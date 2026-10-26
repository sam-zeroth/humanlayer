import { defineConfig } from 'tsup'

// Sam Factory: the local-factory window only, with no host services bundled.
export default defineConfig({
	entry: { main: 'src/local-factory/main.ts', preload: 'src/local-factory/preload.ts' },
	format: ['cjs'],
	platform: 'node',
	external: ['electron'],
	outDir: 'dist-factory',
	clean: true,
})
