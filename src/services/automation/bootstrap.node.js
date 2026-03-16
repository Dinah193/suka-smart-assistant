// src/services/automation/bootstrap.node.js
// Node/SSR automation bootstrap (SAFE to use node:* + fs).
// Responsibilities
//  - Register automation generators ("agents") by kind
//  - Optionally load/warm templates from disk and watch for changes
//  - Provide HTTP handlers for /api/automation/generate and /api/calendar/sync
//  - Keep logic server-side (no node:* leaks to client bundles)

/**
 * IMPORTANT (Vite-safe)
 * ---------------------
 * This file is intended for Node/SSR only, but it can still get *accidentally*
 * imported by client code. To prevent Vite/Rollup from trying to bundle Node
 * built-ins or resolve optional deps (like chokidar), we:
 *   - Avoid ALL static imports of node:* or chokidar
 *   - Dynamically import node:* only when we are actually running on the server
 *   - Use /* @vite-ignore *\/ on dynamic imports so Rollup doesn't try to resolve them
 *   - Provide safe no-op stubs when evaluated in the browser
 *   - Hide optional module specifiers behind computed strings (prevents static analysis)
 */

const IS_BROWSER = typeof window !== "undefined";

/* --------------------------------- DEV flag -------------------------------- */
const DEV = (() => {
  try {
    // process may not exist in browser bundles
    // eslint-disable-next-line no-undef
    return typeof process !== "undefined"
      ? process.env.NODE_ENV !== "production"
      : false;
  } catch {
    return false;
  }
})();

/* ----------------------------- Hard Node guard ----------------------------- */
/**
 * Stronger than IS_BROWSER:
 * - Some bundlers still evaluate modules in "build-time" contexts
 * - This ensures we only ever attempt Node-only behavior when actually running on Node
 */
const IS_NODE_RUNTIME = (() => {
  try {
    // eslint-disable-next-line no-undef
    return (
      typeof process !== "undefined" &&
      !!process.versions &&
      !!process.versions.node
    );
  } catch {
    return false;
  }
})();

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
    log.warn("registerAgent ignored: invalid arguments", {
      kind,
      fnType: typeof fn,
    });
    return;
  }
  registry.set(kind, fn);
  log.info(`registered agent: ${kind}`);
}

/** Resolve an agent function by kind */
function getAgent(kind) {
  return registry.get(kind);
}

/* ------------------------------ Node deps loader --------------------------- */
let _node = null;

async function loadNodeDeps() {
  if (_node) return _node;

  if (IS_BROWSER || !IS_NODE_RUNTIME) {
    throw new Error(
      "[automation:node] Node deps requested outside Node runtime. This module is server-only."
    );
  }

  // Dynamic imports so Vite/Rollup doesn't attempt to resolve them for the client bundle.
  // NOTE: `/* @vite-ignore */` prevents Rollup from trying to resolve the specifier at build time.
  const pathMod = await import(/* @vite-ignore */ "node:path");
  const urlMod = await import(/* @vite-ignore */ "node:url");
  const fsMod = await import(/* @vite-ignore */ "node:fs/promises");
  const eventsMod = await import(/* @vite-ignore */ "node:events");

  const fileURLToPath = urlMod.fileURLToPath;
  const pathToFileURL = urlMod.pathToFileURL;

  // Compute dirname/filename lazily and safely
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = pathMod.dirname(__filename);

  _node = {
    // path
    pathResolve: pathMod.resolve,
    dirname: pathMod.dirname,
    pathJoin: pathMod.join,
    // url
    fileURLToPath,
    pathToFileURL,
    // fs
    fs: fsMod.default || fsMod,
    // events
    EventEmitter: eventsMod.EventEmitter,
    // file locations
    __filename,
    __dirname,
  };

  return _node;
}

/* ------------------------------ Browser-safe bus --------------------------- */
/**
 * In Node we use EventEmitter. In the browser (if this file is accidentally imported),
 * we provide a tiny emitter so code that references automationBus won't explode.
 */
function createTinyEmitter() {
  const listeners = new Map();
  return {
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
      return this;
    },
    off(evt, fn) {
      listeners.get(evt)?.delete(fn);
      return this;
    },
    emit(evt, payload) {
      const set = listeners.get(evt);
      if (!set) return false;
      for (const fn of set) {
        try {
          fn(payload);
        } catch {}
      }
      return true;
    },
  };
}

export const automationBus = IS_BROWSER ? createTinyEmitter() : null;

/* ------------------------------ Draft Builders ---------------------------- */
function balanceStations(recipes) {
  const stations = ["prep", "range", "oven", "grill"];
  let i = 0;
  return recipes.map((r) => ({
    ...r,
    station: r.station || stations[i++ % stations.length],
  }));
}

