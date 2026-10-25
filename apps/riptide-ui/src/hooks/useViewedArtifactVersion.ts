import { useEffect, useState } from 'react'

import { useArtifactContent } from '@/hooks/live-queries/useArtifactContent'

/** Freeze the viewed pair. A changed document blocks an existing draft instead of rebinding it. */
export function useViewedArtifactVersion(
	artifactId: string | null,
	content: string | null | undefined,
	explicit?: { id: string; content: string },
) {
	const { artifact, hasContent } = useArtifactContent(artifactId)
	return useViewedArtifactVersionPair(
		artifactId,
		content,
		explicit ??
			(hasContent && artifact?.current_version_id
				? { id: artifact.current_version_id, content: artifact.content }
				: undefined),
	)
}

/** Public and authenticated viewers share binding logic without requiring a private sync provider. */
export function useViewedArtifactVersionPair(
	artifactId: string | null,
	content: string | null | undefined,
	pair?: { id: string; content: string },
) {
	const id = pair?.id
	const bytes = pair?.content
	const [viewed, setViewed] = useState<{ artifactId: string; id: string; content: string } | null>(null)
	useEffect(() => {
		if (artifactId && id && bytes != null && bytes === content)
			setViewed((previous) =>
				previous?.artifactId === artifactId ? previous : { artifactId, id, content: bytes },
			)
	}, [artifactId, id, bytes, content])
	return viewed?.artifactId === artifactId && viewed.content === content ? viewed.id : undefined
}
