// C:\Users\larho\suka-smart-assistant\src\hooks\estimators\useEstimatorSnapshots.js

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * useEstimatorSnapshots
 * -----------------------------------------------------------------------------
 * Unified adapter-based snapshot collector for SSA estimators.
 *
 * Problem it solves:
 * - Food Security + Cost Delta estimators need "snapshots" of:
 *   inventory/storehouse, meal plan, price map, pantry targets, production, etc.
 * - Different SSA modules may store data in different places (Dexie, Zustand,
 *   localStorage, in-memory drafts).
 * - We want a single hook that:
 *     1) pulls these snapshots through adapters,
 *     2) normalizes them into stable shapes,
 *     3) provides a cheap "snapshotKey" hash for memoized estimator auto-run,
 *     4) can be used by multiple estimators and UI drawers without duplication.
 *
 * This hook is intentionally:
 * - Deterministic (no AI).
 * - Non-opinionated about storage (adapters provide data).
 * - Safe with partial data (returns empty normalized shapes).
 *
 * -----------------------------------------------------------------------------
 * Adapter contract (all optional):
 * {
 *   getInventory:   ({ context }) => value | Promise<value>
 *   getStorehouse:  ({ context }) => value | Promise<value>      // optional separate pantry
 *   getMealPlan:    ({ context }) => value | Promise<value>
 *   getPrices:      ({ context }) => value | Promise<value>
 *   getTargets:     ({ context }) => value | Promise<value>      // pantry targets / provisioning targets
 *   getProduction:  ({ context }) => value | Promise<value>      // garden/animals/preservation outputs
 *
 *   // optional key providers to avoid hashing large objects
 *   getInventoryKey:  ({ context }) => string
 *   getMealPlanKey:   ({ context }) => string
 *   getPricesKey:     ({ context }) => string
 *   getTargetsKey:    ({ context }) => string
 *   getProductionKey: ({ context }) => string
 *
 *   emit: (eventName, payload) => void
 * }
 *
 * -----------------------------------------------------------------------------
 * API:
 * const snap = useEstimatorSnapshots({ adapters, context, autoLoad, debounceMs });
 *
 * snap.status.loading/ready/error
 * snap.snapshots.inventory
 * snap.snapshots.mealPlan
 * snap.snapshots.prices
 * snap.snapshots.targets
 * snap.snapshots.production
 *
 * snap.snapshotKey     // stable short key to feed autoRun triggers
 * snap.reload()        // reload now
 * snap.refresh()       // alias
 *
 * -----------------------------------------------------------------------------
 * Notes:
 * - Normalization here is intentionally light. Estimators may still apply their
 *   own detailed normalization, but this provides stable "good enough" shapes
 *   and consistent keys.
 */

