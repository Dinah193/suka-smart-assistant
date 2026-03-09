// C:\Users\larho\suka-smart-assistant\src\engines\nextBestAction.js

/**
 * nextBestAction
 * ---------------
 * Purpose:
 *  - Continuously compute "what should we do next?" from the live household state.
 *  - Ingests events (sessions created/updated, inventory changes, harvests, imports, etc.)
 *    and ranks actionable sessions (cooking, cleaning, garden, animal, preservation, storehouse).
 *  - Respects guard policies (quiet hours, sabbath, weather) and user preferences.
 *  - Emits normalized suggestions for UI and/or auto-scheduling.
 *  - Optionally exports summarized signals to the Hub (familyFundMode) without blocking core flow.
 *
 * Pipeline fit (imports → intelligence → automation → (optional) hub export):
 *   - imports: upstream engines and importers emit domain events
 *   - intelligence: this engine ranks actions using a scoring model
 *   - automation: emits nba.suggestions.updated and can emit automation.schedule.request
 *   - hub export: sends anonymized/aggregated suggestion summaries if enabled
 */

//// Soft/defensive dynamic import /////////////////////////////////////////////

async function softImport(path) {
  try {
    return await import(path);
  } catch {
    return null;
  }
}

//// Dependencies (populated in start()) ///////////////////////////////////////

let eventBus; // required
let featureFlags = { familyFundMode: false, nba: { autoSchedule: false } };

let SessionStore; // optional: unified store of pending sessions
// Expected minimal API if present:
//   - list({ domains?, state? }): Promise<Array<Session>>
//   - getById(id): Promise<Session|null>
//   - update(id, patch): Promise<void>

let HouseholdPrefs; // optional: doneness, dietary, anchors, user energy, guards
let GuardPolicies; // optional: quiet hours, sabbath, weather guard evaluation
let InventoryService; // optional: reservation/availability peeks
let WeatherService; // optional: used by guard heuristics (outdoor tasks)
let CalendarService; // optional: busy blocks, available time windows

let HubPacketFormatter; // optional
let FamilyFundConnector; // optional

//// Utilities /////////////////////////////////////////////////////////////////

const nowISO = () => new Date().toISOString();

function safeId(prefix = "nba") {
  if (typeof crypto !== "undefined" && crypto.randomUUID)
    return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

function sanitize(x) {
  try {
    return JSON.parse(JSON.stringify(x));
  } catch {
    return undefined;
  }
}
function safeError(err) {
  return { name: err?.name || "Error", message: err?.message || String(err) };
}

function emit(type, source, data) {
  if (!eventBus?.emit) return;
  eventBus.emit({ type, ts: nowISO(), source, data });
}

async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    const packet = HubPacketFormatter?.format?.(payload, {
      stream: "nextBestAction",
    });
    if (!packet) return;
    await FamilyFundConnector?.send?.(packet);
  } catch {
    // silent fail by design
  }
}

//// Engine state //////////////////////////////////////////////////////////////

const state = {
  initialized: false,
  computing: false,
  dirty: false,
  lastSuggestions: [],
  lastContext: null,
  config: {
    // Scoring knobs
    baseWeights: {
      urgency: 0.35, // window closing soon
      readiness: 0.25, // inventory ok, prerequisites met
      fitWindow: 0.15, // duration fits the user's available window
      preference: 0.15, // household anchors (meal label, protein, routines)
      rotation: 0.05, // diversify domains
      freshness: 0.05, // recently suggested? de-boost
    },
    // Time
    debounceMs: 250, // debounce recomputes on bursts of events
    lookaheadMinutes: 120, // plan within next 2 hours by default
    defaultDurationMin: 30,
    // Guards
    enforceGuards: true,
    // Scheduling
    autoScheduleThreshold: 0.82, // if autoSchedule enabled, schedule when score >= this
    maxAutoSchedulesPerCycle: 2,
    // Domain rotation (optional)
    rotationDecay: 0.15, // penalize repeating same domain too often
    // Output
    maxSuggestions: 7,
    includeReasons: true,
  },
  // memory for rotation/freshness
  rotationCounter: new Map(), // domain -> lastSeenIndex
  suggestionCounter: 0, // increments each compute
};

