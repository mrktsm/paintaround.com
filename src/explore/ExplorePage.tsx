import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useNavigate } from 'react-router-dom';
import { MAP_LOCATIONS, PANORAMAS, panoramaThumbnail, panoramaViewUrl, type MapLocation } from '../pool/catalog';
import { cancelPanoramaPrefetch, prefetchPanorama, queuePanoramaPrefetch } from '../pool/panoramaImages';
import { readVisited } from '../pool/visited';
import { DARK_UI } from '../theme';
import CityMenu, { type CityOption } from './CityMenu';
import MobileSheet, { CitiesModal, useIsPhone, type Detent } from './MobileSheet';
import './explore.css';
import Compass from '../components/Compass';
import CloseIcon from '../components/CloseIcon';
import { ESRI_DATA_CREDIT, ESRI_PREVIEW_STYLE, loadEsriHybridStyle } from './esriPreviewStyle';
import { EOX_PREVIEW_STYLE } from './eoxPreviewStyle';
import { heatmapRadius, photoPinOpacity, PHOTO_ZOOM, spotsHeatmapLayer } from './spotsHeatmap';

/**
 * Explore map interface, shared by the home page and /explore.
 * Layout: slim left rail · content panel with image cards · full-bleed light map with floating
 * corner controls. Inspired by the Apple Maps web layout, in light mode.
 */

type Loc = MapLocation;
type CardLocation = Pick<Loc, 'id' | 'title' | 'city' | 'area' | 'previewUrl'>;
const LOCATIONS = MAP_LOCATIONS;
const SEARCH_LOCATIONS: CardLocation[] = PANORAMAS.map(item => ({id:item.id,title:item.title,city:MAP_LOCATIONS.find(loc => loc.id===item.id)?.city || (item.location==='Location not recorded' ? item.category : item.location.replace(/^Near /,'')),area:item.category,previewUrl:item.thumbnailUrl || item.previewUrl}));
const RECENT_SEARCHES_KEY = 'streetview:recent-search-places';

const RECENT_SEARCHES_LIMIT = 6;

function readRecentSearches(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) ?? '[]');
    return Array.isArray(saved)
      ? [...new Set(saved.filter((id): id is string => typeof id === 'string' && SEARCH_LOCATIONS.some(loc => loc.id === id)))].slice(0, RECENT_SEARCHES_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function SearchIcon({ size = 20, weight = 1.9 }: { size?: number; weight?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={weight} strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M20 20l-4.6-4.6" /></svg>;
}

/** Big empty-state magnifier drawn like SF Symbols' magnifyingglass: a solid ring and a
 *  shorter, heavier rounded handle (a thin outline scaled up looks like a wireframe). */
function EmptySearchGlyph() {
  return (
    <svg width="54" height="54" viewBox="0 0 54 54" fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden="true">
      <circle cx="23" cy="23" r="14.5" strokeWidth="4.6" />
      <path d="M34 34l10.5 10.5" strokeWidth="6.4" />
    </svg>
  );
}

function SearchPlaceRow({ loc, onOpen }: { loc: CardLocation; onOpen: (loc: CardLocation) => void }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <li>
      <button className="ex-search-result" onClick={() => onOpen(loc)} onPointerEnter={() => queuePanoramaPrefetch(loc.id)} onPointerLeave={() => cancelPanoramaPrefetch(loc.id)} onFocus={() => prefetchPanorama(loc.id)} onPointerDown={() => prefetchPanorama(loc.id)}>
        <span className="ex-search-result__preview">
          {imageFailed || !loc.previewUrl ? <SearchIcon /> : <img src={loc.previewUrl} alt="" loading="lazy" onError={() => setImageFailed(true)} />}
        </span>
        <span className="ex-search-result__copy">
          <span className="ex-search-result__name">{loc.title}</span>
          <span className="ex-search-result__place">{loc.city}</span>
        </span>
      </button>
    </li>
  );
}

function VisitedPlace({ loc, onOpen }: { loc: CardLocation; onOpen: (loc: CardLocation) => void }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <button
      role="listitem"
      className="ex-visited"
      aria-label={`${loc.title}, ${loc.city}`}
      title={loc.title}
      onClick={() => onOpen(loc)}
      onPointerEnter={() => queuePanoramaPrefetch(loc.id)}
      onPointerLeave={() => cancelPanoramaPrefetch(loc.id)}
      onFocus={() => prefetchPanorama(loc.id)}
      onPointerDown={() => prefetchPanorama(loc.id)}
    >
      {imageFailed || !loc.previewUrl
        ? <span className="ex-visited__fallback">{loc.title.slice(0, 1)}</span>
        : <img src={loc.previewUrl} alt="" loading="lazy" draggable={false} onError={() => setImageFailed(true)} />}
    </button>
  );
}

