// C:\Users\larho\suka-smart-assistant\src\import\parsers\cleaningParser.js
// Parses cleaning and housekeeping routines (shim-safe, normalizeMany-friendly)
// -----------------------------------------------------------------------------
// ROLE IN PIPELINE
// ImportService.importPayload(...) → ImportRouter.routeImport(...) →
//   **cleaningParser.parse(...)** → ImportNormalizer.normalizeImport("cleaning", ...) →
//   automation.runtime → (optional) Hub (done later, not here)
//
// WHAT THIS PARSER HANDLES
// - Cleaning blog posts (weekly, daily, zone cleaning, declutter challenges)
// - JSON payloads coming from an SSA bookmarklet / mobile share
// - Pretty HTML lists (e.g. <ul><li>Vacuum bedrooms</li>…)
// - Structured objects from other SSA users: { title, zones, routines, cadence }
//
// CANONICAL OUTPUT (to normalizer)
//
//   {
//     type: "cleaningPlan",
//     domain: "cleaning",
//     title: "Weekly Kitchen Reset",
//     sourceUrl: "https://...",
//     zones: [{ id: "kitchen", name: "Kitchen", tasks: [{ text: "Wipe counters" }, ...] }, ...],
//     routines: [
//       { name: "Daily", tasks: [{ text: "Unload dishwasher" }, ...] },
//       { name: "Weekly", tasks: [{ text: "Mop floor" }, ...] },
//     ],
//     cadence: "weekly" | "daily" | "monthly" | "seasonal" | null,
//   }
//
// EVENTS
// - Emits "import.parsed.raw" (normalized to "import/parsed/raw") via eventBus:
//   emitEvent("import.parsed.raw", "import.parser.cleaning", { success, ... })
//
// IMPORTANT
// - This parser only SHAPES the data; it does NOT update inventory/storehouse itself.
//   Intelligence → automation → Hub export happens AFTER normalization.
// - Designed to be shim-safe (can run in workers / background contexts).
//
// NORMALIZER COMPATIBILITY
// - parse(raw, meta)  → single cleaningPlan object.
// - parseMany(raw, meta) → [cleaningPlan] for normalizeMany.js.
// -----------------------------------------------------------------------------

import eventBus, { emitEvent } from "../../services/events/eventBus";
import scraperService from "../../services/scraperService.js";

// -----------------------------------------------------------------------------
// Emit helper
// -----------------------------------------------------------------------------
/**
 * Emit a parser-level diagnostic event to the SSA event bus.
 *
 * Consumers can subscribe with:
 *   on("import.parsed.raw", handler)
 * or:
 *   on("import/parsed/**", handler)
 *
 * @param {boolean} success
 * @param {object} detail
 */
function emitParserEvent(success, detail = {}) {
  emitEvent("import.parsed.raw", "import.parser.cleaning", {
    success,
    ...detail,
  });
}

// -----------------------------------------------------------------------------
// 1. Get HTML from input (URL or raw HTML)
// -----------------------------------------------------------------------------
async function getHtmlFromRaw(raw) {
  // Clearly HTML
  if (typeof raw === "string" && /<\/html>|<body|<article|<section/i.test(raw)) {
    return raw;
  }

  // URL → fetch
  if (typeof raw === "string" && /^https?:\/\//i.test(raw)) {
    try {
      const html = await scraperService.fetchHtml(raw);
      return html;
    } catch (err) {
      console.warn("[cleaningParser] fetchHtml failed:", err?.message || err);
      return null;
    }
  }

  // Already an object with html
  if (raw && typeof raw === "object" && typeof raw.html === "string") {
    return raw.html;
  }

  return null;
}

// -----------------------------------------------------------------------------
// 2. If the raw is already a structured cleaning object from SSA or another app
// -----------------------------------------------------------------------------
function isStructuredCleaningObject(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  // Allow any of these to qualify
  if (Array.isArray(raw.zones)) return true;
  if (Array.isArray(raw.routines)) return true;
  if (typeof raw.cadence === "string") return true;
  if (typeof raw.title === "string" && Array.isArray(raw.tasks)) return true;
  return false;
}

