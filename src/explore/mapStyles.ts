/** The map underneath: Esri satellite, or CARTO's drawn map with ?map=standard. */
import type { Map } from 'maplibre-gl';
import { EOX_PREVIEW_STYLE } from './eoxPreviewStyle';
import { ESRI_PREVIEW_STYLE, loadEsriHybridStyle } from './esriPreviewStyle';

// ?map=maptiler / ?map=stadia select configured alternatives; EOX stays a local preview
const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY as string | undefined;
const STADIA_KEY = import.meta.env.VITE_STADIA_KEY as string | undefined;
const REQUESTED = new URLSearchParams(location.search).get('map');
const IS_LOCAL = import.meta.env.DEV && ['localhost', '127.0.0.1'].includes(location.hostname);

export type MapSource = 'esri' | 'eox' | 'maptiler' | 'stadia' | 'carto';
export const MAP_SOURCE: MapSource = REQUESTED === 'standard' ? 'carto'
  : REQUESTED === 'eox' && IS_LOCAL ? 'eox'
  : REQUESTED === 'maptiler' && MAPTILER_KEY ? 'maptiler'
  : REQUESTED === 'stadia' && STADIA_KEY ? 'stadia'
  : 'esri';
export const IS_SATELLITE = MAP_SOURCE !== 'carto';

export const MAP_STYLE = {
  esri: ESRI_PREVIEW_STYLE,
  eox: EOX_PREVIEW_STYLE,
  maptiler: `https://api.maptiler.com/maps/hybrid/style.json?key=${MAPTILER_KEY}`,
  stadia: `https://tiles.stadiamaps.com/styles/alidade_satellite.json${STADIA_KEY ? `?api_key=${STADIA_KEY}` : ''}`,
  // free for non-commercial use, and light vector tiles (dense cities stay quick to zoom)
  carto: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
}[MAP_SOURCE];

/** The map's look: labels for the satellite map (they load a little later), and our colours. */
export function dressMap(m: Map, signal: AbortSignal): void {
  if (MAP_SOURCE === 'esri') {
    void loadEsriHybridStyle(signal).then((style) => {
      if (!signal.aborted) m.setStyle(style);
    }).catch((error: unknown) => {
      if (!signal.aborted) console.warn('Could not load Esri vector labels', error);
    });
  }
  m.on('style.load', () => (IS_SATELLITE ? applySatellitePalette(m) : applyCartoPalette(m)));
}

/** Calm light palette for CARTO "Voyager" (white streets, soft greys, bright water, green parks). */
function applyCartoPalette(m: Map) {
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

/** Apple-like satellite look: white labels with soft dark halos, faint roads, a bit more colour. */
function applySatellitePalette(m: Map) {
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
