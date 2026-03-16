function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(value, fallback) {
  const n = toNum(value, fallback);
  return Math.max(0, Math.min(1, n));
}

function speciesDefaultDressing(species) {
  const s = String(species || "").toLowerCase();
  if (s === "beef") return 0.6;
  if (s === "pork") return 0.72;
  if (s === "lamb" || s === "goat") return 0.5;
  if (s === "poultry") return 0.7;
  return 0.55;
}

function normalizeCutPlan(cutPlan = {}) {
  const raw = {
    steaksPct: Math.max(0, toNum(cutPlan.steaksPct, 0.35)),
    roastsPct: Math.max(0, toNum(cutPlan.roastsPct, 0.25)),
    stewPct: Math.max(0, toNum(cutPlan.stewPct, 0.25)),
    organsPct: Math.max(0, toNum(cutPlan.organsPct, 0.1)),
  };
  const total = raw.steaksPct + raw.roastsPct + raw.stewPct + raw.organsPct;
  if (total <= 0) return { ...raw, total: 1 };
  return {
    steaksPct: raw.steaksPct / total,
    roastsPct: raw.roastsPct / total,
    stewPct: raw.stewPct / total,
    organsPct: raw.organsPct / total,
    total,
  };
}

export function calculateMeatBreakdown(config = {}) {
  const warnings = [];
  const species = String(config.species || "unknown").toLowerCase();
  const unit = String(config.unit || "lb").toLowerCase();
  let liveWeightLb = Math.max(toNum(config.liveWeightLb, 0), 0);
  if (unit === "kg") liveWeightLb *= 2.20462;

  const dressingPct = clamp01(config.dressingPct, speciesDefaultDressing(species));
  const hangingLossPct = clamp01(config.hangingLossPct, 0.02);
  const bonePct = clamp01(config.bonePct, 0.17);
  const fatTrimPct = clamp01(config.fatTrimPct, 0.1);
  const grindPct = clamp01(config.grindPct, 0.25);

  const carcassWeightLb = liveWeightLb * dressingPct;
  const postHangLb = carcassWeightLb * (1 - hangingLossPct);
  const boneWeightLb = postHangLb * bonePct;
  const fatTrimLb = postHangLb * fatTrimPct;
  const bonelessYieldLb = Math.max(postHangLb - boneWeightLb - fatTrimLb, 0);

  const plan = normalizeCutPlan(config.cutPlan || {});
  if (plan.total > 1.001) warnings.push("cutPlan sum > 1, normalized");

  const preCutLb = bonelessYieldLb * (1 - grindPct);
  const grindLb = bonelessYieldLb * grindPct;
  const steaksLb = preCutLb * plan.steaksPct;
  const roastsLb = preCutLb * plan.roastsPct;
  const stewLb = preCutLb * plan.stewPct;
  const organsLb = preCutLb * plan.organsPct;

  const totalPackagedLb = grindLb + steaksLb + roastsLb + stewLb + organsLb;
  const yieldPctOfLive = liveWeightLb > 0 ? (totalPackagedLb / liveWeightLb) * 100 : 0;

  return {
    species,
    liveWeightLb,
    carcassWeightLb,
    bonelessYieldLb,
    boneWeightLb,
    fatTrimLb,
    grindLb,
    steaksLb,
    roastsLb,
    stewLb,
    organsLb,
    totalPackagedLb,
    yieldPctOfLive,
    factors: {
      dressingPct,
      hangingLossPct,
      bonePct,
      fatTrimPct,
      grindPct,
      normalizedCutPlan: {
        steaksPct: plan.steaksPct,
        roastsPct: plan.roastsPct,
        stewPct: plan.stewPct,
        organsPct: plan.organsPct,
      },
    },
    warnings,
  };
}

export default {
  calculateMeatBreakdown,
};
