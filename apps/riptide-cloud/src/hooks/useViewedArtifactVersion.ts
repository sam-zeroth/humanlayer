import { eq, useLiveQuery } from '@tanstack/react-db'
import { useEffect, useState } from 'react'

import { useSync } from '@/providers/SyncProvider'

/** Pin the viewed content/version pair; a changed document requires reopening before writing. */
export function useViewedArtifactVersion(artifactId: string, content: string) {
	const { artifactsCollection } = useSync()
	const { data } = useLiveQuery(
		(q) => q.from({ artifact: artifactsCollection }).where(({ artifact }) => eq(artifact.id, artifactId)),
		[artifactsCollection, artifactId],
	)
	const artifact = data?.[0]
	const [viewed, setViewed] = useState<{ artifactId: string; id: string; content: string } | null>(null)
	useEffect(() => {
		const id = artifact?.current_version_id
		if (id && artifact?.content === content)
			setViewed((previous) => (previous?.artifactId === artifactId ? previous : { artifactId, id, content }))
	}, [artifactId, artifact, content])
	return viewed?.artifactId === artifactId && viewed.content === content ? viewed.id : undefined
}
