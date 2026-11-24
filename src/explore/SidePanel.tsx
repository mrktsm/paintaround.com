import { useEffect, useRef, useState, type RefObject } from 'react';
import CloseIcon from '../components/CloseIcon';
import CityMenu from './CityMenu';
import CityPlaces from './CityPlaces';
import { ChevronDown, ExploreIcon, SearchIcon } from './icons';
import { VisitedCircle } from './placeCards';
import { CITY_OPTIONS, type Place } from './places';
import SearchField from './SearchField';
import SearchResults from './SearchResults';
import type { Search } from './useSearch';

type Section = 'search' | 'explore';
const SECTIONS = [
  { id: 'search', label: 'Search', icon: <SearchIcon size={19} weight={2.5} /> },
  { id: 'explore', label: 'Explore', icon: <ExploreIcon /> },
] as const;

interface Props {
  city: string;
  visited: Place[];
  search: Search;
  open: boolean;
  root: RefObject<HTMLDivElement | null>;
  side: RefObject<HTMLDivElement | null>;
  scroll: RefObject<HTMLDivElement | null>;
  body: RefObject<HTMLDivElement | null>;
  onCity(city: string): void;
  onOpen(place: Place): void;
  onToggle(open: boolean): void;
}

/** Desktop: a slim rail and a panel with a city's places, or search. */
export default function SidePanel({ city, visited, search, open, root, side, scroll, body, onCity, onOpen, onToggle }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [section, setSection] = useState<Section>('explore');
  const [scrolled, setScrolled] = useState(false);
  const [cityButton, setCityButton] = useState<HTMLButtonElement | null>(null);
  const [cityMenu, setCityMenu] = useState(false);
  const searching = section === 'search';

  useEffect(() => {
    if (searching && open) input.current?.focus({ preventScroll: true });
  }, [searching, open]);

  const show = (id: Section) => {
    setSection(id);
    onToggle(true);
    setCityMenu(false);
    scroll.current?.scrollTo({ top: 0 });
    setScrolled(false);
    if (id === 'search') input.current?.focus({ preventScroll: true });
  };
  const close = () => onToggle(false);

  return (
    <div className="ex-side" ref={side}>
      <nav className="ex-rail">
        {SECTIONS.map(({ id, label, icon }) => (
          <button key={id} className={`ex-tile ${open && section === id ? 'is-active' : ''}`} aria-label={label} aria-pressed={open && section === id} title={label} onClick={() => show(id)}>
            {icon}
          </button>
        ))}
        {visited.length > 0 && (
          <>
            <div className="ex-rail__div" />
            <div className="ex-rail__visited" role="list" aria-label="Places you've visited">
              {visited.map(p => <VisitedCircle key={p.id} place={p} onOpen={onOpen} />)}
            </div>
          </>
        )}
      </nav>

      <aside className={`ex-panel ${searching ? 'ex-panel--search' : ''} ${open ? '' : 'is-closed'}`}>
        {!searching && (
          <div className={`ex-panel__bar ${scrolled ? 'is-on' : ''}`} aria-hidden={!scrolled}>
            <div className="ex-panel__bar-title">Explore</div>
            <button className="ex-close" aria-label="Close panel" tabIndex={scrolled ? 0 : -1} onClick={close}><CloseIcon /></button>
          </div>
        )}
        <div ref={scroll} className="ex-panel__scroll" onScroll={e => setScrolled(e.currentTarget.scrollTop > (searching ? 0 : 40))}>
          <header className={`ex-panel__head ${scrolled ? 'is-scrolled' : ''}`}>
            {/* same 60px row as the compact scroll bar, so the title and (x) line up exactly */}
            <div className="ex-panel__titlerow">
              <h1>{searching ? 'Search' : 'Explore'}</h1>
              <button className="ex-close" aria-label="Close panel" onClick={close}><CloseIcon /></button>
            </div>
            {searching ? (
              <SearchField
                input={input}
                query={search.query}
                placeholder="Search"
                onQuery={q => { search.setQuery(q); scroll.current?.scrollTo({ top: 0 }); }}
                onKeyDown={e => {
                  if (e.key !== 'Escape') return;
                  e.preventDefault();
                  if (search.query) search.setQuery('');
                  else close();
                }}
              />
            ) : (
              <div className="ex-city">
                <button ref={setCityButton} className={`ex-city__btn ${cityMenu ? 'is-open' : ''}`} aria-haspopup="menu" aria-expanded={cityMenu} onClick={() => setCityMenu(v => !v)}>
                  {city}
                  <ChevronDown />
                </button>
                {cityMenu && cityButton && root.current && (
                  <CityMenu anchor={cityButton} container={root.current} options={CITY_OPTIONS} current={city} onPick={c => { setCityMenu(false); onCity(c); }} onClose={() => setCityMenu(false)} />
                )}
              </div>
            )}
          </header>
          <div ref={body} className="ex-panel__body">
            {searching ? <SearchResults search={search} onOpen={onOpen} /> : <CityPlaces city={city} row="ex-grid" onOpen={onOpen} />}
          </div>
        </div>
      </aside>
    </div>
  );
}
