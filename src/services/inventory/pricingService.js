// File: src/services/inventory/pricingService.js
/**
 * pricingService (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Provide browser-safe, offline-first pricing utilities for SSA inventory and
 *    shopping scan flows:
 *      • normalize prices / UPCs / pack sizes
 *      • store + retrieve price observations (per store/location)
 *      • compare across stores
 *      • apply coupons/promos (best-effort)
 *      • compute unit price + best offer ranking
 *
 * Design Goals
 *  - Production safe: no Node APIs; no build-breaking imports.
 *  - Works with or without Dexie:
 *      - If `db` exists and tables exist, it will use them.
 *      - Otherwise, falls back to localStorage cache.
 *  - Event-driven: emits events via eventBus if present.
 *
 * Expected (Optional) Dexie Tables (best-effort)
 *  - db.price_observations: observations captured from receipts or scans
 *  - db.pricebook: canonical/curated price entries
 *  - db.vendors: store/vendor metadata (incl. physical locations)
 *  - db.coupons: coupon library
 *
 * NOTE
 *  - This module is intentionally tolerant of schema differences. It probes
 *    table existence at runtime and adapts.
 */

const SOURCE = "inventory.pricingService";
const LS_KEY = "SSA.pricingService.cache.v1";

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

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function toNumber(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function normalizeISO(maybeISO) {
  if (!maybeISO) return undefined;
  const d = new Date(maybeISO);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

/* -------------------------------- Event Bus -------------------------------- */

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

/* ---------------------------------- Dexie ---------------------------------- */

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

function hasTable(db, name) {
  try {
    return !!db && !!db[name] && typeof db[name].toArray === "function";
  } catch {
    return false;
  }
}

/* ---------------------------- Local Cache (LS) ------------------------------ */

function loadCache() {
  if (typeof window === "undefined") {
    return { observations: [], pricebook: [], vendors: [], coupons: [] };
  }
  const raw = window.localStorage?.getItem?.(LS_KEY);
  const parsed = raw ? safeParseJSON(raw, null) : null;
  if (!parsed || !isObject(parsed)) {
    return { observations: [], pricebook: [], vendors: [], coupons: [] };
  }
  return {
    observations: Array.isArray(parsed.observations) ? parsed.observations : [],
    pricebook: Array.isArray(parsed.pricebook) ? parsed.pricebook : [],
    vendors: Array.isArray(parsed.vendors) ? parsed.vendors : [],
    coupons: Array.isArray(parsed.coupons) ? parsed.coupons : [],
  };
}

function saveCache(cache) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem?.(LS_KEY, JSON.stringify(cache));
  } catch {
    // ignore quota/private mode
  }
}

function cacheUpsert(list, row, key = "id") {
  const out = Array.isArray(list) ? [...list] : [];
  const k = row?.[key];
  if (!k) return out;
  const idx = out.findIndex((x) => x?.[key] === k);
  if (idx >= 0) out[idx] = { ...out[idx], ...row };
  else out.push(row);
  return out;
}

/* ---------------------------- Normalization Helpers ------------------------- */

/**
 * Normalize UPC/GTIN into a canonical string.
 * - keeps digits only
 * - preserves leading zeros by returning the stripped digit string as-is
 */
export function normalizeUPC(upc) {
  if (upc == null) return "";
  const digits = String(upc).replace(/\D+/g, "");
  return digits;
}

/**
 * Normalize a money-like input into a 2-decimal number.
 * Accepts:
 *  - number
 *  - "$1.99"
 *  - "1.99"
 */
export function normalizePrice(value) {
  if (value == null) return null;
  if (typeof value === "number") return round2(value);
  const s = String(value).trim();
  if (!s) return null;
  const cleaned = s.replace(/[^0-9.\-]/g, "");
  const n = toNumber(cleaned);
  return n == null ? null : round2(n);
}

