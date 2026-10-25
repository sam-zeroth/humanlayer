// Defense in depth for local mode; the launcher also contains native process egress on macOS.
if (process.env.LOCAL_SURFACE !== '1') throw new Error('Local containment requires LOCAL_SURFACE=1')
const originalFetch = globalThis.fetch
const localFetch: typeof fetch = Object.assign(
	async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const url = new URL(input instanceof Request ? input.url : String(input))
		if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
			throw new Error('External service is unavailable in local mode')
		return originalFetch(input, init)
	},
	originalFetch,
)
globalThis.fetch = localFetch
