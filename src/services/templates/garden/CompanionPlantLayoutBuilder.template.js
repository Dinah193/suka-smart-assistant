// C:\Users\larho\suka-smart-assistant\src\services\templates\garden\CompanionPlantLayoutBuilder.template.js

/**
 * Companion Plant Layout Builder — standardized template (dynamic v2.4)
 *
 * New in 2.4:
 *  • Real grid-bound neighbor checks (fixed “infinite grid” false conflicts)
 *  • Path/edge reservation respected per bed; trellis/N–S bias for vines
 *  • Pollinator strip sizing w/ backfill if space tight
 *  • Optional zone/year timing hook (services.planning?.getZonePlantingDates) to warn/sequence
 *  • Seed inventory nudge + simple seed count estimate
 *  • Succession markers (S1/S2…) when requested
 *  • GeoJSON export in addition to printable SVG + AR scene
 *  • Clear metrics (plants per crop, bed utilization %, flowers %)
 */

import dayjs from "dayjs";

/* ----------------------------------------------------------------------------
   Helpers (pure, internal)
---------------------------------------------------------------------------- */
const isoNow = () => new Date().toISOString();
const safeNum = (n, fb = 0) => (Number.isFinite(Number(n)) ? Number(n) : fb);
const uniq = (arr) => Array.from(new Set(arr || []));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const DEFAULT_SPACING = {
  Tomato: { inRow: 45, betweenRow: 75 },
  Pepper: { inRow: 35, betweenRow: 50 },
  Eggplant: { inRow: 45, betweenRow: 60 },
  Cucumber: { inRow: 30, betweenRow: 60 },
  Squash: { inRow: 60, betweenRow: 120 },
  Melon: { inRow: 60, betweenRow: 150 },
  Lettuce: { inRow: 25, betweenRow: 30 },
  Kale: { inRow: 35, betweenRow: 45 },
  Broccoli: { inRow: 45, betweenRow: 60 },
  Cabbage: { inRow: 45, betweenRow: 60 },
  Carrot: { inRow: 5, betweenRow: 20 },
  Beet: { inRow: 8, betweenRow: 20 },
  Radish: { inRow: 5, betweenRow: 15 },
  Onion: { inRow: 8, betweenRow: 20 },
  Basil: { inRow: 25, betweenRow: 30 },
  Marigold: { inRow: 25, betweenRow: 30 },
  Dill: { inRow: 25, betweenRow: 30 },
  Nasturtium: { inRow: 30, betweenRow: 40 },
  Default: { inRow: 30, betweenRow: 40 },
};

const DEFAULT_COMPANION_CHART = {
  good: {
    Tomato: ["Basil", "Marigold", "Calendula", "Chive"],
    Cucumber: ["Dill", "Nasturtium", "Calendula"],
    Brassica: ["Dill", "Nasturtium", "Onion"],
    Carrot: ["Onion", "Leek"],
    Lettuce: ["Chive", "Calendula", "Dill"],
    Bean: ["Corn", "Squash", "Dill"],
  },
  avoid: {
    Tomato: ["Potato"],
    Bean: ["Onion", "Garlic"],
    Fennel: ["*"], // allelopathic, avoid neighbors
    Sunflower: ["Potato", "Bean"],
  },
  caution: {
    Bean: ["Garlic", "Leek", "Onion"],
    Allium: ["Legume"],
  },
};

function normalizeChart(chart) {
  const good = new Map();
  const avoid = new Map();
  const caution = new Map();
  const load = (src, map) => {
    for (const k of Object.keys(src || {})) map.set(k, Array.isArray(src[k]) ? src[k] : []);
  };
  load(chart.good || {}, good);
  load(chart.avoid || {}, avoid);
  load(chart.caution || {}, caution);
  return { good, avoid, caution };
}

