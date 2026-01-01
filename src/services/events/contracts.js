// src/services/events/contracts.js
/* eslint-disable no-console */

/**
 * Suka Smart Assistant — Event Contracts & Bus
 * -------------------------------------------------------------
 * 1) Canonical event names for clear Information Architecture.
 * 2) Event envelopes & validators for reliable interaction flows.
 * 3) UI glue for consistent design system (states, confirmations).
 * 4) Undo + Empty States + Next Best Action hooks baked in.
 * 5) (NEW) Torah Profile middleware: TIP filtering, Sabbath holds, badges.
 *
 * No external dependencies. Works in .js projects w/ JSDoc types.
 */

/* ──────────────────────────────────────────────────────────────
 * Types (JSDoc for IntelliSense in JS)
 * ────────────────────────────────────────────────────────────── */
/**
 * @typedef {Object} EventEnvelope
 * @property {string} id                 Unique id (ulid-like).
 * @property {string} name               Canonical event name.
 * @property {string} ts                 ISO timestamp.
 * @property {string} [actor]            Who initiated (userId/system).
 * @property {string} [source]           Module/page/component source.
 * @property {any}    payload            Event payload.
 * @property {Object} [meta]             Arbitrary metadata.
 * @property {UndoSpec} [undo]           How to undo this event's effect.
 * @property {NextBestAction} [nextBestAction] Suggested follow-up action.
 */

/**
 * @typedef {Object} UndoSpec
 * @property {string} label              Button/CTA label (e.g., "Undo").
 * @property {string} [tooltip]          Optional tooltip.
 * @property {(ev: EventEnvelope) => void | Promise<void>} handler
 */

/**
 * @typedef {Object} NextBestAction
 * @property {string} label              CTA label (e.g., "Send to Calendar").
 * @property {string} [hint]             Secondary text shown in UI.
 * @property {string} [route]            Suggested route to navigate.
 * @property {Record<string, any>} [params] Optional route/query params.
 * @property {(ev: EventEnvelope) => void | Promise<void>} [onChoose]
 */

/**
 * @typedef {(payload:any)=>true|string} PayloadValidator
 * Return true if valid, otherwise a string error.
 */

/* ──────────────────────────────────────────────────────────────
 * Utilities
 * ────────────────────────────────────────────────────────────── */

