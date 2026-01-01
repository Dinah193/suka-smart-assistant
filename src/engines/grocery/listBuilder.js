/* eslint-disable no-console */
/**
 * listBuilder.js — multi-domain list builder with feed/seed/supply SKU support
 *
 * Inputs:
 *  - plan: Array<mixed-domain items> (meals / garden / cleaning / animal-care)
 *  - ctx?: {
 *      inventory?: object,                      // name -> qty (base units)
 *      preferences?: { vendorPriority?: string[] },
 *      timeWindowMinutes?: number,
 *      budgetPerServing?: number,
 *    }
 *
 * Output:
 *  {
 *    items: [{
 *      id, domain, kind, name, attrs, neededQty, unit,
 *      sku: { id, name, vendor, packQty, unit, price, upc, meta? },
 *      packs, subtotal, reasons: string[]
 *    }],
 *    totals: { grandTotal, byVendor: { [vendor]: number } },
 *    suggestions: string[],
 *    warnings: string[]
 *  }
 *
 * Catalog sources (in priority order):
 *  1) automation.get("catalog.*") — e.g. catalog.seeds, catalog.feed, catalog.supplies, catalog.grocery
 *  2) local data modules if present: "@/data/seedCatalog", "@/data/feedCatalog", "@/data/supplyCatalog", "@/data/priceBook"
 *  3) lightweight heuristics (name → default price/pack)
 */

