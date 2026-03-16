"use strict";

const fs = require("fs");
const path = require("path");

let mongoose = null;
try {
  mongoose = require("mongoose");
} catch {
  mongoose = null;
}

let dbConnection = null;
try {
  dbConnection = require("./dbConnection.js");
} catch {
  dbConnection = null;
}

const CATALOG_ROOT = path.resolve(process.cwd(), "src/catalogs");
const DATA_DIR = path.resolve(process.cwd(), "data");
const CACHE_FILE = path.join(DATA_DIR, "catalog-index-cache.json");
const SYNC_KEY = "catalog.sync.state";

let CatalogRecipeIndex = null;
let CatalogRuleIndex = null;
let CatalogSyncState = null;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeText(v) {
  return String(v || "").toLowerCase().trim();
}

function asArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function walkFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;

  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(abs);
      else out.push(abs);
    }
  }

  return out;
}

function parseJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function deriveDomainFromPath(relPath) {
  const norm = relPath.replace(/\\/g, "/");
  const parts = norm.split("/");
  if (parts[0] !== "src" || parts[1] !== "catalogs") return { domain: "unknown", subdomain: null };
  if (parts[2] === "cuisines") {
    return { domain: "cuisines", subdomain: parts[3] || null };
  }
  return { domain: parts[2] || "unknown", subdomain: null };
}

function buildCatalogIndexes() {
  const files = walkFiles(CATALOG_ROOT).filter((f) => f.endsWith(".json"));
  const recipeDocs = [];
  const ruleDocs = [];

  for (const filePath of files) {
    const relPath = path.relative(process.cwd(), filePath);
    const relNorm = relPath.replace(/\\/g, "/");
    const json = parseJson(filePath);
    if (!json || typeof json !== "object") continue;

    const { domain, subdomain } = deriveDomainFromPath(relNorm);
    const isRecipeFile = /\/recipes\/[^/]+\.json$/i.test(relNorm);
    const isCatalogIndex = /\.catalog\.json$/i.test(relNorm);
    const isSharedRule = /\/cuisines_shared\//i.test(relNorm);
    const isRuleFile = /\/profiles\/|\/rulesets\//i.test(relNorm) || isSharedRule;

    if (isRecipeFile) {
      const recipeId = String(json?.meta?.id || json?.id || path.basename(filePath, ".json")).trim();
      const title = String(json?.meta?.name || json?.title || json?.name || recipeId).trim();
      const tags = Array.from(
        new Set(
          asArray(json?.tags)
            .concat(asArray(json?.classification?.plannerTags))
            .map((x) => String(x || "").trim())
            .filter(Boolean)
        )
      );

      recipeDocs.push({
        recipeId,
        title,
        domain,
        subdomain,
        tags,
        filePath: relNorm,
        sourceType: "json",
      });
      continue;
    }

    if (isCatalogIndex) {
      const entries = asArray(json?.items).concat(asArray(json?.dishes));
      for (const item of entries) {
        const recipeId = String(item?.id || "").trim();
        if (!recipeId) continue;
        recipeDocs.push({
          recipeId,
          title: String(item?.title || item?.name || recipeId).trim(),
          domain,
          subdomain,
          tags: asArray(item?.tags).map((x) => String(x || "").trim()).filter(Boolean),
          filePath: relNorm,
          sourceType: "catalog-index",
        });
      }
      continue;
    }

    if (isRuleFile) {
      const ruleId = String(json?.meta?.id || json?.id || path.basename(filePath, ".json")).trim();
      const type = String(json?.meta?.type || "rule").trim();
      const tags = asArray(json?.meta?.tags || json?.tags)
        .map((x) => String(x || "").trim())
        .filter(Boolean);

      ruleDocs.push({
        ruleId,
        type,
        domain,
        subdomain,
        tags,
        filePath: relNorm,
      });
    }
  }

  const dedupRecipe = new Map();
  for (const d of recipeDocs) {
    const key = `${d.recipeId}::${d.filePath}`;
    dedupRecipe.set(key, d);
  }

  const dedupRule = new Map();
  for (const d of ruleDocs) {
    const key = `${d.ruleId}::${d.filePath}`;
    dedupRule.set(key, d);
  }

  return {
    recipes: Array.from(dedupRecipe.values()),
    rules: Array.from(dedupRule.values()),
  };
}

function dbReady() {
  const status = dbConnection?.getStatus?.();
  return Boolean(mongoose && status?.connected);
}

