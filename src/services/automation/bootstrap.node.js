// src/services/automation/bootstrap.node.js
// Node/SSR automation bootstrap (SAFE to use node:* + fs).
// Responsibilities
//  - Register automation generators ("agents") by kind
//  - Optionally load/warm templates from disk and watch for changes
//  - Provide HTTP handlers for /api/automation/generate and /api/calendar/sync
//  - Keep logic server-side (no node:* leaks to client bundles)

import { resolve as pathResolve, dirname, join as pathJoin } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEV = process.env.NODE_ENV !== "production";

// Hard guard: if ever evaluated in a browser bundle, fail fast.
// (Prevents odd "node:path has been externalized" errors if mis-imported.)
if (typeof window !== "undefined") {
  throw new Error("[automation:node] This module is server-only.");
}

let started = false;

/* --------------------------------- Logger --------------------------------- */
const log = {
  info: (...a) => (DEV ? console.log("[automation:node]", ...a) : void 0),
  warn: (...a) => console.warn("[automation:node]", ...a),
  error: (...a) => console.error("[automation:node]", ...a),
};

/* ----------------------------- Agent Registry ----------------------------- */
/**
 * Registry of generator functions keyed by a `kind` string.
 * Signature: async (input, ctx) => DraftObject
 * DraftObject shape mirrors client DraftStore.create(...) expectation:
 *  { type, title, payload, meta }
 */
const registry = new Map();

/** Register or replace an agent */
export function registerAgent(kind, fn) {
  if (!kind || typeof fn !== "function") {
    log.warn("registerAgent ignored: invalid arguments", { kind, fnType: typeof fn });
    return;
  }
  registry.set(kind, fn);
  log.info(`registered agent: ${kind}`);
}

/** Resolve an agent function by kind */
function getAgent(kind) {
  return registry.get(kind);
}

/* ----------------------------- File Utilities ----------------------------- */
async function ensureDir(dir) {
  try { await fs.mkdir(dir, { recursive: true }); } catch {}
}

async function readJson(file, fallback = null) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await ensureDir(dirname(file));
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

/* ------------------------------ Draft Builders ---------------------------- */
function balanceStations(recipes) {
  const stations = ["prep", "range", "oven", "grill"];
  let i = 0;
  return recipes.map((r) => ({ ...r, station: r.station || stations[(i++) % stations.length] }));
}

function buildCookingDraft({ recipes = [], prefs = {}, inventory = {} }) {
  const withStations = balanceStations(Array.isArray(recipes) ? recipes : []);
  const items = withStations.map((r) => {
    const allergens = r.allergens || [];
    const dietary = r.dietary || [];
    const yieldText = r.yield || "makes 1 batch";

    const timers = [];
    if (r.hotFill) {
      timers.push({ kind: "hot-fill", minutes: 10, note: "Hold above 74°C/165°F for hot fill" });
      timers.push({ kind: "chill", minutes: 45, note: "Rapid chill to ≤4°C/40°F" });
    }

    const label = {
      prefix: prefs.labelPrefix || "SV",
      dateFormat: prefs.dateFormat || "YYYY-MM-DD",
      ingredientsLine: (r.ingredients || []).map((i) => i.name).join(", "),
    };

    return {
      recipeId: r.id,
      name: r.name,
      station: r.station,
      allergens,
      dietary,
      yield: yieldText,
      timers,
      label,
    };
  });

  const totalQuarts = (Array.isArray(recipes) ? recipes : []).reduce(
    (sum, r) => sum + (r.estimatedQuarts || 0),
    0
  );
  const freezerCapacity = inventory.freezerQuarts ?? null;
  const storageHints =
    freezerCapacity != null
      ? { freezer: { requiredQuarts: totalQuarts, remaining: freezerCapacity - totalQuarts } }
      : {};

  return {
    type: "cooking-session",
    title: prefs?.sessionTitle || `Cooking Session (${withStations.length} recipes)`,
    payload: {
      items,
      storageHints,
      context: {
        weeklyFlavorRhythm: prefs?.weeklyFlavorRhythm || null,
        householdId: prefs?.householdId || null,
      },
    },
    meta: { source: "server-agent", createdBy: "automation.bootstrap.node" },
  };
}

