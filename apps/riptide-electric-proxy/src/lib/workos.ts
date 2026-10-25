import { localAuthConfig } from '../../../../local-factory/config'
const WorkOS = process.env.LOCAL_SURFACE === '1' ? undefined : (await import('@workos-inc/node')).WorkOS

import { requireEnvironment } from './utils'

// Export environment variables for use in handlers
export const workosApiKey = process.env.LOCAL_SURFACE === '1' ? 'local-disabled' : requireEnvironment('WORKOS_API_KEY')
export const workosClientId =
	process.env.LOCAL_SURFACE === '1' ? 'local-disabled' : requireEnvironment('WORKOS_CLIENT_ID')
export const workosRedirectUri =
	process.env.LOCAL_SURFACE === '1' ? localAuthConfig().browserOrigin : requireEnvironment('WORKOS_REDIRECT_URI')

// Create and export singleton WorkOS client
export const workos = WorkOS ? new WorkOS(workosApiKey) : undefined

// Export JWKS URL for the cache
export const jwksUrl = workos ? workos.userManagement.getJwksUrl(workosClientId) : localAuthConfig().issuer + '/jwks'
