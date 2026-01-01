// C:\Users\larho\suka-smart-assistant\src\import\parsers\animalParser.js
// Parses animal acquisition, care, breeding, and butchery data (shim-safe)
// -----------------------------------------------------------------------------
// PLACE IN PIPELINE
// ImportService.importPayload(...) → ImportRouter.routeAndParseImport(...)
//   → **animalParser.parse(...)** → ImportNormalizer.normalizeImport("animal", ...)
//   → automation.runtime (can schedule animal-care / butchery sessions)
//   → (optional) Hub export (done AFTER normalization, not here)
//
// WHAT THIS HANDLES
// 1. Structured SSA-style objects, e.g.:
//    {
//      title: "Spring 2026 Lambs",
//      species: "sheep",
//      tasks: [...],
//      yieldCurveId: "sheep_katahdin",
//      butchery: { cuts: [...], offal: [...] }
//    }
// 2. Butchery / cut sheet style JSON from your butchery module
// 3. Yield-curve linked imports (duck_muscovy.json, goat_kiko.json, etc.)
// 4. URL / HTML for butchery / animal-care guides (we scrape lists/headings)
// 5. Raw text: “Acquire 5 meat goats in March, butcher 2 in July, breed back in August…”
//
// EVENTS
// - Emits "import.parsed.raw" (normalized by eventBus to "import/parsed/raw")
//   via the shared eventBus shim:
//   emitEvent("import.parsed.raw", "import.parser.animal", { success, ... })
//
// IMPORTANT
// - This parser ONLY SHAPES DATA. It does NOT update inventory/storehouse.
//   Normalizers and domain engines emit inventory/session events and handle
//   Hub export. This keeps the parser worker-friendly and side-effect-light.
//
// NORMALIZER COMPATIBILITY
// - `parse(raw, meta)` → returns a single canonical animalPlan object.
// - `parseMany(raw, meta)` → wraps that object in an array for normalizeMany.js.
//   This matches a typical pattern where normalizeMany expects an array.
// -----------------------------------------------------------------------------

import eventBus, { emitEvent } from "../../services/events/eventBus";
import scraperService from "../../services/scraperService.js";

// -----------------------------------------------------------------------------
// Emit helper (parser-scoped diagnostic event)
// -----------------------------------------------------------------------------
/**
 * Emit a low-level parser diagnostic event.
 * Consumers can listen on:
 *   on("import.parsed.raw", handler)
 * or:
 *   on("import/parsed/**", handler)
 *
 * @param {boolean} success
 * @param {object} detail
 */
function emitParserEvent(success, detail = {}) {
  emitEvent("import.parsed.raw", "import.parser.animal", {
    success,
    ...detail,
  });
}

// -----------------------------------------------------------------------------
// 1. HTML helper
// -----------------------------------------------------------------------------
async function getHtmlFromRaw(raw) {
  // Direct HTML string
  if (typeof raw === "string" && /<\/html>|<body|<article|<section/i.test(raw)) {
    return raw;
  }

  // URL → fetch
  if (typeof raw === "string" && /^https?:\/\//i.test(raw)) {
    try {
      const html = await scraperService.fetchHtml(raw);
      return html;
    } catch (err) {
      console.warn("[animalParser] fetchHtml failed:", err?.message || err);
      return null;
    }
  }

  // Object with html property
  if (raw && typeof raw === "object" && typeof raw.html === "string") {
    return raw.html;
  }

  return null;
}

// -----------------------------------------------------------------------------
// 2. Detect structured animal object (SSA-style / user-to-user share)
// -----------------------------------------------------------------------------
function isStructuredAnimalObject(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (raw.species) return true;
  if (Array.isArray(raw.tasks)) return true;
  if (raw.yieldCurveId) return true;
  if (raw.butchery) return true;
  return false;
}

