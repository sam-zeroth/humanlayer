import { expect, test } from 'vitest'

import {
	factoryPacket,
	FactoryRequestSchema,
	FactorySnapshotSchema,
	gateHistory,
	gateRecordLabel,
	gateUnsupported,
	renderFactoryUnit,
	reportGate,
} from '../src/factory-unit'

const digest = 'sha256:' + 'a'.repeat(64)
const binding = { ready_revision: 2, ready_digest: digest, report_hash: 'b'.repeat(64) }
// Shaped like unit 2's Ready rev 2 (software-factory/t-0032) as `unit show` returns it.
function snapshot(overrides: { report?: string; gate?: string | null; gates?: Record<string, unknown> } = {}) {
	return FactorySnapshotSchema.parse({
		ready: {
			id: 'demo/t-0001',
			revision: 2,
			digest,
			request: { original: 'Show the friendly page', amendments: ['C7 adds the Next 16 guide'] },
			outcome: {
				before_after: 'Raw JSON 404 → friendly page',
				exclusions: ['@pyrana/auth', 'publishing packages'],
				failure_cases: ['C1: page.tsx deleted'],
			},
			authority: { must_return: ['an edit outside the editable paths'] },
			acceptance: [
				{
					id: 'C1',
					type: 'behaviour',
					stage: 'pre_merge',
					environment: 'local',
					scenario:
						'claim: the page exports AuthErrorRoute\nfails_today: true\nmust_accept:\n  - "export { AuthErrorRoute as default } from \'@pyrana/auth/next\';"\nmust_reject:\n  - page.tsx deleted\n  - "export default function X() { return null }"',
					oracle: { kind: 'command', run: 'pnpm vitest run app/auth/error/page.test.ts' },
				},
				{
					id: 'LIVE',
					type: 'behaviour',
					stage: 'pre_merge',
					environment: 'local',
					scenario: 'owner: sam\nmerge_time: true\nclaim: a failed-login URL shows the friendly page',
					oracle: { kind: 'observation', run: 'Sam: run ./proof/live.sh up' },
				},
			],
		},
		gateContext: {
			api_version: 1,
			unit: 'demo/t-0001',
			binding,
			gate: overrides.gate === undefined ? 'live-test' : overrides.gate,
			report: overrides.report ?? 'Gate: live-test — Sam checks the page',
		},
		gates: overrides.gates,
		completion: {
			unit: 'demo/t-0001',
			ready_revision: 2,
			ready_digest: digest,
			phase: 'active',
			verdict: 'open',
			obligations: { merged: { state: 'pending' } },
			holds: {},
			pr: 'https://github.com/zeroth-agents/pyrana/pull/2820',
		},
	})
}
const record = (sequence: number, reportHash: string, method = 'authorship_only', revision = 2) => ({
	request: { gate: 'live-test', words: 'LIVE passed', requester: { system: 'chat', subject: 'sam' } },
	state: 'accepted',
	binding: { ...binding, ready_revision: revision, report_hash: reportHash },
	receipt: { id: 'sha256:r', method, when: '2026-10-25T22:55:41Z' },
	sequence,
})

test('packet parts 1, 3, 4 and 7 come from the Ready, with the live check split out', () => {
	const packet = factoryPacket(snapshot().ready)
	expect(packet.outcome).toBe('Raw JSON 404 → friendly page')
	expect(packet.request).toBe('Show the friendly page')
	expect(packet.criteria.map((row) => row.id)).toEqual(['C1'])
	expect(packet.criteria[0]).toMatchObject({
		claim: 'the page exports AuthErrorRoute',
		mustAccept: ["export { AuthErrorRoute as default } from '@pyrana/auth/next';"],
		mustReject: ['page.tsx deleted', 'export default function X() { return null }'],
		provenBy: 'pnpm vitest run app/auth/error/page.test.ts',
	})
	expect(packet.exclusions).toEqual(['@pyrana/auth', 'publishing packages'])
	expect(packet.amendments).toEqual(['C7 adds the Next 16 guide'])
	expect(packet.mustReturn).toEqual(['an edit outside the editable paths'])
	expect(packet.liveCheck).toMatchObject({ id: 'LIVE', owner: 'sam', provenBy: 'Sam: run ./proof/live.sh up' })
})

test('a Ready without optional parts renders empty sections instead of failing', () => {
	const packet = factoryPacket({
		id: 'demo/t-0001',
		revision: 1,
		digest,
		outcome: { before_after: 'Only an outcome' },
	})
	expect(packet).toMatchObject({ criteria: [], exclusions: [], amendments: [], mustReturn: [], liveCheck: null })
	expect(renderFactoryUnit({ ...snapshot(), ready: { ...snapshot().ready, acceptance: undefined } })).toContain(
		'No live check in this Ready.',
	)
})

test('unit.md reads as a packet first and keeps the exact HP snapshot last', () => {
	const md = renderFactoryUnit(snapshot({ gates: { a: record(5, 'b'.repeat(64)) } }))
	const order = [
		'## 1. Outcome',
		'## 3. Definition of done',
		'## 4. Exclusions',
		"## 7. Sam's live check",
		'## Pull request',
		'## Gate history',
		'## HP snapshot',
	]
	const positions = order.map((heading) => md.indexOf(heading))
	expect(positions.every((position) => position >= 0)).toBe(true)
	expect([...positions].sort((a, b) => a - b)).toEqual(positions)
	expect(md).toContain('**Proven by:** pnpm vitest run app/auth/error/page.test.ts')
	expect(md).toContain('Live test: Approved · authored · Ready revision 2')
	expect(md).toContain('https://github.com/zeroth-agents/pyrana/pull/2820')
})

test('gate history is newest first and labels earlier reports and earlier Readies', () => {
	const current = snapshot({
		gates: {
			old: record(3, 'c'.repeat(64), 'touch_id', 1),
			used: record(5, 'd'.repeat(64)),
			now: record(7, 'b'.repeat(64), 'touch_id'),
		},
	})
	const history = gateHistory(current)
	expect(history.map((item) => item.sequence)).toEqual([7, 5, 3])
	expect(history.map((item) => gateRecordLabel(item, current))).toEqual([
		'Approved · Touch ID',
		'Approved · authored (earlier report)',
		'Approved · Touch ID (earlier Ready)',
	])
})

test('merge is a requestable gate, and an HP that cannot name it is reported as unsupported', () => {
	expect(FactoryRequestSchema.shape.gate.safeParse('merge').success).toBe(true)
	expect(reportGate('PR: https://example.test/pull/1\nGate: merge — Sam merges')).toBe('merge')
	expect(reportGate('## Report\nGate: merge')).toBeNull()
	expect(gateUnsupported(snapshot({ gate: null, report: 'Gate: merge — Sam merges' }))).toBe(true)
	expect(gateUnsupported(snapshot({ gate: 'merge', report: 'Gate: merge — Sam merges' }))).toBe(false)
	expect(gateUnsupported(snapshot({ gate: null, report: '## Report\nNo stop' }))).toBe(false)
})
