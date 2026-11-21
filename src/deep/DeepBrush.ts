import { RenderPass, type ICustomRenderer, type IViewer, type Viewer } from 'mapillary-js';
import * as THREE from 'three';
import { restoreSurfaceLighting } from './paintLighting';
import { loadPaintSurface } from './paintSurface';

/**
 * Deep Brush prototype — paint that keeps the photo's shadows/texture and wraps onto 3D surfaces.
 *
 * Per panorama we load two precomputed layers (see research/deep-brush):
 *   distance  – DA² panoramic depth (scale-invariant), 2048x1024
 *   shading   – light/shadow from an intrinsic decomposition, normalised so lit surfaces ≈ 1
 *
 * Strokes are stored as lists of image (basic) coordinates and rasterised into a 2048x1024 RGBA
 * layer in the panorama's own equirect space, which is drawn on a sphere that Mapillary's transform
 * aligns exactly with the panorama. Nothing is saved anywhere.
 *
 * Render modes (switchable at any time, all strokes re-render):
 *   flat    – constant-width stroke, plain paint colour (what the app does today)
 *   shaded  – same footprint, painted colour = paint × shading (keeps shadows, cracks, ribs…)
 *   wrap    – footprint measured in 3D on the actual surface + shading: foreshortens on the
 *             ground/walls and stays on the object it started on
 */

export type DeepMode = 'flat' | 'shaded' | 'wrap';
export type PaintMaterial = 'refined' | 'refined-grey' | 'lit-texture' | 'lighting' | 'photo' | 'flat';
type RGB = [number, number, number];
type Stroke = { color: RGB; size: number; pts: [number, number][] };

const W = 2048;
const H = 1024;
const TWO_PI = Math.PI * 2;

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => {
  c = Math.min(Math.max(c, 0), 1);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
};
export const hexToRgb = (hex: string): RGB => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
];

export class DeepLayers {
  // per-row / per-column trig so 3D points are cheap: P = dir(i,j) * dist
  private cosLat = new Float32Array(H);
  private sinLat = new Float32Array(H);
  private cosLon = new Float32Array(W);
  private sinLon = new Float32Array(W);
  dist: Float32Array;
  shade: Float32Array;
  surface?: Float32Array;
  litSurface?: Float32Array;
  /** Grey refined lighting (the first approved Colosseum version). */
  refinedSurface?: Float32Array;
  /** The material the regular drawing tools use: interleaved RGB (coloured lighting when available). */
  paintSurface?: Float32Array;

  constructor(dist: Float32Array, shade: Float32Array, surface?: Float32Array, refinedShade?: Float32Array, paintSurface?: Float32Array) {
    this.paintSurface = paintSurface;
    this.dist = dist;
    this.shade = shade;
    this.surface = surface;
    this.litSurface = surface ? restoreSurfaceLighting(shade, surface) : undefined;
    this.refinedSurface = surface && refinedShade ? restoreSurfaceLighting(shade, surface, refinedShade) : undefined;
    for (let i = 0; i < H; i++) {
      const lat = Math.PI / 2 - ((i + 0.5) / H) * Math.PI;
      this.cosLat[i] = Math.cos(lat);
      this.sinLat[i] = Math.sin(lat);
    }
    for (let j = 0; j < W; j++) {
      const lon = ((j + 0.5) / W) * TWO_PI - Math.PI;
      this.cosLon[j] = Math.cos(lon);
      this.sinLon[j] = Math.sin(lon);
    }
  }

  static async load(imageId: string, includeSurface = false, includeRefined = false): Promise<DeepLayers | null> {
    try {
      const names = includeSurface ? ['distance', 'shading', 'surface'] : ['distance', 'shading'];
      if (includeRefined) {
        if (!includeSurface) throw new Error('Refined lighting requires the surface layer.');
        names.push('shading-view');
      }
      const [buffers, paint] = await Promise.all([
        Promise.all(names.map((n) => fetch(`/deep-layers/${imageId}/${n}.f32`).then((r) => (r.ok ? r.arrayBuffer() : null)))),
        includeRefined ? loadPaintSurface(imageId) : Promise.resolve(null),
      ]);
      if (buffers.some(buffer => !buffer || buffer.byteLength !== W * H * 4)) return null;
      return new DeepLayers(new Float32Array(buffers[0]!), new Float32Array(buffers[1]!),
        buffers[2] ? new Float32Array(buffers[2]) : undefined,
        buffers[3] ? new Float32Array(buffers[3]) : undefined,
        paint ?? undefined);
    } catch {
      return null;
    }
  }

