/**
 * @file C:\Users\larho\suka-smart-assistant\src\engines\synthesis\SynthesisDeDup.js
 *
 * SynthesisDeDup — merges/optimizes readiness steps & session suggestions by
 * detecting shared resources (e.g., oven@T, sanitizer bucket) and collapsing
 * redundant actions before scheduling.
 *
 * PIPELINE FIT
 * imports → normalize → intelligence → synthesis(SynthesisEngine)
 * → **SynthesisDeDup (this file)** → SynthesisValidator → automation/runtime
 * → (optional) hub export on commit (not in this file)
 *
 * GOALS
 * - Collapse duplicate/preparable steps that share a resource/time-window.
 * - Reduce device warm-ups (e.g., one "Preheat oven" instead of three).
 * - Share consumable setups (e.g., one sanitizer bucket for multiple rooms).
 * - Keep a clear audit trail via `automation.event` telemetry.
 *
 * EVENT ENVELOPE SHAPE (all emits):
 *   { type, ts, source, data }
 *
 * EXTENSION POINTS
 * - registerMergeStrategy({ id, applies({steps,sessions,policies}), merge({steps,sessions,policies}) })
 *   Add more domain-specific strategies (preservation/animal/storehouse).
 */

import { emit as emitEventBus } from "@/services/events/eventBus";

const SOURCE = "SynthesisDeDup";

// ───────────────────────────────────────────────────────────────────────────────
// Public API

/**
 * Detect and merge shared-resource steps/sessions.
 *
 * @param {Object} input
 * @param {Array<PrepStep>} input.readinessSteps
 * @param {Array<SessionSuggestion>} input.sessionSuggestions
 * @param {Object} [input.policies]   // knobs that affect merging
 * @returns {Promise<{
 *   ok: boolean,
 *   readinessSteps: PrepStep[],
 *   sessionSuggestions: SessionSuggestion[],
 *   merges: Array<{strategy:string,before:number,after:number,detail?:any}>,
 *   notes: string[]
 * }>}
 */
export async function dedupe({
  readinessSteps = [],
  sessionSuggestions = [],
  policies = {},
} = {}) {
  const steps = Array.isArray(readinessSteps) ? readinessSteps.slice() : [];
  const sessions = Array.isArray(sessionSuggestions)
    ? sessionSuggestions.slice()
    : [];
  const merges = [];
  const notes = [];

  emit("synthesis.dedup.started", {
    steps: steps.length,
    sessions: sessions.length,
    strategies: listStrategies(),
  });

  // Normalize titles & resource hints to improve strategy hits
  for (const s of steps) {
    s.__normTitle = normalizeTitle(s.title);
    // Encourage steps to surface resource hints
    s.__resource = s.meta?.resource || inferResourceFromTitle(s.__normTitle);
  }

  for (const strat of STRATEGIES) {
    try {
      if (!strat?.applies || !strat?.merge) continue;
      const applies = await safeCall(() =>
        strat.applies({ steps, sessions, policies })
      );
      if (!applies) continue;

      const before = steps.length;
      const {
        steps: newSteps,
        sessions: newSessions,
        detail,
        note,
      } = (await safeCall(() => strat.merge({ steps, sessions, policies }))) ||
      {};

      if (Array.isArray(newSteps)) {
        steps.splice(0, steps.length, ...newSteps);
      }
      if (Array.isArray(newSessions)) {
        sessions.splice(0, sessions.length, ...newSessions);
      }

      const after = steps.length;
      if (before !== after) {
        merges.push({ strategy: strat.id, before, after, detail });
        emit("synthesis.dedup.merged", {
          strategy: strat.id,
          delta: before - after,
          detail,
        });
      }
      if (note) notes.push(note);
    } catch (err) {
      emit("synthesis.dedup.error", {
        strategy: strat?.id || "<unknown>",
        message: err?.message || "merge error",
      });
    }
  }

  // Final lightweight general-purpose coalesce (same-title+resource within window)
  const { steps: coalesced, detail: coDetail } = coalesceSimilarSteps(
    steps,
    policies
  );
  if (coDetail?.reduced > 0) {
    merges.push({
      strategy: "general.coalesce",
      before: steps.length,
      after: coalesced.length,
      detail: coDetail,
    });
    steps.splice(0, steps.length, ...coalesced);
    emit("synthesis.dedup.merged", {
      strategy: "general.coalesce",
      delta: coDetail.reduced,
      detail: coDetail,
    });
  }

  emit("synthesis.dedup.completed", {
    steps: steps.length,
    sessions: sessions.length,
    merges: merges.length,
  });

  // Strip private normalization fields
  for (const s of steps) {
    delete s.__normTitle;
    delete s.__resource;
  }

  return {
    ok: true,
    readinessSteps: steps,
    sessionSuggestions: sessions,
    merges,
    notes,
  };
}

