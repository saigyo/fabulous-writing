import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// The content script: one classic IIFE file, no runtime imports (ruling 1 —
// dynamic import from content scripts is subject to the page's CSP).
// emptyOutDir false: this pass ADDS scout.js to the ESM pass's dist/.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/scout.ts'),
      formats: ['iife'],
      name: 'fwScout',
      fileName: () => 'scout.js',
    },
  },
})
