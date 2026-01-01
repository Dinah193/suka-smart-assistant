/**
 * src/features/session/session.helpers.js
 * -----------------------------------------------------------------------------
 * Purpose
 * - A focused utility toolkit used by SessionRunner and Session UI to:
 *   • handle wake lock, notifications, speech, media keys, and PiP HUD
 *   • persist + resume progress (Dexie SessionsRepo integration)
 *   • evaluate guards and compute the next runnable step
 *   • export analytics to the Hub when familyFundMode is enabled
 *   • run resilient tick timers in a Web Worker (survives tab throttling)
 *
 * How this fits
 * - SessionRunner.jsx (root-mounted modal) should import these helpers to keep
 *   sessions alive across navigation, emit events on changes, and persist
 *   checkpoints every 10s and on step transitions.
 *
 * Contracts & Assumptions
 * - eventBus:           src/services/eventBus.js
 * - featureFlags:       src/services/featureFlags.js  (boolean familyFundMode)
 * - HubPacketFormatter: src/services/hub/HubPacketFormatter.js
 * - FamilyFundConnector src/services/hub/FamilyFundConnector.js
 * - SessionsRepo:       src/data/SessionsRepo.js  (Dexie abstraction)
 *   Required minimum repo API used here (adjust to your existing signatures):
 *     SessionsRepo.updateProgress(sessionId, progress) -> Promise<void>
 *     SessionsRepo.writeCheckpoint(sessionId, progress) -> Promise<void>
 *     SessionsRepo.setStatus(sessionId, status) -> Promise<void>
 *     SessionsRepo.get(id) -> Promise<Session|null>
 *
 * Typing
 * - JSDoc annotations for key types; no TS dependency.
 *
 * Extension points
 * - Add new guards in evaluateGuards().
 * - Extend media session handlers, PiP HUD, or notification payloads as needed.
 * -----------------------------------------------------------------------------
 */

import eventBus from '@/services/eventBus';
import featureFlags from '@/services/featureFlags';
import * as SessionsRepo from '@/data/SessionsRepo';
import { SESSION_EVENTS, emitCheckpointWritten, emitWarning } from '@/features/session/session.events';

// Optional hub imports (wrapped in try/catch for graceful degradation)
let HubPacketFormatter, FamilyFundConnector;
try { HubPacketFormatter = require('@/services/hub/HubPacketFormatter'); } catch {}
try { FamilyFundConnector = require('@/services/hub/FamilyFundConnector'); } catch {}

// Optional guard imports (each is expected to expose async isBlocked(session):boolean)
let sabbathGuard, quietHoursGuard, weatherGuard, inventoryGuard, batteryGuard;
try { sabbathGuard = require('@/guards/sabbathGuard'); } catch {}
try { quietHoursGuard = require('@/guards/quietHoursGuard'); } catch {}
try { weatherGuard = require('@/guards/weatherGuard'); } catch {}
try { inventoryGuard = require('@/guards/inventoryGuard'); } catch {}
try { batteryGuard = require('@/guards/batteryGuard'); } catch {}

/** @typedef {import('@/types').Session} Session */
/** @typedef {import('@/types').SessionStep} SessionStep */
/** @typedef {import('@/types').SessionProgress} SessionProgress */

// -----------------------------------------------------------------------------
// Date & formatting
// -----------------------------------------------------------------------------

/** @returns {string} ISO string now */
export function isoNow() { return new Date().toISOString(); }

