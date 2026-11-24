import type { Viewer } from "mapillary-js";
import { applyShading, shadeRegion } from "../deep/strokeShading";
import { SurfaceDecal, loadDeepData, surfaceRing, type DeepData } from "../deep/surfaceDecal";
import { mergePieces, type BakedPiece } from "../deep/geodesicMap";
import { preloadDecalTools, simplify, type ToolType } from "../deep/decalTools";
import { basicToTex, eraseBox, isBlank, isEraseEdit, type EraseEdit, type UndoEntry } from "./eraser";
import { ChalkBrush } from "./flat/crayon";
import { FountainPenBrush } from "./flat/fountainPen";
import { Brush, type Drop } from "./flat/marker";
import { Pen } from "./flat/pencil";
import type { Projector, SplashParticle, Unprojector } from "./flat/types";
import { WatercolorBrush } from "./flat/watercolor";
import { PeerCursors } from "./PeerCursors";
import { PeerPreviews } from "./PeerPreviews";
import { buildPanoramaGeometry, buildScreenGeometry, drawTexturedTriangle, projectionUniforms, projectToScreen } from "./projection";
import { getRainbowHueShift, resolveRainbowColor } from "./rainbow";
import type { ProjectionContext, Scene } from "./scene";
import { copyCanvas, ensureCanvas, texSource, type MarkerTexture } from "./strokes";
import { bakePiece, continues, drawLivePieces, isSky, MID_SAMPLE, paintFrame, pieceTexture, startPiece, type DecalState, type Replay } from "./surfaceStrokes";
import { WebGLDrawingRenderer } from "./WebGLDrawingRenderer";
import { realtime } from "../realtime/client";
import type { PreviewView } from "../pool/localPreview";
import { followCamera, screenProjection, type PhotoTransform, type RenderCamera, type Subscription } from "../viewer/mapillaryInternals";
import { PAINT_LAYER, type FinishedStroke, type LayerTiles, type ServerMessage } from "../../shared/realtime";

