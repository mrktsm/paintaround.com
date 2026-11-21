import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useNavigate, useSearchParams } from "react-router-dom";
import "mapillary-js/dist/mapillary.css";
import cityMarkerImage from "./assets/panorama-preview.jpg";
import { MAP_LOCATIONS, PANORAMA_BY_ID, panoramaThumbnail } from "./pool/catalog";
import { IoIosMore } from "react-icons/io";
import { IoTime, IoPersonCircleSharp } from "react-icons/io5";

import { MaplibreStarfieldLayer } from "@geoql/maplibre-gl-starfield";
import { supabase } from "./supabaseClient";
import { fetchInkLevel } from "./inkManager";
import {
  fetchSubscriptionTier,
  createCheckoutSession,
  GUEST_TIER,
} from "./subscriptionManager";
import type { PlusTier } from "./subscriptionManager";

const locationsData = { locations: MAP_LOCATIONS };

// Cache for loaded thumbnail image IDs (prevents re-loading)
const loadedThumbnails = new Set<string>();
const loadingThumbnails = new Set<string>();
// LRU order for thumbnail eviction — most recently used at the end
const thumbLruOrder: string[] = [];
const MAX_CACHED_THUMBNAILS = 60; // Cap memory: ~60 × 256KB = ~15MB max
// Cache CDN URLs so transition overlays can use them without re-fetching
const thumbCdnUrls = new Map<string, string>();
const highResThumbUrls = new Map<string, string>();

// Global concurrency limiter for thumbnail loading
const MAX_CONCURRENT_LOADS = 8;
let activeLoads = 0;
const loadQueue: Array<() => void> = [];

/** Evict oldest thumbnails from MapLibre when over the cap */
function evictThumbnails(mapInstance: maplibregl.Map) {
  while (thumbLruOrder.length > MAX_CACHED_THUMBNAILS) {
    const oldId = thumbLruOrder.shift()!;
    const markerName = `marker-${oldId}`;
    if (mapInstance.hasImage(markerName)) {
      mapInstance.removeImage(markerName);
    }
    loadedThumbnails.delete(oldId);
  }
}

/** Touch an ID in the LRU list (move to end) */
function touchThumbLru(imageId: string) {
  const idx = thumbLruOrder.indexOf(imageId);
  if (idx > -1) thumbLruOrder.splice(idx, 1);
  thumbLruOrder.push(imageId);
}

// ── Pre-computed GeoJSON (avoids rebuilding ~2000 features on every zoom/pan) ──

// Static heatmap FeatureCollection – set once on the source, never updated
const HEATMAP_FEATURE_COLLECTION = {
  type: "FeatureCollection" as const,
  features: locationsData.locations.map((loc) => ({
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [loc.lng, loc.lat] },
    properties: {
      id: loc.id,
      mag: loc.tier === 1 ? 1 : loc.tier === 2 ? 0.6 : loc.tier === 3 ? 0.3 : 0.15,
    },
  })),
};

// Pre-built marker collections for each tier threshold
const buildTierCollection = (maxTier: number) => ({
  type: "FeatureCollection" as const,
  features: locationsData.locations
    .filter((loc) => loc.tier <= maxTier)
    .map((loc) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [loc.lng, loc.lat] },
      properties: { id: loc.id, city: loc.city, tier: loc.tier },
    })),
});

const TIER_COLLECTIONS: Record<
  number,
  ReturnType<typeof buildTierCollection>
> = {
  0: { type: "FeatureCollection", features: [] }, // zoom < 4
  1: buildTierCollection(1),
  2: buildTierCollection(2),
  3: buildTierCollection(3),
  4: buildTierCollection(4),
};

interface RecentLocation {
  id: string;
  city: string;
  lat: number;
  lng: number;
  thumbUrl?: string;
}

function saveRecentLocation(entry: RecentLocation): void {
  try {
    const stored = localStorage.getItem("streetview_recent_locations");
    const existing: RecentLocation[] = stored ? JSON.parse(stored) : [];
    const updated = [entry, ...existing.filter((r) => r.id !== entry.id && PANORAMA_BY_ID.has(r.id))].slice(
      0,
      5,
    );
    localStorage.setItem(
      "streetview_recent_locations",
      JSON.stringify(updated),
    );
  } catch {
    /* ignore */
  }
}

// Simple debounce helper
function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: any[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as unknown as T;
}

// Create circular-clipped marker image from an HTMLImageElement
function createCircularMarkerImage(
  img: HTMLImageElement,
  outputSize = 256,
  borderWidth = 8,
  alpha = 1.0,
): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext("2d")!;

  ctx.globalAlpha = alpha;

  ctx.save();
  ctx.beginPath();
  ctx.arc(
    outputSize / 2,
    outputSize / 2,
    outputSize / 2 - borderWidth,
    0,
    Math.PI * 2,
  );
  ctx.closePath();
  ctx.clip();

  const srcSize = Math.min(img.width, img.height);
  const srcX = (img.width - srcSize) / 2;
  const srcY = (img.height - srcSize) / 2;
  ctx.drawImage(
    img,
    srcX,
    srcY,
    srcSize,
    srcSize,
    0,
    0,
    outputSize,
    outputSize,
  );

  ctx.restore();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(
    outputSize / 2,
    outputSize / 2,
    outputSize / 2 - borderWidth / 2,
    0,
    Math.PI * 2,
  );
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = borderWidth;
  ctx.stroke();

  return ctx.getImageData(0, 0, outputSize, outputSize);
}

// Load a single thumbnail and add it as a named image to the map
function loadThumbnailForMarker(mapInstance: maplibregl.Map, imageId: string) {
  // Skip if already fully loaded or currently loading
  if (loadedThumbnails.has(imageId) || loadingThumbnails.has(imageId)) return;
  loadingThumbnails.add(imageId);

  const doLoad = async () => {
    activeLoads++;
    try {
      const thumbUrl = panoramaThumbnail(imageId);
      if (!thumbUrl) throw new Error("No thumbnail URL returned");

      // Step 2: Load the CDN image (no auth needed for CDN URLs)
      const img = new Image();
      img.crossOrigin = "anonymous";

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject();
        img.src = thumbUrl;
      });

      const markerName = `marker-${imageId}`;

      const imageData = createCircularMarkerImage(img, 256, 8, 1.0);

      if (mapInstance.hasImage(markerName)) {
        mapInstance.removeImage(markerName);
      }
      mapInstance.addImage(markerName, imageData);

      loadedThumbnails.add(imageId);
      touchThumbLru(imageId);
      evictThumbnails(mapInstance);
      thumbCdnUrls.set(imageId, thumbUrl);
    } catch {
      // Allow retry on failure
    }
    loadingThumbnails.delete(imageId);
    activeLoads--;
    // Kick off next queued load
    if (loadQueue.length > 0) {
      const next = loadQueue.shift()!;
      next();
    }
  };

  // If under concurrency limit, start immediately; otherwise queue
  if (activeLoads < MAX_CONCURRENT_LOADS) {
    doLoad();
  } else {
    loadQueue.push(doLoad);
  }
}

// Prefetch high-res thumbnail on hover
async function prefetchHighResThumbnail(imageId: string) {
  if (highResThumbUrls.has(imageId)) return;

  try {
    const highResUrl = panoramaThumbnail(imageId, true);
    if (!highResUrl) return;

    // Preload image — only store URL once browser has it cached
    await new Promise<void>((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => { highResThumbUrls.set(imageId, highResUrl); resolve(); };
      img.onerror = () => resolve();
      img.src = highResUrl;
    });
  } catch (e) {
    // Ignore errors
  }
}

// Batch-load thumbnails for all visible features
function loadVisibleThumbnails(mapInstance: maplibregl.Map) {
  const features = mapInstance.queryRenderedFeatures(undefined, {
    layers: ["circles-image"],
  });
  if (!features || features.length === 0) return;

  for (const feature of features) {
    const id = feature.properties?.id;
    if (id && !loadedThumbnails.has(id) && !loadingThumbnails.has(id)) {
      loadThumbnailForMarker(mapInstance, id);
    }
  }
}

// Preload thumbnails for locations within the current viewport bounds
// Works even before markers are visible — uses raw location data instead of rendered features
function preloadViewportThumbnails(mapInstance: maplibregl.Map) {
  const bounds = mapInstance.getBounds();
  // Expand bounds by ~25% to preload nearby markers that might scroll into view
  const lngPad = (bounds.getEast() - bounds.getWest()) * 0.25;
  const latPad = (bounds.getNorth() - bounds.getSouth()) * 0.25;
  const west = bounds.getWest() - lngPad;
  const east = bounds.getEast() + lngPad;
  const south = bounds.getSouth() - latPad;
  const north = bounds.getNorth() + latPad;

  const zoom = mapInstance.getZoom();
  const maxTier = getMaxTier(zoom);

  let queued = 0;
  const MAX_PRELOAD = 20; // Cap to avoid flooding the queue

  for (const loc of locationsData.locations) {
    if (queued >= MAX_PRELOAD) break;
    // Only preload locations that would be shown at the current tier threshold
    if (loc.tier > maxTier && maxTier > 0) continue;
    // Skip if already loaded or loading
    if (loadedThumbnails.has(loc.id) || loadingThumbnails.has(loc.id)) continue;
    // Check if location is within padded viewport
    if (
      loc.lng >= west &&
      loc.lng <= east &&
      loc.lat >= south &&
      loc.lat <= north
    ) {
      loadThumbnailForMarker(mapInstance, loc.id);
      queued++;
    }
  }
}

// Satellite Hybrid Style (Imagery + Labels)
const MAP_STYLE = {
  version: 8,
  projection: { type: "globe" },
  sky: {
    "atmosphere-blend": [
      "interpolate",
      ["linear"],
      ["zoom"],
      0, 0.5,
      5, 0.3,
      7, 0,
    ],
  },
  light: {
    anchor: "map",
    position: [1.5, 90, 80],
  },
  sources: {
    "arcgis-satellite": {
      type: "raster",
      tiles: [
        "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg",
      ],
      tileSize: 256,
      attribution: "&copy; EOX IT Services GmbH - S2 Cloudless",
    },
    "arcgis-labels": {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution: "&copy; Esri",
    },
  },
  layers: [
    {
      id: "background",
      type: "background",
      paint: {
        "background-color": "#080E1A", // Deep space
      },
    },
    {
      id: "arcgis-satellite-layer",
      type: "raster",
      source: "arcgis-satellite",
      minzoom: 0,
      maxzoom: 22,
    },
    {
      id: "arcgis-labels-layer",
      type: "raster",
      source: "arcgis-labels",
      minzoom: 0,
      maxzoom: 22,
    },
  ],
};

// Derive the maxTier threshold from zoom level
function getMaxTier(zoom: number): number {
  if (zoom < 4) return 0;
  if (zoom >= 10) return 3;
  if (zoom >= 7) return 2;
  return 1;
}

