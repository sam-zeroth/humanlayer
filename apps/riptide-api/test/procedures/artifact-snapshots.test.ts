import { artifactComments } from '@humanlayer/db/tables/artifact-comments'
import { artifactVersions } from '@humanlayer/db/tables/artifact-versions'
import { artifacts } from '@humanlayer/db/tables/artifacts'
import { organizations } from '@humanlayer/db/tables/organizations'
import { tasks } from '@humanlayer/db/tables/tasks'
import { asc, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { hash } from 'ohash'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { backfillSnapshots } from '../../../../local-factory/backfill'
import { snapshotArtifact } from '../../src/db/artifact-snapshots'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()
let db: PostgresJsDatabase
let cleanup: (() => Promise<void>) | undefined
let organizationId: string
let taskId: string
const userId = 'snapshot-fixture-user'
beforeAll(async () => {
	const context = await createTestDb('snapshot_invariants')
	db = context.db
	cleanup = context.cleanup
	const [org] = await db
		.insert(organizations)
		.values({ name: 'Snapshot tests', workos_organization_id: 'org_snapshot_tests' })
		.returning()
	if (!org) throw new Error('Organization fixture missing')
	organizationId = org.id
	const [task] = await db
		.insert(tasks)
		.values({
			name: 'Snapshot task',
			organization_id: organizationId,
			resource_owner_user_id: userId,
			created_by: userId,
		})
		.returning()
	if (!task) throw new Error('Task fixture missing')
	taskId = task.id
})
afterAll(async () => {
	await cleanup?.()
})
async function create(fileName: string, content = 'A', storage = 'postgres') {
	const [artifact] = await db
		.insert(artifacts)
		.values({
			task_id: taskId,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			created_by: userId,
			file_name: fileName,
			content,
			content_hash: hash(content),
			storage_type: storage,
		})
		.returning()
	if (!artifact) throw new Error('Artifact fixture missing')
	return artifact
}

test('version 1, exact retry and A → B → A preserve occurrence identity', async () => {
	const artifact = await create('occurrences.md')
	const first = await db.transaction((tx) => snapshotArtifact(tx, artifact.id))
	const replay = await db.transaction((tx) => snapshotArtifact(tx, artifact.id))
	expect(first?.versionNumber).toBe(1)
	expect(replay).toEqual({ ...first, created: false })
	for (const content of ['B', 'A'])
		await db.transaction(async (tx) => {
			await tx
				.update(artifacts)
				.set({ content, content_hash: hash(content) })
				.where(eq(artifacts.id, artifact.id))
			await snapshotArtifact(tx, artifact.id)
		})
	const versions = await db
		.select()
		.from(artifactVersions)
		.where(eq(artifactVersions.artifact_id, artifact.id))
		.orderBy(asc(artifactVersions.version_number))
	expect(versions.map((v) => v.content)).toEqual(['A', 'B', 'A'])
	expect(new Set(versions.map((v) => v.id)).size).toBe(3)
	const [current] = await db.select().from(artifacts).where(eq(artifacts.id, artifact.id))
	expect(current?.current_version_id).toBe(versions[2]?.id)
})
test('concurrent snapshot requests allocate only one current version', async () => {
	const artifact = await create('concurrent.md')
	const results = await Promise.all([
		db.transaction((tx) => snapshotArtifact(tx, artifact.id)),
		db.transaction((tx) => snapshotArtifact(tx, artifact.id)),
	])
	expect(results[0]?.id).toBe(results[1]?.id)
	expect(results.filter((r) => r?.created).length).toBe(1)
})
test('dry-run and repeated backfill preserve history and ambiguous old comments', async () => {
	const legacy = await create('legacy.md', 'Current bytes')
	await create('binary.png', '', 's3')
	const [old] = await db
		.insert(artifactVersions)
		.values({
			artifact_id: legacy.id,
			task_id: taskId,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			created_by: userId,
			content: 'Old bytes',
			content_hash: hash('Old bytes'),
			version_number: 1,
		})
		.returning()
	if (!old) throw new Error('Legacy version fixture missing')
	const [comment] = await db
		.insert(artifactComments)
		.values({
			artifact_id: legacy.id,
			task_id: taskId,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			created_by_user_id: userId,
			content_text: 'Old ambiguous binding',
			created_at_artifact_version_id: old.id,
		})
		.returning()
	if (!comment) throw new Error('Legacy comment fixture missing')
	const preview = await backfillSnapshots(db)
	expect(preview.pending).toBe(1)
	expect(preview.updated).toBe(0)
	expect(preview.skippedBinary).toBe(1)
	expect((await backfillSnapshots(db, true)).updated).toBe(1)
	expect((await backfillSnapshots(db, true)).updated).toBe(0)
	const versions = await db
		.select()
		.from(artifactVersions)
		.where(eq(artifactVersions.artifact_id, legacy.id))
		.orderBy(asc(artifactVersions.version_number))
	expect(versions[0]).toEqual(old)
	expect(versions.map((v) => v.content)).toEqual(['Old bytes', 'Current bytes'])
	const [preserved] = await db.select().from(artifactComments).where(eq(artifactComments.id, comment.id))
	expect(preserved).toEqual(comment)
	expect(preserved?.viewed_version_verified).toBe(false)
})
