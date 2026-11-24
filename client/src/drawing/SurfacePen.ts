import { simplify, type ToolType } from "../deep/decalTools";
import { mergePieces, type BakedPiece } from "../deep/geodesicMap";
import { realtime } from "../realtime/client";
import type { LiveRoom } from "./LiveRoom";
import type { Scene } from "./scene";
import type { MarkerTexture, Strokes } from "./strokes";
import { bakePiece, canPaintSurfaces, continues, MID_SAMPLE, paintFrame, pieceTexture, releasePiece, startPiece, type DecalState } from "./surfaceStrokes";

interface Params {
  color: string;
  lineWidth: number;
  toolType: ToolType;
  /** 1 = the usual size. It's the stroke's scale, which others get with it. */
  size: number;
}

/**
 * Drawing on 3D surfaces. The path is followed along the surface under the pointer; where it crosses
 * onto another surface the stroke continues there as a new piece. At the end the pieces become one
 * bitmap.
 */
export class SurfacePen {
  /** The piece being painted (null: not drawing on a surface). */
  active: DecalState | null = null;
  private params: Params | null = null;
  private group = 0;
  /** Screen points not walked yet, and where the walk is. */
  private path: [number, number][] = [];
  private pos: [number, number] = [0, 0];
  /** Finished pieces of the stroke in progress (merged into one bitmap when it ends). */
  private pieces: { piece: BakedPiece; tex: MarkerTexture }[] = [];
  /** When recent pieces started: many in a row = a ragged area, so be less eager to split there. */
  private chainTimes: number[] = [];
  /** Brush samples (u, v, decal x, y) not yet sent. */
  private samples: number[] = [];
  private lastSend = 0;
  private readonly scene: Scene;
  private readonly strokes: Strokes;
  private readonly room: LiveRoom;

  constructor(scene: Scene, strokes: Strokes, room: LiveRoom) {
    this.scene = scene;
    this.strokes = strokes;
    this.room = room;
  }

  /** Start a stroke at this screen point. False: there's no surface to draw on here. */
  start(x: number, y: number, params: Params, group: number): boolean {
    this.params = params;
    this.group = group;
    const b = this.scene.toPanorama(x, y);
    const st = b && this.newPiece(b);
    if (!st) return false;
    st.prev.screen = [x, y];
    this.dropPieces();
    this.path = [];
    this.pos = [x, y];
    this.chainTimes = [];
    this.begin(st);
    return true;
  }

  point(x: number, y: number): void {
    this.path.push([x, y]);
  }

  /** Pieces of the stroke in progress that are done. */
  finishedPieces(): MarkerTexture[] {
    return this.pieces.map((p) => p.tex);
  }

  /**
   * Walk the stroke along the surface through every pointer position since the last frame, in small
   * steps, then let the brush paint that bit. Fast moves are followed exactly like slow ones.
   */
  advance(): void {
    const path = this.path;
    if (!path.length) return;
    this.path = [];
    // steps of about one depth-map pixel (bigger ones could skip over a depth edge)
    const pxPerCell = Math.max(1, this.scene.height) / ((this.scene.fov / 180) * 1024);
    const step = Math.min(5, Math.max(2, pxPerCell));
    for (const [x, y] of path) {
      const [fx, fy] = this.pos;
      const n = Math.max(1, Math.ceil(Math.hypot(x - fx, y - fy) / step));
      for (let k = 1; k <= n; k++) this.step(fx + ((x - fx) * k) / n, fy + ((y - fy) * k) / n);
      this.pos = [x, y];
    }
    if (this.active) this.paintTrack(this.active);
  }

  /** The stroke is over: its pieces become one bitmap, on screen, undoable and shared right away. */
  end(moved: boolean): void {
    this.advance();
    const st0 = this.active;
    if (st0 && st0.off.length > 1 && moved) this.leaveSurface();
    const st = this.active;
    if (!st) return;
    this.endPiece(st);
    const pieces = this.pieces;
    this.pieces = [];
    if (!pieces.length) { this.scene.redraw(); return; }
    let tex = pieces[0].tex;
    if (pieces.length > 1) {
      tex = pieceTexture(mergePieces(pieces.map((p) => p.piece)), st);
      for (const p of pieces) this.strokes.forget(p.tex);
    }
    tex.isLocal = true;
    this.strokes.add(tex);
    this.room.history.add(tex);
    void this.room.share(tex);
    this.scene.redraw();
  }

  /** A piece of our stroke starts here: everyone else rebuilds the same decal and brush. */
  private begin(st: DecalState): void {
    this.active = st;
    this.samples = [];
    realtime.send({
      t: "stroke_start", color: st.params.color, lineWidth: st.params.lineWidth, toolType: st.toolType,
      u: st.start[0], v: st.start[1], fov: st.fov, group: st.group, seed: st.seed, wpp: st.geo.s,
    });
  }

