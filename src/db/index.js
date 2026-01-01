/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\db\index.js
// Dexie init; versioned schema; event-aware hooks (production-ready)
// -----------------------------------------------------------------------------
// Key production fixes applied:
// ✅ Ensure all schema + optional schema-adding migrations register BEFORE db.open()
// ✅ Avoid “adding db.version() after open” (Dexie forbids schema changes post-open)
// ✅ Make initialization idempotent + export a ready promise
// ✅ Keep defensive config + hub export behavior
// ✅ Keep existing logic/shape compatible (no breaking renames)

import Dexie from "dexie";

// existing migration (data migration; runs AFTER open)
import v7NormalizedStore from "./migrations/v7-normalized-store.js";

// optional, lazy-loaded migrations that may add new stores/versions
// - vXX-add-plays.js
// - vXX-favorites-schedules.js

const DB_NAME = "suka-smart-assistant";
// bump to 10 to register plays & playHistory in base schema (v9 was household split)
const DB_VERSION = 10;

/* ----------------------------------------------------------------------------
   Safe config reader (no hard import of "@/config")
---------------------------------------------------------------------------- */
function readConfig() {
  const w = typeof window !== "undefined" ? window : {};
  const flags = w.__SUKA_FLAGS__ || w.sukaFeatureFlags || w.sukaFlags || {}; // loose

  const sukaConfig = w.sukaConfig || {};
  return {
    featureFlags: sukaConfig.featureFlags || flags,
    domains: sukaConfig.domains || {},
    allowUserFavorites:
      typeof sukaConfig.allowUserFavorites === "boolean"
        ? sukaConfig.allowUserFavorites
        : true,
    allowUserSchedules:
      typeof sukaConfig.allowUserSchedules === "boolean"
        ? sukaConfig.allowUserSchedules
        : true,
    runtimeHints: sukaConfig.runtimeHints || {},
  };
}

/* ----------------------------------------------------------------------------
   General helpers
---------------------------------------------------------------------------- */
function nowIso() {
  return new Date().toISOString();
}

// small helper for event bus dispatch — consistent shape
function emitEvent(type, data = {}, source = "db.index") {
  const payload = { type, ts: nowIso(), source, data };
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent(type, { detail: payload }));
    } catch {}
    try {
      const bus = window.__suka?.eventBus;
      if (bus && typeof bus.emit === "function") bus.emit(payload);
    } catch {}
  }
}

// Try a list of module paths without forcing Vite to resolve them up-front.
async function loadOptionalModule(paths = []) {
  for (const p of paths) {
    try {
      // IMPORTANT: vite-ignore keeps Vite from statically resolving the path
      const mod = await import(/* @vite-ignore */ p);
      return mod?.default ?? mod;
    } catch {
      // try next candidate
    }
  }
  return null;
}

// SSA owns data first. If familyFundMode=true we *also* format + send to Hub.
// This is deliberately defensive and silent on failure.
async function exportToHubIfEnabled(payload) {
  try {
    const cfg = readConfig();
    const enabled =
      cfg?.featureFlags?.familyFundMode === true ||
      cfg?.featureFlags?.["familyFundMode"] === true;
    if (!enabled) return;

    // Lazy-load both formatter & connector from either /connectors or /services
    const [HubPacketFormatter, FamilyFundConnector] = await Promise.all([
      loadOptionalModule([
        "@/connectors/HubPacketFormatter.js",
        "src/connectors/HubPacketFormatter.js",
        "@/services/hub/HubPacketFormatter.js",
        "@/services/HubPacketFormatter.js",
      ]),
      loadOptionalModule([
        "@/connectors/FamilyFundConnector.js",
        "src/connectors/FamilyFundConnector.js",
        "@/services/hub/FamilyFundConnector.js",
        "@/services/FamilyFundConnector.js",
      ]),
    ]);

    if (!HubPacketFormatter || !FamilyFundConnector) return;

    const packet = HubPacketFormatter.format?.(payload) ??
      HubPacketFormatter.wrap?.("db-event", payload) ?? {
        kind: "db-event",
        payload,
      };

    await FamilyFundConnector.send?.(packet);
  } catch {
    // ignore; hub is optional
  }
}

