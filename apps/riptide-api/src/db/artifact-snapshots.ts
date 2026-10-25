import { artifactVersions } from '@humanlayer/db/tables/artifact-versions'
import { artifacts } from '@humanlayer/db/tables/artifacts'
import { tasks } from '@humanlayer/db/tables/tasks'
import { and, asc, eq, sql } from 'drizzle-orm'

import type { PostgresDbTransactionClient } from '../effects/services/postgres/postgres-db.service'

/** Call inside the content writer's transaction; the task lock also serializes first inserts. */
export async function lockArtifactTask(tx: PostgresDbTransactionClient, taskId: string) {
	await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).for('update')
}

/** Never infer a revision by matching a hash against history (A → B → A is three revisions). */
export async function snapshotArtifact(tx: PostgresDbTransactionClient, artifactId: string) {
	const [artifact] = await tx.select().from(artifacts).where(eq(artifacts.id, artifactId)).for('update')
	if (!artifact) throw new Error('Artifact not found for snapshot')
	if (artifact.storage_type !== 'postgres') {
		await tx.update(artifacts).set({ current_version_id: null }).where(eq(artifacts.id, artifact.id))
		return undefined
	}
	if (artifact.current_version_id) {
		const [current] = await tx
			.select()
			.from(artifactVersions)
			.where(
				and(
					eq(artifactVersions.id, artifact.current_version_id),
					eq(artifactVersions.artifact_id, artifact.id),
					eq(artifactVersions.organization_id, artifact.organization_id),
				),
			)
		if (current?.content === artifact.content && current.content_hash === artifact.content_hash)
			return { id: current.id, versionNumber: current.version_number, created: false }
	}
	const [maximum] = await tx
		.select({ n: sql<number>`coalesce(max(${artifactVersions.version_number}), 0)` })
		.from(artifactVersions)
		.where(eq(artifactVersions.artifact_id, artifact.id))
	const [version] = await tx
		.insert(artifactVersions)
		.values({
			artifact_id: artifact.id,
			task_id: artifact.task_id,
			task_slug: artifact.task_slug,
			resource_owner_user_id: artifact.resource_owner_user_id,
			organization_id: artifact.organization_id,
			content: artifact.content,
			content_hash: artifact.content_hash,
			created_by: artifact.created_by,
			version_number: Number(maximum?.n ?? 0) + 1,
		})
		.returning()
	if (!version) throw new Error('Snapshot insert returned no row')
	await tx.update(artifacts).set({ current_version_id: version.id }).where(eq(artifacts.id, artifact.id))
	return { id: version.id, versionNumber: version.version_number, created: true }
}

/** Used by task creators that insert several initial documents in a single transaction. */
export async function snapshotTaskArtifacts(tx: PostgresDbTransactionClient, taskId: string) {
	await lockArtifactTask(tx, taskId)
	const rows = await tx
		.select({ id: artifacts.id })
		.from(artifacts)
		.where(eq(artifacts.task_id, taskId))
		.orderBy(asc(artifacts.id))
	for (const row of rows) await snapshotArtifact(tx, row.id)
}