export function useEstimatorSnapshots(options = {}) {
  const {
    adapters = {},
    context = null,

    autoLoad = true,
    debounceMs = 150,

    // If true, merges storehouse into inventory snapshot for convenience
    mergeStorehouseIntoInventory = true,

    // Controls if reload happens when context changes
    watchContext = true,

    // Optional: additional external dependencies that should trigger auto reload
    deps = [],

    // Limits memory footprint by trimming arrays
    limits = DEFAULT_LIMITS,
  } = options;

  const [phase, setPhase] = useState("idle"); // idle|loading|ready|error
  const [error, setError] = useState(null);

  const [snapshots, setSnapshots] = useState(() => emptySnapshots());

  const reloadTimerRef = useRef(null);
  const lastLoadKeyRef = useRef("");

  const status = useMemo(
    () => ({
      loading: phase === "loading",
      ready: phase === "ready",
      error,
      phase,
      sources: {
        inventory: adapters?.getInventory ? "adapter" : "none",
        storehouse: adapters?.getStorehouse ? "adapter" : "none",
        mealPlan: adapters?.getMealPlan ? "adapter" : "none",
        prices: adapters?.getPrices ? "adapter" : "none",
        targets: adapters?.getTargets ? "adapter" : "none",
        production: adapters?.getProduction ? "adapter" : "none",
      },
    }),
    [phase, error, adapters],
  );

  const snapshotKey = useMemo(() => {
    // Prefer adapter-provided keys (cheap), else derive small hashes from normalized shapes.
    const invKey =
      safeKey(adapters?.getInventoryKey?.({ context })) ||
      hashLite(snapshots.inventory);
    const houseKey =
      safeKey(adapters?.getStorehouseKey?.({ context })) ||
      (snapshots.storehouse ? hashLite(snapshots.storehouse) : "no_storehouse");
    const planKey =
      safeKey(adapters?.getMealPlanKey?.({ context })) ||
      hashLite(snapshots.mealPlan);
    const priceKey =
      safeKey(adapters?.getPricesKey?.({ context })) ||
      hashLite(snapshots.prices);
    const targetKey =
      safeKey(adapters?.getTargetsKey?.({ context })) ||
      hashLite(snapshots.targets);
    const prodKey =
      safeKey(adapters?.getProductionKey?.({ context })) ||
      hashLite(snapshots.production);

    const ctxKey = safeKey(hashContext(context));

    return compactKey(
      [ctxKey, invKey, houseKey, planKey, priceKey, targetKey, prodKey].filter(
        Boolean,
      ),
    );
  }, [adapters, context, snapshots]);

  const loadNow = useCallback(
    async (meta = {}) => {
      setPhase("loading");
      setError(null);

      try {
        const startedAt = new Date().toISOString();

        const [
          rawInventory,
          rawStorehouse,
          rawMealPlan,
          rawPrices,
          rawTargets,
          rawProduction,
        ] = await Promise.all([
          resolveMaybeAsync(adapters?.getInventory?.({ context, meta })),
          resolveMaybeAsync(adapters?.getStorehouse?.({ context, meta })),
          resolveMaybeAsync(adapters?.getMealPlan?.({ context, meta })),
          resolveMaybeAsync(adapters?.getPrices?.({ context, meta })),
          resolveMaybeAsync(adapters?.getTargets?.({ context, meta })),
          resolveMaybeAsync(adapters?.getProduction?.({ context, meta })),
        ]);

        const inventory = normalizeInventorySnapshot(
          rawInventory,
          limits.inventoryItems,
        );
        const storehouse = normalizeStorehouseSnapshot(
          rawStorehouse,
          limits.storehouseItems,
        );
        const mealPlan = normalizeMealPlanSnapshot(
          rawMealPlan,
          limits.mealPlanItems,
        );
        const prices = normalizePriceMap(rawPrices, limits.priceEntries);
        const targets = normalizeTargets(rawTargets, limits.targets);
        const production = normalizeProduction(
          rawProduction,
          limits.productionCredits,
        );

        const mergedInventory = mergeStorehouseIntoInventory
          ? mergeInventoryAndStorehouse(inventory, storehouse)
          : inventory;

        const next = {
          inventory: mergedInventory,
          storehouse,
          mealPlan,
          prices,
          targets,
          production,
          meta: {
            loadedAt: new Date().toISOString(),
            startedAt,
            mergeStorehouseIntoInventory: Boolean(mergeStorehouseIntoInventory),
          },
        };

        setSnapshots(next);
        setPhase("ready");

        safeEmit(adapters?.emit, "estimators.snapshots.loaded", {
          meta,
          loadedAt: next.meta.loadedAt,
          counts: {
            inventory: next.inventory.items.length,
            storehouse: next.storehouse.items.length,
            mealPlan: next.mealPlan.items.length,
            prices: next.prices.entries.length,
            targets: next.targets.targets.length,
            production: next.production.credits.length,
          },
        });

        return next;
      } catch (e) {
        setError(e);
        setPhase("error");
        safeEmit(adapters?.emit, "estimators.snapshots.error", {
          error: String(e?.message || e),
        });
        return null;
      }
    },
    [adapters, context, limits, mergeStorehouseIntoInventory],
  );

  const reload = useCallback(
    (meta = {}) => {
      // Debounced reload
      if (reloadTimerRef.current) {
        window.clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
      reloadTimerRef.current = window.setTimeout(
        () => {
          reloadTimerRef.current = null;
          loadNow({ reason: "reload", ...meta });
        },
        Math.max(0, debounceMs),
      );
    },
    [debounceMs, loadNow],
  );

  const refresh = reload;

  // Auto-load on mount and optionally on context changes.
  useEffect(() => {
    if (!autoLoad) return;

    const ctxKey = hashContext(context);
    const invKey = safeKey(adapters?.getInventoryKey?.({ context })) || "inv";
    const planKey = safeKey(adapters?.getMealPlanKey?.({ context })) || "plan";
    const priceKey = safeKey(adapters?.getPricesKey?.({ context })) || "prices";
    const targetKey =
      safeKey(adapters?.getTargetsKey?.({ context })) || "targets";
    const prodKey =
      safeKey(adapters?.getProductionKey?.({ context })) || "prod";

    const depKey =
      Array.isArray(deps) && deps.length ? safeKey(hashLite(deps)) : "";

    const loadKey = JSON.stringify({
      ctxKey,
      invKey,
      planKey,
      priceKey,
      targetKey,
      prodKey,
      watchContext: Boolean(watchContext),
      depKey,
    });

    if (loadKey === lastLoadKeyRef.current) return;

    // If watchContext is false, ignore context changes (only run on first mount and deps)
    if (!watchContext && lastLoadKeyRef.current) {
      // We only update key when deps change
      // but easiest: just allow reload when deps change.
      // If context changed but watchContext false, we do nothing.
      const prev = safeParseJson(lastLoadKeyRef.current).value || {};
      const prevDepKey = prev.depKey;
      if (prevDepKey === depKey) return;
    }

    lastLoadKeyRef.current = loadKey;
    reload({ reason: "autoLoad" });

    return () => {
      if (reloadTimerRef.current) {
        window.clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    autoLoad,
    watchContext,
    debounceMs,
    // context fields should trigger a reload (when enabled)
    context?.mode,
    context?.plannerMode,
    context?.screen,
    context?.route,
    // deps array content
    ...deps,
  ]);

  return useMemo(
    () => ({
      status,
      snapshots,
      snapshotKey,
      loadNow,
      reload,
      refresh,
      adapters,
    }),
    [status, snapshots, snapshotKey, loadNow, reload, refresh, adapters],
  );
}

/* =============================================================================
   Defaults & empty shapes
============================================================================= */

const DEFAULT_LIMITS = {
  inventoryItems: 2500,
  storehouseItems: 2500,
  mealPlanItems: 500,
  priceEntries: 1500,
  targets: 1500,
  productionCredits: 1500,
};

function emptySnapshots() {
  return {
    inventory: { items: [] },
    storehouse: { items: [] },
    mealPlan: { items: [] },
    prices: { entries: [] },
    targets: { targets: [] },
    production: { credits: [] },
    meta: {
      loadedAt: null,
      startedAt: null,
      mergeStorehouseIntoInventory: true,
    },
  };
}

/* =============================================================================
   Normalizers
============================================================================= */

function normalizeInventorySnapshot(raw, limit) {
  const itemsRaw = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.items)
      ? raw.items
      : [];
  const items = itemsRaw
    .map(normalizeInventoryItem)
    .filter((x) => x && x.label)
    .slice(0, clampInt(limit, 0, 1e6));
  return { items };
}

function normalizeStorehouseSnapshot(raw, limit) {
  // Storehouse can be same shape as inventory.
  return normalizeInventorySnapshot(raw, limit);
}

function normalizeInventoryItem(x) {
  if (!x || typeof x !== "object") return null;

  const label = String(x.label || x.name || x.title || "").trim();
  const ingredientId = x.ingredientId || x.ingredient_id || x.id || null;
  const sku = x.sku || x.productId || x.product_id || null;

  const quantity = firstNumber(x.quantity, x.qty, x.count, x.amount?.value);
  const unit = String(x.unit || x.amount?.unit || x.uom || "unit").trim();

  const location = x.location || x.storage || x.bin || null;
  const category = x.category || x.group || null;

  return {
    label:
      label || (ingredientId ? String(ingredientId) : sku ? String(sku) : ""),
    ingredientId: ingredientId ? String(ingredientId) : null,
    sku: sku ? String(sku) : null,
    quantity: Number.isFinite(quantity) ? Number(quantity) : 0,
    unit,
    location: location ? String(location) : null,
    category: category ? String(category) : null,
    updatedAt: x.updatedAt ? String(x.updatedAt) : null,
  };
}

function normalizeMealPlanSnapshot(raw, limit) {
  const itemsRaw = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.items)
      ? raw.items
      : [];
  const items = itemsRaw
    .map((m) => {
      if (!m || typeof m !== "object") return null;
      return {
        id: String(
          m.id ||
            m.recipeId ||
            m.recipe_id ||
            m.title ||
            `meal_${Math.random().toString(36).slice(2, 8)}`,
        ),
        title: String(m.title || m.name || "Planned meal"),
        servingsNeeded: Number.isFinite(Number(m.servingsNeeded))
          ? Number(m.servingsNeeded)
          : null,
        when: m.when ? String(m.when) : null,
        day: m.day ? String(m.day) : null,
        tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
      };
    })
    .filter(Boolean)
    .slice(0, clampInt(limit, 0, 1e6));
  return { items };
}

function normalizePriceMap(raw, limit) {
  const entries = [];

  if (!raw) return { entries };

  if (Array.isArray(raw)) {
    for (const r of raw) {
      if (!r || typeof r !== "object") continue;
      const key = normalizeKey(r.key || r.id || r.label || "");
      const price = firstNumber(r.price, r.value, r.usd, r.amount);
      const unit = r.unit ? String(r.unit) : null;
      if (key && Number.isFinite(price))
        entries.push({ key, price: Number(price), unit });
    }
    return { entries: entries.slice(0, clampInt(limit, 0, 1e6)) };
  }

  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.entries)) {
      for (const r of raw.entries) {
        if (!r || typeof r !== "object") continue;
        const key = normalizeKey(r.key || r.id || r.label || "");
        const price = firstNumber(r.price, r.value, r.usd, r.amount);
        const unit = r.unit ? String(r.unit) : null;
        if (key && Number.isFinite(price))
          entries.push({ key, price: Number(price), unit });
      }
      return { entries: entries.slice(0, clampInt(limit, 0, 1e6)) };
    }

    // Object map: { key -> price }
    for (const [k, v] of Object.entries(raw)) {
      const key = normalizeKey(k);
      const price = firstNumber(v);
      if (key && Number.isFinite(price))
        entries.push({ key, price: Number(price), unit: null });
    }
  }

  return { entries: entries.slice(0, clampInt(limit, 0, 1e6)) };
}

