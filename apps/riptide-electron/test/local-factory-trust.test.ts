import { describe, expect, it } from 'vitest'

import {
	certificateAllowed,
	externalLink,
	requestAllowed,
	spkiPin,
	stackOrigin,
	startPath,
} from '../src/local-factory/trust'

// Throwaway self-signed fixtures; neither is the stack's real leaf.
const leaf = `-----BEGIN CERTIFICATE-----
MIIBfTCCASOgAwIBAgIUSYZQxaYai2X8hNgIVzp6yO+JHfgwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTAyNjA0MzgyOFoXDTM2MTAyMzA0
MzgyOFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEo7eqjVim4+2rbXM7e91/TlnAu1aFKkLNtyJHz/1dBjMFoYTSu8GT0QXy
g6M1j8zBZmYezRL3QTwI5ztjJcuwBqNTMFEwHQYDVR0OBBYEFBMHgn/eEEqNkXgM
NqxJr7euV9tVMB8GA1UdIwQYMBaAFBMHgn/eEEqNkXgMNqxJr7euV9tVMA8GA1Ud
EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgZ8sz+eQ0h0BIx/f44CO/qKb+
fhbctwqj0uKFQeI2X1gCIQDzy0m0YkGPS/AAuCOhiuC3fLeQNAP5G8RxdpHICQXY
gQ==
-----END CERTIFICATE-----`
const other = `-----BEGIN CERTIFICATE-----
MIIBfTCCASOgAwIBAgIUNqhHgb/nHdjleHnLqCUW+KqyThMwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTAyNjA0MzgyOFoXDTM2MTAyMzA0
MzgyOFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEoiVxB34dzXIwJAEg+1DdmCyayglaBgI5rhHZ4lpDnzVGNGhw30H5u0zm
rl57MfiI311XsX/tCl5X2cpHydkR/KNTMFEwHQYDVR0OBBYEFBSqI1dLK/+zvSP9
X/umJjAD9IAQMB8GA1UdIwQYMBaAFBSqI1dLK/+zvSP9X/umJjAD9IAQMA8GA1Ud
EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhAOyBJjrDk611072RD1SKtHxE
bBDw5uQgdHKJHiM/+2f5AiBOt0LQJ8mY35t5uCigfzGRpplQiwkdvbilt9pHkSJM
6A==
-----END CERTIFICATE-----`
const origin = 'https://127.0.0.1:55913'

describe('Sam Factory trust', () => {
	it('accepts only an exact loopback HTTPS origin', () => {
		expect(stackOrigin('https://127.0.0.1:55913')).toBe(origin)
		for (const bad of [
			'http://127.0.0.1:55913',
			'https://localhost:55913',
			'https://127.0.0.1',
			'https://127.0.0.1:55913/x',
			'https://u:p@127.0.0.1:1',
			undefined,
		])
			expect(() => stackOrigin(bad)).toThrow()
	})
	it('pins the stack leaf on the stack host and nothing else', () => {
		const pin = spkiPin(leaf)
		expect(certificateAllowed('127.0.0.1', leaf, origin, pin)).toBe(true)
		expect(certificateAllowed('127.0.0.1', other, origin, pin)).toBe(false)
		expect(certificateAllowed('example.com', leaf, origin, pin)).toBe(false)
		expect(certificateAllowed('127.0.0.1', 'not a certificate', origin, pin)).toBe(false)
	})
	it('lets requests reach only the stack origin', () => {
		expect(requestAllowed(origin + '/factory/units/x', origin)).toBe(true)
		expect(requestAllowed('wss://127.0.0.1:55913/', origin)).toBe(true)
		expect(requestAllowed('data:text/html,hi', origin)).toBe(true)
		for (const bad of [
			'https://127.0.0.1:55813/',
			'http://127.0.0.1:55913/',
			'https://api.workos.com/',
			'https://o1.ingest.sentry.io/',
			'file:///etc/passwd',
			'nonsense',
		])
			expect(requestAllowed(bad, origin)).toBe(false)
	})
	it('sends only non-loopback HTTPS links to the default browser', () => {
		expect(externalLink('https://github.com/zeroth-agents/pyrana/pull/2820')).toBe(
			'https://github.com/zeroth-agents/pyrana/pull/2820',
		)
		expect(externalLink('https://127.0.0.1:55913/')).toBeNull()
		expect(externalLink('http://github.com/')).toBeNull()
		expect(externalLink('file:///tmp/x')).toBeNull()
	})
	it('opens only a projected task path, never anything carrying a fragment', () => {
		expect(startPath('/tasks/01a1767b-6348-744c-9007-4e3448c1fee4?factory=true\n')).toBe(
			'/tasks/01a1767b-6348-744c-9007-4e3448c1fee4?factory=true',
		)
		expect(startPath('/#local-bootstrap=secret')).toBe('/')
		expect(startPath('//evil.example/')).toBe('/')
		expect(startPath(null)).toBe('/')
	})
})
