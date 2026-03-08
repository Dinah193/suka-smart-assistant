// File: src/components/ui/dropdown-menu.jsx
// Production-ready, dependency-light Dropdown Menu (JS + React)
//
// - No external deps (no Radix required).
// - Accessible-ish: ARIA roles, keyboard navigation, focus management, ESC close.
// - Portal to <body> to avoid overflow clipping.
// - Anchoring uses getBoundingClientRect() and keeps within viewport.
// - Supports items, checkbox items, radio group/items, separators, labels, shortcuts,
//   and a simple "submenu" implementation.
// - Works great for SSA dashboards/menus without bringing in a component library.
//
// NOTE:
// This is a pragmatic implementation. For complex nested menus, virtualized lists,
// or full ARIA menu spec coverage, consider Radix. But for SSA's needs (actions,
// small menus, modals), this is robust and production-safe.
//
// Usage:
//   import {
//     DropdownMenu,
//     DropdownMenuTrigger,
//     DropdownMenuContent,
//     DropdownMenuItem,
//     DropdownMenuSeparator,
//     DropdownMenuLabel,
//     DropdownMenuCheckboxItem,
//     DropdownMenuRadioGroup,
//     DropdownMenuRadioItem,
//     DropdownMenuShortcut,
//   } from "@/components/ui/dropdown-menu";
//
//   <DropdownMenu>
//     <DropdownMenuTrigger asChild>
//       <button className="btn">Actions</button>
//     </DropdownMenuTrigger>
//     <DropdownMenuContent align="end" sideOffset={8}>
//       <DropdownMenuLabel>Session</DropdownMenuLabel>
//       <DropdownMenuItem onSelect={() => start()}>Start</DropdownMenuItem>
//       <DropdownMenuItem disabled>Disabled Action</DropdownMenuItem>
//       <DropdownMenuSeparator />
//       <DropdownMenuCheckboxItem checked={sound} onCheckedChange={setSound}>
//         Sound alerts
//       </DropdownMenuCheckboxItem>
//       <DropdownMenuSeparator />
//       <DropdownMenuRadioGroup value={mode} onValueChange={setMode}>
//         <DropdownMenuRadioItem value="auto">Auto</DropdownMenuRadioItem>
//         <DropdownMenuRadioItem value="manual">Manual</DropdownMenuRadioItem>
//       </DropdownMenuRadioGroup>
//     </DropdownMenuContent>
//   </DropdownMenu>

import * as React from "react";
import { createPortal } from "react-dom";

