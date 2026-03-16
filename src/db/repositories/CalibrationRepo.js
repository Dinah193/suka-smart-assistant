// C:\Users\larho\suka-smart-assistant\src\db\repositories\CalibrationRepo.js
/* eslint-disable no-console */

/**
 * CalibrationRepo
 * -----------------------------------------------------------------------------
 * Role in pipeline:
 * - Imports → Intelligence → Automation → (optional) Hub export
 * - Stores and evolves "learning loop" correction factors that adapt SSA’s
 *   planning & execution to your household: e.g., device temperature offsets,
 *   cook-time scale factors, equipment efficiency, preferred doneness drifts,
 *   cleaning agent dwell-time multipliers, garden microclimate shifts, etc.
 *
 * What writes here?
 * - Engines compare planned vs actuals/telemetry and write corrections.
 * - Users can explicitly tweak factors (e.g., “my oven runs +15°F”).
 *
 * What reads here?
 * - Planners (Sessions/Steps generators) read effective factors to bias
 *   durations, temps, and thresholds before scheduling.
 *
 * Events:
 * - Every mutation emits { type, ts, source, data } on the shared eventBus.
 * - If familyFundMode is ON, we also best-effort export changes to the Hub.
 *
 * Dexie tables expected:
 *   db.calibrationFactors  : main KV with scoped factors
 *     {
 *       id, key, value, unit?, confidence, alpha, // learning params
 *       scope: {
 *         householdId?, resourceId?, deviceId?, domain?, method?, ingredient?,
 *         recipeId?, roomId?, model?
 *       },
 *       source?, notes?, createdAt, updatedAt, archivedAt?
 *     }
 *   db.calibrationHistory? : optional append-only trail of updates (if exists)
 *     { id, factorId, key, prevValue, nextValue, delta, ts, scope, note? }
 *
 * Forward-thinking:
 * - Scope precedence resolver combines most-specific → least-specific matches.
 * - EWMA updaters & decay helpers provide smooth learning.
 * - Batch APIs and JSON import/export for portability.
 */

let db = null;
try {
  const mod = require("@/db");
  db = mod?.default || mod?.db || mod;
} catch {}

