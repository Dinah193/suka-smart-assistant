// C:\Users\larho\suka-smart-assistant\src\services\scraper\ScraperNormalizer.js
/**
 * ScraperNormalizer — Converts raw scraped payloads into standardized JSON tables
 * --------------------------------------------------------------------------------
 * ROLE IN PIPELINE
 * imports (ScraperEngine.scrape) → intelligence (ScraperNormalizer.normalize) → automation (emit events)
 * → (optional) hub export (only when a downstream step mutates household data; this file does not).
 *
 * WHAT THIS FILE DOES
 * - Accepts a raw scrape payload from ScraperEngine (url, type, main.text/html, tables, enrichment, meta).
 * - Produces standardized tables and normalized objects per domain (recipe, procedure/cleaning, garden, storehouse, video).
 * - Emits consistent lifecycle events on the shared eventBus with payload { type, ts, source, data } (ISO timestamps).
 * - Provides a lightweight registry to plug in new normalizers (preservation, animal, storehouse variants, etc.).
 *
 * WHAT THIS FILE DOES *NOT* DO
 * - It does not mutate inventory/storehouse/sessions. Downstream engines will do that.
 *   Therefore, we DO NOT call exportToHubIfEnabled() here by default.
 *
 * EVENTS EMITTED
 * - normalize.started
 * - normalize.completed
 * - import.parsed            ← short summary (for automation runtime triggers)
 *
 * EXTENSION POINTS
 * - registerNormalizer({ id, test(payload), normalize(payload, options) })
 * - Built-in normalizers cover: recipe, procedure(cleaning/how-to), garden, storehouse(product), video, unknown.
 */

import eventBus from "../events/eventBus.js";

// Soft imports; degrade gracefully if not present
let featureFlags = { familyFundMode: false };
let HubPacketFormatter = null;
let FamilyFundConnector = null;

(async () => {
  try {
    const mod = await import("@/config/featureFlags.json");
    featureFlags = mod.default || mod || featureFlags;
  } catch {}
  try {
    const mod = await import("@/services/hub/HubPacketFormatter.js");
    HubPacketFormatter = mod.default || mod;
  } catch {}
  try {
    const mod = await import("@/services/hub/FamilyFundConnector.js");
    FamilyFundConnector = mod.default || mod;
  } catch {}
})();

/* ----------------------------------------------------------------------------
 * Utilities
 * ------------------------------------------------------------------------- */

const SOURCE = "ScraperNormalizer";
const nowISO = () => new Date().toISOString();
const emit = (type, data) =>
  eventBus.emit({ type, ts: nowISO(), source: SOURCE, data });

const isStr = (v) => typeof v === "string";
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const clean = (s) => (isStr(s) ? s.replace(/\s+/g, " ").trim() : "");
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/** Simple stable-ish hash for IDs (no crypto dependency). */
function tinyHash(str = "") {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Create a standardized table shape. */
function makeTable(name, columns, rows, meta = {}) {
  return {
    name,
    meta: { ...meta, createdAt: nowISO() },
    columns: [...columns],
    rows: Array.isArray(rows) ? rows : [],
  };
}

/** Parse a best-effort ingredient line into qty/unit/item/notes. */
function parseIngredientLine(line = "") {
  const original = clean(line);
  if (!original) {
    return { line: "", qty: "", unit: "", item: "", notes: "" };
  }
  // Examples handled: "1 1/2 cups all-purpose flour (sifted)"
  const m = original.match(
    /^(?<qty>(?:\d+\s+\d\/\d|\d+\/\d|\d+(?:\.\d+)?))?\s*(?<unit>[a-zA-Z]+\.?|cups?|tbsps?|tablespoons?|tsps?|teaspoons?|grams?|g|kg|lbs?|pounds?|oz|ounces?)?\s*(?<item>.+?)\s*(?:\((?<notes>[^)]+)\))?$/i
  );
  if (!m || !m.groups) {
    return { line: original, qty: "", unit: "", item: original, notes: "" };
  }
  const { qty = "", unit = "", item = "", notes = "" } = m.groups;
  return {
    line: original,
    qty: clean(qty),
    unit: clean(unit),
    item: clean(item),
    notes: clean(notes),
  };
}

