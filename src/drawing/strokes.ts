import type { ToolType } from "../deep/decalTools";

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
