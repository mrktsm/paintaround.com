import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "./supabaseClient";
import locationsData from "./data/locations.json";

const ADMIN_EMAIL = "markotsymbaluk@gmail.com";
const PAGE_SIZE = 500;
const COMPOSITE_SIZE = 400;

interface Stroke {
  id: string;
  image_id: string;
  canvas_data: string | null;
  device_id: string;
  created_at: string;
  tool_type: string;
  color: string;
  grid_basic: [number, number][][] | null;
}

const locationLookup = new Map<
  string,
  { city: string; lat: number; lng: number }
>();
for (const loc of locationsData.locations) {
  locationLookup.set(loc.id, { city: loc.city, lat: loc.lat, lng: loc.lng });
}

// ── Composite Card ───────────────────────────────────────────

function CompositeCard({
  imageId,
  strokes,
  reportCount,
  onDelete,
  onRestore,
  deleting,
  showRestore,
  reasonText,
}: {
  imageId: string;
  strokes: Stroke[];
  reportCount: number;
  onDelete: (ids: string[]) => void;
  onRestore?: (ids: string[]) => void;
  deleting: boolean;
  showRestore?: boolean;
  reasonText?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const loc = locationLookup.get(imageId);
  const city = loc?.city || "Unknown";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let cancelled = false;

    (async () => {
      const items: {
        img: HTMLImageElement;
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
      }[] = [];

      await Promise.all(
        strokes.map(async (s) => {
          if (!s.canvas_data || !s.grid_basic) return;
          try {
            const img = new Image();
            img.crossOrigin = "anonymous";
            await new Promise<void>((resolve, reject) => {
              img.onload = () => resolve();
              img.onerror = () => reject();
              img.src = s.canvas_data!;
            });

            let minX = Infinity,
              minY = Infinity,
              maxX = -Infinity,
              maxY = -Infinity;
            for (const row of s.grid_basic!) {
              for (const [x, y] of row) {
                if (x === 0 && y === 0) continue;
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
              }
            }
            if (minX < maxX && minY < maxY) {
              items.push({ img, minX, minY, maxX, maxY });
            }
          } catch {
            // skip
          }
        })
      );

      if (cancelled || items.length === 0) return;

      let gMinX = Infinity,
        gMinY = Infinity,
        gMaxX = -Infinity,
        gMaxY = -Infinity;
      for (const it of items) {
        if (it.minX < gMinX) gMinX = it.minX;
        if (it.minY < gMinY) gMinY = it.minY;
        if (it.maxX > gMaxX) gMaxX = it.maxX;
        if (it.maxY > gMaxY) gMaxY = it.maxY;
      }

      const bw = gMaxX - gMinX;
      const bh = gMaxY - gMinY;
      if (bw <= 0 || bh <= 0) return;

      const pad = Math.max(bw, bh) * 0.05;
      const padMinX = gMinX - pad;
      const padMinY = gMinY - pad;
      const padW = bw + pad * 2;
      const padH = bh + pad * 2;

      const aspect = padW / padH;
      let cw: number, ch: number;
      if (aspect >= 1) {
        cw = COMPOSITE_SIZE;
        ch = COMPOSITE_SIZE / aspect;
      } else {
        ch = COMPOSITE_SIZE;
        cw = COMPOSITE_SIZE * aspect;
      }
      canvas.width = cw;
      canvas.height = ch;
      ctx.clearRect(0, 0, cw, ch);

      for (const { img, minX, minY, maxX, maxY } of items) {
        const dx = ((minX - padMinX) / padW) * cw;
        const dy = ((minY - padMinY) / padH) * ch;
        const dw = ((maxX - minX) / padW) * cw;
        const dh = ((maxY - minY) / padH) * ch;
        ctx.drawImage(img, dx, dy, dw, dh);
      }

      setReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [strokes]);

  const ids = strokes.map((s) => s.id);

  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 14,
        overflow: "hidden",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        opacity: deleting ? 0.3 : 1,
        transition: "opacity 0.2s",
        border: reportCount > 0 ? "2px solid #ff3b30" : "2px solid transparent",
      }}
    >
      {/* Composite image */}
      <div
        style={{
          background: "#d1d1d6",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 100,
          position: "relative",
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            maxWidth: "100%",
            display: ready ? "block" : "none",
          }}
        />
        {!ready && (
          <span style={{ color: "#8e8e93", fontSize: 11, padding: 30 }}>
            ...
          </span>
        )}
        {reportCount > 0 && (
          <div
            style={{
              position: "absolute",
              top: 6,
              right: 6,
              background: "#ff3b30",
              color: "#fff",
              fontSize: 10,
              fontWeight: 700,
              borderRadius: 4,
              padding: "2px 6px",
            }}
          >
            {reportCount} report{reportCount !== 1 ? "s" : ""}
          </div>
        )}
      </div>

      {/* Info + actions */}
      <div style={{ padding: "8px 10px 10px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 6,
            marginBottom: 6,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "#1c1c1e",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {city}
            </div>
            <div style={{ fontSize: 11, color: "#8e8e93" }}>
              {strokes.length} stroke{strokes.length !== 1 ? "s" : ""}
            </div>
          </div>
          <button
            onClick={() => {
              const url = loc
                ? `/view?imageId=${imageId}&lat=${loc.lat}&lng=${loc.lng}`
                : `/view?imageId=${imageId}`;
              window.open(url, "_blank");
            }}
            style={{
              background: "rgba(0,0,0,0.05)",
              border: "none",
              borderRadius: 6,
              padding: "4px 8px",
              fontSize: 11,
              fontWeight: 500,
              color: "#3c3c43",
              cursor: "pointer",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            View
          </button>
        </div>
        {reasonText && (
          <div
            style={{
              fontSize: 11,
              color: "#ff3b30",
              fontWeight: 600,
              background: "#ff3b3010",
              borderRadius: 6,
              padding: "3px 6px",
              marginBottom: 6,
              wordBreak: "break-word",
            }}
          >
            {reasonText}
          </div>
        )}
        <div style={{ display: "flex", gap: 6 }}>
          {showRestore && onRestore && (
            <button
              onClick={() => onRestore(ids)}
              style={{
                flex: 1,
                background: "#34c75918",
                color: "#34c759",
                border: "none",
                borderRadius: 8,
                padding: "6px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Restore
            </button>
          )}
          <button
            onClick={() => onDelete(ids)}
            style={{
              flex: 1,
              background: showRestore ? "#ff3b30" : "#ff3b3012",
              color: showRestore ? "#fff" : "#ff3b30",
              border: "none",
              borderRadius: 8,
              padding: "6px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Delete{showRestore ? "" : " all"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Dashboard ───────────────────────────────────────────

export default function ModerationDashboard() {
  const navigate = useNavigate();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [reportCounts, setReportCounts] = useState<Map<string, number>>(
    new Map()
  );
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [deletingGroups, setDeletingGroups] = useState<Set<string>>(new Set());
  const [filterCity, setFilterCity] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"recent" | "reports">("recent");
  const [tab, setTab] = useState<"active" | "ai_removed">("active");
  const [hiddenStrokes, setHiddenStrokes] = useState<Stroke[]>([]);
  const [hiddenLoading, setHiddenLoading] = useState(false);
  const [hiddenHasMore, setHiddenHasMore] = useState(true);
  const [flagReasons, setFlagReasons] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setIsAdmin(data.session?.user?.email === ADMIN_EMAIL);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setIsAdmin(session?.user?.email === ADMIN_EMAIL);
    });
    return () => subscription.unsubscribe();
  }, []);

  const loadStrokes = useCallback(async (offset = 0) => {
    setLoading(true);
    const { data, error } = await supabase
      .from("strokes")
      .select(
        "id, image_id, canvas_data, device_id, created_at, tool_type, color, grid_basic"
      )
      .is("hidden_at", null)
      .order("created_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      console.error("Failed to load strokes:", error);
      setLoading(false);
      return;
    }

    if (data.length < PAGE_SIZE) setHasMore(false);
    setStrokes((prev) => (offset === 0 ? data : [...prev, ...data]));
    setLoading(false);
  }, []);

  const loadHiddenStrokes = useCallback(async (offset = 0) => {
    setHiddenLoading(true);
    const { data, error } = await supabase
      .from("strokes")
      .select(
        "id, image_id, canvas_data, device_id, created_at, tool_type, color, grid_basic"
      )
      .not("hidden_at", "is", null)
      .order("hidden_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      console.error("Failed to load hidden strokes:", error);
      setHiddenLoading(false);
      return;
    }

    if (data.length < PAGE_SIZE) setHiddenHasMore(false);
    setHiddenStrokes((prev) => (offset === 0 ? data : [...prev, ...data]));

    // Load flag reasons from moderation_scans
    const imageDevicePairs = new Set(data.map((s) => `${s.image_id}|${s.device_id}`));
    const imageIds = [...new Set(data.map((s) => s.image_id))];
    if (imageIds.length > 0) {
      const { data: scans } = await supabase
        .from("moderation_scans")
        .select("image_id, device_id, flag_reason")
        .in("image_id", imageIds)
        .eq("flagged", true);
      if (scans) {
        setFlagReasons((prev) => {
          const next = new Map(prev);
          for (const s of scans) {
            const key = `${s.image_id}|${s.device_id}`;
            if (imageDevicePairs.has(key) && s.flag_reason) {
              next.set(key, s.flag_reason);
            }
          }
          return next;
        });
      }
    }

    setHiddenLoading(false);
  }, []);

  const loadReports = useCallback(async () => {
    const { data, error } = await supabase.from("reports").select("stroke_id");
    if (error || !data) return;
    const counts = new Map<string, number>();
    for (const r of data) {
      counts.set(r.stroke_id, (counts.get(r.stroke_id) || 0) + 1);
    }
    setReportCounts(counts);
  }, []);

  useEffect(() => {
    if (isAdmin) {
      loadStrokes(0);
      loadReports();
    }
  }, [isAdmin, loadStrokes, loadReports]);

  useEffect(() => {
    if (isAdmin && tab === "ai_removed") {
      setHiddenStrokes([]);
      setHiddenHasMore(true);
      loadHiddenStrokes(0);
    }
  }, [isAdmin, tab, loadHiddenStrokes]);

  const grouped = useMemo(() => {
    let filtered = strokes;
    if (filterCity !== "all") {
      filtered = strokes.filter((s) => {
        const loc = locationLookup.get(s.image_id);
        return loc?.city === filterCity;
      });
    }

    const groups = new Map<string, Stroke[]>();
    for (const s of filtered) {
      const arr = groups.get(s.image_id) || [];
      arr.push(s);
      groups.set(s.image_id, arr);
    }

    const entries = [...groups.entries()];
    if (sortBy === "reports") {
      entries.sort((a, b) => {
        const aR = a[1].reduce(
          (sum, s) => sum + (reportCounts.get(s.id) || 0),
          0
        );
        const bR = b[1].reduce(
          (sum, s) => sum + (reportCounts.get(s.id) || 0),
          0
        );
        return bR - aR;
      });
    } else {
      entries.sort((a, b) => {
        const aD = a[1][0]?.created_at || "";
        const bD = b[1][0]?.created_at || "";
        return bD.localeCompare(aD);
      });
    }

    return entries;
  }, [strokes, filterCity, sortBy, reportCounts]);

  const hiddenGrouped = useMemo(() => {
    let filtered = hiddenStrokes;
    if (filterCity !== "all") {
      filtered = hiddenStrokes.filter((s) => {
        const loc = locationLookup.get(s.image_id);
        return loc?.city === filterCity;
      });
    }

    // Group by image_id + device_id (same as moderation unit)
    const groups = new Map<string, Stroke[]>();
    for (const s of filtered) {
      const key = `${s.image_id}|${s.device_id}`;
      const arr = groups.get(key) || [];
      arr.push(s);
      groups.set(key, arr);
    }

    return [...groups.entries()].sort((a, b) => {
      const aD = a[1][0]?.created_at || "";
      const bD = b[1][0]?.created_at || "";
      return bD.localeCompare(aD);
    });
  }, [hiddenStrokes, filterCity]);

  const citiesWithStrokes = useMemo(() => {
    const cities = new Set<string>();
    for (const s of strokes) {
      const loc = locationLookup.get(s.image_id);
      if (loc) cities.add(loc.city);
    }
    return [...cities].sort();
  }, [strokes]);

  const deleteStrokes = useCallback(async (ids: string[]) => {
    setDeletingGroups((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    for (const id of ids) {
      await supabase.from("reports").delete().eq("stroke_id", id);
      await supabase.from("strokes").delete().eq("id", id);
    }
    setStrokes((prev) => prev.filter((s) => !ids.includes(s.id)));
    setHiddenStrokes((prev) => prev.filter((s) => !ids.includes(s.id)));
    setDeletingGroups((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const restoreStrokes = useCallback(async (ids: string[]) => {
    setDeletingGroups((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    await supabase
      .from("strokes")
      .update({ hidden_at: null })
      .in("id", ids);
    setHiddenStrokes((prev) => prev.filter((s) => !ids.includes(s.id)));
    setDeletingGroups((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  if (isAdmin === null) {
    return (
      <div style={styles.center}>
        <p style={{ color: "#8e8e93" }}>Checking access...</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div style={styles.center}>
        <p style={{ color: "#ff3b30", fontSize: 18, fontWeight: 600 }}>
          Access denied
        </p>
        <button onClick={() => navigate("/")} style={styles.backBtn}>
          Go Home
        </button>
      </div>
    );
  }

  const totalReported = [...reportCounts.values()].reduce((a, b) => a + b, 0);

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => navigate("/")} style={styles.headerBackBtn}>
            ← Back
          </button>
          <h1 style={styles.title}>Moderation</h1>
        </div>
        <div style={styles.stats}>
          <span style={styles.statBadge}>{strokes.length} strokes</span>
          <span style={styles.statBadge}>{grouped.length} locations</span>
          {totalReported > 0 && (
            <span
              style={{
                ...styles.statBadge,
                background: "#ff3b3022",
                color: "#ff3b30",
              }}
            >
              {totalReported} reports
            </span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={styles.tabs}>
        <button
          onClick={() => setTab("active")}
          style={{
            ...styles.tab,
            ...(tab === "active" ? styles.tabActive : {}),
          }}
        >
          Active
        </button>
        <button
          onClick={() => setTab("ai_removed")}
          style={{
            ...styles.tab,
            ...(tab === "ai_removed" ? styles.tabActive : {}),
          }}
        >
          AI Removed
        </button>
      </div>

      {/* Controls */}
      <div style={styles.controls}>
        <select
          value={filterCity}
          onChange={(e) => setFilterCity(e.target.value)}
          style={styles.select}
        >
          <option value="all">All cities ({citiesWithStrokes.length})</option>
          {citiesWithStrokes.map((city) => (
            <option key={city} value={city}>
              {city}
            </option>
          ))}
        </select>
        {tab === "active" && (
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as "recent" | "reports")}
            style={styles.select}
          >
            <option value="recent">Most recent</option>
            <option value="reports">Most reported</option>
          </select>
        )}
      </div>

      {tab === "active" ? (
        <>
          {/* Grid of active composites */}
          <div style={styles.grid}>
            {grouped.map(([imageId, groupStrokes]) => {
              const groupReports = groupStrokes.reduce(
                (sum, s) => sum + (reportCounts.get(s.id) || 0),
                0
              );
              const isDeleting = groupStrokes.some((s) =>
                deletingGroups.has(s.id)
              );

              return (
                <CompositeCard
                  key={imageId}
                  imageId={imageId}
                  strokes={groupStrokes}
                  reportCount={groupReports}
                  onDelete={deleteStrokes}
                  deleting={isDeleting}
                />
              );
            })}
          </div>

          {hasMore && !loading && (
            <div style={{ padding: "12px 20px 40px", textAlign: "center" }}>
              <button
                onClick={() => loadStrokes(strokes.length)}
                style={styles.loadMoreBtn}
              >
                Load more
              </button>
            </div>
          )}
          {loading && (
            <p style={{ textAlign: "center", color: "#8e8e93", padding: 20 }}>
              Loading...
            </p>
          )}
          {!loading && strokes.length === 0 && (
            <p style={{ textAlign: "center", color: "#8e8e93", padding: 40 }}>
              No strokes found
            </p>
          )}
        </>
      ) : (
        <>
          {/* Grid of AI-removed composites */}
          <div style={styles.grid}>
            {hiddenGrouped.map(([key, groupStrokes]) => {
              const imageId = groupStrokes[0].image_id;
              const deviceId = groupStrokes[0].device_id;
              const reason = flagReasons.get(`${imageId}|${deviceId}`);
              const isDeleting = groupStrokes.some((s) =>
                deletingGroups.has(s.id)
              );

              return (
                <CompositeCard
                  key={key}
                  imageId={imageId}
                  strokes={groupStrokes}
                  reportCount={0}
                  onDelete={deleteStrokes}
                  onRestore={restoreStrokes}
                  deleting={isDeleting}
                  showRestore
                  reasonText={reason}
                />
              );
            })}
          </div>

          {hiddenHasMore && !hiddenLoading && (
            <div style={{ padding: "12px 20px 40px", textAlign: "center" }}>
              <button
                onClick={() => loadHiddenStrokes(hiddenStrokes.length)}
                style={styles.loadMoreBtn}
              >
                Load more
              </button>
            </div>
          )}
          {hiddenLoading && (
            <p style={{ textAlign: "center", color: "#8e8e93", padding: 20 }}>
              Loading...
            </p>
          )}
          {!hiddenLoading && hiddenStrokes.length === 0 && (
            <p style={{ textAlign: "center", color: "#8e8e93", padding: 40 }}>
              No AI-removed drawings yet
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  page: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "#f5f5f7",
    fontFamily:
      "'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    overflowY: "auto",
    WebkitOverflowScrolling: "touch",
  },
  center: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100vh",
    gap: 16,
    fontFamily:
      "'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  },
  header: {
    position: "sticky",
    top: 0,
    zIndex: 10,
    background: "rgba(245,245,247,0.85)",
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    padding: "16px 20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: "1px solid rgba(0,0,0,0.08)",
    flexWrap: "wrap",
    gap: 12,
  },
  title: { fontSize: 20, fontWeight: 700, color: "#1c1c1e", margin: 0 },
  headerBackBtn: {
    background: "rgba(0,0,0,0.05)",
    border: "none",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 13,
    fontWeight: 500,
    color: "#3c3c43",
    cursor: "pointer",
  },
  backBtn: {
    background: "#1c1c1e",
    color: "#fff",
    border: "none",
    borderRadius: 12,
    padding: "10px 20px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  stats: { display: "flex", gap: 8, flexWrap: "wrap" },
  statBadge: {
    background: "rgba(0,0,0,0.05)",
    borderRadius: 8,
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    color: "#3c3c43",
  },
  tabs: {
    display: "flex",
    gap: 0,
    padding: "0 20px",
    borderBottom: "1px solid rgba(0,0,0,0.08)",
  },
  tab: {
    background: "none",
    border: "none",
    borderBottom: "2px solid transparent",
    padding: "10px 16px",
    fontSize: 13,
    fontWeight: 600,
    color: "#8e8e93",
    cursor: "pointer",
  },
  tabActive: {
    color: "#007aff",
    borderBottomColor: "#007aff",
  },
  controls: {
    padding: "12px 20px",
    display: "flex",
    gap: 10,
    alignItems: "center",
    flexWrap: "wrap",
    borderBottom: "1px solid rgba(0,0,0,0.05)",
  },
  select: {
    background: "#fff",
    border: "1px solid rgba(0,0,0,0.1)",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 13,
    color: "#1c1c1e",
    cursor: "pointer",
    outline: "none",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: 12,
    padding: "16px 20px",
    maxWidth: 1400,
    margin: "0 auto",
  },
  loadMoreBtn: {
    display: "inline-block",
    background: "#1c1c1e",
    color: "#fff",
    border: "none",
    borderRadius: 12,
    padding: "10px 24px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
};
