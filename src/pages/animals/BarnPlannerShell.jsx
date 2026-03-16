/* eslint-disable no-console */
// src/pages/animals/BarnPlannerShell.jsx
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * BarnPlannerShell — plan barn layout, assignments, and sessions
 * ----------------------------------------------------------------
 * New in this version:
 * - Global Loss settings: feed loss % and bedding loss % (autosaved).
 * - Per-stall overrides for loss % (optional).
 * - Estimates now show Base, +Loss, and Final totals.
 *
 * Still includes:
 * - Grid layout editor, stall assignment, chore rotations, Sabbath Guard,
 * - Safe/optional integrations (eventBus, NBA, estimateEngine, etc.),
 * - Prep consolidation hooks, runbook preview, undo toast, autosave.
 */

// ---------- Optional services (safe shims) ----------
const useSafeEventBus = () => {
  const [bus, setBus] = useState(null);
  useEffect(() => {
    let on = true;
    (async () => {
      try {
        const mod = await import(
          /* webpackIgnore: true */ "../../services/events/eventBus.js"
        ).catch(() => null);
        if (on && mod?.eventBus) setBus(mod.eventBus);
      } catch (e) {}
      if (on && !bus) setBus(createLocalBus());
    })();
    return () => (on = false);
  }, []);
  return bus ?? createLocalBus();
};
function createLocalBus() {
  const listeners = {};
  return {
    on(evt, cb) {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(cb);
      return () =>
        (listeners[evt] = (listeners[evt] || []).filter((f) => f !== cb));
    },
    emit(evt, payload) {
      (listeners[evt] || []).forEach((cb) => {
        try {
          cb(payload);
        } catch (e) {
          console.warn("eventBus listener error:", e);
        }
      });
    },
  };
}

const useSafeNBA = () => {
  const [invoke, setInvoke] = useState(() => () => {});
  useEffect(() => {
    let on = true;
    (async () => {
      try {
        const mod = await import(
          /* webpackIgnore: true */ "../../services/nbaOrchestrator.js"
        ).catch(() => null);
        if (on && mod?.invokeNBA) setInvoke(() => mod.invokeNBA);
      } catch (e) {}
    })();
    return () => (on = false);
  }, []);
  return invoke;
};

async function safeScheduleHelpers() {
  try {
    const mod = await import(
      /* webpackIgnore: true */ "../../engines/calendar/scheduleHelpers.js"
    ).catch(() => null);
    return mod || {};
  } catch (e) {
    return {};
  }
}
async function safeEstimateEngine() {
  try {
    const mod = await import(
      /* webpackIgnore: true */ "../../engines/cost/estimateEngine.js"
    ).catch(() => null);
    return mod || {};
  } catch (e) {
    return {};
  }
}
async function safePlanTemplates() {
  try {
    const mod = await import(
      /* webpackIgnore: true */ "../../engines/planning/planTemplates.js"
    ).catch(() => null);
    return mod || {};
  } catch (e) {
    return {};
  }
}
async function safePrepConsolidation() {
  try {
    const mod = await import(
      /* webpackIgnore: true */ "../../engines/planning/prepConsolidationEngine.js"
    ).catch(() => null);
    return mod || {};
  } catch (e) {
    return {};
  }
}
async function safeAnimalExecutor() {
  try {
    const mod = await import(
      /* webpackIgnore: true */ "../../adapters/execution/animalExecutor.js"
    ).catch(() => null);
    return mod || {};
  } catch (e) {
    return {};
  }
}

// ---------- Local utils ----------
const LS_KEY = "barn.planner.draft.v2"; // bumped version to preserve prior drafts
function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

// Simple default species feed norms (override with estimateEngine if available)
const FEED_BASELINES = {
  sheep: { feedKgPerDay: 2.2 * 0.02, beddingLbPerWeek: 3 }, // ~2% BW placeholder
  goat: { feedKgPerDay: 2.2 * 0.02, beddingLbPerWeek: 3 },
  cow: { feedKgPerDay: 2.2 * 0.03, beddingLbPerWeek: 8 },
  chicken: { feedKgPerDay: 0.12, beddingLbPerWeek: 0.5 },
};

const STATUS_COLORS = {
  empty: "bg-white",
  occupied: "bg-lime-50",
  quarantine: "bg-amber-50",
  cleaning: "bg-sky-50",
};

const DEFAULT_GRID = { rows: 3, cols: 4 };