// -----------------------------------------------------------------------------
// 3. HTML fallback scrapers
// We try to detect:
//  - "zone" style lists (Kitchen, Bathrooms, Bedrooms, Living room)
//  - "daily / weekly / monthly" headers
//  - generic <li> steps
// -----------------------------------------------------------------------------
function fallbackScrape(html, sourceUrl) {
  if (!html) return null;

  // Title
  let title = "Imported cleaning routine";
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1].trim();
  } else {
    // Try <h1>
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (h1Match) title = h1Match[1].trim();
  }

  // Detect "daily / weekly / monthly" sections
  const sections = [];
  const sectionRe = /<(h2|h3|h4)[^>]*>([^<]+)<\/\1>([\s\S]*?)(?=<h\d|\Z)/gi;
  let sm;
  while ((sm = sectionRe.exec(html)) !== null) {
    const heading = sm[2].trim();
    const body = sm[3];
    const tasks = [];
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let lm;
    while ((lm = liRe.exec(body)) !== null) {
      const task = lm[1].replace(/<[^>]+>/g, "").trim();
      if (task) tasks.push(task);
    }
    sections.push({
      name: heading,
      tasks,
    });
  }

  // Detect zone-like list if no sections found
  const zones = [];
  if (sections.length === 0) {
    // Look for common room names
    const possibleZones = [
      "kitchen",
      "bathroom",
      "bathrooms",
      "bedroom",
      "bedrooms",
      "living",
      "living room",
      "dining",
      "entry",
      "entryway",
    ];

    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let lm;
    while ((lm = liRe.exec(html)) !== null) {
      const rawTxt = lm[1].replace(/<[^>]+>/g, "").trim();
      if (!rawTxt) continue;

      // Try to split "Kitchen – wipe counters"
      const dashSplit = rawTxt.split(/\s+[-–:]\s+/);
      if (dashSplit.length >= 2) {
        const zoneNameRaw = dashSplit[0].trim();
        const zoneName = zoneNameRaw.toLowerCase();
        const task = dashSplit.slice(1).join(" - ").trim();

        const existing = zones.find(
          (z) => z.name?.toLowerCase() === zoneName
        );
        if (existing) {
          existing.tasks.push(task);
        } else {
          zones.push({
            id: zoneName.replace(/\s+/g, "-"),
            name: zoneNameRaw,
            tasks: [task],
          });
        }
        continue;
      }

      // Or match rooms by keyword
      const lc = rawTxt.toLowerCase();
      const zoneMatch = possibleZones.find((z) => lc.includes(z));
      if (zoneMatch) {
        const existing = zones.find(
          (z) => z.name.toLowerCase() === zoneMatch.toLowerCase()
        );
        if (existing) {
          existing.tasks.push(rawTxt);
        } else {
          zones.push({
            id: zoneMatch.replace(/\s+/g, "-"),
            name: zoneMatch,
            tasks: [rawTxt],
          });
        }
      }
    }
  }

  // Decide output
  if (sections.length > 0) {
    return {
      type: "cleaningPlan",
      domain: "cleaning",
      title,
      sourceUrl: sourceUrl || null,
      zones: [],
      routines: sections.map((s) => ({
        name: s.name,
        tasks: s.tasks.map((t) => ({ text: t })),
      })),
      cadence: inferCadenceFromSections(sections),
    };
  }

  return {
    type: "cleaningPlan",
    domain: "cleaning",
    title,
    sourceUrl: sourceUrl || null,
    zones: zones.map((z) => ({
      id: z.id,
      name: z.name,
      tasks: z.tasks.map((t) => ({ text: t })),
    })),
    routines: [],
    cadence: null,
  };
}

