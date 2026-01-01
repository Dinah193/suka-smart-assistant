// src/pages/MealPlanning/MealCyclePlannerCalendar.jsx
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";

import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin, { Draggable } from "@fullcalendar/interaction";
import listPlugin from "@fullcalendar/list";

import "../../index.css";

/* -------------------------------------------------------
   Alias-safe soft imports (event bus, preferences)
------------------------------------------------------- */
let eventBus = { on: () => {}, off: () => {}, emit: () => {} };
try {
  // prefer consolidated events path used in other files
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.emit ? eb : eventBus;
} catch {}

let PreferencesStore = {};
try {
  PreferencesStore = require("@/store/PreferencesStore");
} catch {}

/* -------------------------------------------------------
   Helpers
------------------------------------------------------- */
const uid = () => Math.random().toString(36).slice(2);
const todayISO = () => new Date().toISOString().slice(0, 10);

const LS_KEY_EVENTS = "suka:mealcycle:events";
const LS_KEY_RECIPES = "suka:mealcycle:recipes";
const LS_KEY_UNDO = "suka:mealcycle:undo";

function loadJSON(key, fallback) {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const cx = (...a) => a.filter(Boolean).join(" ");

/* Sabbath guard (hands-off) */
const sabbathGuard = () => {
  try {
    const prefs = PreferencesStore?.getPreferences?.() || {};
    const active = prefs?.torahProfile?.sabbath?.isActive;
    const handsOff = prefs?.torahProfile?.sabbath?.handsOffCooking === true;
    if (active && handsOff) return { ok: false, reason: "Sabbath hands-off is active." };
  } catch {}
  if (typeof window !== "undefined" && window.__SABBATH__) {
    return { ok: false, reason: "Sabbath period: actions paused." };
  }
  return { ok: true };
};

/* date utils (for quick jumps) */
const startOfWeek = (d, weekStartsOn = 1) => {
  const x = new Date(d);
  const diff = (x.getDay() + 7 - weekStartsOn) % 7;
  x.setDate(x.getDate() - diff);
  x.setHours(0, 0, 0, 0);
  return x;
};
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const lastDayOfMonth = (y, m) => new Date(y, m + 1, 0);
const quarterStart = (date) => {
  const m = date.getMonth();
  const qStart = Math.floor(m / 3) * 3;
  return new Date(date.getFullYear(), qStart, 1);
};
const quarterEnd = (date) => {
  const qs = quarterStart(date);
  return new Date(qs.getFullYear(), qs.getMonth() + 3, 0);
};

/* -------------------------------------------------------
   Pull recipes from store (best-effort)
------------------------------------------------------- */
async function getRecipesFromStore() {
  try {
    const mod = await import("@/store/RecipeStore");
    const useStore = mod.default || mod.useRecipeStore;
    if (typeof useStore === "function") {
      const st = useStore.getState ? useStore.getState() : useStore();
      const recs = st?.recipes || [];
      return recs.map((r) => ({
        id: r.id,
        name: r.name,
        tags: r.tags || [],
        category: r.category || "",
      }));
    }
  } catch {}
  // fallback demo items if store not available
  return [
    { id: "demo-lentil", name: "Lentil Stew" },
    { id: "demo-roast", name: "Roast Chicken" },
    { id: "demo-cabbage", name: "Cabbage Salad" },
    { id: "demo-bread", name: "Fresh Bread (2 loaves)" },
  ];
}

/* -------------------------------------------------------
   External draggable pill (sidebar)
------------------------------------------------------- */
function DraggablePill({ text, data }) {
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    new Draggable(wrapRef.current, {
      itemSelector: ".drag-pill",
      eventData: () => ({
        id: uid(),
        title: text,
        allDay: true,
        extendedProps: {
          kind: data?.kind || "meal",
          recipeId: data?.recipeId || null,
        },
      }),
    });
  }, []);

  return (
    <div ref={wrapRef}>
      <div
        className="drag-pill"
        title="Drag onto the calendar"
        style={{
          cursor: "grab",
          userSelect: "none",
          padding: "6px 10px",
          borderRadius: 999,
          background: "var(--surface-3)",
          border: "1px solid var(--border)",
          marginBottom: 8,
          fontSize: 13,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span style={{ fontSize: 14 }}>🍽️</span>
        {text}
      </div>
    </div>
  );
}

/* -------------------------------------------------------
   Conflict detection (naive)
------------------------------------------------------- */
function detectConflicts(evts = []) {
  const all = [...evts].filter(Boolean).sort((a, b) => (a.start || "").localeCompare(b.start || ""));
  const conflicts = [];
  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i];
    const b = all[i + 1];
    // if both allDay on same date, and same title → conflict-ish (duplicate)
    if (a.allDay && b.allDay && a.title === b.title && a.start === b.start) {
      conflicts.push({ a, b, reason: "duplicate day/title" });
    }
    // simple overlap check if times exist
    if (a.end && b.start && new Date(a.end) > new Date(b.start)) {
      conflicts.push({ a, b, reason: "overlap" });
    }
  }
  return conflicts;
}