function ensureModels() {
  if (!dbReady()) return false;
  if (CatalogRecipeIndex && CatalogRuleIndex && CatalogSyncState) return true;

  const recipeSchema = new mongoose.Schema(
    {
      recipeId: { type: String, required: true, index: true },
      title: { type: String, default: "" },
      domain: { type: String, default: "" },
      subdomain: { type: String, default: "" },
      tags: { type: [String], default: [] },
      filePath: { type: String, required: true },
      sourceType: { type: String, default: "json" },
    },
    { timestamps: true, collection: "catalog_recipe_index" }
  );
  recipeSchema.index({ recipeId: 1, filePath: 1 }, { unique: true });

  const ruleSchema = new mongoose.Schema(
    {
      ruleId: { type: String, required: true, index: true },
      type: { type: String, default: "rule" },
      domain: { type: String, default: "" },
      subdomain: { type: String, default: "" },
      tags: { type: [String], default: [] },
      filePath: { type: String, required: true },
    },
    { timestamps: true, collection: "catalog_rule_index" }
  );
  ruleSchema.index({ ruleId: 1, filePath: 1 }, { unique: true });

  const syncSchema = new mongoose.Schema(
    {
      key: { type: String, required: true, unique: true },
      syncedAt: { type: String, default: "" },
      recipeCount: { type: Number, default: 0 },
      ruleCount: { type: Number, default: 0 },
      mode: { type: String, default: "db" },
      notes: { type: String, default: "" },
    },
    { timestamps: true, collection: "catalog_sync_state" }
  );

  CatalogRecipeIndex =
    mongoose.models.CatalogRecipeIndex ||
    mongoose.model("CatalogRecipeIndex", recipeSchema);
  CatalogRuleIndex =
    mongoose.models.CatalogRuleIndex ||
    mongoose.model("CatalogRuleIndex", ruleSchema);
  CatalogSyncState =
    mongoose.models.CatalogSyncState ||
    mongoose.model("CatalogSyncState", syncSchema);

  return true;
}

async function syncToDb(indexes) {
  const recipeOps = indexes.recipes.map((doc) => ({
    replaceOne: {
      filter: { recipeId: doc.recipeId, filePath: doc.filePath },
      replacement: doc,
      upsert: true,
    },
  }));

  const ruleOps = indexes.rules.map((doc) => ({
    replaceOne: {
      filter: { ruleId: doc.ruleId, filePath: doc.filePath },
      replacement: doc,
      upsert: true,
    },
  }));

  if (recipeOps.length) {
    await CatalogRecipeIndex.bulkWrite(recipeOps, { ordered: false });
  }
  if (ruleOps.length) {
    await CatalogRuleIndex.bulkWrite(ruleOps, { ordered: false });
  }

  await CatalogSyncState.findOneAndUpdate(
    { key: SYNC_KEY },
    {
      $set: {
        syncedAt: new Date().toISOString(),
        recipeCount: indexes.recipes.length,
        ruleCount: indexes.rules.length,
        mode: "db",
      },
    },
    { upsert: true, new: true }
  );
}

function syncToFile(indexes) {
  ensureDir(DATA_DIR);
  const payload = {
    syncedAt: new Date().toISOString(),
    mode: "file",
    recipeCount: indexes.recipes.length,
    ruleCount: indexes.rules.length,
    recipes: indexes.recipes,
    rules: indexes.rules,
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

async function syncCatalogIndexes() {
  const indexes = buildCatalogIndexes();

  if (ensureModels()) {
    await syncToDb(indexes);
    return {
      ok: true,
      mode: "db",
      recipeCount: indexes.recipes.length,
      ruleCount: indexes.rules.length,
      syncedAt: new Date().toISOString(),
    };
  }

  const payload = syncToFile(indexes);
  return {
    ok: true,
    mode: "file",
    recipeCount: payload.recipeCount,
    ruleCount: payload.ruleCount,
    syncedAt: payload.syncedAt,
  };
}

function getCatalogCacheStatus() {
  if (ensureModels()) {
    return {
      mode: "db",
      cacheFile: null,
    };
  }

  const file = safeReadJson(CACHE_FILE, null);
  return {
    mode: "file",
    cacheFile: CACHE_FILE,
    recipeCount: file?.recipeCount || 0,
    ruleCount: file?.ruleCount || 0,
    syncedAt: file?.syncedAt || null,
  };
}

async function getCatalogRuleIndexSnapshot() {
  if (ensureModels()) {
    const rules = await CatalogRuleIndex.find({}).lean();
    return {
      mode: "db",
      rules: Array.isArray(rules) ? rules : [],
      syncedAt: null,
    };
  }

  const file = safeReadJson(CACHE_FILE, null);
  return {
    mode: "file",
    rules: Array.isArray(file?.rules) ? file.rules : [],
    syncedAt: file?.syncedAt || null,
  };
}

module.exports = {
  syncCatalogIndexes,
  getCatalogCacheStatus,
  getCatalogRuleIndexSnapshot,
};
