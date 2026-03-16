/**
 * src/agents/skills/inventory/substitutionsInventoryCheck.js
 *
 * How this fits:
 * - Used by cooking (and potentially cleaning/preservation) agents to verify
 *   whether proposed substitutions are actually available in the household
 *   inventory.
 *
 * - Typical flow:
 *   1) cooking/substitutions.js proposes candidates for "buttermilk" →
 *      [{ name:"milk", factor:0.75, notes:"+ acid"}, ...]
 *   2) substitutionsInventoryCheck.verifySubstitutions(...) checks the pantry
 *      via inventory.lookup and reports which candidates are feasible.
 *   3) Session composer chooses the best available substitution and
 *      updates session.steps + metadata.adjustments.
 *
 * - This file DOES NOT mutate inventory; it's read-only.
 *   Reservation/decrement is handled by inventory.reserveAndDecrement.js.
 *
 * Events emitted:
 *   - inventory.substitution.check.performed
 */

import { emit } from "@/services/events/eventBus";
import InventoryLookup from "@/agents/skills/inventory/lookup";

/**
 * @typedef {Object} IngredientSpec
 * @property {string} name
 * @property {number} [qty]
 * @property {string} [unit]
 */

/**
 * @typedef {Object} SubstitutionCandidate
 * @property {string} name                - Substitute ingredient name (e.g. "milk")
 * @property {number} [factor]            - Multiplier vs original qty (e.g. 0.75)
 * @property {string} [unit]              - Override unit if different
 * @property {string} [type]              - "direct" | "compound" | "flavor" | etc.
 * @property {string} [notes]             - Human-readable explanation
 * @property {any}    [metadata]          - Free-form metadata (source, flags)
 */

/**
 * @typedef {Object} VerifiedCandidate
 * @property {SubstitutionCandidate} candidate
 * @property {any|null} inventoryItem
 * @property {number} requiredQty        - quantity needed in inventory units
 * @property {number} availableQty       - quantity found in inventory
 * @property {number} coverageRatio      - 0..1 (available / required)
 * @property {boolean} sufficient        - coverageRatio >= minCoverageThreshold
 */

/**
 * @typedef {Object} VerifyOptions
 * @property {number} [desiredQty]           - override original qty
 * @property {string} [unit]                 - override original unit
 * @property {string} [domain]               - inventory domain (default "cooking")
 * @property {number} [minCoverageThreshold] - default 0.75 (75% of required)
 * @property {number} [limitPerCandidate]    - default 5
 */

/**
 * Verify a set of substitution candidates against inventory.
 *
 * - Does NOT mutate inventory.
 * - Uses inventory.lookup lookupByName to see if the pantry has enough of
 *   each candidate.
 *
 * @param {IngredientSpec} originalIngredient
 * @param {SubstitutionCandidate[]} candidates
 * @param {VerifyOptions} [options]
 * @returns {Promise<{
 *   ingredient: IngredientSpec,
 *   desiredQty: number,
 *   unit: string|null,
 *   candidates: VerifiedCandidate[],
 *   best: VerifiedCandidate|null,
 *   sufficient: boolean,
 *   anyAvailable: boolean
 * }>}
 */
export async function verifySubstitutions(
  originalIngredient,
  candidates,
  options = {}
) {
  const ingredient = normalizeIngredient(originalIngredient);
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];

  const {
    desiredQty = ingredient.qty || 0,
    unit = ingredient.unit || null,
    domain = "cooking",
    minCoverageThreshold = 0.75,
    limitPerCandidate = 5,
  } = options;

  /** @type {VerifiedCandidate[]} */
  const verified = [];

  if (!ingredient.name || !list.length) {
    const result = {
      ingredient,
      desiredQty,
      unit,
      candidates: [],
      best: null,
      sufficient: false,
      anyAvailable: false,
    };
    emitCheckEvent("inventory.substitution.check.performed", result);
    return result;
  }

  for (const candidate of list) {
    const vc = await verifySingleCandidate(
      ingredient,
      candidate,
      desiredQty,
      unit,
      {
        domain,
        minCoverageThreshold,
        limitPerCandidate,
      }
    );
    verified.push(vc);
  }

  // Determine best:
  // 1) highest coverageRatio
  // 2) tie-breaker: candidate.factor closest to 1
  let best = null;
  for (const v of verified) {
    if (!v.inventoryItem) continue;

    if (!best) {
      best = v;
      continue;
    }

    if (v.coverageRatio > best.coverageRatio) {
      best = v;
      continue;
    }

    if (v.coverageRatio === best.coverageRatio) {
      const fCur =
        typeof v.candidate.factor === "number" ? v.candidate.factor : 1;
      const fBest =
        typeof best.candidate.factor === "number" ? best.candidate.factor : 1;
      if (Math.abs(fCur - 1) < Math.abs(fBest - 1)) {
        best = v;
      }
    }
  }

  const anyAvailable = verified.some((v) => v.inventoryItem);
  const sufficient = verified.some((v) => v.sufficient);

  const result = {
    ingredient,
    desiredQty,
    unit,
    candidates: verified,
    best,
    sufficient,
    anyAvailable,
  };

  emitCheckEvent("inventory.substitution.check.performed", {
    ingredient: ingredient.name,
    desiredQty,
    unit,
    candidateCount: list.length,
    anyAvailable,
    sufficient,
  });

  return result;
}

