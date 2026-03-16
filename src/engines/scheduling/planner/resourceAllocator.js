// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\planner\resourceAllocator.js
/**
 * Scheduling Planner — Resource Allocator
 * ------------------------------------------------------------
 * Role in pipeline:
 *  imports → intelligence (estimators/calibration) → automation (DAG/backplanner) → resource allocation → (optional) hub export
 *
 * What this file does:
 *  - Reserves devices/people for scheduled tasks across domains (cooking, cleaning, garden, animals, preservation, storehouse).
 *  - Checks calendars, resolves conflicts using priority-aware strategies, and writes reservations.
 *  - Emits consistent events via eventBus and optionally exports change sets to the Hub (familyFundMode).
 *
 * Key concepts:
 *  - Resource Catalog: list of resources (devices/people) with capabilities/skills and a reservation calendar.
 *  - Requirement: each task declares the roles/capabilities/skills and quantity needed for a time window.
 *  - Reservation: normalized record { resourceId, taskId, planId, startISO, endISO, meta }.
 *
 * Events emitted (payload shape: { type, ts, source, data }):
 *  - scheduling.resources.allocated
 *  - scheduling.resources.conflict
 *  - scheduling.resources.released
 *  - scheduling.resources.error
 *
 * Hub export:
 *  - On successful allocation or release, exportToHubIfEnabled(changeSet) is invoked (silent failure if Hub unavailable).
 *
 * Forward-thinking:
 *  - Domain-agnostic matching with roles, skills, capabilities, and alternatives.
 *  - Supports concurrentCapacity for resources (e.g., large oven can host 2 trays).
 *  - Extension points: custom matchers, conflict strategies, external calendars.
 */

"use strict";

/* --------------------------------- Imports --------------------------------- */

let eventBus = {
  emit: (...a) => console.debug("[allocator:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/events/eventBus");
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

const MEM_RESERVATIONS = new Map(); // planId -> Reservation[]
const MEM_RESOURCES = new Map(); // resourceId -> Resource (last seen snapshot)

/* --------------------------------- Helpers --------------------------------- */

const nowISO = () => new Date().toISOString();
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string";
const asISO = (v) =>
  v instanceof Date
    ? v.toISOString()
    : isStr(v)
    ? new Date(v).toISOString()
    : null;
const toMs = (isoOrDate) => {
  if (isoOrDate instanceof Date) return isoOrDate.getTime();
  if (isStr(isoOrDate)) {
    const t = Date.parse(isoOrDate);
    return Number.isFinite(t) ? t : null;
  }
  return null;
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
    const packet = formatter.format("scheduling.resources", payload);
    await connector.send(packet);
  } catch {
    // swallow
  }
}

/* ------------------------------- Data Access -------------------------------- */

const store = {
  /** Persist reservations for a given planId. */
  async putReservations(planId, reservations) {
    try {
      if (dataGateway?.kv?.set) {
        await dataGateway.kv.set("reservations", planId, reservations);
      } else {
        MEM_RESERVATIONS.set(planId, reservations);
      }
    } catch (err) {
      console.warn("[allocator.store.putReservations] fallback MEM", err);
      MEM_RESERVATIONS.set(planId, reservations);
    }
  },
  /** Get reservations by planId. */
  async getReservations(planId) {
    try {
      if (dataGateway?.kv?.get) {
        return (await dataGateway.kv.get("reservations", planId)) || [];
      }
      return MEM_RESERVATIONS.get(planId) || [];
    } catch (err) {
      console.warn("[allocator.store.getReservations] fallback MEM", err);
      return MEM_RESERVATIONS.get(planId) || [];
    }
  },
  /** Cache latest resource catalog snapshot (optional). */
  async cacheResources(resources) {
    try {
      if (!Array.isArray(resources)) return;
      resources.forEach((r) => MEM_RESOURCES.set(r.id, r));
    } catch {} // best effort
  },
};

