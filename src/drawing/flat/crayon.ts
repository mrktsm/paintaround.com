import { mulberry32 } from "../../deep/brushParts";
import type { Unprojector } from "./types";

/**
 * Chalk/crayon brush adapted from p5.js "Chalk Brush" by Kora-Lee.
 * Stamps a random-walk cloud of dots at each cursor position, creating
 * a grainy, dusty texture that mimics real chalk or crayon.
 * Same public interface as Pen so it can be used interchangeably.
 */
export class ChalkBrush {
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
    ctx.beginPath(); // all dots in one path: one fill instead of thousands

    let currentX = 0;
    let currentY = 2.2;
    for (let d = 0; d <= 2500; d++) {
      if (
        currentX * currentX + currentY * currentY <
        (radius / 2) * (radius / 2)
      ) {
        ctx.moveTo(cx + currentX + 1, cy + currentY);
        ctx.arc(cx + currentX, cy + currentY, 1, 0, Math.PI * 2);
      }
      currentX += this._rand() * 2 - 1;
      currentY += this._rand() * 2 - 1;
    }
    ctx.fill();
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
        const steps = Math.min(100, Math.max(1, Math.ceil(stampDist / spacing)));
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

  dispose(): void {
    this._history.length = 0;
  }

  updateColor(newColor: string): void {
    this.color = newColor;
  }
}
