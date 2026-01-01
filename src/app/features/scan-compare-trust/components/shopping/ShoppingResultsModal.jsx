// src/app/features/scan-compare-trust/components/shopping/ShoppingResultsModal.jsx
// -----------------------------------------------------------------------------
// ShoppingResultsModal
// -----------------------------------------------------------------------------
// Purpose:
// - Popup modal that shows scan "Results" for one candidate
// - Updates instantly because the parent passes a live-updated candidate object
// - Actions:
//    - Return to shelf (status: removed)
//    - In cart (status: in_cart)
//    - Keep browsing (close modal)
// -----------------------------------------------------------------------------

import React, { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ShoppingCart, Undo2 } from "lucide-react";
import ShoppingCandidateCard from "@/app/features/scan-compare-trust/components/shopping/ShoppingCandidateCard";

export default function ShoppingResultsModal({
  open,
  onOpenChange,
  candidate,
  onReturnToShelf,
  onInCart,
  onKeepBrowsing,
}) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onOpenChange?.(false);
    }
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const id = candidate?.id;

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-[9999] flex items-end sm:items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          aria-modal="true"
          role="dialog"
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => onOpenChange?.(false)}
          />

          {/* Modal sheet */}
          <motion.div
            className="relative w-full sm:max-w-2xl bg-background rounded-t-2xl sm:rounded-2xl border shadow-lg overflow-hidden"
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 24 }}
          >
            <div className="px-4 py-3 border-b flex items-center justify-between gap-2">
              <div className="text-sm font-medium">Results</div>
              <button
                className="p-2 rounded-md border hover:bg-muted"
                onClick={() => onOpenChange?.(false)}
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-4">
              {!candidate ? (
                <div className="text-sm text-muted-foreground">
                  Waiting for scan…
                </div>
              ) : (
                <ShoppingCandidateCard candidate={candidate} />
              )}

              {/* Actions */}
              <div className="mt-4 flex flex-col sm:flex-row gap-2 sm:justify-end">
                <button
                  className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md border hover:bg-muted"
                  onClick={() => {
                    if (!id) return;
                    onReturnToShelf?.(id);
                    onOpenChange?.(false);
                  }}
                  disabled={!id}
                >
                  <Undo2 className="h-4 w-4" />
                  Return to shelf
                </button>

                <button
                  className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-black text-white hover:opacity-95"
                  onClick={() => {
                    if (!id) return;
                    onInCart?.(id);
                    onOpenChange?.(false);
                  }}
                  disabled={!id}
                >
                  <ShoppingCart className="h-4 w-4" />
                  In cart
                </button>

                <button
                  className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md border hover:bg-muted"
                  onClick={() => {
                    onKeepBrowsing?.();
                    onOpenChange?.(false);
                  }}
                >
                  Keep browsing
                </button>
              </div>
            </div>

            {/* Bottom safe area for mobile */}
            <div className="h-2" />
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
