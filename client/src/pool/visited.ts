import { PANORAMA_BY_ID } from './catalog';

/** Places this browser has opened, most recent first (local only — no account needed). */
const KEY = 'streetview:visited-places';
export const VISITED_LIMIT = 8;

export function readVisited(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(saved)
      ? [...new Set(saved.filter((id): id is string => typeof id === 'string' && PANORAMA_BY_ID.has(id)))].slice(0, VISITED_LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function recordVisit(id: string): void {
  if (!PANORAMA_BY_ID.has(id)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify([id, ...readVisited().filter(v => v !== id)].slice(0, VISITED_LIMIT)));
  } catch {
    // storage unavailable: nothing to remember
  }
}