// -----------------------------------------------------------------------------
// 4. Try to guess cadence from section names
// -----------------------------------------------------------------------------
function inferCadenceFromSections(sections) {
  const names = sections.map((s) => s.name.toLowerCase());
  if (names.some((n) => n.includes("daily"))) return "daily";
  if (names.some((n) => n.includes("weekly"))) return "weekly";
  if (names.some((n) => n.includes("monthly"))) return "monthly";
  if (names.some((n) => n.includes("seasonal") || n.includes("spring cleaning"))) return "seasonal";
  return null;
}

// -----------------------------------------------------------------------------
// 5. MAIN PARSE (single-plan shim)
// -----------------------------------------------------------------------------
/**
 * Parse cleaning-related imports into a single canonical cleaningPlan object.
 *
 * This is normalizeMany-friendly:
 *   - cleaningParser.parse(raw, meta) → one object
 *   - cleaningParser.parseMany(raw, meta) → [object]
 *
 * @param {any} raw
 * @param {object} [meta]
 * @returns {Promise<object>} cleaningPlan
 */
async function parse(raw, meta = {}) {
  // Precompute sourceUrl
  const sourceUrl =
    (typeof raw === "string" && /^https?:\/\//i.test(raw) && raw) ||
    meta.url ||
    null;

  // CASE 1: Structured cleaning object already (SSA → SSA share)
  if (isStructuredCleaningObject(raw)) {
    const title = raw.title || meta.title || "Imported cleaning routine";

    emitParserEvent(true, {
      domain: "cleaning",
      via: "structured-object",
      title,
    });

    return {
      type: "cleaningPlan",
      domain: "cleaning",
      title,
      sourceUrl,
      zones: Array.isArray(raw.zones) ? raw.zones : [],
      routines: Array.isArray(raw.routines) ? raw.routines : [],
      cadence: raw.cadence || null,
    };
  }

  // CASE 2: string / URL / HTML
  const html = await getHtmlFromRaw(raw);
  if (html) {
    const scraped = fallbackScrape(html, sourceUrl);
    if (scraped) {
      emitParserEvent(true, {
        domain: "cleaning",
        via: "html-fallback",
        title: scraped.title,
        cadence: scraped.cadence,
      });
      return scraped;
    }
  }

  // CASE 3: raw text (e.g. copy/pasted from social media)
  if (typeof raw === "string") {
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    // Group lines into a single "routine"
    const tasks = lines.map((l) => ({ text: l }));
    const cadence =
      lines.some((l) => /daily/i.test(l))
        ? "daily"
        : lines.some((l) => /weekly/i.test(l))
        ? "weekly"
        : lines.some((l) => /monthly/i.test(l))
        ? "monthly"
        : null;

    emitParserEvent(true, {
      domain: "cleaning",
      via: "text-lines",
      lineCount: lines.length,
      cadence,
    });

    const routineName =
      cadence === "daily"
        ? "Daily"
        : cadence === "weekly"
        ? "Weekly"
        : cadence === "monthly"
        ? "Monthly"
        : "Cleaning";

    return {
      type: "cleaningPlan",
      domain: "cleaning",
      title: meta.title || "Imported cleaning steps",
      sourceUrl,
      zones: [],
      routines: [
        {
          name: routineName,
          tasks,
        },
      ],
      cadence,
    };
  }

  // CASE 4: unknown
  emitParserEvent(false, {
    domain: "cleaning",
    via: "unknown",
    error: "Could not parse cleaning/housekeeping data.",
  });

  return {
    type: "cleaningPlan",
    domain: "cleaning",
    title: meta.title || "Unknown cleaning plan",
    sourceUrl,
    zones: [],
    routines: [],
    cadence: null,
    warning: "Parser could not identify cleaning structure — returned empty structure.",
  };
}

// -----------------------------------------------------------------------------
// 6. parseMany — helper for normalizeMany.js workflows
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
const cleaningParser = {
  parse,
  parseMany,
};

export default cleaningParser;
