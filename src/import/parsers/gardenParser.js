// C:\Users\larho\suka-smart-assistant\src\import\parsers\gardenParser.js
// Parses garden plans, seed packets, garden care/maintenance, and garden guides
// (shim-safe, normalizeMany-friendly)
// -----------------------------------------------------------------------------
// POSITION IN PIPELINE
// ImportService.importPayload(...) → ImportRouter.routeImport(...) →
//   **gardenParser.parse(...)** → ImportNormalizer.normalizeImport("garden", ...) →
//   automation.runtime (can schedule plant/seed sessions) → (optional) Hub
//
// INPUT FORMS SUPPORTED
// 1. Seed packet JSON (from bookmarklet or mobile):
//    { crop: "Tomato", variety: "Roma", spacing: "18 in", ... }
// 2. Full garden plan JSON:
//    { title, beds: [...], plants: [...], calendar: [...], gardenZone: "8a" }
// 3. URL or HTML to a garden guide / planting guide
// 4. Raw text pasted from a site / PDF
//
// CANONICAL OUTPUT SHAPE (to normalizer):
//
//   {
//     type: "gardenPlan",
//     domain: "garden",
//     title: "Spring 2026 Garden Plan",
//     sourceUrl: "https://...",
//     plants: [
//       {
//         name: "Tomato",
//         variety: "Roma",
//         spacing: "18 in",
//         depth: "1/4 in",
//         daysToMaturity: "75",
//         sun: "full",
//         watering: "moderate",
//         sowing: "After frost",
//         zone: "8a",
//         notes: "...",
//         seedSource: "https://...",
//         harvestWindow: "July–Sept",
//         plantingWindow: "After frost"
//       },
//       ...
//     ],
//     gardenZone: "8a",
//     calendar: [
//       { action: "start-indoors", crop: "Tomato", date: "2026-02-15" },
//       { action: "direct-sow", crop: "Pea", date: "2026-03-10" },
//       ...
//     ],
//     beds: [...optional bed layout...],
//   }
//
// EVENTS
// - Emits "import.parsed.raw" (normalized to "import/parsed/raw") via eventBus shim:
//   emitEvent("import.parsed.raw", "import.parser.garden", { success, ... })
//
// IMPORTANT
// - This parser only SHAPES data; it does NOT update inventory/storehouse itself.
//   Intelligence → automation → Hub export happens AFTER normalization.
// - Designed to be shim-safe: side-effect light, works in background/worker contexts.
//
// NORMALIZER COMPATIBILITY
// - gardenParser.parse(raw, meta)    → one gardenPlan object
// - gardenParser.parseMany(raw,meta) → [gardenPlan] for normalizeMany.js
// -----------------------------------------------------------------------------

import eventBus, { emitEvent } from "../../services/events/eventBus";
import scraperService from "../../services/scraperService.js";

// -----------------------------------------------------------------------------
// Emit helper
// -----------------------------------------------------------------------------
/**
 * Emit a parser-level diagnostic event to the SSA event bus.
 *
 * Consumers may subscribe to:
 *  - "import.parsed.raw"
 *  - "import/parsed/**"
 *
 * @param {boolean} success
 * @param {object} detail
 */
function emitParserEvent(success, detail = {}) {
  emitEvent("import.parsed.raw", "import.parser.garden", {
    success,
    ...detail,
  });
}

// -----------------------------------------------------------------------------
// 1. Get HTML from input (URL or raw HTML)
// -----------------------------------------------------------------------------
async function getHtmlFromRaw(raw) {
  // HTML string?
  if (typeof raw === "string" && /<\/html>|<body|<article|<section/i.test(raw)) {
    return raw;
  }

  // URL?
  if (typeof raw === "string" && /^https?:\/\//i.test(raw)) {
    try {
      const html = await scraperService.fetchHtml(raw);
      return html;
    } catch (err) {
      console.warn("[gardenParser] fetchHtml failed:", err?.message || err);
      return null;
    }
  }

  // object with html?
  if (raw && typeof raw === "object" && typeof raw.html === "string") {
    return raw.html;
  }

  return null;
}

