/* eslint-disable no-console */
// RelativeScheduler.js — event-anchored scheduler (pause-aware, domain-aware, Sabbath/quiet-hours friendly)
//
// HOW THIS FITS IN SSA:
// 1. Imports (recipe, cleaning, garden/seed, animal/butchery, storehouse, video/how-to) can eventually
//    create sessions → "session.started" / "session.paused" / "session.resumed" / "session.ended".
// 2. This file takes those sessions and builds *relative* timelines for sub-steps (prep, proof, ferment,
//    "go water now", "check dehydrator", "turn compost", "open brooder", etc.).
// 3. It is *guard-aware* (Sabbath, quiet hours, domain-withholds, even weather if your scheduleHelpers
//    exposes it).
// 4. It emits events back into the shared eventBus **using a consistent shape**:
//
//    {
//      type: "relative.schedule.created",     // or other
//      ts: "2025-11-01T13:00:00.000Z",
//      source: "RelativeScheduler",
//      data: { ...domain data... }
//    }
//
// 5. If SSA is running with familyFundMode=true (SSA still owns the data first), we mirror
//    schedule/anchor changes up to the Hub so SSA → SVFFH can keep storehouse / shared sessions in sync.

(function () {
  // ------------------------------ Defensive deps ------------------------------
  const isBrowser = typeof window !== "undefined";
  const now = () => Date.now();
  const EVENT_SOURCE = "RelativeScheduler";

  let eventBus = { on() {}, off() {}, emit() {} };
  try {
    const eb = require("@/services/events/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  // SSA → Hub export (optional; fails silently)
  let featureFlags = { familyFundMode: false };
  try {
    // best-effort; if you keep feature flags in another file, this stays harmless
    featureFlags = require("@/config/featureFlags.json") || featureFlags;
  } catch (_e) {}

  let HubPacketFormatter = null;
  try {
    HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  } catch (_e) {}

  let FamilyFundConnector = null;
  try {
    FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
  } catch (_e) {}

  function exportToHubIfEnabled(payload) {
    // We only mirror household-ish data: created anchors, schedules, session-related updates.
    if (!featureFlags?.familyFundMode) return;
    try {
      const packet = HubPacketFormatter
        ? HubPacketFormatter.format("scheduler", payload)
        : { kind: "scheduler", payload };
      if (
        FamilyFundConnector &&
        typeof FamilyFundConnector.send === "function"
      ) {
        FamilyFundConnector.send(packet);
      }
    } catch (_err) {
      // silent fail — SSA must run by itself
    }
  }

  // unified event emitter for this file
  function emitEvent(type, data) {
    const payload = {
      type,
      ts: new Date().toISOString(),
      source: EVENT_SOURCE,
      data: data || {},
    };

    // to shared bus
    try {
      eventBus.emit(type, payload);
    } catch (_e) {}

    // ALSO: if automation runtime is present (we load it defensively below),
    // let it hear the same event — this keeps SSA’s automation "listening" to the same shape.
    try {
      if (automation && typeof automation.emitEvent === "function") {
        automation.emitEvent(type, payload);
      }
    } catch (_e) {}
  }

  let scheduleHelpers = null; // optional: isSabbath(ts), inQuietHours(ts), nextUnquiet(ts), withholdsForDomain(domain)
  try {
    scheduleHelpers = require("@/services/scheduleHelpers");
  } catch (_e) {}

  let estimateEngine = null; // optional: for ETA/window refinements
  try {
    estimateEngine = require("@/services/estimateEngine");
  } catch (_e) {}

  let automation = null; // optional: in-app notifications/toasts
  try {
    automation =
      (require("@/services/automation/runtime") || {}).automation || null;
  } catch (_e) {}

  // NEW (DI-safe): prefs + offset parser for repeat engine
  let getSchedulerPrefs = () => ({
    user: { locale: "en-US", timeZone: "America/Chicago" },
    quietHours: { enabled: false, start: "22:00", end: "06:00" },
    sabbathGuard: { enabled: false },
  });
  try {
    const p = require("@/stores/scheduler/prefs");
    if (p && typeof p.getSchedulerPrefs === "function")
      getSchedulerPrefs = p.getSchedulerPrefs;
  } catch (_e) {}

  let offsetParser = null; // { toMs(expr) }
  try {
    offsetParser = require("@/services/session/utils/offsetParser");
  } catch (_e) {}

  // ------------------------------ Small utils --------------------------------
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
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
  const uid = (p = "rs") =>
    `${p}:${Math.random().toString(36).slice(2)}:${Date.now().toString(36)}`;

  const toTs = (x) =>
    x instanceof Date
      ? x.getTime()
      : typeof x === "number"
      ? x
      : Date.parse(x || 0);

  // Local-time helpers (no external libs; use Intl parts)
  function zonedParts(ts, tz) {
    try {
      const fmt = new Intl.DateTimeFormat(
        getSchedulerPrefs().user?.locale || undefined,
        {
          timeZone: tz,
          hour12: false,
          weekday: "short",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }
      );
      const parts = Object.fromEntries(
        fmt.formatToParts(ts).map((p) => [p.type, p.value])
      );
      const mapW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      const wd = mapW[parts.weekday] ?? 0;
      const y = parseInt(parts.year, 10);
      const m = parseInt(parts.month, 10);
      const d = parseInt(parts.day, 10);
      const hh = parseInt(parts.hour, 10);
      const mm = parseInt(parts.minute, 10);
      const ss = parseInt(parts.second, 10);
      return {
        weekday: wd,
        year: y,
        month: m,
        day: d,
        hour: hh,
        minute: mm,
        second: ss,
      };
    } catch {
      const d = new Date(ts);
      return {
        weekday: d.getUTCDay(),
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes(),
        second: d.getUTCSeconds(),
      };
    }
  }
  const pad2 = (n) => String(n).padStart(2, "0");

  // HH:MM parsing
  function parseHHMM(s) {
    if (!s || typeof s !== "string") return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return null;
    const h = clamp(parseInt(m[1], 10), 0, 23);
    const mm = clamp(parseInt(m[2], 10), 0, 59);
    return { h, m: mm };
  }

  // Convert "+20m" / "PT15M" / 900000 -> ms
  function toMs(expr) {
    if (!expr && expr !== 0) return 0;
    if (typeof expr === "number") return expr;
    if (offsetParser?.toMs) {
      try {
        return offsetParser.toMs(expr);
      } catch {}
    }
    const s = String(expr).trim();

    const sh = /^\+?(\d+)\s*([smhd])$/i.exec(s);
    if (sh) {
      const n = parseInt(sh[1], 10);
      const u = sh[2].toLowerCase();
      return u === "s"
        ? n * 1000
        : u === "m"
        ? n * 60000
        : u === "h"
        ? n * 3600000
        : n * 86400000;
    }
    const iso = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(
      s
    );
    if (iso) {
      const d = parseInt(iso[1] || "0", 10);
      const h = parseInt(iso[2] || "0", 10);
      const m = parseInt(iso[3] || "0", 10);
      const sec = parseInt(iso[4] || "0", 10);
      return d * 86400000 + h * 3600000 + m * 60000 + sec * 1000;
    }
    return Number(s) || 0;
  }

  // ------------------------------ Persistence --------------------------------
  const STORE_KEY = "suka:relativeScheduler:v1";
  const loadStore = () => {
    if (!isBrowser) return { anchors: {}, indexBySession: {} };
    return safeJSON.parse(window.localStorage.getItem(STORE_KEY), {
      anchors: {},
      indexBySession: {},
    });
  };
  const saveStore = (s) => {
    if (isBrowser)
      window.localStorage.setItem(STORE_KEY, safeJSON.stringify(s));
  };

  // Shape:
  // anchors[anchorId] = {
  //   anchorId, sessionId, domain, startedAt, endedAt: null|number,
  //   totalPausedMs, lastPausedAt: null|number,
  //   items: [{id, title, offsetMs, windowMs?, suspendable?, kind?, payload?, domain?, status, dueAt, windowEndAt }],
  //   meta: { createdAt, createdBy, labels:[], notes:"", tickMs }
  // }
  // indexBySession[sessionId] = [anchorId...]

  let store = loadStore();

  // ------------------------------ Core math ----------------------------------
  const isSabbath = (ts) =>
    !!(
      scheduleHelpers &&
      scheduleHelpers.isSabbath &&
      scheduleHelpers.isSabbath(ts)
    );
  const inQuietHours = (ts) =>
    !!(
      scheduleHelpers &&
      scheduleHelpers.inQuietHours &&
      scheduleHelpers.inQuietHours(ts)
    );
  const nextUnquiet = (ts) =>
    (scheduleHelpers &&
      scheduleHelpers.nextUnquiet &&
      scheduleHelpers.nextUnquiet(ts)) ||
    null;
  function withholdsForDomain(domain) {
    if (!scheduleHelpers || !scheduleHelpers.withholdsForDomain) return [];
    try {
      return scheduleHelpers.withholdsForDomain(domain) || [];
    } catch {
      return [];
    }
  }

  function effectiveAnchorElapsed(anchor) {
    // elapsed since startedAt minus totalPaused (and exclude current pause span if paused)
    const base = now() - anchor.startedAt - (anchor.totalPausedMs || 0);
    if (anchor.lastPausedAt) {
      return Math.max(
        0,
        anchor.lastPausedAt - anchor.startedAt - (anchor.totalPausedMs || 0)
      );
    }
    return Math.max(0, base);
  }

  function computeDueTimes(anchor) {
    anchor.items.forEach((it) => {
      it.dueAt =
        anchor.startedAt + (it.offsetMs || 0) + (anchor.totalPausedMs || 0);
      if (it.windowMs) it.windowEndAt = it.dueAt + it.windowMs;
    });
  }

  // ------------------------------ Engine state -------------------------------
  let ticking = false;
  let tickHandle = null;
  let TICK_MS = 1000; // default 1s

  function startTicker() {
    if (ticking) return;
    ticking = true;
    const loop = () => {
      try {
        tick();
      } catch (e) {
        console.error("[RelativeScheduler] tick error:", e);
      }
      tickHandle = setTimeout(loop, TICK_MS);
    };
    tickHandle = setTimeout(loop, TICK_MS);
  }

  function stopTicker() {
    ticking = false;
    if (tickHandle) clearTimeout(tickHandle);
    tickHandle = null;
  }

  // ------------------------------ Emits & NBA --------------------------------
  function emitDue(anchor, it, reason) {
    const ts = now();
    const basePayload = {
      anchorId: anchor.anchorId,
      sessionId: anchor.sessionId,
      domain: it.domain || anchor.domain || null,
      itemId: it.id,
      title: it.title,
      kind: it.kind || "reminder",
      dueAt: it.dueAt,
      windowEndAt: it.windowEndAt || null,
      reason, // "due" | "windowClosing" | "unquietReady" | "withholdLifted"
      payload: it.payload || {},
      meta: {
        createdAt: anchor.meta?.createdAt,
        labels: anchor.meta?.labels || [],
      },
    };

    // Sabbath / Quiet Hours guard:
    if (isSabbath(ts) || inQuietHours(ts)) {
      emitEvent("relative.reminder.muted", {
        ...basePayload,
        muted: true,
        mutedBecause: isSabbath(ts) ? "sabbath" : "quiet-hours",
      });
      const nextOk = nextUnquiet(ts);
      if (nextOk && automation?.notify) {
        automation.notify({
          title: `Queued: ${it.title}`,
          message: isSabbath(ts)
            ? "Sabbath quiet period—I'll remind you after."
            : "Quiet hours—I'll remind you when it's a better time.",
          ts,
          scope: "local",
          severity: "info",
          tags: ["scheduler", "muted", reason],
        });
      }
      return;
    }

    // Domain withholds (e.g., weather/biohazard/appliance) → nudge NBA instead of hard reminder
    const withholds = withholdsForDomain(basePayload.domain);
    const activeWithholds = withholds.filter((w) => !w.until || w.until > ts);
    if (activeWithholds.length > 0) {
      emitEvent("planner.conflict.detected", {
        kind: activeWithholds[0].kind || "withhold",
        until: activeWithholds[0].until || null,
        domain: basePayload.domain,
        source: "RelativeScheduler",
        item: basePayload,
      });
      emitEvent("nba.suggestion.requested", {
        context: "withhold",
        item: basePayload,
        reasons: activeWithholds.map((w) => w.kind),
      });
      return;
    }

    // Standard due event
    emitEvent("relative.reminder.due", basePayload);

    if (automation?.notify) {
      automation.notify({
        title: it.title || "Reminder",
        message: it.kind === "deadline" ? "Deadline reached." : "Task due.",
        ts,
        scope: "local",
        severity: "info",
        tags: ["scheduler", reason, basePayload.domain || "general"],
      });
    }
  }

  // ------------------------------ Tick loop ----------------------------------
  function tick() {
    const ts = now();
    let changed = false;

    Object.values(store.anchors).forEach((anchor) => {
      if (!anchor || anchor.endedAt) return;
      if (!anchor.items?.length) return;

      anchor.items.forEach((it) => {
        if (
          it.status === "done" ||
          it.status === "skipped" ||
          it.status === "muted"
        )
          return;

        // Initialize due/window once
        if (typeof it.dueAt !== "number") {
          it.dueAt =
            anchor.startedAt + (it.offsetMs || 0) + (anchor.totalPausedMs || 0);
          if (it.windowMs) it.windowEndAt = it.dueAt + it.windowMs;
        }

        // Pause-aware: suspendable items freeze while paused
        if (anchor.lastPausedAt && it.suspendable) {
          const sinceLast = ts - (it._lastPauseNudgeAt || 0);
          if (
            it.windowEndAt &&
            it.windowEndAt - ts < 45 * 60 * 1000 &&
            sinceLast > 15 * 60 * 1000
          ) {
            it._lastPauseNudgeAt = ts;
            emitEvent("relative.timer.suspend.suggested", {
              anchorId: anchor.anchorId,
              itemId: it.id,
              title: it.title,
              domain: it.domain || anchor.domain || null,
              message: "This step is paused. Keep it paused or resume soon?",
              windowClosingInMs: clamp(
                it.windowEndAt - ts,
                0,
                it.windowMs || 0
              ),
            });
          }
          return;
        }

        // Window closing heads-up (~33% into window)
        if (
          it.windowMs &&
          ts >= it.dueAt &&
          ts < it.windowEndAt &&
          !it._windowWarned
        ) {
          const progress = (ts - it.dueAt) / it.windowMs;
          if (progress > 1 / 3) {
            it._windowWarned = true;
            emitDue(anchor, it, "windowClosing");
            changed = true;
          }
        }

        // Primary due
        if (ts >= it.dueAt && !it._emitted) {
          it._emitted = true;
          emitDue(anchor, it, "due");
          changed = true;
        }

        // Resurface after quiet period
        if ((isSabbath(ts) || inQuietHours(ts)) && !it._mutedFlagged) {
          it._mutedFlagged = true;
        } else if (
          !isSabbath(ts) &&
          !inQuietHours(ts) &&
          it._mutedFlagged &&
          ts >= it.dueAt
        ) {
          it._mutedFlagged = false;
          emitDue(anchor, it, "unquietReady");
          changed = true;
        }
      });
    });

    if (changed) saveStore(store);
  }

  // ------------------------------ Public API ---------------------------------
  const relativeScheduler = {
    init(options = {}) {
      TICK_MS = clamp(options.tickMs || 1000, 250, 5000);
      if (options.autostart !== false) startTicker();

      // Session lifecycle
      eventBus.on("session.started", (e = {}) => {
        // e: { sessionId, domain?, startedAt?, anchorId? }
        const anchorId = e.anchorId || uid("anchor");
        const created = relativeScheduler.createAnchor({
          anchorId,
          sessionId: e.sessionId,
          domain: e.domain || null,
          startedAt: e.startedAt || now(),
          meta: {
            createdAt: now(),
            createdBy: e.userId || "system",
            labels: ["session"],
            tickMs: TICK_MS,
          },
        });
        emitEvent("relative.schedule.anchor.created", {
          sessionId: e.sessionId,
          anchorId,
        });
        // if SSA is in familyFundMode, mirror anchor creation
        exportToHubIfEnabled({
          action: "anchor.created",
          sessionId: e.sessionId,
          anchorId,
          domain: e.domain || null,
          meta: created?.meta || {},
        });
      });

      eventBus.on("session.paused", (e = {}) => {
        if (e.anchorId) {
          relativeScheduler.pauseAnchor(e.anchorId);
        }
      });
      eventBus.on("session.resumed", (e = {}) => {
        if (e.anchorId) {
          relativeScheduler.resumeAnchor(e.anchorId);
        }
      });
      eventBus.on("session.ended", (e = {}) => {
        if (e.anchorId) {
          relativeScheduler.endAnchor(e.anchorId);
        }
      });

      // Conflicts mark item as withheld (domain aware)
      eventBus.on("planner.conflict.detected", (e = {}) => {
        // e: { kind, until?, domain, item? }
        if (!e.item?.anchorId) return;
        const anchor = store.anchors[e.item.anchorId];
        if (!anchor) return;
        const it = anchor.items.find((x) => x.id === e.item.itemId);
        if (!it) return;
        it.status = "withheld";
        it._withheldUntil = e.until || null;
        saveStore(store);
        emitEvent("relative.schedule.item.withheld", {
          anchorId: e.item.anchorId,
          itemId: e.item.itemId,
          until: e.until || null,
          domain: e.domain || anchor.domain || null,
          reason: e.kind || "withhold",
        });
      });

      // FUTURE DOMAINS:
      //  - eventBus.on("preservation/session/schedule", ...)
      //  - eventBus.on("storehouse/session/schedule", ...)
      // Keep them thin — just call createAnchor + schedule(...) like above.
    },

    // Create a new anchor or get existing
    createAnchor({
      anchorId,
      sessionId,
      domain = null,
      startedAt = now(),
      meta = {},
    }) {
      if (!anchorId) anchorId = uid("anchor");
      if (!store.anchors[anchorId]) {
        store.anchors[anchorId] = {
          anchorId,
          sessionId,
          domain,
          startedAt,
          endedAt: null,
          totalPausedMs: 0,
          lastPausedAt: null,
          items: [],
          meta: {
            createdAt: meta.createdAt || now(),
            createdBy: meta.createdBy || "system",
            labels: meta.labels || [],
            notes: meta.notes || "",
            tickMs: meta.tickMs || TICK_MS,
          },
        };
        if (!store.indexBySession[sessionId])
          store.indexBySession[sessionId] = [];
        if (!store.indexBySession[sessionId].includes(anchorId))
          store.indexBySession[sessionId].push(anchorId);
        saveStore(store);
      }
      startTicker();
      return store.anchors[anchorId];
    },

    // Schedule items relative to an anchor start
    // items: [{ id?, title, offsetMs, windowMs?, suspendable?, kind?, payload?, domain? }]
    schedule(anchorId, items = [], _options = {}) {
      const anchor = store.anchors[anchorId];
      if (!anchor) throw new Error("Anchor not found");

      // Optional ETA polish
      const polishETA = (it) => {
        if (!estimateEngine || !estimateEngine.refine) return it;
        try {
          return estimateEngine.refine(it) || it;
        } catch {
          return it;
        }
      };

      const enriched = items.map((raw) => {
        const id = raw.id || uid("item");
        const base = {
          id,
          title: raw.title || "Reminder",
          kind: raw.kind || "reminder",
          offsetMs: Math.max(0, raw.offsetMs || 0),
          windowMs: raw.windowMs || null,
          suspendable: !!raw.suspendable,
          payload: raw.payload || {},
          domain: raw.domain || anchor.domain || null,
          status: "scheduled",
        };
        return polishETA(base);
      });

      anchor.items.push(...enriched);
      computeDueTimes(anchor);
      saveStore(store);

      emitEvent("relative.schedule.created", {
        anchorId,
        sessionId: anchor.sessionId,
        domain: anchor.domain,
        count: enriched.length,
        items: enriched.map((i) => ({
          id: i.id,
          title: i.title,
          dueAt: i.dueAt,
        })),
      });

      // Mirror to Hub as "this session now has timed sub-steps"
      exportToHubIfEnabled({
        action: "relative.schedule.created",
        anchorId,
        sessionId: anchor.sessionId,
        domain: anchor.domain,
        items: enriched.map((i) => ({
          id: i.id,
          title: i.title,
          dueAt: i.dueAt,
        })),
      });

      if (automation?.seed) {
        try {
          automation.seed({
            title: "Relative schedule",
            prompt: "Show upcoming steps from the current session anchor.",
            items: enriched.map((i) => ({
              id: i.id,
              title: i.title,
              dueAt: i.dueAt,
            })),
          });
        } catch (_e) {}
      }

      startTicker();
      return enriched.map((i) => i.id);
    },

    // Convenience: anchor “recipe”/“procedure” with suspendable steps
    scheduleRecipeRun({ anchorId, domain, plan }) {
      // plan: [{ title, at: "T+5m"|numberMs, window: "20m?"|numberMs, suspendable?, kind?, payload?, domain? }]
      const parseToMs = (expr) => {
        if (typeof expr === "number") return expr;
        if (!expr) return 0;
        const s = ("" + expr).replace(/^T\+/i, "").trim();
        const m = s.match(/^(\d+)\s*(ms|s|m|h|d)?/i);
        if (!m) return 0;
        const n = parseInt(m[1], 10);
        const unit = (m[2] || "ms").toLowerCase();
        const mult =
          unit === "d"
            ? 86400000
            : unit === "h"
            ? 3600000
            : unit === "m"
            ? 60000
            : unit === "s"
            ? 1000
            : 1;
        return n * mult;
      };

      const items = (plan || []).map((p) => ({
        title: p.title,
        kind: p.kind || "reminder",
        offsetMs: parseToMs(p.at),
        windowMs: p.window ? parseToMs(p.window) : null,
        suspendable: !!p.suspendable || p.suspendable === undefined, // default true
        payload: p.payload || {},
        domain: p.domain || domain || null,
      }));

      return this.schedule(anchorId, items);
    },

    // Mark specific item done/skip
    completeItem(anchorId, itemId, outcome = "done") {
      const anchor = store.anchors[anchorId];
      if (!anchor) return;
      const it = anchor.items.find((x) => x.id === itemId);
      if (!it) return;
      it.status = outcome === "skip" ? "skipped" : "done";
      saveStore(store);
      emitEvent("relative.schedule.item.completed", {
        anchorId,
        itemId,
        outcome,
      });
      // Hub mirror: household made progress on timed step
      exportToHubIfEnabled({
        action: "relative.schedule.item.completed",
        anchorId,
        itemId,
        outcome,
      });
    },

    // Pause/resume anchor (session)
    pauseAnchor(anchorId) {
      const anchor = store.anchors[anchorId];
      if (!anchor || anchor.lastPausedAt) return;
      anchor.lastPausedAt = now();
      saveStore(store);
      emitEvent("relative.schedule.anchor.paused", { anchorId });
      exportToHubIfEnabled({
        action: "relative.schedule.anchor.paused",
        anchorId,
      });
    },

    resumeAnchor(anchorId) {
      const anchor = store.anchors[anchorId];
      if (!anchor || !anchor.lastPausedAt) return;
      const pausedSpan = now() - anchor.lastPausedAt;
      anchor.totalPausedMs = (anchor.totalPausedMs || 0) + pausedSpan;
      anchor.lastPausedAt = null;

      // Shift dueAt/windowEndAt forward by pausedSpan for suspendable items; leave others unchanged
      anchor.items.forEach((it) => {
        if (it.suspendable) {
          if (typeof it.dueAt === "number") it.dueAt += pausedSpan;
          if (typeof it.windowEndAt === "number") it.windowEndAt += pausedSpan;
        }
      });

      saveStore(store);
      emitEvent("relative.schedule.anchor.resumed", { anchorId });
      exportToHubIfEnabled({
        action: "relative.schedule.anchor.resumed",
        anchorId,
      });
    },

    endAnchor(anchorId) {
      const anchor = store.anchors[anchorId];
      if (!anchor || anchor.endedAt) return;
      if (anchor.lastPausedAt) this.resumeAnchor(anchorId); // normalize pauses
      anchor.endedAt = now();
      saveStore(store);
      emitEvent("relative.schedule.anchor.ended", { anchorId });
      exportToHubIfEnabled({
        action: "relative.schedule.anchor.ended",
        anchorId,
      });
    },

    cancelAnchor(anchorId) {
      const anchor = store.anchors[anchorId];
      if (!anchor) return;
      const { sessionId } = anchor;
      delete store.anchors[anchorId];
      if (sessionId && store.indexBySession[sessionId]) {
        store.indexBySession[sessionId] = store.indexBySession[
          sessionId
        ].filter((x) => x !== anchorId);
      }
      saveStore(store);
      emitEvent("relative.schedule.anchor.canceled", { anchorId });
      exportToHubIfEnabled({
        action: "relative.schedule.anchor.canceled",
        anchorId,
      });
    },

    // Queries
    getAnchor(anchorId) {
      return store.anchors[anchorId] || null;
    },
    listAnchorsBySession(sessionId) {
      const ids = store.indexBySession[sessionId] || [];
      return ids.map((id) => store.anchors[id]).filter(Boolean);
    },
    listUpcoming(anchorId, withinMs = 60 * 60 * 1000) {
      const anchor = store.anchors[anchorId];
      if (!anchor) return [];
      const ts = now();
      return anchor.items
        .filter((it) => !["done", "skipped"].includes(it.status))
        .filter(
          (it) =>
            typeof it.dueAt === "number" &&
            it.dueAt >= ts &&
            it.dueAt <= ts + withinMs
        )
        .sort((a, b) => a.dueAt - b.dueAt)
        .map((it) => ({
          id: it.id,
          title: it.title,
          dueAt: it.dueAt,
          windowEndAt: it.windowEndAt || null,
          suspendable: it.suspendable,
          kind: it.kind,
        }));
    },

    // Admin/debug
    _resetAll() {
      store = { anchors: {}, indexBySession: {} };
      saveStore(store);
    },
    _stop() {
      stopTicker();
    },
    _start() {
      startTicker();
    },
  };

  // ------------------------------ NEW: Repeat Engine --------------------------
  /**
   * Generate repeated timestamps with guard-aware anchors.
   * input: {
   *   startAt: number|string|Date,
   *   repeatEvery: string|number,        // e.g. "PT15M", "+20m", 900000
   *   count?: number,                    // mutually exclusive with untilTs/anchor
   *   untilTs?: number,                  // hard upper bound (ms epoch)
   *   untilAnchor?: "endOfDay"|"sabbathEnd"|"quietEnd"|string,
   *   guards?: { quietHours?: {...}, sabbathGuard?: {...} },
   *   favorite?: { isFavorite?: boolean, overrides?: { repeatEvery?: string|number } }
   * }
   * returns: { occurrences:number[], meta:{ trimmedBy?:string, skippedByGuards?:boolean } }
   */
  function generateRepeats(input, nowMs) {
    const prefs = getSchedulerPrefs();
    const tz = prefs.user?.timeZone || "America/Chicago";
    const base = typeof nowMs === "number" ? nowMs : toTs(input.startAt);
    const startAt = toTs(input.startAt) || base;
    const favEvery = input.favorite?.overrides?.repeatEvery;
    const cadenceMs = toMs(favEvery ?? input.repeatEvery);
    const count = input.count != null ? Math.max(0, Number(input.count)) : null;

    if (!cadenceMs || cadenceMs <= 0)
      return { occurrences: [], meta: { skippedByGuards: false } };

    // Upper bound resolution: untilTs takes precedence
    let trimmedBy;
    let upperBound = null;
    if (typeof input.untilTs === "number") {
      upperBound = input.untilTs;
      trimmedBy = "untilTs";
    } else if (input.untilAnchor) {
      upperBound = resolveAnchor(input.untilAnchor, {
        baseTs: startAt,
        guards: input.guards,
      });
      trimmedBy = input.untilAnchor;
    }

    const out = [];
    if (count && !upperBound) {
      for (let i = 0; i < count; i++) out.push(startAt + i * cadenceMs);
      return { occurrences: out, meta: {} };
    }

    // open-ended to anchor/ts
    let cur = startAt;
    const maxIterations = 5000; // safety cap
    for (let i = 0; i < maxIterations; i++) {
      if (upperBound != null && cur > upperBound) break;
      out.push(cur);
      cur += cadenceMs;
    }
    return { occurrences: out, meta: { trimmedBy } };
  }

  /**
   * Resolve named anchors to an absolute ms epoch using scheduler prefs/timezone.
   * Supports: "endOfDay" | "quietEnd" | "sabbathEnd"
   */
  function resolveAnchor(anchor, { baseTs, guards } = {}) {
    const prefs = getSchedulerPrefs();
    const tz = prefs.user?.timeZone || "America/Chicago";
    const q = (guards && guards.quietHours) ||
      prefs.quietHours || { enabled: false };
    const sab = (guards && guards.sabbathGuard) ||
      prefs.sabbathGuard || { enabled: false };
    const parts = zonedParts(baseTs, tz);

    // Compute local midnight epoch approximation (avoid DST complexity; sufficient for trimming)
    const msSinceStartOfDay =
      parts.hour * 3600000 + parts.minute * 60000 + parts.second * 1000;
    const localMidnight = baseTs - msSinceStartOfDay;

    if (anchor === "endOfDay") {
      // End of local day ≈ midnight + 24h - 1ms
      return localMidnight + 24 * 3600000 - 1;
    }

    if (anchor === "quietEnd") {
      if (!q?.enabled) return localMidnight + 24 * 3600000 - 1;
      const start = parseHHMM(q.start || "22:00") || { h: 22, m: 0 };
      const end = parseHHMM(q.end || "06:00") || { h: 6, m: 0 };
      const curMin = parts.hour * 60 + parts.minute;
      const sMin = start.h * 60 + start.m;
      const eMin = end.h * 60 + end.m;

      let endDayOffset = 0;
      let endMinTotal = eMin;

      if (sMin <= eMin) {
        // Quiet window is same-day (e.g., 20:00–23:00)
        // If we're currently inside (curMin in [sMin, eMin)), quietEnd is today at eMin; else next occurrence's end
        if (curMin >= sMin && curMin < eMin) {
          endDayOffset = 0;
          endMinTotal = eMin;
        } else {
          // next day's end
          endDayOffset = curMin < sMin ? 0 : 1;
          endMinTotal = eMin;
        }
      } else {
        // Cross-midnight (e.g., 22:00–06:00). If cur >= start OR cur < end => inside now
        const inside = curMin >= sMin || curMin < eMin;
        if (inside) {
          // end is today's eMin if cur < eMin, else tomorrow's eMin
          endDayOffset = curMin < eMin ? 0 : 1;
        } else {
          // not inside: next entering will be at sMin, and the following end at next day's eMin
          endDayOffset = curMin < sMin ? 1 : 2;
        }
      }
      return localMidnight + endDayOffset * 86400000 + endMinTotal * 60000 - 1;
    }

    if (anchor === "sabbathEnd") {
      // Approximate: next Saturday at ~19:30 local
      // If sabbath guard disabled, just return endOfDay for safety
      if (!sab?.enabled) return localMidnight + 24 * 3600000 - 1;
      const wd = parts.weekday; // 0..6 (Sun..Sat)
      const daysToSat = (6 - wd + 7) % 7;
      // If already Saturday and past target time, push to next week
      const targetH = 19,
        targetM = 30;
      let targetDayOffset = daysToSat;
      if (daysToSat === 0) {
        const pastTarget =
          parts.hour * 60 + parts.minute > targetH * 60 + targetM;
        if (pastTarget) targetDayOffset = 7;
      }
      const target =
        localMidnight +
        targetDayOffset * 86400000 +
        (targetH * 60 + targetM) * 60000 -
        1;
      return target;
    }

    // Unknown anchors → default endOfDay
    return localMidnight + 24 * 3600000 - 1;
  }

  // ------------------------------ Export --------------------------------------
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { relativeScheduler, generateRepeats, resolveAnchor };
  } else {
    // attach to window for safety
    // @ts-ignore
    window.relativeScheduler = relativeScheduler;
    // @ts-ignore
    window.RelativeSchedulerRepeats = { generateRepeats, resolveAnchor };
  }

  // ------------------------------ Autoinit ------------------------------------
  relativeScheduler.init({ tickMs: 1000, autostart: true });

  // ------------------------------ Example wires (optional) --------------------
  // 1) Domain-aware prep timers (marination/proofing/rest — suspendable)
  eventBus.on("prep.tasks.requested", (e = {}) => {
    // e: { sessionId, params: { domain, anchorId?, plan? } }
    const anchorId = e.params?.anchorId || uid("anchor");
    const created = relativeScheduler.createAnchor({
      anchorId,
      sessionId: e.sessionId,
      domain: e.params?.domain || null,
      startedAt: now(),
      meta: {
        createdAt: now(),
        labels: ["prep", e.params?.domain || "general"],
      },
    });

    if (Array.isArray(e.params?.plan)) {
      relativeScheduler.scheduleRecipeRun({
        anchorId,
        domain: e.params?.domain || null,
        plan: e.params.plan.map((step) => ({
          ...step,
          suspendable: step.suspendable ?? true,
        })),
      });
    }

    emitEvent("relative.prep.anchor.created", {
      sessionId: e.sessionId,
      anchorId,
      domain: e.params?.domain || null,
    });
    exportToHubIfEnabled({
      action: "relative.prep.anchor.created",
      sessionId: e.sessionId,
      anchorId,
      domain: e.params?.domain || null,
    });
  });

  // 2) Inventory shortage nudge → pause current anchor if biohazard/withhold flagged
  eventBus.on("inventory.shortage.detected", (e = {}) => {
    // e: { domain?, severity?, reason? }
    if (!e.domain) return;
    const sessionAnchors = Object.values(store.anchors).filter(
      (a) => !a.endedAt && a.domain === e.domain
    );
    sessionAnchors.forEach((a) => {
      if (["biohazard", "safety"].includes(e.reason)) {
        relativeScheduler.pauseAnchor(a.anchorId);
      }
    });
    emitEvent("relative.inventory.shortage.received", {
      domain: e.domain,
      severity: e.severity || null,
      reason: e.reason || null,
      affectedAnchors: sessionAnchors.map((a) => a.anchorId),
    });
  });
})();
