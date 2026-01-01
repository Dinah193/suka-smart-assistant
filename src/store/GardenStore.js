// C:\Users\larho\suka-smart-assistant\src\store\GardenStore.js
/**
 * GardenStore (dynamic, agent- & Sabbath-aware)
 * ---------------------------------------------
 * Centralized garden state + helpers:
 *  - Plots lifecycle (plan → plant → maintain → harvest)
 *  - Harvest logging, preservation intents, cellar moves
 *  - Harvest/planting windows & pest-risk nudges
 *  - Inventory syncing (seeds, amendments, jars/lids for preservation)
 *  - Sabbath/quiet-hours awareness for reminders
 *  - Soft integrations (Dexie, agents, sockets, n8n)
 *
 * Dexie tables expected (best-effort):
 *  - gardenPlots:    { id, crop, area, plantedOnISO?, expectedHarvestISO?, yieldEstimate, preserved?: false, meta? }
 *  - gardenHarvests: { id, crop, quantity, unit?, harvestedOnISO, preserved, movedToCellar, meta? }
 *  - userMeta:       { key, value }  // used for persistence/hydration
 */

import { create } from "zustand";
import { shallow } from "zustand/shallow";
import { v4 as uuidv4 } from "uuid";

/* ---------------------------------------------
   Safe dynamic imports & environment shims
----------------------------------------------*/
async function safeImportMany(paths = []) {
  for (const p of paths) {
    try {
      // @vite-ignore
      const mod = await import(p);
      return mod?.default || mod;
    } catch {}
  }
  return null;
}
function safeNowISO() { return new Date().toISOString(); }
function toDateISO(d) {
  const dt = d ? new Date(d) : new Date();
  return Number.isFinite(dt.getTime()) ? dt.toISOString() : new Date().toISOString();
}
function toNumber(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}
function normalizeId(id) {
  const s = String(id ?? "").trim();
  return s || `id_${Math.random().toString(36).slice(2, 10)}`;
}
function normalizeCrop(crop) { return String(crop ?? "").trim(); }

function safeGetSocket() {
  try {
    // eslint-disable-next-line import/no-unresolved
    const sock = require("@/server/services/socket");
    return sock?.socket || sock?.getSocket?.() || null;
  } catch { return null; }
}
function broadcast(event, payload) {
  try { window.dispatchEvent?.(new CustomEvent(event, { detail: payload })); } catch {}
  try { safeGetSocket()?.emit?.(event, payload); } catch {}
}

// Settings & Sabbath helpers
async function loadSettings() {
  const Settings = await safeImportMany(["@/store/SettingsStore.js", "@/store/SettingsStore"]);
  const get = async (k, d) => { try { const v = await Settings?.get?.(k); return v ?? d; } catch { return d; } };
  return {
    profileKey: await get("profile.key", "standard-home"),
    sabbathAvoid: await get("sabbath.avoidSaturday", true),
    quietHours: await get("quietHours", { start: 21, end: 7 }),
    garden: {
      defaultUnit: await get("garden.defaultUnit", "kg"),
      harvestLeadDays: await get("garden.harvestLeadDays", 5),
      plantingLeadDays: await get("garden.plantingLeadDays", 7),
    },
  };
}
function inQuietHours(now, settings) {
  const q = settings?.quietHours || { start: 21, end: 7 };
  const h = now.getHours();
  if ((q.start ?? 21) < (q.end ?? 7)) return h >= (q.start ?? 21) && h < (q.end ?? 7);
  return h >= (q.start ?? 21) || h < (q.end ?? 7);
}
async function isSabbath(now = new Date()) {
  try {
    const ont = await safeImportMany(["@/shared/ontology.js", "@/shared/ontology"]);
    const win = ont?.sabbath?.(now);
    if (win?.startISO && win?.endISO) return now >= new Date(win.startISO) && now < new Date(win.endISO);
  } catch {}
  const day = now.getDay();
  const fri18 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((5 - day + 7) % 7), 18, 0, 0, 0);
  const sat18 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((6 - day + 7) % 7), 18, 0, 0, 0);
  return now >= fri18 && now < sat18;
}

