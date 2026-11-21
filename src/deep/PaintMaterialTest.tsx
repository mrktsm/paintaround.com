import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { TransitionMode, Viewer } from 'mapillary-js';
import { DeepBrush, DeepLayers, type PaintMaterial } from './DeepBrush';
import { PanoramaDataProvider } from '../pool/PanoramaDataProvider';
import { PANORAMA_BY_ID } from '../pool/catalog';
import './paint-material-test.css';

const PANORAMA = PANORAMA_BY_ID.get('ph-colosseum')!;
const MATERIALS: { id: PaintMaterial; label: string; description: string }[] = [
  { id: 'refined', label: 'Color lighting', description: 'Recovered shadows in color across the full 360° view: warm in the sun, cool in sky-lit shade. This is what the drawing tools use.' },
  { id: 'refined-grey', label: 'Gray, one view', description: 'The first recovered version: gray, and only for the 90° view facing the Colosseum.' },
  { id: 'lit-texture', label: 'Previous lighting', description: 'The earlier extraction misses most of the pavement’s cast shadow.' },
  { id: 'flat', label: 'Flat color', description: 'The same surface-wrapped strokes with no lighting or photo texture.' },
];

/** Same coverage and geometry in every mode: only the material multiplier changes. */
function addSamples(brush: DeepBrush, color: string) {
  brush.clear();
  // The pavement sample crosses from cast shadow into direct sun, so the
  // comparison tests shadow contrast rather than two points already in shade.
  for (const [u, v, du, dv, size] of [[0.8025, 0.405, 0.055, 0, 10], [0.76, 0.535, 0.02, 0.105, 16]]) {
    for (let step = 0; step <= 24; step++) {
      const t = step / 24;
      const x = u + t * du;
      const y = v + t * dv + Math.sin(t * Math.PI * 2) * 0.005;
      if (step === 0) brush.begin(x, y, color, size);
      else brush.extend(x, y);
    }
    brush.end();
  }
}

