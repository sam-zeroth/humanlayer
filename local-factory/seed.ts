import { organizationSettings } from '@humanlayer/db/tables/organization-settings'
import { organizations } from '@humanlayer/db/tables/organizations'
import { userSettings } from '@humanlayer/db/tables/user-settings'

import { LOCAL_ORG_ID, LOCAL_USER_ID, LOCAL_WORKOS_ORG_ID } from './config'

if (import.meta.main) {
	if (process.env.LOCAL_SURFACE !== '1') throw new Error('Local seed requires explicit local mode')
	const { db, dbReadReplica } = await import('../apps/riptide-api/src/db/db')
	try {
		await db.transaction(async (tx) => {
			await tx
				.insert(organizations)
				.values({
					id: LOCAL_ORG_ID,
					name: 'Local factory',
					workos_organization_id: LOCAL_WORKOS_ORG_ID,
					eula_accepted_by: LOCAL_USER_ID,
					eula_accepted_at: Date.now(),
				})
				.onConflictDoNothing()
			await tx
				.insert(organizationSettings)
				.values({ organization_id: LOCAL_ORG_ID, enable_creating_publicly_shareable_links: false })
				.onConflictDoNothing()
			await tx
				.insert(userSettings)
				.values({ user_id: LOCAL_USER_ID, organization_id: LOCAL_ORG_ID })
				.onConflictDoNothing()
		})
		console.log('Local organization and user seeded')
	} finally {
		await Promise.all([db.$client.end(), dbReadReplica.$client.end()])
	}
}
