/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\app\ErrorBoundary.jsx
import React from "react";

/**
 * ErrorBoundary — central crash guard for SSA UI
 * -----------------------------------------------------------------------------
 * PIPELINE FIT
 * Imports → Intelligence → Automation → (optional) Hub Export
 *
 * This file does not mutate household data. It:
 * - Catches render/runtime errors and shows a friendly fallback.
 * - Emits a canonical error event to the shared eventBus for analytics/telemetry.
 * - Optionally mirrors non-PII error telemetry to the Hub when familyFundMode is enabled.
 *
 * CANONICAL EVENT SHAPE { type, ts, source, data }
 *   app.error          (caught by boundary or global listeners)
 *   app.error.recovered (after user clicks "Try again" or resetKeys change)
 */

// ----------------------------- Soft Imports ---------------------------------
let eventBus = null;
try {
  eventBus =
    require("@/services/events/eventBus").default ??
    require("@/services/events/eventBus");
} catch {}

let Config = { get: (_k, fb) => fb };
try {
  Config = require("@/config").default ?? require("@/config");
} catch {}

let HubPacketFormatter = null;
try {
  HubPacketFormatter =
    require("@/services/hub/HubPacketFormatter").default ??
    require("@/services/hub/HubPacketFormatter");
} catch {}

let FamilyFundConnector = null;
try {
  FamilyFundConnector =
    require("@/services/hub/FamilyFundConnector").default ??
    require("@/services/hub/FamilyFundConnector");
} catch {}

// ------------------------------ Utilities -----------------------------------
const nowISO = () => new Date().toISOString();

/** Emit to eventBus and window for easy debugging/tools. */
function emit(type, source, data) {
  const payload = { type, ts: nowISO(), source, data };
  try {
    eventBus?.emit?.(type, payload);
    // Also mirror to the DOM event system for DevTools listeners.
    window?.dispatchEvent?.(new CustomEvent(type, { detail: payload }));
  } catch (e) {
    if (process.env.NODE_ENV !== "production")
      console.debug("[ErrorBoundary] emit failed:", e);
  }
  return payload;
}

/** Optional Hub export for telemetry; safe no-op if Hub not present or disabled. */
async function exportToHubIfEnabled(payload) {
  try {
    const flags = Config.get?.("featureFlags", {}) ?? {};
    if (!flags.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format?.(payload);
    if (!packet) return;
    await FamilyFundConnector.send?.(packet);
  } catch (e) {
    if (process.env.NODE_ENV !== "production")
      console.debug("[ErrorBoundary] hub export ignored:", e);
  }
}

/** Normalize error objects into a minimal, serializable shape. */
function toErrorData(error, extra) {
  return {
    message: String(error?.message || error),
    name: error?.name || "Error",
    stack:
      typeof error?.stack === "string"
        ? error.stack.split("\n").slice(0, 10).join("\n")
        : undefined,
    ...extra,
  };
}

// --------------------------- Global Listeners --------------------------------
/**
 * Installs window-level listeners for runtime errors and unhandled promise rejections.
 * Use once at app bootstrap (main.jsx) or mount a single <GlobalErrorListeners />.
 */
export function installGlobalErrorListeners(source = "GlobalErrorListener") {
  const onError = (e) => {
    const payload = emit(
      "app.error",
      source,
      toErrorData(e.error ?? e, {
        filename: e?.filename,
        lineno: e?.lineno,
        colno: e?.colno,
        kind: "window.error",
      })
    );
    exportToHubIfEnabled(payload);
  };

  const onRejection = (e) => {
    const reason = e?.reason ?? "unhandledrejection";
    const payload = emit(
      "app.error",
      source,
      toErrorData(reason, { kind: "unhandledrejection" })
    );
    exportToHubIfEnabled(payload);
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

export function GlobalErrorListeners() {
  React.useEffect(() => installGlobalErrorListeners(), []);
  return null;
}

// ----------------------------- Error Boundary --------------------------------
/**
 * Props:
 * - boundaryName?: string         // used in emitted events
 * - fallback?: ReactNode          // custom UI; receives reset if function form
 * - resetKeys?: any[]             // reset on change (like react-error-boundary)
 * - onError?: (error, info) => void
 * - onReset?: () => void
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null, lastTs: null };
  }

  static getDerivedStateFromError(error) {
    return { error, lastTs: Date.now() };
  }

  componentDidCatch(error, info) {
    const name = this.props.boundaryName || "ErrorBoundary";
    const data = toErrorData(error, {
      componentStack: info?.componentStack,
      boundary: name,
      kind: "react.render",
    });
    const payload = emit("app.error", name, data);
    exportToHubIfEnabled(payload);
    this.props.onError?.(error, info);
    if (process.env.NODE_ENV !== "production") {
      console.error(`[${name}]`, error, info);
    }
  }

  componentDidUpdate(prevProps) {
    // Reset when resetKeys change (shallow compare)
    const { resetKeys } = this.props;
    if (!this.state.error || !Array.isArray(resetKeys)) return;
    const changed =
      !Array.isArray(prevProps.resetKeys) ||
      resetKeys.length !== prevProps.resetKeys.length ||
      resetKeys.some((v, i) => Object.is(v, prevProps.resetKeys[i]) === false);
    if (changed) this.reset();
  }

  reset = () => {
    const name = this.props.boundaryName || "ErrorBoundary";
    this.setState({ error: null, info: null });
    emit("app.error.recovered", name, { ts: nowISO() });
    this.props.onReset?.();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    // Custom fallback supports function-as-children: (reset) => ReactNode
    if (typeof this.props.fallback === "function") {
      return this.props.fallback(this.reset, error);
    }
    if (this.props.fallback) return this.props.fallback;

    // Default accessible fallback UI (Tailwind-friendly)
    const msg = String(error?.message || error || "Unknown error");
    return (
      <div
        role="alert"
        className="m-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-900 shadow-sm"
      >
        <div className="mb-1 text-sm font-semibold">Something went wrong.</div>
        <div className="text-sm">{msg}</div>
        {process.env.NODE_ENV !== "production" && error?.stack ? (
          <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-white/70 p-2 text-xs text-rose-900">
            {String(error.stack).split("\n").slice(0, 12).join("\n")}
          </pre>
        ) : null}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            className="rounded-xl bg-stone-900 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-black focus:outline-none focus:ring-2 focus:ring-stone-700/60"
            onClick={this.reset}
            aria-label="Try again"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
