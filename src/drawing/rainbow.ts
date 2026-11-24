/** Resolve 'rainbow' into a concrete CSS color using the same continuous
 *  hue rotation as the GPU shader (Date.now() / 20 → degrees). */
export function resolveRainbowColor(): string {
  const hue = (Date.now() / 20) % 360;
  return `hsl(${hue}, 90%, 55%)`;
}

/** Get the current hue-shift value (0..1) for rainbow texture animation. */
export function getRainbowHueShift(): number {
  return ((Date.now() / 20) % 360) / 360;
}
