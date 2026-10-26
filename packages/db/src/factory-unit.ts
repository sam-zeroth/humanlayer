import z from 'zod/v4'

import { FactoryGateContextSchema } from './factory-gate'

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const FactorySnapshotSchema = z
	.object({
		ready: z.looseObject({
			id: z.string().regex(/^[^/]+\/t-\d+$/),
			revision: z.number().int().positive(),
			digest: Digest,
			outcome: z.looseObject({ before_after: z.string() }),
		}),
		gateContext: FactoryGateContextSchema.optional(),
		// HP's gate journal for the unit (`unit show`). History only; current approval comes from `unit gate show`.
		gates: z
			.record(
				z.string(),
				z.looseObject({
					request: z.looseObject({
						gate: z.string(),
						words: z.string(),
						requester: z.looseObject({ system: z.string(), subject: z.string() }).optional(),
					}),
					state: z.enum(['requested', 'awaiting_human_presence', 'accepted', 'stale', 'denied', 'failed']),
					binding: z.looseObject({
						ready_revision: z.number().int(),
						ready_digest: z.string(),
						report_hash: z.string(),
					}),
					receipt: z.looseObject({ id: z.string(), method: z.string(), when: z.string() }).nullable(),
					sequence: z.number().int().nonnegative(),
				}),
			)
			.optional(),
		completion: z.looseObject({
			unit: z.string(),
			ready_revision: z.number().int().positive(),
			ready_digest: Digest,
			phase: z.enum(['active', 'landed', 'closed']),
			verdict: z.enum(['open', 'closed', 'closed_with_waivers', 'abandoned']),
			obligations: z.record(
				z.string(),
				z.looseObject({ state: z.enum(['pending', 'done', 'failed', 'waived', 'n/a']) }),
			),
			holds: z.record(z.string(), z.unknown()),
		}),
	})
	.refine(
		(s) =>
			s.ready.id === s.completion.unit &&
			s.ready.revision === s.completion.ready_revision &&
			s.ready.digest === s.completion.ready_digest &&
			(!s.gateContext ||
				(s.gateContext.unit === s.ready.id &&
					s.gateContext.binding.ready_revision === s.ready.revision &&
					s.gateContext.binding.ready_digest === s.ready.digest)),
		{ message: 'Inconsistent HP snapshot' },
	)
export type FactorySnapshot = z.infer<typeof FactorySnapshotSchema>
export const FactoryRequestSchema = z
	.object({
		id: z.uuid(),
		gate: z.enum(['design', 'live-test', 'merge', 'apply', 'publish']),
		artifactVersionId: z.uuid(),
		readyRevision: z.number().int().positive(),
		readyDigest: Digest,
		reportHash: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
		words: z
			.string()
			.min(1)
			.max(500)
			.refine((value) => value.trim().length > 0),
	})
	.strict()
export type FactoryRequest = z.infer<typeof FactoryRequestSchema>
export const factoryGateLabels: Record<FactoryRequest['gate'], string> = {
	design: 'Design',
	'live-test': 'Live test',
	merge: 'Merge',
	apply: 'Apply',
	publish: 'Publish',
}

/** The stop a report asks for, from its header (`Gate: <name> — …` in the first two lines). */
export function reportGate(report: string): string | null {
	for (const line of report.split('\n').slice(0, 2)) {
		const match = /^Gate:\s*([a-z-]+)/.exec(line.trim())
		if (match?.[1]) return match[1]
		// The header is only `PR:` and `Gate:` lines; anything else ends it.
		if (!line.startsWith('PR:')) break
	}
	return null
}
/** The report asks for a gate this HP binary can't name (an older HP drops unknown gates to null). */
export const gateUnsupported = (snapshot: FactorySnapshot) =>
	!!snapshot.gateContext && snapshot.gateContext.gate === null && reportGate(snapshot.gateContext.report) !== null

export interface PacketCriterion {
	id: string
	type: string
	stage: string
	environment: string
	claim: string
	mustAccept: string[]
	mustReject: string[]
	provenBy: string
	owner: string | null
}
export interface FactoryPacket {
	outcome: string
	request: string | null
	criteria: PacketCriterion[]
	exclusions: string[]
	failureCases: string[]
	amendments: string[]
	mustReturn: string[]
	liveCheck: PacketCriterion | null
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const strings = (value: unknown) =>
	Array.isArray(value)
		? value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).filter(Boolean)
		: []
const field = (value: unknown, key: string): unknown =>
	value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined

/** A DoD scenario is a small YAML block: `key: value` lines and `key:` followed by `  - item` lists. */
function scenarioFields(scenario: string) {
	const fields: Record<string, string> = {}
	const lists: Record<string, string[]> = {}
	let list: string[] | null = null
	for (const line of scenario.split('\n')) {
		const item = /^\s+-\s+(.*)$/.exec(line)
		if (item?.[1] !== undefined && list) {
			list.push(item[1].replace(/^"(.*)"$/, '$1'))
			continue
		}
		const pair = /^([a-z_]+):\s*(.*)$/.exec(line)
		if (pair?.[1]) {
			list = null
			if (pair[2]) fields[pair[1]] = pair[2]
			else list = lists[pair[1]] = []
		} else if (list === null && line.trim()) fields.claim = ((fields.claim ?? '') + ' ' + line.trim()).trim()
	}
	return { fields, lists }
}

