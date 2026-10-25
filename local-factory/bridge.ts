import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
	canonicalFactorySnapshot,
	FactorySnapshotSchema,
	renderFactoryUnit,
	type FactorySnapshot,
} from '@humanlayer/db/factory-unit'
import { uuidv7 } from 'uuidv7'

import { localAuthConfig, LOCAL_ORG_ID, LOCAL_USER_ID, loopbackOrigin } from './config'

export interface Surface {
	ensureTask(taskId: string, unit: string): Promise<void>
	upsert(taskId: string, artifactId: string, name: string, content: string): Promise<string>
	publish(
		taskId: string,
		artifactId: string,
		versionId: string,
		snapshot: FactorySnapshot,
		hash: string,
		generation: number,
	): Promise<void>
}
interface Delivery {
	task_id: string
	artifact_id: string
	last_hash: string | null
	revision: number
	pending_hash: string | null
	generation: number
}

/** Delivery state only. Loss/corruption is a stop, never implicit creation of a second mapping. */
export class BridgeJournal {
	private readonly db: Database
	constructor(path: string) {
		if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Symlinked bridge journal refused')
		this.db = new Database(path, { create: true })
		this.db.exec(
			'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS delivery (unit TEXT PRIMARY KEY, task_id TEXT NOT NULL, artifact_id TEXT NOT NULL, last_hash TEXT, revision INTEGER NOT NULL DEFAULT 0, pending_hash TEXT, generation INTEGER NOT NULL DEFAULT 0)',
		)
		chmodSync(path, 0o600)
	}
	mapping(unit: string): Delivery {
		return this.db.transaction(() => {
			const existing = this.db
				.query<Delivery, [string]>(
					'SELECT task_id, artifact_id, last_hash, revision, pending_hash, generation FROM delivery WHERE unit=?',
				)
				.get(unit)
			if (existing) return existing
			const mapping = {
				task_id: uuidv7(),
				artifact_id: uuidv7(),
				last_hash: null,
				revision: 0,
				pending_hash: null,
				generation: 0,
			}
			this.db
				.query('INSERT INTO delivery (unit, task_id, artifact_id) VALUES (?, ?, ?)')
				.run(unit, mapping.task_id, mapping.artifact_id)
			return mapping
		})()
	}
	stage(unit: string, hash: string) {
		this.db
			.query(
				'UPDATE delivery SET generation=generation+1, pending_hash=? WHERE unit=? AND (pending_hash IS NULL OR pending_hash != ?)',
			)
			.run(hash, unit, hash)
		return this.mapping(unit).generation
	}
	confirm(unit: string, snapshot: FactorySnapshot, hash: string) {
		this.db
			.query('UPDATE delivery SET last_hash=?, revision=? WHERE unit=?')
			.run(hash, snapshot.ready.revision, unit)
	}
	close() {
		this.db.close()
	}
}

export async function projectUnit(journal: BridgeJournal, surface: Surface, raw: unknown, force = false) {
	const snapshot = FactorySnapshotSchema.parse(raw)
	const mapping = journal.mapping(snapshot.ready.id)
	if (mapping.revision > snapshot.ready.revision) throw new Error('HP revision regressed; check the configured root')
	const hash = createHash('sha256').update(canonicalFactorySnapshot(snapshot)).digest('hex')
	if (!force && mapping.last_hash === hash) return mapping.task_id
	const generation = journal.stage(snapshot.ready.id, hash)
	await surface.ensureTask(mapping.task_id, snapshot.ready.id)
	// One self-contained summary is the authoritative UI pair. Partial auxiliary updates cannot mix state.
	const version = await surface.upsert(mapping.task_id, mapping.artifact_id, 'unit.md', renderFactoryUnit(snapshot))
	await surface.publish(mapping.task_id, mapping.artifact_id, version, snapshot, hash, generation)
	journal.confirm(snapshot.ready.id, snapshot, hash)
	return mapping.task_id
}

export async function readHpUnit(binary: string, root: string, project: string, thread: string, timeoutMs = 10_000) {
	if (
		!binary.startsWith('/') ||
		!root.startsWith('/') ||
		!/^[a-z0-9][a-z0-9-]*$/.test(project) ||
		!/^t-\d+$/.test(thread)
	)
		throw new Error('Explicit HP binary, root and unit identity are required')
	const child = Bun.spawn([binary, '--root', root, 'unit', 'show', project, thread, '--json'], {
		stdout: 'pipe',
		stderr: 'pipe',
	})
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		child.kill('SIGKILL')
	}, timeoutMs)
	let stdout: string
	try {
		const [output, stderr, status] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		])
		if (timedOut) throw new Error('HP unit show timed out')
		if (status) throw new Error(`HP unit show failed (${status}): ${stderr.slice(0, 500)}`)
		stdout = output
	} finally {
		clearTimeout(timer)
	}
	const snapshot = FactorySnapshotSchema.parse(JSON.parse(stdout))
	if (snapshot.ready.id !== project + '/' + thread) throw new Error('HP returned another unit')
	return snapshot
}

