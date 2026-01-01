/**
 * C:\Users\larho\suka-smart-assistant\src\hooks\useIntervalWorker.js
 *
 * useIntervalWorker — React hook that wraps the sessionTimer Web Worker to provide
 * resilient, drift-aware ticking even when the tab is backgrounded. Falls back to
 * a main-thread setInterval if Worker APIs are unavailable.
 *
 * How this fits:
 * - SessionRunner mounts this hook once per active session to manage ticks,
 *   checkpoints, and step-expire notifications.
 * - The hook is transport-only; SessionRunner remains the source of truth for
 *   progress, persistence (SessionStore.checkpoint), and event emission.
 *
 * Features:
 * - Singleton worker shared across hook instances (per tab).
 * - Defensive creation with Blob fallback and main-thread fallback.
 * - Simple command API: start/pause/resume/stop/setStep/adjustDuration/nudgeElapsed/sync/getState.
 * - Callback props for TICK / CHECKPOINT / STEP_EXPIRED events.
 *
 * Contracts honored:
 * - Mirrors the message protocol of src/workers/sessionTimer.worker.js.
 * - Default checkpoint cadence is 10s but can be overridden per-start.
 *
 * © Suka Smart Assistant
 */

import { useEffect, useMemo, useRef, useState, useCallback } from "react";

/** -------------------------------------------------------------
 * Worker singleton management (safe, defensive)
 * --------------------------------------------------------------*/

/** @type {Worker|null} */
let _worker = null;

/** Resolve a URL relative to this file for bundlers that support import.meta.url */
function resolveWorkerUrl() {
  try {
    // Vite/Rollup/Webpack 5 pattern for module workers:
    // Note: if your bundler needs 'new URL(..., import.meta.url)', this is correct.
    // If using CRA/older webpack, consider worker-loader or adjust build config.
    return new URL("../workers/sessionTimer.worker.js", import.meta.url);
  } catch {
    return null;
  }
}

function createWorkerSafe() {
  if (typeof window === "undefined") return null;
  if (!("Worker" in window)) return null;
  // Reuse if already alive
  if (_worker) return _worker;

  try {
    const url = resolveWorkerUrl();
    if (url) {
      _worker = new Worker(url, { type: "module" });
      return _worker;
    }
  } catch {
    // fall through to Blob fallback
  }

  try {
    // Blob fallback: inlined importScripts path; works when module workers are not available.
    const blob = new Blob(
      [
        `
        // Lightweight proxy to the real worker via importScripts (classic worker).
        // Adjust the path below if your build outputs to a different location.
        try {
          importScripts('/src/workers/sessionTimer.worker.js');
        } catch (e) {
          // Final fallback: no-op worker that just replies PONG and logs
          onmessage = (ev) => {
            const msg = ev?.data || {};
            if (msg.type === 'PING') postMessage({ type: 'PONG', ts: new Date().toISOString() });
          };
        }
      `,
      ],
      { type: "application/javascript" }
    );
    const url = URL.createObjectURL(blob);
    _worker = new Worker(url);
    return _worker;
  } catch {
    return null;
  }
}

/** -------------------------------------------------------------
 * Fallback interval engine (runs on main thread if no worker)
 * Matches a subset of worker protocol for TICK/CHECKPOINT/EXPIRE.
 * --------------------------------------------------------------*/

/**
 * @typedef {Object} FallbackEngineState
 * @property {string} id
 * @property {'idle'|'running'|'paused'|'stopped'} status
 * @property {number} elapsedSec
 * @property {number} stepIndex
 * @property {number} stepDurationSec
 * @property {number} stepElapsedSec
 * @property {number} checkpointEverySec
 * @property {number|null} handle
 * @property {boolean} expiredFired
 */

const fallbackBus = (() => {
  /** @type {Record<string, (data:any)=>void>} */
  const listeners = {};
  let seq = 0;
  return {
    on(fn) {
      const id = `l${++seq}`;
      listeners[id] = fn;
      return () => delete listeners[id];
    },
    emit(data) {
      for (const k of Object.keys(listeners)) {
        try { listeners[k](data); } catch {}
      }
    },
  };
})();

