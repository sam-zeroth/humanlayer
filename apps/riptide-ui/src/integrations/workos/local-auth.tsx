import type { AuthKitProvider as UpstreamAuthKitProvider } from '@workos-inc/authkit-react'

const user = {
	id: 'user_factory_local',
	email: 'sam@localhost.invalid',
	firstName: 'Sam',
	lastName: 'Local',
	profilePictureUrl: null,
	emailVerified: true,
}
let cached: { token: string; expiresAt: number } | undefined
let pending: Promise<string> | undefined

const getAccessToken = async () => {
	if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
	pending ??= (async () => {
		const fragment = new URLSearchParams(window.location.hash.slice(1))
		const bootstrap = fragment.get('local-bootstrap')
		if (bootstrap) {
			sessionStorage.setItem('local-bootstrap', bootstrap)
			fragment.delete('local-bootstrap')
			history.replaceState(null, '', location.pathname + location.search + (fragment.size ? '#' + fragment : ''))
		}
		const secret = sessionStorage.getItem('local-bootstrap')
		if (!secret) throw new Error('Open the local profile using the factory launcher')
		const response = await fetch('/identity/token', { method: 'POST', headers: { 'x-local-bootstrap': secret } })
		if (!response.ok) throw new Error('Could not sign in. Open the local profile using the factory launcher.')
		const body: { token: string; expiresAt: number } = await response.json()
		cached = body
		return body.token
	})().finally(() => {
		pending = undefined
	})
	return pending
}
const unsupported = async (): Promise<never> => {
	throw new Error('This operation is unavailable for the local profile')
}
const auth = {
	user,
	organizationId: 'org_factory_local',
	isLoading: false,
	role: 'admin',
	roles: ['admin'],
	permissions: [],
	entitlements: [],
	featureFlags: [],
	getAccessToken,
	getUser: () => user,
	getSignInUrl: unsupported,
	getSignUpUrl: unsupported,
	impersonator: null,
	authenticationMethod: null,
	signIn: unsupported,
	signUp: unsupported,
	signOut: unsupported,
	switchToOrganization: unsupported,
}
export const useAuth = () => auth
export const AuthKitProvider: typeof UpstreamAuthKitProvider = ({ children }) => <>{children}</>
