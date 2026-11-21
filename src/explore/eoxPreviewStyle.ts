import type { StyleSpecification } from 'maplibre-gl';

// Public non-commercial preview. The 2024 mosaic is Sentinel-2 imagery at 10 m;
// overzoom its last native tile level instead of requesting nonexistent detail.
export const EOX_PREVIEW_STYLE: StyleSpecification = {
  version: 8,
  name: 'EOX Sentinel-2 cloudless 2024',
  sources: {
    'eox-imagery': {
      type: 'raster',
      tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg'],
      tileSize: 256,
      maxzoom: 14,
      attribution: 'EOxCloudless by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)',
    },
    'eox-labels': {
      type: 'raster',
      tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/overlay_3857/default/g/{z}/{y}/{x}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Data © OpenStreetMap contributors, Rendering © EOX and MapServer',
    },
  },
  layers: [
    { id: 'eox-imagery', type: 'raster', source: 'eox-imagery', paint: { 'raster-fade-duration': 0 } },
    { id: 'eox-labels', type: 'raster', source: 'eox-labels', paint: { 'raster-fade-duration': 0 } },
  ],
};
