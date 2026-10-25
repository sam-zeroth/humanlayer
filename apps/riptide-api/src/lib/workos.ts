import type { WorkOS as WorkOSClient } from '@workos-inc/node'

import { localAuthConfig } from '../../../../local-factory/config'
import { requireEnvironment } from './environment'

const WorkOS = process.env.LOCAL_SURFACE === '1' ? undefined : (await import('@workos-inc/node')).WorkOS

// Lazy-loaded values (loaded on first use to avoid requiring env vars at module load)
let _workosApiKey: string | null = null
let _workosClientId: string | null = null
let _workosRedirectUri: string | null = null
let _workos: WorkOSClient | null = null
let _jwksUrl: string | null = null

// Export getters for environment variables
export function getWorkosApiKey(): string {
	if (!_workosApiKey) {
		_workosApiKey = requireEnvironment('WORKOS_API_KEY')
	}
	return _workosApiKey
}

export function getWorkosClientId(): string {
	if (!_workosClientId) {
		_workosClientId = requireEnvironment('WORKOS_CLIENT_ID')
	}
	return _workosClientId
}

export function getWorkosRedirectUri(): string {
	if (!_workosRedirectUri) {
		_workosRedirectUri = requireEnvironment('WORKOS_REDIRECT_URI')
	}
	return _workosRedirectUri
}

// Export getter for singleton WorkOS client
export function getWorkos(): WorkOSClient {
	if (!_workos) {
		if (!WorkOS) throw new Error('WorkOS disabled in LOCAL MODE')
		_workos = new WorkOS(getWorkosApiKey())
	}
	return _workos
}

// Export getter for JWKS URL
export function getJwksUrl(): string {
	if (process.env.LOCAL_SURFACE === '1') return localAuthConfig().issuer + '/jwks'
	if (!_jwksUrl) {
		_jwksUrl = getWorkos().userManagement.getJwksUrl(getWorkosClientId())
	}
	return _jwksUrl
}
