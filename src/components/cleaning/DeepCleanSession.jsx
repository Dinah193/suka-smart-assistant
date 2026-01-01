// src/components/cleaning/DeepCleanSession.jsx
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * DeepCleanSession — dynamic planner with Tools/Equipment & Recommended Upgrades
 * -----------------------------------------------------------------------------
 * - Keeps your sabbath-aware rule-based plan + optional agent normalization
 * - Calculates supply shortages from DIY-cleaner “recipes”
 * - Computes tool gaps with substitution + borrow/buy flows
 * - NEW: “Recommended Upgrades” panel (impact-ranked) that reduces manual effort
 *   • auto-suggests based on chosen tasks & your equipment inventory
 *   • one-click “Add to Shopping List” to resolve recommendations
 * - Keyboard shortcuts: Ctrl+S (Task Board), Ctrl+K (Calendar), Ctrl+Z (Undo)
 */

/* ------------------------------------------------------------------ */
/* Light utilities */
const iso = (d = new Date()) => new Date(d).toISOString();
const isoDate = (d = new Date()) => new Date(d).toISOString().slice(0, 10);
const uid = (p = "id") => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const clamp = (n, min, max) => Math.min(Math.max(Number(n) || 0, min), max);
const cap = (s = "") => s.charAt(0).toUpperCase() + s.slice(1);
const pct = (n) => `${Math.round(Number(n) * 100)}%`;
function addMinutes(d, m) { const x = new Date(d); x.setMinutes(x.getMinutes() + m); return x; }
function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }

/* ------------------------------------------------------------------ */
/* Service shims (sandbox-safe no-ops) */
async function _useAutomationBus() {
  return { emit: () => {}, invoke: async () => {} };
}
async function _useInventoryStore() {
  // Minimal shapes. Real app should supply these via your store/selectors.
  return {
    inventory: [], // consumables/ingredients
    equipment: [
      // e.g., { key: 'tl_microfiber', name: 'Microfiber Cloth', qty: 6 }
    ],
    preferences: {
      toolAcquireMode: (localStorage.getItem("deepClean.toolAcquireMode") || "buy"), // "buy" | "borrow"
      toolSubstitutions: (() => {
        try { return JSON.parse(localStorage.getItem("deepClean.toolSubs") || "{}"); } catch { return {}; }
      })(),
    },
  };
}
async function _useCalendarStore() { return { hebrewDayOfWeek: null }; }
async function _CleaningAgent() { return null; }

/* ------------------------------------------------------------------ */
/* Built-in defaults (extendable) */
const DEFAULT_ZONES = [
  {
    id: "zone_kitchen", name: "Kitchen",
    chores: [
      { id: "k_cabinets", name: "Degrease cabinet doors/handles", estMin: 20, supplies: ["sr_all_purpose"], tools: ["tl_microfiber", "tl_scrub_brush"], deep: true },
      { id: "k_fridge_deep", name: "Empty & deep-clean refrigerator", estMin: 40, supplies: ["sr_all_purpose"], tools: ["tl_microfiber", "tl_bucket"], deep: true },
      { id: "k_oven_racks", name: "Oven racks scrub", estMin: 35, supplies: ["sr_powder_scrub"], tools: ["tl_scrub_pad_heavy", "tl_gloves"], deep: true },
      { id: "k_baseboards", name: "Baseboards & corners", estMin: 15, supplies: ["sr_all_purpose"], tools: ["tl_detail_brush", "tl_microfiber"] },
    ],
  },
  {
    id: "zone_bath", name: "Bathrooms",
    chores: [
      { id: "b_tile_grout", name: "Tile & grout deep scrub", estMin: 30, supplies: ["sr_powder_scrub"], tools: ["tl_grout_brush", "tl_kneepads", "tl_bucket"], deep: true },
      { id: "b_vent_fan", name: "Clean vent fan & cover", estMin: 15, supplies: ["sr_all_purpose"], tools: ["tl_step_stool", "tl_duster_extendable"] },
      { id: "b_shower_glass", name: "Remove mineral deposits on glass", estMin: 20, supplies: ["sr_glass"], tools: ["tl_squeegee", "tl_microfiber"], deep: true },
    ],
  },
  {
    id: "zone_common", name: "Common Areas",
    chores: [
      { id: "c_windows_tracks", name: "Window tracks & sills", estMin: 25, supplies: ["sr_glass"], tools: ["tl_detail_brush", "tl_microfiber", "tl_vac_crevice"], deep: true },
      { id: "c_vents_registers", name: "Dust/clean vents & registers", estMin: 15, supplies: ["sr_all_purpose"], tools: ["tl_duster_extendable", "tl_vac_crevice"] },
      { id: "c_baseboards", name: "Baseboards full pass", estMin: 20, supplies: ["sr_all_purpose"], tools: ["tl_baseboard_mop", "tl_microfiber"] },
    ],
  },
];

const BUILTIN_SUPPLY_RECIPES = [
  { id: "sr_all_purpose", name: "All-Purpose Cleaner", yields: "16 oz", ingredients: [ { key: "white_vinegar", qty: 1, unit: "cup" }, { key: "castile_soap", qty: 1, unit: "tbsp" }, { key: "water", qty: 1, unit: "cup" } ], steps: ["Combine liquids", "Invert gently", "Label bottle"] },
  { id: "sr_glass", name: "Glass Cleaner", yields: "16 oz", ingredients: [ { key: "isopropyl_alcohol_70", qty: 1, unit: "cup" }, { key: "white_vinegar", qty: 1, unit: "tbsp" }, { key: "water", qty: 1, unit: "cup" } ], steps: ["Combine", "Use with microfiber cloth"] },
  { id: "sr_powder_scrub", name: "Powder Scrub", yields: "1 jar", ingredients: [ { key: "baking_soda", qty: 1, unit: "cup" } ], steps: ["Fill jar", "Add optional tea tree oil", "Cap tightly"] },
];