  point(i: number, j: number, out: number[]) {
    const d = this.dist[i * W + j];
    out[0] = this.cosLat[i] * this.sinLon[j] * d;
    out[1] = this.sinLat[i] * d;
    out[2] = this.cosLat[i] * this.cosLon[j] * d;
    return out;
  }
  cosLatAt(i: number) {
    return this.cosLat[i];
  }
}

export class DeepBrush implements ICustomRenderer {
  id = 'deep-brush';
  renderPass = RenderPass.Opaque;

  mode: DeepMode = 'wrap';
  /** 0 = paint ignores the photo (opaque, flat), 1 = full shading/texture multiplied in. */
  textureAmount = 0.5;
  material: PaintMaterial = 'lighting';
  strokes: Stroke[] = [];
  private redoStack: Stroke[] = [];
  private active: Stroke | null = null;

  private layers: DeepLayers | null = null;
  private committed = new Uint8ClampedArray(W * H * 4); // all finished strokes
  private display = new Uint8ClampedArray(W * H * 4); // committed + active stroke
  private cov = new Float32Array(W * H); // active stroke coverage
  private touched: number[] = [];
  private touchedFlag = new Uint8Array(W * H);

  private viewer: Viewer | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private texture: THREE.DataTexture;
  private mesh: THREE.Mesh | null = null;
  private transform: any = null;
  private sub: { unsubscribe(): void } | null = null;
  onChange: () => void = () => {};

  constructor() {
    // We set the camera matrix from Mapillary every frame; stop three.js recomposing it from
    // position/rotation (which silently resets it to "looking straight down").
    this.camera.matrixAutoUpdate = false;
    this.texture = new THREE.DataTexture(this.display, W, H, THREE.RGBAFormat);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
  }

  // ---------- ICustomRenderer ----------
  onAdd(viewer: IViewer, _ref: unknown, context: WebGLRenderingContext | WebGL2RenderingContext) {
    this.viewer = viewer as Viewer;
    this.renderer = new THREE.WebGLRenderer({ canvas: (viewer as Viewer).getCanvas(), context });
    this.renderer.autoClear = false;
    // Mapillary's internal transform maps image (basic) coords <-> world: used to align the sphere.
    const state = (viewer as any)._navigator?.stateService;
    this.sub = state?.currentTransform$?.subscribe((t: any) => {
      this.transform = t;
    });
  }
  onReference() {
    this.rebuildSphere();
  }
  onRemove() {
    this.sub?.unsubscribe();
    this.renderer?.dispose();
    this.viewer = null;
  }
  render(_gl: WebGLRenderingContext, viewMatrix: number[], projectionMatrix: number[]) {
    if (!this.renderer || !this.mesh) return;
    this.camera.matrix.fromArray(viewMatrix).invert();
    this.camera.updateMatrixWorld(true);
    this.camera.projectionMatrix.fromArray(projectionMatrix);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    // Sphere is built camera-relative; keep it centred on wherever the camera is now (robust to
    // Mapillary changing its reference point, which shifts world coordinates).
    this.mesh.position.setFromMatrixPosition(this.camera.matrixWorld);
    this.mesh.updateMatrixWorld(true);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }

  // ---------- public API ----------
  /** Call after the viewer has moved to a new image. */
  setImage(layers: DeepLayers | null) {
    this.layers = layers;
    this.strokes = [];
    this.redoStack = [];
    this.active = null;
    this.committed.fill(0);
    this.display.fill(0);
    this.texture.needsUpdate = true;
    this.rebuildSphere();
    this.onChange();
  }
  hasLayers() {
    return !!this.layers;
  }

  setMode(mode: DeepMode) {
    this.mode = mode;
    this.rerenderAll();
  }
  setTexture(t: number) {
    this.textureAmount = t;
    this.rerenderAll();
  }

  setMaterial(material: PaintMaterial) {
    this.material = material;
    this.rerenderAll();
  }

  begin(u: number, v: number, hex: string, size: number) {
    if (!this.layers) return;
    this.active = { color: hexToRgb(hex), size, pts: [[u, v]] };
    this.redoStack = [];
    this.rasterSegment(this.active, [u, v], [u, v]);
    this.flushActive();
  }
  extend(u: number, v: number) {
    const s = this.active;
    if (!s) return;
    const prev = s.pts[s.pts.length - 1];
    s.pts.push([u, v]);
    this.rasterSegment(s, prev, [u, v]);
    this.flushActive();
  }
  end() {
    if (!this.active) return;
    this.strokes.push(this.active);
    this.bakeActive();
    this.active = null;
    this.onChange();
  }
  undo() {
    const s = this.strokes.pop();
    if (s) {
      this.redoStack.push(s);
      this.rerenderAll();
    }
  }
  redo() {
    const s = this.redoStack.pop();
    if (s) {
      this.strokes.push(s);
      this.rerenderAll();
    }
  }
  clear() {
    this.strokes = [];
    this.redoStack = [];
    this.rerenderAll();
  }
  canRedo() {
    return this.redoStack.length > 0;
  }