/** @param {number} seconds @returns {string} "H:MM:SS" or "M:SS" */
export function formatHMS(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = m.toString().padStart(h ? 2 : 1, '0');
  const ss = s.toString().padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** Clamp helper */
export function clamp(n, min, max) { return Math.min(Math.max(n, min), max); }

// -----------------------------------------------------------------------------
// Guard evaluation (pre-run / inter-step)
// -----------------------------------------------------------------------------

/**
 * Evaluate global guards before starting/resuming a session.
 * The runner should also re-check blockers per step.
 * @param {Session} session
 * @returns {Promise<{blocked: boolean, reasons: string[]}>}
 */
export async function evaluateGuards(session) {
  const reasons = [];
  const safeCheck = async (guard, code) => {
    if (!guard?.isBlocked) return false;
    try { return !!(await guard.isBlocked(session)); }
    catch (e) {
      console.warn(`[session.helpers] Guard "${code}" errored; failing open`, e);
      // non-fatal; we let it pass but warn the UI
      emitWarning(session.id, { code: `guard.${code}.error`, message: 'Guard error, proceeding' });
      return false;
    }
  };
  const results = await Promise.all([
    safeCheck(sabbathGuard, 'sabbath').then(v => v && reasons.push('sabbath')),
    safeCheck(quietHoursGuard, 'quietHours').then(v => v && reasons.push('quietHours')),
    safeCheck(weatherGuard, 'weather').then(v => v && reasons.push('weather')),
    safeCheck(inventoryGuard, 'inventory').then(v => v && reasons.push('inventory')),
    safeCheck(batteryGuard, 'battery').then(v => v && reasons.push('battery')),
  ]);
  return { blocked: results.some(Boolean), reasons };
}

/**
 * Compute the next step index that is safe to run (naive: start from current).
 * The Runner can call this when resuming or skipping blocked steps.
 * @param {Session} session
 * @returns {number} index within [0, steps.length)
 */
export function computeNextRunnableIndex(session) {
  const steps = Array.isArray(session?.steps) ? session.steps : [];
  const startAt = clamp(Number(session?.progress?.currentStepIndex) || 0, 0, Math.max(steps.length - 1, 0));
  // In this helper we simply return current index; the Runner can implement
  // richer logic (e.g., skip invalid/missing steps).
  return startAt;
}

// -----------------------------------------------------------------------------
// Wake Lock (Screen)
// -----------------------------------------------------------------------------

let _wakeLockSentinel = null;

/** Try to keep the screen awake; returns true if locked */
export async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && navigator.wakeLock?.request) {
      _wakeLockSentinel = await navigator.wakeLock.request('screen');
      _wakeLockSentinel.addEventListener?.('release', () => { _wakeLockSentinel = null; });
      return true;
    }
  } catch (e) {
    console.warn('[session.helpers] Wake Lock request failed', e);
  }
  return false;
}

export async function releaseWakeLock() {
  try {
    await _wakeLockSentinel?.release?.();
  } catch (e) {
    // ignore
  } finally {
    _wakeLockSentinel = null;
  }
}

// -----------------------------------------------------------------------------
// Notifications
// -----------------------------------------------------------------------------

/** Ensure permission; returns 'granted'|'denied'|'default' */
export async function ensureNotificationPermission() {
  try {
    if (!('Notification' in window)) return 'denied';
    if (Notification.permission === 'granted') return 'granted';
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/**
 * Show/update an ongoing "Session in progress" notification.
 * Note: For action buttons to work reliably, configure your service worker
 * to listen for notificationclick and postMessage back to the client.
 * @param {{ sessionId:string, title:string, stepTitle?:string, stepIndex:number, totalSteps:number, paused?:boolean }} info
 * @returns {Notification|null}
 */
export function showOngoingNotification(info) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return null;
  try {
    const body = [
      info.paused ? '⏸ Paused' : '▶ In progress',
      `Step ${info.stepIndex + 1}/${info.totalSteps}`,
      info.stepTitle ? `• ${info.stepTitle}` : '',
    ].filter(Boolean).join('  ');
    const n = new Notification(info.title || 'Session in progress', {
      body,
      tag: `ssa-session-${info.sessionId}`, // ensures it updates in place
      requireInteraction: false,
      // icon: '/icons/ssa-192.png', // optional: supply your app icon
      actions: [
        { action: 'pause', title: info.paused ? 'Resume' : 'Pause' },
        { action: 'next',  title: 'Next' },
      ],
    });
    return n;
  } catch (e) {
    console.warn('[session.helpers] Notification failed', e);
    return null;
  }
}

/** Close an ongoing notification by tag (best-effort; browser limits apply) */
export function closeOngoingNotification(sessionId) {
  // There is no direct window-side API to close by tag; rely on SW or simply
  // create a final "completed" notification that replaces the existing one.
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification('Session finished', {
      body: 'Nice work! 🎉',
      tag: `ssa-session-${sessionId}`,
      requireInteraction: false,
    });
  } catch {}
}

// -----------------------------------------------------------------------------
// Web Speech (TTS)
// -----------------------------------------------------------------------------

/**
 * Speak a short cue with Web Speech API if available.
 * Returns a function to cancel the utterance.
 * @param {string} text
 * @param {{ rate?:number, pitch?:number, volume?:number, voice?:SpeechSynthesisVoice }} [opts]
 */
