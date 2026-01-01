// C:\Users\larho\suka-smart-assistant\src\store\BatchQueueStore.js
/**
 * BatchQueueStore (dynamic, agent- & Sabbath-aware)
 * -------------------------------------------------
 * Unified queue for building batch cooking sessions.
 *
 * Enhancements over the original:
 * - Safe dynamic integrations (Dexie persistence, cookingBus, inventoryAgent, socket)
 * - Sabbath-aware session creation (soft deferral)
 * - Per-recipe portions + total portions helper
 * - Inventory reservation lines derived from ingredients
 * - Resilient: all deps are optional and safely imported
 *
 * State shape:
 * {
 *   queue: [{ id, title|name, ingredients[], steps[], tags[], isSelected, portions, meta? }],
 *   meta:  { lastUpdatedISO, profileKey, sabbathAvoid, busy }
 * }
 */

import { create } from "zustand";
import { shallow } from "zustand/shallow";

/* ---------------------------------------------
   Safe dynamic imports & helpers
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

/* ---------------------------------------------
   Local persistence (Dexie + localStorage)
----------------------------------------------*/
const LSK = "suka.batchQueueStore.v2";

async function saveStateSnapshot(snap) {
  const DexieDB = await safeImportMany(["@/db/index.js", "@/db", "../db", "../../db"]);
  try { await DexieDB?.userMeta?.put?.({ key: LSK, value: snap, updatedAt: safeNowISO() }); } catch {}
  try { localStorage.setItem(LSK, JSON.stringify(snap)); } catch {}
}

async function restoreStateSnapshot() {
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

/* ---------------------------------------------
   Utilities
----------------------------------------------*/
function arraysShallowEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]?.id === b[i]?.id) continue; else return false;
  return true;
}

function normalizeRecipe(r, i = 0) {
  return {
    id: r?.id || r?._id || `recipe_${i}_${Math.random().toString(36).slice(2,8)}`,
    title: r?.title || r?.name || `Recipe ${i + 1}`,
    ingredients: Array.isArray(r?.ingredients) ? r.ingredients : [],
    steps: Array.isArray(r?.steps) ? r.steps : (Array.isArray(r?.instructions) ? r.instructions : []),
    tags: Array.isArray(r?.tags) ? r.tags : [],
    isSelected: !!r?.isSelected,
    portions: Number(r?.portions ?? 4) || 4,
    meta: r?.meta || {},
  };
}

function inventoryLinesFromRecipes(list = []) {
  const lines = [];
  for (const r of list) {
    const scale = Math.max(1, Number(r.portions || 4)) / Math.max(1, Number(r.meta?.basePortions || 4));
    for (const ing of r.ingredients || []) {
      const key = ing.key || ing.name || ing.item || null;
      const qtyRaw = ing.qty ?? ing.quantity ?? ing.amount ?? null;
      const unit = ing.unit || ing.u || null;
      if (!key || qtyRaw == null) continue;
      const qty = Number(qtyRaw) * (isFinite(scale) ? scale : 1);
      lines.push({ key, qty, unit, reason: "batch-queue", meta: { recipeId: r.id } });
    }
  }
  return lines;
}

function computeTotals(list = []) {
  return {
    count: list.length,
    portions: list.reduce((a, r) => a + Number(r.portions || 0), 0),
    selected: list.filter((r) => r.isSelected).length,
  };
}

