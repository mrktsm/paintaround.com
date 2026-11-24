import { useEffect, useRef, useState, type RefObject } from 'react';
import { TransitionMode, Viewer } from 'mapillary-js';
import { loadDeepData } from '../deep/surfaceDecal';
import { DrawingOverlay } from '../drawing/DrawingOverlay';
import { PanoramaDataProvider } from '../pool/PanoramaDataProvider';
import type { LookingAt } from '../../../shared/shareView';
import type { Panorama } from '../pool/catalog';
import { showOwnDrawing } from '../pool/localPreview';
import { START_ZOOM } from '../../../shared/startView';

/** Only the photo: the viewer's own controls are replaced by ours. */
const COMPONENTS = {
  attribution: false, bearing: false, cache: false, cover: false, direction: false, image: true, keyboard: true, marker: false,
  pointer: true, popup: false, sequence: false, slider: false, spatial: false, tag: false, zoom: false,
};

/** A shared link's picture stays up this long at most, for the drawings to load behind it. */
const WAIT_FOR_DRAWINGS_MS = 2000;

/** The place's photo and everything drawn on it. `at`: where a shared link looks. */
export function usePanorama(container: RefObject<HTMLDivElement | null>, panorama: Panorama, at: LookingAt | null, onHistoryChange: (overlay: DrawingOverlay) => void) {
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
      revealFrame ??= requestAnimationFrame(() => { if (!disposed) void show(); });
    };
    const show = async () => {
      if (at) {
        // its picture has the drawings: swap it for the place once they're there too
        await Promise.race([o.drawingsLoaded(), new Promise(r => setTimeout(r, WAIT_FOR_DRAWINGS_MS))]);
        if (disposed) return;
        o.show(false);
      }
      setIsLoaded(true);
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
        o.show(!at);
        setIsReady(true);
      });
    };
    o.setViewer(v);
    v.deactivateComponent('pointer'); // we turn the camera ourselves (see Camera)
    void v.moveTo(imageId).then(() => {
      if (disposed) return;
      // same camera the loading picture was rendered with
      v.setCenter(at ? [at.u, at.v] : [panorama.thumbnailView?.u ?? 0.75, panorama.thumbnailView?.v ?? 0.5]);
      v.setZoom(at?.zoom ?? START_ZOOM);
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
  }, [container, panorama, at, onHistoryChange]);

  return { viewer, overlay, isLoaded, isReady, failed };
}
