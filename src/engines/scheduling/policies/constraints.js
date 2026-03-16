// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\policies\constraints.js
/**
 * SSA Scheduling Policies — Constraints (quiet hours, Sabbath/holy days, safety, preferences)
 * ------------------------------------------------------------------------------------------
 * Purpose:
 *   Centralize *blocking* and *preference* rules that limit when sessions may run.
 *   Produces time blocks (do-not-schedule windows) and evaluates a candidate session/window.
 *
 * How it fits the SSA pipeline:
 *   imports → intelligence → automation → (optional) hub export
 *   - imports + intelligence produce normalized sessions (with durations, resources).
 *   - THIS MODULE resolves policy-based constraints into time blocks:
 *       • Quiet hours            (household)
 *       • Sabbath / holy days    (faith/observances)
 *       • Safety rules           (domain-aware e.g., no deep-fry after 9pm)
 *       • Household preferences  (nap, study, screen-free blocks)
 *   - Schedulers (feasibility/options/priorities) consume these blocks before committing plans.
 *   - Policy updates (overrides) emit events and may mirror to Hub when familyFundMode is on.
 *
 * Event payload shape: { type, ts, source, data } with ISO timestamps
 *   - scheduling.constraints.blocks.generated
 *   - scheduling.constraints.evaluated
 *   - scheduling.constraints.policy.updated / .removed / .error
 */

