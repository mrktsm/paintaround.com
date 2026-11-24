import { expect, test, type Page } from '@playwright/test';
import { changed, drag, look, needsPlace, pick, visit } from './helpers';

needsPlace();

/** How wide your own ring is on screen. */
async function ring(page: Page): Promise<number> {
  return page.evaluate(() => [...document.querySelectorAll<SVGPathElement>('.viewer-container svg path:not([data-peer])')].reduce((w, p) => Math.max(w, p.getBBox().width), 0));
}
const press = async (page: Page, key: string, times: number) => { for (let k = 0; k < times; k++) { await page.keyboard.press(key); await page.waitForTimeout(30); } };

for (const flat of [false, true]) for (const tool of ['pencil', 'marker', 'crayon', 'fountainPen', 'watercolor']) {
  test(`] makes the ${tool} bigger, [ smaller${flat ? ' without 3D data' : ''}`, async ({ browser }) => {
    const p = await visit(browser, { alone: true, flat });
    await pick(p, tool);
    const paint = async () => {
      const before = await look(p);
      await drag(p, [560, 600], [840, 600], { steps: 40 });
      const size = await changed(before, await look(p));
      await p.click('[aria-label="Undo"]');
      await p.waitForTimeout(800);
      return size;
    };
    const usual = await paint();
    await p.mouse.move(700, 600);
    await p.mouse.move(701, 600);
    const was = await ring(p);
    await press(p, ']', 5); // 1.12^5 = 1.76
    const grown = await ring(p); // without moving the mouse
    expect(grown / was).toBeGreaterThan(1.5);
    expect(grown / was).toBeLessThan(2);
    expect(await paint()).toBeGreaterThan(usual * 1.25);
    await p.mouse.move(700, 600);
    await press(p, '[', 5);
    expect(Math.abs(await ring(p) - was)).toBeLessThan(was * 0.12); // back to the usual size
    await press(p, '[', 6);
    expect(await paint()).toBeLessThan(usual * 0.85);
    expect(p.problems).toEqual([]);
  });
}

test('others see a big brush as big, while it\'s drawn and after', async ({ browser }) => {
  const a = await visit(browser), b = await visit(browser), all = [a, b];
  await pick(a, 'marker');
  await a.mouse.move(700, 520);
  await press(a, ']', 6);
  const emptyA = await look(a, all), emptyB = await look(b, all);
  await drag(a, [520, 560], [800, 560], { hold: true });
  await b.waitForTimeout(700);
  const during = await changed(emptyB, await b.screenshot({ clip: { x: 300, y: 380, width: 850, height: 340 } }));
  await a.mouse.up();
  await a.waitForTimeout(2500);
  const mine = await look(a, all), seen = await look(b, all);
  const sizeA = await changed(emptyA, mine), sizeB = await changed(emptyB, seen);
  expect(sizeA).toBeGreaterThan(2000);
  expect(Math.abs(sizeA - sizeB) / sizeA).toBeLessThan(0.05);
  expect(during).toBeGreaterThan(sizeB * 0.75);
  expect(during).toBeLessThan(sizeB * 1.25);
  expect(await changed(mine, seen)).toBeLessThan(sizeA * 0.05);
  expect(all.flatMap(p => p.problems)).toEqual([]);
});

test('the eraser has a size too; each tool remembers its own; nothing changes mid-stroke', async ({ browser }) => {
  const p = await visit(browser, { alone: true });
  await pick(p, 'marker');
  await drag(p, [520, 620], [880, 620]);
  const painted = await look(p);
  await pick(p, 'eraser');
  const rub = async () => { await drag(p, [700, 560], [700, 680]); const n = await changed(painted, await look(p)); await p.click('[aria-label="Undo"]'); await p.waitForTimeout(800); return n; };
  const usual = await rub();
  await p.mouse.move(600, 500);
  await press(p, ']', 6);
  expect(await rub()).toBeGreaterThan(usual * 1.5);
  // the marker stayed as it was
  await pick(p, 'marker');
  await p.mouse.move(700, 560);
  await p.mouse.move(701, 560);
  const marker = await ring(p);
  await p.mouse.down();
  await p.mouse.move(760, 560, { steps: 6 });
  await press(p, ']', 5);
  await p.mouse.up();
  await p.mouse.move(700, 560);
  await p.mouse.move(701, 560);
  expect(Math.abs(await ring(p) - marker)).toBeLessThan(marker * 0.1);
  // and after a reload the eraser is still big
  await p.reload();
  await expect(p.locator('.viewer-container.loaded')).toBeVisible({ timeout: 20_000 });
  await p.waitForTimeout(2500);
  expect(await p.evaluate(() => JSON.parse(localStorage.getItem('brushSizes')!).eraser)).toBeGreaterThan(1.8);
  expect(p.problems).toEqual([]);
});

test('sizes have limits', async ({ browser }) => {
  const p = await visit(browser, { alone: true });
  await pick(p, 'marker');
  await p.mouse.move(700, 600);
  await press(p, ']', 40);
  expect(await p.evaluate(() => JSON.parse(localStorage.getItem('brushSizes')!).marker)).toBe(2.2);
  await press(p, '[', 60);
  expect(await p.evaluate(() => JSON.parse(localStorage.getItem('brushSizes')!).marker)).toBe(0.4);
});