/**
 * Normalize quantity/size inputs into a canonical "amount + unit" record.
 * Handles:
 *  - "12 oz", "1 lb", "2.5 kg", "16 fl oz", "750 ml", "1 gal"
 */
export function parsePackSize(packSize) {
  if (!packSize) return null;
  const s = String(packSize).trim().toLowerCase();
  if (!s) return null;

  // Patterns like "12oz" "12 oz" "12.5 oz"
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*([a-z]+(?:\s*[a-z]+)?)$/i);
  if (!m) return null;

  const amount = toNumber(m[1]);
  if (amount == null) return null;

  let unit = m[2].replace(/\s+/g, " ").trim();
  // normalize common units
  const map = {
    oz: "oz",
    ounce: "oz",
    ounces: "oz",
    lb: "lb",
    lbs: "lb",
    pound: "lb",
    pounds: "lb",
    g: "g",
    gram: "g",
    grams: "g",
    kg: "kg",
    kgs: "kg",
    kilogram: "kg",
    kilograms: "kg",
    ml: "ml",
    mls: "ml",
    l: "l",
    liter: "l",
    liters: "l",
    litre: "l",
    litres: "l",
    "fl oz": "floz",
    floz: "floz",
    "fluid oz": "floz",
    "fluid ounce": "floz",
    "fluid ounces": "floz",
    pt: "pt",
    pint: "pt",
    pints: "pt",
    qt: "qt",
    quart: "qt",
    quarts: "qt",
    gal: "gal",
    gallon: "gal",
    gallons: "gal",
    ct: "ct",
    count: "ct",
    ea: "ea",
    each: "ea",
  };
  unit = map[unit] || unit;

  return { amount, unit };
}

/**
 * Convert a pack size to a "base unit" amount for unit price comparisons.
 * Weight base: grams
 * Volume base: milliliters
 * Count base: count
 */
export function toBaseUnits(size) {
  if (!size || !Number.isFinite(Number(size.amount)) || !size.unit) return null;
  const amount = Number(size.amount);
  const unit = String(size.unit).toLowerCase();

  // weight
  if (unit === "g") return { amount, baseUnit: "g" };
  if (unit === "kg") return { amount: amount * 1000, baseUnit: "g" };
  if (unit === "oz") return { amount: amount * 28.349523125, baseUnit: "g" };
  if (unit === "lb") return { amount: amount * 453.59237, baseUnit: "g" };

  // volume
  if (unit === "ml") return { amount, baseUnit: "ml" };
  if (unit === "l") return { amount: amount * 1000, baseUnit: "ml" };
  if (unit === "floz")
    return { amount: amount * 29.5735295625, baseUnit: "ml" };
  if (unit === "pt") return { amount: amount * 473.176473, baseUnit: "ml" };
  if (unit === "qt") return { amount: amount * 946.352946, baseUnit: "ml" };
  if (unit === "gal") return { amount: amount * 3785.411784, baseUnit: "ml" };

  // count/each
  if (unit === "ct") return { amount, baseUnit: "ct" };
  if (unit === "ea") return { amount, baseUnit: "ct" };

  return null;
}

/**
 * Compute unit price (price / baseAmount) for comparable items.
 * Returns null if it cannot compute a valid unit price.
 */
export function computeUnitPrice(price, packSize) {
  const p = normalizePrice(price);
  if (p == null) return null;

  let size = packSize;
  if (typeof packSize === "string") size = parsePackSize(packSize);
  if (!size) return null;

  const base = toBaseUnits(size);
  if (!base) return null;
  if (base.amount <= 0) return null;

  return round2(p / base.amount);
}

/* ------------------------------ Coupon Logic -------------------------------- */

