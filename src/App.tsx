import { useEffect, useRef, useState, useCallback } from 'react';
import { useSquircle } from './useSquircle';
import { Viewer, TransitionMode } from 'mapillary-js';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import 'mapillary-js/dist/mapillary.css';
import './App.css';

import panoramaPreview from './assets/panorama-preview.jpg';
import touchAndScroll from './assets/touch-and-scroll.svg';
import mouseRightClick from './assets/mouse-right-click.svg';
import { DrawingOverlay } from './DrawingOverlay';
import { DEFAULT_PANORAMA, PANORAMA_BY_ID, hasCoordinates, type Panorama } from './pool/catalog';
import { PanoramaDataProvider } from './pool/PanoramaDataProvider';
import { panoramaLoadingPreviewUrl } from './pool/panoramaImages';
import { recordVisit } from './pool/visited';
import { showOwnDrawing } from './pool/localPreview';
import { loadDeepData } from './deep/surfaceDecal';
import CloseIcon from './components/CloseIcon';
import { START_ZOOM } from './pool/startView';
import { DARK_UI } from './theme';

/** Tool body for the current appearance (tips/bands are shared). */
const toolBase = (name: string) => `/tools/${name}-base${DARK_UI ? '-dark' : ''}.png`;

// Force preserveDrawingBuffer on all WebGL contexts so we can capture screenshots
const _origGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement, type: string, attrs?: any) {
  if (type === 'webgl' || type === 'webgl2') {
    attrs = { ...attrs, preserveDrawingBuffer: true };
  }
  return (_origGetContext as any).call(this, type, attrs);
} as any;

// Pool for each tool's random default colour (the toolbar shows a single picker swatch).
// On-screen brush radius per tool (px at the stroke start) for the brush cursor — measured from
// real strokes (pencil ~3px, marker ~28px, crayon ~24px, fountain pen 1-6px, watercolor ~10px wide).
const BRUSH_CURSOR_RADIUS: Record<string, number> = {
  pencil: 2.5,
  marker: 14,
  crayon: 12,
  fountainPen: 3,
  watercolor: 5,
  eraser: 12,
};

const COLORS = [
  '#000000', '#FF3B30', '#34C759',
  '#007AFF', '#FFCC00'
];
const isHexColor = (c: string | null): c is string => !!c && /^#[0-9a-fA-F]{6}$/.test(c);