/**
 * Register a new merge strategy at runtime.
 * @param {MergeStrategy} strategy
 */
export function registerMergeStrategy(strategy) {
  if (!strategy || typeof strategy !== "object" || !strategy.id) return;
  STRATEGIES.push(strategy);
  emit("synthesis.dedup.strategy.registered", { id: strategy.id });
}

/** Get a list of strategy ids (for observability/UI). */
export function listStrategies() {
  return STRATEGIES.map((s) => s.id);
}

// ───────────────────────────────────────────────────────────────────────────────
// Built-in strategies

const STRATEGIES = [];

/**
 * Strategy: Oven preheat merger
 * Collapse multiple "preheat oven" steps into a single step per appliance within a time window.
 * Heuristics:
 *   - Match steps where title contains "preheat" and resource is device:oven-*
 *   - Merge when steps are within +/- mergeWindowMins around the earliest one
 *   - Keep the highest priority and earliest dueBy
 */
registerMergeStrategy({
  id: "device.oven.preheat.merge",
  applies: ({ steps }) => steps.some((s) => isPreheatOven(s)),
  merge: ({ steps, policies }) => {
    const win = toInt(policies?.ovenMergeWindowMins, 45);
    const groups = groupBy(
      steps.filter(isPreheatOven),
      (s) => s.meta?.resource || "device:oven-1"
    );

    const keep = steps.filter((s) => !isPreheatOven(s));
    const detail = { groups: [], reduced: 0 };

    for (const [resource, items] of Object.entries(groups)) {
      if (items.length <= 1) {
        keep.push(items[0]);
        continue;
      }
      items.sort(sortByDuePriority);

      const first = items[0];
      const merged = {
        ...first,
        id:
          first.id ||
          `prep:${hash(`${resource}:preheat:${first.dueBy || ""}`)}`,
        title: "Preheat oven",
        meta: {
          ...(first.meta || {}),
          mergedFrom: items.map((x) => x.id).filter(Boolean),
          resource,
        },
      };

      // Expand dueBy to cover the cluster window
      const earliest = toDate(items[0].dueBy) || null;
      const latest = findLatestWithinWindow(items, earliest, win);
      if (earliest && latest && latest > earliest) {
        merged.meta.window = {
          start: earliest.toISOString(),
          end: latest.toISOString(),
        };
      }

      detail.groups.push({ resource, before: items.length, kept: merged.id });
      detail.reduced += items.length - 1;
      keep.push(merged);
    }

    return {
      steps: keep,
      sessions: undefined,
      detail,
      note: "Merged oven preheats.",
    };
  },
});

/**
 * Strategy: Sanitizer bucket sharer
 * If multiple cleaning steps require sanitizer solution (meta.consumableGroup='sanitizer'),
 * create a single "Mix sanitizer bucket" step with a quantity sized to the batch,
 * and remove per-room duplicates that only prep the same bucket.
 */