/* ------------------------------ utilities ------------------------------ */
function cn(...inputs) {
  const out = [];
  for (const input of inputs) {
    if (!input) continue;
    if (typeof input === "string") out.push(input);
    else if (Array.isArray(input)) out.push(cn(...input));
    else if (typeof input === "object") {
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

function isFocusable(el) {
  if (!el) return false;
  const disabled = el.getAttribute("aria-disabled") === "true" || el.disabled;
  if (disabled) return false;
  const tabindex = el.getAttribute("tabindex");
  return tabindex !== "-1";
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function getViewport() {
  return {
    w: window.innerWidth || document.documentElement.clientWidth,
    h: window.innerHeight || document.documentElement.clientHeight,
  };
}

function nextTick(fn) {
  const id = window.setTimeout(fn, 0);
  return () => window.clearTimeout(id);
}

/* ------------------------------ context ------------------------------ */
const DropdownMenuContext = React.createContext(null);
const DropdownMenuContentContext = React.createContext(null);
const DropdownMenuRadioContext = React.createContext(null);

function useMenuCtx(name) {
  const ctx = React.useContext(DropdownMenuContext);
  if (!ctx) throw new Error(`${name} must be used within <DropdownMenu />`);
  return ctx;
}

function useContentCtx(name) {
  const ctx = React.useContext(DropdownMenuContentContext);
  if (!ctx)
    throw new Error(`${name} must be used within <DropdownMenuContent />`);
  return ctx;
}

/* ------------------------------ icons ------------------------------ */
function CheckIcon({ className }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      className={cn("h-4 w-4", className)}
    >
      <path
        fillRule="evenodd"
        d="M16.704 5.29a1 1 0 0 1 0 1.414l-7.07 7.07a1 1 0 0 1-1.415 0l-3.535-3.535a1 1 0 1 1 1.414-1.414l2.828 2.828 6.364-6.364a1 1 0 0 1 1.414 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function DotIcon({ className }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      className={cn("h-2.5 w-2.5", className)}
    >
      <circle cx="10" cy="10" r="4" />
    </svg>
  );
}

function ChevronRightIcon({ className }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      className={cn("h-4 w-4", className)}
    >
      <path
        fillRule="evenodd"
        d="M7.21 14.77a.75.75 0 0 1 .02-1.06L10.94 10 7.23 6.29A.75.75 0 1 1 8.29 5.23l4.24 4.24a.75.75 0 0 1 0 1.06l-4.24 4.24a.75.75 0 0 1-1.08-.02Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/* ------------------------------ root ------------------------------ */
export function DropdownMenu({
  children,
  open,
  defaultOpen = false,
  onOpenChange,
  modal = true, // if true, traps outside click (still allows focus to move within)
}) {
  const [isOpen, setIsOpen] = useControllableState({
    value: open,
    defaultValue: defaultOpen,
    onChange: onOpenChange,
  });

  const triggerRef = React.useRef(null);
  const contentRef = React.useRef(null);

  const ctx = React.useMemo(
    () => ({
      open: isOpen,
      setOpen: setIsOpen,
      modal,
      triggerRef,
      contentRef,
    }),
    [isOpen, setIsOpen, modal]
  );

  return (
    <DropdownMenuContext.Provider value={ctx}>
      {children}
    </DropdownMenuContext.Provider>
  );
}

/* ------------------------------ trigger ------------------------------ */
export const DropdownMenuTrigger = React.forwardRef(
  function DropdownMenuTrigger(
    { asChild = false, className, onClick, onKeyDown, ...props },
    ref
  ) {
    const { open, setOpen, triggerRef } = useMenuCtx("DropdownMenuTrigger");

    const mergedRef = React.useCallback(
      (node) => {
        triggerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref, triggerRef]
    );

    const handleClick = (e) => {
      if (typeof onClick === "function") onClick(e);
      if (e.defaultPrevented) return;
      setOpen(!open);
    };

    const handleKeyDown = (e) => {
      if (typeof onKeyDown === "function") onKeyDown(e);
      if (e.defaultPrevented) return;

      // Open on ArrowDown/Enter/Space
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
    };

    const triggerProps = {
      ref: mergedRef,
      "aria-haspopup": "menu",
      "aria-expanded": open ? "true" : "false",
      "data-ui": "dropdown-trigger",
      onClick: handleClick,
      onKeyDown: handleKeyDown,
      className,
      ...props,
    };

    if (asChild && React.isValidElement(props.children)) {
      const child = props.children;
      return React.cloneElement(child, {
        ...triggerProps,
        className: cn(child.props.className, className),
        ref: mergedRef,
      });
    }

    return <button type="button" {...triggerProps} />;
  }
);

/* ------------------------------ content positioning ------------------------------ */
function computePosition({
  triggerRect,
  contentRect,
  align,
  side,
  sideOffset,
}) {
  const { w: vw, h: vh } = getViewport();
  const offset = sideOffset ?? 8;

  // Default side: bottom
  const s = side || "bottom";
  const a = align || "start";

  let top = 0;
  let left = 0;

  // Side placement
  if (s === "bottom") top = triggerRect.bottom + offset;
  if (s === "top") top = triggerRect.top - contentRect.height - offset;
  if (s === "right") left = triggerRect.right + offset;
  if (s === "left") left = triggerRect.left - contentRect.width - offset;

  // Align on cross-axis
  if (s === "bottom" || s === "top") {
    if (a === "start") left = triggerRect.left;
    if (a === "center")
      left = triggerRect.left + triggerRect.width / 2 - contentRect.width / 2;
    if (a === "end") left = triggerRect.right - contentRect.width;
  } else {
    // left/right: align vertically
    if (a === "start") top = triggerRect.top;
    if (a === "center")
      top = triggerRect.top + triggerRect.height / 2 - contentRect.height / 2;
    if (a === "end") top = triggerRect.bottom - contentRect.height;
  }

  // Clamp into viewport with a small margin
  const margin = 8;
  left = clamp(left, margin, vw - contentRect.width - margin);
  top = clamp(top, margin, vh - contentRect.height - margin);

  return { top, left };
}

function focusFirstItem(container) {
  if (!container) return;
  const items = Array.from(
    container.querySelectorAll(
      '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'
    )
  );
  const first = items.find(isFocusable);
  if (first) first.focus();
}

function focusLastItem(container) {
  if (!container) return;
  const items = Array.from(
    container.querySelectorAll(
      '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'
    )
  );
  for (let i = items.length - 1; i >= 0; i--) {
    if (isFocusable(items[i])) {
      items[i].focus();
      break;
    }
  }
}

function focusNext(container, dir) {
  if (!container) return;
  const items = Array.from(
    container.querySelectorAll(
      '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'
    )
  );
  const focusables = items.filter(isFocusable);
  if (!focusables.length) return;
  const active = document.activeElement;
  const idx = focusables.indexOf(active);
  const next = focusables[(idx + dir + focusables.length) % focusables.length];
  if (next) next.focus();
}

/* ------------------------------ content ------------------------------ */
export const DropdownMenuContent = React.forwardRef(
  function DropdownMenuContent(
    {
      className,
      align = "start",
      side = "bottom",
      sideOffset = 8,
      loop = true,
      forceMount = false,
      onEscapeKeyDown,
      onPointerDownOutside,
      onFocusOutside,
      ...props
    },
    ref
  ) {
    const { open, setOpen, modal, triggerRef, contentRef } = useMenuCtx(
      "DropdownMenuContent"
    );
    const [mounted, setMounted] = React.useState(false);
    const [pos, setPos] = React.useState({ top: 0, left: 0 });
    const portalEl = React.useMemo(
      () => (typeof document !== "undefined" ? document.body : null),
      []
    );

    const mergedRef = React.useCallback(
      (node) => {
        contentRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref, contentRef]
    );

    // Only render when open unless forceMount
    const shouldRender = forceMount || open;

    // Set mounted for enter transitions if desired
    React.useEffect(() => {
      if (open) {
        setMounted(true);
        const cancel = nextTick(() => {
          const trigger = triggerRef.current;
          const content = contentRef.current;
          if (!trigger || !content) return;

          // Position after it exists in DOM
          const tr = trigger.getBoundingClientRect();
          const cr = content.getBoundingClientRect();
          setPos(
            computePosition({
              triggerRect: tr,
              contentRect: cr,
              align,
              side,
              sideOffset,
            })
          );

          // Focus first item
          focusFirstItem(content);
        });
        return cancel;
      }
      // When closing, return focus to trigger
      if (!open) {
        const cancel = nextTick(() => {
          if (
            triggerRef.current &&
            typeof triggerRef.current.focus === "function"
          ) {
            triggerRef.current.focus();
          }
        });
        return cancel;
      }
    }, [open, align, side, sideOffset, triggerRef, contentRef]);

    // Reposition on resize/scroll while open
    React.useEffect(() => {
      if (!open) return;
      const handle = () => {
        const trigger = triggerRef.current;
        const content = contentRef.current;
        if (!trigger || !content) return;
        const tr = trigger.getBoundingClientRect();
        const cr = content.getBoundingClientRect();
        setPos(
          computePosition({
            triggerRect: tr,
            contentRect: cr,
            align,
            side,
            sideOffset,
          })
        );
      };
      window.addEventListener("resize", handle);
      window.addEventListener("scroll", handle, true);
      return () => {
        window.removeEventListener("resize", handle);
        window.removeEventListener("scroll", handle, true);
      };
    }, [open, align, side, sideOffset, triggerRef, contentRef]);

    // Close on outside click (and optionally focus outside)
    React.useEffect(() => {
      if (!open) return;

      const onDocPointerDown = (e) => {
        const content = contentRef.current;
        const trigger = triggerRef.current;
        const target = e.target;

        if (content && content.contains(target)) return;
        if (trigger && trigger.contains(target)) return;

        if (typeof onPointerDownOutside === "function") onPointerDownOutside(e);

        // In "modal" mode we always close on outside click.
        // In non-modal, we also close (standard dropdown behavior).
        setOpen(false);
      };

      const onDocFocusIn = (e) => {
        const content = contentRef.current;
        const trigger = triggerRef.current;
        const target = e.target;

        if (content && content.contains(target)) return;
        if (trigger && trigger.contains(target)) return;

        if (typeof onFocusOutside === "function") onFocusOutside(e);
        if (modal) setOpen(false);
      };

      document.addEventListener("pointerdown", onDocPointerDown, true);
      document.addEventListener("focusin", onDocFocusIn, true);
      return () => {
        document.removeEventListener("pointerdown", onDocPointerDown, true);
        document.removeEventListener("focusin", onDocFocusIn, true);
      };
    }, [
      open,
      setOpen,
      modal,
      onPointerDownOutside,
      onFocusOutside,
      triggerRef,
      contentRef,
    ]);

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        if (typeof onEscapeKeyDown === "function") onEscapeKeyDown(e);
        if (!e.defaultPrevented) setOpen(false);
        return;
      }

      const content = contentRef.current;
      if (!content) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        focusNext(content, +1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusNext(content, -1);
      } else if (e.key === "Home") {
        e.preventDefault();
        focusFirstItem(content);
      } else if (e.key === "End") {
        e.preventDefault();
        focusLastItem(content);
      } else if (e.key === "Tab") {
        // Keep focus within menu while open (common dropdown behavior)
        // If you want tabbing out, remove this.
        e.preventDefault();
        focusNext(content, e.shiftKey ? -1 : +1);
      }
    };

    const base =
      "z-50 min-w-[10rem] rounded-md border border-slate-200 bg-white p-1 " +
      "text-slate-800 shadow-lg outline-none";
    const animate = mounted && open ? "animate-in fade-in zoom-in-95" : "";
    // If you don't have animate utilities, the above is harmless.

    const contentNode = shouldRender ? (
      <div
        ref={mergedRef}
        role="menu"
        aria-orientation="vertical"
        data-ui="dropdown-content"
        data-state={open ? "open" : "closed"}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={cn(base, animate, className)}
        style={{
          position: "fixed",
          top: pos.top,
          left: pos.left,
        }}
        {...props}
      />
    ) : null;

    if (!portalEl) return null;
    return createPortal(
      <DropdownMenuContentContext.Provider
        value={{ close: () => setOpen(false) }}
      >
        {contentNode}
      </DropdownMenuContentContext.Provider>,
      portalEl
    );
  }
);

/* ------------------------------ primitives ------------------------------ */
export const DropdownMenuLabel = React.forwardRef(function DropdownMenuLabel(
  { className, inset = false, ...props },
  ref
) {
  return (
    <div
      ref={ref}
      role="presentation"
      data-ui="dropdown-label"
      className={cn(
        "px-2 py-1.5 text-xs font-semibold text-slate-600",
        inset && "pl-8",
        className
      )}
      {...props}
    />
  );
});

export const DropdownMenuSeparator = React.forwardRef(
  function DropdownMenuSeparator({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        role="separator"
        aria-orientation="horizontal"
        data-ui="dropdown-separator"
        className={cn("my-1 h-px bg-slate-200", className)}
        {...props}
      />
    );
  }
);

export function DropdownMenuShortcut({ className, ...props }) {
  return (
    <span
      data-ui="dropdown-shortcut"
      className={cn("ml-auto text-xs tracking-wide text-slate-500", className)}
      {...props}
    />
  );
}

function BaseItem({
  role = "menuitem",
  className,
  inset = false,
  disabled = false,
  onSelect,
  closeOnSelect = true,
  leftSlot,
  rightSlot,
  children,
  ...props
}) {
  const { close } = useContentCtx("DropdownMenuItem");
  const handleClick = (e) => {
    if (disabled) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (typeof onSelect === "function") onSelect(e);
    if (closeOnSelect) close();
  };

  const handleKeyDown = (e) => {
    if (disabled) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (typeof onSelect === "function") onSelect(e);
      if (closeOnSelect) close();
    }
  };

  const base =
    "relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm " +
    "outline-none transition-colors";
  const hover =
    "focus:bg-slate-100 focus:text-slate-900 data-[highlighted=true]:bg-slate-100";
  const disabledCls = "opacity-50 pointer-events-none";
  const insetCls = inset ? "pl-8" : "";
  const leftSlotCls =
    "mr-2 flex h-4 w-4 items-center justify-center text-slate-600";
  const rightSlotCls =
    "ml-auto flex items-center justify-center text-slate-500";

  return (
    <div
      role={role}
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled ? "true" : undefined}
      data-ui="dropdown-item"
      className={cn(base, hover, insetCls, disabled && disabledCls, className)}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      {...props}
    >
      {leftSlot ? <span className={leftSlotCls}>{leftSlot}</span> : null}
      <span className="min-w-0 flex-1">{children}</span>
      {rightSlot ? <span className={rightSlotCls}>{rightSlot}</span> : null}
    </div>
  );
}

