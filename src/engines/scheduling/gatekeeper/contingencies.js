// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\gatekeeper\contingencies.js
/**
 * Scheduling Gatekeeper — Contingencies
 * -----------------------------------------------------------------------------
 * Role in pipeline:
 *   imports → intelligence (estimators/calibration) → automation (plans) → gatekeeper
 *   (checks & T-x) → contingencies (swaps, quick-thaw, simplify, reschedule)
 *   → (optional) hub export
 *
 * What this file does:
 *   - Proposes contingency options when gates/checks fail or risks are detected.
 *   - Applies selected contingencies by updating plan windows and reservations.
 *   - Emits consistent events via the shared eventBus and can export changes to
 *     the Family Fund Hub when familyFundMode is enabled.
 *
 * Event payload shape: { type, ts, source, data }
 * Emitted events:
 *   - scheduling.contingency.proposed
 *   - scheduling.contingency.applied
 *   - scheduling.contingency.error
 *
 * Forward-thinking:
 *   - Domain strategies with a registry (cooking, cleaning, garden, animals, preservation, storehouse).
 *   - Contingency types are normalized as "patches" (RFC6902-like, but simple):
 *       { op: "reschedule"|"swap"|"substitute"|"split"|"cancel"|"mutateMeta", targetId, value, meta? }
 *   - Defensive persistence using dataGateway KV with in-memory fallback.
 *   - Integrates with resourceAllocator to re-reserve on timing changes.
 */

"use strict";

/* --------------------------------- Imports --------------------------------- */

let eventBus = {
  emit: (...a) => console.debug("[contingencies:eventBus.emit]", ...a),
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

let allocator = null;
try {
  allocator = require("../planner/resourceAllocator.js");
  allocator = allocator?.default || allocator;
} catch {}

/* ------------------------------ Local Fallbacks ----------------------------- */

const MEM_PLANS = new Map(); // planId -> snapshot (same shape as compilePlan snapshot)

/* --------------------------------- Helpers --------------------------------- */

const nowISO = () => new Date().toISOString();
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string";
const clone = (obj) => (obj && typeof obj === "object" ? JSON.parse(JSON.stringify(obj)) : obj);

const toMs = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const addMinutes = (ms, m) => (isNum(ms) && isNum(m) ? ms + Math.round(m * 60000) : null);
const toISO = (ms) => {
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
};

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
    const packet = formatter.format("scheduling.contingencies", payload);
    await connector.send(packet);
  } catch {
    // swallow
  }
}

/* --------------------------------- Storage ---------------------------------- */

const store = {
  async getPlan(planId) {
    try {
      if (dataGateway?.kv?.get) {
        return (await dataGateway.kv.get("plans", planId)) || null;
      }
      return MEM_PLANS.get(planId) || null;
    } catch {
      return MEM_PLANS.get(planId) || null;
    }
  },
  async putPlan(planId, snapshot) {
    try {
      if (dataGateway?.kv?.set) {
        await dataGateway.kv.set("plans", planId, snapshot);
      } else {
        MEM_PLANS.set(planId, snapshot);
      }
    } catch (err) {
      console.warn("[contingencies.store.putPlan] fallback MEM", err);
      MEM_PLANS.set(planId, snapshot);
    }
  },
};

/* ----------------------------- Contingency Types ---------------------------- */
/**
 * Contingency Patch shape:
 * {
 *   id: string,                       // unique id
 *   type: "reschedule"|"swap"|"substitute"|"quickThaw"|"simplify"|"split"|"cancel"|"mutateMeta"|"reallocate",
 *   severity: "info"|"warn"|"mitigation"|"workaround",
 *   targetId?: string,                // window id (when applicable)
 *   value: any,                       // depends on type
 *   rationale: string,                // human readable why
 *   risks?: string[],                 // notable side-effects
 *   domain?: string,                  // optional
 *   requiresUserConfirm?: boolean,    // if true, caller should confirm before apply
 *   score?: number                    // rough heuristic ranking (higher = better fit)
 * }
 */

/* -------------------------- Domain Strategy Registry ------------------------ */

const STRATEGIES = new Map();

