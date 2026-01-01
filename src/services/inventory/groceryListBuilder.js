// src/services/inventory/groceryListBuilder.js
// Inventory-aware Grocery List builder for Suka Smart Assistant
// - Consolidates meal-plan needs across days/recipes
// - Respects inventory (reserves, deltas, low-stock thresholds)
// - Split by store & aisle with vendor routing & pack sizes
// - Passover-aware filtering, Sabbath handling notes
// - Budget estimation (prices, substitutions, bulk rules)
// - Perishables timeline + preservation tasks
// - Output shapes for NBA, CSV/MD/Print, and Exports
//
// Defensive imports (graceful degradation if optional services are not present)

let eventBus = { emit: () => {}, on: () => () => {} };
let MealPlans, Recipes, Inventory, PreferencesStore, Vendors, Pricing, logger;
let usdaDefaults, nutritionMath;

try { ({ eventBus } = await import("@/services/events/eventBus")); } catch {}
try { ({ MealPlans } = await import("@/store/MealPlanStore")); } catch {}
try { ({ Recipes } = await import("@/store/RecipeStore")); } catch {}
try { ({ Inventory } = await import("@/store/InventoryStore")); } catch {}
try { ({ usePreferencesStore: PreferencesStore } = await import("@/store/PreferencesStore")); } catch {}
try { ({ Vendors } = await import("@/store/VendorStore")); } catch {}
try { ({ Pricing } = await import("@/services/inventory/pricingService")); } catch {}
try { ({ usdaDefaults } = await import("@/services/nutrition/usdaDefaults")); } catch {}
try { ({ nutritionMath } = await import("@/services/nutrition/nutritionMath")); } catch {}
try { ({ logger } = await import("@/utils/logger")); } catch { logger = { info(){}, warn(){}, error(){} }; }