export const DropdownMenuItem = React.forwardRef(function DropdownMenuItem(
  {
    className,
    inset = false,
    disabled = false,
    onSelect,
    closeOnSelect = true,
    ...props
  },
  ref
) {
  return (
    <div ref={ref}>
      <BaseItem
        role="menuitem"
        className={className}
        inset={inset}
        disabled={disabled}
        onSelect={onSelect}
        closeOnSelect={closeOnSelect}
        {...props}
      />
    </div>
  );
});

export const DropdownMenuCheckboxItem = React.forwardRef(
  function DropdownMenuCheckboxItem(
    {
      className,
      checked,
      defaultChecked = false,
      onCheckedChange,
      disabled = false,
      inset = false,
      closeOnSelect = false,
      children,
      ...props
    },
    ref
  ) {
    const [val, setVal] = useControllableState({
      value: checked,
      defaultValue: defaultChecked,
      onChange: onCheckedChange,
    });

    return (
      <div ref={ref}>
        <BaseItem
          role="menuitemcheckbox"
          aria-checked={val ? "true" : "false"}
          className={className}
          inset={inset}
          disabled={disabled}
          closeOnSelect={closeOnSelect}
          leftSlot={val ? <CheckIcon /> : <span className="h-4 w-4" />}
          onSelect={() => setVal(!val)}
          {...props}
        >
          {children}
        </BaseItem>
      </div>
    );
  }
);

