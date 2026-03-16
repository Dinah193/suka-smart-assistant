/**
 * @file src/agents/modes/map.js
 *
 * Intent → skill-graph map for Suka Smart Assistant (SSA).
 *
 * HOW THIS FITS:
 * - Central registry of **what skill(s)** should handle a given intent string.
 * - Provides a lightweight “skill graph” so the Reasoner / Orchestrator can:
 *   - Look up the primary handler (e.g. session composition).
 *   - Discover its dependencies (gating, confidence, budget, context, guards).
 *   - Apply consistent policies (budget, confidence, gating) across intents.
 *
 * This is intentionally metadata-only:
 * - It does NOT execute any skills directly.
 * - Skills should be dynamically imported by the orchestrator using the
 *   `handler.modulePath` + `handler.exportName` fields.
 *
 * EXAMPLE USAGE:
 * ```js
 * import { getIntentConfig, resolveSkillGraph } from '../../agents/modes/map';
 *
 * const cfg = getIntentConfig('session.compose.cooking');
 * if (!cfg) throw new Error('Unknown intent');
 *
 * const graph = resolveSkillGraph('session.compose.cooking');
 * // graph.nodes, graph.edges → used to orchestrate gating → context → main skill.
 * ```
 */

import { emit } from "../../services/events/eventBus";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {'localSkill'|'policy'|'helper'} HandlerKind
 */

/**
 * A skill / policy handler reference. This is metadata only; it describes
 * where to import the actual implementation from.
 *
 * @typedef {Object} HandlerRef
 * @property {HandlerKind} kind
 * @property {string} modulePath   Relative path from src root, e.g. '@agents/skills/sessions/compose'
 * @property {string} exportName   Named export to call, e.g. 'composeSession'
 */

/**
 * Budget policy reference.
 *
 * @typedef {Object} BudgetRef
 * @property {string} policyId     e.g. 'default-reasoning-budget'
 * @property {string} [configPath] JSON path within agents/policies/budget.json
 */

/**
 * Confidence policy reference.
 *
 * @typedef {Object} ConfidenceRef
 * @property {string} profileId    e.g. 'sessions-default'
 * @property {string} [modulePath] e.g. 'agents/policies/confidence'
 */

/**
 * Gating policy reference.
 *
 * @typedef {Object} GatingRef
 * @property {string} [modulePath] e.g. 'agents/policies/gating'
 * @property {string} ruleId       e.g. 'allow-if-budget-and-guards-pass'
 */

/**
 * Context selector reference.
 *
 * @typedef {Object} ContextSelectorRef
 * @property {string} modulePath   e.g. 'agents/context/selectors'
 * @property {string} exportName   e.g. 'getMinimalReasoningContext'
 */

/**
 * Freshness policy reference.
 *
 * @typedef {Object} FreshnessRef
 * @property {string} modulePath   e.g. 'agents/context/freshness'
 * @property {string} exportName   e.g. 'evaluateDatasetFreshness'
 */

/**
 * Guard group reference.
 *
 * @typedef {Object} GuardsRef
 * @property {string} modulePath   e.g. 'agents/skills/sessions/guardsEvaluate'
 * @property {string} exportName   e.g. 'evaluateSessionGuards'
 */

/**
 * Core description of an intent in the skill map.
 *
 * @typedef {Object} IntentConfig
 * @property {string} id
 * @property {string} description
 * @property {HandlerRef} handler
 * @property {BudgetRef} budget
 * @property {ConfidenceRef} confidence
 * @property {GatingRef} gating
 * @property {ContextSelectorRef} context
 * @property {FreshnessRef} freshness
 * @property {GuardsRef|null} [guards]
 * @property {string[]} deps  Other intent ids that should be executed first
 */

/**
 * Skill graph node (for orchestration planning).
 *
 * @typedef {Object} SkillGraphNode
 * @property {string} id
 * @property {IntentConfig} config
 */

/**
 * Skill graph edge.
 *
 * @typedef {Object} SkillGraphEdge
 * @property {string} from
 * @property {string} to
 * @property {'dependsOn'} type
 */

