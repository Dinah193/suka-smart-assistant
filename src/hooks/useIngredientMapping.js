// useIngredientMapping.js
// Hook to map recipe ingredients to internal inventory/garden/animal/bulk items
// ES2015-safe, dependency-light, with DI factory and graceful fallbacks.

import { useCallback, useMemo, useRef, useState } from "react";

/**
 * createIngredientMapping
 * Optional dependency injection for testing/SSR and to prevent crashes.
 *
 * @param {Object} deps
 *  - normalizer: {
 *      tokenizeName?(str): string[],                       // e.g., ["boneless","skinless","chicken","thighs"]
 *      parseQtyUnit?(ing): { qty:number, unit:string },    // normalize qty+unit (g, ml, tbsp, cup, etc.)
 *      toBaseUnit?(qty, unit, sku): { qty:number, unit:string }, // convert to inventory base unit for sku
 *      canonicalName?(str): string                         // lowercased, trimmed, no punctuation
 *    }
 *  - inventory: {
 *      searchSkus?(queryTokens): Array<{id,name,aliases:string[], baseUnit:string, aisle?:string, haveQty?:number}>,
 *      has?(skuId): boolean,
 *      estimateShortage?(skuId, needQtyBase): { have:number, short:number },
 *      linkUsage?(skuId, qtyBase, meta): void,             // reserve/commit later in flow
 *      suggestSub?(skuIdOrName): Array<{id,name,reason?:string}>
 *    }
 *  - sources: {
 *      garden?: { findByProduce?(nameTokens): Array<{id,name,yieldUnit?:string, aisle?:string}> },
 *      animal?: { findByCut?(nameTokens): Array<{id,name,yieldUnit?:string, aisle?:string}> },
 *      bulk?:   { search?(nameTokens): Array<{id,name,packUnit?:string, aisle?:string, pricePerUnit?:number}> }
 *    }
 *  - aisleService: { group?(skuOrName): string }           // maps to aisle group name
 *  - rulesStore: {
 *      get?(key): any, set?(key, value): void,             // general storage
 *      getAliasMap?(): Record<string, string>,             // "scallion" -> "green onion"
 *      setAlias?(from, to): void,
 *      getPinnedSku?(canonicalName): string|null,
 *      setPinnedSku?(canonicalName, skuId): void
 *    }
 *  - estimateEngine: { costForSku?(skuId, qtyBase): { total:number, currency:string } }
 *  - substitutions: { forName?(canonicalName): Array<{name, note?:string}> }
 *  - allergens: { detect?(canonicalName): string[] }       // returns allergen tags
 *  - eventBus: { emit(evt, payload):void }
 *  - analytics: { track(evt, payload):void }
 *  - config: { get(path, fallback): any }
 */
