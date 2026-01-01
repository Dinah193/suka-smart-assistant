/* eslint-disable no-console */
// src/automation/handlers/onGroceryListRequested.js
//
// onGroceryListRequested — build grocery list; mark shortages; propose subs; estimate cost
// Shared orchestration aligned with garden/animal/cleaning vocab normalizations.
//
// Engines (optional; DI):
// - scheduleStore.getAssignmentsInRange(start, end)
// - recipesStore.getByIds(ids)
// - recipeNormalizer.normalizeAll(ingredients)                  -> canonical names/units/forms/brands
// - unitConverter.toBase({ qty, unit, name })                   -> comparable baseQty
// - inventoryStore.getPantrySnapshot()
// - gardenStore.getProjectedHarvest(start, end)                 -> { items: [{name, qty, unit, form?, brand?}] }
// - animalStore.getProjectedButchery(start, end)                -> same shape as harvest
// - substitutionEngine.findAlternates(line, ctx)                -> [{name, reason, delta}] (max 4 kept)
// - aisleTaxonomy.map(name, { storeId })                        -> "Aisle > SubAisle" string
// - estimateEngine.estimateLines(lines, { supplierProfiles, storeId })
//       returns { total, currency, lines:[{id,key,unitPrice,packSizeQty,packUnit,storeId?}] }
// - supplierStore.getSupplierProfiles(), getDefaultStoreId()
// - grocerySync.export(list, { format })                        -> optional exporter (CSV/Sheets/etc.)
//
// Emits:
// - "grocery.list.generated" { list, summary, meta, partitions? }
// - "nba.suggest" with actionable Next Best Actions
//
// UI options supported (GroceryListPanel.jsx, etc.):
// - includeHave            (default: false)
// - collapseDuplicates     (default: true)
// - allowSubstitutions     (default: true)
// - aisleGroups            (default: true)
// - storeId                (default: supplierStore.getDefaultStoreId())
// - preferGarden           (default: true)
// - preferAnimal           (default: true)
// - preferBulk             (default: true)
// - multiStoreOptimize     (default: true) uses estimateEngine.storeId per line when present
// - budgetCap              (number; optional)
// - exportFormat           ("csv" | "sheets" | "none"; optional)