  // ---------- rasterisation ----------
  private rerenderAll() {
    this.committed.fill(0);
    for (const s of this.strokes) {
      for (let k = 0; k < s.pts.length; k++) this.rasterSegment(s, s.pts[Math.max(0, k - 1)], s.pts[k]);
      this.flushActive(s);
      this.bakeActive();
    }
    this.display.set(this.committed);
    this.texture.needsUpdate = true;
    this.viewer?.triggerRerender();
    this.onChange();
  }

  private mark(p: number, c: number) {
    if (c <= this.cov[p]) return;
    this.cov[p] = c;
    if (!this.touchedFlag[p]) {
      this.touchedFlag[p] = 1;
      this.touched.push(p);
    }
  }

  /** Add one segment (a->b, basic coords) of stroke s to the active coverage buffer. */
  private rasterSegment(s: Stroke, a: [number, number], b: [number, number]) {
    const L = this.layers;
    if (!L) return;
    const ax = a[0] * W - 0.5, ay = a[1] * H - 0.5;
    let bx = b[0] * W - 0.5;
    const by = b[1] * H - 0.5;
    if (bx - ax > W / 2) bx -= W; // shortest way round the seam
    if (ax - bx > W / 2) bx += W;

    if (this.mode !== 'wrap') {
      // flat footprint: constant radius in equirect pixels
      const r = s.size;
      const x0 = Math.floor(Math.min(ax, bx) - r - 1), x1 = Math.ceil(Math.max(ax, bx) + r + 1);
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1)), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + r + 1));
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-9;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2));
          const ex = x - (ax + t * dx), ey = y - (ay + t * dy);
          const d = Math.sqrt(ex * ex + ey * ey);
          const c = Math.min(1, Math.max(0, r - d + 0.5));
          if (c > 0) this.mark(y * W + (((x % W) + W) % W), c);
        }
      }
      return;
    }

    // wrap footprint: distance in 3D from each pixel's surface point to the 3D segment
    const ia = clampRow(Math.round(ay)), ja = wrapCol(Math.round(ax));
    const ib = clampRow(Math.round(by)), jb = wrapCol(Math.round(bx));
    const A = L.point(ia, ja, [0, 0, 0]);
    const B = L.point(ib, jb, [0, 0, 0]);
    const dA = L.dist[ia * W + ja], dB = L.dist[ib * W + jb];
    // brush radius in 3D is anchored to where the stroke started, so it matches flat at the start
    const start = s.pts[0];
    const i0 = clampRow(Math.round(start[1] * H - 0.5)), j0 = wrapCol(Math.round(start[0] * W - 0.5));
    const r3 = (s.size / (W / TWO_PI)) * L.dist[i0 * W + j0];
    // a big depth jump means we crossed onto another object: don't bridge through the air
    const jump = Math.abs(dA - dB) / Math.max(Math.min(dA, dB), 1e-6) > 0.25;
    const segs: [number[], number[]][] = jump ? [[A, A], [B, B]] : [[A, B]];

    for (const [P, Q] of segs) {
      const dMin = Math.max(Math.min(Math.hypot(P[0], P[1], P[2]), Math.hypot(Q[0], Q[1], Q[2])), 1e-6);
      const ang = (r3 / dMin) * 1.6;
      const cosL = Math.max(Math.min(L.cosLatAt(ia), L.cosLatAt(ib)), 0.05);
      const hx = (ang * (W / TWO_PI)) / cosL + 2, hy = ang * (H / Math.PI) + 2;
      const px = P === A ? ax : bx, py = P === A ? ay : by;
      const qx = Q === A ? ax : bx, qy = Q === A ? ay : by;
      const x0 = Math.floor(Math.min(px, qx) - hx), x1 = Math.ceil(Math.max(px, qx) + hx);
      const y0 = clampRow(Math.floor(Math.min(py, qy) - hy)), y1 = clampRow(Math.ceil(Math.max(py, qy) + hy));
      const ux = Q[0] - P[0], uy = Q[1] - P[1], uz = Q[2] - P[2];
      const len2 = ux * ux + uy * uy + uz * uz || 1e-12;
      const X = [0, 0, 0];
      const soft = 0.3 * r3;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const j = ((x % W) + W) % W;
          L.point(y, j, X);
          const t = Math.min(1, Math.max(0, ((X[0] - P[0]) * ux + (X[1] - P[1]) * uy + (X[2] - P[2]) * uz) / len2));
          const ex = X[0] - (P[0] + t * ux), ey = X[1] - (P[1] + t * uy), ez = X[2] - (P[2] + t * uz);
          const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
          const c = Math.min(1, Math.max(0, (r3 - d) / soft + 0.5));
          if (c > 0) this.mark(y * W + j, c);
        }
      }
    }
  }

  /** Recompute display pixels touched by the active stroke: committed OVER active paint. */
  private flushActive(s: Stroke | null = this.active) {
    const L = this.layers;
    if (!s || !L) return;
    const shaded = this.mode !== 'flat' && this.material !== 'flat';
    const lighting = this.material === 'refined' ? (L.paintSurface ?? L.refinedSurface ?? L.litSurface ?? L.shade)
      : this.material === 'refined-grey' ? (L.refinedSurface ?? L.litSurface ?? L.shade)
      : this.material === 'photo' ? (L.surface ?? L.shade)
      : this.material === 'lit-texture' ? (L.litSurface ?? L.shade) : L.shade;
    const rgb = lighting.length === W * H * 3;
    const lr = toLin(s.color[0]), lg = toLin(s.color[1]), lb = toLin(s.color[2]);
    const fr = s.color[0] * 255, fg = s.color[1] * 255, fb = s.color[2] * 255;
    for (const p of this.touched) {
      const c = this.cov[p];
      let r: number, g: number, b: number;
      if (shaded) {
        // The comparison uses strength 1: shadows keep their original contrast.
        // grey maps: one value per pixel; the paint material is interleaved RGB
        const k = this.textureAmount;
        if (rgb) {
          r = toSrgb(lr * Math.pow(Math.max(lighting[p * 3], 1e-3), k)) * 255;
          g = toSrgb(lg * Math.pow(Math.max(lighting[p * 3 + 1], 1e-3), k)) * 255;
          b = toSrgb(lb * Math.pow(Math.max(lighting[p * 3 + 2], 1e-3), k)) * 255;
        } else {
          const sh = Math.pow(Math.max(lighting[p], 1e-3), k);
          r = toSrgb(lr * sh) * 255;
          g = toSrgb(lg * sh) * 255;
          b = toSrgb(lb * sh) * 255;
        }
      } else {
        r = fr; g = fg; b = fb;
      }
      const q = p * 4;
      const a0 = this.committed[q + 3] / 255;
      const a = c + a0 * (1 - c);
      const k0 = a > 0 ? (a0 * (1 - c)) / a : 0, k1 = a > 0 ? c / a : 0;
      this.display[q] = r * k1 + this.committed[q] * k0;
      this.display[q + 1] = g * k1 + this.committed[q + 1] * k0;
      this.display[q + 2] = b * k1 + this.committed[q + 2] * k0;
      this.display[q + 3] = a * 255;
    }
    this.texture.needsUpdate = true;
    this.viewer?.triggerRerender();
  }

  private bakeActive() {
    for (const p of this.touched) {
      const q = p * 4;
      this.committed[q] = this.display[q];
      this.committed[q + 1] = this.display[q + 1];
      this.committed[q + 2] = this.display[q + 2];
      this.committed[q + 3] = this.display[q + 3];
      this.cov[p] = 0;
      this.touchedFlag[p] = 0;
    }
    this.touched = [];
  }

  // ---------- sphere aligned with the panorama ----------
  private rebuildSphere() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    const t = this.transform;
    if (!t || !this.layers) return;
    const NU = 256, NV = 128, R = 20;
    // Use only directions (bearing) from the transform: subtract the camera centre so positions
    // are camera-relative and independent of the reference point the transform was built with.
    const C = t.unprojectBasic([0.5, 0.5], 0);
    const pos = new Float32Array((NU + 1) * (NV + 1) * 3);
    const uv = new Float32Array((NU + 1) * (NV + 1) * 2);
    let k = 0;
    for (let iv = 0; iv <= NV; iv++) {
      for (let iu = 0; iu <= NU; iu++) {
        const u = iu / NU, v = iv / NV;
        const p = t.unprojectBasic([u, v], R);
        pos[k * 3] = p[0] - C[0];
        pos[k * 3 + 1] = p[1] - C[1];
        pos[k * 3 + 2] = p[2] - C[2];
        uv[k * 2] = u;
        uv[k * 2 + 1] = v; // DataTexture row 0 = top of the panorama = v 0
        k++;
      }
    }
    const idx: number[] = [];
    for (let iv = 0; iv < NV; iv++) {
      for (let iu = 0; iu < NU; iu++) {
        const a = iv * (NU + 1) + iu, b = a + 1, c = a + NU + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.viewer?.triggerRerender();
  }
}

function clampRow(i: number) {
  return Math.min(H - 1, Math.max(0, i));
}
function wrapCol(j: number) {
  return ((j % W) + W) % W;
}
