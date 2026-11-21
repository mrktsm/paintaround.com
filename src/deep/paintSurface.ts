import materialData from '../data/paint-materials.json';

const materials: Record<string, { surface: string }> = materialData;
const cache = new Map<string, Promise<Float32Array | null>>();
export const SURFACE_W = 2048;
export const SURFACE_H = 1024;
const PIXELS = SURFACE_W * SURFACE_H;

/** half-float -> float lookup (all 65536 bit patterns) for .f16 paint materials */
let HALF: Float32Array | null = null;
function halfTable(): Float32Array {
  if (HALF) return HALF;
  HALF = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const sign = h & 0x8000 ? -1 : 1, exp = (h >> 10) & 0x1f, frac = h & 0x3ff;
    HALF[h] = exp === 0 ? sign * 2 ** -14 * (frac / 1024)
      : exp === 31 ? (frac ? NaN : sign * Infinity)
      : sign * 2 ** (exp - 15) * (1 + frac / 1024);
  }
  return HALF;
}

/** A paint surface is always interleaved linear RGB, SURFACE_W x SURFACE_H x 3.
 * Files may be grey float32 (one value per pixel, the older exports), RGB float32,
 * or RGB float16 (the batch-built materials, half the download); all become float32 RGB. */
async function readSurface(imageId: string, filename: string): Promise<Float32Array | null> {
  try {
    const response = await fetch(`/deep-layers/${encodeURIComponent(imageId)}/${filename}`);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    let values: Float32Array;
    if (buffer.byteLength === PIXELS * 6) {
      const half = new Uint16Array(buffer), table = halfTable();
      values = new Float32Array(half.length);
      for (let i = 0; i < half.length; i++) values[i] = table[half[i]];
    } else if (buffer.byteLength === PIXELS * 4 || buffer.byteLength === PIXELS * 12) {
      values = new Float32Array(buffer);
    } else return null;
    if (values.some(value => !Number.isFinite(value) || value < 0)) return null;
    if (values.length === PIXELS * 3) return values;
    const rgb = new Float32Array(PIXELS * 3);
    for (let p = 0; p < PIXELS; p++) rgb[p * 3] = rgb[p * 3 + 1] = rgb[p * 3 + 2] = values[p];
    return rgb;
  } catch { return null; }
}

/** One shared multiplier for live GPU painting, CPU preview, and finished strokes.
 * Refined lighting is already baked into the versioned file; no model or image
 * processing runs while painting. Unprocessed panoramas retain their old map. */
export function loadPaintSurface(imageId: string): Promise<Float32Array | null> {
  let pending = cache.get(imageId);
  if (!pending) {
    const upgraded = materials[imageId]?.surface;
    pending = (async () => {
      if (upgraded) {
        const surface = await readSurface(imageId, upgraded);
        if (surface) return surface;
        console.warn(`[deep] ${imageId}: refined paint material unavailable; using the previous surface map.`);
      }
      return readSurface(imageId, 'surface.f32');
    })();
    cache.set(imageId, pending);
  }
  return pending;
}

/**
 * Bilinear RGB sample at basic coords (u wraps around the seam, v clamps), the
 * same filtering the GPU path gets from a LINEAR texture. Nearest sampling made
 * shadow edges visibly blocky when zoomed in. Writes into `out`, returns it.
 */
export function sampleSurface(surface: Float32Array, u: number, v: number, out: Float32Array): Float32Array {
  const x = u * SURFACE_W - 0.5;
  const y = Math.min(SURFACE_H - 1, Math.max(0, v * SURFACE_H - 0.5));
  const xf = Math.floor(x), yf = Math.floor(y);
  const fx = x - xf, fy = y - yf;
  const x0 = ((xf % SURFACE_W) + SURFACE_W) % SURFACE_W, x1 = (x0 + 1) % SURFACE_W;
  const y0 = yf, y1 = Math.min(SURFACE_H - 1, yf + 1);
  const a = (y0 * SURFACE_W + x0) * 3, b = (y0 * SURFACE_W + x1) * 3;
  const c = (y1 * SURFACE_W + x0) * 3, d = (y1 * SURFACE_W + x1) * 3;
  const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
  for (let k = 0; k < 3; k++) out[k] = surface[a + k] * w00 + surface[b + k] * w01 + surface[c + k] * w10 + surface[d + k] * w11;
  return out;
}
