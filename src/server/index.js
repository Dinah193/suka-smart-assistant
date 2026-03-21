// C:\Users\larho\suka-smart-assistant\src\server\index.js
/**
 * Suka Smart Assistant — Server Bootstrap (Dynamic, CJS+ESM friendly)
 * -------------------------------------------------------------------
 * - Loads env (dotenv if available)
 * - Initializes Express with sane defaults & safe security middlewares
 * - Resiliently loads CJS or ESM modules (services & routes)
 * - Dynamically mounts route modules (function, router, or default export)
 * - Attaches Socket.IO if available
 * - Health/version/time/config endpoints
 * - Graceful shutdown & basic circuit breakers
 */

const http = require("http");
const path = require("path");
const fs = require("fs");
const express = require("express");
const { v4: uuidv4 } = require("uuid");
const dbConnection = require("./services/dbConnection.js");
const { validateStartupEnv } = require("./services/envValidation.js");
const catalogSyncService = require("./services/catalogSyncService.js");
const { redactObject, redactText } = require("./services/loggingSanitizer.js");

// ---- Optional modules (loaded only if installed) ----
function opt(name) {
  try { return require(name); } catch { return null; }
}
const dotenv = opt("dotenv");
const morgan = opt("morgan");
const helmet = opt("helmet");
const cors = opt("cors");
const compression = opt("compression");
const cookieParser = opt("cookie-parser");
const rateLimit = opt("express-rate-limit");
const etag = opt("etag");

// ---- Load .env early (if available) ----
if (dotenv) dotenv.config();

// ---- Config ----
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "0.0.0.0";
const NODE_ENV = process.env.NODE_ENV || "development";
const TRUST_PROXY = process.env.TRUST_PROXY || "loopback";
const JSON_LIMIT = process.env.JSON_LIMIT || "2mb";
const URLENC_LIMIT = process.env.URLENC_LIMIT || "2mb";
const STATIC_DIR = path.resolve(__dirname, "../public");
const CORS_ORIGIN = (process.env.CORS_ORIGIN || (NODE_ENV === "production" ? "" : "*"))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SERVER_TZ = process.env.TZ || "America/New_York";

// ---- Startup environment validation ----
const envValidation = validateStartupEnv({ nodeEnv: NODE_ENV });
for (const msg of envValidation.warnings) {
  console.warn(`[env] ${msg}`);
}
if (envValidation.errors.length > 0) {
  for (const msg of envValidation.errors) {
    console.error(`[env] ${msg}`);
  }
  if (envValidation.strict || envValidation.isProd) {
    throw new Error("Startup environment validation failed");
  }
}

// ---- Helpers: hybrid module loader (CJS + ESM) ------------------------------
async function loadAny(modulePath) {
  // 1) Try CJS require
  try {
    const mod = require(modulePath);
    return mod && mod.__esModule ? (mod.default || mod) : mod;
  } catch (e1) {
    // 2) Try ESM dynamic import (relative path needs file://)
    try {
      const full = path.isAbsolute(modulePath) ? modulePath : path.resolve(__dirname, modulePath);
      const url = `file://${full.replace(/\\/g, "/")}`;
      const mod = await import(url);
      return mod && (mod.default || mod);
    } catch (e2) {
      // Surface original error for clarity
      throw e1;
    }
  }
}

// ---- Create Express app ----
const app = express();
app.set("env", NODE_ENV);
app.set("trust proxy", TRUST_PROXY);

// ---- Basic middlewares ----
app.use((req, res, next) => {
  req.id = req.headers["x-request-id"] || uuidv4();
  res.setHeader("x-request-id", req.id);
  req._start = Date.now();
  next();
});

