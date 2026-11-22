/**
 * The camera a panorama opens with, shared by the viewer (App.tsx) and the loading-preview
 * renderer (shared/panoramaProjection.mjs) so the preview matches the first frame exactly.
 *
 * Zoom uses Mapillary's scale (0 = widest, 3 = closest): each zoom step halves tan(fov / 2).
 * 0.35 opens ~27% closer than the widest view, so walls start bigger for drawing and there is
 * still room to zoom out.
 */
export const START_ZOOM = 0.35;