/** Register/replace a domain strategy. */
function registerDomainStrategy(domain, fn) {
  const d = String(domain || "").toLowerCase().trim();
  if (!d || typeof fn !== "function") return false;
  STRATEGIES.set(d, fn);
  return true;
}

/* -------------------------- Utility: Slack & Schedule ----------------------- */

function indexSchedule(scheduleArr) {
  // schedule from compilePlan.serializeScheduleMap
  const map = new Map();
  for (const row of scheduleArr || []) {
    map.set(row.id, row);
  }
  return map;
}

function windowSlack(scheduleMap, windowId, anchor = "earliest") {
  const row = scheduleMap.get(windowId);
  if (!row) return 0;
  // available forward slack from ES to LS (in minutes)
  const s = isNum(row.ls) && isNum(row.es) ? Math.max(0, row.ls - row.es) : 0;
  return s;
}

/* ---------------------------- Built-in Strategies --------------------------- */

/**
 * Generic strategy:
 *  - Reschedule within slack to avoid quiet hours or overlaps.
 *  - Swap with a non-blocked window of same duration class.
 *  - Cancel optional/low-priority windows as last resort.
 */
registerDomainStrategy("generic", function genericStrategy(ctx) {
  const patches = [];

  const scheduleMap = indexSchedule(ctx.schedule || []);
  const windowsById = new Map((ctx.windows || []).map((w) => [w.id, w]));
  const blocked = new Set(
    ctx.issues.filter((i) => i.severity === "blocker" && i.scope === "window").map((i) => i.windowId)
  );

  for (const w of ctx.windows) {
    if (!blocked.has(w.id)) continue;

    const slack = windowSlack(scheduleMap, w.id);
    if (slack > 0) {
      patches.push({
        id: `resched-${w.id}`,
        type: "reschedule",
        severity: "mitigation",
        targetId: w.id,
        domain: w.domain || "generic",
        value: { shiftMin: Math.min(slack, 60) }, // try up to 60 minutes within slack
        rationale: "Use available slack to move outside the blocked window.",
        score: 90,
      });
    }

    // Try swap with a same-domain, non-blocked window of similar duration
    const wDur = Math.max(1, (toMs(w.endISO) - toMs(w.startISO)) / 60000);
    const candidates = ctx.windows.filter(
      (x) =>
        x.id !== w.id &&
        !blocked.has(x.id) &&
        (x.domain || "generic") === (w.domain || "generic") &&
        Math.abs(((toMs(x.endISO) - toMs(x.startISO)) / 60000) - wDur) <= 15
    );

    if (candidates.length) {
      const other = candidates[0];
      patches.push({
        id: `swap-${w.id}-${other.id}`,
        type: "swap",
        severity: "mitigation",
        targetId: w.id,
        domain: w.domain || "generic",
        value: { withId: other.id },
        rationale: `Swap order with ${other.id} to bypass conflict period.`,
        score: 75,
      });
    }

    // Last resort: cancel if low priority
    const prio = isNum(w.priority) ? w.priority : 0;
    if (prio <= -1 || ctx.planMeta?.allowCancelLowPriority) {
      patches.push({
        id: `cancel-${w.id}`,
        type: "cancel",
        severity: "workaround",
        targetId: w.id,
        domain: w.domain || "generic",
        value: { reason: "Blocked and low priority" },
        rationale: "Cancel low-priority window to protect the rest of the plan.",
        requiresUserConfirm: true,
        score: 10,
      });
    }
  }

  return patches;
});

/**
 * Cooking strategy:
 *  - Allergy blocker → propose ingredient substitutes.
 *  - Thaw blocker → quick-thaw estimate and pre-stage step insert.
 *  - Device scarcity → downgrade device or split batch.
 */
