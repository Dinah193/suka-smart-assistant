// C:\Users\larho\suka-smart-assistant\src\managers\InventoryMonitor.js
/* eslint-disable no-console */
/**
 * InventoryMonitor (ESM-first, browser-safe)
 * ------------------------------------------
 * Produces "have / low / short / surplus" signals with rationale + NBA,
 * builds a favorite-able Restock Plan, emits calendar hints, and CONSUMES
 * "Add to Inventory" actions (from Scan • Compare • Trust, restock sessions,
 * purchase confirmations, etc.)
 *
 * Recent updates & orchestration
 *  • Settings-aware: observes observance (Sabbath) & favorites defaults.
 *  • Emits shortage events compatible with SessionStore/TemplateStore flows.
 *  • Builds a user-favoriteable "Restock Plan" (grouped by store/aisle).
 *  • Calendar hint on restock plan (so calendarSync can suggest/queue a trip).
 *  • Tier Sync publish for dashboards.
 *  • Substitutions, prep reminders, store/aisle grouping remain optional.
 *  • ACTION CONSUMERS:
 *      - inventory.action.addToInventory          (direct add/adjust)
 *      - restock.purchase.completed               (map purchase -> add)
 *      - scanner.item.accepted                    (optionally add now)
 *  • Favorites/Schedules:
 *      - general.plan.favorite.requested          (Save modal / export)
 *      - schedule.template.save.requested         (user schedules)
 *      - schedule.event.write.requested           (calendar hint)
 *
 * Events emitted (core)
 *  - inventory:item:status
 *  - inventory:signals
 *  - inventory.shortage.detected      ({ missing, store, horizonDays })
 *  - restock.plan.created             ({ plan, signals })
 *  - general.plan.favorite.requested  ({ plan, favoriteKey, options })
 *  - schedule.event.write.requested   ({ domain, planId, title, recurrence, startTimeLocal })
 *
 * NOTE: All emits are best-effort, non-fatal.
 */

const isBrowser = typeof window !== "undefined";
const now = () => new Date();
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const safeNumber = (n, fb = 0) => { const v = Number(n); return Number.isFinite(v) ? v : fb; };
const toKey = (it) => `${(it?.sku || "").toString()}|${(it?.name || "").toLowerCase()}|${it?.store || ""}`;
const idKey = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const DEFAULTS = {
  horizonDays: 7,
  bufferDays: 5,
  surplusFactor: 3,
  minDailyFloor: 0.01,
  store: "Default",
  sabbathGuard: false,
  pantryGuard: false,
  includeHave: true,
  collapseDuplicates: true,
  buildRestockPlan: true,
  restockWindowStart: "17:30",     // calendar hint for shopping after work
  autoFavorite: false,             // can be set by callers/UI
};

const BADGES = {
  short:   { label: "Short",   color: "bg-red-600 text-white",     icon: "AlertTriangle",     priority: 4 },
  low:     { label: "Low",     color: "bg-amber-500 text-black",   icon: "BatteryCharging",   priority: 3 },
  have:    { label: "Have",    color: "bg-emerald-600 text-white", icon: "Check",             priority: 2 },
  surplus: { label: "Surplus", color: "bg-sky-600 text-white",     icon: "Package",           priority: 1 },
};
const badgeFor = (s) => BADGES[s] || BADGES.have;

/* -------------------------- lazy optional imports --------------------------- */
const _cache = new Map();
async function lazy(path) {
  if (_cache.has(path)) return _cache.get(path);
  try {
    const mod = await import(/* @vite-ignore */ path);
    const val = mod?.default ?? mod;
    _cache.set(path, val);
    return val;
  } catch { _cache.set(path, null); return null; }
}

// Event bus
let eventBus = (isBrowser ? (window.__suka_eventBus__ || {}) : {});
if (!eventBus.emit || !eventBus.on || !eventBus.off) {
  eventBus = { emit(){}, on(){}, off(){} };
  lazy("@/services/eventBus").then((eb) => {
    const bus = eb?.eventBus || eb || eventBus;
    if (isBrowser) window.__suka_eventBus__ = bus;
    eventBus = bus;
  });
}

// Tier sync
let tierSync = { publish(){} };
lazy("@/services/sync/tierSync").then((m) => { tierSync = m?.default || m || tierSync; });

