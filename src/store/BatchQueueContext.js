// C:\Users\larho\suka-smart-assistant\src\store\BatchQueueContext.js
/**
 * BatchQueueContext (dynamic, agent- & Sabbath-aware)
 * ---------------------------------------------------
 * Centralized Zustand store for building batch cooking sessions.
 *
 * Goals this serves:
 * - Intuitive queue UX: add/remove/clear, per-recipe portions, totals
 * - Soft integrations: Dexie persistence, cookingBus session creation,
 *   inventoryAgent reservations, orchestrator/socket events
 * - Sabbath & quiet-hours awareness on session creation
 * - Resilient: all external deps are optional (safe-imported)
 *
 * State shape:
 * {
 *   selectedRecipes: [{
 *     id, title, portions, steps?, ingredients?, tags?, meta?
 *   }],
 *   meta: { lastUpdatedISO, profileKey, sabbathAvoid, busy },
 * }
 *
 * Public actions:
 *  - setSelectedRecipes(list)
 *  - addRecipeToBatch(recipe, opts?)
 *  - removeRecipeFromBatch(id)
 *  - clearBatchQueue()
 *  - setRecipePortions(id, portions)
 *  - estimateSession() -> { summary, suggestions?, minutes? }    (best-effort)
 *  - createSession({ userId, title?, batch? }) -> session|{deferred:true}
 *  - reserveInventory() -> { ok, lines? }
 *  - adoptFromConsolidation({ items, title? }) -> void            (quick-fill)
 */

import { create } from "zustand";

// -------------------- Safe dynamic imports --------------------
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

async function loadSettings() {
  const Settings = await safeImportMany(["@/store/SettingsStore.js", "@/store/SettingsStore"]);
  const get = async (k, d) => {
    try { const v = await Settings?.get?.(k); return v ?? d; } catch { return d; }
  };
  return {
    profileKey: await get("profile.key", "standard-home"),
    sabbathAvoid: await get("sabbath.avoidSaturday", true),
  };
}

async function isSabbathNow() {
  try {
    const ont = await safeImportMany(["@/shared/ontology.js", "@/shared/ontology"]);
    const win = ont?.sabbath?.(new Date());
    if (win?.startISO && win?.endISO) {
      const now = new Date();
      return now >= new Date(win.startISO) && now < new Date(win.endISO);
    }
  } catch {}
  // Fallback Fri 18:00 → Sat 18:00
  const now = new Date();
  const day = now.getDay();
  const fri18 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((5 - day + 7) % 7), 18, 0, 0, 0);
  const sat18 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((6 - day + 7) % 7), 18, 0, 0, 0);
  return now >= fri18 && now < sat18;
}

// -------------------- Local persistence (Dexie + localStorage) --------------------
const LSK = "suka.batchQueue.v2";
async function saveStateToDexie(snap) {
  const DexieDB = await safeImportMany(["@/db/index.js", "@/db", "../db", "../../db"]);
  try {
    await DexieDB?.userMeta?.put?.({ key: LSK, value: snap, updatedAt: safeNowISO() });
  } catch {}
  try { localStorage.setItem(LSK, JSON.stringify(snap)); } catch {}
}
async function restoreStateFromDexie() {
  const DexieDB = await safeImportMany(["@/db/index.js", "@/db", "../db", "../../db"]);
  try {
    const doc = await DexieDB?.userMeta?.get?.({ key: LSK });
    if (doc?.value) return doc.value;
  } catch {}
  try {
    const raw = localStorage.getItem(LSK);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// -------------------- Helpers --------------------
const arraysShallowEqual = (a, b) => {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]?.id === b[i]?.id) continue; else return false;
  return true;
};

const normalizeRecipe = (r, i = 0) => ({
  id: r?.id || r?._id || `recipe_${i}_${Math.random().toString(36).slice(2,8)}`,
  title: r?.title || r?.name || `Recipe ${i + 1}`,
  portions: Number(r?.portions ?? 4) || 4,
  steps: Array.isArray(r?.steps) ? r.steps : (Array.isArray(r?.instructions) ? r.instructions : []),
  ingredients: Array.isArray(r?.ingredients) ? r.ingredients : [],
  tags: Array.isArray(r?.tags) ? r.tags : [],
  meta: r?.meta || {},
});

