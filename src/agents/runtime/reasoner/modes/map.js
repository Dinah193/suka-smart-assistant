// File: src/agents/runtime/reasoner/modes/map.js
// SSA — Reasoner Modes Map (production-ready)
//
// Purpose
// - Central registry of "reasoning modes" used by SSA shims/runtime.
// - Each mode defines:
//   - id (unique key)
//   - label + description (UX-friendly)
//   - defaults (policy knobs like freshness/confidence thresholds)
//   - selectors (what evidence to prefer)
//   - prompts/templates (optional; many SSA flows are non-AI)
//   - validators (optional)
// - Used by budget/gating/core pipelines to pick behavior deterministically.
//
// Notes
// - Keep modes small and composable.
// - Modes are NOT "AI models". They are rule-policy profiles.
// - This file must be safe in browser builds (no Node imports).

/* ------------------------------ helpers ------------------------------ */

function deepFreeze(obj) {
  if (!obj || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v);
  }
  return obj;
}

function clamp(n, min, max, fallback) {
  const x = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, x));
}

function normalizeToken(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function mergeShallow(base, over) {
  const b = base && typeof base === "object" ? base : {};
  const o = over && typeof over === "object" ? over : {};
  return { ...b, ...o };
}

/* ------------------------------ mode schema ------------------------------ */
/**
Mode object (informal):
{
  id: "default",
  label: "Default",
  description: "...",
  defaults: {
    // policy knobs used across reasoner
    confidence: { minAccept, minWarn, minBlock, weights? },
    freshness: { maxAgeDays?, preferRecentDays?, ... },
    cache: { enabled, ttlMs, strategy },
    selection: { prefer: ["local","catalog","receipt","web"], maxCandidates },
    safety: { strict, quietHoursAware, sabbathAware },
  },
  selectors: {
    // evidence ordering preferences by domain/kind (optional)
    domains?: { [domain]: { prefer?:[], maxCandidates?:number } },
    kinds?: { [kind]: { prefer?:[], maxCandidates?:number } },
  },
  templates: {
    // optional system/prompt template hooks (kept generic)
    system?: string,
    user?: string,
  },
  validate?: (ctx) => { ok:boolean, warnings?:[], errors?:[] }
}
*/

/* ------------------------------ base defaults ------------------------------ */

const BASE_DEFAULTS = deepFreeze({
  confidence: {
    // In SSA, confidence is used as a "how safe to act" signal:
    // - accept: OK to auto-apply
    // - warn: show a banner / require confirm
    // - block: don't auto-apply (user must explicitly override)
    minAccept: 0.72,
    minWarn: 0.55,
    minBlock: 0.35,

    // Optional weights used by confidence.js (if it supports them)
    // The runtime can ignore any it doesn't understand.
    weights: {
      evidenceQuality: 0.35,
      evidenceCount: 0.15,
      agreement: 0.2,
      freshness: 0.2,
      sourceTrust: 0.1,
    },
  },

  freshness: {
    // Max allowed age for "auto-apply" actions by default.
    // Domain-specific overrides can tighten/loosen this.
    maxAgeDays: 180,
    preferRecentDays: 30,

    // If true, stale evidence isn't discarded; it is downranked.
    downrankStale: true,
  },

  cache: {
    enabled: true,
    // Default 6 hours. Budget/gating can override per call.
    ttlMs: 6 * 60 * 60 * 1000,
    // "hash" means cache keyed by request payload hash; "coarse" ignores payload.
    strategy: "hash", // "hash" | "coarse" | "artifact" | "entity"
  },

  selection: {
    // Evidence preference ordering. Earlier = stronger preference.
    // Keep "local" first (Dexie/user state), then fixed catalogs, then artifacts.
    prefer: ["local", "catalog", "artifact", "receipt", "manual", "web"],
    maxCandidates: 25,
  },

  safety: {
    strict: true,
    quietHoursAware: true,
    sabbathAware: true,
  },
});

/* ------------------------------ mode library ------------------------------ */

const MODES = [
  {
    id: "default",
    label: "Default",
    description:
      "Balanced, deterministic mode. Prefers local + fixed catalogs; uses stale evidence with downranking.",
    defaults: BASE_DEFAULTS,
    selectors: {
      // example: domain-based tweaks
      domains: {
        cleaning: { prefer: ["local", "catalog", "manual"], maxCandidates: 20 },
        meal: {
          prefer: ["local", "catalog", "artifact", "manual"],
          maxCandidates: 30,
        },
        storehouse: {
          prefer: ["local", "receipt", "catalog", "artifact"],
          maxCandidates: 40,
        },
      },
    },
    templates: {},
  },

  {
    id: "strict",
    label: "Strict",
    description:
      "High safety mode. Requires strong confidence and fresh evidence for auto-apply actions.",
    defaults: deepFreeze({
      ...BASE_DEFAULTS,
      confidence: {
        ...BASE_DEFAULTS.confidence,
        minAccept: 0.82,
        minWarn: 0.65,
        minBlock: 0.45,
      },
      freshness: {
        ...BASE_DEFAULTS.freshness,
        maxAgeDays: 90,
        preferRecentDays: 14,
        downrankStale: true,
      },
      selection: {
        ...BASE_DEFAULTS.selection,
        maxCandidates: 20,
      },
      safety: {
        ...BASE_DEFAULTS.safety,
        strict: true,
      },
    }),
    selectors: {
      domains: {
        storehouse: {
          prefer: ["receipt", "local", "catalog"],
          maxCandidates: 30,
        },
      },
    },
  },

  {
    id: "fast",
    label: "Fast",
    description:
      "Speed-first mode. Uses cache aggressively and accepts lower confidence for suggestions (not auto-apply).",
    defaults: deepFreeze({
      ...BASE_DEFAULTS,
      confidence: {
        ...BASE_DEFAULTS.confidence,
        minAccept: 0.66,
        minWarn: 0.5,
        minBlock: 0.3,
      },
      cache: {
        ...BASE_DEFAULTS.cache,
        enabled: true,
        ttlMs: 24 * 60 * 60 * 1000, // 24h
        strategy: "hash",
      },
      freshness: {
        ...BASE_DEFAULTS.freshness,
        maxAgeDays: 365,
        preferRecentDays: 60,
        downrankStale: true,
      },
      selection: {
        ...BASE_DEFAULTS.selection,
        maxCandidates: 50,
      },
    }),
  },

  {
    id: "offline",
    label: "Offline",
    description:
      "Offline-first mode. Never expects network/web evidence; relies on local + catalog + artifacts.",
    defaults: deepFreeze({
      ...BASE_DEFAULTS,
      selection: {
        ...BASE_DEFAULTS.selection,
        prefer: ["local", "catalog", "artifact", "receipt", "manual"],
        maxCandidates: 35,
      },
      cache: {
        ...BASE_DEFAULTS.cache,
        enabled: true,
        ttlMs: 48 * 60 * 60 * 1000, // 48h
      },
    }),
  },

  {
    id: "audit",
    label: "Audit / Explain",
    description:
      "Evidence-heavy mode. Keeps more candidates and expects full reasoning traces for review.",
    defaults: deepFreeze({
      ...BASE_DEFAULTS,
      selection: {
        ...BASE_DEFAULTS.selection,
        maxCandidates: 75,
      },
      cache: {
        ...BASE_DEFAULTS.cache,
        enabled: false, // prefer recompute to show current evidence set
      },
      confidence: {
        ...BASE_DEFAULTS.confidence,
        // keep thresholds normal; audit focuses on explanation, not stricter decisions
        minAccept: 0.72,
        minWarn: 0.55,
        minBlock: 0.35,
      },
    }),
    templates: {
      // Optional hooks if you later add text explanations/prompting (still deterministic)
      system:
        "You are SSA Reasoner in Audit mode. Produce transparent, step-by-step rationale using only provided evidence. No speculation.",
      user: "Explain how you reached the decision. Cite evidence sources and confidence contributions.",
    },
  },

  {
    id: "planner",
    label: "Planner",
    description:
      "Planning mode for forward-looking suggestions. Accepts broader evidence, but does not auto-apply changes.",
    defaults: deepFreeze({
      ...BASE_DEFAULTS,
      confidence: {
        ...BASE_DEFAULTS.confidence,
        // planning can accept slightly lower signals as suggestions
        minAccept: 0.68,
        minWarn: 0.52,
        minBlock: 0.3,
      },
      freshness: {
        ...BASE_DEFAULTS.freshness,
        maxAgeDays: 540,
        preferRecentDays: 90,
        downrankStale: true,
      },
      selection: {
        ...BASE_DEFAULTS.selection,
        maxCandidates: 60,
      },
      safety: {
        ...BASE_DEFAULTS.safety,
        strict: true,
      },
    }),
    selectors: {
      domains: {
        garden: { prefer: ["catalog", "local", "manual"], maxCandidates: 60 },
        animals: { prefer: ["catalog", "local", "manual"], maxCandidates: 60 },
      },
    },
  },
];

/* ------------------------------ index + accessors ------------------------------ */

const MODE_MAP = (() => {
  const m = new Map();
  for (const mode of MODES) {
    if (!mode || !mode.id) continue;
    const id = normalizeToken(mode.id);
    // Ensure defaults are always present
    const normalized = {
      ...mode,
      id,
      defaults: mode.defaults || BASE_DEFAULTS,
      selectors: mode.selectors || {},
      templates: mode.templates || {},
    };
    m.set(id, deepFreeze(normalized));
  }
  // hard guarantee default exists
  if (!m.has("default")) {
    m.set(
      "default",
      deepFreeze({
        id: "default",
        label: "Default",
        description: "Balanced, deterministic mode.",
        defaults: BASE_DEFAULTS,
        selectors: {},
        templates: {},
      })
    );
  }
  return m;
})();

/**
 * Get a mode object by id (falls back to "default").
 */
export function getMode(modeId) {
  const id = normalizeToken(modeId || "default") || "default";
  return MODE_MAP.get(id) || MODE_MAP.get("default");
}

/**
 * Back-compat named export expected by older agents code:
 *   import { getModeConfig } from "./map.js";
 *
 * Historically, "mode config" == the full mode object.
 */
export function getModeConfig(modeId) {
  return getMode(modeId);
}

/**
 * List all modes for UI dropdowns.
 */
export function listModes() {
  return Array.from(MODE_MAP.values()).map((m) => ({
    id: m.id,
    label: m.label,
    description: m.description,
  }));
}

/**
 * Resolve effective policy for a given context.
 * - Merges base defaults + mode defaults + optional overrides.
 *
 * @param {object} params
 * @param {string} params.mode
 * @param {string} params.domain
 * @param {string} params.kind
 * @param {object} [params.overrides] - shallow overrides for defaults buckets
 */
export function resolvePolicy({ mode, domain, kind, overrides } = {}) {
  const m = getMode(mode);

  const d = normalizeToken(domain || "generic");
  const k = normalizeToken(kind || "generic");
  const o = overrides && typeof overrides === "object" ? overrides : {};

  // Start with BASE_DEFAULTS, then mode.defaults
  let policy = {
    confidence: mergeShallow(BASE_DEFAULTS.confidence, m.defaults?.confidence),
    freshness: mergeShallow(BASE_DEFAULTS.freshness, m.defaults?.freshness),
    cache: mergeShallow(BASE_DEFAULTS.cache, m.defaults?.cache),
    selection: mergeShallow(BASE_DEFAULTS.selection, m.defaults?.selection),
    safety: mergeShallow(BASE_DEFAULTS.safety, m.defaults?.safety),
  };

  // Apply domain/kind selector preference tweaks (affects selection bucket only)
  const sel = { ...(policy.selection || {}) };
  const domainSel = m.selectors?.domains?.[d];
  const kindSel = m.selectors?.kinds?.[k];

  if (domainSel?.prefer) sel.prefer = domainSel.prefer.slice();
  if (kindSel?.prefer) sel.prefer = kindSel.prefer.slice();
  if (typeof domainSel?.maxCandidates === "number")
    sel.maxCandidates = clamp(
      domainSel.maxCandidates,
      1,
      500,
      sel.maxCandidates
    );
  if (typeof kindSel?.maxCandidates === "number")
    sel.maxCandidates = clamp(kindSel.maxCandidates, 1, 500, sel.maxCandidates);

  policy.selection = sel;

  // Apply user/household overrides (shallow per bucket)
  if (o.confidence)
    policy.confidence = mergeShallow(policy.confidence, o.confidence);
  if (o.freshness)
    policy.freshness = mergeShallow(policy.freshness, o.freshness);
  if (o.cache) policy.cache = mergeShallow(policy.cache, o.cache);
  if (o.selection)
    policy.selection = mergeShallow(policy.selection, o.selection);
  if (o.safety) policy.safety = mergeShallow(policy.safety, o.safety);

  return deepFreeze({
    mode: m.id,
    domain: d,
    kind: k,
    ...policy,
  });
}

/**
 * Quick helper: pick the preferred source order for a domain/kind in a mode.
 */
export function preferredSources({ mode, domain, kind } = {}) {
  return resolvePolicy({ mode, domain, kind }).selection.prefer || [];
}

/* ------------------------------ back-compat helpers ------------------------------ */
/**
 * Back-compat named export expected by shims (e.g., storehouseShim.js):
 *   import { getModeForIntent } from "@/agents/runtime/reasoner/modes/map";
 *
 * The SSA shims often only know an "intent" (and maybe domain/runtime flags).
 * This resolver:
 * - Accepts common hints (offline/strict/audit/planner/fast) from runtime + intent text
 * - Returns a *mode id string* (not a mode object)
 *
 * @param {object} params
 * @param {string} [params.intent]
 * @param {string} [params.domain]
 * @param {object} [params.runtime]
 * @param {string} [params.fallback="default"]
 * @returns {string} mode id
 */
export function getModeForIntent({
  intent,
  domain,
  runtime,
  fallback = "default",
} = {}) {
  // Explicit override wins
  const explicit =
    runtime?.mode || runtime?.reasonerMode || runtime?.policyMode || null;
  const explicitId = normalizeToken(explicit || "");
  if (explicitId && MODE_MAP.has(explicitId)) return explicitId;

  // Feature flags / environment hints
  if (runtime?.offline === true || runtime?.isOffline === true) {
    return MODE_MAP.has("offline") ? "offline" : "default";
  }
  if (runtime?.audit === true || runtime?.explain === true) {
    return MODE_MAP.has("audit") ? "audit" : "default";
  }
  if (runtime?.strict === true || runtime?.safe === true) {
    return MODE_MAP.has("strict") ? "strict" : "default";
  }
  if (runtime?.fast === true || runtime?.speed === true) {
    return MODE_MAP.has("fast") ? "fast" : "default";
  }
  if (runtime?.planner === true || runtime?.planning === true) {
    return MODE_MAP.has("planner") ? "planner" : "default";
  }

  const t = normalizeToken(intent || "");
  const d = normalizeToken(domain || "");

  // Heuristics from intent text (keep deterministic and conservative)
  if (t.includes("audit") || t.includes("explain") || t.includes("trace")) {
    return MODE_MAP.has("audit") ? "audit" : "default";
  }
  if (t.includes("plan") || t.includes("forecast") || t.includes("rotation")) {
    return MODE_MAP.has("planner") ? "planner" : "default";
  }
  if (t.includes("offline")) {
    return MODE_MAP.has("offline") ? "offline" : "default";
  }
  if (t.includes("strict") || t.includes("safe")) {
    return MODE_MAP.has("strict") ? "strict" : "default";
  }
  if (t.includes("fast") || t.includes("quick")) {
    return MODE_MAP.has("fast") ? "fast" : "default";
  }

  // Domain nudges (minimal)
  if (
    d === "storehouse" &&
    (runtime?.receiptFirst === true || t.includes("par"))
  ) {
    // still a mode id; we keep default unless explicitly strict/audit/etc.
    return "default";
  }

  const fb = normalizeToken(fallback || "default") || "default";
  return MODE_MAP.has(fb) ? fb : "default";
}

/* ------------------------------ default export ------------------------------ */

export const ReasonerModes = {
  getMode,
  getModeConfig,
  listModes,
  resolvePolicy,
  preferredSources,
  getModeForIntent,
};

export default ReasonerModes;
