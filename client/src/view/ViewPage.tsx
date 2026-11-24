import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import 'mapillary-js/dist/mapillary.css';
import './view.css';
import { parseAt, type LookingAt } from '../../../shared/shareView';
import type { DrawingOverlay } from '../drawing/DrawingOverlay';
import { DEFAULT_PANORAMA, PANORAMA_BY_ID, placeByName, placePath, type Panorama } from '../pool/catalog';
import { showOwnDrawing } from '../pool/localPreview';
import { recordVisit } from '../pool/visited';
import { DARK_UI } from '../theme';
import { Hint, LoadingSpinner, PhotoCredit, Tutorial, UndoRedo, ViewActions } from './controls';
import { share, shareLink } from './share';
import Toolbar from './Toolbar';
import type { Tool } from './tools';
import { useLoadingPicture } from './useLoadingPicture';
import { usePanorama } from './usePanorama';
import { usePointer } from './usePointer';
import { useToolColors } from './useToolColors';
import { useTutorial } from './useTutorial';

/** A place: its photo, everyone's drawings on it, and the tools to draw with. */
function View({ panorama, at }: { panorama: Panorama; at: LookingAt | null }) {
  const navigate = useNavigate();
  const container = useRef<HTMLDivElement>(null);
  /** Null: no pen picked, just looking around. */
  const [tool, setTool] = useState<Tool | null>('pencil');
  const [colors, setColor] = useToolColors();
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const readHistory = useCallback((o: DrawingOverlay) => setHistory({ canUndo: o.canUndo(), canRedo: o.canRedo() }), []);
  const { viewer, overlay, isLoaded, isReady, failed } = usePanorama(container, panorama, at, readHistory);
  const loadingPicture = useLoadingPicture(panorama, at);
  const tutorial = useTutorial();
  const pointer = usePointer({
    container, viewer, overlay, tool,
    color: colors[!tool || tool === 'eraser' ? 'pencil' : tool],
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
    navigate('/', { state: { from: panorama.id } }); // the map reopens where this place is
  };

  return (
    <div className={`app${DARK_UI ? ' app--dark' : ''}`}>
      <div
        ref={container}
        className={`viewer-container ${tool ? 'drawing-active' : ''} ${isLoaded ? 'loaded' : ''}`}
        style={{
          backgroundImage: loadingPicture,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
        onPointerDownCapture={pointer.down}
        onPointerMoveCapture={pointer.move}
        onPointerUpCapture={pointer.up}
        onPointerCancelCapture={pointer.cancel}
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
        <ViewActions
          canShare={isLoaded}
          onShare={async () => !!viewer.current && share(await shareLink(viewer.current, panorama.id))}
          onDone={close}
        />
        {!tool && <Hint>Drag to look around</Hint>}
        <Toolbar tool={tool} colors={colors} onTool={t => setTool(now => (now === t ? null : t))} onColor={setColor} />
      </div>
      {!isLoaded && !failed && <LoadingSpinner />}
    </div>
  );
}

export default function ViewPage() {
  const { place = '' } = useParams();
  const [params] = useSearchParams();
  const panorama = placeByName(place);
  const id = panorama?.id;
  const link = params.get('at');
  const at = useMemo(() => parseAt(link), [link]);
  useEffect(() => { if (id) recordVisit(id); }, [id]);
  // the address stays simple: where a shared link looks was only needed to open it
  useEffect(() => { if (id && link !== null) window.history.replaceState(window.history.state, '', placePath(id)); }, [id, link]);
  if (!panorama) return <div className="panorama-unavailable"><h1>This place isn’t in the current collection.</h1><Link to="/">Explore places to draw</Link></div>;
  return <View key={`${panorama.id} ${link}`} panorama={panorama} at={at} />;
}

/** Addresses from before (/view?imageId=ph-colosseum). */
export function OldViewLink() {
  const [params] = useSearchParams();
  const id = params.get('imageId') || DEFAULT_PANORAMA.id, at = params.get('at');
  return <Navigate replace to={PANORAMA_BY_ID.has(id) ? `${placePath(id)}${at ? `?at=${encodeURIComponent(at)}` : ''}` : `/${encodeURIComponent(id)}`} />;
}