if (helmet) app.use(helmet());
if (cors) {
  const corsCfg = {
    origin: (origin, cb) => {
      if (!origin || CORS_ORIGIN.includes("*") || CORS_ORIGIN.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  };
  app.use(cors(corsCfg));
}
if (compression) app.use(compression({ threshold: "1kb" }));
if (cookieParser) app.use(cookieParser());
if (etag) app.set("etag", "strong");

app.use(express.json({ limit: JSON_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: URLENC_LIMIT }));

if (morgan) {
  morgan.token("safe-headers", (req) => {
    const redacted = redactObject(req.headers || {});
    return JSON.stringify(redacted);
  });
  app.use(
    morgan(":method :url :status :response-time ms headers=:safe-headers", {
      skip: () => NODE_ENV === "test",
    })
  );
}

// ---- Optional: basic rate limit on all requests (must run before routes) ----
function createFallbackLimiter({ windowMs, max }) {
  const byIp = new Map();
  const maxHits = Number(max || 600);
  const periodMs = Number(windowMs || 60_000);

  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
    const state = byIp.get(ip) || { count: 0, resetAt: now + periodMs };
    if (now >= state.resetAt) {
      state.count = 0;
      state.resetAt = now + periodMs;
    }
    state.count += 1;
    byIp.set(ip, state);
    if (state.count > maxHits) {
      res.setHeader("Retry-After", Math.ceil((state.resetAt - now) / 1000));
      return res.status(429).json({ ok: false, error: "rate_limited" });
    }
    return next();
  };
}

if (rateLimit) {
  const limiter = rateLimit({
    windowMs: Number(process.env.RATE_WINDOW_MS || 60_000),
    max: Number(process.env.RATE_MAX || 600),
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(limiter);
} else {
  app.use(
    createFallbackLimiter({
      windowMs: Number(process.env.RATE_WINDOW_MS || 60_000),
      max: Number(process.env.RATE_MAX || 600),
    })
  );
}

// ---- Static files (optional) ----
if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR, { fallthrough: true, maxAge: NODE_ENV === "production" ? "1d" : 0 }));
}

// ---- Health & info ----
const startedAt = new Date();
let mongoStartupStatus = {
  checked: false,
  checkedAt: null,
  ok: null,
  required: String(process.env.MONGODB_REQUIRED || "false").toLowerCase() === "true",
  configured: false,
  connected: false,
  fallbackFileMode: true,
  error: null,
};
let postgresStartupStatus = {
  checked: false,
  checkedAt: null,
  ok: null,
  required: String(process.env.POSTGRES_REQUIRED || "false").toLowerCase() === "true",
  configured: false,
  connected: false,
  skipped: false,
  error: null,
};
let neo4jStartupStatus = {
  checked: false,
  checkedAt: null,
  ok: null,
  required: String(process.env.NEO4J_REQUIRED || "false").toLowerCase() === "true",
  skipped: false,
  error: null,
};
function pkgVersion() {
  try {
    const pkg = require("../../package.json");
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    env: NODE_ENV,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    startedAt: startedAt.toISOString(),
    now: new Date().toISOString(),
    requestId: req.id,
    db: dbConnection.getStatus(),
    mongo: mongoStartupStatus,
    postgres: postgresStartupStatus,
    neo4j: neo4jStartupStatus,
  });
});

app.get("/version", (req, res) => {
  res.json({ version: pkgVersion() });
});

app.get("/time", (req, res) => {
  res.json({ now: new Date().toISOString(), tz: SERVER_TZ });
});

// Minimal client boot/config (handy for UI hydration)
app.get("/config", async (req, res) => {
  const out = {
    version: pkgVersion(),
    env: NODE_ENV,
    tz: SERVER_TZ,
    features: {},
  };
  try {
    const prefs = await loadAny("./services/preferencesService.js").catch(() => null);
    if (prefs?.listFeatureFlags) {
      out.features = await prefs.listFeatureFlags({ userId: "global", homeId: "default" });
    }
  } catch {}
  res.json(out);
});

// ---- Services boot (safe/optional) ------------------------------------------
(async () => {
  try {
    const prefs = await loadAny("./services/preferencesService.js").catch(() => null);
    if (prefs?.init) await prefs.init();
  } catch (e) {
    console.warn("[boot] preferencesService init skipped:", e?.message || e);
  }

  try {
    const labels = await loadAny("./services/labelsService.js").catch(() => null);
    // new ESM version exports default object; tries both function names
    if (labels?.init) await labels.init().catch(() => {});
    if (labels?.ensureSampleTemplate) await labels.ensureSampleTemplate().catch(() => {});
  } catch (e) {
    console.warn("[boot] labelsService init skipped:", e?.message || e);
  }

  try {
    const n8n = await loadAny("./services/n8nClient.js").catch(() => null);
    if (n8n?.ping) n8n.ping().catch(() => {}); // non-blocking
  } catch (e) {
    console.warn("[boot] n8nClient ping skipped:", e?.message || e);
  }
})().catch(() => {});