export function speak(text, opts = {}) {
  if (!text || !('speechSynthesis' in window)) return () => {};
  try {
    const u = new SpeechSynthesisUtterance(text);
    if (opts.voice) u.voice = opts.voice;
    if (opts.rate) u.rate = clamp(opts.rate, 0.5, 2);
    if (opts.pitch) u.pitch = clamp(opts.pitch, 0, 2);
    if (opts.volume) u.volume = clamp(opts.volume, 0, 1);
    window.speechSynthesis.speak(u);
    return () => window.speechSynthesis.cancel();
  } catch {
    return () => {};
  }
}

// -----------------------------------------------------------------------------
// Media Session API (hardware keys / OS integrations)
// -----------------------------------------------------------------------------

/**
 * Wire handlers to media keys (play/pause/next/previous).
 * @param {{ onPlay?:Function, onPause?:Function, onNext?:Function, onPrev?:Function, title?:string, artist?:string, album?:string }} h
 */
export function attachMediaSession(h = {}) {
  try {
    if (!('mediaSession' in navigator)) return () => {};
    navigator.mediaSession.metadata = new MediaMetadata({
      title: h.title || 'SSA Session',
      artist: h.artist || 'Suka Smart Assistant',
      album: h.album || 'Household',
    });
    if (h.onPlay)  navigator.mediaSession.setActionHandler('play',  () => h.onPlay());
    if (h.onPause) navigator.mediaSession.setActionHandler('pause', () => h.onPause());
    if (h.onNext)  navigator.mediaSession.setActionHandler('nexttrack', () => h.onNext());
    if (h.onPrev)  navigator.mediaSession.setActionHandler('previoustrack', () => h.onPrev());
    return () => {
      try {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.setActionHandler('nexttrack', null);
        navigator.mediaSession.setActionHandler('previoustrack', null);
        navigator.mediaSession.metadata = null;
      } catch {}
    };
  } catch {
    return () => {};
  }
}

// -----------------------------------------------------------------------------
// Document Picture-in-Picture (mini HUD)
// -----------------------------------------------------------------------------

let _pipWindow = null;

/**
 * Open a tiny always-on-top HUD via Document Picture-in-Picture (Chromium).
 * This function creates a simple shadow DOM container where your caller can
 * render controls (e.g., using vanilla DOM).
 * @param {{ width?: number, height?: number, title?: string }} [opts]
 * @returns {Promise<{ win:Window, root:ShadowRoot, close:Function }|null>}
 */
export async function openPiPHUD(opts = {}) {
  try {
    const api = /** @type {any} */ (document);
    if (!api.pictureInPictureEnabled && !api.documentPictureInPicture) return null;

    const dpi = api.documentPictureInPicture || api; // newer API is documentPictureInPicture
    const width = clamp(opts.width || 320, 240, 600);
    const height = clamp(opts.height || 120, 100, 400);

    _pipWindow = await dpi.requestWindow?.({ width, height }) ||
                 await api.requestPictureInPicture?.(); // older compat (video-only)
    if (!_pipWindow) return null;

    const doc = _pipWindow.document;
    doc.body.style.margin = '0';
    doc.body.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    doc.title = opts.title || 'SSA Session HUD';

    // base container + shadow root to avoid CSS bleed
    const host = doc.createElement('div');
    host.style.all = 'initial';
    host.style.display = 'block';
    host.style.width = '100%';
    host.style.height = '100%';
    doc.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });

    // A very tiny default bar (caller may overwrite contents):
    const wrap = doc.createElement('div');
    wrap.setAttribute('part', 'wrap');
    wrap.style.cssText = `
      box-sizing: border-box;
      width: 100%; height: 100%;
      background: #0f1115; color: #fff; 
      display: grid; grid-template-columns: 1fr auto auto; gap: 8px;
      align-items: center; padding: 10px 12px; 
      border: 1px solid #242a33;
    `;
    wrap.innerHTML = `
      <div id="hud-title" style="font-weight:800;">Session Running</div>
      <button id="hud-prev" part="btn">◀</button>
      <button id="hud-next" part="btn">▶</button>
    `;

    const style = doc.createElement('style');
    style.textContent = `
      :host { all: initial; }
      [part="btn"] {
        all: initial;
        color: #fff; background: #101923; 
        border: 1px solid #2a3442; padding: 6px 10px; border-radius: 8px;
        font-weight: 700; cursor: pointer; text-align: center;
      }
      [part="btn"]:hover { background: #0d1520; }
    `;
    root.appendChild(style);
    root.appendChild(wrap);

    const close = () => { try { _pipWindow?.close?.(); } catch {} _pipWindow = null; };
    _pipWindow.addEventListener('pagehide', () => { _pipWindow = null; });

    return { win: _pipWindow, root, close };
  } catch (e) {
    console.warn('[session.helpers] PiP HUD failed', e);
    return null;
  }
}

