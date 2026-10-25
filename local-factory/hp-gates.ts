import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	FactoryGateContextSchema,
	HpGateResponseSchema,
	type HpGateRequest,
	type HpGateResponse,
} from '@humanlayer/db/factory-gate'
import z from 'zod/v4'

export class HpGateError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message)
	}
}
const capabilitiesSchema = z.object({
	api_version: z.literal(1),
	capability: z.literal('factory-gates-v1'),
	records_extension: z.literal('1.1'),
	touch_id_supported: z.boolean(),
})

/** Only this HP CLI owns gate mutation and the bundled biometric helper. */
export class HpGates {
	constructor(
		readonly binary: string,
		readonly root: string,
		readonly project: string,
		readonly thread: string,
		readonly signal?: AbortSignal,
	) {
		if (
			!binary.startsWith('/') ||
			!root.startsWith('/') ||
			!/^[a-z0-9][a-z0-9-]*$/.test(project) ||
			!/^t-\d+$/.test(thread)
		)
			throw new Error('Explicit HP gate binary, root and unit are required')
	}
	async command(args: string[], timeout = 10_000): Promise<unknown> {
		this.signal?.throwIfAborted()
		const child = Bun.spawn([this.binary, '--root', this.root, 'unit', 'gate', ...args, '--json'], {
			stdout: 'pipe',
			stderr: 'pipe',
		})
		const kill = () => child.kill('SIGTERM')
		this.signal?.addEventListener('abort', kill, { once: true })
		const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
		try {
			const [stdout, stderr, status] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			])
			let body: unknown
			try {
				body = JSON.parse(stdout)
			} catch {
				throw new HpGateError(
					'unavailable',
					`HP returned no valid gate JSON (${status}): ${stderr.slice(0, 200)}`,
				)
			}
			if (status) {
				const error = z
					.object({ api_version: z.literal(1), error: z.object({ code: z.string(), message: z.string() }) })
					.safeParse(body)
				throw new HpGateError(
					error.success ? error.data.error.code : 'unavailable',
					error.success ? error.data.error.message : 'HP gate operation failed',
				)
			}
			return body
		} finally {
			clearTimeout(timer)
			this.signal?.removeEventListener('abort', kill)
		}
	}
	async capabilities() {
		return capabilitiesSchema.parse(await this.command(['capabilities']))
	}
	async context() {
		const context = FactoryGateContextSchema.parse(await this.command(['context', this.project, this.thread]))
		if (
			context.unit !== this.project + '/' + this.thread ||
			createHash('sha256').update(context.report).digest('hex') !== context.binding.report_hash
		)
			throw new Error('HP report context mismatch')
		return context
	}
	async show(id: string) {
		return this.response(await this.command(['show', this.project, this.thread, id]), id)
	}
	async request(request: HpGateRequest) {
		const directory = await mkdtemp(join(tmpdir(), 'humanlayer-gate-'))
		try {
			const file = join(directory, 'request.json')
			await writeFile(file, JSON.stringify(request), { mode: 0o600 })
			return this.response(
				await this.command(['request', this.project, this.thread, '--file', file]),
				request.request_id,
			)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	}
	async attest(id: string) {
		return this.response(await this.command(['attest', this.project, this.thread, id], 100_000), id)
	}
	private response(value: unknown, id: string): HpGateResponse {
		const response = HpGateResponseSchema.parse(value)
		if (response.unit !== this.project + '/' + this.thread || response.record.request.request_id !== id)
			throw new Error('HP returned another gate request')
		if (
			response.record.fingerprint !==
			'sha256:' + createHash('sha256').update(JSON.stringify(response.record.request)).digest('hex')
		)
			throw new Error('HP request fingerprint mismatch')
		if (
			response.record.state === 'accepted' &&
			createHash('sha256').update(response.record.report).digest('hex') !== response.expected.report_hash
		)
			throw new Error('HP accepted report hash mismatch')
		return response
	}
}
