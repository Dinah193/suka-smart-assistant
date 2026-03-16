"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

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

async function main() {
  loadWorkspaceEnv();

  const mongoUri = String(
    process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL || ""
  ).trim();

  if (!mongoUri) {
    console.error("[nutrition-mongo-contract] Missing Mongo URI env var");
    process.exit(1);
  }

  const dbConnection = require("../../src/server/services/dbConnection.js");

  const adapterPath = path.resolve(
    process.cwd(),
    "src",
    "server",
    "db",
    "adapters",
    "nutrition.mongo.js"
  );
  const adapterMod = await import(pathToFileURL(adapterPath).href);
  const adapter = adapterMod?.default || adapterMod;

  if (!adapter || typeof adapter.getById !== "function" || typeof adapter.getByName !== "function" || typeof adapter.upsert !== "function") {
    console.error("[nutrition-mongo-contract] Adapter does not expose getById/getByName/upsert");
    process.exit(1);
  }

  await dbConnection.init();
  const status = dbConnection.getStatus();
  if (!status?.connected) {
    console.error(`[nutrition-mongo-contract] Mongo not connected: ${status?.lastError || "unknown"}`);
    process.exit(1);
  }

  const key = `nutrition-contract-${Date.now()}`;
  const id = `food:${key}`;

  try {
    const write = await adapter.upsert({
      id,
      normalizedName: key,
      displayName: "Nutrition Contract Record",
      source: "contract-test",
      macros: { calories: 100, protein: 8, fat: 2, carbs: 10 },
      micros: { sodium: 25 },
      meta: { test: true },
    });

    if (!write?.ok || write?.id !== id) {
      console.error("[nutrition-mongo-contract] Upsert failed");
      process.exit(1);
    }

    const byId = await adapter.getById(id);
    if (!byId?.ok || byId?.data?.id !== id) {
      console.error("[nutrition-mongo-contract] Lookup by id failed");
      process.exit(1);
    }

    const byName = await adapter.getByName(key);
    if (!byName?.ok || byName?.data?.id !== id) {
      console.error("[nutrition-mongo-contract] Lookup by name failed");
      process.exit(1);
    }

    console.log(JSON.stringify({ ok: true, id, normalizedName: key }));
  } finally {
    await dbConnection.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[nutrition-mongo-contract] Failed: ${String(error?.message || error)}`);
  process.exit(1);
});
