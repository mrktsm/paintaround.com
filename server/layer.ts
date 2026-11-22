/**
 * A room's flattened paint layer. Fresh strokes are separate bitmaps (undo / erase work on them);
 * after a while the server bakes them into this layer: a panorama-sized RGBA image at the scale
 * strokes are baked at (PAINT_LAYER), split into tiles, only tiles with paint kept (lossless WebP).
 * People then load a few cached tiles instead of every stroke, and the browser draws a handful of
 * textures instead of hundreds, so a busy place stays fast.
 */
import sharp from 'sharp';
import { PAINT_LAYER, type FinishedStroke, type LayerTiles } from '../shared/realtime.ts';

const { width: LW, height: LH, tile: T } = PAINT_LAYER;
const COLS = LW / T, ROWS = LH / T;

export interface Tile { buf: Buffer; version: number }

/** Where a baked stroke sits on a W x H panorama: its rectangle (baked strokes have axis-aligned grids). */
export function strokeRect(s: FinishedStroke, W: number, H: number) {
  const pts = s.gridBasic.flat();
  const us = pts.map(p => p[0]), vs = pts.map(p => p[1]);
  const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
  return { u0, v0, w: Math.round((u1 - u0) * W), h: Math.round((v1 - v0) * H), top: Math.round(v0 * H) };
}

export const strokeBitmap = (s: FinishedStroke) => Buffer.from(s.image.slice(s.image.indexOf(',') + 1), 'base64');

/**
 * Pieces of a stroke clipped to a rectangle grid: for each cell it touches, the cropped piece and
 * its offset inside the cell. A stroke across the seam (u < 0 or > 1) lands on both sides.
 */
async function strokePieces(s: FinishedStroke, W: number, H: number, cell: number) {
  const { u0, w, h, top } = strokeRect(s, W, H);
  if (w < 1 || h < 1 || w > W || h > H) return [];
  const img = await sharp(strokeBitmap(s)).ensureAlpha().resize(w, h, { fit: 'fill' }).png().toBuffer();
  const out: { key: string; input: Buffer; left: number; top: number }[] = [];
  for (const shift of [-1, 0, 1]) {
    const left = Math.round((u0 + shift) * W);
    const x0 = Math.max(0, left), x1 = Math.min(W, left + w);
    const y0 = Math.max(0, top), y1 = Math.min(H, top + h);
    if (x1 <= x0 || y1 <= y0) continue;
    for (let ty = Math.floor(y0 / cell); ty * cell < y1; ty++) {
      for (let tx = Math.floor(x0 / cell); tx * cell < x1; tx++) {
        const cx0 = Math.max(x0, tx * cell), cx1 = Math.min(x1, (tx + 1) * cell);
        const cy0 = Math.max(y0, ty * cell), cy1 = Math.min(y1, (ty + 1) * cell);
        if (cx1 <= cx0 || cy1 <= cy0) continue;
        const input = await sharp(img).extract({ left: cx0 - left, top: cy0 - top, width: cx1 - cx0, height: cy1 - cy0 }).toBuffer();
        out.push({ key: `${tx}_${ty}`, input, left: cx0 - tx * cell, top: cy0 - ty * cell });
      }
    }
  }
  return out;
}

export class PaintLayer {
  tiles = new Map<string, Tile>();
  bytes = 0;

  manifest(): LayerTiles {
    return Object.fromEntries([...this.tiles].map(([k, t]) => [k, t.version]));
  }

  /** Paint these strokes (oldest first) into the layer. Returns the tiles that changed. */
  async bake(strokes: FinishedStroke[]): Promise<LayerTiles> {
    const perTile = new Map<string, { input: Buffer; left: number; top: number }[]>();
    for (const s of strokes) {
      for (const p of await strokePieces(s, LW, LH, T)) {
        const [tx, ty] = p.key.split('_').map(Number);
        if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) continue;
        const list = perTile.get(p.key) ?? [];
        list.push({ input: p.input, left: p.left, top: p.top });
        perTile.set(p.key, list);
      }
    }
    const changed: LayerTiles = {};
    const version = Date.now();
    for (const [key, overlays] of perTile) {
      const old = this.tiles.get(key);
      const base = old
        ? sharp(old.buf)
        : sharp({ create: { width: T, height: T, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
      // composite in two steps: sharp applies all overlays of one call onto the base
      const buf = await sharp(await base.composite(overlays).png().toBuffer()).webp({ lossless: true }).toBuffer();
      if (old) this.bytes -= old.buf.length;
      this.tiles.set(key, { buf, version });
      this.bytes += buf.length;
      changed[key] = version;
    }
    return changed;
  }

  /** The tiles as overlays for a W x H panorama (previews). */
  async overlays(W: number, H: number): Promise<{ input: Buffer; left: number; top: number }[]> {
    const sx = W / LW, sy = H / LH;
    const out: { input: Buffer; left: number; top: number }[] = [];
    for (const [key, t] of this.tiles) {
      const [tx, ty] = key.split('_').map(Number);
      const left = Math.round(tx * T * sx), top = Math.round(ty * T * sy);
      const w = Math.round((tx + 1) * T * sx) - left, h = Math.round((ty + 1) * T * sy) - top;
      const input = sx === 1 && sy === 1 ? t.buf : await sharp(t.buf).resize(w, h, { fit: 'fill' }).png().toBuffer();
      out.push({ input, left, top });
    }
    return out;
  }

  clear() {
    this.tiles.clear();
    this.bytes = 0;
  }
}

/** Stroke pieces as overlays for a W x H panorama (previews: fresh strokes over the layer). */
export async function strokeOverlays(strokes: FinishedStroke[], W: number, H: number) {
  const out: { input: Buffer; left: number; top: number }[] = [];
  // one "cell" as big as the image: just the seam handling and cropping
  for (const s of strokes) for (const p of await strokePieces(s, W, H, Math.max(W, H))) out.push({ input: p.input, left: p.left, top: p.top });
  return out;
}
