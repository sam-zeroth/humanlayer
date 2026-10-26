import { createHash, X509Certificate } from 'node:crypto'

/** The stack origin must be exact loopback HTTPS, the same rule the pinned browser follows. */
export function stackOrigin(value: unknown): string {
	if (typeof value !== 'string') throw new Error('Stack origin missing')
	const url = new URL(value)
	if (
		url.protocol !== 'https:' ||
		url.hostname !== '127.0.0.1' ||
		!url.port ||
		url.username ||
		url.password ||
		url.pathname !== '/' ||
		url.search ||
		url.hash
	)
		throw new Error('Stack origin must be exact loopback HTTPS')
	return url.origin
}

/** base64 SHA-256 of the leaf's SubjectPublicKeyInfo, the pin format Chrome's --ignore-certificate-errors-spki-list uses. */
export function spkiPin(pem: string): string {
	const der = new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })
	return createHash('sha256').update(der).digest('base64')
}

/** Only the stack's own leaf, on the stack's own host. No system trust store is consulted or changed. */
export function certificateAllowed(hostname: string, certificatePem: string, origin: string, pin: string): boolean {
	if (hostname !== new URL(origin).hostname) return false
	try {
		return spkiPin(certificatePem) === pin
	} catch {
		return false
	}
}

/** Every network request the app makes goes to the stack origin. In-memory schemes stay allowed. */
export function requestAllowed(target: string, origin: string): boolean {
	let url: URL
	try {
		url = new URL(target)
	} catch {
		return false
	}
	if (['data:', 'blob:', 'devtools:'].includes(url.protocol)) return true
	const stack = new URL(origin)
	return (url.protocol === 'https:' || url.protocol === 'wss:') && url.host === stack.host
}

/** Links that leave the stack (a PR on GitHub) open in the default browser; nothing else leaves the app. */
export function externalLink(target: string): string | null {
	try {
		const url = new URL(target)
		return url.protocol === 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost'
			? url.href
			: null
	} catch {
		return null
	}
}

/** The task page the bridge last projected, or the stack root. Never carries a credential. */
export function startPath(value: string | null): string {
	if (value && /^\/tasks\/[0-9a-f-]{36}\?factory=true$/.test(value.trim())) return value.trim()
	return '/'
}
