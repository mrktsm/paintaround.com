/**
 * Surface decals: make any drawing tool paint *on* the 3D surface of the panorama.
 *
 * When a stroke starts we look up the surface under the cursor in the precomputed depth map, fit
 * its orientation (normal), and build a tangent plane through that point. Each stroke gets a
 * "decal canvas" that represents that plane: one decal pixel is a fixed real-world size on the
 * surface. Tools draw into the decal canvas with their normal code — we only hand them
 * projector/unprojector functions for decal space instead of screen space.
 *
 * The decal is then mapped back onto the panorama in perspective (decal pixel -> point on plane ->
 * view ray -> basic coords), so strokes foreshorten on walls/ground, and marker drips run *down*
 * the wall. Decal pixels where the plane doesn't match the real depth (past a wall's edge, onto a
 * car in front) are masked out so strokes stay on the surface they started on. Finally the
 * panorama's surface map (shadows + texture) is multiplied in.
 *
 * Coordinates: basic (u,v) in [0,1]^2 = equirect image coords. 3D frame: y up,
 * lon = u*2π - π (0 = image centre = +z), lat = π/2 - v*π.
 */

import { loadPaintSurface, sampleSurface } from './paintSurface';

const W = 2048;
const H = 1024;
const TWO_PI = Math.PI * 2;

export type DeepData = {
  dist: Float32Array;
  surface: Float32Array;
  /** smoothed unit normals (camera-facing), half resolution NW x NH x 3 — computed on load */
  normals: Float32Array;
};
const NW = W / 2;
const NH = H / 2;

const cache = new Map<string, Promise<DeepData | null>>();

