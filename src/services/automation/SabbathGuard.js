// C:\Users\larho\suka-smart-assistant\src\services\automation\SabbathGuard.js
/* ============================================================================
   SabbathGuard — automation guardrails for Sabbath & Feast days
   - Blocks or downgrades certain automations during protected windows
   - Sunset-to-sunset (Fri→Sat) with optional Feast/Holy Day windows
   - Defensive, zero-hard-deps; integrates with Preferences/Calendar if present
   - Emits rich events so UI can show badges, toasts, and "Next Best Action"
   - Works with the upgraded AutomationRuntime (useBefore middleware)
   ----------------------------------------------------------------------------
   Inspirations:
   - Linear/Asana: non-blocking toasts with "why" + "override" affordances
   - Apple Screen Time: policy layers with allowlists/exceptions
   - GitHub Actions: soft-fail with logs + manual rerun
============================================================================ */

import { BaseAgent } from "@/services/automation/runtime";

/* ----------------------------------------------------------------------------
   Defensive optional imports (no hard coupling)
---------------------------------------------------------------------------- */
let PreferencesStore, CalendarStore, eventBus, automation;
try {
  ({ usePreferencesStore: PreferencesStore } = await import(
    "@/store/PreferencesStore"
  ));
} catch {}
try {
  ({ useCalendarStore: CalendarStore } = await import("@/store/CalendarStore"));
} catch {}
try {
  ({ eventBus } = await import("@/services/events/eventBus"));
} catch {}
try {
  ({ automation } = await import("@/services/automation/runtime"));
} catch {}

/* ----------------------------------------------------------------------------
   Optional SunCalc for civil sunset/sunrise if available; fallback otherwise
---------------------------------------------------------------------------- */
let SunCalc = null;
try {
  SunCalc = (await import("suncalc")).default || (await import("suncalc"));
} catch {}

/* =============================================================================
   Defaults & helpers
============================================================================= */
const isBrowser = typeof window !== "undefined";
const nowTs = () => Date.now();

const DEFAULTS = {
  enabled: true,
  // "sunset" or fixed time like "18:00". "sunset" is recommended.
  sabbathStartRule: "sunset",
  sabbathEndRule: "sunset",
  // Exceptions allow essential life/safety tasks; tag/ID allow-lists too.
  exceptions: {
    categories: ["health", "safety", "livestock", "urgent-fix"],
    tagsAllow: ["essential", "safety", "health"],
    templatesAllow: [],
  },
  // When true, Feast/Holy days (from Hebrew Calendar service) become protected
  includeFeasts: true,
  // Locality for sunset calc (fallbacks to geolocation or default lat/lon)
  location: { lat: 33.6598, lon: -85.8316, tz: "America/Chicago" }, // Anniston AL default; user can override
  // Visual: emit guard events that UI can listen to
  emitUIEvents: true,
  // Behavior when blocked: "skip" (soft), "queue" (requeue later), or "error"
  onBlock: "skip",
  // Allow emergency override via ctx.meta.override === true
  allowEmergencyOverride: true,
};

/* ----------------------------------------------------------------------------
   Time helpers
---------------------------------------------------------------------------- */
function parseHHMM(s) {
  const m = String(s || "")
    .trim()
    .match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const mm = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return { hh, mm };
}

