import { FactoryRequestSchema, FactorySnapshotSchema } from '@humanlayer/db/factory-unit'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@workos-inc/authkit-react'
import { useState } from 'react'
import { uuidv7 } from 'uuidv7'
import z from 'zod/v4'

const UnitView = z.object({
	projection: z.object({
		unit: z.string(),
		artifact_version_id: z.uuid(),
		snapshot: FactorySnapshotSchema,
		synced_at: z.number(),
	}),
	requests: z.array(z.object({ id: z.uuid(), payload: FactoryRequestSchema, created_at: z.number() })),
	decisionCapability: z.literal('unavailable'),
})
const obligationLabels = {
	pre_merge_verified: 'Before merge',
	merged: 'Merged',
	applied: 'Applied',
	verified: 'Verified',
	observed: 'Observed',
	evidence_retained: 'Evidence retained',
	cleaned_up: 'Cleaned up',
}
const stateLabels = {
	pending: 'Pending',
	done: 'Complete',
	failed: 'Failed',
	waived: 'Waived',
	'n/a': 'Not required',
}

/** One HP snapshot and a request-only form. It cannot manufacture an approved state. */
export function WiredFactoryUnitPage({ taskId }: { taskId: string }) {
	const { getAccessToken } = useAuth()
	const queryClient = useQueryClient()
	const [words, setWords] = useState('')
	const [requestId, setRequestId] = useState(() => uuidv7())
	const [draftProjection, setDraftProjection] = useState<z.infer<typeof UnitView>['projection'] | null>(null)
	const [gate, setGate] = useState<'design' | 'live-test' | 'apply' | 'publish'>('design')
	const key = ['local-factory-unit', taskId]
	const query = useQuery({
		queryKey: key,
		queryFn: async () => {
			const response = await fetch('/factory/units/' + taskId, {
				headers: { Authorization: 'Bearer ' + (await getAccessToken()) },
			})
			if (!response.ok) throw new Error('Could not load the unit. Check the local stack and retry.')
			return UnitView.parse(await response.json())
		},
		refetchInterval: 1000,
	})
	const request = useMutation({
		mutationFn: async () => {
			if (!query.data) throw new Error('Could not request approval. Reload the unit and try again.')
			const projection = draftProjection ?? query.data.projection
			const input = {
				id: requestId,
				gate,
				artifactVersionId: projection.artifact_version_id,
				readyRevision: projection.snapshot.ready.revision,
				readyDigest: projection.snapshot.ready.digest,
				words,
			}
			const response = await fetch('/factory/units/' + taskId + '/requests', {
				method: 'POST',
				headers: { Authorization: 'Bearer ' + (await getAccessToken()), 'Content-Type': 'application/json' },
				body: JSON.stringify(input),
			})
			if (!response.ok) throw new Error('Could not request approval. Review the latest unit and try again.')
		},
		onSuccess: async () => {
			setWords('')
			setDraftProjection(null)
			setRequestId(uuidv7())
			await queryClient.invalidateQueries({ queryKey: key })
		},
	})
	if (!query.data)
		return (
			<main className="p-8">
				<p role="status">
					{query.isError ? 'Could not load the unit. Check the local stack and retry.' : 'Loading the unit…'}
				</p>
				<button type="button" onClick={() => void query.refetch()}>
					Retry
				</button>
			</main>
		)
	const { projection, requests } = query.data
	const { ready, completion } = projection.snapshot
	const changed = draftProjection !== null && draftProjection.artifact_version_id !== projection.artifact_version_id
	const stale = query.isError || Date.now() - projection.synced_at > 15_000
	return (
		<main className="mx-auto w-full max-w-4xl overflow-auto p-6 md:p-10">
			<a className="underline" href={'/tasks/' + taskId}>
				Open task documents
			</a>
			<h1 className="mt-5 text-2xl font-semibold">{projection.unit}</h1>
			<p className="my-4">{ready.outcome.before_after}</p>
			<p className="text-sm">
				Ready revision {ready.revision} ·{' '}
				{completion.phase === 'closed' ? 'Closed' : completion.phase === 'landed' ? 'Landed' : 'Active'}
			</p>
			{stale ? (
				<p role="status" className="my-4">
					Could not refresh the unit. Check the local stack before requesting approval.
				</p>
			) : null}
			<h2 className="mt-8 text-lg font-medium">Completion</h2>
			<dl className="my-4 grid grid-cols-2 gap-3">
				{Object.entries(completion.obligations).map(([name, value]) => (
					<div key={name}>
						<dt>
							{Object.entries(obligationLabels).find(([key]) => key === name)?.[1] ??
								'Additional requirement'}
						</dt>
						<dd>{stateLabels[value.state]}</dd>
					</div>
				))}
			</dl>
			<h2 className="mt-8 text-lg font-medium">Active holds</h2>
			<p>{Object.keys(completion.holds).length ? Object.keys(completion.holds).join(', ') : 'No active holds'}</p>
			<form
				className="my-8 grid gap-3"
				onSubmit={(event) => {
					event.preventDefault()
					request.mutate()
				}}
			>
				<h2 className="text-lg font-medium">Request approval</h2>
				<label htmlFor="factory-gate">Decision</label>
				<select
					id="factory-gate"
					className="rounded border p-2"
					value={gate}
					onChange={(event) => {
						setGate(FactoryRequestSchema.shape.gate.parse(event.target.value))
						setDraftProjection((old) => old ?? projection)
						setRequestId(uuidv7())
					}}
				>
					<option value="design">Design</option>
					<option value="live-test">Live test</option>
					<option value="apply">Apply</option>
					<option value="publish">Publish</option>
				</select>
				<label htmlFor="factory-words">Your instructions</label>
				<textarea
					id="factory-words"
					className="min-h-24 rounded border p-2"
					value={words}
					maxLength={500}
					onChange={(event) => {
						setWords(event.target.value)
						setDraftProjection((old) => old ?? projection)
						setRequestId(uuidv7())
					}}
				/>
				<p className="text-sm">Ready revision {(draftProjection ?? projection).snapshot.ready.revision}</p>
				{changed ? (
					<p role="status">
						The unit changed. Review the latest version before requesting approval.{' '}
						<button
							type="button"
							className="underline"
							onClick={() => {
								setDraftProjection(projection)
								setRequestId(uuidv7())
							}}
						>
							Review latest version
						</button>
					</p>
				) : null}
				<p className="text-sm">
					Your request is saved for confirmation. Approval stays pending until it is recorded on this Mac.
				</p>
				<button
					className="w-fit rounded border px-4 py-2"
					type="submit"
					disabled={changed || stale || request.isPending || !words.trim()}
				>
					{request.isPending ? 'Saving request…' : 'Request approval'}
				</button>
				{request.isError ? (
					<p role="alert">Could not request approval. Review the latest unit and try again.</p>
				) : null}
			</form>
			<h2 className="text-lg font-medium">Requests</h2>
			{requests.length ? (
				requests.map((entry) => (
					<article key={entry.id} className="my-4 border-t py-4">
						<p>{entry.payload.words}</p>
						<p className="mt-2 text-sm" role="status">
							Waiting for confirmation · Ready revision {entry.payload.readyRevision}
						</p>
					</article>
				))
			) : (
				<p className="my-4">No approval requests</p>
			)}
		</main>
	)
}
