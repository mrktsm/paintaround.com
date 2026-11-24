import { mulberry32 } from "../../deep/brushParts";
import type { Projector, SplashParticle, Unprojector } from "./types";

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

export class Drop {
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

export class Brush {
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
      const splashPositions = await Promise.all(this._splashes.map((s) => this._projector([s.basicX, s.basicY])));

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

          // Batch unproject all splash positions
          const basicPositions = await Promise.all(
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