function normalizeTargets(raw, limit) {
  // Supported:
  // - { targets: [{ key, qty, unit? }] }
  // - array of targets
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.targets)
      ? raw.targets
      : [];
  const targets = list
    .map((t) => {
      if (!t || typeof t !== "object") return null;
      const key = normalizeKey(t.key || t.id || t.label || "");
      const qty = firstNumber(t.qty, t.quantity, t.amount?.value);
      const unit = String(t.unit || t.amount?.unit || "unit(s)");
      const label = t.label ? String(t.label) : null;
      if (!key || !Number.isFinite(qty)) return null;
      return { key, qty: Number(qty), unit, label };
    })
    .filter(Boolean)
    .slice(0, clampInt(limit, 0, 1e6));
  return { targets };
}

function normalizeProduction(raw, limit) {
  // Supported:
  // - { credits: [{ key, qtyUnits, valueUsd? }] }
  // - array of credits
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.credits)
      ? raw.credits
      : [];
  const credits = list
    .map((c) => {
      if (!c || typeof c !== "object") return null;
      const key = normalizeKey(c.key || c.id || c.label || "");
      const qtyUnits = firstNumber(
        c.qtyUnits,
        c.qty,
        c.quantity,
        c.amount?.value,
      );
      const valueUsd = firstNumber(c.valueUsd, c.value, c.usd);
      if (!key || !Number.isFinite(qtyUnits)) return null;
      return {
        key,
        qtyUnits: Number(qtyUnits),
        valueUsd: Number.isFinite(valueUsd) ? Number(valueUsd) : null,
        note: c.note ? String(c.note) : null,
        source: c.source ? String(c.source) : null,
      };
    })
    .filter(Boolean)
    .slice(0, clampInt(limit, 0, 1e6));
  return { credits };
}

