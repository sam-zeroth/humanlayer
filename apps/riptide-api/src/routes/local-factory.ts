import { createHash, timingSafeEqual } from 'node:crypto'

import {
	canonicalFactorySnapshot,
	renderFactoryUnit,
	FactoryRequestSchema,
	FactorySnapshotSchema,
} from '@humanlayer/db/factory-unit'
import { artifacts } from '@humanlayer/db/tables/artifacts'
import { factoryRequests, factoryUnits } from '@humanlayer/db/tables/factory-units'
import { tasks } from '@humanlayer/db/tables/tasks'
import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import z from 'zod/v4'

import { LOCAL_USER_ID, localAuthConfig } from '../../../../local-factory/config'
import { getAuthContext } from '../auth/context'
import type { AuthContextOptionalOrg } from '../auth/jwt-validator'
import { db } from '../db/db'
import { appRuntime } from '../effects/app-runtime'
import type { PostgresDbClient } from '../effects/services/postgres/postgres-db.service'

const Projection = z
	.object({
		sourceGeneration: z.number().int().positive(),
		artifactId: z.uuid(),
		artifactVersionId: z.uuid(),
		snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
		snapshot: FactorySnapshotSchema,
	})
	.strict()
const sameSecret = (a: string, b: string) =>
	a.length > 0 && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))

interface LocalFactoryDependencies {
	database: PostgresDbClient
	authenticate: (request: Request) => Promise<AuthContextOptionalOrg | null>
	local: boolean
	browserOrigin: string
	bridgeSecret: string
}

