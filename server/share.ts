/**
 * Shared links: a picture of the place from where someone was looking, with its drawings (only the
 * ones that passed moderation, like the previews), and the page that tells chat apps about it.
 * Nothing is stored: the link says where to look, and the picture is made when it's asked for.
 */
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import { placeNames } from '../shared/placePath.ts';
import { projectRaw, thumbnailViewFor } from '../shared/panoramaProjection.mjs';
import { formatAt, shareCamera, type LookingAt } from '../shared/shareView.ts';
import { START_ZOOM } from '../shared/startView.ts';
import { paintedPanorama, type Drawings } from './previews.ts';

interface Place { id: string; title: string; location: string; thumbnailView?: { u: number; v: number } }
const places = new Map<string, Place>(
  (JSON.parse(readFileSync(new URL('../shared/panorama-pool.json', import.meta.url), 'utf8')) as { items: Place[] }).items.map(p => [p.id, p]),
);
export const isPlace = (id: string) => places.has(id);
const names = placeNames([...places.values()]);
const ids = new Map([...names].map(([id, name]) => [name, id]));
/** The place at an address (/colosseum), if there is one. */
export const placeNamed = (name: string) => ids.get(name) ?? '';

/** The built site (its index.html is the page). */
const SITE_DIR = process.env.SITE_DIR ?? new URL('../dist/', import.meta.url).pathname;
const MAX_PER_MINUTE = Number(process.env.SHARE_MAX_PER_MINUTE ?? 60);
const MAX_WAITING = 6;
const PICTURES = 150, PANORAMAS = 2; // kept in memory: about 25 MB and 50 MB

const startView = (id: string): LookingAt => {
  const { u, v } = places.get(id)?.thumbnailView ?? thumbnailViewFor(id);
  return { u, v, zoom: START_ZOOM };
};

/** Remember the latest few. */
function keep<T>(map: Map<string, T>, key: string, value: T, max: number): T {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value!);
  return value;
}

const pictures = new Map<string, Buffer>();
const making = new Map<string, Promise<Buffer | null>>();
const panoramas = new Map<string, NonNullable<Awaited<ReturnType<typeof paintedPanorama>>>>();
let queue: Promise<unknown> = Promise.resolve();
let recent: number[] = [];

/** The picture for a link (null: too many at once, or it can't be made). `changed`: when its drawings last did. */
export function sharePicture(id: string, at: LookingAt | null, changed: number, drawings: () => Drawings | null): Promise<Buffer | null> {
  const view = at ?? startView(id), key = `${id} ${formatAt(view)} ${changed}`;
  const known = pictures.get(key);
  if (known) return Promise.resolve(keep(pictures, key, known, PICTURES));
  const already = making.get(key);
  if (already) return already;
  const now = Date.now();
  recent = recent.filter(t => now - t < 60_000);
  if (recent.length >= MAX_PER_MINUTE || making.size >= MAX_WAITING) return Promise.resolve(null);
  recent.push(now);
  // one at a time: drawing together must not wait for it
  const picture = queue.then(() => make(id, view, `${id} ${changed}`, drawings)).then(
    jpeg => jpeg && keep(pictures, key, jpeg, PICTURES),
    e => { console.warn(`[share] ${id}: ${(e as Error).message}`); return null; },
  );
  making.set(key, picture);
  queue = picture.finally(() => making.delete(key));
  return picture;
}

async function make(id: string, view: LookingAt, panoramaKey: string, drawings: () => Drawings | null): Promise<Buffer | null> {
  const known = panoramas.get(panoramaKey), painted = known ?? await paintedPanorama(id, drawings());
  if (!painted) return null;
  keep(panoramas, panoramaKey, painted, PANORAMAS);
  const camera = shareCamera(view);
  return sharp(projectRaw(painted.data, painted.info, camera), { raw: { width: camera.width, height: camera.height, channels: 3 } }).jpeg({ quality: 86 }).toBuffer();
}

const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
let page: { html: string; modified: number } | null = null;

async function indexHtml(): Promise<string> {
  const file = `${SITE_DIR.replace(/\/?$/, '/')}index.html`, { mtimeMs: modified } = await stat(file);
  if (page?.modified !== modified) page = { html: await readFile(file, 'utf8'), modified };
  return page.html;
}

/** The site's page for a place, with its title and picture for chat apps (null: the site isn't there). */
export async function placePage(id: string, at: LookingAt | null, changed: number, origin: string): Promise<string | null> {
  let html: string;
  try {
    html = await indexHtml();
  } catch (e) {
    console.warn(`[share] page: ${(e as Error).message}`);
    return null;
  }
  const place = places.get(id);
  if (!place) return html;
  const where = place.location === 'Location not recorded' ? '' : `${place.location.replace(/^Near /, '').replace(/, Location recorded$/, '')}. `;
  const picture = `${origin}/api/share/${id}.jpg?v=${changed}${at ? `&at=${formatAt(at)}` : ''}`;
  const set = (name: string, content: string) => {
    html = html.replace(new RegExp(`(<meta (?:property|name)="${name}" content=")[^"]*`), (_, start: string) => start + escape(content));
  };
  for (const name of ['og:title', 'twitter:title']) set(name, place.title);
  for (const name of ['og:description', 'twitter:description', 'description']) set(name, `${where}Draw on it, live with other people.`);
  set('og:url', `${origin}/${names.get(id)}${at ? `?at=${formatAt(at)}` : ''}`);
  return html.replace('<title>paintaround.com</title>', `<title>${escape(place.title)} · paintaround.com</title>`).replace('</head>', () => [
    `<meta property="og:image" content="${escape(picture)}" />`,
    '<meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />',
    `<meta name="twitter:image" content="${escape(picture)}" />`,
    // it's also what's shown while the place loads
    ...(at ? [`<link rel="preload" as="image" fetchpriority="high" href="${escape(`/api/share/${id}.jpg?at=${formatAt(at)}`)}" />`] : []),
    '</head>',
  ].join('\n'));
}