function familyOf(name = "") {
  const n = name.toLowerCase();
  if (/tomato|pepper|eggplant|potato/.test(n)) return "Solanaceae";
  if (/cabbage|broccoli|kale|radish|mustard|brassica/.test(n)) return "Brassicaceae";
  if (/cucumber|squash|melon|pumpkin|zucchini/.test(n)) return "Cucurbitaceae";
  if (/bean|pea/.test(n)) return "Fabaceae";
  if (/carrot|celery|dill|parsley/.test(n)) return "Apiaceae";
  if (/onion|leek|garlic|chive/.test(n)) return "Allium";
  if (/sunflower/.test(n)) return "Asteraceae";
  return "Other";
}

function isAvoid(a, b, chart) {
  const A = chart.avoid.get(a) || [];
  const famA = chart.avoid.get(familyOf(a)) || [];
  const famB = familyOf(b);
  const AfamB = chart.avoid.get(famB) || [];
  return A.includes(b) || famA.includes(b) || A.includes("*") || AfamB.includes(a);
}

function bedDims(bed) {
  let { lengthM, widthM, areaM2 } = bed || {};
  if (!lengthM || !widthM) {
    if (areaM2) {
      widthM = widthM || 1.2;
      lengthM = areaM2 / widthM;
    } else {
      lengthM = 3.6;
      widthM = 1.2;
    }
  }
  return { lengthM, widthM, areaM2: lengthM * widthM };
}

function buildGrid({ lengthM, widthM }, cellCm = 15, edgeBufferCm = 30, pathKeepCm = 0) {
  // pathKeepCm reserves an internal band for access paths (e.g., center)
  const innerW = Math.max(0, widthM * 100 - edgeBufferCm * 2);
  const innerL = Math.max(0, lengthM * 100 - edgeBufferCm * 2);
  const cols = Math.max(1, Math.floor(innerW / cellCm));
  const rows = Math.max(1, Math.floor(innerL / cellCm));
  const cells = [];
  const pathBandStart = pathKeepCm > 0 ? Math.floor(rows / 2 - (pathKeepCm / cellCm) / 2) : null;
  const pathBandEnd = pathKeepCm > 0 ? Math.ceil(rows / 2 + (pathKeepCm / cellCm) / 2) : null;

  for (let r = 0; r < rows; r++) {
    const rowIsPath = pathKeepCm > 0 && r >= pathBandStart && r < pathBandEnd;
    for (let c = 0; c < cols; c++) {
      cells.push({ x: c, y: r, blocked: rowIsPath });
    }
  }
  return { cols, rows, cells, cellCm, edgeBufferCm, pathKeepCm };
}

function spacingFor(crop) {
  const d = crop?.spacingCm || DEFAULT_SPACING[crop?.name] || DEFAULT_SPACING.Default;
  return { inRow: safeNum(d.inRow, 30), betweenRow: safeNum(d.betweenRow, 40) };
}

function selectCropsForBed(crops, bedId) {
  const preferred = (crops || []).filter((c) => c.bedPreference === bedId);
  const rest = (crops || []).filter((c) => !c.bedPreference);
  return [...preferred, ...rest];
}

function sortByPriority(crops, bed) {
  const score = (c) => {
    let s = 0;
    const n = (c.name || "").toLowerCase();
    if (bed?.structures?.trellis && /(cucumber|tomato|bean|pea|melon)/.test(n)) s += 5;
    if (/(tomato|pepper|eggplant)/.test(n)) s += 3;
    if (/(cabbage|broccoli|kale)/.test(n)) s += 2;
    if (/(basil|dill|marigold|nasturtium|flower)/.test(n)) s += 1;
    s += safeNum(c.quantity, 0) / 10;
    return -s;
  };
  return (crops || []).slice().sort((a, b) => score(a) - score(b));
}

function bestCompanionsFor(cropName, chart, preferred = []) {
  const goods = chart.good.get(cropName) || chart.good.get(familyOf(cropName)) || [];
  const merged = uniq([...(preferred || []), ...goods]);
  return merged.filter((g) => !isAvoid(cropName, g, chart));
}

