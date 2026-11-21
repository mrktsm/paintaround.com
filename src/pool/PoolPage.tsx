import { lazy, Suspense, useLayoutEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import poolData from '../data/panorama-pool.json';
import './pool.css';
import { panoramaViewUrl } from './catalog';

const PanoramaPreview = lazy(() => import('./PanoramaPreview'));
type PoolItem = {
  id: string; title: string; location: string; appeal: string; category?: string; country?: string | null;
  author: string; provider: string; license: string; licenseUrl: string; sourceUrl: string;
  downloadUrl: string; imageUrl: string; previewUrl: string; thumbnailUrl?: string;
  originalWidth: number; originalHeight: number; width: number; height: number;
};
const pool: { version: number; items: PoolItem[] } = poolData;
const kinds = [...new Set(pool.items.map(item => item.category).filter((value): value is string => !!value))].sort();
const PAGE_SIZE = 36;
type Review = 'keep' | 'skip';
const REVIEW_KEY = 'iwh-panorama-pool-review-v1';

export default function PoolPage() {
  const [params, setParams] = useSearchParams();
  const pageRef = useRef<HTMLElement>(null);
  const selected = pool.items.find(item => item.id === params.get('id'));
  useLayoutEffect(() => { pageRef.current?.scrollTo({ top: 0 }); }, [selected?.id]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [kind, setKind] = useState('all');
  const [shown, setShown] = useState(PAGE_SIZE);
  const [reviews, setReviews] = useState<Record<string, Review>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(REVIEW_KEY) || '{}');
      return Object.fromEntries(pool.items.flatMap(item => ['keep', 'skip'].includes(saved?.[item.id]) ? [[item.id, saved[item.id]]] : []));
    } catch { return {}; }
  });
  const [storageNotice, setStorageNotice] = useState('');
  const kept = pool.items.filter(item => reviews[item.id] === 'keep');
  const visible = pool.items.filter(item => {
    const matches = `${item.title} ${item.location} ${item.appeal} ${item.category || ''} ${item.country || ''}`.toLowerCase().includes(query.toLowerCase());
    return matches && (kind === 'all' || item.category === kind) && (filter === 'all' || (filter === 'cc0' && item.license === 'CC0-1.0') || (filter === 'commons' && item.provider === 'Wikimedia Commons') || (filter === 'kept' && reviews[item.id] === 'keep'));
  });
  const review = (id: string, value: Review) => {
    const next = { ...reviews };
    if (next[id] === value) delete next[id]; else next[id] = value;
    setReviews(next);
    try { localStorage.setItem(REVIEW_KEY, JSON.stringify(next)); }
    catch { setStorageNotice('Selections last for this visit only. Export your pool to save them.'); }
  };
  const exportPool = () => {
    const data = { version: pool.version, exportedAt: new Date().toISOString(), items: (filter === 'kept' ? kept : pool.items).map(item => ({ ...item, selection: reviews[item.id] || 'unreviewed' })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'panorama-pool.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <main ref={pageRef} className="pool-page">
    <header className="pool-nav"><Link to="/">← I Was Here</Link><span>THE PANORAMA POOL</span><button onClick={exportPool}>Export {filter === 'kept' ? 'shortlist' : 'pool'} ↗</button></header>
    {selected ? <section className="pool-detail">
      <button className="pool-back" onClick={() => setParams({})}>← All {pool.items.length} places</button>
      <div className="pool-detail-heading"><div><p className="pool-eyebrow">{selected.location}</p><h1>{selected.title}</h1></div><span className="pool-badge">{selected.license}</span></div>
      <Suspense fallback={<div className="pool-panorama-wrap pool-loading">Loading 360° viewer…</div>}>
        <PanoramaPreview key={selected.id} url={selected.imageUrl} title={selected.title} />
      </Suspense>
      <div className="pool-detail-bottom">
        <div><p>{selected.appeal}</p><p className="pool-credit">Photo: {selected.author} / <a href={selected.sourceUrl} target="_blank" rel="noreferrer">{selected.provider}</a> · <a href={selected.licenseUrl} target="_blank" rel="noreferrer">{selected.license}</a></p><p className="pool-small">{selected.originalWidth.toLocaleString()} × {selected.originalHeight.toLocaleString()} original · {selected.width} × {selected.height} preview. Resized and JPEG compressed.</p></div>
        <div className="pool-actions"><Link className="pool-draw-link" to={panoramaViewUrl(selected.id)}>Draw here ↗</Link><button aria-pressed={reviews[selected.id] === 'keep'} onClick={() => review(selected.id, 'keep')}>♡ {reviews[selected.id] === 'keep' ? 'Kept' : 'Keep'}</button><button aria-pressed={reviews[selected.id] === 'skip'} onClick={() => review(selected.id, 'skip')}>{reviews[selected.id] === 'skip' ? 'Skipped' : 'Skip'}</button><a href={selected.imageUrl} download>Download 4K ↓</a><a href={selected.downloadUrl} target="_blank" rel="noreferrer">Original ↗</a></div>
      </div>
    </section> : <>
      <section className="pool-intro"><p className="pool-eyebrow">A NEW COLLECTION / FREE TO REMIX</p><h1>Somewhere worth<br />leaving a mark.</h1><p>Landmarks, city squares and unexpected corners.<br />Look around, find the good ones, build the pool.</p><div className="pool-count">{pool.items.length} sampled places <span>·</span> {kept.length} on your shortlist</div></section>
      <div className="pool-filters"><div role="group" aria-label="Filter panoramas">{[['all', 'All places'], ['cc0', 'CC0'], ['commons', 'Commons'], ['kept', 'Your shortlist']].map(([id, label]) => <button key={id} aria-pressed={filter === id} onClick={() => { setFilter(id); setShown(PAGE_SIZE); }}>{label}</button>)}</div><div className="pool-search"><select aria-label="Scene type" value={kind} onChange={event => { setKind(event.target.value); setShown(PAGE_SIZE); }}><option value="all">All scene types</option>{kinds.map(value => <option key={value} value={value}>{value}</option>)}</select><input type="search" aria-label="Search places" placeholder="Find a place…" value={query} onChange={event => { setQuery(event.target.value); setShown(PAGE_SIZE); }} /></div></div>
      <p className="pool-results" role="status">Showing {Math.min(shown, visible.length)} of {visible.length} places</p>
      <section className="pool-grid" aria-label="Sampled panoramas">
        {visible.slice(0, shown).map(item => <article key={item.id} className={`pool-card ${reviews[item.id] === 'skip' ? 'pool-skipped' : ''}`}>
          <button className="pool-card-image" onClick={() => setParams({ id: item.id })} aria-label={`Explore ${item.title} in 360 degrees`}><img src={item.thumbnailUrl || item.previewUrl} alt={`${item.title}`} loading="lazy" width={800} height={600} /><span className="pool-360">360° ↗</span></button>
          <div className="pool-card-heading"><button className="pool-title" onClick={() => setParams({ id: item.id })}>{item.title}</button><button className="pool-keep" aria-label={`${reviews[item.id] === 'keep' ? 'Remove' : 'Keep'} ${item.title}`} aria-pressed={reviews[item.id] === 'keep'} onClick={() => review(item.id, 'keep')}>{reviews[item.id] === 'keep' ? '♥' : '♡'}</button></div>
          <p className="pool-location">{item.location}</p><p className="pool-appeal">{item.appeal}</p>
          {item.category && <span className="pool-scene-tag">{item.category}</span>}
          <p className="pool-small">Photo: {item.author}<br /><a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.provider}</a> · <a href={item.licenseUrl} target="_blank" rel="noreferrer">{item.license}</a> · {(item.originalWidth / 1000).toFixed(1)}K</p>
          <Link className="pool-card-draw" to={panoramaViewUrl(item.id)}>Draw here ↗</Link>
        </article>)}
      </section>
      {shown < visible.length && <div className="pool-more"><button onClick={() => setShown(count => count + PAGE_SIZE)}>Show {Math.min(PAGE_SIZE, visible.length - shown)} more places ↓</button></div>}
      {!visible.length && <p className="pool-empty">{filter === 'kept' ? 'Keep a few places to start your shortlist.' : 'No places match your search.'}</p>}
      <footer className="pool-footer">A first sample, ready for review. Full-sphere images with downloadable originals and recorded licenses. Shortlist selections are saved in this browser.</footer>
    </>}
    {storageNotice && <p role="status">{storageNotice}</p>}
  </main>;
}
