/**
 * Download places' photos from where they were published and make the sizes the app needs.
 * Usage: npm run photos                   a few places to start with
 *        npm run photos -- ph-colosseum   these places
 *        npm run photos -- --all          all of them (large: the originals are up to 64 MB each)
 * Photos that are already there are skipped. Nothing in the catalog changes.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { renderPanoramaLoadingPreview, renderPanoramaThumbnail } from '../shared/panoramaProjection.mjs';

const STARTERS = ['ph-colosseum', 'ph-palermo_square', 'ph-piazza_san_marco', 'ph-vatican_road', 'ph-circus_maximus_1', 'ph-belvedere'];
const root = new URL('../', import.meta.url);
const folder = new URL('public/panorama-pool/', root);
const { items } = JSON.parse(await readFile(new URL('src/data/panorama-pool.json', root), 'utf8'));
const file = name => new URL(name, folder).pathname;

async function fetchPhoto({ id, downloadUrl, sha256, thumbnailView }) {
  const response = await fetch(downloadUrl, { headers: { 'User-Agent': 'panorama-fetcher/1.0' }, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const original = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(original).digest('hex') !== sha256) throw new Error('not the photo the catalog was made with (checksum)');
  const photo = () => sharp(original, { limitInputPixels: 300_000_000 });
  await photo().resize({ width: 800 }).jpeg({ quality: 80 }).toFile(file(`${id}-preview.jpg`));
  const full = file(`${id}.jpg`);
  await photo().resize({ width: 4096, withoutEnlargement: true }).jpeg({ quality: 92 }).toFile(full);
  await renderPanoramaThumbnail(full, file(`${id}-card.jpg`), id);
  await renderPanoramaLoadingPreview(full, file(`${id}-loading.jpg`), id, thumbnailView); // last: marks it complete
}

const args = process.argv.slice(2);
const ids = args.includes('--all') ? items.map(i => i.id) : args.length ? args : STARTERS;
await mkdir(folder, { recursive: true });
let failed = 0;
for (const [n, id] of ids.entries()) {
  const item = items.find(i => i.id === id);
  const label = `${n + 1}/${ids.length} ${id}`;
  if (item && existsSync(file(`${id}-loading.jpg`))) {
    console.log(`${label}: already here`);
    continue;
  }
  try {
    if (!item) throw new Error('not in src/data/panorama-pool.json');
    await fetchPhoto(item);
    console.log(`${label}: done (${item.license}, ${item.author})`);
  } catch (e) {
    failed++;
    console.error(`${label}: ${e.message}`);
  }
}
if (failed) process.exitCode = 1;