export async function onGroceryListRequested(payload = {}, deps = {}) {
  const {
    bus,
    engines = {},
    stores = {},
    helpers = {},
    log = defaultLog,
  } = deps;

  const {
    recipeNormalizer,
    unitConverter,
    substitutionEngine,
    aisleTaxonomy,
    estimateEngine,
  } = engines;

  const {
    scheduleStore,
    recipesStore,
    inventoryStore,
    gardenStore,
    animalStore,
    supplierStore,
    userStore,
  } = stores;

  const {
    time = timeUtilFallback,
    uuid = uuidFallback,
  } = helpers;

  try {
    // 1) Resolve inputs ------------------------------------------------------
    const tz = payload.timezone ?? userStore?.getTimezone?.() ?? "America/New_York";
    const start = time.coerceDate(payload.startDate) || time.startOfWeek(new Date(), tz);
    const end = time.coerceDate(payload.endDate) || time.addDays(start, 6);

    const options = {
      collapseDuplicates: payload?.options?.collapseDuplicates ?? true,
      allowSubstitutions: payload?.options?.allowSubstitutions ?? true,
      aisleGroups: payload?.options?.aisleGroups ?? true,
      includeHave: payload?.options?.includeHave ?? false,
      includeHousehold: payload?.options?.includeHousehold ?? true,
      preferGarden: payload?.options?.preferGarden ?? true,
      preferAnimal: payload?.options?.preferAnimal ?? true,
      preferBulk: payload?.options?.preferBulk ?? true,
      storeId: payload?.options?.storeId ?? supplierStore?.getDefaultStoreId?.(),
      multiStoreOptimize: payload?.options?.multiStoreOptimize ?? true,
      budgetCap: payload?.options?.budgetCap,
      exportFormat: payload?.options?.exportFormat ?? "none"
    };

    const ctx = {
      tz, start, end, options,
      constraints: payload?.constraints || {},
      user: userStore?.getProfile?.() || {},
      stores, engines, helpers
    };

    // 2) Pull planned recipes/assignments -----------------------------------
    let assignments = [];
    if (payload.recipeIds?.length && recipesStore?.getByIds) {
      const picked = await recipesStore.getByIds(payload.recipeIds);
      assignments = (picked || []).map((r, i) => ({
        slotId: `adhoc-${i}`,
        slotTime: start.toISOString(),
        recipe: r,
      }));
    } else if (scheduleStore?.getAssignmentsInRange) {
      assignments = await scheduleStore.getAssignmentsInRange(start, end).catch(e => {
        log("scheduleStore.getAssignmentsInRange error", e);
        return [];
      });
    }

    const rawLines = collectIngredientsFrom(assignments);

    // 3) Normalize (names/units/forms) --------------------------------------
    const normalizedLines = recipeNormalizer?.normalizeAll
      ? await recipeNormalizer.normalizeAll(rawLines, ctx).catch(e => { log("normalizeAll error", e); return rawLines; })
      : rawLines;

    // 4) Aggregate (merge dupes via base units) ------------------------------
    // Keying is tolerant (name|form|brand|unit); baseQty allows cross-unit math.
    const keyed = normalizeAndKey(normalizedLines);
    const aggregated = aggregateLines(keyed, unitConverter);

    // 5) Apply inventory snapshot (HAVE/PARTIAL/SHORT) -----------------------
    const pantry = (await inventoryStore?.getPantrySnapshot?.()) || { items: [] };
    const afterPantry = applyInventory(aggregated, pantry, unitConverter);

    // 6) Prefer homestead sources (garden/animal) first ----------------------
    let homesteadStage = afterPantry;
    if (options.preferGarden && gardenStore?.getProjectedHarvest) {
      const harvest = await gardenStore.getProjectedHarvest(start, end).catch(e => { log("garden harvest error", e); return { items: [] }; });
      homesteadStage = applyHomestead(homesteadStage, harvest, unitConverter, "garden");
    }
    if (options.preferAnimal && animalStore?.getProjectedButchery) {
      const butchery = await animalStore.getProjectedButchery(start, end).catch(e => { log("animal butchery error", e); return { items: [] }; });
      homesteadStage = applyHomestead(homesteadStage, butchery, unitConverter, "animal");
    }

    // 7) Propose substitutions (optional) -----------------------------------
    let withSubs = homesteadStage;
    if (options.allowSubstitutions && substitutionEngine?.findAlternates) {
      withSubs = await Promise.all(homesteadStage.map(async (line) => {
        try {
          const alts = await substitutionEngine.findAlternates(line, ctx);
          return { ...line, substitutions: (alts || []).slice(0, 4) };
        } catch (e) {
          log("substitutionEngine error", e);
          return line;
        }
      }));
    }

    // 8) Aisle grouping + store targeting -----------------------------------
    const baseStoreId = options.storeId;
    let grouped = withSubs.map(l => ({ ...l, aisle: "General" }));
    if (options.aisleGroups && aisleTaxonomy?.map) {
      grouped = withSubs.map(l => ({
        ...l,
        aisle: aisleTaxonomy.map(l.name, { storeId: baseStoreId }) || guessAisle(l),
      }));
    }

    // 9) Estimate, pack rounding, and (optional) multi-store partition -------
    let estimate = { total: 0, currency: "USD", lines: [] };
    let byStore = null;

    if (estimateEngine?.estimateLines) {
      const supplierProfiles = await supplierStore?.getSupplierProfiles?.();
      estimate = await estimateEngine
        .estimateLines(grouped, { ...ctx, supplierProfiles, storeId: baseStoreId })
        .catch(e => { log("estimateEngine error", e); return estimate; });
    }

    // Attach estimate hints back to lines by key, and round to pack sizes.
    const estIndex = new Map((estimate.lines ?? []).map(el => [el.key, el]));
    let estimatedLines = grouped.map(l => attachEstimate(l, estIndex));
    estimatedLines = applyPackRounding(estimatedLines); // adds .packsNeeded/.roundedNeedQty when packSize present

    // Multi-store: if estimate returns per-line storeId and option enabled.
    if (options.multiStoreOptimize) {
      byStore = partitionByStore(estimatedLines);
    }

    // 10) Final visibility + sorting ----------------------------------------
    const visible = finalizeVisibility(estimatedLines, { includeHave: options.includeHave, collapseDuplicates: options.collapseDuplicates });
    const sorted = sortForStoreWalk(visible);

    // 11) Budget heads-up (soft) --------------------------------------------
    let budget = null;
    if (options.budgetCap != null && Number.isFinite(options.budgetCap)) {
      const estTotal = estimate?.total ?? 0;
      budget = buildBudgetNotice(estTotal, options.budgetCap);
    }

    // 12) Summaries & meta ---------------------------------------------------
    const summary = buildSummary(sorted, estimate);
    const meta = {
      id: uuid(),
      range: { start: start.toISOString(), end: end.toISOString(), tz },
      storeId: baseStoreId,
      generatedAt: new Date().toISOString(),
      generator: "onGroceryListRequested.v2",
      options
    };

    // 13) NBA suggestions ----------------------------------------------------
    const actions = buildNba(sorted, ctx, summary, { budget });

    // 14) Export (optional) --------------------------------------------------
    if ((payload?.options?.exportFormat ?? "none") !== "none") {
      await safeExport(deps, sorted, payload.options.exportFormat, meta).catch(e => log("grocerySync.export error", e));
    }

    // 15) Emit & return ------------------------------------------------------
    const outPayload = { list: sorted, summary, meta };
    if (byStore) outPayload.partitions = byStore;
    safePublish(bus, "grocery.list.generated", outPayload);
    if (actions.length) {
      safePublish(bus, "nba.suggest", {
        scope: "grocery",
        relatedId: meta.id,
        actions,
        priority: "high",
      });
    }

    return outPayload;
  } catch (err) {
    log("onGroceryListRequested fatal error", err);
    safePublish(bus, "grocery.list.failed", { error: serializeError(err), payload });
    return {
      list: [],
      summary: { lines: 0, shortLines: 0, estimatedTotal: 0, currency: "USD" },
      meta: { error: true, message: "Grocery generation failed" },
    };
  }
}

