// src/features/shopping/services/ShoppingEvaluator.js
// Minimal, safe default implementation so automation/runtime can load Shopping mode.
// You can expand this later to call pricing/coupons/recalls/ingredients + store-compare.

function normalizeText(s) {
  return String(s || "").trim();
}

function safeNumber(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

function toLower(s) {
  return normalizeText(s).toLowerCase();
}

/**
 * Candidate shape SSA will commonly use:
 * {
 *   id, createdAt,
 *   name, brand,
 *   upc, sku,
 *   storeId, storeName,
 *   price, unitPrice, size,
 *   ingredientsText,
 *   receiptId (null until receipt arrives),
 *   status: "draft"|"waiting_receipt"|"reconciled"
 * }
 */

const ShoppingEvaluator = {
  /**
   * Evaluate a shopping candidate *without committing to household inventory*.
   * Returns a normalized/enriched candidate + warnings/hints.
   */
  async evaluateCandidate(candidate = {}, ctx = {}) {
    const now = new Date().toISOString();

    const name = normalizeText(candidate.name);
    const brand = normalizeText(candidate.brand);
    const upc = normalizeText(candidate.upc);
    const storeId = normalizeText(candidate.storeId);
    const storeName = normalizeText(candidate.storeName);

    const price = safeNumber(candidate.price);
    const unitPrice = safeNumber(candidate.unitPrice);

    const ingredientsText = normalizeText(candidate.ingredientsText);
    const ingredientsLower = toLower(ingredientsText);

    const warnings = [];
    const hints = [];

    // Basic validation hints
    if (!name && !upc)
      warnings.push({
        code: "missing_identity",
        message: "Missing item name and UPC.",
      });
    if (!storeId && !storeName)
      hints.push({
        code: "missing_store",
        message: "No store selected for this candidate.",
      });
    if (price == null)
      hints.push({
        code: "missing_price",
        message: "No price captured yet (waiting for shelf tag or receipt).",
      });

    // Simple ingredient flags (placeholder; wire to your real rules later)
    const ingredientFlags = [];
    if (ingredientsLower.includes("high fructose corn syrup"))
      ingredientFlags.push("hfcs");
    if (
      ingredientsLower.includes("red 40") ||
      ingredientsLower.includes("red #40")
    )
      ingredientFlags.push("red40");
    if (
      ingredientsLower.includes("yellow 5") ||
      ingredientsLower.includes("yellow #5")
    )
      ingredientFlags.push("yellow5");
    if (
      ingredientsLower.includes("monosodium glutamate") ||
      ingredientsLower.includes(" msg ")
    )
      ingredientFlags.push("msg");

    if (ingredientFlags.length) {
      hints.push({
        code: "ingredient_flags",
        message: "Ingredient flags detected (placeholder rules).",
        flags: ingredientFlags,
      });
    }

    // Receipt gating logic (your core requirement)
    const receiptId = normalizeText(candidate.receiptId);
    const status = receiptId
      ? "reconciled"
      : normalizeText(candidate.status) || "waiting_receipt";

    const enriched = {
      ...candidate,
      name,
      brand,
      upc,
      storeId,
      storeName,
      price,
      unitPrice,
      ingredientsText,
      status,
      updatedAt: now,
      // room for later integrations:
      comparisons: candidate.comparisons || [], // other stores (physical) comparisons
      coupons: candidate.coupons || [], // matched coupons
      recalls: candidate.recalls || [], // recall matches
      nutrition: candidate.nutrition || null, // if present
      ingredientFlags,
    };

    return {
      ok: true,
      enriched,
      warnings,
      hints,
      meta: {
        evaluatedAt: now,
        mode: "shopping",
        source: ctx.source || "automation",
      },
    };
  },

  /**
   * Optional helper: compute KPIs for home page / dashboards.
   * Input: list of candidates + list of receipts (or reconciliation records).
   */
  computeKpis({ candidates = [], receipts = [] } = {}) {
    const waitingReceipt = candidates.filter(
      (c) => !c?.receiptId && (c?.status === "waiting_receipt" || !c?.status)
    ).length;

    // “Receipts pending reconciliation” can mean: receipts exist but not linked/processed
    // This is a placeholder definition until your receipt reconciliation tables are finalized.
    const receiptIdsLinked = new Set(
      candidates.map((c) => c?.receiptId).filter(Boolean)
    );
    const receiptsPending = receipts.filter(
      (r) =>
        r &&
        !receiptIdsLinked.has(r.id) &&
        (r.status === "pending" || !r.status)
    ).length;

    return {
      shoppingCandidatesWaitingForReceipt: waitingReceipt,
      receiptsPendingReconciliation: receiptsPending,
    };
  },
};

export default ShoppingEvaluator;
export { ShoppingEvaluator };
