import { shadeRegion } from "../deep/strokeShading";
import { SurfaceDecal, surfaceRing } from "../deep/surfaceDecal";
import type { Scene } from "./scene";

/** Your own cursor: a circle the size of the brush, wrapped onto the surface under the pointer. */
export class BrushCursor {
  /** Holds the lit paint preview (canvas) under the outline (svg); moved, faded and hidden as one. */
  private layer: HTMLDivElement | null = null;
  private svg: SVGSVGElement | null = null;
  private paths: SVGPathElement[] = [];
  /** Lit preview of the paint inside the outline: the stroke's colour × the panorama's lighting. */
  private fill: HTMLCanvasElement | null = null;
  private fillColor: string | null = null;
  /** The outline in panorama coords. */
  private anchor: { pts: [number, number][]; dot: boolean } | null = null;
  /** Set when the camera moved since the last mouse move (the outline drifted off the pointer). */
  private cameraMoved = false;
  /** Screen centre of the outline as last drawn (for the glide back to the pointer). */
  private center: [number, number] | null = null;
  private readonly scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  /**
   * Show the brush outline at a screen point. radius = brush radius in screen px where a fresh
   * stroke would start; sizeAt = the size (world units per px) a stroke in progress paints at there.
   * With depth data the circle is laid on the surface (ellipse on the ground or an angled wall),
   * matching how the stroke will actually land.
   * fillColor = paint colour to preview inside the outline, lit like a real stroke (shadow, sun,
   * surface texture); null = outline only (while drawing, rainbow, no colour).
   */
  show(pixelX: number, pixelY: number, radius: number, fillColor: string | null, sizeAt: (u: number, v: number) => number | null): void {
    this.build();
    const layer = this.layer!;
    this.fillColor = fillColor;
    if (this.cameraMoved && this.center && layer.style.display !== "none") {
      // The outline was pinned to the scene while the camera moved, so it's away from the pointer.
      // Glide it back (offset the layer by the old position, then transition the offset to zero).
      const [ox, oy] = this.center;
      layer.style.transition = "none";
      layer.style.transform = `translate(${(ox - pixelX).toFixed(1)}px, ${(oy - pixelY).toFixed(1)}px)`;
      void layer.getBoundingClientRect(); // commit the start position
      layer.style.transition = "transform 150ms cubic-bezier(0.2, 0.8, 0.2, 1)";
      layer.style.transform = "translate(0px, 0px)";
    }
    this.cameraMoved = false;
    const N = 64;
    // Outline built in panorama (basic) coords on the surface under the pointer, then projected.
    const anchor: [number, number][] = [];
    const b = this.scene.toPanorama(pixelX, pixelY);
    if (b && this.scene.isSkyAt(pixelX, pixelY)) {
      // Can't paint on the sky: just a small faded dot (a circle would suggest a surface).
      this.anchor = { pts: [b], dot: true };
      this.reproject(true);
      return;
    }
    const deep = this.scene.deep;
    if (b && deep) {
      const decal = SurfaceDecal.create(deep, b[0], b[1], this.scene.radPerPx);
      if (decal) {
        // walk the ring out along the real surface so it rides over bumps/corners like the paint
        // mid-stroke, show the size the active stroke will actually paint at here
        const basis = decal.basis;
        const s = sizeAt(b[0], b[1]) ?? basis.s;
        anchor.push(...surfaceRing(deep, basis, radius * s, N));
      }
    }
    if (!anchor.length) {
      // no depth data: a screen circle, still pinned via its panorama coords when available
      for (let k = 0; k <= N; k++) {
        const a = (k / N) * Math.PI * 2;
        const pb = this.scene.toPanorama(pixelX + Math.cos(a) * radius, pixelY + Math.sin(a) * radius);
        if (!pb) {
          this.anchor = null;
          this.drawFill(null);
          this.drawPath(this.circlePath(pixelX, pixelY, radius), false);
          return;
        }
        anchor.push(pb);
      }
    }
    this.anchor = { pts: anchor, dot: false };
    this.reproject(true);
  }