function buildCookingDraft({ recipes = [], prefs = {}, inventory = {} }) {
  const withStations = balanceStations(Array.isArray(recipes) ? recipes : []);
  const items = withStations.map((r) => {
    const allergens = r.allergens || [];
    const dietary = r.dietary || [];
    const yieldText = r.yield || "makes 1 batch";

    const timers = [];
    if (r.hotFill) {
      timers.push({
        kind: "hot-fill",
        minutes: 10,
        note: "Hold above 74°C/165°F for hot fill",
      });
      timers.push({
        kind: "chill",
        minutes: 45,
        note: "Rapid chill to ≤4°C/40°F",
      });
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
      ? {
          freezer: {
            requiredQuarts: totalQuarts,
            remaining: freezerCapacity - totalQuarts,
          },
        }
      : {};

  return {
    type: "cooking-session",
    title:
      prefs?.sessionTitle || `Cooking Session (${withStations.length} recipes)`,
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
    timeBlock: constraints?.sabbath
      ? "Auto-schedule outside Sabbath window"
      : "Anytime",
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
  registerAgent("recipes-to-cooking-session", async (input) =>
    buildCookingDraft(input)
  );
  registerAgent("signals-to-cleaning-session", async (input) =>
    buildCleaningDraft(input)
  );
  registerAgent("profile-to-meal-plan", async (input) =>
    buildMealPlanDraftFromProfile(input)
  );
}

/* ------------------------------ Event Bridge ------------------------------ */
async function ensureNodeAutomationBus() {
  if (IS_BROWSER || !IS_NODE_RUNTIME) return automationBus;
  const { EventEmitter } = await loadNodeDeps();
  if (
    automationBus &&
    typeof automationBus.emit === "function" &&
    typeof automationBus.on === "function"
  ) {
    return automationBus;
  }
  // In Node, swap the exported binding value via mutation is not possible for ESM exports,
  // so we just return a per-call instance if needed. But we *prefer* the exported one.
  // To keep behavior consistent, we attach a singleton on globalThis.
  if (!globalThis.__sukaAutomationBus)
    globalThis.__sukaAutomationBus = new EventEmitter();
  return globalThis.__sukaAutomationBus;
}

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
      if (IS_BROWSER || !IS_NODE_RUNTIME)
        return res.status(400).json({ error: "server-only" });
      const { kind, input } = req.body || {};
      if (!kind) return res.status(400).json({ error: 'Missing "kind"' });
      const draft = await generate(kind, input || {}, { req });
      return res.json(draft);
    } catch (e) {
      log.error("generate error:", e);
      return res
        .status(500)
        .json({ error: "generation-failed", message: e.message });
    }
  };
}

export function calendarSyncHandler() {
  return async function (req, res) {
    try {
      if (IS_BROWSER || !IS_NODE_RUNTIME)
        return res.status(400).json({ error: "server-only" });

      const { pathResolve, pathJoin, dirname, fs, __dirname } =
        await loadNodeDeps();

      const { draft } = req.body || {};
      if (!draft?.type)
        return res.status(400).json({ error: "Invalid draft payload" });

      const base = pathResolve(
        process.env.SUKA_DATA_DIR || pathResolve(__dirname, "../../../data")
      );
      const file = pathJoin(base, "calendar-sync-log.json");

      async function ensureDir(dir) {
        try {
          await fs.mkdir(dir, { recursive: true });
        } catch {}
      }
      async function readJson(p, fallback = null) {
        try {
          const raw = await fs.readFile(p, "utf8");
          return JSON.parse(raw);
        } catch {
          return fallback;
        }
      }
      async function writeJson(p, data) {
        await ensureDir(dirname(p));
        await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
      }

      // Defensive stringify (no crash on circular)
      const safe = (obj) => {
        try {
          return JSON.parse(JSON.stringify(obj));
        } catch {
          return { note: "non-serializable payload" };
        }
      };

      const logData = (await readJson(file, [])) || [];
      logData.push({
        at: new Date().toISOString(),
        draft: safe({
          type: draft.type,
          title: draft.title,
          payload: draft.payload,
        }),
      });
      await writeJson(file, logData);

      const bus = await ensureNodeAutomationBus();
      bus.emit("calendar/synced", { draft });

      return res.json({ ok: true });
    } catch (e) {
      log.error("calendar sync failed:", e);
      return res
        .status(500)
        .json({ error: "calendar-sync-failed", message: e.message });
    }
  };
}

/* --------------------------- Template Loader (JS/JSON) -------------------- */
/**
 * Load agents/templates from disk.
 * Supported:
 *  - .js/.mjs modules exporting default or named `generate(input, ctx)`
 *  - .json templates { kind, type?, title?, defaults } -> wrapped generator
 */
async function loadTemplatesFromDir(dir) {
  if (IS_BROWSER || !IS_NODE_RUNTIME) return;

  const { pathJoin, pathToFileURL, fs } = await loadNodeDeps();

  async function readJson(file, fallback = null) {
    try {
      const raw = await fs.readFile(file, "utf8");
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  try {
    const files = await fs.readdir(dir);
    for (const name of files) {
      const full = pathJoin(dir, name);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        await loadTemplatesFromDir(full);
        continue;
      }
      if (
        name.endsWith(".js") ||
        name.endsWith(".mjs") ||
        name.endsWith(".cjs")
      ) {
        try {
          // bust import cache in dev
          const url = new URL(
            `${pathToFileURL(full).href}${DEV ? `?t=${Date.now()}` : ""}`
          );
          const mod = await import(url.href);
          const fn = mod?.default || mod?.generate;
          const kind = mod?.kind || name.replace(/\.(mjs|js|cjs)$/i, "");
          if (typeof fn === "function" && kind) {
            registerAgent(kind, fn);
          } else {
            log.warn("template JS missing export function or kind:", name);
          }
        } catch (e) {
          log.warn("template JS load failed:", name, e?.message || e);
        }
      } else if (name.endsWith(".json")) {
        try {
          const tpl = await readJson(full, null);
          if (tpl?.kind) {
            registerAgent(tpl.kind, async (input) => ({
              type: tpl.type || tpl.kind,
              title: tpl.title || `Draft from ${tpl.kind}`,
              payload: { ...(tpl.defaults || {}), ...(input || {}) },
              meta: {
                source: "template-json",
                file: name,
                createdBy: "automation.bootstrap.node",
              },
            }));
          } else {
            log.warn("template JSON missing 'kind':", name);
          }
        } catch (e) {
          log.warn("template JSON load failed:", name, e?.message || e);
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
 * We lazy-import chokidar (ONLY on Node + dev) to avoid any dependency / bundling issues.
 */
async function startWatchingTemplates(dir) {
  if (IS_BROWSER || !IS_NODE_RUNTIME) return;
  if (!DEV) return;

  try {
    // CRITICAL:
    // Rollup can still try to resolve dynamic import specifiers if they're static strings.
    // Hide the module name behind a computed string to prevent static analysis.
    const spec = "choki" + "dar";

    // eslint-disable-next-line no-new-func
    const dynImport = new Function("s", "return import(s)");
    const chokidarMod = await dynImport(spec);

    const chokidar = chokidarMod?.default || chokidarMod;
    if (!chokidar?.watch) {
      log.warn("chokidar loaded but has no .watch; template watch disabled");
      return;
    }

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
  try {
    await watcher?.close?.();
  } catch {}
  watcher = null;
}

/* ------------------------------ Bootstrap API ----------------------------- */
let started = false;

/**
 * Start the Node automation layer.
 * @param {Object} opts
 * @param {string} [opts.baseDir]        - Project base dir (default: CWD or repo root).
 * @param {boolean} [opts.watchTemplates]- Watch template dir in dev.
 * @param {any} [opts.app]               - Express app instance (optional).
 * @param {string} [opts.templatesDir]   - Override templates dir path.
 */
export async function startAutomationBootstrap(opts = {}) {
  // If imported in the browser, be a safe no-op (do not throw).
  if (IS_BROWSER || !IS_NODE_RUNTIME) {
    log.warn(
      "[automation:node] startAutomationBootstrap called outside Node runtime; no-op."
    );
    return { ok: false, skipped: true, reason: "non-node-noop" };
  }

  if (started) return { ok: true, skipped: true };
  started = true;

  const { pathResolve, pathJoin, __dirname } = await loadNodeDeps();

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
    log.info(
      "HTTP routes mounted: POST /api/automation/generate, POST /api/calendar/sync"
    );
  }

  log.info("automation bootstrap (node) started", {
    templatesDir,
    registeredAgents: Array.from(registry.keys()),
  });

  // Clean shutdown in dev
  const stop = async () => {
    try {
      await stopWatchingTemplates();
    } catch {}
  };
  try {
    // eslint-disable-next-line no-undef
    process.once?.("SIGINT", stop);
    // eslint-disable-next-line no-undef
    process.once?.("SIGTERM", stop);
  } catch {}

  return {
    ok: true,
    baseDir,
    templatesDir,
    agents: Array.from(registry.keys()),
  };
}

export async function stopAutomationBootstrap() {
  if (IS_BROWSER || !IS_NODE_RUNTIME) {
    log.warn(
      "[automation:node] stopAutomationBootstrap called outside Node runtime; no-op."
    );
    return { ok: false, skipped: true, reason: "non-node-noop" };
  }
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
