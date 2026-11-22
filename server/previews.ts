/**
 * Previews that show a place's drawings. When a room's strokes change, its card and loading
 * images are re-rendered: the strokes are pasted onto the panorama (they're baked lit, in
 * panorama coordinates) and projected with the exact same code and views as the original
 * previews (shared/panoramaProjection.mjs). Kept in memory, like the strokes themselves.
 */
import sharp from 'sharp';
import { loadingViewFor, projectRaw, thumbnailViewFor, type View } from '../shared/panoramaProjection.mjs';
import type { FinishedStroke } from '../shared/realtime.ts';

/** Panorama images: the site's copy on the server, or public/ when running locally. */
const PANO_DIR = process.env.PANO_DIR ?? new URL('../public/panorama-pool/', import.meta.url).pathname;
const SAFE_ID = /^[\w.-]{1,128}$/;
const DEBOUNCE_MS = 6000;

export interface Preview { version: number; card: Buffer; loading: Buffer }
const previews = new Map<string, Preview>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Set<string>();
/** latest way to read each place's strokes (rendering always uses the current set) */
const sources = new Map<string, () => FinishedStroke[]>();

export const previewManifest = () => Object.fromEntries([...previews].map(([id, p]) => [id, p.version]));
export const getPreview = (id: string) => previews.get(id);

/** Re-render a place's previews a few seconds after its drawings last changed (batches strokes). */
export function schedulePreview(id: string, strokes: () => FinishedStroke[]) {
  if (!SAFE_ID.test(id)) return;
  sources.set(id, strokes);
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    // one render at a time per place; if one is running, try again after the debounce
    if (running.has(id)) return schedulePreview(id, strokes);
    void render(id, (sources.get(id) ?? strokes)());
  }, DEBOUNCE_MS));
}

async function render(id: string, strokes: FinishedStroke[]) {
  running.add(id);
  try {
    if (!strokes.length) { previews.delete(id); return; }
    const base = sharp(`${PANO_DIR}${id}.jpg`).removeAlpha().toColourspace('srgb');
    const { width: W = 0, height: H = 0 } = await base.metadata();
    if (!W || !H) return;
    // paste every stroke at its panorama rectangle (baked strokes have an axis-aligned grid);
    // a stroke crossing the seam is pasted on both sides
    const layers: sharp.OverlayOptions[] = [];
    for (const s of strokes) {
      const pts = s.gridBasic.flat();
      const us = pts.map(p => p[0]), vs = pts.map(p => p[1]);
      const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
      const w = Math.round((u1 - u0) * W), h = Math.round((v1 - v0) * H);
      if (w < 1 || h < 1 || w > W || h > H) continue;
      const img = await sharp(Buffer.from(s.image.slice(s.image.indexOf(',') + 1), 'base64'))
        .ensureAlpha().resize(w, h, { fit: 'fill' }).png().toBuffer();
      const top = Math.round(v0 * H);
      for (const shift of [-1, 0, 1]) {
        const left = Math.round((u0 + shift) * W);
        if (left + w <= 0 || left >= W) continue;
        // sharp needs overlays inside the image: crop the part that sticks out
        const cx = Math.max(0, -left), cy = Math.max(0, -top);
        const cw = Math.min(w, W - left) - cx, chh = Math.min(h, H - top) - cy;
        if (cw < 1 || chh < 1) continue;
        const input = cx || cy || cw !== w || chh !== h
          ? await sharp(img).extract({ left: cx, top: cy, width: cw, height: chh }).toBuffer()
          : img;
        layers.push({ input, left: left + cx, top: top + cy });
      }
    }
    const { data, info } = await base.composite(layers).raw().toBuffer({ resolveWithObject: true })
      .then(r => sharp(r.data, { raw: r.info }).removeAlpha().raw().toBuffer({ resolveWithObject: true }));
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
