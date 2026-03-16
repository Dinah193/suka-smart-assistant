function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundToStep(value, step) {
  const s = toNum(step, 0);
  if (s <= 0) return value;
  return Math.round(value / s) * s;
}

function applyRounding(value, rounding = {}) {
  const mode = String(rounding.mode || "none");
  const step = toNum(rounding.step, 0);
  if (mode === "none") return value;
  if (mode === "decimal") return step > 0 ? roundToStep(value, step) : Number(value.toFixed(2));
  if (mode === "fraction") {
    const fractionStep = step > 0 ? step : 0.25;
    return roundToStep(value, fractionStep);
  }
  return value;
}

export function scaleRecipe(config = {}) {
  const rawBaseServings = toNum(config.baseServings, 1);
  const rawTargetServings = toNum(config.targetServings, rawBaseServings);
  if (rawBaseServings <= 0 || rawTargetServings <= 0) {
    throw new Error("invalid_servings");
  }

  const baseServings = rawBaseServings;
  const targetServings = rawTargetServings;
  const scaleFactor = targetServings / baseServings;
  const ingredients = Array.isArray(config.ingredients)
    ? config.ingredients.filter((x) => x && typeof x === "object")
    : [];

  const out = ingredients.map((ing = {}) => {
    const originalQuantity = Math.max(toNum(ing.quantity, 0), 0);
    const scaleLock = !!ing.scaleLock;
    let quantity = scaleLock ? originalQuantity : originalQuantity * scaleFactor;

    if (Number.isFinite(ing.minQty)) quantity = Math.max(quantity, toNum(ing.minQty, quantity));
    if (Number.isFinite(ing.maxQty)) quantity = Math.min(quantity, toNum(ing.maxQty, quantity));

    const mode = String(config.scalingMode || "linear");
    if (mode === "ceiling") quantity = Math.ceil(quantity);
    if (mode === "floor") quantity = Math.floor(quantity);

    quantity = applyRounding(quantity, config.rounding || {});

    return {
      id: ing.id,
      name: String(ing.name || ""),
      unit: String(ing.unit || "unit"),
      quantity,
      originalQuantity,
      minQty: Number.isFinite(ing.minQty) ? toNum(ing.minQty) : undefined,
      maxQty: Number.isFinite(ing.maxQty) ? toNum(ing.maxQty) : undefined,
      scaleLock,
      notes: [],
    };
  });

  return {
    baseServings,
    targetServings,
    scaleFactor,
    ingredients: out,
    warnings: [],
    notes: [],
  };
}

export default {
  scaleRecipe,
};
