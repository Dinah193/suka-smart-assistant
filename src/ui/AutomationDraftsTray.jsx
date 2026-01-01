// C:\Users\larho\suka-smart-assistant\src\ui\AutomationDraftsTray.jsx
//
// AutomationDraftsTray (Cooking + Cleaning Drafts)
// ------------------------------------------------
// - Cooking: real drafts (status:'draft') via CookingStore v3
// - Cleaning: synthesized "drafts" built from todaysReminders() + getOverdueZones()
//   so users can approve to start a session now (or schedule) even though CleaningStore
//   doesn’t persist true drafts yet.
//
// UX:
// - Sections: Cooking Drafts, Cleaning Drafts
// - Edit (Cooking) -> opens SessionDraftDetail modal
// - Approve (Cooking) -> Cooking.approveDraft (fires calendar sync intent)
// - Schedule at (Cooking) -> approves with chosen time
// - Approve (Cleaning) -> starts a session; if a preset exists, passes it
// - Schedule at (Cleaning) -> starts session + emits a calendar sync intent
// - Discard (both) -> Cooking cancels draft; Cleaning just hides (no-op)
//
// Safe dynamic imports. Graceful fallbacks if stores/agents unavailable.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ------------------------ Safe dynamic imports ------------------------ */
async function safeImport(paths = []) {
  for (const p of paths) {
    try {
      // @vite-ignore
      const mod = await import(p);
      return mod?.default || mod;
    } catch {}
  }
  return null;
}
async function CookingAPI() {
  const mod = await safeImport(["@/store/CookingStore.js", "@/store/CookingStore"]);
  // prefer named helper export "Cooking" from updated store
  return mod?.Cooking || mod;
}
async function CleaningAPI() {
  const mod = await safeImport(["@/store/CleaningStore.js", "@/store/CleaningStore"]);
  // default export has methods; named export Cleaning mirrors helpers
  return mod?.Cleaning || mod;
}

/* ------------------------------ Utils -------------------------------- */
const fmtTime = (iso) => {
  try {
    const d = new Date(iso);
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso || "";
  }
};
const mins = (n, fb = 90) => (Number.isFinite(+n) ? Math.max(0, Math.floor(+n)) : fb);

/* -------------------------- Small UI pieces --------------------------- */

function IconDot({ className = "" }) {
  return <span className={`inline-block w-2 h-2 rounded-full ${className}`} />;
}
function Pill({ children, tone = "default" }) {
  const tones = {
    default: "bg-gray-100 text-gray-700",
    warn: "bg-amber-100 text-amber-800",
    ok: "bg-emerald-100 text-emerald-800",
    info: "bg-sky-100 text-sky-800",
  };
  return (
    <span className={`px-2 py-0.5 text-xs rounded-full whitespace-nowrap ${tones[tone] || tones.default}`}>
      {children}
    </span>
  );
}
function SectionHeader({ title, count, tone = "info" }) {
  return (
    <div className="px-4 pt-4 pb-2 flex items-center gap-2">
      <h3 className="text-xs font-semibold text-gray-700">{title}</h3>
      {Number.isFinite(count) ? <Pill tone={tone}>{count}</Pill> : null}
    </div>
  );
}

/* --------------------------- Main component --------------------------- */

