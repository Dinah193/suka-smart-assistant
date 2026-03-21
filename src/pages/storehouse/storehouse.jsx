// src/pages/storehouse/storehouse.jsx
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  Suspense,
  lazy,
} from "react";

import { automation } from "@/services/automation/runtime";
import { useVision } from "@/context/VisionContext";
import RealtimeCoordinationPanel from "@/components/home/RealtimeCoordinationPanel";
import { emitCanonicalSignal } from "@/services/realtime/canonicalSignalEmitter";
import AutomationPanel from "@/ui/AutomationPanel";

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
  Simple projection fallback (if no template available)
  - Chickens: 5 eggs/hen/week
  - Ducks: 4 eggs/hen/week
  - Goats: 2 L milk/doe/day (14 L/week)
  - Cows: 12 L milk/cow/day (84 L/week)
  - Gardens: try "count*yieldPerPlant" or "area*yieldPerSqm" if present,
             otherwise guess 0.5kg per plant / 1kg per sqm per week in season.
──────────────────────────────────────────────────────────────────────────── */
function simpleProjections({ animals = [], gardens = [] }) {
  const weekly = {
    eggs: 0,
    milkLiters: 0,
    produceKg: 0,
    meatKg: 0,
  };

  // Animals
  animals.forEach((a) => {
    const kind = String(a.type || a.species || a.name || "").toLowerCase();
    const count = Number(a.count || a.qty || a.headcount || 0);
    if (!count) return;

    if (kind.includes("chicken") || kind.includes("layer")) {
      weekly.eggs += count * 5;
    } else if (kind.includes("duck")) {
      weekly.eggs += count * 4;
    } else if (kind.includes("goat")) {
      weekly.milkLiters += count * 14; // 2L/day
    } else if (kind.includes("cow")) {
      weekly.milkLiters += count * 84; // 12L/day
    }

    if (kind.includes("broiler") || kind.includes("meat")) {
      // naive rolling average toward harvest
      weekly.meatKg += count * 0.5; // placeholder weekly growth contribution
    }
  });

  // Gardens
  gardens.forEach((g) => {
    const crops = Array.isArray(g.crops) ? g.crops : [];
    crops.forEach((c) => {
      const count = Number(c.count || c.plants || 0);
      const ypp = Number(c.yieldPerPlant || 0);
      const area = Number(c.area || 0);
      const yps = Number(c.yieldPerSqm || 0);

      if (count && ypp) weekly.produceKg += count * ypp;
      else if (area && yps) weekly.produceKg += area * yps;
      else if (count) weekly.produceKg += count * 0.5;
      else if (area) weekly.produceKg += area * 1;
    });
  });

  return { weekly, notes: "Fallback projections (simple heuristics)" };
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

  // Compute projections via template, fallback to heuristics
  const computeProjections = useCallback(
    async (inputs) => {
      setBusy(true);
      setDebug(null);
      try {
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

        if (res && typeof res === "object" && res.weekly) {
          setProject(res);
          setDebug({ via: "template" });
          emitForecastSignals(res);
        } else {
          const fb = simpleProjections({
            animals: payload.animals,
            gardens: payload.gardens,
          });
          setProject(fb);
          setDebug({ via: "fallback" });
          emitForecastSignals(fb);
        }
        setLastRun(new Date().toISOString());
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

  // Manual refresh
  const refreshNow = async () => {
    const inputs = await loadInputs();
    await computeProjections(inputs);
  };

  // Initial load
  useEffect(() => {
    refreshNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <h1>🏚️ Storehouse Tools</h1>
      <p className="subtitle">
        See upcoming inputs from animals and gardens, and forecast what flows
        into your storehouse. Automations run quietly based on your Home setup.
      </p>

      <div style={{ marginBottom: 12 }}>
        <RealtimeCoordinationPanel scopeOverrides={{ scope: "household" }} />
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
          <Suspense fallback={<div className="subtitle">Loading…</div>}>
            <ToolComp />
          </Suspense>
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
