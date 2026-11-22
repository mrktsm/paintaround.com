import { PANORAMAS, PANORAMA_BY_ID } from './catalog';
import { drawnPreviewUrl } from './drawnPreviews';
import type { Panorama } from './catalog';

// Share downloads across map previews and viewer instances, including StrictMode
// remounts. Only retain the three most recently requested panoramas.
const imageUrls = new Set(PANORAMAS.map(panorama => panorama.imageUrl));
const downloads = new Map<string, Promise<ArrayBuffer>>();
const CACHE_LIMIT = 3;
const loadingPreviews = new Map<string, HTMLImageElement>();
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
let hoverId: string | undefined;

export function panoramaLoadingPreviewUrl(panorama: Panorama): string {
  // with drawings, the loading frame shows them too (same framing as the original)
  return drawnPreviewUrl(panorama.id, 'loading')
    ?? panorama.thumbnailUrl?.replace(/-card\.jpg$/, '-loading.jpg') ?? panorama.previewUrl;
}

export function getPanoramaImageBuffer(url: string, abort?: Promise<void>, priority: RequestPriority = 'high'): Promise<ArrayBuffer> {
  if (!imageUrls.has(url)) return Promise.reject(new Error('Unknown panorama image URL'));

  let download = downloads.get(url);
  if (download) {
    downloads.delete(url);
    downloads.set(url, download);
  } else {
    download = fetch(url, { priority }).then(async response => {
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
        throw new Error('This panorama image is unavailable. Restore the local panorama pool and try again.');
      }
      return response.arrayBuffer();
    });
    const pending = download;
    void download.catch(() => {
      if (downloads.get(url) === pending) downloads.delete(url);
    });
    downloads.set(url, download);
    while (downloads.size > CACHE_LIMIT) downloads.delete(downloads.keys().next().value!);
  }

  // Cancel this consumer without canceling a download another viewer or preview
  // is using. A canceled SDK instance must not receive its completed image.
  return abort ? Promise.race([download, abort.then(() => new Promise<never>(() => {}), () => {
    throw new DOMException('Panorama request canceled', 'AbortError');
  })]) : download;
}

export function prefetchPanorama(id: string): void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType ?? '')) return;
  const panorama = PANORAMA_BY_ID.get(id);
  if (!panorama) return;
  if (!loadingPreviews.has(id)) {
    const preview = new Image();
    preview.decoding = 'async';
    preview.fetchPriority = 'low';
    preview.src = panoramaLoadingPreviewUrl(panorama);
    loadingPreviews.set(id, preview);
    while (loadingPreviews.size > CACHE_LIMIT) loadingPreviews.delete(loadingPreviews.keys().next().value!);
  }
  void getPanoramaImageBuffer(panorama.imageUrl, undefined, 'low').catch(() => {});
}

export function queuePanoramaPrefetch(id: string): void {
  clearTimeout(hoverTimer);
  hoverId = id;
  hoverTimer = setTimeout(() => {
    hoverId = undefined;
    prefetchPanorama(id);
  }, 120);
}

export function cancelPanoramaPrefetch(id: string): void {
  if (hoverId !== id) return;
  clearTimeout(hoverTimer);
  hoverId = undefined;
}
