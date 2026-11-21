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
 * The flood does not cross depth jumps (a pole in front of a wall, the edge of a car) or the sky
 * (distance 0 in the data), so paint stays on the surface it was started on.
 *
 * Output per reached pixel: decal (x, y) — packed into an RGBA32F texture for the GPU shader that
 * draws the live stroke, and used on the CPU to bake the finished stroke into an equirect bitmap.
 */
import { normalIndex, type DeepData } from './surfaceDecal';
import { sampleSurface } from './paintSurface';

const W = 2048;
const H = 1024;
const TWO_PI = Math.PI * 2;

type V3 = [number, number, number];
export type Basis = { P0: V3; n: V3; nSurf: V3; t1: V3; t2: V3; s: number };

type Buffers = { geo: Float32Array; state: Uint8Array; nearDist: Float32Array; frame: Float32Array; tex: Float32Array };
const pool: Buffers[] = [];

export class GeodesicMap {
  /** region of panorama pixels this stroke may cover (origin col j0 is unwrapped, may be < 0) */
  static RW = 1024;
  static RH = 768;
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
  private P0: V3;
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
  // spatial hash for decal -> basic (inverse lookups by the tools)
  private buckets = new Map<number, number[]>();
  private exact = new Map<string, [number, number]>();
  /** bounding box of placed nodes (region coords) and of not-yet-uploaded changes */
  bbox = { r0: Infinity, c0: Infinity, r1: -Infinity, c1: -Infinity };
  dirty: { r0: number; c0: number; r1: number; c1: number } | null = null;
  version = 0;

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
    this.P0 = basis.P0;
    this.dSeed = Math.hypot(basis.P0[0], basis.P0[1], basis.P0[2]) || 1;
    const tune = (globalThis as any).__brushPerspective;
    this.alpha = Math.max(0, Math.min(1, typeof tune === 'number' ? tune : GeodesicMap.SCREEN_LOCK));
    // reuse buffers from finished strokes (avoids ~40MB of allocation + GC per stroke)
    const buf = pool.pop() ?? {
      geo: new Float32Array(RW * RH),
      state: new Uint8Array(RW * RH),
      nearDist: new Float32Array(RW * RH),
      frame: new Float32Array(RW * RH * 6),
      tex: new Float32Array(RW * RH * 4),
    };
    this.geo = buf.geo.fill(Infinity);
    this.state = buf.state.fill(0);
    this.nearDist = buf.nearDist.fill(Infinity);
    this.frame = buf.frame; // only read for placed nodes, no reset needed
    this.tex = buf.tex.fill(0);
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
    this.frame.set([...basis.t1, ...basis.t2], n0 * 6);
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
    const i = Math.min(H - 1, Math.max(0, Math.floor(v * H)));
    const j = (((Math.floor(u * W)) % W) + W) % W;
    const d = this.data.dist[i * W + j];
    return d > 0 ? this.s / this.k(d) : null;
  }

    /** Return this stroke's buffers to the pool (call once the stroke is finished). */
  release(): void {
    if (pool.length < 2 && this.geo) pool.push({ geo: this.geo, state: this.state, nearDist: this.nearDist, frame: this.frame, tex: this.tex });
  }
  private normal(n: number, out: number[]) {
    const r = (n / this.RW) | 0, c = n - r * this.RW;
    const ni = normalIndex((this.j0 + c + 0.5) / W, (this.i0 + r + 0.5) / H);
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
      this.frame.set([t1x, t1y, t1z, t2x, t2y, t2z], n * 6);
    }
    if (x < 1 || y < 1 || x > this.size - 2 || y > this.size - 2) return; // ran off the decal canvas
    this.state[n] = 2;
    const t = n * 4;
    this.tex[t] = x;
    this.tex[t + 1] = y;
    this.tex[t + 2] = 0; // paintable only once near the drawn path (markNear)
    const key = (Math.floor(x / 16) << 12) | Math.floor(y / 16);
    let bk = this.buckets.get(key);
    if (!bk) this.buckets.set(key, (bk = []));
    bk.push(n);
    const bb = this.bbox;
    if (r < bb.r0) bb.r0 = r; if (r > bb.r1) bb.r1 = r;
    if (c < bb.c0) bb.c0 = c; if (c > bb.c1) bb.c1 = c;
    const d = this.dirty;
    if (!d) this.dirty = { r0: r, c0: c, r1: r, c1: c };
    else {
      if (r < d.r0) d.r0 = r; if (r > d.r1) d.r1 = r;
      if (c < d.c0) d.c0 = c; if (c > d.c1) d.c1 = c;
    }
    this.version++;

    // relax neighbours (don't cross depth jumps or the sky)
    for (let dr = -1; dr <= 1; dr++) {
      const rr = r + dr;
      if (rr < 0 || rr >= RH) continue;
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const cc = c + dc;
        if (cc < 0 || cc >= RW) continue;
        const m = rr * RW + cc;
        if (this.state[m] === 2) continue;
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

  /** Grow the unwrap until geodesic distance `limit` (bounded work per call). */
  expand(limit: number, budget = 40000): void {
    while (this.hk.length && budget-- > 0) {
      if (this.hk[0] > limit) return;
      const n = this.pop();
      if (this.state[n] === 2) continue;
      this.settle(n);
    }
  }

  /** Frontier distance (how far the unwrap has grown). */
  get frontier(): number {
    return this.hk.length ? this.hk[0] : Infinity;
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
   * Decal coordinate of a basic point, growing the unwrap towards it if needed.
   * null = not reachable along the surface (other object / sky / too far) — at least for now.
   */
  reach(u: number, v: number, budget = 40000): [number, number] | null {
    const n = this.nodeAt(u, v);
    if (n < 0) return null;
    if (this.state[n] !== 2) {
      if (this.state[n] === 1) {
        this.expand(this.geo[n] + 1e-9, budget);
      } else {
        // not reached yet: grow up to a bound based on the straight-line distance
        // (a surface path is longer than the straight line, but not wildly so)
        const T = [0, 0, 0];
        const dT = this.point(n, T);
        if (!(dT > 0)) return null; // sky
        const straight = Math.hypot(T[0] - this.P0[0], T[1] - this.P0[1], T[2] - this.P0[2]) * Math.max(1, this.k(dT));
        this.expand(Math.min(this.maxGeo, straight * 2.5 + 20 * this.s), budget);
      }
      if (this.state[n] !== 2) return null;
    }
    return this.decalAt(u, v);
  }

  /** Geodesic distance from the seed to a placed/queued basic point (Infinity if unknown). */
  geoAt(u: number, v: number): number {
    const n = this.nodeAt(u, v);
    return n < 0 ? Infinity : this.geo[n];
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
    if (start < 0 || this.state[start] !== 2) return;
    const RW = this.RW, RH = this.RH;
    const P = [0, 0, 0], Q = [0, 0, 0];
    const qk: number[] = [0], qv: number[] = [start];
    const best = new Map<number, number>([[start, 0]]);
    while (qk.length) {
      // tiny local Dijkstra (linear-scan min is fine for a few thousand nodes)
      let mi = 0;
      for (let i = 1; i < qk.length; i++) if (qk[i] < qk[mi]) mi = i;
      const d = qk[mi], n = qv[mi];
      qk[mi] = qk[qk.length - 1]; qv[mi] = qv[qv.length - 1]; qk.pop(); qv.pop();
      if (d > (best.get(n) ?? Infinity)) continue;
      if (d < this.nearDist[n]) {
        this.nearDist[n] = d;
        if (this.tex[n * 4 + 2] === 0) {
          this.tex[n * 4 + 2] = 1;
          const r = (n / RW) | 0, c = n - r * RW;
          const dd = this.dirty;
          if (!dd) this.dirty = { r0: r, c0: c, r1: r, c1: c };
          else {
            if (r < dd.r0) dd.r0 = r; if (r > dd.r1) dd.r1 = r;
            if (c < dd.c0) dd.c0 = c; if (c > dd.c1) dd.c1 = c;
          }
        }
      } else if (n !== start) continue;
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
          if (nd > radius || nd >= (best.get(m) ?? Infinity) || nd >= this.nearDist[m]) continue;
          best.set(m, nd);
          qk.push(nd);
          qv.push(m);
        }
      }
    }
    this.version++;
  }

  /** Remember an exact decal -> basic pair (cursor points), so the tools' inverse lookups are exact. */
  remember(x: number, y: number, basic: [number, number]) {
    this.exact.set(`${x.toFixed(3)},${y.toFixed(3)}`, basic);
    if (this.exact.size > 4000) this.exact.delete(this.exact.keys().next().value!);
  }

  /** Decal -> basic (inverse): exact for remembered points, else nearest placed node. */
  basicAt(x: number, y: number): [number, number] | null {
    const ex = this.exact.get(`${x.toFixed(3)},${y.toFixed(3)}`);
    if (ex) return ex;
    const bx = Math.floor(x / 16), by = Math.floor(y / 16);
    let best = -1, bd = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const bk = this.buckets.get(((bx + dx) << 12) | (by + dy));
      if (!bk) continue;
      for (const k of bk) {
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
  ): { canvas: HTMLCanvasElement; gridBasic: [number, number][][]; rows: number; cols: number } | null {
    // which region pixels map into the tool's drawn rectangle?
    const { x0, y0, w, h } = rect;
    let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity;
    const bb = this.bbox;
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
    const rows = Math.max(1, Math.min(16, Math.ceil(ph / 24)));
    const cols = Math.max(1, Math.min(16, Math.ceil(pw / 24)));
    const gridBasic: [number, number][][] = [];
    for (let gr = 0; gr <= rows; gr++) {
      const row: [number, number][] = [];
      for (let gc = 0; gc <= cols; gc++) {
        const pc = this.j0 + c0 + (gc / cols) * pw; // unwrapped column — renderer is periodic in u
        const pr = this.i0 + r0 + (gr / rows) * ph;
        row.push([pc / W, pr / H]);
      }
      gridBasic.push(row);
    }
    return { canvas: out, gridBasic, rows, cols };
  }
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