const DAY = 24*60*60*1000;
const DEFAULT_AISLE = "Other";
const DEFAULT_STORE = "Any";
const UNITS_PRI = ["g","kg","ml","l","tsp","tbsp","cup","piece"];
const PASSOVER_TAGS = new Set(["chametz","leaven","leavening-agent","bread","pasta","beer","waffle","pancake"]);
const PACK_DEFAULTS = {
  // sku: packSize (in base units)
  "egg, whole": 12,
  "yogurt, plain (whole milk)": 4,
  "tomato, canned crushed": 1,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export const groceryListBuilder = {
  /**
   * Build a grocery list from a meal plan id (or plan object).
   * options:
   *  - householdId (if not inferable)
   *  - passoverMode (default from prefs)
   *  - respectInventory (true)
   *  - reserveInventory (true) -> returns reservations to apply
   *  - preferQuickStores (false) -> route to nearest or default vendor
   *  - vendorStrategy: "lowest-cost" | "fewest-stops" | "preferred-first"
   *  - visitWindowISO: { startISO, endISO } (for perishables suggestions)
   *  - packOverrides: { [slug]: packSize }
   */
  async build(input, options = {}) {
    const plan = typeof input === "string" ? await MealPlans?.getById?.(input) : input;
    if (!plan) throw new Error("groceryListBuilder: missing plan");

    const prefs = PreferencesStore?.getState?.() || {};
    const passoverMode = options.passoverMode ?? !!prefs?.calendar?.passoverMode;
    const respectInventory = options.respectInventory ?? true;
    const reserveInventory = options.reserveInventory ?? true;

    // Build raw needs from plan/recipes
    const recipes = await Recipes?.all?.().catch(() => []) || [];
    const recipeMap = Object.fromEntries(recipes.map(r => [r.id, r]));
    const rawNeeds = collectNeedsFromPlan(plan, recipeMap, { passoverMode });

    // Normalize + consolidate & convert to canonical items
    const consolidated = consolidateNeeds(rawNeeds);

    // Apply inventory snapshot (reduce needs, compute deltas)
    const inventory = await Inventory?.snapshot?.(plan.householdId || options.householdId).catch(() => ({})) || {};
    const { needed, reservations, deltas } = respectInventory
      ? applyInventory(consolidated, inventory)
      : { needed: consolidated, reservations: [], deltas: [] };

    // Vendor routing: map to stores & aisles with pack sizing
    const vendors = (await Vendors?.list?.().catch(() => [])) || getDefaultVendors();
    const vendorStrategy = options.vendorStrategy || "fewest-stops";
    const packMap = { ...PACK_DEFAULTS, ...(options.packOverrides || {}) };
    const routed = routeToVendors(needed, vendors, { vendorStrategy, packMap, preferQuick: !!options.preferQuickStores });

    // Price & budget estimation
    const priced = await estimatePrices(routed);

    // Perishables timeline + preservation queue (based on planned cook dates)
    const perishables = buildPerishablesTimeline(plan, priced);
    const preservationQueue = suggestPreservationTasks(perishables, options.visitWindowISO);

    // Substitution suggestions (inventory-based swaps)
    const substitutions = suggestSubsFromInventory(needed, inventory, passoverMode);

    // Output
    const list = {
      planId: plan.id,
      weekStartISO: plan.weekStartISO,
      householdId: plan.householdId || options.householdId || null,
      passoverMode,
      totals: summarize(priced),
      itemsByStore: priced,               // [{ storeId, storeName, aisles:[{ name, items:[] }] }]
      reservations: reserveInventory ? reservations : [], // inventory reserves to apply
      deltas,                             // info-only inventory deltas
      perishables,
      preservationQueue,
      substitutions,
      meta: {
        createdAt: new Date().toISOString(),
        vendorStrategy
      }
    };

    // Event hook for UI
    eventBus.emit?.("grocery:list:created", { list });

    return list;
  },

  /** Apply reservations to inventory (idempotent on your store’s side). */
  async applyReservations(list) {
    if (!list?.reservations?.length) return { ok: true, applied: 0 };
    const ok = await Inventory?.reserveBatch?.(list.householdId, list.reservations).catch(() => null);
    if (!ok) return { ok: false, applied: 0 };
    eventBus.emit?.("inventory:reserved", { reservations: list.reservations });
    return { ok: true, applied: list.reservations.length };
  },

  /** Render helpers */
  toCSV(list) { return toCSV(list); },
  toMarkdown(list) { return toMarkdown(list); },
  formatForPrint(list) { return formatForPrint(list); },

  /** Diff two lists (simple line-up by slug) */
  diff(prevList, nextList) { return diffLists(prevList, nextList); },

  /** Merge user edits (e.g., quantity tweaks, reassigned store/aisle). */
  mergeEdits(list, edits) { return mergeManualEdits(list, edits); },

  /** Quick utility: split a flat array of items by store/aisle. */
  splitByStoreAndAisle(items, vendors) { return splitByStoreAndAisle(items, vendors); }
};

export default groceryListBuilder;

// ---------------------------------------------------------------------------
// Phase 1: Collect raw needs from plan + recipes
// ---------------------------------------------------------------------------
function collectNeedsFromPlan(plan, recipeMap, { passoverMode }) {
  const rows = [];
  for (const day of plan.days || []) {
    for (const mk of ["breakfast","lunch","dinner","snack"]) {
      const slot = day.meals?.[mk];
      if (!slot?.recipeId) continue;
      const r = recipeMap[slot.recipeId];
      if (!r?.ingredients) continue;

      for (const ing of r.ingredients) {
        const name = ing.name || "";
        const qty = parseQtySafe(ing.qty);
        const unit = ing.unit || "g";

        // Passover filter: skip chametz ingredients if mode ON and item tagged
        if (passoverMode && isChametz(ing)) continue;

        rows.push({
          dateISO: day.dateISO,
          meal: mk,
          recipeId: r.id,
          recipeTitle: r.title,
          slug: slugify(name),
          name,
          qty: qty * (slot.servings || 1),
          unit,
          aisle: ing.aisle || null,
          tags: ing.tags || [],
          densityGPerCup: ing.densityGPerCup,
        });
      }
    }
  }
  return rows;
}

function isChametz(ing) {
  const tags = (ing.tags || []).map(t => String(t).toLowerCase());
  return tags.some(t => PASSOVER_TAGS.has(t)) ||
         /(bread|pasta|barley|wheat|rye|beer)/i.test(ing.name || "");
}

// ---------------------------------------------------------------------------
// Phase 2: Consolidation (normalize units, combine like items)
// ---------------------------------------------------------------------------
function consolidateNeeds(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = row.slug + "::" + (row.unit || "g") + "::" + (row.aisle || "");
    const cur = grouped.get(key) || { ...row, qty: 0, dates: [], recipes: new Set(), meals: new Set() };
    cur.qty += row.qty || 0;
    cur.dates.push(row.dateISO);
    cur.recipes.add(row.recipeId);
    cur.meals.add(row.meal);
    grouped.set(key, cur);
  }

  // attempt to normalize to grams where helpful (using nutritionMath.toGrams)
  const list = [...grouped.values()].map(it => normalizeItem(it));

  // combine items with same slug but different small units after conversion
  const bySlug = new Map();
  for (const it of list) {
    const k = it.slug + "::" + (it.aisle || "");
    const cur = bySlug.get(k);
    if (!cur) { bySlug.set(k, it); continue; }
    // if both gram-based, merge; else keep separate units
    if (it.normUnit === cur.normUnit) {
      cur.normQty += it.normQty;
      cur.qty = (cur.normUnit === "g") ? cur.normQty : cur.qty + it.qty; // keep original too
      cur.dates.push(...it.dates);
      it.recipes.forEach(r => cur.recipes.add(r));
      it.meals.forEach(m => cur.meals.add(m));
    } else {
      // keep as-is (rare)
      bySlug.set(k + "::" + Math.random().toString(36).slice(2), it);
    }
  }
  return [...bySlug.values()].map(flattenSets);
}

