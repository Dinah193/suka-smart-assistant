export function estimatePreservationYield({ qty = 0, lossPct = 0.08, method = "canning" } = {}) {
  const safeQty = Math.max(0, Number(qty || 0));
  const safeLoss = Math.max(0, Math.min(0.9, Number(lossPct || 0)));
  const preservedQty = safeQty * (1 - safeLoss);

  return {
    method,
    inputQty: safeQty,
    preservedQty: Number(preservedQty.toFixed(2)),
    lossPct: safeLoss,
    prepReductionPct: method === "batch-cooked" ? 0.35 : 0.2,
  };
}

export default { estimatePreservationYield };
