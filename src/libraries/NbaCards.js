/* eslint-disable no-console */
/**
 * NbaCards.js — Next Best Action cards builder + registry (ES2015-safe)
 *
 * Purpose
 *  • Convert orchestration signals into consistent, actionable NBA cards
 *  • Domains: meals, cleaning, animals (butchery/cold storage), garden
 *  • Inputs: ConflictHeuristics.analyze() → nbaHints, planner/inventory/session events
 *  • Outputs: ranked, deduped cards with wired actions and analytics hooks
 *
 * Events we react to (existing catalog; no new names):
 *  - planner.conflict.detected     (kind: time|appliance|weather|biohazard|withhold, domain)
 *  - prep.tasks.requested          (params.domain)
 *  - mealplan.draft.requested      (params.domain)
 *  - grocerylist.requested         (domain)
 *  - inventory.shortage.detected   (domain-aware shortages)
 *  - session.pause.requested       (reason: withhold|user, until)
 *  - planner.alternate.requested   (appliance/items)
 *  - planner.schedule.safeWindow.requested (itemId)
 *
 * Public API
 *  - registerCard(type, builderFn)
 *  - buildCardsFromConflicts(conflicts, opts)
 *  - buildCardsFromEvents(events, opts)
 *  - mergeAndRank(cards, opts)
 *  - getCatalog()
 *  - telemetry hooks: emit nba.card.shown / nba.card.dismissed / nba.action.invoked
 *
 * Card Shape
 * {
 *   id, key, title, subtitle, body,
 *   priority: "critical"|"high"|"normal"|"low",
 *   score: 0..100,
 *   domain: "meals"|"cleaning"|"animals"|"garden",
 *   tags: ["conflict","withhold","weather",...],
 *   icon: "Timer"|"AlertTriangle"|... (lucide-react icon names used by UI),
 *   tone: "danger"|"warning"|"info"|"success",
 *   sticky: boolean,
 *   expiresAt?: number(ms),
 *   actions: [
 *     { label, variant, emit?:{name,payload}, patch?:fn, href?, intent? }
 *   ]
 * }
 */

