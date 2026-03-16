"use strict";

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");

function loadWorkspaceEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    if (!key || process.env[key] != null) continue;

    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function resolveConnectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const host = process.env.PGHOST;
  const port = process.env.PGPORT || "5432";
  const user = process.env.PGUSER;
  const pass = process.env.PGPASSWORD;
  const db = process.env.PGDATABASE;

  if (host && user && pass && db) {
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
  }

  return "";
}

function terminateChild(child, graceMs = 1200) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode != null) {
      resolve();
      return;
    }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };

    const forceTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // no-op
      }
    }, graceMs);

    child.once("exit", () => {
      clearTimeout(forceTimer);
      finish();
    });

    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(forceTimer);
      finish();
    }
  });
}

function runNodeScript(filePath, { env = process.env, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [filePath], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (buf) => {
      stdout += String(buf || "");
    });
    child.stderr?.on("data", (buf) => {
      stderr += String(buf || "");
    });

    let timedOut = false;
    const timer = setTimeout(async () => {
      timedOut = true;
      await terminateChild(child);
      reject(
        new Error(
          `timeout:${path.basename(filePath)} exceeded ${timeoutMs}ms${stderr ? ` stderr=${stderr.trim()}` : ""}`
        )
      );
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code === 0) {
        resolve({ code, signal, stdout, stderr });
      } else {
        reject(
          new Error(
            `failed:${path.basename(filePath)} exit=${code} signal=${signal || "none"}${stderr ? ` stderr=${stderr.trim()}` : ""}`
          )
        );
      }
    });
  });
}

function reserveEphemeralPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();

    srv.on("error", (err) => reject(err));
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = Number(address && typeof address === "object" ? address.port : 0);
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function waitForHealth(port, timeoutMs = 12000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        const payload = await res.json();
        if (payload?.ok) return payload;
        throw new Error(`health_not_ok:${JSON.stringify(payload)}`);
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(`health_timeout:${String(lastError?.message || lastError || "unknown")}`);
}