export default function PaintMaterialTest() {
  const mount = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const brushRef = useRef<DeepBrush | null>(null);
  const [material, setMaterial] = useState<PaintMaterial>('refined');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [color, setColor] = useState('#007AFF');
  const [size, setSize] = useState(14);
  const [painting, setPainting] = useState(true);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const bump = useCallback(() => {
    const brush = brushRef.current;
    setHistory({ undo: !!brush?.strokes.length, redo: !!brush?.canRedo() });
  }, []);
  const tools = useRef({ color, size, painting });
  useEffect(() => { tools.current = { color, size, painting }; }, [color, size, painting]);

  useEffect(() => { brushRef.current?.setMaterial(material); }, [material]);

  useEffect(() => {
    const element = stage.current!;
    let disposed = false;
    let drawing = false;
    let pointerId: number | undefined;
    let chain = Promise.resolve();
    const viewer = new Viewer({
      container: mount.current!,
      dataProvider: new PanoramaDataProvider(),
      imageTiling: false,
      transitionMode: TransitionMode.Instantaneous,
      component: { cover: false, attribution: false, sequence: false, direction: false, zoom: false, cache: false },
    });
    const brush = new DeepBrush();
    brush.textureAmount = 1;
    brush.material = 'refined';
    brush.onChange = bump;
    brushRef.current = brush;
    viewer.addCustomRenderer(brush);

    const ready = Promise.all([viewer.moveTo(PANORAMA.id), DeepLayers.load(PANORAMA.id, true, true)]);
    void ready.then(([, layers]) => {
      if (disposed) return;
      if (!layers) throw new Error('The paint test needs the panorama’s depth and lighting layers.');
      viewer.setCenter([PANORAMA.thumbnailView?.u ?? 0.75, PANORAMA.thumbnailView?.v ?? 0.5]);
      brush.setImage(layers);
      addSamples(brush, tools.current.color);
      setStatus('ready');
    }).catch(error => {
      if (!disposed) { console.error('Paint material test could not load', error); setStatus('error'); }
    });

    const isControl = (event: Event) => (event.target as HTMLElement).closest('[data-paint-controls]');
    const enqueue = (event: PointerEvent, begin: boolean) => {
      const rect = element.getBoundingClientRect();
      const point = [event.clientX - rect.left, event.clientY - rect.top];
      const settings = { ...tools.current };
      chain = chain.then(async () => {
        if (disposed) return;
        const basic = await viewer.unprojectToBasic(point);
        if (disposed || !basic || basic[1] < 0 || basic[1] > 1) return;
        const u = ((basic[0] % 1) + 1) % 1;
        if (begin) brush.begin(u, basic[1], settings.color, settings.size);
        else brush.extend(u, basic[1]);
      }).catch(error => { if (!disposed) console.error('Paint input failed', error); });
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || isControl(event) || !tools.current.painting || !brush.hasLayers()) return;
      event.preventDefault();
      event.stopPropagation();
      drawing = true;
      pointerId = event.pointerId;
      element.setPointerCapture(event.pointerId);
      enqueue(event, true);
    };
    const move = (event: PointerEvent) => {
      if (!drawing || event.pointerId !== pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      enqueue(event, false);
    };
    const up = (event: PointerEvent) => {
      if (!drawing || event.pointerId !== pointerId) return;
      event.stopPropagation();
      drawing = false;
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      pointerId = undefined;
      chain = chain.then(() => { if (!disposed) brush.end(); });
    };
    const blockPan = (event: Event) => {
      if (tools.current.painting && brush.hasLayers() && !isControl(event) && (!(event instanceof MouseEvent) || event.button === 0)) event.stopPropagation();
    };
    element.addEventListener('pointerdown', down, true);
    element.addEventListener('pointermove', move, true);
    element.addEventListener('pointerup', up, true);
    element.addEventListener('pointercancel', up, true);
    element.addEventListener('mousedown', blockPan, true);
    element.addEventListener('touchstart', blockPan, true);
    return () => {
      disposed = true;
      element.removeEventListener('pointerdown', down, true);
      element.removeEventListener('pointermove', move, true);
      element.removeEventListener('pointerup', up, true);
      element.removeEventListener('pointercancel', up, true);
      element.removeEventListener('mousedown', blockPan, true);
      element.removeEventListener('touchstart', blockPan, true);
      if (pointerId !== undefined && element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      viewer.remove();
      brushRef.current = null;
    };
  }, [bump]);

  const current = MATERIALS.find(value => value.id === material)!;
  return (
    <main className="paint-test" ref={stage}>
      <div className="paint-test__viewer" ref={mount} />
      <header className="paint-test__header" data-paint-controls>
        <div className="paint-test__title"><h1>Paint test</h1><Link to="/">Back to map</Link></div>
        <div className="paint-test__materials" role="group" aria-label="Paint appearance">
          {MATERIALS.map(value => <button key={value.id} aria-pressed={value.id === material} onClick={() => setMaterial(value.id)}>{value.label}</button>)}
        </div>
        <p aria-live="polite">{current.description}</p>
      </header>
      {status !== 'ready' && <div className="paint-test__status" role={status === 'error' ? 'alert' : 'status'}>{status === 'loading' ? 'Loading paint surfaces…' : 'Could not load this test. Try reloading the page.'}</div>}
      <section className="paint-test__tools" aria-label="Paint tools" data-paint-controls>
        <button aria-pressed={painting} onClick={() => setPainting(value => !value)}>{painting ? 'Paint' : 'Look around'}</button>
        <label>Color<input type="color" value={color} onChange={event => setColor(event.target.value)} /></label>
        <label>Size<input type="range" min="5" max="30" value={size} onChange={event => setSize(Number(event.target.value))} /></label>
        <button disabled={status !== 'ready'} onClick={() => brushRef.current && addSamples(brushRef.current, color)}>Reset samples</button>
        <button disabled={!history.undo} onClick={() => brushRef.current?.undo()}>Undo</button>
        <button disabled={!history.redo} onClick={() => brushRef.current?.redo()}>Redo</button>
      </section>
    </main>
  );
}
