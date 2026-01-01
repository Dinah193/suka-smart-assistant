// C:\Users\larho\suka-smart-assistant\src\services\nbaOrchestrator.js
//
// nbaOrchestrator
// ----------------
// Central “Next Best Action” (NBA) engine for Suka Smart Assistant.
//
// Role in the pipeline
// --------------------
// imports → intelligence → automation → (optional) hub export
//
// • imports:
//   - Upstream modules emit events like `session.generated`,
//     `inventory.shortage.detected`, `garden.harvest.logged`, etc.
//   - Automation/runtime or UI passes a context object when it wants
//     explicit “what should we do next?” suggestions.
//
// • intelligence (THIS FILE):
//   - Maintains a registry of templates (named NBA strategies).
//   - Given an event or an explicit context, calls the appropriate template(s)
//     and returns **suggestions** (e.g. “schedule batch cooking session”,
//     “start freezer inventory audit”, “plan restock for feed”).
//
// • automation:
//   - Consumers (automation runtime, dashboards, NBAToolbar, etc.) listen
//     for `nba.suggestions.created` events or call `suggestForEvent`/
//     `suggestAll` directly and then decide whether to:
//       • create sessions (cooking/cleaning/garden/animals/preservation),
//       • update inventory or storehouse,
//       • or just show recommendations to the user.
//   - Those *other* modules own the actual household data mutations.
//
// • optional hub export:
//   - Because this file only produces **suggestions** and does not itself
//     mutate inventory / storehouse / sessions, it does **not** export
//     directly to the Hub. The modules that act on suggestions (e.g.
//     SessionEngines, Inventory service) remain responsible for that.
//

import eventBus from "./events/eventBus";

// Optional: Dexie-backed queue for persistent NBA suggestions.
// If `db.nbaQueue` does not exist, we simply operate in-memory.
import db from "./db";

/**
 * @typedef {Object} NbaSuggestion
 * @property {string} id          - Unique suggestion id.
 * @property {string} template    - Name of the template that produced it.
 * @property {string} kind        - “session|inventory|storehouse|info|alert|other”.
 * @property {string} title       - Short human-readable title.
 * @property {string} [message]   - Longer description / explanation.
 * @property {any} [payload]      - Arbitrary context for the consumer.
 * @property {string} createdAt   - ISO timestamp.
 * @property {string} [expiresAt] - Optional ISO “good until” time.
 * @property {string} [sourceEventType] - Event type that triggered this suggestion.
 */

/**
 * @typedef {(ctx: any) => (Partial<NbaSuggestion> | Partial<NbaSuggestion>[] | null | undefined)} NbaTemplateFn
 */

const templates = new Map(); // name -> { fn, meta }
const DEFAULT_EXPIRY_MS = 1000 * 60 * 60 * 24; // 24h

function nowIso() {
  return new Date().toISOString();
}

function createSuggestionId(templateName) {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `nba_${templateName}_${ts}_${rnd}`;
}

/**
 * Normalize raw template output into an array of NbaSuggestion objects.
 *
 * @param {string} templateName
 * @param {any} raw
 * @param {string} [sourceEventType]
 * @returns {NbaSuggestion[]}
 */
function normalizeSuggestions(templateName, raw, sourceEventType) {
  if (raw == null) return [];

  const arr = Array.isArray(raw) ? raw : [raw];

  return arr.filter(Boolean).map((s) => {
    const createdAt = nowIso();
    const expiresAt =
      s && s.expiresAt
        ? s.expiresAt
        : new Date(Date.now() + DEFAULT_EXPIRY_MS).toISOString();

    return {
      id: createSuggestionId(templateName),
      template: templateName,
      kind: "info",
      title: "Suggestion",
      message: "",
      payload: {},
      createdAt,
      expiresAt,
      sourceEventType: sourceEventType || null,
      ...s,
    };
  });
}

/**
 * Persist suggestions to Dexie nbaQueue store if available.
 * Falls back to a no-op if store does not exist.
 *
 * @param {NbaSuggestion[]} suggestions
 * @returns {Promise<void>}
 */
async function persistSuggestions(suggestions) {
  if (!suggestions.length) return;

  if (db && db.nbaQueue && typeof db.nbaQueue.bulkPut === "function") {
    try {
      await db.nbaQueue.bulkPut(suggestions);
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.error("[nbaOrchestrator] Failed to persist suggestions", err);
      }
    }
  }
}

/**
 * Emit an NBA event on the central event bus.
 *
 * @param {string} type
 * @param {any} data
 */
function emitNbaEvent(type, data) {
  eventBus.emit({
    type,
    ts: nowIso(),
    source: "nbaOrchestrator",
    data,
  });
}

/**
 * Register a new NBA template.
 *
 * @param {string} name                  - Unique template name (e.g. "animal.stocking.estimate").
 * @param {NbaTemplateFn} fn             - Function that returns suggestions for a given ctx.
 * @param {{ description?: string, autoWireEvents?: string[] }} [meta]
 */
export function registerTemplate(name, fn, meta = {}) {
  if (!name || typeof fn !== "function") return;

  templates.set(name, {
    fn,
    description: meta.description || "",
    autoWireEvents: Array.isArray(meta.autoWireEvents)
      ? meta.autoWireEvents
      : [],
  });
}

/**
 * Unregister an existing template.
 * @param {string} name
 */
