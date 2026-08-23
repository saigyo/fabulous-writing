import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { configDefaults } from 'vitest/config'

// ESM contexts: service worker (MV3 "type": "module"), panel and options
// pages. Stable, hash-free names — the manifest references them literally.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sw: resolve(import.meta.dirname, 'src/sw.ts'),
        panel: resolve(import.meta.dirname, 'panel.html'),
        options: resolve(import.meta.dirname, 'options.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
    // e2e/ has its own runner (e2e/run.mjs -> "npm run e2e") and is plain
    // playwright-core, not a vitest suite — its *.spec.mjs would otherwise
    // match vitest's default include glob and fail with "No test suite
    // found" (it has no describe/it, just a default-exported async fn).
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})
