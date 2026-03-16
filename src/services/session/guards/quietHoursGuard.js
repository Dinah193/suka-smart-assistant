/* eslint-disable no-console */
// quietHoursGuard.js — Convert modal → notify during quiet hours, queue intents, resume later.

(function () {
  // ------------------------------ Defensive deps ------------------------------
  const isBrowser = typeof window !== "undefined";
  const now = () => Date.now();

  let eventBus = { on() {}, off() {}, emit() {} };
  try {
    const eb = require("@/services/events/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  let scheduleHelpers = null; // expects: inQuietHours(ts), nextUnquiet(ts)
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
    QUEUE: "suka:quietHoursGuard:queue:v1",
    PREFS: "suka:quietHoursGuard:prefs:v1",
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
    // Convert “modal” to one of: "toast" (heads-up), "banner" (non-sticky), "sheet" (read-only slide-up)
    convertStrategy: "toast",
    // Quiet-hours schedule can also be driven by scheduleHelpers.inQuietHours; this is a fallback
    fallbackQuietHours: { startHour: 21, endHour: 7 }, // 9pm–7am local
    // Actions allowed during quiet hours (non-destructive, low friction)
    allowedActionKinds: ["ack", "dismiss", "view", "snooze"],
    // Always allowed modal IDs (safety only)
    allowlistIds: ["safetyAlert", "biohazardWarning", "weatherEmergency"],
    // Always converted (commerce/finance/commit flows)
    blocklistIds: [
      "paymentCheckout",
      "publishPlan",
      "deleteConfirm",
      "butcheryBatchCommit",
      "gardenMassReplant",
      "inventoryBulkAdjust",
      "animalsProcedureCommit",
    ],
    // Domain sensitivity for conversion
    domainSensitivity: {
      finance: "always",
      commerce: "always",
      cleaning: "maybe",
      meals: "maybe",
      garden: "maybe",
      animals: "maybe",
      general: "maybe",
    },
    destructiveKinds: [
      "delete",
      "commit",
      "checkout",
      "purchase",
      "publish",
      "startSessionHard",
    ],
    noticeSnoozeMs: 10 * 60 * 1000, // 10 minutes
  };

  let prefs = Object.assign({}, DEFAULTS, load(K.PREFS, {}));
  let queue = load(K.QUEUE, []); // [{id, at, runAt, kind, payload}]

  const setPrefs = (patch) => {
    prefs = Object.assign({}, prefs, patch || {});
    save(K.PREFS, prefs);
    eventBus.emit("quiet.guard.prefs.updated", { prefs });
  };

  // ------------------------------ Helpers ------------------------------------
  function _inFallbackQuiet(ts = now()) {
    try {
      const d = new Date(ts);
      const hour = d.getHours();
      const { startHour, endHour } = prefs.fallbackQuietHours || {};
      if (typeof startHour !== "number" || typeof endHour !== "number")
        return false;
      if (startHour < endHour) return hour >= startHour && hour < endHour; // e.g., 21→23
      return hour >= startHour || hour < endHour; // spans midnight (default)
    } catch {
      return false;
    }
  }

  function inQuietHours(ts = now()) {
    if (scheduleHelpers && typeof scheduleHelpers.inQuietHours === "function") {
      try {
        return !!scheduleHelpers.inQuietHours(ts);
      } catch {
        /* fall through */
      }
    }
    return _inFallbackQuiet(ts);
  }

  function nextUnquiet(ts = now()) {
    if (scheduleHelpers && typeof scheduleHelpers.nextUnquiet === "function") {
      try {
        return scheduleHelpers.nextUnquiet(ts) || null;
      } catch {
        /* fall through */
      }
    }
    // naive fallback: if we're quiet, next unquiet is today/tomorrow endHour
    try {
      const d = new Date(ts);
      const { endHour } = prefs.fallbackQuietHours || {};
      if (typeof endHour !== "number") return null;
      const candidate = new Date(d);
      if (inQuietHours(ts)) {
        // if current hour < endHour: today at endHour; else: tomorrow at endHour
        if (d.getHours() < endHour) {
          candidate.setHours(endHour, 0, 0, 0);
        } else {
          candidate.setDate(candidate.getDate() + 1);
          candidate.setHours(endHour, 0, 0, 0);
        }
      } else {
        return ts; // already unquiet
      }
      return candidate.getTime();
    } catch {
      return null;
    }
  }

  function shouldConvertModal(modal = {}) {
    if (!prefs.enabled) return { convert: false, reason: null };
    if (!inQuietHours()) return { convert: false, reason: null };

    // Always allow safety
    if (prefs.allowlistIds.includes(modal.id))
      return { convert: false, reason: null };

    // Always convert blocklist
    if (prefs.blocklistIds.includes(modal.id))
      return { convert: true, reason: "quiet-hours" };

    const sensitivity =
      prefs.domainSensitivity[modal.domain || "general"] || "maybe";
    if (sensitivity === "always")
      return { convert: true, reason: "quiet-hours" };

    // Convert if destructive
    const kinds = (modal.actions || []).map((a) => a.kind);
    if (kinds.some((k) => prefs.destructiveKinds.includes(k))) {
      return { convert: true, reason: "quiet-hours" };
    }

    // Otherwise “soften”: allow read-only or queue actions
    return { convert: "soften", reason: "quiet-hours" };
  }

  function softenActions(actions = []) {
    const kept = actions.filter((a) =>
      prefs.allowedActionKinds.includes(a.kind)
    );
    const replaced = actions
      .filter((a) => !prefs.allowedActionKinds.includes(a.kind))
      .map((a) => ({
        id: `${a.id}-queue`,
        label: `${a.label} (after quiet hours)`,
        kind: "queueAfterQuietHours",
        original: a,
      }));
    return [...kept, ...replaced];
  }

  function toConvertedConfig(modal, reason, strategy = prefs.convertStrategy) {
    const runAt = nextUnquiet() || now() + 8 * 60 * 60 * 1000;
    const baseMsg =
      "This action is paused for quiet hours. I’ll resume it at a better time.";

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
              kind: "queueAfterQuietHours",
            },
            { id: "dismiss", label: "Dismiss", kind: "dismiss" },
          ],
        },
      };
    }

    if (strategy === "banner") {
      return {
        type: "banner",
        cancelOriginal: true,
        payload: {
          id: `${modal.id}-banner`,
          title: modal.title || "Deferred during quiet hours",
          message: baseMsg,
          runAt,
          domain: modal.domain || "general",
          actions: [
            {
              id: "queueResume",
              label: "Resume after",
              kind: "queueAfterQuietHours",
            },
            {
              id: "snooze",
              label: "Snooze",
              kind: "snooze",
              payload: { ms: prefs.noticeSnoozeMs },
            },
          ],
        },
      };
    }

    // "sheet" (read-only)
    return {
      type: "sheet",
      cancelOriginal: true,
      payload: {
        id: `${modal.id}-converted`,
        title: modal.title || "Action deferred",
        subhead: baseMsg,
        domain: modal.domain || "general",
        reason,
        runAt,
        readOnly: true,
        component: modal.component || null,
        props: Object.assign({}, modal.props || {}, { readOnly: true }),
        actions: [
          { id: "ack", label: "OK", kind: "ack" },
          {
            id: "queueResume",
            label: "Resume after",
            kind: "queueAfterQuietHours",
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
    eventBus.emit("quiet.queue.updated", { size: queue.length });
    if (automation?.notify) {
      automation.notify({
        title: "Queued for later",
        message: "I’ll resume this after quiet hours.",
        scope: "local",
        severity: "info",
        ts: now(),
        tags: ["quiet-hours", "queue"],
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

    ready.forEach((item) => {
      try {
        if (item.kind === "openModal") {
          eventBus.emit("ui.modal.open", item.payload);
        } else if (item.kind === "fireEvent") {
          const { name, data } = item.payload || {};
          if (name) eventBus.emit(name, data || {});
        }
      } catch (e) {
        console.error("[quietHoursGuard] flushQueue item error:", e);
      }
    });

    queue = pending;
    save(K.QUEUE, queue);
    eventBus.emit("quiet.queue.flushed", {
      executed: ready.length,
      remaining: queue.length,
    });
  }

  // ------------------------------ Guard API ----------------------------------
  const quietHoursGuard = {
    init(userPrefs = {}) {
      setPrefs(userPrefs);

      // Intercept modal opens
      eventBus.on("ui.modal.open", (modal = {}) => {
        const { convert, reason } = shouldConvertModal(modal);

        if (!convert) {
          // If we're *in* quiet hours but "soften", strip disallowed actions and show notify
          if (reason === "quiet-hours") {
            const softened = Object.assign({}, modal, {
              actions: softenActions(modal.actions || []),
            });
            const converted = toConvertedConfig(
              softened,
              reason,
              prefs.convertStrategy
            );
            eventBus.emit("ui.modal.converted", converted);
            // Fire notify for awareness
            if (automation?.notify && converted?.payload?.title) {
              automation.notify({
                title: converted.payload.title,
                message: "Converted for quiet hours.",
                scope: "local",
                severity: "info",
                ts: now(),
                tags: ["quiet-hours", "converted"],
              });
            }
          }
          return;
        }

        // Convert or block outright
        const converted = toConvertedConfig(
          modal,
          reason,
          prefs.convertStrategy
        );
        eventBus.emit("ui.modal.converted", converted);

        // Also show a quick notification
        if (automation?.notify) {
          automation.notify({
            title: modal.title || "Action deferred",
            message: "Paused for quiet hours.",
            scope: "local",
            severity: "info",
            ts: now(),
            tags: ["quiet-hours", "converted-modal"],
          });
        }
      });

      // Handle post-conversion actions
      eventBus.on("ui.action.invoked", (e = {}) => {
        const kind = e.action?.kind;
        if (kind === "queueAfterQuietHours") {
          const resumeAt = nextUnquiet() || now() + 8 * 60 * 60 * 1000;
          const payload =
            e.context?.modal?.original || e.context?.card?.original || {};
          queueIntent(
            "openModal",
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
          queueIntent(
            "openModal",
            e.context?.modal?.original || e.context?.card?.original || {},
            now() + ms
          );
        }
      });

      // Auto-flush when quiet hours lift
      if (isBrowser) {
        setInterval(() => {
          if (!inQuietHours()) flushQueue(false);
        }, 60 * 1000);
      }

      // If RelativeScheduler muted a reminder (on another guard), mirror notify here too
      eventBus.on("relative.reminder.muted", (e = {}) => {
        if ((e.mutedBecause || "").includes("quiet")) {
          const payload = {
            title: e.title || "Reminder",
            message: "Queued for after quiet hours.",
            runAt: nextUnquiet() || null,
            modalId: `reminder:${e.itemId}`,
            domain: e.domain || "general",
          };
          eventBus.emit("ui.toast.show", payload);
        }
      });

      // HUD ping
      eventBus.on("quiet.guard.status.requested", () => {
        const active = inQuietHours();
        eventBus.emit("quiet.guard.status", { active, prefs });
      });
    },

    // Imperative guard (if callers bypass ui.modal.open)
    guardModal(modal = {}) {
      const verdict = shouldConvertModal(modal);
      if (!verdict.convert && verdict.reason !== "quiet-hours") {
        return { cancelOriginal: false, converted: null, reason: null };
      }
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

    // Status
    isActive() {
      return inQuietHours();
    },
  };

  // ------------------------------ Export --------------------------------------
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { quietHoursGuard };
  } else {
    // @ts-ignore
    window.quietHoursGuard = quietHoursGuard;
  }

  // ------------------------------ Autoinit ------------------------------------
  quietHoursGuard.init();
})();
