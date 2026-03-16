"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { MongoClient } = require("mongodb");

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

function resolveMongoUri() {
  return String(process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL || "").trim();
}

async function loadModel(modulePath) {
  const mod = await import(pathToFileURL(modulePath).href);
  return mod?.default || mod;
}

function validateTtlIndex(model, { modelName, expectedField }) {
  const schema = model?.schema;
  if (!schema) {
    return {
      ok: false,
      model: modelName,
      error: "missing_schema",
    };
  }

  const hasField = !!schema.path(expectedField);
  const indexes = schema.indexes();
  const ttl = indexes.find(([keys, options]) => keys?.[expectedField] === 1 && Number(options?.expireAfterSeconds) === 0);

  return {
    ok: hasField && !!ttl,
    model: modelName,
    field: expectedField,
    hasField,
    hasDeclaredTtlIndex: !!ttl,
    declaredIndexes: indexes.map(([keys, options]) => ({ keys, options })),
    collectionName: model?.collection?.name || model?.schema?.options?.collection || null,
  };
}

async function validateLiveTtlIndex(db, check) {
  const collectionName = check.collectionName;
  if (!collectionName) {
    return {
      ...check,
      ok: false,
      hasLiveTtlIndex: false,
      liveIndexes: [],
      error: "collection_name_unresolved",
    };
  }

  try {
    const liveIndexes = await db.collection(collectionName).indexes();
    const ttl = liveIndexes.find(
      (idx) => idx?.key?.[check.field] === 1 && Number(idx?.expireAfterSeconds) === 0
    );

    return {
      ...check,
      hasLiveTtlIndex: !!ttl,
      liveIndexes,
      liveCheckSkipped: false,
      ok: check.ok && !!ttl,
    };
  } catch (error) {
    const message = String(error?.message || error || "index_lookup_failed");
    if (message.toLowerCase().includes("ns does not exist")) {
      return {
        ...check,
        hasLiveTtlIndex: false,
        liveIndexes: [],
        liveCheckSkipped: true,
        reason: "collection_missing",
        ok: check.ok,
      };
    }

    return {
      ...check,
      hasLiveTtlIndex: false,
      liveIndexes: [],
      liveCheckSkipped: false,
      error: message,
      ok: false,
    };
  }
}

async function main() {
  loadWorkspaceEnv();
  const repoRoot = process.cwd();
  const mongoUri = resolveMongoUri();
  if (!mongoUri) {
    throw new Error("Missing Mongo URI env var (MONGODB_URI/MONGO_URI/MONGO_URL)");
  }

  const nutritionPath = path.resolve(repoRoot, "src", "services", "mongodb", "nutritionData.collection.js");
  const rawRecipesPath = path.resolve(repoRoot, "src", "services", "mongodb", "rawRecipes.collection.js");
  const preservationPath = path.resolve(repoRoot, "src", "services", "mongodb", "preservationData.collection.js");

  const [NutritionData, RawRecipes, PreservationData] = await Promise.all([
    loadModel(nutritionPath),
    loadModel(rawRecipesPath),
    loadModel(preservationPath),
  ]);

  const checks = [
    validateTtlIndex(NutritionData, { modelName: "NutritionData", expectedField: "expiresAt" }),
    validateTtlIndex(RawRecipes, { modelName: "RawRecipes", expectedField: "expiresAt" }),
    validateTtlIndex(PreservationData, { modelName: "PreservationData", expectedField: "expiresAt" }),
  ];

  const client = new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 5000),
  });

  await client.connect();
  try {
    const db = client.db();
    const liveChecks = [];
    for (const check of checks) {
      liveChecks.push(await validateLiveTtlIndex(db, check));
    }

    const out = {
      ok: liveChecks.every((x) => x.ok),
      dbName: db.databaseName,
      checks: liveChecks,
    };

    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(out.ok ? 0 : 1);
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("[verify-mongo-retention] Failed:", String(error?.message || error));
  process.exit(1);
});
