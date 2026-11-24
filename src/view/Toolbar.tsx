import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { DARK_UI } from '../theme';
import { useSquircle } from '../useSquircle';
import type { Tool, ToolType } from './tools';

/** Tool body for the current appearance (tips and bands are shared). */
const body = (name: string) => `/tools/${name}-base${DARK_UI ? '-dark' : ''}.png`;

/** A pen whose tip is painted in its colour. */
function TippedPen({ name, color, height }: { name: string; color: string; height: number }) {
  const size = { x: '0', y: '0', width: '138', height: String(height) };
  return (
    <svg className="pen-tip" viewBox={`36 0 66 ${height}`} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <mask id={`${name}-tip-mask`} style={{ maskType: 'alpha' }}>
          <image href={`/tools/${name}-tip.png`} {...size} />
        </mask>
      </defs>
      <image href={body(name)} {...size} />
      <rect {...size} fill={color} mask={`url(#${name}-tip-mask)`} />
      <image href={`/tools/${name}-tip-contour.png`} {...size} />
    </svg>
  );
}

/** The fountain pen: a band in its colour. */
function FountainPen({ color }: { color: string }) {
  return (
    <svg className="pen-tip" viewBox="36 0 66 318" xmlns="http://www.w3.org/2000/svg">
      <image href={body('fountainpen')} x="0" y="0" width="138" height="318" />
      <rect x="36" y="165" width="66" height="7" fill={color} />
    </svg>
  );
}

function Eraser({ active }: { active: boolean }) {
  if (DARK_UI) {
    return (
      <svg className="pen-tip" viewBox="36 0 66 390" xmlns="http://www.w3.org/2000/svg">
        <image href={body('eraser')} x="0" y="0" width="138" height="390" />
      </svg>
    );
  }
  return (
    <svg className="pen-tip" width="20" height="89" viewBox="0 0 20 89" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient x1="100%" y1="40.708%" x2="0%" y2="40.708%" id="eraser-body">
          <stop stopColor="#DADADA" offset="0%" />
          <stop stopColor="#F5F5F5" offset="16.9%" />
          <stop stopColor="#FAF7F7" offset="44.5%" />
          <stop stopColor="#E1E1E1" offset="75%" />
          <stop stopColor="#DCDDDC" offset="91.2%" />
          <stop stopColor="#E4E4E4" offset="97.4%" />
          <stop stopColor="#E4E4E4" offset="100%" />
        </linearGradient>
        <linearGradient x1="100%" y1="56.785%" x2="0%" y2="56.785%" id="eraser-cap">
          <stop stopColor="#D8918F" offset="0%" />
          <stop stopColor="#F79E9D" offset="25%" />
          <stop stopColor="#F79E9D" offset="48.6%" />
          <stop stopColor="#D9807F" offset="83.8%" />
          <stop stopColor="#DB9191" offset="100%" />
        </linearGradient>
        <linearGradient x1="50%" y1="0%" x2="50%" y2="7.756%" id="eraser-cap-shadow">
          <stop stopColor="#D27977" offset="0%" />
          <stop stopColor="#525252" stopOpacity="0" offset="100%" />
        </linearGradient>
      </defs>
      <g stroke="none" strokeWidth="1" fill="none" fillRule="evenodd">
        {/* Silver body */}
        <rect fill="url(#eraser-body)" x="0.5" y="17" width="19" height="72" />
        {/* Pink eraser cap */}
        <path d="M10,0 C16,0 19.167,2.018 19.5,6.054 L19.5,32 L0.5,32 L0.5,6.054 C0.833,2.018 4,0 10,0 Z" fill="url(#eraser-cap)" />
        <path d="M10,0 C16,0 19.167,2.018 19.5,6.054 L19.5,32 L0.5,32 L0.5,6.054 C0.833,2.018 4,0 10,0 Z" fill="url(#eraser-cap-shadow)" />
        {/* Metal band with X icon */}
        <rect fill="url(#eraser-body)" x="0.5" y="17" width="19" height="16" rx="0" />
        {/* X mark */}
        <path d="M13.779,21.464 C13.399,21.084 12.782,21.084 12.401,21.464 L10.261,23.604 L8.213,21.555 C7.822,21.165 7.189,21.165 6.799,21.555 C6.408,21.946 6.408,22.579 6.799,22.969 L8.847,25.018 L6.708,27.158 C6.328,27.538 6.328,28.155 6.708,28.536 C7.089,28.916 7.705,28.916 8.086,28.536 L10.225,26.396 L12.274,28.445 C12.665,28.835 13.298,28.835 13.688,28.445 C14.079,28.054 14.079,27.421 13.688,27.031 L11.64,24.982 L13.779,22.842 C14.16,22.462 14.16,21.845 13.779,21.464 Z" fill={active ? '#FF3B30' : 'url(#eraser-body)'} style={{ transition: 'fill 0.2s ease' }} />
      </g>
    </svg>
  );
}

