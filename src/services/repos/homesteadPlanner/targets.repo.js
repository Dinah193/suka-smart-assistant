/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\repos\homesteadPlanner\targets.repo.js
//
// SSA • Homestead Planner Targets Repository
// -----------------------------------------------------------------------------
// What this repo stores:
//  - “Targets” = user-approved planning outputs and/or manual targets that the
//    Homestead Planner uses as constraints and goals.
//
// Typical target domains:
//  - provisioningTargets: pantry/freezer/root-cellar + components demand targets
//  - gardenTargets: beds/sqft/crop allocations, start dates, succession targets
//  - animalTargets: herds/flocks acquisition + production/butchery targets
//  - storehouseTargets: jars/freezer space/dehydrator capacity + procurement
//  - skillsTargets: new skills to learn, training plan, weekly cap, etc.
//
// Design goals:
//  - Browser-safe (Vite) — no Node imports
//  - Dexie-backed; tolerant of missing table names (fallback KV)
//  - Deterministic defaults + sanitization
//  - Atomic upserts, optional history table writes
//  - EventBus emissions for UI/automation sync
//
// Recommended Dexie tables (db.js):
//  - homesteadPlannerTargets: "&id, householdId, userId, planId, status, updatedAt"
//  - homesteadPlannerTargetsHistory: "++pk, id, householdId, userId, planId, at"
//
// Notes:
//  - Targets are scoped to a household and optionally a user and/or planId.
//  - If planId is null, the record is treated as “current household target set”.
//  - If planId is set, the record can represent a saved planning run’s targets.
//
// -----------------------------------------------------------------------------
// Usage:
//  import { homesteadPlannerTargetsRepo as hpTargets } from "@/services/repos/homesteadPlanner/targets.repo";
//  const t = await hpTargets.getEffectiveTargets({ householdId, userId, planId });
//  await hpTargets.setTargets({ householdId, patch: { status: "approved" } });
//
// -----------------------------------------------------------------------------

const DEFAULT_SOURCE = "services/repos/homesteadPlanner/targets.repo";

/** Event names (keep stable) */
export const HP_TARGETS_EVENTS = Object.freeze({
  UPDATED: "homesteadPlanner.targets.updated",
  RESET: "homesteadPlanner.targets.reset",
  STATUS_CHANGED: "homesteadPlanner.targets.statusChanged",
});

/** Primary storage table candidates (ordered) */
const TABLE_CANDIDATES = Object.freeze([
  "homesteadPlannerTargets",
  "homesteadPlannerPlanTargets",
  "plannerTargets",
  "targets",
]);

/** Fallback KV table candidates (id/key -> value) */
const KV_TABLE_CANDIDATES = Object.freeze(["kv", "settings", "appSettings"]);

/** History table candidates */
const HISTORY_TABLE_CANDIDATES = Object.freeze([
  "homesteadPlannerTargetsHistory",
  "homesteadPlannerPlanTargetsHistory",
  "targetsHistory",
]);

/** Allowed status values */
const TARGET_STATUS = Object.freeze([
  "draft",
  "proposed",
  "approved",
  "archived",
]);

/** Safe object check */
function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Simple deep clone safe for JSON-only data */
function jclone(x) {
  return x == null ? x : JSON.parse(JSON.stringify(x));
}

function nowISO() {
  return new Date().toISOString();
}

/** Deep merge: src overrides dst (objects only). Arrays replaced. */
function deepMerge(dst, src) {
  if (!isObj(dst)) dst = {};
  if (!isObj(src)) return dst;

  const out = { ...dst };
  for (const [k, v] of Object.entries(src)) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

/** Remove keys with undefined (recursively) */
function stripUndefined(x) {
  if (Array.isArray(x)) return x.map(stripUndefined);
  if (!isObj(x)) return x;

  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (v === undefined) continue;
    out[k] = stripUndefined(v);
  }
  return out;
}

function clampEnum(val, allowed, fallback) {
  return allowed.includes(val) ? val : fallback;
}

function clampNumOrNull(v, min, max) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function normalizeStr(v) {
  return v == null ? null : String(v).trim() || null;
}

