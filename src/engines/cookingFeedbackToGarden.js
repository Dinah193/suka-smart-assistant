// File: src/engines/cookingFeedbackToGarden.js
// Purpose: Listen to cooking/runtime + inventory events and translate them into
//          garden demand signals (what to plant more/less of, when to harvest, etc.).
// Pipeline fit: imports (recipes) → intelligence (technique + ingredient usage) → automation
//               (sessions + inventory deltas) → FEEDBACK LOOP (this file) → garden planning
//               → (optional) hub export via Family Fund if featureFlags.familyFundMode.
//
// Contracts used here (assumed to exist in repo):
// - src/services/events/eventBus.js         : simple pub/sub with .on(event, handler) and .emit(payload)
// - src/services/dataGateway.js             : get(key), set(key, value), merge(key, partial), transact(fn)
// - src/config/featureFlags.json            : { familyFundMode: boolean }
// - HubPacketFormatter, FamilyFundConnector : used in exportToHubIfEnabled(payload)
//
// Events consumed (examples; extensible):
// - meal.executed       : { data: { id, startedAtISO, completedAtISO, portions,
//                                  ingredients:[{ name, qty, unit, sku?, tags?, classId?, canonicalId? }],
//                                  cuisineTags?, cuisineProfileId?, householdId?, userId? } }
// - cook.step.completed : { data: { techniqueId, ingredientClass, actualTimeMin, actualCoreC } }
// - inventory.updated   : { data: { diffs: [{ sku, name, delta, unit, domain }], reason } }
//
// Events emitted (canonical shape { type, ts, source, data }):
// - garden.demand.incremented : when usage maps to a plant/crop signal
// - garden.cuisine.signal     : cuisine usage → variety/herb suggestions
// - garden.plan.suggestion    : aggregated suggestions ready for planner
// - engine.ready              : observability
//
// Defensive coding: all handlers bail early if payloads are malformed.

import eventBus from "../services/events/eventBus.js";
import dataGateway from "../services/dataGateway.js";
import featureFlags from "@/config/featureFlags.json";

const familyFundMode = !!featureFlags?.familyFundMode;

let HubPacketFormatter; // lazy-required to avoid node resolution in tests if not present
let FamilyFundConnector;

const SOURCE = "cooking.feedback.garden";

/* -------------------------------------------------------------------------------------------------
 * Catalog + Lexicon Integration
 * -------------------------------------------------------------------------------------------------
 *
 * This engine no longer hard-codes ingredient→plant maps.
 *
 * Instead it resolves signals through:
 *  1) Explicit fields on ingredient/inventory diffs (plantId / cropId / tags: "crop:tomato")
 *  2) SKU→crop mapping table (from SSA inventory/catalog layer)
 *  3) Ingredient lexicon (synonyms/keywords → crop ids)
 *  4) Cuisine profile catalog (anchors/variety nudges)
 *  5) Small heuristics fallback (pepper, leaf, etc.) ONLY if no catalogs are present
 *
 * Data sources are loaded through dataGateway with tolerant key discovery.
 *
 * Expected-ish shapes (tolerant):
 *  - Crops Catalog:
 *      { crops: [{ id, key?, name, category?, ediblePart?, demandThresholds? }, ...] }
 *      OR [{...}, {...}]
 *  - Ingredient Lexicon:
 *      { entries: [{ token, cropId, weight? }, ...] }
 *      OR { tokenToCrop: { "tomatoes":"tomato", ... } }
 *      OR [{ token, cropId }, ...]
 *  - Cuisine Profiles:
 *      { profiles: [{ id, name, tags?, gardenAnchors:[{ cropId, reason?, weight? }]|[cropId...] }, ...] }
 *      OR [{...}, {...}]
 *  - SKU mapping:
 *      { skuToCropId: { "SKU123":"tomato", ... } }
 *      OR [{ sku, cropId }, ...]
 *
 * Where these live (keys): your repo may vary. We try multiple keys and cache results.
 */

/* -------------------------------------------------------------------------------------------------
 * Cache / Loader
 * ------------------------------------------------------------------------------------------------- */

const CACHE = {
  loadedAt: 0,
  ttlMs: 5 * 60 * 1000, // 5 minutes (safe default)
  crops: new Map(), // cropId -> cropMeta
  lexTokenToCrop: new Map(), // normalized token -> cropId
  cuisineAnchorsByTag: new Map(), // cuisineTag/profileId/name -> [{cropId, weight, reason}]
  skuToCrop: new Map(), // sku -> cropId
  ready: false,
};

