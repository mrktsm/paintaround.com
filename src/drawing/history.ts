import type { LiveRoom } from "./LiveRoom";
import type { Scene } from "./scene";
import type { MarkerTexture, Strokes } from "./strokes";

/** One eraser gesture over our own strokes: each touched stroke's pixels before and after. */
export interface EraseEdit {
  kind: "erase";
  strokeGroup?: undefined;
  items: Map<MarkerTexture, { before: HTMLCanvasElement; after?: HTMLCanvasElement; removed: boolean }>;
}

/** One step of undo: a stroke, or an eraser gesture. */
export type UndoEntry = MarkerTexture | EraseEdit;

const isEraseEdit = (e: UndoEntry | undefined): e is EraseEdit => (e as EraseEdit | undefined)?.kind === "erase";

/** Undo and redo of our own strokes and erasing. */
export class History {
  /** Called when undo or redo became available or not. */
  onChange: (() => void) | null = null;
  /** Called for each stroke that gets undone. */
  onUndone: ((tex: MarkerTexture) => void) | null = null;
  private done: UndoEntry[] = [];
  private undone: UndoEntry[] = [];
  private readonly scene: Scene;
  private readonly strokes: Strokes;
  private readonly room: LiveRoom;

  constructor(scene: Scene, strokes: Strokes, room: LiveRoom) {
    this.scene = scene;
    this.strokes = strokes;
    this.room = room;
  }

  canUndo(): boolean {
    return this.done.length > 0;
  }

  canRedo(): boolean {
    return this.undone.length > 0;
  }

  add(entry: UndoEntry): void {
    this.done.push(entry);
    this.undone = [];
    this.onChange?.();
  }

  isUndone(tex: MarkerTexture): boolean {
    return this.undone.includes(tex);
  }

  /** These strokes can't be undone any more (by their id in the live room). */
  forget(ids: string[]): void {
    const gone = new Set(ids);
    const keep = (e: UndoEntry) => isEraseEdit(e) || !e.liveId || !gone.has(e.liveId);
    this.done = this.done.filter(keep);
    this.undone = this.undone.filter(keep);
    this.onChange?.();
  }

  /** Undo the last stroke — all of its pieces if it crossed several surfaces. */
  undo(): void {
    this.step(this.done, this.undone, true);
  }

  redo(): void {
    this.step(this.undone, this.done, false);
  }

  private step(from: UndoEntry[], to: UndoEntry[], undo: boolean): void {
    const group = from[from.length - 1]?.strokeGroup;
    do {
      const entry = from.pop();
      if (!entry) return;
      if (isEraseEdit(entry)) {
        this.apply(entry, undo);
      } else if (undo) {
        this.onUndone?.(entry);
        this.strokes.remove(entry);
        this.room.erase([entry]);
      } else {
        this.strokes.add(entry);
      }
      to.push(entry);
      if (!undo && !isEraseEdit(entry)) void this.room.share(entry); // back for everyone, with the same id
      this.scene.redraw();
    } while (group !== undefined && from[from.length - 1]?.strokeGroup === group);
  }

  /** Put an erase gesture's strokes back to before (undo) or after (redo) it. */
  private apply(edit: EraseEdit, undo: boolean): void {
    const gone: MarkerTexture[] = [];
    for (const [tex, item] of edit.items) {
      const src = undo ? item.before : item.after;
      if (!src || !tex.canvas) continue;
      const ctx = tex.canvas.getContext("2d")!;
      ctx.clearRect(0, 0, tex.canvas.width, tex.canvas.height);
      ctx.drawImage(src, 0, 0);
      this.strokes.forget(tex);
      if (item.removed && !undo) {
        this.strokes.remove(tex);
        gone.push(tex);
        continue;
      }
      if (!this.strokes.has(tex)) this.strokes.add(tex);
      void this.room.share(tex);
    }
    if (gone.length) this.room.erase(gone);
  }

  clear(): void {
    this.done = [];
    this.undone = [];
  }
}
