import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { LOCAL_AUDIENCE, LOCAL_ORG_ID, LOCAL_USER_ID, LOCAL_WORKOS_ORG_ID, localAuthConfig } from './config'

export async function loadIdentity(stateDirectory: string) {
	await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
	await chmod(stateDirectory, 0o700)
	const keyPath = join(stateDirectory, 'identity.pem')
	try {
		await writeFile(
			keyPath,
			generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
			{ flag: 'wx', mode: 0o600 },
		)
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
	}
	await chmod(keyPath, 0o600)
	const secretPath = join(stateDirectory, 'bootstrap-secret')
	try {
		await writeFile(secretPath, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 })
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
	}
	await chmod(secretPath, 0o600)
	return { privateKey: await readFile(keyPath, 'utf8'), bootstrapSecret: await readFile(secretPath, 'utf8') }
}

export function identityHandler(options: {
	privateKey: string
	bootstrapSecret: string
	issuer: string
	browserOrigin: string
	now?: () => number
}) {
	const key = createPrivateKey(options.privateKey)
	const jwk = { ...createPublicKey(key).export({ format: 'jwk' }), kid: 'factory-local', alg: 'RS256', use: 'sig' }
	const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
	return (request: Request): Response => {
		const url = new URL(request.url)
		if (![options.issuer, options.browserOrigin].includes(url.origin)) return new Response(null, { status: 403 })
		const headers = { 'Cache-Control': 'no-store' }
		if (url.pathname === '/jwks' && request.method === 'GET') return Response.json({ keys: [jwk] }, { headers })
		if (url.pathname !== '/token' || request.method !== 'POST') return new Response(null, { status: 404 })
		const origin = request.headers.get('origin')
		if (origin !== options.browserOrigin) return new Response(null, { status: 403 })
		const supplied = Buffer.from(request.headers.get('x-local-bootstrap') ?? '')
		const expected = Buffer.from(options.bootstrapSecret)
		if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
			return new Response(null, { status: 403 })
		const now = Math.floor((options.now?.() ?? Date.now()) / 1000)
		const payload =
			b64({ alg: 'RS256', kid: jwk.kid }) +
			'.' +
			b64({
				iss: options.issuer,
				aud: LOCAL_AUDIENCE,
				sub: LOCAL_USER_ID,
				sid: 'session_factory_local',
				org_id: LOCAL_WORKOS_ORG_ID,
				internal_org_id: LOCAL_ORG_ID,
				role: 'admin',
				roles: ['admin'],
				permissions: [],
				entitlements: [],
				iat: now,
				exp: now + 900,
			})
		return Response.json(
			{
				token: payload + '.' + sign('RSA-SHA256', Buffer.from(payload), key).toString('base64url'),
				expiresAt: (now + 900) * 1000,
			},
			{ headers },
		)
	}
}

if (import.meta.main) {
	const config = localAuthConfig()
	const state = process.env.LOCAL_FACTORY_STATE
	if (!state) throw new Error('LOCAL_FACTORY_STATE is required')
	const identity = await loadIdentity(state)
	Bun.serve({
		hostname: new URL(config.issuer).hostname,
		port: Number(new URL(config.issuer).port),
		fetch: identityHandler({ ...config, ...identity }),
	})
}
