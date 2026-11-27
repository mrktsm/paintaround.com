import { useEffect, useState } from 'react';
import type { ToolType } from './tools';

/** Each tool starts with one of these bright, saturated colours, at random, until you pick one for it. */
const COLORS = [
  '#FF2D95', // hot pink
  '#39FF14', // neon green
  '#FF1F1F', // red
  '#00E5FF', // cyan
  '#FFE600', // yellow
  '#FF6A00', // orange
  '#B026FF', // violet
  '#1F7BFF', // electric blue
];
const TOOLS: ToolType[] = ['pencil', 'marker', 'crayon', 'fountainPen', 'watercolor'];
const isHexColor = (c: string | null): c is string => !!c && /^#[0-9a-fA-F]{6}$/.test(c);

/** The colour each tool had last time; the others get different ones. */
function savedColors(): Record<ToolType, string> {
  const colors = {} as Record<ToolType, string>;
  for (const tool of TOOLS) {
    const saved = localStorage.getItem(`${tool}Color`);
    const free = COLORS.filter(c => !Object.values(colors).includes(c));
    colors[tool] = isHexColor(saved) ? saved : free[Math.floor(Math.random() * free.length)];
  }
  return colors;
}

export function useToolColors() {
  const [colors, setColors] = useState(savedColors);
  useEffect(() => { for (const tool of TOOLS) localStorage.setItem(`${tool}Color`, colors[tool]); }, [colors]);
  const setColor = (tool: ToolType, color: string) => setColors(c => ({ ...c, [tool]: color }));
  return [colors, setColor] as const;
}
