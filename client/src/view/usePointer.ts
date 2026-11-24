import { useEffect, useMemo, useRef, type PointerEvent, type RefObject } from 'react';
import type { Viewer } from 'mapillary-js';
import type { DrawingOverlay } from '../drawing/DrawingOverlay';
import { Camera } from './Camera';
import { BRUSH_RADIUS, lineWidth, type Tool, type ToolType } from './tools';

interface Options {
  container: RefObject<HTMLDivElement | null>;
  viewer: RefObject<Viewer | null>;
  overlay: RefObject<DrawingOverlay | null>;
  tool: Tool;
  color: string;
  /** Can be drawn on yet? (Looking around always works.) */
  canDraw: boolean;
  onLookAround(): void;
}

/** Drawing with a mouse, finger or pen; two fingers, the right button or Shift look around. */
export function usePointer(options: Options) {
  const { container } = options;
  const latest = useRef(options);
  useEffect(() => { latest.current = options; });
  const input = useMemo(() => new PointerInput(latest), []);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const shift = (e: KeyboardEvent) => { if (e.key === 'Shift') el.style.cursor = e.type === 'keydown' ? 'grab' : ''; };
    const wheel = (e: WheelEvent) => input.wheel(e);
    const noMenu = (e: MouseEvent) => e.preventDefault(); // the right button looks around
    el.addEventListener('wheel', wheel, { passive: false, capture: true });
    el.addEventListener('contextmenu', noMenu, { capture: true });
    window.addEventListener('keydown', shift);
    window.addEventListener('keyup', shift);
    return () => {
      el.removeEventListener('wheel', wheel, { capture: true });
      el.removeEventListener('contextmenu', noMenu, { capture: true });
      window.removeEventListener('keydown', shift);
      window.removeEventListener('keyup', shift);
    };
  }, [container, input]);

  return input;
}

class PointerInput {
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private drawing = false;
  /** A finger is down but hasn't moved: a second one may follow, to look around instead. */
  private waiting: { x: number; y: number; color: string; tool: ToolType; time: number } | null = null;
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
    const { tool, color, canDraw, container, onLookAround } = this.options.current;
    e.nativeEvent.stopImmediatePropagation(); // the viewer's own controls stay out of it
    const pos = this.position(e);
    this.pointers.set(e.pointerId, pos);

    if (this.pointers.size > 1) {
      onLookAround();
      this.waiting = null;
      this.cancelStroke();
      this.camera?.start([...this.pointers.values()]);
      return;
    }
    const overlay = this.overlay;
    if (!overlay) return;
    if (e.button === 1 || e.button === 2 || e.shiftKey) {
      onLookAround();
      this.camera?.start([pos]);
      container.current?.classList.add('panning');
      return;
    }
    if (!canDraw) return;
    this.camera?.stop();
    if (tool !== 'eraser' && e.pointerType === 'touch') {
      this.waiting = { ...pos, color, tool, time: Date.now() };
      return;
    }
    // pens: the ring first, so others get our brush size before the stroke starts
    if (e.pointerType !== 'mouse') overlay.shareTouchCursor(pos.x, pos.y, BRUSH_RADIUS[tool], true);
    if (tool === 'eraser') overlay.eraseAt(pos.x, pos.y, BRUSH_RADIUS.eraser);
    else this.startStroke(overlay, pos, color, tool);
  };

  readonly move = (e: PointerEvent): void => {
    const { tool, color } = this.options.current;
    e.nativeEvent.stopImmediatePropagation();
    const pos = this.position(e), overlay = this.overlay;
    if (this.camera?.dragging) {
      // the brush outline stays pinned to its spot in the scene meanwhile
      this.camera.move([pos]);
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
    const radius = BRUSH_RADIUS[tool], mouse = e.pointerType === 'mouse';
    if (mouse) overlay.updateBrushCursor(pos.x, pos.y, radius, tool !== 'eraser' && e.buttons === 0 ? color : null);
    else overlay.hideBrushCursor();

    const wait = this.waiting;
    if (wait) {
      // far and long enough not to be the first finger of a pinch
      if (Math.hypot(pos.x - wait.x, pos.y - wait.y) <= 6 || Date.now() - wait.time <= 80) return;
      this.waiting = null;
      overlay.shareTouchCursor(pos.x, pos.y, BRUSH_RADIUS[wait.tool], true);
      this.startStroke(overlay, wait, wait.color, wait.tool);
      overlay.addPoint(pos.x, pos.y);
    } else if (tool === 'eraser') {
      if (e.buttons === 0) return;
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
    if (camera?.pinching && this.pointers.size < 2) camera.end();
    if (this.pointers.size > 0) return; // the stroke was cancelled when the second finger came
    if (camera?.dragging) camera.end();
    if (container.current) {
      container.current.style.cursor = '';
      container.current.classList.remove('panning');
    }
    this.waiting = null;
    if (tool === 'eraser') overlay?.finalizeEraser();
    else this.endStroke();
  };

  readonly leave = (e: PointerEvent): void => {
    this.overlay?.hideBrushCursor();
    this.up(e);
  };

  /** End the stroke being drawn, if there is one. */
  endStroke(): void {
    if (!this.drawing) return;
    this.drawing = false;
    this.overlay?.endStroke();
  }

  private startStroke(overlay: DrawingOverlay, at: { x: number; y: number }, color: string, tool: ToolType): void {
    overlay.startStroke(at.x, at.y, color, lineWidth(tool), tool);
    this.drawing = true;
  }

  /** A second finger came: they want to look around. */
  private cancelStroke(): void {
    if (!this.drawing) return;
    this.endStroke();
    setTimeout(() => { if (this.overlay?.canUndo()) this.overlay.undo(); }, 50);
  }
}
