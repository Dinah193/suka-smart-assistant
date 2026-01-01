/* eslint-disable no-console */

/**
 * Suka Smart Assistant — Torah Profile Integration Hooks (TIP)
 * -------------------------------------------------------------------
 * Goals:
 * 1) Clear IA: top-level helpers for TIP access across features.
 * 2) Intuitive flows: guard Sabbath actions, offer Undo, suggest 1 NBA.
 * 3) Consistent design: emit UI glue (empty, toast, undo, NBA).
 * 4) Event-driven: auto-refresh TIP and recompute badges/filters.
 *
 * Exports:
 *   initTIP()
 *   getTIP()
 *   subscribeTIP(cb)
 *   readTIP()                   // alias of getTIP for semantics
 *   isShellfish(item)
 *   isInSabbathWindow(date?, cfg?)
 *   evaluateTorahRules(entity, ctx?)      // decision/badges/reasons
 *   filterByTorah(items, opts?)
 *   stampTorahBadges(entityOrArray, context?)
 *   guardSabbathAction(actionName, { onProceed, onBlocked, allowEssentials })
 *
 *   // Minimal “touch every domain” helpers used in services/agents:
 *   guardShellfish(items, tip?)            // array in → array out
 *   withTorahBadges(artifact, tip?)        // object in → object out (+badges)
 *   sabbathGuard(fn, tip?)                 // defers during holds, else runs fn()
 */

import profileService from "@/services/profile/profileService";
import {
  events,
  NAMES,
  emitEvent,
} from "@/services/events/contracts";

/* ──────────────────────────────────────────────────────────────
 * TIP Cache + Subscriptions
 * ────────────────────────────────────────────────────────────── */

let _tip = normalizeTIPFromProfile(safeGetProfile());
const TIP_SUBS = new Set();

/** build a resilient TIP object from the profile service */
function normalizeTIPFromProfile(p) {
  const shellfishAllowed = !!p?.torah?.shellfishAllowed;
  const effectiveDate = p?.torah?.effectiveDate || null;
  const notes = p?.torah?.notes || "";

  // Sabbath defaults: Fri 18:00 → Sat 20:00 local (overridable)
  const sabbath = {
    enabled: true,
    start: { day: 5, hour: 18, minute: 0 }, // Friday 18:00
    end: { day: 6, hour: 20, minute: 0 },   // Saturday 20:00
    allowEssentials: true,
    exceptions: [],
    ...(p?.torah?.sabbath || {}),
  };

  const rules = Array.isArray(p?.torah?.rules) ? p.torah.rules : [];
  return { shellfishAllowed, effectiveDate, notes, sabbath, rules };
}

function safeGetProfile() {
  try { return profileService.get(); } catch { return {}; }
}

function notifyTIPSubs() {
  for (const cb of TIP_SUBS) {
    try { cb(_tip); } catch (e) { console.error("[TIP] subscriber error:", e); }
  }
}

/** Public: initialize + wire events (idempotent) */
export function initTIP() {
  // 1) Refresh TIP when profile changes
  events.on(NAMES["torah.profile.updated"], () => {
    _tip = normalizeTIPFromProfile(safeGetProfile());
    notifyTIPSubs();

    // Single “next best action”
    emitEvent(NAMES["ui.nba.suggested"], { label: "Recompute Meal Suggestions", hint: "Update menus & shopping list", route: "/tier2/household/meals" });

    // Consistent toast
    emitEvent(NAMES["ui.toast.shown"], {
      variant: "success",
      title: "Dietary profile updated",
      message: _tip.shellfishAllowed ? "Shellfish now included." : "Shellfish excluded.",
    });
  });

  // 2) Refresh on broader preferences
  events.on(NAMES["preferences.changed"], () => {
    _tip = normalizeTIPFromProfile(safeGetProfile());
    notifyTIPSubs();
  });

  // 3) Event glue: surface actionable single NBAs on core changes
  const nudgeOnce = debounce((payload) => emitEvent(NAMES["ui.nba.suggested"], payload), 300);

  events.on(NAMES["recipes.consolidated"], () => {
    nudgeOnce({ label: "Review Dietary Filters", hint: "Ensure recipes match your profile", route: "/settings/torah" });
  });

  events.on(NAMES["inventory.updated"], (ev) => {
    const low = Array.isArray(ev.payload?.diffs)
      ? ev.payload.diffs.filter(d => (d.delta || 0) < 0).length
      : 0;
    nudgeOnce({
      label: low > 0 ? "Generate Shopping List" : "Open Preservation Panel",
      hint: low > 0 ? "Based on low stock" : "Plan can/freeze/dehydrate",
      route: low > 0 ? "/tier2/household/meals#shopping" : "/tier2/household/meals#preservation",
    });
  });

  events.on(NAMES["calendar.synced"], () => {
    nudgeOnce({ label: "Check Sabbath Guard", hint: "Avoid scheduling during Sabbath", route: "/calendar" });
  });

  // 4) Helpful empty state on first run (no effective date)
  if (!_tip.effectiveDate) {
    emitEvent(NAMES["ui.empty.presented"], {
      context: "profile.torah",
      actions: [
        { label: "Open Dietary Profile", eventName: NAMES["ia.route.navigated"], payload: { path: "/settings/torah" } },
      ],
    });
  }

  return _tip;
}

