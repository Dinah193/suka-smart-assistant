// File: C:\Users\larho\suka-smart-assistant\src\services\imports\ImportRouter.js
/**
 * ImportRouter (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Unified, browser-safe "ingest router" that directs uploads/imports to the
 *    right parser/normalizer pipeline and emits events for downstream layers:
 *      L0 artifacts -> L1 parsed_candidates -> L2 method_maps -> L3 blueprints
 *
 * Why this exists
 *  - SSA has many entry points (QuickAdd, Scanner, recipe imports, receipts,
 *    cleaning plans, garden plans, animal logs, etc.). This router provides a
 *    single, production-safe place to:
 *      • detect import type
 *      • normalize into a standard artifact/ingest envelope
 *      • call ImportIntelligenceService to parse
 *      • cache results (ImportCacheService)
 *      • emit eventBus signals for orchestrators
 *
 * It is intentionally tolerant about schemas and optional dependencies so Vite
 * builds do not fail if some modules are absent.
 *
 * API
 *  - routeImport(input, options)  -> { ok, artifact, parsed, candidates, blueprint, ... }
 *  - detectImportType(input, hints)
 *  - registerRoute(routeDef)
 *  - listRoutes()
 *
 * Input can be:
 *  - File | Blob | string (text/URL) | object (already parsed or scanner payload)
 *
 * Options
 *  {
 *    source: "quickadd"|"scanner"|"import",
 *    kindHint: "receipt"|"recipe"|"clean_plan"|...,
 *    householdId, userId,
 *    mode: "parseOnly"|"parseAndBlueprint",
 *    commit: false|true,
 *    cache: true|false,
 *    emit: true|false,
 *    meta: {},
 *  }
 */

const SOURCE = "services.imports.ImportRouter";

/* -----------------------------------------------------------------------------
 * Optional dependencies (safe, no build breaks)
 * -------------------------------------------------------------------------- */

async function loadDeps() {
  const out = {
    cache: null,
    intel: null,
    logger: null,
    bus: null,
    db: null,
  };

  try {
    const m = await import("./ImportCacheService.js").catch(() => null);
    out.cache = m?.default || m || null;
  } catch {}

  try {
    const m = await import("./ImportIntelligenceService.js").catch(() => null);
    out.intel = m?.default || m || null;
  } catch {}

  try {
    const m = await import("../../utils/logger.js").catch(() => null);
    out.logger = m?.default || m?.logger || m || null;
  } catch {}

  try {
    const m = await import("../automation/eventBus.js").catch(() => null);
    out.bus =
      m?.eventBus || m?.bus || m?.default?.eventBus || m?.default || null;
  } catch {}

  try {
    const m = await import("../db.js").catch(() => null);
    out.db = m?.db || m?.default || m || null;
  } catch {}

  return out;
}

function log(logger, level, ...args) {
  try {
    const fn =
      (level === "error" && logger?.error) ||
      (level === "warn" && logger?.warn) ||
      (level === "info" && logger?.info) ||
      logger?.log;
    if (typeof fn === "function") fn(...args);
  } catch {}
}

function emit(bus, event, payload) {
  try {
    if (!bus) return;
    if (typeof bus.emit === "function") bus.emit(event, payload);
    else if (typeof bus.publish === "function") bus.publish(event, payload);
  } catch {}
}

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const safeObj = (x) => (isObj(x) ? x : {});
const safeArr = (x) => (Array.isArray(x) ? x : []);
const nowISO = () => new Date().toISOString();

const keyOf = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");

function stableId(prefix = "art") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function isFileLike(x) {
  return typeof File !== "undefined" && x instanceof File;
}
function isBlobLike(x) {
  return typeof Blob !== "undefined" && x instanceof Blob;
}

function guessMimeFromName(name) {
  const n = String(name || "").toLowerCase();
  if (n.endsWith(".json")) return "application/json";
  if (n.endsWith(".csv")) return "text/csv";
  if (n.endsWith(".txt")) return "text/plain";
  if (n.endsWith(".md")) return "text/markdown";
  if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
  if (n.endsWith(".pdf")) return "application/pdf";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".webp")) return "image/webp";
  return "";
}

async function readAsText(input) {
  if (typeof input === "string") return input;
  if (isFileLike(input) || isBlobLike(input)) {
    try {
      return await input.text();
    } catch {
      // fallback FileReader
      return await new Promise((resolve, reject) => {
        try {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result || ""));
          fr.onerror = () => reject(fr.error || new Error("FileReader failed"));
          fr.readAsText(input);
        } catch (e) {
          reject(e);
        }
      });
    }
  }
  if (isObj(input)) return JSON.stringify(input);
  return String(input ?? "");
}

