/* eslint-disable no-console */
// pausePolicies.js — canonical pause policies (freeze / continue / safety-only / mute)
// Integrates: RelativeScheduler, sabbath/quiet-hours, weatherGuard, inventoryGuard
// Emits: session.pause.policy.applied, session.pause.policy.evaluated

(function () {
  // ------------------------------ Defensive deps ------------------------------
  const isBrowser = typeof window !== "undefined";
  const now = () => Date.now();

  let eventBus = { on(){}, off(){}, emit(){} };
  try {
    const eb = require("@/services/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  let relativeScheduler = null;
  try { relativeScheduler = (require("@/services/session/RelativeScheduler") || {}).relativeScheduler || null; } catch (_e) {}

  let scheduleHelpers = null; // expected: isSabbath(), inQuietHours(), withholdsForDomain(domain)
  try { scheduleHelpers = require("@/services/scheduleHelpers"); } catch (_e) {}

  let automation = null; // for optional info toasts
  try { automation = (require("@/services/automation/runtime") || {}).automation || null; } catch (_e) {}

  // ------------------------------ Constants -----------------------------------
  const POLICY = Object.freeze({
    FREEZE: "freeze",            // freeze suspendable timers; pause anchor
    CONTINUE: "continue",        // allow to proceed (may mute notifs)
    SAFETY_ONLY: "safety-only",  // block normal ops, allow safety interventions
    MUTE: "mute",                // continue but mute emits (quiet-hours/Sabbath UX)
  });

  const REASON = Object.freeze({
    USER_PAUSE: "user-pause",
    SABBATH: "sabbath",
    QUIET_HOURS: "quiet-hours",
    WEATHER: "weather",
    INVENTORY: "inventory",
    APPLIANCE: "appliance",
    BIOHAZARD: "biohazard",
    SAFETY: "safety",
    NONE: "none",
  });

  // Item “traits” flags the rest of the system can set on schedule items
  // to get smarter decisions without querying engines here.
  // Example item payload: { suspendable:true, hot:true, perishable:true, safetyCritical:false }
  const TRAIT = Object.freeze({
    SUSPENDABLE: "suspendable",
    HOT: "hot",                   // in-oven/on-burner/on-heat
    PERISHABLE: "perishable",     // food at risk if delayed too long
    SAFETY_CRITICAL: "safetyCritical",
  });

  // ------------------------------ Defaults ------------------------------------
  // Domain → default posture during pause-like conditions
  // - meals: freeze suspendable (proof/marinate/rest), continue HOT for safety (don't kill a running bake/sear)
  // - cleaning: safety-only if biohazard; otherwise freeze long runs (e.g., soak) and continue short “ack” steps
  // - garden: freeze (weather may override to safety-only), watering may be withheld by weatherGuard
  // - animals: safety-only for medical/biohazard; otherwise freeze
  const DEFAULT_TABLE = {
    general: {
      default: POLICY.FREEZE,
      sabbath: POLICY.MUTE,
      quiet: POLICY.MUTE,
      withhold: POLICY.FREEZE,
      biohazard: POLICY.SAFETY_ONLY,
    },
    meals: {
      default: POLICY.FREEZE,
      sabbath: POLICY.MUTE,
      quiet: POLICY.MUTE,
      withhold: POLICY.FREEZE,
      biohazard: POLICY.SAFETY_ONLY,
      rules(item){ // HOT always continues (but may mute)
        if (item?.traits?.[TRAIT.HOT]) return POLICY.CONTINUE;
        return null;
      },
    },
    cleaning: {
      default: POLICY.FREEZE,
      sabbath: POLICY.MUTE,
      quiet: POLICY.MUTE,
      withhold: POLICY.FREEZE,
      biohazard: POLICY.SAFETY_ONLY,
    },
    garden: {
      default: POLICY.FREEZE,
      sabbath: POLICY.MUTE,
      quiet: POLICY.MUTE,
      withhold: POLICY.FREEZE,
      biohazard: POLICY.SAFETY_ONLY,
    },
    animals: {
      default: POLICY.FREEZE,
      sabbath: POLICY.MUTE,
      quiet: POLICY.MUTE,
      withhold: POLICY.FREEZE,
      biohazard: POLICY.SAFETY_ONLY,
      rules(item){
        if (item?.traits?.[TRAIT.SAFETY_CRITICAL]) return POLICY.SAFETY_ONLY;
        return null;
      },
    },
  };

  // Registry for custom domain policies (pluggable)
  const policyRegistry = { ...DEFAULT_TABLE };

  // ------------------------------ Helpers -------------------------------------
  function isSabbath(ts = now()) {
    try { return !!(scheduleHelpers?.isSabbath && scheduleHelpers.isSabbath(ts)); } catch { return false; }
  }
  function inQuietHours(ts = now()) {
    try { return !!(scheduleHelpers?.inQuietHours && scheduleHelpers.inQuietHours(ts)); } catch { return false; }
  }
  function activeWithholds(domain) {
    try {
      const ws = scheduleHelpers?.withholdsForDomain ? (scheduleHelpers.withholdsForDomain(domain) || []) : [];
      const ts = now();
      return ws.filter(w => !w.until || w.until > ts);
    } catch { return []; }
  }

  function getDomainPolicy(domain) {
    return policyRegistry[domain || "general"] || policyRegistry.general;
  }

  function isSuspendable(item) {
    return !!(item?.traits?.[TRAIT.SUSPENDABLE]);
  }

  function shouldMute(reason) {
    return reason === REASON.SABBATH || reason === REASON.QUIET_HOURS;
  }

  // ------------------------------ Core evaluation -----------------------------
  /**
   * Evaluate pause policy for a session or specific item.
   * @param {Object} ctx
   *  - domain: "meals"|"cleaning"|"garden"|"animals"|...
   *  - item: optional scheduled item { traits:{}, kind, title, dueAt, ... }
   *  - userPause: boolean
   *  - conflicts: array of { kind: "weather"|"inventory"|"appliance"|"biohazard", until? }
   *  - ts: timestamp
   */
  function evaluate(ctx = {}) {
    const ts = ctx.ts || now();
    const domain = ctx.domain || "general";
    const policy = getDomainPolicy(domain);

    // 1) Safety first (explicit conflicts)
    const conflicts = Array.isArray(ctx.conflicts) ? ctx.conflicts : [];
    const conflictKinds = new Set(conflicts.map(c => (c.kind || "").toLowerCase()));

    if (conflictKinds.has("biohazard")) {
      return verdict(POLICY.SAFETY_ONLY, REASON.BIOHAZARD, "Biohazard conflict");
    }
    if (conflictKinds.has("appliance")) {
      return verdict(POLICY.FREEZE, REASON.APPLIANCE, "Appliance conflict");
    }
    if (conflictKinds.has("weather")) {
      return verdict(POLICY.FREEZE, REASON.WEATHER, "Weather withhold");
    }
    if (conflictKinds.has("inventory")) {
      return verdict(POLICY.FREEZE, REASON.INVENTORY, "Inventory shortage");
    }

    // 2) User-initiated pause always freezes
    if (ctx.userPause) {
      return verdict(POLICY.FREEZE, REASON.USER_PAUSE, "User paused");
    }

    // 3) Global time-based mutes (Sabbath / quiet hours)
    if (isSabbath(ts)) {
      // domain rules may override item with HOT → continue but muted
      const ruleHit = policy.rules?.(ctx.item);
      if (ruleHit === POLICY.CONTINUE) return verdict(POLICY.MUTE, REASON.SABBATH, "Sabbath: continue (hot) but mute");
      return verdict(policy.sabbath || POLICY.MUTE, REASON.SABBATH, "Sabbath");
    }
    if (inQuietHours(ts)) {
      const ruleHit = policy.rules?.(ctx.item);
      if (ruleHit === POLICY.CONTINUE) return verdict(POLICY.MUTE, REASON.QUIET_HOURS, "Quiet hours: continue (hot) but mute");
      return verdict(policy.quiet || POLICY.MUTE, REASON.QUIET_HOURS, "Quiet hours");
    }

    // 4) Domain withholds map (from scheduleHelpers)
    const withholds = activeWithholds(domain);
    if (withholds.length) {
      return verdict(policy.withhold || POLICY.FREEZE, REASON.SAFETY, "Domain withhold active");
    }

    // 5) Domain/item-specific edge rules
    const rule = policy.rules?.(ctx.item);
    if (rule) return verdict(rule, REASON.NONE, "Domain rule");

    // 6) Default
    return verdict(policy.default || POLICY.FREEZE, REASON.NONE, "Default policy");
  }

  function verdict(policy, reason, note) {
    return { policy, reason, mute: shouldMute(reason), note };
  }

  // ------------------------------ Effects -------------------------------------
  /**
   * Apply a policy to an anchor (session).
   * FREEZE → pause anchor (suspend suspendable steps per RelativeScheduler semantics)
   * CONTINUE → no-op
   * SAFETY_ONLY → pause anchor; only allow safety prompts; mute normal reminders
   * MUTE → continue; mute reminders
   */
  function applyToAnchor(anchorId, evaluation) {
    if (!anchorId || !evaluation) return;

    const { policy, reason, note } = evaluation;

    if (policy === POLICY.FREEZE || policy === POLICY.SAFETY_ONLY) {
      try { relativeScheduler?.pauseAnchor && relativeScheduler.pauseAnchor(anchorId); } catch (_e) {}
    }

    // Emit a standardized event so HUD/guards can adapt UI accordingly
    eventBus.emit("session.pause.policy.applied", {
      anchorId,
      policy,
      reason,
      note,
      ts: now(),
    });

    // Optional: minimal UX hint
    if (automation?.notify && policy !== POLICY.CONTINUE) {
      automation.notify({
        title: policy === POLICY.FREEZE ? "Session paused" :
               policy === POLICY.SAFETY_ONLY ? "Safety-only mode" :
               "Muted notifications",
        message: note || "Policy applied.",
        scope: "local",
        severity: "info",
        ts: now(),
        tags: ["pause-policy", reason || "none"],
      });
    }
  }

  // ------------------------------ Event wiring --------------------------------
  function wire() {
    // Let components ask for a decision:
    // eventBus.emit("session.pause.policy.requested", { anchorId, domain, item?, userPause?, conflicts? })
    eventBus.on("session.pause.policy.requested", (e = {}) => {
      const evaln = evaluate({
        domain: e.domain,
        item: e.item,
        userPause: !!e.userPause,
        conflicts: e.conflicts || [],
        ts: e.ts || now(),
      });
      eventBus.emit("session.pause.policy.evaluated", { anchorId: e.anchorId || null, evaluation: evaln });
      if (e.apply && e.anchorId) applyToAnchor(e.anchorId, evaln);
    });

    // Auto-apply on common conflict events (weather/inventory/appliance/biohazard)
    eventBus.on("planner.conflict.detected", (conf = {}) => {
      const domain = conf.domain || "general";
      const anchorId = conf.item?.anchorId || null;
      if (!anchorId) return;

      const evaln = evaluate({
        domain,
        conflicts: [{ kind: (conf.kind || "").toLowerCase(), until: conf.until || null }],
      });
      applyToAnchor(anchorId, evaln);
    });

    // Respect user pause/resume buttons
    eventBus.on("session.paused.requested", (e = {}) => {
      const evaln = evaluate({ domain: e.domain || "general", userPause: true });
      applyToAnchor(e.anchorId, evaln);
    });
    // Note: actual resume is handled by callers; no policy needed to resume
  }

  // ------------------------------ Public API ----------------------------------
  const pausePolicies = {
    POLICY, REASON, TRAIT,
    init() { wire(); },

    // Evaluate without side effects
    evaluate,

    // Convenience for anchors
    applyToAnchor,

    // Registry: add/override a domain table
    registerDomainPolicy(domain, table) {
      if (!domain || typeof table !== "object") return;
      policyRegistry[domain] = Object.assign({}, getDomainPolicy(domain), table);
      eventBus.emit("session.pause.policy.updated", { domain, table: policyRegistry[domain] });
    },

    getDomainPolicy,
    isSuspendable,
    shouldMute,
  };

  // ------------------------------ Export --------------------------------------
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { pausePolicies };
  } else {
    // @ts-ignore
    window.pausePolicies = pausePolicies;
  }

  // ------------------------------ Autoinit ------------------------------------
  pausePolicies.init();

  // ------------------------------ Examples (optional) -------------------------
  // Example: override meals to always continue timers labeled { hot:true }, but mute during quiet hours
  // pausePolicies.registerDomainPolicy("meals", {
  //   rules(item){ if (item?.traits?.hot) return POLICY.CONTINUE; return null; }
  // });
})();
