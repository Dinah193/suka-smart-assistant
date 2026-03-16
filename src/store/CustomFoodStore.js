// File: src/store/CustomFoodStore.js
/**
 * CustomFoodStore
 * -----------------------------------------------------------------------------
 * SSA Custom Food Store (offline-first, Dexie-backed, React-friendly).
 *
 * Purpose
 *  - Let users create and manage "custom foods" that SSA can use across:
 *      • nutrition (macros/micros), recipes, meal planning
 *      • inventory/storehouse mappings
 *      • scanning / receipt reconciliation (as user-defined products)
 *
 * Goals
 *  - Browser-safe (no Node imports)
 *  - Offline-first: uses Dexie table if available, else falls back to localStorage
 *  - React-friendly: useSyncExternalStore compatible
 *  - Agent-ready: provides getSnapshot(), pick(), toQuery() helpers
 *  - Schema tolerant: resolves a best-fit table if your db schema differs
 *
 * Entity shape (recommended)
 *  - id: string
 *  - name: string
 *  - brand: string|null
 *  - aliases: string[]
 *  - category: string|null
 *  - cuisine: string|null
 *  - tags: string[]
 *  - serving: { amount:number, unit:string, grams:number|null }  // default serving
 *  - nutrition: {
 *      calories:number|null,
 *      macros: { protein_g, carbs_g, fat_g, fiber_g, sugar_g }  (nullable)
 *      micros: { sodium_mg, potassium_mg, ... } (nullable)
 *    }
 *  - density: { gPerMl:number|null, gPerCup:number|null } // optional
 *  - ingredientsText: string|null
 *  - allergens: string[]
 *  - upc: string|null
 *  - externalRefs: { usdaFdcId?: string, openfoodfactsId?: string, ... }
 *  - createdAt, updatedAt
 *  - version
 *  - archived:boolean
 *
 * Notes
 *  - Write services (commit/ingest) can call store methods or use selectors.
 *  - This module intentionally avoids importing other stores to prevent cycles.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  useCallback,
} from "react";
import db from "@/services/db";

/* -----------------------------------------------------------------------------
 * Optional eventBus
 * -------------------------------------------------------------------------- */

let eventBus = null;
try {
  eventBus = (await import("@/services/events/eventBus")).default ?? null;
} catch {
  eventBus = null;
}

const SOURCE = "store.CustomFoodStore";

/* -----------------------------------------------------------------------------
 * Storage backends
 * -------------------------------------------------------------------------- */

const TABLE_CANDIDATES = [
  "customFoods",
  "custom_foods",
  "foods_custom",
  "userFoods",
  "user_foods",
  "foods",
  "foodLibrary",
  "food_library",
];

function resolveTable(dexieDb) {
  if (!dexieDb) return null;

  for (const k of TABLE_CANDIDATES) {
    const t = dexieDb[k];
    if (t && typeof t.toCollection === "function") return t;
  }

  try {
    const tables = dexieDb.tables || [];
    const exact = tables.find((t) =>
      TABLE_CANDIDATES.some(
        (c) => String(t?.name || "").toLowerCase() === c.toLowerCase()
      )
    );
    if (exact) return exact;

    // fuzzy: any table containing "food" and "custom" or "user"
    const fuzzy = tables.find((t) => {
      const n = String(t?.name || "").toLowerCase();
      if (!n.includes("food")) return false;
      return n.includes("custom") || n.includes("user");
    });
    return fuzzy || null;
  } catch {
    return null;
  }
}

function nowMs() {
  return Date.now();
}

function genId(prefix = "food") {
  const rnd = Math.random().toString(16).slice(2);
  return `${prefix}_${nowMs().toString(16)}_${rnd}`;
}

function safeObject(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function normalizeText(s) {
  return String(s || "").trim();
}

function normalizeTextLower(s) {
  return normalizeText(s).toLowerCase();
}

function normalizeNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function deepMerge(base, patch) {
  const a = safeObject(base);
  const b = safeObject(patch);
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof out[k] === "object" &&
      out[k] &&
      !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function emit(name, payload) {
  try {
    eventBus?.emit?.(name, payload);
  } catch {
    // ignore
  }
}

/* -----------------------------------------------------------------------------
 * LocalStorage fallback
 * -------------------------------------------------------------------------- */

const LS_KEY = "ssa.customFoods.v1";

function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveToLocalStorage(list) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list || []));
  } catch {
    // ignore
  }
}

/* -----------------------------------------------------------------------------
 * Normalization (entity)
 * -------------------------------------------------------------------------- */