/** Load depth + surface maps for a panorama (null if none precomputed). Cached per id. */
export function loadDeepData(imageId: string): Promise<DeepData | null> {
  let p = cache.get(imageId);
  if (!p) {
    const get = (name: string) =>
      fetch(`/deep-layers/${imageId}/${name}.f32`)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((b) => (b && b.byteLength === W * H * 4 ? new Float32Array(b) : null))
        .catch(() => null);
    p = Promise.all([get('distance'), loadPaintSurface(imageId)]).then(([dist, surface]) =>
      dist && surface ? { dist, surface, normals: computeNormals(dist) } : null,
    );
    cache.set(imageId, p);
  }
  return p;
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function dirFromBasic(u: number, v: number): V3 {
  const lon = u * TWO_PI - Math.PI;
  const lat = Math.PI / 2 - v * Math.PI;
  const c = Math.cos(lat);
  return [c * Math.sin(lon), Math.sin(lat), c * Math.cos(lon)];
}
export function basicFromDir(d: V3): [number, number] {
  const r = Math.hypot(d[0], d[1], d[2]) || 1;
  const lon = Math.atan2(d[0], d[2]);
  const lat = Math.asin(Math.max(-1, Math.min(1, d[1] / r)));
  return [(lon + Math.PI) / TWO_PI, (Math.PI / 2 - lat) / Math.PI];
}

function pixelIndex(u: number, v: number) {
  const x = ((Math.floor((u - Math.floor(u)) * W) % W) + W) % W;
  const y = Math.min(H - 1, Math.max(0, Math.floor(v * H)));
  return y * W + x;
}
function pointAt(data: DeepData, i: number, j: number): V3 {
  i = Math.min(H - 1, Math.max(0, i));
  j = ((j % W) + W) % W;
  const d = dirFromBasic((j + 0.5) / W, (i + 0.5) / H);
  const r = data.dist[i * W + j];
  return [d[0] * r, d[1] * r, d[2] * r];
}

/**
 * Per-pixel surface normals from the depth map (half resolution), smoothed so that big surfaces
 * (walls, ground, a bus side) get one consistent direction while corners stay sharp-ish.
 * Used to decide when a stroke has moved onto a different surface, and to stop paint bleeding
 * across a corner (e.g. from a wall onto the floor).
 */
function computeNormals(dist: Float32Array): Float32Array {
  const n = new Float32Array(NW * NH * 3);
  const P = (i: number, j: number, out: number[]) => {
    i = Math.min(H - 1, Math.max(0, i));
    j = ((j % W) + W) % W;
    const lon = ((j + 0.5) / W) * TWO_PI - Math.PI, lat = Math.PI / 2 - ((i + 0.5) / H) * Math.PI;
    const c = Math.cos(lat), r = dist[i * W + j];
    out[0] = c * Math.sin(lon) * r; out[1] = Math.sin(lat) * r; out[2] = c * Math.cos(lon) * r;
  };
  const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], d = [0, 0, 0], o = [0, 0, 0];
  const K = 4;
  for (let y = 0; y < NH; y++) {
    const i = y * 2 + 1;
    for (let x = 0; x < NW; x++) {
      const j = x * 2 + 1;
      P(i, j + K, a); P(i, j - K, b); P(i + K, j, c); P(i - K, j, d); P(i, j, o);
      const ux = a[0] - b[0], uy = a[1] - b[1], uz = a[2] - b[2];
      const vx = c[0] - d[0], vy = c[1] - d[1], vz = c[2] - d[2];
      let nx = vy * uz - vz * uy, ny = vz * ux - vx * uz, nz = vx * uy - vy * ux;
      if (nx * o[0] + ny * o[1] + nz * o[2] > 0) { nx = -nx; ny = -ny; nz = -nz; }
      const l = Math.hypot(nx, ny, nz) || 1;
      const q = (y * NW + x) * 3;
      n[q] = nx / l; n[q + 1] = ny / l; n[q + 2] = nz / l;
    }
  }
  // separable box blur (radius 3) then renormalise
  const tmp = new Float32Array(n.length);
  const R = 3;
  for (let y = 0; y < NH; y++) for (let x = 0; x < NW; x++) {
    let sx = 0, sy = 0, sz = 0;
    for (let k = -R; k <= R; k++) { const q = (y * NW + ((x + k + NW) % NW)) * 3; sx += n[q]; sy += n[q + 1]; sz += n[q + 2]; }
    const q = (y * NW + x) * 3; tmp[q] = sx; tmp[q + 1] = sy; tmp[q + 2] = sz;
  }
  for (let y = 0; y < NH; y++) for (let x = 0; x < NW; x++) {
    let sx = 0, sy = 0, sz = 0;
    for (let k = -R; k <= R; k++) { const yy = Math.min(NH - 1, Math.max(0, y + k)); const q = (yy * NW + x) * 3; sx += tmp[q]; sy += tmp[q + 1]; sz += tmp[q + 2]; }
    const l = Math.hypot(sx, sy, sz) || 1;
    const q = (y * NW + x) * 3; n[q] = sx / l; n[q + 1] = sy / l; n[q + 2] = sz / l;
  }
  return n;
}
export function normalIndex(u: number, v: number) {
  const x = ((Math.floor((u - Math.floor(u)) * NW) % NW) + NW) % NW;
  const y = Math.min(NH - 1, Math.max(0, Math.floor(v * NH)));
  return (y * NW + x) * 3;
}

export class SurfaceDecal {
  /** decal canvas size in pixels (square) */
  static SIZE = 2048;
  readonly size = SurfaceDecal.SIZE;
  readonly cx = SurfaceDecal.SIZE / 2;
  readonly cy = SurfaceDecal.SIZE / 2;
  private P0: V3;
  private n: V3; // plane normal (may be tilted towards the camera for edge-on surfaces)
  private nSurf: V3; // real surface normal — used to tell surfaces apart
  private t1: V3;
  private t2: V3;
  private s: number; // world units per decal pixel
  /** Seed point + tangent frame + scale (used to start a geodesic surface unwrap). */
  get basis() {
    return { P0: this.P0, n: this.n, nSurf: this.nSurf, t1: this.t1, t2: this.t2, s: this.s };
  }

  /** World units per decal pixel (brush scale); passed on when a stroke chains onto a new surface. */
  get worldPerPx() {
    return this.s;
  }
  private data: DeepData;

  private constructor(data: DeepData, P0: V3, n: V3, nSurf: V3, t1: V3, t2: V3, s: number) {
    this.data = data;
    this.P0 = P0;
    this.n = n;
    this.nSurf = nSurf;
    this.t1 = t1;
    this.t2 = t2;
    this.s = s;
  }