// ----------------------------- helpers --------------------------------------

function collectIngredientsFrom(assignments = []) {
  const lines = [];
  for (const a of assignments) {
    const ings = a?.recipe?.ingredients || [];
    for (const ing of ings) {
      const name = (ing.name || ing.item || "").trim().toLowerCase();
      if (!name) continue;
      lines.push({
        // core
        name,
        qty: toNum(ing.qty ?? ing.quantity ?? 1),
        unit: (ing.unit || "").toLowerCase() || null,
        form: ing.form || null,    // e.g., chopped, ground
        brand: ing.brand || null,
        notes: ing.notes || "",
        // provenance
        source: "plan",
        recipeId: a?.recipe?.id,
        slotId: a?.slotId,
      });
    }
  }
  return lines;
}

function normalizeAndKey(lines = []) {
  return lines.map((l, i) => {
    const key = [l.name, l.form || "", l.brand || "", l.unit || ""].join("|");
    return { ...l, key, id: l.id || `ln-${i}` };
  });
}

function aggregateLines(keyed = [], unitConverter) {
  const map = new Map();
  for (const l of keyed) {
    const base = toBaseSafe(l, unitConverter);
    const addBase = base.baseQty ?? (l.qty ?? 0);
    const prev = map.get(l.key);
    if (prev) {
      const prevQty = prev.qty ?? 0;
      const prevBase = prev.baseQty ?? 0;
      map.set(l.key, {
        ...prev,
        qty: prevQty + (l.qty ?? 0),
        baseQty: prevBase + addBase,
      });
    } else {
      map.set(l.key, { ...l, baseQty: base.baseQty ?? (l.qty ?? 0) });
    }
  }
  return Array.from(map.values());
}

function applyInventory(lines = [], pantry = { items: [] }, unitConverter) {
  const haveMap = new Map();
  for (const p of pantry.items || []) {
    const name = (p.name || "").toLowerCase();
    if (!name) continue;
    const key = [name, p.form || "", p.brand || "", (p.unit || "").toLowerCase()].join("|");
    const base = toBaseSafe({ name, qty: p.qty, unit: p.unit }, unitConverter);
    const prev = haveMap.get(key);
    haveMap.set(key, (prev || 0) + (base.baseQty ?? (p.qty ?? 0)));
  }

  return lines.map(l => {
    const haveBase = haveMap.get(l.key) || 0;
    const target = l.baseQty || l.qty || 0;
    const needBase = Math.max(0, target - haveBase);
    const status = needBase === 0 ? "have" : (haveBase > 0 ? "partial" : "short");
    const badges = status === "have" ? ["HAVE"] : status === "partial" ? ["PARTIAL"] : ["SHORT"];
    return { ...l, haveBaseQty: haveBase, needBaseQty: needBase, status, badges };
  });
}