/* ------------------------------------------------------------------ */
/* Sabbath logic */
function isSabbath(dateObj, { saturdayAsSabbath = false, hebrewDayOfWeek } = {}) {
  if (saturdayAsSabbath) return dateObj.getDay() === 6; // Saturday
  if (typeof hebrewDayOfWeek === "function") return hebrewDayOfWeek(dateObj) === 7; // Hebrew Day-7
  return dateObj.getDay() === 6; // Fallback proxy: Saturday
}

/* ------------------------------------------------------------------ */
/* Inventory helpers: supplies */
function flattenNeededSupplies(sections = []) {
  const ids = new Set();
  sections.forEach((sec) => sec.tasks.forEach((t) => (t.supplies || []).forEach((s) => ids.add(s))));
  return [...ids];
}
function computeShortages(recipes = [], inventory = []) {
  const invMap = new Map(inventory.map((i) => [i.key || i.id, Number(i.qty) || 0]));
  const out = [];
  recipes.forEach((r) => {
    r.ingredients.forEach((ing) => {
      if (!ing.key) return;
      const have = invMap.get(ing.key) || 0;
      const need = Number(ing.qty) || 0;
      if (need > have) {
        out.push({ key: ing.key, name: prettySupplyName(ing.key), unit: ing.unit || "unit", have, need, missing: Math.max(0, need - have), recipe: r.name });
      }
    });
  });
  return out;
}
function prettySupplyName(key) {
  const dict = { white_vinegar: "White Vinegar", castile_soap: "Liquid Castile Soap", water: "Water", isopropyl_alcohol_70: "Isopropyl Alcohol (70%)", baking_soda: "Baking Soda" };
  return dict[key] || key.replace(/_/g, " ");
}

/* ------------------------------------------------------------------ */
/* Tools & Equipment helpers */
function flattenNeededTools(sections = []) {
  const ids = new Set();
  sections.forEach((sec) => sec.tasks.forEach((t) => (t.tools || []).forEach((tool) => ids.add(tool))));
  return [...ids];
}
function prettyToolName(key) {
  const dict = {
    tl_microfiber: "Microfiber Cloth",
    tl_scrub_brush: "Scrub Brush",
    tl_detail_brush: "Detail Brush",
    tl_scrub_pad_heavy: "Heavy-Duty Scrub Pad",
    tl_grout_brush: "Grout Brush",
    tl_kneepads: "Knee Pads",
    tl_bucket: "Bucket",
    tl_step_stool: "Step Stool",
    tl_duster_extendable: "Extendable Duster",
    tl_squeegee: "Squeegee",
    tl_vac_crevice: "Vacuum (Crevice Tool)",
    tl_baseboard_mop: "Baseboard Mop",
    tl_gloves: "Gloves",
    tl_spin_scrubber: "Power Spin Scrubber",
    tl_steam_cleaner: "Steam Cleaner",
    tl_stick_vac: "Cordless Stick Vacuum",
    tl_window_kit: "Pro Squeegee + Scrubber Kit",
    tl_soak_tub: "Soak Tub (Oven Racks)",
    tl_grout_steam_brush: "Steam Grout Brush",
  };
  return dict[key] || key.replace(/_/g, " ");
}
/**
 * Compute tool availability and gaps.
 */
function computeToolGaps(neededTools = [], equipment = [], prefs = { toolAcquireMode: "buy", toolSubstitutions: {} }) {
  const haveSet = new Set(equipment.map((e) => e.key || e.id));
  const available = [];
  const missing = [];

  neededTools.forEach((k) => {
    if (haveSet.has(k)) {
      available.push({ key: k, name: prettyToolName(k) });
    } else {
      // Try substitution
      const subs = prefs?.toolSubstitutions?.[k] || [];
      const subHit = subs.find((alt) => haveSet.has(alt));
      if (subHit) {
        available.push({ key: subHit, name: prettyToolName(subHit), substituteFor: k });
      } else {
        missing.push({ key: k, name: prettyToolName(k) });
      }
    }
  });

  const resolved = available.filter((t) => t.substituteFor).map((t) => ({ need: t.substituteFor, used: t.key }));
  return { available, missing, resolved };
}

/* ------------------------------------------------------------------ */
/* Timers */
function extractTimersFromSteps(steps = []) {
  const timers = [];
  const re = /Set a timer for\s+(\d+)\s+minutes?/i;
  steps.forEach((s) => { const m = re.exec(s); if (m) timers.push({ minutes: Number(m[1]) || 1 }); });
  return timers;
}

