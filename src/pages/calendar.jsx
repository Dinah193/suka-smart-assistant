// src/pages/calendar.jsx
// -----------------------------------------------------------------------------
// Household Calendar Page (shim-friendly, no direct agent imports)
//
// How this fits the SSA system:
// - Shows all household events (meals, garden, animals, cleaning, etc.).
// - Offers high-level actions like:
//     • "Plan My Garden"  (HTTP backend agent call)
//     • "Generate Meal Plan" (via automation shim, no direct agent import)
//     • "Animal Care Plan" (local stub for now)
//     • Quick Add (events or saved plans)
// - For meal bundles, this page now calls the automation runtime shim:
//       automation.invoke("meal-bundle", { command: "generate", ... })
//   The runtime is responsible for loading the actual agent implementation
//   (e.g. "@/agents/mealBundleAgent") and/or forwarding to a backend.
// - This keeps the page decoupled from specific agents while still working
//   if the automation runtime is missing (local fallback is used).
// -----------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";

import { useHouseholdCalendar } from "@/store/HouseholdCalendarStore";
import { useBus, emit as busEmit } from "@/utils/safeBus";
import "../index.css";

/* ----------------------------------------------------------------------------
   Optional, defensive imports (won't crash if not present)
   - automation: Shared runtime for invoking/queuing agents by id.
   - sabbathGuard: Guardrail wrapper to respect sabbath rules.
---------------------------------------------------------------------------- */
let automation = {
  invoke: async () => ({ ok: false, reason: "automation.runtime.missing" }),
  queue: async () => ({ ok: false, reason: "automation.runtime.missing" }),
};
let sabbathGuard = async (fn) => fn?.();

(async () => {
  try {
    const mod = await import("@/services/automation/runtime");
    if (mod?.automation) automation = mod.automation;
  } catch {
    // no-op, shim remains
  }
  try {
    const mod = await import("@/services/guardrails/sabbathGuard");
    if (typeof mod?.sabbathGuard === "function") sabbathGuard = mod.sabbathGuard;
  } catch {
    // no-op
  }
})();

/* ---------------------------- config ---------------------------- */
const API =
  import.meta?.env?.VITE_API_BASE?.replace(/\/$/, "") ||
  "http://127.0.0.1:7071";

/* ---------------------------- helpers ---------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CACHE_KEY = "suka.calendar.cache.v2";
const FAVS_KEY = "suka:favorites:plans";

function monthSpanFromView(viewApi) {
  const focus = viewApi.calendar.getDate();
  const y = focus.getFullYear();
  const m = focus.getMonth();
  const start = new Date(y, m, 1);
  const end = new Date(y, m + 1, 1);
  const startISO = start.toISOString().slice(0, 10);
  const days = Math.round((end - start) / 86400000);
  return { startISO, days };
}

function rangeSpanFromView(viewApi) {
  const { currentStart, currentEnd } = viewApi;
  const startISO = currentStart.toISOString().slice(0, 10);
  const days = Math.round((currentEnd - currentStart) / 86400000);
  return { startISO, days };
}

function backendToEvents(calendar = []) {
  return (calendar || []).map((e, idx) => {
    const tagStr = (e.tags || []).join(", ");
    let source = "general";
    const tags = e.tags || [];
    if (tags.includes("preservation") || tags.includes("garden")) source = "garden";
    if (tags.includes("meal") || tags.includes("meals")) source = "meals";
    if (tags.includes("cleaning")) source = "cleaning";
    if (tags.includes("animals")) source = "animals";
    return {
      id: e.id || `be-${idx}-${e.date}-${e.title}`,
      title: e.title + (tagStr ? ` (${tagStr})` : ""),
      start: e.date,
      allDay: e.allDay ?? true,
      source,
      extendedProps: { tags, source },
    };
  });
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 6500) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(to);
  }
}

async function resilientJSON(url, opts = {}, retries = 1) {
  try {
    const res = await fetchWithTimeout(url, opts, 6500);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (retries > 0) {
      await sleep(400);
      return resilientJSON(url, opts, retries - 1);
    }
    throw err;
  }
}

// Soft import helper
async function soft(path) {
  try {
    // eslint-disable-next-line import/no-dynamic-require
    return await import(/* @vite-ignore */ path);
  } catch {
    return null;
  }
}

