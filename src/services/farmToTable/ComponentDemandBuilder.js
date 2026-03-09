// C:\Users\larho\suka-smart-assistant\src\services\farmToTable\ComponentDemandBuilder.js
/* eslint-disable no-console */
/**
 * SSA • Farm-to-Table / Homestead ComponentDemandBuilder
 * -----------------------------------------------------------------------------
 * Builds a time-phased component demand plan from provisioning targets, meal/cuisine
 * rhythms, and preservation goals; then maps demand to:
 *  - component catalog (CatalogLoader normalized bundle)
 *  - current inventory (storehouse / freezer / pantry)
 *  - garden/animal targets derivation (downstream)
 *  - preservation batches (downstream)
 *
 * Core output:
 *  {
 *    meta: { householdId, horizonDays, startISO, endISO, builtAtISO },
 *    rows: DemandRow[],              // time-phased demand by component
 *    totals: DemandTotals[],         // totals by component across horizon
 *    gaps: DemandGap[],              // required - available - planned
 *    actions: DemandActionPlan,      // suggested actions by domain
 *    indices: { byComponentId, byDayKey }
 *  }
 *
 * This is deterministic and explainable; NO AI.
 *
 * -----------------------------------------------------------------------------
 * Inputs (flexible; only needs what you have today)
 * -----------------------------------------------------------------------------
 * buildDemandPlan({
 *   householdId,
 *   startISO,
 *   horizonDays,
 *   targets,           // provisioning targets (your targets.jsx output)
 *   schedule,          // optional schedule/rhythm plan (days, feast windows)
 *   cuisineContext,    // output of CuisineResolver + PreferenceResolver (optional)
 *   catalogBundle,     // output of CatalogLoader.loadCatalog()
 *   inventorySnapshot, // optional: { items: [{ componentId, qty, unit, location, expiresAtISO? }], asOfISO }
 *   plannedBatches,    // optional: { batches: [{ id, produces: [{ componentId, qty, unit }], readyAtISO }] }
 *   unitRules,         // optional conversions
 *   options
 * })
 *
 * Targets input shape (recommended):
 *  {
 *    provisioning: [
 *      { componentId, name?, qty, unit, cadence: "daily|weekly|monthly|once", notes?, startISO?, endISO? }
 *    ],
 *    preservation: [
 *      { componentId, qty, unit, byISO?, seasonKey?, priority? }
 *    ]
 *  }
 *
 * Notes:
 *  - If componentId is missing but name provided, we attempt fuzzy match with catalog name.
 *  - Units are treated as strings; conversions are optional/simple.
 */

const SOURCE = "services/farmToTable/ComponentDemandBuilder";

const DEFAULTS = {
  horizonDays: 28,
  // How to spread weekly/monthly cadence across days
  cadence: {
    weeklySpread: "even", // even | frontload | backload
    monthlySpread: "even",
  },
  // Consider inventory expiring before need date as unavailable
  expiry: {
    enforceExpiry: true,
    // days before expiry to treat as "not reliable"
    bufferDays: 0,
  },
  // Gaps action thresholds
  actionThresholds: {
    // if gap qty >= this, suggest action
    minGapQty: 0.000001,
  },
  // Dependency expansion:
  // If a component has inputs, we can optionally "explode" demand into inputs
  // using defaults.yieldRatio when provided (input->output).
  explode: {
    enabled: true,
    maxDepth: 4,
  },
  // Unit conversion (very simple)
  units: {
    // default unit normalization: lowercase
    normalize: true,
  },
};

export const ComponentDemandBuilder = {
  buildDemandPlan,
  expandCadenceToDaily,
  explodeDemandToInputs,
  indexInventory,
  indexPlannedBatches,
};

/* -----------------------------------------------------------------------------
 * Main
 * --------------------------------------------------------------------------- */

