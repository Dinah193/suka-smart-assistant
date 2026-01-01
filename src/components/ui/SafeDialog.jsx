// src/components/ui/SafeDialog.jsx
/* eslint-disable react/prop-types */
// A tiny, dependency-free dialog shim (portal + overlay + ESC to close).
// Works in controlled (open/onOpenChange) and uncontrolled modes.

import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

/* ---------------- Context ---------------- */
const DialogCtx = React.createContext(null);
function useDialogCtx() {
  const ctx = useContext(DialogCtx);
  if (!ctx) throw new Error("Dialog components must be used inside <Dialog>.");
  return ctx;
}

/* ---------------- Root ---------------- */
export default function Dialog({ open, onOpenChange, children }) {
  const [uOpen, setUOpen] = useState(false);
  const controlled = typeof open === "boolean";

  const value = useMemo(
    () => ({
      open: controlled ? !!open : uOpen,
      setOpen: (v) => {
        if (controlled) onOpenChange && onOpenChange(!!v);
        else setUOpen(!!v);
      },
    }),
    [controlled, open, onOpenChange, uOpen]
  );

  return <DialogCtx.Provider value={value}>{children}</DialogCtx.Provider>;
}

/* ---------------- Trigger ---------------- */
export function DialogTrigger({ asChild, children }) {
  const { setOpen } = useDialogCtx();
  const handle = useCallback(() => setOpen(true), [setOpen]);

  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, {
      onClick: (e) => {
        children.props?.onClick?.(e);
        handle();
      },
    });
  }
  return (
    <button className="btn sm" onClick={handle} type="button">
      {children}
    </button>
  );
}

/* ---------------- Portal root (once) ---------------- */
function usePortalRoot(id = "suka-dialog-root") {
  const elRef = useRef(null);
  useEffect(() => {
    let root = document.getElementById(id);
    if (!root) {
      root = document.createElement("div");
      root.id = id;
      document.body.appendChild(root);
    }
    elRef.current = root;
  }, [id]);
  return elRef.current;
}

/* ---------------- Content + Overlay ---------------- */
export function DialogContent({ children, className, onEscapeClose = true }) {
  const { open, setOpen } = useDialogCtx();
  const portal = usePortalRoot();

  useEffect(() => {
    if (!open || !onEscapeClose) return;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onEscapeClose, setOpen]);

  if (!open || !portal) return null;

  return createPortal(
    <>
      <div
        className="fixed inset-0 bg-black/40"
        onClick={() => setOpen(false)}
        aria-hidden="true"
        style={{ zIndex: 50 }}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={[
          "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-xl shadow-xl p-4",
          "w-[min(680px,92vw)] max-h-[88vh] overflow-auto",
          className || "",
        ].join(" ")}
        style={{ zIndex: 51 }}
      >
        {children}
      </div>
    </>,
    portal
  );
}

/* ---------------- Helpers (semantic) ---------------- */
export function DialogHeader({ children, className }) {
  return <div className={className} style={{ marginBottom: 8 }}>{children}</div>;
}
export function DialogTitle({ children, className }) {
  return <h3 className={className} style={{ fontWeight: 700 }}>{children}</h3>;
}
export function DialogDescription({ children, className }) {
  return <p className={className} style={{ opacity: 0.8 }}>{children}</p>;
}
export function DialogClose({ children = "Close", className }) {
  const { setOpen } = useDialogCtx();
  return (
    <button className={["btn sm", className || ""].join(" ")} onClick={() => setOpen(false)} type="button">
      {children}
    </button>
  );
}
