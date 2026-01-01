// src/agents/shims/cookingSessionShim.js
// -----------------------------------------------------------------------------
// CookingSessionShim
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

// Always import the primary/shared event bus the Cooking page uses
import eventBus from "@/services/events/eventBus.js";

// Static imports so Vite can resolve aliases correctly
import * as dbModule from "@/db";
import * as CookingEngineModule from "@/services/session/CookingSessionEngine.js";
import * as SessionRunnerModule from "@/services/session/SessionRunner.js";
import featureFlags from "@/config/featureFlags.json";
import * as hubExportModule from "@/services/hub/exportToHubIfEnabled.js";

const SHIM_SOURCE = "CookingSessionShim";
const isBrowser = typeof window !== "undefined";

/* -------------------------------------------------------------------------- */
/* Event bus bridge (ensure we share the same instance as UI pages)           */
/* -------------------------------------------------------------------------- */

// Expose the bus on window so any other surfaces can reuse the same instance
if (isBrowser) {
  if (!window.__suka) window.__suka = {};
  if (!window.__suka.eventBus) {
    window.__suka.eventBus = eventBus;
  }
}

/* -------------------------------------------------------------------------- */
/* 🔧 Tap into eventBus.emit so we ALWAYS see mealplan.draft.requested         */
/* -------------------------------------------------------------------------- */

if (
  eventBus &&
  typeof eventBus.emit === "function" &&
  !eventBus.__cookingShimPatched
) {
  const originalEmit = eventBus.emit.bind(eventBus);

  eventBus.emit = function patchedEmit(type, payload, meta) {
    if (type === "mealplan.draft.requested") {
      if (import.meta.env.DEV) {
        console.info(
          `[${SHIM_SOURCE}] tapped eventBus.emit("mealplan.draft.requested")`,
          payload
        );
      }
      try {
        // Normalize into the envelope shape this shim expects
        handleMealplanDraftRequested({
          type,
          ts: new Date().toISOString(),
          source: meta?.source || "cooking.index",
          data: payload || {},
        });
      } catch (err) {
        console.warn(`[${SHIM_SOURCE}] patched emit handler error:`, err);
      }
    }

    return originalEmit(type, payload, meta);
  };

  Object.defineProperty(eventBus, "__cookingShimPatched", {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  if (import.meta.env.DEV) {
    console.info(`[${SHIM_SOURCE}] eventBus.emit patched for mealplan drafts`);
  }
}

/* -------------------------------------------------------------------------- */
/* Lazy wrappers around statically imported modules                           */
/* -------------------------------------------------------------------------- */

let engineInstancePromise = null;
let runnerModulePromise = null;
let dbPromise = null;
let featureFlagsPromise = null;
let hubExportPromise = null;

async function getCookingEngine() {
  if (!engineInstancePromise) {
    engineInstancePromise = (async () => {
      const mod = CookingEngineModule || {};
      const engine =
        typeof mod.generateCookingSessionFromDraft === "function" ||
        typeof mod.generateCookingSession === "function"
          ? mod
          : null;

      if (!engine) {
        console.warn(
          `[${SHIM_SOURCE}] CookingSessionEngine missing expected exports`
        );
      }

      return engine;
    })();
  }
  return engineInstancePromise;
}

async function getSessionRunner() {
  if (!runnerModulePromise) {
    runnerModulePromise = Promise.resolve(SessionRunnerModule || null);
  }
  return runnerModulePromise;
}

async function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      try {
        const resolved = dbModule.default || dbModule;
        return resolved || null;
      } catch (err) {
        console.warn(`[${SHIM_SOURCE}] failed to resolve db module:`, err);
        return null;
      }
    })();
  }
  return dbPromise;
}

async function getFeatureFlags() {
  if (!featureFlagsPromise) {
    featureFlagsPromise = Promise.resolve(featureFlags || {});
  }
  return featureFlagsPromise;
}

async function getHubExporter() {
  if (!hubExportPromise) {
    hubExportPromise = Promise.resolve(hubExportModule || null);
  }
  return hubExportPromise;
}

/* -------------------------------------------------------------------------- */
/* Normalizers                                                                */
/* -------------------------------------------------------------------------- */

function normalizeMealplanPayload(raw = {}) {
  const mealPlan = raw.mealPlan || raw.plan || raw;
  const windowStart = raw.windowStart || mealPlan?.windowStart;
  const windowEnd = raw.windowEnd || mealPlan?.windowEnd;

  const meals = Array.isArray(mealPlan?.meals) ? mealPlan.meals : [];

  const recipes = meals.map((m) => ({
    id: m.id || m.key || undefined,
    title: m.title || m.name || "Meal",
    ingredients: m.ingredients || m.items || [],
    cookTimeMin: m.cookTimeMin || m.timeMin || undefined,
    bakeTimeMin: m.bakeTimeMin || undefined,
    pressureTimeMin: m.pressureTimeMin || undefined,
    servings: m.servings || m.portions || undefined,
  }));

  return {
    date: windowStart || new Date().toISOString(),
    recipes,
    batch: true,
    notes: mealPlan?.notes || "",
    adjacency: mealPlan?.adjacency || null,
    rawMealPlan: mealPlan,
    window: { start: windowStart, end: windowEnd },
  };
}

