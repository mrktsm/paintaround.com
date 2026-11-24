import { applyShading } from "../deep/strokeShading";
import { SurfaceDecal, surfaceRing } from "../deep/surfaceDecal";
import type { PeerCursors } from "./PeerCursors";
import type { Scene } from "./scene";
import type { MarkerTexture } from "./strokes";

/** Where the live strokes are shown. */
export interface StrokeCanvas {
  /** Replace one stroke with another (null: just add, or just remove) and redraw. */
  swap(remove: MarkerTexture | null, add: MarkerTexture | null): void;
}

interface Preview {
  color: string;
  radius: number;
  group?: number;
  ended: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** stamped footprints in basic coords (u unwrapped around u0, so the seam is continuous) */
  stamps: [number, number][][];
  last: [number, number];
  u0: number;
  tex: MarkerTexture | null;
  dirty: boolean;
}

/**
 * Others' strokes while they draw, where they can't be replayed with the real brush. The brush's
 * real footprint on the surface (the same wrapped ring as their cursor) is stamped along their path
 * into a panorama-space bitmap, lit with this panorama's lighting, and shown like any finished
 * stroke, so it sits on the surface instead of floating over it. Their finished bitmap replaces it
 * when they let go.
 */
export class PeerPreviews {
  private readonly previews = new Map<string, Preview>();
  private readonly scene: Scene;
  private readonly peers: PeerCursors;
  private readonly canvas: StrokeCanvas;

  constructor(scene: Scene, peers: PeerCursors, canvas: StrokeCanvas) {
    this.scene = scene;
    this.peers = peers;
    this.canvas = canvas;
  }

  start(id: string, color: string, u: number, v: number, group?: number): void {
    const cur = this.previews.get(id);
    if (cur && group !== undefined && cur.group === group) {
      // next piece of the same stroke (it crossed onto another surface): keep painting
      cur.ended = false;
      clearTimeout(cur.timer);
      this.point(id, u, v);
      return;
    }
    this.end(id);
    const paint = color === "rainbow" ? (this.peers.colors.get(id) ?? "#ff3b30") : color;
    // brush radius from their cursor (radians); a sensible default until one arrives
    const radius = this.peers.brush.get(id) ?? 0.006;
    const rp: Preview = { color: paint, radius, group, ended: false, stamps: [], last: [u, v], u0: u, tex: null, dirty: false };
    this.previews.set(id, rp);
    this.stamp(id, u, v);
  }

  point(id: string, u: number, v: number): void {
    const rp = this.previews.get(id);
    if (!rp) return;
    // unwrap u next to the previous point, then stamp along the gap so the line stays solid
    while (u - rp.last[0] > 0.5) u -= 1;
    while (rp.last[0] - u > 0.5) u += 1;
    const [lu, lv] = rp.last;
    const lat = (0.5 - lv) * Math.PI;
    const ang = Math.hypot((u - lu) * 2 * Math.PI * Math.cos(lat), (v - lv) * Math.PI);
    const steps = Math.min(40, Math.max(1, Math.ceil(ang / (rp.radius * 0.5))));
    for (let k = 1; k <= steps; k++) this.stamp(id, lu + ((u - lu) * k) / steps, lv + ((v - lv) * k) / steps);
    rp.last = [u, v];
  }

