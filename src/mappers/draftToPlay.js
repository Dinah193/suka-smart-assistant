// C:\Users\larho\suka-smart-assistant\src\mappers\draftToPlay.js
/**
 * mappers/draftToPlay.js — Deterministic mapper: draft → session.play.start envelope
 *
 * Where this fits in SSA (imports → intelligence → automation → (optional) hub export):
 * - INPUT: a normalized session "draft" (from recipe/cleaning/garden/etc. imports or planners)
 * - INTELLIGENCE: we derive deterministic ids, initial timers, cursor, and privacy flags
 * - AUTOMATION: we build a canonical session.play.start envelope (contract-safe) and can emit it
 * - OPTIONAL HUB EXPORT: when familyFundMode is enabled, we format & send a lightweight packet
 *
 * Highlights:
 * - Deterministic sessionId from stable JSON + FNV-1a hash (stable across devices/environments)
 * - Cursor bootstrapping (startAtStepIndex) with defensive clamps
 * - Timers extraction from draft steps (label + durationMs); included in meta for analytics
 * - Streamer-safe privacy handling: [[private]]...[[/private]] redaction for titles/notes in meta
 * - Telemetry: standardized eventBus payloads { type, ts, source, data }
 * - Dev-friendly validation: optional hook to `validateSessionPlay` (safe soft-dep)
 *
 * This module itself does not mutate inventory/storehouse. It does "generate a session"
 * envelope; therefore we support optional Hub export (fail-silent) via exportToHubIfEnabled().
 */

