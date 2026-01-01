/**
 * src/services/tts.js
 * -----------------------------------------------------------------------------
 * TTS Service (singleton)
 *
 * Purpose:
 * - Centralize Web Speech (Text-to-Speech) for SessionRunner and other SSA features.
 * - Speak step titles/cues, toasts, and critical warnings with resilient fallbacks.
 * - Emit standard event envelopes via eventBus; optionally mirror to Hub.
 *
 * How it fits:
 * - SessionRunner can call:
 *     import tts from "@/services/tts";
 *     await tts.init(); // optional, lazy otherwise
 *     tts.setProfile({ rate: 1.0, pitch: 1.0, volume: 1.0, voiceHint: { name: "Samantha", lang: "en-US" } });
 *     tts.speakStep(session, step, { prepend: "Next: ", append: "", interrupt: true });
 *   When paused/aborted: tts.cancelAll()
 *
 * Events emitted (payload: { type, ts, source, data }):
 * - device.tts.supported
 * - device.tts.voices.changed
 * - device.tts.requested
 * - device.tts.started
 * - device.tts.ended
 * - device.tts.cancelled
 * - device.tts.paused
 * - device.tts.resumed
 * - device.tts.error
 *
 * Resilience:
 * - SSR safe; checks window/speechSynthesis existence.
 * - Queues utterances; supports interrupt mode (cancel current then speak).
 * - Handles iOS “first user gesture” restriction gracefully (init() requires a gesture).
 * - Defensive guards on long text (trims + chunks).
 *
 * Extension points:
 * - Add SSML parsing → plain text (current no-SSML; browsers vary).
 * - Per-domain voice profiles (cooking vs animals).
 * -----------------------------------------------------------------------------
 */

import eventBus from "@/services/eventBus";
import { featureFlags } from "@/services/featureFlags";

let HubPacketFormatter = null;
let FamilyFundConnector = null;
(async () => {
  try {
    const m1 = await import("@/services/hub/HubPacketFormatter");
    const m2 = await import("@/services/hub/FamilyFundConnector");
    HubPacketFormatter = m1?.default || null;
    FamilyFundConnector = m2?.default || null;
  } catch { /* no-op */ }
})();

const SOURCE = "services.tts";
const isoNow = () => new Date().toISOString();

function emit(type, data = {}) {
  const payload = { type, ts: isoNow(), source: SOURCE, data };
  try { eventBus?.emit?.(payload); } catch { /* no-op */ }
  if (featureFlags?.familyFundMode) exportToHubIfEnabled(payload);
  return payload;
}

async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch { /* silent */ }
}

function supported() {
  try { return typeof window !== "undefined" && "speechSynthesis" in window; }
  catch { return false; }
}

// Basic sanitizer: strip tags/ssml-ish, collapse whitespace, limit length.
function sanitize(text, maxLen = 800) {
  if (typeof text !== "string") return "";
  const noTags = text.replace(/<[^>]+>/g, " ");
  const clean = noTags.replace(/\s+/g, " ").trim();
  return clean.slice(0, maxLen);
}

function chunkText(text, max = 180) {
  // Split by sentence-ish boundaries, then ensure pieces <= max chars
  const parts = text.split(/([.!?]\s+)/).reduce((acc, cur) => {
    if (!acc.length) return [cur];
    const prev = acc[acc.length - 1];
    if ((prev + cur).length <= max) acc[acc.length - 1] = prev + cur;
    else acc.push(cur);
    return acc;
  }, []);
  // Post-process to ensure none exceed max
  const final = [];
  for (const p of parts) {
    if (p.length <= max) { if (p.trim()) final.push(p.trim()); continue; }
    // Hard wrap
    for (let i = 0; i < p.length; i += max) {
      final.push(p.slice(i, i + max).trim());
    }
  }
  return final.filter(Boolean);
}

class TtsService {
  constructor() {
    /** @type {SpeechSynthesisVoice[]} */
    this._voices = [];
    this._initialized = false;
    this._profile = {
      rate: 1.0,
      pitch: 1.0,
      volume: 1.0,
      voiceHint: /** { name?: string, lang?: string } */ ({ lang: "en-US" }),
    };
    this._queue = [];
    this._speaking = false;
    this._paused = false;
    this._bindVoiceEvents();
    if (supported()) emit("device.tts.supported", { supported: true });
  }

