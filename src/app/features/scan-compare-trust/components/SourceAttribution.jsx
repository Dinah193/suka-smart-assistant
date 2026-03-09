/* eslint-disable no-console */
/**
 * SourceAttribution — Scan • Compare • Trust
 * -----------------------------------------------------------------------------
 * Displays the provenance of the current result: which providers contributed,
 * what signals they provided, freshness, confidence weighting, and links.
 *
 * Props:
 *  - subject?: { upc?:string, name?:string, brand?:string, store?:{id?:string,name?:string} }
 *  - sources?: Array<SourceLike>
 *  - dense?: boolean
 *  - title?: string
 *  - className?: string
 *
 * SourceLike (best-effort):
 * {
 *   id: string,                          // stable provider-id or row-id
 *   name: string,                         // "FDA Recalls", "OpenFoodFacts", "StoreApp"
 *   type?: 'safety'|'price'|'ingredients'|'nutrition'|'images'|'user'|'coupon'|'meta',
 *   url?: string,
 *   fetchedISO?: string,                  // when we fetched
 *   updatedISO?: string,                  // provider's last update (if known)
 *   credibility?: number,                 // 0..1
 *   weight?: number,                      // contribution to final decision (0..1)
 *   contribution?: string[],              // e.g., ['price','safety']
 *   sampleCount?: number,
 *   notes?: string,
 *   conflicts?: string[],                 // any disagreements it created
 *   icon?: string,                        // optional emoji or data-url
 * }
 *
 * Orchestration:
 *  - Emits:
 *      provenance:open        (open a detailed drawer)
 *      provenance:refresh     (kick off a re-fetch)
 *      favorites:session:add  (Verification run)
 *      favorites:schedule:add (Source refresh cadence)
 *      ui:toast               (feedback)
 *  - Optional hooks:
 *      useFavoriteSessions/useFavoriteSchedules
 *  - Optional services:
 *      analytics
 */

import React, { useMemo, useState } from "react";

/* ------------------------------- Optional deps -------------------------------- */
let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let analytics = { track: () => {} };
try {
  const a = require("@/services/analytics");
  analytics = (a && (a.default || a.analytics || a)) || analytics;
} catch (_e) {}

let useFavoriteSessions = null;
let useFavoriteSchedules = null;
try {
  ({ useFavoriteSessions } = require("@/hooks/useFavoriteSessions"));
} catch (_e) {}
try {
  ({ useFavoriteSchedules } = require("@/hooks/useFavoriteSchedules"));
} catch (_e) {}

/* --------------------------------- helpers ---------------------------------- */
const fmtDateTime = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString();
};
const daysAgo = (iso) => {
  if (!iso) return null;
  const d = new Date(iso).getTime();
  const diff = (Date.now() - d) / 86400000;
  return Math.floor(diff);
};
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n || 0)));

const tone = {
  gray: "border-gray-300 text-gray-700",
  green: "border-emerald-300 text-emerald-700",
  blue: "border-sky-300 text-sky-700",
  orange: "border-orange-300 text-orange-700",
  red: "border-rose-400 text-rose-800",
  violet: "border-violet-300 text-violet-700",
};

const typeTone = (t) =>
  t === "safety"
    ? tone.red
    : t === "price"
    ? tone.blue
    : t === "ingredients"
    ? tone.orange
    : t === "nutrition"
    ? tone.green
    : t === "images"
    ? tone.gray
    : t === "coupon"
    ? tone.violet
    : tone.gray;

const chip = (key, label, cls) => (
  <span
    key={key}
    className={`inline-block text-[11px] px-1.5 py-0.5 rounded-md border ${cls} mr-1 mb-1`}
  >
    {label}
  </span>
);

const byWeightThenFreshness = (a, b) => {
  const wa = clamp01(a.weight),
    wb = clamp01(b.weight);
  if (wa !== wb) return wb - wa;
  // fresher first
  const fa = a.fetchedISO ? -new Date(a.fetchedISO).getTime() : 0;
  const fb = b.fetchedISO ? -new Date(b.fetchedISO).getTime() : 0;
  return fa - fb;
};

