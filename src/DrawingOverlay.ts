import type { Viewer } from "mapillary-js";
import {
  WebGLDrawingRenderer,
  type GPUProjectionUniforms,
} from "./WebGLDrawingRenderer";
import rough from "roughjs";
import getStroke from "perfect-freehand";
import { supabase, LOCAL_MODE } from "./supabaseClient";
import { deviceId } from "./inkManager";
import { applyShading, shadeRegion } from "./deep/strokeShading";
import { SurfaceDecal, loadDeepData, surfaceRing, type DeepData } from "./deep/surfaceDecal";
import { GeodesicMap } from "./deep/geodesicMap";
import { realtime } from "./realtime/client";
import type { CursorState, FinishedStroke, ServerMessage } from "../shared/realtime";

/** Resolve 'rainbow' into a concrete CSS color using the same continuous
 *  hue rotation as the GPU shader (Date.now() / 20 → degrees). */
function resolveRainbowColor(): string {
  const hue = (Date.now() / 20) % 360;
  return `hsl(${hue}, 90%, 55%)`;
}

/** Get the current hue-shift value (0..1) for rainbow texture animation. */
function getRainbowHueShift(): number {
  return ((Date.now() / 20) % 360) / 360;
}

type Projector = (basic: [number, number]) => Promise<[number, number] | null>;
type Unprojector = (
  screen: [number, number],
) => Promise<[number, number] | null>;

interface SplashParticle {
  basicX: number;
  basicY: number;
  /** tool-space position, set when the brush paints in a fixed space (a 3D surface decal) */
  x?: number;
  y?: number;
  radius: number;
  life: number;
  color: string;
  strokeId?: string;
}

/** Small seeded PRNG (mulberry32): same seed -> same sequence on every device. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Hair {
  basicX: number = 0;
  basicY: number = 0;
  screenX: number = 0;
  screenY: number = 0;
  inkAmount: number = 7;
  color: string = "#000";
  initialized: boolean = false;
  history: [number, number][] = [];
  screenHistory: [number, number][] = [];

  constructor(
    basicX: number,
    basicY: number,
    screenX: number,
    screenY: number,
    inkAmount: number,
    color: string,
  ) {
    this.basicX = basicX;
    this.basicY = basicY;
    this.screenX = screenX;
    this.screenY = screenY;
    this.inkAmount = inkAmount;
    this.color = color;
    this.history = [[basicX, basicY]];
    this.screenHistory = [[screenX, screenY]];
    this.initialized = true;
  }

  // Fast screen-space render — used during active drawing (zero async calls)
  renderScreenSpace(ctx: CanvasRenderingContext2D, fovScale: number): void {
    if (!this.initialized || this.screenHistory.length < 2) return;

    ctx.save();
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.inkAmount * fovScale;
    ctx.beginPath();
    ctx.moveTo(this.screenHistory[0][0], this.screenHistory[0][1]);
    for (let i = 1; i < this.screenHistory.length; i++) {
      ctx.lineTo(this.screenHistory[i][0], this.screenHistory[i][1]);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Projected render — used only during finalization after stroke ends
  async render(
    ctx: CanvasRenderingContext2D,
    projector: Projector,
    fovScale: number,
  ): Promise<void> {
    if (!this.initialized || this.history.length < 2) return;

    const projectedPoints = await Promise.all(
      this.history.map((p) => projector(p)),
    );

    ctx.save();
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.inkAmount * fovScale;
    ctx.beginPath();

    let started = false;
    for (const pos of projectedPoints) {
      if (!pos) continue;
      if (!started) {
        ctx.moveTo(pos[0], pos[1]);
        started = true;
      } else {
        ctx.lineTo(pos[0], pos[1]);
      }
    }

    ctx.stroke();
    ctx.restore();
  }

  updatePosition(
    newBasicX: number,
    newBasicY: number,
    screenDx: number,
    screenDy: number,
  ): void {
    this.basicX = newBasicX;
    this.basicY = newBasicY;
    this.screenX += screenDx;
    this.screenY += screenDy;

    // No tight cap needed — screen-space rendering is O(n) canvas draws, very cheap
    this.history.push([newBasicX, newBasicY]);
    this.screenHistory.push([this.screenX, this.screenY]);
  }
}

class Drop {
  basicX: number = 0;
  basicY: number = 0;
  size: number = 7;
  color: string = "#000";
  strokeId: string | null = null;
  life: number = 0;
  private _xOffRatio: number = 0;
  history: [number, number][] = [];

  constructor(
    basicX: number,
    basicY: number,
    _screenX: number,
    _screenY: number,
    size: number,
    color: string,
    strokeId: string,
  ) {
    this.basicX = basicX;
    this.basicY = basicY;
    this.size = size;
    this.color = color;
    this.strokeId = strokeId;
    this.life = this.size * 1.5;
    this.history = [[basicX, basicY]];
  }

  updatePhysics(fovScale: number): void {
    // Stop physics once dried (life <= 0)
    if (this.life <= 0) return;

    if (Math.random() < 0.03) {
      this._xOffRatio += 0.06 * Math.random() - 0.03;
    } else if (Math.random() < 0.1) {
      this._xOffRatio *= 0.003;
    }

    // Apply physics directly in basic (spherical) coordinates
    // basicY increases = moves down in equirectangular space
    const basicDx = this.life * this._xOffRatio * 0.0005 * fovScale;
    const basicDy = this.life * 0.5 * Math.random() * 0.001 * fovScale;

    this.basicX += basicDx;
    this.basicY += basicDy;

    // Limit history growth but don't remove old points
    if (this.history.length < 50) {
      this.history.push([this.basicX, this.basicY]);
    }

    this.life -= 0.004; // ~3.5 second lifespan
  }

  async render(
    ctx: CanvasRenderingContext2D,
    projector: Projector,
    fovScale: number,
  ): Promise<void> {
    if (this.history.length < 2) return;

    const projectedPoints = await Promise.all(
      this.history.map((p) => projector(p)),
    );

    ctx.save();
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.strokeStyle = this.color;
    ctx.globalAlpha = Math.min(1, this.life); // Fade out like splashes
    ctx.lineWidth = (this.size + this.life * 0.3) * fovScale;
    ctx.beginPath();

    let started = false;
    for (const pos of projectedPoints) {
      if (!pos) continue;
      if (!started) {
        ctx.moveTo(pos[0], pos[1]);
        started = true;
      } else {
        ctx.lineTo(pos[0], pos[1]);
      }
    }

    ctx.stroke();
    ctx.restore();
  }
}

class Brush {
  private _SPLASHING_BRUSH_SPEED: number = 75;

  basicX: number = 0;
  basicY: number = 0;
  screenX: number = 0;
  screenY: number = 0;
  prevScreenX: number = 0;
  prevScreenY: number = 0;
  color: string = "#000";
  size: number = 35;
  inkAmount: number = 7;
  splashing: boolean = true;
  dripping: boolean = false; // drips off (splatters stay) — they looked wrong on 3D surfaces
  referenceFov: number = 90;
  /**
   * Painting in a fixed space (a 3D surface decal) instead of on screen: splatters stay at their
   * tool-space spot and are painted with the stroke (lit, on the surface, baked in for good).
   */
  fixedSpace = false;
  private _splashesMarked = 0;

  /** Splatters added since the last call (so the surface can be opened up for paint there). */
  takeNewSplashes(): SplashParticle[] {
    const out = this._splashes.slice(this._splashesMarked);
    this._splashesMarked = this._splashes.length;
    return out;
  }

  private _strokeId: string | null = null;
  private _tip: Hair[] = [];
  private _drops: Drop[] = [];
  private _splashes: SplashParticle[] = [];
  private _projector: Projector;
  private _unprojector: Unprojector;
  private _initialized: boolean = false;
  /** Per-stroke random source: seeded the same for the drawer and everyone watching, so a
   *  live replay of the stroke draws exactly what the drawer gets. */
  private _rand: () => number = Math.random;
  setSeed(seed: number): void {
    this._rand = mulberry32(seed);
  }

  minX: number = Infinity;
  minY: number = Infinity;
  maxX: number = -Infinity;
  maxY: number = -Infinity;

  constructor(
    screenX: number,
    screenY: number,
    color: string,
    projector: Projector,
    unprojector: Unprojector,
    size?: number,
    inkAmount?: number,
    referenceFov?: number,
  ) {
    this.screenX = screenX;
    this.screenY = screenY;
    this.prevScreenX = screenX;
    this.prevScreenY = screenY;
    this._projector = projector;
    this._unprojector = unprojector;
    if (color !== undefined) this.color = color;
    if (size !== undefined) this.size = size;
    if (inkAmount !== undefined) this.inkAmount = inkAmount;
    if (referenceFov !== undefined) this.referenceFov = referenceFov;

    this._drops = [];
    this._splashes = [];
    this._updateBounds(screenX, screenY);
  }

  async initialize(): Promise<void> {
    const basic = await this._unprojector([this.screenX, this.screenY]);
    if (basic) {
      this.basicX = basic[0];
      this.basicY = basic[1];
    }
    await this._resetTip();
    this._initialized = true;
  }

  private _updateBounds(x: number, y: number): void {
    const pad = this.size * 2;
    this.minX = Math.min(this.minX, x - pad);
    this.minY = Math.min(this.minY, y - pad);
    this.maxX = Math.max(this.maxX, x + pad);
    this.maxY = Math.max(this.maxY, y + pad);
  }

  getBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    return {
      minX: this.minX,
      minY: this.minY,
      maxX: this.maxX,
      maxY: this.maxY,
    };
  }

  isStroke(): boolean {
    return Boolean(this._strokeId);
  }

  getStrokeId(): string | null {
    return this._strokeId;
  }

  async startStroke(): Promise<void> {
    if (this.isStroke()) return;
    await this._resetTip();
    this._strokeId = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
      /[xy]/g,
      (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      },
    );
  }

  endStroke(): void {
    this._strokeId = null;
  }

  hasActiveDrops(): boolean {
    return (
      this._drops.some((d) => d.life > 0) ||
      this._splashes.some((s) => s.life > 0)
    );
  }

  extractDrops(): Drop[] {
    const drops = this._drops;
    this._drops = [];
    return drops;
  }

  extractSplashes(): SplashParticle[] {
    const splashes = this._splashes;
    this._splashes = [];
    return splashes;
  }

  async render(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    currentFov: number,
  ): Promise<void> {
    if (!this._initialized) return;

    const isStroke = this.isStroke();
    const fovScale = this.referenceFov / currentFov;

    this.prevScreenX = this.screenX;
    this.prevScreenY = this.screenY;
    this.screenX = x;
    this.screenY = y;
    this._updateBounds(x, y);

    const newBasic = await this._unprojector([x, y]);
    const prevBasic: [number, number] = [this.basicX, this.basicY];
    if (newBasic) {
      this.basicX = newBasic[0];
      this.basicY = newBasic[1];
    }

    // Batch splash projections for performance
    if (this._splashes.length > 0) {
      const splashPositions = this.fixedSpace
        ? this._splashes.map((s) => [s.x!, s.y!] as [number, number])
        : await Promise.all(this._splashes.map((s) => this._projector([s.basicX, s.basicY])));

      for (let i = 0; i < this._splashes.length; i++) {
        const splash = this._splashes[i];
        const pos = splashPositions[i];
        // DON'T decrement life here - only decrement after extraction in startRenderLoop
        if (pos && splash.life > 0) {
          this._updateBounds(pos[0], pos[1]);
          ctx.save();
          ctx.fillStyle = this.color;
          ctx.globalAlpha = Math.min(1, splash.life);
          ctx.beginPath();
          ctx.arc(pos[0], pos[1], splash.radius * fovScale, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    }

    // Batch drop position projections and update physics
    if (this._drops.length) {
      const drops = this._drops;
      const sizeSq = this.size * this.size * fovScale * fovScale;

      // Update physics first (doesn't need projection)
      for (const drop of drops) {
        drop.updatePhysics(fovScale);
      }

      // Batch project drop positions for collision check
      const dropPositions = await Promise.all(
        drops.map((d) => this._projector([d.basicX, d.basicY])),
      );

      // Filter drops that collide with brush, render the rest
      for (let i = drops.length - 1; i >= 0; i--) {
        const drop = drops[i];
        const dropPos = dropPositions[i];

        if (dropPos) {
          this._updateBounds(dropPos[0], dropPos[1]);
          const dx = this.screenX - dropPos[0];
          const dy = this.screenY - dropPos[1];

          if (
            isStroke &&
            sizeSq > dx * dx + dy * dy &&
            this._strokeId !== drop.strokeId
          ) {
            drops.splice(i, 1);
            continue;
          }
        }

        await drop.render(ctx, this._projector, fovScale);
      }
    }

    if (isStroke) {
      const dx = this.screenX - this.prevScreenX;
      const dy = this.screenY - this.prevScreenY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (this.splashing && dist > this._SPLASHING_BRUSH_SPEED) {
        const maxNum = ((dist - this._SPLASHING_BRUSH_SPEED) * 0.5) | 0;
        const numSplashes = (maxNum * this._rand()) | 0;

        if (numSplashes > 0) {
          // Prepare all splash screen positions
          const splashScreenPositions: {
            sx: number;
            sy: number;
            sr: number;
          }[] = [];
          for (let i = 0; i < numSplashes; i++) {
            const r = (dist - 1) * this._rand() + 1;
            const a = Math.PI * 2 * this._rand();
            const sr = 5 * this._rand() * fovScale;
            const sx = this.screenX + r * Math.sin(a);
            const sy = this.screenY + r * Math.cos(a);
            this._updateBounds(sx, sy);
            splashScreenPositions.push({ sx, sy, sr });
          }

          if (this.fixedSpace) {
            for (const p of splashScreenPositions)
              this._splashes.push({ basicX: 0, basicY: 0, x: p.sx, y: p.sy, radius: p.sr, life: 1, color: this.color, strokeId: this._strokeId || undefined });
          }
          // Batch unproject all splash positions
          const basicPositions = this.fixedSpace ? [] : await Promise.all(
            splashScreenPositions.map((p) => this._unprojector([p.sx, p.sy])),
          );

          // Create splashes from results
          for (let i = 0; i < splashScreenPositions.length; i++) {
            const basic = basicPositions[i];
            if (basic) {
              this._splashes.push({
                basicX: basic[0],
                basicY: basic[1],
                radius: splashScreenPositions[i].sr,
                life: 1,
                color: this.color,
                strokeId: this._strokeId || undefined,
              });
            }
          }
        }
      } else if (
        this.dripping &&
        dist < this.inkAmount * 2 &&
        this._rand() < 0.05
      ) {
        const dropBasic = await this._unprojector([this.screenX, this.screenY]);
        if (dropBasic) {
          this._drops.push(
            new Drop(
              dropBasic[0],
              dropBasic[1],
              this.screenX,
              this.screenY,
              (this.size + this.inkAmount) *
                0.5 *
                ((0.25 - 0.1) * this._rand() + 0.1) *
                fovScale,
              this.color,
              this._strokeId!,
            ),
          );
        }
      }

      const basicDx = this.basicX - prevBasic[0];
      const basicDy = this.basicY - prevBasic[1];
      const screenDx = this.screenX - this.prevScreenX;
      const screenDy = this.screenY - this.prevScreenY;

      for (const hair of this._tip) {
        hair.updatePosition(
          hair.basicX + basicDx,
          hair.basicY + basicDy,
          screenDx,
          screenDy,
        );
      }
    }

    // Always use screen-space rendering — avoids visual jump between
    // active stroke and finalization (projected render produces slight
    // position/thickness differences). Projection is unnecessary since
    // the camera hasn't moved.
    for (const hair of this._tip) {
      hair.renderScreenSpace(ctx, fovScale);
    }
  }

  dispose(): void {
    this._tip.length = 0;
    this._drops.length = 0;
    this._splashes.length = 0;
  }

  /** Update the brush color and propagate to all hair/splash/drop objects. */
  updateColor(newColor: string): void {
    this.color = newColor;
    for (const hair of this._tip) hair.color = newColor;
    for (const splash of this._splashes) splash.color = newColor;
    for (const drop of this._drops) drop.color = newColor;
  }

  private async _resetTip(): Promise<void> {
    const tip: Hair[] = [];
    this._tip = tip;

    const rad = this.size * 0.5;
    const a1 = Math.PI * 2 * this._rand();
    let len = ((rad * rad * Math.PI) / this.inkAmount) | 0;
    if (len < 1) len = 1;

    const hairPromises: Promise<Hair | null>[] = [];

    for (let i = 0; i < len; i++) {
      const x0 = rad * this._rand();
      const y0 = x0 * 0.5;
      const a0 = Math.PI * 2 * this._rand();
      const x1 = x0 * Math.sin(a0);
      const y1 = y0 * Math.cos(a0);
      const cv = Math.cos(a1);
      const sv = Math.sin(a1);

      const screenX = this.screenX + x1 * cv - y1 * sv;
      const screenY = this.screenY + x1 * sv + y1 * cv;

      hairPromises.push(
        this._unprojector([screenX, screenY]).then((basic) => {
          if (basic) {
            return new Hair(
              basic[0],
              basic[1],
              screenX,
              screenY,
              this.inkAmount,
              this.color,
            );
          }
          return null;
        }),
      );
    }

    const hairs = await Promise.all(hairPromises);
    for (const hair of hairs) {
      if (hair) tip.push(hair);
    }
  }
}

// ── Pencil grain: real scanned paper (David Revoy, CC0) as the graphite's tooth ──
type PencilLook = { src: string; scale: number; lo: number; hi: number; floor: number; width: number };
/** Bold graphite on speckled drawing paper (chosen over softer/fibre variants, Nov 2026). */
const PENCIL_LOOK: PencilLook = { src: "/textures/paper-grain.png", scale: 0.35, lo: 0.3, hi: 0.7, floor: 0.12, width: 1.0 };
function pencilLook(): PencilLook {
  return PENCIL_LOOK;
}
const _grainMasks = new Map<string, HTMLCanvasElement | null>();
/** The look's grain as an alpha mask pattern (null until the texture has loaded). */
function pencilGrain(ctx: CanvasRenderingContext2D, look: PencilLook): CanvasPattern | null {
  const key = `${look.src}|${look.lo}|${look.hi}|${look.floor}`;
  if (!_grainMasks.has(key)) {
    _grainMasks.set(key, null);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < d.data.length; i += 4) {
        // bright = paper peak = graphite catches; dark = valley = paper shows through
        const v = d.data[i] / 255;
        const t = Math.min(1, Math.max(0, (v - look.lo) / (look.hi - look.lo)));
        d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
        d.data[i + 3] = Math.round(255 * (look.floor + (1 - look.floor) * t * t * (3 - 2 * t)));
      }
      g.putImageData(d, 0, 0);
      _grainMasks.set(key, c);
    };
    img.src = look.src;
  }
  const mask = _grainMasks.get(key);
  if (!mask) return null;
  const pat = ctx.createPattern(mask, "repeat");
  if (!pat) return null;
  // patterns are anchored to user space at fill time, i.e. drawing-space 0,0 (the surface
  // decal), so the grain stays put under the pen
  pat.setTransform(new DOMMatrix([look.scale, 0, 0, look.scale, 0, 0]));
  return pat;
}

class Pen {
  basicX: number = 0;
  basicY: number = 0;
  screenX: number = 0;
  screenY: number = 0;
  prevScreenX: number = 0;
  prevScreenY: number = 0;
  color: string = "#000";
  size: number = 240;
  referenceFov: number = 90;

  private _strokeId: string | null = null;
  private _projector: Projector;
  private _unprojector: Unprojector;
  private _initialized: boolean = false;
  private _history: { basicX: number; basicY: number; width: number }[] = [];
  private _off: HTMLCanvasElement | null = null;
  setSeed(_seed: number): void {} // no randomness: the grain is fixed to the surface

  minX: number = Infinity;
  minY: number = Infinity;
  maxX: number = -Infinity;
  maxY: number = -Infinity;

  constructor(
    screenX: number,
    screenY: number,
    color: string,
    projector: Projector,
    unprojector: Unprojector,
    size?: number,
    referenceFov?: number,
  ) {
    this.screenX = screenX;
    this.screenY = screenY;
    this.prevScreenX = screenX;
    this.prevScreenY = screenY;
    this._projector = projector;
    this._unprojector = unprojector;
    if (color !== undefined) this.color = color;
    if (size !== undefined) this.size = size;
    if (referenceFov !== undefined) this.referenceFov = referenceFov;
    if (referenceFov !== undefined) this.referenceFov = referenceFov;
    this._updateBounds(screenX, screenY);
  }

