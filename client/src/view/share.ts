import type { Viewer } from 'mapillary-js';
import { formatAt, type LookingAt } from '../../../shared/shareView';

/** The picture of a place as seen from there, with its drawings (made by the server). */
export const sharePictureUrl = (id: string, at: LookingAt): string => `/api/share/${encodeURIComponent(id)}.jpg?at=${formatAt(at)}`;

/** A link to a place that opens looking where you're looking now. */
export async function shareLink(viewer: Viewer, id: string): Promise<string> {
  const [[u, v], zoom] = await Promise.all([viewer.getCenter(), viewer.getZoom()]);
  const at: LookingAt = { u, v: Math.min(1, Math.max(0, v)), zoom: Math.min(3, Math.max(0, zoom)) };
  new Image().src = sharePictureUrl(id, at); // made now, so it's there when the link is sent
  return `${location.origin}/view?imageId=${encodeURIComponent(id)}&at=${formatAt(at)}`;
}

/** Phones get their share sheet; elsewhere the link is copied. True: copied. */
export async function share(url: string): Promise<boolean> {
  if (navigator.maxTouchPoints > 0 && navigator.share) {
    await navigator.share({ url }).catch((e: Error) => { if (e.name !== 'AbortError') throw e; }); // closed without sharing
    return false;
  }
  await navigator.clipboard.writeText(url);
  return true;
}
