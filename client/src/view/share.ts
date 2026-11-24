import type { Viewer } from 'mapillary-js';
import { formatAt, type LookingAt } from '../../../shared/shareView';
import { placePath } from '../pool/catalog';

/** The picture of a place as seen from there, with its drawings (made by the server). */
export const sharePictureUrl = (id: string, at: LookingAt): string => `/api/share/${encodeURIComponent(id)}.jpg?at=${formatAt(at)}`;

/** A link to a place that opens looking where you're looking now. */
export async function shareLink(viewer: Viewer, id: string): Promise<string> {
  const [[u, v], zoom] = await Promise.all([viewer.getCenter(), viewer.getZoom()]);
  const at: LookingAt = { u, v: Math.min(1, Math.max(0, v)), zoom: Math.min(3, Math.max(0, zoom)) };
  // made now, so it's there when the link is sent (v: with what was just drawn, which gets checked first)
  new Image().src = `${sharePictureUrl(id, at)}&v=${Date.now()}`;
  return `${location.origin}${placePath(id)}?at=${formatAt(at)}`;
}

/** The system's share sheet, or where there's none the link is copied. True: copied. */
export async function share(url: string): Promise<boolean> {
  if (navigator.share) {
    try {
      await navigator.share({ url });
      return false;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false; // closed without sharing
    }
  }
  await navigator.clipboard.writeText(url);
  return true;
}
