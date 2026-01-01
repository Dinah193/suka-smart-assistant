// C:\Users\larho\suka-smart-assistant\src\components\context\PlanDraftContext.jsx
// Provides a context around the meal-plan draft lifecycle with autosave, undo/redo,
// NBA emits, persistence, and orchestration glue.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import useMealPlanDraft, { createMealPlanDraft } from "../../hooks/useMealPlanDraft"; // you already added this
// Optional: light debounce to keep autosave snappy without chatty writes.
function debounce(fn, ms) {
  let t = null;
  return function (...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

/**
 * PlanDraftProvider props (DI-friendly)
 * deps: pass the same deps you would to useMealPlanDraft, plus storage/eventBus/analytics.
 */
const PlanDraftContext = createContext(null);

export function PlanDraftProvider({
  children,
  deps = {}, // { eventBus, analytics, storage, ... see useMealPlanDraft deps }
  storageKey = "suka:mealplan:draft",
  autosaveMs = 600,
  initialDraftOptions = { days: 7, dayparts: ["breakfast", "lunch", "dinner"] },
  loadExistingPlan = null, // optional: () => { slots:[...] } to seed from calendar/current plan
}) {
  // Compose hook with DI (keeps parity with the rest of your system)
  const draftEngineRef = useRef(null);
  if (!draftEngineRef.current) draftEngineRef.current = createMealPlanDraft(deps);

  const [hook] = useState(() => useMealPlanDraft(deps));
  const {
    draft,
    suggestions,
    newDraft,
    apply,
    remove,
    swap,
    fill,
    linkLeftovers,
    commit,
    abandon,
    openSlots,
    perDayTotals,
    grocerySignal,
  } = hook;

  // -------- undo / redo stacks (simple snapshots) -----------------------------
  const pastRef = useRef([]);
  const futureRef = useRef([]);

  const pushHistory = useCallback((snapshot) => {
    try {
      pastRef.current.push(snapshot);
      // cap history
      if (pastRef.current.length > 50) pastRef.current.shift();
      futureRef.current = [];
    } catch (_e) {}
  }, []);

  const canUndo = !!pastRef.current.length;
  const canRedo = !!futureRef.current.length;

  const undo = useCallback(() => {
    if (!pastRef.current.length || !draft) return false;
    const prev = pastRef.current.pop();
    futureRef.current.push(JSON.parse(JSON.stringify(draft)));
    // restore
    deps.eventBus && deps.eventBus.emit && deps.eventBus.emit("mealplan:draft:undo", { draftId: draft.id });
    setDraftSnapshot(prev);
    return true;
  }, [draft, deps.eventBus]);

  const redo = useCallback(() => {
    if (!futureRef.current.length || !draft) return false;
    const next = futureRef.current.pop();
    pastRef.current.push(JSON.parse(JSON.stringify(draft)));
    deps.eventBus && deps.eventBus.emit && deps.eventBus.emit("mealplan:draft:redo", { draftId: draft.id });
    setDraftSnapshot(next);
    return true;
  }, [draft, deps.eventBus]);

  // Internal method to replace the entire draft state via engine
  const setDraftSnapshot = useCallback((snapshot) => {
    // We use the underlying engine to avoid breaking hook invariants.
    // Rebuild a new engine draft from snapshot slots.
    // Strategy: build new draft shell -> overlay slots/fields -> set via local state setter
    const shell = draftEngineRef.current.buildDraft({
      startISO: snapshot?.meta?.startISO || undefined,
      days: snapshot?.meta?.days || undefined,
      dayparts: snapshot?.meta?.dayparts || undefined,
    });
    const rebuilt = Object.assign({}, shell, {
      id: snapshot.id || shell.id,
      slots: snapshot.slots || shell.slots,
      updatedAtISO: new Date().toISOString(),
      guards: snapshot.guards || shell.guards,
      meta: Object.assign({}, shell.meta, snapshot.meta || {}),
    });
    // We do not have a public setter from the hook; emulate by applying no-op then replacing internal state:
    // Instead of hacking the hook, we expose this context-controlled snapshot through a local mirror:
    setLocalOverride(rebuilt);
  }, []);

  const [localOverride, setLocalOverride] = useState(null);
  const effectiveDraft = localOverride || draft;

  // -------- autosave / rehydrate ---------------------------------------------
  const saveDraft = useCallback(
    debounce((d) => {
      try {
        if (!deps.storage || !deps.storage.set) return;
        deps.storage.set(storageKey, JSON.stringify(d));
        deps.analytics && deps.analytics.track && deps.analytics.track("mealplan/autosave", { id: d.id });
      } catch (_e) {}
    }, autosaveMs),
    [autosaveMs, deps.analytics, deps.storage, storageKey]
  );

  // Hydrate on first mount
  useEffect(() => {
    let seeded = false;
    try {
      if (deps.storage && deps.storage.get) {
        const raw = deps.storage.get(storageKey);
        if (raw) {
          const snap = JSON.parse(raw);
          setDraftSnapshot(snap);
          seeded = true;
        }
      }
    } catch (_e) {}
    if (!seeded) {
      // optionally seed from existing plan/calendar
      if (typeof loadExistingPlan === "function") {
        try {
          const plan = loadExistingPlan();
          if (plan && Array.isArray(plan.slots) && plan.slots.length) {
            const shell = draftEngineRef.current.buildDraft(initialDraftOptions || {});
            const overlay = Object.assign({}, shell, { slots: plan.slots, updatedAtISO: new Date().toISOString() });
            setLocalOverride(overlay);
            return;
          }
        } catch (_e) {}
      }
      // otherwise start fresh
      const d = draftEngineRef.current.buildDraft(initialDraftOptions || {});
      setLocalOverride(d);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist effective draft whenever it changes
  useEffect(() => {
    if (!effectiveDraft) return;
    saveDraft(effectiveDraft);
  }, [effectiveDraft, saveDraft]);

  // Keep localOverride in sync if user moves back into hook-driven changes
  useEffect(() => {
    if (!draft) return;
    // If we previously applied a local override, drop it when hook emits a newer draft (timestamp-aware)
    if (localOverride && draft.updatedAtISO > localOverride.updatedAtISO) {
      setLocalOverride(null);
    }
  }, [draft, localOverride]);

  // -------- action wrappers (push history, forward to hook, update override) --
  const wrapChange = useCallback(
    (mutator) => (...args) => {
      if (!effectiveDraft) return null;
      pushHistory(JSON.parse(JSON.stringify(effectiveDraft)));
      const res = mutator(...args);
      // If hook returned a next draft, prefer it; otherwise refresh from hook state
      if (res && res.slots) {
        setLocalOverride(res); // reflect change immediately; hook will catch up
      } else {
        setLocalOverride(null);
      }
      return res;
    },
    [effectiveDraft, pushHistory]
  );

  const onNewDraft = useCallback((opts) => {
    pastRef.current = [];
    futureRef.current = [];
    const d = draftEngineRef.current.buildDraft(opts || initialDraftOptions || {});
    setLocalOverride(d);
    deps.eventBus && deps.eventBus.emit && deps.eventBus.emit("mealplan:draft:new", { id: d.id });
    return d;
  }, [deps.eventBus, initialDraftOptions]);

  const onApply = wrapChange((where, recipeOrId, opts) => apply(where, recipeOrId, opts));
  const onRemove = wrapChange((slotId) => remove(slotId));
  const onSwap = wrapChange((a, b) => swap(a, b));
  const onFill = wrapChange((candidates, context, opts) => fill(candidates, context, opts)?.draft || null);
  const onLinkLeftovers = wrapChange(() => linkLeftovers());

  const onCommit = useCallback(() => {
    if (!effectiveDraft) return null;
    const res = commit(); // { plan, deltas }
    if (res && res.plan) {
      deps.eventBus && deps.eventBus.emit && deps.eventBus.emit("mealplan:finalize", { planId: res.plan.id });
      deps.analytics && deps.analytics.track && deps.analytics.track("mealplan/commit", { planId: res.plan.id });
      // keep draft; allow calling code to clear or we can automatically begin a new one:
      // setLocalOverride(null);
    }
    return res;
  }, [commit, deps.analytics, deps.eventBus, effectiveDraft]);

  const onAbandon = useCallback(() => {
    abandon();
    pastRef.current = [];
    futureRef.current = [];
    setLocalOverride(null);
    try {
      deps.storage && deps.storage.set && deps.storage.set(storageKey, "");
      deps.analytics && deps.analytics.track && deps.analytics.track("mealplan/abandon", {});
    } catch (_e) {}
    return true;
  }, [abandon, deps.analytics, deps.storage, storageKey]);

  // -------- external triggers via event bus ----------------------------------
  useEffect(() => {
    if (!deps.eventBus || !deps.eventBus.on || !deps.eventBus.off) return;

    function handleApply(evt) {
      if (!evt) return;
      onApply({ dateISO: evt.dateISO, daypart: evt.daypart }, evt.recipe || evt.recipeId, { servings: evt.servings, lock: evt.lock });
    }
    function handleSwap(evt) {
      if (!evt) return;
      onSwap(evt.a, evt.b);
    }
    function handleRemove(evt) {
      if (!evt) return;
      onRemove(evt.slotId);
    }
    function handleFill(evt) {
      if (!evt) return;
      onFill(evt.candidates || [], evt.context || {}, evt.opts || {});
    }
    function handleLinkLeftovers() { onLinkLeftovers(); }
    function handleCommit() { onCommit(); }
    function handleNew(evt) { onNewDraft(evt && evt.options); }
    function handleAbandon() { onAbandon(); }

    deps.eventBus.on("mealplan:apply:req", handleApply);
    deps.eventBus.on("mealplan:swap:req", handleSwap);
    deps.eventBus.on("mealplan:remove:req", handleRemove);
    deps.eventBus.on("mealplan:fill:req", handleFill);
    deps.eventBus.on("mealplan:leftovers:req", handleLinkLeftovers);
    deps.eventBus.on("mealplan:commit:req", handleCommit);
    deps.eventBus.on("mealplan:new:req", handleNew);
    deps.eventBus.on("mealplan:abandon:req", handleAbandon);

    return () => {
      deps.eventBus.off("mealplan:apply:req", handleApply);
      deps.eventBus.off("mealplan:swap:req", handleSwap);
      deps.eventBus.off("mealplan:remove:req", handleRemove);
      deps.eventBus.off("mealplan:fill:req", handleFill);
      deps.eventBus.off("mealplan:leftovers:req", handleLinkLeftovers);
      deps.eventBus.off("mealplan:commit:req", handleCommit);
      deps.eventBus.off("mealplan:new:req", handleNew);
      deps.eventBus.off("mealplan:abandon:req", handleAbandon);
    };
  }, [deps.eventBus, onAbandon, onApply, onCommit, onFill, onLinkLeftovers, onNewDraft, onRemove, onSwap]);

  // -------- “well executed sites” ergonomics (selectors) ---------------------
  const days = useMemo(() => {
    const d = effectiveDraft;
    if (!d) return [];
    const map = {};
    for (let i = 0; i < d.slots.length; i++) {
      const s = d.slots[i];
      if (!map[s.dateISO]) map[s.dateISO] = [];
      map[s.dateISO].push(s);
    }
    return Object.keys(map)
      .sort()
      .map((dateISO) => ({ dateISO, slots: map[dateISO].sort((a, b) => a.daypart.localeCompare(b.daypart)) }));
  }, [effectiveDraft]);

  const summaries = useMemo(() => {
    const d = effectiveDraft;
    if (!d) return {};
    const out = {};
    for (const day of days) {
      out[day.dateISO] = perDayTotals?.[day.dateISO] || { cost: { total: 0, currency: "USD" }, macros: { calories: 0, protein: 0, carbs: 0, fat: 0 } };
    }
    return out;
  }, [effectiveDraft, days, perDayTotals]);

  const quickChips = useMemo(() => {
    // Small UX helpers for header chips: # open slots, grocery signal, sabbath guard, etc.
    const open = (openSlots || []).length;
    const missingPct = Math.round((grocerySignal?.missingFrac || 0) * 100);
    const sabbath = effectiveDraft?.guards?.sabbathActive ? ["sabbath"] : [];
    return [
      { key: "open", label: `${open} open`, tone: open > 0 ? "warn" : "ok" },
      { key: "missing", label: `${missingPct}% missing`, tone: missingPct >= 35 ? "warn" : "info" },
      ...sabbath.map((k) => ({ key: k, label: "Sabbath", tone: "muted" })),
    ];
  }, [effectiveDraft, grocerySignal, openSlots]);

  // -------- context value -----------------------------------------------------
  const value = useMemo(
    () => ({
      // state
      draft: effectiveDraft,
      days,
      suggestions,
      perDayTotals: summaries,
      grocerySignal,
      quickChips,
      // actions
      newDraft: onNewDraft,
      apply: onApply,
      remove: onRemove,
      swap: onSwap,
      fill: onFill,
      linkLeftovers: onLinkLeftovers,
      commit: onCommit,
      abandon: onAbandon,
      // history
      undo,
      redo,
      canUndo,
      canRedo,
    }),
    [
      effectiveDraft,
      days,
      suggestions,
      summaries,
      grocerySignal,
      quickChips,
      onNewDraft,
      onApply,
      onRemove,
      onSwap,
      onFill,
      onLinkLeftovers,
      onCommit,
      onAbandon,
      undo,
      redo,
      canUndo,
      canRedo,
    ]
  );

  return <PlanDraftContext.Provider value={value}>{children}</PlanDraftContext.Provider>;
}

export function usePlanDraft() {
  const ctx = useContext(PlanDraftContext);
  if (!ctx) {
    throw new Error("usePlanDraft must be used within a PlanDraftProvider");
  }
  return ctx;
}