function normalizeStrArray(v) {
  return Array.isArray(v)
    ? v
        .map(String)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/** Create a stable compound id */
export function makeHomesteadPlannerTargetsId({
  householdId,
  userId,
  planId,
} = {}) {
  const hid = String(householdId || "").trim();
  if (!hid) throw new Error("householdId is required");
  const uid =
    userId == null || String(userId).trim() === ""
      ? "__household__"
      : String(userId).trim();
  const pid =
    planId == null || String(planId).trim() === ""
      ? "__current__"
      : String(planId).trim();
  return `${hid}::${uid}::${pid}`;
}

/** Deterministic defaults */
export function getHomesteadPlannerTargetsDefaults() {
  return {
    schemaVersion: 1,

    // lifecycle/status
    status: "draft", // draft|proposed|approved|archived
    title: null, // optional label
    notes: "",

    // links/context
    context: {
      startISO: null,
      horizonDays: null,
      cuisineKey: null,
      rotationKeys: [],
    },

    // The actual targets. These are intentionally generic; planners may extend.
    provisioningTargets: {
      // componentDemand: { componentKey: { unit, amount, horizonDays, notes? } }
      componentDemand: {},
      // storage posture
      pantryBufferDays: null,
      freezerBufferDays: null,
      rootCellarBufferDays: null,
      preserveSurplus: null,
      favorShelfStable: null,
      // computed summary (optional)
      summaries: {
        caloriesPerDay: null,
        mealsPerWeek: null,
      },
    },

    gardenTargets: {
      enabled: null,
      maxBeds: null,
      maxSqFt: null,
      irrigation: null,
      includeHerbs: null,
      includeMedicinals: null,
      avoidCrops: [],
      preferCrops: [],
      // allocations: { cropKey: { areaSqFt?, beds?, plantings?, notes? } }
      allocations: {},
      // schedule hints
      schedule: {
        firstPlantingISO: null,
        successionEnabled: null,
      },
    },

    animalTargets: {
      enabled: null,
      allowNewAcquisitions: null,
      maxSpeciesCount: null,
      avoidSpecies: [],
      preferSpecies: [],
      ethics: {
        noPork: null,
        noShellfish: null,
        halalLike: null,
      },
      // herds: { speciesKey: { count, purpose: "eggs|milk|meat|fiber|mixed", notes? } }
      herds: {},
      // production goals (optional)
      production: {
        eggsPerWeek: null,
        milkGallonsPerWeek: null,
        meatLbsPerMonth: null,
      },
    },

    storehouseTargets: {
      jarsAvailable: null,
      freezerCuFt: null,
      dehydratorTrays: null,
      rootCellarAvailable: null,
      procurement: {
        // items needed to meet capacities
        needed: [],
      },
    },

    skillsTargets: {
      capNewSkillsPerWeek: null,
      learningQueue: [], // array of { key, label?, priority?, notes? }
      completed: [],
    },

    // optional computed outputs + explanations for UI
    explain: {
      assumptions: [],
      gaps: [],
      actions: [],
    },
  };
}

/**
 * Sanitize / normalize targets to be safe and predictable.
 * This does not “validate schema” in a strict sense; it ensures:
 *  - defaults exist
 *  - known enums/numbers clamped
 *  - arrays/objects shaped consistently
 */
export function sanitizeHomesteadPlannerTargets(targets) {
  const d = getHomesteadPlannerTargetsDefaults();
  const merged = deepMerge(d, isObj(targets) ? targets : {});
  const out = stripUndefined(merged);

  out.status = clampEnum(out.status, TARGET_STATUS, "draft");
  out.title = normalizeStr(out.title);
  out.notes =
    typeof out.notes === "string" ? out.notes : String(out.notes ?? "");

  // context
  out.context.cuisineKey = normalizeStr(out.context.cuisineKey);
  out.context.rotationKeys = normalizeStrArray(out.context.rotationKeys);
  out.context.startISO = normalizeStr(out.context.startISO);
  out.context.horizonDays = clampNumOrNull(out.context.horizonDays, 1, 366);

  // provisioningTargets
  out.provisioningTargets.pantryBufferDays = clampNumOrNull(
    out.provisioningTargets.pantryBufferDays,
    0,
    365
  );
  out.provisioningTargets.freezerBufferDays = clampNumOrNull(
    out.provisioningTargets.freezerBufferDays,
    0,
    365
  );
  out.provisioningTargets.rootCellarBufferDays = clampNumOrNull(
    out.provisioningTargets.rootCellarBufferDays,
    0,
    365
  );

  const asBoolOrNull = (v) => (v == null ? null : !!v);
  out.provisioningTargets.preserveSurplus = asBoolOrNull(
    out.provisioningTargets.preserveSurplus
  );
  out.provisioningTargets.favorShelfStable = asBoolOrNull(
    out.provisioningTargets.favorShelfStable
  );

  // componentDemand: force object-of-objects
  if (!isObj(out.provisioningTargets.componentDemand))
    out.provisioningTargets.componentDemand = {};
  for (const [k, v] of Object.entries(
    out.provisioningTargets.componentDemand
  )) {
    if (!isObj(v)) {
      out.provisioningTargets.componentDemand[k] = {
        unit: "count",
        amount: null,
      };
      continue;
    }
    const unit = normalizeStr(v.unit) || "count";
    const amount = clampNumOrNull(v.amount, 0, 1e9);
    const horizonDays = clampNumOrNull(v.horizonDays, 1, 366);
    out.provisioningTargets.componentDemand[k] = stripUndefined({
      unit,
      amount,
      horizonDays,
      notes:
        typeof v.notes === "string"
          ? v.notes
          : v.notes == null
          ? undefined
          : String(v.notes),
    });
  }

  out.provisioningTargets.summaries.caloriesPerDay = clampNumOrNull(
    out.provisioningTargets.summaries.caloriesPerDay,
    0,
    100000
  );
  out.provisioningTargets.summaries.mealsPerWeek = clampNumOrNull(
    out.provisioningTargets.summaries.mealsPerWeek,
    0,
    500
  );

  // gardenTargets
  out.gardenTargets.enabled = asBoolOrNull(out.gardenTargets.enabled);
  out.gardenTargets.maxBeds = clampNumOrNull(out.gardenTargets.maxBeds, 0, 500);
  out.gardenTargets.maxSqFt = clampNumOrNull(
    out.gardenTargets.maxSqFt,
    0,
    200000
  );
  out.gardenTargets.irrigation = normalizeStr(out.gardenTargets.irrigation);
  out.gardenTargets.includeHerbs = asBoolOrNull(out.gardenTargets.includeHerbs);
  out.gardenTargets.includeMedicinals = asBoolOrNull(
    out.gardenTargets.includeMedicinals
  );
  out.gardenTargets.avoidCrops = normalizeStrArray(
    out.gardenTargets.avoidCrops
  );
  out.gardenTargets.preferCrops = normalizeStrArray(
    out.gardenTargets.preferCrops
  );

  if (!isObj(out.gardenTargets.allocations)) out.gardenTargets.allocations = {};
  for (const [cropKey, v] of Object.entries(out.gardenTargets.allocations)) {
    const row = isObj(v) ? v : {};
    out.gardenTargets.allocations[cropKey] = stripUndefined({
      areaSqFt: clampNumOrNull(row.areaSqFt, 0, 200000),
      beds: clampNumOrNull(row.beds, 0, 5000),
      plantings: clampNumOrNull(row.plantings, 0, 10000),
      notes:
        typeof row.notes === "string"
          ? row.notes
          : row.notes == null
          ? undefined
          : String(row.notes),
    });
  }

  out.gardenTargets.schedule.firstPlantingISO = normalizeStr(
    out.gardenTargets.schedule.firstPlantingISO
  );
  out.gardenTargets.schedule.successionEnabled = asBoolOrNull(
    out.gardenTargets.schedule.successionEnabled
  );

  // animalTargets
  out.animalTargets.enabled = asBoolOrNull(out.animalTargets.enabled);
  out.animalTargets.allowNewAcquisitions = asBoolOrNull(
    out.animalTargets.allowNewAcquisitions
  );
  out.animalTargets.maxSpeciesCount = clampNumOrNull(
    out.animalTargets.maxSpeciesCount,
    0,
    200
  );
  out.animalTargets.avoidSpecies = normalizeStrArray(
    out.animalTargets.avoidSpecies
  );
  out.animalTargets.preferSpecies = normalizeStrArray(
    out.animalTargets.preferSpecies
  );

  out.animalTargets.ethics.noPork = asBoolOrNull(
    out.animalTargets.ethics.noPork
  );
  out.animalTargets.ethics.noShellfish = asBoolOrNull(
    out.animalTargets.ethics.noShellfish
  );
  out.animalTargets.ethics.halalLike = asBoolOrNull(
    out.animalTargets.ethics.halalLike
  );

  if (!isObj(out.animalTargets.herds)) out.animalTargets.herds = {};
  for (const [speciesKey, v] of Object.entries(out.animalTargets.herds)) {
    const row = isObj(v) ? v : {};
    const purpose = normalizeStr(row.purpose) || "mixed";
    out.animalTargets.herds[speciesKey] = stripUndefined({
      count: clampNumOrNull(row.count, 0, 100000),
      purpose,
      notes:
        typeof row.notes === "string"
          ? row.notes
          : row.notes == null
          ? undefined
          : String(row.notes),
    });
  }

  out.animalTargets.production.eggsPerWeek = clampNumOrNull(
    out.animalTargets.production.eggsPerWeek,
    0,
    100000
  );
  out.animalTargets.production.milkGallonsPerWeek = clampNumOrNull(
    out.animalTargets.production.milkGallonsPerWeek,
    0,
    100000
  );
  out.animalTargets.production.meatLbsPerMonth = clampNumOrNull(
    out.animalTargets.production.meatLbsPerMonth,
    0,
    1e9
  );

  // storehouseTargets
  out.storehouseTargets.jarsAvailable = clampNumOrNull(
    out.storehouseTargets.jarsAvailable,
    0,
    50000
  );
  out.storehouseTargets.freezerCuFt = clampNumOrNull(
    out.storehouseTargets.freezerCuFt,
    0,
    10000
  );
  out.storehouseTargets.dehydratorTrays = clampNumOrNull(
    out.storehouseTargets.dehydratorTrays,
    0,
    1000
  );
  out.storehouseTargets.rootCellarAvailable = asBoolOrNull(
    out.storehouseTargets.rootCellarAvailable
  );
  out.storehouseTargets.procurement.needed = Array.isArray(
    out.storehouseTargets.procurement.needed
  )
    ? out.storehouseTargets.procurement.needed.map((x) =>
        isObj(x) ? stripUndefined(x) : { label: String(x) }
      )
    : [];

  // skillsTargets
  out.skillsTargets.capNewSkillsPerWeek = clampNumOrNull(
    out.skillsTargets.capNewSkillsPerWeek,
    0,
    20
  );

  const normalizeSkillItem = (x) => {
    if (!isObj(x)) return { key: String(x).trim() || "unknown", priority: 0 };
    return stripUndefined({
      key: String(x.key ?? "unknown").trim() || "unknown",
      label:
        typeof x.label === "string"
          ? x.label
          : x.label == null
          ? undefined
          : String(x.label),
      priority: clampNumOrNull(x.priority, -100, 100) ?? 0,
      notes:
        typeof x.notes === "string"
          ? x.notes
          : x.notes == null
          ? undefined
          : String(x.notes),
    });
  };

  out.skillsTargets.learningQueue = Array.isArray(
    out.skillsTargets.learningQueue
  )
    ? out.skillsTargets.learningQueue.map(normalizeSkillItem)
    : [];
  out.skillsTargets.completed = Array.isArray(out.skillsTargets.completed)
    ? out.skillsTargets.completed.map(normalizeSkillItem)
    : [];

  // explain fields
  const normExplainList = (v) =>
    Array.isArray(v)
      ? v.map((x) => (isObj(x) ? stripUndefined(x) : { text: String(x) }))
      : [];
  out.explain.assumptions = normExplainList(out.explain.assumptions);
  out.explain.gaps = normExplainList(out.explain.gaps);
  out.explain.actions = normExplainList(out.explain.actions);

  if (!Number.isFinite(Number(out.schemaVersion))) out.schemaVersion = 1;

  return out;
}

/** Lazy-load db and eventBus (path-tolerant) */
async function getDbAndBus() {
  let db = null;
  let eventBus = null;

  try {
    const mod = await import("@/services/db");
    db = mod.db || mod.default || null;
  } catch {
    try {
      const mod = await import("../../db");
      db = mod.db || mod.default || null;
    } catch {
      // ignore
    }
  }

  try {
    const mod = await import("@/services/events/eventBus");
    eventBus = mod.eventBus || mod.default || null;
  } catch {
    try {
      const mod = await import("../../events/eventBus");
      eventBus = mod.eventBus || mod.default || null;
    } catch {
      // ignore
    }
  }

  return { db, eventBus };
}

function hasTable(db, name) {
  try {
    if (!db || !db.tables) return false;
    return db.tables.some((t) => t && t.name === name);
  } catch {
    return false;
  }
}

function pickFirstExistingTable(db, candidates) {
  for (const n of candidates) if (hasTable(db, n)) return n;
  return null;
}

function emit(bus, evt, payload) {
  try {
    if (!bus) return;
    if (typeof bus.emit === "function") bus.emit(evt, payload);
    else if (typeof bus.publish === "function") bus.publish(evt, payload);
  } catch (e) {
    console.warn(`[HP targets] event emit failed: ${evt}`, e);
  }
}

/**
 * Repo factory (dependency-injectable).
 *   const repo = createHomesteadPlannerTargetsRepo({ db, eventBus })
 */
export function createHomesteadPlannerTargetsRepo(deps = {}) {
  const injectedDb = deps.db || null;
  const injectedBus = deps.eventBus || null;

  async function resolve() {
    if (injectedDb || injectedBus)
      return { db: injectedDb, eventBus: injectedBus };
    return getDbAndBus();
  }

  async function resolveStorage(db) {
    const primary = pickFirstExistingTable(db, TABLE_CANDIDATES);
    const history = pickFirstExistingTable(db, HISTORY_TABLE_CANDIDATES);
    const kv = pickFirstExistingTable(db, KV_TABLE_CANDIDATES);
    return { primary, history, kv };
  }

  /**
   * Reads targets; returns defaults merged with stored targets.
   * @param {object} args
   * @param {string} args.householdId
   * @param {string|null} [args.userId]
   * @param {string|null} [args.planId]
   */
  async function getTargets({
    householdId,
    userId = null,
    planId = null,
  } = {}) {
    const { db } = await resolve();
    if (!db)
      return sanitizeHomesteadPlannerTargets(
        getHomesteadPlannerTargetsDefaults()
      );

    const { primary, kv } = await resolveStorage(db);
    const id = makeHomesteadPlannerTargetsId({ householdId, userId, planId });

    let stored = null;

    if (primary) {
      const rec = await db.table(primary).get(id);
      stored = rec ? rec.targets || rec.data || rec.value || null : null;
    } else if (kv) {
      const key = `homesteadPlanner.targets.${id}`;
      const row =
        (await db.table(kv).get(key)) ||
        (await db.table(kv).get(`hpTargets:${id}`)) ||
        null;
      stored = row ? row.value || row.val || row.data || null : null;
    }

    return sanitizeHomesteadPlannerTargets(stored);
  }

  /**
   * Returns the raw stored record (if available). Useful for debugging.
   */
  async function getTargetsRecord({
    householdId,
    userId = null,
    planId = null,
  } = {}) {
    const { db } = await resolve();
    if (!db) return null;

    const { primary, kv } = await resolveStorage(db);
    const id = makeHomesteadPlannerTargetsId({ householdId, userId, planId });

    if (primary) return db.table(primary).get(id);

    if (kv) {
      const key = `homesteadPlanner.targets.${id}`;
      return (
        (await db.table(kv).get(key)) ||
        (await db.table(kv).get(`hpTargets:${id}`)) ||
        null
      );
    }

    return null;
  }

  /**
   * Upserts targets.
   * - default behavior deep-merges patch into existing targets (sanitized)
   * - replace=true replaces entirely (still sanitized)
   *
   * Persisted record fields (primary table):
   *  { id, householdId, userId, planId, status, title, notes, targets, schemaVersion, source, reason, createdAt, updatedAt }
   */
  async function setTargets({
    householdId,
    userId = null,
    planId = null,
    patch = {},
    replace = false,
    source = DEFAULT_SOURCE,
    reason = "user_update",
    emitEvents = true,
    writeHistory = true,
  } = {}) {
    const { db, eventBus } = await resolve();
    const id = makeHomesteadPlannerTargetsId({ householdId, userId, planId });
    const at = nowISO();

    if (!db) {
      const base = sanitizeHomesteadPlannerTargets(
        getHomesteadPlannerTargetsDefaults()
      );
      const next = sanitizeHomesteadPlannerTargets(
        replace ? patch : deepMerge(base, patch)
      );
      if (emitEvents) {
        emit(eventBus, HP_TARGETS_EVENTS.UPDATED, {
          householdId,
          userId,
          planId,
          id,
          source,
          reason,
          updatedAt: at,
          targets: jclone(next),
          persistence: "none",
        });
      }
      return next;
    }

    const { primary, history, kv } = await resolveStorage(db);

    // Build next targets
    let current = null;
    if (!replace) current = await getTargets({ householdId, userId, planId });
    const defaults = sanitizeHomesteadPlannerTargets(
      getHomesteadPlannerTargetsDefaults()
    );
    const nextTargets = sanitizeHomesteadPlannerTargets(
      replace ? deepMerge(defaults, patch) : deepMerge(current, patch)
    );

    // Persist
    if (primary) {
      const t = db.table(primary);
      const record = {
        id,
        householdId: String(householdId),
        userId: userId == null ? null : String(userId),
        planId: planId == null ? null : String(planId),
        status: nextTargets.status,
        title: nextTargets.title,
        notes: nextTargets.notes,
        targets: jclone(nextTargets),
        schemaVersion: Number(nextTargets.schemaVersion) || 1,
        source,
        reason,
        createdAt: at,
        updatedAt: at,
      };

      await db.transaction(
        "rw",
        t,
        ...(history ? [db.table(history)] : []),
        async () => {
          const existing = await t.get(id);
          if (existing && existing.createdAt)
            record.createdAt = existing.createdAt;

          await t.put(record);

          if (history && writeHistory) {
            await db.table(history).add({
              id,
              householdId: record.householdId,
              userId: record.userId,
              planId: record.planId,
              at,
              source,
              reason,
              status: record.status,
              targets: jclone(nextTargets),
            });
          }
        }
      );

      if (emitEvents) {
        emit(eventBus, HP_TARGETS_EVENTS.UPDATED, {
          householdId,
          userId,
          planId,
          id,
          source,
          reason,
          updatedAt: at,
          status: nextTargets.status,
          targets: jclone(nextTargets),
          persistence: "table",
          table: primary,
        });
      }

      return nextTargets;
    }

    if (kv) {
      const t = db.table(kv);
      const keyA = `homesteadPlanner.targets.${id}`;
      const keyB = `hpTargets:${id}`;

      await db.transaction("rw", t, async () => {
        const existingA = await t.get(keyA);
        const existingB = existingA ? null : await t.get(keyB);
        const keyToUse = existingB ? keyB : keyA;

        const base = existingB || existingA || { key: keyToUse };
        const out = {
          ...base,
          key: base.key ?? keyToUse,
          id: base.id ?? base.key ?? keyToUse,
          value: jclone(nextTargets),
          status: nextTargets.status,
          title: nextTargets.title,
          updatedAt: at,
          source,
          reason,
        };

        await t.put(out);
      });

      if (emitEvents) {
        emit(eventBus, HP_TARGETS_EVENTS.UPDATED, {
          householdId,
          userId,
          planId,
          id,
          source,
          reason,
          updatedAt: at,
          status: nextTargets.status,
          targets: jclone(nextTargets),
          persistence: "kv",
          table: kv,
        });
      }

      return nextTargets;
    }

    // No compatible tables — return sanitized without persistence
    if (emitEvents) {
      emit(eventBus, HP_TARGETS_EVENTS.UPDATED, {
        householdId,
        userId,
        planId,
        id,
        source,
        reason,
        updatedAt: at,
        status: nextTargets.status,
        targets: jclone(nextTargets),
        persistence: "none",
      });
    }
    return nextTargets;
  }

  /**
   * Convenience: set status only (atomic patch).
   */
  async function setTargetsStatus({
    householdId,
    userId = null,
    planId = null,
    status,
    source = DEFAULT_SOURCE,
    reason = "status_change",
    emitEvents = true,
  } = {}) {
    const nextStatus = clampEnum(
      String(status || "").trim(),
      TARGET_STATUS,
      "draft"
    );
    const next = await setTargets({
      householdId,
      userId,
      planId,
      patch: { status: nextStatus },
      replace: false,
      source,
      reason,
      emitEvents,
      writeHistory: true,
    });

    const { eventBus } = await resolve();
    if (emitEvents) {
      emit(eventBus, HP_TARGETS_EVENTS.STATUS_CHANGED, {
        householdId,
        userId,
        planId,
        id: makeHomesteadPlannerTargetsId({ householdId, userId, planId }),
        status: nextStatus,
        updatedAt: nowISO(),
        source,
        reason,
      });
    }

    return next;
  }

  /**
   * Resets targets to defaults (stored).
   */
  async function resetTargets({
    householdId,
    userId = null,
    planId = null,
    source = DEFAULT_SOURCE,
    reason = "reset_to_defaults",
    emitEvents = true,
  } = {}) {
    const defaults = sanitizeHomesteadPlannerTargets(
      getHomesteadPlannerTargetsDefaults()
    );
    const out = await setTargets({
      householdId,
      userId,
      planId,
      patch: defaults,
      replace: true,
      source,
      reason,
      emitEvents,
      writeHistory: true,
    });

    const { eventBus } = await resolve();
    if (emitEvents) {
      emit(eventBus, HP_TARGETS_EVENTS.RESET, {
        householdId,
        userId,
        planId,
        id: makeHomesteadPlannerTargetsId({ householdId, userId, planId }),
        updatedAt: nowISO(),
        source,
        reason,
      });
    }

    return out;
  }

  /**
   * Deletes targets for the given scope.
   */
  async function deleteTargets({
    householdId,
    userId = null,
    planId = null,
    source = DEFAULT_SOURCE,
    reason = "delete",
    emitEvents = true,
  } = {}) {
    const { db, eventBus } = await resolve();
    if (!db) return true;

    const { primary, kv } = await resolveStorage(db);
    const id = makeHomesteadPlannerTargetsId({ householdId, userId, planId });
    const at = nowISO();

    if (primary) {
      await db.table(primary).delete(id);
      if (emitEvents) {
        emit(eventBus, HP_TARGETS_EVENTS.UPDATED, {
          householdId,
          userId,
          planId,
          id,
          source,
          reason,
          updatedAt: at,
          targets: null,
          persistence: "table",
          table: primary,
          deleted: true,
        });
      }
      return true;
    }

    if (kv) {
      const t = db.table(kv);
      await t.delete(`homesteadPlanner.targets.${id}`);
      await t.delete(`hpTargets:${id}`);
      if (emitEvents) {
        emit(eventBus, HP_TARGETS_EVENTS.UPDATED, {
          householdId,
          userId,
          planId,
          id,
          source,
          reason,
          updatedAt: at,
          targets: null,
          persistence: "kv",
          table: kv,
          deleted: true,
        });
      }
      return true;
    }

    return false;
  }

  /**
   * List all targets records for a household (table-backed only).
   * If stored via KV fallback, returns [] (KV prefix querying is unreliable).
   */
  async function listHouseholdTargetsRecords({ householdId } = {}) {
    const { db } = await resolve();
    if (!db) return [];
    const { primary } = await resolveStorage(db);
    if (!primary) return [];

    return db
      .table(primary)
      .where("householdId")
      .equals(String(householdId))
      .toArray();
  }

  /**
   * List all plan-scoped targets for a household (table-backed only).
   */
  async function listHouseholdPlanTargetsRecords({ householdId } = {}) {
    const rows = await listHouseholdTargetsRecords({ householdId });
    return rows.filter((r) => r && r.planId);
  }

  /**
   * Effective targets = household baseline (userId=null, planId=current)
   * overridden by user-specific (userId, planId=current) if present.
   *
   * If planId is provided, effective uses that planId for both baseline+user.
   */
  async function getEffectiveTargets({
    householdId,
    userId = null,
    planId = null,
  } = {}) {
    const baseline = await getTargets({ householdId, userId: null, planId });
    if (userId == null) return baseline;

    const user = await getTargets({ householdId, userId, planId });
    // Treat user record as override layer; deep merge baseline->user.
    return sanitizeHomesteadPlannerTargets(deepMerge(baseline, user));
  }

  /**
   * Saves a new plan-scoped targets record (planId required).
   * If planId already exists, this acts like setTargets.
   */
  async function savePlanTargets({
    householdId,
    userId = null,
    planId,
    targets,
    status = "proposed",
    title = null,
    notes = "",
    source = DEFAULT_SOURCE,
    reason = "save_plan_targets",
    emitEvents = true,
  } = {}) {
    if (!planId) throw new Error("planId is required to save plan targets");
    const patch = deepMerge(targets || {}, { status, title, notes });
    return setTargets({
      householdId,
      userId,
      planId,
      patch,
      replace: true,
      source,
      reason,
      emitEvents,
      writeHistory: true,
    });
  }

  /**
   * Copies a plan’s targets into “current” (planId=null) for the same user scope.
   * Useful when a user approves a planning run.
   */
  async function promotePlanTargetsToCurrent({
    householdId,
    userId = null,
    planId,
    source = DEFAULT_SOURCE,
    reason = "promote_plan_to_current",
    emitEvents = true,
  } = {}) {
    if (!planId) throw new Error("planId is required");
    const planTargets = await getTargets({ householdId, userId, planId });
    // Promote with approved status unless already approved
    const desiredStatus =
      planTargets.status === "approved" ? "approved" : "approved";
    return setTargets({
      householdId,
      userId,
      planId: null,
      patch: deepMerge(planTargets, { status: desiredStatus }),
      replace: true,
      source,
      reason,
      emitEvents,
      writeHistory: true,
    });
  }

  return Object.freeze({
    // ids + defaults
    makeId: makeHomesteadPlannerTargetsId,
    defaults: getHomesteadPlannerTargetsDefaults,
    sanitize: sanitizeHomesteadPlannerTargets,

    // reads
    getTargets,
    getTargetsRecord,
    getEffectiveTargets,
    listHouseholdTargetsRecords,
    listHouseholdPlanTargetsRecords,

    // writes
    setTargets,
    setTargetsStatus,
    resetTargets,
    deleteTargets,

    // plan helpers
    savePlanTargets,
    promotePlanTargetsToCurrent,
  });
}

/**
 * Default singleton repo (auto-resolves db/eventBus).
 */
export const homesteadPlannerTargetsRepo = createHomesteadPlannerTargetsRepo();

/* -----------------------------------------------------------------------------
Example usage
------------------------------------------------------------------------------
import { homesteadPlannerTargetsRepo as hpTargets } from "@/services/repos/homesteadPlanner/targets.repo";

// Get targets in effect for current run
const targets = await hpTargets.getEffectiveTargets({ householdId, userId });

// Patch a few values
await hpTargets.setTargets({
  householdId,
  userId,
  patch: {
    provisioningTargets: { pantryBufferDays: 21, preserveSurplus: true },
    gardenTargets: { maxSqFt: 800, includeHerbs: true },
  },
  source: "pages/homesteadplanner/targets",
  reason: "user_adjusted_targets",
});

// Save a plan-scoped snapshot of targets
await hpTargets.savePlanTargets({
  householdId,
  userId,
  planId: "plan_2026_01_10_001",
  status: "proposed",
  title: "Winter-to-Spring Plan",
  targets,
});

// Approve and promote plan to current
await hpTargets.setTargetsStatus({ householdId, userId, planId: "plan_2026_01_10_001", status: "approved" });
await hpTargets.promotePlanTargetsToCurrent({ householdId, userId, planId: "plan_2026_01_10_001" });
----------------------------------------------------------------------------- */
