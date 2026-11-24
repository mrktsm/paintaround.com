import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { changed, drag, look, needsPlace, pick, visit } from './helpers';

needsPlace();

// a drawing server of its own that flattens strokes into the paint layer after a few seconds
const PORT = 8798;
let server: ChildProcess;
test.beforeAll(async ({ baseURL }) => {
  server = spawn('node', ['server/realtime.ts'], {
    stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), ALLOWED_ORIGINS: baseURL!, FLATTEN_AFTER_MS: '8000', MODERATION: 'off', NODE_NO_WARNINGS: '1' },
  });
  await expect.poll(() => fetch(`http://127.0.0.1:${PORT}/`).then(() => true, () => false)).toBe(true);
});
test.afterAll(() => { server.kill(); });

test('old strokes become part of the paint layer: they look the same and can no longer be undone', async ({ browser }) => {
  const a = await visit(browser, { relay: PORT }), b = await visit(browser, { relay: PORT }), all = [a, b];
  const tiles: string[] = [];
  a.on('response', r => { if (r.url().includes('/api/layer/') && r.ok()) tiles.push(r.url()); });
  const empty = await look(b, all);
  await pick(a, 'marker');
  await drag(a, [520, 620], [880, 620]);
  const mine = await look(a, all), seen = await look(b, all), size = await changed(empty, seen);
  expect(size).toBeGreaterThan(400);
  await expect(a.locator('[aria-label="Undo"]')).toBeEnabled();

  await expect(a.locator('[aria-label="Undo"]')).toBeDisabled({ timeout: 25_000 });
  await a.waitForTimeout(1000);
  expect(tiles.length).toBeGreaterThan(0);
  expect(await changed(mine, await look(a, all))).toBeLessThan(size * 0.3);
  expect(await changed(seen, await look(b, all))).toBeLessThan(size * 0.3);

  // someone arriving now gets it too, and drawing over it and undoing that leaves it alone
  const late = await visit(browser, { relay: PORT });
  all.push(late);
  const flat = await look(late, all);
  expect(await changed(seen, flat)).toBeLessThan(size * 0.3);
  await pick(late, 'marker');
  await drag(late, [520, 660], [880, 660]);
  await late.click('[aria-label="Undo"]');
  await late.waitForTimeout(900);
  expect(await changed(flat, await look(late, all))).toBeLessThan(size * 0.1);
  expect(all.flatMap(p => p.problems)).toEqual([]);
});