// ---------- UI atoms ----------
function SectionCard({ title, actions, children }) {
  return (
    <div className="rounded-2xl border bg-white shadow-sm p-4 md:p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">{title}</h3>
        <div className="flex gap-2">{actions}</div>
      </div>
      {children}
    </div>
  );
}
function Field({ label, hint, children }) {
  return (
    <label className="block mb-3">
      <div className="text-xs uppercase tracking-wide mb-1 flex items-center gap-2">
        <span>{label}</span>
        {hint ? (
          <span className="text-[10px] text-gray-500">• {hint}</span>
        ) : null}
      </div>
      {children}
    </label>
  );
}
function Chip({ children, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
      {children}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="opacity-70 hover:opacity-100"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}
function Toast({ toast, onUndo, onClose }) {
  if (!toast) return null;
  return (
    <div className="fixed bottom-4 right-4 max-w-sm rounded-xl bg-black text-white p-4 shadow-lg flex items-start gap-3 z-50">
      <div className="text-sm flex-1">
        <strong className="block">{toast.title}</strong>
        <span className="opacity-90">{toast.message}</span>
      </div>
      {toast.canUndo ? (
        <button
          className="underline text-sm mr-2"
          onClick={() => onUndo?.(toast)}
        >
          Undo
        </button>
      ) : null}
      <button
        className="opacity-80 hover:opacity-100"
        aria-label="close"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}

// ---------- Main ----------
export default function BarnPlannerShell() {
  const eventBus = useSafeEventBus();
  const invokeNBA = useSafeNBA();

  // planner state
  const draft = loadDraft();
  const [tab, setTab] = useState("layout"); // layout | assign | chores | simulate | preview
  const [grid, setGrid] = useState(draft?.grid || { ...DEFAULT_GRID });
  const [cells, setCells] = useState(draft?.cells || seedCells(DEFAULT_GRID));
  const [zones, setZones] = useState(draft?.zones || ["North", "South"]);
  const [sabbathGuard, setSabbathGuard] = useState(draft?.sabbathGuard ?? true);

  // NEW: Global loss settings (defaults can be tuned)
  const [loss, setLoss] = useState(
    draft?.loss || { feedPct: 7, beddingPct: 10 }
  );

  // quick search / filters
  const [q, setQ] = useState("");
  const [toast, setToast] = useState(null);
  const lastChangeRef = useRef(null);

  // derived
  const filteredCells = useMemo(() => {
    if (!q) return cells;
    const f = q.toLowerCase();
    return cells.map((c) =>
      c.name?.toLowerCase().includes(f) ||
      (c.assigned || []).some((a) =>
        (a.name || a.id || "").toLowerCase().includes(f)
      ) ||
      c.zone?.toLowerCase().includes(f)
        ? c
        : { ...c, hidden: true }
    );
  }, [q, cells]);

  // autosave
  useEffect(() => {
    try {
      const payload = { grid, cells, zones, sabbathGuard, loss };
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
    } catch {}
  }, [grid, cells, zones, sabbathGuard, loss]);

  // actions
  const setGridSize = useCallback((rows, cols) => {
    setGrid({ rows, cols });
    setCells((prev) => resizeCells(prev, rows, cols));
    raiseToast("Grid updated", `${rows} × ${cols} layout applied.`, true);
  }, []);

  const updateCell = useCallback((id, patch) => {
    setCells((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    lastChangeRef.current = { id, patch };
  }, []);

  const assignAnimal = useCallback((cellId, animal) => {
    setCells((prev) =>
      prev.map((c) => {
        if (c.id !== cellId) return c;
        const next = new Set([
          ...(c.assigned || []).map((a) => a.id),
          animal.id,
        ]);
        const list = (c.assigned || [])
          .filter((a) => a.id !== animal.id)
          .concat([animal]);
        return {
          ...c,
          assigned: list.filter(
            (a, i) =>
              next.has(a.id) && i === list.findIndex((x) => x.id === a.id)
          ),
        };
      })
    );
  }, []);

  const unassignAnimal = useCallback((cellId, animalId) => {
    setCells((prev) =>
      prev.map((c) => {
        if (c.id !== cellId) return c;
        return {
          ...c,
          assigned: (c.assigned || []).filter((a) => a.id !== animalId),
        };
      })
    );
  }, []);

  const clearAssignments = useCallback(() => {
    if (!confirm("Clear all animal assignments?")) return;
    setCells((prev) => prev.map((c) => ({ ...c, assigned: [] })));
    raiseToast("Cleared", "All stall assignments removed.", false);
  }, []);

  const addZone = useCallback(
    () => setZones((z) => [...z, `Zone ${z.length + 1}`]),
    []
  );
  const removeZone = useCallback((name) => {
    setZones((z) => z.filter((x) => x !== name));
    setCells((prev) =>
      prev.map((c) => (c.zone === name ? { ...c, zone: "" } : c))
    );
  }, []);

  const sendTo = useCallback(
    async (target) => {
      const sched = await safeScheduleHelpers();
      const prep = await safePrepConsolidation();
      const allSessions = buildSessions(cells, sabbathGuard, sched);
      const consolidated = prep?.consolidate
        ? prep.consolidate(allSessions, { domain: "animals" })
        : allSessions;

      eventBus.emit("export.requested", {
        kind: "barn-plan",
        target,
        grid,
        cells,
        zones,
        sessions: consolidated,
        sabbathGuard,
        loss,
        at: Date.now(),
      });

      raiseToast("Sent", `Plan exported to ${target}.`, true);

      try {
        invokeNBA?.({
          reason: "barn_plan_export",
          context: {
            target,
            stalls: cells.length,
            sessions: consolidated.length,
          },
        });
      } catch (e) {}
    },
    [cells, zones, grid, sabbathGuard, loss, eventBus, invokeNBA]
  );

  // ---- Estimates (with loss) ----
  const [estimates, setEstimates] = useState({
    base: { feedKgPerDay: 0, beddingLbPerWeek: 0 },
    final: { feedKgPerDay: 0, beddingLbPerWeek: 0 },
  });

  const estimateNeeds = useCallback(async () => {
    const est = await safeEstimateEngine();

    // Base totals without loss
    const base = cells.reduce(
      (acc, c) => {
        const assigned = c.assigned || [];
        assigned.forEach((a) => {
          const key = (a.species || "").toLowerCase();
          const baseLine = FEED_BASELINES[key] || FEED_BASELINES.sheep;
          const feedKg = est?.estimateAnimalFeedKgPerDay
            ? est.estimateAnimalFeedKgPerDay(a)
            : baseLine.feedKgPerDay;
          const beddingLb = est?.estimateBeddingLbPerWeek
            ? est.estimateBeddingLbPerWeek(a)
            : baseLine.beddingLbPerWeek;
          acc.feedKgPerDay += feedKg || 0;
          acc.beddingLbPerWeek += beddingLb || 0;
        });
        return acc;
      },
      { feedKgPerDay: 0, beddingLbPerWeek: 0 }
    );

    // Apply loss: cell-level override (feedLossPct/beddingLossPct) falls back to global loss
    const withLoss = cells.reduce(
      (acc, c) => {
        const stallFeedLossPct = pctNum(c.feedLossPct, loss.feedPct);
        const stallBeddingLossPct = pctNum(c.beddingLossPct, loss.beddingPct);
        const assigned = c.assigned || [];

        // compute base for this stall again (could micro-optimize, kept explicit for clarity)
        let stallFeed = 0;
        let stallBedding = 0;
        assigned.forEach((a) => {
          const key = (a.species || "").toLowerCase();
          const baseLine = FEED_BASELINES[key] || FEED_BASELINES.sheep;
          const feedKg = est?.estimateAnimalFeedKgPerDay
            ? est.estimateAnimalFeedKgPerDay(a)
            : baseLine.feedKgPerDay;
          const beddingLb = est?.estimateBeddingLbPerWeek
            ? est.estimateBeddingLbPerWeek(a)
            : baseLine.beddingLbPerWeek;
          stallFeed += feedKg || 0;
          stallBedding += beddingLb || 0;
        });

        acc.feedKgPerDay += stallFeed * (1 + stallFeedLossPct / 100);
        acc.beddingLbPerWeek += stallBedding * (1 + stallBeddingLossPct / 100);
        return acc;
      },
      { feedKgPerDay: 0, beddingLbPerWeek: 0 }
    );

    return { base, final: withLoss };
  }, [cells, loss]);

  useEffect(() => {
    (async () => setEstimates(await estimateNeeds()))();
  }, [estimateNeeds]);

  const [previewRunbooks, setPreviewRunbooks] = useState([]);
  const buildRunbooks = useCallback(async () => {
    const exec = await safeAnimalExecutor();
    const toRunbook = exec?.toRunbook;
    const basic = (task) => ({
      id: uid("rb"),
      title: task.title,
      kind: task.kind || "care",
      estMinutes: task.estMinutes || 10,
      flags: task.flags || [],
      ppe: task.ppe || ["gloves"],
      sanitize: true,
      feed: task.feed,
      chillChain: task.chillChain,
    });

    const all = [];
    cells.forEach((c) => {
      (c.assigned || []).forEach((a) => {
        const task = {
          title: `Care: ${a.name || a.id} @ ${c.name}`,
          kind: a.status === "butcher-queued" ? "butchery" : "care",
          estMinutes: a.status === "butcher-queued" ? 120 : 10,
          flags: a.status === "butcher-queued" ? ["raw-meat", "biohazard"] : [],
          ppe:
            a.status === "butcher-queued"
              ? ["gloves", "apron", "face shield"]
              : ["gloves"],
          chillChain:
            a.status === "butcher-queued" ? { maxMinutesOut: 20 } : undefined,
          feed:
            a.status !== "butcher-queued"
              ? {
                  items: [{ name: "ration", amount: "per plan" }],
                  waterCheck: true,
                }
              : undefined,
        };
        all.push(toRunbook ? toRunbook(task) : basic(task));
      });
    });
    setPreviewRunbooks(await Promise.all(all));
    setTab("preview");
  }, [cells]);

  // undo toast
  const raiseToast = (title, message, canUndo) =>
    setToast({ id: uid("t"), title, message, canUndo });
  const dismissToast = () => setToast(null);
  const undoLast = () => {
    const last = lastChangeRef.current;
    if (!last) return dismissToast();
    const { id, patch } = last;
    setCells((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        const reverted = Object.keys(patch).reduce((acc, k) => {
          acc[k] = undefined;
          return acc;
        }, {});
        return { ...c, ...reverted };
      })
    );
    dismissToast();
  };

  // --------- Render ---------
  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <header className="mb-4 md:mb-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl md:text-2xl font-semibold">
            Barn Planner — Layout • Assign • Chores
          </h1>
          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-2 text-sm border rounded-lg px-3 py-1.5">
              <input
                type="checkbox"
                checked={sabbathGuard}
                onChange={(e) => setSabbathGuard(e.target.checked)}
              />
              Sabbath Guard
            </label>
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={() => sendTo("Task Board")}
            >
              Send → Task Board
            </button>
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={() => sendTo("Calendar")}
            >
              Send → Calendar
            </button>
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={() => sendTo("Inventory")}
            >
              Send → Inventory
            </button>
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={() => window.print()}
            >
              Print Stall Cards
            </button>
          </div>
        </div>

        <nav className="mt-4 flex gap-2">
          {[
            { k: "layout", t: "Layout" },
            { k: "assign", t: "Assign" },
            { k: "chores", t: "Chores" },
            { k: "simulate", t: "Simulate" },
            { k: "preview", t: "Runbook Preview" },
          ].map((x) => (
            <button
              key={x.k}
              onClick={() => setTab(x.k)}
              className={`px-3 py-1.5 rounded-lg text-sm border ${
                tab === x.k
                  ? "bg-black text-white border-black"
                  : "hover:bg-gray-50"
              }`}
            >
              {x.t}
            </button>
          ))}
          <div className="ml-auto">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter stalls/animals…"
              className="px-3 py-1.5 text-sm rounded-lg border w-56"
            />
          </div>
        </nav>
      </header>

      {/* Layout */}
      {tab === "layout" && (
        <div className="grid lg:grid-cols-3 gap-4">
          <SectionCard
            title="Grid & Zones"
            actions={
              <>
                <button
                  className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
                  onClick={() => setGridSize(grid.rows + 1, grid.cols)}
                >
                  + Row
                </button>
                <button
                  className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
                  onClick={() =>
                    setGridSize(Math.max(1, grid.rows - 1), grid.cols)
                  }
                >
                  − Row
                </button>
                <button
                  className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
                  onClick={() => setGridSize(grid.rows, grid.cols + 1)}
                >
                  + Col
                </button>
                <button
                  className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
                  onClick={() =>
                    setGridSize(grid.rows, Math.max(1, grid.cols - 1))
                  }
                >
                  − Col
                </button>
              </>
            }
          >
            <div className="mb-4 text-sm text-gray-600">
              Click a cell to rename, set zone/aisle, mark status, or edit loss
              overrides in Chores.
            </div>
            <BarnGrid
              grid={grid}
              cells={filteredCells}
              onUpdate={updateCell}
              zones={zones}
            />
          </SectionCard>

          <SectionCard
            title="Zones / Aisles"
            actions={
              <button
                className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
                onClick={addZone}
              >
                + Zone
              </button>
            }
          >
            <div className="flex flex-wrap gap-2">
              {zones.map((z) => (
                <Chip key={z} onRemove={() => removeZone(z)}>
                  {z}
                </Chip>
              ))}
            </div>
            <div className="mt-3 text-xs text-gray-600">
              Assign zones on cells to group chores and feed runs.
            </div>
          </SectionCard>

          <SectionCard title="Daily Needs (Estimates with Loss)">
            <LossControls
              loss={loss}
              onChange={(next) => setLoss((prev) => ({ ...prev, ...next }))}
            />
            <EstimateBlock estimates={estimates} />
          </SectionCard>
        </div>
      )}

      {/* Assign */}
      {tab === "assign" && (
        <SectionCard
          title="Assign Animals to Stalls"
          actions={
            <>
              <button
                className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
                onClick={() => setTab("chores")}
              >
                Next → Chores
              </button>
              <button
                className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
                onClick={clearAssignments}
              >
                Clear Assignments
              </button>
            </>
          }
        >
          <AssignPanel
            cells={filteredCells}
            onAssign={assignAnimal}
            onUnassign={unassignAnimal}
            onUpdate={updateCell}
          />
        </SectionCard>
      )}

      {/* Chores */}
      {tab === "chores" && (
        <SectionCard
          title="Chore Rotations & Tasks (with Loss Overrides)"
          actions={
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={() => setTab("simulate")}
            >
              Next → Simulate
            </button>
          }
        >
          <ChoresPanel
            cells={filteredCells}
            onUpdate={updateCell}
            sabbathGuard={sabbathGuard}
            loss={loss}
          />
        </SectionCard>
      )}

      {/* Simulate */}
      {tab === "simulate" && (
        <SectionCard
          title="Simulate Sessions"
          actions={
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={buildRunbooks}
            >
              Build Runbooks
            </button>
          }
        >
          <SimulatePanel cells={filteredCells} />
        </SectionCard>
      )}

      {/* Preview */}
      {tab === "preview" && (
        <SectionCard
          title="Runbook Preview"
          actions={
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={() => sendTo("Task Board")}
            >
              Send Runbooks → Task Board
            </button>
          }
        >
          <RunbooksList runbooks={previewRunbooks} />
        </SectionCard>
      )}

      <Toast toast={toast} onUndo={undoLast} onClose={dismissToast} />
    </div>
  );
}

// ---------- Subcomponents ----------
function BarnGrid({ grid, cells, zones, onUpdate }) {
  const getCell = (r, c) =>
    cells.find((x) => x.r === r && x.c === c) || {
      id: "",
      name: "",
      status: "empty",
      r,
      c,
      zone: "",
    };
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: grid.rows }).map((_, r) =>
        Array.from({ length: grid.cols }).map((__, c) => {
          const cell = getCell(r, c);
          if (cell.hidden) return <div key={`${r}-${c}`} />;
          const statusClass = STATUS_COLORS[cell.status] || "bg-white";
          return (
            <button
              key={cell.id || `${r}-${c}`}
              className={`rounded-xl border p-3 text-left ${statusClass} hover:ring-2 hover:ring-black/10`}
              onClick={() => {
                const name =
                  prompt(
                    "Stall name/label",
                    cell.name || `Stall ${r + 1}-${c + 1}`
                  ) ?? cell.name;
                const zone =
                  prompt("Zone/Aisle (or blank)", cell.zone || "") ?? cell.zone;
                const status =
                  prompt(
                    "Status: empty | occupied | quarantine | cleaning",
                    cell.status || "empty"
                  ) ?? cell.status;
                onUpdate(cell.id, { name, zone, status });
              }}
            >
              <div className="font-medium">
                {cell.name || `Stall ${r + 1}-${c + 1}`}
              </div>
              <div className="text-xs text-gray-600">{cell.zone || "—"}</div>
              <div className="mt-1 text-[11px]">
                {(cell.assigned || []).slice(0, 3).map((a) => (
                  <div key={a.id} className="truncate">
                    • {a.name || a.id}
                    {a.species ? ` (${a.species})` : ""}
                  </div>
                ))}
                {(cell.assigned || []).length > 3 ? (
                  <div className="opacity-70">
                    +{(cell.assigned || []).length - 3} more
                  </div>
                ) : null}
              </div>
            </button>
          );
        })
      )}
    </div>
  );
}

