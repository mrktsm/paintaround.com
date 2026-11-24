/**
 * Previews that show a place's drawings. When a room's drawings change, its card and loading
 * images are re-rendered: its paint layer and fresh strokes are pasted onto the panorama (both are
 * baked lit, in panorama coordinates) and projected with the exact same code and views as the
 * original previews (shared/panoramaProjection.mjs). Kept in memory, like the drawings.
 */
import sharp from 'sharp';
import { loadingViewFor, projectRaw, thumbnailViewFor, type View } from '../shared/panoramaProjection.mjs';
import type { FinishedStroke } from '../shared/realtime.ts';
import { strokeOverlays, type PaintLayer } from './layer.ts';

/** Panorama images: the site's copy on the server, or client/public/ when running locally. */
const PANO_DIR = process.env.PANO_DIR ?? new URL('../client/public/panorama-pool/', import.meta.url).pathname;
const SAFE_ID = /^[\w.-]{1,128}$/;
const DEBOUNCE_MS = 6000;

export interface Preview { version: number; card: Buffer; loading: Buffer }
/** what a place currently looks like: its paint layer + strokes not flattened yet */
export interface Drawings { layer: PaintLayer; strokes: FinishedStroke[] }

const previews = new Map<string, Preview>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Set<string>();
/** latest way to read each place's drawings (rendering always uses the current state) */
const sources = new Map<string, () => Drawings>();

export const previewManifest = () => Object.fromEntries([...previews].map(([id, p]) => [id, p.version]));
export const getPreview = (id: string) => previews.get(id);

/** Re-render a place's previews a few seconds after its drawings last changed (batches strokes). */
export function schedulePreview(id: string, drawings: () => Drawings) {
  if (!SAFE_ID.test(id)) return;
  sources.set(id, drawings);
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    // one render at a time per place; if one is running, try again after the debounce
    if (running.has(id)) return schedulePreview(id, drawings);
    void render(id, (sources.get(id) ?? drawings)());
  }, DEBOUNCE_MS));
}

async function render(id: string, { layer, strokes }: Drawings) {
  running.add(id);
  try {
    if (!strokes.length && !layer.tiles.size) { previews.delete(id); return; }
    const base = sharp(`${PANO_DIR}${id}.jpg`).removeAlpha().toColourspace('srgb');
    const { width: W = 0, height: H = 0 } = await base.metadata();
    if (!W || !H) return;
    // the paint layer first (older paint), fresh strokes on top
    const layers = [...await layer.overlays(W, H), ...await strokeOverlays(strokes, W, H)];
    const flat = await base.composite(layers).raw().toBuffer({ resolveWithObject: true });
    const { data, info } = await sharp(flat.data, { raw: flat.info }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const cardView = thumbnailViewFor(id);
    const loadingView = loadingViewFor(id, cardView);
    const toJpeg = (view: View) =>
      sharp(projectRaw(data, info, view), { raw: { width: view.width, height: view.height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
    const [card, loading] = await Promise.all([toJpeg(cardView), toJpeg(loadingView)]);
    previews.set(id, { version: Date.now(), card, loading });
  } catch (e) {
    console.warn(`[previews] ${id}: ${(e as Error).message}`);
  } finally {
    running.delete(id);
  }
}
