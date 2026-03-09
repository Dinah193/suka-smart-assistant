// File: C:\Users\larho\suka-smart-assistant\src\services\imports\ImportIntelligenceService.js
/**
 * ImportIntelligenceService (SSA)
 * -----------------------------------------------------------------------------
 * "L0→L1 Intelligence" for imports/ingest.
 *
 * Purpose
 *  - Given a raw artifact (upload, pasted text, scan output), infer:
 *      • what it likely is (receipt, recipe, meal plan, cleaning plan, calendar, note)
 *      • what SSA domain(s) it touches (shopping, inventory, meals, cooking, cleaning, garden, animals)
 *      • what parser/router to use next (if available)
 *      • what next-actions to suggest to the UI ("Commit to inventory", "Create cooking session", etc.)
 *  - Provide a consistent, production-safe interface even when optional
 *    services/tables/parsers are missing.
 *
 * Design constraints
 *  - Browser-safe (no Node imports)
 *  - Tolerant: any optional dependency may not exist
 *  - Cacheable: uses ImportCacheService (if present) and/or Dexie parse_cache table
 *  - Event-driven: emits to eventBus + automation bus (if present)
 *
 * Expected upstream inputs
 *  - artifact object (recommended shape):
 *      {
 *        id, kind: "text"|"image"|"pdf"|"json",
 *        source: "scanner"|"paste"|"upload"|"api",
 *        mime, filename,
 *        rawText?, rawJson?, rawBytesRef?,
 *        createdAt, meta: { ... }
 *      }
 *
 * Public API
 *  - analyzeArtifact(artifact, options?)
 *  - analyzeText(text, options?)
 *  - analyzeCandidates(candidates, options?)
 *  - suggestNextActions(analysis, context?)
 *  - getHeuristicsVersion()
 *
 * Notes
 *  - This service is not an OCR engine. If you pass images/PDF, provide extracted text
 *    (from your scanner or other layer) in artifact.rawText when possible.
 */

import db from "@/services/db";

/* -----------------------------------------------------------------------------
 * Optional deps (soft)
 * -------------------------------------------------------------------------- */

let logger = null;
try {
  const mod = await import("@/utils/logger.js");
  logger = mod?.default ?? mod ?? null;
} catch {
  logger = null;
}

let eventBus = null;
try {
  const mod = await import("@/services/events/eventBus");
  eventBus = mod?.default ?? mod ?? null;
} catch {
  eventBus = null;
}

let autoBus = null;
try {
  const mod = await import("@/services/automation/eventBus.js");
  autoBus = mod?.default ?? mod ?? null;
} catch {
  autoBus = null;
}

let ImportCacheService = null;
try {
  const mod = await import("@/services/imports/ImportCacheService.js");
  ImportCacheService = mod?.default ?? mod ?? null;
} catch {
  ImportCacheService = null;
}

// Optional router/ingest services (only used if present)
let UploadIngestService = null;
try {
  const mod = await import("@/services/imports/UploadIngestService.js");
  UploadIngestService = mod?.default ?? mod ?? null;
} catch {
  UploadIngestService = null;
}

let ImportRouter = null;
try {
  const mod = await import("@/services/imports/ImportRouter.js");
  ImportRouter = mod?.default ?? mod ?? null;
} catch {
  ImportRouter = null;
}

/* -----------------------------------------------------------------------------
 * Constants / Versioning
 * -------------------------------------------------------------------------- */

const SOURCE = "services.imports.ImportIntelligenceService";

// Bump this if you change heuristics in ways that should invalidate cache.
const HEURISTICS_VERSION = "1.0.0";

// Cache keys
const CACHE_PREFIX = "importIntel";
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/* -----------------------------------------------------------------------------
 * Lightweight helpers
 * -------------------------------------------------------------------------- */

function safeObj(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}
function safeArr(x) {
  return Array.isArray(x) ? x : [];
}
function nowMs() {
  return Date.now();
}
function nowISO() {
  return new Date().toISOString();
}
function clamp(n, a, b) {
  const v = Number(n);
  if (!Number.isFinite(v)) return a;
  return Math.max(a, Math.min(b, v));
}
function emit(name, payload) {
  try {
    eventBus?.emit?.(name, payload);
  } catch {}
  try {
    autoBus?.emit?.(name, payload);
  } catch {}
}
function warn(msg, meta) {
  try {
    logger?.warn?.(msg, meta, { source: SOURCE });
  } catch {}
}
function info(msg, meta) {
  try {
    logger?.info?.(msg, meta, { source: SOURCE });
  } catch {}
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\r\n/g, "\n")
    .trim();
}

