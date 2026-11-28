/** Buttons and messages over the photo. */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import mouseRightClick from '../assets/mouse-right-click.svg';
import touchAndScroll from '../assets/touch-and-scroll.svg';
import CloseIcon from '../components/CloseIcon';
import type { Panorama } from '../pool/catalog';
import { DARK_UI } from '../theme';

function HistoryButton({ label, enabled, onClick, children }: { label: string; enabled: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      disabled={!enabled}
      className="sidebar-icon-btn"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '40px',
        height: '38px',
        border: 'none',
        cursor: enabled ? 'pointer' : 'default',
        opacity: enabled ? 1 : 0.3,
        transition: 'opacity 0.2s ease',
        padding: 0,
        color: DARK_UI ? '#fff' : '#1c1c1e',
      }}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
    </button>
  );
}

/** On desktop these sit inside the top of the tool panel (see view.css). */
export function UndoRedo({ canUndo, canRedo, onUndo, onRedo }: { canUndo: boolean; canRedo: boolean; onUndo(): void; onRedo(): void }) {
  return (
    <div
      className="undo-redo"
      style={{
        position: 'absolute',
        top: 'calc(20px + env(safe-area-inset-top, 0px))',
        left: 'calc(14px + env(safe-area-inset-left, 0px))',
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        zIndex: 21,
      }}
    >
      <HistoryButton label="Undo" enabled={canUndo} onClick={onUndo}>
        <path d="M9 14 4 9l5-5" />
        <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
      </HistoryButton>
      <HistoryButton label="Redo" enabled={canRedo} onClick={onRedo}>
        <path d="m15 14 5-5-5-5" />
        <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13" />
      </HistoryButton>
    </div>
  );
}

const GLASS: CSSProperties = {
  // same frosted, slightly see-through grey + hairline + soft shadow as the left sidebar
  background: DARK_UI ? 'rgba(30, 31, 29, 0.76)' : 'rgba(226, 226, 231, 0.78)',
  backdropFilter: DARK_UI ? 'blur(30px) saturate(1.5)' : 'blur(18px) saturate(1.3)',
  WebkitBackdropFilter: DARK_UI ? 'blur(30px) saturate(1.5)' : 'blur(18px) saturate(1.3)',
  boxShadow: DARK_UI ? '0 0 0 0.5px rgba(255,255,255,0.1), 0 6px 20px rgba(0,0,0,0.25)' : '0 0 0 0.5px rgba(0,0,0,0.1), 0 6px 20px rgba(0,0,0,0.08)',
  color: DARK_UI ? '#fff' : '#1c1c1e',
};

/** Apple's share symbol: a box with an arrow out of its top. */
function ShareIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 14V3M8.5 6.5 12 3l3.5 3.5" />
      <path d="M8 10H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-2" />
    </svg>
  );
}

function CheckIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
}

/** Share what you're looking at, and leave. `onShare` says whether the link was copied. */
export function ViewActions({ canShare, onShare, onDone }: { canShare: boolean; onShare(): Promise<boolean>; onDone(): void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const onClick = () => void onShare().then(setCopied, e => console.warn('[share]', e));
  return (
    <div className="view-actions">
      <button className="view-action view-share" aria-label={copied ? 'Link copied' : 'Share'} title={copied ? 'Link copied' : 'Share'} disabled={!canShare} onClick={onClick} style={GLASS}>
        <span className="view-share__content view-share__measure" aria-hidden="true"><CheckIcon /><span>Copied</span></span>
        <span className="view-share__content">
          {copied ? <CheckIcon /> : <ShareIcon />}
          <span aria-live="polite">{copied ? 'Copied' : 'Share'}</span>
        </span>
      </button>
      <button className="view-action view-close" aria-label="Close" title="Close" onClick={onDone} style={GLASS}><CloseIcon /></button>
    </div>
  );
}

/**
 * Credit for photos that aren't CC0: the shortest complete form, like a map's © line. The name links
 * to the source page, the license name to the exact license version; that the photo was changed
 * (resized, drawn on) is stated in the hover text and screen-reader label.
 */
export function PhotoCredit({ panorama: p }: { panorama: Panorama }) {
  if (p.license === 'CC0-1.0') return null;
  return (
    <aside className="panorama-credit" aria-label={`Photo by ${p.author}, edited, ${p.license}`}>
      <a href={p.sourceUrl} target="_blank" rel="noreferrer" title="Original photo (this one is resized and drawn on)">© {p.author}</a>
      <a href={p.licenseUrl} target="_blank" rel="noreferrer" title={p.license}>{p.license.replace(/[\s-]\d[\d.]*$/, '')}</a>
    </aside>
  );
}

/** First visit: how to look around. */
export function Tutorial({ fading }: { fading: boolean }) {
  const touch = 'ontouchstart' in window, size = touch ? 166 : 200;
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        opacity: fading ? 0 : 1,
        transition: 'opacity 0.4s ease',
        pointerEvents: 'none',
      }}
    >
      <img src={touch ? touchAndScroll : mouseRightClick} alt="" width={size} height={size} style={{ filter: 'invert(1)', opacity: 0.9 }} />
      <p style={{ color: 'white', fontSize: '18px', fontWeight: 600, marginTop: '16px', textAlign: 'center', lineHeight: 1.5 }}>
        {touch ? 'Use two fingers to look around' : 'Right-click and drag to look around'}
      </p>
    </div>
  );
}

/** Shown when loading takes a moment. */
export function LoadingSpinner() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), 300);
    return () => clearTimeout(timer);
  }, []);
  return show && (
    <div className="loading-overlay" role="status" aria-label="Loading panorama">
      <div className="spinner">
        {Array.from({ length: 8 }, (_, i) => <div key={i} className="spinner-blade" style={{ '--i': i } as CSSProperties} />)}
      </div>
    </div>
  );
}
