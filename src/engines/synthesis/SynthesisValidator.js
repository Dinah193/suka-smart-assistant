/**
 * @file C:\Users\larho\suka-smart-assistant\src\engines\synthesis\SynthesisValidator.js
 *
 * SynthesisValidator — performs a 100% readiness coverage check *before*
 * `session.build.complete`. Ensures every domain’s preconditions are satisfied
 * by the generated readiness steps, preventing half-baked schedules.
 *
 * PIPELINE FIT
 * imports → normalize → intelligence → synthesis(SynthesisEngine) → **SynthesisValidator (this)**
 * → if OK and (options.commit) → SessionsStore status update → (optional) Hub export
 *
 * WHAT THIS MODULE DOES
 * - Derives per-import “readiness requirements” using declarative Requirement Rules.
 * - Verifies that readinessSteps fully satisfy those requirements (>=100% coverage).
 * - Emits structured automation events for observability.
 * - Optionally commits session status updates to the SessionsStore and emits
 *   `session.build.complete` (and optionally exports to the Hub) **only when fully covered**.
 *
 * EVENT ENVELOPE SHAPE (every emit):
 *   { type, ts, source, data }
 *
 * EXTENSION POINTS
 * - registerRequirement(rule): add/override readiness requirement detection & satisfaction logic.
 *   See the RuleSpec typedef at the bottom of this file.
 */
import { emit as emitEventBus } from "@/services/events/eventBus";

const SOURCE = "SynthesisValidator";

// ───────────────────────────────────────────────────────────────────────────────
// Public API

/**
 * Validate 100% readiness coverage before completing session build.
 *
 * @param {Object} input
 * @param {Array<Object>} input.imports - normalized import items (same items SynthesisEngine used)
 * @param {Array<PrepStep>} input.readinessSteps - steps produced by SynthesisEngine
 * @param {Array<SessionSuggestion>} [input.sessionSuggestions] - sessions SynthesisEngine suggested
 * @param {Object} [input.context] - time/prefs/inventory context (optional; some rules consult this)
 * @param {Object} [options]
 * @param {boolean} [options.commit=false] - if true and coverage = 100%, persist sessions as "ready/built"
 * @param {string}  [options.planId] - optional plan correlation id
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   coverage: {
 *     score: number, // 0..1 (1 === 100%)
 *     byImport: Record<string, { required: string[], satisfied: string[], missing: string[] }>
 *   },
 *   blockers: string[],       // human-readable reasons for failure
 *   suggestions: string[],    // suggested new steps for missing coverage
 *   meta?: object
 * }>}
 */
export async function validate(
  {
    imports = [],
    readinessSteps = [],
    sessionSuggestions = [],
    context = {},
  } = {},
  options = {}
) {
  const tsStart = nowISO();

  if (!Array.isArray(imports) || !Array.isArray(readinessSteps)) {
    return failFast("Invalid inputs", { planId: options.planId });
  }

  emit("synthesis.validation.started", {
    imports: imports.length,
    steps: readinessSteps.length,
    sessions: sessionSuggestions.length,
    planId: options.planId || null,
  });

  // Build step index for quick satisfaction lookups
  const stepIndex = indexSteps(readinessSteps);

  // Compute requirements per import using the RULES registry
  const byImport = {};
  const blockers = [];
  const suggestions = [];

  for (const imp of imports) {
    const reqs = detectRequirements(imp, context);
    const satisfied = [];
    const missing = [];

    for (const req of reqs) {
      const ok = isRequirementSatisfied(req, { stepIndex, importItem: imp });
      if (ok) satisfied.push(req.id);
      else {
        missing.push(req.id);
        suggestions.push(req.mitigation || humanizeRequirement(req));
      }
    }

    byImport[
      imp.id || imp.title || `imp:${Math.random().toString(36).slice(2)}`
    ] = {
      required: reqs.map((r) => r.id),
      satisfied,
      missing,
    };
  }

  const { score, allMissing } = scoreCoverage(byImport);
  const ok = score === 1 && allMissing.length === 0;

  emit("synthesis.validation.coverage", {
    score,
    missingCount: allMissing.length,
    planId: options.planId || null,
  });

  if (!ok) {
    // Produce friendly blockers
    blockers.push(
      `Readiness coverage below 100% (${Math.round(score * 100)}%).`
    );
    if (allMissing.length)
      blockers.push(`Missing: ${Array.from(new Set(allMissing)).join(", ")}`);

    emit("synthesis.validation.failed", {
      score,
      missing: Array.from(new Set(allMissing)),
      planId: options.planId || null,
    });

    return {
      ok: false,
      coverage: { score, byImport },
      blockers,
      suggestions,
      meta: { tsStart, tsEnd: nowISO() },
    };
  }

  // All good: optionally commit sessions to "built/ready"
  if (
    options.commit &&
    Array.isArray(sessionSuggestions) &&
    sessionSuggestions.length > 0
  ) {
    const commitRes = await commitSessionsBuilt(
      sessionSuggestions,
      options.planId
    );
    if (commitRes.ok) {
      emit("session.build.complete", {
        planId: options.planId || null,
        count: sessionSuggestions.length,
      });

      // Optional hub export on household data change
      await exportToHubIfEnabled({
        type: "session.build.complete",
        ts: nowISO(),
        source: SOURCE,
        data: {
          planId: options.planId || null,
          count: sessionSuggestions.length,
        },
      });
    } else {
      emit("synthesis.validation.commit.error", {
        planId: options.planId || null,
        message: commitRes.error,
      });
      // Commit failure should not flip validation result to false
    }
  }

  emit("synthesis.validation.passed", {
    score: 1,
    planId: options.planId || null,
  });

  return {
    ok: true,
    coverage: { score: 1, byImport },
    blockers: [],
    suggestions: [],
    meta: { tsStart, tsEnd: nowISO() },
  };
}