export function localSurface(origin: string, token: () => Promise<string>, bridgeSecret: string): Surface {
	loopbackOrigin(origin)
	async function post(path: string, input: unknown, method = 'POST'): Promise<unknown> {
		const response = await fetch(origin + path, {
			method,
			headers: {
				Authorization: 'Bearer ' + (await token()),
				'Content-Type': 'application/json',
				'x-factory-bridge': bridgeSecret,
			},
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(15_000),
		})
		if (!response.ok) throw new Error(`Surface request failed (${response.status}) at ${path}`)
		return response.json()
	}
	return {
		async ensureTask(taskId, unit) {
			const result = await post('/rpc/api/v1/tasks/create', {
				id: taskId,
				name: unit,
				workflowType: 'oneshot',
				worktreeTiming: 'never',
				autoAdvanceQuestionsToResearch: false,
				autoAdvanceResearchToDesign: false,
				autoAdvancePlanToWorktree: false,
				autoAdvanceWorktreeToImplementation: false,
				autoAdvanceImplementationToPr: false,
			})
			if (
				!result ||
				typeof result !== 'object' ||
				!('task' in result) ||
				!result.task ||
				typeof result.task !== 'object' ||
				!('id' in result.task) ||
				result.task.id !== taskId ||
				!('organization_id' in result.task) ||
				result.task.organization_id !== LOCAL_ORG_ID ||
				!('resource_owner_user_id' in result.task) ||
				result.task.resource_owner_user_id !== LOCAL_USER_ID ||
				!('workflow_type' in result.task) ||
				result.task.workflow_type !== 'oneshot' ||
				!('worktree_timing' in result.task) ||
				result.task.worktree_timing !== 'never' ||
				[
					'auto_advance_questions_to_research',
					'auto_advance_research_to_design',
					'auto_advance_plan_to_worktree',
					'auto_advance_worktree_to_implementation',
					'auto_advance_implementation_to_pr',
				].some((key) => Reflect.get(result.task as object, key) !== false)
			)
				throw new Error('Surface task identity mismatch')
		},
		async upsert(taskId, artifactId, fileName, content) {
			const result = await post('/rpc/api/v1/artifacts/upsert', { id: artifactId, taskId, fileName, content })
			if (!result || typeof result !== 'object' || !('artifactId' in result) || result.artifactId !== artifactId)
				throw new Error('Surface artifact identity mismatch')
			const versions = await post('/rpc/api/v1/artifacts/versions/list', { artifactId })
			if (
				!versions ||
				typeof versions !== 'object' ||
				!('latest' in versions) ||
				!versions.latest ||
				typeof versions.latest !== 'object' ||
				!('currentVersionId' in versions.latest) ||
				typeof versions.latest.currentVersionId !== 'string'
			)
				throw new Error('Surface current version missing')
			return versions.latest.currentVersionId
		},
		async publish(taskId, artifactId, artifactVersionId, snapshot, snapshotHash, sourceGeneration) {
			await post(
				'/factory/units/' + taskId,
				{ artifactId, artifactVersionId, snapshot, snapshotHash, sourceGeneration },
				'PUT',
			)
		},
	}
}

async function claim(directory: string) {
	const lock = join(directory, 'bridge.lock')
	try {
		await mkdir(lock)
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
		const pid = Number(await readFile(join(lock, 'pid'), 'utf8'))
		if (!Number.isInteger(pid) || pid <= 0) throw new Error('Bridge lock is corrupt')
		try {
			process.kill(pid, 0)
			throw new Error('Another bridge worker holds this state')
		} catch (cause) {
			if (!(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')) throw cause
		}
		await rm(lock, { recursive: true })
		await mkdir(lock)
	}
	await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 })
	return () => rm(lock, { recursive: true })
}

if (import.meta.main) {
	const config = localAuthConfig()
	const directory = resolve(process.env.LOCAL_FACTORY_STATE ?? '.local-factory')
	await mkdir(directory, { recursive: true, mode: 0o700 })
	const release = await claim(directory)
	const path = join(directory, 'bridge.sqlite')
	if ((await Bun.file(join(directory, 'bridge.initialized')).exists()) && !(await Bun.file(path).exists()))
		throw new Error('Bridge journal is missing; restore its backup before restarting')
	const journal = new BridgeJournal(path)
	await writeFile(join(directory, 'bridge.initialized'), '1', { mode: 0o600 })
	const bootstrap = await readFile(join(directory, 'bootstrap-secret'), 'utf8')
	const bridgeSecret = await readFile(join(directory, 'bridge-secret'), 'utf8')
	const token = async () => {
		const response = await fetch(config.issuer + '/token', {
			method: 'POST',
			headers: { origin: config.browserOrigin, 'x-local-bootstrap': bootstrap },
		})
		if (!response.ok) throw new Error('Local identity unavailable')
		const body: unknown = await response.json()
		if (!body || typeof body !== 'object' || !('token' in body) || typeof body.token !== 'string')
			throw new Error('Invalid local token response')
		return body.token
	}
	const surface = localSurface(process.env.LOCAL_API_ORIGIN ?? 'http://127.0.0.1:55800', token, bridgeSecret)
	let stopped = false
	process.on('SIGINT', () => {
		stopped = true
	})
	process.on('SIGTERM', () => {
		stopped = true
	})
	try {
		let lastReconcile = 0
		while (!stopped) {
			try {
				const snapshot = await readHpUnit(
					process.env.LOCAL_HP_BINARY ?? '',
					process.env.LOCAL_HP_ROOT ?? '',
					process.env.LOCAL_HP_PROJECT ?? '',
					process.env.LOCAL_HP_THREAD ?? '',
				)
				const force = Date.now() - lastReconcile > 5000
				await projectUnit(journal, surface, snapshot, force)
				if (force) lastReconcile = Date.now()
			} catch (error) {
				console.error(error instanceof Error ? error.message : 'Bridge synchronization failed')
				await Bun.sleep(2000)
			}
			await Bun.sleep(250)
		}
	} finally {
		journal.close()
		await release()
	}
}
