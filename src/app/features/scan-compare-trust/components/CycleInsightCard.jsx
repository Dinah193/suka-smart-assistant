/* eslint-disable no-console */
/**
 * CycleInsightCard — Scan • Compare • Trust
 * -----------------------------------------------------------------------------
 * Shows discount cadence insights (e.g., "6–8 weeks"), next predicted window,
 * and quick actions: Watch Price (schedule), Save Deal Run (session),
 * Open price history, Copy RRULE.
 *
 * Props:
 *  - subject: {
 *      upc?: string,
 *      brand?: string,
 *      category?: string,
 *      store?: { id?:string, slug?:string, name?:string }
 *      name?: string,
 *    }
 *  - dense?: boolean
 *  - variant?: 'sku' | 'brand' | 'store'   // heuristic if omitted
 *  - className?: string
 */

import React, { useEffect, useMemo, useState } from "react";

/* ----------------------------- Optional dependencies ----------------------------- */
let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  const eb = require("@/services/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let analytics = { track: () => {} };
try {
  const a = require("@/services/analytics");
  analytics = (a && (a.default || a.analytics || a)) || analytics;
} catch (_e) {}

let priceCycle = null; // source of cadence patterns + predictions
try {
  priceCycle = require("@/services/pricing/priceCycle").default;
} catch (_e) {}

let useFavoriteSchedules = null;
let useFavoriteSessions = null;
try {
  ({ useFavoriteSchedules } = require("@/hooks/useFavoriteSchedules"));
} catch (_e) {}
try {
  ({ useFavoriteSessions } = require("@/hooks/useFavoriteSessions"));
} catch (_e) {}

/* ----------------------------------- Helpers ----------------------------------- */
const fmtDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString();
};
const dayDiff = (a, b) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

const normalizeStoreId = (s) =>
  s?.id || s?.slug || (s?.name ? s.name.toLowerCase().replace(/\s+/g, "-") : null);

function titleFor(subject, variant) {
  const storeName = subject?.store?.name || normalizeStoreId(subject?.store) || "Store";
  if (variant === "sku" && (subject?.name || subject?.upc)) {
    return `${storeName}: ${subject?.name || subject?.upc}`;
  }
  if (variant === "brand" && subject?.brand) {
    return `${storeName}: ${subject.brand}`;
  }
  return `${storeName}: discounts pattern`;
}

/* ----------------------------------- Badge ------------------------------------ */
const Badge = ({ children, tone = "gray" }) => {
  const map = {
    gray: "border-gray-300 text-gray-700",
    green: "border-emerald-300 text-emerald-700",
    orange: "border-orange-300 text-orange-700",
    red: "border-rose-400 text-rose-800",
    blue: "border-sky-300 text-sky-700",
    purple: "border-violet-300 text-violet-700",
  };
  return (
    <span className={`inline-block text-[11px] px-1.5 py-0.5 rounded-md border ${map[tone] || map.gray}`}>
      {children}
    </span>
  );
};