/**
 * Convenience helper:
 * Returns only the "best" verified candidate (or null).
 *
 * @param {IngredientSpec} originalIngredient
 * @param {SubstitutionCandidate[]} candidates
 * @param {VerifyOptions} [options]
 * @returns {Promise<VerifiedCandidate|null>}
 */
export async function verifyBestSubstitution(
  originalIngredient,
  candidates,
  options = {}
) {
  const res = await verifySubstitutions(
    originalIngredient,
    candidates,
    options
  );
  return res.best;
}

/* ------------------------------ Internals ---------------------------------- */

/**
 * @param {IngredientSpec} ing
 * @returns {IngredientSpec}
 */
function normalizeIngredient(ing) {
  if (!ing || typeof ing !== "object") {
    return { name: "", qty: 0, unit: null };
  }
  return {
    name: cleanSpace(ing.name || ""),
    qty: Number(ing.qty || 0) || 0,
    unit: ing.unit || null,
  };
}

/**
 * Verify a single candidate substitution against inventory.
 *
 * @param {IngredientSpec} original
 * @param {SubstitutionCandidate} candidate
 * @param {number} desiredQty
 * @param {string|null} unit
 * @param {{domain:string, minCoverageThreshold:number, limitPerCandidate:number}} ctx
 * @returns {Promise<VerifiedCandidate>}
 */
async function verifySingleCandidate(
  original,
  candidate,
  desiredQty,
  unit,
  ctx
) {
  const factor =
    typeof candidate.factor === "number" && candidate.factor > 0
      ? candidate.factor
      : 1;

  const requiredQty = desiredQty * factor;

  // For now we assume units are compatible. Later you can add a unit
  // conversion table here (e.g., cups ↔ grams) and per-ingredient density.
  const requiredUnit = candidate.unit || unit || null;

  const rows = await InventoryLookup.lookupByName(candidate.name, {
    domain: ctx.domain,
    limit: ctx.limitPerCandidate,
  });

  // Choose "best" inventory item for the candidate:
  // simplest heuristic: highest quantity.
  let inventoryItem = null;
  let availableQty = 0;

  if (rows && rows.length) {
    inventoryItem = rows.reduce((a, b) => {
      const qa = Number(a.quantity || 0);
      const qb = Number(b.quantity || 0);
      return qb > qa ? b : a;
    }, rows[0]);
    availableQty = Number(inventoryItem.quantity || 0);
  }

  const coverageRatio =
    requiredQty > 0 ? clamp(availableQty / requiredQty, 0, 1) : 0;

  const sufficient = coverageRatio >= ctx.minCoverageThreshold;

  return {
    candidate,
    inventoryItem,
    requiredQty,
    availableQty,
    coverageRatio,
    sufficient,
  };
}

/* --------------------------------- Events ---------------------------------- */

function emitCheckEvent(type, data) {
  try {
    emit?.({
      type,
      ts: new Date().toISOString(),
      source: "inventory.substitutionsInventoryCheck",
      data,
    });
  } catch {
    // ignore
  }
}

/* --------------------------------- Utils ----------------------------------- */

function cleanSpace(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/* --------------------------------- Export ---------------------------------- */

export default {
  verifySubstitutions,
  verifyBestSubstitution,
};
