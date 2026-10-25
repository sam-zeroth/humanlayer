import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Same inert thread-metadata fixture as B3's CLI tests; never writes unit journals or receipts. */
export async function createHpFixture(
	binary: string,
	directory: string,
	repo: string,
	band: 'small' | 'standard' = 'small',
) {
	const root = join(directory, 'hp-root')
	const thread = join(directory, 'thread')
	await mkdir(thread, { recursive: true, mode: 0o700 })
	async function run(args: string[]) {
		const child = Bun.spawn([binary, '--root', root, ...args], { stdout: 'pipe', stderr: 'pipe' })
		const [stdout, stderr, status] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		])
		if (status) throw new Error('Fixture CLI failed: ' + stderr)
		return stdout
	}
	await run(['new', 'demo'])
	await run(['set', 'demo', 'factory', 'true'])
	// Bootstrap only a non-running thread. HP's own fixture pattern avoids launching an executor.
	await writeFile(
		join(root, 'demo/threads/t-0001.toml'),
		`id = "t-0001"\nstatus = "open"\nkind = "tab"\nwork = "build"\nsize = "full"\nthread_dir = ${JSON.stringify(thread)}\n`,
	)
	const report = join(thread, 'report.md')
	await writeFile(
		report,
		`Gate: ${band === 'standard' ? 'design' : 'live-test'} — Review this exact output\n\n## Report\nA disposable HumanLayer round-trip test.\n`,
	)
	const git = Bun.spawn(['git', '-C', repo, 'rev-parse', 'HEAD'], { stdout: 'pipe' })
	const base = (await new Response(git.stdout).text()).trim()
	if (await git.exited) throw new Error('Fixture repository has no head')
	const ready = join(directory, 'ready.json')
	await writeFile(
		ready,
		JSON.stringify({
			band,
			door: 'two-way',
			request: { original: 'Test the HumanLayer HP gate round trip' },
			outcome: { before_after: 'A current HP receipt is the only approval state' },
			repos: [{ repo, merge_target: 'HEAD', base_sha: base }],
			acceptance: [
				{
					id: 'A1',
					type: 'behaviour',
					scenario: 'Approval returns through HP',
					oracle: { kind: 'command', run: 'bun test local-factory' },
					environment: 'local',
					stage: 'pre_merge',
				},
			],
			current_state: { checked_at: new Date().toISOString() },
			authority: { delivery_boundary: 'verified' },
			dependencies: {},
			resources: {},
		}),
	)
	await run(['unit', 'create', 'demo', 't-0001', '--ready', ready])
	return { root, report, ready, run }
}