  /** One brush footprint at (u, v), wrapped onto the surface like their cursor ring. */
  private stamp(id: string, u: number, v: number): void {
    const rp = this.previews.get(id);
    if (!rp) return;
    let ring: [number, number][] = [];
    const { deep, radPerPx } = this.scene;
    if (deep) {
      const decal = SurfaceDecal.create(deep, ((u % 1) + 1) % 1, v, radPerPx);
      if (decal) ring = surfaceRing(deep, decal.basis, (rp.radius / radPerPx) * decal.basis.s, 20, 8);
    }
    if (!ring.length) {
      // no depth here (or sky): a plain angular circle
      const cosLat = Math.max(0.05, Math.cos((0.5 - v) * Math.PI));
      for (let k = 0; k < 20; k++) {
        const a = (k / 20) * Math.PI * 2;
        ring.push([u + (Math.cos(a) * rp.radius) / (2 * Math.PI * cosLat), v + (Math.sin(a) * rp.radius) / Math.PI]);
      }
    }
    // keep every footprint next to u0 (the ring may come back wrapped to [0, 1))
    rp.stamps.push(ring.map(([pu, pv]) => {
      while (pu - rp.u0 > 0.5) pu -= 1;
      while (rp.u0 - pu > 0.5) pu += 1;
      return [pu, pv];
    }));
    if (!rp.dirty) {
      rp.dirty = true;
      requestAnimationFrame(() => this.rebuild(id));
    }
  }

  /** Re-render the preview bitmap (at most once a frame) and swap it into the stroke list. */
  private rebuild(id: string): void {
    const rp = this.previews.get(id);
    if (!rp) return;
    rp.dirty = false;
    const W = 2048, H = 1024, SS = 2; // panorama px, supersampled like baked strokes
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const ring of rp.stamps) for (const [u, v] of ring) {
      const x = u * W, y = v * H;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!isFinite(x0)) return;
    x0 = Math.floor(x0) - 1; y0 = Math.max(0, Math.floor(y0) - 1);
    x1 = Math.ceil(x1) + 1; y1 = Math.min(H, Math.ceil(y1) + 1);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0 || w > 1600 || h > 900) return; // runaway: keep the last good preview
    const canvas = document.createElement("canvas");
    canvas.width = w * SS;
    canvas.height = h * SS;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = rp.color;
    ctx.setTransform(SS, 0, 0, SS, -x0 * SS, -y0 * SS);
    for (const ring of rp.stamps) {
      ctx.beginPath();
      ring.forEach(([u, v], k) => (k ? ctx.lineTo(u * W, v * H) : ctx.moveTo(u * W, v * H)));
      ctx.closePath();
      ctx.fill();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // equirect is linear in u, v, so a coarse grid spans the box exactly
    const rows = 4, cols = 4;
    const gridBasic: [number, number][][] = [];
    for (let r = 0; r <= rows; r++) {
      const row: [number, number][] = [];
      for (let c = 0; c <= cols; c++) row.push([(x0 + (c / cols) * w) / W, (y0 + (r / rows) * h) / H]);
      gridBasic.push(row);
    }
    const light = this.scene.deep?.surface;
    if (light) applyShading(canvas, gridBasic, light);
    const tex: MarkerTexture = {
      canvas, gridBasic, gridRows: rows, gridCols: cols,
      srcWidth: canvas.width, srcHeight: canvas.height,
      referenceFov: this.scene.fov, opacity: 1,
    };
    const old = rp.tex;
    rp.tex = tex;
    this.canvas.swap(old, tex);
  }

  /** They finished (or left): the live version goes. */
  end(id: string): void {
    const rp = this.previews.get(id);
    if (!rp) return;
    clearTimeout(rp.timer);
    if (rp.tex) this.canvas.swap(rp.tex, null);
    this.previews.delete(id);
  }

  /**
   * A piece of their stroke ended. A stroke crossing onto a new surface ends a piece and starts the
   * next one (same group): keep the line until the finished bitmap arrives, unless it continues.
   */
  pieceEnded(id: string): void {
    const rp = this.previews.get(id);
    if (!rp) return;
    rp.ended = true;
    clearTimeout(rp.timer);
    rp.timer = setTimeout(() => { if (this.previews.get(id) === rp && rp.ended) this.end(id); }, 4000);
  }

  /** The finished bitmap of a whole stroke is on screen. */
  finished(id: string, group: number | undefined): void {
    const rp = this.previews.get(id);
    if (rp && rp.ended && (group === undefined || rp.group === undefined || rp.group === group)) this.end(id);
  }

  clear(): void {
    for (const id of [...this.previews.keys()]) this.end(id);
  }
}