/**
 * Skill graph for a root intent.
 *
 * @typedef {Object} SkillGraph
 * @property {string} rootIntent
 * @property {SkillGraphNode[]} nodes
 * @property {SkillGraphEdge[]} edges
 */

/* -------------------------------------------------------------------------- */
/*  Intent Registry                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Central intent → configuration map.
 *
 * NOTE:
 * - All module paths are relative to `src/`, without file extensions.
 *   The orchestrator should add `.js` when importing dynamically.
 * - You can evolve this registry over time without touching core logic.
 *
 * @type {Record<string, IntentConfig>}
 */
const INTENT_MAP = {
  /* ---------------------------------------------------------------------- */
  /*  Session composition (domain-specific)                                 */
  /* ---------------------------------------------------------------------- */

  "session.compose.cooking": makeSessionComposeConfig({
    id: "session.compose.cooking",
    description: "Compose a cooking session from a recipe or manual input.",
    domain: "cooking",
  }),

  "session.compose.cleaning": makeSessionComposeConfig({
    id: "session.compose.cleaning",
    description: "Compose a cleaning session from a plan or manual input.",
    domain: "cleaning",
  }),

  "session.compose.garden": makeSessionComposeConfig({
    id: "session.compose.garden",
    description: "Compose a garden session from a garden plan.",
    domain: "garden",
  }),

  "session.compose.animals": makeSessionComposeConfig({
    id: "session.compose.animals",
    description: "Compose an animal-care session from daily tasks/rotations.",
    domain: "animals",
  }),

  "session.compose.preservation": makeSessionComposeConfig({
    id: "session.compose.preservation",
    description: "Compose a preservation session (canning, curing, etc.).",
    domain: "preservation",
  }),

  "session.compose.storehouse": makeSessionComposeConfig({
    id: "session.compose.storehouse",
    description: "Compose a storehouse session (inventory moves, audits).",
    domain: "storehouse",
  }),

  /* ---------------------------------------------------------------------- */
  /*  Session guards + feasibility                                          */
  /* ---------------------------------------------------------------------- */

  "session.guards.evaluate": {
    id: "session.guards.evaluate",
    description:
      "Evaluate all configured guards (Sabbath, quiet hours, weather, inventory, battery) for a proposed session.",
    handler: {
      kind: "localSkill",
      modulePath: "agents/skills/sessions/guardsEvaluate",
      exportName: "evaluateSessionGuards",
    },
    budget: {
      policyId: "guards-default",
      configPath: "session.guards",
    },
    confidence: {
      profileId: "guards-default",
      modulePath: "agents/policies/confidence",
    },
    gating: {
      modulePath: "agents/policies/gating",
      ruleId: "allow-if-budget-and-guards-pass",
    },
    context: {
      modulePath: "agents/context/selectors",
      exportName: "getMinimalReasoningContext",
    },
    freshness: {
      modulePath: "agents/context/freshness",
      exportName: "evaluateDatasetFreshness",
    },
    guards: null,
    deps: [
      "guards.sabbath.check",
      "guards.quietHours.check",
      "guards.weather.check",
      "guards.inventory.check",
      "guards.battery.check",
    ],
  },

  /* Individual guard intents (can be called independently if needed) */

  "guards.sabbath.check": {
    id: "guards.sabbath.check",
    description: "Check if the requested session conflicts with Sabbath rules.",
    handler: {
      kind: "localSkill",
      modulePath: "agents/skills/guards/sabbath",
      exportName: "checkSabbath",
    },
    budget: {
      policyId: "guards-light",
      configPath: "guards.sabbath",
    },
    confidence: {
      profileId: "guards-default",
      modulePath: "agents/policies/confidence",
    },
    gating: {
      modulePath: "agents/policies/gating",
      ruleId: "allow-if-budget",
    },
    context: {
      modulePath: "agents/context/selectors",
      exportName: "getMinimalReasoningContext",
    },
    freshness: {
      modulePath: "agents/context/freshness",
      exportName: "evaluateDatasetFreshness",
    },
    guards: null,
    deps: [],
  },

  "guards.quietHours.check": {
    id: "guards.quietHours.check",
    description: "Check if the requested session conflicts with quiet hours.",
    handler: {
      kind: "localSkill",
      modulePath: "agents/skills/guards/quietHours",
      exportName: "checkQuietHours",
    },
    budget: {
      policyId: "guards-light",
      configPath: "guards.quietHours",
    },
    confidence: {
      profileId: "guards-default",
      modulePath: "agents/policies/confidence",
    },
    gating: {
      modulePath: "agents/policies/gating",
      ruleId: "allow-if-budget",
    },
    context: {
      modulePath: "agents/context/selectors",
      exportName: "getMinimalReasoningContext",
    },
    freshness: {
      modulePath: "agents/context/freshness",
      exportName: "evaluateDatasetFreshness",
    },
    guards: null,
    deps: [],
  },

  "guards.weather.check": {
    id: "guards.weather.check",
    description: "Check if current/forecast weather allows the requested work.",
    handler: {
      kind: "localSkill",
      modulePath: "agents/skills/guards/weather",
      exportName: "checkWeather",
    },
    budget: {
      policyId: "guards-weather",
      configPath: "guards.weather",
    },
    confidence: {
      profileId: "guards-weather",
      modulePath: "agents/policies/confidence",
    },
    gating: {
      modulePath: "agents/policies/gating",
      ruleId: "allow-if-budget",
    },
    context: {
      modulePath: "agents/context/selectors",
      exportName: "getMinimalReasoningContext",
    },
    freshness: {
      modulePath: "agents/context/freshness",
      exportName: "evaluateDatasetFreshness",
    },
    guards: null,
    deps: [],
  },

  "guards.inventory.check": {
    id: "guards.inventory.check",
    description:
      "Check if inventory and equipment are sufficient for a session.",
    handler: {
      kind: "localSkill",
      modulePath: "agents/skills/guards/inventory",
      exportName: "checkInventoryForSession",
    },
    budget: {
      policyId: "guards-inventory",
      configPath: "guards.inventory",
    },
    confidence: {
      profileId: "guards-default",
      modulePath: "agents/policies/confidence",
    },
    gating: {
      modulePath: "agents/policies/gating",
      ruleId: "allow-if-budget",
    },
    context: {
      modulePath: "agents/context/selectors",
      exportName: "getMinimalReasoningContext",
    },
    freshness: {
      modulePath: "agents/context/freshness",
      exportName: "evaluateDatasetFreshness",
    },
    guards: null,
    deps: [],
  },

  "guards.battery.check": {
    id: "guards.battery.check",
    description:
      "Check device battery state to apply low-battery pause policy.",
    handler: {
      kind: "localSkill",
      modulePath: "agents/skills/guards/battery",
      exportName: "checkBatteryGuard",
    },
    budget: {
      policyId: "guards-light",
      configPath: "guards.battery",
    },
    confidence: {
      profileId: "guards-default",
      modulePath: "agents/policies/confidence",
    },
    gating: {
      modulePath: "agents/policies/gating",
      ruleId: "allow-if-budget",
    },
    context: {
      modulePath: "agents/context/selectors",
      exportName: "getMinimalReasoningContext",
    },
    freshness: {
      modulePath: "agents/context/freshness",
      exportName: "evaluateDatasetFreshness",
    },
    guards: null,
    deps: [],
  },

  /* ---------------------------------------------------------------------- */
  /*  Session "Now" resolver                                                */
  /* ---------------------------------------------------------------------- */

  "session.now.resolve": {
    id: "session.now.resolve",
    description:
      'Resolve the next runnable session for a given domain (for the "Now" button).',
    handler: {
      kind: "localSkill",
      modulePath: "@agents/skills/sessions/compose", // convenience: compose module can host resolver
      exportName: "resolveNextRunnableSession",
    },
    budget: {
      policyId: "default-reasoning-budget",
      configPath: "session.now",
    },
    confidence: {
      profileId: "sessions-default",
      modulePath: "agents/policies/confidence",
    },
    gating: {
      modulePath: "agents/policies/gating",
      ruleId: "allow-if-budget",
    },
    context: {
      modulePath: "agents/context/selectors",
      exportName: "getMinimalReasoningContext",
    },
    freshness: {
      modulePath: "agents/context/freshness",
      exportName: "evaluateDatasetFreshness",
    },
    guards: {
      modulePath: "agents/skills/sessions/guardsEvaluate",
      exportName: "evaluateSessionGuards",
    },
    deps: ["session.guards.evaluate"],
  },
};

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Get the configuration for a given intent id.
 *
 * @param {string} intentId
 * @returns {IntentConfig|null}
 */
