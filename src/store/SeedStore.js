// File: src/store/SeedStore.js
/**
 * SeedStore (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Offline-first seed catalog + inventory for garden planning and storehouse
 *    stewardship in SSA.
 *
 * Supports
 *  - Seed lots (packs/jars/containers) with viability, purchase, storage, and
 *    germination test tracking.
 *  - Varietal catalog entries (crop + cultivar metadata).
 *  - Planting plans can reference Seed lots by id (seedLotId) and/or varietalId.
 *  - Optional Dexie persistence (db.seeds and db.seed_lots if present).
 *  - LocalStorage fallback (always available).
 *  - EventBus emissions for cross-domain orchestration.
 *  - React-friendly subscribe/getSnapshot for useSyncExternalStore.
 *
 * Notes
 *  - This store is schema-tolerant and will adapt to existing table names:
 *      • db.seeds or db.seed_catalog (varietals)
 *      • db.seed_lots or db.seeds_lots (lots)
 *      • db.germ_tests (optional)
 */

const STORE_NAME = "SeedStore";
const LS_KEY = "SSA.SeedStore.v1";
const VERSION = 1;

/* -------------------------------- Utilities -------------------------------- */

function nowISO() {
  return new Date().toISOString();
}

function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeParseJSON(str, fallback) {
  try {
    const v = JSON.parse(str);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function deepMerge(base, patch) {
  if (!isObject(base) || !isObject(patch)) return patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    const bv = base[k];
    if (isObject(bv) && isObject(pv)) out[k] = deepMerge(bv, pv);
    else out[k] = pv;
  }
  return out;
}

function stableUnique(arr) {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(arr) ? arr : []) {
    if (v == null) continue;
    const s = String(v);
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function toNumber(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function normalizeISO(maybeISO) {
  if (!maybeISO) return undefined;
  const d = new Date(maybeISO);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function createId(prefix = "seed") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/* --------------------------- Optional Dependencies --------------------------- */

let _dbPromise = null;
async function getDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = (async () => {
    try {
      const mod = await import(/* @vite-ignore */ "@/services/db");
      return mod?.db || mod?.default || null;
    } catch {
      return null;
    }
  })();
  return _dbPromise;
}

let _eventBusPromise = null;
async function getEventBus() {
  if (_eventBusPromise) return _eventBusPromise;
  _eventBusPromise = (async () => {
    try {
      const mod = await import(/* @vite-ignore */ "@/services/events/eventBus");
      return mod?.eventBus || mod?.default || null;
    } catch {
      return null;
    }
  })();
  return _eventBusPromise;
}

async function emit(type, payload) {
  try {
    const eb = await getEventBus();
    if (!eb) return;
    if (typeof eb.emit === "function") eb.emit(type, payload);
    else if (typeof eb.publish === "function") eb.publish(type, payload);
  } catch {
    // ignore
  }
}

function hasTable(db, name) {
  try {
    return !!db && !!db[name] && typeof db[name].toArray === "function";
  } catch {
    return false;
  }
}

async function dbPut(db, tableName, row) {
  try {
    if (!hasTable(db, tableName)) return false;
    const t = db[tableName];
    if (typeof t.put === "function") {
      await t.put(row);
      return true;
    }
    if (typeof t.add === "function") {
      await t.add(row);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function dbBulkPut(db, tableName, rows) {
  try {
    if (!hasTable(db, tableName)) return false;
    const t = db[tableName];
    if (typeof t.bulkPut === "function") {
      await t.bulkPut(rows);
      return true;
    }
    for (const r of rows) await dbPut(db, tableName, r);
    return true;
  } catch {
    return false;
  }
}

async function dbDelete(db, tableName, id) {
  try {
    if (!hasTable(db, tableName)) return false;
    const t = db[tableName];
    if (typeof t.delete === "function") {
      await t.delete(id);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function dbToArray(db, tableName) {
  try {
    if (!hasTable(db, tableName)) return [];
    return (await db[tableName].toArray()) || [];
  } catch {
    return [];
  }
}

/* ------------------------------ LocalStorage -------------------------------- */

function loadLS() {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage?.getItem?.(LS_KEY);
  if (!raw) return null;
  const parsed = safeParseJSON(raw, null);
  if (!parsed || !isObject(parsed)) return null;

  return {
    ...parsed,
    varietalsById: isObject(parsed.varietalsById) ? parsed.varietalsById : {},
    seedLotsById: isObject(parsed.seedLotsById) ? parsed.seedLotsById : {},
    testsById: isObject(parsed.testsById) ? parsed.testsById : {},
    orderVarietals: Array.isArray(parsed.orderVarietals)
      ? parsed.orderVarietals
      : [],
    orderSeedLots: Array.isArray(parsed.orderSeedLots)
      ? parsed.orderSeedLots
      : [],
    orderTests: Array.isArray(parsed.orderTests) ? parsed.orderTests : [],
  };
}

function saveLS(state) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem?.(LS_KEY, JSON.stringify(state));
  } catch {
    // ignore quota
  }
}

/* ------------------------------ Data Models --------------------------------- */

/**
 * Varietal (seed catalog entry)
 * {
 *  id,
 *  crop: "Tomato",
 *  cultivar: "Cherokee Purple",
 *  species?: "Solanum lycopersicum",
 *  family?: "Solanaceae",
 *  type?: "vegetable"|"herb"|"grain"|"fruit"|"flower",
 *  daysToMaturity?: number,
 *  sowMethod?: "direct"|"transplant"|"either",
 *  sun?: "full"|"partial"|"shade",
 *  spacingIn?: number,
 *  rowSpacingIn?: number,
 *  depthIn?: number,
 *  germDaysMin?: number,
 *  germDaysMax?: number,
 *  notes?: string,
 *  tags?: string[],
 *  createdAt,
 *  updatedAt
 * }
 */
function normalizeVarietal(input) {
  const v = isObject(input) ? { ...input } : {};
  const id = String(v.id || createId("var"));

  const crop = v.crop != null ? String(v.crop).trim() : "";
  const cultivar = v.cultivar != null ? String(v.cultivar).trim() : "";

  const createdAt = normalizeISO(v.createdAt) || nowISO();
  const updatedAt = nowISO();

  const tags = stableUnique(v.tags).map((t) => String(t));

  return {
    id,
    crop,
    cultivar,
    species: v.species != null ? String(v.species) : undefined,
    family: v.family != null ? String(v.family) : undefined,
    type: v.type != null ? String(v.type) : undefined,
    daysToMaturity: toNumber(v.daysToMaturity) ?? undefined,
    sowMethod: v.sowMethod != null ? String(v.sowMethod) : undefined,
    sun: v.sun != null ? String(v.sun) : undefined,
    spacingIn: toNumber(v.spacingIn) ?? undefined,
    rowSpacingIn: toNumber(v.rowSpacingIn) ?? undefined,
    depthIn: toNumber(v.depthIn) ?? undefined,
    germDaysMin: toNumber(v.germDaysMin) ?? undefined,
    germDaysMax: toNumber(v.germDaysMax) ?? undefined,
    notes: v.notes != null ? String(v.notes) : undefined,
    tags: tags.length ? tags : undefined,
    createdAt,
    updatedAt,
    meta: isObject(v.meta) ? { ...v.meta } : undefined,
  };
}

/**
 * SeedLot (inventory lot)
 * {
 *  id,
 *  varietalId?,
 *  crop?,
 *  cultivar?,
 *  source?: "store"|"saved"|"seed_swap"|"homegrown",
 *  vendor?: string,
 *  purchasedAt?: ISO,
 *  packedAt?: ISO,
 *  expiresAt?: ISO,
 *  storage?: { locationId?, locationName?, tempF?, humidityPct?, method? },
 *  qty: number,              // counts (seeds) or grams (if unit="g")
 *  unit: "ct"|"g",
 *  lotCode?: string,
 *  viability?: { model: "simple"|"testBased"|"vendor", pct?: number, lastTestId?: string },
 *  notes?: string,
 *  status?: "active"|"depleted"|"lost"|"discarded",
 *  createdAt,
 *  updatedAt
 * }
 */
function normalizeSeedLot(input, defaults = {}) {
  const x = isObject(input) ? { ...input } : {};
  const id = String(x.id || createId("lot"));

  const createdAt = normalizeISO(x.createdAt) || nowISO();
  const updatedAt = nowISO();

  const qty = Math.max(0, toNumber(x.qty) ?? 0);
  const unit = String(x.unit || defaults.unit || "ct") === "g" ? "g" : "ct";

  const storage = isObject(x.storage) ? { ...x.storage } : undefined;
  if (storage) {
    if (storage.locationId != null)
      storage.locationId = String(storage.locationId);
    if (storage.locationName != null)
      storage.locationName = String(storage.locationName);
    storage.tempF = toNumber(storage.tempF) ?? undefined;
    storage.humidityPct = clamp(toNumber(storage.humidityPct) ?? 0, 0, 100);
    if (storage.method != null) storage.method = String(storage.method);
  }

  const viability = isObject(x.viability) ? { ...x.viability } : undefined;
  if (viability) {
    const model = String(viability.model || "simple");
    viability.model = ["simple", "testBased", "vendor"].includes(model)
      ? model
      : "simple";
    viability.pct =
      viability.pct != null
        ? clamp(toNumber(viability.pct) ?? 0, 0, 100)
        : undefined;
    if (viability.lastTestId != null)
      viability.lastTestId = String(viability.lastTestId);
  }

  const status = String(x.status || "active");
  const allowedStatus = ["active", "depleted", "lost", "discarded"];
  const statusNorm = allowedStatus.includes(status) ? status : "active";

  return {
    id,
    varietalId: x.varietalId != null ? String(x.varietalId) : undefined,
    crop: x.crop != null ? String(x.crop) : undefined,
    cultivar: x.cultivar != null ? String(x.cultivar) : undefined,
    source: x.source != null ? String(x.source) : undefined,
    vendor: x.vendor != null ? String(x.vendor) : undefined,
    purchasedAt: normalizeISO(x.purchasedAt),
    packedAt: normalizeISO(x.packedAt),
    expiresAt: normalizeISO(x.expiresAt),
    storage,
    qty,
    unit,
    lotCode: x.lotCode != null ? String(x.lotCode) : undefined,
    viability,
    notes: x.notes != null ? String(x.notes) : undefined,
    status: statusNorm,
    createdAt,
    updatedAt,
    meta: isObject(x.meta) ? { ...x.meta } : undefined,
  };
}

/**
 * GerminationTest
 * {
 *  id,
 *  seedLotId,
 *  testedAt: ISO,
 *  sampleSize: number,
 *  germinated: number,
 *  pct: number,
 *  method?: string,
 *  notes?: string,
 *  createdAt,
 *  updatedAt
 * }
 */
function normalizeTest(input) {
  const t = isObject(input) ? { ...input } : {};
  const id = String(t.id || createId("test"));
  const seedLotId = t.seedLotId != null ? String(t.seedLotId) : "";

  const sampleSize = Math.max(1, Math.trunc(toNumber(t.sampleSize) ?? 10));
  const germinated = Math.max(
    0,
    Math.min(sampleSize, Math.trunc(toNumber(t.germinated) ?? 0))
  );
  const pct = round2((germinated / sampleSize) * 100);

  const createdAt = normalizeISO(t.createdAt) || nowISO();
  const updatedAt = nowISO();

  return {
    id,
    seedLotId,
    testedAt: normalizeISO(t.testedAt) || nowISO(),
    sampleSize,
    germinated,
    pct,
    method: t.method != null ? String(t.method) : undefined,
    notes: t.notes != null ? String(t.notes) : undefined,
    createdAt,
    updatedAt,
    meta: isObject(t.meta) ? { ...t.meta } : undefined,
  };
}

/* ------------------------------ Viability Math ------------------------------ */

/**
 * Simple viability decay model:
 * - If you have a known viability pct, use it.
 * - Otherwise, if we have a test, use test pct.
 * - Otherwise, if we have packedAt/purchasedAt and "expected shelf life", decay.
 *
 * This is intentionally conservative and easy to reason about.
 */
function estimateViabilityForLot(
  lot,
  { testsById, expectedShelfLifeDays = 365 } = {}
) {
  if (!lot) return { pct: null, source: "none" };

  // explicit viability pct
  if (lot.viability?.pct != null) {
    return { pct: clamp(Number(lot.viability.pct), 0, 100), source: "manual" };
  }

  // last test
  const lastTestId = lot.viability?.lastTestId;
  if (lastTestId && testsById && testsById[lastTestId]?.pct != null) {
    return {
      pct: clamp(Number(testsById[lastTestId].pct), 0, 100),
      source: "test",
    };
  }

  // fallback: simple time-based decay from 100% at packedAt/purchasedAt
  const startISO = lot.packedAt || lot.purchasedAt;
  if (!startISO) return { pct: null, source: "none" };

  const start = new Date(startISO).getTime();
  const now = Date.now();
  if (!Number.isFinite(start)) return { pct: null, source: "none" };

  const ageDays = Math.max(0, (now - start) / (1000 * 60 * 60 * 24));
  const life = Math.max(30, Number(expectedShelfLifeDays) || 365);

  // linear decay to 20% at end of shelf life, never below 0
  const pct = clamp(100 - (ageDays / life) * 80, 0, 100);
  return { pct: round2(pct), source: "time" };
}

/* -------------------------------- Store Core -------------------------------- */

function createStore() {
  let state = {
    version: VERSION,
    hydrated: false,
    dirty: false,
    lastHydratedAt: null,
    lastPersistedAt: null,
    source: "local", // local|dexie|merged
    error: null,

    varietalsById: {},
    seedLotsById: {},
    testsById: {},

    orderVarietals: [],
    orderSeedLots: [],
    orderTests: [],

    prefs: {
      defaultSortVarietals: "cropAsc", // cropAsc|updatedDesc
      defaultSortLots: "updatedDesc", // updatedDesc|qtyDesc|viabilityDesc
      hideDepleted: true,
      expectedShelfLifeDays: 365,
    },
  };

  const listeners = new Set();
  let db = null;

  function emitLocal() {
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  }

  function setState(updater, meta) {
    const prev = state;
    const next =
      typeof updater === "function" ? updater(prev) : deepMerge(prev, updater);

    state = {
      ...next,
      varietalsById: next.varietalsById || {},
      seedLotsById: next.seedLotsById || {},
      testsById: next.testsById || {},
      orderVarietals: Array.isArray(next.orderVarietals)
        ? next.orderVarietals
        : [],
      orderSeedLots: Array.isArray(next.orderSeedLots)
        ? next.orderSeedLots
        : [],
      orderTests: Array.isArray(next.orderTests) ? next.orderTests : [],
      prefs: deepMerge(
        {
          defaultSortVarietals: "cropAsc",
          defaultSortLots: "updatedDesc",
          hideDepleted: true,
          expectedShelfLifeDays: 365,
        },
        next.prefs || {}
      ),
    };

    emit("seeds.changed", { source: STORE_NAME, at: nowISO(), meta }).catch(
      () => {}
    );
    emitLocal();
  }

  function getState() {
    return state;
  }

  function getSnapshot() {
    return state;
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /* ------------------------------ Persistence -------------------------------- */

  function persistLocal(snapshot) {
    saveLS({ ...snapshot, dirty: false, lastPersistedAt: nowISO() });
  }

  async function persistDexie(snapshot) {
    if (!db) return false;

    const varietalTable = hasTable(db, "seeds")
      ? "seeds"
      : hasTable(db, "seed_catalog")
      ? "seed_catalog"
      : null;

    const lotTable = hasTable(db, "seed_lots")
      ? "seed_lots"
      : hasTable(db, "seeds_lots")
      ? "seeds_lots"
      : null;

    const testTable = hasTable(db, "germ_tests") ? "germ_tests" : null;

    try {
      if (varietalTable) {
        const rows = Object.values(snapshot.varietalsById || {});
        await dbBulkPut(db, varietalTable, rows);
      }
      if (lotTable) {
        const rows = Object.values(snapshot.seedLotsById || {});
        await dbBulkPut(db, lotTable, rows);
      }
      if (testTable) {
        const rows = Object.values(snapshot.testsById || {});
        await dbBulkPut(db, testTable, rows);
      }
      return true;
    } catch {
      return false;
    }
  }

  async function hydrateFromDexie() {
    if (!db) return null;

    const varietalTable = hasTable(db, "seeds")
      ? "seeds"
      : hasTable(db, "seed_catalog")
      ? "seed_catalog"
      : null;

    const lotTable = hasTable(db, "seed_lots")
      ? "seed_lots"
      : hasTable(db, "seeds_lots")
      ? "seeds_lots"
      : null;

    const testTable = hasTable(db, "germ_tests") ? "germ_tests" : null;

    const varietals = varietalTable ? await dbToArray(db, varietalTable) : [];
    const lots = lotTable ? await dbToArray(db, lotTable) : [];
    const tests = testTable ? await dbToArray(db, testTable) : [];

    const varietalsById = {};
    const seedLotsById = {};
    const testsById = {};

    for (const v of varietals) {
      if (!v || !v.id) continue;
      varietalsById[String(v.id)] = normalizeVarietal(v);
    }
    for (const l of lots) {
      if (!l || !l.id) continue;
      seedLotsById[String(l.id)] = normalizeSeedLot(l);
    }
    for (const t of tests) {
      if (!t || !t.id) continue;
      testsById[String(t.id)] = normalizeTest(t);
    }

    return {
      varietalsById,
      seedLotsById,
      testsById,
      orderVarietals: Object.keys(varietalsById),
      orderSeedLots: Object.keys(seedLotsById),
      orderTests: Object.keys(testsById),
    };
  }

  function hydrateFromLocal() {
    const ls = loadLS();
    if (!ls) return null;

    return {
      ...ls,
      varietalsById: ls.varietalsById || {},
      seedLotsById: ls.seedLotsById || {},
      testsById: ls.testsById || {},
      orderVarietals: Array.isArray(ls.orderVarietals) ? ls.orderVarietals : [],
      orderSeedLots: Array.isArray(ls.orderSeedLots) ? ls.orderSeedLots : [],
      orderTests: Array.isArray(ls.orderTests) ? ls.orderTests : [],
    };
  }

  function mergeMaps(a, b, pickUpdated = true) {
    const out = { ...(a || {}) };
    for (const id of Object.keys(b || {})) {
      const av = out[id];
      const bv = b[id];
      if (!av) out[id] = bv;
      else if (!pickUpdated) out[id] = bv;
      else {
        const aT = av.updatedAt ? new Date(av.updatedAt).getTime() : 0;
        const bT = bv.updatedAt ? new Date(bv.updatedAt).getTime() : 0;
        out[id] = bT >= aT ? bv : av;
      }
    }
    return out;
  }

  function sortVarietals(ids, map, sortKey) {
    const key = sortKey || state.prefs.defaultSortVarietals;
    const list = [...ids];

    if (key === "updatedDesc") {
      list.sort((a, b) => {
        const ta = new Date(map[a]?.updatedAt || 0).getTime();
        const tb = new Date(map[b]?.updatedAt || 0).getTime();
        return tb - ta;
      });
      return list;
    }

    // cropAsc (default)
    list.sort((a, b) => {
      const A = `${map[a]?.crop || ""} ${map[a]?.cultivar || ""}`.toLowerCase();
      const B = `${map[b]?.crop || ""} ${map[b]?.cultivar || ""}`.toLowerCase();
      return A.localeCompare(B);
    });
    return list;
  }

  function sortLots(ids, lotsMap, testsMap, sortKey) {
    const key = sortKey || state.prefs.defaultSortLots;
    const list = [...ids];

    if (key === "qtyDesc") {
      list.sort((a, b) => (lotsMap[b]?.qty || 0) - (lotsMap[a]?.qty || 0));
      return list;
    }

    if (key === "viabilityDesc") {
      list.sort((a, b) => {
        const va = estimateViabilityForLot(lotsMap[a], {
          testsById: testsMap,
          expectedShelfLifeDays: state.prefs.expectedShelfLifeDays,
        }).pct;
        const vb = estimateViabilityForLot(lotsMap[b], {
          testsById: testsMap,
          expectedShelfLifeDays: state.prefs.expectedShelfLifeDays,
        }).pct;
        return (vb ?? -1) - (va ?? -1);
      });
      return list;
    }

    // updatedDesc (default)
    list.sort((a, b) => {
      const ta = new Date(lotsMap[a]?.updatedAt || 0).getTime();
      const tb = new Date(lotsMap[b]?.updatedAt || 0).getTime();
      return tb - ta;
    });
    return list;
  }

  async function init() {
    db = await getDB();

    const local = hydrateFromLocal();
    if (local) {
      setState(
        {
          ...state,
          ...local,
          hydrated: true,
          source: "local",
          lastHydratedAt: nowISO(),
          dirty: false,
          error: null,
        },
        { op: "hydrate.local" }
      );
    } else {
      setState(
        {
          hydrated: true,
          source: "local",
          lastHydratedAt: nowISO(),
          dirty: false,
        },
        { op: "hydrate.empty" }
      );
    }

    // Dexie merge if available
    if (db) {
      const dx = await hydrateFromDexie();
      if (dx) {
        setState(
          (prev) => {
            const varietalsById = mergeMaps(
              prev.varietalsById,
              dx.varietalsById,
              true
            );
            const seedLotsById = mergeMaps(
              prev.seedLotsById,
              dx.seedLotsById,
              true
            );
            const testsById = mergeMaps(prev.testsById, dx.testsById, true);

            const orderVarietals = sortVarietals(
              stableUnique([
                ...(prev.orderVarietals || []),
                ...Object.keys(dx.varietalsById || {}),
              ]),
              varietalsById
            );

            const orderSeedLots = sortLots(
              stableUnique([
                ...(prev.orderSeedLots || []),
                ...Object.keys(dx.seedLotsById || {}),
              ]),
              seedLotsById,
              testsById
            );

            const orderTests = stableUnique([
              ...(prev.orderTests || []),
              ...Object.keys(dx.testsById || {}),
            ]);

            return {
              ...prev,
              varietalsById,
              seedLotsById,
              testsById,
              orderVarietals,
              orderSeedLots,
              orderTests,
              source: local ? "merged" : "dexie",
              lastHydratedAt: nowISO(),
              dirty: false,
            };
          },
          { op: "hydrate.dexie.merge" }
        );

        persistLocal(getState());
      }
    }
  }

  function persistNow() {
    const snapshot = getState();
    persistLocal(snapshot);

    if (db) {
      persistDexie(snapshot).then((ok) => {
        if (ok) {
          setState(
            (prev) => ({ ...prev, dirty: false, lastPersistedAt: nowISO() }),
            { op: "persist.dexie" }
          );
        }
      });
    } else {
      setState(
        (prev) => ({ ...prev, dirty: false, lastPersistedAt: nowISO() }),
        { op: "persist.local" }
      );
    }
  }

  /* ---------------------------------- Prefs ---------------------------------- */

  function setPrefs(partialOrUpdater) {
    setState(
      (prev) => {
        const nextPrefs =
          typeof partialOrUpdater === "function"
            ? partialOrUpdater(prev.prefs)
            : deepMerge(prev.prefs, partialOrUpdater || {});
        return { ...prev, prefs: nextPrefs, dirty: true };
      },
      { op: "prefs.set" }
    );
  }

  /* -------------------------------- Varietals -------------------------------- */

  function upsertVarietal(input) {
    const v = normalizeVarietal(input);
    setState(
      (prev) => {
        const varietalsById = { ...prev.varietalsById, [v.id]: v };
        const orderVarietals = sortVarietals(
          stableUnique([v.id, ...(prev.orderVarietals || [])]),
          varietalsById,
          prev.prefs.defaultSortVarietals
        );
        return { ...prev, varietalsById, orderVarietals, dirty: true };
      },
      { op: "varietal.upsert", id: v.id }
    );

    emit("seeds.varietal.upserted", {
      source: STORE_NAME,
      at: nowISO(),
      id: v.id,
    }).catch(() => {});
    return v.id;
  }

  function deleteVarietal(id) {
    const key = String(id || "");
    if (!key || !state.varietalsById[key]) return false;

    // Do not auto-delete lots; just detach varietalId
    setState(
      (prev) => {
        const varietalsById = { ...prev.varietalsById };
        delete varietalsById[key];

        const seedLotsById = { ...prev.seedLotsById };
        for (const lotId of Object.keys(seedLotsById)) {
          if (seedLotsById[lotId]?.varietalId === key) {
            seedLotsById[lotId] = {
              ...seedLotsById[lotId],
              varietalId: undefined,
              updatedAt: nowISO(),
            };
          }
        }

        return {
          ...prev,
          varietalsById,
          seedLotsById,
          orderVarietals: prev.orderVarietals.filter((x) => x !== key),
          dirty: true,
        };
      },
      { op: "varietal.delete", id: key }
    );

    if (db) {
      const table = hasTable(db, "seeds")
        ? "seeds"
        : hasTable(db, "seed_catalog")
        ? "seed_catalog"
        : null;
      if (table) dbDelete(db, table, key).catch(() => {});
    }

    return true;
  }

  /* --------------------------------- Seed Lots -------------------------------- */

  function upsertSeedLot(input) {
    const lot = normalizeSeedLot(input);
    setState(
      (prev) => {
        const seedLotsById = { ...prev.seedLotsById, [lot.id]: lot };
        const orderSeedLots = sortLots(
          stableUnique([lot.id, ...(prev.orderSeedLots || [])]),
          seedLotsById,
          prev.testsById,
          prev.prefs.defaultSortLots
        );
        return { ...prev, seedLotsById, orderSeedLots, dirty: true };
      },
      { op: "lot.upsert", id: lot.id }
    );

    emit("seeds.lot.upserted", {
      source: STORE_NAME,
      at: nowISO(),
      id: lot.id,
    }).catch(() => {});
    return lot.id;
  }

  function adjustLotQty(lotId, delta, { floorAtZero = true } = {}) {
    const id = String(lotId || "");
    if (!id || !state.seedLotsById[id]) return false;
    const d = toNumber(delta) ?? 0;

    setState(
      (prev) => {
        const existing = prev.seedLotsById[id];
        const nextQty = floorAtZero
          ? Math.max(0, (existing.qty || 0) + d)
          : (existing.qty || 0) + d;

        const status =
          nextQty <= 0
            ? "depleted"
            : existing.status === "depleted"
            ? "active"
            : existing.status;

        const updated = {
          ...existing,
          qty: round2(nextQty),
          status,
          updatedAt: nowISO(),
        };
        const seedLotsById = { ...prev.seedLotsById, [id]: updated };
        const orderSeedLots = sortLots(
          prev.orderSeedLots.includes(id)
            ? prev.orderSeedLots
            : [id, ...prev.orderSeedLots],
          seedLotsById,
          prev.testsById,
          prev.prefs.defaultSortLots
        );
        return { ...prev, seedLotsById, orderSeedLots, dirty: true };
      },
      { op: "lot.adjustQty", id, delta: d }
    );

    return true;
  }

  function deleteSeedLot(id) {
    const key = String(id || "");
    if (!key || !state.seedLotsById[key]) return false;

    // Remove related tests
    const testsToRemove = [];
    for (const testId of state.orderTests) {
      if (state.testsById[testId]?.seedLotId === key)
        testsToRemove.push(testId);
    }

    setState(
      (prev) => {
        const seedLotsById = { ...prev.seedLotsById };
        delete seedLotsById[key];

        const testsById = { ...prev.testsById };
        for (const tId of testsToRemove) delete testsById[tId];

        return {
          ...prev,
          seedLotsById,
          testsById,
          orderSeedLots: prev.orderSeedLots.filter((x) => x !== key),
          orderTests: prev.orderTests.filter((x) => !testsToRemove.includes(x)),
          dirty: true,
        };
      },
      { op: "lot.delete", id: key, removedTests: testsToRemove.length }
    );

    if (db) {
      const table = hasTable(db, "seed_lots")
        ? "seed_lots"
        : hasTable(db, "seeds_lots")
        ? "seeds_lots"
        : null;
      if (table) dbDelete(db, table, key).catch(() => {});

      if (hasTable(db, "germ_tests")) {
        for (const tId of testsToRemove)
          dbDelete(db, "germ_tests", tId).catch(() => {});
      }
    }

    return true;
  }

  /* ----------------------------- Germination Tests ---------------------------- */

  function addGerminationTest(input) {
    const test = normalizeTest(input);
    if (!test.seedLotId) return { ok: false, error: "Missing seedLotId" };
    if (!state.seedLotsById[test.seedLotId])
      return { ok: false, error: "Unknown seedLotId" };

    setState(
      (prev) => {
        const testsById = { ...prev.testsById, [test.id]: test };
        const orderTests = stableUnique([test.id, ...(prev.orderTests || [])]);

        // Set lastTestId + pct on the lot (testBased)
        const lot = prev.seedLotsById[test.seedLotId];
        const nextLot = {
          ...lot,
          viability: {
            ...(lot.viability || {}),
            model: "testBased",
            lastTestId: test.id,
            pct: test.pct,
          },
          updatedAt: nowISO(),
        };

        const seedLotsById = { ...prev.seedLotsById, [lot.id]: nextLot };
        const orderSeedLots = sortLots(
          prev.orderSeedLots,
          seedLotsById,
          testsById,
          prev.prefs.defaultSortLots
        );

        return {
          ...prev,
          testsById,
          orderTests,
          seedLotsById,
          orderSeedLots,
          dirty: true,
        };
      },
      { op: "test.add", id: test.id, seedLotId: test.seedLotId }
    );

    emit("seeds.test.added", {
      source: STORE_NAME,
      at: nowISO(),
      id: test.id,
    }).catch(() => {});
    return { ok: true, id: test.id, pct: test.pct };
  }

  function deleteGerminationTest(testId) {
    const id = String(testId || "");
    if (!id || !state.testsById[id]) return false;
    const lotId = state.testsById[id].seedLotId;

    setState(
      (prev) => {
        const testsById = { ...prev.testsById };
        delete testsById[id];

        // If this was lastTestId, clear it (or find next most recent)
        const seedLotsById = { ...prev.seedLotsById };
        const lot = seedLotsById[lotId];

        if (lot?.viability?.lastTestId === id) {
          // find next most recent test for lot
          const remaining = Object.values(testsById).filter(
            (t) => t.seedLotId === lotId
          );
          remaining.sort(
            (a, b) =>
              new Date(b.testedAt || 0).getTime() -
              new Date(a.testedAt || 0).getTime()
          );
          const next = remaining[0] || null;

          seedLotsById[lotId] = {
            ...lot,
            viability: next
              ? {
                  ...(lot.viability || {}),
                  model: "testBased",
                  lastTestId: next.id,
                  pct: next.pct,
                }
              : {
                  ...(lot.viability || {}),
                  lastTestId: undefined,
                  pct: undefined,
                },
            updatedAt: nowISO(),
          };
        }

        return {
          ...prev,
          testsById,
          seedLotsById,
          orderTests: prev.orderTests.filter((x) => x !== id),
          dirty: true,
        };
      },
      { op: "test.delete", id }
    );

    if (db && hasTable(db, "germ_tests"))
      dbDelete(db, "germ_tests", id).catch(() => {});
    return true;
  }

  /* ---------------------------------- Selectors ---------------------------------- */

  function listVarietals({ search, tag, sort } = {}) {
    const ids = state.orderVarietals.length
      ? state.orderVarietals
      : Object.keys(state.varietalsById);

    let rows = ids.map((id) => state.varietalsById[id]).filter(Boolean);

    if (search) {
      const q = String(search).toLowerCase();
      rows = rows.filter((v) =>
        `${v.crop || ""} ${v.cultivar || ""} ${v.species || ""} ${(
          v.tags || []
        ).join(" ")}`
          .toLowerCase()
          .includes(q)
      );
    }

    if (tag) {
      const t = String(tag).toLowerCase();
      rows = rows.filter((v) =>
        (v.tags || []).map((x) => String(x).toLowerCase()).includes(t)
      );
    }

    const map = state.varietalsById;
    const sortedIds = sortVarietals(
      rows.map((r) => r.id),
      map,
      sort || state.prefs.defaultSortVarietals
    );
    return sortedIds.map((id) => map[id]).filter(Boolean);
  }

  function listSeedLots({ search, varietalId, includeDepleted, sort } = {}) {
    const ids = state.orderSeedLots.length
      ? state.orderSeedLots
      : Object.keys(state.seedLotsById);

    const incDepl =
      typeof includeDepleted === "boolean"
        ? includeDepleted
        : !state.prefs.hideDepleted;

    let rows = ids.map((id) => state.seedLotsById[id]).filter(Boolean);

    if (!incDepl) {
      rows = rows.filter((l) => l.status !== "depleted");
    }

    if (varietalId) {
      const vId = String(varietalId);
      rows = rows.filter((l) => l.varietalId === vId);
    }

    if (search) {
      const q = String(search).toLowerCase();
      rows = rows.filter((l) =>
        `${l.crop || ""} ${l.cultivar || ""} ${l.vendor || ""} ${
          l.lotCode || ""
        } ${l.notes || ""}`
          .toLowerCase()
          .includes(q)
      );
    }

    const map = state.seedLotsById;
    const sortedIds = sortLots(
      rows.map((r) => r.id),
      map,
      state.testsById,
      sort || state.prefs.defaultSortLots
    );
    return sortedIds.map((id) => map[id]).filter(Boolean);
  }

  function getVarietal(id) {
    return state.varietalsById[String(id)] || null;
  }

  function getSeedLot(id) {
    return state.seedLotsById[String(id)] || null;
  }

  function listTestsForLot(seedLotId) {
    const lotId = String(seedLotId || "");
    const rows = state.orderTests
      .map((id) => state.testsById[id])
      .filter((t) => t && t.seedLotId === lotId);

    rows.sort(
      (a, b) =>
        new Date(b.testedAt || 0).getTime() -
        new Date(a.testedAt || 0).getTime()
    );
    return rows;
  }

  function getLotViability(seedLotId) {
    const lot = getSeedLot(seedLotId);
    return estimateViabilityForLot(lot, {
      testsById: state.testsById,
      expectedShelfLifeDays: state.prefs.expectedShelfLifeDays,
    });
  }

  function summaryCounts() {
    const lots = Object.values(state.seedLotsById || {});
    const varietals = Object.keys(state.varietalsById || {}).length;

    let activeLots = 0,
      depletedLots = 0,
      totalQty = 0;

    for (const l of lots) {
      if (!l) continue;
      if (l.status === "depleted") depletedLots++;
      else activeLots++;
      totalQty += toNumber(l.qty) ?? 0;
    }

    return {
      varietals,
      lots: lots.length,
      activeLots,
      depletedLots,
      totalQty: round2(totalQty),
    };
  }

  /* --------------------------------- Imports --------------------------------- */

  function importAll(payload, { mode = "merge" } = {}) {
    // payload can be { varietals, lots, tests } or arrays
    const varietals = Array.isArray(payload) ? payload : payload?.varietals;
    const lots = payload?.lots;
    const tests = payload?.tests;

    setState(
      (prev) => {
        const varietalsById =
          mode === "replace" ? {} : { ...prev.varietalsById };
        const seedLotsById = mode === "replace" ? {} : { ...prev.seedLotsById };
        const testsById = mode === "replace" ? {} : { ...prev.testsById };

        if (Array.isArray(varietals)) {
          for (const v of varietals) {
            const nv = normalizeVarietal(v);
            varietalsById[nv.id] = nv;
          }
        }
        if (Array.isArray(lots)) {
          for (const l of lots) {
            const nl = normalizeSeedLot(l);
            seedLotsById[nl.id] = nl;
          }
        }
        if (Array.isArray(tests)) {
          for (const t of tests) {
            const nt = normalizeTest(t);
            testsById[nt.id] = nt;
          }
        }

        const orderVarietals = sortVarietals(
          Object.keys(varietalsById),
          varietalsById,
          prev.prefs.defaultSortVarietals
        );
        const orderSeedLots = sortLots(
          Object.keys(seedLotsById),
          seedLotsById,
          testsById,
          prev.prefs.defaultSortLots
        );
        const orderTests = Object.keys(testsById);

        return {
          ...prev,
          varietalsById,
          seedLotsById,
          testsById,
          orderVarietals,
          orderSeedLots,
          orderTests,
          dirty: true,
        };
      },
      { op: "importAll", mode }
    );

    return true;
  }

  function exportAll() {
    return {
      version: VERSION,
      exportedAt: nowISO(),
      varietals: listVarietals(),
      lots: listSeedLots({ includeDepleted: true }),
      tests: Object.values(state.testsById || {}),
      prefs: state.prefs,
    };
  }

  /* -------------------------------- Public API ------------------------------- */

  return {
    // core
    getState,
    getSnapshot,
    subscribe,

    // lifecycle
    init,
    persistNow,

    // prefs
    setPrefs,

    // varietals
    upsertVarietal,
    deleteVarietal,

    // lots
    upsertSeedLot,
    deleteSeedLot,
    adjustLotQty,

    // tests
    addGerminationTest,
    deleteGerminationTest,

    // selectors
    listVarietals,
    listSeedLots,
    getVarietal,
    getSeedLot,
    listTestsForLot,
    getLotViability,
    summaryCounts,

    // import/export
    importAll,
    exportAll,
  };
}

/* -------------------------------- Singleton --------------------------------- */

const SeedStore = createStore();

// Auto-init in browser
if (typeof window !== "undefined") {
  Promise.resolve()
    .then(() => SeedStore.init())
    .catch(() => {});
}

export default SeedStore;