function buildCleaningDraft({ zones = [], constraints = {} }) {
  const list = Array.isArray(zones) ? zones : [];
  const items = list.map((z) => ({
    zoneId: z.id,
    name: z.name,
    timeBlock: constraints?.sabbath ? "Auto-schedule outside Sabbath window" : "Anytime",
    supplies: z.supplyHints || [],
  }));
  return {
    type: "cleaning-session",
    title: `Cleaning Session (${list.length} zones)`,
    payload: { items, constraints },
    meta: { source: "server-agent", createdBy: "automation.bootstrap.node" },
  };
}

function buildMealPlanDraftFromProfile({ profile = {} }) {
  return {
    type: "meal-plan",
    title: "New Meal Plan (from profile)",
    payload: {
      weeklyFlavorRhythm: profile?.weeklyFlavorRhythm || null,
      householdId: profile?.householdId || null,
      notes: "Auto-generated from household profile (server).",
    },
    meta: { source: "server-agent", createdBy: "automation.bootstrap.node" },
  };
}

/* ------------------------------ Default Agents ---------------------------- */
function registerDefaultAgents() {
  registerAgent("recipes-to-cooking-session", async (input) => buildCookingDraft(input));
  registerAgent("signals-to-cleaning-session", async (input) => buildCleaningDraft(input));
  registerAgent("profile-to-meal-plan", async (input) => buildMealPlanDraftFromProfile(input));
}

/* --------------------------- Template Loader (JS/JSON) -------------------- */
/**
 * Load agents/templates from disk.
 * Supported:
 *  - .js/.mjs modules exporting default or named `generate(input, ctx)`
 *  - .json templates { kind, type?, title?, defaults } -> wrapped generator
 */
async function loadTemplatesFromDir(dir) {
  try {
    const files = await fs.readdir(dir);
    for (const name of files) {
      const full = pathJoin(dir, name);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        await loadTemplatesFromDir(full);
        continue;
      }
      if (name.endsWith(".js") || name.endsWith(".mjs") || name.endsWith(".cjs")) {
        try {
          // bust import cache in dev
          const url = new URL(`${pathToFileURL(full).href}${DEV ? `?t=${Date.now()}` : ""}`);
          const mod = await import(url.href);
          const fn = mod?.default || mod?.generate;
          const kind = mod?.kind || name.replace(/\.(mjs|js|cjs)$/i, "");
          if (typeof fn === "function" && kind) {
            registerAgent(kind, fn);
          } else {
            log.warn("template JS missing export function or kind:", name);
          }
        } catch (e) {
          log.warn("template JS load failed:", name, e.message);
        }
      } else if (name.endsWith(".json")) {
        try {
          const tpl = await readJson(full, null);
          if (tpl?.kind) {
            registerAgent(tpl.kind, async (input) => ({
              type: tpl.type || tpl.kind,
              title: tpl.title || `Draft from ${tpl.kind}`,
              payload: { ...(tpl.defaults || {}), ...(input || {}) },
              meta: { source: "template-json", file: name, createdBy: "automation.bootstrap.node" },
            }));
          } else {
            log.warn("template JSON missing 'kind':", name);
          }
        } catch (e) {
          log.warn("template JSON load failed:", name, e.message);
        }
      }
    }
  } catch (e) {
    if (DEV) log.info("no templates dir yet:", dir);
  }
}

/* --------------------------- Optional File Watching ----------------------- */
let watcher = null;
/**
 * If you want live-reloading of templates during dev, pass watchTemplates: true.
 * We lazy-import chokidar to avoid an extra dep for production.
 */
async function startWatchingTemplates(dir) {
  if (!DEV) return;
  try {
    const chokidar = (await import("chokidar")).default;
    watcher = chokidar.watch(dir, { ignoreInitial: true, depth: 4 });
    watcher.on("all", async (event, file) => {
      log.info("templates changed:", event, file);
      await loadTemplatesFromDir(dir);
    });
  } catch {
    log.warn("chokidar not installed; template watch disabled");
  }
}

async function stopWatchingTemplates() {
  try { await watcher?.close(); } catch {}
  watcher = null;
}

/* ------------------------------ Event Bridge ------------------------------ */
export const automationBus = new EventEmitter();

