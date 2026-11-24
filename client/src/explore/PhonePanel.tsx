import { useRef, useState, type RefObject } from 'react';
import CityPlaces from './CityPlaces';
import { ChevronRight } from './icons';
import MobileSheet, { CitiesModal, type Detent } from './MobileSheet';
import { VisitedTile } from './placeCards';
import { CITIES, type Place } from './places';
import SearchField from './SearchField';
import SearchResults from './SearchResults';
import type { Search } from './useSearch';

const SORTED_CITIES = [...CITIES].sort((a, b) => a.localeCompare(b));

interface Props {
  city: string;
  visited: Place[];
  search: Search;
  detent: Detent;
  scroll: RefObject<HTMLDivElement | null>;
  onCity(city: string): void;
  onOpen(place: Place): void;
  onDetent(detent: Detent): void;
  onVisibleHeight(px: number): void;
}

/** Phones: one bottom sheet with search, the places you visited, and a city's places. */
export default function PhonePanel({ city, visited, search, detent, scroll, onCity, onOpen, onDetent, onVisibleHeight }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const tap = useRef<{ x: number; y: number; t: number } | null>(null);
  const [searching, setSearching] = useState(false);
  const [choosingCity, setChoosingCity] = useState(false);

  const setDetent = (d: Detent) => {
    onDetent(d);
    if (d === 'full') return;
    input.current?.blur();
    if (!search.query) setSearching(false);
  };
  const openSearch = () => {
    setSearching(true);
    onDetent('full');
  };
  const closeSearch = () => {
    search.setQuery('');
    setSearching(false);
    input.current?.blur();
    onDetent('half');
  };
  // The browser scrolls the page to keep a focused field above the keyboard, measured while the
  // sheet is still half open; the sheet then rises and that scroll pushed the field off screen. So:
  // take over the tap, open the sheet fully and focus without scrolling (still inside the tap, so the
  // keyboard opens), then undo any leftover page shift once the keyboard is up.
  // Only a tap (the finger lifts without moving) opens search: a drag that starts on the field is
  // moving the sheet (e.g. swiping it down to hide it) and must not focus it.
  const takeOverTap = {
    onPointerDown: (e: React.PointerEvent) => {
      if (detent === 'full' || document.activeElement === input.current) return;
      e.preventDefault(); // no native focus yet
      tap.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    },
    onPointerUp: (e: React.PointerEvent) => {
      const t = tap.current;
      tap.current = null;
      if (!t || Math.hypot(e.clientX - t.x, e.clientY - t.y) > 8 || performance.now() - t.t > 600) return;
      openSearch();
      input.current?.focus({ preventScroll: true });
    },
    onPointerCancel: () => { tap.current = null; },
    onFocus: () => {
      openSearch();
      const unshift = () => { if (window.scrollY || document.documentElement.scrollTop) window.scrollTo(0, 0); };
      unshift();
      window.visualViewport?.addEventListener('resize', unshift, { once: true });
      setTimeout(unshift, 350);
      setTimeout(unshift, 700);
    },
  };

  return (
    <>
      <MobileSheet
        detent={detent}
        onDetent={setDetent}
        onVisibleHeight={onVisibleHeight}
        scrollRef={scroll}
        header={
          <div className="ex-sheet__searchrow">
            <SearchField
              input={input}
              query={search.query}
              placeholder="Search places"
              onQuery={q => { search.setQuery(q); scroll.current?.scrollTo({ top: 0 }); }}
              onSubmitted={() => input.current?.blur()}
              {...takeOverTap}
            />
            {searching && <button className="ex-sheet__cancel" onClick={closeSearch}>Cancel</button>}
          </div>
        }
      >
        <div className="ex-sheet__body">
          {searching ? <SearchResults search={search} onOpen={onOpen} /> : (
            <>
              {visited.length > 0 && (
                <>
                  <h2 className="ex-sec ex-sec--first">Recents</h2>
                  <div className="ex-row ex-row--recents">{visited.map(p => <VisitedTile key={p.id} place={p} onOpen={onOpen} />)}</div>
                </>
              )}
              <div className={`ex-sheet__titlerow ${visited.length ? '' : 'ex-sheet__titlerow--first'}`}>
                <div>
                  <h2>Explore</h2>
                  <button className="ex-city__btn" onClick={() => setChoosingCity(true)}>{city}<ChevronRight /></button>
                </div>
              </div>
              <CityPlaces city={city} row="ex-row" onOpen={onOpen} />
            </>
          )}
        </div>
      </MobileSheet>
      <CitiesModal open={choosingCity} onClose={() => setChoosingCity(false)}>
        <ul className="ex-options">
          {SORTED_CITIES.map(c => (
            <li key={c}>
              <button className={`ex-option ${c === city ? 'is-current' : ''}`} onClick={() => { setChoosingCity(false); onCity(c); onDetent('half'); }}>
                {c}
                {c === city && <svg className="ex-option__check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}
              </button>
            </li>
          ))}
        </ul>
      </CitiesModal>
    </>
  );
}
