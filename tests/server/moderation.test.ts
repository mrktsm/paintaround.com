/** Moderation end to end: the real relay, with a stand-in for Gemini that calls red paint "bad". */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import sharp from 'sharp';
import { dab, fakeGemini, fakeNtfy, panoDir, relay, until, wait, PLACE } from './helpers.ts';

const RED = '#ff2020', BLUE = '#2020ff';

async function setup(t: TestContext, env: Record<string, string> = {}) {
  const gemini = await fakeGemini(), ntfy = await fakeNtfy();
  const r = await relay({
    PANO_DIR: await panoDir(), GEMINI_API_KEY: 'test-key', GEMINI_URL: gemini.url, NTFY_TOPIC: 'secret-topic', NTFY_URL: ntfy.url,
    MODERATION: 'on', MODERATION_QUIET_MS: '300', ...env,
  });
  t.after(async () => { await r.stop(); gemini.close(); ntfy.close(); });
  const held = async () => await (await r.get('/internal/held')).json() as { id: string; removed: boolean; place: string }[];
  return { gemini, ntfy, r, held };
}

test('a bad drawing goes for everyone but its author; a harmless one stays', async t => {
  const { r, ntfy, held } = await setup(t);
  const [bad, good, watcher] = [await r.person(), await r.person(), await r.person()];
  const red = await dab(0.2, 0.5, RED), blue = await dab(0.7, 0.5, BLUE);
  bad.draw(red);
  good.draw(blue);
  await until('both show at first', () => watcher.seen.has(red.id) && watcher.seen.has(blue.id));
  await until('the bad one goes', () => !watcher.seen.has(red.id));
  await wait(500);
  assert.ok(watcher.seen.has(blue.id));
  assert.ok(!bad.messages.some(m => m.t === 'erase'), 'the author is not told');
  const late = await r.person();
  assert.deepEqual([late.seen.has(red.id), late.seen.has(blue.id)], [false, true]);
  assert.deepEqual((await held()).map(h => h.id), [red.id]);
  await until('an alert with a picture', () => ntfy.sent.length);
  assert.match(ntfy.sent[0].title, /removed/);
  assert.ok(ntfy.sent[0].bytes > 1000);
  assert.equal(ntfy.sent.length, 1);
});

test('a wrong removal can be restored, and only from the server itself', async t => {
  const { r, held } = await setup(t);
  const [a, watcher] = [await r.person(), await r.person()];
  const red = await dab(0.2, 0.5, RED);
  a.draw(red);
  await until('it shows', () => watcher.seen.has(red.id));
  await until('it goes', () => !watcher.seen.has(red.id));
  const outside = { headers: { 'x-forwarded-for': '1.2.3.4' } };
  for (const path of ['/internal/held', `/internal/held/${red.id}.jpg`]) assert.equal((await r.get(path, outside)).status, 404);
  assert.equal((await r.get(`/internal/restore/${red.id}`, { method: 'POST', ...outside })).status, 404);
  assert.equal((await r.get(`/internal/held/${red.id}.jpg`)).headers.get('content-type'), 'image/jpeg');
  assert.equal((await r.get(`/internal/restore/${red.id}`, { method: 'POST' })).status, 200);
  await until('it is back', () => watcher.seen.has(red.id));
  assert.equal((await held()).length, 0);
});

test('log mode records but removes nothing', async t => {
  const { r, held } = await setup(t, { MODERATION: 'log' });
  const [a, watcher] = [await r.person(), await r.person()];
  const red = await dab(0.2, 0.5, RED);
  a.draw(red);
  await until('it is recorded', async () => (await held()).length);
  await wait(300);
  assert.ok(watcher.seen.has(red.id));
  assert.equal((await held())[0].removed, false);
});