// Optional deps
let inventoryApi = null;
let demandApi = null;
let suppliersApi = null;
let gardenApi = null;
let animalApi = null;
let IngredientLinker = null;
let scheduleHelpers = null;
let SettingsStore = null;

Promise.all([
  lazy("@/services/inventory/api").then((m)=>{ inventoryApi = m?.default || m || null; }),
  lazy("@/services/planning/demandForecast").then((m)=>{ demandApi = m?.default || m || null; }),
  lazy("@/services/suppliers/api").then((m)=>{ suppliersApi = m?.default || m || null; }),
  lazy("@/services/garden/api").then((m)=>{ gardenApi = m?.default || m || null; }),
  lazy("@/services/animals/api").then((m)=>{ animalApi = m?.default || m || null; }),
  lazy("@/engines/linkers/IngredientLinker").then((m)=>{ IngredientLinker = m?.default || m || null; }),
  lazy("@/engines/scheduling/scheduleHelpers").then((m)=>{ scheduleHelpers = m?.default || m || null; }),
  lazy("@/store/SettingsStore").then((m)=>{ SettingsStore = m?.default || m || null; }),
]);

/* -------------------------------- helpers ----------------------------------- */
function withinHorizon(date, start, end) { return !!date && (new Date(date) >= start && new Date(date) <= end); }

function estimateDailyUse(item) {
  const fromApi = safeNumber(item?.usage?.dailyAvg, NaN);
  if (!Number.isNaN(fromApi) && fromApi > 0) return fromApi;
  const isPerishable = !!item?.tags?.some(t => /produce|dairy|meat|fresh/i.test(t));
  const base = isPerishable ? 0.5 : 0.1;
  return Math.max(base, DEFAULTS.minDailyFloor);
}
function reorderPoint(item, cfg) {
  if (item?.reorderPoint != null) return safeNumber(item.reorderPoint, 0);
  return Math.ceil(estimateDailyUse(item) * (cfg?.bufferDays ?? DEFAULTS.bufferDays));
}
function surplusPoint(item, cfg) { return Math.ceil(reorderPoint(item, cfg) * (cfg?.surplusFactor ?? DEFAULTS.surplusFactor)); }

function safeEmit(evt, payload) { try { eventBus?.emit?.(evt, payload); } catch(e){ console.warn("[InventoryMonitor] emit fail", evt, e); } }
function safeTierSync(type, payload) { try { tierSync?.publish?.(type, payload); } catch {} }

function getSettingsSnapshot() {
  try {
    if (!SettingsStore) return {};
    const get = SettingsStore.get || SettingsStore?.default?.get;
    const s = get ? {
      sabbathAware: !!get("observance.sabbathAware", true),
      sabbathRule: get("observance.sabbathDayRule", "hebrew_day7"),
      quietRespect: !!get("notifications.quietHours.respectObservance", true),
      defaultDestination: get("favorites.defaultDestination", "local"),
      restockWindowStart: get("sessions.itemRuntimePanel.compact", false) ? "18:00" : DEFAULTS.restockWindowStart,
      defaultScheduleName: get("scheduler.defaultScheduleName", "Household"),
    } : {};
    return s;
  } catch { return {}; }
}

