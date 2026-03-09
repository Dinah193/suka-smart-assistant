// File: src/agents/runtime/reasoner/freshness.js
// SSA — Reasoner Freshness Utilities (production-ready)
//
// Purpose
// - Provide deterministic “freshness” scoring + staleness evaluation for SSA reasoner.
// - Convert timestamps/ages into a normalized 0..1 freshness score.
// - Provide standard policies per domain (shopping/pricing, inventory, cleaning, etc.).
// - Produce structured freshness meta for traces, caching, and UI.
//
// Notes
// - Freshness is distinct from confidence. Freshness measures time relevance.
// - This module is dependency-free and safe for offline + Vite builds.

function clamp01(n) {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function safeNum(v, fallback = 0) {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : fallback;
}

function nowMs() {
  return Date.now();
}

/** Accepts Date, ms epoch, or ISO string. Returns ms epoch or null. */
export function toMs(ts) {
  if (ts == null) return null;

  if (typeof ts === "number") {
    return Number.isFinite(ts) ? ts : null;
  }

  if (ts instanceof Date) {
    const t = ts.getTime();
    return Number.isFinite(t) ? t : null;
  }

  if (typeof ts === "string") {
    const s = ts.trim();
    if (!s) return null;

    // numeric string
    if (/^\d+$/.test(s)) {
      const t = Number(s);
      return Number.isFinite(t) ? t : null;
    }

    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }

  return null;
}

export function ageMsFrom(ts, now = nowMs()) {
  const t = toMs(ts);
  if (t == null) return null;
  const n = typeof now === "number" ? now : toMs(now);
  if (n == null) return null;
  return Math.max(0, n - t);
}

export function msToHuman(ms) {
  const x = Math.max(0, safeNum(ms, 0));
  const sec = Math.floor(x / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d`;
  const week = Math.floor(day / 7);
  if (week < 12) return `${week}w`;
  const month = Math.floor(day / 30);
  if (month < 24) return `${month}mo`;
  const year = Math.floor(day / 365);
  return `${year}y`;
}

/**
 * Freshness decay using half-life.
 * freshness = 0.5^(age/halfLife)
 *
 * @param {number} ageMs
 * @param {{ halfLifeMs?:number, floor?:number, ceiling?:number }} [opts]
 * @returns {number} 0..1
 */
export function freshnessFromAge(ageMs, opts = {}) {
  const age = Math.max(0, safeNum(ageMs, 0));
  const halfLifeMs = Math.max(
    1,
    safeNum(opts.halfLifeMs ?? 1000 * 60 * 60 * 24 * 7, 1000 * 60 * 60 * 24 * 7)
  ); // 7 days
  const floor = clamp01(opts.floor ?? 0);
  const ceiling = clamp01(opts.ceiling ?? 1);

  const raw = Math.pow(0.5, age / halfLifeMs);
  const bounded = floor + (ceiling - floor) * clamp01(raw);
  return clamp01(bounded);
}

/**
 * Determine staleness buckets from age and thresholds.
 *
 * @param {number} ageMs
 * @param {{ freshMs?:number, okMs?:number, staleMs?:number }} [thresholds]
 * @returns {"fresh"|"ok"|"stale"|"expired"}
 */
export function freshnessBucket(ageMs, thresholds = {}) {
  const age = Math.max(0, safeNum(ageMs, 0));
  const freshMs = Math.max(
    0,
    safeNum(thresholds.freshMs ?? 1000 * 60 * 60 * 6, 1000 * 60 * 60 * 6)
  ); // 6h
  const okMs = Math.max(
    freshMs,
    safeNum(thresholds.okMs ?? 1000 * 60 * 60 * 24 * 2, 1000 * 60 * 60 * 24 * 2)
  ); // 2d
  const staleMs = Math.max(
    okMs,
    safeNum(
      thresholds.staleMs ?? 1000 * 60 * 60 * 24 * 7,
      1000 * 60 * 60 * 24 * 7
    )
  ); // 7d

  if (age <= freshMs) return "fresh";
  if (age <= okMs) return "ok";
  if (age <= staleMs) return "stale";
  return "expired";
}

/**
 * Domain policy presets for how quickly information becomes stale.
 * You can add more domains over time; defaults are conservative.
 *
 * Threshold meanings:
 * - freshMs: "no warning" window
 * - okMs: still acceptable without warning
 * - staleMs: should warn / prefer refresh
 * - expiredMs: treat as invalid for decisions unless user overrides
 *
 * halfLifeMs: used for numeric freshness score decay.
 */
export const FRESHNESS_POLICIES = Object.freeze({
  generic: {
    halfLifeMs: 1000 * 60 * 60 * 24 * 14, // 14 days
    freshMs: 1000 * 60 * 60 * 24, // 1 day
    okMs: 1000 * 60 * 60 * 24 * 7, // 7 days
    staleMs: 1000 * 60 * 60 * 24 * 30, // 30 days
    expiredMs: 1000 * 60 * 60 * 24 * 90, // 90 days
  },

  // Pricing/coupons/stock can change fast
  shopping: {
    halfLifeMs: 1000 * 60 * 60 * 12, // 12 hours
    freshMs: 1000 * 60 * 30, // 30 minutes
    okMs: 1000 * 60 * 60 * 6, // 6 hours
    staleMs: 1000 * 60 * 60 * 24, // 24 hours
    expiredMs: 1000 * 60 * 60 * 24 * 3, // 3 days
  },

  pricing: {
    halfLifeMs: 1000 * 60 * 60 * 12,
    freshMs: 1000 * 60 * 30,
    okMs: 1000 * 60 * 60 * 6,
    staleMs: 1000 * 60 * 60 * 24,
    expiredMs: 1000 * 60 * 60 * 24 * 3,
  },

  coupons: {
    halfLifeMs: 1000 * 60 * 60 * 24, // 1 day
    freshMs: 1000 * 60 * 60, // 1 hour
    okMs: 1000 * 60 * 60 * 12, // 12 hours
    staleMs: 1000 * 60 * 60 * 24 * 2, // 2 days
    expiredMs: 1000 * 60 * 60 * 24 * 7, // 7 days (or by coupon exp)
  },

  // Inventory changes often but not minute-by-minute in most homes
  inventory: {
    halfLifeMs: 1000 * 60 * 60 * 24 * 3, // 3 days
    freshMs: 1000 * 60 * 60 * 6, // 6 hours
    okMs: 1000 * 60 * 60 * 24 * 2, // 2 days
    staleMs: 1000 * 60 * 60 * 24 * 7, // 7 days
    expiredMs: 1000 * 60 * 60 * 24 * 30, // 30 days
  },

  // Meal plans often roll weekly
  meal: {
    halfLifeMs: 1000 * 60 * 60 * 24 * 7, // 7 days
    freshMs: 1000 * 60 * 60 * 24, // 1 day
    okMs: 1000 * 60 * 60 * 24 * 7, // 7 days
    staleMs: 1000 * 60 * 60 * 24 * 21, // 21 days
    expiredMs: 1000 * 60 * 60 * 24 * 60, // 60 days
  },

  // Cleaning schedules can be stable for weeks
  cleaning: {
    halfLifeMs: 1000 * 60 * 60 * 24 * 21, // 21 days
    freshMs: 1000 * 60 * 60 * 24 * 2, // 2 days
    okMs: 1000 * 60 * 60 * 24 * 14, // 14 days
    staleMs: 1000 * 60 * 60 * 24 * 45, // 45 days
    expiredMs: 1000 * 60 * 60 * 24 * 120, // 120 days
  },

  // Garden/animal cycles can be seasonal
  garden: {
    halfLifeMs: 1000 * 60 * 60 * 24 * 45, // 45 days
    freshMs: 1000 * 60 * 60 * 24 * 7, // 7 days
    okMs: 1000 * 60 * 60 * 24 * 30, // 30 days
    staleMs: 1000 * 60 * 60 * 24 * 90, // 90 days
    expiredMs: 1000 * 60 * 60 * 24 * 180, // 180 days
  },

  animals: {
    halfLifeMs: 1000 * 60 * 60 * 24 * 14, // 14 days
    freshMs: 1000 * 60 * 60 * 24 * 2,
    okMs: 1000 * 60 * 60 * 24 * 14,
    staleMs: 1000 * 60 * 60 * 24 * 45,
    expiredMs: 1000 * 60 * 60 * 24 * 120,
  },

  // Storehouse targets can be monthly/quarterly
  storehouse: {
    halfLifeMs: 1000 * 60 * 60 * 24 * 30, // 30 days
    freshMs: 1000 * 60 * 60 * 24 * 7,
    okMs: 1000 * 60 * 60 * 24 * 30,
    staleMs: 1000 * 60 * 60 * 24 * 90,
    expiredMs: 1000 * 60 * 60 * 24 * 365,
  },

  // Preservation behaves closer to inventory/storehouse unless you later specialize
  preservation: {
    halfLifeMs: 1000 * 60 * 60 * 24 * 14, // 14 days
    freshMs: 1000 * 60 * 60 * 24 * 2, // 2 days
    okMs: 1000 * 60 * 60 * 24 * 14, // 14 days
    staleMs: 1000 * 60 * 60 * 24 * 45, // 45 days
    expiredMs: 1000 * 60 * 60 * 24 * 120, // 120 days
  },
});

/**
 * Get a policy by domain/kind with fallback.
 *
 * @param {string} domain
 * @param {string} [kind]
 * @returns {object}
 */
export function getFreshnessPolicy(domain, kind) {
  const d = String(domain || "generic")
    .trim()
    .toLowerCase();
  const k = kind ? String(kind).trim().toLowerCase() : "";

  // Kind-specific overrides can be added later (e.g., "pricing.receipt", etc.)
  // For now, use domain-only.
  return (
    FRESHNESS_POLICIES[`${d}.${k}`] ||
    FRESHNESS_POLICIES[d] ||
    FRESHNESS_POLICIES.generic
  );
}

/**
 * Evaluate freshness for a piece of evidence.
 *
 * @param {object} params
 * @param {string} params.domain
 * @param {string} [params.kind]
 * @param {string|number|Date} params.timestamp when the evidence was observed/updated
 * @param {string|number|Date} [params.now] optional now override
 * @param {object} [params.policy] optional explicit policy (overrides domain policy)
 * @returns {{
 *  ok: boolean,
 *  freshness: number,
 *  bucket: "fresh"|"ok"|"stale"|"expired",
 *  ageMs: number|null,
 *  ageHuman: string|null,
 *  policy: object,
 *  timestampMs: number|null
 * }}
 */
export function evaluateFreshness(params = {}) {
  const domain = params.domain || "generic";
  const kind = params.kind || "";
  const policy = params.policy || getFreshnessPolicy(domain, kind);

  const n = params.now != null ? toMs(params.now) : nowMs();
  const t = toMs(params.timestamp);

  const age = t == null || n == null ? null : Math.max(0, n - t);

  // If no timestamp, treat as stale with very low freshness.
  if (age == null) {
    return {
      ok: false,
      freshness: 0.15,
      bucket: "stale",
      ageMs: null,
      ageHuman: null,
      policy,
      timestampMs: t,
    };
  }

  const freshness = freshnessFromAge(age, {
    halfLifeMs: policy.halfLifeMs,
    floor: 0,
    ceiling: 1,
  });

  const bucket = freshnessBucket(age, {
    freshMs: policy.freshMs,
    okMs: policy.okMs,
    staleMs: policy.staleMs,
  });

  const expiredMs = Math.max(
    safeNum(policy.expiredMs ?? 0, 0),
    safeNum(policy.staleMs ?? 0, 0)
  );
  const ok = age <= expiredMs;

  return {
    ok,
    freshness: clamp01(freshness),
    bucket,
    ageMs: age,
    ageHuman: msToHuman(age),
    policy,
    timestampMs: t,
  };
}

/**
 * Choose the freshest item from a list of candidates.
 *
 * @param {Array<any>} items
 * @param {(item:any)=> (string|number|Date|null|undefined)} getTimestamp
 * @param {{ domain?:string, kind?:string, now?:any, policy?:object }} [opts]
 * @returns {{ item:any|null, freshnessMeta:any, index:number }}
 */
export function pickFreshest(items, getTimestamp, opts = {}) {
  const arr = Array.isArray(items) ? items : [];
  const getter = typeof getTimestamp === "function" ? getTimestamp : () => null;
  const domain = opts.domain || "generic";
  const kind = opts.kind || "";
  const policy = opts.policy || getFreshnessPolicy(domain, kind);
  const n = opts.now != null ? opts.now : undefined;

  let best = null;
  let bestMeta = null;
  let bestIdx = -1;

  for (let i = 0; i < arr.length; i++) {
    const ts = getter(arr[i]);
    const meta = evaluateFreshness({
      domain,
      kind,
      timestamp: ts,
      now: n,
      policy,
    });

    if (!bestMeta) {
      best = arr[i];
      bestMeta = meta;
      bestIdx = i;
      continue;
    }

    // Prefer higher freshness score; tie-break by younger age if available
    if (meta.freshness > bestMeta.freshness) {
      best = arr[i];
      bestMeta = meta;
      bestIdx = i;
      continue;
    }

    if (
      meta.freshness === bestMeta.freshness &&
      meta.ageMs != null &&
      bestMeta.ageMs != null &&
      meta.ageMs < bestMeta.ageMs
    ) {
      best = arr[i];
      bestMeta = meta;
      bestIdx = i;
    }
  }

  return { item: best, freshnessMeta: bestMeta, index: bestIdx };
}

/**
 * Whether a datum should be refreshed based on thresholds.
 *
 * @param {object} params
 * @param {string} params.domain
 * @param {string} [params.kind]
 * @param {string|number|Date} params.timestamp
 * @param {("fresh"|"ok"|"stale"|"expired")} [params.refreshAt="stale"]
 * @param {any} [params.now]
 * @param {object} [params.policy]
 * @returns {{ shouldRefresh:boolean, reason:string, meta:any }}
 */
export function shouldRefresh(params = {}) {
  const refreshAt = String(params.refreshAt || "stale").toLowerCase();
  const meta = evaluateFreshness(params);

  const bucketOrder = {
    fresh: 0,
    ok: 1,
    stale: 2,
    expired: 3,
  };
  const target = bucketOrder[refreshAt] ?? 2;
  const current = bucketOrder[meta.bucket] ?? 2;

  const should = current >= target;

  let reason = "unknown";
  if (!meta.timestampMs) reason = "missing_timestamp";
  else if (meta.bucket === "expired") reason = "expired";
  else if (meta.bucket === "stale") reason = "stale";
  else if (meta.bucket === "ok") reason = "ok_but_refresh_target";
  else reason = "fresh";

  return { shouldRefresh: should, reason, meta };
}

/* -------------------------------------------------------------------------- */
/* Back-compat export expected by shims                                       */
/* -------------------------------------------------------------------------- */

/**
 * applyFreshnessRules(ctx, opts)
 *
 * Back-compat helper expected by some agent shims.
 * - Does NOT mutate nested structures besides attaching `_freshness`.
 * - Returns the original ctx reference for convenience.
 *
 * @param {Object} ctx
 * @param {{ domain?:string, kind?:string, now?:any, policy?:object, timestamp?:any }} [opts]
 * @returns {Object} ctx (with ctx._freshness attached)
 */
export function applyFreshnessRules(ctx = {}, opts = {}) {
  const c = ctx && typeof ctx === "object" ? ctx : {};

  const domain =
    opts.domain || c.domain || c?._meta?.domain || c.intentDomain || "generic";

  const kind = opts.kind || c.kind || c.intent || "";

  // Try a few common timestamp locations
  const ts =
    opts.timestamp ||
    c.updatedAt ||
    c.ts ||
    c.timestamp ||
    c?._meta?.builtAt ||
    null;

  const meta = evaluateFreshness({
    domain,
    kind,
    timestamp: ts,
    now: opts.now,
    policy: opts.policy,
  });

  // Attach in a predictable location for caching/UI/trace
  try {
    c._freshness = {
      domain: String(domain || "generic"),
      kind: String(kind || ""),
      timestamp: ts || null,
      ok: !!meta.ok,
      freshness: meta.freshness,
      bucket: meta.bucket,
      ageMs: meta.ageMs,
      ageHuman: meta.ageHuman,
      policy: meta.policy,
    };
  } catch {
    // swallow
  }

  return c;
}

export default {
  toMs,
  ageMsFrom,
  msToHuman,
  freshnessFromAge,
  freshnessBucket,
  FRESHNESS_POLICIES,
  getFreshnessPolicy,
  evaluateFreshness,
  pickFreshest,
  shouldRefresh,
  applyFreshnessRules,
};