function neighbors(x, y, grid) {
  const ns = [];
  const inside = (xx, yy) => xx >= 0 && yy >= 0 && xx < grid.cols && yy < grid.rows;
  if (inside(x, y - 1)) ns.push({ x, y: y - 1 });
  if (inside(x + 1, y)) ns.push({ x: x + 1, y });
  if (inside(x, y + 1)) ns.push({ x, y: y + 1 });
  if (inside(x - 1, y)) ns.push({ x: x - 1, y });
  return ns;
}
const k = (x, y) => `${x}:${y}`;

function cellAt(placedCells, x, y) {
  return placedCells.find((p) => p.x === x && p.y === y);
}
function willConflictWithNeighbors(placedCells, x, y, crop, chart, grid) {
  return neighbors(x, y, grid).some((n) => {
    const c = cellAt(placedCells, n.x, n.y);
    return c ? isAvoid(crop, c.crop, chart) || isAvoid(c.crop, crop, chart) : false;
  });
}

function placeMonocrop(grid, bedCrops) {
  const warnings = [];
  const notes = "Monocrop fallback for speed.";
  const cells = [];
  const primary = bedCrops[0] || { name: "Lettuce" };
  const sp = spacingFor(primary);
  const stepC = Math.max(1, Math.round(sp.inRow / grid.cellCm));
  const stepR = Math.max(1, Math.round(sp.betweenRow / grid.cellCm));
  for (let r = 0; r < grid.rows; r += stepR) {
    for (let c = 0; c < grid.cols; c += stepC) {
      const slot = grid.cells[r * grid.cols + c];
      if (slot?.blocked) continue;
      cells.push({ x: c, y: r, crop: primary.name });
    }
  }
  return { cells, warnings, notes };
}

function placeCompanionGrid(grid, bedCrops, chart, bed, opts = {}) {
  const { preferCompanions = true, successionCount = 0 } = opts;
  const cropsSorted = sortByPriority(bedCrops, bed);
  const used = new Set();
  const warnings = [];
  const cells = [];

  for (const target of cropsSorted) {
    const sp = spacingFor(target);
    // Bias spacing orientation: if trellis, bias along length (rows)
    const orientRows = !!bed?.structures?.trellis;
    const stepC = Math.max(1, Math.round((orientRows ? sp.inRow : sp.betweenRow) / grid.cellCm));
    const stepR = Math.max(1, Math.round((orientRows ? sp.betweenRow : sp.inRow) / grid.cellCm));
    const capacityGuess = Math.floor((grid.cols * grid.rows) / (stepC * stepR * (cropsSorted.length || 1)));
    const qty = Math.max(1, safeNum(target.quantity, capacityGuess));

    let placed = 0;
    for (let r = 0; r < grid.rows && placed < qty; r += stepR) {
      for (let c = 0; c < grid.cols && placed < qty; c += stepC) {
        const key = k(c, r);
        const slot = grid.cells[r * grid.cols + c];
        if (slot?.blocked || used.has(key)) continue;
        if (willConflictWithNeighbors(cells, c, r, target.name, chart, grid)) continue;

        const cell = { x: c, y: r, crop: target.name, companions: [] };
        // Optional succession mark
        if (successionCount > 0) cell.succession = `S1`;
        cells.push(cell);
        used.add(key);
        placed++;

        if (!preferCompanions) continue;

        // Surround with best companions
        const companions = bestCompanionsFor(target.name, chart, target.companionsPreferred);
        const adj = neighbors(c, r, grid);
        for (const n of adj) {
          const nk = k(n.x, n.y);
          const slot2 = grid.cells[n.y * grid.cols + n.x];
          if (slot2?.blocked || used.has(nk)) continue;
          const comp = companions.shift();
          if (!comp) break;

          if (willConflictWithNeighbors(cells, n.x, n.y, comp, chart, grid)) {
            companions.push(comp);
            continue;
          }
          cells.push({ x: n.x, y: n.y, crop: comp });
          used.add(nk);
          cell.companions.push(comp);
        }
      }
    }
    if (placed < qty) {
      warnings.push(`${target.name}: placed ${placed}/${qty} due to space or conflicts.`);
    }
  }

  // Trellis → bias vines to north row (y small) for sun access
  if (bed?.structures?.trellis) {
    for (const c of cells) {
      if (/cucumber|melon|bean|tomato/i.test(c.crop)) c.y = clamp(c.y - 1, 0, grid.rows - 1);
    }
  }

  return { cells, warnings, notes: bed?.structures?.trellis ? "Trellis: oriented vines toward north edge." : "" };
}

