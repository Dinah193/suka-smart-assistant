/* eslint-disable no-console */
// sabbathGuard.js — Convert/skip blocking modals on Sabbath (and quiet hours), queue intents, resume later.

(function () {
  // ------------------------------ Defensive deps ------------------------------
  const isBrowser = typeof window !== "undefined";
  const now = () => Date.now();

  let eventBus = { on() {}, off() {}, emit() {} };
  try {
    const eb = require("@/services/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  let scheduleHelpers = null; // expects: isSabbath(ts), inQuietHours(ts), nextUnquiet(ts)
  try {
    scheduleHelpers = require("@/services/scheduleHelpers");
  } catch (_e) {}

  let automation = null; // in-app toasts/banners
  try {
    automation =
      (require("@/services/automation/runtime") || {}).automation || null;
  } catch (_e) {}

  // ------------------------------ Storage utils -------------------------------
  const K = {
    QUEUE: "suka:sabbathGuard:queue:v1",
    PREFS: "suka:sabbathGuard:prefs:v1",
  };
  const safeJSON = {
    parse: (s, f = null) => {
      try {
        return JSON.parse(s);
      } catch {
        return f;
      }
    },
    stringify: (o) => {
      try {
        return JSON.stringify(o);
      } catch {
        return "{}";
      }
    },
  };
  const load = (key, fallback) =>
    isBrowser ? safeJSON.parse(localStorage.getItem(key), fallback) : fallback;
  const save = (key, val) => {
    if (isBrowser) localStorage.setItem(key, safeJSON.stringify(val));
  };

  // ------------------------------ Config / Defaults ---------------------------
  const DEFAULTS = {
    enabled: true,
    guardQuietHours: true,
    // Convert “modal” to one of: "sheet" (slide-up), "card" (inline panel), "toast" (heads-up)
    convertStrategy: "sheet",
    // Actions allowed during Sabbath (non-destructive, safety first)
    allowedActionKinds: ["ack", "dismiss", "view", "snooze"],
    // Modal IDs always allowed (e.g., safety, biohazard, fire, gas)
    allowlistIds: ["safetyAlert", "biohazardWarning", "weatherEmergency"],
    // Modal IDs always blocked/converted during Sabbath (payments, publishing, batch destructive)
    blocklistIds: [
      "paymentCheckout",
      "publishPlan",
      "deleteConfirm",
      "butcheryBatchCommit",
      "gardenMassReplant",
      "inventoryBulkAdjust",
      "animalsProcedureCommit",
    ],
    // Domains to always convert (commerce, finance) vs maybe convert (meals/garden)
    domainSensitivity: {
      finance: "always",
      commerce: "always",
      cleaning: "maybe",
      meals: "maybe",
      garden: "maybe",
      animals: "maybe",
      general: "maybe",
    },
    // For “maybe”: convert if the modal is destructive or commits future labor/time
    destructiveKinds: [
      "delete",
      "commit",
      "checkout",
      "purchase",
      "publish",
      "startSessionHard",
    ],
    // How long to snooze “converted” notices (ms)
    noticeSnoozeMs: 5 * 60 * 1000,
  };

  let prefs = Object.assign({}, DEFAULTS, load(K.PREFS, {}));
  let queue = load(K.QUEUE, []); // [{id, at, runAt, kind, payload}]

  const setPrefs = (patch) => {
    prefs = Object.assign({}, prefs, patch || {});
    save(K.PREFS, prefs);
    eventBus.emit("sabbath.guard.prefs.updated", { prefs });
  };

  // ------------------------------ Helpers ------------------------------------
  function isSabbath(ts = now()) {
    return !!(
      scheduleHelpers &&
      scheduleHelpers.isSabbath &&
      scheduleHelpers.isSabbath(ts)
    );
  }
  function inQuietHours(ts = now()) {
    if (!prefs.guardQuietHours) return false;
    return !!(
      scheduleHelpers &&
      scheduleHelpers.inQuietHours &&
      scheduleHelpers.inQuietHours(ts)
    );
  }
  function nextUnquiet(ts = now()) {
    return (
      (scheduleHelpers &&
        scheduleHelpers.nextUnquiet &&
        scheduleHelpers.nextUnquiet(ts)) ||
      null
    );
  }

  function shouldConvertModal(modal = {}) {
    // modal: { id, title, domain?, kind?, actions?:[], payload?:{}, priority?:'high'|'normal' }
    if (!prefs.enabled) return { convert: false, reason: null };

    const sab = isSabbath();
    const qh = inQuietHours();
    if (!sab && !qh) return { convert: false, reason: null };

    // Always allow (safety)
    if (prefs.allowlistIds.includes(modal.id))
      return { convert: false, reason: null };

    // Always block (commerce/finance/etc.)
    if (prefs.blocklistIds.includes(modal.id)) {
      return { convert: true, reason: sab ? "sabbath" : "quiet-hours" };
    }

    // Domain sensitivity
    const sensitivity =
      prefs.domainSensitivity[modal.domain || "general"] || "maybe";
    if (sensitivity === "always") {
      return { convert: true, reason: sab ? "sabbath" : "quiet-hours" };
    }

    // If any destructive action present → convert
    const kinds = (modal.actions || []).map((a) => a.kind);
    const hasDestructive = kinds.some((k) =>
      prefs.destructiveKinds.includes(k)
    );
    if (hasDestructive) {
      return { convert: true, reason: sab ? "sabbath" : "quiet-hours" };
    }

    // Otherwise “maybe”: allow but strip disallowed actions (convert->soften)
    return { convert: "soften", reason: sab ? "sabbath" : "quiet-hours" };
  }

  function softenActions(actions = []) {
    // keep only allowed kinds; replace others with post-sabbath queue buttons
    const kept = actions.filter((a) =>
      prefs.allowedActionKinds.includes(a.kind)
    );
    const replaced = actions
      .filter((a) => !prefs.allowedActionKinds.includes(a.kind))
      .map((a) => ({
        id: `${a.id}-queue`,
        label: `${a.label} (after Sabbath)`,
        kind: "queueAfterSabbath",
        original: a,
      }));
    return [...kept, ...replaced];
  }

  function toConvertedConfig(modal, reason, strategy = prefs.convertStrategy) {
    const runAt = nextUnquiet() || now() + 12 * 60 * 60 * 1000;
    const baseMsg =
      reason === "sabbath"
        ? "This action is paused for Sabbath. You can review now, and I’ll resume it afterward."
        : "This action is paused for quiet hours. You can review now, and I’ll resume it at a better time.";

    if (strategy === "toast") {
      return {
        type: "toast",
        cancelOriginal: true,
        payload: {
          title: modal.title || "Action deferred",
          message: baseMsg,
          runAt,
          modalId: modal.id,
          domain: modal.domain || "general",
          actions: [
            { id: "viewReadOnly", label: "View read-only", kind: "view" },
            {
              id: "queueResume",
              label: "Resume after",
              kind: "queueAfterSabbath",
            },
            { id: "dismiss", label: "Dismiss", kind: "dismiss" },
          ],
        },
      };
    }

    // "sheet" (default) or "card"
    return {
      type: strategy, // "sheet" or "card"
      cancelOriginal: true,
      payload: {
        id: `${modal.id}-converted`,
        title: modal.title || "Action deferred",
        subhead: baseMsg,
        domain: modal.domain || "general",
        reason,
        runAt,
        readOnly: true,
        // keep read-only content (props/component are passed through for rendering in view mode)
        component: modal.component || null,
        props: Object.assign({}, modal.props || {}, { readOnly: true }),
        // Soften actions
        actions: [
          { id: "ack", label: "OK", kind: "ack" },
          {
            id: "queueResume",
            label: "Resume after",
            kind: "queueAfterSabbath",
          },
          {
            id: "snooze",
            label: "Snooze",
            kind: "snooze",
            payload: { ms: prefs.noticeSnoozeMs },
          },
        ],
        original: {
          id: modal.id,
          kind: modal.kind,
          actions: modal.actions || [],
          payload: modal.payload || {},
        },
      },
    };
  }

  // ------------------------------ Queue --------------------------------------
  function queueIntent(kind, payload, runAt) {
    const item = {
      id: `q:${Math.random().toString(36).slice(2)}`,
      at: now(),
      runAt,
      kind,
      payload,
    };
    queue.push(item);
    save(K.QUEUE, queue);
    eventBus.emit("sabbath.queue.updated", { size: queue.length });
    if (automation?.notify) {
      automation.notify({
        title: "Queued for later",
        message: "I’ll resume this after Sabbath/quiet hours.",
        scope: "local",
        severity: "info",
        ts: now(),
        tags: ["sabbath", "queue"],
      });
    }
    return item.id;
  }

  function flushQueue(force = false) {
    const ts = now();
    const ready = [];
    const pending = [];

    // ✅ Null/shape guard: if queue is missing or not an array, reset and exit
    if (!Array.isArray(queue) || queue.length === 0) {
      queue = [];
      save(K.QUEUE, queue);
      return;
    }

    queue.forEach((item) => {
      if (force || (item.runAt && item.runAt <= ts)) ready.push(item);
      else pending.push(item);
    });

    // Execute ready intents
    ready.forEach((item) => {
      try {
        // Convention: we re-emit the original intent events or UI opens
        // Supported kinds: "openModal", "fireEvent"
        if (item.kind === "openModal") {
          eventBus.emit("ui.modal.open", item.payload);
        } else if (item.kind === "fireEvent") {
          const { name, data } = item.payload || {};
          if (name) eventBus.emit(name, data || {});
        }
      } catch (e) {
        console.error("[sabbathGuard] flushQueue item error:", e);
      }
    });

    queue = pending;
    save(K.QUEUE, queue);
    eventBus.emit("sabbath.queue.flushed", {
      executed: ready.length,
      remaining: queue.length,
    });
  }

  // ------------------------------ Guard API ----------------------------------
  const sabbathGuard = {
    init(userPrefs = {}) {
      setPrefs(userPrefs);

      // Intercept modal opens
      eventBus.on("ui.modal.open", (modal = {}) => {
        const { convert, reason } = shouldConvertModal(modal);

        if (!convert) {
          // “soften” path still strips destructive actions if we’re in sabbath/qh
          if (reason === "sabbath" || reason === "quiet-hours") {
            const softened = Object.assign({}, modal, {
              actions: softenActions(modal.actions || []),
            });
            eventBus.emit("ui.modal.converted", {
              cancelOriginal: true,
              converted: toConvertedConfig(
                softened,
                reason,
                prefs.convertStrategy
              ),
            });
          }
          return;
        }

        // Convert or block outright
        const converted = toConvertedConfig(
          modal,
          reason,
          prefs.convertStrategy
        );

        // Tell UI to cancel the original modal and show alternative
        eventBus.emit("ui.modal.converted", converted);

        // Optional banner/toast
        if (automation?.notify) {
          automation.notify({
            title: modal.title || "Action deferred",
            message:
              reason === "sabbath"
                ? "Paused for Sabbath."
                : "Paused for quiet hours.",
            scope: "local",
            severity: "info",
            ts: now(),
            tags: ["sabbath", "converted-modal"],
          });
        }
      });

      // Handle “queueAfterSabbath” and “snooze” coming back from converted UI
      eventBus.on("ui.action.invoked", (e = {}) => {
        // e: { sourceId, action: { id, kind, original? }, context?: { modal?, card? } }
        const kind = e.action?.kind;
        if (kind === "queueAfterSabbath") {
          const resumeAt = nextUnquiet() || now() + 12 * 60 * 60 * 1000;
          const payload =
            e.context?.modal?.original || e.context?.card?.original || {};
          // Decide how to resume: if original looked like a modal open, replay it
          const resumeKind = "openModal";
          queueIntent(
            resumeKind,
            {
              id: payload.id,
              title: e.context?.title,
              actions: payload.actions,
              payload: payload.payload,
              domain: e.context?.domain,
            },
            resumeAt
          );
        } else if (kind === "snooze") {
          const ms = e.action?.payload?.ms || prefs.noticeSnoozeMs;
          const until = now() + ms;
          queueIntent(
            "openModal",
            e.context?.modal?.original || e.context?.card?.original || {},
            until
          );
        }
      });

      // When Sabbath/quiet hours lift, flush automatically
      // RelativeScheduler and scheduleHelpers already mute/queue; we re-check periodically
      if (isBrowser) {
        setInterval(() => {
          const sab = isSabbath();
          const qh = inQuietHours();
          if (!sab && !qh) flushQueue(false);
        }, 60 * 1000);
      }

      // If RelativeScheduler muted a reminder, swap to non-blocking UI
      eventBus.on("relative.reminder.muted", (e = {}) => {
        // Replace any modal ask with a soft toast/sheet
        const converted = toConvertedConfig(
          {
            id: `reminder:${e.itemId}`,
            title: e.title || "Reminder",
            domain: e.domain || "general",
            actions: [],
          },
          e.mutedBecause === "sabbath" ? "sabbath" : "quiet-hours",
          "toast"
        );
        eventBus.emit("ui.toast.show", converted.payload);
      });

      // If planner conflict is detected (e.g., withhold), prefer NBA suggestion over modal
      eventBus.on("planner.conflict.detected", (e = {}) => {
        // e: { kind, until?, domain, item? }
        eventBus.emit("nba.suggestion.requested", {
          context: "withhold",
          reasons: [e.kind || "withhold"],
          item: e.item || null,
        });
      });

      // UX affordance: let HUD ask if guard is active
      eventBus.on("sabbath.guard.status.requested", () => {
        const active = isSabbath() || inQuietHours();
        eventBus.emit("sabbath.guard.status", { active, prefs });
      });
    },

    // Imperative guard for callers who open modals via function calls
    guardModal(modal = {}) {
      const verdict = shouldConvertModal(modal);
      if (
        !verdict.convert &&
        verdict.reason !== "sabbath" &&
        verdict.reason !== "quiet-hours"
      ) {
        return { cancelOriginal: false, converted: null, reason: null };
      }
      // “soften” converts to the configured alternative with read-only props + softened actions
      const softened =
        verdict.convert === "soften"
          ? Object.assign({}, modal, {
              actions: softenActions(modal.actions || []),
            })
          : modal;
      const converted = toConvertedConfig(
        softened,
        verdict.reason,
        prefs.convertStrategy
      );
      return { cancelOriginal: true, converted, reason: verdict.reason };
    },

    // Queue controls
    queueIntent,
    flushQueue,
    getQueue() {
      return queue.slice();
    },

    // Prefs
    getPrefs() {
      return Object.assign({}, prefs);
    },
    setPrefs,

    // Simple status
    isActive() {
      return isSabbath() || inQuietHours();
    },
  };

  // ------------------------------ Export --------------------------------------
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { sabbathGuard };
  } else {
    // @ts-ignore
    window.sabbathGuard = sabbathGuard;
  }

  // ------------------------------ Autoinit ------------------------------------
  sabbathGuard.init();
})();