export function buildDemandPlan(input = {}) {
  const opts = { ...DEFAULTS, ...(input.options || {}) };
  opts.cadence = { ...DEFAULTS.cadence, ...(opts.cadence || {}) };
  opts.expiry = { ...DEFAULTS.expiry, ...(opts.expiry || {}) };
  opts.actionThresholds = {
    ...DEFAULTS.actionThresholds,
    ...(opts.actionThresholds || {}),
  };
  opts.explode = { ...DEFAULTS.explode, ...(opts.explode || {}) };
  opts.units = { ...DEFAULTS.units, ...(opts.units || {}) };

  const householdId = safeStr(input.householdId || "primary");
  const startISO = input.startISO || new Date().toISOString();
  const horizonDays = Number.isFinite(input.horizonDays)
    ? input.horizonDays
    : opts.horizonDays;

  const start = toDate(startISO);
  const end = new Date(start.getTime() + horizonDays * 86400000);

  const catalog = input.catalogBundle || { components: [], methods: [] };
  const componentsById = new Map(
    (catalog.components || []).map((c) => [toLower(c.id), c])
  );
  const componentsByName = new Map(
    (catalog.components || []).map((c) => [toLower(c.name), c])
  );

  const targets = input.targets || {};
  const provisioningTargets = Array.isArray(targets.provisioning)
    ? targets.provisioning
    : [];
  const preservationTargets = Array.isArray(targets.preservation)
    ? targets.preservation
    : [];

  // 1) Expand provisioning targets into per-day demands
  const dailyRows = [];
  for (const t of provisioningTargets) {
    const expanded = expandCadenceToDaily(
      t,
      start,
      end,
      opts,
      componentsById,
      componentsByName
    );
    for (const r of expanded) dailyRows.push(r);
  }

  // 2) Add preservation targets as one-time demands (or byISO)
  for (const pt of preservationTargets) {
    const pr = normalizeTarget(pt, componentsById, componentsByName);
    if (!pr.componentId) continue;
    const when = pt.byISO ? toDate(pt.byISO) : end; // default end-of-horizon
    const dayKey = ymd(when);
    dailyRows.push({
      dayKey,
      dateISO: new Date(
        Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate())
      ).toISOString(),
      componentId: pr.componentId,
      componentName: pr.componentName,
      qty: pr.qty,
      unit: pr.unit,
      kind: "preservation",
      source: "target.preservation",
      notes: safeStr(pt.notes),
      trace: { raw: pt },
    });
  }

  // 3) Optional explode into inputs (component dependencies)
  const explodedRows = opts.explode.enabled
    ? explodeDemandToInputs(dailyRows, catalog, opts)
    : dailyRows.slice();

  // 4) Aggregate totals across horizon
  const totals = aggregateTotals(explodedRows, componentsById);

  // 5) Index inventory + planned batches
  const invIndex = indexInventory(input.inventorySnapshot, opts);
  const batchIndex = indexPlannedBatches(input.plannedBatches, opts);

  // 6) Compute gaps per component (total required vs available + planned)
  const gaps = computeGaps(totals, invIndex, batchIndex, start, end, opts);

  // 7) Produce action plan
  const actions = buildActions(gaps, componentsById, opts);

  // 8) Indices for UI
  const indices = {
    byComponentId: indexByComponentId(explodedRows),
    byDayKey: indexByDayKey(explodedRows),
  };

  return {
    meta: {
      householdId,
      horizonDays,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      builtAtISO: new Date().toISOString(),
      source: SOURCE,
    },
    rows: explodedRows,
    totals,
    gaps,
    actions,
    indices,
  };
}

/* -----------------------------------------------------------------------------
 * Target expansion
 * --------------------------------------------------------------------------- */

/**
 * Expand a provisioning target into daily rows for [start, end).
 * Supported cadence:
 *  - daily: qty per day
 *  - weekly: qty per week (spread)
 *  - monthly: qty per month (spread)
 *  - once: qty one-time at start (or target.startISO)
 */