let debounceTimer = null;

//// Core NBA computation //////////////////////////////////////////////////////

/**
 * Load sessions to consider. If no SessionStore, derive from events (degraded).
 */
async function loadCandidateSessions() {
  if (SessionStore?.list) {
    try {
      // By default, consider actionable/pending sessions in key domains
      const sessions = await SessionStore.list({
        domains: [
          "cooking",
          "cleaning",
          "garden",
          "animal",
          "preservation",
          "storehouse",
        ],
        state: ["planned", "created", "ready"], // flexible: adapt to your status names
      });
      return Array.isArray(sessions) ? sessions : [];
    } catch (err) {
      emit("engine.warning", "engines/nextBestAction", {
        message: "SessionStore.list failed",
        error: safeError(err),
      });
    }
  }
  // Degraded: no store; return empty and rely on direct suggestion events to fill UI
  return [];
}

/**
 * Build the "context" used in scoring (time, availability, guards, prefs, weather).
 */
async function buildContext() {
  const now = new Date();
  const prefs =
    (HouseholdPrefs?.get?.() || HouseholdPrefs?.getCached?.()) ?? {};

  // Calendar availability window (optional)
  let availableWindowMinutes = state.config.lookaheadMinutes;
  if (CalendarService?.nextAvailableWindowMinutes) {
    try {
      availableWindowMinutes =
        (await CalendarService.nextAvailableWindowMinutes({
          horizonMinutes: state.config.lookaheadMinutes,
        })) ?? availableWindowMinutes;
    } catch {
      /* noop */
    }
  }

  // Weather snapshot (optional)
  let weather = null;
  if (WeatherService?.getSnapshot) {
    try {
      weather = await WeatherService.getSnapshot();
    } catch {
      /* noop */
    }
  }

  // Guard policy computed flags
  let guardFlags = { quiet: false, sabbath: false, weather: null };
  if (state.config.enforceGuards && GuardPolicies?.evaluateNow) {
    try {
      guardFlags = await GuardPolicies.evaluateNow({ prefs, weather, now });
      // example result: { quiet: true/false, sabbath: true/false, weather: { outdoorOk: boolean } }
    } catch {
      /* noop */
    }
  }

  return {
    now,
    prefs,
    weather,
    guardFlags,
    availableWindowMinutes,
  };
}

/**
 * Compute a normalized score [0,1] and reasons array for a session.
 */