export function getIntentConfig(intentId) {
  if (!intentId || typeof intentId !== "string") return null;
  const cfg = INTENT_MAP[intentId];
  return cfg || null;
}

/**
 * Back-compat named export expected by `src/agents/modes/validate.js`:
 *   import { getModeConfig } from "./map.js";
 *
 * In this folder, "mode config" historically refers to the *intent config* entry.
 *
 * @param {string} intentId
 * @returns {IntentConfig|null}
 */
export function getModeConfig(intentId) {
  return getIntentConfig(intentId);
}

/**
 * Back-compat named export expected by some shims:
 *   import { getModeForIntent } from "@/agents/modes/map";
 *
 * Shopping shim uses this to resolve a mode config from an intent string.
 *
 * @param {string} intentId
 * @returns {IntentConfig|null}
 */
export function getModeForIntent(intentId) {
  return getIntentConfig(intentId);
}

/**
 * Return a skill graph (nodes + edges) rooted at the given intent.
 *
 * - Performs a simple DFS to collect all dependency intents.
 * - Deduplicates nodes.
 * - Emits a telemetry event describing the resolved graph.
 *
 * @param {string} rootIntentId
 * @returns {SkillGraph|null}
 */
export function resolveSkillGraph(rootIntentId) {
  const rootCfg = getIntentConfig(rootIntentId);
  if (!rootCfg) return null;

  /** @type {Record<string, SkillGraphNode>} */
  const nodesById = {};
  /** @type {SkillGraphEdge[]} */
  const edges = [];

  const visited = new Set();

  /**
   * @param {string} intentId
   */
  function dfs(intentId) {
    if (visited.has(intentId)) return;
    visited.add(intentId);

    const cfg = getIntentConfig(intentId);
    if (!cfg) return;

    nodesById[intentId] = {
      id: intentId,
      config: cfg,
    };

    for (const depId of cfg.deps || []) {
      edges.push({
        from: intentId,
        to: depId,
        type: "dependsOn",
      });
      dfs(depId);
    }
  }

  dfs(rootIntentId);

  const graph = {
    rootIntent: rootIntentId,
    nodes: Object.values(nodesById),
    edges,
  };

  safeEmitGraphResolved(graph);
  return graph;
}

