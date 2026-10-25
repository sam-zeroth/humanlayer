import { createHash } from 'node:crypto'

import { canonicalFactorySnapshot, renderFactoryUnit, type FactorySnapshot } from '@humanlayer/db/factory-unit'
import { artifacts } from '@humanlayer/db/tables/artifacts'
import { factoryRequests } from '@humanlayer/db/tables/factory-units'
import { organizations } from '@humanlayer/db/tables/organizations'
import { tasks } from '@humanlayer/db/tables/tasks'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { hash } from 'ohash'
import { uuidv7 } from 'uuidv7'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { LOCAL_ORG_ID, LOCAL_USER_ID } from '../../../../local-factory/config'
import { snapshotArtifact } from '../../src/db/artifact-snapshots'
import { createLocalFactoryRoutes } from '../../src/routes/local-factory'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()
let db: PostgresJsDatabase
let cleanup: (() => Promise<void>) | undefined
let taskId: string
let artifactId: string
let versionId: string
let app: ReturnType<typeof createLocalFactoryRoutes>
const origin = 'https://127.0.0.1:55813'
const snapshot: FactorySnapshot = {
	ready: {
		id: 'demo/t-0001',
		revision: 1,
		digest: 'sha256:' + 'a'.repeat(64),
		outcome: { before_after: 'A complete unit view' },
	},
	completion: {
		unit: 'demo/t-0001',
		ready_revision: 1,
		ready_digest: 'sha256:' + 'a'.repeat(64),
		phase: 'active',
		verdict: 'open',
		obligations: { verified: { state: 'pending' } },
		holds: {},
	},
}
beforeAll(async () => {
	const context = await createTestDb('local_factory_routes')
	db = context.db
	cleanup = context.cleanup
	await db
		.insert(organizations)
		.values({ id: LOCAL_ORG_ID, name: 'Local factory', workos_organization_id: 'org_factory_local' })
	const [task] = await db
		.insert(tasks)
		.values({
			organization_id: LOCAL_ORG_ID,
			name: 'Factory fixture',
			resource_owner_user_id: LOCAL_USER_ID,
			created_by: LOCAL_USER_ID,
		})
		.returning()
	if (!task) throw new Error('Task fixture missing')
	taskId = task.id
	const content = renderFactoryUnit(snapshot)
	const [artifact] = await db
		.insert(artifacts)
		.values({
			task_id: taskId,
			file_name: 'unit.md',
			content,
			content_hash: hash(content),
			organization_id: LOCAL_ORG_ID,
			resource_owner_user_id: LOCAL_USER_ID,
			created_by: LOCAL_USER_ID,
		})
		.returning()
	if (!artifact) throw new Error('Artifact fixture missing')
	artifactId = artifact.id
	const version = await db.transaction((tx) => snapshotArtifact(tx, artifactId))
	if (!version) throw new Error('Version fixture missing')
	versionId = version.id
	app = createLocalFactoryRoutes({
		database: db,
		authenticate: async () => ({
			userId: LOCAL_USER_ID,
			organizationId: LOCAL_ORG_ID,
			role: 'admin',
			roles: ['admin'],
			permissions: [],
			entitlements: [],
		}),
		local: true,
		browserOrigin: origin,
		bridgeSecret: 'bridge-test',
	})
})
afterAll(async () => {
	await cleanup?.()
})
const payload = () => ({
	sourceGeneration: 1,
	artifactId,
	artifactVersionId: versionId,
	snapshot,
	snapshotHash: createHash('sha256').update(canonicalFactorySnapshot(snapshot)).digest('hex'),
})
async function request(method: string, suffix: string, body?: unknown, bridge = false, requestOrigin = origin) {
	return app.request('http://localhost/units/' + taskId + suffix, {
		method,
		headers: {
			origin: requestOrigin,
			'Content-Type': 'application/json',
			'x-factory-bridge': bridge ? 'bridge-test' : '',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
}

test('browser cannot publish authority or project arbitrary state', async () => {
	expect((await request('PUT', '', payload())).status).toBe(403)
	expect((await request('PUT', '', payload(), true, 'https://evil.example')).status).toBe(403)
	expect((await request('PUT', '', { ...payload(), snapshotHash: 'b'.repeat(64) }, true)).status).toBe(409)
	expect((await request('PUT', '', payload(), true)).status).toBe(200)
	const response = await request('GET', '')
	expect(response.status).toBe(200)
	expect(await response.json()).toMatchObject({ decisionCapability: 'unavailable' })
})
test('pending request replay is idempotent and a conflicting reuse fails closed', async () => {
	await request('PUT', '', payload(), true)
	const input = {
		id: uuidv7(),
		gate: 'design',
		artifactVersionId: versionId,
		readyRevision: 1,
		readyDigest: snapshot.ready.digest,
		words: 'Review this design',
	}
	expect((await request('POST', '/requests', input)).status).toBe(202)
	expect((await request('POST', '/requests', input)).status).toBe(202)
	expect((await request('POST', '/requests', { ...input, words: 'Different intent' })).status).toBe(409)
	const rows = await db.select().from(factoryRequests).where(eq(factoryRequests.id, input.id))
	expect(rows.length).toBe(1)
	expect(rows[0]?.payload).toEqual(input)
	const response = await request('GET', '')
	expect(await response.json()).toMatchObject({ decisionCapability: 'unavailable' })
})
test('stale or foreign request bindings are refused', async () => {
	await request('PUT', '', payload(), true)
	const base = {
		id: uuidv7(),
		gate: 'design',
		artifactVersionId: versionId,
		readyRevision: 1,
		readyDigest: snapshot.ready.digest,
		words: 'Review this',
	}
	expect((await request('POST', '/requests', { ...base, readyRevision: 2 })).status).toBe(409)
	expect((await request('POST', '/requests', { ...base, artifactVersionId: uuidv7() })).status).toBe(409)
	expect((await request('POST', '/requests', { ...base, readyDigest: 'sha256:' + 'f'.repeat(64) })).status).toBe(409)
})
test('late in-flight delivery cannot regress the projection generation', async () => {
	expect((await request('PUT', '', { ...payload(), sourceGeneration: 2 }, true)).status).toBe(200)
	expect((await request('PUT', '', payload(), true)).status).toBe(409)
})
