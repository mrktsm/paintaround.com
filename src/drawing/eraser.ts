import type { MarkerTexture } from "./strokes";

/** One eraser gesture over our own strokes: each touched stroke's pixels before and after. */
export interface EraseEdit {
  kind: "erase";
  strokeGroup?: undefined;
  items: Map<MarkerTexture, { before: HTMLCanvasElement; after?: HTMLCanvasElement; removed: boolean }>;
}

/** One step of undo: a stroke, or an eraser gesture. */
export type UndoEntry = MarkerTexture | EraseEdit;

export const isEraseEdit = (e: UndoEntry | undefined): e is EraseEdit => (e as EraseEdit | undefined)?.kind === "erase";

/** Panorama bbox [u0, v0, u1, v1] of a stroke's grid (cached). */
export function eraseBox(tex: MarkerTexture & { _box?: [number, number, number, number] }): [number, number, number, number] {
  if (tex._box) return tex._box;
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const row of tex.gridBasic) for (const [u, v] of row) {
    if (u < u0) u0 = u; if (u > u1) u1 = u;
    if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  return (tex._box = [u0, v0, u1, v1]);
}

/**
 * Panorama point -> pixel in a stroke's bitmap, through its grid (bitmap corners -> panorama).
 * Points just outside the stroke extrapolate from the nearest cell, so footprints at the edge
 * still cut cleanly.
 */
export function basicToTex(tex: MarkerTexture, u: number, v: number): [number, number] | null {
  const g = tex.gridBasic, R = tex.gridRows, C = tex.gridCols;
  const cw = (tex.canvas?.width ?? tex.srcWidth) / C, ch = (tex.canvas?.height ?? tex.srcHeight) / R;
  let best: [number, number] | null = null, bestErr = Infinity;
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    const p00 = g[r][c], p10 = g[r][c + 1], p01 = g[r + 1][c], p11 = g[r + 1][c + 1];
    // cheap reject: far outside this cell (with a margin for extrapolation)
    const mu = Math.max(Math.abs(p10[0] - p00[0]), Math.abs(p01[1] - p00[1]), 1e-4) * 1.5;
    if (u < Math.min(p00[0], p01[0], p10[0], p11[0]) - mu || u > Math.max(p00[0], p01[0], p10[0], p11[0]) + mu) continue;
    if (v < Math.min(p00[1], p01[1], p10[1], p11[1]) - mu || v > Math.max(p00[1], p01[1], p10[1], p11[1]) + mu) continue;
    // inverse bilinear by Newton steps
    let s = 0.5, t = 0.5;
    for (let it = 0; it < 6; it++) {
      const x = (1 - s) * (1 - t) * p00[0] + s * (1 - t) * p10[0] + (1 - s) * t * p01[0] + s * t * p11[0];
      const y = (1 - s) * (1 - t) * p00[1] + s * (1 - t) * p10[1] + (1 - s) * t * p01[1] + s * t * p11[1];
      const dxs = (1 - t) * (p10[0] - p00[0]) + t * (p11[0] - p01[0]);
      const dys = (1 - t) * (p10[1] - p00[1]) + t * (p11[1] - p01[1]);
      const dxt = (1 - s) * (p01[0] - p00[0]) + s * (p11[0] - p10[0]);
      const dyt = (1 - s) * (p01[1] - p00[1]) + s * (p11[1] - p10[1]);
      const det = dxs * dyt - dxt * dys;
      if (Math.abs(det) < 1e-14) break;
      const ex = u - x, ey = v - y;
      s += (ex * dyt - ey * dxt) / det;
      t += (ey * dxs - ex * dys) / det;
    }
    // how far outside the unit cell the solution lies (0 = inside)
    const err = Math.max(0, -s, s - 1) + Math.max(0, -t, t - 1);
    if (err < bestErr && isFinite(s) && isFinite(t)) {
      bestErr = err;
      best = [(c + s) * cw, (r + t) * ch];
      if (err === 0) return best;
    }
  }
  return bestErr < 2 ? best : null;
}

/** No visible pixels left? */
export function isBlank(canvas: HTMLCanvasElement): boolean {
  if (!canvas.width || !canvas.height) return true;
  const d = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < d.length; i += 16) if (d[i] > 8) return false;
  return true;
}