export function DropdownMenuRadioGroup({
  value,
  defaultValue,
  onValueChange,
  children,
}) {
  const [v, setV] = useControllableState({
    value,
    defaultValue,
    onChange: onValueChange,
  });

  const ctx = React.useMemo(() => ({ value: v, setValue: setV }), [v, setV]);

  return (
    <DropdownMenuRadioContext.Provider value={ctx}>
      {children}
    </DropdownMenuRadioContext.Provider>
  );
}

export const DropdownMenuRadioItem = React.forwardRef(
  function DropdownMenuRadioItem(
    {
      className,
      value,
      disabled = false,
      inset = false,
      closeOnSelect = false,
      children,
      ...props
    },
    ref
  ) {
    const ctx = React.useContext(DropdownMenuRadioContext);
    if (!ctx)
      throw new Error(
        "DropdownMenuRadioItem must be used within <DropdownMenuRadioGroup />"
      );
    const selected = ctx.value === value;

    return (
      <div ref={ref}>
        <BaseItem
          role="menuitemradio"
          aria-checked={selected ? "true" : "false"}
          className={className}
          inset={inset}
          disabled={disabled}
          closeOnSelect={closeOnSelect}
          leftSlot={selected ? <DotIcon /> : <span className="h-4 w-4" />}
          onSelect={() => ctx.setValue(value)}
          {...props}
        >
          {children}
        </BaseItem>
      </div>
    );
  }
);

