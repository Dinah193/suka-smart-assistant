"use strict";

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

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

async function main() {
  loadWorkspaceEnv();
  const connectionString = resolveConnectionString();

  if (!connectionString) {
    console.error("[test:planners:db-contract] Missing DB connection configuration.");
    console.error(
      "Set DATABASE_URL or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE (or place them in .env), then rerun."
    );
    process.exit(1);
  }

  process.env.DATABASE_URL = connectionString;

  const preflightEntry = path.resolve(
    process.cwd(),
    "tools",
    "scripts",
    "db-preflight.cjs"
  );
  const preflightCheck = spawnSync(process.execPath, [preflightEntry], {
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  if (preflightCheck.error || preflightCheck.status !== 0) {
    console.error("[test:planners:db-contract] DB preflight failed.");
    process.exit(1);
  }

  const env = {
    ...process.env,
    SSA_ENABLE_RUNTIME_CONTRACT_TESTS: "true",
    SSA_ENABLE_DB_RUNTIME_CONTRACT_TESTS: "true",
  };

  const vitestEntrypoint = path.resolve(
    process.cwd(),
    "node_modules",
    "vitest",
    "vitest.mjs"
  );
  const bin = process.execPath;
  const args = [
    vitestEntrypoint,
    "run",
    "_tests_/planners.runtime.contract.test.js",
    "--reporter",
    "verbose",
  ];

  const result = spawnSync(bin, args, {
    env,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    console.error("[test:planners:db-contract] Failed to launch vitest:", result.error.message);
    process.exit(1);
  }

  process.exit(Number.isInteger(result.status) ? result.status : 1);
}

main().catch((error) => {
  console.error("[test:planners:db-contract] Unexpected failure:", String(error?.message || error));
  process.exit(1);
});
