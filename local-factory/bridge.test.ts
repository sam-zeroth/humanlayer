import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FactorySnapshotSchema } from '@humanlayer/db/factory-unit'

import { BridgeJournal, projectUnit, type Surface } from './bridge'

const directory = await mkdtemp(join(tmpdir(), 'factory-bridge-'))
afterAll(() => rm(directory, { recursive: true, force: true }))
const snapshot = (revision: number, state = 'pending') => ({
	ready: {
		id: 'demo/t-0001',
		revision,
		digest: 'sha256:' + String(revision).repeat(64),
		outcome: { before_after: 'A useful unit' },
	},
	completion: {
		unit: 'demo/t-0001',
		ready_revision: revision,
		ready_digest: 'sha256:' + String(revision).repeat(64),
		phase: 'active',
		verdict: 'open',
		obligations: { verified: { state } },
		holds: {},
	},
})
class FakeSurface implements Surface {
	tasks = new Set<string>()
	versions = new Map<string, string[]>()
	published: unknown[] = []
	crash = false
	async ensureTask(id: string) {
		this.tasks.add(id)
	}
	async upsert(_taskId: string, artifactId: string, _name: string, content: string) {
		const contents = this.versions.get(artifactId) ?? []
		if (contents.at(-1) !== content) contents.push(content)
		this.versions.set(artifactId, contents)
		return 'version-' + contents.length
	}
	async publish(_taskId: string, _artifactId: string, version: string, value: unknown) {
		if (this.crash) throw new Error('Injected crash after remote write')
		this.published.push({ version, value })
	}
}

test('durable mapping survives a crash after remote success before checkpoint', async () => {
	const path = join(directory, 'crash.sqlite')
	let journal = new BridgeJournal(path)
	const surface = new FakeSurface()
	surface.crash = true
	await expect(projectUnit(journal, surface, snapshot(1))).rejects.toThrow('Injected crash')
	const mapping = journal.mapping('demo/t-0001')
	expect(mapping.last_hash).toBeNull()
	journal.close()
	journal = new BridgeJournal(path)
	surface.crash = false
	await projectUnit(journal, surface, snapshot(1))
	expect(journal.mapping('demo/t-0001').task_id).toBe(mapping.task_id)
	expect(surface.tasks.size).toBe(1)
	expect(surface.versions.get(mapping.artifact_id)?.length).toBe(1)
	journal.close()
})
test('deduplicates identical state but delivers completion-only changes', async () => {
	const journal = new BridgeJournal(join(directory, 'completion.sqlite'))
	const surface = new FakeSurface()
	await projectUnit(journal, surface, snapshot(1))
	await projectUnit(journal, surface, snapshot(1))
	expect(surface.published.length).toBe(1)
	await projectUnit(journal, surface, snapshot(1, 'done'))
	expect(surface.published.length).toBe(2)
	journal.close()
})
test('rejects older revisions and inconsistent HP projections', async () => {
	const journal = new BridgeJournal(join(directory, 'stale.sqlite'))
	const surface = new FakeSurface()
	await projectUnit(journal, surface, snapshot(3))
	await expect(projectUnit(journal, surface, snapshot(2))).rejects.toThrow('regressed')
	const broken = snapshot(3)
	broken.completion.ready_revision = 2
	expect(() => FactorySnapshotSchema.parse(broken)).toThrow()
	expect(surface.published.length).toBe(1)
	journal.close()
})
test('reconciles the remote projection on restart even if checkpoint matches', async () => {
	const journal = new BridgeJournal(join(directory, 'restart.sqlite'))
	const surface = new FakeSurface()
	await projectUnit(journal, surface, snapshot(1))
	await projectUnit(journal, surface, snapshot(1), true)
	expect(surface.published.length).toBe(2)
	const mapping = journal.mapping('demo/t-0001')
	expect(surface.versions.get(mapping.artifact_id)?.length).toBe(1)
	journal.close()
})

test('a retained delivery journal refuses a different HP root or unit', () => {
	const path = join(directory, 'source.sqlite')
	let journal = new BridgeJournal(path)
	journal.bindSource('/owned/root', 'demo/t-0001')
	const mapping = journal.mapping('demo/t-0001')
	journal.close()
	journal = new BridgeJournal(path)
	journal.bindSource('/owned/root', 'demo/t-0001')
	expect(journal.mapping('demo/t-0001').task_id).toBe(mapping.task_id)
	expect(() => journal.bindSource('/another/root', 'demo/t-0001')).toThrow('source changed')
	expect(() => journal.bindSource('/owned/root', 'demo/t-0002')).toThrow('source changed')
	journal.close()
})