/** Heuristic to scan a step text for common doneness cues. */
function inferDonenessCue(text = "") {
  const t = text.toLowerCase();
  const cues = [
    "golden brown",
    "opaque",
    "fork-tender",
    "until tender",
    "bubbly",
    "set in the center",
    "crumb forms",
    "reads 165°",
    "reads 160°",
    "no pink",
    "juices run clear",
    "until fragrant",
  ];
  for (const c of cues) {
    if (t.includes(c)) return c;
  }
  return "";
}

/** Extract numeric minutes if present in step time hints. */
function coerceMinutes(v) {
  if (v == null) return "";
  const n = Number(v);
  return Number.isFinite(n) ? n : "";
}

/** Optional hub export helper (not used here by default) */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch {
    // silent by design
  }
}

/* ----------------------------------------------------------------------------
 * Normalizer registry
 * ------------------------------------------------------------------------- */

const _registry = new Map();

export function registerNormalizer(plugin) {
  if (
    !plugin ||
    !plugin.id ||
    typeof plugin.test !== "function" ||
    typeof plugin.normalize !== "function"
  ) {
    throw new Error("Invalid normalizer plugin shape.");
  }
  _registry.set(plugin.id, plugin);
}

export function unregisterNormalizer(id) {
  _registry.delete(id);
}

export function listNormalizers() {
  return [..._registry.keys()];
}

/* ----------------------------------------------------------------------------
 * Built-in Normalizers
 * ------------------------------------------------------------------------- */

/** Recipe normalizer */
const RecipeNormalizer = {
  id: "builtin.recipe",
  test: (p) => p?.type === "recipe" || p?.enrichment?.kind === "recipe",
  normalize: (p) => {
    const eid = tinyHash((p.url || "") + (p.meta?.title || "") + "recipe");
    const r = p.enrichment?.recipe || {};

    const ingredients = arr(r.ingredients || [])
      .map(parseIngredientLine)
      .map((row, idx) => ({ order: idx + 1, ...row }));

    const stepsSrc = arr(r.steps || []);
    const steps = stepsSrc.map((s, idx) => ({
      order: idx + 1,
      text: clean(s.text || s || ""),
      prepMinutes: coerceMinutes(s.time?.prep),
      performMinutes: coerceMinutes(s.time?.perform),
      cue: inferDonenessCue(s.text || s || ""),
      temperature: "", // left for future extraction from text
    }));

    const nutritionObj = r.nutrition || {};
    const nutritionRows = Object.entries(nutritionObj).map(([k, v]) => ({
      nutrient: k,
      value: clean(String(v)),
    }));

    const ingredientsTable = makeTable(
      "recipe.ingredients",
      ["order", "line", "qty", "unit", "item", "notes"],
      ingredients
    );
    const stepsTable = makeTable(
      "recipe.steps",
      ["order", "text", "prepMinutes", "performMinutes", "temperature", "cue"],
      steps
    );
    const nutritionTable = makeTable(
      "recipe.nutrition",
      ["nutrient", "value"],
      nutritionRows
    );

    const normalized = {
      id: `recipe_${eid}`,
      name: clean(r.name || p.meta?.title || ""),
      author: clean(r.author || ""),
      yield: clean(r.yield || ""),
      category: clean(r.category || ""),
      cuisine: clean(r.cuisine || ""),
      time: {
        totalMinutes: coerceMinutes(r.time?.totalMinutes),
        prepMinutes: coerceMinutes(r.time?.prepMinutes),
        cookMinutes: coerceMinutes(r.time?.cookMinutes),
      },
      media: r.media || {},
      sourceUrl: p.url,
    };

    const tables = [ingredientsTable, stepsTable];
    if (nutritionRows.length) tables.push(nutritionTable);

    return {
      kind: "recipe",
      id: normalized.id,
      normalized,
      tables,
      warnings: [],
    };
  },
};

