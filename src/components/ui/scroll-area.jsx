// File: src/components/ui/scroll-area.jsx
// SSA UI — ScrollArea (production-ready)
//
// Notes
// - This is a lightweight, dependency-free ScrollArea that works with your existing
//   “bridge” CSS and Tailwind utilities.
// - Supports:
//   - Vertical and/or horizontal scrolling
//   - Optional fade edges (top/bottom/left/right) to hint scrollability
//   - Optional auto-hide scrollbar styling hooks via data-attrs
//   - Imperative ref to the viewport for programmatic scrolling
//
// Usage
// <ScrollArea className="h-64">
//   <div className="p-3">...</div>
// </ScrollArea>
//
// <ScrollArea orientation="both" className="h-64">
//   <div style={{ width: 900 }}>Wide content</div>
// </ScrollArea>

import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

/* ------------------------------ utils ------------------------------ */

function cn(...parts) {
  return parts.filter(Boolean).join(" ");
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

/**
 * Detect whether an element can scroll in each axis.
 */
function getScrollState(el) {
  if (!el)
    return {
      canY: false,
      canX: false,
      atTop: true,
      atBottom: true,
      atLeft: true,
      atRight: true,
    };

  const canY = el.scrollHeight > el.clientHeight + 1;
  const canX = el.scrollWidth > el.clientWidth + 1;

  const atTop = el.scrollTop <= 0;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;

  const atLeft = el.scrollLeft <= 0;
  const atRight = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;

  return { canY, canX, atTop, atBottom, atLeft, atRight };
}

/**
 * Safe ResizeObserver wrapper.
 */
function useResizeObserver(targetRef, onResize) {
  useEffect(() => {
    const el = targetRef?.current;
    if (!el) return;

    if (typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver(() => onResize?.());
    ro.observe(el);

    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetRef, onResize]);
}

/* ------------------------------ component ------------------------------ */

/**
 * @typedef {"vertical"|"horizontal"|"both"} ScrollOrientation
 */

/**
 * @param {Object} props
 * @param {React.ReactNode} props.children
 * @param {string} [props.className] - wrapper classes
 * @param {string} [props.viewportClassName] - viewport classes
 * @param {ScrollOrientation} [props.orientation="vertical"]
 * @param {boolean} [props.fadeEdges=true] - show subtle gradient edges when scrollable
 * @param {number} [props.fadeSize=18] - px size of fade gradients
 * @param {boolean} [props.autoHide=false] - adds data-autohide attr for CSS-based behavior
 * @param {boolean} [props.showScrollbar=true] - show scrollbar (native) or hide via CSS hooks
 * @param {boolean} [props.trackScrollState=true] - updates data attrs for edge state
 * @param {React.HTMLAttributes<HTMLDivElement>} [props.rest]
 */
const ScrollArea = forwardRef(function ScrollArea(
  {
    children,
    className,
    viewportClassName,
    orientation = "vertical",
    fadeEdges = true,
    fadeSize = 18,
    autoHide = false,
    showScrollbar = true,
    trackScrollState = true,
    ...rest
  },
  ref
) {
  const viewportRef = useRef(null);

  const [state, setState] = useState(() => ({
    canY: false,
    canX: false,
    atTop: true,
    atBottom: true,
    atLeft: true,
    atRight: true,
  }));

  const axis = useMemo(() => {
    const o = (orientation || "vertical").toLowerCase();
    return /** @type {ScrollOrientation} */ (
      o === "horizontal" || o === "both" ? o : "vertical"
    );
  }, [orientation]);

  const overflowStyle = useMemo(() => {
    const style = {};
    if (axis === "vertical") {
      style.overflowY = "auto";
      style.overflowX = "hidden";
    } else if (axis === "horizontal") {
      style.overflowX = "auto";
      style.overflowY = "hidden";
    } else {
      style.overflowX = "auto";
      style.overflowY = "auto";
    }
    return style;
  }, [axis]);

  const updateState = () => {
    if (!trackScrollState) return;
    const el = viewportRef.current;
    setState(getScrollState(el));
  };

  // Track scroll edges
  useEffect(() => {
    updateState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axis, trackScrollState]);

  // Update on scroll
  const onScroll = () => updateState();

  // Update when size changes (viewport or content)
  useResizeObserver(viewportRef, updateState);

  // Also update when children change significantly
  useEffect(() => {
    updateState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children]);

  // Expose imperative API
  useImperativeHandle(
    ref,
    () => ({
      viewport: viewportRef.current,
      scrollTo: (opts) => viewportRef.current?.scrollTo?.(opts),
      scrollTop: (y) => {
        const el = viewportRef.current;
        if (!el) return;
        el.scrollTop = clamp(y, 0, el.scrollHeight);
        updateState();
      },
      scrollLeft: (x) => {
        const el = viewportRef.current;
        if (!el) return;
        el.scrollLeft = clamp(x, 0, el.scrollWidth);
        updateState();
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [axis, trackScrollState]
  );

  const dataAttrs = trackScrollState
    ? {
        "data-can-y": state.canY ? "1" : "0",
        "data-can-x": state.canX ? "1" : "0",
        "data-at-top": state.atTop ? "1" : "0",
        "data-at-bottom": state.atBottom ? "1" : "0",
        "data-at-left": state.atLeft ? "1" : "0",
        "data-at-right": state.atRight ? "1" : "0",
      }
    : {};

  const fadeEnabledY = fadeEdges && (axis === "vertical" || axis === "both");
  const fadeEnabledX = fadeEdges && (axis === "horizontal" || axis === "both");

  const fadePx = clamp(fadeSize, 0, 80);

  return (
    <div
      {...rest}
      className={cn(
        "relative w-full",
        // optional hooks for CSS
        autoHide ? "ssa-scrollarea-autohide" : "",
        showScrollbar ? "ssa-scrollarea-scrollbar" : "ssa-scrollarea-nosb",
        className
      )}
      data-scrollarea="1"
      data-orientation={axis}
      data-autohide={autoHide ? "1" : "0"}
      data-show-scrollbar={showScrollbar ? "1" : "0"}
      {...dataAttrs}
    >
      {/* Viewport */}
      <div
        ref={viewportRef}
        className={cn(
          "w-full h-full",
          // Allow consumers to style the native scrollbar via CSS
          "ssa-scrollarea-viewport",
          viewportClassName
        )}
        style={overflowStyle}
        onScroll={onScroll}
      >
        {children}
      </div>

      {/* Fades (pure CSS gradients) */}
      {fadeEnabledY && state.canY ? (
        <>
          {/* top */}
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute left-0 right-0 top-0",
              state.atTop ? "opacity-0" : "opacity-100",
              "transition-opacity duration-150"
            )}
            style={{
              height: fadePx,
              background:
                "linear-gradient(to bottom, rgba(0,0,0,0.12), rgba(0,0,0,0))",
              // let theme override via CSS variables if desired
              mixBlendMode: "multiply",
            }}
          />
          {/* bottom */}
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute left-0 right-0 bottom-0",
              state.atBottom ? "opacity-0" : "opacity-100",
              "transition-opacity duration-150"
            )}
            style={{
              height: fadePx,
              background:
                "linear-gradient(to top, rgba(0,0,0,0.12), rgba(0,0,0,0))",
              mixBlendMode: "multiply",
            }}
          />
        </>
      ) : null}

      {fadeEnabledX && state.canX ? (
        <>
          {/* left */}
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-0 bottom-0 left-0",
              state.atLeft ? "opacity-0" : "opacity-100",
              "transition-opacity duration-150"
            )}
            style={{
              width: fadePx,
              background:
                "linear-gradient(to right, rgba(0,0,0,0.12), rgba(0,0,0,0))",
              mixBlendMode: "multiply",
            }}
          />
          {/* right */}
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-0 bottom-0 right-0",
              state.atRight ? "opacity-0" : "opacity-100",
              "transition-opacity duration-150"
            )}
            style={{
              width: fadePx,
              background:
                "linear-gradient(to left, rgba(0,0,0,0.12), rgba(0,0,0,0))",
              mixBlendMode: "multiply",
            }}
          />
        </>
      ) : null}
    </div>
  );
});

export default ScrollArea;
export { ScrollArea };

/* ------------------------------ CSS hooks (optional) ------------------------------ */
/**
Add to your global CSS if you want nicer scrollbars and hide behavior.
(You can place in bridge.scan.css or a global ui.css)
----------------------------------------------------
.ssa-scrollarea-viewport {
  scrollbar-gutter: stable;
}

.ssa-scrollarea-nosb .ssa-scrollarea-viewport {
  scrollbar-width: none;          // Firefox
}
.ssa-scrollarea-nosb .ssa-scrollarea-viewport::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.ssa-scrollarea-autohide .ssa-scrollarea-viewport {
  scrollbar-width: thin;          // Firefox
}
.ssa-scrollarea-autohide .ssa-scrollarea-viewport::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
.ssa-scrollarea-autohide .ssa-scrollarea-viewport::-webkit-scrollbar-thumb {
  background: rgba(0,0,0,0.25);
  border-radius: 999px;
  border: 2px solid rgba(255,255,255,0.35);
}
.ssa-scrollarea-autohide .ssa-scrollarea-viewport::-webkit-scrollbar-track {
  background: transparent;
}
----------------------------------------------------
**/