  /**
   * Build a decal for a stroke starting at basic coords (u,v).
   * radPerScreenPx = view angle covered by one screen pixel, so decal pixels match screen pixels
   * at the start point (each tool keeps its usual on-screen size where you start drawing).
   * Returns null where the surface is unusable (sky, too steep / grazing angle).
   */
  static create(data: DeepData, u: number, v: number, radPerScreenPx: number, worldPerPx?: number): SurfaceDecal | null {
    if (v < 0.04 || v > 0.98) return null;
    const i = Math.floor(v * H), j = Math.floor(u * W);
    const P0 = pointAt(data, i, j);
    const d0 = Math.hypot(P0[0], P0[1], P0[2]);
    if (!(d0 > 0)) return null;
    // surface normal from the smoothed normal map (same source used for chaining/masking)
    const ni = normalIndex(u, v);
    let n: V3 = [data.normals[ni], data.normals[ni + 1], data.normals[ni + 2]];
    const nSurf: V3 = [n[0], n[1], n[2]];
    const view = norm(P0);
    // Surfaces seen almost edge-on make the plane math explode; instead of giving up (flat
    // stroke), tilt the plane towards the camera just enough to stay usable.
    for (let k = 0; k < 8 && -dot(n, view) < 0.3; k++) n = norm([n[0] - view[0] * 0.25, n[1] - view[1] * 0.25, n[2] - view[2] * 0.25]);
    const up: V3 = [0, 1, 0];
    let t1 = cross(n, up);
    if (Math.hypot(t1[0], t1[1], t1[2]) < 0.35) t1 = cross(n, view); // ground / ceiling
    t1 = norm(t1); // decal +x ~ screen right
    const t2 = norm(cross(n, t1)); // decal +y ~ screen down (and "down the wall")
    // one decal px = the width of one screen px at the start point, measured on the surface —
    // unless continuing a stroke, where we keep the previous segment's real-world scale
    // (clamped to 1.5x of a fresh stroke's size, so a stroke going from a far wall onto the
    // nearby ground doesn't balloon into a blob, and vice versa)
    const fresh = d0 * radPerScreenPx;
    const s = worldPerPx ? Math.min(fresh * 1.5, Math.max(fresh / 1.5, worldPerPx)) : fresh;
    return new SurfaceDecal(data, P0, n, nSurf, t1, t2, s);
  }

  /** decal px -> basic coords (always valid). */
  basicFromDecal(x: number, y: number): [number, number] {
    const a = (x - this.cx) * this.s, b = (y - this.cy) * this.s;
    const X: V3 = [
      this.P0[0] + a * this.t1[0] + b * this.t2[0],
      this.P0[1] + a * this.t1[1] + b * this.t2[1],
      this.P0[2] + a * this.t1[2] + b * this.t2[2],
    ];
    return basicFromDir(X);
  }

  /** basic coords -> decal px, via the view ray hitting the stroke's plane (null if it misses). */
  decalFromBasic(u: number, v: number): [number, number] | null {
    const d = dirFromBasic(u, v);
    const den = dot(this.n, d);
    if (Math.abs(den) < 1e-6) return null;
    const t = dot(this.n, this.P0) / den;
    if (t <= 0) return null;
    const rel = sub([d[0] * t, d[1] * t, d[2] * t], this.P0);
    const x = dot(rel, this.t1) / this.s + this.cx;
    const y = dot(rel, this.t2) / this.s + this.cy;
    // keep a margin so tools never draw past the decal canvas
    const m = 64;
    if (x < m || y < m || x > this.size - m || y > this.size - m) return null;
    return [x, y];
  }

  /**
   * Is the real surface at basic (u,v) still (close to) this stroke's plane? False when the view ray
   * misses the plane, leaves the decal canvas, or the depth there differs — i.e. the stroke has moved
   * onto another surface (corner, curve, object in front) and should continue on a new decal.
   */
  matches(u: number, v: number, tol = 0.15): boolean {
    if (!this.decalFromBasic(u, v)) return false;
    // different facing direction = different surface (wall vs floor ~ 90° apart)
    const ni = normalIndex(u, v), N = this.data.normals;
    const ns = this.nSurf;
    if (N[ni] * ns[0] + N[ni + 1] * ns[1] + N[ni + 2] * ns[2] < 0.7) return false; // > ~45° apart
    const d = dirFromBasic(u, v);
    const t = dot(this.n, this.P0) / dot(this.n, d);
    const real = this.data.dist[pixelIndex(u, v)];
    return Math.abs(real - t) / t < tol;
  }

