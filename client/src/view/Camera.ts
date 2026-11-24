import type { Viewer } from 'mapillary-js';
import { rotateBy, zoomTo } from '../viewer/mapillaryInternals';

interface Point { x: number; y: number }
interface Move { dx: number; dy: number; time: number }

/** A drag (one point) or pinch (the middle of two). */
interface Gesture {
  last: Point;
  moves: Move[];
  /** Unknown until the viewer has said so: the view doesn't move before that. */
  fov: number | null;
  pinch: { dist: number; zoom: number } | null;
}

const middle = ([a, b]: Point[]): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = ([a, b]: Point[]): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Looking around: dragging, pinching, the wheel or trackpad, and gliding on after letting go. */
export class Camera {
  private gesture: Gesture | null = null;
  private glideFrame: number | null = null;
  private wheelZoom: number | null = null;
  private wheelFov = 90;
  /**
   * One decision per gesture: a fast two-finger flick sends big whole-number steps that look like a
   * mouse wheel, so judging every event alone made fast swipes zoom mid-pan. Once a gesture looks
   * like a trackpad it stays a pan until the wheel events pause.
   */
  private wheelKind: 'trackpad' | 'wheel' | null = null;
  private lastWheel = 0;
  private readonly container: HTMLElement;
  private readonly viewer: () => Viewer | null;

  constructor(container: HTMLElement, viewer: () => Viewer | null) {
    this.container = container;
    this.viewer = viewer;
  }

  get dragging(): boolean {
    return !!this.gesture && !this.gesture.pinch;
  }

  get pinching(): boolean {
    return !!this.gesture?.pinch;
  }

  /** Start turning with one point (a drag) or two (which also zoom). */
  start(points: Point[]): void {
    const viewer = this.viewer();
    if (!viewer) return;
    this.stop();
    const two = points.length > 1;
    const g: Gesture = { last: two ? middle(points) : points[0], moves: [], fov: null, pinch: two ? { dist: distance(points), zoom: 0 } : null };
    this.gesture = g;
    void Promise.all([viewer.getFieldOfView(), viewer.getZoom()]).then(([fov, zoom]) => {
      if (g.pinch) g.pinch.zoom = zoom;
      g.fov = fov;
    });
  }

  move(points: Point[]): void {
    const g = this.gesture, viewer = this.viewer();
    if (!g || g.fov === null || !viewer) return;
    if (g.pinch && points.length < 2) return;
    const at = g.pinch ? middle(points) : points[0];
    const { dx, dy } = this.turn(at.x - g.last.x, at.y - g.last.y, g.fov);
    rotateBy(viewer, -dx, -dy);
    g.moves.push({ dx: -dx, dy: -dy, time: Date.now() });
    if (g.moves.length > 20) g.moves.shift();
    g.last = at;
    if (!g.pinch) return;
    // a third of Mapillary's own zoom speed, so drifting fingers while panning barely zoom
    const dist = distance(points), { width, height } = this.size();
    g.pinch.zoom = Math.max(0, g.pinch.zoom + (0.8 * (dist - g.pinch.dist)) / Math.min(width, height));
    g.pinch.dist = dist;
    zoomTo(viewer, g.pinch.zoom);
  }

  /** Let go: the view glides on, like Mapillary's own dragging. */
  end(): void {
    const moves = this.gesture?.moves.filter(m => Date.now() - m.time <= 50) ?? [];
    this.gesture = null;
    if (!moves.length) return;
    let dx = moves.reduce((sum, m) => sum + m.dx, 0) / moves.length;
    let dy = moves.reduce((sum, m) => sum + m.dy, 0) / moves.length;
    const glide = () => {
      const viewer = this.viewer();
      dx *= 0.86;
      dy *= 0.86;
      this.glideFrame = null;
      if (!viewer || (Math.abs(dx) < 1e-5 && Math.abs(dy) < 1e-5)) return;
      rotateBy(viewer, dx, dy);
      this.glideFrame = requestAnimationFrame(glide);
    };
    this.glideFrame = requestAnimationFrame(glide);
  }

  /** Stop gliding. */
  stop(): void {
    if (this.glideFrame !== null) cancelAnimationFrame(this.glideFrame);
    this.glideFrame = null;
  }

  /** Two-finger swipe on a trackpad looks around, pinching zooms, a mouse wheel zooms. */
  wheel(e: WheelEvent): void {
    const viewer = this.viewer();
    if (!viewer) return;
    e.preventDefault();
    if (!e.ctrlKey && this.isTrackpad(e)) {
      void viewer.getFieldOfView().then(f => { this.wheelFov = f; });
      // same feel as dragging: fingers move left -> scene follows -> camera turns right
      const { dx, dy } = this.turn(e.deltaX, e.deltaY, this.wheelFov);
      rotateBy(viewer, dx, dy);
      return;
    }
    if (this.wheelZoom === null) {
      this.wheelZoom = 0;
      void viewer.getZoom().then(z => { this.wheelZoom = z; });
      return;
    }
    // pinch (a wheel event with ctrl) sends small deltas: scaled up so zooming feels natural
    const delta = -e.deltaY * (e.ctrlKey ? 0.01 : 0.002);
    this.wheelZoom = Math.max(0, Math.min(3, this.wheelZoom + delta));
    zoomTo(viewer, this.wheelZoom);
  }

  /**
   * Trackpad scrolls are in pixels, with small or fractional steps or a horizontal part; Chrome and
   * Safari also report them with wheelDelta exactly -3 times delta (a mouse notch is ±120). Mouse
   * wheels send larger whole-number vertical steps.
   */
  private isTrackpad(e: WheelEvent): boolean {
    const now = performance.now();
    if (now - this.lastWheel > 220) this.wheelKind = null;
    this.lastWheel = now;
    const { wheelDeltaY } = e as WheelEvent & { wheelDeltaY?: number };
    const looksLike = e.deltaMode === 0 && (
      e.deltaX !== 0 || !Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 40 ||
      (!!wheelDeltaY && wheelDeltaY === -3 * e.deltaY));
    if (looksLike) this.wheelKind = 'trackpad'; // a wheel never sends these
    else this.wheelKind ??= 'wheel';
    return this.wheelKind === 'trackpad';
  }

  /** Screen px -> how much of the panorama that is (it spans 360° × 180°). */
  private turn(x: number, y: number, fov: number): { dx: number; dy: number } {
    const { width, height } = this.size();
    const ease = 1.25; // makes up for rotateBy easing 0.8 of the way
    return { dx: (x / width) * ((fov * width) / height / 360) * ease, dy: (y / height) * (fov / 180) * ease };
  }

  private size(): { width: number; height: number } {
    return { width: this.container.clientWidth || window.innerWidth, height: this.container.clientHeight || window.innerHeight };
  }
}
