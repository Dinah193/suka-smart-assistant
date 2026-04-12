// src/pages/storehouse/storehouse.jsx
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
} from "react";

import { automation } from "@/services/automation/runtime";
import { useVision } from "@/context/VisionContext";
import RealtimeCoordinationPanel from "@/components/home/RealtimeCoordinationPanel";
import { emitCanonicalSignal } from "@/services/realtime/canonicalSignalEmitter";
import AutomationPanel from "@/ui/AutomationPanel";
import {
  Avatar as SacredAvatar,
  Button as SacredButton,
  Card as SacredCard,
  DashboardGrid,
  FeedPost,
  Notification,
} from "@/components/sacred";
import {
  recordProductActionClick,
  recordProductActionImpression,
} from "@/services/telemetry/productActionTelemetry";
import {
  areAgendaFiltersEqual,
  normalizeAppliedAgendaFilters,
} from "@/utils/householdAgendaControls";
import { buildHouseholdTodayUpcomingQuery } from "@/utils/householdAgendaQueryParams";
import { fetchStorehousePlannerData } from "@/pages/storehouse/planner/InventoryEstimatorService";
import LoadingBoundary from "@/components/common/LoadingBoundary";

/* ────────────────────────────────────────────────────────────────────────────
  Safe imports & helpers (avoid hard crashes if a module isn't present)
──────────────────────────────────────────────────────────────────────────── */
async function safeImport(path) {
  try {
    return await import(/* @vite-ignore */ path);
  } catch {
    return null;
  }
}
async function safeCall(modPromise, fn, args) {
  try {
    const mod = await modPromise;
    const api = mod?.default || mod;
    const op = api?.[fn];
    if (typeof op !== "function") return null;
    return await op(...(Array.isArray(args) ? args : [args]));
  } catch {
    return null;
  }
}
function useDebouncedCallback(fn, delay = 800) {
  const t = useRef(null);
  return useCallback(
    (...args) => {
      if (t.current) clearTimeout(t.current);
      t.current = setTimeout(() => fn(...args), delay);
    },
    [fn, delay]
  );
}
function JsonBlock({ data }) {
  if (!data) return null;
  return (
    <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function resolveStorehouseHouseholdId() {
  if (typeof window === "undefined") return "default-household";
  const fromGlobal =
    window.__suka?.profile?.householdId ||
    window.__suka?.profile?.homeId ||
    window.__suka?.householdId ||
    window.__suka?.homeId;
  if (fromGlobal) return String(fromGlobal);

  try {
    const raw = window.localStorage?.getItem("suka.profile");
    const parsed = raw ? JSON.parse(raw) : null;
    return String(parsed?.householdId || parsed?.homeId || "default-household");
  } catch {
    return "default-household";
  }
}

function emitUiToast(type, message) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("toast", {
      detail: { type, message },
    })
  );
}

/* ────────────────────────────────────────────────────────────────────────────
  Inputs fetchers (defensive)
──────────────────────────────────────────────────────────────────────────── */
async function getAnimalQueueSafe() {
  const mod =
    (await safeImport("@/managers/AnimalQueueManager")) ||
    (await safeImport("../../managers/AnimalQueueManager")) ||
    null;
  const api = mod?.default || mod || {};
  const q =
    (await safeCall(Promise.resolve(api), "getQueue")) || api.queue || [];
  return Array.isArray(q) ? q : [];
}

async function getGardenQueueSafe() {
  const mod =
    (await safeImport("@/managers/GardenQueueManager")) ||
    (await safeImport("../../managers/GardenQueueManager")) ||
    null;
  const api = mod?.default || mod || {};
  const q =
    (await safeCall(Promise.resolve(api), "getQueue")) || api.queue || [];
  return Array.isArray(q) ? q : [];
}

