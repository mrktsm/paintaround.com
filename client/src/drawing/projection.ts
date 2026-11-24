import type { ProjectionContext } from "./scene";
import type { MarkerTexture } from "./strokes";
import type { GPUProjectionUniforms } from "./WebGLDrawingRenderer";

/** A panorama point on screen (null: not on screen, undefined: can't be told synchronously). */
export function projectToScreen(
  basicPoint: number[],
  ctx: ProjectionContext | null,
): [number, number] | null | undefined {
  if (!ctx) return undefined;
  try {
    const canvasPoint = ctx.proj.basicToCanvas(
      basicPoint,
      ctx.container,
      ctx.renderCamera,
      ctx.transform,
    );
    if (canvasPoint) {
      return [Math.round(canvasPoint[0]), Math.round(canvasPoint[1])];
    }
    return null;
  } catch {
    return undefined;
  }
}

/**
 * Extract projection uniforms from mapillary internals for GPU projection.
 * Returns null if internals are not accessible.
 */
export function projectionUniforms(ctx: ProjectionContext | null): GPUProjectionUniforms | null {
  if (!ctx) return null;

  try {
    const perspective = ctx.renderCamera.perspective;
    const transform = ctx.transform;

    if (!perspective || !transform) return null;

    const rtMatrix = transform.rt;
    if (!rtMatrix?.clone) return null;

    const cameraToWorld = rtMatrix.clone().invert();

    if (
      !perspective.projectionMatrix?.elements ||
      !perspective.matrixWorldInverse?.elements ||
      !cameraToWorld.elements
    )
      return null;

    // Camera type: 'perspective' | 'spherical' | 'fisheye'
    const cameraTypeStr = transform.cameraType;
    let cameraType = 0;
    if (cameraTypeStr === "spherical") cameraType = 1;
    else if (cameraTypeStr === "fisheye") cameraType = 2;

    return {
      cameraToWorld: new Float32Array(cameraToWorld.elements),
      projectionMatrix: new Float32Array(
        perspective.projectionMatrix.elements,
      ),
      viewMatrix: new Float32Array(perspective.matrixWorldInverse.elements),
      focal: transform.focal,
      imageWidth: transform.width,
      imageHeight: transform.height,
      ck1: transform.ck1 || 0,
      ck2: transform.ck2 || 0,
      orientation: transform.orientation || 1,
      cameraType,
    };
  } catch (e) {
    console.error("[GPU] uniform extraction error:", e);
    return null;
  }
}

/** Screen-space triangles of a stroke, for the fallback without GPU projection. */
export function buildScreenGeometry(tex: MarkerTexture): void {
  const projectedGrid = tex.cachedProjection;
  if (!projectedGrid) return;

  const maxTris = tex.gridRows * tex.gridCols * 2;
  const positions = new Float32Array(maxTris * 6);
  const texCoords = new Float32Array(maxTris * 6);
  let triCount = 0;

  for (let row = 0; row < tex.gridRows; row++) {
    for (let col = 0; col < tex.gridCols; col++) {
      const tl = projectedGrid[row][col];
      const tr = projectedGrid[row][col + 1];
      const bl = projectedGrid[row + 1][col];
      const br = projectedGrid[row + 1][col + 1];
      if (!tl || !tr || !bl || !br) continue;

      const u0 = col / tex.gridCols,
        v0 = row / tex.gridRows;
      const u1 = (col + 1) / tex.gridCols,
        v1 = (row + 1) / tex.gridRows;

      let b = triCount * 6;
      positions[b] = tl[0];
      positions[b + 1] = tl[1];
      positions[b + 2] = tr[0];
      positions[b + 3] = tr[1];
      positions[b + 4] = bl[0];
      positions[b + 5] = bl[1];
      texCoords[b] = u0;
      texCoords[b + 1] = v0;
      texCoords[b + 2] = u1;
      texCoords[b + 3] = v0;
      texCoords[b + 4] = u0;
      texCoords[b + 5] = v1;
      triCount++;

      b = triCount * 6;
      positions[b] = tr[0];
      positions[b + 1] = tr[1];
      positions[b + 2] = br[0];
      positions[b + 3] = br[1];
      positions[b + 4] = bl[0];
      positions[b + 5] = bl[1];
      texCoords[b] = u1;
      texCoords[b + 1] = v0;
      texCoords[b + 2] = u1;
      texCoords[b + 3] = v1;
      texCoords[b + 4] = u0;
      texCoords[b + 5] = v1;
      triCount++;
    }
  }

  tex._glPositions = positions.subarray(0, triCount * 6);
  tex._glTexCoords = texCoords.subarray(0, triCount * 6);
  tex._glTriCount = triCount;
}

/**
 * Build GPU projection geometry for a MarkerTexture.
 * Called once when a texture is created — stores basic coords and UVs
 * as Float32Arrays that never change (projection happens on GPU).
 */
