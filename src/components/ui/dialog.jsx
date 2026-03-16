// C:\Users\larho\suka-smart-assistant\src\components\ui\dialog.jsx
/* eslint-disable react/prop-types */
/* eslint-disable no-console */
/**
 * SSA • UI Dialog (dependency-free, shadcn-style exports)
 * -----------------------------------------------------------------------------
 * Purpose:
 *  - Your codebase imports "@/components/ui/dialog"
 *  - If you don't have shadcn/ui + Radix installed, Vite build fails
 *  - This file provides a production-grade, browser-safe dialog implementation
 *
 * Features:
 *  - Controlled OR uncontrolled open state (open/defaultOpen/onOpenChange)
 *  - DialogTrigger + DialogClose (supports asChild)
 *  - Overlay click-to-close (configurable)
 *  - ESC-to-close (configurable)
 *  - Focus management: autofocus first focusable; trap focus while open
 *  - Body scroll lock while open (restores on close)
 *  - Accessible roles/aria attributes
 *  - Zero external dependencies
 *
 * API shape:
 *  export {
 *    Dialog,
 *    DialogTrigger,
 *    DialogPortal,
 *    DialogOverlay,
 *    DialogClose,
 *    DialogContent,
 *    DialogHeader,
 *    DialogFooter,
 *    DialogTitle,
 *    DialogDescription
 *  }
 *
 * Notes:
 *  - This intentionally mimics the common shadcn/Radix component names so your
 *    existing imports work without needing Radix.
 *  - If you later adopt Radix/shadcn, you can swap this file.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const DialogContext = createContext(null);

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function isBrowser() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function getFocusableElements(root) {
  if (!root || !root.querySelectorAll) return [];
  const selectors = [
    "a[href]",
    "area[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type='hidden'])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "iframe",
    "object",
    "embed",
    "[contenteditable='true']",
    "[tabindex]:not([tabindex='-1'])",
  ];
  const nodes = Array.from(root.querySelectorAll(selectors.join(",")));
  // Filter out invisible elements
  return nodes.filter((el) => {
    const style = window.getComputedStyle(el);
    return style && style.visibility !== "hidden" && style.display !== "none";
  });
}

function useControlledState(controlled, defaultValue, onChange) {
  const isControlled = controlled !== undefined;
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const value = isControlled ? controlled : uncontrolled;

  const setValue = (next) => {
    const v = typeof next === "function" ? next(value) : next;
    if (!isControlled) setUncontrolled(v);
    onChange?.(v);
  };

  return [value, setValue, isControlled];
}

function mergeHandlers(a, b) {
  return (e, ...rest) => {
    a?.(e, ...rest);
    if (!e?.defaultPrevented) b?.(e, ...rest);
  };
}

/**
 * Dialog
 * - Provides context for children
 * - Supports controlled/uncontrolled
 */
export function Dialog({ open, defaultOpen = false, onOpenChange, children }) {
  const [isOpen, setOpen] = useControlledState(open, defaultOpen, onOpenChange);

  const value = useMemo(
    () => ({
      open: !!isOpen,
      setOpen,
    }),
    [isOpen, setOpen]
  );

  return (
    <DialogContext.Provider value={value}>{children}</DialogContext.Provider>
  );
}

function useDialogCtx(componentName) {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error(`${componentName} must be used within <Dialog>.`);
  return ctx;
}

/**
 * DialogTrigger
 * - Opens the dialog
 * - asChild: clones child and attaches onClick
 */
export function DialogTrigger({
  asChild = false,
  children,
  onClick,
  ...props
}) {
  const { setOpen } = useDialogCtx("DialogTrigger");

  const handleClick = mergeHandlers(onClick, () => setOpen(true));

  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, {
      ...props,
      onClick: handleClick,
    });
  }

  return (
    <button type="button" {...props} onClick={handleClick}>
      {children}
    </button>
  );
}

/**
 * DialogClose
 * - Closes the dialog
 * - asChild supported
 */
export function DialogClose({ asChild = false, children, onClick, ...props }) {
  const { setOpen } = useDialogCtx("DialogClose");

  const handleClick = mergeHandlers(onClick, () => setOpen(false));

  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, {
      ...props,
      onClick: handleClick,
    });
  }

  return (
    <button type="button" {...props} onClick={handleClick}>
      {children}
    </button>
  );
}

/**
 * DialogPortal
 * - Kept for compatibility. This implementation renders inline.
 * - If you ever want true portal behavior, you can upgrade this to createPortal.
 */
export function DialogPortal({ children }) {
  return children;
}

/**
 * DialogOverlay
 * - Optional overlay element (compat). Usually you’ll rely on DialogContent’s overlay.
 */