function scoreSession(session, ctx) {
  const reasons = [];
  const W = state.config.baseWeights;

  // Urgency: how close to window end are we?
  const win = session?.schedule?.window || {};
  const end = win?.to ? new Date(win.to) : new Date(Date.now() + 60 * 60000);
  const start = win?.from ? new Date(win.from) : new Date();
  const now = ctx.now;
  const totalMs = Math.max(end - start, 1);
  const elapsedMs = Math.max(now - start, 0);
  const urgency = clamp01(totalMs ? elapsedMs / totalMs : 0);
  reasons.push({ k: "urgency", v: round2(urgency) });

  // Readiness: inventory availability + prerequisites satisfied
  let readiness = 1;
  const shortages = session?.meta?.shortages || [];
  if (shortages.length) {
    readiness -= Math.min(0.6, shortages.length * 0.15);
  }
  if (session?.meta?.prereqs?.length) {
    // penalize if unsatisfied
    const unmet = session.meta.prereqs.filter((p) => !p?.met).length;
    if (unmet > 0) readiness -= Math.min(0.4, unmet * 0.2);
  }
  readiness = clamp01(readiness);
  reasons.push({ k: "readiness", v: round2(readiness) });

  // Fit to available window: duration vs availableWindowMinutes
  const estMin =
    Number(
      session?.session?.tasks?.reduce(
        (a, t) => a + Number(t.estimatedMinutes || 0),
        0
      )
    ) ||
    Number(session?.meta?.projection?.estimatedCookMinutes) ||
    state.config.defaultDurationMin;
  const fitRatio = clamp01(estMin / Math.max(ctx.availableWindowMinutes, 1));
  // Closer to 1 is worse fit; invert
  const fitWindow = clamp01(1 - Math.abs(1 - fitRatio)); // best around equal
  reasons.push({ k: "fitWindow", v: round2(fitWindow) });

  // Preferences: anchors alignment (meal label, protein, technique, routines)
  let preference = 0;
  const anchors = session?.session?.anchors || [];
  const wantMeal = ctx.prefs?.preferredMealLabel;
  if (wantMeal) {
    const hit = anchors.some((a) => a.type === "meal" && a.label === wantMeal);
    if (hit) preference += 0.4;
  }
  const routineTags = ctx.prefs?.routineTags || [];
  if (routineTags.length) {
    const hit = anchors.some((a) => routineTags.includes(a.label));
    if (hit) preference += 0.3;
  }
  preference = clamp01(preference);
  reasons.push({ k: "preference", v: round2(preference) });

  // Rotation: discourage repeating same domain too often
  let rotation = 1;
  const dKey = session?.domain || "unknown";
  if (state.rotationCounter.has(dKey)) {
    rotation -= state.config.rotationDecay; // small penalty; keeps variety
  }
  rotation = clamp01(rotation);
  reasons.push({ k: "rotation", v: round2(rotation) });

  // Freshness: was this suggested very recently?
  let freshness = 1;
  const recently = state.lastSuggestions.find(
    (s) => s.sessionId === session.id
  );
  if (recently) {
    freshness -= 0.3; // small de-boost to avoid nagging
  }
  freshness = clamp01(freshness);
  reasons.push({ k: "freshness", v: round2(freshness) });

  // Guards: hard blocks → zero out or heavy penalty
  const guardPenalty = guardBlockPenalty(session, ctx);
  if (guardPenalty >= 1) {
    reasons.push({ k: "guardBlock", v: 1 });
    return { score: 0, reasons };
  }
  if (guardPenalty > 0) {
    reasons.push({ k: "guardPenalty", v: round2(guardPenalty) });
  }

  // Weighted sum → clamp
  let score =
    W.urgency * urgency +
    W.readiness * readiness +
    W.fitWindow * fitWindow +
    W.preference * preference +
    W.rotation * rotation +
    W.freshness * freshness;

  // Apply guard penalty multiplicatively
  score = clamp01(score * (1 - guardPenalty));

  return { score, reasons };
}

function guardBlockPenalty(session, ctx) {
  if (!state.config.enforceGuards) return 0;
  const guards = ctx.guardFlags || {};
  const isOutdoor =
    session?.meta?.outdoor === true || session?.domain === "garden";

  // Quiet hours: block noisy tasks (e.g., blender, vacuum, mower)
  const noisy =
    session?.meta?.noisy === true || hasAnchor(session, "appliance", "vacuum");
  if (guards.quiet && noisy) return 1;

  // Sabbath: block work-like tasks if enabled
  if (guards.sabbath && session?.domain !== "cooking") {
    // allow essential cooking with minimal prep; otherwise penalize
    const cookingEssential =
      session?.domain === "cooking" && session?.meta?.essential === true;
    if (!cookingEssential) return 1;
  }

  // Weather: if outdoor but weather guard says "indoor preferred", penalize
  if (guards.weather && isOutdoor && guards.weather.outdoorOk === false) {
    return 0.5;
  }

  return 0;
}

