/** The drawing tools. */
import type { ToolType } from '../deep/decalTools';

export type { ToolType };
/** What can be picked in the toolbar. */
export type Tool = ToolType | 'eraser';

/** Brush radius on screen per tool (px at the stroke's start), measured from real strokes. */
export const BRUSH_RADIUS: Record<Tool, number> = {
  pencil: 2.5,
  marker: 14,
  crayon: 12,
  fountainPen: 3,
  watercolor: 5,
  eraser: 12,
};

/** How much bigger or smaller a brush may be made, and by how much at a time. */
const SIZES = { min: 0.4, max: 2.2, step: 1.12 };
export function resized(size: number, steps: number): number {
  const next = Math.min(SIZES.max, Math.max(SIZES.min, size * SIZES.step ** steps));
  return Math.abs(next - 1) < 0.05 ? 1 : next; // the usual size is easy to get back to
}

export const lineWidth = (tool: ToolType): number => (tool === 'marker' ? 8 : 3);