function normalizeItem(item) {
  const out = { ...item };
  const name = out.name || out.slug;
  let grams = 0;

  try {
    grams = nutritionMath?.toGrams?.({
      qty: out.qty, unit: out.unit, name, densityGPerCup: out.densityGPerCup
    }) ?? 0;
  } catch { grams = 0; }

  if (grams > 0) {
    out.normUnit = "g";
    out.normQty = grams;
  } else {
    out.normUnit = (out.unit || "g").toLowerCase();
    out.normQty = out.qty;
  }
  // prefer human-readable units if huge grams → kg
  if (out.normUnit === "g" && out.normQty >= 1000) {
    out.prettyUnit = "kg";
    out.prettyQty = round(out.normQty / 1000, 2);
  } else if (out.normUnit === "g") {
    out.prettyUnit = "g";
    out.prettyQty = round(out.normQty, 0);
  } else {
    out.prettyUnit = out.normUnit;
    out.prettyQty = round(out.normQty, 2);
  }
  return out;
}

function flattenSets(it) {
  return {
    ...it,
    recipes: [...(it.recipes || [])],
    meals: [...(it.meals || [])]
  };
}

// ---------------------------------------------------------------------------
// Phase 3: Inventory mapping (reduce needs, compute deltas/reservations)
// ---------------------------------------------------------------------------
function applyInventory(items, inventory) {
  const bySlug = indexInventory(inventory);
  const needed = [];
  const reservations = [];
  const deltas = [];

  for (const it of items) {
    const inv = bySlug.get(it.slug);
    if (!inv) { needed.push(it); continue; }

    const have = inv.qty || 0;
    const need = it.normQty || 0;

    if (have >= need) {
      // reserve exact needed
      reservations.push({ slug: it.slug, qty: need, where: inv.location || "pantry" });
      deltas.push({ slug: it.slug, action: "reserve", qty: need });
      // note: no "needed" push
    } else {
      if (have > 0) {
        reservations.push({ slug: it.slug, qty: have, where: inv.location || "pantry" });
        deltas.push({ slug: it.slug, action: "reserve", qty: have });
      }
      const short = need - have;
      needed.push({ ...it, normQty: short, prettyQty: prettyQty(short, it.normUnit), inventoryShort: true });
      deltas.push({ slug: it.slug, action: "short", qty: short });
    }
  }

  return { needed, reservations, deltas };
}

