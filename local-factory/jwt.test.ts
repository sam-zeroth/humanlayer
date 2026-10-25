import { afterAll, expect, test } from 'bun:test'
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto'

import { Effect, Layer } from 'effect'

import { LOCAL_AUDIENCE, LOCAL_ORG_ID, LOCAL_USER_ID, LOCAL_WORKOS_ORG_ID } from './config'
import { identityHandler } from './identity'

const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
	.privateKey.export({ type: 'pkcs8', format: 'pem' })
	.toString()
let handler: (request: Request) => Response = () => new Response(null, { status: 503 })
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => handler(request) })
const issuer = server.url.origin
process.env.LOCAL_SURFACE = '1'
process.env.LOCAL_IDENTITY_ORIGIN = issuer
process.env.LOCAL_BROWSER_ORIGIN = 'https://127.0.0.1:55813'
handler = identityHandler({
	privateKey: key,
	bootstrapSecret: 'test',
	issuer,
	browserOrigin: process.env.LOCAL_BROWSER_ORIGIN,
})
const { validateJWT } = await import('../apps/riptide-api/src/auth/jwt-validator')
const { jwksCache } = await import('../apps/riptide-api/src/auth/jwks-cache')
await jwksCache.forceRefresh()
afterAll(() => {
	server.stop(true)
	delete process.env.LOCAL_SURFACE
	delete process.env.LOCAL_IDENTITY_ORIGIN
	delete process.env.LOCAL_BROWSER_ORIGIN
})
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const now = Math.floor(Date.now() / 1000)
const claims = {
	iss: issuer,
	aud: LOCAL_AUDIENCE,
	sub: LOCAL_USER_ID,
	internal_org_id: LOCAL_ORG_ID,
	org_id: LOCAL_WORKOS_ORG_ID,
	sid: 'local-test',
	iat: now,
	exp: now + 900,
}
const token = (payload: unknown, kid = 'factory-local') => {
	const data = b64({ alg: 'RS256', kid }) + '.' + b64(payload)
	return data + '.' + sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')
}

test('real API JWT seam accepts only the seeded signed identity', async () => {
	expect((await validateJWT(token(claims)))?.userId).toBe(LOCAL_USER_ID)
	for (const mutation of [
		{ iss: 'https://evil.example' },
		{ aud: 'another-service' },
		{ sub: 'another-user' },
		{ org_id: 'another-org' },
		{ act: { sub: 'impersonated-user' } },
		{ internal_org_id: '019b049c-950d-7baa-b9a8-b9364599319b' },
		{ exp: now - 1 },
		{ exp: undefined },
	])
		expect(await validateJWT(token({ ...claims, ...mutation }))).toBeNull()
	expect(await validateJWT(token(claims, 'unknown-key'))).toBeNull()
	const signed = token(claims).split('.')
	expect(await validateJWT(signed[0] + '.' + b64({ ...claims, sub: 'forged' }) + '.' + signed[2])).toBeNull()
})

test('Electric independently enforces local issuer, audience, identity and expiry', async () => {
	const { JWTValidator, JWTValidatorLive } =
		await import('../apps/riptide-electric-proxy/src/auth/effect/jwt-validator.service')
	const { JWKSCache } = await import('../apps/riptide-electric-proxy/src/auth/effect/jwks-cache.service')
	const { JWKSKeyNotFoundError } = await import('../apps/riptide-electric-proxy/src/auth/effect/errors')
	const publicKey = await crypto.subtle.importKey(
		'spki',
		createPublicKey(key).export({ type: 'spki', format: 'der' }),
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['verify'],
	)
	const cache = Layer.succeed(JWKSCache, {
		getKey: (kid) =>
			kid === 'factory-local' ? Effect.succeed(publicKey) : Effect.fail(new JWKSKeyNotFoundError({ kid })),
		isReady: Effect.succeed(true),
		forceRefresh: Effect.void,
	})
	const layer = Layer.provide(JWTValidatorLive, cache)
	const check = (candidate: string) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const validator = yield* JWTValidator
				return yield* validator.validateJWT(candidate)
			}).pipe(Effect.provide(layer)),
		)
	expect((await check(token(claims))).userId).toBe(LOCAL_USER_ID)
	for (const mutation of [
		{ iss: 'https://evil.example' },
		{ aud: 'wrong-audience' },
		{ sub: 'another-user' },
		{ org_id: 'another-org' },
		{ internal_org_id: '019b049c-950d-7baa-b9a8-b9364599319b' },
		{ exp: now - 1 },
		{ exp: undefined },
	])
		await expect(check(token({ ...claims, ...mutation }))).rejects.toThrow()
	await expect(check(token(claims, 'unknown-key'))).rejects.toThrow()
})
