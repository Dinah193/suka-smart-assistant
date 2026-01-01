/**
 * src/hooks/useWakeLock.js
 * -----------------------------------------------------------------------------
 * React hook over the Wake Lock service.
 *
 * What it does in SSA:
 * - Provides SessionRunner/Play pages a reliable way to keep the screen awake.
 * - Emits standard event envelopes (done in the service).
 * - Optionally mirrors engagement to the Hub (service handles familyFundMode).
 *
 * API:
 *   const {
 *     supported, active, requesting, error, reason,
 *     setReason, request, release, toggle
 *   } = useWakeLock({ auto = true, reason = "cooking-session", hubSync = false })
 *
 * Behavior:
 * - On mount (if auto && supported) it tries to acquire after a brief delay.
 * - Re-acquires on visibility change if the user still “wants” the lock.
 * - Cleans up on unmount (best-effort release).
 * -----------------------------------------------------------------------------
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import wakelock from "@/services/wakelock";

export default function useWakeLock(options = {}) {
  const { auto = true, reason: initialReason = "cooking-session", hubSync = false } = options;

  const [supported] = useState(() => wakelock.supported());
  const [active, setActive] = useState(wakelock.state().active);
  const [requesting, setRequesting] = useState(wakelock.state().requesting);
  const [error, setError] = useState(wakelock.state().error);
  const [reason, setReason] = useState(initialReason);

  // Keep latest hubSync in a ref for visibility-change reacquire path.
  const hubSyncRef = useRef(!!hubSync);
  useEffect(() => { hubSyncRef.current = !!hubSync; }, [hubSync]);

  // Keep service "want" updated when reason changes.
  useEffect(() => {
    // Mark intent but do not acquire yet (lets caller call request() explicitly).
    wakelock.want(reason);
  }, [reason]);

  const syncFromService = useCallback(() => {
    const s = wakelock.state();
    setActive(s.active);
    setRequesting(s.requesting);
    setError(s.error || null);
  }, []);

  const request = useCallback(async () => {
    const ok = await wakelock.acquire(reason, { hubSync: hubSyncRef.current });
    syncFromService();
    return ok;
  }, [reason, syncFromService]);

  const release = useCallback(async () => {
    const ok = await wakelock.release({ hubSync: hubSyncRef.current });
    syncFromService();
    return ok;
  }, [syncFromService]);

  const toggle = useCallback(async () => {
    const ok = await wakelock.toggle({ hubSync: hubSyncRef.current });
    syncFromService();
    return ok;
  }, [syncFromService]);

  // Auto acquire on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (auto && supported) {
        // small delay so SessionRunner can complete first paint
        await new Promise((r) => setTimeout(r, 50));
        if (!cancelled) {
          await request();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auto, supported, request]);

  // Visibility-change re-check (service already handles reacquire; we just sync UI)
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => syncFromService();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [syncFromService]);

  // Best-effort cleanup on unmount
  useEffect(() => {
    return () => {
      wakelock.release({ hubSync: hubSyncRef.current }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return useMemo(
    () => ({
      supported,
      active,
      requesting,
      error,
      reason,
      setReason,
      request,
      release,
      toggle,
    }),
    [supported, active, requesting, error, reason, request, release, toggle]
  );
}
