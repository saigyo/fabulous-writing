import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      // fsevents-based watching has repeatedly gone stale on this machine
      // (edits on disk were not picked up until a server restart), so poll.
      usePolling: true,
    },
  },
})