// CARTO basemaps (free for non-commercial use, lightweight vector tiles on a fast CDN —
// ~8x smaller than OpenFreeMap's for dense cities, which is what made zooming slow).
/** Calm light palette for CARTO "Voyager" (white streets, soft greys, bright water, green parks). */
function applyCartoPalette(m: maplibregl.Map) {
  const set = (id: string, prop: string, value: unknown) => {
    if (m.getLayer(id)) m.setPaintProperty(id, prop, value);
  };
  // Remove clutter: POI labels, city-dot markers, tiny hamlets, house numbers. Keep place,
  // street and water names so you can still orient yourself.
  for (const l of [...(m.getStyle().layers ?? [])]) {
    const id = l.id;
    if (
      id === 'housenumber' ||
      id.startsWith('poi_') ||
      id === 'watername_lake_pois' ||
      id.startsWith('place_city_dot') ||
      id === 'place_capital_dot_z7' ||
      id === 'place_hamlet'
    ) {
      if (m.getLayer(id)) m.removeLayer(id);
    }
  }
  for (const l of m.getStyle().layers ?? []) {
    const id = l.id;
    if (l.type === 'background') set(id, 'background-color', '#f4f3ef');
    else if (l.type === 'fill') {
      if (id === 'water' || id === 'water_shadow') set(id, 'fill-color', '#9fd3f5');
      else if (id === 'landuse_residential') set(id, 'fill-color', 'rgba(238, 236, 230, 0.3)');
      else if (id === 'landcover' || id.startsWith('park_') || id === 'landuse') {
        set(id, 'fill-color', '#c4e4aa');
        set(id, 'fill-opacity', 0.9);
      } else if (id === 'building') set(id, 'fill-color', '#e8e5df');
      else if (id === 'building-top') set(id, 'fill-color', '#efece7');
    } else if (l.type === 'line') {
      if (id === 'waterway') set(id, 'line-color', '#9fd3f5');
      else if (/rail/.test(id) && !/dash/.test(id)) set(id, 'line-color', '#d3d0ca');
      else if (/_(mot|trunk)_case/.test(id) || /^(bridge|tunnel)_(mot|trunk)_case/.test(id)) set(id, 'line-color', '#ecc874');
      else if (/_(mot|trunk)_fill/.test(id)) set(id, 'line-color', '#fbe4a8');
      else if (/_case/.test(id)) set(id, 'line-color', '#e2ddd3');
      else if (/^tunnel_.*_fill/.test(id)) set(id, 'line-color', '#f6f5f2');
      else if (/_fill/.test(id)) set(id, 'line-color', '#ffffff');
      else if (/^boundary/.test(id)) set(id, 'line-color', '#cfccc5');
    } else if (l.type === 'symbol') {
      if (id.startsWith('place_')) {
        set(id, 'text-color', '#2c2c2e');
        set(id, 'text-halo-color', 'rgba(255,255,255,0.92)');
      } else if (id.startsWith('roadname')) {
        set(id, 'text-color', '#6b6b70');
        set(id, 'text-halo-color', 'rgba(255,255,255,0.92)');
      } else if (/water/.test(id)) set(id, 'text-color', '#4f7fae');
      else if (id.startsWith('poi')) set(id, 'text-color', '#7a8a6f');
    }
  }
}

// Esri satellite is the default locally and live. ?map=standard shows CARTO.
// ?map=maptiler / ?map=stadia select configured alternatives; EOX stays a local preview.
const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY as string | undefined;
const STADIA_KEY = import.meta.env.VITE_STADIA_KEY as string | undefined;
const IS_LOCALHOST = ['localhost', '127.0.0.1'].includes(location.hostname);
const REQUESTED_MAP = new URLSearchParams(location.search).get('map');
const IS_LOCAL_PREVIEW = import.meta.env.DEV && IS_LOCALHOST;
const IS_EOX_PREVIEW = IS_LOCAL_PREVIEW && REQUESTED_MAP === 'eox';
const SATELLITE_SOURCE = IS_EOX_PREVIEW ? 'eox'
  : REQUESTED_MAP === 'maptiler' && MAPTILER_KEY ? 'maptiler'
  : REQUESTED_MAP === 'stadia' && STADIA_KEY ? 'stadia'
  : 'esri';
const SATELLITE_STYLE =
  SATELLITE_SOURCE === 'eox'
    ? EOX_PREVIEW_STYLE
    : SATELLITE_SOURCE === 'esri'
    ? ESRI_PREVIEW_STYLE
    : SATELLITE_SOURCE === 'maptiler'
    ? `https://api.maptiler.com/maps/hybrid/style.json?key=${MAPTILER_KEY}`
    : `https://tiles.stadiamaps.com/styles/alidade_satellite.json${STADIA_KEY ? `?api_key=${STADIA_KEY}` : ''}`;

/** Apple-like satellite look: white labels with soft dark halos, faint roads, a bit more colour. */
function applySatellitePalette(m: maplibregl.Map) {
  const set = (id: string, prop: string, value: unknown) => {
    if (m.getLayer(id)) m.setPaintProperty(id, prop, value);
  };
  for (const l of m.getStyle().layers ?? []) {
    const id = l.id;
    if (l.type === 'raster' && !id.startsWith('esri-') && !id.startsWith('eox-')) {
      set(id, 'raster-saturation', 0.12);
      set(id, 'raster-contrast', 0.06);
    } else if (l.type === 'line') {
      if (/(motorway|highway).*casing|casing.*(motorway|highway)/i.test(id)) set(id, 'line-color', 'rgba(0, 0, 0, 0.25)');
      else if (/motorway|highway_major|trunk/i.test(id)) set(id, 'line-color', 'rgba(255, 224, 140, 0.7)');
      else if (/highway|road|street|path|minor|major|primary|secondary|tertiary/i.test(id)) set(id, 'line-color', 'rgba(255, 255, 255, 0.38)');
      else if (/boundary/.test(id)) set(id, 'line-color', 'rgba(255, 255, 255, 0.35)');
    } else if (l.type === 'symbol') {
      set(id, 'text-color', '#ffffff');
      set(id, 'text-halo-color', 'rgba(0, 0, 0, 0.55)');
      set(id, 'text-halo-width', 1.2);
      set(id, 'text-halo-blur', 0.6);
    }
  }
}
// Satellite is the default look; ?map=standard shows the drawn map.
const IS_SATELLITE = REQUESTED_MAP !== 'standard';

