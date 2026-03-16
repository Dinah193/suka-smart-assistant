"use strict";

let mongoose = null;
try {
  mongoose = require("mongoose");
} catch {
  mongoose = null;
}

let dbConnection = null;
try {
  dbConnection = require("../../services/dbConnection.js");
} catch {
  dbConnection = null;
}

let NutritionRecordModel = null;

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/s$/, "");
}

function isConnected() {
  const status = dbConnection?.getStatus?.();
  return Boolean(mongoose && status?.connected);
}

async function ensureConnected() {
  if (!mongoose || !dbConnection?.init) return false;
  if (isConnected()) return true;

  try {
    await dbConnection.init();
  } catch {
    // caller handles unavailable DB as miss/error contract
  }

  return isConnected();
}

function ensureModel() {
  if (!mongoose) return false;
  if (NutritionRecordModel) return true;

  const schema = new mongoose.Schema(
    {
      id: { type: String, required: true, unique: true, index: true },
      normalizedName: { type: String, required: true, index: true },
      displayName: { type: String, default: "" },
      source: { type: String, default: "" },
      macros: { type: Object, default: {} },
      micros: { type: Object, default: {} },
      lastUpdated: { type: String, default: "" },
      meta: { type: Object, default: {} },
    },
    { timestamps: true, collection: "nutrition_records" }
  );

  schema.index({ normalizedName: 1 });

  NutritionRecordModel =
    mongoose.models.NutritionRecord ||
    mongoose.model("NutritionRecord", schema);

  return true;
}

function toPlain(doc) {
  if (!doc) return null;
  return {
    id: String(doc.id || "").trim(),
    normalizedName: String(doc.normalizedName || "").trim(),
    displayName: String(doc.displayName || "").trim(),
    source: String(doc.source || "").trim(),
    macros: doc.macros && typeof doc.macros === "object" ? doc.macros : {},
    micros: doc.micros && typeof doc.micros === "object" ? doc.micros : {},
    lastUpdated: String(doc.lastUpdated || "").trim(),
    meta: doc.meta && typeof doc.meta === "object" ? doc.meta : {},
  };
}

async function getById(id) {
  const key = String(id || "").trim();
  if (!key) return { ok: true, data: null };
  if (!(await ensureConnected()) || !ensureModel()) return { ok: true, data: null };

  const doc = await NutritionRecordModel.findOne({ id: key }).lean();
  return { ok: true, data: toPlain(doc) };
}

async function getByName(name) {
  const normalized = normalizeName(name);
  if (!normalized) return { ok: true, data: null };
  if (!(await ensureConnected()) || !ensureModel()) return { ok: true, data: null };

  const doc = await NutritionRecordModel.findOne({ normalizedName: normalized }).lean();
  return { ok: true, data: toPlain(doc) };
}

async function upsert(doc = {}) {
  const normalized = normalizeName(doc?.normalizedName || doc?.displayName || doc?.name || "");
  if (!normalized) {
    return { ok: false, error: "normalizedName_required" };
  }

  if (!(await ensureConnected()) || !ensureModel()) {
    return { ok: false, error: "mongo_unavailable" };
  }

  const payload = {
    id: String(doc?.id || `food:${normalized}`).trim(),
    normalizedName: normalized,
    displayName: String(doc?.displayName || normalized).trim(),
    source: String(doc?.source || "").trim(),
    macros: doc?.macros && typeof doc.macros === "object" ? doc.macros : {},
    micros: doc?.micros && typeof doc.micros === "object" ? doc.micros : {},
    lastUpdated: String(doc?.lastUpdated || new Date().toISOString()),
    meta: doc?.meta && typeof doc.meta === "object" ? doc.meta : {},
  };

  const out = await NutritionRecordModel.findOneAndUpdate(
    { id: payload.id },
    { $set: payload },
    { upsert: true, returnDocument: "after", lean: true }
  );

  return { ok: true, id: payload.id, data: toPlain(out) };
}

module.exports = {
  getById,
  getByName,
  upsert,
};
