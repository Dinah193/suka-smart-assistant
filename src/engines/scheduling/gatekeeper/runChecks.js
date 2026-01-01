// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\gatekeeper\runChecks.js
/**
 * Scheduling Gatekeeper — Prereq & Constraint Checks
 * ---------------------------------------------------------------------------
 * Role in pipeline:
 *   imports → intelligence (estimators/calibration) → automation (plans) → gatekeeper (checks) → (optional) hub export
 *
 * What this file does:
 *   - Executes prereq & constraint checks against a compiled plan’s windows (tasks),
 *     optional resource reservations, inventory, household rules (quiet hours,
 *     sabbath guard), domain requirements (cook/clean/garden/animals/preservation/storehouse),
 *     and preferences.
 *   - Emits consistent events on the shared eventBus.
 *   - Provides an extensible registry for global and domain-specific checks.
 *
 * Events (payload = { type, ts, source, data }):
 *   - scheduling.checks.completed
 *   - scheduling.checks.blockers            (emitted when ≥1 blocker exists)
 *   - scheduling.checks.error
 *
 * Hub export:
 *   - This module is read-only by design. It does not mutate household data.
 *   - If callers pass { export: true }, we may export the *results* to the Hub
 *     (for dashboards/analytics), but we NEVER fail the local run if Hub is down.
 *
 * Forward-thinking:
 *   - Domain-agnostic architecture with per-domain rule registration.
 *   - Defensive access to dataGateway (Dexie/IndexedDB/etc.) with in-memory fallback.
 *   - Small helpers are co-located for clarity; feel free to promote to shared utils later.
 */

"use strict";

/* --------------------------------- Imports --------------------------------- */

let eventBus = {
  emit: (...a) => console.debug("[gatekeeper:runChecks:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let featureFlags = { familyFundMode: false /* quietHours?, sabbathGuard? (optional) */ };
try {
  featureFlags = require("@/featureFlags.json");
} catch {}

/** Optional data gateway; used to read inventory, settings, etc. */
let dataGateway = null;
try {
  dataGateway = require("@/services/dataGateway");
  dataGateway = dataGateway?.default || dataGateway;
} catch {}

/* ------------------------------ Local Fallbacks ----------------------------- */

const MEM_SETTINGS = {
  quietHours: { enabled: false, start: "21:00", end: "07:00" }, // local fallback
  sabbathGuard: { enabled: false }, // naive weekday guard when enabled
  dietary: { allergies: [], avoid: [] },
  weather: { allowRain: true, forecast: [] }, // forecast shape: [{ iso, code, mmRain }]
  storehouse: { freeBins: null },
};

const nowISO = () => new Date().toISOString();
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string";
const toMs = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const minToMs = (m) => Math.round(m * 60000);

function emit(type, source, data) {
  eventBus.emit({ type, ts: nowISO(), source, data });
}

/** Optional hub export (results only) — silent failure by requirement. */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    const HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
    const FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
    const formatter = HubPacketFormatter?.default || HubPacketFormatter;
    const connector = FamilyFundConnector?.default || FamilyFundConnector;
    const packet = formatter.format("scheduling.checks", payload);
    await connector.send(packet);
  } catch {
    // swallow
  }
}

/* ---------------------------- Settings & Inventory -------------------------- */

async function readSettingsSafe() {
  try {
    // Prefer gateway KV buckets when present; fall back to memory defaults
    const quiet = (await dataGateway?.kv?.get?.("settings", "quietHours")) ?? MEM_SETTINGS.quietHours;
    const sabbath = (await dataGateway?.kv?.get?.("settings", "sabbathGuard")) ?? MEM_SETTINGS.sabbathGuard;
    const dietary = (await dataGateway?.kv?.get?.("settings", "dietary")) ?? MEM_SETTINGS.dietary;
    const weather = (await dataGateway?.kv?.get?.("weather", "forecast")) ?? MEM_SETTINGS.weather;
    const storehouse = (await dataGateway?.kv?.get?.("settings", "storehouse")) ?? MEM_SETTINGS.storehouse;
    return { quietHours: quiet, sabbathGuard: sabbath, dietary, weather, storehouse };
  } catch {
    return MEM_SETTINGS;
  }
}