const PENS: { tool: Tool; label: string; picture: (color: string, active: boolean) => React.JSX.Element }[] = [
  { tool: 'pencil', label: 'Pencil', picture: c => <TippedPen name="pencil" color={c} height={390} /> },
  { tool: 'marker', label: 'Marker', picture: c => <TippedPen name="marker" color={c} height={390} /> },
  { tool: 'eraser', label: 'Eraser', picture: (_, active) => <Eraser active={active} /> },
  { tool: 'crayon', label: 'Crayon', picture: c => <TippedPen name="crayon" color={c} height={390} /> },
  { tool: 'fountainPen', label: 'Fountain pen', picture: c => <FountainPen color={c} /> },
  { tool: 'watercolor', label: 'Watercolor', picture: c => <TippedPen name="watercolor" color={c} height={318} /> },
];

/** The pens scroll sideways on narrow screens: fade out the side there is more on. */
function useScrollFade(ref: RefObject<HTMLElement | null>): string {
  const [fade, setFade] = useState('none');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 2, right = el.scrollWidth - el.clientWidth - el.scrollLeft > 2;
      setFade(!left && !right ? 'none'
        : `linear-gradient(to right, ${left ? 'transparent, black 40px' : 'black calc(100% - 40px)'}${left && right ? ', black calc(100% - 40px)' : ''}${right ? ', transparent' : ''})`);
    };
    // focusing a pen also scrolls the strip up: undo that, but only then (writing it while the strip
    // is being scrolled cuts its momentum short on iPhones)
    const onFocus = () => { if (el.scrollTop) el.scrollTop = 0; };
    update();
    el.addEventListener('scroll', update, { passive: true });
    el.addEventListener('focusin', onFocus);
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => { el.removeEventListener('scroll', update); el.removeEventListener('focusin', onFocus); observer.disconnect(); };
  }, [ref]);
  return fade;
}

/**
 * The photo credit rests just above the toolbar on phones, and undo/redo are placed from it on
 * desktop: publish its real height as --toolbar-h. Measured again once its layout change has finished
 * animating (phone strip to desktop panel rotates over 0.4 s).
 */
function usePublishHeight(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const bar = ref.current;
    if (!bar || typeof ResizeObserver === 'undefined') return;
    const measure = () => document.documentElement.style.setProperty('--toolbar-h', `${bar.getBoundingClientRect().height}px`);
    let settle: ReturnType<typeof setTimeout> | undefined;
    const measureSoon = () => { measure(); clearTimeout(settle); settle = setTimeout(measure, 450); };
    const observer = new ResizeObserver(measureSoon);
    observer.observe(bar);
    bar.addEventListener('transitionend', measure);
    window.addEventListener('resize', measureSoon);
    return () => {
      observer.disconnect();
      clearTimeout(settle);
      bar.removeEventListener('transitionend', measure);
      window.removeEventListener('resize', measureSoon);
    };
  }, [ref]);
}

interface Props {
  tool: Tool;
  colors: Record<ToolType, string>;
  onTool(tool: Tool): void;
  onColor(tool: ToolType, color: string): void;
}

/** The pens and the colour picker: a strip at the bottom on phones, a panel at the side on desktop. */
export default function Toolbar({ tool, colors, onTool, onColor }: Props) {
  const bar = useRef<HTMLDivElement>(null);
  const pens = useRef<HTMLDivElement>(null);
  useSquircle(bar, 9999);
  usePublishHeight(bar);
  const fade = useScrollFade(pens);
  const erasing = tool === 'eraser';
  const color = colors[erasing ? 'pencil' : tool];
  return (
    <div ref={bar} className="toolbar">
      <div ref={pens} className="nav-pen-group" style={{ maskImage: fade, WebkitMaskImage: fade }}>
        <div className="pen-container">
          {PENS.map(({ tool: t, label, picture }) => (
            <button key={t} className={`pen-btn ${t} ${tool === t ? 'active' : ''}`} aria-label={label} onClick={() => onTool(t)}>
              {picture(t === 'eraser' ? '' : colors[t], tool === t)}
            </button>
          ))}
        </div>
      </div>
      <div className="tool-group" style={{ alignSelf: 'flex-end', marginBottom: -6 }}>
        <div className={`color-grid ${erasing ? 'disabled' : ''}`}>
          {/* rainbow ring around the tool's colour; opens the picker */}
          <label className="color-option color-picker-swatch" style={{ '--picked': color } as CSSProperties} title="Choose colour">
            <input type="color" value={color.toLowerCase()} disabled={erasing} onChange={e => { if (!erasing) onColor(tool, e.target.value.toUpperCase()); }} />
          </label>
        </div>
      </div>
    </div>
  );
}
