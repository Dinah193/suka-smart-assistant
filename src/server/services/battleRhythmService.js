import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let mongoose = null;
let dbConnection = null;
try {
  mongoose = require("mongoose");
} catch {
  mongoose = null;
}

try {
  dbConnection = require("./dbConnection.js");
} catch {
  dbConnection = null;
}

const DATA_DIR = path.resolve(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "battle-rhythm.json");

let UserBattleRhythmModel = null;
let RecipeCustomizationModel = null;

function asObj(v) {
  return v && typeof v === "object" ? v : {};
}

function normKey(v) {
  return String(v || "").trim();
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readFileStore() {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(DB_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return {
      users: asObj(parsed.users),
      customizations: asObj(parsed.customizations),
      updatedAt: parsed.updatedAt || null,
    };
  } catch {
    return { users: {}, customizations: {}, updatedAt: null };
  }
}

async function writeFileStore(data) {
  await ensureDataDir();
  const payload = {
    users: asObj(data.users),
    customizations: asObj(data.customizations),
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(DB_FILE, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function dbReady() {
  const status = dbConnection?.getStatus?.();
  return Boolean(mongoose && status?.connected);
}

function ensureModels() {
  if (!dbReady()) return false;
  if (UserBattleRhythmModel && RecipeCustomizationModel) return true;

  const userBattleRhythmSchema = new mongoose.Schema(
    {
      userId: { type: String, required: true, index: true, unique: true },
      profile: { type: Object, default: {} },
    },
    { timestamps: true, collection: "user_battle_rhythm" }
  );

  const recipeCustomizationSchema = new mongoose.Schema(
    {
      userId: { type: String, required: true, index: true },
      recipeId: { type: String, default: "" },
      fingerprint: { type: String, default: "" },
      override: { type: Object, default: {} },
    },
    { timestamps: true, collection: "recipe_customization" }
  );

  recipeCustomizationSchema.index({ userId: 1, recipeId: 1, fingerprint: 1 }, { unique: true });

  UserBattleRhythmModel =
    mongoose.models.UserBattleRhythm ||
    mongoose.model("UserBattleRhythm", userBattleRhythmSchema);
  RecipeCustomizationModel =
    mongoose.models.RecipeCustomization ||
    mongoose.model("RecipeCustomization", recipeCustomizationSchema);

  return true;
}

export async function getUserBattleRhythm(userId = "global") {
  const uid = normKey(userId) || "global";

  if (ensureModels()) {
    const doc = await UserBattleRhythmModel.findOne({ userId: uid }).lean();
    return asObj(doc?.profile);
  }

  const store = await readFileStore();
  return asObj(store.users?.[uid]?.profile);
}

export async function saveUserBattleRhythm(userId = "global", profile = {}) {
  const uid = normKey(userId) || "global";
  const safeProfile = asObj(profile);

  if (ensureModels()) {
    await UserBattleRhythmModel.findOneAndUpdate(
      { userId: uid },
      { $set: { profile: safeProfile } },
      { upsert: true, new: true }
    );
    return safeProfile;
  }

  const store = await readFileStore();
  store.users[uid] = {
    profile: safeProfile,
    updatedAt: new Date().toISOString(),
  };
  await writeFileStore(store);
  return safeProfile;
}

export async function listRecipeCustomizations(userId = "global") {
  const uid = normKey(userId) || "global";

  if (ensureModels()) {
    const docs = await RecipeCustomizationModel.find({ userId: uid }).lean();
    return docs.map((d) => ({
      userId: d.userId,
      recipeId: d.recipeId || "",
      fingerprint: d.fingerprint || "",
      override: asObj(d.override),
      updatedAt: d.updatedAt || null,
    }));
  }

  const store = await readFileStore();
  const rows = asObj(store.customizations?.[uid]);
  return Object.values(rows);
}

export async function upsertRecipeCustomization({
  userId = "global",
  recipeId = "",
  fingerprint = "",
  override = {},
} = {}) {
  const uid = normKey(userId) || "global";
  const rid = normKey(recipeId);
  const fp = normKey(fingerprint);
  if (!rid && !fp) {
    throw new Error("recipeId or fingerprint is required");
  }

  const payload = {
    userId: uid,
    recipeId: rid,
    fingerprint: fp,
    override: asObj(override),
    updatedAt: new Date().toISOString(),
  };

  if (ensureModels()) {
    await RecipeCustomizationModel.findOneAndUpdate(
      { userId: uid, recipeId: rid, fingerprint: fp },
      { $set: { override: payload.override } },
      { upsert: true, new: true }
    );
    return payload;
  }

  const store = await readFileStore();
  const key = `${rid}::${fp}`;
  store.customizations[uid] = asObj(store.customizations[uid]);
  store.customizations[uid][key] = payload;
  await writeFileStore(store);
  return payload;
}

export async function deleteRecipeCustomization({
  userId = "global",
  recipeId = "",
  fingerprint = "",
} = {}) {
  const uid = normKey(userId) || "global";
  const rid = normKey(recipeId);
  const fp = normKey(fingerprint);
  if (!rid && !fp) return false;

  if (ensureModels()) {
    const out = await RecipeCustomizationModel.deleteOne({
      userId: uid,
      recipeId: rid,
      fingerprint: fp,
    });
    return Number(out?.deletedCount || 0) > 0;
  }

  const store = await readFileStore();
  const key = `${rid}::${fp}`;
  if (!store.customizations?.[uid]?.[key]) return false;
  delete store.customizations[uid][key];
  await writeFileStore(store);
  return true;
}

export default {
  getUserBattleRhythm,
  saveUserBattleRhythm,
  listRecipeCustomizations,
  upsertRecipeCustomization,
  deleteRecipeCustomization,
};
