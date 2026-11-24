/** Pieces shared by the on-screen brushes (DrawingOverlay) and the surface brushes (decalTools). */

/** Small seeded PRNG (mulberry32): same seed -> same sequence on every device. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Pencil grain: real scanned paper (David Revoy, CC0) as the graphite's tooth ──
type PencilLook = { src: string; scale: number; lo: number; hi: number; floor: number; width: number };
/** Bold graphite on speckled drawing paper (chosen over softer/fibre variants, Nov 2026). */
const PENCIL_LOOK: PencilLook = { src: "/textures/paper-grain.png", scale: 0.35, lo: 0.3, hi: 0.7, floor: 0.12, width: 1.0 };
export function pencilLook(): PencilLook {
  return PENCIL_LOOK;
}
const _grainMasks = new Map<string, HTMLCanvasElement | null>();
/** The look's grain as an alpha mask pattern (null until the texture has loaded). */
export function pencilGrain(ctx: CanvasRenderingContext2D, look: PencilLook): CanvasPattern | null {
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

export interface Vec2 {
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
  const t = (x - 0.5) * 1.58740105;
  return t * t * t + 0.5;
}
function wcRand(rand: () => number): number {
  return wcDistribute(rand());
}

export class WCPoly {
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
 * Build a closed polygon outlining a stroke path with given width.
 * Returns vertices tracing the left side forward, then right side backward.
 */
export function strokeToPolygon(points: Vec2[], width: number): Vec2[] {
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