export default function AutomationDraftsTray({
  open: openProp = false,
  onClose,
  maxHeight = 600,
}) {
  const [open, setOpen] = useState(!!openProp);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Cooking
  const [cookingDrafts, setCookingDrafts] = useState([]);
  const [capacity, setCapacity] = useState(null); // { freezerQ, fridgeQ, pantryQ }

  // Cleaning synthesized drafts
  const [cleaningDrafts, setCleaningDrafts] = useState([]);

  const trayRef = useRef(null);

  // Keep internal open in sync with prop
  useEffect(() => setOpen(!!openProp), [openProp]);

  // Global open/close listeners
  useEffect(() => {
    const onOpen = (e) => { if (e?.detail?.id === "AutomationDrafts") setOpen(true); };
    const onCloseEvt = (e) => { if (e?.detail?.id === "AutomationDrafts") setOpen(false); };
    window.addEventListener("ui:tray:open", onOpen);
    window.addEventListener("ui:tray:close", onCloseEvt);
    return () => {
      window.removeEventListener("ui:tray:open", onOpen);
      window.removeEventListener("ui:tray:close", onCloseEvt);
    };
  }, []);

  // ESC to close
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { setOpen(false); onClose?.(); }
    };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  /* ---------------------------- Loaders ----------------------------- */

  const loadCookingDrafts = useCallback(async () => {
    const Cooking = await CookingAPI();
    if (!Cooking) { setCookingDrafts([]); setCapacity(null); return; }

    const listDrafts =
      Cooking.listDraftsThisWeek?.() ||
      (typeof Cooking.state === "object"
        ? (Cooking.state.week?.sessions || []).filter((s) => s.status === "draft")
        : []);

    const drafts = Array.isArray(listDrafts) ? listDrafts : (await listDrafts) || [];

    // capacity
    const st = Cooking.state || (await (async () => (typeof Cooking.getState === "function" ? Cooking.getState() : {}))());
    setCapacity(st?.capacity || null);

    const normalized = drafts
      .map((s) => ({
        id: s.id,
        title: s.title || "Draft Cooking Session",
        start: s.start,
        end: s.end,
        recipes: Array.isArray(s.recipes) ? s.recipes : [],
        storageHints: s.storageHints || {},
        labelTemplate: s.labelTemplate || null,
        safetyTimers: s.safetyTimers || null,
        notes: s.notes || "",
        status: s.status || "draft",
      }))
      .sort((a, b) => new Date(a.start) - new Date(b.start));

    setCookingDrafts(normalized);
  }, []);

  const loadCleaningDrafts = useCallback(async () => {
    const Cleaning = await CleaningAPI();
    if (!Cleaning) { setCleaningDrafts([]); return; }

    // 1) Today reminders -> lightweight “drafts”
    const reminders = await Cleaning.todaysReminders?.({}) || [];
    const remDrafts = reminders.map((r, i) => ({
      id: r.id || `rem_${i}`,
      title: r.label || "Cleaning reminder",
      type: r.type || "reminder",
      start: r.atISO, // suggested time today
      preset: r.preset || null,
      zones: r.zones || null,
      estMin: r.estMin || null,
      source: "reminder",
    }));

    // 2) Overdue zones → compact “drafts”
    const overdue = await Cleaning.getOverdueZones?.({ graceDays: 0, limit: 5 }) || [];
    const odDrafts = overdue.map((z, i) => ({
      id: `overdue_${z.id}_${i}`,
      title: `Overdue: ${z.name}`,
      type: "overdue",
      start: null,
      preset: "high-visibility-rooms",
      zones: [z.id],
      estMin: Math.min(15, 5 + (z.overdueBy || 1)),
      source: "overdue",
    }));

    setCleaningDrafts([...remDrafts, ...odDrafts]);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true); setError("");
    try {
      await Promise.all([loadCookingDrafts(), loadCleaningDrafts()]);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [loadCookingDrafts, loadCleaningDrafts]);

  // Initial + reactive refresh
  useEffect(() => { loadAll(); }, [loadAll]);

  // Refresh on cooking draft-related events
  useEffect(() => {
    const onDraftCreated = () => loadCookingDrafts();
    const onCookingUpdated = (e) => {
      const t = e?.detail?.type;
      if (!t) return;
      if (["draft:create", "draft:approve", "schedule", "cancel", "clearOld", "capacity"].includes(t)) {
        loadCookingDrafts();
      }
    };
    window.addEventListener("cooking:draft:created", onDraftCreated);
    window.addEventListener("cooking:updated", onCookingUpdated);
    return () => {
      window.removeEventListener("cooking:draft:created", onDraftCreated);
      window.removeEventListener("cooking:updated", onCookingUpdated);
    };
  }, [loadCookingDrafts]);

  /* ---------------------------- Actions ----------------------------- */
  const capacityWarnText = useCallback((hints, cap) => {
    if (!hints || !cap) return null;
    const over = [];
    if (Number(hints.freezerQ || 0) > Number(cap.freezerQ ?? Infinity)) over.push("freezer");
    if (Number(hints.fridgeQ || 0) > Number(cap.fridgeQ ?? Infinity)) over.push("fridge");
    if (Number(hints.pantryQ || 0) > Number(cap.pantryQ ?? Infinity)) over.push("pantry");
    if (!over.length) return null;
    return `May exceed ${over.join(", ")} capacity`;
  }, []);

  // Cooking
  const onEditCooking = useCallback((sessionId) => {
    try {
      window.dispatchEvent(new CustomEvent("ui:modal:open", { detail: { id: "SessionDraftDetail", sessionId } }));
    } catch {}
  }, []);
  const onApproveCooking = useCallback(async (sessionId, overrideIso) => {
    setLoading(true);
    try {
      const Cooking = await CookingAPI();
      if (Cooking?.approveDraft) {
        await Cooking.approveDraft(sessionId, overrideIso ? { scheduleAtIso: overrideIso } : undefined);
      } else {
        window.dispatchEvent(new CustomEvent("automation:intent", {
          detail: { intent: "cooking/draft/approve", id: sessionId, start: overrideIso }
        }));
      }
    } catch (e) {
      setError(String(e?.message || e));
    } finally { setLoading(false); }
  }, []);
  const onDiscardCooking = useCallback(async (sessionId) => {
    setLoading(true);
    try {
      window.dispatchEvent(new CustomEvent("automation:intent", {
        detail: { intent: "cooking/session/cancel", id: sessionId }
      }));
    } catch (e) { setError(String(e?.message || e)); } finally { setLoading(false); }
  }, []);

  // Cleaning (approve = start session, schedule emits calendar intent)
  const onApproveCleaning = useCallback(async (draft, scheduleIso) => {
    setLoading(true);
    try {
      const Cleaning = await CleaningAPI();
      // Start immediately (session title reflects source)
      await Cleaning.startSession?.({
        title: draft.title || "Cleaning Session",
        preset: draft.preset || null,
      });

      // If a schedule time was chosen, nudge calendar to reflect this plan
      if (scheduleIso) {
        window.dispatchEvent(new CustomEvent("automation:intent", {
          detail: {
            intent: "calendar/sync",
            context: {
              source: "cleaning",
              id: draft.id,
              title: draft.title || "Cleaning Session",
              start: scheduleIso,
              end: scheduleIso ? new Date(new Date(scheduleIso).getTime() + mins(draft.estMin || 30) * 60000).toISOString() : null,
              tags: ["cleaning", "session", draft.type || "draft"],
            },
          },
        }));
      }

      // Refresh cleaning drafts to remove the approved suggestion
      setCleaningDrafts((prev) => prev.filter((d) => d.id !== draft.id));
    } catch (e) {
      setError(String(e?.message || e));
    } finally { setLoading(false); }
  }, []);
  const onDiscardCleaning = useCallback(async (id) => {
    // Just hide the synthesized draft
    setCleaningDrafts((prev) => prev.filter((d) => d.id !== id));
  }, []);

  const emptyCooking = !cookingDrafts.length;
  const emptyCleaning = !cleaningDrafts.length;
  const allEmpty = emptyCooking && emptyCleaning;

  /* ------------------------------ Render ---------------------------- */
  return (
    <div
      aria-live="polite"
      className={`fixed z-40 right-4 bottom-4 w-[400px] max-w-[92vw] shadow-2xl rounded-2xl border border-gray-200 bg-white transition-all ${
        open ? "opacity-100 translate-y-0" : "pointer-events-none opacity-0 translate-y-3"
      }`}
      style={{ maxHeight }}
      ref={trayRef}
    >
      <header className="px-4 py-3 flex items-center justify-between border-b border-gray-100">
        <div className="flex items-center gap-2">
          <IconDot className={allEmpty ? "bg-gray-300" : "bg-amber-500"} />
          <h2 className="text-sm font-semibold">Automation Drafts</h2>
          {!allEmpty && <Pill tone="info">{(cookingDrafts.length + cleaningDrafts.length)} pending</Pill>}
        </div>
        <div className="flex items-center gap-2">
          {loading && <span className="text-xs text-gray-500">updating…</span>}
          <button
            onClick={() => { setOpen(false); onClose?.(); }}
            className="text-gray-500 hover:text-gray-700 rounded-md p-1"
            aria-label="Close drafts tray"
            title="Close"
          >
            ✕
          </button>
        </div>
      </header>

      <div className="overflow-y-auto" style={{ maxHeight: maxHeight - 48 }}>
        {/* Error banner */}
        {error ? (
          <div className="mx-4 mt-3 mb-2 rounded-lg bg-rose-50 text-rose-800 text-xs p-3">{error}</div>
        ) : null}

        {/* COOKING DRAFTS */}
        <SectionHeader title="Cooking Drafts" count={cookingDrafts.length} tone="info" />
        {!emptyCooking ? (
          <ul className="divide-y divide-gray-100">
            {cookingDrafts.map((d) => {
              const warn = capacityWarnText(d.storageHints, capacity);
              return (
                <li key={d.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium text-sm">{d.title}</div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {d.start ? `Planned: ${fmtTime(d.start)}` : "No start time yet"}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Pill tone="default">
                          {d.recipes?.length || 0} recipe{(d.recipes?.length || 0) === 1 ? "" : "s"}
                        </Pill>
                        {d.labelTemplate?.prefix ? <Pill tone="info">Label: {d.labelTemplate.prefix}</Pill> : null}
                        {warn ? <Pill tone="warn">{warn}</Pill> : null}
                      </div>
                    </div>
                    <div className="flex flex-col gap-2">
                      <button
                        onClick={() => onEditCooking(d.id)}
                        className="text-xs px-3 py-1 rounded-md border border-gray-300 hover:bg-gray-50"
                        title="Edit draft details"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => onApproveCooking(d.id)}
                        className="text-xs px-3 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700"
                        title="Approve and sync to calendar"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => onDiscardCooking(d.id)}
                        className="text-[11px] px-2.5 py-1 rounded-md text-rose-700 hover:bg-rose-50"
                        title="Discard this draft"
                      >
                        Discard
                      </button>
                    </div>
                  </div>

                  {/* Quick schedule line */}
                  <div className="mt-3 flex items-center gap-2">
                    <label className="text-xs text-gray-600">Schedule at</label>
                    <input
                      type="datetime-local"
                      className="text-xs border rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-amber-400"
                      onChange={(e) => {
                        const v = e.target.value;
                        const iso = v ? new Date(v).toISOString() : null;
                        if (iso) onApproveCooking(d.id, iso);
                      }}
                    />
                  </div>

                  {/* Recipe line preview */}
                  {Array.isArray(d.recipes) && d.recipes.length ? (
                    <div className="mt-3 bg-gray-50 rounded-lg p-2">
                      <div className="text-[11px] text-gray-500 mb-1">Recipes</div>
                      <div className="flex flex-wrap gap-1">
                        {d.recipes.slice(0, 6).map((r, i) => (
                          <span key={r?.id || `${d.id}_r${i}`} className="text-[11px] px-2 py-0.5 rounded-full bg-white border">
                            {r?.title || "Untitled"}{r?.station ? ` · ${r.station}` : ""}
                          </span>
                        ))}
                        {d.recipes.length > 6 ? (
                          <span className="text-[11px] text-gray-500">+{d.recipes.length - 6} more</span>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="px-4 pb-2 text-[11px] text-gray-500">No cooking drafts.</div>
        )}

        {/* CLEANING DRAFTS */}
        <SectionHeader title="Cleaning Drafts" count={cleaningDrafts.length} tone="info" />
        {!emptyCleaning ? (
          <ul className="divide-y divide-gray-100">
            {cleaningDrafts.map((d) => (
              <li key={d.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-sm">{d.title}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {d.start ? `Suggested: ${fmtTime(d.start)}` : "No time suggested"}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {d.type ? <Pill tone="default">{d.type}</Pill> : null}
                      {Array.isArray(d.zones) && d.zones.length ? (
                        <Pill tone="info">{d.zones.slice(0, 3).join(", ")}{d.zones.length > 3 ? "…" : ""}</Pill>
                      ) : null}
                      {d.estMin ? <Pill tone="default">{d.estMin} min</Pill> : null}
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={() => onApproveCleaning(d)}
                      className="text-xs px-3 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700"
                      title="Approve and start cleaning session"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => onDiscardCleaning(d.id)}
                      className="text-[11px] px-2.5 py-1 rounded-md text-rose-700 hover:bg-rose-50"
                      title="Discard this cleaning draft"
                    >
                      Discard
                    </button>
                  </div>
                </div>

                {/* Quick schedule line for calendar (optional) */}
                <div className="mt-3 flex items-center gap-2">
                  <label className="text-xs text-gray-600">Schedule at</label>
                  <input
                    type="datetime-local"
                    className="text-xs border rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-amber-400"
                    onChange={(e) => {
                      const v = e.target.value;
                      const iso = v ? new Date(v).toISOString() : null;
                      if (iso) onApproveCleaning(d, iso);
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-4 pb-4 text-[11px] text-gray-500">No cleaning drafts right now.</div>
        )}

        {/* Fully empty helper */}
        {allEmpty ? (
          <div className="px-4 pb-6">
            <div className="text-sm font-medium text-gray-700">No drafts yet</div>
            <p className="text-xs text-gray-500 mt-1">
              When your agents propose sessions, they’ll appear here for quick approval.
            </p>
            <div className="mt-4 flex items-center gap-2">
              <button
                className="text-xs px-3 py-2 rounded-md bg-amber-600 text-white hover:bg-amber-700"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent("automation:intent", {
                    detail: { intent: "cooking/draft/new", title: "Quick Batch Session", durationMins: 90, recipes: [] }
                  }))
                }
              >
                New cooking draft
              </button>
              <button
                className="text-xs px-3 py-2 rounded-md border hover:bg-gray-50"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent("automation:intent", {
                    detail: { intent: "cleaning/quickReset" }
                  }))
                }
              >
                Quick reset
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Footer quick actions */}
      <footer className="px-4 py-3 border-t border-gray-100 flex items-center justify-between">
        <div className="text-[11px] text-gray-500">
          Approving cooking drafts schedules them; approving cleaning drafts starts a session (optional calendar sync).
        </div>
        <div className="flex items-center gap-2">
          <button
            className="text-xs px-2.5 py-1 rounded-md border hover:bg-gray-50"
            onClick={() => loadAll()}
            title="Refresh"
          >
            Refresh
          </button>
          <button
            className="text-xs px-2.5 py-1 rounded-md border hover:bg-gray-50"
            onClick={() => setOpen(false) || onClose?.()}
            title="Close tray"
          >
            Close
          </button>
        </div>
      </footer>
    </div>
  );
}