/* ------------------------------------------------------------------ */
/* Recommended Upgrades — curated library mapped to tasks */
const RECOMMENDED_LIBRARY = [
  // Effort shifters (big wins)
  { key: "tl_spin_scrubber", type: "tool", name: "Power Spin Scrubber", impact: 0.9, why: "Cuts hand-scrubbing time on tubs, grout, baseboards.", tags: ["bath", "tile", "grout", "baseboards"], matchIds: ["b_tile_grout", "k_baseboards", "c_baseboards"] },
  { key: "tl_steam_cleaner", type: "equipment", name: "Steam Cleaner", impact: 0.85, why: "Sanitizes without chemicals; blasts grime from tracks and glass edges.", tags: ["kitchen", "bath", "windows"], matchIds: ["c_windows_tracks", "k_fridge_deep", "b_shower_glass"] },
  { key: "tl_grout_steam_brush", type: "tool", name: "Steam Grout Brush", impact: 0.8, why: "Targets grout lines; reduces scrubbing fatigue.", tags: ["grout"], matchIds: ["b_tile_grout"] },
  { key: "tl_stick_vac", type: "equipment", name: "Cordless Stick Vacuum", impact: 0.75, why: "Fast floor/crevice pickup before wet work.", tags: ["common", "prep"], matchIds: ["c_windows_tracks", "c_vents_registers"] },

  // Targeted pro kits
  { key: "tl_window_kit", type: "tool", name: "Pro Squeegee + Scrubber Kit", impact: 0.7, why: "Streak-free windows in fewer passes.", tags: ["glass", "windows"], matchIds: ["c_windows_tracks", "b_shower_glass"] },
  { key: "tl_soak_tub", type: "equipment", name: "Soak Tub for Racks", impact: 0.65, why: "Hands-off soak loosens burnt-on debris.", tags: ["kitchen", "oven"], matchIds: ["k_oven_racks"] },
];

/**
 * Builds recommendations by: (1) looking at tasks, (2) checking inventory,
 * (3) preferring high-impact items that the household lacks.
 */
function computeRecommendations(plan, equipment = [], toolGaps, { max = 6 } = {}) {
  if (!plan?.sections?.length) return [];
  const haveSet = new Set((equipment || []).map((e) => e.key || e.id));
  const taskIds = new Set(plan.sections.flatMap((s) => (s.tasks || []).map((t) => t.id)));

  // Score each recommendation
  const scored = RECOMMENDED_LIBRARY.map((r) => {
    const matches = (r.matchIds || []).some((id) => taskIds.has(id));
    const missing = !haveSet.has(r.key);
    // bonus if it's directly covering a missing need from tools panel
    const missingInPlan = (toolGaps?.missing || []).some((m) => m.key === r.key);
    const base = r.impact || 0.5;
    const score = base
      + (matches ? 0.25 : 0)
      + (missing ? 0.15 : 0)
      + (missingInPlan ? 0.15 : 0);
    return { ...r, score };
  });

  // Sort by score desc; keep top unique by key
  const uniq = new Map();
  scored
    .sort((a, b) => b.score - a.score)
    .forEach((r) => { if (!uniq.has(r.key)) uniq.set(r.key, r); });

  return Array.from(uniq.values()).slice(0, max);
}

