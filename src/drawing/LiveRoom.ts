import type { FinishedStroke, ServerMessage } from "../../shared/realtime";
import { realtime } from "../realtime/client";
import { History } from "./history";
import { PaintLayer } from "./PaintLayer";
import { PeerCursors } from "./PeerCursors";
import { PeerPreviews } from "./PeerPreviews";
import { Replays } from "./Replays";
import type { Scene } from "./scene";
import type { MarkerTexture, Strokes } from "./strokes";

/** The place's live room: what others draw shows up here, and what we draw is shared. */
export class LiveRoom {
  readonly history: History;
  readonly peers: PeerCursors;
  readonly replays: Replays;
  private readonly previews: PeerPreviews;
  private readonly layer: PaintLayer;
  private readonly scene: Scene;
  private readonly strokes: Strokes;
  private room: string | null = null;
  private off: (() => void) | null = null;
  /** Strokes being encoded for the room. */
  private readonly sharing = new Set<Promise<void>>();
  private ownChanges = false;
  private lastCursor = 0;
  private cursorShared = false;

  constructor(scene: Scene, strokes: Strokes) {
    this.scene = scene;
    this.strokes = strokes;
    this.history = new History(scene, strokes, this);
    this.peers = new PeerCursors(scene);
    this.replays = new Replays(scene);
    this.layer = new PaintLayer(scene, strokes);
    this.previews = new PeerPreviews(scene, this.peers, {
      swap: (remove, add) => {
        if (remove) strokes.remove(remove);
        if (add) strokes.add(add);
        scene.redraw();
      },
    });
  }

  /** Join this panorama's live room: others' cursors and strokes appear, ours are shared. */
  join(imageId: string): void {
    this.leaveRoom();
    this.room = imageId;
    this.off = realtime.on((msg) => this.receive(msg));
    realtime.join(imageId);
  }

  /**
   * Leaving the place: stop listening and leave its live room on the server. Without this the
   * connection stayed in the room, so coming back to the same place was ignored as "already
   * there" and its saved drawings never arrived until a reload.
   */
  leave(): void {
    this.leaveRoom();
    this.room = null;
    // a stroke finished just now may still be encoding: let it reach the room first
    if (this.sharing.size) realtime.leaveAfter(Promise.race([Promise.allSettled(this.sharing), new Promise((r) => setTimeout(r, 3000))]));
    else realtime.leave();
  }

  private leaveRoom(): void {
    this.off?.();
    this.off = null;
    this.layer.clear();
    // others' strokes in progress and cursors
    this.previews.clear();
    this.replays.clear();
    this.peers.clear();
  }

  /**
   * Share a finished stroke exactly as we see it: the baked bitmap (3D wrap + lighting
   * included) and its panorama grid. Called for every finished stroke.
   */
  share(tex: MarkerTexture): Promise<void> {
    this.ownChanges = true;
    const p = this.send(tex).catch((e) => console.warn("[realtime] could not share a stroke:", e));
    this.sharing.add(p);
    void p.then(() => this.sharing.delete(p));
    return p;
  }

  /** Tell the room these finished strokes are gone (undo / eraser). */
  erase(textures: MarkerTexture[]): void {
    this.ownChanges = true;
    const ids = textures.map((t) => t.liveId).filter((id): id is string => !!id);
    if (ids.length) realtime.send({ t: "erase", ids });
  }

  /** Did we draw, undo or erase here since the last time this was asked? */
  takeOwnChanges(): boolean {
    const c = this.ownChanges;
    this.ownChanges = false;
    return c;
  }

  /** Share our brush position (panorama coords + angular radius), about 20 times a second at most. */
  shareCursor(b: [number, number], radiusPx: number, paint: string | null, force = false): void {
    const now = performance.now();
    if (!force && now - this.lastCursor < 50) return;
    this.cursorShared = true;
    this.lastCursor = now;
    realtime.send({ t: "cursor", u: b[0], v: b[1], radius: radiusPx * this.scene.radPerPx, paint: paint === "rainbow" ? null : paint });
  }

  /** Others stop seeing our ring (finger lifted, pointer left, over the sky). */
  hideCursor(): void {
    if (this.cursorShared) realtime.send({ t: "cursor_hide" });
    this.cursorShared = false;
  }

