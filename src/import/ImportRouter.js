// C:\Users\larho\suka-smart-assistant\src\import\ImportRouter.js
// -----------------------------------------------------------------------------
// PURPOSE
// -----------------------------------------------------------------------------
// Determines which parser to use per import type / domain, then (optionally)
// runs the parser and emits a normalized SSA event:
//
//   Events.IMPORT_PARSED  ("import/parsed")
//
// That event flows into your automation layer, which can:
//
//   • Update inventory
//   • Generate auto-plans / sessions
//   • Optionally export to the Hub via FamilyFundConnector
//
// File responsibilities:
//   1. Route raw imports → appropriate parser (recipe, cleaning, garden, animals,
//      storehouse, how-to, preservation).
//   2. Emit router diagnostic events ("import.router.selected", errors, etc.).
//   3. Provide a convenience `routeAndParseImport` that:
//        - calls the parser
//        - emits IMPORT_PARSED
//        - triggers domain-specific auto-plan hints
//        - optionally exports to the Hub (session-friendly shim)
//
// This file is *UI-agnostic* and safe to use from:
//   • Import landing page
//   • Background workers
//   • SessionRunner / agent shims
// -----------------------------------------------------------------------------

import eventBus, { emitEvent, Events } from "../services/events/eventBus";
import siteAllowList from "../services/siteAllowList.json";

// -----------------------------------------------------------------------------
// Emit helper (router-scoped events)
// -----------------------------------------------------------------------------
function emitRouterEvent(type, data = {}) {
  // Uses eventBus canonicalization; `type` is the event name, `data` is payload.
  emitEvent(type, "import.router", data);
}

// -----------------------------------------------------------------------------
// Optional Hub export helper — shim that is safe if Hub is not configured.
// This *never* throws; failures are logged only in development.
// -----------------------------------------------------------------------------
async function maybeExportImportEnvelope(envelope) {
  try {
    const [{ default: HubPacketFormatter }, { exportToHubIfEnabled }] = await Promise.all([
      import("../services/hub/HubPacketFormatter.js"),
      import("../services/hub/FamilyFundConnector.js"),
    ]);

    const packet =
      HubPacketFormatter && typeof HubPacketFormatter.formatImportEnvelope === "function"
        ? HubPacketFormatter.formatImportEnvelope(envelope)
        : envelope;

    // Let the connector decide if export is actually allowed based on flags.
    exportToHubIfEnabled(packet, { mode: "auto", reason: "import.parsed" });
  } catch (err) {
    try {
      // Best-effort dev logging only
      if (
        typeof import.meta !== "undefined" &&
        import.meta.env &&
        import.meta.env.MODE === "development"
      ) {
        // eslint-disable-next-line no-console
        console.warn("[ImportRouter] Hub export (import.parsed) failed silently:", err);
      }
    } catch {
      // ignore meta/env errors
    }
  }
}

// -----------------------------------------------------------------------------
// Small helper to dynamically import a parser with a primary path and a
// case-variant fallback. This protects you on case-sensitive FS.
// -----------------------------------------------------------------------------
async function safeImportParser(primaryPath, fallbackPath) {
  try {
    const mod = await import(primaryPath);
    return mod.default || mod;
  } catch (err) {
    if (fallbackPath) {
      try {
        const mod2 = await import(fallbackPath);
        return mod2.default || mod2;
      } catch (err2) {
        console.warn("[ImportRouter] failed to import parser:", primaryPath, "and", fallbackPath);
        throw err2;
      }
    }
    throw err;
  }
}