test('nobody is judged for paint that isn\'t theirs', async t => {
  const { r, gemini } = await setup(t, { MODERATION: 'log' });
  const [a, b] = [await r.person(), await r.person()];
  a.draw(await dab(0.5, 0.5, RED, 300));
  await until('a is checked', () => gemini.calls.length === 1);
  b.draw(await dab(0.5, 0.5, BLUE, 120)); // right on top of it
  await until('b is checked', () => gemini.calls.length === 2);
  for (const picture of gemini.calls[1].pictures) {
    const raw = await sharp(picture).removeAlpha().raw().toBuffer();
    let red = 0;
    for (let i = 0; i < raw.length; i += 3) if (raw[i] > 180 && raw[i + 1] < 90 && raw[i + 2] < 90) red++;
    assert.equal(red, 0, 'no red paint in b\'s pictures');
  }
});

test('drawings far apart are judged separately; a drawing across the seam is one', async t => {
  const { r, gemini, held } = await setup(t, { MODERATION: 'log' });
  const a = await r.person();
  const red = await dab(0.1, 0.5, RED, 40), blue = await dab(0.6, 0.5, BLUE, 400);
  a.draw(red, blue);
  await until('both are checked', () => gemini.calls.length === 2);
  await until('only the red one is flagged', async () => (await held()).length === 1);
  assert.equal((await held())[0].id, red.id);
  const b = await r.person();
  b.draw(await dab(0.985, 0.5, BLUE, 100), await dab(0.005, 0.5, BLUE, 100));
  await until('the seam one is checked', () => gemini.calls.length === 3);
  const { width = 0, height = 0 } = await sharp(gemini.calls[2].pictures[0]).metadata();
  assert.ok(width / height < 4 && width > 300, `picture ${width}x${height}`);
});

test('a small drawing fills its picture', async t => {
  const { r, gemini } = await setup(t, { MODERATION: 'log' });
  const a = await r.person();
  a.draw(await dab(0.5, 0.5, BLUE, 60));
  await until('it is checked', () => gemini.calls.length === 1);
  const raw = await sharp(gemini.calls[0].pictures[0]).removeAlpha().raw().toBuffer();
  let blue = 0;
  for (let i = 0; i < raw.length; i += 3) if (raw[i + 2] > 180 && raw[i] < 120) blue++;
  assert.ok(blue / (raw.length / 3) > 0.15, `${(blue / (raw.length / 3) * 100).toFixed(0)}% paint`);
});

test('someone who never pauses is still checked', async t => {
  const { r, gemini } = await setup(t, { MODERATION_QUIET_MS: '800', MODERATION_MAX_WAIT_MS: '2000' });
  const a = await r.person();
  const started = Date.now();
  while (!gemini.calls.length && Date.now() - started < 10_000) { a.draw(await dab(0.5 + Math.random() * 0.05, 0.5, BLUE, 60)); await wait(250); }
  assert.ok(gemini.calls.length > 0);
});

test('leaving right after drawing doesn\'t skip the check', async t => {
  const { r, held } = await setup(t);
  const a = await r.person();
  a.draw(await dab(0.2, 0.5, RED));
  await wait(100);
  a.leave();
  await until('it is caught', async () => (await held()).length);
});

test('if Gemini is down, drawings stay and someone is told, without leaking secrets', async t => {
  const { r, gemini, ntfy, held } = await setup(t);
  gemini.down = true;
  const [a, watcher] = [await r.person(), await r.person()];
  const red = await dab(0.2, 0.5, RED);
  a.draw(red);
  await until('the check gives up', () => r.log.includes('check failed, allowing'), 25_000);
  assert.ok(watcher.seen.has(red.id));
  assert.equal((await held()).length, 0);
  await until('an alert', () => ntfy.sent.length);
  assert.match(ntfy.sent[0].title, /not being checked/);
  assert.ok(!r.log.includes('test-key') && !r.log.includes('secret-topic'));
});

test('the log never says what was drawn', async t => {
  const { r } = await setup(t);
  const a = await r.person();
  a.draw(await dab(0.2, 0.5, RED));
  await until('it is logged', () => r.log.includes('removed 1 stroke'));
  assert.match(r.log, new RegExp(`${PLACE}: checked 1 stroke`));
  assert.ok(!r.log.includes('red paint') && !r.log.includes('a dab'));
});