function normalizeServing(serving) {
  const s = safeObject(serving);
  const amount = normalizeNum(s.amount) ?? 1;
  const unit = normalizeText(s.unit) || "serving";
  const grams = normalizeNum(s.grams);
  return { amount, unit, grams };
}

function normalizeMacros(macros) {
  const m = safeObject(macros);
  return {
    protein_g: normalizeNum(m.protein_g ?? m.protein ?? m.proteinG),
    carbs_g: normalizeNum(m.carbs_g ?? m.carbs ?? m.carbsG),
    fat_g: normalizeNum(m.fat_g ?? m.fat ?? m.fatG),
    fiber_g: normalizeNum(m.fiber_g ?? m.fiber ?? m.fiberG),
    sugar_g: normalizeNum(m.sugar_g ?? m.sugar ?? m.sugarG),
  };
}

function normalizeMicros(micros) {
  const m = safeObject(micros);
  // Keep flexible — don’t enumerate everything; copy numeric keys through.
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    const n = normalizeNum(v);
    out[k] = n;
  }
  return out;
}

function normalizeNutrition(nutrition) {
  const n = safeObject(nutrition);
  return {
    calories: normalizeNum(n.calories ?? n.kcal),
    macros: normalizeMacros(n.macros),
    micros: normalizeMicros(n.micros),
  };
}

function normalizeFood(input) {
  const f = safeObject(input);

  const id = f.id ?? f._id ?? f.uuid ?? f.key ?? genId("food");
  const createdAt = f.createdAt ?? f.created_at ?? nowMs();
  const updatedAt = f.updatedAt ?? f.updated_at ?? createdAt;

  const name = normalizeText(f.name ?? f.title);
  const brand = normalizeText(f.brand) || null;

  const aliases = safeArray(f.aliases).map(normalizeText).filter(Boolean);

  const tags = safeArray(f.tags).map(normalizeText).filter(Boolean);

  const allergens = safeArray(f.allergens).map(normalizeText).filter(Boolean);

  const serving = normalizeServing(f.serving);

  const food = {
    id,
    name,
    brand,
    aliases,
    category: normalizeText(f.category) || null,
    cuisine: normalizeText(f.cuisine) || null,
    tags,
    serving,
    nutrition: normalizeNutrition(f.nutrition),
    density: {
      gPerMl: normalizeNum(f.density?.gPerMl ?? f.density?.g_per_ml),
      gPerCup: normalizeNum(f.density?.gPerCup ?? f.density?.g_per_cup),
    },
    ingredientsText: normalizeText(f.ingredientsText ?? f.ingredients) || null,
    allergens,
    upc: normalizeText(f.upc) || null,
    externalRefs: safeObject(f.externalRefs),
    archived: !!(f.archived ?? f.isArchived ?? f.deleted ?? f.isDeleted),
    createdAt,
    updatedAt,
    version: Number.isFinite(Number(f.version)) ? Number(f.version) : 1,
  };

  return food;
}

/* -----------------------------------------------------------------------------
 * Store core (subscribe/getSnapshot)
 * -------------------------------------------------------------------------- */

const state = {
  hydrated: false,
  loading: false,
  error: null,

  // authoritative list (in-memory cache)
  foods: [],
  // for fast lookup
  byId: new Map(),

  // persistence meta
  backend: "unknown", // dexie | localStorage
  lastUpdated: null,
  dirty: false,

  // internal subs
  subs: new Set(),
};

function notify() {
  for (const fn of state.subs) {
    try {
      fn();
    } catch {
      // ignore
    }
  }
}

function setState(patch) {
  Object.assign(state, patch);
  notify();
}

function rebuildIndex(list) {
  state.byId = new Map();
  for (const f of list || []) {
    if (f?.id != null) state.byId.set(f.id, f);
  }
}

async function loadAllFromDexie() {
  const t = resolveTable(db);
  if (!t) return null;

  const rows = await t.toArray();
  const normalized = rows.map(normalizeFood);
  return normalized;
}

async function saveOneToDexie(food) {
  const t = resolveTable(db);
  if (!t) return false;
  await t.put(food);
  return true;
}

async function deleteFromDexie(id) {
  const t = resolveTable(db);
  if (!t) return false;
  await t.delete(id);
  return true;
}