// -----------------------------------------------------------------------------
// PARSER REGISTRY (extension point)
// NOTE: all lowercase file names to match your current disk state
// -----------------------------------------------------------------------------
const PARSER_REGISTRY = {
  async recipe() {
    // primary: lowercase; fallback: PascalCase
    return safeImportParser("./parsers/recipeParser.js", "./parsers/RecipeParser.js");
  },
  async cleaning() {
    return safeImportParser("./parsers/cleaningParser.js", "./parsers/CleaningParser.js");
  },
  async garden() {
    return safeImportParser("./parsers/gardenParser.js", "./parsers/GardenParser.js");
  },
  async animal() {
    return safeImportParser("./parsers/animalParser.js", "./parsers/AnimalParser.js");
  },
  async storehouse() {
    return safeImportParser("./parsers/storehouseParser.js", "./parsers/StorehouseParser.js");
  },
  async howto() {
    // in case you named it howToParser.js
    return safeImportParser("./parsers/howtoParser.js", "./parsers/HowToParser.js");
  },
  async preservation() {
    return safeImportParser("./parsers/preservationParser.js", "./parsers/PreservationParser.js");
  },
};

// -----------------------------------------------------------------------------
// URL → host
// -----------------------------------------------------------------------------
function extractHost(urlLike) {
  if (!urlLike || typeof urlLike !== "string") return null;
  try {
    const u = new URL(urlLike);
    return u.host?.toLowerCase() || null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Look up a host in siteAllowList.json
// -----------------------------------------------------------------------------
function inferDomainFromAllowlist(host) {
  if (!host) return null;
  const domains = siteAllowList?.domains || siteAllowList?.Sites || {};
  if (domains[host]) {
    return domains[host].domain || domains[host].type || null;
  }
  // try root (e.g. "www.allrecipes.com" → "allrecipes.com")
  const parts = host.split(".");
  if (parts.length > 2) {
    const root = parts.slice(-2).join(".");
    if (domains[root]) {
      return domains[root].domain || domains[root].type || null;
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Content sniffers — try to figure out domain from raw payload
// -----------------------------------------------------------------------------
function sniffDomainFromRaw(raw) {
  if (!raw) return null;
  const asStr = typeof raw === "string" ? raw : JSON.stringify(raw);

  if (/\bingredient\b|\bingredients\b|prep time|cook time|servings/i.test(asStr)) {
    return "recipe";
  }
  if (/\bdeclutter\b|\bcleaning\b|\bzone\b|\bchore\b|\broom\b|\bkitchen day\b/i.test(asStr)) {
    return "cleaning";
  }
  if (/\bseed\b|\bplanting\b|\bsow\b|\bspacing\b|\bfrost date\b|\bzone\s*\d+/i.test(asStr)) {
    return "garden";
  }
  if (/\bbutcher\b|\byield\b|\bcarcass\b|\bslaughter\b|\bgoat\b|\bsheep\b|\bduck\b/i.test(asStr)) {
    return "animal";
  }
  if (/\bstorehouse\b|\bpantry\b|\broot cellar\b|\binventory target\b/i.test(asStr)) {
    return "storehouse";
  }
  if (/\byoutube\.com\/watch|tiktok\.com\/@|facebook\.com\/reel/i.test(asStr)) {
    return "howto";
  }
  if (/\bbrine\b|\bferment\b|\bdehydrate\b|\bpressure can\b|\bpasteurize\b/i.test(asStr)) {
    return "preservation";
  }

  return null;
}

// -----------------------------------------------------------------------------
// Parser runner — supports both { parse() } and direct function parsers
// -----------------------------------------------------------------------------
async function runParser(parser, raw, meta) {
  if (!parser) throw new Error("No parser provided");

  // If parser is a class instance or object with `parse`:
  if (typeof parser.parse === "function") {
    return parser.parse(raw, meta);
  }

  // If parser itself is a function:
  if (typeof parser === "function") {
    return parser(raw, meta);
  }

  // Fallback: if parser.default is a function
  if (parser.default && typeof parser.default === "function") {
    return parser.default(raw, meta);
  }

  throw new Error("Unsupported parser type — expected function or { parse() }");
}

// -----------------------------------------------------------------------------
// MAIN ROUTER FUNCTION (routing ONLY, for backward compatibility)
// -----------------------------------------------------------------------------
/**
 * Route an import to the appropriate parser, but do NOT run the parser.
 * Returns: { ok, domain, parser, reason, warning? }
 */
async function routeImport({ domain, raw, meta = {} } = {}) {
  if (!raw) {
    const out = {
      ok: false,
      error: "No raw payload provided.",
      reason: "missing-raw",
    };
    emitRouterEvent("import.router.error", out);
    return out;
  }

  // 1. Explicit domain from caller
  if (domain && PARSER_REGISTRY[domain]) {
    const parser = await PARSER_REGISTRY[domain]();
    const out = {
      ok: true,
      domain,
      parser,
      reason: "matched-by-explicit-domain",
    };
    emitRouterEvent("import.router.selected", { ...out, meta });
    return out;
  }

  // 2. Infer from URL / allowlist
  const possibleUrl =
    (typeof raw === "string" && raw.startsWith("http") && raw) ||
    meta.url ||
    (typeof raw === "string" && /https?:\/\//.test(raw) ? raw.match(/https?:\/\/\S+/)?.[0] : null);

  if (possibleUrl) {
    const host = extractHost(possibleUrl);
    const inferred = inferDomainFromAllowlist(host);
    if (inferred && PARSER_REGISTRY[inferred]) {
      const parser = await PARSER_REGISTRY[inferred]();
      const out = {
        ok: true,
        domain: inferred,
        parser,
        reason: "matched-by-allowlist",
      };
      emitRouterEvent("import.router.selected", { ...out, meta: { ...meta, host } });
      return out;
    }
  }

  // 3. Sniff content
  const sniffed = sniffDomainFromRaw(raw);
  if (sniffed && PARSER_REGISTRY[sniffed]) {
    const parser = await PARSER_REGISTRY[sniffed]();
    const out = {
      ok: true,
      domain: sniffed,
      parser,
      reason: "matched-by-sniffer",
    };
    emitRouterEvent("import.router.selected", { ...out, meta });
    return out;
  }

  // 4. Fallback → recipe
  if (PARSER_REGISTRY.recipe) {
    const parser = await PARSER_REGISTRY.recipe();
    const out = {
      ok: true,
      domain: "recipe",
      parser,
      reason: "fallback-default",
      warning: "Unknown domain; routed to recipe parser as safe default.",
    };
    emitRouterEvent("import.router.unknown", {
      rawPreview: typeof raw === "string" ? raw.slice(0, 160) : "[non-string]",
      meta,
    });
    return out;
  }

  // 5. No parser found
  const out = {
    ok: false,
    error: "No matching parser found and no fallback available.",
    reason: "no-parser",
  };
  emitRouterEvent("import.router.error", out);
  return out;
}

// -----------------------------------------------------------------------------
// AUTO-PLAN HINT EMITTER
// Emits domain-specific "generate requested" events so engines can respond.
// -----------------------------------------------------------------------------
function emitAutoPlanHints(domain, normalized, meta) {
  const payload = { normalized, meta };

  switch (domain) {
    case "recipe": {
      // meals + cooking engines
      emitEvent("meals.plan.generate.requested", "import.router", payload);
      emitEvent("cooking.session.generate.requested", "import.router", payload);
      break;
    }
    case "cleaning": {
      emitEvent("cleaning.session.generate.requested", "import.router", payload);
      break;
    }
    case "garden": {
      // Use the registry constant where available
      emitEvent(Events.GARDEN_PLAN_GENERATE_REQ, "import.router", payload);
      emitEvent("garden.care.schedule.requested", "import.router", payload);
      break;
    }
    case "storehouse": {
      emitEvent("storehouse.stockPlan.generate.requested", "import.router", payload);
      break;
    }
    case "animal": {
      emitEvent("animals.plan.generate.requested", "import.router", payload);
      emitEvent("animals.fromRecipes.generate.requested", "import.router", payload);
      break;
    }
    case "preservation": {
      emitEvent("preservation.plan.generate.requested", "import.router", payload);
      emitEvent("preservation.session.generate.requested", "import.router", payload);
      break;
    }
    default: {
      // For domains like "howto" we may intentionally do nothing for now.
      break;
    }
  }
}

// -----------------------------------------------------------------------------
// HIGH-LEVEL: route + parse + emit import.parsed + autoplan + optional Hub export
// -----------------------------------------------------------------------------
/**
 * Full import pipeline helper used by SSA:
 *
 *   1. routeImport → find parser
 *   2. runParser   → get normalized representation
 *   3. emit IMPORT_PARSED via eventBus (Events.IMPORT_PARSED)
 *   4. emit auto-plan hints for relevant domains
 *   5. optionally export envelope to Hub via FamilyFundConnector
 *
 * @param {Object}   opts
 * @param {string}  [opts.domain]                 - Optional hint for parser domain
 * @param {any}      opts.raw                     - Raw import payload (HTML, JSON, URL text, etc.)
 * @param {Object}  [opts.meta]                   - Metadata (source URL, user, etc.)
 * @param {boolean} [opts.autoPlan=true]          - Emit domain auto-plan events
 * @param {boolean} [opts.exportToHub=true]       - Try exporting to Hub if enabled
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   domain?: string,
 *   normalized?: any,
 *   router?: any,
 *   error?: string
 * }>}
 */
async function routeAndParseImport({
  domain,
  raw,
  meta = {},
  autoPlan = true,
  exportToHub = true,
} = {}) {
  const router = await routeImport({ domain, raw, meta });
  if (!router.ok || !router.parser) {
    return {
      ok: false,
      error: router.error || "Routing failed",
      router,
    };
  }

  let normalized;
  try {
    normalized = await runParser(router.parser, raw, meta);
  } catch (err) {
    const errorOut = {
      ok: false,
      error: String(err && err.message ? err.message : err),
      reason: "parser-error",
      domain: router.domain,
    };
    emitRouterEvent("import.router.parse-error", { ...errorOut, meta });
    return errorOut;
  }

  const envelopeData = {
    domain: router.domain,
    normalized,
    meta,
    rawPreview: typeof raw === "string" ? raw.slice(0, 4000) : undefined,
    router: {
      reason: router.reason,
      warning: router.warning,
    },
  };

  // 1) Emit canonical IMPORT_PARSED event
  emitEvent(Events.IMPORT_PARSED, "import.router", envelopeData);

  // 2) Autoplan hints for engines
  if (autoPlan) {
    emitAutoPlanHints(router.domain, normalized, meta);
  }

  // 3) Optional Hub export (session-friendly shim)
  if (exportToHub) {
    const envelope = {
      type: Events.IMPORT_PARSED,
      ts: new Date().toISOString(),
      source: "import.router",
      data: envelopeData,
    };
    void maybeExportImportEnvelope(envelope);
  }

  return {
    ok: true,
    domain: router.domain,
    normalized,
    router,
  };
}

// -----------------------------------------------------------------------------
// Runtime registration (for community / Hub-sent modules)
// -----------------------------------------------------------------------------
function registerDynamicParser(domain, loaderFn) {
  if (!domain || typeof loaderFn !== "function") return;
  PARSER_REGISTRY[domain] = loaderFn;
  emitRouterEvent("import.router.dynamic-registered", { domain });
}

// -----------------------------------------------------------------------------
// EXPORT
// -----------------------------------------------------------------------------
// Default object keeps backward compatibility AND exposes new helper.
//
const ImportRouter = {
  routeImport,
  routeAndParseImport,
  registerDynamicParser,
  __sniffDomainFromRaw: sniffDomainFromRaw,
  __inferDomainFromAllowlist: inferDomainFromAllowlist,
  __extractHost: extractHost,
};

export default ImportRouter;
