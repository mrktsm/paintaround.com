/** Recover subtle detail from the legacy shading^0.3 * detail^0.6 export,
 * then apply full-strength lighting. Lighting changes RGB, never coverage.
 * `illumination` is grey (one value per pixel) or interleaved RGB (three);
 * the result has the same layout as `illumination`. */
export function restoreSurfaceLighting(shade: Float32Array, surface: Float32Array, illumination = shade) {
  const channels = illumination.length / shade.length;
  if (shade.length !== surface.length || (channels !== 1 && channels !== 3)) throw new Error('Paint layers must have matching dimensions.');
  return Float32Array.from(illumination, (light, i) => {
    const p = channels === 1 ? i : (i / 3) | 0;
    const detail = surface[p] / Math.pow(Math.max(shade[p], 1e-3), 0.3);
    return light * Math.pow(Math.max(detail, 0), 0.25 / 0.6);
  });
}