async function generate(kind, input, ctx) {
  const agent = getAgent(kind);
  if (!agent) throw new Error(`No agent registered for kind "${kind}"`);
  return agent(input, ctx);
}

/* ------------------------------- HTTP Handlers ---------------------------- */
/** Express-style handlers for optional server endpoints */
export function automationGenerateHandler() {
  return async function (req, res) {
    try {
      const { kind, input } = req.body || {};
      if (!kind) return res.status(400).json({ error: 'Missing "kind"' });
      const draft = await generate(kind, input || {}, { req });
      return res.json(draft);
    } catch (e) {
      log.error("generate error:", e);
      return res.status(500).json({ error: "generation-failed", message: e.message });
    }
  };
}

export function calendarSyncHandler() {
  return async function (req, res) {
    try {
      const { draft } = req.body || {};
      if (!draft?.type) return res.status(400).json({ error: "Invalid draft payload" });

      const base = pathResolve(
        process.env.SUKA_DATA_DIR || pathResolve(__dirname, "../../../data")
      );
      const file = pathJoin(base, "calendar-sync-log.json");

      // Defensive stringify (no crash on circular)
      const safe = (obj) => {
        try { return JSON.parse(JSON.stringify(obj)); } catch { return { note: "non-serializable payload" }; }
      };

      const logData = (await readJson(file, [])) || [];
      logData.push({ at: new Date().toISOString(), draft: safe({ type: draft.type, title: draft.title, payload: draft.payload }) });
      await writeJson(file, logData);

      automationBus.emit("calendar/synced", { draft });

      return res.json({ ok: true });
    } catch (e) {
      log.error("calendar sync failed:", e);
      return res.status(500).json({ error: "calendar-sync-failed", message: e.message });
    }
  };
}

/* ------------------------------ Bootstrap API ----------------------------- */
/**
 * Start the Node automation layer.
 * @param {Object} opts
 * @param {string} [opts.baseDir]        - Project base dir (default: CWD or repo root).
 * @param {boolean} [opts.watchTemplates]- Watch template dir in dev.
 * @param {any} [opts.app]               - Express app instance (optional).
 * @param {string} [opts.templatesDir]   - Override templates dir path.
 */
export async function startAutomationBootstrap(opts = {}) {
  if (started) return { ok: true, skipped: true };
  started = true;

  // Resolve baseDir robustly
  const baseDir =
    opts.baseDir ??
    process.env.SUKA_BASE_DIR ??
    // Try CWD; fallback to repo root relative to this file
    (process.cwd?.() || pathResolve(__dirname, "../../.."));

  const templatesDir =
    opts.templatesDir ??
    process.env.SUKA_TEMPLATES_DIR ??
    pathJoin(baseDir, "src", "automation", "templates");

  // 1) Register built-in agents
  registerDefaultAgents();

  // 2) Load user templates (server-extensible agents)
  await loadTemplatesFromDir(templatesDir);

  // 3) Optional watch in dev
  if (opts.watchTemplates) {
    await startWatchingTemplates(templatesDir);
  }

  // 4) Wire HTTP routes if an Express app was passed
  const app = opts.app;
  if (app?.post) {
    app.post("/api/automation/generate", automationGenerateHandler());
    app.post("/api/calendar/sync", calendarSyncHandler());
    log.info("HTTP routes mounted: POST /api/automation/generate, POST /api/calendar/sync");
  }

  log.info("automation bootstrap (node) started", {
    templatesDir,
    registeredAgents: Array.from(registry.keys()),
  });

  // Clean shutdown in dev
  const stop = async () => { try { await stopWatchingTemplates(); } catch {} };
  process.once?.("SIGINT", stop);
  process.once?.("SIGTERM", stop);

  return { ok: true, baseDir, templatesDir, agents: Array.from(registry.keys()) };
}

export async function stopAutomationBootstrap() {
  await stopWatchingTemplates();
  started = false;
  log.info("automation bootstrap (node) stopped");
  return { ok: true };
}

/* ------------------------------ Default export ---------------------------- */
const api = {
  startAutomationBootstrap,
  stopAutomationBootstrap,
  registerAgent,
  automationBus,
};
export default api;