/**
 * Register/override a readiness requirement rule at runtime.
 * @param {RuleSpec} rule
 */
export function registerRequirement(rule) {
  if (!rule || typeof rule !== "object" || !rule.id) return;
  REQUIREMENT_RULES.set(rule.id, rule);
  emit("synthesis.validation.rule.registered", {
    id: rule.id,
    domain: rule.domain || "*",
  });
}

/** List registered requirement ids (for diagnostics/UIs). */
export function listRequirementIds() {
  return Array.from(REQUIREMENT_RULES.keys());
}

// ───────────────────────────────────────────────────────────────────────────────
// Requirements — registry & defaults

const REQUIREMENT_RULES = new Map();
bootstrapDefaultRequirements();

/**
 * Given an import item, detect all requirements that apply.
 * @param {object} imp
 * @param {object} ctx
 * @returns {Array<Requirement>}
 */
function detectRequirements(imp, ctx) {
  const out = [];
  for (const rule of REQUIREMENT_RULES.values()) {
    try {
      if (rule.domain && rule.domain !== (imp.domain || "").toLowerCase())
        continue;
      const needed =
        typeof rule.when === "function"
          ? !!rule.when({ item: imp, ctx })
          : true;
      if (!needed) continue;

      const req = buildRequirementFromRule(rule, imp);
      out.push(req);
    } catch {
      // Skip faulty rule; validator should never crash the pipeline
    }
  }
  // Deduplicate by id
  const uniq = new Map();
  for (const r of out) uniq.set(r.id, r);
  return Array.from(uniq.values());
}

/**
 * Determine if a requirement is satisfied by existing readiness steps.
 * Satisfaction logic may be:
 *  - explicit matcher (rule.satisfiedBy)
 *  - fallback to title/meta heuristics
 */
function isRequirementSatisfied(req, { stepIndex, importItem }) {
  try {
    if (typeof req.satisfiedBy === "function") {
      return !!req.satisfiedBy({
        steps: stepIndex.all,
        stepIndex,
        item: importItem,
      });
    }
  } catch {
    // fall through to heuristics
  }

  // Heuristics: check keywords in title and meta.reason tags
  const titleHits = stepIndex.byTitle[req.keywordKey] || [];
  if (titleHits.length) return true;

  for (const reason of req.reasonTags || []) {
    const hits = stepIndex.byReason[reason] || [];
    if (hits.length) return true;
  }

  return false;
}

// ───────────────────────────────────────────────────────────────────────────────
// Default requirement rules