function App({ panorama }: { panorama: Panorama }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const drawingOverlayRef = useRef<DrawingOverlay | null>(null);
  const navigate = useNavigate();
  const [pencilColor, setPencilColor] = useState(() => {
    const saved = localStorage.getItem('pencilColor');
    if (isHexColor(saved)) return saved;
    const pool = COLORS;
    return pool[Math.floor(Math.random() * pool.length)];
  });
  const [markerColor, setMarkerColor] = useState(() => {
    const saved = localStorage.getItem('markerColor');
    if (isHexColor(saved)) return saved;
    const pool = COLORS;
    let color = pool[Math.floor(Math.random() * pool.length)];
    // Avoid same default as pencil
    while (color === pencilColor && pool.length > 1) {
      color = pool[Math.floor(Math.random() * pool.length)];
    }
    return color;
  });
  const [crayonColor, setCrayonColor] = useState(() => {
    const saved = localStorage.getItem('crayonColor');
    if (isHexColor(saved)) return saved;
    const pool = COLORS;
    let color = pool[Math.floor(Math.random() * pool.length)];
    while ((color === pencilColor || color === markerColor) && pool.length > 2) {
      color = pool[Math.floor(Math.random() * pool.length)];
    }
    return color;
  });
  const [fountainPenColor, setFountainPenColor] = useState(() => {
    const saved = localStorage.getItem('fountainPenColor');
    if (isHexColor(saved)) return saved;
    const pool = COLORS;
    let color = pool[Math.floor(Math.random() * pool.length)];
    while ((color === pencilColor || color === markerColor || color === crayonColor) && pool.length > 3) {
      color = pool[Math.floor(Math.random() * pool.length)];
    }
    return color;
  });
  const [watercolorColor, setWatercolorColor] = useState(() => {
    const saved = localStorage.getItem('watercolorColor');
    if (isHexColor(saved)) return saved;
    const pool = COLORS;
    let color = pool[Math.floor(Math.random() * pool.length)];
    while ((color === pencilColor || color === markerColor || color === crayonColor || color === fountainPenColor) && pool.length > 4) {
      color = pool[Math.floor(Math.random() * pool.length)];
    }
    return color;
  });
  const [activeTool, setActiveTool] = useState<'pencil' | 'marker' | 'crayon' | 'fountainPen' | 'watercolor' | 'eraser'>('pencil');
  const selectedColor = activeTool === 'marker' ? markerColor : activeTool === 'crayon' ? crayonColor : activeTool === 'fountainPen' ? fountainPenColor : activeTool === 'watercolor' ? watercolorColor : pencilColor;
  const setSelectedColor = activeTool === 'marker' ? setMarkerColor : activeTool === 'crayon' ? setCrayonColor : activeTool === 'fountainPen' ? setFountainPenColor : activeTool === 'watercolor' ? setWatercolorColor : setPencilColor;
  const [isDrawing, setIsDrawing] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [showLoadingSpinner, setShowLoadingSpinner] = useState(false);
  const [viewerError, setViewerError] = useState('');
  const [isStrokesLoading, setIsStrokesLoading] = useState(true);
  useEffect(() => {
    if (isLoaded) return;
    const timer = setTimeout(() => setShowLoadingSpinner(true), 300);
    return () => clearTimeout(timer);
  }, [isLoaded]);
  const thumbBg = panorama.thumbnailUrl || panorama.previewUrl;
  const activeToolRef = useRef(activeTool);
  const activePointers = useRef(new Map<number, { x: number; y: number }>());
  const isDrawingRef = useRef(false);
  const pinchRef = useRef<{
    lastMidX: number; lastMidY: number;
    lastDist: number;
    lastFov: number;
    lastZoom: number;
    moveBuffer: { time: number; dx: number; dy: number }[];
  } | null>(null);
  const inertiaRef = useRef<number | null>(null);
  const rightClickPanRef = useRef<{ lastX: number; lastY: number; fov: number; moveBuffer: { dx: number; dy: number; time: number }[] } | null>(null);
  const pendingTouchStrokeRef = useRef<{ x: number; y: number; color: string; lineWidth: number; tool: 'pencil' | 'marker' | 'crayon' | 'fountainPen' | 'watercolor'; time: number } | null>(null);
  const imageId = panorama.id;

  const toolbarRef = useRef<HTMLDivElement>(null);
  const navPenGroupRef = useRef<HTMLDivElement>(null);
  const [penScrollMask, setPenScrollMask] = useState<'none' | 'right' | 'left' | 'both'>('none');
  const [showTutorial, setShowTutorial] = useState(() => !localStorage.getItem('tutorialSeen'));
  const [tutorialFading, setTutorialFading] = useState(false);
  const showTutorialRef = useRef(!localStorage.getItem('tutorialSeen'));

  useSquircle(toolbarRef, 9999);

  // Detect pen scroll overflow and update fade masks
  useEffect(() => {
    const el = navPenGroupRef.current;
    if (!el) return;
    const update = () => {
      const canScrollLeft = el.scrollLeft > 2;
      const canScrollRight = el.scrollWidth - el.clientWidth - el.scrollLeft > 2;
      const mask = canScrollLeft && canScrollRight ? 'both'
        : canScrollLeft ? 'left'
        : canScrollRight ? 'right'
        : 'none';
      setPenScrollMask(mask);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', update); ro.disconnect(); };
  }, []);

  // The photo credit rests just above the drawing tools on phones; the bar's height scales
  // with the screen, so publish its real height as --toolbar-h.
  useEffect(() => {
    const bar = toolbarRef.current;
    if (!bar || typeof ResizeObserver === 'undefined') return;
    // (desktop also places undo/redo from it.) Measure again once the bar's layout change has
    // finished animating — switching between the phone strip and the desktop panel rotates it over
    // 0.4s, and a mid-animation measurement left undo/redo halfway down the panel.
    const measure = () => document.documentElement.style.setProperty('--toolbar-h', `${bar.getBoundingClientRect().height}px`);
    let settle: ReturnType<typeof setTimeout> | undefined;
    const measureSoon = () => { measure(); clearTimeout(settle); settle = setTimeout(measure, 450); };
    const ro = new ResizeObserver(measureSoon);
    ro.observe(bar);
    bar.addEventListener('transitionend', measure);
    window.addEventListener('resize', measureSoon);
    return () => {
      ro.disconnect();
      clearTimeout(settle);
      bar.removeEventListener('transitionend', measure);
      window.removeEventListener('resize', measureSoon);
    };
  }, []);

  // Undo/Redo availability
  const [undoAvailable, setUndoAvailable] = useState(false);
  const [redoAvailable, setRedoAvailable] = useState(false);

  const refreshUndoRedo = useCallback(() => {
    if (drawingOverlayRef.current) {
      setUndoAvailable(drawingOverlayRef.current.canUndo());
      setRedoAvailable(drawingOverlayRef.current.canRedo());
    }
  }, []);
  const selectedColorRef = useRef(selectedColor);

  // Keep ref in sync & persist colors
  useEffect(() => {
    selectedColorRef.current = selectedColor;
  }, [selectedColor]);

  useEffect(() => { localStorage.setItem('pencilColor', pencilColor); }, [pencilColor]);
  useEffect(() => { localStorage.setItem('markerColor', markerColor); }, [markerColor]);
  useEffect(() => { localStorage.setItem('crayonColor', crayonColor); }, [crayonColor]);
  useEffect(() => { localStorage.setItem('fountainPenColor', fountainPenColor); }, [fountainPenColor]);
  useEffect(() => { localStorage.setItem('watercolorColor', watercolorColor); }, [watercolorColor]);

  const handleBack = () => {
    if (drawingOverlayRef.current) {
      if (isDrawingRef.current) void drawingOverlayRef.current.endStroke();
      showOwnDrawing(panorama, drawingOverlayRef.current);
      drawingOverlayRef.current.leaveRealtime();
      void drawingOverlayRef.current.fadeOut();
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

  useEffect(() => {
    let disposed = false;
    let revealFrame: number | undefined;
    let cameraReady = false;
    let renderReady = false;
    const reveal = () => {
      if (disposed || !cameraReady || !renderReady || revealFrame !== undefined) return;
      revealFrame = requestAnimationFrame(() => {
        if (disposed) return;
        setIsLoaded(true);
      });
    };

    if (containerRef.current && !viewerRef.current) {
      // Start depth/material loading alongside the photo. The view can reveal
      // immediately; drawing waits until its lighting is available.
      void loadDeepData(imageId);
      viewerRef.current = new Viewer({
        dataProvider: new PanoramaDataProvider(),
        container: containerRef.current,
        imageTiling: false,
        component: {
          attribution: false,
          bearing: false,
          cache: false,
          cover: false,
          direction: false,
          image: true,
          keyboard: true,
          marker: false,
          pointer: true,
          popup: false,
          sequence: false,
          slider: false,
          spatial: false,
          tag: false,
          zoom: false,
        },
        transitionMode: TransitionMode.Instantaneous,
      });
      viewerRef.current.on('load', () => {
        renderReady = true;
        reveal();
      });

      // Use 'image' event which confirms data is loaded
      viewerRef.current.on('image', async (event) => {
        if (disposed) return;
        // Set image ID on drawing overlay for stroke persistence
        if (drawingOverlayRef.current && event?.image?.id) {
          const imageId = String(event.image.id);
          drawingOverlayRef.current.setImageId(imageId);
          // Subscribe to realtime drawing events for this panorama
          drawingOverlayRef.current.subscribeToRealtime(imageId);
        }
      });

      drawingOverlayRef.current = new DrawingOverlay(containerRef.current);
      // keep the undo/redo buttons in step when the history changes on its own (strokes baked
      // into the paint layer can no longer be undone)
      drawingOverlayRef.current.onHistoryChange = refreshUndoRedo;
      drawingOverlayRef.current.setGuestMode(false); // no accounts: nothing to hold back until sign-in
      // Start prefetching strokes immediately — don't wait for the viewer to load
      if (imageId) drawingOverlayRef.current.prefetchStrokes(imageId);
      drawingOverlayRef.current.onStrokesLoaded = () => {
        void loadDeepData(imageId).then(() => {
          if (disposed) return;
          drawingOverlayRef.current?.fadeIn();
          setIsStrokesLoading(false);
        });
      };
      drawingOverlayRef.current.setViewer(viewerRef.current);
      void viewerRef.current.moveTo(imageId).then(() => {
        if (disposed || !viewerRef.current || !containerRef.current) return;
        viewerRef.current.setCenter([panorama.thumbnailView?.u ?? 0.75, panorama.thumbnailView?.v ?? 0.5]);
        viewerRef.current.setZoom(START_ZOOM); // same camera the loading preview was rendered with
        // Reveal after the matching camera is applied, avoiding a flash of the
        // viewer's default direction or zoom before it settles on the preview.
        cameraReady = true;
        reveal();
      }).catch((error: unknown) => {
        if (!disposed) {
          console.error('Could not load panorama', error);
          setViewerError('This panorama could not be loaded. Try again or choose another place.');
        }
      });

      // Note: zoom limits are handled by Mapillary's internal min/maxZoom clamping
    }

    return () => {
      disposed = true;
      if (revealFrame !== undefined) cancelAnimationFrame(revealFrame);
      setIsLoaded(false);
      if (drawingOverlayRef.current) {
        showOwnDrawing(panorama, drawingOverlayRef.current); // left some other way (browser back)
        drawingOverlayRef.current.dispose();
        drawingOverlayRef.current = null;
      }
      if (viewerRef.current) {
        try {
          viewerRef.current.remove();
        } catch (e) {
          console.debug('Mapillary cleanup error:', e);
        }
        viewerRef.current = null;
      }
    };
  }, [imageId, panorama.thumbnailView?.u, panorama.thumbnailView?.v]);

  useEffect(() => {
    activeToolRef.current = activeTool;
    if (!viewerRef.current) return;
    if (activeTool) {
      viewerRef.current.deactivateComponent('pointer');
    } else {
      viewerRef.current.activateComponent('pointer');
    }
  }, [activeTool]);

  // Right-click pans the camera, so no context menu
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    container.addEventListener('contextmenu', onContextMenu, { capture: true });
    return () => container.removeEventListener('contextmenu', onContextMenu, { capture: true });
  }, []);

  const getPointerPosition = useCallback((e: React.PointerEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Track pointers for multi-touch (always, regardless of tool)
    const rect = containerRef.current?.getBoundingClientRect();
    activePointers.current.set(e.pointerId, {
      x: e.clientX - (rect?.left || 0),
      y: e.clientY - (rect?.top || 0),
    });

    // Block native events from reaching Mapillary during drawing or multi-touch
    if (activeTool || activePointers.current.size > 1) {
      e.nativeEvent.stopImmediatePropagation();
    }

    // Multi-touch detected: dismiss tutorial + start custom pan/zoom
    if (activePointers.current.size > 1) {
      if (showTutorialRef.current) {
        localStorage.setItem('tutorialSeen', '1');
        showTutorialRef.current = false;
        setTutorialFading(true);
        setTimeout(() => setShowTutorial(false), 400);
      }
      // Cancel pending touch stroke that hasn't started drawing yet
      pendingTouchStrokeRef.current = null;
      // Cancel any active stroke if drawing
      if (isDrawingRef.current && drawingOverlayRef.current) {
        drawingOverlayRef.current.endStroke();
        setTimeout(() => {
          if (drawingOverlayRef.current?.canUndo()) {
            drawingOverlayRef.current.undo();
          }
        }, 50);
        setIsDrawing(false);
        isDrawingRef.current = false;
      }
      // Initialize pinch gesture state
      const pts = [...activePointers.current.values()];
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      if (viewerRef.current) {
        const viewer = viewerRef.current;
        if (inertiaRef.current) {
          cancelAnimationFrame(inertiaRef.current);
          inertiaRef.current = null;
        }
        Promise.all([viewer.getFieldOfView(), viewer.getZoom()]).then(([fov, zoom]) => {
          pinchRef.current = {
            lastMidX: midX, lastMidY: midY,
            lastDist: dist,
            lastFov: fov,
            lastZoom: zoom,
            moveBuffer: [],
          };
        });
      }
      return;
    }

    // Single-finger: only handle if a drawing tool is active
    if (!activeTool || !drawingOverlayRef.current) return;

    // Middle click, right-click, or Shift+click: manual camera pan
    if (e.button === 1 || e.button === 2 || e.shiftKey) {
      if (showTutorialRef.current) {
        localStorage.setItem('tutorialSeen', '1');
        showTutorialRef.current = false;
        setTutorialFading(true);
        setTimeout(() => setShowTutorial(false), 400);
      }
      const pos = getPointerPosition(e);
      if (pos && viewerRef.current) {
        if (inertiaRef.current) {
          cancelAnimationFrame(inertiaRef.current);
          inertiaRef.current = null;
        }
        viewerRef.current.getFieldOfView().then(fov => {
          rightClickPanRef.current = { lastX: pos.x, lastY: pos.y, fov, moveBuffer: [] };
        });
        if (containerRef.current) containerRef.current.classList.add('panning');
      }
      return;
    }

    // Block drawing while tutorial is showing
    if (showTutorialRef.current) return;
    // The panorama can already be visible while existing artwork is loading.
    if (!isLoaded || isStrokesLoading) return;

    const pos = getPointerPosition(e);
    if (!pos) return;

    if (inertiaRef.current) {
      cancelAnimationFrame(inertiaRef.current);
      inertiaRef.current = null;
    }

    if (activeTool === 'eraser') {
      if (e.pointerType !== 'mouse') drawingOverlayRef.current.shareTouchCursor(pos.x, pos.y, BRUSH_CURSOR_RADIUS.eraser, true);
      drawingOverlayRef.current.eraseAt(pos.x, pos.y, BRUSH_CURSOR_RADIUS.eraser);
    } else if (e.pointerType === 'touch') {
      // Touch: wait until the finger moves, so a second finger can start a pan instead
      const lineWidth = activeTool === 'marker' ? 8 : 3;
      pendingTouchStrokeRef.current = { x: pos.x, y: pos.y, color: selectedColor, lineWidth, tool: activeTool as 'pencil' | 'marker' | 'crayon' | 'fountainPen' | 'watercolor', time: Date.now() };
    } else {
      // Mouse: start stroke immediately
      const lineWidth = activeTool === 'marker' ? 8 : 3;
      // stylus (Apple Pencil): share the ring first, like touch, so others get our brush size
      if (e.pointerType !== 'mouse') drawingOverlayRef.current.shareTouchCursor(pos.x, pos.y, BRUSH_CURSOR_RADIUS[activeTool] ?? 4, true);
      drawingOverlayRef.current.startStroke(pos.x, pos.y, selectedColor, lineWidth, activeTool);
      setIsDrawing(true);
      isDrawingRef.current = true;
    }
  }, [activeTool, selectedColor, getPointerPosition, isLoaded, isStrokesLoading]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    // Block native events from reaching Mapillary during drawing or pinch
    if (activeTool || activePointers.current.size > 1 || pinchRef.current) {
      e.nativeEvent.stopImmediatePropagation();
    }

    // Right-click camera pan (same math as pinch pan). The brush outline stays pinned to its spot
    // in the scene while the view moves (DrawingOverlay re-projects it on camera changes).
    if (rightClickPanRef.current && viewerRef.current) {
      const pos = getPointerPosition(e);
      if (pos) {
        const pan = rightClickPanRef.current;
        const vw = containerRef.current?.clientWidth || window.innerWidth;
        const vh = containerRef.current?.clientHeight || window.innerHeight;
        const dx = pos.x - pan.lastX;
        const dy = pos.y - pan.lastY;
        const hFov = pan.fov * (vw / vh);
        const movX = -(dx / vw) * (hFov / 360) * 1.25;
        const movY = -(dy / vh) * (pan.fov / 180) * 1.25;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (viewerRef.current as any)._navigator.stateService.rotateBasicUnbounded([movX, movY]);
        pan.moveBuffer.push({ dx: movX, dy: movY, time: Date.now() });
        if (pan.moveBuffer.length > 20) pan.moveBuffer.shift();
        pan.lastX = pos.x;
        pan.lastY = pos.y;
      }
      return;
    }

    // Custom two-finger pan + zoom
    if (activePointers.current.size > 1) {
      const rect = containerRef.current?.getBoundingClientRect();
      const pid = e.pointerId;
      if (activePointers.current.has(pid)) {
        activePointers.current.set(pid, {
          x: e.clientX - (rect?.left || 0),
          y: e.clientY - (rect?.top || 0),
        });
      }
      const pinch = pinchRef.current;
      if (!pinch || !viewerRef.current || activePointers.current.size < 2) return;

      const pts = [...activePointers.current.values()];
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);

      // Pan: use rotateBasicUnbounded for full 360° rotation (no clamping)
      const vw = rect?.width || window.innerWidth;
      const vh = rect?.height || window.innerHeight;
      const dx = midX - pinch.lastMidX;
      const dy = midY - pinch.lastMidY;
      // Convert pixel delta to basic coord delta, scaled by FOV
      // Basic X spans 360°, basic Y spans 180° (equirectangular)
      // Multiply by 1.25 to compensate for rotateBasicUnbounded's 0.8 lerp alpha
      const hFov = pinch.lastFov * (vw / vh);
      const movX = -(dx / vw) * (hFov / 360) * 1.25;
      const movY = -(dy / vh) * (pinch.lastFov / 180) * 1.25;

      // rotateBasicUnbounded: delta-based, no 0-1 clamping, works for spherical
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (viewerRef.current as any)._navigator.stateService.rotateBasicUnbounded([movX, movY]);

      // Buffer recent moves (keep last 50ms, matching Mapillary's _drainBuffer)
      const now = Date.now();
      pinch.moveBuffer.push({ time: now, dx: movX, dy: movY });
      while (pinch.moveBuffer.length > 0 && now - pinch.moveBuffer[0].time > 50) {
        pinch.moveBuffer.shift();
      }

      // Zoom: apply continuously with reduced sensitivity (0.8x vs Mapillary's 3x)
      // so small finger distance drift during panning is barely noticeable
      const distanceChange = dist - pinch.lastDist;
      const minDim = Math.min(vw, vh);
      const zoomDelta = 0.8 * distanceChange / minDim;
      const newZoom = Math.max(0, pinch.lastZoom + zoomDelta);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (viewerRef.current as any)._navigator.stateService.setZoom(newZoom);
      pinch.lastZoom = newZoom;
      pinch.lastDist = dist;

      // Update last values for next frame
      pinch.lastMidX = midX;
      pinch.lastMidY = midY;
      return;
    }

    const pos = getPointerPosition(e);
    if (!pos || !drawingOverlayRef.current) return;

    // Brush outline that wraps onto the surface under the mouse (not shown for touch / eraser).
    // While hovering it previews the paint colour inside, lit like the real stroke; while a
    // button is held the stroke itself is the preview, so the outline stays empty.
    if (activeTool && e.pointerType === 'mouse') {
      // the eraser shows its ring too, just never filled with paint
      const hoverColor = activeTool !== 'eraser' && e.buttons === 0 ? selectedColorRef.current : null;
      drawingOverlayRef.current.updateBrushCursor(pos.x, pos.y, BRUSH_CURSOR_RADIUS[activeTool] ?? 4, hoverColor);
    } else {
      drawingOverlayRef.current.hideBrushCursor();
    }

    // Start deferred touch stroke once finger moves enough
    const pending = pendingTouchStrokeRef.current;
    if (pending && drawingOverlayRef.current) {
      const dx = pos.x - pending.x;
      const dy = pos.y - pending.y;
      if (dx * dx + dy * dy > 36 && Date.now() - pending.time > 80) { // 6px + 80ms delay to avoid accidental draw during pinch
        pendingTouchStrokeRef.current = null;
        // share the ring first, so others get our brush size before the stroke starts
        drawingOverlayRef.current.shareTouchCursor(pos.x, pos.y, BRUSH_CURSOR_RADIUS[pending.tool] ?? 4, true);
        drawingOverlayRef.current.startStroke(pending.x, pending.y, pending.color, pending.lineWidth, pending.tool);
        drawingOverlayRef.current.addPoint(pos.x, pos.y);
        setIsDrawing(true);
        isDrawingRef.current = true;
      }
      return;
    }

    if (activeTool === 'eraser') {
      if (e.buttons > 0) {
        if (e.pointerType !== 'mouse') drawingOverlayRef.current.shareTouchCursor(pos.x, pos.y, BRUSH_CURSOR_RADIUS.eraser);
        drawingOverlayRef.current.eraseAt(pos.x, pos.y, BRUSH_CURSOR_RADIUS.eraser);
      }
      return;
    }

    if (isDrawing) {
      // every sample since the last event (pens and fast fingers report more than one per frame),
      // so quick curves stay curves
      const overlay = drawingOverlayRef.current;
      const rect = containerRef.current?.getBoundingClientRect();
      const samples = rect ? e.nativeEvent.getCoalescedEvents?.() ?? [] : [];
      for (const s of samples) overlay.addPoint(s.clientX - rect!.left, s.clientY - rect!.top);
      overlay.addPoint(pos.x, pos.y);
      if (e.pointerType !== 'mouse' && activeTool) overlay.shareTouchCursor(pos.x, pos.y, BRUSH_CURSOR_RADIUS[activeTool] ?? 4);
    }
  }, [isDrawing, activeTool, getPointerPosition]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    // Block native events if we were handling a pinch or drawing
    if (pinchRef.current || activeTool) {
      e.nativeEvent.stopImmediatePropagation();
    }
    activePointers.current.delete(e.pointerId);
    // finger lifted: others stop seeing our ring (mouse users keep theirs while hovering)
    if (e.pointerType !== 'mouse') drawingOverlayRef.current?.shareCursorHide();

    // Start inertia when releasing from pinch gesture (matches Mapillary's DragPanHandler)
    if (activePointers.current.size < 2 && pinchRef.current) {
      const pinch = pinchRef.current;
      pinchRef.current = null;

      // Re-deactivate pointer component if a tool is active (pinch touch events
      // may have leaked to viewer before stopImmediatePropagation kicked in)
      if (viewerRef.current && activeTool) {
        viewerRef.current.deactivateComponent('pointer');
      }

      // Average recent moves from last 50ms buffer (like Mapillary's _drainBuffer)
      const buf = pinch.moveBuffer;
      const now = Date.now();
      const recent = buf.filter(m => now - m.time <= 50);
      if (viewerRef.current && recent.length > 0) {
        let avgDx = 0, avgDy = 0;
        for (const m of recent) { avgDx += m.dx; avgDy += m.dy; }
        avgDx /= recent.length;
        avgDy /= recent.length;

        // Decay per frame: 0.86 (Mapillary's _rotationAcceleration)
        const decay = 0.86;
        const threshold = 1e-5;
        let velX = avgDx;
        let velY = avgDy;

        const tick = () => {
          if (!viewerRef.current) return;
          velX *= decay;
          velY *= decay;
          if (Math.abs(velX) < threshold && Math.abs(velY) < threshold) {
            inertiaRef.current = null;
            return;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (viewerRef.current as any)._navigator.stateService.rotateBasicUnbounded([velX, velY]);
          inertiaRef.current = requestAnimationFrame(tick);
        };
        inertiaRef.current = requestAnimationFrame(tick);
      }
    }

    if (activePointers.current.size === 0) {
      if (containerRef.current) {
        containerRef.current.style.cursor = '';
        containerRef.current.classList.remove('panning');
      }
      // End right-click pan with inertia (same as pinch)
      if (rightClickPanRef.current) {
        const buf = rightClickPanRef.current.moveBuffer;
        const now = Date.now();
        const recent = buf.filter(m => now - m.time <= 50);
        rightClickPanRef.current = null;
        if (viewerRef.current && recent.length > 0) {
          let avgDx = 0, avgDy = 0;
          for (const m of recent) { avgDx += m.dx; avgDy += m.dy; }
          avgDx /= recent.length;
          avgDy /= recent.length;
          const decay = 0.86;
          const threshold = 1e-5;
          let velX = avgDx, velY = avgDy;
          const tick = () => {
            if (!viewerRef.current) return;
            velX *= decay;
            velY *= decay;
            if (Math.abs(velX) < threshold && Math.abs(velY) < threshold) {
              inertiaRef.current = null;
              return;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (viewerRef.current as any)._navigator.stateService.rotateBasicUnbounded([velX, velY]);
            inertiaRef.current = requestAnimationFrame(tick);
          };
          inertiaRef.current = requestAnimationFrame(tick);
        }
      }
    }

    // Don't process stroke end if multi-touch was active (stroke already ended)
    if (activePointers.current.size > 0) return;

    // Clear any pending touch stroke that never started
    pendingTouchStrokeRef.current = null;

    if (!isDrawingRef.current && activeTool !== 'eraser') {
      // No active stroke (was cancelled by multi-touch or never started)
      return;
    }

    setIsDrawing(false);
    isDrawingRef.current = false;

    if (activeTool === 'eraser' && drawingOverlayRef.current) {
      drawingOverlayRef.current.finalizeEraser();
      refreshUndoRedo();
      if (e.pointerType !== 'mouse') drawingOverlayRef.current.shareCursorHide();
    }

    if (activeTool !== 'eraser') void drawingOverlayRef.current?.endStroke();

    // Delayed refresh: textures finalize async after endStroke
    setTimeout(() => refreshUndoRedo(), 600);
  }, [activeTool, refreshUndoRedo]);

  // Show grab cursor when Shift is held while a tool is active
  useEffect(() => {
    if (!activeTool) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift' && containerRef.current) {
        containerRef.current.style.cursor = 'grab';
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift' && containerRef.current) {
        containerRef.current.style.cursor = '';
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [activeTool]);

  // Wheel / trackpad: two-finger swipe looks around, pinch zooms, a mouse wheel zooms.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let currentZoom = 0;
    let zoomInitialized = false;
    let fov = 90;
    // One decision per gesture: a fast two-finger flick sends big whole-number steps that look
    // like a mouse wheel, so judging every event alone made fast swipes zoom mid-pan. Once a
    // gesture looks like a trackpad it stays a pan until the wheel events pause.
    let gesture: 'trackpad' | 'wheel' | null = null;
    let lastWheelAt = 0;
    const onWheel = (e: WheelEvent) => {
      if (!viewerRef.current) return;
      e.preventDefault();
      const viewer = viewerRef.current;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = (viewer as any)._navigator.stateService;
      const now = performance.now();
      if (now - lastWheelAt > 220) gesture = null;
      lastWheelAt = now;
      // Trackpad scrolls are pixel-mode with small/fractional deltas or a horizontal component;
      // Chrome/Safari also report trackpads with wheelDelta exactly -3x delta (a mouse notch is
      // ±120). Mouse wheels send larger whole-number vertical steps. Pinch = wheel + ctrlKey.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const legacy = e as any;
      const looksTrackpad = e.deltaMode === 0 && (
        e.deltaX !== 0 || !Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 40 ||
        (typeof legacy.wheelDeltaY === 'number' && legacy.wheelDeltaY !== 0 && legacy.wheelDeltaY === -3 * e.deltaY));
      if (!e.ctrlKey) {
        if (gesture === null) gesture = looksTrackpad ? 'trackpad' : 'wheel';
        else if (gesture === 'wheel' && looksTrackpad) gesture = 'trackpad'; // a wheel never sends these
      }
      const isTrackpadScroll = !e.ctrlKey && gesture === 'trackpad';
      if (isTrackpadScroll) {
        // brush outline stays pinned to its spot in the scene while the camera turns
        viewer.getFieldOfView().then((f) => { fov = f; });
        // same feel as dragging: fingers move left -> scene follows -> camera turns right
        const vw = container.clientWidth || window.innerWidth;
        const vh = container.clientHeight || window.innerHeight;
        const hFov = fov * (vw / vh);
        const movX = (e.deltaX / vw) * (hFov / 360) * 1.25;
        const movY = (e.deltaY / vh) * (fov / 180) * 1.25;
        svc.rotateBasicUnbounded([movX, movY]);
        return;
      }
      if (!zoomInitialized) {
        zoomInitialized = true;
        viewer.getZoom().then(z => { currentZoom = z; });
        return;
      }
      // pinch deltas are small -> scale them up so pinch-zoom feels natural
      const delta = -e.deltaY * (e.ctrlKey ? 0.01 : 0.002);
      currentZoom = Math.max(0, Math.min(3, currentZoom + delta));
      svc.setZoom(currentZoom);
    };
    container.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => container.removeEventListener('wheel', onWheel, { capture: true });
  }, []);

  return (
    <div className={`app${DARK_UI ? ' app--dark' : ''}`}>
      <div
        ref={containerRef}
        className={`viewer-container ${activeTool ? 'drawing-active' : ''} ${activeTool === 'eraser' ? 'tool-eraser' : ''} ${isLoaded ? 'loaded' : ''}`}
        style={{
          backgroundImage: `url(${panoramaLoadingPreviewUrl(panorama)}), url(${thumbBg || panoramaPreview})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
        onPointerDownCapture={handlePointerDown}
        onPointerMoveCapture={handlePointerMove}
        onPointerUpCapture={handlePointerUp}
        onPointerLeave={(e) => {
          drawingOverlayRef.current?.hideBrushCursor();
          handlePointerUp(e);
        }}
      />
      {/* Credit for non-CC0 photos: the shortest complete form, like a map's © line. The name links
          to the source page, the license name to the exact license version; that the photo was
          changed (resized, drawn on) is stated in the hover text and screen-reader label. */}
      {panorama.license !== 'CC0-1.0' && <aside className="panorama-credit" aria-label={`Photo by ${panorama.author}, edited, ${panorama.license}`}>
        <a href={panorama.sourceUrl} target="_blank" rel="noreferrer" title="Original photo (this one is resized and drawn on)">© {panorama.author}</a>
        <a href={panorama.licenseUrl} target="_blank" rel="noreferrer" title={panorama.license}>{panorama.license.replace(/[\s-]\d[\d.]*$/, '')}</a>
      </aside>}
      {viewerError && <div className="panorama-error" role="alert"><p>{viewerError}</p><button onClick={() => window.location.reload()}>Try again</button><Link to="/">Choose a place</Link></div>}
      {/* First-time tutorial overlay */}
      {/* Looking around works as soon as the photo is up — don't wait for drawings / depth data. */}
      {showTutorial && isLoaded && (
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
            opacity: tutorialFading ? 0 : 1,
            transition: 'opacity 0.4s ease',
            pointerEvents: 'none',
          }}
        >
          {'ontouchstart' in window ? (
            <>
              <img src={touchAndScroll} alt="" width="166" height="166" style={{ filter: 'invert(1)', opacity: 0.9 }} />
              <p style={{ color: 'white', fontSize: '18px', fontWeight: 600, marginTop: '16px', textAlign: 'center', lineHeight: 1.5 }}>
                Use two fingers to look around
              </p>
            </>
          ) : (
            <>
              <img src={mouseRightClick} alt="" width="200" height="200" style={{ filter: 'invert(1)', opacity: 0.9 }} />
              <p style={{ color: 'white', fontSize: '18px', fontWeight: 600, marginTop: '16px', textAlign: 'center', lineHeight: 1.5 }}>
                Right-click and drag to look around
              </p>
            </>
          )}
        </div>
      )}

      {/* Show controls immediately; drawing waits until the viewer and artwork are ready. */}
      <div style={{
        pointerEvents: (!isLoaded || isStrokesLoading || showTutorial) ? 'none' : 'auto',
      }}>

        {/* Undo / Redo Buttons (on desktop they sit inside the top of the tool panel, see App.css) */}
        <div
          className="undo-redo"
          style={{
            position: 'absolute',
            top: 'calc(20px + env(safe-area-inset-top, 0px))',
            left: 'calc(14px + env(safe-area-inset-left, 0px))',
            display: 'flex',
            alignItems: 'center',
            gap: 0,
            // Sits on top of the left sidebar: plain icons, rounded highlight on hover only
            zIndex: 21,
          }}
        >
          <button
            aria-label="Undo"
            onClick={() => { drawingOverlayRef.current?.undo(); refreshUndoRedo(); }}
            disabled={!undoAvailable}
            className="sidebar-icon-btn"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '40px',
              height: '38px',
              border: 'none',
              cursor: undoAvailable ? 'pointer' : 'default',
              opacity: undoAvailable ? 1 : 0.3,
              transition: 'opacity 0.2s ease',
              padding: 0,
              color: DARK_UI ? '#fff' : '#1c1c1e',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
            </svg>
          </button>
          <button
            aria-label="Redo"
            onClick={() => { drawingOverlayRef.current?.redo(); refreshUndoRedo(); }}
            disabled={!redoAvailable}
            className="sidebar-icon-btn"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '40px',
              height: '38px',
              border: 'none',
              cursor: redoAvailable ? 'pointer' : 'default',
              opacity: redoAvailable ? 1 : 0.3,
              transition: 'opacity 0.2s ease',
              padding: 0,
              color: DARK_UI ? '#fff' : '#1c1c1e',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 14 5-5-5-5" />
              <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13" />
            </svg>
          </button>
        </div>

        {/* Close (X) Button */}
        <button
          className="view-close"
          onClick={handleBack}
          aria-label="Close"
          title="Close"
          style={{
            pointerEvents: 'auto',
            position: 'absolute',
            top: 'calc(20px + env(safe-area-inset-top, 0px))',
            right: 'calc(20px + env(safe-area-inset-right, 0px))',
            width: '40px',
            height: '40px',
            padding: 0,
            // Same frosted, slightly see-through grey + hairline + soft shadow as the left sidebar
            background: DARK_UI ? 'rgba(30, 31, 29, 0.76)' : 'rgba(226, 226, 231, 0.78)',
            backdropFilter: DARK_UI ? 'blur(30px) saturate(1.5)' : 'blur(18px) saturate(1.3)',
            WebkitBackdropFilter: DARK_UI ? 'blur(30px) saturate(1.5)' : 'blur(18px) saturate(1.3)',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: DARK_UI ? '#fff' : '#1c1c1e',
            boxShadow: DARK_UI ? '0 0 0 0.5px rgba(255,255,255,0.1), 0 6px 20px rgba(0,0,0,0.25)' : '0 0 0 0.5px rgba(0,0,0,0.1), 0 6px 20px rgba(0,0,0,0.08)',
            zIndex: 20,
            border: 'none',
            cursor: 'pointer',
            transition: 'transform 0.2s ease',
          }}
          onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.04)'}
          onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
        >
          <CloseIcon />
        </button>


        {/* iOS-inspired Bottom Toolbar */}
        <div ref={toolbarRef} className="toolbar">
          {/* Back/Forward Buttons + Pens */}
          <div
            ref={navPenGroupRef}
            className="nav-pen-group"
            style={{
              maskImage: penScrollMask === 'both'
                ? 'linear-gradient(to right, transparent, black 40px, black calc(100% - 40px), transparent)'
                : penScrollMask === 'left'
                ? 'linear-gradient(to right, transparent, black 40px)'
                : penScrollMask === 'right'
                ? 'linear-gradient(to right, black calc(100% - 40px), transparent)'
                : 'none',
              WebkitMaskImage: penScrollMask === 'both'
                ? 'linear-gradient(to right, transparent, black 40px, black calc(100% - 40px), transparent)'
                : penScrollMask === 'left'
                ? 'linear-gradient(to right, transparent, black 40px)'
                : penScrollMask === 'right'
                ? 'linear-gradient(to right, black calc(100% - 40px), transparent)'
                : 'none',
            }}
          >
            {/* Pencil & Marker Tool Selector */}
            <div className="pen-container">
              <button
                className={`pen-btn pencil ${activeTool === 'pencil' ? 'active' : ''}`}
                aria-label="Pencil"
                onClick={() => setActiveTool('pencil')}
              >
                <svg className="pen-tip" viewBox="36 0 66 390" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <mask id="pencil-tip-mask" style={{ maskType: 'alpha' } as React.CSSProperties}>
                      <image href="/tools/pencil-tip.png" x="0" y="0" width="138" height="390" />
                    </mask>
                  </defs>
                  <image href={toolBase('pencil')} x="0" y="0" width="138" height="390" />
                  <rect x="0" y="0" width="138" height="390" fill={pencilColor} mask="url(#pencil-tip-mask)" />
                  <image href="/tools/pencil-tip-contour.png" x="0" y="0" width="138" height="390" />
                </svg>
              </button>
              <button
                className={`pen-btn marker ${activeTool === 'marker' ? 'active' : ''}`}
                aria-label="Marker"
                onClick={() => setActiveTool('marker')}
              >
                <svg className="pen-tip" viewBox="36 0 66 390" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <mask id="marker-tip-mask" style={{ maskType: 'alpha' } as React.CSSProperties}>
                      <image href="/tools/marker-tip.png" x="0" y="0" width="138" height="390" />
                    </mask>
                  </defs>
                  <image href={toolBase('marker')} x="0" y="0" width="138" height="390" />
                  <rect x="0" y="0" width="138" height="390" fill={markerColor} mask="url(#marker-tip-mask)" />
                  <image href="/tools/marker-tip-contour.png" x="0" y="0" width="138" height="390" />
                </svg>
              </button>
              <button
                className={`pen-btn eraser ${activeTool === 'eraser' ? 'active' : ''}`}
                aria-label="Eraser"
                onClick={() => setActiveTool('eraser')}
              >
                {DARK_UI ? (
                  <svg className="pen-tip" viewBox="36 0 66 390" xmlns="http://www.w3.org/2000/svg">
                    <image href={toolBase('eraser')} x="0" y="0" width="138" height="390" />
                  </svg>
                ) : (
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
                    <path d="M13.779,21.464 C13.399,21.084 12.782,21.084 12.401,21.464 L10.261,23.604 L8.213,21.555 C7.822,21.165 7.189,21.165 6.799,21.555 C6.408,21.946 6.408,22.579 6.799,22.969 L8.847,25.018 L6.708,27.158 C6.328,27.538 6.328,28.155 6.708,28.536 C7.089,28.916 7.705,28.916 8.086,28.536 L10.225,26.396 L12.274,28.445 C12.665,28.835 13.298,28.835 13.688,28.445 C14.079,28.054 14.079,27.421 13.688,27.031 L11.64,24.982 L13.779,22.842 C14.16,22.462 14.16,21.845 13.779,21.464 Z" fill={activeTool === 'eraser' ? '#FF3B30' : 'url(#eraser-body)'} style={{ transition: 'fill 0.2s ease' }} />
                  </g>
                </svg>
                )}
              </button>
              <button
                className={`pen-btn crayon ${activeTool === 'crayon' ? 'active' : ''}`}
                onClick={() => setActiveTool('crayon')}
              >
                <svg className="pen-tip" viewBox="36 0 66 390" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <mask id="crayon-tip-mask" style={{ maskType: 'alpha' } as React.CSSProperties}>
                      <image href="/tools/crayon-tip.png" x="0" y="0" width="138" height="390" />
                    </mask>
                  </defs>
                  <image href={toolBase('crayon')} x="0" y="0" width="138" height="390" />
                  <rect x="0" y="0" width="138" height="390" fill={crayonColor} mask="url(#crayon-tip-mask)" />
                  <image href="/tools/crayon-tip-contour.png" x="0" y="0" width="138" height="390" />
                </svg>
              </button>
              <button
                className={`pen-btn fountainPen ${activeTool === 'fountainPen' ? 'active' : ''}`}
                onClick={() => setActiveTool('fountainPen')}
              >
                <svg className="pen-tip" viewBox="36 0 66 318" xmlns="http://www.w3.org/2000/svg">
                  <image href={toolBase('fountainpen')} x="0" y="0" width="138" height="318" />
                  <rect x="36" y="165" width="66" height="7" fill={fountainPenColor} />
                </svg>
              </button>
              <button
                className={`pen-btn watercolor ${activeTool === 'watercolor' ? 'active' : ''}`}
                onClick={() => setActiveTool('watercolor')}
              >
                <svg className="pen-tip" viewBox="36 0 66 318" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <mask id="watercolor-tip-mask" style={{ maskType: 'alpha' } as React.CSSProperties}>
                      <image href="/tools/watercolor-tip.png" x="0" y="0" width="138" height="318" />
                    </mask>
                  </defs>
                  <image href={toolBase('watercolor')} x="0" y="0" width="138" height="318" />
                  <rect x="0" y="0" width="138" height="318" fill={watercolorColor} mask="url(#watercolor-tip-mask)" />
                  <image href="/tools/watercolor-tip-contour.png" x="0" y="0" width="138" height="318" />
                </svg>
              </button>
            </div>
          </div>

          {/* Color Picker Grid */}
          <div className="tool-group" style={{ alignSelf: 'flex-end', marginBottom: -6 }}>
            <div className={`color-grid ${activeTool === 'pencil' || activeTool === 'marker' || activeTool === 'crayon' || activeTool === 'fountainPen' || activeTool === 'watercolor' ? '' : 'disabled'}`}>
              {/* Single colour swatch: rainbow ring around the current tool's colour; opens the picker */}
              <label
                className="color-option color-picker-swatch"
                style={{ '--picked': isHexColor(selectedColor) ? selectedColor : '#FF9500' } as React.CSSProperties}
                title="Choose colour"
              >
                <input
                  type="color"
                  value={(isHexColor(selectedColor) ? selectedColor : '#FF9500').toLowerCase()}
                  disabled={activeTool === 'eraser'}
                  onChange={(e) => setSelectedColor(e.target.value.toUpperCase())}
                />
              </label>
            </div>
          </div>

        </div>{/* end toolbar */}


      </div>{/* end drawing UI */}

      {/* Loading Spinner Overlay */}
      {showLoadingSpinner && !isLoaded && !viewerError && <div className="loading-overlay" role="status" aria-label="Loading panorama">
        <div className="spinner">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="spinner-blade" style={{ '--i': i } as React.CSSProperties} />
          ))}
        </div>
      </div>}

    </div>
  );
}

export default function PanoramaRoute() {
  const [params] = useSearchParams();
  const panorama = PANORAMA_BY_ID.get(params.get('imageId') || DEFAULT_PANORAMA.id);
  const visitedId = panorama?.id;
  useEffect(() => { if (visitedId) recordVisit(visitedId); }, [visitedId]);
  if (!panorama) return <div className="panorama-unavailable"><h1>This place isn’t in the current collection.</h1><Link to="/">Explore places to draw</Link></div>;
  return <App key={panorama.id} panorama={panorama} />;
}
