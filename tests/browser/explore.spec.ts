import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import type { Map } from 'maplibre-gl';

declare global { interface Window { __map: Map } }

const pages: Page[] = [];
test.afterEach(async () => { await Promise.all(pages.splice(0).map(p => p.context().close())); });

async function explore(browser: Browser, path = '/', options: BrowserContextOptions = {}): Promise<Page> {
  const page = await (await browser.newContext(options)).newPage();
  pages.push(page);
  await page.goto(path);
  await expect(page.locator('.ex-pin.is-shown').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1200);
  return page;
}
const PHONE = { viewport: { width: 393, height: 780 }, hasTouch: true, isMobile: true };
const middle = (p: Page) => p.evaluate(() => window.__map.getCenter());
const far = (a: { lng: number; lat: number }, b: { lng: number; lat: number }) => Math.hypot(a.lng - b.lng, a.lat - b.lat);

test('tapping a photo circle opens that place', async ({ browser }) => {
  const p = await explore(browser);
  // one that isn't under the panel or the controls
  const id = await p.evaluate(() => [...document.querySelectorAll<HTMLElement>('.ex-pin.is-shown')].find(el => {
    const r = el.querySelector('.ex-pin__photo')!.getBoundingClientRect(), top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!top && el.contains(top);
  })?.dataset.place);
  expect(id).toBeTruthy();
  await p.locator(`.ex-pin[data-place="${id}"] .ex-pin__photo`).click();
  await expect(p).toHaveURL(new RegExp(`/${id!.replace(/^ph-/, '').replaceAll('_', '-')}$`));
});

test('picking a city flies there and shows its places', async ({ browser }) => {
  const p = await explore(browser);
  const before = await middle(p), hero = p.locator('.ex-card--hero .ex-card__title'), title = await hero.textContent();
  await p.click('.ex-city__btn');
  await p.locator('.ex-cmenu__row', { hasText: 'Europe' }).hover();
  await p.locator('.ex-cmenu__row--city', { hasText: 'Paris' }).click();
  await expect(p.locator('.ex-city__btn')).toContainText('Paris');
  await expect(hero).not.toHaveText(title!);
  await expect.poll(async () => far(before, await middle(p)), { timeout: 8000 }).toBeGreaterThan(5);
  await p.waitForTimeout(1500);
  expect(Math.abs((await middle(p)).lat - 48.86)).toBeLessThan(0.3);
});

test('dragging the map to another city changes the panel, without moving the map back', async ({ browser }) => {
  const p = await explore(browser);
  const paris: [number, number] = [2.35, 48.86];
  await p.evaluate(c => window.__map.jumpTo({ center: c, zoom: 11 }), paris); // ours: doesn't count
  await p.waitForTimeout(800);
  await expect(p.locator('.ex-city__btn')).toContainText('Rome');
  await p.mouse.move(900, 400);
  await p.mouse.down();
  await p.mouse.move(930, 410, { steps: 8 });
  await p.mouse.up();
  await expect(p.locator('.ex-city__btn')).toContainText('Paris', { timeout: 5000 });
  await p.waitForTimeout(2000);
  expect(far(await middle(p), { lng: paris[0], lat: paris[1] })).toBeLessThan(0.3);
});

test('zooming in keeps the circles there are and adds more', async ({ browser }) => {
  const p = await explore(browser);
  const shown = () => p.evaluate(() => [...document.querySelectorAll<HTMLElement>('.ex-pin.is-shown')].map(e => e.dataset.place!));
  await p.evaluate(() => window.__map.jumpTo({ center: [12.49, 41.9], zoom: 11 }));
  await p.waitForTimeout(1200);
  const few = await shown();
  await p.evaluate(() => window.__map.jumpTo({ center: [12.49, 41.9], zoom: 13.5 }));
  await p.waitForTimeout(1200);
  const more = await shown();
  expect(more.length).toBeGreaterThan(few.length);
  await p.evaluate(() => window.__map.jumpTo({ center: [12.49, 41.9], zoom: 11 }));
  await p.waitForTimeout(1200);
  expect((await shown()).sort()).toEqual(few.sort());
});

test('searching finds places, opens them and remembers them', async ({ browser }) => {
  const p = await explore(browser);
  await p.click('.ex-tile[aria-label="Search"]');
  await expect(p.locator('.ex-search-empty')).toContainText('No Recent Searches');
  await p.fill('input[aria-label="Search places"]', 'colos');
  await expect(p.locator('.ex-search-result').first()).toContainText(/colosseum/i);
  await p.fill('input[aria-label="Search places"]', 'zzzz');
  await expect(p.locator('.ex-search-empty')).toContainText('No Places Found');
  await p.fill('input[aria-label="Search places"]', 'colos');
  await p.locator('.ex-search-result').first().click();
  await expect(p).toHaveURL(/\/colosseum$/);
  await expect(p.locator('.viewer-container')).toBeVisible();
  await p.goto('/');
  await p.click('.ex-tile[aria-label="Search"]');
  await expect(p.locator('.ex-search-result')).toHaveCount(1);
  await expect(p.locator('.ex-visited')).toHaveCount(1); // and it's one of your visited places
  await p.click('.ex-search-recents button');
  await expect(p.locator('.ex-search-empty')).toBeVisible();
  await p.keyboard.press('Escape');
});

