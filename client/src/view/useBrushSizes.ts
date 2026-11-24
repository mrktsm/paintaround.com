import { useCallback, useEffect, useState } from 'react';
import { BRUSH_RADIUS, resized, type Tool } from './tools';

const KEY = 'brushSizes';
const TOOLS = Object.keys(BRUSH_RADIUS) as Tool[];

function saved(): Record<Tool, number> {
  let sizes: Partial<Record<Tool, unknown>> = {};
  try {
    sizes = (JSON.parse(localStorage.getItem(KEY) ?? '{}') as typeof sizes | null) ?? {};
  } catch {
    // unreadable: the usual sizes
  }
  return Object.fromEntries(TOOLS.map(t => [t, typeof sizes[t] === 'number' ? resized(sizes[t], 0) : 1])) as Record<Tool, number>;
}

/** Each brush's size (1 = the usual one), remembered like its colour. */
export function useBrushSizes() {
  const [sizes, setSizes] = useState(saved);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(sizes));
    } catch {
      // works without browser storage too, just not next time
    }
  }, [sizes]);
  const resize = useCallback((tool: Tool, steps: number) => setSizes(s => ({ ...s, [tool]: resized(s[tool], steps) })), []);
  return [sizes, resize] as const;
}
