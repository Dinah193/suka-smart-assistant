/* -----------------------------------------------------------------------------
   agentsWorker.js  —  Background Reasoner / Orchestrator Delegator (Web Worker)

   Project: Suka Smart Assistant - Household Management System

   What this does now:
   - Provides a background queue with priorities + cancellation.
   - Auto-registers templates using src/services/automation/autoRegisterTemplates.js.
   - For “AI work”, it no longer imports agents directly.
     Instead, it DELEGATES to your Reasoner / Orchestrator / Shims layer by
     emitting REASONER_REQUEST messages while still returning a RESULT payload
     to the caller (delegated: true).
   - Still emits PROGRESS / LOG / ERROR in a consistent format.

   Message Protocol (Main <-> Worker)
   ----------------------------------
   Inbound (to Worker):
     { id, type: "INIT", payload?: { preload?: string[] } }
     { id, type: "REGISTER_TEMPLATES", payload?: { dirs?: string[], exclude?: string[] } }
     { id, type: "RUN_AGENT", payload: { name, input, options? } }          // now delegates to Reasoner
     { id, type: "GENERATE_SESSIONS", payload: { scope?, opts? } }          // delegates + worker fallback
     { id, type: "CONSOLIDATE_RECIPES", payload: { planId?, window? } }     // delegates
     { id, type: "APPROVE_SESSION", payload: { draftId, calendar? } }       // delegates + worker fallback
     { id, type: "CANCEL", payload: { taskId } }
     { id, type: "PING" }
     { id, type: "SHUTDOWN" }

   Outbound (from Worker):
     { id, type: "READY", data: { ts } }
     { id, type: "LOG", data: { level, msg, meta? } }
     { id, type: "PROGRESS", data: { taskId, phase, pct } }
     { id, type: "RESULT", data: { taskId, result } }
     { id, type: "ERROR",  data: { taskId, message, stack? } }

   NEW outbound for Reasoner delegation:
     { id, type: "REASONER_REQUEST", data: { taskId, topic, payload } }

   The main thread can listen for REASONER_REQUEST and then call your
   Reasoner/Orchestrator/Shims setup (e.g. window.__suka.reasoner.query, etc.).
----------------------------------------------------------------------------- */

/* ------------------------------ Environment Utils ------------------------------ */
const IS_BROWSER = typeof window === "undefined" && typeof self !== "undefined";
const IS_NODE =
  typeof process !== "undefined" &&
  process.versions &&
  process.versions.node &&
  typeof self === "undefined";

const now = () => Date.now();
const safeJSON = (v) => {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return v;
  }
};

/* ------------------------------ X-thread Messaging ----------------------------- */
// In a Worker, postMessage is global; in Node worker_threads we shim.
let _postMessage = (msg) => {
  // eslint-disable-next-line no-undef
  if (typeof postMessage === "function") postMessage(msg);
};
if (IS_NODE) {
  try {
    // eslint-disable-next-line node/no-unsupported-features/node-builtins
    const { parentPort } = require("node:worker_threads");
    if (parentPort) {
      _postMessage = (msg) => parentPort.postMessage(msg);
      parentPort.on("message", (msg) => {
        try {
          onCommand(msg);
        } catch (e) {
          sendError(msg?.id ?? null, e);
        }
      });
    }
  } catch {}
}

/* ------------------------------ Task Registry ---------------------------------- */
const tasks = new Map(); // taskId -> controller
const queue = [];
let processing = false;

const PRIORITY = {
  HIGH: 0,
  NORMAL: 1,
  LOW: 2,
};

function enqueue(task) {
  queue.push(task);
  queue.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
  pump();
}

async function pump() {
  if (processing) return;
  processing = true;
  try {
    while (queue.length) {
      const task = queue.shift();
      if (!task) break;
      if (task.controller?.canceled) continue;
      try {
        sendProgress(task.id, "started", 1);
        const result = await task.run(task.controller);
        if (!task.controller?.canceled) {
          sendResult(task.id, result);
        }
      } catch (err) {
        sendError(task.id, err);
      }
    }
  } finally {
    processing = false;
  }
}

/* ------------------------------ Cancelation Token ------------------------------ */
class TaskController {
  constructor(id) {
    this.id = id;
    this.canceled = false;
    this.abort = new AbortController();
    this.signal = this.abort.signal;
  }
  cancel() {
    this.canceled = true;
    this.abort.abort();
  }
}