async function getInventoryQtySafe(itemKey) {
  try {
    // Support either a simple API or custom table adapter
    if (dataGateway?.inventory?.getQuantity) {
      return await dataGateway.inventory.getQuantity(itemKey);
    }
    if (dataGateway?.kv?.get) {
      const inv = (await dataGateway.kv.get("inventory", itemKey)) ?? { qty: 0 };
      return Number(inv.qty || 0);
    }
  } catch {}
  return 0;
}

/* --------------------------------- Registry --------------------------------- */
/**
 * A Check function receives:
 *   (ctx) => Array<Issue>
 *
 * Where ctx is:
 *   {
 *     planId, planMeta, windows, reservations, conflicts,
 *     settings: { quietHours, sabbathGuard, dietary, weather, storehouse },
 *     featureFlags
 *   }
 *
 * Issue shape:
 *   {
 *     id: string,
 *     severity: "info"|"warn"|"error"|"blocker",
 *     scope: "plan"|"window",
 *     windowId?: string,
 *     domain?: string,
 *     code: string,               // machine-friendly code
 *     title: string,
 *     detail?: string,
 *     refs?: object               // any structured references
 *   }
 */

const GLOBAL_CHECKS = [];
const DOMAIN_CHECKS = new Map(); // domain -> Array<CheckFn>

function registerGlobalCheck(fn) {
  if (typeof fn === "function") GLOBAL_CHECKS.push(fn);
}
function registerDomainCheck(domain, fn) {
  const d = String(domain || "").toLowerCase();
  if (!DOMAIN_CHECKS.has(d)) DOMAIN_CHECKS.set(d, []);
  DOMAIN_CHECKS.get(d).push(fn);
}

/* ---------------------------- Built-in Global Checks ------------------------ */

/** Quiet Hours guard (soft by default: warn; can be escalated via settings) */
registerGlobalCheck(function quietHoursCheck(ctx) {
  const issues = [];
  const q = ctx.settings?.quietHours;
  if (!q?.enabled) return issues;

  const [startH, startM] = String(q.start || "21:00").split(":").map((n) => parseInt(n, 10));
  const [endH, endM] = String(q.end || "07:00").split(":").map((n) => parseInt(n, 10));

  for (const w of ctx.windows) {
    const s = new Date(w.startISO);
    const withinQuiet =
      (s.getHours() > startH || (s.getHours() === startH && s.getMinutes() >= startM)) ||
      (s.getHours() < endH || (s.getHours() === endH && s.getMinutes() <= endM));

    if (withinQuiet) {
      issues.push({
        id: `quiet-${w.id}`,
        severity: "warn",
        scope: "window",
        windowId: w.id,
        domain: w.domain || "generic",
        code: "QUIET_HOURS",
        title: "Window falls in quiet hours",
        detail: `Starts at ${w.startISO}. Quiet hours ${q.start}-${q.end}.`,
      });
    }
  }
  return issues;
});

/** Sabbath guard (naive Fri sunset→Sat sunset proxy: Fri 18:00–Sat 19:00 local) */
registerGlobalCheck(function sabbathGuardCheck(ctx) {
  const s = ctx.settings?.sabbathGuard;
  if (!s?.enabled) return [];
  const issues = [];

  for (const w of ctx.windows) {
    const d = new Date(w.startISO);
    const dow = d.getDay(); // 0 Sun .. 6 Sat
    // very coarse proxy: block if Fri evening or Sat (caller can override)
    const isWithin =
      (dow === 5 && d.getHours() >= 18) || // Fri >= 18:00
      (dow === 6 && d.getHours() < 19);    // Sat < 19:00

    if (isWithin) {
      issues.push({
        id: `sabbath-${w.id}`,
        severity: "blocker",
        scope: "window",
        windowId: w.id,
        domain: w.domain || "generic",
        code: "SABBATH_GUARD",
        title: "Falls within Sabbath guard",
        detail: "Window overlaps Sabbath guard period. Reschedule required.",
      });
    }
  }
  return issues;
});