export function expandCadenceToDaily(target, start, end, opts, byId, byName) {
  const t = normalizeTarget(target, byId, byName);
  if (!t.componentId || !Number.isFinite(t.qty) || t.qty <= 0) return [];

  const cadence = toLower(target.cadence || "weekly");
  const rows = [];

  const windowStart = target.startISO
    ? maxDate(start, toDate(target.startISO))
    : start;
  const windowEnd = target.endISO ? minDate(end, toDate(target.endISO)) : end;
  if (windowEnd <= windowStart) return rows;

  if (cadence === "daily") {
    // qty each day
    for (let d = new Date(windowStart); d < windowEnd; d = addDays(d, 1)) {
      rows.push(makeRow(d, t, target, "provisioning", "target.daily"));
    }
    return rows;
  }

  if (cadence === "once") {
    const when = target.byISO ? toDate(target.byISO) : windowStart;
    if (when >= windowStart && when < windowEnd) {
      rows.push(makeRow(when, t, target, "provisioning", "target.once"));
    }
    return rows;
  }

  if (cadence === "monthly") {
    // Spread across each month in horizon
    let cursor = new Date(
      Date.UTC(windowStart.getUTCFullYear(), windowStart.getUTCMonth(), 1)
    );
    while (cursor < windowEnd) {
      const monthStart = cursor;
      const monthEnd = new Date(
        Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1)
      );
      const a = maxDate(monthStart, windowStart);
      const b = minDate(monthEnd, windowEnd);
      const days = Math.max(1, daysBetween(a, b));
      const perDay = t.qty / days;

      for (let d = new Date(a); d < b; d = addDays(d, 1)) {
        rows.push(
          makeRow(
            d,
            { ...t, qty: perDay },
            target,
            "provisioning",
            "target.monthly"
          )
        );
      }
      cursor = monthEnd;
    }
    return rows;
  }

  // weekly default
  // Spread across each week in horizon, aligned to UTC weeks (Sun-Sat)
  let cursor = startOfWeekUTC(windowStart, 0);
  while (cursor < windowEnd) {
    const weekStart = cursor;
    const weekEnd = addDays(weekStart, 7);
    const a = maxDate(weekStart, windowStart);
    const b = minDate(weekEnd, windowEnd);
    const days = Math.max(1, daysBetween(a, b));

    const perDay = t.qty / days;

    for (let d = new Date(a); d < b; d = addDays(d, 1)) {
      rows.push(
        makeRow(
          d,
          { ...t, qty: perDay },
          target,
          "provisioning",
          "target.weekly"
        )
      );
    }
    cursor = weekEnd;
  }

  return rows;
}

function makeRow(date, normTarget, rawTarget, kind, source) {
  const d0 = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  return {
    dayKey: ymd(d0),
    dateISO: d0.toISOString(),
    componentId: normTarget.componentId,
    componentName: normTarget.componentName,
    qty: normTarget.qty,
    unit: normTarget.unit,
    kind, // provisioning | preservation | exploded
    source,
    notes: safeStr(rawTarget.notes),
    trace: { raw: rawTarget },
  };
}

function normalizeTarget(target, byId, byName) {
  const name = safeStr(target?.name);
  const id = safeStr(target?.componentId || target?.id);

  let comp = null;
  if (id) comp = byId.get(toLower(id)) || null;
  if (!comp && name) comp = byName.get(toLower(name)) || null;

  // Fuzzy name match fallback
  if (!comp && name && byName.size) {
    comp = fuzzyFindByName(name, byName);
  }

  const unit = normalizeUnit(target?.unit || comp?.defaults?.unit || "unit");
  const qty = toNum(target?.qty, NaN);

  return {
    componentId: comp ? comp.id : id || "",
    componentName: comp ? comp.name : name || id || "",
    qty,
    unit,
    _component: comp || null,
  };
}

/* -----------------------------------------------------------------------------
 * Dependency explosion
 * --------------------------------------------------------------------------- */

/**
 * Explode demand rows into input components where catalog defines inputs.
 *
 * For each demand row for component C, if C.inputs includes components A,B...
 * then add rows for A and B, scaled by yieldRatio if available.
 *
 * Scaling rule:
 *  - If C.defaults.yieldRatio is provided, interpret as output per unit input.
 *    To get required input = required output / yieldRatio.
 *  - If no yieldRatio, use 1:1.
 *
 * This is intentionally simple; your future MethodMap can replace it.
 */
export function explodeDemandToInputs(rows, catalogBundle, opts) {
  const byId = new Map(
    (catalogBundle?.components || []).map((c) => [toLower(c.id), c])
  );
  const out = [];
  const maxDepth = clampInt(opts.explode.maxDepth, 0, 10);

  for (const r of rows || []) {
    out.push(r);
    explodeRow(r, 1, maxDepth, byId, out);
  }
  return out;
}

