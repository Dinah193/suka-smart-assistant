/* eslint-disable no-console */
/**
 * StoreCatalog.js — Canonical items, vendor SKUs, pack math, and purchase suggestions (ES2015-safe)
 *
 * Purpose
 *  • One source for "what to buy" across meals, cleaning, animals (incl. butchery/cold storage), and garden.
 *  • Convert plan/inventory requirements into lowest-cost, sensible purchase options with safe substitutions.
 *  • Support "fresh-milled" flour via wheat-berries↔flour yield, feed/seed SKUs, PPE bundles, and domain kits.
 *
 * Design
 *  • Pure core (no side-effects). Optional eventBus hooks are encapsulated in helpers.
 *  • Registries: canonical items, units/aliases, vendor catalogs, substitution rules.
 *  • Price math: price per base unit, pack breakouts, equivalence multipliers.
 *  • Fuzzy matcher: normalize + token-includes; deterministic and fast.
 */

(function () {
  /* ----------------------------- Safe Imports ----------------------------- */
  var eventBus = {
    emit: function () {},
    on: function () {},
    off: function () {},
  };
  try {
    var eb = require("@/services/events/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus)) || eventBus;
  } catch (e) {
    /* noop */
  }

  /* ------------------------------- Utilities ------------------------------ */
  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }
  function id(parts) {
    return parts.filter(Boolean).join(".").toLowerCase();
  }
  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }
  function tokens(s) {
    return norm(s).split(/\s+/).filter(Boolean);
  }
  function includesAll(hay, needles) {
    for (var i = 0; i < needles.length; i++)
      if (hay.indexOf(needles[i]) < 0) return false;
    return true;
  }
  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  /* --------------------------- Units & Conversions ------------------------ */
  // Base unit per category: mass: g, volume: ml, count: each
  var U = {
    // mass
    g: { base: "g", toBase: 1, fromBase: 1 },
    kg: { base: "g", toBase: 1000, fromBase: 1 / 1000 },
    lb: { base: "g", toBase: 453.592, fromBase: 1 / 453.592 },
    oz: { base: "g", toBase: 28.3495, fromBase: 1 / 28.3495 },

    // volume
    ml: { base: "ml", toBase: 1, fromBase: 1 },
    l: { base: "ml", toBase: 1000, fromBase: 1 / 1000 },
    cup: { base: "ml", toBase: 236.588, fromBase: 1 / 236.588 },
    tbsp: { base: "ml", toBase: 14.7868, fromBase: 1 / 14.7868 },
    tsp: { base: "ml", toBase: 4.92892, fromBase: 1 / 4.92892 },

    // count
    each: { base: "each", toBase: 1, fromBase: 1 },
    ct: { base: "each", toBase: 1, fromBase: 1 },
  };

  function convert(qty, unitFrom, unitTo) {
    if (!U[unitFrom] || !U[unitTo] || U[unitFrom].base !== U[unitTo].base)
      return null;
    var baseQty = qty * U[unitFrom].toBase;
    return baseQty * U[unitTo].fromBase;
  }

  /* ---------------------------- Canonical Catalog ------------------------- */
  // Canonical item shape
  // { id, label, domain, baseUnit, tags:[...], aliases:[...], yield?:{ from:"grain.wheat.berries", inUnit:"g", outUnit:"g", factor: 1.0 }, subs?:[{toId, note, score}], meta:{...} }
  var canonical = Object.create(null);

  function addCanonical(item) {
    canonical[item.id] = item;
    // alias index
    for (var i = 0; i < (item.aliases || []).length; i++) {
      aliasIndex[norm(item.aliases[i])] = item.id;
    }
  }

  var aliasIndex = Object.create(null);

  /* -------- Meals / Baking (fresh-milled) -------- */
  addCanonical({
    id: "grain.wheat.berries",
    label: "Wheat Berries (Hard Red/White)",
    domain: "meals",
    baseUnit: "g",
    tags: ["grain", "storage", "mill", "wholegrain"],
    aliases: [
      "wheat berries",
      "hard white wheat",
      "hard red wheat",
      "whole wheat berries",
    ],
    meta: { storage: "dry", moisture: "low", wholegrain: true },
  });

  addCanonical({
    id: "flour.whole.wheat.fresh",
    label: "Fresh-Milled Whole Wheat Flour",
    domain: "meals",
    baseUnit: "g",
    tags: ["flour", "fresh-milled", "wholegrain", "baking"],
    aliases: [
      "fresh milled flour",
      "freshly milled whole wheat",
      "whole wheat flour fresh",
    ],
    // Typical home mill yield: ~100% mass in → ~100% flour out (minus minor loss). Use 0.98 by default.
    yield: {
      from: "grain.wheat.berries",
      inUnit: "g",
      outUnit: "g",
      factor: 0.98,
    },
    meta: { millingRequired: true },
  });

  addCanonical({
    id: "flour.ap",
    label: "All-Purpose Flour",
    domain: "meals",
    baseUnit: "g",
    tags: ["flour", "baking", "refined"],
    aliases: ["ap flour", "all purpose flour", "all-purpose flour"],
    subs: [
      {
        toId: "flour.whole.wheat.fresh",
        note: "Use fresh-milled + adjust hydration 5–10%",
        score: 0.55,
      },
    ],
  });

  addCanonical({
    id: "yeast.instant",
    label: "Instant Yeast",
    domain: "meals",
    baseUnit: "g",
    tags: ["baking", "yeast"],
    aliases: ["instant yeast", "saf instant"],
  });

  addCanonical({
    id: "salt.kosher",
    label: "Kosher Salt",
    domain: "meals",
    baseUnit: "g",
    tags: ["salt", "seasoning"],
    aliases: ["kosher salt", "coarse salt"],
  });

  /* -------- Cleaning -------- */
  addCanonical({
    id: "chem.bleach",
    label: "Sodium Hypochlorite (Bleach)",
    domain: "cleaning",
    baseUnit: "ml",
    tags: ["chemical", "disinfect"],
    aliases: ["bleach"],
  });

  addCanonical({
    id: "chem.vinegar",
    label: "White Distilled Vinegar",
    domain: "cleaning",
    baseUnit: "ml",
    tags: ["chemical", "acid"],
    aliases: ["vinegar"],
  });

  addCanonical({
    id: "ppe.kit.clean",
    label: "Cleaning PPE Kit",
    domain: "cleaning",
    baseUnit: "each",
    tags: ["ppe", "bundle"],
    aliases: ["cleaning ppe kit", "gloves goggles mask kit"],
    meta: { bundle: ["ppe.gloves.nitrile", "ppe.eye.basic", "ppe.mask.dust"] },
  });

  addCanonical({
    id: "ppe.gloves.nitrile",
    label: "Nitrile Gloves",
    domain: "cleaning",
    baseUnit: "each",
    tags: ["ppe", "gloves"],
    aliases: ["nitrile gloves", "disposable gloves"],
  });

  addCanonical({
    id: "ppe.eye.basic",
    label: "Safety Glasses",
    domain: "cleaning",
    baseUnit: "each",
    tags: ["ppe", "eye"],
    aliases: ["safety glasses", "eye protection"],
  });

  addCanonical({
    id: "ppe.mask.dust",
    label: "Dust Mask / Respirator",
    domain: "cleaning",
    baseUnit: "each",
    tags: ["ppe", "mask"],
    aliases: ["dust mask", "respirator"],
  });

  /* -------- Animals (feed / minerals / butchery) -------- */
  addCanonical({
    id: "feed.chicken.layer",
    label: "Layer Feed 16%",
    domain: "animals",
    baseUnit: "g",
    tags: ["feed", "poultry"],
    aliases: ["layer feed", "chicken feed"],
  });

  addCanonical({
    id: "mineral.goat",
    label: "Loose Mineral (Goat)",
    domain: "animals",
    baseUnit: "g",
    tags: ["mineral", "caprine"],
    aliases: ["goat mineral", "loose mineral"],
  });

  addCanonical({
    id: "butchery.bags.vacuum",
    label: "Vacuum Bags (Butchery)",
    domain: "animals",
    baseUnit: "each",
    tags: ["butchery", "storage", "bags"],
    aliases: ["vacuum bags", "vac sealer bags"],
  });

  /* -------- Garden (seeds / soil / fertilizer) -------- */
  addCanonical({
    id: "seed.corn.sweet",
    label: "Sweet Corn Seed",
    domain: "garden",
    baseUnit: "each",
    tags: ["seed", "corn"],
    aliases: ["corn seed", "sweet corn seed"],
  });

  addCanonical({
    id: "soil.mix.raisedbed",
    label: "Raised Bed Soil Mix",
    domain: "garden",
    baseUnit: "g",
    tags: ["soil", "mix"],
    aliases: ["raised bed mix", "garden soil"],
  });

  addCanonical({
    id: "fert.npk.5.10.10",
    label: "Fertilizer 5-10-10",
    domain: "garden",
    baseUnit: "g",
    tags: ["fertilizer", "npk"],
    aliases: ["5-10-10 fertilizer", "garden fertilizer"],
  });

  /* --------------------------- Substitution Rules -------------------------- */
  // Generic fallbacks if item.subs not present
  var subs = {
    "flour.ap": [
      {
        toId: "flour.whole.wheat.fresh",
        note: "Hydration +5–10%, expect denser crumb",
        score: 0.5,
      },
    ],
    "chem.bleach": [
      {
        toId: "chem.vinegar",
        note: "Acid cleaner (NOT a disinfectant). Do NOT mix.",
        score: 0.2,
      },
    ],
  };

  function getSubstitutions(id) {
    var item = canonical[id];
    var out = [];
    if (item && item.subs) out = out.concat(item.subs);
    if (subs[id]) out = out.concat(subs[id]);
    return out;
  }

  /* ---------------------------- Vendor Catalogs ---------------------------- */
  // minimal example vendor entries. You will likely populate from JSON or APIs later.
  // SKU record:
  // { sku, vendor, canonicalId, packQty, packUnit, price, name, url?, meta:{}, availability?: "in_stock"|"oos" }
  var vendorCatalogs = Object.create(null);

  function registerVendor(vendorKey, list) {
    vendorCatalogs[vendorKey] = list || [];
  }

  // Local / Warehouse / Azure-style seeding
  registerVendor("local", [
    {
      sku: "LOC-0001",
      vendor: "local",
      canonicalId: "grain.wheat.berries",
      packQty: 22.68,
      packUnit: "kg",
      price: 24.0,
      name: "Wheat Berries 50 lb (local mill)",
      availability: "in_stock",
    },
    {
      sku: "LOC-0002",
      vendor: "local",
      canonicalId: "yeast.instant",
      packQty: 454,
      packUnit: "g",
      price: 6.99,
      name: "Instant Yeast 1 lb",
    },
    {
      sku: "LOC-0003",
      vendor: "local",
      canonicalId: "salt.kosher",
      packQty: 1360,
      packUnit: "g",
      price: 3.49,
      name: "Kosher Salt 3 lb",
    },
    {
      sku: "LOC-0101",
      vendor: "local",
      canonicalId: "ppe.kit.clean",
      packQty: 1,
      packUnit: "each",
      price: 12.99,
      name: "Cleaning PPE Kit",
    },
    {
      sku: "LOC-0201",
      vendor: "local",
      canonicalId: "feed.chicken.layer",
      packQty: 22.68,
      packUnit: "kg",
      price: 16.99,
      name: "Layer Feed 50 lb",
    },
    {
      sku: "LOC-0202",
      vendor: "local",
      canonicalId: "mineral.goat",
      packQty: 4540,
      packUnit: "g",
      price: 19.99,
      name: "Goat Mineral 10 lb",
    },
    {
      sku: "LOC-0301",
      vendor: "local",
      canonicalId: "butchery.bags.vacuum",
      packQty: 100,
      packUnit: "each",
      price: 21.99,
      name: "Vacuum Bags (100ct)",
    },
    {
      sku: "LOC-0401",
      vendor: "local",
      canonicalId: "soil.mix.raisedbed",
      packQty: 28.3,
      packUnit: "kg",
      price: 9.99,
      name: "Raised Bed Mix 62.5 lb",
    },
    {
      sku: "LOC-0402",
      vendor: "local",
      canonicalId: "fert.npk.5.10.10",
      packQty: 4.54,
      packUnit: "kg",
      price: 11.99,
      name: "Fertilizer 5-10-10 (10 lb)",
    },
  ]);

  registerVendor("azure", [
    {
      sku: "AZ-berries-25",
      vendor: "azure",
      canonicalId: "grain.wheat.berries",
      packQty: 11.34,
      packUnit: "kg",
      price: 14.95,
      name: "Wheat Berries 25 lb",
    },
    {
      sku: "AZ-yeast-1lb",
      vendor: "azure",
      canonicalId: "yeast.instant",
      packQty: 454,
      packUnit: "g",
      price: 5.89,
      name: "Instant Yeast 1 lb",
    },
    {
      sku: "AZ-salt-3lb",
      vendor: "azure",
      canonicalId: "salt.kosher",
      packQty: 1360,
      packUnit: "g",
      price: 2.99,
      name: "Kosher Salt 3 lb",
    },
    {
      sku: "AZ-vac-100",
      vendor: "azure",
      canonicalId: "butchery.bags.vacuum",
      packQty: 100,
      packUnit: "each",
      price: 18.5,
      name: "Vacuum Bags (100ct)",
    },
  ]);

  registerVendor("warehouse", [
    {
      sku: "WH-AP50",
      vendor: "warehouse",
      canonicalId: "flour.ap",
      packQty: 22.68,
      packUnit: "kg",
      price: 18.99,
      name: "AP Flour 50 lb",
    },
    {
      sku: "WH-PPEKIT",
      vendor: "warehouse",
      canonicalId: "ppe.kit.clean",
      packQty: 1,
      packUnit: "each",
      price: 9.99,
      name: "Cleaning PPE Kit (bulk)",
    },
    {
      sku: "WH-layer-40",
      vendor: "warehouse",
      canonicalId: "feed.chicken.layer",
      packQty: 18.14,
      packUnit: "kg",
      price: 13.49,
      name: "Layer Feed 40 lb",
    },
    {
      sku: "WH-mineral-goat",
      vendor: "warehouse",
      canonicalId: "mineral.goat",
      packQty: 2268,
      packUnit: "g",
      price: 12.99,
      name: "Goat Mineral 5 lb",
    },
  ]);

  /* ---------------------------- Matching & Math ---------------------------- */
  function findCanonicalByAliasOrId(query) {
    if (!query) return null;
    var q = norm(query);
    if (canonical[q]) return canonical[q];
    if (canonical[query]) return canonical[query];
    if (aliasIndex[q]) return canonical[aliasIndex[q]];

    // greedy token match
    var qTok = tokens(q);
    var best = null,
      bestScore = 0;
    for (var cid in canonical) {
      if (!Object.prototype.hasOwnProperty.call(canonical, cid)) continue;
      var c = canonical[cid];
      var hay = tokens(
        c.label +
          " " +
          (c.aliases || []).join(" ") +
          " " +
          (c.tags || []).join(" ")
      );
      if (includesAll(hay, qTok)) {
        // simple score: shorter difference is better
        var score = 1 / (Math.abs(hay.length - qTok.length) + 1);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
    }
    return best;
  }

  function listVendorSkusFor(canonicalId) {
    var out = [];
    for (var v in vendorCatalogs) {
      if (!Object.prototype.hasOwnProperty.call(vendorCatalogs, v)) continue;
      var list = vendorCatalogs[v];
      for (var i = 0; i < list.length; i++) {
        if (list[i].canonicalId === canonicalId) out.push(list[i]);
      }
    }
    return out;
  }

  function pricePerBaseUnit(sku) {
    // Convert pack to canonical base unit for comparable price
    var c = canonical[sku.canonicalId];
    if (!c) return null;
    var from = sku.packUnit;
    var to = c.baseUnit;
    if (!U[from] || !U[to]) return null;
    var baseQty = sku.packQty * U[from].toBase; // qty in FROM base
    var toQtyInToBase =
      U[from].base === U[to].base ? sku.packQty * U[from].toBase : null;
    if (toQtyInToBase == null) {
      // incompatible (e.g., ml vs g); do not price per base
      return null;
    }
    var baseUnits = toQtyInToBase; // already in target base units
    return baseUnits > 0 ? sku.price / baseUnits : null;
  }

  function chooseBestPrice(skus) {
    var withPPU = [];
    for (var i = 0; i < skus.length; i++) {
      var ppu = pricePerBaseUnit(skus[i]);
      withPPU.push(Object.assign({}, skus[i], { pricePerBaseBaseUnit: ppu }));
    }
    withPPU = withPPU.filter(function (x) {
      return typeof x.pricePerBaseBaseUnit === "number";
    });
    withPPU.sort(function (a, b) {
      return a.pricePerBaseBaseUnit - b.pricePerBaseBaseUnit;
    });
    return withPPU;
  }

  /* ----------------------- Requirement → Purchase Options ------------------ */
  // requirement: { id? (canonical), name?, qty, unit, domain?, allowSub?:boolean }
  // returns: { requirement:{...}, options:[{sku, vendor, totalPacks, totalPrice, coverQtyBase, pricePerBaseUnit}], substitutions:[...] }
  function suggestPurchases(requirement, prefs) {
    prefs = prefs || {};
    var domainPref = prefs.domain || requirement.domain || null;

    // Resolve canonical
    var c = requirement.id
      ? canonical[requirement.id]
      : findCanonicalByAliasOrId(requirement.name);
    if (!c) {
      return {
        requirement: requirement,
        options: [],
        substitutions: [],
        warnings: ["unknown_item"],
      };
    }

    // Fresh-milled: if requirement is flour.whole.wheat.fresh and berries available, offer berry route
    var extraOptions = [];
    if (
      c.id === "flour.whole.wheat.fresh" &&
      canonical["grain.wheat.berries"]
    ) {
      // convert flour qty needed into berries qty needed via yield
      var y = c.yield || {
        from: "grain.wheat.berries",
        inUnit: "g",
        outUnit: "g",
        factor: 0.98,
      };
      var needFlourBase = toBase(requirement.qty, requirement.unit, c.baseUnit);
      var berriesId = y.from;
      var berries = canonical[berriesId];
      if (needFlourBase != null && berries) {
        var berriesNeededBase = needFlourBase / (y.factor || 1);
        var berrySkus = listVendorSkusFor(berriesId);
        var rankedBerry = chooseBestPrice(berrySkus);
        for (var i = 0; i < rankedBerry.length; i++) {
          var s = rankedBerry[i];
          var packBaseQty = toBase(s.packQty, s.packUnit, berries.baseUnit);
          if (!packBaseQty) continue;
          var packs = Math.ceil(berriesNeededBase / packBaseQty);
          extraOptions.push({
            kind: "alt-route",
            note:
              "Mill fresh flour from wheat berries (~" +
              round2(100 * (y.factor || 1)) +
              "% yield)",
            sku: s.sku,
            vendor: s.vendor,
            name: s.name,
            canonicalId: s.canonicalId,
            totalPacks: packs,
            totalPrice: round2(packs * s.price),
            coverQtyBase: round2(packs * packBaseQty * (y.factor || 1)), // flour coverage
            pricePerBaseUnit: s.pricePerBaseBaseUnit,
          });
        }
      }
    }

    // Regular route: same canonical
    var skus = listVendorSkusFor(c.id);
    var ranked = chooseBestPrice(skus);

    // Build suggestions sized to requirement
    var needBase = toBase(requirement.qty, requirement.unit, c.baseUnit);
    var options = [];
    for (var j = 0; j < ranked.length; j++) {
      var rk = ranked[j];
      var packBaseQty2 = toBase(rk.packQty, rk.packUnit, c.baseUnit);
      if (!packBaseQty2) continue;
      var packs2 = Math.ceil((needBase || 0) / packBaseQty2);
      options.push({
        sku: rk.sku,
        vendor: rk.vendor,
        name: rk.name,
        canonicalId: rk.canonicalId,
        totalPacks: packs2 || 1,
        totalPrice: round2((packs2 || 1) * rk.price),
        coverQtyBase: round2((packs2 || 1) * packBaseQty2),
        pricePerBaseUnit: rk.pricePerBaseBaseUnit,
      });
    }

    // Substitutions (if allowed)
    var subsOut = [];
    if (requirement.allowSub !== false) {
      var sRules = getSubstitutions(c.id);
      for (var k = 0; k < sRules.length; k++) {
        var sub = sRules[k];
        var subSkus = listVendorSkusFor(sub.toId);
        var rankedSub = chooseBestPrice(subSkus);
        if (!rankedSub.length) continue;
        subsOut.push({
          toId: sub.toId,
          note: sub.note,
          score: sub.score,
          best: rankedSub[0],
        });
      }
      // sort subs by score desc then price asc
      subsOut.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        var ap = (a.best && a.best.pricePerBaseBaseUnit) || Infinity;
        var bp = (b.best && b.best.pricePerBaseBaseUnit) || Infinity;
        return ap - bp;
      });
    }

    // Merge extra options (berries milling route) with regular options; keep unique by vendor+sku
    var merged = options.slice(0);
    for (var x = 0; x < extraOptions.length; x++) {
      merged.push(extraOptions[x]);
    }
    merged = dedupeOptions(merged);

    // prefer vendor if requested
    if (prefs.vendor) {
      merged.sort(function (a, b) {
        var ap = a.vendor === prefs.vendor ? 0 : 1;
        var bp = b.vendor === prefs.vendor ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return a.totalPrice - b.totalPrice;
      });
    } else {
      merged.sort(function (a, b) {
        return a.totalPrice - b.totalPrice;
      });
    }

    return {
      requirement: Object.assign({}, requirement, {
        id: c.id,
        domain: c.domain,
        baseUnit: c.baseUnit,
      }),
      options: merged,
      substitutions: subsOut,
    };
  }

  function dedupeOptions(arr) {
    var map = Object.create(null),
      out = [];
    for (var i = 0; i < arr.length; i++) {
      var k = (arr[i].vendor || "?") + "|" + (arr[i].sku || "?");
      if (!map[k]) {
        map[k] = true;
        out.push(arr[i]);
      }
    }
    return out;
  }

  function toBase(qty, unitFrom, baseUnit) {
    if (!qty || !unitFrom) return null;
    if (!U[unitFrom] || !U[baseUnit]) return null;
    if (U[unitFrom].base !== U[baseUnit].base) return null;
    return qty * U[unitFrom].toBase; // qty in base-of-from; since bases match, this equals base-of-target
  }

  /* ------------------------- Plan → Supply Suggestions --------------------- */
  // items: [{ id, title, domain, needs:[{ name|id, qty, unit, allowSub? }], tags? }]
  // returns shopping list with line-grouping by canonicalId and vendor suggestion
  function planToShoppingList(items, prefs) {
    var lines = Object.create(null);
    var debug = [];

    for (var i = 0; i < (items || []).length; i++) {
      var needs = items[i].needs || [];
      for (var n = 0; n < needs.length; n++) {
        var req = needs[n];
        var sug = suggestPurchases(req, prefs);
        debug.push({ need: req, suggest: sug });

        // group by canonical
        var cid = sug.requirement.id || req.id || req.name;
        var line =
          lines[cid] ||
          (lines[cid] = {
            canonicalId: cid,
            label: (canonical[cid] && canonical[cid].label) || req.name || cid,
            baseUnit:
              (canonical[cid] && canonical[cid].baseUnit) || req.unit || "each",
            totalNeededBase: 0,
            suggestions: [],
          });
        var needBase = toBase(req.qty, req.unit, line.baseUnit) || 0;
        line.totalNeededBase += needBase;

        // keep top 3 options per need for UI flexibility
        line.suggestions.push((sug.options || []).slice(0, 3));
      }
    }

    // flatten suggestions and compute best vendor per line
    var out = [];
    for (var k in lines) {
      if (!Object.prototype.hasOwnProperty.call(lines, k)) continue;
      var L = lines[k];
      var flat = [];
      for (var s = 0; s < L.suggestions.length; s++)
        flat = flat.concat(L.suggestions[s]);
      // choose cheapest that covers at least totalNeededBase
      var chosen = pickPacksToCover(flat, L.totalNeededBase, L.baseUnit);
      out.push({
        canonicalId: L.canonicalId,
        label: L.label,
        baseUnit: L.baseUnit,
        totalNeededBase: round2(L.totalNeededBase),
        bestOption: chosen,
        alternatives: flat.slice(0, 6), // for UI “see more”
      });
    }

    out.sort(function (a, b) {
      return (a.label || "").localeCompare(b.label || "");
    });
    return { lines: out, debug: debug };
  }

  function pickPacksToCover(options, needBase, baseUnit) {
    // greedy by price per coverage
    var ranked = options.slice(0).filter(function (o) {
      return (
        typeof o.totalPrice === "number" && typeof o.coverQtyBase === "number"
      );
    });
    ranked.sort(function (a, b) {
      var aCost = a.totalPrice / Math.max(1, a.coverQtyBase);
      var bCost = b.totalPrice / Math.max(1, b.coverQtyBase);
      return aCost - bCost;
    });

    var chosen = [],
      remain = needBase;
    for (var i = 0; i < ranked.length && remain > 0; i++) {
      var o = ranked[i];
      chosen.push(o);
      remain -= o.coverQtyBase;
    }

    var totalPrice = 0,
      cover = 0;
    for (var j = 0; j < chosen.length; j++) {
      totalPrice += chosen[j].totalPrice;
      cover += chosen[j].coverQtyBase;
    }
    return {
      packs: chosen,
      totalPrice: round2(totalPrice),
      coverQtyBase: round2(cover),
      needBase: round2(needBase),
      unit: baseUnit,
    };
  }

  /* --------------------------- Domain Convenience -------------------------- */
  function mealBakingKitFreshMilled(servings) {
    // simple helper to propose flour/berries/yeast/salt for bread/waffles etc.
    servings = Math.max(1, servings || 1);
    var flourNeedG = 120 * servings; // ~120g flour per small waffle/bun serving
    var yeastNeedG = 2.5 * servings; // ~2.5g instant yeast per serving (recipe-dependent)
    var saltNeedG = 2.0 * servings;

    var needs = [
      { name: "fresh milled whole wheat flour", qty: flourNeedG, unit: "g" },
      { id: "yeast.instant", qty: yeastNeedG, unit: "g" },
      { id: "salt.kosher", qty: saltNeedG, unit: "g" },
    ];
    return needs.map(function (x) {
      return suggestPurchases(x, { vendor: null });
    });
  }

  function cleaningStarterKit() {
    var needs = [
      { id: "ppe.kit.clean", qty: 1, unit: "each" },
      { id: "chem.bleach", qty: 946, unit: "ml", allowSub: false },
    ];
    return needs.map(function (x) {
      return suggestPurchases(x, {});
    });
  }

  function animalsButcheryKit() {
    var needs = [
      { id: "butchery.bags.vacuum", qty: 200, unit: "each" },
      { id: "mineral.goat", qty: 4540, unit: "g" },
    ];
    return needs.map(function (x) {
      return suggestPurchases(x, {});
    });
  }

  function gardenSeedSoilKit() {
    var needs = [
      { id: "seed.corn.sweet", qty: 50, unit: "each" },
      { id: "soil.mix.raisedbed", qty: 226.8, unit: "kg" },
      { id: "fert.npk.5.10.10", qty: 4.54, unit: "kg" },
    ];
    return needs.map(function (x) {
      return suggestPurchases(x, {});
    });
  }

  /* ----------------------------- Event Helpers ----------------------------- */
  // Optional: build an event payload for shortages or list requests without side-effects.
  function buildShortageEventFromPlan(planMissingLines) {
    // planMissingLines: output of inventory comparator → [{ id|name, qty, unit, domain }]
    return {
      name: "inventory.shortage.detected",
      payload: {
        domain: inferDomainFromLines(planMissingLines),
        items: planMissingLines.map(function (m) {
          return { id: m.id, name: m.name, qtyNeeded: m.qty, unit: m.unit };
        }),
      },
    };
  }

  function inferDomainFromLines(lines) {
    // naive: take first canonical domain if resolvable
    for (var i = 0; i < (lines || []).length; i++) {
      var c = lines[i].id
        ? canonical[lines[i].id]
        : findCanonicalByAliasOrId(lines[i].name);
      if (c && c.domain) return c.domain;
    }
    return "meals";
  }

  /* ---------------------------------- API ---------------------------------- */
  var api = {
    // Registries
    addCanonical: addCanonical,
    getCanonical: function (idOrName) {
      return (
        (idOrName && canonical[idOrName]) || findCanonicalByAliasOrId(idOrName)
      );
    },
    listCanonical: function () {
      return Object.keys(canonical).map(function (k) {
        return canonical[k];
      });
    },
    registerVendor: registerVendor,
    listVendorSkusFor: listVendorSkusFor,

    // Matching & math
    findCanonicalByAliasOrId: findCanonicalByAliasOrId,
    pricePerBaseUnit: pricePerBaseUnit,
    suggestPurchases: suggestPurchases,
    planToShoppingList: planToShoppingList,

    // Domain helpers
    kits: {
      mealBakingKitFreshMilled: mealBakingKitFreshMilled,
      cleaningStarterKit: cleaningStarterKit,
      animalsButcheryKit: animalsButcheryKit,
      gardenSeedSoilKit: gardenSeedSoilKit,
    },

    // Units
    convert: convert,
    units: U,

    // Events (pure builders)
    buildShortageEventFromPlan: buildShortageEventFromPlan,
  };

  /* ---------------------------- Export (CJS/UMD) --------------------------- */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else if (typeof define === "function" && define.amd) {
    // eslint-disable-next-line no-undef
    define(function () {
      return api;
    });
  } else {
    // eslint-disable-next-line no-undef
    this.StoreCatalog = api;
  }
}).call(
  typeof global !== "undefined"
    ? global
    : typeof window !== "undefined"
    ? window
    : this
);
