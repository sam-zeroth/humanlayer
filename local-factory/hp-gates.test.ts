import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

import { hpRequest, currentHpApproval } from '@humanlayer/db/factory-gate'
import { uuidv7 } from 'uuidv7'

import { readHpProjection } from './bridge'
import { LOCAL_USER_ID } from './config'
import { DecisionPump, type QueuedRequest } from './decisions'
import { createHpFixture } from './hp-fixture'
import { HpGates } from './hp-gates'

const binary = process.env.LOCAL_HP_TEST_BINARY
const integration = binary ? test : test.skip
const directory = await mkdtemp(join(tmpdir(), 'hl-real-hp-'))
afterAll(() => rm(directory, { recursive: true, force: true }))
integration(
	'real B3 CLI round trip, lost acknowledgement replay, stale report and fresh positive control',
	async () => {
		if (!binary) throw new Error('Missing HP test binary')
		const fixture = await createHpFixture(binary, directory, resolve(import.meta.dir, '..'))
		// A small-band design needs no Touch ID on any HP; live-test and merge now do, and must never be attested here.
		await writeFile(
			fixture.report,
			'Gate: design — Review this exact output\n\n## Report\nA disposable HumanLayer round-trip test.\n',
		)
		const hp = new HpGates(binary, fixture.root, 'demo', 't-0001')
		expect((await hp.capabilities()).capability).toBe('factory-gates-v1')
		const context = await hp.context()
		const row: QueuedRequest = {
			id: uuidv7(),
			created_by_user_id: LOCAL_USER_ID,
			artifact_id: uuidv7(),
			payload: {
				id: '',
				gate: 'design',
				artifactVersionId: uuidv7(),
				readyRevision: context.binding.ready_revision,
				readyDigest: context.binding.ready_digest,
				reportHash: context.binding.report_hash,
				words: 'Approve the exact viewed report',
			},
		}
		row.payload.id = row.id
		let writes = 0
		let receiptId: string | undefined
		const surface = {
			requests: async () => [row],
			decision: async (_task: string, _id: string, response: Awaited<ReturnType<typeof hp.show>> | null) => {
				if (response?.record.state === 'accepted') {
					writes++
					receiptId = response.record.receipt?.id
					if (writes === 1) throw new Error('Lost acknowledgement after HP append')
				}
			},
		}
		const pump = new DecisionPump(hp, surface)
		await pump.refresh('task')
		await pump.settle()
		const accepted = await hp.show('hl:' + row.id)
		expect(accepted.record.state).toBe('accepted')
		expect(accepted.record.receipt?.method).toBe('authorship_only')
		expect(currentHpApproval(accepted, context, Date.now())).toBe(true)
		const restarted = new DecisionPump(hp, surface)
		await restarted.refresh('task')
		await restarted.settle()
		expect(writes).toBe(2)
		expect(receiptId).toBe(accepted.record.receipt?.id)
		expect((await hp.show('hl:' + row.id)).record.sequence).toBe(accepted.record.sequence)
		await expect(
			hp.request({ ...hpRequest(row.payload, row.artifact_id, LOCAL_USER_ID), words: 'Changed intent' }),
		).rejects.toThrow('conflict')
		await writeFile(fixture.report, 'Gate: design — Updated report\n\nChanged reviewed bytes.\n')
		const superseded = await hp.show('hl:' + row.id)
		expect(superseded.record.state).toBe('accepted')
		expect(superseded.current).toBe(false)
		const stale = await hp.request({
			...hpRequest(row.payload, row.artifact_id, LOCAL_USER_ID),
			request_id: 'hl:' + uuidv7(),
		})
		expect(stale.record.state).toBe('stale')
		expect(stale.record.receipt).toBeNull()
		const freshContext = await hp.context()
		const fresh = await hp.request({
			...hpRequest(
				{ ...row.payload, reportHash: freshContext.binding.report_hash },
				row.artifact_id,
				LOCAL_USER_ID,
			),
			request_id: 'hl:' + uuidv7(),
		})
		const confirmed = await hp.attest(fresh.record.request.request_id)
		expect(currentHpApproval(confirmed, freshContext, Date.now())).toBe(true)
		expect(currentHpApproval(confirmed, freshContext, Date.now() - 16_000)).toBe(false)
	},
	30_000,
)

