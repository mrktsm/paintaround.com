/**
 * Tell the app about places' 3D data: reads each place's meta.json (from build_layers.py) and writes
 * its entry in client/src/data/paint-materials.json.
 * Usage: node pipeline/3d/add-to-catalog.mjs LAYERS_DIR   (a folder with <id>/meta.json)
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const layers = process.argv[2];
if (!layers) throw new Error('usage: node pipeline/3d/add-to-catalog.mjs LAYERS_DIR');
const catalog = new URL('../../client/src/data/paint-materials.json', import.meta.url);
const materials = JSON.parse(await readFile(catalog, 'utf8'));
let added = 0;
for (const id of await readdir(layers)) {
  const path = join(layers, id, 'meta.json');
  if (!existsSync(path)) continue;
  const meta = JSON.parse(await readFile(path, 'utf8'));
  if (!meta.surface || !existsSync(join(layers, id, meta.surface))) throw new Error(`${id}: no lighting file`);
  materials[id] = {
    surface: meta.surface, sourceSha256: meta.source_sha256, depth: meta.depth, lighting: '360 views, colour',
    channels: 3, format: 'f16', coverageFraction: meta.coverage_fraction,
  };
  added++;
}
await writeFile(catalog, JSON.stringify(Object.fromEntries(Object.entries(materials).sort()), null, 2) + '\n');
console.log(`${added} places`);