/* --------------------------------- Types ------------------------------------
Resource (catalog item):
{
  id: string,
  kind: "device" | "person",
  roles?: string[],               // e.g., ["oven","mixer"] or ["cook","butcher"]
  skills?: string[],              // e.g., ["sous-vide","can-seal"]
  capabilities?: string[],        // free-form tags ["large","gas","outdoor","sterile"]
  concurrentCapacity?: number,    // default 1; number of simultaneous tasks allowed
  calendar?: Array<{ startISO: string, endISO: string, taskId?: string, planId?: string }>,
  domain?: string                 // optional affinity ("cooking","cleaning",...)
}

Requirement (per task):
{
  type: "device"|"person",
  role?: string,
  skills?: string[],              // all-of matching (AND) unless custom matcher changes it
  capabilities?: string[],        // subset match (AND)
  quantity?: number,              // default 1
  alternatives?: Array<{ role?: string, skills?: string[], capabilities?: string[] }>,
  optional?: boolean,             // if true, lack of match becomes a soft conflict
}

Task window (from planner):
{
  id: string,
  startISO: string,
  endISO: string,
  domain?: string,
  priority?: number,              // higher wins conflicts; default 0
  requirements?: Requirement[]
}
------------------------------------------------------------------------------*/

/* ------------------------------ Matching Logic ------------------------------ */

/**
 * Default matcher (extensible):
 *  - kind must match requirement.type
 *  - role if provided -> resource.roles includes role
 *  - every required skill/capability must be included in resource
 */
function defaultMatcher(requirement, resource) {
  if (!requirement || !resource) return false;
  if (resource.kind !== requirement.type) return false;

  if (requirement.role) {
    const roles = Array.isArray(resource.roles) ? resource.roles : [];
    if (!roles.includes(requirement.role)) return false;
  }

  if (Array.isArray(requirement.skills) && requirement.skills.length) {
    const skills = new Set(
      Array.isArray(resource.skills) ? resource.skills : []
    );
    for (const s of requirement.skills) if (!skills.has(s)) return false;
  }

  if (
    Array.isArray(requirement.capabilities) &&
    requirement.capabilities.length
  ) {
    const caps = new Set(
      Array.isArray(resource.capabilities) ? resource.capabilities : []
    );
    for (const c of requirement.capabilities) if (!caps.has(c)) return false;
  }

  return true;
}

/** Try requirement alternatives if base requirement fails. */
function* requirementVariants(req) {
  yield req;
  const alts = Array.isArray(req?.alternatives) ? req.alternatives : [];
  for (const a of alts) {
    yield {
      ...req,
      role: a.role ?? req.role,
      skills: a.skills ?? req.skills,
      capabilities: a.capabilities ?? req.capabilities,
    };
  }
}

/* ---------------------------- Calendar / Overlaps --------------------------- */

function overlaps(aStartMs, aEndMs, bStartMs, bEndMs) {
  return aStartMs < bEndMs && bStartMs < aEndMs;
}

function getConcurrentLoad(resource, startMs, endMs, existingCalendar) {
  const cal = Array.isArray(existingCalendar) ? existingCalendar : [];
  let load = 0;
  for (const slot of cal) {
    const s = toMs(slot.startISO);
    const e = toMs(slot.endISO);
    if (s == null || e == null) continue;
    if (overlaps(startMs, endMs, s, e)) load += 1;
  }
  return load;
}

function canReserve(resource, startMs, endMs, quantity, existingCalendar) {
  const cap = Math.max(1, Number(resource.concurrentCapacity) || 1);
  const load = getConcurrentLoad(resource, startMs, endMs, existingCalendar);
  return load + quantity <= cap;
}

function applyReservation(
  resource,
  startISO,
  endISO,
  taskId,
  planId,
  quantity
) {
  const entries = [];
  const cal = resource.calendar || (resource.calendar = []);
  for (let i = 0; i < quantity; i++) {
    const entry = { startISO, endISO, taskId, planId };
    cal.push(entry);
    entries.push({ resourceId: resource.id, startISO, endISO, taskId, planId });
  }
  return entries;
}

/* ------------------------- Conflict Strategy (Priority) --------------------- */

/**
 * Simple resolver:
 *  - Greedy by descending task.priority, then earlier start.
 *  - If not enough capacity, try alternatives; otherwise record conflict.
 *  - No preemption of already-chosen higher-priority reservations within the same call.
 *  - Returns { reservations, conflicts }.
 */
