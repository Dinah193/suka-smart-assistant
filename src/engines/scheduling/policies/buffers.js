// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\policies\buffers.js
/**
 * SSA Scheduling Policies — Central Buffer Settings & Overrides
 * --------------------------------------------------------------
 * Purpose:
 *   Provide a single place to resolve “how much buffer (minutes) should we add?”
 *   for any planned session step or whole-session estimate, with a clear
 *   precedence order and safe defaults. Also supports persistent household-level
 *   overrides and ephemeral runtime overrides.
 *
 * How it fits the SSA pipeline:
 *   imports → intelligence → automation → (optional) hub export
 *   - imports + intelligence → produce estimates (prep/setup/task/cleanup)
 *   - THIS MODULE → resolves recommended buffer minutes using:
 *       1) household overrides (policies.buffers)
 *       2) learned models (planning.models.bufferMin)
 *       3) featureFlag defaults & caps
 *   - automation/feasibility/options engines use the resolved buffers when
 *     constructing schedules. When an override is added/removed, we emit events
 *     and (optionally) mirror the policy change to the Hub.
 *
 * Events (payload: { type, ts, source, data }):
 *   - scheduling.buffer.resolved          (read-only resolution)
 *   - scheduling.buffer.policy.updated    (persisted override added/changed)
 *   - scheduling.buffer.policy.removed    (persisted override deleted)
 *   - scheduling.buffer.policy.error      (operation failed)
 *
 * Forward-thinking:
 *   - Hierarchical keys: (domain, taskType, equipmentSig) with wildcard support
 *   - Runtime overrides (ephemeral) layer for experiments or A/B
 *   - Caps/guards from featureFlags + per-domain caps
 *   - Storage adapter via dataGateway (Dexie/SQLite/etc.)
 */

