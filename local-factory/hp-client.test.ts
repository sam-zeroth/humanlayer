import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readHpUnit } from './bridge'

const directory = await mkdtemp(join(tmpdir(), 'factory-hp-argv-'))
afterAll(() => rm(directory, { recursive: true, force: true }))
// CLI test double only. Real record/gate integration waits for the coordinator's B3 debug binary.
const fixture = {
	ready: { id: 'demo/t-0001', revision: 1, digest: 'sha256:' + 'a'.repeat(64), outcome: { before_after: 'Fixture' } },
	completion: {
		unit: 'demo/t-0001',
		ready_revision: 1,
		ready_digest: 'sha256:' + 'a'.repeat(64),
		phase: 'active',
		verdict: 'open',
		obligations: {},
		holds: {},
	},
}

test('passes the explicit root and identity as argv, without shell interpretation', async () => {
	const binary = join(directory, 'fixture binary')
	const captured = join(directory, 'argv.json')
	await writeFile(
		binary,
		'#!/usr/bin/env bun\n' +
			'await Bun.write(' +
			JSON.stringify(captured) +
			', JSON.stringify(process.argv.slice(2)));\nconsole.log(' +
			JSON.stringify(JSON.stringify(fixture)) +
			')\n',
		{ mode: 0o700 },
	)
	const root = join(directory, 'root with $literal words')
	expect((await readHpUnit(binary, root, 'demo', 't-0001')).ready.id).toBe('demo/t-0001')
	expect(JSON.parse(await readFile(captured, 'utf8'))).toEqual([
		'--root',
		root,
		'unit',
		'show',
		'demo',
		't-0001',
		'--json',
	])
	await expect(readHpUnit(binary, root, 'other-project', 't-0001')).rejects.toThrow('another unit')
	await expect(readHpUnit(binary, root, 'demo;touch', 't-0001')).rejects.toThrow('Explicit HP binary')
})
test('a stuck read is bounded and cannot freeze replay or shutdown forever', async () => {
	const binary = join(directory, 'stuck fixture')
	await writeFile(binary, '#!/usr/bin/env bun\nawait Bun.sleep(30000)\n', { mode: 0o700 })
	await expect(readHpUnit(binary, directory, 'demo', 't-0001', 100)).rejects.toThrow('timed out')
})