export function DialogOverlay({ className, ...props }) {
  return (
    <div className={cx("absolute inset-0 bg-black/40", className)} {...props} />
  );
}

/**
 * DialogContent
 * -----------------------------------------------------------------------------
 * Props:
 *  - open is derived from context
 *  - onEscapeKeyDown(event): call event.preventDefault() to block close
 *  - onInteractOutside(event): called on overlay mouse down; preventDefault blocks close
 *  - disableOutsideClose: if true, clicking overlay won't close
 *  - disableEscapeClose: if true, ESC won't close
 *  - initialFocusRef: element to focus when opened (optional)
 *  - restoreFocus: defaults true, restores previously focused element on close
 */
export function DialogContent({
  children,
  className,
  overlayClassName,
  onEscapeKeyDown,
  onInteractOutside,
  disableOutsideClose = false,
  disableEscapeClose = false,
  initialFocusRef,
  restoreFocus = true,
  "aria-label": ariaLabel,
  ...props
}) {
  const { open, setOpen } = useDialogCtx("DialogContent");

  const panelRef = useRef(null);
  const lastActiveRef = useRef(null);

  // Track last active element to restore focus
  useEffect(() => {
    if (!isBrowser()) return;
    if (open) {
      lastActiveRef.current = document.activeElement;
    }
  }, [open]);

  // Scroll lock + focus + key handling (ESC + focus trap)
  useEffect(() => {
    if (!isBrowser()) return;
    if (!open) return;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusPanel = () => {
      const panel = panelRef.current;
      if (!panel) return;

      // Prefer initialFocusRef if provided
      if (
        initialFocusRef?.current &&
        typeof initialFocusRef.current.focus === "function"
      ) {
        initialFocusRef.current.focus();
        return;
      }

      // Focus the first focusable within panel, else the panel itself
      const focusables = getFocusableElements(panel);
      if (focusables.length) {
        focusables[0].focus();
      } else if (typeof panel.focus === "function") {
        panel.focus();
      }
    };

    // Ensure focus after render
    const t = window.setTimeout(focusPanel, 0);

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        onEscapeKeyDown?.(e);
        if (disableEscapeClose) return;
        if (!e.defaultPrevented) setOpen(false);
        return;
      }

      // Focus trap: TAB cycles within dialog
      if (e.key === "Tab") {
        const panel = panelRef.current;
        if (!panel) return;

        const focusables = getFocusableElements(panel);
        if (!focusables.length) {
          e.preventDefault();
          return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;

        if (e.shiftKey) {
          if (active === first || active === panel) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, setOpen, onEscapeKeyDown, disableEscapeClose, initialFocusRef]);

  // Restore focus on close
  useEffect(() => {
    if (!isBrowser()) return;
    if (open) return;
    if (!restoreFocus) return;

    const el = lastActiveRef.current;
    if (el && typeof el.focus === "function") {
      try {
        el.focus();
      } catch (e) {
        // ignore
      }
    }
  }, [open, restoreFocus]);

  if (!open) return null;

  const onOverlayMouseDown = (e) => {
    onInteractOutside?.(e);
    if (disableOutsideClose) return;
    if (!e.defaultPrevented) setOpen(false);
  };

  const onPanelMouseDown = (e) => {
    // prevent overlay handler from firing when clicking inside
    e.stopPropagation();
  };

  return (
    <div
      className={cx(
        "fixed inset-0 z-[80] flex items-center justify-center p-4",
        overlayClassName
      )}
      onMouseDown={onOverlayMouseDown}
    >
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel || "Dialog"}
        tabIndex={-1}
        className={cx(
          "relative z-[81] w-full max-w-3xl rounded-2xl border border-gray-200 bg-white shadow-xl outline-none",
          className
        )}
        onMouseDown={onPanelMouseDown}
        {...props}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * DialogHeader / Footer / Title / Description
 * - Simple layout helpers consistent with SSA card styling
 */
export function DialogHeader({ className, children, ...props }) {
  return (
    <div
      className={cx("px-5 pt-5 pb-3 border-b border-gray-200", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function DialogFooter({ className, children, ...props }) {
  return (
    <div
      className={cx(
        "px-5 py-4 border-t border-gray-200 flex items-center justify-end gap-2 flex-wrap",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function DialogTitle({ className, children, ...props }) {
  return (
    <div className={cx("text-base font-bold", className)} {...props}>
      {children}
    </div>
  );
}

export function DialogDescription({ className, children, ...props }) {
  return (
    <div className={cx("text-sm opacity-80 mt-1", className)} {...props}>
      {children}
    </div>
  );
}