  /** Grid of basic coords spanning a decal rectangle corner to corner (for MarkerTexture.gridBasic). */
  grid(x0: number, y0: number, w: number, h: number, rows: number, cols: number): [number, number][][] {
    const g: [number, number][][] = [];
    for (let r = 0; r <= rows; r++) {
      const row: [number, number][] = [];
      for (let c = 0; c <= cols; c++) row.push(this.basicFromDecal(x0 + (c / cols) * w, y0 + (r / rows) * h));
      g.push(row);
    }
    // unwrap u so a grid crossing the panorama seam stays continuous (renderer interpolates)
    const u0 = g[0][0][0];
    for (const row of g) for (const p of row) {
      if (p[0] - u0 > 0.5) p[0] -= 1;
      else if (u0 - p[0] > 0.5) p[0] += 1;
    }
    return g;
  }

  /**
   * Copy the decal rectangle (x0,y0,w,h) of src into dst (resized to w x h), masking pixels where
   * the plane doesn't match the real surface depth, and multiplying in shadows/texture.
   */
  process(src: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, dst: HTMLCanvasElement): void {
    x0 = Math.floor(x0); y0 = Math.floor(y0); w = Math.floor(w); h = Math.floor(h);
    if (dst.width !== w || dst.height !== h) {
      dst.width = w;
      dst.height = h;
    }
    const dctx = dst.getContext('2d', { willReadFrequently: true })!;
    if (w <= 0 || h <= 0) return;
    const img = src.getImageData(x0, y0, w, h);
    const p = img.data;
    const { dist, surface, normals } = this.data;
    const n0 = this.nSurf[0], n1 = this.nSurf[1], n2 = this.nSurf[2];
    const s = this.s, t1 = this.t1, t2 = this.t2, P0 = this.P0;
    const sh = new Float32Array(3);
    for (let py = 0; py < h; py++) {
      const b = (y0 + py + 0.5 - this.cy) * s;
      const rx = P0[0] + b * t2[0], ry = P0[1] + b * t2[1], rz = P0[2] + b * t2[2];
      for (let px = 0; px < w; px++) {
        const q = (py * w + px) * 4;
        if (p[q + 3] === 0) continue;
        const a = (x0 + px + 0.5 - this.cx) * s;
        const X0 = rx + a * t1[0], X1 = ry + a * t1[1], X2 = rz + a * t1[2];
        const r = Math.hypot(X0, X1, X2);
        const u = (Math.atan2(X0, X2) + Math.PI) / TWO_PI;
        const v = (Math.PI / 2 - Math.asin(Math.max(-1, Math.min(1, X1 / r)))) / Math.PI;
        const idx = pixelIndex(u, v);
        // occlusion / off-surface mask: plane distance vs. real surface distance along this ray
        const rel = Math.abs(dist[idx] - r) / r;
        const ni = normalIndex(u, v);
        const facing = normals[ni] * n0 + normals[ni + 1] * n1 + normals[ni + 2] * n2;
        const keepDepth = rel < 0.1 ? 1 : rel > 0.18 ? 0 : (0.18 - rel) / 0.08;
        const keepFacing = facing > 0.75 ? 1 : facing < 0.6 ? 0 : (facing - 0.6) / 0.15;
        const keep = Math.min(keepDepth, keepFacing);
        if (keep === 0) {
          p[q + 3] = 0;
          continue;
        }
        if (keep < 1) p[q + 3] = p[q + 3] * keep;
        sampleSurface(surface, u, v, sh);
        p[q] = toSrgb8(TO_LIN[p[q]] * sh[0]);
        p[q + 1] = toSrgb8(TO_LIN[p[q + 1]] * sh[1]);
        p[q + 2] = toSrgb8(TO_LIN[p[q + 2]] * sh[2]);
      }
    }
    dctx.putImageData(img, 0, 0);
  }
}

