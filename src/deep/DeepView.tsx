import { useCallback, useEffect, useRef, useState } from 'react';
import { Viewer } from 'mapillary-js';
import { useSearchParams } from 'react-router-dom';
import 'mapillary-js/dist/mapillary.css';
import { DeepBrush, DeepLayers, type DeepMode } from './DeepBrush';

// Panoramas with precomputed layers in public/deep-layers (see research/deep-brush).
const SPOTS = [
  { id: '287647329615048', label: 'Brick wall + bus' },
  { id: '1006271928250695', label: 'Brooklyn corner' },
  { id: '1202577813847514', label: 'Spot 3' },
  { id: '1470904911288094', label: 'Spot 4' },
];
const COLORS = ['#EB1F73', '#FF3B30', '#FFCC00', '#34C759', '#007AFF', '#FFFFFF', '#111111'];
const MODES: { id: DeepMode; label: string }[] = [
  { id: 'flat', label: 'Flat' },
  { id: 'shaded', label: 'Keep shadows' },
  { id: 'wrap', label: 'Wrap + shadows' },
];

/** Deep Brush prototype page (/deep). Local only, nothing is saved. */
export default function DeepView() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const viewerElRef = useRef<HTMLDivElement>(null);
  const brushRef = useRef<DeepBrush | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [params, setParams] = useSearchParams();
  const startId = params.get('imageId') || SPOTS[0].id;

  const [mode, setMode] = useState<DeepMode>('wrap');
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(10);
  const [texture, setTexture] = useState(0.5);
  const [drawMode, setDrawMode] = useState(true);
  const [status, setStatus] = useState<'loading' | 'ready' | 'none'>('loading');
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const toolRef = useRef({ color, size, drawMode });
  toolRef.current = { color, size, drawMode };

  useEffect(() => {
    const wrap = wrapRef.current!;
    const viewer = new Viewer({
      accessToken: 'REMOVED',
      container: viewerElRef.current!,
      imageId: startId,
      component: { cover: false, attribution: false, sequence: false, direction: true, zoom: false },
    });
    viewerRef.current = viewer;
    const brush = new DeepBrush();
    brush.onChange = bump;
    brushRef.current = brush;
    viewer.addCustomRenderer(brush);
    if (import.meta.env.DEV) (window as unknown as { __deep: unknown }).__deep = { viewer, brush };

    let loadToken = 0;
    viewer.on('image', async (e) => {
      const id = e.image.id;
      const token = ++loadToken;
      setStatus('loading');
      const layers = await DeepLayers.load(id);
      if (token !== loadToken) return;
      brush.setImage(layers);
      setStatus(layers ? 'ready' : 'none');
      // Dev-only: ?demo=1 paints sample squiggles (same spots as research/deep-brush/paint_test.py)
      if (import.meta.env.DEV && layers && params.get('demo')) {
        const seeds = [[760, 470, 60], [1500, 600, 50], [1000, 850, 110], [300, 760, 90]];
        seeds.forEach(([cu, cv, s], n) => {
          for (let i = 0; i <= 80; i++) {
            const t = i / 80;
            const x = t < 0.7 ? -1 + (t / 0.7) * 2 : 0.75 + 0.25 * Math.cos(((t - 0.7) / 0.3) * 2 * Math.PI);
            const y = t < 0.7 ? 0.35 * Math.sin((t / 0.7) * 3 * Math.PI) : 0.25 * Math.sin(((t - 0.7) / 0.3) * 2 * Math.PI);
            const u = (cu + x * s * 2) / 2048, v = (cv + y * s * 2) / 1024;
            if (i === 0) brush.begin(u, v, COLORS[n % COLORS.length], 9);
            else brush.extend(u, v);
          }
          brush.end();
        });
        const m = params.get('mode') as DeepMode | null;
        if (m) {
          setMode(m);
          brush.setMode(m);
        }
      }
    });

    const onResize = () => viewer.resize();
    window.addEventListener('resize', onResize);

    // ---- drawing input: screen px -> image (basic) coords via Mapillary, kept in order ----
    let drawing = false;
    let chain: Promise<void> = Promise.resolve();
    const local = (e: PointerEvent) => {
      const r = wrap.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const isUi = (e: Event) => !!(e.target as HTMLElement).closest('[data-ui]');
    const enqueue = (pt: number[], kind: 'begin' | 'extend') => {
      chain = chain.then(async () => {
        const basic = await viewer.unprojectToBasic(pt);
        if (!basic || basic[0] < 0 || basic[0] > 1 || basic[1] < 0 || basic[1] > 1) return;
        if (kind === 'begin') brush.begin(basic[0], basic[1], toolRef.current.color, toolRef.current.size);
        else brush.extend(basic[0], basic[1]);
      });
    };
    const onDown = (e: PointerEvent) => {
      if (!toolRef.current.drawMode || e.button !== 0 || isUi(e) || !brush.hasLayers()) return;
      e.stopPropagation();
      e.preventDefault();
      wrap.setPointerCapture(e.pointerId);
      drawing = true;
      enqueue(local(e), 'begin');
    };
    let lastMove = 0;
    const onMove = (e: PointerEvent) => {
      if (!drawing) return;
      e.stopPropagation();
      const now = performance.now();
      if (now - lastMove < 12) return; // ~80 Hz is plenty, each point costs an unproject
      lastMove = now;
      enqueue(local(e), 'extend');
    };
    const onUp = (e: PointerEvent) => {
      if (!drawing) return;
      e.stopPropagation();
      drawing = false;
      chain = chain.then(() => brush.end());
    };
    const block = (e: Event) => {
      if (toolRef.current.drawMode && !isUi(e) && brush.hasLayers() && (!(e instanceof MouseEvent) || e.button === 0)) {
        e.stopPropagation();
      }
    };
    wrap.addEventListener('pointerdown', onDown, true);
    wrap.addEventListener('pointermove', onMove, true);
    wrap.addEventListener('pointerup', onUp, true);
    wrap.addEventListener('pointercancel', onUp, true);
    wrap.addEventListener('mousedown', block, true);
    wrap.addEventListener('touchstart', block, true);

    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) brush.redo();
        else brush.undo();
      } else if (e.key.toLowerCase() === 'd' && !e.metaKey && !e.ctrlKey) {
        setDrawMode((m) => !m);
      } else if (['1', '2', '3'].includes(e.key)) {
        const m = MODES[Number(e.key) - 1].id;
        setMode(m);
        brush.setMode(m);
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      wrap.removeEventListener('pointerdown', onDown, true);
      wrap.removeEventListener('pointermove', onMove, true);
      wrap.removeEventListener('pointerup', onUp, true);
      wrap.removeEventListener('pointercancel', onUp, true);
      wrap.removeEventListener('mousedown', block, true);
      wrap.removeEventListener('touchstart', block, true);
      viewer.remove();
      brushRef.current = null;
    };
  }, [startId, bump]);

  const brush = brushRef.current;
  const pickMode = (m: DeepMode) => {
    setMode(m);
    brush?.setMode(m);
  };

  return (
    <div ref={wrapRef} style={{ position: 'fixed', inset: 0, background: '#000', touchAction: 'none', cursor: drawMode && status === 'ready' ? 'crosshair' : 'grab' }}>
      <div ref={viewerElRef} style={{ position: 'absolute', inset: 0 }} />

      {/* top: spot picker + status */}
      <div data-ui style={{ ...bar, top: 14 }}>
        {SPOTS.map((s) => (
          <button key={s.id} style={pill(s.id === startId)} onClick={() => setParams({ imageId: s.id })}>
            {s.label}
          </button>
        ))}
      </div>
      <div style={hint}>
        {status === 'loading' && 'Loading depth + lighting…'}
        {status === 'none' && 'No deep data for this spot — pick one above'}
        {status === 'ready' && (drawMode ? 'Drag to paint · right-drag or D to look · 1/2/3 switch modes' : 'Drag to look · D to paint')}
      </div>

      {/* bottom: mode + tools */}
      <div data-ui style={{ ...bar, bottom: 18 }}>
        {MODES.map((m, i) => (
          <button key={m.id} style={pill(mode === m.id)} onClick={() => pickMode(m.id)} title={`Key ${i + 1}`}>
            {m.label}
          </button>
        ))}
        <span style={divider} />
        {COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            aria-label={c}
            style={{ width: 22, height: 22, borderRadius: '50%', border: 0, cursor: 'pointer', background: c, boxShadow: c === color ? 'inset 0 0 0 2px #fff, 0 0 0 1px rgba(0,0,0,.4)' : '0 0 0 1px rgba(0,0,0,.25)' }}
          />
        ))}
        <span style={divider} />
        <input type="range" min={3} max={30} value={size} onChange={(e) => setSize(Number(e.target.value))} style={{ width: 80 }} title="Brush size" />
        <span style={{ font: '600 12px system-ui', color: '#555' }}>Texture</span>
        <input
          type="range" min={0} max={100} value={Math.round(texture * 100)} style={{ width: 80 }}
          title="How much of the photo's shadows/texture shows through the paint"
          onChange={(e) => setTexture(Number(e.target.value) / 100)}
          onPointerUp={() => brush?.setTexture(texture)}
          onKeyUp={() => brush?.setTexture(texture)}
        />
        <span style={divider} />
        <button style={pill(drawMode)} onClick={() => setDrawMode((m) => !m)}>{drawMode ? '✏️ Paint' : '✋ Look'}</button>
        <button style={pill(false)} onClick={() => brush?.undo()} disabled={!brush?.strokes.length}>Undo</button>
        <button style={pill(false)} onClick={() => brush?.clear()} disabled={!brush?.strokes.length}>Clear</button>
      </div>
    </div>
  );
}

const bar: React.CSSProperties = {
  position: 'absolute', left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 6,
  padding: '7px 9px', borderRadius: 999, background: 'rgba(235,235,240,.92)', boxShadow: '0 4px 20px rgba(0,0,0,.2)',
  zIndex: 10, maxWidth: 'calc(100vw - 24px)', overflowX: 'auto', cursor: 'default',
};
const pill = (on: boolean): React.CSSProperties => ({
  border: 0, borderRadius: 999, padding: '7px 12px', font: '600 13px system-ui, sans-serif', whiteSpace: 'nowrap', cursor: 'pointer',
  color: on ? '#fff' : '#1c1c1e', background: on ? '#1c1c1e' : 'transparent',
});
const divider: React.CSSProperties = { width: 1, height: 20, background: 'rgba(0,0,0,.15)', margin: '0 3px', flex: 'none' };
const hint: React.CSSProperties = {
  position: 'absolute', top: 64, left: '50%', transform: 'translateX(-50%)', padding: '6px 12px', borderRadius: 999,
  background: 'rgba(0,0,0,.5)', color: '#fff', font: '12px system-ui, sans-serif', zIndex: 10, whiteSpace: 'nowrap', pointerEvents: 'none',
};
