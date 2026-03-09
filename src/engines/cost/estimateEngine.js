/* eslint-disable no-console */
// estimateEngine.js — Optional cost logic (detergent / feed / seed / cleaners / utilities)
// Suka Smart Assistant • defensive, zero-crash helpers
//
// What it does
// - Builds cost line-items from any task (cooking, cleaning, animal care/butchery, garden)
// - Resolves SKU → price using Supplier Catalog / PriceBook / Inventory fallbacks
// - Converts units, respects pack size & concentration (e.g., detergent 6x)
// - Estimates utilities (electricity, gas, water) by appliance + duration
// - Handles substitutions, aisle/store selection, shortages
// - Emits events so UI can show a live “Estimated Cost” badge + NBA suggestions
//
// Inputs (examples)
// task.resources = [{ sku, name, qty, unit, alt:[{sku,qty,unit}], notes, group: "chemicals|feed|seed|meat|veg|disposables" }, ...]
// task.appliance = { kind:"oven|washer|dryer|stove|kettle|smoker|dehydrator|freezer", watts, btu, minutes, fuel:"electric|gas" }
// task.kind = "cooking|cleaning|animal|butchery|garden"
// task.location.storeId (optional preferred store)
// task.flags e.g. ["shortage-ok","sabbath-guard", ...]
// task.meta = { concentration: { "detergent": 6 }, dilution: { "bleach": "1:10" } }
//
// Public API
//  - estimateTaskCost(task, opts?) -> { total, currency, items:[...], utilities:{...}, notes:[] }
//  - estimateSessionCost(tasks, opts?) -> { total, currency, items:[...], utilities:{...}, perTask:[...], notes:[] }
//  - estimateLineItemsFromTask(task, opts?) -> items[]
//
// UMD-safe export at bottom.

