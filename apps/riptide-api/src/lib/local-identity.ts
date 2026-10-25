import { LOCAL_USER_ID, LOCAL_WORKOS_ORG_ID, LOCAL_EMAIL, localAuthConfig } from '../../../../local-factory/config'
// Single-user local identity. Unsupported identity mutations fail closed.
import type { WorkosSdkAdapter } from './workos-service'
const now = new Date().toISOString()
const user = {
	object: 'user' as const,
	id: LOCAL_USER_ID,
	email: LOCAL_EMAIL,
	emailVerified: true,
	firstName: 'Local',
	lastName: 'Factory',
	profilePictureUrl: null,
	lastSignInAt: now,
	createdAt: now,
	updatedAt: now,
	externalId: null,
	metadata: {},
	name: null,
	locale: null,
}
const organization = {
	object: 'organization' as const,
	id: LOCAL_WORKOS_ORG_ID,
	name: 'Software Factory Local',
	allowProfilesOutsideOrganization: false,
	domains: [],
	createdAt: now,
	updatedAt: now,
	externalId: null,
	metadata: {},
}
const membership = {
	object: 'organization_membership' as const,
	id: 'om_factory_local',
	userId: user.id,
	organizationId: organization.id,
	organizationName: organization.name,
	status: 'active' as const,
	directoryManaged: false,
	customAttributes: {},
	role: { slug: 'admin' },
	roles: [{ slug: 'admin' }],
	createdAt: now,
	updatedAt: now,
}
const unsupported = (): never => {
	throw new Error('Unavailable in single-user LOCAL MODE')
}
const page = <T>(data: T[]) => ({
	object: 'list' as const,
	data,
	listMetadata: { before: null, after: null },
	autoPagination: async () => data,
})
export const localIdentity: WorkosSdkAdapter = {
	config: { clientId: 'local-disabled', redirectUri: localAuthConfig().browserOrigin },
	countActiveOrganizationMemberships: async () => 1,
	countPendingInvitations: async () => 0,
	verifyWebhook: unsupported,
	getMembershipWebhookEvent: () => null,
	userManagement: {
		getUser: async (id: string) => {
			if (id !== user.id) throw new Error('Unknown local user')
			return user
		},
		listUsers: async (input) => page(!input?.email || input.email === user.email ? [user] : []),
		listOrganizationMemberships: async (input) =>
			page(
				(!input?.organizationId || input.organizationId === organization.id) &&
					(!input?.userId || input.userId === user.id)
					? [membership]
					: [],
			),
		listInvitations: async () => page([]),
		listUserApiKeys: async () => page([]),
		createUserApiKey: unsupported,
		findInvitationByToken: unsupported,
		acceptInvitation: unsupported,
		getAuthorizationUrl: unsupported,
		createOrganizationMembership: unsupported,
		authenticateWithRefreshToken: unsupported,
		getInvitation: unsupported,
		sendInvitation: unsupported,
		revokeInvitation: unsupported,
		updateOrganizationMembership: unsupported,
		deleteOrganizationMembership: unsupported,
		deactivateOrganizationMembership: unsupported,
		reactivateOrganizationMembership: unsupported,
	},
	organizations: {
		getOrganization: async (id: string) => {
			if (id !== organization.id) throw new Error('Unknown local org')
			return organization
		},
		createOrganization: unsupported,
		updateOrganization: unsupported,
	},
	organizationDomains: { create: unsupported, delete: unsupported },
	adminPortal: { generateLink: unsupported },
	apiKeys: { createValidation: async () => ({ apiKey: null }), deleteApiKey: unsupported },
}
