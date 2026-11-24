import { drawnPreviewUrl } from './drawnPreviews';
import data from '../data/panorama-pool.json';

export type Panorama = {
  id: string; title: string; location: string; appeal: string; category: string;
  country: string | null; latitude: number | null; longitude: number | null;
  author: string; provider: string; license: string; licenseUrl: string; sourceUrl: string;
  imageUrl: string; previewUrl: string; thumbnailUrl?: string; downloadUrl: string;
  thumbnailView?: { u: number; v: number; horizontalFov?: number };
  originalWidth: number; originalHeight: number; width: number; height: number;
  capturedAt: number | null;
};

export const PANORAMAS: readonly Panorama[] = data.items;
export const PANORAMA_BY_ID = new Map(PANORAMAS.map(panorama => [panorama.id, panorama]));
export const DEFAULT_PANORAMA = PANORAMA_BY_ID.get('ph-colosseum') || PANORAMAS[0];

export type MapLocation = {
  id: string; lat: number; lng: number; city: string; title: string; tier: number;
  street: string; area: string; previewUrl: string;
};

export function hasCoordinates(panorama: Panorama): panorama is Panorama & { latitude: number; longitude: number } {
  return typeof panorama.latitude === 'number' && Number.isFinite(panorama.latitude) && Math.abs(panorama.latitude) <= 90
    && typeof panorama.longitude === 'number' && Number.isFinite(panorama.longitude) && Math.abs(panorama.longitude) <= 180;
}

function kilometers(lat1: number, lng1: number, lat2: number, lng2: number) {
  const rad = Math.PI / 180;
  const h = Math.sin((lat2-lat1)*rad/2)**2 + Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin((lng2-lng1)*rad/2)**2;
  return 12742 * Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
}

// Group nearby viewpoints without averaging unrelated locations across an entire country.
const groups: { city: string; lat: number; lng: number }[] = [];
export const MAP_LOCATIONS: MapLocation[] = PANORAMAS.filter(hasCoordinates).map((panorama, index) => {
  let group = groups.find(candidate => kilometers(candidate.lat,candidate.lng,panorama.latitude,panorama.longitude) < 35);
  if (!group) {
    const namedLocation = panorama.location.replace(/^Near /,'');
    const city = namedLocation.includes(',')
      ? namedLocation.replace(/, Location recorded$/,'')
      : `${panorama.title}${panorama.country && panorama.country !== 'Location recorded' ? `, ${panorama.country}` : ''}`;
    group = { city, lat: panorama.latitude, lng: panorama.longitude };
    groups.push(group);
  }
  return { id: panorama.id, lat: panorama.latitude, lng: panorama.longitude, city: group.city,
    title: panorama.title, street: panorama.title, area: panorama.category, previewUrl: panorama.thumbnailUrl || panorama.previewUrl,
    tier: index < 36 ? 1 : index < 90 ? 2 : 3 };
});

/** Coordinates come from the catalog, never untrusted/stale links or a guessed city center. */
export function panoramaViewUrl(id: string) {
  const panorama = PANORAMA_BY_ID.get(id);
  if (!panorama) return '/';
  const params = new URLSearchParams({ imageId: panorama.id });
  if (hasCoordinates(panorama)) {
    params.set('lng', String(panorama.longitude));
    params.set('lat', String(panorama.latitude));
  }
  return `/view?${params}`;
}

export function panoramaThumbnail(id: string, full = false): string | null {
  const panorama = PANORAMA_BY_ID.get(id);
  if (!panorama) return null;
  // a place with drawings shows them in its preview (same framing as the original card)
  if (!full) { const drawn = drawnPreviewUrl(id, 'card'); if (drawn) return drawn; }
  return panorama.thumbnailUrl || (full ? panorama.imageUrl : panorama.previewUrl);
}
