// src/models/SupplyInventory.js

/**
 * SupplyInventory
 * -----------------------------------------------------------------------------
 * Unified model for household supplies & ingredients supporting:
 *  - Smart units + basic conversions (cups/tbsp/tsp, lb/oz, g/kg, ml/l)
 *  - Reservations for sessions (held → committed/consumed or released)
 *  - Lots (batches) with FEFO (first-expire-first-out) consumption
 *  - Depletion forecasting & projected runout date
 *  - Reorder point (ROP) with safety stock & vendor pack suggestions
 *  - Substitutions & “make vs buy” (homemade cleaners)
 *  - Links to tasks/recipes; tags & notes
 *  - Full audit trail; clean toJSON()/from()
 */

const UID = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

// --- Unit normalization & simple conversions (extend as needed) ---
const UNIT_ALIASES = {
  teaspoon: "tsp", teaspoons: "tsp",
  tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
  ounce: "oz", ounces: "oz",
  pound: "lb", pounds: "lb",
  gram: "g", grams: "g",
  kilogram: "kg", kilograms: "kg",
  milliliter: "ml", milliliters: "ml",
  liter: "l", liters: "l",
  cup: "cup", cups: "cup",
  piece: "pcs", pieces: "pcs"
};
function normUnit(u) {
  if (!u) return "";
  const s = String(u).trim().toLowerCase();
  return UNIT_ALIASES[s] || s;
}