function computeTotals(list = []) {
  const count = list.length;
  const portions = list.reduce((a, r) => a + Number(r.portions || 0), 0);
  return { count, portions };
}

// Build inventory reservation lines from normalized recipes
function inventoryLinesFromRecipes(list = []) {
  // We expect ingredients like { key|name, qty|quantity|amount, unit }
  const lines = [];
  for (const r of list) {
    const scale = Math.max(1, Number(r.portions || 4)) / Math.max(1, Number(r.meta?.basePortions || 4));
    for (const ing of r.ingredients || []) {
      const name = ing.key || ing.name || ing.item || null;
      const qtyRaw = ing.qty ?? ing.quantity ?? ing.amount ?? null;
      const unit = ing.unit || ing.u || null;
      if (!name || qtyRaw == null) continue;
      const qty = Number(qtyRaw) * (isFinite(scale) ? scale : 1);
      lines.push({ key: name, qty, unit, reason: "batch-queue", meta: { recipeId: r.id } });
    }
  }
  return lines;
}

// -------------------- Zustand Store --------------------
export const useBatchQueueStore = create((set, get) => ({
  // state
  selectedRecipes: [],
  meta: {
    lastUpdatedISO: null,
    profileKey: "standard-home",
    sabbathAvoid: true,
    busy: false,
  },

  // hydration
  hydrate: async () => {
    const snap = await restoreStateFromDexie();
    const settings = await loadSettings();
    if (snap && Array.isArray(snap.selectedRecipes)) {
      set({
        selectedRecipes: snap.selectedRecipes,
        meta: { ...(get().meta), ...snap.meta, profileKey: settings.profileKey, sabbathAvoid: settings.sabbathAvoid },
      });
    } else {
      set({ meta: { ...(get().meta), lastUpdatedISO: safeNowISO(), profileKey: settings.profileKey, sabbathAvoid: settings.sabbathAvoid } });
    }
  },

  // Set full list (no-op if unchanged ids)
  setSelectedRecipes: async (recipes) => {
    const next = Array.isArray(recipes) ? recipes.map((r, i) => normalizeRecipe(r, i)) : [];
    const prev = get().selectedRecipes;
    if (arraysShallowEqual(prev, next)) return;
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ selectedRecipes: next, meta });
    saveStateToDexie({ selectedRecipes: next, meta }).catch(() => {});
    broadcast("batchQueue:changed", { size: next.length, at: meta.lastUpdatedISO });
  },

  addRecipeToBatch: async (recipe, opts = {}) => {
    if (!recipe) return;
    const rec = normalizeRecipe({ ...recipe, portions: opts.portions ?? recipe.portions }, 0);
    const prev = get().selectedRecipes;
    if (prev.some((r) => r.id === rec.id)) return;
    const next = [...prev, rec];
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ selectedRecipes: next, meta });
    saveStateToDexie({ selectedRecipes: next, meta }).catch(() => {});
    broadcast("batchQueue:changed", { size: next.length, at: meta.lastUpdatedISO, op: "add", id: rec.id });
  },

  removeRecipeFromBatch: async (id) => {
    const prev = get().selectedRecipes;
    const next = prev.filter((r) => r.id !== id);
    if (next.length === prev.length) return;
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ selectedRecipes: next, meta });
    saveStateToDexie({ selectedRecipes: next, meta }).catch(() => {});
    broadcast("batchQueue:changed", { size: next.length, at: meta.lastUpdatedISO, op: "remove", id });
  },

  clearBatchQueue: async () => {
    if (get().selectedRecipes.length === 0) return;
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ selectedRecipes: [], meta });
    saveStateToDexie({ selectedRecipes: [], meta }).catch(() => {});
    broadcast("batchQueue:changed", { size: 0, at: meta.lastUpdatedISO, op: "clear" });
  },

  setRecipePortions: async (id, portions) => {
    const p = Math.max(1, Math.round(Number(portions) || 1));
    const list = get().selectedRecipes.map((r) => (r.id === id ? { ...r, portions: p } : r));
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ selectedRecipes: list, meta });
    saveStateToDexie({ selectedRecipes: list, meta }).catch(() => {});
    broadcast("batchQueue:changed", { size: list.length, at: meta.lastUpdatedISO, op: "portions", id, portions: p });
  },

  // Quick-fill from a consolidation result (e.g., recipes/consolidated event)
  adoptFromConsolidation: async ({ items = [], title } = {}) => {
    const normalized = (items || []).map((r, i) => normalizeRecipe(r, i));
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO(), adoptedTitle: title || null };
    set({ selectedRecipes: normalized, meta });
    saveStateToDexie({ selectedRecipes: normalized, meta }).catch(() => {});
    broadcast("batchQueue:changed", { size: normalized.length, adopted: true });
  },

  // -------- Estimates & creation --------
  estimateSession: async () => {
    const list = get().selectedRecipes;
    if (!list.length) return { summary: "No recipes selected", suggestions: [], minutes: 0 };
    // Prefer cookingAgent.estimatePlan
    try {
      const agent = await safeImportMany(["@/agents/cookingAgent.js", "@/agents/cookingAgent"]);
      const ctx = {}; // you can plumb household context here if desired
      const res = await agent?.estimatePlan?.(ctx, { recipes: list, batch: true });
      if (res?.summary) return res;
    } catch {}
    // Fallback: simple estimate = 15min base + 12min/recipe
    const minutes = 15 + list.length * 12;
    return { summary: `Approx ${minutes} minutes for ${list.length} recipe(s).`, suggestions: [], minutes };
  },

  createSession: async ({ userId = "localUser", title = "Batch Cooking", batch = true } = {}) => {
    const list = get().selectedRecipes;
    if (!list.length) return null;

    const settings = await loadSettings();
    const sabbath = settings.sabbathAvoid !== false && (await isSabbathNow());
    if (sabbath) {
      // Don’t block user; return a soft deferral signal the UI can interpret
      return { deferred: true, reason: "sabbath", message: "Sabbath is active. Session will be gentler if deferred." };
    }

    set({ meta: { ...(get().meta), busy: true } });
    try {
      const cookingBus = await safeImportMany(["@/services/cookingBus.js", "@/services/cookingBus"]);
      const session = await cookingBus?.createSession?.({
        userId,
        title,
        batch,
        recipes: list,
        meta: { from: "BatchQueue", profile: get().meta.profileKey },
      });
      if (session?.id) {
        broadcast("SESSION.PLANNED.COOKING", { sessionId: session.id, count: list.length });
      }
      return session;
    } finally {
      set({ meta: { ...(get().meta), busy: false } });
    }
  },

  // Reserve inventory for selected recipes (best-effort)
  reserveInventory: async () => {
    const list = get().selectedRecipes;
    if (!list.length) return { ok: false, reason: "empty" };
    const lines = inventoryLinesFromRecipes(list).filter(l => l.qty > 0);
    try {
      const inv = await safeImportMany(["@/agents/inventoryAgent.js", "@/agents/inventoryAgent"]);
      await inv?.handleCommand?.("reserveItems", { lines });
      broadcast("inventory:delta", { at: safeNowISO(), lines, reason: "batch-queue:reserve" });
      return { ok: true, lines };
    } catch (e) {
      return { ok: false, error: String(e?.message || e), lines };
    }
  },

  // -------- Selectors (computed on demand) --------
  totals: () => computeTotals(get().selectedRecipes),
}));

// -------------------- Convenience selector hooks --------------------
export const useSelectedRecipes = () =>
  useBatchQueueStore((s) => s.selectedRecipes);

export const useBatchQueueMeta = () =>
  useBatchQueueStore((s) => s.meta);

export const useBatchQueueTotals = () =>
  useBatchQueueStore((s) => s.totals());

export const useBatchQueueActions = () => {
  const api = useBatchQueueStore.getState();
  return {
    hydrate: api.hydrate,
    setSelectedRecipes: api.setSelectedRecipes,
    addRecipeToBatch: api.addRecipeToBatch,
    removeRecipeFromBatch: api.removeRecipeFromBatch,
    clearBatchQueue: api.clearBatchQueue,
    setRecipePortions: api.setRecipePortions,
    estimateSession: api.estimateSession,
    createSession: api.createSession,
    reserveInventory: api.reserveInventory,
    adoptFromConsolidation: api.adoptFromConsolidation,
  };
};

// Auto-hydrate on first import (non-blocking)
useBatchQueueStore.getState().hydrate?.();
