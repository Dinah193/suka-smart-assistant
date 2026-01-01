// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\gatekeeper\txSchedule.js
/**
 * Scheduling Gatekeeper — T-x Readiness Schedules
 * ------------------------------------------------------------
 * Role in pipeline:
 *  imports → intelligence (estimators/calibration) → automation (plans) → gatekeeper (T-x readiness) → (optional) hub export
 *
 * What this file does:
 *  - Builds “T-x” readiness schedules (T-24h / T-2h / T-30m / T-10m / T-0) for daily or ad-hoc session plans.
 *  - Uses domain-aware checklists to generate preflight tasks (cooking, cleaning, garden, animals, preservation, storehouse, generic).
 *  - Emits consistent events to the shared eventBus and can export the schedule to the Hub when familyFundMode is enabled.
 *
 * Event payload shape: { type, ts, source, data }
 * Emitted events:
 *  - scheduling.tx.created
 *  - scheduling.tx.error
 *
 * Forward-thinking:
 *  - Domain rules are pluggable via registerDomainPhaseRules(domain, rules).
 *  - Phases are configurable: e.g., [{label:'T-24h', offsetMin:-1440}, ...]
 *  - Defensive & side-effect safe: stores to dataGateway KV (“txSchedules”) or in-memory fallback.
 */

"use strict";

/* --------------------------------- Imports --------------------------------- */

let eventBus = {
  emit: (...a) => console.debug("[txSchedule:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let featureFlags = { familyFundMode: false };
try {
  featureFlags = require("@/featureFlags.json");
} catch {}

/** Optional data gateway (Dexie/IndexedDB/etc.). Falls back to in-memory. */
let dataGateway = null;
try {
  dataGateway = require("@/services/dataGateway");
  dataGateway = dataGateway?.default || dataGateway;
} catch {}

/* ------------------------------ Local Fallbacks ----------------------------- */

const MEM_SCHEDULES = new Map(); // planId -> T-x schedule snapshot

/* --------------------------------- Helpers --------------------------------- */

const nowISO = () => new Date().toISOString();
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string";

function emit(type, source, data) {
  eventBus.emit({ type, ts: nowISO(), source, data });
}

/** Optional hub export — silent failure. */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    const HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
    const FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
    const formatter = HubPacketFormatter?.default || HubPacketFormatter;
    const connector = FamilyFundConnector?.default || FamilyFundConnector;
    const packet = formatter.format("scheduling.tx", payload);
    await connector.send(packet);
  } catch {
    // swallow
  }
}