let eventBus = {
  emit: (...a) => console.debug("[policies:buffers:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {
  /* noop */
}

let featureFlags = {
  familyFundMode: false,
  bufferPolicy: {
    defaultMin: 5, // base fallback minutes
    capMin: 60, // absolute cap
    perDomainCaps: {
      // optional domain caps
      preservation: 90,
    },
    // Optional hard minimums by domain/task
    floors: {
      preservation: 10,
    },
  },
};
try {
  const ff = require("@/config/featureFlags");
  featureFlags = ff?.default || ff || featureFlags;
} catch {
  /* noop */
}

let dataGateway;
try {
  dataGateway = require("@/services/dataGateway");
} catch {}

let HubPacketFormatter, FamilyFundConnector;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch {
  /* optional */
}

/* ------------------------------ Public API --------------------------------- */
module.exports = {
  /**
   * Resolve a recommended buffer (minutes) for a planning key.
   * @param {Object} key
   * @param {("cooking"|"cleaning"|"garden"|"animal"|"preservation"|"storehouse")} key.domain
   * @param {string} [key.taskType]        // e.g., "bake", "stovetop", "harvest"
   * @param {string} [key.equipmentSig]    // e.g., "oven|range.top" or "none"
   * @param {Object} [opts]
   * @param {boolean} [opts.emitEvent=true]    // emit scheduling.buffer.resolved
   * @returns {Promise<{ minutes:number, source:string, explanation?:string }>}
   */
  async resolveBuffer(key, opts = {}) {
    const ts = new Date().toISOString();
    const source = "engines.scheduling.policies.buffers";
    try {
      const res = await _resolveBufferInternal(key);
      if (opts.emitEvent !== false) {
        eventBus.emit({
          type: "scheduling.buffer.resolved",
          ts,
          source,
          data: { key: normKey(key), ...res },
        });
      }
      return res;
    } catch (err) {
      eventBus.emit({
        type: "scheduling.buffer.policy.error",
        ts,
        source,
        data: { op: "resolve", reason: err?.message || "unknown" },
      });
      return {
        minutes: clamp(featureFlags?.bufferPolicy?.defaultMin ?? 5, 0, 1440),
        source: "error:fallback",
      };
    }
  },

  /**
   * Apply a buffer to an estimate (object with minute parts).
   * @param {{ prepMinutes?:number, setupMinutes?:number, taskMinutes:number, cleanupMinutes?:number, bufferMinutes?:number }} estimate
   * @param {Object} key same shape as resolveBuffer
   * @returns {Promise<{ totalMinutes:number, parts:{prep:number,setup:number,task:number,cleanup:number,buffer:number}, bufferSource:string }>}
   */
  async applyBufferToEstimate(estimate, key) {
    const safe = sanitizeEstimate(estimate);
    const { minutes, source } = await this.resolveBuffer(key, {
      emitEvent: false,
    });
    const buffer = minutes;
    const total = safe.prep + safe.setup + safe.task + safe.cleanup + buffer;
    return {
      totalMinutes: total,
      parts: {
        prep: safe.prep,
        setup: safe.setup,
        task: safe.task,
        cleanup: safe.cleanup,
        buffer,
      },
      bufferSource: source,
    };
  },

  /**
   * Create or update a persistent buffer override.
   * @param {{ id?:string, domain?:string, taskType?:string, equipmentSig?:string, minutes:number, reason?:string, enabled?:boolean }} override
   *   - Any of domain/taskType/equipmentSig may be "*" for wildcard.
   * @returns {Promise<{ id:string, minutes:number, scope:{domain:string,taskType:string,equipmentSig:string} }>}
   */
  async setBufferOverride(override) {
    const ts = new Date().toISOString();
    const source = "engines.scheduling.policies.buffers";
    try {
      guardDataGateway();

      const row = normalizeOverride(override);
      const id = row.id || makeId(row);
      const toSave = { ...row, id, updatedAt: ts };

      await upsertMany("policies.buffers", [toSave], ["id"]);

      eventBus.emit({
        type: "scheduling.buffer.policy.updated",
        ts,
        source,
        data: {
          id,
          minutes: toSave.minutes,
          scope: pick(toSave, ["domain", "taskType", "equipmentSig"]),
          reason: toSave.reason || null,
        },
      });

      await exportToHubIfEnabled({
        type: "policy.buffer.updated",
        ts,
        source,
        data: {
          id,
          minutes: toSave.minutes,
          scope: pick(toSave, ["domain", "taskType", "equipmentSig"]),
          enabled: toSave.enabled !== false,
        },
      });

      return {
        id,
        minutes: toSave.minutes,
        scope: pick(toSave, ["domain", "taskType", "equipmentSig"]),
      };
    } catch (err) {
      eventBus.emit({
        type: "scheduling.buffer.policy.error",
        ts: new Date().toISOString(),
        source,
        data: { op: "set", reason: err?.message || "unknown" },
      });
      throw err;
    }
  },

  /**
   * Remove a persistent buffer override by id.
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async removeBufferOverride(id) {
    const ts = new Date().toISOString();
    const source = "engines.scheduling.policies.buffers";
    try {
      guardDataGateway();
      const ok = await delById("policies.buffers", id);
      if (ok) {
        eventBus.emit({
          type: "scheduling.buffer.policy.removed",
          ts,
          source,
          data: { id },
        });
        await exportToHubIfEnabled({
          type: "policy.buffer.removed",
          ts,
          source,
          data: { id },
        });
      }
      return !!ok;
    } catch (err) {
      eventBus.emit({
        type: "scheduling.buffer.policy.error",
        ts,
        source,
        data: { op: "remove", reason: err?.message || "unknown" },
      });
      return false;
    }
  },

  /**
   * List all persistent overrides (enabled first).
   * @returns {Promise<Array<object>>}
   */
  async listBufferOverrides() {
    guardDataGateway();
    const rows = await readAll("policies.buffers");
    return (rows || []).sort(
      (a, b) => Number(b.enabled !== false) - Number(a.enabled !== false)
    );
  },

  /**
   * Register or clear an ephemeral runtime override.
   * @param {{ domain?:string, taskType?:string, equipmentSig?:string }} scope
   * @param {number|null} minutes    // null removes the runtime override
   */
  setRuntimeOverride(scope, minutes) {
    const key = keyToString(normalizeScope(scope));
    if (minutes == null) {
      runtimeOverrides.delete(key);
    } else {
      runtimeOverrides.set(key, clamp(toPosInt(minutes), 0, 24 * 60));
    }
  },
};

/* ------------------------------- Internals --------------------------------- */

const runtimeOverrides = new Map(); // key => minutes (non-persistent)

/**
 * Resolution precedence (first match wins):
 *   1. runtime override (exact → wildcard)
 *   2. persistent override (exact → wildcard)
 *   3. learned model planning.models.bufferMin (exact → wildcard)
 *   4. featureFlags floors/caps + defaultMin
 */
async function _resolveBufferInternal(key) {
  const k = normKey(key);

  // 1) runtime overrides
  const rt = matchFromRuntime(k);
  if (rt != null) return finalize(rt, "runtime.override", k);

  // 2) persistent overrides
  const persisted = await matchFromPersistent(k);
  if (persisted != null) return finalize(persisted, "policy.override", k);

  // 3) learned models
  const modelBuf = await matchFromModels(k);
  if (modelBuf != null) return finalize(modelBuf, "model.buffer", k);

  // 4) flags default
  const flagDefault = featureFlags?.bufferPolicy?.defaultMin ?? 5;
  return finalize(flagDefault, "flag.default", k);
}

function finalize(rawMinutes, source, key) {
  const caps = featureFlags?.bufferPolicy?.perDomainCaps || {};
  const floors = featureFlags?.bufferPolicy?.floors || {};
  const cap = toPosInt(
    caps[key.domain] ?? featureFlags?.bufferPolicy?.capMin ?? 60
  );
  const floor = toPosInt(floors[key.domain] ?? 0);

  const bounded = clamp(toPosInt(rawMinutes), floor, cap);
  const explanation = `bounded(${rawMinutes}) with floor=${floor}, cap=${cap}`;
  return { minutes: bounded, source, explanation };
}

/* --------------------------- Matchers (layers) ----------------------------- */

function matchFromRuntime(key) {
  // exact → domain+task+equipment
  const exact = runtimeOverrides.get(keyToString(key));
  if (isPosInt(exact)) return exact;

  // fallbacks with wildcards
  const candidates = [
    { domain: key.domain, taskType: key.taskType, equipmentSig: "*" },
    { domain: key.domain, taskType: "*", equipmentSig: key.equipmentSig },
    { domain: key.domain, taskType: "*", equipmentSig: "*" },
    { domain: "*", taskType: "*", equipmentSig: "*" },
  ];
  for (const c of candidates) {
    const v = runtimeOverrides.get(keyToString(c));
    if (isPosInt(v)) return v;
  }
  return null;
}

async function matchFromPersistent(key) {
  if (!dataGateway) return null;
  // attempt to fetch once and index
  const rows = await readAll("policies.buffers");
  const list = (rows || []).filter((r) => r && r.enabled !== false);

  const tryMatch = (scope) => {
    return list.find((r) =>
      isScopeMatch(scope, {
        domain: r.domain,
        taskType: r.taskType,
        equipmentSig: r.equipmentSig,
      })
    );
  };

  // exact first
  const exact = tryMatch(key);
  if (exact) return toPosInt(exact.minutes);

  // wildcard precedence
  const candidates = [
    { domain: key.domain, taskType: key.taskType, equipmentSig: "*" },
    { domain: key.domain, taskType: "*", equipmentSig: key.equipmentSig },
    { domain: key.domain, taskType: "*", equipmentSig: "*" },
    { domain: "*", taskType: "*", equipmentSig: "*" },
  ];
  for (const c of candidates) {
    const hit = tryMatch(c);
    if (hit) return toPosInt(hit.minutes);
  }
  return null;
}

async function matchFromModels(key) {
  if (!dataGateway) return null;
  const read = async (scope) => {
    const row =
      (typeof dataGateway.getOne === "function" &&
        (await dataGateway.getOne("planning.models", scope))) ||
      (typeof dataGateway.findOne === "function" &&
        (await dataGateway.findOne("planning.models", scope))) ||
      null;
    return row?.bufferMin != null ? toPosInt(row.bufferMin) : null;
  };

  // exact
  const exact = await read(key);
  if (isPosInt(exact)) return exact;

  // wildcard patterns
  const patterns = [
    { domain: key.domain, taskType: key.taskType, equipmentSig: "none" },
    { domain: key.domain, taskType: key.taskType, equipmentSig: "*" }, // if your adapter supports *
    { domain: key.domain, taskType: "general", equipmentSig: key.equipmentSig },
    { domain: key.domain, taskType: "general", equipmentSig: "none" },
    { domain: key.domain, taskType: "general", equipmentSig: "*" },
  ];

  for (const p of patterns) {
    const v = await read(p);
    if (isPosInt(v)) return v;
  }

  // domain-only fallback
  const v2 = await read({
    domain: key.domain,
    taskType: "general",
    equipmentSig: "none",
  });
  return isPosInt(v2) ? v2 : null;
}

/* ------------------------------- Persistence ------------------------------- */

function guardDataGateway() {
  if (!dataGateway) throw new Error("dataGateway unavailable");
}

async function upsertMany(table, rows, keyFields) {
  guardDataGateway();
  if (typeof dataGateway.upsertMany === "function") {
    return await dataGateway.upsertMany(table, rows, keyFields);
  }
  if (typeof dataGateway.writeMany === "function") {
    return await dataGateway.writeMany({
      table,
      rows,
      keyFields,
      mode: "upsert",
    });
  }
  if (typeof dataGateway.putMany === "function") {
    await dataGateway.putMany(table, rows);
    return rows.length;
  }
  if (typeof dataGateway.put === "function") {
    for (const r of rows) await dataGateway.put(table, r);
    return rows.length;
  }
  throw new Error("No upsert-capable method on dataGateway");
}

async function delById(table, id) {
  if (typeof dataGateway.delete === "function")
    return await dataGateway.delete(table, id);
  if (typeof dataGateway.remove === "function")
    return await dataGateway.remove(table, { id });
  if (typeof dataGateway.writeMany === "function") {
    await dataGateway.writeMany({ table, rows: [{ id }], mode: "delete" });
    return true;
  }
  return false;
}

async function readAll(table) {
  if (typeof dataGateway.all === "function")
    return await dataGateway.all(table);
  if (typeof dataGateway.scan === "function")
    return await dataGateway.scan(table, {});
  return [];
}

/* --------------------------------- Helpers --------------------------------- */

function normKey(key) {
  const domain = String(key?.domain || "").trim() || "*";
  const taskType = String(key?.taskType || "").trim() || "general";
  const equipmentSig = String(key?.equipmentSig || "").trim() || "none";
  return { domain, taskType, equipmentSig };
}
function normalizeScope(scope) {
  return {
    domain: (scope?.domain ?? "*") || "*",
    taskType: (scope?.taskType ?? "*") || "*",
    equipmentSig: (scope?.equipmentSig ?? "*") || "*",
  };
}
function keyToString({ domain, taskType, equipmentSig }) {
  return `${domain}::${taskType}::${equipmentSig}`;
}
function isScopeMatch(scope, row) {
  const domOk = row.domain === "*" || row.domain === scope.domain;
  const taskOk = row.taskType === "*" || row.taskType === scope.taskType;
  const eqOk =
    row.equipmentSig === "*" || row.equipmentSig === scope.equipmentSig;
  return domOk && taskOk && eqOk;
}

function sanitizeEstimate(e) {
  return {
    prep: toNonNegInt(e?.prepMinutes ?? 0),
    setup: toNonNegInt(e?.setupMinutes ?? 0),
    task: toNonNegInt(e?.taskMinutes ?? 0),
    cleanup: toNonNegInt(e?.cleanupMinutes ?? 0),
  };
}

function normalizeOverride(ovr) {
  if (!ovr || typeof ovr !== "object") throw new Error("invalid-override");
  const scope = normalizeScope(ovr);
  const minutes = toPosInt(ovr.minutes);
  if (!minutes && minutes !== 0) throw new Error("override-minutes-required");
  return {
    id: String(ovr.id || "").trim(),
    domain: scope.domain,
    taskType: scope.taskType,
    equipmentSig: scope.equipmentSig,
    minutes,
    reason: typeof ovr.reason === "string" ? ovr.reason.slice(0, 240) : null,
    enabled: ovr.enabled !== false,
  };
}

function makeId(row) {
  // Stable ID per scope when not provided
  return `buf::${row.domain}::${row.taskType}::${row.equipmentSig}`;
}
function isPosInt(n) {
  return Number.isInteger(n) && n > 0;
}
function toPosInt(n) {
  const v = Math.floor(Number(n) || 0);
  return v > 0 ? v : 0;
}
function toNonNegInt(n) {
  const v = Math.floor(Number(n) || 0);
  return v < 0 ? 0 : v;
}
function clamp(n, lo, hi) {
  const x = Number(n);
  return Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
}
function pick(obj, keys) {
  const o = {};
  for (const k of keys) if (k in obj) o[k] = obj[k];
  return o;
}

/* --------------------------- Optional Hub Export --------------------------- */
/**
 * This module *may* change policy state (when set/remove override). That is not
 * inventory/storehouse “household data,” but we still mirror to Hub when enabled,
 * per the SSA contract. Fail silently if Hub is unavailable.
 */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch {
    /* silent */
  }
}
