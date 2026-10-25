import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'

import { ArtifactCommentThread } from './ArtifactCommentThread'

const props = { authorName: 'Reviewer', authorAvatarUrl: null, createdAt: 0n, contentText: 'Agree', kind: 'approval' as const, active: false, outdated: false, onActivate: () => {}, onHoverChange: () => {} }

test('old and optimistic verdicts expose their unverified viewed binding', () => {
	for (const viewedVersionVerified of [undefined, false]) {
		const markup = renderToStaticMarkup(createElement(ArtifactCommentThread, { ...props, viewedVersionVerified }))
		expect(markup).toContain('Viewed version unverified')
	}
})
test('confirmed caller binding clears only the viewed-version uncertainty label', () => {
	const markup = renderToStaticMarkup(createElement(ArtifactCommentThread, { ...props, viewedVersionVerified: true }))
	expect(markup).not.toContain('Viewed version unverified')
	expect(markup).toContain('Approve verdict')
})