/* =============================================================================
   Merge helpers
============================================================================= */

function mergeInventoryAndStorehouse(inventory, storehouse) {
  const invItems = Array.isArray(inventory?.items) ? inventory.items : [];
  const storeItems = Array.isArray(storehouse?.items) ? storehouse.items : [];

  if (!storeItems.length) return inventory || { items: [] };

  // De-dup by ingredientId or sku or label
  const seen = new Map(); // key -> item
  for (const it of invItems) {
    seen.set(dedupeKey(it), { ...it });
  }

  for (const it of storeItems) {
    const k = dedupeKey(it);
    if (seen.has(k)) {
      const prev = seen.get(k);
      // sum quantities if same unit, else keep both by suffixing key
      if (String(prev.unit) === String(it.unit)) {
        seen.set(k, {
          ...prev,
          quantity: roundTo((prev.quantity || 0) + (it.quantity || 0), 4),
        });
      } else {
        seen.set(`${k}__${normalizeKey(it.unit)}`, { ...it });
      }
    } else {
      seen.set(k, { ...it });
    }
  }

  return { items: [...seen.values()] };
}

function dedupeKey(it) {
  const ingredientId = (it?.ingredientId || "").trim();
  if (ingredientId) return `iid:${normalizeKey(ingredientId)}`;
  const sku = (it?.sku || "").trim();
  if (sku) return `sku:${normalizeKey(sku)}`;
  return `lbl:${normalizeKey(it?.label || "")}`;
}