// -----------------------------------------------------------------------------
// 2. Detect if raw is a structured garden object already (SSA → SSA share)
// -----------------------------------------------------------------------------
function isStructuredGardenObject(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (Array.isArray(raw.plants)) return true;
  if (Array.isArray(raw.beds)) return true;
  if (Array.isArray(raw.calendar)) return true;
  if (raw.gardenZone) return true;
  return false;
}

// -----------------------------------------------------------------------------
// 3. Detect if raw looks like a seed packet object
// -----------------------------------------------------------------------------
function isSeedPacketObject(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const seedFields = [
    "variety",
    "crop",
    "plant",
    "daysToMaturity",
    "spacing",
    "depth",
    "rowSpacing",
    "sun",
    "watering",
    "sowing",
    "germination",
  ];
  return seedFields.some((f) => typeof raw[f] !== "undefined");
}

// -----------------------------------------------------------------------------
// 4. HTML fallback scraper for garden guides
//    We look for lists that can be interpreted as plants.
// -----------------------------------------------------------------------------
function fallbackScrape(html, sourceUrl) {
  if (!html) return null;

  // Title
  let title = "Imported garden guide";
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1].trim();
  } else {
    const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (h1) title = h1[1].trim();
  }

  const plants = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let lm;

  while ((lm = liRe.exec(html)) !== null) {
    const txt = lm[1].replace(/<[^>]+>/g, "").trim();
    if (!txt) continue;

    // Try to split "Tomato — full sun — 18 in"
    const split = txt.split(/\s+[-–—:]\s+/);
    if (split.length >= 2) {
      const name = split[0].trim();
      const details = split.slice(1).join(" - ").trim();
      plants.push({
        name,
        notes: details,
      });
    } else {
      // Just a plant name / line
      plants.push({
        name: txt,
      });
    }
  }

  // Try to detect zone
  let gardenZone = null;
  const zoneMatch = html.match(/zone\s*(\d+[ab]?)/i);
  if (zoneMatch) {
    gardenZone = zoneMatch[1];
  }

  return {
    type: "gardenPlan",
    domain: "garden",
    title,
    sourceUrl: sourceUrl || null,
    plants,
    gardenZone,
    calendar: [],
    beds: [],
  };
}

// -----------------------------------------------------------------------------
// 5. Normalize a seed packet to a "plant" entry
// -----------------------------------------------------------------------------
function seedPacketToPlant(raw, meta) {
  const name =
    raw.crop ||
    raw.plant ||
    raw.variety ||
    meta?.title ||
    "Unnamed plant";

  const variety = raw.variety || null;
  const plantingWindow =
    raw.sowing ||
    raw.sow ||
    raw.plantingWindow ||
    (raw.afterFrost ? "After frost" : raw.beforeFrost ? "Before frost" : null);

  return {
    name,
    variety,
    spacing: raw.spacing || raw.rowSpacing || null,
    depth: raw.depth || null,
    daysToMaturity: raw.daysToMaturity || raw.dtm || null,
    sun: raw.sun || raw.light || null,
    watering: raw.watering || null,
    sowing: raw.sowing || raw.sow || null,
    zone: raw.zone || raw.hardinessZone || null,
    notes: raw.notes || raw.description || null,
    seedSource: meta?.url || null,
    harvestWindow: raw.harvest || null,
    plantingWindow,
  };
}

// -----------------------------------------------------------------------------
// 6. Try to turn a simple text list into garden tasks / plants
// -----------------------------------------------------------------------------
function textToGardenPlan(text, meta) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const plants = [];
  const calendar = [];

  lines.forEach((line) => {
    // e.g. "Start tomatoes indoors 2/15", "Direct sow peas 3/10"
    const dateMatch = line.match(
      /(\d{1,2}[\/-]\d{1,2}|\d{4}-\d{2}-\d{2})/
    );
    if (dateMatch) {
      calendar.push({
        action: "task",
        text: line.replace(dateMatch[0], "").trim(),
        date: dateMatch[0],
      });
    } else {
      plants.push({
        name: line,
      });
    }
  });

  return {
    type: "gardenPlan",
    domain: "garden",
    title: meta?.title || "Imported garden text",
    sourceUrl: meta?.url || null,
    plants,
    gardenZone: meta?.gardenZone || null,
    calendar,
    beds: [],
  };
}