function allocateGreedy(tasks, resources, options = {}) {
  const byId = new Map((resources || []).map((r) => [r.id, r]));
  const reservations = [];
  const conflicts = [];

  // Defensive calendars
  for (const r of resources || []) {
    if (!Array.isArray(r.calendar)) r.calendar = [];
  }

  const sorted = (tasks || []).slice().sort((a, b) => {
    const ap = isNum(a.priority) ? a.priority : 0;
    const bp = isNum(b.priority) ? b.priority : 0;
    if (bp !== ap) return bp - ap;
    const as = toMs(a.startISO) ?? 0;
    const bs = toMs(b.startISO) ?? 0;
    return as - bs;
  });

  for (const task of sorted) {
    const tStartMs = toMs(task.startISO);
    const tEndMs = toMs(task.endISO);
    if (tStartMs == null || tEndMs == null || tEndMs <= tStartMs) {
      conflicts.push({
        type: "invalidWindow",
        taskId: task.id,
        detail: { start: task.startISO, end: task.endISO },
      });
      continue;
    }

    const reqs = Array.isArray(task.requirements) ? task.requirements : [];
    const allocationsForTask = [];

    for (const req of reqs) {
      const qty = Math.max(1, Number(req.quantity) || 1);

      let remaining = qty;
      let matched = [];

      for (const variant of requirementVariants(req)) {
        if (remaining <= 0) break;
        // Candidate resources matching variant
        const candidates = (resources || []).filter((r) =>
          defaultMatcher(variant, r)
        );
        // Sort candidates: least-loaded first on the window, then higher capacity
        candidates.sort((r1, r2) => {
          const load1 = getConcurrentLoad(r1, tStartMs, tEndMs, r1.calendar);
          const load2 = getConcurrentLoad(r2, tStartMs, tEndMs, r2.calendar);
          if (load1 !== load2) return load1 - load2;
          const cap1 = Math.max(1, Number(r1.concurrentCapacity) || 1);
          const cap2 = Math.max(1, Number(r2.concurrentCapacity) || 1);
          return cap2 - cap1;
        });

        for (const res of candidates) {
          if (remaining <= 0) break;
          const can = canReserve(res, tStartMs, tEndMs, 1, res.calendar);
          if (!can) continue;
          const sISO = asISO(task.startISO);
          const eISO = asISO(task.endISO);
          const ents = applyReservation(
            res,
            sISO,
            eISO,
            task.id,
            options.planId || "ad-hoc",
            1
          );
          matched = matched.concat(ents);
          remaining -= 1;
        }
      }

      if (remaining > 0) {
        if (req.optional) {
          // Note: optional unmet requirement — soft conflict, but task may proceed.
          conflicts.push({
            type: "optionalUnmet",
            taskId: task.id,
            requirement: req,
            missingQuantity: remaining,
          });
        } else {
          // Hard conflict; record and roll back matched so far for this requirement to keep allocation atomic per req.
          for (const m of matched) {
            const res = byId.get(m.resourceId);
            if (!res) continue;
            res.calendar = (res.calendar || []).filter(
              (slot) =>
                !(
                  slot.planId === m.planId &&
                  slot.taskId === m.taskId &&
                  slot.startISO === m.startISO &&
                  slot.endISO === m.endISO
                )
            );
          }
          conflicts.push({
            type: "capacityUnmet",
            taskId: task.id,
            requirement: req,
            missingQuantity: remaining,
          });
          matched = [];
        }
      }

      allocationsForTask.push(...matched);
    }

    if (allocationsForTask.length) {
      reservations.push(...allocationsForTask);
    }
  }

  return { reservations, conflicts };
}

/* ------------------------------- Public API -------------------------------- */

/**
 * Reserve resources for a set of task windows.
 *
 * @param {Array} tasks  Array of tasks with { id, startISO, endISO, domain?, priority?, requirements? }
 * @param {Array} resources Array of resources (catalog) with calendars
 * @param {Object} options
 *   - planId: string (groups all reservations)
 *   - strategy: "greedy" (default) // placeholder for future strategies
 *   - export: boolean (default false)
 *   - planMeta: object
 * @returns {Promise<{ reservations: Array, conflicts: Array }>}
 */
