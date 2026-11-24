import { expect, test } from '@playwright/test';
import { changed, drag, look, needsPlace, pick, visit } from './helpers';

needsPlace();

test('drawing together: live strokes, latecomers, erasing, undo and leaving', async ({ browser }) => {
  test.setTimeout(150_000);
  const a = await visit(browser), b = await visit(browser), all = [a, b];
  const see = (p: typeof a) => look(p, all);
  const empty = await see(b), emptyA = await see(a);
  await pick(a, 'marker');

  await test.step('b sees the stroke while a is still drawing it', async () => {
    await drag(a, [520, 620], [700, 620], { hold: true });
    await b.waitForTimeout(500);
    expect(await changed(empty, await b.screenshot({ clip: { x: 300, y: 380, width: 850, height: 340 } }))).toBeGreaterThan(150);
    for (let k = 1; k <= 14; k++) { await a.mouse.move(700 + k * 12, 620); await a.waitForTimeout(20); }
    await a.mouse.up();
    await a.waitForTimeout(2500);
  });

  const drawn = await see(b), size = await changed(empty, drawn);
  await test.step('both end with the same drawing', async () => {
    const mine = await see(a), sizeA = await changed(emptyA, mine);
    expect(size).toBeGreaterThan(400);
    expect(Math.abs(size - sizeA) / sizeA).toBeLessThan(0.12);
    expect(await changed(mine, drawn)).toBeLessThan(sizeA * 0.25);
  });

  await test.step('someone arriving later sees it', async () => {
    const late = await visit(browser);
    all.push(late);
    expect(await changed(drawn, await see(late))).toBeLessThan(size * 0.25);
  });

  await test.step('b sees a erase, and can\'t erase a\'s drawing', async () => {
    await pick(a, 'eraser');
    await drag(a, [700, 580], [700, 660]);
    await a.waitForTimeout(700);
    const erased = await see(b);
    expect(await changed(drawn, erased)).toBeGreaterThan(20);
    await pick(b, 'eraser');
    await drag(b, [600, 580], [600, 660]);
    expect(await changed(erased, await see(b))).toBeLessThan(15);
  });

  await test.step('undo and redo reach everyone', async () => {
    const press = async (what: string) => { await a.click(`[aria-label="${what}"]`); await a.waitForTimeout(1800); };
    await press('Undo');
    expect(await changed(drawn, await see(b))).toBeLessThan(size * 0.12);
    await press('Undo');
    expect(await changed(empty, await see(b))).toBeLessThan(size * 0.12);
    await press('Redo');
    expect(await changed(drawn, await see(b))).toBeLessThan(size * 0.2);
  });

  await test.step('it stays after a leaves', async () => {
    await a.click('.view-close');
    await a.waitForTimeout(2500);
    expect(await changed(drawn, await look(b, all.filter(p => p !== a)))).toBeLessThan(size * 0.2);
  });
  expect(all.flatMap(p => p.problems)).toEqual([]);
});

test('where there is no 3D data, strokes are still seen live and end up the same', async ({ browser }) => {
  const a = await visit(browser, { flat: true }), b = await visit(browser, { flat: true }), all = [a, b];
  await pick(a, 'marker');
  const empty = await look(b, all), emptyA = await look(a, all);
  await drag(a, [520, 480], [700, 480], { hold: true });
  await b.waitForTimeout(500);
  expect(await changed(empty, await b.screenshot({ clip: { x: 300, y: 380, width: 850, height: 340 } }))).toBeGreaterThan(1000);
  await a.mouse.up();
  await a.waitForTimeout(3000);
  const seen = await changed(empty, await look(b, all)), mine = await changed(emptyA, await look(a, all));
  expect(Math.abs(seen - mine) / mine).toBeLessThan(0.12); // the live version is gone, only the finished one is left
  await a.click('[aria-label="Undo"]');
  await a.waitForTimeout(1800);
  expect(await changed(empty, await look(b, all))).toBeLessThan(mine * 0.05);
});

test('others see your cursor ring, pinned to the scene, until you leave', async ({ browser }) => {
  const a = await visit(browser), b = await visit(browser);
  const ring = b.locator('svg path[data-peer]');
  await pick(a, 'marker');
  await a.mouse.move(700, 600);
  await a.mouse.move(705, 600, { steps: 4 });
  await expect(ring).toHaveCount(1);
  await expect.poll(async () => (await ring.boundingBox())?.width ?? 0).toBeGreaterThan(4);
  const at = (await ring.boundingBox())!;
  expect(Math.abs(at.x + at.width / 2 - 705)).toBeLessThan(25);
  expect(Math.abs(at.y + at.height / 2 - 600)).toBeLessThan(25);
  await drag(b, [700, 500], [600, 500], { button: 'right' });
  const moved = (await ring.boundingBox())!;
  expect(at.x - moved.x).toBeGreaterThan(40); // the scene moved, the ring with it
  await a.click('.view-close');
  await expect(ring).toHaveCount(0);
  expect([...a.problems, ...b.problems]).toEqual([]);
});
