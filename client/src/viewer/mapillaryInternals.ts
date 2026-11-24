/**
 * The parts of mapillary-js that aren't in its public API but that drawing in sync with the photo
 * needs: turning the camera freely, and the camera the current frame is rendered with. Everything
 * reaches them through here, so an update of mapillary-js has one place to check.
 */
import type { Viewer } from 'mapillary-js';

interface Matrix {
  elements: number[];
  clone(): Matrix & { invert(): Matrix };
}

/** The camera the photo is being rendered with. */
export interface RenderCamera {
  perspective?: { projectionMatrix?: Matrix; matrixWorldInverse?: Matrix };
}

/** How the photo is placed in the world. */
export interface PhotoTransform {
  rt?: Matrix;
  cameraType?: string;
  focal: number;
  width: number;
  height: number;
  ck1?: number;
  ck2?: number;
  orientation?: number;
}

export interface Subscription { unsubscribe(): void }
interface Observable<T> { subscribe(next: (value: T) => void): Subscription }

export interface Projection {
  basicToCanvas(basic: number[], container: HTMLElement, camera: RenderCamera, transform: PhotoTransform): [number, number] | null;
  canvasToBasic(canvas: number[], container: HTMLElement, camera: RenderCamera, transform: PhotoTransform): [number, number] | null;
}

interface StateService {
  currentTransform$?: Observable<PhotoTransform>;
  rotateBasicUnbounded(delta: [number, number]): void;
  setZoom(zoom: number): void;
}

interface Internals {
  _container?: { renderService?: { renderCameraFrame$?: Observable<RenderCamera> }; _container?: HTMLElement; container?: HTMLElement; element?: HTMLElement };
  _navigator: { stateService: StateService };
  _observer?: { _projection?: Projection };
}

const internals = (viewer: Viewer) => viewer as unknown as Internals;

/** Turn the camera by this much of the panorama (no limits, unlike the public API). */
export function rotateBy(viewer: Viewer, dx: number, dy: number): void {
  internals(viewer)._navigator.stateService.rotateBasicUnbounded([dx, dy]);
}

/** Zoom without the public API's animation. */
export function zoomTo(viewer: Viewer, zoom: number): void {
  internals(viewer)._navigator.stateService.setZoom(zoom);
}

/** Follow the camera of every rendered frame, and the photo's placement. */
export function followCamera(viewer: Viewer, onCamera: (camera: RenderCamera) => void, onTransform: (transform: PhotoTransform) => void): Subscription[] {
  const v = internals(viewer), subs: Subscription[] = [];
  const camera$ = v._container?.renderService?.renderCameraFrame$, transform$ = v._navigator?.stateService?.currentTransform$;
  if (camera$) subs.push(camera$.subscribe(onCamera));
  if (transform$) subs.push(transform$.subscribe(onTransform));
  return subs;
}

/** What projects panorama coordinates to the screen right now (null if it can't be reached). */
export function screenProjection(viewer: Viewer): { projection: Projection; container: HTMLElement } | null {
  const v = internals(viewer);
  const projection = v._observer?._projection;
  const container = v._container?._container ?? v._container?.container ?? v._container?.element;
  return projection && container ? { projection, container } : null;
}
