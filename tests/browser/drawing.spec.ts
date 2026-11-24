import { expect, test } from '@playwright/test';
import { changed, drag, look, needsPlace, pick, visit, PLACE } from './helpers';

needsPlace();

for (const tool of ['pencil', 'marker', 'crayon', 'fountainPen', 'watercolor']) {
  test(`${tool} paints, undo removes it, redo brings it back`, async ({ browser }) => {
    const p = await visit(browser, { alone: true });
    await pick(p, tool);
    const before = await look(p);
    await drag(p, [520, 620], [880, 620]);
    const painted = await look(p), size = await changed(before, painted);
    expect(size).toBeGreaterThan(60);
    await p.click('[aria-label="Undo"]');
    await p.waitForTimeout(900);
    expect(await changed(before, await look(p))).toBeLessThan(size * 0.1);
    await p.click('[aria-label="Redo"]');
    await p.waitForTimeout(900);
    expect(await changed(painted, await look(p))).toBeLessThan(size * 0.1);
    expect(p.problems).toEqual([]);
  });
}

test('paint lands under the pointer', async ({ browser }) => {
  const p = await visit(browser, { alone: true });
  await pick(p, 'marker');
  const before = await look(p);
  await drag(p, [640, 600], [760, 600]);
  const after = await look(p);
  const { default: sharp } = await import('sharp');
  const [a, b] = await Promise.all([before, after].map(x => sharp(x).removeAlpha().raw().toBuffer()));
  let x = 0, y = 0, n = 0;
  for (let i = 0; i < a.length; i += 3) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 90) { x += (i / 3) % 850; y += Math.floor(i / 3 / 850); n++; }
  expect(Math.abs(300 + x / n - 700)).toBeLessThan(15);
  expect(Math.abs(380 + y / n - 600)).toBeLessThan(15);
});

test('the eraser rubs out paint, and undo puts it back', async ({ browser }) => {
  const p = await visit(browser, { alone: true });
  await pick(p, 'marker');
  await drag(p, [520, 620], [880, 620]);
  const painted = await look(p);
  await pick(p, 'eraser');
  await drag(p, [700, 580], [700, 660]);
  expect(await changed(painted, await look(p))).toBeGreaterThan(20);
  await p.click('[aria-label="Undo"]');
  await p.waitForTimeout(900);
  expect(await changed(painted, await look(p))).toBeLessThan(15);
});

test('right-drag looks around and the wheel zooms', async ({ browser }) => {
  const p = await visit(browser, { alone: true });
  const a = await look(p);
  await drag(p, [700, 500], [500, 500], { button: 'right' });
  const b = await look(p);
  expect(await changed(a, b)).toBeGreaterThan(20_000);
  await p.mouse.move(700, 500);
  for (let k = 0; k < 8; k++) { await p.mouse.wheel(0, -120); await p.waitForTimeout(40); }
  await p.waitForTimeout(800);
  expect(await changed(b, await look(p))).toBeGreaterThan(20_000);
});

test('the colour is remembered, and closing goes back to the place on the map', async ({ browser }) => {
  const p = await visit(browser, { alone: true });
  await pick(p, 'marker');
  await p.fill('.color-picker-swatch input', '#00aa55');
  await expect.poll(() => p.evaluate(() => localStorage.getItem('markerColor')?.toLowerCase())).toBe('#00aa55');
  await p.click('.view-close');
  await expect(p).toHaveURL(new RegExp(`imageId=${PLACE}`));
  expect(new URL(p.url()).searchParams.get('lng')).toBeTruthy();
  expect(p.problems).toEqual([]);
});

test('a first-time visitor is shown how to look around, until they do', async ({ browser }) => {
  const p = await visit(browser, { alone: true, firstTime: true });
  const tip = p.getByText('Right-click and drag to look around');
  await expect(tip).toBeVisible();
  await drag(p, [700, 400], [600, 400], { button: 'right' });
  await expect(tip).toBeHidden();
});

test('an unknown place says so', async ({ browser }) => {
  const p = await visit(browser, { alone: true, path: '/view?imageId=nope' });
  await expect(p.getByText('Explore places to draw')).toBeVisible();
});

test('on a phone one finger paints and two look around', async ({ browser }) => {
  const p = await visit(browser, { alone: true, viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true });
  const c = await p.context().newCDPSession(p);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: [number, number][]) => c.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const area = { x: 0, y: 420, width: 402, height: 280 }, shot = () => p.screenshot({ clip: area });
  await p.tap('.pen-btn.marker');
  await p.waitForTimeout(500);
  const before = await shot();
  await touch('touchStart', [[200, 620]]);
  await p.waitForTimeout(100);
  for (let k = 1; k <= 20; k++) { await touch('touchMove', [[200 + k * 5, 620]]); await p.waitForTimeout(16); }
  await touch('touchEnd', []);
  await p.waitForTimeout(1600);
  const painted = await shot();
  expect(await changed(before, painted)).toBeGreaterThan(80);
  await touch('touchStart', [[120, 500], [240, 500]]);
  await p.waitForTimeout(250);
  for (let k = 1; k <= 20; k++) { await touch('touchMove', [[120 + k * 5, 500], [240 + k * 5, 500]]); await p.waitForTimeout(16); }
  await touch('touchEnd', []);
  await p.waitForTimeout(1200);
  expect(await changed(painted, await shot())).toBeGreaterThan(8000);
  // the two fingers left no stroke behind: one undo empties the history
  await p.tap('[aria-label="Undo"]');
  await p.waitForTimeout(800);
  await expect(p.locator('[aria-label="Undo"]')).toBeDisabled();
});