/* ────────────────────────────────────────────────────────────────────────────
  Custom Locations (inline manager) — raised pill buttons
──────────────────────────────────────────────────────────────────────────── */
function CustomLocationsInline() {
  const [locations, setLocations] = useState([
    "Pantry",
    "Fridge",
    "Freezer",
    "Garage",
  ]);
  const [newLoc, setNewLoc] = useState("");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const mod =
        (await safeImport("@/managers/LocationManager")) ||
        (await safeImport("@/store/LocationsStore")) ||
        (await safeImport("@/store/StorageLocationsStore")) ||
        null;
      try {
        const api = mod?.default || mod;
        const getter =
          api?.getAll ||
          api?.getLocations ||
          api?.get ||
          (Array.isArray(api?.locations) ? () => api.locations : null);
        if (getter) {
          const res = await getter();
          if (alive && Array.isArray(res) && res.length) setLocations(res);
        }
      } catch {}
    })();
    return () => {
      alive = false;
    };
  }, []);

  const persist = useCallback(async (list) => {
    setBusy(true);
    try {
      const mod =
        (await safeImport("@/managers/LocationManager")) ||
        (await safeImport("@/store/LocationsStore")) ||
        (await safeImport("@/store/StorageLocationsStore")) ||
        null;
      const api = mod?.default || mod;
      const setter = api?.setAll || api?.setLocations || api?.save || null;
      if (setter) await setter(list);
      else automation.emit("locations/update", { locations: list });

      emitCanonicalSignal({
        type: "inventoryAdded",
        sourceModule: "planner.storehouse",
        urgency: "low",
        completionPct: 100,
        dependencies: ["storehouse"],
        payload: {
          action: "locationsUpdated",
          count: Array.isArray(list) ? list.length : 0,
        },
      });

      setOk(true);
      setTimeout(() => setOk(false), 900);
    } finally {
      setBusy(false);
    }
  }, []);

  const add = () => {
    const v = newLoc.trim();
    if (!v) return;
    if (locations.some((x) => x.toLowerCase() === v.toLowerCase())) {
      setNewLoc("");
      return;
    }
    const next = [...locations, v];
    setLocations(next);
    setNewLoc("");
    persist(next);
  };

  const remove = (name) => {
    const next = locations.filter((x) => x !== name);
    setLocations(next);
    persist(next);
  };

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="subtitle" style={{ fontWeight: 700 }}>
        Custom Locations
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          className="btn"
          placeholder="Add a storage location (e.g., Root Cellar, Shed)"
          value={newLoc}
          onChange={(e) => setNewLoc(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          style={{ flex: 1 }}
        />
        <button className="btn sm primary" onClick={add} aria-busy={busy}>
          <span className="label">Add</span>
        </button>
        {ok ? (
          <span className="subtitle" style={{ color: "var(--success)" }}>
            ✓ Saved
          </span>
        ) : null}
      </div>

      {/* Raised pill buttons with shadow, matching other raised buttons */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        {locations.map((loc) => (
          <button
            key={loc}
            type="button"
            className="btn sm"
            title={loc}
            style={{
              borderRadius: 999,
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              paddingInline: 12,
              background: "#fff",
              boxShadow:
                "0 6px 14px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.06)",
              border: "1px solid var(--border, #e5e7eb)",
            }}
            onClick={(e) => e.preventDefault()}
          >
            <span className="label" style={{ fontWeight: 600 }}>
              {loc}
            </span>
            <span
              role="button"
              aria-label={`Remove ${loc}`}
              onClick={(e) => {
                e.stopPropagation();
                remove(loc);
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 22,
                height: 22,
                borderRadius: 999,
                border: "1px solid var(--border, #e5e7eb)",
                background: "rgba(0,0,0,0.04)",
                lineHeight: 1,
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              ×
            </span>
          </button>
        ))}
        {!locations.length && (
          <span className="subtitle">No locations yet — add one above.</span>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
  Lazy tool registry (kept, but hidden until you open them)
──────────────────────────────────────────────────────────────────────────── */
const ToolAutoFill = lazy(() =>
  import("../../components/storehouse/StorehouseAutoFillPlanner").then((m) => ({
    default: m.default || m,
  }))
);
const ToolPreserveQueue = lazy(() =>
  import("../../components/storehouse/PreservationQueuePlanner").then((m) => ({
    default: m.default || m,
  }))
);

const toolDefs = [
  { id: "auto-fill", label: "Auto-Fill Planner", Comp: ToolAutoFill },
  {
    id: "preserve-queue",
    label: "Preservation Queue",
    Comp: ToolPreserveQueue,
  },
];

/* ────────────────────────────────────────────────────────────────────────────
  Page
──────────────────────────────────────────────────────────────────────────── */
export default function StorehousePage() {
  const { options: vision } = useVision() || { options: {} };

  // Inputs
  const [animalQueue, setAnimalQueue] = useState([]);
  const [gardenQueue, setGardenQueue] = useState([]);

  // Projections
  const [project, setProject] = useState(null);
  const [debug, setDebug] = useState(null);
  const [busy, setBusy] = useState(false);

  // Background auto-forecast toggle
  const [autoForecast, setAutoForecast] = useState(true);
  const runningRef = useRef(false);
  const [lastRun, setLastRun] = useState(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [sacredStorehouseAlerts, setSacredStorehouseAlerts] = useState([
    {
      id: "store-alert-1",
      type: "info",
      title: "Forecast loop active",
      message:
        "Storehouse projections are synced with current household profile inputs.",
      timestamp: "Now",
    },
    {
      id: "store-alert-2",
      type: "warning",
      title: "Replenishment watch",
      message:
        "Review low-stock items before next batch-cooking window for smoother flow.",
      timestamp: "12m ago",
    },
  ]);
  const [storehouseFeedState, setStorehouseFeedState] = useState([]);
  const [feedBusyById, setFeedBusyById] = useState({});
  const [alertsBusyById, setAlertsBusyById] = useState({});
  const [householdAgenda, setHouseholdAgenda] = useState({
    applied: {
      filters: {
        person: "",
        module: "",
        priority: "",
        status: "",
      },
      sortBy: "dueAt",
      sortDirection: "desc",
    },
    today: [],
    upcoming: [],
  });
  const [householdAgendaBusy, setHouseholdAgendaBusy] = useState(false);
  const [agendaFilters, setAgendaFilters] = useState({
    person: "",
    module: "",
    priority: "",
    status: "",
    sortBy: "dueAt",
    sortDirection: "desc",
  });
  const [agendaPersonDraft, setAgendaPersonDraft] = useState("");

  const storehouseFeed = useMemo(() => {
    if (Array.isArray(storehouseFeedState) && storehouseFeedState.length) {
      return storehouseFeedState;
    }
    return [
      {
        id: "store-feed-1",
        author: "Storehouse Coordinator",
        content:
          "Weekly projection updated from garden + animal queues. Prioritize grain and legumes procurement.",
        timestamp: "Today 07:50",
        likes: 11,
        comments: 2,
        shares: 1,
      },
      {
        id: "store-feed-2",
        author: "Willow Household",
        household: true,
        content:
          "Preservation queue aligned with incoming produce peaks for this cycle.",
        timestamp: "Today 06:35",
        likes: 8,
        comments: 1,
        shares: 0,
      },
    ];
  }, [storehouseFeedState]);

  const loadStorehouseContext = useCallback(async () => {
    try {
      const householdId = resolveStorehouseHouseholdId();
      const response = await fetch(
        `/api/planners/storehouse/context?householdId=${encodeURIComponent(householdId)}`,
        {
          credentials: "include",
        }
      );
      if (!response.ok) return;
      const payload = await response.json();
      if (Array.isArray(payload?.feed)) {
        setStorehouseFeedState(payload.feed);
      }
      if (Array.isArray(payload?.alerts)) {
        setSacredStorehouseAlerts(payload.alerts);
      }
    } catch {
      // keep local fallback context
    }
  }, []);

  const loadHouseholdAgenda = useCallback(async () => {
    setHouseholdAgendaBusy(true);
    try {
      const householdId = resolveStorehouseHouseholdId();
      const params = buildHouseholdTodayUpcomingQuery({
        householdId,
        modules: "meal,cleaning,storehouse,homestead,community",
        todayLimit: 6,
        upcomingLimit: 6,
        filters: agendaFilters,
      });
      const response = await fetch(
        `/api/planners/household/today-upcoming?${params.toString()}`,
        {
          credentials: "include",
        }
      );
      if (!response.ok) return;
      const payload = await response.json();
      setHouseholdAgenda({
        applied: payload?.applied && typeof payload.applied === "object"
          ? payload.applied
          : {
              filters: {
                person: String(agendaFilters.person || ""),
                module: String(agendaFilters.module || ""),
                priority: String(agendaFilters.priority || ""),
                status: String(agendaFilters.status || ""),
              },
              sortBy: String(agendaFilters.sortBy || "dueAt"),
              sortDirection: String(agendaFilters.sortDirection || "desc"),
            },
        today: Array.isArray(payload?.today) ? payload.today : [],
        upcoming: Array.isArray(payload?.upcoming) ? payload.upcoming : [],
      });
      const normalizedAppliedFilters = normalizeAppliedAgendaFilters(payload?.applied);
      setAgendaFilters((previous) => {
        if (areAgendaFiltersEqual(previous, normalizedAppliedFilters)) {
          return previous;
        }
        return normalizedAppliedFilters;
      });
      setAgendaPersonDraft((previous) => {
        if (previous === normalizedAppliedFilters.person) {
          return previous;
        }
        return normalizedAppliedFilters.person;
      });
    } catch {
      // keep existing agenda state
    } finally {
      setHouseholdAgendaBusy(false);
    }
  }, [agendaFilters]);

  const dismissStorehouseAlert = useCallback(async (id) => {
    setAlertsBusyById((prev) => ({ ...prev, [id]: true }));
    try {
      const householdId = resolveStorehouseHouseholdId();
      const response = await fetch(
        `/api/planners/storehouse/context/alerts/${encodeURIComponent(id)}/dismiss`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ householdId }),
        }
      );
      if (response.ok) {
        const payload = await response.json();
        if (Array.isArray(payload?.alerts)) {
          setSacredStorehouseAlerts(payload.alerts);
        } else {
          setSacredStorehouseAlerts((prev) => prev.filter((item) => item.id !== id));
        }
      } else {
        setSacredStorehouseAlerts((prev) => prev.filter((item) => item.id !== id));
      }
    } catch {
      setSacredStorehouseAlerts((prev) => prev.filter((item) => item.id !== id));
    } finally {
      setAlertsBusyById((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }, []);

  const reactToStorehouseFeed = useCallback(async (postId, action) => {
    setFeedBusyById((prev) => ({ ...prev, [postId]: action }));
    try {
      const householdId = resolveStorehouseHouseholdId();
      const response = await fetch(
        `/api/planners/storehouse/context/feed/${encodeURIComponent(postId)}/action`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ householdId, action, delta: 1 }),
        }
      );
      if (response.ok) {
        const payload = await response.json();
        if (Array.isArray(payload?.feed)) {
          setStorehouseFeedState(payload.feed);
        }
      }
    } catch {
      // preserve existing UI state
    } finally {
      setFeedBusyById((prev) => {
        const next = { ...prev };
        delete next[postId];
        return next;
      });
    }
  }, []);

  function formatTimeAgo(timestamp) {
    if (!Number(new Date(timestamp).getTime())) return "Never";
    const deltaMs = Math.max(0, nowTick - Number(new Date(timestamp).getTime()));
    const minutes = Math.floor(deltaMs / (60 * 1000));
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function agendaCueLine(item) {
    return [
      String(item?.module || item?.lane || "household"),
      String(item?.workflowState || item?.state || "planned"),
      item?.priority ? String(item.priority) : null,
      item?.recurrenceEnabled ? "recurring" : null,
      item?.hasDependencyBlock
        ? `blocked by ${Number(item?.blockingDependencyCount || 0)} deps`
        : null,
      item?.hasConflict ? `conflicts ${Number(item?.conflictCount || 0)}` : null,
      item?.overdue ? "overdue" : null,
    ]
      .filter(Boolean)
      .join(" | ");
  }

  const emitForecastSignals = useCallback((forecast) => {
    const weekly = forecast?.weekly || {};
    const eggs = Number(weekly?.eggs || 0);
    const milkLiters = Number(weekly?.milkLiters || 0);
    const produceKg = Number(weekly?.produceKg || 0);
    const meatKg = Number(weekly?.meatKg || 0);
    const total = eggs + milkLiters + produceKg + meatKg;

    if (total > 0) {
      emitCanonicalSignal({
        type: "inventoryAdded",
        sourceModule: "planner.storehouse",
        urgency: "normal",
        completionPct: 100,
        dependencies: ["meal", "sessions", "storehouse"],
        payload: {
          name: "Projected weekly inputs",
          eggs,
          milkLiters,
          produceKg,
          meatKg,
        },
      });
      return;
    }

    emitCanonicalSignal({
      type: "inventoryShortage",
      sourceModule: "planner.storehouse",
      urgency: "high",
      completionPct: 100,
      dependencies: ["meal", "sessions", "storehouse"],
      payload: {
        name: "Projected weekly inputs",
        message: "No projected inputs available for this cycle.",
      },
    });
  }, []);

  // Tools (optional)
  const [activeTool, setActiveTool] = useState("");
  const ToolComp = useMemo(
    () => toolDefs.find((t) => t.id === activeTool)?.Comp,
    [activeTool]
  );

  useEffect(() => {
    recordProductActionImpression({
      page: "planner.storehouse",
      quickActionCount: 4,
      meta: {
        tool: activeTool || "overview",
      },
    });
    // Impression tracked once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load inputs once (and when user opens the page again)
  const loadInputs = useCallback(async () => {
    const [animals, gardens] = await Promise.all([
      getAnimalQueueSafe(),
      getGardenQueueSafe(),
    ]);
    setAnimalQueue(animals);
    setGardenQueue(gardens);
    return { animals, gardens };
  }, []);

  // Compute projections via template, then backend snapshot
  const computeProjections = useCallback(
    async (inputs) => {
      setBusy(true);
      setDebug(null);
      try {
        const householdId = resolveStorehouseHouseholdId();
        const backendSnapshot = await fetchStorehousePlannerData(householdId).catch(
          () => null
        );

        const payload = {
          invokedBy: "ui/storehouse",
          vision: vision || {},
          animals: inputs?.animals ?? animalQueue,
          gardens: inputs?.gardens ?? gardenQueue,
        };
        // Prefer template if registered
        const canRunProjectionTemplate =
          typeof automation?.hasTemplate === "function" &&
          automation.hasTemplate("storehouse.projections");
        const res = canRunProjectionTemplate
          ? (await automation
              .runTemplate?.("storehouse.projections", payload)
              .catch(() => null)) || null
          : null;

        const backendWeekly =
          backendSnapshot?.projection?.weekly || backendSnapshot?.weekly || null;
        if (res && typeof res === "object" && res.weekly) {
          setProject(res);
          setDebug({
            via: "template",
            backendInventoryCount: Array.isArray(backendSnapshot?.inventory)
              ? backendSnapshot.inventory.length
              : 0,
          });
          emitForecastSignals(res);
        } else if (backendWeekly && typeof backendWeekly === "object") {
          const backendProjection = {
            weekly: {
              eggs: Number(backendWeekly.eggs || 0),
              milkLiters: Number(backendWeekly.milkLiters || 0),
              produceKg: Number(backendWeekly.produceKg || 0),
              meatKg: Number(backendWeekly.meatKg || 0),
            },
            notes: "Backend projection snapshot",
          };
          setProject(backendProjection);
          setDebug({
            via: "backend",
            backendInventoryCount: Array.isArray(backendSnapshot?.inventory)
              ? backendSnapshot.inventory.length
              : 0,
          });
          emitForecastSignals(backendProjection);
        } else {
          throw new Error("Backend/storehouse projection unavailable in strict mode.");
        }
        setLastRun(new Date().toISOString());
        emitUiToast("success", "Storehouse forecast updated from backend snapshot.");
      } catch (error) {
        emitUiToast(
          "error",
          `Storehouse forecast failed: ${String(error?.message || "unknown error")}`
        );
        throw error;
      } finally {
        setBusy(false);
      }
    },
    [vision, animalQueue, gardenQueue, emitForecastSignals]
  );

  // Background: run when Home profile changes
  const debouncedForecast = useDebouncedCallback(async () => {
    if (!autoForecast || runningRef.current) return;
    runningRef.current = true;
    try {
      const inputs = await loadInputs();
      await computeProjections(inputs);
    } finally {
      runningRef.current = false;
    }
  }, 900);

  useEffect(() => {
    debouncedForecast();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    autoForecast,
    vision?.mode,
    vision?.goals,
    vision?.constraints,
    vision?.dietary,
    vision?.weeklyHrs,
    vision?.budget,
  ]);

  useEffect(() => {
    const tickId = window.setInterval(() => {
      setNowTick(Date.now());
    }, 60 * 1000);
    return () => {
      window.clearInterval(tickId);
    };
  }, []);

  // Manual refresh
  const refreshNow = async () => {
    recordProductActionClick({
      page: "planner.storehouse",
      action: "refresh_projections",
      status: "click",
      meta: {
        activeTool: activeTool || "overview",
      },
    });
    const inputs = await loadInputs();
    await computeProjections(inputs);
    recordProductActionClick({
      page: "planner.storehouse",
      action: "refresh_projections",
      status: "success",
      meta: {
        activeTool: activeTool || "overview",
      },
    });
  };

  // Initial load
  useEffect(() => {
    refreshNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadStorehouseContext();
  }, [loadStorehouseContext]);

  useEffect(() => {
    loadHouseholdAgenda();
  }, [loadHouseholdAgenda]);

  return (
    <div className="sv-container ssa-content-flow">
      <div className="ssa-hero-wrap p-4">
        <div className="sv-row sv-wrap" style={{ gap: 8, alignItems: "center", marginBottom: 4 }}>
          <h1 className="ssa-hero-title text-2xl">🏚️ Storehouse Tools</h1>
          <span className="ssa-hero-chip">
            Last auto-sync: {formatTimeAgo(lastRun)}
          </span>
        </div>
        <p className="subtitle ssa-hero-subtitle">
          See upcoming inputs from animals and gardens, and forecast what flows
          into your storehouse. Automations run quietly based on your Home setup.
        </p>
      </div>

      <div
        className="card ssa-panel-balanced ssa-interactive-panel"
        style={{ marginBottom: 12, width: "100%", maxWidth: 1440, marginInline: "auto" }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
          <SacredAvatar
            name="Storehouse Module"
            type="household"
            subtitle="Sacred Agrarian visual layer"
            online
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <SacredButton size="sm" onClick={refreshNow} loading={busy}>
              Refresh Projections
            </SacredButton>
            <SacredButton
              size="sm"
              tone="secondary"
              onClick={() => {
                recordProductActionClick({
                  page: "planner.storehouse",
                  action: "open_auto_fill",
                  status: "click",
                });
                setActiveTool("auto-fill");
              }}
            >
              Auto-Fill
            </SacredButton>
            <SacredButton
              size="sm"
              tone="accent"
              onClick={() => {
                recordProductActionClick({
                  page: "planner.storehouse",
                  action: "open_preservation_queue",
                  status: "click",
                });
                setActiveTool("preserve-queue");
              }}
            >
              Preservation Queue
            </SacredButton>
          </div>
        </div>

        <div style={{ marginTop: 12, width: "100%", maxWidth: 1440, marginInline: "auto" }}>
          <DashboardGrid columns={3}>
            <SacredCard
              kind="storehouse"
              title="Forecast Health"
              subtitle="Weekly projection confidence"
              value={project?.weekly ? "Stable" : "Pending"}
              delta={project?.weekly ? 5 : -3}
              footer={lastRun ? `Last run ${new Date(lastRun).toLocaleTimeString()}` : "Awaiting run"}
            >
              {debug?.via === "template"
                ? "Template projection active with runtime signals emitted."
                : debug?.via === "backend"
                  ? "Backend projection snapshot active with runtime signals emitted."
                  : "Awaiting backend projection data."}
            </SacredCard>
            <SacredCard
              kind="meal"
              title="Eggs + Milk"
              subtitle="Animal-derived output"
              value={`${Number(project?.weekly?.eggs || 0).toFixed(0)} / ${Number(project?.weekly?.milkLiters || 0).toFixed(1)}L`}
              delta={2}
              footer="Eggs / Milk liters per week"
            >
              Animal queue signals are mapped to storehouse inflow expectations.
            </SacredCard>
            <SacredCard
              kind="dashboard"
              title="Produce + Meat"
              subtitle="Garden and harvest output"
              value={`${Number(project?.weekly?.produceKg || 0).toFixed(1)}kg / ${Number(project?.weekly?.meatKg || 0).toFixed(1)}kg`}
              delta={1}
              footer="Produce / Meat per week"
            >
              Use this to align batch planning and preservation decisions.
            </SacredCard>
          </DashboardGrid>
        </div>

        <div style={{ marginTop: 12, display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
          <div style={{ display: "grid", gap: 10 }}>
            {storehouseFeed.map((item) => (
              <FeedPost
                key={item.id}
                {...item}
                onLike={() => reactToStorehouseFeed(item.id, "like")}
                onComment={() => reactToStorehouseFeed(item.id, "comment")}
                onShare={() => reactToStorehouseFeed(item.id, "share")}
                busyLike={feedBusyById[item.id] === "like"}
                busyComment={feedBusyById[item.id] === "comment"}
                busyShare={feedBusyById[item.id] === "share"}
              />
            ))}
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            {sacredStorehouseAlerts.map((item) => (
              <Notification
                key={item.id}
                type={item.type}
                title={item.title}
                message={item.message}
                timestamp={item.timestamp}
                onDismiss={() => dismissStorehouseAlert(item.id)}
                dismissing={Boolean(alertsBusyById[item.id])}
              />
            ))}
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <RealtimeCoordinationPanel scopeOverrides={{ scope: "household" }} />
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="subtitle" style={{ fontWeight: 700 }}>
          Household Today and Upcoming
        </div>
        <div
          style={{
            marginTop: 8,
            display: "grid",
            gap: 8,
            gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          }}
        >
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            <span className="subtitle">Module</span>
            <select
              value={agendaFilters.module}
              onChange={(event) =>
                setAgendaFilters((prev) => ({ ...prev, module: String(event.target.value || "") }))
              }
            >
              <option value="">All</option>
              <option value="meal">meal</option>
              <option value="cleaning">cleaning</option>
              <option value="storehouse">storehouse</option>
              <option value="homestead">homestead</option>
              <option value="community">community</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            <span className="subtitle">Priority</span>
            <select
              value={agendaFilters.priority}
              onChange={(event) =>
                setAgendaFilters((prev) => ({ ...prev, priority: String(event.target.value || "") }))
              }
            >
              <option value="">All</option>
              <option value="critical">critical</option>
              <option value="high">high</option>
              <option value="normal">normal</option>
              <option value="low">low</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            <span className="subtitle">Status</span>
            <select
              value={agendaFilters.status}
              onChange={(event) =>
                setAgendaFilters((prev) => ({ ...prev, status: String(event.target.value || "") }))
              }
            >
              <option value="">All</option>
              <option value="blocked">blocked</option>
              <option value="pending_approval">pending_approval</option>
              <option value="active">active</option>
              <option value="draft">draft</option>
              <option value="planned">planned</option>
              <option value="completed">completed</option>
              <option value="archived">archived</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            <span className="subtitle">Sort</span>
            <select
              value={agendaFilters.sortBy}
              onChange={(event) =>
                setAgendaFilters((prev) => ({ ...prev, sortBy: String(event.target.value || "dueAt") }))
              }
            >
              <option value="dueAt">dueAt</option>
              <option value="priority">priority</option>
              <option value="status">status</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            <span className="subtitle">Direction</span>
            <select
              value={agendaFilters.sortDirection}
              onChange={(event) =>
                setAgendaFilters((prev) => ({ ...prev, sortDirection: String(event.target.value || "desc") }))
              }
            >
              <option value="desc">desc</option>
              <option value="asc">asc</option>
            </select>
          </label>
        </div>
        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 8 }}>
          <input
            type="text"
            value={agendaPersonDraft}
            onChange={(event) => setAgendaPersonDraft(String(event.target.value || ""))}
            placeholder="Filter by person handle"
            style={{ flex: "1 1 240px" }}
          />
          <SacredButton
            size="sm"
            tone="secondary"
            onClick={() =>
              setAgendaFilters((prev) => ({
                ...prev,
                person: String(agendaPersonDraft || "").trim().toLowerCase(),
              }))
            }
          >
            Apply Person
          </SacredButton>
          <SacredButton
            size="sm"
            tone="secondary"
            onClick={() => {
              setAgendaPersonDraft("");
              setAgendaFilters({
                person: "",
                module: "",
                priority: "",
                status: "",
                sortBy: "dueAt",
                sortDirection: "desc",
              });
            }}
          >
            Reset Filters
          </SacredButton>
          <SacredButton size="sm" onClick={loadHouseholdAgenda} loading={householdAgendaBusy}>
            Refresh Agenda
          </SacredButton>
        </div>
        {householdAgendaBusy &&
        !householdAgenda.today.length &&
        !householdAgenda.upcoming.length ? (
          <div className="subtitle">Loading household agenda…</div>
        ) : (
          <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
            <div className="subtitle" style={{ fontSize: 12 }}>
              Applied: {String(householdAgenda?.applied?.filters?.module || "all modules")}
              {householdAgenda?.applied?.filters?.priority
                ? ` | ${String(householdAgenda.applied.filters.priority)} priority`
                : ""}
              {householdAgenda?.applied?.filters?.status
                ? ` | ${String(householdAgenda.applied.filters.status)} status`
                : ""}
              {householdAgenda?.applied?.filters?.person
                ? ` | person ${String(householdAgenda.applied.filters.person)}`
                : ""}
              {` | sort ${String(householdAgenda?.applied?.sortBy || "dueAt")}:${String(householdAgenda?.applied?.sortDirection || "desc")}`}
            </div>
            <div
              style={{
                display: "grid",
                gap: 12,
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              }}
            >
            <section>
              <div className="subtitle" style={{ fontWeight: 600 }}>
                Today
              </div>
              {householdAgenda.today.length ? (
                <ul style={{ margin: "6px 0 0", paddingLeft: 18, display: "grid", gap: 6 }}>
                  {householdAgenda.today.slice(0, 4).map((item) => (
                    <li key={item.id} style={{ color: "var(--fg)", fontSize: 13 }}>
                      <div style={{ display: "grid", gap: 2 }}>
                        <span>{item.title}</span>
                        <span className="sv-muted" style={{ fontSize: 11 }}>
                          {agendaCueLine(item)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="subtitle">No items for today.</div>
              )}
            </section>

            <section>
              <div className="subtitle" style={{ fontWeight: 600 }}>
                Upcoming
              </div>
              {householdAgenda.upcoming.length ? (
                <ul style={{ margin: "6px 0 0", paddingLeft: 18, display: "grid", gap: 6 }}>
                  {householdAgenda.upcoming.slice(0, 4).map((item) => (
                    <li key={item.id} style={{ color: "var(--fg)", fontSize: 13 }}>
                      <div style={{ display: "grid", gap: 2 }}>
                        <span>{item.title}</span>
                        <span className="sv-muted" style={{ fontSize: 11 }}>
                          {agendaCueLine(item)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="subtitle">No upcoming items.</div>
              )}
            </section>
            </div>
          </div>
        )}
      </div>

      {/* Background controls */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="subtitle" style={{ fontWeight: 700 }}>
          Forecast Control
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <label
            className="field"
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <input
              type="checkbox"
              checked={autoForecast}
              onChange={(e) => setAutoForecast(e.target.checked)}
            />
            <span className="subtitle">
              Auto-forecast from Home profile and queues
            </span>
          </label>
          <button className="btn sm" onClick={refreshNow} aria-busy={busy}>
            <span className="label">{busy ? "Running…" : "Run forecast"}</span>
          </button>
          {lastRun && (
            <span className="subtitle">
              Last run: {new Date(lastRun).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {/* Inputs Overview */}
      <div className="card">
        <div className="subtitle" style={{ fontWeight: 700 }}>
          Upcoming Inputs
        </div>

        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          }}
        >
          {/* Animals */}
          <section
            className="card"
            style={{ background: "#fffaf0", borderColor: "#fde68a" }}
          >
            <h3 style={{ marginTop: 0 }}>🐓 Animals in Progress</h3>
            {animalQueue.length ? (
              <ul className="text-sm" style={{ marginLeft: 16 }}>
                {animalQueue.map((p, i) => (
                  <li key={String(p.id ?? i)}>
                    <strong>{String(p.name ?? p.type ?? "Plan")}</strong>
                    {p.cadence ? ` — ${String(p.cadence)}` : ""}
                    {Array.isArray(p.zones)
                      ? ` • zones: ${p.zones.length}`
                      : ""}
                    {Array.isArray(p.steps)
                      ? ` • steps: ${p.steps.length}`
                      : ""}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="subtitle">No active animal plans.</p>
            )}
          </section>

          {/* Gardens */}
          <section
            className="card"
            style={{ background: "#f0fff4", borderColor: "#bbf7d0" }}
          >
            <h3 style={{ marginTop: 0 }}>🌿 Gardens Planned</h3>
            {gardenQueue.length ? (
              <ul className="text-sm" style={{ marginLeft: 16 }}>
                {gardenQueue.map((g, i) => (
                  <li key={String(g.id ?? i)}>
                    <strong>{String(g.name ?? "Garden")}</strong>
                    {Array.isArray(g.crops)
                      ? ` — ${g.crops.length} crop${
                          g.crops.length === 1 ? "" : "s"
                        }`
                      : ""}
                    {g.cadence ? ` • ${String(g.cadence)}` : ""}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="subtitle">No plantings scheduled.</p>
            )}
          </section>
        </div>
      </div>

      {/* Projected Outputs */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="subtitle" style={{ fontWeight: 700 }}>
          Projected Storehouse Outputs (weekly)
        </div>

        {project ? (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "separate",
                borderSpacing: 0,
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "var(--brand-weak)",
                    color: "var(--brand-ink)",
                  }}
                >
                  <th style={th}>Eggs</th>
                  <th style={th}>Milk (L)</th>
                  <th style={th}>Produce (kg)</th>
                  <th style={th}>Meat (kg)</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={td}>
                    {Number(project.weekly?.eggs || 0).toFixed(0)}
                  </td>
                  <td style={td}>
                    {Number(project.weekly?.milkLiters || 0).toFixed(1)}
                  </td>
                  <td style={td}>
                    {Number(project.weekly?.produceKg || 0).toFixed(1)}
                  </td>
                  <td style={td}>
                    {Number(project.weekly?.meatKg || 0).toFixed(1)}
                  </td>
                </tr>
              </tbody>
            </table>

            {project.notes ? (
              <p className="subtitle" style={{ marginTop: 8 }}>
                {project.notes}
              </p>
            ) : null}
            {debug ? (
              <p
                className="subtitle"
                style={{ marginTop: 4, color: "var(--muted)" }}
              >
                via {debug.via}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="subtitle">
            {busy ? "Calculating…" : "No projection yet."}
          </p>
        )}
      </div>

      {/* Inline Custom Locations */}
      <CustomLocationsInline />

      <AutomationPanel
        title="Shopping Automation Templates"
        agents={[]}
        defaultTemplateFilter="shopping"
      />

      {/* Optional tools (hidden until opened) */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          margin: "12px 0 12px",
        }}
      >
        {toolDefs.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setActiveTool(id)}
            className={`btn sm ${activeTool === id ? "primary" : ""}`}
            aria-pressed={activeTool === id}
          >
            <span className="label">{label}</span>
          </button>
        ))}
      </div>

      <div className="card" style={{ minHeight: 80 }}>
        {activeTool ? (
          <LoadingBoundary placeholder={<div className="subtitle">Loading…</div>}>
            <ToolComp />
          </LoadingBoundary>
        ) : (
          <p className="subtitle">Open a tool if you need to fine-tune.</p>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
  Table cell styles
──────────────────────────────────────────────────────────────────────────── */
const th = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: ".8rem",
  textTransform: "uppercase",
  letterSpacing: ".04em",
  borderBottom: "1px solid var(--line)",
};
const td = { padding: "10px 12px", fontSize: ".95rem" };
