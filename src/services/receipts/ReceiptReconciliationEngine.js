// src/services/receipts/ReceiptReconciliationEngine.js
// -----------------------------------------------------------------------------
// ReceiptReconciliationEngine
// - Fuzzy match scanned shopping candidates to receipt items
// - Handles multipacks, weight items, store abbreviations, taxes/discounts
//
// Inputs:
//   { receipt: { lineItems }, candidates: [...] }
//
// Output:
//   {
//     matches: [{ candidateId, receiptLineNo, receiptName, receiptQty, receiptUnit, receiptTotal, score, reasons[] }],
//     unmatchedReceiptItems: [...],
//     unmatchedCandidates: [...]
//   }
//
// NOTE: This is pure logic (no DB). ReceiptIngestService persists results.
// -----------------------------------------------------------------------------

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s) {
  return norm(s)
    .split(" ")
    .filter((t) => t.length > 2);
}

function jaccard(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

function levenshtein(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  const n = s.length;
  const m = t.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[n][m];
}

function similarity(a, b) {
  const A = norm(a);
  const B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const jac = jaccard(A, B);
  const lev = levenshtein(A, B);
  const maxLen = Math.max(A.length, B.length) || 1;
  const levSim = 1 - lev / maxLen;
  // Blend: jaccard favors shared keywords; lev favors close strings
  return Math.max(0, Math.min(1, jac * 0.65 + levSim * 0.35));
}

/* ---------------- multipack + unit helpers ---------------- */
function parsePackSize(name) {
  const s = norm(name);
  // "12pk" "12 pk" "pack of 12" "12 count"
  let m = s.match(/\b(\d{1,3})\s*(pk|pack)\b/);
  if (m) return Number(m[1]);
  m = s.match(/\bpack\s*of\s*(\d{1,3})\b/);
  if (m) return Number(m[1]);
  m = s.match(/\b(\d{1,3})\s*(ct|count)\b/);
  if (m) return Number(m[1]);
  return null;
}

function isWeightUnit(u) {
  const x = String(u || "").toLowerCase();
  return ["lb", "lbs", "oz", "g", "kg"].includes(x);
}

function qtyClose(a, b) {
  const A = Number(a);
  const B = Number(b);
  if (!Number.isFinite(A) || !Number.isFinite(B)) return 0;
  if (A === B) return 1;
  // allow small tolerance for weight rounding
  const diff = Math.abs(A - B);
  const denom = Math.max(1e-6, Math.max(A, B));
  const rel = diff / denom;
  if (rel <= 0.03) return 0.85;
  if (rel <= 0.08) return 0.6;
  if (rel <= 0.15) return 0.35;
  return 0;
}

function priceClose(a, b) {
  const A = Number(a);
  const B = Number(b);
  if (!Number.isFinite(A) || !Number.isFinite(B)) return 0;
  const diff = Math.abs(A - B);
  if (diff <= 0.01) return 1;
  if (diff <= 0.1) return 0.85;
  if (diff <= 0.35) return 0.55;
  if (diff <= 0.75) return 0.3;
  return 0;
}

function upcMatch(cUpc, rUpc) {
  const A = String(cUpc || "").trim();
  const B = String(rUpc || "").trim();
  if (!A || !B) return 0;
  if (A === B) return 1;
  // allow last-12 match (some receipts drop leading digits)
  if (A.length >= 12 && B.length >= 12 && A.slice(-12) === B.slice(-12))
    return 0.95;
  return 0;
}

function storeAbbrevBoost(storeId, candidate, receiptItem) {
  // Hook: if you later add store-specific abbreviation maps, do it here.
  // For now, tiny boost if candidate.storeId aligns
  if (!storeId) return 0;
  const cStore = String(candidate?.storeId || candidate?.store || "");
  if (cStore && String(storeId) === cStore) return 0.05;
  // receipts sometimes have shorthand names; no reliable mapping in pure engine
  return 0;
}

/* ------------------------------ engine ------------------------------------ */
export class ReceiptReconciliationEngine {
  static reconcile({ receipt, candidates, options = {} } = {}) {
    const lineItems = Array.isArray(receipt?.lineItems)
      ? receipt.lineItems
      : [];
    const cand = Array.isArray(candidates) ? candidates : [];
    const storeId = options.storeId || receipt?.storeId || null;
    const allowCrossStore = !!options.allowCrossStore;
    const scoreThreshold = Number.isFinite(options.scoreThreshold)
      ? options.scoreThreshold
      : 0.55;

    // prepare lists
    const receiptItems = lineItems
      .map((it) => ({
        lineNo: it.lineNo ?? it.line ?? null,
        name: it.name || it.description || it.raw || "",
        qty: it.qty ?? 1,
        unit: it.unit || "ea",
        isWeight: !!it.isWeight || isWeightUnit(it.unit),
        totalPrice: it.totalPrice ?? it.total ?? null,
        unitPrice: it.unitPrice ?? it.priceEach ?? null,
        upcLike: it.upcLike || it.upc || null,
        raw: it.raw || "",
      }))
      .filter((it) => it.name);

    const candidatesNorm = cand
      .map((c) => ({
        ...c,
        _id: String(c.id || c.candidateId || c.upc || ""),
        _name: c.name || c.title || c.productName || "",
        _brand: c.brand || "",
        _upc: c.upc || c.barcode || null,
        _qty: c.qty ?? c.quantity ?? 1,
        _unit: c.unit || "ea",
        _isWeight: !!c.isWeight || isWeightUnit(c.unit),
        _store: c.storeId || c.store || null,
        _ts: c.ts || c.createdAt || null,
      }))
      .filter((c) => c._id);

    // greedy bipartite match: best score per candidate, then resolve collisions by score
    const scoredPairs = [];
    for (const c of candidatesNorm) {
      for (const r of receiptItems) {
        if (
          !allowCrossStore &&
          storeId &&
          c._store &&
          String(c._store) !== String(storeId)
        ) {
          // still allow if candidate store missing
          continue;
        }
        const scoreRec = scoreCandidateToReceiptItem(c, r, storeId);
        if (scoreRec.score >= scoreThreshold) scoredPairs.push(scoreRec);
      }
    }

    scoredPairs.sort((a, b) => b.score - a.score);

    const usedCandidates = new Set();
    const usedReceiptLines = new Set();
    const matches = [];

    for (const s of scoredPairs) {
      const cId = String(s.candidateId);
      const rLine = String(s.receiptLineNo);
      if (usedCandidates.has(cId)) continue;
      if (usedReceiptLines.has(rLine)) continue;
      usedCandidates.add(cId);
      usedReceiptLines.add(rLine);
      matches.push({
        candidateId: s.candidateId,
        receiptLineNo: s.receiptLineNo,
        receiptName: s.receiptName,
        receiptQty: s.receiptQty,
        receiptUnit: s.receiptUnit,
        receiptTotal: s.receiptTotal,
        score: s.score,
        reasons: s.reasons,
      });
    }

    const matchedReceiptLineNos = new Set(
      matches.map((m) => String(m.receiptLineNo))
    );
    const matchedCandidateIds = new Set(
      matches.map((m) => String(m.candidateId))
    );

    const unmatchedReceiptItems = receiptItems.filter(
      (r) => !matchedReceiptLineNos.has(String(r.lineNo))
    );
    const unmatchedCandidates = candidatesNorm.filter(
      (c) => !matchedCandidateIds.has(String(c._id))
    );

    return { matches, unmatchedReceiptItems, unmatchedCandidates };
  }
}

/* ----------------------------- scoring core ------------------------------- */
function scoreCandidateToReceiptItem(c, r, storeId) {
  const reasons = [];

  // 1) UPC match dominates
  const upcScore = upcMatch(c._upc, r.upcLike);
  if (upcScore > 0) reasons.push(`upc:${upcScore.toFixed(2)}`);

  // 2) Name similarity
  const nameScore = similarity(`${c._brand} ${c._name}`, r.name);
  reasons.push(`name:${nameScore.toFixed(2)}`);

  // 3) Qty/unit alignment
  const pack = parsePackSize(c._name) || parsePackSize(r.name);
  let qtyScore = 0;
  if (pack && !c._isWeight && !r.isWeight) {
    // Candidate may represent a multipack; receipt might show single pack or expanded units
    // If candidate qty is 1 and receipt qty is 1, okay; otherwise check pack ratio heuristics.
    qtyScore = qtyClose(c._qty, r.qty) || 0;
    if (!qtyScore && Number.isFinite(r.qty) && Number.isFinite(pack)) {
      // if receipt qty equals pack size and candidate qty is 1, treat as match
      if (Number(c._qty) === 1 && Number(r.qty) === Number(pack))
        qtyScore = 0.65;
      // if candidate qty equals pack size and receipt qty is 1, also plausible
      if (Number(c._qty) === Number(pack) && Number(r.qty) === 1)
        qtyScore = 0.55;
    }
    reasons.push(`pack:${pack}`);
  } else {
    qtyScore = qtyClose(c._qty, r.qty);
  }
  if (qtyScore) reasons.push(`qty:${qtyScore.toFixed(2)}`);

  // 4) Unit compatibility (weight vs each)
  let unitScore = 0;
  const cW = !!c._isWeight || isWeightUnit(c._unit);
  const rW = !!r.isWeight || isWeightUnit(r.unit);
  if (cW === rW) unitScore = 0.15;
  if (cW && rW) unitScore = 0.25;
  if (!cW && !rW) unitScore = 0.15;
  reasons.push(`unit:${unitScore.toFixed(2)}`);

  // 5) Price alignment (if you captured scan-estimated totals)
  let priceScore = 0;
  const cTotal = c.totalPrice ?? c.priceTotal ?? c.price ?? null;
  if (cTotal != null && r.totalPrice != null) {
    priceScore = priceClose(cTotal, r.totalPrice) * 0.35;
    if (priceScore) reasons.push(`price:${priceScore.toFixed(2)}`);
  }

  // 6) Store boost
  const storeBoost = storeAbbrevBoost(storeId, c, r);
  if (storeBoost) reasons.push(`store:${storeBoost.toFixed(2)}`);

  // combine
  // weights: UPC strongest; name next; qty/unit moderate; price minor; store tiny
  const score =
    upcScore * 0.55 +
    nameScore * 0.3 +
    qtyScore * 0.1 +
    unitScore * 0.05 +
    priceScore +
    storeBoost;

  return {
    candidateId: String(c._id),
    receiptLineNo: r.lineNo,
    receiptName: r.name,
    receiptQty: r.qty,
    receiptUnit: r.unit,
    receiptTotal: r.totalPrice ?? null,
    score: Math.max(0, Math.min(1, score)),
    reasons,
  };
}
