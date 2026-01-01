/* eslint-disable no-console */
// SessionAnalyticsManager.js — domain-aware, event-driven KPIs for sessions
// Robust to missing deps. Works in browser/offline. Emits nudges for NBA.
// Integrates (defensively) with: DexieDB, StabilityScore, SavePlanButton/PlanStorageRouter

(function () {
  /* ---------------------------------- utils --------------------------------- */
  const isBrowser = typeof window !== "undefined";
  const now = () => Date.now();
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const toISO = (ts) => new Date(ts || Date.now()).toISOString();
  const byId = (arr, id) => (arr || []).find((x) => x && x.id === id);
  const noop = () => {};
  const safeJSON = {
    parse: (s, fallback = null) => { try { return JSON.parse(s); } catch { return fallback; } },
    stringify: (o) => { try { return JSON.stringify(o); } catch { return "{}"; } },
  };

  /* --------------------------- defensive dependencies ------------------------ */
  let eventBus = { on: noop, off: noop, emit: noop };
  try {
    const eb = require("@/services/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  let DexieDB = null;
  try { DexieDB = require("@/db").default || require("@/db"); } catch (_e) {}

  let StabilityScoreEngine = null; // optional
  try { StabilityScoreEngine = require("@/engines/metrics/stabilityScore").default; } catch (_e) {}

  // Favorite plans / Plan storage bridges (defensive)
  let PlanStorageRouter = null;
  try { PlanStorageRouter = require("@/services/plans/PlanStorageRouter").default; } catch (_e) {}
  let useFavoritePlans = null;
  try { useFavoritePlans = require("@/hooks/useFavoritePlans").default; } catch (_e) {}

  // Optional NBA orchestrator signal bus
  let nba = { push: noop };
  try { nba = require("@/services/nba/orchestrator").default || nba; } catch (_e) {}

  // Sabbath / policy guards (scores may penalize during active guards)
  let pausePolicies = null;
  try { pausePolicies = require("@/services/session/policies/pausePolicies").default; } catch (_e) {}

  // Inventory / offset parser (timestamps for scheduled vs actual)
  let offsetParser = null;
  try { offsetParser = require("@/services/session/utils/offsetParser").default; } catch (_e) {}

  // Calendar sync awareness (for "on-time" score deltas)
  let calendarSync = null;
  try { calendarSync = require("@/services/calendar/calendarSync").default; } catch (_e) {}

  /* ------------------------------- state stores ------------------------------ */
  const memory = {
    sessions: new Map(),      // id -> live SessionState
    aggregates: {             // rolling aggregates per domain
      byDomain: {},           // domain -> Aggregate
      lastISO: null,
    },
    lastEmit: 0,
  };

  // Local persistence keys
  const LS_KEYS = {
    AGG: "suka:analytics:aggregates:v1",
  };

  function loadAggregates() {
    if (!isBrowser) return;
    const raw = localStorage.getItem(LS_KEYS.AGG);
    const parsed = safeJSON.parse(raw, null);
    if (parsed) memory.aggregates = parsed;
  }

  function saveAggregates() {
    if (!isBrowser) return;
    localStorage.setItem(LS_KEYS.AGG, safeJSON.stringify(memory.aggregates));
  }

  // Dexie tables (optional)
  async function persistSessionSummary(summary) {
    try {
      if (DexieDB && DexieDB.analytics) {
        await DexieDB.analytics.put(summary);
      } else if (DexieDB && DexieDB.sessionAnalytics) {
        await DexieDB.sessionAnalytics.put(summary);
      } else {
        // fallback to localStorage "append"
        const key = `suka:analytics:sessions:${summary.domain || "general"}`;
        const arr = safeJSON.parse(localStorage.getItem(key), []);
        arr.push(summary);
        localStorage.setItem(key, safeJSON.stringify(arr));
      }
    } catch (e) {
      console.error("[SessionAnalyticsManager] persistSessionSummary failed", e);
    }
  }

  function getOrCreateAggregate(domain) {
    const agg = memory.aggregates.byDomain[domain] || {
      domain,
      sessions: 0,
      totalActiveMs: 0,
      totalPausedMs: 0,
      totalDurationMs: 0,
      avgStepThroughput: 0,
      avgOnTimeRate: 0,
      conflicts: 0,
      shortages: 0,
      guardPauses: 0,
      lastUpdatedISO: null,
      streakSessions: 0, // for streak widgets
    };
    memory.aggregates.byDomain[domain] = agg;
    return agg;
  }

  /* --------------------------------- models --------------------------------- */
  // Live session tracking
  function makeSessionState(payload) {
    const id = payload.id || `session:${payload.domain || "general"}:${now()}`;
    return {
      id,
      domain: payload.domain || "general",
      planId: payload.planId || null,
      title: payload.title || payload.name || `${payload.domain || "Session"} run`,
      createdISO: payload.createdISO || toISO(),
      scheduledStartISO: payload.scheduledStartISO || null,
      actualStartISO: null,
      endISO: null,

      // time accounting
      activeMs: 0,
      pausedMs: 0,
      lastTick: null,
      isPaused: false,
      pauseReason: null,
      pauseStart: null,

      // steps
      steps: [],          // {id, title, plannedAt?, startedAt?, endedAt?, durationMs, onTime}
      stepsCompleted: 0,
      stepsTotal: payload.stepsTotal || 0,
      onTimeHits: 0,

      // signals
      conflicts: 0,
      shortages: 0,
      guardPauses: 0,

      // stability score delta snapshot
      stabilityScoreStart: null,
      stabilityScoreEnd: null,

      // user flags
      favorited: false,
    };
  }

  function tickSession(ts, s) {
    if (!s.lastTick) { s.lastTick = ts; return; }
    const dt = ts - s.lastTick;
    s.lastTick = ts;
    if (s.isPaused) s.pausedMs += dt;
    else s.activeMs += dt;
  }

  function computeThroughput(s) {
    const durHours = Math.max(0.001, (s.activeMs + s.pausedMs) / 3600000);
    return round2((s.stepsCompleted || 0) / durHours); // steps per hour
  }

  function computeOnTimeRate(s) {
    const denom = Math.max(1, s.stepsCompleted);
    return round2((s.onTimeHits || 0) / denom);
  }

  function summarizeSession(s) {
    const totalMs = (s.activeMs + s.pausedMs);
    return {
      id: s.id,
      domain: s.domain,
      planId: s.planId,
      title: s.title,
      createdISO: s.createdISO,
      scheduledStartISO: s.scheduledStartISO,
      actualStartISO: s.actualStartISO,
      endISO: s.endISO || toISO(),
      durationMs: totalMs,
      activeMs: s.activeMs,
      pausedMs: s.pausedMs,
      stepsCompleted: s.stepsCompleted,
      stepsTotal: s.stepsTotal,
      stepThroughput: computeThroughput(s),
      onTimeRate: computeOnTimeRate(s),
      conflicts: s.conflicts,
      shortages: s.shortages,
      guardPauses: s.guardPauses,
      stabilityScoreStart: s.stabilityScoreStart,
      stabilityScoreEnd: s.stabilityScoreEnd,
      stabilityScoreDelta: (typeof s.stabilityScoreStart === "number" && typeof s.stabilityScoreEnd === "number")
        ? round2(s.stabilityScoreEnd - s.stabilityScoreStart)
        : null,
      favorited: !!s.favorited,
    };
  }

  function foldAggregate(agg, summary) {
    agg.sessions += 1;
    agg.totalActiveMs += summary.activeMs;
    agg.totalPausedMs += summary.pausedMs;
    agg.totalDurationMs += summary.durationMs;
    const n = agg.sessions;
    // Running averages
    agg.avgStepThroughput = round2(((agg.avgStepThroughput * (n - 1)) + summary.stepThroughput) / n);
    agg.avgOnTimeRate = round2(((agg.avgOnTimeRate * (n - 1)) + summary.onTimeRate) / n);
    agg.conflicts += summary.conflicts;
    agg.shortages += summary.shortages;
    agg.guardPauses += summary.guardPauses;
    agg.lastUpdatedISO = toISO();
    // streak heuristic: session within 48h increments streak
    try {
      const last = memory.aggregates.lastISO ? new Date(memory.aggregates.lastISO).getTime() : 0;
      const diff = new Date(summary.endISO).getTime() - last;
      if (!last || diff <= 1000 * 60 * 60 * 48) agg.streakSessions += 1;
      else agg.streakSessions = 1;
      memory.aggregates.lastISO = summary.endISO;
    } catch (_e) {}
    return agg;
  }

  /* ------------------------------ favorite bridge --------------------------- */
  // Allow "favorite this session's plan" from analytics (e.g., best KPI runbooks)
  async function favoritePlanFromSession(sessionSummary, target = "local") {
    try {
      // Prefer PlanStorageRouter if present (supports drive/cloud)
      if (PlanStorageRouter && PlanStorageRouter.savePlanFavorite) {
        return await PlanStorageRouter.savePlanFavorite({
          planId: sessionSummary.planId,
          domain: sessionSummary.domain,
          source: "SessionAnalytics",
          target, // "local" | "drive" | "cloud"
          meta: {
            title: sessionSummary.title,
            stepThroughput: sessionSummary.stepThroughput,
            onTimeRate: sessionSummary.onTimeRate,
            stabilityScoreDelta: sessionSummary.stabilityScoreDelta,
            createdFromSessionId: sessionSummary.id,
          },
        });
      }

      // Fallback: hook (Zustand) if available
      if (typeof useFavoritePlans === "function") {
        const { addFavorite } = useFavoritePlans.getState ? useFavoritePlans.getState() : { addFavorite: null };
        if (addFavorite) {
          addFavorite({
            id: sessionSummary.planId || `favorite:${sessionSummary.domain}:${now()}`,
            domain: sessionSummary.domain,
            title: sessionSummary.title,
            meta: {
              stepThroughput: sessionSummary.stepThroughput,
              onTimeRate: sessionSummary.onTimeRate,
              stabilityScoreDelta: sessionSummary.stabilityScoreDelta,
              createdFromSessionId: sessionSummary.id,
              target,
            },
          });
          return { ok: true, via: "useFavoritePlans" };
        }
      }

      // Last resort: localStorage pin
      const key = "suka:favorites:plans";
      const prev = safeJSON.parse(localStorage.getItem(key), []);
      prev.push({
        id: sessionSummary.planId || `favorite:${sessionSummary.domain}:${now()}`,
        domain: sessionSummary.domain,
        title: sessionSummary.title,
        meta: {
          stepThroughput: sessionSummary.stepThroughput,
          onTimeRate: sessionSummary.onTimeRate,
          stabilityScoreDelta: sessionSummary.stabilityScoreDelta,
          createdFromSessionId: sessionSummary.id,
          target,
        },
      });
      localStorage.setItem(key, safeJSON.stringify(prev));
      return { ok: true, via: "localStorage" };
    } catch (e) {
      console.error("[SessionAnalyticsManager] favoritePlanFromSession failed", e);
      return { ok: false, error: e?.message || String(e) };
    }
  }

  /* ------------------------------ public manager ---------------------------- */
  const SessionAnalyticsManager = {
    init(options = {}) {
      loadAggregates();
      wireListeners(options.throttleMs || 1000);
      return this;
    },

    // Expose quick stats for HUD, dashboards, or NBA cards
    getSessionLive(sessionId) {
      return memory.sessions.get(sessionId) || null;
    },

    getDomainAggregate(domain) {
      return getOrCreateAggregate(domain);
    },

    getAggregates() {
      return memory.aggregates;
    },

    async exportDomainCSV(domain) {
      // export summaries (Dexie or LS fallback) in CSV for Drive/local save by other services
      const key = `suka:analytics:sessions:${domain || "general"}`;
      let rows = [];
      try {
        if (DexieDB && (DexieDB.analytics || DexieDB.sessionAnalytics)) {
          const table = DexieDB.analytics || DexieDB.sessionAnalytics;
          rows = await table.where("domain").equals(domain).toArray();
        } else {
          rows = safeJSON.parse(localStorage.getItem(key), []);
        }
      } catch (e) {
        console.error("[SessionAnalyticsManager] exportDomainCSV read failed", e);
      }
      const header = [
        "id","domain","planId","title","createdISO","scheduledStartISO","actualStartISO","endISO",
        "durationMs","activeMs","pausedMs","stepsCompleted","stepsTotal","stepThroughput",
        "onTimeRate","conflicts","shortages","guardPauses","stabilityScoreStart","stabilityScoreEnd","stabilityScoreDelta","favorited"
      ];
      const csv = [header.join(",")]
        .concat(rows.map(r => header.map(h => JSON.stringify(r[h] ?? "")).join(",")))
        .join("\n");

      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      if (isBrowser) {
        // Emit event so your existing download/cloud bridges can catch & route
        eventBus.emit?.("analytics.export.generated", {
          domain, kind: "csv", size: blob.size, createdISO: toISO(),
          // Provide a File-like object if your storage bridges need it
          file: blob,
          filename: `session_analytics_${domain}_${Date.now()}.csv`,
        });
      }
      return { ok: true, csv };
    },

    async favoriteBestRun(domain, metric = "stepThroughput", target = "local") {
      // find last best run in this domain and favorite it
      const key = `suka:analytics:sessions:${domain || "general"}`;
      let rows = [];
      try {
        if (DexieDB && (DexieDB.analytics || DexieDB.sessionAnalytics)) {
          const table = DexieDB.analytics || DexieDB.sessionAnalytics;
          rows = await table.where("domain").equals(domain).reverse().sortBy(metric);
        } else {
          rows = (safeJSON.parse(localStorage.getItem(key), []) || []).sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
        }
      } catch (_e) {}
      const best = rows[0];
      if (!best) return { ok: false, reason: "no-runs" };
      return favoritePlanFromSession(best, target);
    },
  };

  /* ------------------------------- event wiring ----------------------------- */
  function wireListeners(throttleMs) {
    const T = clamp(throttleMs, 500, 5000);

    // Session lifecycle
    eventBus.on?.("session.started", onSessionStarted);
    eventBus.on?.("session.resumed", onSessionResumed);
    eventBus.on?.("session.paused", onSessionPaused);
    eventBus.on?.("session.ended", onSessionEnded);
    eventBus.on?.("session.aborted", onSessionAborted);

    // Step stream
    eventBus.on?.("session.step.started", onStepStarted);
    eventBus.on?.("session.step.completed", onStepCompleted);

    // Conflicts/shortages/guards
    eventBus.on?.("planner.conflict.detected", onConflict);
    eventBus.on?.("inventory.shortage.detected", onShortage);
    eventBus.on?.("session.guard.pause", onGuardPause);

    // Optional: tick heartbeats (from SessionHUD/ExecutionEngine)
    eventBus.on?.("session.tick", (e) => {
      const s = e?.sessionId && memory.sessions.get(e.sessionId);
      if (!s) return;
      const ts = e.ts || now();
      // throttle
      if (ts - (memory.lastEmit || 0) < T) { tickSession(ts, s); return; }
      tickSession(ts, s);
      memory.lastEmit = ts;

      // Live KPI toast / HUD update
      eventBus.emit?.("analytics.live.updated", {
        sessionId: s.id,
        domain: s.domain,
        stepThroughput: computeThroughput(s),
        onTimeRate: computeOnTimeRate(s),
        activeMs: s.activeMs,
        pausedMs: s.pausedMs,
      });
    });

    // Compatibility with your general catalog (domain-aware draft/requests)
    eventBus.on?.("mealplan.draft.requested", (p) => emitDomainIntent("meals", "draft.requested", p));
    eventBus.on?.("grocerylist.requested", (p) => emitDomainIntent(p?.domain || "meals", "grocery.requested", p));
    eventBus.on?.("prep.tasks.requested", (p) => emitDomainIntent(p?.domain || "meals", "prep.requested", p));

    // Calendar sync improves on-time scoring expectations
    eventBus.on?.("calendar.session.synced", (p) => {
      const s = p?.sessionId && memory.sessions.get(p.sessionId);
      if (!s) return;
      s.scheduledStartISO = p?.scheduledStartISO || s.scheduledStartISO;
    });
  }

  function emitDomainIntent(domain, kind, payload) {
    eventBus.emit?.("analytics.intent.logged", {
      domain,
      kind,
      tsISO: toISO(),
      params: payload || {},
    });
  }

  /* -------------------------------- handlers -------------------------------- */
  function onSessionStarted(payload = {}) {
    const s = makeSessionState(payload);
    s.actualStartISO = payload.actualStartISO || toISO();
    s.lastTick = Date.now();
    if (StabilityScoreEngine?.getScore) {
      s.stabilityScoreStart = StabilityScoreEngine.getScore();
    }
    memory.sessions.set(s.id, s);

    eventBus.emit?.("analytics.session.live", {
      sessionId: s.id, domain: s.domain, title: s.title,
      status: "started", tsISO: toISO(),
    });
  }

  function onSessionResumed(payload = {}) {
    const s = payload.sessionId && memory.sessions.get(payload.sessionId);
    if (!s) return;
    const ts = now();
    // close pause
    if (s.isPaused) {
      s.isPaused = false;
      s.pauseReason = null;
      if (s.pauseStart) s.pausedMs += (ts - s.pauseStart);
      s.pauseStart = null;
    }
    s.lastTick = ts;
    eventBus.emit?.("analytics.session.live", {
      sessionId: s.id, domain: s.domain, status: "resumed", tsISO: toISO(),
    });
  }

  function onSessionPaused(payload = {}) {
    const s = payload.sessionId && memory.sessions.get(payload.sessionId);
    if (!s) return;
    const ts = now();
    if (!s.isPaused) {
      s.isPaused = true;
      s.pauseReason = payload.reason || null;
      s.pauseStart = ts;
    }
    eventBus.emit?.("analytics.session.live", {
      sessionId: s.id, domain: s.domain, status: "paused", reason: s.pauseReason, tsISO: toISO(),
    });
  }

  async function finalizeSession(s, status = "ended") {
    s.endISO = toISO();
    if (s.isPaused && s.pauseStart) {
      s.pausedMs += (now() - s.pauseStart);
      s.isPaused = false;
      s.pauseStart = null;
    }
    if (StabilityScoreEngine?.getScore) {
      s.stabilityScoreEnd = StabilityScoreEngine.getScore();
    }
    const summary = summarizeSession(s);

    // Fold into aggregates
    const agg = getOrCreateAggregate(s.domain);
    foldAggregate(agg, summary);
    saveAggregates();

    // Persist summary
    await persistSessionSummary(summary);

    // Emit NBA nudges if thresholds crossed
    try {
      if (summary.onTimeRate < 0.6) {
        eventBus.emit?.("nba.updated", {
          scope: "session",
          sessionId: s.id,
          domain: s.domain,
          priority: "high",
          hint: "On-time rate is low. Consider shorter prep windows or earlier calendar blocks.",
          metrics: { onTimeRate: summary.onTimeRate },
        });
      }
      if (summary.stepThroughput > 12) {
        eventBus.emit?.("nba.updated", {
          scope: "session",
          sessionId: s.id,
          domain: s.domain,
          priority: "info",
          hint: "Excellent throughput! Save this runbook as a favorite template.",
          metrics: { stepThroughput: summary.stepThroughput },
          cta: { type: "favorite.plan.fromSession", sessionId: s.id },
        });
      }
    } catch (_e) {}

    eventBus.emit?.("analytics.session.completed", { ...summary, status });
  }

  function onSessionEnded(payload = {}) {
    const s = payload.sessionId && memory.sessions.get(payload.sessionId);
    if (!s) return;
    finalizeSession(s, "ended").finally(() => {
      memory.sessions.delete(s.id);
    });
  }

  function onSessionAborted(payload = {}) {
    const s = payload.sessionId && memory.sessions.get(payload.sessionId);
    if (!s) return;
    finalizeSession(s, "aborted").finally(() => {
      memory.sessions.delete(s.id);
    });
  }

  function onStepStarted(payload = {}) {
    const s = payload.sessionId && memory.sessions.get(payload.sessionId);
    if (!s) return;
    const step = {
      id: payload.stepId || `step:${s.steps.length + 1}`,
      title: payload.title || `Step ${s.steps.length + 1}`,
      plannedAt: payload.plannedAt || null,
      startedAt: toISO(),
      endedAt: null,
      durationMs: 0,
      onTime: null,
    };
    s.steps.push(step);
    eventBus.emit?.("analytics.session.live", {
      sessionId: s.id, domain: s.domain, status: "step.started", stepId: step.id, tsISO: step.startedAt,
    });
  }

  function onStepCompleted(payload = {}) {
    const s = payload.sessionId && memory.sessions.get(payload.sessionId);
    if (!s) return;
    const step = byId(s.steps, payload.stepId) || s.steps[s.steps.length - 1];
    if (!step) return;

    const endISO = toISO();
    step.endedAt = endISO;
    step.durationMs = Math.max(0, new Date(endISO).getTime() - new Date(step.startedAt || endISO).getTime());

    // On-time test: plannedAt vs startedAt (or endedAt with tolerance)
    if (step.plannedAt && offsetParser?.diffMs) {
      const deltaMs = Math.abs(offsetParser.diffMs(step.plannedAt, step.startedAt || endISO));
      step.onTime = deltaMs <= (payload.onTimeToleranceMs || 120000); // default 2m tolerance
    } else if (typeof payload.onTime === "boolean") {
      step.onTime = payload.onTime;
    } else {
      // Fallback heuristic: if started within 3m of planned or session start
      if (s.scheduledStartISO && step.startedAt) {
        step.onTime = Math.abs(new Date(step.startedAt).getTime() - new Date(s.scheduledStartISO).getTime()) <= 180000;
      } else {
        step.onTime = true;
      }
    }

    s.stepsCompleted += 1;
    if (step.onTime) s.onTimeHits += 1;

    eventBus.emit?.("analytics.session.live", {
      sessionId: s.id, domain: s.domain, status: "step.completed",
      stepId: step.id, onTime: step.onTime, tsISO: endISO,
      kpis: { stepThroughput: computeThroughput(s), onTimeRate: computeOnTimeRate(s) },
    });
  }

  function onConflict(payload = {}) {
    const s = payload.sessionId && memory.sessions.get(payload.sessionId);
    if (!s) return;
    s.conflicts += 1;
    eventBus.emit?.("analytics.session.live", {
      sessionId: s.id, domain: s.domain, status: "conflict", kind: payload.kind || "unknown", tsISO: toISO(),
    });
  }

  function onShortage(payload = {}) {
    // domain-aware shortage detection already raised elsewhere; just count if tied to session
    const s = payload.sessionId && memory.sessions.get(payload.sessionId);
    if (!s) return;
    s.shortages += 1;
    eventBus.emit?.("analytics.session.live", {
      sessionId: s.id, domain: s.domain, status: "shortage", itemId: payload.itemId, tsISO: toISO(),
    });
  }

  function onGuardPause(payload = {}) {
    const s = payload.sessionId && memory.sessions.get(payload.sessionId);
    if (!s) return;
    s.guardPauses += 1;
    // Optional policy-specific penalty to StabilityScore (if your engine supports)
    if (pausePolicies?.penalizeGuardPause && StabilityScoreEngine?.bump) {
      try { StabilityScoreEngine.bump(-pausePolicies.penalizeGuardPause(s.domain)); } catch (_e) {}
    }
    eventBus.emit?.("analytics.session.live", {
      sessionId: s.id, domain: s.domain, status: "guard.pause", tsISO: toISO(),
    });
  }

  /* ------------------------------ command wiring ---------------------------- */
  // CTA handler to favorite from HUD/NBA (listen once here so UI can just emit)
  eventBus.on?.("favorite.plan.fromSession", async (p) => {
    const s = p?.sessionId && memory.sessions.get(p.sessionId);
    if (!s) return;
    const summary = summarizeSession(s);
    const target = p?.target || "local";
    const res = await favoritePlanFromSession(summary, target);
    if (res?.ok) {
      s.favorited = true;
      eventBus.emit?.("toast", { kind: "success", message: "Saved as Favorite Plan", tsISO: toISO() });
    } else {
      eventBus.emit?.("toast", { kind: "error", message: "Could not save favorite", tsISO: toISO() });
    }
  });

  /* --------------------------------- export --------------------------------- */
  // ESM/CJS friendly export
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SessionAnalyticsManager;
  } else {
    // attach to window for browser-only builds
    if (isBrowser) window.SessionAnalyticsManager = SessionAnalyticsManager;
  }
})();
