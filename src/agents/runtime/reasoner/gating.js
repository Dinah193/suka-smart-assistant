// File: src/agents/runtime/reasoner/gating.js
// SSA — Reasoner Gating (production-ready)
//
// Purpose
// - Provide deterministic “should we run the reasoner?” gating logic.
// - Protect SSA from:
//   - quiet hours / sabbath rules (if provided by callers)
//   - excessive compute / spammy re-runs
//   - low-signal requests
//   - missing prerequisites (no evidence, no task, etc.)
// - Works in browser + Vite build (no Node APIs).
//
// Design
// - Pure-ish functions, no side effects.
// - Accepts an optional memo/cache adapter (see cache/memo.js if you add it later).
// - Returns a structured decision with reasons and recommended next action.
//
// Typical usage (from a shim/runtime):
//   import { gateReasonerRun } from "@/agents/runtime/reasoner/gating";
//   const decision = gateReasonerRun({ modeId, domain, kind, task, evidence, meta, policyOverrides, memo });
//   if (!decision.allow) { ...fallback... }
//   else { ...runReasoner... }

import { clamp } from "@/engines/scheduling/scheduleHelpers";
import { resolvePolicy } from "./modes/map";
import { makeKey } from "./cache/keys";

/* ------------------------------ utils ------------------------------ */

function asArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}
function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function safeStr(v, fallback = "") {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  return s.trim() || fallback;
}
function normalizeToken(s, fallback = "") {
  return safeStr(s, fallback).toLowerCase().replace(/\s+/g, "-");
}
function nowMs() {
  return Date.now();
}
function toIso(ts) {
  try {
    return new Date(ts || Date.now()).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function addReason(arr, code, message, detail) {
  arr.push({
    code: safeStr(code, "reason"),
    message: safeStr(message, ""),
    ...(detail !== undefined ? { detail } : {}),
  });
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

/**
 * Normalize evidence into:
 *   [{ text, source, meta? }]
 *
 * Accepts:
 *  - string
 *  - array of strings
 *  - array of objects (tries common fields: text/content/message/summary)
 *  - single object
 */
function normalizeEvidence(input) {
  const out = [];

  const pushOne = (item) => {
    if (item == null) return;

    // string
    if (typeof item === "string") {
      const t = item.trim();
      if (t) out.push({ text: t, source: "manual" });
      return;
    }

    // object-ish
    if (typeof item === "object") {
      const text =
        safeStr(item.text, "") ||
        safeStr(item.content, "") ||
        safeStr(item.message, "") ||
        safeStr(item.summary, "") ||
        safeStr(item.note, "") ||
        "";

      const source =
        safeStr(item.source, "") ||
        safeStr(item.kind, "") ||
        safeStr(item.type, "") ||
        "local";

      if (text) out.push({ text, source, meta: item.meta || item });
      return;
    }

    // fallback
    const t = safeStr(item, "");
    if (t) out.push({ text: t, source: "manual" });
  };

  if (Array.isArray(input)) {
    for (const item of input) pushOne(item);
    return out;
  }

  pushOne(input);
  return out;
}

/**
 * Build a deterministic cache key for gating/reasoner calls using cache/keys.js
 * (browser-safe).
 */
function buildReasonerCacheKey({
  modeId,
  domain,
  kind,
  policy,
  task,
  evidence,
  variables,
  context,
} = {}) {
  const ctx = {
    domain,
    kind,
    mode: modeId || policy?.mode || "default",
    householdId:
      context?.householdId || context?.household_id || context?.household || "",
    userId: context?.userId || context?.user_id || context?.user || "",
  };

  const payload = {
    policy,
    task,
    evidence,
    variables: variables || null,
    // context can be huge; keep only lightweight identity-ish hints
    contextHint: context
      ? pick(context, [
          "householdId",
          "household_id",
          "userId",
          "user_id",
          "tier",
          "area",
          "domain",
        ])
      : null,
  };

  return makeKey("reasoner.gating", ctx, payload, {
    prefix: "reasoner",
    maxDepth: 10,
  });
}

/* ------------------------------ defaults ------------------------------ */

const DEFAULTS = {
  // Minimum evidence lines recommended for "reasoner" use; can be lowered per mode/policy.
  minEvidence: 1,

  // If "task" is empty, we block by default (unless allowEmptyTask is true)
  allowEmptyTask: false,

  // Throttle: do not allow re-run more frequently than this (ms), unless forced
  minRerunIntervalMs: 8_000,

  // Require a meaningful delta to rerun: e.g. evidence changed, task changed, etc.
  // If false, interval is the only throttle.
  requireChangeForRerun: true,

  // If a previous run is cached and "fresh enough", skip (recommend reuse).
  // (This is gating only; execution layer decides.)
  reuseIfCachedMs: 60_000,

  // Quiet hours / sabbath: if caller supplies guard signals, respect them by default
  respectGuards: true,

  // If a request is explicitly marked "low stakes", allow looser gating
  lowStakesRelaxMultiplier: 0.5,

  // If caller set meta.force, ignore most blocks
  allowForceOverride: true,
};

/* ------------------------------ public API ------------------------------ */

/**
 * canCallReasoner(input) -> boolean
 * Back-compat helper expected by some shims.
 */
export function canCallReasoner(input = {}) {
  try {
    return !!gateReasonerRun(input)?.allow;
  } catch {
    return false;
  }
}

/**
 * isReasonerCallAllowed(input) -> boolean
 * Export expected by some shims (e.g., procurementShim).
 * Alias to canCallReasoner for compatibility.
 */
export function isReasonerCallAllowed(input = {}) {
  return canCallReasoner(input);
}

/**
 * gateReasonerRun(input)
 *
 * input:
 * {
 *   modeId, domain, kind,
 *   task: { title?, instruction?, question?, ... } | string,
 *   evidence: [] | string | objects,
 *   context: any,
 *   policyOverrides: object,
 *   meta: {
 *     force?: boolean,
 *     requestId?: string,
 *     // optional "guard" inputs from session quiet hours / sabbath rules:
 *     guards?: {
 *       isQuietHours?: boolean,
 *       isSabbath?: boolean,
 *       blockReason?: string,
 *       allowDuringQuietHours?: boolean,
 *       allowDuringSabbath?: boolean
 *     },
 *     // optional "budget" signals:
 *     budget?: {
 *       // indicates overall system load / budget availability
 *       ok?: boolean,
 *       remaining?: number,
 *       limit?: number,
 *       reason?: string
 *     },
 *     stakes?: "low" | "normal" | "high",
 *     // caller can pass a memo adapter or pass separately as input.memo
 *   },
 *   memo: {
 *     get(key): any | Promise<any>
 *     set(key, value, { ttlMs? }): void | Promise<void>
 *   }
 * }
 *
 * output:
 * {
 *   allow: boolean,
 *   action: "run" | "skip_reuse_cache" | "skip_throttled" | "block",
 *   cacheKey: string|null,
 *   reasons: [{code,message,detail?}],
 *   policy: object,
 *   meta: { requestId, decidedAt, decidedAtMs, nextAllowedAtMs?, ... }
 * }
 */
export function gateReasonerRun(input = {}) {
  const decidedAtMs = nowMs();
  const decidedAt = toIso(decidedAtMs);

  const modeId = normalizeToken(input.modeId || input.mode, "default");
  const domain = normalizeToken(input.domain, "generic");
  const kind = normalizeToken(input.kind, "generic");

  // Task normalization
  const taskIn = input.task;
  const task =
    typeof taskIn === "string"
      ? { title: "Reasoner Task", instruction: taskIn }
      : isObj(taskIn)
      ? taskIn
      : {};

  const instruction = safeStr(
    task.instruction || task.question || task.prompt || "",
    ""
  );
  const title = safeStr(task.title || task.name || "", "");

  const evidence = normalizeEvidence(input.evidence);
  const evidenceCount = evidence.length;

  // Resolve policy via modes map (browser-safe)
  const policy = resolvePolicy({
    mode: modeId,
    domain,
    kind,
    overrides: input.policyOverrides || input.overrides,
  });

  const meta = isObj(input.meta) ? input.meta : {};
  const force = !!meta.force;

  const stakes = safeStr(meta.stakes, "normal").toLowerCase();
  const lowStakes = stakes === "low";

  const memo = input.memo || meta.memo || null;

  const reasons = [];

  // Compute cacheKey early (for memo/throttle)
  const cacheKey =
    buildReasonerCacheKey({
      modeId: policy.mode || modeId,
      domain,
      kind,
      policy,
      task: {
        title: title || "Reasoner Task",
        instruction: instruction || "",
      },
      evidence,
      variables: input.variables || null,
      context: input.context || null,
    }) || null;

  // Force override
  const allowForce =
    DEFAULTS.allowForceOverride && force === true ? true : false;

  // 1) Guards: quiet hours / sabbath
  if (DEFAULTS.respectGuards && meta.guards && DEFAULTS.respectGuards) {
    const g = meta.guards || {};
    const isQuiet = !!g.isQuietHours;
    const isSabbath = !!g.isSabbath;

    const allowQuiet = g.allowDuringQuietHours === true;
    const allowSabbath = g.allowDuringSabbath === true;

    if (isQuiet && !allowQuiet) {
      addReason(
        reasons,
        "blocked.quiet_hours",
        "Reasoner gated due to quiet hours.",
        pick(g, ["isQuietHours", "blockReason"])
      );
    }

    if (isSabbath && !allowSabbath) {
      addReason(
        reasons,
        "blocked.sabbath",
        "Reasoner gated due to sabbath rules.",
        pick(g, ["isSabbath", "blockReason"])
      );
    }
  }

  // 2) Budget signals (if provided)
  if (meta.budget && isObj(meta.budget)) {
    const b = meta.budget;
    const ok = b.ok !== false; // default ok
    if (!ok) {
      addReason(
        reasons,
        "blocked.budget",
        "Reasoner gated due to budget constraints.",
        pick(b, ["remaining", "limit", "reason"])
      );
    }
  }

  // 3) Task presence
  const allowEmptyTask =
    policy?.selection?.allowEmptyTask ??
    policy?.meta?.allowEmptyTask ??
    DEFAULTS.allowEmptyTask;

  if (!allowEmptyTask) {
    if (!instruction) {
      addReason(
        reasons,
        "blocked.no_task",
        "Missing task instruction/question; refusing to run reasoner."
      );
    }
  }

  // 4) Evidence requirements
  const policyMinEvidenceRaw =
    policy?.selection?.minEvidence ??
    policy?.meta?.minEvidence ??
    DEFAULTS.minEvidence;

  const relax = lowStakes ? DEFAULTS.lowStakesRelaxMultiplier : 1;
  const minEvidence = Math.max(
    0,
    Math.floor(
      (typeof policyMinEvidenceRaw === "number"
        ? policyMinEvidenceRaw
        : DEFAULTS.minEvidence) * relax
    )
  );

  if (evidenceCount < minEvidence) {
    addReason(
      reasons,
      "blocked.insufficient_evidence",
      `Insufficient evidence to run reasoner (have ${evidenceCount}, need ${minEvidence}).`,
      { evidenceCount, minEvidence }
    );
  }

  // 5) Validation errors from policy (if any caller adds them later)
  const policyErrors = asArray(policy?.__validation?.errors);
  if (policyErrors.length) {
    addReason(
      reasons,
      "blocked.policy_invalid",
      "Policy validation failed; refusing to run reasoner.",
      { errors: policyErrors }
    );
  }

  // If anything blocked and not forced -> block
  const hardBlocks = reasons.filter((r) =>
    String(r.code || "").startsWith("blocked.")
  );
  if (hardBlocks.length && !allowForce) {
    return {
      allow: false,
      action: "block",
      cacheKey,
      reasons,
      policy,
      meta: {
        requestId: safeStr(meta.requestId, "") || null,
        decidedAt,
        decidedAtMs,
        forced: false,
      },
    };
  }

  // 6) Throttle / reuse logic (memo-based, optional)
  // If no memo adapter, default to allow.
  const minIntervalRaw =
    policy?.cache?.minRerunIntervalMs ??
    policy?.meta?.minRerunIntervalMs ??
    DEFAULTS.minRerunIntervalMs;

  const minIntervalMs = Math.max(
    0,
    Math.floor(
      (typeof minIntervalRaw === "number"
        ? minIntervalRaw
        : DEFAULTS.minRerunIntervalMs) *
        (lowStakes ? DEFAULTS.lowStakesRelaxMultiplier : 1)
    )
  );

  const reuseWindowRaw =
    policy?.cache?.reuseIfCachedMs ??
    policy?.meta?.reuseIfCachedMs ??
    DEFAULTS.reuseIfCachedMs;

  const reuseIfCachedMs = Math.max(
    0,
    Math.floor(
      (typeof reuseWindowRaw === "number"
        ? reuseWindowRaw
        : DEFAULTS.reuseIfCachedMs) * (lowStakes ? 1.25 : 1)
    )
  );

  const requireChange =
    policy?.cache?.requireChangeForRerun ??
    policy?.meta?.requireChangeForRerun ??
    DEFAULTS.requireChangeForRerun;

  // If forced, skip throttles entirely and run.
  if (allowForce) {
    addReason(
      reasons,
      "allow.force",
      "Force override enabled; bypassing throttle/cache gating."
    );
    return {
      allow: true,
      action: "run",
      cacheKey,
      reasons,
      policy,
      meta: {
        requestId: safeStr(meta.requestId, "") || null,
        decidedAt,
        decidedAtMs,
        forced: true,
      },
    };
  }

  // Memo keys (use cacheKey as namespace)
  const lastRunKey = cacheKey ? `${cacheKey}:lastRun` : null;
  const lastPayloadKey = cacheKey ? `${cacheKey}:lastPayloadSig` : null;
  const cachedResultKey = cacheKey ? `${cacheKey}:lastResult` : null;

  // If memo exists, check last run / last result for reuse
  if (memo && typeof memo.get === "function" && cacheKey) {
    // We keep synchronous gating: if memo.get returns a promise, we won't await here.
    // This stays compatible with callers that use sync memo (localStorage map, etc.).
    // If you need async memo, use gateReasonerRunAsync below.
    const lastRun = memo.get(lastRunKey);
    const cached = memo.get(cachedResultKey);
    const payloadSig = buildPayloadSignature({
      modeId,
      domain,
      kind,
      task,
      evidence,
      policy,
    });

    const lastSig = memo.get(lastPayloadKey);

    // If cached result exists and is within reuse window, recommend reuse
    if (cached && isObj(cached) && cached.tsMs != null) {
      const age = decidedAtMs - Number(cached.tsMs || 0);
      if (age >= 0 && age <= reuseIfCachedMs) {
        addReason(
          reasons,
          "skip.reuse_cache",
          `Cached reasoner result is fresh (age ${Math.round(
            age
          )}ms <= ${reuseIfCachedMs}ms).`,
          { ageMs: age, reuseIfCachedMs }
        );
        return {
          allow: false,
          action: "skip_reuse_cache",
          cacheKey,
          reasons,
          policy,
          meta: {
            requestId: safeStr(meta.requestId, "") || null,
            decidedAt,
            decidedAtMs,
            forced: false,
            cachedAgeMs: age,
          },
        };
      }
    }

    // Throttle by interval
    if (typeof lastRun === "number" || typeof lastRun === "string") {
      const last = Number(lastRun);
      if (Number.isFinite(last)) {
        const dt = decidedAtMs - last;
        if (dt >= 0 && dt < minIntervalMs) {
          addReason(
            reasons,
            "skip.throttled",
            `Throttled: last run ${Math.round(
              dt
            )}ms ago (min ${minIntervalMs}ms).`,
            { sinceLastMs: dt, minRerunIntervalMs: minIntervalMs }
          );
          return {
            allow: false,
            action: "skip_throttled",
            cacheKey,
            reasons,
            policy,
            meta: {
              requestId: safeStr(meta.requestId, "") || null,
              decidedAt,
              decidedAtMs,
              forced: false,
              nextAllowedAtMs: last + minIntervalMs,
            },
          };
        }
      }
    }

    // Require change for rerun (optional)
    if (requireChange) {
      if (lastSig && typeof lastSig === "string" && lastSig === payloadSig) {
        addReason(
          reasons,
          "skip.no_change",
          "No meaningful change detected since last run; skipping to reduce churn.",
          { requireChangeForRerun: true }
        );
        return {
          allow: false,
          action: "skip_throttled",
          cacheKey,
          reasons,
          policy,
          meta: {
            requestId: safeStr(meta.requestId, "") || null,
            decidedAt,
            decidedAtMs,
            forced: false,
            nextAllowedAtMs: decidedAtMs + minIntervalMs,
          },
        };
      }
    }

    // If we got here, allow run. (Caller should write memo after running.)
    addReason(reasons, "allow.ok", "Gating passed; allow reasoner run.", {
      evidenceCount,
      minEvidence,
      minRerunIntervalMs: minIntervalMs,
      reuseIfCachedMs,
      requireChangeForRerun: !!requireChange,
    });

    return {
      allow: true,
      action: "run",
      cacheKey,
      reasons,
      policy,
      meta: {
        requestId: safeStr(meta.requestId, "") || null,
        decidedAt,
        decidedAtMs,
        forced: false,
        memoKeys: { lastRunKey, lastPayloadKey, cachedResultKey },
      },
    };
  }

  // No memo: allow, but explain throttle not enforced
  addReason(
    reasons,
    "allow.ok_no_memo",
    "Gating passed; no memo adapter provided so throttles/reuse checks were not applied.",
    { evidenceCount, minEvidence }
  );

  return {
    allow: true,
    action: "run",
    cacheKey,
    reasons,
    policy,
    meta: {
      requestId: safeStr(meta.requestId, "") || null,
      decidedAt,
      decidedAtMs,
      forced: false,
    },
  };
}

/**
 * Async version that can await async memo adapters.
 */
export async function gateReasonerRunAsync(input = {}) {
  const decidedAtMs = nowMs();
  const decidedAt = toIso(decidedAtMs);

  const modeId = normalizeToken(input.modeId || input.mode, "default");
  const domain = normalizeToken(input.domain, "generic");
  const kind = normalizeToken(input.kind, "generic");

  const taskIn = input.task;
  const task =
    typeof taskIn === "string"
      ? { title: "Reasoner Task", instruction: taskIn }
      : isObj(taskIn)
      ? taskIn
      : {};

  const instruction = safeStr(
    task.instruction || task.question || task.prompt || "",
    ""
  );
  const title = safeStr(task.title || task.name || "", "");

  const evidence = normalizeEvidence(input.evidence);
  const evidenceCount = evidence.length;

  const policy = resolvePolicy({
    mode: modeId,
    domain,
    kind,
    overrides: input.policyOverrides || input.overrides,
  });

  const meta = isObj(input.meta) ? input.meta : {};
  const force = !!meta.force;
  const stakes = safeStr(meta.stakes, "normal").toLowerCase();
  const lowStakes = stakes === "low";

  const memo = input.memo || meta.memo || null;

  const reasons = [];

  const cacheKey =
    buildReasonerCacheKey({
      modeId: policy.mode || modeId,
      domain,
      kind,
      policy,
      task: {
        title: title || "Reasoner Task",
        instruction: instruction || "",
      },
      evidence,
      variables: input.variables || null,
      context: input.context || null,
    }) || null;

  const allowForce =
    DEFAULTS.allowForceOverride && force === true ? true : false;

  // Guards
  if (DEFAULTS.respectGuards && meta.guards) {
    const g = meta.guards || {};
    const isQuiet = !!g.isQuietHours;
    const isSabbath = !!g.isSabbath;
    const allowQuiet = g.allowDuringQuietHours === true;
    const allowSabbath = g.allowDuringSabbath === true;

    if (isQuiet && !allowQuiet) {
      addReason(
        reasons,
        "blocked.quiet_hours",
        "Reasoner gated due to quiet hours.",
        pick(g, ["isQuietHours", "blockReason"])
      );
    }
    if (isSabbath && !allowSabbath) {
      addReason(
        reasons,
        "blocked.sabbath",
        "Reasoner gated due to sabbath rules.",
        pick(g, ["isSabbath", "blockReason"])
      );
    }
  }

  // Budget
  if (meta.budget && isObj(meta.budget)) {
    const b = meta.budget;
    const ok = b.ok !== false;
    if (!ok) {
      addReason(
        reasons,
        "blocked.budget",
        "Reasoner gated due to budget constraints.",
        pick(b, ["remaining", "limit", "reason"])
      );
    }
  }

  // Task
  const allowEmptyTask =
    policy?.selection?.allowEmptyTask ??
    policy?.meta?.allowEmptyTask ??
    DEFAULTS.allowEmptyTask;

  if (!allowEmptyTask && !instruction) {
    addReason(
      reasons,
      "blocked.no_task",
      "Missing task instruction/question; refusing to run reasoner."
    );
  }

  // Evidence
  const policyMinEvidenceRaw =
    policy?.selection?.minEvidence ??
    policy?.meta?.minEvidence ??
    DEFAULTS.minEvidence;
  const relax = lowStakes ? DEFAULTS.lowStakesRelaxMultiplier : 1;
  const minEvidence = Math.max(
    0,
    Math.floor(
      (typeof policyMinEvidenceRaw === "number"
        ? policyMinEvidenceRaw
        : DEFAULTS.minEvidence) * relax
    )
  );

  if (evidenceCount < minEvidence) {
    addReason(
      reasons,
      "blocked.insufficient_evidence",
      `Insufficient evidence to run reasoner (have ${evidenceCount}, need ${minEvidence}).`,
      { evidenceCount, minEvidence }
    );
  }

  // Policy errors
  const policyErrors = asArray(policy?.__validation?.errors);
  if (policyErrors.length) {
    addReason(
      reasons,
      "blocked.policy_invalid",
      "Policy validation failed; refusing to run reasoner.",
      { errors: policyErrors }
    );
  }

  const hardBlocks = reasons.filter((r) =>
    String(r.code || "").startsWith("blocked.")
  );
  if (hardBlocks.length && !allowForce) {
    return {
      allow: false,
      action: "block",
      cacheKey,
      reasons,
      policy,
      meta: {
        requestId: safeStr(meta.requestId, "") || null,
        decidedAt,
        decidedAtMs,
        forced: false,
      },
    };
  }

  if (allowForce) {
    addReason(
      reasons,
      "allow.force",
      "Force override enabled; bypassing throttle/cache gating."
    );
    return {
      allow: true,
      action: "run",
      cacheKey,
      reasons,
      policy,
      meta: {
        requestId: safeStr(meta.requestId, "") || null,
        decidedAt,
        decidedAtMs,
        forced: true,
      },
    };
  }

  // Throttle/reuse (async memo)
  const minIntervalRaw =
    policy?.cache?.minRerunIntervalMs ??
    policy?.meta?.minRerunIntervalMs ??
    DEFAULTS.minRerunIntervalMs;
  const minIntervalMs = Math.max(
    0,
    Math.floor(
      (typeof minIntervalRaw === "number"
        ? minIntervalRaw
        : DEFAULTS.minRerunIntervalMs) *
        (lowStakes ? DEFAULTS.lowStakesRelaxMultiplier : 1)
    )
  );

  const reuseWindowRaw =
    policy?.cache?.reuseIfCachedMs ??
    policy?.meta?.reuseIfCachedMs ??
    DEFAULTS.reuseIfCachedMs;
  const reuseIfCachedMs = Math.max(
    0,
    Math.floor(
      (typeof reuseWindowRaw === "number"
        ? reuseWindowRaw
        : DEFAULTS.reuseIfCachedMs) * (lowStakes ? 1.25 : 1)
    )
  );

  const requireChange =
    policy?.cache?.requireChangeForRerun ??
    policy?.meta?.requireChangeForRerun ??
    DEFAULTS.requireChangeForRerun;

  const lastRunKey = cacheKey ? `${cacheKey}:lastRun` : null;
  const lastPayloadKey = cacheKey ? `${cacheKey}:lastPayloadSig` : null;
  const cachedResultKey = cacheKey ? `${cacheKey}:lastResult` : null;

  if (memo && typeof memo.get === "function" && cacheKey) {
    const [lastRun, cached, lastSig] = await Promise.all([
      memo.get(lastRunKey),
      memo.get(cachedResultKey),
      memo.get(lastPayloadKey),
    ]);

    const payloadSig = buildPayloadSignature({
      modeId,
      domain,
      kind,
      task,
      evidence,
      policy,
    });

    if (cached && isObj(cached) && cached.tsMs != null) {
      const age = decidedAtMs - Number(cached.tsMs || 0);
      if (age >= 0 && age <= reuseIfCachedMs) {
        addReason(
          reasons,
          "skip.reuse_cache",
          `Cached reasoner result is fresh (age ${Math.round(
            age
          )}ms <= ${reuseIfCachedMs}ms).`,
          { ageMs: age, reuseIfCachedMs }
        );
        return {
          allow: false,
          action: "skip_reuse_cache",
          cacheKey,
          reasons,
          policy,
          meta: {
            requestId: safeStr(meta.requestId, "") || null,
            decidedAt,
            decidedAtMs,
            forced: false,
            cachedAgeMs: age,
          },
        };
      }
    }

    if (typeof lastRun === "number" || typeof lastRun === "string") {
      const last = Number(lastRun);
      if (Number.isFinite(last)) {
        const dt = decidedAtMs - last;
        if (dt >= 0 && dt < minIntervalMs) {
          addReason(
            reasons,
            "skip.throttled",
            `Throttled: last run ${Math.round(
              dt
            )}ms ago (min ${minIntervalMs}ms).`,
            { sinceLastMs: dt, minRerunIntervalMs: minIntervalMs }
          );
          return {
            allow: false,
            action: "skip_throttled",
            cacheKey,
            reasons,
            policy,
            meta: {
              requestId: safeStr(meta.requestId, "") || null,
              decidedAt,
              decidedAtMs,
              forced: false,
              nextAllowedAtMs: last + minIntervalMs,
            },
          };
        }
      }
    }

    if (requireChange) {
      if (lastSig && typeof lastSig === "string" && lastSig === payloadSig) {
        addReason(
          reasons,
          "skip.no_change",
          "No meaningful change detected since last run; skipping to reduce churn.",
          { requireChangeForRerun: true }
        );
        return {
          allow: false,
          action: "skip_throttled",
          cacheKey,
          reasons,
          policy,
          meta: {
            requestId: safeStr(meta.requestId, "") || null,
            decidedAt,
            decidedAtMs,
            forced: false,
            nextAllowedAtMs: decidedAtMs + minIntervalMs,
          },
        };
      }
    }

    addReason(reasons, "allow.ok", "Gating passed; allow reasoner run.", {
      evidenceCount,
      minEvidence,
      minRerunIntervalMs: minIntervalMs,
      reuseIfCachedMs,
      requireChangeForRerun: !!requireChange,
    });

    return {
      allow: true,
      action: "run",
      cacheKey,
      reasons,
      policy,
      meta: {
        requestId: safeStr(meta.requestId, "") || null,
        decidedAt,
        decidedAtMs,
        forced: false,
        memoKeys: { lastRunKey, lastPayloadKey, cachedResultKey },
      },
    };
  }

  addReason(
    reasons,
    "allow.ok_no_memo",
    "Gating passed; no memo adapter provided so throttles/reuse checks were not applied.",
    { evidenceCount, minEvidence }
  );

  return {
    allow: true,
    action: "run",
    cacheKey,
    reasons,
    policy,
    meta: {
      requestId: safeStr(meta.requestId, "") || null,
      decidedAt,
      decidedAtMs,
      forced: false,
    },
  };
}

/* ------------------------------ memo helpers ------------------------------ */

/**
 * Call this AFTER a reasoner run to update throttle/cached-result bookkeeping.
 * Safe to call even if memo is missing.
 */
export async function recordReasonerRun({
  memo,
  cacheKey,
  policy,
  task,
  evidence,
  result,
  tsMs,
} = {}) {
  if (!memo || typeof memo.set !== "function" || !cacheKey) return;

  const now = Number.isFinite(tsMs) ? tsMs : nowMs();
  const payloadSig = buildPayloadSignature({
    modeId: policy?.mode || "default",
    domain: policy?.domain || "generic",
    kind: policy?.kind || "generic",
    task: task || {},
    evidence: normalizeEvidence(evidence),
    policy: policy || {},
  });

  const lastRunKey = `${cacheKey}:lastRun`;
  const lastPayloadKey = `${cacheKey}:lastPayloadSig`;
  const cachedResultKey = `${cacheKey}:lastResult`;

  const ttlMs =
    policy?.cache?.resultTtlMs ?? policy?.meta?.resultTtlMs ?? 5 * 60_000; // 5 min default

  await memo.set(lastRunKey, now);
  await memo.set(lastPayloadKey, payloadSig);
  if (result != null) {
    await memo.set(
      cachedResultKey,
      {
        tsMs: now,
        result,
      },
      { ttlMs }
    );
  }
}

/* ------------------------------ signatures ------------------------------ */

function buildPayloadSignature({
  modeId,
  domain,
  kind,
  task,
  evidence,
  policy,
}) {
  const t = isObj(task) ? task : {};
  const e = normalizeEvidence(evidence);

  // Keep deterministic but light:
  // - task instruction + title
  // - evidence text (first N chars) + sources
  // - core policy knobs that affect outcomes
  const instruction = safeStr(
    t.instruction || t.question || t.prompt || "",
    ""
  );
  const title = safeStr(t.title || t.name || "", "");
  const evSig = e
    .slice(0, 25)
    .map(
      (x) =>
        `${normalizeToken(x.source, "local")}:${safeStr(x.text, "").slice(
          0,
          120
        )}`
    )
    .join("|");

  const knobs = {
    modeId: normalizeToken(modeId, "default"),
    domain: normalizeToken(domain, "generic"),
    kind: normalizeToken(kind, "generic"),
    // only include policy knobs likely to change selection/outcome
    freshness: pick(policy?.freshness || {}, [
      "maxAgeDays",
      "preferRecentDays",
      "downrankStale",
    ]),
    selection: pick(policy?.selection || {}, ["maxCandidates", "prefer"]),
    confidence: pick(policy?.confidence || {}, [
      "minAccept",
      "minWarn",
      "minBlock",
      "weights",
    ]),
    cache: pick(policy?.cache || {}, ["ttlMs", "strategy"]),
  };

  const raw = `${title}::${instruction}::${evSig}::${JSON.stringify(knobs)}`;
  return simpleHash(raw);
}

function simpleHash(str) {
  // Non-crypto lightweight hash (browser-safe)
  const s = String(str || "");
  let h1 = 0x811c9dc5; // FNV-ish
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = (h1 * 0x01000193) >>> 0;
  }
  return `sig_${h1.toString(16)}`;
}

export default {
  canCallReasoner,
  isReasonerCallAllowed,
  gateReasonerRun,
  gateReasonerRunAsync,
  recordReasonerRun,
};
