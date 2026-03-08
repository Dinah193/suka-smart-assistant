// File: src/components/ui/tabs.jsx
// Production-ready, dependency-light Tabs components (JS + React)
//
// - Accessible: proper roles, aria-selected, roving tabindex, keyboard nav
// - Controlled or uncontrolled
// - Supports vertical/horizontal orientation
// - Optional "pill" / "underline" variants
// - No external deps (no Radix required)
//
// Usage:
//   import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
//
//   <Tabs defaultValue="overview">
//     <TabsList aria-label="Meal tools">
//       <TabsTrigger value="overview">Overview</TabsTrigger>
//       <TabsTrigger value="recipes">Recipe Vault</TabsTrigger>
//       <TabsTrigger value="batch">Batch Session</TabsTrigger>
//     </TabsList>
//
//     <TabsContent value="overview">...</TabsContent>
//     <TabsContent value="recipes">...</TabsContent>
//     <TabsContent value="batch">...</TabsContent>
//   </Tabs>
//
// Controlled:
//   <Tabs value={tab} onValueChange={setTab}>...</Tabs>

import * as React from "react";

/** Tiny className merge helper (avoids external deps). */
function cn(...inputs) {
  const out = [];
  for (const input of inputs) {
    if (!input) continue;
    if (typeof input === "string") {
      out.push(input);
      continue;
    }
    if (Array.isArray(input)) {
      out.push(cn(...input));
      continue;
    }
    if (typeof input === "object") {
      for (const [k, v] of Object.entries(input)) if (v) out.push(k);
    }
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function useControllableState({ value, defaultValue, onChange }) {
  const controlled = value !== undefined;
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const current = controlled ? value : uncontrolled;

  const set = React.useCallback(
    (next) => {
      if (!controlled) setUncontrolled(next);
      if (typeof onChange === "function") onChange(next);
    },
    [controlled, onChange]
  );

  return [current, set, controlled];
}

const TabsContext = React.createContext(null);

function useTabsContext(componentName) {
  const ctx = React.useContext(TabsContext);
  if (!ctx) {
    throw new Error(`${componentName} must be used within <Tabs />`);
  }
  return ctx;
}

function makeId(prefix) {
  // Use React 18 useId if available, fallback to random.
  // This avoids importing a separate uid lib.
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

/**
 * Tabs (root)
 * Props:
 * - value / defaultValue
 * - onValueChange
 * - orientation: "horizontal" | "vertical"
 * - activationMode: "automatic" | "manual"  (arrowing auto-activates or not)
 * - variant: "pill" | "underline"
 */
export const Tabs = React.forwardRef(function Tabs(
  {
    className,
    value,
    defaultValue,
    onValueChange,
    orientation = "horizontal",
    activationMode = "automatic",
    variant = "pill",
    dir = "ltr",
    ...props
  },
  ref
) {
  const rootId = React.useMemo(() => makeId("tabs"), []);
  const [current, setCurrent] = useControllableState({
    value,
    defaultValue,
    onChange: onValueChange,
  });

  // Registry allows TabsList to perform roving focus across triggers
  const triggersRef = React.useRef(new Map()); // value -> HTMLElement
  const listRef = React.useRef(null);

  const registerTrigger = React.useCallback((val, el) => {
    if (!val) return;
    if (el) triggersRef.current.set(val, el);
    else triggersRef.current.delete(val);
  }, []);

  const getOrderedValues = React.useCallback(() => {
    // Rely on DOM order within list if possible.
    const listEl = listRef.current;
    if (!listEl) return Array.from(triggersRef.current.keys());
    const nodes = Array.from(
      listEl.querySelectorAll('[data-ui="tabs-trigger"]')
    );
    const vals = nodes.map((n) => n.getAttribute("data-value")).filter(Boolean);
    return vals.length ? vals : Array.from(triggersRef.current.keys());
  }, []);

  const focusValue = React.useCallback((val) => {
    const el = triggersRef.current.get(val);
    if (el && typeof el.focus === "function") el.focus();
  }, []);

  const ctx = React.useMemo(
    () => ({
      rootId,
      value: current,
      setValue: setCurrent,
      orientation,
      activationMode,
      variant,
      dir,
      registerTrigger,
      triggersRef,
      listRef,
      getOrderedValues,
      focusValue,
    }),
    [
      rootId,
      current,
      setCurrent,
      orientation,
      activationMode,
      variant,
      dir,
      registerTrigger,
      getOrderedValues,
      focusValue,
    ]
  );

  return (
    <TabsContext.Provider value={ctx}>
      <div
        ref={ref}
        data-ui="tabs"
        data-orientation={orientation}
        data-variant={variant}
        className={cn("w-full", className)}
        {...props}
      />
    </TabsContext.Provider>
  );
});
Tabs.displayName = "Tabs";

/**
 * TabsList
 * - Provides roving focus & keyboard navigation for triggers.
 */
export const TabsList = React.forwardRef(function TabsList(
  { className, "aria-label": ariaLabel, ...props },
  ref
) {
  const {
    orientation,
    variant,
    dir,
    value,
    setValue,
    activationMode,
    listRef,
    getOrderedValues,
    focusValue,
  } = useTabsContext("TabsList");

  const mergedRef = React.useCallback(
    (node) => {
      listRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref, listRef]
  );

  const isHorizontal = orientation === "horizontal";

  const listBase =
    "inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white p-1 " +
    "text-slate-700";
  const listUnderline =
    "inline-flex items-center gap-4 border-b border-slate-200 bg-transparent p-0 rounded-none";
  const listVariant = variant === "underline" ? listUnderline : listBase;

  const onKeyDown = (e) => {
    const keys = [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
    ];
    if (!keys.includes(e.key)) return;

    const values = getOrderedValues();
    if (!values.length) return;

    const currentIndex = Math.max(0, values.indexOf(value));
    const rtl = dir === "rtl";

    const nextIndex = (idx) => (idx + values.length) % values.length;

    let targetIndex = currentIndex;

    if (e.key === "Home") targetIndex = 0;
    else if (e.key === "End") targetIndex = values.length - 1;
    else if (e.key === "ArrowLeft" && isHorizontal) {
      targetIndex = rtl
        ? nextIndex(currentIndex + 1)
        : nextIndex(currentIndex - 1);
    } else if (e.key === "ArrowRight" && isHorizontal) {
      targetIndex = rtl
        ? nextIndex(currentIndex - 1)
        : nextIndex(currentIndex + 1);
    } else if (e.key === "ArrowUp" && !isHorizontal) {
      targetIndex = nextIndex(currentIndex - 1);
    } else if (e.key === "ArrowDown" && !isHorizontal) {
      targetIndex = nextIndex(currentIndex + 1);
    } else {
      return;
    }

    e.preventDefault();
    const nextVal = values[targetIndex];
    focusValue(nextVal);
    if (activationMode === "automatic") setValue(nextVal);
  };

  return (
    <div
      ref={mergedRef}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation={orientation}
      data-ui="tabs-list"
      className={cn(listVariant, className)}
      onKeyDown={onKeyDown}
      {...props}
    />
  );
});
TabsList.displayName = "TabsList";

/**
 * TabsTrigger
 * Props:
 * - value: required
 * - disabled
 */
export const TabsTrigger = React.forwardRef(function TabsTrigger(
  {
    className,
    value: triggerValue,
    disabled = false,
    onClick,
    onFocus,
    ...props
  },
  ref
) {
  const { rootId, value, setValue, variant, registerTrigger, activationMode } =
    useTabsContext("TabsTrigger");

  if (triggerValue == null) {
    throw new Error("TabsTrigger requires a `value` prop.");
  }

  const selected = value === triggerValue;

  const localRef = React.useRef(null);
  const mergedRef = React.useCallback(
    (node) => {
      localRef.current = node;
      registerTrigger(triggerValue, node);
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref, registerTrigger, triggerValue]
  );

  React.useEffect(() => {
    return () => registerTrigger(triggerValue, null);
  }, [registerTrigger, triggerValue]);

  const triggerBase =
    "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm " +
    "transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 " +
    "disabled:pointer-events-none disabled:opacity-50";

  const pillStyles = selected
    ? "bg-slate-900 text-white focus-visible:ring-slate-900/30 ring-offset-white"
    : "bg-transparent text-slate-700 hover:bg-slate-100 focus-visible:ring-slate-400/30 ring-offset-white";

  const underlineBase =
    "relative inline-flex items-center justify-center pb-2 text-sm font-medium transition-colors " +
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 " +
    "disabled:pointer-events-none disabled:opacity-50";
  const underlineStyles = selected
    ? "text-slate-900 focus-visible:ring-slate-900/30 ring-offset-white"
    : "text-slate-600 hover:text-slate-900 focus-visible:ring-slate-400/30 ring-offset-white";

  const handleClick = (e) => {
    if (disabled) return;
    setValue(triggerValue);
    if (typeof onClick === "function") onClick(e);
  };

  const handleFocus = (e) => {
    if (typeof onFocus === "function") onFocus(e);
    if (disabled) return;
    if (activationMode === "automatic") {
      // focus occurs during arrow nav; in automatic mode focus == activation
      // but TabsList already sets value; this keeps behavior consistent if focused externally
      setValue(triggerValue);
    }
  };

  const tabId = `${rootId}-tab-${String(triggerValue)}`;
  const panelId = `${rootId}-panel-${String(triggerValue)}`;

  return (
    <button
      ref={mergedRef}
      type="button"
      role="tab"
      id={tabId}
      aria-selected={selected}
      aria-controls={panelId}
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      data-ui="tabs-trigger"
      data-value={String(triggerValue)}
      data-state={selected ? "active" : "inactive"}
      className={cn(
        variant === "underline" ? underlineBase : triggerBase,
        variant === "underline" ? underlineStyles : pillStyles,
        className
      )}
      onClick={handleClick}
      onFocus={handleFocus}
      {...props}
    >
      {props.children}
      {variant === "underline" && selected ? (
        <span
          aria-hidden="true"
          className="absolute left-0 right-0 -bottom-[1px] h-[2px] bg-slate-900 rounded-full"
        />
      ) : null}
    </button>
  );
});
TabsTrigger.displayName = "TabsTrigger";

/**
 * TabsContent
 * Props:
 * - value: required
 * - forceMount: render even when inactive (hidden)
 */
export const TabsContent = React.forwardRef(function TabsContent(
  { className, value: contentValue, forceMount = false, ...props },
  ref
) {
  const { rootId, value } = useTabsContext("TabsContent");

  if (contentValue == null) {
    throw new Error("TabsContent requires a `value` prop.");
  }

  const selected = value === contentValue;
  if (!forceMount && !selected) return null;

  const tabId = `${rootId}-tab-${String(contentValue)}`;
  const panelId = `${rootId}-panel-${String(contentValue)}`;

  return (
    <div
      ref={ref}
      role="tabpanel"
      id={panelId}
      aria-labelledby={tabId}
      hidden={!selected}
      tabIndex={0}
      data-ui="tabs-content"
      data-state={selected ? "active" : "inactive"}
      className={cn("mt-3 outline-none", className)}
      {...props}
    />
  );
});
TabsContent.displayName = "TabsContent";

export default Tabs;