function AssignPanel({ cells, onAssign, onUnassign, onUpdate }) {
  return (
    <div className="grid md:grid-cols-2 gap-4">
      {cells.map((c) =>
        c.hidden ? null : (
          <div key={c.id} className="rounded-xl border p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="font-semibold">
                {c.name || `Stall ${c.r + 1}-${c.c + 1}`}
              </div>
              <button
                className="text-xs rounded-lg border px-2 py-1 hover:bg-gray-50"
                onClick={() => onUpdate(c.id, { assigned: [] })}
              >
                Clear
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Add animal by CSV"
                hint='id,name,species,status (ex: "a1,Daisy,sheep,active")'
              >
                <input
                  className="w-full border rounded-md px-2 py-1"
                  placeholder="a1,Daisy,sheep,active"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.currentTarget.value.trim()) {
                      const [id, name, species, status] = e.currentTarget.value
                        .split(",")
                        .map((s) => s?.trim());
                      onAssign(c.id, {
                        id: id || uid("animal"),
                        name,
                        species,
                        status: status || "active",
                      });
                      e.currentTarget.value = "";
                    }
                  }}
                />
              </Field>
              <Field label="Mark status">
                <select
                  className="w-full border rounded-md px-2 py-1"
                  value={c.status}
                  onChange={(e) => onUpdate(c.id, { status: e.target.value })}
                >
                  {["empty", "occupied", "quarantine", "cleaning"].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="mt-2 flex flex-wrap gap-2">
              {(c.assigned || []).map((a) => (
                <Chip key={a.id} onRemove={() => onUnassign(c.id, a.id)}>
                  {a.name || a.id}
                  {a.species ? ` • ${a.species}` : ""}
                  {a.status ? ` • ${a.status}` : ""}
                </Chip>
              ))}
            </div>
          </div>
        )
      )}
    </div>
  );
}

