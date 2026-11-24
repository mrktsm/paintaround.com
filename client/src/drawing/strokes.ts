import type { ToolType } from "../deep/decalTools";
import type { Scene } from "./scene";

/** A finished stroke: its bitmap and where it sits on the panorama. */
export interface MarkerTexture {
  canvas?: HTMLCanvasElement; // Lazy — created on demand
  image?: HTMLImageElement; // For remote strokes loaded via URL
  gridBasic: [number, number][][];
  gridRows: number;
  gridCols: number;
  srcWidth: number;
  srcHeight: number;
  referenceFov: number;
  cachedProjection?: ([number, number] | null)[][];
  isLocal?: boolean;
  opacity?: number;
  liveId?: string; // id shared with the live room (finished strokes, undo, eraser)
  needsProjection?: boolean;
  isProjecting?: boolean;
  toolType?: ToolType;
  brushStrokeId?: string; // Internal brush stroke ID for matching drips/splashes
  strokeGroup?: number; // Pieces of one stroke that crossed surfaces — undone/redone together
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

/** The best source for drawing a stroke: its canvas, or the image it came as. */
export function texSource(tex: MarkerTexture): HTMLCanvasElement | HTMLImageElement {
  return tex.canvas || tex.image!;
}

/** Lazily materialises a canvas from an Image (to rub parts out) */
export function ensureCanvas(tex: MarkerTexture): HTMLCanvasElement {
  if (tex.canvas) return tex.canvas;
  const img = tex.image!;
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d")!.drawImage(img, 0, 0);
  tex.canvas = c;
  return c;
}

export function copyCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  c.getContext("2d")!.drawImage(src, 0, 0);
  return c;
}

/** Every finished stroke in this place, oldest first (that's the order they're drawn in). */
export class Strokes {
  list: MarkerTexture[] = [];
  /** Called when a rainbow stroke is added (they keep moving). */
  onRainbow: (() => void) | null = null;
  private readonly scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  add(tex: MarkerTexture): void {
    this.list.push(tex);
    if (tex.isRainbow) this.onRainbow?.();
  }

  has(tex: MarkerTexture): boolean {
    return this.list.includes(tex);
  }

  remove(tex: MarkerTexture): void {
    const i = this.list.indexOf(tex);
    if (i > -1) this.list.splice(i, 1);
    this.forget(tex);
  }

  /** Put a stroke in an older version's place, or under everything. */
  replace(old: MarkerTexture | undefined, tex: MarkerTexture): void {
    const i = old ? this.list.indexOf(old) : -1;
    if (i > -1) this.list[i] = tex;
    else this.list.unshift(tex);
    if (old) this.forget(old);
  }

  /** A stroke's pixels changed, or it's gone: the GPU's copy is out of date. */
  forget(tex: MarkerTexture): void {
    this.scene.renderer?.invalidateTexture(texSource(tex));
  }

  /** Remove strokes by their id in the live room. True if there were any. */
  removeShared(ids: string[]): boolean {
    const gone = new Set(ids);
    const found = this.list.filter((t) => t.liveId && gone.has(t.liveId));
    for (const t of found) this.remove(t);
    return found.length > 0;
  }

  dispose(): void {
    for (const { canvas } of this.list) if (canvas) canvas.width = canvas.height = 0; // frees the memory now
    this.list = [];
  }
}