let eventBus = {
  emit: (...a) => console.debug("[policies:constraints:eventBus.emit]", ...a),
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
  constraints: {
    quietHours: { enabled: false, start: 22, end: 6 }, // local hours, overnight supported
    sabbathGuard: { enabled: false, dayStart: 18, dayEnd: 18 }, // Fri sunset → Sat sunset approximated
    holyDays: { enabled: false, datesISO: [] }, // hard blackout dates [ "2025-12-25", ... ]
    safety: {
      // Example defaults; domains can extend with strategy registry
      cooking: {
        noHighHeatAfterHour: 21, // 9pm
      },
      garden: { daylightPreferred: true }, // not a hard block; yields recommendation
    },
    preferences: {
      blocks: [
        // example: { label:"kids nap", startHour:13, endHour:15, daysOfWeek:[0..6], hard:true }
      ],
    },
    // maximum horizon for block generation (days)
    maxBlockHorizonDays: 60,
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
   * Build constraint blocks for a time range.
   * @param {{ rangeStartISO:string, rangeEndISO:string, fetchAstronomy?:(d:Date)=>Promise<{sunsetISO?:string,sundownISO?:string,sunriseISO?:string}> }} opts
   * @returns {Promise<{ blocks:Array<Block>, meta:{range:{startISO:string,endISO:string}} }>}
   */
  async getBlocks(opts = {}) {
    const ts = new Date().toISOString();
    const source = "engines.scheduling.policies.constraints";

    const start = parseISO(opts.rangeStartISO);
    const end = parseISO(opts.rangeEndISO);
    guardRange(start, end);

    const policies = await resolvePolicies();
    const blocks = await buildAllBlocks(
      start,
      end,
      policies,
      opts.fetchAstronomy
    );

    eventBus.emit({
      type: "scheduling.constraints.blocks.generated",
      ts,
      source,
      data: {
        count: blocks.length,
        range: { startISO: start.toISOString(), endISO: end.toISOString() },
        sample: blocks.slice(0, 3),
      },
    });

    return {
      blocks,
      meta: {
        range: { startISO: start.toISOString(), endISO: end.toISOString() },
      },
    };
  },

  /**
   * Evaluate if a session window is allowed under constraints.
   * @param {Session} session
   * @param {{ startISO:string, endISO:string, fetchAstronomy?:(d:Date)=>Promise<any> }} window
   * @returns {Promise<{ allowed:boolean, violations:Array<{policy:string,reason:string}>, blockingWindows:Array<Block>, recommendations:string[] }>}
   */
  async evaluate(session, window) {
    const ts = new Date().toISOString();
    const source = "engines.scheduling.policies.constraints";

    // Defensive inputs
    const s = sanitizeSession(session);
    const start = parseISO(window?.startISO);
    const end = parseISO(window?.endISO);
    guardRange(start, end);

    const policies = await resolvePolicies();
    const blocks = await buildAllBlocks(
      start,
      end,
      policies,
      window.fetchAstronomy
    );

    const intersects = blocks.filter((b) =>
      intersectsWindow({ start, end }, b)
    );
    const hardViolations = intersects.filter((b) => b.level === "hard");

    // Domain safety strategies (may add hard/soft flags dynamically)
    const { violations, recommendations } = await runDomainSafety(s, {
      window: { start, end },
      policies,
    });

    const allowed =
      hardViolations.length === 0 &&
      !violations.some((v) => v.level === "hard");

    const data = {
      allowed,
      violations: [
        ...hardViolations.map((b) => ({
          policy: b.policy,
          reason: b.reason || b.label || "blocked",
        })),
        ...violations.map((v) => ({ policy: v.policy, reason: v.reason })),
      ],
      blockingWindows: intersects,
      recommendations,
    };

    eventBus.emit({
      type: "scheduling.constraints.evaluated",
      ts,
      source,
      data: {
        sessionId: s.id || null,
        domain: s.domain || null,
        allowed,
        reasons: data.violations.slice(0, 6),
      },
    });

    return data;
  },

  /**
   * Create/update a persistent constraint override.
   * Allows editing quiet hours, holy day dates, sabbath switch, preference blocks, or domain safety knobs.
   * @param {{ id?:string, kind:"quietHours"|"sabbathGuard"|"holyDays"|"preferences"|"safety"|"customBlock", payload:Object, enabled?:boolean, scope?:("global"|"domain"), domain?:string, reason?:string }} override
   * @returns {Promise<{ id:string }>}
   */
  async setConstraintOverride(override) {
    const ts = new Date().toISOString();
    const source = "engines.scheduling.policies.constraints";
    try {
      guardDataGateway();
      const row = normalizeOverride(override);
      const id = row.id || makeId(row);
      const toSave = { ...row, id, updatedAt: ts };

      await upsertMany("policies.constraints", [toSave], ["id"]);

      eventBus.emit({
        type: "scheduling.constraints.policy.updated",
        ts,
        source,
        data: {
          id,
          kind: toSave.kind,
          scope: toSave.scope,
          domain: toSave.domain || null,
        },
      });

      await exportToHubIfEnabled({
        type: "policy.constraints.updated",
        ts,
        source,
        data: {
          id,
          kind: toSave.kind,
          scope: toSave.scope,
          domain: toSave.domain || null,
        },
      });

      return { id };
    } catch (err) {
      eventBus.emit({
        type: "scheduling.constraints.policy.error",
        ts,
        source,
        data: { op: "set", reason: err?.message || "unknown" },
      });
      throw err;
    }
  },

  /**
   * Remove a persistent constraint override.
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async removeConstraintOverride(id) {
    const ts = new Date().toISOString();
    const source = "engines.scheduling.policies.constraints";
    try {
      guardDataGateway();
      const ok = await delById("policies.constraints", id);
      if (ok) {
        eventBus.emit({
          type: "scheduling.constraints.policy.removed",
          ts,
          source,
          data: { id },
        });
        await exportToHubIfEnabled({
          type: "policy.constraints.removed",
          ts,
          source,
          data: { id },
        });
      }
      return !!ok;
    } catch (err) {
      eventBus.emit({
        type: "scheduling.constraints.policy.error",
        ts,
        source,
        data: { op: "remove", reason: err?.message || "unknown" },
      });
      return false;
    }
  },

  /**
   * Read all overrides (enabled first).
   */
  async listConstraintOverrides() {
    guardDataGateway();
    const rows = await readAll("policies.constraints");
    return (rows || []).sort(
      (a, b) => Number(b.enabled !== false) - Number(a.enabled !== false)
    );
  },

  /**
   * Ephemeral runtime suppression of a policy until a timestamp.
   * @param {string} policyKey e.g., "quietHours"|"sabbathGuard"|"holyDays"|"preferences:<label>"
   * @param {string|null} untilISO if null, clears suppression
   */
  setRuntimeSuppression(policyKey, untilISO) {
    const k = String(policyKey || "").trim();
    if (!k) return;
    if (!untilISO) {
      runtimeSuppressions.delete(k);
    } else {
      const t = Date.parse(untilISO);
      if (!Number.isNaN(t)) runtimeSuppressions.set(k, new Date(t));
    }
  },
};

/* --------------------------------- Types ---------------------------------- */
/**
 * @typedef {Object} Block
 * @property {"hard"|"soft"} level
 * @property {string} policy          // "quietHours"|"sabbath"|"holyDay"|"preference"|"safety"
 * @property {string} label
 * @property {string} [reason]
 * @property {string} startISO
 * @property {string} endISO
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {("cooking"|"cleaning"|"garden"|"animal"|"preservation"|"storehouse")} domain
 * @property {string} [title]
 * @property {number} taskMinutes
 * @property {number} [prepMinutes]
 * @property {number} [setupMinutes]
 * @property {number} [cleanupMinutes]
 * @property {number} [bufferMinutes]
 * @property {Array<string>} [requiredResources]
 * @property {Object} [preferences]
 */

/* ------------------------------- Internals --------------------------------- */

const runtimeSuppressions = new Map(); // policyKey -> Date(until)

/**
 * Resolve policies from featureFlags + persistent overrides (+ runtime suppressions)
 */
async function resolvePolicies() {
  const base = deepClone(featureFlags?.constraints || {});
  const overrides = await readAllSafe("policies.constraints");

  // Apply enabled overrides (global first, then domain-specific left as payload data for strategies)
  for (const row of overrides) {
    if (row?.enabled === false) continue;
    if (!row?.payload || !row?.kind) continue;

    if (row.scope === "global" || !row.scope) {
      base[row.kind] = mergePolicy(base[row.kind], row.payload);
    } else if (row.scope === "domain" && row.domain) {
      // store domain-scoped payloads under base.safety/preferences with domain key
      if (row.kind === "safety") {
        base.safety = base.safety || {};
        base.safety[row.domain] = mergePolicy(
          base.safety[row.domain],
          row.payload
        );
      } else if (row.kind === "preferences") {
        base.preferences = base.preferences || {};
        // merge blocks with stability
        const blk = Array.isArray(row.payload?.blocks)
          ? row.payload.blocks
          : [];
        base.preferences.blocks = [
          ...(base.preferences.blocks || []),
          ...blk.map(tagBlock(row.domain)),
        ];
      } else {
        base[row.kind] = mergePolicy(base[row.kind], row.payload);
      }
    }
  }

  // Drop suppressed policies
  for (const [key, until] of runtimeSuppressions.entries()) {
    if (until && until > new Date()) {
      const k = key.replace(":.*$", "");
      if (key === "quietHours") base.quietHours = { enabled: false };
      if (key === "sabbathGuard") base.sabbathGuard = { enabled: false };
      if (key.startsWith("preferences")) {
        base.preferences = base.preferences || {};
        base.preferences.blocks = (base.preferences.blocks || []).filter(
          (b) => `preferences:${b.label}` !== key
        );
      }
      if (key === "holyDays") base.holyDays = { enabled: false, datesISO: [] };
    } else {
      runtimeSuppressions.delete(key);
    }
  }

  return base;
}

function tagBlock(domain) {
  return (b) => ({
    ...b,
    label: domain ? `[${domain}] ${b.label || "preference"}` : b.label,
  });
}

/* ----------------------------- Block Builders ------------------------------ */

async function buildAllBlocks(rangeStart, rangeEnd, policies, fetchAstronomy) {
  guardHorizon(
    rangeStart,
    rangeEnd,
    featureFlags?.constraints?.maxBlockHorizonDays ?? 60
  );

  const blocks = [];

  // Quiet hours (hard)
  if (policies.quietHours?.enabled) {
    blocks.push(
      ...buildQuietHourBlocks(
        rangeStart,
        rangeEnd,
        policies.quietHours.start,
        policies.quietHours.end
      ).map((iv) => toBlock("hard", "quietHours", "quiet hours", iv))
    );
  }

  // Sabbath (hard)
  if (policies.sabbathGuard?.enabled) {
    const sab = await buildSabbathBlocks(
      rangeStart,
      rangeEnd,
      fetchAstronomy,
      policies.sabbathGuard
    );
    blocks.push(
      ...sab.map((iv) => toBlock("hard", "sabbath", "Sabbath guard", iv))
    );
  }

  // Holy days (hard)
  if (policies.holyDays?.enabled && Array.isArray(policies.holyDays.datesISO)) {
    blocks.push(
      ...buildHolyDayBlocks(
        rangeStart,
        rangeEnd,
        policies.holyDays.datesISO
      ).map((iv) => toBlock("hard", "holyDay", "holy day", iv))
    );
  }

  // Preferences (may be hard or soft)
  if (policies.preferences?.blocks?.length) {
    blocks.push(
      ...buildPreferenceBlocks(
        rangeStart,
        rangeEnd,
        policies.preferences.blocks
      )
    );
  }

  // Safety windows (domain-agnostic global hard blocks if any)
  // Most safety is domain-specific and checked in runDomainSafety
  // Example global: "no power-tools after 22:00"
  if (policies.safety?.global?.noPowerToolsAfterHour != null) {
    blocks.push(
      ...buildDailyHourBlocks(
        rangeStart,
        rangeEnd,
        policies.safety.global.noPowerToolsAfterHour,
        policies.safety.global.untilHour ?? 6
      ).map((iv) => toBlock("hard", "safety", "no power-tools", iv))
    );
  }

  // Normalize & merge overlaps
  return mergeBlocks(blocks);
}

/* --------------------------- Domain Safety Rules --------------------------- */

async function runDomainSafety(session, { window, policies }) {
  const violations = [];
  const recommendations = [];

  const reg = getDomainSafetyRegistry();

  const fns = reg[session.domain] || [];
  for (const fn of fns) {
    try {
      const res = await Promise.resolve(fn(session, { window, policies }));
      if (!res) continue;
      if (Array.isArray(res.violations)) violations.push(...res.violations);
      if (Array.isArray(res.recommendations))
        recommendations.push(...res.recommendations);
    } catch {
      /* ignore */
    }
  }

  return { violations, recommendations };
}

/**
 * Registry: add new domain safety evaluators here.
 * Each returns { violations:[{level:"hard"|"soft", policy, reason}], recommendations:[string] }
 */
function getDomainSafetyRegistry() {
  return {
    cooking: [
      (s, { window, policies }) => {
        const cfg = policies?.safety?.cooking || {};
        if (Number.isFinite(cfg.noHighHeatAfterHour) && usesHighHeat(s)) {
          const winHours = [window.start.getHours(), window.end.getHours()];
          if (winHours.some((h) => isAfterHour(h, cfg.noHighHeatAfterHour))) {
            return {
              violations: [
                {
                  level: "hard",
                  policy: "safety",
                  reason: "no-high-heat-after-hour",
                },
              ],
              recommendations: ["schedule high-heat earlier"],
            };
          }
        }
        return null;
      },
    ],
    preservation: [
      // Example: discourage canning overnight
      (s, { window }) => {
        if (window.start.getHours() >= 22 || window.end.getHours() <= 6) {
          return {
            violations: [
              {
                level: "soft",
                policy: "safety",
                reason: "avoid-canning-overnight",
              },
            ],
            recommendations: ["prefer daylight for canning"],
          };
        }
        return null;
      },
    ],
    garden: [
      (s, { policies }) => {
        if (policies?.safety?.garden?.daylightPreferred) {
          return {
            violations: [
              {
                level: "soft",
                policy: "preference",
                reason: "daylight-preferred",
              },
            ],
            recommendations: ["schedule during daylight"],
          };
        }
        return null;
      },
    ],
    cleaning: [],
    animal: [],
    storehouse: [],
  };
}

function usesHighHeat(session) {
  const req = Array.isArray(session?.requiredResources)
    ? session.requiredResources
    : [];
  const prefs = session?.preferences || {};
  const declared = !!prefs?.cooking?.requiresHighHeat;
  return (
    declared || req.includes("range.top") || req.includes("outdoor.burner")
  );
}

function isAfterHour(h, limit) {
  // supports integer hour-based guard (local hour 0..23)
  return Number(h) >= Number(limit);
}

/* ------------------------------- Builders ---------------------------------- */

function buildQuietHourBlocks(start, end, startHr, endHr) {
  const blocks = [];
  let day = startOfDay(start);
  const lastDay = startOfDay(end);
  while (day <= lastDay) {
    if (startHr < endHr) {
      blocks.push({ start: setHour(day, startHr), end: setHour(day, endHr) });
    } else {
      blocks.push({
        start: setHour(day, startHr),
        end: setHour(addDays(day, 1), endHr),
      });
    }
    day = addDays(day, 1);
  }
  return trimBlocksToRange(blocks, start, end);
}

async function buildSabbathBlocks(start, end, fetchAstronomy, sabbathCfg) {
  const out = [];
  let day = startOfDay(start);
  const last = startOfDay(end);
  while (day <= last) {
    if (day.getDay() === 5) {
      // Friday
      const fri = new Date(day);
      const sat = addDays(fri, 1);
      let sISO, eISO;
      if (typeof fetchAstronomy === "function") {
        const aFri = await safeCall(() => fetchAstronomy(fri), {});
        const aSat = await safeCall(() => fetchAstronomy(sat), {});
        sISO =
          aFri?.sunsetISO ||
          aFri?.sundownISO ||
          setHour(fri, sabbathCfg.dayStart ?? 18).toISOString();
        eISO =
          aSat?.sundownISO ||
          aSat?.sunsetISO ||
          setHour(sat, sabbathCfg.dayEnd ?? 18).toISOString();
      } else {
        sISO = setHour(fri, sabbathCfg.dayStart ?? 18).toISOString();
        eISO = setHour(sat, sabbathCfg.dayEnd ?? 18).toISOString();
      }
      out.push({ start: new Date(sISO), end: new Date(eISO) });
    }
    day = addDays(day, 1);
  }
  return trimBlocksToRange(out, start, end);
}

function buildHolyDayBlocks(start, end, dateStrs) {
  const out = [];
  for (const d of dateStrs || []) {
    const day = parseISO(`${d}T00:00:00Z`, true); // tolerate date-only
    if (!day) continue;
    const next = addDays(day, 1);
    out.push({ start: day, end: next });
  }
  return trimBlocksToRange(out, start, end);
}

function buildPreferenceBlocks(rangeStart, rangeEnd, blocks) {
  const out = [];
  let day = startOfDay(rangeStart);
  const last = startOfDay(rangeEnd);
  while (day <= last) {
    const dow = day.getDay();
    for (const b of blocks) {
      const applies =
        !Array.isArray(b.daysOfWeek) || b.daysOfWeek.includes(dow);
      if (!applies) continue;
      const s = setHour(day, toHour(b.startHour, 0));
      const e = setHour(day, toHour(b.endHour, 0));
      const level = b.hard ? "hard" : "soft";
      const label = b.label || "preference";
      out.push(toBlock(level, "preference", label, { start: s, end: e }));
    }
    day = addDays(day, 1);
  }
  return mergeBlocks(
    trimBlocksToRange(
      out.map((b) => ({
        start: new Date(b.startISO),
        end: new Date(b.endISO),
        _b: b,
      })),
      rangeStart,
      rangeEnd
    ).map((x) => x._b)
  );
}

function buildDailyHourBlocks(start, end, fromHr, toHr) {
  // builds [fromHr → toHr(next day if wrap)]
  return buildQuietHourBlocks(start, end, fromHr, toHr);
}

/* ------------------------------ Block Utils -------------------------------- */

function toBlock(level, policy, label, iv, reason) {
  return {
    level,
    policy,
    label,
    reason,
    startISO: iv.start.toISOString(),
    endISO: iv.end.toISOString(),
  };
}

function intersectsWindow(win, block) {
  const bs = Date.parse(block.startISO);
  const be = Date.parse(block.endISO);
  return be > +win.start && bs < +win.end;
}

function mergeBlocks(blocks) {
  // Merge per (level, policy) to keep semantics
  const grouped = new Map();
  for (const b of blocks) {
    const k = `${b.level}::${b.policy}`;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped
      .get(k)
      .push({
        start: new Date(b.startISO),
        end: new Date(b.endISO),
        label: b.label,
        reason: b.reason,
      });
  }

  const out = [];
  for (const [k, arr] of grouped.entries()) {
    const [level, policy] = k.split("::");
    const merged = mergeIntervals(arr);
    for (const m of merged) {
      out.push(toBlock(level, policy, policy, m));
    }
  }
  // sort by start
  return out.sort((a, b) => Date.parse(a.startISO) - Date.parse(b.startISO));
}

/* -------------------------------- Persistence ------------------------------- */

function guardDataGateway() {
  if (!dataGateway) throw new Error("dataGateway unavailable");
}
async function readAllSafe(table) {
  if (!dataGateway) return [];
  if (typeof dataGateway.all === "function")
    return await dataGateway.all(table);
  if (typeof dataGateway.scan === "function")
    return await dataGateway.scan(table, {});
  return [];
}
async function upsertMany(table, rows, keyFields) {
  guardDataGateway();
  if (typeof dataGateway.upsertMany === "function")
    return dataGateway.upsertMany(table, rows, keyFields);
  if (typeof dataGateway.writeMany === "function")
    return dataGateway.writeMany({ table, rows, keyFields, mode: "upsert" });
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

/* ---------------------------------- Helpers -------------------------------- */

function sanitizeSession(s) {
  if (!s || typeof s !== "object") return {};
  return {
    ...s,
    taskMinutes: toNonNegInt(s.taskMinutes ?? 0),
    prepMinutes: toNonNegInt(s.prepMinutes ?? 0),
    setupMinutes: toNonNegInt(s.setupMinutes ?? 0),
    cleanupMinutes: toNonNegInt(s.cleanupMinutes ?? 0),
    bufferMinutes: toNonNegInt(s.bufferMinutes ?? 0),
  };
}

function normalizeOverride(ovr) {
  if (!ovr || typeof ovr !== "object") throw new Error("invalid-override");
  const kind = String(ovr.kind || "").trim();
  if (
    ![
      "quietHours",
      "sabbathGuard",
      "holyDays",
      "preferences",
      "safety",
      "customBlock",
    ].includes(kind)
  ) {
    throw new Error("invalid-kind");
  }
  const scope = (ovr.scope || "global").toLowerCase();
  if (!["global", "domain"].includes(scope)) throw new Error("invalid-scope");
  return {
    id: String(ovr.id || "").trim(),
    kind,
    payload: ovr.payload || {},
    enabled: ovr.enabled !== false,
    scope,
    domain: scope === "domain" ? String(ovr.domain || "").trim() : null,
    reason: typeof ovr.reason === "string" ? ovr.reason.slice(0, 240) : null,
  };
}

function makeId(row) {
  if (row.kind === "customBlock") {
    // Ensure unique
    return `constraints::custom::${Date.now()}`;
  }
  return row.scope === "domain"
    ? `constraints::${row.kind}::${row.domain}`
    : `constraints::${row.kind}`;
}

function mergePolicy(base, payload) {
  const a = base && typeof base === "object" ? base : {};
  const b = payload && typeof payload === "object" ? payload : {};
  return deepMerge(a, b);
}

function guardRange(start, end) {
  if (!(start instanceof Date) || !(end instanceof Date) || end <= start) {
    throw new Error("invalid-range");
  }
}
function guardHorizon(start, end, maxDays) {
  const ms = end - start;
  const maxMs = (maxDays || 60) * 24 * 60 * 60 * 1000;
  if (ms > maxMs) throw new Error("range-too-large");
}

function parseISO(s, allowDateOnly = false) {
  if (!s) return null;
  if (allowDateOnly && /^\d{4}-\d{2}-\d{2}$/.test(s))
    return new Date(`${s}T00:00:00Z`);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function setHour(d, hour) {
  const x = new Date(d);
  x.setHours(hour, 0, 0, 0);
  return x;
}
function addDays(d, n) {
  return new Date(d.getTime() + n * 864e5);
}
function toHour(val, def) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 && n < 24 ? Math.floor(n) : def;
}

function mergeIntervals(intervals) {
  const arr = intervals
    .filter(
      (iv) =>
        iv?.start instanceof Date &&
        iv?.end instanceof Date &&
        iv.end > iv.start
    )
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const iv of arr) {
    if (!merged.length || iv.start > merged[merged.length - 1].end) {
      merged.push({ start: new Date(iv.start), end: new Date(iv.end) });
    } else {
      if (iv.end > merged[merged.length - 1].end)
        merged[merged.length - 1].end = new Date(iv.end);
    }
  }
  return merged;
}

function trimBlocksToRange(blocks, start, end) {
  return blocks
    .map((b) => ({
      start: b.start < start ? new Date(start) : b.start,
      end: b.end > end ? new Date(end) : b.end,
    }))
    .filter((b) => b.end > b.start);
}

function toNonNegInt(n) {
  const v = Math.floor(Number(n) || 0);
  return v < 0 ? 0 : v;
}
function deepMerge(a, b) {
  if (!a) return b;
  if (!b) return a;
  const o = { ...a };
  for (const k of Object.keys(b))
    o[k] = isObj(a[k]) && isObj(b[k]) ? deepMerge(a[k], b[k]) : b[k];
  return o;
}
function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}
async function safeCall(fn, fb) {
  try {
    return await fn();
  } catch {
    return fb;
  }
}

/* --------------------------- Optional Hub Export --------------------------- */
/**
 * Policy changes are mirrored to the Hub when enabled (SSA still owns the data).
 * This module does not mutate inventory/storehouse; it only changes policy config.
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
