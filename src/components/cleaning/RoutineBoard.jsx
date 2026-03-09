// src/components/cleaning/RoutineBoard.jsx
// Suka – Cleaning / Routine Board
// - Shows user's saved routines (entry/exit flows, zone routines, deep-focus sets)
// - "Suggestions" powered by organizingStrategies.suggestStrategies(context)
// - One-click "Generate Routine" -> creates ad-hoc plan via CleaningPlanManager
// - Schedules cadence items with calendar RRULEs (deepCleanCadenceToRRULE)
// - Sabbath-aware guardrails; Undo/Redo for local changes
// - Emits UI + Navigation events (e.g., open EntryExitFlowDesigner, LiveCleaningSession)

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles,
  CalendarPlus,
  CalendarDays,
  Filter,
  Plus,
  Play,
  Save,
  Edit3,
  Trash2,
  Copy,
  Search,
  RefreshCcw,
  Undo2,
  Redo2,
  Shield,
  DoorOpen,
  Inbox,
  Leaf,
  BadgeCheck,
  Info,
} from "lucide-react";

/* ------------------------------ Defensive imports ------------------------------ */
let eventBus = { emit: () => {}, on: () => () => {} };
let automation = { queue: () => {}, invoke: async () => {} };
let CleaningPlanManager = null;
let deepCleanCadenceToRRULE = (x) =>
  "RRULE:FREQ=YEARLY;BYHOUR=9;BYMINUTE=0;BYSECOND=0";
let getStrategies = () => [];
let suggestStrategies = () => [];
let PreferencesStore = {
  getState: () => ({ timezone: "America/New_York", sabbathAware: true }),
};

(async () => {
  try {
    ({ eventBus } = await import("@/services/events/eventBus"));
  } catch {}
  try {
    ({ automation } = await import("@/services/automation/runtime"));
  } catch {}
  try {
    ({ default: CleaningPlanManager } = await import(
      "@/managers/CleaningPlanManager"
    ));
  } catch {}
  try {
    const s = await import("@/data/organizingStrategies");
    deepCleanCadenceToRRULE =
      s?.deepCleanCadenceToRRULE || deepCleanCadenceToRRULE;
    getStrategies = s?.getStrategies || getStrategies;
    suggestStrategies = s?.suggestStrategies || suggestStrategies;
  } catch {}
  try {
    const p = await import("@/store/PreferencesStore");
    PreferencesStore = p?.usePreferencesStore || PreferencesStore;
  } catch {}
})();

/* --------------------------------- Utilities --------------------------------- */
const TZ = () => {
  try {
    return PreferencesStore.getState()?.timezone || "America/New_York";
  } catch {
    return "America/New_York";
  }
};
const SABBATH_AWARE = () => {
  try {
    return !!PreferencesStore.getState()?.sabbathAware;
  } catch {
    return true;
  }
};
const isSabbathApprox = (
  d = new Date(),
  tz = "America/New_York",
  aware = true
) => {
  if (!aware) return false;
  const dow = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: tz,
  }).format(d);
  return dow === "Sat";
};
const uid = () =>
  crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* ------------------------------ Local persistence ----------------------------- */