// -----------------------------------------------------------------------------
// 3. Detect simple butchery / cut-sheet object
//    e.g. { animal: "lamb", liveWeight: 120, hangingWeight: 72, cuts: [...] }
// -----------------------------------------------------------------------------
function isButcheryObject(raw) {
  if (!raw || typeof raw !== "object") return false;
  if (raw.butchery) return true;
  if (Array.isArray(raw.cuts)) return true;
  if (typeof raw.liveWeight !== "undefined" || typeof raw.hangingWeight !== "undefined") return true;
  return false;
}

// -----------------------------------------------------------------------------
// 4. HTML fallback parser
//    We try to pull “tasks” out of lists, and detect species from headings
// -----------------------------------------------------------------------------
function fallbackScrape(html, sourceUrl) {
  if (!html) return null;

  // Title
  let title = "Imported animal plan";
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1].trim();
  } else {
    const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (h1) title = h1[1].trim();
  }

  // Species detection (simple)
  let species = null;
  if (/goat/i.test(html)) species = "goat";
  else if (/sheep|lamb/i.test(html)) species = "sheep";
  else if (/cow|cattle|beef/i.test(html)) species = "beef";
  else if (/duck/i.test(html)) species = "duck";
  else if (/chicken|broiler|hen/i.test(html)) species = "chicken";

  const tasks = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let lm;
  while ((lm = liRe.exec(html)) !== null) {
    const txt = lm[1].replace(/<[^>]+>/g, "").trim();
    if (!txt) continue;
    tasks.push({
      text: txt,
    });
  }

  // Detect yield-ish info
  let yieldCurveId = null;
  if (/katahdin/i.test(html)) yieldCurveId = "sheep_katahdin";
  if (/muscovy/i.test(html)) yieldCurveId = "duck_muscovy";

  return {
    type: "animalPlan",
    domain: "animals",
    title,
    sourceUrl: sourceUrl || null,
    species,
    tasks,
    yieldCurveId,
  };
}

// -----------------------------------------------------------------------------
// 5. Text → tasks
//    Example text:
//    "Acquire 5 kiko goats in March
//     Vaccinate kids at 6 wks
//     Butcher 2 wethers in October (target 65 lb carcass)"
// -----------------------------------------------------------------------------
function textToAnimalPlan(text, meta) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const tasks = lines.map((line) => ({
    text: line,
  }));

  // Simple species detection in text
  let species = null;
  if (lines.some((l) => /goat|kiko/i.test(l))) species = "goat";
  else if (lines.some((l) => /sheep|lamb|katahdin|dorper/i.test(l))) species = "sheep";
  else if (lines.some((l) => /duck/i.test(l))) species = "duck";
  else if (lines.some((l) => /chicken|broiler/i.test(l))) species = "chicken";

  // Simple yield detection
  let yieldCurveId = null;
  if (lines.some((l) => /katahdin/i.test(l))) yieldCurveId = "sheep_katahdin";
  if (lines.some((l) => /kiko/i.test(l))) yieldCurveId = "goat_kiko";
  if (lines.some((l) => /muscovy/i.test(l))) yieldCurveId = "duck_muscovy";

  return {
    type: "animalPlan",
    domain: "animals",
    title: meta?.title || "Imported animal plan",
    sourceUrl: meta?.url || null,
    species,
    tasks,
    yieldCurveId,
  };
}

// -----------------------------------------------------------------------------
// 6. MAIN PARSE (single-plan shim)
// -----------------------------------------------------------------------------
/**
 * Parse a raw animal-related import into a single canonical animalPlan object.
 *
 * The result shape is stable and compatible with normalizeMany-style helpers:
 *   - normalizeMany("animal", result) can treat this as one item.
 *   - animalParser.parseMany(raw, meta) will return [result].
 *
 * @param {any} raw
 * @param {object} [meta]
 * @returns {Promise<object>} animalPlan
 */
