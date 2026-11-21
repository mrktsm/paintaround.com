/** Download the explicit queue produced from official catalogs; do not crawl websites.
 * Usage: node scripts/sample-panorama-pool.mjs [--expanded] [--limit=200] [--id=ph-colosseum]
 */
import { access, mkdir, readFile, rename, statfs, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { renderPanoramaThumbnail } from './lib/panorama-thumbnail.mjs';

const headers = { 'User-Agent': 'IWasHere-PanoramaSampler/1.0 (local noncommercial prototype)' };
const root = new URL('../', import.meta.url);
const cache = new URL('research/panorama-pool/cache/', root);
const output = new URL('public/panorama-pool/', root);
const manifestPath = new URL('src/data/panorama-pool.json', root);
const MAX_SOURCE_BYTES = 64000000;
const pausedHosts = new Set();
const curation = JSON.parse(await readFile(new URL('research/panorama-pool/curation.json',root),'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return '{"excluded":[],"prefer":[]}';
}));
const excluded = new Set(curation.excluded.map(item => item.id));
const candidates = [
  ['colosseum', 'Colosseum', 'Rome, Italy', 'A landmark with stone, cobblestones, fences and strong sun.'],
  ['potsdamer_platz', 'Potsdamer Platz', 'Berlin, Germany', 'Glass towers, benches and broad pavement.'],
  ['dresden_square', 'Dresden Square', 'Dresden, Germany', 'Historic façades, a statue and cobblestones.'],
  ['palermo_square', 'Palermo Square', 'Palermo, Italy', 'A quiet architectural square with nearby drawing surfaces.'],
  ['teufelsberg_inner', 'Teufelsberg', 'Berlin, Germany', 'Graffiti and industrial walls; a close-range surface test.'],
  ['hansaplatz', 'Hansaplatz at night', 'Hamburg, Germany', 'Night lighting, shopfronts and contrasting illumination.'],
  ['schadowplatz', 'Schadowplatz', 'Düsseldorf, Germany', 'Modern façades, glass and plaza pavement.'],
  ['dresden_station_night', 'Dresden Station at night', 'Dresden, Germany', 'Station architecture and artificial lighting.'],
].map(([asset, title, location, appeal]) => ({ id: `ph-${asset}`, provider: 'Poly Haven', asset, title, location, appeal }));
candidates.push(
  { id: 'commons-marche-butte', provider: 'Wikimedia Commons', file: 'Au Marché de la Butte, Paris April 2007.jpg', title: 'Au Marché de la Butte', location: 'Paris, France', appeal: 'Shopfronts and a Paris street corner.', lat: 48.885561, lng: 2.3385 },
  { id: 'commons-brompton', provider: 'Wikimedia Commons', file: 'Brompton Oratory 360x180, London, UK - Diliff.jpg', title: 'Brompton Oratory', location: 'London, United Kingdom', appeal: 'Detailed columns, arches and an ornate interior.', authorCredit: 'DAVID ILIFF', lat: 51.497123, lng: -0.169618 },
);
if (process.argv.includes('--expanded')) {
  const queue = JSON.parse(await readFile(new URL('research/panorama-pool/expanded-candidates.json', root), 'utf8'));
  const ids = new Set(candidates.map(item => item.id));
  for (const candidate of queue.candidates) {
    if (!ids.has(candidate.id)) { candidates.push(candidate); ids.add(candidate.id); }
  }
}

