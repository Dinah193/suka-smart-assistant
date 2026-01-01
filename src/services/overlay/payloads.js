// src/services/overlay/payloads.js
// Single source of truth for building overlay payloads used by SSA (draft & play views).
//
// How this fits the pipeline:
// imports → intelligence → automation → (optional) hub export
// • This module does NOT mutate household data. It formats view payloads for overlays/TV.
// • It emits SSA-standard telemetry via eventBus for observability.
//
// Design goals:
// • Stable envelope: { type, ts, source, data } with ISO ts
// • Mode-aware: "draft" vs "play" (active session)
// • Streamer Safe: strip private/pantry fields before sending to overlays
// • Bounded: limit size, truncate big arrays, include checksum/etag for caching
// • Forward-thinking: domain-agnostic (cooking, cleaning, garden, animal, preservation), extension points
//
// Usage:
//   const payload = buildOverlayPayload("play", { roomId, session, ui, nutrition, stream });
//   overlayTransport.send(JSON.stringify(payload));
//
// Notes:
// • If you later add a Hub feature that archives overlay snapshots, call exportToHubIfEnabled() here.
//   For now we do NOT export overlay payloads because they are a presentation layer artifact.

let eventBus = {
  emit: (...a) => console.debug("[overlay:payloads:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch { /* optional */ }

// Feature flags and defaults (safe if missing)
let featureFlags = {
  streamerSafeDefault: true,         // default to true unless caller overrides
  overlayMaxBytes: 80 * 1024,        // ~80KB cap for payload
};
try {
  const f = require("@/config/featureFlags.json");
  featureFlags.streamerSafeDefault = f?.overlay?.streamerSafeDefault ?? featureFlags.streamerSafeDefault;
  featureFlags.overlayMaxBytes = f?.overlay?.maxBytes ?? featureFlags.overlayMaxBytes;
} catch { /* optional */ }

// Optional Hub export (currently not used; kept for future archival use)
let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  HubPacketFormatter = require("@/integrations/HubPacketFormatter");
  FamilyFundConnector = require("@/integrations/FamilyFundConnector");
} catch { /* optional */ }

const SRC = "services.overlay.payloads";
const STREAM_CHANNEL = "sv-cooking-stream"; // keep consistent with your cooking overlay

/* --------------------------------- Public --------------------------------- */

/**
 * Build a normalized overlay payload.
 *
 * Overloads supported:
 *   buildOverlayPayload("draft" | "play", opts)
 *   buildOverlayPayload(sourceObject, { mode: "draft" | "play", ... })
 *
 * @param {string|object} arg1 - mode or a source object
 * @param {object} [opts] - options when arg1 is mode or extra options when arg1 is source
 *   opts.mode                : "draft" | "play" (required if arg1 is a source object)
 *   opts.roomId              : string
 *   opts.session             : { id, type, title, step, steps[], plan, timers[], deadlineTs, ... }
 *   opts.ui                  : { theme, density, showTimers, showNutrition, ... }
 *   opts.nutrition           : lightweight nutrition snapshot to render (per serving or total)
 *   opts.stream              : { channel, seq, cursor }
 *   opts.streamerSafe        : boolean (defaults from featureFlags)
 *   opts.maxBytes            : number (payload size cap; default from featureFlags)
 *   opts.allowKeys           : string[] (explicit allow-list of top-level data keys)
 *   opts.extra               : any additional domain-specific fields
 *
 * @returns {object} envelope { type, ts, source, data }
 */
function buildOverlayPayload(arg1, opts = {}) {
  const { mode, normalizedOpts } = coerceModeAndOpts(arg1, opts);
  assertMode(mode);

  // Derive base model
  const base = normalizeInputs(normalizedOpts);

  // Compute derived view bits
  const derived = deriveViewFields(base);

  // Compose data section
  const data = {
    version: "1.2.0",                 // bump if contract changes
    mode,                             // "draft" | "play"
    roomId: base.roomId || null,
    stream: {
      channel: base.stream?.channel || STREAM_CHANNEL,
      seq: base.stream?.seq ?? null,
      cursor: base.stream?.cursor ?? null,
    },
    session: shapeSessionForOverlay(base.session, mode),
    ui: shapeUi(base.ui),
    nutrition: shapeNutrition(base.nutrition, base.ui),
    derived,
    extra: base.extra || null,        // forward-compatible domain extras
  };

  // Apply streamer-safe redaction
  const safe = (normalizedOpts.streamerSafe ?? featureFlags.streamerSafeDefault)
    ? redactStreamerUnsafe(data)
    : data;

  // Enforce allow-list if provided (top-level keys only)
  const allowed = Array.isArray(normalizedOpts.allowKeys) && normalizedOpts.allowKeys.length
    ? pickKeys(safe, normalizedOpts.allowKeys)
    : safe;

  // Enforce size bounds and include checksum/etag for cacheability
  const maxBytes = Number.isFinite(normalizedOpts.maxBytes) ? normalizedOpts.maxBytes : featureFlags.overlayMaxBytes;
  const bounded = boundPayload(allowed, maxBytes);

  const envelope = {
    type: "overlay.payload",
    ts: nowIso(),
    source: SRC,
    data: bounded,
  };

  emit("overlay.payload.built", {
    mode,
    roomId: base.roomId || null,
    bytes: bounded.__meta?.bytes,
    truncated: bounded.__meta?.truncated || false,
    streamerSafe: !!(normalizedOpts.streamerSafe ?? featureFlags.streamerSafeDefault),
  });

  // NOTE: Not exporting to Hub; overlay payload is presentation-only.
  // If you later decide to archive, uncomment below & add a feature flag gate.
  // exportToHubIfEnabled({ kind: "overlay.snapshot", envelope });

  return envelope;
}

/* ------------------------------ Derivations ------------------------------ */

function deriveViewFields(base) {
  const s = base.session || {};
  const steps = Array.isArray(s.steps) ? s.steps : [];
  const activeIndex = clampIndex(steps.findIndex(x => x?.id === s.step?.id), steps.length);
  const nextStep = steps[activeIndex + 1] || null;

  // Timers: prefer explicit timers; otherwise infer from step estimates
  const timers = Array.isArray(s.timers) && s.timers.length
    ? normalizeTimers(s.timers)
    : inferTimersFromStep(s.step);

  // ETA: use provided eta if present, else derive from timers
  const eta = s.eta || estimateEta(timers);

  return {
    activeIndex,
    nextStep: nextStep ? minimalStep(nextStep) : null,
    timers,
    eta,
    hasNutrition: !!base.nutrition,
    warnings: collectWarnings(base),
  };
}

/* ------------------------------ Shape helpers ---------------------------- */

function shapeSessionForOverlay(session, mode) {
  const s = session || {};
  const base = {
    id: s.id || null,
    type: s.type || null,                 // cooking|cleaning|garden|animal|preservation
    title: s.title || null,
    status: coerceStatus(s.status, mode), // idle|planned|started|paused|completed|canceled|failed
    deadlineTs: s.deadlineTs || null,
    plan: shapePlan(s.plan),
    step: s.step ? minimalStep(s.step) : null,
    steps: shapeSteps(s.steps),
    devices: shapeDevices(s.devices),
  };
  return base;
}

function shapePlan(p) {
  if (!p || typeof p !== "object") return null;
  return {
    plannedStartTs: p.plannedStartTs || null,
    p50: p.p50 || null,
    p80: p.p80 || null,
    p95: p.p95 || null,
    criticalPath: Array.isArray(p.criticalPath) ? p.criticalPath.map(minimalStepRef) : null,
    buffers: p.buffers || null,
  };
}

function shapeSteps(list) {
  if (!Array.isArray(list)) return null;
  // Keep only fields the overlay needs
  return list.map(minimalStep);
}

function shapeDevices(list) {
  if (!Array.isArray(list)) return null;
  return list.map(d => ({
    id: d?.id || null,
    name: d?.name || null,
    kind: d?.kind || null, // oven|stovetop|dishwasher|counter|grill|custom
    slot: d?.slot ?? null,
    busy: !!d?.busy,
  }));
}

function shapeUi(ui) {
  const u = ui || {};
  return {
    theme: u.theme || "system",
    density: u.density || "comfortable",
    showTimers: u.showTimers !== false,
    showNutrition: u.showNutrition !== false,
    showNextStep: u.showNextStep !== false,
  };
}

function shapeNutrition(nutrition, ui) {
  if (!nutrition || typeof nutrition !== "object") return null;
  // Overlay expects a compact snapshot; keep names & macros only by default
  const n = {
    label: nutrition.label || "Per serving",
    servings: nutrition.servings || null,
    kcal: roundSafe(nutrition.kcal),
    protein_g: roundSafe(nutrition.protein_g),
    carbs_g: roundSafe(nutrition.carbs_g),
    fat_g: roundSafe(nutrition.fat_g),
  };
  // Optional extras if UI explicitly asked
  if (ui?.nutritionDetail === "extended") {
    n.fiber_g = roundSafe(nutrition.fiber_g);
    n.sugar_g = roundSafe(nutrition.sugar_g);
    n.sodium_mg = roundSafe(nutrition.sodium_mg);
  }
  return n;
}

/* ----------------------------- Redaction pass ---------------------------- */

const SENSITIVE_TOP_LEVEL = new Set([
  "inventory",
  "pantry",
  "cost",
  "supplier",
  "householdId",
  "userEmail",
  "userPhone",
  "exactLocation",
  "notesPrivate",
]);

const SENSITIVE_STEP_KEYS = new Set([
  "internalNotes",
  "private",
  "supplier",
  "cost",
  "storageLocation",
]);

function redactStreamerUnsafe(data) {
  // Deep clone to avoid mutating caller
  const copy = safeClone(data);

  // Strip top-level sensitive keys (if present inside extra/unknown)
  Object.keys(copy).forEach(k => {
    if (SENSITIVE_TOP_LEVEL.has(k)) delete copy[k];
  });

  // Scrub session fields
  if (copy.session) {
    // Steps: remove private fields
    if (Array.isArray(copy.session.steps)) {
      copy.session.steps = copy.session.steps.map(stripSensitiveFromStep);
    }
    if (copy.session.step) {
      copy.session.step = stripSensitiveFromStep(copy.session.step);
    }
    // Remove any pantry-like fields that may have slipped via extras
    delete copy.session.pantry;
    delete copy.session.cost;
    delete copy.session.supplier;
    delete copy.session.internalNotes;
  }

  // Extra domain payload may include sensitive bits; remove common culprits
  if (copy.extra && typeof copy.extra === "object") {
    Object.keys(copy.extra).forEach(k => {
      if (SENSITIVE_TOP_LEVEL.has(k)) delete copy.extra[k];
    });
  }

  return copy;
}

function stripSensitiveFromStep(step) {
  if (!step || typeof step !== "object") return step;
  const s = { ...step };
  Object.keys(s).forEach(k => { if (SENSITIVE_STEP_KEYS.has(k)) delete s[k]; });
  return s;
}

/* ------------------------------ Size control ----------------------------- */

function boundPayload(obj, maxBytes) {
  // Serialize to measure size
  let json = stableStringify(obj);
  let bytes = utf8Length(json);

  const meta = {
    bytes,
    truncated: false,
    etag: hashDJB2(json),
  };

  // If within bounds, attach meta and return
  if (bytes <= maxBytes) {
    const withMeta = { ...obj, __meta: meta };
    return withMeta;
  }

  // Otherwise, try truncation strategies: steps → messages → extra
  const shrunk = safeClone(obj);

  // 1) Trim steps details (keep only current & next)
  if (Array.isArray(shrunk.session?.steps) && shrunk.session.steps.length > 2) {
    const currentId = shrunk.session?.step?.id;
    const idx = shrunk.session.steps.findIndex(x => x?.id === currentId);
    const keep = [];
    if (idx >= 0) {
      keep.push(shrunk.session.steps[idx]);
      if (shrunk.session.steps[idx + 1]) keep.push(shrunk.session.steps[idx + 1]);
    } else {
      keep.push(shrunk.session.steps[0]);
      if (shrunk.session.steps[1]) keep.push(shrunk.session.steps[1]);
    }
    shrunk.session.steps = keep.map(minimalStep);
  }

  // 2) Drop extended nutrition if present
  if (shrunk.nutrition && "fiber_g" in (shrunk.nutrition || {})) {
    delete shrunk.nutrition.fiber_g;
    delete shrunk.nutrition.sugar_g;
    delete shrunk.nutrition.sodium_mg;
  }

  // 3) Remove "extra" if still too big
  json = stableStringify(shrunk);
  bytes = utf8Length(json);
  if (bytes > maxBytes) {
    delete shrunk.extra;
  }

  // Recompute
  json = stableStringify(shrunk);
  bytes = utf8Length(json);
  meta.bytes = bytes;
  meta.truncated = bytes > maxBytes ? true : (meta.truncated || json.length < stableStringify(obj).length);
  meta.etag = hashDJB2(json);

  // Final guard: if STILL too big, drop steps entirely (overlay can run with current step only)
  if (bytes > maxBytes && shrunk.session) {
    delete shrunk.session.steps;
    json = stableStringify(shrunk);
    bytes = utf8Length(json);
    meta.bytes = bytes;
    meta.truncated = true;
    meta.etag = hashDJB2(json);
  }

  return { ...shrunk, __meta: meta };
}

/* ------------------------------- Utilities ------------------------------- */

function coerceModeAndOpts(arg1, opts) {
  if (typeof arg1 === "string") {
    return { mode: arg1, normalizedOpts: opts || {} };
  }
  if (arg1 && typeof arg1 === "object") {
    return { mode: opts?.mode, normalizedOpts: { ...opts, ...arg1 } };
  }
  return { mode: undefined, normalizedOpts: opts || {} };
}

function assertMode(mode) {
  if (mode !== "draft" && mode !== "play") {
    throw new Error('buildOverlayPayload requires mode "draft" or "play"');
  }
}

function normalizeInputs(o = {}) {
  return {
    roomId: o.roomId || null,
    session: o.session || {},
    ui: o.ui || {},
    nutrition: o.nutrition || null,
    stream: o.stream || {},
    streamerSafe: o.streamerSafe,
    allowKeys: o.allowKeys,
    maxBytes: o.maxBytes,
    extra: o.extra,
  };
}

function coerceStatus(status, mode) {
  const s = (status || "").toLowerCase();
  if (s) return s;
  return mode === "play" ? "started" : "planned";
}

function minimalStepRef(x) {
  return x && typeof x === "object" ? { id: x.id || null, name: x.name || null } : null;
}

function minimalStep(x) {
  if (!x || typeof x !== "object") return null;
  return {
    id: x.id || null,
    name: x.name || null,
    durationMin: toNumber(x.durationMin),
    device: x.device || null,
    // Only safe & necessary display fields
    hints: Array.isArray(x.hints) ? x.hints.slice(0, 3) : null,
  };
}

function normalizeTimers(list) {
  if (!Array.isArray(list)) return null;
  return list.map(t => ({
    id: t?.id || null,
    label: t?.label || null,
    remainingSec: toNumber(t?.remainingSec),
    totalSec: toNumber(t?.totalSec),
    running: !!t?.running,
  }));
}

function inferTimersFromStep(step) {
  if (!step || typeof step !== "object") return null;
  const secs = Math.round((Number(step.durationMin) || 0) * 60);
  if (!secs) return null;
  return [{
    id: step.id ? `timer-${step.id}` : "timer-1",
    label: step.name || "Step",
    remainingSec: secs,
    totalSec: secs,
    running: true,
  }];
}

function estimateEta(timers) {
  if (!Array.isArray(timers) || !timers.length) return null;
  const maxRem = Math.max(...timers.map(t => Number(t.remainingSec) || 0));
  if (!Number.isFinite(maxRem)) return null;
  const eta = new Date(Date.now() + maxRem * 1000);
  return eta.toISOString();
}

function collectWarnings(base) {
  const warnings = [];
  const s = base.session || {};
  if (s.deadlineTs && s.eta) {
    try {
      const d = new Date(s.deadlineTs).getTime();
      const e = new Date(s.eta).getTime();
      if (Number.isFinite(d) && Number.isFinite(e) && e > d) {
        warnings.push("eta_exceeds_deadline");
      }
    } catch {}
  }
  if (Array.isArray(s.steps) && s.steps.length > 40) {
    warnings.push("many_steps_truncated_in_overlay");
  }
  return warnings.length ? warnings : null;
}

function pickKeys(obj, keys) {
  const out = {};
  keys.forEach(k => { if (k in obj) out[k] = obj[k]; });
  return out;
}

function roundSafe(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampIndex(i, len) {
  if (!Number.isFinite(i) || i < 0) return -1;
  if (i >= len) return len - 1;
  return i;
}

function safeClone(x) {
  try { return JSON.parse(JSON.stringify(x)); }
  catch { return x; }
}

function nowIso() { return new Date().toISOString(); }

function stableStringify(obj) {
  // Deterministic stringify for etag
  const seen = new WeakSet();
  return JSON.stringify(obj, function (k, v) {
    if (v && typeof v === "object") {
      if (seen.has(v)) return;
      seen.add(v);
      const o = {};
      Object.keys(v).sort().forEach(key => { o[key] = v[key]; });
      return o;
    }
    return v;
  });
}

function utf8Length(str) {
  // Fast-ish byte length approximation for UTF-8
  let bytes = 0, i = 0;
  for (i = 0; i < str.length; i++) {
    const codePoint = str.charCodeAt(i);
    if (codePoint < 0x80) bytes += 1;
    else if (codePoint < 0x800) bytes += 2;
    else if (codePoint >= 0xD800 && codePoint < 0xE000) { // surrogate pair
      bytes += 4; i++;
    } else bytes += 3;
  }
  return bytes;
}

function hashDJB2(str) {
  let hash = 5381, i = str.length;
  while (i) { hash = (hash * 33) ^ str.charCodeAt(--i); }
  return (hash >>> 0).toString(16);
}

function emit(type, data = {}) {
  try {
    eventBus.emit({ type, ts: nowIso(), source: SRC, data });
  } catch (err) {
    console.warn("[overlay:payloads] eventBus.emit failed", err);
  }
}

// Optional future archival — currently disabled on purpose
async function exportToHubIfEnabled(snapshotEnvelope) {
  try {
    const flags = require("@/config/featureFlags.json");
    if (!flags?.overlay?.exportSnapshotsToHub) return;
  } catch { return; }

  if (!HubPacketFormatter || !FamilyFundConnector) return;
  try {
    const packet = HubPacketFormatter.format(snapshotEnvelope);
    await FamilyFundConnector.send(packet);
  } catch { /* silent by design */ }
}

/* --------------------------------- Exports -------------------------------- */

module.exports = {
  buildOverlayPayload,
  __internals: {
    redactStreamerUnsafe,
    boundPayload,
    deriveViewFields,
    minimalStep,
    normalizeTimers,
    inferTimersFromStep,
    estimateEta,
    stableStringify,
    utf8Length,
    hashDJB2,
  },
};