/* ------------------------------ Debounce Coalescing ---------------------------- */
const coalesce = (() => {
  const pending = new Map(); // key -> { timer, resolvers[] }
  return function (key, fn, ms = 50) {
    return new Promise((resolve, reject) => {
      const entry = pending.get(key) || { resolvers: [], timer: null };
      entry.resolvers.push({ resolve, reject, fn });
      clearTimeout(entry.timer);
      entry.timer = setTimeout(async () => {
        const batch = pending.get(key);
        pending.delete(key);
        try {
          const out = await fn();
          batch.resolvers.forEach((r) => r.resolve(out));
        } catch (e) {
          batch.resolvers.forEach((r) => r.reject(e));
        }
      }, ms);
      pending.set(key, entry);
    });
  };
})();

/* ------------------------------ Progress / Results ----------------------------- */
function send(type, id, data) {
  _postMessage({ id, type, data });
}
function sendReady(id) {
  send("READY", id, { ts: now() });
}
function sendLog(level, msg, meta) {
  send("LOG", null, { level, msg, meta });
}
function sendProgress(id, phase, pct) {
  send("PROGRESS", id, { taskId: id, phase, pct });
}
function sendResult(id, result) {
  send("RESULT", id, { taskId: id, result: safeJSON(result) });
}
function sendError(id, error) {
  const payload =
    error && error.message
      ? { message: error.message, stack: error.stack }
      : { message: String(error) };
  send("ERROR", id, { taskId: id, ...payload });
}

/* ------------------------------ Dynamic Imports --------------------------------
   Only for non-AI helpers (templates, stores). AI work is delegated.
---------------------------------------------------------------------------------*/
async function autoRegisterTemplates(dirs, exclude) {
  const mod = await import(
    /* @vite-ignore */ "@/services/automation/autoRegisterTemplates.js"
  );
  const fn =
    mod.default || mod.autoRegisterTemplates || mod.registerTemplates || mod;
  if (typeof fn !== "function") {
    throw new Error("autoRegisterTemplates: exported function not found.");
  }
  return await fn({ dirs, exclude });
}

async function maybeLoadStores() {
  // NOTE: kept for future use if any delegated tasks need store snapshots.
  const out = {};
  try {
    out.CookingStore = (
      await import(/* @vite-ignore */ "@/store/CookingStore.js")
    ).default;
  } catch {}
  try {
    out.InventoryStore = (
      await import(/* @vite-ignore */ "@/store/InventoryStore.js")
    ).default;
  } catch {}
  try {
    out.IngredientsIndex = (
      await import(/* @vite-ignore */ "@/store/IngredientsIndex.js")
    ).default;
  } catch {}
  try {
    out.HouseholdCalendarStore = (
      await import(/* @vite-ignore */ "@/store/HouseholdCalendarStore.js")
    ).useHouseholdCalendar;
  } catch {}
  try {
    out.RecipeStore = (
      await import(/* @vite-ignore */ "@/store/RecipeStore.js")
    ).default;
  } catch {}
  try {
    out.MealPlanStore = (
      await import(/* @vite-ignore */ "@/store/MealPlanStore.js")
    ).default;
  } catch {}
  return out;
}

/* ------------------------------ Cooking Draft Fallback ------------------------- */
/**
 * Build a minimal but usable cooking session draft entirely in the worker.
 * This is the "oh my gosh just give me a draft" path so the UI never hangs
 * even if the Reasoner layer is not wired up yet.
 */
function buildCookingDraftFromPayload(payload) {
  const opts = payload?.opts || {};
  const windowRange = opts.consolidation?.window || null;
  const includeTags = Array.isArray(opts.consolidation?.includeTags)
    ? opts.consolidation.includeTags
    : [];
  const preferences = opts.cooking?.preferences || {};

  const title =
    preferences.title ||
    opts.title ||
    (windowRange
      ? `Cooking ${windowRange.start || ""} → ${windowRange.end || ""}`
      : "Cooking Session");

  const cuisines = Array.isArray(preferences.cuisines)
    ? preferences.cuisines
    : [];
  const proteins = Array.isArray(preferences.proteins)
    ? preferences.proteins
    : [];
  const equipment = Array.isArray(preferences.equipment)
    ? preferences.equipment
    : [];

  const id = `draft_worker_${Date.now()}`;

  const stations = (equipment.length ? equipment : ["Stovetop", "Oven"])
    .slice(0, 4)
    .map((e, i) => ({
      key: e.toLowerCase().replace(/\s+/g, "-"),
      label: e,
      tools: [],
      order: i + 1,
    }));

  const steps = [];
  const totalRecipes = Math.max(2, Math.min(6, proteins.length || 3));

  for (let i = 0; i < totalRecipes; i += 1) {
    const cuisine =
      cuisines[i % Math.max(1, cuisines.length)] || "Balanced Meal";
    const protein = proteins[i % Math.max(1, proteins.length)] || "Protein";
    const station = stations[i % stations.length];

    steps.push({
      id: `${id}_step_${i + 1}`,
      label: `${cuisine} ${protein} prep`,
      station: station.label,
      stationKey: station.key,
      estMin: 10 + (i % 3) * 5,
      done: false,
    });

    steps.push({
      id: `${id}_step_${i + 1}_cook`,
      label: `Cook ${protein} (${cuisine})`,
      station: station.label,
      stationKey: station.key,
      estMin: 15 + (i % 4) * 5,
      done: false,
    });
  }

  const timers = steps
    .filter((s) => /Cook/.test(s.label))
    .slice(0, 3)
    .map((s, i) => ({
      id: `${id}_tm_${i + 1}`,
      label: s.label.replace("Cook ", ""),
      station: s.station,
      seconds: 5 * 60 + i * 120,
      startedAt: null,
      running: false,
    }));

  return {
    id,
    title,
    createdAt: new Date().toISOString(),
    window: windowRange,
    selection: [],
    stations,
    steps,
    timers,
    inventory: {
      pulls: [],
      missing: [],
    },
    metrics: {
      totalRecipes,
      estMinutes: steps.reduce((acc, s) => acc + (s.estMin || 0), 0),
      includeTags,
    },
    preferences,
    draftType: "cooking",
    source: "worker-fallback",
  };
}