async function fetchBytes(url) {
  const host = new URL(url).hostname;
  if (pausedHosts.has(host)) throw new Error(`Deferred ${host}: provider rate limit`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(120000) });
      if (response.status === 429) {
        pausedHosts.add(host);
        throw new Error(`Deferred ${host}: HTTP 429; provider paused for this run`);
      }
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      if (Number(response.headers.get('content-length')) > MAX_SOURCE_BYTES) throw new Error('Image exceeds the 64 MB per-source budget');
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (pausedHosts.has(host)) throw error;
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}
async function cachedJSON(name, url) {
  const path = new URL(`${name}.json`, cache);
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { /* fetch first snapshot */ }
  const bytes = await fetchBytes(url);
  const data = JSON.parse(bytes);
  await writeFile(path, JSON.stringify(data, null, 2));
  return data;
}
const plain = value => (value || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
await Promise.all([mkdir(new URL('inputs/', cache), { recursive: true }), mkdir(output, { recursive: true })]);
let previous = { version: 1, items: [] };
try { previous = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { /* new pool */ }
const items = new Map(previous.items.filter(item => !excluded.has(item.id)).map(item => [item.id, item]));
const only = process.argv.find(arg => arg.startsWith('--id='))?.slice(5);
const limitArg = process.argv.find(arg => arg.startsWith('--limit='))?.slice(8);
const limit = limitArg ? Number(limitArg) : Infinity;
if (!(limit > 0)) throw new Error('--limit must be a positive number');
let failures = 0;
const deferred = [], rejected = [];
async function sample(candidate) {
    let source;
    if (candidate.provider === 'Poly Haven') {
      const [info, files] = await Promise.all([
        candidate.metadata || cachedJSON(`${candidate.id}-info`, `https://api.polyhaven.com/info/${candidate.asset}`),
        cachedJSON(`${candidate.id}-files`, `https://api.polyhaven.com/files/${candidate.asset}`),
      ]);
      if (!files.tonemapped?.url) throw new Error('No original tonemapped panorama');
      if (files.tonemapped.size > MAX_SOURCE_BYTES) throw new Error('Original exceeds the 64 MB per-source budget');
      source = {
        sourceUrl: `https://polyhaven.com/a/${candidate.asset}`,
        downloadUrl: files.tonemapped.url,
        expectedMd5: files.tonemapped.md5,
        author: Object.entries(info.authors).filter(([, role]) => /All|HDRI/i.test(role)).map(([name]) => name).join(', ') || Object.keys(info.authors).join(', '),
        license: 'CC0-1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
        licenseEvidence: 'https://polyhaven.com/license',
        latitude: info.coords?.[0] ?? null, longitude: info.coords?.[1] ?? null,
        capturedAt: info.date_taken ? info.date_taken * 1000 : null,
        availableHdrResolution: info.max_resolution,
        hdrDownloadUrl: files.hdri?.['4k']?.exr?.url ?? null,
      };
    } else {
      const query = new URLSearchParams({ action: 'query', format: 'json', prop: 'imageinfo', iiprop: 'url|size|extmetadata', titles: `File:${candidate.file}` });
      const data = candidate.commonsInfo ? null : await cachedJSON(candidate.id, `https://commons.wikimedia.org/w/api.php?${query}`);
      const info = candidate.commonsInfo || Object.values(data.query.pages)[0].imageinfo?.[0];
      if (!info) throw new Error('Commons original unavailable');
      const meta = info.extmetadata;
      const license = plain(meta.LicenseShortName?.value);
      if (!/^CC (BY|BY-SA) /i.test(license) && license !== 'CC0') throw new Error(`Unreviewed license: ${license}`);
      source = {
        sourceUrl: info.descriptionurl, downloadUrl: info.url,
        author: candidate.authorCredit || plain(meta.Artist?.value), license, licenseUrl: meta.LicenseUrl?.value,
        licenseEvidence: info.descriptionurl,
        latitude: meta.GPSLatitude?.value ? Number(meta.GPSLatitude.value) : candidate.lat ?? null,
        longitude: meta.GPSLongitude?.value ? Number(meta.GPSLongitude.value) : candidate.lng ?? null,
        capturedAt: null, availableHdrResolution: null, hdrDownloadUrl: null,
      };
    }
    const originalPath = new URL(`${candidate.id}-original.jpg`, cache);
    let bytes;
    try { bytes = await readFile(originalPath); } catch {
      const space = await statfs(root.pathname);
      if (space.bavail * space.bsize < 1200000000) throw new Error('Deferred: preserving 1.2 GB of free disk space');
      bytes = await fetchBytes(source.downloadUrl);
      await writeFile(originalPath, bytes);
    }
    if (source.expectedMd5 && createHash('md5').update(bytes).digest('hex') !== source.expectedMd5) throw new Error('Source checksum mismatch');
    const dimensions = await sharp(bytes, { limitInputPixels: 300000000 }).metadata();
    if (!dimensions.width || !dimensions.height || dimensions.width < 6000 || dimensions.width !== dimensions.height * 2) throw new Error(`Not a high-resolution 2:1 candidate: ${dimensions.width}×${dimensions.height}`);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if ([...items.values()].some(item => item.id !== candidate.id && item.sha256 === hash)) throw new Error('Duplicate original already in pool');
    await sharp(bytes).resize({ width: 4096, withoutEnlargement: true }).jpeg({ quality: 92 }).toFile(new URL(`${candidate.id}.jpg`, output).pathname);
    await sharp(bytes).resize({ width: 2048 }).jpeg({ quality: 95 }).toFile(new URL(`inputs/${candidate.id}.jpg`, cache).pathname);
    await sharp(bytes).resize({ width: 800 }).jpeg({ quality: 80 }).toFile(new URL(`${candidate.id}-preview.jpg`, output).pathname);
    const thumbnailView = await renderPanoramaThumbnail(new URL(`${candidate.id}.jpg`,output).pathname,new URL(`${candidate.id}-card.jpg`,output).pathname,candidate.id);
    const old = items.get(candidate.id);
    const entry = {
      id: candidate.id, title: candidate.title, location: candidate.location, appeal: candidate.appeal,
      category: candidate.category || (/Teufelsberg/.test(candidate.title) ? 'Industrial & ruins' : /Oratory/.test(candidate.title) ? 'Churches & heritage' : /Station/.test(candidate.title) ? 'Interiors & culture' : 'Streets & squares'),
      country: candidate.country || candidate.location.split(', ').at(-1),
      provider: candidate.provider, ...source, originalWidth: dimensions.width, originalHeight: dimensions.height,
      width: Math.min(4096, dimensions.width), height: Math.min(2048, dimensions.height),
      projection: 'equirectangular', coverage: '360x180',
      imageUrl: `/panorama-pool/${candidate.id}.jpg`, previewUrl: `/panorama-pool/${candidate.id}-preview.jpg`,
      thumbnailUrl: `/panorama-pool/${candidate.id}-card.jpg`, thumbnailView,
      sha256: hash,
      modifications: 'Resized and JPEG compressed; original color rendering preserved.',
      processing: old?.processing ?? { depth: 'pending', lighting: 'pending' },
      sampledAt: old?.sampledAt ?? new Date().toISOString(),
      review: 'candidate: dimensions checked; visual stitching and surface quality require review',
    };
    console.log(`Sampled ${candidate.id}: ${dimensions.width}×${dimensions.height}, ${source.license}`);
    return entry;
}
async function checkpoint() {
  const temporary = new URL('src/data/panorama-pool.json.tmp', root);
  await writeFile(temporary, JSON.stringify({ version: 1, items: [...items.values()] }, null, 2) + '\n');
  await rename(temporary, manifestPath);
}
let pending = [];
for (const candidate of candidates.filter(item => !excluded.has(item.id) && (!only || item.id === only))) {
  if (process.argv.includes('--expanded') && !only && items.has(candidate.id)) {
    try {
      await Promise.all([candidate.id+'.jpg', candidate.id+'-preview.jpg', candidate.id+'-card.jpg'].map(name => access(new URL(name, output))));
      const old = items.get(candidate.id);
      items.set(candidate.id, { ...old, title: candidate.title, location: candidate.location, appeal: candidate.appeal,
        category: candidate.category || old.category || (/Teufelsberg/.test(candidate.title) ? 'Industrial & ruins' : /Oratory/.test(candidate.title) ? 'Churches & heritage' : /Station/.test(candidate.title) ? 'Interiors & culture' : 'Streets & squares'),
        country: candidate.country || old.country || candidate.location.split(', ').at(-1) });
      continue;
    } catch { /* restore missing generated images */ }
  }
  pending.push(candidate);
}
const preferred = new Set(curation.prefer);
pending.sort((a,b) => Number(preferred.has(b.id)) - Number(preferred.has(a.id)));
while (pending.length && (only || items.size < limit)) {
  const batch = pending.splice(0, Math.min(2, only ? 2 : limit - items.size));
  const results = await Promise.allSettled(batch.map(sample));
  for (let i=0; i<results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') items.set(result.value.id, result.value);
    else {
      const reason = result.reason.message;
      if (reason.startsWith('Deferred')) deferred.push({ id: batch[i].id, reason });
      else if (/budget|candidate|Duplicate original/.test(reason)) rejected.push({ id: batch[i].id, reason });
      else failures++;
      console.error(`${reason.startsWith('Deferred') ? 'Deferred' : 'Rejected/failed'} ${batch[i].id}: ${reason}`);
    }
  }
  await checkpoint();
}
await checkpoint();
await writeFile(new URL('research/panorama-pool/cache/ingestion-report.json',root),JSON.stringify({completedAt:new Date().toISOString(),target:Number.isFinite(limit)?limit:null,total:items.size,failures,deferred,rejected},null,2)+'\n');
console.log(`${items.size} local panoramas. ${failures} failures, ${deferred.length} deferred, ${rejected.length} rejected.`);
if (failures || (Number.isFinite(limit) && items.size < limit) || (only && !candidates.some(item => item.id === only))) process.exitCode = 1;