function hasAnchor(session, type, label) {
  return (session?.session?.anchors || []).some(
    (a) => a.type === type && (!label || a.label === label)
  );
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
function round2(x) {
  return Math.round(Number(x) * 100) / 100;
}

/**
 * Compute suggestions: returns sorted array of { sessionId, domain, title, score, reasons? }
 */
async function computeSuggestions() {
  const [ctx, sessions] = await Promise.all([
    buildContext(),
    loadCandidateSessions(),
  ]);
  state.lastContext = ctx;

  const scored = sessions.map((s) => {
    const { score, reasons } = scoreSession(s, ctx);
    return {
      sessionId: s.id,
      domain: s.domain,
      title: s.title || `${s.domain} session`,
      score,
      reasons: state.config.includeReasons ? reasons : undefined,
      window: s?.schedule?.window,
    };
  });

  // Sort & take top N
  const sorted = scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, state.config.maxSuggestions);

  // Update rotation memory (top pick domain gets marked)
  state.suggestionCounter += 1;
  if (sorted[0]) {
    state.rotationCounter.set(sorted[0].domain, state.suggestionCounter);
  }

  state.lastSuggestions = sorted;
  return sorted;
}

//// Auto-scheduling (optional) ////////////////////////////////////////////////

async function maybeAutoSchedule(suggestions) {
  if (!featureFlags?.nba?.autoSchedule) return;

  const winners = suggestions
    .filter((s) => s.score >= state.config.autoScheduleThreshold)
    .slice(0, state.config.maxAutoSchedulesPerCycle);

  for (const win of winners) {
    emit("automation.schedule.request", "engines/nextBestAction", {
      domain: win.domain,
      reason: "nba_high_score",
      sessionId: win.sessionId,
      preferredWindow: win.window || buildDefaultWindow(),
      priority: "high",
    });
  }

  if (winners.length) {
    exportToHubIfEnabled({
      domain: "nba",
      action: "auto_schedule_requests",
      payload: winners.map((w) => ({
        sessionId: w.sessionId,
        domain: w.domain,
        score: w.score,
      })),
    });
  }
}

function buildDefaultWindow() {
  const from = new Date();
  const to = new Date(Date.now() + state.config.lookaheadMinutes * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

//// Event-driven recompute ////////////////////////////////////////////////////

function markDirtyAndDebounce() {
  state.dirty = true;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    recomputeNow();
  }, state.config.debounceMs);
}

async function recomputeNow() {
  if (state.computing) return;
  state.computing = true;
  try {
    const suggestions = await computeSuggestions();

    emit("nba.suggestions.updated", "engines/nextBestAction", {
      suggestions: sanitize(suggestions),
      context: sanitize({
        availableWindowMinutes: state?.lastContext?.availableWindowMinutes,
        guardFlags: state?.lastContext?.guardFlags,
      }),
    });

    // Optional hub export (summarized)
    exportToHubIfEnabled({
      domain: "nba",
      action: "suggestions_updated",
      payload: {
        count: suggestions.length,
        top: suggestions[0]
          ? {
              sessionId: suggestions[0].sessionId,
              domain: suggestions[0].domain,
              score: suggestions[0].score,
            }
          : null,
      },
    });

    // Optional: auto schedule
    await maybeAutoSchedule(suggestions);

    state.dirty = false;
  } catch (err) {
    emit("engine.warning", "engines/nextBestAction", {
      message: "recompute failed",
      error: safeError(err),
    });
  } finally {
    state.computing = false;
  }
}

//// Public API ////////////////////////////////////////////////////////////////

/**
 * start(config)
 *  - Loads dependencies
 *  - Subscribes to signals that should trigger recomputation:
 *      • session created/updated in any domain
 *      • inventory changes / shortages
 *      • harvests / preservation completions
 *      • imports delivering sessions or meal plans
 *      • schedule results (accept/reject) to update rotation memory
 *  - Emits "engine.started"
 */
