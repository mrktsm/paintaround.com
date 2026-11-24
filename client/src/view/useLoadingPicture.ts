import { useEffect, useState } from 'react';
import type { LookingAt } from '../../../shared/shareView';
import panoramaPreview from '../assets/panorama-preview.jpg';
import type { Panorama } from '../pool/catalog';
import { panoramaLoadingPreviewUrl } from '../pool/panoramaImages';
import { sharePictureUrl } from './share';

/**
 * What's shown while a place loads, as a CSS background: the place as it opens, or a shared link's
 * picture. (If that can't be had, the usual one.)
 */
export function useLoadingPicture(panorama: Panorama, at: LookingAt | null): string | undefined {
  const usual = `url(${panoramaLoadingPreviewUrl(panorama)}), url(${panorama.thumbnailUrl || panorama.previewUrl || panoramaPreview})`;
  const shared = at && sharePictureUrl(panorama.id, at);
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  useEffect(() => {
    if (!shared) return;
    const img = new Image();
    img.onload = () => setState('loaded');
    img.onerror = () => setState('failed');
    img.src = shared;
    return () => { img.onload = img.onerror = null; };
  }, [shared]);
  if (!shared || state === 'failed') return usual;
  return state === 'loaded' ? `url(${shared})` : undefined;
}