  private receive(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        // strokes others drew in this room before we arrived (held in server memory)
        this.peers.clear();
        for (const p of msg.peers) this.peers.colors.set(p.id, p.color);
        if (msg.layer) void this.layer.apply(this.room!, msg.layer);
        for (const s of msg.strokes) void this.add(s);
        return;
      case "flattened":
        // swap the separate strokes for the updated layer once its tiles are on screen
        if (this.room) void this.layer.apply(this.room, msg.tiles).then(() => this.dropFlattened(msg.ids));
        return;
      case "peer_join":
        this.peers.colors.set(msg.peer.id, msg.peer.color);
        return;
      case "peer_leave":
        this.peers.colors.delete(msg.id);
        this.peers.brush.delete(msg.id);
        this.peers.remove(msg.id);
        this.previews.end(msg.id);
        this.replays.remove(msg.id);
        return;
      case "cursor":
        this.peers.set(msg.from, msg);
        return;
      case "cursor_hide":
        this.peers.remove(msg.from);
        return;
      case "stroke_start":
        if (msg.seed !== undefined && msg.wpp !== undefined && this.replays.start(msg.from, msg)) return this.previews.end(msg.from);
        this.previews.start(msg.from, msg.color, msg.u, msg.v, msg.group);
        return;
      case "stroke_point": {
        const r = this.replays.live(msg.from);
        if (r && msg.pts) return this.replays.samples(r, msg.pts);
        this.previews.point(msg.from, msg.u, msg.v);
        return;
      }
      case "stroke_end": {
        const r = this.replays.live(msg.from);
        if (r) return this.replays.end(msg.from, r);
        this.previews.pieceEnded(msg.from);
        return;
      }
      case "stroke_done": {
        // the finished, lit bitmap replaces the live line once the whole stroke is over
        const from = msg.from, group = msg.stroke.strokeGroup;
        const dropReplay = this.replays.finished(from, group);
        void this.add(msg.stroke).then(() => {
          requestAnimationFrame(dropReplay);
          this.previews.finished(from, group);
        });
        return;
      }
      case "erase":
        if (this.strokes.removeShared(msg.ids)) this.scene.redraw();
        return;
    }
  }

  /** Add someone else's finished stroke (or replace it, e.g. after their redo). */
  private async add(s: FinishedStroke): Promise<void> {
    const room = this.room;
    try {
      const blob = await (await fetch(s.image)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      if (this.room !== room) return; // moved to another panorama meanwhile
      this.strokes.removeShared([s.id]);
      const tex: MarkerTexture = {
        canvas,
        gridBasic: s.gridBasic,
        gridRows: s.gridRows,
        gridCols: s.gridCols,
        srcWidth: s.srcWidth,
        srcHeight: s.srcHeight,
        referenceFov: s.referenceFov,
        toolType: s.toolType,
        liveId: s.id,
        opacity: 1,
        isRainbow: s.isRainbow,
      };
      this.strokes.add(tex);
      this.scene.redraw();
    } catch (err) {
      console.error("[realtime] could not add a shared stroke:", err);
    }
  }

  /** Strokes that are now part of the paint layer: drop the separate copies (ours too: undo can't reach into the layer). */
  private dropFlattened(ids: string[]): void {
    this.history.forget(ids);
    if (this.strokes.removeShared(ids)) this.scene.redraw();
  }

  private async send(tex: MarkerTexture): Promise<void> {
    if (!tex.canvas) return;
    const room = realtime.current;
    tex.liveId ??= crypto.randomUUID();
    const canvas = tex.canvas;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
    const finalBlob = blob?.type === "image/webp" ? blob : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!finalBlob) return;
    const image = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(finalBlob);
    });
    // undone while encoding: don't resurrect it for everyone else
    if (this.history.isUndone(tex)) return;
    if (realtime.current !== room) return; // in another place by now
    realtime.send({
      t: "stroke_done",
      stroke: {
        id: tex.liveId,
        image,
        gridBasic: tex.gridBasic,
        gridRows: tex.gridRows,
        gridCols: tex.gridCols,
        srcWidth: tex.srcWidth,
        srcHeight: tex.srcHeight,
        referenceFov: tex.referenceFov,
        isRainbow: !!tex.isRainbow,
        toolType: tex.toolType,
        strokeGroup: tex.strokeGroup,
      },
    });
  }
}
