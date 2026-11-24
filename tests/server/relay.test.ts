import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { dab, panoDir, relay, until, wait, PLACE } from './helpers.ts';

test('people in a place see each other\'s strokes, and people elsewhere don\'t', async t => {
  const r = await relay({ PANO_DIR: await panoDir() });
  t.after(r.stop);
  const [a, b, elsewhere] = [await r.person(), await r.person(), await r.person('another-place')];
  const s = await dab(0.5, 0.5, '#0000ff');
  a.draw(s);
  await until('b sees it', () => b.seen.has(s.id));
  await wait(150);
  assert.ok(!elsewhere.seen.has(s.id));
  assert.ok(!a.seen.has(s.id), 'your own stroke is not sent back');

  const late = await r.person();
  assert.ok(late.seen.has(s.id), 'someone arriving later gets it');
  a.send({ t: 'erase', ids: [s.id] });
  await until('it goes for everyone', () => !b.seen.has(s.id) && !late.seen.has(s.id));
});

test('drawings stay when everyone leaves', async t => {
  const r = await relay({ PANO_DIR: await panoDir() });
  t.after(r.stop);
  const a = await r.person(), s = await dab(0.5, 0.5, '#0000ff');
  a.draw(s);
  await wait(200);
  a.leave();
  await wait(200);
  assert.ok((await r.person()).seen.has(s.id));
});

test('nonsense and strangers are refused', async t => {
  const r = await relay({ PANO_DIR: await panoDir() });
  t.after(r.stop);
  await assert.rejects(r.person(PLACE, 'https://evil.example'));
  const [a, b] = [await r.person(), await r.person()];
  const good = await dab(0.5, 0.5, '#0000ff');
  a.ws.send('not json');
  a.draw({ ...good, id: 'bad-image', image: 'javascript:alert(1)' }, { ...good, id: 'bad-grid', gridBasic: [] }, { ...good, id: 'x'.repeat(100) });
  a.draw(good);
  await until('the good one arrives', () => b.seen.has(good.id));
  assert.deepEqual([...b.seen], [good.id]);
});

test('previews show the drawings, and older strokes become paint-layer tiles', async t => {
  const r = await relay({ PANO_DIR: await panoDir(), FLATTEN_AFTER_MS: '300' });
  t.after(r.stop);
  const [a, b] = [await r.person(), await r.person()];
  const s = await dab(0.75, 0.5, '#00ff00', 400);
  a.draw(s);
  await until('it is flattened', () => b.messages.some(m => m.t === 'flattened' && m.ids.includes(s.id)));
  const late = await r.person();
  assert.ok(!late.seen.has(s.id) && late.welcome?.layer, 'newcomers get tiles instead of the stroke');
  const [key, version] = Object.entries(late.welcome.layer)[0];
  const tile = await r.get(`/api/layer/${PLACE}/${key}?v=${version}`);
  assert.equal(tile.headers.get('content-type'), 'image/webp');

  await until('a preview exists', async () => PLACE in (await (await r.get('/api/previews')).json() as object));
  const card = await r.get(`/api/previews/${PLACE}/card`);
  assert.equal(card.status, 200);
  const { channels } = await sharp(Buffer.from(await card.arrayBuffer())).stats();
  assert.ok(channels[1].max > 200 && channels[0].min < 80, 'the green paint is in the picture');
});

test('a stroke across the panorama\'s seam lands on both sides', async t => {
  const r = await relay({ PANO_DIR: await panoDir(), FLATTEN_AFTER_MS: '300' });
  t.after(r.stop);
  const a = await r.person();
  a.draw(await dab(0.97, 0.5, '#00ff00', 300));
  await until('it is flattened', () => a.messages.some(m => m.t === 'flattened'));
  const columns = new Set(a.messages.flatMap(m => m.t === 'flattened' ? Object.keys(m.tiles) : []).map(k => k.split('_')[0]));
  assert.ok(columns.has('7') && columns.has('0'), `tiles in columns ${[...columns]}`);
});
