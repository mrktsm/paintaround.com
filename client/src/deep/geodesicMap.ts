/**
 * Geodesic surface unwrap ("discrete exponential map") for one stroke.
 *
 * Starting at the stroke's first point, we flood outwards over the panorama's pixels in order of
 * distance measured *along the surface* (Dijkstra on the depth map), and give every reached pixel
 * a 2D coordinate on one continuous, unfolded sheet — the "decal" space the drawing tools paint
 * in. Each pixel's coordinate comes from its already-placed neighbours via their tangent planes,
 * with the tangent frame carried along (parallel transport), so the sheet bends smoothly around
 * corners (wall -> floor) and curves (a bus roof) instead of being a flat patch.
 *
 * Only a corridor around the drawn path is unwrapped (openTo): the work grows with the stroke's
 * length, not with the area of a disc around its start, so long fast strokes stay cheap.
 *
 * The flood does not cross depth jumps (a pole in front of a wall, the edge of a car) or the sky
 * (distance 0 in the data), so paint stays on the surface it was started on.
 *
 * Output per reached pixel: decal (x, y) — packed into an RGBA32F texture for the GPU shader that
 * draws the live stroke, and used on the CPU to bake the finished stroke into an equirect bitmap.
 */
import { type DeepData } from './surfaceDecal';
import { sampleSurface } from './paintSurface';

const W = 2048;
const H = 1024;
const TWO_PI = Math.PI * 2;

type V3 = [number, number, number];
export type Basis = { P0: V3; n: V3; nSurf: V3; t1: V3; t2: V3; s: number };

type Buffers = { geo: Float32Array; state: Uint8Array; allowed: Uint8Array; nearDist: Float32Array; frame: Float32Array; tex: Float32Array; cellNext: Int32Array };
const pool: Buffers[] = [];
/** half-width (panorama px) of the unwrapped corridor around the path */
const CORRIDOR = 40;
/** decal -> panorama lookups: placed nodes bucketed by 16 decal px, as linked lists */
const CELL = 16, CELLS = 2048 / CELL;

export class GeodesicMap {
  /** region of panorama pixels this stroke may cover (origin col j0 is unwrapped, may be < 0) */
  static RW = 768;
  static RH = 576;
  readonly RW = GeodesicMap.RW;
  readonly RH = GeodesicMap.RH;
  readonly i0: number;
  readonly j0: number;
  /** decal canvas size + centre (seed point) */
  readonly size = 2048;
  readonly cx = 1024;
  readonly cy = 1024;
  readonly s: number; // world units per decal px

  private data: DeepData;
  private geo: Float32Array; // geodesic distance (Infinity = not reached)
  private state: Uint8Array; // 0 untouched, 1 queued, 2 placed
  private allowed: Uint8Array; // inside the opened corridor
  private nearDist: Float32Array; // surface distance to the nearest drawn path point (paint mask)
  private cosLat!: Float32Array;
  private sinLat!: Float32Array;
  private cosLon!: Float32Array;
  private sinLon!: Float32Array;
  private frame: Float32Array; // t1 (3) + t2 (3) per node
  /** RGBA32F: decal x, decal y, paintable (near the drawn path) 1/0, 0 — uploaded to the GPU */
  readonly tex: Float32Array;
  private seedR: number;
  private seedC: number;
  private maxGeo: number;
  /**
   * Depth scaling: the sheet is stretched by k = dSeed / depth (clamped), so one decal px covers
   * about one *screen* px everywhere — not a fixed real-world size. Without it a stroke started
   * far away balloons as it's pulled towards the camera (and shrinks going away), no longer
   * matching the brush cursor. Distances (`geo`, radii, limits) are in "seed world units"
   * (= decal px * s) under this scaled metric.
   */
  private dSeed: number;
  static KMAX = 8;
  /**
   * How much the brush keeps its on-screen size with depth: 0 = fixed real-world size (full
   * perspective, strokes balloon up close), 1 = fixed screen size (flat look), between = blend.
   * Live-tunable in dev via `window.__brushPerspective = 0.5`.
   */
  static SCREEN_LOCK = 0.5;
  private alpha: number;
  // binary heap (key = geodesic distance, lazy deletion)
  private hk: number[] = [];
  private hv: number[] = [];
  private cellHead = new Int32Array(CELLS * CELLS).fill(-1);
  private cellNext: Int32Array;
  /** rows of the buffers in use (only these are cleared when they're reused) */
  private usedR0 = Infinity;
  private usedR1 = -Infinity;
  /** last corridor disc (region px) */
  private openX = Infinity;
  private openY = Infinity;
  private released = false;
  /** bounding box of placed nodes (region coords) and of not-yet-uploaded changes */
  bbox = { r0: Infinity, c0: Infinity, r1: -Infinity, c1: -Infinity };
  dirty: { r0: number; c0: number; r1: number; c1: number } | null = null;
  /** bounding box of paintable nodes */
  paintBox = { r0: Infinity, c0: Infinity, r1: -Infinity, c1: -Infinity };

