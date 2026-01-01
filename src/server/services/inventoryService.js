// C:\Users\larho\suka-smart-assistant\src\server\services\inventoryService.js
//
// Suka Smart Assistant — Inventory Service (Dynamic)
// -----------------------------------------------------------------------------
// Purpose:
//   A pragmatic inventory layer used by /api/inventory routes, Agents, and n8n.
//   - Local JSON store (dev/offline) w/ in-memory mirror
//   - Deltas (consume/add/preserve/waste/adjust/transfer-in/out)
//   - Bulk ops for Sessions & Garden (reserve/consume/rollback/addProduced)
//   - Lightweight search & snapshot
//   - Batch/Lot metadata for produced goods (label printer alignment)
//   - Minimums/reorder checks for storehouse UX
//
// Existing API (kept):
//   - applyDelta({ userId, sku, qty, unit, reason?, location?, meta? })
//   - applyDeltas(deltasArray)
//   - transfer({ userId, sku, qty, unit, from, to, meta? })
//   - findItems({ userId, q?, sku?, limit? })
//
// New API (used by Cooking/Garden services & agents):
//   - snapshot(userId?) -> { items:[{name,sku,qty,unit,locations[]...}], locations, updatedAt }
//   - upsertItem({ userId, sku?, name, canonicalUnit?, meta?, seedLocation? })
//   - addItem(line) -> convenience wrapper for applyDelta(+)
//   - reserveBulk(lines, { userId, batchId, location? }) -> reservationId
//   - consumeBulk(lines, { userId, batchId, location? }) -> receipt[]
//   - rollbackReservation({ userId, batchId }) -> receipt[]
//   - addProducedBulk(outputs, { userId, batchId, location? }) -> receipt[]
//   - setMinimums({ userId, minimums: [{sku|minName, qty, unit}] })
//   - checkReorder({ userId }) -> [{sku,name,needed,unit,current,minimum}]
//
// Data model on disk (local):
//   data/inventory-local.json
//   {
//     users: {
//       "<userId>": {
//         items: {
//           "<sku>": {
//             name?: string,
//             canonicalUnit?: string,
//             locations: { [location: string]: number }, // qty in canonicalUnit
//             minimum?: { qty: number, unit: string }    // reorder threshold (canonical)
//             meta?: object
//           },
//           ...
//         },
//         reservations: {
//           "<batchId>": { id:"<batchId>", createdAt: ISO, lines:[{ sku, qty, unit, location }] }
//         },
//         moves: [ { ts, userId, action, payload } ] // audit trail (lightweight)
//       }
//     },
//     meta: { updatedAt: ISO, locations: string[] }
//   }
//
// Notes:
//   - Common kitchen units supported (g/kg, oz/lb, ml/l, tsp/tbsp/cup -> ml, ct/unit).
//   - “reservation” subtracts stock now; rollback will add it back (simple & safe).
//   - Locations are free-form; we seed common ones: ["Pantry","Fridge","Freezer","Root Cellar"].
// -----------------------------------------------------------------------------

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/* ──────────────────────────────────────────────────────────────────────────────
   Local persistence
────────────────────────────────────────────────────────────────────────────── */
const DATA_DIR = process.env.SUKA_DATA_DIR || path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "inventory-local.json");

// in-memory mirror
/** @type {{ users: Record<string, any>, meta: {updatedAt: string, locations: string[]} }} */
let state = null;

async function ensureLoaded() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const buf = await fs.readFile(DB_FILE);
    state = JSON.parse(buf.toString());
    if (!state.meta?.locations) state.meta = { ...(state.meta || {}), locations: seedLocations(state.meta?.locations) };
  } catch {
    state = {
      users: {},
      meta: { updatedAt: new Date().toISOString(), locations: seedLocations() },
    };
    await flush();
  }
}

function seedLocations(existing) {
  const defaults = ["Pantry", "Fridge", "Freezer", "Root Cellar"];
  if (Array.isArray(existing) && existing.length) {
    const set = new Set([...(existing || []), ...defaults]);
    return Array.from(set.values());
  }
  return defaults;
}

async function flush() {
  state.meta.updatedAt = new Date().toISOString();
  await fs.writeFile(DB_FILE, JSON.stringify(state, null, 2));
}

