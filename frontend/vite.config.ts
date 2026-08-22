/// <reference types="vitest/config" />
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        // simulator.html (Task 7) is deliberately NOT a build input —
        // dev-server-only.
        embed: resolve(import.meta.dirname, 'embed.html'),
      },
    },
  },
  test: {
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      // Count every source file, not just the ones tests happen to import —
      // otherwise untested components silently inflate the percentage.
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/embed/main.tsx', 'src/simulator/main.ts', 'src/vite-env.d.ts'],
    },
  },
  server: {
    watch: {
      // fsevents-based watching has repeatedly gone stale on this machine
      // (edits on disk were not picked up until a server restart), so poll.
      usePolling: true,
    },
  },
})
