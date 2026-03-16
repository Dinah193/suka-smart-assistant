/**
 * src/features/session/session.pip.js
 * -----------------------------------------------------------------------------
 * Document Picture-in-Picture (PiP) Mini HUD for SessionRunner
 *
 * Purpose:
 * - Provide an “always-on-top” mini controller (where supported) that shows:
 *   timer, step title, progress, and controls (Prev, Pause/Resume, Next, Close).
 *
 * How it fits:
 * - SessionRunner (and domain Play pages) call this service to open/update/close
 *   a PiP HUD while a session is running. The HUD communicates with the opener
 *   via postMessage; this module relays actions to eventBus and (optionally)
 *   mirrors to Family Fund Hub.
 *
 * Events emitted (payload: { type, ts, source, data }):
 * - ui.pip.opened
 * - ui.pip.updated
 * - ui.pip.closed
 * - ui.pip.focused
 * - ui.pip.unsupported
 * - ui.pip.action   (data.action: "prev"|"pause"|"resume"|"next"|"close")
 * - ui.pip.error
 *
 * Resilience:
 * - Fails gracefully when PiP API unsupported (no-ops + event).
 * - Rebuilds HUD after accidental reload (caller can call `restoreIfPossible()`).
 * - Defensive guards around window messaging and lifecycle.
 *
 * Public API:
 *   import pip from "@/features/session/session.pip";
 *   if (pip.supported()) await pip.open(session);
 *   await pip.update(session, step, { paused, elapsedSec });
 *   await pip.setPaused(true|false);
 *   pip.focus();
 *   pip.close();
 *
 * Notes:
 * - This uses Document Picture-in-Picture (Chromium-only today). On unsupported
 *   browsers, callers should simply continue without PiP. The SessionRunner UI
 *   remains the primary control surface.
 * -----------------------------------------------------------------------------
 */

import eventBus from "@/services/events/eventBus";
import { featureFlags } from "@/config/featureFlags";

let HubPacketFormatter = null;
let FamilyFundConnector = null;
(async () => {
  try {
    const m1 = await import("@/services/hub/HubPacketFormatter");
    const m2 = await import("@/services/hub/FamilyFundConnector");
    HubPacketFormatter = m1?.default || null;
    FamilyFundConnector = m2?.default || null;
  } catch {
    /* no-op */
  }
})();

const SOURCE = "features.session.pip";
const isoNow = () => new Date().toISOString();

function emit(type, data = {}) {
  const payload = { type, ts: isoNow(), source: SOURCE, data };
  try {
    eventBus?.emit?.(payload);
  } catch {
    /* no-op */
  }
  if (featureFlags?.familyFundMode) exportToHubIfEnabled(payload);
  return payload;
}

async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch {
    /* silent */
  }
}

function apiSupported() {
  try {
    return (
      typeof window !== "undefined" && "documentPictureInPicture" in window
    );
  } catch {
    return false;
  }
}

/* --------------------------------- State ---------------------------------- */

let pipWindow = null; // The PiP window handle
let lastState = null; // Cached state for redraws/restores
let actionListenerBound = false;

/**
 * Normalize values and cache the current state.
 * @param {object} s
 */
function setState(s = {}) {
  lastState = {
    sessionId: s.sessionId ?? null,
    title: s.title ?? "Session",
    stepTitle: s.stepTitle ?? "",
    stepIdx: Number.isFinite(+s.stepIdx) ? +s.stepIdx : 0,
    totalSteps: Number.isFinite(+s.totalSteps) ? +s.totalSteps : 0,
    paused: !!s.paused,
    elapsedSec: Number.isFinite(+s.elapsedSec) ? +s.elapsedSec : 0,
    cue: s.cue || null, // e.g., donenessCue or temp
    tempTargetF: Number.isFinite(+s.tempTargetF) ? +s.tempTargetF : null,
  };
}

/* -------------------------- PiP Window Template --------------------------- */

