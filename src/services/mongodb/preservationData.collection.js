import mongoose from "mongoose";

function resolveRetentionDays() {
  const raw = Number(process.env.MONGO_RETENTION_PRESERVATION_SNAPSHOT_DAYS || 180);
  if (!Number.isFinite(raw) || raw <= 0) return 180;
  return Math.floor(raw);
}

function computeExpiresAt() {
  const days = resolveRetentionDays();
  const ttlMs = days * 24 * 60 * 60 * 1000;
  return new Date(Date.now() + ttlMs);
}

const PreservationDataSchema = new mongoose.Schema(
  {
    householdId: { type: String, required: true },
    lotId: { type: String, required: true },
    method: { type: String, required: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    prepTimeReductionPct: { type: Number, default: 0 },
    notes: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: computeExpiresAt },
  },
  { collection: "preservation_data" }
);

PreservationDataSchema.index({ householdId: 1, lotId: 1 }, { unique: true });
PreservationDataSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PreservationData =
  mongoose.models.PreservationData ||
  mongoose.model("PreservationData", PreservationDataSchema);

export default PreservationData;
