// File: src/components/ui/use-toast.jsx
// SSA UI: dependency-free toast hook + imperative API
// Compatible with React 18/19. Designed to be used with a renderer (e.g., src/ui/Toasts/ToastBus.jsx).
//
// Usage (anywhere):
//   import { toast, useToast } from "@/components/ui/use-toast";
//   toast({ title: "Saved", description: "Meal plan updated." });
//
// In a UI component:
//   const { toasts, dismiss, toast } = useToast();
//   ...render toasts...

import * as React from "react";

/** Tiny className joiner */
function cn(...parts) {
  return parts
    .flatMap((p) => (Array.isArray(p) ? p : [p]))
    .filter(Boolean)
    .join(" ");
}

/**
 * Toast shape
 * - id: string
 * - title?: ReactNode
 * - description?: ReactNode
 * - action?: ReactNode (button/link etc)
 * - duration?: number (ms) default 5000
 * - variant?: "default" | "destructive" | "success" | "warning" | "info"
 * - className?: string
 * - open?: boolean
 * - onOpenChange?: (open:boolean)=>void
 */
const TOAST_LIMIT = 6;
const DEFAULT_DURATION = 5000;

function genId() {
  // reasonably unique for UI use
  return (
    "t_" + Math.random().toString(36).slice(2) + "_" + Date.now().toString(36)
  );
}

/** Internal reducer + store (inspired by shadcn, simplified) */
const ACTIONS = {
  ADD: "ADD_TOAST",
  UPDATE: "UPDATE_TOAST",
  DISMISS: "DISMISS_TOAST",
  REMOVE: "REMOVE_TOAST",
  CLEAR: "CLEAR_TOASTS",
};

function reducer(state, action) {
  switch (action.type) {
    case ACTIONS.ADD: {
      const next = [action.toast, ...state.toasts].slice(0, TOAST_LIMIT);
      return { ...state, toasts: next };
    }
    case ACTIONS.UPDATE: {
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === action.toast.id ? { ...t, ...action.toast } : t
        ),
      };
    }
    case ACTIONS.DISMISS: {
      const id = action.id;
      // mark open=false; removal happens via timeout
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          !id || t.id === id ? { ...t, open: false } : t
        ),
      };
    }
    case ACTIONS.REMOVE: {
      const id = action.id;
      return {
        ...state,
        toasts: id ? state.toasts.filter((t) => t.id !== id) : [],
      };
    }
    case ACTIONS.CLEAR: {
      return { ...state, toasts: [] };
    }
    default:
      return state;
  }
}

const listeners = new Set();
let memoryState = { toasts: [] };

// timeouts for removal after close
const removeTimeouts = new Map();

function emit() {
  for (const l of listeners) l(memoryState);
}

function dispatch(action) {
  memoryState = reducer(memoryState, action);
  emit();
}

function scheduleRemove(id, delay = 300) {
  // avoid duplicate timers
  if (removeTimeouts.has(id)) return;
  const t = setTimeout(() => {
    removeTimeouts.delete(id);
    dispatch({ type: ACTIONS.REMOVE, id });
  }, Math.max(0, delay));
  removeTimeouts.set(id, t);
}

function cancelRemove(id) {
  const t = removeTimeouts.get(id);
  if (t) {
    clearTimeout(t);
    removeTimeouts.delete(id);
  }
}

/**
 * Imperative toast() API
 * Returns controls for updating/dismissing.
 */
export function toast(opts = {}) {
  const id = opts.id || genId();
  const duration =
    typeof opts.duration === "number" ? opts.duration : DEFAULT_DURATION;

  // If updating an existing toast id, treat it as update
  const existing = memoryState.toasts.find((t) => t.id === id);

  const toastObj = {
    id,
    title: opts.title,
    description: opts.description,
    action: opts.action,
    variant: opts.variant || "default",
    className: opts.className,
    duration,
    open: true,
    // Hook for UI components that want to drive close behavior.
    onOpenChange: (open) => {
      if (!open) dismiss(id);
      if (typeof opts.onOpenChange === "function") opts.onOpenChange(open);
    },
    // Anything extra caller wants to attach
    meta: opts.meta,
  };

  if (existing) {
    // reopen + update
    cancelRemove(id);
    dispatch({ type: ACTIONS.UPDATE, toast: { ...toastObj, open: true } });
  } else {
    dispatch({ type: ACTIONS.ADD, toast: toastObj });
  }

  // auto-dismiss timer
  if (duration > 0) {
    window.setTimeout(() => {
      // dismiss first (sets open=false)
      dismiss(id);
    }, duration);
  }

  const update = (next = {}) =>
    dispatch({ type: ACTIONS.UPDATE, toast: { id, ...next } });

  const dismissOne = () => dismiss(id);

  return { id, update, dismiss: dismissOne };
}

/**
 * Dismiss by id or all if no id provided.
 * Note: we also schedule actual removal (for exit animation time).
 */
export function dismiss(id) {
  if (id) {
    dispatch({ type: ACTIONS.DISMISS, id });
    scheduleRemove(id, 350);
  } else {
    // dismiss all then remove all after delay
    dispatch({ type: ACTIONS.DISMISS });
    for (const t of memoryState.toasts) scheduleRemove(t.id, 350);
  }
}

/** Remove immediately (no animation wait) */
export function removeToast(id) {
  if (id) {
    cancelRemove(id);
    dispatch({ type: ACTIONS.REMOVE, id });
  }
}

/** Clear store immediately */
export function clearToasts() {
  for (const t of memoryState.toasts) cancelRemove(t.id);
  dispatch({ type: ACTIONS.CLEAR });
}

/**
 * Hook for React components to consume the toast store.
 * Returns: { toasts, toast, dismiss, remove, clear }
 */
export function useToast() {
  const [state, setState] = React.useState(memoryState);

  React.useEffect(() => {
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);

  return React.useMemo(
    () => ({
      toasts: state.toasts,
      toast,
      dismiss,
      remove: removeToast,
      clear: clearToasts,
      cn, // exported for convenience if you want it in your toast renderer
    }),
    [state.toasts]
  );
}

export default useToast;
