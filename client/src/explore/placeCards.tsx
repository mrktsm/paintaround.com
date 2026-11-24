/** The ways a place is shown in the panel: a card, a circle, a search result. */
import { useState } from 'react';
import { panoramaThumbnail } from '../pool/catalog';
import { cancelPanoramaPrefetch, prefetchPanorama, queuePanoramaPrefetch } from '../pool/panoramaImages';
import { fadeInWhenLoaded } from './fadeInWhenLoaded';
import { SearchIcon } from './icons';
import type { Place } from './places';

/** Its photo starts loading when you point at it. */
const prefetch = (id: string) => ({
  onPointerEnter: () => queuePanoramaPrefetch(id),
  onPointerLeave: () => cancelPanoramaPrefetch(id),
  onFocus: () => prefetchPanorama(id),
  onPointerDown: () => prefetchPanorama(id),
});

interface Props { place: Place; onOpen(place: Place): void }

export function Card({ place, overline, size, onOpen }: Props & { overline: string; size: 'hero' | 'tile' }) {
  const src = panoramaThumbnail(place.id);
  return (
    <button className={`ex-card ex-card--${size}`} onClick={() => onOpen(place)} {...prefetch(place.id)}>
      {src ? <img key={src} src={src} alt="" loading="lazy" ref={fadeInWhenLoaded} /> : <div className="ex-card__ph" />}
      <div className="ex-card__shade" />
      <div className="ex-card__text">
        <div className="ex-card__overline">{overline}</div>
        <div className="ex-card__title">{place.title}</div>
      </div>
    </button>
  );
}

export function SearchResult({ place, onOpen }: Props) {
  const [failed, setFailed] = useState(false);
  return (
    <li>
      <button className="ex-search-result" onClick={() => onOpen(place)} {...prefetch(place.id)}>
        <span className="ex-search-result__preview">
          {failed || !place.previewUrl ? <SearchIcon /> : <img className="ex-fade-img" ref={fadeInWhenLoaded} src={panoramaThumbnail(place.id) ?? place.previewUrl} alt="" loading="lazy" onError={() => setFailed(true)} />}
        </span>
        <span className="ex-search-result__copy">
          <span className="ex-search-result__name">{place.title}</span>
          <span className="ex-search-result__place">{place.city}</span>
        </span>
      </button>
    </li>
  );
}

/** Places you've visited: circles in the desktop rail. */
export function VisitedCircle({ place, onOpen }: Props) {
  const [failed, setFailed] = useState(false);
  return (
    <button role="listitem" className="ex-visited" aria-label={`${place.title}, ${place.city}`} title={place.title} onClick={() => onOpen(place)} {...prefetch(place.id)}>
      {failed || !place.previewUrl
        ? <span className="ex-visited__fallback">{place.title.slice(0, 1)}</span>
        : <img className="ex-fade-img" ref={fadeInWhenLoaded} src={panoramaThumbnail(place.id) ?? place.previewUrl} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} />}
    </button>
  );
}

/** And circles with names in the phone sheet. */
export function VisitedTile({ place, onOpen }: Props) {
  return (
    <button className="ex-recent" onClick={() => onOpen(place)} onPointerDown={() => prefetchPanorama(place.id)}>
      <span className="ex-recent__photo">{place.previewUrl && <img className="ex-fade-img" ref={fadeInWhenLoaded} src={panoramaThumbnail(place.id) ?? place.previewUrl} alt="" loading="lazy" draggable={false} />}</span>
      <span className="ex-recent__name">{place.title}</span>
    </button>
  );
}