export function createIngredientMapping(deps = {}) {
  const normalizer = deps.normalizer || {
    tokenizeName: function (s) {
      return String(s || "")
        .toLowerCase()
        .replace(/[\(\),]/g, " ")
        .split(/\s+/)
        .filter(Boolean);
    },
    parseQtyUnit: function (ing) {
      // naive fallback; expect a richer normalizer present in project
      const qty = Number(ing.qty || 1) || 1;
      const unit = String(ing.unit || "").toLowerCase();
      return { qty, unit };
    },
    toBaseUnit: function (qty, unit /*, sku */) { return { qty, unit: unit || "" }; },
    canonicalName: function (s) { return String(s || "").toLowerCase().trim(); },
  };

  const inventory = deps.inventory || {
    searchSkus: function () { return []; },
    has: function () { return false; },
    estimateShortage: function () { return { have: 0, short: 0 }; },
    linkUsage: function () {},
    suggestSub: function () { return []; },
  };

  const sources = deps.sources || {
    garden: { findByProduce: function () { return []; } },
    animal: { findByCut: function () { return []; } },
    bulk:   { search: function () { return []; } },
  };

  const aisleService   = deps.aisleService   || { group: function () { return "General"; } };
  const rulesStore     = deps.rulesStore     || {
    get: function () { return null; },
    set: function () {},
    getAliasMap: function () { return {}; },
    setAlias: function () {},
    getPinnedSku: function () { return null; },
    setPinnedSku: function () {},
  };
  const estimateEngine = deps.estimateEngine || { costForSku: function () { return null; } };
  const substitutions  = deps.substitutions  || { forName: function () { return []; } };
  const allergens      = deps.allergens      || { detect: function () { return []; } };
  const eventBus       = deps.eventBus       || { emit: function () {} };
  const analytics      = deps.analytics      || { track: function () {} };
  const config         = deps.config         || { get: function (_p, fb) { return fb; } };

  // --- Local helpers ----------------------------------------------------------

  function jaccard(aTokens, bTokens) {
    var a = {}; for (var i = 0; i < aTokens.length; i++) a[aTokens[i]] = true;
    var inter = 0; var union = {};
    for (var k in a) union[k] = true;
    for (var j = 0; j < bTokens.length; j++) {
      var t = bTokens[j]; if (a[t]) inter++; union[t] = true;
    }
    var u = Object.keys(union).length || 1;
    return inter / u;
  }

  function rankCandidates(canonicalName, tokens, candidates, kind) {
    var scored = [];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var cName = normalizer.canonicalName(c.name);
      var cTokens = normalizer.tokenizeName(cName + " " + (c.aliases || []).join(" "));
      var sim = jaccard(tokens, cTokens);
      var aisleBoost = 0;
      try { aisleBoost = aisleService.group(c.name) === aisleService.group(canonicalName) ? 0.05 : 0; } catch (_e) {}
      var priorBoost = 0;
      try {
        var pinned = rulesStore.getPinnedSku(canonicalName);
        if (pinned && c.id === pinned) priorBoost = 0.25;
      } catch (_e) {}
      var score = sim + aisleBoost + priorBoost + (kind === "inventory" ? 0.05 : 0);
      scored.push({ ...c, _score: score, _kind: kind });
    }
    scored.sort(function (a, b) { return b._score - a._score; });
    return scored;
  }

  function buildCandidates(ingName) {
    var aliasMap = {};
    try { aliasMap = rulesStore.getAliasMap() || {}; } catch (_e) {}
    var canonical = normalizer.canonicalName(ingName);
    var canonicalWithAlias = aliasMap[canonical] || canonical;
    var tokens = normalizer.tokenizeName(canonicalWithAlias);

    var inv = []; var gar = []; var ani = []; var bul = [];
    try { inv = inventory.searchSkus(tokens) || []; } catch (_e) {}
    try { gar = sources.garden && sources.garden.findByProduce ? sources.garden.findByProduce(tokens) : []; } catch (_e) {}
    try { ani = sources.animal && sources.animal.findByCut ? sources.animal.findByCut(tokens) : []; } catch (_e) {}
    try { bul = sources.bulk && sources.bulk.search ? sources.bulk.search(tokens) : []; } catch (_e) {}

    var ranked = []
      .concat(rankCandidates(canonical, tokens, inv, "inventory"))
      .concat(rankCandidates(canonical, tokens, gar, "garden"))
      .concat(rankCandidates(canonical, tokens, ani, "animal"))
      .concat(rankCandidates(canonical, tokens, bul, "bulk"));

    // attach aisle if missing
    for (var i = 0; i < ranked.length; i++) {
      if (!ranked[i].aisle) {
        try { ranked[i].aisle = aisleService.group(ranked[i].name); } catch (_e) { ranked[i].aisle = "General"; }
      }
    }

    // basic substitutions if nothing strong
    var subs = [];
    if (!ranked.length || (ranked[0] && ranked[0]._score < 0.35)) {
      try { subs = substitutions.forName(canonical) || []; } catch (_e) { subs = []; }
    }

    return { ranked, substitutions: subs, canonical, tokens };
  }

  function toBaseQtyForCandidate(qty, unit, candidate) {
    try {
      return normalizer.toBaseUnit(qty, unit, candidate);
    } catch (_e) {
      return { qty, unit: unit || "" };
    }
  }

  function shortageBadge(skuId, needBase) {
    try {
      var est = inventory.estimateShortage(skuId, needBase.qty);
      var have = est.have || 0;
      var short = est.short || 0;
      if (short > 0) return { type: "short", have, short };
      return { type: "have", have, short: 0 };
    } catch (_e) {
      var has = false; try { has = inventory.has(skuId); } catch (_e2) { has = false; }
      return { type: has ? "have" : "short", have: has ? 1 : 0, short: has ? 0 : needBase.qty || 1 };
    }
  }

  function costFor(skuId, needBase) {
    try { return estimateEngine.costForSku(skuId, needBase.qty) || null; } catch (_e) { return null; }
  }

  // --- Public API (non-hook) --------------------------------------------------

  function suggestMatches(ingredient) {
    var name = ingredient && (ingredient.canonicalName || ingredient.name) || "";
    var parsed = normalizer.parseQtyUnit(ingredient || {});
    var cand = buildCandidates(name);
    var results = [];

    for (var i = 0; i < cand.ranked.length; i++) {
      var c = cand.ranked[i];
      var base = toBaseQtyForCandidate(parsed.qty, parsed.unit, c);
      var badge = c.id ? shortageBadge(c.id, base) : { type: "have", have: 0, short: 0 };
      var price = c.id ? costFor(c.id, base) : null;
      results.push({
        candidateId: c.id || ("src:" + c._kind + ":" + c.name),
        name: c.name,
        kind: c._kind,                 // "inventory" | "garden" | "animal" | "bulk"
        aisle: c.aisle || "General",
        confidence: Number((c._score || 0).toFixed(3)),
        need: base,                    // {qty, unit}
        badge,                         // {type:"have"|"short", have, short}
        price,                         // {total, currency} | null
        meta: c
      });
    }

    // Merge in textual subs when low confidence
    var subs = (cand.substitutions || []).map(function (s) {
      return {
        candidateId: "sub:" + s.name,
        name: s.name,
        kind: "substitution",
        aisle: aisleService.group(s.name),
        confidence: 0.25,
        need: { qty: parsed.qty, unit: parsed.unit || "" },
        badge: { type: "unknown", have: 0, short: 0 },
        price: null,
        meta: s
      };
    });

    // Allergen tags
    var allergenTags = [];
    try { allergenTags = allergens.detect(normalizer.canonicalName(name)) || []; } catch (_e) {}

    return {
      ingredient: {
        id: ingredient.id || ("ing:" + Math.random().toString(36).slice(2)),
        name: name,
        displayName: ingredient.name || name,
        parsed: { qty: parsed.qty, unit: parsed.unit || "" },
        allergens: allergenTags
      },
      candidates: results.concat(subs)
    };
  }

  function confirmMapping(ingredient, selectedCandidate, opts = {}) {
    var ingName = ingredient && (ingredient.canonicalName || ingredient.name) || "";
    var canonical = normalizer.canonicalName(ingName);

    // Learn alias if user maps a non-exact name
    try {
      var aliasMap = rulesStore.getAliasMap() || {};
      if (!aliasMap[canonical] && selectedCandidate && selectedCandidate.kind === "inventory") {
        // If the SKU's name is different enough, learn alias
        var skuName = normalizer.canonicalName(selectedCandidate.name || "");
        if (skuName && skuName !== canonical) {
          rulesStore.setAlias(canonical, skuName);
        }
      }
    } catch (_e) {}

    // Pin preferred SKU for this canonical ingredient
    try {
      if (selectedCandidate && selectedCandidate.kind === "inventory" && selectedCandidate.candidateId) {
        rulesStore.setPinnedSku(canonical, selectedCandidate.candidateId);
      }
    } catch (_e) {}

    // Emit & analytics
    try {
      eventBus.emit("ingredient:mapped", {
        ingredientName: ingName,
        to: selectedCandidate,
        from: opts.from || "importer",
        ts: new Date().toISOString()
      });
      analytics.track("ingredient/mapped", {
        name: ingName,
        candidateKind: selectedCandidate && selectedCandidate.kind,
        confidence: selectedCandidate && selectedCandidate.confidence
      });
    } catch (_e) {}

    return {
      ingredientId: ingredient.id,
      mappedTo: selectedCandidate
    };
  }

  function ignoreMapping(ingredient, reason) {
    try {
      eventBus.emit("ingredient:ignored", {
        ingredientName: ingredient && ingredient.name,
        reason: reason || "user"
      });
    } catch (_e) {}
    return true;
  }

  return {
    suggestMatches,
    confirmMapping,
    ignoreMapping
  };
}

