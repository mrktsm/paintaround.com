import { DecalLayer, makeDecalTool, type DecalTool, type ToolType } from "../deep/decalTools";
import { GeodesicMap, pieceGrid, type BakedPiece } from "../deep/geodesicMap";
import { SurfaceDecal, type DeepData } from "../deep/surfaceDecal";
import type { Scene } from "./scene";
import type { MarkerTexture } from "./strokes";
import type { WebGLDrawingRenderer } from "./WebGLDrawingRenderer";

/**
 * Paintable radius around the drawn path per tool (decal px = screen px at the stroke start):
 * measured brush half-width + a margin for texture/bleed. Paint outside it is never shown.
 */
const DEEP_NEAR_RADIUS: Record<string, number> = {
  pencil: 10,
  marker: 26,
  crayon: 22,
  fountainPen: 11,
  watercolor: 18,
};

/** A point of the path on the surface: where in the panorama, where on the decal, where on screen. */
export interface PathPoint { basic: [number, number]; decal: [number, number]; screen: [number, number] }

/** A stroke piece being drawn on a 3D surface (see deep/geodesicMap, deep/decalTools). */
export interface DecalState {
  geo: GeodesicMap; // continuous surface unwrap for this piece (decal space <-> panorama)
  surface: Float32Array; // panorama paint multiplier (shadows + texture)
  layer: DecalLayer; // the brush's drawing on the unwrapped sheet
  tool: DecalTool;
  toolType: ToolType;
  seed: number;
  params: { color: string; lineWidth: number; toolType: ToolType };
  geom: { key: string; basic: Float32Array; tex: Float32Array } | null; // cached draw geometry
  fov: number; // fov at stroke start
  group: number; // stroke group id (shared by all pieces of a stroke)
  nearRadius: number; // paintable radius around the drawn path, in decal px (~brush half-width + margin)
  prev: PathPoint; // last path point on the surface
  painted: [number, number]; // last decal point handed to the brush
  marked: [number, number]; // last decal point marked paintable
  track: PathPoint[]; // points since then
  off: [number, number][]; // screen points off this piece's surface, not placed yet
  gap: boolean; // the path left the surface (sky) since prev
  hasPaint: boolean;
  cells: Map<number, [number, number]>; // where in the panorama each bit of the sheet was painted
  start: [number, number]; // panorama point the decal was built at
}

/** Someone else's surface stroke, replayed live with their brush (see replayStart). */
export interface Replay {
  st: DecalState;
  group?: number;
  ended: boolean;
  dead: boolean;
  /** points of a frame whose last point hasn't arrived yet */
  mids: [number, number][];
  /** the finished piece, baked when it ended (its surface map is freed) */
  tex: MarkerTexture | null;
  timer?: ReturnType<typeof setTimeout>;
}

/** Added to a sample's decal x when more points of the same frame follow (decal x is < 2048). */
export const MID_SAMPLE = 8192;

/** Is this panorama point sky (no depth = nothing to paint)? False without depth data. */
export function isSky(d: DeepData | null, u: number, v: number): boolean {
  if (!d) return false;
  const x = ((Math.floor(u * 2048) % 2048) + 2048) % 2048;
  const y = Math.min(1023, Math.max(0, Math.floor(v * 1024)));
  return !(d.dist[y * 2048 + x] > 0);
}

/**
 * A surface decal starting at panorama point b. Deterministic for the same inputs, which is
 * what lets other people rebuild exactly the drawer's decal (exact = use worldPerPx as is).
 */
export function startPiece(
  deep: DeepData, b: [number, number], radPerPx: number, worldPerPx: number | undefined, exact: boolean,
  params: { color: string; lineWidth: number; toolType: ToolType }, seed: number, group: number, fov: number,
): DecalState | null {
  const decal = SurfaceDecal.create(deep, b[0], b[1], radPerPx, worldPerPx, exact);
  if (!decal) return null;
  const geo = new GeodesicMap(deep, b[0], b[1], decal.basis);
  geo.openTo(b[0], b[1]);
  const near = DEEP_NEAR_RADIUS[params.toolType] ?? 14;
  geo.markNear(b[0], b[1], near * geo.s);
  const layer = new DecalLayer();
  const tool = makeDecalTool(params.toolType, layer, params.color, params.lineWidth, seed);
  const c: [number, number] = [geo.cx, geo.cy];
  tool.begin(c[0], c[1]);
  return {
    geo,
    surface: deep.surface,
    layer,
    tool,
    seed,
    params,
    toolType: params.toolType,
    geom: null,
    fov,
    group,
    nearRadius: near,
    prev: { basic: [b[0], b[1]], decal: c, screen: [0, 0] },
    painted: c,
    marked: c,
    track: [],
    off: [],
    gap: false,
    hasPaint: false,
    cells: new Map(),
    start: [b[0], b[1]],
  };
}

/** Is decal point d at b a step along the same surface from the last point, not a jump? */
export function continues(st: DecalState, b: [number, number], d: [number, number]): boolean {
  const moved = Math.hypot(d[0] - st.prev.decal[0], d[1] - st.prev.decal[1]);
  if (folds(st, b, d)) return false;
  if (moved < 6) return true;
  const s = st.geo.step(st.prev.basic, b);
  // the sheet can't be much longer than the straight line between two close points, unless they
  // are only connected the long way round (an object's edge, or a loop that doesn't close)
  return moved < s.px * 1.6 + 4;
}