/**
 * A coupon is treated as:
 * {
 *  id,
 *  vendorId?, storeId?, // storeId can be locationId
 *  upc?, brand?, category?, tag?,
 *  type: "amountOff"|"percentOff"|"bogo"|"salePrice",
 *  amountOff?: number,
 *  percentOff?: number, // 0-100
 *  salePrice?: number,
 *  minQty?: number,
 *  expiresAt?: ISO,
 *  meta?: any
 * }
 *
 * This is best-effort; if your coupon schema differs, you can still pass
 * a mapper into applyCoupons().
 */
function couponIsExpired(c) {
  const exp = normalizeISO(c?.expiresAt);
  if (!exp) return false;
  return new Date(exp).getTime() < Date.now();
}

function couponMatches(c, ctx) {
  if (!c || couponIsExpired(c)) return false;

  // vendor/store constraints
  if (c.vendorId && ctx.vendorId && String(c.vendorId) !== String(ctx.vendorId))
    return false;
  if (c.storeId && ctx.storeId && String(c.storeId) !== String(ctx.storeId))
    return false;

  // product constraints
  if (c.upc && ctx.upc && normalizeUPC(c.upc) !== normalizeUPC(ctx.upc))
    return false;

  // category/tag/brand match (best-effort)
  if (
    c.brand &&
    ctx.brand &&
    String(c.brand).toLowerCase() !== String(ctx.brand).toLowerCase()
  )
    return false;

  if (
    c.category &&
    ctx.category &&
    String(c.category).toLowerCase() !== String(ctx.category).toLowerCase()
  )
    return false;

  if (c.tag && Array.isArray(ctx.tags)) {
    const tag = String(c.tag).toLowerCase();
    const tags = ctx.tags.map((t) => String(t).toLowerCase());
    if (!tags.includes(tag)) return false;
  }

  // quantity requirement
  const minQty = toNumber(c.minQty);
  if (minQty != null && minQty > 0) {
    const qty = toNumber(ctx.qty) ?? 1;
    if (qty < minQty) return false;
  }

  return true;
}

function applyCouponToPrice(coupon, basePrice, qty = 1) {
  const p = normalizePrice(basePrice);
  if (p == null) return null;
  const q = Math.max(1, Math.trunc(toNumber(qty) ?? 1));
  const type = String(coupon?.type || "").trim();

  // Note: these are per-item simplifications. Real-world coupons can be more complex.
  if (type === "salePrice") {
    const sale = normalizePrice(coupon.salePrice);
    if (sale == null) return null;
    return { finalPrice: round2(sale * q), savings: round2(p * q - sale * q) };
  }

  if (type === "amountOff") {
    const off = normalizePrice(coupon.amountOff);
    if (off == null) return null;
    const final = Math.max(0, p * q - off);
    return { finalPrice: round2(final), savings: round2(p * q - final) };
  }

  if (type === "percentOff") {
    const pct = clamp(toNumber(coupon.percentOff) ?? 0, 0, 100);
    const final = p * q * (1 - pct / 100);
    return {
      finalPrice: round2(Math.max(0, final)),
      savings: round2(p * q - final),
    };
  }

  if (type === "bogo") {
    // best-effort: assume "buy one get one free" (one free per pair)
    const free = Math.floor(q / 2);
    const final = p * (q - free);
    return { finalPrice: round2(final), savings: round2(p * q - final) };
  }

  return null;
}

/**
 * Apply coupons to an offer.
 * @param {Object} params
 * @param {number|string} params.price - base unit price for 1 item (or subtotal if you pass qty)
 * @param {number} [params.qty=1]
 * @param {Object} params.context - { upc, vendorId, storeId, brand, category, tags }
 * @param {Array} params.coupons - coupon list
 * @param {(coupon:any)=>any} [params.mapCoupon] - optional mapper for external coupon schemas
 */