/* --------------------------- external lookups -------------------------------- */
function projectedDemand(item, start, end) {
  if (!demandApi?.project) return 0;
  try {
    const v = demandApi.project({ sku: item?.sku, name: item?.name, start, end, unit: item?.unit });
    return safeNumber(v, 0);
  } catch (e) { console.warn("[InventoryMonitor] demandApi.project failed:", e); return 0; }
}
function supplierLeadTimeDays(item) {
  if (!suppliersApi?.leadTimeDays) return 0;
  try { return clamp(safeNumber(suppliersApi.leadTimeDays({ sku: item?.sku, name: item?.name, supplierId: item?.supplierId }), 0), 0, 60); }
  catch { return 0; }
}
function minOrderQty(item) {
  if (!suppliersApi?.minOrderQty) return 0;
  try { return safeNumber(suppliersApi.minOrderQty({ sku: item?.sku }), 0); } catch { return 0; }
}
function fallbackFarmQty(item, start, end) {
  let g = 0, a = 0;
  try {
    if (gardenApi?.searchCrops) {
      const crops = gardenApi.searchCrops({ query: item?.name || item?.category || "" }) || [];
      for (const c of crops) {
        if (Array.isArray(c?.harvestDates) && c.harvestDates.some(d => withinHorizon(d, start, end))) {
          g += safeNumber(c?.expectedQty, 0);
        }
      }
    }
  } catch {}
  try {
    if (animalApi?.search) {
      const animals = animalApi.search({ query: item?.name || "" }) || [];
      for (const an of animals) {
        if (withinHorizon(an?.processingDate, start, end)) {
          a += safeNumber(an?.projectedYield, 0);
        }
      }
    }
  } catch {}
  return g + a;
}
async function suggestSubs(item, ctx) {
  if (!IngredientLinker?.linkIngredient) return [];
  try {
    const linked = await IngredientLinker.linkIngredient(
      { name: item?.name, qty: 1, unit: item?.unit || null },
      { store: ctx?.store, sabbathGuard: ctx?.sabbathGuard, pantryGuard: ctx?.pantryGuard }
    );
    const pool = [linked.primary, ...(linked.candidates || [])].filter(Boolean);
    const out = [];
    for (const c of pool) {
      if (c.sourceType === "inventory" && (item?.qty ?? 0) > 0) continue;
      out.push({
        type: c.sourceType,
        id: c.sourceId || c.supplier || null,
        confidence: c.confidence,
        rationale: c.rationale || [],
        fulfill: c.fulfill ? c.fulfill() : null,
      });
      if (out.length >= 3) break;
    }
    return out;
  } catch { return []; }
}
function prepReminders(item, ctx, start) {
  if (!scheduleHelpers) return [];
  try {
    const hints = [];
    if (/meat|lamb|beef|chicken|fish|poultry/i.test(item?.name || "")) {
      const when = addDays(start, 0);
      const defrost  = scheduleHelpers?.defrostReminder?.(item, when);
      const marinate = scheduleHelpers?.marinateReminder?.(item, when);
      const preheat  = scheduleHelpers?.preheatReminder?.(item, when);
      if (defrost)  hints.push(defrost);
      if (marinate) hints.push(marinate);
      if (preheat)  hints.push(preheat);
    }
    return hints.map(h => ({ ...h, disabled: !!ctx?.sabbathGuard }));
  } catch { return []; }
}

/* -------------------------------- rationale --------------------------------- */
function buildRationale({ qty, demand, farmFallback, buffer, surplus, projected, lead, moq, dailyUse }) {
  const bits = [];
  bits.push(`on-hand:${qty}`);
  if (demand > 0) bits.push(`demand:${demand}/${dailyUse.toFixed(2)}/d`);
  if (farmFallback > 0) bits.push(`farm-fallback:+${farmFallback}`);
  bits.push(`buffer:${buffer}`);
  bits.push(`surplus:${surplus}`);
  bits.push(`projected:${projected}`);
  if (lead > 0) bits.push(`lead:${lead}d`);
  if (moq > 0) bits.push(`moq:${moq}`);
  return bits;
}

