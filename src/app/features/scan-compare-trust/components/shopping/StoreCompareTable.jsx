import React, { useMemo } from "react";
import {
  TrendingDown,
  TrendingUp,
  Minus,
  CheckCircle2,
  XCircle,
} from "lucide-react";

/**
 * StoreCompareTable
 * -----------------------------------------------------------------------------
 * Props:
 * - stores: ["Walmart", "Target", ...] (optional)
 * - rows: [{ store, price, unitPrice, currency, inStock, at, source, confidence }]
 * - highlightStore: string (optional)
 *
 * Behavior:
 * - sorts by price (if present)
 * - shows "best price" indicator
 * - safe for partial/unknown data
 */

export default function StoreCompareTable({
  stores = [],
  rows = [],
  highlightStore,
}) {
  const list = Array.isArray(rows) ? rows : [];
  const highlight = String(highlightStore || "")
    .trim()
    .toLowerCase();

  const sorted = useMemo(() => {
    const xs = list.slice();
    xs.sort((a, b) => {
      const ap = num(a?.price);
      const bp = num(b?.price);
      if (ap == null && bp == null)
        return String(a?.store || "").localeCompare(String(b?.store || ""));
      if (ap == null) return 1;
      if (bp == null) return -1;
      return ap - bp;
    });
    return xs;
  }, [list]);

  const best = useMemo(() => {
    const priced = sorted.filter((r) => num(r?.price) != null);
    return priced.length ? priced[0] : null;
  }, [sorted]);

  return (
    <div className="rounded-lg border overflow-hidden">
      <div className="px-3 py-2 text-sm font-medium border-b">
        Compare by Store
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-muted/40 text-[12px] text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Store</th>
              <th className="text-left px-3 py-2 font-medium">Price</th>
              <th className="text-left px-3 py-2 font-medium">Unit</th>
              <th className="text-left px-3 py-2 font-medium">Stock</th>
              <th className="text-left px-3 py-2 font-medium">Trend</th>
            </tr>
          </thead>

          <tbody>
            {sorted.map((r, idx) => {
              const store = String(r?.store || "").trim() || `Store ${idx + 1}`;
              const price = num(r?.price);
              const unit = num(r?.unitPrice);
              const currency = r?.currency || "USD";

              const isBest =
                best && norm(best.store) === norm(store) && price != null;
              const isHighlight = highlight && norm(store) === highlight;

              const rowTone = isBest
                ? "bg-emerald-50/40"
                : isHighlight
                ? "bg-indigo-50/40"
                : "";

              const trend = computeTrendIndicator(price, best?.price);

              return (
                <tr key={`${store}:${idx}`} className={`border-t ${rowTone}`}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{store}</span>
                      {isBest ? (
                        <span className="text-[11px] px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">
                          Best
                        </span>
                      ) : null}
                      {isHighlight ? (
                        <span className="text-[11px] px-2 py-0.5 rounded-full border bg-indigo-50 text-indigo-700 border-indigo-200">
                          Current
                        </span>
                      ) : null}
                    </div>
                  </td>

                  <td className="px-3 py-2">
                    {price == null ? (
                      <span className="text-muted-foreground text-[12px]">
                        —
                      </span>
                    ) : (
                      <span className="font-medium">
                        {fmt(price, currency)}
                      </span>
                    )}
                  </td>

                  <td className="px-3 py-2">
                    {unit == null ? (
                      <span className="text-muted-foreground text-[12px]">
                        —
                      </span>
                    ) : (
                      <span className="text-[12px] text-muted-foreground">
                        {fmt(unit, currency)}/{String(r?.unit || "unit")}
                      </span>
                    )}
                  </td>

                  <td className="px-3 py-2">
                    {typeof r?.inStock === "boolean" ? (
                      r.inStock ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700 text-[12px]">
                          <CheckCircle2 className="h-4 w-4" /> In
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-red-700 text-[12px]">
                          <XCircle className="h-4 w-4" /> Out
                        </span>
                      )
                    ) : (
                      <span className="text-muted-foreground text-[12px]">
                        —
                      </span>
                    )}
                  </td>

                  <td className="px-3 py-2">
                    {trend.kind === "best" ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700 text-[12px]">
                        <TrendingDown className="h-4 w-4" /> Best
                      </span>
                    ) : trend.kind === "worse" ? (
                      <span className="inline-flex items-center gap-1 text-amber-800 text-[12px]">
                        <TrendingUp className="h-4 w-4" /> +{trend.deltaPct}%
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-muted-foreground text-[12px]">
                        <Minus className="h-4 w-4" /> —
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}

            {sorted.length === 0 ? (
              <tr>
                <td
                  className="px-3 py-3 text-[12px] text-muted-foreground"
                  colSpan={5}
                >
                  No store observations yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="px-3 py-2 text-[11px] text-muted-foreground border-t">
        Tip: “Best” is computed from the lowest available price across known
        observations.
      </div>
    </div>
  );
}

/* ------------------------------ Helpers ------------------------------ */

function computeTrendIndicator(price, bestPrice) {
  const p = num(price);
  const b = num(bestPrice);
  if (p == null || b == null) return { kind: "unknown" };
  if (p === b) return { kind: "best", deltaPct: 0 };
  if (b <= 0) return { kind: "unknown" };
  const delta = ((p - b) / b) * 100;
  return { kind: "worse", deltaPct: Math.max(0, Math.round(delta)) };
}

function fmt(value, currency = "USD") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: String(currency || "USD"),
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function norm(x) {
  return String(x || "")
    .trim()
    .toLowerCase();
}