export function createLocalFactoryRoutes(
	dependencies: LocalFactoryDependencies = {
		database: db,
		authenticate: (request) => getAuthContext(request, appRuntime),
		local: process.env.LOCAL_SURFACE === '1',
		browserOrigin: localAuthConfig().browserOrigin,
		bridgeSecret: process.env.LOCAL_FACTORY_BRIDGE_SECRET ?? '',
	},
) {
	const { database } = dependencies
	const app = new Hono<{ Variables: { auth: AuthContextOptionalOrg } }>()
	app.use('/units/:taskId/*', async (c, next) => {
		if (!dependencies.local) return c.notFound()
		const origin = c.req.header('origin')
		if (origin && origin !== dependencies.browserOrigin) return c.json({ error: 'Origin refused' }, 403)
		if (!z.uuid().safeParse(c.req.param('taskId')).success) return c.notFound()
		const auth = await dependencies.authenticate(c.req.raw)
		if (!auth?.organizationId || auth.userId !== LOCAL_USER_ID)
			return c.json({ error: 'Authentication required' }, 401)
		const [task] = await database
			.select({ id: tasks.id })
			.from(tasks)
			.where(
				and(
					eq(tasks.id, c.req.param('taskId') ?? ''),
					eq(tasks.organization_id, auth.organizationId),
					eq(tasks.resource_owner_user_id, auth.userId),
				),
			)
		if (!task) return c.notFound()
		c.set('auth', auth)
		await next()
	})
	app.get('/units/:taskId', async (c) => {
		const [projection] = await database
			.select()
			.from(factoryUnits)
			.where(eq(factoryUnits.task_id, c.req.param('taskId')))
		if (!projection) return c.notFound()
		const requests = await database
			.select()
			.from(factoryRequests)
			.where(eq(factoryRequests.task_id, projection.task_id))
			.orderBy(desc(factoryRequests.created_at))
			.limit(20)
		return c.json({ projection, requests, decisionCapability: 'unavailable' as const })
	})
	app.put('/units/:taskId', async (c) => {
		if (!sameSecret(c.req.header('x-factory-bridge') ?? '', dependencies.bridgeSecret))
			return c.json({ error: 'Bridge credential required' }, 403)
		const decoded = Projection.safeParse(await c.req.json().catch(() => null))
		if (!decoded.success) return c.json({ error: 'Invalid projection' }, 400)
		const input = decoded.data
		const auth = c.get('auth')
		if (createHash('sha256').update(canonicalFactorySnapshot(input.snapshot)).digest('hex') !== input.snapshotHash)
			return c.json({ error: 'Projection digest does not match' }, 409)
		const accepted = await database.transaction(async (tx) => {
			await tx
				.select({ id: tasks.id })
				.from(tasks)
				.where(eq(tasks.id, c.req.param('taskId')))
				.for('update')
			const [artifact] = await tx
				.select()
				.from(artifacts)
				.where(
					and(
						eq(artifacts.id, input.artifactId),
						eq(artifacts.task_id, c.req.param('taskId')),
						eq(artifacts.organization_id, auth.organizationId ?? ''),
					),
				)
				.for('update')
			if (
				!artifact ||
				artifact.current_version_id !== input.artifactVersionId ||
				artifact.share_enabled ||
				artifact.content !== renderFactoryUnit(input.snapshot)
			)
				return false
			const [existing] = await tx
				.select()
				.from(factoryUnits)
				.where(eq(factoryUnits.task_id, c.req.param('taskId')))
			if (
				existing &&
				(existing.unit !== input.snapshot.ready.id ||
					existing.snapshot.ready.revision > input.snapshot.ready.revision ||
					existing.source_generation > input.sourceGeneration ||
					(existing.source_generation === input.sourceGeneration &&
						existing.snapshot_hash !== input.snapshotHash))
			)
				return false
			const values = {
				task_id: c.req.param('taskId'),
				organization_id: artifact.organization_id,
				unit: input.snapshot.ready.id,
				artifact_id: artifact.id,
				artifact_version_id: input.artifactVersionId,
				snapshot_hash: input.snapshotHash,
				source_generation: input.sourceGeneration,
				snapshot: input.snapshot,
				synced_at: Date.now(),
			}
			await tx
				.insert(factoryUnits)
				.values(values)
				.onConflictDoUpdate({ target: factoryUnits.task_id, set: values })
			return true
		})
		if (!accepted) return c.json({ error: 'Projection identity does not match' }, 409)
		return c.json({ projected: true })
	})
	app.post('/units/:taskId/requests', async (c) => {
		const decoded = FactoryRequestSchema.safeParse(await c.req.json().catch(() => null))
		if (!decoded.success)
			return c.json({ error: 'Could not request approval. Review the document and try again.' }, 400)
		const input = decoded.data
		const result = await database.transaction(async (tx) => {
			await tx
				.select({ id: tasks.id })
				.from(tasks)
				.where(eq(tasks.id, c.req.param('taskId')))
				.for('update')
			const [projection] = await tx
				.select()
				.from(factoryUnits)
				.where(eq(factoryUnits.task_id, c.req.param('taskId')))
				.for('update')
			if (!projection) return 'missing'
			const [old] = await tx.select().from(factoryRequests).where(eq(factoryRequests.id, input.id))
			if (old)
				return old.task_id === projection.task_id &&
					JSON.stringify(FactoryRequestSchema.parse(old.payload)) === JSON.stringify(input)
					? 'pending'
					: 'conflict'
			const [artifact] = await tx
				.select()
				.from(artifacts)
				.where(eq(artifacts.id, projection.artifact_id))
				.for('update')
			if (
				projection.artifact_version_id !== input.artifactVersionId ||
				artifact?.current_version_id !== input.artifactVersionId ||
				projection.snapshot.ready.revision !== input.readyRevision ||
				projection.snapshot.ready.digest !== input.readyDigest
			)
				return 'stale'
			await tx.insert(factoryRequests).values({
				id: input.id,
				task_id: projection.task_id,
				organization_id: projection.organization_id,
				created_by_user_id: c.get('auth').userId,
				payload: input,
				created_at: Date.now(),
			})
			return 'pending'
		})
		if (result === 'missing') return c.notFound()
		if (result !== 'pending')
			return c.json({ error: 'Could not request approval. Review the latest document and try again.' }, 409)
		// B3 owns attestation. No legacy approval command, event or invented receipt is emitted.
		return c.json({ id: input.id, status: 'pending', decisionCapability: 'unavailable' }, 202)
	})
	return app
}