// ---- Dynamic route mounting helper ------------------------------------------
async function safeMountRoute(fileRel, basePath) {
  const fileAbs = path.resolve(__dirname, fileRel);
  if (!fs.existsSync(fileAbs)) return false;

  let mod;
  try {
    mod = await loadAny(fileAbs);
  } catch (e) {
    console.warn(`[routes] failed to load ${fileRel}:`, e?.message || e);
    return false;
  }

  const mountPath = basePath || mod?.basePath || inferBasePathFromFilename(fileRel);

  // Export shapes supported:
  //  1) function (app) {}
  //  2) { router: express.Router }
  //  3) default export as function or router
  //  4) direct express.Router instance
  // 1) Named router export object: { router, basePath? }
  if (mod?.router && typeof mod.router?.use === "function") {
    app.use(mountPath, mod.router);
    console.log(`[routes] mounted router at ${mountPath} from ${fileRel}`);
    return true;
  }

  // 2) Default router export
  if (mod?.default && typeof mod.default?.use === "function") {
    app.use(mountPath, mod.default);
    console.log(`[routes] mounted default router at ${mountPath} from ${fileRel}`);
    return true;
  }

  // 3) Direct router instance export (express.Router() is also a function)
  if (mod && typeof mod.use === "function" && typeof mod.handle === "function") {
    app.use(mountPath, mod);
    console.log(`[routes] mounted router instance at ${mountPath} from ${fileRel}`);
    return true;
  }

  // 4) App-loader function export: function(app) {}
  if (typeof mod === "function") {
    if (typeof mod.use === "function" && typeof mod.handle === "function") {
      app.use(mountPath, mod);
      console.log(`[routes] mounted function-router at ${mountPath} from ${fileRel}`);
      return true;
    }
    mod(app);
    console.log(`[routes] mounted function from ${fileRel}`);
    return true;
  }

  // 5) Default app-loader function export
  if (mod?.default && typeof mod.default === "function") {
    mod.default(app);
    console.log(`[routes] mounted default(app) from ${fileRel}`);
    return true;
  }

  console.warn(`[routes] ${fileRel} exists but did not export a supported shape`);
  return false;
}

function inferBasePathFromFilename(fileRel) {
  const name = path.basename(fileRel).replace(/\.(js|cjs|mjs|ts)$/, "");
  const cleaned = name.replace(/Controller$/i, "").replace(/Route(s)?$/i, "").toLowerCase();
  return `/${cleaned}`;
}

// ---- Mount your known routes if present -------------------------------------
const candidates = [
  "./routes/calendarController.js",
  "./routes/cookingOrchestrator.js",
  "./routes/inventoryController.js",
  "./routes/irrigationController.js",
  { file: "./routes/mealPlanController.js", basePath: "/api/mealplan" },
  { file: "./routes/planners.js", basePath: "/api/planners" },
  "./routes/labelsController.js",
  "./routes/preferencesController.js",
  { file: "./routes/authController.js", basePath: "/api/auth" },
  { file: "./routes/accessPolicyAdminController.js", basePath: "/api/access-policies" },
  { file: "./routes/battleRhythmController.js", basePath: "/api/battle-rhythm" },
  "./routes/automationsController.js",
  "./routes/realtimeController.js",
  "./routes/uploadsController.js",
];

const routesReadyPromise = (async () => {
  let mountedCount = 0;
  for (const candidate of candidates) {
    const rel = typeof candidate === "string" ? candidate : candidate.file;
    const basePath =
      candidate && typeof candidate === "object" ? candidate.basePath : undefined;
    // eslint-disable-next-line no-await-in-loop
    if (await safeMountRoute(rel, basePath)) mountedCount++;
  }
  console.log(`[routes] mounted ${mountedCount}/${candidates.length} candidate route files`);
})().catch((e) => {
  console.warn("[routes] dynamic mount failed:", e?.message || e);
});