  /**
   * Redraw the brush outline from its panorama coords. Called on mouse move (show = true) and
   * whenever the camera moves (only while the cursor is showing).
   */
  private reproject(show = false): void {
    const a = this.anchor;
    if (!a || !this.layer) return;
    if (!show && this.layer.style.display === "none") return;
    const sync = this.scene.projection();
    if (!sync) return;
    // project each point; skip the few that can't be projected rather than blanking the cursor
    let d = "";
    let pen = false;
    let shown = 0;
    let first: [number, number] | null = null;
    const screen: [number, number][] = [];
    for (const p of a.pts) {
      let sp: number[] | null = null;
      try {
        sp = sync.proj.basicToCanvas(p, sync.container, sync.renderCamera, sync.transform);
      } catch {
        sp = null;
      }
      if (!sp) {
        pen = false;
        continue;
      }
      if (!first) first = [sp[0], sp[1]];
      screen.push([sp[0], sp[1]]);
      d += `${pen ? "L" : "M"}${sp[0].toFixed(1)},${sp[1].toFixed(1)}`;
      pen = true;
      shown++;
    }
    if (!first) {
      // whole outline is behind the camera: hide just the shape (next mouse move brings it back)
      for (const path of this.paths) path.setAttribute("d", "");
      this.drawFill(null);
      return;
    }
    if (a.dot) {
      this.center = first;
      this.drawFill(null);
      this.drawPath(this.circlePath(first[0], first[1], 1.5), true);
    } else {
      // centre = average of the projected outline points
      let cx = 0, cy = 0, n = 0;
      for (const m of d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)) { cx += +m[1]; cy += +m[2]; n++; }
      this.center = n ? [cx / n, cy / n] : first;
      this.drawFill(shown === a.pts.length ? screen : null);
      this.drawPath(shown === a.pts.length ? d + "Z" : d, false);
    }
  }

  /**
   * Fill the outline polygon (screen px) with the paint colour and light it per pixel with the
   * same surface map and shadeRegion as live strokes, so the preview darkens and cools in shadow,
   * warms in sun and picks up the surface texture — before anything is drawn.
   */
  private drawFill(poly: [number, number][] | null): void {
    const canvas = this.fill;
    if (!canvas) return;
    const color = this.fillColor;
    if (!poly || poly.length < 3 || !color || color === "rainbow") {
      canvas.style.display = "none";
      return;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    x0 = Math.floor(x0) - 1; y0 = Math.floor(y0) - 1; x1 = Math.ceil(x1) + 1; y1 = Math.ceil(y1) + 1;
    const w = x1 - x0, h = y1 - y0;
    if (w < 3 || h < 3 || w * h > 600 * 600) { canvas.style.display = "none"; return; }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.ceil(w * dpr), ch = Math.ceil(h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.style.transform = `translate(${x0}px, ${y0}px)`;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.setTransform(dpr, 0, 0, dpr, -x0 * dpr, -y0 * dpr);
    ctx.fillStyle = color;
    ctx.beginPath();
    poly.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const surface = this.scene.deep?.surface;
    if (surface) {
      // coarse screen -> panorama grid over the box, interpolated per pixel inside shadeRegion
      const G = 6;
      const grid: ([number, number] | null)[][] = [];
      for (let r = 0; r <= G; r++) {
        const row: ([number, number] | null)[] = [];
        for (let c = 0; c <= G; c++) row.push(this.scene.toPanorama(x0 + (c / G) * w, y0 + (r / G) * h));
        grid.push(row);
      }
      shadeRegion(ctx, 0, 0, cw, ch, grid, surface);
    }
    canvas.style.display = "";
  }

  private circlePath(x: number, y: number, r: number): string {
    return `M${(x - r).toFixed(1)},${y.toFixed(1)}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`;
  }

  /** Update the outline; `disabled` = faded (e.g. the dot over the sky, where you can't paint). */
  private drawPath(d: string, disabled: boolean): void {
    if (!this.svg) return;
    for (const path of this.paths) {
      path.setAttribute("d", d);
      path.removeAttribute("stroke-dasharray");
    }
    if (!this.layer) return;
    this.layer.style.opacity = disabled ? "0.6" : "1";
    this.layer.style.display = "";
  }

  private build(): void {
    if (this.layer) return;
    const layer = document.createElement("div");
    layer.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:12;overflow:visible";
    const fill = document.createElement("canvas");
    // Fully opaque: the preview looks exactly like the paint will once the stroke is released.
    fill.style.cssText = "position:absolute;left:0;top:0;display:none";
    layer.appendChild(fill);
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg") as SVGSVGElement;
    svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;overflow:visible";
    // dark halo under a white line so it's visible on any background
    for (const [stroke, width] of [["rgba(0,0,0,0.45)", 3], ["rgba(255,255,255,0.95)", 1.5]] as const) {
      const path = document.createElementNS(NS, "path") as SVGPathElement;
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", stroke);
      path.setAttribute("stroke-width", String(width));
      svg.appendChild(path);
      this.paths.push(path);
    }
    layer.appendChild(svg);
    this.scene.container.appendChild(layer);
    this.layer = layer;
    this.svg = svg;
    this.fill = fill;
  }

  /** The camera moved: keep the outline pinned to its spot in the scene. */
  follow(): void {
    if (!this.anchor || !this.layer || this.layer.style.display === "none") return;
    this.cameraMoved = true;
    this.reproject();
  }

  hide(): void {
    if (this.layer) this.layer.style.display = "none";
  }

  dispose(): void {
    this.layer?.remove();
    this.layer = null;
    this.svg = null;
    this.fill = null;
  }
}