export function buildPanoramaGeometry(tex: MarkerTexture): void {
  const maxTris = tex.gridRows * tex.gridCols * 2;
  const basicCoords = new Float32Array(maxTris * 6);
  const texCoords = new Float32Array(maxTris * 6);
  let triCount = 0;

  for (let row = 0; row < tex.gridRows; row++) {
    for (let col = 0; col < tex.gridCols; col++) {
      const tl = tex.gridBasic[row][col];
      const tr = tex.gridBasic[row][col + 1];
      const bl = tex.gridBasic[row + 1][col];
      const br = tex.gridBasic[row + 1][col + 1];

      // Skip cells with failed unprojection (zero coords)
      if (
        (!tl[0] && !tl[1]) ||
        (!tr[0] && !tr[1]) ||
        (!bl[0] && !bl[1]) ||
        (!br[0] && !br[1])
      )
        continue;

      const u0 = col / tex.gridCols,
        v0 = row / tex.gridRows;
      const u1 = (col + 1) / tex.gridCols,
        v1 = (row + 1) / tex.gridRows;

      // Triangle 1: tl, tr, bl
      let b = triCount * 6;
      basicCoords[b] = tl[0];
      basicCoords[b + 1] = tl[1];
      basicCoords[b + 2] = tr[0];
      basicCoords[b + 3] = tr[1];
      basicCoords[b + 4] = bl[0];
      basicCoords[b + 5] = bl[1];
      texCoords[b] = u0;
      texCoords[b + 1] = v0;
      texCoords[b + 2] = u1;
      texCoords[b + 3] = v0;
      texCoords[b + 4] = u0;
      texCoords[b + 5] = v1;
      triCount++;

      // Triangle 2: tr, br, bl
      b = triCount * 6;
      basicCoords[b] = tr[0];
      basicCoords[b + 1] = tr[1];
      basicCoords[b + 2] = br[0];
      basicCoords[b + 3] = br[1];
      basicCoords[b + 4] = bl[0];
      basicCoords[b + 5] = bl[1];
      texCoords[b] = u1;
      texCoords[b + 1] = v0;
      texCoords[b + 2] = u1;
      texCoords[b + 3] = v1;
      texCoords[b + 4] = u0;
      texCoords[b + 5] = v1;
      triCount++;
    }
  }

  tex._gpuBasicCoords = basicCoords.subarray(0, triCount * 6);
  tex._gpuTexCoords = texCoords.subarray(0, triCount * 6);
  tex._gpuVertexCount = triCount * 3;
}

/** Draw one triangle of a bitmap with the 2D canvas (the fallback without WebGL). */
export function drawTexturedTriangle(
  ctx: CanvasRenderingContext2D,
  img: HTMLCanvasElement | HTMLImageElement,
  sx0: number,
  sy0: number,
  sx1: number,
  sy1: number,
  sx2: number,
  sy2: number,
  dx0: number,
  dy0: number,
  dx1: number,
  dy1: number,
  dx2: number,
  dy2: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(dx0, dy0);
  ctx.lineTo(dx1, dy1);
  ctx.lineTo(dx2, dy2);
  ctx.closePath();
  ctx.clip();

  const x0 = sx0,
    y0 = sy0;
  const x1 = sx1,
    y1 = sy1;
  const x2 = sx2,
    y2 = sy2;

  const u0 = dx0,
    v0 = dy0;
  const u1 = dx1,
    v1 = dy1;
  const u2 = dx2,
    v2 = dy2;

  const delta = x0 * (y1 - y2) + x1 * (y2 - y0) + x2 * (y0 - y1);
  if (Math.abs(delta) < 0.0001) {
    ctx.restore();
    return;
  }

  const deltaA = u0 * (y1 - y2) + u1 * (y2 - y0) + u2 * (y0 - y1);
  const deltaB = x0 * (u1 - u2) + x1 * (u2 - u0) + x2 * (u0 - u1);
  const deltaC =
    x0 * (y1 * u2 - y2 * u1) +
    x1 * (y2 * u0 - y0 * u2) +
    x2 * (y0 * u1 - y1 * u0);

  const deltaD = v0 * (y1 - y2) + v1 * (y2 - y0) + v2 * (y0 - y1);
  const deltaE = x0 * (v1 - v2) + x1 * (v2 - v0) + x2 * (v0 - v1);
  const deltaF =
    x0 * (y1 * v2 - y2 * v1) +
    x1 * (y2 * v0 - y0 * v2) +
    x2 * (y0 * v1 - y1 * v0);

  ctx.transform(
    deltaA / delta,
    deltaD / delta,
    deltaB / delta,
    deltaE / delta,
    deltaC / delta,
    deltaF / delta,
  );

  ctx.drawImage(img, 0, 0);
  ctx.restore();
}