/** Simple ULID-ish id (sortable, collision-resistant enough for UI) */
function uid() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${t}${r}`;
}

/** Safe ISO now */
function isoNow() {
  return new Date().toISOString();
}

/** Basic shape checker helpers */
const isString = (v) => typeof v === "string";
const isBool = (v) => typeof v === "boolean";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isArray = Array.isArray;

/** Build a predicate that matches exact or namespace wildcard (e.g., "recipes.*") */
function topicMatcher(pattern) {
  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\*", ".*");
    const re = new RegExp(`^${escaped}$`);
    return (name) => re.test(name);
  }
  return (name) => name === pattern;
}

/* ──────────────────────────────────────────────────────────────
 * Event Bus (singleton)
 * ────────────────────────────────────────────────────────────── */
class EventBus {
  constructor() {
    /** @type {Array<{ match:(name:string)=>boolean, handler:(ev:EventEnvelope)=>void, once?:boolean }>} */
    this.listeners = [];
  }
  on(pattern, handler) {
    const entry = { match: topicMatcher(pattern), handler, once: false };
    this.listeners.push(entry);
    return () => this.off(handler);
  }
  once(pattern, handler) {
    const entry = { match: topicMatcher(pattern), handler, once: true };
    this.listeners.push(entry);
  }
  off(handler) {
    this.listeners = this.listeners.filter((l) => l.handler !== handler);
  }
  emit(envelope) {
    const listeners = [...this.listeners];
    for (const l of listeners) {
      if (l.match(envelope.name)) {
        try {
          l.handler(envelope);
        } catch (err) {
          console.error(`[events] listener error for "${envelope.name}":`, err);
        } finally {
          if (l.once) this.off(l.handler);
        }
      }
    }
  }
  waitFor(pattern, predicate) {
    return new Promise((resolve) => {
      this.once(pattern, (ev) => {
        if (!predicate || predicate(ev)) resolve(ev);
      });
    });
  }
}

/** Singleton instance */
export const events = new EventBus();

/* ──────────────────────────────────────────────────────────────
 * Canonical Event Names
 * Grouped by domain to enforce clear IA across the app.
 * Use dot-notated namespaces and verbs in past tense.
 * ────────────────────────────────────────────────────────────── */
export const NAMES = Object.freeze({
  // ── Information Architecture / Navigation
  "ia.route.navigated": "ia.route.navigated",               // payload: { path, params? }
  "ia.nav.section.opened": "ia.nav.section.opened",         // payload: { section }
  "ia.nav.section.closed": "ia.nav.section.closed",         // payload: { section }

  // ── UI Design System (states, confirmations, empty)
  "ui.toast.shown": "ui.toast.shown",                       // payload: { variant, title, message }
  "ui.dialog.confirm.requested": "ui.dialog.confirm.requested", // payload: { title, message, confirmLabel, cancelLabel, onConfirmId }
  "ui.state.pending": "ui.state.pending",                   // payload: { key }  (e.g., "recipes:save")
  "ui.state.ready": "ui.state.ready",                       // payload: { key }
  "ui.empty.presented": "ui.empty.presented",               // payload: { context, actions: [{label, eventName, payload}] }

  // ── Interaction Flow (step-by-step tasks)
  "flow.step.entered": "flow.step.entered",                 // payload: { flow, step, context? }
  "flow.step.completed": "flow.step.completed",             // payload: { flow, step, output? }
  "flow.completed": "flow.completed",                       // payload: { flow, summary? }

  // ── Next Best Action & Undo
  "ui.undo.offered": "ui.undo.offered",                     // payload: { label, ttlMs }
  "ui.undo.triggered": "ui.undo.triggered",                 // payload: { reason }
  "ui.nba.suggested": "ui.nba.suggested",                   // payload: { label, route?, params?, hint? }

  // ── Domain: Torah Profile (user dietary profile/toggles)
  "torah.profile.updated": "torah.profile.updated",         // payload: { shellfishAllowed:boolean, effectiveDate?:string, notes?:string }
  // (NEW) TIP guard lifecycle signals
  "torah.guard.shellfish.applied": "torah.guard.shellfish.applied",  // payload: { name, key, before, after }
  "torah.sabbath.hold.deferred": "torah.sabbath.hold.deferred",      // payload: { original: {name, payload}, until?: {start,end} }
  "torah.badges.attached": "torah.badges.attached",                  // payload: { name, count, artifactType? }

  // ── Domain: Preferences
  "preferences.changed": "preferences.changed",             // payload: { keys?: string[] }

  // ── Domain: Recipes
  "recipes.created": "recipes.created",                     // payload: { recipeId, title }
  "recipes.updated": "recipes.updated",                     // payload: { recipeId, changed: string[] }
  "recipes.deleted": "recipes.deleted",                     // payload: { recipeId }
  "recipes.consolidated": "recipes.consolidated",           // payload: { count, issues?:string[] }

  // ── Domain: Meal Planning
  "meal.plan.created": "meal.plan.created",                 // payload: { planId, weekStartISO, items: Array }
  "meal.plan.updated": "meal.plan.updated",                 // payload: { planId, changes: string[] }
  "meal.plan.published": "meal.plan.published",             // payload: { planId, toCalendar:boolean }

  // ── Domain: Inventory / Storehouse
  "inventory.updated": "inventory.updated",                 // payload: { diffs: Array<{sku, delta, reason}> }
  "storehouse.labels.generated": "storehouse.labels.generated", // payload: { batchId, count }

  // ── Domain: Preservation Queues
  "preservation.queue.recomputed": "preservation.queue.recomputed", // payload: { reason, totals: {dehydrate, can, freeze} }

  // ── Domain: Calendar
  "calendar.events.created": "calendar.events.created",     // payload: { count, range: {start, end}, ref?:string }
  "calendar.events.updated": "calendar.events.updated",     // payload: { count, ref?:string }
  // (NEW) Calendar sync lifecycle (used elsewhere in your app)
  "calendar.synced": "calendar.synced",                     // payload: { provider?:string, count?:number, range?:{start,end} },
});

/* ──────────────────────────────────────────────────────────────
 * Validators per event (no external deps)
 * Return true if valid, else string describing the issue.
 * ────────────────────────────────────────────────────────────── */
const vString = (k) => (p) => isString(p?.[k]) ? true : `Missing/invalid "${k}" (string)`;
const vBool = (k) => (p) => isBool(p?.[k]) ? true : `Missing/invalid "${k}" (boolean)`;
const vArray = (k) => (p) => isArray(p?.[k]) ? true : `Missing/invalid "${k}" (array)`;
const vObj = (k) => (p) => isObj(p?.[k]) ? true : `Missing/invalid "${k}" (object)`;
const vNum = (k) => (p) => isNum(p?.[k]) ? true : `Missing/invalid "${k}" (number)`;

/** Compose validators */
function validateAll(payload, validators) {
  for (const check of validators) {
    const res = check(payload);
    if (res !== true) return res;
  }
  return true;
}

/* ──────────────────────────────────────────────────────────────
 * (NEW) Middleware pipeline
 *  - Allows TIP filtering, hold deferral, and badge stamping
 *    without importing domain code here (no cycles).
 * ────────────────────────────────────────────────────────────── */

/**
 * @typedef {Object} EventMiddleware
 * @property {(env:EventEnvelope)=> (false | void | {defer?:boolean,envelope?:EventEnvelope,meta?:any})} [beforeEmit]
 *   Return `false` to cancel emission, `{defer:true}` to indicate a hold/defer, or `{envelope}` to replace.
 * @property {(env:EventEnvelope)=> void} [afterEmit]
 * @property {string} [name]
 */

const PIPE = { befores: [], afters: [] };

/**
 * Register a generic event middleware.
 * @param {EventMiddleware} mw
 * @returns {() => void} unsubscribe
 */
export function useEventMiddleware(mw) {
  const m = { name: mw.name || "mw", beforeEmit: mw.beforeEmit, afterEmit: mw.afterEmit };
  if (m.beforeEmit) PIPE.befores.push(m);
  if (m.afterEmit) PIPE.afters.push(m);
  return () => {
    PIPE.befores = PIPE.befores.filter((x) => x !== m);
    PIPE.afters = PIPE.afters.filter((x) => x !== m);
  };
}

/**
 * Convenience installer for Torah Profile guards.
 * You pass your own functions from other modules to avoid imports here.
 *
 * @param {Object} hooks
 * @param {()=>any} hooks.tipProvider                      // e.g., tipContext()
 * @param {(list:any[], tip:any)=>any[]} [hooks.guardShellfish]
 * @param {()=>boolean} [hooks.isOnHold]                   // fast check for Sabbath/appointed-time hold
 * @param {(artifact:any, tip:any)=>any} [hooks.withTorahBadges]
 * @param {(name:string, payload:any)=>('items'|'rows'|'recipes'|'list'|null)} [hooks.shouldFilterKey]
 * @param {(name:string, payload:any)=>boolean} [hooks.shouldHold]
 * @param {(name:string, payload:any)=>({artifact:any,type?:string}|null)} [hooks.isArtifact]
 */
export function installTorahProfileGuards(hooks) {
  const unsub = useEventMiddleware({
    name: "torahProfile",
    beforeEmit(env) {
      const tip = hooks.tipProvider?.();
      if (!tip) return;

      // 1) TIP filtering (hide shellfish when Off)
      let filteredMeta = null;
      const key = hooks.shouldFilterKey?.(env.name, env.payload) || null;
      if (key && hooks.guardShellfish && Array.isArray(env.payload?.[key])) {
        const before = env.payload[key].length;
        const afterList = hooks.guardShellfish(env.payload[key], tip);
        env.payload[key] = afterList;
        const after = afterList.length;
        if (after !== before) {
          filteredMeta = { name: env.name, key, before, after };
          env.meta = { ...(env.meta || {}), _tipFiltered: filteredMeta };
        }
      }

      // 2) Hold deferral (Sabbath/Appointed-Times)
      const shouldHold = hooks.shouldHold?.(env.name, env.payload);
      if (shouldHold && hooks.isOnHold?.()) {
        // Emit a hold/defer notice directly to the bus (no recursion through middleware).
        events.emit(buildEvent(NAMES["torah.sabbath.hold.deferred"], {
          original: { name: env.name, payload: env.payload },
          until: tip?.sabbath?.nextWindow,
        }, { source: "events/contracts" }));
        return { defer: true };
      }

      // 3) Badges on artifacts (labels, lots, exports)
      if (hooks.withTorahBadges && hooks.isArtifact) {
        const art = hooks.isArtifact(env.name, env.payload);
        if (art && art.artifact) {
          const stamped = hooks.withTorahBadges(art.artifact, tip);
          // Put it back where callers expect it:
          if ("artifact" in env.payload) {
            env.payload.artifact = stamped;
          } else {
            // If no canonical key, inject into meta for consumers
            env.meta = { ...(env.meta || {}), artifact: stamped };
          }
          env.meta = { ...(env.meta || {}), _badged: { name: env.name, type: art.type, count: (stamped?.badges || []).length } };
        }
      }

      return { envelope: env };
    },
    afterEmit(env) {
      // Mirror meta into simple signals (no middleware recursion, use raw bus)
      if (env?.meta?._tipFiltered) {
        const m = env.meta._tipFiltered;
        events.emit(buildEvent(NAMES["torah.guard.shellfish.applied"], m, { source: "events/contracts" }));
      }
      if (env?.meta?._badged) {
        const m = env.meta._badged;
        events.emit(buildEvent(NAMES["torah.badges.attached"], { name: m.name, count: m.count, artifactType: m.type }, { source: "events/contracts" }));
      }
    },
  });
  return unsub;
}

/* ──────────────────────────────────────────────────────────────
 * Registry: event → { version, description, validate(payload), suggestNext(payload) }
 * ────────────────────────────────────────────────────────────── */
export const CONTRACTS = Object.freeze({
  [NAMES["ia.route.navigated"]]: {
    version: 1,
    description: "User navigated to a route (IA glue).",
    validate: (p) => validateAll(p, [vString("path")]),
    suggestNext: (p) => ({
      label: "Open Weekly Planner",
      hint: "Jump to meal planning",
      route: "/tier2/household/meals",
    }),
  },

  [NAMES["ui.toast.shown"]]: {
    version: 1,
    description: "Design system toast notification.",
    validate: (p) => validateAll(p, [vString("variant"), vString("title"), vString("message")]),
  },

  [NAMES["ui.dialog.confirm.requested"]]: {
    version: 1,
    description: "Centralized confirm dialog request.",
    validate: (p) =>
      validateAll(p, [vString("title"), vString("message"), vString("confirmLabel"), vString("cancelLabel"), vString("onConfirmId")]),
  },

  [NAMES["ui.state.pending"]]: {
    version: 1,
    description: "Begin pending UI state for key.",
    validate: (p) => validateAll(p, [vString("key")]),
  },

  [NAMES["ui.state.ready"]]: {
    version: 1,
    description: "Clear pending UI state for key.",
    validate: (p) => validateAll(p, [vString("key")]),
  },

  [NAMES["ui.empty.presented"]]: {
    version: 1,
    description: "Show an empty state with contextual actions.",
    validate: (p) =>
      validateAll(p, [
        vString("context"),
        (pp) =>
          isArray(pp?.actions) && pp.actions.every((a) => isString(a?.label) && isString(a?.eventName))
            ? true
            : 'Invalid "actions": [{label, eventName, payload?}]',
      ]),
  },

  [NAMES["flow.step.entered"]]: {
    version: 1,
    description: "A user entered a specific step of a named flow.",
    validate: (p) => validateAll(p, [vString("flow"), vString("step")]),
  },

  [NAMES["flow.step.completed"]]: {
    version: 1,
    description: "A user completed a step (provide output for chaining).",
    validate: (p) => validateAll(p, [vString("flow"), vString("step")]),
    suggestNext: (p) => ({
      label: "Continue",
      hint: `Proceed to next step in ${p.flow}`,
    }),
  },

  [NAMES["flow.completed"]]: {
    version: 1,
    description: "A flow is fully completed.",
    validate: (p) => validateAll(p, [vString("flow")]),
  },

  [NAMES["ui.undo.offered"]]: {
    version: 1,
    description: "Offer an undo action to the user (UI layer renders snackbar).",
    validate: (p) => validateAll(p, [vString("label"), vNum("ttlMs")]),
  },

  [NAMES["ui.undo.triggered"]]: {
    version: 1,
    description: "User triggered undo (route to envelope.undo.handler).",
    validate: (p) => validateAll(p, [vString("reason")]),
  },

  [NAMES["ui.nba.suggested"]]: {
    version: 1,
    description: "Suggest a Next Best Action (CTA chip/cards).",
    validate: (p) => validateAll(p, [vString("label")]),
  },

  [NAMES["torah.profile.updated"]]: {
    version: 1,
    description:
      "Dietary profile toggles updated. Trigger recompute: meal suggestions, preservation queues, shopping lists, label templates.",
    validate: (p) => validateAll(p, [vBool("shellfishAllowed")]),
    suggestNext: (p) => ({
      label: "Recompute Meal Suggestions",
      hint: "Update menus & shopping list",
      route: "/tier2/household/meals",
    }),
  },

  [NAMES["torah.guard.shellfish.applied"]]: {
    version: 1,
    description: "TIP filter removed shellfish items from outbound payload.",
    validate: (p) => validateAll(p, [vString("name"), vString("key"), vNum("before"), vNum("after")]),
  },

  [NAMES["torah.sabbath.hold.deferred"]]: {
    version: 1,
    description: "Emission deferred due to Sabbath/Appointed-Time hold.",
    validate: (p) => validateAll(p, [vObj("original")]),
  },

  [NAMES["torah.badges.attached"]]: {
    version: 1,
    description: "Badges were attached to an outgoing artifact (labels/lots/exports).",
    validate: (p) => validateAll(p, [vString("name"), vNum("count")]),
  },

  [NAMES["preferences.changed"]]: {
    version: 1,
    description: "Global user preferences changed; UIs may need to refresh.",
    validate: (p) => true,
  },

  [NAMES["recipes.created"]]: {
    version: 1,
    description: "A new recipe was added.",
    validate: (p) => validateAll(p, [vString("recipeId"), vString("title")]),
    suggestNext: (p) => ({
      label: "Add to Batch Session",
      hint: "Queue for batch cooking",
      route: "/tier2/household/meals#batch",
    }),
  },

  [NAMES["recipes.updated"]]: {
    version: 1,
    description: "A recipe was updated.",
    validate: (p) => validateAll(p, [vString("recipeId"), vArray("changed")]),
  },

  [NAMES["recipes.deleted"]]: {
    version: 1,
    description: "A recipe was removed.",
    validate: (p) => validateAll(p, [vString("recipeId")]),
  },

  [NAMES["recipes.consolidated"]]: {
    version: 1,
    description: "Recipe consolidation completed.",
    validate: (p) => validateAll(p, [vNum("count")]),
  },

  [NAMES["meal.plan.created"]]: {
    version: 1,
    description: "A meal plan (week) was created.",
    validate: (p) => validateAll(p, [vString("planId"), vString("weekStartISO"), vArray("items")]),
    suggestNext: (p) => ({
      label: "Send to Calendar",
      hint: "Create events for meals",
      route: "/calendar",
    }),
  },

  [NAMES["meal.plan.updated"]]: {
    version: 1,
    description: "Meal plan updated.",
    validate: (p) => validateAll(p, [vString("planId"), vArray("changes")]),
  },

  [NAMES["meal.plan.published"]]: {
    version: 1,
    description: "Meal plan finalized and optionally synced to calendar.",
    validate: (p) => validateAll(p, [vString("planId")]),
  },

  [NAMES["inventory.updated"]]: {
    version: 1,
    description: "Inventory diffs applied (recompute labels/preservation queues).",
    validate: (p) =>
      validateAll(p, [
        (pp) =>
          isArray(pp?.diffs) &&
          pp.diffs.every((d) => isString(d?.sku) && isNum(d?.delta))
            ? true
            : 'Invalid "diffs": [{sku, delta(number), reason?}]',
      ]),
    suggestNext: (p) => ({
      label: "Generate Labels",
      hint: "Print/update storage labels",
      route: "/tier2/household/inventory#labels",
    }),
  },

  [NAMES["storehouse.labels.generated"]]: {
    version: 1,
    description: "Labels generated for storehouse items.",
    validate: (p) => validateAll(p, [vString("batchId"), vNum("count")]),
  },

  [NAMES["preservation.queue.recomputed"]]: {
    version: 1,
    description: "Preservation queues recalculated from latest data.",
    validate: (p) =>
      validateAll(p, [
        vString("reason"),
        (pp) => (isObj(pp?.totals) ? true : 'Missing/invalid "totals" (object)'),
      ]),
    suggestNext: (p) => ({
      label: "Open Preservation Panel",
      hint: "Plan can / freeze / dehydrate",
      route: "/tier2/household/meals#preservation",
    }),
  },

  [NAMES["calendar.events.created"]]: {
    version: 1,
    description: "Calendar events added (e.g., meals).",
    validate: (p) =>
      validateAll(p, [
        vNum("count"),
        (pp) => (pp?.range && isString(pp.range.start) && isString(pp.range.end) ? true : 'Invalid "range": {start,end}'),
      ]),
    suggestNext: (p) => ({
      label: "Share Schedule",
      hint: "Send plan to family",
      route: "/share",
    }),
  },

  [NAMES["calendar.events.updated"]]: {
    version: 1,
    description: "Calendar events updated.",
    validate: (p) => validateAll(p, [vNum("count")]),
  },

  [NAMES["calendar.synced"]]: {
    version: 1,
    description: "External calendar sync completed.",
    validate: (p) => true,
  },
});

/* ──────────────────────────────────────────────────────────────
 * Envelope builder + guarded emit
 * ────────────────────────────────────────────────────────────── */

/**
 * Build a standard event envelope and validate payload via CONTRACTS.
 * @param {string} name
 * @param {any} payload
 * @param {Object} [opts]
 * @param {string} [opts.actor]
 * @param {string} [opts.source]
 * @param {Object} [opts.meta]
 * @param {UndoSpec} [opts.undo]
 * @param {NextBestAction} [opts.nextBestAction]
 * @returns {EventEnvelope}
 */
export function buildEvent(name, payload, opts = {}) {
  const contract = CONTRACTS[name];
  if (!contract) throw new Error(`Unknown event name "${name}". Define it in CONTRACTS.`);
  const v = contract.validate ? contract.validate(payload) : true;
  if (v !== true) throw new Error(`Invalid payload for "${name}": ${v}`);
  /** @type {EventEnvelope} */
  const envelope = {
    id: uid(),
    name,
    ts: isoNow(),
    payload,
    actor: opts.actor,
    source: opts.source,
    meta: opts.meta,
    undo: opts.undo,
    nextBestAction: opts.nextBestAction || (contract.suggestNext ? contract.suggestNext(payload) : undefined),
  };
  return envelope;
}

/**
 * Emit an event with validation and auto-suggested next-best-action.
 * Runs middleware (TIP filters, holds, badges) before/after emission.
 * Also emits UI glue events for undo/NBA when specified.
 * @param {string} name
 * @param {any} payload
 * @param {Object} [opts] see buildEvent
 * @returns {EventEnvelope} The envelope that was actually emitted (or deferred)
 */
export function emitEvent(name, payload, opts = {}) {
  let envelope = buildEvent(name, payload, opts);

  // BEFORE middlewares
  for (const m of PIPE.befores) {
    try {
      const res = m.beforeEmit?.(envelope);
      if (res === false) return envelope;           // canceled
      if (res && res.defer) return envelope;        // deferred elsewhere
      if (res && res.envelope) envelope = res.envelope;
    } catch (e) {
      console.error(`[events] beforeEmit error (${m.name || "mw"}):`, e);
    }
  }

  // Core emission
  events.emit(envelope);

  // AFTER middlewares
  for (const m of PIPE.afters) {
    try { m.afterEmit?.(envelope); } catch (e) { console.error(`[events] afterEmit error (${m.name || "mw"}):`, e); }
  }

  // Auto UI glue for undo
  if (envelope.undo) {
    events.emit(buildEvent(NAMES["ui.undo.offered"], { label: envelope.undo.label || "Undo", ttlMs: 7000 }, { source: "events/contracts" }));
  }

  // Auto UI glue for Next Best Action
  if (envelope.nextBestAction) {
    events.emit(buildEvent(
      NAMES["ui.nba.suggested"],
      { label: envelope.nextBestAction.label, route: envelope.nextBestAction.route, params: envelope.nextBestAction.params, hint: envelope.nextBestAction.hint },
      { source: "events/contracts" }
    ));
  }

  return envelope;
}

/* ──────────────────────────────────────────────────────────────
 * Convenience subscriptions (sugar for UI + orchestrators)
 * ────────────────────────────────────────────────────────────── */
export function onConfirmRequested(onRequest) {
  return events.on(NAMES["ui.dialog.confirm.requested"], onRequest);
}
export function onTorahProfileUpdated(handler) {
  return events.on(NAMES["torah.profile.updated"], handler);
}
export function onAny(pattern, handler) {
  return events.on(pattern, handler);
}

/* ──────────────────────────────────────────────────────────────
 * Example: common high-level flows (documented for integrators)
 * ────────────────────────────────────────────────────────────── */
/**
 * Example integration patterns:
 *
 * // 1) Empty State shown when no recipes:
 * emitEvent(NAMES["ui.empty.presented"], {
 *   context: "recipes.list",
 *   actions: [
 *     { label: "Scan a Recipe", eventName: NAMES["recipes.created"], payload: { recipeId, title } },
 *     { label: "Open Recipe Vault", eventName: NAMES["ia.route.navigated"], payload: { path: "/tier2/household/meals#vault" } },
 *   ],
 * }, { source: "RecipesList.jsx" });
 *
 * // 2) Undo for inventory change:
 * const diffs = [{ sku: "FLOUR-25LB", delta: -1, reason: "Batch baking" }];
 * const env = emitEvent(NAMES["inventory.updated"], { diffs }, {
 *   actor: "user:123",
 *   source: "InventoryAdjuster.jsx",
 *   undo: {
 *     label: "Undo",
 *     handler: () => emitEvent(NAMES["inventory.updated"], { diffs: diffs.map(d => ({ ...d, delta: -d.delta })) }, { source: "undo" })
 *   }
 * });
 *
 * // 3) Next Best Action after meal plan creation:
 * emitEvent(NAMES["meal.plan.created"], {
 *   planId: "wk-2025-10-06",
 *   weekStartISO: "2025-10-06",
 *   items: [...]
 * }, { actor: "user:123", source: "MealPlanner.jsx" });
 *
 * // 4) (NEW) Install Torah Profile guards once at app boot:
 * installTorahProfileGuards({
 *   tipProvider: () => tipContext(),                              // from AgentCore
 *   guardShellfish: (list, tip) => guardShellfish(list, tip),     // your hook
 *   isOnHold: () => sabbathIsActiveNow(),                         // fast check
 *   withTorahBadges: (artifact, tip) => withTorahBadges(artifact, tip),
 *   shouldFilterKey: (name, payload) => {                         // choose list key to filter
 *     if (name.startsWith("recipes.")) return "recipes";
 *     if (name.startsWith("inventory.")) return "rows";
 *     if (name.startsWith("meal.plan.")) return "items";
 *     return null;
 *   },
 *   shouldHold: (name) => /created|updated|published/.test(name), // hold mutating actions
 *   isArtifact: (name, payload) => payload?.artifact ? { artifact: payload.artifact, type: payload?.artifact?.type } : null,
 * });
 */

/* ──────────────────────────────────────────────────────────────
 * Default export (optional)
 * ────────────────────────────────────────────────────────────── */
export default {
  events,
  NAMES,
  CONTRACTS,
  buildEvent,
  emitEvent,
  useEventMiddleware,
  installTorahProfileGuards,
  onAny,
  onConfirmRequested,
  onTorahProfileUpdated,
};
