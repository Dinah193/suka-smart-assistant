// C:\Users\larho\suka-smart-assistant\src\pages\cooking\cooking.worker.js
// -----------------------------------------------------------------------------
// SSA Cooking Worker (ESM)
// -----------------------------------------------------------------------------
// WHAT THIS DOES
// - Offloads parsing / normalization for cooking UI so main thread stays smooth.
// - Emits SSA-shaped events { type, ts, source, data } via the shared eventBus
//   when available (falls back to postMessage to the main thread).
// - Can optionally export synthesized prep intelligence to the Hub if the
//   feature flag familyFundMode=true and connectors are reachable.
//
// HOW IT FITS THE PIPELINE
// imports → intelligence → automation → (optional) hub export
// - imports: raw recipe sources / ingredient text arrive here
// - intelligence: we normalize ingredients, infer units/methods/equipment
// - automation: emits `prep.synthesized` so runtime can suggest sessions/timers
// - hub export: best-effort via HubPacketFormatter + FamilyFundConnector
//
// IMPORTANT
// - Designed to run even if event bus / hub / flags fail to import.
// - All messages to and from this worker are JSON-serializable.
// - Every response includes an envelope { ok, type, ts, source, data, error? }.
//
// -----------------------------------------------------------------------------

// Attempt to import shared services (optional & defensive).
// NOTE: worker file location: src/pages/cooking/cooking.worker.js
//       eventBus path:      src/services/events/eventBus.js
//       config bridge:      src/config/index.js
//       hub connectors:     src/connectors/*
// All imports are optional; failures are silently ignored.
let eventBus = null;
let featureFlags = {};
let HubPacketFormatter = null;
let FamilyFundConnector = null;

(async () => {
  try {
    const mod = await import("../../services/events/eventBus.js");
    eventBus = mod?.eventBus || mod?.default || null;
  } catch {} // optional

  try {
    const cfg = await import("../../config/index.js");
    // featureFlags is a light, serializable set for fast checks
    featureFlags = cfg?.featureFlags || cfg?.default?.featureFlags || {};
  } catch {} // optional

  try {
    HubPacketFormatter = await import("../../connectors/HubPacketFormatter.js");
  } catch {} // optional
  try {
    FamilyFundConnector = await import("../../connectors/FamilyFundConnector.js");
  } catch {} // optional
})();

// -----------------------------------------------------------------------------
// small utilities
// -----------------------------------------------------------------------------
const SOURCE = "cooking.worker";
const nowIso = () => new Date().toISOString();

function envelope(type, data = {}) {
  return { type, ts: nowIso(), source: SOURCE, data };
}

// Safe event emission: prefer shared bus, else postMessage back to UI.
function emit(evt) {
  try {
    if (eventBus?.emit) {
      eventBus.emit(evt);
      return;
    }
  } catch {}
  // fall back to client to let main thread rebroadcast
  try {
    // Use distinct channel so UI can differentiate
    self.postMessage({ ok: true, __forward__: true, ...evt });
  } catch {}
}

// Optional hub export (best-effort & silent on failure)
async function exportToHubIfEnabled(evt) {
  try {
    const ff = featureFlags || {};
    const familyFund = !!ff.familyFundMode;
    if (!familyFund) return;

    const formatter = HubPacketFormatter?.default || HubPacketFormatter;
    const connector =
      FamilyFundConnector?.default ||
      FamilyFundConnector?.FamilyFundConnector ||
      FamilyFundConnector;

    if (!formatter?.formatForHub || !connector?.sendToHub) return;

    const res = formatter.formatForHub(evt);
    if (res?.ok && res.packet) {
      await connector.sendToHub(res.packet);
    }
  } catch {
    // swallow – hub is optional
  }
}

