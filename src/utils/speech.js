// C:\Users\larho\suka-smart-assistant\src\utils\speech.js
/**
 * utils/speech.js — Safe speechSynthesis wrapper; respects prefs.privacy.streamerSafe
 *
 * Where this fits in SSA:
 * - SSA pipeline: imports → intelligence → automation → (optional) hub export.
 * - This module lives in the "automation/execution UX" layer to provide hands-busy
 *   audible prompts (e.g., timers, step directions) without mutating household data.
 * - It emits standardized telemetry on the shared eventBus: { type, ts, source, data }.
 *
 * Design goals:
 * - Defensive: gracefully handle missing speechSynthesis, voice loading race, SSR.
 * - Privacy-aware: if prefs.privacy.streamerSafe is true, redact sensitive text.
 *   (Supports [[private]]...[[/private]] markers and light heuristics.)
 * - Queue-based: chunk long text, allow multiple enqueued messages, pause/resume/cancel.
 * - Configurable: voice selection hints, rate/pitch/volume defaults per user.
 * - Visibility-aware: optional ducking when page hidden/visible (kept minimal here).
 * - Non-invasive: does not change data → no hub export here.
 */

let eventBus = {
  emit: (...a) => console.debug("[speech:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

const isBrowser =
  typeof window !== "undefined" &&
  typeof document !== "undefined" &&
  typeof navigator !== "undefined";

const hasSpeech =
  isBrowser &&
  "speechSynthesis" in window &&
  "SpeechSynthesisUtterance" in window;

/* -------------------------------------------------------------------------- */
/* Event helpers                                                              */
/* -------------------------------------------------------------------------- */
const nowISO = () => new Date().toISOString();

function emit(type, data = {}) {
  try {
    eventBus.emit({ type, ts: nowISO(), source: "utils.speech", data });
  } catch (err) {
    console.debug("[utils.speech emit error]", err);
  }
}

/* -------------------------------------------------------------------------- */
/* Defaults & prefs                                                           */
/* -------------------------------------------------------------------------- */
const prefs = {
  enabled: true,
  privacy: {
    streamerSafe: false, // when true, redact sensitive bits before speaking
  },
  voiceHint: {
    lang: "", // e.g., "en-US"
    nameSubstr: "", // e.g., "Female", "Google", "Samantha"
  },
  volume: 1.0, // 0..1
  rate: 1.0, // 0.1..10
  pitch: 1.0, // 0..2
  maxCharsPerChunk: 180, // conservative for mobile synthesizers
  pauseBetweenChunksMs: 40,
  punctuationPauseMs: 140, // small pause injection at .,!?:
};

/** External toggles */
export function setSpeechEnabled(on) {
  prefs.enabled = !!on;
  emit("speech.prefs.changed", { enabled: prefs.enabled });
}
export function setStreamerSafe(on) {
  prefs.privacy.streamerSafe = !!on;
  emit("speech.prefs.changed", { streamerSafe: prefs.privacy.streamerSafe });
}
export function setVoiceHint({ lang, nameSubstr } = {}) {
  if (typeof lang === "string") prefs.voiceHint.lang = lang;
  if (typeof nameSubstr === "string") prefs.voiceHint.nameSubstr = nameSubstr;
  emit("speech.prefs.changed", { voiceHint: { ...prefs.voiceHint } });
}
export function setDefaults({ volume, rate, pitch, maxCharsPerChunk } = {}) {
  if (Number.isFinite(volume)) prefs.volume = clamp(volume, 0, 1);
  if (Number.isFinite(rate)) prefs.rate = clamp(rate, 0.1, 3); // keep humane
  if (Number.isFinite(pitch)) prefs.pitch = clamp(pitch, 0, 2);
  if (Number.isFinite(maxCharsPerChunk))
    prefs.maxCharsPerChunk = Math.max(40, Math.floor(maxCharsPerChunk));
  emit("speech.prefs.changed", {
    volume: prefs.volume,
    rate: prefs.rate,
    pitch: prefs.pitch,
    maxCharsPerChunk: prefs.maxCharsPerChunk,
  });
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function noop() {}

function safeString(x) {
  return typeof x === "string" ? x : x == null ? "" : String(x);
}

/**
 * Lightweight privacy redactor:
 * - Remove explicit [[private]]...[[/private]] segments.
 * - Mask numbers that look like phone amounts or times (e.g., "555-1212", "06:32").
 * - Optionally strip parentheses notes that might contain addresses/IDs.
 */
function redactForStreamerSafe(text) {
  let t = safeString(text);

  // Explicit markers
  t = t.replace(/\[\[private\]\][\s\S]*?\[\[\/private\]\]/gi, "[redacted]");

  // Mask phone-like and time-like tokens
  t = t.replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[digits]");
  t = t.replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "[time]");

  // Mask long digit runs (IDs, order numbers)
  t = t.replace(/\b\d{5,}\b/g, (m) => "*".repeat(Math.min(m.length, 12)));

  // Strip parentheses notes if they contain @ or # or long digits
  t = t.replace(/\(([^)]{0,120})\)/g, (m, inner) => {
    if (/@|#|\d{4,}/.test(inner)) return "";
    return m;
  });

  // Collapse excessive whitespace
  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}

/**
 * Split text into synth-friendly chunks at sentence boundaries when possible.
 */
function chunkText(text, maxLen) {
  const t = safeString(text);
  if (t.length <= maxLen) return [t];

  const out = [];
  let remaining = t;
  const sentenceSep = /([.!?…]+)\s+/g;

  while (remaining.length > maxLen) {
    let cut = -1;
    let lastSepIdx = -1;
    sentenceSep.lastIndex = 0;

    let match;
    while ((match = sentenceSep.exec(remaining))) {
      const idx = match.index + match[0].length;
      if (idx <= maxLen) lastSepIdx = idx;
      else break;
    }
    if (lastSepIdx > 0) {
      cut = lastSepIdx;
    } else {
      // fallback: cut at last space before maxLen
      const spaceIdx = remaining.lastIndexOf(" ", maxLen);
      cut = spaceIdx > 0 ? spaceIdx + 1 : maxLen;
    }
    out.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) out.push(remaining);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Voice management                                                           */
/* -------------------------------------------------------------------------- */
let cachedVoices = [];
let voicesReadyResolve = noop;
const voicesReadyPromise = new Promise((res) => (voicesReadyResolve = res));

function refreshVoices() {
  if (!hasSpeech) return [];
  try {
    cachedVoices = window.speechSynthesis.getVoices() || [];
    if (cachedVoices.length) {
      voicesReadyResolve(cachedVoices);
      emit("speech.voices.ready", {
        count: cachedVoices.length,
        langs: Array.from(new Set(cachedVoices.map((v) => v.lang))).slice(
          0,
          12
        ),
      });
    }
  } catch {}
  return cachedVoices;
}

if (hasSpeech) {
  // Some UAs fire this after async voice load
  window.speechSynthesis.onvoiceschanged = refreshVoices;
  // Kick an early fetch
  refreshVoices();
}

/** Public: returns voices synchronously (may be empty early in page life) */
export function listVoicesSync() {
  return cachedVoices.slice();
}

/** Public: await voices availability */
export async function listVoices() {
  refreshVoices();
  // Small safety timeout to avoid hanging forever on broken engines
  const timeout = new Promise((res) =>
    setTimeout(() => res(cachedVoices.slice()), 1200)
  );
  const v = await Promise.race([voicesReadyPromise, timeout]);
  return (v || []).slice();
}

/**
 * Choose a voice using hint { lang, nameSubstr } with graceful fallback.
 */
function chooseVoice(hint = prefs.voiceHint) {
  const voices = cachedVoices.length ? cachedVoices : refreshVoices();

  if (!voices || voices.length === 0) return null;

  const lang = safeString(hint.lang).toLowerCase().trim();
  const nameSub = safeString(hint.nameSubstr).toLowerCase().trim();

  let candidates = voices;

  if (lang)
    candidates = candidates.filter((v) =>
      v.lang.toLowerCase().startsWith(lang)
    );
  if (nameSub)
    candidates = candidates.filter((v) =>
      v.name.toLowerCase().includes(nameSub)
    );

  if (!candidates.length && lang) {
    // fallback: match language loosely (e.g., 'en' matches 'en-US')
    candidates = voices.filter((v) =>
      v.lang.toLowerCase().startsWith(lang.slice(0, 2))
    );
  }

  // Prefer localService voices for latency
  candidates.sort((a, b) => Number(b.localService) - Number(a.localService));

  return candidates[0] || voices[0] || null;
}

/* -------------------------------------------------------------------------- */
/* Speech manager (queue, chunking, controls)                                 */
/* -------------------------------------------------------------------------- */
class SpeechManager {
  queue = [];
  speaking = false;
  paused = false;
  current = null;
  lastUtteranceId = 0;

  async speak(text, options = {}) {
    if (!isBrowser || !hasSpeech) {
      emit("speech.unsupported", { reason: "no_speech_api" });
      return false;
    }
    if (!prefs.enabled) {
      emit("speech.skipped", { reason: "disabled" });
      return false;
    }

    const raw = safeString(text);
    const toSpeak = prefs.privacy.streamerSafe
      ? redactForStreamerSafe(raw)
      : raw;
    if (!toSpeak) {
      emit("speech.skipped", { reason: "empty_after_redact" });
      return false;
    }

    const {
      lang = prefs.voiceHint.lang || undefined,
      voiceName = prefs.voiceHint.nameSubstr || undefined,
      rate = prefs.rate,
      pitch = prefs.pitch,
      volume = prefs.volume,
      tag = undefined, // e.g., "cooking:step:123"
      announce = undefined, // custom event tag
      injectPunctuationPauses = true,
    } = options;

    const chunks = chunkText(
      injectPunctuationPauses
        ? injectPauses(toSpeak, prefs.punctuationPauseMs)
        : toSpeak,
      prefs.maxCharsPerChunk
    );

    // Enqueue chunks as individual utterances with same tag
    const ids = [];
    for (const textChunk of chunks) {
      const id = ++this.lastUtteranceId;
      const item = {
        id,
        text: textChunk,
        opts: { lang, voiceName, rate, pitch, volume, tag, announce },
      };
      this.queue.push(item);
      ids.push(id);
    }

    emit("speech.queue.added", { count: chunks.length, tag, ids });
    // Start pump if idle
    if (!this.speaking && !this.paused) this.#pump();

    return true;
  }

  pause() {
    if (!hasSpeech) return;
    try {
      window.speechSynthesis.pause();
      this.paused = true;
      emit("speech.paused", {});
    } catch {}
  }

  resume() {
    if (!hasSpeech) return;
    try {
      window.speechSynthesis.resume();
      this.paused = false;
      emit("speech.resumed", {});
      if (!this.speaking) this.#pump();
    } catch {}
  }

  cancelAll(reason = "user") {
    if (!hasSpeech) return;
    try {
      this.queue.length = 0;
      window.speechSynthesis.cancel();
      this.speaking = false;
      this.current = null;
      emit("speech.queue.cleared", { reason });
    } catch {}
  }

  isSpeaking() {
    return !!this.speaking;
  }

  isPaused() {
    return !!this.paused;
  }

  async #pump() {
    if (this.speaking || this.paused) return;
    const next = this.queue.shift();
    if (!next) {
      emit("speech.queue.empty", {});
      return;
    }
    this.speaking = true;
    this.current = next;

    // Build utterance
    const u = new window.SpeechSynthesisUtterance(next.text);
    const v =
      chooseVoice({
        lang: next.opts.lang || prefs.voiceHint.lang,
        nameSubstr: next.opts.voiceName || prefs.voiceHint.nameSubstr,
      }) || null;

    if (v) u.voice = v;
    if (next.opts.lang) u.lang = next.opts.lang;
    u.rate = clamp(next.opts.rate ?? prefs.rate, 0.1, 3);
    u.pitch = clamp(next.opts.pitch ?? prefs.pitch, 0, 2);
    u.volume = clamp(next.opts.volume ?? prefs.volume, 0, 1);

    u.onstart = () => {
      emit("speech.start", {
        id: next.id,
        tag: next.opts.tag,
        voice: v
          ? { name: v.name, lang: v.lang, local: !!v.localService }
          : null,
      });
    };
    u.onend = async () => {
      emit("speech.end", { id: next.id, tag: next.opts.tag });
      this.speaking = false;
      this.current = null;
      // slight delay between chunks to avoid stutter
      setTimeout(() => this.#pump(), prefs.pauseBetweenChunksMs);
    };
    u.onerror = (e) => {
      emit("speech.error", {
        id: next.id,
        tag: next.opts.tag,
        message: e?.error || e?.message || "unknown",
      });
      this.speaking = false;
      this.current = null;
      setTimeout(() => this.#pump(), prefs.pauseBetweenChunksMs);
    };

    try {
      window.speechSynthesis.speak(u);
    } catch (err) {
      emit("speech.error", {
        id: next.id,
        tag: next.opts.tag,
        message: err?.message || String(err),
      });
      this.speaking = false;
      this.current = null;
      setTimeout(() => this.#pump(), prefs.pauseBetweenChunksMs);
    }
  }
}

/* Tiny helper: add micro-pauses after punctuation (improves intelligibility) */
function injectPauses(text, ms = 120) {
  const pauseToken = `, pause ${Math.max(60, ms)}ms, `;
  // Non-invasive: only at sentence end punctuation
  return text.replace(/([.!?…])\s+/g, `$1 ${pauseToken}`);
}

/* Singleton speech manager */
const manager = new SpeechManager();

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */
/**
 * Speak a text string with safe defaults and privacy redaction when enabled.
 * options: { lang, voiceName, rate, pitch, volume, tag, announce, injectPunctuationPauses }
 */
export async function speak(text, options = {}) {
  if (!isBrowser) {
    emit("speech.skipped", { reason: "not_browser" });
    return false;
  }
  return manager.speak(text, options);
}

export function pause() {
  return manager.pause();
}
export function resume() {
  return manager.resume();
}
export function cancelAll(reason) {
  return manager.cancelAll(reason);
}
export function isSpeaking() {
  return manager.isSpeaking();
}
export function isPaused() {
  return manager.isPaused();
}

/**
 * Subscribe to speech status events (start/end/error/prefs/queue.*)
 * Returns unsubscribe()
 */
export function onSpeechStatus(cb) {
  if (typeof cb !== "function") return () => {};
  const handler = (evt) => {
    if (!evt || typeof evt !== "object") return;
    const t = String(evt.type || "");
    if (t.startsWith("speech.")) cb(evt);
  };
  const off = eventBus.on(handler);
  return typeof off === "function" ? off : () => {};
}

/* -------------------------------------------------------------------------- */
/* Opt-in auto-wiring to SSA events                                           */
/* -------------------------------------------------------------------------- *
 * Any module can emit:
 *  - { type: "session.step.announce", data: { text, lang, tag } }
 *  - { type: "timer.completed", data: { label } }  // concise audible alert
 *  - { type: "session.play.stop" }                 // clear any queued speech
 * This keeps domain modules lean and centralizes privacy-aware speech here.
 * -------------------------------------------------------------------------- */
try {
  eventBus.on(async (evt) => {
    if (!evt || typeof evt !== "object") return;

    if (evt.type === "session.step.announce") {
      const text = safeString(evt?.data?.text);
      if (text) {
        await speak(text, {
          lang: evt?.data?.lang,
          tag: evt?.data?.tag || evt?.data?.sessionId || "session:step",
        });
      }
      return;
    }

    if (evt.type === "timer.completed") {
      const label = safeString(evt?.data?.label || "Timer");
      await speak(`${label} is done.`);
      return;
    }

    if (evt.type === "session.play.stop") {
      cancelAll("session_end");
      return;
    }
  });
} catch {}

/* -------------------------------------------------------------------------- */
/* Notes for integrators                                                      */
/* -------------------------------------------------------------------------- *
 * - Mark secrets with [[private]] ... [[/private]] to guarantee redaction when
 *   streamerSafe is enabled. Example: "Add [[private]]2 tbsp of our family mix[[/private]] now."
 * - To select a voice, call setVoiceHint({ lang: "en-US", nameSubstr: "Google" }).
 * - Pair with utils/awake.js (keepAwake) and utils/notify.js for a complete
 *   hands-busy session UX (screen-on + audible prompts + toasts/notifications).
 */
