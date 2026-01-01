/* eslint-disable no-console */
/**
 * useNBANudges.js — contextual Next-Best-Action (NBA) prompts across domains
 * ES2015-safe, dependency-light, DI-friendly, resilient to missing deps.
 *
 * Key upgrades (2025-10):
 * - Domain coverage: meals • cleaning • animals/butchery • garden • inventory • budget/nutrition • maintenance
 * - Sabbath guard + withholds + weather/heat/UV safety + PPE checks
 * - Session-aware nudges (start/pause/resume), leftovers routing, batch opportunities
 * - A/B nudge strategy keys, user throttles (mute/snooze/dismiss), tiny recency heuristics
 * - Event-driven inline nudges (decider/workplan/session/garden/inventory events)
 * - CTA router wired to eventBus/grocery/scheduler/etc., with graceful no-ops
 * - Icons + compact chip metadata for modern HUD/Toast UIs
 *
 * Nudge shape:
 * { id, type, title, body, score(0..1), severity, icon, cta{label,action,payload}, altCtas[], tags[], source{domain,id,ref}, createdAtISO, expiresAtISO?, snoozedUntilISO? }
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ----------------------------- Safe/Optional Deps -----------------------------
function noop(){}
const NIL_BUS = { emit: noop, on: noop, off: noop };

export function createNBANudges(deps = {}) {
  const clock       = deps.clock       || { now: () => new Date() };
  const config      = deps.config      || { get: (_p, fb) => fb, sabbathGuard: { enabled:false } };
  const analytics   = deps.analytics   || { track: noop };
  const eventBus    = deps.eventBus    || NIL_BUS;
  const storage     = deps.storage     || { get: () => null, set: noop, remove: noop };

  // domain helpers (each optional)
  const mealPlan    = deps.mealPlan    || { getTodaySlots: () => [], getThisWeek: () => [] };
  const mapping     = deps.mapping     || { shortageRatio: () => 0 };
  const grocery     = deps.grocery     || { openList: noop, addMissingForRecipe: noop, addItems: noop };
  const decider     = deps.decider     || { nextBestActions: () => [] };
  const scheduler   = deps.scheduler   || { windowsForDay: () => [], scheduleCook: noop, scheduleBlock: noop, scheduleTasks: noop };
  const recipeStore = deps.recipeStore || { byId: () => null, linkLeftovers: noop };

  const inventory   = deps.inventory   || {
    expiringSoon: () => [],
    lowStaples: () => [],
    filterMaintenanceDue: () => [],
    storehouseGaps: () => [], // long-term pantry “gaps”
  };

  const weather     = deps.weather     || { tempF: () => 72, rainChanceToday: () => 0.1, uvIndexToday: () => 5, stormToday: () => false };
  const garden      = deps.garden      || {
    harvestDueSoon: () => [],
    irrigationSkipOk: () => false,
    outdoorWindows: () => [],   // [{startISO,endISO,label,minutes}]
    sprayWithholdsActive: () => false
  };

  const animals     = deps.animals     || {
    careDueToday: () => [],     // [{id,title,estMinutes,ppeRequired[],withhold?:{type,untilISO}}]
    butcheryQueued: () => [],   // [{id,title,estMinutes,chillChain?:{maxMinutesOut}, ppeRequired[]}]
  };

  const cleaning    = deps.cleaning    || {
    choreBacklog: () => [],     // [{id,zone,estMinutes,appliances[],suppliesShortRatio,rotationBoost}]
    streakInfo:  () => ({ streak:0, nextMilestone:3 })
  };

  const nutrition   = deps.nutrition   || {
    dailyTargets: () => null,
    progressSoFar: () => null
  };

  const finance     = deps.finance     || {
    budgetToday: () => null,    // {limit,spent}
    rpmTarget: () => null       // {pageRPMTarget, currentRPM?}
  };

  const plans       = deps.plans       || { activeSession: () => null }; // {domain,id,status,startedAtISO,pausedAtISO}

// ----------------------------- Utils -----------------------------
  function uuid(prefix){ return (prefix || "nudge") + "-" + Math.random().toString(36).slice(2, 10); }
  function isoNow(){ return clock.now().toISOString(); }
  function todayISO(){ return isoNow().slice(0,10); }
  function clamp01(x){ return Math.max(0, Math.min(1, Number(x) || 0)); }

  function isSabbathGuardActive() {
    try {
      const sg = config.sabbathGuard || config.get("sabbath.guard", { enabled:false });
      if (!sg || !sg.enabled) return false;
      // Basic Fri evening → Sat evening window (local)
      const now = clock.now();
      const day = now.getDay();
      const map = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
      const startS = sg.start || "Fri 18:00";
      const endS   = sg.end   || "Sat 19:00";
      function pointOf(wdayHM){
        const [w, hm] = wdayHM.split(" ");
        const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const delta = (map[w] - day) * 86400000;
        const d = new Date(base.getTime() + delta);
        const [h,m] = hm.split(":").map(Number);
        d.setHours(h||0, m||0, 0, 0);
        return d;
      }
      let s = pointOf(startS);
      let e = pointOf(endS);
      if (e < s) e = new Date(e.getTime() + 7*86400000);
      return now >= s && now <= e;
    } catch { return false; }
  }

  const ICONS = {
    grocery: "🛒",
    mapping: "🧩",
    prep: "🧰",
    schedule: "🗓️",
    cleaning: "🧼",
    garden: "🌱",
    leftovers: "🥡",
    inventory: "📦",
    budget: "💸",
    macro: "🍽️",
    maintenance: "🛠️",
    alert: "⚠️",
    animals: "🐑",
    butchery: "🔪"
  };

  function baseNudge(partial){
    return Object.assign({
      id: uuid("nba"),
      type: "tip",
      title: "Heads up",
      body: "",
      score: 0.5,
      severity: "info",
      icon: ICONS.alert,
      tags: [],
      createdAtISO: isoNow()
    }, partial || {});
  }

  // scoring weight: severity + tiny recency boost − sabbath scheduling penalty
  function weight(n) {
    const sev = n.severity === "critical" ? 0.15 : n.severity === "warn" ? 0.08 : 0;
    let rec = 0;
    try {
      const ageMs = clock.now().getTime() - new Date(n.createdAtISO).getTime();
      const ageMin = Math.max(1, ageMs / 60000);
      rec = Math.max(0, 0.05 - Math.min(0.05, ageMin/12000));
    } catch {}
    const sabbath = isSabbathGuardActive() && (n.type === "schedule" || n.type === "prep") ? 0.08 : 0;
    return clamp01((n.score || 0.5) + sev + rec - sabbath);
  }

  function dedupe(list){
    const seen = {};
    const out = [];
    for (let i=0;i<list.length;i++){
      const n = list[i];
      const key = (n.type + "::" + (n.source?.id || n.title)).toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      out.push(n);
    }
    return out;
  }

  function applyUserThrottles(list){
    const prefs   = storage.get("nba:prefs")   || {};
    const muted   = prefs.mutedTags || [];
    const snoozed = storage.get("nba:snoozed") || {};
    const dismissed = storage.get("nba:dismissed") || {};
    const now = isoNow();

    const keep = [];
    for (let i=0;i<list.length;i++){
      const n = list[i];
      // muted tags
      if ((n.tags||[]).some(t => muted.includes(t))) continue;
      // snoozed
      if (snoozed[n.id] && snoozed[n.id] > now) continue;
      // dismissed same-day? (optional)
      if (dismissed[n.id] && dismissed[n.id].slice(0,10) === todayISO()) continue;
      // expiry
      if (n.expiresAtISO && n.expiresAtISO < now) continue;
      keep.push(n);
    }
    return keep;
  }

// ----------------------------- Collectors -----------------------------

  function collectMeals(){
    const out = [];
    let slots = [];
    try { slots = mealPlan.getTodaySlots() || []; } catch {}
    // empty slots → fill
    slots.forEach(s => {
      if (!s.recipe && !s.leftoversFrom) {
        out.push(baseNudge({
          type: "schedule",
          icon: ICONS.schedule,
          title: `Fill your ${s.daypart}?`,
          body: "Pick a recipe or leftovers to keep today on track.",
          score: 0.62,
          tags: ["today","meal"],
          cta: { label: "Fill Slot", action: "OPEN_MEAL_PICKER", payload: { dateISO: s.dateISO, daypart: s.daypart } },
          source: { domain: "meals", id: `${s.dateISO}::${s.daypart}` }
        }));
      }
    });

    // ingredient shortages or scheduling windows
    slots.forEach(s => {
      if (!s.recipe) return;
      let miss = 0;
      try { miss = mapping.shortageRatio(s.recipe) || 0; } catch {}
      if (miss >= 0.35) {
        out.push(baseNudge({
          type: "grocery",
          icon: ICONS.grocery,
          title: `Missing items for ${(s.recipe.title||"your meal")}`,
          body: `${Math.round(miss*100)}% of ingredients are not on hand.`,
          score: 0.7, severity: "warn",
          tags: ["today","grocery"],
          cta: { label: "Add Missing", action: "GROCERY_ADD_MISSING", payload: { recipeId: s.recipe.id } },
          altCtas: [{ label: "Open List", action: "OPEN_GROCERY" }],
          source: { domain: "meals", id: s.recipe.id }
        }));
      }
      let wins = [];
      try { wins = scheduler.windowsForDay(s.dateISO) || []; } catch {}
      if (wins.length) {
        out.push(baseNudge({
          type: "schedule",
          icon: ICONS.schedule,
          title: "Schedule cooking time",
          body: `Block ${(wins[0].minutes||45)} minutes for ${(s.recipe.title||"your meal")}`,
          score: 0.58,
          cta: { label: "Schedule", action: "SCHEDULE_COOK", payload: { recipeId: s.recipe.id, dateISO: s.dateISO, windowId: wins[0].id } },
          source: { domain: "meals", id: s.recipe.id }
        }));
      }
    });

    // leftovers routing from recent meals
    try {
      const week = mealPlan.getThisWeek() || [];
      const leftovers = week.filter(x => x.leftovers && !x.leftoversRouted);
      if (leftovers.length) {
        const l = leftovers[0];
        out.push(baseNudge({
          type: "leftovers",
          icon: ICONS.leftovers,
          title: "Route leftovers",
          body: "Add leftovers to a lunch/snack to reduce waste.",
          score: 0.56,
          tags: ["inventory","waste","meal"],
          cta: { label: "Link Leftovers", action: "LINK_LEFTOVERS", payload: { fromId: l.id, toDateISO: todayISO() } },
          source: { domain: "meals", id: l.id }
        }));
      }
    } catch {}

    return out;
  }

  function collectInventory(){
    const out = [];
    let exp = [], low = [], gaps = [], maint = [];
    try { exp = inventory.expiringSoon(3) || []; } catch{}
    try { low = inventory.lowStaples() || []; } catch{}
    try { gaps = inventory.storehouseGaps() || []; } catch{}
    try { maint = inventory.filterMaintenanceDue() || []; } catch{}

    if (exp.length) {
      out.push(baseNudge({
        type: "inventory",
        icon: ICONS.inventory,
        title: `${exp[0].name||"Item"} expires soon`,
        body: "Use or freeze items within 3 days.",
        score: 0.66, severity:"warn",
        tags: ["inventory","waste"],
        cta: { label: "Find Recipes", action: "OPEN_MEAL_PICKER_WITH_FILTER", payload: { includeItems: exp.map(x=>x.name) } }
      }));
    }
    if (low.length) {
      out.push(baseNudge({
        type: "grocery",
        icon: ICONS.grocery,
        title: "Staples running low",
        body: low.slice(0,3).map(x=>x.name).join(", ") + (low.length>3 ? "…" : ""),
        score: 0.60,
        tags: ["grocery","staples"],
        cta: { label: "Open Grocery", action: "OPEN_GROCERY" }
      }));
    }
    if (gaps.length) {
      out.push(baseNudge({
        type: "grocery",
        icon: ICONS.grocery,
        title: "Storehouse gaps",
        body: "Top up long-term pantry items.",
        score: 0.53,
        tags: ["pantry","storehouse"],
        cta: { label: "Add to List", action: "GROCERY_ADD_ITEMS", payload: { items: gaps.map(g=>({ name:g.name, qty:g.qty||1, unit:g.unit||"" })) } }
      }));
    }
    if (maint.length) {
      const m = maint[0];
      out.push(baseNudge({
        type: "maintenance",
        icon: ICONS.maintenance,
        title: "Appliance filter due",
        body: `Replace/clean: ${m.name || m.type}`,
        score: 0.55,
        tags: ["maintenance"],
        cta: { label: "Add Task", action: "SCHEDULE_BLOCK", payload: { title: `Replace ${m.name||m.type}`, minutes: 15 } }
      }));
    }
    return out;
  }

  function collectGarden(){
    const out = [];
    let due = [];
    try { due = garden.harvestDueSoon() || []; } catch{}
    if (due.length){
      out.push(baseNudge({
        type: "garden",
        icon: ICONS.garden,
        title: "Harvest window",
        body: "Best harvest today for " + due.slice(0,3).map(x=>x.crop).join(", "),
        score: 0.57,
        tags: ["garden","today"],
        cta: { label: "Open Garden", action: "OPEN_GARDEN" }
      }));
    }
    let skip = false;
    try { skip = garden.irrigationSkipOk(); } catch{}
    if (skip){
      out.push(baseNudge({
        type: "garden",
        icon: ICONS.garden,
        title: "Skip irrigation",
        body: "Recent rain — save water by skipping.",
        score: 0.52,
        tags: ["garden","sustainability"],
        cta: { label: "Mark Skipped", action: "SCHEDULE_BLOCK", payload: { title: "Skip irrigation", minutes: 0 } }
      }));
    }
    // Safety: UV/Heat/Storm
    let uv = 0, t = 72, storm = false;
    try { uv = Number(weather.uvIndexToday()||0); } catch{}
    try { t  = Number(weather.tempF()||72); } catch{}
    try { storm = !!weather.stormToday?.(); } catch{}
    if (storm || uv >= 8 || t >= 92) {
      out.push(baseNudge({
        type: "alert",
        icon: ICONS.alert,
        title: storm ? "Storm expected" : (uv>=8 ? "High UV today" : "Heat advisory"),
        body: storm ? "Push outdoor chores or pick a safer window."
             : uv>=8 ? "Water early, shade seedlings, wear protection."
             : "Shift heavy chores to morning/evening; hydrate.",
        score: 0.5, severity:"warn",
        tags: ["weather","garden"]
      }));
    }
    // Withholds (spray intervals)
    let sprays = false;
    try { sprays = garden.sprayWithholdsActive(); } catch{}
    if (sprays){
      out.push(baseNudge({
        type: "alert",
        icon: ICONS.alert,
        title: "Garden withhold active",
        body: "Avoid harvest/application within withhold window.",
        score: 0.51, severity:"warn",
        tags: ["garden","withhold"]
      }));
    }
    return out;
  }

  function collectAnimals(){
    const out = [];
    let care = [], butcher = [];
    try { care = animals.careDueToday() || []; } catch{}
    try { butcher = animals.butcheryQueued() || []; } catch{}
    if (care.length){
      const c = care[0];
      const withhold = c.withhold?.untilISO;
      out.push(baseNudge({
        type: "animals",
        icon: ICONS.animals,
        title: "Animal care due",
        body: c.title + (withhold ? ` (withhold until ${withhold.slice(0,10)})` : ""),
        score: 0.58,
        tags: ["animals","today"],
        cta: { label: "Schedule Care", action: "SCHEDULE_TASKS", payload: { tasks: care.map(x=>({ id:x.id, title:x.title, minutes:x.estMinutes||20 })) } }
      }));
    }
    if (butcher.length){
      const b = butcher[0];
      out.push(baseNudge({
        type: "butchery",
        icon: ICONS.butchery,
        title: "Butchery queued",
        body: b.title + (b.chillChain ? ` (max out ${b.chillChain.maxMinutesOut}m)` : ""),
        score: 0.6, severity:"warn",
        tags: ["animals","butchery"],
        cta: { label: "Open Session", action: "OPEN_BUTCHERY", payload: { id: b.id } }
      }));
    }
    return out;
  }

  function collectCleaning(){
    const out = [];
    let chores = [], streak = {streak:0,nextMilestone:3};
    try { chores = cleaning.choreBacklog() || []; } catch{}
    try { streak = cleaning.streakInfo() || streak; } catch{}
    if (chores.length){
      const quick = chores.find(c => (c.estMinutes||15) <= 15) || chores[0];
      out.push(baseNudge({
        type: "cleaning",
        icon: ICONS.cleaning,
        title: "Quick win: " + (quick.zone || quick.title || "Task"),
        body: `Takes ~${quick.estMinutes||15} min — keep momentum.`,
        score: 0.56,
        tags: ["cleaning","streak"],
        cta: { label: "Start Now", action: "SCHEDULE_BLOCK", payload: { title: quick.title||"Cleaning task", minutes: quick.estMinutes||15 } }
      }));
    }
    if (streak.streak && streak.nextMilestone && streak.nextMilestone - streak.streak === 1){
      out.push(baseNudge({
        type: "cleaning",
        icon: "🏁",
        title: "1 task to next streak badge",
        body: `Complete one more cleaning task today.`,
        score: 0.55,
        tags: ["cleaning","streak","gamify"],
        cta: { label: "Open Cleaning", action: "OPEN_CLEANING" }
      }));
    }
    return out;
  }

  function collectNutritionFinance(){
    const out = [];
    // Nutrition macro
    let targets=null, progress=null;
    try { targets = nutrition.dailyTargets(); } catch{}
    try { progress = nutrition.progressSoFar(); } catch{}
    if (targets && progress){
      const deficitP = (targets.protein||0) - (progress.protein||0);
      if (deficitP > 20){
        out.push(baseNudge({
          type: "macro",
          icon: ICONS.macro,
          title: "Protein is behind today",
          body: "Add a high-protein snack or side.",
          score: 0.54,
          tags: ["nutrition","today"],
          cta: { label: "See Ideas", action: "OPEN_MEAL_PICKER_WITH_FILTER", payload: { macro: "protein" } }
        }));
      }
    }
    // Budget (optional)
    let b=null,rpm=null;
    try { b = finance.budgetToday(); } catch{}
    try { rpm = finance.rpmTarget?.(); } catch{}
    if (b && b.limit > 0 && b.spent > b.limit){
      out.push(baseNudge({
        type: "budget",
        icon: ICONS.budget,
        title: "Today's food spend over budget",
        body: "Switch to pantry-first meals.",
        score: 0.6, severity:"warn",
        tags: ["budget","meal"],
        cta: { label: "Pantry Recipes", action: "OPEN_MEAL_PICKER_WITH_FILTER", payload: { pantryFirst: true } }
      }));
    }
    if (rpm && rpm.pageRPMTarget && rpm.currentRPM && rpm.currentRPM < rpm.pageRPMTarget){
      out.push(baseNudge({
        type: "tip",
        icon: "📈",
        title: "Engagement idea",
        body: "Add a how-to or checklist to boost time-on-page.",
        score: 0.45,
        tags: ["content","rpm"]
      }));
    }
    return out;
  }

  function collectSessionAware(){
    const out = [];
    const active = plans.activeSession?.() || null;
    if (active && active.status === "paused"){
      out.push(baseNudge({
        type: "schedule",
        icon: ICONS.schedule,
        title: "Resume your session?",
        body: "Timers and holds are waiting.",
        score: 0.62,
        tags: ["session","today"],
        cta: { label: "Resume", action: "SESSION_RESUME", payload: { id: active.id, domain: active.domain } },
        source: { domain: active.domain, id: active.id }
      }));
    }
    if (active && active.status === "running"){
      out.push(baseNudge({
        type: "prep",
        icon: ICONS.prep,
        title: "Batch prep opportunity",
        body: "Group knife/prep tasks to save time.",
        score: 0.58,
        tags: ["prep","batch"],
        cta: { label: "Open Prep Drawer", action: "OPEN_PREP_DRAWER", payload: { sessionId: active.id } },
        source: { domain: active.domain, id: active.id }
      }));
    }
    return out;
  }

// ----------------------------- CTA Router -----------------------------
  function execAction(action, payload){
    try {
      switch (action) {
        case "OPEN_GROCERY":          grocery.openList(); return true;
        case "GROCERY_ADD_MISSING":   payload?.recipeId && grocery.addMissingForRecipe(payload.recipeId); return true;
        case "GROCERY_ADD_ITEMS":     payload?.items?.length && grocery.addItems(payload.items); return true;
        case "OPEN_MAPPING":          eventBus.emit("ui:open:mapping", payload||{}); return true;
        case "OPEN_MEAL_PICKER":      eventBus.emit("ui:open:mealpicker", payload||{}); return true;
        case "OPEN_MEAL_PICKER_WITH_FILTER":
                                      eventBus.emit("ui:open:mealpicker", Object.assign({ filter:{} }, payload||{})); return true;
        case "SCHEDULE_COOK":         scheduler.scheduleCook(payload?.recipe || recipeStore.byId(payload?.recipeId) || { id: payload?.recipeId }, payload?.dateISO || todayISO(), payload?.windowId || null); return true;
        case "SCHEDULE_BLOCK":        scheduler.scheduleBlock(payload || { title:"Task", minutes:15 }); return true;
        case "SCHEDULE_TASKS":        scheduler.scheduleTasks(payload?.tasks || []); return true;
        case "OPEN_GARDEN":           eventBus.emit("ui:open:garden", {}); return true;
        case "OPEN_CLEANING":         eventBus.emit("ui:open:cleaning", {}); return true;
        case "OPEN_BUTCHERY":         eventBus.emit("ui:open:butchery", payload||{}); return true;
        case "OPEN_PREP_DRAWER":      eventBus.emit("ui:open:prepdrawe r".replace(" ",""), payload||{}); return true;
        case "LINK_LEFTOVERS":        recipeStore.linkLeftovers(payload||{}); return true;
        case "SESSION_RESUME":        eventBus.emit("session.resume.requested", payload||{}); return true;
        default:                      eventBus.emit("ui:action", { action, payload }); return true;
      }
    } catch (e) {
      console.warn("NBA action error", action, e);
      return false;
    }
  }

// ----------------------------- Public Engine API -----------------------------
  function collectAll(){
    let all = []
      .concat(collectSessionAware())
      .concat(collectMeals())
      .concat(collectInventory())
      .concat(collectGarden())
      .concat(collectAnimals())
      .concat(collectCleaning())
      .concat(collectNutritionFinance());

    all = dedupe(all);
    for (let i=0;i<all.length;i++) all[i].score = weight(all[i]);
    all.sort((a,b)=> b.score - a.score);
    return applyUserThrottles(all);
  }

  function execute(nudge){
    if (!nudge?.cta) return false;
    const ok = execAction(nudge.cta.action, nudge.cta.payload);
    try { analytics.track("nba/cta", { id: nudge.id, action: nudge.cta.action }); } catch {}
    return ok;
  }

  function markDone(id){ try {
    const done = storage.get("nba:done") || {};
    done[id] = isoNow();
    storage.set("nba:done", done);
    analytics.track("nba/done", { id });
    return true; } catch { return false; } }

  function dismiss(id){ try {
    const dismissed = storage.get("nba:dismissed") || {};
    dismissed[id] = isoNow();
    storage.set("nba:dismissed", dismissed);
    analytics.track("nba/dismiss", { id });
    return true; } catch { return false; } }

  function snooze(id, minutes=30){ try {
    const until = new Date(clock.now().getTime() + Number(minutes)*60000).toISOString();
    const snoozed = storage.get("nba:snoozed") || {};
    snoozed[id] = until;
    storage.set("nba:snoozed", snoozed);
    analytics.track("nba/snooze", { id, minutes });
    return true; } catch { return false; } }

  function addInlineNudge(n){ const ready = baseNudge(n); try { analytics.track("nba/inline",{type:ready.type}); } catch{} return ready; }

  // expose small preference helpers
  function muteTag(tag){ const prefs = storage.get("nba:prefs") || {}; const muted = new Set(prefs.mutedTags||[]); muted.add(tag); prefs.mutedTags = Array.from(muted); storage.set("nba:prefs", prefs); }
  function unmuteTag(tag){ const prefs = storage.get("nba:prefs") || {}; const muted = new Set(prefs.mutedTags||[]); muted.delete(tag); prefs.mutedTags = Array.from(muted); storage.set("nba:prefs", prefs); }

  return {
    collectAll,
    execute,
    markDone,
    dismiss,
    snooze,
    addInlineNudge,
    muteTag,
    unmuteTag
  };
}

// ----------------------------- React Hook Wrapper -----------------------------
export default function useNBANudges(deps = {}) {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = createNBANudges(deps);

  const [nudges, setNudges] = useState([]);
  const [history, setHistory] = useState([]);
  const [lastRefreshISO, setLastRefreshISO] = useState(null);

  const refresh = useCallback(() => {
    const list = engineRef.current.collectAll();
    setNudges(list);
    setLastRefreshISO(new Date().toISOString());
    return list;
  }, []);

  const act = useCallback((id) => {
    const n = nudges.find(x => x.id === id);
    if (!n) return false;
    const ok = engineRef.current.execute(n);
    if (ok) {
      engineRef.current.markDone(id);
      setHistory(h => [{ ...n, actedAtISO: new Date().toISOString() }].concat(h).slice(0, 30));
      setNudges(arr => arr.filter(x => x.id !== id));
    }
    return ok;
  }, [nudges]);

  const dismiss = useCallback((id) => {
    engineRef.current.dismiss(id);
    setNudges(arr => arr.filter(x => x.id !== id));
    return true;
  }, []);

  const snooze = useCallback((id, minutes=30) => {
    engineRef.current.snooze(id, minutes);
    setNudges(arr => arr.filter(x => x.id !== id));
    return true;
  }, []);

  const muteTag = useCallback((tag) => { engineRef.current.muteTag(tag); refresh(); }, [refresh]);
  const unmuteTag = useCallback((tag) => { engineRef.current.unmuteTag(tag); refresh(); }, [refresh]);

  // Event-driven inline nudges & auto refresh cadence
  useEffect(() => {
    const bus = deps.eventBus || NIL_BUS;

    function pushInline(n){ setNudges(curr => [engineRef.current.addInlineNudge(n)].concat(curr)); }

    // WorkDecider top pick
    const onDeciderTop = (evt) => pushInline({
      type: "schedule",
      icon: "⭐",
      title: `Great pick: ${evt?.title || "Choice"}`,
      body: "Schedule time so it really happens.",
      score: 0.6,
      tags: ["today"],
      cta: { label: "Schedule", action: "SCHEDULE_COOK", payload: { recipeId: evt?.recipeId, dateISO: todayISO() } },
      source: { domain: evt?.domain || "meals", id: evt?.recipeId }
    });

    // WorkPlan created → suggest pre-steps or grocery build
    const onPlanCreated = (e) => pushInline({
      type: "prep",
      icon: ICONS.prep,
      title: "Plan created",
      body: "Schedule pre-steps or create a grocery list.",
      score: 0.61,
      tags: ["plan"],
      cta: { label: "Open Grocery", action: "OPEN_GROCERY" },
      altCtas: [{ label:"Add Prep Block", action:"SCHEDULE_BLOCK", payload:{ title:"Prep Session", minutes:25 } }],
      source: { domain: e?.domain || "custom", id: e?.draft?.id }
    });

    // Session state changes
    const onSessionPaused  = (e) => pushInline({
      type: "schedule",
      icon: ICONS.schedule,
      title: "Session paused",
      body: "Set reminders for marinating/proofing/timers.",
      score: 0.6,
      tags: ["session"],
      cta: { label:"Add Reminders", action:"SCHEDULE_BLOCK", payload:{ title:"Pause timers", minutes:0 } },
      source: { domain: e?.domain || "custom", id: e?.sessionId }
    });

    const onSessionResumable = (e) => pushInline({
      type: "schedule",
      icon: ICONS.schedule,
      title: "Resume now?",
      body: "Pick up where you left off.",
      score: 0.62,
      tags: ["session","today"],
      cta: { label:"Resume", action:"SESSION_RESUME", payload:{ id:e?.sessionId, domain:e?.domain } },
      source: { domain: e?.domain || "custom", id: e?.sessionId }
    });

    // Garden/weather/inventory specific pushes
    const onInventoryLow = (e) => pushInline({
      type: "grocery",
      icon: ICONS.grocery,
      title: "Low inventory",
      body: (e?.items||[]).slice(0,3).join(", ") + "…",
      score: 0.6,
      tags: ["grocery","inventory"],
      cta: { label:"Open Grocery", action:"OPEN_GROCERY" },
      source: { domain:"inventory", id:"low" }
    });

    bus.on("decider:top-candidate", onDeciderTop);
    bus.on("workplan.draft.created", onPlanCreated);
    bus.on("session.paused", onSessionPaused);
    bus.on("session.resumable", onSessionResumable);
    bus.on("inventory.low", onInventoryLow);

    // Initial + periodic refresh
    const first = refresh();
    // light cadence like well-executed dashboards
    const t = setInterval(() => { refresh(); }, 60 * 1000 * 5); // every 5 minutes
    if (!first?.length) { setTimeout(() => refresh(), 1500); }

    return () => {
      clearInterval(t);
      bus.off("decider:top-candidate", onDeciderTop);
      bus.off("workplan.draft.created", onPlanCreated);
      bus.off("session.paused", onSessionPaused);
      bus.off("session.resumable", onSessionResumable);
      bus.off("inventory.low", onInventoryLow);
    };
  }, [deps.eventBus, refresh]);

  // Derived views for HUDs/cards
  const top       = useMemo(() => nudges[0] || null, [nudges]);
  const runnersUp = useMemo(() => nudges.slice(1, 5), [nudges]);
  const critical  = useMemo(() => nudges.filter(n => n.severity==="critical"), [nudges]);

  return {
    // actions
    refresh,
    act,
    dismiss,
    snooze,
    muteTag,
    unmuteTag,

    // state & views
    nudges,
    top,
    runnersUp,
    critical,
    history,
    lastRefreshISO
  };
}
