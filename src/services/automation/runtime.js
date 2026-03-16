// C:\Users\larho\suka-smart-assistant\src\services\automation\runtime.js
// Local in-app automation runtime (event-driven, offline-resilient, Sabbath-guardable)
// NOW with: user schedules (persisted), favorites glue, bus orchestration for Scan•Compare•Trust
// UPDATED to listen for: automation.schedule.request + domain session schedule requests
// UPDATED AGAIN to also normalize: mealplan, storehouse, coop/collab, import→planner, reverse-generation
// ✅ UPDATED (Shopping Mode): adds Shopping schedule remap + shopping scan evaluation + receipt-gated commit hooks

import EventEmitter from "eventemitter3";
/* ✅ NEW: wire cookingSessionShim */
import { bootstrapcookingSessionShim } from "@/agents/shims/cookingSessionShim";

/* ────────────────────────────── tiny utils ─────────────────────────────── */
const isBrowser = typeof window !== "undefined";
const now = () => Date.now();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const genId = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);
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
      return "";
    }
  },
};
const storage = (() => {
  const keyPrefix = "suka::automation::";
  if (isBrowser && window.localStorage) {
    return {
      get: (k, d = null) =>
        safeJSON.parse(localStorage.getItem(keyPrefix + k), d),
      set: (k, v) => localStorage.setItem(keyPrefix + k, safeJSON.stringify(v)),
      del: (k) => localStorage.removeItem(keyPrefix + k),
    };
  }
  const mem = new Map();
  return {
    get: (k, d = null) => (mem.has(k) ? mem.get(k) : d),
    set: (k, v) => mem.set(k, v),
    del: (k) => mem.delete(k),
  };
})();

/* ─────────────────────────── NEW HELPER (to keep spec) ───────────────────────────
   SSA owns data first. If familyFundMode=true we *also* format + send to Hub.
   This is deliberately defensive and silent on failure.
   IMPORTANT: this file lives at: src/services/automation/runtime.js
   your connector lives at:       src/connectors/HubPacketFormatter.js
   so RELATIVE path from here is: ../../connectors/HubPacketFormatter.js
---------------------------------------------------------------------------- */
async function exportToHubIfEnabled(payload) {
  try {
    const featureFlags =
      (isBrowser && (window.sukaFeatureFlags || window.__SUKA_FLAGS__)) || null;

    const enabled =
      (featureFlags && featureFlags.familyFundMode) ||
      (payload && payload.meta && payload.meta.hubOnly) ||
      false;

    if (!enabled) return;

    // 1st: correct relative path (ALWAYS works if folder names don’t move)
    // 2nd: alias path (works if @ -> /src is set)
    const [
      { default: HubPacketFormatter = null } = {},
      { default: FamilyFundConnector = null } = {},
    ] = await Promise.all([
      import("../../connectors/HubPacketFormatter.js")
        .catch(() => import("@/connectors/HubPacketFormatter.js"))
        .catch(() => ({})),
      import("../../connectors/FamilyFundConnector.js")
        .catch(() => import("@/connectors/FamilyFundConnector.js"))
        .catch(() => ({})),
    ]);

    if (!HubPacketFormatter || !FamilyFundConnector) {
      if (import.meta.env?.DEV) {
        console.warn(
          "[automation.runtime] familyFundMode enabled, but src/connectors/HubPacketFormatter.js or src/connectors/FamilyFundConnector.js is missing. Skipping export.",
        );
      }
      return;
    }

    const packet = HubPacketFormatter.fromAutomation?.(payload) ||
      HubPacketFormatter.fromSchedule?.(payload) ||
      HubPacketFormatter.wrap?.("automation", payload) || {
        kind: "automation",
        payload,
      };

    await FamilyFundConnector.send?.(packet);
  } catch {
    // hub export is optional → do nothing
  }
}

/* ───────────────────── optional deps (lazy to avoid loops) ─────────────── */
let sabbathGuard = async (fn) => fn?.();
let bus = {
  on: () => () => {},
  emit: () => {},
  emitAsync: async () => {},
  Events: {},
};
(async () => {
  try {
    ({ sabbathGuard } = await import("@/services/guardrails/sabbathGuard"));
  } catch {}
  try {
    const mod = await import("@/services/events/eventBus");
    bus.on = mod.on;
    bus.emit = mod.emit;
    bus.emitAsync = mod.emitAsync;
    bus.Events = mod.Events || {};
    // ---------------------------------------------------------------------
    // Import pipeline wiring: import.created → parse → blueprint → session
    // ---------------------------------------------------------------------
    try {
      const { default: HouseholdOrchestrator } =
        await import("@/agents/shims/HouseholdOrchestrator");

      // Avoid double-binding in HMR
      if (!bus.__importPipelineBound) {
        bus.__importPipelineBound = true;

        bus.on("import.created", async (e) => {
          const detail = e?.detail || e || {};
          const artifactId = detail.artifactId;
          if (!artifactId) return;
          try {
            await HouseholdOrchestrator.invokeShim({
              intent: "import.parse",
              payload: {
                artifactId,
                forceDomain: detail.domainHint,
                householdId: detail.householdId,
                userId: detail.userId,
              },
            });
          } catch (err) {
            if (import.meta?.env?.DEV)
              console.warn("[automation] import.parse failed", err);
          }
        });

        bus.on("import.parsed", async (e) => {
          const detail = e?.detail || e || {};
          const artifactId = detail.artifactId;
          const candidateId = detail.candidateId;
          if (!artifactId || !candidateId) return;

          try {
            const { db } = await import("@/services/db");
            const maps = await db.method_maps
              .where("[candidateId+methodKey]")
              .between([candidateId, ""], [candidateId, "\uffff"])
              .toArray();

            const top = (maps || []).sort(
              (a, b) => (b.confidence || 0) - (a.confidence || 0),
            )[0];
            const threshold = Number(cfg?.importAutoSessionThreshold ?? 0.65);

            if (!top || (top.confidence || 0) < threshold) {
              // Push to review queue
              if (db?.review_queue) {
                await db.review_queue.add({
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  status: "needs_review",
                  artifactId,
                  candidateId,
                  domain: detail.domain || "unknown",
                  reason: "low_confidence",
                  topMethodKey: top?.methodKey || null,
                  topConfidence: top?.confidence || 0,
                });
              }
              return;
            }

            await HouseholdOrchestrator.invokeShim({
              intent: "session.generate.fromImport",
              payload: {
                artifactId,
                candidateId,
                methodMapId: top.id,
                householdId: detail.householdId,
                userId: detail.userId,
                minConfidence: threshold,
              },
            });
          } catch (err) {
            if (import.meta?.env?.DEV)
              console.warn(
                "[automation] session.generate.fromImport failed",
                err,
              );
          }
        });
      }
    } catch (e) {
      // If orchestrator isn't available yet, skip wiring.
    }
  } catch {}
})();

/* ───────────────────────────── Quiet hours cfg ─────────────────────────── */
const cfg = isBrowser && window.sukaConfig ? window.sukaConfig : {};
function isQuietHoursActive(d = new Date()) {
  const q = cfg?.quietHours;
  if (!q?.enabled) return false;
  const [sh, sm] = String(q.start || "22:00")
    .split(":")
    .map(Number);
  const [eh, em] = String(q.end || "07:00")
    .split(":")
    .map(Number);
  const s = new Date(d);
  s.setHours(sh || 0, sm || 0, 0, 0);
  const e = new Date(d);
  e.setHours(eh || 0, em || 0, 0, 0);
  return s <= e ? d >= s && d <= e : d >= s || d <= e;
}