async function hydrateOnce() {
  if (state.hydrated || state.loading) return;

  setState({ loading: true, error: null });

  try {
    const dexieList = await loadAllFromDexie();
    if (dexieList) {
      rebuildIndex(dexieList);
      setState({
        foods: dexieList,
        hydrated: true,
        loading: false,
        backend: "dexie",
        lastUpdated: nowMs(),
        dirty: false,
      });
      emit("customFoods.hydrated", {
        backend: "dexie",
        count: dexieList.length,
      });
      return;
    }

    // fallback: localStorage
    const ls = loadFromLocalStorage().map(normalizeFood);
    rebuildIndex(ls);
    setState({
      foods: ls,
      hydrated: true,
      loading: false,
      backend: "localStorage",
      lastUpdated: nowMs(),
      dirty: false,
    });
    emit("customFoods.hydrated", { backend: "localStorage", count: ls.length });
  } catch (e) {
    const msg = String(e?.message || e);
    setState({
      loading: false,
      error: msg,
      hydrated: true,
      backend: "localStorage",
    });
    emit("customFoods.error", { where: "hydrate", error: msg });

    // even on error, attempt localStorage as best-effort
    const ls = loadFromLocalStorage().map(normalizeFood);
    rebuildIndex(ls);
    setState({ foods: ls, lastUpdated: nowMs() });
  }
}

/* -----------------------------------------------------------------------------
 * Public store API (non-React)
 * -------------------------------------------------------------------------- */