registerMergeStrategy({
  id: "cleaning.sanitizer.bucket.share",
  applies: ({ steps }) =>
    steps.some(
      (s) =>
        s.domain === "cleaning" &&
        (s.meta?.consumableGroup === "sanitizer" ||
          /sanitizer/.test(s.__normTitle))
    ),
  merge: ({ steps, policies }) => {
    const sanitizerSteps = steps.filter(
      (s) =>
        s.domain === "cleaning" &&
        (s.meta?.consumableGroup === "sanitizer" ||
          /sanitizer/.test(s.__normTitle))
    );
    if (sanitizerSteps.length <= 1) return { steps };

    const nonSan = steps.filter((s) => !sanitizerSteps.includes(s));
    const rooms = sanitizerSteps
      .map((s) => s.meta?.room || inferRoomFromTitle(s.title))
      .filter(Boolean);
    const qtyPerRoom = toInt(policies?.sanitizer?.litersPerRoom, 3);
    const totalLiters = Math.max(
      qtyPerRoom * Math.max(1, rooms.length),
      qtyPerRoom
    );

    // Keep earliest dueBy among the group
    const earliest = sanitizerSteps
      .map((s) => toDate(s.dueBy))
      .filter(Boolean)
      .sort((a, b) => a - b)[0];

    const merged = {
      id: `prep:${hash(
        `sanitizer:${rooms.sort().join("|")}:${
          earliest ? earliest.toISOString() : ""
        }`
      )}`,
      domain: "cleaning",
      title: `Mix sanitizer bucket (${totalLiters} L)`,
      dueBy: earliest ? earliest.toISOString() : null,
      priority: Math.max(...sanitizerSteps.map((s) => s.priority ?? 0)),
      meta: {
        reason: "shared-sanitizer",
        consumableGroup: "sanitizer",
        rooms: Array.from(new Set(rooms)),
        mergedFrom: sanitizerSteps.map((s) => s.id).filter(Boolean),
      },
    };

    const detail = {
      before: sanitizerSteps.length,
      kept: merged.id,
      rooms: merged.meta.rooms,
      totalLiters,
    };
    return {
      steps: [...nonSan, merged],
      detail,
      note: "Shared sanitizer bucket across rooms.",
    };
  },
});

/**
 * Strategy: Capacity window merger for prep steps referencing the same abstract capacity
 * Example: "Bring stovetop to simmer" steps referencing capacity:stovetop should coalesce.
 */
registerMergeStrategy({
  id: "capacity.window.merge",
  applies: ({ steps }) =>
    steps.some((s) => String(s.__resource || "").startsWith("capacity:")),
  merge: ({ steps }) => {
    const capSteps = steps.filter((s) =>
      String(s.__resource || "").startsWith("capacity:")
    );
    if (capSteps.length === 0) return { steps };

    const byCap = groupBy(capSteps, (s) => s.__resource);
    const keep = steps.filter((s) => !capSteps.includes(s));
    const detail = { groups: [], reduced: 0 };

    for (const [cap, arr] of Object.entries(byCap)) {
      if (arr.length <= 1) {
        keep.push(arr[0]);
        continue;
      }
      arr.sort(sortByDuePriority);
      const first = arr[0];
      const merged = {
        ...first,
        id: first.id || `prep:${hash(`${cap}:${first.dueBy || ""}`)}`,
        meta: {
          ...(first.meta || {}),
          mergedFrom: arr.map((x) => x.id).filter(Boolean),
          resource: cap,
        },
      };
      detail.groups.push({
        capacity: cap,
        before: arr.length,
        kept: merged.id,
      });
      detail.reduced += arr.length - 1;
      keep.push(merged);
    }
    return { steps: keep, detail, note: "Merged capacity prep windows." };
  },
});

// ───────────────────────────────────────────────────────────────────────────────
// General-purpose coalescer (fallback pass)