  async initialize(): Promise<void> {
    const basic = await this._unprojector([this.screenX, this.screenY]);
    if (basic) {
      this.basicX = basic[0];
      this.basicY = basic[1];
      this._history.push({
        basicX: basic[0],
        basicY: basic[1],
        width: this.size,
      });
    }
    this._initialized = true;
  }

  private _updateBounds(x: number, y: number): void {
    const pad = this.size * 3;
    this.minX = Math.min(this.minX, x - pad);
    this.minY = Math.min(this.minY, y - pad);
    this.maxX = Math.max(this.maxX, x + pad);
    this.maxY = Math.max(this.maxY, y + pad);
  }

  getBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    return {
      minX: this.minX,
      minY: this.minY,
      maxX: this.maxX,
      maxY: this.maxY,
    };
  }

  isStroke(): boolean {
    return Boolean(this._strokeId);
  }

  startStroke(id: string): void {
    this._strokeId = id;
  }

  async render(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    currentFov: number,
  ): Promise<void> {
    if (!this._initialized) return;

    const isStroke = this.isStroke();
    const fovScale = this.referenceFov / currentFov;

    const dx = x - this.screenX;
    const dy = y - this.screenY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const velocity = distance;

    const minWidth = this.size * 0.8;
    const maxWidth = this.size * 1.2;
    const velocityFactor = Math.min(velocity / 60, 1);
    const currentWidth = maxWidth - (maxWidth - minWidth) * velocityFactor;

    this.prevScreenX = this.screenX;
    this.prevScreenY = this.screenY;
    this.screenX = x;
    this.screenY = y;
    this._updateBounds(x, y);

    if (isStroke) {
      const newBasic = await this._unprojector([x, y]);
      if (newBasic && distance > 1.5) {
        this.basicX = newBasic[0];
        this.basicY = newBasic[1];
        this._history.push({
          basicX: newBasic[0],
          basicY: newBasic[1],
          width: currentWidth,
        });
        if (this._history.length > 500) this._history.shift();
      }
    }

    if (this._history.length >= 2) {
      const projectedPoints = await Promise.all(
        this._history.map((p) => this._projector([p.basicX, p.basicY])),
      );

      const validPoints: [number, number][] = [];
      for (const p of projectedPoints) {
        if (p) validPoints.push([p[0], p[1]]);
      }

      if (validPoints.length >= 2) {
        const isDefaultColor =
          this.color === "#000000" || this.color === "black";
        const strokeColor = isDefaultColor ? "#333333" : this.color;
        const look = pencilLook();
        // Graphite: a steady line (width follows speed: slow = fuller), then masked by real paper
        // grain so the colour only catches on the paper's tooth. The grain is anchored to the
        // drawing space (the surface decal), so it never slides with the pen.
        const pts: [number, number, number][] = [];
        projectedPoints.forEach((p, i) => {
          if (p) pts.push([p[0], p[1], this._history[i].width * fovScale * look.width]);
        });
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y, w] of pts) {
          x0 = Math.min(x0, x - w); y0 = Math.min(y0, y - w);
          x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + w);
        }
        x0 = Math.floor(x0 - 2); y0 = Math.floor(y0 - 2);
        const w = Math.ceil(x1 + 2) - x0, h = Math.ceil(y1 + 2) - y0;
        if (w > 0 && h > 0 && w < 8192 && h < 8192) {
          const off = (this._off ??= document.createElement("canvas"));
          off.width = w;
          off.height = h;
          const o = off.getContext("2d")!;
          o.translate(-x0, -y0);
          o.strokeStyle = strokeColor;
          o.lineCap = o.lineJoin = "round";
          for (let i = 1; i < pts.length; i++) {
            o.lineWidth = (pts[i - 1][2] + pts[i][2]) / 2;
            o.beginPath();
            o.moveTo(pts[i - 1][0], pts[i - 1][1]);
            o.lineTo(pts[i][0], pts[i][1]);
            o.stroke();
          }
          const grain = pencilGrain(o, look);
          if (grain) {
            o.globalCompositeOperation = "destination-in";
            o.fillStyle = grain;
            o.fillRect(x0, y0, w, h);
          }
          ctx.drawImage(off, x0, y0);
        }
      }
    }
  }

  async renderSmooth(
    ctx: CanvasRenderingContext2D,
    _x: number,
    _y: number,
    currentFov: number,
  ): Promise<void> {
    if (!this._initialized || this._history.length < 2) return;

    const fovScale = this.referenceFov / currentFov;
    const projectedPoints = await Promise.all(
      this._history.map((p) => this._projector([p.basicX, p.basicY])),
    );

    const validPoints: [number, number][] = [];
    for (const p of projectedPoints) {
      if (p) validPoints.push([p[0], p[1]]);
    }
    if (validPoints.length < 2) return;

    const baseWidth = this._history[0].width * fovScale;

    ctx.save();
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = baseWidth * 0.6;
    ctx.beginPath();
    ctx.moveTo(validPoints[0][0], validPoints[0][1]);
    for (let i = 1; i < validPoints.length; i++) {
      ctx.lineTo(validPoints[i][0], validPoints[i][1]);
    }
    ctx.stroke();
    ctx.restore();
  }

  dispose(): void {
    this._history.length = 0;
  }

  /** Update the pen color and invalidate the rough.js cached drawable. */
  updateColor(newColor: string): void {
    this.color = newColor;
  }
}

/**
 * Chalk/crayon brush adapted from p5.js "Chalk Brush" by Kora-Lee.
 * Stamps a random-walk cloud of dots at each cursor position, creating
 * a grainy, dusty texture that mimics real chalk or crayon.
 * Same public interface as Pen so it can be used interchangeably.
 */
class ChalkBrush {
  basicX: number = 0;
  basicY: number = 0;
  screenX: number = 0;
  screenY: number = 0;
  prevScreenX: number = 0;
  prevScreenY: number = 0;
  color: string = "#000";
  size: number = 240;
  referenceFov: number = 90;

  private _strokeId: string | null = null;
  private _projector: Projector;
  private _unprojector: Unprojector;
  private _initialized: boolean = false;
  /** Per-stroke random source: seeded the same for the drawer and everyone watching, so a
   *  live replay of the stroke draws exactly what the drawer gets. */
  private _rand: () => number = Math.random;
  setSeed(seed: number): void {
    this._rand = mulberry32(seed);
  }
  private _history: { basicX: number; basicY: number; width: number }[] = [];

  private _offscreen: HTMLCanvasElement;
  private _offCtx: CanvasRenderingContext2D;
  private _lastStampX: number = -Infinity;
  private _lastStampY: number = -Infinity;

  minX: number = Infinity;
  minY: number = Infinity;
  maxX: number = -Infinity;
  maxY: number = -Infinity;

  constructor(
    screenX: number,
    screenY: number,
    color: string,
    projector: Projector,
    unprojector: Unprojector,
    size?: number,
    referenceFov?: number,
    canvasWidth?: number,
    canvasHeight?: number,
  ) {
    this.screenX = screenX;
    this.screenY = screenY;
    this.prevScreenX = screenX;
    this.prevScreenY = screenY;
    this._projector = projector;
    this._unprojector = unprojector;
    if (color !== undefined) this.color = color;
    if (size !== undefined) this.size = size;
    if (referenceFov !== undefined) this.referenceFov = referenceFov;

    this._offscreen = document.createElement("canvas");
    this._offscreen.width = canvasWidth || 1920;
    this._offscreen.height = canvasHeight || 1080;
    this._offCtx = this._offscreen.getContext("2d")!;

    this._updateBounds(screenX, screenY);
  }

  async initialize(): Promise<void> {
    const basic = await this._unprojector([this.screenX, this.screenY]);
    if (basic) {
      this.basicX = basic[0];
      this.basicY = basic[1];
      this._history.push({
        basicX: basic[0],
        basicY: basic[1],
        width: this.size,
      });
    }
    this._initialized = true;
  }

  private _updateBounds(x: number, y: number): void {
    const pad = this.size * 2;
    this.minX = Math.min(this.minX, x - pad);
    this.minY = Math.min(this.minY, y - pad);
    this.maxX = Math.max(this.maxX, x + pad);
    this.maxY = Math.max(this.maxY, y + pad);
  }

  getBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    return {
      minX: this.minX,
      minY: this.minY,
      maxX: this.maxX,
      maxY: this.maxY,
    };
  }

  isStroke(): boolean {
    return Boolean(this._strokeId);
  }

  startStroke(id: string): void {
    this._strokeId = id;
  }

  /**
   * Random-walk stamp — exact algorithm from p5.js Chalk Brush by Kora-Lee:
   * 2500 steps, start at (0, 2.2), step by random(-1,1), draw within r/2.
   */
  private _stamp(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    color: string,
  ): void {
    ctx.fillStyle = color;

    let currentX = 0;
    let currentY = 2.2;
    for (let d = 0; d <= 2500; d++) {
      if (
        currentX * currentX + currentY * currentY <
        (radius / 2) * (radius / 2)
      ) {
        ctx.beginPath();
        ctx.arc(cx + currentX, cy + currentY, 1, 0, Math.PI * 2);
        ctx.fill();
      }
      currentX += this._rand() * 2 - 1;
      currentY += this._rand() * 2 - 1;
    }
  }

  async render(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    currentFov: number,
  ): Promise<void> {
    if (!this._initialized) return;

    const isStroke = this.isStroke();
    const fovScale = this.referenceFov / currentFov;

    const dx = x - this.screenX;
    const dy = y - this.screenY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    this.prevScreenX = this.screenX;
    this.prevScreenY = this.screenY;
    this.screenX = x;
    this.screenY = y;
    this._updateBounds(x, y);

    if (isStroke) {
      const newBasic = await this._unprojector([x, y]);
      if (newBasic && distance > 1.5) {
        this.basicX = newBasic[0];
        this.basicY = newBasic[1];
        this._history.push({
          basicX: newBasic[0],
          basicY: newBasic[1],
          width: this.size,
        });
        if (this._history.length > 500) this._history.shift();
      }
    }

    const radius = this.size * fovScale * 8;
    const firstStamp = this._lastStampX === -Infinity;
    const stampDist = firstStamp
      ? 0
      : Math.sqrt((x - this._lastStampX) ** 2 + (y - this._lastStampY) ** 2);

    if (firstStamp || stampDist > 2) {
      if (firstStamp || stampDist < 4) {
        this._stamp(this._offCtx, x, y, radius, this.color);
      } else {
        const spacing = Math.max(2, radius / 6);
        const steps = Math.min(50, Math.max(1, Math.ceil(stampDist / spacing)));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const ix = this._lastStampX + (x - this._lastStampX) * t;
          const iy = this._lastStampY + (y - this._lastStampY) * t;
          this._stamp(this._offCtx, ix, iy, radius, this.color);
        }
      }
      this._lastStampX = x;
      this._lastStampY = y;
    }

    ctx.drawImage(this._offscreen, 0, 0);
  }

  async renderSmooth(
    ctx: CanvasRenderingContext2D,
    _x: number,
    _y: number,
    currentFov: number,
  ): Promise<void> {
    if (!this._initialized || this._history.length < 2) return;

    const fovScale = this.referenceFov / currentFov;
    const projectedPoints = await Promise.all(
      this._history.map((p) => this._projector([p.basicX, p.basicY])),
    );

    const validPoints: [number, number][] = [];
    for (const p of projectedPoints) {
      if (p) validPoints.push([p[0], p[1]]);
    }
    if (validPoints.length < 2) return;

    const baseWidth = this._history[0].width * fovScale;

    ctx.save();
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = baseWidth * 0.6;
    ctx.beginPath();
    ctx.moveTo(validPoints[0][0], validPoints[0][1]);
    for (let i = 1; i < validPoints.length; i++) {
      ctx.lineTo(validPoints[i][0], validPoints[i][1]);
    }
    ctx.stroke();
    ctx.restore();
  }

  dispose(): void {
    this._history.length = 0;
  }

  updateColor(newColor: string): void {
    this.color = newColor;
  }
}

// ---------------------------------------------------------------------------
// Watercolor brush — ported from p5.js "water colour" by BarneyCodes
// ---------------------------------------------------------------------------

interface Vec2 {
  x: number;
  y: number;
}

