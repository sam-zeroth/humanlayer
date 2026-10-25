import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const source = resolve(import.meta.dir, '..')
const directory = await mkdtemp(join(tmpdir(), 'factory-sdk-trap-'))
afterAll(() => rm(directory, { recursive: true, force: true }))
beforeAll(async () => {
	await mkdir(join(directory, 'local-factory'), { recursive: true })
	await cp(join(source, 'local-factory/config.ts'), join(directory, 'local-factory/config.ts'))
	for (const app of ['riptide-api', 'riptide-electric-proxy']) {
		const original = join(source, 'apps', app)
		const copy = join(directory, 'apps', app)
		await mkdir(copy, { recursive: true })
		await cp(join(original, 'src'), join(copy, 'src'), { recursive: true })
		await cp(join(original, 'tsconfig.json'), join(copy, 'tsconfig.json'))
		await mkdir(join(copy, 'node_modules'), { recursive: true })
		for (const entry of await readdir(join(original, 'node_modules'))) {
			if (entry.startsWith('.')) continue
			if (entry.startsWith('@')) {
				await mkdir(join(copy, 'node_modules', entry))
				for (const member of await readdir(join(original, 'node_modules', entry))) {
					if (entry === '@workos-inc' && member === 'node') continue
					await symlink(
						join(original, 'node_modules', entry, member),
						join(copy, 'node_modules', entry, member),
					)
				}
			} else await symlink(join(original, 'node_modules', entry), join(copy, 'node_modules', entry))
		}
		const sdk = join(copy, 'node_modules/@workos-inc/node')
		await mkdir(sdk, { recursive: true })
		await writeFile(
			join(sdk, 'package.json'),
			JSON.stringify({ name: '@workos-inc/node', type: 'module', exports: './index.js' }),
		)
		await writeFile(
			join(sdk, 'index.js'),
			"throw new Error('FACTORY_WORKOS_RUNTIME_EXECUTED'); export class WorkOS {}",
		)
	}
})
async function run(code: string) {
	const child = Bun.spawn(['bun', '--eval', code], {
		cwd: directory,
		env: {
			...process.env,
			LOCAL_SURFACE: '1',
			LOCAL_BROWSER_ORIGIN: 'https://127.0.0.1:55813',
			WORKOS_API_KEY: '',
			WORKOS_CLIENT_ID: '',
			WORKOS_REDIRECT_URI: '',
		},
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
	return { status, stderr }
}

test('copied-source SDK trap has a failing positive control', async () => {
	const result = await run("await import('./apps/riptide-api/node_modules/@workos-inc/node')")
	expect(result.status).not.toBe(0)
	expect(result.stderr).toContain('FACTORY_WORKOS_RUNTIME_EXECUTED')
})
test('unchanged local composition source runs without an executable SDK', async () => {
	const result = await run(
		"await import('./apps/riptide-api/src/workos'); await import('./apps/riptide-electric-proxy/src/auth/effect/workos.service')",
	)
	expect(result.status).toBe(0)
	expect(result.stderr).not.toContain('FACTORY_WORKOS_RUNTIME_EXECUTED')
})
