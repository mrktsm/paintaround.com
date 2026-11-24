/**
 * Where someone is looking, as it travels in a shared link (?at=u,v,zoom) and in its picture. Used by
 * the site and the drawing server, so the picture is exactly what the place opens with.
 */
export interface LookingAt {
  /** Middle of the screen, in panorama coordinates (0..1). */
  u: number;
  v: number;
  /** Mapillary's zoom: 0 = widest, 3 = closest. */
  zoom: number;
}

/** The usual size for link pictures. */
const WIDTH = 1200, HEIGHT = 630;

export function formatAt({ u, v, zoom }: LookingAt): string {
  return `${(((u % 1) + 1) % 1).toFixed(4)},${v.toFixed(4)},${zoom.toFixed(2)}`;
}

export function parseAt(text: string | null | undefined): LookingAt | null {
  const m = text?.match(/^(\d(?:\.\d{1,6})?),(\d(?:\.\d{1,6})?),(\d(?:\.\d{1,4})?)$/);
  if (!m) return null;
  const [u, v, zoom] = m.slice(1).map(Number);
  return u <= 1 && v <= 1 && zoom <= 3 ? { u, v, zoom } : null;
}

/** That view as a wide picture: as high as the screen, with more on both sides of a phone's. */
export function shareCamera({ u, v, zoom }: LookingAt) {
  // the viewer sees 90° from top to bottom at zoom 0; each step halves tan(fov / 2)
  const horizontalFov = (2 * Math.atan(WIDTH / HEIGHT / 2 ** zoom) * 180) / Math.PI;
  return { u, v, horizontalFov, width: WIDTH, height: HEIGHT };
}