/* --------------------------------- Wiring --------------------------------- */
let eventBus = {
  emit: (...a) => console.debug("[mapper:draftToPlay:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let featureFlags = { familyFundMode: false };
try {
  featureFlags = require("@/config/featureFlags");
} catch {}

let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch {}

/* Optional dev validator (soft import) */
let validateSessionPlay = null;
try {
  validateSessionPlay =
    require("@/contracts/validators/validateSessionPlay").validateSessionPlay;
} catch {}

/* --------------------------------- Utils ---------------------------------- */
const isBrowser =
  typeof window !== "undefined" &&
  typeof document !== "undefined" &&
  typeof navigator !== "undefined";

const nowISO = () => new Date().toISOString();

function emitTelemetry(type, data = {}) {
  try {
    eventBus.emit({ type, ts: nowISO(), source: "mappers.draftToPlay", data });
  } catch {}
}

function isPlainObject(x) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function clamp(num, lo, hi) {
  if (!Number.isFinite(num)) return lo;
  return Math.min(hi, Math.max(lo, num));
}

/** Stable stringify: sort object keys recursively for deterministic hashing */
function stableStringify(value) {
  const seen = new WeakSet();
  const sort = (val) => {
    if (val === null || typeof val !== "object") return val;
    if (seen.has(val)) return "[Circular]";
    seen.add(val);

    if (Array.isArray(val)) return val.map(sort);

    const keys = Object.keys(val).sort();
    const out = {};
    for (const k of keys) out[k] = sort(val[k]);
    return out;
  };
  try {
    return JSON.stringify(sort(value));
  } catch {
    return JSON.stringify(value);
  }
}

/** FNV-1a 32-bit hash → base36 */
function fnv1a36(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

/** Deterministic sessionId from domain, draft.id/title + structure */
function computeSessionId(draft) {
  const domain = String(draft?.domain || "general").toLowerCase();
  const seed =
    (draft?.id ? String(draft.id) : "") +
    "|" +
    (draft?.title ? String(draft.title) : "") +
    "|" +
    (draft?.version ? String(draft.version) : "");
  const body = stableStringify({
    domain,
    seed,
    stepsShape: (draft?.steps || []).map((s) => ({
      t: s?.type || s?.kind || "step",
      d: Number.isFinite(s?.durationMs) ? 1 : 0,
      n: !!s?.note,
    })),
  });
  return `${domain}_${fnv1a36(body)}`.slice(0, 24);
}

/** Normalize domain: supports cooking, cleaning, garden, animals, preservation, storehouse */
function normalizeDomain(d) {
  const v = String(d || "")
    .toLowerCase()
    .trim();
  if (
    [
      "cooking",
      "cleaning",
      "garden",
      "animals",
      "animal",
      "preservation",
      "storehouse",
    ].includes(v)
  ) {
    return v === "animal" ? "animals" : v;
  }
  return "cooking"; // safe default (most-common surface)
}

/** Redact [[private]]...[[/private]] when streamerSafe=true (for meta only; envelope stays clean) */
function redact(text, streamerSafe) {
  const s = typeof text === "string" ? text : "";
  if (!streamerSafe) return s;
  return s
    .replace(/\[\[private\]\][\s\S]*?\[\[\/private\]\]/gi, "[redacted]")
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[digits]")
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "[time]");
}

/** Extract timers from draft steps: looks for step.durationMs or step.timer{label,durationMs} */
function extractTimers(draft) {
  const timers = [];
  const steps = Array.isArray(draft?.steps) ? draft.steps : [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {};
    const label =
      (s.timer && s.timer.label) ||
      s.label ||
      s.title ||
      (typeof s.note === "string" ? s.note.slice(0, 40) : `Step ${i + 1}`);
    const dur = Number.isFinite(s?.durationMs)
      ? s.durationMs
      : Number.isFinite(s?.timer?.durationMs)
      ? s.timer.durationMs
      : null;
    if (Number.isFinite(dur) && dur >= 0) {
      const timerIdSeed = `t|${i}|${label}|${dur}`;
      timers.push({
        id: `tm_${fnv1a36(timerIdSeed)}`,
        label: String(label),
        durationMs: Math.floor(dur),
      });
    }
  }
  return timers;
}

/** Build initial cursor (step index) */
function computeStartIndex(draft, requestedIndex) {
  const steps = Array.isArray(draft?.steps) ? draft.steps : [];
  if (Number.isInteger(requestedIndex))
    return clamp(requestedIndex, 0, Math.max(steps.length - 1, 0));
  // If draft carries a hint (e.g., first actionable step), honor it
  if (Number.isInteger(draft?.startAtStepIndex)) {
    return clamp(draft.startAtStepIndex, 0, Math.max(steps.length - 1, 0));
  }
  return 0;
}

/* ---------------------------- Hub export helper ---------------------------- */
/**
 * Format + send to the Hub if featureFlags.familyFundMode is on.
 * Silent on any error.
 */
async function exportToHubIfEnabled(envelope, context = {}) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.formatSessionStart?.(envelope, context);
    if (!packet) return;
    await FamilyFundConnector.send?.(packet);
    emitTelemetry("hub.export.ok", {
      sessionId: envelope?.data?.sessionId,
      domain: envelope?.data?.domain,
    });
  } catch (err) {
    // fail silent but log telemetry for dev
    emitTelemetry("hub.export.fail", { message: err?.message || String(err) });
  }
}

/* ------------------------------- Main API --------------------------------- */
/**
 * Create a contract-safe session.play.start envelope from a draft (no side-effects).
 *
 * @param {object} draft - Normalized draft: { id?, domain, title?, notes?, steps?, version?, privacy? }
 * @param {object} [opts]
 *  - startAtStepIndex?: number
 *  - keepAwake?: boolean
 *  - speech?: { enabled?, lang?, voiceHint?, rate?, pitch?, volume? }
 *  - room?: string  (remote control room code)
 *  - source?: string (telemetry source label; default 'mappers.draftToPlay')
 *  - streamerSafe?: boolean (overrides draft.privacy.streamerSafe if provided)
 *  - validate?: boolean (default true in dev, false in prod)
 *  - attachMeta?: boolean (default true) — included under data.meta (safe analytics)
 *  - exportToHub?: boolean (default true) — try Hub export when familyFundMode is on
 * @returns {{ envelope: object, meta: object }}
 */
