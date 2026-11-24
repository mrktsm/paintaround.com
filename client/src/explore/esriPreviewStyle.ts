import type { StyleSpecification } from 'maplibre-gl';

// Public Esri imagery and vector-reference services. These URLs do not configure
// an ArcGIS account, subscription, or usage entitlement.
const service = 'https://services.arcgisonline.com/ArcGIS/rest/services';
const imageryTiles = [`${service}/World_Imagery/MapServer/tile/{z}/{y}/{x}`];
export const ESRI_DATA_CREDIT = 'Esri, Vantor, Earthstar Geographics, TomTom, Garmin, FAO, NOAA, USGS, and the GIS User Community';
const vectorService = 'https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer';
const referenceStyle = 'https://www.arcgis.com/sharing/rest/content/items/30d6b8271e1849cd9c3042060001f425/resources/styles/root.json';

export const ESRI_PREVIEW_STYLE: StyleSpecification = {
  version: 8,
  name: 'Esri imagery preview',
  sources: {
    // Keep a few coarse tiles ready beneath the detail layer. Zooming out can
    // reveal large areas before their detailed tiles have arrived.
    'esri-overview': {
      type: 'raster',
      tiles: imageryTiles,
      tileSize: 256,
      maxzoom: 3,
    },
    'esri-imagery': {
      type: 'raster',
      tiles: imageryTiles,
      tileSize: 256,
      maxzoom: 19,
      attribution: ESRI_DATA_CREDIT,
    },
  },
  layers: [
    { id: 'esri-overview', type: 'raster', source: 'esri-overview', paint: { 'raster-fade-duration': 0 } },
    { id: 'esri-imagery', type: 'raster', source: 'esri-imagery', paint: { 'raster-fade-duration': 0 } },
  ],
};

/** Render reference text as vectors so it stays sharp on Retina screens and during zoom. */
export async function loadEsriHybridStyle(signal: AbortSignal): Promise<StyleSpecification> {
  const response = await fetch(referenceStyle, { signal });
  if (!response.ok) throw new Error(`Esri reference style: ${response.status}`);
  const reference: StyleSpecification = await response.json();
  return {
    ...ESRI_PREVIEW_STYLE,
    name: 'Esri imagery with vector labels',
    sprite: reference.sprite,
    glyphs: reference.glyphs,
    sources: {
      ...ESRI_PREVIEW_STYLE.sources,
      esri: {
        type: 'vector',
        tiles: [`${vectorService}/tile/{z}/{y}/{x}.pbf`],
        maxzoom: 14,
        attribution: ESRI_DATA_CREDIT,
      },
    },
    layers: [...ESRI_PREVIEW_STYLE.layers, ...reference.layers],
  };
}
