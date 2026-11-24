/**
 * "Keep shadows" for every drawing tool.
 *
 * Each panorama can have a precomputed *surface* map (interleaved linear RGB, so
 * paint in sky-lit shade turns slightly cool and in sun slightly warm). Reviewed refinements use
 * full-strength lighting with subtle detail (see pipeline/3d).
 * Older panoramas retain their original shading^0.3 * detail^0.6 map.
 *   shading – light/shadow from an intrinsic decomposition
 *   detail  – image luminance relative to its local average (mortar lines, cracks, roughness)
 * Multiplying paint by it makes strokes look painted onto the surface instead of stuck on top.
 *
 * Used twice:
 *  - while drawing: the live stroke is shaded each frame (shadeRegion with a screen->basic grid)
 *  - when finished: the stroke bitmap is shaded once and baked (applyShading), so it saves/syncs
 *    exactly like any other stroke.
 */

import { loadPaintSurface, sampleSurface } from './paintSurface';

/** Load the surface multiplier for a panorama, or null if none has been precomputed. Cached. */
export function loadShading(imageId: string): Promise<Float32Array | null> {
  return loadPaintSurface(imageId);
}

// sRGB <-> linear lookups for 8-bit values
const TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const SRGB_LUT_SIZE = 4096;
const TO_SRGB = new Uint8ClampedArray(SRGB_LUT_SIZE + 1);
for (let i = 0; i <= SRGB_LUT_SIZE; i++) {
  const c = i / SRGB_LUT_SIZE;
  TO_SRGB[i] = (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255 + 0.5;
}
const toSrgb8 = (c: number) => TO_SRGB[c >= 1 ? SRGB_LUT_SIZE : c <= 0 ? 0 : (c * SRGB_LUT_SIZE) | 0];

/**
 * Shade the rectangle (x, y, w, h) of a 2D context in place.
 * gridBasic is (rows+1) x (cols+1) basic coords spanning that rectangle corner to corner;
 * entries may be null where the projection failed (those cells are left unshaded).
 */
export function shadeRegion(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  gridBasic: ([number, number] | null)[][],
  surface: Float32Array,
): void {
  x = Math.floor(x);
  y = Math.floor(y);
  w = Math.floor(w);
  h = Math.floor(h);
  const rows = gridBasic.length - 1, cols = gridBasic[0].length - 1;
  if (w <= 0 || h <= 0 || rows < 1 || cols < 1) return;
  const img = ctx.getImageData(x, y, w, h);
  const d = img.data;

  // Unwrap u across the panorama seam so interpolation doesn't jump from 0.99 to 0.01
  let u0 = 0;
  outer: for (const r of gridBasic) for (const p of r) if (p) { u0 = p[0]; break outer; }
  const gu = gridBasic.map((r) => r.map((p) => (p ? (p[0] - u0 > 0.5 ? p[0] - 1 : u0 - p[0] > 0.5 ? p[0] + 1 : p[0]) : NaN)));
  const gv = gridBasic.map((r) => r.map((p) => (p ? p[1] : NaN)));
  const s = new Float32Array(3);

  for (let py = 0; py < h; py++) {
    const fy = ((py + 0.5) / h) * rows;
    const r = Math.min(rows - 1, Math.floor(fy));
    const ty = fy - r;
    for (let px = 0; px < w; px++) {
      const q = (py * w + px) * 4;
      if (d[q + 3] === 0) continue;
      const fx = ((px + 0.5) / w) * cols;
      const c = Math.min(cols - 1, Math.floor(fx));
      const tx = fx - c;
      const u =
        (gu[r][c] * (1 - tx) + gu[r][c + 1] * tx) * (1 - ty) + (gu[r + 1][c] * (1 - tx) + gu[r + 1][c + 1] * tx) * ty;
      const v =
        (gv[r][c] * (1 - tx) + gv[r][c + 1] * tx) * (1 - ty) + (gv[r + 1][c] * (1 - tx) + gv[r + 1][c + 1] * tx) * ty;
      if (!(v >= 0 && v <= 1)) continue; // also skips NaN (failed projection)
      sampleSurface(surface, u, v, s);
      d[q] = toSrgb8(TO_LIN[d[q]] * s[0]);
      d[q + 1] = toSrgb8(TO_LIN[d[q + 1]] * s[1]);
      d[q + 2] = toSrgb8(TO_LIN[d[q + 2]] * s[2]);
    }
  }
  ctx.putImageData(img, x, y);
}

/** Shade a whole finished stroke bitmap whose gridBasic spans the canvas corner to corner. */
export function applyShading(canvas: HTMLCanvasElement, gridBasic: [number, number][][], surface: Float32Array): void {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  shadeRegion(ctx, 0, 0, canvas.width, canvas.height, gridBasic, surface);
}