  /* --------------------------------- Setup -------------------------------- */

  async init() {
    if (!supported()) {
      emit("device.tts.supported", { supported: false });
      return false;
    }
    // Browsers sometimes need an explicit getVoices() call to populate.
    await this._loadVoices();
    this._initialized = true;
    return true;
  }

  _bindVoiceEvents() {
    if (!supported()) return;
    try {
      window.speechSynthesis.onvoiceschanged = async () => {
        await this._loadVoices();
        emit("device.tts.voices.changed", { count: this._voices.length });
      };
    } catch { /* no-op */ }
  }

  async _loadVoices() {
    if (!supported()) return [];
    let tries = 0;
    let voices = window.speechSynthesis.getVoices() || [];
    // Some browsers populate asynchronously; retry briefly.
    while ((!voices || voices.length === 0) && tries < 5) {
      await new Promise(r => setTimeout(r, 100));
      voices = window.speechSynthesis.getVoices() || [];
      tries++;
    }
    this._voices = voices;
    return voices;
  }

  listVoices(filter = {}) {
    if (!this._voices?.length) return [];
    const { lang, name } = filter;
    return this._voices.filter(v => {
      if (lang && !String(v.lang || "").toLowerCase().startsWith(String(lang).toLowerCase())) return false;
      if (name && String(v.name) !== String(name)) return false;
      return true;
    });
  }

  setProfile(profile = {}) {
    // rate: 0.1..10 (spec), pitch: 0..2, volume: 0..1
    const clamp = (v, min, max, d) => Number.isFinite(+v) ? Math.min(max, Math.max(min, +v)) : d;
    if (profile.rate !== undefined)  this._profile.rate = clamp(profile.rate, 0.5, 2.0, 1.0);
    if (profile.pitch !== undefined) this._profile.pitch = clamp(profile.pitch, 0.5, 2.0, 1.0);
    if (profile.volume !== undefined) this._profile.volume = clamp(profile.volume, 0.0, 1.0, 1.0);
    if (profile.voiceHint && typeof profile.voiceHint === "object") {
      this._profile.voiceHint = { ...this._profile.voiceHint, ...profile.voiceHint };
    }
  }

  setPreferredVoiceByName(name) {
    const v = this._voices.find(x => x.name === name);
    if (v) this._profile.voiceHint = { ...this._profile.voiceHint, name: v.name, lang: v.lang };
    return !!v;
  }

  /* --------------------------------- Core --------------------------------- */

  /**
   * Speak arbitrary text.
   * @param {string} text
   * @param {{ interrupt?: boolean, rate?: number, pitch?: number, volume?: number, voiceHint?: { name?: string, lang?: string } }} opts
   * @returns {Promise<boolean>} resolves true if at least one utterance started.
   */
  async speak(text, opts = {}) {
    if (!supported()) return false;
    const safe = sanitize(text);
    if (!safe) return false;

    await this.init(); // ensure voices loaded at least once

    const profile = { ...this._profile, ...opts };
    if (opts.voiceHint) profile.voiceHint = { ...this._profile.voiceHint, ...opts.voiceHint };

    if (opts.interrupt) {
      this.cancelAll(); // cancel currently speaking; onend will be skipped by cancel
    }

    const chunks = chunkText(safe);
    for (const c of chunks) this._queue.push({ text: c, profile });

    if (!this._speaking && !this._paused) {
      this._dequeueAndSpeak();
    }

    emit("device.tts.requested", { chars: safe.length, chunks: chunks.length });
    return true;
  }

  /**
   * Speak a session step with helpful defaults.
   * @param {any} session
   * @param {any} step
   * @param {{ prepend?: string, append?: string, interrupt?: boolean }} opts
   */
  async speakStep(session, step, opts = {}) {
    if (!step) return false;
    const prefix = (opts.prepend ?? "");
    const suffix = (opts.append ?? "");
    const parts = [
      prefix,
      step.title || "",
      step.desc ? `. ${step.desc}` : "",
      step?.metadata?.cueNotes ? `. ${step.metadata.cueNotes}` : "",
      suffix,
    ];
    const text = sanitize(parts.join(" ").replace(/\s+/g, " "));
    return this.speak(text, { interrupt: !!opts.interrupt });
  }

