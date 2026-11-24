import { useEffect, useRef, useState, type RefObject } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MAP_LOCATIONS, type MapLocation } from '../pool/catalog';
import { dressMap, MAP_STYLE } from './mapStyles';
import { PhotoPins } from './PhotoPins';
import { middleOf, placesIn } from './places';
import { heatmapRadius, PHOTO_ZOOM, SPOTS, spotsHeatmapLayer } from './spotsHeatmap';

interface Options {
  city: string;
  /** The place you came back from: the map opens there. */
  from?: string;
  onOpen(place: MapLocation): void;
  /** You moved the map to another city. False: the panel stays where it is. */
  onCity(city: string): boolean;
  /** Where the middle of the visible map is (beside the panel, above the sheet), from the map's middle. */
  offset(): [number, number];
}

const distanceTo = (p: { x: number; y: number }, x: number, y: number) => Math.hypot(p.x - x, p.y - y);

/** This place's position on screen, on the copy of the world being viewed. */
function project(m: maplibregl.Map, l: MapLocation, refLng: number) {
  return m.project([l.lng + 360 * Math.round((refLng - l.lng) / 360), l.lat]);
}

/** The place nearest a point on screen, within this distance. */
function nearest(m: maplibregl.Map, x: number, y: number, within: number, refLng: number, onScreen: boolean): MapLocation | null {
  const { clientWidth: W, clientHeight: H } = m.getContainer();
  let best: MapLocation | null = null, bestDistance = within;
  for (const l of MAP_LOCATIONS) {
    const p = project(m, l, refLng);
    if (onScreen && (p.x < 0 || p.y < 0 || p.x > W || p.y > H)) continue;
    const d = distanceTo(p, x, y);
    if (d < bestDistance) { bestDistance = d; best = l; }
  }
  return best;
}

/** The city in the middle of what you see, if that isn't the current one any more. */
function cityInView(m: maplibregl.Map, current: string, [ox, oy]: [number, number]): string | null {
  if (m.getZoom() < 3) return null; // whole-world view
  const { clientWidth: W, clientHeight: H } = m.getContainer();
  const x = W / 2 + ox, y = H / 2 + oy, refLng = m.getCenter().lng;
  const city = nearest(m, x, y, Infinity, refLng, true)?.city;
  if (!city || city === current) return null;
  // no flip-flopping: stay while any of its places is still near the middle
  const near = Math.min(W, H) * 0.22;
  return placesIn(current).some(l => distanceTo(project(m, l, refLng), x, y) < near) ? null : city;
}

/** The map, its photo circles, and keeping the panel's city in step with it. */
export function useExploreMap(container: RefObject<HTMLDivElement | null>, options: Options) {
  const { city } = options;
  const map = useRef<maplibregl.Map | null>(null);
  const [bearing, setBearing] = useState(0);
  const latest = useRef(options);
  useEffect(() => { latest.current = options; });
  /** The city the map is at (or on its way to). */
  const mapCity = useRef(city);

  useEffect(() => {
    if (!container.current) return;
    const from = MAP_LOCATIONS.find(l => l.id === latest.current.from);
    const back: [number, number] | null = from ? [from.lng, from.lat] : null;
    const center = back ?? middleOf(placesIn(latest.current.city)) ?? [-73.98, 40.72];
    const m = new maplibregl.Map({
      container: container.current,
      style: MAP_STYLE,
      center,
      zoom: back ? 15 : 12.5,
      attributionControl: false,
      fadeDuration: 0, // tiles and labels right away instead of a 300ms fade
      maxTileCacheSize: 800, // keep more tiles around so zooming back is instant
    });
    // an offset rather than camera padding, which would shift the map when the panel opens or closes
    m.easeTo({ center, offset: latest.current.offset(), duration: 0 });
    mapCity.current = latest.current.city;
    const labels = new AbortController();
    dressMap(m, labels.signal);
    m.on('rotate', () => setBearing(m.getBearing()));
    m.on('style.load', () => {
      if (!m.getSource('spots')) m.addSource('spots', { type: 'geojson', data: SPOTS });
      // the glow is the "where are places" overview, under the circles and the map's own labels
      if (!m.getLayer('spots-heatmap')) m.addLayer(spotsHeatmapLayer(), m.getStyle().layers?.find(l => l.type === 'symbol')?.id);
    });
    new PhotoPins(m, (place) => latest.current.onOpen(place));

    // you moved the map: once it settles the panel switches to the city in view. Moves we start
    // ourselves (flying to a city you picked) don't count, so they never override what you picked.
    const follow = () => {
      const next = cityInView(m, latest.current.city, latest.current.offset());
      if (next && latest.current.onCity(next)) mapCity.current = next; // already there
    };
    let moving = false;
    m.on('movestart', (e) => { moving = !!(e as { originalEvent?: Event }).originalEvent; });
    m.on('moveend', () => {
      if (!moving) return;
      moving = false;
      follow();
    });
    // tapping the glow (not a circle; those open their place) zooms in on the nearest place under it
    m.on('click', (e) => {
      if (m.getZoom() >= PHOTO_ZOOM) return;
      const refLng = m.unproject(e.point).lng;
      // it reaches a bit past the heatmap's radius, so taps anywhere on it count
      const place = nearest(m, e.point.x, e.point.y, heatmapRadius(m.getZoom()) * 1.5, refLng, false);
      if (!place) return;
      const center: [number, number] = [place.lng + 360 * Math.round((refLng - place.lng) / 360), place.lat];
      m.flyTo({ center, zoom: Math.min(PHOTO_ZOOM + 1, Math.max(11, m.getZoom() + 3)), offset: latest.current.offset(), essential: true });
      m.once('moveend', follow); // you chose to go there
    });

    map.current = m;
    if (import.meta.env.DEV) (window as unknown as { __map: maplibregl.Map }).__map = m;
    return () => {
      labels.abort();
      m.remove();
      map.current = null;
    };
  }, [container]);

  // you picked another city: fly there
  useEffect(() => {
    if (mapCity.current === city) return;
    mapCity.current = city;
    const center = middleOf(placesIn(city));
    if (center) map.current?.flyTo({ center, zoom: 12.5, offset: latest.current.offset(), duration: 1600, essential: true });
  }, [city]);

  return { map, bearing };
}