let eventBus = { emit: () => {}, on: () => () => {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let featureFlags = { familyFundMode: false };
try {
  featureFlags = require("@/config/featureFlags.json");
} catch {}

let HubPacketFormatter = null;
try {
  const mod = require("@/services/hub/HubPacketFormatter");
  HubPacketFormatter = mod?.default || mod;
} catch {}

let FamilyFundConnector = null;
try {
  const mod = require("@/services/hub/FamilyFundConnector");
  FamilyFundConnector = mod?.default || mod;
} catch {}

const SOURCE = "db/CalibrationRepo";

/* ----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

function isoNow() {
  return new Date().toISOString();
}

function uuid(prefix = "calf") {
  try {
    return (
      globalThis?.crypto?.randomUUID?.() ||
      `${prefix}_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`
    );
  } catch {
    return `${prefix}_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }
}

function emit(type, data) {
  try {
    eventBus.emit({ type, ts: isoNow(), source: SOURCE, data });
  } catch (err) {
    console.warn("[CalibrationRepo] event emit failed:", err);
  }
}

async function exportToHubIfEnabled(payload) {
  if (
    !featureFlags?.familyFundMode ||
    !HubPacketFormatter ||
    !FamilyFundConnector
  )
    return;
  try {
    const packet =
      HubPacketFormatter.formatCalibrationChange?.(payload) || payload;
    await FamilyFundConnector.send?.(packet);
  } catch (err) {
    // Silent fail by design
    console.warn(
      "[CalibrationRepo] Hub export failed (silent):",
      err?.message || err
    );
  }
}

function ensureDB() {
  const ok = db && typeof db === "object" && db.calibrationFactors;
  if (!ok) {
    throw new Error(
      "Dexie table 'calibrationFactors' is required. Ensure '@/db' defines it."
    );
  }
}

/* ----------------------------------------------------------------------------
 * Normalizers
 * -------------------------------------------------------------------------- */

/**
 * normalizeScope
 *  - Only keeps known keys; trims strings; nulls for empties.
 */
function normalizeScope(scope = {}) {
  const keep = [
    "householdId",
    "resourceId",
    "deviceId",
    "roomId",
    "domain",
    "method", // e.g., "roast", "boil", "mop", "sanitize", "till"
    "ingredient", // e.g., "goat_shoulder", "glass", "tile", "soil_clay"
    "recipeId",
    "model", // e.g., appliance model, sensor model
  ];
  const out = {};
  for (const k of keep) {
    const v = scope?.[k];
    if (v === undefined || v === null) {
      out[k] = null;
      continue;
    }
    out[k] = typeof v === "string" ? v.trim() || null : v;
  }
  return out;
}

/**
 * normalizeFactor
 *  - key: dot-path like "temp.offset.F" | "time.scale" | "humidity.bias"
 *  - value: number preferred (can be boolean/string for toggles)
 *  - unit: e.g., "F","C","ratio","sec","pct"
 *  - alpha: learning rate for EWMA updates (0..1), default 0.2
 *  - confidence: heuristic 0..1 about trust in this factor
 */
function normalizeFactor(input = {}) {
  if (!input || typeof input !== "object")
    return { ok: false, error: "Invalid factor payload." };

  const now = isoNow();
  const key = String(input.key || "").trim();
  if (!key) return { ok: false, error: "Factor 'key' is required." };

  // prefer numeric values but allow others
  const val = input.value;
  const record = {
    id: input.id || uuid(),
    key,
    value: typeof val === "number" ? val : val, // keep as provided
    unit: input.unit || inferUnitFromKey(key) || null,

    alpha: clamp01(input.alpha ?? 0.2),
    confidence: clamp01(input.confidence ?? 0.5),

    scope: normalizeScope(input.scope || {}),

    source: input.source || null, // "engine", "user", "import", "probe"
    notes: input.notes || null,

    createdAt: input.createdAt || now,
    updatedAt: now,
    archivedAt: input.archivedAt || null,
  };

  return { ok: true, record };
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function inferUnitFromKey(key) {
  if (key.includes(".offset.F")) return "F";
  if (key.includes(".offset.C")) return "C";
  if (key.endsWith(".scale") || key.endsWith(".ratio")) return "ratio";
  if (key.includes(".sec")) return "sec";
  if (key.includes(".pct")) return "pct";
  return null;
}

/* ----------------------------------------------------------------------------
 * Scope precedence
 * -------------------------------------------------------------------------- */

/**
 * Precedence from most specific → general (left earlier = stronger):
 * [ deviceId, resourceId, roomId, recipeId, ingredient, method, domain, model, householdId, (global nulls) ]
 */
const PRECEDENCE = [
  "deviceId",
  "resourceId",
  "roomId",
  "recipeId",
  "ingredient",
  "method",
  "domain",
  "model",
  "householdId",
];

/**
 * scoreSpecificity(scope, target)
 *  - Counts matching non-null fields with precedence weighting.
 */
function scoreSpecificity(scope, target) {
  if (!scope || !target) return 0;
  let score = 0;
  let weight = PRECEDENCE.length;
  for (const k of PRECEDENCE) {
    if (scope?.[k] && target?.[k] && scope[k] === target[k]) {
      score += weight;
    }
    weight -= 1;
  }
  return score;
}

/* ----------------------------------------------------------------------------
 * Repository
 * -------------------------------------------------------------------------- */

const CalibrationRepo = {
  /**
   * setFactor({ key, value, unit?, scope?, alpha?, confidence?, source?, notes? })
   * - Upserts a single factor.
   */
  async setFactor(factor) {
    ensureDB();
    const res = normalizeFactor(factor);
    if (!res.ok) return { ok: false, error: res.error };
    const rec = res.record;

    // Attempt to find an existing row for same key + exact scope match
    const existing = await this._findExact(rec.key, rec.scope);
    const toSave = existing
      ? {
          ...existing,
          ...rec,
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: isoNow(),
        }
      : rec;

    try {
      await db.calibrationFactors.put(toSave);
      await this._appendHistorySafe({
        factorId: toSave.id,
        key: toSave.key,
        prevValue: existing?.value ?? null,
        nextValue: toSave.value,
        delta: diffsafe(existing?.value, toSave.value),
        scope: toSave.scope,
        note: "setFactor",
      });

      const payload = {
        action: existing ? "factor.update" : "factor.create",
        factor: toSave,
      };
      emit(
        existing ? "calibration.factor_updated" : "calibration.factor_created",
        payload
      );
      await exportToHubIfEnabled(payload);
      return { ok: true, data: toSave };
    } catch (err) {
      console.error("[CalibrationRepo.setFactor] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * setFactors(list)
   */
  async setFactors(list = []) {
    ensureDB();
    if (!Array.isArray(list) || !list.length)
      return { ok: false, error: "Nothing to set." };
    const normalized = [];
    for (const f of list) {
      const n = normalizeFactor(f);
      if (n.ok) normalized.push(n.record);
    }
    if (!normalized.length) return { ok: false, error: "No valid factors." };

    try {
      // Resolve against existing to keep ids
      const toSave = [];
      for (const rec of normalized) {
        const ex = await this._findExact(rec.key, rec.scope);
        toSave.push(
          ex
            ? {
                ...ex,
                ...rec,
                id: ex.id,
                createdAt: ex.createdAt,
                updatedAt: isoNow(),
              }
            : rec
        );
      }

      await db.calibrationFactors.bulkPut(toSave);

      for (let i = 0; i < toSave.length; i++) {
        const ex = await this._findExact(
          toSave[i].key,
          toSave[i].scope,
          toSave[i].id
        );
        await this._appendHistorySafe({
          factorId: toSave[i].id,
          key: toSave[i].key,
          prevValue: ex?.value ?? null,
          nextValue: toSave[i].value,
          delta: diffsafe(ex?.value, toSave[i].value),
          scope: toSave[i].scope,
          note: "setFactors",
        });
      }

      const payload = {
        action: "factor.bulk_upsert",
        count: toSave.length,
        keys: toSave.map((f) => f.key),
      };
      emit("calibration.factors_bulk_upserted", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: toSave.map((r) => r.id) };
    } catch (err) {
      console.error("[CalibrationRepo.setFactors] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * getFactors({ key?, scopeFilter? })
   * - Returns raw factors matching key and optional partial scope filter.
   */
  async getFactors({ key = null, scopeFilter = null } = {}) {
    ensureDB();
    try {
      let coll = db.calibrationFactors.toCollection();
      if (key) {
        const set = new Set(Array.isArray(key) ? key : [key]);
        coll = coll.and((r) => set.has(r.key));
      }
      if (scopeFilter && typeof scopeFilter === "object") {
        const filt = normalizeScope(scopeFilter);
        coll = coll.and((r) => scopeMatches(r.scope, filt));
      }
      const arr = await coll.toArray();
      return { ok: true, data: arr };
    } catch (err) {
      console.error("[CalibrationRepo.getFactors] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * getEffectiveFactor({ key, scope?, defaultValue? })
   * - Picks the highest specificity factor by precedence scoring.
   */
  async getEffectiveFactor({ key, scope = {}, defaultValue = null } = {}) {
    ensureDB();
    if (!key) return { ok: false, error: "key is required." };

    const candRes = await this.getFactors({ key });
    if (!candRes.ok) return candRes;

    const target = normalizeScope(scope);
    let best = null;
    let bestScore = -1;

    for (const row of candRes.data) {
      const s = scoreSpecificity(row.scope, target);
      if (s > bestScore) {
        bestScore = s;
        best = row;
      }
    }

    if (!best)
      return {
        ok: true,
        data: {
          key,
          value: defaultValue,
          unit: inferUnitFromKey(key) || null,
          source: "default",
        },
      };

    return {
      ok: true,
      data: {
        key: best.key,
        value: best.value,
        unit: best.unit || null,
        source: "calibration",
        factor: best,
      },
    };
  },

  /**
   * applyEffective({ items: [{ key, defaultValue? }], scope })
   * - Batch read of effective values for a set of keys.
   */
  async applyEffective({ items = [], scope = {} } = {}) {
    if (!Array.isArray(items) || !items.length) return { ok: true, data: [] };
    const out = [];
    for (const it of items) {
      const r = await this.getEffectiveFactor({
        key: it.key,
        scope,
        defaultValue: it.defaultValue ?? null,
      });
      out.push(
        r.ok
          ? r.data
          : {
              key: it.key,
              value: it.defaultValue ?? null,
              unit: null,
              source: "default",
            }
      );
    }
    return { ok: true, data: out };
  },

  /**
   * recordOutcome({ key, expected, observed, scope?, unit?, learning?:{alpha?, confidenceBoost?} })
   * - Learning loop: computes correction from expected → observed and EWMA-updates.
   *   For offsets: delta = observed - expected  (e.g., oven temp bias)
   *   For scale factors: if key ends with ".scale", delta = observed/expected
   */
  async recordOutcome({
    key,
    expected,
    observed,
    scope = {},
    unit = null,
    learning = {},
  } = {}) {
    ensureDB();
    if (expected === undefined || observed === undefined) {
      return { ok: false, error: "expected and observed are required." };
    }
    const isScale = key.endsWith(".scale") || key.endsWith(".ratio");
    const delta = isScale
      ? safeDiv(observed, expected, 1) // multiplicative
      : Number(observed) - Number(expected); // additive offset

    // Load current factor (or create)
    const current = await this._findExact(key, normalizeScope(scope));
    const alpha = clamp01(learning.alpha ?? current?.alpha ?? 0.2);
    const prev = Number(current?.value ?? (isScale ? 1 : 0));
    const next = isScale
      ? (1 - alpha) * prev + alpha * delta
      : (1 - alpha) * prev + alpha * delta;

    const confidence = clamp01(
      (current?.confidence ?? 0.5) + (learning.confidenceBoost ?? 0.02)
    );

    const payload = {
      id: current?.id,
      key,
      value: numOr(delta, next), // store the learned param (offset/scale)
      unit:
        unit ||
        current?.unit ||
        inferUnitFromKey(key) ||
        (isScale ? "ratio" : null),
      alpha,
      confidence,
      scope: normalizeScope(scope),
      source: "learning",
      notes: `recordOutcome expected=${expected} observed=${observed} delta=${delta}`,
    };

    const saveRes = await this.setFactor(payload);
    if (!saveRes.ok) return saveRes;

    const evt = {
      action: "factor.learned",
      key,
      expected,
      observed,
      delta,
      factor: saveRes.data,
    };
    emit("calibration.factor_learned", evt);
    await exportToHubIfEnabled(evt);

    return { ok: true, data: saveRes.data };
  },

  /**
   * decay({ key?, scopeFilter?, toward?, rate? })
   * - Nudges factors toward a target (e.g., regress to neutral) by rate (0..1).
   */
  async decay({
    key = null,
    scopeFilter = null,
    toward = null,
    rate = 0.05,
  } = {}) {
    ensureDB();
    const list = await this.getFactors({ key, scopeFilter });
    if (!list.ok) return list;
    if (!list.data.length) return { ok: true, data: 0 };

    let changed = 0;
    for (const f of list.data) {
      const tgt =
        toward ??
        (f.key.endsWith(".scale") || f.key.endsWith(".ratio") ? 1 : 0);
      const next = f.value + clamp01(rate) * (tgt - Number(f.value || 0));
      await db.calibrationFactors.put({
        ...f,
        value: next,
        updatedAt: isoNow(),
      });
      await this._appendHistorySafe({
        factorId: f.id,
        key: f.key,
        prevValue: f.value,
        nextValue: next,
        delta: diffsafe(f.value, next),
        scope: f.scope,
        note: "decay",
      });
      changed++;
    }

    const payload = {
      action: "factor.decay",
      count: changed,
      key,
      scopeFilter,
      toward,
      rate,
    };
    emit("calibration.factors_decayed", payload);
    await exportToHubIfEnabled(payload);
    return { ok: true, data: changed };
  },

  /**
   * removeFactor(id)
   */
  async removeFactor(id) {
    ensureDB();
    if (!id) return { ok: false, error: "Missing id." };
    try {
      const curr = await db.calibrationFactors.get(id);
      if (!curr) return { ok: false, error: "Not found." };

      await db.calibrationFactors.delete(id);
      const payload = { action: "factor.delete", id, factor: curr };
      emit("calibration.factor_deleted", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: { id } };
    } catch (err) {
      console.error("[CalibrationRepo.removeFactor] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * archiveFactor(id)
   */
  async archiveFactor(id) {
    ensureDB();
    const curr = await db.calibrationFactors.get(id);
    if (!curr) return { ok: false, error: "Not found." };
    const next = { ...curr, archivedAt: isoNow(), updatedAt: isoNow() };
    await db.calibrationFactors.put(next);
    const payload = { action: "factor.archive", id };
    emit("calibration.factor_archived", payload);
    await exportToHubIfEnabled(payload);
    return { ok: true, data: next };
  },

  /**
   * exportJSON({ key?, scopeFilter? })
   */
  async exportJSON({ key = null, scopeFilter = null } = {}) {
    const res = await this.getFactors({ key, scopeFilter });
    if (!res.ok) return res;
    return {
      ok: true,
      data: JSON.stringify({ exportedAt: isoNow(), items: res.data }, null, 2),
    };
  },

  /**
   * importJSON(json)
   */
  async importJSON(json) {
    ensureDB();
    let payload;
    try {
      payload = typeof json === "string" ? JSON.parse(json) : json;
    } catch {
      return { ok: false, error: "Invalid JSON." };
    }
    const items = Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload)
      ? payload
      : [];
    if (!items.length) return { ok: false, error: "Nothing to import." };
    return this.setFactors(items);
  },

  /* --------------------------------------------------------------------------
   * Private helpers
   * ------------------------------------------------------------------------ */

  async _findExact(key, scope, preferId = null) {
    try {
      let coll = db.calibrationFactors.where("key").equals(key);
      const list = await coll.toArray();
      // exact scope match: all scope fields equal (including nulls)
      const norm = normalizeScope(scope);
      const matches = list.filter((r) => deepScopeEqual(r.scope, norm));
      if (!matches.length) return null;
      if (preferId) {
        const found = matches.find((m) => m.id === preferId);
        if (found) return found;
      }
      // return most recent
      matches.sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt));
      return matches[0] || null;
    } catch {
      return null;
    }
  },

  async _appendHistorySafe(entry) {
    try {
      if (!db.calibrationHistory) return;
      await db.calibrationHistory.put({
        id: uuid("calh"),
        ...entry,
        ts: isoNow(),
      });
    } catch {
      // ignore if history table isn't configured
    }
  },
};

/* ----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

function diffsafe(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return null;
  return nb - na;
}

function numOr(delta, fallback) {
  const n = Number(delta);
  return Number.isFinite(n) ? n : fallback;
}

function safeDiv(a, b, fallback = 1) {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb) || nb === 0) return fallback;
  return na / nb;
}

function scopeMatches(rowScope = {}, filter = {}) {
  // every non-null filter key must match rowScope
  for (const k of Object.keys(filter)) {
    const fv = filter[k];
    if (fv === null || fv === undefined) continue;
    if (rowScope?.[k] !== fv) return false;
  }
  return true;
}

function deepScopeEqual(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const av = a[k] ?? null;
    const bv = b[k] ?? null;
    if (av !== bv) return false;
  }
  return true;
}

function toTime(iso) {
  const t = new Date(iso || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

export default CalibrationRepo;