function draftToPlayStartEnvelope(draft, opts = {}) {
  if (!isPlainObject(draft)) {
    throw new Error("draftToPlayStartEnvelope: draft must be an object.");
  }

  const domain = normalizeDomain(draft.domain);
  const sessionId = computeSessionId(draft);
  const draftId = draft.id != null ? String(draft.id) : undefined;

  const streamerSafe =
    typeof opts.streamerSafe === "boolean"
      ? opts.streamerSafe
      : !!(draft?.privacy?.streamerSafe || draft?.prefs?.privacy?.streamerSafe);

  const startAtStepIndex = computeStartIndex(draft, opts.startAtStepIndex);
  const timers = extractTimers(draft);

  const meta = {
    // Safe analytics snapshot — never secrets. Text is redacted when streamerSafe=true.
    title: redact(draft?.title, streamerSafe) || undefined,
    notes: redact(draft?.notes, streamerSafe) || undefined,
    steps: Array.isArray(draft?.steps) ? draft.steps.length : 0,
    timers,
    version: draft?.version || undefined,
    streamerSafe,
    createdBy: draft?.createdBy || undefined,
    draftKind: draft?.kind || draft?.type || "session",
    device: isBrowser
      ? navigator?.userAgentData?.platform || navigator?.platform || "web"
      : "server",
  };

  const envelope = {
    type: "session.play.start",
    ts: nowISO(),
    source: String(opts.source || "mappers.draftToPlay"),
    data: {
      domain,
      sessionId,
      draftId,
      room: opts.room || undefined,
      streamerSafe,
      startAtStepIndex,
      keepAwake: !!opts.keepAwake,
      speech: isPlainObject(opts.speech) ? { ...opts.speech } : undefined,
      meta: opts.attachMeta === false ? undefined : meta,
    },
  };

  // Optional dev validation
  const shouldValidate =
    typeof opts.validate === "boolean"
      ? opts.validate
      : process.env.NODE_ENV !== "production" &&
        typeof validateSessionPlay === "function";

  if (shouldValidate && typeof validateSessionPlay === "function") {
    try {
      const res = validateSessionPlay(envelope, {
        strict: true,
        throwOnError: true,
      });
      if (res?.warnings?.length) {
        emitTelemetry("draftToPlay.validate.warnings", {
          warnings: res.warnings.slice(0, 4),
        });
      }
    } catch (err) {
      // Surface a precise error with a preview
      emitTelemetry("draftToPlay.validate.error", {
        message: err?.message || String(err),
      });
      throw err;
    }
  }

  emitTelemetry("draftToPlay.mapped", {
    domain,
    sessionId,
    timers: timers.length,
    startAtStepIndex,
    streamerSafe,
  });

  return { envelope, meta };
}

/**
 * Emit the start envelope on the shared eventBus and optionally export to Hub.
 * Returns the same envelope for chaining.
 *
 * @param {object} draft
 * @param {object} [opts] — same as draftToPlayStartEnvelope + { autoExport?: boolean }
 */
async function draftToPlayAndEmit(draft, opts = {}) {
  const { envelope, meta } = draftToPlayStartEnvelope(draft, opts);

  try {
    eventBus.emit(envelope);
    emitTelemetry("draftToPlay.emitted", {
      domain: envelope.data.domain,
      sessionId: envelope.data.sessionId,
    });
  } catch (err) {
    emitTelemetry("draftToPlay.emit.error", {
      message: err?.message || String(err),
    });
    throw err;
  }

  if (opts.exportToHub !== false) {
    // Export a non-sensitive projection; envelope already excludes secrets
    exportToHubIfEnabled(envelope, { meta });
  }

  return envelope;
}

/* ----------------------------- Convenience API ---------------------------- */
/**
 * Build ONLY (no emit/export) — useful for previews or links.
 */
function buildOnly(draft, opts = {}) {
  return draftToPlayStartEnvelope(draft, {
    ...opts,
    validate: opts.validate ?? false,
  });
}

/**
 * Build + emit (dev-friendly default) — emits the session.play.start envelope now.
 */
async function buildAndEmit(draft, opts = {}) {
  return draftToPlayAndEmit(draft, opts);
}

/* --------------------------------- Exports -------------------------------- */
module.exports = {
  draftToPlayStartEnvelope,
  draftToPlayAndEmit,
  buildOnly,
  buildAndEmit,
  // exposed utils for tests
  __test__: {
    computeSessionId,
    extractTimers,
    normalizeDomain,
    redact,
    computeStartIndex,
    stableStringify,
    fnv1a36,
  },
};