let terminalHandlersInstalled = false;
function installTerminalHandlers() {
  if (terminalHandlersInstalled) return;
  terminalHandlersInstalled = true;

  // ---- 404 handler ----
  app.use((req, res) => {
    res.status(404).json({
      ok: false,
      error: "not_found",
      path: req.originalUrl,
      method: req.method,
      requestId: req.id,
    });
  });

  // ---- Error handler ----
  app.use((err, req, res, next) => {
    const safeError = {
      name: err?.name,
      code: err?.code,
      message: redactText(String(err?.message || "")),
      stack: NODE_ENV === "development" ? redactText(String(err?.stack || "")) : undefined,
      requestId: req?.id,
      path: req?.originalUrl,
      method: req?.method,
      headers: redactObject(req?.headers || {}),
    };
    console.error("[http:error]", safeError);

    const status = err.status || err.statusCode || 500;
    const payload = {
      ok: false,
      error: err.code || err.name || "Error",
      message: err.expose
        ? err.message
        : NODE_ENV === "development"
        ? String(err.message || err)
        : "Internal Server Error",
      requestId: req.id,
    };
    if (NODE_ENV === "development") payload.stack = err.stack;
    res.status(status).json(payload);
  });
}

// ---- Create HTTP server & attach sockets ----
const server = http.createServer(app);
(async () => {
  try {
    const socketMod = await loadAny("./socket.js").catch(() => null);
    if (socketMod?.createSocketServer) {
      socketMod.createSocketServer(server);
      console.log("[socket] Socket.IO attached");
    }
  } catch (e) {
    console.warn("[socket] Skipped attaching Socket.IO:", e?.message || e);
  }
})();

