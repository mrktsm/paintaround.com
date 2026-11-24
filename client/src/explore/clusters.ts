/** Which places get a photo circle on the map at each zoom, and which places each circle stands for. */
export interface Spot { id: string; lat: number; lng: number }
export interface Cluster<T extends Spot> { rep: T; group: T[] }

/** Photo circles closer than this on screen (px) merge into one. */
export const CLUSTER_PX = 84;

const km = (a: Spot, b: Spot) => {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** Web Mercator position on a world this many px wide. */
const worldXY = ({ lng, lat }: Spot, scale: number): [number, number] => {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return [((lng + 180) / 360) * scale, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale];
};

const distance = ([ax, ay]: [number, number], [bx, by]: [number, number], scale: number) => {
  const dx = Math.abs(ax - bx);
  return Math.hypot(Math.min(dx, scale - dx), ay - by); // across the antimeridian
};

/** A random but fixed order of the places. */
function rank(id: string, seed: number): number {
  let h = seed ^ 0x9e3779b9;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x85ebca6b) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}

/**
 * Clusters depend only on the zoom (per half step, from all places), never on what's on screen, so
 * panning doesn't regroup or move anything.
 *
 * Which places get a circle is decided level by level, from the whole world (zoom 0) inward: every
 * circle at one level is kept at all closer levels, and new ones are only added (in priority order)
 * where no circle is within CLUSTER_PX. So zooming in only splits circles and zooming out only merges
 * them; a circle never pops out and gets taken back.
 */
export class Clusters<T extends Spot> {
  /** Busier spots first (neighbours within ~40 km, bucketed so similar ones tie), then the seed's order. */
  private readonly ordered: T[];
  private readonly levels = new Map<number, T[]>();

  constructor(spots: T[], seed: number) {
    const busy = new Map(spots.map(s => [s.id, Math.floor(Math.log2(1 + spots.filter(o => km(s, o) < 40).length))]));
    this.ordered = [...spots].sort((a, b) => busy.get(b.id)! - busy.get(a.id)! || rank(a.id, seed) - rank(b.id, seed));
  }

  /** The zoom clusters are made for at this zoom. */
  static level(zoom: number): number {
    return Math.floor(zoom * 2) / 2;
  }

  at(level: number): Cluster<T>[] {
    const scale = 512 * 2 ** level;
    const out = this.reps(Math.max(0, level)).map(rep => ({ rep, at: worldXY(rep, scale), group: [] as T[] }));
    // every place joins its nearest circle (that's the cluster it opens up from)
    for (const s of this.ordered) {
      const at = worldXY(s, scale);
      let best = out[0], bestDistance = Infinity;
      for (const c of out) {
        const d = distance(c.at, at, scale);
        if (d < bestDistance) { bestDistance = d; best = c; }
      }
      best?.group.push(s);
    }
    return out.map(({ rep, group }) => ({ rep, group }));
  }

  private reps(level: number): T[] {
    const known = this.levels.get(level);
    if (known) return known;
    const scale = 512 * 2 ** level;
    const reps = level <= 0 ? [] : [...this.reps(level - 0.5)];
    const at = reps.map(r => worldXY(r, scale));
    const taken = new Set(reps.map(r => r.id));
    for (const s of this.ordered) {
      if (taken.has(s.id)) continue;
      const p = worldXY(s, scale);
      if (at.some(q => distance(p, q, scale) < CLUSTER_PX)) continue;
      reps.push(s);
      at.push(p);
    }
    this.levels.set(level, reps);
    return reps;
  }
}
