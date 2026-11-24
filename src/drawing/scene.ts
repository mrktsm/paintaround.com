import type { DeepData } from "../deep/surfaceDecal";
import type { WebGLDrawingRenderer } from "./WebGLDrawingRenderer";
import type { PhotoTransform, Projection, RenderCamera } from "../viewer/mapillaryInternals";

/** Everything needed to project panorama coordinates to the screen in this frame. */
export interface ProjectionContext {
  proj: Projection;
  container: HTMLElement;
  renderCamera: RenderCamera;
  transform: PhotoTransform;
}

/** What's on screen right now, for the parts that draw on top of it. */
export interface Scene {
  readonly container: HTMLElement;
  /** Depth and lighting of this place, once loaded (null: strokes stay flat). */
  readonly deep: DeepData | null;
  /** Degrees of the panorama across the screen's height. */
  readonly fov: number;
  /** Radians of the panorama per screen pixel. */
  readonly radPerPx: number;
  /** Height of the drawing on screen (px). */
  readonly height: number;
  /** Draws on the GPU (null: not available, strokes are drawn with the 2D canvas). */
  readonly renderer: WebGLDrawingRenderer | null;
  projection(): ProjectionContext | null;
  /** Screen px -> panorama coords (null if not known right now). */
  toPanorama(x: number, y: number): [number, number] | null;
  /** Nothing to paint at this panorama point? (Never without 3D data.) */
  isSky(u: number, v: number): boolean;
  /** Same, for a point on screen. */
  isSkyAt(x: number, y: number): boolean;
  /** Draw everything again, as it is now. */
  redraw(): void;
}
