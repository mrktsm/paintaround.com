/**
 * Your own drawings in a place's preview the moment you leave it. The server re-renders previews
 * for everyone a little later (and only with drawings that passed moderation); this one is made in
 * your browser, from exactly what you just saw, and only you see it: nothing is uploaded.
 * Same framing as the server's and the original previews (shared/panoramaProjection.mjs).
 */
import type { DrawingOverlay } from '../drawing/DrawingOverlay';
import type { Panorama } from './catalog';
import { setLocalPreview } from './drawnPreviews';
import { START_ZOOM } from '../../../shared/startView';

export interface PreviewView { u: number; v: number; horizontalFov: number; width: number; height: number }

/** The wide loading frame's view (see loadingViewFor in shared/panoramaProjection.mjs). */
function loadingView(card: { u: number; v: number }): PreviewView {
  const width = 1920, height = 480;
  return { u: card.u, v: card.v, width, height, horizontalFov: (2 * Math.atan(width / height / 2 ** START_ZOOM) * 180) / Math.PI };
}

async function withPhoto(photoUrl: string, paint: HTMLCanvasElement, view: PreviewView): Promise<Blob | null> {
  const photo = new Image();
  photo.src = photoUrl;
  await photo.decode();
  const c = document.createElement('canvas');
  c.width = view.width;
  c.height = view.height;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(photo, 0, 0, c.width, c.height);
  ctx.drawImage(paint, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.88));
}

/** If you changed this place's drawing, show it in its previews now. Call before the overlay goes away. */
export function showOwnDrawing(panorama: Panorama, overlay: DrawingOverlay): void {
  const cardUrl = panorama.thumbnailUrl, v = panorama.thumbnailView;
  if (!cardUrl || !v || !overlay.takeOwnChanges()) return;
  const card: PreviewView = { u: v.u, v: v.v, horizontalFov: v.horizontalFov ?? 85, width: 800, height: 600 };
  const wide = loadingView(card);
  try {
    // the drawings are read now; photo and encoding follow while the page moves on
    const cardPaint = overlay.renderPreview(card, 2), widePaint = overlay.renderPreview(wide, 1);
    if (!cardPaint || !widePaint) return;
    void Promise.all([
      withPhoto(cardUrl, cardPaint, card),
      withPhoto(cardUrl.replace(/-card\.jpg$/, '-loading.jpg'), widePaint, wide),
    ]).then(([a, b]) => { if (a && b) setLocalPreview(panorama.id, a, b); }).catch((e) => console.warn('[preview]', e));
  } catch (e) {
    console.warn('[preview] own drawing:', e); // a bonus: the server's preview still comes
  }
}
