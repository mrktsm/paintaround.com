/**
 * Previews that show a place's drawings. The live-drawing server re-renders a place's card and
 * loading images when its drawings change (server/previews.ts); this keeps the list of which
 * places have one (and its version) and hands out their URLs. Places without drawings keep
 * their original preview images.
 */
const versions = new Map<string, number>();
/**
 * Previews of your own drawings, made in this browser when you left the place (localPreview.ts).
 * Shown for a while even if the server has a newer one: its version may still lack your strokes
 * (they are checked and rendered after you stop). After that, the newest wins.
 */
const local = new Map<string, { card: string; loading: string; at: number }>();
const LOCAL_FIRST_MS = 90_000;
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

export function setLocalPreview(id: string, card: Blob, loading: Blob): void {
  const old = local.get(id);
  local.set(id, { card: URL.createObjectURL(card), loading: URL.createObjectURL(loading), at: Date.now() });
  for (const l of listeners) l();
  // pages still showing the old one get a moment to switch
  if (old) setTimeout(() => { URL.revokeObjectURL(old.card); URL.revokeObjectURL(old.loading); }, 10_000);
  // then the server's may take over: check again, and let pages re-read
  setTimeout(() => { void refreshDrawnPreviews(true).then(() => { for (const l of listeners) l(); }); }, LOCAL_FIRST_MS + 500);
}

/** URL of a place's card / loading image with its drawings, or null if it has none. */
export function drawnPreviewUrl(id: string, kind: 'card' | 'loading'): string | null {
  const v = versions.get(id);
  const own = local.get(id);
  if (own && (!v || v < own.at || Date.now() - own.at < LOCAL_FIRST_MS)) return own[kind];
  return v ? `/api/previews/${encodeURIComponent(id)}/${kind}?v=${v}` : null;
}

/** A counter that changes whenever drawn previews change (for re-rendering React lists). */
let revision = 0;
onDrawnPreviewsChange(() => { revision++; });
export const drawnPreviewsRevision = () => revision;
