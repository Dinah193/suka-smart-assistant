/**
 * @file src/agents/skills/sessions/compose.js
 *
 * Domain-agnostic Session builder for Suka Smart Assistant (SSA).
 *
 * This module’s job:
 * - Accept domain-specific “plans” (recipes, cleaning plans, garden plans, etc.) OR
 *   already-structured steps and normalize them into a canonical Session object.
 * - Fill in sensible defaults (ids, prefs, timestamps, blockers, metadata).
 * - Optionally merge into an existing session to support “resume / recompose” flows.
 * - Emit a lightweight `session.composed` event so other SSA services can react.
 *
 * NOTE: This module *does not* persist sessions. Callers should hand the result
 *       to whatever SessionsRepo / Dexie integration you’re using.
 *
 * HOW THIS FITS:
 * - Pages / agents that create sessions (cooking, cleaning, garden, animals,
 *   preservation, storehouse) should call `composeSession` with:
 *   - a domain,
 *   - a source descriptor,
 *   - either a domain plan OR already normalized steps.
 * - The SessionRunner / “Now” button flow then consumes the composed Session.
 */

import { emit } from "../../../services/events/eventBus"; // Adjust if your eventBus exports differently

/**
 * @typedef {'cooking'|'cleaning'|'garden'|'animals'|'preservation'|'storehouse'} SessionDomain
 */

/**
 * @typedef {'recipe'|'cleaningPlan'|'gardenPlan'|'animalTask'|'import'|'manual'} SessionSourceType
 */

/**
 * @typedef {'pending'|'running'|'paused'|'completed'|'aborted'} SessionStatus
 */

/**
 * @typedef {'inventory'|'weather'|'quietHours'|'sabbath'|'equipment'} SessionBlocker
 */

/**
 * @typedef {'color'|'texture'|'probeTemp'|'timer'|'smell'} DonenessCue
 */

/**
 * @typedef {Object} SessionSource
 * @property {SessionSourceType} type
 * @property {string|null} refId
 */

/**
 * @typedef {Object} SessionStepMetadata
 * @property {number} [tempTargetF]
 * @property {DonenessCue} [donenessCue]
 * @property {string} [cueNotes]
 */

/**
 * @typedef {Object} SessionStep
 * @property {string} id
 * @property {string} title
 * @property {string} desc
 * @property {number} durationSec
 * @property {SessionBlocker[]} blockers
 * @property {SessionStepMetadata} metadata
 */

/**
 * @typedef {Object} SessionPrefs
 * @property {boolean} voiceGuidance
 * @property {boolean} haptic
 * @property {boolean} autoAdvance
 */

/**
 * @typedef {Object} SessionProgress
 * @property {number} currentStepIndex
 * @property {number} elapsedSec
 * @property {string|null} startedAt
 * @property {string|null} pausedAt
 */

/**
 * @typedef {Object} SessionAnalytics
 * @property {string[]} skippedSteps
 * @property {Array<Object>} adjustments
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {SessionDomain} domain
 * @property {string} title
 * @property {SessionSource} source
 * @property {SessionStep[]} steps
 * @property {SessionPrefs} prefs
 * @property {SessionStatus} status
 * @property {SessionProgress} progress
 * @property {SessionAnalytics} analytics
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} DomainPlanStepInput
 * @property {string} [id]
 * @property {string} [title]
 * @property {string} [desc]
 * @property {number} [durationSec]
 * @property {SessionBlocker[]} [blockers]
 * @property {Partial<SessionStepMetadata>} [metadata]
 * @property {Object} [constraints] Arbitrary domain-specific constraints (e.g., { needsQuiet: true })
 */

/**
 * @typedef {Object} DomainPlanInput
 * @property {string} [title]
 * @property {string} [subtitle]
 * @property {DomainPlanStepInput[]} [steps]
 * @property {Object} [guards] Optional hints for blockers (e.g., { weather: true, sabbath: false })
 */

/**
 * @typedef {Object} ComposeSessionOptions
 * @property {SessionDomain} domain
 * @property {string} [title] Fallback title if plan/source doesn't supply one
 * @property {SessionSource} [source]
 * @property {DomainPlanInput} [plan] Domain-specific plan object
 * @property {DomainPlanStepInput[]} [steps] Already-normalized (or close) steps
 * @property {Partial<SessionPrefs>} [prefs]
 * @property {Session} [resumeFrom] Existing session to merge/patch for “resume” flows
 */

