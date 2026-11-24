import { PAINT_LAYER, type LayerTiles } from "../../shared/realtime";
import type { Scene } from "./scene";
import type { MarkerTexture, Strokes } from "./strokes";

/** The room's paint layer: older strokes, flattened by the server into a few tiles. */
export class PaintLayer {
  private readonly tiles = new Map<string, { version: number; tex: MarkerTexture }>();
  private room: string | null = null;
  private readonly scene: Scene;
  private readonly strokes: Strokes;

  constructor(scene: Scene, strokes: Strokes) {
    this.scene = scene;
    this.strokes = strokes;
  }

  /** Load or update these tiles; resolves once they're on screen (so strokes can swap without a gap). */
  async apply(room: string, tiles: LayerTiles): Promise<void> {
    this.room = room;
    const { width: LW, height: LH, tile: T } = PAINT_LAYER;
    await Promise.all(Object.entries(tiles).map(async ([key, version]) => {
      if (this.tiles.get(key)?.version === version) return;
      const [tx, ty] = key.split("_").map(Number);
      try {
        const blob = await (await fetch(`/api/layer/${encodeURIComponent(room)}/${key}?v=${version}`)).blob();
        const bitmap = await createImageBitmap(blob);
        if (this.room !== room) { bitmap.close?.(); return; }
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
        bitmap.close?.();
        // a fine grid so the tile follows the sphere when projected (like baked strokes)
        const N = 16;
        const gridBasic: [number, number][][] = [];
        for (let r = 0; r <= N; r++) {
          const row: [number, number][] = [];
          for (let c = 0; c <= N; c++) row.push([(tx * T + (c / N) * T) / LW, (ty * T + (r / N) * T) / LH]);
          gridBasic.push(row);
        }
        const tex: MarkerTexture = {
          canvas, gridBasic, gridRows: N, gridCols: N,
          srcWidth: canvas.width, srcHeight: canvas.height, referenceFov: 90, opacity: 1,
        };
        const old = this.tiles.get(key);
        if (old && old.version > version) return; // a newer one landed first
        this.tiles.set(key, { version, tex });
        // the layer is older paint: it sits under every separate stroke
        this.strokes.replace(old?.tex, tex);
      } catch (err) {
        console.warn("[realtime] paint layer tile failed:", key, err);
      }
    }));
    this.scene.redraw();
  }

  clear(): void {
    this.room = null;
    for (const { tex } of this.tiles.values()) this.strokes.remove(tex);
    this.tiles.clear();
  }
}