registerDomainStrategy("cooking", function cookingStrategy(ctx) {
  const patches = [];
  const allergyIssues = ctx.issues.filter((i) => i.domain === "cooking" && i.code === "DIET_ALLERGY");

  for (const issue of allergyIssues) {
    const w = ctx.windows.find((x) => x.id === issue.windowId);
    if (!w) continue;

    // naive substitution table
    const subs = [
      { hit: "peanut", substitute: "sunflower-seed butter" },
      { hit: "milk", substitute: "oat milk" },
      { hit: "butter", substitute: "olive oil" },
      { hit: "egg", substitute: "flax egg" },
    ];
    for (const s of subs) {
      if ((issue.detail || "").toLowerCase().includes(s.hit)) {
        patches.push({
          id: `sub-${w.id}-${s.hit}`,
          type: "substitute",
          severity: "mitigation",
          targetId: w.id,
          domain: "cooking",
          value: { ingredient: s.hit, substitute: s.substitute },
          rationale: `Replace ${s.hit} with ${s.substitute} to avoid allergy.`,
          requiresUserConfirm: true,
          score: 95,
        });
      }
    }
  }

  // Quick-thaw suggestion for sessions starting within 2h and tagged with "frozen"
  for (const w of ctx.windows.filter((x) => (x.domain || "generic") === "cooking")) {
    const startsInMin = Math.round((toMs(w.startISO) - Date.now()) / 60000);
    const frozen = (w.tags || []).some((t) => /frozen/i.test(String(t)));
    if (frozen && startsInMin <= 120) {
      patches.push({
        id: `quickthaw-${w.id}`,
        type: "quickThaw",
        severity: "mitigation",
        targetId: w.id,
        domain: "cooking",
        value: { method: "cold-water" /* or "microwave" depending on preference */ , estMinutesPerKg: 30 },
        rationale: "Quick-thaw recommended due to short horizon; adjust prep timeline.",
        risks: ["Texture variation", "Requires food safety diligence"],
        score: 80,
      });
    }
  }

  // Device downgrade: if resource conflicts present for ovens, propose using stovetop/airfryer split
  const deviceConflicts = (ctx.conflicts || []).filter((c) => c.type === "capacityUnmet");
  for (const c of deviceConflicts) {
    const w = ctx.windows.find((x) => x.id === c.taskId);
    if (!w || (w.domain || "generic") !== "cooking") continue;
    patches.push({
      id: `downgrade-${w.id}`,
      type: "simplify",
      severity: "mitigation",
      targetId: w.id,
      domain: "cooking",
      value: { method: "device-downgrade", to: "stovetop|airfryer", note: "Modify recipe step to alternate heat source." },
      rationale: "Oven capacity unavailable; switch to alternate device or split batches.",
      score: 60,
    });
    patches.push({
      id: `split-${w.id}`,
      type: "split",
      severity: "mitigation",
      targetId: w.id,
      domain: "cooking",
      value: { into: 2, spacingMin: 10 },
      rationale: "Split into two runs to fit device capacity.",
      score: 55,
    });
  }

  return patches;
});

/**
 * Garden strategy:
 *  - Rain forecast → reschedule later in day within slack; or swap with indoor storehouse session.
 */
registerDomainStrategy("garden", function gardenStrategy(ctx) {
  const patches = [];
  const rain = ctx.issues.filter((i) => i.domain === "garden" && i.code === "WEATHER_RAIN");
  const scheduleMap = indexSchedule(ctx.schedule || []);

  for (const issue of rain) {
    const w = ctx.windows.find((x) => x.id === issue.windowId);
    if (!w) continue;
    const slack = windowSlack(scheduleMap, w.id);
    if (slack > 0) {
      patches.push({
        id: `rain-resched-${w.id}`,
        type: "reschedule",
        severity: "mitigation",
        targetId: w.id,
        domain: "garden",
        value: { shiftMin: Math.min(120, slack) },
        rationale: "Delay to bypass rain window using available slack.",
        score: 85,
      });
    }
    // Swap with storehouse indoors
    const indoor = ctx.windows.find((x) => (x.domain || "generic") === "storehouse");
    if (indoor) {
      patches.push({
        id: `swap-garden-store-${w.id}-${indoor.id}`,
        type: "swap",
        severity: "mitigation",
        targetId: w.id,
        domain: "garden",
        value: { withId: indoor.id },
        rationale: "Swap with indoor storehouse work until rain passes.",
        score: 70,
      });
    }
  }
  return patches;
});

