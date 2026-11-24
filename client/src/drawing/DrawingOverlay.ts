import type { Viewer } from "mapillary-js";
import { preloadDecalTools, type ToolType } from "../deep/decalTools";
import { loadDeepData, type DeepData } from "../deep/surfaceDecal";
import type { PreviewView } from "../pool/localPreview";
import { followCamera, screenProjection, type PhotoTransform, type RenderCamera, type Subscription } from "../viewer/mapillaryInternals";
import { BrushCursor } from "./BrushCursor";
import { Eraser } from "./eraser";
import { FlatPen } from "./FlatPen";
import { LiveRoom } from "./LiveRoom";
import type { ProjectionContext, Scene } from "./scene";
import { StrokeRenderer } from "./StrokeRenderer";
import { Strokes } from "./strokes";
import { SurfacePen } from "./SurfacePen";
import { isSky } from "./surfaceStrokes";
import { WebGLDrawingRenderer } from "./WebGLDrawingRenderer";

/** Everything drawn over a place's photo, by you and by everyone else in it. */
export class DrawingOverlay {
  /** Called once a place is ready to draw on. */
  onReady?: () => void;
  private viewer: Viewer | null = null;
  private imageId: string | null = null;
  private deep: DeepData | null = null;
  private fov = 90;
  private camera: RenderCamera | null = null;
  private transform: PhotoTransform | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly gpu: WebGLDrawingRenderer | null;
  /** Both canvases: drawing in progress, and everything drawn. */
  private readonly layers: HTMLCanvasElement[];

  private readonly scene: Scene;
  private readonly strokes: Strokes;
  private readonly room: LiveRoom;
  private readonly cursor: BrushCursor;
  private readonly eraser: Eraser;
  private readonly surface: SurfacePen;
  private readonly flat: FlatPen;
  private readonly renderer: StrokeRenderer;

  /** The stroke in progress: its number, where the pointer is, and whether it went anywhere. */
  private stroke = 0;
  private last: [number, number] = [0, 0];
  private moved = false;
  private frameId: number | null = null;
  private subscriptions: Subscription[] = [];
  private cleanUp: (() => void)[] = [];

  constructor(container: HTMLElement) {
    preloadDecalTools();
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:11;opacity:0";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.gpu = this.createGpu(container);
    this.layers = this.gpu ? [this.canvas, this.gpu.getCanvas()] : [this.canvas];
    for (const c of this.layers) c.style.opacity = "0";

    this.scene = this.createScene(container);
    this.strokes = new Strokes(this.scene);
    this.room = new LiveRoom(this.scene, this.strokes);
    this.cursor = new BrushCursor(this.scene);
    this.eraser = new Eraser(this.scene, this.strokes, this.room.history, this.room);
    this.surface = new SurfacePen(this.scene, this.strokes, this.room);
    this.flat = new FlatPen(this.scene, this.ctx, this.strokes, this.room, () => this.viewer);
    this.flat.onActive = () => this.startFrames();
    this.renderer = new StrokeRenderer(this.scene, this.ctx, this.strokes, this.surface, this.room, () => this.viewer);

    const resize = () => this.resize();
    resize();
    window.addEventListener("resize", resize);
    this.cleanUp.push(() => window.removeEventListener("resize", resize));
  }

  private createGpu(container: HTMLElement): WebGLDrawingRenderer | null {
    try {
      return new WebGLDrawingRenderer(container);
    } catch {
      return null; // no WebGL: the 2D canvas does it
    }
  }

  private createScene(container: HTMLElement): Scene {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- read live by the getters below
    const overlay = this;
    const toPanorama = (x: number, y: number): [number, number] | null => {
      const ctx = this.projection();
      try {
        const b = ctx?.proj.canvasToBasic([x, y], ctx.container, ctx.renderCamera, ctx.transform);
        return b ? [b[0], b[1]] : null;
      } catch {
        return null;
      }
    };
    return {
      container,
      renderer: this.gpu,
      get deep() { return overlay.deep; },
      get fov() { return overlay.fov; },
      get radPerPx() { return ((overlay.fov * Math.PI) / 180) / Math.max(1, overlay.canvas.height); },
      get height() { return overlay.canvas.height; },
      projection: () => this.projection(),
      toPanorama,
      isSky: (u, v) => isSky(this.deep, u, v),
      isSkyAt: (x, y) => {
        const b = this.deep && toPanorama(x, y);
        return !!b && isSky(this.deep, b[0], b[1]);
      },
      redraw: () => void this.renderer.redraw(),
    };
  }

  private projection(): ProjectionContext | null {
    if (!this.viewer || !this.camera || !this.transform) return null;
    const p = screenProjection(this.viewer);
    return p && { proj: p.projection, container: p.container, renderCamera: this.camera, transform: this.transform };
  }

