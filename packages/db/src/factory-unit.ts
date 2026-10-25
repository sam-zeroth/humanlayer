import z from 'zod/v4'

import { FactoryGateContextSchema } from './factory-gate'

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const FactorySnapshotSchema = z
	.object({
		ready: z.looseObject({
			id: z.string().regex(/^[^/]+\/t-\d+$/),
			revision: z.number().int().positive(),
			digest: Digest,
			outcome: z.looseObject({ before_after: z.string() }),
		}),
		gateContext: FactoryGateContextSchema.optional(),
		completion: z.looseObject({
			unit: z.string(),
			ready_revision: z.number().int().positive(),
			ready_digest: Digest,
			phase: z.enum(['active', 'landed', 'closed']),
			verdict: z.enum(['open', 'closed', 'closed_with_waivers', 'abandoned']),
			obligations: z.record(
				z.string(),
				z.looseObject({ state: z.enum(['pending', 'done', 'failed', 'waived', 'n/a']) }),
			),
			holds: z.record(z.string(), z.unknown()),
		}),
	})
	.refine(
		(s) =>
			s.ready.id === s.completion.unit &&
			s.ready.revision === s.completion.ready_revision &&
			s.ready.digest === s.completion.ready_digest &&
			(!s.gateContext ||
				(s.gateContext.unit === s.ready.id &&
					s.gateContext.binding.ready_revision === s.ready.revision &&
					s.gateContext.binding.ready_digest === s.ready.digest)),
		{ message: 'Inconsistent HP snapshot' },
	)
export type FactorySnapshot = z.infer<typeof FactorySnapshotSchema>
export const FactoryRequestSchema = z
	.object({
		id: z.uuid(),
		gate: z.enum(['design', 'live-test', 'apply', 'publish']),
		artifactVersionId: z.uuid(),
		readyRevision: z.number().int().positive(),
		readyDigest: Digest,
		reportHash: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
		words: z
			.string()
			.min(1)
			.max(500)
			.refine((value) => value.trim().length > 0),
	})
	.strict()
export type FactoryRequest = z.infer<typeof FactoryRequestSchema>

function sorted(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sorted)
	if (value !== null && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, child]) => [key, sorted(child)]),
		)
	return value
}
export const canonicalFactorySnapshot = (snapshot: FactorySnapshot) => JSON.stringify(sorted(snapshot))
export const renderFactoryUnit = (snapshot: FactorySnapshot) =>
	`# ${snapshot.ready.id}\n\n${snapshot.ready.outcome.before_after}\n\nReady revision: ${snapshot.ready.revision}\n\nHP is authoritative. Browser decisions are requests until HP records them.\n\n\`\`\`json\n${canonicalFactorySnapshot(snapshot)}\n\`\`\`\n`
