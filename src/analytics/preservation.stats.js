// C:\Users\larho\suka-smart-assistant\src\analytics\preservation.stats.js
// -----------------------------------------------------------------------------
// Suka Smart Assistant – Preservation Stats
// -----------------------------------------------------------------------------
// PURPOSE
// Track how the household is preserving food across domains:
//  - meals → leftovers preserved (rare, but possible)
//  - garden → harvest → preservation
//  - animals/butchery → meat preservation
//  - storehouse → restock via preservation (dehydrate, can, ferment)
//
// This file is part of the pipeline:
//   imports → normalize → intelligence (TagEngine, KnowledgeGraph, GraphLinker)
//   → automation → **analytics (this file)** → (optional) Hub export
//
// EVENTS WE CARE ABOUT
// - preservation.completed        ← main signal
// - garden.harvest.logged         ← potential for preservation
// - animal/butchery session done  ← future; treat as “preserve meat” opportunity
// - import.parsed                 ← detect preservation instructions on import
//
// WHAT WE TRACK
// - method usage count: can, dehydrate, freeze, ferment, cure, smoke
// - by-domain usage: garden, animal, storehouse, meals
// - success/failure: if event has data.success === false, we track as failure
// - seasonality: per month/year
// - yield: weightIn / weightOut when present
//
// EXPORT TO HUB?
// - YES, when a real preservation is completed (food actually stored)
// - NO, for pure analytics or “potential” signals
//
// FORWARD THINKING
// - easy to add new methods: just add to METHOD_ALIASES
// - easy to add new triggering events
//
// -----------------------------------------------------------------------------

import eventBus from "@/services/events/eventBus.js";
import featureFlags from "@/config/featureFlags.json";

// soft hub deps
let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  // eslint-disable-next-line import/no-unresolved, global-require
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter.js");
  // eslint-disable-next-line import/no-unresolved, global-require
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector.js");
} catch (_) {
  // optional
}

const isBrowser = typeof window !== "undefined";

// in-memory store
// stats = {
//   "can": {
//     method: "can",
//     total: 4,
//     success: 4,
//     failure: 0,
//     byDomain: { garden: 3, animal: 1 },
//     byMonth: { "2025-07": 2, "2025-08": 1, ... },
//     totalWeightIn: 10.2,
//     totalWeightOut: 9.8,
//     lastSeen: ISO,
//     firstSeen: ISO,
//     sources: ["import:...", ...],
//   },
//   ...
// }
const stats = Object.create(null);

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------
function nowIso() {
  return new Date().toISOString();
}

function emitEvent(type, data = {}) {
  const evt = { type, ts: nowIso(), source: "analytics:preservation", data };
  try {
    eventBus?.emit?.(evt);
  } catch (_) {
    // never crash analytics
  }
  return evt;
}

async function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode) return;
  if (!HubPacketFormatter || !FamilyFundConnector) return;
  try {
    const packet = HubPacketFormatter.format(payload);
    if (!packet) return;
    await FamilyFundConnector.send(packet);
  } catch (_) {
    // silent
  }
}

function norm(s = "") {
  return s.toString().trim().toLowerCase();
}

function getMonthKey(ts) {
  const d = ts ? new Date(ts) : new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  return `${y}-${m.toString().padStart(2, "0")}`;
}

// known preservation methods & aliases
const METHOD_ALIASES = {
  can: ["can", "canning", "water bath", "pressure can"],
  dehydrate: ["dehydrate", "dehydration", "dry", "sun dry"],
  freeze: ["freeze", "freezing", "frozen"],
  ferment: ["ferment", "fermentation", "kimchi", "sauerkraut", "brine"],
  cure: ["cure", "curing", "salt cure"],
  smoke: ["smoke", "smoking"],
  pickle: ["pickle", "pickling"],
};

// detect method from free text or payload.method
function detectMethod(payload = {}) {
  const fromField = norm(payload.method || payload.preservationMethod || "");
  if (fromField) {
    const direct = matchMethod(fromField);
    if (direct) return direct;
  }

  const text = (
    payload.title ||
    payload.text ||
    payload.description ||
    payload.notes ||
    ""
  ).toLowerCase();

  if (!text) return "other";

  return matchMethod(text) || "other";
}