// External modules (soft)
async function DB() {
  return await safeImportMany(["@/db/index.js", "@/db", "../db", "../../db"]);
}
async function gardenAgent() {
  return await safeImportMany(["@/agents/gardeningAgent.js", "@/agents/gardeningAgent"]);
}
async function harvestAgent() {
  return await safeImportMany(["@/agents/gardenHarvestAgent.js", "@/agents/gardenHarvestAgent"]);
}
async function preservationAgent() {
  return await safeImportMany(["@/agents/preservationAgent.js", "@/agents/preservationAgent"]);
}
async function inventoryAgent() {
  return await safeImportMany(["@/agents/inventoryAgent.js", "@/agents/inventoryAgent"]);
}
async function n8nClient() {
  return await safeImportMany(["@/services/n8nClient.js", "@/services/n8nClient"]);
}

let EVENTS = {};
(async () => {
  const ont = await safeImportMany(["@/shared/ontology.js", "@/shared/ontology"]);
  EVENTS = ont?.EVENTS || {};
})();

/* ---------------------------------------------
   Local persistence (Dexie + localStorage)
----------------------------------------------*/
const LSK = "suka.gardenStore.v2";
async function saveSnapshot(snap) {
  const DexieDB = await DB();
  try { await DexieDB?.userMeta?.put?.({ key: LSK, value: snap, updatedAt: safeNowISO() }); } catch {}
  try { localStorage.setItem(LSK, JSON.stringify(snap)); } catch {}
}
async function restoreSnapshot() {
  const DexieDB = await DB();
  try {
    const doc = await DexieDB?.userMeta?.get?.({ key: LSK });
    if (doc?.value) return doc.value;
  } catch {}
  try { const raw = localStorage.getItem(LSK); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/* ---------------------------------------------
   Domain helpers
----------------------------------------------*/
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function isISOOnOrAfter(aISO, bISO) { return new Date(aISO) >= new Date(bISO); }
function daysBetween(a, b) { return Math.round((a - b) / 86400000); }

function parseTimeToToday(timeHHMM, base = new Date()) {
  const [hh, mm] = String(timeHHMM || "10:00").split(":").map(Number);
  const d = new Date(base);
  d.setHours(hh || 0, mm || 0, 0, 0);
  return d;
}

function normalizePlot(plot) {
  return {
    id: normalizeId(plot.id || `${plot.crop || "plot"}-${Date.now()}`),
    crop: normalizeCrop(plot.crop),
    area: toNumber(plot.area, 0),
    plantedOnISO: plot.plantedOn ? toDateISO(plot.plantedOn) : (plot.plantedOnISO || null),
    expectedHarvestISO: plot.expectedHarvestDate ? toDateISO(plot.expectedHarvestDate) : (plot.expectedHarvestISO || null),
    yieldEstimate: toNumber(plot.yieldEstimate, 0),
    preserved: !!plot.preserved,
    meta: plot.meta || {},
  };
}

function normalizeHarvest(h) {
  return {
    id: normalizeId(h.id || `${normalizeCrop(h.crop) || "harvest"}-${Date.now()}`),
    crop: normalizeCrop(h.crop),
    quantity: toNumber(h.quantity, 0),
    unit: h.unit || null,
    harvestedOnISO: toDateISO(h.harvestedOn || h.harvestedOnISO),
    preserved: !!h.preserved,
    movedToCellar: !!h.movedToCellar,
    meta: h.meta || {},
  };
}

/* ---------------------------------------------
   Store
----------------------------------------------*/
export const useGardenStore = create((set, get) => ({
  plots: [],
  harvests: [],
  meta: {
    lastUpdatedISO: null,
    profileKey: "standard-home",
    sabbathAvoid: true,
    busy: false,
  },

  /* ---------- lifecycle / hydration ---------- */
  init: async () => {
    const settings = await loadSettings();
    const snap = await restoreSnapshot();
    set((s) => ({
      plots: Array.isArray(snap?.plots) ? snap.plots : s.plots,
      harvests: Array.isArray(snap?.harvests) ? snap.harvests : s.harvests,
      meta: { ...(s.meta), ...(snap?.meta || {}), profileKey: settings.profileKey, sabbathAvoid: settings.sabbathAvoid },
    }));
    broadcast("garden:init", { at: safeNowISO() });
    return true;
  },

  /* ---------- plots ---------- */
  addPlot: async (plot) => {
    if (!plot) return;
    const p = normalizePlot(plot);
    const prev = get().plots;
    if (prev.some((x) => x.id === p.id)) return;
    const next = [...prev, p];
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ plots: next, meta });
    saveSnapshot({ plots: next, harvests: get().harvests, meta }).catch(() => {});
    // persist to Dexie table if exists
    try { await (await DB())?.gardenPlots?.put?.(p); } catch {}
    broadcast("garden:plots:changed", { op: "add", plotId: p.id });

    // Ask agent to compute expected harvest date if missing
    if (!p.expectedHarvestISO) {
      try {
        const agent = await gardenAgent();
        const res = await agent?.handleCommand?.("estimateHarvestDate", { crop: p.crop, plantedOnISO: p.plantedOnISO, area: p.area });
        if (res?.expectedHarvestISO) {
          get().updatePlot(p.id, { expectedHarvestISO: res.expectedHarvestISO });
        }
      } catch {}
    }
  },

  updatePlot: async (id, updates) => {
    const pid = normalizeId(id);
    if (!pid || !updates || typeof updates !== "object") return;
    const prev = get().plots;
    let changed = false;
    const next = prev.map((p) => {
      if (p.id !== pid) return p;
      const merged = normalizePlot({ ...p, ...updates });
      if (JSON.stringify(merged) === JSON.stringify(p)) return p;
      changed = true;
      return merged;
    });
    if (!changed) return;
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ plots: next, meta });
    saveSnapshot({ plots: next, harvests: get().harvests, meta }).catch(() => {});
    try { await (await DB())?.gardenPlots?.put?.(next.find((x) => x.id === pid)); } catch {}
    broadcast("garden:plots:changed", { op: "update", plotId: pid });
  },

  removePlot: async (id) => {
    const pid = normalizeId(id);
    const prev = get().plots;
    const next = prev.filter((p) => p.id !== pid);
    if (next.length === prev.length) return;
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ plots: next, meta });
    saveSnapshot({ plots: next, harvests: get().harvests, meta }).catch(() => {});
    try { await (await DB())?.gardenPlots?.delete?.(pid); } catch {}
    broadcast("garden:plots:changed", { op: "remove", plotId: pid });
  },

  /* ---------- harvests ---------- */
  logHarvest: async ({ crop, quantity, unit, harvestedOn }) => {
    const settings = await loadSettings();
    const hv = normalizeHarvest({ crop, quantity, unit: unit || settings.garden.defaultUnit, harvestedOn });
    const prev = get().harvests;
    const next = [...prev, hv];
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ harvests: next, meta });
    saveSnapshot({ plots: get().plots, harvests: next, meta }).catch(() => {});
    try { await (await DB())?.gardenHarvests?.put?.(hv); } catch {}
    broadcast(EVENTS?.GARDEN?.HARVEST_WINDOW || "GARDEN.HARVEST.WINDOW", { crop: hv.crop, at: hv.harvestedOnISO });

    // Ask preservation agent for options & reserve jars if needed
    try {
      const pres = await preservationAgent();
      const suggestion = await pres?.estimatePlan?.({}, { inputs: [{ crop: hv.crop, qty: hv.quantity, unit: hv.unit }] });
      if (suggestion?.requirements?.length) {
        const inv = await inventoryAgent();
        await inv?.handleCommand?.("reserveItems", { lines: suggestion.requirements.map((r) => ({
          key: r.key || r.name, qty: r.qty, unit: r.unit, reason: "preservation"
        })) });
        broadcast("inventory:delta", { at: safeNowISO(), reason: "preservation", lines: suggestion.requirements });
      }
    } catch {}

    // n8n
    try {
      const n8n = await n8nClient();
      await n8n?.runWorkflowByName?.("Suka: Garden Harvest Event", { harvest: hv });
    } catch {}
    return hv;
  },

  markPreserved: async (harvestId, status = true) => {
    const hid = normalizeId(harvestId);
    const prev = get().harvests;
    let changed = false;
    const next = prev.map((h) => {
      if (h.id !== hid) return h;
      if (h.preserved === !!status) return h;
      changed = true;
      return { ...h, preserved: !!status };
    });
    if (!changed) return;
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ harvests: next, meta });
    saveSnapshot({ plots: get().plots, harvests: next, meta }).catch(() => {});
    try { await (await DB())?.gardenHarvests?.put?.(next.find((x) => x.id === hid)); } catch {}
    broadcast("garden:harvests:changed", { op: "preserved", harvestId: hid, status: !!status });
  },

  moveToCellar: async (harvestId) => {
    const hid = normalizeId(harvestId);
    const prev = get().harvests;
    let changed = false;
    const next = prev.map((h) => {
      if (h.id !== hid) return h;
      if (h.movedToCellar) return h;
      changed = true;
      return { ...h, movedToCellar: true };
    });
    if (!changed) return;
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ harvests: next, meta });
    saveSnapshot({ plots: get().plots, harvests: next, meta }).catch(() => {});
    try { await (await DB())?.gardenHarvests?.put?.(next.find((x) => x.id === hid)); } catch {}
    broadcast("garden:harvests:changed", { op: "cellar", harvestId: hid });
  },

  /* ---------- selectors ---------- */
  getUnpreservedHarvests: () => get().harvests.filter((h) => !h.preserved),
  getPreservedHarvests:   () => get().harvests.filter((h) => h.preserved && !h.movedToCellar),
  getHarvestSummaryByCrop: () => get().harvests.reduce((acc, h) => {
    const key = normalizeCrop(h.crop);
    acc[key] = (acc[key] || 0) + toNumber(h.quantity, 0);
    return acc;
  }, {}),

  /* ---------- inventory sync helpers ---------- */
  reserveForPlanting: async ({ seeds = [], amendments = [] } = {}) => {
    const inv = await inventoryAgent();
    const lines = [
      ...seeds.map((s) => ({ key: s.key || s.name, qty: s.qty, unit: s.unit || "pkt", reason: "planting" })),
      ...amendments.map((a) => ({ key: a.key || a.name, qty: a.qty, unit: a.unit || "kg", reason: "planting" })),
    ].filter((l) => l.key && l.qty > 0);
    if (!lines.length) return { ok: false, reason: "empty" };
    try {
      await inv?.handleCommand?.("reserveItems", { lines });
      broadcast("inventory:delta", { at: safeNowISO(), reason: "planting", lines });
      return { ok: true, lines };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  },

  /* ---------- intelligence: windows, risk, suggestions ---------- */
  computeHarvestWindows: async ({ now = new Date() } = {}) => {
    const settings = await loadSettings();
    const lead = Number(settings.garden.harvestLeadDays || 5);
    const list = get().plots;
    const out = [];
    for (const p of list) {
      if (!p.expectedHarvestISO) continue;
      const harvest = new Date(p.expectedHarvestISO);
      const open = addDays(harvest, -lead);
      if (now >= open && now <= addDays(harvest, lead)) {
        out.push({ plotId: p.id, crop: p.crop, windowStartISO: open.toISOString(), windowEndISO: addDays(harvest, lead).toISOString() });
      }
    }
    return out;
  },

  computePlantingWindows: async ({ now = new Date() } = {}) => {
    try {
      const agent = await gardenAgent();
      const res = await agent?.estimatePlan?.({}, { window: "this-week", intent: "planting" });
      // Shape: [{ crop, bestDayISO, seedKey?, notes? }]
      return Array.isArray(res?.suggestions) ? res.suggestions : [];
    } catch {
      // Fallback: recommend planting if no plantedOn & season (rough)
      const month = now.getMonth() + 1;
      const coolSeason = [3,4,5,9,10].includes(month);
      const warmSeason = [5,6,7].includes(month);
      const crops = coolSeason ? ["lettuce","kale","radish"] : (warmSeason ? ["tomato","pepper","beans"] : ["garlic"]);
      return crops.map((c, i) => ({ crop: c, bestDayISO: addDays(now, i + 1).toISOString() }));
    }
  },

  detectPestRisk: async () => {
    try {
      const agent = await gardenAgent();
      const res = await agent?.handleCommand?.("detectPestRisk", { plots: get().plots });
      return res?.risks || []; // [{crop, risk:'low|med|high', notes}]
    } catch { return []; }
  },

  suggestGardenTasks: async ({ max = 6 } = {}) => {
    // Prefer agents
    try {
      const agent = await gardenAgent();
      const res = await agent?.estimatePlan?.({}, { window: "this-week" });
      if (Array.isArray(res?.suggestions) && res.suggestions.length) {
        return res.suggestions.slice(0, max).map((s, i) => ({
          id: s.id || `g_${i}`,
          title: s.title || s.text || `Task ${i + 1}`,
          crop: s.crop || null,
          estMin: Number(s.estMin ?? 10),
          category: "gardening",
        }));
      }
    } catch {}
    // Fallback: care for nearest-harvest plots
    const windows = await get().computeHarvestWindows({});
    return windows.slice(0, max).map((w, i) => ({
      id: `w_${w.plotId}_${i}`,
      title: `Prep for ${w.crop} harvest`,
      crop: w.crop,
      estMin: 10,
      category: "gardening",
    }));
  },

  /* ---------- reminders (Sabbath/quiet-aware) ---------- */
  todaysReminders: async ({ now = new Date() } = {}) => {
    const settings = await loadSettings();
    const sabbath = settings.sabbathAvoid !== false && (await isSabbath(now));
    const quiet = inQuietHours(now, settings);
    const reminders = [];

    // Planting window (morning)
    const planting = await get().computePlantingWindows({ now });
    if (planting.length && !sabbath) {
      reminders.push({
        atISO: parseTimeToToday("09:30", now).toISOString(),
        label: `Planting window: ${planting.map((p) => p.crop).slice(0,3).join(", ")}`,
        type: "planting",
        gentle: quiet,
      });
    }

    // Harvest window (afternoon)
    const harvests = await get().computeHarvestWindows({ now });
    if (harvests.length) {
      reminders.push({
        atISO: parseTimeToToday("15:30", now).toISOString(),
        label: `Harvest soon: ${harvests.map((h) => h.crop).slice(0,3).join(", ")}`,
        type: "harvest",
        gentle: sabbath || quiet, // harvesting can be essential; keep gentle on Sabbath
      });
    }

    // Pest risk (evening)
    const risks = await get().detectPestRisk();
    const high = risks.filter((r) => /high/i.test(r.risk));
    if (high.length && !sabbath) {
      reminders.push({
        atISO: parseTimeToToday("18:00", now).toISOString(),
        label: `Pest alert: ${high.map((h) => h.crop).slice(0,2).join(", ")}`,
        type: "pest",
        gentle: quiet,
      });
    }

    return reminders.sort((a, b) => new Date(a.atISO) - new Date(b.atISO));
  },

  /* ---------- cross-domain adoption ---------- */
  adoptFromRecipes: async ({ items = [] } = {}) => {
    // For each vegetable/herb ingredient found in recipes, propose a plot if missing
    const vegKeys = new Set(["tomato","pepper","onion","garlic","kale","lettuce","bean","cucumber","basil","cilantro"]);
    const crops = new Set();
    for (const it of items) {
      const name = String(it?.name || it?.key || "").toLowerCase();
      for (const k of vegKeys) if (name.includes(k)) crops.add(k);
    }
    if (!crops.size) return 0;

    const add = [];
    for (const crop of crops) {
      if (!get().plots.some((p) => String(p.crop).toLowerCase() === crop)) {
        add.push({ crop, area: 2, plantedOn: null, expectedHarvestDate: null, yieldEstimate: 0 });
      }
    }
    for (const p of add) await get().addPlot(p);
    return add.length;
  },

  /* ---------- utils ---------- */
  resetGarden: async () => {
    const had = get().plots.length || get().harvests.length;
    if (!had) return;
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ plots: [], harvests: [], meta });
    saveSnapshot({ plots: [], harvests: [], meta }).catch(() => {});
    try {
      const db = await DB();
      await db?.gardenPlots?.clear?.();
      await db?.gardenHarvests?.clear?.();
    } catch {}
    broadcast("garden:reset", { at: meta.lastUpdatedISO });
  },
}));

