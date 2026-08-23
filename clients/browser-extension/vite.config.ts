/// <reference types="vitest/config" />
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

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
  test: { environment: 'happy-dom', setupFiles: ['./vitest.setup.ts'] },
})