/** Public getters + subscriptions */
export function getTIP() { return _tip; }
export function readTIP() { return _tip; }

export function subscribeTIP(cb) {
  TIP_SUBS.add(cb);
  try { cb(_tip); } catch { /* ignore */ }
  return () => TIP_SUBS.delete(cb);
}

/* ──────────────────────────────────────────────────────────────
 * Rule Evaluator
 * ────────────────────────────────────────────────────────────── */

function normalizeTextList(v) {
  if (!v) return [];
  return (Array.isArray(v) ? v : String(v).split(/[,\s/|]+/g))
    .map(x => String(x).trim().toLowerCase())
    .filter(Boolean);
}

function entityFacets(entity = {}) {
  const name = String(entity.title || entity.name || "").toLowerCase();
  const tags = normalizeTextList(entity.tags || entity.labels || entity.categories);
  const ingredients = normalizeTextList(entity.ingredients || entity.items);
  // naive inference
  const implied = new Set(tags.concat(ingredients));
  if (name.includes("cheese") || tags.includes("dairy")) implied.add("dairy");
  if (name.includes("beef") || name.includes("lamb") || name.includes("goat") || tags.includes("meat")) implied.add("meat");
  return { name, tags: Array.from(implied), ingredients };
}

/**
 * Evaluate TIP rules against an entity + context.
 * Returns { decision: "allow"|"exclude"|"warn", badges:[...], reasons:[...] }
 */
