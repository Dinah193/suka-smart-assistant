// src/components/cooking/index.js
// Robust barrel + lazy wrappers + hooks + mount helpers for cooking components
// Fits Suka's raised-card aesthetic; no circular deps.

import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { automation } from "@/services/automation/runtime";
import { CookingPrefsStore } from "@/store/CookingPrefsStore";

/* -------------------------------------------------------------------------- */
/* Direct (eager) exports                                                      */
/* -------------------------------------------------------------------------- */
export { default as TechniqueFeedbackBar } from "./TechniqueFeedbackBar.jsx";
export { default as TasteAndKitControls } from "./TasteAndKitControls.jsx";

/* -------------------------------------------------------------------------- */
/* Lazy components with error boundary + retry                                 */
/* -------------------------------------------------------------------------- */
const LazyTechniqueFeedbackBarInner = React.lazy(() =>
  import(/* webpackChunkName: "cooking-technique-feedback" */ "./TechniqueFeedbackBar.jsx")
);
const LazyTasteAndKitControlsInner = React.lazy(() =>
  import(/* webpackChunkName: "cooking-taste-kit-controls" */ "./TasteAndKitControls.jsx")
);

export function LazyTechniqueFeedbackBar(props) {
  return (
    <ErrorBoundary name="TechniqueFeedbackBar">
      <Suspense fallback={<FeedbackBarSkeleton />}>
        <LazyTechniqueFeedbackBarInner {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}

export function LazyTasteAndKitControls(props) {
  return (
    <ErrorBoundary name="TasteAndKitControls">
      <Suspense fallback={<ControlsSkeleton />}>
        <LazyTasteAndKitControlsInner {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}

/* -------------------------------------------------------------------------- */
/* Preload helpers (warm chunks before opening drawers/modals)                 */
/* -------------------------------------------------------------------------- */
export async function preloadTechniqueFeedbackBar() {
  try {
    await Promise.all([
      import(/* webpackPrefetch: true */ "./TechniqueFeedbackBar.jsx"),
    ]);
  } catch {}
}
export async function preloadTasteAndKitControls() {
  try {
    await Promise.all([
      import(/* webpackPrefetch: true */ "./TasteAndKitControls.jsx"),
    ]);
  } catch {}
}

/* -------------------------------------------------------------------------- */
/* Hook: useCookingPrefs (selector + shallow equality)                         */
/* -------------------------------------------------------------------------- */
export function useCookingPrefs(selector = (s) => s, equalityFn = shallowEqual) {
  const [slice, setSlice] = useState(() => selector(CookingPrefsStore.get()));
  useEffect(() => {
    return CookingPrefsStore.subscribe((s) => {
      const next = selector(s);
      setSlice((prev) => (equalityFn(prev, next) ? prev : next));
    });
  }, [selector, equalityFn]);
  return slice;
}

/* -------------------------------------------------------------------------- */
/* Optional: Combined panel (tabs) for quick drop-ins                          */
/* -------------------------------------------------------------------------- */
export function CombinedCookingPanel({
  cuisine,
  dish = "",
  showAdvanced = true,
  defaultTab = "taste",
  compact = false,
}) {
  const [tab, setTab] = useState(defaultTab);
  return (
    <div className={cookingUi.card + " p-3"}>
      <div className="flex items-center justify-between">
        <div className="font-semibold">Cooking Controls</div>
        <div className="tabs tabs-boxed tabs-sm">
          <button className={"tab " + (tab === "taste" ? "tab-active" : "")} onClick={() => setTab("taste")}>Taste & Kit</button>
          <button className={"tab " + (tab === "feedback" ? "tab-active" : "")} onClick={() => setTab("feedback")}>Feedback</button>
        </div>
      </div>
      <div className="mt-3">
        {tab === "taste" ? (
          <LazyTasteAndKitControls compact={compact} showAdvanced={showAdvanced} />
        ) : (
          <LazyTechniqueFeedbackBar cuisine={cuisine} dish={dish} />
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Skeletons (match raised-horizontal card style)                              */
/* -------------------------------------------------------------------------- */
export function FeedbackBarSkeleton() {
  return (
    <div className={cookingUi.card + " p-4 animate-pulse"}>
      <div className="flex flex-col md:flex-row md:items-center gap-3">
        <div className="h-4 w-40 bg-base-300 rounded" />
        <div className="flex gap-2">
          <div className="h-6 w-20 bg-base-300 rounded-full" />
          <div className="h-6 w-24 bg-base-300 rounded-full" />
          <div className="h-6 w-16 bg-base-300 rounded-full" />
          <div className="h-6 w-28 bg-base-300 rounded-full" />
        </div>
        <div className="flex-1 flex items-center gap-2 md:justify-end">
          <div className="h-8 w-full md:w-80 bg-base-300 rounded" />
          <div className="h-8 w-20 bg-base-300 rounded" />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="p-3 rounded-xl bg-base-200">
            <div className="h-3 w-24 bg-base-300 rounded mb-2" />
            <div className="h-2 w-full bg-base-300 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ControlsSkeleton() {
  return (
    <div className={cookingUi.card + " p-5 animate-pulse"}>
      <div className="h-5 w-48 bg-base-300 rounded mb-4" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="p-3 rounded-xl bg-base-200">
            <div className="h-3 w-24 bg-base-300 rounded mb-2" />
            <div className="h-2 w-full bg-base-300 rounded" />
          </div>
        ))}
      </div>
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-5">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="card bg-base-100 border border-base-200 shadow-sm">
            <div className="card-body p-4">
              <div className="h-4 w-32 bg-base-300 rounded mb-2" />
              <div className="h-6 w-full bg-base-300 rounded mb-2" />
              <div className="h-6 w-1/2 bg-base-300 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Error boundary (with retry button + telemetry)                              */
/* -------------------------------------------------------------------------- */
function ErrorBoundary({ name = "Unknown", children }) {
  const [key, setKey] = useState(0);
  return (
    <BoundaryImpl
      key={key}
      name={name}
      onRetry={() => {
        automation.emit("ui/componentRetry", { name, ts: Date.now() });
        setKey((k) => k + 1);
      }}
    >
      {children}
    </BoundaryImpl>
  );
}
class BoundaryImpl extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(err) { return { error: err }; }
  componentDidCatch(error, info) {
    try {
      automation.emit("ui/componentError", {
        name: this.props.name,
        message: String(error?.message || error),
        stack: String(error?.stack || ""),
        info,
      });
    } catch {}
  }
  render() {
    if (this.state.error) {
      return (
        <div className={cookingUi.card + " p-4 border-error"}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold">Something went wrong</div>
              <div className="text-xs opacity-70">{this.props.name} failed to load.</div>
            </div>
            <button className="btn btn-sm" onClick={this.props.onRetry}>Retry</button>
          </div>
          <pre className="mt-3 text-xs opacity-60 max-h-40 overflow-auto">
            {String(this.state.error?.message || this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

/* -------------------------------------------------------------------------- */
/* Mount helpers (portal-friendly, SSR-safe)                                   */
/* -------------------------------------------------------------------------- */

export function mountTechniqueFeedbackBar(container, initialProps = {}) {
  return mountWithState(container, LazyTechniqueFeedbackBar, initialProps);
}
export function mountTasteAndKitControls(container, initialProps = {}) {
  return mountWithState(container, LazyTasteAndKitControls, initialProps);
}
export function mountCombinedCookingPanel(container, initialProps = {}) {
  return mountWithState(container, CombinedCookingPanel, initialProps);
}

function mountWithState(container, Component, initialProps) {
  if (!isBrowser() || !container) return () => {};
  const Wrapper = () => {
    const [props, setProps] = useState(initialProps || {});
    useEffect(() => {
      // announce mount for analytics
      automation.emit("ui/componentMounted", { name: Component.name, ts: Date.now() });
      return () => automation.emit("ui/componentUnmounted", { name: Component.name, ts: Date.now() });
    }, []);
    // expose updater via DOM node (handy in portals)
    useEffect(() => {
      container.__sukaUpdate = (patch) => setProps((p) => ({ ...p, ...(patch || {}) }));
    }, []);
    return <Component {...props} />;
  };
  const root = ReactDOM.createRoot(container);
  root.render(<Wrapper />);
  return {
    update: (patch) => container.__sukaUpdate?.(patch),
    unmount: () => root.unmount(),
  };
}

/* -------------------------------------------------------------------------- */
/* Dev tools: quick mount from console                                        */
/* -------------------------------------------------------------------------- */
export function registerCookingDevTools() {
  if (!isBrowser()) return;
  window.SukaCooking = {
    preloadTechniqueFeedbackBar,
    preloadTasteAndKitControls,
    mountFeedback(el, props) { return mountTechniqueFeedbackBar(resolveEl(el), props); },
    mountControls(el, props) { return mountTasteAndKitControls(resolveEl(el), props); },
    mountCombined(el, props) { return mountCombinedCookingPanel(resolveEl(el), props); },
  };
  // lightweight nudge
  automation.emit("devtools/registered", { scope: "SukaCooking" });
}

/* -------------------------------------------------------------------------- */
/* Small design tokens + utilities                                             */
/* -------------------------------------------------------------------------- */
export const cookingUi = {
  card: "rounded-2xl shadow-lg border border-base-200 bg-base-100/90 backdrop-blur",
  sectionCard: "card bg-base-100 border border-base-200 shadow-sm",
  chipActive: "bg-primary text-primary-content border-primary shadow",
  chip: "bg-base-100 border-base-300 hover:bg-base-200",
};

export function cn(...parts) {
  return parts.filter(Boolean).join(" ");
}
function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}
function isBrowser() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}
function resolveEl(el) {
  if (el && el.nodeType === 1) return el;
  if (typeof el === "string") return document.querySelector(el);
  return null;
}
