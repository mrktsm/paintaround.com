/**
 * The brushes that paint on a 3D surface. They draw into the stroke's flat sheet (decal space, see
 * geodesicMap) and only ever draw what's new: each frame adds the latest bit of path to a layer
 * that keeps everything before it, so a long stroke costs no more per frame than a short one.
 * Everything is synchronous and seeded, so someone watching live who feeds the same frames to the
 * same brush gets exactly the drawer's pixels.
 */
import getStroke from 'perfect-freehand';
import { mulberry32, pencilGrain, pencilLook, strokeToPolygon, WCPoly, type Vec2 } from './brushParts';

export type ToolType = 'pencil' | 'marker' | 'crayon' | 'fountainPen' | 'watercolor';
export type Rect = { x0: number; y0: number; x1: number; y1: number };
type Pt = [number, number];

const SIZE = 2048; // decal canvas size (GeodesicMap.size)

/** The painted part of a stroke's sheet: a canvas that grows with the stroke. */
export class DecalLayer {
  canvas = document.createElement('canvas');
  /** kept in main memory: small draws are cheap and reading it back never waits for the GPU */
  ctx: CanvasRenderingContext2D;
  x0 = 0;
  y0 = 0;
  w = 0;
  h = 0;
  /** bumped when the canvas was reallocated (upload all of it) */
  gen = 0;
  /** decal px changed since the last upload */
  dirty: Rect | null = null;

