import React from "react";
import {
  FileText,
  CheckCircle2,
  AlertTriangle,
  X,
  ArrowLeftRight,
} from "lucide-react";

export default function ReceiptModePanel({
  selectedStores = [],
  shoppingSessionId,
  candidatesCount = 0,
  receiptDraft,
  onClearReceipt,
  onCommitRequest,
  onStoresEdit,
}) {
  const stores = Array.isArray(selectedStores) ? selectedStores : [];
  const hasStores = stores.length > 0;
  const hasReceipt = !!receiptDraft;

  return (
    <div className="space-y-3">
      {/* Context */}
      <div className="rounded-lg border p-3 bg-muted/20">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium flex items-center gap-2">
              <FileText className="h-4 w-4" /> Receipt Mode
            </div>
            <div className="text-[12px] text-muted-foreground mt-1">
              Capture the receipt (image or text). Then request
              reconciliation/commit.
            </div>

            <div className="mt-2 text-[11px] text-muted-foreground">
              Session:{" "}
              {shoppingSessionId ? (
                <span className="font-medium">
                  {String(shoppingSessionId).slice(0, 18)}…
                </span>
              ) : (
                <span className="text-amber-700 font-medium">none</span>
              )}
              {" • "}
              Candidates: <span className="font-medium">{candidatesCount}</span>
            </div>

            <div className="mt-1 text-[11px] text-muted-foreground">
              Stores:{" "}
              {hasStores ? (
                <span className="font-medium">{stores.join(", ")}</span>
              ) : (
                <span className="text-amber-700 font-medium">
                  select stores first
                </span>
              )}
            </div>
          </div>

          <button
            className="px-2 py-1 text-xs rounded-md border hover:bg-muted shrink-0"
            onClick={onStoresEdit}
            title="Edit stores"
          >
            <ArrowLeftRight className="h-4 w-4 inline mr-1" /> Stores
          </button>
        </div>
      </div>

      {/* Receipt draft preview */}
      <div className="rounded-lg border p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-medium">Captured Receipt</div>
          <button
            className="px-2 py-1 text-xs rounded-md border hover:bg-muted"
            onClick={onClearReceipt}
            disabled={!hasReceipt}
            title="Clear receipt"
          >
            <X className="h-4 w-4 inline mr-1" /> Clear
          </button>
        </div>

        {!hasReceipt ? (
          <div className="mt-2 text-[12px] text-muted-foreground">
            No receipt captured yet. Use the camera “Receipt” button, upload an
            image, or paste receipt text below.
          </div>
        ) : (
          <div className="mt-2 rounded-md border p-2">
            <div className="text-sm font-medium">
              {receiptDraft.kind === "image"
                ? "Receipt Image"
                : receiptDraft.kind === "text"
                ? "Receipt Text"
                : receiptDraft.kind === "barcode"
                ? "Receipt Barcode"
                : "Receipt"}
            </div>
            <div className="text-[11px] text-muted-foreground mt-1">
              Source: {receiptDraft.source || "unknown"} •{" "}
              {new Date(receiptDraft.at || Date.now()).toLocaleString()}
            </div>

            {receiptDraft.kind === "text" ? (
              <div className="mt-2 text-xs whitespace-pre-wrap max-h-40 overflow-auto">
                {String(receiptDraft.content || "").slice(0, 1500)}
              </div>
            ) : null}

            {receiptDraft.kind === "image" ? (
              <div className="mt-2">
                {/* content is an objectURL; safe to render */}
                <img
                  src={receiptDraft.content}
                  alt="Receipt"
                  className="max-h-52 rounded-md border object-contain"
                />
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* Commit call-to-action */}
      <div className="rounded-lg border p-3">
        <div className="flex items-start gap-2">
          {!hasStores ? (
            <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />
          ) : !hasReceipt ? (
            <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />
          ) : (
            <CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5" />
          )}

          <div className="min-w-0">
            <div className="text-sm font-medium">
              Request Reconcile → Commit
            </div>
            <div className="text-[12px] text-muted-foreground mt-1">
              This will trigger your downstream blueprint builder to run receipt
              reconciliation, record price observations, apply
              coupons/recalls/ingredients checks, then commit.
            </div>

            <div className="mt-2">
              <button
                className="px-3 py-2 text-sm rounded-md border hover:bg-muted disabled:opacity-60"
                onClick={onCommitRequest}
                disabled={!hasStores || !hasReceipt}
                title={
                  !hasStores
                    ? "Select stores first"
                    : !hasReceipt
                    ? "Capture receipt first"
                    : "Request commit"
                }
              >
                <CheckCircle2 className="h-4 w-4 inline mr-1" />
                Request Commit
              </button>
            </div>

            {!hasStores ? (
              <div className="mt-2 text-[11px] text-amber-700">
                Stores are required so comparisons and observations are
                store-specific.
              </div>
            ) : null}
            {!hasReceipt ? (
              <div className="mt-2 text-[11px] text-amber-700">
                Receipt is required. Shopping candidates remain staged until
                receipt commit.
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
