/**
 * Previews that show a place's drawings. The live-drawing server re-renders a place's card and
 * loading images when its drawings change (server/previews.ts); this keeps the list of which
 * places have one (and its version) and hands out their URLs. Places without drawings keep
 * their original preview images.
 */
const versions = new Map<string, number>();
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let lastFetch = 0;

/** Ask the server which places have drawn previews (throttled; call freely). */
export function refreshDrawnPreviews(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force && Date.now() - lastFetch < 5000) return Promise.resolve();
  lastFetch = Date.now();
  inflight = fetch('/api/previews', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : {}))
    .then((m: Record<string, number>) => {
      let changed = versions.size !== Object.keys(m).length;
      for (const [id, v] of Object.entries(m)) if (versions.get(id) !== v) changed = true;
      if (!changed) return;
      versions.clear();
      for (const [id, v] of Object.entries(m)) if (typeof v === 'number') versions.set(id, v);
      for (const l of listeners) l();
    })
    .catch(() => {}) // previews with drawings are a bonus: originals keep working
    .finally(() => { inflight = null; });
  return inflight;
}

export function onDrawnPreviewsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** URL of a place's card / loading image with its drawings, or null if it has none. */
export function drawnPreviewUrl(id: string, kind: 'card' | 'loading'): string | null {
  const v = versions.get(id);
  return v ? `/api/previews/${encodeURIComponent(id)}/${kind}?v=${v}` : null;
}

/** A counter that changes whenever drawn previews change (for re-rendering React lists). */
let revision = 0;
onDrawnPreviewsChange(() => { revision++; });
export const drawnPreviewsRevision = () => revision;