/** Resource allocator conflicts bubble-up */
registerGlobalCheck(function resourceConflictsCheck(ctx) {
  const issues = [];
  for (const c of ctx.conflicts || []) {
    issues.push({
      id: `res-conf-${c.taskId || c.type}`,
      severity: c.type === "capacityUnmet" ? "blocker" : "error",
      scope: "plan",
      code: `RESOURCE_${String(c.type || "CONFLICT").toUpperCase()}`,
      title: "Resource allocation conflict",
      detail: JSON.stringify(c),
      refs: c,
    });
  }
  return issues;
});

/* -------------------------- Built-in Domain Checks -------------------------- */

/** Cooking: diet/allergy & preheat/prep readiness hints */
registerDomainCheck("cooking", function cookingDietAllergyCheck(ctx) {
  const issues = [];
  const allergies = new Set(ctx.settings?.dietary?.allergies || []);
  if (!allergies.size) return issues;

  for (const w of ctx.windows.filter((x) => (x.domain || "generic") === "cooking")) {
    const tags = (w.tags || []).map((t) => String(t).toLowerCase());
    // If the plan attaches ingredients to windows, they can appear in w.ingredients: [{name, qty, unit}]
    const ing = (w.ingredients || []).map((i) => String(i.name || "").toLowerCase());
    const hit = ing.find((i) => allergies.has(i)) || tags.find((t) => allergies.has(t));
    if (hit) {
      issues.push({
        id: `diet-${w.id}-${hit}`,
        severity: "blocker",
        scope: "window",
        windowId: w.id,
        domain: "cooking",
        code: "DIET_ALLERGY",
        title: "Allergy ingredient detected",
        detail: `Contains ${hit}. Remove/replace or exclude allergic participant.`,
        refs: { hit, windowId: w.id },
      });
    }
  }
  return issues;
});

/** Preservation: jars/lids availability from inventory if quantities are provided */
registerDomainCheck("preservation", async function preservationJarLidCheck(ctx) {
  const issues = [];
  for (const w of ctx.windows.filter((x) => (x.domain || "generic") === "preservation")) {
    const needJars = Number(w.materials?.jars || 0);
    const needLids = Number(w.materials?.lids || 0);
    if (!needJars && !needLids) continue;

    const haveJars = needJars ? await getInventoryQtySafe("jar.pint|quart|halfgal") : 0;
    const haveLids = needLids ? await getInventoryQtySafe("lid.standard|wide") : 0;

    if (needJars && haveJars < needJars) {
      issues.push({
        id: `jar-short-${w.id}`,
        severity: "error",
        scope: "window",
        windowId: w.id,
        domain: "preservation",
        code: "INVENTORY_SHORTAGE",
        title: "Not enough jars",
        detail: `Need ${needJars}, have ~${haveJars}.`,
        refs: { needJars, haveJars },
      });
    }
    if (needLids && haveLids < needLids) {
      issues.push({
        id: `lid-short-${w.id}`,
        severity: "error",
        scope: "window",
        windowId: w.id,
        domain: "preservation",
        code: "INVENTORY_SHORTAGE",
        title: "Not enough lids",
        detail: `Need ${needLids}, have ~${haveLids}.`,
        refs: { needLids, haveLids },
      });
    }
  }
  return issues;
});

