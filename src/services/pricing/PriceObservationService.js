// C:\Users\larho\suka-smart-assistant\src\services\pricing\PriceObservationService.js
// -----------------------------------------------------------------------------
// PriceObservationService
// - Persists price observations
// - Maintains "latest by storeKey+upc" index
//
// Expected Dexie tables (recommended):
//   price_observations: "++id, upc, storeKey, at, source, [upc+storeKey], [storeKey+at]"
//   price_latest: "&key, upc, storeKey, at"
//
// Safe fallback: in-memory (for dev / missing DB).
// Emits:
//   pricing:observation.saved
//   pricing:latest.updated
// -----------------------------------------------------------------------------

import { getPriceNormalizerSingleton } from "@/app/features/scan-compare-trust/services/pricing/PriceNormalizer";

function now() {
  return Date.now();
}

function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function str(x) {
  const s = String(x ?? "").trim();
  return s ? s : "";
}

function safeBus(bus) {
  return bus?.emit ? bus : { emit: () => {} };
}

function safeDb(db) {
  return db && typeof db.table === "function" ? db : null;
}

export function createPriceObservationService(deps = {}) {
  const {
    db = null, // Dexie instance
    eventBus = null,
    normalizer = null, // optional injected
    logger = console,
  } = deps;

  const bus = safeBus(eventBus);
  const dexie = safeDb(db);
  const pn = normalizer || getPriceNormalizerSingleton({ eventBus: bus });

  // in-memory fallback
  const mem = {
    observations: [],
    latest: new Map(), // key -> record
  };

  return {
    saveObservation,
    saveObservationsBulk,
    getLatestForStoreUpc,
    listLatestForStores,
    clearStoreLatest,
  };

  /**
   * Save a single observation.
   * observation can be raw; we normalize it and attach storeKey.
   */
  async function saveObservation(observation = {}, ctx = {}) {
    const item = ctx?.item || ctx?.resolved?.item || {};
    const upc = str(ctx?.upc || observation.upc || item.upc);
    if (!upc) return null;

    const normObs = pn.normalizeObservationForUnitPrice(observation, {
      ...ctx,
      upc,
      item,
      targetUnit: ctx?.targetUnit,
      store: ctx?.store,
    });

    const rec = materializeRecord(normObs, { upc });

    // persist base observation
    const saved = await putObservation(rec);

    // update latest index
    const latest = await upsertLatest(rec);

    bus.emit("pricing:observation.saved", {
      upc,
      storeKey: rec.storeKey,
      observation: rec,
      ts: now(),
    });
    bus.emit("pricing:latest.updated", {
      upc,
      storeKey: rec.storeKey,
      latest,
      ts: now(),
    });

    return { observation: rec, latest };
  }

  async function saveObservationsBulk(observations = [], ctx = {}) {
    const list = Array.isArray(observations) ? observations : [];
    const out = [];
    for (const o of list) {
      // sequential on purpose to keep latest index correct + simple
      // (you can batch later if needed)
      // eslint-disable-next-line no-await-in-loop
      const saved = await saveObservation(o, ctx);
      if (saved) out.push(saved);
    }
    return out;
  }

  async function getLatestForStoreUpc({ upc, storeKey }) {
    const u = str(upc);
    const sk = str(storeKey);
    if (!u || !sk) return null;

    if (dexie?.price_latest) {
      try {
        const key = latestKey(u, sk);
        return await dexie.price_latest.get(key);
      } catch (e) {
        logger?.warn?.("[PriceObservationService] getLatestForStoreUpc", e);
      }
    }

    return mem.latest.get(latestKey(u, sk)) || null;
  }

  async function listLatestForStores({ upc, storeKeys = [] }) {
    const u = str(upc);
    const keys = Array.isArray(storeKeys)
      ? storeKeys.map(str).filter(Boolean)
      : [];
    if (!u || !keys.length) return [];

    if (dexie?.price_latest) {
      try {
        const out = [];
        for (const sk of keys) {
          // eslint-disable-next-line no-await-in-loop
          const rec = await dexie.price_latest.get(latestKey(u, sk));
          if (rec) out.push(rec);
        }
        return out;
      } catch (e) {
        logger?.warn?.("[PriceObservationService] listLatestForStores", e);
      }
    }

    return keys.map((sk) => mem.latest.get(latestKey(u, sk))).filter(Boolean);
  }

  async function clearStoreLatest({ storeKey }) {
    const sk = str(storeKey);
    if (!sk) return 0;

    if (dexie?.price_latest) {
      try {
        const all = await dexie.price_latest.toArray();
        const toDel = all
          .filter((r) => str(r.storeKey) === sk)
          .map((r) => r.key);
        await dexie.price_latest.bulkDelete(toDel);
        return toDel.length;
      } catch (e) {
        logger?.warn?.("[PriceObservationService] clearStoreLatest", e);
      }
    }

    let n = 0;
    for (const k of mem.latest.keys()) {
      if (k.includes(`::${sk}`)) {
        mem.latest.delete(k);
        n++;
      }
    }
    return n;
  }

  // ------------------------ persistence helpers ------------------------

  async function putObservation(rec) {
    if (dexie?.price_observations) {
      try {
        const id = await dexie.price_observations.add(rec);
        return { ...rec, id };
      } catch (e) {
        logger?.warn?.(
          "[PriceObservationService] price_observations.add failed, falling back",
          e
        );
      }
    }

    const id = mem.observations.length + 1;
    const saved = { ...rec, id };
    mem.observations.push(saved);
    return saved;
  }

  async function upsertLatest(rec) {
    const key = latestKey(rec.upc, rec.storeKey);
    const next = { ...rec, key };

    if (dexie?.price_latest) {
      try {
        // If exists and is newer, replace. Else, set.
        const existing = await dexie.price_latest.get(key);
        if (!existing || (existing?.at ?? 0) <= (next?.at ?? 0)) {
          await dexie.price_latest.put(next);
          return next;
        }
        return existing;
      } catch (e) {
        logger?.warn?.(
          "[PriceObservationService] price_latest.put failed, falling back",
          e
        );
      }
    }

    const existing = mem.latest.get(key);
    if (!existing || (existing?.at ?? 0) <= (next?.at ?? 0))
      mem.latest.set(key, next);
    return mem.latest.get(key) || next;
  }

  function latestKey(upc, storeKey) {
    return `${str(upc)}::${str(storeKey)}`;
  }

  function materializeRecord(o, { upc }) {
    const storeKey = str(
      o.storeKey ||
        pn.buildStoreKey({
          store: o.store,
          placeId: o.placeId,
          locationId: o.locationId,
          storeId: o.storeId,
        })
    );
    const at = toNum(o.at) ?? now();

    return {
      // identity
      upc,
      storeKey,
      store: str(o.store),
      placeId: str(o.placeId) || null,
      locationId: str(o.locationId) || null,
      storeId: str(o.storeId) || null,

      // price
      price: toNum(o.price),
      currency: str(o.currency) || "USD",
      unitPrice: toNum(o.unitPrice),
      unit: str(o.unit) || null,

      // normalized unit price (optional)
      unitPriceNormalized: isObj(o.unitPriceNormalized)
        ? o.unitPriceNormalized
        : null,

      // observation metadata
      inStock: typeof o.inStock === "boolean" ? o.inStock : null,
      confidence: toNum(o.confidence),
      source: str(o.source) || null,
      at,
      ts: now(),
    };
  }
}

let __priceObservationService;
export function getPriceObservationService(deps) {
  if (!__priceObservationService)
    __priceObservationService = createPriceObservationService(deps);
  return __priceObservationService;
}