  /** One small step of the stroke's path on screen. */
  private step(x: number, y: number): void {
    const st = this.active;
    const b = st && this.scene.toPanorama(x, y);
    if (!st || !b) return;
    if (!st.geo.isSurface(b[0], b[1])) {
      // over the sky: the pen is up until the path is back on something
      st.gap = true;
      st.off = [];
      return;
    }
    // how far the path may be off this surface before the stroke continues on the other one
    // (thin things like railings are skipped; ragged areas like trees split less eagerly)
    const now = performance.now();
    this.chainTimes = this.chainTimes.filter((t) => now - t < 400);
    const hop = Math.min(48, 6 + 4 * this.chainTimes.length);
    const d = st.geo.reach(b[0], b[1]);
    if (d && continues(st, b, d)) {
      if (!st.gap || Math.hypot(x - st.prev.screen[0], y - st.prev.screen[1]) <= hop) {
        st.gap = false;
        st.off = [];
        st.prev = { basic: b, decal: d, screen: [x, y] };
        st.track.push(st.prev);
        if (Math.hypot(d[0] - st.marked[0], d[1] - st.marked[1]) > st.nearRadius * 0.4) {
          st.geo.markNear(b[0], b[1], st.nearRadius * st.geo.s);
          st.marked = d;
        }
        return;
      }
      this.chain(x, y, b);
      return;
    }
    st.off.push([x, y]);
    const [ox, oy] = st.off[0];
    if (Math.hypot(x - ox, y - oy) >= hop) this.leaveSurface();
  }

  /** The path is off this piece's surface for good: continue the stroke from where it left. */
  private leaveSurface(): void {
    const st = this.active;
    if (!st || !st.off.length) return;
    const off = st.off;
    st.off = [];
    const b = this.scene.toPanorama(off[0][0], off[0][1]);
    if (!b) return;
    // still the same surface (the unwrap just ended here): join on at the last painted point
    const near = st.geo.step(st.prev.basic, b);
    const moved = st.hasPaint || st.track.length > 0; // a piece that got nowhere isn't joined onto again
    const joined = moved && !st.gap && near.depth < 1.15 && Math.hypot(off[0][0] - st.prev.screen[0], off[0][1] - st.prev.screen[1]) < 8;
    const ok = joined
      ? this.chain(st.prev.screen[0], st.prev.screen[1], st.prev.basic, st.geo.worldPerPxAt(st.prev.basic[0], st.prev.basic[1]) ?? undefined)
      : this.chain(off[0][0], off[0][1], b);
    if (!ok) { st.gap = true; return; }
    for (const [x, y] of joined ? off : off.slice(1)) this.step(x, y);
  }

  /** Finish the current piece and continue the same stroke on a new one starting at this point. */
  private chain(x: number, y: number, b: [number, number], worldPerPx?: number): boolean {
    const st = this.active;
    if (!st) return false;
    const next = this.newPiece(b, worldPerPx);
    if (!next) { st.gap = true; return false; }
    next.prev.screen = [x, y];
    this.endPiece(st);
    next.tool.resume(st.tool);
    this.chainTimes.push(performance.now());
    this.begin(next);
    return true;
  }

  /** Hand the path walked so far to the brush (and to everyone watching). */
  private paintTrack(st: DecalState): void {
    const track = st.track;
    if (!track.length) return;
    let dist = 0, p = st.painted;
    for (const t of track) { dist += Math.hypot(t.decal[0] - p[0], t.decal[1] - p[1]); p = t.decal; }
    if (dist < 1) return; // too little yet: paint it with the next frame
    st.track = [];
    const round = (v: number) => Math.round(v * 100) / 100;
    const pts = track.map((t) => [round(t.decal[0]), round(t.decal[1])] as [number, number]);
    const keep = simplify(st.painted, pts, 0.6);
    const kept = keep.map((i) => pts[i]);
    keep.forEach((i, k) => {
      const mid = k < keep.length - 1;
      this.samples.push(+track[i].basic[0].toFixed(6), +track[i].basic[1].toFixed(6), pts[i][0] + (mid ? MID_SAMPLE : 0), pts[i][1]);
    });
    this.sendSamples();
    paintFrame(st, kept, track[track.length - 1].basic);
  }

  /** End a piece: bake it now (it's small), free its surface map, keep the picture on screen. */
  private endPiece(st: DecalState): void {
    this.paintTrack(st);
    this.sendSamples(true);
    realtime.send({ t: "stroke_end" });
    const piece = bakePiece(st);
    if (piece) this.pieces.push({ piece, tex: pieceTexture(piece, st) });
    releasePiece(this.scene, st);
    if (this.active === st) this.active = null;
  }

  private dropPieces(): void {
    for (const { tex } of this.pieces) this.strokes.forget(tex);
    this.pieces = [];
  }

  /** Send the brush samples gathered so far (~20 times a second; force = now, e.g. stroke end). */
  private sendSamples(force = false): void {
    const pts = this.samples;
    if (!pts.length) return;
    const now = performance.now();
    if (!force && now - this.lastSend < 50 && pts.length < 4 * 120) return;
    this.lastSend = now;
    this.samples = [];
    for (let i = 0; i < pts.length; i += 4 * 120) {
      const part = pts.slice(i, i + 4 * 120);
      realtime.send({ t: "stroke_point", u: part[part.length - 4], v: part[part.length - 3], pts: part });
    }
  }

  private newPiece(b: [number, number], worldPerPx?: number): DecalState | null {
    const s = this.scene;
    if (!canPaintSurfaces(s) || !this.params) return null;
    return startPiece(s.deep, b, s.radPerPx * this.params.size, worldPerPx, false, this.params, Math.floor(Math.random() * 2 ** 31), this.group, s.fov);
  }
}