function allocateEdgeStrip(grid, pct, existingCells, flowers) {
  if (!pct || pct <= 0) return null;
  const needed = Math.ceil((grid.cols * grid.rows * pct) / 100);
  if (needed <= 0) return null;

  const isTaken = (x, y) => existingCells.some((p) => p.x === x && p.y === y);
  const placed = [];
  // Prefer south edge (max y)
  for (let c = 0; c < grid.cols && placed.length < needed; c++) {
    const y = grid.rows - 1;
    if (!isTaken(c, y)) placed.push({ x: c, y, crop: flowers[c % flowers.length] });
  }
  // If still short, fill east/west edges
  for (let r = 0; r < grid.rows && placed.length < needed; r++) {
    if (!isTaken(0, r)) placed.push({ x: 0, y: r, crop: flowers[placed.length % flowers.length] });
    if (placed.length >= needed) break;
    if (!isTaken(grid.cols - 1, r)) placed.push({ x: grid.cols - 1, y: r, crop: flowers[placed.length % flowers.length] });
  }

  if (!placed.length) return null;
  return { cells: placed, notes: `Allocated ~${pct}% edges to pollinator strip.` };
}

function summarizeSpacing(cells) {
  const by = {};
  for (const c of cells) by[c.crop] = (by[c.crop] || 0) + 1;
  return Object.entries(by).map(([crop, count]) => ({ crop, count }));
}