  constructor(data: DeepData, u: number, v: number, basis: Basis) {
    this.data = data;
    this.s = basis.s;
    const RW = this.RW, RH = this.RH;
    const si = Math.min(H - 1, Math.floor(v * H));
    const sj = Math.floor(u * W);
    this.i0 = Math.max(0, Math.min(H - RH, si - (RH >> 1)));
    this.j0 = sj - (RW >> 1);
    this.seedR = si - this.i0;
    this.seedC = sj - this.j0;
    this.dSeed = Math.hypot(basis.P0[0], basis.P0[1], basis.P0[2]) || 1;
    const tune = (globalThis as { __brushPerspective?: number }).__brushPerspective;
    this.alpha = Math.max(0, Math.min(1, typeof tune === 'number' ? tune : GeodesicMap.SCREEN_LOCK));
    // reuse buffers from finished strokes (avoids ~40MB of allocation + GC per stroke)
    const buf = pool.pop() ?? {
      geo: new Float32Array(RW * RH).fill(Infinity),
      state: new Uint8Array(RW * RH),
      allowed: new Uint8Array(RW * RH),
      nearDist: new Float32Array(RW * RH).fill(Infinity),
      frame: new Float32Array(RW * RH * 6),
      tex: new Float32Array(RW * RH * 4),
      cellNext: new Int32Array(RW * RH),
    };
    this.geo = buf.geo;
    this.state = buf.state;
    this.allowed = buf.allowed;
    this.nearDist = buf.nearDist;
    this.cellNext = buf.cellNext;
    this.frame = buf.frame; // only read for placed nodes, no reset needed
    this.tex = buf.tex;
    // trig tables for this region (3D positions become a few multiplications)
    this.cosLat = new Float32Array(RH); this.sinLat = new Float32Array(RH);
    this.cosLon = new Float32Array(RW); this.sinLon = new Float32Array(RW);
    for (let r = 0; r < RH; r++) {
      const lat = Math.PI / 2 - ((this.i0 + r + 0.5) / H) * Math.PI;
      this.cosLat[r] = Math.cos(lat); this.sinLat[r] = Math.sin(lat);
    }
    for (let c = 0; c < RW; c++) {
      const lon = ((this.j0 + c + 0.5) / W) * TWO_PI - Math.PI;
      this.cosLon[c] = Math.cos(lon); this.sinLon[c] = Math.sin(lon);
    }
    this.maxGeo = (this.size / 2 - 80) * this.s;
    const n0 = this.seedR * RW + this.seedC;
    this.frame.set(basis.t1, n0 * 6);
    this.frame.set(basis.t2, n0 * 6 + 3);
    this.allowed[n0] = 1;
    this.usedR0 = this.usedR1 = this.seedR;
    this.geo[n0] = 0;
    this.push(n0, 0);
    this.state[n0] = 1;
  }

  // ---------- coordinates ----------
  private point(n: number, out: number[]) {
    const r = (n / this.RW) | 0, c = n - r * this.RW;
    const j = this.j0 + c;
    const d = this.data.dist[(this.i0 + r) * W + (j >= 0 ? (j < W ? j : j - W) : j + W)];
    const cl = this.cosLat[r] * d;
    out[0] = cl * this.sinLon[c];
    out[1] = this.sinLat[r] * d;
    out[2] = cl * this.cosLon[c];
    return d;
  }

  /** Sheet scale at a point at distance d from the camera (see dSeed). */
  private k(d: number): number {
    const k = Math.pow(this.dSeed / d, this.alpha);
    return k > GeodesicMap.KMAX ? GeodesicMap.KMAX : k < 1 / GeodesicMap.KMAX ? 1 / GeodesicMap.KMAX : k;
  }

