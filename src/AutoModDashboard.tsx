import { useEffect, useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "./supabaseClient";
import locationsData from "./data/locations.json";

const ADMIN_EMAIL = "markotsymbaluk@gmail.com";
const PAGE_SIZE = 50;

interface ModerationScan {
  id: string;
  image_id: string;
  device_id: string;
  scanned_at: string;
  latest_stroke_at: string;
  flagged: boolean;
  flag_reason: string | null;
  composite_url: string | null;
  result: {
    flagged?: boolean;
    reasons?: string[];
  } | null;
}

const locationLookup = new Map<
  string,
  { city: string; lat: number; lng: number }
>();
for (const loc of locationsData.locations) {
  locationLookup.set(loc.id, { city: loc.city, lat: loc.lat, lng: loc.lng });
}

function ScanCard({
  scan,
  onUnhide,
  onDelete,
  hiding,
}: {
  scan: ModerationScan;
  onUnhide: (scan: ModerationScan) => void;
  onDelete: (scan: ModerationScan) => void;
  hiding: boolean;
}) {
  const loc = locationLookup.get(scan.image_id);
  const city = loc?.city || "Unknown";
  const reasons = scan.result?.reasons || [];

  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 14,
        overflow: "hidden",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        opacity: hiding ? 0.3 : 1,
        transition: "opacity 0.2s",
        border: scan.flagged
          ? "2px solid #ff3b30"
          : "2px solid transparent",
      }}
    >
      {/* Composite image */}
      <div
        style={{
          background: "#d1d1d6",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 120,
          position: "relative",
        }}
      >
        {scan.composite_url ? (
          <img
            src={scan.composite_url}
            alt="composite"
            style={{ width: "100%", display: "block" }}
            loading="lazy"
          />
        ) : (
          <span style={{ color: "#8e8e93", fontSize: 11, padding: 30 }}>
            No composite
          </span>
        )}
        {scan.flagged && (
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
            FLAGGED
          </div>
        )}
      </div>

      {/* Info */}
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
            <div style={{ fontSize: 10, color: "#8e8e93" }}>
              {new Date(scan.scanned_at).toLocaleDateString()}{" "}
              {new Date(scan.scanned_at).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>
          </div>
          <button
            onClick={() => {
              const url = loc
                ? `/view?imageId=${scan.image_id}&lat=${loc.lat}&lng=${loc.lng}`
                : `/view?imageId=${scan.image_id}`;
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

        {/* Reasons */}
        {reasons.length > 0 && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 3,
              marginBottom: 6,
            }}
          >
            {reasons.map((reason, i) => (
              <div
                key={i}
                style={{
                  fontSize: 11,
                  color: scan.flagged ? "#ff3b30" : "#3c3c43",
                  fontWeight: scan.flagged ? 600 : 400,
                  background: scan.flagged ? "#ff3b3010" : "rgba(0,0,0,0.03)",
                  borderRadius: 6,
                  padding: "3px 6px",
                  wordBreak: "break-word",
                }}
              >
                {reason}
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 6 }}>
          {scan.flagged && (
            <button
              onClick={() => onUnhide(scan)}
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
            onClick={() => onDelete(scan)}
            style={{
              flex: 1,
              background: scan.flagged ? "#ff3b30" : "#ff3b3012",
              color: scan.flagged ? "#fff" : "#ff3b30",
              border: "none",
              borderRadius: 8,
              padding: "6px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Dashboard ───────────────────────────────────────────

export default function AutoModDashboard() {
  const navigate = useNavigate();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [scans, setScans] = useState<ModerationScan[]>([]);
  const [loading, setLoading] = useState(true);
  const [hidingIds, setHidingIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<"all" | "flagged" | "clean">("all");
  const [sortBy, setSortBy] = useState<"recent" | "flagged_first">(
    "flagged_first"
  );
  const [hasMore, setHasMore] = useState(true);
  const [runningBatch, setRunningBatch] = useState(false);
  const [batchResult, setBatchResult] = useState<string | null>(null);

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

  const loadScans = useCallback(
    async (offset = 0) => {
      setLoading(true);
      let query = supabase
        .from("moderation_scans")
        .select("*")
        .order("scanned_at", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);

      if (filter === "flagged") query = query.eq("flagged", true);
      if (filter === "clean") query = query.eq("flagged", false);

      const { data, error } = await query;
      if (error) {
        console.error("Failed to load scans:", error);
        setLoading(false);
        return;
      }

      if (data.length < PAGE_SIZE) setHasMore(false);
      else setHasMore(true);
      setScans((prev) => (offset === 0 ? data : [...prev, ...data]));
      setLoading(false);
    },
    [filter]
  );

  useEffect(() => {
    if (isAdmin) {
      setScans([]);
      setHasMore(true);
      loadScans(0);
    }
  }, [isAdmin, loadScans]);

  const sorted = useMemo(() => {
    const arr = [...scans];
    if (sortBy === "flagged_first") {
      arr.sort((a, b) => {
        if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
        return (
          new Date(b.scanned_at).getTime() - new Date(a.scanned_at).getTime()
        );
      });
    }
    return arr;
  }, [scans, sortBy]);

  const unhideDrawing = useCallback(async (scan: ModerationScan) => {
    setHidingIds((prev) => new Set(prev).add(scan.id));
    await supabase
      .from("strokes")
      .update({ hidden_at: null })
      .eq("image_id", scan.image_id)
      .eq("device_id", scan.device_id);
    await supabase
      .from("moderation_scans")
      .update({ flagged: false, flag_reason: null })
      .eq("id", scan.id);
    setScans((prev) =>
      prev.map((s) =>
        s.id === scan.id ? { ...s, flagged: false, flag_reason: null } : s
      )
    );
    setHidingIds((prev) => {
      const next = new Set(prev);
      next.delete(scan.id);
      return next;
    });
  }, []);

  const deleteDrawing = useCallback(async (scan: ModerationScan) => {
    setHidingIds((prev) => new Set(prev).add(scan.id));

    // Delete all strokes for this device+image
    const { data: strokeIds } = await supabase
      .from("strokes")
      .select("id")
      .eq("image_id", scan.image_id)
      .eq("device_id", scan.device_id);

    if (strokeIds) {
      for (const s of strokeIds) {
        await supabase.from("reports").delete().eq("stroke_id", s.id);
      }
      const ids = strokeIds.map((s) => s.id);
      await supabase.from("strokes").delete().in("id", ids);
    }

    // Delete the moderation scan record
    await supabase.from("moderation_scans").delete().eq("id", scan.id);

    // Remove from local state
    setScans((prev) => prev.filter((s) => s.id !== scan.id));
    setHidingIds((prev) => {
      const next = new Set(prev);
      next.delete(scan.id);
      return next;
    });
  }, []);

  const runBatch = useCallback(async () => {
    setRunningBatch(true);
    setBatchResult(null);
    let totalScanned = 0;
    let totalFlagged = 0;
    let totalErrors = 0;
    const BATCH_SIZE = 10;
    const MAX_TOTAL = 50;

    try {
      // Process in batches of 10, up to 50 per click
      while (totalScanned < MAX_TOTAL) {
        setBatchResult(`Scanning... ${totalScanned} done so far`);
        const resp = await fetch(
          `https://example.supabase.co/functions/v1/moderate-drawings?limit=${BATCH_SIZE}`
        );
        const data = await resp.json();
        const scannedCount = data.scanned ?? data.results?.length ?? 0;
        if (scannedCount === 0) break;

        totalScanned += scannedCount;
        totalFlagged += data.results?.filter(
          (r: { flagged: boolean }) => r.flagged
        ).length ?? 0;
        totalErrors += data.results?.filter(
          (r: { error?: string }) => r.error
        ).length ?? 0;

        // If we got fewer than BATCH_SIZE, there are no more
        if (scannedCount < BATCH_SIZE) break;
      }

      let msg = `Scanned ${totalScanned} drawings. ${totalFlagged} flagged.`;
      if (totalErrors > 0) msg += ` ${totalErrors} errors.`;
      if (totalScanned === 0) msg = "No new drawings to scan.";
      setBatchResult(msg);
      setScans([]);
      setHasMore(true);
      loadScans(0);
    } catch (err) {
      setBatchResult(`Error after ${totalScanned} scanned: ${err}`);
    }
    setRunningBatch(false);
  }, [loadScans]);

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

  const totalScanned = scans.length;
  const totalFlagged = scans.filter((s) => s.flagged).length;

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => navigate("/")} style={styles.headerBackBtn}>
            ← Back
          </button>
          <h1 style={styles.title}>Auto-Moderation</h1>
        </div>
        <div style={styles.stats}>
          <span style={styles.statBadge}>{totalScanned} scanned</span>
          {totalFlagged > 0 && (
            <span
              style={{
                ...styles.statBadge,
                background: "#ff3b3022",
                color: "#ff3b30",
              }}
            >
              {totalFlagged} flagged
            </span>
          )}
        </div>
      </div>

      {/* Controls */}
      <div style={styles.controls}>
        <select
          value={filter}
          onChange={(e) =>
            setFilter(e.target.value as "all" | "flagged" | "clean")
          }
          style={styles.select}
        >
          <option value="all">All scans</option>
          <option value="flagged">Flagged only</option>
          <option value="clean">Clean only</option>
        </select>
        <select
          value={sortBy}
          onChange={(e) =>
            setSortBy(e.target.value as "recent" | "flagged_first")
          }
          style={styles.select}
        >
          <option value="flagged_first">Flagged first</option>
          <option value="recent">Most recent</option>
        </select>

        <button
          onClick={() => runBatch()}
          disabled={runningBatch}
          style={{
            ...styles.batchBtn,
            marginLeft: "auto",
            background: runningBatch ? "rgba(0,0,0,0.05)" : "#007aff",
            color: runningBatch ? "#8e8e93" : "#fff",
          }}
        >
          {runningBatch ? "Scanning..." : "Scan new drawings"}
        </button>
      </div>

      {batchResult && (
        <div
          style={{
            padding: "8px 20px",
            fontSize: 13,
            color: "#3c3c43",
            background: "#007aff0a",
            borderBottom: "1px solid rgba(0,0,0,0.05)",
          }}
        >
          {batchResult}
        </div>
      )}

      {/* Grid */}
      <div style={styles.grid}>
        {sorted.map((scan) => (
          <ScanCard
            key={scan.id}
            scan={scan}
            onUnhide={unhideDrawing}
            onDelete={deleteDrawing}
            hiding={hidingIds.has(scan.id)}
          />
        ))}
      </div>

      {hasMore && !loading && (
        <div style={{ padding: "12px 20px 40px", textAlign: "center" }}>
          <button
            onClick={() => loadScans(scans.length)}
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
      {!loading && scans.length === 0 && (
        <p style={{ textAlign: "center", color: "#8e8e93", padding: 40 }}>
          No scans yet. Run a batch to get started.
        </p>
      )}
    </div>
  );
}

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
  batchBtn: {
    border: "none",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
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