function ChoresPanel({ cells, onUpdate, sabbathGuard, loss }) {
  return (
    <div className="grid md:grid-cols-2 gap-4">
      {cells.map((c) =>
        c.hidden ? null : (
          <div key={c.id} className="rounded-xl border p-4">
            <div className="font-semibold mb-2">
              {c.name || `Stall ${c.r + 1}-${c.c + 1}`}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Feed (times/day)">
                <input
                  type="number"
                  min="0"
                  className="w-full border rounded-md px-2 py-1"
                  value={numOr(c.feedPerDay, 1)}
                  onChange={(e) =>
                    onUpdate(c.id, {
                      feedPerDay: clampNum(e.target.value, 0, 6),
                    })
                  }
                />
              </Field>
              <Field label="Water check (times/day)">
                <input
                  type="number"
                  min="0"
                  className="w-full border rounded-md px-2 py-1"
                  value={numOr(c.waterChecks, 2)}
                  onChange={(e) =>
                    onUpdate(c.id, {
                      waterChecks: clampNum(e.target.value, 0, 12),
                    })
                  }
                />
              </Field>
              <Field label="Bedding (lb/week)">
                <input
                  type="number"
                  min="0"
                  className="w-full border rounded-md px-2 py-1"
                  value={numOr(c.beddingLbPerWeek, 0)}
                  onChange={(e) =>
                    onUpdate(c.id, {
                      beddingLbPerWeek: clampNum(e.target.value, 0, 500),
                    })
                  }
                />
              </Field>
              <Field label="Muck-out day">
                <select
                  className="w-full border rounded-md px-2 py-1"
                  value={c.muckDay || "Wed"}
                  onChange={(e) => onUpdate(c.id, { muckDay: e.target.value })}
                >
                  {["Mon", "Tue", "Wed", "Thu", "Fri", "Sun"].map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </Field>

              {/* NEW: per-stall loss overrides */}
              <Field
                label="Feed loss %"
                hint={`Global default ${loss.feedPct}%`}
              >
                <input
                  type="number"
                  min="0"
                  className="w-full border rounded-md px-2 py-1"
                  value={numOr(c.feedLossPct, "")}
                  onChange={(e) =>
                    onUpdate(c.id, { feedLossPct: cleanPct(e.target.value) })
                  }
                  placeholder={`${loss.feedPct}`}
                />
              </Field>
              <Field
                label="Bedding loss %"
                hint={`Global default ${loss.beddingPct}%`}
              >
                <input
                  type="number"
                  min="0"
                  className="w-full border rounded-md px-2 py-1"
                  value={numOr(c.beddingLossPct, "")}
                  onChange={(e) =>
                    onUpdate(c.id, { beddingLossPct: cleanPct(e.target.value) })
                  }
                  placeholder={`${loss.beddingPct}`}
                />
              </Field>
            </div>

            <div className="mt-2 text-xs text-gray-700">
              Rotation hint: {nextRotation(new Date().getDay())}
              {sabbathGuard
                ? " • Sabbath Guard active (no new sessions Fri eve–Sat eve)"
                : ""}
            </div>
          </div>
        )
      )}
    </div>
  );
}

function SimulatePanel({ cells }) {
  const sessions = useMemo(() => {
    const out = [];
    cells.forEach((c) => {
      if (c.hidden) return;
      const feed = Math.max(0, Number(c.feedPerDay ?? 1));
      const water = Math.max(0, Number(c.waterChecks ?? 2));
      for (let i = 0; i < feed; i++)
        out.push({
          id: uid("sess"),
          kind: "feed",
          stall: c.name,
          zone: c.zone,
        });
      for (let i = 0; i < water; i++)
        out.push({
          id: uid("sess"),
          kind: "water",
          stall: c.name,
          zone: c.zone,
        });
      if (c.muckDay)
        out.push({
          id: uid("sess"),
          kind: "muck",
          stall: c.name,
          zone: c.zone,
          day: c.muckDay,
        });
    });
    return out;
  }, [cells]);

  const grouped = useMemo(() => {
    const by = {};
    sessions.forEach((s) => {
      const k = `${s.kind}:${s.zone || "-"}`;
      by[k] = by[k] || [];
      by[k].push(s);
    });
    return by;
  }, [sessions]);

  return (
    <div>
      <div className="text-sm text-gray-600 mb-2">
        Auto-grouped sessions (for consolidation): feed/water per zone, and
        weekly muck-outs.
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        {Object.keys(grouped).map((k) => (
          <div key={k} className="rounded-xl border p-4">
            <div className="font-semibold mb-1">{k}</div>
            <div className="text-xs text-gray-700">
              {grouped[k].length} tasks
            </div>
            <ul className="mt-2 text-sm list-disc ml-5">
              {grouped[k].slice(0, 8).map((s) => (
                <li key={s.id}>
                  {s.kind} @ {s.stall} {s.day ? `• ${s.day}` : ""}
                </li>
              ))}
              {grouped[k].length > 8 ? (
                <li className="opacity-70">…and more</li>
              ) : null}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function RunbooksList({ runbooks }) {
  if (!runbooks?.length) {
    return (
      <div className="border-2 border-dashed rounded-2xl p-8 text-center">
        <h4 className="font-semibold mb-1">No runbooks yet</h4>
        <p className="text-sm text-gray-600">
          Use “Build Runbooks” in Simulate to generate care/butchery steps.
        </p>
      </div>
    );
  }
  return (
    <div className="grid md:grid-cols-2 gap-4">
      {runbooks.map((rb) => (
        <div key={rb.id} className="rounded-xl border p-4">
          <div className="text-sm uppercase tracking-wide text-gray-600 mb-1">
            {rb.kind}
          </div>
          <div className="font-semibold mb-2">{rb.title}</div>
          <div className="text-sm mb-2">Est. {rb.estMinutes} min</div>
          {rb.flags?.length ? (
            <div className="mb-2 flex flex-wrap gap-1">
              {rb.flags.map((f) => (
                <Chip key={f}>{f}</Chip>
              ))}
            </div>
          ) : null}
          {rb.ppe?.length ? (
            <div className="text-xs text-gray-700 mb-2">
              PPE: {rb.ppe.join(", ")}
            </div>
          ) : null}
          {rb.feed ? (
            <div className="text-xs text-gray-700">
              Feed: water check {rb.feed.waterCheck ? "✓" : "—"}
            </div>
          ) : null}
          {rb.chillChain ? (
            <div className="text-xs text-gray-700">
              Chill-chain: max {rb.chillChain.maxMinutesOut} min out
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function LossControls({ loss, onChange }) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-3">
      <Field label="Feed loss %" hint="Accounting for spillage/pest/weather">
        <input
          type="number"
          min="0"
          className="w-full border rounded-md px-2 py-1"
          value={numOr(loss.feedPct, 0)}
          onChange={(e) => onChange({ feedPct: cleanPct(e.target.value) })}
        />
      </Field>
      <Field label="Bedding loss %" hint="Waste, breakage, unusable portions">
        <input
          type="number"
          min="0"
          className="w-full border rounded-md px-2 py-1"
          value={numOr(loss.beddingPct, 0)}
          onChange={(e) => onChange({ beddingPct: cleanPct(e.target.value) })}
        />
      </Field>
    </div>
  );
}

function EstimateBlock({ estimates }) {
  const kg = (n) => Number(n || 0).toFixed(2);
  const lb = (n) => Number(n || 0).toFixed(1);
  const base = estimates.base || { feedKgPerDay: 0, beddingLbPerWeek: 0 };
  const final = estimates.final || { feedKgPerDay: 0, beddingLbPerWeek: 0 };
  const addFeed = Math.max(
    0,
    (final.feedKgPerDay || 0) - (base.feedKgPerDay || 0)
  );
  const addBed = Math.max(
    0,
    (final.beddingLbPerWeek || 0) - (base.beddingLbPerWeek || 0)
  );

  return (
    <div className="text-sm">
      <div className="flex items-center justify-between">
        <span>Feed (kg/day) — base</span>
        <span>{kg(base.feedKgPerDay)}</span>
      </div>
      <div className="flex items-center justify-between">
        <span>+ Loss adjustment</span>
        <span>{kg(addFeed)}</span>
      </div>
      <div className="flex items-center justify-between font-semibold mb-3">
        <span>Feed (kg/day) — final</span>
        <span>{kg(final.feedKgPerDay)}</span>
      </div>

      <div className="flex items-center justify-between">
        <span>Bedding (lb/week) — base</span>
        <span>{lb(base.beddingLbPerWeek)}</span>
      </div>
      <div className="flex items-center justify-between">
        <span>+ Loss adjustment</span>
        <span>{lb(addBed)}</span>
      </div>
      <div className="flex items-center justify-between font-semibold">
        <span>Bedding (lb/week) — final</span>
        <span>{lb(final.beddingLbPerWeek)}</span>
      </div>

      <div className="text-xs text-gray-600 mt-3">
        Estimates use your engine if available; otherwise fallback species
        baselines. Final totals include loss.
      </div>
    </div>
  );
}

// ---------- helpers ----------
function seedCells({ rows, cols }) {
  const list = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      list.push({
        id: uid("stall"),
        r,
        c,
        name: `Stall ${r + 1}-${c + 1}`,
        zone: "",
        status: "empty",
        assigned: [],
        feedPerDay: 1,
        waterChecks: 2,
        beddingLbPerWeek: 0,
        muckDay: "Wed",
        // NEW: optional per-stall loss overrides (undefined = use global)
        feedLossPct: undefined,
        beddingLossPct: undefined,
      });
    }
  }
  return list;
}
function resizeCells(prev, rows, cols) {
  const next = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const exists = prev.find((x) => x.r === r && x.c === c);
      next.push(
        exists || {
          ...defaultCell(),
          r,
          c,
          name: `Stall ${r + 1}-${c + 1}`,
        }
      );
    }
  }
  return next;
}
function defaultCell() {
  return {
    id: uid("stall"),
    r: 0,
    c: 0,
    name: "",
    zone: "",
    status: "empty",
    assigned: [],
    feedPerDay: 1,
    waterChecks: 2,
    beddingLbPerWeek: 0,
    muckDay: "Wed",
    feedLossPct: undefined,
    beddingLossPct: undefined,
  };
}
function loadDraft() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function clampNum(v, min, max) {
  const n = Number(v);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}
function numOr(v, fallback) {
  return v === undefined || v === null || v === "" ? fallback : v;
}
function cleanPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(1000, n); // generous upper cap for edge cases
}
function pctNum(maybe, fallback) {
  const n = Number(maybe);
  return Number.isFinite(n) ? n : Number(fallback || 0);
}
function nextRotation(dayIndex) {
  return dayIndex % 2 === 0 ? "Group A" : "Group B";
}

// Build session list honoring Sabbath Guard (simple: skip Sat sessions)
function buildSessions(cells, sabbathGuard, schedHelpers) {
  const today = new Date();
  const isSat = today.getDay() === 6; // Saturday
  const sessions = [];
  cells.forEach((c) => {
    if (!c || c.hidden) return;
    const add = (kind, times = 1) => {
      for (let i = 0; i < times; i++) {
        sessions.push({ id: uid("sess"), kind, stall: c.name, zone: c.zone });
      }
    };
    if (!(sabbathGuard && isSat)) {
      add("feed", Math.max(0, Number(c.feedPerDay ?? 1)));
      add("water", Math.max(0, Number(c.waterChecks ?? 2)));
    }
    const helper = schedHelpers?.mkDateForWeekday;
    const nextMuckDate = helper ? helper(c.muckDay || "Wed") : null;
    sessions.push({
      id: uid("sess"),
      kind: "muck",
      stall: c.name,
      zone: c.zone,
      when: nextMuckDate || c.muckDay || "Wed",
    });
  });
  return sessions;
}
