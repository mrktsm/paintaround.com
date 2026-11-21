// Bake reviewed lighting once; the drawing app only downloads the finished
// multiplier and samples it on the GPU. Requires Node with native TS support.
// Usage: npm run paint:materials -- ph-colosseum
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { restoreSurfaceLighting } from '../src/deep/paintLighting.ts';

const root = new URL('../', import.meta.url);
const manifestPath = new URL('src/data/paint-materials.json', root);
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const catalog = JSON.parse(await fs.readFile(new URL('src/data/panorama-pool.json', root), 'utf8'));
const ids = process.argv.slice(2);
if (!ids.length) throw new Error('Specify the reviewed panorama IDs to export.');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
for (const id of ids) {
  const panorama = catalog.items.find(value => value.id === id);
  if (!panorama) throw new Error(`Unknown panorama: ${id}`);
  const directory = new URL(`public/deep-layers/${id}/`, root);
  const sourceHash = hash(await fs.readFile(new URL(`public${panorama.imageUrl}`, root)));
  const readJson = name => fs.readFile(new URL(name, directory), 'utf8').then(JSON.parse, () => null);
  const read = async (name, channels = 1) => {
    const bytes = await fs.readFile(new URL(`${name}.f32`, directory));
    if (bytes.byteLength !== 2048 * 1024 * 4 * channels) throw new Error(`${id}: invalid ${name} dimensions.`);
    const values = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error(`${id}: invalid ${name} values.`);
    return values;
  };
  // Best reviewed lighting first: full 360° merge (merge_view_lighting.py), then the
  // single coloured view (color_view_lighting.py), then the single grey view.
  const sources = [
    { grey: 'shading-360', rgb: 'shading-360-rgb', meta: 'shading-360.json' },
    { grey: 'shading-view', rgb: 'shading-view-rgb', meta: 'shading-view-rgb.f32.json' },
    { grey: 'shading-view', rgb: null, meta: 'shading-view.json' },
  ];
  let chosen = null, metadata = null;
  for (const candidate of sources) if ((metadata = await readJson(candidate.meta))) { chosen = candidate; break; }
  if (!chosen) throw new Error(`${id}: no reviewed lighting found.`);
  if (metadata.source_sha256 !== sourceHash) throw new Error(`${id}: lighting belongs to a different photo.`);
  let refined = await read(chosen.grey);
  if (chosen.rgb) {
    const rgb = await read(chosen.rgb, 3);
    for (let p = 0; p < refined.length; p++) {
      const mean = (rgb[p * 3] + rgb[p * 3 + 1] + rgb[p * 3 + 2]) / 3;
      if (Math.abs(mean - refined[p]) > 1e-3 * Math.max(1, refined[p])) throw new Error(`${id}: colour lighting brightness differs from its grey map.`);
    }
    refined = rgb;
  }
  const [shade, surface] = await Promise.all(['shading', 'surface'].map(name => read(name)));
  const material = restoreSurfaceLighting(shade, surface, refined);
  const bytes = Buffer.from(material.buffer);
  const filename = `surface-${hash(bytes).slice(0, 12)}.f32`;
  await fs.writeFile(new URL(filename, directory), bytes);
  manifest[id] = { surface: filename, sourceSha256: sourceHash, lighting: chosen.rgb ?? chosen.grey, channels: chosen.rgb ? 3 : 1, coverageFraction: metadata.solid_covered_fraction ?? metadata.coverage_fraction };
  console.log(`${id}: ${fileURLToPath(new URL(filename, directory))}`);
}
await fs.writeFile(manifestPath, JSON.stringify(Object.fromEntries(Object.entries(manifest).sort()), null, 2) + '\n');