export function applyCoupons({
  price,
  qty = 1,
  context,
  coupons,
  mapCoupon,
} = {}) {
  const base = normalizePrice(price);
  if (base == null) {
    return {
      baseSubtotal: null,
      finalSubtotal: null,
      applied: [],
      rejected: [],
    };
  }

  const q = Math.max(1, Math.trunc(toNumber(qty) ?? 1));
  const baseSubtotal = round2(base * q);

  const mapped = (Array.isArray(coupons) ? coupons : [])
    .map((c) => (mapCoupon ? mapCoupon(c) : c))
    .filter(Boolean);

  const applied = [];
  const rejected = [];

  let bestFinal = baseSubtotal;

  for (const c of mapped) {
    if (!couponMatches(c, { ...(context || {}), qty: q })) {
      rejected.push({ coupon: c, reason: "no-match" });
      continue;
    }
    const res = applyCouponToPrice(c, base, q);
    if (!res) {
      rejected.push({ coupon: c, reason: "unsupported" });
      continue;
    }
    applied.push({ coupon: c, ...res });
    if (res.finalPrice < bestFinal) bestFinal = res.finalPrice;
  }

  // Choose all coupons that reach the best final (ties included)
  const winners = applied.filter((a) => a.finalPrice === bestFinal);

  return {
    baseSubtotal,
    finalSubtotal: round2(bestFinal),
    savings: round2(baseSubtotal - bestFinal),
    applied: winners,
    rejected,
  };
}

/* ----------------------------- Data Access Layer ---------------------------- */

async function readAllFromTable(db, tableName) {
  try {
    if (!hasTable(db, tableName)) return [];
    return (await db[tableName].toArray()) || [];
  } catch {
    return [];
  }
}

