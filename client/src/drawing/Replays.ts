import type { Scene } from "./scene";
import { texSource, type MarkerTexture } from "./strokes";
import { bakePiece, canPaintSurfaces, MID_SAMPLE, paintFrame, pieceTexture, releasePiece, startPiece, type DecalState, type Replay } from "./surfaceStrokes";

/**
 * Others' strokes on 3D surfaces, replayed with the same brush. The drawer sends the decal's origin
 * and scale, the brush seed and every brush sample, so we rebuild their decal, run the same tool on
 * the same samples, and draw it with the same surface shader as our own live strokes. Their finished
 * bitmap is then the same pixels, so the swap when they let go is invisible.
 */
export class Replays {
  private readonly replays = new Map<string, Replay[]>();
  private readonly scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  /** A piece of their stroke starts. False: it can't be replayed here (no 3D data, rainbow). */
  start(id: string, m: { color: string; lineWidth: number; toolType: string; u: number; v: number; fov: number; group?: number; seed?: number; wpp?: number }): boolean {
    if (!canPaintSurfaces(this.scene) || m.color === "rainbow") return false;
    const toolType = (["pencil", "marker", "crayon", "fountainPen", "watercolor"] as const).find((t) => t === m.toolType);
    if (!toolType) return false;
    const st = startPiece(this.scene.deep, [m.u, m.v], 1, m.wpp, true, { color: m.color, lineWidth: m.lineWidth, toolType }, m.seed ?? 0, m.group ?? 0, m.fov);
    if (!st) return false;
    const r: Replay = { st, group: m.group, ended: false, dead: false, mids: [], tex: null };
    const list = this.replays.get(id) ?? [];
    const before = list[list.length - 1];
    if (before && before.group === m.group) st.tool.resume(before.st.tool);
    // pieces of a stroke stay until its finished bitmap arrives; a new stroke means the old one is over
    for (const o of list) if (o.ended && o.group !== m.group) this.expire(id, o, 6000);
    list.push(r);
    this.replays.set(id, list);
    // a stroke that never finishes (sender vanished) doesn't stay forever
    this.expire(id, r, 60000);
    return true;
  }

  /** The peer's stroke piece still being drawn (null = none, or they draw flat). */
  live(id: string): Replay | null {
    const list = this.replays.get(id);
    const r = list?.[list.length - 1];
    return r && !r.ended ? r : null;
  }

  /** Feed the drawer's brush samples (u, v, decal x, y) to the same brush, frame by frame. */
  samples(r: Replay, pts: number[]): void {
    if (r.dead) return;
    const st = r.st, g = st.geo, radius = st.nearRadius * g.s;
    for (let k = 0; k + 3 < pts.length; k += 4) {
      const b: [number, number] = [pts[k], pts[k + 1]];
      const mid = pts[k + 2] >= MID_SAMPLE;
      const d: [number, number] = [pts[k + 2] - (mid ? MID_SAMPLE : 0), pts[k + 3]];
      // unwrap and open up the surface along the way
      const from = st.prev;
      let du = b[0] - from.basic[0];
      if (du > 0.5) du -= 1;
      else if (du < -0.5) du += 1;
      const dv = b[1] - from.basic[1];
      const len = Math.hypot(d[0] - from.decal[0], d[1] - from.decal[1]);
      const n = Math.min(400, Math.max(1, Math.ceil(len / (st.nearRadius * 0.3)), Math.ceil(Math.hypot(du * 2048, dv * 1024) / 12)));
      for (let i = 1; i <= n; i++) {
        const u = from.basic[0] + (du * i) / n, v = from.basic[1] + (dv * i) / n;
        if (g.reach(u, v)) g.markNear(u, v, radius);
      }
      st.prev = { basic: b, decal: d, screen: [0, 0] };
      r.mids.push(d);
      if (mid) continue;
      paintFrame(st, r.mids, b, this.scene.height);
      r.mids = [];
    }
    this.scene.redraw();
  }

  end(id: string, r: Replay): void {
    r.ended = true;
    const piece = bakePiece(r.st);
    if (piece) r.tex = pieceTexture(piece, r.st);
    releasePiece(this.scene, r.st);
    // the finished bitmap arrives once the whole stroke (all its pieces) is over
    this.expire(id, r, 60000);
    this.scene.redraw();
  }

  /** Their stroke is over; call the result once its finished bitmap is on screen. */
  finished(id: string, group: number | undefined): () => void {
    // the replayed copy is pixel-identical: swap once the bitmap is on screen
    // (every piece of it: one bitmap holds the whole stroke)
    const done = (this.replays.get(id) ?? []).filter((r) => r.ended && (group === undefined || r.group === group));
    for (const r of done) clearTimeout(r.timer);
    return () => { for (const r of done) this.drop(id, r); };
  }

  /** They left. */
  remove(id: string): void {
    for (const r of [...(this.replays.get(id) ?? [])]) this.drop(id, r);
  }

  clear(): void {
    for (const id of [...this.replays.keys()]) this.remove(id);
  }

  /** Ended pieces still waiting for their finished bitmap. */
  strokes(): MarkerTexture[] {
    const out: MarkerTexture[] = [];
    for (const list of this.replays.values()) for (const r of list) if (r.tex) out.push(r.tex);
    return out;
  }

  /** Pieces being painted right now. */
  pieces(): DecalState[] {
    const out: DecalState[] = [];
    for (const list of this.replays.values()) for (const r of list) if (!r.ended && !r.dead && r.st.hasPaint) out.push(r.st);
    return out;
  }

  private expire(id: string, r: Replay, ms: number): void {
    clearTimeout(r.timer);
    r.timer = setTimeout(() => this.drop(id, r), ms);
  }

  private drop(id: string, r: Replay): void {
    if (r.dead) return;
    r.dead = true;
    clearTimeout(r.timer);
    const list = this.replays.get(id);
    if (list) {
      const i = list.indexOf(r);
      if (i > -1) list.splice(i, 1);
      if (!list.length) this.replays.delete(id);
    }
    if (r.tex) this.scene.renderer?.invalidateTexture(texSource(r.tex));
    if (!r.ended) releasePiece(this.scene, r.st);
    this.scene.redraw();
  }
}
