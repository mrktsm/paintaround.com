import { useEffect, useRef, useState, type RefObject } from 'react';
import { TransitionMode, Viewer } from 'mapillary-js';
import { loadDeepData } from '../deep/surfaceDecal';
import { DrawingOverlay } from '../drawing/DrawingOverlay';
import { PanoramaDataProvider } from '../pool/PanoramaDataProvider';
import type { Panorama } from '../pool/catalog';
import { showOwnDrawing } from '../pool/localPreview';
import { START_ZOOM } from '../pool/startView';

/** Only the photo: the viewer's own controls are replaced by ours. */
const COMPONENTS = {
  attribution: false, bearing: false, cache: false, cover: false, direction: false, image: true, keyboard: true, marker: false,
  pointer: true, popup: false, sequence: false, slider: false, spatial: false, tag: false, zoom: false,
};

/** The place's photo and everything drawn on it. */
export function usePanorama(container: RefObject<HTMLDivElement | null>, panorama: Panorama, onHistoryChange: (overlay: DrawingOverlay) => void) {
  const viewer = useRef<Viewer | null>(null);
  const overlay = useRef<DrawingOverlay | null>(null);
  /** The photo is up. */
  const [isLoaded, setIsLoaded] = useState(false);
  /** The place is ready to draw on (a bit later). */
  const [isReady, setIsReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    const imageId = panorama.id;
    let disposed = false;
    let cameraReady = false, rendered = false;
    let revealFrame: number | undefined;
    const reveal = () => {
      if (disposed || !cameraReady || !rendered) return;
      revealFrame ??= requestAnimationFrame(() => { if (!disposed) setIsLoaded(true); });
    };

    // alongside the photo: the view can appear right away, drawing waits until its lighting is there
    void loadDeepData(imageId);
    const v = new Viewer({
      dataProvider: new PanoramaDataProvider(),
      container: container.current,
      imageTiling: false,
      component: COMPONENTS,
      transitionMode: TransitionMode.Instantaneous,
    });
    const o = new DrawingOverlay(container.current);
    viewer.current = v;
    overlay.current = o;
    v.on('load', () => { rendered = true; reveal(); });
    v.on('image', (event) => {
      if (disposed || !event?.image?.id) return;
      const id = String(event.image.id);
      o.setImageId(id);
      o.subscribeToRealtime(id);
    });
    o.onHistoryChange = () => onHistoryChange(o);
    o.onReady = () => {
      void loadDeepData(imageId).then(() => {
        if (disposed) return;
        o.fadeIn();
        setIsReady(true);
      });
    };
    o.setViewer(v);
    v.deactivateComponent('pointer'); // we turn the camera ourselves (see Camera)
    void v.moveTo(imageId).then(() => {
      if (disposed) return;
      v.setCenter([panorama.thumbnailView?.u ?? 0.75, panorama.thumbnailView?.v ?? 0.5]);
      v.setZoom(START_ZOOM); // same camera the loading preview was rendered with
      // shown once that camera is applied, so the viewer's default direction doesn't flash by
      cameraReady = true;
      reveal();
    }).catch((error: unknown) => {
      if (disposed) return;
      console.error('Could not load panorama', error);
      setFailed(true);
    });

    return () => {
      disposed = true;
      if (revealFrame !== undefined) cancelAnimationFrame(revealFrame);
      setIsLoaded(false);
      showOwnDrawing(panorama, o); // left some other way (browser back)
      o.dispose();
      overlay.current = null;
      try {
        v.remove();
      } catch (e) {
        console.debug('Mapillary cleanup error:', e);
      }
      viewer.current = null;
    };
  }, [container, panorama, onHistoryChange]);

  return { viewer, overlay, isLoaded, isReady, failed };
}