/* -------------------------------------------------------
   Premade bundles (one click)
------------------------------------------------------- */
const bundles = {
  "Torah-compliant (Israelite home)": (startDate) => {
    const s = new Date(startDate);
    const add = (d) => new Date(s.getFullYear(), s.getMonth(), s.getDate() + d).toISOString().slice(0, 10);
    return [
      { id: uid(), title: "Weekly Bread Bake", start: add(3), allDay: true, extendedProps: { kind: "prep" } },
      { id: uid(), title: "Weekly Bread Bake", start: add(10), allDay: true, extendedProps: { kind: "prep" } },
      { id: uid(), title: "Batch Cook Beans", start: add(13), allDay: true, extendedProps: { kind: "prep" } },
      { id: uid(), title: "Ferment Cabbage", start: add(1), allDay: true, extendedProps: { kind: "prep" } },
      { id: uid(), title: "Ferment Cabbage", start: add(15), allDay: true, extendedProps: { kind: "prep" } },
    ];
  },
  "Dairy-Free starter": (startDate) => {
    const s = new Date(startDate);
    const add = (d) => new Date(s.getFullYear(), s.getMonth(), s.getDate() + d).toISOString().slice(0, 10);
    return [
      { id: uid(), title: "Roast Chicken + Veg", start: add(2), allDay: true },
      { id: uid(), title: "Lentil Soup (DF)", start: add(5), allDay: true },
      { id: uid(), title: "Taco Night (no dairy)", start: add(7), allDay: true },
    ];
  },
  Vegetarian: (startDate) => {
    const s = new Date(startDate);
    const add = (d) => new Date(s.getFullYear(), s.getMonth(), s.getDate() + d).toISOString().slice(0, 10);
    return [
      { id: uid(), title: "Veggie Stir-Fry", start: add(1), allDay: true },
      { id: uid(), title: "Chickpea Curry", start: add(3), allDay: true },
      { id: uid(), title: "Pasta Primavera", start: add(6), allDay: true },
    ];
  },
  "Low-Carb / Low Sugar": (startDate) => {
    const s = new Date(startDate);
    const add = (d) => new Date(s.getFullYear(), s.getMonth(), s.getDate() + d).toISOString().slice(0, 10);
    return [
      { id: uid(), title: "Grilled Salmon + Greens", start: add(1), allDay: true },
      { id: uid(), title: "Turkey Lettuce Wraps", start: add(4), allDay: true },
      { id: uid(), title: "Zoodle Bolognese", start: add(6), allDay: true },
    ];
  },
  Keto: (startDate) => {
    const s = new Date(startDate);
    const add = (d) => new Date(s.getFullYear(), s.getMonth(), s.getDate() + d).toISOString().slice(0, 10);
    return [
      { id: uid(), title: "Eggs + Avocado Bowls", start: add(2), allDay: true },
      { id: uid(), title: "Beef + Cauli Mash", start: add(5), allDay: true },
      { id: uid(), title: "Keto Chicken Alfredo", start: add(7), allDay: true },
    ];
  },
};

