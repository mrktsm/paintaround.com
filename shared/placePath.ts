/** A place's address: paintaround.com/colosseum. Used by the site and the drawing server. */

/** Pages that aren't places, and folders of files. */
const TAKEN = new Set(['explore', 'privacy', 'terms', 'view', 'api', 'ws', 'internal', 'assets', 'icons', 'textures', 'tools', 'panorama-pool', 'deep-layers']);

/** The name in the address, per place id. The first of two with the same name keeps it. */
export function placeNames(places: readonly { id: string; title: string }[]): Map<string, string> {
  const names = new Map<string, string>(), used = new Set(TAKEN);
  for (const { id, title } of places) {
    const base = (id.startsWith('ph-') ? id.slice(3) : title).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || id;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name);
    names.set(id, name);
  }
  return names;
}