function bootstrapDefaultRequirements() {
  // RECIPE: thaw when frozen proteins present
  REQUIREMENT_RULES.set("thaw-protein", {
    id: "thaw-protein",
    domain: "recipe",
    label: "Thaw frozen protein",
    keywordKey: "thaw",
    reasonTags: ["frozen-protein"],
    mitigation: "Add a “Thaw protein in fridge (12h)” prep step.",
    when: ({ item }) =>
      hasAny(
        item?.items,
        (x) =>
          /(chicken|beef|pork|fish|lamb)/i.test(x.name) && x.state === "frozen"
      ),
  });

  // RECIPE: soak beans for dried legumes
  REQUIREMENT_RULES.set("soak-beans", {
    id: "soak-beans",
    domain: "recipe",
    label: "Soak dried beans",
    keywordKey: "soak",
    reasonTags: ["dried-legume"],
    mitigation: "Add a “Soak beans (8h)” prep step.",
    when: ({ item }) =>
      hasAny(
        item?.items,
        (x) => /(chickpea|garbanzo|bean)/i.test(x.name) && x.state === "dried"
      ),
  });

  // RECIPE: preheat oven when baking/roasting
  REQUIREMENT_RULES.set("preheat-oven", {
    id: "preheat-oven",
    domain: "recipe",
    label: "Preheat oven",
    keywordKey: "preheat",
    reasonTags: ["oven-method"],
    mitigation: "Add a “Preheat oven” prep step.",
    when: ({ item }) => hasAny(item?.methods, (m) => /bake|roast/i.test(m)),
  });

  // CLEANING: have supplies before task
  REQUIREMENT_RULES.set("stock-supplies", {
    id: "stock-supplies",
    domain: "cleaning",
    label: "Ensure cleaning supplies available",
    keywordKey: "stock",
    reasonTags: ["inventory-shortage"],
    mitigation: "Add a “Stock up supplies” prep step.",
    when: ({ item, ctx }) => {
      const shortages = (item.items || []).filter(
        (it) => qty(ctx?.inventory, it.sku) < (it.qty || 1)
      );
      return shortages.length > 0;
    },
  });

  // PRESERVATION: sterilize jars
  REQUIREMENT_RULES.set("sterilize-jars", {
    id: "sterilize-jars",
    domain: "preservation",
    label: "Sterilize jars",
    keywordKey: "sterilize",
    reasonTags: [],
    mitigation: "Add a “Sterilize jars” prep step.",
    when: () => true,
  });

  // GARDEN: clean tools before harvest
  REQUIREMENT_RULES.set("clean-tools", {
    id: "clean-tools",
    domain: "garden",
    label: "Clean tools & baskets",
    keywordKey: "clean",
    reasonTags: [],
    mitigation: "Add a “Clean tools & baskets” prep step.",
    when: ({ item }) => /harvest/i.test(item.title || ""),
  });
}

