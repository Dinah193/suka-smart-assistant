// src/utils/stableExternalStore.js
import { useEffect, useRef, useState } from "react";

/* shallow compare helper */
export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

/**
 * createExternalStoreHook({ subscribe, getState })
 * No useSyncExternalStore; simple effect-based subscription.
 * subscribe(cb) must call cb(nextStateRef) with the NEW state reference.
 */
export function createExternalStoreHook({ subscribe, getState }) {
  return function useExternalStore(selector = (s) => s, options = {}) {
    const equals = options.equals || Object.is;

    const selectorRef = useRef(selector);
    const equalsRef = useRef(equals);
    selectorRef.current = selector;
    equalsRef.current = equals;

    const [slice, setSlice] = useState(() => selector(getState()));

    useEffect(() => {
      const handle = (nextState) => {
        const nextSlice = selectorRef.current(nextState);
        setSlice((prev) => (equalsRef.current(prev, nextSlice) ? prev : nextSlice));
      };
      handle(getState());
      const unsub = subscribe(handle);
      return () => { try { unsub && unsub(); } catch {} };
    }, [subscribe, getState]);

    return slice;
  };
}