/**
 * On a long stroke over bumpy surfaces the unfolded sheet can overlap itself: two places far apart
 * get the same decal coordinates, and paint for one would show up in the other as a smear.
 */
function folds(st: DecalState, b: [number, number], d: [number, number]): boolean {
  const cell = st.nearRadius * 2, cx = Math.floor(d[0] / cell), cy = Math.floor(d[1] / cell);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const at = st.cells.get((cy + j) * 4096 + cx + i);
    if (at && st.geo.step(at, b).px > cell * 4) return true;
  }
  st.cells.set(cy * 4096 + cx, b);
  return false;
}

/** Let a piece's brush paint one frame's points; at = the last one in the panorama. */
export function paintFrame(st: DecalState, pts: [number, number][], at: [number, number]): void {
  const g = st.geo;
  st.tool.frame(pts);
  st.painted = pts[pts.length - 1];
  st.hasPaint = true;
  g.markNear(at[0], at[1], st.nearRadius * g.s);
  // splatters land away from the path: unwrap out to them and let paint show there
  const spots = st.tool.spots;
  if (!spots.length) return;
  st.tool.spots = [];
  const far = Math.max(...spots.map((sp) => Math.hypot(sp.x - st.painted[0], sp.y - st.painted[1]) + sp.radius));
  const scale = g.worldPerPxAt(at[0], at[1]), distance = g.distanceAt(at[0], at[1]);
  const reach = scale && distance ? Math.ceil((far * scale / distance * 1024) / Math.PI) + 4 : 0; // in panorama pixels
  if (reach > 38) g.openTo(at[0], at[1], Math.min(80, reach), true);
  for (const sp of spots) {
    const b = g.basicAt(sp.x, sp.y);
    if (b) g.markNear(b[0], b[1], (sp.radius + 2) * g.s);
  }
}

/** Bake what the brush painted into a panorama bitmap (null = nothing to see). */
export function bakePiece(st: DecalState): BakedPiece | null {
  const l = st.layer;
  if (!st.hasPaint || !l.w || !l.h) return null;
  return st.geo.bake(l.ctx.getImageData(0, 0, l.w, l.h), { x0: l.x0, y0: l.y0, w: l.w, h: l.h }, st.surface);
}

/** A baked piece as a stroke. */
export function pieceTexture(piece: BakedPiece, st: DecalState): MarkerTexture {
  const grid = pieceGrid(piece);
  return {
    canvas: piece.canvas,
    toolType: st.toolType === "marker" ? undefined : st.toolType,
    gridBasic: grid.gridBasic, gridRows: grid.rows, gridCols: grid.cols,
    srcWidth: piece.canvas.width, srcHeight: piece.canvas.height,
    referenceFov: st.fov, strokeGroup: st.group, opacity: 1,
  };
}

/** Draw live 3D strokes with the deep shader (projection uniforms already set this frame). */
export function drawLivePieces(r: WebGLDrawingRenderer, live: DecalState[]): void {
  for (const st of live) {
    const g = st.geo, bb = g.paintBox;
    if (!isFinite(bb.r0)) continue;
    // geometry covering the reached area (rebuilt only when it grows)
    const key = `${bb.r0},${bb.c0},${bb.r1},${bb.c1}`;
    if (!st.geom || st.geom.key !== key) {
      const r0 = bb.r0, c0 = bb.c0, r1 = bb.r1 + 1, c1 = bb.c1 + 1;
      const rows = Math.max(1, Math.min(32, Math.ceil((r1 - r0) / 16)));
      const cols = Math.max(1, Math.min(32, Math.ceil((c1 - c0) / 16)));
      const basic = new Float32Array(rows * cols * 12), tex = new Float32Array(rows * cols * 12);
      let k = 0;
      const put = (gr: number, gc: number) => {
        const rr = r0 + (gr / rows) * (r1 - r0), cc = c0 + (gc / cols) * (c1 - c0);
        basic[k] = (g.j0 + cc) / 2048; basic[k + 1] = (g.i0 + rr) / 1024;
        tex[k] = cc / g.RW; tex[k + 1] = rr / g.RH;
        k += 2;
      };
      for (let gr = 0; gr < rows; gr++) for (let gc = 0; gc < cols; gc++) {
        put(gr, gc); put(gr + 1, gc); put(gr, gc + 1);
        put(gr, gc + 1); put(gr + 1, gc); put(gr + 1, gc + 1);
      }
      st.geom = { key, basic, tex };
    }
    r.drawDeepStroke({
      key: g,
      dem: g.tex,
      regionW: g.RW,
      regionH: g.RH,
      regionOrigin: [g.j0, g.i0],
      dirty: g.dirty,
      basicCoords: st.geom.basic,
      texCoords: st.geom.tex,
      layer: st.layer,
      surface: st.surface,
      panoW: 2048,
      panoH: 1024,
    });
    g.dirty = null;
    st.layer.dirty = null;
  }
}

/** Can strokes be painted onto the 3D surface here? */
export function canPaintSurfaces(scene: Scene): scene is Scene & { deep: DeepData; renderer: WebGLDrawingRenderer } {
  return !!(scene.deep && scene.renderer?.hasGPUProjection() && scene.renderer.hasDeepStrokes());
}

/** Free a piece's surface map. */
export function releasePiece(scene: Scene, st: DecalState): void {
  scene.renderer?.releaseDeepStroke(st.geo);
  st.geo.release();
}
