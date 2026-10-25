import z from 'zod/v4'

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const reportHash = z.string().regex(/^[a-f0-9]{64}$/)
export const FactoryGateBindingSchema = z.object({
	ready_revision: z.number().int().positive(),
	ready_digest: digest,
	report_hash: reportHash,
})
export const FactoryGateContextSchema = z.object({
	api_version: z.literal(1),
	unit: z.string(),
	binding: FactoryGateBindingSchema,
	gate: z.string().nullable(),
	report: z.string().max(1_048_576),
})
export const HpGateRequestSchema = z.object({
	api_version: z.literal(1),
	request_id: z.string(),
	gate: z.string(),
	expected_ready_revision: z.number().int().positive(),
	expected_ready_digest: digest,
	expected_report_hash: reportHash,
	artifact: z.object({ system: z.literal('humanlayer'), id: z.string(), version: z.string() }),
	requester: z.object({
		system: z.literal('humanlayer'),
		subject: z.string(),
		authorship: z.literal('authenticated-user'),
	}),
	words: z.string(),
})
const observedBinding = FactoryGateBindingSchema.extend({ report_hash: z.union([reportHash, z.literal('')]) })
export const HpGateResponseSchema = z
	.object({
		api_version: z.literal(1),
		unit: z.string(),
		record: z.object({
			request: HpGateRequestSchema,
			fingerprint: digest,
			report: z.string(),
			state: z.enum(['requested', 'awaiting_human_presence', 'accepted', 'stale', 'denied', 'failed']),
			attempt: z.string().nullable(),
			binding: observedBinding,
			reason: z.string(),
			receipt: z
				.object({
					id: z.string().min(1),
					attempt: z.string(),
					method: z.enum(['touch_id', 'authorship_only']),
					when: z.string(),
					binding: FactoryGateBindingSchema,
					packet_digest: z.string().nullable(),
				})
				.nullable(),
			sequence: z.number().int().nonnegative(),
		}),
		expected: FactoryGateBindingSchema,
		current_binding: observedBinding.nullable(),
		current: z.boolean(),
		attestation_required: z.boolean(),
	})
	.superRefine((r, c) => {
		const expected = {
			ready_revision: r.record.request.expected_ready_revision,
			ready_digest: r.record.request.expected_ready_digest,
			report_hash: r.record.request.expected_report_hash,
		}
		const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
		if (!same(expected, r.expected)) c.addIssue({ code: 'custom', message: 'HP expected binding mismatch' })
		if (r.record.state === 'accepted') {
			const receipt = r.record.receipt
			if (
				!receipt ||
				!same(receipt.binding, expected) ||
				!same(r.record.binding, expected) ||
				receipt.attempt !== r.record.attempt ||
				(r.current && receipt.method !== (r.attestation_required ? 'touch_id' : 'authorship_only'))
			)
				c.addIssue({ code: 'custom', message: 'HP acceptance requires a bound receipt' })
		} else if (r.record.receipt || r.current)
			c.addIssue({ code: 'custom', message: 'Non-accepted HP result cannot grant approval' })
		if (r.current && !same(r.current_binding, expected))
			c.addIssue({ code: 'custom', message: 'Current HP receipt must match current binding' })
	})
export type HpGateRequest = z.infer<typeof HpGateRequestSchema>
export type HpGateResponse = z.infer<typeof HpGateResponseSchema>
export type FactoryGateContext = z.infer<typeof FactoryGateContextSchema>

export function hpRequest(
	input: {
		id: string
		gate: string
		readyRevision: number
		readyDigest: string
		reportHash?: string
		artifactVersionId: string
		words: string
	},
	artifactId: string,
	subject: string,
): HpGateRequest {
	return HpGateRequestSchema.parse({
		api_version: 1,
		request_id: 'hl:' + input.id,
		gate: input.gate,
		expected_ready_revision: input.readyRevision,
		expected_ready_digest: input.readyDigest,
		expected_report_hash: input.reportHash,
		artifact: { system: 'humanlayer', id: artifactId, version: input.artifactVersionId },
		requester: { system: 'humanlayer', subject, authorship: 'authenticated-user' },
		words: input.words,
	})
}

/** A cached HP acceptance is only usable while its fresh binding still matches the displayed HP report. */
export function currentHpApproval(
	response: HpGateResponse | null | undefined,
	context: FactoryGateContext | undefined,
	checkedAt: number | null | undefined,
	now = Date.now(),
) {
	return !!(
		response &&
		response.record.state === 'accepted' &&
		response.current &&
		checkedAt &&
		now - checkedAt < 15_000 &&
		context &&
		response.unit === context.unit &&
		JSON.stringify(response.expected) === JSON.stringify(context.binding)
	)
}
