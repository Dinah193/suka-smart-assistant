/**
 * @file C:\Users\larho\suka-smart-assistant\src\server\routes\nutrition.js
 *
 * Backend nutrition routes (central API).
 *
 * PIPELINE FIT (imports → intelligence → automation → (optional) hub export)
 * - Frontend NutritionResolver consults local Dexie first, then calls these routes.
 * - These routes read the central nutrition records and, on miss, can trigger a scrape.
 * - We now explicitly:
 *    1) Call getNutritionFromDB()
 *    2) If not found, call scrapeNutritionIfMissing()
 *    3) Return the final nutrition JSON to the frontend (if available), otherwise a typed 404.
 *
 * EVENTS (automation.event envelopes):
 *   nutrition.api.lookup.hit
 *   nutrition.api.lookup.miss
 *   nutrition.api.lookup.error
 *   nutrition.api.getById.hit
 *   nutrition.scrape.queued
 *   nutrition.scrape.skipped
 *   nutrition.scrape.completed   (when scrape function reports a synchronous result)
 */

import express from "express";
import crypto from "crypto";
import eventBus from "src/services/events/eventBus.js";

const SOURCE = "server.routes.nutrition";
const router = express.Router();

// ───────────────────────────────────────────────────────────────────────────────
// Soft-import services (keep server modular / swappable):
//
// Expected shapes:
//
// getNutritionFromDB.js
//   export default async function getNutritionFromDB({ id?, name? }) -> { ok:boolean, data?:object|null }
//
// scrapeNutritionIfMissing.js
//   export default async function scrapeNutritionIfMissing({ normalizedName, hint? })
//     -> { queued?:boolean, jobId?:string, ok?:boolean, data?:object|null }
//
// If your project exposes these as a single module, we try multiple paths below.

const getNutritionFromDB =
  (await softImport("src/server/services/nutrition/getNutritionFromDB.js")) ||
  (await softImport("src/server/services/NutritionDB.js"))?.getByNameOrId || // legacy adapter (optional)
  null;

const scrapeNutritionIfMissing =
  (await softImport(
    "src/server/services/nutrition/scrapeNutritionIfMissing.js"
  )) ||
  (await softImport("src/server/services/ScraperOrchestrator.js"))
    ?.enqueueNutritionJob ||
  null;

// ───────────────────────────────────────────────────────────────────────────────
// GET /nutrition/lookup?name=<string>[&scrape=1|true][&wait=short]
//
// Flow:
//  1) normalize name
//  2) try getNutritionFromDB({ name: normalizedName })
//  3) if not found and scrape flag set → call scrapeNutritionIfMissing()
//     - if scrape returns data synchronously, return it
//     - else 404 with reason and optional jobId
router.get(
  "/nutrition/lookup",
  asyncHandler(async (req, res) => {
    const raw = (req.query.name || "").toString();
    const triggerScrape =
      req.query.scrape === "1" || req.query.scrape === "true";
    const waitMode = (req.query.wait || "").toString(); // e.g., "short" to re-check once after enqueue

    if (!raw.trim()) {
      return json(res, 400, {
        ok: false,
        error: 'Missing query parameter "name"',
      });
    }

    const normalizedName = normalizeName(raw);

    // 1) DB lookup
    const dbResult = await safeGetFromDB({ name: normalizedName });
    if (dbResult?.ok && dbResult.data) {
      emit("nutrition.api.lookup.hit", { normalizedName });
      return sendOk(res, dbResult.data);
    }

    emit("nutrition.api.lookup.miss", { normalizedName });

    // 2) Optional scrape-on-miss
    if (triggerScrape && scrapeNutritionIfMissing) {
      const scrapeResult = await safeScrape({ normalizedName, hint: raw });

      // If scraper returned a synchronous payload, return it now.
      if (scrapeResult?.ok && scrapeResult.data) {
        emit("nutrition.scrape.completed", { normalizedName });
        // Persisting to DB should be the scraper’s job; we just return the data.
        return sendOk(res, scrapeResult.data);
      }

      // If asked to wait a moment and re-check DB once (best-effort)
      if (waitMode === "short") {
        await delay(150);
        const recheck = await safeGetFromDB({ name: normalizedName });
        if (recheck?.ok && recheck.data) {
          emit("nutrition.api.lookup.hit", {
            normalizedName,
            note: "post-scrape-recheck",
          });
          return sendOk(res, recheck.data);
        }
      }

      // Otherwise, report 404 + queued info
      return json(res, 404, {
        ok: false,
        error: "Not found; scrape queued",
        reason: "SCRAPE_QUEUED",
        normalizedName,
        ...(scrapeResult?.jobId ? { jobId: scrapeResult.jobId } : {}),
      });
    }

    // 3) Not found and no scrape requested
    return json(res, 404, {
      ok: false,
      error: "Not found",
      reason: "NOT_FOUND",
      normalizedName,
    });
  })
);