/* ───────────────────────────── BaseAgent (unchanged) ────────────────────── */
export class BaseAgent {
  constructor({ automation, bus: b } = {}) {
    if (!automation)
      console.warn("[BaseAgent] constructed without automation context");
    this.automation = automation || null;
    this.bus = b || automation || null;
    this._unsubs = [];
    this.started = false;
  }
  start() {
    this.started = true;
  }
  handleEvent(_evt) {}
  onEvent(fn) {
    if (!this.automation || typeof this.automation.on !== "function") {
      console.warn("[BaseAgent] automation event bus unavailable");
      return () => {};
    }
    const handler = (evt) => {
      const topic = evt?.topic || evt?.type;
      fn({ ...evt, topic });
    };
    this.automation.on("event", handler);
    const unsub = () => this.automation.off("event", handler);
    this._unsubs.push(unsub);
    return unsub;
  }
  teardown() {
    this._unsubs.forEach((u) => {
      try {
        u();
      } catch {}
    });
    this._unsubs = [];
    this.started = false;
  }
}

/* ───────────────────────── template normalization ───────────────────────── */
function toNormalizedTemplateShape(input) {
  if (!input) return null;

  if (
    typeof input === "function" &&
    !(input.prototype && (input.prototype.run || input.prototype.execute))
  ) {
    try {
      const out = input();
      if (out) return toNormalizedTemplateShape(out);
    } catch {}
  }

  const tpl =
    input?.default && typeof input.default === "object" ? input.default : input;
  if (!tpl || typeof tpl !== "object") return null;

  const runLike =
    tpl.run || tpl.execute || tpl.handler || tpl.perform || tpl.runStep;

  if (tpl.meta?.id && typeof (tpl.run || tpl.execute) === "function") {
    return {
      id: String(tpl.meta.id),
      title: String(tpl.meta.title || tpl.meta.name || tpl.meta.id || ""),
      description: String(tpl.meta.description || tpl.meta.purpose || ""),
      tags: tpl.meta.tags || tpl.tags || [],
      guard: tpl.guard || tpl.shouldRun,
      schedule: tpl.schedule || tpl.cron || null,
      onRegister: tpl.onRegister || tpl.registerWith,
      onResult: tpl.onResult,
      run: tpl.run || tpl.execute,
      retry: tpl.retry || null,
      timeoutMs: tpl.timeoutMs ?? 0,
    };
  }

  const id = String(tpl.id || tpl.key || tpl.name || "").trim();
  if (!id || typeof runLike !== "function") return null;

  return {
    id,
    title: String(tpl.title || tpl.name || id || "").trim(),
    description: String(tpl.description || tpl.purpose || "").trim(),
    tags: tpl.tags || tpl.forAgents || [],
    guard: tpl.guard || tpl.shouldRun,
    schedule: tpl.schedule || tpl.cron || null,
    onRegister: tpl.onRegister || tpl.registerWith,
    onResult: tpl.onResult,
    run: runLike,
    retry: tpl.retry || null,
    timeoutMs: tpl.timeoutMs ?? 0,
  };
}
function expandCandidates(templateLike) {
  const out = [];
  if (templateLike == null) return out;
  const mod = templateLike?.default ?? templateLike;
  if (Array.isArray(mod)) out.push(...mod);
  else if (typeof mod === "object") {
    if (
      mod.id &&
      (mod.run || mod.execute || mod.handler || mod.perform || mod.runStep)
    ) {
      out.push(mod);
    } else {
      for (const k of Object.keys(mod)) {
        const v = mod[k];
        if (!v) continue;
        if (typeof v === "function" || typeof v === "object") out.push(v);
      }
    }
  } else if (typeof mod === "function") out.push(mod);
  if (!out.length) out.push(templateLike);
  return out;
}

/* ────────────────────────────── schedule rules ───────────────────────────── */
// Supports: "hourly", "daily", "HH:MM", { everyMinutes }, { at:"HH:MM", days:[0..6] }
function parseRule(rule) {
  if (!rule) return null;
  if (typeof rule === "string") {
    const s = rule.toLowerCase().trim();
    if (s === "hourly") return { kind: "everyMinutes", minutes: 60 };
    if (s === "daily") return { kind: "time", hh: 9, mm: 0, days: null };
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const hh = clamp(parseInt(m[1], 10), 0, 23);
      const mm = clamp(parseInt(m[2], 10), 0, 59);
      return { kind: "time", hh, mm, days: null };
    }
    return null;
  }
  if (typeof rule === "object") {
    if (Number.isFinite(rule.everyMinutes)) {
      return {
        kind: "everyMinutes",
        minutes: Math.max(1, Math.floor(rule.everyMinutes)),
      };
    }
    if (typeof rule.at === "string") {
      const m = rule.at.match(/^(\d{1,2}):(\d{2})$/);
      if (m) {
        const hh = clamp(parseInt(m[1], 10), 0, 23);
        const mm = clamp(parseInt(m[2], 10), 0, 59);
        const days = Array.isArray(rule.days)
          ? rule.days.map((d) => clamp(+d, 0, 6))
          : null;
        return { kind: "time", hh, mm, days };
      }
    }
  }
  return null;
}
const nextInMinutes = (minutes) => new Date().getTime() + minutes * 60 * 1000;
function nextAtTime(hh, mm, days /* nullable */) {
  const d = new Date();
  d.setSeconds(0, 0);
  const today = d.getDay();
  const target = new Date(d);
  target.setHours(hh, mm, 0, 0);

  if (!days || days.length === 0) {
    if (target.getTime() <= now()) target.setDate(target.getDate() + 1);
    return target.getTime();
  }

  let add = 0;
  while (add <= 7) {
    const check = new Date(d);
    check.setDate(check.getDate() + add);
    const dow = check.getDay();
    if (days.includes(dow)) {
      check.setHours(hh, mm, 0, 0);
      if (check.getTime() > now()) return check.getTime();
    }
    add++;
  }
  const first = days[0] ?? today;
  const base = new Date(d);
  const delta = 7 - ((today - first + 7) % 7) || 7;
  base.setDate(base.getDate() + delta);
  base.setHours(hh, mm, 0, 0);
  return base.getTime();
}

/* ───────────────────────────────── middleware ───────────────────────────── */
const compose = (middlewares, core) =>
  middlewares.reduceRight((next, mw) => mw(next), core);

/* ────────────────────────────── Automation core ─────────────────────────── */
class AutomationRuntime extends EventEmitter {
  constructor() {
    super();

    // registry
    this.templates = new Map(); // id -> tpl
    this.triggers = []; // [{ fn, unsub }]

    // queue
    this._queue = [];
    this._running = false;
    this._concurrency = 1;
    this._inflight = 0;
    this._cancelledIds = new Set();

    // schedules
    this._schedules = new Map(); // id -> { rule, nextAt }
    this._userSchedules = new Map(); // user-created

    // rules
    this._rules = new Map();

    // loop
    this._interval = null;
    this.started = false;

    // listeners for UI subscribers
    this._version = 0;
    this._listeners = new Set();

    // stats
    this.stats = {
      templates: 0,
      triggers: 0,
      runs: 0,
      lastRunAt: null,
      lastError: null,
      cancelled: 0,
    };

    // middlewares
    this._middlewares = { before: [], after: [], finally: [] };

    // persistence
    this._persistKey = "state";
    this._persistUserKey = "userSchedules";
    this._persistFavKey = "favorites";
    this._hydrate();
  }

  /* ───────────── ergonomic subscriptions & change ticks ─────────────────── */
  get version() {
    return this._version;
  }
  subscribe(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }
  _bump(type, payload) {
    try {
      super.emit("runtime", { type, payload, at: now() });
    } catch {}
    this._version++;
    try {
      super.emit("change", this._version);
    } catch {}
    for (const cb of this._listeners) {
      try {
        cb();
      } catch {}
    }
    this._persist();
  }