/* -------------------------------------------------------
   Main component
------------------------------------------------------- */
export default function MealCyclePlannerCalendar() {
  const calendarRef = useRef(null);

  // Single source of truth: React state
  const [events, setEvents] = useState(() => loadJSON(LS_KEY_EVENTS, []));
  const [recipes, setRecipes] = useState(() => loadJSON(LS_KEY_RECIPES, []));
  const [filter, setFilter] = useState("");
  const [showTray, setShowTray] = useState(true);
  const [flash, setFlash] = useState(""); // short confirmation message
  const [bundleKey, setBundleKey] = useState("Torah-compliant (Israelite home)");
  const [toast, setToast] = useState(null); // {type,msg,actionLabel,onAction}
  const [undoStack, setUndoStack] = useState(() => loadJSON(LS_KEY_UNDO, []));
  const [includeKinds, setIncludeKinds] = useState({ meal: true, prep: true });

  // Load recipes on mount
  useEffect(() => {
    let mounted = true;
    (async () => {
      const recs = await getRecipesFromStore();
      if (!mounted) return;
      setRecipes(recs);
      saveJSON(LS_KEY_RECIPES, recs);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Persist events + undo to localStorage
  useEffect(() => saveJSON(LS_KEY_EVENTS, events), [events]);
  useEffect(() => saveJSON(LS_KEY_UNDO, undoStack), [undoStack]);

  // Filtered recipe pills
  const filteredRecipes = useMemo(() => {
    const q = (filter || "").toLowerCase();
    if (!q) return recipes;
    return recipes.filter((r) => r.name?.toLowerCase().includes(q));
  }, [recipes, filter]);

  // Conflict hints
  const conflicts = useMemo(() => detectConflicts(events), [events]);

  // Toast UI
  const Toast = () =>
    toast ? (
      <div
        className={cx(
          "fixed bottom-4 right-4 z-50 max-w-sm rounded-xl px-4 py-3 shadow-lg",
          toast.type === "success" && "bg-green-600 text-white",
          toast.type === "warning" && "bg-yellow-600 text-white",
          toast.type === "error" && "bg-red-600 text-white",
          toast.type === "info" && "bg-zinc-900 text-white"
        )}
      >
        <div className="text-sm">{toast.msg}</div>
        {toast.actionLabel && toast.onAction ? (
          <button className="mt-2 rounded-lg border border-white/20 px-2 py-1 text-xs hover:bg-white/10" onClick={toast.onAction}>
            {toast.actionLabel}
          </button>
        ) : null}
      </div>
    ) : null;

  /* ----------------- Bundles + Quick add ----------------- */
  function addBundle() {
    const guard = sabbathGuard();
    if (!guard.ok) {
      setToast({ type: "warning", msg: guard.reason });
      return;
    }
    const api = calendarRef.current?.getApi();
    const start = api?.view?.currentStart?.toISOString().slice(0, 10) || todayISO();
    const builder = bundles[bundleKey];
    if (!builder) return;
    const newItems = builder(start);
    const prev = events;
    const next = [...events, ...newItems];
    setEvents(next);
    setFlash(`Added ${newItems.length} items from “${bundleKey}”.`);
    setUndoStack((s) => [...s, { type: "add-bundle", prev }]);
    setTimeout(() => setFlash(""), 2000);
  }

  // Quick-add buttons (adds to TODAY)
  function addQuick(title, kind = "prep") {
    const guard = sabbathGuard();
    if (!guard.ok) {
      setToast({ type: "warning", msg: guard.reason });
      return;
    }
    const newEvt = { id: uid(), title, start: todayISO(), allDay: true, extendedProps: { kind } };
    const prev = events;
    const next = [...events, newEvt];
    setEvents(next);
    setFlash(`Added “${title}” to today`);
    setUndoStack((s) => [...s, { type: "add-one", prev }]);
    setTimeout(() => setFlash(""), 1500);
  }

  /* ----------------- Calendar handlers (state-first) -------------- */

  // Drop from external sidebar → copy into state & remove FC's temp event
  function handleEventReceive(info) {
    const guard = sabbathGuard();
    if (!guard.ok) {
      setToast({ type: "warning", msg: guard.reason });
      info.event.remove();
      return;
    }
    const plain = {
      id: uid(),
      title: info.event.title,
      start: info.event.startStr,
      end: info.event.endStr || null,
      allDay: info.event.allDay,
      extendedProps: { ...info.event.extendedProps },
    };
    const prev = events;
    const next = [...events, plain];
    setEvents(next);
    setUndoStack((s) => [...s, { type: "receive", prev }]);
    info.event.remove(); // prevent duplicates
  }

  // Move/resize inside the calendar → mirror back to state
  function handleEventChange(info) {
    const e = info.event;
    const prev = events;
    const next = events.map((it) =>
      it.id === e.id
        ? {
            ...it,
            title: e.title,
            start: e.startStr,
            end: e.endStr || null,
            allDay: e.allDay,
            extendedProps: { ...e.extendedProps },
          }
        : it
    );
    setEvents(next);
    setUndoStack((s) => [...s, { type: "change", prev }]);
  }

  function handleEventClick(info) {
    const guard = sabbathGuard();
    if (!guard.ok) {
      setToast({ type: "warning", msg: guard.reason });
      return;
    }
    if (confirm(`Remove "${info.event.title}"?`)) {
      const id = info.event.id;
      const prev = events;
      const next = events.filter((e) => e.id !== id);
      setEvents(next);
      setUndoStack((s) => [...s, { type: "remove", prev }]);
    }
  }

  function handleDateClick(arg) {
    const guard = sabbathGuard();
    if (!guard.ok) {
      setToast({ type: "warning", msg: guard.reason });
      return;
    }
    const prev = events;
    const next = [...events, { id: uid(), title: "New meal", start: arg.dateStr, allDay: true }];
    setEvents(next);
    setUndoStack((s) => [...s, { type: "add-date", prev }]);
  }

  /* -------------------------------------------------------
     Quick range jumps (Week / Full Month / True Quarter)
  ------------------------------------------------------- */
  const jumpToWeek = () => {
    const api = calendarRef.current?.getApi();
    if (!api) return;
    api.changeView("dayGridWeek");
    api.gotoDate(startOfWeek(new Date()));
  };
  const jumpToFullMonth = () => {
    const api = calendarRef.current?.getApi();
    if (!api) return;
    api.changeView("dayGridMonth");
    api.gotoDate(new Date());
  };
  const jumpToTrueQuarter = () => {
    const api = calendarRef.current?.getApi();
    if (!api) return;
    const qs = quarterStart(new Date());
    api.changeView("dayGridMonth");
    api.gotoDate(qs);
  };

  /* -------------------------------------------------------
     Share / Export hooks
  ------------------------------------------------------- */
  const shareSchedule = () => {
    eventBus.emit("sharing.open", {
      panel: "FamilySharing",
      payload: {
        purpose: "meal-cycle",
        items: events,
        range: {
          start: events.length ? events.map((e) => e.start).sort()[0] : todayISO(),
          end:
            events.length && events.some((e) => e.end)
              ? events.map((e) => e.end || e.start).sort().slice(-1)[0]
              : todayISO(),
        },
      },
    });
    setToast({ type: "success", msg: "Schedule ready to share." });
  };

  const clearCalendar = () => {
    const guard = sabbathGuard();
    if (!guard.ok) {
      setToast({ type: "warning", msg: guard.reason });
      return;
    }
    const prev = events;
    setEvents([]);
    setUndoStack((s) => [...s, { type: "clear", prev }]);
  };

  const undo = () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack((s) => s.slice(0, -1));
    if (last.prev) setEvents(last.prev);
    setToast({ type: "info", msg: "Undone." });
  };

  /* ----------------- Toolbar to match Garden page ----------------- */
  const headerToolbar = useMemo(
    () => ({
      left: "today prev,next",
      center: "title",
      right: "dayGridMonth,dayGridWeek,dayGridDay,listWeek",
    }),
    []
  );

  // Filtered view by kind (meal vs prep)
  const filteredEvents = useMemo(() => {
    return events.filter((e) => includeKinds[e?.extendedProps?.kind || "meal"] !== false);
  }, [events, includeKinds]);

  return (
    <div className="card" style={{ padding: 0 }}>
      <Toast />
      <div
        className="card"
        style={{ margin: 16, marginBottom: 0, padding: 12, borderRadius: 14 }}
      >
        {/* Header controls */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Meal Cycle Planner</h2>
            {conflicts.length > 0 && (
              <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-900">
                {conflicts.length} conflict(s)
              </span>
            )}
            {!sabbathGuard().ok && (
              <span className="rounded-full border border-violet-300 bg-violet-50 px-2 py-0.5 text-xs text-violet-900">
                Sabbath: hands-off
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button className="rounded-xl border px-3 py-2 text-sm hover:bg-zinc-50" onClick={jumpToWeek}>Week</button>
            <button className="rounded-xl border px-3 py-2 text-sm hover:bg-zinc-50" onClick={jumpToFullMonth}>Full Month</button>
            <button className="rounded-xl border px-3 py-2 text-sm hover:bg-zinc-50" onClick={jumpToTrueQuarter}>True Quarter</button>

            <button className="rounded-xl border px-3 py-2 text-sm hover:bg-zinc-50" onClick={shareSchedule}>
              Share schedule
            </button>
            <button className="rounded-xl border px-3 py-2 text-sm hover:bg-zinc-50" onClick={undo} disabled={!undoStack.length}>
              Undo
            </button>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr minmax(260px, 360px)", // wider tray
            gap: 16,
          }}
        >
          {/* Calendar */}
          <div>
            <FullCalendar
              ref={calendarRef}
              plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
              initialView="dayGridMonth"
              headerToolbar={headerToolbar}
              height="auto"
              firstDay={1}
              editable={true}
              droppable={true}
              selectable={true}
              dayMaxEvents={true}
              expandRows={true}
              events={filteredEvents}
              dateClick={handleDateClick}
              eventReceive={handleEventReceive}
              eventChange={handleEventChange}
              eventClick={handleEventClick}
            />
          </div>

          {/* Sidebar: bundles + external draggables */}
          <aside>
            <div
              className="card"
              style={{ margin: 0, padding: 12, position: "sticky", top: 8 }}
            >
              {/* Bundles section */}
              <div style={{ display: "grid", gap: 8 }}>
                <label style={{ fontWeight: 700 }}>One-click bundle</label>
                <select
                  className="btn"
                  value={bundleKey}
                  onChange={(e) => setBundleKey(e.target.value)}
                  style={{ width: "100%" }}
                >
                  {Object.keys(bundles).map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <button className="btn sm" onClick={addBundle}>
                    <span className="label">Add Bundle to Calendar</span>
                  </button>
                  <button className="btn sm" onClick={clearCalendar}>
                    <span className="label">Clear Calendar</span>
                  </button>
                  {flash && (
                    <span className="subtitle" style={{ opacity: 0.85 }}>
                      {flash}
                    </span>
                  )}
                </div>
              </div>

              {/* Kind filter */}
              <div className="mt-3 flex items-center justify-between">
                <div className="text-sm font-semibold">Show</div>
                <div className="flex items-center gap-3 text-xs">
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={includeKinds.meal}
                      onChange={(e) => setIncludeKinds((k) => ({ ...k, meal: e.target.checked }))}
                    />
                    Meals
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={includeKinds.prep}
                      onChange={(e) => setIncludeKinds((k) => ({ ...k, prep: e.target.checked }))}
                    />
                    Prep
                  </label>
                </div>
              </div>

              {/* Tray header */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginTop: 12,
                }}
              >
                <div style={{ fontWeight: 700 }}>Recipes & Quick Items</div>
                <button className="btn sm" onClick={() => setShowTray((v) => !v)}>
                  <span className="label">{showTray ? "Hide" : "Show"}</span>
                </button>
              </div>

              {showTray && (
                <>
                  <div style={{ marginTop: 8 }}>
                    <input
                      className="btn"
                      placeholder="Filter recipes…"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      style={{ width: "100%" }}
                    />
                  </div>

                  <div style={{ marginTop: 10, marginBottom: 6, fontSize: 12 }}>
                    Drag any item onto the calendar:
                  </div>

                  <div id="recipe-draggable-list">
                    {/* Recipe pills */}
                    {filteredRecipes.slice(0, 200).map((r) => (
                      <DraggablePill
                        key={r.id}
                        text={r.name}
                        data={{ kind: "meal", recipeId: r.id }}
                      />
                    ))}

                    {/* Quick session pills */}
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
                      Quick sessions
                    </div>
                    <DraggablePill text="Weekly Bread Bake" data={{ kind: "prep" }} />
                    <DraggablePill text="Batch Cook Beans" data={{ kind: "prep" }} />
                    <DraggablePill text="Ferment Cabbage" data={{ kind: "prep" }} />

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 8,
                        marginTop: 10,
                      }}
                    >
                      <button className="btn sm" onClick={() => addQuick("Weekly Bread Bake")}>
                        <span className="label">Add Bread (today)</span>
                      </button>
                      <button className="btn sm" onClick={() => addQuick("Batch Cook Beans")}>
                        <span className="label">Add Beans (today)</span>
                      </button>
                    </div>
                  </div>
                </>
              )}

              {/* Conflict peek */}
              {conflicts.length > 0 && (
                <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <div className="font-medium">{conflicts.length} potential conflict(s)</div>
                  <ul className="ml-4 list-disc">
                    {conflicts.slice(0, 5).map((c, idx) => (
                      <li key={idx} className="mt-1">
                        {c.a.title} ↔ {c.b.title} ({c.reason})
                      </li>
                    ))}
                  </ul>
                  <div className="mt-1">
                    <button
                      className="underline"
                      onClick={() => eventBus.emit("ui.open", { panel: "CalendarPreview", items: events })}
                    >
                      Open timeline preview
                    </button>
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

/* ===========================
   Lightweight TESTS (dev only)
   =========================== */
(function runMealCyclePlannerCalendarTestsOnce() {
  if (typeof window === "undefined") return;
  if (window.__MEALCYCLE_TESTS__) return;
  window.__MEALCYCLE_TESTS__ = true;

  const expect = (cond, msg) => (cond ? console.log("[MealCycle TEST PASS]", msg) : console.error("[MealCycle TEST FAIL]", msg));

  // Conflict detector
  const evts = [
    { title: "A", start: "2025-01-01", end: "2025-01-01", allDay: true },
    { title: "A", start: "2025-01-01", allDay: true },
  ];
  expect(detectConflicts(evts).length >= 1, "Detects duplicate same-day allDay titles");

  // Quarter start
  const qS = quarterStart(new Date(2025, 4, 11)); // May 11, 2025 -> Q2 start Apr 1
  expect(qS.getMonth() === 3 && qS.getDate() === 1, "Quarter start computed");

  // Undo stack behavior
  const before = [{ id: "x", title: "T", start: "2025-01-01", allDay: true }];
  saveJSON("___tmp", before);
  expect(Array.isArray(loadJSON("___tmp", [])), "Storage helpers work");
})();