function vecSub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}
function vecAdd(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}
function vecMult(v: Vec2, s: number): Vec2 {
  return { x: v.x * s, y: v.y * s };
}
function vecMag(v: Vec2): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}
function vecSetMag(v: Vec2, m: number): Vec2 {
  const mag = vecMag(v);
  if (mag === 0) return { x: 0, y: 0 };
  return { x: (v.x / mag) * m, y: (v.y / mag) * m };
}
function vecRotate(v: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Cubic distribution biased toward center — makes edge deformation organic. */
function wcDistribute(x: number): number {
  return Math.pow((x - 0.5) * 1.58740105, 3) + 0.5;
}
function wcRand(rand: () => number): number {
  return wcDistribute(rand());
}

class WCPoly {
  vertices: Vec2[];
  modifiers: number[];
  readonly rand: () => number;

  constructor(vertices: Vec2[], modifiers?: number[], rand: () => number = Math.random) {
    this.vertices = vertices;
    this.rand = rand;
    if (modifiers) {
      this.modifiers = modifiers;
    } else {
      this.modifiers = vertices.map(() => 0.1 + this.rand() * 0.7);
    }
  }

  grow(): WCPoly {
    const grownVerts: Vec2[] = [];
    const grownMods: number[] = [];
    for (let i = 0; i < this.vertices.length; i++) {
      const j = (i + 1) % this.vertices.length;
      const v1 = this.vertices[i];
      const v2 = this.vertices[j];
      const mod = this.modifiers[i];

      const chmod = (m: number) => m + (wcRand(this.rand) - 0.5) * 0.1;

      grownVerts.push(v1);
      grownMods.push(chmod(mod));

      const segment = vecSub(v2, v1);
      const len = vecMag(segment);
      const scaled = vecMult(segment, wcRand(this.rand));
      const v = vecAdd(scaled, v1);

      const rotated = vecRotate(segment, -Math.PI / 2 + (wcRand(this.rand) - 0.5) * Math.PI / 4);
      const displaced = vecSetMag(rotated, wcRand(this.rand) * len / 2 * mod);
      v.x += displaced.x;
      v.y += displaced.y;

      grownVerts.push(v);
      grownMods.push(chmod(mod));
    }
    return new WCPoly(grownVerts, grownMods, this.rand);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.vertices.length < 3) return;
    ctx.beginPath();
    ctx.moveTo(this.vertices[0].x, this.vertices[0].y);
    for (let i = 1; i < this.vertices.length; i++) {
      ctx.lineTo(this.vertices[i].x, this.vertices[i].y);
    }
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * Fountain pen brush — variable-width calligraphic strokes.
 * Thick on slow movement, thin on fast movement, with smooth tapering.
 * Uses perfect-freehand for smooth, pressure-sensitive stroke outlines.
 * Same public interface as Pen/ChalkBrush/WatercolorBrush.
 */
class FountainPenBrush {
  basicX: number = 0;
  basicY: number = 0;
  screenX: number = 0;
  screenY: number = 0;
  prevScreenX: number = 0;
  prevScreenY: number = 0;
  color: string = '#000';
  size: number = 240;
  referenceFov: number = 90;

  private _strokeId: string | null = null;
  private _projector: Projector;
  private _unprojector: Unprojector;
  private _initialized: boolean = false;
  setSeed(_seed: number): void {} // no randomness
  private _history: { basicX: number; basicY: number; width: number }[] = [];

  private _offscreen: HTMLCanvasElement;
  private _offCtx: CanvasRenderingContext2D;
  private _inputPoints: [number, number, number][] = []; // [x, y, pressure]

  minX: number = Infinity;
  minY: number = Infinity;
  maxX: number = -Infinity;
  maxY: number = -Infinity;

  constructor(
    screenX: number,
    screenY: number,
    color: string,
    projector: Projector,
    unprojector: Unprojector,
    size?: number,
    referenceFov?: number,
    canvasWidth?: number,
    canvasHeight?: number
  ) {
    this.screenX = screenX;
    this.screenY = screenY;
    this.prevScreenX = screenX;
    this.prevScreenY = screenY;
    this._projector = projector;
    this._unprojector = unprojector;
    if (color !== undefined) this.color = color;
    if (size !== undefined) this.size = size;
    if (referenceFov !== undefined) this.referenceFov = referenceFov;

    this._offscreen = document.createElement('canvas');
    this._offscreen.width = canvasWidth || 1920;
    this._offscreen.height = canvasHeight || 1080;
    this._offCtx = this._offscreen.getContext('2d')!;

    this._updateBounds(screenX, screenY);
  }

  async initialize(): Promise<void> {
    const basic = await this._unprojector([this.screenX, this.screenY]);
    if (basic) {
      this.basicX = basic[0];
      this.basicY = basic[1];
      this._history.push({ basicX: basic[0], basicY: basic[1], width: this.size });
    }
    this._initialized = true;
  }

  private _updateBounds(x: number, y: number): void {
    const pad = this.size * 20;
    this.minX = Math.min(this.minX, x - pad);
    this.minY = Math.min(this.minY, y - pad);
    this.maxX = Math.max(this.maxX, x + pad);
    this.maxY = Math.max(this.maxY, y + pad);
  }

  getBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    return { minX: this.minX, minY: this.minY, maxX: this.maxX, maxY: this.maxY };
  }

  isStroke(): boolean {
    return Boolean(this._strokeId);
  }

  startStroke(id: string): void {
    this._strokeId = id;
  }

  private _drawStroke(): void {
    const ctx = this._offCtx;
    ctx.clearRect(0, 0, this._offscreen.width, this._offscreen.height);

    if (this._inputPoints.length < 1) return;

    const fovScale = this.referenceFov / 90;
    const strokeSize = this.size * fovScale * 6;

    const outlinePoints = getStroke(this._inputPoints, {
      size: strokeSize,
      thinning: 0.9,
      smoothing: 0.5,
      streamline: 0.5,
      simulatePressure: true,
      start: { taper: strokeSize * 2, cap: true },
      end: { taper: strokeSize * 0.5, cap: false },
    });

    if (outlinePoints.length < 2) return;

    ctx.fillStyle = this.color;
    ctx.beginPath();

    const [firstPt, secondPt] = outlinePoints;
    ctx.moveTo(firstPt[0], firstPt[1]);
    ctx.quadraticCurveTo(firstPt[0], firstPt[1],
      (firstPt[0] + secondPt[0]) / 2, (firstPt[1] + secondPt[1]) / 2);

    let p0 = secondPt;
    for (let i = 2; i < outlinePoints.length; i++) {
      const p1 = outlinePoints[i];
      ctx.quadraticCurveTo(p0[0], p0[1], (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2);
      p0 = p1;
    }

    ctx.closePath();
    ctx.fill();
  }

  async render(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    currentFov: number
  ): Promise<void> {
    if (!this._initialized) return;

    const isStroke = this.isStroke();
    const fovScale = this.referenceFov / currentFov;

    const dx = x - this.screenX;
    const dy = y - this.screenY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    this.prevScreenX = this.screenX;
    this.prevScreenY = this.screenY;
    this.screenX = x;
    this.screenY = y;
    this._updateBounds(x, y);

    if (isStroke && distance > 1) {
      const newBasic = await this._unprojector([x, y]);
      if (newBasic) {
        this.basicX = newBasic[0];
        this.basicY = newBasic[1];

        this._inputPoints.push([x, y, 0.5]);

        const strokeWidth = this.size * fovScale * 6;
        this._history.push({
          basicX: newBasic[0],
          basicY: newBasic[1],
          width: strokeWidth,
        });
        if (this._history.length > 500) this._history.shift();
        if (this._inputPoints.length > 500) this._inputPoints.shift();

        this._drawStroke();
      }
    }

    ctx.drawImage(this._offscreen, 0, 0);
  }

  async renderSmooth(
    ctx: CanvasRenderingContext2D,
    _x: number,
    _y: number,
    currentFov: number
  ): Promise<void> {
    if (!this._initialized || this._history.length < 2) return;

    const fovScale = this.referenceFov / currentFov;
    const projectedPoints = await Promise.all(
      this._history.map((p) => this._projector([p.basicX, p.basicY]))
    );

    const validPoints: [number, number, number][] = [];
    for (const p of projectedPoints) {
      if (p) validPoints.push([p[0], p[1], 0.5]);
    }
    if (validPoints.length < 2) return;

    const strokeSize = this._history[0].width * fovScale;

    const outlinePoints = getStroke(validPoints, {
      size: strokeSize,
      thinning: 0.9,
      smoothing: 0.5,
      streamline: 0.5,
      simulatePressure: true,
      start: { taper: strokeSize * 2, cap: true },
      end: { taper: strokeSize * 0.5, cap: false },
    });

    if (outlinePoints.length < 2) return;

    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();

    const [firstPt, secondPt] = outlinePoints;
    ctx.moveTo(firstPt[0], firstPt[1]);
    ctx.quadraticCurveTo(firstPt[0], firstPt[1],
      (firstPt[0] + secondPt[0]) / 2, (firstPt[1] + secondPt[1]) / 2);

    let p0 = secondPt;
    for (let i = 2; i < outlinePoints.length; i++) {
      const p1 = outlinePoints[i];
      ctx.quadraticCurveTo(p0[0], p0[1], (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2);
      p0 = p1;
    }

    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  dispose(): void {
    this._history.length = 0;
    this._inputPoints.length = 0;
  }

  updateColor(newColor: string): void {
    this.color = newColor;
  }
}

/**
 * Build a closed polygon outlining a stroke path with given width.
 * Returns vertices tracing the left side forward, then right side backward.
 */
function strokeToPolygon(points: Vec2[], width: number): Vec2[] {
  if (points.length < 2) return [];

  const left: Vec2[] = [];
  const right: Vec2[] = [];
  const halfW = width / 2;

  for (let i = 0; i < points.length; i++) {
    let dx: number, dy: number;

    if (i === 0) {
      dx = points[1].x - points[0].x;
      dy = points[1].y - points[0].y;
    } else if (i === points.length - 1) {
      dx = points[i].x - points[i - 1].x;
      dy = points[i].y - points[i - 1].y;
    } else {
      dx = points[i + 1].x - points[i - 1].x;
      dy = points[i + 1].y - points[i - 1].y;
    }

    const mag = Math.sqrt(dx * dx + dy * dy);
    if (mag === 0) {
      left.push(points[i]);
      right.push(points[i]);
      continue;
    }

    const nx = -dy / mag * halfW;
    const ny = dx / mag * halfW;

    left.push({ x: points[i].x + nx, y: points[i].y + ny });
    right.push({ x: points[i].x - nx, y: points[i].y - ny });
  }

  return [...left, ...right.reverse()];
}

/**
 * Watercolor brush — renders the full BarneyCodes watercolor algorithm live.
 * Same public interface as Pen/ChalkBrush.
 *
 * Builds a stroke-outline polygon from all points collected so far,
 * then renders 50 semi-transparent layers with organic edge deformation
 * via the grow() subdivision algorithm. Re-renders to offscreen canvas
 * only when new points arrive, blits each frame for flicker-free display.
 *
 * Color mixing happens naturally through alpha compositing —
 * each stroke is ~40% max opacity, overlaps blend automatically.
 */
class WatercolorBrush {
  basicX: number = 0;
  basicY: number = 0;
  screenX: number = 0;
  screenY: number = 0;
  prevScreenX: number = 0;
  prevScreenY: number = 0;
  color: string = '#000';
  size: number = 240;
  referenceFov: number = 90;

  private _strokeId: string | null = null;
  private _projector: Projector;
  private _unprojector: Unprojector;
  private _initialized: boolean = false;
  /** Per-stroke random source: seeded the same for the drawer and everyone watching, so a
   *  live replay of the stroke draws exactly what the drawer gets. */
  private _rand: () => number = Math.random;
  setSeed(seed: number): void {
    this._rand = mulberry32(seed);
  }
  private _history: { basicX: number; basicY: number; width: number }[] = [];
  private _screenPoints: Vec2[] = [];

  private _offscreen: HTMLCanvasElement;
  private _offCtx: CanvasRenderingContext2D;
  private _dirty: boolean = false;
  private _cachedRGB: [number, number, number] | null = null;

  minX: number = Infinity;
  minY: number = Infinity;
  maxX: number = -Infinity;
  maxY: number = -Infinity;

  constructor(
    screenX: number,
    screenY: number,
    color: string,
    projector: Projector,
    unprojector: Unprojector,
    size?: number,
    referenceFov?: number,
    canvasWidth?: number,
    canvasHeight?: number
  ) {
    this.screenX = screenX;
    this.screenY = screenY;
    this.prevScreenX = screenX;
    this.prevScreenY = screenY;
    this._projector = projector;
    this._unprojector = unprojector;
    if (color !== undefined) this.color = color;
    if (size !== undefined) this.size = size;
    if (referenceFov !== undefined) this.referenceFov = referenceFov;

    this._offscreen = document.createElement('canvas');
    this._offscreen.width = canvasWidth || 1920;
    this._offscreen.height = canvasHeight || 1080;
    this._offCtx = this._offscreen.getContext('2d')!;

    this._updateBounds(screenX, screenY);
  }

  async initialize(): Promise<void> {
    const basic = await this._unprojector([this.screenX, this.screenY]);
    if (basic) {
      this.basicX = basic[0];
      this.basicY = basic[1];
      this._history.push({ basicX: basic[0], basicY: basic[1], width: this.size });
    }
    this._screenPoints.push({ x: this.screenX, y: this.screenY });
    this._initialized = true;
  }

  private _updateBounds(x: number, y: number): void {
    const pad = this.size * 8;
    this.minX = Math.min(this.minX, x - pad);
    this.minY = Math.min(this.minY, y - pad);
    this.maxX = Math.max(this.maxX, x + pad);
    this.maxY = Math.max(this.maxY, y + pad);
  }

  getBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    return { minX: this.minX, minY: this.minY, maxX: this.maxX, maxY: this.maxY };
  }

  isStroke(): boolean {
    return Boolean(this._strokeId);
  }

  startStroke(id: string): void {
    this._strokeId = id;
  }

  private _getRGB(): [number, number, number] {
    if (!this._cachedRGB) {
      const tmp = document.createElement('canvas').getContext('2d')!;
      tmp.fillStyle = this.color;
      const hex = tmp.fillStyle;
      this._cachedRGB = [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16),
      ];
    }
    return this._cachedRGB;
  }

  /**
   * Render watercolor for just the newest segment and accumulate
   * onto the offscreen canvas. Existing paint stays untouched.
   */
  private _renderSegment(fovScale: number): void {
    const len = this._screenPoints.length;
    if (len < 2) return;

    const overlap = Math.min(3, len - 1);
    const segPoints = this._screenPoints.slice(len - overlap - 1);

    const strokeWidth = this.size * fovScale * 4;
    const polyVerts = strokeToPolygon(segPoints, strokeWidth);
    if (polyVerts.length < 3) return;

    const poly = new WCPoly(polyVerts, undefined, this._rand);
    const [r, g, b] = this._getRGB();

    const numLayers = 50;
    const alpha = 1.5 / numLayers;
    this._offCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;

    let base = poly.grow().grow();

    for (let i = 0; i < numLayers; i++) {
      if (i === Math.floor(numLayers / 3) || i === Math.floor(2 * numLayers / 3)) {
        base = base.grow().grow();
      }
      base.grow().draw(this._offCtx);
    }

    this._dirty = false;
  }

  async render(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    currentFov: number
  ): Promise<void> {
    if (!this._initialized) return;

    const isStroke = this.isStroke();
    const fovScale = this.referenceFov / currentFov;

    const dx = x - this.screenX;
    const dy = y - this.screenY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    this.prevScreenX = this.screenX;
    this.prevScreenY = this.screenY;
    this.screenX = x;
    this.screenY = y;
    this._updateBounds(x, y);

    if (isStroke) {
      const newBasic = await this._unprojector([x, y]);
      if (newBasic && distance > 3) {
        this.basicX = newBasic[0];
        this.basicY = newBasic[1];
        this._history.push({
          basicX: newBasic[0],
          basicY: newBasic[1],
          width: this.size,
        });
        if (this._history.length > 500) this._history.shift();
        this._screenPoints.push({ x, y });
        if (this._screenPoints.length > 500) this._screenPoints.shift();
        this._dirty = true;
      }
    }

    if (this._dirty) {
      this._renderSegment(fovScale);
    }

    ctx.drawImage(this._offscreen, 0, 0);
  }

  async renderSmooth(
    ctx: CanvasRenderingContext2D,
    _x: number,
    _y: number,
    currentFov: number
  ): Promise<void> {
    if (!this._initialized || this._history.length < 2) return;

    const fovScale = this.referenceFov / currentFov;
    const projectedPoints = await Promise.all(
      this._history.map((p) => this._projector([p.basicX, p.basicY]))
    );

    const validPoints: [number, number][] = [];
    for (const p of projectedPoints) {
      if (p) validPoints.push([p[0], p[1]]);
    }
    if (validPoints.length < 2) return;

    const baseWidth = this._history[0].width * fovScale * 4;

    ctx.save();
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = baseWidth;
    ctx.beginPath();
    ctx.moveTo(validPoints[0][0], validPoints[0][1]);
    for (let i = 1; i < validPoints.length; i++) {
      ctx.lineTo(validPoints[i][0], validPoints[i][1]);
    }
    ctx.stroke();
    ctx.restore();
  }

  dispose(): void {
    this._history.length = 0;
    this._screenPoints.length = 0;
  }

  updateColor(newColor: string): void {
    this.color = newColor;
    this._cachedRGB = null;
  }
}

interface StrokePoint {
  basicX: number;
  basicY: number;
  width: number;
}

interface Stroke {
  points: StrokePoint[];
  color: string;
  baseWidth: number;
  referenceFov: number;
  toolType: "pencil" | "marker" | "crayon" | "fountainPen" | "watercolor";
}

interface MarkerTexture {
  canvas?: HTMLCanvasElement; // Lazy — created on demand for hit-testing / silhouettes
  image?: HTMLImageElement; // For remote strokes loaded via URL
  silhouetteCanvas?: HTMLCanvasElement; // Clean smooth version for highlight outline (pencil strokes)
  gridBasic: [number, number][][];
  gridRows: number;
  gridCols: number;
  srcWidth: number;
  srcHeight: number;
  referenceFov: number;
  cachedProjection?: ([number, number] | null)[][];
  isLocal?: boolean;
  opacity?: number;
  supabaseId?: string;
  liveId?: string; // id shared with the live room (finished strokes, undo, eraser)
  pendingDelete?: boolean;
  fadingOut?: boolean;
  fadeStartTime?: number;
  needsProjection?: boolean;
  isProjecting?: boolean;
  deviceId?: string;
  createdAt?: string;
  highlighted?: boolean;
  toolType?: "pencil" | "marker" | "crayon" | "fountainPen" | "watercolor";
  brushStrokeId?: string; // Internal brush stroke ID for matching drips/splashes
  strokeGroup?: number; // Pieces of one stroke that crossed surfaces — undone/redone together
  inkCost?: number; // Total ink spent on this stroke (for refund on erase)
  isRainbow?: boolean; // Rainbow-colored stroke — animates hue continuously
  // Cached WebGL triangle geometry — rebuilt only when cachedProjection changes
  _glPositions?: Float32Array;
  _glTexCoords?: Float32Array;
  _glTriCount?: number;
  // GPU projection geometry — built once from gridBasic, never changes
  _gpuBasicCoords?: Float32Array;
  _gpuTexCoords?: Float32Array;
  _gpuVertexCount?: number;
}

/** Returns the best available texture source for WebGL / 2D drawing */
/** Other people's cursor rings fade in/out over this long instead of popping. */
const CURSOR_FADE_MS = 250;

function texSource(tex: MarkerTexture): HTMLCanvasElement | HTMLImageElement {
  return tex.canvas || tex.image!;
}

/** Lazily materialises a canvas from an Image (for hit-testing / silhouettes) */
function ensureCanvas(tex: MarkerTexture): HTMLCanvasElement {
  if (tex.canvas) return tex.canvas;
  const img = tex.image!;
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d")!.drawImage(img, 0, 0);
  tex.canvas = c;
  return c;
}

/**
 * Paintable radius around the drawn path per tool (decal px = screen px at the stroke start):
 * measured brush half-width + a margin for texture/bleed. Paint outside it is never shown.
 */
const DEEP_NEAR_RADIUS: Record<string, number> = {
  pencil: 10,
  marker: 26,
  crayon: 22,
  fountainPen: 11,
  watercolor: 18,
};

/** One eraser gesture over our own strokes: each touched stroke's pixels before and after. */
interface EraseEdit {
  kind: "erase";
  strokeGroup?: undefined;
  items: Map<MarkerTexture, { before: HTMLCanvasElement; after?: HTMLCanvasElement; removed: boolean }>;
}
type UndoEntry = MarkerTexture | EraseEdit;
const isEraseEdit = (e: UndoEntry | undefined): e is EraseEdit => (e as EraseEdit | undefined)?.kind === "erase";

function copyCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  c.getContext("2d")!.drawImage(src, 0, 0);
  return c;
}

/** Panorama bbox [u0, v0, u1, v1] of a stroke's grid (cached). */
function eraseBox(tex: MarkerTexture & { _box?: [number, number, number, number] }): [number, number, number, number] {
  if (tex._box) return tex._box;
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const row of tex.gridBasic) for (const [u, v] of row) {
    if (u < u0) u0 = u; if (u > u1) u1 = u;
    if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  return (tex._box = [u0, v0, u1, v1]);
}

/**
 * Panorama point -> pixel in a stroke's bitmap, through its grid (bitmap corners -> panorama).
 * Points just outside the stroke extrapolate from the nearest cell, so footprints at the edge
 * still cut cleanly.
 */
function basicToTex(tex: MarkerTexture, u: number, v: number): [number, number] | null {
  const g = tex.gridBasic, R = tex.gridRows, C = tex.gridCols;
  const cw = (tex.canvas?.width ?? tex.srcWidth) / C, ch = (tex.canvas?.height ?? tex.srcHeight) / R;
  let best: [number, number] | null = null, bestErr = Infinity;
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    const p00 = g[r][c], p10 = g[r][c + 1], p01 = g[r + 1][c], p11 = g[r + 1][c + 1];
    // cheap reject: far outside this cell (with a margin for extrapolation)
    const mu = Math.max(Math.abs(p10[0] - p00[0]), Math.abs(p01[1] - p00[1]), 1e-4) * 1.5;
    if (u < Math.min(p00[0], p01[0], p10[0], p11[0]) - mu || u > Math.max(p00[0], p01[0], p10[0], p11[0]) + mu) continue;
    if (v < Math.min(p00[1], p01[1], p10[1], p11[1]) - mu || v > Math.max(p00[1], p01[1], p10[1], p11[1]) + mu) continue;
    // inverse bilinear by Newton steps
    let s = 0.5, t = 0.5;
    for (let it = 0; it < 6; it++) {
      const x = (1 - s) * (1 - t) * p00[0] + s * (1 - t) * p10[0] + (1 - s) * t * p01[0] + s * t * p11[0];
      const y = (1 - s) * (1 - t) * p00[1] + s * (1 - t) * p10[1] + (1 - s) * t * p01[1] + s * t * p11[1];
      const dxs = (1 - t) * (p10[0] - p00[0]) + t * (p11[0] - p01[0]);
      const dys = (1 - t) * (p10[1] - p00[1]) + t * (p11[1] - p01[1]);
      const dxt = (1 - s) * (p01[0] - p00[0]) + s * (p11[0] - p10[0]);
      const dyt = (1 - s) * (p01[1] - p00[1]) + s * (p11[1] - p10[1]);
      const det = dxs * dyt - dxt * dys;
      if (Math.abs(det) < 1e-14) break;
      const ex = u - x, ey = v - y;
      s += (ex * dyt - ey * dxt) / det;
      t += (ey * dxs - ex * dys) / det;
    }
    // how far outside the unit cell the solution lies (0 = inside)
    const err = Math.max(0, -s, s - 1) + Math.max(0, -t, t - 1);
    if (err < bestErr && isFinite(s) && isFinite(t)) {
      bestErr = err;
      best = [(c + s) * cw, (r + t) * ch];
      if (err === 0) return best;
    }
  }
  return bestErr < 2 ? best : null;
}

/** No visible pixels left? */
function isBlank(canvas: HTMLCanvasElement): boolean {
  if (!canvas.width || !canvas.height) return true;
  const d = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < d.length; i += 16) if (d[i] > 8) return false;
  return true;
}

/** Someone else's surface stroke, replayed live with their brush (see replayStart). */
interface Replay {
  st: DecalState;
  tool: { render(ctx: CanvasRenderingContext2D, x: number, y: number, fov: number): unknown; getBounds(): { minX: number; minY: number; maxX: number; maxY: number }; dispose(): void };
  group?: number;
  ended: boolean;
  dead: boolean;
  /** tool work runs strictly in order (each step awaits the last) */
  chain: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

/** A stroke being drawn on a 3D surface decal (see deep/surfaceDecal). */
interface DecalState {
  geo: GeodesicMap; // continuous surface unwrap for this stroke (decal space <-> panorama)
  surface: Float32Array; // panorama paint multiplier (shadows + texture)
  toolCrop: HTMLCanvasElement; // crop of the tool drawing, uploaded to the GPU each frame
  toolRect: [number, number, number, number]; // crop rect in decal px
  hasLive: boolean;
  toolVersion: number; // bumped each time the tool drawing is re-rendered
  geom: { key: string; basic: Float32Array; tex: Float32Array } | null; // cached draw geometry
  x: number; // current tool position in decal px
  y: number;
  fov: number; // fov at stroke start (tools render at fovScale 1 in decal space)
  offFrames: number; // consecutive frames the cursor couldn't be reached along the surface
  group: number; // stroke group id (shared by all pieces of a stroke)
  nearRadius: number; // paintable radius around the drawn path, in decal px (~brush half-width + margin)
  prev: { basic: [number, number]; decal: [number, number] } | null; // last cursor sample on the surface
  start: [number, number]; // panorama point the decal was built at
}


export class DrawingOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private viewer: Viewer | null = null;
  private strokes: Stroke[] = [];
  private markerTextures: MarkerTexture[] = [];
  private lastPixelX: number = 0;
  private lastPixelY: number = 0;

  private brush: Brush | null = null;
  private pen: Pen | ChalkBrush | FountainPenBrush | WatercolorBrush | null = null;
  private isMarkerActive: boolean = false;
  private isPencilActive: boolean = false;
  private _strokeHasMovement: boolean = false;
  private _currentToolType:
    | "pencil"
    | "marker"
    | "crayon"
    | "fountainPen"
    | "watercolor" = "pencil";
  private animationFrameId: number | null = null;
  private currentFov: number = 90;
  private referenceFov: number = 90;
  private dyingStrokes: {
    brush: Brush;
    brushStrokeId?: string;
    lastX: number;
    lastY: number;
    fov: number;
    decal?: DecalState;
  }[] = [];
  private dyingPenStrokes: {
    pen: Pen | ChalkBrush | FountainPenBrush | WatercolorBrush;
    lastX: number;
    lastY: number;
    fov: number;
    decal?: DecalState;
  }[] = [];
  private finalizingStrokes: {
    brush: Brush;
    lastX: number;
    lastY: number;
    fov: number;
    decal?: DecalState;
  }[] = [];
  private finalizingPenStrokes: {
    pen: Pen | ChalkBrush | FountainPenBrush | WatercolorBrush;
    lastX: number;
    lastY: number;
    fov: number;
    decal?: DecalState;
  }[] = [];
  private pendingTextures: {
    stroke: any;
    texture: MarkerTexture;
  }[] = [];
  private pendingPenTextures: {
    stroke: any;
    texture: MarkerTexture;
  }[] = [];
  private activeDrops: Drop[] = [];
  private activeSplashes: SplashParticle[] = [];
  private webglRenderer: WebGLDrawingRenderer | null = null;
  private currentRenderId: number = 0;
  private _renderPending: boolean = false;

  // Supabase persistence
  private _imageId: string | null = null;
  /** Precomputed shading (light/shadow) for the current panorama, if available — see deep/strokeShading */
  private _deepShade: Float32Array | null = null;
  /** Depth + surface maps for the current panorama (enables drawing on 3D surfaces) */
  private _deepData: DeepData | null = null;
  private _activeDecal: DecalState | null = null;
  /** Params of the stroke in progress, so it can continue on a new surface (decal chaining). */
  private _strokeGroup = 0;
  /** Pre-built decal for the next segment when a stroke chains onto a new surface. */
  private _chainDecal: DecalState | null = null;
  private _strokeParams: { color: string; lineWidth: number; toolType: "pencil" | "marker" | "crayon" | "fountainPen" | "watercolor" } | null = null;
  private _loadedStrokeIds: Set<string> = new Set();
  private _prefetchedTextures: Map<string, MarkerTexture[]> = new Map();