// -----------------------------------------------------------------------------
// domain helpers (single-use, kept here for locality & perf)
// -----------------------------------------------------------------------------
const UNIT_ALIASES = {
  tsp: ["tsp", "teaspoon", "teaspoons"],
  tbsp: ["tbsp", "tablespoon", "tablespoons"],
  cup: ["c", "cup", "cups"],
  ml: ["ml", "milliliter", "milliliters"],
  l: ["l", "liter", "liters"],
  g: ["g", "gram", "grams"],
  kg: ["kg", "kilogram", "kilograms"],
  oz: ["oz", "ounce", "ounces"],
  lb: ["lb", "lbs", "pound", "pounds"],
  pinch: ["pinch", "pinches"],
};

function canonicalUnit(token) {
  if (!token || typeof token !== "string") return null;
  const lc = token.trim().toLowerCase();
  for (const [canon, list] of Object.entries(UNIT_ALIASES)) {
    if (list.includes(lc)) return canon;
  }
  return null;
}

function parseQuantityToken(token) {
  if (!token) return null;
  const t = token.replace(/\u00BD/g, "1/2").replace(/\u00BC/g, "1/4").trim();
  // handle simple fractions like 1/2, 3/4, 1-1/2
  const dashSplit = t.split("-"); // 1-1/2
  if (dashSplit.length === 2 && /^\d+$/.test(dashSplit[0]) && /^\d+\/\d+$/.test(dashSplit[1])) {
    const whole = Number(dashSplit[0]);
    const [n, d] = dashSplit[1].split("/").map(Number);
    if (d) return whole + n / d;
  }
  if (/^\d+\/\d+$/.test(t)) {
    const [n, d] = t.split("/").map(Number);
    if (d) return n / d;
  }
  const num = Number(t);
  return Number.isFinite(num) ? num : null;
}