/* -------------------------------- core logic -------------------------------- */
async function computeStatus(item, cfg) {
  const start = now();
  const end   = addDays(start, cfg?.horizonDays ?? DEFAULTS.horizonDays);

  const qty      = safeNumber(item?.qty, 0);
  const unit     = item?.unit || item?.units || null;
  const dailyUse = estimateDailyUse(item);
  const buffer   = reorderPoint(item, cfg);
  const surplus  = surplusPoint(item, cfg);

  const demand       = projectedDemand(item, start, end);
  const farmFallback = fallbackFarmQty(item, start, end);
  const projected    = qty - demand + farmFallback;

  let status = "have";
  if (projected < 0) status = "short";
  else if (qty <= buffer) status = "low";
  else if (qty >= surplus) status = "surplus";

  const badge = badgeFor(status);
  const lead  = supplierLeadTimeDays(item);
  const moq   = minOrderQty(item);

  // qty needed to reach buffer + demand coverage (respect MOQ & lead time)
  const needed = Math.max(0, buffer + demand - qty + Math.ceil(dailyUse * lead));
  const recommendedOrderQty = Math.max(moq, needed);

  const actions = [];
  if (status === "short" || status === "low") {
    actions.push({
      type: "order",
      label: "Order from supplier",
      disabled: !!cfg?.sabbathGuard,
      data: {
        supplierId: item?.supplierId || null,
        sku: item?.sku || null,
        qty: Math.ceil(clamp(recommendedOrderQty, 0, Number.MAX_SAFE_INTEGER)),
        leadTimeDays: lead,
        moq,
      },
    });
    if (farmFallback > 0) {
      actions.push({
        type: "reserve-farm",
        label: "Reserve garden/animal harvest",
        disabled: !!cfg?.sabbathGuard,
        data: { expectedQty: farmFallback, horizonEnd: end.toISOString() },
      });
    }
    const subs = await suggestSubs(item, cfg);
    if (subs.length) actions.push({ type: "substitute", label: "See substitutions", disabled: false, data: subs });
  }

  // Always allow "Add to Inventory" once you actually have the item (post-purchase)
  actions.push({
    type: "add-to-inventory",
    label: "Add to Inventory",
    disabled: false, // adding is allowed even w/ sabbathGuard; the user already possesses the item
    data: {
      sku: item?.sku || null,
      name: item?.name || "",
      unit,
      // qty is filled by caller UI at time of action; provide a sane default suggestion:
      qty: Math.max(1, Math.ceil(recommendedOrderQty || 1)),
      store: cfg?.store || item?.store || "Default",
      idempotencyKey: null,
    }
  });

  actions.push(...prepReminders(item, cfg, start));

  let aisleHint = item?.aisle || item?.meta?.aisle || null;
  if (!aisleHint && IngredientLinker?.mapAisleHint) {
    try { aisleHint = IngredientLinker.mapAisleHint(item?.tags || [], item?.name || ""); } catch {}
  }

  const payload = {
    id: item?.id || item?.sku || item?.name,
    sku: item?.sku || null,
    name: item?.name || "",
    unit,
    qty,
    store: cfg?.store || item?.store || "Default",
    status,
    badge,
    rationale: buildRationale({ qty, demand, farmFallback, buffer, surplus, projected, lead, moq, dailyUse }),
    window: { start: start.toISOString(), end: end.toISOString(), days: (cfg?.horizonDays ?? DEFAULTS.horizonDays) },
    numbers: { qty, demand, buffer, surplus, projected, dailyUse, leadTimeDays: lead, moq, recommendedOrderQty: Math.ceil(recommendedOrderQty) },
    actions,
    meta: { aisle: aisleHint, pantryGuard: !!cfg?.pantryGuard },
  };

  safeEmit("inventory:item:status", payload);
  return payload;
}

/* -------------------------- restock plan builder ---------------------------- */
function buildRestockPlan(signals, cfg) {
  const items = signals.filter(s => s.status === "short" || s.status === "low");
  if (!items.length) return null;

  // group by store → aisle
  const byStore = new Map();
  for (const it of items) {
    const store = it.store || "Default";
    if (!byStore.has(store)) byStore.set(store, []);
    byStore.get(store).push(it);
  }

  const steps = [];
  for (const [store, list] of byStore.entries()) {
    list.sort((a, b) => (a?.meta?.aisle || "").localeCompare(b?.meta?.aisle || "") || (a.name || "").localeCompare(b.name || ""));
    for (const it of list) {
      // Each step includes a *post-purchase* Add-to-Inventory action contract
      steps.push({
        id: `buy-${it.sku || it.id}`,
        title: `Buy ${it.name}`,
        description: `${it.meta?.aisle ? `Aisle: ${it.meta.aisle}. ` : ""}Suggested qty: ${it.numbers?.recommendedOrderQty || 1}${it.unit ? " " + it.unit : ""}.`,
        kind: "purchase",
        store,
        aisle: it.meta?.aisle || null,
        durationMs: 0,
        startOffset: 0,
        actions: [
          {
            type: "add-to-inventory",
            label: "Add purchased qty to Inventory",
            data: {
              sku: it.sku || null,
              name: it.name || "",
              unit: it.unit || null,
              qty: it.numbers?.recommendedOrderQty || 1,
              store,
              idempotencyKey: null,
            }
          }
        ]
      });
    }
  }

  const planId = `plan:restock:${Date.now()}`;
  const today = new Date();
  const recurrence = null;
  const startTimeLocal = cfg?.restockWindowStart || DEFAULTS.restockWindowStart;

  const plan = {
    "$id": planId,
    "$schema": "urn:suka:contracts:workplan",
    type: "restock",
    slug: "restock:shopping-list",
    meta: {
      title: "Restock — Shopping List",
      subtitle: `${items.length} items · ${Array.from(byStore.keys()).join(", ")}`,
      domain: "general",
      version: "1.1.0",
      favoriteable: true,
      exportable: true,
      defaultFavoriteKey: "general:restock",
      icon: "shopping-cart",
      tags: ["restock", "shopping", "inventory"]
    },
    params: { domain: "general", generatedAt: today.toISOString() },
    schedule: {
      recurrence,
      startTimeLocal,
      calendar: { write: true, title: "Restock — Shopping Trip" },
      // Allow user to save THIS plan as their own schedule template
      favoriteableSchedule: {
        suggestedName: "My Restock Evening",
        suggestedDomain: "general",
      }
    },
    steps
  };

  // calendar hint
  safeEmit("schedule.event.write.requested", {
    domain: "general",
    planId: plan.$id,
    title: plan.schedule.calendar.title || plan.meta.title,
    recurrence: plan.schedule.recurrence,
    startTimeLocal: plan.schedule.startTimeLocal
  });

  // also allow saving a schedule template (user-owned)
  safeEmit("schedule.template.save.requested", {
    source: "InventoryMonitor",
    planId: plan.$id,
    template: {
      name: plan.schedule?.favoriteableSchedule?.suggestedName || "Restock Evening",
      domain: "general",
      schedule: {
        startTimeLocal,
        recurrence: null
      },
      favoriteKey: "user:schedule:restock",
    }
  });

  return plan;
}

