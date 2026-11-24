import { SurfaceDecal, surfaceRing } from "../deep/surfaceDecal";
import type { EraseEdit, History } from "./history";
import type { LiveRoom } from "./LiveRoom";
import type { Scene } from "./scene";
import { copyCanvas, ensureCanvas, type MarkerTexture, type Strokes } from "./strokes";

/** Panorama bbox [u0, v0, u1, v1] of a stroke's grid (cached). */
function eraseBox(tex: MarkerTexture & { _box?: [number, number, number, number] }): [number, number, number, number] {
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
function basicToTex(tex: MarkerTexture, u: number, v: number): [number, number] | null {
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
function isBlank(canvas: HTMLCanvasElement): boolean {
  if (!canvas.width || !canvas.height) return true;
  const d = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < d.length; i += 16) if (d[i] > 8) return false;
  return true;
}

/**
 * A brush that rubs out our own paint. Its footprint is the same surface-wrapped ring as the brush
 * cursor. Each stamp is mapped into the bitmaps of our strokes underneath and cut out. One gesture is
 * one undo step; trimmed strokes are shared with the room again under the same id.
 */
export class Eraser {
  private session: EraseEdit | null = null;
  private last: [number, number] | null = null;
  private lastShare = 0;
  private readonly scene: Scene;
  private readonly strokes: Strokes;
  private readonly history: History;
  private readonly room: LiveRoom;

  constructor(scene: Scene, strokes: Strokes, history: History, room: LiveRoom) {
    this.scene = scene;
    this.strokes = strokes;
    this.history = history;
    this.room = room;
  }

  at(pixelX: number, pixelY: number, radius: number): void {
    // stamp along the path since the last point, so fast moves leave no gaps
    const last = this.last;
    const dist = last ? Math.hypot(pixelX - last[0], pixelY - last[1]) : 0;
    const steps = last ? Math.min(40, Math.max(1, Math.ceil(dist / (radius * 0.4)))) : 1;
    let changed = false;
    for (let k = 1; k <= steps; k++) {
      const x = last ? last[0] + ((pixelX - last[0]) * k) / steps : pixelX;
      const y = last ? last[1] + ((pixelY - last[1]) * k) / steps : pixelY;
      const ring = this.footprint(x, y, radius);
      if (ring && this.cut(ring)) changed = true;
    }
    this.last = [pixelX, pixelY];
    if (!changed) return;
    this.scene.redraw();
    // others watch it get rubbed out (a few times a second; the final state goes on release)
    const now = performance.now();
    if (now - this.lastShare > 400 && this.session) {
      this.lastShare = now;
      for (const tex of this.session.items.keys()) if (this.strokes.has(tex)) void this.room.share(tex);
    }
  }

  /**
   * End of an eraser gesture: strokes rubbed out completely are removed, the rest are re-shared
   * trimmed; the whole gesture becomes one undo step.
   */
  finish(): void {
    this.last = null;
    const session = this.session;
    this.session = null;
    if (!session) return;
    const removed: MarkerTexture[] = [];
    for (const [tex, item] of session.items) {
      if (!tex.canvas) continue;
      item.after = copyCanvas(tex.canvas);
      if (isBlank(tex.canvas)) {
        item.removed = true;
        removed.push(tex);
        this.strokes.remove(tex);
      } else {
        void this.room.share(tex);
      }
    }
    if (removed.length) this.room.erase(removed);
    this.history.add(session);
    this.scene.redraw();
  }

  /** The eraser outline at a screen point, in panorama coords (on the surface when we have depth). */
  private footprint(x: number, y: number, radius: number): [number, number][] | null {
    const b = this.scene.toPanorama(x, y);
    if (!b) return null;
    const deep = this.scene.deep;
    if (deep) {
      const decal = SurfaceDecal.create(deep, b[0], b[1], this.scene.radPerPx);
      if (decal) return surfaceRing(deep, decal.basis, radius * decal.basis.s, 32);
    }
    const ring: [number, number][] = [];
    for (let k = 0; k <= 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      const p = this.scene.toPanorama(x + Math.cos(a) * radius, y + Math.sin(a) * radius);
      if (p) ring.push(p);
    }
    return ring.length > 8 ? ring : null;
  }

  /** Cut one footprint out of every own stroke under it. True if anything was touched. */
  private cut(ring: [number, number][]): boolean {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [u, v] of ring) {
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const cu = (u0 + u1) / 2;
    let touched = false;
    for (const tex of this.strokes.list) {
      if (!tex.isLocal) continue;
      const box = eraseBox(tex);
      // compare with the footprint shifted by whole turns towards the stroke (panorama seam)
      const shift = Math.round((box[0] + box[2]) / 2 - cu);
      if (u1 + shift < box[0] || u0 + shift > box[2] || v1 < box[1] || v0 > box[3]) continue;
      const pts: [number, number][] = [];
      for (const [u, v] of ring) {
        const t = basicToTex(tex, u + shift, v);
        if (t) pts.push(t);
      }
      if (pts.length < 3) continue;
      // first touch in this gesture: keep the pixels for undo
      const session = (this.session ??= { kind: "erase", items: new Map() });
      if (!session.items.has(tex)) {
        if (!tex.canvas) this.strokes.forget(tex);
        session.items.set(tex, { before: copyCanvas(ensureCanvas(tex)), removed: false });
      }
      const canvas = tex.canvas!;
      const ctx = canvas.getContext("2d")!;
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      this.strokes.forget(tex);
      touched = true;
    }
    return touched;
  }
}