function indexInventory(inventory) {
  const map = new Map();
  (inventory?.items || []).forEach(i => {
    const slug = slugify(i.slug || i.name);
    const key = slug;
    const cur = map.get(key);
    if (!cur) map.set(key, { ...i, slug });
    else cur.qty += (i.qty || 0);
  });
  return map;
}

// ---------------------------------------------------------------------------
// Phase 4: Vendor routing (stores & aisles) + pack sizes
// ---------------------------------------------------------------------------
function routeToVendors(items, vendors, { vendorStrategy, packMap, preferQuick }) {
  // Build a catalog of where things are available: vendor.aisles[].matches[] regex or tag rules
  const catalog = buildVendorCatalog(vendors);

  // 1) assign each item to a preferred store & aisle
  const assigned = items.map(it => assignStoreAisle(it, catalog, { preferQuick }));

  // 2) pack sizing
  const packed = assigned.map(it => applyPackSize(it, packMap));

  // 3) group by store → aisles
  return groupByStoreAisle(packed, vendorStrategy);
}

function buildVendorCatalog(vendors = []) {
  // expected vendor shape:
  // { id, name, priority, distanceKm, aisles: [{ name, match: ["tomato","canned","crushed"] | /regex/ }] }
  const out = [];
  for (const v of vendors) {
    const aisles = (v.aisles || []).map(a => ({
      name: a.name || DEFAULT_AISLE,
      matchers: (a.match || []).map(m => (m instanceof RegExp) ? m : new RegExp(String(m), "i"))
    }));
    out.push({
      id: v.id || v.name || DEFAULT_STORE,
      name: v.name || DEFAULT_STORE,
      priority: v.priority ?? 5,
      distanceKm: v.distanceKm ?? 5,
      aisles
    });
  }
  // ensure at least one default
  if (!out.length) out.push({ id: DEFAULT_STORE, name: DEFAULT_STORE, priority: 9, distanceKm: 0, aisles: [{ name: DEFAULT_AISLE, matchers: [] }] });
  return out.sort((a, b) => a.priority - b.priority);
}

function assignStoreAisle(item, catalog, { preferQuick }) {
  const name = item.name || item.slug;
  let chosen = catalog[0];
  let aisle = DEFAULT_AISLE;

  for (const store of catalog) {
    // if preferQuick, bias by distance
    if (preferQuick && store.distanceKm > (chosen.distanceKm || 999)) continue;

    // try aisle match
    for (const a of store.aisles) {
      const match = a.matchers?.some(rx => rx.test(name)) || false;
      if (match) { chosen = store; aisle = a.name; break; }
    }
  }

  return {
    ...item,
    storeId: chosen.id,
    storeName: chosen.name,
    aisle: item.aisle || aisle
  };
}

function applyPackSize(item, packMap) {
  const key = item.slug;
  const pack = packMap[key] || inferPackFromName(item.name);
  if (!pack) return { ...item, packSize: null, packs: null, buyQty: item.normQty };

  const unit = item.normUnit;
  // Only apply pack for piece/serving/can-like, else skip (bulk grams usually loose)
  const packApplies = unit === "piece" || /can|egg|yogurt|tomato/.test(item.name || "");
  if (!packApplies) return { ...item, packSize: null, packs: null, buyQty: item.normQty };

  const packs = Math.ceil((item.normQty || 0) / pack);
  const buyQty = packs * pack;
  return { ...item, packSize: pack, packs, buyQty };
}

function inferPackFromName(name = "") {
  if (/egg/i.test(name)) return 12;
  if (/yogurt/i.test(name)) return 4;
  if (/tomato.*can/i.test(name)) return 1;
  return null;
}