/**
 * Generate a reasonably unique id without introducing external dependencies.
 * @param {string} [prefix]
 * @returns {string}
 */
function generateId(prefix = "sess") {
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}_${rand}`;
}

/**
 * Normalize domain value defensively.
 * @param {any} domain
 * @returns {SessionDomain}
 */
function normalizeDomain(domain) {
  const allowed = [
    "cooking",
    "cleaning",
    "garden",
    "animals",
    "preservation",
    "storehouse",
  ];
  if (typeof domain !== "string") {
    return /** @type {SessionDomain} */ ("cooking");
  }
  const lower = domain.toLowerCase();
  if (allowed.includes(lower)) {
    return /** @type {SessionDomain} */ (lower);
  }
  return /** @type {SessionDomain} */ ("cooking");
}

/**
 * Normalize preferences with safe defaults.
 * @param {Partial<SessionPrefs>|undefined} prefs
 * @returns {SessionPrefs}
 */
function normalizePrefs(prefs) {
  const safe = prefs || {};
  return {
    voiceGuidance:
      typeof safe.voiceGuidance === "boolean" ? safe.voiceGuidance : true,
    haptic: typeof safe.haptic === "boolean" ? safe.haptic : true,
    autoAdvance:
      typeof safe.autoAdvance === "boolean" ? safe.autoAdvance : false,
  };
}

/**
 * Derive blockers array from explicit blockers + domain-specific constraints.
 * @param {SessionBlocker[]|undefined} blockers
 * @param {Object|undefined} constraints
 * @returns {SessionBlocker[]}
 */
function deriveBlockers(blockers, constraints) {
  /** @type {Set<SessionBlocker>} */
  const result = new Set();

  if (Array.isArray(blockers)) {
    for (const b of blockers) {
      if (
        b === "inventory" ||
        b === "weather" ||
        b === "quietHours" ||
        b === "sabbath" ||
        b === "equipment"
      ) {
        result.add(b);
      }
    }
  }

  if (constraints && typeof constraints === "object") {
    if (constraints.needsInventory || constraints.inventoryShortage)
      result.add("inventory");
    if (constraints.weatherSensitive || constraints.outdoorOnly)
      result.add("weather");
    if (constraints.needsQuiet || constraints.nightTimeOnly)
      result.add("quietHours");
    if (constraints.sabbathSensitive) result.add("sabbath");
    if (
      constraints.specialEquipment ||
      constraints.needsOven ||
      constraints.needsMixer
    )
      result.add("equipment");
  }

  return Array.from(result);
}

/**
 * Normalize metadata with fallbacks and guard against invalid values.
 * @param {Partial<SessionStepMetadata>|undefined} metadata
 * @returns {SessionStepMetadata}
 */
function normalizeMetadata(metadata) {
  const safe = metadata || {};
  /** @type {DonenessCue[]} */
  const allowedCues = ["color", "texture", "probeTemp", "timer", "smell"];

  let cue = safe.donenessCue;
  if (!allowedCues.includes(/** @type {DonenessCue} */ (cue))) {
    cue = "timer";
  }

  return {
    tempTargetF: Number.isFinite(safe.tempTargetF)
      ? Number(safe.tempTargetF)
      : 0,
    donenessCue: /** @type {DonenessCue} */ (cue),
    cueNotes: typeof safe.cueNotes === "string" ? safe.cueNotes.trim() : "",
  };
}

/**
 * Normalize / coerce a single step into a canonical SessionStep.
 *
 * The builder is intentionally tolerant: it will fill in missing titles/descriptions
 * and clamp invalid durations to zero so that the SessionRunner can still function
 * and show a warning instead of crashing.
 *
 * @param {DomainPlanStepInput|undefined|null} raw
 * @param {number} index
 * @returns {SessionStep}
 */
function normalizeStep(raw, index) {
  const fallbackTitle = `Step ${index + 1}`;
  const safe = raw || {};

  const id =
    typeof safe.id === "string" && safe.id.trim()
      ? safe.id.trim()
      : generateId(`step${index + 1}`);

  const title =
    typeof safe.title === "string" && safe.title.trim()
      ? safe.title.trim()
      : fallbackTitle;

  const desc = typeof safe.desc === "string" ? safe.desc.trim() : "";

  let duration = 0;
  if (Number.isFinite(safe.durationSec) && safe.durationSec > 0) {
    duration = Math.floor(Number(safe.durationSec));
  }

  const blockers = deriveBlockers(safe.blockers, safe.constraints);
  const metadata = normalizeMetadata(safe.metadata);

  return {
    id,
    title,
    desc,
    durationSec: duration,
    blockers,
    metadata,
  };
}

/**
 * Convert a DomainPlanInput into an array of SessionStep items.
 * @param {DomainPlanInput|undefined} plan
 * @param {DomainPlanStepInput[]|undefined} explicitSteps
 * @returns {SessionStep[]}
 */
function buildSteps(plan, explicitSteps) {
  const rawSteps = Array.isArray(explicitSteps)
    ? explicitSteps
    : plan && Array.isArray(plan.steps)
    ? plan.steps
    : [];

  if (!rawSteps.length) {
    // Provide a tiny “no-op” session instead of failing hard.
    return [
      normalizeStep(
        {
          title: "No steps provided",
          desc: "This session has no defined steps. Use Edit to add steps or discard this session.",
          durationSec: 0,
          blockers: [],
          metadata: { donenessCue: "timer", cueNotes: "" },
        },
        0
      ),
    ];
  }

  return rawSteps.map((s, idx) => normalizeStep(s, idx));
}

/**
 * Derive a reasonable session title from the plan/source options.
 * @param {ComposeSessionOptions} opts
 * @returns {string}
 */
function deriveTitle(opts) {
  if (typeof opts.title === "string" && opts.title.trim()) {
    return opts.title.trim();
  }

  if (opts.plan) {
    const { title, subtitle } = opts.plan;
    if (typeof title === "string" && title.trim()) return title.trim();
    if (typeof subtitle === "string" && subtitle.trim()) return subtitle.trim();
  }

  if (
    opts.source &&
    typeof opts.source.refId === "string" &&
    opts.source.refId
  ) {
    // Very basic domain-y fallback based on source
    return `Session from ${opts.source.type}:${opts.source.refId}`;
  }

  // Domain-based generic fallback
  const domainLabelMap = {
    cooking: "Cooking Session",
    cleaning: "Cleaning Session",
    garden: "Garden Session",
    animals: "Animal Care Session",
    preservation: "Preservation Session",
    storehouse: "Storehouse Session",
  };

  const domain = normalizeDomain(opts.domain);
  // @ts-ignore
  return domainLabelMap[domain] || "Household Session";
}

/**
 * Normalize a source descriptor (type/refId) defensively.
 * @param {SessionSource|undefined} source
 * @returns {SessionSource}
 */
function normalizeSource(source) {
  const fallbackType = /** @type {SessionSourceType} */ ("manual");
  if (!source || typeof source !== "object") {
    return { type: fallbackType, refId: null };
  }

  const allowedTypes = [
    "recipe",
    "cleaningPlan",
    "gardenPlan",
    "animalTask",
    "import",
    "manual",
  ];
  const type = allowedTypes.includes(source.type) ? source.type : fallbackType;

  const refId =
    typeof source.refId === "string" && source.refId.trim()
      ? source.refId.trim()
      : null;

  return {
    type: /** @type {SessionSourceType} */ (type),
    refId,
  };
}

/**
 * Compose a brand new Session object OR (optionally) merge into an existing one
 * for a “resume / recompose” scenario.
 *
 * Basic usage:
 * ```js
 * const session = composeSession({
 *   domain: 'cooking',
 *   source: { type: 'recipe', refId: recipeId },
 *   plan: parsedRecipePlan,    // or `steps: [...]`
 *   prefs: { voiceGuidance: true }
 * });
 * ```
 *
 * Resume usage (e.g. user edits steps then resumes):
 * ```js
 * const updated = composeSession({
 *   domain: 'cooking',
 *   plan: updatedPlan,
 *   resumeFrom: existingSession
 * });
 * ```
 *
 * @param {ComposeSessionOptions} opts
 * @returns {Session}
 */
export function composeSession(opts) {
  if (!opts || typeof opts !== "object") {
    throw new Error("composeSession: options object is required.");
  }

  const domain = normalizeDomain(opts.domain);
  const nowIso = new Date().toISOString();
  const title = deriveTitle(opts);
  const prefs = normalizePrefs(opts.prefs);
  const source = normalizeSource(opts.source);

  const steps = buildSteps(opts.plan, opts.steps);

  // If resuming from an existing session, preserve id, analytics, createdAt, and attempt to
  // maintain progress where possible. This keeps the SessionRunner + Dexie logic idempotent.
  if (opts.resumeFrom && typeof opts.resumeFrom === "object") {
    const prev = opts.resumeFrom;

    const safeProgress = /** @type {SessionProgress} */ ({
      currentStepIndex: clampIndex(
        prev.progress?.currentStepIndex ?? 0,
        steps.length
      ),
      elapsedSec: Number.isFinite(prev.progress?.elapsedSec)
        ? Number(prev.progress.elapsedSec)
        : 0,
      startedAt: prev.progress?.startedAt || null,
      pausedAt: prev.progress?.pausedAt || null,
    });

    /** @type {Session} */
    const resumedSession = {
      id: prev.id || generateId("sess"),
      domain,
      title,
      source,
      steps,
      prefs,
      status: prev.status || "pending",
      progress: safeProgress,
      analytics: prev.analytics || { skippedSteps: [], adjustments: [] },
      createdAt: prev.createdAt || nowIso,
      updatedAt: nowIso,
    };

    safeEmitSessionComposed(resumedSession, "resume");
    return resumedSession;
  }

  // New session case
  /** @type {SessionProgress} */
  const progress = {
    currentStepIndex: 0,
    elapsedSec: 0,
    startedAt: null,
    pausedAt: null,
  };

  /** @type {SessionAnalytics} */
  const analytics = {
    skippedSteps: [],
    adjustments: [],
  };

  /** @type {Session} */
  const session = {
    id: generateId("sess"),
    domain,
    title,
    source,
    steps,
    prefs,
    status: "pending",
    progress,
    analytics,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  safeEmitSessionComposed(session, "new");
  return session;
}

/**
 * Clamp a step index to valid range [0, stepsLength-1].
 * If there are no steps, return 0.
 *
 * @param {number} index
 * @param {number} stepsLength
 * @returns {number}
 */
function clampIndex(index, stepsLength) {
  if (!Number.isFinite(index)) return 0;
  if (stepsLength <= 0) return 0;
  if (index < 0) return 0;
  if (index >= stepsLength) return stepsLength - 1;
  return index;
}

/**
 * Emit a `session.composed` event in a defensive way so that this module never
 * hard-crashes if eventBus is misconfigured or temporarily unavailable.
 *
 * Event payload shape:
 * {
 *   type: 'session.composed',
 *   ts: ISO8601 string,
 *   source: 'sessions.compose',
 *   data: { session, mode: 'new'|'resume' }
 * }
 *
 * @param {Session} session
 * @param {'new'|'resume'} mode
 */
function safeEmitSessionComposed(session, mode) {
  try {
    if (typeof emit === "function") {
      emit({
        type: "session.composed",
        ts: new Date().toISOString(),
        source: "sessions.compose",
        data: { session, mode },
      });
    }
  } catch (err) {
    // Fail silently; composing a session should never crash due to eventBus issues.
    // You may want to log this to your own telemetry.
    // console.warn('[sessions.compose] Failed to emit session.composed', err);
  }
}

/**
 * Convenience helper for building a trivial one-step “quick session”, e.g.:
 * - “15-minute kitchen reset”
 * - “Turn compost pile”
 * - “Check freezers”
 *
 * This is useful for quick ad-hoc sessions from buttons or voice commands.
 *
 * @param {Object} opts
 * @param {SessionDomain} opts.domain
 * @param {string} opts.title
 * @param {string} [opts.desc]
 * @param {number} [opts.durationSec]
 * @param {SessionBlocker[]} [opts.blockers]
 * @param {Partial<SessionPrefs>} [opts.prefs]
 * @returns {Session}
 */
export function composeQuickSession(opts) {
  if (!opts || typeof opts !== "object") {
    throw new Error("composeQuickSession: options object is required.");
  }

  const planStep = /** @type {DomainPlanStepInput} */ ({
    title: opts.title,
    desc: opts.desc || "",
    durationSec: opts.durationSec || 0,
    blockers: opts.blockers || [],
    metadata: { donenessCue: "timer", cueNotes: "" },
  });

  return composeSession({
    domain: opts.domain,
    title: opts.title,
    steps: [planStep],
    prefs: opts.prefs,
  });
}