const DEFAULT_KEYS = Object.freeze({
  crops: [
    "catalog:garden.crops",
    "catalog:gardenCrops",
    "garden:crops",
    "layers:catalog:garden.crops",
    "layers:catalog:gardenCrops",
    "layerSpine:catalog:garden.crops",
  ],
  ingredientLexicon: [
    "lexicon:ingredients",
    "lexicon:ingredient",
    "layers:lexicon:ingredients",
    "layers:lexicons:ingredients",
    "layerSpine:lexicon:ingredients",
    "catalog:ingredients.lexicon",
  ],
  cuisineProfiles: [
    "catalog:cuisines",
    "catalog:cuisineProfiles",
    "layers:catalog:cuisines",
    "layers:catalog:cuisineProfiles",
    "layerSpine:catalog:cuisineProfiles",
  ],
  skuMap: [
    "table:inventory.skuToCrop",
    "inventory:skuToCrop",
    "layers:table:inventory.skuToCrop",
    "layerSpine:table:inventory.skuToCrop",
    "catalog:inventory.skuToCrop",
  ],
  // Optional: user/household overrides for mapping tokens→crop
  overrides: [
    "overrides:garden.mapping",
    "garden:mapping.overrides",
    "layers:overrides:garden.mapping",
    "layerSpine:overrides:garden.mapping",
  ],
});

/* -------------------------------------------------------------------------------------------------
 * Utilities
 * ------------------------------------------------------------------------------------------------- */

function tsISO() {
  return new Date().toISOString();
}

function payload(source, type, data) {
  return { type, ts: tsISO(), source, data };
}