// ensures rows have userId, householdId, timestamps, and orchestration meta
function ensureRowBase(obj, cfg, domain) {
  const row = { ...obj };
  if (!row.userId) row.userId = "__current_user__";
  if (!row.householdId) row.householdId = "__default_household__";

  const domCfg = cfg.domains?.[domain];
  const canFav = cfg.allowUserFavorites && domCfg?.allowUserFavorites !== false;
  const canSched =
    cfg.allowUserSchedules && domCfg?.allowUserSchedules !== false;

  if (typeof row.favorite === "undefined")
    row.favorite = canFav ? false : false;

  if (typeof row.schedule === "undefined") {
    row.schedule = canSched ? { enabled: false } : null;
  }

  if (!row.createdAt) row.createdAt = nowIso();
  row.updatedAt = nowIso();

  if (!row.orchestration) {
    row.orchestration = {
      bus: cfg.runtimeHints?.domChannel || "window.__suka?.eventBus",
      shared: cfg.runtimeHints?.sharedBus ?? true,
      source: "db.index.hook",
      domain,
    };
  }
  return row;
}

/* ----------------------------------------------------------------------------
   Dexie init + schema (schema MUST be fully registered BEFORE open)
---------------------------------------------------------------------------- */
export const db = new Dexie(DB_NAME);

// Notes on indexes: Dexie store syntax "primaryKey, index1, [compound+index]"
db.version(DB_VERSION).stores({
  // app/meta
  meta: "id",

  // HOUSEHOLD CORE -----------------------------------------------------------
  households: "id, slug, name, ownerId",
  householdMembers: "id, householdId, email, role, [householdId+role]",
  userPreferences: "id, householdId, userId, [householdId+userId]",
  automations: "id, householdId, eventType, enabled",
  events: "id, householdId, type, source, ts",

  // IMPORT STACK -------------------------------------------------------------
  importSources: "id, host, domain, [host+domain]",
  importQueue: "id, status, source, domain, createdAt",
  imports:
    "id, householdId, domain, source, status, [householdId+domain], createdAt",
  importErrors: "id, source, domain, createdAt",
  importMappings: "id, domain, engine, [domain+engine]",
  importToSessionRequests:
    "id, householdId, importId, status, requestedSessionType",
  importExports: "id, householdId, importId, target, exportedAt",

  // MEALS --------------------------------------------------------------------
  recipes: "id, title, tags",
  mealPlans: "id, userId, householdId, createdAt",
  cookingSessions: "id, mealPlanId, date, createdAt",

  // CLEANING -----------------------------------------------------------------
  cleaningSessions: "id, userId, householdId, zone, createdAt",

  // GARDEN -------------------------------------------------------------------
  gardenPlans: "id, userId, householdId, season, createdAt",
  gardenQueue: "id, planId, type, due, createdAt",
  gardenHarvests: "id, householdId, gardenPlanId, crop, ts",

  // STOREHOUSE ---------------------------------------------------------------
  storehouseGoals: "id, userId, householdId, category, createdAt",

  // ANIMALS ------------------------------------------------------------------
  animalPlans: "id, userId, householdId, createdAt",
  animalCare: "id, animalPlanId, createdAt",
  butcherySessions: "id, animalPlanId, date, createdAt",
  animalAssets: "id, householdId, species, status, updatedAt",

  // PRESERVATION -------------------------------------------------------------
  preservationBatches: "id, householdId, method, sourceType, ts",

  // SESSIONS (GENERAL / ACTIONABLE) -----------------------------------------
  sessions:
    "id, householdId, type, status, scheduledFor, [householdId+type], [householdId+status]",

  // INVENTORY / PRICEBOOK ----------------------------------------------------
  inventory: "id, householdId, name, location, category, createdAt",
  pricebook:
    "id, householdId, sku, retailer, [householdId+sku], [householdId+retailer]",
  coupons: "id, provider, createdAt",

  // SYNC / HUB ---------------------------------------------------------------
  syncQueue: "id, householdId, status, target, createdAt",

  // LEGACY / IMPORTED SESSIONS ----------------------------------------------
  importSessions: "id, type, sourceUrl, createdAt",

  // NEW CORE TABLES (EXECUTION) ---------------------------------------------
  plays: "id, sessionId, domain, status, updatedAt",
  playHistory: "id, sessionId, domain, startedAt, endedAt, outcome",

  // USER PREFERENCES (CROSS-DOMAIN) -----------------------------------------
  favorites: "id, domain, kind, targetId, createdAt",
  scheduleTemplates: "id, domain, enabled, nextRunAt",
});

/* ----------------------------------------------------------------------------
   OPTIONAL SCHEMA REGISTRATION (must happen BEFORE open)
---------------------------------------------------------------------------- */
let _schemaRegistered = false;