// -----------------------------------------------------------------------------
// 7. MAIN PARSE (single-plan shim)
// -----------------------------------------------------------------------------
/**
 * Parse garden-related imports into a single canonical gardenPlan object.
 *
 * normalizeMany-friendly:
 *   - gardenParser.parse(raw, meta)    → one gardenPlan object
 *   - gardenParser.parseMany(raw,meta) → [gardenPlan]
 *
 * @param {any} raw
 * @param {object} [meta]
 * @returns {Promise<object>} gardenPlan
 */
async function parse(raw, meta = {}) {
  const sourceUrl =
    (typeof raw === "string" && /^https?:\/\//i.test(raw) && raw) ||
    meta.url ||
    null;

  // CASE 1: SSA-style structured garden object
  if (isStructuredGardenObject(raw)) {
    const title = raw.title || meta.title || "Imported garden plan";
    const plants = Array.isArray(raw.plants) ? raw.plants : [];
    const calendar = Array.isArray(raw.calendar) ? raw.calendar : [];
    const beds = Array.isArray(raw.beds) ? raw.beds : [];

    emitParserEvent(true, {
      domain: "garden",
      via: "structured-object",
      title,
      plantsCount: plants.length,
      calendarCount: calendar.length,
    });

    return {
      type: "gardenPlan",
      domain: "garden",
      title,
      sourceUrl,
      plants,
      gardenZone: raw.gardenZone || raw.zone || meta.gardenZone || null,
      calendar,
      beds,
    };
  }

  // CASE 2: Seed packet object
  if (isSeedPacketObject(raw)) {
    const plant = seedPacketToPlant(raw, meta);

    emitParserEvent(true, {
      domain: "garden",
      via: "seed-packet",
      plant: plant.name,
    });

    return {
      type: "gardenPlan",
      domain: "garden",
      title: meta.title || `Seed: ${plant.name}`,
      sourceUrl,
      plants: [plant],
      gardenZone: plant.zone || meta.gardenZone || null,
      calendar: [],
      beds: [],
    };
  }

  // CASE 3: URL/HTML
  const html = await getHtmlFromRaw(raw);
  if (html) {
    const scraped = fallbackScrape(html, sourceUrl);
    if (scraped) {
      emitParserEvent(true, {
        domain: "garden",
        via: "html-fallback",
        title: scraped.title,
        plantsCount: Array.isArray(scraped.plants)
          ? scraped.plants.length
          : 0,
      });
      return scraped;
    }
  }

  // CASE 4: plain text
  if (typeof raw === "string") {
    const plan = textToGardenPlan(raw, meta);

    emitParserEvent(true, {
      domain: "garden",
      via: "text-lines",
      plantsCount: plan.plants.length,
      calendarCount: plan.calendar.length,
    });

    return plan;
  }

  // CASE 5: unknown
  emitParserEvent(false, {
    domain: "garden",
    via: "unknown",
    error: "Could not parse garden/seed data.",
  });

  return {
    type: "gardenPlan",
    domain: "garden",
    title: meta.title || "Unknown garden import",
    sourceUrl,
    plants: [],
    gardenZone: meta.gardenZone || null,
    calendar: [],
    beds: [],
    warning:
      "Parser could not identify garden structure — returned empty structure.",
  };
}

// -----------------------------------------------------------------------------
// 8. parseMany — helper for normalizeMany.js workflows
// -----------------------------------------------------------------------------
/**
 * Wraps `parse` into an array-based interface for normalizeMany-style helpers.
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
const gardenParser = {
  parse,
  parseMany,
};

export default gardenParser;
