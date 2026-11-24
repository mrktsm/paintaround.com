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
import { fetchInkLevel, saveInkLevel, deviceId } from './inkManager';
import { supabase } from './supabaseClient';
import { createCheckoutSession, DEFAULT_TIER } from './subscriptionManager';
import type { PlusTier } from './subscriptionManager';
import { PiDropSlashFill } from 'react-icons/pi';
import { DEFAULT_PANORAMA, PANORAMA_BY_ID, hasCoordinates, type Panorama } from './pool/catalog';
import { PanoramaDataProvider } from './pool/PanoramaDataProvider';
import { panoramaLoadingPreviewUrl } from './pool/panoramaImages';
import { recordVisit } from './pool/visited';
import { showOwnDrawing } from './pool/localPreview';
import { DARK_UI } from './theme';

/** PencilKit tool body for the current appearance (tips/bands are shared). */
/** Double-click / long-press on a drawing to star or report it. Off for now. */
const STROKE_ACTIONS = false;

const toolBase = (name: string) => `/tools/${name}-base${DARK_UI ? '-dark' : ''}.png`;
import { loadDeepData } from './deep/surfaceDecal';
import CloseIcon from './components/CloseIcon';
import { START_ZOOM } from './pool/startView';

/** No accounts: admin powers (unlimited ink, delete any drawing) exist only when running locally. */
const IS_ADMIN = import.meta.env.DEV;

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
  const [searchParams] = useSearchParams();
  const [pencilColor, setPencilColor] = useState(() => {
    const saved = localStorage.getItem('pencilColor');
    if (isHexColor(saved)) return saved;
    const pool = COLORS.filter(c => c !== 'rainbow');
    return pool[Math.floor(Math.random() * pool.length)];
  });
  const [markerColor, setMarkerColor] = useState(() => {
    const saved = localStorage.getItem('markerColor');
    if (isHexColor(saved)) return saved;
    const pool = COLORS.filter(c => c !== 'rainbow');
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
    const pool = COLORS.filter(c => c !== 'rainbow');
    let color = pool[Math.floor(Math.random() * pool.length)];
    while ((color === pencilColor || color === markerColor) && pool.length > 2) {
      color = pool[Math.floor(Math.random() * pool.length)];
    }
    return color;
  });
  const [fountainPenColor, setFountainPenColor] = useState(() => {
    const saved = localStorage.getItem('fountainPenColor');
    if (isHexColor(saved)) return saved;
    const pool = COLORS.filter(c => c !== 'rainbow');
    let color = pool[Math.floor(Math.random() * pool.length)];
    while ((color === pencilColor || color === markerColor || color === crayonColor) && pool.length > 3) {
      color = pool[Math.floor(Math.random() * pool.length)];
    }
    return color;
  });
  const [watercolorColor, setWatercolorColor] = useState(() => {
    const saved = localStorage.getItem('watercolorColor');
    if (isHexColor(saved)) return saved;
    const pool = COLORS.filter(c => c !== 'rainbow');
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
  const [reportTarget, setReportTarget] = useState<{ strokeIds: string[], basicCoord: [number, number], authorDeviceId?: string } | null>(null);
  const [reportStatus, setReportStatus] = useState<'idle' | 'sending' | 'done'>('idle');
  const [reportBtnPos, setReportBtnPos] = useState<{ x: number, y: number, visible: boolean }>({ x: 0, y: 0, visible: false });
  const [reportBtnMounted, setReportBtnMounted] = useState(false);
  const [reportBtnShow, setReportBtnShow] = useState(false);
  const [isLiked, setIsLiked] = useState(false);
  const [likeStatus, setLikeStatus] = useState<'idle' | 'toggling'>('idle');
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
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressPosRef = useRef<{ x: number; y: number } | null>(null);
  const [drawingHint, setDrawingHint] = useState<{ x: number; y: number; basicCoord: [number, number] } | null>(null);
  const [drawingHintShow, setDrawingHintShow] = useState(false);
  const drawingHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [strokesLoadedCount, setStrokesLoadedCount] = useState(0);
  const [hasMovedView, setHasMovedView] = useState(false);

  const lng = hasCoordinates(panorama) ? String(panorama.longitude) : null;
  const lat = hasCoordinates(panorama) ? String(panorama.latitude) : null;
  const camLng = searchParams.get('camLng');
  const camLat = searchParams.get('camLat');
  const zoom = searchParams.get('zoom');
  const pitch = searchParams.get('pitch');
  const bearing = searchParams.get('bearing');
  const imageId = panorama.id;

  // Ink Logic
  // Ink limit removed: drawing costs nothing, so ink never depletes.
  const INK_COST_PER_PIXEL = 0;
  const INK_COST_PER_STROKE = 0;
  const INK_REGEN_RATE = 0.000307; // ~1.5 hr full regen at 60fps

  const INK_RECOVER_THRESHOLD = 15; // Must regen to this before drawing is unlocked

  const [inkLevel, setInkLevel] = useState(100);
  const [inkPillVisible, setInkPillVisible] = useState(false);
  const [inkPillCollapsed, setInkPillCollapsed] = useState(false);
  const inkPillTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [inkToastVisible, setInkToastVisible] = useState(false);
  const inkToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inkToastShownRef = useRef(false); // Only show once per depletion cycle
  const [inkPulsing, setInkPulsing] = useState(false);
  const inkLevelRef = useRef(100); // Mutable ref for instant access
  const inkDepletedRef = useRef(false); // Locked until ink recovers to threshold
  const inkBeforeStrokeRef = useRef(100); // Snapshot to fully restore on multi-touch cancel
  const inkFillRef = useRef<HTMLDivElement>(null); // Ref for visual update
  const lastSaveTime = useRef(0);
  const inkLoaded = useRef(false); // Gate saves until initial fetch completes
  const tierRef = useRef<PlusTier>(DEFAULT_TIER);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const navPenGroupRef = useRef<HTMLDivElement>(null);
  const [penScrollMask, setPenScrollMask] = useState<'none' | 'right' | 'left' | 'both'>('none');
  const [showPlusSheet, setShowPlusSheet] = useState(false);
  const [isPlusSheetClosing, setIsPlusSheetClosing] = useState(false);
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

  // Ink is per device (no accounts): load it once
  useEffect(() => {
    fetchInkLevel(undefined, tierRef.current.maxInk).then(level => {
      setInkLevel(level);
      inkLevelRef.current = level;
      inkLoaded.current = true;
      if (level >= INK_RECOVER_THRESHOLD) inkDepletedRef.current = false;
      updateInkVisuals();
    });

    // Save ink when page closes
    const handleBeforeUnload = () => {
      if (inkLoaded.current) {
        saveInkLevel(inkLevelRef.current, undefined);
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // Save ink to backend (debounced — max once every 5s, only after initial load)
  useEffect(() => {
    if (!inkLoaded.current) return;
    const now = Date.now();
    if (now - lastSaveTime.current < 5000) return;
    lastSaveTime.current = now;
    saveInkLevel(inkLevel, undefined);
  }, [inkLevel]);

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
  const lastInkPos = useRef<{ x: number, y: number } | null>(null);
  const selectedColorRef = useRef(selectedColor);

  // Shared rainbow hue — drives tools, ink bar, and drawn strokes from one clock
  const [rainbowHue, setRainbowHue] = useState(0);
  useEffect(() => {
    let rafId: number;
    const tick = () => {
      setRainbowHue((Date.now() / 20) % 360);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);
  const rainbowColor = `hsl(${rainbowHue}, 90%, 55%)`;

  // Keep ref in sync & persist colors
  useEffect(() => {
    selectedColorRef.current = selectedColor;
    updateInkVisuals();
  }, [selectedColor, pencilColor, markerColor, crayonColor, fountainPenColor, watercolorColor, activeTool]);

  useEffect(() => { localStorage.setItem('pencilColor', pencilColor); }, [pencilColor]);
  useEffect(() => { localStorage.setItem('markerColor', markerColor); }, [markerColor]);
  useEffect(() => { localStorage.setItem('crayonColor', crayonColor); }, [crayonColor]);
  useEffect(() => { localStorage.setItem('fountainPenColor', fountainPenColor); }, [fountainPenColor]);
  useEffect(() => { localStorage.setItem('watercolorColor', watercolorColor); }, [watercolorColor]);

  // Update visual pill immediately
  const updateInkVisuals = () => {
    if (inkFillRef.current) {
      inkFillRef.current.style.height = `${(inkLevelRef.current / tierRef.current.maxInk) * 100}%`;
      const inkPercent = (inkLevelRef.current / tierRef.current.maxInk) * 100;
      if (inkPercent < 20) {
        inkFillRef.current.classList.remove('ink-fill-rainbow');
        inkFillRef.current.style.background = '#ff3b30';
        inkFillRef.current.style.boxShadow = '0 0 10px #ff3b3080';
      } else if (selectedColorRef.current === 'rainbow') {
        // Rainbow ink bar is now driven by JS inline styles, not CSS animation
        inkFillRef.current.classList.remove('ink-fill-rainbow');
        // background/boxShadow set inline in JSX via rainbowColor
      } else {
        inkFillRef.current.classList.remove('ink-fill-rainbow');
        inkFillRef.current.style.background = selectedColorRef.current;
        inkFillRef.current.style.boxShadow = `0 0 10px ${selectedColorRef.current}80`;
      }
    }
  };

  const showInkToast = useCallback(() => {
    if (inkToastShownRef.current) return;
    inkToastShownRef.current = true;
    setInkToastVisible(true);
    if (inkToastTimerRef.current) clearTimeout(inkToastTimerRef.current);
    inkToastTimerRef.current = setTimeout(() => setInkToastVisible(false), 4000);
  }, []);

  // Compute human-readable regen time remaining
  const getRegenTimeString = useCallback(() => {
    const maxInk = tierRef.current.maxInk;
    const remaining = maxInk - inkLevelRef.current;
    if (remaining <= 0) return 'Full';
    // INK_REGEN_RATE is per frame at 60fps
    const framesNeeded = remaining / (INK_REGEN_RATE * tierRef.current.regenMultiplier);
    const seconds = framesNeeded / 60;
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (mins === 0) return `${hours}h`;
    return `${hours}h ${mins}m`;
  }, []);

  // Sync state with ref for regeneration and initial load
  // We don't need updateInkVisuals here as the color effect handles it,
  // but we do need to sync inkLevelRef if state changes externally (unlikely now)
  useEffect(() => {
    inkLevelRef.current = inkLevel;
  }, [inkLevel]);

  // Show ink pill when drawing, hide after delay when stopped
  useEffect(() => {
    if (inkPillTimerRef.current) {
      clearTimeout(inkPillTimerRef.current);
      inkPillTimerRef.current = null;
    }
    if (isDrawing) {
      setInkPillVisible(true);
      setInkPillCollapsed(true);
    } else if (inkPillVisible) {
      inkPillTimerRef.current = setTimeout(() => setInkPillVisible(false), 3000);
    }
  }, [isDrawing]);

  // Regenerate ink loop
  useEffect(() => {
    let animationFrameId: number;
    let frameCount = 0;
    const regenerate = () => {
      const maxInk = tierRef.current.maxInk;
      if (!isDrawing && inkLevelRef.current < maxInk) {
        inkLevelRef.current = Math.min(inkLevelRef.current + INK_REGEN_RATE * tierRef.current.regenMultiplier, maxInk);
        if (inkDepletedRef.current && inkLevelRef.current >= INK_RECOVER_THRESHOLD) {
          inkDepletedRef.current = false;
          inkToastShownRef.current = false; // Allow toast again on next depletion
          setInkPulsing(false);
        }
        updateInkVisuals();
        // Only sync React state periodically to avoid re-render choppiness
        frameCount++;
        if (frameCount % 10 === 0 || inkLevelRef.current >= maxInk) {
          setInkLevel(inkLevelRef.current);
        }
      }
      animationFrameId = requestAnimationFrame(regenerate);
    };
    animationFrameId = requestAnimationFrame(regenerate);
    return () => cancelAnimationFrame(animationFrameId);
  }, [isDrawing]);

  const handleBack = async () => {
    // Save ink before leaving
    saveInkLevel(inkLevelRef.current, undefined);

    // Fade out drawing strokes before leaving
    if (drawingOverlayRef.current) {
      if (isDrawingRef.current) void drawingOverlayRef.current.endStroke();
      showOwnDrawing(panorama, drawingOverlayRef.current);
      drawingOverlayRef.current.leaveRealtime();
      drawingOverlayRef.current.fadeOut();
    }

    // Animate viewer to initial position (bearing) before zooming out
    if (viewerRef.current) {
      const viewer = viewerRef.current;
      const targetBearing = parseFloat(bearing || '0');
      const targetPitch = 0; // Reset pitch to horizon

      // In MapillaryJS v4, getBearing/getPitch return Promises
      try {
        // @ts-ignore
        const currentBearing = await (typeof viewer.getBearing === 'function' ? viewer.getBearing() : Promise.resolve(0));
        // @ts-ignore
        const currentPitch = await (typeof viewer.getPitch === 'function' ? viewer.getPitch() : Promise.resolve(0));

        const startBearing = currentBearing;
        const startPitch = currentPitch;

        const startTime = performance.now();
        const duration = 400; // ms

        // Only animate if methods exist and we are far enough
        // @ts-ignore
        if (typeof viewer.setBearing === 'function' &&
          (Math.abs(startBearing - targetBearing) > 2 || Math.abs(startPitch - targetPitch) > 2)) {

          await new Promise<void>(resolve => {
            const animate = (currentTime: number) => {
              const elapsed = currentTime - startTime;
              const t = Math.min(elapsed / duration, 1);
              const ease = 1 - Math.pow(1 - t, 3);

              const nowBearing = startBearing + (targetBearing - startBearing) * ease;
              const nowPitch = startPitch + (targetPitch - startPitch) * ease;

              // @ts-ignore
              viewer.setBearing(nowBearing);
              // @ts-ignore
              viewer.setPitch(nowPitch);

              if (t < 1) {
                requestAnimationFrame(animate);
              } else {
                resolve();
              }
            };
            requestAnimationFrame(animate);
          });
        }
      } catch (e) {
        console.warn('Rotation animation failed', e);
      }
    }

    // Store collapse animation state for Heatmap to pick up
    // Use marker lng/lat so Heatmap can project to accurate screen coords after map loads
    if (lng && lat) {
      sessionStorage.setItem('collapseAnimation', JSON.stringify({
        markerLng: parseFloat(lng),
        markerLat: parseFloat(lat),
        thumbUrl: thumbBg || '',
        imageId: imageId || '',
      }));
    }

    // Navigate immediately — Heatmap shows the shrinking circle over the real map
    let params = '';
    if (lng && lat) {
      params = `?lng=${lng}&lat=${lat}`;
      if (camLng !== null) {
        params += `&camLng=${camLng}&camLat=${camLat}&zoom=${zoom}&pitch=${pitch}&bearing=${bearing}`;
      }
      if (imageId) {
        params += `&imageId=${imageId}`;
      }
      if (thumbBg) {
        params += `&thumbUrl=${encodeURIComponent(thumbBg)}`;
      }
    }
    navigate('/' + params);
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
          setStrokesLoadedCount(c => c + 1);
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
    if (activeTool && activeTool !== 'eraser') { // pencil, marker, crayon
      // Sync ink level and visuals when selecting a drawing tool
      setInkLevel(inkLevelRef.current);
      updateInkVisuals();
      // Only expand to full pill if it's not currently visible (was hidden)
      if (!inkPillVisible) {
        setInkPillCollapsed(false);
      }
      setInkPillVisible(true);
      if (inkPillTimerRef.current) clearTimeout(inkPillTimerRef.current);
      inkPillTimerRef.current = setTimeout(() => {
        setInkPillVisible(false);
        setTimeout(() => setInkPillCollapsed(false), 300);
      }, 3000);
    } else if (activeTool === 'eraser') {
      // Eraser doesn't use ink — hide pill and reset collapsed state
      setInkPillVisible(false);
      setInkPillCollapsed(false);
      if (inkPillTimerRef.current) clearTimeout(inkPillTimerRef.current);
    } else if (!activeTool) {
      // Tool deselected — hide pill, reset collapsed after fade-out
      setInkPillVisible(false);
      setTimeout(() => setInkPillCollapsed(false), 300);
    }
    if (!viewerRef.current) return;
    if (activeTool) {
      viewerRef.current.deactivateComponent('pointer');
    } else {
      viewerRef.current.activateComponent('pointer');
    }
  }, [activeTool]);

  // Hit-test a screen position and select/deselect the stroke under it
  const doHitTest = useCallback((posX: number, posY: number) => {
    if (!drawingOverlayRef.current) return;
    drawingOverlayRef.current.hitTestAt(posX, posY).then(async hit => {
      if (hit && drawingOverlayRef.current && viewerRef.current) {
        const { strokeIds, authorDeviceId } = drawingOverlayRef.current.selectStroke(hit);
        const basic = await viewerRef.current.unprojectToBasic([posX, posY]);
        if (basic) {
          setReportTarget({ strokeIds, basicCoord: [basic[0], basic[1]], authorDeviceId });
          setReportStatus('idle');
          // Check like status for this drawing (location + author)
          const currentImageId = drawingOverlayRef.current.getImageId();
          if (currentImageId && authorDeviceId) {
            supabase.from('likes').select('id').eq('image_id', currentImageId).eq('device_id', deviceId).eq('author_device_id', authorDeviceId).maybeSingle().then(({ data }) => {
              setIsLiked(!!data);
            });
          }
        }
      } else {
        drawingOverlayRef.current?.clearSelection();
        setReportTarget(null);
      }
    });
  }, []);

  // Start a long-press timer at the given screen position
  const startLongPress = useCallback((posX: number, posY: number) => {
    if (!STROKE_ACTIONS) return;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressPosRef.current = { x: posX, y: posY };
    longPressTimerRef.current = setTimeout(() => {
      const pos = longPressPosRef.current;
      if (pos) {
        // Cancel pending touch stroke (before drawing started)
        pendingTouchStrokeRef.current = null;
        // Cancel any in-progress stroke (mouse long-press edge case)
        if (isDrawingRef.current && drawingOverlayRef.current) {
          drawingOverlayRef.current.endStroke();
          if (drawingOverlayRef.current.canUndo()) {
            drawingOverlayRef.current.undo();
          }
          setIsDrawing(false);
          isDrawingRef.current = false;
        }
        doHitTest(pos.x, pos.y);
        longPressPosRef.current = null;
      }
    }, 600);
  }, [doHitTest]);

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressPosRef.current = null;
  }, []);

  // Double-click and long-press to select strokes for reporting (when no tool active)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Suppress right-click context menu
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    // Long-press: start timer on pointerdown (only fires when no activeTool,
    // since React capture handlers call stopImmediatePropagation when a tool is active)
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const rect = container.getBoundingClientRect();
      startLongPress(e.clientX - rect.left, e.clientY - rect.top);
    };

    // Cancel long-press if moved too far
    const onMove = (e: PointerEvent) => {
      if (!longPressPosRef.current || !longPressTimerRef.current) return;
      const rect = container.getBoundingClientRect();
      const dx = (e.clientX - rect.left) - longPressPosRef.current.x;
      const dy = (e.clientY - rect.top) - longPressPosRef.current.y;
      if (dx * dx + dy * dy > 400) {
        cancelLongPress();
      }
    };

    const onUp = () => {
      cancelLongPress();
    };

    // Double-click to select strokes for reporting (desktop)
    const onDblClick = (e: MouseEvent) => {
      if (!STROKE_ACTIONS) return;
      const rect = container.getBoundingClientRect();
      doHitTest(e.clientX - rect.left, e.clientY - rect.top);
    };

    container.addEventListener('contextmenu', onContextMenu, { capture: true });
    container.addEventListener('pointerdown', onDown, { capture: true });
    container.addEventListener('pointermove', onMove, { capture: true });
    container.addEventListener('pointerup', onUp, { capture: true });
    container.addEventListener('dblclick', onDblClick, { capture: true });
    return () => {
      container.removeEventListener('contextmenu', onContextMenu, { capture: true });
      container.removeEventListener('pointerdown', onDown, { capture: true });
      container.removeEventListener('pointermove', onMove, { capture: true });
      container.removeEventListener('pointerup', onUp, { capture: true });
      container.removeEventListener('dblclick', onDblClick, { capture: true });
      cancelLongPress();
    };
  }, [doHitTest, startLongPress, cancelLongPress]);

  // Show contextual hint after user has been idle (not moving camera) for a few seconds
  const hintIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintShownRef = useRef(false);
  useEffect(() => {
    // the hint teaches double-click / hold to star or report — only while that's enabled
    if (!STROKE_ACTIONS || strokesLoadedCount === 0 || !hasMovedView || hintShownRef.current) return;
    if (localStorage.getItem('drawingHintSeen')) return;
    // Reset idle timer on any pointer activity
    const resetTimer = () => {
      if (hintIdleTimerRef.current) clearTimeout(hintIdleTimerRef.current);
      hintIdleTimerRef.current = startHintCheck();
    };
    const startHintCheck = () => setTimeout(async () => {
      if (hintShownRef.current) return;
      if (!drawingOverlayRef.current || !viewerRef.current) return;
      const centers = drawingOverlayRef.current.getRemoteDrawingBasicCenters();
      if (centers.length === 0) return;
      // Project all and pick the one closest to screen center
      const screenCenterX = window.innerWidth / 2;
      const screenCenterY = window.innerHeight / 2;
      let best: { x: number; y: number; basicCoord: [number, number]; dist: number } | null = null;
      for (const basicCoord of centers) {
        try {
          const screenPos = await viewerRef.current.projectFromBasic(basicCoord);
          if (!screenPos) continue;
          const rect = containerRef.current?.getBoundingClientRect();
          const x = screenPos[0] + (rect?.left || 0);
          const y = screenPos[1] + (rect?.top || 0);
          if (x < 20 || x > window.innerWidth - 20 || y < 20 || y > window.innerHeight - 20) continue;
          const dist = Math.hypot(x - screenCenterX, y - screenCenterY);
          if (!best || dist < best.dist) {
            best = { x, y, basicCoord, dist };
          }
        } catch {}
      }
      // Only show hint if a drawing is reasonably close to screen center
      if (!best || best.dist > Math.min(window.innerWidth, window.innerHeight) * 0.35) return;
      setDrawingHint({ x: best.x, y: best.y, basicCoord: best.basicCoord });
      requestAnimationFrame(() => setDrawingHintShow(true));
      // Auto-dismiss after 10s
      drawingHintTimerRef.current = setTimeout(() => {
        setDrawingHintShow(false);
        setTimeout(() => setDrawingHint(null), 300);
        localStorage.setItem('drawingHintSeen', '1');
      }, 10000);
      hintShownRef.current = true;
    }, 3500);
    // Start initial timer
    hintIdleTimerRef.current = startHintCheck();
    // Reset on any pointer/touch activity
    window.addEventListener('pointermove', resetTimer);
    window.addEventListener('pointerdown', resetTimer);
    return () => {
      if (hintIdleTimerRef.current) clearTimeout(hintIdleTimerRef.current);
      window.removeEventListener('pointermove', resetTimer);
      window.removeEventListener('pointerdown', resetTimer);
    };
  }, [strokesLoadedCount, hasMovedView]);

  // Dismiss hint on any interaction
  useEffect(() => {
    if (!drawingHint) return;
    const dismiss = () => {
      if (drawingHintTimerRef.current) clearTimeout(drawingHintTimerRef.current);
      setDrawingHintShow(false);
      setTimeout(() => setDrawingHint(null), 300);
      localStorage.setItem('drawingHintSeen', '1');
    };
    window.addEventListener('pointerdown', dismiss, { once: true });
    return () => window.removeEventListener('pointerdown', dismiss);
  }, [drawingHint]);

  // Track hint position via projection
  useEffect(() => {
    if (!drawingHint || !viewerRef.current) return;
    let rafId: number;
    const update = async () => {
      if (!viewerRef.current || !drawingHint) return;
      try {
        const screenPos = await viewerRef.current.projectFromBasic(drawingHint.basicCoord);
        if (screenPos) {
          const rect = containerRef.current?.getBoundingClientRect();
          setDrawingHint(prev => prev ? { ...prev, x: screenPos[0] + (rect?.left || 0), y: screenPos[1] + (rect?.top || 0) } : null);
        }
      } catch {}
      rafId = requestAnimationFrame(update);
    };
    rafId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(rafId);
  }, [drawingHint?.basicCoord[0], drawingHint?.basicCoord[1]]);

  // Animate report button mount/unmount
  useEffect(() => {
    if (reportTarget) {
      setReportBtnMounted(true);
      // Trigger enter animation on next frame
      requestAnimationFrame(() => setReportBtnShow(true));
    } else {
      setReportBtnShow(false);
      // Keep mounted during exit animation, then unmount
      const timer = setTimeout(() => setReportBtnMounted(false), 250);
      return () => clearTimeout(timer);
    }
  }, [reportTarget]);

  // Project report button position to screen space every frame
  useEffect(() => {
    if (!reportTarget || !viewerRef.current) return;
    let rafId: number;
    const update = async () => {
      if (!viewerRef.current || !reportTarget) return;
      try {
        const screenPos = await viewerRef.current.projectFromBasic(reportTarget.basicCoord);
        if (screenPos) {
          const rect = containerRef.current?.getBoundingClientRect();
          const x = screenPos[0] + (rect?.left || 0);
          const y = screenPos[1] + (rect?.top || 0);
          const inView = x > -50 && x < window.innerWidth + 50 && y > -50 && y < window.innerHeight + 50;
          setReportBtnPos({ x, y: y - 40, visible: inView });
        } else {
          setReportBtnPos(prev => ({ ...prev, visible: false }));
        }
      } catch {
        setReportBtnPos(prev => ({ ...prev, visible: false }));
      }
      rafId = requestAnimationFrame(update);
    };
    rafId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(rafId);
  }, [reportTarget]);

  const handleSetActiveTool = useCallback((tool: 'pencil' | 'marker' | 'crayon' | 'fountainPen' | 'watercolor' | 'eraser') => {
    setActiveTool(tool);
    drawingOverlayRef.current?.clearSelection();
    setReportTarget(null);
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
    if (!hasMovedView) setHasMovedView(true);
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
      cancelLongPress();
      // Cancel any active stroke if drawing
      if (isDrawingRef.current && drawingOverlayRef.current) {
        drawingOverlayRef.current.endStroke();
        setTimeout(() => {
          if (drawingOverlayRef.current?.canUndo()) {
            drawingOverlayRef.current.undo();
          }
        }, 50);
        // Fully restore ink to pre-stroke level (covers per-stroke + per-pixel costs)
        inkLevelRef.current = inkBeforeStrokeRef.current;
        inkDepletedRef.current = false;
        updateInkVisuals();
        setIsDrawing(false);
        isDrawingRef.current = false;
        lastInkPos.current = null;
        // Hide ink pill immediately — this was a pan, not a draw
        setInkPillVisible(false);
        setInkPillCollapsed(false);
        if (inkPillTimerRef.current) {
          clearTimeout(inkPillTimerRef.current);
          inkPillTimerRef.current = null;
        }
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

    const isAdmin = IS_ADMIN;
    if (activeTool !== 'eraser' && inkDepletedRef.current && !isAdmin) {
      showInkToast();
      return;
    }

    if (inertiaRef.current) {
      cancelAnimationFrame(inertiaRef.current);
      inertiaRef.current = null;
    }

    // Dismiss report selection when starting to draw
    if (reportTarget) {
      drawingOverlayRef.current.clearSelection();
      setReportTarget(null);
    }

    if (activeTool === 'eraser') {
      if (e.pointerType !== 'mouse') drawingOverlayRef.current.shareTouchCursor(pos.x, pos.y, BRUSH_CURSOR_RADIUS.eraser, true);
      drawingOverlayRef.current.eraseAt(pos.x, pos.y, BRUSH_CURSOR_RADIUS.eraser);
    } else if (e.pointerType === 'touch') {
      // Touch: defer stroke start until finger moves (allows long-press to report)
      const lineWidth = activeTool === 'marker' ? 8 : 3;
      pendingTouchStrokeRef.current = { x: pos.x, y: pos.y, color: selectedColor, lineWidth, tool: activeTool as 'pencil' | 'marker' | 'crayon' | 'fountainPen' | 'watercolor', time: Date.now() };
      // Start long-press timer (native listener is blocked by stopImmediatePropagation)
      startLongPress(pos.x, pos.y);
    } else {
      // Mouse: start stroke immediately
      const lineWidth = activeTool === 'marker' ? 8 : 3;
      inkBeforeStrokeRef.current = inkLevelRef.current;
      if (!isAdmin) {
        inkLevelRef.current = Math.max(inkLevelRef.current - INK_COST_PER_STROKE, 0);
        if (inkLevelRef.current === 0) inkDepletedRef.current = true;
        updateInkVisuals();
      }
      // stylus (Apple Pencil): share the ring first, like touch, so others get our brush size
      if (e.pointerType !== 'mouse') drawingOverlayRef.current.shareTouchCursor(pos.x, pos.y, BRUSH_CURSOR_RADIUS[activeTool] ?? 4, true);
      drawingOverlayRef.current.startStroke(pos.x, pos.y, selectedColor, lineWidth, activeTool);
      setIsDrawing(true);
      isDrawingRef.current = true;
      lastInkPos.current = pos;
    }
  }, [activeTool, selectedColor, pencilColor, markerColor, getPointerPosition, startLongPress, hasMovedView, isLoaded, isStrokesLoading]);

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
      const hoverColor = activeTool !== 'eraser' && e.buttons === 0 && selectedColorRef.current !== 'rainbow' ? selectedColorRef.current : null;
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
        cancelLongPress();
        pendingTouchStrokeRef.current = null;
        inkBeforeStrokeRef.current = inkLevelRef.current;
        const isAdmin = IS_ADMIN;
        if (!isAdmin) {
          inkLevelRef.current = Math.max(inkLevelRef.current - INK_COST_PER_STROKE, 0);
          if (inkLevelRef.current === 0) inkDepletedRef.current = true;
          updateInkVisuals();
        }
        // share the ring first, so others get our brush size before the stroke starts
        drawingOverlayRef.current.shareTouchCursor(pos.x, pos.y, BRUSH_CURSOR_RADIUS[pending.tool] ?? 4, true);
        drawingOverlayRef.current.startStroke(pending.x, pending.y, pending.color, pending.lineWidth, pending.tool);
        drawingOverlayRef.current.addPoint(pos.x, pos.y);
        setIsDrawing(true);
        isDrawingRef.current = true;
        lastInkPos.current = pos;
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
      const isAdmin = IS_ADMIN;
      if (inkLevelRef.current > 0 || isAdmin) {
        // every sample since the last event (pens and fast fingers report more than one per frame),
        // so quick curves stay curves
        const overlay = drawingOverlayRef.current;
        const rect = containerRef.current?.getBoundingClientRect();
        const samples = rect ? e.nativeEvent.getCoalescedEvents?.() ?? [] : [];
        for (const s of samples) overlay.addPoint(s.clientX - rect!.left, s.clientY - rect!.top);
        overlay.addPoint(pos.x, pos.y);
        if (e.pointerType !== 'mouse' && activeTool) drawingOverlayRef.current.shareTouchCursor(pos.x, pos.y, BRUSH_CURSOR_RADIUS[activeTool] ?? 4);

        if (lastInkPos.current && !isAdmin) {
          const dx = pos.x - lastInkPos.current.x;
          const dy = pos.y - lastInkPos.current.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          // Direct update
          const newLevel = Math.max(inkLevelRef.current - dist * INK_COST_PER_PIXEL, 0);
          inkLevelRef.current = newLevel;
          updateInkVisuals();

          // We DON'T call setInkLevel here to avoid re-renders during draw
        }
        lastInkPos.current = pos;
      } else {
        inkDepletedRef.current = true;
        drawingOverlayRef.current.endStroke();
        setIsDrawing(false);
        setInkLevel(0);
        showInkToast();
        setInkPulsing(true);
        // Show full pill and keep it visible while pulsing
        setInkPillCollapsed(false);
        setInkPillVisible(true);
        if (inkPillTimerRef.current) clearTimeout(inkPillTimerRef.current);
      }
    }
  }, [isDrawing, activeTool, getPointerPosition, cancelLongPress]);

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
    cancelLongPress();
    pendingTouchStrokeRef.current = null;

    if (!isDrawingRef.current && activeTool !== 'eraser') {
      // No active stroke (was cancelled by multi-touch or never started)
      return;
    }

    setIsDrawing(false);
    isDrawingRef.current = false;
    lastInkPos.current = null;

    if (activeTool === 'eraser' && drawingOverlayRef.current) {
      const fullRefund = drawingOverlayRef.current.finalizeEraser();
      refreshUndoRedo();
      if (e.pointerType !== 'mouse') drawingOverlayRef.current.shareCursorHide();
      const refund = fullRefund * 0.50; // Refund 50% of erased ink
      if (refund > 0) {
        const maxInk = tierRef.current.maxInk;
        inkLevelRef.current = Math.min(inkLevelRef.current + refund, maxInk);
        if (inkDepletedRef.current && inkLevelRef.current >= INK_RECOVER_THRESHOLD) {
          inkDepletedRef.current = false;
        }
        // Enable smooth height transition for refund animation
        if (inkFillRef.current) inkFillRef.current.classList.add('refunding');
        setInkLevel(inkLevelRef.current);
        updateInkVisuals();
        // Show pill with pulse effect for ink refund
        setInkPillCollapsed(false);
        setInkPillVisible(true);
        // Trigger refund pulse via DOM class (re-triggerable per erase)
        const pill = inkFillRef.current?.closest('.ink-pill');
        if (pill) {
          pill.classList.remove('refund-pulse');
          void (pill as HTMLElement).offsetWidth; // force reflow to re-trigger animation
          pill.classList.add('refund-pulse');
        }
        // Clean up after animation
        setTimeout(() => {
          if (inkFillRef.current) inkFillRef.current.classList.remove('refunding');
          pill?.classList.remove('refund-pulse');
        }, 800);
      }
    }

    if (drawingOverlayRef.current && activeTool !== 'eraser') {
      const inkCost = inkBeforeStrokeRef.current - inkLevelRef.current;
      drawingOverlayRef.current.setStrokeInkCost(inkCost);
      drawingOverlayRef.current.endStroke();
      setInkLevel(inkLevelRef.current); // Sync state on mouse up
    }

    // Force immediate save to backend
    saveInkLevel(inkLevelRef.current, undefined);

    // Delayed refresh: textures finalize async after endStroke
    setTimeout(() => refreshUndoRedo(), 600);
  }, [activeTool, isDrawing, refreshUndoRedo, cancelLongPress]);

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


        {/* Ink Pill Slider */}
        <div style={{ display: 'none' }}>
        <div className={`ink-pill ${inkPillVisible || isDrawing || inkPulsing ? 'visible' : ''} ${inkPillCollapsed ? 'drawing' : ''} ${inkPulsing ? 'pulsing' : ''}`}
          style={inkLevel <= 0 ? { background: 'rgba(255, 59, 48, 0.6)' } : undefined}
        >
          <div
            className="ink-track"
            style={{ backgroundColor: inkLevel <= 0 ? 'transparent' : selectedColor === 'rainbow' ? 'rgba(128,128,128,0.2)' : `${selectedColor}33` }}
          >
            <div
              ref={inkFillRef}
              className="ink-fill"
              style={{
                height: `${(inkLevel / tierRef.current.maxInk) * 100}%`, // Initial/fallback
                ...(selectedColor === 'rainbow' ? {
                  background: rainbowColor,
                  boxShadow: `0 0 10px ${rainbowColor}`,
                } : {
                  background: selectedColor,
                  boxShadow: `0 0 10px ${selectedColor}80`,
                }),
              }}
            />
          </div>
          <div className="ink-icon">
            <svg viewBox="0 0 24 24" fill="rgba(255, 255, 255, 0.5)" stroke="none" width="16" height="16">
              <path d="M12 22C17 22 20 18 20 14C20 9 12 2 12 2C12 2 4 9 4 14C4 18 7 22 12 22Z" />
            </svg>
          </div>
        </div>
        </div>

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
                onClick={() => handleSetActiveTool('pencil')}
              >
                <svg className="pen-tip" viewBox="36 0 66 390" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <mask id="pencil-tip-mask" style={{ maskType: 'alpha' } as React.CSSProperties}>
                      <image href="/tools/pencil-tip.png" x="0" y="0" width="138" height="390" />
                    </mask>
                  </defs>
                  <image href={toolBase('pencil')} x="0" y="0" width="138" height="390" />
                  <rect x="0" y="0" width="138" height="390" fill={pencilColor === 'rainbow' ? rainbowColor : pencilColor} mask="url(#pencil-tip-mask)" />
                  <image href="/tools/pencil-tip-contour.png" x="0" y="0" width="138" height="390" />
                </svg>
              </button>
              <button
                className={`pen-btn marker ${activeTool === 'marker' ? 'active' : ''}`}
                aria-label="Marker"
                onClick={() => handleSetActiveTool('marker')}
              >
                <svg className="pen-tip" viewBox="36 0 66 390" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <mask id="marker-tip-mask" style={{ maskType: 'alpha' } as React.CSSProperties}>
                      <image href="/tools/marker-tip.png" x="0" y="0" width="138" height="390" />
                    </mask>
                  </defs>
                  <image href={toolBase('marker')} x="0" y="0" width="138" height="390" />
                  <rect x="0" y="0" width="138" height="390" fill={markerColor === 'rainbow' ? rainbowColor : markerColor} mask="url(#marker-tip-mask)" />
                  <image href="/tools/marker-tip-contour.png" x="0" y="0" width="138" height="390" />
                </svg>
              </button>
              <button
                className={`pen-btn eraser ${activeTool === 'eraser' ? 'active' : ''}`}
                aria-label="Eraser"
                onClick={() => handleSetActiveTool('eraser')}
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
                className={`pen-btn crayon ${activeTool === 'crayon' ? 'active' : ''} ${!tierRef.current.isPlus ? 'premium-locked' : ''}`}
                onClick={() => tierRef.current.isPlus ? handleSetActiveTool('crayon') : setShowPlusSheet(true)}
              >
                <svg className="pen-tip" viewBox="36 0 66 390" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <mask id="crayon-tip-mask" style={{ maskType: 'alpha' } as React.CSSProperties}>
                      <image href="/tools/crayon-tip.png" x="0" y="0" width="138" height="390" />
                    </mask>
                  </defs>
                  <image href={toolBase('crayon')} x="0" y="0" width="138" height="390" />
                  <rect x="0" y="0" width="138" height="390" fill={crayonColor === 'rainbow' ? rainbowColor : crayonColor} mask="url(#crayon-tip-mask)" />
                  <image href="/tools/crayon-tip-contour.png" x="0" y="0" width="138" height="390" />
                </svg>
              </button>
              <button
                className={`pen-btn fountainPen ${activeTool === 'fountainPen' ? 'active' : ''} ${!tierRef.current.isPlus ? 'premium-locked' : ''}`}
                onClick={() => tierRef.current.isPlus ? handleSetActiveTool('fountainPen') : setShowPlusSheet(true)}
              >
                <svg className="pen-tip" viewBox="36 0 66 318" xmlns="http://www.w3.org/2000/svg">
                  <image href={toolBase('fountainpen')} x="0" y="0" width="138" height="318" />
                  <rect x="36" y="165" width="66" height="7" fill={fountainPenColor === 'rainbow' ? rainbowColor : fountainPenColor} />
                </svg>
              </button>
              <button
                className={`pen-btn watercolor ${activeTool === 'watercolor' ? 'active' : ''} ${!tierRef.current.isPlus ? 'premium-locked' : ''}`}
                onClick={() => tierRef.current.isPlus ? handleSetActiveTool('watercolor') : setShowPlusSheet(true)}
              >
                <svg className="pen-tip" viewBox="36 0 66 318" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <mask id="watercolor-tip-mask" style={{ maskType: 'alpha' } as React.CSSProperties}>
                      <image href="/tools/watercolor-tip.png" x="0" y="0" width="138" height="318" />
                    </mask>
                  </defs>
                  <image href={toolBase('watercolor')} x="0" y="0" width="138" height="318" />
                  <rect x="0" y="0" width="138" height="318" fill={watercolorColor === 'rainbow' ? rainbowColor : watercolorColor} mask="url(#watercolor-tip-mask)" />
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

      {/* Report / Admin Delete Buttons */}
      {reportBtnMounted && (
        <div
          className={`report-btn ${reportBtnShow ? 'report-btn-enter' : 'report-btn-exit'}`}
          style={{
            left: reportBtnPos.x,
            top: reportBtnPos.y,
            visibility: reportBtnPos.visible ? 'visible' : 'hidden',
          }}
        >
          <button
            style={{ all: 'unset', cursor: 'pointer', borderRadius: 999, padding: '6px 12px', background: isLiked ? 'rgba(0,122,255,0.12)' : 'transparent', display: 'flex', alignItems: 'center', gap: 5, color: isLiked ? '#007AFF' : '#8e8e93', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', transition: 'all 0.2s' }}
            onClick={() => {
              if (likeStatus !== 'idle' || !drawingOverlayRef.current || !reportTarget?.authorDeviceId) return;
              const currentImageId = drawingOverlayRef.current.getImageId();
              if (!currentImageId) return;
              const authorId = reportTarget.authorDeviceId;
              setLikeStatus('toggling');
              const newLiked = !isLiked;
              setIsLiked(newLiked);
              (newLiked
                ? supabase.from('likes').insert({ image_id: currentImageId, device_id: deviceId, author_device_id: authorId })
                : supabase.from('likes').delete().eq('image_id', currentImageId).eq('device_id', deviceId).eq('author_device_id', authorId)
              ).then(() => {
                setLikeStatus('idle');
                if (newLiked && drawingOverlayRef.current) {
                  drawingOverlayRef.current.captureScreenshotForStar(reportTarget?.authorDeviceId);
                }
                setTimeout(() => {
                  setReportTarget(null);
                  drawingOverlayRef.current?.clearSelection();
                }, 600);
              });
            }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill={isLiked ? '#007AFF' : 'none'} stroke={isLiked ? '#007AFF' : '#8e8e93'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transition: 'all 0.2s' }}>
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            {isLiked ? 'Starred' : 'Star'}
          </button>
          <button
            style={{ all: 'unset', cursor: 'pointer', borderRadius: 999, padding: '6px 12px', background: reportStatus === 'done' ? 'rgba(52,199,89,0.12)' : 'transparent', display: 'flex', alignItems: 'center', gap: 5, color: reportStatus === 'done' ? '#34C759' : '#FF3B30', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', transition: 'all 0.2s' }}
            onClick={() => {
              if (reportStatus !== 'idle' || !drawingOverlayRef.current) return;
              setReportStatus('sending');
              const currentImageId = drawingOverlayRef.current.getImageId();
              // Remove star if it was starred
              if (isLiked && currentImageId && reportTarget?.authorDeviceId) {
                setIsLiked(false);
                supabase.from('likes').delete().eq('image_id', currentImageId).eq('device_id', deviceId).eq('author_device_id', reportTarget.authorDeviceId);
              }
              drawingOverlayRef.current.reportStrokes(reportTarget!.strokeIds).then(() => {
                setReportStatus('done');
                setTimeout(() => {
                  setReportTarget(null);
                  setReportStatus('idle');
                }, 1500);
              });
            }}
          >
            {reportStatus === 'done' ? (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="#34C759" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Reported
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke={reportStatus === 'sending' ? '#ccc' : '#FF3B30'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" style={{ transition: 'all 0.2s' }}>
                  <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                  <line x1="4" y1="22" x2="4" y2="15" />
                </svg>
                {reportStatus === 'sending' ? 'Sending...' : 'Report'}
              </>
            )}
          </button>
          {IS_ADMIN && reportStatus === 'idle' && (
            <button
              style={{ all: 'unset', cursor: 'pointer', borderRadius: 999, padding: '6px 12px', background: 'transparent', display: 'flex', alignItems: 'center', gap: 5, color: DARK_UI ? '#fff' : '#1c1c1e', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}
              onClick={() => {
                if (!drawingOverlayRef.current) return;
                setReportStatus('sending');
                const authorDid = reportTarget!.authorDeviceId;
                const imgId = drawingOverlayRef.current.getImageId();
                drawingOverlayRef.current.adminDeleteStrokes(reportTarget!.strokeIds).then(() => {
                  // Also delete the screenshot for this drawing
                  if (imgId && authorDid) {
                    supabase.from('screenshots').delete().eq('image_id', imgId).eq('device_id', authorDid);
                  } else if (imgId) {
                    supabase.from('screenshots').delete().eq('image_id', imgId).eq('device_id', 'legacy');
                  }
                  setReportStatus('done');
                  setTimeout(() => {
                    setReportTarget(null);
                    setReportStatus('idle');
                  }, 1500);
                });
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="#1c1c1e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              Delete
            </button>
          )}
        </div>
      )}

      {/* Drawing interaction hint popover */}
      {drawingHint && (
        <div
          style={{
            position: 'fixed',
            left: drawingHint.x,
            top: drawingHint.y - 120,
            transform: 'translateX(-50%)',
            zIndex: 10000,
            pointerEvents: 'none',
            opacity: drawingHintShow ? 1 : 0,
            transition: 'opacity 0.3s ease',
          }}
        >
          <div style={{
            background: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            borderRadius: 10,
            padding: '8px 14px',
            color: '#fff',
            fontSize: 13,
            fontWeight: 500,
            fontFamily: "-apple-system, 'SF Pro Text', system-ui, sans-serif",
            whiteSpace: 'nowrap',
            boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
          }}>
            {('ontouchstart' in window) ? 'Hold on a drawing to star or report' : 'Double-click a drawing to star or report'}
          </div>
          {/* Arrow pointing down */}
          <div style={{
            width: 0,
            height: 0,
            borderLeft: '8px solid transparent',
            borderRight: '8px solid transparent',
            borderTop: '8px solid rgba(0,0,0,0.75)',
            margin: '0 auto',
          }} />
        </div>
      )}

      {/* Plus Subscription Bottom Sheet */}
      {(showPlusSheet || isPlusSheetClosing) && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999 }}>
          <div
            style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)', animation: isPlusSheetClosing ? 'plusSheetScrimOut 0.3s forwards' : 'plusSheetScrimIn 0.3s forwards' }}
            onClick={() => {
              setIsPlusSheetClosing(true);
              setTimeout(() => { setShowPlusSheet(false); setIsPlusSheetClosing(false); }, 300);
            }}
          />
          <div
            className={`sheet-dialog ${isPlusSheetClosing ? 'sheet-leaving' : 'sheet-entering'}`}
            style={{
            position: 'absolute',
            bottom: 0, left: 0, right: 0,
            maxWidth: '420px',
            marginLeft: 'auto',
            marginRight: 'auto',
            borderRadius: '32px 32px 0 0',
            background: 'rgba(255,255,255,0.92)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            animation: isPlusSheetClosing ? 'plusSheetSlideDown 0.3s cubic-bezier(0.2,0.8,0.2,1) forwards' : 'plusSheetSlideUp 0.35s cubic-bezier(0.2,0.8,0.2,1) forwards',
            fontFamily: "-apple-system, 'SF Pro Display', 'SF Pro Text', system-ui, sans-serif",
            overflow: 'hidden',
          }}>
            <div className="sheet-drag-handle" style={{ width: '36px', height: '4px', borderRadius: '2px', background: 'rgba(0,0,0,0.12)', margin: '6px auto 0' }} />
            <button
              onPointerDown={e => e.stopPropagation()}
              onClick={() => {
                setIsPlusSheetClosing(true);
                setTimeout(() => {
                  setShowPlusSheet(false);
                  setIsPlusSheetClosing(false);
                }, 300);
              }}
              style={{
                position: 'absolute', top: '14px', right: '16px',
                width: '28px', height: '28px', borderRadius: '50%',
                background: 'rgba(118,118,128,0.12)', border: 'none',
                cursor: 'pointer', display: 'flex', alignItems: 'center',
                justifyContent: 'center', padding: 0,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#8e8e93" strokeWidth="2" strokeLinecap="round">
                <line x1="1" y1="1" x2="11" y2="11" />
                <line x1="11" y1="1" x2="1" y2="11" />
              </svg>
            </button>

            <div style={{ padding: '16px 24px 32px' }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                <svg width="120" height="120" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" style={{ overflow: 'hidden' }}>
                  <defs>
                    <clipPath id="splat-clip-app">
                      <path d="M438.024,210.133c0,7.488,6.08,13.551,13.551,13.551c7.488,0,13.569-6.063,13.569-13.551c0-7.479-6.081-13.552-13.569-13.552C444.104,196.581,438.024,202.654,438.024,210.133z" />
                      <path d="M400.097,376.503c-5.994,0-10.842,4.856-10.842,10.85c0,5.986,4.848,10.832,10.842,10.832c5.994,0,10.841-4.847,10.841-10.832C410.938,381.359,406.091,376.503,400.097,376.503z" />
                      <path d="M382.758,415.376c-12.284,0-22.238,9.956-22.238,22.238c0,12.274,9.955,22.229,22.238,22.229c12.283,0,22.238-9.955,22.238-22.229C404.997,425.332,395.041,415.376,382.758,415.376z" />
                      <circle cx="137.251" cy="426.904" r="16.8" />
                      <path d="M94.425,359.164c-4.778,0-8.669,3.874-8.669,8.678c0,4.778,3.892,8.66,8.669,8.66c4.796,0,8.67-3.883,8.67-8.66C103.094,363.038,99.22,359.164,94.425,359.164z" />
                      <path d="M54.865,151.063c6.29,0,11.38-5.1,11.38-11.389c0-6.281-5.09-11.38-11.38-11.38c-6.289,0-11.38,5.099-11.38,11.38C43.485,145.963,48.576,151.063,54.865,151.063z" />
                      <path d="M165.97,97.952c8.374,0,15.166-6.793,15.166-15.185c0-8.365-6.792-15.158-15.166-15.158s-15.168,6.794-15.168,15.158C150.802,91.158,157.596,97.952,165.97,97.952z" />
                      <path d="M450.775,300.632c-47.586-16.887-56.968-10.485-80.214-32.515c-5.56-5.255-5.438-22.49,25.47-18.425c15.497,2.042,26.008-6.506,26.008-18.702c0-8.131-9.799-19.433-24.393-13.821c-21.126,8.131-34.834-1.094-37.388-11.38c-3.25-13.004,0.434-27.832,54.814-54.996c66.646-33.332,28.423-93.983-23.924-36.859c-23.194,25.296-34.14,35.764-49.584,43.895c-13.864,7.288-30.49-0.27-17.895-17.069c4.882-6.507,13.17-11.527,15.445-19.511c3.249-11.38-6.324-21.952-14.628-21.952c-8.304,0-18.694,4.874-21.943,17.07c-4.882,22.359-17.322,21.24-23.194,14.785c-11.241-12.318-7.193-26.686-5.264-48.924c2.276-26.121,17.738-86.443-29.709-81.995c-22.88,2.146-29.639,23.715-22.238,62.267c9.208,47.856-4.725,81.257-19.597,88.007c-17.878,8.13-26.946,5.046-65.029-21.126c-20.24-13.926-42.584-1.703-47.152,14.628c-4.031,14.385,7.332,31.768,24.393,37.396c26.286,8.678,37.944,10.693,50.14,17.33c11.918,6.507,13.412,22.282,1.511,36.554c-11.918,14.282-42.705,2.468-88.224-0.782c-78.685-5.611-60.999,81.43,12.996,55.831c42.27-14.637,60.147-11.389,67.479-2.441c10.112,12.344,3.162,29.031-16.54,40.915c-62.858,37.944,7.61,85.078,33.618,32.515c10.876-21.961,23.385-28.71,35.756-23.846c10.094,3.979,23.02,39.204,8.409,86.72C206.885,466.473,207.771,512,238.33,512c28.563,0,33.028-42.539,28.164-88.875c-1.808-17.339-0.47-44.207,13.012-50.948c10.842-5.421,27.781-11.458,39.283,12.457c10.58,21.951,33.34,18.693,42.287,6.506c6.532-8.921,9.851-28.71-16.157-38.969c-30.995-12.249-19.615-45.58,3.961-42.323c26.026,3.588,43.868,13.17,74.794,39.569C466.829,386.233,522.234,325.989,450.775,300.632z" />
                    </clipPath>
                    <linearGradient id="rainbow-app" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse" spreadMethod="repeat">
                      <stop offset="0%" stopColor="#FF3B30" />
                      <stop offset="7%" stopColor="#FF6A1E" />
                      <stop offset="14%" stopColor="#FF9500" />
                      <stop offset="21%" stopColor="#FFB300" />
                      <stop offset="28%" stopColor="#FFCC00" />
                      <stop offset="35%" stopColor="#9ACD32" />
                      <stop offset="42%" stopColor="#34C759" />
                      <stop offset="50%" stopColor="#1AA3A3" />
                      <stop offset="57%" stopColor="#007AFF" />
                      <stop offset="64%" stopColor="#2C68EA" />
                      <stop offset="71%" stopColor="#5856D6" />
                      <stop offset="78%" stopColor="#8454DA" />
                      <stop offset="85%" stopColor="#AF52DE" />
                      <stop offset="92%" stopColor="#D946A8" />
                      <stop offset="100%" stopColor="#FF3B30" />
                    </linearGradient>
                  </defs>
                  <g clipPath="url(#splat-clip-app)">
                    <rect x="-512" y="-512" width="1536" height="1536" fill="url(#rainbow-app)" style={{ animation: 'rainbowSlide 4s linear infinite' }} />
                  </g>
                </svg>
              </div>
              <h2 style={{ margin: '0 0 6px', fontSize: '20px', fontWeight: 700, color: '#1c1c1e' }}><span style={{ display: 'inline-block', background: 'rgba(118,118,128,0.12)', color: '#3c3c43', fontSize: '13px', fontWeight: 700, padding: '2px 8px', borderRadius: '6px', verticalAlign: 'middle', letterSpacing: '0.3px' }}>Plus</span></h2>
              <p style={{ margin: '0 0 20px', fontSize: '14px', color: '#8e8e93', lineHeight: 1.5 }}>
                Exclusive tools, more ink, and rainbow color.
              </p>
              <div style={{ background: 'rgba(118,118,128,0.08)', borderRadius: '14px', padding: '4px 0', marginBottom: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{
                      width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                      position: 'relative', overflow: 'hidden',
                    }}>
                      <div style={{
                        position: 'absolute', inset: -1, borderRadius: '50%',
                        background: `conic-gradient(#ff3b30, #ff6a1e, #ff9500, #ffb300, #ffcc00, #9acd32, #34c759, #1aa3a3, #007aff, #2c68ea, #5856d6, #8454da, #af52de, #d946a8, #ff3b30), linear-gradient(135deg, #ff3b30, #ff9500, #ffcc00, #34c759, #007aff, #5856d6, #af52de, #ff3b30, #ff9500, #ffcc00, #34c759, #007aff, #5856d6, #af52de, #ff3b30)`,
                        backgroundSize: '100% 100%, 500% 500%',
                        backgroundBlendMode: 'overlay',
                        animation: 'rainbowFlow 6s ease infinite',
                        filter: 'blur(0.5px)',
                      }} />
                    </div>
                    <span style={{
                      fontSize: '15px',
                      background: 'linear-gradient(135deg, #ff3b30, #ff9500, #ffcc00, #34c759, #007aff, #5856d6, #af52de, #ff3b30, #ff9500, #ffcc00, #34c759, #007aff, #5856d6, #af52de, #ff3b30)',
                      backgroundSize: '500% 500%',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                      animation: 'rainbowTextFlow 6s ease infinite',
                    }}>Rainbow color</span>
                  </div>
                </div>
                <div style={{ height: '1px', background: 'rgba(60,60,67,0.1)', marginLeft: '41px' }} />
                {/* Crayon */}
                <div style={{ display: 'flex', alignItems: 'center', padding: '11px 11px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(118,118,128,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
                      <svg viewBox="36 0 66 390" width="18" height="50" xmlns="http://www.w3.org/2000/svg" style={{ marginTop: 28 }}>
                        <defs>
                          <mask id="plus-crayon-mask-app" style={{ maskType: 'alpha' } as any}>
                            <image href="/tools/crayon-tip.png" x="0" y="0" width="138" height="390" />
                          </mask>
                        </defs>
                        <image href="/tools/crayon-base.png" x="0" y="0" width="138" height="390" />
                        <rect x="0" y="0" width="138" height="390" fill="#FF9500" mask="url(#plus-crayon-mask-app)" />
                        <image href="/tools/crayon-tip-contour.png" x="0" y="0" width="138" height="390" />
                      </svg>
                    </div>
                    <span style={{ fontSize: '15px', color: '#1c1c1e' }}>Crayon</span>
                  </div>
                </div>
                <div style={{ height: '1px', background: 'rgba(60,60,67,0.1)', marginLeft: '41px' }} />
                {/* Fountain Pen */}
                <div style={{ display: 'flex', alignItems: 'center', padding: '11px 11px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(118,118,128,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
                      <svg viewBox="36 0 66 318" width="18" height="42" xmlns="http://www.w3.org/2000/svg" style={{ marginTop: 18 }}>
                        <image href="/tools/fountainpen-base.png" x="0" y="0" width="138" height="318" />
                        <rect x="36" y="165" width="66" height="7" fill="#007AFF" />
                      </svg>
                    </div>
                    <span style={{ fontSize: '15px', color: '#1c1c1e' }}>Fountain Pen</span>
                  </div>
                </div>
                <div style={{ height: '1px', background: 'rgba(60,60,67,0.1)', marginLeft: '41px' }} />
                {/* Watercolor */}
                <div style={{ display: 'flex', alignItems: 'center', padding: '11px 11px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(118,118,128,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
                      <svg viewBox="36 0 66 318" width="18" height="42" xmlns="http://www.w3.org/2000/svg" style={{ marginTop: 18 }}>
                        <defs>
                          <mask id="plus-watercolor-mask-app" style={{ maskType: 'alpha' } as any}>
                            <image href="/tools/watercolor-tip.png" x="0" y="0" width="138" height="318" />
                          </mask>
                        </defs>
                        <image href="/tools/watercolor-base.png" x="0" y="0" width="138" height="318" />
                        <rect x="0" y="0" width="138" height="318" fill="#34C759" mask="url(#plus-watercolor-mask-app)" />
                        <image href="/tools/watercolor-tip-contour.png" x="0" y="0" width="138" height="318" />
                      </svg>
                    </div>
                    <span style={{ fontSize: '15px', color: '#1c1c1e' }}>Watercolor</span>
                  </div>
                </div>
                <div style={{ height: '1px', background: 'rgba(60,60,67,0.1)', marginLeft: '41px' }} />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <svg viewBox="0 0 24 24" fill="#1c1c1e" stroke="none" width="15" height="15" style={{ flexShrink: 0 }}>
                      <path d="M12 22C17 22 20 18 20 14C20 9 12 2 12 2C12 2 4 9 4 14C4 18 7 22 12 22Z" />
                    </svg>
                    <span style={{ fontSize: '15px', color: '#1c1c1e' }}>10x Ink capacity</span>
                  </div>
                  <span style={{ fontSize: '15px', fontWeight: 600 }}><span style={{ color: '#8e8e93' }}>150</span> <span style={{ color: '#8e8e93' }}>→</span> <span style={{ color: '#34c759' }}>1,500</span></span>
                </div>
                <div style={{ height: '1px', background: 'rgba(60,60,67,0.1)', marginLeft: '41px' }} />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <svg viewBox="0 0 24 24" fill="#1c1c1e" stroke="#1c1c1e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="15" height="15" style={{ flexShrink: 0 }}>
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                    </svg>
                    <span style={{ fontSize: '15px', color: '#1c1c1e' }}>10x Refill speed</span>
                  </div>
                  <span style={{ fontSize: '15px', fontWeight: 600, color: '#34c759' }}>10x</span>
                </div>
              </div>
              <button
                onClick={async () => {
                  const url = await createCheckoutSession();
                  if (url) window.location.href = url;
                }}
                style={{
                  width: '100%',
                  padding: '14px',
                  background: '#007aff',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '14px',
                  fontWeight: 600,
                  fontSize: '16px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  transition: 'transform 0.2s ease',
                }}
                onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.02)'}
                onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
              >
                Unlock for $3.99
              </button>
              <div style={{ textAlign: 'center', fontSize: '11px', color: '#8e8e93', marginTop: '8px' }}>
                One-time purchase. Supports development & moderation.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Ink Depleted Toast */}
      <div className={`ink-toast ${inkToastVisible ? 'visible' : ''}`}>
        <div className="ink-toast-icon">
          <PiDropSlashFill size={20} color="#ff3b30" />
        </div>
        <div className="ink-toast-text">
          <div className="ink-toast-title">Out of ink — refills in {getRegenTimeString()}</div>
        </div>
      </div>

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