async function probeServerHealth(baseEnv, timeoutMs = 16000) {
  const port = await reserveEphemeralPort();
  const env = {
    ...baseEnv,
    PORT: String(port),
    HOST: "127.0.0.1",
    NODE_ENV: baseEnv.NODE_ENV || "test",
    STRICT_STARTUP_ENV: String(baseEnv.STRICT_STARTUP_ENV || "false"),
    PLANNER_OPERATIONAL_OUTBOX_WORKER_DISABLED: "true",
  };

  const entry = path.resolve(process.cwd(), "src", "server", "index.js");
  const child = spawn(process.execPath, [entry], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  let logs = "";
  child.stdout?.on("data", (buf) => {
    logs += String(buf || "");
  });
  child.stderr?.on("data", (buf) => {
    logs += String(buf || "");
  });

  const guard = setTimeout(async () => {
    await terminateChild(child);
  }, timeoutMs);

  try {
    const health = await waitForHealth(port, timeoutMs - 1000);
    return { port, health };
  } finally {
    clearTimeout(guard);
    await terminateChild(child);
  }
}

async function checkMongoConnectivity(baseEnv) {
  const dbConnectionPath = path.resolve(process.cwd(), "src", "server", "services", "dbConnection.js");
  // Force a fresh load so this script reflects current env each run.
  delete require.cache[dbConnectionPath];
  const dbConnection = require(dbConnectionPath);

  const priorEnv = {
    MONGODB_URI: process.env.MONGODB_URI,
    MONGO_URI: process.env.MONGO_URI,
    MONGO_URL: process.env.MONGO_URL,
    MONGO_SERVER_SELECTION_TIMEOUT_MS: process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS,
    MONGO_MAX_POOL_SIZE: process.env.MONGO_MAX_POOL_SIZE,
  };

  process.env.MONGODB_URI = baseEnv.MONGODB_URI || "";
  process.env.MONGO_URI = baseEnv.MONGO_URI || "";
  process.env.MONGO_URL = baseEnv.MONGO_URL || "";
  process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS = String(
    baseEnv.MONGO_SERVER_SELECTION_TIMEOUT_MS || process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 2000
  );
  process.env.MONGO_MAX_POOL_SIZE = String(baseEnv.MONGO_MAX_POOL_SIZE || process.env.MONGO_MAX_POOL_SIZE || 10);

  try {
    await dbConnection.init();
    const status = dbConnection.getStatus();
    if (!status.uriConfigured) {
      throw new Error("mongo_uri_missing:MONGODB_URI/MONGO_URI/MONGO_URL is required for preflight");
    }
    if (!status.connected) {
      throw new Error(`mongo_connect_failed:${status.lastError || "unknown"}`);
    }
    return status;
  } finally {
    await dbConnection.close().catch(() => {});

    if (priorEnv.MONGODB_URI == null) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = priorEnv.MONGODB_URI;

    if (priorEnv.MONGO_URI == null) delete process.env.MONGO_URI;
    else process.env.MONGO_URI = priorEnv.MONGO_URI;

    if (priorEnv.MONGO_URL == null) delete process.env.MONGO_URL;
    else process.env.MONGO_URL = priorEnv.MONGO_URL;

    if (priorEnv.MONGO_SERVER_SELECTION_TIMEOUT_MS == null) delete process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS;
    else process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS = priorEnv.MONGO_SERVER_SELECTION_TIMEOUT_MS;

    if (priorEnv.MONGO_MAX_POOL_SIZE == null) delete process.env.MONGO_MAX_POOL_SIZE;
    else process.env.MONGO_MAX_POOL_SIZE = priorEnv.MONGO_MAX_POOL_SIZE;
  }
}

async function main() {
  const startedAt = Date.now();
  const maxRuntimeMs = Number(process.env.DB_PREFLIGHT_TIMEOUT_MS || 55000);
  if (!Number.isFinite(maxRuntimeMs) || maxRuntimeMs < 10000) {
    throw new Error("invalid DB_PREFLIGHT_TIMEOUT_MS; must be >= 10000");
  }

  loadWorkspaceEnv();

  const connectionString = resolveConnectionString();
  if (!connectionString) {
    throw new Error(
      "Missing DB connection. Set DATABASE_URL or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE, or add them to .env"
    );
  }

  const baseEnv = {
    ...process.env,
    DATABASE_URL: connectionString,
    MONGO_SERVER_SELECTION_TIMEOUT_MS: String(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 2000),
    PLANNER_OPERATIONAL_OUTBOX_WORKER_DISABLED: "true",
  };

  const out = {
    ok: false,
    maxRuntimeMs,
    totalMs: 0,
    checks: {},
  };

  function remainingMs() {
    return Math.max(1000, maxRuntimeMs - (Date.now() - startedAt));
  }

  const migrateScript = path.resolve(process.cwd(), "tools", "scripts", "db-migrate.cjs");
  const bootstrapScript = path.resolve(process.cwd(), "tools", "scripts", "check-planner-db-bootstrap.cjs");

  const stepStartedMigrate = Date.now();
  await runNodeScript(migrateScript, {
    env: baseEnv,
    timeoutMs: Math.min(22000, remainingMs()),
  });
  out.checks.postgresMigrate = { ok: true, ms: Date.now() - stepStartedMigrate };

  const stepStartedBootstrap = Date.now();
  await runNodeScript(bootstrapScript, {
    env: baseEnv,
    timeoutMs: Math.min(16000, remainingMs()),
  });
  out.checks.postgresBootstrap = { ok: true, ms: Date.now() - stepStartedBootstrap };

  const stepStartedMongo = Date.now();
  const mongo = await Promise.race([
    checkMongoConnectivity(baseEnv),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("mongo_check_timeout")), Math.min(9000, remainingMs()));
    }),
  ]);
  out.checks.mongo = {
    ok: true,
    ms: Date.now() - stepStartedMongo,
    driver: mongo.driver,
    connected: mongo.connected,
    uriConfigured: mongo.uriConfigured,
  };

  const stepStartedHealth = Date.now();
  const healthProbe = await probeServerHealth(baseEnv, Math.min(14000, remainingMs()));
  out.checks.healthProbe = {
    ok: true,
    ms: Date.now() - stepStartedHealth,
    port: healthProbe.port,
    db: healthProbe.health?.db || null,
  };

  out.ok = true;
  out.totalMs = Date.now() - startedAt;
  if (out.totalMs > maxRuntimeMs) {
    throw new Error(`preflight_runtime_exceeded:${out.totalMs}ms > ${maxRuntimeMs}ms`);
  }

  console.log(JSON.stringify(out));
}

main().catch((error) => {
  console.error(`[db:preflight] Failed: ${String(error?.message || error)}`);
  process.exit(1);
});
