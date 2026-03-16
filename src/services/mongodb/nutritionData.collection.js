import mongoose from "mongoose";

function resolveRetentionDays() {
  const raw = Number(process.env.MONGO_RETENTION_NUTRITION_DAYS || 365);
  if (!Number.isFinite(raw) || raw <= 0) return 365;
  return Math.floor(raw);
}

function computeExpiresAt() {
  const days = resolveRetentionDays();
  const ttlMs = days * 24 * 60 * 60 * 1000;
  return new Date(Date.now() + ttlMs);
}

const NutritionDataSchema = new mongoose.Schema(
  {
    source: { type: String, required: true },
    itemKey: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    qualityScore: { type: Number, default: 0 },
    ingestedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: computeExpiresAt },
  },
  { collection: "nutrition_data" }
);

NutritionDataSchema.index({ source: 1, itemKey: 1 }, { unique: true });
NutritionDataSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const NutritionData =
  mongoose.models.NutritionData ||
  mongoose.model("NutritionData", NutritionDataSchema);

export default NutritionData;