(function () {
  // ----------------------------- Defensive Imports -----------------------------
  var eventBus = { emit: function () {} };
  try {
    eventBus =
      (require("@/services/events/eventBus") || {}).eventBus || eventBus;
  } catch (_) {}

  // Price/Inventory sources (all optional, used opportunistically)
  var Inventory = {
    findBySku: function () {
      return null;
    },
    priceFor: function () {
      return null;
    }, // { price, currency, packQty, packUnit, lastUpdated }
  };
  try {
    var inv = require("@/managers/InventoryMonitor");
    if (inv) {
      Inventory.findBySku = function (sku) {
        try {
          return inv.getItemBySKU && inv.getItemBySKU(sku);
        } catch (_) {
          return null;
        }
      };
      Inventory.priceFor = function (q) {
        try {
          return inv.getPriceFor && inv.getPriceFor(q);
        } catch (_) {
          return null;
        }
      };
    }
  } catch (_) {}

  var PriceBook = {
    lookup: function () {
      return null;
    },
  };
  try {
    PriceBook = require("@/services/pricing/priceBook") || PriceBook;
  } catch (_) {}

  var SupplierCatalog = {
    find: function () {
      return null;
    },
  };
  try {
    SupplierCatalog =
      require("@/services/suppliers/catalog") || SupplierCatalog;
  } catch (_) {}

  var Settings = {
    currency: "USD",
    utilityRates: {
      // sensible defaults; override in SettingsStore
      electricity_kwh: 0.15,
      natural_gas_therm: 1.2,
      water_1000gal: 5.0,
    },
    tz: "America/New_York",
    locale: "en-US",
  };
  try {
    var settings = require("@/stores/SettingsStore") || {};
    Settings.currency =
      (settings.get && settings.get("currency")) || Settings.currency;
    var ur = (settings.get && settings.get("utilityRates")) || {};
    Settings.utilityRates = Object.assign(Settings.utilityRates, ur || {});
    Settings.tz = (settings.get && settings.get("timezone")) || Settings.tz;
    Settings.locale =
      (settings.get && settings.get("locale")) || Settings.locale;
  } catch (_) {}

  // Optional store selector (if user pins a store)
  var StoreSelector = {
    getActiveStoreId: function () {
      return null;
    },
  };
  try {
    StoreSelector = require("@/stores/StoreSelector") || StoreSelector;
  } catch (_) {}

  // ----------------------------- Tiny Utils -----------------------------
  function toNum(n, def) {
    n = Number(n);
    return isFinite(n) ? n : def || 0;
  }
  function round2(n) {
    return Math.round((toNum(n, 0) + Number.EPSILON) * 100) / 100;
  }
  function id(prefix) {
    return (prefix || "est") + ":" + Math.random().toString(36).slice(2, 10);
  }
  function pick(a, b, c) {
    return a != null ? a : b != null ? b : c;
  }
  function lower(s) {
    return (s || "").toString().toLowerCase();
  }

  // Unit conversions (minimal but practical)
  var U = (function () {
    var gramsPerOunce = 28.349523125;
    var mlPerFlOz = 29.5735295625;
    var gPerLb = 453.59237;
    var mlPerL = 1000;
    var unitAliases = {
      g: "g",
      gram: "g",
      grams: "g",
      kg: "kg",
      oz: "oz",
      ounce: "oz",
      ounces: "oz",
      lb: "lb",
      lbs: "lb",
      pound: "lb",
      pounds: "lb",
      ml: "ml",
      milliliter: "ml",
      milliliters: "ml",
      l: "l",
      liter: "l",
      liters: "l",
      floz: "floz",
      "fl-oz": "floz",
      "fl oz": "floz",
      tsp: "tsp",
      teaspoon: "tsp",
      teaspoons: "tsp",
      tbsp: "tbsp",
      tablespoon: "tbsp",
      tablespoons: "tbsp",
      cup: "cup",
      cups: "cup",
      ea: "ea",
      each: "ea",
      unit: "ea",
      ct: "ea",
      seeds: "seeds",
    };

    var toBase = function (qty, unit) {
      unit = unitAliases[lower(unit)] || lower(unit);
      var n = toNum(qty, 0);
      // Base dimensions by category:
      // mass: g, volume: ml, count: ea
      switch (unit) {
        case "g":
          return { qty: n, unit: "g", dim: "mass" };
        case "kg":
          return { qty: n * 1000, unit: "g", dim: "mass" };
        case "oz":
          return { qty: n * gramsPerOunce, unit: "g", dim: "mass" };
        case "lb":
          return { qty: n * gPerLb, unit: "g", dim: "mass" };
        case "ml":
          return { qty: n, unit: "ml", dim: "vol" };
        case "l":
          return { qty: n * mlPerL, unit: "ml", dim: "vol" };
        case "floz":
          return { qty: n * mlPerFlOz, unit: "ml", dim: "vol" };
        case "tsp":
          return { qty: n * 4.92892, unit: "ml", dim: "vol" };
        case "tbsp":
          return { qty: n * 14.7868, unit: "ml", dim: "vol" };
        case "cup":
          return { qty: n * 236.588, unit: "ml", dim: "vol" };
        case "ea":
          return { qty: n, unit: "ea", dim: "count" };
        case "seeds":
          return { qty: n, unit: "seeds", dim: "count" };
        default:
          return { qty: n, unit: unit || "ea", dim: "count" };
      }
    };

    // convert base into target unit; if impossible, return null
    var fromBase = function (base, targetUnit) {
      targetUnit = unitAliases[lower(targetUnit)] || lower(targetUnit);
      var q = toNum(base.qty, 0),
        u = base.unit,
        dim = base.dim;
      if (!targetUnit) return { qty: q, unit: u };
      // mass targets
      if (dim === "mass") {
        switch (targetUnit) {
          case "g":
            return { qty: q, unit: "g" };
          case "kg":
            return { qty: q / 1000, unit: "kg" };
          case "oz":
            return { qty: q / 28.349523125, unit: "oz" };
          case "lb":
            return { qty: q / 453.59237, unit: "lb" };
        }
      }
      // volume targets
      if (dim === "vol") {
        switch (targetUnit) {
          case "ml":
            return { qty: q, unit: "ml" };
          case "l":
            return { qty: q / 1000, unit: "l" };
          case "floz":
            return { qty: q / 29.5735295625, unit: "floz" };
          case "tsp":
            return { qty: q / 4.92892, unit: "tsp" };
          case "tbsp":
            return { qty: q / 14.7868, unit: "tbsp" };
          case "cup":
            return { qty: q / 236.588, unit: "cup" };
        }
      }
      // count targets
      if (dim === "count") {
        if (targetUnit === "ea" || targetUnit === "seeds")
          return { qty: q, unit: targetUnit };
      }
      // fallback (cannot convert dimensions)
      return null;
    };

    // find unit cost given pack {qty,unit} & price
    function unitCost(price, packQty, packUnit) {
      var base = toBase(packQty, packUnit);
      var bq = Math.max(base.qty, 0.000001);
      return price / bq; // per base-unit (g/ml/ea)
    }

    // normalize quantity to a pack; returns packCount and remainder
    function packsNeeded(reqQtyBase, packQtyBase) {
      var count = Math.ceil(reqQtyBase / Math.max(packQtyBase, 0.000001));
      var remainder = count * packQtyBase - reqQtyBase;
      return { count: count, remainder: remainder };
    }

    return {
      toBase: toBase,
      fromBase: fromBase,
      unitCost: unitCost,
      packsNeeded: packsNeeded,
    };
  })();

  // ----------------------------- Defaults for Commodity Profiles -----------------------------
  // Fallback price heuristics if no pricebook/catalog/inventory record is found
  // Values are approximate and should be overridden by PriceBook.
  var CommodityDefaults = {
    detergent: {
      // concentrated cleaners
      unit: "ml",
      basePricePerML: 0.006, // $0.006/ml ~ $9/L
      concentrationX: 6, // 6x means effective cost/ml is basePricePerML / 6
    },
    bleach: {
      unit: "ml",
      basePricePerML: 0.0015, // ~ $1.50/L generic
    },
    degreaser: {
      unit: "ml",
      basePricePerML: 0.004,
    },
    feed_layer: {
      // chicken layer feed
      unit: "lb",
      basePricePerLB: 0.4, // ~$20 for 50 lb
    },
    feed_broiler: {
      unit: "lb",
      basePricePerLB: 0.45,
    },
    feed_sheep: {
      unit: "lb",
      basePricePerLB: 0.36,
    },
    seed_generic: {
      unit: "seeds",
      basePricePerSeed: 0.02, // packet-level estimate
    },
    sanitizer: {
      unit: "ml",
      basePricePerML: 0.003,
    },
    bags_vac: {
      unit: "ea",
      basePricePerEA: 0.25,
    },
    gloves_nitrile: {
      unit: "ea",
      basePricePerEA: 0.08,
    },
  };

  function inferCommodityKey(line) {
    var g = lower(line.group || "");
    var name = lower(line.name || "");
    if (g.indexOf("feed") >= 0) {
      if (name.indexOf("layer") >= 0) return "feed_layer";
      if (name.indexOf("broiler") >= 0) return "feed_broiler";
      if (name.indexOf("sheep") >= 0 || name.indexOf("ewe") >= 0)
        return "feed_sheep";
      return "feed_layer";
    }
    if (g.indexOf("seed") >= 0 || name.indexOf("seed") >= 0)
      return "seed_generic";
    if (g.indexOf("chem") >= 0 || g.indexOf("clean") >= 0) {
      if (name.indexOf("bleach") >= 0) return "bleach";
      if (name.indexOf("degreaser") >= 0) return "degreaser";
      if (name.indexOf("sanitize") >= 0) return "sanitizer";
      if (name.indexOf("detergent") >= 0 || name.indexOf("soap") >= 0)
        return "detergent";
      return "detergent";
    }
    if (name.indexOf("vac bag") >= 0 || name.indexOf("vacuum bag") >= 0)
      return "bags_vac";
    if (name.indexOf("glove") >= 0) return "gloves_nitrile";
    return null;
  }

  function priceFromCommodityDefault(line) {
    var key = inferCommodityKey(line);
    if (!key || !CommodityDefaults[key]) return null;
    var d = CommodityDefaults[key];
    var qty = toNum(line.qty, 1);
    var unit = lower(line.unit || d.unit);
    var base = U.toBase(qty, unit);
    var price = 0;

    if (key === "seed_generic") {
      // seeds counted as "seeds" not ml/g
      var per = d.basePricePerSeed || 0.02;
      var seeds = base.unit === "seeds" ? base.qty : qty; // if user typed 100 seeds
      price = per * seeds;
    } else if (key.startsWith("feed_")) {
      // feed priced by lb
      var lb = U.fromBase(base, "lb");
      lb = lb ? lb.qty : qty;
      price = (d.basePricePerLB || 0.4) * lb;
    } else if (key === "gloves_nitrile" || key === "bags_vac") {
      var ea = base.unit === "ea" ? base.qty : qty;
      var perEA = d.basePricePerEA || 0.1;
      price = perEA * ea;
    } else {
      // chemicals by ml (with concentration consideration for "detergent")
      var ml = U.fromBase(base, "ml");
      ml = ml ? ml.qty : qty;
      var ppm = d.basePricePerML || 0.003;
      var cx = d.concentrationX || 1;
      price = (ppm * ml) / Math.max(cx, 1);
    }

    return {
      price: round2(price),
      currency: Settings.currency,
      source: "commodity-default",
      key: key,
    };
  }

  // ----------------------------- Price Resolution -----------------------------
  function resolvePrice(line, opts) {
    opts = opts || {};
    var storeId = pick(
      line.storeId,
      opts.storeId != null ? opts.storeId : null,
      (StoreSelector.getActiveStoreId && StoreSelector.getActiveStoreId()) ||
        null
    );

    // 1) SKU in PriceBook for store
    if (line.sku && PriceBook && PriceBook.lookup) {
      try {
        var pb = PriceBook.lookup({ sku: line.sku, storeId: storeId });
        if (pb && pb.price != null) {
          return normalizeLineCost(line, pb);
        }
      } catch (_) {}
    }
    // 2) SKU in SupplierCatalog
    if (line.sku && SupplierCatalog && SupplierCatalog.find) {
      try {
        var sc = SupplierCatalog.find({ sku: line.sku, storeId: storeId });
        if (sc && sc.price != null) {
          return normalizeLineCost(line, sc);
        }
      } catch (_) {}
    }
    // 3) Inventory current price
    if (Inventory && Inventory.priceFor) {
      try {
        var invPrice = Inventory.priceFor({
          sku: line.sku,
          name: line.name,
          storeId: storeId,
        });
        if (invPrice && invPrice.price != null) {
          return normalizeLineCost(line, invPrice);
        }
      } catch (_) {}
    }
    // 4) Try alt substitutions (if any)
    if (Array.isArray(line.alt)) {
      for (var i = 0; i < line.alt.length; i++) {
        var alt = Object.assign({}, line, line.alt[i] || {});
        var altResolved = resolvePrice(alt, opts);
        if (altResolved) {
          altResolved.substitution = true;
          return altResolved;
        }
      }
    }
    // 5) Commodity defaults (detergent/feed/seed/etc.)
    var fallback = priceFromCommodityDefault(line);
    if (fallback) {
      return normalizeLineCost(line, {
        price: fallback.price,
        currency: fallback.currency,
        packQty: line.qty, // assume right-sized
        packUnit: line.unit,
        source: fallback.source,
        meta: { commodityKey: fallback.key },
      });
    }

    // 6) Unknown → zero price but return structured
    return normalizeLineCost(line, {
      price: 0,
      currency: Settings.currency,
      source: "unknown",
    });
  }

  function normalizeLineCost(line, priceRef) {
    // priceRef: { price, currency, packQty, packUnit, lastUpdated, source, meta? }
    var qty = toNum(line.qty, 1);
    var unit = line.unit || "ea";

    var needBase = U.toBase(qty, unit);
    var packQty = pick(priceRef.packQty, qty);
    var packUnit = pick(priceRef.packUnit, unit);

    var packBase = U.toBase(packQty, packUnit);

    // If a pack size is defined, use packsNeeded to determine how many to buy
    var packCount = 1;
    if (priceRef.packQty != null && priceRef.packUnit) {
      var pn = U.packsNeeded(needBase.qty, packBase.qty);
      packCount = Math.max(1, pn.count);
    }

    var price = toNum(priceRef.price, 0);
    var lineCost = round2(price * packCount);

    return {
      id: id("li"),
      sku: line.sku || null,
      name: line.name || "Item (" + (line.group || "misc") + ")",
      group: line.group || null,
      qty: qty,
      unit: unit,
      storeId: line.storeId || null,
      pack: { qty: packQty, unit: packUnit, count: packCount },
      priceEachPack: round2(price),
      lineTotal: lineCost,
      currency: priceRef.currency || Settings.currency,
      source: priceRef.source || "pricebook",
      meta: Object.assign({}, priceRef.meta || {}, {
        substitution: !!line.substitution,
      }),
    };
  }

  // ----------------------------- Utilities Estimator -----------------------------
  function estimateUtilities(task, opts) {
    opts = opts || {};
    var rates = Object.assign(
      {},
      Settings.utilityRates,
      opts.utilityRates || {}
    );
    var a = task.appliance || null;
    if (!a) return { total: 0, items: [], notes: [] };

    var minutes = toNum(a.minutes, 0);
    if (!minutes) return { total: 0, items: [], notes: [] };

    var notes = [];
    var items = [];
    var total = 0;

    function pushItem(label, cost, meta) {
      items.push({
        id: id("util"),
        label: label,
        cost: round2(cost),
        currency: Settings.currency,
        meta: meta || {},
      });
      total += cost;
    }

    // Electricity (kWh = watts * hours / 1000)
    if (a.watts && (!a.fuel || a.fuel === "electric")) {
      var kwh = (toNum(a.watts, 0) * (minutes / 60)) / 1000;
      var costE = kwh * toNum(rates.electricity_kwh, 0.15);
      pushItem("Electricity (" + round2(kwh) + " kWh)", costE, { kwh: kwh });
    }

    // Gas (approx: BTU → therm; 1 therm = 100,000 BTU)
    if (a.btu && a.fuel === "gas") {
      var btu = toNum(a.btu, 0) * (minutes / 60); // if BTU provided as per-hour rating
      var therms = btu / 100000;
      var costG = therms * toNum(rates.natural_gas_therm, 1.2);
      pushItem("Natural Gas (" + round2(therms) + " therms)", costG, {
        therms: therms,
      });
    }

    // Water (assume liters used if present; else estimate for washers/dishwashers)
    var litersUsed = toNum(a.liters, 0);
    if (!litersUsed) {
      var k = lower(a.kind || "");
      if (k === "washer") litersUsed = 60; // typical per cycle
      if (k === "dishwasher") litersUsed = 15; // economy cycle
      if (k === "kettle") litersUsed = 1.5;
    }
    if (litersUsed) {
      // 1,000 gal ≈ 3,785 L
      var costPerL = toNum(rates.water_1000gal, 5) / 3785;
      var costW = litersUsed * costPerL;
      pushItem("Water (" + round2(litersUsed) + " L)", costW, {
        liters: litersUsed,
      });
    }

    return { total: round2(total), items: items, notes: notes };
  }

  // ----------------------------- Line Item Builder -----------------------------
  function coalesceResources(resources) {
    // merges duplicates by sku+unit to compute combined qty before pack resolution
    if (!Array.isArray(resources) || !resources.length) return [];
    var map = Object.create(null);
    for (var i = 0; i < resources.length; i++) {
      var r = resources[i] || {};
      var k =
        (r.sku ? "sku:" + r.sku : "name:" + lower(r.name || "")) +
        "|" +
        lower(r.unit || "ea");
      if (!map[k]) map[k] = Object.assign({}, r);
      else map[k].qty = toNum(map[k].qty, 0) + toNum(r.qty, 0);
    }
    return Object.keys(map).map(function (k) {
      return map[k];
    });
  }

  function estimateLineItemsFromTask(task, opts) {
    opts = opts || {};
    var resources = coalesceResources(task.resources || []);
    var items = [];
    for (var i = 0; i < resources.length; i++) {
      var r = resources[i] || {};
      // Respect “shortage-ok” flag by skipping price lookup if qty=0 or missing
      if (!toNum(r.qty, 0)) continue;

      // Apply concentration/dilution note if present in task.meta
      if (task.meta && task.meta.concentration && r.name) {
        var key = Object.keys(task.meta.concentration).find(function (k) {
          return lower(r.name).indexOf(lower(k)) >= 0;
        });
        if (key) {
          // reduce effective qty by factor
          var factor = toNum(task.meta.concentration[key], 1);
          if (factor > 1) {
            // convert requested qty to base, then divide; maintain unit for price resolution
            var base = U.toBase(r.qty, r.unit);
            base.qty = base.qty / factor;
            // attempt to convert back; if fails keep original but mark virtual reduction
            var back = U.fromBase(base, r.unit) || {
              qty: r.qty / factor,
              unit: r.unit,
            };
            r.qty = back.qty;
          }
        }
      }

      var normalized = resolvePrice(r, {
        storeId: pick(
          task.storeId,
          task.location && task.location.storeId,
          null
        ),
      });
      items.push(normalized);
    }
    return items;
  }

  // ----------------------------- Estimators -----------------------------
  function estimateTaskCost(task, opts) {
    opts = opts || {};
    try {
      var lines = estimateLineItemsFromTask(task, opts) || [];
      var utilities = estimateUtilities(task, opts);
      var subtotal = 0;
      for (var i = 0; i < lines.length; i++)
        subtotal += toNum(lines[i].lineTotal, 0);
      var total = subtotal + toNum(utilities.total, 0);

      // Domain-specific overheads (shrinkage, waste, disposables)
      var overhead = 0;
      var overheadNotes = [];
      var kind = lower(task.kind || "");

      if (kind === "cooking" || kind === "butchery") {
        // bags/gloves if not already included
        var hasBags = lines.some(function (li) {
          return (li.group || "").toLowerCase().indexOf("bag") >= 0;
        });
        if (!hasBags) {
          overhead += 0.5;
          overheadNotes.push("Packaging disposables");
        }
      }

      if (kind === "garden") {
        // seedling mortality +10% cost factor
        var seedCost = lines
          .filter(function (li) {
            return (li.group || "").toLowerCase().indexOf("seed") >= 0;
          })
          .reduce(function (s, li) {
            return s + toNum(li.lineTotal, 0);
          }, 0);
        if (seedCost > 0) {
          var add = round2(seedCost * 0.1);
          overhead += add;
          overheadNotes.push("Seed/seedling loss buffer");
        }
      }

      if (kind === "cleaning") {
        // rags/filters assumed small cost
        overhead += 0.25;
        overheadNotes.push("Consumables buffer");
      }

      // Taxes (simple %; override via SettingsStore.utilityRates.sales_tax or dedicated Tax service)
      var taxRate =
        Settings.utilityRates && Settings.utilityRates.sales_tax
          ? toNum(Settings.utilityRates.sales_tax, 0)
          : 0;
      var taxable = subtotal; // utilities typically non-taxed; depends on locale
      var tax = round2(taxable * taxRate);

      total = round2(total + overhead + tax);

      var result = {
        id: id("est"),
        taskId: task.id || null,
        title: task.title || null,
        kind: task.kind || null,
        currency: Settings.currency,
        items: lines,
        utilities: utilities,
        overhead: round2(overhead),
        tax: tax,
        subtotal: round2(subtotal + utilities.total + overhead),
        total: total,
        notes: overheadNotes,
      };

      try {
        eventBus.emit("estimate.created", result);
      } catch (_) {}
      try {
        eventBus.emit("nba.suggestion.created", {
          id: result.id,
          kind: "cost",
          title: "Estimated cost: " + result.currency + " " + result.total,
          actionLabel: "See breakdown",
          action: {
            type: "openEstimateBreakdown",
            params: { estimateId: result.id },
          },
        });
      } catch (_) {}

      return result;
    } catch (e) {
      console.warn("estimateTaskCost error:", e && e.message);
      return {
        id: id("est"),
        taskId: (task && task.id) || null,
        currency: Settings.currency,
        items: [],
        utilities: { total: 0, items: [], notes: [] },
        overhead: 0,
        tax: 0,
        subtotal: 0,
        total: 0,
        notes: ["Error during estimation; returning zero."],
      };
    }
  }

  function estimateSessionCost(tasks, opts) {
    tasks = Array.isArray(tasks) ? tasks : tasks ? [tasks] : [];
    var combined = {
      id: id("est-session"),
      currency: Settings.currency,
      perTask: [],
      items: [],
      utilities: { total: 0, items: [], notes: [] },
      notes: [],
      subtotal: 0,
      tax: 0,
      total: 0,
    };

    var subtotal = 0,
      utilitiesTotal = 0,
      tax = 0,
      overhead = 0;
    for (var i = 0; i < tasks.length; i++) {
      var est = estimateTaskCost(tasks[i], opts);
      combined.perTask.push(est);
      combined.items = combined.items.concat(est.items);
      combined.utilities.items = combined.utilities.items.concat(
        est.utilities.items
      );
      combined.utilities.total += toNum(est.utilities.total, 0);
      combined.notes = combined.notes.concat(est.notes || []);
      subtotal += toNum(est.subtotal, 0);
      tax += toNum(est.tax, 0);
    }
    // Merge duplicate items to see a session shopping list cost
    combined.items = mergeLineItems(combined.items);
    combined.subtotal = round2(subtotal);
    combined.tax = round2(tax);
    combined.total = round2(subtotal + tax);

    try {
      eventBus.emit("estimate.session.created", combined);
    } catch (_) {}
    return combined;
  }

  function mergeLineItems(items) {
    var map = Object.create(null);
    for (var i = 0; i < items.length; i++) {
      var li = items[i] || {};
      var key =
        (li.sku ? "sku:" + li.sku : "name:" + lower(li.name || "")) +
        "|" +
        lower(li.unit || "ea") +
        "|" +
        (li.storeId || "any");
      if (!map[key]) map[key] = Object.assign({}, li);
      else {
        map[key].qty = round2(toNum(map[key].qty, 0) + toNum(li.qty, 0));
        // If pack logic differs, we conservatively add totals
        map[key].lineTotal = round2(
          toNum(map[key].lineTotal, 0) + toNum(li.lineTotal, 0)
        );
      }
    }
    return Object.keys(map).map(function (k) {
      return map[k];
    });
  }

  // ----------------------------- Public API -----------------------------
  var api = {
    estimateLineItemsFromTask: estimateLineItemsFromTask,
    estimateTaskCost: estimateTaskCost,
    estimateSessionCost: estimateSessionCost,
    _internals: {
      U: U,
      resolvePrice: resolvePrice,
      CommodityDefaults: CommodityDefaults,
      priceFromCommodityDefault: priceFromCommodityDefault,
    },
  };

  // UMD-ish export
  try {
    module.exports = api;
  } catch (_) {
    this.estimateEngine = api;
  }
})();