function pipHtml() {
  // Minimal, readable HUD; styles are inlined for portability.
  return /* html */ `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>SSA Mini HUD</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      --bg: #0b1020; --fg: #eaf2ff; --muted:#93a1b5; --accent:#6aa0ff; --warn:#ffcc66; --danger:#ff7a7a;
    }
    html, body { margin:0; padding:0; background:var(--bg); color:var(--fg); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Apple Color Emoji", "Segoe UI Emoji"; }
    .wrap { display:grid; grid-template-rows: auto 1fr auto; min-height:100vh; gap:8px; padding:12px; box-sizing:border-box;}
    .title { font-weight:600; letter-spacing:.2px; font-size:14px; color:var(--muted); text-overflow:ellipsis; white-space:nowrap; overflow:hidden;}
    .step { font-weight:700; font-size:16px; line-height:1.2; text-overflow:ellipsis; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;}
    .bar { display:flex; align-items:center; gap:8px; }
    .progress { flex:1; height:6px; border-radius:999px; background:rgba(255,255,255,.08); overflow:hidden;}
    .progress > span { display:block; height:100%; width:0%; background:linear-gradient(90deg, var(--accent), #9ad0ff);}
    .timer { font-variant-numeric: tabular-nums; font-weight:600; }
    .cue { font-size:12px; color: var(--warn); }
    .controls { display:grid; grid-template-columns: repeat(4, 1fr); gap:8px; }
    button { appearance:none; border:1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.06); color:var(--fg);
      border-radius:10px; padding:8px 6px; font-weight:600; cursor:pointer; }
    button:hover { background: rgba(255,255,255,.12); }
    .danger { border-color: rgba(255,122,122,.4); color:#fff; }
    .pill { border-radius:999px; padding:2px 8px; font-size:11px; background:rgba(255,255,255,.08); color:var(--muted);}
    .row { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="row">
      <div class="title" id="title">Session</div>
      <div class="pill" id="stepCount">0/0</div>
    </div>

    <div>
      <div class="step" id="stepTitle">Step title</div>
      <div class="row" style="margin-top:8px">
        <div class="bar">
          <div class="progress" aria-hidden="true"><span id="progressFill"></span></div>
          <div class="timer" id="timer">00:00</div>
        </div>
      </div>
      <div class="cue" id="cue"></div>
    </div>

    <div class="controls">
      <button id="prevBtn" title="Previous (P)">⟵ Prev</button>
      <button id="pauseBtn" title="Pause (Space)">⏸ Pause</button>
      <button id="nextBtn" title="Next (N)">Next ⟶</button>
      <button id="closeBtn" class="danger" title="Close">✕ Close</button>
    </div>
  </div>

  <script>
    (function(){
      const $ = (id) => document.getElementById(id);
      const els = {
        title: $("title"),
        stepTitle: $("stepTitle"),
        stepCount: $("stepCount"),
        timer: $("timer"),
        cue: $("cue"),
        progressFill: $("progressFill"),
        pauseBtn: $("pauseBtn"),
        prevBtn: $("prevBtn"),
        nextBtn: $("nextBtn"),
        closeBtn: $("closeBtn"),
      };

      let paused = false;

      function mmss(sec) {
        sec = Math.max(0, Math.floor(sec||0));
        const m = String(Math.floor(sec/60)).padStart(2, "0");
        const s = String(sec%60).padStart(2, "0");
        return m + ":" + s;
      }

      function setPaused(p) {
        paused = !!p;
        els.pauseBtn.textContent = paused ? "▶ Resume" : "⏸ Pause";
        els.pauseBtn.title = paused ? "Resume (Space)" : "Pause (Space)";
      }

      function render(state) {
        if (!state) return;
        els.title.textContent = state.title || "Session";
        els.stepTitle.textContent = state.stepTitle || "";
        els.stepCount.textContent = (state.stepIdx+1) + "/" + (state.totalSteps || 0);
        els.timer.textContent = mmss(state.elapsedSec || 0);
        const pct = state.totalSteps ? Math.max(0, Math.min(100, Math.round(((state.stepIdx+1)/state.totalSteps)*100))) : 0;
        els.progressFill.style.width = pct + "%";
        const cueLines = [];
        if (state.cue) cueLines.push("Cue: " + state.cue);
        if (Number.isFinite(state.tempTargetF)) cueLines.push("Target: " + Math.round(state.tempTargetF) + "°F");
        els.cue.textContent = cueLines.join("  •  ");
        setPaused(!!state.paused);
      }

      function send(action) {
        try {
          window.opener?.postMessage?.({ type:"SSA_PIP_ACTION", action, ts: new Date().toISOString() }, "*");
        } catch (e) { /* ignore */ }
      }

      els.prevBtn.addEventListener("click", () => send("prev"));
      els.pauseBtn.addEventListener("click", () => send(paused ? "resume" : "pause"));
      els.nextBtn.addEventListener("click", () => send("next"));
      els.closeBtn.addEventListener("click", () => send("close"));

      window.addEventListener("keydown", (e) => {
        const key = e.key.toLowerCase();
        if (key === " " || key === "spacebar") { e.preventDefault(); send(paused ? "resume" : "pause"); }
        else if (key === "n") send("next");
        else if (key === "p") send("prev");
      });

      window.addEventListener("message", (e) => {
        const msg = e?.data || {};
        if (!msg || msg.type !== "SSA_PIP_UPDATE") return;
        render(msg.state);
      });

      window.addEventListener("beforeunload", () => {
        send("close");
      });

      // Initial handshake to request the latest state (opener should reply)
      send("focus");
    })();
  </script>
</body>
</html>
`;
}

