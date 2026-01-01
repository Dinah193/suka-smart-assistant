// src/services/shopping/ShoppingCandidatePipeline.js
// -----------------------------------------------------------------------------
// ShoppingCandidatePipeline
// -----------------------------------------------------------------------------
// Given (candidate | upc + store set), enriches progressively and emits:
//
// "shopping:candidate.enriched" with:
//   { candidateId, resolved: { item?, observations?, coupons?, recalls?, ingredientsCheck? } }
//
// It can emit multiple times per candidate as each section arrives.
// UI should deepMerge patches (your card already does).
//
// It also emits:
// - "shopping:candidate.enriching" { candidateId }
// - "shopping:candidate.failed" { candidateId, error }
// - "shopping:candidate.updated" { candidateId, patch, candidate } (optional)
//
// Persistence strategy:
// - Updates the candidate record (resolved.* streaming fields)
// - Optionally writes "price snapshots" / "coupon" / "recall" / "ingredient" to separate tables
//   IF those tables exist. Otherwise it only updates the candidate record.
// -----------------------------------------------------------------------------
//
// Provider strategy (pluggable):
// - productResolver.resolve(upc) -> item
// - pricingProvider.getLocalPrices({ upc, stores }) -> observations[]
// - couponProvider.getCoupons({ upc, stores }) -> coupons[]
// - recallProvider.getRecalls({ upc, item }) -> recalls[]
// - ingredientsProvider.getIngredients({ upc, item }) -> ingredientsCheck
//
// Defaults are safe "no data" providers so pipeline never crashes.
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

