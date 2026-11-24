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

export const lineWidth = (tool: ToolType): number => (tool === 'marker' ? 8 : 3);