/* ------------------------------ submenus ------------------------------ */
/**
 * Minimal submenu support:
 * <DropdownMenuSub>
 *   <DropdownMenuSubTrigger>More...</DropdownMenuSubTrigger>
 *   <DropdownMenuSubContent>...</DropdownMenuSubContent>
 * </DropdownMenuSub>
 *
 * Sub menus open on hover/focus and via ArrowRight.
 */
const DropdownSubContext = React.createContext(null);

export function DropdownMenuSub({
  children,
  open,
  defaultOpen = false,
  onOpenChange,
}) {
  const [isOpen, setIsOpen] = useControllableState({
    value: open,
    defaultValue: defaultOpen,
    onChange: onOpenChange,
  });

  const triggerRef = React.useRef(null);
  const contentRef = React.useRef(null);

  const ctx = React.useMemo(
    () => ({ open: isOpen, setOpen: setIsOpen, triggerRef, contentRef }),
    [isOpen, setIsOpen]
  );

  return (
    <DropdownSubContext.Provider value={ctx}>
      {children}
    </DropdownSubContext.Provider>
  );
}

function useSubCtx(name) {
  const ctx = React.useContext(DropdownSubContext);
  if (!ctx) throw new Error(`${name} must be used within <DropdownMenuSub />`);
  return ctx;
}