function sniffTypeFromText(text) {
  const t = String(text || "").trim();
  if (!t) return null;

  // JSON
  if (
    (t.startsWith("{") && t.endsWith("}")) ||
    (t.startsWith("[") && t.endsWith("]"))
  ) {
    return "json";
  }

  // CSV-ish (has commas and multiple lines)
  if (t.includes(",") && (t.includes("\n") || t.includes("\r"))) return "csv";

  // Receipt-ish (has totals keywords)
  const lower = t.toLowerCase();
  if (lower.includes("subtotal") && lower.includes("total"))
    return "receipt_text";

  // Recipe-ish
  if (
    lower.includes("ingredients") &&
    (lower.includes("directions") || lower.includes("instructions"))
  ) {
    return "recipe_text";
  }

  // Fallback plain
  return "text";
}

function normalizeArtifactEnvelope(input, options = {}) {
  const opts = safeObj(options);
  const source = opts.source || "import";
  const householdId = opts.householdId || null;
  const userId = opts.userId || null;

  // Basic fields
  let name = "";
  let mime = "";
  let size = undefined;

  if (isFileLike(input)) {
    name = input.name || "";
    mime = input.type || guessMimeFromName(name);
    size = input.size;
  } else if (isBlobLike(input)) {
    mime = input.type || "";
    size = input.size;
  } else if (typeof input === "string") {
    name = "text";
    mime = "text/plain";
    size = input.length;
  } else if (isObj(input)) {
    name = input.name || input.title || "object";
    mime = input.mime || input.type || "application/json";
  }

  const id = opts.artifactId ? String(opts.artifactId) : stableId("art");
  const kindHint = opts.kindHint ? String(opts.kindHint) : null;

  return {
    id,
    source,
    kindHint,
    householdId,
    userId,
    name,
    mime,
    size,
    createdAtISO: nowISO(),
    meta: safeObj(opts.meta),
    raw: input,
  };
}

/* -----------------------------------------------------------------------------
 * Route registry
 * -------------------------------------------------------------------------- */

const _routes = [];

/**
 * A route def:
 *  {
 *    id: "receipt",
 *    match: (ctx)=>boolean,
 *    handle: async (ctx, deps)=>result,
 *    priority?: number
 *  }
 */
function registerRoute(route) {
  const r = safeObj(route);
  if (
    !r.id ||
    typeof r.match !== "function" ||
    typeof r.handle !== "function"
  ) {
    throw new Error(
      `[${SOURCE}] registerRoute requires { id, match(), handle() }`
    );
  }
  const id = keyOf(r.id);
  const priority = Number.isFinite(r.priority) ? Number(r.priority) : 0;

  // replace if existing
  const idx = _routes.findIndex((x) => x.id === id);
  const next = { ...r, id, priority };
  if (idx >= 0) _routes[idx] = next;
  else _routes.push(next);

  // sort high priority first
  _routes.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return id;
}

function listRoutes() {
  return _routes.map((r) => ({ id: r.id, priority: r.priority || 0 }));
}

/* -----------------------------------------------------------------------------
 * Detection
 * -------------------------------------------------------------------------- */

export function detectImportType(input, hints = {}) {
  const h = safeObj(hints);
  const kindHint = h.kindHint ? keyOf(h.kindHint) : "";

  // strong hint wins
  if (kindHint) return kindHint;

  // file types
  if (isFileLike(input)) {
    const n = String(input.name || "").toLowerCase();
    const mt = String(input.type || guessMimeFromName(n)).toLowerCase();
    if (mt.includes("pdf")) return "pdf";
    if (mt.includes("image/")) return "image";
    if (n.includes("receipt")) return "receipt";
    if (n.includes("recipe")) return "recipe";
    if (n.endsWith(".csv")) return "csv";
    if (n.endsWith(".json")) return "json";
    return mt || "file";
  }

  if (isBlobLike(input)) {
    const mt = String(input.type || "").toLowerCase();
    if (mt.includes("pdf")) return "pdf";
    if (mt.includes("image/")) return "image";
    if (mt.includes("json")) return "json";
    if (mt.includes("csv") || mt.includes("text/")) return "text";
    return "blob";
  }

  if (typeof input === "string") {
    const txtType = sniffTypeFromText(input);
    if (txtType === "receipt_text") return "receipt";
    if (txtType === "recipe_text") return "recipe";
    return txtType || "text";
  }

  if (isObj(input)) {
    // scanner payload patterns
    const o = input;
    if (o.mode && String(o.mode).toLowerCase().includes("shopping"))
      return "shopping_scan";
    if (o.receipt || o.receiptLines || o.total || o.subtotal) return "receipt";
    if (o.ingredients || o.instructions || o.directions) return "recipe";
    if (o.cleanPlan || o.cleaningPlan || o.roomPlan) return "clean_plan";
    if (o.gardenPlan || o.bedPlan || o.crop) return "garden_plan";
    if (o.animalLog || o.herd || o.flock) return "animal_log";
    if (o.type) return keyOf(o.type);
    return "object";
  }

  return "unknown";
}