/* ---------------------------------------------
   Store
----------------------------------------------*/
export const useBatchQueueStore = create((set, get) => ({
  queue: [],
  meta: { lastUpdatedISO: null, profileKey: "standard-home", sabbathAvoid: true, busy: false },

  // ---------- hydration ----------
  hydrate: async () => {
    const snap = await restoreStateSnapshot();
    const settings = await loadSettings();
    if (snap && Array.isArray(snap.queue)) {
      set({
        queue: snap.queue,
        meta: { ...(get().meta), ...(snap.meta || {}), profileKey: settings.profileKey, sabbathAvoid: settings.sabbathAvoid },
      });
    } else {
      set({ meta: { ...(get().meta), lastUpdatedISO: safeNowISO(), profileKey: settings.profileKey, sabbathAvoid: settings.sabbathAvoid } });
    }
  },

  // ---------- core queue ops ----------
  addToQueue: (recipe) => {
    if (!recipe) return;
    const rec = normalizeRecipe(recipe, 0);
    const prev = get().queue;
    if (prev.some((r) => r.id === rec.id)) return; // no duplicates
    const next = [...prev, rec];
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ queue: next, meta });
    saveStateSnapshot({ queue: next, meta }).catch(() => {});
    broadcast("batchQueue:changed", { op: "add", id: rec.id, size: next.length, at: meta.lastUpdatedISO });
  },

  removeFromQueue: (id) => {
    const prev = get().queue;
    const next = prev.filter((r) => r.id !== id);
    if (next.length === prev.length) return;
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ queue: next, meta });
    saveStateSnapshot({ queue: next, meta }).catch(() => {});
    broadcast("batchQueue:changed", { op: "remove", id, size: next.length, at: meta.lastUpdatedISO });
  },

  clearQueue: () => {
    const prev = get().queue;
    if (!prev.length) return;
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ queue: [], meta });
    saveStateSnapshot({ queue: [], meta }).catch(() => {});
    broadcast("batchQueue:changed", { op: "clear", size: 0, at: meta.lastUpdatedISO });
  },

  reorderQueue: (sourceIndex, destinationIndex) => {
    const prev = get().queue;
    if (
      sourceIndex === destinationIndex ||
      sourceIndex < 0 ||
      destinationIndex < 0 ||
      sourceIndex >= prev.length ||
      destinationIndex >= prev.length
    ) return;

    const updated = [...prev];
    const [moved] = updated.splice(sourceIndex, 1);
    updated.splice(destinationIndex, 0, moved);

    if (arraysShallowEqual(prev, updated)) return;
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ queue: updated, meta });
    saveStateSnapshot({ queue: updated, meta }).catch(() => {});
    broadcast("batchQueue:changed", { op: "reorder", from: sourceIndex, to: destinationIndex, at: meta.lastUpdatedISO });
  },

  toggleSelection: (id) => {
    const prev = get().queue;
    let changed = false;
    const updated = prev.map((r) => {
      if (r.id !== id) return r;
      changed = true;
      return { ...r, isSelected: !r.isSelected };
    });
    if (!changed) return;
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ queue: updated, meta });
    saveStateSnapshot({ queue: updated, meta }).catch(() => {});
  },

  updateRecipeSteps: (id, newSteps) => {
    const prev = get().queue;
    let changed = false;
    const updated = prev.map((r) => {
      if (r.id !== id) return r;
      if (r.steps === newSteps) return r;
      changed = true;
      return { ...r, steps: Array.isArray(newSteps) ? newSteps : r.steps };
    });
    if (!changed) return;
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ queue: updated, meta });
    saveStateSnapshot({ queue: updated, meta }).catch(() => {});
  },

  setRecipePortions: (id, portions) => {
    const p = Math.max(1, Math.round(Number(portions) || 1));
    const prev = get().queue;
    const updated = prev.map((r) => (r.id === id ? { ...r, portions: p } : r));
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ queue: updated, meta });
    saveStateSnapshot({ queue: updated, meta }).catch(() => {});
    broadcast("batchQueue:changed", { op: "portions", id, portions: p, at: meta.lastUpdatedISO });
  },

  // ---------- selectors ----------
  getSelectedRecipes: () => get().queue.filter((r) => r.isSelected),
  totals: () => computeTotals(get().queue),

  // ---------- inventory sync / reservation ----------
  syncWithInventory: (inventoryItems) => {
    const items = Array.isArray(inventoryItems) ? inventoryItems : [];
    const lookup = new Map(items.map((i) => [String(i?.name || i?.key || "").toLowerCase(), i]));

    const prev = get().queue;
    let changed = false;

    const updated = prev.map((recipe) => {
      const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
      let ingChanged = false;
      const syncedIngredients = ingredients.map((ing) => {
        const key = String(ing?.name || ing?.key || "").toLowerCase();
        const match = lookup.get(key);
        const desired = Number(ing?.quantity ?? ing?.qty ?? ing?.amount ?? 0);
        const availableQty = Number(match?.quantity ?? match?.qty ?? 0);
        const available = availableQty >= desired && desired > 0;
        if (ing.available === available) return ing;
        ingChanged = true;
        return { ...ing, available };
      });
      if (!ingChanged) return recipe;
      changed = true;
      return { ...recipe, ingredients: syncedIngredients };
    });

    if (!changed) return;
    const meta = { ...(get().meta), lastUpdatedISO: safeNowISO() };
    set({ queue: updated, meta });
    saveStateSnapshot({ queue: updated, meta }).catch(() => {});
  },

  reserveInventory: async () => {
    const selected = get().getSelectedRecipes();
    const list = selected.length ? selected : get().queue; // reserve for selected if any, else all
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

  // ---------- estimation & session creation ----------
  estimateSession: async () => {
    const selected = get().getSelectedRecipes();
    const list = selected.length ? selected : get().queue;
    if (!list.length) return { summary: "No recipes in queue", suggestions: [], minutes: 0 };
    try {
      const agent = await safeImportMany(["@/agents/cookingAgent.js", "@/agents/cookingAgent"]);
      const res = await agent?.estimatePlan?.({}, { recipes: list, batch: true });
      if (res?.summary) return res;
    } catch {}
    const minutes = 15 + list.length * 12;
    return { summary: `Approx ${minutes} minutes for ${list.length} recipe(s).`, suggestions: [], minutes };
  },

  createSession: async ({ userId = "localUser", title = "Batch Cooking", batch = true } = {}) => {
    const selected = get().getSelectedRecipes();
    const list = selected.length ? selected : get().queue;
    if (!list.length) return null;

    const settings = await loadSettings();
    const sabbath = settings.sabbathAvoid !== false && (await isSabbathNow());
    if (sabbath) {
      // Soft deferral — let UI decide what to do
      return { deferred: true, reason: "sabbath", message: "Sabbath is active. Consider deferring this session." };
    }

    set({ meta: { ...(get().meta), busy: true } });
    try {
      const cookingBus = await safeImportMany(["@/services/cookingBus.js", "@/services/cookingBus"]);
      const session = await cookingBus?.createSession?.({
        userId,
        title,
        batch,
        recipes: list,
        meta: { from: "BatchQueueStore", profile: get().meta.profileKey },
      });
      if (session?.id) {
        broadcast("SESSION.PLANNED.COOKING", { sessionId: session.id, count: list.length });
      }
      return session || null;
    } finally {
      set({ meta: { ...(get().meta), busy: false } });
    }
  },
}));

/* ---------------------------------------------
   Convenience selector hooks
---------------------------------------------- */
export const useBatchQueue = () =>
  useBatchQueueStore((s) => s.queue, shallow);

export const useBatchQueueMeta = () =>
  useBatchQueueStore((s) => s.meta, shallow);

export const useBatchQueueTotals = () =>
  useBatchQueueStore((s) => s.totals(), shallow);

export const useBatchQueueActions = () =>
  useBatchQueueStore(
    (s) => ({
      hydrate: s.hydrate,
      addToQueue: s.addToQueue,
      removeFromQueue: s.removeFromQueue,
      clearQueue: s.clearQueue,
      reorderQueue: s.reorderQueue,
      toggleSelection: s.toggleSelection,
      updateRecipeSteps: s.updateRecipeSteps,
      setRecipePortions: s.setRecipePortions,
      getSelectedRecipes: s.getSelectedRecipes,
      syncWithInventory: s.syncWithInventory,
      reserveInventory: s.reserveInventory,
      estimateSession: s.estimateSession,
      createSession: s.createSession,
    }),
    shallow
  );

// Auto-hydrate on first import (non-blocking)
useBatchQueueStore.getState().hydrate?.();