(function () {
  /* ----------------------------- Safe Imports ----------------------------- */
  var eventBus = {
    on: function () {},
    off: function () {},
    emit: function () {},
  };
  try {
    var eb = require("@/services/events/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus)) || eventBus;
  } catch (e) {}

  var ConflictHeuristics = null;
  try {
    ConflictHeuristics = require("@/libraries/ConflictHeuristics");
  } catch (e) {}

  var scheduleHelpers = {
    now: function () {
      return Date.now();
    },
  };
  try {
    scheduleHelpers =
      require("@/engines/schedule/scheduleHelpers") || scheduleHelpers;
  } catch (e) {}

  /* ------------------------------- Constants ------------------------------ */
  var DOMAINS = {
    meals: "meals",
    cleaning: "cleaning",
    animals: "animals",
    garden: "garden",
  };
  var PRIOR = { critical: 3, high: 2, normal: 1, low: 0 };
  var DEFAULT_TTL_MS = 45 * 60 * 1000; // 45m
  var MAX_PER_DOMAIN = 6;

  var ICONS = {
    time: "Clock",
    appliance: "WashingMachine",
    resource: "PanelsLeftClose",
    weather: "CloudSunRain",
    biohazard: "Radioactive",
    withhold: "Hourglass",
    shortage: "PackageMinus",
    plan: "Map",
    prep: "ClipboardCheck",
    schedule: "CalendarClock",
    info: "Info",
    success: "CheckCircle2",
    warning: "AlertTriangle",
    danger: "OctagonAlert",
  };

  var TONES = {
    danger: "danger",
    warning: "warning",
    info: "info",
    success: "success",
  };

  /* ------------------------------- Registry -------------------------------- */
  var registry = Object.create(null); // type -> builder(ctx)->Card[]
  var throttleMap = Object.create(null); // key -> lastShownMs (per-session memory)

  function registerCard(type, builder) {
    registry[type] = builder;
  }
  function listTypes() {
    return Object.keys(registry);
  }

  /* ------------------------------- Utilities -------------------------------- */
  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function normalizePriority(p, score) {
    if (p) return p;
    if (score >= 80) return "critical";
    if (score >= 60) return "high";
    if (score >= 35) return "normal";
    return "low";
  }

  function mkKey(parts) {
    return (parts || []).filter(Boolean).join("|").toLowerCase();
  }

  function baseCard(seed) {
    var now = scheduleHelpers.now ? scheduleHelpers.now() : Date.now();
    return Object.assign(
      {
        id: seed.id || "nba:" + Math.random().toString(36).slice(2),
        key:
          seed.key || seed.id || "nba:" + Math.random().toString(36).slice(2),
        title: seed.title || "Next best action",
        subtitle: seed.subtitle || "",
        body: seed.body || "",
        priority: normalizePriority(seed.priority, seed.score || 0),
        score: clamp(seed.score || 0, 0, 100),
        domain: seed.domain || DOMAINS.meals,
        tags: (seed.tags || []).slice(0),
        icon: seed.icon || ICONS.info,
        tone: seed.tone || TONES.info,
        sticky: !!seed.sticky,
        expiresAt: seed.expiresAt || now + DEFAULT_TTL_MS,
        actions: (seed.actions || []).map(function (a) {
          return {
            label: a.label || "Apply",
            variant: a.variant || "primary",
            emit: a.emit || null,
            patch: a.patch || null,
            href: a.href || null,
            intent: a.intent || "cta",
          };
        }),
      },
      seed.extra || {}
    );
  }

  function decayScore(score, createdAtMs) {
    var now = scheduleHelpers.now ? scheduleHelpers.now() : Date.now();
    var age = Math.max(0, now - (createdAtMs || now));
    var hours = age / (60 * 60 * 1000);
    var factor = Math.max(0.65, 1 - hours * 0.07); // lose 7% per hour, floor at 65%
    return clamp(Math.round(score * factor), 0, 100);
  }

  function dedupeByKey(cards) {
    var map = Object.create(null);
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (!c || !c.key) continue;
      if (!map[c.key] || map[c.key].score < c.score) map[c.key] = c; // keep stronger
    }
    var out = [];
    for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) out.push(map[k]);
    return out;
  }

  function filterExpired(cards) {
    var now = scheduleHelpers.now ? scheduleHelpers.now() : Date.now();
    return cards.filter(function (c) {
      return !c.expiresAt || c.expiresAt > now;
    });
  }

  function applyDomainCaps(cards) {
    var byD = { meals: [], cleaning: [], animals: [], garden: [] };
    for (var i = 0; i < cards.length; i++) {
      var d = byD[cards[i].domain] || (byD[cards[i].domain] = []);
      d.push(cards[i]);
    }
    var out = [];
    Object.keys(byD).forEach(function (d) {
      var arr = byD[d];
      arr.sort(function (a, b) {
        if (PRIOR[b.priority] !== PRIOR[a.priority])
          return PRIOR[b.priority] - PRIOR[a.priority];
        if (b.score !== a.score) return b.score - a.score;
        return (a.title || "").localeCompare(b.title || "");
      });
      out = out.concat(arr.slice(0, MAX_PER_DOMAIN));
    });
    return out;
  }

  function rank(cards) {
    cards.forEach(function (c) {
      // Apply time decay if card carries createdAt
      if (c.createdAt) c.score = decayScore(c.score, c.createdAt);
      // Boost sticky and danger tones a bit
      if (c.sticky) c.score = clamp(c.score + 5, 0, 100);
      if (c.tone === TONES.danger) c.score = clamp(c.score + 3, 0, 100);
      c.priority = normalizePriority(c.priority, c.score);
    });
    cards.sort(function (a, b) {
      if (PRIOR[b.priority] !== PRIOR[a.priority])
        return PRIOR[b.priority] - PRIOR[a.priority];
      if (b.score !== a.score) return b.score - a.score;
      return (a.title || "").localeCompare(b.title || "");
    });
    return cards;
  }

  function throttle(cards, ttlMs) {
    var now = Date.now();
    var out = [];
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var last = throttleMap[c.key];
      if (!last || now - last > (ttlMs || 60 * 1000)) {
        // 60s min re-show window
        throttleMap[c.key] = now;
        out.push(c);
      }
    }
    return out;
  }

  function emitShown(cards) {
    for (var i = 0; i < cards.length; i++) {
      try {
        eventBus.emit("nba.card.shown", {
          key: cards[i].key,
          domain: cards[i].domain,
          tags: cards[i].tags,
          priority: cards[i].priority,
        });
      } catch (e) {}
    }
  }

  function emitDismiss(card, reason) {
    try {
      eventBus.emit("nba.card.dismissed", {
        key: card.key,
        reason: reason || "user",
      });
    } catch (e) {}
  }

  function wireActionInvocation(action) {
    if (!action) return function () {};
    return function () {
      try {
        eventBus.emit("nba.action.invoked", {
          label: action.label,
          intent: action.intent || "cta",
        });
        if (action.emit && action.emit.name) {
          eventBus.emit(action.emit.name, action.emit.payload || {});
        }
      } catch (e) {}
      // patch is applied by the caller (planner/session layer) to keep this library UI-agnostic.
    };
  }

  /* ------------------------- Built-in Card Builders ------------------------ */

  // A) Conflicts → cards (from ConflictHeuristics.analyze().nbaHints or conflicts[])
  registerCard("conflict", function (ctx) {
    var cards = [];
    var conflicts = ctx.conflicts || [];
    for (var i = 0; i < conflicts.length; i++) {
      var c = conflicts[i];
      var tone =
        c.kind === "biohazard"
          ? TONES.danger
          : c.kind === "weather" || c.kind === "withhold"
          ? TONES.warning
          : TONES.info;

      var icon = ICONS[c.kind] || ICONS.info;
      var key = mkKey([
        "conflict",
        c.kind,
        c.domain,
        (c.affected || []).join(","),
      ]);

      var built = baseCard({
        id: "card:" + key,
        key: key,
        title: c.title || "Resolve " + c.kind + " conflict",
        subtitle:
          (c.domain || "plan").toUpperCase() + " • " + (c.kind || "conflict"),
        body: c.rationale || "",
        priority: c.priority || null,
        score: typeof c.score === "number" ? c.score : 50,
        domain: c.domain || DOMAINS.meals,
        tags: ["conflict", c.kind],
        icon: icon,
        tone: tone,
        sticky: c.kind === "biohazard" || c.score >= 80,
        extra: { createdAt: Date.now(), conflictId: c.id },
      });

      // map suggestions -> actions
      var acts = [];
      var sugs = c.suggestions || [];
      for (var j = 0; j < sugs.length; j++) {
        var s = sugs[j];
        acts.push({
          label: s.title || "Apply",
          variant: s.autoApply ? "primary" : "secondary",
          emit: s.emit || null,
          patch: s.patch || null,
          intent: s.intent || (s.autoApply ? "patch" : "option"),
        });
      }
      built.actions = acts;
      cards.push(built);
    }
    return cards;
  });

  // B) Inventory shortages → “Fix before session”
  registerCard("shortage", function (ctx) {
    var events = ctx.events || [];
    var cards = [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.name !== "inventory.shortage.detected") continue;

      var domain =
        (ev.payload && ev.payload.domain) || ctx.domain || DOMAINS.meals;
      var items = (ev.payload && ev.payload.items) || [];
      if (!items.length) continue;

      var list = items
        .slice(0, 5)
        .map(function (it) {
          return (
            (it.qtyNeeded ? it.qtyNeeded + "× " : "") +
            (it.name || it.sku || "Item")
          );
        })
        .join(", ");

      var key = mkKey([
        "shortage",
        domain,
        items
          .map(function (x) {
            return x.name || x.sku;
          })
          .join(","),
      ]);

      cards.push(
        baseCard({
          key: key,
          title: "Supplies missing for your plan",
          subtitle: domain.toUpperCase() + " • Shortages",
          body: list + (items.length > 5 ? " …" : ""),
          priority: "high",
          score: 72,
          domain: domain,
          tags: ["shortage", "inventory"],
          icon: ICONS.shortage,
          tone: TONES.warning,
          actions: [
            {
              label: "Generate grocery/supply list",
              variant: "primary",
              emit: {
                name: "grocerylist.requested",
                payload: { domain: domain },
              },
              intent: "cta",
            },
            {
              label: "Swap items",
              variant: "secondary",
              emit: {
                name: "planner.alternate.requested",
                payload: {
                  items: items.map(function (x) {
                    return x.id;
                  }),
                },
              },
              intent: "option",
            },
          ],
        })
      );
    }
    return cards;
  });

  // C) Session paused due to withhold → reminder/auto-resume
  registerCard("withholdResume", function (ctx) {
    var events = ctx.events || [];
    var out = [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.name !== "session.pause.requested") continue;
      if (!ev.payload || ev.payload.reason !== "withhold") continue;

      var until = ev.payload.until;
      var domain = ev.payload.domain || DOMAINS.meals;
      var key = mkKey(["withhold", "resume", domain, until]);

      out.push(
        baseCard({
          key: key,
          title: "Withhold in progress",
          subtitle: domain.toUpperCase() + " • Resume when timer ends",
          body: "Session will resume after the withhold period ends.",
          priority: "high",
          score: 68,
          domain: domain,
          tags: ["withhold", "timer"],
          icon: ICONS.withhold,
          tone: TONES.info,
          expiresAt: until ? until + 10 * 60 * 1000 : undefined, // 10 min grace
          actions: [
            {
              label: "Resume now",
              variant: "primary",
              emit: {
                name: "session.resume.requested",
                payload: { domain: domain },
              },
              intent: "cta",
            },
            {
              label: "Adjust reminder",
              variant: "secondary",
              emit: {
                name: "reminder.adjust.requested",
                payload: { until: until },
              },
              intent: "option",
            },
          ],
        })
      );
    }
    return out;
  });

  // D) Fresh “Plan it for me” nudges (empty state / dashboard)
  registerCard("planDraft", function (ctx) {
    if (!ctx.plan || (ctx.plan.items && ctx.plan.items.length)) return [];
    var domain = ctx.domain || DOMAINS.meals;
    var key = mkKey(["plantdraft", domain]);

    return [
      baseCard({
        key: key,
        title: "Start a new plan",
        subtitle: domain.toUpperCase() + " • Empty state",
        body: "Kick off a draft and I’ll help you fill in the details.",
        priority: "normal",
        score: 40,
        domain: domain,
        tags: ["plan", "empty"],
        icon: ICONS.plan,
        tone: TONES.info,
        actions: [
          {
            label: "Draft it for me",
            variant: "primary",
            emit: {
              name: "mealplan.draft.requested",
              payload: { domain: domain },
            },
            intent: "cta",
          },
          {
            label: "Collect tasks first",
            variant: "secondary",
            emit: { name: "prep.tasks.requested", payload: { domain: domain } },
            intent: "option",
          },
        ],
      }),
    ];
  });

  // E) Weather risk (pass-through if not covered by Conflict cards)
  registerCard("weather", function (ctx) {
    var events = ctx.events || [];
    var out = [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.name !== "planner.conflict.detected") continue;
      var conf = ev.payload && ev.payload.conflict;
      if (!conf || conf.kind !== "weather") continue;
      var key = mkKey(["weather", conf.domain, conf.id]);

      out.push(
        baseCard({
          key: key,
          title: conf.title || "Weather risk",
          subtitle: (conf.domain || "").toUpperCase() + " • Weather",
          body:
            conf.rationale ||
            "Outdoor conditions may reduce success or safety.",
          priority: normalizePriority(null, conf.score || 60),
          score: conf.score || 60,
          domain: conf.domain || DOMAINS.garden,
          tags: ["weather", "conflict"],
          icon: ICONS.weather,
          tone: TONES.warning,
          actions: [
            {
              label: "Find safe window",
              variant: "primary",
              emit: {
                name: "planner.schedule.safeWindow.requested",
                payload: { itemId: (conf.affected || [])[0] },
              },
              intent: "cta",
            },
            {
              label: "Add PPE note",
              variant: "secondary",
              emit: {
                name: "prep.tasks.requested",
                payload: {
                  domain: conf.domain,
                  tasks: ["PPE: weather protection"],
                },
              },
              intent: "option",
            },
          ],
        })
      );
    }
    return out;
  });

  /* ------------------------- Builders: Conflicts & Events ------------------ */

  function buildCardsFromConflicts(conflictsOrHints, opts) {
    opts = opts || {};
    var ctx = {
      conflicts: normalizeConflicts(conflictsOrHints),
      domain: opts.domain,
      plan: opts.plan,
    };
    var cards = [];
    // Route through a single builder; conflict builder covers all kinds
    var cfb = registry["conflict"];
    if (cfb) cards = cards.concat(cfb(ctx) || []);
    return cards;
  }

  function buildCardsFromEvents(events, opts) {
    opts = opts || {};
    var cards = [];
    var types = ["shortage", "withholdResume", "weather"];
    for (var i = 0; i < types.length; i++) {
      var b = registry[types[i]];
      if (!b) continue;
      var ctx = { events: events || [], domain: opts.domain, plan: opts.plan };
      try {
        cards = cards.concat(b(ctx) || []);
      } catch (e) {
        console.warn("[NbaCards] builder failed:", types[i], e && e.message);
      }
    }
    // Optional “empty state” planDraft
    var planDraftB = registry["planDraft"];
    if (planDraftB) {
      try {
        cards = cards.concat(
          planDraftB({ domain: opts.domain, plan: opts.plan }) || []
        );
      } catch (e) {}
    }
    return cards;
  }

  function normalizeConflicts(arr) {
    if (!arr || !arr.length) return [];
    // We accept either raw conflicts or nbaHints format; prefer raw conflicts when present
    if (arr[0] && arr[0].kind) return arr;
    // nbaHints → no conflict object; ignore (ConflictHeuristics.analyze returns both—pass raw conflicts to us)
    return [];
  }

  /* ------------------------------- Merge/Rank ------------------------------ */

  function mergeAndRank(cards, opts) {
    opts = opts || {};
    var all = cards.filter(Boolean);

    // Dedupe by .key while keeping the strongest card per key
    all = dedupeByKey(all);

    // Remove expired
    all = filterExpired(all);

    // Apply throttling (prevents card flicker when events fire repeatedly)
    all = throttle(all, opts.minRepeatMs || 30 * 1000);

    // Apply domain caps & rank
    all = applyDomainCaps(all);
    return rank(all);
  }

  /* ------------------------------- Catalog --------------------------------- */

  function getCatalog() {
    return {
      types: listTypes(),
      icons: ICONS,
      tones: TONES,
      defaultTtlMs: DEFAULT_TTL_MS,
    };
  }

  /* ----------------------------- Convenience ------------------------------- */

  function wireActionsForUI(card) {
    // Returns a shallow copy with .actions[i].invoke() bound to emit analytics + event
    var out = Object.assign({}, card, { actions: [] });
    for (var i = 0; i < card.actions.length; i++) {
      var a = card.actions[i];
      var invoke = wireActionInvocation(a);
      out.actions.push(Object.assign({}, a, { invoke: invoke }));
    }
    return out;
  }

  function onCardDismiss(card, reason) {
    emitDismiss(card, reason || "user");
  }

  /* --------------------------------- API ----------------------------------- */
  var api = {
    registerCard: registerCard,
    buildCardsFromConflicts: buildCardsFromConflicts,
    buildCardsFromEvents: buildCardsFromEvents,
    mergeAndRank: mergeAndRank,
    wireActionsForUI: wireActionsForUI,
    onCardDismiss: onCardDismiss,
    getCatalog: getCatalog,
  };

  /* ----------------------------- Default Exports ---------------------------- */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else if (typeof define === "function" && define.amd) {
    // eslint-disable-next-line no-undef
    define(function () {
      return api;
    });
  } else {
    // eslint-disable-next-line no-undef
    this.NbaCards = api;
  }
}).call(
  typeof global !== "undefined"
    ? global
    : typeof window !== "undefined"
    ? window
    : this
);