const CustomFoodStore = {
  /* ----- lifecycle ----- */

  async hydrate() {
    await hydrateOnce();
    return this.getSnapshot();
  },

  isHydrated() {
    return !!state.hydrated;
  },

  isLoading() {
    return !!state.loading;
  },

  getError() {
    return state.error;
  },

  getBackend() {
    return state.backend;
  },

  /* ----- subscribe/getSnapshot ----- */

  subscribe(fn) {
    if (typeof fn !== "function") return () => {};
    state.subs.add(fn);
    return () => state.subs.delete(fn);
  },

  getSnapshot() {
    return {
      hydrated: state.hydrated,
      loading: state.loading,
      error: state.error,
      backend: state.backend,
      lastUpdated: state.lastUpdated,
      dirty: state.dirty,
      count: state.foods.length,
      foods: state.foods,
      byId: state.byId,
    };
  },

  /* ----- getters ----- */

  getAll() {
    return state.foods;
  },

  getById(id) {
    return id == null ? null : state.byId.get(id) || null;
  },

  /**
   * Simple search by name/brand/aliases/tags
   * @param {string} query
   * @param {object} [opts]
   * @param {boolean} [opts.includeArchived]
   * @param {string} [opts.category]
   * @param {string} [opts.cuisine]
   * @param {string[]} [opts.tags]
   */
  search(query, opts = {}) {
    const q = normalizeTextLower(query);
    const includeArchived = !!opts.includeArchived;
    const wantCategory = opts.category
      ? normalizeTextLower(opts.category)
      : null;
    const wantCuisine = opts.cuisine ? normalizeTextLower(opts.cuisine) : null;
    const wantTags = safeArray(opts.tags)
      .map(normalizeTextLower)
      .filter(Boolean);

    const list = state.foods.filter((f) => {
      if (!includeArchived && f.archived) return false;
      if (wantCategory && normalizeTextLower(f.category) !== wantCategory)
        return false;
      if (wantCuisine && normalizeTextLower(f.cuisine) !== wantCuisine)
        return false;
      if (wantTags.length) {
        const ft = safeArray(f.tags).map(normalizeTextLower);
        if (!wantTags.every((t) => ft.includes(t))) return false;
      }

      if (!q) return true;
      const blob = normalizeTextLower(
        [
          f.name,
          f.brand,
          ...(f.aliases || []),
          ...(f.tags || []),
          f.category,
          f.cuisine,
          f.upc,
        ]
          .filter(Boolean)
          .join(" ")
      );
      return blob.includes(q);
    });

    // rank: name startsWith > contains
    const ranked = list
      .map((f) => {
        const name = normalizeTextLower(f.name);
        const score = !q
          ? 0
          : name.startsWith(q)
          ? 100
          : name.includes(q)
          ? 60
          : normalizeTextLower(f.brand).includes(q)
          ? 40
          : 10;
        return { f, score };
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          normalizeTextLower(a.f.name).localeCompare(
            normalizeTextLower(b.f.name)
          )
      )
      .map((x) => x.f);

    return ranked;
  },

  /* ----- mutations ----- */

  /**
   * Upsert a custom food.
   * @param {object} food
   * @param {object} [opts]
   * @param {boolean} [opts.merge] - default true: deep merge with existing
   */
  async upsert(food, opts = {}) {
    await hydrateOnce();

    const merge = opts.merge !== false;
    const incoming = normalizeFood(food);

    const existing = state.byId.get(incoming.id) || null;

    const next =
      existing && merge
        ? normalizeFood({
            ...existing,
            ...incoming,
            meta: deepMerge(existing.meta, incoming.meta),
            nutrition: deepMerge(existing.nutrition, incoming.nutrition),
            serving: { ...existing.serving, ...incoming.serving },
            density: { ...existing.density, ...incoming.density },
            externalRefs: deepMerge(
              existing.externalRefs,
              incoming.externalRefs
            ),
            updatedAt: nowMs(),
            version: (Number(existing.version) || 1) + 1,
          })
        : normalizeFood({
            ...incoming,
            createdAt: existing?.createdAt ?? incoming.createdAt ?? nowMs(),
            updatedAt: nowMs(),
            version: existing ? (Number(existing.version) || 1) + 1 : 1,
          });

    // Persist
    let persisted = false;
    if (resolveTable(db)) {
      try {
        await saveOneToDexie(next);
        persisted = true;
      } catch (e) {
        // fall back to localStorage
        persisted = false;
        emit("customFoods.warn", {
          where: "dexie.put",
          error: String(e?.message || e),
        });
      }
    }

    // Update cache
    const nextList = existing
      ? state.foods.map((f) => (f.id === next.id ? next : f))
      : [next, ...state.foods];

    rebuildIndex(nextList);
    setState({
      foods: nextList,
      lastUpdated: nowMs(),
      dirty: !persisted && state.backend !== "dexie",
    });

    if (!persisted) {
      // localStorage fallback persistence
      saveToLocalStorage(nextList);
    }

    emit("customFoods.upserted", {
      id: next.id,
      name: next.name,
      persisted,
      backend: state.backend,
    });
    return next;
  },

  /**
   * Mark as archived (soft delete).
   */
  async archive(id) {
    await hydrateOnce();
    const cur = this.getById(id);
    if (!cur) return null;
    return await this.upsert({ ...cur, archived: true }, { merge: true });
  },

  async unarchive(id) {
    await hydrateOnce();
    const cur = this.getById(id);
    if (!cur) return null;
    return await this.upsert({ ...cur, archived: false }, { merge: true });
  },

  /**
   * Hard delete.
   */
  async remove(id) {
    await hydrateOnce();
    if (id == null) return false;

    let persisted = false;
    if (resolveTable(db)) {
      try {
        await deleteFromDexie(id);
        persisted = true;
      } catch (e) {
        persisted = false;
        emit("customFoods.warn", {
          where: "dexie.delete",
          error: String(e?.message || e),
        });
      }
    }

    const nextList = state.foods.filter((f) => f.id !== id);
    rebuildIndex(nextList);
    setState({
      foods: nextList,
      lastUpdated: nowMs(),
      dirty: !persisted && state.backend !== "dexie",
    });

    if (!persisted) saveToLocalStorage(nextList);

    emit("customFoods.removed", { id, persisted });
    return true;
  },

  /**
   * Bulk import (dedupe by normalized name+brand or id).
   * @param {object[]} foods
   * @param {object} [opts]
   * @param {boolean} [opts.overwrite] - overwrite duplicates; default false
   */
  async bulkImport(foods, opts = {}) {
    await hydrateOnce();
    const overwrite = !!opts.overwrite;

    const incoming = safeArray(foods).map(normalizeFood);

    // build lookup for dedupe
    const existingByKey = new Map();
    for (const f of state.foods) {
      const k = `${normalizeTextLower(f.name)}|${normalizeTextLower(f.brand)}`;
      existingByKey.set(k, f);
    }

    const toUpsert = [];
    for (const f of incoming) {
      if (!f.name) continue;
      const k = `${normalizeTextLower(f.name)}|${normalizeTextLower(f.brand)}`;
      const hit = existingByKey.get(k);
      if (!hit) {
        toUpsert.push(f);
        existingByKey.set(k, f);
        continue;
      }
      if (overwrite) {
        toUpsert.push({ ...hit, ...f, id: hit.id });
      }
    }

    // persist best-effort
    let persisted = false;
    if (resolveTable(db)) {
      try {
        const t = resolveTable(db);
        await t.bulkPut(toUpsert);
        persisted = true;
      } catch (e) {
        persisted = false;
        emit("customFoods.warn", {
          where: "dexie.bulkPut",
          error: String(e?.message || e),
        });
      }
    }

    // merge into cache
    const merged = (() => {
      const byId = new Map(state.foods.map((x) => [x.id, x]));
      for (const f of toUpsert)
        byId.set(
          f.id,
          normalizeFood({ ...byId.get(f.id), ...f, updatedAt: nowMs() })
        );
      return Array.from(byId.values());
    })();

    rebuildIndex(merged);
    setState({
      foods: merged,
      lastUpdated: nowMs(),
      dirty: !persisted && state.backend !== "dexie",
    });
    if (!persisted) saveToLocalStorage(merged);

    emit("customFoods.imported", { count: toUpsert.length, persisted });
    return { count: toUpsert.length, persisted };
  },

  /**
   * Export as JSON blob string (callers can download).
   */
  exportJSON(opts = {}) {
    const includeArchived = !!opts.includeArchived;
    const list = includeArchived
      ? state.foods
      : state.foods.filter((f) => !f.archived);
    return JSON.stringify(list, null, 2);
  },

  /**
   * Reset store data (danger).
   */
  async reset(opts = {}) {
    await hydrateOnce();
    const hard = !!opts.hardDelete;

    if (hard && resolveTable(db)) {
      try {
        const t = resolveTable(db);
        await t.clear();
      } catch (e) {
        emit("customFoods.warn", {
          where: "dexie.clear",
          error: String(e?.message || e),
        });
      }
    }

    saveToLocalStorage([]);
    rebuildIndex([]);
    setState({ foods: [], lastUpdated: nowMs(), dirty: false, error: null });
    emit("customFoods.reset", { hard });
  },

  /* ----- agent helpers ----- */

  /**
   * pick() — return a minimal subset for agent/tool calls
   */
  pick(opts = {}) {
    const includeArchived = !!opts.includeArchived;
    const max = Number(opts.max ?? 50);
    const q = opts.query ? normalizeTextLower(opts.query) : "";

    const list = (
      includeArchived ? state.foods : state.foods.filter((f) => !f.archived)
    )
      .filter((f) =>
        q
          ? normalizeTextLower(
              `${f.name} ${f.brand} ${(f.aliases || []).join(" ")}`
            ).includes(q)
          : true
      )
      .slice(0, Math.max(1, max));

    return list.map((f) => ({
      id: f.id,
      name: f.name,
      brand: f.brand,
      category: f.category,
      cuisine: f.cuisine,
      tags: f.tags,
      serving: f.serving,
      calories: f.nutrition?.calories ?? null,
      macros: f.nutrition?.macros ?? {},
      upc: f.upc ?? null,
      archived: !!f.archived,
    }));
  },

  /**
   * toQuery() — create a query string suitable for intent routing
   */
  toQuery(opts = {}) {
    const p = this.pick(opts);
    return p
      .map((f) => `${f.name}${f.brand ? ` (${f.brand})` : ""}`)
      .join("; ");
  },
};

export default CustomFoodStore;

/* -----------------------------------------------------------------------------
 * React hook wrapper
 * -------------------------------------------------------------------------- */

/**
 * useCustomFoods
 *  - React-friendly access to CustomFoodStore
 *  - Automatically hydrates on mount
 */
export function useCustomFoods() {
  const sub = useCallback((fn) => CustomFoodStore.subscribe(fn), []);
  const getSnap = useCallback(() => CustomFoodStore.getSnapshot(), []);

  const snap = useSyncExternalStore(sub, getSnap, getSnap);

  useEffect(() => {
    if (!snap.hydrated && !snap.loading) {
      CustomFoodStore.hydrate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const actions = useMemo(
    () => ({
      hydrate: () => CustomFoodStore.hydrate(),
      upsert: (food, opts) => CustomFoodStore.upsert(food, opts),
      archive: (id) => CustomFoodStore.archive(id),
      unarchive: (id) => CustomFoodStore.unarchive(id),
      remove: (id) => CustomFoodStore.remove(id),
      bulkImport: (foods, opts) => CustomFoodStore.bulkImport(foods, opts),
      reset: (opts) => CustomFoodStore.reset(opts),

      search: (q, opts) => CustomFoodStore.search(q, opts),
      getById: (id) => CustomFoodStore.getById(id),
      pick: (opts) => CustomFoodStore.pick(opts),
      toQuery: (opts) => CustomFoodStore.toQuery(opts),

      exportJSON: (opts) => CustomFoodStore.exportJSON(opts),
    }),
    []
  );

  return { ...snap, actions };
}
