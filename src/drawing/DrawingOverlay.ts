import type { Viewer } from "mapillary-js";
import { applyShading, shadeRegion } from "../deep/strokeShading";
import { loadDeepData, type DeepData } from "../deep/surfaceDecal";
import { mergePieces, type BakedPiece } from "../deep/geodesicMap";
import { preloadDecalTools, simplify, type ToolType } from "../deep/decalTools";
import { BrushCursor } from "./BrushCursor";
import { Eraser } from "./eraser";
import { ChalkBrush } from "./flat/crayon";
import { FountainPenBrush } from "./flat/fountainPen";
import { Brush, type Drop } from "./flat/marker";
import { Pen } from "./flat/pencil";
import type { Projector, SplashParticle, Unprojector } from "./flat/types";
import { WatercolorBrush } from "./flat/watercolor";
import { LiveRoom } from "./LiveRoom";
import { buildPanoramaGeometry, buildScreenGeometry, drawTexturedTriangle, projectionUniforms, projectToScreen } from "./projection";
import { getRainbowHueShift, resolveRainbowColor } from "./rainbow";
import type { ProjectionContext, Scene } from "./scene";
import { Strokes, texSource, type MarkerTexture } from "./strokes";
import { bakePiece, canPaintSurfaces, continues, drawLivePieces, isSky, MID_SAMPLE, paintFrame, pieceTexture, releasePiece, startPiece, type DecalState } from "./surfaceStrokes";
import { WebGLDrawingRenderer } from "./WebGLDrawingRenderer";
import { realtime } from "../realtime/client";
import type { PreviewView } from "../pool/localPreview";
import { followCamera, screenProjection, type PhotoTransform, type RenderCamera, type Subscription } from "../viewer/mapillaryInternals";

