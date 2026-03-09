// C:\Users\larho\suka-smart-assistant\src\components\knowledgeHelper\SafetyAlertCard.jsx
/* eslint-disable no-console */
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ShieldAlert,
  Info,
  CheckCircle2,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  X,
  Clock,
  Tag,
} from "lucide-react";

/**
 * SSA • Knowledge Helper • SafetyAlertCard
 * -----------------------------------------------------------------------------
 * A UI card for presenting safety alerts / cautions to users in a calm,
 * actionable, non-alarmist way.
 *
 * Design goals
 *  - Deterministic rendering (no HTML injection; no dangerouslySetInnerHTML)
 *  - Accessible: role="alert" for high severities; keyboard controls; aria labels
 *  - Production-ready: robust prop normalization, graceful missing data,
 *    optional dismiss + actions + sources + expandable details
 *
 * Typical uses
 *  - Food safety: temps, storage, cross-contamination
 *  - Cleaning safety: chemical mixing warnings, ventilation
 *  - Tool safety: pressure canner, dehydrator temps, sharp tools
 *  - Allergy/caution: ingredient notes, exposure risks
 *
 * -----------------------------------------------------------------------------
 * Props
 *  - alert: object with fields (any subset is OK):
 *      {
 *        id?: string,
 *        severity?: "info"|"low"|"medium"|"high"|"critical",
 *        title?: string,
 *        summary?: string,
 *        details?: string,
 *        bullets?: string[],
 *        recommendations?: string[],
 *        category?: string,
 *        tags?: string[],
 *        createdAt?: string (ISO),
 *        updatedAt?: string (ISO),
 *        sources?: Array<{ label: string, url?: string }>,
 *        confidence?: number (0..1),
 *        domains?: string[] // e.g. ["cooking","cleaning"]
 *      }
 *  - severity: overrides alert.severity
 *  - compact: boolean (less padding)
 *  - defaultExpanded: boolean
 *  - showTimestamp: boolean
 *  - showCategory: boolean
 *  - showTags: boolean
 *  - showConfidence: boolean
 *  - maxBullets: number (default 6)
 *  - onDismiss: (alert) => void
 *  - onAction: (actionId, alert) => void
 *  - actions: Array<{ id: string, label: string, variant?: "primary"|"secondary"|"ghost", icon?: ReactNode }>
 *
 * Notes
 *  - Links open in a new tab with rel="noreferrer noopener".
 */

const DEFAULT_MAX_BULLETS = 6;

const SEVERITY_META = Object.freeze({
  info: {
    label: "Info",
    icon: Info,
    border: "border-slate-200",
    bg: "bg-slate-50",
    text: "text-slate-900",
    badge: "bg-slate-100 text-slate-800",
    ring: "focus:ring-slate-400",
    role: "status",
  },
  low: {
    label: "Low",
    icon: CheckCircle2,
    border: "border-emerald-200",
    bg: "bg-emerald-50",
    text: "text-emerald-950",
    badge: "bg-emerald-100 text-emerald-900",
    ring: "focus:ring-emerald-500",
    role: "status",
  },
  medium: {
    label: "Medium",
    icon: AlertTriangle,
    border: "border-amber-200",
    bg: "bg-amber-50",
    text: "text-amber-950",
    badge: "bg-amber-100 text-amber-900",
    ring: "focus:ring-amber-500",
    role: "status",
  },
  high: {
    label: "High",
    icon: ShieldAlert,
    border: "border-orange-200",
    bg: "bg-orange-50",
    text: "text-orange-950",
    badge: "bg-orange-100 text-orange-900",
    ring: "focus:ring-orange-500",
    role: "alert",
  },
  critical: {
    label: "Critical",
    icon: ShieldAlert,
    border: "border-rose-200",
    bg: "bg-rose-50",
    text: "text-rose-950",
    badge: "bg-rose-100 text-rose-900",
    ring: "focus:ring-rose-500",
    role: "alert",
  },
});

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(1, v));
}

function normalizeString(v) {
  if (v == null) return "";
  const s = String(v).trim();
  return s;
}

function normalizeArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => normalizeString(x)).filter(Boolean);
}

function safeUrl(u) {
  const s = normalizeString(u);
  if (!s) return "";
  // basic safety: allow http(s) only; otherwise return empty string
  try {
    const url = new URL(s, window.location.origin);
    const proto = url.protocol.toLowerCase();
    if (proto === "http:" || proto === "https:") return url.toString();
    return "";
  } catch {
    return "";
  }
}

function formatWhen(iso) {
  const s = normalizeString(iso);
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  // Compact but clear; relies on user's locale/timezone
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toDomainLabel(domains) {
  const arr = normalizeArray(domains);
  if (!arr.length) return "";
  // show up to 2; otherwise +N
  if (arr.length <= 2) return arr.join(" · ");
  return `${arr.slice(0, 2).join(" · ")} +${arr.length - 2}`;
}

function variantBtn(variant) {
  switch (variant) {
    case "primary":
      return "bg-slate-900 text-white hover:bg-slate-800";
    case "secondary":
      return "bg-white text-slate-900 border border-slate-200 hover:bg-slate-50";
    case "ghost":
    default:
      return "bg-transparent text-slate-900 hover:bg-slate-100";
  }
}

export default function SafetyAlertCard({
  alert,
  severity: severityOverride,
  compact = false,
  defaultExpanded = false,
  showTimestamp = true,
  showCategory = true,
  showTags = true,
  showConfidence = false,
  maxBullets = DEFAULT_MAX_BULLETS,
  onDismiss,
  actions = [],
  onAction,
}) {
  const a = alert && typeof alert === "object" ? alert : {};
  const normalizedSeverity = normalizeString(
    severityOverride || a.severity || "info"
  ).toLowerCase();
  const sevKey = SEVERITY_META[normalizedSeverity]
    ? normalizedSeverity
    : "info";
  const meta = SEVERITY_META[sevKey];

  const title = normalizeString(a.title) || "Safety note";
  const summary = normalizeString(a.summary);
  const details = normalizeString(a.details);
  const bullets = normalizeArray(a.bullets);
  const recs = normalizeArray(a.recommendations);
  const tags = normalizeArray(a.tags);
  const category = normalizeString(a.category);
  const whenISO = normalizeString(a.updatedAt || a.createdAt);
  const when = showTimestamp ? formatWhen(whenISO) : "";
  const confidence = clamp01(a.confidence);

  const domainsLabel = useMemo(() => toDomainLabel(a.domains), [a.domains]);

  const sources = useMemo(() => {
    const src = Array.isArray(a.sources) ? a.sources : [];
    return src
      .map((s) => {
        const label = normalizeString(s?.label) || "Source";
        const url = safeUrl(s?.url);
        return { label, url };
      })
      .filter((s) => s.label || s.url);
  }, [a.sources]);

  const [expanded, setExpanded] = useState(!!defaultExpanded);
  const bodyId = useMemo(
    () =>
      `sa_${normalizeString(a.id) || Math.random().toString(16).slice(2)}_body`,
    [a.id]
  );

  const titleRef = useRef(null);

  useEffect(() => {
    // If defaultExpanded is true and severity is high+, help focus for screen readers
    if (
      defaultExpanded &&
      (sevKey === "high" || sevKey === "critical") &&
      titleRef.current
    ) {
      // don't steal focus aggressively; only focus if nothing else is focused
      if (document.activeElement === document.body) {
        titleRef.current.focus({ preventScroll: true });
      }
    }
  }, [defaultExpanded, sevKey]);

  const Icon = meta.icon;

  const shownBullets = bullets.slice(
    0,
    Math.max(0, Number(maxBullets) || DEFAULT_MAX_BULLETS)
  );
  const extraBullets = bullets.length - shownBullets.length;

  const hasExpandable =
    !!details ||
    recs.length > 0 ||
    bullets.length > shownBullets.length ||
    (sources && sources.length > 0);

  const role = meta.role; // "status" | "alert"
  const ariaLive = role === "alert" ? "assertive" : "polite";

  const headerPad = compact ? "p-3" : "p-4";
  const bodyPad = compact ? "px-3 pb-3" : "px-4 pb-4";

  const dismissible = typeof onDismiss === "function";

  const actionList = Array.isArray(actions)
    ? actions.filter((x) => x && x.id && x.label)
    : [];

  function handleToggle() {
    setExpanded((v) => !v);
  }

  function handleKeyToggle(e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleToggle();
    }
  }

  function handleDismiss() {
    try {
      onDismiss?.(a);
    } catch (e) {
      console.warn("[SafetyAlertCard] onDismiss failed", e);
    }
  }

  function handleAction(actionId) {
    try {
      onAction?.(actionId, a);
    } catch (e) {
      console.warn("[SafetyAlertCard] onAction failed", e);
    }
  }

  return (
    <section
      className={[
        "w-full rounded-2xl border shadow-sm",
        meta.border,
        meta.bg,
        compact ? "text-sm" : "text-base",
      ].join(" ")}
      role={role}
      aria-live={ariaLive}
      aria-atomic="true"
      data-severity={sevKey}
    >
      <div className={["flex items-start gap-3", headerPad].join(" ")}>
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/70 border border-black/5">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              ref={titleRef}
              tabIndex={-1}
              className={[
                "min-w-0 truncate font-semibold leading-6",
                meta.text,
              ].join(" ")}
              title={title}
            >
              {title}
            </h3>

            <span
              className={[
                "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                meta.badge,
              ].join(" ")}
            >
              {meta.label}
            </span>

            {showCategory && category ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-white/70 border border-black/5 px-2 py-0.5 text-xs text-slate-700">
                <Tag className="h-3.5 w-3.5" aria-hidden="true" />
                {category}
              </span>
            ) : null}

            {domainsLabel ? (
              <span className="inline-flex items-center rounded-full bg-white/70 border border-black/5 px-2 py-0.5 text-xs text-slate-700">
                {domainsLabel}
              </span>
            ) : null}

            {showConfidence && confidence != null ? (
              <span className="inline-flex items-center rounded-full bg-white/70 border border-black/5 px-2 py-0.5 text-xs text-slate-700">
                Confidence: {Math.round(confidence * 100)}%
              </span>
            ) : null}

            {showTimestamp && when ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-white/70 border border-black/5 px-2 py-0.5 text-xs text-slate-700">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                {when}
              </span>
            ) : null}
          </div>

          {summary ? (
            <p className="mt-1 text-slate-800 leading-6">{summary}</p>
          ) : null}

          {shownBullets.length ? (
            <ul className="mt-2 list-disc pl-5 text-slate-800 space-y-1">
              {shownBullets.map((b, idx) => (
                <li key={`${idx}-${b.slice(0, 18)}`}>{b}</li>
              ))}
              {extraBullets > 0 && !expanded ? (
                <li className="list-none pl-0">
                  <span className="text-slate-600 text-sm">
                    +{extraBullets} more…
                  </span>
                </li>
              ) : null}
            </ul>
          ) : null}

          {showTags && tags.length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {tags.slice(0, 12).map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center rounded-full bg-white/70 border border-black/5 px-2 py-0.5 text-xs text-slate-700"
                >
                  {t}
                </span>
              ))}
              {tags.length > 12 ? (
                <span className="text-xs text-slate-600">
                  +{tags.length - 12}
                </span>
              ) : null}
            </div>
          ) : null}

          {/* Actions row */}
          {hasExpandable || actionList.length || dismissible ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {hasExpandable ? (
                <button
                  type="button"
                  onClick={handleToggle}
                  onKeyDown={handleKeyToggle}
                  className={[
                    "inline-flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium",
                    "bg-white/80 border border-black/5 hover:bg-white",
                    "focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-transparent",
                    meta.ring,
                  ].join(" ")}
                  aria-expanded={expanded}
                  aria-controls={bodyId}
                >
                  {expanded ? "Hide details" : "Show details"}
                  {expanded ? (
                    <ChevronUp className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              ) : null}

              {actionList.map((act) => (
                <button
                  key={act.id}
                  type="button"
                  onClick={() => handleAction(act.id)}
                  className={[
                    "inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium",
                    "focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-transparent",
                    meta.ring,
                    variantBtn(act.variant),
                  ].join(" ")}
                >
                  {act.icon ? (
                    <span className="inline-flex h-4 w-4 items-center justify-center">
                      {act.icon}
                    </span>
                  ) : null}
                  {act.label}
                </button>
              ))}

              {dismissible ? (
                <button
                  type="button"
                  onClick={handleDismiss}
                  className={[
                    "ml-auto inline-flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium",
                    "bg-transparent text-slate-700 hover:bg-white/70",
                    "focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-transparent",
                    meta.ring,
                  ].join(" ")}
                  aria-label="Dismiss safety alert"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                  Dismiss
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {hasExpandable ? (
        <div
          id={bodyId}
          className={[
            "border-t border-black/5",
            expanded ? "block" : "hidden",
          ].join(" ")}
        >
          <div className={bodyPad}>
            {details ? (
              <div className="mt-1">
                <h4 className="text-sm font-semibold text-slate-900">
                  Details
                </h4>
                <p className="mt-1 text-slate-800 leading-6 whitespace-pre-line">
                  {details}
                </p>
              </div>
            ) : null}

            {recs.length ? (
              <div className="mt-4">
                <h4 className="text-sm font-semibold text-slate-900">
                  Recommended actions
                </h4>
                <ul className="mt-2 list-disc pl-5 text-slate-800 space-y-1">
                  {recs.map((r, idx) => (
                    <li key={`${idx}-${r.slice(0, 18)}`}>{r}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {bullets.length > shownBullets.length ? (
              <div className="mt-4">
                <h4 className="text-sm font-semibold text-slate-900">
                  Additional notes
                </h4>
                <ul className="mt-2 list-disc pl-5 text-slate-800 space-y-1">
                  {bullets.slice(shownBullets.length).map((b, idx) => (
                    <li key={`more-${idx}-${b.slice(0, 18)}`}>{b}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {sources.length ? (
              <div className="mt-4">
                <h4 className="text-sm font-semibold text-slate-900">
                  Sources
                </h4>
                <ul className="mt-2 space-y-2">
                  {sources.map((s, idx) => (
                    <li
                      key={`${idx}-${s.label}`}
                      className="flex items-center justify-between gap-3 rounded-xl bg-white/70 border border-black/5 px-3 py-2"
                    >
                      <span className="min-w-0 truncate text-sm text-slate-800">
                        {s.label}
                      </span>
                      {s.url ? (
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-1 text-sm font-medium text-slate-900 hover:underline"
                        >
                          Open{" "}
                          <ExternalLink
                            className="h-4 w-4"
                            aria-hidden="true"
                          />
                        </a>
                      ) : (
                        <span className="text-xs text-slate-600">No link</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Convenience: build a minimal alert object consistently.
 * Use this in engines/services when emitting alerts to UI.
 */
export function makeSafetyAlert({
  id,
  severity = "info",
  title,
  summary,
  details,
  bullets,
  recommendations,
  category,
  tags,
  sources,
  confidence,
  domains,
  createdAt,
  updatedAt,
} = {}) {
  return {
    id: normalizeStr(id) || randomId("alert"),
    severity: normalizeStr(severity)?.toLowerCase() || "info",
    title: normalizeStr(title) || "Safety note",
    summary: normalizeStr(summary) || "",
    details: normalizeStr(details) || "",
    bullets: normalizeArray(bullets),
    recommendations: normalizeArray(recommendations),
    category: normalizeStr(category) || "",
    tags: normalizeArray(tags),
    sources: Array.isArray(sources)
      ? sources.map((s) => ({
          label: normalizeStr(s?.label) || "Source",
          url: normalizeStr(s?.url) || "",
        }))
      : [],
    confidence: clamp01(confidence),
    domains: normalizeArray(domains),
    createdAt: normalizeStr(createdAt) || nowISO(),
    updatedAt: normalizeStr(updatedAt) || null,
  };
}
