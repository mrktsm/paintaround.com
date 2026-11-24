import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const RELAY_PORT = process.env.RELAY_PORT ?? 8787

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    // live drawing server (npm run server); production gets the same path via Caddy
    proxy: { '/ws': { target: `ws://127.0.0.1:${RELAY_PORT}`, ws: true }, '/api': { target: `http://127.0.0.1:${RELAY_PORT}` } },
  },
})