// sRGB <-> linear lookups
const TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const LUT = 4096;
const TO_SRGB = new Uint8ClampedArray(LUT + 1);
for (let i = 0; i <= LUT; i++) {
  const c = i / LUT;
  TO_SRGB[i] = (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255 + 0.5;
}
const toSrgb8 = (c: number) => TO_SRGB[c >= 1 ? LUT : c <= 0 ? 0 : (c * LUT) | 0];

/** Depth at basic (u,v), bilinear — except across a depth edge or the sky, where it's nearest. */
function sampleDist(data: DeepData, u: number, v: number): number {
  const x = (u - Math.floor(u)) * W - 0.5, y = Math.min(H - 1, Math.max(0, v * H - 0.5));
  const j0 = Math.floor(x), i0 = Math.floor(y), fx = x - j0, fy = y - i0;
  const i1 = Math.min(H - 1, i0 + 1);
  const ja = (j0 + W) % W, jb = (j0 + 1) % W;
  const a = data.dist[i0 * W + ja], b = data.dist[i0 * W + jb], c = data.dist[i1 * W + ja], d = data.dist[i1 * W + jb];
  const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
  if (!(lo > 0) || (hi - lo) / lo > 0.12) {
    return fx < 0.5 ? (fy < 0.5 ? a : c) : fy < 0.5 ? b : d;
  }
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * A circle drawn *on* the surface (for the brush cursor): from the centre, walk outwards in N
 * directions along the actual depth surface — so the ring rides over bumps, kerbs and corners
 * like paint does — until `radius` (world units, measured along the surface) is covered.
 * A walk stops early at a depth jump (edge of another object) or the sky, the same places a
 * stroke can't cross. Returns the ring in basic coords (closed: last point = first).
 */
export function surfaceRing(
  data: DeepData,
  basis: { P0: V3; nSurf: V3; t1: V3; t2: V3 },
  radius: number,
  N = 64,
  steps = 20,
): [number, number][] {
  const { P0, nSurf } = basis;
  const h = radius / steps;
  const ring: [number, number][] = [];
  for (let k = 0; k < N; k++) {
    const ang = (k / N) * TWO_PI;
    // start direction in the real surface's tangent plane
    let t: V3 = [
      Math.cos(ang) * basis.t1[0] + Math.sin(ang) * basis.t2[0],
      Math.cos(ang) * basis.t1[1] + Math.sin(ang) * basis.t2[1],
      Math.cos(ang) * basis.t1[2] + Math.sin(ang) * basis.t2[2],
    ];
    const dn = dot(t, nSurf);
    t = norm([t[0] - dn * nSurf[0], t[1] - dn * nSurf[1], t[2] - dn * nSurf[2]]);
    let P: V3 = P0;
    let left = radius;
    for (let s = 0; s < steps * 3 && left > 1e-9; s++) {
      const step = Math.min(h, left);
      const G: V3 = [P[0] + t[0] * step, P[1] + t[1] * step, P[2] + t[2] * step];
      const gl = Math.hypot(G[0], G[1], G[2]);
      if (!(gl > 0)) break;
      const [u, v] = basicFromDir(G);
      if (v < 0.01 || v > 0.99) break;
      const d = sampleDist(data, u, v);
      if (!(d > 0) || Math.abs(d - gl) / Math.min(d, gl) > 0.12) break; // sky / another object
      const Q: V3 = [(G[0] / gl) * d, (G[1] / gl) * d, (G[2] / gl) * d];
      const moved = sub(Q, P);
      const len = Math.hypot(moved[0], moved[1], moved[2]);
      if (!(len > 1e-9)) break;
      // keep heading "straight" along the surface: new direction = the step actually taken,
      // blended with the old one so depth noise doesn't make the walk wander
      t = norm([moved[0] / len + t[0], moved[1] / len + t[1], moved[2] / len + t[2]]);
      P = Q;
      left -= len;
    }
    ring.push(basicFromDir(P));
  }
  ring.push(ring[0]);
  return ring;
}