/* ──────────────────────────────────────────────────────────────────────────────
   Units & conversions
   - Canonical per SKU (first-seen or specified)
   - Supported families:
       Weight: g<->kg  and oz<->lb
       Volume: ml<->l  (+ kitchen: cup ≈ 240 ml, tbsp ≈ 15 ml, tsp ≈ 5 ml)
       Count : ct (aka unit)
────────────────────────────────────────────────────────────────────────────── */
const UNIT_MAP = {
  // weight
  g:   { family: "weight-g", canonical: "g",  toCanonical: (v, u) => (u === "kg" ? v * 1000 : v), fromCanonical: (v, u) => (u === "kg" ? v / 1000 : v) },
  kg:  { family: "weight-g", canonical: "g",  toCanonical: (v, u) => (u === "g" ? v : v * 1000), fromCanonical: (v, u) => (u === "g" ? v : v / 1000) },
  oz:  { family: "weight-oz", canonical: "oz", toCanonical: (v, u) => (u === "lb" ? v * 16 : v), fromCanonical: (v, u) => (u === "lb" ? v / 16 : v) },
  lb:  { family: "weight-oz", canonical: "oz", toCanonical: (v, u) => (u === "oz" ? v : v * 16), fromCanonical: (v, u) => (u === "oz" ? v : v / 16) },

  // volume
  ml:  { family: "vol-ml", canonical: "ml",   toCanonical: (v, u) => (u === "l" ? v * 1000 : v), fromCanonical: (v, u) => (u === "l" ? v / 1000 : v) },
  l:   { family: "vol-ml", canonical: "ml",   toCanonical: (v, u) => (u === "ml" ? v : v * 1000), fromCanonical: (v, u) => (u === "ml" ? v : v / 1000) },
  cup: { family: "vol-ml", canonical: "ml",   toCanonical: (v) => v * 240, fromCanonical: (v) => v / 240 },
  tbsp:{ family: "vol-ml", canonical: "ml",   toCanonical: (v) => v * 15,  fromCanonical: (v) => v / 15 },
  tsp: { family: "vol-ml", canonical: "ml",   toCanonical: (v) => v * 5,   fromCanonical: (v) => v / 5 },

  // count
  ct:    { family: "count", canonical: "ct", toCanonical: (v) => v, fromCanonical: (v) => v },
  unit:  { family: "count", canonical: "ct", toCanonical: (v) => v, fromCanonical: (v) => v }, // alias
  pcs:   { family: "count", canonical: "ct", toCanonical: (v) => v, fromCanonical: (v) => v }, // alias
  piece: { family: "count", canonical: "ct", toCanonical: (v) => v, fromCanonical: (v) => v }, // alias
};

function normalizeUnit(u) {
  if (!u) return null;
  const s = String(u).trim().toLowerCase();
  if (s === "units") return "ct";
  return UNIT_MAP[s] ? s : s; // accept unknown; will fallback
}

function toCanonical(qty, fromUnit, skuCanonical) {
  const f = normalizeUnit(fromUnit);
  if (!f || !UNIT_MAP[f]) return { qty, unit: skuCanonical || f || "ct" };

  const fam = UNIT_MAP[f].family;
  const target = skuCanonical || UNIT_MAP[f].canonical;

  // If SKU already has canonical unit and it's in SAME family, convert to that:
  if (skuCanonical && UNIT_MAP[skuCanonical] && UNIT_MAP[skuCanonical].family === fam) {
    const converted = UNIT_MAP[f].toCanonical(qty, f); // -> family canonical
    if (skuCanonical === UNIT_MAP[f].canonical) {
      return { qty: converted, unit: skuCanonical };
    }
    // Convert family canonical -> skuCanonical
    const back = UNIT_MAP[skuCanonical].fromCanonical(converted, skuCanonical);
    return { qty: back, unit: skuCanonical };
  }

  // Otherwise convert to family's canonical and adopt that as canonical for SKU
  const converted = UNIT_MAP[f].toCanonical(qty, f);
  return { qty: converted, unit: UNIT_MAP[f].canonical };
}

/* ──────────────────────────────────────────────────────────────────────────────
   Core helpers
────────────────────────────────────────────────────────────────────────────── */
const uid = () => crypto.randomUUID();
const nowISO = () => new Date().toISOString();

function getUser(userId) {
  if (!state.users[userId]) state.users[userId] = { items: {}, reservations: {}, moves: [] };
  return state.users[userId];
}