integration('standard design remains requested until HP-owned presence; automated checks never attest it', async () => {
	if (!binary) throw new Error('Missing HP test binary')
	const fixture = await createHpFixture(
		binary,
		join(directory, 'standard'),
		resolve(import.meta.dir, '..'),
		'standard',
	)
	const hp = new HpGates(binary, fixture.root, 'demo', 't-0001')
	const context = await hp.context()
	const intent = {
		id: uuidv7(),
		gate: 'design',
		artifactVersionId: uuidv7(),
		readyRevision: context.binding.ready_revision,
		readyDigest: context.binding.ready_digest,
		reportHash: context.binding.report_hash,
		words: 'Review this exact design',
	}
	const response = await hp.request(hpRequest(intent, uuidv7(), LOCAL_USER_ID))
	expect(response.record.state).toBe('requested')
	expect(response.attestation_required).toBe(true)
	expect(response.record.receipt).toBeNull()
	expect(response.current).toBe(false)
})

integration('projection retries a Ready amendment between its unit and report reads', async () => {
	if (!binary) throw new Error('Missing HP test binary')
	const fixture = await createHpFixture(binary, join(directory, 'coherence'), resolve(import.meta.dir, '..'))
	const hp = new HpGates(binary, fixture.root, 'demo', 't-0001')
	const original = hp.context.bind(hp)
	let reads = 0
	hp.context = async () => {
		reads++
		if (reads === 1) {
			const ready = await Bun.file(fixture.ready).json()
			ready.outcome.before_after = 'Amended during projection'
			await writeFile(fixture.ready, JSON.stringify(ready))
			await fixture.run(['unit', 'amend', 'demo', 't-0001', '--ready', fixture.ready])
		}
		return original()
	}
	const result = await readHpProjection(hp)
	expect(reads).toBe(2)
	expect(result.ready.revision).toBe(2)
	expect(result.gateContext?.binding.ready_revision).toBe(2)
})

integration('historical authorship receipt stays superseded when current Ready now requires Touch ID', async () => {
	if (!binary) throw new Error('Missing HP test binary')
	const fixture = await createHpFixture(binary, join(directory, 'policy-change'), resolve(import.meta.dir, '..'))
	await writeFile(fixture.report, 'Gate: design — Review a small design\n')
	const hp = new HpGates(binary, fixture.root, 'demo', 't-0001')
	const context = await hp.context()
	const intent = {
		id: uuidv7(),
		gate: 'design',
		artifactVersionId: uuidv7(),
		readyRevision: context.binding.ready_revision,
		readyDigest: context.binding.ready_digest,
		reportHash: context.binding.report_hash,
		words: 'Review the small design',
	}
	const request = await hp.request(hpRequest(intent, uuidv7(), LOCAL_USER_ID))
	const accepted = await hp.attest(request.record.request.request_id)
	expect(accepted.record.receipt?.method).toBe('authorship_only')
	const ready = await Bun.file(fixture.ready).json()
	ready.band = 'standard'
	await writeFile(fixture.ready, JSON.stringify(ready))
	await fixture.run(['unit', 'amend', 'demo', 't-0001', '--ready', fixture.ready])
	const old = await hp.show(request.record.request.request_id)
	expect(old.record.state).toBe('accepted')
	expect(old.record.receipt?.method).toBe('authorship_only')
	expect(old.attestation_required).toBe(true)
	expect(old.current).toBe(false)
	expect(currentHpApproval(old, await hp.context(), Date.now())).toBe(false)
})

integration('live-test and merge stay requested and require Touch ID; automated checks never attest them', async () => {
	if (!binary) throw new Error('Missing HP test binary')
	for (const gate of ['live-test', 'merge'] as const) {
		const fixture = await createHpFixture(
			binary,
			join(directory, 'presence-' + gate),
			resolve(import.meta.dir, '..'),
		)
		await writeFile(fixture.report, `Gate: ${gate} — Sam signs this exact report\n`)
		const hp = new HpGates(binary, fixture.root, 'demo', 't-0001')
		const context = await hp.context()
		expect(context.gate).toBe(gate)
		const intent = {
			id: uuidv7(),
			gate,
			artifactVersionId: uuidv7(),
			readyRevision: context.binding.ready_revision,
			readyDigest: context.binding.ready_digest,
			reportHash: context.binding.report_hash,
			words: 'Sign this exact report',
		}
		const response = await hp.request(hpRequest(intent, uuidv7(), LOCAL_USER_ID))
		expect(response.record.state).toBe('requested')
		expect(response.attestation_required).toBe(true)
		expect(response.current).toBe(false)
	}
})