/** Garden: weather window (skip if allowRain) */
registerDomainCheck("garden", function gardenWeatherCheck(ctx) {
  const issues = [];
  const wx = ctx.settings?.weather;
  if (!wx || wx.allowRain) return issues;
  const fc = Array.isArray(wx.forecast) ? wx.forecast : [];

  for (const w of ctx.windows.filter((x) => (x.domain || "generic") === "garden")) {
    const t = toMs(w.startISO);
    if (t == null) continue;
    // naive match: find forecast cell +-60min
    const bucket = fc.find((cell) => {
      const ct = toMs(cell.iso);
      return ct != null && Math.abs(ct - t) <= minToMs(60);
    });
    if (bucket && isNum(bucket.mmRain) && bucket.mmRain > 0) {
      issues.push({
        id: `rain-${w.id}`,
        severity: "warn",
        scope: "window",
        windowId: w.id,
        domain: "garden",
        code: "WEATHER_RAIN",
        title: "Rain expected near start time",
        detail: `~${bucket.mmRain}mm forecast around ${bucket.iso}. Consider rescheduling.`,
        refs: { forecast: bucket },
      });
    }
  }
  return issues;
});

/** Animals: feed/bedding check if materials specified on window */
registerDomainCheck("animals", async function animalsSuppliesCheck(ctx) {
  const issues = [];
  for (const w of ctx.windows.filter((x) => (x.domain || "generic") === "animals")) {
    const needFeed = Number(w.materials?.feedKg || 0);
    const needBedding = Number(w.materials?.beddingKg || 0);
    if (!needFeed && !needBedding) continue;

    const haveFeed = needFeed ? await getInventoryQtySafe("feed.mixedKg") : 0;
    const haveBedding = needBedding ? await getInventoryQtySafe("bedding.strawKg") : 0;

    if (needFeed && haveFeed < needFeed) {
      issues.push({
        id: `feed-short-${w.id}`,
        severity: "error",
        scope: "window",
        windowId: w.id,
        domain: "animals",
        code: "INVENTORY_SHORTAGE",
        title: "Insufficient animal feed",
        detail: `Need ${needFeed}kg, have ~${haveFeed}kg.`,
      });
    }
    if (needBedding && haveBedding < needBedding) {
      issues.push({
        id: `bedding-short-${w.id}`,
        severity: "error",
        scope: "window",
        windowId: w.id,
        domain: "animals",
        code: "INVENTORY_SHORTAGE",
        title: "Insufficient bedding",
        detail: `Need ${needBedding}kg, have ~${haveBedding}kg.`,
      });
    }
  }
  return issues;
});

/** Storehouse: free bin capacity (if set) */
registerDomainCheck("storehouse", function storehouseCapacityCheck(ctx) {
  const issues = [];
  const freeBins = ctx.settings?.storehouse?.freeBins;
  if (!isNum(freeBins)) return issues;

  // If any storehouse window plans to stash more bins than freeBins (via materials.bins)
  for (const w of ctx.windows.filter((x) => (x.domain || "generic") === "storehouse")) {
    const needBins = Number(w?.materials?.bins || 0);
    if (needBins > freeBins) {
      issues.push({
        id: `bins-short-${w.id}`,
        severity: "error",
        scope: "window",
        windowId: w.id,
        domain: "storehouse",
        code: "CAPACITY_SHORTAGE",
        title: "Not enough free bins",
        detail: `Need ${needBins}, free ${freeBins}.`,
      });
    }
  }
  return issues;
});

/* ------------------------------- Public API -------------------------------- */
/**
 * Execute all checks.
 *
 * @param {Object} req
 *  - planId: string
 *  - planMeta?: object
 *  - windows: Array<{ id, domain?, startISO, endISO, materials?, ingredients?, tags?, requirements? }>
 *  - reservations?: Array   // from resource allocator
 *  - conflicts?: Array      // from resource allocator
 *  - export?: boolean
 *
 * @returns {Promise<{
 *   planId: string,
 *   ok: boolean,
 *   counts: { info: number, warn: number, error: number, blocker: number },
 *   issues: Array,
 *   byWindow: Record<string, Array>,
 *   ts: string
 * }>}
 */