function coalesceSimilarSteps(steps, policies = {}) {
  const maxDeltaMin = toInt(policies?.coalesceWindowMins, 20);
  const buckets = new Map(); // key -> array

  for (const s of steps) {
    const key = `${s.__resource || ""}|${s.__normTitle}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s);
  }

  const out = [];
  let reduced = 0;
  const groups = [];

  for (const [key, arr] of buckets.entries()) {
    if (arr.length === 1) {
      out.push(arr[0]);
      continue;
    }
    arr.sort(sortByDuePriority);
    const merged = [arr[0]];
    for (let i = 1; i < arr.length; i += 1) {
      const prev = merged[merged.length - 1];
      const cur = arr[i];
      if (closeInTime(prev.dueBy, cur.dueBy, maxDeltaMin)) {
        // merge cur into prev (keep earliest due, max priority, concat refs)
        prev.priority = Math.max(prev.priority ?? 0, cur.priority ?? 0);
        prev.meta = {
          ...(prev.meta || {}),
          mergedFrom: uniq(
            [...(prev.meta?.mergedFrom || []), cur.id].filter(Boolean)
          ),
        };
        reduced += 1;
      } else {
        merged.push(cur);
      }
    }
    out.push(...merged);
    if (merged.length < arr.length)
      groups.push({ key, before: arr.length, after: merged.length });
  }

  return { steps: out, detail: { reduced, groups } };
}

// ───────────────────────────────────────────────────────────────────────────────
// Utilities

function isPreheatOven(s) {
  const t = s.__normTitle || "";
  const res = String(s.__resource || "");
  return /preheat/.test(t) && (res.startsWith("device:oven") || /oven/.test(t));
}

function inferResourceFromTitle(normTitle) {
  if (!normTitle) return "";
  if (/\boven\b/.test(normTitle)) return "device:oven-1";
  if (/\bstovetop|burner|hob\b/.test(normTitle)) return "capacity:stovetop";
  if (/sanitizer|disinfect/.test(normTitle)) return "consumable:sanitizer";
  return "";
}

function inferRoomFromTitle(title = "") {
  const s = title.toLowerCase();
  if (s.includes("bathroom")) return "bathroom";
  if (s.includes("kitchen")) return "kitchen";
  if (s.includes("living")) return "living";
  if (s.includes("bedroom")) return "bedroom";
  return null;
}

function normalizeTitle(t) {
  return String(t || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sortByDuePriority(a, b) {
  const ta = toDate(a.dueBy);
  const tb = toDate(b.dueBy);
  if (ta && tb && ta.getTime() !== tb.getTime()) return ta - tb;
  // later fallback: higher priority first
  return (b.priority ?? 0) - (a.priority ?? 0);
}

function toDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toInt(n, fallback) {
  const x = Number.parseInt(n, 10);
  return Number.isFinite(x) ? x : fallback;
}

function groupBy(list, keyFn) {
  const map = {};
  for (const it of list) {
    const k = keyFn(it);
    if (!map[k]) map[k] = [];
    map[k].push(it);
  }
  return map;
}

function closeInTime(aISO, bISO, deltaMin) {
  const a = toDate(aISO);
  const b = toDate(bISO);
  if (!a || !b) return false;
  return Math.abs(b - a) <= deltaMin * 60 * 1000;
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function hash(str) {
  let h = 2166136261 >>> 0; // FNV-1a
  const s = String(str || "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16);
}

// ───────────────────────────────────────────────────────────────────────────────
// Telemetry (no hub export here; not a household mutation)

function emit(type, data) {
  try {
    eventBus.emit("automation.event", {
      type,
      ts: new Date().toISOString(),
      source: SOURCE,
      data,
    });
  } catch {
    /* never throw */
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Types (JSDoc)
/**
 * @typedef {Object} PrepStep
 * @property {string} [id]
 * @property {string} domain
 * @property {string} title
 * @property {string|null} [dueBy]
 * @property {number} [priority]
 * @property {Object} [meta] // may contain resource, consumableGroup, room, etc.
 */

/**
 * @typedef {Object} SessionSuggestion
 * @property {string} [id]
 * @property {string} domain
 * @property {string} title
 * @property {string|null} [start]
 * @property {string|null} [end]
 * @property {Object} [needs] // { devices?:string[], people?:string[], capacity?:Array<{id,units}> }
 * @property {Object} [meta]
 */

/**
 * @typedef {Object} MergeStrategy
 * @property {string} id
 * @property {(args:{steps:PrepStep[],sessions:SessionSuggestion[],policies?:Object})=>boolean|Promise<boolean>} applies
 * @property {(args:{steps:PrepStep[],sessions:SessionSuggestion[],policies?:Object})=>Promise<{steps?:PrepStep[],sessions?:SessionSuggestion[],detail?:any,note?:string}>} merge
 */

// ───────────────────────────────────────────────────────────────────────────────

export default {
  dedupe,
  registerMergeStrategy,
  listStrategies,
};