export class DrawingOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private viewer: Viewer | null = null;
  private markerTextures: MarkerTexture[] = [];
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

  // Undo/Redo stacks
  private _undoStack: UndoEntry[] = [];
  private _redoStack: UndoEntry[] = [];

  // Realtime collaboration
  private lastBroadcastTime: number = 0;
  private _isRainbowStroke: boolean = false; // Current stroke is rainbow
  private _rainbowAnimFrameId: number | null = null; // Animation loop for rainbow textures
  private _container: HTMLElement | null = null;

  /** What's on screen right now, for the parts drawn on top of it. */
  private readonly scene: Scene;
  private readonly peers: PeerCursors;
  private readonly peerPreviews: PeerPreviews;

  constructor(container: HTMLElement) {
    preloadDecalTools();
    this._container = container;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- read live by the getters below
    const overlay = this;
    this.scene = {
      container,
      get deep() { return overlay._deepData; },
      get fov() { return overlay.currentFov; },
      get radPerPx() { return ((overlay.currentFov * Math.PI) / 180) / Math.max(1, overlay.canvas.height); },
      projection: () => this.getSyncProjectionContext(),
      isSky: (u, v) => isSky(this._deepData, u, v),
    };
    this.peers = new PeerCursors(this.scene);
    this.peerPreviews = new PeerPreviews(this.scene, this.peers, {
      swap: (remove, add) => {
        const i = remove ? this.markerTextures.indexOf(remove) : -1;
        if (i > -1) this.markerTextures.splice(i, 1);
        if (remove) this.webglRenderer?.invalidateTexture(texSource(remove));
        if (add) this.markerTextures.push(add);
        this.render();
      },
    });
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
    this.peers.reproject();
    // keep the outline pinned to its spot in the scene while the camera moves
    if (this._cursorAnchor && this._cursorLayer && this._cursorLayer.style.display !== "none") {
      this._cursorCameraMoved = true;
      this.reprojectBrushCursor();
    }
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
      for (const tex of this.markerTextures) {
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

  /** Join this panorama's live room: others' cursors and strokes appear, ours are shared. */
  subscribeToRealtime(imageId: string): void {
    this.unsubscribeFromRealtime();
    this._liveRoom = imageId;
    this._realtimeOff = realtime.on((msg) => this.onRealtimeMessage(msg));
    realtime.join(imageId);
  }

  /** Called when undo/redo availability changes without a user action (e.g. strokes got baked). */
  onHistoryChange: (() => void) | null = null;

  // ── The room's paint layer: older strokes, flattened by the server into a few tiles ──
  private _liveRoom: string | null = null;
  private _layerTiles = new Map<string, { version: number; tex: MarkerTexture }>();
  /** load / update these tiles; resolves once they're on screen (so strokes can swap without a gap) */
  private async applyLayerTiles(tiles: LayerTiles): Promise<void> {
    const room = this._liveRoom;
    if (!room) return;
    const { width: LW, height: LH, tile: T } = PAINT_LAYER;
    await Promise.all(Object.entries(tiles).map(async ([key, version]) => {
      if (this._layerTiles.get(key)?.version === version) return;
      const [tx, ty] = key.split("_").map(Number);
      try {
        const blob = await (await fetch(`/api/layer/${encodeURIComponent(room)}/${key}?v=${version}`)).blob();
        const bitmap = await createImageBitmap(blob);
        if (this._liveRoom !== room) { bitmap.close?.(); return; }
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
        bitmap.close?.();
        // a fine grid so the tile follows the sphere when projected (like baked strokes)
        const N = 16;
        const gridBasic: [number, number][][] = [];
        for (let r = 0; r <= N; r++) {
          const row: [number, number][] = [];
          for (let c = 0; c <= N; c++) row.push([(tx * T + (c / N) * T) / LW, (ty * T + (r / N) * T) / LH]);
          gridBasic.push(row);
        }
        const tex: MarkerTexture = {
          canvas, gridBasic, gridRows: N, gridCols: N,
          srcWidth: canvas.width, srcHeight: canvas.height, referenceFov: 90, opacity: 1,
        };
        const old = this._layerTiles.get(key);
        if (old && old.version > version) return; // a newer one landed first
        this._layerTiles.set(key, { version, tex });
        const i = old ? this.markerTextures.indexOf(old.tex) : -1;
        // the layer is older paint: it sits under every separate stroke
        if (i > -1) this.markerTextures[i] = tex;
        else this.markerTextures.unshift(tex);
        if (old && this.webglRenderer) this.webglRenderer.invalidateTexture(texSource(old.tex));
      } catch (err) {
        console.warn("[realtime] paint layer tile failed:", key, err);
      }
    }));
    this.render();
  }

  /** Strokes that are now part of the paint layer: drop the separate copies (ours too: undo can't reach into the layer). */
  private dropFlattened(ids: string[]): void {
    const gone = new Set(ids);
    const isGone = (e: unknown) => !!(e as MarkerTexture).liveId && gone.has((e as MarkerTexture).liveId!);
    this._undoStack = this._undoStack.filter(e => !isGone(e));
    this._redoStack = this._redoStack.filter(e => !isGone(e));
    this.removeLiveStrokes(ids);
    this.onHistoryChange?.();
  }

  private clearLayerTiles(): void {
    for (const { tex } of this._layerTiles.values()) {
      const i = this.markerTextures.indexOf(tex);
      if (i > -1) this.markerTextures.splice(i, 1);
      if (this.webglRenderer) this.webglRenderer.invalidateTexture(texSource(tex));
    }
    this._layerTiles.clear();
  }

  /**
   * Leaving the place: stop listening and leave its live room on the server. Without this the
   * connection stayed in the room, so coming back to the same place was ignored as "already
   * there" and its saved drawings never arrived until a reload.
   */
  leaveRealtime(): void {
    this.unsubscribeFromRealtime();
    this._liveRoom = null;
    // a stroke finished just now may still be encoding: let it reach the room first
    if (this._sharing.size) realtime.leaveAfter(Promise.race([Promise.allSettled(this._sharing), new Promise((r) => setTimeout(r, 3000))]));
    else realtime.leave();
  }

  unsubscribeFromRealtime(): void {
    this._realtimeOff?.();
    this._realtimeOff = null;
    this.clearLayerTiles();
    // Clean up others' in-progress strokes and cursors
    this.peerPreviews.clear();
    for (const id of [...this._replays.keys()]) this.dropReplays(id);
    this.peers.clear();
  }

  private onRealtimeMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        // strokes others drew in this room before we arrived (held in server memory)
        this.peers.clear();
        for (const p of msg.peers) this.peers.colors.set(p.id, p.color);
        if (msg.layer) void this.applyLayerTiles(msg.layer);
        for (const s of msg.strokes) void this.addLiveStroke(s);
        return;
      case "flattened":
        // swap the separate strokes for the updated layer once its tiles are on screen
        void this.applyLayerTiles(msg.tiles).then(() => this.dropFlattened(msg.ids));
        return;
      case "peer_join":
        this.peers.colors.set(msg.peer.id, msg.peer.color);
        return;
      case "peer_leave":
        this.peers.colors.delete(msg.id);
        this.peers.brush.delete(msg.id);
        this.peers.remove(msg.id);
        this.peerPreviews.end(msg.id);
        this.dropReplays(msg.id);
        return;
      case "cursor":
        this.peers.set(msg.from, msg);
        return;
      case "cursor_hide":
        this.peers.remove(msg.from);
        return;
      case "stroke_start":
        if (msg.seed !== undefined && msg.wpp !== undefined && this.replayStart(msg.from, msg)) return;
        this.peerPreviews.start(msg.from, msg.color, msg.u, msg.v, msg.group);
        return;
      case "stroke_point": {
        const r = this.liveReplay(msg.from);
        if (r && msg.pts) return this.replaySamples(r, msg.pts);
        this.peerPreviews.point(msg.from, msg.u, msg.v);
        return;
      }
      case "stroke_end": {
        const r = this.liveReplay(msg.from);
        if (r) return this.replayEnd(msg.from, r);
        this.peerPreviews.pieceEnded(msg.from);
        return;
      }
      case "stroke_done": {
        // the finished, lit bitmap replaces the live line once the whole stroke is over
        const from = msg.from, group = msg.stroke.strokeGroup;
        // the replayed copy is pixel-identical: swap once the bitmap is on screen
        // (every piece of it: one bitmap holds the whole stroke)
        const replays = (this._replays.get(from) ?? []).filter((r) => r.ended && (group === undefined || r.group === group));
        for (const r of replays) clearTimeout(r.timer);
        void this.addLiveStroke(msg.stroke).then(() => {
          requestAnimationFrame(() => { for (const r of replays) this.dropReplay(from, r); });
          this.peerPreviews.finished(from, group);
        });
        return;
      }
      case "erase":
        this.removeLiveStrokes(msg.ids);
        return;
    }
  }

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

  /** Tell the room these finished strokes are gone (undo / eraser). */
  private broadcastEraseStrokes(textures: MarkerTexture[]): void {
    this._ownChanges = true;
    const ids = textures.map((t) => t.liveId).filter((id): id is string => !!id);
    if (ids.length) realtime.send({ t: "erase", ids });
  }

  /**
   * Share a finished stroke exactly as we see it: the baked bitmap (3D wrap + lighting
   * included) and its panorama grid. Called for every finished stroke.
   */
  private shareFinishedStroke(tex: MarkerTexture): Promise<void> {
    this._ownChanges = true;
    const p = this.sendFinishedStroke(tex).catch((e) => console.warn("[realtime] could not share a stroke:", e));
    this._sharing.add(p);
    void p.then(() => this._sharing.delete(p));
    return p;
  }

  /** strokes being encoded for the room */
  private _sharing = new Set<Promise<void>>();
  /** did we draw, undo or erase here since the last takeOwnChanges? */
  private _ownChanges = false;
  takeOwnChanges(): boolean {
    const c = this._ownChanges;
    this._ownChanges = false;
    return c;
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

  private async sendFinishedStroke(tex: MarkerTexture): Promise<void> {
    if (!tex.canvas) return;
    const room = realtime.current;
    tex.liveId ??= crypto.randomUUID();
    const canvas = tex.canvas;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
    const finalBlob = blob?.type === "image/webp" ? blob : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!finalBlob) return;
    const image = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(finalBlob);
    });
    // undone while encoding: don't resurrect it for everyone else
    if (this._redoStack.includes(tex)) return;
    if (realtime.current !== room) return; // in another place by now
    realtime.send({
      t: "stroke_done",
      stroke: {
        id: tex.liveId,
        image,
        gridBasic: tex.gridBasic,
        gridRows: tex.gridRows,
        gridCols: tex.gridCols,
        srcWidth: tex.srcWidth,
        srcHeight: tex.srcHeight,
        referenceFov: tex.referenceFov,
        isRainbow: !!tex.isRainbow,
        toolType: tex.toolType,
        strokeGroup: tex.strokeGroup,
      },
    });
  }

  /** Add someone else's finished stroke (or replace it, e.g. after their redo). */
  private async addLiveStroke(s: FinishedStroke): Promise<void> {
    const imageId = this._imageId;
    try {
      const blob = await (await fetch(s.image)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      if (this._imageId !== imageId) return; // moved to another panorama meanwhile
      this.removeLiveStrokes([s.id], false);
      const tex: MarkerTexture = {
        canvas,
        gridBasic: s.gridBasic,
        gridRows: s.gridRows,
        gridCols: s.gridCols,
        srcWidth: s.srcWidth,
        srcHeight: s.srcHeight,
        referenceFov: s.referenceFov,
        toolType: s.toolType,
        liveId: s.id,
        opacity: 1,
        isRainbow: s.isRainbow,
      };
      this.markerTextures.push(tex);
      if (tex.isRainbow) this._startRainbowAnimationLoop();
      this.render();
    } catch (err) {
      console.error("[realtime] could not add a shared stroke:", err);
    }
  }

  private removeLiveStrokes(ids: string[], render = true): void {
    const gone = new Set(ids);
    let changed = false;
    for (let i = this.markerTextures.length - 1; i >= 0; i--) {
      const t = this.markerTextures[i];
      if (!t.liveId || !gone.has(t.liveId)) continue;
      if (this.webglRenderer) this.webglRenderer.invalidateTexture(texSource(t));
      this.markerTextures.splice(i, 1);
      changed = true;
    }
    if (changed && render) this.render();
  }

  private _realtimeOff: (() => void) | null = null;
  private _lastCursorSend = 0;

  /** Share our brush position (panorama coords + angular radius) at most ~20 times a second. */
  /**
   * Phones have no hover: while a finger draws, share the ring at the stroke's tip so others see
   * where you're painting (and how big your brush is). Your own screen shows nothing extra.
   */
  shareTouchCursor(pixelX: number, pixelY: number, radiusPx: number, force = false): void {
    const b = this.screenToBasic(pixelX, pixelY);
    if (!b) return;
    if (this._deepData && this.isSkyAt(pixelX, pixelY)) return this.shareCursorHide();
    this.sendCursor(b, radiusPx, null, force);
  }

  /** Others stop seeing our ring (finger lifted, pointer left, over the sky). */
  shareCursorHide(): void {
    if (this._cursorShared) realtime.send({ t: "cursor_hide" });
    this._cursorShared = false;
  }

  private _cursorShared = false;

  private sendCursor(b: [number, number], radiusPx: number, paint: string | null, force = false): void {
    const now = performance.now();
    if (!force && now - this._lastCursorSend < 50) return;
    this._cursorShared = true;
    this._lastCursorSend = now;
    const radPerPx = ((this.currentFov * Math.PI) / 180) / Math.max(1, this.canvas.height);
    realtime.send({ t: "cursor", u: b[0], v: b[1], radius: radiusPx * radPerPx, paint: paint === "rainbow" ? null : paint });
  }

  // ── Others' strokes on 3D surfaces: replayed with the same brush ──
  // The drawer sends the decal's origin + scale, the brush seed and every brush sample, so we
  // rebuild their decal, run the same tool on the same samples, and draw it with the same
  // surface shader as our own live strokes. Their finished bitmap is then the same pixels, so
  // the swap when they let go is invisible.
  private _replays = new Map<string, Replay[]>();

  private replayStart(id: string, m: { color: string; lineWidth: number; toolType: string; u: number; v: number; fov: number; group?: number; seed?: number; wpp?: number }): boolean {
    if (!this.canDrawDecals() || m.color === "rainbow") return false;
    const toolType = (["pencil", "marker", "crayon", "fountainPen", "watercolor"] as const).find((t) => t === m.toolType);
    if (!toolType) return false;
    const st = startPiece(this._deepData!, [m.u, m.v], 1, m.wpp, true, { color: m.color, lineWidth: m.lineWidth, toolType }, m.seed ?? 0, m.group ?? 0, m.fov);
    if (!st) return false;
    this.peerPreviews.end(id);
    const r: Replay = { st, group: m.group, ended: false, dead: false, mids: [], tex: null };
    const list = this._replays.get(id) ?? [];
    const before = list[list.length - 1];
    if (before && before.group === m.group) st.tool.resume(before.st.tool);
    // pieces of a stroke stay until its finished bitmap arrives; a new stroke means the old one is over
    for (const o of list) if (o.ended && o.group !== m.group) this.expireReplay(id, o, 6000);
    list.push(r);
    this._replays.set(id, list);
    // a stroke that never finishes (sender vanished) doesn't stay forever
    this.expireReplay(id, r, 60000);
    return true;
  }

  private expireReplay(id: string, r: Replay, ms: number): void {
    clearTimeout(r.timer);
    r.timer = setTimeout(() => this.dropReplay(id, r), ms);
  }

  /** The peer's stroke piece still being drawn (null = none, or they draw flat). */
  private liveReplay(id: string): Replay | null {
    const list = this._replays.get(id);
    const r = list?.[list.length - 1];
    return r && !r.ended ? r : null;
  }

  /** Feed the drawer's brush samples (u, v, decal x, y) to the same brush, frame by frame. */
  private replaySamples(r: Replay, pts: number[]): void {
    if (r.dead) return;
    const st = r.st, g = st.geo, radius = st.nearRadius * g.s;
    for (let k = 0; k + 3 < pts.length; k += 4) {
      const b: [number, number] = [pts[k], pts[k + 1]];
      const mid = pts[k + 2] >= MID_SAMPLE;
      const d: [number, number] = [pts[k + 2] - (mid ? MID_SAMPLE : 0), pts[k + 3]];
      // unwrap and open up the surface along the way
      const from = st.prev;
      let du = b[0] - from.basic[0];
      if (du > 0.5) du -= 1;
      else if (du < -0.5) du += 1;
      const dv = b[1] - from.basic[1];
      const len = Math.hypot(d[0] - from.decal[0], d[1] - from.decal[1]);
      const n = Math.min(400, Math.max(1, Math.ceil(len / (st.nearRadius * 0.3)), Math.ceil(Math.hypot(du * 2048, dv * 1024) / 12)));
      for (let i = 1; i <= n; i++) {
        const u = from.basic[0] + (du * i) / n, v = from.basic[1] + (dv * i) / n;
        if (g.reach(u, v)) g.markNear(u, v, radius);
      }
      st.prev = { basic: b, decal: d, screen: [0, 0] };
      r.mids.push(d);
      if (mid) continue;
      paintFrame(st, r.mids, b, this.canvas.height);
      r.mids = [];
    }
    this.render();
  }

  private replayEnd(id: string, r: Replay): void {
    r.ended = true;
    const piece = bakePiece(r.st);
    if (piece) r.tex = pieceTexture(piece, r.st);
    this.releaseDecal(r.st);
    // the finished bitmap arrives once the whole stroke (all its pieces) is over
    this.expireReplay(id, r, 60000);
    this.render();
  }

  private dropReplay(id: string, r: Replay): void {
    if (r.dead) return;
    r.dead = true;
    clearTimeout(r.timer);
    const list = this._replays.get(id);
    if (list) {
      const i = list.indexOf(r);
      if (i > -1) list.splice(i, 1);
      if (!list.length) this._replays.delete(id);
    }
    if (r.tex) this.webglRenderer?.invalidateTexture(texSource(r.tex));
    if (!r.ended) this.releaseDecal(r.st);
    this.render();
  }

  private dropReplays(id: string): void {
    for (const r of [...(this._replays.get(id) ?? [])]) this.dropReplay(id, r);
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
            this.markerTextures.push(item.texture);
            this._undoStack.push(item.texture);
            this._redoStack = [];
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
                  if (this._isRainbowStroke) {
                    tex.isRainbow = true;
                    this._startRainbowAnimationLoop();
                  }
                  void this.shareFinishedStroke(tex);
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
                if (this._isRainbowStroke) {
                  tex.isRainbow = true;
                  this._startRainbowAnimationLoop();
                }
                void this.shareFinishedStroke(tex);
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
            this.markerTextures.push(item.texture);
            this._undoStack.push(item.texture);
            this._redoStack = [];
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

  // ── Brush cursor: a circle the size of the brush, wrapped onto the surface under the cursor ──
  /** Holds the lit paint preview (canvas) under the outline (svg); moved/faded/hidden as one. */
  private _cursorLayer: HTMLDivElement | null = null;
  private _cursorSvg: SVGSVGElement | null = null;
  private _cursorPaths: SVGPathElement[] = [];
  /** Lit preview of the paint inside the outline: the stroke's colour × the panorama's lighting. */
  private _cursorFill: HTMLCanvasElement | null = null;
  private _cursorFillColor: string | null = null;

  private ensureCursorSvg(): void {
    if (this._cursorLayer || !this._container) return;
    const layer = document.createElement("div");
    layer.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:12;overflow:visible";
    const fill = document.createElement("canvas");
    // Fully opaque: the preview looks exactly like the paint will once the stroke is released.
    fill.style.cssText = "position:absolute;left:0;top:0;display:none";
    layer.appendChild(fill);
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg") as SVGSVGElement;
    svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;overflow:visible";
    // dark halo under a white line so it's visible on any background
    for (const [stroke, width] of [["rgba(0,0,0,0.45)", 3], ["rgba(255,255,255,0.95)", 1.5]] as const) {
      const path = document.createElementNS(NS, "path") as SVGPathElement;
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", stroke);
      path.setAttribute("stroke-width", String(width));
      svg.appendChild(path);
      this._cursorPaths.push(path);
    }
    layer.appendChild(svg);
    this._container.appendChild(layer);
    this._cursorLayer = layer;
    this._cursorSvg = svg;
    this._cursorFill = fill;
  }

  /**
   * Show the brush outline at a screen point. radius = brush radius in screen px where a fresh
   * stroke would start. With depth data the circle is laid on the surface (ellipse on the ground
   * or an angled wall), matching how the stroke will actually land.
   * fillColor = paint colour to preview inside the outline, lit like a real stroke (shadow, sun,
   * surface texture); null = outline only (while drawing, rainbow, no colour).
   */
  updateBrushCursor(pixelX: number, pixelY: number, radius: number, fillColor: string | null = null): void {
    this.ensureCursorSvg();
    if (!this._cursorLayer) return;
    this._cursorFillColor = fillColor;
    if (this._cursorCameraMoved && this._cursorCenter && this._cursorLayer.style.display !== "none") {
      // The outline was pinned to the scene while the camera moved, so it's away from the pointer.
      // Glide it back (offset the layer by the old position, then transition the offset to zero).
      const [ox, oy] = this._cursorCenter;
      const svg = this._cursorLayer;
      svg.style.transition = "none";
      svg.style.transform = `translate(${(ox - pixelX).toFixed(1)}px, ${(oy - pixelY).toFixed(1)}px)`;
      void svg.getBoundingClientRect(); // commit the start position
      svg.style.transition = "transform 150ms cubic-bezier(0.2, 0.8, 0.2, 1)";
      svg.style.transform = "translate(0px, 0px)";
    }
    this._cursorCameraMoved = false;
    const N = 64;
    // Outline built in panorama (basic) coords on the surface under the pointer, then projected.
    const anchor: [number, number][] = [];
    const b = this.screenToBasic(pixelX, pixelY);
    if (b && this._deepData && this.isSkyAt(pixelX, pixelY)) this.shareCursorHide();
    else if (b) this.sendCursor(b, radius, fillColor);
    if (b && this._deepData && this.isSkyAt(pixelX, pixelY)) {
      // Can't paint on the sky: just a small faded dot (a circle would suggest a surface).
      this._cursorAnchor = { pts: [b], dot: true };
      this.reprojectBrushCursor(true);
      return;
    }
    if (b && this._deepData) {
      const radPerPx = ((this.currentFov * Math.PI) / 180) / Math.max(1, this.canvas.height);
      const decal = SurfaceDecal.create(this._deepData, b[0], b[1], radPerPx);
      if (decal) {
        // walk the ring out along the real surface so it rides over bumps/corners like the paint
        // mid-stroke, show the size the active stroke will actually paint at here
        const basis = decal.basis;
        const s = this._activeDecal?.geo.worldPerPxAt(b[0], b[1]) ?? basis.s;
        anchor.push(...surfaceRing(this._deepData, basis, radius * s, N));
      }
    }
    if (!anchor.length) {
      // no depth data: a screen circle, still pinned via its panorama coords when available
      for (let k = 0; k <= N; k++) {
        const a = (k / N) * Math.PI * 2;
        const pb = this.screenToBasic(pixelX + Math.cos(a) * radius, pixelY + Math.sin(a) * radius);
        if (!pb) {
          this._cursorAnchor = null;
          this.drawCursorFill(null);
          this.drawCursorPath(this.circlePath(pixelX, pixelY, radius), false);
          return;
        }
        anchor.push(pb);
      }
    }
    this._cursorAnchor = { pts: anchor, dot: false };
    this.reprojectBrushCursor(true);
  }

  private _cursorAnchor: { pts: [number, number][]; dot: boolean } | null = null;

  /** Set when the camera moved since the last mouse move (the outline drifted off the pointer). */
  private _cursorCameraMoved = false;
  /** Screen centre of the outline as last drawn (for the glide back to the pointer). */
  private _cursorCenter: [number, number] | null = null;

  /**
   * Redraw the brush outline from its panorama coords. Called on mouse move (show = true) and
   * whenever the camera moves (only while the cursor is showing).
   */
  private reprojectBrushCursor(show = false): void {
    const a = this._cursorAnchor;
    if (!a || !this._cursorLayer) return;
    if (!show && this._cursorLayer.style.display === "none") return;
    const sync = this.getSyncProjectionContext();
    if (!sync) return;
    // project each point; skip the few that can't be projected rather than blanking the cursor
    let d = "";
    let pen = false;
    let shown = 0;
    let first: [number, number] | null = null;
    const screen: [number, number][] = [];
    for (const p of a.pts) {
      let sp: number[] | null = null;
      try {
        sp = sync.proj.basicToCanvas(p, sync.container, sync.renderCamera, sync.transform);
      } catch {
        sp = null;
      }
      if (!sp) {
        pen = false;
        continue;
      }
      if (!first) first = [sp[0], sp[1]];
      screen.push([sp[0], sp[1]]);
      d += `${pen ? "L" : "M"}${sp[0].toFixed(1)},${sp[1].toFixed(1)}`;
      pen = true;
      shown++;
    }
    if (!first) {
      // whole outline is behind the camera: hide just the shape (next mouse move brings it back)
      for (const path of this._cursorPaths) path.setAttribute("d", "");
      this.drawCursorFill(null);
      return;
    }
    if (a.dot) {
      this._cursorCenter = first;
      this.drawCursorFill(null);
      this.drawCursorPath(this.circlePath(first[0], first[1], 1.5), true);
    } else {
      // centre = average of the projected outline points
      let cx = 0, cy = 0, n = 0;
      for (const m of d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)) { cx += +m[1]; cy += +m[2]; n++; }
      this._cursorCenter = n ? [cx / n, cy / n] : first;
      this.drawCursorFill(shown === a.pts.length ? screen : null);
      this.drawCursorPath(shown === a.pts.length ? d + "Z" : d, false);
    }
  }

  /**
   * Fill the outline polygon (screen px) with the paint colour and light it per pixel with the
   * same surface map and shadeRegion as live strokes, so the preview darkens and cools in shadow,
   * warms in sun and picks up the surface texture — before anything is drawn.
   */
  private drawCursorFill(poly: [number, number][] | null): void {
    const canvas = this._cursorFill;
    if (!canvas) return;
    const color = this._cursorFillColor;
    if (!poly || poly.length < 3 || !color || color === "rainbow") {
      canvas.style.display = "none";
      return;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    x0 = Math.floor(x0) - 1; y0 = Math.floor(y0) - 1; x1 = Math.ceil(x1) + 1; y1 = Math.ceil(y1) + 1;
    const w = x1 - x0, h = y1 - y0;
    if (w < 3 || h < 3 || w * h > 600 * 600) { canvas.style.display = "none"; return; }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.ceil(w * dpr), ch = Math.ceil(h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.style.transform = `translate(${x0}px, ${y0}px)`;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.setTransform(dpr, 0, 0, dpr, -x0 * dpr, -y0 * dpr);
    ctx.fillStyle = color;
    ctx.beginPath();
    poly.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const surface = this._deepShade;
    if (surface) {
      // coarse screen -> panorama grid over the box, interpolated per pixel inside shadeRegion
      const G = 6;
      const grid: ([number, number] | null)[][] = [];
      for (let r = 0; r <= G; r++) {
        const row: ([number, number] | null)[] = [];
        for (let c = 0; c <= G; c++) row.push(this.screenToBasic(x0 + (c / G) * w, y0 + (r / G) * h));
        grid.push(row);
      }
      shadeRegion(ctx, 0, 0, cw, ch, grid, surface);
    }
    canvas.style.display = "";
  }

  private circlePath(x: number, y: number, r: number): string {
    return `M${(x - r).toFixed(1)},${y.toFixed(1)}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`;
  }

  /** Update the outline; `disabled` = faded (e.g. the dot over the sky, where you can't paint). */
  private drawCursorPath(d: string, disabled: boolean): void {
    if (!this._cursorSvg) return;
    for (const path of this._cursorPaths) {
      path.setAttribute("d", d);
      path.removeAttribute("stroke-dasharray");
    }
    if (!this._cursorLayer) return;
    this._cursorLayer.style.opacity = disabled ? "0.6" : "1";
    this._cursorLayer.style.display = "";
  }

  hideBrushCursor(): void {
    this.shareCursorHide();
    if (this._cursorLayer) this._cursorLayer.style.display = "none";
  }

  /** Build a surface decal for a stroke starting at this screen point (null = draw flat). */
  private makeDecal(pixelX: number, pixelY: number, worldPerPx?: number): DecalState | null {
    const why = (r: string) => {
      if (import.meta.env.DEV && (globalThis as { __deepDebug?: boolean }).__deepDebug) console.info(`[deep] flat @${pixelX | 0},${pixelY | 0}: ${r}`);
      return null;
    };
    if (!this._deepData) return why("no deep data");
    if (!this.canDrawDecals()) return why("no GPU support");
    const b = this.screenToBasic(pixelX, pixelY);
    if (!b) return why("no projection");
    const radPerPx = ((this.currentFov * Math.PI) / 180) / Math.max(1, this.canvas.height);
    const st = startPiece(this._deepData, b, radPerPx, worldPerPx, false, this._strokeParams!, Math.floor(Math.random() * 2 ** 31), this._strokeGroup, this.currentFov);
    if (!st) return why("no surface (sky)");
    st.prev.screen = [pixelX, pixelY];
    if (import.meta.env.DEV && (globalThis as { __deepDebug?: boolean }).__deepDebug) console.info(`[deep] wrap @${pixelX | 0},${pixelY | 0}${worldPerPx ? " (chained)" : ""}`);
    return st;
  }

  private canDrawDecals(): boolean {
    return !!(this._deepData && this.useWebGL && this.webglRenderer?.hasGPUProjection() && this.webglRenderer.hasDeepStrokes());
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

  private releaseDecal(st: DecalState): void {
    this.webglRenderer?.releaseDeepStroke(st.geo);
    st.geo.release();
  }

  /** End a piece: bake it now (it's small), free its surface map, keep the picture on screen. */
  private endPiece(st: DecalState): void {
    this.paintTrack(st);
    this.flushStrokeSamples(true);
    this.broadcastStrokeEnd();
    const piece = bakePiece(st);
    if (piece) this._pieces.push({ piece, tex: pieceTexture(piece, st) });
    this.releaseDecal(st);
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
    this.markerTextures.push(tex);
    this._undoStack.push(tex);
    this._redoStack = [];
    this.onHistoryChange?.();
    void this.shareFinishedStroke(tex);
    this.render();
  }

  /** Everything baked that's on screen: finished strokes, then pieces of strokes in progress. */
  private drawList(): MarkerTexture[] {
    const extra: MarkerTexture[] = [];
    for (const list of this._replays.values()) for (const r of list) if (r.tex) extra.push(r.tex);
    for (const p of this._pieces) extra.push(p.tex);
    return extra.length ? [...this.markerTextures, ...extra] : this.markerTextures;
  }

  /** Live (in-progress) 3D strokes to draw this frame. */
  private liveDecals(): DecalState[] {
    const out: DecalState[] = [];
    for (const list of this._replays.values()) for (const r of list) if (!r.ended && !r.dead && r.st.hasPaint) out.push(r.st);
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

  canUndo(): boolean {
    return this._undoStack.length > 0;
  }

  canRedo(): boolean {
    return this._redoStack.length > 0;
  }

  /** Undo the last stroke — all of its pieces if it crossed several surfaces. */
  undo(): void {
    const top = this._undoStack[this._undoStack.length - 1];
    if (isEraseEdit(top)) {
      this._undoStack.pop();
      this.applyEraseEdit(top, true);
      this._redoStack.push(top);
      return;
    }
    const group = top?.strokeGroup;
    do {
      this.undoOne();
    } while (group !== undefined && this._undoStack[this._undoStack.length - 1]?.strokeGroup === group);
  }

  private undoOne(): void {
    if (isEraseEdit(this._undoStack[this._undoStack.length - 1])) return;
    const tex = this._undoStack.pop() as MarkerTexture | undefined;
    if (!tex) return;
    // Remove drips/splashes belonging to this stroke
    if (tex.brushStrokeId) {
      this.activeDrops = this.activeDrops.filter(
        (d) => d.strokeId !== tex.brushStrokeId,
      );
      this.activeSplashes = this.activeSplashes.filter(
        (s) => !s.strokeId || s.strokeId !== tex.brushStrokeId,
      );
    }

    // Remove from markerTextures
    const idx = this.markerTextures.indexOf(tex);
    if (idx > -1) this.markerTextures.splice(idx, 1);

    // Free WebGL texture
    if (this.webglRenderer) {
      this.webglRenderer.invalidateTexture(texSource(tex));
    }

    this.broadcastEraseStrokes([tex]);

    this._redoStack.push(tex);
    this.render();
  }

  redo(): void {
    const top = this._redoStack[this._redoStack.length - 1];
    if (isEraseEdit(top)) {
      this._redoStack.pop();
      this.applyEraseEdit(top, false);
      this._undoStack.push(top);
      return;
    }
    const group = top?.strokeGroup;
    do {
      this.redoOne();
    } while (group !== undefined && this._redoStack[this._redoStack.length - 1]?.strokeGroup === group);
  }

  private redoOne(): void {
    if (isEraseEdit(this._redoStack[this._redoStack.length - 1])) return;
    const tex = this._redoStack.pop() as MarkerTexture | undefined;
    if (!tex) return;

    // Re-add to markerTextures
    this.markerTextures.push(tex);
    this._undoStack.push(tex);

    // put it back for everyone in the live room (same id)
    void this.shareFinishedStroke(tex);

    this.render();
  }

  // ── Eraser: a brush that rubs out our own paint ──
  // The eraser footprint is the same surface-wrapped ring as the brush cursor. Each stamp is
  // mapped into the bitmaps of our strokes underneath and cut out (destination-out). One
  // gesture = one undo step; trimmed strokes are re-shared with the room under the same id.
  private _eraseSession: EraseEdit | null = null;
  private _lastErase: [number, number] | null = null;
  private _lastEraseShare = 0;

  eraseAt(pixelX: number, pixelY: number, radius = 12): void {
    if (!this.viewer) return;
    // stamp along the path since the last point, so fast moves leave no gaps
    const last = this._lastErase;
    const dist = last ? Math.hypot(pixelX - last[0], pixelY - last[1]) : 0;
    const steps = last ? Math.min(40, Math.max(1, Math.ceil(dist / (radius * 0.4)))) : 1;
    let changed = false;
    for (let k = 1; k <= steps; k++) {
      const x = last ? last[0] + ((pixelX - last[0]) * k) / steps : pixelX;
      const y = last ? last[1] + ((pixelY - last[1]) * k) / steps : pixelY;
      const ring = this.eraserFootprint(x, y, radius);
      if (ring && this.eraseFootprint(ring)) changed = true;
    }
    this._lastErase = [pixelX, pixelY];
    if (!changed) return;
    this.render();
    // others watch it get rubbed out (a few times a second; the final state goes on release)
    const now = performance.now();
    if (now - this._lastEraseShare > 400 && this._eraseSession) {
      this._lastEraseShare = now;
      for (const tex of this._eraseSession.items.keys()) if (this.markerTextures.includes(tex)) void this.shareFinishedStroke(tex);
    }
  }

  /** The eraser outline at a screen point, in panorama coords (on the surface when we have depth). */
  private eraserFootprint(x: number, y: number, radius: number): [number, number][] | null {
    const b = this.screenToBasic(x, y);
    if (!b) return null;
    if (this._deepData) {
      const radPerPx = ((this.currentFov * Math.PI) / 180) / Math.max(1, this.canvas.height);
      const decal = SurfaceDecal.create(this._deepData, b[0], b[1], radPerPx);
      if (decal) return surfaceRing(this._deepData, decal.basis, radius * decal.basis.s, 32);
    }
    const ring: [number, number][] = [];
    for (let k = 0; k <= 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      const p = this.screenToBasic(x + Math.cos(a) * radius, y + Math.sin(a) * radius);
      if (p) ring.push(p);
    }
    return ring.length > 8 ? ring : null;
  }

  /** Cut one footprint out of every own stroke under it. True if anything was touched. */
  private eraseFootprint(ring: [number, number][]): boolean {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [u, v] of ring) {
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const cu = (u0 + u1) / 2;
    let touched = false;
    for (const tex of this.markerTextures) {
      if (!tex.isLocal) continue;
      const box = eraseBox(tex);
      // compare with the footprint shifted by whole turns towards the stroke (panorama seam)
      const shift = Math.round((box[0] + box[2]) / 2 - cu);
      if (u1 + shift < box[0] || u0 + shift > box[2] || v1 < box[1] || v0 > box[3]) continue;
      const pts: [number, number][] = [];
      for (const [u, v] of ring) {
        const t = basicToTex(tex, u + shift, v);
        if (t) pts.push(t);
      }
      if (pts.length < 3) continue;
      // first touch in this gesture: keep the pixels for undo
      const session = (this._eraseSession ??= { kind: "erase", items: new Map() });
      if (!session.items.has(tex)) {
        if (!tex.canvas && this.webglRenderer) this.webglRenderer.invalidateTexture(texSource(tex));
        session.items.set(tex, { before: copyCanvas(ensureCanvas(tex)), removed: false });
      }
      const canvas = tex.canvas!;
      const ctx = canvas.getContext("2d")!;
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      if (this.webglRenderer) this.webglRenderer.invalidateTexture(canvas);
      touched = true;
    }
    return touched;
  }

  /**
   * End of an eraser gesture: strokes rubbed out completely are removed, the rest are re-shared
   * trimmed; the whole gesture becomes one undo step.
   */
  finalizeEraser(): void {
    this._lastErase = null;
    const session = this._eraseSession;
    this._eraseSession = null;
    if (!session) return;
    const removed: MarkerTexture[] = [];
    for (const [tex, item] of session.items) {
      if (!tex.canvas) continue;
      item.after = copyCanvas(tex.canvas);
      if (isBlank(tex.canvas)) {
        item.removed = true;
        removed.push(tex);
        const i = this.markerTextures.indexOf(tex);
        if (i > -1) this.markerTextures.splice(i, 1);
        if (this.webglRenderer) this.webglRenderer.invalidateTexture(tex.canvas);
      } else {
        void this.shareFinishedStroke(tex);
      }
    }
    if (removed.length) this.broadcastEraseStrokes(removed);
    this._undoStack.push(session);
    this._redoStack = [];
    this.render();
  }

  /** Put an erase gesture's strokes back to before (undo) or after (redo) it. */
  private applyEraseEdit(edit: EraseEdit, undo: boolean): void {
    const gone: MarkerTexture[] = [];
    for (const [tex, item] of edit.items) {
      const src = undo ? item.before : item.after;
      if (!src || !tex.canvas) continue;
      const ctx = tex.canvas.getContext("2d")!;
      ctx.clearRect(0, 0, tex.canvas.width, tex.canvas.height);
      ctx.drawImage(src, 0, 0);
      if (this.webglRenderer) this.webglRenderer.invalidateTexture(tex.canvas);
      const shown = this.markerTextures.includes(tex);
      if (item.removed && !undo) {
        if (shown) this.markerTextures.splice(this.markerTextures.indexOf(tex), 1);
        gone.push(tex);
        continue;
      }
      if (!shown) this.markerTextures.push(tex);
      void this.shareFinishedStroke(tex);
    }
    if (gone.length) this.broadcastEraseStrokes(gone);
    this.render();
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

    for (const tex of this.markerTextures) {
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

    for (const tex of this.markerTextures) {
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
      const hasRainbow = this.markerTextures.some((t) => t.isRainbow);
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
    this._cursorLayer?.remove();
    this._cursorLayer = null;
    this.peers.dispose();
    this._cursorSvg = null;
    this._cursorFill = null;
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
    this.leaveRealtime();

    // Clean up RxJS subscriptions
    for (const sub of this._internalSubs) {
      sub.unsubscribe();
    }
    this._internalSubs = [];

    // Remove viewer event listeners
    for (const off of this._boundViewerListeners) off();
    this._boundViewerListeners = [];

    // Clean up texture canvases to free memory
    for (const tex of this.markerTextures) {
      if (tex.canvas) {
        tex.canvas.width = 0;
        tex.canvas.height = 0;
      }
    }
    this.markerTextures = [];
    this._undoStack = [];
    this._redoStack = [];

    if (this.webglRenderer) {
      this.webglRenderer.dispose();
    }
    if (this._boundResize) {
      window.removeEventListener("resize", this._boundResize);
    }
    this.canvas.remove();
  }
}