export function closePiPHUD() {
  try { _pipWindow?.close?.(); } catch {}
  _pipWindow = null;
}

// -----------------------------------------------------------------------------
// Web Worker timer (resilient to tab throttling)
// -----------------------------------------------------------------------------

/**
 * Create a ticking worker that posts {type:'tick', now, seq} every `intervalMs`.
 * @param {number} intervalMs
 * @param {(msg:{type:'tick', now:number, seq:number})=>void} onTick
 * @returns {{ terminate: Function }}
 */
export function createTickWorker(intervalMs, onTick) {
  const blob = new Blob([`
    let seq = 0, timer = null;
    function start() {
      timer = setInterval(() => {
        seq++;
        self.postMessage({ type: 'tick', now: Date.now(), seq });
      }, ${Math.max(250, Number(intervalMs) || 1000)});
    }
    self.addEventListener('message', (e) => {
      const {type} = e.data || {};
      if (type === 'stop') { clearInterval(timer); close(); }
    });
    start();
  `], { type: 'application/javascript' });

  const worker = new Worker(URL.createObjectURL(blob));
  const handler = (e) => {
    if (e?.data?.type === 'tick') onTick?.(e.data);
  };
  worker.addEventListener('message', handler);

  return {
    terminate() {
      try { worker.postMessage({ type: 'stop' }); } catch {}
      try { worker.terminate(); } catch {}
    }
  };
}

// -----------------------------------------------------------------------------
// Persistence / Checkpoints
// -----------------------------------------------------------------------------

/**
 * Write a durable checkpoint (called every step change and ~10s while running).
 * Also emits 'session.checkpoint.written' for observers.
 * @param {string} sessionId
 * @param {SessionProgress} progress
 */
export async function writeCheckpoint(sessionId, progress) {
  if (!sessionId || !progress) return;
  try {
    if (typeof SessionsRepo.writeCheckpoint === 'function') {
      await SessionsRepo.writeCheckpoint(sessionId, progress);
    } else if (typeof SessionsRepo.updateProgress === 'function') {
      await SessionsRepo.updateProgress(sessionId, progress);
    }
    emitCheckpointWritten(sessionId, progress);
  } catch (e) {
    console.warn('[session.helpers] writeCheckpoint failed', e);
    eventBus.emit({
      type: SESSION_EVENTS.ERROR,
      ts: isoNow(),
      source: 'session.helpers',
      data: { sessionId, code: 'checkpoint.write.failed', message: String(e) }
    });
  }
}

/**
 * Mark session status and bump updatedAt. Do not throw.
 * @param {string} sessionId
 * @param {'pending'|'running'|'paused'|'completed'|'aborted'} status
 */
export async function setSessionStatus(sessionId, status) {
  try {
    if (typeof SessionsRepo.setStatus === 'function') {
      await SessionsRepo.setStatus(sessionId, status);
    } else {
      // last-resort: shallow update via get->save style if your repo uses upsert
      const s = await SessionsRepo.get(sessionId);
      if (s) {
        s.status = status;
        s.updatedAt = isoNow();
        await SessionsRepo.put?.(s); // optional upsert
      }
    }
  } catch (e) {
    console.warn('[session.helpers] setSessionStatus failed', e);
  }
}

// -----------------------------------------------------------------------------
// Hub export (familyFundMode)
// -----------------------------------------------------------------------------

/**
 * Export a completed/aborted session payload to the Hub, if enabled.
 * Fails silently by design (per product spec).
 * @param {{ session: Session, analytics?: any, outcome: 'completed'|'aborted' }} payload
 * @returns {Promise<{ ok:boolean, hubMessageId?:string }>}
 */
export async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return { ok: false };
    if (!payload?.session?.id) return { ok: false };
    if (!HubPacketFormatter?.formatSessionPacket || !FamilyFundConnector?.send) return { ok: false };

    const envelope = HubPacketFormatter.formatSessionPacket(payload);
    const res = await FamilyFundConnector.send(envelope);
    if (res?.ok) {
      eventBus.emit({
        type: SESSION_EVENTS.EXPORTED,
        ts: isoNow(),
        source: 'session.helpers',
        data: { sessionId: payload.session.id, hubMessageId: res.id, tookMs: res.tookMs }
      });
      return { ok: true, hubMessageId: res.id };
    }
  } catch (e) {
    // Silent by contract
  }
  return { ok: false };
}

