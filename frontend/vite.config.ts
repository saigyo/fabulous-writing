/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      // Count every source file, not just the ones tests happen to import —
      // otherwise untested components silently inflate the percentage.
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/vite-env.d.ts'],
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