/** @type {Map<string, FallbackEngineState>} */
const fallbackMap = new Map();

function fallbackDispatch(msg) {
  const type = msg?.type;
  const id = msg?.id;
  let s = fallbackMap.get(id);
  const ISO = () => new Date().toISOString();

  function ensure() {
    if (!s) {
      s = {
        id,
        status: "idle",
        elapsedSec: 0,
        stepIndex: 0,
        stepDurationSec: 0,
        stepElapsedSec: 0,
        checkpointEverySec: 10,
        handle: null,
        expiredFired: false,
      };
      fallbackMap.set(id, s);
    }
  }

  function startLoop() {
    if (s.handle) return;
    let checkpointMs = 0;
    s.handle = window.setInterval(() => {
      if (s.status !== "running") return;
      s.elapsedSec += 1;
      if (s.stepDurationSec > 0) s.stepElapsedSec += 1;
      checkpointMs += 1000;

      const remaining = s.stepDurationSec > 0 ? Math.max(0, s.stepDurationSec - s.stepElapsedSec) : null;
      fallbackBus.emit({
        type: "TICK",
        id: s.id,
        elapsedSec: s.elapsedSec,
        stepElapsedSec: s.stepElapsedSec,
        stepRemainingSec: remaining,
        stepIndex: s.stepIndex,
        ts: ISO(),
      });

      if (s.stepDurationSec > 0 && remaining === 0 && !s.expiredFired) {
        s.expiredFired = true;
        fallbackBus.emit({ type: "STEP_EXPIRED", id: s.id, stepIndex: s.stepIndex, ts: ISO() });
      }
      if (checkpointMs >= s.checkpointEverySec * 1000) {
        checkpointMs = 0;
        fallbackBus.emit({ type: "CHECKPOINT", id: s.id, elapsedSec: s.elapsedSec, stepIndex: s.stepIndex, ts: ISO() });
      }
    }, 1000);
  }

  switch (type) {
    case "START": {
      ensure();
      s.status = "running";
      s.elapsedSec = (msg?.elapsedSec | 0) || 0;
      s.stepIndex = msg?.stepIndex | 0;
      s.stepDurationSec = (msg?.stepDurationSec | 0) || 0;
      s.stepElapsedSec = 0;
      s.checkpointEverySec = Math.min(120, Math.max(5, (msg?.checkpointEverySec | 0) || 10));
      s.expiredFired = s.stepDurationSec === 0;
      startLoop();
      // snap tick
      fallbackBus.emit({
        type: "TICK",
        id: s.id,
        elapsedSec: s.elapsedSec,
        stepElapsedSec: s.stepElapsedSec,
        stepRemainingSec: s.stepDurationSec ? s.stepDurationSec : null,
        stepIndex: s.stepIndex,
        ts: ISO(),
      });
      break;
    }
    case "PAUSE": {
      if (!s) return;
      s.status = "paused";
      break;
    }
    case "RESUME": {
      if (!s) return;
      s.status = "running";
      startLoop();
      fallbackBus.emit({
        type: "TICK",
        id: s.id,
        elapsedSec: s.elapsedSec,
        stepElapsedSec: s.stepElapsedSec,
        stepRemainingSec: s.stepDurationSec ? Math.max(0, s.stepDurationSec - s.stepElapsedSec) : null,
        stepIndex: s.stepIndex,
        ts: ISO(),
      });
      break;
    }
    case "STOP": {
      if (!s) return;
      s.status = "stopped";
      if (s.handle) { clearInterval(s.handle); s.handle = null; }
      break;
    }
    case "SET_STEP": {
      if (!s) return;
      s.stepIndex = msg?.stepIndex | 0;
      s.stepDurationSec = (msg?.stepDurationSec | 0) || 0;
      s.stepElapsedSec = 0;
      s.expiredFired = s.stepDurationSec === 0;
      fallbackBus.emit({
        type: "TICK",
        id: s.id,
        elapsedSec: s.elapsedSec,
        stepElapsedSec: s.stepElapsedSec,
        stepRemainingSec: s.stepDurationSec ? s.stepDurationSec : null,
        stepIndex: s.stepIndex,
        ts: ISO(),
      });
      break;
    }
    case "ADJUST_DURATION": {
      if (!s) return;
      const next = Math.max(0, (s.stepDurationSec | 0) + ((msg?.deltaSec | 0) || 0));
      s.stepDurationSec = next;
      if (next === 0) s.expiredFired = true;
      fallbackBus.emit({
        type: "TICK",
        id: s.id,
        elapsedSec: s.elapsedSec,
        stepElapsedSec: s.stepElapsedSec,
        stepRemainingSec: next ? Math.max(0, next - s.stepElapsedSec) : null,
        stepIndex: s.stepIndex,
        ts: ISO(),
      });
      break;
    }
    case "NUDGE_ELAPSED": {
      if (!s) return;
      s.elapsedSec = Math.max(0, s.elapsedSec + ((msg?.deltaSec | 0) || 0));
      break;
    }
    case "SYNC": {
      ensure();
      if (msg?.status) s.status = msg.status;
      const p = msg?.progress;
      if (p) {
        if (Number.isFinite(p.currentStepIndex)) s.stepIndex = p.currentStepIndex | 0;
        if (Number.isFinite(p.elapsedSec)) s.elapsedSec = p.elapsedSec | 0;
      }
      if (Number.isFinite(msg?.stepDurationSec)) s.stepDurationSec = msg.stepDurationSec | 0;
      // snap
      fallbackBus.emit({
        type: "TICK",
        id: s.id,
        elapsedSec: s.elapsedSec,
        stepElapsedSec: s.stepElapsedSec,
        stepRemainingSec: s.stepDurationSec ? Math.max(0, s.stepDurationSec - s.stepElapsedSec) : null,
        stepIndex: s.stepIndex,
        ts: ISO(),
      });
      break;
    }
    case "GET_STATE": {
      if (!s) return;
      fallbackBus.emit({
        type: "STATE",
        id: s.id,
        state: {
          id: s.id,
          status: s.status,
          elapsedSec: s.elapsedSec,
          stepIndex: s.stepIndex,
          stepDurationSec: s.stepDurationSec,
          stepElapsedSec: s.stepElapsedSec,
          checkpointEverySec: s.checkpointEverySec,
        },
      });
      break;
    }
    case "PING": {
      fallbackBus.emit({ type: "PONG", ts: ISO() });
      break;
    }
    default:
      break;
  }
}