  constructor() {
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  /** Make room for this rectangle and note it as changed. Returns it clipped to whole pixels. */
  touch(ax0: number, ay0: number, ax1: number, ay1: number): Rect {
    const x0 = Math.max(0, Math.floor(ax0)), y0 = Math.max(0, Math.floor(ay0));
    const x1 = Math.max(x0, Math.min(SIZE, Math.ceil(ax1))), y1 = Math.max(y0, Math.min(SIZE, Math.ceil(ay1)));
    if (x1 > x0 && y1 > y0) {
      if (!this.w || x0 < this.x0 || y0 < this.y0 || x1 > this.x0 + this.w || y1 > this.y0 + this.h) this.grow(x0, y0, x1, y1);
      const d = this.dirty;
      this.dirty = d ? { x0: Math.min(d.x0, x0), y0: Math.min(d.y0, y0), x1: Math.max(d.x1, x1), y1: Math.max(d.y1, y1) } : { x0, y0, x1, y1 };
    }
    return { x0, y0, x1, y1 };
  }

  private grow(x0: number, y0: number, x1: number, y1: number) {
    const empty = !this.w;
    const pad = Math.max(96, (Math.max(this.w, this.h) * 0.35) | 0);
    const snap = (v: number, up: boolean) => Math.max(0, Math.min(SIZE, (up ? Math.ceil(v / 64) : Math.floor(v / 64)) * 64));
    // grow generously, but only on the sides that ran out
    const nx0 = empty ? snap(x0 - pad, false) : x0 < this.x0 ? snap(x0 - pad, false) : this.x0;
    const ny0 = empty ? snap(y0 - pad, false) : y0 < this.y0 ? snap(y0 - pad, false) : this.y0;
    const nx1 = empty ? snap(x1 + pad, true) : x1 > this.x0 + this.w ? snap(x1 + pad, true) : this.x0 + this.w;
    const ny1 = empty ? snap(y1 + pad, true) : y1 > this.y0 + this.h ? snap(y1 + pad, true) : this.y0 + this.h;
    const next = document.createElement('canvas');
    next.width = nx1 - nx0;
    next.height = ny1 - ny0;
    const ctx = next.getContext('2d', { willReadFrequently: true })!;
    if (!empty) ctx.drawImage(this.canvas, this.x0 - nx0, this.y0 - ny0);
    ctx.setTransform(1, 0, 0, 1, -nx0, -ny0); // tools draw in decal coordinates
    this.canvas = next;
    this.ctx = ctx;
    this.x0 = nx0; this.y0 = ny0; this.w = next.width; this.h = next.height;
    this.gen++;
  }
}

export abstract class DecalTool {
  protected last: Pt = [0, 0];
  protected layer: DecalLayer;
  protected color: string;
  protected size: number;
  protected rand: () => number;
  /** spots away from the path that got paint (splatters): the surface must be opened up there */
  spots: { x: number; y: number; radius: number }[] = [];
  constructor(layer: DecalLayer, color: string, size: number, seed: number) {
    this.layer = layer;
    this.color = color;
    this.size = size;
    this.rand = mulberry32(seed);
  }
  begin(x: number, y: number): void {
    this.last = [x, y];
  }
  /** This piece carries on a stroke from another surface: keep the pen's state instead of starting anew. */
  resume(prev: DecalTool): void { void prev; }
  /** One frame's worth of path: the points since the last call, in order. */
  frame(pts: Pt[]): void {
    let dist = 0, p = this.last;
    for (const q of pts) { dist += Math.hypot(q[0] - p[0], q[1] - p[1]); p = q; }
    if (dist < 1) return;
    this.paint(pts, dist);
    this.last = pts[pts.length - 1];
  }
  protected abstract paint(pts: Pt[], dist: number): void;
}

function bounds(pts: Pt[], pad: number): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

let scratch: CanvasRenderingContext2D | null = null;
/** A cleared scratch canvas at least w x h. */
function scratchFor(w: number, h: number): CanvasRenderingContext2D {
  scratch ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  const c = scratch.canvas;
  if (c.width < w || c.height < h) {
    c.width = Math.max(c.width, Math.ceil(w / 128) * 128);
    c.height = Math.max(c.height, Math.ceil(h / 128) * 128);
  }
  scratch.setTransform(1, 0, 0, 1, 0, 0);
  scratch.globalCompositeOperation = 'source-over';
  scratch.clearRect(0, 0, w, h);
  return scratch;
}

/** Graphite: a line (slow = fuller) masked by real paper grain fixed to the surface. */
class PencilTool extends DecalTool {
  private segs: [number, number, number, number, number][] = [];
  private width = 0;
  resume(prev: DecalTool): void {
    if (prev instanceof PencilTool) this.width = prev.width;
  }
  protected paint(pts: Pt[], dist: number): void {
    const look = pencilLook();
    const target = this.size * (1.2 - 0.4 * Math.min(dist / 60, 1)) * look.width;
    const from = this.width || this.size * look.width;
    this.width = target;
    let p = this.last;
    const max = this.size * 1.2 + 2;
    pts.forEach((q, i) => {
      this.segs.push([p[0], p[1], q[0], q[1], from + ((target - from) * (i + 1)) / pts.length]);
      p = q;
    });
    const r = this.layer.touch(...bounds([this.last, ...pts], max));
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    if (w <= 0 || h <= 0) return;
    // repaint just this rectangle: the plain line, then the grain cut out of it once
    const o = scratchFor(w, h);
    o.setTransform(1, 0, 0, 1, -r.x0, -r.y0);
    o.save();
    o.beginPath();
    o.rect(r.x0, r.y0, w, h);
    o.clip();
    o.strokeStyle = this.color === '#000000' || this.color === 'black' ? '#333333' : this.color;
    o.lineCap = o.lineJoin = 'round';
    for (const [ax, ay, bx, by, lw] of this.segs) {
      if (Math.max(ax, bx) + max < r.x0 || Math.min(ax, bx) - max > r.x1 || Math.max(ay, by) + max < r.y0 || Math.min(ay, by) - max > r.y1) continue;
      o.lineWidth = lw;
      o.beginPath();
      o.moveTo(ax, ay);
      o.lineTo(bx, by);
      o.stroke();
    }
    const grain = pencilGrain(o, look);
    if (grain) {
      o.globalCompositeOperation = 'destination-in';
      o.fillStyle = grain;
      o.fillRect(r.x0, r.y0, w, h);
    }
    o.restore();
    const ctx = this.layer.ctx;
    ctx.clearRect(r.x0, r.y0, w, h);
    ctx.drawImage(o.canvas, 0, 0, w, h, r.x0, r.y0, w, h);
  }
}

/** Fat marker: a tip of many hairs dragged along the path; fast moves throw splatters. */
class MarkerTool extends DecalTool {
  private hairs: Pt[] = [];
  private readonly ink: number;
  constructor(layer: DecalLayer, color: string, size: number, seed: number) {
    super(layer, color, size * 4, seed);
    this.ink = size;
    const rad = this.size * 0.5, a1 = Math.PI * 2 * this.rand();
    const n = Math.max(1, ((rad * rad * Math.PI) / this.ink) | 0);
    for (let i = 0; i < n; i++) {
      const x0 = rad * this.rand(), y0 = x0 * 0.5, a0 = Math.PI * 2 * this.rand();
      const x1 = x0 * Math.sin(a0), y1 = y0 * Math.cos(a0), c = Math.cos(a1), s = Math.sin(a1);
      this.hairs.push([x1 * c - y1 * s, x1 * s + y1 * c]);
    }
  }
  protected paint(pts: Pt[], dist: number): void {
    const path = [this.last, ...pts];
    this.layer.touch(...bounds(path, this.size * 0.5 + this.ink));
    const ctx = this.layer.ctx;
    ctx.strokeStyle = ctx.fillStyle = this.color;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.lineWidth = this.ink;
    ctx.beginPath();
    for (const [hx, hy] of this.hairs) {
      ctx.moveTo(path[0][0] + hx, path[0][1] + hy);
      for (let i = 1; i < path.length; i++) ctx.lineTo(path[i][0] + hx, path[i][1] + hy);
    }
    ctx.stroke();
    if (dist > 75) {
      const n = ((((dist - 75) * 0.5) | 0) * this.rand()) | 0;
      const [ex, ey] = path[path.length - 1];
      const reach = Math.min(dist - 1, 140);
      for (let i = 0; i < n; i++) {
        const r = reach * this.rand() + 1, a = Math.PI * 2 * this.rand(), radius = 5 * this.rand();
        if (i >= 60) continue; // very fast flicks: enough is enough
        const x = ex + r * Math.sin(a), y = ey + r * Math.cos(a);
        this.layer.touch(x - radius - 1, y - radius - 1, x + radius + 1, y + radius + 1);
        const c = this.layer.ctx; // touch may have reallocated it
        c.fillStyle = this.color;
        c.beginPath();
        c.arc(x, y, radius, 0, Math.PI * 2);
        c.fill();
        this.spots.push({ x, y, radius });
      }
    }
  }
}

/** Crayon: clouds of random-walk dots stamped along the path (after Kora-Lee's p5 chalk). */
class CrayonTool extends DecalTool {
  private stamped = false;
  /** path walked since the last stamp */
  private carry = 0;
  private rgb: [number, number, number] | null = null;
  protected paint(pts: Pt[], dist: number): void {
    if (!this.rgb) {
      const c = document.createElement('canvas').getContext('2d')!;
      c.fillStyle = this.color;
      const hex = String(c.fillStyle);
      this.rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
    }
    const half = (this.size * 8) / 2;
    const r = this.layer.touch(...bounds([this.last, ...pts], half + 3));
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    if (w <= 0 || h <= 0) return;
    // thousands of tiny dots: written straight into the pixels, far cheaper than canvas arcs
    const ctx = this.layer.ctx;
    const img = ctx.getImageData(r.x0 - this.layer.x0, r.y0 - this.layer.y0, w, h);
    const spacing = Math.max(4, dist / 64);
    let p = this.last;
    const at = (x: number, y: number) => this.stamp(img, x - r.x0, y - r.y0, half);
    if (!this.stamped) { this.stamped = true; at(p[0], p[1]); }
    for (const q of pts) {
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      let t = Math.max(0, spacing - this.carry);
      for (; t <= len && len > 0; t += spacing) at(p[0] + ((q[0] - p[0]) * t) / len, p[1] + ((q[1] - p[1]) * t) / len);
      this.carry = len - (t - spacing);
      p = q;
    }
    ctx.putImageData(img, r.x0 - this.layer.x0, r.y0 - this.layer.y0);
  }
  private stamp(img: ImageData, cx: number, cy: number, half: number): void {
    const r2 = half * half, rand = this.rand, d = img.data, W = img.width, H = img.height;
    const [R, G, B] = this.rgb!;
    let x = 0, y = 2.2;
    for (let n = 0; n <= 2500; n++) {
      if (x * x + y * y < r2) {
        // an anti-aliased dot of radius 1
        const dx = cx + x - 0.5, dy = cy + y - 0.5;
        const x0 = Math.max(0, Math.ceil(dx - 1.5)), x1 = Math.min(W - 1, Math.floor(dx + 1.5));
        const y0 = Math.max(0, Math.ceil(dy - 1.5)), y1 = Math.min(H - 1, Math.floor(dy + 1.5));
        for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
          const q = (py * W + px) * 4, a = d[q + 3];
          if (a === 255) continue;
          const cov = 1.5 - Math.sqrt((px - dx) * (px - dx) + (py - dy) * (py - dy));
          if (cov <= 0) continue;
          d[q] = R; d[q + 1] = G; d[q + 2] = B;
          d[q + 3] = a + (255 - a) * (cov > 1 ? 1 : cov);
        }
      }
      x += rand() * 2 - 1;
      y += rand() * 2 - 1;
    }
  }
}