function matchMethod(txt = "") {
  const t = txt.toLowerCase();
  for (const [method, aliases] of Object.entries(METHOD_ALIASES)) {
    if (aliases.some((a) => t.includes(a))) {
      return method;
    }
  }
  return null;
}

function detectDomainFromEvent(evt = {}) {
  const t = (evt.type || "").toLowerCase();
  const d = evt.data || {};

  // direct from event
  if (d.domain) return d.domain;

  if (t.includes("garden")) return "garden";
  if (t.includes("animal") || t.includes("butcher")) return "animal";
  if (t.includes("storehouse")) return "storehouse";
  if (t.includes("meal")) return "meals";
  if (t.includes("import")) {
    const k = (d.kind || "").toLowerCase();
    if (k.includes("garden")) return "garden";
    if (k.includes("animal")) return "animal";
    if (k.includes("store")) return "storehouse";
    if (k.includes("recipe") || k.includes("meal")) return "meals";
  }
  return "other";
}

function upsertMethod(
  method,
  domain,
  evtTs,
  sourceId,
  weightIn,
  weightOut,
  successFlag
) {
  const key = method || "other";
  const monthKey = getMonthKey(evtTs);
  const iso = typeof evtTs === "string" ? evtTs : nowIso();

  if (!stats[key]) {
    stats[key] = {
      method: key,
      total: 0,
      success: 0,
      failure: 0,
      byDomain: Object.create(null),
      byMonth: Object.create(null),
      totalWeightIn: 0,
      totalWeightOut: 0,
      lastSeen: iso,
      firstSeen: iso,
      sources: [],
    };
  }

  const entry = stats[key];
  entry.total += 1;
  entry.lastSeen = iso;
  if (!entry.firstSeen) entry.firstSeen = iso;

  if (domain) {
    entry.byDomain[domain] = (entry.byDomain[domain] || 0) + 1;
  }
  entry.byMonth[monthKey] = (entry.byMonth[monthKey] || 0) + 1;

  // success/failure
  if (successFlag === false) {
    entry.failure += 1;
  } else {
    entry.success += 1;
  }

  // weight
  if (typeof weightIn === "number") entry.totalWeightIn += weightIn;
  if (typeof weightOut === "number") entry.totalWeightOut += weightOut;

  // sources – keep latest 10
  if (sourceId) {
    entry.sources.unshift(sourceId);
    if (entry.sources.length > 10) entry.sources.length = 10;
  }

  // emit per-method update
  emitEvent("analytics.preservation.method.updated", {
    method: entry.method,
    domain,
    month: monthKey,
    total: entry.total,
    successRate: calcSuccessRate(entry),
  });

  return entry;
}

function calcSuccessRate(entry) {
  const total = entry.total || 0;
  if (!total) return 0;
  return entry.success / total;
}