/**
 * Enumerate all known intents in the registry.
 *
 * @returns {string[]}
 */
export function listIntents() {
  return Object.keys(INTENT_MAP).sort();
}

/**
 * Resolve an "agent mode" for HouseholdOrchestrator.
 *
 * HouseholdOrchestrator expects a named export `resolveMode`.
 * This maps a domain (and optional caller overrides) to a root intent id.
 *
 * @param {{ domain?: string, intent?: string, mode?: string }} [opts]
 * @returns {{ mode: 'local'|'reasoner', intentId: string }}
 */
export function resolveMode(opts = {}) {
  const domain = String(opts.domain || "")
    .trim()
    .toLowerCase();
  const explicitIntent = String(opts.intent || "").trim();
  const explicitMode = String(opts.mode || "")
    .trim()
    .toLowerCase();

  // If caller explicitly provides an intent, trust it.
  if (explicitIntent) {
    return {
      mode: explicitMode === "local" ? "local" : "reasoner",
      intentId: explicitIntent,
    };
  }

  // Domain → default session.compose intent
  const byDomain = {
    cooking: "session.compose.cooking",
    cleaning: "session.compose.cleaning",
    garden: "session.compose.garden",
    animals: "session.compose.animals",
    preservation: "session.compose.preservation",
    storehouse: "session.compose.storehouse",
  };

  const intentId = byDomain[domain] || "session.compose.cooking";

  return {
    mode: explicitMode === "local" ? "local" : "reasoner",
    intentId,
  };
}