/** Procedure / Cleaning normalizer (HowTo) */
const ProcedureNormalizer = {
  id: "builtin.procedure",
  test: (p) =>
    p?.type === "cleaning" ||
    p?.enrichment?.kind === "procedure" ||
    /how-to|howto/i.test(p?.meta?.title || ""),
  normalize: (p) => {
    const eid = tinyHash((p.url || "") + (p.meta?.title || "") + "procedure");
    const h = p.enrichment?.procedure || {};
    const domainHint = h.domainHint || "cleaning";

    const supplies = arr(h.supplies)
      .map((s) => ({ item: clean(s) }))
      .filter((x) => x.item);
    const tools = arr(h.tools)
      .map((t) => ({ tool: clean(t) }))
      .filter((x) => x.tool);

    const steps = arr(h.steps || []).map((s, idx) => ({
      order: idx + 1,
      text: clean(s.text || s || ""),
      prepMinutes: coerceMinutes(s.time?.prep),
      performMinutes: coerceMinutes(s.time?.perform),
    }));

    const suppliesTable = makeTable(
      `${domainHint}.supplies`,
      ["item"],
      supplies
    );
    const toolsTable = makeTable(`${domainHint}.tools`, ["tool"], tools);
    const stepsTable = makeTable(
      `${domainHint}.steps`,
      ["order", "text", "prepMinutes", "performMinutes"],
      steps
    );

    const normalized = {
      id: `procedure_${eid}`,
      name: clean(h.name || p.meta?.title || ""),
      domain: domainHint,
      time: {
        totalMinutes: coerceMinutes(h.time?.totalMinutes),
        prepMinutes: coerceMinutes(h.time?.prepMinutes),
        performMinutes: coerceMinutes(h.time?.performMinutes),
      },
      safety: arr(h.safety).map(clean).filter(Boolean),
      sourceUrl: p.url,
    };

    return {
      kind: "procedure",
      id: normalized.id,
      normalized,
      tables: [suppliesTable, toolsTable, stepsTable],
      warnings: [],
    };
  },
};

/** Garden normalizer (seed spacing, germination tables to hints table) */
const GardenNormalizer = {
  id: "builtin.garden",
  test: (p) => p?.type === "garden" || p?.enrichment?.kind === "garden",
  normalize: (p) => {
    const eid = tinyHash((p.url || "") + (p.meta?.title || "") + "garden");
    const g = p.enrichment?.garden || {};
    const hints = arr(g.hints || []);
    const rows = hints.map((h) => ({
      crop: clean(h.crop || g.cropGuess || ""),
      spacing: clean(h.spacing || ""),
      depth: clean(h.depth || ""),
      germination: clean(h.germination || ""),
      daysToMaturity: clean(h.daysToMaturity || ""),
      zone: clean(h.zone || ""),
      sun: clean(h.sun || ""),
      water: clean(h.water || ""),
      row: clean(h.row || ""),
    }));
    const hintsTable = makeTable(
      "garden.hints",
      [
        "crop",
        "spacing",
        "depth",
        "germination",
        "daysToMaturity",
        "zone",
        "sun",
        "water",
        "row",
      ],
      rows
    );

    const normalized = {
      id: `garden_${eid}`,
      crop: clean(g.cropGuess || ""),
      sourceUrl: p.url,
      title: clean(p.meta?.title || ""),
    };

    return {
      kind: "garden",
      id: normalized.id,
      normalized,
      tables: [hintsTable],
      warnings: [],
    };
  },
};

