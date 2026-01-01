import React, { useMemo, useState } from "react";
import {
  ShieldAlert,
  ExternalLink,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

/**
 * RecallBanner
 * -----------------------------------------------------------------------------
 * Props:
 * - recalls: [{ id, title, severity, summary, url, date, affected }]
 *
 * Behavior:
 * - shows most severe recall as banner
 * - expandable to show all
 */

export default function RecallBanner({ recalls = [] }) {
  const list = Array.isArray(recalls) ? recalls : [];
  const [open, setOpen] = useState(false);

  const sorted = useMemo(() => {
    const xs = list.slice();
    xs.sort((a, b) => severityRank(b?.severity) - severityRank(a?.severity));
    return xs;
  }, [list]);

  const top = sorted[0];
  if (!top) return null;

  const tone = toneFor(top?.severity);

  return (
    <div className={`border-b ${tone.wrap}`}>
      <div className="p-3 flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <ShieldAlert className={`h-5 w-5 mt-0.5 ${tone.icon}`} />
          <div className="min-w-0">
            <div className={`text-sm font-semibold ${tone.text} truncate`}>
              Recall Alert
              {top?.severity ? ` • ${String(top.severity).toUpperCase()}` : ""}
            </div>
            <div className="text-[12px] text-muted-foreground mt-0.5">
              {String(top?.title || "A recall may apply to this product.")}
            </div>
            {top?.summary ? (
              <div className="text-[12px] text-muted-foreground mt-1">
                {String(top.summary).slice(0, 200)}
                {String(top.summary).length > 200 ? "…" : ""}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {top?.url ? (
            <a
              className="px-2 py-1 text-xs rounded-md border bg-background/60 hover:bg-background inline-flex items-center"
              href={String(top.url)}
              target="_blank"
              rel="noreferrer"
              title="View recall details"
            >
              <ExternalLink className="h-4 w-4 inline mr-1" /> Details
            </a>
          ) : null}

          {sorted.length > 1 ? (
            <button
              className="px-2 py-1 text-xs rounded-md border bg-background/60 hover:bg-background"
              onClick={() => setOpen((x) => !x)}
            >
              {open ? (
                <>
                  <ChevronUp className="h-4 w-4 inline mr-1" /> Less
                </>
              ) : (
                <>
                  <ChevronDown className="h-4 w-4 inline mr-1" /> All (
                  {sorted.length})
                </>
              )}
            </button>
          ) : null}
        </div>
      </div>

      {open ? (
        <div className="px-3 pb-3 space-y-2">
          {sorted.map((r, idx) => (
            <RecallRow key={r?.id || idx} recall={r} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RecallRow({ recall }) {
  const r = recall || {};
  const tone = toneFor(r?.severity);
  const date = r?.date ? safeDate(r.date) : null;

  return (
    <div className="rounded-md border bg-background p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`text-[11px] px-2 py-0.5 rounded-full border ${tone.pill}`}
            >
              {String(r?.severity || "medium").toUpperCase()}
            </span>
            {date ? (
              <span className="text-[11px] text-muted-foreground">{date}</span>
            ) : null}
          </div>

          <div className="mt-1 text-sm font-medium truncate">
            {String(r?.title || "Recall")}
          </div>

          {r?.summary ? (
            <div className="mt-1 text-[12px] text-muted-foreground">
              {String(r.summary)}
            </div>
          ) : null}
        </div>

        {r?.url ? (
          <a
            className="px-2 py-1 text-xs rounded-md border hover:bg-muted inline-flex items-center shrink-0"
            href={String(r.url)}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink className="h-4 w-4 inline mr-1" /> Details
          </a>
        ) : null}
      </div>

      {r?.affected ? (
        <div className="mt-2 text-[11px] text-muted-foreground">
          Affected: {String(r.affected).slice(0, 240)}
          {String(r.affected).length > 240 ? "…" : ""}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ Helpers ------------------------------ */

function severityRank(sev) {
  const s = String(sev || "").toLowerCase();
  if (s === "high" || s === "critical") return 3;
  if (s === "medium") return 2;
  if (s === "low") return 1;
  return 0;
}

function toneFor(sev) {
  const s = String(sev || "medium").toLowerCase();
  if (s === "high" || s === "critical") {
    return {
      wrap: "bg-red-50/60",
      icon: "text-red-700",
      text: "text-red-800",
      pill: "bg-red-50 text-red-700 border-red-200",
    };
  }
  if (s === "low") {
    return {
      wrap: "bg-slate-50/60",
      icon: "text-slate-700",
      text: "text-slate-800",
      pill: "bg-slate-50 text-slate-700 border-slate-200",
    };
  }
  return {
    wrap: "bg-amber-50/60",
    icon: "text-amber-800",
    text: "text-amber-900",
    pill: "bg-amber-50 text-amber-800 border-amber-200",
  };
}

function safeDate(x) {
  try {
    const t = typeof x === "number" ? x : Date.parse(String(x));
    if (!Number.isFinite(t)) return null;
    return new Date(t).toLocaleDateString();
  } catch {
    return null;
  }
}
