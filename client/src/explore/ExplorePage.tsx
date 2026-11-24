import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { MAP_LOCATIONS, panoramaViewUrl } from '../pool/catalog';
import { onDrawnPreviewsChange, refreshDrawnPreviews } from '../pool/drawnPreviews';
import { prefetchPanorama } from '../pool/panoramaImages';
import { readVisited } from '../pool/visited';
import { DARK_UI } from '../theme';
import MapControls from './MapControls';
import { IS_SATELLITE } from './mapStyles';
import type { Detent } from './MobileSheet';
import PhonePanel from './PhonePanel';
import { refreshPinPhotos } from './PhotoPins';
import { CITIES, placesById, placesIn } from './places';
import SidePanel from './SidePanel';
import { useExploreMap } from './useExploreMap';
import { useIsPhone } from './useIsPhone';
import { useSearch } from './useSearch';
import './explore.css';

function firstCity(): string {
  const id = new URLSearchParams(location.search).get('imageId');
  return MAP_LOCATIONS.find(l => l.id === id)?.city || CITIES.find(c => c.startsWith('Rome')) || CITIES[0];
}

/** Places with drawings show them in their photos: ask which ones now, then every 30 s. */
function useDrawnPreviews(): void {
  const [, setRevision] = useState(0);
  useEffect(() => {
    const off = onDrawnPreviewsChange(() => {
      setRevision(r => r + 1);
      refreshPinPhotos();
    });
    void refreshDrawnPreviews(true);
    const timer = setInterval(() => { if (!document.hidden) void refreshDrawnPreviews(); }, 30_000);
    return () => { off(); clearInterval(timer); };
  }, []);
}

/** The home page: a full-screen map with every place on it, and a panel to browse and search them. */
export default function ExplorePage() {
  const navigate = useNavigate();
  const phone = useIsPhone();
  const root = useRef<HTMLDivElement>(null);
  const mapEl = useRef<HTMLDivElement>(null);
  const side = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const panelBody = useRef<HTMLDivElement>(null);
  const [city, setCity] = useState(firstCity);
  const [panelOpen, setPanelOpen] = useState(true);
  const [detent, setDetent] = useState<Detent>('half');
  const [sheetHeight, setSheetHeight] = useState(0);
  const sheet = useRef(0); // known before the map is made
  const onVisibleHeight = useCallback((px: number) => { sheet.current = px; setSheetHeight(px); }, []);
  const [visited] = useState(() => placesById(readVisited()));
  const search = useSearch();
  useDrawnPreviews();

  const open = useCallback(({ id }: { id: string }) => {
    prefetchPanorama(id);
    navigate(panoramaViewUrl(id));
  }, [navigate]);

  // the panel's list fades out and the new one in right away; photos fill in as they load
  const swap = useRef<ReturnType<typeof setTimeout>>(undefined);
  const followCity = (next: string): boolean => {
    if ((scroll.current?.scrollTop ?? 0) > 40) return false; // reading further down: not under you
    const body = panelBody.current;
    if (!body || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setCity(next);
      return true;
    }
    body.classList.add('is-swapping');
    clearTimeout(swap.current);
    swap.current = setTimeout(() => {
      setCity(next);
      requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove('is-swapping')));
    }, 160);
    return true;
  };
  const pickCity = (next: string) => {
    clearTimeout(swap.current);
    panelBody.current?.classList.remove('is-swapping');
    setCity(next);
  };

  const { map, bearing } = useExploreMap(mapEl, {
    city,
    onOpen: open,
    onCity: followCity,
    offset: () => phone
      ? [0, -Math.min(sheet.current, window.innerHeight * 0.6) / 2]
      : [(side.current?.getBoundingClientRect().right ?? 0) / 2, 0],
  });

  // the first place you'd open loads ahead of time
  const heroId = placesIn(city)[0]?.id;
  useEffect(() => {
    if (!heroId || !panelOpen) return;
    const timer = setTimeout(() => prefetchPanorama(heroId), 600);
    return () => clearTimeout(timer);
  }, [heroId, panelOpen]);

  const shared = { city, visited, search, scroll, onCity: pickCity, onOpen: open };
  return (
    <div
      ref={root}
      className={`ex ${IS_SATELLITE ? 'ex--satellite' : ''} ${DARK_UI ? 'ex--dark' : ''} ${panelOpen ? '' : 'is-panel-closed'} ${phone ? `ex--phone ex--sheet-${detent}` : ''}`}
      style={phone ? { '--sheet-h': `${sheetHeight}px` } as CSSProperties : undefined}
    >
      {phone
        ? <PhonePanel {...shared} detent={detent} onDetent={setDetent} onVisibleHeight={onVisibleHeight} />
        : <SidePanel {...shared} open={panelOpen} root={root} side={side} body={panelBody} onToggle={setPanelOpen} />}
      <main className="ex-map">
        <div ref={mapEl} className="ex-map__canvas" />
        <MapControls map={map} bearing={bearing} />
      </main>
    </div>
  );
}