// Load favorite plans from store/service/localStorage (resilient)
async function loadFavoritePlans() {
  const store = await soft("@/store/FavoritePlansStore");
  const svc = await soft("@/services/planService");
  try {
    if (store?.default?.getAll) return await store.default.getAll();
    if (store?.getAll) return await store.getAll();
    if (svc?.default?.listFavorites) return await svc.default.listFavorites();
  } catch {
    // fall back to localStorage
  }
  try {
    const raw = localStorage.getItem(FAVS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Plan → events (offset from a base date)
function expandPlanToEvents(plan, baseISO) {
  const base = new Date(baseISO);
  const pad = (n) => String(n).padStart(2, "0");
  const addDays = (d) => {
    const dt = new Date(base);
    dt.setDate(dt.getDate() + (d || 0));
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  };

  const domain = plan.domain || "general";
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];

  if (!tasks.length) {
    // Minimal fallback: a single event for the plan itself
    return [
      {
        id: `plan-${plan.id || plan.slug || Date.now()}`,
        title: plan.title || "Favorite Plan",
        start: addDays(0),
        allDay: true,
        source: domain,
        extendedProps: {
          planId: plan.id,
          source: domain,
          tags: plan.tags || ["favorite"],
        },
      },
    ];
  }

  return tasks.map((t, i) => ({
    id: t.id || `plan-${plan.id || "fav"}-${i}-${Date.now()}`,
    title: t.title || t.name || plan.title || "Task",
    start: addDays(t.offsetDays || 0),
    allDay: t.allDay !== false, // default all-day
    source: t.domain || domain || "general",
    extendedProps: {
      planId: plan.id,
      source: t.domain || domain || "general",
      tags: t.tags || plan.tags || ["favorite"],
    },
  }));
}

/**
 * Local fallback meal bundle generator.
 * Used when automation runtime cannot produce a bundle result.
 */
function fallbackMealBundle({ startISO, days }) {
  const events = [];
  const base = new Date(startISO);
  const pad = (n) => String(n).padStart(2, "0");
  const addDays = (d) => {
    const dt = new Date(base);
    dt.setDate(dt.getDate() + d);
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  };

  const labels = ["Breakfast", "Lunch", "Dinner"];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(i);
    labels.forEach((label, idx) => {
      events.push({
        id: `fb-meal-${date}-${idx}`,
        title: `${label} (fallback)`,
        start: date,
        allDay: true,
        source: "meals",
        extendedProps: { source: "meals", tags: ["fallback", "meals"] },
      });
    });
  }
  return { ok: true, events, summary: "Fallback meal plan for current view." };
}

/* --------------------------- small UI bits --------------------------- */
function Modal({ open, onClose, title, children, confirmLabel = "Run", onConfirm }) {
  if (!open) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 640, maxWidth: "92vw" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-2">{title}</h3>
        <div className="mb-4 text-sm opacity-80">{children}</div>
        <div className="flex gap-2 justify-end">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {onConfirm && (
            <button
              className="btn primary"
              onClick={async () => {
                await onConfirm?.();
                onClose();
              }}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Banner({ kind = "info", children, onClose }) {
  const bg =
    kind === "error"
      ? "rgba(239, 68, 68, 0.12)"
      : kind === "warn"
      ? "rgba(245, 158, 11, 0.12)"
      : "rgba(59, 130, 246, 0.10)";
  const border =
    kind === "error" ? "#ef4444" : kind === "warn" ? "#f59e0b" : "#3b82f6";
  return (
    <div
      className="mb-3"
      style={{
        background: bg,
        border: `1px solid ${border}`,
        padding: 10,
        borderRadius: 12,
        display: "flex",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      <div className="text-sm">{children}</div>
      {onClose && (
        <button className="btn" onClick={onClose}>
          ✕
        </button>
      )}
    </div>
  );
}

function UndoToast({ open, message, onUndo, onClose }) {
  if (!open) return null;
  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        background: "var(--card, #fff)",
        border: "1px solid var(--border, #e5e7eb)",
        borderRadius: 14,
        boxShadow: "0 10px 24px rgba(0,0,0,0.08)",
        padding: "10px 12px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        zIndex: 60,
      }}
    >
      <span className="text-sm">{message}</span>
      {onUndo && (
        <button className="btn" onClick={onUndo}>
          Undo
        </button>
      )}
      <button className="btn" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

/* --------------------------- component --------------------------- */
export default function CalendarPage() {
  const { events: storeEvents } = useHouseholdCalendar();

  // data state
  const [backendEvents, setBackendEvents] = useState([]);
  const [bundleEvents, setBundleEvents] = useState([]);
  const [recentIds, setRecentIds] = useState(new Set());

  // ui state
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);

  // filters
  const [showMeals, setShowMeals] = useState(true);
  const [showGarden, setShowGarden] = useState(true);
  const [showAnimals, setShowAnimals] = useState(true);
  const [showCleaning, setShowCleaning] = useState(true);

  // modals
  const [openGardenModal, setOpenGardenModal] = useState(false);
  const [openMealsModal, setOpenMealsModal] = useState(false);
  const [openCleaningModal, setOpenCleaningModal] = useState(false);
  const [openQuickAdd, setOpenQuickAdd] = useState(false);

  // quick-add form
  const [qaTitle, setQaTitle] = useState("");
  const [qaSource, setQaSource] = useState("general");
  const [qaDate, setQaDate] = useState("");

  // quick-add tabs & favorites
  const [qaTab, setQaTab] = useState("event"); // "event" | "plans"
  const [favorites, setFavorites] = useState([]);
  const [favQuery, setFavQuery] = useState("");

  // meal bundle controls
  const [selectedBundleKey, setSelectedBundleKey] = useState("standard");
  const [avoidTagsInput, setAvoidTagsInput] = useState("");

  // undo toast (for deletes)
  const [undo, setUndo] = useState({ open: false, payload: null });

  const calendarRef = useRef(null);

  /* ------------------- connectivity ------------------- */
  useEffect(() => {
    const onUp = () => setOnline(true);
    const onDown = () => setOnline(false);
    window.addEventListener("online", onUp);
    window.addEventListener("offline", onDown);
    return () => {
      window.removeEventListener("online", onUp);
      window.removeEventListener("offline", onDown);
    };
  }, []);

  /* ------------------- backend refresh + cache ------------------- */
  async function refreshFromBackend(showToasts = true) {
    setLoading(true);
    setError("");
    try {
      const data = await resilientJSON(`${API}/state`, {}, 1);
      const mapped = backendToEvents(data?.calendar || []);
      setBackendEvents(mapped);

      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ ts: Date.now(), events: mapped })
      );

      const ids = new Set(mapped.map((e) => e.id));
      setRecentIds(ids);
      clearTimeout(window.__recentGlowTO);
      window.__recentGlowTO = setTimeout(
        () => setRecentIds(new Set()),
        3200
      );

      if (showToasts) {
        setFlash("🔄 Calendar synced.");
        clearTimeout(window.__flashTO);
        window.__flashTO = setTimeout(() => setFlash(""), 2000);
      }
    } catch {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          setBackendEvents(parsed.events || []);
          setInfo(
            "You’re viewing cached calendar data (offline or service down)."
          );
        } catch {
          // ignore
        }
      }
      setError("Could not reach the calendar service. Working offline.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    refreshFromBackend(false);
  }, []);

  /* ------------------- safe bus listeners ------------------- */
  useBus("calendar.refresh", () => refreshFromBackend(), []);
  useBus("plan.saved", () => refreshFromBackend(), []);
  useBus("inventory.updated", () => refreshFromBackend(), []);
  useBus("garden.plan.saved", () => refreshFromBackend(), []);
  useBus("meal.plan.generated", () => refreshFromBackend(), []);

  /* ----------------------- filtering + merge ---------------------- */
  const byFilters = (arr) =>
    (arr || []).filter((e) => {
      const src = String(e.source || "").toLowerCase();
      if (src === "meals") return showMeals;
      if (src === "garden") return showGarden;
      if (src === "animals") return showAnimals;
      if (src === "cleaning") return showCleaning;
      return true;
    });

  const filteredStore = useMemo(
    () => byFilters(storeEvents),
    [storeEvents, showMeals, showGarden, showAnimals, showCleaning]
  );
  const filteredBackend = useMemo(
    () => byFilters(backendEvents),
    [backendEvents, showMeals, showGarden, showAnimals, showCleaning]
  );
  const filteredBundle = useMemo(
    () => byFilters(bundleEvents),
    [bundleEvents, showMeals, showGarden, showAnimals, showCleaning]
  );

  const calendarEvents = useMemo(
    () => [...filteredStore, ...filteredBackend, ...filteredBundle],
    [filteredStore, filteredBackend, filteredBundle]
  );

  /* ------------------------ event glow style ---------------------- */
  function eventDidMount(info) {
    const id = info.event.id;
    const src = String(
      info.event.extendedProps?.source ||
        info.event._def?.extendedProps?.source ||
        info.event?.source
    ).toLowerCase();
    const el = info.el;
    if (src.includes("meal")) el.style.borderLeft = "4px solid #10b981";
    else if (src.includes("garden")) el.style.borderLeft = "4px solid #22c55e";
    else if (src.includes("animals")) el.style.borderLeft = "4px solid #8b5cf6";
    else if (src.includes("cleaning")) el.style.borderLeft = "4px solid #0ea5e9";
    else el.style.borderLeft = "4px solid #9ca3af";

    if (recentIds.has(id)) {
      el.style.boxShadow = "0 0 0 3px rgba(16,185,129,0.35)";
      el.style.transition = "box-shadow 400ms ease";
      setTimeout(() => {
        el.style.boxShadow = "";
      }, 2800);
    }
  }

  /* -------------------------- handlers ---------------------------- */
  async function handleGenerateBundle() {
    const api = calendarRef.current?.getApi();
    if (!api) return;

    let startISO;
    let days;

    if (api.view.type === "dayGridMonth") {
      ({ startISO, days } = monthSpanFromView(api.view));
    } else {
      ({ startISO, days } = rangeSpanFromView(api.view));
    }

    const avoidTags = avoidTagsInput
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    await sabbathGuard(async () => {
      let res;
      try {
        // -------------------------------------------------------------------
        // Primary path: automation runtime invokes the "meal-bundle" shim.
        // The runtime is free to map this to a local agent or remote service.
        // -------------------------------------------------------------------
        res = await automation.invoke("meal-bundle", {
          command: "generate",
          archetypeKey: selectedBundleKey,
          span: { startISO, days },
          avoidTags,
          source: "CalendarPage",
        });
      } catch {
        res = null;
      }

      // Fallback to local stub if automation runtime is unavailable or fails.
      if (!res || res.ok === false || !Array.isArray(res.events)) {
        res = fallbackMealBundle({ startISO, days });
      }

      if (res?.ok) {
        const tagged = (res.events || []).map((e, i) => ({
          ...e,
          source: e.source || "meals",
          id: e.id || `bundle-${Date.now()}-${i}`,
          allDay: e.allDay ?? true,
          extendedProps: {
            ...(e.extendedProps || {}),
            _new: true,
            source: e.source || "meals",
          },
        }));
        setBundleEvents((prev) => [
          ...prev.filter((x) => x.source !== "meals"),
          ...tagged,
        ]);
        setFlash(
          `✅ ${
            res.summary || "Meal plan generated for the current view."
          }`
        );
        busEmit("meal.plan.generated", { startISO, days, avoidTags });
      } else {
        setFlash("⚠️ Failed to generate meals for this view.");
      }

      clearTimeout(window.__mealBundleFlashTO);
      window.__mealBundleFlashTO = setTimeout(() => setFlash(""), 3500);
    });
  }

  async function runPlanMyGarden() {
    await sabbathGuard(async () => {
      const body = {
        agent: "companionLayoutAgent",
        template_id: "companion_layout",
        context: {
          crops: ["tomato", "basil", "marigold"],
          beds: [
            { bedId: "A", rows: 3 },
            { bedId: "B", rows: 3 },
          ],
          chart: {},
        },
      };
      try {
        await fetch(`${API}/agents/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        await refreshFromBackend();
        setFlash("🌱 Garden plan updated and saved.");
        busEmit("garden.plan.saved", {});
      } catch {
        setError("Garden agent endpoint unavailable. Try again later.");
      } finally {
        clearTimeout(window.__flashTO);
        window.__flashTO = setTimeout(() => setFlash(""), 3000);
      }
    });
  }

  // NEW: Animal Care quick stub
  async function runAnimalCareSuggest() {
    await sabbathGuard(async () => {
      const base = new Date().toISOString().slice(0, 10);
      const addDays = (d) => {
        const dt = new Date(base);
        dt.setDate(dt.getDate() + d);
        return dt.toISOString().slice(0, 10);
      };
      const stub = [
        {
          id: `ac-${Date.now()}-1`,
          title: "Feed & Water",
          start: addDays(0),
          allDay: true,
          source: "animals",
          extendedProps: {
            tags: ["animals"],
            _new: true,
            source: "animals",
          },
        },
        {
          id: `ac-${Date.now()}-2`,
          title: "Coop Clean",
          start: addDays(2),
          allDay: true,
          source: "animals",
          extendedProps: {
            tags: ["animals"],
            _new: true,
            source: "animals",
          },
        },
      ];
      setBundleEvents((prev) => [...prev, ...stub]);
      setFlash("🐓 Suggested animal care tasks (local stub).");
      clearTimeout(window.__flashTO);
      window.__flashTO = setTimeout(() => setFlash(""), 3000);
    });
  }

  function handleDateClick(arg) {
    setQaDate(arg.dateStr);
    setQaTab("event"); // default to event tab when clicking the grid
    setOpenQuickAdd(true);
  }

  function handleDateDoubleClick(dateStr) {
    busEmit("plan.save.modal.open", {
      source: "Calendar",
      suggested: {
        planId: `fav:${dateStr}`,
        title: "My Favorite Plan",
        domain: "meals",
        whenISO: dateStr,
        tags: ["calendar", "evergreen"],
      },
      tsISO: new Date().toISOString(),
    });
  }

  function removeEventById(id) {
    const removed =
      bundleEvents.find((e) => e.id === id) ||
      backendEvents.find((e) => e.id === id) ||
      (storeEvents || []).find((e) => e.id === id);
    setBundleEvents((prev) => prev.filter((e) => e.id !== id));
    setBackendEvents((prev) => prev.filter((e) => e.id !== id));
    if (removed) setUndo({ open: true, payload: removed });
  }
  function undoRemoval() {
    if (undo.payload) setBundleEvents((prev) => [...prev, undo.payload]);
    setUndo({ open: false, payload: null });
  }

  function exportICS() {
    const title = "Suka Household Calendar";
    const events = calendarEvents;
    const pad = (n) => String(n).padStart(2, "0");
    const dtstamp = new Date();
    const dt = (d) => {
      const date = new Date(d);
      return (
        date.getUTCFullYear() +
        pad(date.getUTCMonth() + 1) +
        pad(date.getUTCDate()) +
        "T000000Z"
      );
    };
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      `PRODID:-//Suka//Household Calendar//EN`,
      `X-WR-CALNAME:${title}`,
      ...events.map((e) => {
        const uid = e.id || `${Math.random().toString(36).slice(2)}@suka`;
        return [
          "BEGIN:VEVENT",
          `UID:${uid}`,
          `DTSTAMP:${dt(dtstamp)}`,
          `DTSTART:${dt(e.start)}`,
          e.allDay ? "" : `DTEND:${dt(e.end || e.start)}`,
          `SUMMARY:${e.title?.replace(/\n/g, " ") || "Event"}`,
          "END:VEVENT",
        ]
          .filter(Boolean)
          .join("\n");
      }),
      "END:VCALENDAR",
    ].join("\n");
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.download = "suka-household.ics";
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
  }
  function printCalendar() {
    window.print();
  }

  /* ------------------------------ UI ------------------------------ */
  return (
    <div
      className="p-4"
      onDoubleClick={(e) => {
        const cell = e.target?.closest?.(".fc-daygrid-day");
        const dateStr = cell?.getAttribute?.("data-date");
        if (dateStr) handleDateDoubleClick(dateStr);
      }}
    >
      <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">🏠 Household Calendar</h1>
          <p className="subtitle">
            Cooking, gardening, animal care, feasts, automated routines — all in
            one place.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button className="btn" onClick={() => refreshFromBackend()}>
            {loading ? "Syncing…" : "Refresh"}
          </button>
          <button className="btn" onClick={exportICS}>
            Export .ics
          </button>
          <button className="btn" onClick={printCalendar}>
            Print
          </button>
          <span
            className="subtitle"
            title={online ? "Online" : "Offline"}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "1px solid var(--border, #e5e7eb)",
            }}
          >
            {online ? "🟢 Online" : "🟠 Offline"}
          </span>
        </div>
      </div>

      {error && (
        <Banner kind="error" onClose={() => setError("")}>
          {error}
        </Banner>
      )}
      {info && (
        <Banner kind="info" onClose={() => setInfo("")}>
          {info}
        </Banner>
      )}
      {flash && (
        <Banner kind="warn" onClose={() => setFlash("")}>
          {flash}
        </Banner>
      )}

      {/* Entry points + Filters */}
      <div className="card mb-3" style={{ display: "grid", gap: 12 }}>
        {/* Primary actions */}
        <div className="flex gap-2 flex-wrap">
          <button
            className="btn primary"
            onClick={() => setOpenGardenModal(true)}
          >
            🌱 Plan My Garden
          </button>
          <button
            className="btn primary"
            onClick={() => setOpenMealsModal(true)}
          >
            🍽️ Generate Meal Plan
          </button>
          <button
            className="btn primary"
            onClick={() => setOpenCleaningModal(true)}
          >
            🧽 Suggest Cleaning Routine
          </button>
          {/* NEW: Animal Care button */}
          <button className="btn primary" onClick={runAnimalCareSuggest}>
            🐓 Animal Care Plan
          </button>
          <button
            className="btn"
            onClick={async () => {
              const today = new Date().toISOString().slice(0, 10);
              setQaDate(today);
              setQaTab("plans"); // default Quick Add to plans per your request
              setOpenQuickAdd(true);
              // lazy-load favorites each time we open the modal
              const favs = await loadFavoritePlans();
              setFavorites(Array.isArray(favs) ? favs : []);
            }}
          >
            ➕ Quick Add
          </button>
        </div>

        {/* Filters */}
        <div className="flex gap-4 items-center flex-wrap">
          <span className="subtitle">Show:</span>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showMeals}
              onChange={(e) => setShowMeals(e.target.checked)}
            />
            Meals
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showGarden}
              onChange={(e) => setShowGarden(e.target.checked)}
            />
            Garden
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showAnimals}
              onChange={(e) => setShowAnimals(e.target.checked)}
            />
            Animals
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showCleaning}
              onChange={(e) => setShowCleaning(e.target.checked)}
            />
            Cleaning
          </label>
        </div>

        <div
          className="divider"
          style={{ borderTop: "1px solid var(--border)", opacity: 0.6 }}
        />

        {/* Meal bundle generator controls */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 12,
            alignItems: "end",
          }}
        >
          <label>
            <div className="subtitle" style={{ marginBottom: 4 }}>
              Meal Bundle
            </div>
            <select
              value={selectedBundleKey}
              onChange={(e) => setSelectedBundleKey(e.target.value)}
              className="btn"
              style={{ width: "100%" }}
            >
              <option value="standard">
                Standard (Breakfast/Lunch/Dinner/Snacks)
              </option>
              <option value="shabbat">Shabbat-friendly</option>
              <option value="feast">Feast Days</option>
            </select>
          </label>

          <label>
            <div className="subtitle" style={{ marginBottom: 4 }}>
              Avoid Tags (comma-separated)
            </div>
            <input
              className="btn"
              placeholder="e.g., spicy, pork, dairy"
              value={avoidTagsInput}
              onChange={(e) => setAvoidTagsInput(e.target.value)}
              style={{ width: "100%" }}
            />
          </label>

          <div>
            <button
              className="btn"
              onClick={handleGenerateBundle}
              style={{ width: "100%" }}
            >
              <span className="label">Generate Meals for Current View</span>
            </button>
          </div>
        </div>
      </div>

      {/* Calendar */}
      <div className="card">
        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          headerToolbar={{
            left: "title",
            center: "",
            right: "today prev,next dayGridMonth,dayGridWeek,dayGridDay",
          }}
          height="auto"
          events={calendarEvents}
          eventDisplay="block"
          firstDay={1}
          dayMaxEvents
          eventDidMount={eventDidMount}
          dateClick={handleDateClick}
          eventClick={(info) => {
            const ok = window.confirm(
              `Remove "${info.event.title}" from this view?`
            );
            if (ok) removeEventById(info.event.id);
          }}
        />
      </div>

      {/* Empty-state hint */}
      {calendarEvents.length === 0 && (
        <div className="subtitle mt-3">
          No events yet. Try “Plan My Garden”, “Generate Meal Plan”, “Animal
          Care Plan”, or “Suggest Cleaning Routine”.
        </div>
      )}

      {/* ---------- Run Agent Modals ---------- */}
      <Modal
        open={openGardenModal}
        onClose={() => setOpenGardenModal(false)}
        title="🌱 Plan My Garden"
        confirmLabel="Run Garden Agent"
        onConfirm={runPlanMyGarden}
      >
        I’ll generate a simple companion layout and save it to your assistant’s
        state. Newly added tasks will appear and glow briefly.
      </Modal>

      <Modal
        open={openMealsModal}
        onClose={() => setOpenMealsModal(false)}
        title="🍽️ Generate Meal Plan"
        confirmLabel="Generate For Current View"
        onConfirm={handleGenerateBundle}
      >
        I’ll create Breakfast/Lunch/Dinner/Snack events for the days currently
        visible. Use “Avoid Tags” to keep out certain ingredients or styles.
      </Modal>

      <Modal
        open={openCleaningModal}
        onClose={() => setOpenCleaningModal(false)}
        title="🧽 Suggest Cleaning Routine"
        confirmLabel="Suggest 3-Day Routine"
        onConfirm={
          runAnimalCareSuggest /* optional: swap for real cleaning agent later */
        }
      >
        I’ll suggest a light routine (local stub for now). You can wire this to
        a backend cleaning agent later to tailor frequency and zones.
      </Modal>

      {/* ---------- Quick Add Modal (Event / Plans) ---------- */}
      <Modal
        open={openQuickAdd}
        onClose={() => setOpenQuickAdd(false)}
        title="➕ Quick Add"
        confirmLabel={qaTab === "event" ? "Add Event" : undefined}
        onConfirm={
          qaTab === "event"
            ? async () => {
                if (!qaTitle || !qaDate) return;
                const ev = {
                  id: `qa-${Date.now()}`,
                  title: qaTitle,
                  start: qaDate,
                  allDay: true,
                  source: qaSource,
                  extendedProps: { source: qaSource },
                };
                setBundleEvents((prev) => [...prev, ev]);
                setQaTitle("");
                setQaSource("general");
                setQaDate("");
                setFlash("✅ Event added.");
                clearTimeout(window.__flashTO);
                window.__flashTO = setTimeout(() => setFlash(""), 2500);
                try {
                  await fetch(`${API}/calendar/add`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      title: ev.title,
                      date: ev.start,
                      tags: [qaSource],
                    }),
                  });
                } catch {
                  // ignore network failure for quick add
                }
                busEmit("plan.saved", {
                  planId: ev.id,
                  domain: qaSource,
                  title: ev.title,
                  whenISO: ev.start,
                  target: "local",
                  source: "Calendar.QuickAdd",
                });
              }
            : undefined
        }
      >
        {/* Tabs */}
        <div className="flex gap-2 mb-3">
          <button
            className={`btn ${qaTab === "event" ? "primary" : ""}`}
            onClick={() => setQaTab("event")}
          >
            New Event
          </button>
          <button
            className={`btn ${qaTab === "plans" ? "primary" : ""}`}
            onClick={async () => {
              setQaTab("plans");
              const favs = await loadFavoritePlans();
              setFavorites(Array.isArray(favs) ? favs : []);
            }}
          >
            Saved Plans
          </button>
        </div>

        {qaTab === "event" && (
          <div className="grid" style={{ gap: 8 }}>
            <label className="grid" style={{ gap: 4 }}>
              <span className="subtitle">Title</span>
              <input
                className="btn"
                value={qaTitle}
                onChange={(e) => setQaTitle(e.target.value)}
                placeholder="e.g., Family Feast Prep"
              />
            </label>
            <label className="grid" style={{ gap: 4 }}>
              <span className="subtitle">Date</span>
              <input
                className="btn"
                type="date"
                value={qaDate}
                onChange={(e) => setQaDate(e.target.value)}
              />
            </label>
            <label className="grid" style={{ gap: 4 }}>
              <span className="subtitle">Source</span>
              <select
                className="btn"
                value={qaSource}
                onChange={(e) => setQaSource(e.target.value)}
              >
                <option value="general">General</option>
                <option value="meals">Meals</option>
                <option value="garden">Garden</option>
                <option value="animals">Animals</option>
                <option value="cleaning">Cleaning</option>
              </select>
            </label>
          </div>
        )}

        {qaTab === "plans" && (
          <div className="grid" style={{ gap: 10 }}>
            <div className="grid" style={{ gap: 4 }}>
              <span className="subtitle">Apply on date</span>
              <input
                className="btn"
                type="date"
                value={qaDate}
                onChange={(e) => setQaDate(e.target.value)}
              />
            </div>

            <div className="grid" style={{ gap: 4 }}>
              <span className="subtitle">Search Favorites</span>
              <input
                className="btn"
                placeholder="Type to filter…"
                value={favQuery}
                onChange={(e) => setFavQuery(e.target.value)}
              />
            </div>

            <div
              className="grid"
              style={{ gap: 8, maxHeight: 260, overflow: "auto" }}
            >
              {(favorites || [])
                .filter((p) => {
                  const q = favQuery.trim().toLowerCase();
                  if (!q) return true;
                  return (
                    (p.title || "").toLowerCase().includes(q) ||
                    (p.domain || "").toLowerCase().includes(q)
                  );
                })
                .map((p) => (
                  <div
                    key={p.id || p.slug}
                    className="border rounded-lg p-3 flex items-center justify-between"
                  >
                    <div>
                      <div className="font-medium">
                        {p.title || "Favorite Plan"}
                      </div>
                      <div className="text-xs opacity-70">
                        {(p.domain || "general")} ·{" "}
                        {(p.tags || []).join(", ")}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        className="btn"
                        onClick={() => {
                          busEmit("plan.save.modal.open", {
                            source: "Calendar.QuickAdd",
                            suggested: {
                              ...p,
                              title: p.title || "Favorite Plan",
                            },
                            tsISO: new Date().toISOString(),
                          });
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="btn primary"
                        onClick={async () => {
                          if (!qaDate) {
                            // eslint-disable-next-line no-alert
                            alert("Pick a date first");
                            return;
                          }
                          const evs = expandPlanToEvents(p, qaDate);
                          setBundleEvents((prev) => [...prev, ...evs]);
                          setFlash(
                            `✅ Applied “${
                              p.title || "Favorite Plan"
                            }” to ${qaDate}.`
                          );
                          clearTimeout(window.__flashTO);
                          window.__flashTO = setTimeout(
                            () => setFlash(""),
                            2500
                          );

                          // Optimistic backend apply (ignore errors)
                          try {
                            await fetch(`${API}/calendar/apply-plan`, {
                              method: "POST",
                              headers: {
                                "Content-Type": "application/json",
                              },
                              body: JSON.stringify({
                                planId: p.id,
                                date: qaDate,
                              }),
                            });
                          } catch {
                            // ignore
                          }

                          busEmit("plan.saved", {
                            planId: p.id,
                            domain: p.domain || "general",
                            title: p.title,
                            whenISO: qaDate,
                            target: "local",
                            source: "Calendar.ApplyPlan",
                          });
                          busEmit("calendar.refresh");
                        }}
                      >
                        Apply
                      </button>
                    </div>
                  </div>
                ))}
              {(!favorites || favorites.length === 0) && (
                <div className="text-sm opacity-70">
                  No favorites yet. Create a plan anywhere in the app, then
                  “Save as Favorite Plan”.
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* Undo for deletes */}
      <UndoToast
        open={undo.open}
        message="Event removed."
        onUndo={undoRemoval}
        onClose={() => setUndo({ open: false, payload: null })}
      />
    </div>
  );
}