  /** World units per decal px at a basic point (the brush's real size there), or null over the sky. */
  worldPerPxAt(u: number, v: number): number | null {
    const d = this.distanceAt(u, v);
    return d > 0 ? this.s / this.k(d) : null;
  }

  /** How far away a point of the panorama is (0: sky). */
  distanceAt(u: number, v: number): number {
    const i = Math.min(H - 1, Math.max(0, Math.floor(v * H)));
    const j = (((Math.floor(u * W)) % W) + W) % W;
    return this.data.dist[i * W + j];
  }

    /** Return this stroke's buffers to the pool (call once the stroke is finished). */
  release(): void {
    if (this.released) return; // pooling the same buffers twice would garble two later strokes
    this.released = true;
    if (pool.length >= 3) return;
    if (this.usedR1 >= this.usedR0) {
      const a = this.usedR0 * this.RW, b = (this.usedR1 + 1) * this.RW;
      this.geo.fill(Infinity, a, b);
      this.state.fill(0, a, b);
      this.allowed.fill(0, a, b);
      this.nearDist.fill(Infinity, a, b);
      this.tex.fill(0, a * 4, b * 4);
    }
    pool.push({ geo: this.geo, state: this.state, allowed: this.allowed, nearDist: this.nearDist, frame: this.frame, tex: this.tex, cellNext: this.cellNext });
  }
  private normal(n: number, out: number[]) {
    const r = (n / this.RW) | 0, c = n - r * this.RW;
    const ni = (((this.i0 + r) >> 1) * 1024 + (((this.j0 + c) >> 1) & 1023)) * 3; // half resolution
    out[0] = this.data.normals[ni];
    out[1] = this.data.normals[ni + 1];
    out[2] = this.data.normals[ni + 2];
  }
  /** region (fractional) coords of a basic point, u unwrapped towards this region */
  private regionCoords(u: number, v: number): [number, number] {
    let x = u * W - 0.5 - this.j0;
    const mid = this.RW / 2;
    while (x - mid > W / 2) x -= W;
    while (mid - x > W / 2) x += W;
    return [x, v * H - 0.5 - this.i0];
  }