async function parse(raw, meta = {}) {
  // Precompute a sourceUrl candidate so we can use it consistently
  const sourceUrl =
    (typeof raw === "string" && /^https?:\/\//i.test(raw) && raw) || meta.url || null;

  // CASE 1: structured SSA-style animal object
  if (isStructuredAnimalObject(raw)) {
    const title = raw.title || meta.title || "Imported animal plan";

    emitParserEvent(true, {
      domain: "animal",
      via: "structured-object",
      title,
      species: raw.species || null,
      yieldCurveId: raw.yieldCurveId || null,
    });

    return {
      type: "animalPlan",
      domain: "animals",
      title,
      sourceUrl,
      species: raw.species || null,
      tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
      yieldCurveId: raw.yieldCurveId || null,
      butchery: raw.butchery || null,
    };
  }

  // CASE 2: butchery / cut sheet style object
  if (isButcheryObject(raw)) {
    const inferredSpeciesFromTitle =
      raw.title && /lamb|sheep/i.test(raw.title)
        ? "sheep"
        : raw.title && /goat/i.test(raw.title)
        ? "goat"
        : null;

    const species = raw.species || raw.animal || inferredSpeciesFromTitle || null;

    emitParserEvent(true, {
      domain: "animal",
      via: "butchery-object",
      species,
    });

    // Turn cuts into tasks
    const tasks = [];
    if (Array.isArray(raw.cuts)) {
      raw.cuts.forEach((cut) => {
        const cutName = cut.name || cut.cut || "unknown";
        const weight = cut.weight ? ` (${cut.weight})` : "";
        tasks.push({
          text: `Process cut: ${cutName}${weight}`,
        });
      });
    }
    if (raw.butchery && Array.isArray(raw.butchery.offal)) {
      raw.butchery.offal.forEach((o) => {
        tasks.push({
          text: `Process offal: ${o.name || o}`,
        });
      });
    }

    return {
      type: "animalPlan",
      domain: "animals",
      title: raw.title || meta.title || "Imported butchery plan",
      sourceUrl,
      species,
      tasks,
      yieldCurveId: raw.yieldCurveId || null,
      butchery: raw.butchery || {
        liveWeight: raw.liveWeight,
        hangingWeight: raw.hangingWeight,
        cuts: raw.cuts || [],
      },
    };
  }

  // CASE 3: URL / HTML
  const html = await getHtmlFromRaw(raw);
  if (html) {
    const scraped = fallbackScrape(html, sourceUrl);
    if (scraped) {
      emitParserEvent(true, {
        domain: "animal",
        via: "html-fallback",
        title: scraped.title,
        species: scraped.species,
        yieldCurveId: scraped.yieldCurveId,
      });
      return scraped;
    }
  }

  // CASE 4: raw text
  if (typeof raw === "string") {
    const plan = textToAnimalPlan(raw, meta);
    emitParserEvent(true, {
      domain: "animal",
      via: "text-lines",
      species: plan.species,
      tasks: plan.tasks.length,
      yieldCurveId: plan.yieldCurveId,
    });
    return plan;
  }

  // CASE 5: unknown
  emitParserEvent(false, {
    domain: "animal",
    via: "unknown",
    error: "Could not parse animal/butchery data.",
  });

  return {
    type: "animalPlan",
    domain: "animals",
    title: meta.title || "Unknown animal import",
    sourceUrl,
    species: null,
    tasks: [],
    yieldCurveId: null,
    warning: "Parser could not identify animal structure — returned empty structure.",
  };
}

// -----------------------------------------------------------------------------
// 7. parseMany — helper for normalizeMany.js style workflows
// -----------------------------------------------------------------------------
/**
 * Wraps `parse` into an array-based interface for helpers that expect
 * "many" semantics (e.g., normalizeMany). This is safe even if you
 * later allow parse() to return an array — we normalize to an array.
 *
 * @param {any} raw
 * @param {object} [meta]
 * @returns {Promise<object[]>}
 */
async function parseMany(raw, meta = {}) {
  const result = await parse(raw, meta);
  if (Array.isArray(result)) return result;
  if (!result) return [];
  return [result];
}

// -----------------------------------------------------------------------------
// EXPORT
// -----------------------------------------------------------------------------
const animalParser = {
  parse,
  parseMany,
};

export default animalParser;
