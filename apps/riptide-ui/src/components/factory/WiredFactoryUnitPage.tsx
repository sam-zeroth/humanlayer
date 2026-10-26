import { currentHpApproval, HpGateResponseSchema } from '@humanlayer/db/factory-gate'
import {
	factoryGateLabels,
	factoryPacket,
	FactoryRequestSchema,
	FactorySnapshotSchema,
	gateHistory,
	gateRecordLabel,
	gateUnsupported,
	reportGate,
	type PacketCriterion,
} from '@humanlayer/db/factory-unit'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@workos-inc/authkit-react'
import { useState, useSyncExternalStore } from 'react'
import { uuidv7 } from 'uuidv7'
import z from 'zod/v4'

const UnitView = z.object({
	projection: z.object({
		unit: z.string(),
		artifact_version_id: z.uuid(),
		snapshot: FactorySnapshotSchema,
		synced_at: z.number(),
	}),
	requests: z.array(
		z.object({
			id: z.uuid(),
			payload: FactoryRequestSchema,
			created_at: z.number(),
			hp_response: HpGateResponseSchema.nullable().optional(),
			hp_checked_at: z.number().nullable().optional(),
			delivery_error: z.string().nullable().optional(),
		}),
	),
	decisionCapability: z.enum(['unavailable', 'available']),
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

// Clock expiry must rerender even when React Query structurally shares unchanged data or a fetch hangs.
const readClock = () => Math.ceil(Date.now() / 1000) * 1000
function subscribeClock(notify: () => void) {
	const timer = window.setInterval(notify, 1000)
	document.addEventListener('visibilitychange', notify)
	return () => {
		window.clearInterval(timer)
		document.removeEventListener('visibilitychange', notify)
	}
}

/** One HP snapshot and a request-only form. It cannot manufacture an approved state. */
export function WiredFactoryUnitPage({ taskId }: { taskId: string }) {
	const now = useSyncExternalStore(subscribeClock, readClock, readClock)
	const { getAccessToken } = useAuth()
	const queryClient = useQueryClient()
	const [words, setWords] = useState('')
	const [requestId, setRequestId] = useState(() => uuidv7())
	const [draftProjection, setDraftProjection] = useState<z.infer<typeof UnitView>['projection'] | null>(null)
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
			const context = projection.snapshot.gateContext
			if (!context || !FactoryRequestSchema.shape.gate.safeParse(context.gate).success)
				throw new Error('Could not request approval. Review the current document and retry.')
			const input = {
				id: requestId,
				gate: context.gate,
				reportHash: context.binding.report_hash,
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
			<main className="minimalist-shared p-8">
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
	const context = projection.snapshot.gateContext
	const applicable =
		!!context &&
		FactoryRequestSchema.shape.gate.safeParse(context.gate).success &&
		query.data.decisionCapability === 'available'
	const unsupportedGate = gateUnsupported(projection.snapshot) ? reportGate(context?.report ?? '') : null
	const packet = factoryPacket(ready)
	const pr = typeof completion.pr === 'string' && completion.pr ? completion.pr : null
	const history = gateHistory(projection.snapshot)
	const stale = query.isError || now - projection.synced_at > 15_000
	return (
		<main className="minimalist-shared mx-auto w-full max-w-4xl overflow-auto p-6 md:p-10">
			<a className="underline" href={'/tasks/' + taskId}>
				Open task documents
			</a>
			<h1 className="mt-5 text-2xl font-semibold">{projection.unit}</h1>
			<p className="text-sm">
				Ready revision {ready.revision} ·{' '}
				{completion.phase === 'closed' ? 'Closed' : completion.phase === 'landed' ? 'Landed' : 'Active'}
			</p>
			{stale ? (
				<p role="status" className="my-4">
					Could not refresh the unit. Check the local stack before requesting approval.
				</p>
			) : null}
			<FactoryPacketSections packet={packet} />
			<h2 className="mt-8 text-lg font-medium">Pull request</h2>
			{pr ? (
				<p className="my-2">
					<a className="underline" href={pr} target="_blank" rel="noreferrer">
						{pr}
					</a>
					{typeof completion.pr_head === 'string' && completion.pr_head
						? ' at ' + completion.pr_head.slice(0, 10)
						: null}
				</p>
			) : (
				<p className="my-2">No pull request recorded</p>
			)}
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
			<section className="my-8">
				<h2 className="text-lg font-medium">Review document</h2>
				{context ? (
					<pre className="mt-3 whitespace-pre-wrap break-words rounded border p-4 text-sm">
						{context.report}
					</pre>
				) : (
					<p role="status">
						Could not load the review document. Wait for it to sync before requesting approval.
					</p>
				)}
			</section>
			<form
				className="my-8 grid gap-3"
				onSubmit={(event) => {
					event.preventDefault()
					request.mutate()
				}}
			>
				<h2 className="text-lg font-medium">Request approval</h2>
				<p>
					Decision:{' '}
					{context?.gate
						? (Object.entries(factoryGateLabels).find(([name]) => name === context.gate)?.[1] ??
							'Unavailable')
						: 'Unavailable'}
				</p>
				{unsupportedGate ? (
					<p role="status">
						The report asks for{' '}
						{Object.entries(factoryGateLabels).find(([name]) => name === unsupportedGate)?.[1] ??
							unsupportedGate}{' '}
						approval, which this HP does not support yet. Update HP, then reopen the unit.
					</p>
				) : null}
				{query.data.decisionCapability === 'unavailable' && context ? (
					<p role="status">Requests are off: this stack reads HP without writing to it.</p>
				) : null}
				<label htmlFor="factory-words">Your instructions</label>
				<textarea
					id="factory-words"
					disabled={request.isPending}
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
					disabled={!applicable || changed || stale || request.isPending || !words.trim()}
				>
					{request.isPending ? 'Saving request…' : 'Request approval'}
				</button>
				{request.isError ? (
					<p role="alert">Could not request approval. Review the latest unit and try again.</p>
				) : null}
			</form>
			<h2 className="text-lg font-medium">Gate history</h2>
			{history.length ? (
				history.map((record) => (
					<article key={record.sequence + record.request.gate} className="my-4 border-t py-4">
						<p className="text-sm font-medium">
							{Object.entries(factoryGateLabels).find(([name]) => name === record.request.gate)?.[1] ??
								record.request.gate}
							{' · '}
							{gateRecordLabel(record, projection.snapshot)}
						</p>
						<p className="mt-1">{record.request.words}</p>
						<p className="mt-1 text-xs">
							Ready revision {record.binding.ready_revision}
							{record.receipt ? ' · ' + record.receipt.when : null}
						</p>
					</article>
				))
			) : (
				<p className="my-4">No gate records</p>
			)}
			<h2 className="text-lg font-medium">Requests</h2>
			{requests.length ? (
				requests.map((entry) => (
					<article key={entry.id} className="my-4 border-t py-4">
						<p>{entry.payload.words}</p>
						<p className="mt-2 text-sm" role="status">
							{decisionLabel(entry, context, stale, now)} · Ready revision {entry.payload.readyRevision}
						</p>
						{entry.hp_response?.record.receipt ? (
							<p className="mt-1 text-xs">
								Receipt {entry.hp_response.record.receipt.id} ·{' '}
								{entry.hp_response.record.receipt.method === 'touch_id'
									? 'Touch ID'
									: 'Authored confirmation'}
							</p>
						) : null}
					</article>
				))
			) : (
				<p className="my-4">No approval requests</p>
			)}
		</main>
	)
}

function decisionLabel(
	entry: z.infer<typeof UnitView>['requests'][number],
	context: z.infer<typeof FactorySnapshotSchema>['gateContext'],
	stale: boolean,
	now: number,
) {
	if (entry.delivery_error || stale) return 'Could not confirm the decision. Check the local stack.'
	const response = entry.hp_response
	if (!response) return 'Waiting for confirmation'
	if (!entry.hp_checked_at || now - entry.hp_checked_at >= 15_000)
		return 'Could not confirm the decision. Check the local stack.'
	if (currentHpApproval(response, context, entry.hp_checked_at, now)) return 'Approval recorded'
	// Same Ready, newer report: the approval happened and was used, it just no longer binds the current report.
	const earlierReport =
		!!context &&
		response.expected.ready_revision === context.binding.ready_revision &&
		response.expected.ready_digest === context.binding.ready_digest &&
		response.expected.report_hash !== context.binding.report_hash
	const labels = {
		requested: 'Waiting for confirmation',
		awaiting_human_presence: 'Confirm on this Mac',
		accepted: earlierReport ? 'Approved (earlier report)' : 'Superseded — review the current document',
		stale: 'Superseded — review the current document',
		denied: 'Confirmation cancelled or denied',
		failed: 'Confirmation failed — review and submit a new request',
	}
	return labels[response.record.state]
}

function ItemList({ items, empty }: { items: string[]; empty: string }) {
	return items.length ? (
		<ul className="my-2 list-disc pl-6">
			{items.map((item, index) => (
				<li key={index}>{item}</li>
			))}
		</ul>
	) : (
		<p className="my-2">{empty}</p>
	)
}

function CriterionView({ row }: { row: PacketCriterion }) {
	return (
		<article className="my-4 border-t py-3">
			<p className="text-sm font-medium">{[row.id, row.type, row.stage].filter(Boolean).join(' · ')}</p>
			<p className="mt-1">{row.claim}</p>
			{row.provenBy ? (
				<p className="mt-2 text-sm">
					<span className="font-medium">Proven by:</span> {row.provenBy}
				</p>
			) : null}
			{row.mustAccept.length || row.mustReject.length ? (
				<details className="mt-2 text-sm">
					<summary className="cursor-pointer">
						Examples: {row.mustAccept.length} must accept, {row.mustReject.length} must reject
					</summary>
					{row.mustAccept.length ? <p className="mt-2 font-medium">Must accept</p> : null}
					{row.mustAccept.length ? <ItemList items={row.mustAccept} empty="" /> : null}
					{row.mustReject.length ? <p className="mt-2 font-medium">Must reject</p> : null}
					{row.mustReject.length ? <ItemList items={row.mustReject} empty="" /> : null}
				</details>
			) : null}
		</article>
	)
}

/** Packet parts 1, 3, 4 and 7 from HP's Ready. */
function FactoryPacketSections({ packet }: { packet: ReturnType<typeof factoryPacket> }) {
	return (
		<>
			<h2 className="mt-8 text-lg font-medium">Outcome</h2>
			<p className="my-2">{packet.outcome}</p>
			{packet.request ? (
				<p className="my-2 text-sm">
					<span className="font-medium">Original request:</span> {packet.request}
				</p>
			) : null}
			<h2 className="mt-8 text-lg font-medium">Definition of done</h2>
			{packet.criteria.length ? (
				packet.criteria.map((row) => <CriterionView key={row.id} row={row} />)
			) : (
				<p className="my-2">No criteria in this Ready</p>
			)}
			<h2 className="mt-8 text-lg font-medium">Exclusions and amendments</h2>
			<h3 className="mt-4 font-medium">Out of scope</h3>
			<ItemList items={packet.exclusions} empty="None" />
			<h3 className="mt-4 font-medium">Amendments</h3>
			<ItemList items={packet.amendments} empty="None" />
			<h3 className="mt-4 font-medium">Stop and return if</h3>
			<ItemList items={packet.mustReturn} empty="None" />
			<details className="mt-4">
				<summary className="cursor-pointer font-medium">Failure cases ({packet.failureCases.length})</summary>
				<ItemList items={packet.failureCases} empty="None" />
			</details>
			<h2 className="mt-8 text-lg font-medium">Your live check</h2>
			{packet.liveCheck ? (
				<CriterionView row={packet.liveCheck} />
			) : (
				<p className="my-2">No live check in this Ready</p>
			)}
		</>
	)
}
