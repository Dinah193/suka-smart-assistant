// src/hooks/useMediaSession.js
import { useCallback, useEffect, useMemo, useRef } from "react";

/**
 * useMediaSession — Lock-screen / earbuds transport integration via Media Session API.
 *
 * Purpose in SSA:
 * - Lets Cooking Play/Remote (and other domains in the future) expose prev/next/play/pause
 *   on the OS lock screen, notification shade, car UI, and earbuds.
 * - Emits standard envelopes { type, ts, source, data } onto the shared eventBus so the
 *   automation runtime can observe user intent (e.g., next step, toggle timer).
 * - Optional Hub mirroring (familyFundMode) is supported but disabled by default.
 *
 * Fits the pipeline: execution → automation (no direct household data mutation).
 *
 * API
 *   const api = useMediaSession({
 *     enabled = true,
 *     hubSync = false,
 *     metadata,                 // { title, artist, album, artwork: [{src,sizes,type}] }
 *     getPositionState,         // () => ({ duration, position, playbackRate })
 *     onPlay, onPause, onStop,
 *     onNext, onPrev,
 *     onSeekTo,                 // (seconds)
 *     onSeekRel,                // (deltaSeconds) for seekforward/seekbackward
 *   })
 *
 *   api.setMetadata(meta)
 *   api.setPlaybackState("playing" | "paused" | "none")
 *   api.setPositionState({ duration, position, playbackRate })
 *   api.clear()
 */

// ---------------- safe requires (no hard deps at import time) ----------------
let eventBus = { emit: (...a) => console.debug("[useMediaSession:eventBus.emit]", ...a) };
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let featureFlags = {};
try {
  featureFlags = require("@/config/featureFlags.json");
} catch {}

let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter")?.default;
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector")?.default;
} catch {}

// ---------------- internals ----------------
const isoNow = () => new Date().toISOString();
const hasMediaSession = () =>
  typeof navigator !== "undefined" && navigator.mediaSession && typeof navigator.mediaSession === "object";

function emitEvent(type, data = {}) {
  const payload = { type, ts: isoNow(), source: "hooks.useMediaSession", data };
  try {
    eventBus.emit?.(type, payload);
  } catch {}
  return payload;
}

async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch {
    // silent by design
  }
}

// Normalize artwork to spec array
function normalizeArtwork(artwork) {
  if (!artwork) return undefined;
  if (Array.isArray(artwork)) return artwork;
  if (typeof artwork === "string") return [{ src: artwork, sizes: "512x512", type: "image/png" }];
  if (artwork?.src) return [artwork];
  return undefined;
}

// Build MediaMetadata safely
function buildMetadata(meta) {
  if (!meta) return null;
  const { title, artist, album, artwork } = meta;
  try {
    // eslint-disable-next-line no-undef
    return new window.MediaMetadata({
      title: title ?? "Suka Smart Assistant",
      artist: artist ?? "",
      album: album ?? "",
      artwork: normalizeArtwork(artwork),
    });
  } catch {
    return null;
  }
}