async function registerOptionalSchemaVersions() {
  if (_schemaRegistered) return;
  _schemaRegistered = true;

  // Any optional migration that calls db.version(...).stores(...) must happen here.
  // We load them defensively; if they don’t exist, no problem.
  try {
    const addPlays = await loadOptionalModule([
      "./migrations/vXX-add-plays.js",
      "src/db/migrations/vXX-add-plays.js",
    ]);
    if (typeof addPlays === "function") {
      try {
        addPlays(db);
      } catch {}
    }
  } catch {}

  try {
    const favSched = await loadOptionalModule([
      "./migrations/vXX-favorites-schedules.js",
      "src/db/migrations/vXX-favorites-schedules.js",
    ]);
    if (typeof favSched === "function") {
      try {
        favSched(db);
      } catch {}
    }
  } catch {}

  // Keep your legacy optional data migrations discoverable, but DO NOT let them
  // register schema versions after open. If those modules add schema versions,
  // they must be refactored to export a registerSchema(db) function.
  // Here we only call `.migrate` after open (see init).
}

/* ----------------------------------------------------------------------------
   OPEN + DATA MIGRATE (idempotent, production-safe)
---------------------------------------------------------------------------- */
let _initPromise = null;

async function initDbOnce() {
  await registerOptionalSchemaVersions();

  await db.open();

  // Run data migrations AFTER open (safe)
  try {
    await v7NormalizedStore.migrate(db);
  } catch (err) {
    if (import.meta?.env?.DEV) {
      console.warn("[db] v7NormalizedStore.migrate failed (non-fatal):", err);
    }
  }

  // Optional data migrations (safe after open) -------------------------------
  // v1 (optional)
  try {
    const v1 = await loadOptionalModule([
      "./migrations/v1-imports.js",
      "src/db/migrations/v1-imports.js",
    ]);
    if (v1 && typeof v1.migrate === "function") {
      await v1.migrate(db);
    }
  } catch {}

  // v3 (optional)
  try {
    const v3 = await loadOptionalModule([
      "./migrations/v3-household-analytics.js", // ✅ your file
      "src/db/migrations/v3-household-analytics.js",
      "./migrations/v3-household.js", // legacy
      "src/db/migrations/v3-household.js",
    ]);
    if (v3 && typeof v3.migrate === "function") {
      await v3.migrate(db);
    }
  } catch {}

  emitEvent("db.ready", { at: nowIso(), version: db.verno || DB_VERSION });
  return db;
}

// Export a ready promise callers can await (recommended)
export const dbReady = (() => {
  if (_initPromise) return _initPromise;
  _initPromise = initDbOnce().catch((err) => {
    console.error("[db] failed to open", err);
    // Re-throw so awaiters can handle it
    throw err;
  });
  return _initPromise;
})();

