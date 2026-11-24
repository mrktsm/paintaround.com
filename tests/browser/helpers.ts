import { existsSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import sharp from 'sharp';

/** A place whose 3D data must be there, so strokes are drawn onto surfaces like in production. */
export const PLACE = process.env.PLACE ?? 'ph-colosseum';
const PUBLIC = new URL('../../public/', import.meta.url).pathname;
const ready = existsSync(`${PUBLIC}panorama-pool/${PLACE}.jpg`) && existsSync(`${PUBLIC}deep-layers/${PLACE}/distance.f32`);

const open: Page[] = [];

/** Call at the top of a file: skips it when the photo or 3D data isn't there, closes everyone's windows after a test. */
export function needsPlace(): void {
  test.skip(!ready, `needs public/panorama-pool/${PLACE}.jpg and public/deep-layers/${PLACE}/`);
  test.afterEach(async () => { await Promise.all(open.splice(0).map(p => p.context().close())); });
}

/** The part of the screen strokes are drawn on and compared in. */
const AREA = { x: 300, y: 380, width: 850, height: 340 };

export type Visitor = Page & { problems: string[] };

/** Someone who opens a place and waits until they can draw. */
export async function visit(browser: Browser, options: BrowserContextOptions & { firstTime?: boolean; path?: string; alone?: boolean } = {}): Promise<Visitor> {
  const { firstTime, path, alone, ...context } = options;
  const page = await (await browser.newContext(context)).newPage() as Visitor;
  page.problems = [];
  open.push(page);
  // alone: no drawing server, so other tests' drawings aren't here
  if (alone) await page.routeWebSocket(/\/ws$/, () => {});
  page.on('pageerror', e => page.problems.push(e.message));
  let on3D = false;
  page.on('console', m => { if (m.text().includes('3D surface painting ON')) on3D = true; });
  if (!firstTime) await page.addInitScript(() => { localStorage.setItem('tutorialSeen', '1'); localStorage.setItem('markerColor', '#FF00FF'); });
  await page.goto(path ?? `/view?imageId=${PLACE}`);
  if (!path) {
    await expect(page.locator('.viewer-container.loaded')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => on3D, { message: 'strokes are drawn onto surfaces', timeout: 20_000 }).toBe(true);
    await page.waitForTimeout(1500); // strokes already here fade in
  }
  return page;
}

/** A picture of the drawing area, with nobody's cursor ring in it. */
export async function look(page: Page, others: Page[] = [], area = AREA): Promise<Buffer> {
  for (const p of [page, ...others]) await p.mouse.move(1230, 150);
  await page.waitForTimeout(800);
  return page.screenshot({ clip: area });
}

/** How many pixels differ visibly between two pictures. */
export async function changed(a: Buffer, b: Buffer): Promise<number> {
  const [x, y] = await Promise.all([a, b].map(p => sharp(p).removeAlpha().raw().toBuffer()));
  let n = 0;
  for (let i = 0; i < x.length; i += 3) if (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]) > 60) n++;
  return n;
}

export async function pick(page: Page, tool: string): Promise<void> {
  await page.click(`.pen-btn.${tool}`);
  await page.waitForTimeout(400);
}

export async function drag(page: Page, from: [number, number], to: [number, number], { button = 'left' as 'left' | 'right', steps = 24, hold = false } = {}): Promise<void> {
  await page.mouse.move(...from);
  await page.mouse.down({ button });
  for (let k = 1; k <= steps; k++) {
    await page.mouse.move(from[0] + (to[0] - from[0]) * k / steps, from[1] + (to[1] - from[1]) * k / steps);
    await page.waitForTimeout(16);
  }
  if (hold) return;
  await page.mouse.up({ button });
  await page.waitForTimeout(1300);
}