async function upsertRow(db, tableName, row) {
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

async function bulkUpsert(db, tableName, rows) {
  try {
    if (!hasTable(db, tableName)) return false;
    const t = db[tableName];
    if (typeof t.bulkPut === "function") {
      await t.bulkPut(rows);
      return true;
    }
    // fallback
    for (const r of rows) await upsertRow(db, tableName, r);
    return true;
  } catch {
    return false;
  }
}

/* ----------------------------- Observation Model ---------------------------- */

/**
 * Canonical observation shape (what we store)
 * {
 *  id,
 *  upc,
 *  title?,
 *  brand?,
 *  vendorId?,     // chain/vendor identifier
 *  storeId?,      // physical location id (preferred)
 *  storeName?,
 *  address?,
 *  city?, state?, zip?,
 *  price,         // numeric (per item)
 *  qty?,          // number of items in line
 *  packSize?,     // "12 oz", etc.
 *  unitPrice?,    // computed from packSize
 *  currency?,     // "USD"
 *  observedAt,    // ISO
 *  source: "scan"|"receipt"|"manual"|"pricebook"
 *  confidence?,   // 0-1
 *  meta?
 * }
 */
function createObservation(input) {
  const upc = normalizeUPC(input?.upc || input?.gtin || input?.barcode);
  const price = normalizePrice(
    input?.price ?? input?.unitPrice ?? input?.amount
  );
  const observedAt = normalizeISO(input?.observedAt) || nowISO();

  const packSizeStr = input?.packSize || input?.size || input?.packageSize;
  const unitPrice = computeUnitPrice(price, packSizeStr);

  const id =
    input?.id ||
    `obs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

  return {
    id,
    upc,
    title: input?.title != null ? String(input.title) : undefined,
    brand: input?.brand != null ? String(input.brand) : undefined,

    vendorId: input?.vendorId != null ? String(input.vendorId) : undefined,
    storeId: input?.storeId != null ? String(input.storeId) : undefined,
    storeName: input?.storeName != null ? String(input.storeName) : undefined,

    address: input?.address != null ? String(input.address) : undefined,
    city: input?.city != null ? String(input.city) : undefined,
    state: input?.state != null ? String(input.state) : undefined,
    zip: input?.zip != null ? String(input.zip) : undefined,

    price,
    qty:
      input?.qty != null
        ? Math.max(1, Math.trunc(toNumber(input.qty) ?? 1))
        : 1,
    packSize: packSizeStr != null ? String(packSizeStr) : undefined,
    unitPrice: unitPrice != null ? unitPrice : undefined,

    currency: input?.currency != null ? String(input.currency) : "USD",
    observedAt,
    source: input?.source ? String(input.source) : "scan",
    confidence:
      input?.confidence != null ? clamp(Number(input.confidence), 0, 1) : 0.7,

    meta: isObject(input?.meta) ? { ...input.meta } : undefined,
  };
}

/* ------------------------------- Public APIs -------------------------------- */

/**
 * Warm the service caches (Dexie → localStorage cache mirror).
 * Safe to call repeatedly.
 */
export async function warmPricingCache() {
  const db = await getDB();
  const cache = loadCache();

  if (db) {
    // Mirror optional tables into cache (best-effort)
    const observations = await readAllFromTable(db, "price_observations");
    const pricebook = await readAllFromTable(db, "pricebook");
    const vendors = await readAllFromTable(db, "vendors");
    const coupons = await readAllFromTable(db, "coupons");

    const merged = {
      observations: Array.isArray(observations)
        ? observations
        : cache.observations,
      pricebook: Array.isArray(pricebook) ? pricebook : cache.pricebook,
      vendors: Array.isArray(vendors) ? vendors : cache.vendors,
      coupons: Array.isArray(coupons) ? coupons : cache.coupons,
    };

    saveCache(merged);

    await emit("pricing.cache.warmed", {
      source: SOURCE,
      at: nowISO(),
      dexie: true,
      counts: {
        observations: merged.observations.length,
        pricebook: merged.pricebook.length,
        vendors: merged.vendors.length,
        coupons: merged.coupons.length,
      },
    });

    return { dexie: true, ...merged };
  }

  await emit("pricing.cache.warmed", {
    source: SOURCE,
    at: nowISO(),
    dexie: false,
    counts: {
      observations: cache.observations.length,
      pricebook: cache.pricebook.length,
      vendors: cache.vendors.length,
      coupons: cache.coupons.length,
    },
  });

  return { dexie: false, ...cache };
}

/**
 * Commit a new price observation (scan / receipt / manual).
 * Writes to Dexie if available; always mirrors to local cache.
 */
export async function commitPriceObservation(observationInput) {
  const obs = createObservation(observationInput);
  const db = await getDB();
  const cache = loadCache();

  // Mirror into local cache immediately
  const nextCache = {
    ...cache,
    observations: cacheUpsert(cache.observations, obs, "id"),
  };
  saveCache(nextCache);

  // Persist to Dexie if possible
  let persisted = false;
  if (db && hasTable(db, "price_observations")) {
    persisted = await upsertRow(db, "price_observations", obs);
  }

  await emit("pricing.observation.committed", {
    source: SOURCE,
    at: nowISO(),
    id: obs.id,
    upc: obs.upc,
    vendorId: obs.vendorId,
    storeId: obs.storeId,
    price: obs.price,
    persisted,
  });

  return { observation: obs, persisted };
}

/**
 * Bulk commit observations (e.g., receipt parse).
 */
export async function commitPriceObservations(list = []) {
  const inputs = Array.isArray(list) ? list : [];
  const rows = inputs.map(createObservation);

  const db = await getDB();
  const cache = loadCache();
  let observations = cache.observations;

  for (const r of rows) observations = cacheUpsert(observations, r, "id");
  saveCache({ ...cache, observations });

  let persisted = false;
  if (db && hasTable(db, "price_observations")) {
    persisted = await bulkUpsert(db, "price_observations", rows);
  }

  await emit("pricing.observation.bulkCommitted", {
    source: SOURCE,
    at: nowISO(),
    count: rows.length,
    persisted,
  });

  return { count: rows.length, persisted, observations: rows };
}

/**
 * Get price history for a UPC (optionally scoped by vendor/store).
 */
export async function getPriceHistory({
  upc,
  vendorId,
  storeId,
  limit = 100,
  includePricebook = true,
} = {}) {
  const target = normalizeUPC(upc);
  const lim = Math.max(1, Math.trunc(toNumber(limit) ?? 100));

  const { observations, pricebook } = await warmPricingCache();

  const obsRows = (Array.isArray(observations) ? observations : [])
    .map((x) => (isObject(x) ? x : null))
    .filter(Boolean)
    .filter((o) => normalizeUPC(o.upc) === target)
    .filter((o) =>
      vendorId ? String(o.vendorId || "") === String(vendorId) : true
    )
    .filter((o) =>
      storeId ? String(o.storeId || "") === String(storeId) : true
    )
    .sort(
      (a, b) =>
        new Date(b.observedAt || 0).getTime() -
        new Date(a.observedAt || 0).getTime()
    )
    .slice(0, lim);

  let pbRows = [];
  if (includePricebook) {
    pbRows = (Array.isArray(pricebook) ? pricebook : [])
      .map((x) => (isObject(x) ? x : null))
      .filter(Boolean)
      .filter((p) => normalizeUPC(p.upc) === target)
      .filter((p) =>
        vendorId ? String(p.vendorId || "") === String(vendorId) : true
      )
      .filter((p) =>
        storeId ? String(p.storeId || "") === String(storeId) : true
      )
      .map((p) =>
        createObservation({
          ...p,
          source: p.source || "pricebook",
          observedAt: p.observedAt || p.updatedAt || p.createdAt || nowISO(),
          id:
            p.id || `pb_${p.upc}_${p.vendorId || "any"}_${p.storeId || "any"}`,
        })
      );
  }

  const combined = [...obsRows, ...pbRows].sort(
    (a, b) =>
      new Date(b.observedAt || 0).getTime() -
      new Date(a.observedAt || 0).getTime()
  );

  return combined.slice(0, lim);
}

/* ------------------------------ Offer / Ranking ----------------------------- */

/**
 * Build offers across stores/vendors for a given product.
 * You can pass a list of storeIds (physical locations) the user selected.
 */
export async function compareAcrossStores({
  upc,
  storeIds,
  vendorIds,
  includeCoupons = true,
  qty = 1,
  context = {},
} = {}) {
  const target = normalizeUPC(upc);
  const stores = stableUnique(storeIds);
  const vendors = stableUnique(vendorIds);

  const { observations, pricebook, coupons } = await warmPricingCache();

  // Gather candidates: observations + pricebook rows
  const candidateRows = [];

  for (const o of Array.isArray(observations) ? observations : []) {
    if (!o || normalizeUPC(o.upc) !== target) continue;
    candidateRows.push(createObservation({ ...o, source: o.source || "scan" }));
  }

  for (const p of Array.isArray(pricebook) ? pricebook : []) {
    if (!p || normalizeUPC(p.upc) !== target) continue;
    candidateRows.push(
      createObservation({ ...p, source: p.source || "pricebook" })
    );
  }

  // Apply scope filters
  const scoped = candidateRows
    .filter((r) =>
      stores.length ? stores.includes(String(r.storeId || "")) : true
    )
    .filter((r) =>
      vendors.length ? vendors.includes(String(r.vendorId || "")) : true
    );

  // Reduce to best per storeId (lowest effective subtotal, then newest)
  const byStore = new Map();
  for (const r of scoped) {
    const storeKey = String(r.storeId || r.vendorId || "unknown");
    const base = normalizePrice(r.price);
    if (base == null) continue;

    const couponResult =
      includeCoupons && Array.isArray(coupons)
        ? applyCoupons({
            price: base,
            qty,
            context: {
              ...context,
              upc: target,
              vendorId: r.vendorId,
              storeId: r.storeId,
              brand: r.brand,
              tags: context.tags || r.tags,
              category: context.category || r.category,
            },
            coupons,
          })
        : null;

    const finalSubtotal =
      couponResult?.finalSubtotal ??
      round2(base * Math.max(1, Math.trunc(qty || 1)));
    const savings = couponResult?.savings ?? 0;

    const offer = {
      ...r,
      upc: target,
      baseUnitPrice: base,
      qty: Math.max(1, Math.trunc(qty || 1)),
      baseSubtotal: round2(base * Math.max(1, Math.trunc(qty || 1))),
      finalSubtotal: finalSubtotal,
      savings: savings,
      appliedCoupons: couponResult?.applied || [],
      computedUnitPrice:
        r.unitPrice != null ? r.unitPrice : computeUnitPrice(base, r.packSize),
    };

    const prev = byStore.get(storeKey);
    if (!prev) {
      byStore.set(storeKey, offer);
      continue;
    }
    // pick lower finalSubtotal; tie-breaker newer observedAt; then higher confidence
    const prevFinal = toNumber(prev.finalSubtotal) ?? Number.POSITIVE_INFINITY;
    const nextFinal = toNumber(offer.finalSubtotal) ?? Number.POSITIVE_INFINITY;
    if (nextFinal < prevFinal) {
      byStore.set(storeKey, offer);
      continue;
    }
    if (nextFinal === prevFinal) {
      const prevT = new Date(prev.observedAt || 0).getTime();
      const nextT = new Date(offer.observedAt || 0).getTime();
      if (nextT > prevT) {
        byStore.set(storeKey, offer);
        continue;
      }
      const prevC = toNumber(prev.confidence) ?? 0;
      const nextC = toNumber(offer.confidence) ?? 0;
      if (nextC > prevC) byStore.set(storeKey, offer);
    }
  }

  const offers = Array.from(byStore.values());

  // Rank offers
  const ranked = rankOffers(offers);

  await emit("pricing.offers.compared", {
    source: SOURCE,
    at: nowISO(),
    upc: target,
    offers: ranked.length,
    scopedStores: stores.length || null,
    scopedVendors: vendors.length || null,
  });

  return ranked;
}

/**
 * Rank offers by:
 *  1) lowest finalSubtotal
 *  2) lowest unit price if available (computedUnitPrice)
 *  3) newest observedAt
 *  4) highest confidence
 */
export function rankOffers(offers = []) {
  const arr = Array.isArray(offers) ? offers.slice() : [];
  arr.sort((a, b) => {
    const aF = toNumber(a.finalSubtotal) ?? Number.POSITIVE_INFINITY;
    const bF = toNumber(b.finalSubtotal) ?? Number.POSITIVE_INFINITY;
    if (aF !== bF) return aF - bF;

    const aU = toNumber(a.computedUnitPrice) ?? Number.POSITIVE_INFINITY;
    const bU = toNumber(b.computedUnitPrice) ?? Number.POSITIVE_INFINITY;
    if (aU !== bU) return aU - bU;

    const aT = new Date(a.observedAt || 0).getTime();
    const bT = new Date(b.observedAt || 0).getTime();
    if (aT !== bT) return bT - aT;

    const aC = toNumber(a.confidence) ?? 0;
    const bC = toNumber(b.confidence) ?? 0;
    return bC - aC;
  });
  return arr;
}

/**
 * Get a "best price" summary for a UPC across selected stores/vendors.
 */
export async function getBestPrice({
  upc,
  storeIds,
  vendorIds,
  includeCoupons = true,
  qty = 1,
  context = {},
} = {}) {
  const offers = await compareAcrossStores({
    upc,
    storeIds,
    vendorIds,
    includeCoupons,
    qty,
    context,
  });

  const best = offers[0] || null;

  // Additional summary stats
  const finals = offers
    .map((o) => toNumber(o.finalSubtotal))
    .filter((x) => Number.isFinite(x));
  const min = finals.length ? Math.min(...finals) : null;
  const max = finals.length ? Math.max(...finals) : null;
  const avg = finals.length
    ? round2(finals.reduce((a, b) => a + b, 0) / finals.length)
    : null;

  return {
    upc: normalizeUPC(upc),
    best,
    offers,
    stats: { min, max, avg, count: offers.length },
  };
}

/* ------------------------------ Pricebook APIs ------------------------------ */

/**
 * Upsert a pricebook entry.
 * This is meant for curated prices (e.g., manually set "known good" store price).
 */
export async function upsertPricebookEntry(entry) {
  const row = createObservation({
    ...entry,
    source: entry?.source || "pricebook",
  });

  const db = await getDB();
  const cache = loadCache();

  const nextCache = {
    ...cache,
    pricebook: cacheUpsert(cache.pricebook, row, "id"),
  };
  saveCache(nextCache);

  let persisted = false;
  if (db && hasTable(db, "pricebook")) {
    persisted = await upsertRow(db, "pricebook", row);
  }

  await emit("pricing.pricebook.upserted", {
    source: SOURCE,
    at: nowISO(),
    id: row.id,
    upc: row.upc,
    vendorId: row.vendorId,
    storeId: row.storeId,
    price: row.price,
    persisted,
  });

  return { entry: row, persisted };
}

/**
 * Retrieve coupons (best-effort). You can optionally scope by vendor/store/upc.
 */
export async function getCoupons({ vendorId, storeId, upc } = {}) {
  const { coupons } = await warmPricingCache();
  const targetUPC = upc ? normalizeUPC(upc) : null;

  return (Array.isArray(coupons) ? coupons : [])
    .map((c) => (isObject(c) ? c : null))
    .filter(Boolean)
    .filter((c) => !couponIsExpired(c))
    .filter((c) =>
      vendorId ? String(c.vendorId || "") === String(vendorId) : true
    )
    .filter((c) =>
      storeId ? String(c.storeId || "") === String(storeId) : true
    )
    .filter((c) =>
      targetUPC ? normalizeUPC(c.upc || "") === targetUPC : true
    );
}

/* ------------------------------ Estimation APIs ----------------------------- */

/**
 * Estimate a unit price given a known price + packSize.
 * Returns:
 *  { unitPrice, baseUnit }
 */
export function estimateUnitPrice(price, packSize) {
  const p = normalizePrice(price);
  if (p == null) return { unitPrice: null, baseUnit: null };

  const size =
    typeof packSize === "string" ? parsePackSize(packSize) : packSize;
  const base = toBaseUnits(size);
  if (!base || base.amount <= 0) return { unitPrice: null, baseUnit: null };

  return { unitPrice: round2(p / base.amount), baseUnit: base.baseUnit };
}

/* --------------------------- Convenience: One-Shot --------------------------- */

/**
 * Convenience helper:
 * - commits an observation
 * - returns best price across selected stores/vendors
 *
 * Useful for "Shopping Scan" mode (scan now, compare now; commit as pending).
 */
export async function scanAndCompare({
  observation,
  compare: compareParams,
} = {}) {
  const committed = observation
    ? await commitPriceObservation(observation)
    : null;
  const upc = normalizeUPC(
    compareParams?.upc ||
      observation?.upc ||
      observation?.gtin ||
      observation?.barcode
  );
  const best = await getBestPrice({ ...compareParams, upc });
  return { committed, best };
}

/* ---------------------------- Default Export (API) --------------------------- */

const pricingService = {
  // cache
  warmPricingCache,

  // normalization
  normalizeUPC,
  normalizePrice,
  parsePackSize,
  toBaseUnits,
  computeUnitPrice,
  estimateUnitPrice,

  // coupons
  getCoupons,
  applyCoupons,

  // observations
  commitPriceObservation,
  commitPriceObservations,
  getPriceHistory,

  // comparisons
  compareAcrossStores,
  getBestPrice,
  rankOffers,

  // pricebook
  upsertPricebookEntry,

  // convenience
  scanAndCompare,
};

export default pricingService;
