/** The places as Explore shows them: on the map, in the panel and in search. */
import { MAP_LOCATIONS, PANORAMAS, type MapLocation } from '../pool/catalog';
import type { CityOption } from './CityMenu';

export type Place = Pick<MapLocation, 'id' | 'title' | 'city' | 'area' | 'previewUrl'>;

/** Every place, also the ones whose position isn't known. */
const PLACES: Place[] = PANORAMAS.map(p => ({
  id: p.id,
  title: p.title,
  city: MAP_LOCATIONS.find(l => l.id === p.id)?.city || (p.location === 'Location not recorded' ? p.category : p.location.replace(/^Near /, '')),
  area: p.category,
  previewUrl: p.thumbnailUrl || p.previewUrl,
}));
const BY_ID = new Map(PLACES.map(p => [p.id, p]));

/** The places with these ids (unknown ones left out). */
export const placesById = (ids: string[]): Place[] => ids.flatMap(id => BY_ID.get(id) ?? []);

/** Places whose title, city or area contain every word. */
export function searchPlaces(term: string): Place[] {
  if (!term) return [];
  const words = term.split(/\s+/);
  return PLACES.filter(p => {
    const text = `${p.title} ${p.city} ${p.area}`.toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });
}

/** Cities, the ones with the most places first. */
export const CITIES = (() => {
  const counts = new Map<string, number>();
  for (const l of MAP_LOCATIONS) counts.set(l.city, (counts.get(l.city) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
})();

/** A city's places, the best first. */
export const placesIn = (city: string): MapLocation[] => MAP_LOCATIONS.filter(l => l.city === city).sort((a, b) => a.tier - b.tier);

/** The middle of these places. */
export function middleOf(places: MapLocation[]): [number, number] | null {
  if (!places.length) return null;
  return [places.reduce((sum, l) => sum + l.lng, 0) / places.length, places.reduce((sum, l) => sum + l.lat, 0) / places.length];
}

/** One of the best places of a few other cities. */
export function aroundTheWorld(city: string): MapLocation[] {
  const picks: MapLocation[] = [];
  for (const l of MAP_LOCATIONS) {
    if (picks.length >= 4) break;
    if (l.tier === 1 && l.city !== city && !picks.some(p => p.city === l.city)) picks.push(l);
  }
  return picks;
}

/** Continent from coordinates (city names don't always include a country). */
function continentOf(lat: number, lng: number): string {
  if (lng < -30) return lat > 12 ? 'North America' : 'South America';
  if (lat > 35 && lng < 45) return 'Europe';
  if (lng < 55 && lat <= 37) return 'Africa';
  if (lat < -10 && lng > 110) return 'Oceania';
  return 'Asia';
}
/** City picker options: name + country line, grouped by continent (bigger continents first). */
export const CITY_OPTIONS: CityOption[] = (() => {
  const opts = CITIES.map(city => {
    const first = MAP_LOCATIONS.find(l => l.city === city)!;
    const [name, ...rest] = city.split(',');
    return { city, name: name.trim(), sub: rest.join(',').trim(), continent: continentOf(first.lat, first.lng) };
  });
  const size = new Map<string, number>();
  for (const o of opts) size.set(o.continent, (size.get(o.continent) ?? 0) + 1);
  return opts.sort((a, b) => (size.get(b.continent)! - size.get(a.continent)!) || a.continent.localeCompare(b.continent) || a.name.localeCompare(b.name));
})();
