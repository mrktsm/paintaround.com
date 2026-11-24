import getStroke from "perfect-freehand";
import type { Unprojector } from "./types";

// ---------------------------------------------------------------------------
// Watercolor brush — ported from p5.js "water colour" by BarneyCodes
// ---------------------------------------------------------------------------

/**
 * Fountain pen brush — variable-width calligraphic strokes.
 * Thick on slow movement, thin on fast movement, with smooth tapering.
 * Uses perfect-freehand for smooth, pressure-sensitive stroke outlines.
 * Same public interface as Pen/ChalkBrush/WatercolorBrush.
 */
export class FountainPenBrush {
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
  setSeed(): void { /* no randomness */ }
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
        if (this._inputPoints.length > 3000) this._inputPoints.shift();

        this._drawStroke();
      }
    }

    ctx.drawImage(this._offscreen, 0, 0);
  }

  dispose(): void {
    this._history.length = 0;
    this._inputPoints.length = 0;
  }

  updateColor(newColor: string): void {
    this.color = newColor;
  }
}