function normalizeName(s) {
  if (!s || typeof s !== "string") return "";
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr || []) {
    if (v == null) continue;
    const k = typeof v === "string" ? v : JSON.stringify(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function asArrayMaybe(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (Array.isArray(x?.items)) return x.items;
  if (Array.isArray(x?.entries)) return x.entries;
  if (Array.isArray(x?.profiles)) return x.profiles;
  if (Array.isArray(x?.crops)) return x.crops;
  return [];
}

async function firstExistingValue(keys) {
  for (const k of keys) {
    try {
      const v = await dataGateway.get(k);
      if (v != null) return { key: k, value: v };
    } catch (_e) {
      // ignore
    }
  }
  return { key: null, value: null };
}

/* -------------------------------------------------------------------------------------------------
 * Catalog/Lexicon normalization
 * ------------------------------------------------------------------------------------------------- */

function indexCrops(cropsValue) {
  const crops = asArrayMaybe(cropsValue);
  const out = new Map();
  for (const c of crops) {
    if (!c) continue;
    const id = c.id || c.cropId || c.key || c.slug;
    if (!id) continue;
    out.set(String(id), {
      id: String(id),
      key: c.key ? String(c.key) : undefined,
      name: c.name || c.label || c.commonName || String(id),
      category: c.category || c.type || undefined, // "leafy", "fruit", "root", "herb", etc.
      ediblePart: c.ediblePart || c.part || undefined, // "leaf", "fruit", etc.
      demandThresholds: c.demandThresholds || c.thresholds || undefined, // optional
      ...c,
    });
  }
  return out;
}

function indexIngredientLexicon(lexValue) {
  const tokenToCrop = new Map();

  if (!lexValue) return tokenToCrop;

  // Shape: { tokenToCrop: { "tomato":"tomato", ... } }
  if (lexValue.tokenToCrop && typeof lexValue.tokenToCrop === "object") {
    for (const [token, cropId] of Object.entries(lexValue.tokenToCrop)) {
      const t = normalizeName(token);
      const c = cropId ? String(cropId) : "";
      if (t && c) tokenToCrop.set(t, c);
    }
  }

  // Shape: { entries:[{ token, cropId }] } OR array
  const entries = asArrayMaybe(lexValue);
  for (const e of entries) {
    const token = normalizeName(e?.token || e?.term || e?.name || "");
    const cropId = e?.cropId || e?.plantId || e?.value || e?.mapsTo;
    if (!token || !cropId) continue;
    tokenToCrop.set(token, String(cropId));

    // optional synonyms array
    if (Array.isArray(e?.synonyms)) {
      for (const syn of e.synonyms) {
        const s = normalizeName(syn);
        if (s) tokenToCrop.set(s, String(cropId));
      }
    }
  }

  return tokenToCrop;
}

function indexCuisineAnchors(cuisineValue) {
  const profiles = asArrayMaybe(cuisineValue);
  const byTag = new Map();

  for (const p of profiles) {
    if (!p) continue;

    const profileId = p.id ? String(p.id) : null;
    const profileName = p.name ? String(p.name) : null;
    const tags = uniq([
      ...(Array.isArray(p.tags) ? p.tags : []),
      ...(Array.isArray(p.cuisineTags) ? p.cuisineTags : []),
      ...(profileName ? [profileName] : []),
      ...(profileId ? [profileId] : []),
    ])
      .map((t) => String(t))
      .filter(Boolean);

    // anchors can be [cropId...] or [{cropId, reason, weight}...]
    let anchorsRaw = p.gardenAnchors || p.anchors || p.garden || p.plants || [];
    if (
      Array.isArray(anchorsRaw) &&
      anchorsRaw.length &&
      typeof anchorsRaw[0] === "string"
    ) {
      anchorsRaw = anchorsRaw.map((cropId) => ({
        cropId,
        weight: 1,
        reason: "cuisine_anchor",
      }));
    }
    if (!Array.isArray(anchorsRaw)) anchorsRaw = [];

    const anchors = anchorsRaw
      .map((a) => {
        const cropId = a?.cropId || a?.plantId || a?.id || a;
        if (!cropId) return null;
        return {
          cropId: String(cropId),
          weight: Number.isFinite(a?.weight) ? a.weight : 1,
          reason: a?.reason || a?.note || "cuisine_anchor",
        };
      })
      .filter(Boolean);

    for (const t of tags) {
      const key = String(t);
      const cur = byTag.get(key) || [];
      byTag.set(key, cur.concat(anchors));
    }
  }

  // Deduplicate per tag by cropId (keep max weight)
  for (const [tag, anchors] of byTag.entries()) {
    const best = new Map();
    for (const a of anchors) {
      const cur = best.get(a.cropId);
      if (!cur || (a.weight ?? 1) > (cur.weight ?? 1)) best.set(a.cropId, a);
    }
    byTag.set(tag, Array.from(best.values()));
  }

  return byTag;
}

function indexSkuMap(skuValue) {
  const out = new Map();

  if (!skuValue) return out;

  // Shape: { skuToCropId: { "SKU":"tomato" } }
  if (skuValue.skuToCropId && typeof skuValue.skuToCropId === "object") {
    for (const [sku, cropId] of Object.entries(skuValue.skuToCropId)) {
      if (!sku || !cropId) continue;
      out.set(String(sku), String(cropId));
    }
  }

  // Shape: array [{sku, cropId}]
  const rows = asArrayMaybe(skuValue);
  for (const r of rows) {
    const sku = r?.sku || r?.id;
    const cropId = r?.cropId || r?.plantId || r?.mapsTo;
    if (!sku || !cropId) continue;
    out.set(String(sku), String(cropId));
  }

  return out;
}

function parseOverrides(overridesValue) {
  // overrides: { tokenToCrop: {...}, skuToCropId: {...} } or similar
  const tokenToCrop = new Map();
  const skuToCrop = new Map();

  if (!overridesValue || typeof overridesValue !== "object") {
    return { tokenToCrop, skuToCrop };
  }

  const ttc =
    overridesValue.tokenToCrop ||
    overridesValue.ingredientToCrop ||
    overridesValue.ingredientMap;
  if (ttc && typeof ttc === "object") {
    for (const [k, v] of Object.entries(ttc)) {
      const token = normalizeName(k);
      if (token && v) tokenToCrop.set(token, String(v));
    }
  }

  const stc =
    overridesValue.skuToCropId ||
    overridesValue.skuToCrop ||
    overridesValue.skuMap;
  if (stc && typeof stc === "object") {
    for (const [k, v] of Object.entries(stc)) {
      if (k && v) skuToCrop.set(String(k), String(v));
    }
  }

  return { tokenToCrop, skuToCrop };
}

/* -------------------------------------------------------------------------------------------------
 * Loader (public-ish internal)
 * ------------------------------------------------------------------------------------------------- */

async function ensureCatalogsLoaded(force = false) {
  const now = Date.now();
  if (!force && CACHE.ready && now - CACHE.loadedAt < CACHE.ttlMs) return;

  const cropsRes = await firstExistingValue(DEFAULT_KEYS.crops);
  const lexRes = await firstExistingValue(DEFAULT_KEYS.ingredientLexicon);
  const cuisineRes = await firstExistingValue(DEFAULT_KEYS.cuisineProfiles);
  const skuRes = await firstExistingValue(DEFAULT_KEYS.skuMap);
  const overridesRes = await firstExistingValue(DEFAULT_KEYS.overrides);

  const crops = indexCrops(cropsRes.value);
  const lexTokenToCrop = indexIngredientLexicon(lexRes.value);
  const cuisineAnchorsByTag = indexCuisineAnchors(cuisineRes.value);
  const skuToCrop = indexSkuMap(skuRes.value);

  const overrides = parseOverrides(overridesRes.value);
  // apply overrides (overrides win)
  for (const [t, c] of overrides.tokenToCrop.entries())
    lexTokenToCrop.set(t, c);
  for (const [s, c] of overrides.skuToCrop.entries()) skuToCrop.set(s, c);

  CACHE.crops = crops;
  CACHE.lexTokenToCrop = lexTokenToCrop;
  CACHE.cuisineAnchorsByTag = cuisineAnchorsByTag;
  CACHE.skuToCrop = skuToCrop;

  CACHE.loadedAt = now;
  CACHE.ready = true;

  // Emit for observability (but keep it lightweight)
  eventBus.emit(
    payload(SOURCE, "engine.catalogs.loaded", {
      crops: CACHE.crops.size,
      lexiconTokens: CACHE.lexTokenToCrop.size,
      cuisineKeys: CACHE.cuisineAnchorsByTag.size,
      skuMappings: CACHE.skuToCrop.size,
      keys: {
        cropsKey: cropsRes.key,
        lexiconKey: lexRes.key,
        cuisineKey: cuisineRes.key,
        skuKey: skuRes.key,
        overridesKey: overridesRes.key,
      },
    })
  );
}

/* -------------------------------------------------------------------------------------------------
 * Resolution (ingredient/inventory diff → cropId)
 * ------------------------------------------------------------------------------------------------- */

function extractTaggedCropId(tags) {
  const arr = Array.isArray(tags) ? tags : [];
  for (const tRaw of arr) {
    if (!tRaw) continue;
    const t = String(tRaw);
    // Accept: "crop:tomato", "plant:tomato", "garden:tomato", "cropId=tomato"
    const m1 = t.match(/^(?:crop|plant|garden)\s*[:=]\s*(.+)$/i);
    if (m1?.[1]) return normalizeName(m1[1]).replace(/\s+/g, "_");
    const m2 = t.match(/(?:^|\s)cropId\s*=\s*([A-Za-z0-9_\-]+)/i);
    if (m2?.[1]) return String(m2[1]);
  }
  return null;
}

function resolveCropIdFromToken(token) {
  const t = normalizeName(token);
  if (!t) return null;

  // Exact token
  if (CACHE.lexTokenToCrop.has(t)) return CACHE.lexTokenToCrop.get(t);

  // Common lightweight tokenization fallbacks:
  // "tomatoes, chopped" → "tomatoes"
  const stripped = t
    .replace(/[(),]/g, " ")
    .replace(
      /\b(chopped|diced|minced|sliced|fresh|frozen|dried|ground|powder|seed|seeds|leaf|leaves)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
  if (stripped && CACHE.lexTokenToCrop.has(stripped))
    return CACHE.lexTokenToCrop.get(stripped);

  // Singular/plural try:
  if (stripped.endsWith("es")) {
    const s = stripped.slice(0, -2);
    if (CACHE.lexTokenToCrop.has(s)) return CACHE.lexTokenToCrop.get(s);
  }
  if (stripped.endsWith("s")) {
    const s = stripped.slice(0, -1);
    if (CACHE.lexTokenToCrop.has(s)) return CACHE.lexTokenToCrop.get(s);
  }

  // Heuristic-only fallback if catalogs are missing
  // (kept minimal, because your lexicons should own the real mapping)
  if (CACHE.lexTokenToCrop.size === 0) {
    if (/\bpepper\b|\bchili\b/.test(t)) return "capsicum_generic";
    if (/\b(onion|scallion|shallot)\b/.test(t)) return "onion_bulb";
    if (/\bgarlic\b/.test(t)) return "garlic";
    if (/\btomato\b/.test(t)) return "tomato";
    if (/\bcilantro\b|\bcoriander\b/.test(t)) return "cilantro_coriander_leaf";
    if (/\bparsley\b/.test(t)) return "parsley";
    if (/\bbasil\b/.test(t)) return "basil";
    if (/\bspinach\b/.test(t)) return "spinach";
  }

  return null;
}

async function resolveCropIdFromIngredient(ing) {
  if (!ing) return null;

  // 1) explicit fields (future-proof)
  const explicit =
    ing.cropId ||
    ing.plantId ||
    ing.gardenCropId ||
    ing.canonicalCropId ||
    ing.canonicalId;
  if (explicit) return String(explicit);

  // 2) tags (crop:tomato)
  const tagged = extractTaggedCropId(ing.tags);
  if (tagged) return String(tagged);

  // 3) SKU mapping
  if (ing.sku && CACHE.skuToCrop.has(String(ing.sku))) {
    return CACHE.skuToCrop.get(String(ing.sku));
  }

  // 4) ingredient lexicon by name token
  if (ing.name) {
    const byToken = resolveCropIdFromToken(ing.name);
    if (byToken) return byToken;
  }

  // 5) classId (if you have class lexicons later)
  if (ing.classId) {
    const byClass = resolveCropIdFromToken(String(ing.classId));
    if (byClass) return byClass;
  }

  return null;
}

async function resolveCropIdFromInventoryDiff(d) {
  if (!d) return null;

  // explicit
  const explicit = d.cropId || d.plantId || d.gardenCropId;
  if (explicit) return String(explicit);

  // tags if present (some inventory diff producers include tags)
  const tagged = extractTaggedCropId(d.tags);
  if (tagged) return String(tagged);

  // SKU mapping
  if (d.sku && CACHE.skuToCrop.has(String(d.sku)))
    return CACHE.skuToCrop.get(String(d.sku));

  // name token
  if (d.name) {
    const byToken = resolveCropIdFromToken(d.name);
    if (byToken) return byToken;
  }

  return null;
}

/* -------------------------------------------------------------------------------------------------
 * Quantity normalization
 * ------------------------------------------------------------------------------------------------- */

const UNIT_WEIGHTS = Object.freeze({
  gram: 1,
  g: 1,
  kg: 1000,
  ounce: 28.3495,
  oz: 28.3495,
  lb: 453.592,
  pound: 453.592,
  lbs: 453.592,
  // everything else treated as unknown mass
});

function toGrams(qty, unit) {
  if (qty == null) return { grams: null, approx: true };
  if (!unit) return { grams: null, approx: true };
  const u = normalizeName(unit);
  const factor = UNIT_WEIGHTS[u];
  if (!factor) return { grams: null, approx: true };
  const n = Number(qty);
  if (!Number.isFinite(n)) return { grams: null, approx: true };
  return { grams: n * factor, approx: false };
}

/* -------------------------------------------------------------------------------------------------
 * Demand storage + aggregation
 * ------------------------------------------------------------------------------------------------- */

async function recordDemand(cropId, grams, context) {
  if (!cropId) return;

  await dataGateway.transact(async (tx) => {
    const key = `gardenDemand:${cropId}`;
    const current = (await tx.get(key)) || {
      cropId,
      totalGrams: 0,
      events: [],
      lastUsedISO: null,
    };

    const next = {
      ...current,
      totalGrams: current.totalGrams + (Number.isFinite(grams) ? grams : 0),
      lastUsedISO: tsISO(),
      events: current.events.slice(-49).concat({
        at: tsISO(),
        grams: Number.isFinite(grams) ? grams : null,
        ctx: context || null,
      }),
    };

    await tx.set(key, next);
  });
}

async function getUsageSumDays(cropId, days = 30) {
  const rec = await dataGateway.get(`gardenDemand:${cropId}`);
  if (!rec || !Array.isArray(rec.events)) return 0;
  const cutoff = Date.now() - days * 86400000;

  let sum = 0;
  for (const e of rec.events) {
    const t = Date.parse(e?.at || "");
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (Number.isFinite(e?.grams)) sum += e.grams;
  }
  return sum;
}

/* -------------------------------------------------------------------------------------------------
 * Hub export (optional)
 * ------------------------------------------------------------------------------------------------- */

async function exportToHubIfEnabled(eventPayload) {
  try {
    if (!familyFundMode) return;
    HubPacketFormatter ||= (
      await import("@/services/hub/HubPacketFormatter.js")
    ).default;
    FamilyFundConnector ||= (
      await import("@/services/hub/FamilyFundConnector.js")
    ).default;
    const packet = HubPacketFormatter.format(eventPayload);
    await FamilyFundConnector.send(packet);
  } catch (_err) {
    // fail silent by requirement
  }
}

/* -------------------------------------------------------------------------------------------------
 * Cuisine anchors (from cuisine profiles catalog)
 * ------------------------------------------------------------------------------------------------- */

function resolveCuisineKeysFromMeal(evtData) {
  const keys = [];

  // explicit profile id
  if (evtData?.cuisineProfileId) keys.push(String(evtData.cuisineProfileId));

  // cuisineTags list
  if (Array.isArray(evtData?.cuisineTags)) {
    for (const t of evtData.cuisineTags) if (t) keys.push(String(t));
  }

  // sometimes meal.executed includes cuisineTags as string
  if (typeof evtData?.cuisineTags === "string" && evtData.cuisineTags.trim()) {
    keys.push(evtData.cuisineTags.trim());
  }

  // optional: ingredient-level tags that include "cuisine:Indian"
  const ings = Array.isArray(evtData?.ingredients) ? evtData.ingredients : [];
  for (const ing of ings) {
    const tags = Array.isArray(ing?.tags) ? ing.tags : [];
    for (const tag of tags) {
      const m = String(tag || "").match(/^cuisine\s*[:=]\s*(.+)$/i);
      if (m?.[1]) keys.push(m[1].trim());
    }
  }

  return uniq(keys);
}

function getCuisineAnchorSuggestions(cuisineKeys) {
  const suggestions = [];
  for (const k of cuisineKeys || []) {
    const anchors = CACHE.cuisineAnchorsByTag.get(String(k)) || [];
    for (const a of anchors) suggestions.push({ ...a, from: String(k) });
  }

  // Dedup cropId, keep max weight, and retain combined sources
  const best = new Map();
  for (const s of suggestions) {
    const cur = best.get(s.cropId);
    if (!cur) {
      best.set(s.cropId, { ...s, sources: [s.from] });
      continue;
    }
    const wNew = s.weight ?? 1;
    const wCur = cur.weight ?? 1;
    const merged = {
      ...cur,
      weight: Math.max(wCur, wNew),
      reason: cur.reason || s.reason,
      sources: uniq([...(cur.sources || []), s.from]),
    };
    best.set(s.cropId, merged);
  }

  return Array.from(best.values()).sort(
    (a, b) => (b.weight ?? 1) - (a.weight ?? 1)
  );
}

/* -------------------------------------------------------------------------------------------------
 * Plan suggestion logic (uses crop meta where possible)
 * ------------------------------------------------------------------------------------------------- */

function cropIsLeafy(cropMetaOrId) {
  const id = typeof cropMetaOrId === "string" ? cropMetaOrId : cropMetaOrId?.id;
  const meta =
    typeof cropMetaOrId === "string" ? CACHE.crops.get(id) : cropMetaOrId;
  const category = normalizeName(meta?.category || "");
  const part = normalizeName(meta?.ediblePart || "");

  // Prefer explicit meta
  if (category) {
    if (/(leaf|leafy|herb)/.test(category)) return true;
    if (/(root|tuber|fruit|seed)/.test(category)) return false;
  }
  if (part) {
    if (/(leaf)/.test(part)) return true;
    if (/(fruit|root|tuber|seed)/.test(part)) return false;
  }

  // minimal fallback (should be avoided if catalog is rich)
  return /leaf|basil|cilantro|parsley|chives|mint|shiso|epazote|culantro|methi/.test(
    String(id || "")
  );
}

function resolveThresholdsForCrop(cropId) {
  const meta = CACHE.crops.get(String(cropId));
  const isLeaf = cropIsLeafy(meta || cropId);

  // If catalog defines thresholds, honor them.
  // Expected:
  //   demandThresholds: { windowDays:30, gramsPerWindow: 400, actions:[...] }
  const t = meta?.demandThresholds;
  if (t && typeof t === "object") {
    return {
      windowDays: Number.isFinite(t.windowDays) ? t.windowDays : 30,
      gramsPerWindow: Number.isFinite(t.gramsPerWindow)
        ? t.gramsPerWindow
        : isLeaf
        ? 60
        : 400,
      actions: Array.isArray(t.actions)
        ? t.actions
        : isLeaf
        ? ["succession_sow_every_2_weeks", "increase_container_count_by_1"]
        : ["start_seedlings_now", "stagger_transplants_every_2_weeks"],
    };
  }

  // Default heuristic
  return {
    windowDays: 30,
    gramsPerWindow: isLeaf ? 60 : 400,
    actions: isLeaf
      ? ["succession_sow_every_2_weeks", "increase_container_count_by_1"]
      : ["start_seedlings_now", "stagger_transplants_every_2_weeks"],
  };
}

async function maybeEmitPlanSuggestion(opts = {}) {
  const maxSuggestions = Number.isFinite(opts.maxSuggestions)
    ? opts.maxSuggestions
    : 24;

  // Candidate set:
  //   - any crop used recently (demand keys exist)
  //   - plus any cuisine anchors (nudges)
  //
  // We discover used crops via keys list if available; otherwise fall back to crop catalog.
  let candidateCropIds = [];

  try {
    // If your dataGateway supports listing keys, it might be `dataGateway.keys(prefix)`.
    // We do NOT assume it exists. If it does, great. If not, we fall back.
    if (typeof dataGateway.keys === "function") {
      const keys = await dataGateway.keys("gardenDemand:");
      if (Array.isArray(keys)) {
        candidateCropIds = keys
          .map((k) => String(k).replace(/^gardenDemand:/, ""))
          .filter(Boolean);
      }
    }
  } catch (_e) {
    // ignore
  }

  // fallback: crop catalog ids (still OK, just heavier)
  if (!candidateCropIds.length) {
    candidateCropIds = Array.from(CACHE.crops.keys());
  }

  // If even that is empty, nothing to suggest.
  candidateCropIds = uniq(candidateCropIds).filter(Boolean);
  if (!candidateCropIds.length) return;

  const suggestions = [];

  for (const cropId of candidateCropIds) {
    const th = resolveThresholdsForCrop(cropId);
    const sum = await getUsageSumDays(cropId, th.windowDays);

    if (sum >= th.gramsPerWindow) {
      const meta = CACHE.crops.get(String(cropId));
      suggestions.push({
        cropId: String(cropId),
        cropName: meta?.name || undefined,
        windowDays: th.windowDays,
        usageGrams: Math.round(sum),
        thresholdGrams: th.gramsPerWindow,
        reason: `usage_${th.windowDays}d≈${Math.round(sum)}g ≥ ${
          th.gramsPerWindow
        }g`,
        actions: th.actions,
      });
    }
  }

  if (!suggestions.length) return;

  // sort highest usage ratio first
  suggestions.sort(
    (a, b) => b.usageGrams / b.thresholdGrams - a.usageGrams / a.thresholdGrams
  );

  const planPayload = payload(SOURCE, "garden.plan.suggestion", {
    suggestions: suggestions.slice(0, maxSuggestions),
    hint: "Feed to GardenPlanning engine to merge with zone/bed capacity + season windows.",
  });

  eventBus.emit(planPayload);
  exportToHubIfEnabled(planPayload);
}

/* -------------------------------------------------------------------------------------------------
 * Event handlers
 * ------------------------------------------------------------------------------------------------- */

async function onMealExecuted(evt) {
  const data = evt?.data;
  if (!data || !Array.isArray(data.ingredients)) return;

  await ensureCatalogsLoaded(false);

  const portions = Number.isFinite(data.portions) ? data.portions : null;
  const cuisineKeys = resolveCuisineKeysFromMeal(data);

  // 1) Ingredient usage → demand increments
  for (const ing of data.ingredients) {
    if (!ing) continue;

    // Resolve cropId via catalogs/lexicons/tables
    const cropId = await resolveCropIdFromIngredient(ing);
    if (!cropId) continue;

    const { grams } = toGrams(ing.qty, ing.unit);

    const ctx = {
      mealId: data.id || null,
      portions,
      src: "meal.executed",
      cuisineKeys,
      raw: {
        name: ing.name ?? null,
        qty: ing.qty ?? null,
        unit: ing.unit ?? null,
        sku: ing.sku ?? null,
        tags: Array.isArray(ing.tags) ? ing.tags : null,
      },
    };

    await recordDemand(cropId, grams ?? 0, ctx);

    const incPayload = payload(SOURCE, "garden.demand.incremented", {
      cropId,
      grams: grams ?? null,
      approx: grams == null,
      mealId: data.id || null,
      portions,
    });

    eventBus.emit(incPayload);
    exportToHubIfEnabled(incPayload);
  }

  // 2) Cuisine anchors → variety/herb suggestions (catalog-driven)
  if (cuisineKeys.length) {
    const anchors = getCuisineAnchorSuggestions(cuisineKeys);

    if (anchors.length) {
      const sigPayload = payload(SOURCE, "garden.cuisine.signal", {
        cuisineKeys,
        suggestedCrops: anchors.map((a) => ({
          cropId: a.cropId,
          cropName: CACHE.crops.get(a.cropId)?.name,
          weight: a.weight ?? 1,
          reason: a.reason,
          sources: a.sources || [a.from],
        })),
      });

      eventBus.emit(sigPayload);
      exportToHubIfEnabled(sigPayload);
    }
  }

  // 3) Aggregation hint
  await maybeEmitPlanSuggestion();
}

async function onInventoryUpdated(evt) {
  const diffs = evt?.data?.diffs;
  if (!Array.isArray(diffs) || !diffs.length) return;

  await ensureCatalogsLoaded(false);

  for (const d of diffs) {
    if (!d || typeof d.delta !== "number") continue;

    // consumption only (negative delta)
    if (d.delta >= 0) continue;

    const cropId = await resolveCropIdFromInventoryDiff(d);
    if (!cropId) continue;

    // If unit unknown, use a small symbolic bump (still useful for trends)
    const grams = d.unit ? toGrams(Math.abs(d.delta), d.unit).grams : null;
    const gramsEff = Number.isFinite(grams) ? grams : 50;

    await recordDemand(cropId, gramsEff, {
      src: "inventory.updated",
      reason: evt?.data?.reason || null,
      raw: {
        sku: d.sku ?? null,
        name: d.name ?? null,
        delta: d.delta,
        unit: d.unit ?? null,
        domain: d.domain ?? null,
      },
    });

    const incPayload = payload(SOURCE, "garden.demand.incremented", {
      cropId,
      grams: Number.isFinite(grams) ? grams : null,
      approx: !Number.isFinite(grams),
      reason: evt?.data?.reason || null,
    });

    eventBus.emit(incPayload);
    exportToHubIfEnabled(incPayload);
  }

  await maybeEmitPlanSuggestion();
}

/* -------------------------------------------------------------------------------------------------
 * Engine lifecycle
 * ------------------------------------------------------------------------------------------------- */

let _bound = false;
let _disposeFns = [];

function bind(eventName, handler) {
  eventBus.on(eventName, handler);
  _disposeFns.push(() => {
    try {
      if (typeof eventBus.off === "function") eventBus.off(eventName, handler);
    } catch (_e) {
      // ignore
    }
  });
}

async function reloadCatalogs() {
  await ensureCatalogsLoaded(true);
}

/**
 * Initialize the feedback engine and bind event listeners.
 * @param {object} [opts] optional configuration overrides
 * @param {string[]} [opts.consume] event types to consume
 * @param {number} [opts.catalogTtlMs] override catalog cache TTL
 * @param {boolean} [opts.forceCatalogLoad] load catalogs immediately
 */
function init(opts = {}) {
  if (_bound) return api(); // idempotent

  const consume = new Set(
    Array.isArray(opts.consume) && opts.consume.length
      ? opts.consume
      : ["meal.executed", "inventory.updated"]
  );

  if (Number.isFinite(opts.catalogTtlMs) && opts.catalogTtlMs > 10_000) {
    CACHE.ttlMs = opts.catalogTtlMs;
  }

  if (consume.has("meal.executed")) bind("meal.executed", onMealExecuted);
  if (consume.has("inventory.updated"))
    bind("inventory.updated", onInventoryUpdated);

  // Optional: if your layer spine emits something like "layers.updated" or "catalogs.updated",
  // we listen and refresh our caches. This is safe even if never emitted.
  bind("layers.updated", reloadCatalogs);
  bind("catalogs.updated", reloadCatalogs);
  bind("lexicons.updated", reloadCatalogs);

  _bound = true;

  if (opts.forceCatalogLoad) {
    // best-effort load
    ensureCatalogsLoaded(true).catch(() => {});
  }

  eventBus.emit(
    payload(SOURCE, "engine.ready", {
      engine: "cookingFeedbackToGarden",
      consume: Array.from(consume),
      catalogTtlMs: CACHE.ttlMs,
    })
  );

  return api();
}

function dispose() {
  for (const fn of _disposeFns) {
    try {
      fn();
    } catch (_e) {
      // ignore
    }
  }
  _disposeFns = [];
  _bound = false;
}

function api() {
  return {
    dispose,
    reloadCatalogs,

    // test hooks
    _ensureCatalogsLoaded: ensureCatalogsLoaded,
    _resolveCropIdFromToken: resolveCropIdFromToken,
    _resolveCropIdFromIngredient: resolveCropIdFromIngredient,
    _resolveCropIdFromInventoryDiff: resolveCropIdFromInventoryDiff,
    _toGrams: toGrams,
    _maybeEmitPlanSuggestion: maybeEmitPlanSuggestion,
    _cacheSnapshot: () => ({
      loadedAt: CACHE.loadedAt,
      ttlMs: CACHE.ttlMs,
      crops: CACHE.crops.size,
      lexiconTokens: CACHE.lexTokenToCrop.size,
      cuisineKeys: CACHE.cuisineAnchorsByTag.size,
      skuMappings: CACHE.skuToCrop.size,
      ready: CACHE.ready,
    }),
  };
}

export default {
  init,
  dispose,
};