function Heatmap() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedFeature, setSelectedFeature] = useState<any>(null);
  const selectedFeatureRef = useRef<any>(null);
  const preClickCameraRef = useRef<any>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [isCardClosing, setIsCardClosing] = useState(false);
  const [cardRelated, setCardRelated] = useState<RecentLocation[]>([]);
  const cardSheetRef = useRef<HTMLDivElement>(null);
  const cardSheetDrag = useRef<{ startY: number; dragging: boolean; velocity: number; lastY: number; lastTime: number } | null>(null);
  const [showWelcome, setShowWelcome] = useState(
    () => !sessionStorage.getItem("preClickCamera"),
  );
  // Keep explore logic for future gallery use
  const [, setShowExploreBtn] = useState(
    () => !sessionStorage.getItem("preClickCamera"),
  );
  const [recentLocations, setRecentLocations] = useState<RecentLocation[]>([]);
  const [popularLocations, setPopularLocations] = useState<RecentLocation[]>(
    [],
  );
  const [discoverEntries, setDiscoverEntries] = useState<{ image_id: string; like_count: number; screenshot_url: string; city: string; lat: number; lng: number }[]>([]);
  const [bottomSheetDataReady, setBottomSheetDataReady] = useState(false);
  const [sidebarInkLevel, setSidebarInkLevel] = useState<number | null>(null);
  const [tier, setTier] = useState<PlusTier | null>(null);
  const [user, setUser] = useState<any>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authStep, setAuthStep] = useState<"idle" | "sending" | "sent">("idle");
  const [isAuthModalClosing, setIsAuthModalClosing] = useState(false);
  const [showPlusSheet, setShowPlusSheet] = useState(false);
  const [isPlusSheetClosing, setIsPlusSheetClosing] = useState(false);
  const [showAccountSheet, setShowAccountSheet] = useState(false);
  const [isAccountSheetClosing, setIsAccountSheetClosing] = useState(false);
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  useEffect(() => {
    if (!!localStorage.getItem('tutorialSeen') && !localStorage.getItem('whatsNewSeen_v3')) {
      const timer = setTimeout(() => setShowWhatsNew(true), 2000);
      return () => clearTimeout(timer);
    }
  }, []);
  const [isWhatsNewClosing, setIsWhatsNewClosing] = useState(false);
  const [bottomSheetState, setBottomSheetState] = useState<'collapsed' | 'half' | 'full'>(() => window.innerWidth > 600 ? 'full' : 'collapsed');
  const [bottomSheetSearchActive, setBottomSheetSearchActive] = useState(false);
  const [bottomSheetSearchQuery, setBottomSheetSearchQuery] = useState('');
  const bottomSheetDrag = useRef<{ startY: number; startX?: number; dragging: boolean; fromContent?: boolean; lastY: number; lastTime: number; velocity: number; startHeight?: number; onCarousel?: boolean; directionLocked?: boolean } | null>(null);
  const bottomSheetRef = useRef<HTMLDivElement>(null);
  const bottomSheetContentRef = useRef<HTMLDivElement>(null);
  const bottomSheetSearchInputRef = useRef<HTMLInputElement>(null);
  const watermarkRef = useRef<HTMLDivElement>(null);
  const isDesktop = typeof window !== 'undefined' && window.innerWidth > 600;
  const WATERMARK_GAP = 14;
  const SHEET_HEADER_HEIGHT = 60;
  const [sheetHeight, setSheetHeight] = useState(SHEET_HEADER_HEIGHT);
  const [desktopSheetHeight, setDesktopSheetHeight] = useState<string | undefined>(undefined);
  const [isDesktopDragging, setIsDesktopDragging] = useState(false);
  const [returningTransition, setReturningTransition] = useState<{
    active: boolean;
    x: number;
    y: number;
  } | null>(null);

  // Refs for map listeners to avoid stale closures
  const showWelcomeRef = useRef(showWelcome);
  const isClosingRef = useRef(isClosing);
  const lastZoomRef = useRef(0);
  const strokeCountsRef = useRef<Record<string, number>>({});
  const pulseAnimFrameRef = useRef<number>(0);

  useEffect(() => {
    showWelcomeRef.current = showWelcome;
    isClosingRef.current = isClosing;
  }, [showWelcome, isClosing]);

  // Track bottom sheet position for watermark
  useEffect(() => {
    if (isDesktop) return;
    let rafId: number;
    const update = () => {
      if (bottomSheetRef.current) {
        const rect = bottomSheetRef.current.getBoundingClientRect();
        setSheetHeight(window.innerHeight - rect.top);
      }
      rafId = requestAnimationFrame(update);
    };
    rafId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(rafId);
  }, [isDesktop]);


  // Auth state listener
  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      if (session?.user?.id) {
        fetchSubscriptionTier(session.user.id).then((tier) => {
          setTier(tier);
          if (event === 'INITIAL_SESSION') {
            fetchInkLevel(session.user.id, tier.maxInk).then(setSidebarInkLevel);
          }
          if (sessionStorage.getItem("intentToSubscribe")) {
            sessionStorage.removeItem("intentToSubscribe");
            createCheckoutSession().then((url) => {
              if (url) window.location.href = url;
            });
          }
        });
      } else {
        setTier(null);
        if (event === 'INITIAL_SESSION') {
          fetchInkLevel(undefined, GUEST_TIER.maxInk).then(setSidebarInkLevel);
        }
      }
    });
    return () => subscription.unsubscribe();
  }, []);



  // Fetch related locations for the selected feature
  useEffect(() => {
    if (!selectedFeature?.id) {
      setCardRelated([]);
      return;
    }
    let cancelled = false;

    // Find nearby locations
    if (selectedFeature.coordinates) {
      const [lng, lat] = selectedFeature.coordinates;
      const nearby = locationsData.locations
        .filter((l) => l.id !== selectedFeature.id)
        .map((l) => ({
          ...l,
          dist: Math.hypot(l.lat - lat, l.lng - lng),
        }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 8);

      // Fetch thumbnails for related locations
      Promise.all(
        nearby.map(async (loc) => {
          const cached = highResThumbUrls.get(loc.id) || thumbCdnUrls.get(loc.id);
          if (cached) return { id: loc.id, city: loc.city, lat: loc.lat, lng: loc.lng, thumbUrl: cached } as RecentLocation;
          const thumbUrl = panoramaThumbnail(loc.id);
          if (thumbUrl) thumbCdnUrls.set(loc.id, thumbUrl);
          return { id: loc.id, city: loc.city, lat: loc.lat, lng: loc.lng, thumbUrl: thumbUrl || undefined } as RecentLocation;
        }),
      ).then((results) => {
        if (!cancelled) setCardRelated(results);
      });


    }

    return () => { cancelled = true; };
  }, [selectedFeature?.id]);

  // Collapse animation state (when returning from panorama)
  // Ref must be declared before useState so the lazy initializer can populate it
  const collapseDataRef = useRef<{
    markerLng: number;
    markerLat: number;
    thumbUrl: string;
    imageId: string;
  } | null>(null);
  // Initialize synchronously from sessionStorage so the overlay is present on the very first render
  // (avoids a flicker where the MapLibre map is briefly visible before the overlay mounts)
  const [collapseAnim, setCollapseAnim] = useState<{
    thumbX: number;
    thumbY: number;
    thumbUrl: string;
    markerSize: number;
    active: boolean;
    opacity: number;
  } | null>(() => {
    const stored = sessionStorage.getItem("collapseAnimation");
    if (stored) {
      sessionStorage.removeItem("collapseAnimation");
      const data = JSON.parse(stored);
      collapseDataRef.current = data;
      return {
        thumbX: window.innerWidth / 2,
        thumbY: window.innerHeight / 2,
        thumbUrl: data.thumbUrl,
        markerSize: 100,
        active: false,
        opacity: 1,
      };
    }
    return null;
  });
  const collapseTrackRef = useRef<(() => void) | null>(null);
  const collapseFlyToRef = useRef<{
    center: [number, number];
    zoom: number;
    pitch: number;
    bearing: number;
  } | null>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("streetview_recent_locations");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) setRecentLocations(parsed.filter((item: RecentLocation) => MAP_LOCATIONS.some(loc => loc.id === item.id)).map((item: RecentLocation) => ({ ...item, thumbUrl: panoramaThumbnail(item.id) || undefined })));
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    supabase.rpc("top_image_ids", { lim: 5 }).then(async ({ data, error }) => {
      if (error || !data || data.length === 0) return;
      const top5Entries = (data as { image_id: string; count: number }[])
        .map(({ image_id: id }) => {
          const loc = locationsData.locations.find((l) => l.id === id);
          if (!loc) return null;
          return {
            id,
            city: loc.city,
            lat: loc.lat,
            lng: loc.lng,
          } as RecentLocation;
        })
        .filter(Boolean) as RecentLocation[];
      setPopularLocations(top5Entries);

      // Fetch thumbnails in parallel, then update with URLs
      const withThumbs = await Promise.all(
        top5Entries.map(async (loc) => {
          const cached =
            highResThumbUrls.get(loc.id) || thumbCdnUrls.get(loc.id);
          if (cached) return { ...loc, thumbUrl: cached };
          const thumbUrl = panoramaThumbnail(loc.id);
          if (thumbUrl) thumbCdnUrls.set(loc.id, thumbUrl);
          return { ...loc, thumbUrl: thumbUrl || undefined };
        }),
      );
      setPopularLocations(withThumbs);
    });
  }, []);

  // Fetch discover feed
  useEffect(() => {
    supabase.rpc('discover_feed', { lim: 20 }).then(({ data, error }) => {
      if (error || !data || data.length === 0) return;
      const entries = (data as { image_id: string; screenshot_url: string; like_count: number; updated_at: string }[])
        .map((row) => {
          const loc = locationsData.locations.find((l) => l.id === row.image_id);
          if (!loc) return null;
          return {
            image_id: row.image_id,
            like_count: Number(row.like_count),
            screenshot_url: row.screenshot_url,
            city: loc.city,
            lat: loc.lat,
            lng: loc.lng,
          };
        })
        .filter(Boolean) as { image_id: string; like_count: number; screenshot_url: string; city: string; lat: number; lng: number }[];
      setDiscoverEntries(entries);
    });
  }, []);

  // Delay bottomSheetDataReady until images are actually available, then flip one frame later for CSS transition
  useEffect(() => {
    if (bottomSheetDataReady) return;
    const hasPopularThumbs = popularLocations.length > 0 && popularLocations.some(l => l.thumbUrl);
    const hasDiscover = discoverEntries.length > 0;
    if (hasPopularThumbs || hasDiscover) {
      requestAnimationFrame(() => setBottomSheetDataReady(true));
    }
  }, [popularLocations, discoverEntries, bottomSheetDataReady]);

  const [transition, setTransition] = useState<{
    active: boolean;
    startX: number;
    startY: number;
    startSize: number;
  } | null>(null);

  const [transitionCoords, setTransitionCoords] = useState<any>(null);
  const transitioningRef = useRef(false);

  const triggerTransition = (
    screenX: number,
    screenY: number,
    size: number = 100,
    coords?: [number, number],
    cameraState?: any,
    imageId?: string,
  ) => {
    if (transitioningRef.current) return;
    transitioningRef.current = true;
    setTransition({
      active: true,
      startX: screenX,
      startY: screenY,
      startSize: size,
    });
    if (coords) {
      setTransitionCoords({
        marker: coords,
        camera: cameraState,
        imageId: imageId || null,
        thumbX: screenX,
        thumbY: screenY,
      });
    }

    // Persist pre-click camera to sessionStorage so it survives component remount
    if (cameraState) {
      sessionStorage.setItem(
        "preClickCamera",
        JSON.stringify({
          center: [
            cameraState.center.lng ?? cameraState.center[0],
            cameraState.center.lat ?? cameraState.center[1],
          ],
          zoom: cameraState.zoom,
          pitch: cameraState.pitch,
          bearing: cameraState.bearing,
        }),
      );
    }

    // Save to recent locations
    if (coords && imageId) {
      const loc = locationsData.locations.find((l) => l.id === imageId);
      if (loc) {
        const thumbUrl =
          highResThumbUrls.get(imageId) || thumbCdnUrls.get(imageId);
        const entry: RecentLocation = {
          id: imageId,
          city: loc.city,
          lat: coords[1],
          lng: coords[0],
          ...(thumbUrl ? { thumbUrl } : {}),
        };
        saveRecentLocation(entry);
        setRecentLocations((prev) =>
          [entry, ...prev.filter((r) => r.id !== imageId)].slice(0, 5),
        );
      }
    }

    // Wait for the expansion animation to mostly complete before navigating
    setTimeout(() => {
      let params = "";
      if (coords) {
        params = `?lng=${coords[0]}&lat=${coords[1]}`;
        if (cameraState) {
          params += `&camLng=${cameraState.center.lng}&camLat=${cameraState.center.lat}&zoom=${cameraState.zoom}&pitch=${cameraState.pitch}&bearing=${cameraState.bearing}`;
        }
        if (imageId) {
          params += `&imageId=${imageId}`;
          // Prefer high-res URL if available, else fallback to low-res
          const cdnUrl =
            highResThumbUrls.get(imageId) || thumbCdnUrls.get(imageId);
          if (cdnUrl) params += `&thumbUrl=${encodeURIComponent(cdnUrl)}`;
          // Pass thumbnail center relative to screen if needed, currently unused by App.tsx logic but kept for future
        }
      }
      navigate("/view" + params);
    }, 500);
  };

  const getMarkerSize = () => {
    if (!map.current) return 200;
    const zoom = map.current.getZoom();
    const minZoom = 4,
      maxZoom = 14;
    const minScale = 0.08,
      maxScale = 0.94;
    const baseSize = 256;
    const t = Math.max(0, Math.min(1, (zoom - minZoom) / (maxZoom - minZoom)));
    const scale = minScale + (maxScale - minScale) * t;
    return baseSize * scale;
  };

  const navigateToLocation = (loc: RecentLocation) => {
    if (!map.current) return;
    if (!isDesktop) {
      setBottomSheetState('collapsed');
    }
    setBottomSheetSearchActive(false);
    setBottomSheetSearchQuery('');
    if (!preClickCameraRef.current) {
      preClickCameraRef.current = {
        center: map.current.getCenter(),
        zoom: map.current.getZoom(),
        pitch: map.current.getPitch(),
        bearing: map.current.getBearing(),
      };
    }
    const coords: [number, number] = [loc.lng, loc.lat];
    loadThumbnailForMarker(map.current, loc.id);
    prefetchHighResThumbnail(loc.id);
    map.current.flyTo({ center: coords, zoom: 14, speed: 2.0 });
    map.current.once("moveend", () => {
      if (!map.current) return;
      const featureData = {
        id: loc.id,
        coordinates: coords,
        name: loc.city,
        time: "...",
      };
      setSelectedFeature(featureData);
      selectedFeatureRef.current = featureData;
      supabase
        .from("strokes")
        .select("created_at")
        .eq("image_id", loc.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .then(({ data, error }) => {
          if (error || !data) return;
          let timeAgo = "No activity";
          if (data.length > 0) {
            const latest = new Date(data[0].created_at);
            const diffMs = Date.now() - latest.getTime();
            const diffMin = Math.floor(diffMs / 60000);
            const diffHr = Math.floor(diffMin / 60);
            const diffDay = Math.floor(diffHr / 24);
            if (diffMin < 1) timeAgo = "Just now";
            else if (diffMin < 60) timeAgo = `${diffMin}m ago`;
            else if (diffHr < 24) timeAgo = `${diffHr}h ago`;
            else if (diffDay < 30) timeAgo = `${diffDay}d ago`;
            else timeAgo = latest.toLocaleDateString();
          }
          const updated = { ...featureData, time: timeAgo };
          if (selectedFeatureRef.current?.id === loc.id) {
            setSelectedFeature(updated);
            selectedFeatureRef.current = updated;
          }
        });
    });
  };

  // Handle returning from panorama - show reverse transition
  useEffect(() => {
    const lng = searchParams.get("lng");
    const lat = searchParams.get("lat");
    const camLng = searchParams.get("camLng");
    const camLat = searchParams.get("camLat");
    const zoom = searchParams.get("zoom");
    const pitch = searchParams.get("pitch");
    const bearing = searchParams.get("bearing");

    if (!lng || !lat || !map.current) return;

    // Wait for map to be ready, then calculate screen position
    const onLoad = () => {
      if (!map.current) return;
      const markerCoords: [number, number] = [parseFloat(lng), parseFloat(lat)];

      // Restore camera from sessionStorage (most reliable — survives component remount)
      const savedCamera = sessionStorage.getItem("preClickCamera");
      const hasCollapseAnim = !!collapseDataRef.current;
      if (savedCamera) {
        try {
          const cam = JSON.parse(savedCamera);
          if (hasCollapseAnim) {
            // Start zoomed in on the marker, then flyTo pre-click camera after collapse animation
            map.current.jumpTo({ center: markerCoords, zoom: 14 });
            collapseFlyToRef.current = {
              center: cam.center,
              zoom: cam.zoom,
              pitch: cam.pitch,
              bearing: cam.bearing,
            };
          } else {
            map.current.jumpTo({
              center: cam.center,
              zoom: cam.zoom,
              pitch: cam.pitch,
              bearing: cam.bearing,
            });
          }
          sessionStorage.removeItem("preClickCamera");
        } catch {
          map.current.jumpTo({ center: markerCoords, zoom: 14 });
        }
      } else if (
        camLng !== null &&
        camLat !== null &&
        zoom !== null &&
        pitch !== null &&
        bearing !== null
      ) {
        // User requesting to center on marker: use markerCoords as center
        // but keep the camera browsing state (zoom/pitch/bearing)
        map.current.jumpTo({
          center: markerCoords,
          zoom: parseFloat(zoom),
          pitch: parseFloat(pitch),
          bearing: parseFloat(bearing),
        });
      } else {
        map.current.jumpTo({ center: markerCoords, zoom: 14 });
      }

      // Immediately sync tier data after jumpTo to prevent wrong-tier markers flickering
      if (map.current) {
        const currentZoom = map.current.getZoom();
        const tier = getMaxTier(currentZoom);
        const circleSource = map.current.getSource(
          "circles-source",
        ) as maplibregl.GeoJSONSource;
        if (circleSource && TIER_COLLECTIONS[tier]) {
          circleSource.setData(TIER_COLLECTIONS[tier] as any);
        }
      }

      // Wait a frame for the map to render
      requestAnimationFrame(() => {
        if (!map.current) return;
        const screenPoint = map.current.project(markerCoords);
        setReturningTransition({
          active: true,
          x: screenPoint.x,
          y: screenPoint.y,
        });

        // Clear URL params and hide animation after it completes
        setTimeout(() => {
          setReturningTransition(null);
          setSearchParams({});

          // Show Plus sheet if user ran low on ink and isn't subscribed
          if (user && tier && !tier.isPlus) {
            fetchInkLevel(user.id, tier.maxInk).then((level) => {
              if (level < 15) setShowPlusSheet(true);
            });
          }
        }, 800);
      });
    };

    if (map.current.loaded()) {
      onLoad();
    } else {
      map.current.on("load", onLoad);
    }
  }, [searchParams, setSearchParams]);

  // Initialize Map
  useEffect(() => {
    if (map.current || !mapContainer.current) return;

    // Clear thumbnail caches so images get re-added to the fresh map instance
    // (fixes post-panorama bug where thumbnails were cached but not on the new map)
    loadedThumbnails.clear();
    loadingThumbnails.clear();
    thumbLruOrder.length = 0;

    const container = mapContainer.current;

    // Calculate initial zoom — globe on mobile, zoomed in on desktop
    const smallerDimension = Math.min(
      container.clientWidth,
      container.clientHeight,
    );
    const isDesktop = container.clientWidth >= 768;
    const initialZoom = isDesktop
      ? Math.log2(smallerDimension / 100) + 0.2
      : Math.log2(smallerDimension / 100) - 1.1;

    // Check for saved camera state (returning from panorama)
    let initialConfig = {
      center: [0, 40] as [number, number],
      zoom: initialZoom,
      pitch: 0,
      bearing: 0,
      isRestored: false,
    };

    const savedCamera = sessionStorage.getItem("preClickCamera");
    if (savedCamera) {
      try {
        const cam = JSON.parse(savedCamera);

        // If returning from panorama with marker coordinates, center on the marker
        // while preserving the user's previous zoom/pitch/bearing (from saved camera state)
        // Use saved camera center to restore exact view (don't recenter on marker)
        // This ensures the exit animation (animating to thumbX/thumbY) lines up
        // perfectly with the marker's position on the restored map.
        const center = cam.center;

        initialConfig = {
          center: center,
          zoom: cam.zoom,
          pitch: cam.pitch,
          bearing: cam.bearing,
          isRestored: true,
        };
        // Don't remove yet - let the load handler use it to stop rotation and ensure exact positioning
      } catch (e) {
        console.error("Failed to parse saved camera state", e);
      }
    }

    map.current = new maplibregl.Map({
      container: container,
      style: MAP_STYLE as any,
      center: initialConfig.center,
      zoom: initialConfig.zoom,
      pitch: initialConfig.pitch,
      bearing: initialConfig.bearing,
      minZoom: 0,
      maxZoom: 16,
      attributionControl: false, // Remove "i" icon
      // @ts-ignore
      projection: { type: "globe" },
    });

    // Increase scroll zoom speed for Mac trackpad
    (map.current.scrollZoom as any).setWheelZoomRate(1 / 50);

    // Auto-rotate globe animation (only if not returning from panorama)
    let isRotating = !initialConfig.isRestored;
    let animationFrameId: number;
    const rotationSpeed = 0.03;

    const rotateGlobe = () => {
      if (!map.current || !isRotating) return;
      const center = map.current.getCenter();
      center.lng += rotationSpeed;
      // Use jumpTo with explicit zoom to prevent any zoom drift
      map.current.jumpTo({ center, zoom: map.current.getZoom() });
      animationFrameId = requestAnimationFrame(rotateGlobe);
    };

    const stopRotation = () => {
      isRotating = false;
      lastInteractionTime = Date.now();
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };

    // Cooldown: don't resume rotation within 3s of the last user interaction
    let lastInteractionTime = 0;

    map.current.on("mousedown", stopRotation);
    map.current.on("touchstart", stopRotation);
    map.current.on("wheel", stopRotation);
    map.current.on("zoomstart", stopRotation);

    // (zoom clamping removed — users can freely zoom out to see the full globe)

    // Resume rotation when zoomed out (with cooldown)
    map.current.on("moveend", () => {
      if (!map.current) return;
      const zoom = map.current.getZoom();
      if (
        zoom <= 2.5 &&
        !isRotating &&
        Date.now() - lastInteractionTime > 3000
      ) {
        isRotating = true;
        rotateGlobe();
      }
    });

    map.current.on("load", () => {
      if (!map.current) return;

      // Add starfield behind the globe
      const starfield = new MaplibreStarfieldLayer({
        starCount: 4000,
        starSize: 2.0,
      });
      const firstLayerId = map.current.getStyle().layers[0]?.id;
      if (firstLayerId) {
        map.current.addLayer(starfield as any, firstLayerId);
      } else {
        map.current.addLayer(starfield as any);
      }

      // Force projection set to ensure it takes effect
      // @ts-ignore
      map.current.setProjection({ type: "globe" });

      // minZoom=0 allows full zoom out to see the globe

      // Restore camera if returning from panorama (ensure exact state after load)
      if (initialConfig.isRestored) {
        sessionStorage.removeItem("preClickCamera");
        // Don't start rotation — we are already at the restored position
        stopRotation();

        // Update collapse animation target with accurate screen coordinates and marker size
        if (collapseDataRef.current && map.current) {
          const { markerLng, markerLat } = collapseDataRef.current;

          // Jump to marker zoomed in — collapse animation will shrink from full-screen to this
          map.current.jumpTo({ center: [markerLng, markerLat], zoom: 14 });

          // Store the pre-click camera so flyTo runs after collapse finishes
          collapseFlyToRef.current = {
            center: initialConfig.center,
            zoom: initialConfig.zoom,
            pitch: initialConfig.pitch,
            bearing: initialConfig.bearing,
          };

          const screenPoint = map.current.project([markerLng, markerLat]);

          // Compute actual rendered marker size using the same icon-size stops as the map layer
          const computeMarkerSize = (z: number) => {
            const stops: [number, number][] = [
              [9, 0.42],
              [12, 0.62],
              [14, 0.88],
              [16, 1.1],
            ];
            let iconScale = stops[0][1];
            if (z >= stops[stops.length - 1][0]) {
              iconScale = stops[stops.length - 1][1];
            } else {
              for (let i = 0; i < stops.length - 1; i++) {
                if (z >= stops[i][0] && z <= stops[i + 1][0]) {
                  const t = (z - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
                  iconScale = stops[i][1] + t * (stops[i + 1][1] - stops[i][1]);
                  break;
                }
              }
            }
            return 256 * iconScale;
          };

          const z = map.current.getZoom();
          const size = computeMarkerSize(z);

          // Position is now known — start the shrink animation
          setCollapseAnim((prev) =>
            prev
              ? {
                ...prev,
                thumbX: screenPoint.x,
                thumbY: screenPoint.y,
                markerSize: size,
                opacity: 1,
                active: true,
              }
              : null,
          );

          // Track map movement so the overlay follows the marker
          const trackCollapse = () => {
            if (!map.current || !collapseDataRef.current) return;
            const pt = map.current.project([
              collapseDataRef.current.markerLng,
              collapseDataRef.current.markerLat,
            ]);
            const currentZoom = map.current.getZoom();
            const currentSize = computeMarkerSize(currentZoom);
            // Match real marker visibility: markers appear at zoom >= 9
            // Fade between zoom 8 and 9 to match the marker layer transition
            const opacity = Math.max(0, Math.min(1, currentZoom - 8));
            setCollapseAnim((prev) =>
              prev
                ? {
                  ...prev,
                  thumbX: pt.x,
                  thumbY: pt.y,
                  markerSize: currentSize,
                  opacity,
                }
                : null,
            );
          };
          map.current.on("move", trackCollapse);
          collapseTrackRef.current = trackCollapse;

          // Poll for the thumbnail to load, then remove overlay and fly back
          const markerImageId = collapseDataRef.current.imageId;
          const startTime = Date.now();
          const pollForMarker = () => {
            if (
              loadedThumbnails.has(markerImageId) ||
              Date.now() - startTime > 4000
            ) {
              setCollapseAnim(null);
              collapseDataRef.current = null;
              if (collapseTrackRef.current && map.current) {
                map.current.off("move", collapseTrackRef.current);
                collapseTrackRef.current = null;
              }
              if (collapseFlyToRef.current && map.current) {
                map.current.flyTo({ ...collapseFlyToRef.current, speed: 2.0 });
                collapseFlyToRef.current = null;
              }
            } else {
              setTimeout(pollForMarker, 100);
            }
          };
          // Start polling after shrink animation completes (600ms)
          setTimeout(pollForMarker, 600);
        }
      } else {
        // Normal load — start globe rotation
        rotateGlobe();
      }

      addHeatmapLayer(map.current);

      // Click on heatmap blobs → flyTo nearest marker cluster so markers become visible
      map.current.on("click", "heatmap-layer", (e) => {
        // Don't handle if markers are already visible (zoom >= 9)
        if (!map.current || map.current.getZoom() >= 9) return;

        // Find the nearest marker to the click point
        const clickLng = e.lngLat.lng;
        const clickLat = e.lngLat.lat;
        let nearestCoords: [number, number] = [clickLng, clickLat];
        let nearestDist = Infinity;

        for (const loc of locationsData.locations) {
          const dx = loc.lng - clickLng;
          const dy = loc.lat - clickLat;
          const dist = dx * dx + dy * dy;
          if (dist < nearestDist) {
            nearestDist = dist;
            nearestCoords = [loc.lng, loc.lat];
          }
        }

        // Immediately preload thumbnails near the destination so they're ready when markers appear
        const destLng = nearestCoords[0];
        const destLat = nearestCoords[1];
        let preloaded = 0;
        // Sort locations by distance to destination and preload the closest ones
        const nearby = locationsData.locations
          .map((loc) => ({
            ...loc,
            dist: (loc.lng - destLng) ** 2 + (loc.lat - destLat) ** 2,
          }))
          .sort((a, b) => a.dist - b.dist)
          .slice(0, 20);
        for (const loc of nearby) {
          if (preloaded >= 20) break;
          loadThumbnailForMarker(map.current, loc.id);
          preloaded++;
        }

        map.current.flyTo({
          center: nearestCoords,
          zoom: 10,
          speed: 2.0,
        });

        // Also preload whatever is in viewport once flyTo finishes
        map.current.once("moveend", () => {
          if (map.current) preloadViewportThumbnails(map.current);
        });
      });

      // Change cursor on heatmap hover
      map.current.on("mouseenter", "heatmap-layer", () => {
        if (map.current && map.current.getZoom() < 9) {
          map.current.getCanvas().style.cursor = "pointer";
        }
      });
      map.current.on("mouseleave", "heatmap-layer", () => {
        if (map.current) map.current.getCanvas().style.cursor = "";
      });

      // Add interactivity for circles (Click -> Show Sidebar)
      map.current.on("click", "circles-image", (e) => {
        if (!e.features || e.features.length === 0) return;
        // Don't handle marker clicks when they're not visible (heatmap zoom)
        if (map.current && map.current.getZoom() < 9) return;
        const feature = e.features[0];

        // Save camera state before zooming in
        // Save camera state before zooming in (only if not already saved)
        if (map.current && !preClickCameraRef.current) {
          preClickCameraRef.current = {
            center: map.current.getCenter(),
            zoom: map.current.getZoom(),
            pitch: map.current.getPitch(),
            bearing: map.current.getBearing(),
          };
        }

        const coords = (feature.geometry as GeoJSON.Point).coordinates;

        // Fly to location
        map.current?.easeTo({
          center: coords as [number, number],
          zoom: 14,
          duration: 800,
        });

        const imageId = feature.properties?.id;
        const cityName = feature.properties?.city || "Unknown Location";

        // Start loading thumbnail immediately so it's ready when flyTo completes
        if (imageId && map.current) {
          loadThumbnailForMarker(map.current, imageId);
          prefetchHighResThumbnail(imageId);
        }

        const featureData = {
          id: imageId,
          coordinates: coords,
          name: cityName,
          time: "...",
        };
        setSelectedFeature(featureData);
        selectedFeatureRef.current = featureData;

        // Fetch last activity from Supabase
        if (imageId) {
          supabase
            .from("strokes")
            .select("created_at")
            .eq("image_id", imageId)
            .order("created_at", { ascending: false })
            .limit(1)
            .then(({ data, error }) => {
              if (error || !data) return;
              let timeAgo = "No activity";
              if (data.length > 0) {
                const latest = new Date(data[0].created_at);
                const diffMs = Date.now() - latest.getTime();
                const diffMin = Math.floor(diffMs / 60000);
                const diffHr = Math.floor(diffMin / 60);
                const diffDay = Math.floor(diffHr / 24);
                if (diffMin < 1) timeAgo = "Just now";
                else if (diffMin < 60) timeAgo = `${diffMin}m ago`;
                else if (diffHr < 24) timeAgo = `${diffHr}h ago`;
                else if (diffDay < 30) timeAgo = `${diffDay}d ago`;
                else timeAgo = latest.toLocaleDateString();
              }
              const updated = { ...featureData, time: timeAgo };
              if (selectedFeatureRef.current?.id === imageId) {
                setSelectedFeature(updated);
                selectedFeatureRef.current = updated;
              }
            });
        }
      });

      // Unified function to close info card and revert zoom on manual interaction
      const cancelSelection = (e?: any) => {
        // Only trigger if manually interacting (check for originalEvent on zoomstart)
        if (e?.type === "zoomstart" && !e.originalEvent) return;

        if (selectedFeatureRef.current) {
          setIsCardClosing(true);
          setTimeout(() => {
            setSelectedFeature(null);
            selectedFeatureRef.current = null;
            setIsCardClosing(false);
            // Zoom back out
            if (map.current && preClickCameraRef.current) {
              map.current.flyTo({ ...preClickCameraRef.current, speed: 2.0 });
              preClickCameraRef.current = null;
            }
          }, 350);
        }
      };

      // Close info card and zoom out when user drags/moves/zooms the map manually
      map.current.on("dragstart", cancelSelection);
      map.current.on("wheel", cancelSelection);
      map.current.on("zoomstart", cancelSelection);

      // Double-click to trigger transition from marker center
      map.current.on("dblclick", "circles-image", (e) => {
        e.originalEvent.preventDefault();
        if (!e.features || e.features.length === 0 || !map.current) return;
        const feature = e.features[0];
        // @ts-ignore
        const coords = feature.geometry.coordinates;
        const screenPoint = map.current.project(coords);
        // Save pre-click camera if not already saved (for direct double-click without single-click first)
        if (!preClickCameraRef.current) {
          preClickCameraRef.current = {
            center: map.current.getCenter(),
            zoom: map.current.getZoom(),
            pitch: map.current.getPitch(),
            bearing: map.current.getBearing(),
          };
        }
        const cameraState = preClickCameraRef.current;
        const featureImageId = feature.properties?.id;

        // Prefetch high-res on click immediate to ensure it loads asap if hover didn't catch it
        if (featureImageId) prefetchHighResThumbnail(featureImageId);

        triggerTransition(
          screenPoint.x,
          screenPoint.y,
          getMarkerSize(),
          coords,
          cameraState,
          featureImageId,
        );
      });

      // Change cursor to pointer on hover and prefetch high-res
      map.current.on("mouseenter", "circles-image", (e) => {
        if (map.current) map.current.getCanvas().style.cursor = "pointer";

        // Prefetch high-res image
        if (e.features && e.features.length > 0) {
          const id = e.features[0].properties?.id;
          if (id) prefetchHighResThumbnail(id);
        }
      });
      map.current.on("mouseleave", "circles-image", () => {
        if (map.current) map.current.getCanvas().style.cursor = "";
      });

      // Add atmosphere/fog for nicer globe look
      // @ts-ignore
      if (map.current.setFog) {
        // @ts-ignore
        map.current.setFog({
          range: [0.5, 10],
          color: "#242b4b",
          "horizon-blend": 0.1,
        });
      }

      // Dynamic projection switching & Auto-hide welcome
      map.current.on("zoomstart", () => {
        if (map.current) lastZoomRef.current = map.current.getZoom();
      });

      map.current.on("zoom", () => {
        if (!map.current) return;
        const zoom = map.current.getZoom();

        // // Hide welcome modal only on significant zoom in (> 0.3 levels)
        // if (showWelcomeRef.current && !isClosingRef.current && (zoom - lastZoomRef.current) > 0.3) {
        //   isClosingRef.current = true;
        //   setIsClosing(true);
        //   setTimeout(() => {
        //     setShowWelcome(false);
        //     showWelcomeRef.current = false;
        //     setIsClosing(false);
        //     isClosingRef.current = false;
        //   }, 450);
        // }

        // Fade out Start Exploring button when zoomed in, reappear only at default globe view
        if (zoom > 2.5) {
          setShowExploreBtn(false);
        } else {
          setShowExploreBtn(true);
        }

        // Switch projection only once per threshold crossing (not every zoom tick)
        // @ts-ignore
        const currentProjection = map.current.getProjection()?.type;

        if (zoom > 5.5 && currentProjection === "globe") {
          // @ts-ignore
          map.current.setProjection({ type: "mercator" });
          // @ts-ignore
          if (map.current.setFog) {
            // @ts-ignore
            map.current.setFog(null);
          }
        } else if (zoom <= 4.5 && currentProjection !== "globe") {
          // @ts-ignore
          map.current.setProjection({ type: "globe" });
          // @ts-ignore
          if (map.current.setFog) {
            // @ts-ignore
            map.current.setFog({
              range: [0.5, 10],
              color: "#242b4b",
              "horizon-blend": 0.1,
            });
          }
        }
      });

      // Set heatmap data once — it's static and never changes
      const heatmapSource = map.current.getSource(
        "heatmap-source",
      ) as maplibregl.GeoJSONSource;
      if (heatmapSource) {
        heatmapSource.setData(HEATMAP_FEATURE_COLLECTION as any);
      }

      // Load ALL marker features once — no tier-swapping or clustering
      // so the opacity transition handles smooth show/hide cleanly
      const circleSource = map.current.getSource(
        "circles-source",
      ) as maplibregl.GeoJSONSource;
      if (circleSource) {
        circleSource.setData(TIER_COLLECTIONS[4] as any);
      }

      // Fetch stroke counts and set up pulse ring circle layer
      (async () => {
        const counts: Record<string, number> = {};
        const { data, error } = await supabase.rpc("get_stroke_counts");
        if (!error && data) {
          for (const row of data) {
            counts[row.image_id] = Number(row.count);
          }
        }
        strokeCountsRef.current = counts;
        const m = map.current;
        if (!m) return;

        // Build a dedicated GeoJSON source with stroke counts as properties
        const strokeIds = Object.keys(counts);
        if (strokeIds.length === 0) return;

        const locMap = new Map(locationsData.locations.map((l) => [l.id, l]));
        const pulseFeatures = strokeIds
          .filter((id) => locMap.has(id))
          .map((id) => {
            const loc = locMap.get(id)!;
            const count = counts[id];
            return {
              type: "Feature" as const,
              geometry: {
                type: "Point" as const,
                coordinates: [loc.lng, loc.lat],
              },
              properties: {
                id: loc.id,
                strokeCount: count,
                // Normalize: 0→1 where 1 = 1000+ strokes
                intensity: Math.min(1, count / 1000),
              },
            };
          });

        m.addSource("pulse-source", {
          type: "geojson",
          data: { type: "FeatureCollection", features: pulseFeatures },
        });

        // Add 5 radiating circle layers with staggered phases
        const NUM_RINGS = 5;
        for (let i = 0; i < NUM_RINGS; i++) {
          m.addLayer(
            {
              id: `pulse-circle-${i}`,
              type: "circle",
              source: "pulse-source",
              minzoom: 9,
              paint: {
                "circle-radius": 0,
                "circle-color": [
                  "interpolate",
                  ["linear"],
                  ["get", "intensity"],
                  0,
                  "rgba(255, 255, 255, 0.15)",
                  0.3,
                  "rgba(255, 255, 255, 0.25)",
                  0.7,
                  "rgba(255, 255, 255, 0.35)",
                  1.0,
                  "rgba(255, 255, 255, 0.45)",
                ],
                "circle-opacity": 0,
              },
              // @ts-ignore
            },
            "circles-image",
          );
        }

        // Animation loop: each ring radiates outward at a staggered phase
        // Faster cycle = more rapid firing feel
        const CYCLE_MS = 2000;
        const startTime = performance.now();

        let lastPulseUpdate = 0;
        const PULSE_INTERVAL = 100; // ~10fps — balances smoothness with performance

        // Pre-allocate step arrays per ring (avoid creating new arrays every frame)
        const opacitySteps: any[][] = [];
        for (let i = 0; i < NUM_RINGS; i++) {
          opacitySteps.push([
            "step",
            ["get", "strokeCount"],
            i === 0 ? 1 : 0, // <5 strokes: 1 ring (calm)
            5,
            i <= 1 ? 1 : 0, // 5-19: 2 rings
            20,
            i <= 2 ? 1 : 0, // 20-99: 3 rings
            100,
            i <= 3 ? 1 : 0, // 100-499: 4 rings (busy)
            500,
            1, // 500+: all 5 rings (intense)
          ]);
        }

        const animatePulse = () => {
          if (!map.current) return;
          const now = performance.now();

          // Throttle updates
          if (now - lastPulseUpdate < PULSE_INTERVAL) {
            pulseAnimFrameRef.current = requestAnimationFrame(animatePulse);
            return;
          }
          lastPulseUpdate = now;

          const zoom = map.current.getZoom();

          // Skip entirely when rings aren't visible (minzoom: 9)
          if (zoom < 9) {
            pulseAnimFrameRef.current = requestAnimationFrame(animatePulse);
            return;
          }

          // Match icon-size interpolation
          const s9 = 0.42;
          const s12 = 0.62;
          const s14 = 0.88;
          const s16 = 1.1;
          const iconScale =
            zoom <= 9
              ? s9
              : zoom >= 16
                ? s16
                : zoom <= 12
                  ? s9 + ((zoom - 9) / 3) * (s12 - s9)
                  : zoom <= 14
                    ? s12 + ((zoom - 12) / 2) * (s14 - s12)
                    : s14 + ((zoom - 14) / 2) * (s16 - s14);
          const baseRadius = (256 * iconScale) / 2;

          for (let i = 0; i < NUM_RINGS; i++) {
            const layerId = `pulse-circle-${i}`;
            if (!map.current.getLayer(layerId)) {
              return;
            }

            // Stagger each ring by 1/5 of the cycle
            const phase = i / NUM_RINGS;
            const t = ((now - startTime) / CYCLE_MS + phase) % 1;
            const eased = 1 - Math.pow(1 - t, 2); // ease-out

            // Radius: start at marker edge, expand outward
            const expansionBase = baseRadius * 0.5;
            const expansionMax = baseRadius * 1.5;

            // Data-driven radius: base + expansion scaled by intensity
            const radius: any = [
              "+",
              baseRadius + eased * expansionBase,
              [
                "*",
                eased * (expansionMax - expansionBase),
                ["get", "intensity"],
              ],
            ];

            // Opacity: fade out as circle expands, brighter for more strokes
            const baseOpacity = 0.15 + 0.55 * (1 - eased); // 0.7 → 0.15
            const opacity: any = ["*", baseOpacity, opacitySteps[i]];

            // @ts-ignore
            map.current.setPaintProperty(layerId, "circle-radius", radius);
            // @ts-ignore
            map.current.setPaintProperty(layerId, "circle-opacity", opacity);
          }

          pulseAnimFrameRef.current = requestAnimationFrame(animatePulse);
        };
        pulseAnimFrameRef.current = requestAnimationFrame(animatePulse);
      })();
    });

    return () => {
      stopRotation();
      if (pulseAnimFrameRef.current)
        cancelAnimationFrame(pulseAnimFrameRef.current);
      if (map.current) {
        map.current.remove();
        map.current = null;
      }
    };
  }, []);

  const addHeatmapLayer = (mapInstance: maplibregl.Map) => {
    if (mapInstance.getSource("heatmap-source")) return;

    mapInstance.addSource("heatmap-source", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [],
      },
    });

    mapInstance.addLayer({
      id: "heatmap-layer",
      type: "heatmap",
      source: "heatmap-source",
      paint: {
        // Each point contributes a small weight — density comes from overlap
        "heatmap-weight": ["get", "mag"],
        // Low intensity so only the densest clusters turn red
        "heatmap-intensity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          0,
          0.08,
          3,
          0.12,
          6,
          0.25,
          9,
          0.5,
          12,
          0.8, // Higher intensity at zoom-in so isolated points still glow
        ],
        "heatmap-color": [
          "interpolate",
          ["linear"],
          ["heatmap-density"],
          0,
          "rgba(33,102,172,0)",
          0.1,
          "rgb(103,169,207)",
          0.3,
          "rgb(209,229,240)",
          0.5,
          "rgb(253,219,199)",
          0.7,
          "rgb(239,138,98)",
          1,
          "rgb(178,24,43)",
        ],
        // Larger radius for smooth blending
        "heatmap-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          0,
          20,
          3,
          35,
          6,
          60,
          9,
          100,
          12,
          140, // Keep growing so sparse points remain visible
        ],
        // Gradual fade — heatmap lingers while marker thumbnails load
        "heatmap-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          0,
          0.6,
          8,
          0.6,
          9,
          0.5,
          10,
          0.35, // Still visible at zoom 10
          12,
          0, // Fully gone by zoom 12
        ],
        "heatmap-opacity-transition": {
          duration: 800,
          delay: 0,
        },
      },
    });

    // Add circle markers source (no clustering — all features loaded statically
    // so the opacity transition provides smooth fade-in/out at zoom threshold)
    mapInstance.addSource("circles-source", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [],
      },
    });

    // Load the default fallback marker image, then set up per-location thumbnail loading
    const loadMarkerImage = async () => {
      try {
        const img = new Image();
        img.crossOrigin = "anonymous";

        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = (e) => reject(e);
          img.src = cityMarkerImage;
        });

        // Create default circular marker as fallback
        const imageData = createCircularMarkerImage(img);

        if (!mapInstance.hasImage("city-marker")) {
          mapInstance.addImage("city-marker", imageData);
        }

        if (mapInstance.getLayer("circles-image")) return;

        // Clustering is enabled on the source for spatial indexing performance,
        // but we don't render cluster bubbles — the heatmap glow already
        // provides visual density at mid-zoom levels.

        // Individual marker layer (unclustered points only)
        mapInstance.addLayer({
          id: "circles-image",
          type: "symbol",
          source: "circles-source",
          minzoom: 0,
          layout: {
            "icon-image": ["image", ["concat", "marker-", ["get", "id"]]],
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "icon-size": [
              "interpolate",
              ["linear"],
              ["zoom"],
              9,
              0.42,
              12,
              0.62,
              14,
              0.88,
              16,
              1.1,
            ],
          },
          paint: {
            "icon-opacity": 0, // Start hidden; programmatic toggle triggers the transition
            "icon-opacity-transition": {
              duration: 800,
              delay: 0,
            },
          },
        });

        // Programmatic fade: toggle opacity when crossing zoom 9
        // setPaintProperty with a static value properly triggers the transition
        let markersVisible = false;
        const checkMarkerVisibility = () => {
          const z = mapInstance.getZoom();
          if (z >= 9 && !markersVisible) {
            markersVisible = true;
            mapInstance.setPaintProperty("circles-image", "icon-opacity", 1);
          } else if (z < 9 && markersVisible) {
            markersVisible = false;
            mapInstance.setPaintProperty("circles-image", "icon-opacity", 0);
          }
        };
        mapInstance.on("zoom", checkMarkerVisibility);
        // Delay initial check by one frame so the transition property is applied first;
        // otherwise markers pop in instantly when the map loads at zoom >= 9
        requestAnimationFrame(() => checkMarkerVisibility());

        // On-demand thumbnail loading: when MapLibre needs an image that
        // doesn't exist yet, add a tiny transparent placeholder immediately
        // (suppresses the console warning). Start prefetching at zoom 4
        // so thumbnails are ready just before markers fade in at zoom 9.
        const PREFETCH_ZOOM = 7;
        mapInstance.on("styleimagemissing", (e: { id: string }) => {
          const { id } = e;
          if (!id.startsWith("marker-")) return;

          // Add 1x1 transparent placeholder to silence the warning
          if (!mapInstance.hasImage(id)) {
            mapInstance.addImage(id, {
              width: 1,
              height: 1,
              data: new Uint8Array(4),
            });
          }

          // Prefetch the real thumbnail once zoomed in enough
          if (mapInstance.getZoom() >= PREFETCH_ZOOM) {
            const imageId = id.replace("marker-", "");
            loadThumbnailForMarker(mapInstance, imageId);
          }
        });

        // Eagerly preload thumbnails based on viewport position,
        // even before markers are rendered on screen
        const debouncedPreload = debounce(() => {
          const z = mapInstance.getZoom();
          if (z >= PREFETCH_ZOOM) {
            // At lower zoom: use viewport bounds against raw data
            preloadViewportThumbnails(mapInstance);
            // At higher zoom: also load any rendered features
            if (z >= 7) {
              loadVisibleThumbnails(mapInstance);
            }
          }
        }, 150);
        mapInstance.on("moveend", debouncedPreload);
        mapInstance.on("zoomend", debouncedPreload);
        // Preload immediately if already zoomed in
        if (mapInstance.getZoom() >= PREFETCH_ZOOM) {
          preloadViewportThumbnails(mapInstance);
          if (mapInstance.getZoom() >= 7) {
            loadVisibleThumbnails(mapInstance);
          }
        }
      } catch (error) {
        console.error("Error loading marker image:", error);
      }
    };

    loadMarkerImage();
  };

  const bottomSheetFilteredLocations = bottomSheetSearchQuery.trim()
    ? locationsData.locations
      .filter((l) =>
        l.city
          .toLowerCase()
          .includes(bottomSheetSearchQuery.trim().toLowerCase()),
      )
      .slice(0, 12)
    : [];

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "#09090b",
      }}
    >
      <div
        ref={mapContainer}
        onMouseDown={() => {
          if (!isDesktop) {
            setBottomSheetState('collapsed');
            setBottomSheetSearchActive(false);
            setBottomSheetSearchQuery('');
          }
        }}
        onTouchStart={() => {
          if (!isDesktop) {
            setBottomSheetState('collapsed');
            setBottomSheetSearchActive(false);
            setBottomSheetSearchQuery('');
          }
        }}
        onWheel={() => {
          if (!isDesktop) {
            setBottomSheetState('collapsed');
            setBottomSheetSearchActive(false);
            setBottomSheetSearchQuery('');
          }
        }}
        style={{
          position: "absolute",
          top: "calc(-1 * env(safe-area-inset-top, 0px))",
          left: "calc(-1 * env(safe-area-inset-left, 0px))",
          right: "calc(-1 * env(safe-area-inset-right, 0px))",
          bottom: "calc(-1 * env(safe-area-inset-bottom, 0px))",
        }}
      />

      {/* Returning Transition Overlay */}
      {returningTransition && (
        <div
          style={{
            position: "fixed",
            top: "calc(-1 * env(safe-area-inset-top, 0px))",
            left: "calc(-1 * env(safe-area-inset-left, 0px))",
            right: "calc(-1 * env(safe-area-inset-right, 0px))",
            bottom: "calc(-1 * env(safe-area-inset-bottom, 0px))",
            zIndex: 1000,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: `${returningTransition.x}px`,
              top: `${returningTransition.y}px`,
              transform: "translate(-50%, -50%)",
              width: "100px",
              height: "100px",
              borderRadius: "50%",
              overflow: "hidden",
              animation:
                "expandFromCircle 0.8s cubic-bezier(0.2, 0.8, 0.2, 1) forwards",
            }}
          >
            <img
              src={(() => {
                const params = new URLSearchParams(window.location.search);
                const imgId = params.get("imageId");
                const paramThumbUrl = params.get("thumbUrl");
                // Prefer URL-passed thumbnail (survives map re-init cache clear)
                if (paramThumbUrl) return decodeURIComponent(paramThumbUrl);
                if (imgId && thumbCdnUrls.has(imgId))
                  return thumbCdnUrls.get(imgId)!;
                return cityMarkerImage;
              })()}
              alt="Transition"
              style={{
                width: "100%",
                height: "100%",
                position: "absolute",
                top: 0,
                left: 0,
                objectFit: "cover",
                objectPosition: "center",
                transform: "scale(1)",
                animation:
                  "zoomOutRectilinear 0.8s cubic-bezier(0.2, 0.8, 0.2, 1) forwards",
              }}
            />
          </div>
        </div>
      )}

      {/* Info Card — bottom sheet on mobile, floating card on desktop */}
      {selectedFeature &&
        (() => {
          const isMobile = window.innerWidth <= 600;

          const closeCard = () => {
            setIsCardClosing(true);
            setTimeout(() => {
              setSelectedFeature(null);
              selectedFeatureRef.current = null;
              setIsCardClosing(false);
              if (!isDesktop) setBottomSheetState('half');
              if (map.current && preClickCameraRef.current) {
                map.current.flyTo({ ...preClickCameraRef.current, speed: 2.0 });
                preClickCameraRef.current = null;
              }
            }, 350);
          };

          const enterLocation = (e: React.MouseEvent) => {
            e.stopPropagation();
            if (selectedFeature?.coordinates && map.current) {
              const screenPoint = map.current.project(
                selectedFeature.coordinates,
              );
              const cameraState = preClickCameraRef.current || {
                center: map.current.getCenter(),
                zoom: map.current.getZoom(),
                pitch: map.current.getPitch(),
                bearing: map.current.getBearing(),
              };
              // Use a smaller starting size so the expand animation is visible
              // (at zoom 14 the marker is ~240px which covers most of the screen)
              const size = getMarkerSize();
              triggerTransition(
                screenPoint.x,
                screenPoint.y,
                size,
                selectedFeature.coordinates,
                cameraState,
                selectedFeature.id,
              );
            }
          };

          const isCardDataReady = cardRelated.length > 0 || selectedFeature.time !== "...";

          const cardContent = (
            <div style={{
              opacity: isCardDataReady ? 1 : 0,
              transition: "opacity 0.3s ease",
            }}>
              <button
                onClick={enterLocation}
                style={{
                  width: "100%",
                  padding: "14px",
                  background: "#007aff",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "14px",
                  fontWeight: 600,
                  fontSize: "16px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  letterSpacing: "-0.2px",
                  transition: "transform 0.2s ease, background 0.2s ease",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = "scale(1.02)";
                  e.currentTarget.style.background = "#0062cc";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "scale(1)";
                  e.currentTarget.style.background = "#007aff";
                }}
                onPointerDown={(e) => {
                  e.currentTarget.style.transform = "scale(0.96)";
                }}
                onPointerUp={(e) => {
                  e.currentTarget.style.transform = "scale(1.02)";
                }}
              >
                Enter
              </button>


              {/* Nearby locations */}
              {!isMobile && cardRelated.length > 0 && (
                <div style={{ marginTop: "20px" }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#1c1c1e', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                    Nearby
                  </div>
                  <div
                    data-carousel
                    onWheel={(e) => {
                      e.stopPropagation();
                      if (e.deltaY !== 0) {
                        e.currentTarget.scrollLeft += e.deltaY * 0.3;
                        e.preventDefault();
                      }
                    }}
                    style={{
                      display: 'flex',
                      gap: '14px',
                      overflowX: 'auto',
                      scrollbarWidth: 'none',
                      msOverflowStyle: 'none',
                      touchAction: 'pan-x',
                      overscrollBehavior: 'none',
                      margin: '0 -24px',
                      padding: '0 24px',
                    }}
                  >
                    {cardRelated.map((loc) => (
                      <button
                        key={loc.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          navigateToLocation(loc);
                        }}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: '6px',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: 0,
                          minWidth: '96px',
                        }}
                      >
                        <div style={{
                          width: 100, height: 100, borderRadius: '50%',
                          background: 'rgba(118,118,128,0.12)',
                          overflow: 'hidden',
                          boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
                        }}>
                          {loc.thumbUrl ? (
                            <img src={loc.thumbUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} crossOrigin="anonymous" />
                          ) : (
                            <div style={{ width: '100%', height: '100%', background: 'rgba(118,118,128,0.12)' }} />
                          )}
                        </div>
                        <span style={{ fontSize: '12px', color: '#3c3c43', fontWeight: 500, maxWidth: '96px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {loc.city}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

            </div>
          );

          if (isMobile) {
            return (
              <div
                style={{
                  position: "fixed",
                  inset: 0,
                  zIndex: 60,
                  pointerEvents: "none",
                }}
              >
                {/* Tap-to-dismiss area (no scrim) */}
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    pointerEvents: "auto",
                  }}
                  onClick={closeCard}
                />
                {/* Sheet */}
                <div
                  ref={cardSheetRef}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => {
                    cardSheetDrag.current = { startY: e.clientY, dragging: true, velocity: 0, lastY: e.clientY, lastTime: Date.now() };
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (!cardSheetDrag.current?.dragging || !cardSheetRef.current) return;
                    const dy = e.clientY - cardSheetDrag.current.startY;
                    const now = Date.now();
                    const dt = now - cardSheetDrag.current.lastTime;
                    if (dt > 0) {
                      const instantV = (e.clientY - cardSheetDrag.current.lastY) / dt;
                      cardSheetDrag.current.velocity = 0.7 * instantV + 0.3 * cardSheetDrag.current.velocity;
                    }
                    cardSheetDrag.current.lastY = e.clientY;
                    cardSheetDrag.current.lastTime = now;
                    if (dy > 0 && cardSheetRef.current) {
                      cardSheetRef.current.style.transition = 'none';
                      cardSheetRef.current.style.transform = `translateY(${dy}px)`;
                    }
                  }}
                  onPointerUp={(e) => {
                    if (!cardSheetDrag.current || !cardSheetRef.current) return;
                    const dy = e.clientY - cardSheetDrag.current.startY;
                    const v = cardSheetDrag.current.velocity;
                    cardSheetDrag.current = null;
                    cardSheetRef.current.style.transition = 'transform 0.35s cubic-bezier(0.2,0.8,0.2,1)';
                    if (v > 0.5 || dy > 80) {
                      closeCard();
                    } else {
                      cardSheetRef.current.style.transform = '';
                    }
                  }}
                  style={{
                    position: "absolute",
                    bottom: 0,
                    left: 0,
                    right: 0,
                    maxWidth: "420px",
                    marginLeft: "auto",
                    marginRight: "auto",
                    borderRadius: "32px 32px 0 0",
                    background: "rgba(255,255,255,0.92)",
                    backdropFilter: "blur(20px)",
                    WebkitBackdropFilter: "blur(20px)",
                    boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
                    paddingBottom: "env(safe-area-inset-bottom, 0px)",
                    pointerEvents: "auto",
                    overflow: "hidden",
                    touchAction: "none",
                    animation: isCardClosing
                      ? "slideDownSheet 0.3s cubic-bezier(0.2,0.8,0.2,1) forwards"
                      : "slideUpSheet 0.35s cubic-bezier(0.2,0.8,0.2,1) forwards",
                  }}
                >
                  {/* Drag handle + title + close button */}
                  <div style={{ position: "relative", zIndex: 1 }}>
                    <div
                      style={{
                        width: "36px",
                        height: "4px",
                        borderRadius: "2px",
                        background: "rgba(0,0,0,0.12)",
                        margin: "6px auto 0",
                      }}
                    />
                    <h2
                      style={{
                        margin: 0,
                        fontSize: "20px",
                        fontWeight: 600,
                        color: "#1c1c1e",
                        padding: "4px 48px 0 48px",
                        textAlign: "center",
                      }}
                    >
                      {selectedFeature.name}
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "3px", fontSize: "13px", fontWeight: 400, color: "#8e8e93", marginLeft: "6px", verticalAlign: "middle" }}>
                        <IoTime size={13} color="#8e8e93" />
                        {selectedFeature.time}
                      </span>
                    </h2>
                    <button
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={closeCard}
                      style={{
                        position: "absolute",
                        top: "8px",
                        right: "12px",
                        width: "28px",
                        height: "28px",
                        borderRadius: "50%",
                        background: "rgba(118,118,128,0.12)",
                        border: "none",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 0,
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#8e8e93" strokeWidth="2" strokeLinecap="round">
                        <line x1="1" y1="1" x2="11" y2="11" />
                        <line x1="11" y1="1" x2="1" y2="11" />
                      </svg>
                    </button>
                  </div>
                  <div style={{ padding: "12px 24px 36px" }}>{cardContent}</div>
                </div>
              </div>
            );
          }

          return (
            <div style={{ position: "fixed", inset: 0, zIndex: 60, pointerEvents: "none" }}>
              <div style={{
                position: "fixed",
                top: "calc(100vh - 674px)",
                left: "12px",
                width: "400px",
                borderRadius: "28px",
                overflow: "hidden",
                pointerEvents: "auto",
                boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
              }}>
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    width: "100%",
                    background: "rgba(255,255,255,0.92)",
                    backdropFilter: "blur(20px)",
                    WebkitBackdropFilter: "blur(20px)",
                    overflow: "auto",
                    position: "relative",
                    animation: isCardClosing
                      ? "entranceCardFadeOut 0.25s ease forwards"
                      : "entranceCardFadeIn 0.3s ease forwards",
                  }}
                >
                  {/* Title + close button */}
                  <div
                    style={{ position: "relative", zIndex: 1, touchAction: "none", cursor: "grab" }}
                    onPointerDown={(e) => {
                      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                      (e.currentTarget as any)._dragStartY = e.clientY;
                      const sheet = e.currentTarget.parentElement;
                      if (sheet) sheet.style.transition = 'none';
                    }}
                    onPointerMove={(e) => {
                      const startY = (e.currentTarget as any)._dragStartY;
                      if (startY == null) return;
                      const dy = e.clientY - startY;
                      if (dy > 0) {
                        const sheet = e.currentTarget.parentElement;
                        if (sheet) sheet.style.transform = `translateY(${dy}px)`;
                      }
                    }}
                    onPointerUp={(e) => {
                      const startY = (e.currentTarget as any)._dragStartY;
                      (e.currentTarget as any)._dragStartY = null;
                      const sheet = e.currentTarget.parentElement;
                      if (sheet) sheet.style.transition = '';
                      const dy = startY != null ? e.clientY - startY : 0;
                      if (dy > 60) {
                        closeCard();
                      } else if (sheet) {
                        sheet.style.transform = '';
                      }
                    }}
                  >
                    <div
                      style={{
                        width: "36px",
                        height: "4px",
                        borderRadius: "2px",
                        background: "rgba(0,0,0,0.12)",
                        margin: "6px auto 0",
                      }}
                    />
                    <h2
                      style={{
                        margin: 0,
                        fontSize: "20px",
                        fontWeight: 600,
                        color: "#1c1c1e",
                        padding: "4px 48px 0 48px",
                        textAlign: "center",
                      }}
                    >
                      {selectedFeature.name}
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "3px", fontSize: "13px", fontWeight: 400, color: "#8e8e93", marginLeft: "6px", verticalAlign: "middle" }}>
                        <IoTime size={13} color="#8e8e93" />
                        {selectedFeature.time}
                      </span>
                    </h2>
                    <button
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={closeCard}
                      style={{
                        position: "absolute",
                        top: "8px",
                        right: "12px",
                        width: "28px",
                        height: "28px",
                        borderRadius: "50%",
                        background: "rgba(118,118,128,0.12)",
                        border: "none",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 0,
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#8e8e93" strokeWidth="2" strokeLinecap="round">
                        <line x1="1" y1="1" x2="11" y2="11" />
                        <line x1="11" y1="1" x2="1" y2="11" />
                      </svg>
                    </button>
                  </div>
                  <div style={{ padding: "16px 24px 24px" }}>{cardContent}</div>
                </div>
              </div>
            </div>
          );
        })()}

      {/* Transition Overlay */}
      {transition && (
        <div
          style={{
            position: "fixed",
            top: "calc(-1 * env(safe-area-inset-top, 0px))",
            left: "calc(-1 * env(safe-area-inset-left, 0px))",
            right: "calc(-1 * env(safe-area-inset-right, 0px))",
            bottom: "calc(-1 * env(safe-area-inset-bottom, 0px))",
            zIndex: 1000,
            pointerEvents: "none",
            overflow: "hidden",
          }}
        >
          <div
            ref={(el) => {
              if (el && !el.dataset.expanded) {
                el.dataset.expanded = "true";
                // Force the browser to commit the initial circle state
                el.getBoundingClientRect();
                // Then trigger expansion
                el.style.width = "100%";
                el.style.height = "100%";
                el.style.top = "50%";
                el.style.left = "50%";
                el.style.borderRadius = "0";
                el.style.border = "0px solid white";
              }
            }}
            style={{
              position: "absolute",
              top: `${transition.startY}px`,
              left: `${transition.startX}px`,
              transform: "translate(-50%, -50%)",
              width: `${transition.startSize}px`,
              height: `${transition.startSize}px`,
              borderRadius: "50%",
              overflow: "hidden",
              border: `${Math.max(2, transition.startSize * 0.03)}px solid white`,
              boxSizing: "border-box",
              transition:
                "width 0.6s cubic-bezier(0.25, 1, 0.5, 1), height 0.6s cubic-bezier(0.25, 1, 0.5, 1), top 0.6s cubic-bezier(0.25, 1, 0.5, 1), left 0.6s cubic-bezier(0.25, 1, 0.5, 1), border-radius 0.6s cubic-bezier(0.25, 1, 0.5, 1), border 0.6s cubic-bezier(0.25, 1, 0.5, 1)",
            }}
          >
            <img
              src={(() => {
                const imgId = transitionCoords?.imageId;
                if (imgId) {
                  if (highResThumbUrls.has(imgId))
                    return highResThumbUrls.get(imgId)!;
                  if (thumbCdnUrls.has(imgId)) return thumbCdnUrls.get(imgId)!;
                }
                return cityMarkerImage;
              })()}
              alt="Transition"
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />
          </div>
        </div>
      )}

      {/* CSS Keyframes */}
      <style>
        {`
          @keyframes expandFromCorner {
            0% {
              clip-path: inset(0 0 calc(100% - 40px) calc(100% - 40px) round 20px);
              opacity: 0;
            }
            30% {
              opacity: 1;
            }
            100% {
              clip-path: inset(0 0 0 0 round 32px 28px 32px 32px);
              opacity: 1;
            }
          }

          @keyframes collapseToCorner {
            0% {
              clip-path: inset(0 0 0 0 round 32px 28px 32px 32px);
              opacity: 1;
            }
            50% {
              opacity: 1;
            }
            50.1% {
              opacity: 0;
            }
            100% {
              clip-path: inset(0 0 calc(100% - 40px) calc(100% - 40px) round 20px);
              opacity: 0;
            }
          }

          @keyframes expandScale {
            0% { transform: scale(0); }
            100% { transform: scale(1); }
          }

          @keyframes collapseScale {
            0% { transform: scale(1); }
            100% { transform: scale(0); }
          }

          /* Restored keyframes for other modals */
          @keyframes expandFromDot {
            0% {
              transform: scale(0);
              border-radius: 200px;
              opacity: 0;
            }
            30% {
              opacity: 1;
            }
            100% {
              transform: scale(1);
              border-radius: 32px 28px 32px 32px;
              opacity: 1;
            }
          }

          @keyframes collapseToDot {
            0% {
              transform: scale(1);
              border-radius: 32px 28px 32px 32px;
              opacity: 1;
            }
            70% {
              opacity: 1;
            }
            70.1% {
              opacity: 0;
            }
            100% {
              transform: scale(0);
              border-radius: 200px;
              opacity: 0;
            }
          }

          @keyframes expandFromCircle {
            0% {
              width: 100%;
              height: 100%;
              border-radius: 0;
              left: 50%;
              top: 50%;
              opacity: 1;
            }
            100% {
              width: 100px;
              height: 100px;
              border-radius: 50%;
              opacity: 0;
            }
          }

          @keyframes modalFadeIn {
            0% {
              opacity: 0;
              transform: scale(0.95) translateY(10px);
            }
            100% {
              opacity: 1;
              transform: scale(1) translateY(0);
            }
          }


          @keyframes zoomOutRectilinear {
            0% { transform: scale(1); }
            100% { transform: scale(1.7); }
          }

          @keyframes sidebarScrimIn  { from { opacity: 0; } to { opacity: 1; } }
          @keyframes sidebarScrimOut { from { opacity: 1; } to { opacity: 0; } }
          @keyframes slideUpSheet {
            from { transform: translateY(100%); }
            to   { transform: translateY(0); }
          }
          @keyframes slideDownSheet {
            from { transform: translateY(0); }
            to   { transform: translateY(100%); }
          }
          @keyframes entranceCardFadeIn {
            from { opacity: 0; transform: scale(0.97); }
            to   { opacity: 1; transform: scale(1); }
          }
          @keyframes entranceCardFadeOut {
            from { opacity: 1; transform: scale(1); }
            to   { opacity: 0; transform: scale(0.97); }
          }
          @keyframes featureCardSlideIn {
            from { transform: translateX(-100%); }
            to   { transform: translateX(0); }
          }
          @keyframes featureCardSlideOut {
            from { transform: translateX(0); }
            to   { transform: translateX(-100%); }
          }
          @keyframes heatmapSheetScaleIn {
            from { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
            to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          }
          @keyframes heatmapSheetScaleOut {
            from { opacity: 1; transform: translate(-50%, -50%) scale(1); }
            to   { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
          }
          @media (min-width: 650px) {
            .heatmap-sheet-dialog {
              bottom: auto !important;
              top: 50% !important;
              left: 50% !important;
              right: auto !important;
              transform: translate(-50%, -50%) !important;
              border-radius: 32px !important;
              max-height: calc(100vh - 80px);
              height: fit-content;
              overflow-y: auto;
              padding-bottom: 0 !important;
              width: 420px !important;
              height: auto !important;
              pointer-events: auto;
            }
            .heatmap-sheet-dialog.heatmap-sheet-entering {
              animation: heatmapSheetScaleIn 0.3s cubic-bezier(0.2, 0.8, 0.2, 1) forwards !important;
            }
            .heatmap-sheet-dialog.heatmap-sheet-leaving {
              animation: heatmapSheetScaleOut 0.25s cubic-bezier(0.2, 0.8, 0.2, 1) forwards !important;
            }
            .heatmap-sheet-dialog .heatmap-sheet-drag-handle {
              display: none;
            }
          }
          @keyframes rainbowSlide {
            from { transform: translate(0, 0); }
            to { transform: translate(-512px, -512px); }
          }
          @keyframes rainbowBar {
            from { background-position: 0% 50%; }
            to { background-position: 200% 50%; }
          }
          @keyframes rainbowFlow {
            0% { background-position: center, 0% 0%; }
            50% { background-position: center, 100% 100%; }
            100% { background-position: center, 0% 0%; }
          }
          @keyframes rainbowTextFlow {
            0% { background-position: 0% 0%; }
            50% { background-position: 100% 100%; }
            100% { background-position: 0% 0%; }
          }
          @keyframes rainbowRotate {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          @keyframes rainbowGlowRotate {
            0% { transform: rotate(0deg) scale(0.3); }
            50% { transform: rotate(180deg) scale(0.3); }
            100% { transform: rotate(360deg) scale(0.3); }
          }
        `}
      </style>

      {/* Menu Button (Stays but icon fades when modal open) */}
      {false && (
        <button
          onClick={() => !showWelcome && !isClosing && setShowWelcome(true)}
          onMouseEnter={(e) => {
            if (!showWelcome) e.currentTarget.style.transform = "scale(1.05)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = "scale(1)";
          }}
          style={{
            position: "absolute",
            top: "20px",
            right: "20px",
            background:
              showWelcome && !isClosing
                ? "transparent"
                : "rgba(255, 255, 255, 0.85)",
            backdropFilter: showWelcome && !isClosing ? "none" : "blur(20px)",
            WebkitBackdropFilter:
              showWelcome && !isClosing ? "none" : "blur(20px)",
            border: "none",
            borderRadius: "50%",
            width: "40px",
            height: "40px",
            cursor: showWelcome ? "default" : "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#3c3c43",
            boxShadow:
              showWelcome && !isClosing
                ? "none"
                : "0 4px 16px rgba(0, 0, 0, 0.12)",
            zIndex: 11,
            pointerEvents: showWelcome ? "none" : "auto",
            transition: "all 0.3s ease",
          }}
        >
          <div
            style={{
              opacity: showWelcome && !isClosing ? 0 : 1,
              transition: "opacity 0.3s ease",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <IoIosMore size={24} />
          </div>
        </button>
      )}

      {/* Expandable Welcome Modal with Symmetrical Animations */}
      {false && (showWelcome || isClosing) && (
        <div
          style={{
            position: "absolute",
            top: "20px",
            right: "20px",
            left: "20px",
            maxWidth: "400px",
            marginLeft: "auto",
            background: "rgba(255, 255, 255, 0.85)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            filter: "drop-shadow(0 8px 32px rgba(0, 0, 0, 0.12))",
            boxShadow: "none",
            zIndex: 10,
            overflow: "hidden",
            height: "auto",
            padding: 0,
            animation: isClosing
              ? "collapseToCorner 0.45s cubic-bezier(0.2, 0.8, 0.2, 1) forwards"
              : "expandFromCorner 0.45s cubic-bezier(0.2, 0.8, 0.2, 1) forwards",
          }}
        >
          {/* Inner wrapper scales in sync */}
          <div
            style={{
              padding: "32px",
              paddingTop: "20px",
              transformOrigin: "calc(100% - 20px) 20px",
              animation: isClosing
                ? "collapseScale 0.45s cubic-bezier(0.2, 0.8, 0.2, 1) forwards"
                : "expandScale 0.45s cubic-bezier(0.2, 0.8, 0.2, 1) forwards",
            }}
          >
            <h2
              style={{
                margin: "0 0 8px 0",
                fontSize: "20px",
                fontWeight: 700,
                color: "#1c1c1e",
                paddingRight: "32px",
              }}
            >
              Welcome
            </h2>
            <div
              style={{ display: "flex", flexDirection: "column", gap: "8px" }}
            >
              <p
                style={{
                  margin: 0,
                  lineHeight: "1.6",
                  color: "#3c3c43",
                  fontSize: "15px",
                }}
              >
                Draw directly on the world. Your sketches stay for others to
                find and add to.
                <br />
                <br />
                Find a spot on the map to start drawing.
              </p>

              <button
                onClick={async () => {
                  // Close the welcome modal immediately
                  setIsClosing(true);
                  setTimeout(() => {
                    setShowWelcome(false);
                    showWelcomeRef.current = false;
                    setIsClosing(false);
                    isClosingRef.current = false;
                  }, 450);

                  // Progressive explore: query top locations from Supabase RPC
                  if (!map.current) return;

                  // Track explore usage in localStorage
                  const exploreCount = parseInt(
                    localStorage.getItem("streetview_explore_count") || "0",
                    10,
                  );
                  localStorage.setItem(
                    "streetview_explore_count",
                    String(exploreCount + 1),
                  );

                  // Progressive pool size: start with top 20, grow slowly
                  const poolSize = Math.min(
                    200,
                    20 + Math.floor(exploreCount * exploreCount * 0.5),
                  );

                  const { data, error } = await supabase.rpc("top_image_ids", {
                    lim: poolSize,
                  });
                  if (error || !data || data.length === 0) return;

                  // Weighted random pick: count² so popular locations are strongly favored
                  const entries = data as { image_id: string; count: number }[];
                  const weights = entries.map((e) => e.count * e.count);
                  const totalWeight = weights.reduce((a, b) => a + b, 0);
                  let random = Math.random() * totalWeight;
                  let picked = entries[0];
                  for (let i = 0; i < entries.length; i++) {
                    random -= weights[i];
                    if (random <= 0) {
                      picked = entries[i];
                      break;
                    }
                  }

                  const topImageId = picked.image_id;
                  const loc = locationsData.locations.find(
                    (l) => l.id === topImageId,
                  );

                  // Prefetch thumbnail
                  loadThumbnailForMarker(map.current, topImageId);
                  prefetchHighResThumbnail(topImageId);

                  // Save current camera as pre-click state
                  preClickCameraRef.current = {
                    center: map.current.getCenter(),
                    zoom: map.current.getZoom(),
                    pitch: map.current.getPitch(),
                    bearing: map.current.getBearing(),
                  };

                  if (loc) {
                    // Location is on the map — fly to it then enter panorama
                    const coords: [number, number] = [loc.lng, loc.lat];
                    map.current.flyTo({ center: coords, zoom: 14, speed: 2.0 });
                    map.current.once("moveend", () => {
                      if (!map.current) return;
                      const screenPoint = map.current.project(coords);
                      const cameraState = preClickCameraRef.current;
                      triggerTransition(
                        screenPoint.x,
                        screenPoint.y,
                        getMarkerSize(),
                        coords,
                        cameraState,
                        topImageId,
                      );
                    });
                  } else {
                    // Location not in locations.json — go straight to panorama from screen center
                    const cameraState = preClickCameraRef.current;
                    const cx = window.innerWidth / 2;
                    const cy = window.innerHeight / 2;
                    triggerTransition(
                      cx,
                      cy,
                      120,
                      undefined,
                      cameraState,
                      topImageId,
                    );
                  }
                }}
                style={{
                  width: "calc(100% + 32px)",
                  marginLeft: "-16px",
                  marginRight: "-16px",
                  marginBottom: "-16px",
                  marginTop: "24px",
                  padding: "14px",
                  background: "#ffffff",
                  color: "#000000",
                  border: "1px solid rgba(0,0,0,0.1)",
                  borderRadius: "100px",
                  fontWeight: 600,
                  fontSize: "16px",
                  cursor: "pointer",
                  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.05)",
                  transition: "transform 0.2s ease",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.transform = "scale(1.02)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.transform = "scale(1)")
                }
              >
                Start Exploring
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom Sheet Styles & Functions */}
      <style>
        {`
          .bottom-sheet-dragging, .bottom-sheet-dragging * {
            transition: none !important;
          }
        `}
      </style>

      {/* Floating Ink Bar */}
      {sidebarInkLevel !== null && (() => {
        const maxInk = tier?.maxInk ?? GUEST_TIER.maxInk;
        const inkPercent = Math.min(100, (sidebarInkLevel / maxInk) * 100);
        return (
          <div style={{
            position: 'absolute',
            top: 'calc(env(safe-area-inset-top, 0px) + 8px)',
            left: '20px',
            right: '20px',
            height: '4px',
            background: 'rgba(255,255,255,0.15)',
            borderRadius: '2px',
            zIndex: 15,
            pointerEvents: 'none',
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${inkPercent}%`,
              background: inkPercent > 30 ? 'rgba(255,255,255,0.5)' : inkPercent > 10 ? '#FF9500' : '#FF3B30',
              borderRadius: '2px',
              transition: 'width 0.5s ease',
            }} />
          </div>
        );
      })()}

      {/* Map Watermark */}
      <div
        ref={watermarkRef}
        style={{
          position: 'absolute',
          ...(isDesktop ? {
            bottom: '30px',
            left: '392px',
            right: '20px',
          } : {
            bottom: `${sheetHeight + WATERMARK_GAP}px`,
            left: '20px',
            right: '20px',
          }),
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: '4px',
          opacity: isDesktop ? 0.5 : (showAuthModal || showPlusSheet || showAccountSheet || selectedFeature) ? 0 : 0.5,
          pointerEvents: 'none',
          zIndex: 10,
          transition: 'opacity 0.3s ease',
          mixBlendMode: 'normal'
        }}
      >
        <svg width="18" height="18" viewBox="0 0 512 512" fill="#E5E5EA" style={{ opacity: 0.9 }}>
          <path d="M438.024,210.133c0,7.488,6.08,13.551,13.551,13.551c7.488,0,13.569-6.063,13.569-13.551
            c0-7.479-6.081-13.552-13.569-13.552C444.104,196.581,438.024,202.654,438.024,210.133z"/>
          <path d="M400.097,376.503c-5.994,0-10.842,4.856-10.842,10.85c0,5.986,4.848,10.832,10.842,10.832
            c5.994,0,10.841-4.847,10.841-10.832C410.938,381.359,406.091,376.503,400.097,376.503z"/>
          <path d="M382.758,415.376c-12.284,0-22.238,9.956-22.238,22.238c0,12.274,9.955,22.229,22.238,22.229
            c12.283,0,22.238-9.955,22.238-22.229C404.997,425.332,395.041,415.376,382.758,415.376z"/>
          <circle cx="137.251" cy="426.904" r="16.8" />
          <path d="M94.425,359.164c-4.778,0-8.669,3.874-8.669,8.678c0,4.778,3.892,8.66,8.669,8.66
            c4.796,0,8.67-3.883,8.67-8.66C103.094,363.038,99.22,359.164,94.425,359.164z"/>
          <path d="M54.865,151.063c6.29,0,11.38-5.1,11.38-11.389c0-6.281-5.09-11.38-11.38-11.38
            c-6.289,0-11.38,5.099-11.38,11.38C43.485,145.963,48.576,151.063,54.865,151.063z"/>
          <path d="M165.97,97.952c8.374,0,15.166-6.793,15.166-15.185c0-8.365-6.792-15.158-15.166-15.158
            s-15.168,6.794-15.168,15.158C150.802,91.158,157.596,97.952,165.97,97.952z"/>
          <path d="M450.775,300.632c-47.586-16.887-56.968-10.485-80.214-32.515c-5.56-5.255-5.438-22.49,25.47-18.425
            c15.497,2.042,26.008-6.506,26.008-18.702c0-8.131-9.799-19.433-24.393-13.821c-21.126,8.131-34.834-1.094-37.388-11.38
            c-3.25-13.004,0.434-27.832,54.814-54.996c66.646-33.332,28.423-93.983-23.924-36.859c-23.194,25.296-34.14,35.764-49.584,43.895
            c-13.864,7.288-30.49-0.27-17.895-17.069c4.882-6.507,13.17-11.527,15.445-19.511c3.249-11.38-6.324-21.952-14.628-21.952
            c-8.304,0-18.694,4.874-21.943,17.07c-4.882,22.359-17.322,21.24-23.194,14.785c-11.241-12.318-7.193-26.686-5.264-48.924
            c2.276-26.121,17.738-86.443-29.709-81.995c-22.88,2.146-29.639,23.715-22.238,62.267c9.208,47.856-4.725,81.257-19.597,88.007
            c-17.878,8.13-26.946,5.046-65.029-21.126c-20.24-13.926-42.584-1.703-47.152,14.628c-4.031,14.385,7.332,31.768,24.393,37.396
            c26.286,8.678,37.944,10.693,50.14,17.33c11.918,6.507,13.412,22.282,1.511,36.554c-11.918,14.282-42.705,2.468-88.224-0.782
            c-78.685-5.611-60.999,81.43,12.996,55.831c42.27-14.637,60.147-11.389,67.479-2.441c10.112,12.344,3.162,29.031-16.54,40.915
            c-62.858,37.944,7.61,85.078,33.618,32.515c10.876-21.961,23.385-28.71,35.756-23.846c10.094,3.979,23.02,39.204,8.409,86.72
            C206.885,466.473,207.771,512,238.33,512c28.563,0,33.028-42.539,28.164-88.875c-1.808-17.339-0.47-44.207,13.012-50.948
            c10.842-5.421,27.781-11.458,39.283,12.457c10.58,21.951,33.34,18.693,42.287,6.506c6.532-8.921,9.851-28.71-16.157-38.969
            c-30.995-12.249-19.615-45.58,3.961-42.323c26.026,3.588,43.868,13.17,74.794,39.569
            C466.829,386.233,522.234,325.989,450.775,300.632z"/>
        </svg>
        <span style={{
          fontSize: '16px',
          fontWeight: 500,
          color: '#E5E5EA',
        }}>
        </span>
        <div style={{ flex: 1 }} />
        <a href="/terms" style={{ fontSize: '12px', color: '#E5E5EA', textDecoration: 'none', pointerEvents: 'auto', opacity: 0.8 }}>Terms</a>
        <span style={{ width: '1px', height: '10px', background: '#E5E5EA', opacity: 0.5, margin: '0 6px' }} />
        <a href="/privacy" style={{ fontSize: '12px', color: '#E5E5EA', textDecoration: 'none', pointerEvents: 'auto', opacity: 0.8 }}>Privacy</a>
      </div>

      {/* Bottom Sheet / Side Panel */}
      <div
        ref={bottomSheetRef}
        className={bottomSheetDrag.current ? 'bottom-sheet-dragging' : ''}
        style={{
          '--sheet-progress': isDesktop ? (bottomSheetState === 'collapsed' ? 0 : 1) : bottomSheetState === 'collapsed' ? 0 : 1,
          position: 'absolute',
          display: 'flex',
          flexDirection: 'column' as const,
          background: 'rgba(255,255,255,0.85)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          zIndex: 20,
          fontFamily: "-apple-system, 'SF Pro Display', 'SF Pro Text', system-ui, sans-serif",
          overflow: 'hidden',
          ...(isDesktop ? {
            left: '12px',
            bottom: '24px',
            width: '400px',
            height: desktopSheetHeight ?? (bottomSheetState === 'collapsed' ? '60px' : 'fit-content'),
            maxHeight: '650px',
            borderRadius: '28px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.1)',
            transition: isDesktopDragging ? 'none' : 'height 0.35s cubic-bezier(0.2,0.8,0.2,1), transform 0.35s cubic-bezier(0.2,0.8,0.2,1), opacity 0.3s ease',
            pointerEvents: (selectedFeature || !bottomSheetDataReady) ? 'none' as const : 'auto' as const,
            opacity: (selectedFeature || !bottomSheetDataReady) ? 0 : 1,
          } : {
            bottom: 0,
            left: 0,
            right: 0,
            maxWidth: '500px',
            marginLeft: 'auto',
            marginRight: 'auto',
            borderRadius: `28px 28px calc(28px * (1 - var(--sheet-progress))) calc(28px * (1 - var(--sheet-progress)))`,
            boxShadow: '0 -2px 20px rgba(0,0,0,0.1)',
            paddingBottom: bottomSheetState === 'full' ? 'env(safe-area-inset-bottom, 0px)' : 0,
            marginBottom: `calc((12px + env(safe-area-inset-bottom, 0px) * 0.7) * (1 - var(--sheet-progress)))`,
            width: `calc(100% - 48px * (1 - var(--sheet-progress)))`,
            transition: 'margin 0.3s ease, padding-bottom 0.3s ease, border-radius 0.3s ease, width 0.3s ease, transform 0.35s cubic-bezier(0.2,0.8,0.2,1)',
            transform: (showAuthModal || showPlusSheet || showAccountSheet || selectedFeature) ? 'translateY(calc(100% + 40px))' : undefined,
            pointerEvents: (showAuthModal || showPlusSheet || showAccountSheet || selectedFeature) ? 'none' as const : 'auto' as const,
          }),
        } as any}
      >
        {/* Drag handle + search bar (draggable area) */}
        <div
          onPointerDown={(e) => {
            // On mouse, don't start drag from search bar or profile button (let click through)
            // On touch, allow drag from anywhere (search bar opens via tap, not pointerDown)
            const target = e.target as HTMLElement;
            if (e.pointerType === 'mouse' && target.closest('[data-no-drag]')) return;
            const startHeight = bottomSheetRef.current ? bottomSheetRef.current.getBoundingClientRect().height : 650;
            bottomSheetDrag.current = { startY: e.clientY, dragging: true, lastY: e.clientY, lastTime: Date.now(), velocity: 0, startHeight };
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!bottomSheetDrag.current?.dragging) return;
            const dy = e.clientY - bottomSheetDrag.current.startY;
            if (!bottomSheetRef.current || !bottomSheetContentRef.current) return;

            // Track velocity (px/ms)
            const now = Date.now();
            const dt = now - bottomSheetDrag.current.lastTime;
            if (dt > 0) {
              const instantV = (e.clientY - bottomSheetDrag.current.lastY) / dt;
              // Exponential smoothing
              bottomSheetDrag.current.velocity = 0.7 * instantV + 0.3 * bottomSheetDrag.current.velocity;
            }
            bottomSheetDrag.current.lastY = e.clientY;
            bottomSheetDrag.current.lastTime = now;

            // Logarithmic rubber-band: feels soft at first, diminishes further out
            const rubberBand = (d: number) => {
              const abs = Math.abs(d);
              const sign = d < 0 ? -1 : 1;
              return sign * 50 * Math.log(1 + abs / 50);
            };

            if (isDesktop) {
              // Desktop: directly change sheet height
              const expandedHeight = (bottomSheetDrag.current as any).startHeight || 650;
              setIsDesktopDragging(true);
              if (bottomSheetState === 'collapsed') {
                if (dy < 0) {
                  const newHeight = Math.min(650, 60 + (-dy));
                  setDesktopSheetHeight(`${newHeight}px`);
                }
              } else {
                const newHeight = Math.max(60, Math.min(650, expandedHeight - dy));
                setDesktopSheetHeight(`${newHeight}px`);
              }
            } else {
              // Mobile: content-based drag
              bottomSheetRef.current.classList.add('bottom-sheet-dragging');
              let progress = bottomSheetState === 'collapsed' ? 0 : 1;
              let contentMaxHeight = 0;
              let opacity = bottomSheetState === 'collapsed' ? 0 : 1;
              let translateY = 0;
              const HALF_HEIGHT = 280;
              const FULL_HEIGHT = window.innerHeight - 140;

              if (bottomSheetState === 'collapsed') {
                if (dy < 0) {
                  const absDy = -dy;
                  if (absDy <= HALF_HEIGHT) {
                    progress = Math.min(1, absDy / HALF_HEIGHT);
                    contentMaxHeight = progress * HALF_HEIGHT;
                    opacity = progress;
                  } else {
                    progress = 1;
                    opacity = 1;
                    const extra = absDy - HALF_HEIGHT;
                    const diff = FULL_HEIGHT - HALF_HEIGHT;
                    if (extra > diff) {
                      translateY = -rubberBand(extra - diff);
                    }
                    contentMaxHeight = Math.min(FULL_HEIGHT, HALF_HEIGHT + extra);
                  }
                } else {
                  translateY = rubberBand(dy);
                }
              } else if (bottomSheetState === 'half') {
                if (dy > 0) {
                  progress = Math.min(1, Math.max(0, 1 - (dy / HALF_HEIGHT)));
                  contentMaxHeight = progress * HALF_HEIGHT;
                  opacity = progress;
                } else {
                  const diff = FULL_HEIGHT - HALF_HEIGHT;
                  let added = -dy;
                  if (added > diff) {
                    translateY = -rubberBand(added - diff);
                    added = diff;
                  }
                  contentMaxHeight = Math.min(FULL_HEIGHT, HALF_HEIGHT + added);
                  progress = 1;
                }
              } else if (bottomSheetState === 'full') {
                if (dy > 0) {
                  const diff = FULL_HEIGHT - HALF_HEIGHT;
                  if (dy < diff) {
                    contentMaxHeight = FULL_HEIGHT - dy;
                    progress = 1;
                  } else {
                    progress = Math.min(1, Math.max(0, 1 - ((dy - diff) / HALF_HEIGHT)));
                    contentMaxHeight = progress * HALF_HEIGHT;
                    opacity = progress;
                  }
                } else {
                  translateY = rubberBand(dy);
                  contentMaxHeight = FULL_HEIGHT;
                  progress = 1;
                }
              }
              bottomSheetRef.current.style.setProperty('--sheet-progress', progress.toString());
              bottomSheetRef.current.style.transform = `translateY(${translateY}px)`;
              bottomSheetContentRef.current.style.maxHeight = `${contentMaxHeight}px`;
              bottomSheetContentRef.current.style.opacity = opacity.toString();
            } // end mobile
          }}
          onPointerUp={(e) => {
            if (!bottomSheetDrag.current?.dragging) return;
            const dy = e.clientY - bottomSheetDrag.current.startY;
            bottomSheetDrag.current = null;

            let nextState = bottomSheetState;
            const HALF_HEIGHT = 280;
            if (bottomSheetState === 'collapsed') {
              if (Math.abs(dy) < 5) nextState = isDesktop ? 'full' : 'half'; // tap
              else if (dy < 0) {
                const absDy = -dy;
                if (isDesktop || absDy > HALF_HEIGHT + 40) nextState = 'full';
                else nextState = 'half';
              }
            } else if (bottomSheetState === 'half') {
              if (dy < -40) {
                nextState = 'full';
              } else if (dy > 40) {
                nextState = 'collapsed';
              }
            } else if (bottomSheetState === 'full') {
              if (dy > 40) {
                nextState = isDesktop ? 'collapsed' : 'half';
              }
            }

            if (bottomSheetRef.current && bottomSheetContentRef.current) {
              bottomSheetRef.current.classList.remove('bottom-sheet-dragging');
              bottomSheetRef.current.style.setProperty('--sheet-progress', nextState === 'collapsed' ? '0' : '1');
              bottomSheetRef.current.style.transform = 'translateY(0)';

              if (isDesktop) {
                bottomSheetContentRef.current.style.maxHeight = '';
                bottomSheetContentRef.current.style.opacity = '';
              } else {
                const nextMaxHeight = nextState === 'full' ? 'calc(100vh - 140px)' : nextState === 'half' ? '280px' : '0px';
                const nextOpacity = nextState !== 'collapsed' ? '1' : '0';
                bottomSheetContentRef.current.style.maxHeight = nextMaxHeight;
                bottomSheetContentRef.current.style.opacity = nextOpacity;
              }
            }
            // watermark positioning handled by useEffect after state change
            setIsDesktopDragging(false);
            setDesktopSheetHeight(undefined);

            if (nextState !== bottomSheetState) {
              setBottomSheetState(nextState);
            }
          }}
          onPointerCancel={() => {
            setIsDesktopDragging(false);
            setDesktopSheetHeight(undefined);
            bottomSheetDrag.current = null;
            if (bottomSheetRef.current && bottomSheetContentRef.current) {
              bottomSheetRef.current.classList.remove('bottom-sheet-dragging');
              bottomSheetRef.current.style.setProperty('--sheet-progress', bottomSheetState === 'collapsed' ? '0' : '1');
              bottomSheetRef.current.style.transform = 'translateY(0)';

              const currentMaxHeight = bottomSheetState === 'full' ? 'calc(100vh - 140px)' : bottomSheetState === 'half' ? '280px' : '0px';
              const currentOpacity = bottomSheetState !== 'collapsed' ? '1' : '0';
              bottomSheetContentRef.current.style.maxHeight = currentMaxHeight;
              bottomSheetContentRef.current.style.opacity = currentOpacity;
            }
          }}
          style={{ touchAction: 'none', cursor: 'grab' }}
        >
          {/* Drag handle */}
          <div style={{
            width: `calc(30px + 6px * var(--sheet-progress))`,
            height: `calc(3px + 1px * var(--sheet-progress))`,
            borderRadius: '2px',
            background: 'rgba(0,0,0,0.15)',
            marginTop: `calc(5px + 1px * var(--sheet-progress))`,
            marginBottom: 0,
            marginLeft: 'auto',
            marginRight: 'auto',
            transition: 'width 0.3s ease, height 0.3s ease, margin 0.3s ease'
          }} />

          {/* Search bar + profile icon */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              paddingTop: '4px',
              paddingLeft: '14px',
              paddingRight: '14px',
              paddingBottom: `calc(10px - 2px * var(--sheet-progress))`,
              transition: 'padding 0.3s ease'
            }}
          >
            <div
              data-no-drag
              onPointerDown={(e) => { if (bottomSheetSearchActive) e.stopPropagation(); }}
              onClick={(e) => {
                if (!bottomSheetSearchActive) {
                  e.stopPropagation();
                  setBottomSheetSearchActive(true);
                  setBottomSheetState('full');
                  if (bottomSheetContentRef.current) {
                    bottomSheetContentRef.current.style.maxHeight = '';
                    bottomSheetContentRef.current.style.opacity = '';
                  }
                  setTimeout(() => bottomSheetSearchInputRef.current?.focus(), 100);
                }
              }}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                background: 'rgba(118,118,128,0.12)',
                borderRadius: '999px',
                height: '36px',
                paddingLeft: `calc(12px + 2px * var(--sheet-progress))`,
                paddingRight: `calc(12px + 2px * var(--sheet-progress))`,
                cursor: bottomSheetSearchActive ? 'text' : 'pointer',
                transition: 'padding 0.3s ease'
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#1c1c1e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              {bottomSheetSearchActive ? (
                <>
                  <input
                    ref={bottomSheetSearchInputRef}
                    type="text"
                    placeholder="Search cities..."
                    value={bottomSheetSearchQuery}
                    onChange={(e) => setBottomSheetSearchQuery(e.target.value)}
                    onPointerDown={(e) => e.stopPropagation()}
                    onBlur={() => {
                      if (!bottomSheetSearchQuery.trim()) {
                        setTimeout(() => {
                          setBottomSheetSearchActive(false);
                          setBottomSheetSearchQuery('');
                        }, 150);
                      }
                    }}
                    style={{
                      flex: 1,
                      border: 'none',
                      background: 'transparent',
                      outline: 'none',
                      fontSize: '16px',
                      color: '#1c1c1e',
                      fontFamily: 'inherit',
                      padding: 0,
                    }}
                  />
                  {bottomSheetSearchQuery.length > 0 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setBottomSheetSearchQuery(''); bottomSheetSearchInputRef.current?.focus(); }}
                      onPointerDown={(e) => e.stopPropagation()}
                      style={{
                        background: 'rgba(0,0,0,0.12)',
                        border: 'none',
                        borderRadius: '50%',
                        width: '18px',
                        height: '18px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#8e8e93',
                        fontSize: '10px',
                        flexShrink: 0,
                        padding: 0,
                      }}
                    >
                      ✕
                    </button>
                  )}
                </>
              ) : (
                <span style={{ fontSize: '16px', color: '#8e8e93', userSelect: 'none' }}>Find a place to draw on...</span>
              )}
            </div>
            {bottomSheetSearchActive ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setBottomSheetSearchActive(false);
                  setBottomSheetSearchQuery('');
                  setBottomSheetState(isDesktop ? 'full' : 'half');
                }}
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '15px',
                  fontWeight: 500,
                  color: '#007aff',
                  flexShrink: 0,
                  padding: '4px 0',
                  fontFamily: 'inherit',
                }}
              >
                Cancel
              </button>
            ) : (
              <button
                onPointerDown={(e) => { e.stopPropagation(); }}
                onClick={(e) => { e.stopPropagation(); if (user) { setShowAccountSheet(true); } else { setShowAuthModal(true); } }}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  margin: '-4px -2px -4px 0',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {user?.user_metadata?.avatar_url ? (
                  <img
                    src={user.user_metadata.avatar_url}
                    alt=""
                    referrerPolicy="no-referrer"
                    style={{ width: 34, height: 34, borderRadius: '50%', objectFit: 'cover' }}
                  />
                ) : user ? (
                  <div style={{
                    width: 34,
                    height: 34,
                    borderRadius: '50%',
                    background: 'linear-gradient(180deg, #5AC8FA, #007AFF)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '15px',
                    fontWeight: 600,
                    color: '#fff',
                  }}>
                    {(user.user_metadata?.full_name || user.email?.split('@')[0] || 'U').charAt(0).toUpperCase()}
                  </div>
                ) : (
                  <IoPersonCircleSharp size={38} color="#8e8e93" />
                )}
              </button>
            )}
          </div>
        </div>

        {/* Expandable content */}
        <div
          ref={bottomSheetContentRef}
          onScroll={() => { }}
          onTouchStart={(e) => {
            const onCarousel = !!(e.target as HTMLElement).closest('[data-carousel]');
            if (bottomSheetState === 'half' || (bottomSheetState !== 'collapsed' && bottomSheetContentRef.current && bottomSheetContentRef.current.scrollTop <= 0)) {
              bottomSheetDrag.current = { startY: e.touches[0].clientY, startX: e.touches[0].clientX, dragging: true, fromContent: true, lastY: e.touches[0].clientY, lastTime: Date.now(), velocity: 0, onCarousel, directionLocked: false };
            }
          }}
          onTouchMove={(e) => {
            if (!bottomSheetDrag.current?.fromContent) return;
            const dy = e.touches[0].clientY - bottomSheetDrag.current.startY;

            // On first significant movement inside a carousel, lock direction
            if (bottomSheetDrag.current.onCarousel && !bottomSheetDrag.current.directionLocked) {
              const dx = e.touches[0].clientX - (bottomSheetDrag.current.startX ?? 0);
              if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
                if (Math.abs(dx) > Math.abs(dy)) {
                  // Horizontal — let the carousel handle it
                  bottomSheetDrag.current = null;
                  return;
                }
                bottomSheetDrag.current.directionLocked = true;
              } else {
                return; // Wait for enough movement to determine direction
              }
            }

            // Track velocity
            const now = Date.now();
            const dt = now - bottomSheetDrag.current.lastTime;
            if (dt > 0) {
              const instantV = (e.touches[0].clientY - bottomSheetDrag.current.lastY) / dt;
              bottomSheetDrag.current.velocity = 0.7 * instantV + 0.3 * bottomSheetDrag.current.velocity;
            }
            bottomSheetDrag.current.lastY = e.touches[0].clientY;
            bottomSheetDrag.current.lastTime = now;

            if (!bottomSheetRef.current || !bottomSheetContentRef.current) return;

            const HALF_HEIGHT = 280;
            const FULL_HEIGHT = window.innerHeight - 140;

            if (bottomSheetState === 'half') {
              e.preventDefault();
              bottomSheetRef.current.classList.add('bottom-sheet-dragging');
              // Same logic as handle drag in half state
              let progress = 1;
              let contentMaxHeight = 0;
              let opacity = 1;
              let translateY = 0;
              const rubberBand = (d: number) => { const abs = Math.abs(d); const sign = d < 0 ? -1 : 1; return sign * 50 * Math.log(1 + abs / 50); };
              if (dy > 0) {
                progress = Math.min(1, Math.max(0, 1 - (dy / HALF_HEIGHT)));
                contentMaxHeight = progress * HALF_HEIGHT;
                opacity = progress;
              } else {
                const diff = FULL_HEIGHT - HALF_HEIGHT;
                let added = -dy;
                if (added > diff) {
                  translateY = -rubberBand(added - diff);
                  added = diff;
                }
                contentMaxHeight = Math.min(FULL_HEIGHT, HALF_HEIGHT + added);
                progress = 1;
              }
              bottomSheetRef.current.style.setProperty('--sheet-progress', progress.toString());
              bottomSheetRef.current.style.transform = `translateY(${translateY}px)`;
              bottomSheetContentRef.current.style.maxHeight = `${contentMaxHeight}px`;
              bottomSheetContentRef.current.style.opacity = opacity.toString();
            } else if (bottomSheetState === 'full' && dy > 0) {
              e.preventDefault();
              bottomSheetRef.current.classList.add('bottom-sheet-dragging');
              const diff = FULL_HEIGHT - HALF_HEIGHT;
              let progress = 1;
              let contentMaxHeight: number;
              let opacity = 1;
              if (dy < diff) {
                contentMaxHeight = FULL_HEIGHT - dy;
              } else {
                progress = Math.min(1, Math.max(0, 1 - ((dy - diff) / HALF_HEIGHT)));
                contentMaxHeight = progress * HALF_HEIGHT;
                opacity = progress;
              }
              bottomSheetRef.current.style.setProperty('--sheet-progress', progress.toString());
              bottomSheetContentRef.current.style.maxHeight = `${contentMaxHeight}px`;
              bottomSheetContentRef.current.style.opacity = opacity.toString();
            } else {
              // Dragging up in full or other — cancel drag
              bottomSheetDrag.current = null;
              bottomSheetRef.current.classList.remove('bottom-sheet-dragging');
            }
          }}
          onTouchEnd={(e) => {
            if (!bottomSheetDrag.current?.fromContent) return;
            const dy = e.changedTouches[0].clientY - bottomSheetDrag.current.startY;
            bottomSheetDrag.current = null;

            let nextState = bottomSheetState;
            if (bottomSheetState === 'half') {
              if (dy < -40) {
                nextState = 'full';
              } else if (dy > 40) {
                nextState = 'collapsed';
              }
            } else if (bottomSheetState === 'full') {
              if (dy > 40) {
                nextState = isDesktop ? 'collapsed' : 'half';
              }
            }

            if (bottomSheetRef.current && bottomSheetContentRef.current) {
              bottomSheetRef.current.classList.remove('bottom-sheet-dragging');
              bottomSheetRef.current.style.setProperty('--sheet-progress', nextState === 'collapsed' ? '0' : '1');
              bottomSheetRef.current.style.transform = 'translateY(0)';

              const nextMaxHeight = nextState === 'full' ? 'calc(100vh - 140px)' : nextState === 'half' ? '280px' : '0px';
              const nextOpacity = nextState !== 'collapsed' ? '1' : '0';
              bottomSheetContentRef.current.style.maxHeight = nextMaxHeight;
              bottomSheetContentRef.current.style.opacity = nextOpacity;
            }
            // watermark positioning handled by useEffect after state change

            if (nextState !== bottomSheetState) {
              setBottomSheetState(nextState);
            }
          }}
          style={{
            maxHeight: isDesktop ? undefined : bottomSheetState === 'full' ? 'calc(100vh - 140px)' : bottomSheetState === 'half' ? '280px' : '0px',
            minHeight: !isDesktop && bottomSheetSearchActive && bottomSheetSearchQuery.trim() !== '' ? 'calc(100vh - 140px)' : undefined,
            flex: isDesktop ? 1 : undefined,
            opacity: bottomSheetState !== 'collapsed' ? 1 : 0,
            overflowY: isDesktop ? (bottomSheetState === 'collapsed' ? 'hidden' : 'auto') : bottomSheetState === 'full' ? 'auto' : 'hidden',
            overflowX: 'hidden',
            overscrollBehavior: 'none',
            transition: 'max-height 0.35s cubic-bezier(0.2,0.8,0.2,1), opacity 0.2s ease',
          }}>

          {bottomSheetSearchActive && bottomSheetSearchQuery.trim() !== '' ? (
            /* Search results — only shown when user has typed something */
            <div style={{ padding: '4px 16px 12px' }}>
              {bottomSheetFilteredLocations.length > 0 ? (
                <div style={{ borderRadius: '16px', background: 'rgba(0,0,0,0.04)', overflow: 'hidden' }}>
                  {bottomSheetFilteredLocations.map((loc, idx) => (
                    <button
                      key={loc.id}
                      className="sidebar-row"
                      onClick={() => {
                        navigateToLocation({ id: loc.id, city: loc.city, lat: loc.lat, lng: loc.lng });
                        setBottomSheetSearchActive(false);
                        setBottomSheetSearchQuery('');
                      }}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        padding: '12px 14px',
                        background: 'transparent',
                        border: 'none',
                        borderTop: idx === 0 ? 'none' : '0.5px solid rgba(0,0,0,0.06)',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8e8e93" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                        <circle cx="12" cy="10" r="3" />
                      </svg>
                      <div style={{
                        flex: 1, minWidth: 0,
                        fontSize: '15px', fontWeight: 600, color: '#1c1c1e',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>
                        {loc.city}
                      </div>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#c7c7cc" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                    </button>
                  ))}
                </div>
              ) : (
                <div style={{ padding: '24px 0', textAlign: 'center', color: '#8e8e93', fontSize: '15px' }}>
                  No results found
                </div>
              )}
            </div>
          ) : (
            <div>
              {/* Popular */}
              {popularLocations.length > 0 && (
                <div style={{ padding: '8px 0 4px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#1c1c1e', textTransform: 'uppercase', letterSpacing: '0.5px', padding: '0 16px 8px' }}>
                    Popular
                  </div>
                  <div
                    onWheel={(e) => {
                      e.stopPropagation();
                      if (e.deltaY !== 0) {
                        e.currentTarget.scrollLeft += e.deltaY * 0.3;
                        e.preventDefault();
                      }
                    }}
                    data-carousel
                    style={{
                      display: 'flex',
                      gap: '14px',
                      overflowX: 'auto',
                      padding: '0 16px 8px',
                      scrollbarWidth: 'none',
                      msOverflowStyle: 'none',
                      touchAction: 'pan-x',
                      overscrollBehavior: 'none',
                    }}>
                    {popularLocations.map((loc) => (
                      <button
                        key={loc.id}
                        onClick={() => navigateToLocation(loc)}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: '6px',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: 0,
                          minWidth: '96px',
                        }}
                      >
                        <div style={{
                          width: 100, height: 100, borderRadius: '50%',
                          background: 'rgba(118,118,128,0.12)',
                          overflow: 'hidden',
                          boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
                        }}>
                          {loc.thumbUrl ? (
                            <img src={loc.thumbUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} crossOrigin="anonymous" />
                          ) : (
                            <div style={{ width: '100%', height: '100%', background: 'rgba(118,118,128,0.12)' }} />
                          )}
                        </div>
                        <span style={{ fontSize: '12px', color: '#3c3c43', fontWeight: 500, maxWidth: '96px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {loc.city}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Discover */}
              {discoverEntries.length > 0 && (
                <div style={{ padding: '8px 0 4px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#1c1c1e', textTransform: 'uppercase', letterSpacing: '0.5px', padding: '0 16px 8px' }}>
                    Discover
                  </div>
                  <div
                    onWheel={(e) => {
                      e.stopPropagation();
                      if (e.deltaY !== 0) {
                        const itemWidth = 150 + 10; // minWidth + gap
                        e.currentTarget.scrollBy({ left: e.deltaY > 0 ? itemWidth : -itemWidth, behavior: 'smooth' });
                        e.preventDefault();
                      }
                    }}
                    data-carousel
                    style={{
                      display: 'flex',
                      gap: '10px',
                      overflowX: 'auto',
                      padding: '0 16px 8px',
                      scrollbarWidth: 'none',
                      msOverflowStyle: 'none',
                      touchAction: 'pan-x',
                      overscrollBehavior: 'none',
                      scrollSnapType: 'x mandatory',
                      scrollPaddingLeft: '16px',
                    }}
                  >
                    {discoverEntries.map((entry) => (
                      <button
                        key={entry.image_id}
                        onClick={() => navigateToLocation({ id: entry.image_id, city: entry.city, lat: entry.lat, lng: entry.lng })}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: 0,
                          minWidth: '150px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '4px',
                          scrollSnapAlign: 'start',
                          scrollSnapStop: 'always',
                        }}
                      >
                        <div style={{
                          width: 150, height: 200, borderRadius: '12px',
                          overflow: 'hidden',
                          background: 'rgba(118,118,128,0.12)',
                          position: 'relative',
                        }}>
                          <img src={entry.screenshot_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} crossOrigin="anonymous" />
                          <div style={{
                            position: 'absolute', bottom: 0, left: 0, right: 0,
                            padding: '32px 8px 8px',
                            background: 'linear-gradient(to top, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.3) 40%, transparent 100%)',
                            mask: 'linear-gradient(to top, black 0%, black 50%, transparent 100%)',
                            WebkitMask: 'linear-gradient(to top, black 0%, black 50%, transparent 100%)',
                            backdropFilter: 'blur(8px)',
                            WebkitBackdropFilter: 'blur(8px)',
                            display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
                          }}>
                            <span style={{
                              fontSize: '14px', fontWeight: 700, color: '#fff',
                              textTransform: 'uppercase', letterSpacing: '0.5px',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              flex: 1, minWidth: 0, textAlign: 'left',
                            }}>
                              {entry.city}
                            </span>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Recent */}
              {recentLocations.length > 0 && (
                <div style={{ padding: '4px 16px 12px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#1c1c1e', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                    Recent
                  </div>
                  <div style={{ borderRadius: '16px', background: 'rgba(0,0,0,0.04)', overflow: 'hidden' }}>
                    {recentLocations.slice(0, 10).map((loc, i) => (
                      <button
                        key={loc.id}
                        className="sidebar-row"
                        onClick={() => navigateToLocation(loc)}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '12px',
                          padding: '10px 14px',
                          background: 'transparent',
                          border: 'none',
                          borderTop: i > 0 ? '0.5px solid rgba(0,0,0,0.06)' : 'none',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <div style={{
                          width: 40, height: 40, borderRadius: '50%',
                          overflow: 'hidden',
                          flexShrink: 0,
                          background: 'rgba(118,118,128,0.18)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '16px',
                          fontWeight: 700,
                          color: '#8e8e93',
                        }}>
                          {loc.thumbUrl ? (
                            <img src={loc.thumbUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} crossOrigin="anonymous" />
                          ) : (
                            loc.city.charAt(0).toUpperCase()
                          )}
                        </div>
                        <div style={{
                          flex: 1, minWidth: 0,
                          fontSize: '15px', fontWeight: 600, color: '#1c1c1e',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                          {loc.city}
                        </div>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8e8e93" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                          <path d="m9 18 6-6-6-6" />
                        </svg>
                      </button>
                    ))}
                  </div>
                </div>
              )}

          {/* CTA — only in full state */}
          {!user && !(bottomSheetSearchActive && bottomSheetSearchQuery.trim() !== '') && (
            <div style={{ padding: '12px 16px 16px', position: 'relative', overflow: 'hidden' }}>
              <button
                onClick={() => setShowAuthModal(true)}
                style={{
                  width: '100%',
                  padding: '12px',
                  borderRadius: '14px',
                  border: 'none',
                  background: '#007aff',
                  color: '#fff',
                  fontSize: '15px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  letterSpacing: '-0.2px',
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                Sign Up
              </button>

            </div>
          )}
          {user && (!tier || !tier.isPlus) && !(bottomSheetSearchActive && bottomSheetSearchQuery.trim() !== '') && (
            <div style={{ padding: '12px 16px 16px', position: 'relative', overflow: 'hidden' }}>
              <button
                onClick={() => setShowPlusSheet(true)}
                style={{
                  width: '100%',
                  padding: '12px',
                  borderRadius: '14px',
                  border: 'none',
                  background: 'rgba(0,122,255,0.12)',
                  color: '#007aff',
                  fontSize: '15px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  letterSpacing: '-0.2px',
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                Unlock Plus
                <svg
                  width="80"
                  height="80"
                  viewBox="0 0 512 512"
                  xmlns="http://www.w3.org/2000/svg"
                  style={{
                    position: 'absolute',
                    bottom: -28,
                    right: -20,
                    pointerEvents: 'none',
                    overflow: 'hidden',
                  }}
                >
                  <defs>
                    <clipPath id="splat-clip-btn">
                      <path d="M438.024,210.133c0,7.488,6.08,13.551,13.551,13.551c7.488,0,13.569-6.063,13.569-13.551c0-7.479-6.081-13.552-13.569-13.552C444.104,196.581,438.024,202.654,438.024,210.133z" />
                      <path d="M400.097,376.503c-5.994,0-10.842,4.856-10.842,10.85c0,5.986,4.848,10.832,10.842,10.832c5.994,0,10.841-4.847,10.841-10.832C410.938,381.359,406.091,376.503,400.097,376.503z" />
                      <path d="M382.758,415.376c-12.284,0-22.238,9.956-22.238,22.238c0,12.274,9.955,22.229,22.238,22.229c12.283,0,22.238-9.955,22.238-22.229C404.997,425.332,395.041,415.376,382.758,415.376z" />
                      <circle cx="137.251" cy="426.904" r="16.8" />
                      <path d="M94.425,359.164c-4.778,0-8.669,3.874-8.669,8.678c0,4.778,3.892,8.66,8.669,8.66c4.796,0,8.67-3.883,8.67-8.66C103.094,363.038,99.22,359.164,94.425,359.164z" />
                      <path d="M54.865,151.063c6.29,0,11.38-5.1,11.38-11.389c0-6.281-5.09-11.38-11.38-11.38c-6.289,0-11.38,5.099-11.38,11.38C43.485,145.963,48.576,151.063,54.865,151.063z" />
                      <path d="M165.97,97.952c8.374,0,15.166-6.793,15.166-15.185c0-8.365-6.792-15.158-15.166-15.158s-15.168,6.794-15.168,15.158C150.802,91.158,157.596,97.952,165.97,97.952z" />
                      <path d="M450.775,300.632c-47.586-16.887-56.968-10.485-80.214-32.515c-5.56-5.255-5.438-22.49,25.47-18.425c15.497,2.042,26.008-6.506,26.008-18.702c0-8.131-9.799-19.433-24.393-13.821c-21.126,8.131-34.834-1.094-37.388-11.38c-3.25-13.004,0.434-27.832,54.814-54.996c66.646-33.332,28.423-93.983-23.924-36.859c-23.194,25.296-34.14,35.764-49.584,43.895c-13.864,7.288-30.49-0.27-17.895-17.069c4.882-6.507,13.17-11.527,15.445-19.511c3.249-11.38-6.324-21.952-14.628-21.952c-8.304,0-18.694,4.874-21.943,17.07c-4.882,22.359-17.322,21.24-23.194,14.785c-11.241-12.318-7.193-26.686-5.264-48.924c2.276-26.121,17.738-86.443-29.709-81.995c-22.88,2.146-29.639,23.715-22.238,62.267c9.208,47.856-4.725,81.257-19.597,88.007c-17.878,8.13-26.946,5.046-65.029-21.126c-20.24-13.926-42.584-1.703-47.152,14.628c-4.031,14.385,7.332,31.768,24.393,37.396c26.286,8.678,37.944,10.693,50.14,17.33c11.918,6.507,13.412,22.282,1.511,36.554c-11.918,14.282-42.705,2.468-88.224-0.782c-78.685-5.611-60.999,81.43,12.996,55.831c42.27-14.637,60.147-11.389,67.479-2.441c10.112,12.344,3.162,29.031-16.54,40.915c-62.858,37.944,7.61,85.078,33.618,32.515c10.876-21.961,23.385-28.71,35.756-23.846c10.094,3.979,23.02,39.204,8.409,86.72C206.885,466.473,207.771,512,238.33,512c28.563,0,33.028-42.539,28.164-88.875c-1.808-17.339-0.47-44.207,13.012-50.948c10.842-5.421,27.781-11.458,39.283,12.457c10.58,21.951,33.34,18.693,42.287,6.506c6.532-8.921,9.851-28.71-16.157-38.969c-30.995-12.249-19.615-45.58,3.961-42.323c26.026,3.588,43.868,13.17,74.794,39.569C466.829,386.233,522.234,325.989,450.775,300.632z" />
                    </clipPath>
                    <linearGradient id="rainbow-btn" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
                      <stop offset="0%" stopColor="#E040FB" />
                      <stop offset="33%" stopColor="#536DFE" />
                      <stop offset="66%" stopColor="#00BCD4" />
                      <stop offset="100%" stopColor="#76FF03" />
                    </linearGradient>
                  </defs>
                  <g clipPath="url(#splat-clip-btn)">
                    <rect x="0" y="0" width="512" height="512" fill="url(#rainbow-btn)" />
                  </g>
                </svg>
              </button>
            </div>
          )}
            </div>
          )}

        </div>{/* end expandable content */}
      </div>


      {/* Auth Modal — bottom sheet */}
      {(showAuthModal || isAuthModalClosing) && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60 }}>
          {/* Scrim */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.4)",
              animation: isAuthModalClosing
                ? "sidebarScrimOut 0.3s forwards"
                : "sidebarScrimIn 0.3s forwards",
            }}
            onClick={() => {
              setIsAuthModalClosing(true);
              setTimeout(() => {
                setShowAuthModal(false);
                setIsAuthModalClosing(false);
                setAuthStep("idle");
                setAuthEmail("");
              }, 300);
            }}
          />
          {/* Sheet */}
          <div
            className={`heatmap-sheet-dialog ${isAuthModalClosing ? 'heatmap-sheet-leaving' : 'heatmap-sheet-entering'}`}
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              maxWidth: "420px",
              marginLeft: "auto",
              marginRight: "auto",
              borderRadius: "32px 32px 0 0",
              background: "rgba(255,255,255,0.92)",
              backdropFilter: "blur(20px)",
              WebkitBackdropFilter: "blur(20px)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
              paddingBottom: "env(safe-area-inset-bottom, 0px)",
              pointerEvents: 'auto',
              animation: isAuthModalClosing
                ? "slideDownSheet 0.3s cubic-bezier(0.2,0.8,0.2,1) forwards"
                : "slideUpSheet 0.35s cubic-bezier(0.2,0.8,0.2,1) forwards",
            }}
          >
            {/* Drag handle + close button */}
            <div
              className="heatmap-sheet-drag-handle"
              style={{ position: "relative", touchAction: "none", cursor: "grab" }}
              onPointerDown={(e) => {
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                (e.currentTarget as any)._dragStartY = e.clientY;
                const sheet = e.currentTarget.parentElement;
                if (sheet) sheet.style.transition = 'none';
              }}
              onPointerMove={(e) => {
                const startY = (e.currentTarget as any)._dragStartY;
                if (startY == null) return;
                const dy = e.clientY - startY;
                if (dy > 0) {
                  const sheet = e.currentTarget.parentElement;
                  if (sheet) sheet.style.transform = `translateY(${dy}px)`;
                }
              }}
              onPointerUp={(e) => {
                const startY = (e.currentTarget as any)._dragStartY;
                (e.currentTarget as any)._dragStartY = null;
                const sheet = e.currentTarget.parentElement;
                if (sheet) sheet.style.transition = '';
                const dy = startY != null ? e.clientY - startY : 0;
                if (dy > 60) {
                  setIsAuthModalClosing(true);
                  setTimeout(() => {
                    setShowAuthModal(false);
                    setIsAuthModalClosing(false);
                    setAuthStep("idle");
                    setAuthEmail("");
                  }, 300);
                } else if (sheet) {
                  sheet.style.transform = '';
                }
              }}
            >
              <div
                style={{
                  width: "36px",
                  height: "4px",
                  borderRadius: "2px",
                  background: "rgba(0,0,0,0.12)",
                  margin: "6px auto 0",
                }}
              />
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  setIsAuthModalClosing(true);
                  setTimeout(() => {
                    setShowAuthModal(false);
                    setIsAuthModalClosing(false);
                    setAuthStep("idle");
                    setAuthEmail("");
                  }, 300);
                }}
                style={{
                  position: "absolute",
                  top: "8px",
                  right: "12px",
                  width: "28px",
                  height: "28px",
                  borderRadius: "50%",
                  background: "rgba(118,118,128,0.12)",
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#8e8e93" strokeWidth="2" strokeLinecap="round">
                  <line x1="1" y1="1" x2="11" y2="11" />
                  <line x1="11" y1="1" x2="1" y2="11" />
                </svg>
              </button>
            </div>

            <div style={{ padding: "16px 24px 32px" }}>
              {/* Title + subtitle */}
              <h2
                style={{
                  margin: "0 0 6px",
                  fontSize: "20px",
                  fontWeight: 600,
                  color: "#1c1c1e",
                }}
              >
                Sign in to{" "}
                <svg width="20" height="20" viewBox="0 0 512 512" fill="#1c1c1e" style={{ display: "inline-block", verticalAlign: "-2px", marginRight: "-1px" }}>
                  <path d="M438.024,210.133c0,7.488,6.08,13.551,13.551,13.551c7.488,0,13.569-6.063,13.569-13.551c0-7.479-6.081-13.552-13.569-13.552C444.104,196.581,438.024,202.654,438.024,210.133z" />
                  <path d="M400.097,376.503c-5.994,0-10.842,4.856-10.842,10.85c0,5.986,4.848,10.832,10.842,10.832c5.994,0,10.841-4.847,10.841-10.832C410.938,381.359,406.091,376.503,400.097,376.503z" />
                  <path d="M382.758,415.376c-12.284,0-22.238,9.956-22.238,22.238c0,12.274,9.955,22.229,22.238,22.229c12.283,0,22.238-9.955,22.238-22.229C404.997,425.332,395.041,415.376,382.758,415.376z" />
                  <circle cx="137.251" cy="426.904" r="16.8" />
                  <path d="M94.425,359.164c-4.778,0-8.669,3.874-8.669,8.678c0,4.778,3.892,8.66,8.669,8.66c4.796,0,8.67-3.883,8.67-8.66C103.094,363.038,99.22,359.164,94.425,359.164z" />
                  <path d="M54.865,151.063c6.29,0,11.38-5.1,11.38-11.389c0-6.281-5.09-11.38-11.38-11.38c-6.289,0-11.38,5.099-11.38,11.38C43.485,145.963,48.576,151.063,54.865,151.063z" />
                  <path d="M165.97,97.952c8.374,0,15.166-6.793,15.166-15.185c0-8.365-6.792-15.158-15.166-15.158s-15.168,6.794-15.168,15.158C150.802,91.158,157.596,97.952,165.97,97.952z" />
                  <path d="M450.775,300.632c-47.586-16.887-56.968-10.485-80.214-32.515c-5.56-5.255-5.438-22.49,25.47-18.425c15.497,2.042,26.008-6.506,26.008-18.702c0-8.131-9.799-19.433-24.393-13.821c-21.126,8.131-34.834-1.094-37.388-11.38c-3.25-13.004,0.434-27.832,54.814-54.996c66.646-33.332,28.423-93.983-23.924-36.859c-23.194,25.296-34.14,35.764-49.584,43.895c-13.864,7.288-30.49-0.27-17.895-17.069c4.882-6.507,13.17-11.527,15.445-19.511c3.249-11.38-6.324-21.952-14.628-21.952c-8.304,0-18.694,4.874-21.943,17.07c-4.882,22.359-17.322,21.24-23.194,14.785c-11.241-12.318-7.193-26.686-5.264-48.924c2.276-26.121,17.738-86.443-29.709-81.995c-22.88,2.146-29.639,23.715-22.238,62.267c9.208,47.856-4.725,81.257-19.597,88.007c-17.878,8.13-26.946,5.046-65.029-21.126c-20.24-13.926-42.584-1.703-47.152,14.628c-4.031,14.385,7.332,31.768,24.393,37.396c26.286,8.678,37.944,10.693,50.14,17.33c11.918,6.507,13.412,22.282,1.511,36.554c-11.918,14.282-42.705,2.468-88.224-0.782c-78.685-5.611-60.999,81.43,12.996,55.831c42.27-14.637,60.147-11.389,67.479-2.441c10.112,12.344,3.162,29.031-16.54,40.915c-62.858,37.944,7.61,85.078,33.618,32.515c10.876-21.961,23.385-28.71,35.756-23.846c10.094,3.979,23.02,39.204,8.409,86.72C206.885,466.473,207.771,512,238.33,512c28.563,0,33.028-42.539,28.164-88.875c-1.808-17.339-0.47-44.207,13.012-50.948c10.842-5.421,27.781-11.458,39.283,12.457c10.58,21.951,33.34,18.693,42.287,6.506c6.532-8.921,9.851-28.71-16.157-38.969c-30.995-12.249-19.615-45.58,3.961-42.323c26.026,3.588,43.868,13.17,74.794,39.569C466.829,386.233,522.234,325.989,450.775,300.632z" />
                </svg>
                {" "}Sign in
              </h2>
              <p
                style={{
                  margin: "0 0 24px",
                  fontSize: "14px",
                  color: "#8e8e93",
                  lineHeight: 1.5,
                }}
              >
                More ink, save progress, and unlock upgrades.
              </p>

              {/* Google button */}
              <button
                onClick={async () => {
                  await supabase.auth.signInWithOAuth({
                    provider: "google",
                    options: { redirectTo: window.location.origin },
                  });
                }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "10px",
                  padding: "14px",
                  background: "#fff",
                  color: "#1c1c1e",
                  border: "0.5px solid rgba(0,0,0,0.12)",
                  borderRadius: "14px",
                  fontWeight: 600,
                  fontSize: "16px",
                  cursor: "pointer",
                  marginBottom: "10px",
                  fontFamily: "inherit",
                }}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 18 18"
                  xmlns="http://www.w3.org/2000/svg"
                  style={{ flexShrink: 0 }}
                >
                  <path
                    d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
                    fill="#4285F4"
                  />
                  <path
                    d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
                    fill="#34A853"
                  />
                  <path
                    d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"
                    fill="#FBBC05"
                  />
                  <path
                    d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.163 6.656 3.58 9 3.58z"
                    fill="#EA4335"
                  />
                </svg>
                Continue with Google
              </button>

              {/* Divider */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  marginBottom: "10px",
                }}
              >
                <div
                  style={{
                    flex: 1,
                    height: "0.5px",
                    background: "rgba(60,60,67,0.18)",
                  }}
                />
                <span style={{ fontSize: "13px", color: "#8e8e93" }}>or</span>
                <div
                  style={{
                    flex: 1,
                    height: "0.5px",
                    background: "rgba(60,60,67,0.18)",
                  }}
                />
              </div>

              {authStep === "sent" ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "8px",
                    padding: "14px",
                    background: "rgba(118,118,128,0.08)",
                    borderRadius: "14px",
                    color: "#1c1c1e",
                    fontSize: "15px",
                    fontWeight: 600,
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#34C759"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    width="16"
                    height="16"
                    style={{ flexShrink: 0 }}
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Check your email for a link
                </div>
              ) : (
                <>
                  {/* Email input */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      background: "rgba(118,118,128,0.08)",
                      borderRadius: "14px",
                      padding: "12px 14px",
                      marginBottom: "10px",
                    }}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#8e8e93"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ flexShrink: 0 }}
                    >
                      <rect x="2" y="4" width="20" height="16" rx="2" />
                      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                    </svg>
                    <input
                      type="email"
                      placeholder="Email address"
                      value={authEmail}
                      onChange={(e) => setAuthEmail(e.target.value)}
                      onKeyDown={async (e) => {
                        if (
                          e.key === "Enter" &&
                          authEmail &&
                          authStep === "idle"
                        ) {
                          setAuthStep("sending");
                          await supabase.auth.signInWithOtp({
                            email: authEmail,
                            options: {
                              emailRedirectTo: window.location.origin,
                            },
                          });
                          setAuthStep("sent");
                        }
                      }}
                      style={{
                        flex: 1,
                        border: "none",
                        background: "transparent",
                        outline: "none",
                        fontSize: "16px",
                        color: "#1c1c1e",
                        fontFamily: "inherit",
                      }}
                    />
                  </div>
                  <button
                    onClick={async () => {
                      if (!authEmail || authStep !== "idle") return;
                      setAuthStep("sending");
                      await supabase.auth.signInWithOtp({
                        email: authEmail,
                        options: { emailRedirectTo: window.location.origin },
                      });
                      setAuthStep("sent");
                    }}
                    style={{
                      width: "100%",
                      padding: "14px",
                      background: authEmail ? "#007aff" : "rgba(0,122,255,0.35)",
                      color: "#fff",
                      border: "none",
                      borderRadius: "14px",
                      fontWeight: 600,
                      fontSize: "16px",
                      cursor: authEmail ? "pointer" : "default",
                      transition: "background 0.2s ease",
                      fontFamily: "inherit",
                    }}
                  >
                    {authStep === "sending"
                      ? "Sending…"
                      : "Continue with Email"}
                  </button>
                </>
              )}

              {/* Terms footnote */}
              <p
                style={{
                  margin: "16px 0 0",
                  fontSize: "11px",
                  color: "#8e8e93",
                  textAlign: "center",
                  lineHeight: 1.4,
                }}
              >
                By continuing, you agree to our{" "}
                <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: "#8e8e93", textDecoration: "underline" }}>Terms</a>
                {" "}and{" "}
                <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: "#8e8e93", textDecoration: "underline" }}>Privacy Policy</a>.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Plus Subscription Bottom Sheet */}
      {(showPlusSheet || isPlusSheetClosing) && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60 }}>
          {/* Scrim */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.4)",
              animation: isPlusSheetClosing
                ? "sidebarScrimOut 0.3s forwards"
                : "sidebarScrimIn 0.3s forwards",
            }}
            onClick={() => {
              setIsPlusSheetClosing(true);
              setTimeout(() => {
                setShowPlusSheet(false);
                setIsPlusSheetClosing(false);
              }, 300);
            }}
          />
          {/* Sheet */}
          <div
            className={`heatmap-sheet-dialog ${isPlusSheetClosing ? 'heatmap-sheet-leaving' : 'heatmap-sheet-entering'}`}
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              maxWidth: "420px",
              marginLeft: "auto",
              marginRight: "auto",
              borderRadius: "32px 32px 0 0",
              background: "rgba(255,255,255,0.92)",
              backdropFilter: "blur(20px)",
              WebkitBackdropFilter: "blur(20px)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
              paddingBottom: "env(safe-area-inset-bottom, 0px)",
              pointerEvents: 'auto',
              animation: isPlusSheetClosing
                ? "slideDownSheet 0.3s cubic-bezier(0.2,0.8,0.2,1) forwards"
                : "slideUpSheet 0.35s cubic-bezier(0.2,0.8,0.2,1) forwards",
            }}
          >
            {/* Drag handle + close button */}
            <div
              className="heatmap-sheet-drag-handle"
              style={{ position: "relative", touchAction: "none", cursor: "grab" }}
              onPointerDown={(e) => {
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                (e.currentTarget as any)._dragStartY = e.clientY;
                const sheet = e.currentTarget.parentElement;
                if (sheet) sheet.style.transition = 'none';
              }}
              onPointerMove={(e) => {
                const startY = (e.currentTarget as any)._dragStartY;
                if (startY == null) return;
                const dy = e.clientY - startY;
                if (dy > 0) {
                  const sheet = e.currentTarget.parentElement;
                  if (sheet) sheet.style.transform = `translateY(${dy}px)`;
                }
              }}
              onPointerUp={(e) => {
                const startY = (e.currentTarget as any)._dragStartY;
                (e.currentTarget as any)._dragStartY = null;
                const sheet = e.currentTarget.parentElement;
                if (sheet) sheet.style.transition = '';
                const dy = startY != null ? e.clientY - startY : 0;
                if (dy > 60) {
                  setIsPlusSheetClosing(true);
                  setTimeout(() => {
                    setShowPlusSheet(false);
                    setIsPlusSheetClosing(false);
                  }, 300);
                } else if (sheet) {
                  sheet.style.transform = '';
                }
              }}
            >
              <div
                style={{
                  width: "36px",
                  height: "4px",
                  borderRadius: "2px",
                  background: "rgba(0,0,0,0.12)",
                  margin: "6px auto 0",
                }}
              />
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  setIsPlusSheetClosing(true);
                  setTimeout(() => {
                    setShowPlusSheet(false);
                    setIsPlusSheetClosing(false);
                  }, 300);
                }}
                style={{
                  position: "absolute",
                  top: "8px",
                  right: "12px",
                  width: "28px",
                  height: "28px",
                  borderRadius: "50%",
                  background: "rgba(118,118,128,0.12)",
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#8e8e93" strokeWidth="2" strokeLinecap="round">
                  <line x1="1" y1="1" x2="11" y2="11" />
                  <line x1="11" y1="1" x2="1" y2="11" />
                </svg>
              </button>
            </div>

            <div style={{ padding: "16px 24px 32px" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  marginBottom: "16px",
                }}
              >
                <svg
                  width="120"
                  height="120"
                  viewBox="0 0 512 512"
                  xmlns="http://www.w3.org/2000/svg"
                  style={{ overflow: "hidden" }}
                >
                  <defs>
                    <clipPath id="splat-clip-heatmap">
                      <path d="M438.024,210.133c0,7.488,6.08,13.551,13.551,13.551c7.488,0,13.569-6.063,13.569-13.551c0-7.479-6.081-13.552-13.569-13.552C444.104,196.581,438.024,202.654,438.024,210.133z" />
                      <path d="M400.097,376.503c-5.994,0-10.842,4.856-10.842,10.85c0,5.986,4.848,10.832,10.842,10.832c5.994,0,10.841-4.847,10.841-10.832C410.938,381.359,406.091,376.503,400.097,376.503z" />
                      <path d="M382.758,415.376c-12.284,0-22.238,9.956-22.238,22.238c0,12.274,9.955,22.229,22.238,22.229c12.283,0,22.238-9.955,22.238-22.229C404.997,425.332,395.041,415.376,382.758,415.376z" />
                      <circle cx="137.251" cy="426.904" r="16.8" />
                      <path d="M94.425,359.164c-4.778,0-8.669,3.874-8.669,8.678c0,4.778,3.892,8.66,8.669,8.66c4.796,0,8.67-3.883,8.67-8.66C103.094,363.038,99.22,359.164,94.425,359.164z" />
                      <path d="M54.865,151.063c6.29,0,11.38-5.1,11.38-11.389c0-6.281-5.09-11.38-11.38-11.38c-6.289,0-11.38,5.099-11.38,11.38C43.485,145.963,48.576,151.063,54.865,151.063z" />
                      <path d="M165.97,97.952c8.374,0,15.166-6.793,15.166-15.185c0-8.365-6.792-15.158-15.166-15.158s-15.168,6.794-15.168,15.158C150.802,91.158,157.596,97.952,165.97,97.952z" />
                      <path d="M450.775,300.632c-47.586-16.887-56.968-10.485-80.214-32.515c-5.56-5.255-5.438-22.49,25.47-18.425c15.497,2.042,26.008-6.506,26.008-18.702c0-8.131-9.799-19.433-24.393-13.821c-21.126,8.131-34.834-1.094-37.388-11.38c-3.25-13.004,0.434-27.832,54.814-54.996c66.646-33.332,28.423-93.983-23.924-36.859c-23.194,25.296-34.14,35.764-49.584,43.895c-13.864,7.288-30.49-0.27-17.895-17.069c4.882-6.507,13.17-11.527,15.445-19.511c3.249-11.38-6.324-21.952-14.628-21.952c-8.304,0-18.694,4.874-21.943,17.07c-4.882,22.359-17.322,21.24-23.194,14.785c-11.241-12.318-7.193-26.686-5.264-48.924c2.276-26.121,17.738-86.443-29.709-81.995c-22.88,2.146-29.639,23.715-22.238,62.267c9.208,47.856-4.725,81.257-19.597,88.007c-17.878,8.13-26.946,5.046-65.029-21.126c-20.24-13.926-42.584-1.703-47.152,14.628c-4.031,14.385,7.332,31.768,24.393,37.396c26.286,8.678,37.944,10.693,50.14,17.33c11.918,6.507,13.412,22.282,1.511,36.554c-11.918,14.282-42.705,2.468-88.224-0.782c-78.685-5.611-60.999,81.43,12.996,55.831c42.27-14.637,60.147-11.389,67.479-2.441c10.112,12.344,3.162,29.031-16.54,40.915c-62.858,37.944,7.61,85.078,33.618,32.515c10.876-21.961,23.385-28.71,35.756-23.846c10.094,3.979,23.02,39.204,8.409,86.72C206.885,466.473,207.771,512,238.33,512c28.563,0,33.028-42.539,28.164-88.875c-1.808-17.339-0.47-44.207,13.012-50.948c10.842-5.421,27.781-11.458,39.283,12.457c10.58,21.951,33.34,18.693,42.287,6.506c6.532-8.921,9.851-28.71-16.157-38.969c-30.995-12.249-19.615-45.58,3.961-42.323c26.026,3.588,43.868,13.17,74.794,39.569C466.829,386.233,522.234,325.989,450.775,300.632z" />
                    </clipPath>
                    <linearGradient
                      id="rainbow-heatmap"
                      x1="0"
                      y1="0"
                      x2="512"
                      y2="512"
                      gradientUnits="userSpaceOnUse"
                      spreadMethod="repeat"
                    >
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
                  <g clipPath="url(#splat-clip-heatmap)">
                    <rect
                      x="-512"
                      y="-512"
                      width="1536"
                      height="1536"
                      fill="url(#rainbow-heatmap)"
                      style={{ animation: "rainbowSlide 4s linear infinite" }}
                    />
                  </g>
                </svg>
              </div>
              <h2
                style={{
                  margin: "0 0 6px",
                  fontSize: "20px",
                  fontWeight: 700,
                  color: "#1c1c1e",
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    background: "rgba(118,118,128,0.12)",
                    color: "#3c3c43",
                    fontSize: "13px",
                    fontWeight: 700,
                    padding: "2px 8px",
                    borderRadius: "6px",
                    verticalAlign: "middle",
                    letterSpacing: "0.3px",
                  }}
                >
                  Plus
                </span>
              </h2>
              <p
                style={{
                  margin: "0 0 20px",
                  fontSize: "14px",
                  color: "#8e8e93",
                  lineHeight: 1.5,
                }}
              >
                Exclusive tools, more ink, and rainbow color.
              </p>

              {/* Benefits — simple rows matching sidebar text style */}
              <div
                style={{
                  background: "rgba(118,118,128,0.08)",
                  borderRadius: "14px",
                  padding: "4px 0",
                  marginBottom: "20px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "11px 16px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                    }}
                  >
                    <div
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: "50%",
                        flexShrink: 0,
                        position: "relative",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          position: "absolute",
                          inset: -1,
                          borderRadius: "50%",
                          background: `conic-gradient(#ff3b30, #ff6a1e, #ff9500, #ffb300, #ffcc00, #9acd32, #34c759, #1aa3a3, #007aff, #2c68ea, #5856d6, #8454da, #af52de, #d946a8, #ff3b30), linear-gradient(135deg, #ff3b30, #ff9500, #ffcc00, #34c759, #007aff, #5856d6, #af52de, #ff3b30, #ff9500, #ffcc00, #34c759, #007aff, #5856d6, #af52de, #ff3b30)`,
                          backgroundSize: "100% 100%, 500% 500%",
                          backgroundBlendMode: "overlay",
                          animation: "rainbowFlow 6s ease infinite",
                          filter: "blur(0.5px)",
                        }}
                      />
                    </div>
                    <span
                      style={{
                        fontSize: "15px",
                        background:
                          "linear-gradient(135deg, #ff3b30, #ff9500, #ffcc00, #34c759, #007aff, #5856d6, #af52de, #ff3b30, #ff9500, #ffcc00, #34c759, #007aff, #5856d6, #af52de, #ff3b30)",
                        backgroundSize: "500% 500%",
                        WebkitBackgroundClip: "text",
                        WebkitTextFillColor: "transparent",
                        backgroundClip: "text",
                        animation: "rainbowTextFlow 6s ease infinite",
                      }}
                    >
                      Rainbow color
                    </span>
                  </div>
                </div>
                <div
                  style={{
                    height: "1px",
                    background: "rgba(60,60,67,0.1)",
                    marginLeft: "41px",
                  }}
                />
                {/* Crayon */}
                <div style={{ display: "flex", alignItems: "center", padding: "11px 11px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(118,118,128,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
                      <svg viewBox="36 0 66 390" width="18" height="50" xmlns="http://www.w3.org/2000/svg" style={{ marginTop: 28 }}>
                        <defs>
                          <mask id="plus-crayon-mask" style={{ maskType: 'alpha' } as any}>
                            <image href="/tools/crayon-tip.png" x="0" y="0" width="138" height="390" />
                          </mask>
                        </defs>
                        <image href="/tools/crayon-base.png" x="0" y="0" width="138" height="390" />
                        <rect x="0" y="0" width="138" height="390" fill="#FF9500" mask="url(#plus-crayon-mask)" />
                        <image href="/tools/crayon-tip-contour.png" x="0" y="0" width="138" height="390" />
                      </svg>
                    </div>
                    <span style={{ fontSize: "15px", color: "#1c1c1e" }}>Crayon</span>
                  </div>
                </div>
                <div style={{ height: "1px", background: "rgba(60,60,67,0.1)", marginLeft: "41px" }} />
                {/* Fountain Pen */}
                <div style={{ display: "flex", alignItems: "center", padding: "11px 11px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(118,118,128,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
                      <svg viewBox="36 0 66 318" width="18" height="42" xmlns="http://www.w3.org/2000/svg" style={{ marginTop: 18 }}>
                        <image href="/tools/fountainpen-base.png" x="0" y="0" width="138" height="318" />
                        <rect x="36" y="165" width="66" height="7" fill="#007AFF" />
                      </svg>
                    </div>
                    <span style={{ fontSize: "15px", color: "#1c1c1e" }}>Fountain Pen</span>
                  </div>
                </div>
                <div style={{ height: "1px", background: "rgba(60,60,67,0.1)", marginLeft: "41px" }} />
                {/* Watercolor */}
                <div style={{ display: "flex", alignItems: "center", padding: "11px 11px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(118,118,128,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
                      <svg viewBox="36 0 66 318" width="18" height="42" xmlns="http://www.w3.org/2000/svg" style={{ marginTop: 18 }}>
                        <defs>
                          <mask id="plus-watercolor-mask" style={{ maskType: 'alpha' } as any}>
                            <image href="/tools/watercolor-tip.png" x="0" y="0" width="138" height="318" />
                          </mask>
                        </defs>
                        <image href="/tools/watercolor-base.png" x="0" y="0" width="138" height="318" />
                        <rect x="0" y="0" width="138" height="318" fill="#34C759" mask="url(#plus-watercolor-mask)" />
                        <image href="/tools/watercolor-tip-contour.png" x="0" y="0" width="138" height="318" />
                      </svg>
                    </div>
                    <span style={{ fontSize: "15px", color: "#1c1c1e" }}>Watercolor</span>
                  </div>
                </div>
                <div style={{ height: "1px", background: "rgba(60,60,67,0.1)", marginLeft: "41px" }} />
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "11px 16px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                    }}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="#1c1c1e"
                      stroke="none"
                      width="15"
                      height="15"
                      style={{ flexShrink: 0 }}
                    >
                      <path d="M12 22C17 22 20 18 20 14C20 9 12 2 12 2C12 2 4 9 4 14C4 18 7 22 12 22Z" />
                    </svg>
                    <span style={{ fontSize: "15px", color: "#1c1c1e" }}>
                      10x Ink capacity
                    </span>
                  </div>
                  <span style={{ fontSize: "15px", fontWeight: 600 }}>
                    <span style={{ color: "#8e8e93" }}>150</span>{" "}
                    <span style={{ color: "#8e8e93" }}>→</span>{" "}
                    <span style={{ color: "#34c759" }}>1,500</span>
                  </span>
                </div>
                <div
                  style={{
                    height: "1px",
                    background: "rgba(60,60,67,0.1)",
                    marginLeft: "41px",
                  }}
                />
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "11px 16px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                    }}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="#1c1c1e"
                      stroke="#1c1c1e"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      width="15"
                      height="15"
                      style={{ flexShrink: 0 }}
                    >
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                    </svg>
                    <span style={{ fontSize: "15px", color: "#1c1c1e" }}>
                      10x Refill speed
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: "15px",
                      fontWeight: 600,
                      color: "#34c759",
                    }}
                  >
                    10x
                  </span>
                </div>
              </div>

              {/* Purchase button */}
              <button
                onClick={async () => {
                  if (!user) {
                    sessionStorage.setItem("intentToSubscribe", "true");
                    setIsPlusSheetClosing(true);
                    setTimeout(() => {
                      setShowPlusSheet(false);
                      setIsPlusSheetClosing(false);
                      setShowAuthModal(true);
                    }, 300);
                    return;
                  }
                  const url = await createCheckoutSession();
                  if (url) window.location.href = url;
                }}
                style={{
                  width: "100%",
                  padding: "14px",
                  background: "#007aff",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "14px",
                  fontWeight: 600,
                  fontSize: "16px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  transition: "transform 0.2s ease",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.transform = "scale(1.02)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.transform = "scale(1)")
                }
              >
                Unlock for $3.99
              </button>
              <div style={{ textAlign: "center", fontSize: "11px", color: "#8e8e93", marginTop: "8px" }}>
                One-time purchase. Supports development & moderation.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Account Sheet */}
      {(showAccountSheet || isAccountSheetClosing) &&
        (() => {
          const displayName =
            user?.user_metadata?.full_name ||
            user?.email?.split("@")[0] ||
            "Guest";
          const avatarLetter = displayName.charAt(0).toUpperCase();
          const avatarUrl = user?.user_metadata?.avatar_url;
          const closeAccountSheet = () => {
            setIsAccountSheetClosing(true);
            setTimeout(() => {
              setShowAccountSheet(false);
              setIsAccountSheetClosing(false);
            }, 300);
          };
          return (
            <div style={{ position: "fixed", inset: 0, zIndex: 60 }}>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: "rgba(0,0,0,0.4)",
                  animation: isAccountSheetClosing
                    ? "sidebarScrimOut 0.3s forwards"
                    : "sidebarScrimIn 0.3s forwards",
                }}
                onClick={closeAccountSheet}
              />
              <div
                className={`heatmap-sheet-dialog ${isAccountSheetClosing ? 'heatmap-sheet-leaving' : 'heatmap-sheet-entering'}`}
                style={{
                  position: "absolute",
                  bottom: 0,
                  left: 0,
                  right: 0,
                  maxWidth: "420px",
                  marginLeft: "auto",
                  marginRight: "auto",
                  borderRadius: "32px 32px 0 0",
                  background: "rgba(255,255,255,0.92)",
                  backdropFilter: "blur(20px)",
                  WebkitBackdropFilter: "blur(20px)",
                  boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
                  paddingBottom: "env(safe-area-inset-bottom, 0px)",
                  pointerEvents: 'auto',
                  animation: isAccountSheetClosing
                    ? "slideDownSheet 0.3s cubic-bezier(0.2,0.8,0.2,1) forwards"
                    : "slideUpSheet 0.35s cubic-bezier(0.2,0.8,0.2,1) forwards",
                }}
              >
                <div
                  className="heatmap-sheet-drag-handle"
                  style={{ position: "relative", touchAction: "none", cursor: "grab" }}
                  onPointerDown={(e) => {
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                    (e.currentTarget as any)._dragStartY = e.clientY;
                    const sheet = e.currentTarget.parentElement;
                    if (sheet) sheet.style.transition = 'none';
                  }}
                  onPointerMove={(e) => {
                    const startY = (e.currentTarget as any)._dragStartY;
                    if (startY == null) return;
                    const dy = e.clientY - startY;
                    if (dy > 0) {
                      const sheet = e.currentTarget.parentElement;
                      if (sheet) sheet.style.transform = `translateY(${dy}px)`;
                    }
                  }}
                  onPointerUp={(e) => {
                    const startY = (e.currentTarget as any)._dragStartY;
                    (e.currentTarget as any)._dragStartY = null;
                    const sheet = e.currentTarget.parentElement;
                    if (sheet) sheet.style.transition = '';
                    const dy = startY != null ? e.clientY - startY : 0;
                    if (dy > 60) {
                      closeAccountSheet();
                    } else if (sheet) {
                      sheet.style.transform = '';
                    }
                  }}
                >
                  <div
                    style={{
                      width: "36px",
                      height: "4px",
                      borderRadius: "2px",
                      background: "rgba(0,0,0,0.12)",
                      margin: "6px auto 0",
                    }}
                  />
                  <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={closeAccountSheet}
                    style={{
                      position: "absolute",
                      top: "8px",
                      right: "12px",
                      width: "28px",
                      height: "28px",
                      borderRadius: "50%",
                      background: "rgba(118,118,128,0.12)",
                      border: "none",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: 0,
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#8e8e93" strokeWidth="2" strokeLinecap="round">
                      <line x1="1" y1="1" x2="11" y2="11" />
                      <line x1="11" y1="1" x2="1" y2="11" />
                    </svg>
                  </button>
                </div>
                <div style={{ padding: "20px 24px 32px" }}>
                  {/* Profile header */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "14px",
                      marginBottom: "24px",
                    }}
                  >
                    <div
                      style={{
                        width: "56px",
                        height: "56px",
                        borderRadius: "50%",
                        background: "rgba(118,118,128,0.18)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "22px",
                        fontWeight: 700,
                        color: "#8e8e93",
                        flexShrink: 0,
                        overflow: "hidden",
                      }}
                    >
                      {avatarUrl ? (
                        <img
                          src={avatarUrl}
                          alt={avatarLetter}
                          style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "cover",
                          }}
                          onError={(e) => {
                            (
                              e.currentTarget as HTMLImageElement
                            ).style.display = "none";
                            e.currentTarget.parentElement!.textContent =
                              avatarLetter;
                          }}
                        />
                      ) : (
                        avatarLetter
                      )}
                    </div>
                    <div>
                      <div
                        style={{
                          fontSize: "18px",
                          fontWeight: 700,
                          color: "#1c1c1e",
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                        }}
                      >
                        {displayName}
                        {tier?.isPlus && (
                          <span
                            style={{
                              display: "inline-block",
                              background: "rgba(118,118,128,0.12)",
                              color: "#3c3c43",
                              fontSize: "11px",
                              fontWeight: 700,
                              padding: "1px 6px",
                              borderRadius: "5px",
                              letterSpacing: "0.3px",
                              lineHeight: "16px",
                            }}
                          >
                            Plus
                          </span>
                        )}
                      </div>
                      <div
                        style={{
                          fontSize: "14px",
                          color: "#8e8e93",
                          marginTop: "2px",
                        }}
                      >
                        {user?.email}
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "10px",
                    }}
                  >
                    {!tier?.isPlus && (
                      <button
                        onClick={() => {
                          closeAccountSheet();
                          setTimeout(() => setShowPlusSheet(true), 350);
                        }}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.transform = "scale(1.02)")
                        }
                        onMouseLeave={(e) =>
                          (e.currentTarget.style.transform = "scale(1)")
                        }
                        style={{
                          width: "100%",
                          padding: "14px",
                          background: "#ffffff",
                          color: "#1c1c1e",
                          border: "1px solid rgba(0,0,0,0.1)",
                          borderRadius: "100px",
                          fontWeight: 600,
                          fontSize: "16px",
                          cursor: "pointer",
                          fontFamily: "inherit",
                          boxShadow: "0 2px 8px rgba(0,0,0,0.05)",
                          transition: "transform 0.2s ease",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: "8px",
                        }}
                      >
                        Upgrade to Plus
                      </button>
                    )}
                    <button
                      onClick={() => {
                        closeAccountSheet();
                        setTimeout(() => {
                          supabase.auth.signOut();
                        }, 350);
                      }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.transform = "scale(1.02)")
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.transform = "scale(1)")
                      }
                      style={{
                        width: "100%",
                        padding: "14px",
                        background: "rgba(255,59,48,0.08)",
                        color: "#FF3B30",
                        border: "none",
                        borderRadius: "100px",
                        fontWeight: 600,
                        fontSize: "16px",
                        cursor: "pointer",
                        fontFamily: "inherit",
                        transition: "transform 0.2s ease",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "8px",
                      }}
                    >
                      Sign Out
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

      {/* Back to Map Button */}

      {/* Collapse Animation Overlay (returning from panorama) */}
      {collapseAnim && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: collapseAnim.active ? `${collapseAnim.thumbY}px` : "50%",
              left: collapseAnim.active ? `${collapseAnim.thumbX}px` : "50%",
              transform: "translate(-50%, -50%)",
              width: collapseAnim.active
                ? `${collapseAnim.markerSize}px`
                : "100%",
              height: collapseAnim.active
                ? `${collapseAnim.markerSize}px`
                : "100%",
              borderRadius: collapseAnim.active ? "50%" : "0",
              overflow: "hidden",
              transition:
                "width 0.6s cubic-bezier(0.25, 1, 0.5, 1), height 0.6s cubic-bezier(0.25, 1, 0.5, 1), border-radius 0.6s cubic-bezier(0.25, 1, 0.5, 1), border 0.6s cubic-bezier(0.25, 1, 0.5, 1)",
              border: collapseAnim.active
                ? `${Math.max(2, collapseAnim.markerSize * 0.03)}px solid white`
                : "none",
              boxSizing: "border-box",
              opacity: collapseAnim.opacity,
            }}
          >
            {collapseAnim.thumbUrl && (
              <img
                src={collapseAnim.thumbUrl}
                alt="Transition"
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
            )}
          </div>
        </div>
      )}
      {/* What's New Bottom Sheet */}
      {(showWhatsNew || isWhatsNewClosing) && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999 }}>
          <div
            style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)', animation: isWhatsNewClosing ? 'sidebarScrimOut 0.3s forwards' : 'sidebarScrimIn 0.3s forwards' }}
            onClick={() => {
              setIsWhatsNewClosing(true);
              localStorage.setItem('whatsNewSeen_v3', '1');
              setTimeout(() => { setShowWhatsNew(false); setIsWhatsNewClosing(false); }, 300);
            }}
          />
          <div
            className={`heatmap-sheet-dialog ${isWhatsNewClosing ? 'heatmap-sheet-leaving' : 'heatmap-sheet-entering'}`}
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
              animation: isWhatsNewClosing ? 'slideDownSheet 0.3s cubic-bezier(0.2,0.8,0.2,1) forwards' : 'slideUpSheet 0.35s cubic-bezier(0.2,0.8,0.2,1) forwards',
              fontFamily: "-apple-system, 'SF Pro Display', 'SF Pro Text', system-ui, sans-serif",
            }}>
            <div className="heatmap-sheet-drag-handle" style={{ width: '36px', height: '4px', borderRadius: '2px', background: 'rgba(0,0,0,0.12)', margin: '14px auto 0' }} />
            <div style={{ padding: '20px 24px 32px' }}>
              <h2 style={{ margin: '0 0 6px', fontSize: '20px', fontWeight: 700, color: '#1c1c1e' }}>What's New</h2>
              <p style={{ margin: '0 0 20px', fontSize: '14px', color: '#8e8e93', lineHeight: 1.5 }}>
                The beginning of a big discovery update.
              </p>
              <div style={{ background: 'rgba(118,118,128,0.08)', borderRadius: '14px', padding: '4px 0', marginBottom: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', gap: '10px' }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="#007aff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15" style={{ flexShrink: 0 }}>
                    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <span style={{ fontSize: '15px', color: '#1c1c1e' }}>New Discover tab with the best drawings</span>
                </div>
                <div style={{ height: '1px', background: 'rgba(60,60,67,0.1)', marginLeft: '41px' }} />
                <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', gap: '10px' }}>
                  <svg viewBox="0 0 24 24" fill="#007aff" stroke="none" width="15" height="15" style={{ flexShrink: 0 }}>
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                  <span style={{ fontSize: '15px', color: '#1c1c1e' }}>Star drawings to help them rise in Discover</span>
                </div>
              </div>
              <button
                onClick={() => {
                  setIsWhatsNewClosing(true);
                  localStorage.setItem('whatsNewSeen_v3', '1');
                  setTimeout(() => { setShowWhatsNew(false); setIsWhatsNewClosing(false); }, 300);
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
                Got it
              </button>
              <button
                onClick={() => {
                  setIsWhatsNewClosing(true);
                  localStorage.setItem('whatsNewSeen_v3', '1');
                  setTimeout(() => {
                    setShowWhatsNew(false);
                    setIsWhatsNewClosing(false);
                    setShowPlusSheet(true);
                  }, 300);
                }}
                style={{
                  width: '100%',
                  padding: '12px',
                  marginTop: '8px',
                  background: 'rgba(0,122,255,0.12)',
                  color: '#007aff',
                  border: 'none',
                  borderRadius: '14px',
                  fontWeight: 600,
                  fontSize: '15px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  transition: 'transform 0.2s ease',
                  position: 'relative',
                  overflow: 'hidden',
                  letterSpacing: '-0.2px',
                }}
                onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.02)'}
                onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
              >
                Unlock Plus
                <svg
                  width="80"
                  height="80"
                  viewBox="0 0 512 512"
                  xmlns="http://www.w3.org/2000/svg"
                  style={{
                    position: 'absolute',
                    bottom: -28,
                    right: -20,
                    pointerEvents: 'none',
                    overflow: 'hidden',
                  }}
                >
                  <defs>
                    <clipPath id="splat-clip-wn">
                      <path d="M438.024,210.133c0,7.488,6.08,13.551,13.551,13.551c7.488,0,13.569-6.063,13.569-13.551c0-7.479-6.081-13.552-13.569-13.552C444.104,196.581,438.024,202.654,438.024,210.133z" />
                      <path d="M400.097,376.503c-5.994,0-10.842,4.856-10.842,10.85c0,5.986,4.848,10.832,10.842,10.832c5.994,0,10.841-4.847,10.841-10.832C410.938,381.359,406.091,376.503,400.097,376.503z" />
                      <path d="M382.758,415.376c-12.284,0-22.238,9.956-22.238,22.238c0,12.274,9.955,22.229,22.238,22.229c12.283,0,22.238-9.955,22.238-22.229C404.997,425.332,395.041,415.376,382.758,415.376z" />
                      <circle cx="137.251" cy="426.904" r="16.8" />
                      <path d="M94.425,359.164c-4.778,0-8.669,3.874-8.669,8.678c0,4.778,3.892,8.66,8.669,8.66c4.796,0,8.67-3.883,8.67-8.66C103.094,363.038,99.22,359.164,94.425,359.164z" />
                      <path d="M54.865,151.063c6.29,0,11.38-5.1,11.38-11.389c0-6.281-5.09-11.38-11.38-11.38c-6.289,0-11.38,5.099-11.38,11.38C43.485,145.963,48.576,151.063,54.865,151.063z" />
                      <path d="M165.97,97.952c8.374,0,15.166-6.793,15.166-15.185c0-8.365-6.792-15.158-15.166-15.158s-15.168,6.794-15.168,15.158C150.802,91.158,157.596,97.952,165.97,97.952z" />
                      <path d="M450.775,300.632c-47.586-16.887-56.968-10.485-80.214-32.515c-5.56-5.255-5.438-22.49,25.47-18.425c15.497,2.042,26.008-6.506,26.008-18.702c0-8.131-9.799-19.433-24.393-13.821c-21.126,8.131-34.834-1.094-37.388-11.38c-3.25-13.004,0.434-27.832,54.814-54.996c66.646-33.332,28.423-93.983-23.924-36.859c-23.194,25.296-34.14,35.764-49.584,43.895c-13.864,7.288-30.49-0.27-17.895-17.069c4.882-6.507,13.17-11.527,15.445-19.511c3.249-11.38-6.324-21.952-14.628-21.952c-8.304,0-18.694,4.874-21.943,17.07c-4.882,22.359-17.322,21.24-23.194,14.785c-11.241-12.318-7.193-26.686-5.264-48.924c2.276-26.121,17.738-86.443-29.709-81.995c-22.88,2.146-29.639,23.715-22.238,62.267c9.208,47.856-4.725,81.257-19.597,88.007c-17.878,8.13-26.946,5.046-65.029-21.126c-20.24-13.926-42.584-1.703-47.152,14.628c-4.031,14.385,7.332,31.768,24.393,37.396c26.286,8.678,37.944,10.693,50.14,17.33c11.918,6.507,13.412,22.282,1.511,36.554c-11.918,14.282-42.705,2.468-88.224-0.782c-78.685-5.611-60.999,81.43,12.996,55.831c42.27-14.637,60.147-11.389,67.479-2.441c10.112,12.344,3.162,29.031-16.54,40.915c-62.858,37.944,7.61,85.078,33.618,32.515c10.876-21.961,23.385-28.71,35.756-23.846c10.094,3.979,23.02,39.204,8.409,86.72C206.885,466.473,207.771,512,238.33,512c28.563,0,33.028-42.539,28.164-88.875c-1.808-17.339-0.47-44.207,13.012-50.948c10.842-5.421,27.781-11.458,39.283,12.457c10.58,21.951,33.34,18.693,42.287,6.506c6.532-8.921,9.851-28.71-16.157-38.969c-30.995-12.249-19.615-45.58,3.961-42.323c26.026,3.588,43.868,13.17,74.794,39.569C466.829,386.233,522.234,325.989,450.775,300.632z" />
                    </clipPath>
                    <linearGradient id="rainbow-wn" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
                      <stop offset="0%" stopColor="#E040FB" />
                      <stop offset="33%" stopColor="#536DFE" />
                      <stop offset="66%" stopColor="#00BCD4" />
                      <stop offset="100%" stopColor="#76FF03" />
                    </linearGradient>
                  </defs>
                  <g clipPath="url(#splat-clip-wn)">
                    <rect x="0" y="0" width="512" height="512" fill="url(#rainbow-wn)" />
                  </g>
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Heatmap;
