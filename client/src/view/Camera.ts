import type { Viewer } from 'mapillary-js';
import { rotateBy, zoomTo } from '../viewer/mapillaryInternals';

interface Point { x: number; y: number }
interface Move { dx: number; dy: number; time: number }

/** A drag (one point) or pinch (the middle of two). */
interface Gesture {
  last: Point;
  moves: Move[];
  touch: boolean;
  /** Unknown until the viewer has said so: the view doesn't move before that. */
  fov: number | null;
  /** The distance between the two fingers of a pinch. */
  pinch: number | null;
}

/** How much of its speed the view keeps per millisecond after letting go: fingers flick it far, like scrolling. */
const GLIDE = { touch: 0.9972, mouse: 0.993 };
/** Phones show a narrow part of the view, so following the fingers exactly turns slowly. */
const TOUCH_GAIN = 1.3;
const MAX_ZOOM = 3;

const middle = ([a, b]: Point[]): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = ([a, b]: Point[]): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Looking around: dragging, pinching, the wheel or trackpad, keys, and gliding on after letting go. */
export class Camera {
  private gesture: Gesture | null = null;
  private glideFrame: number | null = null;
  /** Null until asked for. */
  private zoom: number | null = null;
  private fov = 90;
  private held = { x: 0, y: 0, zoom: 0 };
  private keyFrame: number | null = null;
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
    return !!this.gesture && this.gesture.pinch === null;
  }

  get pinching(): boolean {
    return this.gesture ? this.gesture.pinch !== null : false;
  }

  /** Start turning with one point (a drag) or two (which also zoom). */
  start(points: Point[], touch = points.length > 1): void {
    const viewer = this.viewer();
    if (!viewer) return;
    this.stop();
    const two = points.length > 1;
    const g: Gesture = { last: two ? middle(points) : points[0], moves: [], touch, fov: null, pinch: two ? distance(points) : null };
    this.gesture = g;
    void Promise.all([viewer.getFieldOfView(), viewer.getZoom()]).then(([fov, zoom]) => {
      this.zoom = zoom;
      g.fov = fov;
    });
  }

  move(points: Point[]): void {
    const g = this.gesture, viewer = this.viewer();
    if (!g || g.fov === null || !viewer) return;
    if (g.pinch !== null && points.length < 2) return;
    const at = g.pinch === null ? points[0] : middle(points), gain = g.touch ? TOUCH_GAIN : 1;
    const { dx, dy } = this.turn((at.x - g.last.x) * gain, (at.y - g.last.y) * gain, g.fov);
    rotateBy(viewer, -dx, -dy);
    g.moves.push({ dx: -dx, dy: -dy, time: performance.now() });
    if (g.moves.length > 20) g.moves.shift();
    g.last = at;
    if (g.pinch === null) return;
    // a third of Mapillary's own zoom speed, so drifting fingers while panning barely zoom
    const dist = distance(points), { width, height } = this.size();
    this.zoomTo(viewer, (this.zoom ?? 0) + (0.8 * (dist - g.pinch)) / Math.min(width, height));
    g.pinch = dist;
  }

  /** Let go: the view glides on. */
  end(): void {
    const g = this.gesture, now = performance.now();
    this.gesture = null;
    const moves = g?.moves.filter(m => now - m.time <= 80) ?? [];
    if (!g || moves.length < 2 || now - moves[moves.length - 1].time > 50) return; // held still before letting go
    const time = Math.max(16, now - moves[0].time);
    let vx = moves.slice(1).reduce((sum, m) => sum + m.dx, 0) / time, vy = moves.slice(1).reduce((sum, m) => sum + m.dy, 0) / time;
    const keep = g.touch ? GLIDE.touch : GLIDE.mouse;
    let last = now;
    const glide = (t: number) => {
      const viewer = this.viewer(), dt = Math.min(50, Math.max(0, t - last));
      last = t;
      this.glideFrame = null;
      if (!viewer || Math.hypot(vx, vy) < 1e-6) return;
      rotateBy(viewer, vx * dt, vy * dt);
      vx *= keep ** dt;
      vy *= keep ** dt;
      this.glideFrame = requestAnimationFrame(glide);
    };
    this.glideFrame = requestAnimationFrame(glide);
  }

  /** Let go without gliding. */
  cancel(): void {
    this.gesture = null;
  }

  /** Turn and zoom for as long as keys are held: -1, 0 or 1 each. */
  hold(x: number, y: number, zoom: number): void {
    this.held = { x, y, zoom };
    if (this.keyFrame !== null || (!x && !y && !zoom)) return;
    this.stop();
    let last = performance.now();
    const now = { x: 0, y: 0, zoom: 0 }; // eased, so it starts and stops softly
    const frame = (t: number) => {
      const viewer = this.viewer(), dt = Math.min(50, Math.max(0, t - last)), ease = 1 - 0.988 ** dt;
      last = t;
      for (const k of ['x', 'y', 'zoom'] as const) now[k] += (this.held[k] - now[k]) * ease;
      const idle = !this.held.x && !this.held.y && !this.held.zoom && Math.hypot(now.x, now.y, now.zoom) < 0.01;
      this.keyFrame = null;
      if (!viewer || idle) return;
      void viewer.getFieldOfView().then(f => { this.fov = f; });
      const degrees = (this.fov * 0.9 * dt) / 1000;
      if (now.x || now.y) rotateBy(viewer, (now.x * degrees) / 360, (now.y * degrees) / 180);
      if (Math.abs(now.zoom) > 0.01) {
        if (this.zoom === null) this.askZoom(viewer);
        else this.zoomTo(viewer, this.zoom + (now.zoom * 1.3 * dt) / 1000);
      }
      this.keyFrame = requestAnimationFrame(frame);
    };
    this.keyFrame = requestAnimationFrame(frame);
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
      this.stop();
      void viewer.getFieldOfView().then(f => { this.fov = f; });
      // same feel as dragging: fingers move left -> scene follows -> camera turns right
      const { dx, dy } = this.turn(e.deltaX, e.deltaY, this.fov);
      rotateBy(viewer, dx, dy);
      return;
    }
    if (this.zoom === null) {
      this.askZoom(viewer);
      return;
    }
    // pinch (a wheel event with ctrl) sends small deltas: scaled up so zooming feels natural
    this.zoomTo(viewer, this.zoom - e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
  }

  private askZoom(viewer: Viewer): void {
    void viewer.getZoom().then(z => { this.zoom ??= z; });
  }

  private zoomTo(viewer: Viewer, zoom: number): void {
    this.zoom = Math.max(0, Math.min(MAX_ZOOM, zoom));
    zoomTo(viewer, this.zoom);
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

  /** Screen px -> how much of the panorama that is (it spans 360° × 180°), in the middle of the screen. */
  private turn(x: number, y: number, fov: number): { dx: number; dy: number } {
    const radiansPerPx = (2 * Math.tan((fov * Math.PI) / 360)) / this.size().height;
    return { dx: (x * radiansPerPx) / (2 * Math.PI), dy: (y * radiansPerPx) / Math.PI };
  }

  private size(): { width: number; height: number } {
    return { width: this.container.clientWidth || window.innerWidth, height: this.container.clientHeight || window.innerHeight };
  }
}
