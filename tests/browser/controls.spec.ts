import { expect, test, type Page } from '@playwright/test';
import { changed, drag, look, needsPlace, pick, visit } from './helpers';

needsPlace();

const PHONE = { viewport: { width: 393, height: 780 }, hasTouch: true, isMobile: true };
const PHONE_AREA = { x: 20, y: 300, width: 350, height: 260 };
type Finger = [number, number];

/** Real touches, with as many fingers as you like. */
async function fingers(page: Page) {
  const c = await page.context().newCDPSession(page);
  const send = (type: string, at: Finger[]) => c.send('Input.dispatchTouchEvent', { type, touchPoints: at.map(([x, y], id) => ({ x, y, id })) } as never);
  return {
    async tap(...at: Finger[]) { for (let k = 1; k <= at.length; k++) await send('touchStart', at.slice(0, k)); await page.waitForTimeout(60); await send('touchEnd', []); await page.waitForTimeout(1200); },
    async swipe(from: Finger[], by: Finger, { steps = 12, ms = 16, rest = 0 } = {}) {
      for (let k = 1; k <= from.length; k++) await send('touchStart', from.slice(0, k));
      for (let k = 1; k <= steps; k++) { await send('touchMove', from.map(([x, y]) => [x + (by[0] * k) / steps, y + (by[1] * k) / steps])); await page.waitForTimeout(ms); }
      if (rest) await page.waitForTimeout(rest);
      await send('touchEnd', []);
    },
  };
}
/** Where they're looking (from the link they'd share). */
async function looking(page: Page): Promise<{ u: number; v: number; zoom: number }> {
  await page.evaluate(() => Object.defineProperty(navigator, 'share', { configurable: true, value: async (d: { url: string }) => { (window as unknown as { __url: string }).__url = d.url; } }));
  await page.evaluate(() => { (window as unknown as { __url: string }).__url = ''; document.querySelector<HTMLElement>('.view-share')!.click(); });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __url: string }).__url)).toBeTruthy();
  const [u, v, zoom] = new URL(await page.evaluate(() => (window as unknown as { __url: string }).__url)).searchParams.get('at')!.split(',').map(Number);
  return { u, v, zoom };
}
const turned = (a: { u: number }, b: { u: number }) => { const d = Math.abs(a.u - b.u); return Math.min(d, 1 - d) * 360; };

test('undo and redo with the keyboard', async ({ browser }) => {
  const p = await visit(browser, { alone: true });
  await pick(p, 'marker');
  const before = await look(p);
  await drag(p, [520, 620], [880, 620]);
  const painted = await look(p), size = await changed(before, painted);
  for (const [undo, redo] of [['ControlOrMeta+z', 'ControlOrMeta+Shift+z'], ['ControlOrMeta+z', 'ControlOrMeta+y']]) {
    await p.keyboard.press(undo);
    await p.waitForTimeout(700);
    expect(await changed(before, await look(p))).toBeLessThan(size * 0.1);
    await p.keyboard.press(redo);
    await p.waitForTimeout(700);
    expect(await changed(painted, await look(p))).toBeLessThan(size * 0.1);
  }
  expect(p.problems).toEqual([]);
});

test('arrow keys look around, + and - zoom', async ({ browser }) => {
  const p = await visit(browser, { alone: true });
  const hold = async (key: string) => { await p.keyboard.down(key); await p.waitForTimeout(500); await p.keyboard.up(key); await p.waitForTimeout(900); };
  const a = await looking(p);
  await hold('ArrowRight');
  const b = await looking(p);
  expect(turned(a, b)).toBeGreaterThan(15);
  await hold('ArrowLeft');
  expect(turned(a, await looking(p))).toBeLessThan(6);
  await hold('ArrowUp');
  expect((await looking(p)).v).toBeLessThan(a.v - 0.03);
  await hold('+');
  const zoomed = await looking(p);
  expect(zoomed.zoom).toBeGreaterThan(a.zoom + 0.3);
  // the wheel goes on from there instead of jumping back
  await p.mouse.move(700, 400);
  for (let k = 0; k < 3; k++) { await p.mouse.wheel(0, 120); await p.waitForTimeout(60); }
  await p.waitForTimeout(500);
  expect(Math.abs((await looking(p)).zoom - (zoomed.zoom - 0.72))).toBeLessThan(0.15);
  expect(p.problems).toEqual([]);
});

test('holding Space drags the view instead of drawing', async ({ browser }) => {
  const p = await visit(browser, { alone: true });
  await pick(p, 'marker');
  const a = await looking(p);
  await p.keyboard.down('Space');
  await drag(p, [800, 500], [600, 500]);
  await p.keyboard.up('Space');
  await p.waitForTimeout(700);
  expect(turned(a, await looking(p))).toBeGreaterThan(10);
  await expect(p.locator('[aria-label="Undo"]')).toBeDisabled();
  await expect(p.locator('.pen-btn.marker')).toHaveClass(/active/); // Space didn't press the pen
  await drag(p, [520, 620], [700, 620]);
  await expect(p.locator('[aria-label="Undo"]')).toBeEnabled();
});