/* ----------------------------- Window Handling ---------------------------- */

function bindGlobalActionListener() {
  if (actionListenerBound || typeof window === "undefined") return;
  actionListenerBound = true;

  window.addEventListener("message", (event) => {
    const msg = event?.data || {};
    if (!msg || msg.type !== "SSA_PIP_ACTION") return;

    const payload = emit("ui.pip.action", {
      action: msg.action,
      tsRemote: msg.ts,
    });
    // Hub mirroring handled by emit()
    // No direct control changes here; SessionRunner should respond (prev/pause/next/close/focus)
  });
}

async function createPipWindow({ width = 380, height = 220 } = {}) {
  const html = pipHtml();
  const pip = await window.documentPictureInPicture.requestWindow({
    width,
    height,
  });
  // Write content to the PiP document
  pip.document.open();
  pip.document.write(html);
  pip.document.close();
  return pip;
}

function postStateToPip() {
  if (!pipWindow || !lastState) return;
  try {
    pipWindow.postMessage({ type: "SSA_PIP_UPDATE", state: lastState }, "*");
  } catch {
    /* no-op */
  }
}

function focusPip() {
  try {
    pipWindow?.focus?.();
    emit("ui.pip.focused", {});
  } catch {
    /* no-op */
  }
}

/* --------------------------------- API ------------------------------------ */

async function open(session, opts = {}) {
  if (!apiSupported()) {
    emit("ui.pip.unsupported", {});
    return null;
  }

  bindGlobalActionListener();

  // Build initial state (minimal; can be updated after)
  const s = {
    sessionId: session?.id ?? null,
    title: session?.title ?? "Session",
    stepTitle:
      session?.steps?.[session?.progress?.currentStepIndex || 0]?.title ?? "",
    stepIdx: Number(session?.progress?.currentStepIndex || 0),
    totalSteps: Array.isArray(session?.steps) ? session.steps.length : 0,
    paused: session?.status === "paused",
    elapsedSec: Number(session?.progress?.elapsedSec || 0),
    cue:
      session?.steps?.[session?.progress?.currentStepIndex || 0]?.metadata
        ?.donenessCue ?? null,
    tempTargetF:
      session?.steps?.[session?.progress?.currentStepIndex || 0]?.metadata
        ?.tempTargetF ?? null,
  };
  setState(s);

  try {
    // If already open, just update
    if (pipWindow && !pipWindow.closed) {
      postStateToPip();
      focusPip();
      return pipWindow;
    }

    pipWindow = await createPipWindow(opts.window || {});
    pipWindow.addEventListener?.("pagehide", () => {
      /* pagehide fires on close */ close();
    });
    pipWindow.addEventListener?.("unload", () => {
      close();
    });

    postStateToPip();

    const payload = emit("ui.pip.opened", { sessionId: s.sessionId });
    // hub mirrored by emit()
    return pipWindow;
  } catch (err) {
    emit("ui.pip.error", {
      phase: "open",
      message: String(err?.message || err),
    });
    return null;
  }
}

