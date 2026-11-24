import type { Viewer } from "mapillary-js";
import type { PreviewView } from "../pool/localPreview";
import type { LiveRoom } from "./LiveRoom";
import { buildPanoramaGeometry, buildScreenGeometry, drawTexturedTriangle, projectionUniforms, projectToScreen } from "./projection";
import { getRainbowHueShift } from "./rainbow";
import type { Scene } from "./scene";
import { texSource, type MarkerTexture, type Strokes } from "./strokes";
import type { SurfacePen } from "./SurfacePen";
import { drawLivePieces, type DecalState } from "./surfaceStrokes";

/**
 * Draws the strokes over the photo. Normally the GPU projects them, so they move with the camera in
 * the same frame; without that, they are projected here and drawn as triangles.
 */
export class StrokeRenderer {
  private camera = 0;
  private redrawing = false;
  private rainbow: number | null = null;
  private readonly scene: Scene;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly strokes: Strokes;
  private readonly pen: SurfacePen;
  private readonly room: LiveRoom;
  private readonly viewer: () => Viewer | null;

  constructor(scene: Scene, ctx: CanvasRenderingContext2D, strokes: Strokes, pen: SurfacePen, room: LiveRoom, viewer: () => Viewer | null) {
    this.scene = scene;
    this.ctx = ctx;
    this.strokes = strokes;
    this.pen = pen;
    this.room = room;
    this.viewer = viewer;
    strokes.onRainbow = () => this.animateRainbow();
  }

  /** Everything baked that's on screen: finished strokes, then pieces of strokes in progress. */
  private baked(): MarkerTexture[] {
    const extra = [...this.room.replays.strokes(), ...this.pen.finishedPieces()];
    return extra.length ? [...this.strokes.list, ...extra] : this.strokes.list;
  }

  /** Pieces being painted right now, on 3D surfaces. */
  private painting(): DecalState[] {
    const out = this.room.replays.pieces();
    if (this.pen.active?.hasPaint) out.push(this.pen.active);
    return out;
  }

  private empty(): boolean {
    return !this.baked().length && !this.painting().length;
  }

  /** The camera moved: draw the strokes where they are now. */
  cameraMoved(): void {
    if (this.drawNow()) return;
    // projected here: mark them stale, and draw once per frame
    this.camera++;
    for (const tex of this.strokes.list) tex.needsProjection = true;
    if (this.redrawing) return;
    this.redrawing = true;
    requestAnimationFrame(() => {
      this.redrawing = false;
      void this.redraw();
    });
  }

  /** Draw right now, in step with the panorama. False: only possible asynchronously. */
  private drawNow(): boolean {
    if (!this.scene.renderer?.hasGPUProjection() || !this.scene.projection()) return false;
    if (!this.empty()) this.drawOnGPU(true);
    return true;
  }

  async redraw(): Promise<void> {
    if (!this.viewer()) return;
    this.ctx.clearRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
    this.scene.renderer?.clear();
    await this.drawStrokes();
  }

  private drawOnGPU(clear = false): boolean {
    const r = this.scene.renderer;
    if (!r?.hasGPUProjection()) return false;
    const uniforms = projectionUniforms(this.scene.projection());
    if (!uniforms) return false;
    if (clear) r.clear();
    r.setGPUProjectionUniforms(uniforms);
    const hueShift = getRainbowHueShift();
    for (const tex of this.baked()) {
      if (!tex._gpuBasicCoords) buildPanoramaGeometry(tex);
      if (!tex._gpuVertexCount) continue;
      r.drawGPUProjectedBatch(texSource(tex), tex._gpuBasicCoords!, tex._gpuTexCoords!, tex.opacity ?? 1, false, tex.isRainbow ? hueShift : 0);
    }
    drawLivePieces(r, this.painting());
    return true;
  }