  // ---------- heap ----------
  private push(n: number, k: number) {
    const hk = this.hk, hv = this.hv;
    let i = hk.length;
    hk.push(k);
    hv.push(n);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= k) break;
      hk[i] = hk[p]; hv[i] = hv[p];
      i = p;
    }
    hk[i] = k; hv[i] = n;
  }
  private pop(): number {
    const hk = this.hk, hv = this.hv;
    const top = hv[0];
    const lk = hk.pop()!, lv = hv.pop()!;
    const len = hk.length;
    if (len > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = lk;
        if (l < len && hk[l] < mk) { m = l; mk = hk[l]; }
        if (r < len && hk[r] < mk) { m = r; mk = hk[r]; }
        if (m === i) break;
        hk[i] = hk[m]; hv[i] = hv[m];
        i = m;
      }
      hk[i] = lk; hv[i] = lv;
    }
    return top;
  }

  // ---------- flood ----------
  private P = [0, 0, 0];
  private Q = [0, 0, 0];
  private N = [0, 0, 0];
  private NK = [0, 0, 0];
  private BQ = [0, 0, 0];

  /** Place the cheapest queued node: compute its decal coordinate + tangent frame. */
  private settle(n: number) {
    const RW = this.RW, RH = this.RH;
    const r = (n / RW) | 0, c = n - r * RW;
    const P = this.P, Q = this.Q, N = this.N, NK = this.NK;
    const dq = this.point(n, P);
    this.normal(n, N);
    let x = this.cx, y = this.cy;
    if (!(r === this.seedR && c === this.seedC)) {
      // average the predictions of all placed neighbours (upwind), weighted by 1/edge length
      let sx = 0, sy = 0, sw = 0, best = -1, bestG = Infinity;
      const bQ = this.BQ;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= RH) continue;
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const cc = c + dc;
          if (cc < 0 || cc >= RW) continue;
          const k = rr * RW + cc;
          if (this.state[k] !== 2) continue;
          const dk = this.point(k, Q);
          this.normal(k, NK);
          const ke = 0.5 * (this.k(dq) + this.k(dk));
          let ex = P[0] - Q[0], ey = P[1] - Q[1], ez = P[2] - Q[2];
          const len = Math.hypot(ex, ey, ez);
          if (!(len > 0)) continue;
          // project the step onto the neighbour's tangent plane, keep its length
          const dn = ex * NK[0] + ey * NK[1] + ez * NK[2];
          ex -= dn * NK[0]; ey -= dn * NK[1]; ez -= dn * NK[2];
          const pl = Math.hypot(ex, ey, ez) || 1;
          ex *= (len * ke) / pl; ey *= (len * ke) / pl; ez *= (len * ke) / pl;
          const f = k * 6, fr = this.frame;
          const a = (ex * fr[f] + ey * fr[f + 1] + ez * fr[f + 2]) / this.s;
          const b = (ex * fr[f + 3] + ey * fr[f + 4] + ez * fr[f + 5]) / this.s;
          const w = 1 / len;
          sx += (this.tex[k * 4] + a) * w;
          sy += (this.tex[k * 4 + 1] + b) * w;
          sw += w;
          const g = this.geo[k] + len * ke;
          if (g < bestG) { bestG = g; best = k; bQ[0] = Q[0]; bQ[1] = Q[1]; bQ[2] = Q[2]; }
        }
      }
      if (sw === 0 || best < 0) return; // isolated — leave unplaced
      x = sx / sw;
      y = sy / sw;
      // transport the best parent's frame onto this node's tangent plane
      const f = best * 6, fr = this.frame;
      let t1x = fr[f], t1y = fr[f + 1], t1z = fr[f + 2];
      const d1 = t1x * N[0] + t1y * N[1] + t1z * N[2];
      t1x -= d1 * N[0]; t1y -= d1 * N[1]; t1z -= d1 * N[2];
      const l1 = Math.hypot(t1x, t1y, t1z) || 1;
      t1x /= l1; t1y /= l1; t1z /= l1;
      // The depth scaling bends "straight" on the sheet: carrying the frame under the scaled
      // metric rotates it about the normal by n . (step x grad log k), grad log k = -X_tan/|X|^2.
      // (Without this, neighbours disagree and the sheet's sideways scale drifts.)
      if (this.k(dq) < GeodesicMap.KMAX && this.k(dq) > 1 / GeodesicMap.KMAX) {
        const inv = this.alpha / (dq * dq);
        const pn = P[0] * N[0] + P[1] * N[1] + P[2] * N[2];
        const gx = -(P[0] - pn * N[0]) * inv, gy = -(P[1] - pn * N[1]) * inv, gz = -(P[2] - pn * N[2]) * inv;
        const sx2 = P[0] - bQ[0], sy2 = P[1] - bQ[1], sz2 = P[2] - bQ[2];
        const th = (N[0] * (sy2 * gz - sz2 * gy) + N[1] * (sz2 * gx - sx2 * gz) + N[2] * (sx2 * gy - sy2 * gx));
        if (th) {
          const c = Math.cos(th), sn = Math.sin(th);
          const ux = N[1] * t1z - N[2] * t1y, uy = N[2] * t1x - N[0] * t1z, uz = N[0] * t1y - N[1] * t1x;
          t1x = t1x * c + ux * sn; t1y = t1y * c + uy * sn; t1z = t1z * c + uz * sn;
        }
      }
      // t2 = n x t1 (same handedness as the seed frame: +y = "down the surface")
      const t2x = N[1] * t1z - N[2] * t1y, t2y = N[2] * t1x - N[0] * t1z, t2z = N[0] * t1y - N[1] * t1x;
      const fo = n * 6;
      fr[fo] = t1x; fr[fo + 1] = t1y; fr[fo + 2] = t1z; fr[fo + 3] = t2x; fr[fo + 4] = t2y; fr[fo + 5] = t2z;
    }
    if (x < 1 || y < 1 || x > this.size - 2 || y > this.size - 2) return; // ran off the decal canvas
    this.state[n] = 2;
    const t = n * 4;
    this.tex[t] = x;
    this.tex[t + 1] = y;
    this.tex[t + 2] = 0; // paintable only once near the drawn path (markNear)
    const cell = ((y / CELL) | 0) * CELLS + ((x / CELL) | 0);
    this.cellNext[n] = this.cellHead[cell];
    this.cellHead[cell] = n;
    const bb = this.bbox;
    if (r < bb.r0) bb.r0 = r; if (r > bb.r1) bb.r1 = r;
    if (c < bb.c0) bb.c0 = c; if (c > bb.c1) bb.c1 = c;
    const d = this.dirty;
    if (!d) this.dirty = { r0: r, c0: c, r1: r, c1: c };
    else {
      if (r < d.r0) d.r0 = r; if (r > d.r1) d.r1 = r;
      if (c < d.c0) d.c0 = c; if (c > d.c1) d.c1 = c;
    }

    // relax neighbours (don't cross depth jumps or the sky)
    for (let dr = -1; dr <= 1; dr++) {
      const rr = r + dr;
      if (rr < 0 || rr >= RH) continue;
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const cc = c + dc;
        if (cc < 0 || cc >= RW) continue;
        const m = rr * RW + cc;
        if (this.state[m] === 2 || !this.allowed[m]) continue;
        const dm = this.point(m, Q);
        if (!(dm > 0)) continue; // sky / no surface
        if (Math.abs(dm - dq) / Math.min(dm, dq) > 0.12) continue; // depth jump = another object
        const g = this.geo[n] + Math.hypot(Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]) * 0.5 * (this.k(dq) + this.k(dm));
        if (g < this.geo[m] && g <= this.maxGeo) {
          this.geo[m] = g;
          this.state[m] = 1;
          this.push(m, g);
        }
      }
    }
  }

  /** Unwrap what the corridor allows (bounded work per call; the rest continues next call). */
  private expand(budget: number): void {
    while (this.hk.length && budget > 0) {
      const n = this.pop();
      if (this.state[n] === 2) continue;
      this.settle(n);
      budget--;
    }
  }

  /** Open the corridor around a basic point and unwrap it. radius in panorama px. */
  openTo(u: number, v: number, radius = CORRIDOR, force = false): void {
    const [x, y] = this.regionCoords(u, v);
    if (!force && Math.hypot(x - this.openX, y - this.openY) < radius * 0.35) {
      if (this.hk.length) this.expand(20000);
      return;
    }
    if (!force) { this.openX = x; this.openY = y; }
    const RW = this.RW, RH = this.RH, P = [0, 0, 0], Q = [0, 0, 0];
    const rc = Math.max(0, Math.min(RH - 1, Math.round(y)));
    const rx = radius * Math.min(4, 1 / Math.max(0.05, this.cosLat[rc]));
    const r0 = Math.max(0, Math.ceil(y - radius)), r1 = Math.min(RH - 1, Math.floor(y + radius));
    if (r1 >= r0) { this.usedR0 = Math.min(this.usedR0, r0); this.usedR1 = Math.max(this.usedR1, r1); }
    for (let r = r0; r <= r1; r++) {
      const t = (r - y) / radius, half = rx * Math.sqrt(Math.max(0, 1 - t * t));
      const c0 = Math.max(0, Math.ceil(x - half)), c1 = Math.min(RW - 1, Math.floor(x + half));
      for (let c = c0; c <= c1; c++) {
        const m = r * RW + c;
        if (this.allowed[m]) continue;
        this.allowed[m] = 1;
        // touching what's already unwrapped: the flood continues from there
        let dm = -1;
        for (let dr = -1; dr <= 1; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= RH) continue;
          for (let dc = -1; dc <= 1; dc++) {
            const cc = c + dc;
            if (cc < 0 || cc >= RW) continue;
            const k = rr * RW + cc;
            if (this.state[k] !== 2) continue;
            if (dm < 0) dm = this.point(m, Q);
            if (!(dm > 0)) continue;
            const dk = this.point(k, P);
            if (Math.abs(dm - dk) / Math.min(dm, dk) > 0.12) continue;
            const g = this.geo[k] + Math.hypot(Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]) * 0.5 * (this.k(dk) + this.k(dm));
            if (g < this.geo[m] && g <= this.maxGeo) {
              this.geo[m] = g;
              this.state[m] = 1;
              this.push(m, g);
            }
          }
        }
      }
    }
    this.expand(60000);
  }

  private nodeAt(u: number, v: number): number {
    const [x, y] = this.regionCoords(u, v);
    const c = Math.round(x), r = Math.round(y);
    if (r < 0 || r >= this.RH || c < 0 || c >= this.RW) return -1;
    return r * this.RW + c;
  }

  /** Is this basic point on a surface at all (not sky)? */
  isSurface(u: number, v: number): boolean {
    const i = Math.min(H - 1, Math.max(0, Math.floor(v * H)));
    const j = (((Math.floor(u * W)) % W) + W) % W;
    return this.data.dist[i * W + j] > 0;
  }

  /**
   * Decal coordinate of a basic point, unwrapping the corridor there if needed.
   * null = not reachable along the surface (other object / sky / past the decal's edge).
   */
  reach(u: number, v: number): [number, number] | null {
    const n = this.nodeAt(u, v);
    if (n < 0) return null;
    this.openTo(u, v);
    return this.state[n] === 2 ? this.decalAt(u, v) : null;
  }

  /**
   * A short step between two basic points: its straight 3D length in decal px, and how much the
   * depth changes (1 = none). Tells a step along one surface from a jump to another.
   */
  step(a: [number, number], b: [number, number]): { px: number; depth: number } {
    const at = (p: [number, number]) => {
      const i = Math.min(H - 1, Math.max(0, Math.floor(p[1] * H)));
      const j = (((Math.floor(p[0] * W)) % W) + W) % W;
      const d = this.data.dist[i * W + j], lon = p[0] * TWO_PI, lat = Math.PI / 2 - p[1] * Math.PI, c = Math.cos(lat) * d;
      return [c * Math.sin(lon), Math.sin(lat) * d, c * Math.cos(lon), d];
    };
    const A = at(a), B = at(b), lo = Math.min(A[3], B[3]), hi = Math.max(A[3], B[3]);
    if (!(lo > 0)) return { px: Infinity, depth: Infinity };
    return { px: (Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) * this.k(lo)) / this.s, depth: hi / lo };
  }

  /** Bilinear decal coordinate at a basic point from placed nodes only (no growth). */
  decalAt(u: number, v: number): [number, number] | null {
    const [x, y] = this.regionCoords(u, v);
    const c0 = Math.floor(x), r0 = Math.floor(y);
    const fx = x - c0, fy = y - r0;
    let sx = 0, sy = 0, sw = 0;
    for (let dr = 0; dr < 2; dr++) {
      const r = r0 + dr;
      if (r < 0 || r >= this.RH) continue;
      for (let dc = 0; dc < 2; dc++) {
        const c = c0 + dc;
        if (c < 0 || c >= this.RW) continue;
        const k = r * this.RW + c;
        if (this.state[k] !== 2) continue;
        const w = (dc ? fx : 1 - fx) * (dr ? fy : 1 - fy);
        sx += this.tex[k * 4] * w;
        sy += this.tex[k * 4 + 1] * w;
        sw += w;
      }
    }
    if (sw < 1e-4) return null;
    return [sx / sw, sy / sw];
  }

  /**
   * Mark the surface within `radius` (world units, measured along the surface) of a drawn point as
   * paintable. Only paintable pixels show paint — so if the unwrap ever "folds" (two separate
   * patches getting overlapping sheet coordinates), no ghost copy of the stroke appears.
   */
  markNear(u: number, v: number, radius: number): void {
    const start = this.nodeAt(u, v);
    if (start < 0 || this.state[start] !== 2 || this.nearDist[start] <= 0) return;
    const RW = this.RW, RH = this.RH, near = this.nearDist;
    const P = [0, 0, 0], Q = [0, 0, 0];
    // relaxing distances already in nearDist: nodes another path point is closer to stop the flood,
    // so marking along a path costs little more than its area
    const queue: number[] = [start];
    near[start] = 0;
    this.mark(start);
    for (let qi = 0; qi < queue.length; qi++) {
      const n = queue[qi], d = near[n];
      const r = (n / RW) | 0, c = n - r * RW;
      const dP = this.point(n, P);
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= RH) continue;
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const cc = c + dc;
          if (cc < 0 || cc >= RW) continue;
          const m = rr * RW + cc;
          if (this.state[m] !== 2) continue; // only over the placed (connected) surface
          const dQ = this.point(m, Q);
          const nd = d + Math.hypot(Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]) * 0.5 * (this.k(dP) + this.k(dQ));
          if (nd > radius || nd >= near[m]) continue;
          near[m] = nd;
          this.mark(m);
          queue.push(m);
        }
      }
    }
  }

  private mark(n: number): void {
    const t = n * 4 + 2;
    if (this.tex[t] !== 0) return;
    this.tex[t] = 1;
    const r = (n / this.RW) | 0, c = n - r * this.RW;
    const pb = this.paintBox;
    if (r < pb.r0) pb.r0 = r; if (r > pb.r1) pb.r1 = r;
    if (c < pb.c0) pb.c0 = c; if (c > pb.c1) pb.c1 = c;
    const d = this.dirty;
    if (!d) this.dirty = { r0: r, c0: c, r1: r, c1: c };
    else {
      if (r < d.r0) d.r0 = r; if (r > d.r1) d.r1 = r;
      if (c < d.c0) d.c0 = c; if (c > d.c1) d.c1 = c;
    }
  }

  /** Decal -> basic (inverse): the nearest placed node. */
  basicAt(x: number, y: number): [number, number] | null {
    const bx = Math.floor(x / CELL), by = Math.floor(y / CELL);
    let best = -1, bd = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const cx = bx + dx, cy = by + dy;
      if (cx < 0 || cy < 0 || cx >= CELLS || cy >= CELLS) continue;
      for (let k = this.cellHead[cy * CELLS + cx]; k >= 0; k = this.cellNext[k]) {
        const ddx = this.tex[k * 4] - x, ddy = this.tex[k * 4 + 1] - y;
        const d = ddx * ddx + ddy * ddy;
        if (d < bd) { bd = d; best = k; }
      }
    }
    if (best < 0) return null;
    const r = (best / this.RW) | 0, c = best - r * this.RW;
    return [(this.j0 + c + 0.5) / W, (this.i0 + r + 0.5) / H];
  }

  /**
   * Bake the finished stroke: sample the tool's decal-space drawing at every reached pixel inside
   * `rect` (decal px) and write an equirect bitmap (supersampled), shaded by the surface map.
   * Returns the bitmap + a grid of basic coords spanning it corner to corner.
   */
  bake(
    src: ImageData, // the tool drawing for `rect` only (top-left = rect.x0, rect.y0)
    rect: { x0: number; y0: number; w: number; h: number },
    surface: Float32Array | null,
    ss = 2,
  ): BakedPiece | null {
    // which region pixels map into the tool's drawn rectangle?
    const { x0, y0, w, h } = rect;
    let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity;
    const bb = this.paintBox;
    for (let r = bb.r0; r <= bb.r1; r++) for (let c = bb.c0; c <= bb.c1; c++) {
      const k = r * this.RW + c;
      if (this.tex[k * 4 + 2] < 0.5) continue;
      const x = this.tex[k * 4], y = this.tex[k * 4 + 1];
      if (x < x0 - 2 || y < y0 - 2 || x > x0 + w + 2 || y > y0 + h + 2) continue;
      if (r < r0) r0 = r; if (r > r1) r1 = r;
      if (c < c0) c0 = c; if (c > c1) c1 = c;
    }
    if (!isFinite(r0)) return null;
    r0 = Math.max(0, r0 - 1); c0 = Math.max(0, c0 - 1);
    r1 = Math.min(this.RH - 1, r1 + 1); c1 = Math.min(this.RW - 1, c1 + 1);
    const pw = c1 - c0 + 1, ph = r1 - r0 + 1;
    const ow = pw * ss, oh = ph * ss;
    const out = document.createElement('canvas');
    out.width = ow;
    out.height = oh;
    const octx = out.getContext('2d')!;
    const img = octx.createImageData(ow, oh);
    const o = img.data, sd = src.data, SW = src.width, SH = src.height;
    const shade = new Float32Array(3);
    for (let oy = 0; oy < oh; oy++) {
      const ry = r0 + (oy + 0.5) / ss - 0.5;
      const rb = Math.floor(ry), fy = ry - rb;
      for (let ox = 0; ox < ow; ox++) {
        const rx = c0 + (ox + 0.5) / ss - 0.5;
        const cb = Math.floor(rx), fx = rx - cb;
        // bilinear decal coord from placed nodes
        let sx = 0, sy = 0, sw = 0;
        for (let dr = 0; dr < 2; dr++) {
          const r = rb + dr;
          if (r < 0 || r >= this.RH) continue;
          for (let dc = 0; dc < 2; dc++) {
            const c = cb + dc;
            if (c < 0 || c >= this.RW) continue;
            const k = r * this.RW + c;
            if (this.tex[k * 4 + 2] < 0.5) continue;
            const wt = (dc ? fx : 1 - fx) * (dr ? fy : 1 - fy);
            sx += this.tex[k * 4] * wt; sy += this.tex[k * 4 + 1] * wt; sw += wt;
          }
        }
        if (sw < 0.5) continue;
        const dx = sx / sw - 0.5 - x0, dy = sy / sw - 0.5 - y0;
        // bilinear sample of the tool drawing (premultiply for correct filtering)
        const ix = Math.floor(dx), iy = Math.floor(dy);
        if (ix < 0 || iy < 0 || ix + 1 >= SW || iy + 1 >= SH) continue;
        const ax = dx - ix, ay = dy - iy;
        let cr = 0, cg = 0, cbb = 0, ca = 0;
        for (let k = 0; k < 4; k++) {
          const px = ix + (k & 1), py = iy + (k >> 1);
          const wt = ((k & 1) ? ax : 1 - ax) * ((k >> 1) ? ay : 1 - ay);
          const q = (py * SW + px) * 4;
          const a = sd[q + 3] * wt;
          cr += sd[q] * a; cg += sd[q + 1] * a; cbb += sd[q + 2] * a; ca += a;
        }
        if (ca < 0.5) continue;
        let R = cr / ca, G = cg / ca, B = cbb / ca;
        if (surface) {
          // region px (rx, ry) has its centre at panorama px (j0 + rx + 0.5, i0 + ry + 0.5)
          sampleSurface(surface, (this.j0 + rx + 0.5) / W, (this.i0 + ry + 0.5) / H, shade);
          R = srgb8(lin8(R) * shade[0]); G = srgb8(lin8(G) * shade[1]); B = srgb8(lin8(B) * shade[2]);
        }
        const edge = Math.min(1, (sw - 0.5) * 2);
        const q = (oy * ow + ox) * 4;
        o[q] = R; o[q + 1] = G; o[q + 2] = B; o[q + 3] = ca * edge;
      }
    }
    octx.putImageData(img, 0, 0);
    return { canvas: out, col: this.j0 + c0, row: this.i0 + r0, cols: pw, rows: ph, ss };
  }
}

