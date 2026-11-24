import type { DeepData } from "../deep/surfaceDecal";
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
  projection(): ProjectionContext | null;
  isSky(u: number, v: number): boolean;
}