/* ------------------------------ Reasoner Delegation ---------------------------- */
/**
 * Generic delegator for anything that used to be an "agent".
 * We:
 *  - emit a REASONER_REQUEST event to the main thread
 *  - log what we did
 *  - return a trivial { delegated: true } result so the caller's Promise resolves
 *
 * The main thread can listen for "REASONER_REQUEST" and call your
 * Reasoner/Orchestrator/Shims (e.g. window.__suka.reasoner.query, etc.)
 * using the provided topic + payload.
 */
async function runReasonerDelegatedTask(taskId, topic, payload, controller) {
  if (controller?.canceled) return { canceled: true };

  const enveloped = {
    taskId,
    topic,
    payload: safeJSON(payload || {}),
  };

  _postMessage({
    id: taskId,
    type: "REASONER_REQUEST",
    data: enveloped,
  });

  sendLog("info", "Delegated task to Reasoner", {
    taskId,
    topic,
  });

  // This is what the calling code receives via RESULT.
  return {
    ok: true,
    delegated: true,
    topic,
  };
}

/* ------------------------------ Core Pipelines (delegated) -------------------- */
async function runAgentTask(taskId, name, input, options, controller) {
  // Old RUN_AGENT → Reasoner topic: "agent:<name>"
  return runReasonerDelegatedTask(
    taskId,
    `agent:${name || "unknown"}`,
    { input, options },
    controller
  );
}

async function consolidateRecipesTask(taskId, payload, controller) {
  // Optionally snapshot stores for the reasoner in the future:
  // const stores = await maybeLoadStores().catch(() => ({}));
  return runReasonerDelegatedTask(
    taskId,
    "recipes.consolidate",
    { payload }, // + optionally { stores }
    controller
  );
}

async function generateSessionsTask(taskId, payload, controller) {
  await coalesce("GENERATE_SESSIONS", async () => {}, 40);
  if (controller?.canceled) return { canceled: true };

  const scope = payload?.scope ?? "all";
  const opts = payload?.opts ?? {};

  // 1) Build an immediate worker-side cooking draft so the UI never hangs.
  const draft = buildCookingDraftFromPayload({ scope, opts });

  // 2) Tell the UI that the draft is ready.
  sendProgress(taskId, "draft:cooking:worker", 100);

  _postMessage({
    id: taskId,
    type: "DRAFT_READY",
    data: {
      draft,
      draftType: "cooking",
    },
  });

  // 3) Still delegate to the Reasoner for richer refinement (non-blocking).
  const delegatedRes = await runReasonerDelegatedTask(
    taskId,
    "sessions.generate",
    { scope, opts, draftId: draft.id },
    controller
  );

  // 4) Return a combined result so callers get both the delegation info and
  //    the worker-generated draft id.
  return {
    ...delegatedRes,
    draftId: draft.id,
    draftSource: "worker-fallback",
  };
}

async function approveSessionTask(taskId, payload, controller) {
  const { draftId, calendar } = payload || {};
  if (!draftId) {
    throw new Error("approveSession: missing draftId");
  }
  if (controller?.canceled) return { canceled: true };

  // 1) Local fallback: generate a stub calendar event id so callers get a value.
  const eventId = `cal_${Date.now()}`;
  sendProgress(taskId, "session.approve:worker", 100);

  _postMessage({
    id: taskId,
    type: "SESSION_APPROVED",
    data: { draftId, calendar, eventId },
  });

  // 2) Also delegate to the Reasoner so it can sync with a real calendar later.
  const delegatedRes = await runReasonerDelegatedTask(
    taskId,
    "sessions.approve",
    { draftId, calendar, eventId },
    controller
  );

  return {
    ...delegatedRes,
    eventId,
    draftId,
  };
}

