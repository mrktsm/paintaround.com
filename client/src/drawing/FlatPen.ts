import type { Viewer } from "mapillary-js";
import type { ToolType } from "../deep/decalTools";
import { applyShading, shadeRegion } from "../deep/strokeShading";
import { realtime } from "../realtime/client";
import { ChalkBrush } from "./flat/crayon";
import { FountainPenBrush } from "./flat/fountainPen";
import { Brush, type Drop } from "./flat/marker";
import { Pen } from "./flat/pencil";
import type { FlatTool, Projector, SplashParticle, Unprojector } from "./flat/types";
import { WatercolorBrush } from "./flat/watercolor";
import type { LiveRoom } from "./LiveRoom";
import { resolveRainbowColor } from "./rainbow";
import type { Scene } from "./scene";
import type { MarkerTexture, Strokes } from "./strokes";

interface FlatStroke {
  tool: FlatTool;
  toolType: ToolType;
  rainbow: boolean;
  /** Field of view it's drawn at. */
  fov: number;
  /** Where the pointer is. */
  x: number;
  y: number;
  moved: boolean;
  ready: boolean;
  /** The marker's id for its drips and splashes. */
  id?: string;
}

/** Drawing on screen, where there is no 3D surface: the stroke is put onto the panorama once it ends. */
export class FlatPen {
  /** Called when there is something to draw every frame. */
  onActive: (() => void) | null = null;
  private current: FlatStroke | null = null;
  /** Strokes that just ended. */
  private ended: FlatStroke[] = [];
  /** Strokes being put onto the panorama, still drawn on screen. */
  private settling: FlatStroke[] = [];
  /** Strokes on the panorama, waiting to join the others at the start of a frame. */
  private settled: { stroke: FlatStroke; tex: MarkerTexture | null }[] = [];
  /** Is the last stroke rainbow? Its drips and splashes keep changing colour. */
  private rainbow = false;
  private drops: Drop[] = [];
  private splashes: SplashParticle[] = [];
  private lastSend = 0;
  private lit: HTMLCanvasElement | null = null;
  private litCtx: CanvasRenderingContext2D | null = null;
  private readonly project: Projector;
  private readonly unproject: Unprojector;
  private readonly scene: Scene;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly strokes: Strokes;
  private readonly room: LiveRoom;

  constructor(scene: Scene, ctx: CanvasRenderingContext2D, strokes: Strokes, room: LiveRoom, viewer: () => Viewer | null) {
    this.scene = scene;
    this.ctx = ctx;
    this.strokes = strokes;
    this.room = room;
    this.project = async (b) => {
      const p = await viewer()?.projectFromBasic(b);
      return p && p.length >= 2 ? [p[0], p[1]] : null;
    };
    this.unproject = async (p) => {
      const b = await viewer()?.unprojectToBasic(p);
      return b ? [b[0], b[1]] : null;
    };
    room.history.onUndone = (tex) => this.dropDrips(tex);
  }

  start(x: number, y: number, color: string, lineWidth: number, toolType: ToolType, group: number): void {
    const { fov } = this.scene, rainbow = color === "rainbow";
    const tool = this.createTool(toolType, x, y, rainbow ? resolveRainbowColor() : color, lineWidth, fov);
    tool.setSeed(Math.floor(Math.random() * 2 ** 31));
    const stroke: FlatStroke = { tool, toolType, rainbow, fov, x, y, moved: false, ready: false };
    this.current = stroke;
    this.rainbow = rainbow;
    void this.unproject([x, y]).then((b) => {
      if (b) realtime.send({ t: "stroke_start", color, lineWidth, toolType, u: b[0], v: b[1], fov: this.scene.fov, group });
    });
    void tool.initialize().then(async () => {
      if (this.current !== stroke) return;
      await tool.startStroke(`pen_${Date.now()}`);
      stroke.ready = true;
      this.onActive?.();
    });
  }

  point(x: number, y: number): void {
    const s = this.current;
    if (!s) return;
    s.moved = true;
    s.x = x;
    s.y = y;
    if (s.rainbow) s.tool.updateColor(resolveRainbowColor());
    void this.unproject([x, y]).then((b) => {
      const now = performance.now();
      if (!b || now - this.lastSend < 50) return;
      this.lastSend = now;
      realtime.send({ t: "stroke_point", u: b[0], v: b[1] });
    });
  }