export class DrawingOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private viewer: Viewer | null = null;
  private lastPixelX: number = 0;
  private lastPixelY: number = 0;

  private brush: Brush | null = null;
  private pen: Pen | ChalkBrush | FountainPenBrush | WatercolorBrush | null = null;
  private isMarkerActive: boolean = false;
  private isPencilActive: boolean = false;
  private _strokeHasMovement: boolean = false;
  private animationFrameId: number | null = null;
  private currentFov: number = 90;
  private referenceFov: number = 90;
  private dyingStrokes: {
    brush: Brush;
    brushStrokeId?: string;
    lastX: number;
    lastY: number;
    fov: number;
  }[] = [];
  private dyingPenStrokes: {
    pen: Pen | ChalkBrush | FountainPenBrush | WatercolorBrush;
    lastX: number;
    lastY: number;
    fov: number;
  }[] = [];
  private finalizingStrokes: {
    brush: Brush;
    lastX: number;
    lastY: number;
    fov: number;
  }[] = [];
  private finalizingPenStrokes: {
    pen: Pen | ChalkBrush | FountainPenBrush | WatercolorBrush;
    lastX: number;
    lastY: number;
    fov: number;
  }[] = [];
  /** Finished flat strokes waiting to join the others at the start of a frame. */
  private pendingTextures: { stroke: DrawingOverlay["finalizingStrokes"][number]; texture: MarkerTexture | null }[] = [];
  private pendingPenTextures: { stroke: DrawingOverlay["finalizingPenStrokes"][number]; texture: MarkerTexture | null }[] = [];
  private activeDrops: Drop[] = [];
  private activeSplashes: SplashParticle[] = [];
  private webglRenderer: WebGLDrawingRenderer | null = null;
  private currentRenderId: number = 0;
  private _renderPending: boolean = false;

  /** The panorama being drawn on. */
  private _imageId: string | null = null;
  /** Precomputed shading (light/shadow) for the current panorama, if available — see deep/strokeShading */
  private _deepShade: Float32Array | null = null;
  /** Depth + surface maps for the current panorama (enables drawing on 3D surfaces) */
  private _deepData: DeepData | null = null;
  private _activeDecal: DecalState | null = null;
  /** Params of the stroke in progress, so it can continue on a new surface (decal chaining). */
  private _strokeGroup = 0;
  /** Screen points of the current surface stroke not walked yet, and where the walk is. */
  private _decalPath: [number, number][] = [];
  private _decalPos: [number, number] = [0, 0];
  /** Finished pieces of the stroke in progress (merged into one bitmap when it ends). */
  private _pieces: { piece: BakedPiece; tex: MarkerTexture }[] = [];
  /** when recent pieces started: many in a row = a ragged area, so be less eager to split there */
  private _chainTimes: number[] = [];
  private _strokeParams: { color: string; lineWidth: number; toolType: ToolType } | null = null;
  /** Called once a place is ready to draw on. */
  onReady?: () => void;
  private useWebGL: boolean = false;

  // Cached mapillary internals (subscribed in setViewer)
  private _cachedRenderCamera: RenderCamera | null = null;
  private _cachedTransform: PhotoTransform | null = null;
  private _internalSubs: Subscription[] = [];
  private _boundResize: (() => void) | null = null;
  private _boundViewerListeners: (() => void)[] = [];

  // Realtime collaboration
  private lastBroadcastTime: number = 0;
  private _isRainbowStroke: boolean = false; // Current stroke is rainbow
  private _rainbowAnimFrameId: number | null = null; // Animation loop for rainbow textures

  /** What's on screen right now, for the parts drawn on top of it. */
  private readonly scene: Scene;
  private readonly strokes: Strokes;
  private readonly cursor: BrushCursor;
  private readonly live: LiveRoom;
  private readonly eraser: Eraser;

  constructor(container: HTMLElement) {
    preloadDecalTools();
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- read live by the getters below
    const overlay = this;
    this.scene = {
      container,
      get deep() { return overlay._deepData; },
      get fov() { return overlay.currentFov; },
      get radPerPx() { return ((overlay.currentFov * Math.PI) / 180) / Math.max(1, overlay.canvas.height); },
      get height() { return overlay.canvas.height; },
      get renderer() { return overlay.webglRenderer; },
      projection: () => this.getSyncProjectionContext(),
      toPanorama: (x, y) => this.screenToBasic(x, y),
      isSky: (u, v) => isSky(this._deepData, u, v),
      isSkyAt: (x, y) => this.isSkyAt(x, y),
      redraw: () => void this.render(),
    };
    this.strokes = new Strokes(this.scene);
    this.strokes.onRainbow = () => this._startRainbowAnimationLoop();
    this.cursor = new BrushCursor(this.scene);
    this.live = new LiveRoom(this.scene, this.strokes);
    this.eraser = new Eraser(this.scene, this.strokes, this.live.history, this.live);
    this.live.history.onUndone = (tex) => this.dropDrips(tex);
    this.canvas = document.createElement("canvas");
    this.canvas.style.position = "absolute";
    this.canvas.style.top = "0";
    this.canvas.style.left = "0";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.pointerEvents = "none";
    this.canvas.style.zIndex = "11";
    this.canvas.style.opacity = "0";
    container.appendChild(this.canvas);

    this.ctx = this.canvas.getContext("2d")!;

    try {
      this.webglRenderer = new WebGLDrawingRenderer(container);
      this.useWebGL = true;
      // Sync WebGL canvas opacity with the 2D canvas
      const webglCanvas = this.webglRenderer.getCanvas();
      webglCanvas.style.opacity = "0";
    } catch {
      this.useWebGL = false;
    }
    this.resizeCanvas();
    this._boundResize = () => this.resizeCanvas();
    window.addEventListener("resize", this._boundResize);
  }

  setViewer(viewer: Viewer): void {
    this.viewer = viewer;

    // Track viewer listeners for cleanup in dispose()
    const onFov = async () => {
      this.currentFov = await viewer.getFieldOfView();
    };
    viewer.on("fov", onFov);
    this._boundViewerListeners.push(() => viewer.off("fov", onFov));

    viewer.getFieldOfView().then((fov) => {
      this.currentFov = fov;
    });

    // Follow the camera of every rendered frame
    try {
      this._internalSubs = followCamera(
        viewer,
        (camera) => {
          this._cachedRenderCamera = camera;
          this.invalidateProjectionCache();
        },
        (transform) => { this._cachedTransform = transform; },
      );
    } catch (e) {
      console.warn("[DrawingOverlay] could not follow the viewer's camera:", e);
    }

    // Fallback: pov/bearing events for CPU path (when subscriptions fail)
    const onPov = () => this.invalidateProjectionCache();
    const onBearing = () => this.invalidateProjectionCache();
    viewer.on("pov", onPov);
    viewer.on("bearing", onBearing);
    this._boundViewerListeners.push(() => viewer.off("pov", onPov), () => viewer.off("bearing", onBearing));
  }

  private invalidateProjectionCache(): void {
    this.live.peers.reproject();
    this.cursor.follow();
    const useGPUPath =
      this.useWebGL &&
      this.webglRenderer?.hasGPUProjection() &&
      this._cachedRenderCamera &&
      this._cachedTransform;

    if (useGPUPath) {
      // GPU path: render synchronously — sub-millisecond, zero lag
      this.renderGPUTexturesOnly();
    } else {
      // CPU path: mark stale + debounce via rAF
      this.currentRenderId++;
      for (const tex of this.strokes.list) {
        tex.needsProjection = true;
      }
      if (!this._renderPending) {
        this._renderPending = true;
        requestAnimationFrame(() => {
          this._renderPending = false;
          this.render();
        });
      }
    }
  }

  /**
   * Fast GPU-only render path — called synchronously from renderCameraFrame$
   * subscription so strokes move in perfect sync with the panorama.
   */
  private renderGPUTexturesOnly(): void {
    const live = this.liveDecals();
    const list = this.drawList();
    if (!this.viewer || !this.webglRenderer || (list.length === 0 && live.length === 0))
      return;

    const gpuUniforms = projectionUniforms(this.getSyncProjectionContext());
    if (!gpuUniforms) return;

    this.webglRenderer.clear();
    this.webglRenderer.setGPUProjectionUniforms(gpuUniforms);

    const hueShift = getRainbowHueShift();

    for (const tex of list) {
      if (!tex._gpuBasicCoords) buildPanoramaGeometry(tex);
      if (!tex._gpuVertexCount) continue;

      const texOpacity = tex.opacity ?? 1;
      this.webglRenderer.drawGPUProjectedBatch(
        texSource(tex),
        tex._gpuBasicCoords!,
        tex._gpuTexCoords!,
        texOpacity,
        false,
        tex.isRainbow ? hueShift : 0,
      );
    }
    drawLivePieces(this.webglRenderer, live);
  }

  // ── Realtime Collaboration ─────────────────────────────────────────

  private broadcastStrokeStart(
    color: string,
    lineWidth: number,
    toolType: ToolType,
    basicX: number,
    basicY: number,
  ): void {
    realtime.send({ t: "stroke_start", color, lineWidth, toolType, u: basicX, v: basicY, fov: this.currentFov, group: this._strokeGroup });
  }

  private broadcastStrokePoint(basicX: number, basicY: number): void {
    // Throttle to ~50ms
    const now = performance.now();
    if (now - this.lastBroadcastTime < 50) return;
    this.lastBroadcastTime = now;
    realtime.send({ t: "stroke_point", u: basicX, v: basicY });
  }

  private broadcastStrokeEnd(): void {
    realtime.send({ t: "stroke_end" });
  }

  /** Everything painted here as seen from this view (transparent background; ss = supersampling). */
  renderPreview(view: PreviewView, ss: number): HTMLCanvasElement | null {
    const draws = this.drawList().flatMap((tex) => {
      if (!tex._gpuBasicCoords) buildPanoramaGeometry(tex);
      return tex._gpuVertexCount
        ? [{ source: texSource(tex), basic: tex._gpuBasicCoords!, uv: tex._gpuTexCoords!, opacity: tex.opacity ?? 1 }]
        : [];
    });
    return this.webglRenderer?.renderPreview(draws, view, ss) ?? null;
  }

  /** Join this panorama's live room: others' cursors and strokes appear, ours are shared. */
  subscribeToRealtime(imageId: string): void {
    this.live.join(imageId);
  }

  leaveRealtime(): void {
    this.live.leave();
  }

  /** Did we draw, undo or erase here since the last time this was asked? */
  takeOwnChanges(): boolean {
    return this.live.takeOwnChanges();
  }

  /** Called when undo or redo became available or not. */
  set onHistoryChange(f: (() => void) | null) {
    this.live.history.onChange = f;
  }

  canUndo(): boolean {
    return this.live.history.canUndo();
  }

  canRedo(): boolean {
    return this.live.history.canRedo();
  }

  undo(): void {
    this.live.history.undo();
  }

  redo(): void {
    this.live.history.redo();
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
    this.cursor.show(x, y, radius, fillColor, (u, v) => this._activeDecal?.geo.worldPerPxAt(u, v) ?? null);
  }

  hideBrushCursor(): void {
    this.live.hideCursor();
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
    this.live.hideCursor();
  }

  private shareCursor(x: number, y: number, radius: number, paint: string | null, force = false): void {
    const b = this.screenToBasic(x, y);
    if (!b) return;
    if (this.isSkyAt(x, y)) this.live.hideCursor();
    else this.live.shareCursor(b, radius, paint, force);
  }

  /** Remove an undone stroke's drips and splashes. */
  private dropDrips(tex: MarkerTexture): void {
    const id = tex.brushStrokeId;
    if (!id) return;
    this.activeDrops = this.activeDrops.filter((d) => d.strokeId !== id);
    this.activeSplashes = this.activeSplashes.filter((s) => !s.strokeId || s.strokeId !== id);
  }

  private resizeCanvas(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (rect) {
      this.canvas.width = rect.width;
      this.canvas.height = rect.height;
    }
  }

  startStroke(
    pixelX: number,
    pixelY: number,
    color: string,
    lineWidth: number,
    toolType: ToolType,
  ): void {
    if (!this.viewer) return;

    this.lastPixelX = pixelX;
    this.lastPixelY = pixelY;

    // Track if this is a rainbow stroke
    this._isRainbowStroke = color === "rainbow";
    this._strokeHasMovement = false;
    const resolvedColor = this._isRainbowStroke ? resolveRainbowColor() : color;

    // The sky isn't a surface: don't start a stroke there at all.
    if (this.isSkyAt(pixelX, pixelY)) {
      this._strokeParams = null;
      this._activeDecal = null;
      return;
    }
    this._strokeParams = { color, lineWidth, toolType };
    this._strokeGroup++;

    // Ensure canvas is visible when user starts drawing
    this.canvas.style.opacity = "1";
    if (this.useWebGL && this.webglRenderer) {
      this.webglRenderer.getCanvas().style.opacity = "1";
    }

    // Draw on the 3D surface when depth data is available.
    if (!this._isRainbowStroke) {
      const st = this.makeDecal(pixelX, pixelY);
      if (st) {
        this.dropPieces();
        this._decalPath = [];
        this._decalPos = [pixelX, pixelY];
        this._chainTimes = [];
        this.beginPiece(st);
        this.startRenderLoop();
        return;
      }
    }

    const projector = async (basic: [number, number]): Promise<[number, number] | null> => {
      if (!this.viewer) return null;
      const result = await this.viewer.projectFromBasic(basic);
      return result ? [result[0], result[1]] : null;
    };
    const unprojector = async (screen: [number, number]): Promise<[number, number] | null> => {
      if (!this.viewer) return null;
      const result = await this.viewer.unprojectToBasic(screen);
      return result ? [result[0], result[1]] : null;
    };
    const tool = this.createTool(
      toolType, pixelX, pixelY, resolvedColor, projector, unprojector,
      lineWidth, this.currentFov, this.canvas.width, this.canvas.height,
    );
    tool.setSeed(Math.floor(Math.random() * 2 ** 31));
    this.viewer.unprojectToBasic([pixelX, pixelY]).then((basic) => {
      if (basic) this.broadcastStrokeStart(color, lineWidth, toolType, basic[0], basic[1]);
    });

    if (tool instanceof Brush) {
      this.brush = tool;
      tool.initialize().then(async () => {
        if (this.brush) {
          await this.brush.startStroke();
          this.isMarkerActive = true;
          this.startRenderLoop();
        }
      });
    } else {
      this.pen = tool;
      tool.initialize().then(async () => {
        if (this.pen) {
          this.pen.startStroke(`pen_${Date.now()}`);
          this.isPencilActive = true;
          this.startRenderLoop();
        }
      });
    }
  }

  /** The on-screen drawing tool for a flat stroke (no 3D surface). */
  private createTool(
    toolType: ToolType,
    x: number, y: number, color: string, projector: Projector, unprojector: Unprojector,
    lineWidth: number, fov: number, w: number, h: number,
  ): Brush | Pen | ChalkBrush | FountainPenBrush | WatercolorBrush {
    switch (toolType) {
      case "marker": return new Brush(x, y, color, projector, unprojector, lineWidth * 4, lineWidth, fov);
      case "crayon": return new ChalkBrush(x, y, color, unprojector, lineWidth, fov, w, h);
      case "fountainPen": return new FountainPenBrush(x, y, color, unprojector, lineWidth, fov, w, h);
      case "watercolor": return new WatercolorBrush(x, y, color, unprojector, lineWidth, fov, w, h);
      default: return new Pen(x, y, color, projector, unprojector, lineWidth, fov);
    }
  }

  /** Send the brush samples gathered so far (~20 times a second; force = now, e.g. stroke end). */
  private flushStrokeSamples(force = false): void {
    const pts = this._pendingSamples;
    if (!pts.length) return;
    const now = performance.now();
    if (!force && now - this.lastBroadcastTime < 50 && pts.length < 4 * 120) return;
    this.lastBroadcastTime = now;
    this._pendingSamples = [];
    for (let i = 0; i < pts.length; i += 4 * 120) {
      const part = pts.slice(i, i + 4 * 120);
      realtime.send({ t: "stroke_point", u: part[part.length - 4], v: part[part.length - 3], pts: part });
    }
  }

  addPoint(pixelX: number, pixelY: number): void {
    if (!this.viewer) return;

    const dx = pixelX - this.lastPixelX;
    const dy = pixelY - this.lastPixelY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < (this._activeDecal ? 1 : 2)) return;

    this._strokeHasMovement = true;
    this.lastPixelX = pixelX;
    this.lastPixelY = pixelY;

    // Cycle rainbow color each stroke segment for live drawing
    if (this._isRainbowStroke) {
      const newColor = resolveRainbowColor();
      if (this.brush) this.brush.updateColor(newColor);
      if (this.pen) this.pen.updateColor(newColor);
    }

    // Surface strokes walk every point of the path (advanceDecal) and share their brush samples.
    if (this._activeDecal) {
      this._decalPath.push([pixelX, pixelY]);
      return;
    }
    // Broadcast point in basic coords (throttled internally).
    this.viewer.unprojectToBasic([pixelX, pixelY]).then((basic) => {
      if (basic) {
        this.broadcastStrokePoint(basic[0], basic[1]);
      }
    });
  }

  async endStroke(): Promise<void> {
    if (this._activeDecal) return this.endDecalStroke();
    if (this.isMarkerActive && this.brush) {
      this.brush.endStroke();
      this.isMarkerActive = false;

      if (this._strokeHasMovement) {
        const brushStrokeId = this.brush.getStrokeId();
        this.dyingStrokes.push({
          brush: this.brush,
          brushStrokeId: brushStrokeId || undefined,
          fov: this.currentFov,
          lastX: this.lastPixelX,
          lastY: this.lastPixelY,
        });
      } else {
        this.brush.dispose();
      }

      this.brush = null;
      this.startRenderLoop();
    }

    if (this.isPencilActive && this.pen) {
      this.isPencilActive = false;

      if (this._strokeHasMovement) {
        this.dyingPenStrokes.push({
          pen: this.pen,
          fov: this.currentFov,
          lastX: this.lastPixelX,
          lastY: this.lastPixelY,
        });
      } else {
        this.pen.dispose();
      }

      this.pen = null;
    }

    this.broadcastStrokeEnd();
  }

  private startRenderLoop(): void {
    if (this.animationFrameId !== null) return;

    const frame = async () => {
      // Keep running if we have anything active
      if (
        !this._activeDecal &&
        !this.isMarkerActive &&
        !this.isPencilActive &&
        this.dyingStrokes.length === 0 &&
        this.dyingPenStrokes.length === 0 &&
        this.finalizingStrokes.length === 0 &&
        this.finalizingPenStrokes.length === 0 &&
        this.pendingTextures.length === 0 &&
        this.pendingPenTextures.length === 0 &&
        this.activeDrops.length === 0 &&
        this.activeSplashes.length === 0
      ) {
        this.animationFrameId = null;
        await this.render();
        return;
      }

      // Process pending textures (synchronize with frame)
      while (this.pendingTextures.length > 0) {
        const item = this.pendingTextures.shift();
        if (item) {
          if (item.texture) {
            item.texture.isLocal = true;
            item.texture.opacity = 1;
            this.strokes.add(item.texture);
            this.live.history.add(item.texture);
          }
          const idx = this.finalizingStrokes.indexOf(item.stroke);
          if (idx > -1) this.finalizingStrokes.splice(idx, 1);
        }
      }

      // paint this frame's path first, so it's on screen this frame
      if (this._activeDecal) this.advanceDecal();

      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

      if (this.useWebGL && this.webglRenderer) {
        this.webglRenderer.clear();
        await this.renderMarkerTextures();
      } else {
        await this.renderMarkerTextures();
      }

      if (this.viewer) {
        const fovScale = this.referenceFov / this.currentFov;
        const projector = async (
          basic: number[],
        ): Promise<[number, number] | null> => {
          if (!this.viewer) return null;
          const res = await this.viewer.projectFromBasic(basic);
          if (!res || res.length < 2) return null;
          return [res[0], res[1]];
        };

        // 1. Extract particles from dying strokes FIRST so they are rendered this frame
        for (let i = this.dyingStrokes.length - 1; i >= 0; i--) {
          const stroke = this.dyingStrokes[i];
          if (stroke.brush) {
            this.activeDrops.push(...stroke.brush.extractDrops());
            this.activeSplashes.push(...stroke.brush.extractSplashes());

            // Disable simulation for finalization phase
            stroke.brush.dripping = false;
            stroke.brush.splashing = false;

            this.finalizingStrokes.push(stroke);

            // Finalize in background
            this.finalizeStroke(stroke)
              .then((tex) => {
                this.pendingTextures.push({ stroke, texture: tex });
                if (tex) {
                  tex.brushStrokeId = stroke.brushStrokeId;
                if (this._isRainbowStroke) tex.isRainbow = true;
                  void this.live.share(tex);
                }
              })
              .catch(console.error);
          }
          this.dyingStrokes.splice(i, 1);
        }

        // 2. Render finalizing strokes (fill the gap between dying and texture)
        for (const stroke of this.finalizingStrokes) {
          await this.renderShaded(stroke.brush, stroke.lastX, stroke.lastY, stroke.fov);
        }

        // 3. Process active splashes (batch projections)
        // First, update life and filter dead splashes
        for (let i = this.activeSplashes.length - 1; i >= 0; i--) {
          const splash = this.activeSplashes[i];
          splash.life -= 0.004; // ~3.5 second lifespan
          if (splash.life <= 0.1) {
            // Remove before alpha gets too low (prevents flicker)
            this.activeSplashes.splice(i, 1);
          }
        }

        // Batch project and render living splashes
        if (this.activeSplashes.length > 0) {
          // Update rainbow splash colors every frame
          if (this._isRainbowStroke) {
            const rc = resolveRainbowColor();
            for (const s of this.activeSplashes) s.color = rc;
          }

          const splashPositions = await Promise.all(
            this.activeSplashes.map((s) => projector([s.basicX, s.basicY])),
          );

          for (let i = 0; i < this.activeSplashes.length; i++) {
            const splash = this.activeSplashes[i];
            const pos = splashPositions[i];
            if (pos) {
              this.ctx.save();
              this.ctx.fillStyle = splash.color || "black";
              this.ctx.globalAlpha = Math.min(1, splash.life);
              this.ctx.beginPath();
              this.ctx.arc(
                pos[0],
                pos[1],
                splash.radius * fovScale,
                0,
                Math.PI * 2,
              );
              this.ctx.fill();
              this.ctx.restore();
            }
          }
        }

        // 4. Process active drops (physics update + batch render)
        if (this._isRainbowStroke) {
          const rc = resolveRainbowColor();
          for (const d of this.activeDrops) d.color = rc;
        }
        for (let i = this.activeDrops.length - 1; i >= 0; i--) {
          const drop = this.activeDrops[i];
          if (drop.life > 0.1) {
            // Remove before alpha gets too low (prevents flicker)
            drop.updatePhysics(fovScale);
            await drop.render(this.ctx, projector, fovScale);
          } else {
            // Remove faded drops to prevent accumulation
            this.activeDrops.splice(i, 1);
          }
        }
      }

      if (this.isMarkerActive && this.brush) {
        // Update rainbow color every frame so hue animates continuously
        if (this._isRainbowStroke)
          this.brush.updateColor(resolveRainbowColor());

        // Extract drips/splashes frame-by-frame so they are simulated immediately
        // preventing "stuck" drops during long strokes
        this.activeDrops.push(...this.brush.extractDrops());
        this.activeSplashes.push(...this.brush.extractSplashes());

        await this.renderShaded(this.brush, this.lastPixelX, this.lastPixelY, this.currentFov);
      }

      // Process dying pen strokes -> finalize to textures
      for (let i = this.dyingPenStrokes.length - 1; i >= 0; i--) {
        const stroke = this.dyingPenStrokes[i];
        if (stroke.pen) {
          this.finalizingPenStrokes.push(stroke);

          // Finalize pen stroke in background
          this.finalizePenStroke(stroke)
            .then((tex) => {
              this.pendingPenTextures.push({ stroke, texture: tex });
              if (tex) {
                if (this._isRainbowStroke) tex.isRainbow = true;
                void this.live.share(tex);
              }
            })
            .catch(console.error);
        }
        this.dyingPenStrokes.splice(i, 1);
      }

      // Process pending pen textures
      while (this.pendingPenTextures.length > 0) {
        const item = this.pendingPenTextures.shift();
        if (item) {
          if (item.texture) {
            item.texture.isLocal = true;
            item.texture.opacity = 1;
            this.strokes.add(item.texture);
            this.live.history.add(item.texture);
          }
          const idx = this.finalizingPenStrokes.indexOf(item.stroke);
          if (idx > -1) this.finalizingPenStrokes.splice(idx, 1);
        }
      }

      // Render finalizing pen strokes
      for (const stroke of this.finalizingPenStrokes) {
        await this.renderShaded(stroke.pen, stroke.lastX, stroke.lastY, stroke.fov);
      }

      // Render active pen
      if (this.isPencilActive && this.pen) {
        // Update rainbow color every frame so hue animates continuously
        if (this._isRainbowStroke) this.pen.updateColor(resolveRainbowColor());

        await this.renderShaded(this.pen, this.lastPixelX, this.lastPixelY, this.currentFov);
      }

      this.animationFrameId = requestAnimationFrame(loop);
    };
    // Claim the loop before the first frame runs: frames await, and a second loop started meanwhile
    // would draw the same brush at the same time and garble the stroke.
    const loop = () => {
      frame().catch((err) => {
        console.error("[DrawingOverlay] frame failed:", err);
        this.animationFrameId = requestAnimationFrame(loop);
      });
    };
    this.animationFrameId = requestAnimationFrame(loop);
  }

  private async finalizeStroke(stroke: {
    brush: Brush;
    lastX: number;
    lastY: number;
    fov: number;
  }): Promise<MarkerTexture | null> {
    if (!this.viewer) return null;

    // Render to a full-size temp canvas first (projector outputs screen coords)
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = this.canvas.width;
    tempCanvas.height = this.canvas.height;
    const tempCtx = tempCanvas.getContext("2d")!;

    await stroke.brush.render(tempCtx, stroke.lastX, stroke.lastY, stroke.fov);

    // Now crop to the bounding box
    const pad = 100;
    const bounds = stroke.brush.getBounds();
    const minX = Math.max(0, bounds.minX - pad);
    const minY = Math.max(0, bounds.minY - pad);
    const maxX = Math.min(this.canvas.width, bounds.maxX + pad);
    const maxY = Math.min(this.canvas.height, bounds.maxY + pad);
    const width = maxX - minX;
    const height = maxY - minY;

    if (width <= 0 || height <= 0) {
      stroke.brush.dispose();
      return null;
    }

    const croppedCanvas = document.createElement("canvas");
    croppedCanvas.width = width;
    croppedCanvas.height = height;
    const croppedCtx = croppedCanvas.getContext("2d")!;
    croppedCtx.drawImage(
      tempCanvas,
      minX,
      minY,
      width,
      height,
      0,
      0,
      width,
      height,
    );

    const GRID_ROWS = Math.max(1, Math.min(12, Math.ceil(height / 50)));
    const GRID_COLS = Math.max(1, Math.min(12, Math.ceil(width / 50)));
    const gridBasic: [number, number][][] = [];

    try {
      const promises: Promise<[number, number] | null>[] = [];
      for (let row = 0; row <= GRID_ROWS; row++) {
        for (let col = 0; col <= GRID_COLS; col++) {
          const px = minX + (col / GRID_COLS) * width;
          const py = minY + (row / GRID_ROWS) * height;
          promises.push(
            this.viewer
              .unprojectToBasic([px, py])
              .then((r) => (r ? ([r[0], r[1]] as [number, number]) : null))
              .catch(() => null),
          );
        }
      }

      const results = await Promise.all(promises);

      let idx = 0;
      for (let row = 0; row <= GRID_ROWS; row++) {
        const rowPoints: [number, number][] = [];
        for (let col = 0; col <= GRID_COLS; col++) {
          const basic = results[idx++];
          rowPoints.push(basic ? [basic[0], basic[1]] : [0, 0]);
        }
        gridBasic.push(rowPoints);
      }

      stroke.brush.dispose();
      this.bakeShading(croppedCanvas, gridBasic);

      return {
        canvas: croppedCanvas,
        gridBasic,
        gridRows: GRID_ROWS,
        gridCols: GRID_COLS,
        srcWidth: width,
        srcHeight: height,
        referenceFov: stroke.fov,
      };
    } catch {
      stroke.brush.dispose();
      return null;
    }
  }

  private async finalizePenStroke(stroke: {
    pen: Pen | ChalkBrush | FountainPenBrush | WatercolorBrush;
    lastX: number;
    lastY: number;
    fov: number;
  }): Promise<MarkerTexture | null> {
    if (!this.viewer) return null;

    const isWatercolor = stroke.pen instanceof WatercolorBrush;

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = this.canvas.width;
    tempCanvas.height = this.canvas.height;
    const tempCtx = tempCanvas.getContext("2d")!;

    await stroke.pen.render(tempCtx, stroke.lastX, stroke.lastY, stroke.fov);

    const pad = isWatercolor ? 150 : 50;
    const bounds = stroke.pen.getBounds();
    const minX = Math.max(0, bounds.minX - pad);
    const minY = Math.max(0, bounds.minY - pad);
    const maxX = Math.min(this.canvas.width, bounds.maxX + pad);
    const maxY = Math.min(this.canvas.height, bounds.maxY + pad);
    const width = maxX - minX;
    const height = maxY - minY;

    if (width <= 0 || height <= 0) {
      stroke.pen.dispose();
      return null;
    }

    const croppedCanvas = document.createElement("canvas");
    croppedCanvas.width = width;
    croppedCanvas.height = height;
    const croppedCtx = croppedCanvas.getContext("2d")!;
    croppedCtx.drawImage(
      tempCanvas,
      minX,
      minY,
      width,
      height,
      0,
      0,
      width,
      height,
    );

    const GRID_ROWS = Math.max(1, Math.min(12, Math.ceil(height / 50)));
    const GRID_COLS = Math.max(1, Math.min(12, Math.ceil(width / 50)));
    const gridBasic: [number, number][][] = [];

    try {
      const promises: Promise<[number, number] | null>[] = [];
      for (let row = 0; row <= GRID_ROWS; row++) {
        for (let col = 0; col <= GRID_COLS; col++) {
          const px = minX + (col / GRID_COLS) * width;
          const py = minY + (row / GRID_ROWS) * height;
          promises.push(
            this.viewer
              .unprojectToBasic([px, py])
              .then((r) => (r ? ([r[0], r[1]] as [number, number]) : null))
              .catch(() => null),
          );
        }
      }

      const results = await Promise.all(promises);

      let idx = 0;
      for (let row = 0; row <= GRID_ROWS; row++) {
        const rowPoints: [number, number][] = [];
        for (let col = 0; col <= GRID_COLS; col++) {
          const basic = results[idx++];
          rowPoints.push(basic ? [basic[0], basic[1]] : [0, 0]);
        }
        gridBasic.push(rowPoints);
      }

      stroke.pen.dispose();

      const resolvedToolType = isWatercolor
        ? ("watercolor" as const)
        : stroke.pen instanceof ChalkBrush
          ? ("crayon" as const)
          : stroke.pen instanceof FountainPenBrush
            ? ("fountainPen" as const)
            : ("pencil" as const);
      this.bakeShading(croppedCanvas, gridBasic);
      return {
        canvas: croppedCanvas,
        toolType: resolvedToolType,
        gridBasic,
        gridRows: GRID_ROWS,
        gridCols: GRID_COLS,
        srcWidth: width,
        srcHeight: height,
        referenceFov: stroke.fov,
      };
    } catch {
      stroke.pen.dispose();
      return null;
    }
  }

  // ── 3D surface drawing (decals) ───────────────────────────────────────

  /** Build a surface decal for a stroke starting at this screen point (null = draw flat). */
  private makeDecal(pixelX: number, pixelY: number, worldPerPx?: number): DecalState | null {
    const why = (r: string) => {
      if (import.meta.env.DEV && (globalThis as { __deepDebug?: boolean }).__deepDebug) console.info(`[deep] flat @${pixelX | 0},${pixelY | 0}: ${r}`);
      return null;
    };
    if (!this._deepData) return why("no deep data");
    if (!canPaintSurfaces(this.scene)) return why("no GPU support");
    const b = this.screenToBasic(pixelX, pixelY);
    if (!b) return why("no projection");
    const radPerPx = ((this.currentFov * Math.PI) / 180) / Math.max(1, this.canvas.height);
    const st = startPiece(this._deepData, b, radPerPx, worldPerPx, false, this._strokeParams!, Math.floor(Math.random() * 2 ** 31), this._strokeGroup, this.currentFov);
    if (!st) return why("no surface (sky)");
    st.prev.screen = [pixelX, pixelY];
    if (import.meta.env.DEV && (globalThis as { __deepDebug?: boolean }).__deepDebug) console.info(`[deep] wrap @${pixelX | 0},${pixelY | 0}${worldPerPx ? " (chained)" : ""}`);
    return st;
  }

  /** Screen px -> basic coords via Mapillary's sync projection (null if unavailable). */
  private screenToBasic(x: number, y: number): [number, number] | null {
    const sync = this.getSyncProjectionContext();
    if (!sync) return null;
    try {
      const b = sync.proj.canvasToBasic([x, y], sync.container, sync.renderCamera, sync.transform);
      return b ? [b[0], b[1]] : null;
    } catch {
      return null;
    }
  }

  /** Is this screen point on the sky (no paintable surface)? */
  private isSkyAt(x: number, y: number): boolean {
    const b = this._deepData && this.screenToBasic(x, y);
    return !!b && isSky(this._deepData, b[0], b[1]);
  }

  /** Brush samples (u, v, decal x, y) not yet sent. */
  private _pendingSamples: number[] = [];

  /** A piece of our stroke starts here: everyone else rebuilds the same decal and brush. */
  private beginPiece(st: DecalState): void {
    this._activeDecal = st;
    this._pendingSamples = [];
    realtime.send({
      t: "stroke_start", color: st.params.color, lineWidth: st.params.lineWidth, toolType: st.toolType,
      u: st.start[0], v: st.start[1], fov: st.fov, group: st.group, seed: st.seed, wpp: st.geo.s,
    });
  }

  /**
   * Walk the stroke along the surface through every pointer position since the last frame, in small
   * steps, then let the brush paint that bit. Fast moves are followed exactly like slow ones.
   */
  private advanceDecal(): void {
    const path = this._decalPath;
    if (!path.length) return;
    this._decalPath = [];
    // steps of about one depth-map pixel (bigger ones could skip over a depth edge)
    const pxPerCell = Math.max(1, this.canvas.height) / ((this.currentFov / 180) * 1024);
    const step = Math.min(5, Math.max(2, pxPerCell));
    for (const [x, y] of path) {
      const [fx, fy] = this._decalPos;
      const n = Math.max(1, Math.ceil(Math.hypot(x - fx, y - fy) / step));
      for (let k = 1; k <= n; k++) this.stepDecal(fx + ((x - fx) * k) / n, fy + ((y - fy) * k) / n);
      this._decalPos = [x, y];
    }
    if (this._activeDecal) this.paintTrack(this._activeDecal);
  }

  /** One small step of the stroke's path on screen. */
  private stepDecal(x: number, y: number): void {
    const st = this._activeDecal;
    const b = st && this.screenToBasic(x, y);
    if (!st || !b) return;
    if (!st.geo.isSurface(b[0], b[1])) {
      // over the sky: the pen is up until the path is back on something
      st.gap = true;
      st.off = [];
      return;
    }
    // how far the path may be off this surface before the stroke continues on the other one
    // (thin things like railings are skipped; ragged areas like trees split less eagerly)
    const now = performance.now();
    this._chainTimes = this._chainTimes.filter((t) => now - t < 400);
    const hop = Math.min(48, 6 + 4 * this._chainTimes.length);
    const d = st.geo.reach(b[0], b[1]);
    if (d && continues(st, b, d)) {
      if (!st.gap || Math.hypot(x - st.prev.screen[0], y - st.prev.screen[1]) <= hop) {
        st.gap = false;
        st.off = [];
        st.prev = { basic: b, decal: d, screen: [x, y] };
        st.track.push(st.prev);
        if (Math.hypot(d[0] - st.marked[0], d[1] - st.marked[1]) > st.nearRadius * 0.4) {
          st.geo.markNear(b[0], b[1], st.nearRadius * st.geo.s);
          st.marked = d;
        }
        return;
      }
      this.chainDecal(x, y, b);
      return;
    }
    st.off.push([x, y]);
    const [ox, oy] = st.off[0];
    if (Math.hypot(x - ox, y - oy) >= hop) this.leaveSurface();
  }

  /** The path is off this piece's surface for good: continue the stroke from where it left. */
  private leaveSurface(): void {
    const st = this._activeDecal;
    if (!st || !st.off.length) return;
    const off = st.off;
    st.off = [];
    const b = this.screenToBasic(off[0][0], off[0][1]);
    if (!b) return;
    // still the same surface (the unwrap just ended here): join on at the last painted point
    const near = st.geo.step(st.prev.basic, b);
    const moved = st.hasPaint || st.track.length > 0; // a piece that got nowhere isn't joined onto again
    const joined = moved && !st.gap && near.depth < 1.15 && Math.hypot(off[0][0] - st.prev.screen[0], off[0][1] - st.prev.screen[1]) < 8;
    const ok = joined
      ? this.chainDecal(st.prev.screen[0], st.prev.screen[1], st.prev.basic, st.geo.worldPerPxAt(st.prev.basic[0], st.prev.basic[1]) ?? undefined)
      : this.chainDecal(off[0][0], off[0][1], b);
    if (!ok) { st.gap = true; return; }
    for (const [x, y] of joined ? off : off.slice(1)) this.stepDecal(x, y);
  }

  /** Finish the current piece and continue the same stroke on a new one starting at this point. */
  private chainDecal(x: number, y: number, b: [number, number], worldPerPx?: number): boolean {
    const st = this._activeDecal;
    const params = this._strokeParams;
    if (!st || !params) return false;
    const radPerPx = ((this.currentFov * Math.PI) / 180) / Math.max(1, this.canvas.height);
    const next = this._deepData && startPiece(this._deepData, b, radPerPx, worldPerPx, false, params, Math.floor(Math.random() * 2 ** 31), this._strokeGroup, this.currentFov);
    if (!next) { st.gap = true; return false; }
    next.prev.screen = [x, y];
    this.endPiece(st);
    next.tool.resume(st.tool);
    this._chainTimes.push(performance.now());
    this.beginPiece(next);
    return true;
  }

  /** Hand the path walked so far to the brush (and to everyone watching). */
  private paintTrack(st: DecalState): void {
    const track = st.track;
    if (!track.length) return;
    let dist = 0, p = st.painted;
    for (const t of track) { dist += Math.hypot(t.decal[0] - p[0], t.decal[1] - p[1]); p = t.decal; }
    if (dist < 1) return; // too little yet: paint it with the next frame
    st.track = [];
    const round = (v: number) => Math.round(v * 100) / 100;
    const pts = track.map((t) => [round(t.decal[0]), round(t.decal[1])] as [number, number]);
    const keep = simplify(st.painted, pts, 0.6);
    const kept = keep.map((i) => pts[i]);
    keep.forEach((i, k) => {
      const mid = k < keep.length - 1;
      this._pendingSamples.push(+track[i].basic[0].toFixed(6), +track[i].basic[1].toFixed(6), pts[i][0] + (mid ? MID_SAMPLE : 0), pts[i][1]);
    });
    this.flushStrokeSamples();
    paintFrame(st, kept, track[track.length - 1].basic, this.canvas.height);
  }

  /** End a piece: bake it now (it's small), free its surface map, keep the picture on screen. */
  private endPiece(st: DecalState): void {
    this.paintTrack(st);
    this.flushStrokeSamples(true);
    this.broadcastStrokeEnd();
    const piece = bakePiece(st);
    if (piece) this._pieces.push({ piece, tex: pieceTexture(piece, st) });
    releasePiece(this.scene, st);
    if (this._activeDecal === st) this._activeDecal = null;
  }

  private dropPieces(): void {
    for (const { tex } of this._pieces) this.webglRenderer?.invalidateTexture(texSource(tex));
    this._pieces = [];
  }

  /** The stroke is over: its pieces become one bitmap, on screen, undoable and shared right away. */
  private endDecalStroke(): void {
    this.advanceDecal();
    const st0 = this._activeDecal;
    if (st0 && st0.off.length > 1 && this._strokeHasMovement) this.leaveSurface();
    const st = this._activeDecal;
    if (!st) return;
    this.endPiece(st);
    const pieces = this._pieces;
    this._pieces = [];
    if (!pieces.length) { this.render(); return; }
    let tex = pieces[0].tex;
    if (pieces.length > 1) {
      tex = pieceTexture(mergePieces(pieces.map((p) => p.piece)), st);
      for (const p of pieces) this.webglRenderer?.invalidateTexture(texSource(p.tex));
    }
    tex.isLocal = true;
    this.strokes.add(tex);
    this.live.history.add(tex);
    void this.live.share(tex);
    this.render();
  }

  /** Everything baked that's on screen: finished strokes, then pieces of strokes in progress. */
  private drawList(): MarkerTexture[] {
    const extra: MarkerTexture[] = [];
    extra.push(...this.live.replays.strokes());
    for (const p of this._pieces) extra.push(p.tex);
    return extra.length ? [...this.strokes.list, ...extra] : this.strokes.list;
  }

  /** Live (in-progress) 3D strokes to draw this frame. */
  private liveDecals(): DecalState[] {
    const out = this.live.replays.pieces();
    if (this._activeDecal?.hasPaint) out.push(this._activeDecal);
    return out;
  }

  private _liveCanvas: HTMLCanvasElement | null = null;
  private _liveCtx: CanvasRenderingContext2D | null = null;

  /**
   * Draw a live (in-progress or finishing) stroke, shaded with the panorama's surface map so it
   * already looks painted-on while drawing — matching what gets baked when it's finished.
   * Falls back to a plain render when there's no shading data or no sync projection yet.
   */
  private async renderShaded(
    obj: {
      render(ctx: CanvasRenderingContext2D, x: number, y: number, fov: number): unknown;
      getBounds(): { minX: number; minY: number; maxX: number; maxY: number };
    },
    x: number,
    y: number,
    fov: number,
  ): Promise<void> {
    const surface = this._deepShade;
    const sync = surface && !this._isRainbowStroke ? this.getSyncProjectionContext() : null;
    if (!surface || !sync) {
      await obj.render(this.ctx, x, y, fov);
      return;
    }
    const cw = this.canvas.width, ch = this.canvas.height;
    if (!this._liveCanvas || this._liveCanvas.width !== cw || this._liveCanvas.height !== ch) {
      this._liveCanvas = document.createElement("canvas");
      this._liveCanvas.width = cw;
      this._liveCanvas.height = ch;
      this._liveCtx = this._liveCanvas.getContext("2d", { willReadFrequently: true });
    }
    const off = this._liveCanvas, offCtx = this._liveCtx!;
    const pad = obj instanceof WatercolorBrush ? 150 : 50;
    const b = obj.getBounds();
    const x0 = Math.max(0, Math.floor(b.minX - pad)), y0 = Math.max(0, Math.floor(b.minY - pad));
    const x1 = Math.min(cw, Math.ceil(b.maxX + pad)), y1 = Math.min(ch, Math.ceil(b.maxY + pad));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0 || !isFinite(w) || !isFinite(h)) {
      await obj.render(this.ctx, x, y, fov);
      return;
    }
    offCtx.clearRect(0, 0, cw, ch);
    await obj.render(offCtx, x, y, fov);
    // coarse screen -> panorama grid (sync), interpolated per pixel inside shadeRegion
    const STEP = 32;
    const rows = Math.max(1, Math.ceil(h / STEP)), cols = Math.max(1, Math.ceil(w / STEP));
    const grid: ([number, number] | null)[][] = [];
    for (let r = 0; r <= rows; r++) {
      const row: ([number, number] | null)[] = [];
      for (let c = 0; c <= cols; c++) {
        let bp: number[] | null = null;
        try {
          bp = sync.proj.canvasToBasic([x0 + (c / cols) * w, y0 + (r / rows) * h], sync.container, sync.renderCamera, sync.transform);
        } catch {
          bp = null;
        }
        row.push(bp ? [bp[0], bp[1]] : null);
      }
      grid.push(row);
    }
    shadeRegion(offCtx, x0, y0, w, h, grid, surface);
    this.ctx.drawImage(off, x0, y0, w, h, x0, y0, w, h);
  }

  /** Bake the panorama's shadows/texture into a finished stroke bitmap (no-op without shading data). */
  private bakeShading(canvas: HTMLCanvasElement, gridBasic: [number, number][][]): void {
    if (!this._deepShade || this._isRainbowStroke) return;
    try {
      applyShading(canvas, gridBasic, this._deepShade);
    } catch (e) {
      console.warn("[DrawingOverlay] shading bake failed:", e);
    }
  }

  private getSyncProjectionContext(): ProjectionContext | null {
    if (!this.viewer || !this._cachedRenderCamera || !this._cachedTransform) return null;
    const p = screenProjection(this.viewer);
    return p && { proj: p.projection, container: p.container, renderCamera: this._cachedRenderCamera, transform: this._cachedTransform };
  }

  private async renderMarkerTextures(): Promise<void> {
    const live = this.liveDecals();
    const list = this.drawList();
    if (!this.viewer || (list.length === 0 && live.length === 0)) return;

    // ── GPU projection fast path ─────────────────────────────────────────
    // No per-texture JS projection — GPU transforms basic→screen in vertex shader
    if (this.useWebGL && this.webglRenderer?.hasGPUProjection()) {
      const gpuUniforms = projectionUniforms(this.getSyncProjectionContext());
      if (gpuUniforms) {
        this.webglRenderer.setGPUProjectionUniforms(gpuUniforms);

        const hueShift = getRainbowHueShift();
        for (const tex of list) {
          if (!tex._gpuBasicCoords) buildPanoramaGeometry(tex);
          if (!tex._gpuVertexCount) continue;

          const texOpacity = tex.opacity ?? 1;
          this.webglRenderer.drawGPUProjectedBatch(
            texSource(tex),
            tex._gpuBasicCoords!,
            tex._gpuTexCoords!,
            texOpacity,
            false,
            tex.isRainbow ? hueShift : 0,
          );
        }
        drawLivePieces(this.webglRenderer, live);
        return;
      }
    }

    // ── CPU projection fallback ──────────────────────────────────────────
    const currentRenderId = this.currentRenderId;
    const syncCtx = this.getSyncProjectionContext();

    const asyncProjections: Promise<number[] | null>[] = [];
    const asyncMeta: { tex: MarkerTexture; startIdx: number }[] = [];

    for (const tex of this.strokes.list) {
      if (tex.isProjecting) continue;
      if (tex.cachedProjection && !tex.needsProjection) continue;

      if (syncCtx) {
        let canSync = true;
        const projectedGrid: ([number, number] | null)[][] = [];
        outer: for (let row = 0; row <= tex.gridRows; row++) {
          const rowPoints: ([number, number] | null)[] = [];
          for (let col = 0; col <= tex.gridCols; col++) {
            const syncPoint = projectToScreen(
              tex.gridBasic[row][col],
              syncCtx,
            );
            if (syncPoint === undefined) {
              canSync = false;
              break outer;
            }
            rowPoints.push(syncPoint);
          }
          projectedGrid.push(rowPoints);
        }

        if (canSync) {
          tex.cachedProjection = projectedGrid;
          tex.needsProjection = false;
          if (this.useWebGL) buildScreenGeometry(tex);
          continue;
        }
      }

      tex.isProjecting = true;
      const startIdx = asyncProjections.length;
      for (let row = 0; row <= tex.gridRows; row++) {
        for (let col = 0; col <= tex.gridCols; col++) {
          asyncProjections.push(
            this.viewer.projectFromBasic(tex.gridBasic[row][col]),
          );
        }
      }
      asyncMeta.push({ tex, startIdx });
    }

    if (asyncProjections.length > 0) {
      const allResults = await Promise.all(asyncProjections);
      const renderIdChanged = this.currentRenderId !== currentRenderId;

      for (const { tex, startIdx } of asyncMeta) {
        tex.isProjecting = false;
        if (!renderIdChanged) {
          const projectedGrid: ([number, number] | null)[][] = [];
          let idx = startIdx;
          for (let row = 0; row <= tex.gridRows; row++) {
            const rowPoints: ([number, number] | null)[] = [];
            for (let col = 0; col <= tex.gridCols; col++) {
              const p = allResults[idx++];
              rowPoints.push(p ? [p[0], p[1]] : null);
            }
            projectedGrid.push(rowPoints);
          }
          tex.cachedProjection = projectedGrid;
          tex.needsProjection = false;
          if (this.useWebGL) buildScreenGeometry(tex);
        }
      }
    }

    for (const tex of this.strokes.list) {
      if (!tex.cachedProjection) continue;
      const texOpacity = tex.opacity ?? 1;

      if (this.useWebGL && this.webglRenderer) {
        if (tex._glTriCount && tex._glPositions && tex._glTexCoords) {
          const hueShiftCPU = tex.isRainbow ? getRainbowHueShift() : 0;
          this.webglRenderer.drawTexturedTriangleBatch(
            texSource(tex),
            tex._glPositions,
            tex._glTexCoords,
            texOpacity,
            false,
            hueShiftCPU,
          );
        }
      } else {
        const projectedGrid = tex.cachedProjection;
        const cellWidth = tex.srcWidth / tex.gridCols;
        const cellHeight = tex.srcHeight / tex.gridRows;
        const savedAlpha = this.ctx.globalAlpha;
        this.ctx.globalAlpha = texOpacity;
        try {
          for (let row = 0; row < tex.gridRows; row++) {
            for (let col = 0; col < tex.gridCols; col++) {
              const tl = projectedGrid[row][col];
              const tr = projectedGrid[row][col + 1];
              const bl = projectedGrid[row + 1][col];
              const br = projectedGrid[row + 1][col + 1];
              if (!tl || !tr || !bl || !br) continue;
              const srcX = col * cellWidth;
              const srcY = row * cellHeight;
              drawTexturedTriangle(
                this.ctx,
                texSource(tex),
                srcX,
                srcY,
                srcX + cellWidth,
                srcY,
                srcX,
                srcY + cellHeight,
                tl[0],
                tl[1],
                tr[0],
                tr[1],
                bl[0],
                bl[1],
              );
              drawTexturedTriangle(
                this.ctx,
                texSource(tex),
                srcX + cellWidth,
                srcY,
                srcX + cellWidth,
                srcY + cellHeight,
                srcX,
                srcY + cellHeight,
                tr[0],
                tr[1],
                br[0],
                br[1],
                bl[0],
                bl[1],
              );
            }
          }
        } catch {
          // a texture that can't be drawn (yet) is skipped this frame
        }
        this.ctx.globalAlpha = savedAlpha;
      }
    }
  }

  private async render(): Promise<void> {
    if (!this.viewer) return;

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (this.useWebGL && this.webglRenderer) {
      this.webglRenderer.clear();
      await this.renderMarkerTextures();
    } else {
      await this.renderMarkerTextures();
    }
  }

  setImageId(imageId: string): void {
    this._imageId = imageId;
    this._deepShade = null;
    this._deepData = null;
    loadDeepData(imageId).then((data) => {
      if (this._imageId !== imageId) return;
      this._deepData = data;
      this._deepShade = data?.surface ?? null;
      console.info(`[deep] ${imageId}: ${data ? "3D surface painting ON (depth + shading loaded)" : "no deep data for this panorama — strokes stay flat"}`);
    });
    this.render();
    this.onReady?.();
  }

  fadeIn(): void {
    this.canvas.style.transition = "opacity 0.4s ease-in-out";
    this.canvas.style.opacity = "1";
    if (this.useWebGL && this.webglRenderer) {
      this.webglRenderer.getCanvas().style.transition =
        "opacity 0.4s ease-in-out";
      this.webglRenderer.getCanvas().style.opacity = "1";
    }
    // Ensure WebGL buffer is populated
    this.render();
  }

  fadeOut(): Promise<void> {
    return new Promise((resolve) => {
      this.canvas.style.transition = "opacity 0.4s ease-out";
      if (this.useWebGL && this.webglRenderer) {
        this.webglRenderer.getCanvas().style.transition =
          "opacity 0.4s ease-out";
        this.webglRenderer.getCanvas().style.opacity = "0";
      }
      this.canvas.style.opacity = "0";

      // Resolve after the transition completes
      const handler = () => {
        this.canvas.removeEventListener("transitionend", handler);
        resolve();
      };
      this.canvas.addEventListener("transitionend", handler);

      // Fallback timeout in case transitionend doesn't fire
      setTimeout(resolve, 500);
    });
  }

  /**
   * Start a lightweight rAF loop that re-renders rainbow textures
   * so their hue-shift animation stays alive even when no strokes are active.
   */
  private _startRainbowAnimationLoop(): void {
    if (this._rainbowAnimFrameId !== null) return; // Already running

    const loop = () => {
      // Check if any rainbow textures still exist
      const hasRainbow = this.strokes.list.some((t) => t.isRainbow);
      if (!hasRainbow) {
        this._rainbowAnimFrameId = null;
        return;
      }

      // Trigger a synchronous GPU re-render with updated hue shift
      if (this.useWebGL && this.webglRenderer?.hasGPUProjection()) {
        this.renderGPUTexturesOnly();
      } else {
        this.invalidateProjectionCache();
      }

      this._rainbowAnimFrameId = requestAnimationFrame(loop);
    };

    this._rainbowAnimFrameId = requestAnimationFrame(loop);
  }

  dispose(): void {
    this.cursor.dispose();
    this.live.peers.dispose();
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    if (this._rainbowAnimFrameId) {
      cancelAnimationFrame(this._rainbowAnimFrameId);
      this._rainbowAnimFrameId = null;
    }
    if (this.brush) {
      this.brush.dispose();
    }

    // Clean up dying/finalizing stroke brushes
    for (const s of this.dyingStrokes) {
      s.brush.dispose();
    }
    this.dyingStrokes = [];
    for (const s of this.dyingPenStrokes) {
      s.pen.dispose();
    }
    this.dyingPenStrokes = [];
    this.finalizingStrokes = [];
    this.finalizingPenStrokes = [];
    this.pendingTextures = [];
    this.pendingPenTextures = [];

    // Clean up remote strokes and leave the place's live room
    this.live.leave();

    // Clean up RxJS subscriptions
    for (const sub of this._internalSubs) {
      sub.unsubscribe();
    }
    this._internalSubs = [];

    // Remove viewer event listeners
    for (const off of this._boundViewerListeners) off();
    this._boundViewerListeners = [];

    this.strokes.dispose();
    this.live.history.clear();

    if (this.webglRenderer) {
      this.webglRenderer.dispose();
    }
    if (this._boundResize) {
      window.removeEventListener("resize", this._boundResize);
    }
    this.canvas.remove();
  }
}