function hashString(input) {
  // Fast non-crypto hash (FNV-1a-ish)
  const s = String(input || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function fingerprintArtifact(artifact) {
  const a = safeObj(artifact);
  const parts = [
    HEURISTICS_VERSION,
    a.id || "",
    a.kind || "",
    a.mime || "",
    a.filename || "",
    a.source || "",
    a.createdAt || "",
    a.rawText ? hashString(String(a.rawText).slice(0, 12000)) : "",
    a.rawJson ? hashString(JSON.stringify(a.rawJson).slice(0, 12000)) : "",
  ];
  return hashString(parts.join("|"));
}

function scoreAdd(map, key, delta) {
  map[key] = (map[key] || 0) + delta;
}

function topKScoreMap(map, k = 5) {
  return Object.entries(map)
    .sort((a, b) => (b[1] || 0) - (a[1] || 0))
    .slice(0, k)
    .map(([name, score]) => ({ name, score }));
}

/* -----------------------------------------------------------------------------
 * Dexie parse_cache integration (optional)
 * -------------------------------------------------------------------------- */

const PARSE_CACHE_TABLE_CANDIDATES = [
  "parse_cache",
  "parseCache",
  "import_cache",
  "importCache",
];

function resolveParseCacheTable() {
  for (const n of PARSE_CACHE_TABLE_CANDIDATES) {
    const t = db?.[n];
    if (t && typeof t.get === "function" && typeof t.put === "function")
      return t;
  }
  try {
    const tables = db?.tables || [];
    for (const n of PARSE_CACHE_TABLE_CANDIDATES) {
      const hit = tables.find((t) => t?.name === n);
      if (hit) return hit;
    }
  } catch {}
  return null;
}

async function cacheGetDexie(key) {
  const t = resolveParseCacheTable();
  if (!t) return null;
  try {
    const row = await t.get(key);
    if (!row) return null;
    const expiresAt = Number(row.expiresAt || 0);
    if (expiresAt && expiresAt < nowMs()) return null;
    return row.value ?? row.data ?? null;
  } catch {
    return null;
  }
}

async function cacheSetDexie(key, value, ttlMs) {
  const t = resolveParseCacheTable();
  if (!t) return false;
  try {
    await t.put({
      id: key,
      value,
      updatedAt: nowMs(),
      expiresAt: ttlMs ? nowMs() + ttlMs : null,
      source: SOURCE,
      version: HEURISTICS_VERSION,
    });
    return true;
  } catch {
    return false;
  }
}

/* -----------------------------------------------------------------------------
 * Heuristic lexicons (keep small & practical)
 * -------------------------------------------------------------------------- */

const RX = {
  money: /\$?\s?\b\d{1,3}(?:,\d{3})*(?:\.\d{2})\b/g,
  dateLike:
    /\b(?:\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\b/g,
  timeLike: /\b\d{1,2}:\d{2}\s?(?:AM|PM|am|pm)?\b/g,
  qtyUnit:
    /\b(\d+(?:\.\d+)?)\s?(oz|ounce|ounces|lb|lbs|pound|pounds|g|kg|ml|l|tsp|tbsp|cup|cups|qt|quart|gal|gallon|pack|ct|count)\b/gi,
  upcLike: /\b\d{12,14}\b/g,
  percent: /\b\d{1,3}%\b/g,
};

const LEX = {
  receipt: [
    "subtotal",
    "total",
    "tax",
    "change",
    "tender",
    "cash",
    "credit",
    "debit",
    "visa",
    "mastercard",
    "amex",
    "discover",
    "auth",
    "approval",
    "approved",
    "transaction",
    "register",
    "store",
    "cashier",
    "receipt",
    "refund",
    "return",
    "balance due",
    "loyalty",
    "member",
    "points",
    "savings",
    "coupon",
    "discount",
    "sale",
    "void",
    "item",
    "qty",
    "unit price",
  ],
  recipe: [
    "ingredients",
    "directions",
    "instructions",
    "prep",
    "cook time",
    "servings",
    "yield",
    "preheat",
    "bake",
    "stir",
    "simmer",
    "boil",
    "chop",
    "mince",
    "saute",
    "tablespoon",
    "teaspoon",
    "cup",
    "cups",
    "oz",
    "lb",
    "lbs",
    "salt",
    "pepper",
  ],
  mealPlan: [
    "meal plan",
    "breakfast",
    "lunch",
    "dinner",
    "snack",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "week",
    "menu",
  ],
  cleaning: [
    "clean",
    "cleaning",
    "tidy",
    "declutter",
    "wipe",
    "mop",
    "vacuum",
    "dust",
    "laundry",
    "bathroom",
    "kitchen",
    "bedroom",
    "living room",
    "schedule",
    "checklist",
  ],
  calendar: [
    "event",
    "calendar",
    "appointment",
    "schedule",
    "reminder",
    "starts",
    "ends",
    "location",
    "invite",
    "attendees",
  ],
  inventory: [
    "pantry",
    "storehouse",
    "inventory",
    "par level",
    "restock",
    "low stock",
    "on hand",
    "unit",
    "location",
    "bin",
    "shelf",
  ],
  gardening: [
    "harvest",
    "seed",
    "plant",
    "garden",
    "beds",
    "transplant",
    "sprout",
    "compost",
  ],
  animals: [
    "feed",
    "pasture",
    "butcher",
    "lamb",
    "goat",
    "chicken",
    "coop",
    "vaccination",
  ],
};

/* -----------------------------------------------------------------------------
 * Classification core
 * -------------------------------------------------------------------------- */

function classifyTextHeuristic(text, options = {}) {
  const opts = safeObj(options);
  const t = normalizeText(text);
  const lower = t.toLowerCase();

  const scores = {}; // label -> score
  const evidence = []; // { label, rule, weight, sample? }

  function hit(label, rule, weight, sample) {
    scoreAdd(scores, label, weight);
    evidence.push({ label, rule, weight, sample: sample || null });
  }

  // Keyword hits
  for (const [label, words] of Object.entries(LEX)) {
    let c = 0;
    for (const w of words) {
      if (!w) continue;
      if (lower.includes(w)) c++;
    }
    if (c) hit(label, "keyword_hits", clamp(c, 1, 8) * 3, `${c} hits`);
  }

  // Receipt-like formatting cues
  const moneyCount = (t.match(RX.money) || []).length;
  const dateCount = (t.match(RX.dateLike) || []).length;
  const timeCount = (t.match(RX.timeLike) || []).length;
  const upcCount = (t.match(RX.upcLike) || []).length;
  const unitCount = (t.match(RX.qtyUnit) || []).length;
  const pctCount = (t.match(RX.percent) || []).length;

  if (moneyCount >= 4)
    hit("receipt", "many_money_values", 12, String(moneyCount));
  if (moneyCount >= 8)
    hit("receipt", "very_many_money_values", 10, String(moneyCount));
  if (dateCount >= 1 && timeCount >= 1)
    hit(
      "receipt",
      "date_and_time_present",
      6,
      `${dateCount} dates, ${timeCount} times`
    );
  if (upcCount >= 1) hit("receipt", "upc_present", 8, String(upcCount));
  if (pctCount >= 1) hit("receipt", "percent_present", 3, String(pctCount));

  // Recipe cues: lots of units, line breaks, imperative verbs
  const lines = t.split("\n").filter(Boolean);
  const longLines = lines.filter((l) => l.length > 35).length;
  const unitHeavy = unitCount >= 6 || (unitCount >= 3 && lines.length >= 8);

  if (unitHeavy) hit("recipe", "quantity_units_present", 10, String(unitCount));
  if (lines.length >= 10) hit("recipe", "many_lines", 5, String(lines.length));
  if (lower.includes("ingredients") && lower.includes("instructions"))
    hit("recipe", "has_ingredients_and_instructions", 12);

  // Meal plan cues: days of week + meal words
  const dowHits = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ].filter((d) => lower.includes(d)).length;
  const mealHits = ["breakfast", "lunch", "dinner"].filter((m) =>
    lower.includes(m)
  ).length;
  if (dowHits >= 3 && mealHits >= 1)
    hit(
      "mealPlan",
      "dow_plus_meal_words",
      12,
      `${dowHits} DOW, ${mealHits} meals`
    );
  if (lower.includes("menu") && dowHits >= 2)
    hit("mealPlan", "menu_plus_dow", 8, `${dowHits} DOW`);

  // Cleaning plan cues: rooms + checklist feel
  const checklistHits = ["- ", "• ", "[ ]", "[x]", "✅"].filter((mark) =>
    t.includes(mark)
  ).length;
  if (checklistHits >= 2)
    hit("cleaning", "checklist_markers", 7, String(checklistHits));
  const roomHits = ["kitchen", "bathroom", "bedroom", "living room"].filter(
    (r) => lower.includes(r)
  ).length;
  if (roomHits >= 2) hit("cleaning", "room_mentions", 6, String(roomHits));

  // Calendar cues: times + "location" + "starts/ends"
  if (
    timeCount >= 1 &&
    (lower.includes("location") || lower.includes("attendees"))
  )
    hit("calendar", "calendar_fields", 10);
  if (lower.includes("starts") && lower.includes("ends"))
    hit("calendar", "starts_ends", 8);

  // Inventory cues: "on hand", "par", "restock" + numbers
  if (
    (lower.includes("on hand") ||
      lower.includes("restock") ||
      lower.includes("par")) &&
    moneyCount + unitCount >= 2
  ) {
    hit("inventory", "inventory_language", 8);
  }

  // Domain mapping (secondary)
  const domainScores = {};
  const domainEvidence = [];

  const mapLabelToDomains = {
    receipt: ["shopping", "inventory", "budget"],
    recipe: ["meals", "cooking", "inventory"],
    mealPlan: ["meals", "calendar", "inventory"],
    cleaning: ["cleaning", "calendar"],
    calendar: ["calendar"],
    inventory: ["inventory"],
    gardening: ["garden", "inventory"],
    animals: ["animals", "inventory"],
  };

  for (const [label, sc] of Object.entries(scores)) {
    const domains = mapLabelToDomains[label] || [];
    for (const d of domains) {
      scoreAdd(domainScores, d, sc * 0.6);
      domainEvidence.push({ domain: d, from: label, weight: sc * 0.6 });
    }
  }

  // Determine primary label
  const topLabels = topKScoreMap(scores, 3);
  const primary = topLabels[0]?.name || "unknown";
  const confidence = clamp((topLabels[0]?.score || 0) / 40, 0, 1); // heuristic normalization

  // Provide a few extracted signals
  const signals = {
    moneyCount,
    dateCount,
    timeCount,
    upcCount,
    unitCount,
    pctCount,
    lineCount: lines.length,
    longLines,
    checklistHits,
    dowHits,
    mealHits,
  };

  // Optional strict mode: if everything low, mark unknown
  const minScore = opts.minScoreForKnown ?? 10;
  const maxScore = topLabels[0]?.score || 0;
  const label = maxScore >= minScore ? primary : "unknown";

  return {
    label, // primary classification label
    confidence,
    scores,
    topLabels,
    domainScores,
    topDomains: topKScoreMap(domainScores, 5),
    evidence: evidence
      .sort((a, b) => (b.weight || 0) - (a.weight || 0))
      .slice(0, 20),
    signals,
  };
}

function classifyArtifact(artifact, options = {}) {
  const a = safeObj(artifact);
  const opts = safeObj(options);

  const rawText = a.rawText != null ? String(a.rawText) : "";
  const rawJson = a.rawJson != null ? a.rawJson : null;

  // Text classification dominates unless JSON looks structured
  const textAnalysis = rawText ? classifyTextHeuristic(rawText, opts) : null;

  // JSON hints: receipt candidate arrays, lineItems, totals, etc.
  const jsonSignals = {};
  const jsonScores = {};
  const jsonEvidence = [];

  function jhit(label, rule, weight, sample) {
    scoreAdd(jsonScores, label, weight);
    jsonEvidence.push({ label, rule, weight, sample: sample || null });
  }

  if (rawJson && typeof rawJson === "object") {
    const j = rawJson;
    const str = JSON.stringify(j).toLowerCase();

    const hasLineItems =
      Array.isArray(j.lineItems) ||
      Array.isArray(j.items) ||
      Array.isArray(j.products) ||
      str.includes("lineitems") ||
      str.includes("unitprice");

    const hasTotals =
      j.total != null ||
      j.subtotal != null ||
      j.tax != null ||
      str.includes('"total"') ||
      str.includes('"subtotal"') ||
      str.includes('"tax"');

    const hasIngredients =
      Array.isArray(j.ingredients) ||
      str.includes("ingredients") ||
      str.includes("instructions");

    const hasMeals =
      Array.isArray(j.meals) ||
      str.includes("breakfast") ||
      str.includes("lunch") ||
      str.includes("dinner");

    jsonSignals.hasLineItems = !!hasLineItems;
    jsonSignals.hasTotals = !!hasTotals;
    jsonSignals.hasIngredients = !!hasIngredients;
    jsonSignals.hasMeals = !!hasMeals;

    if (hasLineItems && hasTotals) jhit("receipt", "json_lineItems_totals", 20);
    if (hasIngredients) jhit("recipe", "json_ingredients", 18);
    if (hasMeals) jhit("mealPlan", "json_meals", 14);
  }

  const topJson = topKScoreMap(jsonScores, 2);

  // Merge text+json with a bias toward whichever is stronger
  const combinedScores = {};
  if (textAnalysis?.scores) {
    for (const [k, v] of Object.entries(textAnalysis.scores))
      combinedScores[k] = (combinedScores[k] || 0) + v;
  }
  for (const [k, v] of Object.entries(jsonScores))
    combinedScores[k] = (combinedScores[k] || 0) + v;

  const combinedTop = topKScoreMap(combinedScores, 3);
  const primary =
    combinedTop[0]?.name ||
    textAnalysis?.label ||
    topJson[0]?.name ||
    "unknown";
  const confidence = clamp((combinedTop[0]?.score || 0) / 45, 0, 1);

  // Determine domains from combined
  const domainScores = {};
  const mapLabelToDomains = {
    receipt: ["shopping", "inventory", "budget"],
    recipe: ["meals", "cooking", "inventory"],
    mealPlan: ["meals", "calendar", "inventory"],
    cleaning: ["cleaning", "calendar"],
    calendar: ["calendar"],
    inventory: ["inventory"],
    gardening: ["garden", "inventory"],
    animals: ["animals", "inventory"],
  };

  for (const [label, sc] of Object.entries(combinedScores)) {
    const domains = mapLabelToDomains[label] || [];
    for (const d of domains) scoreAdd(domainScores, d, sc * 0.6);
  }

  const mime = String(a.mime || "").toLowerCase();
  const kind = String(a.kind || "").toLowerCase();

  // Minor boosts by mime/kind
  if (mime.includes("pdf") || kind === "pdf")
    scoreAdd(combinedScores, "receipt", 2);
  if (mime.includes("image") || kind === "image")
    scoreAdd(combinedScores, "receipt", 1);

  const label =
    (combinedTop[0]?.score || 0) >= (opts.minScoreForKnown ?? 10)
      ? primary
      : "unknown";

  return {
    kind: kind || null,
    mime: mime || null,
    filename: a.filename || null,
    source: a.source || null,

    label,
    confidence,
    topLabels: combinedTop,
    scores: combinedScores,

    topDomains: topKScoreMap(domainScores, 5),
    domainScores,

    evidence: [...(textAnalysis?.evidence || []), ...jsonEvidence]
      .sort((x, y) => (y.weight || 0) - (x.weight || 0))
      .slice(0, 24),

    signals: {
      ...(textAnalysis?.signals || {}),
      ...jsonSignals,
    },

    textAnalysis,
    jsonAnalysis: {
      scores: jsonScores,
      top: topJson,
      signals: jsonSignals,
      evidence: jsonEvidence,
    },
  };
}

/* -----------------------------------------------------------------------------
 * Next action suggestions
 * -------------------------------------------------------------------------- */

function baseNextActionsForLabel(label) {
  switch (label) {
    case "receipt":
      return [
        {
          id: "route.shoppingReceipt",
          title: "Process as Receipt",
          domain: "shopping",
          intent: "receipt.reconcile",
        },
        {
          id: "commit.inventoryCandidates",
          title: "Queue Inventory Candidates",
          domain: "inventory",
          intent: "inventory.candidates",
        },
        {
          id: "extract.coupons",
          title: "Extract Coupons",
          domain: "shopping",
          intent: "coupons.extract",
        },
      ];
    case "recipe":
      return [
        {
          id: "route.recipeImport",
          title: "Import as Recipe",
          domain: "meals",
          intent: "recipe.import",
        },
        {
          id: "map.ingredients",
          title: "Map Ingredients to Inventory",
          domain: "inventory",
          intent: "inventory.mapIngredients",
        },
        {
          id: "start.cookingSession",
          title: "Start Cooking Session Blueprint",
          domain: "cooking",
          intent: "session.blueprint.cooking",
        },
      ];
    case "mealPlan":
      return [
        {
          id: "route.mealPlanImport",
          title: "Import Meal Plan",
          domain: "meals",
          intent: "mealPlan.import",
        },
        {
          id: "sync.shoppingList",
          title: "Generate Shopping List",
          domain: "shopping",
          intent: "shopping.list.generate",
        },
        {
          id: "schedule.sessions",
          title: "Schedule Sessions from Plan",
          domain: "planning",
          intent: "session.schedule.fromPlan",
        },
      ];
    case "cleaning":
      return [
        {
          id: "route.cleanPlan",
          title: "Import Cleaning Plan",
          domain: "cleaning",
          intent: "cleaning.plan.import",
        },
        {
          id: "schedule.cleaningSessions",
          title: "Schedule Cleaning Sessions",
          domain: "planning",
          intent: "session.schedule.cleaning",
        },
      ];
    case "calendar":
      return [
        {
          id: "route.calendarImport",
          title: "Import Calendar Items",
          domain: "calendar",
          intent: "calendar.import",
        },
        {
          id: "schedule.alerts",
          title: "Schedule Alerts",
          domain: "planning",
          intent: "alerts.schedule",
        },
      ];
    case "inventory":
      return [
        {
          id: "route.inventoryImport",
          title: "Import Inventory List",
          domain: "inventory",
          intent: "inventory.import",
        },
        {
          id: "set.parLevels",
          title: "Set Par Levels",
          domain: "inventory",
          intent: "inventory.parLevels",
        },
      ];
    default:
      return [
        {
          id: "route.genericNote",
          title: "Save as Note",
          domain: "notes",
          intent: "note.save",
        },
      ];
  }
}

function scoreNextActions(actions, analysis, context = {}) {
  const a = safeObj(analysis);
  const ctx = safeObj(context);
  const topDomains = safeArr(a.topDomains);

  const domainBoost = {};
  for (const d of topDomains) domainBoost[d.name] = d.score || 0;

  const scored = actions.map((act) => {
    let score = 0;
    const dom = act.domain || "unknown";
    score += (domainBoost[dom] || 0) * 0.4;

    // Contextual boosts
    if (ctx.mode === "shopping" && dom === "shopping") score += 12;
    if (ctx.mode === "cooking" && dom === "cooking") score += 12;
    if (ctx.mode === "cleaning" && dom === "cleaning") score += 12;

    if (ctx.hasReceipt === true && act.id === "route.shoppingReceipt")
      score += 10;
    if (
      ctx.wantsSessionBlueprint === true &&
      String(act.intent || "").includes("session")
    )
      score += 8;

    // Confidence impact
    score += clamp((a.confidence || 0) * 20, 0, 20);

    return { ...act, score };
  });

  return scored.sort((x, y) => (y.score || 0) - (x.score || 0));
}

/* -----------------------------------------------------------------------------
 * Public methods
 * -------------------------------------------------------------------------- */

async function getCached(key) {
  // First: ImportCacheService (if it exists)
  try {
    if (ImportCacheService?.get) {
      const hit = await ImportCacheService.get(key);
      if (hit) return hit;
    }
  } catch {
    // ignore
  }
  // Second: Dexie parse_cache
  const dex = await cacheGetDexie(key);
  if (dex) return dex;
  return null;
}

async function setCached(key, value, ttlMs) {
  const ttl = ttlMs == null ? DEFAULT_CACHE_TTL_MS : ttlMs;
  let wrote = false;

  try {
    if (ImportCacheService?.set) {
      await ImportCacheService.set(key, value, {
        ttlMs: ttl,
        source: SOURCE,
        version: HEURISTICS_VERSION,
      });
      wrote = true;
    }
  } catch {
    // ignore
  }

  if (!wrote) {
    await cacheSetDexie(key, value, ttl);
  }

  return true;
}

/**
 * Analyze an artifact. Uses caching based on fingerprint.
 * @param {object} artifact
 * @param {object} [options]
 * @param {boolean} [options.useCache=true]
 * @param {number} [options.cacheTtlMs]
 * @param {number} [options.minScoreForKnown=10]
 * @param {boolean} [options.tryRouter=false] - attempt to call ImportRouter for next step hints
 */
export async function analyzeArtifact(artifact, options = {}) {
  const opts = safeObj(options);
  const a = safeObj(artifact);

  const fp = fingerprintArtifact(a);
  const cacheKey = `${CACHE_PREFIX}:artifact:${fp}`;

  if (opts.useCache !== false) {
    const cached = await getCached(cacheKey);
    if (cached) {
      emit("imports.intel.cacheHit", {
        key: cacheKey,
        artifactId: a.id || null,
      });
      return { ...cached, _cache: { hit: true, key: cacheKey, at: nowISO() } };
    }
  }

  const analysis = classifyArtifact(a, opts);

  // Router hints (optional)
  let routerHints = null;
  if (opts.tryRouter && ImportRouter?.hintNext) {
    try {
      routerHints = await ImportRouter.hintNext(a, analysis);
    } catch (e) {
      routerHints = null;
      warn("ImportRouter.hintNext failed", { err: String(e?.message || e) });
    }
  }

  const out = {
    artifactId: a.id || null,
    fingerprint: fp,
    heuristicsVersion: HEURISTICS_VERSION,
    analyzedAt: nowISO(),
    analysis,
    routerHints,
    nextActions: suggestNextActions({ analysis }, { mode: a.source || null }),
  };

  await setCached(cacheKey, out, opts.cacheTtlMs);

  emit("imports.intel.analyzed", {
    artifactId: a.id || null,
    label: analysis.label,
    confidence: analysis.confidence,
    topDomains: analysis.topDomains,
  });

  return { ...out, _cache: { hit: false, key: cacheKey, at: nowISO() } };
}

/**
 * Analyze plain text input (paste).
 * @param {string} text
 * @param {object} [options]
 */
export async function analyzeText(text, options = {}) {
  const opts = safeObj(options);
  const t = normalizeText(text);

  const fp = hashString(
    `${HEURISTICS_VERSION}|text|${hashString(t.slice(0, 24000))}`
  );
  const cacheKey = `${CACHE_PREFIX}:text:${fp}`;

  if (opts.useCache !== false) {
    const cached = await getCached(cacheKey);
    if (cached)
      return { ...cached, _cache: { hit: true, key: cacheKey, at: nowISO() } };
  }

  const analysis = classifyTextHeuristic(t, opts);
  const out = {
    fingerprint: fp,
    heuristicsVersion: HEURISTICS_VERSION,
    analyzedAt: nowISO(),
    analysis,
    nextActions: suggestNextActions(
      { analysis },
      { mode: opts.mode || "paste" }
    ),
  };

  await setCached(cacheKey, out, opts.cacheTtlMs);
  emit("imports.intel.textAnalyzed", {
    label: analysis.label,
    confidence: analysis.confidence,
  });

  return { ...out, _cache: { hit: false, key: cacheKey, at: nowISO() } };
}

/**
 * Analyze already-parsed candidates (L1 objects).
 * Useful when you have OCR/receipt candidates and want a "best domain" decision.
 * @param {Array<object>} candidates
 * @param {object} [options]
 */
export async function analyzeCandidates(candidates, options = {}) {
  const opts = safeObj(options);
  const arr = safeArr(candidates);

  const fp = hashString(
    `${HEURISTICS_VERSION}|cands|${hashString(
      JSON.stringify(arr.slice(0, 80)).slice(0, 24000)
    )}`
  );
  const cacheKey = `${CACHE_PREFIX}:cands:${fp}`;

  if (opts.useCache !== false) {
    const cached = await getCached(cacheKey);
    if (cached)
      return { ...cached, _cache: { hit: true, key: cacheKey, at: nowISO() } };
  }

  // candidate signals
  let receiptish = 0;
  let recipeish = 0;
  let mealPlanish = 0;

  for (const c of arr) {
    const x = safeObj(c);
    const k = String(x.kind || x.type || "").toLowerCase();
    const label = String(x.label || x.category || "").toLowerCase();
    const hasPrice = x.price != null || x.unitPrice != null || x.total != null;
    const hasQty = x.qty != null || x.quantity != null;
    const hasIngredient = (x.ingredient || x.food || "").toString().length > 0;
    const hasDay = [
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ].some((d) =>
      String(x.text || x.name || "")
        .toLowerCase()
        .includes(d)
    );

    if (k.includes("line") || label.includes("line")) receiptish += 2;
    if (hasPrice) receiptish += 2;
    if (hasQty) receiptish += 1;

    if (hasIngredient || k.includes("ingredient")) recipeish += 2;
    if (k.includes("step") || label.includes("instruction")) recipeish += 1;

    if (hasDay) mealPlanish += 2;
    if (String(x.mealType || "").length) mealPlanish += 1;
  }

  const scores = {
    receipt: receiptish,
    recipe: recipeish,
    mealPlan: mealPlanish,
  };

  const topLabels = topKScoreMap(scores, 3);
  const label =
    (topLabels[0]?.score || 0) >= (opts.minScoreForKnown ?? 6)
      ? topLabels[0].name
      : "unknown";
  const confidence = clamp((topLabels[0]?.score || 0) / 18, 0, 1);

  const analysis = {
    label,
    confidence,
    scores,
    topLabels,
    topDomains: topKScoreMap(
      {
        shopping: receiptish * 0.6,
        inventory: (receiptish + recipeish + mealPlanish) * 0.3,
        meals: (recipeish + mealPlanish) * 0.6,
        cooking: recipeish * 0.6,
        calendar: mealPlanish * 0.5,
      },
      5
    ),
    evidence: [
      { label: "receipt", rule: "candidate_prices_qty", weight: receiptish },
      {
        label: "recipe",
        rule: "candidate_ingredients_steps",
        weight: recipeish,
      },
      {
        label: "mealPlan",
        rule: "candidate_days_mealtypes",
        weight: mealPlanish,
      },
    ].sort((a, b) => (b.weight || 0) - (a.weight || 0)),
    signals: { receiptish, recipeish, mealPlanish, candidateCount: arr.length },
  };

  const out = {
    fingerprint: fp,
    heuristicsVersion: HEURISTICS_VERSION,
    analyzedAt: nowISO(),
    analysis,
    nextActions: suggestNextActions(
      { analysis },
      { mode: opts.mode || "candidates" }
    ),
  };

  await setCached(cacheKey, out, opts.cacheTtlMs);
  emit("imports.intel.candidatesAnalyzed", { label, confidence });

  return { ...out, _cache: { hit: false, key: cacheKey, at: nowISO() } };
}

/**
 * Suggest next actions for UI or orchestrator.
 * @param {object} analysisWrapper - { analysis }
 * @param {object} [context]
 */
export function suggestNextActions(analysisWrapper, context = {}) {
  const a = safeObj(analysisWrapper?.analysis || analysisWrapper);
  const label = String(a.label || "unknown");

  const base = baseNextActionsForLabel(label);

  // Add "generic" actions always available
  const extras = [
    {
      id: "view.raw",
      title: "View Raw Import",
      domain: "imports",
      intent: "import.viewRaw",
    },
    {
      id: "tag.note",
      title: "Tag & Save for Later",
      domain: "imports",
      intent: "import.saveDraft",
    },
  ];

  const all = [...base, ...extras];

  const scored = scoreNextActions(all, a, context);

  // keep top 6
  return scored.slice(0, 6);
}

export function getHeuristicsVersion() {
  return HEURISTICS_VERSION;
}

/* -----------------------------------------------------------------------------
 * Convenience "full pipeline hint"
 * -------------------------------------------------------------------------- */

/**
 * Best-effort helper that (optionally) calls UploadIngestService/ImportRouter to recommend a pipeline.
 * Safe no-op if those services do not exist.
 *
 * @param {object} artifact
 * @param {object} [options]
 * @param {boolean} [options.tryIngest=false] - if true, calls UploadIngestService.hint(...) if available
 * @param {boolean} [options.tryRouter=true] - if true, calls ImportRouter.hintNext(...) if available
 */
export async function getPipelineHint(artifact, options = {}) {
  const opts = safeObj(options);
  const intel = await analyzeArtifact(artifact, {
    ...opts,
    tryRouter: !!opts.tryRouter,
  });

  let ingestHint = null;
  if (opts.tryIngest && UploadIngestService?.hint) {
    try {
      ingestHint = await UploadIngestService.hint(artifact, intel.analysis);
    } catch (e) {
      ingestHint = null;
    }
  }

  const hint = {
    ...intel,
    ingestHint,
    pipeline: {
      // non-binding suggestion
      label: intel.analysis.label,
      domains: intel.analysis.topDomains,
      actions: intel.nextActions,
    },
  };

  emit("imports.intel.pipelineHint", {
    artifactId: safeObj(artifact).id || null,
    label: intel.analysis.label,
    confidence: intel.analysis.confidence,
  });

  return hint;
}

/* -----------------------------------------------------------------------------
 * ✅ NEW: Recent imports helper (build-fix compat)
 * -------------------------------------------------------------------------- */
/**
 * getRecentImports
 *
 * Some domain planners (ex: AnimalPlanner.jsx) import:
 *   import { getRecentImports } from "@/services/imports/ImportIntelligenceService";
 *
 * This service is primarily for analysis, but planners may want a lightweight,
 * browser-safe "recent imports" feed to seed suggestions.
 *
 * Design:
 *  - Prefer ImportCacheService.listRecent() if available
 *  - Otherwise scan Dexie parse_cache/import_cache tables (best-effort)
 *  - Never throws; always returns an array
 *
 * @param {object} [options]
 * @param {number} [options.limit=25]
 * @param {string[]} [options.kinds]   - optional filter by artifact kind
 * @param {string[]} [options.labels]  - optional filter by intel.analysis.label
 * @param {number} [options.sinceMs]   - optional lower-bound timestamp (ms)
 * @returns {Promise<Array<object>>}
 */
export async function getRecentImports(options = {}) {
  const opts = safeObj(options);
  const limit = clamp(opts.limit ?? 25, 1, 250);
  const kinds = safeArr(opts.kinds).map((x) => String(x).toLowerCase());
  const labels = safeArr(opts.labels).map((x) => String(x).toLowerCase());
  const sinceMs = Number.isFinite(Number(opts.sinceMs))
    ? Number(opts.sinceMs)
    : null;

  // 1) Prefer ImportCacheService if it exposes a recent listing API
  try {
    if (ImportCacheService?.listRecent) {
      const rows = await ImportCacheService.listRecent({ limit });
      const out = safeArr(rows).slice(0, limit);
      return filterRecentImports(out, { kinds, labels, sinceMs }).slice(
        0,
        limit
      );
    }
  } catch {
    // ignore
  }

  // 2) Dexie best-effort scan of parse cache table (may be large; we keep it bounded)
  const t = resolveParseCacheTable();
  if (!t) return [];

  try {
    // Try dexie collection methods if available
    // Many Dexie tables support: orderBy(), reverse(), limit(), toArray()
    if (typeof t.orderBy === "function") {
      let q = t.orderBy("updatedAt");
      if (q && typeof q.reverse === "function") q = q.reverse();
      if (q && typeof q.limit === "function") q = q.limit(limit * 4); // fetch extra then filter
      const arr = (await q.toArray()) || [];
      const mapped = arr.map((row) => normalizeCacheRow(row));
      return filterRecentImports(mapped, { kinds, labels, sinceMs }).slice(
        0,
        limit
      );
    }
  } catch {
    // ignore
  }

  try {
    // Fallback: if Dexie table supports toArray, grab a small slice then sort in memory
    if (typeof t.toArray === "function") {
      const arr = (await t.toArray()) || [];
      const mapped = arr
        .map((row) => normalizeCacheRow(row))
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
      return filterRecentImports(mapped, { kinds, labels, sinceMs }).slice(
        0,
        limit
      );
    }
  } catch {
    // ignore
  }

  return [];
}

function normalizeCacheRow(row) {
  const r = safeObj(row);
  const value = r.value ?? r.data ?? null;
  const v = safeObj(value);

  // try to pick out common intel output shape
  const analysis = v.analysis
    ? safeObj(v.analysis)
    : safeObj(v?.analysisWrapper?.analysis);
  const artifactId = v.artifactId ?? v.id ?? r.artifactId ?? null;

  return {
    id: r.id ?? v.fingerprint ?? artifactId ?? null,
    artifactId,
    kind: (v.kind ?? v?.artifact?.kind ?? null) || null,
    mime: (v.mime ?? v?.artifact?.mime ?? null) || null,
    filename: (v.filename ?? v?.artifact?.filename ?? null) || null,
    source: (v.source ?? v?.artifact?.source ?? null) || null,
    analyzedAt: v.analyzedAt ?? null,
    updatedAt: r.updatedAt ?? v.updatedAt ?? null,
    expiresAt: r.expiresAt ?? null,
    heuristicsVersion: v.heuristicsVersion ?? r.version ?? null,
    analysis: analysis && Object.keys(analysis).length ? analysis : null,
    raw: value,
  };
}

function filterRecentImports(items, { kinds, labels, sinceMs }) {
  const arr = safeArr(items);

  let out = arr;

  if (sinceMs != null) {
    out = out.filter((x) => {
      const u = Number(safeObj(x).updatedAt || 0);
      return u >= sinceMs;
    });
  }

  if (kinds.length) {
    out = out.filter((x) => {
      const k = String(safeObj(x).kind || "").toLowerCase();
      return kinds.includes(k);
    });
  }

  if (labels.length) {
    out = out.filter((x) => {
      const a = safeObj(safeObj(x).analysis);
      const l = String(a.label || "").toLowerCase();
      return labels.includes(l);
    });
  }

  return out;
}

/* -----------------------------------------------------------------------------
 * Default export
 * -------------------------------------------------------------------------- */

const ImportIntelligenceService = {
  analyzeArtifact,
  analyzeText,
  analyzeCandidates,
  suggestNextActions,
  getHeuristicsVersion,
  getPipelineHint,
  getRecentImports,
};

export default ImportIntelligenceService;