  // Called when loadStrokes completes (success or error)
  onStrokesLoaded?: () => void;
  private _localSupabaseIds: Set<string> = new Set();
  private useWebGL: boolean = false;
  private _gpuPathLogged: boolean = false;

  // Cached mapillary internals (subscribed in setViewer)
  private _cachedRenderCamera: any = null;
  private _cachedTransform: any = null;
  private _internalSubs: any[] = [];
  private _boundResize: (() => void) | null = null;
  private _boundViewerListeners: { event: string; handler: (...args: any[]) => void }[] = [];

  // Undo/Redo stacks
  private _undoStack: UndoEntry[] = [];
  private _redoStack: UndoEntry[] = [];

  // Stroke selection & reporting
  private highlightedStrokes: Set<MarkerTexture> = new Set();

  // Realtime collaboration
  private lastBroadcastTime: number = 0;
  private _isRainbowStroke: boolean = false; // Current stroke is rainbow
  private _pendingInkCost: number = 0; // Ink cost for current stroke, set by App before endStroke
  private _rainbowAnimFrameId: number | null = null; // Animation loop for rainbow textures
  private _container: HTMLElement | null = null;
  private _pendingScreenshotFrames: number = 0;

  // Guest mode: strokes render locally but don't save to Supabase
  private _guestMode: boolean = false;
  private _unsavedGuestTextures: { texture: MarkerTexture; toolType: "pencil" | "marker" | "crayon" | "fountainPen" | "watercolor" }[] = [];

  // Composite cache — single equirectangular preview image for fast initial load
  private _compositeTexture: MarkerTexture | null = null;
  private _compositeGenerating: boolean = false;
  private _compositeImageId: string | null = null;

  setGuestMode(guest: boolean): void {
    this._guestMode = guest;
  }

  hasUnsavedGuestStrokes(): boolean {
    return this._unsavedGuestTextures.length > 0;
  }

  /** After auth succeeds, flush all guest strokes to Supabase */
  async saveGuestStrokes(): Promise<void> {
    this._guestMode = false;
    for (const { texture, toolType } of this._unsavedGuestTextures) {
      await this.saveStrokeTexture(texture, toolType);
    }
    this._unsavedGuestTextures = [];
  }

  constructor(container: HTMLElement) {
    this._container = container;
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
    this._boundViewerListeners.push({ event: "fov", handler: onFov });

    viewer.getFieldOfView().then((fov) => {
      this.currentFov = fov;
    });

    // Subscribe to internal observables to cache renderCamera and transform
    try {
      const viewerAny = viewer as any;
      const renderService = viewerAny._container?.renderService;
      const stateService = viewerAny._navigator?.stateService;

      if (renderService?.renderCameraFrame$) {
        this._internalSubs.push(
          renderService.renderCameraFrame$.subscribe((rc: any) => {
            this._cachedRenderCamera = rc;
            this.invalidateProjectionCache();
          }),
        );
      }
      if (stateService?.currentTransform$) {
        this._internalSubs.push(
          stateService.currentTransform$.subscribe((t: any) => {
            this._cachedTransform = t;
          }),
        );
      }
    } catch (e) {
      console.warn("[DrawingOverlay] Failed to subscribe to internals:", e);
    }

    // Fallback: pov/bearing events for CPU path (when subscriptions fail)
    const onPov = () => this.invalidateProjectionCache();
    const onBearing = () => this.invalidateProjectionCache();
    viewer.on("pov", onPov);
    viewer.on("bearing", onBearing);
    this._boundViewerListeners.push({ event: "pov", handler: onPov });
    this._boundViewerListeners.push({ event: "bearing", handler: onBearing });
  }

  private invalidateProjectionCache(): void {
    this.reprojectRemoteCursors();
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
    if (!this.viewer || !this.webglRenderer || (this.markerTextures.length === 0 && live.length === 0))
      return;

    const gpuUniforms = this.getGPUProjectionUniforms();
    if (!gpuUniforms) return;

    this.webglRenderer.clear();
    this.webglRenderer.setGPUProjectionUniforms(gpuUniforms);

    const hueShift = getRainbowHueShift();

    // First pass: highlight outlines behind highlighted textures
    for (const tex of this.markerTextures) {
      if (!tex.highlighted) continue;
      if (!tex._gpuBasicCoords) this.buildGPUGeometry(tex);
      if (!tex._gpuVertexCount) continue;

      const highlightCanvas = this.getOrCreateSilhouette(tex);
      this.webglRenderer.drawGPUProjectedBatch(
        highlightCanvas,
        tex._gpuBasicCoords!,
        tex._gpuTexCoords!,
        1,
        true,
      );
    }

    // Second pass: all textures normally
    for (const tex of this.markerTextures) {
      if (!tex._gpuBasicCoords) this.buildGPUGeometry(tex);
      if (!tex._gpuVertexCount) continue;

      const texOpacity = tex.pendingDelete ? 0.4 : (tex.opacity ?? 1);
      this.webglRenderer.drawGPUProjectedBatch(
        texSource(tex),
        tex._gpuBasicCoords!,
        tex._gpuTexCoords!,
        texOpacity,
        false,
        tex.isRainbow ? hueShift : 0,
      );
    }
    this.drawLiveDecals(live);
  }

  private buildGLGeometry(tex: MarkerTexture): void {
    const projectedGrid = tex.cachedProjection;
    if (!projectedGrid) return;

    const maxTris = tex.gridRows * tex.gridCols * 2;
    const positions = new Float32Array(maxTris * 6);
    const texCoords = new Float32Array(maxTris * 6);
    let triCount = 0;

    for (let row = 0; row < tex.gridRows; row++) {
      for (let col = 0; col < tex.gridCols; col++) {
        const tl = projectedGrid[row][col];
        const tr = projectedGrid[row][col + 1];
        const bl = projectedGrid[row + 1][col];
        const br = projectedGrid[row + 1][col + 1];
        if (!tl || !tr || !bl || !br) continue;

        const u0 = col / tex.gridCols,
          v0 = row / tex.gridRows;
        const u1 = (col + 1) / tex.gridCols,
          v1 = (row + 1) / tex.gridRows;

        let b = triCount * 6;
        positions[b] = tl[0];
        positions[b + 1] = tl[1];
        positions[b + 2] = tr[0];
        positions[b + 3] = tr[1];
        positions[b + 4] = bl[0];
        positions[b + 5] = bl[1];
        texCoords[b] = u0;
        texCoords[b + 1] = v0;
        texCoords[b + 2] = u1;
        texCoords[b + 3] = v0;
        texCoords[b + 4] = u0;
        texCoords[b + 5] = v1;
        triCount++;

        b = triCount * 6;
        positions[b] = tr[0];
        positions[b + 1] = tr[1];
        positions[b + 2] = br[0];
        positions[b + 3] = br[1];
        positions[b + 4] = bl[0];
        positions[b + 5] = bl[1];
        texCoords[b] = u1;
        texCoords[b + 1] = v0;
        texCoords[b + 2] = u1;
        texCoords[b + 3] = v1;
        texCoords[b + 4] = u0;
        texCoords[b + 5] = v1;
        triCount++;
      }
    }

    tex._glPositions = positions.subarray(0, triCount * 6);
    tex._glTexCoords = texCoords.subarray(0, triCount * 6);
    tex._glTriCount = triCount;
  }

  /**
   * Build GPU projection geometry for a MarkerTexture.
   * Called once when a texture is created — stores basic coords and UVs
   * as Float32Arrays that never change (projection happens on GPU).
   */
  private buildGPUGeometry(tex: MarkerTexture): void {
    const maxTris = tex.gridRows * tex.gridCols * 2;
    const basicCoords = new Float32Array(maxTris * 6);
    const texCoords = new Float32Array(maxTris * 6);
    let triCount = 0;

    for (let row = 0; row < tex.gridRows; row++) {
      for (let col = 0; col < tex.gridCols; col++) {
        const tl = tex.gridBasic[row][col];
        const tr = tex.gridBasic[row][col + 1];
        const bl = tex.gridBasic[row + 1][col];
        const br = tex.gridBasic[row + 1][col + 1];

        // Skip cells with failed unprojection (zero coords)
        if (
          (!tl[0] && !tl[1]) ||
          (!tr[0] && !tr[1]) ||
          (!bl[0] && !bl[1]) ||
          (!br[0] && !br[1])
        )
          continue;

        const u0 = col / tex.gridCols,
          v0 = row / tex.gridRows;
        const u1 = (col + 1) / tex.gridCols,
          v1 = (row + 1) / tex.gridRows;

        // Triangle 1: tl, tr, bl
        let b = triCount * 6;
        basicCoords[b] = tl[0];
        basicCoords[b + 1] = tl[1];
        basicCoords[b + 2] = tr[0];
        basicCoords[b + 3] = tr[1];
        basicCoords[b + 4] = bl[0];
        basicCoords[b + 5] = bl[1];
        texCoords[b] = u0;
        texCoords[b + 1] = v0;
        texCoords[b + 2] = u1;
        texCoords[b + 3] = v0;
        texCoords[b + 4] = u0;
        texCoords[b + 5] = v1;
        triCount++;

        // Triangle 2: tr, br, bl
        b = triCount * 6;
        basicCoords[b] = tr[0];
        basicCoords[b + 1] = tr[1];
        basicCoords[b + 2] = br[0];
        basicCoords[b + 3] = br[1];
        basicCoords[b + 4] = bl[0];
        basicCoords[b + 5] = bl[1];
        texCoords[b] = u1;
        texCoords[b + 1] = v0;
        texCoords[b + 2] = u1;
        texCoords[b + 3] = v1;
        texCoords[b + 4] = u0;
        texCoords[b + 5] = v1;
        triCount++;
      }
    }

    tex._gpuBasicCoords = basicCoords.subarray(0, triCount * 6);
    tex._gpuTexCoords = texCoords.subarray(0, triCount * 6);
    tex._gpuVertexCount = triCount * 3;
  }

  /**
   * Extract projection uniforms from mapillary internals for GPU projection.
   * Returns null if internals are not accessible.
   */
  private getGPUProjectionUniforms(): GPUProjectionUniforms | null {
    // Reuse the same internal access path that getSyncProjectionContext() uses
    const ctx = this.getSyncProjectionContext();
    if (!ctx) return null;

    try {
      const perspective = ctx.renderCamera.perspective;
      const transform = ctx.transform;

      if (!perspective || !transform) return null;

      const rtMatrix = transform.rt;
      if (!rtMatrix?.clone) return null;

      const cameraToWorld = rtMatrix.clone().invert();

      if (
        !perspective.projectionMatrix?.elements ||
        !perspective.matrixWorldInverse?.elements ||
        !cameraToWorld.elements
      )
        return null;

      // Camera type: 'perspective' | 'spherical' | 'fisheye'
      const cameraTypeStr = transform.cameraType;
      let cameraType = 0;
      if (cameraTypeStr === "spherical") cameraType = 1;
      else if (cameraTypeStr === "fisheye") cameraType = 2;

      return {
        cameraToWorld: new Float32Array(cameraToWorld.elements),
        projectionMatrix: new Float32Array(
          perspective.projectionMatrix.elements,
        ),
        viewMatrix: new Float32Array(perspective.matrixWorldInverse.elements),
        focal: transform.focal,
        imageWidth: transform.width,
        imageHeight: transform.height,
        ck1: transform.ck1 || 0,
        ck2: transform.ck2 || 0,
        orientation: transform.orientation || 1,
        cameraType,
      };
    } catch (e) {
      if (!this._gpuPathLogged)
        console.error("[GPU] uniform extraction error:", e);
      return null;
    }
  }

  // ── Realtime Collaboration ─────────────────────────────────────────

  /** Join this panorama's live room: others' cursors and strokes appear, ours are shared. */
  subscribeToRealtime(imageId: string): void {
    this.unsubscribeFromRealtime();
    this._realtimeOff = realtime.on((msg) => this.onRealtimeMessage(msg));
    realtime.join(imageId);
  }

  unsubscribeFromRealtime(): void {
    this._realtimeOff?.();
    this._realtimeOff = null;
    // Clean up others' in-progress strokes and cursors
    for (const id of [...this._remotePreviews.keys()]) this.remotePreviewEnd(id);
    for (const id of [...this._replays.keys()]) this.dropReplays(id);
    this.clearRemoteCursors();
  }