function tokenize(line) {
  return String(line || "")
    .replace(/[(),]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function inferIngredient(line) {
  const tokens = tokenize(line);
  if (!tokens.length) return null;

  // try first two tokens for qty + unit
  let qty = null;
  let unit = null;
  let nameStart = 0;

  qty = parseQuantityToken(tokens[0]);
  if (qty !== null) {
    // check next token for unit
    const u = canonicalUnit(tokens[1]);
    if (u) {
      unit = u;
      nameStart = 2;
    } else {
      nameStart = 1;
    }
  } else {
    const uFirst = canonicalUnit(tokens[0]);
    if (uFirst) {
      unit = uFirst;
      nameStart = 1;
    }
  }

  const name = tokens.slice(nameStart).join(" ").trim();
  return {
    raw: line,
    qty: qty ?? 1,
    unit: unit ?? null,
    name,
  };
}

function synthesizePrep(recipe) {
  // Derive simple prep intelligence: counts, timers placeholder, equipment hints
  const steps = Array.isArray(recipe?.steps) ? recipe.steps : [];
  const ingredients = Array.isArray(recipe?.ingredients) ? recipe.ingredients : [];

  const equipment = [];
  for (const s of steps) {
    const ls = String(s || "").toLowerCase();
    if (ls.includes("oven")) equipment.push("oven");
    if (ls.includes("skillet")) equipment.push("skillet");
    if (ls.includes("sheet pan")) equipment.push("sheet pan");
    if (ls.includes("instant pot")) equipment.push("pressure cooker");
  }

  // very light timers: detect "bake X minutes" or "simmer X minutes"
  const timers = [];
  const minuteRegex = /(?:bake|roast|simmer|boil|rest|rise)\s+(\d{1,3})\s+min/i;
  steps.forEach((s, idx) => {
    const m = String(s).match(minuteRegex);
    if (m) {
      timers.push({ label: `step ${idx + 1}`, minutes: Number(m[1]) });
    }
  });

  return {
    ingredientsCount: ingredients.length,
    stepsCount: steps.length,
    equipment: Array.from(new Set(equipment)),
    timers,
  };
}

// -----------------------------------------------------------------------------
// command handlers
// -----------------------------------------------------------------------------
const handlers = {
  ping() {
    const evt = envelope("worker.pong", { ok: true });
    emit(evt);
    return { ok: true, ...evt };
  },

  parseIngredients({ lines }) {
    const list = Array.isArray(lines) ? lines : String(lines || "").split(/\n+/);
    const parsed = list.map(inferIngredient).filter(Boolean);
    const evt = envelope("cooking.ingredients.parsed", { parsed, count: parsed.length });
    emit(evt);
    return { ok: true, ...evt };
  },

  normalizeRecipe({ title, ingredients, steps }) {
    const normalized = {
      title: String(title || "").trim(),
      ingredients: (Array.isArray(ingredients) ? ingredients : String(ingredients || "").split(/\n+/))
        .map(inferIngredient)
        .filter(Boolean),
      steps: Array.isArray(steps) ? steps : String(steps || "").split(/\n+/).filter(Boolean),
    };

    // derive prep intel
    const prep = synthesizePrep(normalized);

    const evt = envelope("prep.synthesized", { recipe: normalized, prep });
    emit(evt);
    // hub export (best-effort)
    exportToHubIfEnabled(evt).catch(() => {});
    return { ok: true, ...evt };
  },

  // Coarse unit converter for UI helpers
  convertUnits({ qty, from, to }) {
    const table = {
      // weight
      g: { g: 1, kg: 1 / 1000, oz: 1 / 28.3495, lb: 1 / 453.592 },
      kg: { g: 1000, kg: 1, oz: 35.274, lb: 2.20462 },
      oz: { g: 28.3495, kg: 0.0283495, oz: 1, lb: 1 / 16 },
      lb: { g: 453.592, kg: 0.453592, oz: 16, lb: 1 },
      // volume (rough, water-equivalent)
      ml: { ml: 1, l: 1 / 1000, cup: 1 / 236.588, tbsp: 1 / 14.7868, tsp: 1 / 4.92892 },
      l: { ml: 1000, l: 1, cup: 4.22675, tbsp: 67.628, tsp: 202.884 },
      cup: { ml: 236.588, l: 0.236588, cup: 1, tbsp: 16, tsp: 48 },
      tbsp: { ml: 14.7868, l: 0.0147868, cup: 1 / 16, tbsp: 1, tsp: 3 },
      tsp: { ml: 4.92892, l: 0.00492892, cup: 1 / 48, tbsp: 1 / 3, tsp: 1 },
    };

    const f = canonicalUnit(String(from || ""));
    const t = canonicalUnit(String(to || ""));
    const q = Number(qty);
    if (!Number.isFinite(q) || !f || !t || !table[f]?.[t]) {
      const evt = envelope("validation.failed", {
        scope: "cooking.convertUnits",
        reason: "invalid-args",
        detail: { qty, from, to },
      });
      emit(evt);
      return { ok: false, ...evt };
    }
    const value = q * table[f][t];
    const evt = envelope("cooking.units.converted", { qty: q, from: f, to: t, value });
    emit(evt);
    return { ok: true, ...evt };
  },
};

// -----------------------------------------------------------------------------
// worker router
// -----------------------------------------------------------------------------
self.onmessage = async (e) => {
  const msg = e?.data || {};
  const cmd = msg?.cmd;
  const payload = msg?.payload ?? {};

  const base = { type: "worker.ack", ts: nowIso(), source: SOURCE, data: { cmd } };

  if (!cmd || typeof handlers[cmd] !== "function") {
    const evt = envelope("validation.failed", {
      scope: "cooking.worker",
      reason: "unknown-cmd",
      cmd,
    });
    emit(evt);
    try { self.postMessage({ ok: false, ...evt }); } catch {}
    return;
  }

  try {
    const res = await handlers[cmd](payload);
    // Always respond to requester
    try { self.postMessage(res || { ok: true, ...base }); } catch {}
  } catch (err) {
    const evt = envelope("worker.error", {
      cmd,
      message: String(err?.message || err),
    });
    emit(evt);
    try { self.postMessage({ ok: false, ...evt }); } catch {}
  }
};

// Eager pong so callers can detect readiness quickly
try {
  const evt = envelope("worker.ready", { version: "1.0.0" });
  emit(evt);
  self.postMessage({ ok: true, ...evt });
} catch {}