const STYLES = {
  standard: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
  muted: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
};

type Section = 'search' | 'explore';

/**
 * Calm light palette applied on top of OpenFreeMap "Liberty": white roads with soft grey edges,
 * pale-yellow motorways, softer greens and blues, quiet labels — closer to the Apple Maps light look.
 */
function applyLightPalette(m: maplibregl.Map) {
  const set = (id: string, prop: string, value: unknown) => {
    if (m.getLayer(id)) m.setPaintProperty(id, prop, value);
  };
  // drop layers we don't use — less work per tile (3D extrusions are the heaviest)
  for (const id of ['building-3d', 'road_area_pattern', 'road_one_way_arrow', 'road_one_way_arrow_opposite']) {
    if (m.getLayer(id)) m.removeLayer(id);
  }
  for (const l of m.getStyle().layers ?? []) {
    const id = l.id;
    if (l.type === 'background') set(id, 'background-color', '#f4f3ef');
    else if (l.type === 'fill') {
      if (id === 'water') set(id, 'fill-color', '#9fd3f5');
      else if (id === 'park') set(id, 'fill-color', '#bfe3a6');
      else if (id === 'landcover_wood') {
        set(id, 'fill-color', '#b5dd98');
        set(id, 'fill-opacity', 0.85);
      } else if (id === 'landcover_grass') {
        set(id, 'fill-color', '#c6e6ad');
        set(id, 'fill-opacity', 0.9);
      } else if (id === 'landuse_residential') set(id, 'fill-color', 'rgba(238, 236, 230, 0.35)');
      else if (id === 'building') set(id, 'fill-color', '#e9e6e0');
      else if (id.startsWith('landuse_')) set(id, 'fill-color', '#ecebe4');
    } else if (l.type === 'fill-extrusion') {
      set(id, 'fill-extrusion-color', '#e9e6e0');
    } else if (l.type === 'line') {
      if (id.startsWith('waterway')) set(id, 'line-color', '#a9d3f3');
      else if (/rail/.test(id)) set(id, 'line-color', '#d3d0ca');
      else if (/motorway/.test(id) && /casing/.test(id)) set(id, 'line-color', '#ecc874');
      else if (/motorway/.test(id)) set(id, 'line-color', '#fbe4a8');
      else if (/casing/.test(id)) set(id, 'line-color', '#e2ddd3');
      else if (/^(road|bridge|tunnel)_/.test(id) && !/path|pedestrian/.test(id)) set(id, 'line-color', '#ffffff');
      else if (id === 'park_outline') set(id, 'line-color', 'rgba(0,0,0,0)');
      else if (id.startsWith('boundary')) set(id, 'line-color', '#c7c4bd');
    } else if (l.type === 'symbol') {
      if (/^label_(city|town|village|country|state)/.test(id)) {
        set(id, 'text-color', '#2c2c2e');
        set(id, 'text-halo-color', 'rgba(255,255,255,0.9)');
      } else if (/water/.test(id)) {
        set(id, 'text-color', '#5a87b5');
      } else if (/^poi|airport/.test(id)) {
        set(id, 'text-color', '#8e8e93');
      } else {
        set(id, 'text-color', '#6b6b70');
        set(id, 'text-halo-color', 'rgba(255,255,255,0.9)');
      }
    }
  }
}

// cities with the most curated spots first
const CITIES = (() => {
  const counts = new Map<string, number>();
  for (const l of LOCATIONS) counts.set(l.city, (counts.get(l.city) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
})();

/** Continent from coordinates (city names don't always include a country). */
function continentOf(lat: number, lng: number): string {
  if (lng < -30) return lat > 12 ? 'North America' : 'South America';
  if (lat > 35 && lng < 45) return 'Europe';
  if (lng < 55 && lat <= 37) return 'Africa';
  if (lat < -10 && lng > 110) return 'Oceania';
  return 'Asia';
}
/** City picker options: name + country line, grouped by continent (bigger continents first). */
const CITY_OPTIONS: CityOption[] = (() => {
  const opts = CITIES.map(city => {
    const first = LOCATIONS.find(l => l.city === city)!;
    const [name, ...rest] = city.split(',');
    return { city, name: name.trim(), sub: rest.join(',').trim(), continent: continentOf(first.lat, first.lng) };
  });
  const size = new Map<string, number>();
  for (const o of opts) size.set(o.continent, (size.get(o.continent) ?? 0) + 1);
  return opts.sort((a, b) => (size.get(b.continent)! - size.get(a.continent)!) || a.continent.localeCompare(b.continent) || a.name.localeCompare(b.name));
})();

/** Places closer than this on screen (px) count as one cluster; else each gets its own circle. */
const SOLO_SPACING = 76;
/** Matches the .ex-pin appear/disappear transition in explore.css. */
const PIN_FADE_MS = 280;

const SPOTS_GEOJSON = {
  type: 'FeatureCollection' as const,
  features: LOCATIONS.map((l) => ({
    type: 'Feature' as const,
    properties: { id: l.id },
    geometry: { type: 'Point' as const, coordinates: [l.lng, l.lat] },
  })),
};

/** Photo marker with a map-style place label below its white-ringed thumbnail. */
function makePin(loc: Loc, label: string | null, onOpen: (l: Loc) => void): HTMLElement {
  const el = document.createElement('button');
  el.className = 'ex-pin';
  el.setAttribute('aria-label', `Draw at ${label || loc.title}`);
  el.innerHTML = `<span class="ex-pin__photo"><img alt="" /></span>${label ? `<span class="ex-pin__label"></span>` : ''}`;
  if (label) (el.querySelector('.ex-pin__label') as HTMLElement).textContent = label;
  const img = el.querySelector('img') as HTMLImageElement;
  img.src = loc.previewUrl;
  el.addEventListener('pointerenter', () => queuePanoramaPrefetch(loc.id));
  el.addEventListener('pointerleave', () => cancelPanoramaPrefetch(loc.id));
  el.addEventListener('focus', () => prefetchPanorama(loc.id));
  el.addEventListener('pointerdown', () => prefetchPanorama(loc.id));
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    prefetchPanorama(loc.id);
    onOpen(loc);
  });
  return el;
}