// conversions return multiplier to convert FROM -> TO (if supported)
const CONV = {
  // volume (metric)
  "ml->l": 0.001, "l->ml": 1000,
  // mass (metric)
  "g->kg": 0.001, "kg->g": 1000,
  // mass (imperial)
  "oz->lb": 1/16, "lb->oz": 16,
  // handy cooking (approx)
  "tsp->tbsp": 1/3, "tbsp->tsp": 3,
  "tbsp->cup": 1/16, "cup->tbsp": 16,
  "tsp->cup": 1/48, "cup->tsp": 48
};
function convertQty(qty, fromUnit, toUnit) {
  const f = normUnit(fromUnit), t = normUnit(toUnit);
  if (!f || !t || f === t) return { qty, unit: t || f };
  const key = `${f}->${t}`;
  if (CONV[key] != null) return { qty: qty * CONV[key], unit: t };
  // unknown path: return qty as-is with original unit
  return { qty, unit: f };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

class SupplyInventory {
  constructor({
    id,
    name,
    category = "",            // "cleaning" | "cooking" | "personal care" | ...
    subcategory = "",         // optional refinement
    unit = "",                // canonical unit (normalized)
    quantity = 0,             // on-hand (base unit)
    threshold = 0,            // legacy restock alert
    minQty = 0,               // preferred minimum (par min)
    maxQty = null,            // preferred maximum (par max/target)
    safetyStock = 0,          // buffer above average demand
    location = "",            // "pantry" | "cleaning cabinet" | ...
    locations = [],           // [{ name, qty }] (optional per-location)
    tags = [],                // ["eco","disinfectant","vinegar"]
    linkedTasks = [],         // task IDs using this supply
    linkedRecipes = [],       // recipe IDs using this supply
    substitutes = [],         // alternative supply IDs/names
    makeVsBuy = {             // homemade option for cleaners/food
      canMake: false, recipeId: null, notes: ""
    },
    autoRestock = false,      // eligible for auto-purchase
    vendors = [],             // [{ id, name, sku, url, packQty, packUnit, price, leadTimeDays }]
    lotTracking = true,       // enable FEFO/FIFO with lots
    lots = [],                // [{ id, qty, unit, acquiredAt, expiresAt, costPerUnit? }]
    perishable = false,
    defaultShelfLifeDays = null,

    // demand tracking
    usageHistory = [],        // [{ at, delta, context }] (delta negative for consumption)
    reservations = [],        // [{ id, qty, unit, context:{type,refId}, status, createdAt }]
    lastUpdated = new Date(),
    notes = "",

    // identity/costing
    sku = "",
    barcode = "",
    costPerUnit = null,       // base unit cost
  } = {}) {
    this.id = id || `supply-${UID()}`;
    this.name = name;
    this.category = category;
    this.subcategory = subcategory;
    this.unit = normUnit(unit);
    this.quantity = Number(quantity || 0);
    this.threshold = Number(threshold || 0);
    this.minQty = Number(minQty || 0);
    this.maxQty = maxQty != null ? Number(maxQty) : null;
    this.safetyStock = Number(safetyStock || 0);
    this.location = location;
    this.locations = Array.isArray(locations) ? locations : [];
    this.tags = Array.isArray(tags) ? tags : [];
    this.linkedTasks = Array.isArray(linkedTasks) ? linkedTasks : [];
    this.linkedRecipes = Array.isArray(linkedRecipes) ? linkedRecipes : [];
    this.substitutes = Array.isArray(substitutes) ? substitutes : [];
    this.makeVsBuy = makeVsBuy || { canMake: false, recipeId: null, notes: "" };
    this.autoRestock = !!autoRestock;
    this.vendors = Array.isArray(vendors) ? vendors : [];

    this.lotTracking = !!lotTracking;
    this.lots = Array.isArray(lots) ? lots.map((l) => this._normalizeLot(l)) : [];
    this.perishable = !!perishable;
    this.defaultShelfLifeDays = defaultShelfLifeDays != null ? Number(defaultShelfLifeDays) : null;

    this.usageHistory = Array.isArray(usageHistory) ? usageHistory : [];
    this.reservations = Array.isArray(reservations) ? reservations : [];
    this.lastUpdated = lastUpdated instanceof Date ? lastUpdated : new Date();
    this.notes = notes;

    this.sku = sku;
    this.barcode = barcode;
    this.costPerUnit = costPerUnit != null ? Number(costPerUnit) : null;
  }

  /* ---------------------------- Normalization ---------------------------- */

  _normalizeLot(l) {
    return {
      id: l.id || `lot-${UID()}`,
      qty: Number(l.qty || 0),
      unit: normUnit(l.unit || this.unit),
      acquiredAt: l.acquiredAt ? new Date(l.acquiredAt) : new Date(),
      expiresAt: l.expiresAt ? new Date(l.expiresAt) : (this.defaultShelfLifeDays ? this._addDays(new Date(), this.defaultShelfLifeDays) : null),
      costPerUnit: l.costPerUnit != null ? Number(l.costPerUnit) : this.costPerUnit
    };
  }
  _addDays(d, n) { const x = new Date(d); x.setDate(x.getDate()+n); return x; }

  /* ------------------------------- Mutations ------------------------------ */

  updateQuantity(amount, { unit = this.unit, reason = "manual-adjust", context = null } = {}) {
    const { qty } = convertQty(Number(amount || 0), unit, this.unit);
    this.quantity = Math.max(0, Number(qty));
    this._touch();
    this._logUsage(this.quantity - this.quantity, { reason, context }); // noop baseline
  }

  increase(amount, { unit = this.unit, lot = null, costPerUnit = null, expiresAt = null } = {}) {
    const { qty } = convertQty(Number(amount || 0), unit, this.unit);
    this.quantity = Math.max(0, this.quantity + qty);
    if (this.lotTracking) {
      const lotObj = this._normalizeLot({
        ...(lot || {}),
        qty,
        unit: this.unit,
        costPerUnit: costPerUnit != null ? costPerUnit : this.costPerUnit,
        expiresAt: expiresAt || lot?.expiresAt || null
      });
      this.lots.push(lotObj);
    }
    this._touch();
  }

  decrease(amount, { unit = this.unit, reason = "manual-decrease", context = null } = {}) {
    const { qty } = convertQty(Number(amount || 0), unit, this.unit);
    const used = this._consumeLots(qty); // also reduces this.quantity
    this._logUsage(-used, { reason, context });
    this._touch();
  }

  moveLocation(newLocation) {
    this.location = newLocation;
    this._touch();
  }

  tag(label) {
    const l = String(label || "").trim();
    if (l && !this.tags.includes(l)) this.tags.push(l);
    this._touch(false);
  }

  linkToTask(taskId) {
    if (!this.linkedTasks.includes(taskId)) this.linkedTasks.push(taskId);
    this._touch(false);
  }

  linkToRecipe(recipeId) {
    if (!this.linkedRecipes.includes(recipeId)) this.linkedRecipes.push(recipeId);
    this._touch(false);
  }

  /* ----------------------------- Reservations ----------------------------- */

  /**
   * Hold stock for a session.
   * context: { type: "cooking"|"cleaning"|"other", refId: string }
   */
  reserve(qty, { unit = this.unit, context } = {}) {
    const { qty: q } = convertQty(Number(qty || 0), unit, this.unit);
    if (q <= 0) return null;
    if (q > this.availableQty()) return null;

    const r = {
      id: `res-${UID()}`,
      qty: q,
      unit: this.unit,
      context: context || { type: "other", refId: null },
      status: "held",
      createdAt: new Date()
    };
    this.reservations.push(r);
    this._touch(false);
    return r;
  }

  releaseReservation(resId) {
    const r = this.reservations.find((x) => x.id === resId && x.status === "held");
    if (!r) return false;
    r.status = "released";
    r.releasedAt = new Date();
    this._touch(false);
    return true;
  }

  /**
   * Commit reservation → consume from lots (FEFO), reduce on-hand, log usage.
   */
  commitReservation(resId, { reason = "reservation-commit" } = {}) {
    const r = this.reservations.find((x) => x.id === resId && x.status === "held");
    if (!r) return false;
    const used = this._consumeLots(r.qty);
    r.status = "committed";
    r.committedAt = new Date();
    this._logUsage(-used, { reason, context: r.context });
    this._touch();
    return true;
  }

  /* ----------------------------- Calculations ------------------------------ */

  availableQty() {
    const held = this.reservations
      .filter((r) => r.status === "held")
      .reduce((acc, r) => acc + r.qty, 0);
    return Math.max(0, this.quantity - held);
  }

  earliestExpiry() {
    if (!this.lotTracking || !this.lots.length) return null;
    const valid = this.lots.filter((l) => l.qty > 0 && l.expiresAt);
    if (!valid.length) return null;
    return valid.sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt))[0].expiresAt;
    }

  shouldRestock() {
    // legacy threshold OR par min
    return this.availableQty() <= Math.max(this.threshold, this.minQty || 0);
  }

  /**
   * Moving-average daily burn rate (negative deltas in usageHistory).
   * windowDays default: 30 (use last 30 days).
   */
  burnRatePerDay(windowDays = 30) {
    if (!this.usageHistory.length) return 0;
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - windowDays);
    const window = this.usageHistory.filter((u) => new Date(u.at) >= cutoff);
    const used = window.reduce((acc, u) => acc + (u.delta < 0 ? -u.delta : 0), 0);
    return used / windowDays;
  }

  projectedRunoutDate({ windowDays = 30 } = {}) {
    const rate = this.burnRatePerDay(windowDays);
    const avail = this.availableQty();
    if (rate <= 0) return null;
    const days = avail / rate;
    const d = new Date(); d.setDate(d.getDate() + Math.ceil(days));
    return d;
  }

  /**
   * Reorder point based on lead time + safety stock:
   * ROP = (avgDailyUse * leadTimeDays) + safetyStock
   * Picks shortest vendor lead time if present.
   */
  reorderPoint({ windowDays = 30 } = {}) {
    const rate = this.burnRatePerDay(windowDays);
    const lead = (this.vendors.length
      ? Math.min(...this.vendors.map(v => Number(v.leadTimeDays || 0)))
      : 0);
    return Math.ceil(rate * lead + this.safetyStock);
  }

  /**
   * Get restock recommendation: target up to maxQty (or ROP + pack), with vendor pack suggestion.
   */
  getRestockRecommendation({ windowDays = 30 } = {}) {
    const avail = this.availableQty();
    const rop = this.reorderPoint({ windowDays });
    const target = this.maxQty != null ? this.maxQty : Math.max(rop, this.minQty || 0) + (this.safetyStock || 0);

    const need = Math.max(0, (target || 0) - avail);
    if (need <= 0) {
      return { recommendedQty: 0, unit: this.unit, reason: "at-or-above-target", vendor: null };
    }
    // pick best vendor pack (closest >= need)
    let vendor = null;
    if (this.vendors.length) {
      const candidates = this.vendors
        .map(v => ({ ...v, packUnit: normUnit(v.packUnit || this.unit) }))
        .map(v => {
          const { qty: packInBase } = convertQty(Number(v.packQty || 0), v.packUnit, this.unit);
          return { ...v, packInBase };
        })
        .filter(v => v.packInBase > 0)
        .sort((a, b) => a.packInBase - b.packInBase);

      vendor = candidates.find(v => v.packInBase >= need) || candidates.at(-1) || null;
    }

    let recommendedQty = need;
    if (vendor) {
      // round to vendor pack multiple
      const packs = Math.max(1, Math.ceil(need / vendor.packInBase));
      recommendedQty = packs * vendor.packInBase;
    }

    return {
      recommendedQty: Math.round(recommendedQty * 100) / 100,
      unit: this.unit,
      reason: need >= rop ? "below-rop" : "below-target",
      vendor
    };
  }

  /**
   * Low-inventory alert payload for dashboards.
   */
  makeLowInventoryAlert() {
    if (!this.shouldRestock()) return null;
    const rec = this.getRestockRecommendation({});
    return {
      id: `alert-${this.id}-${Date.now()}`,
      name: this.name,
      currentQty: Math.round(this.availableQty() * 100) / 100,
      unit: this.unit,
      minQty: this.minQty,
      rop: this.reorderPoint({}),
      recommendedOrderQty: rec.recommendedQty,
      vendor: rec.vendor ? { name: rec.vendor.name, sku: rec.vendor.sku, url: rec.vendor.url } : null,
      location: this.location,
      earliestExpiry: this.earliestExpiry(),
      autoRestock: this.autoRestock,
      substitutes: this.substitutes
    };
  }

  /* ----------------------------- Internal ops ------------------------------ */

  _consumeLots(qtyNeeded) {
    // reduce both quantity and lots using FEFO → FIFO
    let remaining = Math.max(0, qtyNeeded);
    if (!this.lotTracking || !this.lots.length) {
      const used = clamp(remaining, 0, this.quantity);
      this.quantity = Math.max(0, this.quantity - used);
      return used;
    }
    // FEFO: sort by earliest expiry then acquiredAt
    this.lots.sort((a, b) => {
      const ea = a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
      const eb = b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
      if (ea !== eb) return ea - eb;
      return new Date(a.acquiredAt) - new Date(b.acquiredAt);
    });

    let consumed = 0;
    for (const lot of this.lots) {
      if (remaining <= 0) break;
      if (lot.qty <= 0) continue;
      const take = Math.min(lot.qty, remaining);
      lot.qty -= take;
      remaining -= take;
      consumed += take;
    }
    this.quantity = Math.max(0, this.quantity - consumed);
    // prune empty lots
    this.lots = this.lots.filter(l => l.qty > 0.0001);
    return consumed;
  }

  _logUsage(delta, { reason = "", context = null } = {}) {
    if (!delta) return;
    this.usageHistory.push({ at: new Date(), delta: Number(delta), reason, context });
    if (this.usageHistory.length > 1000) this.usageHistory.shift();
  }

  _touch(updateTime = true) {
    if (updateTime) this.lastUpdated = new Date();
  }

  /* ------------------------------- Utilities ------------------------------- */

  addVendor(v) {
    const vendor = {
      id: v.id || `ven-${UID()}`,
      name: v.name || "",
      sku: v.sku || "",
      url: v.url || "",
      packQty: Number(v.packQty || 0),
      packUnit: normUnit(v.packUnit || this.unit),
      price: v.price != null ? Number(v.price) : null,
      leadTimeDays: Number(v.leadTimeDays || 0)
    };
    this.vendors.push(vendor);
    this._touch(false);
  }

  addLot({ qty, unit = this.unit, acquiredAt = new Date(), expiresAt = null, costPerUnit = null }) {
    const { qty: q } = convertQty(Number(qty || 0), unit, this.unit);
    this.increase(q, { unit: this.unit, lot: { acquiredAt, expiresAt }, costPerUnit });
  }

  /* -------------------------------- Validation ------------------------------- */

  validate() {
    const errors = [];
    if (!this.name || String(this.name).trim() === "") errors.push("Supply must have a name.");
    if (!this.unit || String(this.unit).trim() === "") errors.push("Supply must have a unit.");
    if (Number.isNaN(this.quantity)) errors.push("Quantity is invalid.");
    if (this.minQty < 0 || this.threshold < 0) errors.push("Min/threshold cannot be negative.");
    return errors;
  }

  /* -------------------------------- Serialization ---------------------------- */

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      category: this.category,
      subcategory: this.subcategory,
      unit: this.unit,
      quantity: this.quantity,
      threshold: this.threshold,
      minQty: this.minQty,
      maxQty: this.maxQty,
      safetyStock: this.safetyStock,
      location: this.location,
      locations: this.locations,
      tags: this.tags,
      linkedTasks: this.linkedTasks,
      linkedRecipes: this.linkedRecipes,
      substitutes: this.substitutes,
      makeVsBuy: this.makeVsBuy,
      autoRestock: this.autoRestock,
      vendors: this.vendors,
      lotTracking: this.lotTracking,
      lots: this.lots.map(l => ({
        ...l,
        acquiredAt: l.acquiredAt ? new Date(l.acquiredAt).toISOString() : null,
        expiresAt: l.expiresAt ? new Date(l.expiresAt).toISOString() : null
      })),
      perishable: this.perishable,
      defaultShelfLifeDays: this.defaultShelfLifeDays,
      usageHistory: this.usageHistory.map(u => ({ ...u, at: new Date(u.at).toISOString() })),
      reservations: this.reservations.map(r => ({ ...r, createdAt: new Date(r.createdAt).toISOString(), committedAt: r.committedAt || null, releasedAt: r.releasedAt || null })),
      lastUpdated: this.lastUpdated ? new Date(this.lastUpdated).toISOString() : null,
      notes: this.notes,
      sku: this.sku,
      barcode: this.barcode,
      costPerUnit: this.costPerUnit
    };
  }

  static from(obj = {}) {
    return new SupplyInventory({
      ...obj,
      lots: Array.isArray(obj.lots)
        ? obj.lots.map(l => ({
            ...l,
            acquiredAt: l.acquiredAt ? new Date(l.acquiredAt) : null,
            expiresAt: l.expiresAt ? new Date(l.expiresAt) : null
          }))
        : [],
      usageHistory: Array.isArray(obj.usageHistory)
        ? obj.usageHistory.map(u => ({ ...u, at: u.at ? new Date(u.at) : new Date() }))
        : [],
      reservations: Array.isArray(obj.reservations)
        ? obj.reservations.map(r => ({ ...r, createdAt: r.createdAt ? new Date(r.createdAt) : new Date() }))
        : [],
      lastUpdated: obj.lastUpdated ? new Date(obj.lastUpdated) : new Date()
    });
  }
}

export default SupplyInventory;
