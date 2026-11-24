import { mulberry32, strokeToPolygon, WCPoly, type Vec2 } from "../../deep/brushParts";
import type { Unprojector } from "./types";

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
export class WatercolorBrush {
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

  dispose(): void {
    this._history.length = 0;
    this._screenPoints.length = 0;
  }

  updateColor(newColor: string): void {
    this.color = newColor;
    this._cachedRGB = null;
  }
}
