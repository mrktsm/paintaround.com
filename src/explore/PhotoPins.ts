import maplibregl from 'maplibre-gl';
import { MAP_LOCATIONS, panoramaThumbnail, type MapLocation } from '../pool/catalog';
import { cancelPanoramaPrefetch, prefetchPanorama, queuePanoramaPrefetch } from '../pool/panoramaImages';
import { Clusters, CLUSTER_PX, type Cluster } from './clusters';
import { fadeInWhenLoaded } from './fadeInWhenLoaded';

/** Matches the .ex-pin appear/disappear transition in explore.css. */
const FADE_MS = 280;

/** Which place represents a cluster changes between visits (discovery) but stays put while panning and zooming. */
const clusters = new Clusters(MAP_LOCATIONS, Math.floor(Math.random() * 2 ** 31));

/** Photo marker with a map-style place label below its white-ringed thumbnail. */
function makePin(place: MapLocation, onOpen: (place: MapLocation) => void): HTMLElement {
  const el = document.createElement('button');
  el.className = 'ex-pin';
  el.setAttribute('aria-label', `Draw at ${place.title}`);
  el.innerHTML = `<span class="ex-pin__photo"><img alt="" /></span><span class="ex-pin__label"></span>`;
  el.querySelector('.ex-pin__label')!.textContent = place.title;
  const img = el.querySelector('img') as HTMLImageElement;
  img.src = panoramaThumbnail(place.id) ?? place.previewUrl;
  el.dataset.place = place.id;
  fadeInWhenLoaded(img);
  el.addEventListener('pointerenter', () => queuePanoramaPrefetch(place.id));
  el.addEventListener('pointerleave', () => cancelPanoramaPrefetch(place.id));
  el.addEventListener('focus', () => prefetchPanorama(place.id));
  el.addEventListener('pointerdown', () => prefetchPanorama(place.id));
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    prefetchPanorama(place.id);
    onOpen(place);
  });
  return el;
}

/** Places with new drawings show them in their circles too. */
export function refreshPinPhotos(): void {
  document.querySelectorAll<HTMLElement>('.ex-pin[data-place]').forEach(pin => {
    const img = pin.querySelector('img');
    const src = panoramaThumbnail(pin.dataset.place!);
    if (!img || !src || img.src.endsWith(src)) return;
    // keep the old photo until the new one has loaded, then switch (no flash)
    const next = new Image();
    next.onload = () => { img.src = src; };
    next.src = src;
  });
}

interface Pin {
  marker: maplibregl.Marker;
  el: HTMLElement;
  /** Set while it fades out. */
  leaving?: ReturnType<typeof setTimeout>;
}

/**
 * One photo circle over each area, so there's always something to tap; zooming in splits them. A
 * circle shows one real place's photo, so tapping it opens that place (even in a cluster).
 */
export class PhotoPins {
  private readonly pins = new Map<string, Pin>();
  private level = NaN;
  private shown: Cluster<MapLocation>[] = [];
  /** place id -> the circle it belongs to, now and before the last regroup */
  private owner = new Map<string, string>();
  private prevOwner = new Map<string, string>();
  private frame = 0;
  private readonly map: maplibregl.Map;
  private readonly onOpen: (place: MapLocation) => void;

  constructor(map: maplibregl.Map, onOpen: (place: MapLocation) => void) {
    this.map = map;
    this.onOpen = onOpen;
    map.on('style.load', () => this.update());
    const soon = () => {
      this.frame ||= requestAnimationFrame(() => { this.frame = 0; this.update(); });
    };
    map.on('move', soon);
    map.on('idle', soon);
  }

  private regroup(): void {
    const level = Clusters.level(this.map.getZoom());
    if (level === this.level) return;
    this.level = level;
    this.shown = clusters.at(level);
    this.prevOwner = this.owner;
    this.owner = new Map(this.shown.flatMap(c => c.group.map(g => [g.id, c.rep.id] as [string, string])));
  }

  private update(): void {
    this.regroup();
    const m = this.map;
    const { clientWidth: W, clientHeight: H } = m.getContainer();
    const refLng = m.getCenter().lng;
    const keep = new Set<string>();
    for (const { rep } of this.shown) {
      const lng = rep.lng + 360 * Math.round((refLng - rep.lng) / 360); // the copy of the world being viewed
      const p = m.project([lng, rep.lat]);
      if (p.x < -CLUSTER_PX || p.y < -CLUSTER_PX || p.x > W + CLUSTER_PX || p.y > H + CLUSTER_PX) continue;
      keep.add(rep.id);
      const pin = this.pins.get(rep.id);
      if (!pin) this.add(rep, lng, p);
      else this.keep(pin, lng, rep.lat);
    }
    for (const [id, pin] of this.pins) if (!keep.has(id) && pin.leaving === undefined) this.remove(id, pin);
  }

  private add(place: MapLocation, lng: number, at: { x: number; y: number }): void {
    const el = makePin(place, this.onOpen);
    // split: a new circle slides out of the one it was part of (like Leaflet.markercluster, MapKit)
    // instead of popping up in place
    const parent = this.pins.get(this.prevOwner.get(place.id) ?? '');
    if (parent && parent.leaving === undefined) this.slide(el, at, parent);
    const pin: Pin = { el, marker: new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, -31] }).setLngLat([lng, place.lat]).addTo(this.map) };
    this.pins.set(place.id, pin);
    requestAnimationFrame(() => requestAnimationFrame(() => { if (pin.leaving === undefined) el.classList.add('is-shown'); }));
  }

  private keep(pin: Pin, lng: number, lat: number): void {
    if (pin.leaving !== undefined) {
      clearTimeout(pin.leaving);
      pin.leaving = undefined;
      pin.el.classList.add('is-shown');
      this.setTappable(pin.el, true);
    }
    // only when it changes: setLngLat re-lays the marker, and this runs on every frame of a pan
    if (pin.marker.getLngLat().lng !== lng) pin.marker.setLngLat([lng, lat]);
    if (pin.el.classList.contains('is-shown')) this.slide(pin.el);
  }

  private remove(id: string, pin: Pin): void {
    // merge: slide into the circle it joined while fading (off-screen ones just fade)
    const into = this.pins.get(this.owner.get(id) ?? '');
    if (into && into !== pin) this.slide(pin.el, this.map.project(pin.marker.getLngLat()), into);
    else this.slide(pin.el);
    pin.el.classList.remove('is-shown');
    this.setTappable(pin.el, false);
    pin.leaving = setTimeout(() => { pin.marker.remove(); this.pins.delete(id); }, FADE_MS);
  }

  /** Where a circle comes from or goes to: another one, or nowhere else. */
  private slide(el: HTMLElement, at?: { x: number; y: number }, other?: Pin): void {
    if (!at || !other) {
      el.style.removeProperty('--fx');
      el.style.removeProperty('--fy');
      return;
    }
    const to = this.map.project(other.marker.getLngLat());
    el.style.setProperty('--fx', `${(to.x - at.x).toFixed(1)}px`);
    el.style.setProperty('--fy', `${(to.y - at.y).toFixed(1)}px`);
  }

  private setTappable(el: HTMLElement, yes: boolean): void {
    for (const part of [el, ...el.querySelectorAll<HTMLElement>('.ex-pin__photo, .ex-pin__label')]) part.style.pointerEvents = yes ? '' : 'none';
  }
}