  pause() {
    if (!supported()) return false;
    try {
      window.speechSynthesis.pause();
      this._paused = true;
      emit("device.tts.paused", {});
      return true;
    } catch (e) {
      emit("device.tts.error", { phase: "pause", message: String(e?.message || e) });
      return false;
    }
  }

  resume() {
    if (!supported()) return false;
    try {
      window.speechSynthesis.resume();
      this._paused = false;
      emit("device.tts.resumed", {});
      // If we had a queue and weren't speaking, continue
      if (!this._speaking && this._queue.length) this._dequeueAndSpeak();
      return true;
    } catch (e) {
      emit("device.tts.error", { phase: "resume", message: String(e?.message || e) });
      return false;
    }
  }

  cancelAll() {
    if (!supported()) return false;
    try {
      window.speechSynthesis.cancel();
      this._queue = [];
      this._speaking = false;
      this._paused = false;
      emit("device.tts.cancelled", {});
      return true;
    } catch (e) {
      emit("device.tts.error", { phase: "cancel", message: String(e?.message || e) });
      return false;
    }
  }

  isSpeaking() {
    if (!supported()) return false;
    try { return window.speechSynthesis.speaking || this._speaking; }
    catch { return this._speaking; }
  }

  /* ------------------------------ Internals ------------------------------- */

  _pickVoice(hint = {}) {
    if (!this._voices?.length) return null;
    const { name, lang } = hint;
    if (name) {
      const byName = this._voices.find(v => v.name === name);
      if (byName) return byName;
    }
    if (lang) {
      // Prefer enhanced/localService voices in requested language
      const langLower = String(lang).toLowerCase();
      const matches = this._voices.filter(v => String(v.lang || "").toLowerCase().startsWith(langLower));
      if (matches.length) {
        // Prefer non-default to avoid duplicates; then localService
        matches.sort((a, b) => {
          if (a.default && !b.default) return 1;
          if (!a.default && b.default) return -1;
          if (a.localService && !b.localService) return -1;
          if (!a.localService && b.localService) return 1;
          return 0;
        });
        return matches[0] || null;
      }
    }
    // Fallback: default voice
    return this._voices.find(v => v.default) || this._voices[0] || null;
  }

  _dequeueAndSpeak() {
    if (!supported()) return;
    if (this._speaking || this._paused) return;
    const next = this._queue.shift();
    if (!next) return;

    const voice = this._pickVoice(next.profile.voiceHint || {});
    const u = new SpeechSynthesisUtterance(next.text);
    u.voice = voice || null;
    u.rate = next.profile.rate;
    u.pitch = next.profile.pitch;
    u.volume = next.profile.volume;

    u.onstart = () => {
      this._speaking = true;
      emit("device.tts.started", {
        textLen: next.text.length,
        voice: u.voice?.name || null,
        lang: u.voice?.lang || null,
        rate: u.rate, pitch: u.pitch, volume: u.volume,
      });
    };
    u.onend = () => {
      emit("device.tts.ended", { textLen: next.text.length });
      this._speaking = false;
      // speak next chunk if any
      if (!this._paused) this._dequeueAndSpeak();
    };
    u.onerror = (e) => {
      emit("device.tts.error", { phase: "speak", message: String(e?.error || e?.message || "unknown") });
      this._speaking = false;
      if (!this._paused) this._dequeueAndSpeak();
    };

    try {
      window.speechSynthesis.speak(u);
    } catch (e) {
      emit("device.tts.error", { phase: "speak", message: String(e?.message || e) });
      this._speaking = false;
    }
  }
}

const tts = new TtsService();
export default tts;

/* --------------------------------- Usage -----------------------------------
 * // In SessionRunner controller:
 * import tts from "@/services/tts";
 *
 * // Respect user prefs:
 * if (session?.prefs?.voiceGuidance) {
 *   tts.setProfile({ rate: 1.05, voiceHint: { lang: "en-US" } });
 *   await tts.init(); // after a user gesture if on iOS
 *   tts.speakStep(session, session.steps[session.progress.currentStepIndex] || {}, { interrupt: true });
 * }
 *
 * // On pause/resume:
 * tts.pause(); // → device.tts.paused
 * tts.resume(); // → device.tts.resumed
 *
 * // On abort/completion:
 * tts.cancelAll();
 * -------------------------------------------------------------------------- */
