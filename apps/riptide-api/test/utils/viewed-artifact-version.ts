import { artifacts } from '@humanlayer/db/tables/artifacts'
import { eq } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { snapshotArtifact } from '../../src/db/artifact-snapshots'
import type { PostgresDbClient } from '../../src/effects/services/postgres/postgres-db.service'

/** Simulate opening this fixture's current document, rather than fabricating a latest-version binding. */
export async function viewedArtifactVersion(db: PostgresDbClient, artifactId: string) {
	return db.transaction(async (tx) => {
		const [artifact] = await tx.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.id, artifactId))
		// Missing-artifact negative controls still need a syntactically valid, unbound UUID.
		if (!artifact) return uuidv7()
		const snapshot = await snapshotArtifact(tx, artifactId)
		if (!snapshot) throw new Error('Binary artifact fixture has no text revision')
		return snapshot.id
	})
}