export function evaluateTorahRules(entity, ctx = {}) {
  const { rules = [], shellfishAllowed } = _tip || {};
  const { name, tags, ingredients } = entityFacets(entity);

  let decision = "allow";
  const badges = [];
  const reasons = [];

  // Built-in shellfish rule first
  const hitShell = isShellfish(entity);
  if (hitShell && !shellfishAllowed) {
    decision = "exclude";
    badges.push({ key: "shellfish", label: "Shellfish", tone: "error" });
    reasons.push("Contains shellfish and household setting disallows it.");
  }

  // Sabbath window
  const dt = ctx.date || entity.date || entity.start || entity.scheduledAt;
  if (dt && isInSabbathWindow(dt)) {
    badges.push({ key: "sabbath-hold", label: "Sabbath Hold", tone: "warning" });
  }

  // Household custom rules
  for (const r of rules) {
    if (!r?.enabled) continue;
    switch (r.type) {
      case "avoidIngredients": {
        const any = normalizeTextList(r.anyOf);
        if (any.some(a => ingredients.includes(a) || tags.includes(a) || name.includes(a))) {
          if (r.effect === "exclude") decision = "exclude";
          else if (decision !== "exclude") decision = "warn";
          badges.push({ key: r.id, label: r.label || r.id, tone: r.effect === "exclude" ? "error" : "warning" });
          reasons.push(r.label || r.id);
        }
        break;
      }
      case "avoidTags": {
        const any = normalizeTextList(r.anyOf);
        if (any.some(a => tags.includes(a) || name.includes(a))) {
          if (r.effect === "exclude") decision = "exclude";
          else if (decision !== "exclude") decision = "warn";
          badges.push({ key: r.id, label: r.label || r.id, tone: r.effect === "exclude" ? "error" : "warning" });
          reasons.push(r.label || r.id);
        }
        break;
      }
      case "requireTags": {
        const all = normalizeTextList(r.allOf);
        const ok = all.every(a => tags.includes(a));
        if (!ok) {
          if (r.effect === "exclude") decision = "exclude";
          else if (decision !== "exclude") decision = "warn";
          badges.push({ key: r.id, label: r.label || r.id, tone: "warning" });
          reasons.push(`Requires: ${all.join(", ")}`);
        }
        break;
      }
      case "avoidPairing": {
        const [a, b] = normalizeTextList(r.pair);
        const hasA = tags.includes(a) || ingredients.includes(a) || name.includes(a);
        const hasB = tags.includes(b) || ingredients.includes(b) || name.includes(b);
        if (a && b && hasA && hasB) {
          if (r.effect === "exclude") decision = "exclude";
          else if (decision !== "exclude") decision = "warn";
          badges.push({ key: r.id, label: r.label || `${a}+${b}`, tone: r.effect === "exclude" ? "error" : "warning" });
          reasons.push(r.label || `${a}+${b}`);
        }
        break;
      }
      case "calendarWindow": {
        if (String(r.window) === "unleavened" && ctx.inUnleavenedWindow === true) {
          const looksLeavened = /bread|yeast|leaven|sourdough/.test(name) || tags.includes("leavened");
          if (looksLeavened) {
            if (r.effect === "exclude") decision = "exclude";
            else if (decision !== "exclude") decision = "warn";
            badges.push({ key: r.id, label: r.label || "Unleavened Window", tone: "warning" });
            reasons.push("Leavened during Unleavened Bread window.");
          }
        }
        break;
      }
      default: break;
    }
  }

  // Merge standard badges (no dupes)
  const stamped = stampTorahBadges(entity, ctx);
  const extra = (stamped.torahBadges || []).filter(b => !badges.find(x => x.key === b.key));
  badges.push(...extra);

  return { decision, badges, reasons };
}

/* ──────────────────────────────────────────────────────────────
 * Shellfish & Filtering Helpers
 * ────────────────────────────────────────────────────────────── */

export function isShellfish(item) {
  if (!item) return false;
  const tags = toLowerArray(item.tags || item.labels || item.categories);
  const name = String(item.title || item.name || "").toLowerCase();

  const hits = [
    "shrimp","prawn","crab","lobster","crayfish","crawfish","krill",
    "clam","mussel","oyster","scallop","abalone","whelk","cockle","geoduck",
  ];
  if (tags.some(t => hits.includes(t))) return true;
  return hits.some(word => name.includes(word));
}

function toLowerArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x => String(x).toLowerCase());
  return String(v).split(/[,\s/|]+/g).map(x => x.toLowerCase()).filter(Boolean);
}

/**
 * Filter items by Torah profile and household rules.
 * - Uses evaluateTorahRules()
 * - If excluded solely by shellfish, allows a one-time override via Undo
 * - Options:
 *    - allowShellfishOverride?: boolean
 *    - respectWarn?: boolean (keeps warned items but marks _warn=true)
 *    - ctx?: object (e.g., { inUnleavenedWindow: boolean })
 */
export function filterByTorah(items, { allowShellfishOverride = false, respectWarn = false, ctx = {} } = {}) {
  if (!Array.isArray(items) || items.length === 0) return items || [];

  const visible = [];
  let hidden = 0;

  for (const it of items) {
    const ev = evaluateTorahRules(it, ctx);

    const excludedByShellfishOnly =
      ev.decision === "exclude" &&
      ev.reasons.length === 1 &&
      ev.reasons[0].toLowerCase().includes("shellfish");

    const exclude = ev.decision === "exclude" && !(allowShellfishOverride && excludedByShellfishOnly);

    if (exclude) {
      hidden++;
    } else {
      const stamped = { ...it, torahBadges: ev.badges };
      if (respectWarn && ev.decision === "warn") stamped._warn = true;
      visible.push(stamped);
    }
  }

  if (hidden > 0) {
    emitEvent(NAMES["ui.toast.shown"], { variant: "info", title: "Filtered by household rules", message: `${hidden} hidden.` });
    emitEvent(NAMES["ui.undo.offered"], { label: "Show all (override once)", ttlMs: 8000 });
    // The UI layer should trigger NAMES["ui.undo.triggered"] to apply the override in context.
  }

  return visible;
}

