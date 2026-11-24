/**
 * Browser tests: the real app and drawing server in Chrome. They need a place's photo and its 3D
 * data in client/public/ (neither is in git), so they run locally, not in CI: npm run test:browser
 */
import { defineConfig } from '@playwright/test';

const APP = 5399, RELAY = 8799;

export default defineConfig({
  testDir: 'tests/browser',
  timeout: 90_000,
  workers: 1, // they share one drawing server and the GPU
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${APP}`,
    channel: 'chrome',
    colorScheme: 'dark',
    viewport: { width: 1280, height: 800 },
    launchOptions: { args: ['--enable-gpu', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])] },
  },
  webServer: [
    { command: 'node server/realtime.ts', port: RELAY, env: { PORT: String(RELAY), ALLOWED_ORIGINS: `http://127.0.0.1:${APP}`, FLATTEN_AFTER_MS: '600000', MODERATION: 'off', NODE_NO_WARNINGS: '1' } },
    { command: `npx vite --host 127.0.0.1 --port ${APP} --strictPort`, port: APP, env: { RELAY_PORT: String(RELAY) } },
  ],
});
