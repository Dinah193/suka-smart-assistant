import React, { useMemo, useState } from "react";
import {
  Wheat,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

/**
 * IngredientsCheckPanel
 * -----------------------------------------------------------------------------
 * Displays ingredient flags, allergen notices, and additive warnings.
 *
 * Props:
 * - ingredientsCheck:
 *   {
 *     ok: boolean,
 *     flags: [{ kind, label, severity, reason, match }],
 *     allergens: [{ label, severity, reason }],
 *     additives: [{ label, severity, reason }],
 *     notes: string,
 *     ingredientText?: string
 *   }
 * - item: optional item meta { title, brand, ... }
 *
 * Safe for missing data.
 */

export default function IngredientsCheckPanel({ ingredientsCheck, item }) {
  const [open, setOpen] = useState(false);

  const check =
    ingredientsCheck && typeof ingredientsCheck === "object"
      ? ingredientsCheck
      : null;

  const flags = Array.isArray(check?.flags) ? check.flags : [];
  const allergens = Array.isArray(check?.allergens) ? check.allergens : [];
  const additives = Array.isArray(check?.additives) ? check.additives : [];

  const severity = useMemo(() => {
    return maxSeverity([
      ...flags.map((x) => x?.severity),
      ...allergens.map((x) => x?.severity),
      ...additives.map((x) => x?.severity),
    ]);
  }, [flags, allergens, additives]);

  const status = useMemo(() => {
    if (!check)
      return { kind: "unknown", label: "Ingredients not checked yet" };
    if (severity === "high")
      return { kind: "warn", label: "Ingredients flags found" };
    if (severity === "medium")
      return { kind: "warn", label: "Potential ingredient concerns" };
    if (severity === "low") return { kind: "ok", label: "Minor notes" };
    return { kind: "ok", label: "No ingredient flags" };
  }, [check, severity]);

  const tone = toneFor(status.kind, severity);

  return (
    <div className="rounded-lg border overflow-hidden">
      <div className="px-3 py-2 flex items-center justify-between border-b">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Wheat className="h-4 w-4" /> Ingredients Check
        </div>

        <button
          className="px-2 py-1 text-xs rounded-md border hover:bg-muted"
          onClick={() => setOpen((x) => !x)}
        >
          {open ? (
            <>
              <ChevronUp className="h-4 w-4 inline mr-1" /> Hide
            </>
          ) : (
            <>
              <ChevronDown className="h-4 w-4 inline mr-1" /> Details
            </>
          )}
        </button>
      </div>

      <div className="p-3">
        <div className={`rounded-md border p-2 ${tone.wrap}`}>
          <div className="flex items-start gap-2">
            {status.kind === "ok" ? (
              <CheckCircle2 className={`h-5 w-5 mt-0.5 ${tone.icon}`} />
            ) : status.kind === "warn" ? (
              <AlertTriangle className={`h-5 w-5 mt-0.5 ${tone.icon}`} />
            ) : (
              <AlertTriangle
                className={`h-5 w-5 mt-0.5 text-muted-foreground`}
              />
            )}

            <div className="min-w-0">
              <div className={`text-sm font-semibold ${tone.text}`}>
                {status.label}
              </div>
              <div className="text-[12px] text-muted-foreground mt-0.5">
                {item?.title ? (
                  <span className="font-medium">{item.title}</span>
                ) : (
                  "Item"
                )}
                {item?.brand ? ` • ${item.brand}` : ""}{" "}
                {check?.notes ? ` • ${String(check.notes)}` : ""}
              </div>
            </div>
          </div>

          {!check ? (
            <div className="mt-2 text-[12px] text-muted-foreground">
              Waiting for ingredient parsing or lookup.
            </div>
          ) : null}
        </div>

        {open ? (
          <div className="mt-3 space-y-3">
            {flags.length ? (
              <Section title="Flags" items={flags} />
            ) : (
              <Empty label="No ingredient flags." />
            )}

            {allergens.length ? (
              <Section title="Allergens" items={allergens} />
            ) : (
              <Empty label="No allergen matches." />
            )}

            {additives.length ? (
              <Section title="Additives" items={additives} />
            ) : (
              <Empty label="No additive matches." />
            )}

            {check?.ingredientText ? (
              <div className="rounded-md border p-2">
                <div className="text-sm font-medium">Ingredient Text</div>
                <div className="text-[12px] text-muted-foreground whitespace-pre-wrap mt-1 max-h-40 overflow-auto">
                  {String(check.ingredientText).slice(0, 2500)}
                  {String(check.ingredientText).length > 2500 ? "…" : ""}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Section({ title, items }) {
  const list = Array.isArray(items) ? items : [];
  return (
    <div className="rounded-md border p-2">
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-2 space-y-2">
        {list.map((it, idx) => (
          <Row key={`${title}:${idx}`} item={it} />
        ))}
      </div>
    </div>
  );
}

function Row({ item }) {
  const it = item || {};
  const sev = normalizeSeverity(it.severity);
  const pill = pillFor(sev);

  return (
    <div className="rounded-md border p-2 bg-background">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">
            {String(it.label || it.kind || "Flag")}
          </div>
          {it.reason ? (
            <div className="text-[12px] text-muted-foreground mt-0.5">
              {String(it.reason)}
            </div>
          ) : null}
          {it.match ? (
            <div className="text-[11px] text-muted-foreground mt-1">
              Match: <span className="font-medium">{String(it.match)}</span>
            </div>
          ) : null}
        </div>
        <span
          className={`text-[11px] px-2 py-0.5 rounded-full border shrink-0 ${pill}`}
        >
          {sev.toUpperCase()}
        </span>
      </div>
    </div>
  );
}

function Empty({ label }) {
  return <div className="text-[12px] text-muted-foreground">{label}</div>;
}

/* ------------------------------ Helpers ------------------------------ */

function normalizeSeverity(x) {
  const s = String(x || "").toLowerCase();
  if (s === "high" || s === "critical") return "high";
  if (s === "medium") return "medium";
  if (s === "low") return "low";
  return "none";
}

function maxSeverity(list) {
  const rank = (s) =>
    s === "high" ? 3 : s === "medium" ? 2 : s === "low" ? 1 : 0;
  let best = 0;
  for (const x of list || []) best = Math.max(best, rank(normalizeSeverity(x)));
  return best === 3
    ? "high"
    : best === 2
    ? "medium"
    : best === 1
    ? "low"
    : "none";
}

function pillFor(sev) {
  if (sev === "high") return "bg-red-50 text-red-700 border-red-200";
  if (sev === "medium") return "bg-amber-50 text-amber-800 border-amber-200";
  if (sev === "low") return "bg-slate-50 text-slate-700 border-slate-200";
  return "bg-emerald-50 text-emerald-700 border-emerald-200";
}

function toneFor(kind, severity) {
  if (kind === "warn") {
    if (severity === "high") {
      return {
        wrap: "bg-red-50/50",
        icon: "text-red-700",
        text: "text-red-800",
      };
    }
    return {
      wrap: "bg-amber-50/50",
      icon: "text-amber-800",
      text: "text-amber-900",
    };
  }
  if (kind === "ok") {
    return {
      wrap: "bg-emerald-50/40",
      icon: "text-emerald-700",
      text: "text-emerald-800",
    };
  }
  return {
    wrap: "bg-slate-50/40",
    icon: "text-muted-foreground",
    text: "text-slate-800",
  };
}
