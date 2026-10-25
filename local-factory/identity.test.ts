import { afterAll, expect, test } from 'bun:test'
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loopbackOrigin } from './config'
import { identityHandler, loadIdentity } from './identity'

const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
	.privateKey.export({ type: 'pkcs8', format: 'pem' })
	.toString()
let now = 1_800_000_000_000
const handler = identityHandler({
	privateKey: key,
	bootstrapSecret: 'profile-secret',
	issuer: 'http://127.0.0.1:55801',
	browserOrigin: 'https://127.0.0.1:55813',
	now: () => now,
})
const request = (origin = 'https://127.0.0.1:55813', secret = 'profile-secret') =>
	new Request('http://127.0.0.1:55801/token', { method: 'POST', headers: { origin, 'x-local-bootstrap': secret } })

test('pins exact loopback origins', () => {
	for (const origin of [
		'https://example.com',
		'http://localhost:123',
		'http://0.0.0.0:123',
		'file:///tmp/a',
		'http://127.0.0.1/path',
		'http://u@127.0.0.1',
	])
		expect(() => loopbackOrigin(origin)).toThrow()
	expect(loopbackOrigin('https://127.0.0.1:55813')).toBe('https://127.0.0.1:55813')
})
test('refuses hostile origins and missing credentials without issuing tokens', () => {
	expect(handler(request('https://evil.example')).status).toBe(403)
	expect(handler(request(undefined, '')).status).toBe(403)
	expect(handler(new Request('http://127.0.0.1:55801/token')).status).toBe(404)
	expect(handler(new Request('http://example.com/jwks')).status).toBe(403)
})
test('issues signed expiring tokens and renews without restarting', async () => {
	const first = await handler(request()).json()
	const parts = first.token.split('.')
	expect(
		verify(
			'RSA-SHA256',
			Buffer.from(parts[0] + '.' + parts[1]),
			createPublicKey(key),
			Buffer.from(parts[2], 'base64url'),
		),
	).toBe(true)
	expect(
		verify(
			'RSA-SHA256',
			Buffer.from(parts[0] + '.tampered'),
			createPublicKey(key),
			Buffer.from(parts[2], 'base64url'),
		),
	).toBe(false)
	const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
	expect(claims.exp - claims.iat).toBe(900)
	expect(claims.aud).toBe('humanlayer-local')
	now += 901_000
	const second = await handler(request()).json()
	expect(second.token).not.toBe(first.token)
	expect(second.expiresAt).toBeGreaterThan(first.expiresAt)
})
const directory = await mkdtemp(join(tmpdir(), 'factory-identity-'))
afterAll(() => rm(directory, { recursive: true, force: true }))
test('persists one private identity and bootstrap secret with private permissions', async () => {
	const first = await loadIdentity(directory)
	expect(await loadIdentity(directory)).toEqual(first)
	expect((await stat(join(directory, 'identity.pem'))).mode & 0o777).toBe(0o600)
	expect((await stat(directory)).mode & 0o777).toBe(0o700)
})