  end(): void {
    const s = this.current;
    this.current = null;
    if (s?.ready && s.moved) {
      s.fov = this.scene.fov;
      if (s.tool instanceof Brush) {
        s.id = s.tool.getStrokeId() ?? undefined;
        s.tool.endStroke(); // it draws no more when it's put onto the panorama
      }
      this.ended.push(s);
      this.onActive?.();
    } else {
      s?.tool.dispose();
    }
    realtime.send({ t: "stroke_end" });
  }

  /** Anything to draw this frame? */
  get busy(): boolean {
    return !!this.current?.ready || this.ended.length + this.settling.length + this.settled.length + this.drops.length + this.splashes.length > 0;
  }

  /** Start of a frame: strokes now on the panorama join the others. */
  join(): void {
    for (const { stroke, tex } of this.settled) {
      if (tex) {
        this.strokes.add(tex);
        this.room.history.add(tex);
      }
      this.settling.splice(this.settling.indexOf(stroke), 1);
    }
    this.settled = [];
  }

  /** Draw the strokes that aren't on the panorama yet, with their drips and splashes. */
  async draw(): Promise<void> {
    for (const stroke of this.ended) {
      this.takeDrips(stroke);
      if (stroke.tool instanceof Brush) stroke.tool.dripping = stroke.tool.splashing = false;
      this.settling.push(stroke);
      void this.settle(stroke);
    }
    this.ended = [];
    for (const stroke of this.settling) await this.drawLit(stroke);
    await this.drawDrips();
    const s = this.current;
    if (!s?.ready) return;
    if (s.rainbow) s.tool.updateColor(resolveRainbowColor());
    this.takeDrips(s); // every frame, so they run during long strokes too
    await this.drawLit({ ...s, fov: this.scene.fov });
  }

  private takeDrips({ tool }: FlatStroke): void {
    if (!(tool instanceof Brush)) return;
    this.drops.push(...tool.extractDrops());
    this.splashes.push(...tool.extractSplashes());
  }