const LKEY = "suka:routines:v1";
function readRoutines() {
  try {
    const raw = localStorage.getItem(LKEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function writeRoutines(xs) {
  try {
    localStorage.setItem(LKEY, JSON.stringify(xs || []));
  } catch {}
}

/* ------------------------------- Undo/Redo Hook ------------------------------- */
function useHistoryState(initial) {
  const [stack, setStack] = useState([initial]);
  const [i, setI] = useState(0);
  const value = stack[i];
  const canUndo = i > 0;
  const canRedo = i < stack.length - 1;
  const set = (next) => {
    const arr = stack.slice(0, i + 1).concat([next]);
    setStack(arr);
    setI(arr.length - 1);
  };
  const undo = () => canUndo && setI(i - 1);
  const redo = () => canRedo && setI(i + 1);
  return { value, set, undo, redo, canUndo, canRedo };
}

/* --------------------------------- Component --------------------------------- */
export default function RoutineBoard() {
  const tz = useMemo(() => TZ(), []);
  const sabbathAware = useMemo(() => SABBATH_AWARE(), []);
  const sabbathActive = isSabbathApprox(new Date(), tz, sabbathAware);

  const history = useHistoryState(readRoutines());
  const routines = history.value;

  const [tab, setTab] = useState("mine"); // mine | suggestions
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState({ cadence: "all", tag: "all" });
  const [busy, setBusy] = useState(false);

  // prefetch suggestions
  const suggestions = useMemo(() => suggestStrategies({}), [routines.length]);

  // persist whenever history changes
  useEffect(() => {
    writeRoutines(routines);
  }, [routines]);

  // listen to external plan creation to show success
  useEffect(() => {
    const off = eventBus.on("cleaning:plan:created", ({ planId, source }) => {
      if (!planId) return;
      eventBus.emit("ui:toast", {
        type: "success",
        message: "Routine created. Open Live Session to start.",
      });
    });
    return () => off();
  }, []);

  /* ----------------------------- Derived collections ----------------------------- */
  const filteredMine = useMemo(() => {
    const q = query.trim().toLowerCase();
    return routines.filter((r) => {
      const matchesQ =
        !q ||
        r.name?.toLowerCase?.().includes(q) ||
        (r.tags || []).join(", ").toLowerCase().includes(q);
      const matchesCad =
        filters.cadence === "all" || (r.cadence || "none") === filters.cadence;
      const matchesTag =
        filters.tag === "all" || (r.tags || []).includes(filters.tag);
      return matchesQ && matchesCad && matchesTag;
    });
  }, [routines, query, filters]);

  /* --------------------------------- Actions --------------------------------- */
  const createBlankRoutine = () => {
    const draft = {
      id: uid(),
      name: "New Routine",
      tz,
      sabbathAware,
      cadence: "none", // for display; steps can have own cadence
      tags: [],
      steps: [],
      createdAt: new Date().toISOString(),
    };
    const next = [...routines, draft];
    history.set(next);
    eventBus.emit("ui:toast", {
      type: "info",
      message: "Blank routine created. Add steps or Edit.",
    });
  };

  const duplicateRoutine = (rid) => {
    const r = routines.find((x) => x.id === rid);
    if (!r) return;
    const dup = {
      ...r,
      id: uid(),
      name: `${r.name} (copy)`,
      createdAt: new Date().toISOString(),
    };
    history.set([...routines, dup]);
    eventBus.emit("ui:toast", {
      type: "success",
      message: "Routine duplicated.",
    });
  };

  const deleteRoutine = (rid) => {
    const prev = routines;
    const next = prev.filter((x) => x.id !== rid);
    history.set(next);
    eventBus.emit("ui:toast:undo", {
      message: "Routine deleted",
      actionLabel: "Undo",
      onAction: () => history.set(prev),
    });
  };

  const saveRoutineMeta = (rid, patch) => {
    const next = routines.map((r) => (r.id === rid ? { ...r, ...patch } : r));
    history.set(next);
  };

  const openDesigner = (rid = null) => {
    // prefer route if available
    eventBus.emit("ui:navigate", {
      to: "/cleaning/entry-exit-flow",
      state: { routineId: rid },
    });
  };

  const startLive = (rid) => {
    const r = routines.find((x) => x.id === rid);
    if (!r) return;
    // Create ad-hoc plan with routine steps
    try {
      const tasks = (r.steps || [])
        .map((s, idx) => ({
          id: s.id || `t-${idx}`,
          title: s.title || `Step ${idx + 1}`,
          area: s.zone || "entry",
          estMinutes: clamp(s.estMinutes || 3, 1, 120),
          priority: 2,
          cadence: s.cadence || null,
          meta: {
            trigger: s.trigger,
            role: s.role,
            sabbathBlocked: s.sabbathBlocked !== false,
            tags: s.tags || [],
          },
        }))
        .filter((t) => !(t.meta?.sabbathBlocked && sabbathActive));

      if (CleaningPlanManager?.createAdhocPlan) {
        const plan = CleaningPlanManager.createAdhocPlan({
          title: r.name || "Routine",
          tasks,
          meta: {
            source: "RoutineBoard",
            routineId: rid,
            createdAt: new Date().toISOString(),
          },
        });
        eventBus.emit("cleaning:plan:created", {
          planId: plan?.id,
          source: "routine-board",
        });
        // Navigate to live session view if registered by the app shell
        eventBus.emit("ui:navigate", { to: "/tier2/household/cleaning/live" });
      } else {
        eventBus.emit("ui:toast", {
          type: "info",
          message: "Live session service not available.",
        });
      }

      // Schedule cadence steps
      tasks
        .filter((t) => !!t.cadence)
        .forEach((t) => {
          const rrule = deepCleanCadenceToRRULE(t.cadence);
          eventBus.emit("calendar:create:rrule", {
            title: `Routine: ${t.title}`,
            area: t.area,
            rrule,
            tz,
            meta: { source: "routine-board", cadence: t.cadence },
          });
        });
    } catch (e) {
      console.error(e);
      eventBus.emit("ui:toast", {
        type: "error",
        message: "Could not start live session.",
      });
    }
  };

  const materializeSuggestion = async (strategyId) => {
    setBusy(true);
    try {
      // soft import to avoid circular
      const mod = await import("@/data/organizingStrategies");
      const res = await mod.materializeStrategy(strategyId, {
        blockOnSabbath: true,
      });
      const steps = (res?.tasks || []).map((t) => ({
        id: t.id || uid(),
        title: t.title,
        zone: t.area || "entry",
        estMinutes: clamp(t.estMinutes || 5, 1, 120),
        trigger: t.meta?.trigger || "onEntry",
        role: t.meta?.role || "household",
        cadence: t.cadence || null,
        sabbathBlocked: t.meta?.sabbathBlocked !== false,
        tags: t.meta?.tags || [],
      }));

      const routine = {
        id: uid(),
        name:
          getStrategies().find((s) => s.id === strategyId)?.name ||
          "Generated Routine",
        tz,
        sabbathAware,
        cadence: "mixed",
        tags: [strategyId],
        steps,
        createdAt: new Date().toISOString(),
      };
      history.set([...routines, routine]);

      // If strategy already scheduled cadences, great; otherwise do it now:
      steps
        .filter((s) => !!s.cadence)
        .forEach((s) => {
          const rrule = deepCleanCadenceToRRULE(s.cadence);
          eventBus.emit("calendar:create:rrule", {
            title: `Routine: ${s.title}`,
            area: s.zone,
            rrule,
            tz,
            meta: { source: "routine-board", cadence: s.cadence },
          });
        });

      eventBus.emit("ui:toast", {
        type: "success",
        message: "Routine generated from suggestion.",
      });
    } catch (e) {
      console.error(e);
      eventBus.emit("ui:toast", {
        type: "error",
        message: "Could not generate from suggestion.",
      });
    } finally {
      setBusy(false);
    }
  };

  /* ----------------------------------- UI ----------------------------------- */

  const Toolbar = () => (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <div className="flex items-center gap-2">
        <button
          className="btn"
          onClick={() => history.undo()}
          disabled={!history.canUndo}
          title="Undo"
        >
          <Undo2 className="w-4 h-4 mr-1" /> Undo
        </button>
        <button
          className="btn"
          onClick={() => history.redo()}
          disabled={!history.canRedo}
          title="Redo"
        >
          <Redo2 className="w-4 h-4 mr-1" /> Redo
        </button>
        <button className="btn" onClick={() => createBlankRoutine()}>
          <Plus className="w-4 h-4 mr-1" /> New Routine
        </button>
        <button
          className="btn"
          onClick={() =>
            eventBus.emit("ui:navigate", { to: "/cleaning/entry-exit-flow" })
          }
        >
          <DoorOpen className="w-4 h-4 mr-1" /> New Entry/Exit Flow
        </button>
      </div>

      <div className="flex items-center gap-2 ml-auto">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2 top-2.5 text-gray-400" />
          <input
            className="pl-8 pr-3 py-2 border rounded-lg"
            placeholder="Search routines…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-500" />
          <select
            className="border rounded-lg px-2 py-2"
            value={filters.cadence}
            onChange={(e) =>
              setFilters((f) => ({ ...f, cadence: e.target.value }))
            }
          >
            <option value="all">All cadences</option>
            <option value="none">No cadence</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="bi-annual">Bi-Annual</option>
            <option value="annual">Annual</option>
          </select>
          <select
            className="border rounded-lg px-2 py-2"
            value={filters.tag}
            onChange={(e) => setFilters((f) => ({ ...f, tag: e.target.value }))}
          >
            <option value="all">All tags</option>
            <option value="bug-shield-perimeter">Bug-Shield</option>
            <option value="paper-inbox-zero">Paper Inbox</option>
            <option value="garden-to-pantry">Garden→Pantry</option>
            <option value="daily-reset">Daily Reset</option>
          </select>
        </div>
      </div>
    </div>
  );

  const Tabs = () => (
    <div className="flex items-center gap-2 mb-3">
      <button
        className={`tab ${tab === "mine" ? "tab-active" : ""}`}
        onClick={() => setTab("mine")}
      >
        My Routines
      </button>
      <button
        className={`tab ${tab === "suggestions" ? "tab-active" : ""}`}
        onClick={() => setTab("suggestions")}
      >
        <Sparkles className="w-4 h-4 mr-1" /> Suggestions
      </button>
      <div className="ml-auto flex items-center gap-2 text-sm text-gray-600">
        <BadgeCheck className="w-4 h-4" />
        Sabbath Guard: {sabbathAware ? "On" : "Off"}
        {sabbathActive && (
          <span className="ml-2 text-amber-600">(active now)</span>
        )}
      </div>
    </div>
  );

  const RoutineCard = ({ r }) => (
    <div className="p-4 border rounded-2xl bg-white flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="font-medium">{r.name}</div>
        <div className="text-xs text-gray-500">
          {new Date(r.createdAt).toLocaleDateString()}
        </div>
      </div>
      <div className="text-sm text-gray-600">
        {(r.tags || []).map((t) => (
          <span
            key={t}
            className="inline-block text-xs px-2 py-1 rounded-full border mr-1 mb-1"
          >
            {t}
          </span>
        ))}
        {!r.tags?.length && (
          <span className="text-xs text-gray-400">No tags</span>
        )}
      </div>
      <div className="text-xs text-gray-500">
        {r.steps?.length || 0} steps
        {r.cadence && r.cadence !== "none" ? ` • ${r.cadence}` : ""}
      </div>

      {/* Quick actions */}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" onClick={() => startLive(r.id)}>
          <Play className="w-4 h-4 mr-1" /> Start Live Session
        </button>
        <button className="btn" onClick={() => openDesigner(r.id)}>
          <Edit3 className="w-4 h-4 mr-1" /> Edit
        </button>
        <button className="btn" onClick={() => duplicateRoutine(r.id)}>
          <Copy className="w-4 h-4 mr-1" /> Duplicate
        </button>
        <button
          className="btn"
          onClick={() => {
            // schedule all cadence steps (if any)
            (r.steps || [])
              .filter((s) => !!s.cadence)
              .forEach((s) => {
                const rrule = deepCleanCadenceToRRULE(s.cadence);
                eventBus.emit("calendar:create:rrule", {
                  title: `Routine: ${s.title}`,
                  area: s.zone || "entry",
                  rrule,
                  tz,
                  meta: { source: "routine-board", cadence: s.cadence },
                });
              });
            eventBus.emit("ui:toast", {
              type: "success",
              message: "Cadence items scheduled.",
            });
          }}
        >
          <CalendarPlus className="w-4 h-4 mr-1" /> Schedule
        </button>
        <button className="btn btn-danger" onClick={() => deleteRoutine(r.id)}>
          <Trash2 className="w-4 h-4 mr-1" /> Delete
        </button>
      </div>
    </div>
  );

  const SuggestionsGrid = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {/* Curated “quick create” suggestion tiles */}
      <SuggestionTile
        icon={<DoorOpen className="w-5 h-5" />}
        title="Daily Entry Reset"
        subtitle="Shoes, keys, mail basket, groceries staging"
        onGenerate={() => materializeSuggestion("daily-reset")}
        cta="Generate Routine"
      />
      <SuggestionTile
        icon={<Shield className="w-5 h-5" />}
        title="Bug-Shield Touchpoints"
        subtitle="Entry gaps, crumb lines, trash seals, traps"
        onGenerate={() => materializeSuggestion("bug-shield-perimeter")}
        cta="Generate Routine"
      />
      <SuggestionTile
        icon={<Inbox className="w-5 h-5" />}
        title="Paper Inbox Bridge"
        subtitle="Mail to basket + pin weekly Inbox Zero"
        onGenerate={() => materializeSuggestion("paper-inbox-zero")}
        cta="Generate Routine"
      />
      <SuggestionTile
        icon={<Leaf className="w-5 h-5" />}
        title="Harvest → Pantry Handoff"
        subtitle="Wash, portion, preserve, update inventory"
        onGenerate={() => materializeSuggestion("garden-to-pantry")}
        cta="Generate Routine"
      />

      {/* Strategy-driven suggestions */}
      {suggestions.slice(0, 6).map(({ id, name, description, tags = [] }) => (
        <div
          key={id}
          className="p-4 border rounded-2xl bg-white flex flex-col gap-2"
        >
          <div className="font-medium">{name}</div>
          <div className="text-sm text-gray-600">{description}</div>
          <div className="text-xs text-gray-500">
            {tags.map((t) => (
              <span
                key={t}
                className="inline-block text-xs px-2 py-1 rounded-full border mr-1 mb-1"
              >
                {t}
              </span>
            ))}
          </div>
          <div className="flex gap-2 mt-1">
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => materializeSuggestion(id)}
            >
              <Sparkles className="w-4 h-4 mr-1" /> Generate Routine
            </button>
            <button
              className="btn"
              onClick={() =>
                eventBus.emit("ui:navigate", {
                  to: "/cleaning/entry-exit-flow",
                  state: { preset: id },
                })
              }
            >
              <Edit3 className="w-4 h-4 mr-1" /> Edit First
            </button>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className="w-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <CalendarDays className="w-5 h-5 text-gray-700" />
          <h2 className="text-lg font-semibold">Routine Board</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn"
            onClick={() =>
              eventBus.emit("ui:navigate", {
                to: "/tier2/household/cleaning/live",
              })
            }
          >
            <Play className="w-4 h-4 mr-1" /> Open Live Session
          </button>
          <button
            className="btn"
            onClick={() => eventBus.emit("ui:refresh", { scope: "routines" })}
          >
            <RefreshCcw className="w-4 h-4 mr-1" /> Refresh
          </button>
          <button
            className="btn"
            onClick={() => {
              writeRoutines(routines);
              eventBus.emit("ui:toast", { type: "success", message: "Saved." });
            }}
          >
            <Save className="w-4 h-4 mr-1" /> Save
          </button>
        </div>
      </div>

      <Toolbar />
      <Tabs />

      {tab === "mine" ? (
        <>
          {filteredMine.length === 0 ? (
            <div className="border border-dashed rounded-2xl p-8 bg-white text-center">
              <div className="flex items-center justify-center gap-2 text-gray-700">
                <Info className="w-5 h-5" />
                <span className="font-medium">No routines found</span>
              </div>
              <p className="text-sm text-gray-500 mt-1">
                Get started with a preset or create a blank routine, then edit
                in the Flow Designer.
              </p>
              <div className="mt-4 flex items-center justify-center gap-2">
                <button
                  className="btn"
                  onClick={() => materializeSuggestion("daily-reset")}
                >
                  <DoorOpen className="w-4 h-4 mr-1" /> Daily Entry Reset
                </button>
                <button
                  className="btn"
                  onClick={() => materializeSuggestion("bug-shield-perimeter")}
                >
                  <Shield className="w-4 h-4 mr-1" /> Bug-Shield
                </button>
                <button className="btn" onClick={createBlankRoutine}>
                  <Plus className="w-4 h-4 mr-1" /> Blank Routine
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {filteredMine.map((r) => (
                <RoutineCard key={r.id} r={r} />
              ))}
            </div>
          )}
        </>
      ) : (
        <SuggestionsGrid />
      )}

      {/* Footer help */}
      <div className="mt-4 p-3 rounded-2xl border bg-white">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-gray-600 flex items-center gap-1">
            <Play className="w-4 h-4" /> <b>Start Live Session</b> launches an
            ad-hoc plan with Sabbath guard.
          </span>
          <span className="text-gray-600 flex items-center gap-1">
            <CalendarPlus className="w-4 h-4" /> <b>Schedule</b> creates RRULEs
            for steps with cadences (monthly/quarterly/bi-annual/annual).
          </span>
          <span className="text-gray-600 flex items-center gap-1">
            <Sparkles className="w-4 h-4" /> <b>Suggestions</b> learn from
            Inventory/Garden/Household signals over time.
          </span>
        </div>
      </div>

      {/* Inline styles for quick copy/paste (Tailwind-aware) */}
      <StyleSeed />
    </div>
  );
}

/* ------------------------------ Small subcomponents ------------------------------ */
function SuggestionTile({
  icon,
  title,
  subtitle,
  onGenerate,
  cta = "Generate",
}) {
  return (
    <div className="p-4 border rounded-2xl bg-white flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {icon}
        <div className="font-medium">{title}</div>
      </div>
      <div className="text-sm text-gray-600">{subtitle}</div>
      <div>
        <button className="btn btn-primary" onClick={onGenerate}>
          <Sparkles className="w-4 h-4 mr-1" /> {cta}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------- Styles (inline) ------------------------------- */
function StyleSeed() {
  if (typeof document === "undefined") return null;
  if (document.getElementById("routine-board-inline-styles")) return null;
  const style = document.createElement("style");
  style.id = "routine-board-inline-styles";
  style.innerHTML = `
    .btn {
      display:inline-flex;align-items:center;justify-content:center;
      border:1px solid rgb(229,231,235);border-radius:0.75rem;
      padding:0.5rem 0.75rem;font-size:0.875rem;background:white;color:rgb(55,65,81);
    }
    .btn:hover { background: rgb(249,250,251); }
    .btn-primary { background: rgb(17,24,39); color: white; border-color: rgb(17,24,39); }
    .btn-primary:hover { background: black; }
    .btn-danger { color: rgb(220,38,38); border-color: rgb(252,165,165); }
    .tab {
      padding:0.375rem 0.75rem;border:1px solid rgb(229,231,235);
      border-radius:9999px;background:white;color:rgb(75,85,99);
    }
    .tab-active {
      background: rgb(17,24,39); color:white; border-color: rgb(17,24,39);
    }
  `;
  document.head.appendChild(style);
  return null;
}
