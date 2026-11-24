import { EmptySearchGlyph } from './icons';
import { SearchResult } from './placeCards';
import type { Place } from './places';
import type { Search } from './useSearch';

/** What was found, or the places opened from search before. */
export default function SearchResults({ search: s, onOpen }: { search: Search; onOpen(place: Place): void }) {
  const places = s.searched ? s.results : s.recents;
  const open = (place: Place) => {
    s.remember(place.id);
    onOpen(place);
  };
  return (
    <>
      <span className="ex-search-status" role="status">{s.searched ? `${s.results.length} ${s.results.length === 1 ? 'place' : 'places'} found` : ''}</span>
      {places.length ? (
        <>
          {!s.searched && <div className="ex-search-recents"><h2>Recents</h2><button onClick={s.clearRecents}>Clear</button></div>}
          <ul className="ex-search-results" aria-label={s.searched ? 'Search results' : 'Recent searches'}>
            {places.map(place => <SearchResult key={place.id} place={place} onOpen={open} />)}
          </ul>
        </>
      ) : (
        <div className="ex-search-empty">
          <EmptySearchGlyph />
          <h2>{s.searched ? 'No Places Found' : 'No Recent Searches'}</h2>
          <p>{s.searched ? 'Try a different place or city.' : 'Your recent searches will appear here.'}</p>
        </div>
      )}
    </>
  );
}
