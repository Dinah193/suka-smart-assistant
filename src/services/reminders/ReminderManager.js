// src/services/reminders/ReminderManager.js
/* eslint-disable no-console */

/**
 * ReminderManager — central reminder/alert surface
 * - Channels: system Notification API (if permitted), UI toast, UI modal, optional voice
 * - API:
 *     .init()
 *     .notify({ title, message, level, domain, when, alignEvery, tag, sticky, requireInteraction, actions, icon, voiceText })
 *     .modal({ title, body, actions, size, blocking, level }) → Promise<actionId|string|null>
 *     .confirm(opts) / .prompt(opts)
 * - Scheduling: accepts absolute epoch ms OR relative strings (e.g., "+20m", "90s")
 * - Dedupe/throttle: via { tag } and { throttleMs }
 * - Events emitted for UI layers to render:
 *     "ui.toast", "ui.modal.show", "ui.modal.action", "reminder.fired"
 * - Defensive: no import.meta; works SSR or browser; safe if eventBus/UI not present
 */

let eventBus = { on() {}, off() {}, emit() {} };
try {
  const eb = require("@/services/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) { /* no-op */ }

let timeMath = null;
try {
  timeMath = require("@/services/session/utils/timeMath.js");
  timeMath = (timeMath && (timeMath.default || timeMath)) || null;
} catch (_e) { /* no-op */ }

let scheduleDebug = null;
try {
  scheduleDebug = require("@/services/session/utils/scheduleDebug.js");
  scheduleDebug = (scheduleDebug && (scheduleDebug.default || scheduleDebug)) || null;
} catch (_e) { /* no-op */ }

let pausePolicies = null; // optional; used to avoid pinging during withhold windows
try {
  pausePolicies = require("@/services/session/policies/pausePolicies.js");
  pausePolicies = (pausePolicies && (pausePolicies.default || pausePolicies)) || null;
} catch (_e) { /* no-op */ }

const isBrowser = typeof window !== "undefined";
const now = () => Date.now();

const d = scheduleDebug?.withDomain ? scheduleDebug.withDomain("reminders") : {
  debug() {}, info() {}, warn() {}, error() {}, trace() {}
};

const DEFAULTS = Object.freeze({
  level: "info", // "success" | "info" | "warn" | "error"
  domain: "meals",
  size: "md",    // modal sizes: "sm" | "md" | "lg" | "xl"
  blocking: false,
  requireInteraction: false,
  sticky: false,
  throttleMs: 0,
});

const LEVEL_ICON = {
  success: "✅",
  info: "ℹ️",
  warn: "⚠️",
  error: "⛔",
};

function toMs(v) {
  if (!timeMath) return (typeof v === "number" ? v : 0);
  return timeMath.toMs ? timeMath.toMs(v) : (typeof v === "number" ? v : 0);
}

function humanize(ms) {
  if (!timeMath) return `${ms}ms`;
  return timeMath.humanize ? timeMath.humanize(ms) : `${ms}ms`;
}

function nextAligned(ts, every) {
  if (!timeMath) return ts;
  return timeMath.nextTickAligned ? timeMath.nextTickAligned({ fromTs: ts, everyMs: every }) : ts;
}

function canUseSystemNotifications() {
  if (!isBrowser || !("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  return false;
}

async function ensureSystemPermission() {
  if (!isBrowser || !("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission !== "denied") {
    try {
      const perm = await Notification.requestPermission();
      return perm === "granted";
    } catch (_e) {
      return false;
    }
  }
  return false;
}

function speak(text) {
  try {
    if (!isBrowser || !("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(u);
  } catch (_e) {}
}

let _id = 0;
const genId = (prefix = "rem") => `${prefix}_${(++_id).toString(36)}_${Math.floor(Math.random()*1e6).toString(36)}`;

class ReminderManager {
  constructor() {
    this.timers = new Map();     // id -> timeout handle
    this.lastByTag = new Map();  // tag -> lastTs
    this.modals = new Map();     // modalId -> resolver
    this.initialized = false;
  }

  init() {
    if (this.initialized) return;
    this.initialized = true;

    // Bridge UI modal actions back to promises
    if (eventBus.on) {
      eventBus.on("ui.modal.action", (payload) => {
        const { id, actionId = null, data = null } = payload || {};
        const resolver = this.modals.get(id);
        if (resolver) {
          this.modals.delete(id);
          resolver.resolve(actionId ?? data ?? null);
        }
      });
    }

    d.info("initialized");
  }

  /**
   * notify(opts)
   *  - Immediate or scheduled notification/toast with optional modal fallback
   *  - opts.when: epoch ms OR string "+20m" / "30s" (relative)
   *  - opts.alignEvery: e.g., "30s" (align to neat ticks)
   */
  async notify(opts = {}) {
    const {
      title,
      message,
      level = DEFAULTS.level,
      domain = DEFAULTS.domain,
      icon = LEVEL_ICON[level] || "🔔",
      actions = [],              // [{ id, label, href?, intent? }]
      tag,                       // string to dedupe/throttle
      throttleMs = DEFAULTS.throttleMs,
      requireInteraction = DEFAULTS.requireInteraction,
      sticky = DEFAULTS.sticky,
      voiceText,                 // optional string to TTS
      when = null,               // absolute ms or relative string
      alignEvery = null,         // "30s" | "5m"
      policyContext = null,      // optional pausePolicies context
    } = opts;

    // Policy guard (optional)
    if (pausePolicies?.evaluate && policyContext) {
      try {
        const decision = pausePolicies.evaluate(policyContext);
        if (decision?.block) {
          d.warn("policy-block", { reason: decision.reason, title, message });
          // Emit NBA suggestion instead of interrupting
          eventBus.emit?.("nba.updated", { domain, actions: decision.suggestedActions || [] });
          return null;
        }
      } catch (_e) { /* ignore */ }
    }

    // Throttle/dedupe by tag
    if (tag && throttleMs > 0) {
      const last = this.lastByTag.get(tag) || 0;
      if (now() - last < throttleMs) {
        d.debug("throttled", { tag, remaining: humanize(throttleMs - (now() - last)) });
        return null;
      }
    }

    // Schedule or send now
    let fireAt = now();
    if (typeof when === "number" && when > now()) fireAt = when;
    else if (typeof when === "string" && timeMath) {
      const delta = toMs(when);
      if (delta > 0) fireAt = now() + delta;
    }

    if (alignEvery) fireAt = nextAligned(fireAt, toMs(alignEvery));

    const id = genId("ntf");

    if (fireAt <= now() + 15) {
      this._deliverNotify({ id, title, message, icon, level, domain, actions, requireInteraction, sticky, voiceText, tag, throttleMs });
    } else {
      const delay = Math.max(0, fireAt - now());
      d.debug("timer:set", { id, fireAt, in: humanize(delay), title });
      const handle = setTimeout(() => {
        this._deliverNotify({ id, title, message, icon, level, domain, actions, requireInteraction, sticky, voiceText, tag, throttleMs });
        this.timers.delete(id);
      }, delay);
      this.timers.set(id, handle);
    }
    return id;
  }

  cancel(id) {
    const t = this.timers.get(id);
    if (t) { clearTimeout(t); this.timers.delete(id); d.info("timer:cancel", { id }); }
  }

  cancelAll() {
    for (const [id, t] of this.timers.entries()) { clearTimeout(t); }
    this.timers.clear();
    d.info("timer:cancel-all");
  }

  async _deliverNotify(payload) {
    const { id, title, message, icon, level, domain, actions, requireInteraction, sticky, voiceText, tag, throttleMs } = payload;

    // Mark throttle timestamp
    if (tag && throttleMs > 0) this.lastByTag.set(tag, now());

    // Try System Notification first if user granted
    let usedSystem = false;
    if (isBrowser && ("Notification" in window)) {
      if (Notification.permission === "granted" || await ensureSystemPermission()) {
        try {
          const n = new Notification(title || "Reminder", {
            body: message || "",
            icon: typeof icon === "string" ? undefined : undefined, // keep simple; UI toast will show emoji/icon
            requireInteraction: !!requireInteraction,
            tag: tag || undefined,
          });
          usedSystem = true;
          d.info("notify:system", { id, title, message, tag, level });
          // Click-through: surface first actionable intent if present
          if (actions && actions.length) {
            n.onclick = () => {
              const a = actions[0];
              if (a?.href && isBrowser) window.open(a.href, "_blank");
              eventBus.emit?.("ui.toast.action", { id, actionId: a?.id || "primary", intent: a?.intent || null, domain });
            };
          }
        } catch (_e) { usedSystem = false; }
      }
    }

    // Always emit UI toast event for in-app surfaces
    eventBus.emit?.("ui.toast", {
      id,
      title: title || "Reminder",
      message: message || "",
      level,
      domain,
      icon: LEVEL_ICON[level] || icon || "🔔",
      actions: actions || [],
      sticky: !!sticky,
      ts: now(),
    });

    // Optional voice cue
    if (voiceText) speak(voiceText);

    // Analytics hook
    eventBus.emit?.("reminder.fired", { id, channel: usedSystem ? "system" : "toast", title, domain, level });

    d.debug("notify:fired", { id, title, level, usedSystem });
  }

  /**
   * modal(opts) → Promise<actionId|string|null>
   *  - Renders via your app's modal layer listening to "ui.modal.show"
   *  - The UI must emit "ui.modal.action" with { id, actionId, data } to resolve.
   */
  modal(opts = {}) {
    const {
      title = "Attention",
      body = "",
      level = "info",
      size = DEFAULTS.size,
      blocking = DEFAULTS.blocking,
      actions = [
        { id: "ok", label: "OK", intent: "primary" },
      ],
      domain = DEFAULTS.domain,
      icon = LEVEL_ICON[level] || "🪄",
    } = opts;

    const id = genId("mod");
    d.info("modal:show", { id, title, size, blocking, actionsLen: actions.length });

    return new Promise((resolve) => {
      this.modals.set(id, { resolve });
      // Emit event for UI layer
      eventBus.emit?.("ui.modal.show", {
        id,
        title,
        body,
        level,
        size,
        blocking,
        actions,    // [{ id, label, intent, href? }]
        domain,
        icon,
        // optional affordances for keyboard handlers in UI
        meta: { escCloses: !blocking, defaultAction: actions?.[0]?.id || "ok" },
      });

      // Safety timeout (avoid orphaned promises if UI never responds)
      setTimeout(() => {
        if (this.modals.has(id)) {
          this.modals.delete(id);
          d.warn("modal:auto-resolve", { id });
          resolve(null);
        }
      }, 10 * 60 * 1000); // 10 minutes
    });
  }

  /**
   * confirm({ title, body, okLabel, cancelLabel }) → Promise<boolean>
   */
  async confirm(opts = {}) {
    const { title = "Are you sure?", body = "", okLabel = "Confirm", cancelLabel = "Cancel", level = "warn", domain = DEFAULTS.domain } = opts;
    const action = await this.modal({
      title, body, level, domain, size: "sm", blocking: false,
      actions: [
        { id: "ok", label: okLabel, intent: "primary" },
        { id: "cancel", label: cancelLabel, intent: "ghost" },
      ],
    });
    return action === "ok";
  }

  /**
   * prompt({ title, body, placeholder, submitLabel }) → Promise<string|null>
   * Your UI should render a text input when payload.meta.kind === "prompt".
   */
  async prompt(opts = {}) {
    const { title = "Enter value", body = "", placeholder = "", submitLabel = "Submit", level = "info", domain = DEFAULTS.domain } = opts;
    const id = genId("mod");
    return new Promise((resolve) => {
      this.modals.set(id, { resolve });
      eventBus.emit?.("ui.modal.show", {
        id,
        title,
        body,
        level,
        size: "sm",
        blocking: false,
        actions: [
          { id: "submit", label: submitLabel, intent: "primary" },
          { id: "cancel", label: "Cancel", intent: "ghost" },
        ],
        domain,
        icon: LEVEL_ICON[level] || "💬",
        meta: { kind: "prompt", placeholder },
      });

      setTimeout(() => {
        if (this.modals.has(id)) {
          this.modals.delete(id);
          d.warn("prompt:auto-resolve", { id });
          resolve(null);
        }
      }, 10 * 60 * 1000);
    });
  }
}

/* ------------------------------ Singleton export ----------------------------- */
const reminderManager = new ReminderManager();
reminderManager.init();

export { ReminderManager };
export default reminderManager;

/* ----------------------------------- Notes -----------------------------------
UI Integration (minimal):

1) Toasts
   eventBus.on("ui.toast", (p) => {
     // Render your Toast component (shadcn/ui or your own):
     // p = { id, title, message, level, domain, icon, actions[], sticky, ts }
   });

2) Modals
   eventBus.on("ui.modal.show", (p) => {
     // Present your Modal. When user clicks an action:
     //   eventBus.emit("ui.modal.action", { id: p.id, actionId: "ok" });
     // For prompt input, emit data in place of actionId:
     //   eventBus.emit("ui.modal.action", { id: p.id, data: "user text" });
   });

Examples:

import reminders from "@/services/reminders/ReminderManager";

// Immediate toast
reminders.notify({ title: "Proofing started", message: "20 minutes on the clock", level: "info", tag: "proof-start", throttleMs: 2000 });

// Scheduled, aligned to :30s ticks, with voice
reminders.notify({
  title: "Flip steaks",
  message: "Sear the other side",
  level: "warn",
  domain: "meals",
  when: "+3m",
  alignEvery: "30s",
  voiceText: "Flip the steaks now.",
  tag: "flip-steaks",
  throttleMs: 10000
});

// Modal confirm
const ok = await reminders.confirm({ title: "Start batch cook?", body: "This will arm 5 timers." });
// if (ok) { startSession(); }

-------------------------------------------------------------------------------- */