  /* ─────────────────────── event emission & normalization ────────────────── */
  emitEvent(topic, payload) {
    const evt = {
      topic: String(topic || "").trim(),
      payload,
      ts: now(),
      traceId: genId(),
    };
    try {
      super.emit("event", evt);
    } catch {}
    queueMicrotask(() => this._evaluateRules(evt));
    try {
      bus.emit?.(evt.topic, evt);
    } catch {}
    return true;
  }
  emit(event, payload) {
    if (
      typeof event === "string" &&
      !["runtime", "change", "tick", "stop"].includes(event)
    ) {
      return this.emitEvent(event, payload);
    }
    return super.emit(event, payload);
  }
  onTopic(topic, handler) {
    const t = String(topic || "");
    const h = (evt) => {
      if ((evt?.topic || evt?.type) === t) handler(evt);
    };
    this.on("event", h);
    return () => this.off("event", h);
  }
  onceEvent(topic, timeoutMs = 10_000) {
    const expected = String(topic || "");
    return new Promise((resolve, reject) => {
      let timer = null;
      const handler = (evt) => {
        if ((evt?.topic || evt?.type) === expected) {
          clearTimeout(timer);
          this.off("event", handler);
          resolve(evt);
        }
      };
      this.on("event", handler);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.off("event", handler);
          reject(
            new Error(
              `onceEvent("${expected}") timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }
    });
  }

  /* ───────────────────────────── registration ───────────────────────────── */
  _registerOne(templateLike) {
    const tpl = toNormalizedTemplateShape(templateLike);
    if (!tpl) return false;
    if (this.templates.has(tpl.id)) return true;

    this.templates.set(tpl.id, tpl);
    this.stats.templates = this.templates.size;

    if (tpl.schedule) {
      const parsed = parseRule(tpl.schedule);
      if (parsed) {
        const nextAt =
          parsed.kind === "everyMinutes"
            ? nextInMinutes(parsed.minutes)
            : nextAtTime(parsed.hh, parsed.mm, parsed.days || null);
        this._schedules.set(tpl.id, { rule: parsed, nextAt });
      }
    }

    try {
      tpl.onRegister?.({
        emit: this.emitEvent.bind(this),
        automation: this,
      });
    } catch (e) {
      console.warn(
        `[automation] onRegister("${tpl.id}") failed: ${e?.message || e}`,
      );
    }

    this._bump("templates/registered", { id: tpl.id });
    return true;
  }
  register(templateLike) {
    const candidates = expandCandidates(templateLike);
    let ok = 0;
    for (const c of candidates) {
      const did = this._registerOne(c);
      if (!did) {
        const shape =
          c && typeof c === "object" ? Object.keys(c).join(",") : typeof c;
        console.warn(
          "[automation] Skipping invalid template:",
          c,
          `(shape: ${shape})`,
        );
      } else ok++;
    }
    return ok;
  }
  async registerGlob(globModules) {
    if (!globModules || typeof globModules !== "object") return 0;
    return coalesce(
      "registerGlob",
      async () => {
        let count = 0;
        for (const key of Object.keys(globModules)) {
          try {
            const mod =
              typeof globModules[key] === "function"
                ? await globModules[key]()
                : globModules[key];
            count += this.register(mod);
          } catch (e) {
            console.warn(
              `[automation] Failed to register template from "${key}": ${
                e?.message || e
              }`,
            );
          }
        }
        return count;
      },
      30,
    );
  }

  registerTemplate(templateLike) {
    return this.register(templateLike) > 0;
  }
  getTemplate(id) {
    return this.templates.get(id) || null;
  }
  hasTemplate(id) {
    return this.templates.has(id);
  }
  getTemplates() {
    return Array.from(this.templates.values());
  }
  removeTemplate(id) {
    this.templates.delete(String(id));
    this._schedules.delete(String(id));
    this.stats.templates = this.templates.size;
    this._bump("templates/removed", { id });
  }

  /* ─────────────────────────────── triggers ─────────────────────────────── */
  registerTrigger(triggerFn) {
    if (typeof triggerFn !== "function") {
      console.warn("[automation] Skipped non-function trigger:", triggerFn);
      return;
    }
    this.triggers.push({ fn: triggerFn, unsub: null });
    this.stats.triggers = this.triggers.length;
    if (this.started) this._activateTrigger(triggerFn);
    this._bump("triggers/registered");
  }
  _activateTrigger(triggerFn) {
    try {
      const unsub = triggerFn({
        ctx: this,
        emit: (topic, payload) => this.emitEvent(topic, payload),
        on: this.onTopic.bind(this),
      });
      if (typeof unsub === "function") {
        const rec = this.triggers.find((t) => t.fn === triggerFn);
        if (rec) rec.unsub = unsub;
        this.once("stop", unsub);
      }
    } catch (e) {
      console.error("Trigger activation error:", e?.message || e);
    }
  }

  /* ───────────────────────────────── rules ───────────────────────────────── */
  addRule({ id, if: predicate, then: action, once = false }) {
    if (
      !id ||
      typeof predicate !== "function" ||
      typeof action !== "function"
    ) {
      console.warn("[automation] Invalid rule:", { id, predicate, action });
      return false;
    }
    this._rules.set(String(id), {
      id: String(id),
      predicate,
      action,
      once,
    });
    this._bump("rules/added", { id });
    return true;
  }
  removeRule(id) {
    this._rules.delete(String(id));
    this._bump("rules/removed", { id });
  }
  async _evaluateRules(evt) {
    for (const [id, r] of this._rules.entries()) {
      try {
        const ok = await r.predicate(evt, this);
        if (ok) {
          await r.action(this, evt);
          if (r.once) this._rules.delete(id);
        }
      } catch (e) {
        console.warn(`[automation] rule "${id}" error:`, e?.message || e);
      }
    }
  }

  /* ────────────────────────────── lifecycle ─────────────────────────────── */
  start(startCtx) {
    if (this.started) return;
    this.started = true;

    // activate triggers
    this.triggers.forEach((t) => this._activateTrigger(t.fn));

    // main loop
    if (!this._interval) {
      this._interval = setInterval(() => {
        try {
          this.emit("tick", { ts: now(), ctx: startCtx });
        } catch {}
        this._checkSchedules();
        this._pump();
      }, 60 * 1000);
    }

    this._bump("runtime/started", { ctx: startCtx });
  }
  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this.triggers.forEach((t) => {
      try {
        t.unsub?.();
      } catch {}
    });
    this.triggers = [];
    this._schedules.clear();

    this.started = false;
    super.emit("stop");
    this._bump("runtime/stopped");
  }

  /* ───────────────────────── middleware API ─────────────────────────────── */
  useBefore(mw) {
    if (typeof mw === "function") this._middlewares.before.push(mw);
    return this;
  }
  useAfter(mw) {
    if (typeof mw === "function") this._middlewares.after.push(mw);
    return this;
  }
  useFinally(mw) {
    if (typeof mw === "function") this._middlewares.finally.push(mw);
    return this;
  }

  /* ───────────────────────── queue & execution core ─────────────────────── */
  setConcurrency(n = 1) {
    this._concurrency = clamp(n | 0, 1, 4);
  }
  cancel(id) {
    this._cancelledIds.add(String(id));
    this.stats.cancelled++;
  }

  enqueueRun(id, options = {}) {
    const priority = clamp(options.priority ?? 1, 0, 2);
    const task = {
      id: String(id),
      priority,
      enqueuedAt: now(),
      options,
      attempt: 0,
    };
    this._queue.push(task);
    this._queue.sort(
      (a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt,
    );
    this._persist();
    this._pump();
  }

  async _pump() {
    if (this._inflight >= this._concurrency) return;
    if (this._running) return;
    this._running = true;
    try {
      while (this._queue.length && this._inflight < this._concurrency) {
        const task = this._queue.shift();
        if (!task) break;
        this._inflight++;
        this._executeTask(task)
          .catch(() => {})
          .finally(() => {
            this._inflight = Math.max(0, this._inflight - 1);
            this._persist();
            queueMicrotask(() => this._pump());
          });
      }
    } finally {
      this._running = false;
    }
  }

  async _executeTask(task) {
    const { id, options } = task;
    const tpl = this.templates.get(String(id));
    if (!tpl) {
      console.warn(`[automation] template "${id}" not registered`);
      return null;
    }
    if (this._cancelledIds.has(String(id))) {
      this._cancelledIds.delete(String(id));
      this.stats.cancelled++;
      this._bump("template/cancelled", { id });
      return { cancelled: true };
    }

    // Quiet hours nudge for scheduled runs (non-blocking)
    if (options?.scheduled && isQuietHoursActive()) {
      try {
        bus.emit?.(bus.Events?.UI_TOAST || "ui/toast", {
          variant: "info",
          title: "Quiet hours",
          message: "Automation delayed until quiet hours end.",
        });
      } catch {}
    }

    const core = async (tplId, ctx, runOpts) =>
      this._runTemplateInternal(tplId, ctx, runOpts);
    const beforeWrapped = compose(this._middlewares.before, core);
    const afterWrapped = compose(
      this._middlewares.after,
      async (tplId, ctx, runOpts) => beforeWrapped(tplId, ctx, runOpts),
    );
    const finalWrapped = compose(
      this._middlewares.finally,
      async (tplId, ctx, runOpts) => afterWrapped(tplId, ctx, runOpts),
    );

    const retry = tpl.retry && typeof tpl.retry === "object" ? tpl.retry : null;
    const maxAttempts = retry?.attempts ? Math.max(1, retry.attempts) : 1;
    const backoffMs = retry?.backoffMs ? Math.max(0, retry.backoffMs) : 5000;

    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        const res = await finalWrapped(id, options?.ctx || {}, {
          ...options,
          attempt,
          timeoutMs: tpl.timeoutMs ?? options?.timeoutMs ?? 0,
        });
        if (tpl.onResult) {
          try {
            await tpl.onResult({
              result: res,
              emit: this.emitEvent.bind(this),
              automation: this,
            });
          } catch {}
        }
        this.stats.lastRunAt = now();
        this.stats.runs++;
        this._bump("template/ran", {
          id,
          ok: true,
          scheduled: !!options?.scheduled,
        });
        return res;
      } catch (e) {
        if (attempt >= maxAttempts) {
          this.stats.lastError = e?.message || String(e);
          this._bump("template/error", { id, error: this.stats.lastError });
          return { error: this.stats.lastError };
        }
        await sleep(backoffMs);
      }
    }
    return null;
  }

  async _runTemplateInternal(id, ctx = {}, options = {}) {
    const t = this.templates.get(String(id));
    if (!t) {
      console.warn(`[automation] template "${id}" not registered`);
      return null;
    }

    const guardedRunner = () =>
      sabbathGuard(async () => {
        if (t.guard && !(await t.guard(ctx))) {
          this.stats.lastRunAt = now();
          this.stats.runs++;
          this._bump("template/skipped", {
            id,
            reason: "guard-failed",
          });
          return { skipped: true, reason: "guard-failed" };
        }

        const timeoutMs = options.timeoutMs ?? 0;
        const runner = async () =>
          t.run({ ...ctx, emit: this.emitEvent.bind(this), automation: this });

        const exec =
          timeoutMs > 0
            ? Promise.race([
                runner(),
                new Promise((_, rej) =>
                  setTimeout(
                    () =>
                      rej(
                        new Error(
                          `runTemplate("${id}") timeout after ${timeoutMs}ms`,
                        ),
                      ),
                    timeoutMs,
                  ),
                ),
              ])
            : runner();

        const res = await exec;
        this.stats.lastRunAt = now();
        this.stats.runs++;
        this._bump("template/ran", { id, ok: true });
        return res;
      });

    return guardedRunner();
  }

  async runTemplate(id, ctx = {}, options = {}) {
    return this._runTemplateInternal(id, ctx, options);
  }
  invoke(id, ctx = {}, options = {}) {
    return this.runTemplate(id, ctx, options);
  }
  queue(id, options = {}) {
    this.enqueueRun(id, options);
  }

  async runTagged(tag, ctx = {}, options = {}) {
    const mats = this.getTemplates().filter((t) =>
      (t.tags || []).includes(tag),
    );
    for (const t of mats) {
      await this._runTemplateInternal(t.id, ctx, options);
    }
    return { ok: true, count: mats.length };
  }

  /* ─────────────────────────────── plan text ─────────────────────────────── */
  async runPlan(text, opts = {}) {
    this.emitEvent("plan.received", {
      text: String(text || ""),
      opts,
    });
    return {
      ok: true,
      applied: false,
      planText: String(text || ""),
      options: opts,
    };
  }
  async applyPlan(text, opts = {}) {
    this.emitEvent("plan.applied", {
      text: String(text || ""),
      opts,
    });
    return this.runPlan(text, opts);
  }

  /* ─────────────────────────────── schedules ─────────────────────────────── */
  _checkSchedules() {
    if (
      !this.started ||
      (this._schedules.size === 0 && this._userSchedules.size === 0)
    )
      return;
    const ts = now();

    // template schedules
    for (const [id, sch] of this._schedules.entries()) {
      if (ts >= sch.nextAt) {
        this.enqueueRun(id, { priority: 2, scheduled: true });
        const r = sch.rule;
        sch.nextAt =
          r.kind === "everyMinutes"
            ? nextInMinutes(r.minutes)
            : nextAtTime(r.hh, r.mm, r.days || null);
        this._schedules.set(id, sch);
      }
    }

    // user schedules
    for (const [sid, rec] of this._userSchedules.entries()) {
      if (ts >= rec.nextAt) {
        this.enqueueRun(rec.templateId, {
          priority: rec.priority ?? 1,
          scheduled: true,
          ctx: rec.ctx || {},
        });
        const r = rec.rule;
        rec.nextAt =
          r.kind === "everyMinutes"
            ? nextInMinutes(r.minutes)
            : nextAtTime(r.hh, r.mm, r.days || null);
        this._userSchedules.set(sid, rec);
      }
    }
  }

  /** Save or update a user-defined schedule. */
  saveSchedule({
    id,
    title,
    templateId,
    rule,
    days,
    tags = [],
    ctx = {},
    priority = 1,
    meta = {},
  }) {
    const parsed = parseRule(rule || { at: "09:00", days });
    if (!parsed) return { ok: false, error: "invalid-rule" };
    const sid = String(id || `sch_${genId()}`);
    const nextAt =
      parsed.kind === "everyMinutes"
        ? nextInMinutes(parsed.minutes)
        : nextAtTime(parsed.hh, parsed.mm, parsed.days || null);
    const rec = {
      id: sid,
      title: String(title || templateId),
      templateId: String(templateId),
      rule: parsed,
      nextAt,
      tags,
      ctx,
      priority,
      meta,
    };
    this._userSchedules.set(sid, rec);
    this._persist();
    this._bump("userSchedule/saved", { id: sid, title: rec.title });
    try {
      bus.emit?.(bus.Events?.SCHEDULE_SAVED || "schedule/saved", {
        id: sid,
        domain: meta?.domain || "general",
        items: [{ templateId }],
        rec,
      });
    } catch {}
    return { ok: true, id: sid, nextAt };
  }
  deleteSchedule(id) {
    const sid = String(id);
    const ok = this._userSchedules.delete(sid);
    this._persist();
    this._bump("userSchedule/deleted", { id: sid });
    try {
      bus.emit?.(bus.Events?.SCHEDULE_DELETED || "schedule/deleted", {
        id: sid,
      });
    } catch {}
    return ok;
  }
  listSchedules() {
    return Array.from(this._userSchedules.values()).sort((a, b) =>
      (a.title || "").localeCompare(b.title || ""),
    );
  }
  runScheduleNow(id, ctx = {}) {
    const rec = this._userSchedules.get(String(id));
    if (!rec) return { ok: false, error: "not-found" };
    this.enqueueRun(rec.templateId, {
      priority: 2,
      scheduled: true,
      ctx: { ...(rec.ctx || {}), ...ctx },
    });
    this._bump("userSchedule/running", { id });
    return { ok: true };
  }
  exportSchedules() {
    return this.listSchedules().map((s) => ({
      id: s.id,
      title: s.title,
      templateId: s.templateId,
      rule:
        s.rule.kind === "everyMinutes"
          ? { everyMinutes: s.rule.minutes }
          : {
              at: `${String(s.rule.hh).padStart(2, "0")}:${String(
                s.rule.mm,
              ).padStart(2, "0")}`,
              days: s.rule.days || null,
            },
      tags: s.tags,
      ctx: s.ctx,
      priority: s.priority,
      meta: s.meta,
    }));
  }
  importSchedules(list = []) {
    let count = 0;
    for (const s of list) {
      const res = this.saveSchedule(s);
      if (res.ok) count++;
    }
    return { ok: true, count };
  }

  /* ───────────────────── Favorites (sessions & schedules) ───────────────── */
  _getFavs() {
    return storage.get(this._persistFavKey, {
      items: [],
      sessions: [],
      schedules: [],
    });
  }
  _setFavs(v) {
    storage.set(this._persistFavKey, v);
  }
  listFavoriteItems() {
    return this._getFavs().items;
  }
  listFavoriteSessions() {
    return this._getFavs().sessions;
  }
  listFavoriteSchedules() {
    return this._getFavs().schedules;
  }

  saveFavoriteItem(item) {
    const favs = this._getFavs();
    const id = String(item?.id || item?.upc || genId());
    if (!favs.items.some((x) => String(x.id) === id))
      favs.items.push({ ...item, id, savedAt: now() });
    this._setFavs(favs);
    try {
      bus.emit?.(bus.Events?.FAVORITES_TOGGLED || "favorites/toggled", {
        entity: "item",
        id,
        on: true,
      });
    } catch {}
    return { ok: true, id };
  }
  removeFavoriteItem(id) {
    const favs = this._getFavs();
    favs.items = favs.items.filter((x) => String(x.id) !== String(id));
    this._setFavs(favs);
    try {
      bus.emit?.(bus.Events?.FAVORITES_TOGGLED || "favorites/toggled", {
        entity: "item",
        id,
        on: false,
      });
    } catch {}
    return { ok: true };
  }

  saveFavoriteSession(session) {
    const favs = this._getFavs();
    const id = String(session?.id || genId());
    if (!favs.sessions.some((s) => String(s.id) === id))
      favs.sessions.push({ ...session, id, savedAt: now() });
    this._setFavs(favs);
    try {
      bus.emit?.(bus.Events?.FAVORITES_TOGGLED || "favorites/toggled", {
        entity: "session",
        id,
        on: true,
      });
    } catch {}
    return { ok: true, id };
  }
  removeFavoriteSession(id) {
    const favs = this._getFavs();
    favs.sessions = favs.sessions.filter((s) => String(s.id) !== String(id));
    this._setFavs(favs);
    try {
      bus.emit?.(bus.Events?.FAVORITES_TOGGLED || "favorites/toggled", {
        entity: "session",
        id,
        on: false,
      });
    } catch {}
    return { ok: true };
  }

  saveFavoriteSchedule(scheduleRef) {
    const favs = this._getFavs();
    const id = String(scheduleRef?.id || genId());
    if (!favs.schedules.some((s) => String(s.id) === id))
      favs.schedules.push({ ...scheduleRef, id, savedAt: now() });
    this._setFavs(favs);
    try {
      bus.emit?.(bus.Events?.FAVORITES_TOGGLED || "favorites/toggled", {
        entity: "schedule",
        id,
        on: true,
      });
    } catch {}
    return { ok: true, id };
  }
  removeFavoriteSchedule(id) {
    const favs = this._getFavs();
    favs.schedules = favs.schedules.filter((s) => String(s.id) !== String(id));
    this._setFavs(favs);
    try {
      bus.emit?.(bus.Events?.FAVORITES_TOGGLED || "favorites/toggled", {
        entity: "schedule",
        id,
        on: false,
      });
    } catch {}
    return { ok: true };
  }

  /* ───────────────────────────── state & persistence ────────────────────── */
  getState() {
    return {
      version: this._version,
      started: this.started,
      templates: this.getTemplates().map((t) => ({
        id: t.id,
        tags: t.tags || [],
        schedule: t.schedule || null,
        timeoutMs: t.timeoutMs ?? 0,
      })),
      triggers: this.triggers.length,
      queueLen: this._queue.length,
      inflight: this._inflight,
      concurrency: this._concurrency,
      stats: { ...this.stats },
      schedules: this.listSchedules(),
      favorites: this._getFavs(),
    };
  }
  getQueue() {
    return this._queue.slice();
  }
  clearQueue() {
    this._queue = [];
    this._bump("queue/cleared");
  }

  _persist() {
    const toSave = {
      schedules: Array.from(this._schedules.entries()).map(([id, v]) => [
        id,
        v,
      ]),
      userSchedules: Array.from(this._userSchedules.entries()).map(
        ([id, v]) => [id, v],
      ),
      queue: this._queue.map((t) => ({
        id: t.id,
        priority: t.priority,
        enqueuedAt: t.enqueuedAt,
        options: t.options ?? {},
      })),
      stats: this.stats,
      version: this._version,
    };
    storage.set(this._persistKey, toSave);
  }
  _hydrate() {
    const saved = storage.get(this._persistKey, null);
    if (saved) {
      try {
        this._schedules = new Map(saved.schedules || []);
        this._userSchedules = new Map(saved.userSchedules || []);
        this._queue = (saved.queue || []).map((t) => ({
          ...t,
          attempt: 0,
        }));
        this.stats = { ...this.stats, ...(saved.stats || {}) };
        this._version = saved.version || this._version;
      } catch {}
    }
  }

  /* ───────────────────────── convenience domain channel ─────────────────── */
  channel(domain) {
    const ensure = (p) =>
      p && typeof p === "object" ? { ...p, domain } : { domain, value: p };
    return {
      emit: (name, payload) =>
        this.emitEvent(`${domain}/${name}`, ensure(payload)),
      on: (name, fn) => this.onTopic(`${domain}/${name}`, fn),
      once: (name, ms) => this.onceEvent(`${domain}/${name}`, ms),
    };
  }
}

/* ─────────────────────────── singleton & helpers ────────────────────────── */
export const automation = new AutomationRuntime();
export default AutomationRuntime;

/* ✅ NEW: shim bootstrap helper */
let shimsBootstrapped = false;

/**
 * Bootstraps domain shims that need eventBus listeners.
 * Currently: cookingSessionShim.
 */
export function bootstrapAutomation() {
  if (shimsBootstrapped) return;
  shimsBootstrapped = true;

  try {
    bootstrapcookingSessionShim();
  } catch (e) {
    if (import.meta.env?.DEV) {
      console.warn(
        "[automation.runtime] Failed to bootstrap cookingSessionShim",
        e,
      );
    }
  }
}

/** Optional alias if other code prefers `bootstrap()` */
export function bootstrap() {
  bootstrapAutomation();
}

// Helper emitters aligned with flows
export function emitDraftReady(draft, draftType = "cooking") {
  return automation.emitEvent("draft.ready", { draft, draftType });
}
export function emitDraftApproved({
  draftId,
  calendar = { enabled: true, calendarId: null },
}) {
  return automation.emitEvent("draft.approved", { draftId, calendar });
}
export function emitProgress(taskId, phase, pct) {
  return automation.emitEvent("progress", { taskId, phase, pct });
}

/* ✅ COMPAT EXPORTS (for legacy imports like: import { on, emit } from runtime) */
export function on(topic, handler) {
  return automation.onTopic(topic, handler);
}
export function emit(topic, payload) {
  return automation.emitEvent(topic, payload);
}

/* ─────────────────────── opinionated middlewares ───────────────────────── */
automation
  .useAfter((next) => async (id, ctx, options) => {
    const res = await next(id, ctx, options);
    automation.emitEvent("template.result", {
      id,
      result: res,
      ts: now(),
    });
    return res;
  })
  .useFinally((next) => async (id, ctx, options) => {
    try {
      const out = await next(id, ctx, options);
      if (isBrowser && window.__AUTOMATION_DEBUG__) {
        try {
          console.debug("[automation] ran", id, { ctx, options });
        } catch {}
      }
      return out;
    } finally {
      try {
        automation._persist();
      } catch {}
    }
  });

/* ────────────────── shared orchestration (rules & triggers) ────────────── */
// NBA when drafts appear
automation.addRule({
  id: "nba:draft-ready",
  if: (evt) => evt?.topic === "draft.ready",
  then: (auto, evt) => {
    auto.emitEvent("nba.suggest", {
      kind: "review-draft",
      draftType: evt.payload?.draftType,
    });
  },
});
// Inventory → replenish suggestion
automation.addRule({
  id: "nba:inventory-updated",
  if: (evt) => evt?.topic === "inventory.updated",
  then: (auto, evt) => {
    const lowItems = evt?.payload?.lowItems || 0;
    if (lowItems > 0)
      auto.emitEvent("nba.suggest", { kind: "replenish", count: lowItems });
  },
});
// Storehouse → stock toward goal
automation.addRule({
  id: "nba:storehouse-goal",
  if: (evt) =>
    evt?.topic === "storehouse.goal.variance" &&
    (evt.payload?.variance || 0) < 0,
  then: (auto, evt) => {
    auto.emitEvent("nba.suggest", {
      kind: "storehouse-replenish",
      variance: evt.payload?.variance,
      goalId: evt.payload?.goalId,
    });
  },
});
// Mealplan → animal-from-recipes (reverse gen)
automation.addRule({
  id: "nba:mealplan-to-animals",
  if: (evt) =>
    evt?.topic === "mealplan.generated" &&
    Array.isArray(evt?.payload?.meals) &&
    evt.payload.meals.length > 0,
  then: (auto, evt) => {
    auto.emitEvent("reverse.generate.request", {
      source: "mealplan",
      target: "animals",
      meals: evt.payload.meals,
    });
  },
});
// Garden → storehouse harvest → inventory
automation.addRule({
  id: "nba:garden-harvest",
  if: (evt) => evt?.topic === "garden.harvest.logged",
  then: (auto, evt) => {
    auto.emitEvent("inventory.ingest.request", {
      from: "garden",
      items: evt?.payload?.items || [],
    });
  },
});

/* ───────────────────── listen for automation.schedule.request ─────────────
   Canonical path for *all* domain scheduling.
-------------------------------------------------------------------------- */
automation.addRule({
  id: "automation:schedule:request:handler",
  if: (evt) => evt?.topic === "automation.schedule.request",
  then: async (auto, evt) => {
    const p = evt.payload || {};
    const res = auto.saveSchedule({
      id: p.id,
      title: p.title,
      templateId: p.templateId,
      rule: p.rule,
      days: p.days,
      tags: p.tags || [],
      ctx: p.ctx || {},
      priority: p.priority ?? 1,
      meta: p.meta || {},
    });
    if (res.ok) {
      const created = {
        scheduleId: res.id,
        nextAt: res.nextAt,
        templateId: p.templateId,
        domain: p.meta?.domain || "general",
        hubOnly: p.meta?.hubOnly || false,
        tier: p.meta?.tier || null,
      };
      auto.emitEvent("automation.schedule.created", created);

      // ───── NEW: optionally export schedule to Hub if enabled ─────
      await exportToHubIfEnabled({
        kind: "automation-schedule",
        ...created,
        ctx: p.ctx || {},
        meta: p.meta || {},
      });
    } else {
      auto.emitEvent("automation.schedule.failed", {
        reason: res.error || "unknown",
        templateId: p.templateId,
      });
    }
  },
});

/* ───────────────────── domain-specific schedule remaps ────────────────────
   Everything below emits → automation.schedule.request
   so your UI / Dexie / Sync can stay in ONE place.
-------------------------------------------------------------------------- */
automation.registerTrigger(({ ctx, on }) => {
  const unsubs = [];

  // cleaning
  unsubs.push(
    on("cleaning/session/schedule", (evt) => {
      const p = evt.payload || {};
      ctx.emitEvent("automation.schedule.request", {
        id: p.id,
        title: p.title || "Cleaning Session",
        templateId: p.templateId || "cleaning.session.generate",
        rule: p.rule || p.schedule || { at: "09:00" },
        days: p.days,
        ctx: p.ctx || { sessionId: p.sessionId },
        meta: {
          domain: "cleaning",
          sessionId: p.sessionId,
          tier: p.tier || null,
        },
      });
    }),
  );

  // cooking / batch
  unsubs.push(
    on("cooking/session/schedule", (evt) => {
      const p = evt.payload || {};
      ctx.emitEvent("automation.schedule.request", {
        id: p.id,
        title: p.title || "Cooking / Batch Session",
        templateId: p.templateId || "cooking.session.generate",
        rule: p.rule || p.schedule || { at: "15:00" },
        days: p.days,
        ctx: p.ctx || { sessionId: p.sessionId, recipes: p.recipes || [] },
        meta: {
          domain: "cooking",
          sessionId: p.sessionId,
          tier: p.tier || null,
        },
      });
    }),
  );

  // garden
  unsubs.push(
    on("garden/session/schedule", (evt) => {
      const p = evt.payload || {};
      ctx.emitEvent("automation.schedule.request", {
        id: p.id,
        title: p.title || "Garden Session",
        templateId: p.templateId || "garden.session.generate",
        rule: p.rule || p.schedule || { at: "08:00" },
        days: p.days,
        ctx: p.ctx || { sessionId: p.sessionId },
        meta: {
          domain: "garden",
          sessionId: p.sessionId,
          coop: p.coop || false,
          tier: p.tier || null,
        },
      });
    }),
  );

  // animals / butchery
  unsubs.push(
    on("animals/session/schedule", (evt) => {
      const p = evt.payload || {};
      ctx.emitEvent("automation.schedule.request", {
        id: p.id,
        title: p.title || "Animal Session",
        templateId: p.templateId || "animals.session.generate",
        rule: p.rule || p.schedule || { at: "07:00" },
        days: p.days,
        ctx: p.ctx || { sessionId: p.sessionId },
        meta: {
          domain: "animals",
          sessionId: p.sessionId,
          reverseFromRecipes: !!p.reverseFromRecipes,
          tier: p.tier || null,
        },
      });
    }),
  );

  // inventory
  unsubs.push(
    on("inventory/session/schedule", (evt) => {
      const p = evt.payload || {};
      ctx.emitEvent("automation.schedule.request", {
        id: p.id,
        title: p.title || "Inventory Session",
        templateId: p.templateId || "inventory.session.generate",
        rule: p.rule || p.schedule || { at: "10:00" },
        days: p.days,
        ctx: p.ctx || { sessionId: p.sessionId },
        meta: {
          domain: "inventory",
          sessionId: p.sessionId,
          tier: p.tier || null,
        },
      });
    }),
  );

  // storehouse (Goals Planner) – distinct from inventory
  unsubs.push(
    on("storehouse/goal/schedule", (evt) => {
      const p = evt.payload || {};
      ctx.emitEvent("automation.schedule.request", {
        id: p.id,
        title: p.title || "Storehouse Goal Session",
        templateId: p.templateId || "storehouse.goal.generate",
        rule: p.rule || p.schedule || { at: "11:00" },
        days: p.days,
        ctx: p.ctx || { goalId: p.goalId },
        meta: {
          domain: "storehouse",
          goalId: p.goalId,
          tier: p.tier || null,
        },
      });
    }),
  );

  // mealplan → schedule a refresh or application
  unsubs.push(
    on("mealplan/session/schedule", (evt) => {
      const p = evt.payload || {};
      ctx.emitEvent("automation.schedule.request", {
        id: p.id,
        title: p.title || "Meal Plan Refresh",
        templateId: p.templateId || "mealplan.session.generate",
        rule: p.rule || p.schedule || { at: "06:30" },
        days: p.days,
        ctx: p.ctx || {
          profileId: p.profileId,
          source: p.source || "user",
        },
        meta: {
          domain: "mealplan",
          profileId: p.profileId,
          tier: p.tier || null,
        },
      });
    }),
  );

  // Scan • Compare • Trust (pricebook, circular scrape, coupon checks)
  unsubs.push(
    on("scan-compare-trust/session/schedule", (evt) => {
      const p = evt.payload || {};
      ctx.emitEvent("automation.schedule.request", {
        id: p.id,
        title: p.title || "Scan • Compare • Trust Run",
        templateId: p.templateId || "sct.session.generate",
        rule: p.rule || p.schedule || { everyMinutes: 240 }, // every 4 hours by default
        ctx: p.ctx || { source: p.source || "bookmarklet" },
        meta: { domain: "scan-compare-trust", tier: p.tier || null },
      });
    }),
  );

  // Import → Planner (Pinterest, recipe sites, garden sites, store / grocery inspiration)
  unsubs.push(
    on("import/session/schedule", (evt) => {
      const p = evt.payload || {};
      ctx.emitEvent("automation.schedule.request", {
        id: p.id,
        title: p.title || "Import → Planner",
        templateId: p.templateId || "import.session.process",
        rule: p.rule || p.schedule || { everyMinutes: 180 },
        ctx: p.ctx || { importId: p.importId, origin: p.origin },
        meta: {
          domain: "import",
          origin: p.origin,
          tier: p.tier || null,
        },
      });
    }),
  );

  // co-op / collab / Family Fund Hub – “many hands make light work”
  unsubs.push(
    on("coop/session/schedule", (evt) => {
      const p = evt.payload || {};
      ctx.emitEvent("automation.schedule.request", {
        id: p.id,
        title: p.title || p.coopTitle || "Co-op Shared Session",
        templateId: p.templateId || "coop.session.generate",
        rule: p.rule || p.schedule || { at: "14:00" },
        days: p.days,
        ctx: p.ctx || { households: p.households || [], goal: p.goal || null },
        meta: {
          domain: "coop",
          households: p.households || [],
          goal: p.goal || null,
          tier: p.tier || null,
          hubOnly: !!p.hubOnly,
        },
      });
    }),
  );

  // ✅ Shopping Mode (scan while shopping, price/coupon/recall/ingredients checks)
  // Note: does NOT commit to household inventory — receipt is the commit gate.
  unsubs.push(
    on("shopping/session/schedule", (evt) => {
      const p = evt.payload || {};
      ctx.emitEvent("automation.schedule.request", {
        id: p.id,
        title: p.title || "Shopping Mode Check",
        templateId: p.templateId || "shopping.session.evaluate",
        rule: p.rule || p.schedule || { everyMinutes: 60 },
        days: p.days,
        ctx: p.ctx || {
          tripId: p.tripId,
          storeId: p.storeId,
          storeName: p.storeName,
          locations: p.locations || [],
          mode: "shopping",
        },
        meta: {
          domain: "shopping",
          tripId: p.tripId,
          storeId: p.storeId,
          tier: p.tier || null,
          hubOnly: !!p.hubOnly,
        },
      });
    }),
  );

  return () =>
    unsubs.forEach((u) => {
      try {
        u();
      } catch {}
    });
});

/* ─────────────────── reverse generation event → automation ────────────────
   If any domain emits "reverse.generate.request", we try to schedule the
   corresponding generator. Example:
   - mealplan → animals
   - calendar → storehouse
   - garden intention list → mealplan (seasonal)
-------------------------------------------------------------------------- */
automation.addRule({
  id: "reverse:generate:router",
  if: (evt) => evt?.topic === "reverse.generate.request",
  then: (auto, evt) => {
    const p = evt.payload || {};
    const source = p.source;
    const target = p.target;
    // map to template ids
    const mapping = {
      "mealplan→animals": "animals.session.generate",
      "calendar→storehouse": "storehouse.goal.generate",
      "garden→mealplan": "mealplan.session.generate",
    };
    let templateId = null;
    if (source === "mealplan" && target === "animals")
      templateId = mapping["mealplan→animals"];
    if (source === "calendar" && target === "storehouse")
      templateId = mapping["calendar→storehouse"];
    if (source === "garden" && target === "mealplan")
      templateId = mapping["garden→mealplan"];
    if (!templateId) return;
    auto.emitEvent("automation.schedule.request", {
      title: `Reverse: ${source} → ${target}`,
      templateId,
      rule: { at: "05:00" },
      ctx: p,
      meta: { domain: target, reverse: true },
    });
  },
});

/* ───────────────── share / export / publish to other households ───────────
   Any UI / feature can emit:
   automation.emitEvent("automation.export.request", {
     kind: "schedule" | "session" | "plan",
     id: "...",
     to: ["household:abc", "co-op:tomatoes"],
     visibility: "hub-only" | "family" | "public"
   });
-------------------------------------------------------------------------- */
automation.addRule({
  id: "automation:export:request",
  if: (evt) => evt?.topic === "automation.export.request",
  then: (auto, evt) => {
    const p = evt.payload || {};
    // We don’t really export here – we fan it out to the bus so the
    // Hub / Sync / Storage layer can pick it up.
    try {
      bus.emit?.("automation.export.ready", {
        kind: p.kind,
        id: p.id,
        to: p.to || [],
        visibility: p.visibility || "family",
        meta: p.meta || {},
      });
    } catch {}
    auto.emitEvent("automation.export.completed", {
      kind: p.kind,
      id: p.id,
      to: p.to || [],
    });
  },
});

/* ───────────────────────── Shopping Mode orchestration ────────────────────
   - shopping.item.scanned  → evaluate (pricing/coupons/recalls/ingredients)
   - shopping.receipt.received → commit (receipt-gated) + cost tracking hook
   These are deliberately defensive: if the underlying services aren’t present,
   they still emit lifecycle events for UI/logging.
-------------------------------------------------------------------------- */
automation.addRule({
  id: "shopping:item-scanned:auto-eval",
  if: (evt) => evt?.topic === "shopping.item.scanned",
  then: (auto, evt) => {
    const p = evt?.payload || {};
    auto.enqueueRun("shopping.item.evaluate", {
      priority: 2,
      ctx: {
        ...p,
        // normalize a few likely fields
        upc: p.upc || p.barcode || p.gtin || null,
        query: p.query || p.name || null,
        tripId: p.tripId || null,
        storeId: p.storeId || null,
        storeName: p.storeName || null,
        locations: p.locations || p.compareStores || [],
        mode: "shopping",
      },
    });
  },
});

automation.addRule({
  id: "shopping:receipt:received:auto-commit",
  if: (evt) => evt?.topic === "shopping.receipt.received",
  then: (auto, evt) => {
    const p = evt?.payload || {};
    auto.enqueueRun("shopping.receipt.commit", {
      priority: 2,
      ctx: {
        ...p,
        receiptId: p.receiptId || p.id || null,
        tripId: p.tripId || null,
        storeId: p.storeId || null,
        storeName: p.storeName || null,
        items: Array.isArray(p.items) ? p.items : [],
        totals: p.totals || null,
        mode: "shopping",
      },
    });
  },
});

/* ───────────────── cleaning: built-in commands/templates (existing) ─────── */
(async function registerCleaningTemplates() {
  let CleaningPlanManager = null;
  try {
    const mod = await import("@/managers/CleaningPlanManager");
    CleaningPlanManager = mod?.default ?? mod;
  } catch {}

  automation.registerTemplate({
    id: "cleaning.session.generate",
    title: "Generate Cleaning Routine",
    description:
      "Create a CleaningPlan from Standard/Deep templates (declutter-first aware).",
    tags: ["cleaning", "generate", "household"],
    timeoutMs: 10_000,
    async run(ctx) {
      if (!CleaningPlanManager?.generateRoutine) {
        console.warn(
          "[automation.cleaning] CleaningPlanManager.generateRoutine unavailable",
        );
        return { ok: false, reason: "manager-missing" };
      }
      const plan = await CleaningPlanManager.generateRoutine(ctx || {});
      automation.emitEvent("cleaning.routine.generated", {
        planId: plan?.id,
        routineType: plan?.routineType,
        longCadence: plan?.longCadence || null,
        deepFocus: plan?.deepFocus || null,
      });
      if (plan?.routineType === "Deep") {
        automation.emitEvent("cleaning.nba.suggest", {
          kind: "deep-focus",
          message:
            "Deep Clean Focus generated. Start with entry/mudroom landing zones and 5-bin declutter.",
          planId: plan.id,
        });
      }
      return { ok: true, plan };
    },
  });

  automation.registerTemplate({
    id: "cleaning.routine.generate",
    title: "Generate Cleaning Routine (Alias)",
    description: "Alias for cleaning.session.generate",
    tags: ["cleaning", "alias"],
    async run(ctx) {
      return automation.runTemplate("cleaning.session.generate", ctx, {
        timeoutMs: 10_000,
      });
    },
  });
})();

/* ───────────────────── Shopping Mode templates (NEW) ────────────────────── */
(async function registerShoppingTemplates() {
  // No hard deps here; everything is lazily imported inside run().
  automation.registerTemplate({
    id: "shopping.session.evaluate",
    title: "Shopping Mode Evaluate (Batch)",
    description:
      "Evaluate shopping-mode basket/items for pricing, coupons, recalls, and ingredients without committing to household inventory.",
    tags: ["shopping", "scan", "compare", "trust", "evaluate"],
    timeoutMs: 15_000,
    async run(ctx) {
      const tripId = ctx?.tripId || null;
      automation.emitEvent("shopping.session.evaluating", {
        tripId,
        storeId: ctx?.storeId || null,
        storeName: ctx?.storeName || null,
        ts: now(),
      });

      // If UI wants a background sweep: it can pass ctx.items (basket)
      const items = Array.isArray(ctx?.items) ? ctx.items : [];

      let ShoppingEvaluator = null;
      try {
        const mod =
          await import("@/features/shopping/services/ShoppingEvaluator");
        ShoppingEvaluator = mod?.default ?? mod;
      } catch {}

      if (
        !ShoppingEvaluator?.evaluateTrip &&
        !ShoppingEvaluator?.evaluateItems
      ) {
        // still emit a shape so UI can show “engine missing” gracefully
        automation.emitEvent("shopping.session.evaluated", {
          ok: false,
          reason: "service-missing",
          tripId,
          count: items.length,
          results: [],
        });
        return { ok: false, reason: "service-missing" };
      }

      const results = ShoppingEvaluator.evaluateTrip
        ? await ShoppingEvaluator.evaluateTrip({ ...ctx, items })
        : await ShoppingEvaluator.evaluateItems(items, ctx);

      automation.emitEvent("shopping.session.evaluated", {
        ok: true,
        tripId,
        count: items.length,
        results: results || [],
      });

      return { ok: true, tripId, results: results || [] };
    },
  });

  automation.registerTemplate({
    id: "shopping.item.evaluate",
    title: "Shopping Item Evaluate",
    description:
      "Evaluate a scanned item for pricing, coupons, recalls, and ingredients in Shopping Mode. Does not commit to household inventory.",
    tags: ["shopping", "scan", "compare", "trust", "item"],
    timeoutMs: 12_000,
    async run(ctx) {
      const upc = ctx?.upc || null;

      automation.emitEvent("shopping.item.evaluating", {
        upc,
        tripId: ctx?.tripId || null,
        storeId: ctx?.storeId || null,
        storeName: ctx?.storeName || null,
        ts: now(),
      });

      let evaluator = null;
      try {
        const mod =
          await import("@/features/shopping/services/ShoppingEvaluator");
        evaluator = mod?.default ?? mod;
      } catch {}

      // Optional: allow reusing existing SCT services if you already have them
      // (kept defensive so this file doesn’t require those modules).
      let sct = null;
      try {
        const mod =
          await import("@/app/features/scan-compare-trust/services/SCTOrchestrator");
        sct = mod?.default ?? mod;
      } catch {}

      const payload = { ...ctx, upc };

      let result = null;
      try {
        if (evaluator?.evaluateItem)
          result = await evaluator.evaluateItem(payload);
        else if (sct?.evaluateOne) result = await sct.evaluateOne(payload);
        else if (sct?.evaluate) result = await sct.evaluate(payload);
      } catch (e) {
        const msg = e?.message || String(e);
        automation.emitEvent("shopping.item.evaluated", {
          ok: false,
          upc,
          error: msg,
        });
        return { ok: false, error: msg };
      }

      automation.emitEvent("shopping.item.evaluated", {
        ok: true,
        upc,
        tripId: ctx?.tripId || null,
        storeId: ctx?.storeId || null,
        storeName: ctx?.storeName || null,
        result: result || null,
      });

      // Optional: export to Hub if enabled (shopping evaluation packets can fuel local ads analytics)
      await exportToHubIfEnabled({
        kind: "shopping-item-evaluated",
        upc,
        tripId: ctx?.tripId || null,
        storeId: ctx?.storeId || null,
        storeName: ctx?.storeName || null,
        result: result || null,
        meta: { domain: "shopping", hubOnly: !!ctx?.hubOnly },
      });

      return { ok: true, result: result || null };
    },
  });

  automation.registerTemplate({
    id: "shopping.receipt.commit",
    title: "Shopping Receipt Commit",
    description:
      "Receipt-gated commit: writes purchased items + costs to household systems (inventory/pricebook) only after receipt is received.",
    tags: ["shopping", "receipt", "commit", "costs"],
    timeoutMs: 20_000,
    async run(ctx) {
      const receiptId = ctx?.receiptId || null;
      const tripId = ctx?.tripId || null;
      const items = Array.isArray(ctx?.items) ? ctx.items : [];

      automation.emitEvent("shopping.receipt.committing", {
        receiptId,
        tripId,
        count: items.length,
        storeId: ctx?.storeId || null,
        storeName: ctx?.storeName || null,
        ts: now(),
      });

      let ReceiptCommitService = null;
      try {
        const mod =
          await import("@/features/shopping/services/ReceiptCommitService");
        ReceiptCommitService = mod?.default ?? mod;
      } catch {}

      if (!ReceiptCommitService?.commitReceipt) {
        // Emit that we received receipt but cannot commit yet (still good for UI)
        automation.emitEvent("shopping.receipt.committed", {
          ok: false,
          reason: "service-missing",
          receiptId,
          tripId,
          count: items.length,
        });
        return { ok: false, reason: "service-missing" };
      }

      const out = await ReceiptCommitService.commitReceipt({
        ...ctx,
        receiptId,
        tripId,
        items,
      });

      automation.emitEvent("shopping.receipt.committed", {
        ok: true,
        receiptId,
        tripId,
        result: out || null,
      });

      // Optional: export commit packet to Hub if reminder/coop accounting needs it
      await exportToHubIfEnabled({
        kind: "shopping-receipt-committed",
        receiptId,
        tripId,
        storeId: ctx?.storeId || null,
        storeName: ctx?.storeName || null,
        totals: ctx?.totals || null,
        count: items.length,
        meta: { domain: "shopping", hubOnly: !!ctx?.hubOnly },
      });

      return { ok: true, result: out || null };
    },
  });
})();

/* ─────────────────────── auto-start (browser) ───────────────────────────── */
if (isBrowser) {
  queueMicrotask(() => {
    try {
      // ✅ Ensure shims (including cookingSessionShim) are wired up
      bootstrapAutomation();
    } catch {}
    try {
      automation.start({ source: "auto" });
    } catch {}
  });
}

/* NOTE: Keep all other code the same. */