/* ---------------------------------------------
   Optional selector helpers (lean components)
----------------------------------------------*/
export const useGardenPlots = () => useGardenStore((s) => s.plots, shallow);
export const useHarvests   = () => useGardenStore((s) => s.harvests, shallow);
export const useGardenMeta = () => useGardenStore((s) => s.meta, shallow);

export const useGardenActions = () =>
  useGardenStore(
    (s) => ({
      init: s.init,

      addPlot: s.addPlot,
      updatePlot: s.updatePlot,
      removePlot: s.removePlot,

      logHarvest: s.logHarvest,
      markPreserved: s.markPreserved,
      moveToCellar: s.moveToCellar,

      getUnpreservedHarvests: s.getUnpreservedHarvests,
      getPreservedHarvests: s.getPreservedHarvests,
      getHarvestSummaryByCrop: s.getHarvestSummaryByCrop,

      reserveForPlanting: s.reserveForPlanting,

      computeHarvestWindows: s.computeHarvestWindows,
      computePlantingWindows: s.computePlantingWindows,
      detectPestRisk: s.detectPestRisk,
      suggestGardenTasks: s.suggestGardenTasks,

      todaysReminders: s.todaysReminders,
      adoptFromRecipes: s.adoptFromRecipes,

      resetGarden: s.resetGarden,
    }),
    shallow
  );

// Auto-init (non-blocking)
useGardenStore.getState().init?.();