function Card({ loc, title, overline, size, onOpen }: { loc: CardLocation; title: string; overline?: string; size: 'hero' | 'tile'; onOpen: (l: CardLocation) => void }) {
  const src = panoramaThumbnail(loc.id);
  return (
    <button className={`ex-card ex-card--${size}`} onClick={() => onOpen(loc)} onPointerEnter={() => queuePanoramaPrefetch(loc.id)} onPointerLeave={() => cancelPanoramaPrefetch(loc.id)} onFocus={() => prefetchPanorama(loc.id)} onPointerDown={() => prefetchPanorama(loc.id)}>
      {src ? <img src={src} alt="" loading="lazy" /> : <div className="ex-card__ph" />}
      <div className="ex-card__shade" />
      <div className="ex-card__text">
        {overline && <div className="ex-card__overline">{overline}</div>}
        <div className="ex-card__title">{title}</div>
      </div>
    </button>
  );
}

export default function ExplorePage() {
  const navigate = useNavigate();
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<Section>('explore');
  const [panelOpen, setPanelOpen] = useState(true);
  const [city, setCity] = useState(() => {
    const query = new URLSearchParams(location.search);
    const selected = LOCATIONS.find(loc => loc.id === query.get('imageId'));
    return selected?.city || CITIES.find(value => value.startsWith('Rome')) || CITIES[0];
  });
  const [cityMenu, setCityMenu] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const cityBtnRef = useRef<HTMLButtonElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [bearing, setBearing] = useState(0);
  const [creditOpen, setCreditOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const panelScroll = useRef<HTMLDivElement>(null);
  const [recentSearchIds, setRecentSearchIds] = useState(readRecentSearches);
  const dark = DARK_UI;
  // phones: one Apple Maps-style bottom sheet instead of the rail + side panel
  const phone = useIsPhone();
  const [detent, setDetent] = useState<Detent>('half');
  const [citiesOpen, setCitiesOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [sheetH, setSheetH] = useState(0);
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  const sheetHRef = useRef(0);
  const onSheetHeight = useMemo(() => (px: number) => { sheetHRef.current = px; setSheetH(px); }, []);
  /** Map centre offset so a focused place lands in the visible map area (beside the panel / above the sheet). */
  const mapOffset = (): [number, number] => phoneRef.current
    ? [0, -Math.min(sheetHRef.current, window.innerHeight * 0.6) / 2]
    : [(sideRef.current?.getBoundingClientRect().right ?? 0) / 2, 0];
  const [visitedPlaces] = useState(() => readVisited().flatMap(id => {
    const loc = SEARCH_LOCATIONS.find(item => item.id === id);
    return loc ? [loc] : [];
  }));
  const searchTerm = query.trim().toLocaleLowerCase();
  const searchResults = useMemo(() => {
    if (!searchTerm) return [];
    const terms = searchTerm.split(/\s+/);
    return SEARCH_LOCATIONS.filter(loc => {
      const text = `${loc.title} ${loc.city} ${loc.area}`.toLocaleLowerCase();
      return terms.every(term => text.includes(term));
    });
  }, [searchTerm]);
  const recentSearchPlaces = recentSearchIds.flatMap(id => {
    const loc = SEARCH_LOCATIONS.find(item => item.id === id);
    return loc ? [loc] : [];
  });
  const visibleSearchPlaces = searchTerm ? searchResults : recentSearchPlaces;

  useEffect(() => {
    if (section === 'search' && panelOpen) searchInput.current?.focus({ preventScroll: true });
  }, [section, panelOpen]);

  const saveRecentSearches = (ids: string[]) => {
    setRecentSearchIds(ids);
    try {
      if (ids.length) localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(ids));
      else localStorage.removeItem(RECENT_SEARCHES_KEY);
    } catch {
      // Search stays usable when browser storage is unavailable.
    }
  };

  const spots = useMemo(() => LOCATIONS.filter((l) => l.city === city).sort((a, b) => a.tier - b.tier), [city]);

  // map
  useEffect(() => {
    if (!mapEl.current || map.current) return;
    // coming back from a street view: return to where you were (?lng=&lat=&zoom=)
    const q = new URLSearchParams(location.search);
    const backLng = parseFloat(q.get('lng') ?? ''), backLat = parseFloat(q.get('lat') ?? '');
    const hasBack = isFinite(backLng) && isFinite(backLat);
    // The initial camera is already at the selected city; don't fly there again.
    skipCityFly.current = true;
    const initialCenter: [number, number] = hasBack ? [backLng, backLat]
      : spots.length ? [spots.reduce((sum, loc) => sum + loc.lng, 0) / spots.length, spots.reduce((sum, loc) => sum + loc.lat, 0) / spots.length]
      : [-73.98, 40.72];
    const m = new maplibregl.Map({
      container: mapEl.current,
      style: IS_SATELLITE ? SATELLITE_STYLE : STYLES.standard,
      center: initialCenter,
      zoom: hasBack ? Math.max(3, parseFloat(q.get('zoom') ?? '') || 15) : 12.5,
      attributionControl: false,
      fadeDuration: 0, // show tiles/labels immediately instead of a 300ms fade
      maxTileCacheSize: 800, // keep more tiles around so zooming back is instant
    });
    // Focus the initial place in the visible map area without retaining camera
    // padding that would shift the map when the sidebar opens or closes.
    m.easeTo({ center: initialCenter, offset: mapOffset(), duration: 0 });
    const referenceAbort = new AbortController();
    if (IS_SATELLITE && SATELLITE_SOURCE === 'esri') {
      void loadEsriHybridStyle(referenceAbort.signal).then((style) => {
        if (!referenceAbort.signal.aborted) m.setStyle(style);
      }).catch((error: unknown) => {
        if (!referenceAbort.signal.aborted) console.warn('Could not load Esri vector labels', error);
      });
    }
    m.on('style.load', () => {
      if (IS_SATELLITE) {
        applySatellitePalette(m);
        return;
      }
      const name = m.getStyle().name?.toLowerCase() ?? '';
      if (name.includes('liberty')) applyLightPalette(m);
      else applyCartoPalette(m);
    });
    m.on('rotate', () => setBearing(m.getBearing()));

    // Place density at a distance, crossfading into individual photo circles up close.
    const pins = new Map<string, maplibregl.Marker>();
    const addSpotsLayer = () => {
      if (!m.getSource('spots')) m.addSource('spots', { type: 'geojson', data: SPOTS_GEOJSON });
      if (!m.getLayer('spots-heatmap')) {
        // Keep geographic labels readable above the colour, including after the Esri style loads.
        const labels = m.getStyle().layers?.find(layer => layer.type === 'symbol');
        m.addLayer(spotsHeatmapLayer(), labels?.id);
        soloKey = ''; // new layer: re-apply the single-place filter
        updatePins();
      }
    };
    // A heatmap blob made of a single place is just that place: show its photo circle at any
    // zoom (and leave it out of the heatmap). Only real clusters stay heat until PHOTO_ZOOM.
    const leaving = new Map<string, ReturnType<typeof setTimeout>>();
    let solo = new Set<string>();
    let soloKey = '';
    const findSolo = () => {
      const z = m.getZoom();
      const near = Math.max(SOLO_SPACING, heatmapRadius(z));
      const cLng = m.getCenter().lng;
      const pts = LOCATIONS.map(l => m.project([l.lng + 360 * Math.round((cLng - l.lng) / 360), l.lat]));
      const out = new Set<string>();
      for (let i = 0; i < pts.length; i++) {
        let alone = true;
        for (let j = 0; j < pts.length && alone; j++) {
          if (i !== j && Math.abs(pts[i].x - pts[j].x) < near && Math.abs(pts[i].y - pts[j].y) < near
            && Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < near) alone = false;
        }
        if (alone) out.add(LOCATIONS[i].id);
      }
      return out;
    };
    const updatePins = () => {
      const z = m.getZoom();
      const clusterOpacity = photoPinOpacity(z);
      solo = z >= PHOTO_ZOOM ? new Set() : findSolo();
      const key = [...solo].sort().join(',');
      if (key !== soloKey && m.getLayer('spots-heatmap')) {
        soloKey = key;
        m.setFilter('spots-heatmap', solo.size ? ['!', ['in', ['get', 'id'], ['literal', [...solo]]]] : null);
      }
      const keep = new Set<string>();
      const b = m.getBounds();
      const c = m.getCenter();
      const inView = LOCATIONS.filter((l) => b.contains([l.lng, l.lat]));
      const show = [
        ...inView.filter(l => solo.has(l.id)),
        ...(clusterOpacity > 0 ? inView.filter(l => !solo.has(l.id))
          .sort((a, b2) => (a.lat - c.lat) ** 2 + (a.lng - c.lng) ** 2 - ((b2.lat - c.lat) ** 2 + (b2.lng - c.lng) ** 2))
          .slice(0, 30) : []),
      ];
      for (const l of show) {
        keep.add(l.id);
        const leavingTimer = leaving.get(l.id);
        if (leavingTimer !== undefined) {
          // was fading out — bring it back
          clearTimeout(leavingTimer);
          leaving.delete(l.id);
          pins.get(l.id)?.getElement().classList.add('is-shown');
        }
        if (!pins.has(l.id)) {
          const el = makePin(l, l.title, (loc) => navigate(panoramaViewUrl(loc.id)));
          pins.set(l.id, new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, -31] }).setLngLat([l.lng, l.lat]).addTo(m));
          // ease in (the class flips after the first paint so the transition runs)
          requestAnimationFrame(() => requestAnimationFrame(() => { if (!leaving.has(l.id)) el.classList.add('is-shown'); }));
        }
        const opacity = solo.has(l.id) ? 1 : clusterOpacity;
        const el = pins.get(l.id)!.getElement();
        el.style.opacity = String(opacity);
        el.style.pointerEvents = opacity >= 0.5 ? 'auto' : 'none';
        el.tabIndex = opacity >= 0.5 ? 0 : -1;
        el.setAttribute('aria-hidden', String(opacity < 0.5));
      }
      for (const [id, mk] of pins) {
        if (keep.has(id) || leaving.has(id)) continue;
        // ease out, then drop the marker
        const el = mk.getElement();
        el.classList.remove('is-shown');
        el.style.pointerEvents = 'none';
        leaving.set(id, setTimeout(() => { mk.remove(); pins.delete(id); leaving.delete(id); }, PIN_FADE_MS));
      }
    };
    // Heatmap pixels don't identify a single feature. Hit-test the actual nearby places instead.
    const nearestHotspot = (point: maplibregl.Point) => {
      if (m.getZoom() >= PHOTO_ZOOM) return null;
      const referenceLng = m.unproject(point).lng;
      let nearest: Loc | null = null;
      let distance = heatmapRadius(m.getZoom());
      for (const loc of LOCATIONS) {
        if (solo.has(loc.id)) continue; // has its own photo circle
        const lng = loc.lng + 360 * Math.round((referenceLng - loc.lng) / 360);
        const projected = m.project([lng, loc.lat]);
        const delta = Math.hypot(projected.x - point.x, projected.y - point.y);
        if (delta < distance) { nearest = loc; distance = delta; }
      }
      return nearest;
    };
    m.on('click', e => {
      const loc = nearestHotspot(e.point);
      if (!loc) return;
      const lng = loc.lng + 360 * Math.round((m.unproject(e.point).lng - loc.lng) / 360);
      m.flyTo({ center: [lng, loc.lat], zoom: Math.min(PHOTO_ZOOM + 1, Math.max(11, m.getZoom() + 3)), offset: mapOffset(), essential: true });
    });
    m.on('style.load', addSpotsLayer);
    m.on('move', updatePins);
    m.on('idle', updatePins);
    map.current = m;
    if (import.meta.env.DEV) (window as unknown as { __map: maplibregl.Map }).__map = m;
    return () => {
      referenceAbort.abort();
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // fly to the selected city (not on first load when returning from a street view)
  const skipCityFly = useRef(false);
  useEffect(() => {
    const m = map.current;
    if (!m || !spots.length) return;
    if (skipCityFly.current) {
      skipCityFly.current = false;
      return;
    }
    const lng = spots.reduce((s, l) => s + l.lng, 0) / spots.length;
    const lat = spots.reduce((s, l) => s + l.lat, 0) / spots.length;
    m.flyTo({ center: [lng, lat], zoom: 12.5, offset: mapOffset(), duration: 1600, essential: true });
  }, [spots]);

  const open = (l: CardLocation) => {
    prefetchPanorama(l.id);
    navigate(panoramaViewUrl(l.id));
  };
  const openSearchPlace = (loc: CardLocation) => {
    saveRecentSearches([loc.id, ...recentSearchIds.filter(id => id !== loc.id)].slice(0, RECENT_SEARCHES_LIMIT));
    open(loc);
  };



  const hero = spots[0];
  const heroId = hero?.id;
  useEffect(() => {
    if (!heroId || section !== 'explore' || !panelOpen) return;
    const timer = setTimeout(() => prefetchPanorama(heroId), 600);
    return () => clearTimeout(timer);
  }, [heroId, section, panelOpen]);
  const popular = spots.slice(1, 5);
  // recently drawn anywhere (spread across cities) — real activity feed comes later
  const recent = useMemo(() => {
    const picks: Loc[] = [];
    const seen = new Set<string>([city]);
    for (const l of LOCATIONS) {
      if (picks.length >= 4) break;
      if (l.tier === 1 && !seen.has(l.city)) {
        picks.push(l);
        seen.add(l.city);
      }
    }
    return picks;
  }, [city]);

  const searchBody = <>
    <span className="ex-search-status" role="status">{searchTerm ? `${searchResults.length} ${searchResults.length === 1 ? 'place' : 'places'} found` : ''}</span>
    {visibleSearchPlaces.length ? <>
      {!searchTerm && <div className="ex-search-recents"><h2>Recents</h2><button onClick={() => saveRecentSearches([])}>Clear</button></div>}
      <ul className="ex-search-results" aria-label={searchTerm ? 'Search results' : 'Recent searches'}>
        {visibleSearchPlaces.map(loc => <SearchPlaceRow key={loc.id} loc={loc} onOpen={openSearchPlace} />)}
      </ul>
    </> : <div className="ex-search-empty">
      <EmptySearchGlyph />
      <h2>{searchTerm ? 'No Places Found' : 'No Recent Searches'}</h2>
      <p>{searchTerm ? 'Try a different place or city.' : 'Your recent searches will appear here.'}</p>
    </div>}
  </>;
  const chevron = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>;
  const closeSearch = () => {
    setQuery('');
    setSearching(false);
    searchInput.current?.blur();
    setDetent('half');
  };

  const sheet = phone && (
    <MobileSheet
      detent={detent}
      onDetent={(d) => { setDetent(d); if (d !== 'full') { searchInput.current?.blur(); if (!query) setSearching(false); } }}
      onVisibleHeight={onSheetHeight}
      scrollRef={panelScroll}
      header={
        <div className="ex-sheet__searchrow">
          <form className="ex-search-field" role="search" onSubmit={event => { event.preventDefault(); searchInput.current?.blur(); }}>
            <SearchIcon />
            <input
              ref={searchInput}
              type="search"
              aria-label="Search places"
              placeholder="Search places"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onFocus={() => { setSearching(true); setDetent('full'); }}
              onChange={event => { setQuery(event.target.value); panelScroll.current?.scrollTo({ top: 0 }); }}
            />
            {query && <button type="button" className="ex-search-clear" aria-label="Clear search" onClick={() => { setQuery(''); searchInput.current?.focus(); }}>
              <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                <circle cx="10" cy="10" r="10" fill="currentColor" />
                <path d="M6.5 6.5l7 7M13.5 6.5l-7 7" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>}
          </form>
          {searching && <button className="ex-sheet__cancel" onClick={closeSearch}>Cancel</button>}
        </div>
      }
    >
      <div className="ex-sheet__body">
        {searching ? searchBody : <>
          {visitedPlaces.length > 0 && <>
            <h2 className="ex-sec ex-sec--first">Recents</h2>
            <div className="ex-row ex-row--recents">
              {visitedPlaces.map(loc => (
                <button key={loc.id} className="ex-recent" onClick={() => open(loc)} onPointerDown={() => prefetchPanorama(loc.id)}>
                  <span className="ex-recent__photo">{loc.previewUrl && <img src={loc.previewUrl} alt="" loading="lazy" draggable={false} />}</span>
                  <span className="ex-recent__name">{loc.title}</span>
                </button>
              ))}
            </div>
          </>}
          <div className={`ex-sheet__titlerow ${visitedPlaces.length ? '' : 'ex-sheet__titlerow--first'}`}>
            <div>
              <h2>Explore</h2>
              <button className="ex-city__btn" onClick={() => setCitiesOpen(true)}>{city}{chevron}</button>
            </div>
          </div>
          {hero && <Card size="hero" loc={hero} overline={city} title={hero.title} onOpen={open} />}
          {popular.length > 0 && <>
            <h2 className="ex-sec">Popular Spots</h2>
            <div className="ex-row">
              {popular.map((l) => <Card key={l.id} size="tile" loc={l} overline={l.area ?? city} title={l.title} onOpen={open} />)}
            </div>
          </>}
          {recent.length > 0 && <>
            <h2 className="ex-sec">Around the World</h2>
            <div className="ex-row">
              {recent.map((l) => <Card key={l.id} size="tile" loc={l} overline={l.city} title={l.title} onOpen={open} />)}
            </div>
          </>}
        </>}
      </div>
    </MobileSheet>
  );

  const pickCity = (c: string) => {
    setCitiesOpen(false);
    setCity(c);
    setDetent('half');
  };
  const citiesModal = phone && (
    <CitiesModal open={citiesOpen} onClose={() => setCitiesOpen(false)}>
      <ul className="ex-options">
        {[...CITIES].sort((x, y) => x.localeCompare(y)).map(c => (
          <li key={c}>
            <button className={`ex-option ${c === city ? 'is-current' : ''}`} onClick={() => pickCity(c)}>
              {c}
              {c === city && <svg className="ex-option__check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}
            </button>
          </li>
        ))}
      </ul>
    </CitiesModal>
  );

  return (
    <div
      ref={rootRef}
      className={`ex ${IS_SATELLITE ? 'ex--satellite' : ''} ${dark ? 'ex--dark' : ''} ${panelOpen ? '' : 'is-panel-closed'} ${phone ? `ex--phone ex--sheet-${detent}` : ''}`}
      style={phone ? { ['--sheet-h' as string]: `${sheetH}px` } : undefined}
    >
      {sheet}
      {citiesModal}
      {!phone && <div className="ex-side" ref={sideRef}>
      {/* ── Left rail ── */}
      <nav className="ex-rail">
        {([
          ['search', 'Search', <svg key="s" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M20 20l-4.6-4.6" /></svg>],
          ['explore', 'Explore', <svg key="e" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2.2" /><rect x="13" y="3.5" width="7.5" height="7.5" rx="2.2" /><rect x="3.5" y="13" width="7.5" height="7.5" rx="2.2" /><rect x="13" y="13" width="7.5" height="7.5" rx="2.2" /></svg>],
        ] as const).map(([id, label, icon]) => (
          <button
            key={id}
            className={`ex-tile ${panelOpen && section === id ? 'is-active' : ''}`}
            aria-label={label}
            aria-pressed={panelOpen && section === id}
            title={label}
            onClick={() => {
              setSection(id);
              setPanelOpen(true);
              setCityMenu(false);
              panelScroll.current?.scrollTo({ top: 0 });
              setScrolled(false);
              if (id === 'search') searchInput.current?.focus({ preventScroll: true });
            }}
          >
            {icon}
          </button>
        ))}
        {visitedPlaces.length > 0 && <>
          <div className="ex-rail__div" />
          <div className="ex-rail__visited" role="list" aria-label="Places you've visited">
            {visitedPlaces.map(loc => <VisitedPlace key={loc.id} loc={loc} onOpen={open} />)}
          </div>
        </>}
      </nav>

      {/* ── Content panel ── */}
      <aside className={`ex-panel ${section === 'search' ? 'ex-panel--search' : ''} ${panelOpen ? '' : 'is-closed'}`}>
        {section !== 'search' && <div className={`ex-panel__bar ${scrolled ? 'is-on' : ''}`} aria-hidden={!scrolled}>
          <div className="ex-panel__bar-title">Explore</div>
          <button className="ex-close" aria-label="Close panel" tabIndex={scrolled ? 0 : -1} onClick={() => setPanelOpen(false)}>
            <CloseIcon />
          </button>
        </div>}
        <div ref={panelScroll} className="ex-panel__scroll" onScroll={event => setScrolled(event.currentTarget.scrollTop > (section === 'search' ? 0 : 40))}>
        <header className={`ex-panel__head ${scrolled ? 'is-scrolled' : ''}`}>
          {/* same 60px row as the compact scroll bar, so the title and (x) line up exactly */}
          <div className="ex-panel__titlerow">
            <h1>{section === 'explore' ? 'Explore' : 'Search'}</h1>
            <button className="ex-close" aria-label="Close panel" onClick={() => setPanelOpen(false)}>
              <CloseIcon />
            </button>
          </div>
          {section === 'search' ? (
            <form className="ex-search-field" role="search" onSubmit={event => event.preventDefault()}>
              <SearchIcon />
              <input
                ref={searchInput}
                type="search"
                aria-label="Search places"
                placeholder="Search"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={event => { setQuery(event.target.value); panelScroll.current?.scrollTo({ top: 0 }); }}
                onKeyDown={event => {
                  if (event.key !== 'Escape') return;
                  event.preventDefault();
                  if (query) setQuery('');
                  else setPanelOpen(false);
                }}
              />
              {query && <button type="button" className="ex-search-clear" aria-label="Clear search" onClick={() => { setQuery(''); searchInput.current?.focus(); }}>
                <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                  <circle cx="10" cy="10" r="10" fill="currentColor" />
                  <path d="M6.5 6.5l7 7M13.5 6.5l-7 7" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>}
            </form>
          ) : <div className="ex-city">
            <button ref={cityBtnRef} className={`ex-city__btn ${cityMenu ? 'is-open' : ''}`} aria-haspopup="menu" aria-expanded={cityMenu} onClick={() => setCityMenu((v) => !v)}>
              {city}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            {cityMenu && cityBtnRef.current && rootRef.current && (
              <CityMenu
                anchor={cityBtnRef.current}
                container={rootRef.current}
                options={CITY_OPTIONS}
                current={city}
                onPick={c => { setCityMenu(false); pickCity(c); }}
                onClose={() => setCityMenu(false)}
              />
            )}
          </div>}
        </header>

        <div className="ex-panel__body">
          {section === 'search' && searchBody}
          {section !== 'search' && hero && <Card size="hero" loc={hero} overline={city} title={hero.title} onOpen={open} />}
          {section !== 'search' && popular.length > 0 && (
            <>
              <h2 className="ex-sec">Popular Spots</h2>
              <div className="ex-grid">
                {popular.map((l) => (
                  <Card key={l.id} size="tile" loc={l} overline={l.area ?? city} title={l.title} onOpen={open} />
                ))}
              </div>
            </>
          )}
          {section !== 'search' && recent.length > 0 && (
            <>
              <h2 className="ex-sec">Around the World</h2>
              <div className="ex-grid">
                {recent.map((l) => (
                  <Card key={l.id} size="tile" loc={l} overline={l.city} title={l.title} onOpen={open} />
                ))}
              </div>
            </>
          )}
        </div>
        </div>
      </aside>
      </div>}

      {/* ── Map (full-screen, behind the glass side panels) ── */}
      <main className="ex-map">
        <div ref={mapEl} className="ex-map__canvas" />

        <div className="ex-ctl ex-ctl--tr">
          <Compass bearing={bearing} background={dark ? 'rgba(36, 36, 38, 0.82)' : undefined} onClick={() => map.current?.easeTo({ bearing: 0, pitch: 0 })} />
        </div>

        {/* MapTiler free plan requires their logo on the map */}
        {IS_SATELLITE && SATELLITE_SOURCE === 'maptiler' && (
          <a className="ex-maptiler-logo" href="https://www.maptiler.com" target="_blank" rel="noreferrer" aria-label="MapTiler">
            <img src="https://api.maptiler.com/resources/logo.svg" alt="MapTiler" />
          </a>
        )}

        <div className="ex-ctl ex-ctl--br">
          {/* map data credit (required by the OpenStreetMap licence), behind a small (i) */}
          <div className="ex-info">
            {creditOpen && (
              <div className="ex-info__pop" role="dialog" aria-label="Map credits">
                {IS_SATELLITE && SATELLITE_SOURCE === 'esri' && (
                  <a className="ex-info__row" href="https://www.esri.com/" target="_blank" rel="noreferrer">
                    Powered by Esri
                    <svg width="7" height="12" viewBox="0 0 7 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M1 1l5 5-5 5" /></svg>
                  </a>
                )}
                <div className="ex-info__caption">Sources</div>
                <p className="ex-info__body">
                  {IS_SATELLITE && SATELLITE_SOURCE === 'eox' ? <><a href="https://cloudless.eox.at" target="_blank" rel="noreferrer">EOxCloudless</a> by <a href="https://eox.at" target="_blank" rel="noreferrer">EOX IT Services GmbH</a> (contains modified Copernicus Sentinel data 2024), <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noreferrer">CC BY-NC-SA 4.0</a>. Overlay rendering © EOX and MapServer.</> : IS_SATELLITE && SATELLITE_SOURCE === 'esri' ? <>{ESRI_DATA_CREDIT}</> : IS_SATELLITE && SATELLITE_SOURCE === 'maptiler' ? <>© <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noreferrer">MapTiler</a></> : IS_SATELLITE ? <>Imagery © CNES, Airbus DS, PlanetObserver · © <a href="https://stadiamaps.com/" target="_blank" rel="noreferrer">Stadia Maps</a> · © OpenMapTiles</> : <>© <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a></>}
                  <br />© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors
                </p>
              </div>
            )}
            {/* one small line, like Apple Maps' legal links: "© Esri" opens the credits panel above
                (Esri's required "Powered by Esri" + every source); Privacy and Terms sit beside it */}
            <div className="ex-credit">
              <button aria-label="Map credits" aria-expanded={creditOpen} onClick={() => setCreditOpen((v) => !v)}>
                {IS_SATELLITE && SATELLITE_SOURCE === 'esri' ? '© Esri' : 'Map data'}
              </button>
              <a href="/privacy">Privacy</a>
              <a href="/terms">Terms</a>
            </div>
          </div>
          <div className="ex-stack">
            <button aria-label="Zoom in" onClick={() => map.current?.zoomIn()}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            <button aria-label="Zoom out" onClick={() => map.current?.zoomOut()}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M5 12h14" /></svg>
            </button>
          </div>
        </div>


      </main>
    </div>
  );
}
