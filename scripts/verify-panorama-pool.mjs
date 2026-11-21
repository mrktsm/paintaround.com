/** Check actual local assets and provenance, then generate contact sheets for visual review. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const root = new URL('../', import.meta.url);
const pool = JSON.parse(await readFile(new URL('src/data/panorama-pool.json', root), 'utf8'));
const ids = new Set(), hashes = new Set();
for (const item of pool.items) {
  if (ids.has(item.id) || hashes.has(item.sha256)) throw new Error(`Duplicate: ${item.id}`);
  ids.add(item.id); hashes.add(item.sha256);
  if (!item.author || !item.sourceUrl || !item.licenseUrl || !item.licenseEvidence) throw new Error(`Missing provenance: ${item.id}`);
  if (item.license !== 'CC0-1.0' && !/^CC (BY|BY-SA) /.test(item.license)) throw new Error(`Unsupported license: ${item.id}`);
  const bytes = await readFile(new URL(`research/panorama-pool/cache/${item.id}-original.jpg`, root));
  if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error(`Original checksum: ${item.id}`);
  const original = await sharp(bytes, { limitInputPixels: 300000000 }).metadata();
  if (original.width !== item.originalWidth || original.height !== item.originalHeight || original.width !== 2*original.height || original.width < 6000) throw new Error(`Original dimensions: ${item.id}`);
  for (const [path, width, height] of [
    [item.imageUrl.slice(1), item.width, item.height],
    [item.previewUrl.slice(1), 800, 400],
    ...(item.thumbnailUrl ? [[item.thumbnailUrl.slice(1), 800, 600]] : []),
  ]) {
    const meta = await sharp(new URL(`public/${path}`, root).pathname).metadata();
    if (meta.width !== width || meta.height !== height) throw new Error(`Derivative dimensions: ${item.id}`);
  }
  const input = await sharp(new URL(`research/panorama-pool/cache/inputs/${item.id}.jpg`, root).pathname).metadata();
  if (input.width !== 2048 || input.height !== 1024) throw new Error(`Processing input: ${item.id}`);
}
const output = new URL('research/panorama-pool/review/', root);
await mkdir(output, { recursive: true });
const escape = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const perPage = 30, columns = 5, tileWidth = 320, tileHeight = 215;
for (let offset=0; offset<pool.items.length; offset+=perPage) {
  const batch = pool.items.slice(offset, offset+perPage);
  const layers = [];
  for (let i=0; i<batch.length; i++) {
    const item=batch[i], left=(i%columns)*tileWidth, top=Math.floor(i/columns)*tileHeight;
    const image=await sharp(new URL(`public${item.previewUrl}`,root).pathname).resize(tileWidth,160).toBuffer();
    layers.push({ input:image, left, top });
    const label=`<svg width="320" height="55"><rect width="320" height="55" fill="#f8f7f3"/><text x="7" y="18" fill="#243026" font-family="sans-serif" font-size="12">${offset+i+1}. ${escape(item.title.slice(0,43))}</text><text x="7" y="35" fill="#526652" font-family="sans-serif" font-size="10">${escape(item.location.slice(0,48))}</text><text x="7" y="49" fill="#526652" font-family="sans-serif" font-size="9">${escape(item.id)}</text></svg>`;
    layers.push({ input:Buffer.from(label), left, top:top+160 });
  }
  await sharp({create:{width:columns*tileWidth,height:Math.ceil(batch.length/columns)*tileHeight,channels:3,background:'#f8f7f3'}}).composite(layers).jpeg({quality:85}).toFile(new URL(`sheet-${String(offset/perPage+1).padStart(2,'0')}.jpg`,output).pathname);
}
const byProvider={}, byCountry={}, byCategory={};
for (const item of pool.items) {
  byProvider[item.provider]=(byProvider[item.provider]||0)+1;
  byCountry[item.country||item.location.split(', ').at(-1)]=(byCountry[item.country||item.location.split(', ').at(-1)]||0)+1;
  byCategory[item.category||'Uncategorized']=(byCategory[item.category||'Uncategorized']||0)+1;
}
const report={verifiedAt:new Date().toISOString(),count:pool.items.length,byProvider,byCountry,byCategory,checks:['unique IDs and original hashes','original SHA-256 matches downloaded bytes','original dimensions >=6000px and exactly 2:1','4K, 800px and 2K derivatives decode at expected dimensions','source, author, license and evidence recorded'],visualReview:'Contact sheets generated; individual sphere seams, nadir and stitch quality are not certified.'};
await writeFile(new URL('verification.json',output),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