function explodeRow(row, depth, maxDepth, byId, out) {
  if (depth > maxDepth) return;

  const comp = byId.get(toLower(row.componentId));
  const inputs = normalizeStringArray(comp?.inputs);
  if (!inputs.length) return;

  const yieldRatio = toNum(comp?.defaults?.yieldRatio, 1);
  const scale = yieldRatio && yieldRatio > 0 ? 1 / yieldRatio : 1;

  for (const inputId of inputs) {
    const inputComp = byId.get(toLower(inputId));
    const inputUnit = normalizeUnit(inputComp?.defaults?.unit || row.unit);

    const exploded = {
      ...row,
      componentId: inputComp ? inputComp.id : inputId,
      componentName: inputComp ? inputComp.name : inputId,
      qty: row.qty * scale,
      unit: inputUnit,
      kind: "exploded",
      source: `${row.source}:explode`,
      trace: {
        ...row.trace,
        explodedFrom: row.componentId,
        depth,
        yieldRatio: yieldRatio,
      },
    };

    out.push(exploded);
    explodeRow(exploded, depth + 1, maxDepth, byId, out);
  }
}

/* -----------------------------------------------------------------------------
 * Aggregation + indices
 * --------------------------------------------------------------------------- */

function aggregateTotals(rows, byId) {
  // totals keyed by componentId+unit (unit-aware)
  const map = new Map();

  for (const r of rows || []) {
    const cid = safeStr(r.componentId);
    if (!cid) continue;
    const unit = normalizeUnit(r.unit || "unit");
    const key = `${toLower(cid)}|${unit}`;
    const prev = map.get(key) || {
      componentId: cid,
      componentName: r.componentName || byId.get(toLower(cid))?.name || cid,
      unit,
      requiredQty: 0,
      breakdown: { provisioning: 0, preservation: 0, exploded: 0 },
      byKind: {},
      sources: {},
    };

    const q = toNum(r.qty, 0);
    prev.requiredQty += q;

    const kind = r.kind || "unknown";
    prev.byKind[kind] = (prev.byKind[kind] || 0) + q;
    if (kind === "provisioning") prev.breakdown.provisioning += q;
    else if (kind === "preservation") prev.breakdown.preservation += q;
    else if (kind === "exploded") prev.breakdown.exploded += q;

    const src = safeStr(r.source);
    if (src) prev.sources[src] = (prev.sources[src] || 0) + q;

    map.set(key, prev);
  }

  const out = Array.from(map.values());
  out.sort((a, b) => b.requiredQty - a.requiredQty);
  return out;
}

function indexByComponentId(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const k = toLower(r.componentId);
    if (!k) continue;
    const arr = map.get(k) || [];
    arr.push(r);
    map.set(k, arr);
  }
  return map;
}

function indexByDayKey(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const k = safeStr(r.dayKey);
    if (!k) continue;
    const arr = map.get(k) || [];
    arr.push(r);
    map.set(k, arr);
  }
  return map;
}

/* -----------------------------------------------------------------------------
 * Inventory / planned batch indices
 * --------------------------------------------------------------------------- */

/**
 * inventorySnapshot:
 *  { asOfISO, items: [{ componentId, qty, unit, location, expiresAtISO? }] }
 */
export function indexInventory(inventorySnapshot, opts) {
  const items = Array.isArray(inventorySnapshot?.items)
    ? inventorySnapshot.items
    : [];
  const asOf = inventorySnapshot?.asOfISO
    ? toDate(inventorySnapshot.asOfISO)
    : new Date();

  const byKey = new Map();
  for (const it of items) {
    const cid = safeStr(it.componentId || it.id);
    if (!cid) continue;

    const unit = normalizeUnit(it.unit || "unit");
    const key = `${toLower(cid)}|${unit}`;

    const prev = byKey.get(key) || {
      componentId: cid,
      unit,
      totalQty: 0,
      lots: [],
    };

    const qty = toNum(it.qty, 0);
    const expiresAt = it.expiresAtISO ? toDate(it.expiresAtISO) : null;
    prev.totalQty += qty;
    prev.lots.push({
      qty,
      unit,
      location: safeStr(it.location),
      expiresAtISO: expiresAt ? expiresAt.toISOString() : null,
    });

    byKey.set(key, prev);
  }

  return { asOfISO: asOf.toISOString(), byKey };
}

