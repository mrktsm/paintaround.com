import type { HeatmapLayerSpecification } from 'maplibre-gl';

export const HEATMAP_FADE_START = 12.5;
export const PHOTO_ZOOM = 13.5;

export function photoPinOpacity(zoom: number): number {
  return Math.max(0, Math.min(1, (zoom - HEATMAP_FADE_START) / (PHOTO_ZOOM - HEATMAP_FADE_START)));
}

export function heatmapRadius(zoom: number): number {
  return 30 + Math.max(0, Math.min(PHOTO_ZOOM, zoom)) * 2.5;
}

/** Equal weight for every mapped panorama. Warmth currently means place density. */
export function spotsHeatmapLayer(): HeatmapLayerSpecification {
  return {
    id: 'spots-heatmap',
    type: 'heatmap',
    source: 'spots',
    maxzoom: PHOTO_ZOOM,
    paint: {
      'heatmap-weight': 1,
      // At world scale many places share a few pixels. Lower their combined
      // intensity there so whole cities don't immediately hit the warmest colour.
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 0.06, 3, 0.18, 6, 0.32, 9, 0.42, HEATMAP_FADE_START, 0.5],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, heatmapRadius(0), PHOTO_ZOOM, heatmapRadius(PHOTO_ZOOM)],
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(143, 171, 239, 0)',
        0.04, 'rgba(114, 148, 234, 0.28)',
        0.14, 'rgba(135, 159, 233, 0.65)',
        0.35, 'rgba(166, 153, 226, 0.75)',
        0.62, 'rgba(236, 191, 174, 0.8)',
        0.82, 'rgba(239, 167, 167, 0.85)',
        1, 'rgba(225, 144, 176, 0.88)',
      ],
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], HEATMAP_FADE_START, 0.72, PHOTO_ZOOM, 0],
    },
  };
}