/* ------------------------------ Command Router -------------------------------- */
function scheduleTask(id, priority, run) {
  const controller = new TaskController(id);
  tasks.set(id, controller);
  enqueue({ id, priority, enqueuedAt: now(), run, controller });
}

async function onCommand(msg) {
  const { id, type, payload } = msg || {};
  if (!id) return; // we expect correlation id from the main thread

  switch (type) {
    case "INIT": {
      sendReady(id);
      // preload is a no-op now; we don't have agents to preload, but we keep
      // the shape so callers don't break.
      if (payload?.preload?.length) {
        scheduleTask(id + ":preload", PRIORITY.LOW, async () => {
          return { ok: true, preloaded: payload.preload, delegated: true };
        });
      }
      break;
    }

    case "REGISTER_TEMPLATES": {
      scheduleTask(id, PRIORITY.HIGH, async () => {
        const dirs = payload?.dirs ?? ["src/services/templates"];
        const exclude = payload?.exclude ?? [
          "**/triggers/**",
          "**/__fixtures__/**",
          "**/*.d.ts",
        ];
        const res = await autoRegisterTemplates(dirs, exclude);
        return {
          ok: true,
          registered: Array.isArray(res) ? res.length : undefined,
        };
      });
      break;
    }

    case "RUN_AGENT": {
      scheduleTask(id, PRIORITY.NORMAL, (ctl) =>
        runAgentTask(id, payload?.name, payload?.input, payload?.options, ctl)
      );
      break;
    }

    case "CONSOLIDATE_RECIPES": {
      scheduleTask(id, PRIORITY.NORMAL, (ctl) =>
        consolidateRecipesTask(id, payload, ctl)
      );
      break;
    }

    case "GENERATE_SESSIONS": {
      scheduleTask(id, PRIORITY.HIGH, (ctl) =>
        generateSessionsTask(id, payload, ctl)
      );
      break;
    }

    case "APPROVE_SESSION": {
      scheduleTask(id, PRIORITY.HIGH, (ctl) =>
        approveSessionTask(id, payload, ctl)
      );
      break;
    }

    case "CANCEL": {
      const taskId = payload?.taskId;
      const ctl = tasks.get(taskId);
      if (ctl) ctl.cancel();
      sendResult(id, { ok: true, canceled: !!ctl, taskId });
      break;
    }

    case "PING": {
      send("RESULT", id, { taskId: id, pong: true, ts: now() });
      break;
    }

    case "SHUTDOWN": {
      for (const [, ctl] of tasks) ctl.cancel();
      send("RESULT", id, { ok: true, shuttingDown: true });
      if (IS_BROWSER) {
        // eslint-disable-next-line no-undef
        close();
      } else if (IS_NODE) {
        // eslint-disable-next-line node/no-unsupported-features/node-builtins
        const { exit } = require("node:process");
        exit(0);
      }
      break;
    }

    default:
      sendError(id, new Error(`Unknown command: ${type}`));
  }
}

/* ------------------------------ Global Message Hook --------------------------- */
// Browser Worker global
if (IS_BROWSER) {
  // eslint-disable-next-line no-undef
  self.onmessage = (ev) => {
    try {
      onCommand(ev.data);
    } catch (e) {
      sendError(ev?.data?.id ?? null, e);
    }
  };
}

/* ------------------------------ Boot Echo ------------------------------------- */
sendLog("info", "agentsWorker (reasoner-delegator) booted", {
  ts: now(),
  mode: IS_BROWSER ? "webworker" : IS_NODE ? "node-worker" : "unknown",
});

/* -----------------------------------------------------------------------------
   NOTE FOR MAIN THREAD

   You can keep using your existing shimsClient wrapper; it will still receive
   RESULT / ERROR / PROGRESS events.

   To actually hook up the Reasoner/Orchestrator/Shims, also listen for
   "REASONER_REQUEST" messages from the worker:

   worker.onmessage = (ev) => {
     const { id, type, data } = ev.data || {};
     if (type === "REASONER_REQUEST") {
       const { taskId, topic, payload } = data;
       // e.g. window.__suka?.reasoner?.query(topic, payload)
       // and optionally emit your own events / updates.
       return;
     }
     // ...existing RESULT / ERROR / PROGRESS handling...
   };

----------------------------------------------------------------------------- */