// --- React hook wrapper -------------------------------------------------------

/**
 * useIngredientMapping
 * Provides:
 * - suggestAll(ingredients[]) → builds a mapping queue with ranked candidates
 * - confirm(ingredientId, candidateId) → persists and learns alias/pin rules
 * - overrideAlias(from, to) → admin/user quick fixes
 * - setPinnedSku(name, skuId) → force future auto-maps
 * - computed views: byAisle(), haveVsShort(), totals(), unresolved()
 */
export default function useIngredientMapping(deps = {}) {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = createIngredientMapping(deps);

  const [queue, setQueue] = useState([]); // [{ingredient, candidates, selectedId?, status:"pending"|"mapped"|"ignored"}]
  const [indexById, setIndexById] = useState({}); // ingredientId -> idx

  const suggestAll = useCallback((ingredients) => {
    if (!ingredients || !ingredients.length) {
      setQueue([]); setIndexById({});
      return [];
    }
    const out = [];
    const idxMap = {};
    for (let i = 0; i < ingredients.length; i++) {
      const s = engineRef.current.suggestMatches(ingredients[i]);
      out.push({ ingredient: s.ingredient, candidates: s.candidates, status: "pending", selectedId: null });
      idxMap[s.ingredient.id] = i;
    }
    setQueue(out);
    setIndexById(idxMap);
    return out;
  }, []);

  const confirm = useCallback((ingredientId, candidateId, opts = {}) => {
    const idx = indexById[ingredientId];
    if (idx === undefined) return null;
    const row = queue[idx];
    const selected = (row.candidates || []).find((c) => c.candidateId === candidateId) || null;
    if (!selected) return null;

    const res = engineRef.current.confirmMapping(row.ingredient, selected, opts);

    const next = queue.slice(0);
    next[idx] = { ...row, status: "mapped", selectedId: candidateId };
    setQueue(next);

    return res;
  }, [queue, indexById]);

  const ignore = useCallback((ingredientId, reason) => {
    const idx = indexById[ingredientId];
    if (idx === undefined) return false;
    engineRef.current.ignoreMapping(queue[idx].ingredient, reason);
    const next = queue.slice(0);
    next[idx] = { ...queue[idx], status: "ignored" };
    setQueue(next);
    return true;
  }, [queue, indexById]);

  const overrideAlias = useCallback((fromName, toCanonical) => {
    try {
      if (deps && deps.rulesStore && deps.rulesStore.setAlias) {
        deps.rulesStore.setAlias(fromName.toLowerCase(), toCanonical.toLowerCase());
      }
    } catch (_e) {}
  }, [deps]);

  const setPinnedSku = useCallback((canonicalName, skuId) => {
    try {
      if (deps && deps.rulesStore && deps.rulesStore.setPinnedSku) {
        deps.rulesStore.setPinnedSku(canonicalName.toLowerCase(), skuId);
      }
    } catch (_e) {}
  }, [deps]);

  // --- Computed views for UI glue --------------------------------------------

  const byAisle = useMemo(() => {
    const groups = {};
    for (let i = 0; i < queue.length; i++) {
      const row = queue[i];
      const pick = row.selectedId
        ? row.candidates.find((c) => c.candidateId === row.selectedId)
        : (row.candidates[0] || null);
      const aisle = (pick && pick.aisle) || "General";
      if (!groups[aisle]) groups[aisle] = [];
      groups[aisle].push({
        id: row.ingredient.id,
        name: row.ingredient.displayName,
        status: row.status,
        selected: pick
      });
    }
    // Sort aisles and items to match “well executed sites” like Instacart/Walmart
    const sortedAisles = Object.keys(groups).sort();
    const result = [];
    for (let j = 0; j < sortedAisles.length; j++) {
      const a = sortedAisles[j];
      const items = groups[a].slice(0).sort((x, y) => (x.name > y.name ? 1 : -1));
      result.push({ aisle: a, items });
    }
    return result;
  }, [queue]);

  const haveVsShort = useMemo(() => {
    const out = { have: [], short: [], unknown: [] };
    for (let i = 0; i < queue.length; i++) {
      const row = queue[i];
      const pick = row.selectedId
        ? row.candidates.find((c) => c.candidateId === row.selectedId)
        : (row.candidates[0] || null);
      if (!pick || !pick.badge) { out.unknown.push(row); continue; }
      if (pick.badge.type === "have") out.have.push(row); else if (pick.badge.type === "short") out.short.push(row);
      else out.unknown.push(row);
    }
    return out;
  }, [queue]);

  const totals = useMemo(() => {
    let estTotal = 0; let currency = "USD";
    for (let i = 0; i < queue.length; i++) {
      const row = queue[i];
      const pick = row.selectedId
        ? row.candidates.find((c) => c.candidateId === row.selectedId)
        : (row.candidates[0] || null);
      if (pick && pick.price && typeof pick.price.total === "number") {
        estTotal += pick.price.total;
        currency = pick.price.currency || currency;
      }
    }
    return { estimatedCost: estTotal, currency };
  }, [queue]);

  const unresolved = useMemo(() => queue.filter((r) => r.status === "pending").length, [queue]);

  // --- UX niceties / emits ----------------------------------------------------

  const emitBatchLinked = useCallback(() => {
    // Hint BatchInventoryMap / PrepConsolidation that mapping is ready
    try {
      const mapped = queue.filter((r) => r.status === "mapped");
      const payload = mapped.map((m) => ({
        ingredientId: m.ingredient.id,
        to: m.candidates.find((c) => c.candidateId === m.selectedId)
      }));
      if (deps && deps.eventBus && deps.eventBus.emit) {
        deps.eventBus.emit("ingredient:mapping:batch-linked", {
          count: payload.length,
          items: payload
        });
      }
      if (deps && deps.analytics && deps.analytics.track) {
        deps.analytics.track("ingredient/mapping/batch-linked", { count: payload.length });
      }
    } catch (_e) {}
  }, [queue, deps]);

  return {
    // actions
    suggestAll,
    confirm,
    ignore,
    overrideAlias,
    setPinnedSku,
    emitBatchLinked,
    // state & views
    queue,
    byAisle,
    haveVsShort,
    totals,
    unresolved
  };
}
