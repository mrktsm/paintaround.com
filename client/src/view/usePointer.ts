import { useEffect, useMemo, useRef, type PointerEvent, type RefObject } from 'react';
import type { Viewer } from 'mapillary-js';
import type { DrawingOverlay } from '../drawing/DrawingOverlay';
import { Camera } from './Camera';
import { BRUSH_RADIUS, lineWidth, type Tool } from './tools';

interface Options {
  container: RefObject<HTMLDivElement | null>;
  viewer: RefObject<Viewer | null>;
  overlay: RefObject<DrawingOverlay | null>;
  /** Null: the pens are down, and everything looks around. */
  tool: Tool | null;
  color: string;
  /** Can be drawn on yet? (Looking around always works.) */
  canDraw: boolean;
  onLookAround(): void;
}

/**
 * Drawing with a mouse, finger or pen. Two fingers, the right button, Shift or Space look around, and so
 * does everything while no pen is picked. Two fingers tapping undo, three redo.
 */
export function usePointer(options: Options) {
  const { container } = options;
  const latest = useRef(options);
  useEffect(() => { latest.current = options; });
  const input = useMemo(() => new PointerInput(latest), []);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => input.wheel(e);
    const noMenu = (e: MouseEvent) => e.preventDefault(); // the right button looks around
    el.addEventListener('wheel', wheel, { passive: false, capture: true });
    el.addEventListener('contextmenu', noMenu, { capture: true });
    const offKeys = input.listenToKeys();
    return () => {
      el.removeEventListener('wheel', wheel, { capture: true });
      el.removeEventListener('contextmenu', noMenu, { capture: true });
      offKeys();
    };
  }, [container, input]);

  return input;
}

/** How far (px) and how long (ms) a tap with several fingers may go. */
const TAP = { move: 14, time: 320 };
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

class PointerInput {
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private drawing = false;
  private erasing = false;
  /** A finger is down but hasn't moved: a second one may follow, to look around instead. */
  private waiting: { x: number; y: number; color: string; tool: Tool; time: number } | null = null;
  /** Several fingers are down, maybe for a tap: how many there were, where they started, since when. */
  private tap: { fingers: number; starts: Map<number, { x: number; y: number }>; since: number; moved: boolean } | null = null;
  private readonly keys = new Set<string>();
  private cameraOf: Camera | null = null;
  private readonly options: RefObject<Options>;

  constructor(options: RefObject<Options>) {
    this.options = options;
  }

  private get overlay(): DrawingOverlay | null {
    return this.options.current.overlay.current;
  }

  private get camera(): Camera | null {
    const { container, viewer } = this.options.current;
    if (container.current) this.cameraOf ??= new Camera(container.current, () => viewer.current);
    return this.cameraOf;
  }

  private position(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.options.current.container.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  }

  wheel(e: WheelEvent): void {
    this.camera?.wheel(e);
  }

  readonly down = (e: PointerEvent): void => {
    const { tool, color, canDraw, onLookAround } = this.options.current;
    e.nativeEvent.stopImmediatePropagation(); // the viewer's own controls stay out of it
    const pos = this.position(e), touch = e.pointerType === 'touch';
    this.pointers.set(e.pointerId, pos);
    if (touch) this.trackTap(e.pointerId, pos);

    if (this.pointers.size > 1) {
      onLookAround();
      this.waiting = null;
      this.cancelDrawing();
      this.camera?.start([...this.pointers.values()]);
      return;
    }
    const overlay = this.overlay;
    if (!overlay) return;
    if (!tool || e.button === 1 || e.button === 2 || e.shiftKey || this.keys.has('Space')) {
      onLookAround();
      this.look(pos, touch);
      return;
    }
    if (!canDraw) return;
    this.camera?.stop();
    if (touch) {
      this.waiting = { ...pos, color, tool, time: Date.now() };
      return;
    }
    this.begin(overlay, pos, color, tool, e.pointerType !== 'mouse');
  };