function groupByStoreAisle(items, vendorStrategy) {
  // Currently vendorStrategy only affects sorting: fewest-stops → prefer default store; lowest-cost left to pricing
  const stores = {};
  for (const it of items) {
    const sid = it.storeId || DEFAULT_STORE;
    const aisle = it.aisle || DEFAULT_AISLE;
    ((stores[sid] ||= { storeId: sid, storeName: it.storeName || sid, aisles: {} }).aisles[aisle] ||= []).push(it);
  }
  // to arrays
  const out = Object.values(stores).map(s => ({
    storeId: s.storeId,
    storeName: s.storeName,
    aisles: Object.entries(s.aisles).sort(([a],[b]) => a.localeCompare(b)).map(([name, items]) => ({
      name,
      items: items.sort((a,b) => (a.slug || "").localeCompare(b.slug || ""))
    }))
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Phase 5: Pricing / Budget
// ---------------------------------------------------------------------------
async function estimatePrices(itemsByStore) {
  // Pricing service optional; fallback to zeroes
  if (!Pricing?.quote) return itemsByStore.map(s => ({ ...s, aisles: s.aisles.map(a => ({ ...a, items: a.items.map(i => ({ ...i, price: 0, priceUnit: i.normUnit, estTotal: 0 })) })) }));

  const out = [];
  for (const store of itemsByStore) {
    const aisles = [];
    for (const aisle of store.aisles) {
      const quoted = [];
      for (const it of aisle.items) {
        const q = await Pricing.quote({
          storeId: store.storeId,
          slug: it.slug,
          name: it.name,
          qty: it.buyQty ?? it.normQty,
          unit: it.normUnit,
          packs: it.packs || 1
        }).catch(() => null);

        const price = q?.unitPrice ?? 0;
        const priceUnit = q?.unit ?? (it.normUnit || "g");
        const estTotal = round((it.buyQty ?? it.normQty) * (q?.pricePerUnit ?? 0) + (q?.packFee ?? 0), 2);

        quoted.push({ ...it, price, priceUnit, estTotal, vendorSku: q?.vendorSku || null });
      }
      aisles.push({ ...aisle, items: quoted });
    }
    out.push({ ...store, aisles });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase 6: Perishables timeline & preservation queue
// ---------------------------------------------------------------------------
function buildPerishablesTimeline(plan, itemsByStore) {
  const perish = [];
  const dateParse = (iso) => new Date(iso + "T00:00:00");

  // If an item is used within X days of purchase, mark as "use-by"
  const useWindowDays = 3;

  // Build forward index of planned usage by slug
  const usageBySlug = {};
  for (const d of plan.days || []) {
    for (const mk of ["breakfast","lunch","dinner","snack"]) {
      const slot = d.meals?.[mk];
      if (!slot?.recipeId) continue;
      // recipe link not needed here; use grocery "slug overlap" heuristic
      // basic: if recipe ingredients include the slug, but we don't have here, just estimate use on that day
      // (more accurate link can be added if the recipe store exposes ingredients)
    }
    // record a generic use date for all items purchased that day if matching
  }

  // Walk the list & label perishables (simple rule: greens/leafy, fish, raw meats)
  for (const store of itemsByStore) {
    for (const aisle of store.aisles) {
      for (const it of aisle.items) {
        const isPerishable = /(greens|spinach|herb|fish|meat|yogurt|milk|tomato, canned crushed)/i.test(it.name || "");
        if (!isPerishable) continue;

        const firstUse = nearestUseDate(it.slug, plan) || plan.weekStartISO;
        const useBy = new Date(new Date(firstUse).getTime() + (useWindowDays * DAY));
        perish.push({
          slug: it.slug,
          name: it.name,
          storeId: store.storeId,
          firstUseISO: firstUse,
          suggestedUseByISO: useBy.toISOString().slice(0,10)
        });
      }
    }
  }
  return perish;
}

function nearestUseDate(slug, plan) {
  // naive heuristic: pick the earliest day in the plan
  return plan.days?.[0]?.dateISO || plan.weekStartISO;
}

function suggestPreservationTasks(perishables, visitWindowISO) {
  // Suggest blanch/freeze, pickle, dry based on item family
  const tasks = [];
  for (const p of perishables) {
    let action = null;
    if (/greens|spinach|herb/i.test(p.name)) action = "Wash, chop, and freeze in portions";
    else if (/fish/i.test(p.name)) action = "Vacuum seal and freeze portions";
    else if (/yogurt|milk/i.test(p.name)) action = "Plan breakfast bowls to consume by use-by";
    else if (/tomato, canned crushed/i.test(p.name)) action = "Batch cook sauce base and portion";
    if (!action) continue;

    const dueISO = p.suggestedUseByISO;
    tasks.push({
      id: `preserve_${p.slug}_${dueISO}`,
      slug: p.slug,
      name: p.name,
      action,
      dueISO
    });
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Phase 7: Substitution suggestions from inventory
// ---------------------------------------------------------------------------
function suggestSubsFromInventory(needed, inventory, passoverMode) {
  const subs = [];
  const bySlug = indexInventory(inventory);
  for (const it of needed) {
    // look for close matches (e.g., "onion, chopped" → any onion)
    const candidates = [...bySlug.values()].filter(inv => isCloseMatch(inv.slug, it.slug));
    for (const c of candidates) {
      if (passoverMode && isChametz({ name: c.name, tags: c.tags })) continue;
      if (c.qty <= 0) continue;
      subs.push({
        needSlug: it.slug,
        needName: it.name,
        substituteSlug: c.slug,
        substituteName: c.name,
        availableQty: c.qty,
        location: c.location || "pantry"
      });
    }
  }
  return subs.slice(0, 24);
}

function isCloseMatch(invSlug, needSlug) {
  if (invSlug === needSlug) return false; // exact handled earlier
  const a = invSlug.split(" ")[0]; const b = needSlug.split(" ")[0];
  return a === b || invSlug.includes(b) || needSlug.includes(a);
}

// ---------------------------------------------------------------------------
// Summaries, Diffs, Formatting
// ---------------------------------------------------------------------------
function summarize(itemsByStore) {
  let est = 0, count = 0, stores = itemsByStore.length;
  for (const s of itemsByStore) for (const a of s.aisles) for (const i of a.items) {
    est += Number(i.estTotal || 0);
    count += 1;
  }
  return { estimatedTotal: round(est, 2), itemCount: count, stores };
}

function diffLists(prev, next) {
  const p = flattenItems(prev);
  const n = flattenItems(next);
  const pMap = new Map(p.map(i => [i.slug, i]));
  const nMap = new Map(n.map(i => [i.slug, i]));
  const added = [];
  const removed = [];
  const changed = [];

  for (const [slug, it] of nMap) {
    if (!pMap.has(slug)) added.push(it);
    else {
      const prevIt = pMap.get(slug);
      if ((prevIt.normQty || 0) !== (it.normQty || 0) || (prevIt.storeId !== it.storeId) || (prevIt.aisle !== it.aisle))
        changed.push({ before: prevIt, after: it });
    }
  }
  for (const [slug, it] of pMap) {
    if (!nMap.has(slug)) removed.push(it);
  }
  return { added, removed, changed };
}

function flattenItems(list) {
  const out = [];
  for (const s of list?.itemsByStore || []) for (const a of s.aisles) for (const i of a.items) out.push(i);
  return out;
}

function mergeManualEdits(list, edits = []) {
  // edits: [{ slug, storeId?, aisle?, normQty?, note?, checked? }]
  const index = {};
  for (const s of list.itemsByStore) for (const a of s.aisles) {
    a.items = a.items.map(it => {
      const e = edits.find(x => x.slug === it.slug);
      if (!e) return it;
      return {
        ...it,
        storeId: e.storeId ?? it.storeId,
        storeName: e.storeName ?? it.storeName,
        aisle: e.aisle ?? it.aisle,
        normQty: e.normQty ?? it.normQty,
        prettyQty: e.normQty ? prettyQty(e.normQty, it.normUnit) : it.prettyQty,
        note: e.note ?? it.note,
        checked: e.checked ?? it.checked
      };
    });
  }
  return list;
}

// CSV/MD/Print formatters (compact; your Exports service can also call these)
function toCSV(list) {
  const rows = [["Store","Aisle","Item","Qty","Unit","Est Total","Note"]];
  for (const s of list.itemsByStore) for (const a of s.aisles) for (const i of a.items) {
    rows.push([s.storeName, a.name, i.name, i.prettyQty, i.prettyUnit, (i.estTotal ?? 0).toFixed(2), i.note || ""]);
  }
  return rows.map(r => r.map(csvSafe).join(",")).join("\n");
}

function toMarkdown(list) {
  const lines = [];
  lines.push(`# Grocery List (${list.weekStartISO || ""})`);
  lines.push(`Estimated total: **$${(list.totals.estimatedTotal || 0).toFixed(2)}**`);
  if (list.passoverMode) lines.push(`> Passover mode is **ON** – chametz filtered.\n`);

  for (const s of list.itemsByStore) {
    lines.push(`\n## ${s.storeName}`);
    for (const a of s.aisles) {
      lines.push(`### ${a.name}`);
      for (const i of a.items) {
        lines.push(`- [ ] ${i.name} — ${i.prettyQty} ${i.prettyUnit}${i.estTotal ? ` _(~$${i.estTotal.toFixed(2)})_` : ""}`);
      }
    }
  }

  // Preservation appendix
  if (list.preservationQueue?.length) {
    lines.push(`\n---\n## Preservation Tasks`);
    list.preservationQueue.forEach(t => lines.push(`- ${t.action} for **${t.name}** by **${t.dueISO}**`));
  }
  return lines.join("\n");
}

function formatForPrint(list) {
  // minimal printable structure; your UI can render this with a nice template
  return {
    title: `Grocery List — ${list.weekStartISO || ""}`,
    summary: list.totals,
    stores: list.itemsByStore.map(s => ({
      name: s.storeName,
      aisles: s.aisles.map(a => ({
        name: a.name,
        items: a.items.map(i => ({
          name: i.name, qty: i.prettyQty, unit: i.prettyUnit, note: i.note || "", est: i.estTotal || 0, checked: !!i.checked
        }))
      }))
    })),
    preservation: list.preservationQueue || []
  };
}

// Quick helpers
function round(x, n=2) { const p = Math.pow(10, n); return Math.round((Number(x)||0)*p)/p; }
function parseQtySafe(q) {
  if (!q && q !== 0) return 0;
  if (typeof q === "number") return q;
  const s = String(q).trim();
  // handle "1 1/2"
  const parts = s.split(" ");
  let total = 0;
  for (const p of parts) {
    if (p.includes("/")) {
      const [a,b] = p.split("/").map(Number);
      if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) total += a/b;
    } else {
      const n = Number(p); if (Number.isFinite(n)) total += n;
    }
  }
  return total;
}
function slugify(s="") { return s.toLowerCase().replace(/[^a-z0-9]+/g," ").trim().replace(/\s+/g," "); }
function csvSafe(s) { if (s==null) return ""; const t=String(s); return /[",\n]/.test(t) ? `"${t.replace(/"/g,'""')}"` : t; }
function prettyQty(q, unit) {
  if (unit === "g" && q >= 1000) return round(q/1000,2);
  if (unit === "g") return round(q,0);
  return round(q,2);
}

// Default vendors (fallback)
function getDefaultVendors() {
  return [
    { id: "market", name: "Local Market", priority: 1, distanceKm: 2, aisles: [
      { name: "Produce", match: ["greens","spinach","okra","onion","pepper"] },
      { name: "Meat & Fish", match: ["lamb","goat","beef","fish"] },
      { name: "Pantry", match: ["tomato","spice","oil","rice","jollof","millet","quinoa"] },
      { name: "Dairy", match: ["yogurt","milk"] },
    ]},
    { id: "warehouse", name: "Warehouse Club", priority: 2, distanceKm: 8, aisles: [
      { name: "Bulk Pantry", match: ["tomato","rice","oil","oats","beans"] },
      { name: "Chilled", match: ["yogurt","milk"] },
    ]},
  ];
}

// ---------------------------------------------------------------------------
// Exposed helpers if you want to use them elsewhere
// ---------------------------------------------------------------------------
export function splitByStoreAndAisle(items, vendors) {
  const routed = routeToVendors(items, vendors || getDefaultVendors(), { vendorStrategy: "fewest-stops", packMap: PACK_DEFAULTS, preferQuick: false });
  return routed;
}