test('dragging the view: it sticks to the pointer, and stays where it\'s let go', async ({ browser }) => {
  const p = await visit(browser, { alone: true });
  await pick(p, 'pencil'); // put it down
  const a = await looking(p);
  await p.mouse.move(700, 400);
  await p.mouse.down();
  await p.mouse.move(600, 400, { steps: 10 });
  await p.waitForTimeout(200);
  await p.mouse.up();
  await p.waitForTimeout(500);
  // at zoom 0.35 the screen is 76.2° high, 800 px: 0.1124° per px in the middle
  expect(Math.abs(turned(a, await looking(p)) - 11.24)).toBeLessThan(0.4);
});

test('putting the pen down: dragging looks around; picking one up draws again', async ({ browser }) => {
  const p = await visit(browser, { alone: true });
  await pick(p, 'marker');
  await pick(p, 'marker'); // the same one: put down
  await expect(p.locator('.pen-btn.active')).toHaveCount(0);
  const a = await looking(p);
  await drag(p, [800, 500], [600, 500]);
  await p.waitForTimeout(700);
  expect(turned(a, await looking(p))).toBeGreaterThan(10);
  await expect(p.locator('[aria-label="Undo"]')).toBeDisabled();
  await pick(p, 'crayon');
  await drag(p, [520, 620], [700, 620]);
  await expect(p.locator('[aria-label="Undo"]')).toBeEnabled();
  expect(p.problems).toEqual([]);
});

test('on a phone: one finger looks around with the pen down, and goes on when the other one lifts', async ({ browser }) => {
  const p = await visit(browser, { alone: true, ...PHONE });
  const f = await fingers(p);
  await p.locator('.pen-btn.pencil').tap(); // it's picked: put it down
  const a = await looking(p);
  await f.swipe([[300, 400]], [-150, 0], { rest: 150 });
  await p.waitForTimeout(300);
  const b = await looking(p);
  expect(Math.abs(turned(a, b) - 150 * 0.1153 * 1.3)).toBeLessThan(2); // held still before letting go: no glide
  await expect(p.locator('[aria-label="Undo"]')).toBeDisabled();
  expect(p.problems).toEqual([]);
});

test('on a phone: a flick glides far, and a touch stops it', async ({ browser }) => {
  const p = await visit(browser, { alone: true, ...PHONE });
  const f = await fingers(p);
  const a = await looking(p);
  await f.swipe([[250, 350], [250, 430]], [-120, 0], { steps: 6 });
  await p.waitForTimeout(2500);
  const b = await looking(p);
  expect(turned(a, b)).toBeGreaterThan(35); // the drag itself is about 14°
  await f.swipe([[250, 350], [250, 430]], [-120, 0], { steps: 6 });
  await p.waitForTimeout(80);
  await f.swipe([[200, 350], [200, 430]], [0, 0], { steps: 1, rest: 200 });
  const c = await looking(p);
  await p.waitForTimeout(800);
  expect(turned(c, await looking(p))).toBeLessThan(0.5);
});

test('on a phone: two fingers tapping undo, three redo; a pinch doesn\'t', async ({ browser }) => {
  const p = await visit(browser, { alone: true, ...PHONE });
  const f = await fingers(p);
  await p.locator('.pen-btn.marker').tap();
  await p.waitForTimeout(400);
  const empty = await look(p, [], PHONE_AREA);
  await f.swipe([[80, 480]], [220, 0], { steps: 20 });
  await p.waitForTimeout(1500);
  const painted = await look(p, [], PHONE_AREA), size = await changed(empty, painted);
  expect(size).toBeGreaterThan(400);
  await f.tap([150, 350], [240, 350]);
  expect(await changed(empty, await look(p, [], PHONE_AREA))).toBeLessThan(size * 0.1);
  await f.tap([120, 350], [200, 350], [280, 350]);
  expect(await changed(painted, await look(p, [], PHONE_AREA))).toBeLessThan(size * 0.15);
  // looking around with two fingers leaves the drawing alone
  await f.swipe([[150, 350], [240, 350]], [60, 0], { rest: 150 });
  await p.waitForTimeout(600);
  await expect(p.locator('[aria-label="Undo"]')).toBeEnabled();
  expect(p.problems).toEqual([]);
});

test('on a phone: starting to draw and then adding a finger takes back only that stroke', async ({ browser }) => {
  const p = await visit(browser, { alone: true, ...PHONE });
  const f = await fingers(p), c = await p.context().newCDPSession(p);
  const send = (type: string, at: Finger[]) => c.send('Input.dispatchTouchEvent', { type, touchPoints: at.map(([x, y], id) => ({ x, y, id })) } as never);
  for (const tool of ['marker', 'eraser']) {
    await p.locator(`.pen-btn.${tool}`).tap();
    await p.waitForTimeout(400);
    if (tool === 'marker') { await f.swipe([[80, 480]], [220, 0], { steps: 20 }); await p.waitForTimeout(1500); }
    const before = await look(p, [], PHONE_AREA);
    await send('touchStart', [[150, 400]]);
    for (let k = 1; k <= 14; k++) { await send('touchMove', [[150, 400 + k * 10]]); await p.waitForTimeout(16); }
    await send('touchStart', [[150, 540], [250, 540]]);
    await p.waitForTimeout(250);
    await send('touchEnd', []);
    await p.waitForTimeout(1500);
    expect(await changed(before, await look(p, [], PHONE_AREA)), tool).toBeLessThan(60);
    await expect(p.locator('[aria-label="Undo"]')).toBeEnabled();
    await expect(p.locator('[aria-label="Redo"]')).toBeDisabled();
  }
  expect(p.problems).toEqual([]);
});