/* --------------------------- ACTION CONSUMERS ------------------------------- */
/**
 * Idempotent action memory to avoid double-processing when events bounce around.
 */
const _actionSeen = new Set();
function seenOrRemember(key) {
  if (!key) return false;
  if (_actionSeen.has(key)) return true;
  _actionSeen.add(key);
  // Keep memory small
  if (_actionSeen.size > 1000) {
    // drop oldest arbitrarily
    const it = _actionSeen.values().next();
    if (!it.done) _actionSeen.delete(it.value);
  }
  return false;
}

/**
 * Apply "Add to Inventory" action
 * payload shape (normalized):
 * {
 *   sku, name, unit, qty, store, location?, notes?, idempotencyKey?
 * }
 */
async function applyAddToInventory(payload = {}) {
  if (!inventoryApi) return { ok: false, reason: "no-inventory-api" };
  const key = payload.idempotencyKey || `add:${payload.sku || payload.name}:${payload.qty}:${payload.store}`;
  if (seenOrRemember(key)) return { ok: true, reason: "duplicate-ignored" };

  try {
    const upsert = inventoryApi.upsert || inventoryApi.add || inventoryApi.adjust || null;
    if (!upsert) return { ok: false, reason: "no-upsert-method" };

    const res = await Promise.resolve(upsert({
      sku: payload.sku || null,
      name: payload.name || "",
      unit: payload.unit || null,
      qty: safeNumber(payload.qty, 0),
      store: payload.store || "Default",
      location: payload.location || null,
      notes: payload.notes || null,
      source: payload.source || "action",
    }));

    // Fan out: let the rest of the system refresh
    safeEmit("inventory:changed", { reason: "add-to-inventory", item: { sku: payload.sku, name: payload.name, qty: payload.qty } });
    safeTierSync("inventory.changed", { store: payload.store || "Default" });

    return { ok: true, data: res };
  } catch (e) {
    console.warn("[InventoryMonitor] applyAddToInventory failed:", e);
    return { ok: false, error: e };
  }
}

/**
 * Register consumers for external actions:
 *  - inventory.action.addToInventory
 *  - restock.purchase.completed  -> normalize then addToInventory
 *  - scanner.item.accepted       -> optional, when user chooses "add now"
 *
 * Returns: unsubscribe function
 */
