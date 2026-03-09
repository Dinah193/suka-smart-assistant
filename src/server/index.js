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
const CORS_ORIGIN = (process.env.CORS_ORIGIN || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SERVER_TZ = process.env.TZ || "America/New_York";

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
  app.use(
    morgan("dev", {
      skip: () => NODE_ENV === "test",
    })
  );
}

// ---- Static files (optional) ----
if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR, { fallthrough: true, maxAge: NODE_ENV === "production" ? "1d" : 0 }));
}

// ---- Health & info ----
const startedAt = new Date();
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
  if (typeof mod === "function") {
    mod(app);
    console.log(`[routes] mounted function from ${fileRel}`);
    return true;
  }
  if (mod?.router && typeof mod.router === "function") {
    app.use(mountPath, mod.router);
    console.log(`[routes] mounted router at ${mountPath} from ${fileRel}`);
    return true;
  }
  if (mod?.default && typeof mod.default === "function" && mod.default.name.length) {
    // Named function default (assume (app) loader)
    try {
      mod.default(app);
      console.log(`[routes] mounted default(app) from ${fileRel}`);
      return true;
    } catch {}
  }
  if (mod?.default && typeof mod.default?.use === "function") {
    app.use(mountPath, mod.default);
    console.log(`[routes] mounted default router at ${mountPath} from ${fileRel}`);
    return true;
  }
  if (mod && typeof mod.use === "function") {
    app.use(mountPath, mod);
    console.log(`[routes] mounted router instance at ${mountPath} from ${fileRel}`);
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
  "./routes/mealPlanController.js",
  "./routes/labelsController.js",
  "./routes/preferencesController.js",
  "./routes/automationsController.js",
  "./routes/realtimeController.js",
  "./routes/uploadsController.js",
];

(async () => {
  let mountedCount = 0;
  for (const rel of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await safeMountRoute(rel)) mountedCount++;
  }
  console.log(`[routes] mounted ${mountedCount}/${candidates.length} candidate route files`);
})().catch((e) => {
  console.warn("[routes] dynamic mount failed:", e?.message || e);
});

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

// ---- Optional: basic rate limit on all requests (attach last) ----
if (rateLimit) {
  const limiter = rateLimit({
    windowMs: Number(process.env.RATE_WINDOW_MS || 60_000),
    max: Number(process.env.RATE_MAX || 600),
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(limiter);
}

// ---- Start listening ----
server.listen(PORT, HOST, () => {
  console.log(`\nSuka Smart Assistant server listening on http://${HOST}:${PORT}  [env=${NODE_ENV}]`);
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
  console.error("[server] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException:", err);
});

module.exports = { app, server };