/* ------------------------------------------------------------------ */
export default function DeepCleanSession({
  initialZones = DEFAULT_ZONES,
  defaultWindowMin = 90,
  defaultEnergy = "moderate",
  saturdayAsSabbath = false,
  onPlanned = () => {},
  defaultCadence = "none",
}) {
  const [zones] = useState(initialZones);
  const [selectedZoneIds, setSelectedZoneIds] = useState(() => {
    try { return JSON.parse(localStorage.getItem("deepClean.selectedZones") || "null") || initialZones.slice(0, 2).map((z) => z.id); }
    catch { return initialZones.slice(0, 2).map((z) => z.id); }
  });
  const [energy, setEnergy] = useState(() => { try { return localStorage.getItem("deepClean.energy") || defaultEnergy; } catch { return defaultEnergy; } });
  const [windowMin, setWindowMin] = useState(() => { try { return Number(localStorage.getItem("deepClean.windowMin")) || defaultWindowMin; } catch { return defaultWindowMin; } });
  const [voiceAlerts, setVoiceAlerts] = useState(() => { try { return JSON.parse(localStorage.getItem("deepClean.voiceAlerts") || "true"); } catch { return true; } });
  const [cadence, setCadence] = useState(() => { try { return localStorage.getItem("deepClean.cadence") || defaultCadence; } catch { return defaultCadence; } });

  const [draft, setDraft] = useState(null);
  const [shortages, setShortages] = useState([]);
  const [toolGaps, setToolGaps] = useState({ available: [], missing: [], resolved: [] });
  const [recommended, setRecommended] = useState([]);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [lastAction, setLastAction] = useState(null); // { type, payload }

  const today = useMemo(() => new Date(), []);
  const dayKey = useMemo(() => isoDate(today), [today]);

  // Persist controls
  useEffect(() => { try { localStorage.setItem("deepClean.selectedZones", JSON.stringify(selectedZoneIds)); } catch {} }, [selectedZoneIds]);
  useEffect(() => { try { localStorage.setItem("deepClean.energy", energy); } catch {} }, [energy]);
  useEffect(() => { try { localStorage.setItem("deepClean.windowMin", String(windowMin)); } catch {} }, [windowMin]);
  useEffect(() => { try { localStorage.setItem("deepClean.voiceAlerts", JSON.stringify(voiceAlerts)); } catch {} }, [voiceAlerts]);
  useEffect(() => { try { localStorage.setItem("deepClean.cadence", cadence); } catch {} }, [cadence]);

  /* Load Hebrew DOW if Calendar store present */
  const [hebrewDOW, setHebrewDOW] = useState(null);
  useEffect(() => { (async () => { const cal = await _useCalendarStore(); setHebrewDOW(() => cal?.hebrewDayOfWeek || null); })(); }, []);

  // Build plan (debounced) on selection changes
  const doBuild = useRef(null);
  useEffect(() => {
    doBuild.current = debounce(async () => {
      const sabbath = isSabbath(today, { saturdayAsSabbath, hebrewDayOfWeek: hebrewDOW });
      const Agent = await _CleaningAgent();
      let planResp = null;
      if (Agent?.generateDailyCleaningPlan) {
        try {
          planResp = await Agent.generateDailyCleaningPlan({
            zones: filterZones(zones, selectedZoneIds, true),
            preferences: { energy, availableMinutes: windowMin, sabbath: saturdayAsSabbath ? "saturday" : "hebrew" },
          });
        } catch {}
      }

      const plan = planResp?.ok && planResp.plan
        ? normalizeToDeepSession(planResp.plan, { voiceAlerts })
        : ruleBasedDeepPlan(filterZones(zones, selectedZoneIds, true), { energy, windowMin, sabbath, voiceAlerts });

      // Supplies shortages
      const inv = await _useInventoryStore();
      const inventory = inv?.inventory || inv?.items || [];
      const neededIds = flattenNeededSupplies(plan.sections);
      const recipes = resolveRecipesById(neededIds, BUILTIN_SUPPLY_RECIPES);
      const s = computeShortages(recipes, inventory);

      // Tools availability
      const neededTools = flattenNeededTools(plan.sections);
      const { available, missing, resolved } = computeToolGaps(neededTools, inv?.equipment || [], inv?.preferences || {});

      // Recommendations
      const recs = computeRecommendations(plan, inv?.equipment || [], { available, missing, resolved });

      const result = {
        plan,
        recipes,
        shortages: s,
        tools: { needed: neededTools, available, missing, resolved },
        recommended: recs,
      };
      setDraft(result);
      setShortages(s);
      setToolGaps({ available, missing, resolved });
      setRecommended(recs);
      try { onPlanned(result); } catch {}

      try {
        const bus = await _useAutomationBus();
        if (bus?.emit) bus.emit("analytics/event", { name: "deepClean.planBuilt", props: { minutes: plan.sessionMinutes, energy, toolsNeeded: neededTools.length, recCount: recs.length } });
      } catch {}
    }, 120);
  }, [energy, hebrewDOW, saturdayAsSabbath, windowMin, voiceAlerts, onPlanned, selectedZoneIds, zones, today]);

  useEffect(() => { doBuild.current && doBuild.current(); }, [selectedZoneIds, energy, windowMin, voiceAlerts]);

  function normalizeToDeepSession(agentPlan, { voiceAlerts = true } = {}) {
    const sections = (agentPlan.sections || []).map((s, si) => ({
      ...s,
      title: s.title || `Zone ${si + 1}`,
      tasks: (s.tasks || []).map((t, idx) => ({
        ...t,
        id: t.id || uid("task"),
        order: idx + 1,
        steps: ensureTimerStep(t, Math.max(5, Math.round((t.estMin || 10) * 0.6))),
        voiceAlerts: voiceAlerts,
      })),
    }));
    return {
      id: agentPlan.id || uid("deepPlan"),
      date: agentPlan.date || isoDate(),
      tz: agentPlan.tz || "America/New_York",
      sessionType: "deep_clean",
      sessionMinutes: Math.max(30, sections.reduce((a, s) => a + s.tasks.reduce((x, t) => x + (t.estMin || 5), 0), 0)),
      energy: agentPlan.energy || "moderate",
      sabbathSkipped: !!agentPlan.sabbathSkipped,
      sections,
      meta: { fromAgent: true },
    };
  }

  function ensureTimerStep(task, mins) {
    const hasTimer = (task.steps || []).some((s) => /Set a timer for/i.test(s));
    return hasTimer
      ? task.steps
      : [
          `Set a timer for ${mins} minutes.`,
          "Declutter fast pass.",
          "Apply cleaner/scrub.",
          "Detail passes.",
          "Final reset.",
        ];
  }

  function ruleBasedDeepPlan(selectedZones, { energy, windowMin, sabbath, voiceAlerts }) {
    if (sabbath) {
      return {
        id: uid("deepPlan"),
        date: isoDate(),
        tz: "America/New_York",
        sessionType: "prep_only",
        sessionMinutes: 15,
        energy,
        sabbathSkipped: true,
        sections: [{
          id: uid("sec"),
          title: "Prep Only (Sabbath)",
          tasks: [{
            id: uid("task"),
            name: "Stage caddies & bottles",
            estMin: 10,
            supplies: ["sr_all_purpose", "sr_powder_scrub", "sr_glass"],
            tools: ["tl_microfiber", "tl_bucket"],
            steps: ["Check/refill bottles", "Lay out cloths & pads", "Place at first zone for tomorrow"],
            voiceAlerts: false,
          }],
        }],
        meta: { fromAgent: false },
      };
    }

    const pool = [];
    selectedZones.forEach((z) => (z.chores || []).forEach((c) => pool.push({ zoneName: z.name, zoneId: z.id, ...c })));

    // priority: deep tasks; then by energy/time sort
    pool.sort((a, b) => {
      const deepA = a.deep ? 1 : 0, deepB = b.deep ? 1 : 0;
      if (deepB !== deepA) return deepB - deepA;
      if (energy === "high") return (b.estMin || 0) - (a.estMin || 0);
      if (energy === "low") return (a.estMin || 0) - (b.estMin || 0);
      return (a.estMin || 0) - (b.estMin || 0);
    });

    const chosen = [];
    const zonesPicked = new Set();
    let time = 0;
    for (const t of pool) {
      if (time + (t.estMin || 10) > windowMin) continue;
      if (zonesPicked.size <= 0 || zonesPicked.has(t.zoneId) || zonesPicked.size < 2) {
        chosen.push({
          ...t,
          id: t.id || uid("task"),
          steps: [
            `Set a timer for ${Math.max(8, Math.round((t.estMin || 10) * 0.6))} minutes.`,
            "Remove items & pre-spray.",
            "Scrub/detail from top to bottom.",
            "Rinse/wipe; return items.",
          ],
          voiceAlerts,
        });
        time += t.estMin || 10;
        zonesPicked.add(t.zoneId);
      }
      if (time >= windowMin) break;
    }

    const secTitle = [...zonesPicked]
      .map((id) => selectedZones.find((z) => z.id === id)?.name || "Zone")
      .join(" + ") || "Deep Clean";

    return {
      id: uid("deepPlan"),
      date: isoDate(),
      tz: "America/New_York",
      sessionType: "deep_clean",
      sessionMinutes: Math.max(30, time || 45),
      energy,
      sabbathSkipped: false,
      sections: [{ id: uid("sec"), title: secTitle, tasks: chosen }],
      meta: { fromAgent: false },
    };
  }

  function resolveRecipesById(ids, external = []) {
    const pool = [...BUILTIN_SUPPLY_RECIPES, ...external];
    return ids.map((id) => pool.find((r) => r.id === id)).filter(Boolean);
  }

  /* ------------------------------------------------------------------ */
  /* Actions */
  async function toTaskBoard() {
    if (!draft?.plan) return;
    const bus = await _useAutomationBus();
    if (!bus) return;

    const batchId = draft.plan.id;
    const payload = {
      source: "DeepCleanSession",
      planId: batchId,
      createdAt: iso(),
      tasks: draft.plan.sections.flatMap((s) =>
        s.tasks.map((t) => ({
          id: t.id || uid("task"),
          title: `${t.name} — ${s.title}`,
          estMin: t.estMin || 10,
          labels: ["cleaning", "deep"],
          timers: extractTimersFromSteps(t.steps),
          voiceAlerts: !!t.voiceAlerts,
          tools: t.tools || [],
        }))
      ),
    };

    if (bus.emit) bus.emit("tasks/createBatch", payload);
    if (bus.invoke) try { await bus.invoke("tasks/createBatch", payload); } catch {}
    setLastAction({ type: "tasks.createBatch", payload: { batchId } });
  }

  async function toCalendar() {
    if (!draft?.plan) return;
    const bus = await _useAutomationBus();
    if (!bus) return;

    const start = new Date();
    const end = addMinutes(start, draft.plan.sessionMinutes || 60);

    const payload = {
      source: "DeepCleanSession",
      title: draft.plan.sessionType === "prep_only" ? "Cleaning Prep" : "Deep Cleaning Session",
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      description: "Auto-created by DeepCleanSession (approve or adjust).",
      requireApproval: true,
      metadata: { planId: draft.plan.id, toolsNeeded: draft?.tools?.needed || [] },
    };

    if (bus.emit) bus.emit("calendar/schedule", payload);
    if (bus.invoke) try { await bus.invoke("calendar/schedule", payload); } catch {}
    setLastAction({ type: "calendar.schedule", payload: { eventMetaPlanId: draft.plan.id } });
  }

  async function scheduleRecurrenceForTasks() {
    if (!draft?.plan || cadence === "none") return;
    const bus = await _useAutomationBus();
    if (!bus) return;

    const map = {
      monthly: "FREQ=MONTHLY",
      quarterly: "FREQ=MONTHLY;INTERVAL=3",
      biannual: "FREQ=MONTHLY;INTERVAL=6",
      annual: "FREQ=YEARLY",
    };
    const rrule = map[cadence];
    if (!rrule) return;

    const now = new Date();
    const schedules = draft.plan.sections.flatMap((s) =>
      s.tasks.map((t) => ({
        title: `Deep Clean Focus: ${t.name}`,
        startISO: now.toISOString(),
        durationMin: t.estMin || 30,
        rrule,
        metadata: { planId: draft.plan.id, taskId: t.id, zone: s.title, tools: t.tools || [] },
      }))
    );

    const payload = { source: "DeepCleanSession", schedules, requireApproval: true };
    if (bus.emit) bus.emit("calendar/scheduleRecurringBatch", payload);
    if (bus.invoke) try { await bus.invoke("calendar/scheduleRecurringBatch", payload); } catch {}
    setLastAction({ type: "calendar.scheduleRecurringBatch", payload: { planId: draft.plan.id } });
  }

  async function resolveShortages() {
    if (!shortages.length) return;
    const bus = await _useAutomationBus();
    if (!bus) return;

    const payload = {
      source: "DeepCleanSession",
      items: shortages.map((s) => ({
        name: s.name,
        qty: s.missing > 0 ? s.missing : 1,
        unit: s.unit || "unit",
        tags: ["cleaning-supplies", "deep-clean"],
        note: `Needed for ${s.recipe}`,
      })),
    };

    if (bus.emit) bus.emit("shopping/addItems", payload);
    if (bus.invoke) try { await bus.invoke("shopping/addItems", payload); } catch {}
    setLastAction({ type: "shopping.addItems", payload: { count: payload.items.length } });
  }

  async function resolveTools() {
    if (!toolGaps?.missing?.length) return;
    const bus = await _useAutomationBus();
    if (!bus) return;
    const inv = await _useInventoryStore();
    const mode = inv?.preferences?.toolAcquireMode || "buy";

    if (mode === "borrow") {
      const payload = { source: "DeepCleanSession", tools: toolGaps.missing.map((t) => ({ key: t.key, name: t.name })) };
      if (bus.emit) bus.emit("tools/requestBorrow", payload);
      if (bus.invoke) try { await bus.invoke("tools/requestBorrow", payload); } catch {}
      setLastAction({ type: "tools.requestBorrow", payload: { count: payload.tools.length } });
    } else {
      const payload = {
        source: "DeepCleanSession",
        items: toolGaps.missing.map((t) => ({ name: t.name, qty: 1, unit: "item", tags: ["cleaning-tools", "deep-clean"], note: "Tool required for plan" })),
      };
      if (bus.emit) bus.emit("shopping/addItems", payload);
      if (bus.invoke) try { await bus.invoke("shopping/addItems", payload); } catch {}
      setLastAction({ type: "shopping.addItems", payload: { count: payload.items.length } });
    }
  }

  async function resolveRecommendations() {
    if (!recommended?.length) return;
    const bus = await _useAutomationBus();
    if (!bus) return;

    const payload = {
      source: "DeepCleanSession",
      items: recommended.map((r) => ({
        name: r.name,
        qty: 1,
        unit: "item",
        tags: ["recommended", "effort-saver", "deep-clean"],
        note: `Recommended: ${r.why}`,
      })),
    };

    if (bus.emit) bus.emit("shopping/addItems", payload);
    if (bus.invoke) try { await bus.invoke("shopping/addItems", payload); } catch {}
    setLastAction({ type: "shopping.addItems", payload: { count: payload.items.length, scope: "recommended" } });
  }

  async function undoLast() {
    if (!lastAction) return;
    const bus = await _useAutomationBus();
    if (!bus) return;

    try {
      switch (lastAction.type) {
        case "tasks.createBatch":
          if (bus.emit) bus.emit("tasks/deleteBatch", { batchId: lastAction.payload.batchId });
          if (bus.invoke) try { await bus.invoke("tasks/deleteBatch", { batchId: lastAction.payload.batchId }); } catch {}
          break;
        case "calendar.schedule":
          if (bus.emit) bus.emit("calendar/cancelByPlan", { planId: lastAction.payload.eventMetaPlanId });
          if (bus.invoke) try { await bus.invoke("calendar/cancelByPlan", { planId: lastAction.payload.eventMetaPlanId }); } catch {}
          break;
        case "calendar.scheduleRecurringBatch":
          if (bus.emit) bus.emit("calendar/cancelRecurringByPlan", { planId: lastAction.payload.planId });
          if (bus.invoke) try { await bus.invoke("calendar/cancelRecurringByPlan", { planId: lastAction.payload.planId }); } catch {}
          break;
        case "shopping.addItems":
          if (bus.emit) bus.emit("shopping/removeLastImport", { source: "DeepCleanSession" });
          if (bus.invoke) try { await bus.invoke("shopping/removeLastImport", { source: "DeepCleanSession" }); } catch {}
          break;
        case "tools.requestBorrow":
          if (bus.emit) bus.emit("tools/cancelBorrowRequests", { source: "DeepCleanSession" });
          if (bus.invoke) try { await bus.invoke("tools/cancelBorrowRequests", { source: "DeepCleanSession" }); } catch {}
          break;
        default:
          break;
      }
    } finally { setLastAction(null); }
  }

  /* ------------------------------------------------------------------ */
  /* UI helpers */
  function toggleZone(id) {
    setSelectedZoneIds((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  }

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e) {
      if (e.ctrlKey && e.key.toLowerCase() === "s") { e.preventDefault(); toTaskBoard(); }
      if (e.ctrlKey && e.key.toLowerCase() === "k") { e.preventDefault(); toCalendar(); }
      if (e.ctrlKey && e.key.toLowerCase() === "z") { e.preventDefault(); undoLast(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, lastAction]);

  /* ------------------------------------------------------------------ */
  /* Render */
  const planJSON = useMemo(() => JSON.stringify(draft || {}, null, 2), [draft]);

  return (
    <div className="rounded-2xl border bg-white shadow-sm p-5 flex flex-col gap-4" role="region" aria-label="Deep Clean Session">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-base font-semibold">Deep Clean Session</div>
          <div className="text-xs text-slate-500">{dayKey}</div>
        </div>
        <div className="flex items-center gap-2">
          <button aria-label="View plan as JSON" className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50" onClick={() => setJsonOpen(true)}>
            View Plan JSON
          </button>
        </div>
      </div>

      {/* Zone picker */}
      <div>
        <div className="text-sm font-semibold mb-2">Zones</div>
        <div className="flex flex-wrap gap-2">
          {zones.map((z) => {
            const active = selectedZoneIds.includes(z.id);
            return (
              <button
                key={z.id}
                type="button"
                onClick={() => toggleZone(z.id)}
                aria-pressed={active}
                className={`px-3 py-1.5 rounded-xl border ${active ? "bg-emerald-600 text-white border-emerald-600" : "bg-white hover:bg-slate-50"}`}
                title={active ? "Selected" : "Select zone"}
              >
                {z.name}
              </button>
            );
          })}
        </div>
        <div className="text-xs text-slate-500 mt-1">Tip: pick up to 2 zones for best flow.</div>
      </div>

      {/* Controls */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        <div className="p-3 rounded-2xl border bg-slate-50">
          <div className="text-xs text-slate-500 mb-1">Energy</div>
          <select value={energy} onChange={(e) => setEnergy(e.target.value)} className="w-full px-2 py-1.5 rounded-xl border bg-white">
            <option value="low">Low</option>
            <option value="moderate">Moderate</option>
            <option value="high">High</option>
          </select>
        </div>
        <div className="p-3 rounded-2xl border bg-slate-50">
          <div className="text-xs text-slate-500 mb-1">Time Window (min)</div>
          <input
            type="number"
            value={windowMin}
            onChange={(e) => setWindowMin(clamp(e.target.value, 20, 300))}
            className="w-full px-2 py-1.5 rounded-xl border"
          />
        </div>
        <div className="p-3 rounded-2xl border bg-slate-50">
          <div className="text-xs text-slate-500 mb-1">Voice Alerts</div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={voiceAlerts} onChange={(e) => setVoiceAlerts(e.target.checked)} />
            Enable voice on step changes
          </label>
        </div>
        <div className="p-3 rounded-2xl border bg-slate-50">
          <div className="text-xs text-slate-500 mb-1">Sabbath Mode</div>
          <div className="text-xs">
            Default: Hebrew Day-7. {saturdayAsSabbath ? <span className="text-emerald-700 font-medium">Saturday active</span> : "Saturday proxy if Hebrew DOW unavailable."}
          </div>
        </div>
        <div className="p-3 rounded-2xl border bg-slate-50">
          <div className="text-xs text-slate-500 mb-1">Deep Clean Focus (recurrence)</div>
          <select value={cadence} onChange={(e) => setCadence(e.target.value)} className="w-full px-2 py-1.5 rounded-xl border bg-white">
            <option value="none">None</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="biannual">Bi-Annually</option>
            <option value="annual">Annually</option>
          </select>
        </div>
      </div>

      {/* Draft preview */}
      {draft?.plan ? (
        <div className="rounded-2xl border bg-slate-50/70 p-3">
          <div className="flex items-center justify-between">
            <div className="font-medium">
              {draft.plan.sessionType === "prep_only" ? "Prep Only (Sabbath)" : "Session Plan"} — {draft.plan.sessionMinutes} min • {cap(draft.plan.energy)}
            </div>
            <div className="text-xs text-slate-500">{draft.plan.sabbathSkipped ? "Sabbath detected — work deferred" : ""}</div>
          </div>
          {draft.plan.sections.map((s) => (
            <div key={s.id} className="mt-2">
              <div className="text-sm font-semibold">{s.title}</div>
              <ol className="mt-1 space-y-1 list-decimal ml-5">
                {s.tasks.map((t) => (
                  <li key={t.id} className="text-sm">
                    <div className="font-medium">
                      {t.name} <span className="text-xs text-slate-500">({t.estMin} min)</span>
                    </div>
                    {t.supplies?.length ? (
                      <div className="text-xs text-slate-500">Supplies: {t.supplies.join(", ")}</div>
                    ) : null}
                    {t.tools?.length ? (
                      <div className="text-xs text-slate-500">Tools: {t.tools.map(prettyToolName).join(", ")}</div>
                    ) : null}
                    <ul className="mt-1 list-disc ml-5 text-xs text-slate-600">
                      {(t.steps || []).map((st, i) => <li key={i}>{st}</li>)}
                    </ul>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border bg-slate-50 p-3 text-sm text-slate-500">
          No draft yet — adjust zones/controls to build one.
        </div>
      )}

      {/* Tools panel */}
      {draft?.tools ? (
        <div className="p-3 rounded-2xl border bg-blue-50 text-blue-900">
          <div className="font-medium">Equipment & Tools</div>
          <div className="grid md:grid-cols-3 gap-2 mt-1 text-sm">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide">Needed ({draft.tools.needed.length})</div>
              <ul className="list-disc ml-5 mt-1">
                {draft.tools.needed.map((k) => <li key={`need-${k}`}>{prettyToolName(k)}</li>)}
              </ul>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide">Available ({toolGaps.available.length})</div>
              <ul className="list-disc ml-5 mt-1">
                {toolGaps.available.map((t) => (
                  <li key={`have-${t.key}`}>
                    {t.name}{t.substituteFor ? <span className="text-xs text-blue-700"> (using instead of {prettyToolName(t.substituteFor)})</span> : null}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide">Missing ({toolGaps.missing.length})</div>
              {toolGaps.missing.length ? (
                <>
                  <ul className="list-disc ml-5 mt-1">
                    {toolGaps.missing.map((t) => <li key={`miss-${t.key}`}>{t.name}</li>)}
                  </ul>
                  <button className="mt-2 px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50" onClick={resolveTools}>
                    Resolve Tools ({toolGaps.missing.length})
                  </button>
                </>
              ) : (
                <div className="text-xs mt-1">All set—no missing tools.</div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* Recommended Upgrades (effort-savers) */}
      {!!recommended?.length && (
        <div className="p-3 rounded-2xl border bg-emerald-50 text-emerald-900">
          <div className="flex items-center justify-between">
            <div className="font-medium">Recommended Upgrades (to reduce manual effort)</div>
            <div className="text-xs text-emerald-800">Auto-picked for your selected tasks</div>
          </div>
          <ul className="mt-2 space-y-2">
            {recommended.map((r) => (
              <li key={r.key} className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 bg-white/70 border rounded-xl px-3 py-2">
                <div>
                  <div className="font-medium">{r.name} <span className="text-xs text-slate-500">({r.type})</span></div>
                  <div className="text-xs text-slate-600">{r.why}</div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-xs">
                    Impact: <span className="inline-block px-2 py-0.5 rounded bg-emerald-100 border border-emerald-200">{pct(r.impact || 0.6)}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <button className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50" onClick={resolveRecommendations}>
              Add Recommended to Shopping List ({recommended.length})
            </button>
          </div>
        </div>
      )}

      {/* Shortages (supplies) */}
      {shortages?.length ? (
        <div className="p-3 rounded-2xl border bg-amber-50 text-amber-900">
          <div className="font-medium">Supplies needed before you start</div>
          <ul className="list-disc ml-5 text-sm mt-1">
            {shortages.slice(0, 6).map((s) => (
              <li key={`${s.key}-${s.recipe}`}>
                {s.name}: need {s.need} {s.unit}, have {s.have} — for {s.recipe}
              </li>
            ))}
          </ul>
          {shortages.length > 6 ? <div className="text-xs mt-1">+ {shortages.length - 6} more…</div> : null}
          <div className="mt-2 flex gap-2">
            <button className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50" onClick={resolveShortages}>
              Resolve Shortages (Shopping/Make)
            </button>
            <button
              className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50"
              onClick={scheduleRecurrenceForTasks}
              disabled={cadence === "none"}
              title={cadence === "none" ? "Choose a cadence first" : "Schedule recurring deep-focus tasks"}
            >
              Schedule Deep-Focus Cadence
            </button>
          </div>
        </div>
      ) : null}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 justify-end">
        {lastAction ? (
          <button className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50" onClick={undoLast} aria-label="Undo last action">
            Undo Last Action
          </button>
        ) : null}
        <button className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50" onClick={toTaskBoard}>
          Send to Task Board
        </button>
        <button className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50" onClick={toCalendar}>
          Schedule on Calendar
        </button>
      </div>

      {/* JSON modal */}
      {jsonOpen ? (
        <div className="fixed inset-0 bg-black/20 z-50 flex items-end md:items-center md:justify-center">
          <div className="w-full md:w-[780px] h-[70vh] bg-white rounded-t-2xl md:rounded-2xl p-4 shadow-lg border flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <div className="text-base font-semibold">Deep Clean Draft JSON</div>
              <button className="px-2 py-1 rounded-lg border hover:bg-slate-50" onClick={() => setJsonOpen(false)}>✕</button>
            </div>
            <pre className="flex-1 overflow-auto text-xs bg-slate-50 rounded-xl p-3 border">{planJSON}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );

  /* ------------------------------------------------------------------ */
  /* Local helpers */
  function filterZones(zs, ids, deepOnly = false) {
    return zs
      .filter((z) => ids.includes(z.id))
      .map((z) => ({
        ...z,
        chores: deepOnly ? (z.chores || []).filter((c) => c.deep) : (z.chores || []),
      }));
  }
}

/* ------------------------------------------------------------------ */
/* Tiny self-tests (run once in dev-like environments) */
(function runSelfTests() {
  try {
    const sampleZones = [
      { id: "z1", name: "A", chores: [{ id: "a", name: "Deep A", deep: true, estMin: 20, tools: ["tl_microfiber", "tl_scrub_brush"] }] },
      { id: "z2", name: "B", chores: [{ id: "b", name: "Deep B", deep: true, estMin: 15, tools: ["tl_squeegee"] }] },
    ];
    const sabBathSat = isSabbath(new Date("2025-10-11T12:00:00Z"), { saturdayAsSabbath: true }); // Sat
    const sabBathHeb = isSabbath(new Date("2025-10-11T12:00:00Z"), { hebrewDayOfWeek: () => 7 });
    console.assert(sabBathSat === true, "[TEST] Saturday sabbath proxy should be true");
    console.assert(sabBathHeb === true, "[TEST] Hebrew DOW=7 should be true");

    // Rule-based planner basic coverage
    function _ruleBasedDeepPlan(selectedZones, opts) {
      const { energy, windowMin, sabbath, voiceAlerts } = opts;
      if (sabbath) return { sessionType: "prep_only" };
      const pool = [];
      selectedZones.forEach((z) => (z.chores || []).forEach((c) => pool.push({ zoneName: z.name, zoneId: z.id, ...c })));
      pool.sort((a, b) => { const deepA = a.deep ? 1 : 0, deepB = b.deep ? 1 : 0; if (deepB !== deepA) return deepB - deepA; if (energy === "high") return (b.estMin || 0) - (a.estMin || 0); if (energy === "low") return (a.estMin || 0) - (b.estMin || 0); return (a.estMin || 0) - (b.estMin || 0); });
      const chosen = []; const zonesPicked = new Set(); let time = 0;
      for (const t of pool) { if (time + (t.estMin || 10) > windowMin) continue; if (zonesPicked.size <= 0 || zonesPicked.has(t.zoneId) || zonesPicked.size < 2) { chosen.push({ ...t, voiceAlerts }); time += t.estMin || 10; zonesPicked.add(t.zoneId); } if (time >= windowMin) break; }
      return { sessionType: "deep_clean", sections: [{ tasks: chosen }], sessionMinutes: Math.max(30, time || 45) };
    }
    const plan = _ruleBasedDeepPlan(sampleZones, { energy: "moderate", windowMin: 30, sabbath: false, voiceAlerts: true });
    console.assert(plan.sessionType === "deep_clean", "[TEST] plan type deep_clean");
    console.assert(plan.sections[0].tasks.length >= 1, "[TEST] at least one task chosen under 30 min window");

    // Tools extraction & gaps
    const needed = flattenNeededTools(plan.sections);
    const equipment = [{ key: "tl_microfiber", qty: 4 }];
    const prefs = { toolAcquireMode: "buy", toolSubstitutions: { tl_scrub_brush: ["tl_detail_brush"] } };
    const gaps = computeToolGaps(needed, equipment, prefs);
    console.assert(Array.isArray(needed) && needed.length >= 1, "[TEST] tools needed extracted");
    console.assert(gaps.available.find((t) => t.key === "tl_microfiber"), "[TEST] available tool recognized");

    // Recommendations scoring sanity
    const recs = computeRecommendations({ sections: [{ tasks: [{ id: "b_tile_grout" }] }] }, equipment, gaps);
    console.assert(Array.isArray(recs) && recs.length >= 1, "[TEST] recommendations generated");
  } catch (e) {
    if (typeof console !== "undefined") console.warn("DeepCleanSession self-tests skipped or failed:", e?.message || e);
  }
})();