// -----------------------------------------------------------------------------
// event listener init
// -----------------------------------------------------------------------------
function initListener() {
  const bus = eventBus || (isBrowser ? window.__suka?.eventBus : null);
  if (!bus || typeof bus.on !== "function") return;

  const handler = async (evt) => {
    if (!evt || !evt.type) return;

    const ts = evt.ts || nowIso();
    const domain = detectDomainFromEvent(evt);

    // 1) Real completed preservation from the system or user
    if (evt.type === "preservation.completed") {
      const method = detectMethod(evt.data || {});
      const srcId =
        evt.data?.id || evt.data?.preservationId || evt.data?.sourceId;
      const weightIn = asNumber(evt.data?.weightIn || evt.data?.weightBefore);
      const weightOut = asNumber(evt.data?.weightOut || evt.data?.weightAfter);
      const successFlag =
        typeof evt.data?.success === "boolean" ? evt.data.success : true;

      const entry = upsertMethod(
        method,
        domain,
        ts,
        srcId,
        weightIn,
        weightOut,
        successFlag
      );

      // this is a REAL household-changing event → export
      await exportToHubIfEnabled({
        kind: "preservation.completed",
        at: ts,
        method: entry.method,
        domain,
        weightIn,
        weightOut,
        successRate: calcSuccessRate(entry),
      });

      return;
    }

    // 2) Garden harvests → potential for preservation
    if (evt.type === "garden.harvest.logged") {
      // we don't know method yet; track as potential
      // use pseudo-method "potential-from-garden"
      const harvest = evt.data?.harvest || [];
      const srcId = evt.data?.id || null;
      const weightIn = asNumber(evt.data?.weight);

      upsertMethod(
        "potential-from-garden",
        "garden",
        ts,
        srcId,
        weightIn,
        null,
        true
      );

      // no export – this is just potential
      return;
    }

    // 3) import.parsed that contains preservation instructions
    if (evt.type === "import.parsed") {
      const data = evt.data || {};
      const text = [
        data.title,
        data.description,
        data.notes,
        data.text,
        ...(Array.isArray(data.steps) ? data.steps : []),
      ]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();

      const hasPreservationWord = Object.values(METHOD_ALIASES).some(
        (aliases) => aliases.some((a) => text.includes(a))
      );

      if (hasPreservationWord) {
        const method = detectMethod(data);
        const srcId = data.id || data.importId || null;
        upsertMethod(method, domain, ts, srcId, null, null, true);
      }

      return;
    }

    // 4) animal/butchery – may imply preservation (freeze/cure)
    if (
      evt.type === "animal.processed" ||
      evt.type === "animal.butchery.completed"
    ) {
      const srcId = evt.data?.id || null;
      const weightOut = asNumber(evt.data?.meatWeight);
      upsertMethod("freeze", "animal", ts, srcId, weightOut, weightOut, true);

      await exportToHubIfEnabled({
        kind: "preservation.completed",
        at: ts,
        method: "freeze",
        domain: "animal",
        weightIn: weightOut,
        weightOut: weightOut,
      });

      return;
    }

    // other events – ignore
  };

  bus.on?.(handler);

  // allow caller to unregister
  return () => {
    bus.off?.(handler);
  };
}

// -----------------------------------------------------------------------------
// public API
// -----------------------------------------------------------------------------
function getAllStats({ limit = 200 } = {}) {
  const list = Object.values(stats);
  list.sort((a, b) => (b.total || 0) - (a.total || 0));
  return list.slice(0, limit).map((e) => ({
    method: e.method,
    total: e.total,
    success: e.success,
    failure: e.failure,
    successRate: calcSuccessRate(e),
    byDomain: e.byDomain,
    byMonth: e.byMonth,
    totalWeightIn: e.totalWeightIn,
    totalWeightOut: e.totalWeightOut,
    lastSeen: e.lastSeen,
  }));
}

function getMethodReport(method) {
  const key = method || "other";
  const entry = stats[key];
  if (!entry) return null;
  return {
    method: entry.method,
    total: entry.total,
    success: entry.success,
    failure: entry.failure,
    successRate: calcSuccessRate(entry),
    byDomain: entry.byDomain,
    byMonth: entry.byMonth,
    totalWeightIn: entry.totalWeightIn,
    totalWeightOut: entry.totalWeightOut,
    lastSeen: entry.lastSeen,
    firstSeen: entry.firstSeen,
  };
}

function prune({ olderThanDays = 180 } = {}) {
  const now = Date.now();
  const maxAge = olderThanDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  Object.keys(stats).forEach((key) => {
    const entry = stats[key];
    const last = new Date(entry.lastSeen).getTime();
    if (now - last > maxAge) {
      delete stats[key];
      removed += 1;
    }
  });
  return removed;
}

// -----------------------------------------------------------------------------
// tiny util
// -----------------------------------------------------------------------------
function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const preservationStats = {
  initListener,
  getAllStats,
  getMethodReport,
  prune,
  // for debugging
  _stats: stats,
};

export default preservationStats;
export { initListener, getAllStats, getMethodReport, prune };