// ---- Start listening ----
async function startServer() {
  const postgresConfigured =
    !!String(process.env.DATABASE_URL || "").trim() ||
    (String(process.env.PGHOST || "").trim() !== "" &&
      String(process.env.PGUSER || "").trim() !== "" &&
      String(process.env.PGPASSWORD || "").trim() !== "" &&
      String(process.env.PGDATABASE || "").trim() !== "");

  try {
    await dbConnection.init();
    const db = dbConnection.getStatus();
    const mongoRequired = String(process.env.MONGODB_REQUIRED || "false").toLowerCase() === "true";
    mongoStartupStatus = {
      checked: true,
      checkedAt: new Date().toISOString(),
      ok: db.connected || !mongoRequired,
      required: mongoRequired,
      configured: db.uriConfigured,
      connected: db.connected,
      fallbackFileMode: db.fallbackFileMode,
      error: db.lastError,
    };
  } catch (e) {
    console.warn("[boot] db connection init failed; continuing in file-fallback mode:", e?.message || e);
    const mongoRequired = String(process.env.MONGODB_REQUIRED || "false").toLowerCase() === "true";
    mongoStartupStatus = {
      checked: true,
      checkedAt: new Date().toISOString(),
      ok: !mongoRequired,
      required: mongoRequired,
      configured: !!String(process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL || "").trim(),
      connected: false,
      fallbackFileMode: true,
      error: String(e?.message || e || "mongo_startup_check_failed"),
    };
    if (mongoRequired) {
      throw e;
    }
  }

  try {
    const plannerIntegration = await loadAny("./services/planners/PlannerIntegrationService.js").catch(
      () => null
    );
    if (plannerIntegration?.pgPool?.query) {
      await plannerIntegration.pgPool.query("select 1 as ok");
      const postgresRequired = String(process.env.POSTGRES_REQUIRED || "false").toLowerCase() === "true";
      postgresStartupStatus = {
        checked: true,
        checkedAt: new Date().toISOString(),
        ok: true,
        required: postgresRequired,
        configured: postgresConfigured,
        connected: true,
        skipped: false,
        error: null,
      };
    } else {
      const postgresRequired = String(process.env.POSTGRES_REQUIRED || "false").toLowerCase() === "true";
      postgresStartupStatus = {
        checked: true,
        checkedAt: new Date().toISOString(),
        ok: !postgresRequired,
        required: postgresRequired,
        configured: postgresConfigured,
        connected: false,
        skipped: true,
        error: "postgres_pool_unavailable",
      };
    }
  } catch (e) {
    const postgresRequired = String(process.env.POSTGRES_REQUIRED || "false").toLowerCase() === "true";
    postgresStartupStatus = {
      checked: true,
      checkedAt: new Date().toISOString(),
      ok: !postgresRequired,
      required: postgresRequired,
      configured: postgresConfigured,
      connected: false,
      skipped: false,
      error: String(e?.message || e || "postgres_startup_check_failed"),
    };
    console.warn("[boot] postgres startup check warning:", e?.message || e);
    if (postgresRequired) {
      throw e;
    }
  }

  try {
    const plannerIntegration = await loadAny("./services/planners/PlannerIntegrationService.js").catch(
      () => null
    );
    if (plannerIntegration?.verifyNeo4jIntegration) {
      const required = String(process.env.NEO4J_REQUIRED || "false").toLowerCase() === "true";
      const neo4jStatus = await plannerIntegration.verifyNeo4jIntegration({ required });
      neo4jStartupStatus = {
        checked: true,
        checkedAt: new Date().toISOString(),
        ...neo4jStatus,
        required,
      };
      if (!neo4jStatus.ok) {
        const message = `[boot] neo4j validation failed: ${neo4jStatus.error || "unknown"}`;
        if (neo4jStatus.required) {
          throw new Error(message);
        }
        console.warn(`${message}; continuing (NEO4J_REQUIRED=false)`);
      } else if (neo4jStatus.skipped) {
        console.log("[boot] neo4j validation skipped (feature not enabled)");
      } else {
        console.log("[boot] neo4j validation passed (ping ok)");
      }
    }
  } catch (e) {
    neo4jStartupStatus = {
      checked: true,
      checkedAt: new Date().toISOString(),
      ok: false,
      skipped: false,
      required: String(process.env.NEO4J_REQUIRED || "false").toLowerCase() === "true",
      error: String(e?.message || e || "neo4j_validation_failed"),
    };
    console.warn("[boot] neo4j validation warning:", e?.message || e);
    if (String(process.env.NEO4J_REQUIRED || "false").toLowerCase() === "true") {
      throw e;
    }
  }

  await routesReadyPromise;
  installTerminalHandlers();

  try {
    const projectionSync = await loadAny("./services/planners/PlannerProjectionSync.js").catch(
      () => null
    );
    projectionSync?.startProjectionWorker?.();
  } catch (e) {
    console.warn("[boot] projection worker start skipped:", e?.message || e);
  }

  try {
    const disabled =
      String(process.env.PLANNER_OPERATIONAL_OUTBOX_WORKER_DISABLED || "false").toLowerCase() ===
      "true";
    if (!disabled) {
      const outboxWorker = await loadAny(
        "./services/planners/OperationalProjectionWorker.js"
      ).catch(() => null);
      outboxWorker?.startOperationalProjectionWorker?.();
    }
  } catch (e) {
    console.warn("[boot] operational outbox worker start skipped:", e?.message || e);
  }

  server.listen(PORT, HOST, () => {
    const db = dbConnection.getStatus();
    console.log(`\nSuka Smart Assistant server listening on http://${HOST}:${PORT}  [env=${NODE_ENV}]`);
    console.log(`[boot] db driver=${db.driver} connected=${db.connected} fallbackFileMode=${db.fallbackFileMode}`);

    Promise.resolve()
      .then(() => catalogSyncService?.syncCatalogIndexes?.())
      .then((sync) => {
        if (!sync?.ok) return;
        console.log(
          `[boot] catalog cache sync mode=${sync.mode} recipes=${sync.recipeCount} rules=${sync.ruleCount}`
        );
      })
      .catch((e) => {
        console.warn("[boot] catalog cache sync skipped:", e?.message || e);
      });
  });
}

startServer().catch((e) => {
  console.error("[server] failed to start:", redactText(String(e?.stack || e?.message || e)));
  process.exitCode = 1;
});

// ---- Graceful shutdown ----
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] Received ${signal}, shutting down...`);
  server.close((err) => {
    if (err) {
      console.error("[server] Error during close:", err);
      process.exitCode = 1;
    }
    dbConnection.close().catch((e) => {
      console.warn("[server] DB close warning:", e?.message || e);
    });
    Promise.resolve()
      .then(() => loadAny("./services/planners/PlannerProjectionSync.js"))
      .then((projectionSync) => projectionSync?.stopProjectionWorker?.())
      .catch(() => {});
    Promise.resolve()
      .then(() => loadAny("./services/planners/OperationalProjectionWorker.js"))
      .then((outboxWorker) => outboxWorker?.stopOperationalProjectionWorker?.())
      .catch(() => {});
    try {
      setTimeout(() => process.exit(), 200);
    } catch {
      process.exit();
    }
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandledRejection:", redactText(String(reason?.stack || reason?.message || reason)));
});
process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException:", redactText(String(err?.stack || err?.message || err)));
});

module.exports = { app, server };