/** -------------------------------------------------------------
 * Hook API
 * --------------------------------------------------------------
 */

/**
 * @typedef {Object} UseIntervalWorkerOptions
 * @property {(payload:{id:string, elapsedSec:number, stepElapsedSec:number, stepRemainingSec:number|null, stepIndex:number, ts:string})=>void} [onTick]
 * @property {(payload:{id:string, elapsedSec:number, stepIndex:number, ts:string})=>void} [onCheckpoint]
 * @property {(payload:{id:string, stepIndex:number, ts:string})=>void} [onStepExpired]
 * @property {(payload:any)=>void} [onLog]
 */

/**
 * useIntervalWorker
 * @param {UseIntervalWorkerOptions} [opts]
 * @returns {{
 *   supported: boolean,
 *   usingWorker: boolean,
 *   lastTickTs: string | null,
 *   start: (args:{id:string, stepIndex:number, stepDurationSec:number, startedAtISO?:string|null, elapsedSec?:number, checkpointEverySec?:number})=>void,
 *   pause: (id:string)=>void,
 *   resume: (id:string)=>void,
 *   stop: (id:string)=>void,
 *   setStep: (id:string, stepIndex:number, stepDurationSec:number)=>void,
 *   adjustDuration: (id:string, deltaSec:number)=>void,
 *   nudgeElapsed: (id:string, deltaSec:number)=>void,
 *   sync: (id:string, payload:{status?:'running'|'paused'|'stopped'|'idle', progress?:{currentStepIndex?:number, elapsedSec?:number}, stepDurationSec?:number})=>void,
 *   getState: (id:string)=>void,
 *   ping: ()=>void
 * }}
 */
