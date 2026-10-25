export const LOCAL_USER_ID = 'user_factory_local'
export const LOCAL_WORKOS_ORG_ID = 'org_factory_local'
export const LOCAL_ORG_ID = '019b049c-950d-7baa-b9a8-b9364599318b'
export const LOCAL_AUDIENCE = 'humanlayer-local'
export const LOCAL_EMAIL = 'sam@localhost.invalid'

export function loopbackOrigin(value: string): string {
	const url = new URL(value)
	if (
		!['127.0.0.1', '[::1]'].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.pathname !== '/' ||
		url.search ||
		url.hash
	)
		throw new Error('Local service origin must be an exact loopback origin')
	if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported local service protocol')
	return url.origin
}

export function localAuthConfig(env = process.env) {
	if (env.LOCAL_SURFACE !== '1') throw new Error('Explicit LOCAL_SURFACE=1 is required')
	const browserOrigin = loopbackOrigin(env.LOCAL_BROWSER_ORIGIN ?? 'https://127.0.0.1:55813')
	if (!browserOrigin.startsWith('https:')) throw new Error('Local browser origin requires HTTPS')
	return {
		issuer: loopbackOrigin(env.LOCAL_IDENTITY_ORIGIN ?? 'http://127.0.0.1:55801'),
		browserOrigin,
		audience: LOCAL_AUDIENCE,
	}
}