/**
 * Back-compat alias expected by some shims:
 *   import { selectMode } from "@/agents/modes/map";
 *
 * @param {{ domain?: string, intent?: string, mode?: string }} [opts]
 * @returns {{ mode: 'local'|'reasoner', intentId: string }}
 */
export function selectMode(opts = {}) {
  return resolveMode(opts);
}

/**
 * resolveSababMode (shim compatibility)
 * ---------------------------------------------------------------------------
 * sababShim imports:
 *   resolveSababMode(req) => { mode: string, schemaId: string }
 *
 * We keep this browser-safe and deterministic. If the request includes an
 * explicit mode/schemaId, we honor it; otherwise we fall back to conservative
 * defaults so builds never fail.
 *
 * @param {any} req
 * @returns {{ mode: string, schemaId: string }}
 */
export function resolveSababMode(req = {}) {
  const r = req && typeof req === "object" ? req : {};
  const mode =
    (typeof r.mode === "string" && r.mode.trim()) ||
    (typeof r.intent === "string" && r.intent.trim()) ||
    "sabab.default";

  const schemaId =
    (typeof r.schemaId === "string" && r.schemaId.trim()) || "sabab.output.v1";

  return { mode, schemaId };
}

/**
 * resolveSausageMode (shim compatibility)
 * ---------------------------------------------------------------------------
 * sausageShim imports:
 *   resolveSausageMode(req) => { mode: string, schemaId: string }
 *
 * Browser-safe + deterministic. If the request includes explicit mode/schemaId,
 * we honor it; otherwise we fall back to conservative defaults so builds never fail.
 *
 * @param {any} req
 * @returns {{ mode: string, schemaId: string }}
 */
export function resolveSausageMode(req = {}) {
  const r = req && typeof req === "object" ? req : {};
  const mode =
    (typeof r.mode === "string" && r.mode.trim()) ||
    (typeof r.intent === "string" && r.intent.trim()) ||
    "sausage.default";

  const schemaId =
    (typeof r.schemaId === "string" && r.schemaId.trim()) ||
    "sausage.output.v1";

  return { mode, schemaId };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Factory to build a domain-specific session compose intent config.
 *
 * @param {{ id: string, description: string, domain: string }} params
 * @returns {IntentConfig}
 */
function makeSessionComposeConfig(params) {
  return {
    id: params.id,
    description: params.description,
    handler: {
      kind: "localSkill",
      modulePath: "@agents/skills/sessions/compose",
      exportName: "composeSession",
    },
    budget: {
      policyId: "default-reasoning-budget",
      configPath: `sessions.compose.${params.domain}`,
    },
    confidence: {
      profileId: "sessions-default",
      modulePath: "agents/policies/confidence",
    },
    gating: {
      modulePath: "agents/policies/gating",
      ruleId: "allow-if-budget-and-guards-pass",
    },
    context: {
      modulePath: "agents/context/selectors",
      exportName: "getMinimalReasoningContext",
    },
    freshness: {
      modulePath: "agents/context/freshness",
      exportName: "evaluateDatasetFreshness",
    },
    guards: {
      modulePath: "agents/skills/sessions/guardsEvaluate",
      exportName: "evaluateSessionGuards",
    },
    deps: ["session.guards.evaluate"],
  };
}

/**
 * Emit graph resolution telemetry without breaking callers.
 *
 * @param {SkillGraph} graph
 */
function safeEmitGraphResolved(graph) {
  try {
    if (typeof emit !== "function") return;
    emit({
      type: "agents.modes.graph.resolved",
      ts: new Date().toISOString(),
      source: "agents.modes.map",
      data: {
        rootIntent: graph.rootIntent,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        intents: graph.nodes.map((n) => n.id),
      },
    });
  } catch {
    // swallow
  }
}
