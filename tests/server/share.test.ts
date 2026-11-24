import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { placeNames } from '../../shared/placePath.ts';
import { formatAt, parseAt } from '../../shared/shareView.ts';
import { dab, fakeGemini, relay, until, wait } from './helpers.ts';

const PLACE = 'ph-colosseum'; // in the catalog
/** A folder with a panorama: grey, with a white wall around u = 0.25. */
async function photos(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'panos-'));
  const wall = await sharp({ create: { width: 400, height: 1024, channels: 3, background: '#ffffff' } }).png().toBuffer();
  await sharp({ create: { width: 2048, height: 1024, channels: 3, background: '#808080' } }).composite([{ input: wall, left: 312, top: 0 }]).jpeg().toFile(join(dir, `${PLACE}.jpg`));
  return `${dir}/`;
}
function site(): string {
  const dir = mkdtempSync(join(tmpdir(), 'site-'));
  writeFileSync(join(dir, 'index.html'), '<html><head><title>paintaround.com</title><meta property="og:title" content="x" /><meta property="og:description" content="x" /><meta property="og:url" content="x" /><meta name="twitter:title" content="x" /></head><body></body></html>');
  return dir;
}
async function colour(jpeg: Buffer, x = 600, y = 315): Promise<number[]> {
  return [...await sharp(jpeg).extract({ left: x - 10, top: y - 10, width: 20, height: 20 }).resize(1, 1).removeAlpha().raw().toBuffer()];
}
const picture = async (r: { get(path: string): Promise<Response> }, at: string) => {
  const res = await r.get(`/api/share/${PLACE}.jpg?at=${at}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  return Buffer.from(await res.arrayBuffer());
};

test('where someone looks survives the link; nonsense doesn\'t', () => {
  assert.deepEqual(parseAt(formatAt({ u: 0.12345, v: 0.6, zoom: 1.234 })), { u: 0.1235, v: 0.6, zoom: 1.23 });
  assert.equal(formatAt({ u: -0.25, v: 0.5, zoom: 0 }), '0.7500,0.5000,0.00');
  for (const bad of [null, '', '1', '0.5,0.5', '2,0.5,0', '0.5,0.5,9', '0.5,0.5,1,1', '"><script>', '0.5,-1,0', 'NaN,0,0', '0.5,0.5,1e9']) assert.equal(parseAt(bad), null, String(bad));
});

test('every place has its own address', () => {
  const { items } = JSON.parse(readFileSync(new URL('../../shared/panorama-pool.json', import.meta.url), 'utf8'));
  const names = placeNames(items);
  assert.equal(new Set(names.values()).size, items.length);
  for (const name of names.values()) assert.match(name, /^[a-z0-9-]+$/);
  assert.equal(names.get('ph-piazza_san_marco'), 'piazza-san-marco');
  assert.deepEqual([...placeNames([{ id: 'ph-terms', title: '' }, { id: 'a', title: 'Café Été' }, { id: 'b', title: 'Cafe ete' }]).values()], ['terms-2', 'cafe-ete', 'cafe-ete-2']);
});

test('a link\'s picture looks where the link says, and shows the drawings', async t => {
  const r = await relay({ PANO_DIR: await photos() });
  t.after(r.stop);
  const wall = await picture(r, '0.2500,0.5000,0.35');
  const { width, height } = await sharp(wall).metadata();
  assert.deepEqual([width, height], [1200, 630]);
  assert.ok((await colour(wall))[0] > 240, 'the white wall is in the middle');
  assert.ok((await colour(await picture(r, '0.7500,0.5000,0.35')))[0] < 150, 'not the other way');
  // 45° to the left of the wall it's off to the right; zoomed in, out of the picture
  assert.ok((await colour(await picture(r, '0.1250,0.5000,0.35'), 1010))[0] > 240);

  const a = await r.person(PLACE), s = await dab(0.735, 0.47, '#0000ff', 160);
  a.draw(s);
  await until('the drawing is in the picture', async () => { const [red, , blue] = await colour(await picture(r, '0.7545,0.5090,0.35')); return blue > 200 && red < 90; });
  a.send({ t: 'erase', ids: [s.id] });
  await until('and gone once erased', async () => (await colour(await picture(r, '0.7545,0.5090,0.35')))[0] > 100);
});

test('drawings waiting for moderation aren\'t in the picture', async t => {
  const r = await relay({ PANO_DIR: await photos(), GEMINI_API_KEY: 'x', GEMINI_URL: 'http://127.0.0.1:9', MODERATION: 'on', MODERATION_QUIET_MS: '60000', MODERATION_MAX_WAIT_MS: '60000' });
  t.after(r.stop);
  const a = await r.person(PLACE);
  a.draw(await dab(0.735, 0.47, '#0000ff', 160));
  await new Promise(ok => setTimeout(ok, 600));
  assert.ok((await colour(await picture(r, '0.7545,0.5090,0.35')))[0] > 100);
});

test('sharing checks what was just drawn, so it\'s in the picture', async t => {
  const gemini = await fakeGemini();
  const r = await relay({ PANO_DIR: await photos(), GEMINI_API_KEY: 'x', GEMINI_URL: gemini.url, MODERATION: 'on', MODERATION_QUIET_MS: '60000', MODERATION_MAX_WAIT_MS: '60000', SHARE_WAIT_MS: '4000' });
  t.after(async () => { await r.stop(); gemini.close(); });
  const at = '0.7545,0.5090,0.35', isBlue = async (extra: string) => { const [red, , blue] = await colour(await picture(r, at + extra)); return blue > 200 && red < 90; };
  const a = await r.person(PLACE), b = await r.person(PLACE);
  a.draw(await dab(0.735, 0.47, '#0000ff', 160));
  await wait(400);
  // opening the place doesn't wait for a check, or cause one
  const started = Date.now();
  assert.equal(await isBlue(''), false);
  assert.ok(Date.now() - started < 1500);
  assert.equal(gemini.calls.length, 0);
  // a chat app asking for the picture does
  assert.equal(await isBlue('&v=1'), true);
  assert.equal(gemini.calls.length, 1);
  assert.equal(await isBlue(''), true, 'and then it\'s checked for good');
  // again at once: no more checks
  a.draw(await dab(0.2, 0.2, '#0000ff', 160));
  await wait(300);
  await picture(r, `${at}&v=2`);
  assert.equal(gemini.calls.length, 1);
  assert.equal(b.seen.size, 2);
});

test('bad drawings shared right away are taken down, not into the picture', async t => {
  const gemini = await fakeGemini();
  const r = await relay({ PANO_DIR: await photos(), GEMINI_API_KEY: 'x', GEMINI_URL: gemini.url, MODERATION: 'on', MODERATION_QUIET_MS: '60000', MODERATION_MAX_WAIT_MS: '60000' });
  t.after(async () => { await r.stop(); gemini.close(); });
  const a = await r.person(PLACE), b = await r.person(PLACE), bad = await dab(0.735, 0.47, '#ff0000', 160);
  a.draw(bad);
  await until('b sees it', () => b.seen.has(bad.id));
  const [red, green] = await colour(await picture(r, '0.7545,0.5090,0.35&v=1'));
  assert.ok(Math.abs(red - green) < 40, 'grey, not red');
  await until('it\'s taken down', () => !b.seen.has(bad.id));
});

test('a slow check doesn\'t hold the picture up for long, and its result still counts', async t => {
  const gemini = await fakeGemini();
  gemini.slowMs = 2500;
  const r = await relay({ PANO_DIR: await photos(), GEMINI_API_KEY: 'x', GEMINI_URL: gemini.url, MODERATION: 'on', MODERATION_QUIET_MS: '60000', MODERATION_MAX_WAIT_MS: '60000', SHARE_WAIT_MS: '700' });
  t.after(async () => { await r.stop(); gemini.close(); });
  const a = await r.person(PLACE);
  a.draw(await dab(0.735, 0.47, '#0000ff', 160));
  await wait(400);
  const started = Date.now(), blue = async () => (await colour(await picture(r, '0.7545,0.5090,0.35&v=1')))[2] > 200;
  assert.equal(await blue(), false);
  assert.ok(Date.now() - started < 2000);
  await until('it\'s there once checked', blue);
});

test('unknown places and too many pictures', async t => {
  const r = await relay({ PANO_DIR: await photos(), SHARE_MAX_PER_MINUTE: '2' });
  t.after(r.stop);
  assert.equal((await r.get('/api/share/nowhere.jpg?at=0.5,0.5,0')).status, 404);
  assert.equal((await r.get('/api/share/..%2f..%2fetc.jpg')).status, 404);
  await picture(r, '0.1000,0.5000,0.00');
  await picture(r, '0.2000,0.5000,0.00');
  const third = await r.get(`/api/share/${PLACE}.jpg?at=0.3000,0.5000,0.00`, { redirect: 'manual' });
  assert.equal(third.status, 302);
  assert.equal(third.headers.get('location'), `/panorama-pool/${PLACE}-card.jpg`);
  await picture(r, '0.1000,0.5000,0.00'); // made before: still there
});

test('the page tells chat apps about the place and its picture', async t => {
  const r = await relay({ PANO_DIR: await photos(), SITE_DIR: site() });
  t.after(r.stop);
  const html = await (await r.get('/colosseum?at=0.2500,0.5000,0.35')).text();
  assert.match(html, /<title>Colosseum · paintaround\.com<\/title>/);
  assert.match(html, /og:title" content="Colosseum"/);
  assert.match(html, /og:image" content="http:\/\/test\.local\/api\/share\/ph-colosseum\.jpg\?v=0&amp;at=0\.2500,0\.5000,0\.35"/);
  assert.match(html, /rel="preload" as="image"[^>]*at=0\.2500,0\.5000,0\.35/);
  assert.match(html, /og:url" content="http:\/\/test\.local\/colosseum\?at=0\.2500,0\.5000,0\.35"/);
  assert.match(await (await r.get(`/view?imageId=${PLACE}`)).text(), /og:title" content="Colosseum"/); // links from before
  // nothing from the link itself gets into the page
  const evil = await (await r.get(`/colosseum?at=${encodeURIComponent('"><script>alert(1)</script>')}`)).text();
  assert.ok(!evil.includes('script>alert') && evil.includes('og:title" content="Colosseum"'));
  const unknown = await (await r.get('/nowhere')).text();
  assert.ok(unknown.includes('<title>paintaround.com</title>') && !unknown.includes('<script>'));
});

test('without the site there, the page says so (the web server then sends the plain one)', async t => {
  const r = await relay({ PANO_DIR: await photos(), SITE_DIR: '/nowhere' });
  t.after(r.stop);
  assert.equal((await r.get('/colosseum')).status, 503);
});
