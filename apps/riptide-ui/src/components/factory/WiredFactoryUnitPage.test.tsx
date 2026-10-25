import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { WiredFactoryUnitPage } from './WiredFactoryUnitPage'

vi.mock('@workos-inc/authkit-react', () => ({ useAuth: () => ({ getAccessToken: async () => 'local-test-token' }) }))
afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
	vi.useRealTimers()
	vi.restoreAllMocks()
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
				gateContext: {
					api_version: 1,
					unit: 'demo/t-0001',
					binding: { ready_revision: revision, ready_digest: digest, report_hash: 'b'.repeat(64) },
					gate: 'design',
					report: 'Gate: design — Review this exact report',
				},
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
		decisionCapability: 'available',
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

test.each([
	['accepted', true, 0, 'Approval recorded'],
	['accepted', false, 0, 'Superseded — review the current document'],
	['denied', false, 0, 'Confirmation cancelled or denied'],
	['failed', false, 0, 'Confirmation failed — review and submit a new request'],
	['awaiting_human_presence', false, 0, 'Confirm on this Mac'],
	['accepted', true, 16_000, 'Could not confirm the decision. Check the local stack.'],
] as const)('renders HP %s, current %s, age %s with authority-safe status', async (state, current, age, label) => {
	const data = unit()
	const context = data.projection.snapshot.gateContext
	const id = second
	const payload = {
		id,
		gate: 'design',
		artifactVersionId: first,
		readyRevision: 1,
		readyDigest: context.binding.ready_digest,
		reportHash: context.binding.report_hash,
		words: 'Approve this viewed report',
	}
	const wire = {
		api_version: 1,
		request_id: 'hl:' + id,
		gate: 'design',
		expected_ready_revision: 1,
		expected_ready_digest: payload.readyDigest,
		expected_report_hash: payload.reportHash,
		artifact: { system: 'humanlayer', id: first, version: first },
		requester: { system: 'humanlayer', subject: 'user_factory_local', authorship: 'authenticated-user' },
		words: payload.words,
	}
	const response = {
		api_version: 1,
		unit: 'demo/t-0001',
		record: {
			request: wire,
			fingerprint: 'sha256:' + 'c'.repeat(64),
			report: context.report,
			state,
			attempt: 'attempt',
			binding: context.binding,
			reason: 'HP outcome',
			receipt:
				state === 'accepted'
					? {
							id: 'hp-receipt',
							attempt: 'attempt',
							method: 'touch_id',
							when: new Date().toISOString(),
							binding: context.binding,
							packet_digest: null,
						}
					: null,
			sequence: 4,
		},
		expected: context.binding,
		current_binding: current ? context.binding : null,
		current,
		attestation_required: true,
	}
	const checkedAt = Date.now() - age
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			Response.json({
				...data,
				requests: [
					{
						id,
						payload,
						created_at: Date.now(),
						hp_response: response,
						hp_checked_at: checkedAt,
						delivery_error: null,
					},
				],
			}),
		),
	)
	const client = mount()
	await screen.findByText(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
	if (label !== 'Approval recorded') expect(screen.queryByText(/^Approval recorded/)).toBeNull()
	if (label === 'Approval recorded') {
		// Returning to a tab must expire authority even if the server cache is structurally unchanged.
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16_000)
		act(() => document.dispatchEvent(new Event('visibilitychange')))
		expect(screen.queryByText(/^Approval recorded/)).toBeNull()
		expect(screen.getByText(/Could not confirm the decision/)).toBeTruthy()
	}

	client.clear()
})