function extractSessionFromEnvelope(envelope = {}) {
  const data = envelope.data ?? envelope;
  const session = data.session || data.payload?.session || null;
  const sessionId = data.sessionId || session?.id || data.id || null;
  return { session, sessionId };
}

/* -------------------------------------------------------------------------- */
/* Core handlers                                                              */
/* -------------------------------------------------------------------------- */

async function handleMealplanDraftRequested(envelope) {
  console.info(
    `[${SHIM_SOURCE}] handleMealplanDraftRequested`,
    (() => {
      try {
        return JSON.parse(JSON.stringify(envelope ?? {}));
      } catch {
        return envelope;
      }
    })()
  );

  const engine = await getCookingEngine();
  if (!engine || typeof engine.generateCookingSessionFromDraft !== "function") {
    softToast(
      "error",
      "Cooking engine unavailable",
      "Unable to generate a cooking session right now."
    );
    return;
  }

  try {
    const payload = envelope?.data || envelope || {};
    const norm = normalizeMealplanPayload(payload);

    const session = await engine.generateCookingSessionFromDraft({
      householdId: payload.householdId || "primary",
      title: payload.title || "Cooking Session",
      windowStart: norm.window.start,
      windowEnd: norm.window.end,
      plan: norm.rawMealPlan,
      context: {
        recipes: norm.recipes,
        notes: norm.notes,
      },
    });

    try {
      const db = await getDb();
      const dbResolved = db?.default || db;
      if (dbResolved?.sessions?.put) {
        await dbResolved.sessions.put({
          ...session,
          status: session.status || "draft",
          updatedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn(`[${SHIM_SOURCE}] failed to persist draft session:`, err);
    }

    eventBus.emit(
      "cooking.session.draft.ready",
      {
        session,
        mealPlan: norm.rawMealPlan,
        window: norm.window,
        ts: new Date().toISOString(),
      },
      { source: SHIM_SOURCE }
    );

    eventBus.emit(
      "session.draft.ready",
      {
        session,
        ts: new Date().toISOString(),
      },
      { source: SHIM_SOURCE }
    );

    if (import.meta.env.DEV) {
      console.info(`[${SHIM_SOURCE}] draft generated`, {
        id: session?.id,
        status: session?.status,
        domain: session?.domain,
        window: norm.window,
      });
    }
  } catch (err) {
    console.warn(
      `[${SHIM_SOURCE}] failed to build session from meal plan:`,
      err
    );
    softToast(
      "error",
      "Couldn’t generate cooking session",
      err?.message || "Something went wrong while building the cooking session."
    );
  }
}

async function handleCookingRequestNow(envelope) {
  const db = await getDb();
  const dbResolved = db?.default || db;
  const { session: explicitSession, sessionId: explicitId } =
    extractSessionFromEnvelope(envelope);

  let session = explicitSession || null;
  let sessionId = explicitId || null;

  try {
    if (!session && dbResolved?.sessions) {
      if (explicitId && typeof dbResolved.sessions.get === "function") {
        session = await dbResolved.sessions.get(explicitId);
      }

      if (!session && typeof dbResolved.sessions.where === "function") {
        const candidates = await dbResolved.sessions
          .where("domain")
          .equals("cooking")
          .and((s) => s && ["running", "scheduled", "draft"].includes(s.status))
          .toArray();

        candidates.sort((a, b) => {
          const score = (s) =>
            s.status === "running" ? 3 : s.status === "scheduled" ? 2 : 1;
          const diff = score(b) - score(a);
          return diff !== 0
            ? diff
            : new Date(b.updatedAt || b.createdAt || 0) -
                new Date(a.updatedAt || a.createdAt || 0);
        });

        session = candidates[0] || null;
      }
    }

    if (!session) {
      softToast(
        "info",
        "No cooking session ready",
        "Create a Cooking Session from your Meal Plan first, then tap Now again."
      );
      return;
    }

    sessionId = session.id;

    try {
      if (dbResolved?.sessions?.put) {
        await dbResolved.sessions.put({
          ...session,
          status: "running",
          updatedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn(`[${SHIM_SOURCE}] failed to mark session running:`, err);
    }

    const Runner = await getSessionRunner();
    if (!Runner || (!Runner.run && !Runner.ensureHost)) {
      softToast(
        "error",
        "Session runner unavailable",
        "The Session Runner module is not ready, so this cooking session can’t be started yet."
      );
      return;
    }

    if (typeof Runner.ensureHost === "function") {
      try {
        await Runner.ensureHost();
      } catch (err) {
        console.warn(`[${SHIM_SOURCE}] ensureHost failed:`, err);
      }
    }

    if (typeof Runner.run === "function") {
      await Runner.run({
        domain: "cooking",
        sessionId,
        resume: session.status === "running",
        source: SHIM_SOURCE,
      });

      eventBus.emit(
        "session.run.requested",
        {
          domain: "cooking",
          sessionId,
          ts: new Date().toISOString(),
        },
        { source: SHIM_SOURCE }
      );
    } else {
      console.warn(`[${SHIM_SOURCE}] Runner.run not available`);
    }
  } catch (err) {
    console.warn(`[${SHIM_SOURCE}] handleCookingRequestNow error:`, err);
    softToast(
      "error",
      "Unable to start session",
      err?.message ||
        "Something went wrong while starting your cooking session."
    );
  }
}

async function handleSessionTerminalEvent(envelope, status) {
  const data = envelope?.data || envelope || {};
  const session = data.session || null;
  if (!session || session.domain !== "cooking") return;

  try {
    const db = await getDb();
    const dbResolved = db?.default || db;
    if (dbResolved?.sessions?.put) {
      await dbResolved.sessions.put({
        ...session,
        status,
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.warn(`[${SHIM_SOURCE}] failed to persist terminal status:`, err);
  }

  try {
    const flags = await getFeatureFlags();
    const familyFundMode = !!flags.familyFundMode;
    if (!familyFundMode) return;

    const hubExport = await getHubExporter();
    const exportToHubIfEnabled =
      hubExport?.exportToHubIfEnabled || hubExport?.default || null;
    if (typeof exportToHubIfEnabled !== "function") return;

    await exportToHubIfEnabled({
      type: "session.analytics",
      domain: "cooking",
      status,
      session,
      ts: new Date().toISOString(),
      source: SHIM_SOURCE,
    });

    eventBus.emit(
      "session.exported",
      {
        domain: "cooking",
        status,
        sessionId: session.id,
        ts: new Date().toISOString(),
      },
      { source: SHIM_SOURCE }
    );
  } catch (err) {
    console.warn(`[${SHIM_SOURCE}] Hub export failed:`, err);
  }
}

/* -------------------------------------------------------------------------- */
/* Toast helper                                                               */
/* -------------------------------------------------------------------------- */

function softToast(variant, title, message) {
  try {
    eventBus.emit(
      "ui.toast",
      {
        variant,
        title,
        message,
        ts: new Date().toISOString(),
      },
      { source: SHIM_SOURCE }
    );
  } catch (err) {
    if (isBrowser) {
      console.log(`[${variant}] ${title}: ${message}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Resume on boot                                                             */
/* -------------------------------------------------------------------------- */

async function autoResumeCookingSessionIfNeeded() {
  try {
    const db = await getDb();
    const dbResolved = db?.default || db;
    if (!dbResolved?.sessions?.where) return;

    const running = await dbResolved.sessions
      .where("domain")
      .equals("cooking")
      .and((s) => s && s.status === "running")
      .toArray();

    if (!running.length) return;
    const latest = running.sort(
      (a, b) =>
        new Date(b.updatedAt || b.createdAt || 0) -
        new Date(a.updatedAt || a.createdAt || 0)
    )[0];

    const Runner = await getSessionRunner();
    if (!Runner || !Runner.run) return;

    if (typeof Runner.ensureHost === "function") {
      await Runner.ensureHost();
    }

    await Runner.run({
      domain: "cooking",
      sessionId: latest.id,
      resume: true,
      source: `${SHIM_SOURCE}.autoResume`,
    });
  } catch (err) {
    console.warn(`[${SHIM_SOURCE}] auto-resume failed:`, err);
  }
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

export function bootstrapCookingSessionShim() {
  if (bootstrapCookingSessionShim._bootstrapped) return;
  bootstrapCookingSessionShim._bootstrapped = true;

  // Keep these for non-mealplan events
  eventBus.on("cooking/session/requestNow", handleCookingRequestNow);

  eventBus.on("session.completed", (env) =>
    handleSessionTerminalEvent(env, "completed")
  );
  eventBus.on("session.aborted", (env) =>
    handleSessionTerminalEvent(env, "aborted")
  );

  if (isBrowser) {
    autoResumeCookingSessionIfNeeded();
  }

  console.info(`[${SHIM_SOURCE}] bootstrapped`);
}