export function registerActionConsumers() {
  const handlers = [];

  const onAddDirect = async (evt) => {
    const p = evt?.payload || evt || {};
    await applyAddToInventory({
      sku: p.sku || null,
      name: p.name || "",
      unit: p.unit || null,
      qty: p.qty || 0,
      store: p.store || "Default",
      location: p.location || null,
      notes: p.notes || null,
      source: "inventory.action.addToInventory",
      idempotencyKey: p.idempotencyKey || p.requestId || null,
    });
  };

  const onPurchaseCompleted = async (evt) => {
    // map purchase receipt line item -> inventory add
    const line = evt?.lineItem || evt?.payload || evt || {};
    await applyAddToInventory({
      sku: line.sku || null,
      name: line.name || "",
      unit: line.unit || null,
      qty: line.qty || line.quantity || 0,
      store: (evt?.store || line.store || "Default"),
      location: null,
      notes: `Receipt ${evt?.receiptId || evt?.orderId || ""}`.trim(),
      source: "restock.purchase.completed",
      idempotencyKey: line.idempotencyKey || `${evt?.receiptId || evt?.orderId}:${line.sku || line.name}:${line.qty || line.quantity}`,
    });
  };

  const onScannerAccepted = async (evt) => {
    // Some flows allow user to immediately add what was scanned to inventory
    const it = evt?.item || evt?.payload || evt || {};
    if (!it || !it.name) return;
    await applyAddToInventory({
      sku: it.sku || null,
      name: it.name,
      unit: it.unit || null,
      qty: it.qty || 1,
      store: it.store || "Default",
      notes: "Scanner accepted",
      source: "scanner.item.accepted",
      idempotencyKey: it.idempotencyKey || `scan:${it.sku || it.name}:${it.qty || 1}`,
    });
  };

  try {
    eventBus.on?.("inventory.action.addToInventory", onAddDirect);         handlers.push(["inventory.action.addToInventory", onAddDirect]);
    eventBus.on?.("restock.purchase.completed", onPurchaseCompleted);      handlers.push(["restock.purchase.completed", onPurchaseCompleted]);
    eventBus.on?.("scanner.item.accepted", onScannerAccepted);             handlers.push(["scanner.item.accepted", onScannerAccepted]);
  } catch (e) {
    console.warn("[InventoryMonitor] registerActionConsumers failed:", e);
  }

  return () => {
    try { for (const [evt, fn] of handlers) eventBus.off?.(evt, fn); } catch {}
  };
}

/* ------------------------------- public API --------------------------------- */
/**
 * Analyze inventory and return signals for the whole list.
 * If `buildRestockPlan` is true and lows/shorts exist, emits a restock plan + favorite event when requested.
 */
export async function analyzeInventory(options = {}) {
  // Merge options with defaults AND user settings
  const settings = getSettingsSnapshot();
  const cfg = {
    ...DEFAULTS,
    sabbathGuard: !!(settings.sabbathAware && settings.quietRespect),
    restockWindowStart: settings.restockWindowStart || DEFAULTS.restockWindowStart,
    ...options
  };

  let items = Array.isArray(cfg.items) ? cfg.items : [];
  if (!items.length && inventoryApi?.list) {
    try { items = inventoryApi.list({ store: cfg.store }) || []; }
    catch (e) { console.warn("[InventoryMonitor] inventoryApi.list failed:", e); items = []; }
  }

  if (cfg.collapseDuplicates) {
    const map = new Map();
    for (const it of items) {
      const k = toKey(it);
      const prev = map.get(k);
      if (prev) map.set(k, { ...it, qty: safeNumber(it?.qty, 0) + safeNumber(prev?.qty, 0) });
      else map.set(k, it);
    }
    items = [...map.values()];
  }

  const results = [];
  for (const it of items) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const st = await computeStatus(it, cfg);
      if (cfg.includeHave || st.status !== "have") results.push(st);
    } catch (e) {
      console.warn("[InventoryMonitor] computeStatus failed:", e);
      results.push({
        id: it?.id || it?.sku || it?.name,
        name: it?.name || "",
        status: "have",
        badge: badgeFor("have"),
        error: true,
        rationale: ["error-compute-status", String(e?.message || e)],
      });
    }
  }

  const sev = { short: 4, low: 3, surplus: 2, have: 1 };
  results.sort((a, b) => {
    const d = (sev[b.status] - sev[a.status]);
    if (d !== 0) return d;
    const ax = (a?.meta?.aisle || "").localeCompare(b?.meta?.aisle || "");
    if (ax !== 0) return ax;
    return (a?.name || "").localeCompare(b?.name || "");
  });

  // summary & signals
  const summary = {
    count: results.length,
    short: results.filter(r => r.status === "short").length,
    low: results.filter(r => r.status === "low").length,
    surplus: results.filter(r => r.status === "surplus").length,
    have: results.filter(r => r.status === "have").length,
    store: cfg.store,
    horizonDays: cfg.horizonDays,
  };

  safeEmit("inventory:signals", summary);
  safeTierSync("inventory.signals", { store: cfg.store, horizonDays: cfg.horizonDays, results: results.slice(0, 200) });

  // emit shortages list for upstream guards (compat)
  const missing = results
    .filter(r => r.status === "short" || r.status === "low")
    .map(r => ({
      sku: r.sku, name: r.name, qtyToOrder: r.numbers?.recommendedOrderQty || 1, unit: r.unit || null, store: r.store
    }));
  if (missing.length) {
    safeEmit("inventory.shortage.detected", { domain: "general", missing, store: cfg.store, horizonDays: cfg.horizonDays });
  }

  // Build & optionally emit a favorite-able restock plan
  if (cfg.buildRestockPlan) {
    const plan = buildRestockPlan(results, cfg);
    if (plan) {
      safeEmit("restock.plan.created", { plan, signals: summary });
      if (cfg.autoFavorite) {
        // Let Save modal / cloud export handle persistence using SettingsStore defaults
        const favoritePayload = {
          domain: "general",
          plan,
          options: { source: "InventoryMonitor", destination: getSettingsSnapshot().defaultDestination || "local" },
          favoriteKey: plan.meta.defaultFavoriteKey || "general:restock"
        };
        safeEmit("general.plan.favorite.requested", favoritePayload);
      }
    }
  }

  return results;
}