/* =============================================================================
   Key and hashing utilities
============================================================================= */

function hashContext(context) {
  if (!context || typeof context !== "object") return "";
  const allowed = ["mode", "plannerMode", "screen", "route", "origin"];
  const out = {};
  for (const k of allowed) {
    if (context[k] != null) out[k] = String(context[k]);
  }
  return JSON.stringify(out);
}

function hashLite(obj) {
  // Lightweight stable-ish hash; avoids big crypto.
  // NOTE: used only for “did it change?” keys, not security.
  try {
    const str =
      typeof obj === "string"
        ? obj
        : JSON.stringify(obj, replacerNoCycles(), 0);
    let h = 2166136261;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `h${(h >>> 0).toString(36)}`;
  } catch {
    return `h${Math.random().toString(36).slice(2, 8)}`;
  }
}

function compactKey(parts) {
  return parts
    .map((p) => String(p || "").trim())
    .filter(Boolean)
    .join("|")
    .slice(0, 220);
}

function safeKey(v) {
  if (v == null) return "";
  const s = String(v).trim();
  return s.length ? s : "";
}

function replacerNoCycles() {
  const seen = new WeakSet();
  return function (_k, v) {
    if (v && typeof v === "object") {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
    }
    return v;
  };
}

/* =============================================================================
   General utilities
============================================================================= */

function resolveMaybeAsync(v) {
  try {
    if (typeof v === "function") return resolveMaybeAsync(v());
    if (v && typeof v.then === "function") return v;
    return Promise.resolve(v);
  } catch (e) {
    return Promise.reject(e);
  }
}

function safeEmit(emit, name, payload) {
  try {
    if (typeof emit === "function") emit(name, payload);
  } catch {
    // ignore
  }
}

function normalizeKey(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w.-]/g, "")
    .slice(0, 140);
}

function firstNumber(...vals) {
  for (const v of vals) {
    const n =
      typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function clampInt(v, min, max) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function roundTo(n, places = 2) {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0;
  const p = Math.pow(10, places);
  return Math.round(x * p) / p;
}

function safeParseJson(text) {
  try {
    const value = JSON.parse(String(text || ""));
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e };
  }
}
