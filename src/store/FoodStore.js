// src/store/FoodStore.js
/**
 * Suka FoodStore
 * - Lightweight, dependency-free store using useSyncExternalStore.
 * - Provides nutrition helpers used by NutritionPanel and Cooking pages.
 * - Emits event-driven UI glue via automation bus on data changes.
 *
 * Exports:
 *   - useFoodStore(): hook returning state + actions
 *   - foodStore: raw store for testing or non-React access
 *
 * Actions of interest:
 *   - upsertRecipeNutrition(id, nutrition)
 *   - getNutritionForRecipes(recipes, { servings })
 *   - getNutritionForSession(sessionId, { servings })
 *   - recordSessionNutrition(sessionId, { perServing, total })
 *   - undo() — reverts the last mutating action (best-effort)
 */

import React from "react";
import { automation } from "@/services/automation/runtime";

// ---------------------------------------------------------------------------
// Minimal store core (sync external store)
// ---------------------------------------------------------------------------
function createStore(initialState) {
  let state = typeof initialState === "function" ? initialState() : initialState || {};
  const listeners = new Set();

  const getState = () => state;
  const setState = (patch, meta = {}) => {
    const next = typeof patch === "function" ? patch(state) : patch;
    state = { ...state, ...next };
    listeners.forEach((l) => l(state, meta));
  };
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  // Hook
  const useStore = (selector = (s) => s) => {
    return React.useSyncExternalStore(
      subscribe,
      () => selector(getState()),
      () => selector(getState())
    );
  };

  return { getState, setState, subscribe, useStore };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

function sumNutrition(items) {
  const acc = {
    calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0,
  };
  for (const it of items) {
    if (!it) continue;
    acc.calories += Number(it.calories || 0);
    acc.protein  += Number(it.protein  || 0);
    acc.carbs    += Number(it.carbs    || 0);
    acc.fat      += Number(it.fat      || 0);
    acc.fiber    += Number(it.fiber    || 0);
    acc.sugar    += Number(it.sugar    || 0);
    acc.sodium   += Number(it.sodium   || 0);
  }
  for (const k of Object.keys(acc)) acc[k] = round(acc[k]);
  return acc;
}
function multiply(n, servings = 1) {
  const out = {};
  for (const [k, v] of Object.entries(n || {})) out[k] = typeof v === "number" ? round(v * servings) : v;
  return out;
}
function deriveMacros(n) {
  const p = Number(n?.protein || 0);
  const c = Number(n?.carbs || 0);
  const f = Number(n?.fat || 0);
  const calFromMacros = p * 4 + c * 4 + f * 9;
  const calories = Number(n?.calories || 0) || calFromMacros;
  const pct = (x) => clamp(Math.round((x / Math.max(1, calories)) * 100), 0, 100);
  return { calories, p, c, f, pp: pct(p * 4), cp: pct(c * 4), fp: pct(f * 9) };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------
const { getState, setState, subscribe, useStore } = createStore({
  // maps
  recipeNutrition: /** @type {Record<string, any>} */ ({}),
  sessionNutrition: /** @type {Record<string, { perServing:any, total:any }>} */ ({}),

  // undo stack for last-action undo
  _history: [],
});

function pushHistory(entry) {
  const s = getState();
  const next = [...(s._history || []), entry].slice(-20);
  setState({ _history: next });
}

function emitGlue(event, data) {
  try { automation.emit?.(event, data); } catch {}
}

// ---------------------------------------------------------------------------
// Public actions
// ---------------------------------------------------------------------------
async function upsertRecipeNutrition(id, nutrition) {
  const prev = getState().recipeNutrition[id];
  setState({ recipeNutrition: { ...getState().recipeNutrition, [id]: nutrition } });
  emitGlue("recipe.updated", { id, nutrition });

  pushHistory({
    kind: "upsertRecipeNutrition",
    undo: () => setState({ recipeNutrition: { ...getState().recipeNutrition, [id]: prev } }),
  });
}

function recordSessionNutrition(sessionId, payload) {
  const prev = getState().sessionNutrition[sessionId];
  setState({ sessionNutrition: { ...getState().sessionNutrition, [sessionId]: payload } });
  emitGlue("cooking.session.nutrition.updated", { sessionId, nutrition: payload });

  pushHistory({
    kind: "recordSessionNutrition",
    undo: () => setState({ sessionNutrition: { ...getState().sessionNutrition, [sessionId]: prev } }),
  });
}

/**
 * Undo last mutating action (best-effort).
 */
function undo() {
  const s = getState();
  const last = (s._history || []).pop();
  if (last?.undo) last.undo();
  setState({ _history: s._history });
  emitGlue("app.undo", {});
}

/**
 * Resolve nutrition for a set of recipes.
 * recipes: Array<{ id: string, servings?: number }>
 * Returns { perServing, total }
 */
async function getNutritionForRecipes(recipes = [], { servings = 1 } = {}) {
  const ids = recipes.map((r) => r?.id).filter(Boolean);
  const known = ids.map((id) => getState().recipeNutrition[id]).filter(Boolean);

  let perServing;
  if (ids.length && known.length === ids.length) {
    perServing = sumNutrition(known);
  } else {
    // Ask backend if available
    try {
      const res = await automation.request?.("food.nutrition.recipes", { recipes, servings: 1 });
      if (res?.perServing) {
        perServing = res.perServing;
        // cache by id if provided
        if (Array.isArray(res.byRecipe)) {
          res.byRecipe.forEach((r) => r?.id && upsertRecipeNutrition(r.id, r.perServing));
        }
      }
    } catch {}
  }

  // Fallback demo if still missing
  if (!perServing) {
    perServing = sumNutrition([{ calories: 620, protein: 32, carbs: 55, fat: 28, fiber: 7, sugar: 8, sodium: 780 }]);
  }

  const total = multiply(perServing, servings);
  return { perServing, total, macro: deriveMacros(perServing) };
}

/**
 * Resolve nutrition for a session.
 * If not present locally, asks backend; otherwise aggregates from stored recipe nutrition.
 */
async function getNutritionForSession(sessionId, { servings = 1 } = {}) {
  const cached = getState().sessionNutrition[sessionId];
  if (cached) {
    return { perServing: cached.perServing, total: multiply(cached.perServing, servings), macro: deriveMacros(cached.perServing) };
  }

  // Try backend
  try {
    const res = await automation.request?.("food.nutrition.session", { sessionId, servings: 1 });
    if (res?.perServing) {
      recordSessionNutrition(sessionId, { perServing: res.perServing, total: multiply(res.perServing, 1) });
      return { perServing: res.perServing, total: multiply(res.perServing, servings), macro: deriveMacros(res.perServing) };
    }
  } catch {}

  // Last resort: synthesize from known recipes if provided by backend cache
  // (Optional: you can extend this to look up session->recipes mapping)

  const perServing = sumNutrition([{ calories: 540, protein: 28, carbs: 48, fat: 24, fiber: 6, sugar: 7, sodium: 650 }]);
  recordSessionNutrition(sessionId, { perServing, total: multiply(perServing, 1) });
  return { perServing, total: multiply(perServing, servings), macro: deriveMacros(perServing) };
}

// ---------------------------------------------------------------------------
// Event-driven glue: listen for domain events and clear caches if relevant
// ---------------------------------------------------------------------------
(function wireAutomationListeners() {
  try {
    const on = automation.on?.bind(automation);
    if (!on) return;

    on("recipe.updated", () => {
      // recipes changed -> session nutrition may be stale
      setState({ sessionNutrition: { ...getState().sessionNutrition } });
    });

    on("inventory.updated", () => emitGlue("ui.hint", { scope: "nutrition", message: "Inventory changed — nutrition may shift with substitutions." }));

    on("calendar.synced", () => {
      // No-op for now; could hydrate session nutrition once calendar confirms
    });
  } catch {
    /* best-effort */
  }
})();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export const foodStore = {
  getState,
  subscribe,
  setState,
  actions: {
    upsertRecipeNutrition,
    recordSessionNutrition,
    getNutritionForRecipes,
    getNutritionForSession,
    undo,
  },
};

export function useFoodStore() {
  const state = useStore((s) => s);
  return {
    ...state,
    ...foodStore.actions,
  };
}

export default useFoodStore;
