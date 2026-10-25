import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chromeWrapper } from './browser'

const directory = await mkdtemp(join(tmpdir(), 'factory-browser-'))
afterAll(() => rm(directory, { recursive: true, force: true }))
test('generated launcher preserves quoted paths and literal Chrome arguments', async () => {
	const executable = join(directory, "browser with 'quotes'")
	await writeFile(executable, '#!/bin/sh\nprintf "<%s>\\n" "$@"\n', { mode: 0o700 })
	const wrapper = join(directory, 'wrapper')
	await writeFile(wrapper, chromeWrapper(executable, 'leaf-public-key-pin', false), { mode: 0o700 })
	const child = Bun.spawn(['/bin/sh', wrapper, 'literal-$HOME-`id`'], { stdout: 'pipe' })
	const stdout = await new Response(child.stdout).text()
	expect(await child.exited).toBe(0)
	expect(stdout).toContain('<--ignore-certificate-errors-spki-list=leaf-public-key-pin>')
	expect(stdout).toContain('<--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost>')
	expect(stdout).toContain('<literal-$HOME-`id`>')
})