  private async drawDrips(): Promise<void> {
    const fovScale = 90 / this.scene.fov;
    for (const s of this.splashes) s.life -= 0.004; // about 3.5 seconds
    // gone before they get too faint (which flickers)
    this.splashes = this.splashes.filter((s) => s.life > 0.1);
    this.drops = this.drops.filter((d) => d.life > 0.1);
    if (this.rainbow) {
      const color = resolveRainbowColor();
      for (const s of this.splashes) s.color = color;
      for (const d of this.drops) d.color = color;
    }
    const splashes = this.splashes;
    const at = await Promise.all(splashes.map((s) => this.project([s.basicX, s.basicY])));
    splashes.forEach((s, i) => {
      const p = at[i];
      if (!p) return;
      this.ctx.save();
      this.ctx.fillStyle = s.color || "black";
      this.ctx.globalAlpha = Math.min(1, s.life);
      this.ctx.beginPath();
      this.ctx.arc(p[0], p[1], s.radius * fovScale, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();
    });
    for (const drop of this.drops) {
      drop.updatePhysics(fovScale);
      await drop.render(this.ctx, this.project, fovScale);
    }
  }

  /** Remove an undone stroke's drips and splashes. */
  private dropDrips(tex: MarkerTexture): void {
    const id = tex.brushStrokeId;
    if (!id) return;
    this.drops = this.drops.filter((d) => d.strokeId !== id);
    this.splashes = this.splashes.filter((s) => !s.strokeId || s.strokeId !== id);
  }

  private createTool(toolType: ToolType, x: number, y: number, color: string, lineWidth: number, fov: number): FlatTool {
    const { project, unproject, ctx: { canvas: { width: w, height: h } } } = this;
    switch (toolType) {
      case "marker": return new Brush(x, y, color, project, unproject, lineWidth * 4, lineWidth, fov);
      case "crayon": return new ChalkBrush(x, y, color, unproject, lineWidth, fov, w, h);
      case "fountainPen": return new FountainPenBrush(x, y, color, unproject, lineWidth, fov, w, h);
      case "watercolor": return new WatercolorBrush(x, y, color, unproject, lineWidth, fov, w, h);
      default: return new Pen(x, y, color, project, unproject, lineWidth, fov);
    }
  }

  /** Put an ended stroke onto the panorama. */
  private async settle(stroke: FlatStroke): Promise<void> {
    const tex = await this.bake(stroke).catch((e) => { console.error("[drawing] a stroke could not be finished:", e); return null; });
    stroke.tool.dispose();
    this.settled.push({ stroke, tex });
    if (tex) void this.room.share(tex);
  }

  private async bake({ tool, toolType, rainbow, fov, x, y, id }: FlatStroke): Promise<MarkerTexture | null> {
    const { width: W, height: H } = this.ctx.canvas;
    const whole = document.createElement("canvas");
    whole.width = W;
    whole.height = H;
    await tool.render(whole.getContext("2d")!, x, y, fov);

    const pad = toolType === "marker" ? 100 : toolType === "watercolor" ? 150 : 50;
    const bounds = tool.getBounds();
    const minX = Math.max(0, bounds.minX - pad), minY = Math.max(0, bounds.minY - pad);
    const width = Math.min(W, bounds.maxX + pad) - minX, height = Math.min(H, bounds.maxY + pad) - minY;
    if (width <= 0 || height <= 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.drawImage(whole, minX, minY, width, height, 0, 0, width, height);

    const rows = Math.max(1, Math.min(12, Math.ceil(height / 50)));
    const cols = Math.max(1, Math.min(12, Math.ceil(width / 50)));
    const at = (r: number, c: number) => this.unproject([minX + (c / cols) * width, minY + (r / rows) * height]).catch(() => null);
    const gridBasic = await Promise.all(Array.from({ length: rows + 1 }, (_, r) =>
      Promise.all(Array.from({ length: cols + 1 }, async (_, c) => (await at(r, c)) ?? ([0, 0] as [number, number])))));

    const light = this.scene.deep?.surface;
    if (light && !rainbow) applyShading(canvas, gridBasic, light);
    return {
      canvas, gridBasic, gridRows: rows, gridCols: cols, srcWidth: width, srcHeight: height, referenceFov: fov,
      toolType: toolType === "marker" ? undefined : toolType,
      brushStrokeId: id, isLocal: true, opacity: 1, isRainbow: rainbow || undefined,
    };
  }

  /**
   * Draw a live (in-progress or finishing) stroke, shaded with the panorama's surface map so it
   * already looks painted-on while drawing — matching what gets baked when it's finished.
   * Falls back to a plain render when there's no shading data or no sync projection yet.
   */
  private async drawLit({ tool, toolType, rainbow, x, y, fov }: FlatStroke): Promise<void> {
    const surface = this.scene.deep?.surface;
    const sync = surface && !rainbow ? this.scene.projection() : null;
    if (!surface || !sync) {
      await tool.render(this.ctx, x, y, fov);
      return;
    }
    const cw = this.ctx.canvas.width, ch = this.ctx.canvas.height;
    if (!this.lit || this.lit.width !== cw || this.lit.height !== ch) {
      this.lit = document.createElement("canvas");
      this.lit.width = cw;
      this.lit.height = ch;
      this.litCtx = this.lit.getContext("2d", { willReadFrequently: true });
    }
    const off = this.lit, offCtx = this.litCtx!;
    const pad = toolType === "watercolor" ? 150 : 50;
    const b = tool.getBounds();
    const x0 = Math.max(0, Math.floor(b.minX - pad)), y0 = Math.max(0, Math.floor(b.minY - pad));
    const x1 = Math.min(cw, Math.ceil(b.maxX + pad)), y1 = Math.min(ch, Math.ceil(b.maxY + pad));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0 || !isFinite(w) || !isFinite(h)) {
      await tool.render(this.ctx, x, y, fov);
      return;
    }
    offCtx.clearRect(0, 0, cw, ch);
    await tool.render(offCtx, x, y, fov);
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

  dispose(): void {
    for (const s of [...this.ended, ...(this.current ? [this.current] : [])]) s.tool.dispose();
    this.current = null;
    this.ended = [];
    this.settling = [];
    this.settled = [];
  }
}
