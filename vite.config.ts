import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    // live drawing server (npm run server); production gets the same path via Caddy
    proxy: { '/ws': { target: 'ws://127.0.0.1:8787', ws: true } },
  },
})