/* -----------------------------------------------------------------------------
 * Default route handlers (generic pipeline)
 * -------------------------------------------------------------------------- */

async function defaultHandle(ctx, deps) {
  const { intel, cache, logger, bus } = deps;

  const mode = ctx.options.mode || "parseAndBlueprint";
  const cacheEnabled = ctx.options.cache !== false;
  const emitEnabled = ctx.options.emit !== false;

  // Build "ingest envelope" for downstream services
  // Try to keep compatible with whatever ImportIntelligenceService expects.
  const envelope = {
    artifact: ctx.artifact,
    type: ctx.type,
    source: ctx.artifact.source,
    kindHint: ctx.artifact.kindHint,
    householdId: ctx.artifact.householdId,
    userId: ctx.artifact.userId,
    meta: ctx.artifact.meta,
    options: safeObj(ctx.options),
  };

  // Cache lookup (by fingerprint if available)
  let cached = null;
  if (cacheEnabled && cache && typeof cache.get === "function") {
    try {
      cached = await cache.get(envelope);
    } catch (e) {
      log(logger, "warn", `[${SOURCE}] cache.get failed`, e);
    }
  }

  if (cached && cached.ok) {
    if (emitEnabled) {
      emit(bus, "import.routed", {
        type: ctx.type,
        artifactId: ctx.artifact.id,
        cached: true,
        at: nowISO(),
      });
    }
    return { ...cached, cached: true };
  }

  // Parse via ImportIntelligenceService if present; else minimal parsing.
  let parsed = null;
  let candidates = [];
  let blueprint = null;

  if (intel && typeof intel.parse === "function") {
    const inputForParse = await (async () => {
      // If file/blob, keep raw; otherwise provide text
      if (isFileLike(ctx.artifact.raw) || isBlobLike(ctx.artifact.raw))
        return ctx.artifact.raw;
      // object/string -> text/obj
      if (isObj(ctx.artifact.raw)) return ctx.artifact.raw;
      return await readAsText(ctx.artifact.raw);
    })();

    try {
      parsed = await intel.parse(inputForParse, envelope);
    } catch (e) {
      log(
        logger,
        "error",
        `[${SOURCE}] ImportIntelligenceService.parse failed`,
        e
      );
      parsed = { ok: false, error: e?.message || String(e) };
    }
  } else {
    // minimal fallback
    const text = await readAsText(ctx.artifact.raw);
    parsed = { ok: true, type: ctx.type, text, meta: { fallback: true } };
  }

  // normalized output shape
  candidates = safeArr(
    parsed?.candidates ||
      parsed?.parsed_candidates ||
      parsed?.items ||
      parsed?.lines
  );
  blueprint = parsed?.blueprint || parsed?.sessionBlueprint || null;

  // If mode is parseOnly, remove blueprint
  if (mode === "parseOnly") blueprint = null;

  const result = {
    ok: !!parsed?.ok || parsed?.ok == null, // treat missing ok as OK
    type: ctx.type,
    artifact: ctx.artifact,
    parsed,
    candidates,
    blueprint,
    atISO: nowISO(),
    cached: false,
  };

  // Cache save
  if (cacheEnabled && cache && typeof cache.put === "function") {
    try {
      await cache.put(envelope, result);
    } catch (e) {
      log(logger, "warn", `[${SOURCE}] cache.put failed`, e);
    }
  }

  // Emit events
  if (emitEnabled) {
    emit(bus, "import.routed", {
      type: ctx.type,
      artifactId: ctx.artifact.id,
      cached: false,
      at: result.atISO,
    });
    emit(bus, "import.parsed", {
      type: ctx.type,
      artifactId: ctx.artifact.id,
      candidateCount: safeArr(candidates).length,
      hasBlueprint: !!blueprint,
      at: result.atISO,
    });
  }

  return result;
}