/* ------------------------------------ Main ------------------------------------ */
export default function CycleInsightCard({
  subject = {},
  dense = false,
  variant: variantProp,
  className = "",
}) {
  const [loading, setLoading] = useState(true);
  const [pattern, setPattern] = useState(null);
  const [error, setError] = useState(null);

  const storeId = useMemo(() => normalizeStoreId(subject?.store), [subject]);
  const variant = useMemo(() => {
    if (variantProp) return variantProp;
    if (subject?.upc) return "sku";
    if (subject?.brand) return "brand";
    return "store";
  }, [subject, variantProp]);

  const favSchedules = useFavoriteSchedules ? useFavoriteSchedules() : null;
  const favSessions  = useFavoriteSessions ? useFavoriteSessions() : null;

  useEffect(() => {
    let alive = true;
    async function fetchPattern() {
      if (!priceCycle?.getPattern) { setLoading(false); return; }
      setLoading(true);
      setError(null);
      try {
        const payload = {
          store: storeId,
          upc: variant === "sku" ? subject?.upc : undefined,
          brand: variant === "brand" ? subject?.brand : undefined,
          category: subject?.category,
        };
        const res = await priceCycle.getPattern(payload);
        // expected shape (best-effort):
        // {
        //   label: "6–8 weeks",
        //   intervalDays: [42, 56],
        //   confidence: 0.86,
        //   nextWindow: { startISO, endISO, label?: "Nov 3–10" },
        //   lastLowISO?: string,
        //   lastAvgPrice?: number,
        //   lastLowPrice?: number,
        //   rrule?: "FREQ=...;BYDAY=..." (approx),
        //   samples?: number
        // }
        if (alive) setPattern(res || null);
        analytics.track("cycleinsight_loaded", { storeId, variant, ok: !!res });
      } catch (e) {
        console.error(e);
        if (alive) setError("Could not load cycle insight.");
      } finally {
        if (alive) setLoading(false);
      }
    }
    fetchPattern();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, subject?.upc, subject?.brand, variant]);

  const title = useMemo(() => titleFor(subject, variant), [subject, variant]);
  const windowLabel = pattern?.nextWindow?.label ||
    (pattern?.nextWindow?.startISO && pattern?.nextWindow?.endISO
      ? `${fmtDate(pattern.nextWindow.startISO)} – ${fmtDate(pattern.nextWindow.endISO)}`
      : null);

  const confPct = pattern?.confidence != null ? Math.round(clamp(pattern.confidence, 0, 1) * 100) : null;

  /* ---------------------------------- Actions ---------------------------------- */
  const saveWatchSchedule = async () => {
    const label =
      variant === "sku"
        ? `Watch price — ${subject?.store?.name || storeId}: ${subject?.name || subject?.upc}`
        : variant === "brand"
        ? `Watch ${subject?.brand} — ${subject?.store?.name || storeId}`
        : `Watch discounts — ${subject?.store?.name || storeId}`;

    const payload = {
      label,
      when: pattern?.rrule || "next_discount_window",
      meta: {
        store: storeId,
        upc: subject?.upc,
        brand: subject?.brand,
        variant,
        domain: "pricing/cycle",
      },
      createdAt: Date.now(),
      source: "CycleInsightCard",
    };

    try {
      if (favSchedules?.add) await favSchedules.add(payload);
      else eventBus.emit("favorites:schedule:add", payload);
      analytics.track("cycleinsight_watch_saved", { storeId, variant });
      eventBus.emit("ui:toast", { type: "success", message: "We’ll watch this discount window." });
    } catch (e) {
      console.error(e);
      eventBus.emit("ui:toast", { type: "error", message: "Could not save price watch." });
    }
  };

  const saveDealRunSession = async () => {
    const payload = {
      type: "deal_run",
      label:
        variant === "sku"
          ? `Deal Run: ${subject?.store?.name || storeId} — ${subject?.name || subject?.upc}`
          : `Deal Run: ${subject?.store?.name || storeId}${subject?.brand ? " • " + subject.brand : ""}`,
      items: [
        { upc: subject?.upc, name: subject?.name || subject?.upc || subject?.brand || "Item" },
      ],
      createdAt: Date.now(),
      source: "CycleInsightCard",
    };
    try {
      if (favSessions?.add) await favSessions.add(payload);
      else eventBus.emit("favorites:session:add", payload);
      analytics.track("cycleinsight_dealrun_saved", { storeId, variant });
      eventBus.emit("ui:toast", { type: "success", message: "Saved a Deal Run to favorites." });
    } catch (e) {
      console.error(e);
      eventBus.emit("ui:toast", { type: "error", message: "Could not save Deal Run." });
    }
  };

  const openHistory = () => {
    eventBus.emit("pricing:history:open", {
      store: storeId,
      upc: subject?.upc,
      brand: subject?.brand,
      variant,
      source: "CycleInsightCard",
    });
    analytics.track("cycleinsight_history_open", { storeId, variant });
  };

  const copyRRule = async () => {
    if (!pattern?.rrule) {
      eventBus.emit("ui:toast", { type: "info", message: "No RRULE available." });
      return;
    }
    try {
      await navigator.clipboard.writeText(pattern.rrule);
      eventBus.emit("ui:toast", { type: "success", message: "RRULE copied." });
      analytics.track("cycleinsight_rrule_copied", { storeId });
    } catch (_e) {
      eventBus.emit("ui:toast", { type: "info", message: pattern.rrule });
    }
  };

  /* ---------------------------------- Render ---------------------------------- */
  return (
    <div
      className={
        "rounded-2xl border p-3 bg-gradient-to-r from-indigo-50 to-violet-50 " +
        (dense ? "text-[13px]" : "text-sm") +
        (className ? " " + className : "")
      }
      role="region"
      aria-label="Discount cycle insight"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold truncate">{title}</div>

          {loading ? (
            <div className="mt-1 h-4 w-56 bg-white/70 animate-pulse rounded" />
          ) : error ? (
            <div className="mt-1 text-gray-600 italic">{error}</div>
          ) : pattern ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge tone="purple">
                Cadence: {pattern.label || (pattern.intervalDays ? `${pattern.intervalDays[0]}–${pattern.intervalDays[1]} days` : "—")}
              </Badge>
              {confPct != null ? <Badge tone={confPct >= 80 ? "green" : confPct >= 60 ? "orange" : "gray"}>
                Confidence {confPct}%
              </Badge> : null}
              {pattern.samples != null ? <Badge tone="blue">{pattern.samples} samples</Badge> : null}
              {windowLabel ? <Badge tone="green">Next: {windowLabel}</Badge> : null}
              {pattern?.lastLowISO ? (
                <Badge tone="gray">
                  Last low: {fmtDate(pattern.lastLowISO)}
                  {pattern.lastAvgPrice != null || pattern.lastLowPrice != null ? (
                    <span className="ml-1">
                      {pattern.lastLowPrice != null ? `@ $${Number(pattern.lastLowPrice).toFixed(2)}` :
                        pattern.lastAvgPrice != null ? `avg $${Number(pattern.lastAvgPrice).toFixed(2)}` : ""}
                    </span>
                  ) : null}
                </Badge>
              ) : null}
              {pattern?.nextWindow?.startISO && pattern?.lastLowISO ? (
                <Badge tone="blue">
                  Gap: {dayDiff(pattern.lastLowISO, pattern.nextWindow.startISO)} days
                </Badge>
              ) : null}
            </div>
          ) : (
            <div className="mt-1 text-gray-600 italic">No cycle pattern found yet.</div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            className="text-xs px-2 py-1 rounded-md border bg-white hover:shadow-sm"
            onClick={saveWatchSchedule}
            title="Create a Favorite Schedule to watch this discount window"
          >
            ⏰ Watch price
          </button>
          <button
            className="text-xs px-2 py-1 rounded-md border bg-white hover:shadow-sm"
            onClick={saveDealRunSession}
            title="Save a Favorite Session for the next deal window"
          >
            ★ Deal run
          </button>
          <button
            className="text-xs px-2 py-1 rounded-md border bg-white hover:shadow-sm"
            onClick={openHistory}
            title="Open price history"
          >
            📈 History
          </button>
          <button
            className="text-xs px-2 py-1 rounded-md border bg-white hover:shadow-sm"
            onClick={copyRRule}
            title="Copy RRULE"
          >
            🧩 RRULE
          </button>
        </div>
      </div>

      {/* Footer hint */}
      {!loading && pattern?.rrule ? (
        <div className="mt-2 text-[11px] text-gray-600">
          Schedule hint: <span className="font-mono">{pattern.rrule}</span>
        </div>
      ) : null}
    </div>
  );
}