/** Fountain pen: thick when slow, thin when fast (perfect-freehand outline). */
class FountainTool extends DecalTool {
  private input: [number, number, number][] = [];
  private pressure = 0.5;
  private resumed = false;
  resume(prev: DecalTool): void {
    if (!(prev instanceof FountainTool)) return;
    this.pressure = prev.pressure;
    this.resumed = true;
    this.input.push([this.last[0], this.last[1], this.pressure]);
  }
  protected paint(pts: Pt[], dist: number): void {
    const size = this.size * 6;
    // perfect-freehand's own speed -> pressure curve, fed with the whole frame's movement (so a
    // frame with many points on a curve isn't taken for a slow one)
    const sp = Math.min(1, dist / size), rp = Math.min(1, 1 - sp);
    const from = this.pressure;
    this.pressure = Math.min(1, from + (rp - from) * (sp * 0.275));
    let p = this.last, changedFrom = this.input.length;
    pts.forEach((q, i) => {
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 1) return;
      this.input.push([q[0], q[1], from + ((this.pressure - from) * (i + 1)) / pts.length]);
      p = q;
    });
    if (this.input.length < 2) return;
    // only the tail's outline changes (end taper, smoothing), so only that part is redrawn
    changedFrom = this.input.length < 24 ? 0 : Math.max(0, changedFrom - 16);
    const r = this.layer.touch(...bounds(this.input.slice(changedFrom).map((q) => [q[0], q[1]] as Pt), size * 1.2 + 2));
    const ctx = this.layer.ctx;
    const outline = getStroke(this.input, {
      size, thinning: 0.9, smoothing: 0.5, streamline: 0.5, simulatePressure: false,
      start: { taper: this.resumed ? 0 : size * 2, cap: true }, end: { taper: size * 0.5, cap: false },
    });
    if (outline.length < 2) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    ctx.clip();
    ctx.clearRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < outline.length; i++) {
      const a = outline[i - 1], b = outline[i];
      ctx.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

/** Watercolour (after BarneyCodes): many thin layers with organic edges, added per segment. */
class WatercolorTool extends DecalTool {
  private pts: Vec2[] = [];
  private rgb = '0, 0, 0';
  begin(x: number, y: number): void {
    super.begin(x, y);
    this.pts = [{ x, y }];
    const c = document.createElement('canvas').getContext('2d')!;
    c.fillStyle = this.color;
    const hex = String(c.fillStyle);
    this.rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');
  }
  protected paint(pts: Pt[], dist: number): void {
    // a layered segment is expensive: a few per frame, longer when moving fast
    const min = Math.max(3, dist / 4);
    for (const q of pts) {
      const l = this.pts[this.pts.length - 1];
      if (Math.hypot(q[0] - l.x, q[1] - l.y) < min && q !== pts[pts.length - 1]) continue;
      if (Math.hypot(q[0] - l.x, q[1] - l.y) < 3) continue;
      this.pts.push({ x: q[0], y: q[1] });
      this.segment();
    }
  }
  private segment(): void {
    const len = this.pts.length, overlap = Math.min(3, len - 1);
    const seg = this.pts.slice(len - overlap - 1);
    const verts = strokeToPolygon(seg, this.size * 4);
    if (verts.length < 3) return;
    let base = new WCPoly(verts, undefined, this.rand).grow().grow();
    const layers = 50;
    const polys: WCPoly[] = [];
    for (let i = 0; i < layers; i++) {
      if (i === Math.floor(layers / 3) || i === Math.floor((2 * layers) / 3)) base = base.grow().grow();
      polys.push(base.grow());
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of polys) for (const v of p.vertices) { x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y); }
    this.layer.touch(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
    const ctx = this.layer.ctx;
    ctx.fillStyle = `rgba(${this.rgb}, ${1.5 / layers})`;
    for (const p of polys) p.draw(ctx);
  }
}

export function makeDecalTool(type: ToolType, layer: DecalLayer, color: string, size: number, seed: number): DecalTool {
  switch (type) {
    case 'marker': return new MarkerTool(layer, color, size, seed);
    case 'crayon': return new CrayonTool(layer, color, size, seed);
    case 'fountainPen': return new FountainTool(layer, color, size, seed);
    case 'watercolor': return new WatercolorTool(layer, color, size, seed);
    default: return new PencilTool(layer, color, size, seed);
  }
}

/** Load the brushes' textures ahead of the first stroke. */
export function preloadDecalTools(): void {
  const c = document.createElement('canvas').getContext('2d');
  if (c) pencilGrain(c, pencilLook());
}

/**
 * Drop points that lie (almost) on the line between their neighbours. Keeps the last one.
 * (On flat surfaces a whole frame becomes one straight step, like a plain mouse sample.)
 */
export function simplify(from: Pt, pts: Pt[], tol: number): number[] {
  const keep: number[] = [];
  let a = from, start = 0;
  for (let end = 1; end < pts.length; end++) {
    const b = pts[end], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    let off = false;
    for (let k = start; k < end && !off; k++) {
      const px = pts[k][0] - a[0], py = pts[k][1] - a[1];
      const d = len < 1e-6 ? Math.hypot(px, py) : Math.abs(px * dy - py * dx) / len;
      const along = len < 1e-6 ? 0 : (px * dx + py * dy) / len;
      if (d > tol || along < -tol || along > len + tol) off = true;
    }
    if (off) {
      keep.push(end - 1);
      a = pts[end - 1];
      start = end;
    }
  }
  if (pts.length) keep.push(pts.length - 1);
  return keep;
}