// ---------------- hook ----------------
export default function useMediaSession(opts = {}) {
  const {
    enabled = true,
    hubSync = false,
    metadata = null,
    getPositionState, // () => ({ duration, position, playbackRate })
    onPlay,
    onPause,
    onStop,
    onNext,
    onPrev,
    onSeekTo, // (seconds)
    onSeekRel, // (deltaSeconds)
  } = opts;

  const supported = useMemo(() => hasMediaSession(), []);
  const metaRef = useRef(metadata || null);
  const getPosRef = useRef(getPositionState);

  // keep latest callbacks
  const cb = useRef({
    onPlay,
    onPause,
    onStop,
    onNext,
    onPrev,
    onSeekTo,
    onSeekRel,
  });
  useEffect(() => {
    cb.current = { onPlay, onPause, onStop, onNext, onPrev, onSeekTo, onSeekRel };
  }, [onPlay, onPause, onStop, onNext, onPrev, onSeekTo, onSeekRel]);

  useEffect(() => {
    getPosRef.current = getPositionState;
  }, [getPositionState]);

  // -- helpers exposed to consumer --
  const setMetadata = useCallback((meta) => {
    if (!supported || !enabled) return;
    metaRef.current = meta;
    const built = buildMetadata(meta);
    if (!built) return;
    try {
      navigator.mediaSession.metadata = built;
      const e = emitEvent("play.mediaSession.metadata.set", {
        title: meta?.title,
        album: meta?.album,
        artist: meta?.artist,
      });
      if (hubSync) exportToHubIfEnabled(e);
    } catch (err) {
      emitEvent("play.mediaSession.error", { phase: "setMetadata", message: String(err?.message || err) });
    }
  }, [supported, enabled, hubSync]);

  const setPlaybackState = useCallback((state = "none") => {
    if (!supported || !enabled) return;
    try {
      navigator.mediaSession.playbackState = state; // "playing" | "paused" | "none"
      emitEvent("play.mediaSession.state", { state });
    } catch (err) {
      emitEvent("play.mediaSession.error", { phase: "setPlaybackState", message: String(err?.message || err) });
    }
  }, [supported, enabled]);

  const setPositionState = useCallback((pos) => {
    if (!supported || !enabled || !navigator.mediaSession.setPositionState) return;
    if (!pos || typeof pos.duration !== "number" || typeof pos.position !== "number") return;
    try {
      navigator.mediaSession.setPositionState({
        duration: Math.max(0, pos.duration),
        position: Math.max(0, pos.position),
        playbackRate: typeof pos.playbackRate === "number" ? pos.playbackRate : 1,
      });
    } catch (err) {
      emitEvent("play.mediaSession.error", { phase: "setPositionState", message: String(err?.message || err) });
    }
  }, [supported, enabled]);

  const clear = useCallback(() => {
    if (!supported) return;
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
      // Clear handlers (no official clear; set to null)
      const acts = [
        "play",
        "pause",
        "stop",
        "previoustrack",
        "nexttrack",
        "seekto",
        "seekbackward",
        "seekforward",
      ];
      acts.forEach((a) => {
        try {
          navigator.mediaSession.setActionHandler(a, null);
        } catch {}
      });
      emitEvent("play.mediaSession.cleared", {});
    } catch (err) {
      emitEvent("play.mediaSession.error", { phase: "clear", message: String(err?.message || err) });
    }
  }, [supported]);

  // -- main effect: wire handlers --
  useEffect(() => {
    if (!supported || !enabled) return;

    // initial metadata (if provided)
    if (metadata) {
      try {
        setMetadata(metadata);
      } catch {}
    }

    const safe = (fn, action, data = {}) => async () => {
      const evt = emitEvent("play.transport.action", { action, ...data });
      if (hubSync) exportToHubIfEnabled(evt);
      try {
        if (typeof fn === "function") {
          await fn(data?.position ?? data?.seekTime ?? data?.delta ?? undefined);
        }
      } catch (err) {
        emitEvent("play.mediaSession.error", { phase: action, message: String(err?.message || err) });
      }
    };

    // Core transport
    try {
      navigator.mediaSession.setActionHandler("play", safe(cb.current.onPlay, "play"));
    } catch {}
    try {
      navigator.mediaSession.setActionHandler("pause", safe(cb.current.onPause, "pause"));
    } catch {}
    try {
      navigator.mediaSession.setActionHandler("stop", safe(cb.current.onStop, "stop"));
    } catch {}
    try {
      navigator.mediaSession.setActionHandler("previoustrack", safe(cb.current.onPrev, "prev"));
    } catch {}
    try {
      navigator.mediaSession.setActionHandler("nexttrack", safe(cb.current.onNext, "next"));
    } catch {}

    // Seeking
    try {
      navigator.mediaSession.setActionHandler(
        "seekto",
        safe(
          (seekEvt) => {
            const pos = seekEvt?.seekTime ?? seekEvt?.position;
            return cb.current.onSeekTo?.(typeof pos === "number" ? pos : 0);
          },
          "seekto",
          /* data on emit comes from the event object at call time; see wrapper below */
        )
      );
    } catch {}

    try {
      navigator.mediaSession.setActionHandler(
        "seekforward",
        safe(() => cb.current.onSeekRel?.(10), "seekforward", { delta: 10 })
      );
    } catch {}
    try {
      navigator.mediaSession.setActionHandler(
        "seekbackward",
        safe(() => cb.current.onSeekRel?.(-10), "seekbackward", { delta: -10 })
      );
    } catch {}

    // Keep position state fresh (if provided)
    let rafId = null;
    const tick = () => {
      if (!enabled) return;
      const pos = typeof getPosRef.current === "function" ? getPosRef.current() : null;
      if (pos && navigator.mediaSession.setPositionState) {
        try {
          navigator.mediaSession.setPositionState({
            duration: Number(pos.duration) || 0,
            position: Number(pos.position) || 0,
            playbackRate: Number(pos.playbackRate) || 1,
          });
        } catch {}
      }
      rafId = window.requestAnimationFrame(tick);
    };
    if (typeof window !== "undefined" && typeof getPosRef.current === "function") {
      rafId = window.requestAnimationFrame(tick);
    }

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      // Do not clear handlers on unmount if another feature might re-use them immediately?
      // We still clear to avoid stale callbacks.
      try {
        navigator.mediaSession.setActionHandler("play", null);
        navigator.mediaSession.setActionHandler("pause", null);
        navigator.mediaSession.setActionHandler("stop", null);
        navigator.mediaSession.setActionHandler("previoustrack", null);
        navigator.mediaSession.setActionHandler("nexttrack", null);
        navigator.mediaSession.setActionHandler("seekto", null);
        navigator.mediaSession.setActionHandler("seekforward", null);
        navigator.mediaSession.setActionHandler("seekbackward", null);
      } catch {}
    };
  }, [supported, enabled, hubSync, setMetadata, metadata]);

  return {
    supported,
    setMetadata,
    setPlaybackState,
    setPositionState,
    clear,
  };
}