function toEpochMs(isoOrDate) {
  if (isoOrDate instanceof Date) return isoOrDate.getTime();
  if (isStr(isoOrDate)) {
    const t = Date.parse(isoOrDate);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function addMinutes(epochMs, minutes) {
  if (!isNum(epochMs) || !isNum(minutes)) return null;
  return epochMs + Math.round(minutes * 60 * 1000);
}

function toISO(epochMs) {
  try {
    return new Date(epochMs).toISOString();
  } catch {
    return null;
  }
}

/* --------------------------- Domain Rule Registry --------------------------- */
/**
 * Each rule function receives:
 *   ({ phase, phaseOffsetMin, plan, windows, ctx }) => ChecklistItem[]
 * ChecklistItem minimal shape:
 *   { id, title, description?, domain, taskIdRef?, severity?: "info"|"warn"|"critical", tags?: string[] }
 */

const _domainRules = new Map();

/** Default generic rules used for any domain lacking custom rules. */
function genericRules({ phase, phaseOffsetMin, plan, windows, ctx }) {
  const items = [];
  if (phase.label === "T-24h") {
    items.push({
      id: `gen-check-inventory-${phaseOffsetMin}`,
      title: "Verify inventory & substitutes",
      description: "Confirm required items exist or plan substitutes; update storehouse goals if short.",
      domain: "generic",
      severity: "info",
      tags: ["inventory", "storehouse", "check"],
    });
  }
  if (phase.label === "T-2h") {
    items.push({
      id: `gen-stage-tools-${phaseOffsetMin}`,
      title: "Stage tools & workspace",
      description: "Clear surfaces, gather tools, sanitize high-touch areas.",
      domain: "generic",
      severity: "info",
      tags: ["tools", "sanitation", "workspace"],
    });
  }
  if (phase.label === "T-30m") {
    items.push({
      id: `gen-brief-household-${phaseOffsetMin}`,
      title: "Brief household",
      description: "Notify participants of upcoming session; confirm resource availability.",
      domain: "generic",
      severity: "info",
      tags: ["people", "brief"],
    });
  }
  if (phase.label === "T-10m") {
    items.push({
      id: `gen-final-go-no-go-${phaseOffsetMin}`,
      title: "Go/No-Go check",
      description: "Verify all critical resources are ready; resolve last-minute conflicts.",
      domain: "generic",
      severity: "critical",
      tags: ["gate", "final"],
    });
  }
  if (phase.label === "T-0") {
    items.push({
      id: `gen-start-session-${phaseOffsetMin}`,
      title: "Start session",
      description: "Begin planned tasks and start first timers.",
      domain: "generic",
      severity: "info",
      tags: ["start"],
    });
  }
  return items;
}

/** Built-in domain rule sets (lightweight, extendable). */
function cookingRules({ phase, windows }) {
  const items = [];
  const cookingWindows = (windows || []).filter((w) => (w.domain || "generic") === "cooking");
  const hasBoil = cookingWindows.some((w) => /boil|blanch|pasta/i.test(w.title || ""));
  if (phase.label === "T-24h") {
    items.push({
      id: "cook-thaw-if-needed",
      title: "Move frozen items to fridge to thaw",
      description: "Safe thawing per weight; adjust based on cut size.",
      domain: "cooking",
      severity: "warn",
      tags: ["thaw", "safety"],
    });
  }
  if (phase.label === "T-2h") {
    items.push({
      id: "cook-preheat-calc",
      title: "Pre-heat equipment calculation",
      description: "Estimate pre-heat times for oven/grill; schedule warm-up.",
      domain: "cooking",
      severity: "info",
      tags: ["preheat", "devices"],
    });
  }
  if (phase.label === "T-30m" && hasBoil) {
    items.push({
      id: "cook-start-pot-water",
      title: "Put pot of water on to boil",
      description: "So water is ready at task start; cover pot to speed up.",
      domain: "cooking",
      severity: "info",
      tags: ["prep-step", "boil"],
    });
  }
  if (phase.label === "T-10m") {
    items.push({
      id: "cook-sanitize-surfaces",
      title: "Sanitize prep surfaces & wash hands",
      description: "Food safety final sweep.",
      domain: "cooking",
      severity: "critical",
      tags: ["sanitation"],
    });
  }
  return items;
}

function cleaningRules({ phase }) {
  const items = [];
  if (phase.label === "T-24h") {
    items.push({
      id: "clean-stock-aromatics",
      title: "Check aromatics & solutions",
      description: "Ensure vinegar/soap/peroxide/essential oils are in stock.",
      domain: "cleaning",
      severity: "info",
      tags: ["aromatics", "inventory"],
    });
  }
  if (phase.label === "T-2h") {
    items.push({
      id: "clean-stage-caddies",
      title: "Stage cleaning caddies",
      description: "Load microfiber, pads, vac filters, PPE.",
      domain: "cleaning",
      severity: "info",
      tags: ["tools"],
    });
  }
  if (phase.label === "T-10m") {
    items.push({
      id: "clean-ventilate",
      title: "Ventilation check",
      description: "Open windows or enable exhaust fans if needed.",
      domain: "cleaning",
      severity: "warn",
      tags: ["safety"],
    });
  }
  return items;
}

function gardenRules({ phase }) {
  const items = [];
  if (phase.label === "T-24h") {
    items.push({
      id: "garden-irrigation-check",
      title: "Check irrigation schedule",
      description: "Adjust watering if harvesting/planting tomorrow.",
      domain: "garden",
      severity: "info",
      tags: ["water", "schedule"],
    });
  }
  if (phase.label === "T-2h") {
    items.push({
      id: "garden-tools-fuel",
      title: "Fuel & sharpen tools",
      description: "Top off fuel; sharpen pruners/hoes.",
      domain: "garden",
      severity: "info",
      tags: ["tools", "fuel"],
    });
  }
  return items;
}

function animalsRules({ phase }) {
  const items = [];
  if (phase.label === "T-24h") {
    items.push({
      id: "animals-feed-bedding-check",
      title: "Check feed & bedding levels",
      description: "Confirm feedKg/beddingKg for the next 24h.",
      domain: "animals",
      severity: "info",
      tags: ["inventory"],
    });
  }
  if (phase.label === "T-2h") {
    items.push({
      id: "animals-pen-prep",
      title: "Prepare pens/stalls",
      description: "Lay fresh bedding; stage handling equipment.",
      domain: "animals",
      severity: "warn",
      tags: ["welfare"],
    });
  }
  return items;
}

function preservationRules({ phase }) {
  const items = [];
  if (phase.label === "T-24h") {
    items.push({
      id: "preserve-jar-lids-count",
      title: "Count jars & lids",
      description: "Ensure jar/lid inventory matches plan volumes.",
      domain: "preservation",
      severity: "info",
      tags: ["inventory", "jars"],
    });
  }
  if (phase.label === "T-2h") {
    items.push({
      id: "preserve-sterilize-gear",
      title: "Sterilize gear & workspace",
      description: "Heat-sanitize jars, rings; wipe surfaces.",
      domain: "preservation",
      severity: "critical",
      tags: ["sanitation"],
    });
  }
  return items;
}

function storehouseRules({ phase }) {
  const items = [];
  if (phase.label === "T-24h") {
    items.push({
      id: "storehouse-space-audit",
      title: "Audit storage space",
      description: "Verify bins/shelves available; plan label ranges.",
      domain: "storehouse",
      severity: "info",
      tags: ["space"],
    });
  }
  if (phase.label === "T-30m") {
    items.push({
      id: "storehouse-label-printers",
      title: "Test label printer",
      description: "Load labels; test a sample code.",
      domain: "storehouse",
      severity: "info",
      tags: ["labels", "devices"],
    });
  }
  return items;
}

/** Register built-in rules */
_domainRules.set("generic", genericRules);
_domainRules.set("cooking", cookingRules);
_domainRules.set("cleaning", cleaningRules);
_domainRules.set("garden", gardenRules);
_domainRules.set("animals", animalsRules);
_domainRules.set("preservation", preservationRules);
_domainRules.set("storehouse", storehouseRules);

/**
 * Public API: register/replace domain rules
 * @param {string} domain lower-case domain key
 * @param {(ctx)=>Array} rulesFn
 */
function registerDomainPhaseRules(domain, rulesFn) {
  const d = String(domain || "").toLowerCase().trim();
  if (!d || typeof rulesFn !== "function") return false;
  _domainRules.set(d, rulesFn);
  return true;
}

/* --------------------------------- Storage ---------------------------------- */

const store = {
  async put(planId, snapshot) {
    try {
      if (dataGateway?.kv?.set) {
        await dataGateway.kv.set("txSchedules", planId, snapshot);
      } else {
        MEM_SCHEDULES.set(planId, snapshot);
      }
    } catch (err) {
      console.warn("[txSchedule.store.put] fallback MEM", err);
      MEM_SCHEDULES.set(planId, snapshot);
    }
  },
  async get(planId) {
    try {
      if (dataGateway?.kv?.get) {
        return (await dataGateway.kv.get("txSchedules", planId)) || null;
      }
      return MEM_SCHEDULES.get(planId) || null;
    } catch (err) {
      console.warn("[txSchedule.store.get] fallback MEM", err);
      return MEM_SCHEDULES.get(planId) || null;
    }
  },
};

/* --------------------------------- Defaults --------------------------------- */
/**
 * Default phases matching the request (24h/2h/30m/10m/0).
 * Offsets are in minutes relative to T0 (session start).
 */
const DEFAULT_PHASES = Object.freeze([
  { label: "T-24h", offsetMin: -24 * 60 },
  { label: "T-2h", offsetMin: -2 * 60 },
  { label: "T-30m", offsetMin: -30 },
  { label: "T-10m", offsetMin: -10 },
  { label: "T-0", offsetMin: 0 },
]);

/* --------------------------------- Builder ---------------------------------- */
/**
 * Build a T-x schedule for a compiled plan.
 *
 * @param {Object} req
 *  - planId: string (required for persistence)
 *  - t0ISO: ISO string of plan start (usually compilePlan.planStartISO) — if missing, will infer from earliest window.startISO
 *  - windows: Array<{ id, title?, domain?, startISO, endISO }>
 *  - phases?: Array<{ label: string, offsetMin: number }>
 *  - tzOffsetMinutes?: number (annotation only)
 *  - export?: boolean
 *  - planMeta?: object
 *
 * @returns {Promise<{ planId, t0ISO, phases, checkpoints }>}
 *   checkpoints: Array<{ label, atISO, offsetMin, items: ChecklistItem[] }>
 */
async function createTxSchedule(req = {}) {
  const source = "engines/scheduling/gatekeeper/txSchedule.createTxSchedule";
  try {
    const planId = String(req.planId || "").trim();
    const windows = Array.isArray(req.windows) ? req.windows.slice() : [];
    if (!planId) {
      emit("scheduling.tx.error", source, { message: "Missing planId." });
      return { planId: "", t0ISO: null, phases: [], checkpoints: [] };
    }
    if (!windows.length) {
      emit("scheduling.tx.error", source, { message: "No windows provided." });
      return { planId, t0ISO: null, phases: [], checkpoints: [] };
    }

    // Determine T0 (plan start)
    let t0ISO = req.t0ISO;
    if (!t0ISO) {
      const sorted = windows
        .filter((w) => isStr(w.startISO))
        .sort((a, b) => (Date.parse(a.startISO) || 0) - (Date.parse(b.startISO) || 0));
      t0ISO = sorted[0]?.startISO || nowISO();
    }
    const t0Ms = toEpochMs(t0ISO);
    if (t0Ms == null) {
      emit("scheduling.tx.error", source, { message: "Invalid t0ISO." });
      return { planId, t0ISO: null, phases: [], checkpoints: [] };
    }

    // Phase config
    const phases = Array.isArray(req.phases) && req.phases.length ? req.phases : DEFAULT_PHASES;

    // Build checkpoints
    const ctxBase = { planId, windows, t0ISO, tzOffsetMinutes: isNum(req.tzOffsetMinutes) ? req.tzOffsetMinutes : undefined };
    const checkpoints = [];

    for (const phase of phases) {
      const whenMs = addMinutes(t0Ms, Number(phase.offsetMin) || 0);
      const atISO = toISO(whenMs);
      const items = [];

      // Gather domains present in this plan
      const domains = new Set((windows || []).map((w) => (w.domain || "generic").toLowerCase()));
      if (!domains.size) domains.add("generic");

      // Domain-specific items
      for (const d of domains) {
        const rules = _domainRules.get(d) || _domainRules.get("generic");
        const generated = safeCallRules(rules, {
          phase,
          phaseOffsetMin: phase.offsetMin,
          plan: { id: planId, meta: req.planMeta || {} },
          windows,
          ctx: ctxBase,
        });
        if (Array.isArray(generated) && generated.length) {
          for (const item of generated) {
            items.push({
              id: item.id || `${d}-${phase.label}-${Math.random().toString(36).slice(2, 8)}`,
              title: item.title || "Checklist item",
              description: item.description || "",
              domain: item.domain || d,
              taskIdRef: item.taskIdRef,
              severity: item.severity || "info",
              tags: Array.isArray(item.tags) ? item.tags.slice() : [],
            });
          }
        }
      }

      // Always add a generic gate at T-0 if nothing else is present
      if (phase.label === "T-0" && items.length === 0) {
        items.push({
          id: "start-session-default",
          title: "Start session",
          description: "Begin planned tasks and start timers.",
          domain: "generic",
          severity: "info",
          tags: ["start"],
        });
      }

      checkpoints.push({
        label: phase.label,
        atISO,
        offsetMin: phase.offsetMin,
        items,
      });
    }

    const snapshot = {
      planId,
      t0ISO,
      phases,
      checkpoints,
      planMeta: req.planMeta || {},
      ts: nowISO(),
    };

    await store.put(planId, snapshot);

    const payload = { planId, t0ISO, phases, checkpoints, planMeta: snapshot.planMeta };
    emit("scheduling.tx.created", source, payload);

    if (req.export === true) {
      await exportToHubIfEnabled({ action: "tx.created", ...payload });
    }

    return snapshot;
  } catch (err) {
    emit("scheduling.tx.error", "engines/scheduling/gatekeeper/txSchedule.createTxSchedule", { message: String(err?.message || err) });
    return { planId: String(req?.planId || ""), t0ISO: null, phases: [], checkpoints: [] };
  }
}

function safeCallRules(fn, arg) {
  try {
    const out = fn?.(arg);
    return Array.isArray(out) ? out : [];
  } catch (e) {
    console.warn("[txSchedule.rules] rule threw:", e);
    return [];
  }
}

/* --------------------------------- Queries ---------------------------------- */

/** Retrieve a stored T-x snapshot for a plan. */
async function getTxSchedule(planId) {
  return await store.get(planId);
}

/* --------------------------------- Exports ---------------------------------- */
module.exports = {
  createTxSchedule,
  getTxSchedule,
  registerDomainPhaseRules,
  // for tests/ext
  _internals: {
    DEFAULT_PHASES,
  },
};
