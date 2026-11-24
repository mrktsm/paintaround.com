import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import 'mapillary-js/dist/mapillary.css';
import './view.css';
import panoramaPreview from '../assets/panorama-preview.jpg';
import type { DrawingOverlay } from '../drawing/DrawingOverlay';
import { DEFAULT_PANORAMA, hasCoordinates, PANORAMA_BY_ID, type Panorama } from '../pool/catalog';
import { showOwnDrawing } from '../pool/localPreview';
import { panoramaLoadingPreviewUrl } from '../pool/panoramaImages';
import { recordVisit } from '../pool/visited';
import { DARK_UI } from '../theme';
import { CloseButton, LoadingSpinner, PhotoCredit, Tutorial, UndoRedo } from './controls';
import Toolbar from './Toolbar';
import type { Tool } from './tools';
import { usePanorama } from './usePanorama';
import { usePointer } from './usePointer';
import { useToolColors } from './useToolColors';
import { useTutorial } from './useTutorial';

/** A place: its photo, everyone's drawings on it, and the tools to draw with. */
function View({ panorama }: { panorama: Panorama }) {
  const navigate = useNavigate();
  const container = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<Tool>('pencil');
  const [colors, setColor] = useToolColors();
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const readHistory = useCallback((o: DrawingOverlay) => setHistory({ canUndo: o.canUndo(), canRedo: o.canRedo() }), []);
  const { viewer, overlay, isLoaded, isReady, failed } = usePanorama(container, panorama, readHistory);
  const tutorial = useTutorial();
  const pointer = usePointer({
    container, viewer, overlay, tool,
    color: colors[tool === 'eraser' ? 'pencil' : tool],
    canDraw: isLoaded && isReady && tutorial.state !== 'shown',
    onLookAround: tutorial.dismiss,
  });

  const close = () => {
    if (overlay.current) {
      pointer.endStroke();
      showOwnDrawing(panorama, overlay.current);
      overlay.current.leaveRealtime();
      void overlay.current.fadeOut();
    }
    // the map reopens where this place is
    const back = new URLSearchParams();
    if (hasCoordinates(panorama)) {
      back.set('lng', String(panorama.longitude));
      back.set('lat', String(panorama.latitude));
      back.set('imageId', panorama.id);
    }
    navigate(`/?${back}`);
  };

  return (
    <div className={`app${DARK_UI ? ' app--dark' : ''}`}>
      <div
        ref={container}
        className={`viewer-container drawing-active ${tool === 'eraser' ? 'tool-eraser' : ''} ${isLoaded ? 'loaded' : ''}`}
        style={{
          backgroundImage: `url(${panoramaLoadingPreviewUrl(panorama)}), url(${panorama.thumbnailUrl || panorama.previewUrl || panoramaPreview})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
        onPointerDownCapture={pointer.down}
        onPointerMoveCapture={pointer.move}
        onPointerUpCapture={pointer.up}
        onPointerLeave={pointer.leave}
      />
      <PhotoCredit panorama={panorama} />
      {failed && (
        <div className="panorama-error" role="alert">
          <p>This panorama could not be loaded. Try again or choose another place.</p>
          <button onClick={() => window.location.reload()}>Try again</button>
          <Link to="/">Choose a place</Link>
        </div>
      )}
      {/* looking around works as soon as the photo is up, before the drawings are */}
      {tutorial.state !== 'gone' && isLoaded && <Tutorial fading={tutorial.state === 'fading'} />}
      {/* there right away, usable once the place can be drawn on */}
      <div style={{ pointerEvents: !isLoaded || !isReady || tutorial.state !== 'gone' ? 'none' : 'auto' }}>
        <UndoRedo {...history} onUndo={() => overlay.current?.undo()} onRedo={() => overlay.current?.redo()} />
        <CloseButton onClick={close} />
        <Toolbar tool={tool} colors={colors} onTool={setTool} onColor={setColor} />
      </div>
      {!isLoaded && !failed && <LoadingSpinner />}
    </div>
  );
}

export default function ViewPage() {
  const [params] = useSearchParams();
  const panorama = PANORAMA_BY_ID.get(params.get('imageId') || DEFAULT_PANORAMA.id);
  const id = panorama?.id;
  useEffect(() => { if (id) recordVisit(id); }, [id]);
  if (!panorama) return <div className="panorama-unavailable"><h1>This place isn’t in the current collection.</h1><Link to="/">Explore places to draw</Link></div>;
  return <View key={panorama.id} panorama={panorama} />;
}
