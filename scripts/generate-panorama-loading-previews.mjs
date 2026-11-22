import { readFile } from 'node:fs/promises';
import { renderPanoramaLoadingPreview } from '../shared/panoramaProjection.mjs';

const root = new URL('../', import.meta.url);
const pool = JSON.parse(await readFile(new URL('src/data/panorama-pool.json', root), 'utf8'));
for (const [index, item] of pool.items.entries()) {
  await renderPanoramaLoadingPreview(
    new URL(`public${item.imageUrl}`, root).pathname,
    new URL(`public/panorama-pool/${item.id}-loading.jpg`, root).pathname,
    item.id,
    item.thumbnailView,
  );
  if ((index + 1) % 20 === 0) console.log(`Rendered ${index + 1}/${pool.items.length} loading previews`);
}
console.log('Loading previews generated; regular card previews unchanged.');