  private onRealtimeMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        // strokes others drew in this room before we arrived (held in server memory)
        this.clearRemoteCursors();
        for (const p of msg.peers) this._peerColors.set(p.id, p.color);
        for (const s of msg.strokes) void this.addLiveStroke(s);
        return;
      case "peer_join":
        this._peerColors.set(msg.peer.id, msg.peer.color);
        return;
      case "peer_leave":
        this._peerColors.delete(msg.id);
        this._peerBrush.delete(msg.id);
        this.removeRemoteCursor(msg.id);
        this.remotePreviewEnd(msg.id);
        this.dropReplays(msg.id);
        return;
      case "cursor":
        this.setRemoteCursor(msg.from, msg);
        return;
      case "cursor_hide":
        this.removeRemoteCursor(msg.from);
        return;
      case "stroke_start":
        if (msg.seed !== undefined && msg.wpp !== undefined && this.replayStart(msg.from, msg)) return;
        this.remotePreviewStart(msg.from, msg.color, msg.u, msg.v, msg.group);
        return;
      case "stroke_point": {
        const r = this.liveReplay(msg.from);
        if (r && msg.pts) return this.replaySamples(r, msg.pts);
        this.remotePreviewPoint(msg.from, msg.u, msg.v);
        return;
      }
      case "stroke_end": {
        const r = this.liveReplay(msg.from);
        if (r) return this.replayEnd(msg.from, r);
        // A stroke crossing onto a new surface ends a piece and starts the next one (same group):
        // keep the line until the finished bitmap arrives, unless a new piece continues it.
        const rp = this._remotePreviews.get(msg.from);
        if (!rp) return;
        rp.ended = true;
        clearTimeout(rp.timer);
        rp.timer = setTimeout(() => { if (this._remotePreviews.get(msg.from) === rp && rp.ended) this.remotePreviewEnd(msg.from); }, 4000);
        return;
      }
      case "stroke_done": {
        // the finished, lit bitmap replaces the live line once the whole stroke is over
        const from = msg.from, group = msg.stroke.strokeGroup;
        // the replayed copy is pixel-identical: swap once the bitmap is on screen
        const replay = this._replays.get(from)?.find((r) => r.ended && (group === undefined || r.group === group));
        if (replay) clearTimeout(replay.timer);
        void this.addLiveStroke(msg.stroke).then(() => {
          if (replay) requestAnimationFrame(() => this.dropReplay(from, replay));
          const rp = this._remotePreviews.get(from);
          if (rp && rp.ended && (group === undefined || rp.group === undefined || rp.group === group)) this.remotePreviewEnd(from);
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
    toolType: "pencil" | "marker" | "crayon" | "fountainPen" | "watercolor",
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
    const ids = textures.map((t) => t.liveId).filter((id): id is string => !!id);
    if (ids.length) realtime.send({ t: "erase", ids });
  }

  /**
   * Share a finished stroke exactly as we see it: the baked bitmap (3D wrap + lighting
   * included) and its panorama grid. Called for every finished stroke, signed in or not.
   */
  private async shareFinishedStroke(tex: MarkerTexture): Promise<void> {
    if (!tex.canvas) return;
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

  // ── Other people's cursors ──
  /** Peer id -> their cursor: an outline the size of their brush, wrapped onto the surface. */
  private _remoteCursors = new Map<string, {
    pts: [number, number][]; paint: string | null; path: SVGPathElement; halo: SVGPathElement;
    timer: ReturnType<typeof setTimeout>;
    /** set while fading out; cleared if the cursor comes back before it's gone */
    fadeOut: ReturnType<typeof setTimeout> | null;
  }>();
  private _remoteCursorSvg: SVGSVGElement | null = null;
  private _peerColors = new Map<string, string>();
  /** each peer's brush radius (radians), from their cursor */
  private _peerBrush = new Map<string, number>();
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

  private ensureRemoteSvg(): SVGSVGElement | null {
    if (!this._remoteCursorSvg && this._container) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
      svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:11;overflow:visible";
      this._container.appendChild(svg);
      this._remoteCursorSvg = svg;
    }
    return this._remoteCursorSvg;
  }

  private setRemoteCursor(id: string, c: CursorState): void {
    const svg = this.ensureRemoteSvg();
    if (!svg) return;
    this._peerBrush.set(id, c.radius);
    if (this.isSkyAtBasic(c.u, c.v)) return this.removeRemoteCursor(id); // nothing to paint up there
    let rc = this._remoteCursors.get(id);
    if (!rc) {
      const NS = "http://www.w3.org/2000/svg";
      const halo = document.createElementNS(NS, "path") as SVGPathElement;
      halo.setAttribute("fill", "none");
      // same weights as our own brush ring (3px halo under a 1.5px line), just in their colour
      halo.setAttribute("stroke", "rgba(0,0,0,0.45)");
      halo.setAttribute("stroke-width", "3");
      halo.setAttribute("stroke-linejoin", "round");
      const path = document.createElementNS(NS, "path") as SVGPathElement;
      path.setAttribute("stroke-width", "1.5");
      path.setAttribute("stroke-linejoin", "round");
      // fade in: start transparent, ease to visible next frame
      for (const el of [halo, path]) {
        el.style.transition = `opacity ${CURSOR_FADE_MS}ms ease`;
        el.style.opacity = "0";
      }
      svg.append(halo, path);
      requestAnimationFrame(() => { halo.style.opacity = "1"; path.style.opacity = "1"; });
      rc = { pts: [], paint: null, path, halo, timer: setTimeout(() => {}, 0), fadeOut: null };
      this._remoteCursors.set(id, rc);
    } else if (rc.fadeOut) {
      // came back while fading out: cancel and fade back in
      clearTimeout(rc.fadeOut);
      rc.fadeOut = null;
      rc.halo.style.opacity = "1";
      rc.path.style.opacity = "1";
    }
    // ring in panorama coords on the surface, sized from their brush angle at our zoom
    const radPerPx = ((this.currentFov * Math.PI) / 180) / Math.max(1, this.canvas.height);
    const radiusPx = Math.max(2, c.radius / radPerPx);
    let pts: [number, number][] = [];
    if (this._deepData) {
      const decal = SurfaceDecal.create(this._deepData, c.u, c.v, radPerPx);
      if (decal) pts = surfaceRing(this._deepData, decal.basis, radiusPx * decal.basis.s, 64);
    }
    if (!pts.length) {
      // no depth here: a small ring in panorama space around the point
      const r = c.radius / (2 * Math.PI);
      for (let k = 0; k <= 64; k++) {
        const a = (k / 64) * Math.PI * 2;
        pts.push([c.u + Math.cos(a) * r, c.v + Math.sin(a) * r * 2]);
      }
    }
    rc.pts = pts;
    rc.paint = c.paint;
    // Ring = this person's colour only, never their paint (like tldraw/Figma: identity on the
    // cursor, content colour only in the stroke itself). Their paint shows once they draw.
    rc.path.setAttribute("stroke", this._peerColors.get(id) ?? "#ffffff");
    rc.path.setAttribute("fill", "none");
    rc.path.dataset.peer = id;
    clearTimeout(rc.timer);
    rc.timer = setTimeout(() => this.removeRemoteCursor(id), 5000); // idle -> fade away
    this.reprojectRemoteCursor(rc);
  }

  private reprojectRemoteCursor(rc: { pts: [number, number][]; path: SVGPathElement; halo: SVGPathElement }): void {
    const sync = this.getSyncProjectionContext();
    if (!sync) return;
    let d = "";
    let pen = false;
    let shown = 0;
    for (const p of rc.pts) {
      let sp: number[] | null = null;
      try {
        sp = sync.proj.basicToCanvas(p, sync.container, sync.renderCamera, sync.transform);
      } catch {
        sp = null;
      }
      if (!sp) { pen = false; continue; }
      d += `${pen ? "L" : "M"}${sp[0].toFixed(1)},${sp[1].toFixed(1)}`;
      pen = true;
      shown++;
    }
    // looking elsewhere: their cursor simply isn't on our screen
    if (shown && shown === rc.pts.length) d += "Z";
    rc.path.setAttribute("d", d);
    rc.halo.setAttribute("d", d);
  }

  private reprojectRemoteCursors(): void {
    for (const rc of this._remoteCursors.values()) this.reprojectRemoteCursor(rc);
  }

  /** Fade their ring out (idle, finger lifted, over the sky, left); instant when switching rooms. */
  private removeRemoteCursor(id: string, instant = false): void {
    const rc = this._remoteCursors.get(id);
    if (!rc) return;
    clearTimeout(rc.timer);
    const drop = () => {
      if (rc.fadeOut) clearTimeout(rc.fadeOut);
      rc.path.remove();
      rc.halo.remove();
      if (this._remoteCursors.get(id) === rc) this._remoteCursors.delete(id);
    };
    if (instant) return drop();
    if (rc.fadeOut) return; // already fading
    rc.halo.style.opacity = "0";
    rc.path.style.opacity = "0";
    rc.fadeOut = setTimeout(drop, CURSOR_FADE_MS);
  }

  private clearRemoteCursors(): void {
    for (const id of [...this._remoteCursors.keys()]) this.removeRemoteCursor(id, true);
  }

  // ── Others' strokes on 3D surfaces: replayed with the same brush ──
  // The drawer sends the decal's origin + scale, the brush seed and every brush sample, so we
  // rebuild their decal, run the same tool on the same samples, and draw it with the same
  // surface shader as our own live strokes. Their finished bitmap is then the same pixels, so
  // the swap when they let go is invisible.
  private _replays = new Map<string, Replay[]>();
  private _replayScratch: CanvasRenderingContext2D | null = null;

  private replayStart(id: string, m: { color: string; lineWidth: number; toolType: string; u: number; v: number; fov: number; group?: number; seed?: number; wpp?: number }): boolean {
    if (!this.canDrawDecals() || m.color === "rainbow") return false;
    const toolType = (["pencil", "marker", "crayon", "fountainPen", "watercolor"] as const).find((t) => t === m.toolType);
    if (!toolType) return false;
    const st = this.makeDecalAt([m.u, m.v], 1, m.wpp, true, toolType, m.group ?? 0, m.fov);
    if (!st) return false;
    this.remotePreviewEnd(id);
    const geo = st.geo;
    const tool = this.createTool(
      toolType, st.x, st.y, m.color,
      async (b) => geo.reach(b[0], b[1], 5000), async (p) => geo.basicAt(p[0], p[1]),
      m.lineWidth, m.fov, geo.size, geo.size,
    );
    tool.setSeed(m.seed ?? 0);
    if (tool instanceof Brush) tool.fixedSpace = true;
    const r: Replay = { st, tool, group: m.group, ended: false, dead: false, chain: Promise.resolve() };
    r.chain = (async () => {
      await tool.initialize();
      if (tool instanceof Brush) await tool.startStroke();
      else tool.startStroke(`replay_${Date.now()}`);
    })().catch(() => {});
    const list = this._replays.get(id) ?? [];
    list.push(r);
    this._replays.set(id, list);
    // a stroke that never finishes (sender vanished) doesn't stay forever
    r.timer = setTimeout(() => this.dropReplay(id, r), 60000);
    return true;
  }

  /** The peer's stroke piece still being drawn (null = none, or they draw flat). */
  private liveReplay(id: string): Replay | null {
    const list = this._replays.get(id);
    const r = list?.[list.length - 1];
    return r && !r.ended ? r : null;
  }

  /** Feed the drawer's brush samples (u, v, decal x, y) to the tool, in order, then redraw. */
  private replaySamples(r: Replay, pts: number[]): void {
    r.chain = r.chain.then(async () => {
      if (r.dead) return;
      this._replayScratch ??= (() => {
        const c = document.createElement("canvas");
        c.width = c.height = 1;
        return c.getContext("2d")!;
      })();
      for (let k = 0; k + 3 < pts.length; k += 4) {
        this.moveDecalTo(r.st, [pts[k], pts[k + 1]], [pts[k + 2], pts[k + 3]]);
        // every sample goes through the tool (it builds the stroke from them); only the last is drawn
        if (k + 4 < pts.length) await r.tool.render(this._replayScratch, r.st.x, r.st.y, r.st.fov);
        if (r.dead) return;
      }
      await this.renderDecalLive(r.tool, r.st);
      if (!r.dead) this.render();
    }).catch(() => {});
  }

  private replayEnd(id: string, r: Replay): void {
    r.ended = true;
    r.chain = r.chain.then(() => {
      if (r.tool instanceof Brush) r.tool.endStroke();
    });
    // the finished bitmap normally arrives well within this
    clearTimeout(r.timer);
    r.timer = setTimeout(() => this.dropReplay(id, r), 6000);
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
    void r.chain.then(() => {
      r.tool.dispose();
      this.webglRenderer?.releaseDeepStroke(r.st.geo);
      r.st.geo.release();
      this.render();
    });
  }

  private dropReplays(id: string): void {
    for (const r of [...(this._replays.get(id) ?? [])]) this.dropReplay(id, r);
  }

  // ── Others' strokes while they draw: painted onto the panorama, live ──
  // The brush's real footprint on the surface (the same wrapped ring as their cursor) is stamped
  // along their path into a panorama-space bitmap, lit with this panorama's lighting, and shown
  // like any finished stroke, so it sits on the surface instead of floating over it. Their
  // finished bitmap (stroke_done) replaces it when they let go.
  private _remotePreviews = new Map<string, {
    color: string; radius: number; group?: number; ended: boolean; timer?: ReturnType<typeof setTimeout>;
    /** stamped footprints in basic coords (u unwrapped around u0, so the seam is continuous) */
    stamps: [number, number][][]; last: [number, number]; u0: number;
    tex: MarkerTexture | null; dirty: boolean;
  }>();

  private remotePreviewStart(id: string, color: string, u: number, v: number, group?: number): void {
    const cur = this._remotePreviews.get(id);
    if (cur && group !== undefined && cur.group === group) {
      // next piece of the same stroke (it crossed onto another surface): keep painting
      cur.ended = false;
      clearTimeout(cur.timer);
      this.remotePreviewPoint(id, u, v);
      return;
    }
    this.remotePreviewEnd(id);
    const paint = color === "rainbow" ? (this._peerColors.get(id) ?? "#ff3b30") : color;
    // brush radius from their cursor (radians); a sensible default until one arrives
    const radius = this._peerBrush.get(id) ?? 0.006;
    const rp = { color: paint, radius, group, ended: false, stamps: [] as [number, number][][], last: [u, v] as [number, number], u0: u, tex: null, dirty: false };
    this._remotePreviews.set(id, rp);
    this.stampRemote(id, u, v);
  }

  private remotePreviewPoint(id: string, u: number, v: number): void {
    const rp = this._remotePreviews.get(id);
    if (!rp) return;
    // unwrap u next to the previous point, then stamp along the gap so the line stays solid
    while (u - rp.last[0] > 0.5) u -= 1;
    while (rp.last[0] - u > 0.5) u += 1;
    const [lu, lv] = rp.last;
    const lat = (0.5 - lv) * Math.PI;
    const ang = Math.hypot((u - lu) * 2 * Math.PI * Math.cos(lat), (v - lv) * Math.PI);
    const steps = Math.min(40, Math.max(1, Math.ceil(ang / (rp.radius * 0.5))));
    for (let k = 1; k <= steps; k++) this.stampRemote(id, lu + ((u - lu) * k) / steps, lv + ((v - lv) * k) / steps);
    rp.last = [u, v];
  }

  /** One brush footprint at (u, v), wrapped onto the surface like their cursor ring. */
  private stampRemote(id: string, u: number, v: number): void {
    const rp = this._remotePreviews.get(id);
    if (!rp) return;
    let ring: [number, number][] = [];
    if (this._deepData) {
      const radPerPx = ((this.currentFov * Math.PI) / 180) / Math.max(1, this.canvas.height);
      const decal = SurfaceDecal.create(this._deepData, ((u % 1) + 1) % 1, v, radPerPx);
      if (decal) ring = surfaceRing(this._deepData, decal.basis, (rp.radius / radPerPx) * decal.basis.s, 20, 8);
    }
    if (!ring.length) {
      // no depth here (or sky): a plain angular circle
      const cosLat = Math.max(0.05, Math.cos((0.5 - v) * Math.PI));
      for (let k = 0; k < 20; k++) {
        const a = (k / 20) * Math.PI * 2;
        ring.push([u + (Math.cos(a) * rp.radius) / (2 * Math.PI * cosLat), v + (Math.sin(a) * rp.radius) / Math.PI]);
      }
    }
    // keep every footprint next to u0 (the ring may come back wrapped to [0, 1))
    rp.stamps.push(ring.map(([pu, pv]) => {
      while (pu - rp.u0 > 0.5) pu -= 1;
      while (rp.u0 - pu > 0.5) pu += 1;
      return [pu, pv];
    }));
    if (!rp.dirty) {
      rp.dirty = true;
      requestAnimationFrame(() => this.rebuildRemotePreview(id));
    }
  }

  /** Re-render the preview bitmap (at most once a frame) and swap it into the stroke list. */
  private rebuildRemotePreview(id: string): void {
    const rp = this._remotePreviews.get(id);
    if (!rp) return;
    rp.dirty = false;
    const W = 2048, H = 1024, SS = 2; // panorama px, supersampled like baked strokes
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const ring of rp.stamps) for (const [u, v] of ring) {
      const x = u * W, y = v * H;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!isFinite(x0)) return;
    x0 = Math.floor(x0) - 1; y0 = Math.max(0, Math.floor(y0) - 1);
    x1 = Math.ceil(x1) + 1; y1 = Math.min(H, Math.ceil(y1) + 1);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0 || w > 1600 || h > 900) return; // runaway: keep the last good preview
    const canvas = document.createElement("canvas");
    canvas.width = w * SS;
    canvas.height = h * SS;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = rp.color;
    ctx.setTransform(SS, 0, 0, SS, -x0 * SS, -y0 * SS);
    for (const ring of rp.stamps) {
      ctx.beginPath();
      ring.forEach(([u, v], k) => (k ? ctx.lineTo(u * W, v * H) : ctx.moveTo(u * W, v * H)));
      ctx.closePath();
      ctx.fill();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // equirect is linear in u, v, so a coarse grid spans the box exactly
    const rows = 4, cols = 4;
    const gridBasic: [number, number][][] = [];
    for (let r = 0; r <= rows; r++) {
      const row: [number, number][] = [];
      for (let c = 0; c <= cols; c++) row.push([(x0 + (c / cols) * w) / W, (y0 + (r / rows) * h) / H]);
      gridBasic.push(row);
    }
    if (this._deepShade) applyShading(canvas, gridBasic, this._deepShade);
    const tex: MarkerTexture = {
      canvas, gridBasic, gridRows: rows, gridCols: cols,
      srcWidth: canvas.width, srcHeight: canvas.height,
      referenceFov: this.currentFov, opacity: 1,
    };
    if (rp.tex) {
      const i = this.markerTextures.indexOf(rp.tex);
      if (i > -1) this.markerTextures.splice(i, 1);
      if (this.webglRenderer) this.webglRenderer.invalidateTexture(texSource(rp.tex));
    }
    rp.tex = tex;
    this.markerTextures.push(tex);
    this.render();
  }

  private remotePreviewEnd(id: string): void {
    const rp = this._remotePreviews.get(id);
    if (!rp) return;
    clearTimeout(rp.timer);
    if (rp.tex) {
      const i = this.markerTextures.indexOf(rp.tex);
      if (i > -1) this.markerTextures.splice(i, 1);
      if (this.webglRenderer) this.webglRenderer.invalidateTexture(texSource(rp.tex));
      this.render();
    }
    this._remotePreviews.delete(id);
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
    toolType: "pencil" | "marker" | "crayon" | "fountainPen" | "watercolor",
  ): void {
    if (!this.viewer) return;

    this.lastPixelX = pixelX;
    this.lastPixelY = pixelY;

    // Track if this is a rainbow stroke
    this._isRainbowStroke = color === "rainbow";
    this._strokeHasMovement = false;
    this._currentToolType = toolType;
    const resolvedColor = this._isRainbowStroke ? resolveRainbowColor() : color;

    // The sky isn't a surface: don't start a stroke there at all.
    if (!this._chainDecal && this.isSkyAt(pixelX, pixelY)) {
      this._strokeParams = null;
      this._activeDecal = null;
      return;
    }
    this._strokeParams = { color, lineWidth, toolType };

    // Draw on the 3D surface when depth data is available: the tool works in decal space.
    if (!this._chainDecal) this._strokeGroup++;
    this._activeDecal = this._isRainbowStroke ? null : this._chainDecal ?? this.makeDecal(pixelX, pixelY);
    this._chainDecal = null;
    const dec = this._activeDecal;
    const toolX = dec ? dec.x : pixelX;
    const toolY = dec ? dec.y : pixelY;
    const toolW = dec ? dec.geo.size : this.canvas.width;
    const toolH = dec ? dec.geo.size : this.canvas.height;
    const decProjector: Projector | null = dec ? async (b) => dec.geo.reach(b[0], b[1], 5000) : null;
    const decUnprojector: Unprojector | null = dec ? async (p) => dec.geo.basicAt(p[0], p[1]) : null;

    // Ensure canvas is visible when user starts drawing
    this.canvas.style.opacity = "1";
    if (this.useWebGL && this.webglRenderer) {
      this.webglRenderer.getCanvas().style.opacity = "1";
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
    const seed = Math.floor(Math.random() * 2 ** 31);
    const tool = this.createTool(
      toolType, toolX, toolY, resolvedColor, decProjector ?? projector, decUnprojector ?? unprojector,
      lineWidth, this.currentFov, toolW, toolH,
    );
    tool.setSeed(seed);
    if (dec && tool instanceof Brush) tool.fixedSpace = true;

    // Broadcast the stroke start. On a 3D surface: the decal's origin, scale and brush seed, so
    // everyone else rebuilds the same decal and replays the same brush (identical pixels).
    this._pendingSamples = [];
    if (dec) {
      this._lastSample = [dec.x, dec.y];
      realtime.send({
        t: "stroke_start", color: resolvedColor, lineWidth, toolType, u: dec.start[0], v: dec.start[1],
        fov: dec.fov, group: this._strokeGroup, seed, wpp: dec.geo.s,
      });
    } else {
      this.viewer.unprojectToBasic([pixelX, pixelY]).then((basic) => {
        if (basic) this.broadcastStrokeStart(color, lineWidth, toolType, basic[0], basic[1]);
      });
    }

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

  /** The drawing tool for a stroke (same construction for our strokes and replayed ones). */
  private createTool(
    toolType: "pencil" | "marker" | "crayon" | "fountainPen" | "watercolor",
    x: number, y: number, color: string, projector: Projector, unprojector: Unprojector,
    lineWidth: number, fov: number, w: number, h: number,
  ): Brush | Pen | ChalkBrush | FountainPenBrush | WatercolorBrush {
    switch (toolType) {
      case "marker": return new Brush(x, y, color, projector, unprojector, lineWidth * 4, lineWidth, fov);
      case "crayon": return new ChalkBrush(x, y, color, projector, unprojector, lineWidth, fov, w, h);
      case "fountainPen": return new FountainPenBrush(x, y, color, projector, unprojector, lineWidth, fov, w, h);
      case "watercolor": return new WatercolorBrush(x, y, color, projector, unprojector, lineWidth, fov, w, h);
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
    realtime.send({ t: "stroke_point", u: pts[pts.length - 4], v: pts[pts.length - 3], pts });
  }

  addPoint(pixelX: number, pixelY: number): void {
    if (!this.viewer) return;

    const dx = pixelX - this.lastPixelX;
    const dy = pixelY - this.lastPixelY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < 2) return;

    this._strokeHasMovement = true;
    this.lastPixelX = pixelX;
    this.lastPixelY = pixelY;

    // Cycle rainbow color each stroke segment for live drawing
    if (this._isRainbowStroke) {
      const newColor = resolveRainbowColor();
      if (this.brush) this.brush.updateColor(newColor);
      if (this.pen) this.pen.updateColor(newColor);
    }

    // Broadcast point in basic coords (throttled internally). Surface strokes share their
    // brush samples instead (updateDecalPosition).
    if (this._activeDecal) return;
    this.viewer.unprojectToBasic([pixelX, pixelY]).then((basic) => {
      if (basic) {
        this.broadcastStrokePoint(basic[0], basic[1]);
      }
    });
  }

  setStrokeInkCost(cost: number): void {
    this._pendingInkCost = cost;
  }

  async endStroke(): Promise<void> {
    if (this.isMarkerActive && this.brush) {
      this.brush.endStroke();
      this.isMarkerActive = false;

      if (this._strokeHasMovement) {
        const brushStrokeId = this.brush.getStrokeId();
        const dec = this._activeDecal;
        this.dyingStrokes.push({
          brush: this.brush,
          brushStrokeId: brushStrokeId || undefined,
          fov: dec ? dec.fov : this.currentFov,
          lastX: dec ? dec.x : this.lastPixelX,
          lastY: dec ? dec.y : this.lastPixelY,
          decal: dec ?? undefined,
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
        const dec = this._activeDecal;
        this.dyingPenStrokes.push({
          pen: this.pen,
          fov: dec ? dec.fov : this.currentFov,
          lastX: dec ? dec.x : this.lastPixelX,
          lastY: dec ? dec.y : this.lastPixelY,
          decal: dec ?? undefined,
        });
      } else {
        this.pen.dispose();
      }

      this.pen = null;
    }

    this._activeDecal = null;
    this.flushStrokeSamples(true);
    this.broadcastStrokeEnd();
  }

  /** Upload a canvas as PNG to Supabase Storage and return the public URL. */
  private async uploadCanvasToStorage(
    canvas: HTMLCanvasElement,
    strokeId: string,
  ): Promise<string | null> {
    // Use WebP for ~5-10x smaller files vs PNG (with transparency support).
    // Try WebP first; if browser doesn't support it, the blob type won't match.
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.85),
    );
    const isWebP = blob?.type === 'image/webp';
    const finalBlob = isWebP ? blob : await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!finalBlob) return null;
    const ext = isWebP ? 'webp' : 'png';

    const path = `strokes/${strokeId}.${ext}`;
    const { error } = await supabase.storage
      .from("stroke-images")
      .upload(path, finalBlob, {
        contentType: finalBlob.type,
        upsert: true,
        cacheControl: "31536000",
      });

    if (error) {
      console.error("Failed to upload stroke image:", error);
      return null;
    }

    const { data: urlData } = supabase.storage
      .from("stroke-images")
      .getPublicUrl(path);
    return urlData?.publicUrl || null;
  }

  private getGridBBox(gridBasic: [number, number][][]): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const row of gridBasic) {
      for (const [x, y] of row) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return { minX, minY, maxX, maxY };
  }

  private async invalidateCompositeCache(imageId: string): Promise<void> {
    await supabase.from("composite_cache").delete().eq("image_id", imageId);
    supabase.storage.from("composite-cache").remove([`composites/${imageId}.webp`]);
  }

  private async generateAndUploadComposite(): Promise<void> {
    if (!this._imageId || this.markerTextures.length === 0) return;
    if (this._compositeGenerating) return;

    this._compositeGenerating = true;
    const imageId = this._imageId;
    try {
      const W = 2048, H = 1024;
      const compositeCanvas = document.createElement("canvas");
      compositeCanvas.width = W;
      compositeCanvas.height = H;
      const ctx = compositeCanvas.getContext("2d")!;
      ctx.clearRect(0, 0, W, H);

      let strokeCount = 0;

      for (const tex of this.markerTextures) {
        if (tex.pendingDelete || tex.fadingOut) continue;
        if (tex === this._compositeTexture) continue;
        const src = tex.canvas || tex.image;
        if (!src) continue;

        const bbox = this.getGridBBox(tex.gridBasic);
        const dx = Math.floor(bbox.minX * W);
        const dy = Math.floor(bbox.minY * H);
        const dw = Math.max(1, Math.ceil((bbox.maxX - bbox.minX) * W));
        const dh = Math.max(1, Math.ceil((bbox.maxY - bbox.minY) * H));

        ctx.drawImage(src, dx, dy, dw, dh);
        strokeCount++;
      }

      if (strokeCount === 0 || this._imageId !== imageId) {
        compositeCanvas.width = 0;
        compositeCanvas.height = 0;
        return;
      }

      const blob = await new Promise<Blob | null>((r) =>
        compositeCanvas.toBlob(r, "image/webp", 0.85),
      );
      if (!blob || this._imageId !== imageId) {
        compositeCanvas.width = 0;
        compositeCanvas.height = 0;
        return;
      }

      const path = `composites/${imageId}.webp`;
      const { error } = await supabase.storage
        .from("composite-cache")
        .upload(path, blob, {
          contentType: "image/webp",
          upsert: true,
          cacheControl: "3600",
        });

      if (error) {
        console.error("Failed to upload composite:", error);
        compositeCanvas.width = 0;
        compositeCanvas.height = 0;
        return;
      }

      const { data: urlData } = supabase.storage
        .from("composite-cache")
        .getPublicUrl(path);
      if (!urlData?.publicUrl) {
        compositeCanvas.width = 0;
        compositeCanvas.height = 0;
        return;
      }

      await supabase.from("composite_cache").upsert({
        image_id: imageId,
        storage_url: urlData.publicUrl,
        stroke_count: strokeCount,
        updated_at: new Date().toISOString(),
      });

      compositeCanvas.width = 0;
      compositeCanvas.height = 0;
    } catch (err) {
      console.error("Failed to generate composite:", err);
    } finally {
      this._compositeGenerating = false;
    }
  }

  getImageId(): string | null {
    return this._imageId;
  }

  /** Returns the basic-coord centers of all remote drawings. */
  getRemoteDrawingBasicCenters(): [number, number][] {
    const centers: [number, number][] = [];
    for (const tex of this.markerTextures) {
      if (tex.deviceId === deviceId) continue;
      if (!tex.gridBasic) continue;
      let sumX = 0, sumY = 0, count = 0;
      for (const row of tex.gridBasic) {
        for (const b of row) {
          sumX += b[0]; sumY += b[1]; count++;
        }
      }
      if (count === 0) continue;
      centers.push([sumX / count, sumY / count]);
    }
    return centers;
  }

  /** Capture/update a screenshot for this drawing. */
  async captureScreenshotForStar(authorDeviceId?: string): Promise<void> {
    if (!this._imageId) return;
    // If no authorDeviceId provided, try to get it from highlighted strokes
    if (!authorDeviceId) {
      for (const t of this.highlightedStrokes) {
        if (t.deviceId) { authorDeviceId = t.deviceId; break; }
      }
    }
    // Old strokes without device_id get grouped under 'legacy'
    if (!authorDeviceId) authorDeviceId = 'legacy';
    await this.captureScreenshot(authorDeviceId);
  }

  private async captureScreenshot(authorDeviceId?: string): Promise<void> {
    if (!this._imageId || !this._container) return;

    // Find Mapillary's canvas (exclude our drawing canvases)
    const myCanvases = new Set<HTMLCanvasElement>([this.canvas]);
    if (this.webglRenderer) {
      myCanvases.add(this.webglRenderer.getCanvas());
    }
    const allCanvases = this._container.querySelectorAll("canvas");
    let mapillaryCanvas: HTMLCanvasElement | null = null;
    for (const c of allCanvases) {
      if (!myCanvases.has(c)) {
        mapillaryCanvas = c;
        break;
      }
    }
    if (!mapillaryCanvas) return;

    // Temporarily clear selection highlight for clean screenshot
    const wasHighlighted = new Set<MarkerTexture>();
    for (const t of this.highlightedStrokes) {
      t.highlighted = false;
      wasHighlighted.add(t);
    }

    // Re-render with cleared highlights
    if (wasHighlighted.size > 0) {
      if (this.useWebGL && this.webglRenderer) {
        this.webglRenderer.clear();
        await this.renderMarkerTextures();
      } else {
        await this.renderMarkerTextures();
      }
    }

    // Find bounding box of all drawings in screen space to center the crop
    const srcW = mapillaryCanvas.width;
    const srcH = mapillaryCanvas.height;
    let minX = srcW, minY = srcH, maxX = 0, maxY = 0;
    let hasLocalBounds = false;
    for (const tex of this.markerTextures) {
      if (!tex.cachedProjection) continue;
      for (const row of tex.cachedProjection) {
        for (const p of row) {
          if (!p) continue;
          minX = Math.min(minX, p[0]);
          minY = Math.min(minY, p[1]);
          maxX = Math.max(maxX, p[0]);
          maxY = Math.max(maxY, p[1]);
          hasLocalBounds = true;
        }
      }
    }
    // Determine crop region — center on drawing with padding, maintain 3:4 aspect (matches Discover cards)
    const W = 300;
    const H = 400;
    const aspect = W / H;
    // Crop a 3:4 region from the canvas, centered on the drawing if possible
    let sw: number, sh: number, sx: number, sy: number;
    if (hasLocalBounds) {
      const drawW = maxX - minX;
      const drawH = maxY - minY;
      // Add generous padding — 3x the drawing size, min 400px
      const padW = Math.max(drawW * 3, 400);
      const padH = Math.max(drawH * 3, 300);
      // Enforce 3:4 aspect ratio
      if (padW / padH > aspect) {
        sw = padW;
        sh = padW / aspect;
      } else {
        sh = padH;
        sw = padH * aspect;
      }
    } else {
      // No bounding box — use as much of the canvas as possible at 3:4
      sw = srcW;
      sh = srcH;
    }
    // Enforce 3:4 aspect ratio and clamp to canvas, preserving ratio
    if (sw / sh > aspect) {
      // Too wide — narrow it
      sw = sh * aspect;
    } else {
      // Too tall — shorten it
      sh = sw / aspect;
    }
    if (sw > srcW) { sw = srcW; sh = sw / aspect; }
    if (sh > srcH) { sh = srcH; sw = sh * aspect; }
    // Center on drawing if we have bounds, otherwise center on canvas
    if (hasLocalBounds) {
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      sx = Math.max(0, Math.min(cx - sw / 2, srcW - sw));
      sy = Math.max(0, Math.min(cy - sh / 2, srcH - sh));
    } else {
      sx = (srcW - sw) / 2;
      sy = (srcH - sh) / 2;
    }

    const offscreen = document.createElement("canvas");
    offscreen.width = W;
    offscreen.height = H;
    const ctx = offscreen.getContext("2d")!;

    // Draw in z-order: Mapillary → WebGL drawing → 2D drawing (cropped to drawing region)
    // (preserveDrawingBuffer:true is forced on Mapillary's GL context in App.tsx)
    try {
      ctx.drawImage(mapillaryCanvas, sx, sy, sw, sh, 0, 0, W, H);
    } catch (e) {
      return; // tainted canvas
    }
    if (this.webglRenderer) {
      try {
        const glCanvas = this.webglRenderer.getCanvas();
        const scaleX = glCanvas.width / srcW;
        const scaleY = glCanvas.height / srcH;
        ctx.drawImage(glCanvas, sx * scaleX, sy * scaleY, sw * scaleX, sh * scaleY, 0, 0, W, H);
      } catch {}
    }
    try {
      const scaleX = this.canvas.width / srcW;
      const scaleY = this.canvas.height / srcH;
      ctx.drawImage(this.canvas, sx * scaleX, sy * scaleY, sw * scaleX, sh * scaleY, 0, 0, W, H);
    } catch {}

    // Restore selection highlight and re-render
    for (const t of wasHighlighted) t.highlighted = true;
    if (wasHighlighted.size > 0) {
      if (this.useWebGL && this.webglRenderer) {
        this.webglRenderer.clear();
        await this.renderMarkerTextures();
      } else {
        await this.renderMarkerTextures();
      }
    }

    let blob: Blob | null;
    try {
      blob = await new Promise<Blob | null>((resolve) =>
        offscreen.toBlob(resolve, "image/jpeg", 0.8),
      );
    } catch (e) {
      return;
    }
    if (!blob) return;

    const screenshotDeviceIdForPath = authorDeviceId || 'local';
    const path = `screenshots/${this._imageId}_${screenshotDeviceIdForPath}.jpg`;
    const { error: uploadError } = await supabase.storage.from("screenshots").upload(path, blob, {
      contentType: "image/jpeg",
      upsert: true,
      cacheControl: "31536000",
    });
    if (uploadError) return;

    const { data: urlData } = supabase.storage
      .from("screenshots")
      .getPublicUrl(path);
    const screenshotUrl = urlData?.publicUrl;
    if (!screenshotUrl) return;

    // Add cache-busting timestamp to the URL for display freshness
    const urlWithTs = `${screenshotUrl}?t=${Date.now()}`;
    const screenshotDeviceId = authorDeviceId || 'local';
    const { error: upsertError } = await supabase.from("screenshots").upsert(
      {
        image_id: this._imageId,
        device_id: screenshotDeviceId,
        screenshot_url: urlWithTs,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "image_id,device_id" },
    );
    if (upsertError) return;
  }

  private async saveStrokeTexture(
    texture: MarkerTexture,
    toolType: "pencil" | "marker" | "crayon" | "fountainPen" | "watercolor",
  ): Promise<void> {
    if (!this._imageId) return;
    // Database off (local mode): strokes are shared live only, nothing is uploaded or stored.
    if (LOCAL_MODE) return;

    // Generate a UUID for the stroke so we can upload the image first
    const strokeId = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
      /[xy]/g,
      (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      },
    );

    texture.supabaseId = strokeId;
    this._loadedStrokeIds.add(strokeId);
    this._localSupabaseIds.add(strokeId);

    // Upload image to Storage first
    const url = await this.uploadCanvasToStorage(texture.canvas!, strokeId);
    if (!url) {
      console.error("Failed to upload stroke image, aborting save");
      return;
    }

    const strokeData = {
      id: strokeId,
      image_id: this._imageId,
      canvas_data: url, // DB gets the real URL right away
      grid_basic: texture.gridBasic,
      grid_rows: texture.gridRows,
      grid_cols: texture.gridCols,
      src_width: texture.srcWidth,
      src_height: texture.srcHeight,
      reference_fov: texture.referenceFov,
      tool_type: toolType,
      color: texture.isRainbow ? "rainbow" : "#000",
      points: [],
      device_id: deviceId,
    };

    const { error } = await supabase.from("strokes").insert(strokeData);
    if (error) {
      console.error("Failed to save stroke:", error);
      return;
    }

    // Invalidate composite cache — new stroke added
    if (this._imageId) this.invalidateCompositeCache(this._imageId);

    // Schedule screenshot capture — use rAF chain so Mapillary has rendered
    this._pendingScreenshotFrames++;
    const captureId = this._pendingScreenshotFrames;
    let framesLeft = 3;
    const tick = () => {
      // Abort if a newer stroke reset the counter
      if (this._pendingScreenshotFrames !== captureId) return;
      if (--framesLeft > 0) {
        requestAnimationFrame(tick);
      } else {
        this.captureScreenshot(deviceId);
      }
    };
    requestAnimationFrame(tick);
  }