/**
 * Update HUD with latest session/step/progress.
 * Call after every step change and ~10s tick (to mirror SessionRunner checkpoints).
 */
async function update(session, step, { paused, elapsedSec } = {}) {
  if (!apiSupported() || !pipWindow || pipWindow.closed) return false;

  const idx = Number(session?.progress?.currentStepIndex || 0);
  const total = Array.isArray(session?.steps) ? session.steps.length : 0;

  setState({
    sessionId: session?.id ?? lastState?.sessionId,
    title: session?.title ?? lastState?.title,
    stepTitle:
      step?.title ?? session?.steps?.[idx]?.title ?? lastState?.stepTitle,
    stepIdx: Number.isFinite(idx) ? idx : lastState?.stepIdx || 0,
    totalSteps: total || lastState?.totalSteps || 0,
    paused: typeof paused === "boolean" ? paused : !!lastState?.paused,
    elapsedSec: Number.isFinite(+elapsedSec)
      ? +elapsedSec
      : Number(session?.progress?.elapsedSec) || lastState?.elapsedSec || 0,
    cue:
      step?.metadata?.donenessCue ??
      session?.steps?.[idx]?.metadata?.donenessCue ??
      lastState?.cue ??
      null,
    tempTargetF: Number.isFinite(+step?.metadata?.tempTargetF)
      ? +step.metadata.tempTargetF
      : Number.isFinite(+session?.steps?.[idx]?.metadata?.tempTargetF)
      ? +session.steps[idx].metadata.tempTargetF
      : lastState?.tempTargetF ?? null,
  });

  try {
    postStateToPip();
    emit("ui.pip.updated", {
      sessionId: lastState.sessionId,
      stepIdx: lastState.stepIdx,
      totalSteps: lastState.totalSteps,
      paused: lastState.paused,
      elapsedSec: lastState.elapsedSec,
    });
    return true;
  } catch (err) {
    emit("ui.pip.error", {
      phase: "update",
      message: String(err?.message || err),
    });
    return false;
  }
}

async function setPaused(p) {
  if (!apiSupported() || !pipWindow || pipWindow.closed) return false;
  setState({ ...(lastState || {}), paused: !!p });
  postStateToPip();
  return true;
}

function isOpen() {
  return !!(pipWindow && !pipWindow.closed);
}

function restoreIfPossible() {
  // No automatic re-creation (requires user gesture in some browsers). Caller
  // can decide to call open() again; we keep lastState for immediate hydration.
  return !!lastState;
}

function focus() {
  if (!apiSupported() || !pipWindow || pipWindow.closed) return false;
  focusPip();
  return true;
}

function close() {
  if (!pipWindow) return;
  try {
    pipWindow.close?.();
  } catch {
    /* ignore */
  }
  pipWindow = null;
  emit("ui.pip.closed", { sessionId: lastState?.sessionId ?? null });
}

/* -------------------------------- Exports --------------------------------- */

const pip = {
  supported: apiSupported,
  open,
  update,
  setPaused,
  isOpen,
  focus,
  close,
  restoreIfPossible,
};

export default pip;

/* --------------------------------- Usage -----------------------------------
 * // In SessionRunner controller:
 * import pip from "@/features/session/session.pip";
 *
 * if (pip.supported()) {
 *   await pip.open(session); // when session starts
 * }
 *
 * // On each step transition / 10s checkpoint tick:
 * await pip.update(session, currentStep, { paused: session.status === "paused", elapsedSec: session.progress.elapsedSec });
 *
 * // Toggle pause:
 * await pip.setPaused(true|false);
 *
 * // On session end:
 * pip.close();
 *
 * // Listen for actions (pause/next/prev/close) via eventBus:
 * // event payload shape: { type, ts, source: "features.session.pip", data: { action } }
 * -------------------------------------------------------------------------- */