(function () {
  // ----------------------------- Safe Imports --------------------------------
  var eventBus = { emit: function () {} };
  try {
    eventBus = (require("@/services/eventBus") || {}).eventBus || eventBus;
  } catch (e) {}

  var automation = null;
  try {
    automation = (require("@/services/automation/runtime") || {}).automation || null;
  } catch (e) {}

  var InventoryMonitor = null;
  try {
    InventoryMonitor = (require("@/managers/InventoryMonitor") || {}).default || null;
  } catch (e) {}

  var priceBook = null;
  try {
    priceBook = (require("@/data/priceBook") || {}).default || null;
  } catch (e) {}

  var seedCatalogLocal = null;
  try {
    seedCatalogLocal = (require("@/data/seedCatalog") || {}).default || null;
  } catch (e) {}

  var feedCatalogLocal = null;
  try {
    feedCatalogLocal = (require("@/data/feedCatalog") || {}).default || null;
  } catch (e) {}

  var supplyCatalogLocal = null;
  try {
    supplyCatalogLocal = (require("@/data/supplyCatalog") || {}).default || null;
  } catch (e) {}

  var units = null;
  try {
    units = (require("@/engines/normalization/units") || {}).units || null;
  } catch (e) {}

  var logger = console;

  // ------------------------------ Utilities ----------------------------------
  function norm(s) { return (s || "").toString().trim().toLowerCase(); }
  function asNum(n, d) { var x = Number(n); return isFinite(x) ? x : (d || 0); }
  function asDate(v) { return v instanceof Date ? v : new Date(v); }

  function toBase(qty, unitName) {
    if (!qty) return 0;
    if (!units) return Number(qty) || 0;
    try { return units.toBase(qty, unitName || "count"); } catch (e) { return Number(qty) || 0; }
  }
  function fromBase(qty, unitName) {
    if (!units) return { qty: qty, unit: unitName || "count" };
    try { var v = units.fromBase(qty, unitName || "count"); return { qty: v, unit: unitName || "count" }; } catch (e) { return { qty: qty, unit: unitName || "count" }; }
  }

  function idOf(it) { return it && (it.id || it._id || it.slug || it.title || it.name) || null; }

  function deepMerge() {
    var out = {};
    for (var i = 0; i < arguments.length; i++) {
      var o = arguments[i];
      if (!o || typeof o !== "object") continue;
      var ks = Object.keys(o);
      for (var j = 0; j < ks.length; j++) {
        var k = ks[j], val = o[k];
        if (val && typeof val === "object" && !Array.isArray(val)) out[k] = deepMerge(out[k] || {}, val);
        else out[k] = val;
      }
    }
    return out;
  }

  function stableHash(obj) {
    try {
      var s = JSON.stringify(obj, Object.keys(obj).sort());
      var h = 2166136261 >>> 0;
      for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
      return h.toString(36);
    } catch (e) { return Math.random().toString(36).slice(2, 10); }
  }

  // ------------------------------ Catalogs -----------------------------------
  function getCatalog(name) {
    // automation can provide arrays of SKUs or functions
    try {
      if (automation && typeof automation.get === "function") {
        var v = automation.get("catalog." + name);
        if (v) return v;
      }
    } catch (e) {}
    if (name === "seeds") return seedCatalogLocal || [];
    if (name === "feed") return feedCatalogLocal || [];
    if (name === "supplies") return supplyCatalogLocal || [];
    if (name === "grocery") return []; // groceries mostly priceBook
    return [];
  }

  // SKU shape standardizer
  function skuNorm(sku) {
    if (!sku) return null;
    var unit = sku.unit || (sku.packUnit || "count");
    var packQty = asNum(sku.packQty || sku.qty || 1, 1);
    var price = asNum(sku.price || sku.pricePerPack || 0, 0);
    return {
      id: sku.id || sku.sku || stableHash([sku.vendor, sku.name, packQty, unit]),
      name: sku.name || sku.title || "",
      vendor: sku.vendor || sku.brand || "Generic",
      packQty: packQty,
      unit: unit,
      price: price,
      upc: sku.upc || sku.ean || null,
      meta: sku.meta || sku.attributes || {}
    };
  }

  // --------------------------- Substitutions ---------------------------------
  function getSubs(kind) {
    try {
      if (automation && typeof automation.get === "function") {
        var key = kind === "feed" ? "feed.substitutions"
          : kind === "chem" ? "chem.substitutions"
          : kind === "seed" ? "seed.substitutions"
          : "ingredients.substitutions";
        var v = automation.get(key);
        if (v) return v;
      }
    } catch (e) {}
    // minimal defaults
    if (kind === "feed") return {
      "layer pellets 16%": ["layer crumbles 16%"],
      "goat chow 16%": ["all-stock 12%"]
    };
    if (kind === "chem") return {
      "quat disinfectant": ["bleach (per mfg)", "hydrogen peroxide"],
      "glass cleaner": ["isopropyl alcohol 70% (mirror)"]
    };
    if (kind === "seed") return {
      "roma tomato": ["plum tomato", "tomato paste type"],
      "butterhead lettuce": ["bibb lettuce"]
    };
    // grocery baseline (already elsewhere)
    return {
      "scallion": ["green onion"],
      "soy sauce": ["tamari", "coconut aminos"]
    };
  }

  // ------------------------------ Need Extraction ----------------------------
  /**
   * Returns normalized need lines across domains:
   * { key, domain, kind, name, attrs, qtyBase, unitBase, sourceId }
   */
  function extractNeeds(plan, ctx) {
    var needs = [];
    var inv = (ctx && ctx.inventory) || (InventoryMonitor && InventoryMonitor.getSnapshot && InventoryMonitor.getSnapshot()) || {};

    function addNeed(domain, kind, name, qty, unit, attrs, source) {
      var base = toBase(qty || 1, unit || "count");
      if (!base || base <= 0) base = 1;
      needs.push({
        key: norm(domain + "|" + kind + "|" + name + "|" + JSON.stringify(attrs || {})),
        domain: domain, kind: kind, name: name,
        attrs: attrs || {},
        qtyBase: base,
        unitBase: unit || "count",
        sourceId: idOf(source)
      });
    }

    for (var i = 0; i < (plan || []).length; i++) {
      var it = plan[i];
      if (!it) continue;
      var domain = (it.domain || (it.ingredients ? "meals" : "unknown")).toLowerCase();

      // MEALS → ingredients
      if (domain === "meals") {
        var ings = Array.isArray(it.ingredients) ? it.ingredients : [];
        for (var a = 0; a < ings.length; a++) {
          var ing = ings[a];
          var name = ing && ing.name ? ing.name : null;
          if (!name) continue;
          var needBase = toBase(ing.quantity || 1, ing.unit || "count");
          var invKey = norm(name);
          var avail = asNum(inv[invKey] && (inv[invKey].quantity || inv[invKey]) || 0, 0);
          var delta = Math.max(0, needBase - avail);
          if (delta > 0) addNeed("meals", "grocery", name, delta, "count", {}, it);
        }
      }

      // GARDEN → seeds & supplies (fertilizer, soil, labels)
      if (domain === "garden") {
        var kind = norm(it.kind || "");
        if (/sow|seed/i.test(kind) || hasTag(it.tags, "needs:seed")) {
          var variety = it.cultivar || it.variety || it.cropName || it.title || "seed";
          var pkg = Math.max(1, asNum(it.seedPackets || 1));
          addNeed("garden", "seed", variety, pkg, "packets", {
            crop: it.cropName || it.title, daysToMaturity: it.daysToMaturity
          }, it);
        }
        if (/fertiliz|amend/i.test(kind) || hasTag(it.tags, "needs:fertilizer")) {
          var fert = it.product || it.fertilizer || "balanced 10-10-10";
          var qty = asNum(it.quantity || it.amount || 1, 1);
          var unit = it.unit || "lb";
          addNeed("garden", "supply", fert, qty, unit, { npk: it.npk || "10-10-10" }, it);
        }
        if (/trellis|stake|label/i.test(kind)) {
          addNeed("garden", "supply", it.product || "plant labels", asNum(it.count || 10, 10), "count", {}, it);
        }
      }

      // CLEANING → chemicals / PPE / tools (consumables only for list)
      if (domain === "cleaning") {
        var chems = Array.isArray(it.chemicals) ? it.chemicals : [];
        for (var c = 0; c < chems.length; c++) {
          var ch = chems[c];
          var nm = (ch && ch.name) || ch || null;
          if (!nm) continue;
          // assume 1 bottle if not available
          var invKey2 = norm(nm);
          var have2 = asNum(inv[invKey2] && (inv[invKey2].quantity || inv[invKey2]) || 0, 0);
          if (have2 <= 0) addNeed("cleaning", "chemical", nm, 1, "bottle", { dilution: ch.dilution }, it);
        }
        var ppe = Array.isArray(it.ppe) ? it.ppe : [];
        for (var p = 0; p < ppe.length; p++) {
          var pnm = ppe[p];
          if (pnm && /glove|mask|respirator|goggle|apron|boot/i.test(pnm)) {
            addNeed("cleaning", "ppe", pnm, 1, "pack", {}, it);
          }
        }
      }

      // ANIMAL-CARE → feed & supplies
      if (domain === "animal-care" || it.species) {
        var species = norm((Array.isArray(it.species) && it.species[0]) || it.species || extractTag(it.tags, "species") || "");
        // feed
        if (species) {
          var feedType = extractTag(it.tags, "feed") || it.feedType || null; // ex: layer pellets 16%
          if (feedType) {
            var neededBags = asNum(it.feedBags || it.count || 1, 1);
            addNeed("animal-care", "feed", feedType, neededBags, "bag", { species: species }, it);
          }
        }
        // meds/supplies (simple heuristic)
        if (hasTag(it.tags, "needs:electrolyte")) addNeed("animal-care", "supply", "electrolyte mix", 1, "pack", { species: species }, it);
      }
    }

    return needs;
  }

  function hasTag(tags, value) {
    if (!Array.isArray(tags)) return false;
    var v = String(value).toLowerCase();
    for (var i = 0; i < tags.length; i++) if (String(tags[i]).toLowerCase() === v) return true;
    return false;
  }
  function extractTag(tags, key) {
    if (!Array.isArray(tags)) return null;
    var p = key.toLowerCase() + ":";
    for (var i = 0; i < tags.length; i++) {
      var t = String(tags[i]).toLowerCase();
      if (t.indexOf(p) === 0) return t.slice(p.length);
    }
    return null;
  }

  // ---------------------------- SKU Resolution --------------------------------
  /**
   * Given a need line, pick the best SKU(s) and number of packs to meet/exceed qty.
   */
  function resolveSKU(line, ctx) {
    var kind = line.kind; // grocery | seed | supply | chemical | ppe | feed
    var name = norm(line.name);
    var attrs = line.attrs || {};
    var vendorPref = (ctx && ctx.preferences && ctx.preferences.vendorPriority) || [];

    // 1) choose catalog(s)
    var cat = [];
    if (kind === "seed") { cat = getCatalog("seeds"); }
    else if (kind === "feed") { cat = getCatalog("feed"); }
    else if (kind === "supply" || kind === "chemical" || kind === "ppe") { cat = getCatalog("supplies"); }
    else if (kind === "grocery") { cat = getCatalog("grocery"); }

    // 2) match candidates
    var candidates = [];
    for (var i = 0; i < cat.length; i++) {
      var raw = cat[i];
      var s = skuNorm(raw);
      if (!s) continue;

      // simple matching rules
      var nm = norm(s.name);
      var ok = false;

      if (kind === "seed") {
        // match variety synonyms and crop if provided
        var crop = norm(attrs.crop || "");
        var m1 = nm.indexOf(name) >= 0 || name.indexOf(nm) >= 0;
        var m2 = crop ? (nm.indexOf(crop) >= 0) : true;
        ok = m1 || m2;
      } else if (kind === "feed") {
        // species + protein % and form (pellets/crumbles)
        var species = norm(attrs.species || "");
        var protein = (name.match(/\b(\d{1,2})\s?%/i) || [])[1];
        var form = (name.match(/\b(pellet|crumbles?|mash)\b/i) || [])[0];
        ok = (!species || nm.indexOf(species) >= 0) &&
             (!protein || nm.indexOf(protein + "%") >= 0) &&
             (!form || nm.indexOf(form) >= 0) ||
             nm.indexOf(name) >= 0;
      } else {
        ok = nm.indexOf(name) >= 0 || name.indexOf(nm) >= 0;
      }

      if (ok) candidates.push(s);
    }

    // 3) substitutions
    if (!candidates.length) {
      var subs = getSubs(kind === "chemical" ? "chem" : kind);
      var alts = subs[name] || [];
      for (var a = 0; a < alts.length; a++) {
        var altName = norm(alts[a]);
        for (var j = 0; j < cat.length; j++) {
          var rs = skuNorm(cat[j]); if (!rs) continue;
          var rnm = norm(rs.name);
          if (rnm.indexOf(altName) >= 0 || altName.indexOf(rnm) >= 0) candidates.push(rs);
        }
      }
    }

    // 4) priceBook/grocery fallback
    if (!candidates.length && (kind === "grocery" || kind === "chemical" || kind === "supply" || kind === "ppe")) {
      var pb = priceBook && priceBook[name];
      if (pb && pb.pricePerUnit) {
        candidates.push({
          id: "PB:" + name,
          name: name,
          vendor: pb.vendor || "Grocery",
          packQty: 1,
          unit: pb.unit || "count",
          price: pb.pricePerUnit,
          upc: pb.upc || null,
          meta: {}
        });
      }
    }

    // 5) absolute fallback heuristic
    if (!candidates.length) {
      candidates.push({
        id: "GEN:" + name,
        name: line.name,
        vendor: "Generic",
        packQty: 1,
        unit: line.unitBase || "count",
        price: kind === "feed" ? 18.99
             : kind === "seed" ? 3.49
             : kind === "chemical" ? 6.99
             : kind === "ppe" ? 7.99
             : kind === "supply" ? 9.99
             : 2.49,
        upc: null,
        meta: {}
      });
    }

    // 6) vendor prioritization (if provided)
    if (vendorPref && vendorPref.length) {
      candidates.sort(function (a, b) {
        var ai = vendorPref.indexOf(a.vendor);
        var bi = vendorPref.indexOf(b.vendor);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
    }

    // 7) choose the cheapest per-base-unit candidate
    var best = candidates[0];
    var bestUnitPrice = Infinity;
    for (var c = 0; c < candidates.length; c++) {
      var can = candidates[c];
      var canBaseQty = toBase(can.packQty, can.unit);
      var per = canBaseQty > 0 ? (can.price / canBaseQty) : can.price;
      if (per < bestUnitPrice) { bestUnitPrice = per; best = can; }
    }

    // 8) compute packs needed
    var needUnits = line.qtyBase; // already base
    var packUnits = toBase(best.packQty, best.unit);
    var packs = Math.max(1, Math.ceil(needUnits / Math.max(1, packUnits)));

    return { best: best, packs: packs, unitPrice: bestUnitPrice };
  }

  // --------------------------- Line Consolidation -----------------------------
  function consolidateNeeds(needs) {
    var map = {};
    for (var i = 0; i < needs.length; i++) {
      var n = needs[i];
      if (!map[n.key]) map[n.key] = deepMerge({}, n);
      else map[n.key].qtyBase += n.qtyBase; // merge quantities of identical need signature
    }
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  // ------------------------------- Builder -----------------------------------
  function buildList(plan, ctx) {
    ctx = ctx || {};
    var needsRaw = extractNeeds(plan, ctx);
    var needs = consolidateNeeds(needsRaw);

    var items = [];
    var byVendor = {};
    var warnings = [];
    var suggestions = [];

    for (var i = 0; i < needs.length; i++) {
      var line = needs[i];
      var res = resolveSKU(line, ctx);
      var sku = res.best;
      var packs = res.packs;
      var subtotal = packs * sku.price;

      items.push({
        id: stableHash({ k: line.key, sku: sku.id }),
        domain: line.domain,
        kind: line.kind,
        name: line.name,
        attrs: line.attrs,
        neededQty: fromBase(line.qtyBase, line.unitBase).qty,
        unit: line.unitBase,
        sku: sku,
        packs: packs,
        subtotal: Number(subtotal.toFixed(2)),
        reasons: recommendReasons(line, sku, packs)
      });

      byVendor[sku.vendor] = (byVendor[sku.vendor] || 0) + subtotal;

      // smart suggestions
      if (line.kind === "seed" && packs >= 3) suggestions.push("Consider bulk seed pack for '" + line.name + "' to reduce unit price.");
      if (line.kind === "feed" && sku.packQty < 40) suggestions.push("Upgrade to 40-50 lb feed bag if storage allows for '" + line.name + "'.");
      if (line.kind === "chemical" && !line.attrs || (line.attrs && !line.attrs.dilution)) {
        suggestions.push("Add dilution guidance to checklist for '" + line.name + "'.");
      }
    }

    // totals and sorting (by vendor → domain → kind)
    var grandTotal = 0;
    var vendors = Object.keys(byVendor).sort();
    for (var v = 0; v < vendors.length; v++) grandTotal += byVendor[vendors[v]];

    items.sort(function (a, b) {
      if (a.sku.vendor !== b.sku.vendor) return a.sku.vendor.localeCompare(b.sku.vendor);
      if (a.domain !== b.domain) return a.domain.localeCompare(b.domain);
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
      return String(a.name).localeCompare(String(b.name));
    });

    try {
      eventBus.emit && eventBus.emit("list:built", {
        count: items.length,
        grandTotal: Number(grandTotal.toFixed(2))
      });
    } catch (e) {}

    return {
      items: items,
      totals: { grandTotal: Number(grandTotal.toFixed(2)), byVendor: byVendor },
      suggestions: uniq(suggestions),
      warnings: uniq(warnings)
    };
  }

  function recommendReasons(line, sku, packs) {
    var r = [];
    if (packs > 1) r.push("Multiple packs to meet required quantity.");
    if (sku.vendor) r.push("Picked from preferred/available vendor: " + sku.vendor + ".");
    if (line.kind === "seed" && line.attrs && line.attrs.crop) r.push("Matched crop/variety family: " + line.attrs.crop + ".");
    if (line.kind === "feed" && line.attrs && line.attrs.species) r.push("Species-aligned feed selection.");
    return r;
  }

  function uniq(arr) {
    var set = {}; var out = [];
    for (var i = 0; i < arr.length; i++) { var k = arr[i]; if (!set[k]) { set[k] = true; out.push(k); } }
    return out;
  }

  // ------------------------------- Exports -----------------------------------
  module.exports = {
    buildList: buildList,
    _internals: {
      extractNeeds: extractNeeds,
      resolveSKU: resolveSKU,
      consolidateNeeds: consolidateNeeds,
      skuNorm: skuNorm,
      getCatalog: getCatalog
    }
  };
})();