function getItem(user, sku) {
  const key = String(sku).trim();
  if (!user.items[key]) user.items[key] = { locations: {}, canonicalUnit: null, name: undefined, meta: {} };
  return user.items[key];
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function totalQty(item) {
  return Object.values(item.locations).reduce((a, b) => a + Number(b || 0), 0);
}

function recordMove(user, action, payload) {
  user.moves.push({ ts: nowISO(), action, payload });
  if (user.moves.length > 2000) user.moves.splice(0, user.moves.length - 2000);
}

/* ──────────────────────────────────────────────────────────────────────────────
   Public API — Single & Bulk Deltas
────────────────────────────────────────────────────────────────────────────── */

/**
 * Apply a single delta. Positive qty adds stock; negative consumes stock.
 * Returns a receipt with new balances.
 */
export async function applyDelta({ userId, sku, qty, unit, reason = "adjustment", location = "Pantry", meta = {} }) {
  if (!state) await ensureLoaded();
  if (!userId || !sku || typeof qty !== "number") {
    throw new Error("applyDelta requires { userId, sku, qty, unit }");
  }

  const user = getUser(userId);
  const item = getItem(user, sku);

  // determine canonical unit for SKU
  const fromUnit = normalizeUnit(unit) || item.canonicalUnit || "ct";
  if (!item.canonicalUnit) {
    const family = UNIT_MAP[fromUnit];
    item.canonicalUnit = family ? family.canonical : fromUnit;
  }

  // convert to canonical
  const { qty: canQty, unit: canUnit } = toCanonical(qty, fromUnit, item.canonicalUnit);
  if (canUnit !== item.canonicalUnit) {
    item.canonicalUnit = canUnit; // adopt when families differed
  }

  // apply change
  const locKey = String(location || "Pantry");
  const prev = Number(item.locations[locKey] || 0);
  const next = round2(prev + canQty);

  if (next < 0) {
    throw new Error(`Insufficient stock for ${sku} at ${locKey}: have ${prev} ${item.canonicalUnit}, trying to remove ${Math.abs(canQty)}.`);
  }

  item.locations[locKey] = next;

  // optional naming/metadata enrichment
  if (meta?.name && !item.name) item.name = meta.name;
  if (meta && typeof meta === "object") {
    item.meta = { ...(item.meta || {}), ...meta };
  }

  recordMove(user, "applyDelta", { sku, canQty, unit: item.canonicalUnit, reason, location: locKey, meta });
  await flush();

  return {
    sku: String(sku),
    reason,
    applied: canQty,
    unit: item.canonicalUnit,
    location: locKey,
    balanceAtLocation: next,
    totalBalance: round2(totalQty(item)),
    name: item.name || undefined,
  };
}

/**
 * Apply many deltas.
 */
export async function applyDeltas(deltasArray) {
  if (!Array.isArray(deltasArray) || deltasArray.length === 0) {
    throw new Error("applyDeltas requires a non-empty array");
  }
  const out = [];
  for (const d of deltasArray) {
    out.push(await applyDelta(d));
  }
  return out;
}

/**
 * Transfer between locations by applying two deltas.
 */
export async function transfer({ userId, sku, qty, unit, from, to, meta = {} }) {
  if (!userId || !sku || typeof qty !== "number" || !from || !to) {
    throw new Error("transfer requires { userId, sku, qty, unit, from, to }");
  }
  const out = [];
  out.push(await applyDelta({
    userId, sku,
    qty: -Math.abs(qty),
    unit,
    reason: "transfer-out",
    location: from,
    meta: { ...meta, transfer: { from, to } },
  }));
  out.push(await applyDelta({
    userId, sku,
    qty: Math.abs(qty),
    unit,
    reason: "transfer-in",
    location: to,
    meta: { ...meta, transfer: { from, to } },
  }));
  return { ok: true, moves: out };
}

/* ──────────────────────────────────────────────────────────────────────────────
   Public API — Lookup / Snapshot / Upsert
────────────────────────────────────────────────────────────────────────────── */

export async function findItems({ userId, q, sku, limit = 20 }) {
  if (!state) await ensureLoaded();
  const user = state.users[userId];
  if (!user) return [];

  const items = user.items || {};
  if (sku) {
    const it = items[sku];
    if (!it) return [];
    return [{
      sku,
      name: it.name || sku,
      qty: round2(totalQty(it)),
      unit: it.canonicalUnit || "ct",
      locations: Object.keys(it.locations),
      minimum: it.minimum || null,
    }];
  }

  const needle = (q || "").toString().toLowerCase().trim();
  const all = Object.entries(items).map(([k, it]) => ({
    sku: k,
    name: it.name || k,
    qty: round2(totalQty(it)),
    unit: it.canonicalUnit || "ct",
    locations: Object.keys(it.locations),
    meta: it.meta || {},
    minimum: it.minimum || null,
  }));

  let results = all;
  if (needle) {
    results = all.filter((r) =>
      r.sku.toLowerCase().includes(needle) ||
      (r.name && r.name.toLowerCase().includes(needle)) ||
      (r.meta?.notes && String(r.meta.notes).toLowerCase().includes(needle))
    );
  }
  results.sort((a, b) => b.qty - a.qty);
  return results.slice(0, Math.max(1, Math.min(100, limit)));
}

export async function snapshot(userId) {
  if (!state) await ensureLoaded();
  const user = state.users[userId];
  if (!user) return { items: [], locations: state.meta.locations, updatedAt: state.meta.updatedAt };

  const items = Object.entries(user.items).map(([sku, it]) => ({
    sku,
    name: it.name || sku,
    qty: round2(totalQty(it)),
    unit: it.canonicalUnit || "ct",
    locations: Object.keys(it.locations),
    minimum: it.minimum || null,
    meta: it.meta || {},
  })).sort((a, b) => a.name.localeCompare(b.name));

  return { items, locations: state.meta.locations, updatedAt: state.meta.updatedAt };
}

export async function upsertItem({ userId, sku, name, canonicalUnit, meta = {}, seedLocation }) {
  if (!state) await ensureLoaded();
  if (!userId) throw new Error("upsertItem requires userId");

  const user = getUser(userId);
  const key = sku || slugify(name || `sku-${uid().slice(0, 6)}`);
  const it = getItem(user, key);

  if (name) it.name = name;
  if (canonicalUnit) it.canonicalUnit = normalizeUnit(canonicalUnit) || canonicalUnit;
  it.meta = { ...(it.meta || {}), ...meta };
  if (seedLocation && state.meta.locations.includes(seedLocation) && typeof it.locations[seedLocation] === "undefined") {
    it.locations[seedLocation] = 0;
  }

  recordMove(user, "upsertItem", { sku: key, name: it.name, canonicalUnit: it.canonicalUnit, seedLocation });
  await flush();
  return { sku: key, name: it.name || key, unit: it.canonicalUnit || "ct", locations: Object.keys(it.locations) };
}

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/* ──────────────────────────────────────────────────────────────────────────────
   Public API — Convenience & Bulk for Sessions/Garden
────────────────────────────────────────────────────────────────────────────── */

export async function addItem({ userId, name, qty, unit = "ct", location = "Pantry", meta = {} }) {
  const sku = meta?.sku || slugify(name);
  return applyDelta({ userId, sku, qty: Math.abs(Number(qty) || 0), unit, reason: "add", location, meta: { name, ...meta } });
}

/**
 * Reserve stock now for a batch (cooking/garden). Can be rolled back.
 * lines: [{ name?, sku, qty, unit, location? }]
 */
export async function reserveBulk(lines, { userId, batchId, location = "Pantry" } = {}) {
  if (!state) await ensureLoaded();
  if (!userId) throw new Error("reserveBulk requires userId");
  if (!Array.isArray(lines) || !lines.length) throw new Error("reserveBulk requires lines");

  const user = getUser(userId);
  const id = String(batchId || `batch_${uid().slice(0, 8)}`);
  const receipts = [];

  for (const ln of lines) {
    const sku = ln.sku || slugify(ln.name || "");
    const meta = ln.name ? { name: ln.name, batchId: id } : { batchId: id };
    receipts.push(await applyDelta({
      userId,
      sku,
      qty: -Math.abs(Number(ln.qty) || 0),
      unit: ln.unit,
      reason: "reserve",
      location: ln.location || location,
      meta,
    }));
  }

  user.reservations[id] = {
    id,
    createdAt: nowISO(),
    lines: lines.map((ln) => ({
      sku: ln.sku || slugify(ln.name || ""),
      qty: Number(ln.qty) || 0,
      unit: normalizeUnit(ln.unit) || ln.unit || "ct",
      location: ln.location || location,
    })),
  };

  recordMove(user, "reserveBulk", { batchId: id, count: lines.length });
  await flush();
  return { reservationId: id, receipts };
}

/**
 * Consume stock for a batch (finalize). Independent of reservation for simplicity.
 */
export async function consumeBulk(lines, { userId, batchId, location = "Pantry" } = {}) {
  if (!state) await ensureLoaded();
  if (!userId) throw new Error("consumeBulk requires userId");
  if (!Array.isArray(lines) || !lines.length) throw new Error("consumeBulk requires lines");

  const receipts = [];
  for (const ln of lines) {
    const sku = ln.sku || slugify(ln.name || "");
    receipts.push(await applyDelta({
      userId,
      sku,
      qty: -Math.abs(Number(ln.qty) || 0),
      unit: ln.unit,
      reason: "consume",
      location: ln.location || location,
      meta: { name: ln.name, batchId },
    }));
  }
  return receipts;
}

/**
 * Rollback a previous reservation for batchId (adds quantities back).
 */
export async function rollbackReservation({ userId, batchId }) {
  if (!state) await ensureLoaded();
  if (!userId || !batchId) throw new Error("rollbackReservation requires userId and batchId");

  const user = getUser(userId);
  const res = user.reservations?.[batchId];
  if (!res) return { ok: false, reason: "no-reservation" };

  const receipts = [];
  for (const ln of res.lines || []) {
    receipts.push(await applyDelta({
      userId,
      sku: ln.sku,
      qty: Math.abs(Number(ln.qty) || 0),
      unit: ln.unit,
      reason: "rollback-reservation",
      location: ln.location || "Pantry",
      meta: { batchId },
    }));
  }
  delete user.reservations[batchId];
  recordMove(user, "rollbackReservation", { batchId });
  await flush();
  return { ok: true, receipts };
}

/**
 * Add produced goods (labels become lot metadata). outputs: [{ name, qty, unit, location?, meta? }]
 */
export async function addProducedBulk(outputs, { userId, batchId, location = "Pantry" } = {}) {
  if (!state) await ensureLoaded();
  if (!userId) throw new Error("addProducedBulk requires userId");
  if (!Array.isArray(outputs) || !outputs.length) throw new Error("addProducedBulk requires outputs");

  const receipts = [];
  for (const out of outputs) {
    const sku = out.meta?.sku || slugify(out.name);
    const lot = out.meta?.batchCode || `lot-${(batchId || "").toString().slice(0, 12) || uid().slice(0, 8)}`;
    receipts.push(await applyDelta({
      userId,
      sku,
      qty: Math.abs(Number(out.qty) || 0),
      unit: out.unit || "ct",
      reason: "produce",
      location: out.location || location,
      meta: { name: out.name, batchId, lot, ...out.meta },
    }));
  }
  return receipts;
}

/* ──────────────────────────────────────────────────────────────────────────────
   Public API — Minimums / Reorder
────────────────────────────────────────────────────────────────────────────── */

export async function setMinimums({ userId, minimums = [] }) {
  if (!state) await ensureLoaded();
  if (!userId) throw new Error("setMinimums requires userId");

  const user = getUser(userId);
  for (const m of minimums) {
    const sku = m.sku || slugify(m.minName || "");
    if (!sku) continue;
    const it = getItem(user, sku);
    const norm = toCanonical(Number(m.qty) || 0, m.unit, it.canonicalUnit);
    it.canonicalUnit = it.canonicalUnit || norm.unit;
    it.minimum = { qty: round2(norm.qty), unit: it.canonicalUnit };
  }
  recordMove(user, "setMinimums", { count: minimums.length });
  await flush();
  return { ok: true };
}

export async function checkReorder({ userId }) {
  if (!state) await ensureLoaded();
  const user = state.users[userId];
  if (!user) return [];

  const out = [];
  for (const [sku, it] of Object.entries(user.items || {})) {
    if (!it.minimum) continue;
    const cur = round2(totalQty(it));
    if (cur < it.minimum.qty) {
      out.push({
        sku,
        name: it.name || sku,
        needed: round2(it.minimum.qty - cur),
        unit: it.canonicalUnit || "ct",
        current: cur,
        minimum: it.minimum.qty,
      });
    }
  }
  return out.sort((a, b) => (b.needed - a.needed));
}

/* ──────────────────────────────────────────────────────────────────────────────
   n8n payload (compact)
────────────────────────────────────────────────────────────────────────────── */
export function buildN8nPayload({ userId, includeMinimums = true } = {}) {
  const u = state?.users?.[userId];
  const items = u ? Object.entries(u.items).map(([sku, it]) => ({
    sku,
    name: it.name || sku,
    qty: round2(totalQty(it)),
    unit: it.canonicalUnit || "ct",
    minimum: it.minimum || null,
  })) : [];
  return {
    userId,
    updatedAt: state?.meta?.updatedAt,
    items,
    reorder: includeMinimums ? items.filter(i => i.minimum && i.qty < i.minimum.qty) : [],
  };
}

/* ──────────────────────────────────────────────────────────────────────────────
   Default export (for dynamic import usage)
────────────────────────────────────────────────────────────────────────────── */
export default {
  // Core
  applyDelta,
  applyDeltas,
  transfer,
  findItems,

  // Lookup / lifecycle
  snapshot,
  upsertItem,
  addItem,

  // Bulk for sessions & garden
  reserveBulk,
  consumeBulk,
  rollbackReservation,
  addProducedBulk,

  // Minimums / reorder
  setMinimums,
  checkReorder,

  // n8n
  buildN8nPayload,
};