export const DropdownMenuSubTrigger = React.forwardRef(
  function DropdownMenuSubTrigger(
    { className, inset = false, disabled = false, children, ...props },
    ref
  ) {
    const { open, setOpen, triggerRef, contentRef } = useSubCtx(
      "DropdownMenuSubTrigger"
    );
    const { close: closeRoot } = useContentCtx("DropdownMenuSubTrigger");

    const mergedRef = React.useCallback(
      (node) => {
        triggerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref, triggerRef]
    );

    const openNow = () => {
      if (disabled) return;
      setOpen(true);
    };

    const closeNow = () => setOpen(false);

    const onKeyDown = (e) => {
      if (disabled) return;
      if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openNow();
        nextTick(() => focusFirstItem(contentRef.current));
      } else if (e.key === "ArrowLeft" || e.key === "Escape") {
        e.preventDefault();
        closeNow();
      }
    };

    return (
      <div ref={mergedRef}>
        <BaseItem
          role="menuitem"
          className={className}
          inset={inset}
          disabled={disabled}
          closeOnSelect={false}
          rightSlot={<ChevronRightIcon />}
          onSelect={() => openNow()}
          onMouseEnter={openNow}
          onMouseLeave={() => {
            // If pointer moves away from trigger, we don't immediately close—submenu content handles it.
          }}
          onKeyDown={onKeyDown}
          {...props}
        >
          {children}
        </BaseItem>
      </div>
    );
  }
);

export const DropdownMenuSubContent = React.forwardRef(
  function DropdownMenuSubContent(
    {
      className,
      sideOffset = 8,
      align = "start",
      forceMount = false,
      ...props
    },
    ref
  ) {
    const { open, setOpen, triggerRef, contentRef } = useSubCtx(
      "DropdownMenuSubContent"
    );
    const [pos, setPos] = React.useState({ top: 0, left: 0 });
    const portalEl = React.useMemo(
      () => (typeof document !== "undefined" ? document.body : null),
      []
    );

    const mergedRef = React.useCallback(
      (node) => {
        contentRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref, contentRef]
    );

    React.useEffect(() => {
      if (!open) return;
      const cancel = nextTick(() => {
        const trigger = triggerRef.current;
        const content = contentRef.current;
        if (!trigger || !content) return;

        const tr = trigger.getBoundingClientRect();
        const cr = content.getBoundingClientRect();
        // submenus always open to the right, but clamp to viewport
        setPos(
          computePosition({
            triggerRect: tr,
            contentRect: cr,
            align,
            side: "right",
            sideOffset,
          })
        );

        focusFirstItem(content);
      });
      return cancel;
    }, [open, align, sideOffset, triggerRef, contentRef]);

    React.useEffect(() => {
      if (!open) return;

      const onDocPointerDown = (e) => {
        const content = contentRef.current;
        const trigger = triggerRef.current;
        if (content && content.contains(e.target)) return;
        if (trigger && trigger.contains(e.target)) return;
        setOpen(false);
      };

      document.addEventListener("pointerdown", onDocPointerDown, true);
      return () =>
        document.removeEventListener("pointerdown", onDocPointerDown, true);
    }, [open, setOpen, triggerRef, contentRef]);

    const onMouseEnter = () => setOpen(true);
    const onMouseLeave = (e) => {
      // If leaving submenu content, close
      setOpen(false);
    };

    const shouldRender = forceMount || open;

    const base =
      "z-50 min-w-[10rem] rounded-md border border-slate-200 bg-white p-1 " +
      "text-slate-800 shadow-lg outline-none";

    const node = shouldRender ? (
      <div
        ref={mergedRef}
        role="menu"
        tabIndex={-1}
        data-ui="dropdown-subcontent"
        data-state={open ? "open" : "closed"}
        className={cn(base, className)}
        style={{ position: "fixed", top: pos.top, left: pos.left }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        {...props}
      />
    ) : null;

    if (!portalEl) return null;
    return createPortal(node, portalEl);
  }
);

/* ------------------------------ exports ------------------------------ */
export default DropdownMenu;