function now() {
  return Date.now();
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
function safeStr(x) {
  return String(x || "").trim();
}

function getEventBusFromGlobals() {
  if (typeof window === "undefined") return null;
  return window.__SUKA_EVENT_BUS__ || null;
}

function getDexieTable(db, name) {
  if (!db) return null;
  try {
    if (typeof db.table === "function") {
      const t = db.table(name);
      if (t) return t;
    }
  } catch {}
  try {
    if (db[name]) return db[name];
  } catch {}
  try {
    const tables = Array.isArray(db.tables) ? db.tables : [];
    const found = tables.find((t) => t?.name === name);
    if (found && typeof db.table === "function") return db.table(name);
  } catch {}
  return null;
}

async function lazyImportDb(path) {
  try {
    const mod = await import(/* @vite-ignore */ path);
    return mod?.db || mod?.default || mod || null;
  } catch {
    return null;
  }
}

/* ------------------------------ Default Providers ------------------------------ */

const DefaultProductResolver = {
  async resolve(upc) {
    const u = safeStr(upc);
    if (!u) return null;
    // Minimal identity until real provider is wired.
    return {
      title: "Scanned Item",
      brand: null,
      size: null,
      upc: u,
      sku: null,
      imageUrl: null,
      category: null,
      source: "fallback",
      at: now(),
    };
  },
};

const DefaultPricingProvider = {
  async getLocalPrices({ upc, stores }) {
    return []; // no data by default
  },
};

const DefaultCouponProvider = {
  async getCoupons({ upc, stores }) {
    return [];
  },
};

const DefaultRecallProvider = {
  async getRecalls({ upc, item }) {
    return [];
  },
};

const DefaultIngredientsProvider = {
  async getIngredients({ upc, item }) {
    // unknown by default, with neutral status
    return {
      ok: null,
      flags: [],
      allergens: [],
      additives: [],
      notes: "",
      source: "fallback",
      at: now(),
    };
  },
};

/* ------------------------------ Pipeline ------------------------------ */

export default class ShoppingCandidatePipeline {
  constructor(opts = {}) {
    const gBus = getEventBusFromGlobals();

    this.eventBus = opts.eventBus ||
      gBus || { emit: () => {}, on: () => {}, off: () => {} };
    this.db = opts.db || null;
    this.dbImportPath = opts.dbImportPath || "@/services/db";

    // candidate table name should match your ShoppingSessionService
    this.candidateTableName = opts.candidateTable || "shopping_candidates";

    // Optional extra tables (only used if they exist)
    this.priceTableName = opts.priceTable || "shopping_price_snapshots";
    this.couponTableName = opts.couponTable || "shopping_coupons";
    this.recallTableName = opts.recallTable || "shopping_recalls";
    this.ingredientsTableName = opts.ingredientsTable || "shopping_ingredients";

    this.productResolver = opts.productResolver || DefaultProductResolver;
    this.pricingProvider = opts.pricingProvider || DefaultPricingProvider;
    this.couponProvider = opts.couponProvider || DefaultCouponProvider;
    this.recallProvider = opts.recallProvider || DefaultRecallProvider;
    this.ingredientsProvider =
      opts.ingredientsProvider || DefaultIngredientsProvider;

    // Concurrency control
    this.maxConcurrent = Number.isFinite(opts.maxConcurrent)
      ? opts.maxConcurrent
      : 3;
    this._active = 0;
    this._queue = [];

    // Per-candidate abort controllers
    this._controllers = new Map();

    // Memo cache (avoid redundant hits during a single session)
    this._cache = new Map(); // key -> { at, value }
    this.cacheTtlMs = Number.isFinite(opts.cacheTtlMs)
      ? opts.cacheTtlMs
      : 5 * 60 * 1000;

    this._ready = false;
    this._tables = {
      candidates: null,
      price: null,
      coupons: null,
      recalls: null,
      ingredients: null,
    };
  }

  async init({ force = false } = {}) {
    if (this._ready && !force) return true;

    if (!this.db) this.db = await lazyImportDb(this.dbImportPath);

    this._tables.candidates = getDexieTable(this.db, this.candidateTableName);
    this._tables.price = getDexieTable(this.db, this.priceTableName);
    this._tables.coupons = getDexieTable(this.db, this.couponTableName);
    this._tables.recalls = getDexieTable(this.db, this.recallTableName);
    this._tables.ingredients = getDexieTable(
      this.db,
      this.ingredientsTableName
    );

    this._ready = true;
    return true;
  }

  /**
   * Enqueue enrichment for a candidate.
   * candidateOrId can be:
   * - full candidate object (preferred)
   * - { id, scan: { content }, stores, storeSetKey, ... }
   * - candidateId (string) IF Dexie table exists to load it
   */
  async enrichCandidate(candidateOrId, { priority = "normal" } = {}) {
    await this.init();

    const candidate = await this._resolveCandidate(candidateOrId);
    if (!candidate?.id) throw new Error("Candidate not found or missing id.");

    // Abort prior run for same candidate (if any)
    this.abort(candidate.id);

    const task = { candidate, priority };
    if (priority === "high") this._queue.unshift(task);
    else this._queue.push(task);

    this._drainQueue();
    return candidate.id;
  }

  abort(candidateId) {
    const id = safeStr(candidateId);
    const ctrl = this._controllers.get(id);
    if (ctrl) {
      try {
        ctrl.abort();
      } catch {}
    }
    this._controllers.delete(id);
  }

  /* ------------------------------ Internal queue runner ------------------------------ */

  async _drainQueue() {
    while (this._active < this.maxConcurrent && this._queue.length) {
      const task = this._queue.shift();
      this._active += 1;

      this._runTask(task)
        .catch(() => {})
        .finally(() => {
          this._active -= 1;
          // keep draining if more tasks
          if (this._queue.length) this._drainQueue();
        });
    }
  }

  async _runTask({ candidate }) {
    const candidateId = safeStr(candidate?.id);
    const upc = safeStr(
      candidate?.scan?.content || candidate?.resolved?.item?.upc || ""
    );
    const stores = Array.isArray(candidate?.stores) ? candidate.stores : [];
    const storeSetKey = safeStr(candidate?.storeSetKey || "");

    const ctrl = new AbortController();
    this._controllers.set(candidateId, ctrl);

    // mark candidate as enriching
    await this._patchCandidate(candidateId, { status: "enriching" });
    this.eventBus.emit?.("shopping:candidate.enriching", { candidateId });

    try {
      // STREAM STEP 1: Identity
      const item = await this._cached(`item:${upc}`, () =>
        this.productResolver.resolve(upc, { signal: ctrl.signal })
      );
      if (ctrl.signal.aborted) return;

      await this._emitResolvedPatch(candidateId, { item });
      await this._maybePutExtra("ingredients", candidateId, { item }); // optional linkage
      // small yield so UI feels responsive
      await sleep(0);

      // STREAM STEP 2: Prices (local snapshots)
      const observations = await this._cached(
        `prices:${upc}:${storeSetKey || stores.join("|")}`,
        () =>
          this.pricingProvider.getLocalPrices({
            upc,
            stores,
            item,
            storeSetKey,
            signal: ctrl.signal,
          })
      );
      if (ctrl.signal.aborted) return;

      const obsList = Array.isArray(observations) ? observations : [];
      await this._emitResolvedPatch(candidateId, { observations: obsList });
      await this._maybePutExtra("price", candidateId, {
        upc,
        stores,
        observations: obsList,
      });
      await sleep(0);

      // STREAM STEP 3: Coupons
      const coupons = await this._cached(
        `coupons:${upc}:${storeSetKey || stores.join("|")}`,
        () =>
          this.couponProvider.getCoupons({
            upc,
            stores,
            item,
            storeSetKey,
            signal: ctrl.signal,
          })
      );
      if (ctrl.signal.aborted) return;

      const couponList = Array.isArray(coupons) ? coupons : [];
      await this._emitResolvedPatch(candidateId, { coupons: couponList });
      await this._maybePutExtra("coupons", candidateId, {
        upc,
        stores,
        coupons: couponList,
      });
      await sleep(0);

      // STREAM STEP 4: Recalls
      const recalls = await this._cached(`recalls:${upc}`, () =>
        this.recallProvider.getRecalls({ upc, item, signal: ctrl.signal })
      );
      if (ctrl.signal.aborted) return;

      const recallList = Array.isArray(recalls) ? recalls : [];
      await this._emitResolvedPatch(candidateId, { recalls: recallList });
      await this._maybePutExtra("recalls", candidateId, {
        upc,
        recalls: recallList,
      });
      await sleep(0);

      // STREAM STEP 5: Ingredients check
      const ingredientsCheck = await this._cached(`ingredients:${upc}`, () =>
        this.ingredientsProvider.getIngredients({
          upc,
          item,
          signal: ctrl.signal,
        })
      );
      if (ctrl.signal.aborted) return;

      await this._emitResolvedPatch(candidateId, { ingredientsCheck });
      await this._maybePutExtra("ingredients", candidateId, {
        upc,
        ingredientsCheck,
      });
      await sleep(0);

      // done
      await this._patchCandidate(candidateId, { status: "enriched" });
      // final "enriched" emit (some listeners prefer one final event)
      this.eventBus.emit?.("shopping:candidate.enriched", {
        candidateId,
        resolved: {
          item,
          observations: obsList,
          coupons: couponList,
          recalls: recallList,
          ingredientsCheck,
        },
      });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      const msg = e?.message || String(e);
      await this._patchCandidate(candidateId, { status: "failed", error: msg });
      this.eventBus.emit?.("shopping:candidate.failed", {
        candidateId,
        error: msg,
      });
      if (import.meta?.env?.DEV)
        console.error("[ShoppingCandidatePipeline] failed", candidateId, msg);
    } finally {
      this._controllers.delete(candidateId);
    }
  }

  /* ------------------------------ Candidate persistence ------------------------------ */

  async _resolveCandidate(candidateOrId) {
    // already object
    if (candidateOrId && typeof candidateOrId === "object")
      return candidateOrId;

    const id = safeStr(candidateOrId);
    if (!id) return null;

    // load from Dexie if possible
    const t = this._tables.candidates;
    if (t?.get) {
      try {
        return await t.get(String(id));
      } catch {}
    }
    return null;
  }

  async _patchCandidate(candidateId, patch) {
    const id = safeStr(candidateId);
    if (!id) return null;

    const t = this._tables.candidates;
    if (t?.get && t?.put) {
      try {
        const existing = await t.get(String(id));
        if (!existing) return null;

        const next = deepMerge(existing, {
          ...(patch || {}),
          updatedAt: now(),
        });
        await t.put(next);

        // Optional: emit updated candidate payload (some UIs want full object)
        this.eventBus.emit?.("shopping:candidate.updated", {
          candidateId: id,
          patch,
          candidate: next,
        });
        return next;
      } catch {}
    }

    // If Dexie table doesn't exist, we can't patch storage here.
    // Still emit event so UI can reflect state changes.
    this.eventBus.emit?.("shopping:candidate.updated", {
      candidateId: id,
      patch,
      candidate: null,
    });
    return null;
  }

  async _emitResolvedPatch(candidateId, resolvedPatch) {
    const id = safeStr(candidateId);
    if (!id) return;

    // Persist resolvedPatch into candidate.resolved if possible
    const t = this._tables.candidates;
    if (t?.get && t?.put) {
      try {
        const existing = await t.get(String(id));
        if (existing) {
          const nextResolved = deepMerge(
            existing.resolved || {},
            resolvedPatch || {}
          );
          const next = deepMerge(existing, {
            resolved: nextResolved,
            updatedAt: now(),
          });
          await t.put(next);
        }
      } catch {
        // even if persistence fails, still emit
      }
    }

    // Emit streaming patch event (what your UI is listening for)
    this.eventBus.emit?.("shopping:candidate.enriched", {
      candidateId: id,
      resolved: resolvedPatch || {},
    });
  }

  async _maybePutExtra(kind, candidateId, payload) {
    // Only if the specific table exists.
    const id = safeStr(candidateId);
    if (!id) return;

    const at = now();

    if (kind === "price" && this._tables.price?.put) {
      try {
        await this._tables.price.put({
          id: `price:${id}:${at}`,
          candidateId: id,
          at,
          ...(payload || {}),
        });
      } catch {}
      return;
    }

    if (kind === "coupons" && this._tables.coupons?.put) {
      try {
        await this._tables.coupons.put({
          id: `coupon:${id}:${at}`,
          candidateId: id,
          at,
          ...(payload || {}),
        });
      } catch {}
      return;
    }

    if (kind === "recalls" && this._tables.recalls?.put) {
      try {
        await this._tables.recalls.put({
          id: `recall:${id}:${at}`,
          candidateId: id,
          at,
          ...(payload || {}),
        });
      } catch {}
      return;
    }

    if (kind === "ingredients" && this._tables.ingredients?.put) {
      try {
        await this._tables.ingredients.put({
          id: `ing:${id}:${at}`,
          candidateId: id,
          at,
          ...(payload || {}),
        });
      } catch {}
      return;
    }
  }

  /* ------------------------------ Memo cache ------------------------------ */

  async _cached(key, fn) {
    const k = safeStr(key);
    if (!k) return fn();

    const hit = this._cache.get(k);
    const t = now();
    if (hit && t - Number(hit.at || 0) < this.cacheTtlMs) {
      return hit.value;
    }

    const value = await fn();
    this._cache.set(k, { at: t, value });
    return value;
  }
}
