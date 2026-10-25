import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { WiredFactoryUnitPage } from './WiredFactoryUnitPage'

vi.mock('@workos-inc/authkit-react', () => ({ useAuth: () => ({ getAccessToken: async () => 'local-test-token' }) }))
afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})
const first = '019b049c-950d-7baa-b9a8-b9364599318b'
const second = '019b049c-950d-7baa-b9a8-b9364599318c'
function unit(version = first, revision = 1) {
	const digest = 'sha256:' + 'a'.repeat(64)
	return {
		projection: {
			unit: 'demo/t-0001',
			artifact_version_id: version,
			synced_at: Date.now(),
			snapshot: {
				ready: { id: 'demo/t-0001', revision, digest, outcome: { before_after: 'A useful result' } },
				completion: {
					unit: 'demo/t-0001',
					ready_revision: revision,
					ready_digest: digest,
					phase: 'active',
					verdict: 'open',
					obligations: { verified: { state: 'pending' } },
					holds: {},
				},
			},
		},
		requests: [],
		decisionCapability: 'unavailable',
	}
}
function mount() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
	render(
		<QueryClientProvider client={client}>
			<WiredFactoryUnitPage taskId="task" />
		</QueryClientProvider>,
	)
	return client
}
test('a failed request retries the same identity and viewed binding without displaying approval', async () => {
	const posted: Array<Record<string, unknown>> = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, options?: RequestInit) => {
			if (options?.method === 'POST') {
				posted.push(JSON.parse(String(options.body)))
				return Response.json({ status: 'pending' }, { status: posted.length === 1 ? 503 : 202 })
			}
			return Response.json(unit())
		}),
	)
	const client = mount()
	await screen.findByText('A useful result')
	fireEvent.change(screen.getByLabelText('Your instructions'), { target: { value: 'Review the design' } })
	fireEvent.click(screen.getByRole('button', { name: 'Request approval' }))
	await screen.findByRole('alert')
	fireEvent.click(screen.getByRole('button', { name: 'Request approval' }))
	await waitFor(() => expect(posted).toHaveLength(2))
	expect(posted[0]).toEqual(posted[1])
	expect(posted[0]?.artifactVersionId).toBe(first)
	expect(screen.queryByText('Approved', { exact: true })).toBeNull()
	client.clear()
})
test('a changed projection blocks an existing draft until explicit review of the fresh version', async () => {
	let current = unit()
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json(current)),
	)
	const client = mount()
	await screen.findByText('A useful result')
	fireEvent.change(screen.getByLabelText('Your instructions'), { target: { value: 'Review the design' } })
	current = unit(second, 2)
	await client.invalidateQueries()
	await screen.findByRole('button', { name: 'Review latest version' })
	expect(screen.getByRole('button', { name: 'Request approval' }).hasAttribute('disabled')).toBe(true)
	fireEvent.click(screen.getByRole('button', { name: 'Review latest version' }))
	expect(screen.getByRole('button', { name: 'Request approval' }).hasAttribute('disabled')).toBe(false)
	client.clear()
})