/** A finished piece: its bitmap covers panorama px [col, col + cols) x [row, row + rows), ss times finer. */
export interface BakedPiece { canvas: HTMLCanvasElement; col: number; row: number; cols: number; rows: number; ss: number }

/** The grid of basic coords spanning a baked rectangle corner to corner (u unwrapped). */
export function pieceGrid(p: { col: number; row: number; cols: number; rows: number }): { gridBasic: [number, number][][]; rows: number; cols: number } {
  const rows = Math.max(1, Math.min(16, Math.ceil(p.rows / 24)));
  const cols = Math.max(1, Math.min(16, Math.ceil(p.cols / 24)));
  const gridBasic: [number, number][][] = [];
  for (let gr = 0; gr <= rows; gr++) {
    const row: [number, number][] = [];
    for (let gc = 0; gc <= cols; gc++) row.push([(p.col + (gc / cols) * p.cols) / W, (p.row + (gr / rows) * p.rows) / H]);
    gridBasic.push(row);
  }
  return { gridBasic, rows, cols };
}

/** Pieces of one stroke (it crossed surfaces) as one bitmap, oldest first. */
export function mergePieces(pieces: BakedPiece[]): BakedPiece {
  if (pieces.length === 1) return pieces[0];
  const ss = pieces[0].ss;
  // u is unwrapped per piece: bring every piece next to the first one
  const mid = pieces[0].col + pieces[0].cols / 2;
  const placed = pieces.map((p) => ({ p, col: p.col - Math.round((p.col + p.cols / 2 - mid) / W) * W }));
  let col = Math.min(...placed.map((q) => q.col));
  const row = Math.min(...pieces.map((p) => p.row));
  const right = Math.max(...placed.map((q) => q.col + q.p.cols)), bottom = Math.max(...pieces.map((p) => p.row + p.rows));
  // all the way around: one full turn, wrapped
  const full = right - col > W;
  if (full) col = 0;
  const cols = full ? W : right - col, rows = bottom - row;
  const canvas = document.createElement('canvas');
  canvas.width = cols * ss;
  canvas.height = rows * ss;
  const ctx = canvas.getContext('2d')!;
  for (const q of placed) {
    for (const shift of full ? [-2 * W, -W, 0, W, 2 * W] : [0]) ctx.drawImage(q.p.canvas, (q.col + shift - col) * ss, (q.p.row - row) * ss);
  }
  return { canvas, col, row, cols, rows, ss };
}

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const lin8 = (v: number) => LIN[Math.max(0, Math.min(255, v | 0))];
const srgb8 = (c: number) => {
  c = c <= 0 ? 0 : c >= 1 ? 1 : c;
  return (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255;
};