export function useIntervalWorker(opts = {}) {
  const { onTick, onCheckpoint, onStepExpired, onLog } = opts;

  // Lazy-create the worker once (module singleton)
  const worker = useMemo(() => createWorkerSafe(), []);
  const usingWorker = !!worker;
  const supported = typeof window !== "undefined" && ("Worker" in window || "setInterval" in window);

  const unsubRef = useRef(null);
  const [lastTickTs, setLastTickTs] = useState(null);

  // Bind worker/fallback message handlers
  useEffect(() => {
    if (worker) {
      const h = (ev) => {
        const msg = ev?.data || {};
        switch (msg.type) {
          case "TICK":
            setLastTickTs(msg.ts || null);
            onTick?.(msg);
            break;
          case "CHECKPOINT":
            onCheckpoint?.(msg);
            break;
          case "STEP_EXPIRED":
            onStepExpired?.(msg);
            break;
          case "LOG":
            onLog?.(msg);
            break;
          case "STATE":
            // let the caller read it from onLog for now, or extend with a dedicated callback if needed
            onLog?.({ type: "STATE", ...msg });
            break;
          case "PONG":
            onLog?.(msg);
            break;
          default:
            // ignore
            break;
        }
      };
      worker.addEventListener("message", h);
      return () => worker.removeEventListener("message", h);
    } else {
      // Fallback bus
      const unsub = fallbackBus.on((msg) => {
        switch (msg.type) {
          case "TICK":
            setLastTickTs(msg.ts || null);
            onTick?.(msg);
            break;
          case "CHECKPOINT":
            onCheckpoint?.(msg);
            break;
          case "STEP_EXPIRED":
            onStepExpired?.(msg);
            break;
          case "STATE":
          case "PONG":
            onLog?.(msg);
            break;
          default:
            break;
        }
      });
      unsubRef.current = unsub;
      return () => {
        try { unsubRef.current?.(); } catch {}
        unsubRef.current = null;
      };
    }
  }, [worker, onTick, onCheckpoint, onStepExpired, onLog]);

  // Command helpers (post to worker or fallback)
  const post = useCallback(
    (payload) => {
      if (worker) {
        try { worker.postMessage(payload); } catch {}
      } else {
        fallbackDispatch(payload);
      }
    },
    [worker]
  );

  const start = useCallback(
    ({ id, stepIndex, stepDurationSec, startedAtISO = null, elapsedSec = 0, checkpointEverySec = 10 }) => {
      if (!id) return;
      post({ type: "START", id, stepIndex, stepDurationSec, startedAtISO, elapsedSec, checkpointEverySec });
    },
    [post]
  );

  const pause = useCallback((id) => id && post({ type: "PAUSE", id }), [post]);
  const resume = useCallback((id) => id && post({ type: "RESUME", id }), [post]);
  const stop = useCallback((id) => id && post({ type: "STOP", id }), [post]);
  const setStep = useCallback((id, stepIndex, stepDurationSec) => {
    if (!id) return;
    post({ type: "SET_STEP", id, stepIndex, stepDurationSec });
  }, [post]);
  const adjustDuration = useCallback((id, deltaSec) => id && post({ type: "ADJUST_DURATION", id, deltaSec }), [post]);
  const nudgeElapsed = useCallback((id, deltaSec) => id && post({ type: "NUDGE_ELAPSED", id, deltaSec }), [post]);
  const sync = useCallback((id, payload) => id && post({ type: "SYNC", id, ...payload }), [post]);
  const getState = useCallback((id) => id && post({ type: "GET_STATE", id }), [post]);
  const ping = useCallback(() => post({ type: "PING" }), [post]);

  return {
    supported,
    usingWorker,
    lastTickTs,
    start,
    pause,
    resume,
    stop,
    setStep,
    adjustDuration,
    nudgeElapsed,
    sync,
    getState,
    ping,
  };
}

export default useIntervalWorker;
