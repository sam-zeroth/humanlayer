import { hpRequest, type HpGateRequest, type HpGateResponse } from '@humanlayer/db/factory-gate'
import { FactoryRequestSchema } from '@humanlayer/db/factory-unit'
import z from 'zod/v4'

import { LOCAL_USER_ID } from './config'
import { HpGateError } from './hp-gates'

export const QueuedRequestSchema = z.object({
	id: z.uuid(),
	created_by_user_id: z.string(),
	payload: FactoryRequestSchema,
	artifact_id: z.uuid(),
})
export type QueuedRequest = z.infer<typeof QueuedRequestSchema>
export interface GateAuthority {
	show(id: string): Promise<HpGateResponse>
	request(input: HpGateRequest): Promise<HpGateResponse>
	attest(id: string): Promise<HpGateResponse>
}
export interface DecisionSurface {
	requests(taskId: string): Promise<QueuedRequest[]>
	decision(taskId: string, id: string, response: HpGateResponse | null, error: string | null): Promise<void>
}

/** HP owns claim/replay and terminal outcomes. Refresh runs independently of an open Touch ID prompt. */
export class DecisionPump {
	private active: Promise<void> | null = null
	constructor(
		private hp: GateAuthority,
		private surface: DecisionSurface,
	) {}
	async refresh(taskId: string) {
		const rows = await this.surface.requests(taskId)
		for (const row of rows) {
			try {
				if (row.created_by_user_id !== LOCAL_USER_ID || row.id !== row.payload.id || !row.payload.reportHash)
					throw new Error('Request needs a newly reviewed report')
				const expected = hpRequest(row.payload, row.artifact_id, row.created_by_user_id)
				let response: HpGateResponse
				try {
					response = await this.hp.show(expected.request_id)
				} catch (error) {
					if (!(error instanceof HpGateError && error.code === 'not_found')) throw error
					response = await this.hp.request(expected)
				}
				this.validate(response, expected)
				await this.surface.decision(taskId, row.id, response, null)
				if (response.record.state === 'requested' && !this.active) {
					const work = this.attest(taskId, row.id, expected)
					this.active = work
					void work.finally(() => {
						if (this.active === work) this.active = null
					})
				}
			} catch (error) {
				await this.surface.decision(
					taskId,
					row.id,
					null,
					error instanceof Error ? error.message : 'HP unavailable',
				)
			}
		}
	}
	private validate(response: HpGateResponse, expected: HpGateRequest) {
		if (JSON.stringify(response.record.request) !== JSON.stringify(expected))
			throw new Error('HP request payload differs from saved intent')
	}
	private async attest(taskId: string, id: string, expected: HpGateRequest) {
		try {
			const response = await this.hp.attest(expected.request_id)
			this.validate(response, expected)
			await this.surface.decision(taskId, id, response, null)
		} catch (error) {
			// Lost output is reconciled by show; an operational error is never approval evidence.
			await this.surface
				.decision(taskId, id, null, error instanceof Error ? error.message : 'HP unavailable')
				.catch(() => undefined)
		}
	}
	async settle() {
		await this.active
	}
}