// -----------------------------------------------------------------------------
// Step safety & fallback logic
// -----------------------------------------------------------------------------

/**
 * Ensure a step object is safe to render/run.
 * @param {any} step
 * @returns {SessionStep}
 */
export function sanitizeStep(step) {
  if (!step || typeof step !== 'object') {
    return { id: 'MISSING', title: '(Missing step)', desc: '', durationSec: 0, blockers: [], metadata: {} };
  }
  return {
    id: String(step.id || 'NO_ID'),
    title: String(step.title || '(Untitled step)'),
    desc: String(step.desc || ''),
    durationSec: Number.isFinite(step.durationSec) ? step.durationSec : 0,
    blockers: Array.isArray(step.blockers) ? step.blockers : [],
    metadata: typeof step.metadata === 'object' && step.metadata ? step.metadata : {},
  };
}

/**
 * Defensive session normalizer (used by Runner prior to render).
 * @param {any} s
 * @returns {Session|null}
 */
export function sanitizeSession(s) {
  if (!s || typeof s !== 'object') return null;
  if (!s.id || !s.domain) return null;
  const steps = Array.isArray(s.steps) ? s.steps.map(sanitizeStep) : [];
  return {
    id: String(s.id),
    domain: String(s.domain),
    title: s.title ? String(s.title) : '',
    source: s.source || { type: 'manual', refId: null },
    steps,
    prefs: s.prefs || { voiceGuidance: false, haptic: true, autoAdvance: false },
    status: s.status || 'pending',
    progress: s.progress || { currentStepIndex: 0, elapsedSec: 0, startedAt: null, pausedAt: null },
    analytics: s.analytics || { skippedSteps: [], adjustments: [] },
    createdAt: s.createdAt || isoNow(),
    updatedAt: s.updatedAt || s.createdAt || isoNow(),
  };
}

// -----------------------------------------------------------------------------
// Elapsed time helpers
// -----------------------------------------------------------------------------

/**
 * Compute elapsed seconds since a given ISO timestamp (best-effort).
 * @param {string|null} iso
 * @param {number} fallbackSec
 */
export function elapsedSince(iso, fallbackSec = 0) {
  if (!iso) return fallbackSec;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return fallbackSec;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

/**
 * Increment progress.elapsedSec by dt and return a new progress object.
 * @param {SessionProgress} progress
 * @param {number} dtSec
 */
export function addElapsed(progress, dtSec) {
  const p = { ...(progress || {}), elapsedSec: Math.max(0, Math.floor((progress?.elapsedSec || 0) + (dtSec || 0))) };
  return p;
}

// -----------------------------------------------------------------------------
// Keyboard helpers (for focus-trapped modal)
// -----------------------------------------------------------------------------

/** Install global keyboard shortcuts for Runner */
export function installRunnerHotkeys({ onPauseToggle, onNext, onPrev }) {
  const handler = (e) => {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); onPauseToggle?.(); }
    if (e.key.toLowerCase() === 'n') { e.preventDefault(); onNext?.(); }
    if (e.key.toLowerCase() === 'p') { e.preventDefault(); onPrev?.(); }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}

// -----------------------------------------------------------------------------
// Small convenience for step cues (doneness hints)
// -----------------------------------------------------------------------------

/**
 * Render a brief cue line from step.metadata.
 * @param {SessionStep} step
 * @returns {string}
 */
export function cueLine(step) {
  const m = step?.metadata || {};
  const parts = [];
  if (Number.isFinite(m.tempTargetF) && m.tempTargetF > 0) parts.push(`→ ${m.tempTargetF}°F`);
  if (m.donenessCue) parts.push(String(m.donenessCue));
  if (m.cueNotes) parts.push(String(m.cueNotes));
  return parts.join(' • ');
}

// -----------------------------------------------------------------------------
// Example: best-effort focus trap helpers for the Runner modal
// -----------------------------------------------------------------------------

/**
 * Trap focus within a container (basic implementation).
 * @param {HTMLElement} root
 * @returns {() => void} cleanup
 */
export function trapFocus(root) {
  const selectable = () => Array.from(root.querySelectorAll('a,button,input,textarea,select,[tabindex]:not([tabindex="-1"])'))
    .filter(/** @param {HTMLElement} n */ (n) => !n.hasAttribute('disabled') && !n.getAttribute('aria-hidden'));
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = selectable();
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  root.addEventListener('keydown', onKey);
  return () => root.removeEventListener('keydown', onKey);
}