function criterion(row: unknown): PacketCriterion {
	const { fields, lists } = scenarioFields(text(field(row, 'scenario')))
	return {
		id: text(field(row, 'id')) || '?',
		type: text(field(row, 'type')),
		stage: text(field(row, 'stage')),
		environment: text(field(row, 'environment')),
		claim: fields.claim ?? text(field(row, 'scenario')),
		mustAccept: lists.must_accept ?? [],
		mustReject: lists.must_reject ?? [],
		provenBy: text(field(field(row, 'oracle'), 'run')),
		owner: fields.owner ?? null,
	}
}

/** Packet parts 1, 3, 4 and 7 from a Ready. Ready is loose-typed, so absent parts render empty. */
export function factoryPacket(ready: FactorySnapshot['ready']): FactoryPacket {
	const rows = Array.isArray(field(ready, 'acceptance')) ? (field(ready, 'acceptance') as unknown[]) : []
	const criteria = rows.map(criterion)
	const live = criteria.find((row) => row.id === 'LIVE' || row.owner === 'sam') ?? null
	const request = field(ready, 'request')
	return {
		outcome: ready.outcome.before_after,
		request: text(field(request, 'original')) || null,
		criteria: criteria.filter((row) => row !== live),
		exclusions: strings(field(ready.outcome, 'exclusions')),
		failureCases: strings(field(ready.outcome, 'failure_cases')),
		amendments: strings(field(request, 'amendments')),
		mustReturn: strings(field(field(ready, 'authority'), 'must_return')),
		liveCheck: live,
	}
}

export type FactoryGateRecord = NonNullable<FactorySnapshot['gates']>[string]
/** HP's gate records in journal order, newest first. */
export const gateHistory = (snapshot: FactorySnapshot) =>
	Object.values(snapshot.gates ?? {}).sort((a, b) => b.sequence - a.sequence)

/** Historical fact only. Current approval comes from `unit gate show`, never from this label. */
export function gateRecordLabel(record: FactoryGateRecord, snapshot: FactorySnapshot) {
	const states = {
		requested: 'Requested',
		awaiting_human_presence: 'Waiting for confirmation on this Mac',
		accepted: 'Approved',
		stale: 'Superseded',
		denied: 'Cancelled or denied',
		failed: 'Failed',
	}
	let label = states[record.state]
	if (record.state === 'accepted') {
		label += record.receipt?.method === 'touch_id' ? ' · Touch ID' : ' · authored'
		const current = snapshot.gateContext?.binding
		if (
			record.binding.ready_revision !== snapshot.ready.revision ||
			record.binding.ready_digest !== snapshot.ready.digest
		)
			label += ' (earlier Ready)'
		else if (current && record.binding.report_hash !== current.report_hash) label += ' (earlier report)'
	}
	return label
}

function sorted(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sorted)
	if (value !== null && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, child]) => [key, sorted(child)]),
		)
	return value
}
export const canonicalFactorySnapshot = (snapshot: FactorySnapshot) => JSON.stringify(sorted(snapshot))
const bullets = (items: string[]) => (items.length ? items.map((item) => `- ${item}`).join('\n') : '- None')
function criterionMarkdown(row: PacketCriterion) {
	const lines = [
		`### ${row.id}${row.type ? ` · ${row.type}` : ''}${row.stage ? ` · ${row.stage}` : ''}`,
		'',
		row.claim,
	]
	if (row.mustAccept.length) lines.push('', '**Must accept**', '', bullets(row.mustAccept))
	if (row.mustReject.length) lines.push('', '**Must reject**', '', bullets(row.mustReject))
	if (row.provenBy) lines.push('', `**Proven by:** ${row.provenBy}`)
	return lines.join('\n')
}

/** unit.md: the readable packet first, then gate history and PR, then the exact HP snapshot. */
export function renderFactoryUnit(snapshot: FactorySnapshot) {
	const packet = factoryPacket(snapshot.ready)
	const { completion } = snapshot
	const pr = typeof completion.pr === 'string' && completion.pr ? completion.pr : null
	const history = gateHistory(snapshot)
	return (
		[
			`# ${snapshot.ready.id}`,
			`Ready revision ${snapshot.ready.revision} · ${completion.phase}`,
			'HP is authoritative. Browser decisions are requests until HP records them.',
			'## 1. Outcome',
			packet.outcome,
			`**Original request:** ${packet.request ?? 'Not in this Ready.'}`,
			'## 3. Definition of done',
			packet.criteria.length ? packet.criteria.map(criterionMarkdown).join('\n\n') : 'No criteria in this Ready.',
			'## 4. Exclusions and amendments',
			'**Out of scope**',
			bullets(packet.exclusions),
			'**Failure cases**',
			bullets(packet.failureCases),
			'**Amendments**',
			bullets(packet.amendments),
			'**Stop and return if**',
			bullets(packet.mustReturn),
			"## 7. Sam's live check",
			packet.liveCheck ? criterionMarkdown(packet.liveCheck) : 'No live check in this Ready.',
			'## Pull request',
			pr
				? `${pr}${typeof completion.pr_head === 'string' && completion.pr_head ? ` at \`${completion.pr_head}\`` : ''}`
				: 'No pull request recorded.',
			'## Gate history',
			history.length
				? bullets(
						history.map(
							(record) =>
								`${factoryGateLabels[record.request.gate as FactoryRequest['gate']] ?? record.request.gate}: ${gateRecordLabel(record, snapshot)} · Ready revision ${record.binding.ready_revision}${record.receipt ? ` · ${record.receipt.when}` : ''} — ${record.request.words}`,
						),
					)
				: 'No gate records.',
			'## HP snapshot',
			'```json\n' + canonicalFactorySnapshot(snapshot) + '\n```',
		].join('\n\n') + '\n'
	)
}
