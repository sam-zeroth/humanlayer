import { artifactComments } from '@humanlayer/db/tables/artifact-comments'
import { artifacts } from '@humanlayer/db/tables/artifacts'
import { and, asc, count, eq, isNull } from 'drizzle-orm'

import { snapshotArtifact } from '../apps/riptide-api/src/db/artifact-snapshots'
import type { PostgresDbClient } from '../apps/riptide-api/src/effects/services/postgres/postgres-db.service'

/** Add current snapshots only. Never rewrite historical versions or infer old viewed bindings. */
export async function backfillSnapshots(db: PostgresDbClient, apply = false, batchSize = 100) {
	if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('Invalid batch size')
	const pending = and(eq(artifacts.storage_type, 'postgres'), isNull(artifacts.current_version_id))
	const [needed] = await db.select({ n: count() }).from(artifacts).where(pending)
	const [binary] = await db.select({ n: count() }).from(artifacts).where(eq(artifacts.storage_type, 's3'))
	const [legacy] = await db
		.select({ n: count() })
		.from(artifactComments)
		.where(eq(artifactComments.viewed_version_verified, false))
	let updated = 0
	if (apply) {
		while (true) {
			const processed = await db.transaction(async (tx) => {
				const rows = await tx
					.select({ id: artifacts.id })
					.from(artifacts)
					.where(pending)
					.orderBy(asc(artifacts.id))
					.limit(batchSize)
					.for('update', { skipLocked: true })
				for (const row of rows) await snapshotArtifact(tx, row.id)
				return rows.length
			})
			updated += processed
			if (!processed) break
		}
	}
	return {
		mode: apply ? 'apply' : 'dry-run',
		pending: needed?.n ?? 0,
		updated,
		skippedBinary: binary?.n ?? 0,
		unverifiedCommentsPreserved: legacy?.n ?? 0,
	}
}

if (import.meta.main) {
	// Resolve from the API workspace so standalone tooling uses its declared dependencies.
	const { db, dbReadReplica } = await import('../apps/riptide-api/src/db/db')
	try {
		console.log(JSON.stringify(await backfillSnapshots(db, process.argv.includes('--apply')), null, 2))
	} finally {
		await Promise.all([db.$client.end(), dbReadReplica.$client.end()])
	}
}