/** Storehouse/Product normalizer */
const StoreProductNormalizer = {
  id: "builtin.storehouse.product",
  test: (p) => p?.type === "storehouse" || p?.enrichment?.kind === "storehouse",
  normalize: (p) => {
    const eid = tinyHash((p.url || "") + (p.meta?.title || "") + "product");
    const product = p.enrichment?.product || {};

    const rows = [
      {
        name: clean(product.name || ""),
        brand: clean(product.brand || ""),
        sku: clean(product.sku || ""),
        price: clean(product.price || ""),
        currency: clean(product.priceCurrency || ""),
        availability: clean(product.availability || ""),
        url: clean(product.url || p.url || ""),
      },
    ];
    const productTable = makeTable(
      "storehouse.product",
      ["name", "brand", "sku", "price", "currency", "availability", "url"],
      rows
    );

    const normalized = {
      id: `product_${eid}`,
      ...rows[0],
      sourceUrl: p.url,
    };

    return {
      kind: "storehouse",
      id: normalized.id,
      normalized,
      tables: [productTable],
      warnings: [],
    };
  },
};

/** Video normalizer (YouTube/VOD metadata) */
const VideoNormalizer = {
  id: "builtin.video",
  test: (p) => p?.type === "video" || p?.enrichment?.kind === "video",
  normalize: (p) => {
    const eid = tinyHash((p.url || "") + (p.meta?.title || "") + "video");
    const v = p.enrichment?.video || {};
    const rows = [
      {
        title: clean(v.title || p.meta?.title || ""),
        author: clean(v.author || ""),
        durationMinutes: coerceMinutes(v.durationMinutes),
        embedUrl: clean(v.embedUrl || ""),
        thumbnail: clean(v.thumbnail || ""),
        description: clean(v.description || ""),
      },
    ];
    const videoTable = makeTable(
      "video.meta",
      [
        "title",
        "author",
        "durationMinutes",
        "embedUrl",
        "thumbnail",
        "description",
      ],
      rows
    );

    const normalized = {
      id: `video_${eid}`,
      title: rows[0].title,
      author: rows[0].author,
      durationMinutes: rows[0].durationMinutes,
      media: { embedUrl: rows[0].embedUrl, thumbnail: rows[0].thumbnail },
      sourceUrl: p.url,
    };

    return {
      kind: "video",
      id: normalized.id,
      normalized,
      tables: [videoTable],
      warnings: [],
    };
  },
};

/** Unknown / passthrough normalizer */
const UnknownNormalizer = {
  id: "builtin.unknown",
  test: (p) => true, // fallback
  normalize: (p) => {
    const eid = tinyHash((p.url || "") + (p.meta?.title || "") + "unknown");
    const preview = clean(p.main?.text || "").slice(0, 240);

    const metaRows = Object.entries(p.meta || {}).map(([k, v]) => ({
      key: k,
      value: clean(String(v)),
    }));
    const metaTable = makeTable("page.meta", ["key", "value"], metaRows);

    const linksRows = arr(p.links || []).map((l) => ({
      href: clean(l.href),
      text: clean(l.text),
    }));
    const linksTable = makeTable("page.links", ["href", "text"], linksRows);

    const normalized = {
      id: `unknown_${eid}`,
      title: clean(p.meta?.title || ""),
      description: clean(p.meta?.description || ""),
      sourceUrl: p.url,
      preview,
    };

    const tables = [metaTable];
    if (linksRows.length) tables.push(linksTable);

    return {
      kind: "unknown",
      id: normalized.id,
      normalized,
      tables,
      warnings: [],
    };
  },
};

// Register built-ins
registerNormalizer(RecipeNormalizer);
registerNormalizer(ProcedureNormalizer);
registerNormalizer(GardenNormalizer);
registerNormalizer(StoreProductNormalizer);
registerNormalizer(VideoNormalizer);
registerNormalizer(UnknownNormalizer);

/* ----------------------------------------------------------------------------
 * Public API: normalize()
 * ------------------------------------------------------------------------- */