const defaultIconFor = (name, type) => {
  if (type === "safety") return "🛡️";
  if (type === "price") return "💲";
  if (type === "coupon") return "🏷️";
  if (type === "ingredients") return "🧪";
  if (type === "nutrition") return "📊";
  if (type === "images") return "🖼️";
  if ((name || "").toLowerCase().includes("fda")) return "🏛️";
  if ((name || "").toLowerCase().includes("usda")) return "🌾";
  if ((name || "").toLowerCase().includes("openfoodfacts")) return "🌐";
  if ((name || "").toLowerCase().includes("ewg")) return "🍃";
  return "🔗";
};

/* ---------------------------------- subcomponents ---------------------------------- */
function ProviderRow({ s, compact = false, onOpen, onRefresh }) {
  const credPct = Math.round(clamp01(s.credibility) * 100);
  const wPct = Math.round(clamp01(s.weight) * 100);
  const staleDays = daysAgo(s.fetchedISO);
  const staleTone =
    staleDays == null
      ? tone.gray
      : staleDays <= 3
      ? tone.green
      : staleDays <= 14
      ? tone.orange
      : tone.red;

  return (
    <div className="flex items-start gap-3 py-2 border-t first:border-t-0">
      <div className="w-8 h-8 flex items-center justify-center rounded-lg border bg-white text-base">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {s.icon && s.icon.startsWith("data:") ? (
          <img src={s.icon} alt="" className="w-6 h-6 object-contain" />
        ) : (
          <span aria-hidden>{s.icon || defaultIconFor(s.name, s.type)}</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between">
          <div className="font-medium truncate">{s.name || s.id}</div>
          <div className="shrink-0 flex items-center gap-2">
            <button
              className="text-[11px] px-2 py-0.5 rounded-md border bg-white hover:shadow-sm"
              onClick={onOpen}
              title="Open details"
            >
              Details
            </button>
            <button
              className="text-[11px] px-2 py-0.5 rounded-md border bg-white hover:shadow-sm"
              onClick={onRefresh}
              title="Refresh this source"
            >
              Refresh
            </button>
          </div>
        </div>

        {!compact && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {s.type ? chip("type", s.type, typeTone(s.type)) : null}
            {Array.isArray(s.contribution)
              ? s.contribution.map((c) => chip(`c-${c}`, c, typeTone(c)))
              : null}
            {s.credibility != null
              ? chip("cred", `Cred ${credPct}%`, tone.green)
              : null}
            {s.weight != null
              ? chip("wt", `Weight ${wPct}%`, tone.violet)
              : null}
            {s.sampleCount != null
              ? chip("n", `${s.sampleCount} samples`, tone.blue)
              : null}
            {s.conflicts && s.conflicts.length
              ? chip("conf", `${s.conflicts.length} conflicts`, tone.red)
              : null}
            <span
              className={`inline-block text-[11px] px-1.5 py-0.5 rounded-md border ${staleTone}`}
            >
              {s.fetchedISO
                ? `Fetched ${staleDays === 0 ? "today" : `${staleDays}d ago`}`
                : "Fetched n/a"}
            </span>
            {s.updatedISO ? (
              <span className="inline-block text-[11px] px-1.5 py-0.5 rounded-md border border-gray-300 text-gray-700">
                Updated {fmtDateTime(s.updatedISO)}
              </span>
            ) : null}
            {s.url ? (
              <a
                className="inline-block text-[11px] px-1.5 py-0.5 rounded-md border border-gray-300 text-gray-700 underline"
                href={s.url}
                target="_blank"
                rel="noreferrer"
                onClick={() =>
                  analytics.track("provenance_source_open", {
                    id: s.id,
                    url: s.url,
                  })
                }
              >
                Open
              </a>
            ) : null}
          </div>
        )}

        {s.notes && !compact ? (
          <div className="mt-1 text-xs text-gray-600">{s.notes}</div>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------- main -------------------------------------- */
export default function SourceAttribution({
  subject = {},
  sources = [],
  dense = false,
  title = "Sources & Attribution",
  className = "",
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);

  const favSessions = useFavoriteSessions ? useFavoriteSessions() : null;
  const favSchedules = useFavoriteSchedules ? useFavoriteSchedules() : null;

  // Stable, ranked view
  const ranked = useMemo(() => {
    const arr = Array.isArray(sources) ? sources.slice() : [];
    arr.forEach((s) => {
      s.weight = clamp01(s.weight);
      s.credibility = clamp01(s.credibility);
    });
    arr.sort(byWeightThenFreshness);
    return arr;
  }, [sources]);

  // Overall confidence (weighted credibility)
  const summary = useMemo(() => {
    if (!ranked.length)
      return { overall: null, topKinds: [], conflicts: 0, freshPct: null };
    const sumW = ranked.reduce((a, s) => a + (s.weight || 0), 0) || 1;
    const overall =
      ranked.reduce((a, s) => a + (s.credibility || 0) * (s.weight || 0), 0) /
      sumW;
    const freq = {};
    ranked.forEach((s) =>
      s.type ? (freq[s.type] = (freq[s.type] || 0) + 1) : null
    );
    const topKinds = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k]) => k);
    const conflicts = ranked.reduce(
      (a, s) => a + (Array.isArray(s.conflicts) ? s.conflicts.length : 0),
      0
    );
    const fresh = ranked.filter(
      (s) => (daysAgo(s.fetchedISO) ?? 999) <= 7
    ).length;
    const freshPct = Math.round((fresh / ranked.length) * 100);
    return { overall, topKinds, conflicts, freshPct };
  }, [ranked]);

  const labelForSubject = useMemo(() => {
    const store = subject?.store?.name || subject?.store?.id || "";
    const ident = subject?.name || subject?.upc || subject?.brand || "";
    return [store, ident].filter(Boolean).join(" — ");
  }, [subject]);

  /* ----------------------------------- actions ----------------------------------- */
  const openProvenanceDrawer = () => {
    eventBus.emit("provenance:open", {
      subject,
      sources: ranked,
      source: "SourceAttribution",
    });
    analytics.track("provenance_open", { count: ranked.length });
  };

  const refreshAll = () => {
    eventBus.emit("provenance:refresh", {
      subject,
      source: "SourceAttribution",
    });
    analytics.track("provenance_refresh", { count: ranked.length });
    eventBus.emit("ui:toast", {
      type: "success",
      message: "Refreshing all sources…",
    });
  };

  const copyProvenance = async () => {
    setCopyBusy(true);
    try {
      const payload = JSON.stringify({ subject, sources: ranked }, null, 2);
      await navigator.clipboard.writeText(payload);
      eventBus.emit("ui:toast", {
        type: "success",
        message: "Provenance copied.",
      });
      analytics.track("provenance_copied", { count: ranked.length });
    } catch (_e) {
      eventBus.emit("ui:toast", {
        type: "info",
        message: "Copy not available in this context.",
      });
    } finally {
      setCopyBusy(false);
    }
  };

  const saveVerificationRun = async () => {
    const session = {
      type: "verification",
      label: `Verify: ${labelForSubject || "Item"}`,
      items: ranked.map((s) => ({
        provider: s.name || s.id,
        type: s.type,
        fetchedISO: s.fetchedISO,
        url: s.url || null,
      })),
      createdAt: Date.now(),
      source: "SourceAttribution",
    };
    try {
      if (favSessions?.add) await favSessions.add(session);
      else eventBus.emit("favorites:session:add", session);
      analytics.track("provenance_verification_session_saved", {
        count: ranked.length,
      });
      eventBus.emit("ui:toast", {
        type: "success",
        message: "Verification session saved.",
      });
    } catch (e) {
      console.error(e);
      eventBus.emit("ui:toast", {
        type: "error",
        message: "Could not save session.",
      });
    }
  };

  const saveRefreshSchedule = async () => {
    const schedule = {
      label: `Refresh sources — ${labelForSubject || "Item"}`,
      when: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0;BYSECOND=0",
      meta: { domain: "provenance", subject },
      createdAt: Date.now(),
      source: "SourceAttribution",
    };
    try {
      if (useFavoriteSchedules) {
        const fav = useFavoriteSchedules();
        if (fav?.add) await fav.add(schedule);
        else eventBus.emit("favorites:schedule:add", schedule);
      } else {
        eventBus.emit("favorites:schedule:add", schedule);
      }
      analytics.track("provenance_refresh_schedule_saved", {});
      eventBus.emit("ui:toast", {
        type: "success",
        message: "We’ll remind you to refresh weekly.",
      });
    } catch (e) {
      console.error(e);
      eventBus.emit("ui:toast", {
        type: "error",
        message: "Could not save schedule.",
      });
    }
  };

  /* ------------------------------------- UI ------------------------------------- */
  return (
    <div
      className={
        "rounded-2xl border p-3 bg-gradient-to-r from-slate-50 to-slate-100 " +
        (dense ? "text-[13px]" : "text-sm") +
        (className ? " " + className : "")
      }
      role="region"
      aria-label="Source Attribution"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold truncate">{title}</div>
          {labelForSubject ? (
            <div className="text-xs text-gray-600 truncate">
              {labelForSubject}
            </div>
          ) : null}

          {/* Summary row */}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {summary.overall != null ? (
              <span
                className={`text-[11px] px-1.5 py-0.5 rounded-md border ${
                  summary.overall >= 0.8
                    ? tone.green
                    : summary.overall >= 0.6
                    ? tone.orange
                    : tone.gray
                }`}
              >
                Overall confidence {Math.round(summary.overall * 100)}%
              </span>
            ) : (
              <span
                className={`text-[11px] px-1.5 py-0.5 rounded-md border ${tone.gray}`}
              >
                Confidence n/a
              </span>
            )}
            {summary.freshPct != null ? (
              <span
                className={`text-[11px] px-1.5 py-0.5 rounded-md border ${
                  summary.freshPct >= 70
                    ? tone.green
                    : summary.freshPct >= 40
                    ? tone.orange
                    : tone.red
                }`}
              >
                {summary.freshPct}% fetched ≤ 7d
              </span>
            ) : null}
            {summary.conflicts ? (
              <span
                className={`text-[11px] px-1.5 py-0.5 rounded-md border ${tone.red}`}
              >
                {summary.conflicts} conflicts
              </span>
            ) : null}
            {summary.topKinds.length
              ? summary.topKinds.map((k) => chip(`top-${k}`, k, typeTone(k)))
              : null}
          </div>
        </div>

        {/* Actions */}
        <div className="shrink-0 flex items-center gap-2">
          <button
            className="text-xs px-2 py-1 rounded-md border bg-white hover:shadow-sm"
            onClick={openProvenanceDrawer}
            title="Open full provenance drawer"
          >
            🔎 Inspect
          </button>
          <button
            className="text-xs px-2 py-1 rounded-md border bg-white hover:shadow-sm"
            onClick={refreshAll}
            title="Refresh all sources"
          >
            ♻️ Refresh
          </button>
          <button
            className="text-xs px-2 py-1 rounded-md border bg-white hover:shadow-sm"
            onClick={saveVerificationRun}
            title="Save a Favorite Session to verify these sources later"
          >
            ★ Verification run
          </button>
          <button
            className="text-xs px-2 py-1 rounded-md border bg-white hover:shadow-sm"
            onClick={saveRefreshSchedule}
            title="Create a Favorite Schedule to refresh sources weekly"
          >
            ⏰ Refresh weekly
          </button>
          <button
            className="text-xs px-2 py-1 rounded-md border bg-white hover:shadow-sm"
            onClick={copyProvenance}
            disabled={copyBusy}
            title="Copy provenance JSON"
          >
            🧩 {copyBusy ? "Copying…" : "Copy JSON"}
          </button>
          <button
            className="text-xs px-2 py-1 rounded-md border bg-white hover:shadow-sm"
            onClick={() => setCollapsed((v) => !v)}
            title="Collapse list"
            aria-expanded={!collapsed}
          >
            {collapsed ? "Show" : "Hide"}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="mt-2">
          {ranked.length ? (
            <div className="divide-y">
              {ranked.map((s) => (
                <ProviderRow
                  key={s.id || s.name}
                  s={s}
                  compact={dense}
                  onOpen={() => {
                    eventBus.emit("provenance:source:open", {
                      id: s.id,
                      subject,
                      source: "SourceAttribution",
                    });
                    analytics.track("provenance_source_details", { id: s.id });
                  }}
                  onRefresh={() => {
                    eventBus.emit("provenance:source:refresh", {
                      id: s.id,
                      subject,
                      source: "SourceAttribution",
                    });
                    analytics.track("provenance_source_refresh", { id: s.id });
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="text-xs text-gray-600 italic">
              No sources attached yet.
            </div>
          )}
        </div>
      )}

      {/* Footnote */}
      <div className="mt-2 text-[11px] text-gray-500">
        We combine multiple providers and weight them by reliability, freshness,
        and relevance. You can inspect, refresh, and schedule provenance checks.
        Favorite sessions/schedules are yours—not just system defaults.
      </div>
    </div>
  );
}