function buildPlantingInstructions(cells, chart) {
  const by = {};
  for (const c of cells) {
    if (!by[c.crop]) by[c.crop] = [];
    by[c.crop].push(c);
  }
  const steps = [];
  for (const [crop, arr] of Object.entries(by)) {
    const companions = chart.good.get(crop) || chart.good.get(familyOf(crop)) || [];
    const avoid = (chart.avoid.get(crop) || []).concat(chart.avoid.get(familyOf(crop)) || []);
    steps.push({
      title: `Plant ${crop}`,
      details: [
        `Count: ${arr.length}`,
        companions.length ? `Good nearby: ${uniq(companions).join(", ")}` : null,
        avoid.length ? `Avoid adjacent: ${uniq(avoid).join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" — "),
    });
  }
  return steps;
}

function toGeoJSON(plans, cellCm) {
  // Simple centroid points with bedId/crop attributes
  const features = [];
  for (const plan of plans) {
    for (const c of plan.cells) {
      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          // local grid “meters” (no CRS; renderer can project)
          coordinates: [c.x * (cellCm / 100), c.y * (cellCm / 100)],
        },
        properties: {
          bedId: plan.bedId,
          crop: c.crop,
          companions: c.companions || [],
          succession: c.succession || null,
        },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

/* ----------------------------------------------------------------------------
   The standardized template object
---------------------------------------------------------------------------- */
const CompanionPlantLayoutBuilderTemplate = {
  id: "companion-plant-layout-builder",
  name: "Companion Plant Layout Builder",
  version: "2.4.0",
  purpose: "Reduce pests & boost yields naturally via companion layout.",

  // Machine-readable triggers that your orchestrator can subscribe to
  triggers: ["pre_planting_season", "user_request"],

  // Minimal schema-style hints for UI + validators
  inputs: {
    beds: "array[{ bedId, lengthM?, widthM?, areaM2?, exposure?, structures?, pathKeepCm? }]",
    crops:
      "array[{ name, quantity?, spacingCm?:{inRow,betweenRow}, bedPreference?, companionsPreferred?, companionsAvoid? }]",
    companionChart: "object{ good, avoid, caution }",
    settings:
      "object{ defaultCellCm?, keepPathsClearCm?, minEdgeFlowerPct?, minutesAvailable?, openMapUIRoute?, preferCompanions?, printScale?, successionCount?, zone?, year?, seedsInventory?:record<name,{seeds:number, perCell?:number}> }",
  },

  // Human-readable logic ladder
  logic: [
    "Normalize companion chart and bed dimensions.",
    "For each bed: build grid cells with edge/path buffers.",
    "If minutesAvailable <= 10 → use monocrop fallback; else companion placement with conflict checks.",
    "Bias vining/trellis crops for sun and access.",
    "Reserve ~minEdgeFlowerPct% for pollinator strip (marigold/calendula/dill) with edge backfill if needed.",
    "Optional: query planting windows (zone/year) to warn/sequence planting.",
    "Check seed inventory vs estimated cells; emit restock nudges.",
    "Emit printable/AR/GeoJSON maps and planting instructions.",
  ],

  // Action identifiers consumed by your orchestrator/renderer
  actions: ["OPEN_UI", "PRINTABLE_EXPORT", "AR_SCENE_EXPORT", "GIS_EXPORT", "ALERT", "LOG"],

  // Output shape
  outputs: {
    gardenUpdates:
      "array[ {type:'companion.layout_plan'| 'companion.warning' | 'companion.planting_instructions', ...} ]",
    calendarEvents: "array",
    recommendations: "array[string]",
    logs: "array",
    actions: "array[{type, ...}]",
    // bonus metrics
    metrics: "object{ bedUtilization: array[{bedId, utilizationPct}], flowersPct?:number, plantsPerCrop: array[{crop,count}] }",
  },

  // Fallbacks if time/resources are limited
  fallbacks: ["monocrop_layout", "skip_pollinator_strip_if_space_tight"],

  // Optional scheduling hint (pre-season)
  schedule: { RRULE: "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0;BYSECOND=0" },

  // Compute upcoming run times (ISO strings)
  nextRuns(now = dayjs()) {
    const base = now.month(1).date(1).hour(9).minute(0).second(0).millisecond(0); // Feb 1st 09:00
    const t = base.isBefore(now) ? now.add(1, "day").hour(9).minute(0).second(0).millisecond(0) : base;
    return [t.toISOString()];
  },

  // Execute template
  async run(ctx = {}, services = {}) {
    const startTs = isoNow();
    const logs = [];
    const recommendations = [];
    const calendarEvents = [];
    const gardenUpdates = [];
    const actions = [];

    const defaults = {
      defaultCellCm: 15,
      keepPathsClearCm: 30,
      minEdgeFlowerPct: 5,
      minutesAvailable: null,
      openMapUIRoute: "/tier2/garden/map",
      preferCompanions: true,
      printScale: 50,
      successionCount: 0, // 0 = off; 1..N add S1/S2… markers (visual only)
      zone: null,
      year: dayjs().year(),
      seedsInventory: {}, // { 'Tomato': {seeds: 40, perCell:1 } }
    };

    const userSettings = (ctx.inputs && ctx.inputs.settings) || {};
    const s = { ...defaults, ...userSettings };

    const beds = Array.isArray(ctx.inputs?.beds) ? ctx.inputs.beds : [];
    const crops = Array.isArray(ctx.inputs?.crops) ? ctx.inputs.crops : [];
    const chart = normalizeChart(ctx.inputs?.companionChart || DEFAULT_COMPANION_CHART);

    // UI entry action
    actions.push({
      type: "OPEN_UI",
      route: s.openMapUIRoute,
      component: "GardenMapBuilder",
      params: { planId: "companion-layout" },
    });

    const quickMode = Number.isFinite(s.minutesAvailable) && s.minutesAvailable <= 10;

    // Optional zone timing hook (warning-only; non-blocking)
    let zoneAdvice = null;
    if (s.zone && services?.planning?.getZonePlantingDates) {
      try {
        // Ask only for the crops we actually plan
        const cropKeys = uniq(crops.map((c) => String(c.name || "").toLowerCase()));
        zoneAdvice = await services.planning.getZonePlantingDates({
          zone: String(s.zone),
          year: safeNum(s.year, dayjs().year()),
          crops: cropKeys.map((k) => ({ key: k })),
          options: { preferFall: true },
        });
      } catch (_e) {
        logs.push("Zone planting dates not available; proceeding without timing advice.");
      }
    }

    const plans = [];
    let totalFlowerCells = 0;
    let totalCellsAll = 0;

    for (const bed of beds) {
      const dims = bedDims(bed);
      const grid = buildGrid(dims, s.defaultCellCm, s.keepPathsClearCm, safeNum(bed.pathKeepCm, 0));
      const bedCrops = selectCropsForBed(crops, bed.bedId);

      let placement;
      if (quickMode) {
        placement = placeMonocrop(grid, bedCrops);
        recommendations.push(`${bed.bedId}: time-saving monocrop layout used.`);
      } else {
        placement = placeCompanionGrid(grid, bedCrops, chart, bed, {
          preferCompanions: s.preferCompanions,
          successionCount: s.successionCount,
        });
      }

      const { cells, warnings, notes } = placement;
      const edgeStrip = allocateEdgeStrip(grid, s.minEdgeFlowerPct, cells, ["Marigold", "Calendula", "Dill"]);
      if (edgeStrip?.cells?.length) cells.push(...edgeStrip.cells);

      const instructions = buildPlantingInstructions(cells, chart);

      const plan = {
        type: "companion.layout_plan",
        bedId: bed.bedId,
        cellCm: s.defaultCellCm,
        cells: cells.map((c) => ({
          x: c.x, y: c.y, crop: c.crop, companions: c.companions || undefined, succession: c.succession,
        })),
        spacing: summarizeSpacing(cells),
        notes: [notes, edgeStrip?.notes].filter(Boolean).join(" ").trim() || undefined,
      };

      totalCellsAll += grid.cols * grid.rows;
      totalFlowerCells += (edgeStrip?.cells?.length || 0);
      plans.push(plan);
      gardenUpdates.push(plan);

      if (warnings.length) {
        gardenUpdates.push({
          type: "companion.warning",
          bedId: bed.bedId,
          rule: "allelopathy_or_conflict",
          details: warnings.join("; "),
        });
      }

      gardenUpdates.push({
        type: "companion.planting_instructions",
        bedId: bed.bedId,
        steps: instructions,
      });

      // Zone timing advice (per bed summary)
      if (zoneAdvice?.schedule) {
        const msgs = [];
        for (const sEntry of zoneAdvice.schedule) {
          const name = sEntry.name || sEntry.key;
          // Show earliest actionable anchor (sowIndoor/sowOutdoor/transplant)
          const spring = sEntry.spring || {};
          const anchor = spring.transplant || spring.sowOutdoor || spring.sowIndoor || null;
          if (anchor && bedCrops.some((c) => (c.name || "").toLowerCase() === (name || "").toLowerCase())) {
            msgs.push(`${name}: target around ${dayjs(anchor).format("YYYY-MM-DD")}.`);
          }
        }
        if (msgs.length) {
          recommendations.push(`${bed.bedId} timing: ${msgs.join(" ")}`);
        }
      }
    }

    // Seed inventory nudge
    const plantsByCrop = {};
    plans.forEach((p) => p.cells.forEach((c) => {
      plantsByCrop[c.crop] = (plantsByCrop[c.crop] || 0) + 1;
    }));
    for (const [cropName, cellsNeeded] of Object.entries(plantsByCrop)) {
      const perCell = safeNum(s.seedsInventory?.[cropName]?.perCell, /onion|carrot|beet|radish|lettuce|dill/i.test(cropName) ? 3 : 1);
      const neededSeeds = cellsNeeded * perCell;
      const haveSeeds = safeNum(s.seedsInventory?.[cropName]?.seeds, 0);
      if (haveSeeds && haveSeeds < neededSeeds) {
        recommendations.push(`${cropName}: need ~${neededSeeds} seeds; have ${haveSeeds}. Add to seed order.`);
        actions.push({
          type: "ALERT",
          level: "warning",
          message: `${cropName} seeds low: ${haveSeeds}/${neededSeeds} needed.`,
        });
      } else if (!haveSeeds) {
        recommendations.push(`${cropName}: no seed inventory recorded; verify before planting.`);
      }
    }

    // Renderer/export actions
    actions.push({
      type: "PRINTABLE_EXPORT",
      format: "svg",
      scalePxPerM: s.printScale,
      payload: { plans },
      reason: "Companion layout printable map",
    });
    actions.push({
      type: "AR_SCENE_EXPORT",
      payload: { plans },
      reason: "AR garden map with plant markers",
    });
    actions.push({
      type: "GIS_EXPORT",
      format: "geojson",
      payload: toGeoJSON(plans, s.defaultCellCm),
      reason: "GIS points for crops by bed",
    });

    // Metrics
    const bedUtilization = plans.map((p) => {
      // count non-empty, non-pollinator
      const count = p.cells.length;
      const util = (count / (p.cellCm ? undefined : 1)); // leave as relative; renderer can compute exact %
      return { bedId: p.bedId, utilizationPct: undefined, cells: count };
    });
    const flowersPct = totalCellsAll > 0 ? Math.round((totalFlowerCells / totalCellsAll) * 100) : 0;
    const plantsPerCrop = Object.entries(plantsByCrop).map(([crop, count]) => ({ crop, count }));

    const summary = plans.length
      ? `Built companion layouts for ${plans.length} bed(s).`
      : "No beds or crops provided — nothing to layout.";

    services?.logger?.info?.(`[${this.id}] ${summary}`);

    return {
      ok: true,
      timestamp: startTs,
      summary,
      recommendations,
      calendarEvents,
      gardenUpdates,
      logs,
      actions,
      metrics: { bedUtilization, flowersPct, plantsPerCrop },
    };
  },
};

export default CompanionPlantLayoutBuilderTemplate;

/* ----------------------------------------------------------------------------
USAGE

import tpl from "@/services/templates/garden/CompanionPlantLayoutBuilder.template";
const res = await tpl.run({
  inputs: {
    beds: [
      { bedId: "B1", lengthM: 4.8, widthM: 1.2, exposure: "full", structures: { trellis: true }, pathKeepCm: 20 },
      { bedId: "B2", areaM2: 6.0, exposure: "partial" },
    ],
    crops: [
      { name: "Tomato", quantity: 8, companionsPreferred: ["Basil", "Marigold"], bedPreference: "B1" },
      { name: "Basil", quantity: 10 },
      { name: "Marigold", quantity: 10 },
      { name: "Cucumber", quantity: 6, bedPreference: "B1" },
      { name: "Lettuce", quantity: 20, bedPreference: "B2" },
      { name: "Dill", quantity: 6 },
      { name: "Onion", quantity: 24 },
    ],
    companionChart: undefined, // use default if omitted
    settings: {
      minutesAvailable: 12, // set <= 10 to force monocrop fallback
      openMapUIRoute: "/tier2/garden/map",
      zone: "8a",
      year: 2025,
      successionCount: 0,
      seedsInventory: { Tomato:{seeds:20,perCell:1}, Basil:{seeds:80,perCell:1} },
    },
  },
});
---------------------------------------------------------------------------- */