async function reserveResources(tasks = [], resources = [], options = {}) {
  const source =
    "engines/scheduling/planner/resourceAllocator.reserveResources";

  // Defensive copies to avoid mutating caller arrays
  const resCopy = Array.isArray(resources)
    ? resources.map((r) => ({ ...r, calendar: (r.calendar || []).slice() }))
    : [];
  const tasksCopy = Array.isArray(tasks) ? tasks.map((t) => ({ ...t })) : [];

  // Validate inputs quickly
  const badTasks = tasksCopy.filter(
    (t) => !t || !t.id || !t.startISO || !t.endISO
  );
  if (badTasks.length) {
    const msg = `Invalid tasks: ${badTasks
      .map((t) => t?.id || "?")
      .join(", ")}`;
    emit("scheduling.resources.error", source, { message: msg });
    return {
      reservations: [],
      conflicts: [{ type: "invalidTask", tasks: badTasks.map((t) => t?.id) }],
    };
  }

  const strategy = (options.strategy || "greedy").toLowerCase();
  let result = { reservations: [], conflicts: [] };

  try {
    switch (strategy) {
      case "greedy":
      default:
        result = allocateGreedy(tasksCopy, resCopy, options);
        break;
    }
  } catch (err) {
    emit("scheduling.resources.error", source, {
      message: String(err?.message || err),
    });
    return {
      reservations: [],
      conflicts: [
        { type: "internalError", message: String(err?.message || err) },
      ],
    };
  }

  // Persist reservations set for this planId
  const planId = options.planId || "ad-hoc";
  const prior = await store.getReservations(planId);
  const merged = dedupeReservations([...(prior || []), ...result.reservations]);

  await store.putReservations(planId, merged);
  await store.cacheResources(resCopy);

  const payload = {
    planId,
    planMeta: options.planMeta || {},
    reservations: merged,
    newReservations: result.reservations,
    conflicts: result.conflicts,
  };

  // Emit events
  if (result.conflicts.length) {
    emit("scheduling.resources.conflict", source, payload);
  }
  if (result.reservations.length) {
    emit("scheduling.resources.allocated", source, payload);
    if (options.export === true) {
      await exportToHubIfEnabled({ action: "resources.allocated", ...payload });
    }
  }

  return { reservations: merged, conflicts: result.conflicts };
}

/**
 * Release reservations by planId, or by taskId subset within a plan.
 * This changes household data → emits & (optionally) exports.
 */
async function releaseReservations({
  planId,
  taskIds = null,
  export: doExport = false,
} = {}) {
  const source =
    "engines/scheduling/planner/resourceAllocator.releaseReservations";
  if (!planId) {
    emit("scheduling.resources.error", source, { message: "Missing planId" });
    return { released: [], remaining: [] };
  }

  const current = await store.getReservations(planId);
  if (!current.length) {
    return { released: [], remaining: [] };
  }

  const { keep, drop } = partition(current, (r) =>
    Array.isArray(taskIds) && taskIds.length
      ? !taskIds.includes(r.taskId)
      : false
  );

  await store.putReservations(planId, keep);

  const payload = { planId, released: drop, remaining: keep };
  emit("scheduling.resources.released", source, payload);
  if (doExport === true && drop.length) {
    await exportToHubIfEnabled({ action: "resources.released", ...payload });
  }

  return { released: drop, remaining: keep };
}

/**
 * Read-only: list reservations for a plan.
 */
async function getReservations(planId) {
  return await store.getReservations(planId);
}

/* -------------------------------- Internals -------------------------------- */

function dedupeReservations(list) {
  const seen = new Set();
  const out = [];
  for (const r of list || []) {
    const key = `${r.resourceId}|${r.taskId}|${r.planId}|${r.startISO}|${r.endISO}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function partition(arr, predicateKeep) {
  const keep = [];
  const drop = [];
  for (const x of arr) {
    if (predicateKeep(x)) keep.push(x);
    else drop.push(x);
  }
  return { keep, drop };
}

/* --------------------------------- Exports ---------------------------------- */
module.exports = {
  reserveResources,
  releaseReservations,
  getReservations,
  // exposed for testing/extension
  _internals: {
    defaultMatcher,
    allocateGreedy,
    overlaps,
    canReserve,
  },
};