/* ──────────────────────────────────────────────────────────────
 * Badges (for cards/exports/lots)
 * ────────────────────────────────────────────────────────────── */

/**
 * Stamp Torah badges on an entity (or array) to be rendered by cards/tables.
 * Returns shallow clones with `torahBadges: []` and also appends `badges` array for artifacts.
 */
export function stampTorahBadges(entityOrArray, context = {}) {
  const tip = _tip;
  const stampOne = (obj) => {
    if (!obj || typeof obj !== "object") return obj;
    const copy = { ...obj };
    const badges = [];

    // Shellfish badge
    const hasShell = isShellfish(copy);
    if (hasShell && !tip.shellfishAllowed) {
      badges.push({ key: "shellfish", label: "Shellfish", tone: "error" });
    } else {
      badges.push({ key: "clean", label: "Clean", tone: "success" });
    }

    // Sabbath badge (if schedulable or has a date)
    const dt = context.date || copy.date || copy.start || copy.scheduledAt || null;
    if (dt) {
      const inSab = isInSabbathWindow(dt);
      badges.push(inSab
        ? { key: "sabbath-hold", label: "Sabbath Hold", tone: "warning" }
        : { key: "sabbath-safe", label: "Sabbath-Safe", tone: "info" });
    }

    copy.torahBadges = badges;
    // Also mirror into a generic "badges" field used by exporters/sharing
    copy.badges = Array.isArray(copy.badges) ? [...copy.badges, ...badges] : [...badges];
    return copy;
  };

  if (Array.isArray(entityOrArray)) return entityOrArray.map(stampOne);
  return stampOne(entityOrArray);
}

/* ──────────────────────────────────────────────────────────────
 * Sabbath Guard
 * ────────────────────────────────────────────────────────────── */

export function isInSabbathWindow(when = Date.now(), cfg) {
  const tip = _tip;
  const s = { ...(cfg || tip.sabbath) };
  if (!s.enabled) return false;

  const d = new Date(when);
  const y = d.getFullYear(), m = d.getMonth(), dayNum = d.getDate();

  const dow = d.getDay(); // 0 Sun .. 6 Sat
  const dateAt = (base, addDays, h, min) => {
    const dd = new Date(base);
    dd.setHours(0, 0, 0, 0);
    dd.setDate(dd.getDate() + addDays);
    dd.setHours(h, min || 0, 0, 0);
    return dd;
  };

  const sunday = new Date(y, m, dayNum - dow);
  const friOffset = ((s.start?.day ?? 5) + 7) % 7;
  const satOffset = ((s.end?.day ?? 6) + 7) % 7;

  const startH = Number(s.start?.hour ?? 18);
  const startM = Number(s.start?.minute ?? 0);
  const endH = Number(s.end?.hour ?? 20);
  const endM = Number(s.end?.minute ?? 0);

  const startTs = dateAt(sunday, friOffset, startH, startM).getTime();
  const endTs   = dateAt(sunday, satOffset, endH, endM).getTime();
  const ts = d.getTime();

  // Exceptions (YYYY-MM-DD)
  const dateIso = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0, 10);
  if (Array.isArray(s.exceptions) && s.exceptions.includes(dateIso)) return false;

  return ts >= startTs && ts <= endTs;
}

/**
 * Guard a user action during Sabbath; emits UI glue when blocked.
 * If allowed (outside guard window), calls onProceed(); if blocked, calls onBlocked().
 * Returns { allowed:boolean, reason?:string }.
 */