function applyHomestead(lines = [], supply = { items: [] }, unitConverter, tag = "garden") {
  const supplyMap = new Map();
  for (const s of supply.items || []) {
    const key = [(s.name || "").toLowerCase(), s.form || "", s.brand || "", (s.unit || "").toLowerCase()].join("|");
    const base = toBaseSafe({ name: s.name, qty: s.qty, unit: s.unit }, unitConverter);
    const prev = supplyMap.get(key);
    supplyMap.set(key, (prev || 0) + (base.baseQty ?? (s.qty ?? 0)));
  }

  return lines.map(l => {
    const avail = supplyMap.get(l.key) || 0;
    if (!avail) return l;
    const priorNeed = l.needBaseQty ?? (l.baseQty || l.qty || 0);
    const remaining = Math.max(0, priorNeed - avail);
    const satisfied = remaining === 0;
    const badges = new Set(l.badges || []);
    badges.add(satisfied ? `FULFILLED_BY_${tag.toUpperCase()}` : `PARTIAL_${tag.toUpperCase()}`);

    return {
      ...l,
      needBaseQty: remaining,
      status: satisfied ? "have" : (l.status === "have" ? "have" : "partial"),
      badges: Array.from(badges),
      homestead: { ...(l.homestead || {}), [tag]: Math.min(priorNeed, avail) },
    };
  });
}

function attachEstimate(line, estIndex) {
  const est = estIndex.get(line.key);
  if (!est) return line;
  return {
    ...line,
    unitPrice: est.unitPrice ?? line.unitPrice,
    packSizeQty: est.packSizeQty ?? line.packSizeQty,
    packUnit: est.packUnit ?? line.packUnit,
    storeOverrideId: est.storeId || null, // used for multi-store partition
  };
}

function applyPackRounding(lines = []) {
  // If packSize is available, compute packsNeeded and roundedNeedQty for shopping clarity.
  return lines.map(l => {
    const need = l.needBaseQty ?? 0;
    const pack = Number(l.packSizeQty);
    if (!pack || need <= 0) return l;
    const packsNeeded = Math.ceil(need / pack);
    const roundedNeedQty = packsNeeded * pack;
    return { ...l, packsNeeded, roundedNeedQty };
  });
}

function finalizeVisibility(lines = [], opts = { includeHave: false, collapseDuplicates: true }) {
  const filtered = opts.includeHave ? lines : lines.filter(l => l.status !== "have");
  return filtered;
}