/* ----------------------------------------------------------------------------
   EVENT-AWARE HOOKS
---------------------------------------------------------------------------- */
function attachHooks() {
  const cfg = readConfig();

  // HOUSEHOLD ---------------------------------------------------------------
  if (db.households) {
    db.households.hook("creating", function (_pk, obj) {
      const row = ensureRowBase(obj, cfg, "household");
      emitEvent("household.created", { id: row.id, household: row });
      exportToHubIfEnabled({
        type: "household.created",
        ts: nowIso(),
        source: "db.index.households",
        data: row,
      });
      return row;
    });
    db.households.hook("updating", function (mods, pk, oldObj) {
      emitEvent("household.updated", { id: pk, mods, old: oldObj });
      exportToHubIfEnabled({
        type: "household.updated",
        ts: nowIso(),
        source: "db.index.households",
        data: { id: pk, mods, old: oldObj },
      });
    });
  }

  if (db.householdMembers) {
    db.householdMembers.hook("creating", function (_pk, obj) {
      const row = ensureRowBase(obj, cfg, "household");
      emitEvent("household.member.added", { id: row.id, member: row });
      exportToHubIfEnabled({
        type: "household.member.added",
        ts: nowIso(),
        source: "db.index.householdMembers",
        data: row,
      });
      return row;
    });
  }

  // IMPORT STACK ------------------------------------------------------------
  if (db.imports) {
    db.imports.hook("creating", function (_pk, obj) {
      const row = ensureRowBase(obj, cfg, "import");
      emitEvent("import.parsed", {
        id: row.id,
        householdId: row.householdId,
        domain: row.domain,
        source: row.source,
        normalizedPayload: row.normalizedPayload,
      });
      exportToHubIfEnabled({
        type: "import.parsed",
        ts: nowIso(),
        source: "db.index.imports",
        data: row,
      });
      return row;
    });
    db.imports.hook("updating", function (mods, pk, oldObj) {
      emitEvent("import.updated", { id: pk, mods, old: oldObj });
    });
  }

  if (db.importToSessionRequests) {
    db.importToSessionRequests.hook("creating", function (_pk, obj) {
      const row = ensureRowBase(obj, cfg, "import");
      emitEvent("import.session.generate.requested", {
        id: row.id,
        importId: row.importId,
        requestedSessionType: row.requestedSessionType,
      });
      return row;
    });
  }

  // MEALS -------------------------------------------------------------------
  if (db.mealPlans) {
    db.mealPlans.hook("creating", function (_pk, obj) {
      const row = ensureRowBase(obj, cfg, "meals");
      emitEvent("meals.plan.created", { id: row.id, plan: row });
      exportToHubIfEnabled({
        type: "meals.plan.created",
        ts: nowIso(),
        source: "db.index.mealPlans",
        data: row,
      });
      return row;
    });
  }

  // CLEANING ----------------------------------------------------------------
  if (db.cleaningSessions) {
    db.cleaningSessions.hook("creating", function (_pk, obj) {
      const row = ensureRowBase(obj, cfg, "cleaning");
      emitEvent("cleaning.session.created", { id: row.id, session: row });
      exportToHubIfEnabled({
        type: "cleaning.session.created",
        ts: nowIso(),
        source: "db.index.cleaningSessions",
        data: row,
      });
      return row;
    });
  }

  // GARDEN ------------------------------------------------------------------
  if (db.gardenPlans) {
    db.gardenPlans.hook("creating", function (_pk, obj) {
      const row = ensureRowBase(obj, cfg, "garden");
      emitEvent("garden.plan.created", { id: row.id, plan: row });
      return row;
    });
  }

  if (db.gardenHarvests) {
    db.gardenHarvests.hook("creating", function (_pk, obj) {
      const row = ensureRowBase(obj, cfg, "garden");
      emitEvent("garden.harvest.logged", { id: row.id, harvest: row });
      exportToHubIfEnabled({
        type: "garden.harvest.logged",
        ts: nowIso(),
        source: "db.index.gardenHarvests",
        data: row,
      });
      return row;
    });
  }

  if (db.gardenQueue) {
    db.gardenQueue.hook("creating", function (_pk, obj) {
      const row = ensureRowBase(obj, cfg, "garden");
      emitEvent("garden.care.task.created", { id: row.id, task: row });
      return row;
    });
  }

  // STOREHOUSE --------------------------------------------------------------
  if (db.storehouseGoals) {
    db.storehouseGoals.hook("creating", function (_pk, obj) {
      const row = ensureRowBase(obj, cfg, "storehouse");
      emitEvent("storehouse.goal.created", { id: row.id, goal: row });
      exportToHubIfEnabled({
        type: "storehouse.goal.created",
        ts: nowIso(),
        source: "db.index.storehouseGoals",
        data: row,
      });
      return row;
    });
  }

  // ANIMALS -----------------------------------------------------------------
  if (db.animalAssets) {
    db.animalAssets.hook("creating", function (_pk, obj) {
      const row = ensureRowBase(obj, cfg, "animals");
      emitEvent("animals.asset.created", { id: row.id, asset: row });
      exportToHubIfEnabled({
        type: "animals.asset.created",
        ts: nowIso(),
        source: "db.index.animalAssets",
        data: row,
      });
      return row;
    });
  }

  if (db.butcherySessions) {
    db.butcherySessions.hook("creating", function (_pk, obj) {
      const row = ensureRowBase(obj, cfg, "animals");
      emitEvent("animals.butchery.session.created", {
        id: row.id,
        session: row,
      });

      // butchery produces outputs we might want to route to storehouse/meals
      if (Array.isArray(row.outputs) && row.outputs.length) {
        const toStorehouse = row.outputs.filter(
          (o) => o.routeTo === "storehouse"
        );
        const toMeals = row.outputs.filter((o) => o.routeTo === "meals");

        if (toStorehouse.length) {
          emitEvent("storehouse.stock.fromButchery", {
            sessionId: row.id,
            outputs: toStorehouse,
          });
          exportToHubIfEnabled({
            type: "storehouse.stock.fromButchery",
            ts: nowIso(),
            source: "db.index.butcherySessions",
            data: { sessionId: row.id, outputs: toStorehouse },
          });
        }

        if (toMeals.length) {
          emitEvent("meals.ingredients.fromButchery", {
            sessionId: row.id,
            outputs: toMeals,
          });
        }
      }
      return row;
    });
  }

  // PRESERVATION -------------------------------------------------------------
  if (db.preservationBatches) {
    db.preservationBatches.hook("creating", function (_pk, obj) {
      const row = ensureRowBase(obj, cfg, "preservation");
      emitEvent("preservation.completed", { id: row.id, batch: row });
      exportToHubIfEnabled({
        type: "preservation.completed",
        ts: nowIso(),
        source: "db.index.preservationBatches",
        data: row,
      });
      return row;
    });
  }

  // INVENTORY ---------------------------------------------------------------
  if (db.inventory) {
    db.inventory.hook("creating", function (_pk, obj) {
      const row = ensureRowBase(obj, cfg, "inventory");
      emitEvent("inventory.updated", {
        id: row.id,
        item: row,
        intent: "create",
      });
      exportToHubIfEnabled({
        type: "inventory.updated",
        ts: nowIso(),
        source: "db.index.inventory",
        data: { item: row, intent: "create" },
      });
      return row;
    });
    db.inventory.hook("updating", function (mods, pk, oldObj) {
      const newObj = { ...oldObj, ...mods, updatedAt: nowIso() };
      emitEvent("inventory.updated", {
        id: pk,
        item: newObj,
        intent: "update",
      });
      exportToHubIfEnabled({
        type: "inventory.updated",
        ts: nowIso(),
        source: "db.index.inventory",
        data: { item: newObj, intent: "update" },
      });

      if (
        typeof newObj.minThreshold === "number" &&
        typeof newObj.quantity === "number" &&
        newObj.quantity < newObj.minThreshold
      ) {
        emitEvent("inventory.shortage.detected", { id: pk, item: newObj });
        exportToHubIfEnabled({
          type: "inventory.shortage.detected",
          ts: nowIso(),
          source: "db.index.inventory",
          data: { item: newObj },
        });
      }
      return mods;
    });
  }

  // SESSIONS (GENERAL) ------------------------------------------------------
  if (db.sessions) {
    db.sessions.hook("creating", function (_pk, obj) {
      const row = ensureRowBase(obj, cfg, "sessions");
      emitEvent("session.created", { id: row.id, session: row });
      exportToHubIfEnabled({
        type: "session.created",
        ts: nowIso(),
        source: "db.index.sessions",
        data: row,
      });
      return row;
    });
  }

  /* ------------------------------------------------------------------------
     EXECUTION TABLES — plays & playHistory
  ------------------------------------------------------------------------- */
  if (db.plays) {
    db.plays.hook("creating", function (_pk, obj) {
      const row = ensureRowBase(obj, cfg, "plays");
      const status = (row.status || "active").toLowerCase();
      row.status = status;

      const base = {
        id: row.id,
        sessionId: row.sessionId,
        domain: row.domain,
        status: row.status,
        stepIndex: row.stepIndex ?? 0,
        timers: Array.isArray(row.timers) ? row.timers : [],
      };

      emitEvent("play.created", base);

      if (status === "active") emitEvent("play.started", base);
      if (status === "paused") emitEvent("play.paused", base);

      exportToHubIfEnabled({
        type: "play.created",
        ts: nowIso(),
        source: "db.index.plays",
        data: base,
      });

      return row;
    });

    db.plays.hook("updating", function (mods, pk, oldObj) {
      const newObj = { ...oldObj, ...mods };
      newObj.updatedAt = nowIso();

      const oldStatus = (oldObj.status || "active").toLowerCase();
      const newStatus = (newObj.status || oldStatus).toLowerCase();

      const base = {
        id: pk,
        sessionId: newObj.sessionId,
        domain: newObj.domain,
        status: newStatus,
        prevStatus: oldStatus,
        stepIndex: newObj.stepIndex ?? 0,
        prevStepIndex: oldObj.stepIndex ?? 0,
        timers: Array.isArray(newObj.timers) ? newObj.timers : [],
        prevTimers: Array.isArray(oldObj.timers) ? oldObj.timers : [],
      };

      emitEvent("play.updated", base);

      if (newStatus !== oldStatus) {
        emitEvent("play.status.changed", base);
        if (newStatus === "active" && oldStatus === "paused")
          emitEvent("play.resumed", base);
        if (newStatus === "paused" && oldStatus === "active")
          emitEvent("play.paused", base);
        if (newStatus === "stopped") emitEvent("play.stopped", base);
        if (newStatus === "completed") emitEvent("play.completed", base);
      }

      if ((newObj.stepIndex ?? 0) !== (oldObj.stepIndex ?? 0)) {
        emitEvent("play.step.changed", {
          id: pk,
          sessionId: newObj.sessionId,
          domain: newObj.domain,
          from: oldObj.stepIndex ?? 0,
          to: newObj.stepIndex ?? 0,
        });
      }

      const tOld = JSON.stringify(oldObj.timers || []);
      const tNew = JSON.stringify(newObj.timers || []);
      if (tOld !== tNew) {
        emitEvent("play.timers.changed", {
          id: pk,
          sessionId: newObj.sessionId,
          domain: newObj.domain,
          timers: newObj.timers || [],
        });
      }

      exportToHubIfEnabled({
        type: "play.updated",
        ts: nowIso(),
        source: "db.index.plays",
        data: base,
      });

      return mods;
    });

    db.plays.hook("deleting", function (pk, obj) {
      emitEvent("play.deleted", {
        id: pk,
        sessionId: obj?.sessionId,
        domain: obj?.domain,
      });
      exportToHubIfEnabled({
        type: "play.deleted",
        ts: nowIso(),
        source: "db.index.plays",
        data: { id: pk, sessionId: obj?.sessionId, domain: obj?.domain },
      });
    });
  }

  if (db.playHistory) {
    db.playHistory.hook("creating", function (_pk, obj) {
      const row = ensureRowBase(obj, cfg, "playHistory");
      const durationMs =
        typeof row.durationMs === "number"
          ? Math.max(0, row.durationMs)
          : Math.max(
              0,
              new Date(row.endedAt || row.updatedAt).getTime() -
                new Date(row.startedAt || row.createdAt).getTime()
            );
      row.durationMs = durationMs;

      const payload = {
        id: row.id,
        sessionId: row.sessionId,
        domain: row.domain,
        outcome: (row.outcome || "completed").toLowerCase(),
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        durationMs,
        stepsCompleted: row.stepsCompleted ?? undefined,
      };

      emitEvent("play.finished", payload);
      exportToHubIfEnabled({
        type: "play.finished",
        ts: nowIso(),
        source: "db.index.playHistory",
        data: payload,
      });

      if (payload.domain === "cooking" && payload.outcome === "completed") {
        emitEvent("meal.executed", {
          sessionId: payload.sessionId,
          at: row.endedAt || nowIso(),
          durationMs,
        });
      }

      return row;
    });
  }

  // USER PREFERENCES (generic tables)
  if (db.favorites) {
    db.favorites.hook("creating", function (_pk, obj) {
      const row = ensureRowBase(obj, cfg, "favorites");
      emitEvent("favorites.added", {
        id: row.id,
        domain: row.domain,
        targetId: row.targetId,
      });
      exportToHubIfEnabled({
        type: "favorites.added",
        ts: nowIso(),
        source: "db.index.favorites",
        data: row,
      });
      return row;
    });
    db.favorites.hook("deleting", function (pk, obj) {
      emitEvent("favorites.removed", {
        id: pk,
        domain: obj?.domain,
        targetId: obj?.targetId,
      });
      exportToHubIfEnabled({
        type: "favorites.removed",
        ts: nowIso(),
        source: "db.index.favorites",
        data: { id: pk, domain: obj?.domain, targetId: obj?.targetId },
      });
    });
  }

  if (db.scheduleTemplates) {
    db.scheduleTemplates.hook("creating", function (_pk, obj) {
      const row = ensureRowBase(obj, cfg, "scheduleTemplates");
      emitEvent("schedule.template.upserted", {
        id: row.id,
        domain: row.domain,
        enabled: row.enabled !== false,
      });
      exportToHubIfEnabled({
        type: "schedule.template.upserted",
        ts: nowIso(),
        source: "db.index.scheduleTemplates",
        data: row,
      });
      return row;
    });
    db.scheduleTemplates.hook("updating", function (mods, pk, oldObj) {
      emitEvent("schedule.template.upserted", { id: pk, mods, old: oldObj });
    });
  }
}

// attach hooks immediately (safe; tables are available after stores() calls)
attachHooks();

// Kick off db open/migrations once at module load (callers can still await dbReady)
void dbReady;

// convenience export
export default db;