  async drawStrokes(): Promise<void> {
    const viewer = this.viewer();
    if (!viewer || this.empty()) return;
    if (this.drawOnGPU()) return;

    // ── CPU projection fallback ──────────────────────────────────────────
    const camera = this.camera;
    const syncCtx = this.scene.projection();

    const asyncProjections: Promise<number[] | null>[] = [];
    const asyncMeta: { tex: MarkerTexture; startIdx: number }[] = [];

    for (const tex of this.strokes.list) {
      if (tex.isProjecting) continue;
      if (tex.cachedProjection && !tex.needsProjection) continue;

      if (syncCtx) {
        let canSync = true;
        const projectedGrid: ([number, number] | null)[][] = [];
        outer: for (let row = 0; row <= tex.gridRows; row++) {
          const rowPoints: ([number, number] | null)[] = [];
          for (let col = 0; col <= tex.gridCols; col++) {
            const syncPoint = projectToScreen(
              tex.gridBasic[row][col],
              syncCtx,
            );
            if (syncPoint === undefined) {
              canSync = false;
              break outer;
            }
            rowPoints.push(syncPoint);
          }
          projectedGrid.push(rowPoints);
        }

        if (canSync) {
          tex.cachedProjection = projectedGrid;
          tex.needsProjection = false;
          if (this.scene.renderer) buildScreenGeometry(tex);
          continue;
        }
      }

      tex.isProjecting = true;
      const startIdx = asyncProjections.length;
      for (let row = 0; row <= tex.gridRows; row++) {
        for (let col = 0; col <= tex.gridCols; col++) {
          asyncProjections.push(
            viewer.projectFromBasic(tex.gridBasic[row][col]),
          );
        }
      }
      asyncMeta.push({ tex, startIdx });
    }

    if (asyncProjections.length > 0) {
      const allResults = await Promise.all(asyncProjections);
      const cameraMoved = this.camera !== camera;

      for (const { tex, startIdx } of asyncMeta) {
        tex.isProjecting = false;
        if (!cameraMoved) {
          const projectedGrid: ([number, number] | null)[][] = [];
          let idx = startIdx;
          for (let row = 0; row <= tex.gridRows; row++) {
            const rowPoints: ([number, number] | null)[] = [];
            for (let col = 0; col <= tex.gridCols; col++) {
              const p = allResults[idx++];
              rowPoints.push(p ? [p[0], p[1]] : null);
            }
            projectedGrid.push(rowPoints);
          }
          tex.cachedProjection = projectedGrid;
          tex.needsProjection = false;
          if (this.scene.renderer) buildScreenGeometry(tex);
        }
      }
    }

    for (const tex of this.strokes.list) {
      if (!tex.cachedProjection) continue;
      const texOpacity = tex.opacity ?? 1;

      if (this.scene.renderer) {
        if (tex._glTriCount && tex._glPositions && tex._glTexCoords) {
          const hueShiftCPU = tex.isRainbow ? getRainbowHueShift() : 0;
          this.scene.renderer.drawTexturedTriangleBatch(
            texSource(tex),
            tex._glPositions,
            tex._glTexCoords,
            texOpacity,
            false,
            hueShiftCPU,
          );
        }
      } else {
        const projectedGrid = tex.cachedProjection;
        const cellWidth = tex.srcWidth / tex.gridCols;
        const cellHeight = tex.srcHeight / tex.gridRows;
        const savedAlpha = this.ctx.globalAlpha;
        this.ctx.globalAlpha = texOpacity;
        try {
          for (let row = 0; row < tex.gridRows; row++) {
            for (let col = 0; col < tex.gridCols; col++) {
              const tl = projectedGrid[row][col];
              const tr = projectedGrid[row][col + 1];
              const bl = projectedGrid[row + 1][col];
              const br = projectedGrid[row + 1][col + 1];
              if (!tl || !tr || !bl || !br) continue;
              const srcX = col * cellWidth;
              const srcY = row * cellHeight;
              drawTexturedTriangle(
                this.ctx,
                texSource(tex),
                srcX,
                srcY,
                srcX + cellWidth,
                srcY,
                srcX,
                srcY + cellHeight,
                tl[0],
                tl[1],
                tr[0],
                tr[1],
                bl[0],
                bl[1],
              );
              drawTexturedTriangle(
                this.ctx,
                texSource(tex),
                srcX + cellWidth,
                srcY,
                srcX + cellWidth,
                srcY + cellHeight,
                srcX,
                srcY + cellHeight,
                tr[0],
                tr[1],
                br[0],
                br[1],
                bl[0],
                bl[1],
              );
            }
          }
        } catch {
          // a texture that can't be drawn (yet) is skipped this frame
        }
        this.ctx.globalAlpha = savedAlpha;
      }
    }
  }

  /** Everything painted here as seen from this view (transparent background; ss = supersampling). */
  preview(view: PreviewView, ss: number): HTMLCanvasElement | null {
    const draws = this.baked().flatMap((tex) => {
      if (!tex._gpuBasicCoords) buildPanoramaGeometry(tex);
      return tex._gpuVertexCount
        ? [{ source: texSource(tex), basic: tex._gpuBasicCoords!, uv: tex._gpuTexCoords!, opacity: tex.opacity ?? 1 }]
        : [];
    });
    return this.scene.renderer?.renderPreview(draws, view, ss) ?? null;
  }

  /** Rainbow strokes keep changing colour while there are any. */
  private animateRainbow(): void {
    if (this.rainbow !== null) return;
    const loop = () => {
      if (!this.strokes.list.some((t) => t.isRainbow)) {
        this.rainbow = null;
        return;
      }
      this.cameraMoved();
      this.rainbow = requestAnimationFrame(loop);
    };
    this.rainbow = requestAnimationFrame(loop);
  }

  dispose(): void {
    if (this.rainbow !== null) cancelAnimationFrame(this.rainbow);
    this.rainbow = null;
  }
}