// ───────────────────────────────────────────────────────────────────────────────
// GET /nutrition/:id
//
// Flow:
//  1) DB lookup by id   → return JSON if found
//  2) otherwise 404
router.get(
  "/nutrition/:id",
  asyncHandler(async (req, res) => {
    const id = (req.params.id || "").toString().trim();
    if (!id) return json(res, 400, { ok: false, error: "Missing id" });

    const dbResult = await safeGetFromDB({ id });
    if (dbResult?.ok && dbResult.data) {
      emit("nutrition.api.getById.hit", { id });
      return sendOk(res, dbResult.data);
    }

    return json(res, 404, {
      ok: false,
      error: "Not found",
      reason: "NOT_FOUND",
    });
  })
);

// ───────────────────────────────────────────────────────────────────────────────
// GET /nutrition?name=<string> OR /nutrition?id=<string>
//   - compatibility shim that routes to the handlers above
router.get(
  "/nutrition",
  asyncHandler(async (req, res, next) => {
    const id = (req.query.id || "").toString().trim();
    const name = (req.query.name || "").toString().trim();

    if (id) {
      req.params.id = id;
      return router.handle(req, res, next); // delegates to /nutrition/:id
    }
    if (name) {
      req.query.name = name;
      // default: do not enqueue scrape automatically here
      req.query.scrape = req.query.scrape ?? "0";
      return router.handle(req, res, next); // delegates to /nutrition/lookup
    }

    return json(res, 400, {
      ok: false,
      error: "Provide either ?id= or ?name=",
    });
  })
);

// ───────────────────────────────────────────────────────────────────────────────
// POST /nutrition/scrape { name: "<raw or normalized>" }
// Force enqueue a scrape job. If the scraper returns data synchronously, return it.
router.post(
  "/nutrition/scrape",
  express.json(),
  asyncHandler(async (req, res) => {
    const raw = (req.body?.name || "").toString();
    if (!raw.trim()) {
      return json(res, 400, { ok: false, error: 'Missing body field "name"' });
    }
    const normalizedName = normalizeName(raw);

    const scrapeResult = await safeScrape({
      normalizedName,
      hint: raw,
      force: true,
    });

    if (scrapeResult?.ok && scrapeResult.data) {
      emit("nutrition.scrape.completed", { normalizedName });
      return json(res, 201, { ok: true, data: scrapeResult.data });
    }

    return json(res, 202, {
      ok: true,
      queued: !!scrapeResult?.queued,
      skipped: !scrapeResult?.queued && !scrapeResult?.ok,
      normalizedName,
      ...(scrapeResult?.jobId ? { jobId: scrapeResult.jobId } : {}),
    });
  })
);

// ───────────────────────────────────────────────────────────────────────────────
// Helpers

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/s$/, ""); // light plural→singular heuristic
}

async function safeGetFromDB({ id, name }) {
  try {
    if (!getNutritionFromDB) {
      emit("nutrition.api.lookup.error", {
        step: "getNutritionFromDB",
        message: "service unavailable",
      });
      return { ok: false, data: null };
    }
    const res = await getNutritionFromDB({ id, name });
    // expected shape { ok, data|null }
    return res || { ok: false, data: null };
  } catch (err) {
    emit("nutrition.api.lookup.error", {
      step: "getNutritionFromDB",
      message: err?.message || "db error",
    });
    return { ok: false, data: null };
  }
}

async function safeScrape({ normalizedName, hint, force = false }) {
  try {
    if (!scrapeNutritionIfMissing) {
      emit("nutrition.scrape.skipped", {
        normalizedName,
        reason: "SCRAPER_UNAVAILABLE",
      });
      return { ok: false };
    }

    // Two possible scraper signatures supported:
    //  A) scrapeNutritionIfMissing({ normalizedName, hint, force }) -> { ok, data? } or { queued, jobId? }
    //  B) enqueueNutritionJob({ normalizedName, hint }) -> { queued, jobId }
    const out = await scrapeNutritionIfMissing({ normalizedName, hint, force });

    if (out?.queued) {
      emit("nutrition.scrape.queued", { normalizedName, jobId: out.jobId });
      return { queued: true, jobId: out.jobId };
    }
    if (out?.ok && out.data) {
      // Synchronous result from a fast scraper path
      emit("nutrition.scrape.completed", { normalizedName });
      return { ok: true, data: out.data };
    }

    // If scraper returned nothing actionable
    emit("nutrition.scrape.skipped", { normalizedName, reason: "NO_ACTION" });
    return { ok: false };
  } catch (err) {
    emit("nutrition.api.lookup.error", {
      step: "scrape",
      message: err?.message || "scrape error",
      normalizedName,
    });
    return { ok: false };
  }
}

function sendOk(res, data) {
  const etag = hash(JSON.stringify(data));
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "public, max-age=86400"); // 1 day
  return json(res, 200, { ok: true, data });
}

function json(res, status, obj) {
  res.status(status).type("application/json").send(JSON.stringify(obj));
  return res;
}

function hash(str) {
  return crypto.createHash("sha1").update(str).digest("hex");
}

function emit(type, data) {
  try {
    eventBus.emit("automation.event", {
      type,
      ts: new Date().toISOString(),
      source: SOURCE,
      data,
    });
  } catch {
    // never throw from telemetry
  }
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function softImport(path) {
  try {
    const mod = await import(/* @vite-ignore */ path);
    return mod?.default || mod;
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ───────────────────────────────────────────────────────────────────────────────
export default router;