async function runChecks(req = {}) {
  const source = "engines/scheduling/gatekeeper/runChecks.runChecks";

  try {
    const planId = String(req.planId || "").trim() || `ad-hoc-${Date.now()}`;
    const windows = Array.isArray(req.windows) ? req.windows.slice() : [];
    const reservations = Array.isArray(req.reservations) ? req.reservations.slice() : [];
    const conflicts = Array.isArray(req.conflicts) ? req.conflicts.slice() : [];

    if (!windows.length) {
      const message = "No windows provided.";
      emit("scheduling.checks.error", source, { message, planId });
      return { planId, ok: false, counts: zeroCounts(), issues: [], byWindow: {}, ts: nowISO() };
    }

    // Read settings/preferences safely
    const settings = await readSettingsSafe();

    // Build context passed to all checks
    const ctx = {
      planId,
      planMeta: req.planMeta || {},
      windows,
      reservations,
      conflicts,
      settings,
      featureFlags,
    };

    // 1) Run all global checks
    const collected = [];
    for (const fn of GLOBAL_CHECKS) {
      const out = await maybeAsync(fn, ctx);
      if (Array.isArray(out)) collected.push(...out);
    }

    // 2) Run domain checks per present domain
    const present = new Set(windows.map((w) => (w.domain || "generic").toLowerCase()));
    for (const d of present) {
      const fns = DOMAIN_CHECKS.get(d) || [];
      for (const fn of fns) {
        const out = await maybeAsync(fn, ctx);
        if (Array.isArray(out)) {
          // tag domain if missing
          for (const issue of out) {
            if (!issue.domain) issue.domain = d;
          }
          collected.push(...out);
        }
      }
    }

    // 3) Normalize + index by window
    const issues = collected.map(normalizeIssue);
    const counts = countSeverities(issues);
    const byWindow = {};
    for (const it of issues) {
      if (it.scope === "window" && it.windowId) {
        if (!byWindow[it.windowId]) byWindow[it.windowId] = [];
        byWindow[it.windowId].push(it);
      }
    }

    const ok = counts.blocker === 0;
    const payload = { planId, ok, counts, issues, byWindow, ts: nowISO(), planMeta: ctx.planMeta };

    // Emit events
    emit("scheduling.checks.completed", source, payload);
    if (!ok) {
      emit("scheduling.checks.blockers", source, payload);
    }

    if (req.export === true) {
      await exportToHubIfEnabled({ action: "checks.completed", ...payload });
    }

    return payload;
  } catch (err) {
    emit("scheduling.checks.error", "engines/scheduling/gatekeeper/runChecks.runChecks", {
      message: String(err?.message || err),
    });
    return { planId: String(req?.planId || ""), ok: false, counts: zeroCounts(), issues: [], byWindow: {}, ts: nowISO() };
  }
}

/* -------------------------------- Internals -------------------------------- */

function zeroCounts() {
  return { info: 0, warn: 0, error: 0, blocker: 0 };
}

function normalizeIssue(i) {
  return {
    id: String(i.id || `issue-${Math.random().toString(36).slice(2, 8)}`),
    severity: oneOf(i.severity, ["info", "warn", "error", "blocker"], "info"),
    scope: oneOf(i.scope, ["plan", "window"], "plan"),
    windowId: i.windowId,
    domain: (i.domain || "generic").toLowerCase(),
    code: String(i.code || "CHECK"),
    title: String(i.title || "Check"),
    detail: isStr(i.detail) ? i.detail : JSON.stringify(i.detail || ""),
    refs: i.refs || null,
  };
}

function oneOf(v, allowed, def) {
  return allowed.includes(v) ? v : def;
}

function countSeverities(list) {
  const c = zeroCounts();
  for (const it of list) {
    c[it.severity] += 1;
  }
  return c;
}

async function maybeAsync(fn, arg) {
  const out = fn?.(arg);
  if (out && typeof out.then === "function") return await out;
  return out;
}

/* --------------------------------- Exports ---------------------------------- */
module.exports = {
  runChecks,
  registerGlobalCheck,
  registerDomainCheck,
  // for tests/ext
  _internals: {
    readSettingsSafe,
    getInventoryQtySafe,
  },
};
