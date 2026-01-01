// C:\Users\larho\suka-smart-assistant\src\services\ingredients\IngredientsService.js
// -----------------------------------------------------------------------------
// IngredientsService
// - Retrieves ingredients "where available" (provider-adapter style)
// - Caches by UPC in Dexie
//
// Recommended Dexie tables:
//   ingredients_cache: "&upc, ts, source"
//   ingredients_checks: "++id, candidateId, upc, ts"
//
// Provider contract (inject into deps.provider):
//   async lookupByUpc({ upc, item }) -> { ingredientsText?, ingredientsList?, allergens?, additives?, source?, ts? }
//
// Emits:
//   ingredients:fetched
//   ingredients:cached
// -----------------------------------------------------------------------------

function now() {
  return Date.now();
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
function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

export function createIngredientsService(deps = {}) {
  const {
    db = null,
    eventBus = null,
    provider = null,
    logger = console,
  } = deps;
  const dexie = safeDb(db);
  const bus = safeBus(eventBus);

  const mem = {
    cache: new Map(), // upc -> record
  };

  return {
    getIngredientsByUpc,
    upsertIngredientsCache,
    clearIngredientsCache,
  };

  async function getIngredientsByUpc({
    upc,
    item = null,
    maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  } = {}) {
    const u = str(upc);
    if (!u) return null;

    // 1) Dexie cache
    const cached = await readCache(u);
    if (cached && !isExpired(cached, maxAgeMs)) {
      return cached;
    }

    // 2) Provider fetch
    if (!provider?.lookupByUpc) {
      // no provider wired yet
      return cached || null;
    }

    try {
      const fetched = await provider.lookupByUpc({ upc: u, item });
      const rec = materializeIngredientsRecord(u, fetched);
      await upsertIngredientsCache(rec);
      bus.emit("ingredients:fetched", {
        upc: u,
        source: rec.source,
        ts: now(),
      });
      return rec;
    } catch (e) {
      logger?.warn?.("[IngredientsService] provider.lookupByUpc failed", e);
      return cached || null;
    }
  }

  async function upsertIngredientsCache(rec) {
    const r = isObj(rec) ? rec : null;
    const u = str(r?.upc);
    if (!u) return false;

    if (dexie?.ingredients_cache) {
      try {
        await dexie.ingredients_cache.put(r);
        bus.emit("ingredients:cached", { upc: u, ts: now() });
        return true;
      } catch (e) {
        logger?.warn?.(
          "[IngredientsService] ingredients_cache.put failed, falling back",
          e
        );
      }
    }

    mem.cache.set(u, r);
    bus.emit("ingredients:cached", { upc: u, ts: now() });
    return true;
  }

  async function clearIngredientsCache() {
    if (dexie?.ingredients_cache) {
      try {
        const n = await dexie.ingredients_cache.count();
        await dexie.ingredients_cache.clear();
        return n;
      } catch (e) {
        logger?.warn?.("[IngredientsService] clearIngredientsCache", e);
      }
    }
    const n = mem.cache.size;
    mem.cache.clear();
    return n;
  }

  // -------------------- internals --------------------

  async function readCache(upc) {
    if (dexie?.ingredients_cache) {
      try {
        const rec = await dexie.ingredients_cache.get(upc);
        return rec || null;
      } catch (e) {
        logger?.warn?.("[IngredientsService] readCache", e);
      }
    }
    return mem.cache.get(upc) || null;
  }

  function isExpired(rec, maxAgeMs) {
    const ts = Number(rec?.ts || 0);
    if (!ts) return true;
    return now() - ts > Number(maxAgeMs || 0);
  }

  function materializeIngredientsRecord(upc, raw) {
    const o = isObj(raw) ? raw : {};
    const ingredientsText = str(
      o.ingredientsText || o.ingredients_text || o.ingredients || ""
    );
    const ingredientsList = Array.isArray(o.ingredientsList)
      ? o.ingredientsList
      : ingredientsText
      ? splitIngredients(ingredientsText)
      : [];

    return {
      upc,
      ingredientsText: ingredientsText || null,
      ingredientsList,
      allergens: Array.isArray(o.allergens) ? o.allergens : [],
      additives: Array.isArray(o.additives) ? o.additives : [],
      source: str(o.source || "unknown"),
      ts: Number(o.ts || now()),
    };
  }

  function splitIngredients(text) {
    // naive but useful; later upgrade with a real parser
    return String(text || "")
      .split(/[,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

let __ingredientsService;
export function getIngredientsService(deps) {
  if (!__ingredientsService)
    __ingredientsService = createIngredientsService(deps);
  return __ingredientsService;
}
