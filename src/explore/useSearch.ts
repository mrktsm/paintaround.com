import { useMemo, useState } from 'react';
import { placesById, searchPlaces } from './places';

const KEY = 'streetview:recent-search-places';
const LIMIT = 6;

function readRecents(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(saved)) return [];
    const ids = saved.filter((id): id is string => typeof id === 'string');
    return placesById([...new Set(ids)]).slice(0, LIMIT).map(p => p.id);
  } catch {
    return [];
  }
}

/** What you search for, what's found, and the places you opened from search before. */
export function useSearch() {
  const [query, setQuery] = useState('');
  const [recentIds, setRecentIds] = useState(readRecents);
  const term = query.trim().toLocaleLowerCase();
  const results = useMemo(() => searchPlaces(term), [term]);

  const save = (ids: string[]) => {
    setRecentIds(ids);
    try {
      if (ids.length) localStorage.setItem(KEY, JSON.stringify(ids));
      else localStorage.removeItem(KEY);
    } catch {
      // works without browser storage too, just not next time
    }
  };
  return {
    query, setQuery, searched: term !== '', results,
    recents: useMemo(() => placesById(recentIds), [recentIds]),
    remember: (id: string) => save([id, ...recentIds.filter(r => r !== id)].slice(0, LIMIT)),
    clearRecents: () => save([]),
  };
}

export type Search = ReturnType<typeof useSearch>;