export function guardSabbathAction(actionName, { onProceed, onBlocked, allowEssentials = false } = {}) {
  const now = new Date();
  const inSab = isInSabbathWindow(now);

  if (inSab) {
    const canBypass = allowEssentials && _tip?.sabbath?.allowEssentials;
    if (!canBypass) {
      const reason = "Action blocked during Sabbath window.";

      // Replace confirms with: toast + undo + single NBA
      emitEvent(NAMES["ui.toast.shown"], {
        variant: "warning",
        title: "Sabbath Guard",
        message: `${actionName} is paused until Sabbath ends.`,
      });

      emitEvent(NAMES["ui.nba.suggested"], {
        label: "Schedule After Sabbath",
        hint: "Pick a time outside the guard window",
        route: "/calendar",
      });

      emitEvent(NAMES["torah.sabbath.hold.deferred"], {
        original: { name: actionName },
        until: _tip?.sabbath?.nextWindow,
      });

      if (onBlocked) { try { onBlocked({ reason }); } catch { /* noop */ } }
      return { allowed: false, reason };
    }
  }

  try { onProceed && onProceed(); } catch { /* noop */ }
  return { allowed: true };
}

/* ──────────────────────────────────────────────────────────────
 * Minimal cross-domain helpers (used by “touch every domain”)
 * ────────────────────────────────────────────────────────────── */

/** TIP filtering: simple list → list (shellfish + household rules) */
export function guardShellfish(items, tip = _tip) {
  if (!Array.isArray(items) || !items.length) return items || [];
  const before = items.length;
  const visible = filterByTorah(items, { allowShellfishOverride: false, respectWarn: false });

  if (visible.length !== before) {
    emitEvent(NAMES["torah.guard.shellfish.applied"], {
      name: "guardShellfish",
      key: "items",
      before,
      after: visible.length,
    });
  }
  return visible;
}

/** Sabbath-aware wrapper: runs fn() or defers with a single NBA */
export async function sabbathGuard(fn, tip = _tip) {
  if (isInSabbathWindow(Date.now(), tip.sabbath)) {
    emitEvent(NAMES["torah.sabbath.hold.deferred"], { original: { name: "action" }, until: tip?.sabbath?.nextWindow });
    emitEvent(NAMES["ui.nba.suggested"], { label: "Schedule After Sabbath", route: "/calendar" });
    return { deferred: true };
  }
  return Promise.resolve().then(() => fn());
}

/** Artifact badging: mirror badges into `badges` and `torahBadges` */
export function withTorahBadges(artifact, tip = _tip) {
  const stamped = stampTorahBadges(artifact);
  emitEvent(NAMES["torah.badges.attached"], {
    name: "withTorahBadges",
    count: (stamped?.badges || stamped?.torahBadges || []).length,
    artifactType: stamped?.type,
  });
  return stamped;
}

/* ──────────────────────────────────────────────────────────────
 * Opinionated wiring for downstream features
 * (UIs can re-stamp on these to stay consistent)
 * ────────────────────────────────────────────────────────────── */

events.on(NAMES["recipes.consolidated"], () => debounceEmit("ui/rebadge", { scope: "recipes" }, 200));
events.on(NAMES["inventory.updated"],    () => debounceEmit("ui/rebadge", { scope: "inventory" }, 200));
events.on(NAMES["calendar.synced"],      () => debounceEmit("ui/rebadge", { scope: "calendar" }, 200));

/* ──────────────────────────────────────────────────────────────
 * Module bootstrap
 * ────────────────────────────────────────────────────────────── */
try {
  initTIP();
} catch (e) {
  console.error("[TIP] init error:", e);
}

export default {
  initTIP,
  getTIP,
  readTIP,
  subscribeTIP,
  isShellfish,
  isInSabbathWindow,
  evaluateTorahRules,
  filterByTorah,
  stampTorahBadges,
  guardSabbathAction,

  // cross-domain helpers
  guardShellfish,
  withTorahBadges,
  sabbathGuard,
};

/* ──────────────────────────────────────────────────────────────
 * tiny utilities
 * ────────────────────────────────────────────────────────────── */
function debounce(fn, wait = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function debounceEmit(name, payload, wait = 200) {
  const key = `__debounce:${name}`;
  if (!window.___sukaDebounces) window.___sukaDebounces = {};
  clearTimeout(window.___sukaDebounces[key]);
  window.___sukaDebounces[key] = setTimeout(() => {
    // Use raw bus emission for internal UI signals
    try {
      events.emit({ id: String(Date.now()), name, ts: new Date().toISOString(), payload });
    } catch {}
  }, wait);
}