function sortForStoreWalk(list = []) {
  // Sort SHORT -> PARTIAL -> HAVE, then aisle (lexical), then name.
  const rank = { short: 0, partial: 1, have: 2 };
  return [...list].sort((a, b) => {
    const ra = rank[a.status] ?? 9;
    const rb = rank[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    if ((a.aisle || "") !== (b.aisle || "")) return (a.aisle || "").localeCompare(b.aisle || "");
    return (a.name || "").localeCompare(b.name || "");
  });
}

function buildSummary(list = [], estimate = { total: 0, currency: "USD" }) {
  const lines = list.length;
  const shortLines = list.filter(l => l.status === "short").length;
  const partialLines = list.filter(l => l.status === "partial").length;
  const haveLines = lines - shortLines - partialLines;

  const byAisle = {};
  for (const l of list) {
    const a = l.aisle || "General";
    byAisle[a] = (byAisle[a] || 0) + 1;
  }

  return {
    lines,
    shortLines,
    partialLines,
    haveLines,
    byAisle,
    estimatedTotal: estimate?.total ?? 0,
    currency: estimate?.currency ?? "USD",
  };
}

function buildBudgetNotice(total, cap) {
  if (!Number.isFinite(total) || !Number.isFinite(cap)) return null;
  const delta = total - cap;
  if (delta <= 0) return { within: true, delta: Math.abs(delta) };
  return { within: false, delta };
}

function buildNba(list = [], ctx, summary, extras = {}) {
  const actions = [];
  const hasSubsCandidates = list.some(l => (l.substitutions || []).length);

  if (summary.shortLines + summary.partialLines > 0) {
    actions.push({
      id: "review-shortages",
      label: `Review ${summary.shortLines} shortages${summary.partialLines ? ` (+${summary.partialLines} partial)` : ""}`,
      cta: "Open Grocery Panel",
      route: "/MealPlanning/GroceryList",
    });
    actions.push({
      id: "schedule-pickup",
      label: "Schedule pickup/delivery",
      cta: "Choose Store & Time",
      route: "/MealPlanning/GroceryList",
      payload: { storeId: ctx.options.storeId },
    });
  }
  if (hasSubsCandidates) {
    actions.push({
      id: "review-substitutions",
      label: "Review suggested substitutions",
      cta: "Review Subs",
      route: "/MealPlanning/GroceryList",
      payload: { filter: "subs" },
    });
  }
  if (list.some(l => (l.homestead?.garden || l.homestead?.animal))) {
    actions.push({
      id: "harvest-first",
      label: "Confirm garden/animal fulfillment",
      cta: "Open Homestead Checklist",
      route: "/Garden/HarvestChecklist",
    });
  }
  if (extras?.budget && extras.budget.within === false) {
    actions.push({
      id: "budget-trim",
      label: `Over budget by ${formatCurrency(extras.budget.delta)} — see swap & bulk options`,
      cta: "Reduce Total",
      route: "/MealPlanning/GroceryList",
      payload: { filter: "overbudget" },
    });
  }
  actions.push({
    id: "sync-to-inventory",
    label: "Sync purchased items to inventory",
    cta: "Open Inventory Sync",
    route: "/Inventory/Sync",
  });
  return actions;
}

function partitionByStore(lines = []) {
  // Prefer storeOverrideId from estimate; fallback to "primary".
  const buckets = new Map();
  for (const l of lines) {
    const sid = l.storeOverrideId || "primary";
    if (!buckets.has(sid)) buckets.set(sid, []);
    buckets.get(sid).push(l);
  }
  const out = {};
  for (const [sid, items] of buckets.entries()) {
    out[sid] = sortForStoreWalk(items);
  }
  return out;
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function toBaseSafe(l, unitConverter) {
  try {
    if (!unitConverter?.toBase) return { baseQty: l.qty };
    const res = unitConverter.toBase({ qty: l.qty, unit: l.unit, name: l.name });
    return { baseQty: res?.qty ?? (l.qty ?? 0) };
  } catch {
    return { baseQty: l.qty };
  }
}

function guessAisle(l) {
  const n = (l.name || "").toLowerCase();
  if (/milk|yogurt|cheese/.test(n)) return "Dairy";
  if (/beef|chicken|pork|lamb|sausage/.test(n)) return "Meat";
  if (/apple|banana|lettuce|broccoli|onion|tomato|herb|spinach/.test(n)) return "Produce";
  if (/flour|rice|pasta|oats|cereal|sugar|beans|lentil/.test(n)) return "Dry Goods";
  if (/soap|detergent|cleaner|towel|foil|wrap|bag/.test(n)) return "Household";
  return "General";
}

function formatCurrency(n, currency = "USD") {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
  } catch {
    return `$${Number(n ?? 0).toFixed(2)}`;
  }
}

function defaultLog(...args) {
  console.log("[onGroceryListRequested]", ...args);
}

const timeUtilFallback = {
  coerceDate(input) {
    if (!input) return null;
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  },
  startOfWeek(d) {
    const date = new Date(d);
    const day = date.getDay(); // 0 Sun
    const diff = (day === 0 ? -6 : 1) - day; // Monday start
    date.setDate(date.getDate() + diff);
    date.setHours(0, 0, 0, 0);
    return date;
  },
  addDays(d, n) {
    const out = new Date(d);
    out.setDate(out.getDate() + n);
    return out;
  },
};

function uuidFallback() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = (c === "x") ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}

async function safeExport(deps, list, format, meta) {
  const sync = deps?.engines?.grocerySync;
  if (!sync?.export) return;
  await sync.export({ list, meta }, { format });
}

function safePublish(bus, topic, message) {
  try {
    bus?.publish?.(topic, message);
  } catch (e) {
    console.error("[onGroceryListRequested] bus.publish error", topic, e);
  }
}

function serializeError(err) {
  if (!err) return { message: "Unknown error" };
  return {
    name: err.name ?? "Error",
    message: err.message ?? String(err),
    stack: err.stack ?? ""
  };
}

export default onGroceryListRequested;