/* ------------------------------- Public API -------------------------------- */
/**
 * Propose contingency patches for a plan given issues/check results.
 *
 * @param {Object} req
 *  - planId: string
 *  - windows: Array<{ id, domain, startISO, endISO, priority?, tags?, materials? }>
 *  - schedule: Array (serialized schedule rows with es/ls/ef/lf, etc.)
 *  - issues: Array (from runChecks)
 *  - reservations?: Array
 *  - conflicts?: Array
 *  - planMeta?: object
 * @returns {Promise<{ planId, patches: Array }>}
 */
async function proposeContingencies(req = {}) {
  const source = "engines/scheduling/gatekeeper/contingencies.proposeContingencies";
  try {
    const planId = String(req.planId || "").trim() || `ad-hoc-${Date.now()}`;
    const windows = Array.isArray(req.windows) ? req.windows.slice() : [];
    const issues = Array.isArray(req.issues) ? req.issues.slice() : [];
    const schedule = Array.isArray(req.schedule) ? req.schedule.slice() : [];
    const conflicts = Array.isArray(req.conflicts) ? req.conflicts.slice() : [];
    const planMeta = req.planMeta || {};

    const ctx = { planId, windows, issues, schedule, conflicts, planMeta };

    // Domains present
    const domains = new Set(windows.map((w) => (w.domain || "generic").toLowerCase()));
    if (!domains.size) domains.add("generic");

    // Aggregate patches from each domain + generic
    const patches = [];
    const seen = new Set();

    for (const d of new Set(["generic", ...domains])) {
      const fn = STRATEGIES.get(d);
      if (!fn) continue;
      const out = fn(ctx) || [];
      for (const p of out) {
        const key = `${p.type}|${p.targetId || "-"}|${p.value?.withId || p.value?.ingredient || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        patches.push({
          id: p.id || `patch-${Math.random().toString(36).slice(2, 8)}`,
          type: p.type,
          severity: p.severity || "mitigation",
          targetId: p.targetId,
          domain: p.domain || "generic",
          value: p.value,
          rationale: p.rationale || "",
          risks: Array.isArray(p.risks) ? p.risks.slice() : [],
          requiresUserConfirm: !!p.requiresUserConfirm,
          score: isNum(p.score) ? p.score : 50,
        });
      }
    }

    // Sort by score desc then by severity preference
    const sevRank = { mitigation: 3, workaround: 2, warn: 1, info: 0 };
    patches.sort((a, b) => (b.score - a.score) || ((sevRank[b.severity] || 0) - (sevRank[a.severity] || 0)));

    const payload = { planId, count: patches.length, patches };
    emit("scheduling.contingency.proposed", source, payload);
    return { planId, patches };
  } catch (err) {
    emit("scheduling.contingency.error", "engines/scheduling/gatekeeper/contingencies.proposeContingencies", {
      message: String(err?.message || err),
    });
    return { planId: String(req?.planId || ""), patches: [] };
  }
}

/**
 * Apply a single contingency patch to a stored plan snapshot.
 * NOTE: This mutates household plan data → emits + optional hub export.
 *
 * @param {Object} req
 *  - planId: string (required; must exist in plans store)
 *  - patch: Contingency Patch object (as returned by proposeContingencies)
 *  - resources?: Array<Resource> (optional resource catalog to re-allocate)
 *  - export?: boolean
 * @returns {Promise<{ planId, patchId, updated: boolean, snapshot?: object }>}
 */
async function applyContingency(req = {}) {
  const source = "engines/scheduling/gatekeeper/contingencies.applyContingency";
  try {
    const planId = String(req.planId || "").trim();
    const patch = req.patch || null;
    const resources = Array.isArray(req.resources) ? req.resources.slice() : [];
    if (!planId || !patch) {
      emit("scheduling.contingency.error", source, { message: "Missing planId or patch." });
      return { planId, patchId: patch?.id, updated: false };
    }

    const snapshot = await store.getPlan(planId);
    if (!snapshot || !Array.isArray(snapshot.windows)) {
      emit("scheduling.contingency.error", source, { message: "Plan not found.", planId });
      return { planId, patchId: patch.id, updated: false };
    }

    // Clone mutable pieces
    const windows = snapshot.windows.map(clone);
    const schedule = Array.isArray(snapshot.schedule) ? snapshot.schedule.map(clone) : [];
    const scheduleIdx = indexSchedule(schedule);

    const getWindow = (id) => windows.find((w) => w.id === id);

    let changed = false;

    switch (String(patch.type)) {
      case "reschedule": {
        const w = getWindow(patch.targetId);
        if (!w) break;
        const shift = Number(patch.value?.shiftMin || 0);
        if (!isNum(shift) || shift === 0) break;

        const s = toMs(w.startISO);
        const e = toMs(w.endISO);
        if (s == null || e == null) break;

        // Respect slack bounds if known
        const slack = windowSlack(scheduleIdx, w.id);
        if (shift > 0 && shift > slack) break;

        w.startISO = toISO(addMinutes(s, shift));
        w.endISO = toISO(addMinutes(e, shift));
        changed = true;
        break;
      }
      case "swap": {
        const a = getWindow(patch.targetId);
        const b = getWindow(patch.value?.withId);
        if (!a || !b) break;
        const aS = a.startISO, aE = a.endISO;
        a.startISO = b.startISO; a.endISO = b.endISO;
        b.startISO = aS; b.endISO = aE;
        changed = true;
        break;
      }
      case "substitute": {
        const w = getWindow(patch.targetId);
        if (!w) break;
        const ingName = String(patch.value?.ingredient || "").toLowerCase();
        const subName = String(patch.value?.substitute || "");
        if (!ingName || !subName) break;

        // Attach/modify substitutions metadata (non-destructive)
        const subs = Array.isArray(w.substitutions) ? w.substitutions.slice() : [];
        subs.push({ ingredient: ingName, substitute: subName, at: nowISO() });
        w.substitutions = subs;
        changed = true;
        break;
      }
      case "quickThaw": {
        const w = getWindow(patch.targetId);
        if (!w) break;
        const method = patch.value?.method || "cold-water";
        const estMinPerKg = Number(patch.value?.estMinutesPerKg || 30);
        // Inject a pre-task window just before start
        const startMs = toMs(w.startISO);
        if (startMs == null) break;
        const dur = Math.max(10, Math.round((w.materials?.meatKg || 1) * estMinPerKg));
        const thawStart = toISO(addMinutes(startMs, -dur));
        windows.push({
          id: `${w.id}::quickthaw`,
          title: `Quick-thaw (${method}) for ${w.title || w.id}`,
          domain: "cooking",
          startISO: thawStart,
          endISO: toISO(startMs),
          priority: (isNum(w.priority) ? w.priority : 0) + 1,
          tags: ["prep", "quick-thaw"],
        });
        changed = true;
        break;
      }
      case "simplify": {
        const w = getWindow(patch.targetId);
        if (!w) break;
        // Mark as simplified variant (downstream UI/runner can use this)
        w.variant = { ...(w.variant || {}), simplified: true, note: patch.value?.note || patch.rationale };
        // Slightly reduce duration by 10% (best effort)
        const s = toMs(w.startISO), e = toMs(w.endISO);
        if (s != null && e != null) {
          const dur = Math.max(1, Math.round((e - s) / 60000));
          const newDur = Math.max(1, Math.round(dur * 0.9));
          w.endISO = toISO(addMinutes(s, newDur));
        }
        changed = true;
        break;
      }
      case "split": {
        const w = getWindow(patch.targetId);
        if (!w) break;
        const into = Math.max(2, Number(patch.value?.into || 2));
        const spacing = Math.max(0, Number(patch.value?.spacingMin || 0));
        const s = toMs(w.startISO), e = toMs(w.endISO);
        if (s == null || e == null) break;
        const total = Math.max(1, Math.round((e - s) / 60000));
        const per = Math.max(1, Math.round((total - spacing * (into - 1)) / into));

        // Remove original and create splits
        const idx = windows.findIndex((x) => x.id === w.id);
        if (idx >= 0) windows.splice(idx, 1);
        for (let i = 0; i < into; i++) {
          const ss = addMinutes(s, i * (per + spacing));
          windows.push({
            id: `${w.id}::split${i + 1}`,
            title: `${w.title || w.id} — batch ${i + 1}/${into}`,
            domain: w.domain || "generic",
            startISO: toISO(ss),
            endISO: toISO(addMinutes(ss, per)),
            priority: w.priority,
            requirements: clone(w.requirements || []),
            tags: Array.isArray(w.tags) ? w.tags.concat(["split"]) : ["split"],
          });
        }
        changed = true;
        break;
      }
      case "cancel": {
        const idx = windows.findIndex((x) => x.id === patch.targetId);
        if (idx >= 0) {
          windows.splice(idx, 1);
          changed = true;
        }
        break;
      }
      case "mutateMeta": {
        const w = getWindow(patch.targetId);
        if (!w) break;
        w.meta = { ...(w.meta || {}), ...(patch.value || {}) };
        changed = true;
        break;
      }
      case "reallocate": {
        // No structural change here; caller may send after a manual edit. We simply trigger reallocation below.
        changed = true;
        break;
      }
      default:
        break;
    }

    if (!changed) {
      return { planId, patchId: patch.id, updated: false, snapshot };
    }

    // Re-allocate resources if allocator is available and we have a catalog
    let reservations = snapshot.reservations || [];
    let conflicts = snapshot.conflicts || [];
    if (allocator?.reserveResources && Array.isArray(resources) && resources.length) {
      // Release existing reservations for affected tasks in this plan to avoid double-booking
      try {
        if (allocator?.releaseReservations) {
          const affectedIds = deriveAffectedIdsFromPatch(patch);
          if (affectedIds.length) {
            await allocator.releaseReservations({ planId, taskIds: affectedIds, export: false });
            // refresh local copy
            const current = await allocator.getReservations?.(planId);
            reservations = Array.isArray(current) ? current : [];
          }
        }
      } catch (e) {
        // non-fatal
      }

      const result = await allocator.reserveResources(windows, resources, {
        planId,
        strategy: "greedy",
        export: false,
        planMeta: snapshot.planMeta || {},
      });
      reservations = result.reservations || [];
      conflicts = result.conflicts || [];
    }

    // Persist updated snapshot
    const updated = {
      ...snapshot,
      windows,
      reservations,
      conflicts,
      ts: nowISO(),
    };
    await store.putPlan(planId, updated);

    const payload = { planId, patchId: patch.id, changed: true, patch, snapshot: safeSnapshot(updated) };
    emit("scheduling.contingency.applied", source, payload);

    if (req.export === true) {
      await exportToHubIfEnabled({ action: "contingency.applied", ...payload });
    }

    return { planId, patchId: patch.id, updated: true, snapshot: updated };
  } catch (err) {
    emit("scheduling.contingency.error", "engines/scheduling/gatekeeper/contingencies.applyContingency", {
      message: String(err?.message || err),
    });
    return { planId: String(req?.planId || ""), patchId: req?.patch?.id, updated: false };
  }
}

/* -------------------------------- Internals -------------------------------- */

function deriveAffectedIdsFromPatch(patch) {
  switch (String(patch?.type)) {
    case "swap":
      return [patch.targetId, patch.value?.withId].filter(Boolean);
    case "split":
      return [patch.targetId];
    case "cancel":
    case "reschedule":
    case "mutateMeta":
    case "quickThaw":
    case "simplify":
      return [patch.targetId].filter(Boolean);
    default:
      return [];
  }
}

function safeSnapshot(snap) {
  // Keep payload lean for events/Hub
  return {
    planId: snap.planId,
    planMeta: snap.planMeta,
    windows: (snap.windows || []).map((w) => ({
      id: w.id, title: w.title, domain: w.domain, startISO: w.startISO, endISO: w.endISO, priority: w.priority,
    })),
    conflicts: snap.conflicts || [],
    reservations: (snap.reservations || []).slice(0, 50), // cap in event payload
    ts: snap.ts,
  };
}

/* --------------------------------- Exports ---------------------------------- */
module.exports = {
  proposeContingencies,
  applyContingency,
  registerDomainStrategy,
  // for tests/ext
  _internals: {
    indexSchedule,
    windowSlack,
  },
};