/**
 * plannedBatches:
 *  { batches: [{ id, readyAtISO, produces: [{ componentId, qty, unit }] }] }
 */
export function indexPlannedBatches(plannedBatches, opts) {
  const batches = Array.isArray(plannedBatches?.batches)
    ? plannedBatches.batches
    : [];
  const byKey = new Map();

  for (const b of batches) {
    const readyAt = b.readyAtISO ? toDate(b.readyAtISO) : null;
    const produces = Array.isArray(b.produces) ? b.produces : [];

    for (const p of produces) {
      const cid = safeStr(p.componentId || p.id);
      if (!cid) continue;
      const unit = normalizeUnit(p.unit || "unit");
      const key = `${toLower(cid)}|${unit}`;

      const prev = byKey.get(key) || {
        componentId: cid,
        unit,
        totalPlannedQty: 0,
        batches: [],
      };

      const qty = toNum(p.qty, 0);
      prev.totalPlannedQty += qty;
      prev.batches.push({
        batchId: safeStr(b.id),
        qty,
        unit,
        readyAtISO: readyAt ? readyAt.toISOString() : null,
      });

      byKey.set(key, prev);
    }
  }

  return { byKey };
}

/* -----------------------------------------------------------------------------
 * Gaps + actions
 * --------------------------------------------------------------------------- */

function computeGaps(totals, invIndex, batchIndex, start, end, opts) {
  const gaps = [];

  for (const t of totals || []) {
    const key = `${toLower(t.componentId)}|${normalizeUnit(t.unit)}`;

    const inv = invIndex?.byKey?.get(key);
    const planned = batchIndex?.byKey?.get(key);

    const availableQty = inv ? computeAvailableQty(inv, start, end, opts) : 0;
    const plannedQty = planned ? toNum(planned.totalPlannedQty, 0) : 0;

    const required = toNum(t.requiredQty, 0);
    const gap = required - availableQty - plannedQty;

    gaps.push({
      componentId: t.componentId,
      componentName: t.componentName,
      unit: t.unit,
      requiredQty: required,
      availableQty,
      plannedQty,
      gapQty: gap,
      status: gap > opts.actionThresholds.minGapQty ? "gap" : "ok",
      detail: {
        inventoryLots: inv?.lots || [],
        plannedBatches: planned?.batches || [],
        breakdown: t.breakdown,
        sources: t.sources,
      },
    });
  }

  // Sort largest gaps first
  gaps.sort((a, b) => (b.gapQty || 0) - (a.gapQty || 0));
  return gaps;
}

function computeAvailableQty(invEntry, start, end, opts) {
  if (!invEntry) return 0;

  if (!opts.expiry.enforceExpiry) return toNum(invEntry.totalQty, 0);

  const bufferDays = clampInt(opts.expiry.bufferDays, 0, 365);
  const bufferMs = bufferDays * 86400000;

  let okQty = 0;
  for (const lot of invEntry.lots || []) {
    const qty = toNum(lot.qty, 0);
    const exp = lot.expiresAtISO ? toDate(lot.expiresAtISO) : null;

    // If no expiry, treat as available
    if (!exp) {
      okQty += qty;
      continue;
    }

    // If expires before end-of-horizon (with buffer), treat as not reliably available
    if (exp.getTime() < end.getTime() + bufferMs) {
      // Still might be usable early; for now we keep strict: not available
      // Future: allocate lots to earliest demand dates
      continue;
    }

    okQty += qty;
  }

  return okQty;
}