/* -----------------------------------------------------------------------------
 * Register default routes (priority-based)
 * -------------------------------------------------------------------------- */

// Receipts / shopping
registerRoute({
  id: "receipt",
  priority: 100,
  match: (ctx) => {
    const t = keyOf(ctx.type);
    return t === "receipt" || t === "receipt_text" || t === "shopping_scan";
  },
  handle: async (ctx, deps) => defaultHandle(ctx, deps),
});

// Recipes
registerRoute({
  id: "recipe",
  priority: 90,
  match: (ctx) =>
    keyOf(ctx.type) === "recipe" || keyOf(ctx.type) === "recipe_text",
  handle: async (ctx, deps) => defaultHandle(ctx, deps),
});

// Cleaning plans
registerRoute({
  id: "clean_plan",
  priority: 80,
  match: (ctx) =>
    keyOf(ctx.type) === "clean_plan" || keyOf(ctx.type) === "cleaning_plan",
  handle: async (ctx, deps) => defaultHandle(ctx, deps),
});

// Garden plans
registerRoute({
  id: "garden_plan",
  priority: 70,
  match: (ctx) =>
    keyOf(ctx.type) === "garden_plan" || keyOf(ctx.type) === "bed_plan",
  handle: async (ctx, deps) => defaultHandle(ctx, deps),
});

// Animal logs
registerRoute({
  id: "animal_log",
  priority: 60,
  match: (ctx) =>
    keyOf(ctx.type) === "animal_log" ||
    keyOf(ctx.type) === "herd_log" ||
    keyOf(ctx.type) === "flock_log",
  handle: async (ctx, deps) => defaultHandle(ctx, deps),
});

// Generic file/json/text
registerRoute({
  id: "generic",
  priority: -1,
  match: () => true,
  handle: async (ctx, deps) => defaultHandle(ctx, deps),
});

/* -----------------------------------------------------------------------------
 * Public router: routeImport()
 * -------------------------------------------------------------------------- */

/**
 * routeImport(input, options)
 *
 * Returns:
 *  {
 *    ok, type, artifact, parsed, candidates, blueprint, cached, atISO
 *  }
 */
export async function routeImport(input, options = {}) {
  const opts = safeObj(options);
  const deps = await loadDeps();
  const { logger, bus } = deps;

  const artifact = normalizeArtifactEnvelope(input, opts);
  const type = detectImportType(input, {
    kindHint: artifact.kindHint,
    ...opts,
  });

  const ctx = {
    type,
    artifact,
    options: opts,
  };

  // Route select
  const route =
    _routes.find((r) => {
      try {
        return !!r.match(ctx);
      } catch {
        return false;
      }
    }) || _routes[_routes.length - 1];

  if (!route) {
    const err = new Error(`[${SOURCE}] No routes registered`);
    log(logger, "error", err.message);
    return { ok: false, error: err.message, type, artifact };
  }

  // Emit pre-route
  if (opts.emit !== false) {
    emit(bus, "import.route.selected", {
      routeId: route.id,
      type,
      artifactId: artifact.id,
      at: nowISO(),
    });
  }

  // Handle
  let result;
  try {
    result = await route.handle(ctx, deps);
  } catch (e) {
    const msg = e?.message || String(e);
    log(logger, "error", `[${SOURCE}] route.handle failed`, msg, e);
    result = { ok: false, error: msg, type, artifact, atISO: nowISO() };
  }

  // Optional commit hook (if your intelligence layer supports it)
  if (opts.commit) {
    try {
      const intel = deps.intel;
      if (intel && typeof intel.commit === "function") {
        const commitRes = await intel.commit(result, {
          ...opts,
          artifactId: artifact.id,
          type,
        });
        result.commit = commitRes;
        emit(bus, "import.committed", {
          artifactId: artifact.id,
          type,
          ok: !!commitRes?.ok,
          at: nowISO(),
        });
      }
    } catch (e) {
      result.commit = { ok: false, error: e?.message || String(e) };
      emit(bus, "import.committed", {
        artifactId: artifact.id,
        type,
        ok: false,
        at: nowISO(),
      });
    }
  }

  return result;
}

/* -----------------------------------------------------------------------------
 * Default export (router facade)
 * -------------------------------------------------------------------------- */

const ImportRouter = {
  detectImportType,
  routeImport,
  registerRoute,
  listRoutes,
};

export default ImportRouter;