function atLocal(dateLike, hh, mm) {
  const d = new Date(dateLike);
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addDays(ts, days) {
  const d = new Date(ts);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function between(ts, a, b) {
  return ts >= Math.min(a, b) && ts <= Math.max(a, b);
}

/* ----------------------------------------------------------------------------
   Sunset computation (SunCalc → civil twilight fallback → fixed time)
---------------------------------------------------------------------------- */
function sunsetTsFor(dateTs, loc, fallbackHHMM = { hh: 18, mm: 0 }) {
  if (SunCalc && loc?.lat != null && loc?.lon != null) {
    try {
      const d = new Date(dateTs);
      const times = SunCalc.getTimes(d, Number(loc.lat), Number(loc.lon));
      // Prefer sunset; if not, fallback to end of civil twilight or default
      return (
        times.sunset?.getTime?.() ??
        times.dusk?.getTime?.() ??
        atLocal(dateTs, fallbackHHMM.hh, fallbackHHMM.mm)
      );
    } catch {}
  }
  return atLocal(dateTs, fallbackHHMM.hh, fallbackHHMM.mm);
}

/* ----------------------------------------------------------------------------
   User Settings fetchers (defensive)
---------------------------------------------------------------------------- */
function readUserSettings() {
  const p = PreferencesStore?.();
  const sab = p?.sabbath || {};
  const guard = p?.guardrails || {};
  // Merge defaults with user prefs (where present)
  const cfg = {
    ...DEFAULTS,
    enabled: guard.sabbathEnabled ?? sab.enabled ?? DEFAULTS.enabled,
    sabbathStartRule: sab.startRule || DEFAULTS.sabbathStartRule,
    sabbathEndRule: sab.endRule || DEFAULTS.sabbathEndRule,
    exceptions: {
      ...DEFAULTS.exceptions,
      ...(guard.sabbathExceptions || {}),
      ...(sab.exceptions || {}),
    },
    includeFeasts: sab.includeFeasts ?? DEFAULTS.includeFeasts,
    location: sab.location || guard.location || DEFAULTS.location,
    onBlock: sab.onBlock || guard.onBlock || DEFAULTS.onBlock,
    allowEmergencyOverride:
      sab.allowEmergencyOverride ?? DEFAULTS.allowEmergencyOverride,
    emitUIEvents: guard.emitUIEvents ?? DEFAULTS.emitUIEvents,
  };
  return cfg;
}

function readFeastWindows(epochStart = startOfDay(Date.now()), days = 30) {
  // Expected shape from CalendarStore (if present):
  // [{ start: ts, end: ts, code: "YOM_TERUAH", name: "...", type: "feast" }, ...]
  try {
    const c = CalendarStore?.();
    const list =
      c?.getProtectedWindows?.(epochStart, addDays(epochStart, days)) ||
      c?.feastWindows ||
      [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/* ----------------------------------------------------------------------------
   Compute Sabbath window (Fri sunset → Sat sunset). Supports "sunset" or HH:MM.
---------------------------------------------------------------------------- */
function computeSabbathWindow(ts, cfg) {
  const loc = cfg?.location || DEFAULTS.location;
  const d = new Date(ts);
  const dow = d.getDay(); // 0 Sun ... 5 Fri, 6 Sat
  const base = startOfDay(ts);

  // Determine the Friday and Saturday dates relative to ts
  const offsetToFriday = (5 - dow + 7) % 7;
  const fridayStart = addDays(base, offsetToFriday);
  const saturdayStart = addDays(fridayStart, 1);

  // Start rule
  let sabStart;
  if (cfg.sabbathStartRule === "sunset") {
    sabStart = sunsetTsFor(fridayStart, loc);
  } else {
    const s = parseHHMM(cfg.sabbathStartRule) || { hh: 18, mm: 0 };
    sabStart = atLocal(fridayStart, s.hh, s.mm);
  }

  // End rule (Sat sunset)
  let sabEnd;
  if (cfg.sabbathEndRule === "sunset") {
    sabEnd = sunsetTsFor(saturdayStart, loc);
  } else {
    const e = parseHHMM(cfg.sabbathEndRule) || { hh: 18, mm: 0 };
    sabEnd = atLocal(saturdayStart, e.hh, e.mm);
  }

  // If current ts falls Sun–Thu, window is for the upcoming Fri→Sat.
  if (ts < sabStart) {
    return { start: sabStart, end: sabEnd };
  }
  // If ts passed sabEnd, compute next week's
  if (ts > sabEnd) {
    const nextFriStart = addDays(fridayStart, 7);
    const nextSatStart = addDays(saturdayStart, 7);
    return {
      start:
        cfg.sabbathStartRule === "sunset"
          ? sunsetTsFor(nextFriStart, loc)
          : atLocal(
              nextFriStart,
              parseHHMM(cfg.sabbathStartRule)?.hh ?? 18,
              parseHHMM(cfg.sabbathStartRule)?.mm ?? 0
            ),
      end:
        cfg.sabbathEndRule === "sunset"
          ? sunsetTsFor(nextSatStart, loc)
          : atLocal(
              nextSatStart,
              parseHHMM(cfg.sabbathEndRule)?.hh ?? 18,
              parseHHMM(cfg.sabbathEndRule)?.mm ?? 0
            ),
    };
  }
  return { start: sabStart, end: sabEnd };
}

/* ----------------------------------------------------------------------------
   Feast/Holy day windows (sunset→sunset) from CalendarStore (optional)
---------------------------------------------------------------------------- */
function feastWindowsAround(ts, cfg) {
  if (!cfg?.includeFeasts) return [];
  const loc = cfg?.location || DEFAULTS.location;
  const st = startOfDay(ts);
  const raws = readFeastWindows(st, 60);
  const norm = [];
  for (const w of raws) {
    if (!w?.start || !w?.end) continue;
    // If store already gives sunset-bounded windows, keep them.
    // Otherwise expand to sunset→sunset around their start day.
    const startIsDayBoundary =
      new Date(w.start).getHours() === 0 &&
      new Date(w.start).getMinutes() === 0;
    const endIsDayBoundary =
      new Date(w.end).getHours() === 0 && new Date(w.end).getMinutes() === 0;

    if (startIsDayBoundary && endIsDayBoundary) {
      const feastStart = sunsetTsFor(w.start, loc);
      const feastEnd = sunsetTsFor(addDays(w.end, -1), loc); // end at following sunset of last day
      norm.push({
        start: feastStart,
        end: feastEnd,
        code: w.code,
        name: w.name,
        type: w.type || "feast",
      });
    } else {
      norm.push({
        start: w.start,
        end: w.end,
        code: w.code,
        name: w.name,
        type: w.type || "feast",
      });
    }
  }
  return norm;
}

/* =============================================================================
   Core API
============================================================================= */

/**
 * Determine whether the current moment (or given ts) is within a protected window.
 * Returns { active: boolean, reason: 'sabbath'|'feast'|null, window: {start,end} | null }
 */
export function isProtectedNow(ts = nowTs(), settings = null) {
  const cfg = { ...DEFAULTS, ...(settings || readUserSettings()) };
  if (!cfg.enabled) return { active: false, reason: null, window: null };

  // Sabbath window
  const sab = computeSabbathWindow(ts, cfg);
  if (between(ts, sab.start, sab.end)) {
    return { active: true, reason: "sabbath", window: sab };
  }

  // Feast windows
  for (const fw of feastWindowsAround(ts, cfg)) {
    if (between(ts, fw.start, fw.end)) {
      return { active: true, reason: "feast", window: fw };
    }
  }

  return { active: false, reason: null, window: null };
}

/**
 * Policy decision for a given template run.
 * @param {Object} params
 *  - template: the normalized template (from automation.getTemplate(id))
 *  - ctx: runtime ctx passed to the template
 *  - settings: optional override settings
 *  - meta: { purpose, category, tags, requestedBy, override }
 * Returns { allow: boolean, mode: 'normal'|'skip'|'queue'|'error', reason?, until? }
 */
export function sabbathPolicy({
  template,
  ctx = {},
  settings = null,
  meta = {},
} = {}) {
  const cfg = { ...DEFAULTS, ...(settings || readUserSettings()) };

  // Short-circuit when disabled
  if (!cfg.enabled) return { allow: true, mode: "normal" };

  // Emergency/manual override
  if (
    cfg.allowEmergencyOverride &&
    (meta.override === true || ctx?.meta?.override === true)
  ) {
    return { allow: true, mode: "normal", reason: "override" };
  }

  const protection = isProtectedNow(nowTs(), cfg);
  if (!protection.active) return { allow: true, mode: "normal" };

  // Exception checks
  const tTags = (template?.tags || []).map(String);
  const mTags = (meta?.tags || []).map(String);

  // Template-level allowlist
  if (cfg.exceptions.templatesAllow?.includes?.(template?.id)) {
    return { allow: true, mode: "normal", reason: "allowlist-template" };
  }

  // Tag-level allowlist
  const allowByTag =
    tTags.some((t) => cfg.exceptions.tagsAllow.includes(t)) ||
    mTags.some((t) => cfg.exceptions.tagsAllow.includes(t));

  if (allowByTag) {
    return { allow: true, mode: "normal", reason: "allowlist-tag" };
  }

  // Category-level exception (health/safety/livestock/etc.)
  const category = meta?.category || "general";
  if (cfg.exceptions.categories.includes(category)) {
    return {
      allow: true,
      mode: "normal",
      reason: `allowlist-category:${category}`,
    };
  }

  // Otherwise block according to onBlock behavior
  const until = protection.window?.end ?? null;
  switch (cfg.onBlock) {
    case "error":
      return { allow: false, mode: "error", reason: protection.reason, until };
    case "queue":
      return { allow: false, mode: "queue", reason: protection.reason, until };
    case "skip":
    default:
      return { allow: false, mode: "skip", reason: protection.reason, until };
  }
}

/* ----------------------------------------------------------------------------
   Middleware installer for AutomationRuntime
   - Blocks or re-queues runs during protected windows
   - Emits "guard.blocked" and "guard.notice" events for UI/agents
---------------------------------------------------------------------------- */
export function attachSabbathMiddleware(runtime, opts = {}) {
  const rt = runtime || automation;
  if (!rt?.useBefore) {
    console.warn("[SabbathGuard] Automation runtime missing useBefore()");
    return () => {};
  }

  const unsub = rt.useBefore((next) => async (id, ctx, options) => {
    // Read template & decide
    const tpl = rt.getTemplate?.(id);
    const meta = options?.meta || {};
    const decision = sabbathPolicy({
      template: tpl,
      ctx,
      settings: opts.settings,
      meta,
    });

    if (decision.allow) return next(id, ctx, options);

    // Emit UI events (toasts/banners)
    if ((opts.emitUIEvents ?? DEFAULTS.emitUIEvents) && rt.emitEvent) {
      rt.emitEvent("guard.blocked", {
        guard: "sabbath",
        templateId: id,
        reason: decision.reason,
        until: decision.until,
        category: meta?.category || "general",
        tags: tpl?.tags || [],
        ts: nowTs(),
        action: decision.mode,
      });
    }

    // Enforce policy
    if (decision.mode === "error") {
      // Throwing will be caught by runtime retry logic (if configured)
      throw new Error(
        `[SabbathGuard] Blocked "${id}" during ${
          decision.reason || "protected window"
        }`
      );
    }
    if (decision.mode === "queue") {
      // Re-queue with a delay (after-until or minimum backoff)
      const delay = Math.max(
        1000 * 60 * 5,
        (decision.until ?? nowTs()) - nowTs()
      ); // 5min or until window end
      setTimeout(() => {
        try {
          rt.enqueueRun(id, { ...(options || {}), priority: 1 });
        } catch {}
      }, delay);
      // Soft skip for now
      return { skipped: true, reason: "guard-queued", until: decision.until };
    }

    // Default: skip
    return { skipped: true, reason: "guard-skipped", until: decision.until };
  });

  return unsub;
}

/* ----------------------------------------------------------------------------
   Convenience: one-shot soft check API (for UI buttons or workflows)
   - Returns { allowed: boolean, message, until }
---------------------------------------------------------------------------- */
export function checkSabbathFor(
  actionLabel = "this action",
  settings = null,
  meta = {}
) {
  const cfg = { ...DEFAULTS, ...(settings || readUserSettings()) };
  if (!cfg.enabled) return { allowed: true, message: "Guard disabled" };
  const p = isProtectedNow(nowTs(), cfg);
  if (!p.active) return { allowed: true, message: "Not in a protected window" };
  const scope = p.reason === "sabbath" ? "Sabbath" : "Feast day";
  const msg = `${scope} guard is active. “${actionLabel}” is paused until the window ends.`;
  return { allowed: false, message: msg, until: p.window?.end ?? null };
}

/* ----------------------------------------------------------------------------
   Agent: keeps UI in sync & posts “Next Best Action” nudges before Sabbath
   - Emits reminders to prep (e.g., batch cook, inventory sync) on Fri morning
---------------------------------------------------------------------------- */
export class SabbathGuardAgent extends BaseAgent {
  start() {
    if (this.started) return;
    super.start();

    // Listen for day/hour ticks (from AutomationRuntime ticker)
    const unsubTick = this.onEvent((evt) => {
      if (evt.topic !== "tick") return;
      try {
        this._maybeNudges();
      } catch {}
    });

    // React to calendar updates (feasts added/changed)
    const offCal =
      eventBus?.on?.("calendar.updated", () => this._maybeRefresh()) ||
      (() => {});
    this._unsubs.push(unsubTick, offCal);
    // Initial nudge evaluation
    this._maybeNudges();
  }

  _maybeRefresh() {
    // Optionally emit a small “notice” so UI badges can refresh
    try {
      this.automation?.emitEvent?.("guard.notice", {
        guard: "sabbath",
        ts: Date.now(),
      });
    } catch {}
  }

  _maybeNudges() {
    const cfg = readUserSettings();
    if (!cfg.enabled || !this.automation?.emitEvent) return;

    const ts = nowTs();
    const sab = computeSabbathWindow(ts, cfg);

    // If it's Friday morning (6–11am local), nudge to prep before Sabbath
    const d = new Date(ts);
    const isFriday = d.getDay() === 5;
    const hh = d.getHours();

    if (isFriday && hh >= 6 && hh <= 11) {
      // Only nudge once per Friday morning window
      const key = `sabbath:nudge:${new Date(sab.start).toDateString()}`;
      if (isBrowser) {
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, "1");
      }

      this.automation.emitEvent("nba", {
        topic: "nba",
        kind: "pre-sabbath-prep",
        message:
          "Sabbath begins at sunset. Would you like to auto-prepare a cooking session and finalize the shopping list?",
        actions: [
          {
            label: "Plan Batch Cooking",
            topic: "batch.plan.request",
            payload: { windowEnd: sab.start },
          },
          {
            label: "Review Shopping List",
            topic: "shopping.review.request",
            payload: { windowEnd: sab.start },
          },
        ],
        until: sab.start,
        ts,
      });
    }
  }
}

/* ----------------------------------------------------------------------------
   Boot-time helper: attach middleware + start agent (idempotent)
---------------------------------------------------------------------------- */
let _booted = false;
export function enableSabbathGuard(runtime, options = {}) {
  if (_booted) return { ok: true };
  const rt = runtime || automation;
  attachSabbathMiddleware(rt, options);
  try {
    const agent = new SabbathGuardAgent({
      automation: rt,
      bus: eventBus || rt,
    });
    agent.start();
  } catch {}
  _booted = true;
  return { ok: true };
}

/* ----------------------------------------------------------------------------
   Named export expected by Settings & pages code
   - Usage:
     import { sabbathGuard, enableSabbathGuard } from "@/services/automation/SabbathGuard"
---------------------------------------------------------------------------- */
export const sabbathGuard = {
  isProtectedNow,
  sabbathPolicy,
  attachSabbathMiddleware,
  checkSabbathFor,
  enable: enableSabbathGuard,
};
