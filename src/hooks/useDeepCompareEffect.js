// src/hooks/useDeepCompareEffect.js
import { useEffect, useRef, useMemo, useCallback } from "react";
import isEqual from "lodash.isequal";

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

function useLatestRef(value) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function toArray(v) {
  return Array.isArray(v) ? v : [v];
}

/**
 * Creates a "signal" that only bumps when `deps` change by deep equality.
 * - comparator: (a, b) => boolean
 * - maxSignal: prevent unbounded growth over very long sessions
 */
function useDeepCompareSignal(deps, { comparator = isEqual, maxSignal = 1e9 } = {}) {
  const lastDepsRef = useRef();
  const signalRef = useRef(0);

  // Distinct check (deep)
  if (!comparator(lastDepsRef.current, deps)) {
    lastDepsRef.current = deps;
    signalRef.current = (signalRef.current + 1) % maxSignal;
  }
  return signalRef.current;
}

/**
 * Returns a stable reference to `deps` that only updates when deep-changed.
 * Useful when a 3rd-party hook doesn't accept a "signal" but needs a deps array.
 */
export function useStableDeepDeps(deps, options) {
  const lastRef = useRef(deps);
  const signal = useDeepCompareSignal(deps, options);

  // When signal ticks, adopt the latest deps object reference
  if (signal !== useRef(signal).current) {
    lastRef.current = deps;
  }
  // Freeze in dev to catch accidental mutation
  if (process.env.NODE_ENV !== "production") {
    try {
      // Shallow freeze the array reference; content may still be objects.
      Object.freeze(lastRef.current);
    } catch {
      /* noop */
    }
  }
  return lastRef.current;
}

/* -----------------------------------------------------------------------------
 * Deep-compare hooks
 * -------------------------------------------------------------------------- */

/**
 * useDeepCompareEffect(effect, deps, options?)
 * - Works like useEffect but compares deps by deep-equality.
 * - Keeps the latest effect via ref, so identity changes of `effect`
 *   don't retrigger unless deps deep-change.
 *
 * options:
 *  - areEqual?: (a,b) => boolean (default: lodash.isequal)
 *  - debugLabel?: string (for dev logging)
 *  - maxSignal?: number (cap the internal counter)
 */
export function useDeepCompareEffect(effect, dependencies, options = {}) {
  if (process.env.NODE_ENV !== "production" && !Array.isArray(dependencies)) {
    // eslint-disable-next-line no-console
    console.warn(
      "useDeepCompareEffect: expected dependencies to be an array, received:",
      dependencies
    );
  }

  const { areEqual = isEqual, debugLabel, maxSignal } = options;

  // Always hold latest effect (React 18-safe)
  const effectRef = useLatestRef(effect);

  // Build a distinct-change signal
  const signal = useDeepCompareSignal(dependencies, {
    comparator: areEqual,
    maxSignal,
  });

  // Optional dev trace
  if (process.env.NODE_ENV !== "production" && debugLabel) {
    const prevSigRef = useRef(signal);
    if (prevSigRef.current !== signal) {
      // eslint-disable-next-line no-console
      console.debug(`[useDeepCompareEffect:${debugLabel}] deps changed (signal=${signal})`);
      prevSigRef.current = signal;
    }
  }

  useEffect(() => {
    // Invoke the latest effect; support cleanup
    return effectRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal]);
}

/**
 * useDeepCompareMemo(factory, deps, options?)
 * - Deep-comparing version of useMemo.
 */
export function useDeepCompareMemo(factory, dependencies, options = {}) {
  const factoryRef = useLatestRef(factory);
  const signal = useDeepCompareSignal(dependencies, {
    comparator: options.areEqual || isEqual,
    maxSignal: options.maxSignal,
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => factoryRef.current(), [signal]);
}

/**
 * useDeepCompareCallback(callback, deps, options?)
 * - Deep-comparing version of useCallback.
 */
export function useDeepCompareCallback(callback, dependencies, options = {}) {
  // We memoize the *callback* only when deep deps change.
  return useDeepCompareMemo(() => callback, dependencies, options);
}

/* -----------------------------------------------------------------------------
 * Default export (backward compatible)
 * -------------------------------------------------------------------------- */

export default useDeepCompareEffect;