export function unregisterTemplate(name) {
  templates.delete(name);
}

/**
 * Check if a template is registered.
 * @param {string} name
 */
export function hasTemplate(name) {
  return templates.has(name);
}

/**
 * Run a specific template with context and return normalized suggestions.
 *
 * @param {string} name
 * @param {any} ctx
 * @param {string} [sourceEventType]
 * @returns {Promise<NbaSuggestion[]>}
 */
export async function runTemplate(name, ctx, sourceEventType) {
  const entry = templates.get(name);
  if (!entry) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn(`[nbaOrchestrator] template "${name}" not registered`);
    }
    return [];
  }

  let raw;
  try {
    raw = await entry.fn(ctx);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.error(`[nbaOrchestrator] template "${name}" error`, err);
    }
    return [];
  }

  const suggestions = normalizeSuggestions(name, raw, sourceEventType);

  if (suggestions.length) {
    await persistSuggestions(suggestions);
    emitNbaEvent("nba.suggestions.created", { suggestions });
  }

  return suggestions;
}

/**
 * Run all templates against the given context.
 *
 * Typically used when a dashboard wants a snapshot of “what should I
 * be doing next?” without tying to a specific event.
 *
 * @param {any} ctx
 * @returns {Promise<NbaSuggestion[]>}
 */
export async function suggestAll(ctx) {
  const allSuggestions = [];

  for (const [name] of templates.entries()) {
    const suggestions = await runTemplate(name, ctx, null);
    allSuggestions.push(...suggestions);
  }

  return allSuggestions;
}

/**
 * Given an SSA event, run all templates that have opted-in to that
 * event type via `autoWireEvents`.
 *
 * Example:
 *   // Template registration:
 *   registerTemplate("animal.stocking.estimate", fn, {
 *     autoWireEvents: ["inventory.updated", "animals.fed"]
 *   });
 *
 *   // Later, when automation or eventBus receives an event, call:
 *   suggestForEvent(evt);
 *
 * @param {{ type: string, ts: string, source: string, data: any }} evt
 * @returns {Promise<NbaSuggestion[]>}
 */
export async function suggestForEvent(evt) {
  if (!evt || !evt.type) return [];

  const ctx = {
    event: evt,
    // This is where you enrich context later (current inventory snapshot,
    // season/cycle info, household preferences, etc.).
  };

  const allSuggestions = [];

  for (const [name, entry] of templates.entries()) {
    if (
      Array.isArray(entry.autoWireEvents) &&
      entry.autoWireEvents.length &&
      !entry.autoWireEvents.includes(evt.type)
    ) {
      continue;
    }

    const suggestions = await runTemplate(name, ctx, evt.type);
    allSuggestions.push(...suggestions);
  }

  return allSuggestions;
}

/**
 * Convenience helper for consumers that only care about still-valid,
 * not-yet-expired suggestions.
 *
 * Requires that `db.nbaQueue` exist. If not, returns [].
 *
 * @returns {Promise<NbaSuggestion[]>}
 */
export async function getActiveSuggestions() {
  if (!db || !db.nbaQueue) return [];

  const now = Date.now();
  const all = await db.nbaQueue.toArray();
  return all.filter((s) => {
    if (!s.expiresAt) return true;
    const exp = new Date(s.expiresAt).getTime();
    return !Number.isNaN(exp) && exp > now;
  });
}

/**
 * Mark a suggestion as resolved / acted on.
 * If `db.nbaQueue` exists, it will delete it there and emit an event.
 *
 * @param {string} id
 */
export async function resolveSuggestion(id) {
  if (!id) return;
  if (db && db.nbaQueue && typeof db.nbaQueue.delete === "function") {
    try {
      await db.nbaQueue.delete(id);
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.error("[nbaOrchestrator] Failed to resolve suggestion", err);
      }
    }
  }

  emitNbaEvent("nba.suggestion.resolved", { id });
}

/**
 * Optional: clear all suggestions (useful for tests / dev).
 */
export async function clearAllSuggestions() {
  if (db && db.nbaQueue && typeof db.nbaQueue.clear === "function") {
    await db.nbaQueue.clear();
  }
  emitNbaEvent("nba.suggestions.cleared", {});
}

// --- Event wiring ----------------------------------------------------
// You can expand this section over time. For now we only provide a
// simple hook that listens to all events and *optionally* triggers
// suggestions. This keeps nbaOrchestrator independent from the rest
// of the runtime while still allowing easy future integration.

eventBus.on("*", (evt) => {
  // Progressive enhancement:
  // - You may later filter by evt.type here and call suggestForEvent(evt)
  //   to create auto-suggestions whenever important events happen.
  // - For now, we leave this a no-op to avoid surprise work.
  //
  // Example when you are ready:
  //
  // const important = new Set([
  //   "inventory.updated",
  //   "inventory.shortage.detected",
  //   "session.completed",
  //   "garden.harvest.logged",
  // ]);
  //
  // if (important.has(evt.type)) {
  //   void suggestForEvent(evt);
  // }
});

const nbaOrchestrator = {
  registerTemplate,
  unregisterTemplate,
  hasTemplate,
  runTemplate,
  suggestAll,
  suggestForEvent,
  getActiveSuggestions,
  resolveSuggestion,
  clearAllSuggestions,
};

export default nbaOrchestrator;
