import { pencilGrain, pencilLook } from "../../deep/brushParts";
import type { Projector, Unprojector } from "./types";

export class Pen {
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
  setSeed(): void { /* no randomness: the grain is fixed to the surface */ }

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

      const widths = this._history.map((p) => p.width);
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
          if (p) pts.push([p[0], p[1], (widths[i] ?? this.size) * fovScale * look.width]);
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

  dispose(): void {
    this._history.length = 0;
  }

  /** Change the colour of the rest of the stroke. */
  updateColor(newColor: string): void {
    this.color = newColor;
  }
}
