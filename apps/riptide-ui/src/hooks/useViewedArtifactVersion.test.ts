import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { useViewedArtifactVersion, useViewedArtifactVersionPair } from './useViewedArtifactVersion'

const source = vi.hoisted(() => ({
	artifact: { current_version_id: 'v1', content: '' },
	hasContent: false,
}))
vi.mock('@/hooks/live-queries/useArtifactContent', () => ({ useArtifactContent: () => source }))
afterEach(cleanup)

test('metadata fallback never binds an empty document before full content arrives', () => {
	source.hasContent = false
	source.artifact = { current_version_id: 'v1', content: '' }
	const view = renderHook(({ content }) => useViewedArtifactVersion('a', content), { initialProps: { content: '' } })
	expect(view.result.current).toBeUndefined()
	source.hasContent = true
	source.artifact = { current_version_id: 'v1', content: 'Real content' }
	view.rerender({ content: 'Real content' })
	expect(view.result.current).toBe('v1')
})
test('a live change cannot silently rebind a draft; reopening supplies the fresh control', () => {
	source.hasContent = true
	source.artifact = { current_version_id: 'v1', content: 'First' }
	const view = renderHook(({ content }) => useViewedArtifactVersion('a', content), {
		initialProps: { content: 'First' },
	})
	expect(view.result.current).toBe('v1')
	source.artifact = { current_version_id: 'v2', content: 'Second' }
	view.rerender({ content: 'Second' })
	expect(view.result.current).toBeUndefined()
	view.unmount()
	const fresh = renderHook(() => useViewedArtifactVersion('a', 'Second'))
	expect(fresh.result.current).toBe('v2')
})
test('public review uses its explicit content/version pair without private collection data', () => {
	source.hasContent = false
	const view = renderHook(() =>
		useViewedArtifactVersionPair('public', 'Shared text', { id: 'shared-v1', content: 'Shared text' }),
	)
	expect(view.result.current).toBe('shared-v1')
})
