import CloseIcon from '../components/CloseIcon';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Apple Maps-style bottom sheet for phones: three resting positions (collapsed / half / full),
 * dragged by its header anywhere, and by its content unless the content is scrolled. A flick
 * carries the sheet towards where its velocity would take it (projected, like UIKit), then it
 * snaps to the nearest position.
 *
 * The content only scrolls when the sheet is full; at the other positions a drag on the content
 * moves the sheet. When full and scrolled to the top, pulling down drags the sheet down again.
 */
export type Detent = 'collapsed' | 'half' | 'full';

const COLLAPSED = 96; // grabber + search field
/** map left visible above a full sheet: never under the status bar / Dynamic Island */
const fullGap = (safeTop: number) => Math.max(52, safeTop + 10);
const PROJECT_MS = 220; // how far a flick "throws" the sheet (velocity * this)

function detentHeights(vh: number, safeTop: number, safeBottom: number) {
  return {
    collapsed: COLLAPSED + safeBottom,
    half: Math.round(vh * 0.46),
    full: vh - fullGap(safeTop),
  };
}

/** Height of an element, kept up to date (headers overlay the content, which pads by this). */
function useHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    setH(el.offsetHeight);
    return () => ro.disconnect();
  });
  return [ref, h] as const;
}

export function useIsPhone() {
  const query = '(max-width: 599px)';
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

export default function MobileSheet({
  detent,
  onDetent,
  onVisibleHeight,
  header,
  children,
  scrollRef,
}: {
  detent: Detent;
  onDetent: (d: Detent) => void;
  /** visible sheet height in px (for placing map controls / centring the map above it) */
  onVisibleHeight?: (px: number) => void;
  header: ReactNode;
  children: ReactNode;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const ownScroll = useRef<HTMLDivElement>(null);
  const content = scrollRef ?? ownScroll;
  const [vh, setVh] = useState(() => window.innerHeight);
  const [safe, setSafe] = useState({ top: 0, bottom: 0 });
  const [dragY, setDragY] = useState<number | null>(null); // live visible height while dragging
  const [scrolled, setScrolled] = useState(false); // content under the header -> header gets glass + hairline
  const [headRef, headH] = useHeight<HTMLDivElement>();

  useLayoutEffect(() => {
    // safe areas aren't readable from JS directly: measure them (again when the screen turns or
    // Safari's bars come and go)
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;width:0;box-sizing:content-box;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
    const frame = sheet.current?.parentElement;
    const measure = () => {
      setVh(frame?.clientHeight || window.innerHeight); // the map's frame: the real screen height
      const s = getComputedStyle(probe);
      const top = parseFloat(s.paddingTop) || 0, bottom = parseFloat(s.paddingBottom) || 0;
      setSafe(prev => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(probe);
    if (frame) ro.observe(frame);
    window.addEventListener('resize', measure);
    return () => { window.removeEventListener('resize', measure); ro.disconnect(); probe.remove(); };
  }, []);

  const heights = detentHeights(vh, safe.top, safe.bottom);
  const visible = dragY ?? heights[detent];

  useEffect(() => { onVisibleHeight?.(visible); }, [visible, onVisibleHeight]);

  // leaving "full" scrolls the content back to the top (like Apple Maps)
  useEffect(() => {
    if (detent !== 'full') content.current?.scrollTo({ top: 0 });
  }, [detent, content]);

  const snap = useCallback((h: number, velocity: number) => {
    // velocity in px/ms, positive = growing (finger moving up)
    const projected = h + velocity * PROJECT_MS;
    let best: Detent = 'half', bd = Infinity;
    for (const d of ['collapsed', 'half', 'full'] as const) {
      const dist = Math.abs(heights[d] - projected);
      if (dist < bd) { bd = dist; best = d; }
    }
    onDetent(best);
    setDragY(null);
  }, [heights, onDetent]);

  // latest values for the long-lived touch listeners (re-binding them mid-drag would lose the drag)
  const live = useRef({ heights, detent, snap });
  live.current = { heights, detent, snap };

  // Touch drag (non-passive so we can stop the page/content from scrolling while dragging)
  useEffect(() => {
    const el = sheet.current;
    if (!el) return;
    let startY = 0, startH = 0, mode: 'undecided' | 'sheet' | 'scroll' = 'undecided';
    let samples: { t: number; y: number }[] = [];
    let fromHeader = false;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      startY = t.clientY;
      startH = live.current.heights[live.current.detent];
      mode = 'undecided';
      samples = [{ t: e.timeStamp, y: t.clientY }];
      fromHeader = !!(e.target as HTMLElement).closest('.ex-sheet__head');
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      const dy = y - startY; // + = down
      if (mode === 'undecided') {
        if (Math.abs(dy) < 6) return;
        const scrollTop = content.current?.scrollTop ?? 0;
        // full sheet: content scrolls, unless pulling down from the very top (or on the header)
        mode = live.current.detent !== 'full' || fromHeader || (dy > 0 && scrollTop <= 0) ? 'sheet' : 'scroll';
        startY = y; // start the sheet drag from here so it doesn't jump
      }
      if (mode !== 'sheet') return;
      e.preventDefault();
      samples.push({ t: e.timeStamp, y });
      if (samples.length > 6) samples.shift();
      const h = startH - (y - startY);
      // rubber-band past the ends
      const lo = live.current.heights.collapsed, hi = live.current.heights.full;
      const clamped = h < lo ? lo - Math.sqrt(lo - h) * 3 : h > hi ? hi + Math.sqrt(h - hi) * 3 : h;
      setDragY(clamped);
    };
    const onEnd = (e: TouchEvent) => {
      if (mode !== 'sheet') return;
      mode = 'undecided';
      const a = samples[0], b = samples[samples.length - 1];
      const dt = Math.max(1, b.t - a.t);
      // samples older than ~100ms don't describe the release velocity
      const v = e.timeStamp - b.t > 100 ? 0 : -(b.y - a.y) / dt;
      const h = startH - (b.y - startY);
      live.current.snap(h, v);
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [content]);

  // Mouse drag on the header (desktop browsers at phone width / testing)
  const onHeadPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || (e.target as HTMLElement).closest('input, button')) return;
    const startY = e.clientY, startH = heights[detent];
    let last = { t: e.timeStamp, y: e.clientY }, prev = last;
    const move = (ev: PointerEvent) => {
      prev = last; last = { t: ev.timeStamp, y: ev.clientY };
      setDragY(Math.max(heights.collapsed - 20, Math.min(heights.full + 20, startH - (ev.clientY - startY))));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const v = -(last.y - prev.y) / Math.max(1, last.t - prev.t);
      snap(startH - (ev.clientY - startY), ev.timeStamp - last.t > 100 ? 0 : v);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      ref={sheet}
      className={`ex-sheet ex-sheet--${detent} ${dragY != null ? 'is-dragging' : ''}`}
      style={{ height: heights.full, transform: `translateY(${heights.full - visible}px)` }}
    >
      {/* header floats over the content (outside the scroller, so it never moves) and the
          content scrolls under it, like the desktop panel header */}
      <div ref={headRef} className={`ex-sheet__head ${scrolled ? 'is-scrolled' : ''}`} onPointerDown={onHeadPointerDown}>
        <button
          className="ex-sheet__grabber"
          aria-label={detent === 'full' ? 'Collapse sheet' : 'Expand sheet'}
          onClick={() => onDetent(detent === 'full' ? 'half' : detent === 'half' ? 'full' : 'half')}
        />
        {header}
      </div>
      <div ref={content} className="ex-sheet__content" style={{ paddingTop: headH }} onScroll={e => setScrolled(e.currentTarget.scrollTop > 0)}>
        {children}
      </div>
    </div>
  );
}

/**
 * A second sheet stacked on top of the main one (Apple's "Cities" picker): slides up to full
 * height over a dimmed backdrop; dismissed by ✕, tapping the backdrop, or dragging its header
 * down (a flick or ~1/4 of its height).
 */
export function CitiesModal({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const [shown, setShown] = useState(open); // stay mounted while sliding out
  const [entered, setEntered] = useState(false);
  const [drag, setDrag] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const [headRef, headH] = useHeight<HTMLDivElement>();
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) {
      setShown(true);
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
      return () => cancelAnimationFrame(id);
    }
    setEntered(false);
    const t = setTimeout(() => { setShown(false); setDrag(0); }, 480);
    return () => clearTimeout(t);
  }, [open]);
  useEffect(() => { if (open) scroll.current?.scrollTo({ top: 0 }); }, [open]);
  if (!shown) return null;

  const onTouchStart = (e: React.TouchEvent) => {
    const y0 = e.touches[0].clientY, t0 = e.timeStamp;
    const el = e.currentTarget as HTMLElement;
    let last = 0;
    const move = (ev: TouchEvent) => { last = Math.max(0, ev.touches[0].clientY - y0); setDrag(last); ev.preventDefault(); };
    const end = (ev: TouchEvent) => {
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      const fast = last / Math.max(1, ev.timeStamp - t0) > 0.6;
      if (fast || last > window.innerHeight * 0.25) onClose();
      else setDrag(0);
    };
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
  };

  return (
    <div className={`ex-modal ${entered ? 'is-open' : ''}`}>
      <div className="ex-modal__scrim" onClick={onClose} />
      <div className={`ex-modal__sheet ${drag ? 'is-dragging' : ''}`} style={drag ? { transform: `translateY(${drag}px)` } : undefined} role="dialog" aria-modal="true" aria-label="Cities">
        <div ref={headRef} className={`ex-modal__head ${scrolled ? 'is-scrolled' : ''}`} onTouchStart={onTouchStart}>
          <span className="ex-modal__grabber" />
          <div className="ex-sheet__titlerow ex-sheet__titlerow--first">
            <h2>Cities</h2>
            <button className="ex-close" aria-label="Close" onClick={onClose}>
              <CloseIcon />
            </button>
          </div>
        </div>
        <div ref={scroll} className="ex-modal__content" style={{ paddingTop: headH }} onScroll={e => setScrolled(e.currentTarget.scrollTop > 0)}>
          <div className="ex-modal__body">{children}</div>
        </div>
      </div>
    </div>
  );
}