function buildActions(gaps, componentsById, opts) {
  const actions = {
    storehouse: [],
    preservation: [],
    garden: [],
    animals: [],
    shopping: [],
  };

  for (const g of gaps || []) {
    if (g.status !== "gap") continue;

    const comp = componentsById.get(toLower(g.componentId));
    const tags = normalizeStringArray(comp?.tags).map(toLower);

    // Heuristics for routing actions:
    // - If component is tagged "produce"/"vegetable"/"fruit"/"herb" -> garden
    // - If tagged "meat"/"dairy"/"eggs" -> animals
    // - If component has preservationMethods -> preservation
    // - Otherwise -> shopping/storehouse
    const isGarden = tags.some((t) =>
      ["produce", "vegetable", "fruit", "herb", "grain", "legume"].includes(t)
    );
    const isAnimal = tags.some((t) =>
      ["meat", "dairy", "eggs", "fish", "poultry"].includes(t)
    );
    const hasPres =
      Array.isArray(comp?.preservationMethods) &&
      comp.preservationMethods.length;

    const entry = {
      componentId: g.componentId,
      componentName: g.componentName,
      unit: g.unit,
      gapQty: g.gapQty,
      suggested: [],
      rationale: [],
    };

    if (hasPres) {
      entry.suggested.push({
        type: "start_preservation_batch",
        methods: comp.preservationMethods.slice(0, 5),
        qty: g.gapQty,
        unit: g.unit,
      });
      entry.rationale.push(
        "Catalog indicates this component can be produced via preservation methods."
      );
      actions.preservation.push(entry);
      continue;
    }

    if (isGarden) {
      entry.suggested.push({
        type: "derive_garden_targets",
        qty: g.gapQty,
        unit: g.unit,
      });
      entry.rationale.push(
        "Component tagged as plant-based; suggest garden targets."
      );
      actions.garden.push(entry);
      continue;
    }

    if (isAnimal) {
      entry.suggested.push({
        type: "derive_animal_targets",
        qty: g.gapQty,
        unit: g.unit,
      });
      entry.rationale.push(
        "Component tagged as animal-based; suggest animal/breeding/purchase targets."
      );
      actions.animals.push(entry);
      continue;
    }

    // Default: buy or stock
    entry.suggested.push({
      type: "add_to_shopping",
      qty: g.gapQty,
      unit: g.unit,
    });
    entry.rationale.push(
      "No preservation/garden/animal route detected; default to shopping/storehouse replenishment."
    );
    actions.shopping.push(entry);

    // also storehouse note
    actions.storehouse.push({
      componentId: g.componentId,
      componentName: g.componentName,
      unit: g.unit,
      gapQty: g.gapQty,
      suggested: [
        { type: "set_storehouse_target", qty: g.gapQty, unit: g.unit },
      ],
      rationale: ["Stock this component to meet horizon demand."],
    });
  }

  return actions;
}

/* -----------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------------- */

function fuzzyFindByName(name, byName) {
  const needle = toLower(name);
  if (!needle) return null;

  // Simple contains match on names in the map
  for (const [k, comp] of byName.entries()) {
    if (k === needle) return comp;
  }
  for (const [k, comp] of byName.entries()) {
    if (k.includes(needle) || needle.includes(k)) return comp;
  }
  return null;
}

function normalizeUnit(unit) {
  const u = safeStr(unit || "unit");
  return DEFAULTS.units.normalize ? u.toLowerCase() : u;
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeStr(x) {
  return (x == null ? "" : String(x)).trim();
}

function toLower(s) {
  return (typeof s === "string" ? s : s == null ? "" : String(s))
    .trim()
    .toLowerCase();
}

function normalizeStringArray(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((x) => safeStr(x)).filter(Boolean);
}

function uniqLower(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const k = toLower(x);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function toDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function addDays(d, days) {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function daysBetween(a, b) {
  const ms = b.getTime() - a.getTime();
  return Math.max(0, Math.round(ms / 86400000));
}

function ymd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

function startOfWeekUTC(d, weekStartDow) {
  const dt = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
  const dow = dt.getUTCDay();
  let diff = dow - weekStartDow;
  if (diff < 0) diff += 7;
  dt.setUTCDate(dt.getUTCDate() - diff);
  return dt;
}

function maxDate(a, b) {
  return a.getTime() >= b.getTime() ? a : b;
}
function minDate(a, b) {
  return a.getTime() <= b.getTime() ? a : b;
}

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