test('coming back from a place shows the map where it is, and the address is the plain one', async ({ browser }) => {
  const p = await (await browser.newContext()).newPage();
  pages.push(p);
  await p.addInitScript(() => localStorage.setItem('tutorialSeen', '1'));
  await p.goto('/quattro-canti');
  await p.locator('.view-close').click();
  await expect(p.locator('.ex-pin.is-shown').first()).toBeVisible({ timeout: 20_000 });
  expect(new URL(p.url()).pathname + new URL(p.url()).search).toBe('/');
  expect(far(await middle(p), { lng: 13.3615, lat: 38.1157 })).toBeLessThan(0.02);
  expect(await p.evaluate(() => window.__map.getZoom())).toBe(15);
  await expect(p.locator('.ex-city__btn')).toContainText('Palermo');
});

test('on a phone: the sheet, search and the city list', async ({ browser }) => {
  const p = await explore(browser, '/', PHONE);
  // the place is in the middle of the map that's visible above the sheet
  const offset = await p.evaluate(() => window.__map.project([12.49, 41.9]).y);
  expect(offset).toBeLessThan(390);
  await p.locator('input[aria-label="Search places"]').tap();
  await expect(p.locator('.ex--sheet-full')).toBeVisible();
  await p.fill('input[aria-label="Search places"]', 'colos');
  await expect(p.locator('.ex-search-result').first()).toContainText(/colosseum/i);
  await p.locator('.ex-sheet__cancel').tap();
  await expect(p.locator('.ex--sheet-half')).toBeVisible();
  await p.waitForTimeout(600);
  await p.locator('.ex-city__btn').tap();
  await p.locator('.ex-option', { hasText: 'Paris' }).first().tap();
  await expect(p.locator('.ex-city__btn')).toContainText('Paris');
  await expect.poll(async () => Math.abs((await middle(p)).lat - 48.86), { timeout: 8000 }).toBeLessThan(0.3);
});

test('on a phone: coming back from a place, nothing is under the search bar, not even for a frame', async ({ browser }) => {
  const p = await (await browser.newContext(PHONE)).newPage();
  pages.push(p);
  await p.addInitScript(() => {
    localStorage.setItem('tutorialSeen', '1');
    const w = window as unknown as { __overlap: number[] };
    w.__overlap = [];
    (function frame() {
      const head = document.querySelector('.ex-sheet__head'), body = document.querySelector('.ex-sheet__body');
      if (head && body) w.__overlap.push(Math.round(head.getBoundingClientRect().bottom - body.getBoundingClientRect().top));
      requestAnimationFrame(frame);
    })();
  });
  await p.goto('/colosseum');
  await expect(p.locator('.viewer-container.loaded')).toBeVisible({ timeout: 20_000 });
  await p.locator('.view-close').tap();
  await expect(p.locator('.ex-recent')).toHaveCount(1);
  await p.waitForTimeout(800);
  const overlap = await p.evaluate(() => (window as unknown as { __overlap: number[] }).__overlap);
  expect(overlap.length).toBeGreaterThan(5);
  expect(Math.max(...overlap)).toBeLessThanOrEqual(0);
});

test('on a phone: the credits move with the sheet, not after it', async ({ browser }) => {
  const p = await explore(browser, '/', PHONE);
  await p.evaluate(() => {
    const w = window as unknown as { __gap: { gap: number; y: number }[] };
    w.__gap = [];
    (function frame() {
      const sheet = document.querySelector('.ex-sheet')!.getBoundingClientRect(), line = document.querySelector('.ex-credit')!.getBoundingClientRect();
      w.__gap.push({ gap: sheet.top - line.bottom, y: sheet.top });
      requestAnimationFrame(frame);
    })();
  });
  const touch = await p.context().newCDPSession(p);
  const at = (type: string, y?: number) => touch.send('Input.dispatchTouchEvent', { type, touchPoints: y === undefined ? [] : [{ x: 200, y }] } as never);
  const top = (await p.locator('.ex-sheet').boundingBox())!.y;
  await at('touchStart', top + 12);
  for (let k = 1; k <= 25; k++) { await at('touchMove', top + 12 + k * 7); await p.waitForTimeout(16); }
  for (let k = 25; k >= 5; k--) { await at('touchMove', top + 12 + k * 7); await p.waitForTimeout(16); }
  await at('touchEnd');
  await p.waitForTimeout(900);
  const seen = await p.evaluate(() => (window as unknown as { __gap: { gap: number; y: number }[] }).__gap);
  const ys = seen.map(s => s.y), gaps = seen.map(s => s.gap);
  expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(100); // it did move
  expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(3);
});

test('the text in buttons can\'t be selected', async ({ browser }) => {
  const p = await explore(browser);
  const n = p.locator('[aria-label="Face north"] text');
  await expect(n).toHaveText('N');
  const box = (await n.boundingBox())!;
  await p.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await p.keyboard.press('ControlOrMeta+a');
  expect(await p.evaluate(() => getSelection()!.toString())).not.toMatch(/^N$/m);
});
