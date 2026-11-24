import type { DecalLayer, DecalTool, ToolType } from "../deep/decalTools";
import type { GeodesicMap } from "../deep/geodesicMap";
import type { MarkerTexture } from "./strokes";

/**
 * Paintable radius around the drawn path per tool (decal px = screen px at the stroke start):
 * measured brush half-width + a margin for texture/bleed. Paint outside it is never shown.
 */
export const DEEP_NEAR_RADIUS: Record<string, number> = {
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