function buildRequirementFromRule(rule, item) {
  return {
    id: rule.id,
    label: rule.label || humanize(rule.id),
    domain: rule.domain || (item.domain || "").toLowerCase(),
    reasonTags: rule.reasonTags || [],
    keywordKey: (rule.keywordKey || rule.id || "").toLowerCase(),
    mitigation:
      rule.mitigation || `Add a “${rule.label || humanize(rule.id)}” step.`,
    satisfiedBy: rule.satisfiedBy,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Scoring & indexing

function scoreCoverage(byImport) {
  let requiredTotal = 0;
  let satisfiedTotal = 0;
  const allMissing = [];

  for (const entry of Object.values(byImport)) {
    requiredTotal += entry.required.length;
    satisfiedTotal += entry.satisfied.length;
    allMissing.push(...entry.missing);
  }

  const score =
    requiredTotal === 0 ? 1 : clamp01(satisfiedTotal / requiredTotal);
  return { score, allMissing };
}

function indexSteps(steps) {
  const byTitle = Object.create(null);
  const byReason = Object.create(null);

  for (const s of steps) {
    const t = (s.title || "").toLowerCase();
    // Collect tokens of interest
    for (const token of [
      "thaw",
      "soak",
      "preheat",
      "stock",
      "sterilize",
      "clean",
    ]) {
      if (t.includes(token)) pushIndex(byTitle, token, s);
    }
    const reason = s.meta?.reason;
    if (reason) pushIndex(byReason, String(reason).toLowerCase(), s);
  }

  return { byTitle, byReason, all: steps };
}

function pushIndex(idx, key, step) {
  if (!idx[key]) idx[key] = [];
  idx[key].push(step);
}

// ───────────────────────────────────────────────────────────────────────────────
// Commit sessions as "built/ready" (household mutation → optional Hub export)

async function commitSessionsBuilt(sessions, planId) {
  try {
    const store =
      (await softImport("src/domain/sessions/SessionsStore.js")) ||
      (await softImport("src/services/session/SessionsStore.js"));
    if (!store) return { ok: false, error: "SessionsStore unavailable" };

    const updater =
      store.updateMany ||
      store.bulkUpsert ||
      (store.default && (store.default.updateMany || store.default.bulkUpsert));

    if (typeof updater !== "function")
      return { ok: false, error: "No updateMany/bulkUpsert in SessionsStore" };

    // Update status to 'ready' and stamp planId
    const docs = sessions.map((s) => ({
      id: s.id || `sess:${hash(`${s.domain}:${s.title}:${s.start || ""}`)}`,
      status: "ready",
      meta: { ...(s.meta || {}), planId: planId || null, builtAt: nowISO() },
    }));

    const res = await updater.call(store, docs);
    return res?.ok !== false
      ? { ok: true }
      : { ok: false, error: res?.error || "store error" };
  } catch (err) {
    return { ok: false, error: err?.message || "commit exception" };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Telemetry

function emit(type, data) {
  try {
    eventBus.emit("automation.event", {
      type,
      ts: nowISO(),
      source: SOURCE,
      data,
    });
  } catch {
    /* never throw */
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Small utils

function nowISO() {
  return new Date().toISOString();
}

function failFast(message, extra = {}) {
  emit("synthesis.validation.failed", { reason: "INPUT", message, ...extra });
  return {
    ok: false,
    coverage: { score: 0, byImport: {} },
    blockers: [message],
    suggestions: [],
    meta: { tsStart: nowISO(), tsEnd: nowISO() },
  };
}

function qty(inventory, sku) {
  if (!sku) return 0;
  const v = inventory?.[sku];
  return Number.isFinite(v) ? v : 0;
}

function clamp01(n) {
  return Math.min(1, Math.max(0, Number(n) || 0));
}

function hasAny(list, pred) {
  return Array.isArray(list) && list.some(pred);
}

function humanizeRequirement(req) {
  return `Add a readiness step for “${req.label || humanize(req.id)}”.`;
}

function humanize(id) {
  return String(id || "")
    .replace(/[-_.]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function stringOrNull(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function hash(str) {
  let h = 2166136261 >>> 0; // FNV-1a tiny impl
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16);
}

// ───────────────────────────────────────────────────────────────────────────────
// Optional Hub export helper (only for household data mutations on commit)

async function exportToHubIfEnabled(payload) {
  try {
    const flagsMod = await softImport("src/config/featureFlags.json");
    const featureFlags = flagsMod?.default || flagsMod || {};
    if (!featureFlags.familyFundMode) return;

    const Formatter = await softImport(
      "src/services/hub/HubPacketFormatter.js"
    );
    const Connector = await softImport(
      "src/services/hub/FamilyFundConnector.js"
    );
    if (!Formatter || !Connector) return;

    const packet =
      (Formatter.format && Formatter.format(payload)) ||
      (Formatter.default &&
        Formatter.default.format &&
        Formatter.default.format(payload)) ||
      null;
    if (!packet) return;

    const send =
      Connector.send || (Connector.default && Connector.default.send);
    if (typeof send !== "function") return;

    await send(packet);
  } catch {
    // fail silent by design
  }
}

async function softImport(path) {
  try {
    const mod = await import(/* @vite-ignore */ path);
    return mod?.default || mod;
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Type hints (JSDoc)

/**
 * @typedef {Object} PrepStep
 * @property {string} [id]
 * @property {string} domain
 * @property {string} title
 * @property {string|null} [dueBy]
 * @property {number} [priority]
 * @property {Object} [meta] - may include `reason` tag used by requirements
 */

/**
 * @typedef {Object} SessionSuggestion
 * @property {string} [id]
 * @property {string} domain
 * @property {string} title
 * @property {string|null} [start]
 * @property {string|null} [end]
 * @property {Object} [needs]
 * @property {Object} [meta]
 */

/**
 * @typedef {Object} Requirement
 * @property {string} id
 * @property {string} label
 * @property {string} domain
 * @property {string[]} [reasonTags]
 * @property {string} [keywordKey] - token used to match step titles (e.g., "thaw","preheat")
 * @property {(args:{steps:PrepStep[], stepIndex:any, item:any})=>boolean} [satisfiedBy]
 * @property {string} [mitigation]
 */

/**
 * @typedef {Object} RuleSpec
 * @property {string} id
 * @property {string} [label]
 * @property {string} [domain] - target domain for this requirement (e.g., 'recipe')
 * @property {string[]} [reasonTags]
 * @property {string} [keywordKey]
 * @property {(args:{item:any, ctx:any})=>boolean} [when] - return true if requirement applies
 * @property {(args:{steps:PrepStep[], stepIndex:any, item:any})=>boolean} [satisfiedBy]
 * @property {string} [mitigation]
 */

// ───────────────────────────────────────────────────────────────────────────────

export default {
  validate,
  registerRequirement,
  listRequirementIds,
};
