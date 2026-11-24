import type { CursorState } from "../../../shared/realtime";
import { SurfaceDecal, surfaceRing } from "../deep/surfaceDecal";
import type { Scene } from "./scene";

/** Other people's rings fade in/out over this long instead of popping. */
const FADE_MS = 250;

/** Someone's cursor: an outline the size of their brush, wrapped onto the surface. */
interface Ring {
  pts: [number, number][];
  paint: string | null;
  path: SVGPathElement;
  halo: SVGPathElement;
  timer: ReturnType<typeof setTimeout>;
  /** set while fading out; cleared if the cursor comes back before it's gone */
  fadeOut: ReturnType<typeof setTimeout> | null;
}

/** Other people's cursors, drawn over the photo. */
export class PeerCursors {
  /** Everyone's cursor colour, by id. */
  readonly colors = new Map<string, string>();
  /** Everyone's brush radius (radians), from their cursor. */
  readonly brush = new Map<string, number>();
  private readonly rings = new Map<string, Ring>();
  private svg: SVGSVGElement | null = null;
  private readonly scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  private layer(): SVGSVGElement {
    if (!this.svg) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
      svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:11;overflow:visible";
      this.scene.container.appendChild(svg);
      this.svg = svg;
    }
    return this.svg;
  }

  set(id: string, c: CursorState): void {
    const svg = this.layer();
    this.brush.set(id, c.radius);
    if (this.scene.isSky(c.u, c.v)) return this.remove(id); // nothing to paint up there
    let rc = this.rings.get(id);
    if (!rc) {
      const NS = "http://www.w3.org/2000/svg";
      const halo = document.createElementNS(NS, "path") as SVGPathElement;
      halo.setAttribute("fill", "none");
      // same weights as our own brush ring (3px halo under a 1.5px line), just in their colour
      halo.setAttribute("stroke", "rgba(0,0,0,0.45)");
      halo.setAttribute("stroke-width", "3");
      halo.setAttribute("stroke-linejoin", "round");
      const path = document.createElementNS(NS, "path") as SVGPathElement;
      path.setAttribute("stroke-width", "1.5");
      path.setAttribute("stroke-linejoin", "round");
      // fade in: start transparent, ease to visible next frame
      for (const el of [halo, path]) {
        el.style.transition = `opacity ${FADE_MS}ms ease`;
        el.style.opacity = "0";
      }
      svg.append(halo, path);
      requestAnimationFrame(() => { halo.style.opacity = "1"; path.style.opacity = "1"; });
      rc = { pts: [], paint: null, path, halo, timer: setTimeout(() => {}, 0), fadeOut: null };
      this.rings.set(id, rc);
    } else if (rc.fadeOut) {
      // came back while fading out: cancel and fade back in
      clearTimeout(rc.fadeOut);
      rc.fadeOut = null;
      rc.halo.style.opacity = "1";
      rc.path.style.opacity = "1";
    }
    // ring in panorama coords on the surface, sized from their brush angle at our zoom
    const { radPerPx, deep } = this.scene;
    const radiusPx = Math.max(2, c.radius / radPerPx);
    let pts: [number, number][] = [];
    if (deep) {
      const decal = SurfaceDecal.create(deep, c.u, c.v, radPerPx);
      if (decal) pts = surfaceRing(deep, decal.basis, radiusPx * decal.basis.s, 64);
    }
    if (!pts.length) {
      // no depth here: a small ring in panorama space around the point
      const r = c.radius / (2 * Math.PI);
      for (let k = 0; k <= 64; k++) {
        const a = (k / 64) * Math.PI * 2;
        pts.push([c.u + Math.cos(a) * r, c.v + Math.sin(a) * r * 2]);
      }
    }
    rc.pts = pts;
    rc.paint = c.paint;
    // Ring = this person's colour only, never their paint (like tldraw/Figma: identity on the
    // cursor, content colour only in the stroke itself). Their paint shows once they draw.
    rc.path.setAttribute("stroke", this.colors.get(id) ?? "#ffffff");
    rc.path.setAttribute("fill", "none");
    rc.path.dataset.peer = id;
    clearTimeout(rc.timer);
    rc.timer = setTimeout(() => this.remove(id), 5000); // idle -> fade away
    this.place(rc);
  }

  private place(rc: Ring): void {
    const sync = this.scene.projection();
    if (!sync) return;
    let d = "";
    let pen = false;
    let shown = 0;
    for (const p of rc.pts) {
      let sp: number[] | null = null;
      try {
        sp = sync.proj.basicToCanvas(p, sync.container, sync.renderCamera, sync.transform);
      } catch {
        sp = null;
      }
      if (!sp) { pen = false; continue; }
      d += `${pen ? "L" : "M"}${sp[0].toFixed(1)},${sp[1].toFixed(1)}`;
      pen = true;
      shown++;
    }
    // looking elsewhere: their cursor simply isn't on our screen
    if (shown && shown === rc.pts.length) d += "Z";
    rc.path.setAttribute("d", d);
    rc.halo.setAttribute("d", d);
  }

  /** The camera moved: keep every ring on its spot in the scene. */
  reproject(): void {
    for (const rc of this.rings.values()) this.place(rc);
  }

  /** Fade their ring out (idle, finger lifted, over the sky, left); instant when switching rooms. */
  remove(id: string, instant = false): void {
    const rc = this.rings.get(id);
    if (!rc) return;
    clearTimeout(rc.timer);
    const drop = () => {
      if (rc.fadeOut) clearTimeout(rc.fadeOut);
      rc.path.remove();
      rc.halo.remove();
      if (this.rings.get(id) === rc) this.rings.delete(id);
    };
    if (instant) return drop();
    if (rc.fadeOut) return; // already fading
    rc.halo.style.opacity = "0";
    rc.path.style.opacity = "0";
    rc.fadeOut = setTimeout(drop, FADE_MS);
  }

  clear(): void {
    for (const id of [...this.rings.keys()]) this.remove(id, true);
  }

  dispose(): void {
    this.clear();
    this.svg?.remove();
    this.svg = null;
  }
}