  readonly move = (e: PointerEvent): void => {
    const { tool, color } = this.options.current;
    e.nativeEvent.stopImmediatePropagation();
    const pos = this.position(e), overlay = this.overlay;
    const start = this.tap?.starts.get(e.pointerId);
    if (this.tap && start && Math.hypot(pos.x - start.x, pos.y - start.y) > TAP.move) this.tap.moved = true;
    if (this.camera?.dragging) {
      // the brush outline stays pinned to its spot in the scene meanwhile
      if (this.pointers.has(e.pointerId)) this.camera.move([pos]);
      return;
    }
    if (this.pointers.size > 1) {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, pos);
      this.camera?.move([...this.pointers.values()]);
      return;
    }
    if (!overlay) return;

    // the ring under the mouse previews the colour, lit like the stroke; while a button is held the
    // stroke itself is the preview (and the eraser's ring is never filled)
    const mouse = e.pointerType === 'mouse';
    if (!mouse || !tool || this.keys.has('Space')) overlay.hideBrushCursor();
    else overlay.updateBrushCursor(pos.x, pos.y, BRUSH_RADIUS[tool], tool !== 'eraser' && e.buttons === 0 ? color : null);
    if (!tool) return;

    const radius = BRUSH_RADIUS[tool], wait = this.waiting;
    if (wait) {
      // far and long enough not to be the first finger of a pinch
      if (Math.hypot(pos.x - wait.x, pos.y - wait.y) <= 6 || Date.now() - wait.time <= 80) return;
      this.waiting = null;
      this.begin(overlay, wait, wait.color, wait.tool, true);
      if (wait.tool === 'eraser') overlay.eraseAt(pos.x, pos.y, radius);
      else overlay.addPoint(pos.x, pos.y);
    } else if (this.erasing) {
      if (!mouse) overlay.shareTouchCursor(pos.x, pos.y, radius);
      overlay.eraseAt(pos.x, pos.y, radius);
    } else if (this.drawing) {
      // pens and fast fingers report several points per frame: with all of them quick curves stay curves
      for (const s of e.nativeEvent.getCoalescedEvents?.() ?? []) {
        const p = this.position(s);
        overlay.addPoint(p.x, p.y);
      }
      overlay.addPoint(pos.x, pos.y);
      if (!mouse) overlay.shareTouchCursor(pos.x, pos.y, radius);
    }
  };

  readonly up = (e: PointerEvent): void => {
    const { tool, container } = this.options.current;
    e.nativeEvent.stopImmediatePropagation();
    const overlay = this.overlay, camera = this.camera;
    this.pointers.delete(e.pointerId);
    // finger lifted: others stop seeing our ring (a mouse keeps it while hovering)
    if (e.pointerType !== 'mouse') overlay?.shareCursorHide();
    if (camera?.pinching && this.pointers.size < 2) {
      if (this.isTap()) camera.cancel();
      else camera.end();
      // with no pen picked the finger that's left goes on looking around
      const [rest] = this.pointers.values();
      if (rest && !tool) this.look(rest, true);
    }
    if (this.pointers.size > 0) return; // drawing was cancelled when the second finger came
    if (camera?.dragging) camera.end();
    container.current?.classList.remove('panning');
    this.finishTap();
    const wait = this.waiting;
    this.waiting = null;
    if (wait?.tool === 'eraser' && overlay) this.begin(overlay, wait, wait.color, wait.tool, false); // a tap rubs out too
    this.endStroke();
  };

  readonly leave = (e: PointerEvent): void => {
    this.overlay?.hideBrushCursor();
    this.up(e);
  };

  /** The browser took the touch away (a system gesture): nothing was meant. */
  readonly cancel = (e: PointerEvent): void => {
    this.waiting = null;
    this.tap = null;
    this.cancelDrawing();
    this.camera?.cancel();
    this.up(e);
  };

  /** End the stroke (or erasing) in progress, if there is one. */
  endStroke(): void {
    if (this.drawing) this.overlay?.endStroke();
    if (this.erasing) this.overlay?.finalizeEraser();
    this.drawing = this.erasing = false;
  }

  private look(at: { x: number; y: number }, touch: boolean): void {
    this.camera?.start([at], touch);
    this.options.current.container.current?.classList.add('panning');
  }

  private begin(overlay: DrawingOverlay, at: { x: number; y: number }, color: string, tool: Tool, shareRing: boolean): void {
    // the ring first, so others get our brush size before the stroke starts
    if (shareRing) overlay.shareTouchCursor(at.x, at.y, BRUSH_RADIUS[tool], true);
    if (tool === 'eraser') {
      overlay.eraseAt(at.x, at.y, BRUSH_RADIUS.eraser);
      this.erasing = true;
    } else {
      overlay.startStroke(at.x, at.y, color, lineWidth(tool), tool);
      this.drawing = true;
    }
  }

  /** A second finger came: they want to look around. */
  private cancelDrawing(): void {
    if (this.drawing) this.overlay?.cancelStroke();
    if (this.erasing) this.overlay?.cancelErase();
    this.drawing = this.erasing = false;
  }

  // ── Taps with several fingers ──

  private trackTap(id: number, at: { x: number; y: number }): void {
    if (this.pointers.size === 1) this.tap = { fingers: 1, starts: new Map(), since: performance.now(), moved: false };
    if (!this.tap) return;
    this.tap.starts.set(id, at);
    this.tap.fingers = Math.max(this.tap.fingers, this.pointers.size);
  }

  private isTap(): boolean {
    return !!this.tap && !this.tap.moved && this.tap.fingers > 1 && performance.now() - this.tap.since < TAP.time;
  }

  private finishTap(): void {
    const fingers = this.isTap() ? this.tap!.fingers : 0;
    this.tap = null;
    if (!this.options.current.canDraw) return;
    if (fingers === 2) this.overlay?.undo();
    if (fingers === 3) this.overlay?.redo();
  }

  // ── Keys ──

  /** Undo and redo, arrows to look, + and - to zoom, Space and Shift to drag the view. */
  listenToKeys(): () => void {
    const down = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest?.('input:not([type="color"]), textarea, [contenteditable]');
      if (typing || e.altKey) return;
      if (e.metaKey || e.ctrlKey) {
        const key = e.key.toLowerCase(), redo = key === 'y' || (key === 'z' && e.shiftKey);
        if (key !== 'z' && key !== 'y') return;
        e.preventDefault();
        if (!this.options.current.canDraw || this.drawing || this.erasing) return;
        if (redo) this.overlay?.redo();
        else this.overlay?.undo();
        return;
      }
      if (e.code === 'Space' && (e.target as HTMLElement).closest?.('button')) return; // presses it
      const key = e.code === 'Space' || ARROWS[e.key] || e.key === 'Shift' ? (e.code === 'Space' ? 'Space' : e.key) : e.key === '+' || e.key === '=' ? '+' : e.key === '-' || e.key === '_' ? '-' : null;
      if (!key) return;
      if (key !== 'Shift') e.preventDefault();
      this.keys.add(key);
      if (key === '+') this.keys.delete('-');
      this.keysChanged();
    };
    const up = (e: KeyboardEvent) => {
      const key = e.code === 'Space' ? 'Space' : e.key === '=' ? '+' : e.key === '_' ? '-' : e.key;
      if (this.keys.delete(key)) this.keysChanged();
    };
    const clear = () => { this.keys.clear(); this.keysChanged(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
      clear();
    };
  }

  private keysChanged(): void {
    const { container, onLookAround } = this.options.current;
    let x = 0, y = 0;
    for (const [key, [dx, dy]] of Object.entries(ARROWS)) if (this.keys.has(key)) { x += dx; y += dy; }
    const zoom = Number(this.keys.has('+')) - Number(this.keys.has('-'));
    if (x || y) onLookAround();
    this.camera?.hold(x, y, zoom);
    const grab = this.keys.has('Space') || this.keys.has('Shift');
    container.current?.classList.toggle('can-pan', grab);
    if (grab) this.overlay?.hideBrushCursor();
  }
}
