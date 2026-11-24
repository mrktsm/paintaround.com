import { expect, test, type Browser, type Page } from '@playwright/test';
import { changed, drag, look, needsPlace, pick, visit, PLACE } from './helpers';

needsPlace();

/** The link you get from the share button. */
async function sharedLink(page: Page): Promise<string> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); }); // no share sheet here
  await page.click('.view-share');
  await expect(page.locator('.view-copied')).toHaveText('Link copied');
  return page.evaluate(() => navigator.clipboard.readText());
}
const whole = { x: 0, y: 0, width: 1280, height: 800 };
/** Opens a link, and pictures it just before and just after the place replaces its loading picture. */
async function opens(browser: Browser, link: string): Promise<Page & { problems: string[] }> {
  return visit(browser, { path: new URL(link).pathname + new URL(link).search });
}

test('a shared link opens looking at the same spot, with the drawings', async ({ browser }) => {
  const a = await visit(browser);
  // somewhere that isn't where the place normally opens
  await drag(a, [700, 400], [420, 300], { button: 'right' });
  for (let k = 0; k < 6; k++) { await a.mouse.wheel(0, -120); await a.waitForTimeout(40); }
  await a.waitForTimeout(800);
  await pick(a, 'marker');
  await drag(a, [560, 620], [840, 620]);
  await a.waitForTimeout(1500);
  const link = await sharedLink(a);
  expect(link).toMatch(/\/colosseum\?at=[\d.]+,[\d.]+,[\d.]+$/);
  await expect(a.locator('.view-copied')).toHaveCount(0, { timeout: 4000 });
  const mine = await look(a, [], whole);

  const b = await opens(browser, link);
  await expect(b.locator('.viewer-container.loaded')).toBeVisible({ timeout: 20_000 });
  await expect(b).toHaveURL(/\/colosseum$/); // the address stays simple
  await b.waitForTimeout(2500);
  const theirs = await look(b, [a], whole);
  expect(await changed(mine, theirs)).toBeLessThan(12_000); // of a million: undo is lit for a, not b; edges
  expect([...a.problems, ...b.problems]).toEqual([]);
});

test('its loading picture is the view it opens with, drawings included, and nothing jumps', async ({ browser }) => {
  const a = await visit(browser);
  await drag(a, [700, 400], [900, 380], { button: 'right' });
  await pick(a, 'crayon');
  await drag(a, [560, 640], [840, 640]);
  const link = await sharedLink(a);
  await a.waitForTimeout(2500);

  // hold the photo back, so the loading picture is on screen on its own
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript(() => localStorage.setItem('tutorialSeen', '1'));
  let release: () => void = () => {};
  const held = new Promise<void>(ok => { release = ok; });
  await page.route(new RegExp(`panorama-pool/${PLACE}\\.jpg`), async route => { await held; await route.continue(); });
  await page.goto(new URL(link).pathname + new URL(link).search);
  await page.waitForTimeout(3000);
  await page.addStyleTag({ content: '.loading-overlay, .view-actions, .toolbar, .undo-redo { visibility: hidden !important; }' });
  const loading = await page.screenshot();
  await page.evaluate(() => {
    const w = window as unknown as { __first: string | null };
    w.__first = null;
    new MutationObserver(() => {
      const drawings = [...document.querySelectorAll<HTMLElement>('.viewer-container > canvas')].map(c => c.style.opacity);
      if (document.querySelector('.viewer-container.loaded')) w.__first ??= drawings.join();
    }).observe(document.querySelector('.viewer-container')!, { attributes: true });
  });
  release();
  await expect(page.locator('.viewer-container.loaded')).toBeVisible({ timeout: 20_000 });
  expect(await page.evaluate(() => (window as unknown as { __first: string | null }).__first)).toMatch(/^1(,1)*$/); // drawings with it, not after
  await page.waitForTimeout(1500);
  const place = await page.screenshot();
  expect(await changed(loading, place)).toBeLessThan(60_000); // same picture (JPEG, resized): not a different view
  const elsewhere = await visit(browser);
  expect(await changed(loading, await elsewhere.screenshot())).toBeGreaterThan(200_000);
  await page.context().close();
});

test('where there is a share sheet it opens, with the link; closing it is fine', async ({ browser }) => {
  const p = await visit(browser, { alone: true });
  await p.evaluate(() => {
    const w = window as unknown as { __shared: string[]; __fail: string | null };
    w.__shared = [];
    w.__fail = null;
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (d: { url: string }) => { w.__shared.push(d.url); if (w.__fail) throw new DOMException('no', w.__fail); } });
  });
  await p.click('.view-share');
  await expect.poll(() => p.evaluate(() => (window as unknown as { __shared: string[] }).__shared[0])).toMatch(/\/colosseum\?at=/);
  await p.evaluate(() => { (window as unknown as { __fail: string }).__fail = 'AbortError'; });
  await p.click('.view-share');
  await p.waitForTimeout(400);
  await expect(p.locator('.view-copied')).toHaveCount(0);
  // a sheet that can't open: the link is copied instead
  await p.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await p.evaluate(() => { (window as unknown as { __fail: string }).__fail = 'NotAllowedError'; });
  await p.click('.view-share');
  await expect(p.locator('.view-copied')).toBeVisible();
  expect(p.problems).toEqual([]);
});

test('when its picture can\'t be made, the link still opens', async ({ browser }) => {
  const a = await visit(browser, { alone: true });
  const link = await sharedLink(a);
  const page = await (await browser.newContext()).newPage();
  await page.route('**/api/share/**', route => route.fulfill({ status: 503 }));
  await page.routeWebSocket(/\/ws$/, () => {});
  await page.goto(new URL(link).pathname + new URL(link).search);
  await expect(page.locator('.viewer-container.loaded')).toBeVisible({ timeout: 20_000 });
  await page.context().close();
});

test('a link with nonsense in it opens the place as usual', async ({ browser }) => {
  const p = await visit(browser, { alone: true, path: '/colosseum?at=what' });
  await expect(p.locator('.viewer-container.loaded')).toBeVisible({ timeout: 20_000 });
  await p.click('.view-close');
  await expect(p).toHaveURL(/\/$/);
  expect(p.problems).toEqual([]);
});

test('links from before still open their place', async ({ browser }) => {
  const p = await visit(browser, { alone: true, path: `/view?imageId=${PLACE}&lng=12.4&lat=41.8` });
  await expect(p).toHaveURL(/\/colosseum$/);
  await expect(p.locator('.viewer-container.loaded')).toBeVisible({ timeout: 20_000 });
  expect(p.problems).toEqual([]);
});
