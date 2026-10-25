import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { hpRequest, HpGateResponseSchema, type HpGateResponse } from '@humanlayer/db/factory-gate'
import { uuidv7 } from 'uuidv7'

import { LOCAL_USER_ID } from './config'
import { DecisionPump, type QueuedRequest } from './decisions'

function fixture() {
	const id = uuidv7()
	const row: QueuedRequest = {
		id,
		artifact_id: uuidv7(),
		created_by_user_id: LOCAL_USER_ID,
		payload: {
			id,
			gate: 'design',
			artifactVersionId: uuidv7(),
			readyRevision: 1,
			readyDigest: 'sha256:' + 'a'.repeat(64),
			reportHash: 'b'.repeat(64),
			words: 'Review this exact report',
		},
	}
	const request = hpRequest(row.payload, row.artifact_id, LOCAL_USER_ID)
	const binding = { ready_revision: 1, ready_digest: row.payload.readyDigest, report_hash: row.payload.reportHash }
	const response = (state: 'requested' | 'awaiting_human_presence' | 'denied' | 'failed' | 'stale') =>
		HpGateResponseSchema.parse({
			api_version: 1,
			unit: 'demo/t-0001',
			record: {
				request,
				fingerprint: 'sha256:' + createHash('sha256').update(JSON.stringify(request)).digest('hex'),
				report: 'Fixture',
				state,
				attempt: state === 'requested' ? null : 'attempt',
				binding,
				reason: 'Fixture outcome',
				receipt: null,
				sequence: 2,
			},
			expected: binding,
			current_binding: binding,
			current: false,
			attestation_required: true,
		})
	return { row, response }
}
test.each(['awaiting_human_presence', 'denied', 'failed', 'stale'] as const)(
	'HP %s never starts another biometric attempt',
	async (state) => {
		const { row, response } = fixture()
		let attest = 0
		const updates: Array<HpGateResponse | null> = []
		const hp = {
			show: async () => response(state),
			request: async () => response(state),
			attest: async () => {
				attest++
				return response(state)
			},
		}
		const pump = new DecisionPump(hp, {
			requests: async () => [row],
			decision: async (_task, _id, result) => {
				updates.push(result)
			},
		})
		await pump.refresh('task')
		await pump.settle()
		await pump.refresh('task')
		expect(attest).toBe(0)
		expect(updates.every((r) => r?.record.state === state)).toBe(true)
	},
)
test('an open HP presence prompt does not block refresh or start a second prompt', async () => {
	const { row, response } = fixture()
	let attest = 0
	let finish: (result: HpGateResponse) => void = () => {}
	const hp = {
		show: async () => response(attest ? 'awaiting_human_presence' : 'requested'),
		request: async () => response('requested'),
		attest: async () => {
			attest++
			return new Promise<HpGateResponse>((resolve) => {
				finish = resolve
			})
		},
	}
	const updates: Array<string | undefined> = []
	const pump = new DecisionPump(hp, {
		requests: async () => [row],
		decision: async (_task, _id, result) => {
			updates.push(result?.record.state)
		},
	})
	await pump.refresh('task')
	await pump.refresh('task')
	expect(attest).toBe(1)
	expect(updates.at(-1)).toBe('awaiting_human_presence')
	finish(response('denied'))
	await pump.settle()
	expect(updates.at(-1)).toBe('denied')
})
test('operational failure and a conflicting HP payload cannot become final authority', async () => {
	const { row, response } = fixture()
	const errors: Array<string | null> = []
	let mismatch = false
	const hp = {
		show: async () => {
			if (!mismatch) throw new Error('Unavailable')
			const result = response('requested')
			result.record.request.words = 'Different intent'
			return result
		},
		request: async () => response('requested'),
		attest: async () => {
			throw new Error('must not attest')
		},
	}
	const pump = new DecisionPump(hp, {
		requests: async () => [row],
		decision: async (_task, _id, result, error) => {
			expect(result).toBeNull()
			errors.push(error)
		},
	})
	await pump.refresh('task')
	mismatch = true
	await pump.refresh('task')
	expect(errors[0]).toBe('Unavailable')
	expect(errors[1]).toContain('differs')
})
