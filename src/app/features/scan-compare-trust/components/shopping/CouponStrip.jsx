import React, { useMemo, useState } from "react";
import { Tag, Copy, ExternalLink, ChevronDown, ChevronUp } from "lucide-react";

/**
 * CouponStrip
 * -----------------------------------------------------------------------------
 * Props:
 * - coupons: [{ id, title, amountOff, pctOff, store, expiresAt, code, url, notes }]
 * - stores: selected store list (optional)
 *
 * Behavior:
 * - shows top 1–2 coupons inline
 * - expandable for all coupons
 * - safe formatting, copy-to-clipboard if code exists
 */

export default function CouponStrip({ coupons = [], stores = [] }) {
  const list = Array.isArray(coupons) ? coupons : [];
  const [open, setOpen] = useState(false);

  const sorted = useMemo(() => {
    const xs = list.slice();
    xs.sort((a, b) => {
      const ae = toTs(a?.expiresAt);
      const be = toTs(b?.expiresAt);
      if (ae == null && be == null) return 0;
      if (ae == null) return 1;
      if (be == null) return -1;
      return ae - be;
    });
    return xs;
  }, [list]);

  const primary = open ? sorted : sorted.slice(0, 2);

  return (
    <div className="rounded-lg border bg-emerald-50/30 overflow-hidden">
      <div className="px-3 py-2 flex items-center justify-between border-b bg-emerald-50/50">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Tag className="h-4 w-4 text-emerald-700" /> Coupons
          <span className="text-[11px] text-muted-foreground">
            ({sorted.length})
          </span>
        </div>
        <button
          className="px-2 py-1 text-xs rounded-md border hover:bg-white/60"
          onClick={() => setOpen((x) => !x)}
        >
          {open ? (
            <>
              <ChevronUp className="h-4 w-4 inline mr-1" /> Less
            </>
          ) : (
            <>
              <ChevronDown className="h-4 w-4 inline mr-1" /> More
            </>
          )}
        </button>
      </div>

      <div className="p-3 space-y-2">
        {primary.map((c, idx) => (
          <CouponRow key={c?.id || idx} coupon={c} />
        ))}

        {sorted.length === 0 ? (
          <div className="text-[12px] text-muted-foreground">
            No coupons found.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CouponRow({ coupon }) {
  const c = coupon || {};
  const title = String(c.title || c.label || "Coupon").trim();
  const store = String(c.store || "").trim();
  const off = describeDiscount(c);

  const expires = toTs(c.expiresAt);
  const expLabel = expires ? new Date(expires).toLocaleDateString() : null;

  return (
    <div className="rounded-md border bg-background p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{title}</div>
          <div className="text-[12px] text-muted-foreground">
            {off ? (
              <span className="font-medium text-emerald-700">{off}</span>
            ) : (
              "Offer available"
            )}
            {store ? ` • ${store}` : ""}
            {expLabel ? ` • Expires ${expLabel}` : ""}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {c.code ? (
            <button
              className="px-2 py-1 text-xs rounded-md border hover:bg-muted"
              onClick={() => copyText(String(c.code))}
              title="Copy coupon code"
            >
              <Copy className="h-4 w-4 inline mr-1" /> Copy
            </button>
          ) : null}

          {c.url ? (
            <a
              className="px-2 py-1 text-xs rounded-md border hover:bg-muted inline-flex items-center"
              href={String(c.url)}
              target="_blank"
              rel="noreferrer"
              title="Open coupon"
            >
              <ExternalLink className="h-4 w-4 inline mr-1" /> Open
            </a>
          ) : null}
        </div>
      </div>

      {c.notes ? (
        <div className="mt-1 text-[12px] text-muted-foreground">
          {String(c.notes)}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ Helpers ------------------------------ */

function describeDiscount(c) {
  const amt = num(c?.amountOff ?? c?.amount_off);
  const pct = num(c?.pctOff ?? c?.pct_off);
  const currency = String(c?.currency || "USD");

  if (pct != null && pct > 0) return `${Math.round(pct)}% off`;
  if (amt != null && amt > 0) return `${fmt(amt, currency)} off`;
  return "";
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

function toTs(x) {
  if (!x) return null;
  if (typeof x === "number") return x;
  const t = Date.parse(String(x));
  return Number.isFinite(t) ? t : null;
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function copyText(t) {
  try {
    await navigator.clipboard?.writeText?.(t);
  } catch {
    // ignore
  }
}