  private startRenderLoop(): void {
    if (this.animationFrameId !== null) return;

    const loop = async () => {
      // Keep running if we have anything active
      if (
        !this.isMarkerActive &&
        !this.isPencilActive &&
        this.dyingStrokes.length === 0 &&
        this.dyingPenStrokes.length === 0 &&
        this.finalizingStrokes.length === 0 &&
        this.finalizingPenStrokes.length === 0 &&
        this.pendingTextures.length === 0 &&
        this.pendingPenTextures.length === 0 &&
        this.activeDrops.length === 0 &&
        this.activeSplashes.length === 0 &&
        !this.markerTextures.some((t) => t.fadingOut)
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

      // Animate fading-out textures
      const FADE_DURATION = 500;
      const now = Date.now();
      this.markerTextures = this.markerTextures.filter((tex) => {
        if (!tex.fadingOut) return true;
        const elapsed = now - (tex.fadeStartTime ?? now);
        const t = Math.min(elapsed / FADE_DURATION, 1);
        tex.opacity = 1 - t;
        return t < 1;
      });

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
            // On a 3D surface the splatters stay inside the brush: it paints them into the decal,
            // so they lie on the surface, get lit, and are baked into the stroke for good.
            if (!stroke.decal) this.activeSplashes.push(...stroke.brush.extractSplashes());

            // Disable simulation for finalization phase
            stroke.brush.dripping = false;
            stroke.brush.splashing = false;

            this.finalizingStrokes.push(stroke);

            // Finalize in background
            const capturedInkCost = this._pendingInkCost;
            this.finalizeStroke(stroke)
              .then((tex) => {
                this.pendingTextures.push({ stroke, texture: tex as any });
                if (tex) {
                  tex.brushStrokeId = stroke.brushStrokeId;
                  tex.inkCost = capturedInkCost;
                  if (this._isRainbowStroke) {
                    tex.isRainbow = true;
                    this._startRainbowAnimationLoop();
                  }
                  if (this._guestMode) {
                    this._unsavedGuestTextures.push({ texture: tex, toolType: "marker" });
                  } else {
                    this.saveStrokeTexture(tex, "marker");
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
          if (stroke.decal) await this.renderDecalLive(stroke.brush, stroke.decal);
          else await this.renderShaded(stroke.brush, stroke.lastX, stroke.lastY, stroke.fov);
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
        if (!this._activeDecal) this.activeSplashes.push(...this.brush.extractSplashes());

        if (this._activeDecal) {
          if (!this.updateDecalPosition(this._activeDecal, this.lastPixelX, this.lastPixelY) && this._strokeHasMovement) {
            this.chainDecalStroke();
          } else {
            await this.renderDecalLive(this.brush, this._activeDecal);
          }
        } else {
          await this.renderShaded(this.brush, this.lastPixelX, this.lastPixelY, this.currentFov);
        }
      }

      // Render highlight outlines AFTER everything (including active brush) so they appear on top
      if (
        this.useWebGL &&
        this.webglRenderer &&
        this.highlightedStrokes.size > 0
      ) {
        for (const tex of this.markerTextures) {
          if (!tex.highlighted || !tex.cachedProjection) continue;
          if (tex._glTriCount && tex._glPositions && tex._glTexCoords) {
            const highlightCanvas = this.getOrCreateSilhouette(tex);
            this.webglRenderer.drawTexturedTriangleBatch(
              highlightCanvas,
              tex._glPositions,
              tex._glTexCoords,
              1,
              true,
            );
          }
        }
      }

      // Process dying pen strokes -> finalize to textures
      for (let i = this.dyingPenStrokes.length - 1; i >= 0; i--) {
        const stroke = this.dyingPenStrokes[i];
        if (stroke.pen) {
          this.finalizingPenStrokes.push(stroke);

          // Finalize pen stroke in background
          const penToolType =
            this._currentToolType === "marker"
              ? "pencil"
              : this._currentToolType;
          const capturedPenInkCost = this._pendingInkCost;
          this.finalizePenStroke(stroke)
            .then((tex) => {
              this.pendingPenTextures.push({ stroke, texture: tex as any });
              if (tex) {
                tex.inkCost = capturedPenInkCost;
                if (this._isRainbowStroke) {
                  tex.isRainbow = true;
                  this._startRainbowAnimationLoop();
                }
                if (this._guestMode) {
                  this._unsavedGuestTextures.push({ texture: tex, toolType: penToolType });
                } else {
                  this.saveStrokeTexture(tex, penToolType);
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
        if (stroke.decal) await this.renderDecalLive(stroke.pen, stroke.decal);
        else await this.renderShaded(stroke.pen, stroke.lastX, stroke.lastY, stroke.fov);
      }

      // Render active pen
      if (this.isPencilActive && this.pen) {
        // Update rainbow color every frame so hue animates continuously
        if (this._isRainbowStroke) this.pen.updateColor(resolveRainbowColor());

        if (this._activeDecal) {
          if (!this.updateDecalPosition(this._activeDecal, this.lastPixelX, this.lastPixelY) && this._strokeHasMovement) {
            this.chainDecalStroke();
          } else {
            await this.renderDecalLive(this.pen, this._activeDecal);
          }
        } else {
          await this.renderShaded(this.pen, this.lastPixelX, this.lastPixelY, this.currentFov);
        }
      }

      this.animationFrameId = requestAnimationFrame(loop);
    };
    loop();
  }

  private async finalizeStroke(stroke: {
    brush: Brush;
    lastX: number;
    lastY: number;
    fov: number;
    decal?: DecalState;
  }): Promise<MarkerTexture | null> {
    if (!this.viewer) return null;
    if (stroke.decal) return this.finalizeDecalStroke(stroke.brush, stroke.decal);

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
    decal?: DecalState;
  }): Promise<MarkerTexture | null> {
    if (!this.viewer) return null;
    if (stroke.decal) return this.finalizeDecalStroke(stroke.pen, stroke.decal);

    const isWatercolor = stroke.pen instanceof WatercolorBrush;

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = this.canvas.width;
    tempCanvas.height = this.canvas.height;
    const tempCtx = tempCanvas.getContext("2d")!;

    await stroke.pen.render(tempCtx, stroke.lastX, stroke.lastY, stroke.fov);

    // Also render a clean smooth version for highlight outline
    const silhouetteTempCanvas = document.createElement("canvas");
    silhouetteTempCanvas.width = this.canvas.width;
    silhouetteTempCanvas.height = this.canvas.height;
    const silhouetteTempCtx = silhouetteTempCanvas.getContext("2d")!;
    await stroke.pen.renderSmooth(
      silhouetteTempCtx,
      stroke.lastX,
      stroke.lastY,
      stroke.fov,
    );

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

    // Crop silhouette canvas with same bounds
    const silhouetteCropped = document.createElement("canvas");
    silhouetteCropped.width = width;
    silhouetteCropped.height = height;
    const silhouetteCroppedCtx = silhouetteCropped.getContext("2d")!;
    silhouetteCroppedCtx.drawImage(
      silhouetteTempCanvas,
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
        silhouetteCanvas: silhouetteCropped,
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
      if (import.meta.env.DEV && (globalThis as any).__deepDebug) console.info(`[deep] flat @${pixelX | 0},${pixelY | 0}: ${r}`);
      return null;
    };
    if (!this._deepData) return why("no deep data");
    if (!this.canDrawDecals()) return why("no GPU support");
    const b = this.screenToBasic(pixelX, pixelY);
    if (!b) return why("no projection");
    const radPerPx = ((this.currentFov * Math.PI) / 180) / Math.max(1, this.canvas.height);
    const st = this.makeDecalAt(b, radPerPx, worldPerPx, false, this._strokeParams?.toolType ?? "pencil", this._strokeGroup, this.currentFov);
    if (!st) return why("no surface (sky)");
    if (import.meta.env.DEV && (globalThis as any).__deepDebug) console.info(`[deep] wrap @${pixelX | 0},${pixelY | 0}${worldPerPx ? " (chained)" : ""}`);
    return st;
  }

  private canDrawDecals(): boolean {
    return !!(this._deepData && this.useWebGL && this.webglRenderer?.hasGPUProjection() && this.webglRenderer.hasDeepStrokes());
  }

  /**
   * A surface decal starting at panorama point b. Deterministic for the same inputs, which is
   * what lets other people rebuild exactly the drawer's decal (exact = use worldPerPx as is).
   */
  private makeDecalAt(
    b: [number, number], radPerPx: number, worldPerPx: number | undefined, exact: boolean,
    toolType: keyof typeof DEEP_NEAR_RADIUS, group: number, fov: number,
  ): DecalState | null {
    if (!this._deepData) return null;
    const decal = SurfaceDecal.create(this._deepData, b[0], b[1], radPerPx, worldPerPx, exact);
    if (!decal) return null;
    const geo = new GeodesicMap(this._deepData, b[0], b[1], decal.basis);
    geo.remember(geo.cx, geo.cy, [b[0], b[1]]);
    geo.expand(80 * geo.s); // a little head start around the start point
    const near = DEEP_NEAR_RADIUS[toolType] ?? 14;
    geo.markNear(b[0], b[1], near * geo.s);
    const toolCrop = document.createElement("canvas");
    toolCrop.width = toolCrop.height = 1;
    return {
      geo,
      surface: this._deepData.surface,
      toolCrop,
      toolRect: [0, 0, 1, 1],
      hasLive: false,
      toolVersion: 0,
      geom: null,
      x: geo.cx,
      y: geo.cy,
      fov,
      offFrames: 0,
      group,
      nearRadius: near,
      prev: { basic: [b[0], b[1]], decal: [geo.cx, geo.cy] },
      start: [b[0], b[1]],
    };
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

  /** Is this panorama point sky (no depth = nothing to paint)? False without depth data. */
  private isSkyAtBasic(u: number, v: number): boolean {
    const d = this._deepData;
    if (!d) return false;
    const x = ((Math.floor(u * 2048) % 2048) + 2048) % 2048;
    const y = Math.min(1023, Math.max(0, Math.floor(v * 1024)));
    return !(d.dist[y * 2048 + x] > 0);
  }

  /** Is this screen point on the sky (no paintable surface)? */
  private isSkyAt(x: number, y: number): boolean {
    const d = this._deepData;
    if (!d) return false;
    const b = this.screenToBasic(x, y);
    if (!b) return false;
    const i = Math.min(1023, Math.max(0, Math.floor(b[1] * 1024)));
    const j = ((Math.floor(b[0] * 2048) % 2048) + 2048) % 2048;
    return !(d.dist[i * 2048 + j] > 0);
  }

  /**
   * Move the decal-space tool position to follow the cursor. Returns false when the cursor has left
   * this decal's surface (corner, curve, other object) — the caller then chains a new decal.
   */
  private updateDecalPosition(st: DecalState, screenX: number, screenY: number): boolean {
    const b = this.screenToBasic(screenX, screenY);
    if (!b) return true;
    const moved = this.moveDecalTo(st, b);
    if (moved && st === this._activeDecal && (st.x !== this._lastSample[0] || st.y !== this._lastSample[1])) {
      // the brush will render at this new spot: share it so others replay the exact same stroke
      this._lastSample = [st.x, st.y];
      this._pendingSamples.push(b[0], b[1], st.x, st.y);
      this.flushStrokeSamples();
    }
    return moved;
  }

  /** Brush samples (u, v, decal x, y) not yet sent, and the last one recorded. */
  private _pendingSamples: number[] = [];
  private _lastSample: [number, number] = [NaN, NaN];

  /**
   * Move a decal's tool position to panorama point b (the cursor). known = the decal position the
   * drawer computed (replaying someone else's stroke), so the brush sees exactly their samples.
   */
  private moveDecalTo(st: DecalState, b: [number, number], known?: [number, number]): boolean {
    if (!st.geo.isSurface(b[0], b[1]) && !known) return true; // over the sky: pause, never chain into it
    const reached = st.geo.reach(b[0], b[1], 30000);
    const d = known ?? reached;
    if (!d) {
      // not reachable along the surface (crossed onto a separate object)
      return ++st.offFrames < 3;
    }
    st.offFrames = 0;
    st.x = d[0];
    st.y = d[1];
    st.geo.remember(d[0], d[1], b);
    // grow a margin around the cursor so the brush footprint is always covered, and mark the
    // surface around the drawn path as paintable
    st.geo.expand(st.geo.geoAt(b[0], b[1]) + 80 * st.geo.s, 20000);
    // Mark the paintable area along the whole segment since the last sample, not just at the
    // sample — fast moves put samples further apart than the brush, which left gaps.
    const radius = st.nearRadius * st.geo.s;
    const prev = st.prev;
    if (prev) {
      const len = Math.hypot(d[0] - prev.decal[0], d[1] - prev.decal[1]);
      const steps = Math.min(64, Math.ceil(len / (st.nearRadius * 0.5)));
      let du = b[0] - prev.basic[0];
      if (du > 0.5) du -= 1;
      else if (du < -0.5) du += 1;
      const dv = b[1] - prev.basic[1];
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        const u = prev.basic[0] + du * t, v = prev.basic[1] + dv * t;
        if (st.geo.reach(u, v, 5000)) st.geo.markNear(u, v, radius);
      }
    }
    st.geo.markNear(b[0], b[1], radius);
    st.prev = { basic: [b[0], b[1]], decal: [d[0], d[1]] };
    return true;
  }

  /**
   * The cursor moved onto a different surface: finish the current segment and continue the same
   * stroke (tool, colour, width) on a new decal fitted to the surface under the cursor.
   */
  private chainDecalStroke(): void {
    const params = this._strokeParams;
    if (!params) return;
    const x = this.lastPixelX, y = this.lastPixelY;
    // The surface unwrap already bends around corners/curves; we only get here when the cursor
    // moved onto a separate object (across a depth jump). Continue the stroke there at the same
    // on-screen brush size (what the cursor shows); if that fails, keep drawing on the current surface.
    const next = this.makeDecal(x, y);
    if (!next) return;
    void this.endStroke();
    this._chainDecal = next;
    this.startStroke(x, y, params.color, params.lineWidth, params.toolType);
  }

  /** Crop rectangle (decal px) around a tool's current bounds. */
  private decalCrop(tool: { getBounds(): { minX: number; minY: number; maxX: number; maxY: number } }, size: number) {
    const pad = tool instanceof WatercolorBrush ? 150 : 50;
    const b = tool.getBounds();
    const x0 = Math.max(0, Math.floor(b.minX - pad)), y0 = Math.max(0, Math.floor(b.minY - pad));
    const x1 = Math.min(size, Math.ceil(b.maxX + pad)), y1 = Math.min(size, Math.ceil(b.maxY + pad));
    return { x0, y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Splatters land away from the path: grow the unwrap out to them and let paint show there. */
  private openSplashes(tool: unknown, st: DecalState): void {
    if (!(tool instanceof Brush)) return;
    const g = st.geo;
    for (const sp of tool.takeNewSplashes()) {
      if (sp.x === undefined || sp.y === undefined) continue;
      g.expand((Math.hypot(sp.x - g.cx, sp.y - g.cy) * 1.3 + 24) * g.s, 20000);
      const b = g.basicAt(sp.x, sp.y);
      if (b) g.markNear(b[0], b[1], (sp.radius + 2) * g.s);
    }
  }

  /** Render a live decal stroke: tool -> decal canvas -> crop uploaded to the GPU (drawn by the shader). */
  private async renderDecalLive(
    tool: { render(ctx: CanvasRenderingContext2D, x: number, y: number, fov: number): unknown; getBounds(): { minX: number; minY: number; maxX: number; maxY: number } },
    st: DecalState,
  ): Promise<void> {
    if (!this.webglRenderer) return;
    const size = st.geo.size;
    this.openSplashes(tool, st);
    // Draw the tool straight into a small canvas covering just the stroke (+ room to grow), via a
    // translate — instead of clearing and cropping a full 2048x2048 canvas every frame.
    const crop = this.decalCrop(tool, size);
    if (crop.w <= 0 || crop.h <= 0 || !isFinite(crop.w) || !isFinite(crop.h)) return;
    const GROW = 96;
    const x0 = Math.max(0, crop.x0 - GROW), y0 = Math.max(0, crop.y0 - GROW);
    const w = Math.min(size, crop.x0 + crop.w + GROW) - x0, h = Math.min(size, crop.y0 + crop.h + GROW) - y0;
    // only reallocate when it must grow (resizing a canvas is expensive)
    const cw = Math.ceil(w / 128) * 128, ch = Math.ceil(h / 128) * 128;
    if (st.toolCrop.width < w || st.toolCrop.height < h || st.toolCrop.width > cw * 2 || st.toolCrop.height > ch * 2) {
      st.toolCrop.width = cw;
      st.toolCrop.height = ch;
    }
    const cctx = st.toolCrop.getContext("2d")!;
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.clearRect(0, 0, st.toolCrop.width, st.toolCrop.height);
    cctx.setTransform(1, 0, 0, 1, -x0, -y0);
    await tool.render(cctx, st.x, st.y, st.fov);
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    st.toolRect = [x0, y0, st.toolCrop.width, st.toolCrop.height];
    st.toolVersion++;
    st.hasLive = true;
  }

  /** Live (in-progress / finishing) 3D strokes to draw this frame. */
  private liveDecals(): DecalState[] {
    const out: DecalState[] = [];
    const add = (st?: DecalState | null) => {
      if (st && st.hasLive) out.push(st);
    };
    add(this._activeDecal);
    for (const list of this._replays.values()) for (const r of list) if (!r.dead) add(r.st);
    for (const s of this.finalizingStrokes) add(s.decal);
    for (const s of this.finalizingPenStrokes) add(s.decal);
    for (const s of this.dyingStrokes) add(s.decal);
    for (const s of this.dyingPenStrokes) add(s.decal);
    return out;
  }

  /** Draw live 3D strokes with the deep shader (projection uniforms already set this frame). */
  private drawLiveDecals(live: DecalState[]): void {
    const r = this.webglRenderer;
    if (!r) return;
    for (const st of live) {
      const g = st.geo, bb = g.bbox;
      if (!isFinite(bb.r0)) continue;
      // geometry covering the reached area (rebuilt only when it grows)
      const key = `${bb.r0},${bb.c0},${bb.r1},${bb.c1}`;
      if (!st.geom || st.geom.key !== key) {
        const r0 = bb.r0, c0 = bb.c0, r1 = bb.r1 + 1, c1 = bb.c1 + 1;
        const rows = Math.max(1, Math.min(32, Math.ceil((r1 - r0) / 16)));
        const cols = Math.max(1, Math.min(32, Math.ceil((c1 - c0) / 16)));
        const basic = new Float32Array(rows * cols * 12), tex = new Float32Array(rows * cols * 12);
        let k = 0;
        const put = (gr: number, gc: number) => {
          const rr = r0 + (gr / rows) * (r1 - r0), cc = c0 + (gc / cols) * (c1 - c0);
          basic[k] = (g.j0 + cc) / 2048; basic[k + 1] = (g.i0 + rr) / 1024;
          tex[k] = cc / g.RW; tex[k + 1] = rr / g.RH;
          k += 2;
        };
        for (let gr = 0; gr < rows; gr++) for (let gc = 0; gc < cols; gc++) {
          put(gr, gc); put(gr + 1, gc); put(gr, gc + 1);
          put(gr, gc + 1); put(gr + 1, gc); put(gr + 1, gc + 1);
        }
        st.geom = { key, basic, tex };
      }
      r.drawDeepStroke({
        key: g,
        dem: g.tex,
        regionW: g.RW,
        regionH: g.RH,
        regionOrigin: [g.j0, g.i0],
        dirty: g.dirty,
        basicCoords: st.geom.basic,
        texCoords: st.geom.tex,
        tool: st.toolCrop,
        toolVersion: st.toolVersion,
        toolRect: st.toolRect,
        surface: st.surface,
        panoW: 2048,
        panoH: 1024,
      });
      g.dirty = null;
    }
  }

  /** Finish a 3D stroke: bake the decal-space drawing into an equirect bitmap + panorama grid. */
  private async finalizeDecalStroke(
    tool: Brush | Pen | ChalkBrush | FountainPenBrush | WatercolorBrush,
    st: DecalState,
  ): Promise<MarkerTexture | null> {
    const size = st.geo.size;
    const tmp = document.createElement("canvas");
    tmp.width = tmp.height = size;
    const tctx = tmp.getContext("2d", { willReadFrequently: true })!;
    await tool.render(tctx, st.x, st.y, st.fov);
    this.openSplashes(tool, st);
    const rect = this.decalCrop(tool, size);
    const release = () => {
      this.webglRenderer?.releaseDeepStroke(st.geo);
      st.geo.release();
    };
    if (rect.w <= 0 || rect.h <= 0) {
      tool.dispose();
      release();
      return null;
    }
    const baked = st.geo.bake(tctx.getImageData(rect.x0, rect.y0, rect.w, rect.h), rect, st.surface);
    let silhouette: HTMLCanvasElement | undefined;
    if (baked && !(tool instanceof Brush)) {
      const sc = document.createElement("canvas");
      sc.width = sc.height = size;
      const sctx = sc.getContext("2d", { willReadFrequently: true })!;
      await tool.renderSmooth(sctx, st.x, st.y, st.fov);
      silhouette = st.geo.bake(sctx.getImageData(rect.x0, rect.y0, rect.w, rect.h), rect, null, 1)?.canvas;
    }
    tool.dispose();
    if (!baked) {
      release();
      return null;
    }
    const toolType =
      tool instanceof Brush ? undefined
      : tool instanceof WatercolorBrush ? ("watercolor" as const)
      : tool instanceof ChalkBrush ? ("crayon" as const)
      : tool instanceof FountainPenBrush ? ("fountainPen" as const)
      : ("pencil" as const);
    // keep the live GPU stroke visible until the baked texture takes over next frame
    setTimeout(release, 500);
    return {
      canvas: baked.canvas,
      silhouetteCanvas: silhouette,
      toolType,
      gridBasic: baked.gridBasic,
      gridRows: baked.rows,
      gridCols: baked.cols,
      srcWidth: baked.canvas.width,
      srcHeight: baked.canvas.height,
      referenceFov: st.fov,
      strokeGroup: st.group,
    };
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
    // Undone guest strokes must not block navigation or be saved after signing in.
    this._unsavedGuestTextures = this._unsavedGuestTextures.filter(item => item.texture !== tex);

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

    // Delete from Supabase
    if (tex.supabaseId) {
      supabase
        .from("strokes")
        .delete()
        .eq("id", tex.supabaseId)
        .then(({ error }) => {
          if (error) console.error("Failed to delete stroke on undo:", error);
        });
    }

    // Invalidate composite cache — stroke removed
    if (this._imageId) this.invalidateCompositeCache(this._imageId);
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

    // Re-save to Supabase + upload to Storage
    this.saveStrokeTexture(tex, tex.toolType || "marker");
    // ...and put it back for everyone in the live room (same id)
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
    if (this._imageId) this.invalidateCompositeCache(this._imageId);
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
      if (!tex.isLocal || tex.fadingOut) continue;
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
        tex.silhouetteCanvas = undefined; // rebuilt from the trimmed bitmap if ever needed
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
   * trimmed; the whole gesture becomes one undo step. Returns the ink of fully erased strokes.
   */
  finalizeEraser(): number {
    this._lastErase = null;
    const session = this._eraseSession;
    this._eraseSession = null;
    if (!session) return 0;
    let inkRefund = 0;
    const removed: MarkerTexture[] = [];
    for (const [tex, item] of session.items) {
      if (!tex.canvas) continue;
      item.after = copyCanvas(tex.canvas);
      if (isBlank(tex.canvas)) {
        item.removed = true;
        removed.push(tex);
        inkRefund += tex.inkCost || 0;
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
    if (this._imageId) this.invalidateCompositeCache(this._imageId);
    this.render();
    return inkRefund;
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
    if (this._imageId) this.invalidateCompositeCache(this._imageId);
    this.render();
  }

  /** Get or lazily create the silhouette canvas for a pencil texture. */
  private getOrCreateSilhouette(tex: MarkerTexture): HTMLCanvasElement {
    if (
      !tex.silhouetteCanvas &&
      (tex.toolType === "pencil" || tex.toolType === "crayon" || tex.toolType === "fountainPen" || tex.toolType === "watercolor")
    ) {
      tex.silhouetteCanvas = this.createSilhouette(ensureCanvas(tex));
    }
    return tex.silhouetteCanvas || ensureCanvas(tex);
  }

  private createSilhouette(source: HTMLCanvasElement): HTMLCanvasElement {
    // Create a solid dilated version of the source for clean highlight outlines.
    // Draws the source image at multiple offsets to fill in roughjs gaps,
    // then composites to solid white.
    const spread = 3;
    const c = document.createElement("canvas");
    c.width = source.width;
    c.height = source.height;
    const ctx = c.getContext("2d")!;

    // Draw the source at multiple offsets to dilate
    for (let dy = -spread; dy <= spread; dy += 2) {
      for (let dx = -spread; dx <= spread; dx += 2) {
        if (dx * dx + dy * dy > (spread + 1) * (spread + 1)) continue;
        ctx.drawImage(source, dx, dy);
      }
    }

    // Convert everything to solid white (keep alpha, replace color)
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = "source-over";

    return c;
  }

  getMarkerTextureCount(): number {
    return this.markerTextures.length;
  }

  hitTestAt(pixelX: number, pixelY: number): Promise<MarkerTexture | null> {
    if (!this.viewer) return Promise.resolve(null);

    return this.viewer.unprojectToBasic([pixelX, pixelY]).then((basicPoint) => {
      if (!basicPoint) return null;

      const bx = basicPoint[0];
      const by = basicPoint[1];

      // Search in reverse order (top-most stroke first)
      for (let i = this.markerTextures.length - 1; i >= 0; i--) {
        const tex = this.markerTextures[i];
        if (tex.pendingDelete) continue;
        if (tex.deviceId === deviceId) continue; // Skip own drawings

        let hit = false;

        for (let r = 0; r < tex.gridRows && !hit; r++) {
          for (let c = 0; c < tex.gridCols && !hit; c++) {
            const tl = tex.gridBasic[r][c];
            const tr = tex.gridBasic[r][c + 1];
            const bl = tex.gridBasic[r + 1][c];
            const br = tex.gridBasic[r + 1][c + 1];

            const minX = Math.min(tl[0], tr[0], bl[0], br[0]);
            const maxX = Math.max(tl[0], tr[0], bl[0], br[0]);
            const minY = Math.min(tl[1], tr[1], bl[1], br[1]);
            const maxY = Math.max(tl[1], tr[1], bl[1], br[1]);

            const margin = 0.003;
            if (
              bx < minX - margin ||
              bx > maxX + margin ||
              by < minY - margin ||
              by > maxY + margin
            )
              continue;

            const cellWidth = tex.srcWidth / tex.gridCols;
            const cellHeight = tex.srcHeight / tex.gridRows;

            const rangeX = maxX - minX;
            const rangeY = maxY - minY;
            if (rangeX < 0.0001 || rangeY < 0.0001) continue;

            const u = (bx - minX) / rangeX;
            const v = (by - minY) / rangeY;

            const texX = Math.floor((c + u) * cellWidth);
            const texY = Math.floor((r + v) * cellHeight);

            if (
              texX < 0 ||
              texX >= tex.srcWidth ||
              texY < 0 ||
              texY >= tex.srcHeight
            )
              continue;

            const hitCanvas2 = ensureCanvas(tex);
            const ctx = hitCanvas2.getContext("2d");
            if (!ctx) continue;

            const sampleRadius = 4;
            const sampleX2 = Math.max(0, texX - sampleRadius);
            const sampleY2 = Math.max(0, texY - sampleRadius);
            const sampleW2 = Math.min(
              hitCanvas2.width - sampleX2,
              sampleRadius * 2 + 1,
            );
            const sampleH2 = Math.min(
              hitCanvas2.height - sampleY2,
              sampleRadius * 2 + 1,
            );
            if (sampleW2 > 0 && sampleH2 > 0) {
              const imageData2 = ctx.getImageData(
                sampleX2,
                sampleY2,
                sampleW2,
                sampleH2,
              ).data;
              for (let dy = 0; dy < sampleH2 && !hit; dy += 2) {
                for (let dx = 0; dx < sampleW2 && !hit; dx += 2) {
                  if (imageData2[(dy * sampleW2 + dx) * 4 + 3] > 10) {
                    hit = true;
                  }
                }
              }
            }
          }
        }

        if (hit) return tex;
      }

      return null;
    });
  }

  getRelatedStrokes(texture: MarkerTexture): MarkerTexture[] {
    if (texture.deviceId) {
      return this.markerTextures.filter((t) => t.deviceId === texture.deviceId);
    }

    // Fallback: group old strokes (no deviceId) by time proximity
    if (!texture.createdAt) return [texture];

    const clickedTime = new Date(texture.createdAt).getTime();
    return this.markerTextures.filter((t) => {
      if (t.deviceId) return false; // Only group strokes without deviceId
      if (!t.createdAt) return false;
      const tTime = new Date(t.createdAt).getTime();
      return Math.abs(tTime - clickedTime) < 60000; // 60 seconds
    });
  }

  selectStroke(texture: MarkerTexture): { strokeIds: string[]; authorDeviceId?: string } {
    this.clearSelection();
    const related = this.getRelatedStrokes(texture);
    const strokeIds: string[] = [];
    for (const t of related) {
      t.highlighted = true;
      this.highlightedStrokes.add(t);
      if (t.supabaseId) strokeIds.push(t.supabaseId);
    }
    this.render();
    return { strokeIds, authorDeviceId: texture.deviceId };
  }

  clearSelection(): void {
    if (this.highlightedStrokes.size === 0) return;
    for (const t of this.highlightedStrokes) {
      t.highlighted = false;
    }
    this.highlightedStrokes.clear();
    this.render();
  }

  async adminDeleteStrokes(strokeIds: string[]): Promise<void> {
    if (strokeIds.length === 0) return;

    const fadeStartTime = Date.now();
    for (const strokeId of strokeIds) {
      const tex = this.markerTextures.find((t) => t.supabaseId === strokeId);
      if (tex) {
        tex.fadingOut = true;
        tex.fadeStartTime = fadeStartTime;
      }
    }
    this.clearSelection();
    this.startRenderLoop();

    // Delete strokes and any associated reports from DB
    for (const strokeId of strokeIds) {
      await supabase.from("reports").delete().eq("stroke_id", strokeId);
      await supabase.from("strokes").delete().eq("id", strokeId);
    }

    // Invalidate composite cache — strokes deleted by admin
    if (this._imageId) this.invalidateCompositeCache(this._imageId);
  }

  async reportStrokes(strokeIds: string[]): Promise<boolean> {
    if (strokeIds.length === 0) return false;

    // Filter out self-reports
    const reportable = strokeIds.filter((id) => {
      const tex = this.markerTextures.find((t) => t.supabaseId === id);
      return !tex || tex.deviceId !== deviceId;
    });
    if (reportable.length === 0) return false;

    // Fade all reported textures out simultaneously
    const fadeStartTime = Date.now();
    for (const strokeId of reportable) {
      const tex = this.markerTextures.find((t) => t.supabaseId === strokeId);
      if (tex) {
        tex.fadingOut = true;
        tex.fadeStartTime = fadeStartTime;
      }
    }
    this.clearSelection();
    this.startRenderLoop();

    // Do DB work in the background
    (async () => {
      for (const strokeId of reportable) {
        const { error: insertError } = await supabase
          .from("reports")
          .insert({ stroke_id: strokeId, reporter_device_id: deviceId });

        if (insertError) continue; // Likely duplicate

        const { count, error: countError } = await supabase
          .from("reports")
          .select("*", { count: "exact", head: true })
          .eq("stroke_id", strokeId);

        if (!countError && count !== null && count >= 3) {
          await supabase.from("reports").delete().eq("stroke_id", strokeId);
          await supabase.from("strokes").delete().eq("id", strokeId);
          // Invalidate composite cache — stroke removed by reports
          if (this._imageId) this.invalidateCompositeCache(this._imageId);
        }
      }
    })();

    return true;
  }

  clearAll(): void {
    this.strokes = [];
    this.markerTextures = [];
    if (this.brush) {
      this.brush.dispose();
    }
    if (this.webglRenderer) {
      this.webglRenderer.clearTextureCache();
    }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private getSyncProjectionContext(): any {
    try {
      const viewerAny = this.viewer as any;
      if (!viewerAny?._observer?._projection) return null;
      if (!this._cachedRenderCamera || !this._cachedTransform) return null;

      const container =
        viewerAny._container?._container ??
        viewerAny._container?.container ??
        viewerAny._container?.element;
      if (!container) return null;

      return {
        renderCamera: this._cachedRenderCamera,
        transform: this._cachedTransform,
        container,
        proj: viewerAny._observer._projection,
      };
    } catch {
      return null;
    }
  }

  private syncProjectWithContext(
    basicPoint: number[],
    ctx: any,
  ): [number, number] | null | undefined {
    if (!ctx) return undefined;
    try {
      const canvasPoint = ctx.proj.basicToCanvas(
        basicPoint,
        ctx.container,
        ctx.renderCamera,
        ctx.transform,
      );
      if (canvasPoint) {
        return [Math.round(canvasPoint[0]), Math.round(canvasPoint[1])];
      }
      return null;
    } catch (e) {
      return undefined;
    }
  }

  private async renderMarkerTextures(): Promise<void> {
    const live = this.liveDecals();
    if (!this.viewer || (this.markerTextures.length === 0 && live.length === 0)) return;

    // ── GPU projection fast path ─────────────────────────────────────────
    // No per-texture JS projection — GPU transforms basic→screen in vertex shader
    if (this.useWebGL && this.webglRenderer?.hasGPUProjection()) {
      const gpuUniforms = this.getGPUProjectionUniforms();
      if (gpuUniforms) {
        this.webglRenderer.setGPUProjectionUniforms(gpuUniforms);

        // First pass: render highlight outlines behind highlighted textures
        for (const tex of this.markerTextures) {
          if (!tex.highlighted) continue;
          if (!tex._gpuBasicCoords) this.buildGPUGeometry(tex);
          if (!tex._gpuVertexCount) continue;

          const highlightCanvas = this.getOrCreateSilhouette(tex);
          this.webglRenderer.drawGPUProjectedBatch(
            highlightCanvas,
            tex._gpuBasicCoords!,
            tex._gpuTexCoords!,
            1,
            true,
            0,
          );
        }

        // Second pass: render all textures normally
        const hueShift = getRainbowHueShift();
        for (const tex of this.markerTextures) {
          if (!tex._gpuBasicCoords) this.buildGPUGeometry(tex);
          if (!tex._gpuVertexCount) continue;

          const texOpacity = tex.pendingDelete ? 0.4 : (tex.opacity ?? 1);
          this.webglRenderer.drawGPUProjectedBatch(
            texSource(tex),
            tex._gpuBasicCoords!,
            tex._gpuTexCoords!,
            texOpacity,
            false,
            tex.isRainbow ? hueShift : 0,
          );
        }
        this.drawLiveDecals(live);
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
            const syncPoint = this.syncProjectWithContext(
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
          if (this.useWebGL) this.buildGLGeometry(tex);
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
          if (this.useWebGL) this.buildGLGeometry(tex);
        }
      }
    }

    for (const tex of this.markerTextures) {
      if (!tex.cachedProjection) continue;
      const texOpacity = tex.pendingDelete ? 0.4 : (tex.opacity ?? 1);

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
              this.drawTexturedTriangle(
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
              this.drawTexturedTriangle(
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
        } catch {}
        this.ctx.globalAlpha = savedAlpha;
      }
    }
  }

  private drawTexturedTriangle(
    img: HTMLCanvasElement | HTMLImageElement,
    sx0: number,
    sy0: number,
    sx1: number,
    sy1: number,
    sx2: number,
    sy2: number,
    dx0: number,
    dy0: number,
    dx1: number,
    dy1: number,
    dx2: number,
    dy2: number,
  ): void {
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.moveTo(dx0, dy0);
    this.ctx.lineTo(dx1, dy1);
    this.ctx.lineTo(dx2, dy2);
    this.ctx.closePath();
    this.ctx.clip();

    const x0 = sx0,
      y0 = sy0;
    const x1 = sx1,
      y1 = sy1;
    const x2 = sx2,
      y2 = sy2;

    const u0 = dx0,
      v0 = dy0;
    const u1 = dx1,
      v1 = dy1;
    const u2 = dx2,
      v2 = dy2;

    const delta = x0 * (y1 - y2) + x1 * (y2 - y0) + x2 * (y0 - y1);
    if (Math.abs(delta) < 0.0001) {
      this.ctx.restore();
      return;
    }

    const deltaA = u0 * (y1 - y2) + u1 * (y2 - y0) + u2 * (y0 - y1);
    const deltaB = x0 * (u1 - u2) + x1 * (u2 - u0) + x2 * (u0 - u1);
    const deltaC =
      x0 * (y1 * u2 - y2 * u1) +
      x1 * (y2 * u0 - y0 * u2) +
      x2 * (y0 * u1 - y1 * u0);

    const deltaD = v0 * (y1 - y2) + v1 * (y2 - y0) + v2 * (y0 - y1);
    const deltaE = x0 * (v1 - v2) + x1 * (v2 - v0) + x2 * (v0 - v1);
    const deltaF =
      x0 * (y1 * v2 - y2 * v1) +
      x1 * (y2 * v0 - y0 * v2) +
      x2 * (y0 * v1 - y1 * v0);

    this.ctx.transform(
      deltaA / delta,
      deltaD / delta,
      deltaB / delta,
      deltaE / delta,
      deltaC / delta,
      deltaF / delta,
    );

    this.ctx.drawImage(img, 0, 0);
    this.ctx.restore();
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

    if (this.strokes.length === 0) return;

    const currentFov = await this.viewer.getFieldOfView();
    const syncCtx = this.getSyncProjectionContext();

    for (const stroke of this.strokes) {
      if (stroke.points.length < 2) continue;

      const fovScale = stroke.referenceFov / currentFov;
      const projectedPoints: Array<{ x: number; y: number; width: number }> =
        [];

      for (const point of stroke.points) {
        try {
          const pixelPoint = syncCtx
            ? this.syncProjectWithContext([point.basicX, point.basicY], syncCtx)
            : undefined;
          if (pixelPoint === undefined) {
            // Fallback completely to avoid rendering a broken line
            const fallbackPoint = await this.viewer.projectFromBasic([
              point.basicX,
              point.basicY,
            ]);
            if (fallbackPoint) {
              projectedPoints.push({
                x: fallbackPoint[0],
                y: fallbackPoint[1],
                width: point.width,
              });
            }
          } else if (pixelPoint !== null) {
            projectedPoints.push({
              x: pixelPoint[0],
              y: pixelPoint[1],
              width: point.width,
            });
          }
        } catch {}
      }

      if (projectedPoints.length >= 2) {
        this.renderPencilStroke(projectedPoints, stroke.color, fovScale);
      }
    }
  }

  private renderPencilStroke(
    points: Array<{ x: number; y: number; width: number }>,
    color: string,
    fovScale: number,
  ): void {
    if (points.length < 2) return;

    const isDefaultColor = color === "#000000" || color === "black";
    const strokeColor = isDefaultColor ? "#333333" : color;
    const baseWidth = points[0].width * fovScale;

    const rc = rough.canvas(this.canvas);
    const pathPoints: [number, number][] = points.map((p) => [p.x, p.y]);

    rc.curve(pathPoints, {
      stroke: strokeColor,
      strokeWidth: baseWidth * 0.6,
      roughness: 1.2,
      bowing: 1,
    });
  }

  private _prefetchDone: Set<string> = new Set();

  /** Start fetching + decoding strokes before the viewer is ready.
   *  Called from App.tsx as soon as we know the imageId. */
  prefetchStrokes(imageId: string): void {
    if (this._prefetchedTextures.has(imageId)) return;
    // Mark as in-progress so we don't duplicate
    this._prefetchedTextures.set(imageId, []);
    this._doPrefetch(imageId);
  }

  private _buildCompositeTexture(img: HTMLImageElement): MarkerTexture {
    const ROWS = 8, COLS = 16;
    const gridBasic: [number, number][][] = [];
    for (let r = 0; r <= ROWS; r++) {
      const row: [number, number][] = [];
      for (let c = 0; c <= COLS; c++) {
        row.push([c / COLS, r / ROWS]);
      }
      gridBasic.push(row);
    }
    return {
      image: img,
      gridBasic,
      gridRows: ROWS,
      gridCols: COLS,
      srcWidth: img.naturalWidth,
      srcHeight: img.naturalHeight,
      referenceFov: 90,
      isLocal: false,
    };
  }

  private async _doPrefetch(imageId: string): Promise<void> {
    // Fetch composite cache in parallel with individual strokes
    const compositePromise = supabase
      .from("composite_cache")
      .select("storage_url")
      .eq("image_id", imageId)
      .maybeSingle();

    // Fire composite load immediately (non-blocking)
    compositePromise.then(async ({ data: cacheRow }) => {
      if (!cacheRow?.storage_url) return;
      // Skip if individuals already loaded or navigated away
      if (this._prefetchDone.has(imageId) || this._imageId !== imageId) return;
      try {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = cacheRow.storage_url;
        if (img.decode) {
          await img.decode();
        } else {
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = reject;
          });
        }
        // Re-check after async load
        if (this._prefetchDone.has(imageId) || this._imageId !== imageId) return;
        this._compositeTexture = this._buildCompositeTexture(img);
        this._compositeImageId = imageId;
      } catch {
        // Composite load failed — individual strokes will handle it
      }
    });

    const reportsPromise = supabase
      .from("reports")
      .select("stroke_id")
      .eq("reporter_device_id", deviceId);

    const PAGE = 1000;
    let offset = 0;
    const textures: MarkerTexture[] = [];

    const reportsResult = await reportsPromise;
    const reportedStrokeIds = new Set<string>(
      (reportsResult.data || []).map((r: any) => r.stroke_id),
    );

    while (true) {
      const { data: page, error } = await supabase
        .from("strokes")
        .select("*")
        .eq("image_id", imageId)
        .is("hidden_at", null)
        .order("created_at", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error || !page || page.length === 0) break;

      const pending = page.filter((row: any) => {
        if (reportedStrokeIds.has(row.id)) return false;
        if (!row.canvas_data || !row.grid_basic) return false;
        return true;
      });

      const CONCURRENT = 50;
      let currentIndex = 0;
      const results: (MarkerTexture | null)[] = new Array(pending.length).fill(null);

      const workers = Array.from({ length: CONCURRENT }).map(async () => {
        while (currentIndex < pending.length) {
          const idx = currentIndex++;
          const row = pending[idx];
          try {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.src = row.canvas_data;
            row.canvas_data = null;
            if (img.decode) {
              await img.decode();
            } else {
              await new Promise<void>((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = () => reject();
              });
            }
            results[idx] = {
              image: img,
              toolType: row.tool_type || undefined,
              gridBasic: row.grid_basic as [number, number][][],
              gridRows: row.grid_rows || 12,
              gridCols: row.grid_cols || 12,
              srcWidth: row.src_width || img.naturalWidth,
              srcHeight: row.src_height || img.naturalHeight,
              referenceFov: row.reference_fov || 90,
              supabaseId: row.id,
              deviceId: row.device_id || undefined,
              createdAt: row.created_at || undefined,
              isRainbow: row.color === "rainbow",
            };
          } catch {}
        }
      });
      await Promise.all(workers);
      for (const tex of results) {
        if (tex) textures.push(tex);
      }
      if (page.length < PAGE) break;
      offset += PAGE;
    }

    this._prefetchedTextures.set(imageId, textures);
    this._prefetchDone.add(imageId);
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
    this._loadedStrokeIds.clear();
    // Clear composite state from previous location
    this._compositeTexture = null;
    this._compositeImageId = null;
    this.loadStrokes(imageId);
  }

  private _removeCompositeTexture(): void {
    if (!this._compositeTexture) return;
    const compIdx = this.markerTextures.indexOf(this._compositeTexture);
    if (compIdx > -1) {
      if (this.webglRenderer) {
        this.webglRenderer.invalidateTexture(texSource(this._compositeTexture));
      }
      this.markerTextures.splice(compIdx, 1);
    }
    this._compositeTexture = null;
    this._compositeImageId = null;
  }

  async loadStrokes(imageId: string): Promise<void> {
    if (!this.viewer) return;

    // Show composite immediately if available (instant first paint)
    if (this._compositeTexture && this._compositeImageId === imageId) {
      this.markerTextures.push(this._compositeTexture);
      this.render();
    }

    // If prefetch is in progress, wait for it to complete
    if (this._prefetchedTextures.has(imageId) && !this._prefetchDone.has(imageId)) {
      while (!this._prefetchDone.has(imageId)) {
        await new Promise<void>((r) => setTimeout(r, 50));
        if (this._imageId !== imageId) return; // Navigated away
      }
    }

    // Use prefetched strokes if available
    const prefetched = this._prefetchedTextures.get(imageId);
    if (prefetched !== undefined) {
      // Remove composite now that individuals are ready
      this._removeCompositeTexture();

      let hasRainbow = false;
      for (const tex of prefetched) {
        if (!this._loadedStrokeIds.has(tex.supabaseId!)) {
          this._loadedStrokeIds.add(tex.supabaseId!);
          this.markerTextures.push(tex);
          if (tex.isRainbow) hasRainbow = true;
        }
      }
      this._prefetchedTextures.delete(imageId);
      this._prefetchDone.delete(imageId);
      if (hasRainbow) this._startRainbowAnimationLoop();
      this.render();
      this.onStrokesLoaded?.();
      // Generate composite for next visitor if none existed
      this.generateAndUploadComposite();
      return;
    }

    // Fallback: normal load (no prefetch available)
    const reportsPromise = supabase
      .from("reports")
      .select("stroke_id")
      .eq("reporter_device_id", deviceId);

    const PAGE = 1000;
    let offset = 0;
    let hasRainbow = false;
    let processed = 0;

    const reportsResult = await reportsPromise;
    const reportedStrokeIds = new Set<string>(
      (reportsResult.data || []).map((r: any) => r.stroke_id),
    );

    while (true) {
      const { data: page, error } = await supabase
        .from("strokes")
        .select("*")
        .eq("image_id", imageId)
        .is("hidden_at", null)
        .order("created_at", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) {
        console.error("Failed to load strokes:", error);
        this.onStrokesLoaded?.();
        return;
      }
      if (!page || page.length === 0) break;

      // Filter to rows we haven't loaded yet
      const pending = page.filter((row: any) => {
        if (this._loadedStrokeIds.has(row.id)) return false;
        if (reportedStrokeIds.has(row.id)) return false;
        if (!row.canvas_data || !row.grid_basic) return false;
        this._loadedStrokeIds.add(row.id);
        return true;
      });

      // Load images concurrently — browser handles HTTP/2 multiplexing.
      // Higher concurrency = faster total load, but too high causes mobile crashes.
      const CONCURRENT = 50;
      let currentIndex = 0;
      const results: (MarkerTexture | null)[] = new Array(pending.length).fill(null);

      const workers = Array.from({ length: CONCURRENT }).map(async () => {
        while (currentIndex < pending.length) {
          if (this._imageId !== imageId) return; // Navigated away — abort
          const idx = currentIndex++;
          const row = pending[idx];
          try {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.src = row.canvas_data;
            row.canvas_data = null;
            if (img.decode) {
              await img.decode();
            } else {
              await new Promise<void>((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = () => reject();
              });
            }

            const isRainbow = row.color === "rainbow";
            if (isRainbow) hasRainbow = true;

            results[idx] = {
              image: img,
              toolType: row.tool_type || undefined,
              gridBasic: row.grid_basic as [number, number][][],
              gridRows: row.grid_rows || 12,
              gridCols: row.grid_cols || 12,
              srcWidth: row.src_width || img.naturalWidth,
              srcHeight: row.src_height || img.naturalHeight,
              referenceFov: row.reference_fov || 90,
              supabaseId: row.id,
              deviceId: row.device_id || undefined,
              createdAt: row.created_at || undefined,
              isRainbow,
            };

            processed++;
          } catch {
            // Skip failed stroke
          }
        }
      });

      await Promise.all(workers);

      // Push in original order so newer strokes render on top
      for (const tex of results) {
        if (tex) this.markerTextures.push(tex);
      }

      if (page.length < PAGE) break;
      offset += PAGE;
    }

    // Remove composite now that individuals are ready
    this._removeCompositeTexture();

    if (hasRainbow) this._startRainbowAnimationLoop();
    this.render();
    this.onStrokesLoaded?.();
    // Generate composite for next visitor if none existed
    this.generateAndUploadComposite();
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
    this._remoteCursorSvg?.remove();
    this._remoteCursorSvg = null;
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
      try {
        s.brush.dispose();
      } catch {}
    }
    this.dyingStrokes = [];
    for (const s of this.dyingPenStrokes) {
      try {
        s.pen.dispose();
      } catch {}
    }
    this.dyingPenStrokes = [];
    this.finalizingStrokes = [];
    this.finalizingPenStrokes = [];
    this.pendingTextures = [];
    this.pendingPenTextures = [];

    // Clean up remote strokes
    this.unsubscribeFromRealtime();

    // Clean up RxJS subscriptions
    for (const sub of this._internalSubs) {
      try {
        sub.unsubscribe();
      } catch {}
    }
    this._internalSubs = [];

    // Remove viewer event listeners
    if (this.viewer) {
      for (const { event, handler } of this._boundViewerListeners) {
        try {
          this.viewer.off(event as any, handler);
        } catch {}
      }
    }
    this._boundViewerListeners = [];

    // Clean up texture canvases to free memory
    for (const tex of this.markerTextures) {
      if (tex.canvas) {
        tex.canvas.width = 0;
        tex.canvas.height = 0;
      }
      if ((tex as any).silhouetteCanvas) {
        (tex as any).silhouetteCanvas.width = 0;
        (tex as any).silhouetteCanvas.height = 0;
        (tex as any).silhouetteCanvas = null;
      }
      if ((tex as any)._glGeometry) {
        (tex as any)._glGeometry = null;
      }
    }
    this.markerTextures = [];
    this._undoStack = [];
    this._redoStack = [];
    this._compositeTexture = null;
    this._compositeImageId = null;

    if (this.webglRenderer) {
      this.webglRenderer.dispose();
    }
    if (this._boundResize) {
      window.removeEventListener("resize", this._boundResize);
    }
    this.canvas.remove();
  }
}