/**
 * Convenience: Build and return a favorite-able restock plan directly (does not run a full re-analysis if signals passed).
 * If signals not provided, it will analyze using defaults.
 */
export async function buildRestockPlanFromCurrent(options = {}) {
  const signals = Array.isArray(options.signals) ? options.signals : await analyzeInventory({ ...options, buildRestockPlan: false });
  const plan = buildRestockPlan(signals, { restockWindowStart: options.restockWindowStart || getSettingsSnapshot().restockWindowStart });
  if (!plan) return null;
  if (options.autoFavorite) {
    safeEmit("general.plan.favorite.requested", {
      domain: "general",
      plan,
      options: { source: "InventoryMonitor.buildRestockPlanFromCurrent", destination: getSettingsSnapshot().defaultDestination || "local" },
      favoriteKey: plan.meta.defaultFavoriteKey || "general:restock"
    });
  }
  return plan;
}

/**
 * Hook live recompute from cross-domain events.
 * Returns an unsubscribe function.
 */
export function registerLiveRecompute(debounceMs = 400) {
  const triggers = [
    "inventory:changed",
    "mealplan:updated",
    "batchsession:updated",
    "garden:harvestScheduled",
    "animals:processingUpdated",
  ];
  let timer = null;
  const run = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      analyzeInventory().catch(e => console.warn("[InventoryMonitor] live recompute failed:", e));
    }, debounceMs);
  };
  try { for (const t of triggers) eventBus.on?.(t, run); } catch {}
  return () => { try { for (const t of triggers) eventBus.off?.(t, run); } catch {} };
}

/* -------------------------------- testing hooks ----------------------------- */
export const _internals = {
  estimateDailyUse,
  reorderPoint,
  surplusPoint,
  projectedDemand,
  supplierLeadTimeDays,
  minOrderQty,
  fallbackFarmQty,
  computeStatus,
  badgeFor,
  buildRestockPlan,
  applyAddToInventory,
  seenOrRemember
};

/* -------------------------------- default export ---------------------------- */
const InventoryMonitorDefault = {
  analyzeInventory,
  registerLiveRecompute,
  registerActionConsumers,
  buildRestockPlanFromCurrent,
  _internals,
};
export default InventoryMonitorDefault;

/* --------------------------------- CJS guard -------------------------------- */
if (typeof module !== "undefined" && typeof module.exports !== "undefined") {
  module.exports = {
    analyzeInventory,
    registerLiveRecompute,
    registerActionConsumers,
    buildRestockPlanFromCurrent,
    _internals,
    default: InventoryMonitorDefault,
  };
}
