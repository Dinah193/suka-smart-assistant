"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  bootstrapPlannerTables,
} = require("../../src/server/services/planners/PlannerSchemaBootstrap");

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
    console.error(
      "[check-planner-db-bootstrap] Missing DB connection. Set DATABASE_URL or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE, or add them to .env"
    );
    process.exit(1);
  }

  const out = await bootstrapPlannerTables(connectionString);
  if (!out.ok) {
    console.error(
      "[check-planner-db-bootstrap] Missing required tables:",
      out.tableCheck?.missing?.join(", ") || "unknown"
    );
    process.exit(1);
  }

  console.log(JSON.stringify(out));
}

main().catch((error) => {
  console.error("[check-planner-db-bootstrap] Failed:", String(error?.message || error));
  process.exit(1);
});