  private resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
  }

  setViewer(viewer: Viewer): void {
    this.viewer = viewer;
    const readFov = async () => { this.fov = await viewer.getFieldOfView(); };
    const moved = () => {
      this.room.peers.reproject();
      this.cursor.follow();
      this.renderer.cameraMoved();
    };
    void readFov();
    viewer.on("fov", readFov);
    // every rendered frame; pov and bearing are for when that can't be followed
    try {
      this.subscriptions = followCamera(viewer, (camera) => { this.camera = camera; moved(); }, (transform) => { this.transform = transform; });
    } catch (e) {
      console.warn("[drawing] could not follow the viewer's camera:", e);
    }
    viewer.on("pov", moved);
    viewer.on("bearing", moved);
    this.cleanUp.push(() => viewer.off("fov", readFov), () => viewer.off("pov", moved), () => viewer.off("bearing", moved));
  }

  setImageId(imageId: string): void {
    this.imageId = imageId;
    this.deep = null;
    void loadDeepData(imageId).then((data) => {
      if (this.imageId !== imageId) return;
      this.deep = data;
      console.info(`[deep] ${imageId}: ${data ? "3D surface painting ON (depth + shading loaded)" : "no deep data for this panorama — strokes stay flat"}`);
    });
    this.scene.redraw();
    this.onReady?.();
  }

  // ── Drawing ──

  startStroke(x: number, y: number, color: string, lineWidth: number, toolType: ToolType): void {
    if (!this.viewer) return;
    this.last = [x, y];
    this.moved = false;
    this.surface.active = null;
    if (this.scene.isSkyAt(x, y)) return; // not a surface
    this.stroke++;
    for (const c of this.layers) c.style.opacity = "1";
    if (color === "rainbow" || !this.surface.start(x, y, { color, lineWidth, toolType }, this.stroke)) {
      this.flat.start(x, y, color, lineWidth, toolType, this.stroke);
    } else {
      this.startFrames();
    }
  }

  addPoint(x: number, y: number): void {
    if (!this.viewer) return;
    if (Math.hypot(x - this.last[0], y - this.last[1]) < (this.surface.active ? 1 : 2)) return;
    this.moved = true;
    this.last = [x, y];
    if (this.surface.active) this.surface.point(x, y);
    else this.flat.point(x, y);
  }

  endStroke(): void {
    if (this.surface.active) this.surface.end(this.moved);
    else this.flat.end();
  }

  /** Draw every frame until there's nothing left that changes. */
  private startFrames(): void {
    // claimed before the first frame runs: frames await, and a second loop started meanwhile would
    // draw the same brush at the same time and garble the stroke
    this.frameId ??= requestAnimationFrame(this.frame);
  }

  private readonly frame = async (): Promise<void> => {
    try {
      if (!this.surface.active && !this.flat.busy) {
        this.frameId = null;
        return await this.renderer.redraw();
      }
      this.flat.join();
      this.surface.advance(); // paint this frame's path first, so it's on screen this frame
      await this.renderer.redraw();
      await this.flat.draw();
    } catch (err) {
      console.error("[drawing] frame failed:", err);
    }
    this.frameId = requestAnimationFrame(this.frame);
  };

  // ── The live room, undo, eraser and cursor ──

  /** Join this panorama's live room: others' cursors and strokes appear, ours are shared. */
  subscribeToRealtime(imageId: string): void {
    this.room.join(imageId);
  }

  leaveRealtime(): void {
    this.room.leave();
  }

  /** Did we draw, undo or erase here since the last time this was asked? */
  takeOwnChanges(): boolean {
    return this.room.takeOwnChanges();
  }

  /** Called when undo or redo became available or not. */
  set onHistoryChange(f: (() => void) | null) {
    this.room.history.onChange = f;
  }

  canUndo(): boolean {
    return this.room.history.canUndo();
  }

  canRedo(): boolean {
    return this.room.history.canRedo();
  }

  undo(): void {
    this.room.history.undo();
  }

  redo(): void {
    this.room.history.redo();
  }

  eraseAt(x: number, y: number, radius: number): void {
    if (this.viewer) this.eraser.at(x, y, radius);
  }

  /** End of an eraser gesture. */
  finalizeEraser(): void {
    this.eraser.finish();
  }

  /** Show the brush outline at a screen point, and to everyone else (see BrushCursor.show). */
  updateBrushCursor(x: number, y: number, radius: number, fillColor: string | null = null): void {
    this.shareCursor(x, y, radius, fillColor);
    this.cursor.show(x, y, radius, fillColor, (u, v) => this.surface.active?.geo.worldPerPxAt(u, v) ?? null);
  }

  hideBrushCursor(): void {
    this.room.hideCursor();
    this.cursor.hide();
  }

  /**
   * Phones have no hover: while a finger draws, share the ring at the stroke's tip so others see
   * where you're painting (and how big your brush is). Your own screen shows nothing extra.
   */
  shareTouchCursor(x: number, y: number, radius: number, force = false): void {
    this.shareCursor(x, y, radius, null, force);
  }

  shareCursorHide(): void {
    this.room.hideCursor();
  }

  private shareCursor(x: number, y: number, radius: number, paint: string | null, force = false): void {
    const b = this.scene.toPanorama(x, y);
    if (!b) return;
    if (this.scene.isSkyAt(x, y)) this.room.hideCursor();
    else this.room.shareCursor(b, radius, paint, force);
  }

  /** Everything painted here as seen from this view (transparent background; ss = supersampling). */
  renderPreview(view: PreviewView, ss: number): HTMLCanvasElement | null {
    return this.renderer.preview(view, ss);
  }

  fadeIn(): void {
    for (const c of this.layers) {
      c.style.transition = "opacity 0.4s ease-in-out";
      c.style.opacity = "1";
    }
    this.scene.redraw();
  }

  /** Resolves once it's gone. */
  fadeOut(): Promise<void> {
    for (const c of this.layers) {
      c.style.transition = "opacity 0.4s ease-out";
      c.style.opacity = "0";
    }
    return new Promise((resolve) => {
      this.canvas.addEventListener("transitionend", () => resolve(), { once: true });
      setTimeout(resolve, 500); // in case it never comes
    });
  }

  dispose(): void {
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.surface.active = null;
    this.flat.dispose();
    this.renderer.dispose();
    this.cursor.dispose();
    this.room.leave();
    this.room.peers.dispose();
    for (const sub of this.subscriptions) sub.unsubscribe();
    for (const f of this.cleanUp) f();
    this.strokes.dispose();
    this.room.history.clear();
    this.gpu?.dispose();
    this.canvas.remove();
  }
}
