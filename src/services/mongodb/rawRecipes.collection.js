import mongoose from "mongoose";

function resolveRetentionDays() {
  const raw = Number(process.env.MONGO_RETENTION_RAW_RECIPES_DAYS || 365);
  if (!Number.isFinite(raw) || raw <= 0) return 365;
  return Math.floor(raw);
}

function computeExpiresAt() {
  const days = resolveRetentionDays();
  const ttlMs = days * 24 * 60 * 60 * 1000;
  return new Date(Date.now() + ttlMs);
}

const RawRecipeSchema = new mongoose.Schema(
  {
    source: { type: String, required: true },
    externalId: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    tags: { type: [String], default: [] },
    ingestedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: computeExpiresAt },
  },
  { collection: "raw_recipes" }
);

RawRecipeSchema.index({ source: 1, externalId: 1 }, { unique: true });
RawRecipeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RawRecipes =
  mongoose.models.RawRecipes || mongoose.model("RawRecipes", RawRecipeSchema);

export default RawRecipes;
