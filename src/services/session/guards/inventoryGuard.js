/* eslint-disable no-console */
// inventoryGuard.js — ensure items on hand (domain-aware), reserve/consume, suggest subs, queue shortages
// Plays nicely with RelativeScheduler + NBA + Grocery List builder by emitting:
//   - inventory.shortage.detected (domain-aware)
//   - planner.conflict.detected (kind: "inventory")
//   - grocerylist.requested (domain-aware)
//   - nba.suggestion.requested (substitution / plan tweak)

(function () {
  // ------------------------------ Defensive deps ------------------------------
  const isBrowser = typeof window !== "undefined";
  const now = () => Date.now();

  let eventBus = { on(){}, off(){}, emit(){} };
  try {
    const eb = require("@/services/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  // Optional: Inventory store/manager — use anything available; guard remains defensive
  // Expected minimal surface:
  //   inventory.has(sku, qty) -> boolean
  //   inventory.getQty(sku) -> number
  //   inventory.reserve(resId, [{sku, qty}])
  //   inventory.release(resId)
  //   inventory.consume(resId)   // commit usage
  let inventory = null;
  try { inventory = (require("@/stores/inventory") || {}).inventory || null; } catch (_e) {}
  if (!inventory) {
    try { inventory = (require("@/managers/InventoryMonitor") || {}).default || null; } catch (_e) {}
  }

  // Optional: Relative Scheduler (for pausing anchors on hard shortages)
  let relativeScheduler = null;
  try { relativeScheduler = (require("@/services/session/RelativeScheduler") || {}).relativeScheduler || null; } catch (_e) {}

  // Optional: Grocery/supply list builder (domain-aware)
  let listBuilder = null;
  try { listBuilder = require("@/services/listBuilder"); } catch (_e) {}

  // Optional: Estimator (to normalize units / scale quantities)
  let estimateEngine = null;
  try { estimateEngine = require("@/services/estimateEngine"); } catch (_e) {}

  // Optional: Automation runtime (toasts/banners)
  let automation = null;
  try { automation = (require("@/services/automation/runtime") || {}).automation || null; } catch (_e) {}

  // ------------------------------ Persistence ---------------------------------
  const K = {
    PREFS: "suka:inventoryGuard:prefs:v1",
    RESMAP: "suka:inventoryGuard:reservations:v1" // { [anchorId]: { id, at, domain, lines:[{sku,qty}], status:'reserved'|'consumed'|'released' } }
  };
  const safeJSON = {
    parse: (s, f = null) => { try { return JSON.parse(s); } catch { return f; } },
    stringify: (o) => { try { return JSON.stringify(o); } catch { return "{}"; } },
  };
  const load = (key, fallback) => isBrowser ? (safeJSON.parse(localStorage.getItem(key), fallback)) : fallback;
  const save = (key, val) => { if (isBrowser) localStorage.setItem(key, safeJSON.stringify(val)); };

  let reservations = load(K.RESMAP, {});

  // ------------------------------ Preferences / Defaults ----------------------
  const DEFAULTS = {
    enabled: true,

    // Normalize incoming recipe/task lines with these alias → sku maps
    skuAliases: {
      // Meals (explicitly include fresh-ground whole grain flour per your updates)
      "fresh-ground-whole-grain-flour": ["fresh ground whole grain flour", "freshly milled flour", "whole wheat flour (fresh)"],
      "ap-flour": ["all purpose flour", "ap flour"],
      "eggs": ["egg", "eggs"],
      "lamb-breakfast-sausage": ["lamb breakfast sausage"],
      "beef-breakfast-sausage": ["beef breakfast sausage"],
      "lamb-bacon": ["lamb bacon"],
      "beef-bacon": ["beef bacon"],
      "goat": ["goat meat", "chevon"],
      "chicken-stock": ["chicken stock", "broth (chicken)"],
      "yeast": ["active dry yeast", "instant yeast"],
      "salt": ["kosher salt", "sea salt"],
      "oil-olive": ["olive oil"],
      "butter": ["unsalted butter", "butter"],

      // Cleaning
      "detergent-laundry": ["laundry detergent"],
      "white-vinegar": ["vinegar (white)"],
      "baking-soda": ["bicarbonate", "baking soda"],

      // Garden / Animals (examples)
      "seed-starter-mix": ["starter mix", "seedling mix"],
      "feed-sheep": ["sheep feed"],
      "dewormer-caprine": ["goat dewormer"],
    },

    // Substitution graph (ordered fallbacks)
    substitutions: {
      "fresh-ground-whole-grain-flour": ["ap-flour"], // not ideal; warn: texture/flavor varies
      "ap-flour": ["fresh-ground-whole-grain-flour"],
      "lamb-breakfast-sausage": ["beef-breakfast-sausage"],
      "lamb-bacon": ["beef-bacon"],
      "chicken-stock": ["water + butter", "water + oil-olive"],

      // cleaning
      "detergent-laundry": ["baking-soda + white-vinegar"],

      // garden/animals
      "seed-starter-mix": ["compost + perlite (homemade mix)"],
      "feed-sheep": ["hay + mineral mix"],
    },

    // Unit assumptions (if estimateEngine missing)
    defaultUnits: {
      "eggs": "count",
      "fresh-ground-whole-grain-flour": "g",
      "ap-flour": "g",
      "yeast": "g",
      "salt": "g",
      "butter": "g",
      "chicken-stock": "ml",
      "oil-olive": "ml",
      "detergent-laundry": "ml",
      "white-vinegar": "ml",
      "baking-soda": "g",
      "seed-starter-mix": "l",
      "feed-sheep": "kg",
      "dewormer-caprine": "ml",
    },

    // Auto-actions
    autoReserveOn: ["session.started", "relative.schedule.created"], // reserve when session starts or schedule arrives
    autoConsumeOn: ["session.ended"],                                // commit when session ends cleanly
    autoReleaseOn: ["session.canceled", "session.failed"],           // rollback on cancel/fail
    pauseAnchorOnHardShortage: true,

    // When shortage found:
    //   - fire `grocerylist.requested` with missing SKUs
    //   - ask NBA for substitutions
    grocerylistOnShortage: true,
    nbaOnShortage: true,

    // Domain scoping
    domainMap: {
      meals: true,
      cleaning: true,
      garden: true,
      animals: true,
    },
  };

  let prefs = Object.assign({}, DEFAULTS, load(K.PREFS, {}));
  const setPrefs = (patch) => {
    prefs = Object.assign({}, prefs, patch || {});
    save(K.PREFS, prefs);
    eventBus.emit("inventory.guard.prefs.updated", { prefs });
  };

  // ------------------------------ Helpers ------------------------------------
  const uid = (p="inv") => `${p}:${Math.random().toString(36).slice(2)}:${Date.now().toString(36)}`;

  function normalizeSkuName(raw = "") {
    const s = (raw || "").toString().trim().toLowerCase();
    const aliases = prefs.skuAliases || {};
    for (const canonical in aliases) {
      const list = aliases[canonical] || [];
      if (canonical === s) return canonical;
      if (list.some(a => a.toLowerCase() === s)) return canonical;
    }
    return s.replace(/\s+/g, "-"); // fallback kebab
  }

  function normalizeLine(line = {}) {
    // line: { sku|string, qty, unit?, title? }
    if (!line) return null;
    const sku = normalizeSkuName(line.sku || line.title || "");
    const unit = line.unit || prefs.defaultUnits[sku] || "count";
    let qty = Number(line.qty || 0);
    if (estimateEngine && estimateEngine.normalizeQty) {
      try { qty = estimateEngine.normalizeQty({ sku, qty, unit }) || qty; } catch (_e) {}
    }
    return { sku, qty, unit, title: line.title || sku };
  }

  function summarizeShortages(lines = []) {
    // returns { ok:[], missing:[{sku, needed, onHand}], low:[...] }
    const ok = [], missing = [], low = [];
    lines.forEach(l => {
      const onHand = inventory && typeof inventory.getQty === "function" ? (inventory.getQty(l.sku) || 0) : 0;
      if (onHand <= 0 && l.qty > 0) missing.push({ sku: l.sku, needed: l.qty, onHand });
      else if (onHand < l.qty) low.push({ sku: l.sku, needed: l.qty, onHand });
      else ok.push({ sku: l.sku, needed: l.qty, onHand });
    });
    return { ok, missing, low };
  }

  function suggestSubstitutions(shortItems = []) {
    const subs = [];
    shortItems.forEach(it => {
      const candidates = prefs.substitutions[it.sku] || [];
      if (Array.isArray(candidates) && candidates.length) {
        subs.push({ sku: it.sku, suggest: candidates });
      }
    });
    return subs;
  }

  function buildReservation(anchorId, domain, lines = []) {
    const id = `res:${anchorId}`;
    const norm = lines.map(normalizeLine).filter(Boolean).filter(x => (x.qty || 0) > 0);
    return { id, at: now(), domain, lines: norm, status: "reserved" };
  }

  function hasInventoryAPI() {
    return !!(inventory && inventory.reserve && inventory.release && inventory.consume && inventory.getQty);
  }

  function toast(title, message, tags = []) {
    if (!automation?.notify) return;
    try {
      automation.notify({ title, message, scope: "local", severity: "info", ts: now(), tags });
    } catch (_e) {}
  }

  // ------------------------------ Core guard ----------------------------------
  async function guardRequirements(e = {}) {
    // e: { sessionId, anchorId, domain, lines:[{sku,qty,unit?,title?}] }
    if (!prefs.enabled || !prefs.domainMap[(e.domain || "general")]) return { allow: true };

    // normalize incoming list
    const lines = (e.lines || []).map(normalizeLine).filter(Boolean);

    // if nothing specified, nothing to check
    if (!lines.length) return { allow: true };

    // compute shortages
    const { ok, missing, low } = summarizeShortages(lines);

    const shortages = [...missing, ...low];
    if (shortages.length === 0) {
      // reserve immediately if API exists
      if (hasInventoryAPI()) {
        try {
          const res = buildReservation(e.anchorId || uid("anchor"), e.domain, lines);
          inventory.reserve(res.id, res.lines);
          reservations[e.anchorId || res.id] = res;
          save(K.RESMAP, reservations);
        } catch (_e) {}
      }
      return { allow: true, shortages: [] };
    }

    // emit domain-aware shortage + planner conflict (inventory)
    const shortagePayload = {
      domain: e.domain,
      lines: shortages,
      sessionId: e.sessionId || null,
      anchorId: e.anchorId || null,
    };

    eventBus.emit("inventory.shortage.detected", Object.assign({}, shortagePayload, { reason: "not-enough-on-hand" }));
    eventBus.emit("planner.conflict.detected", {
      kind: "inventory",
      domain: e.domain,
      until: null,
      source: "inventoryGuard",
      item: {
        anchorId: e.anchorId || null,
        sessionId: e.sessionId || null,
        title: "Inventory shortage",
        kind: "guard",
        payload: shortagePayload,
      },
    });

    // Ask NBA for suggestions (subs, scale down, swap plan/order)
    if (prefs.nbaOnShortage) {
      const subs = suggestSubstitutions(shortages);
      eventBus.emit("nba.suggestion.requested", {
        context: "inventory",
        reasons: ["shortage"],
        item: { domain: e.domain, shortages, substitutions: subs },
      });
    }

    // Optionally build grocery/supply list entries
    if (prefs.grocerylistOnShortage) {
      const glines = shortages.map(s => ({ sku: s.sku, qty: Math.max(0, s.needed - (s.onHand || 0)) }));
      // Preferred: let your centralized flow create the list (domain-aware)
      eventBus.emit("grocerylist.requested", { domain: e.domain, items: glines, sessionId: e.sessionId || null });
      // If a builder lib exists, seed it defensively
      if (listBuilder && listBuilder.addLines) {
        try { listBuilder.addLines({ domain: e.domain, lines: glines }); } catch (_e) {}
      }
    }

    // Pause anchor if we can't proceed and scheduler is present
    if (prefs.pauseAnchorOnHardShortage && relativeScheduler && e.anchorId) {
      try { relativeScheduler.pauseAnchor(e.anchorId); } catch (_e) {}
    }

    toast("Items missing", "We’re short on some supplies. I added them to your list and suggested substitutions.", ["inventory", e.domain || "general"]);

    return { allow: false, shortages };
  }

  // ------------------------------ Lines inference -----------------------------
  // Extract required lines from commonly seen event payloads if the caller didn’t enumerate them explicitly.
  function inferLinesFromEvent(e = {}) {
    // Try structured payload first
    if (Array.isArray(e.lines) && e.lines.length) return e.lines;

    // Recipes (meals): e.recipe?: { ingredients:[{name, qty, unit}] }
    if (e.domain === "meals" && e.recipe?.ingredients?.length) {
      return e.recipe.ingredients.map(ing => ({ sku: ing.name, qty: ing.qty, unit: ing.unit, title: ing.name }));
    }

    // Cleaning procedures: e.procedure?: { supplies:[{sku|name, qty, unit}] }
    if (e.domain === "cleaning" && e.procedure?.supplies?.length) {
      return e.procedure.supplies.map(s => ({ sku: s.sku || s.name, qty: s.qty, unit: s.unit, title: s.name || s.sku }));
    }

    // Garden: e.plan?: { materials:[{sku, qty, unit}] }
    if (e.domain === "garden" && e.plan?.materials?.length) {
      return e.plan.materials.map(m => ({ sku: m.sku, qty: m.qty, unit: m.unit, title: m.title || m.sku }));
    }

    // Animals: e.protocol?: { inputs:[{sku, qty, unit}] }
    if (e.domain === "animals" && e.protocol?.inputs?.length) {
      return e.protocol.inputs.map(i => ({ sku: i.sku, qty: i.qty, unit: i.unit, title: i.title || i.sku }));
    }

    return [];
  }

  // ------------------------------ Event wiring --------------------------------
  async function onEnsureRequested(e = {}) {
    // e: { sessionId, anchorId, domain, lines? | recipe? | procedure? | plan? | protocol? }
    if (!prefs.enabled) return;
    const domain = e.domain || "general";
    if (!prefs.domainMap[domain]) return;

    const lines = inferLinesFromEvent(e);
    const verdict = await guardRequirements({ sessionId: e.sessionId, anchorId: e.anchorId, domain, lines });
    eventBus.emit("inventory.guard.checked", {
      sessionId: e.sessionId || null, anchorId: e.anchorId || null, domain, verdict,
    });
  }

  // Reserve/consume hooks around session lifecycle
  function onSessionStarted(e = {}) {
    // If a schedule already attached, we’ll wait for `relative.schedule.created` to infer lines; otherwise try direct
    // Helpful when callers emit ensure.items.onhand.requested right after `session.started`
  }

  async function onScheduleCreated(e = {}) {
    // e: { anchorId, sessionId, domain, items:[{id,title,payload?}] }
    if (!prefs.enabled || !e || !prefs.domainMap[(e.domain || "general")]) return;

    // Try to infer lines per item payload (meals often store ingredients on the anchor meta or items payload)
    // We’ll scan for a single “requirements” array or collect per-item if present
    const collected = [];

    // Anchor meta first (if any)
    // NOTE: RelativeScheduler stores aren't accessible here without an API; callers should emit
    //       ensure.items.onhand.requested explicitly with lines for best results.
    // Per-item payload check
    (e.items || []).forEach(it => {
      const req = it?.payload?.requirements || it?.payload?.ingredients || it?.payload?.supplies || [];
      if (Array.isArray(req) && req.length) {
        req.forEach(r => collected.push(r));
      }
    });

    if (collected.length) {
      await onEnsureRequested({ sessionId: e.sessionId, anchorId: e.anchorId, domain: e.domain, lines: collected });
    }
  }

  // Commit/rollback inventory around session end/cancel/fail/pause/resume
  function getResIdForAnchor(anchorId) { return `res:${anchorId}`; }

  function commitReservation(anchorId) {
    const resId = getResIdForAnchor(anchorId);
    const res = reservations[anchorId] || reservations[resId];
    if (!res || res.status !== "reserved") return;
    if (hasInventoryAPI()) {
      try { inventory.consume(res.id); res.status = "consumed"; save(K.RESMAP, reservations); } catch (_e) {}
    } else {
      res.status = "consumed"; save(K.RESMAP, reservations);
    }
  }

  function releaseReservation(anchorId) {
    const resId = getResIdForAnchor(anchorId);
    const res = reservations[anchorId] || reservations[resId];
    if (!res || (res.status !== "reserved" && res.status !== "held")) return;
    if (hasInventoryAPI()) {
      try { inventory.release(res.id); res.status = "released"; save(K.RESMAP, reservations); } catch (_e) {}
    } else {
      res.status = "released"; save(K.RESMAP, reservations);
    }
  }

  // ------------------------------ Public API ----------------------------------
  const inventoryGuard = {
    init(userPrefs = {}) {
      setPrefs(userPrefs);

      // 1) Explicit ensure request (preferred entrypoint)
      // e.g., eventBus.emit("ensure.items.onhand.requested", { domain:"meals", sessionId, anchorId, lines:[...] })
      eventBus.on("ensure.items.onhand.requested", onEnsureRequested);

      // 2) Session/schedule glue
      eventBus.on("session.started", onSessionStarted);
      eventBus.on("relative.schedule.created", onScheduleCreated);

      // 3) Lifecycle commits
      (prefs.autoConsumeOn || []).forEach(ev =>
        eventBus.on(ev, (e = {}) => { if (e.anchorId) commitReservation(e.anchorId); })
      );
      (prefs.autoReleaseOn || []).forEach(ev =>
        eventBus.on(ev, (e = {}) => { if (e.anchorId) releaseReservation(e.anchorId); })
      );

      // 4) Optional: if a blocking modal tries to start an action with shortages, convert to a suggestion path
      eventBus.on("ui.modal.open", async (m = {}) => {
        if (!prefs.enabled) return;
        const domain = m.domain || "general";
        if (!prefs.domainMap[domain]) return;

        // Heuristic: Start/Commit modals often have "requirements" in props
        const req = (m.props && (m.props.requirements || m.props.ingredients || m.props.supplies)) || [];
        if (!Array.isArray(req) || req.length === 0) return;

        const lines = req.map(r => ({ sku: r.sku || r.name, qty: r.qty, unit: r.unit, title: r.title || r.name || r.sku }));
        const verdict = await guardRequirements({
          sessionId: m.sessionId || null,
          anchorId: m.anchorId || null,
          domain,
          lines,
        });

        if (!verdict.allow) {
          eventBus.emit("ui.modal.converted", {
            type: "sheet",
            cancelOriginal: true,
            payload: {
              id: `${m.id || "start"}-converted`,
              title: "Short on supplies",
              subhead: "I’ve added missing items to your list and suggested substitutions.",
              domain,
              readOnly: true,
              component: m.component || null,
              props: Object.assign({}, m.props || {}, { readOnly: true }),
              actions: [
                { id: "ack", label: "OK", kind: "ack" },
                { id: "viewList", label: "Open list", kind: "view", payload: { path: "/tier2/household/meals?tab=lists" } },
              ],
              original: { id: m.id, kind: m.kind, actions: m.actions || [], payload: m.payload || {} },
            },
          });
        }
      });

      // 5) HUD query
      eventBus.on("inventory.guard.status.requested", () => {
        eventBus.emit("inventory.guard.status", {
          enabled: prefs.enabled,
          reservationsCount: Object.keys(reservations).length,
        });
      });
    },

    // Imperative check (for direct callers)
    async check({ sessionId, anchorId, domain, lines }) {
      const verdict = await guardRequirements({ sessionId, anchorId, domain, lines });
      return verdict;
    },

    // Reservation controls (if you want to manage manually)
    reserve(anchorId, domain, lines) {
      if (!hasInventoryAPI()) return null;
      const res = buildReservation(anchorId || uid("anchor"), domain, lines || []);
      try { inventory.reserve(res.id, res.lines); } catch (_e) {}
      reservations[anchorId || res.id] = res; save(K.RESMAP, reservations);
      return res;
    },
    release(anchorId) { releaseReservation(anchorId); },
    consume(anchorId) { commitReservation(anchorId); },

    // Prefs
    getPrefs() { return Object.assign({}, prefs); },
    setPrefs,

    // Debug
    _getReservations() { return safeJSON.parse(safeJSON.stringify(reservations), {}); },
    _reset() { reservations = {}; save(K.RESMAP, reservations); },
  };

  // ------------------------------ Export --------------------------------------
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { inventoryGuard };
  } else {
    // @ts-ignore
    window.inventoryGuard = inventoryGuard;
  }

  // ------------------------------ Autoinit ------------------------------------
  inventoryGuard.init();
})();