/**
 * normalize(payload, options)
 * @param {object} payload - Raw scrape payload from ScraperEngine.scrape()
 * @param {object} options - { preferKind?: string, includeRaw?: boolean }
 * @returns {object} - { ok, kind, id, normalized, tables, raw?, warnings }
 */
export async function normalize(payload, options = {}) {
  const startedAt = nowISO();

  if (!payload || typeof payload !== "object") {
    const error = "normalize() requires a scrape payload object.";
    emit("normalize.completed", {
      ok: false,
      error,
      startedAt,
      finishedAt: nowISO(),
    });
    throw new Error(error);
  }

  emit("normalize.started", {
    url: payload.url,
    type: payload.type,
    extractor: payload.extractor || null,
    startedAt,
  });

  // Choose the first normalizer whose test passes; allow a preferred kind override.
  const preferKind = options.preferKind;
  let selected = null;

  // If a preferred kind is provided, try matching ID prefix "builtin.{kind}"
  if (preferKind) {
    const candidateId = `builtin.${preferKind}`;
    const cand = [..._registry.values()].find(
      (n) => n.id === candidateId && safeTest(n, payload)
    );
    if (cand) selected = cand;
  }

  if (!selected) {
    for (const n of _registry.values()) {
      if (safeTest(n, payload)) {
        selected = n;
        break;
      }
    }
  }

  // Always fallback to UnknownNormalizer (registered)
  if (!selected) selected = UnknownNormalizer;

  let result;
  try {
    result = await selected.normalize(payload, options);
  } catch (err) {
    // On failure, fallback once to unknown
    if (selected !== UnknownNormalizer) {
      try {
        result = await UnknownNormalizer.normalize(payload, options);
      } catch {}
    }
  }

  // Defensive shape
  result = result || {
    kind: "unknown",
    id: `unknown_${tinyHash(payload.url || "")}`,
    normalized: {},
    tables: [],
    warnings: ["Normalizer returned empty result"],
  };

  const finishedAt = nowISO();

  // Emit a short "import.parsed" event for the automation runtime to hook into.
  emit("import.parsed", {
    url: payload.url,
    kind: result.kind,
    id: result.id,
    title:
      result.normalized?.name ||
      result.normalized?.title ||
      payload.meta?.title ||
      "",
    startedAt,
    finishedAt,
    tables:
      result.tables?.map((t) => ({
        name: t.name,
        rows: t.rows?.length || 0,
      })) || [],
  });

  emit("normalize.completed", {
    ok: true,
    url: payload.url,
    kind: result.kind,
    id: result.id,
    startedAt,
    finishedAt,
  });

  return {
    ok: true,
    kind: result.kind,
    id: result.id,
    normalized: result.normalized,
    tables: result.tables,
    raw: options.includeRaw ? payload : undefined,
    warnings: result.warnings || [],
  };
}

function safeTest(normalizer, payload) {
  try {
    return !!normalizer.test(payload);
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------------------
 * Default export (module facade)
 * ------------------------------------------------------------------------- */
const ScraperNormalizer = {
  normalize,
  registerNormalizer,
  unregisterNormalizer,
  listNormalizers,
};
export default ScraperNormalizer;

/* ----------------------------------------------------------------------------
 * DEV NOTES / FUTURE
 * ------------------------------------------------------------------------- */
/**
 * - Add Preservation normalizer (fermentation/canning): normalize brine %, headspace, venting, PSI, altitude tables.
 * - Add Animal/Butchery normalizer: parse cut sheets, yield %, weight tables, and food safety temps.
 * - Add cue extraction for cooking doneness (regex over text for °F/°C and visual markers).
 * - Add confidence scores per normalizer to help downstream pick among multiple candidates.
 * - Consider emitting a compact “intelligence.summary” event with derived tags (equipment, methods, seasonality).
 * - If a future normalizer writes storehouse/inventory/session data directly, call exportToHubIfEnabled(payload) there.
 */