export async function start(config = {}) {
  if (state.initialized) return;

  state.config = { ...state.config, ...config };

  const [evb, ff, sess, prefs, guards, inv, weather, cal, hubFmt, hubConn] =
    await Promise.all([
      softImport("../services/events/eventBus.js"),
      softImport("@/config/featureFlags.json"),
      softImport("../stores/SessionStore.js"),
      softImport("../services/HouseholdPrefs.js"),
      softImport("../services/guards/policies.js"),
      softImport("../domain/inventory/InventoryService.js"),
      softImport("../services/WeatherService.js"),
      softImport("../services/CalendarService.js"),
      softImport("@/services/hub/HubPacketFormatter.js"),
      softImport("@/services/hub/FamilyFundConnector.js"),
    ]);

  eventBus = evb?.default || evb || eventBus;
  featureFlags = ff?.default || ff || featureFlags;
  SessionStore = sess?.default || sess || SessionStore;
  HouseholdPrefs = prefs?.default || prefs || HouseholdPrefs;
  GuardPolicies = guards?.default || guards || GuardPolicies;
  InventoryService = inv?.default || inv || InventoryService;
  WeatherService = weather?.default || weather || WeatherService;
  CalendarService = cal?.default || cal || CalendarService;
  HubPacketFormatter = hubFmt?.default || hubFmt || HubPacketFormatter;
  FamilyFundConnector = hubConn?.default || hubConn || FamilyFundConnector;

  if (!eventBus?.on || !eventBus?.emit) {
    throw new Error(
      "nextBestAction requires a functional eventBus with on/emit."
    );
  }

  // --- Session creation/update events (multi-domain) ---
  const sessionEvents = [
    "cooking.session.created",
    "cleaning.session.created",
    "garden.session.created",
    "animal.session.created",
    "preservation.session.created",
    "storehouse.session.created",
    // Updates from runtimes
    "cooking.session.updated",
    "cleaning.session.updated",
    "garden.session.updated",
    "animal.session.updated",
    "preservation.session.updated",
    "storehouse.session.updated",
  ];
  sessionEvents.forEach((evtName) =>
    eventBus.on(evtName, markDirtyAndDebounce)
  );

  // --- Inventory and shortages ---
  eventBus.on("inventory.updated", markDirtyAndDebounce);
  eventBus.on("inventory.shortage.detected", markDirtyAndDebounce);

  // --- Garden & preservation completions / harvests ---
  eventBus.on("garden.harvest.logged", markDirtyAndDebounce);
  eventBus.on("preservation.completed", markDirtyAndDebounce);

  // --- Imports that may introduce sessions or meal plans ---
  eventBus.on("import.parsed", (evt) => {
    const d = evt?.data;
    // If meals/plan or any domain imports, recompute
    if (
      d?.domain &&
      (d?.type === "plan" || d?.type === "session" || d?.type === "harvest")
    ) {
      markDirtyAndDebounce();
    }
  });

  // --- Schedule outcomes (helps rotation/freshness) ---
  eventBus.on("automation.schedule.result", (evt) => {
    // evt.data: { sessionId, status: "scheduled"|"rejected"|"failed" }
    const status = evt?.data?.status;
    const sessionId = evt?.data?.sessionId;
    if (status === "scheduled" && SessionStore?.getById) {
      SessionStore.getById(sessionId)
        .then((s) => {
          if (s?.domain) {
            state.rotationCounter.set(s.domain, state.suggestionCounter);
          }
        })
        .catch(() => {});
    }
    markDirtyAndDebounce();
  });

  state.initialized = true;

  emit("engine.started", "engines/nextBestAction", {
    config: sanitize(state.config),
    degraded: {
      sessions: !SessionStore,
      prefs: !HouseholdPrefs,
      guards: !GuardPolicies,
      inventory: !InventoryService,
      weather: !WeatherService,
      calendar: !CalendarService,
    },
  });

  // initial compute
  markDirtyAndDebounce();
}

/**
 * suggestNow()
 *  - Manual trigger to compute and emit suggestions immediately.
 */
export async function suggestNow() {
  if (!state.initialized) await start();
  await recomputeNow();
  return { ok: true, suggestions: sanitize(state.lastSuggestions) };
}

/**
 * getLastSuggestions()
 *  - Read-only accessor for UI components without forcing recompute.
 */
export function getLastSuggestions() {
  return sanitize(state.lastSuggestions) || [];
}

export default {
  start,
  suggestNow,
  getLastSuggestions,
};
