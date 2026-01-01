// File: src/components/meals/collector/SourceAttributionCard.jsx
// Purpose: Display and act on the provenance of a collected recipe/ingredient set.
// Design: Compact, modern card with resilient fallbacks and Suka-integrations (eventBus, automation).
// Inspired by Notion/Linear cards: clear hierarchy, tasteful metadata, crisp actions.

import React, { useMemo, useState, useEffect, useCallback } from "react";

/* --------------------------------- Shims ---------------------------------- */
// Use dynamic requires so alias imports never break previews/sandboxes.
const softRequire = (id) => {
  try {
    const req = typeof require === "function" ? require : (0, eval)("require");
    return req ? req(id) : null;
  } catch { return null; }
};
const alias = (p) => "@" + "/" + p; // discourage bundlers from static-resolving "@/..."

let Icons = softRequire("lucide-react") || {};
const mkIcon = (name) => (props) => (
  <span aria-hidden className={props?.className || "inline-block w-4 h-4"} data-icon={name}/>
);
const {
  Link2 = mkIcon("Link2"),
  Globe = mkIcon("Globe"),
  ShieldCheck = mkIcon("ShieldCheck"),
  Shield = mkIcon("Shield"),
  BadgeCheck = mkIcon("BadgeCheck"),
  Clipboard = mkIcon("Clipboard"),
  Share2 = mkIcon("Share2"),
  ExternalLink = mkIcon("ExternalLink"),
  FileText = mkIcon("FileText"),
  FileClock = mkIcon("FileClock"),
  Calendar = mkIcon("Calendar"),
  User = mkIcon("User"),
  Percent = mkIcon("Percent"),
  Scale = mkIcon("Scale"),
  Boxes = mkIcon("Boxes"),
  Info = mkIcon("Info"),
  Sparkles = mkIcon("Sparkles"),
  MoreHorizontal = mkIcon("MoreHorizontal"),
} = Icons;

let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  const mod = softRequire(alias("services/eventBus"));
  if (mod?.eventBus) eventBus = mod.eventBus;
} catch {}

let automation = null;
try {
  const mod = softRequire(alias("services/automation/runtime"));
  if (mod?.automation) automation = mod.automation;
} catch {}

// Optional SendToMenu (inline dropdown) — if not present, we emit a sendto event instead
let SendToMenu = null;
try {
  const mod = softRequire(alias("components/meals/collector/SendToMenu"));
  SendToMenu = mod?.default || null;
} catch {}

/* --------------------------------- Helpers -------------------------------- */
const fmtDate = (d) => {
  if (!d) return "";
  try {
    // accept ISO or Date
    const dt = typeof d === "string" ? new Date(d) : d;
    return dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch { return String(d); }
};

const getDomain = (url = "") => {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
};

const faviconFor = (url = "") => {
  const domain = getDomain(url);
  if (!domain) return null;
  // Lightweight public favicon service
  return `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`;
};

const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));

const confidenceColor = (c) => {
  // green (>0.8), amber (0.5-0.8), red (<0.5)
  if (c >= 0.8) return "bg-green-500";
  if (c >= 0.5) return "bg-amber-500";
  return "bg-rose-500";
};

const mdCitation = ({ title, url, author, publishedAt }) => {
  const date = fmtDate(publishedAt);
  const pieces = [];
  if (author) pieces.push(author);
  if (date) pieces.push(date);
  const meta = pieces.length ? ` — ${pieces.join(", ")}` : "";
  return `[${title || getDomain(url) || "Source"}](${url})${meta}`;
};

const safeShare = async (payload) => {
  try {
    if (navigator.share) await navigator.share(payload);
    else if (payload?.url) await navigator.clipboard?.writeText(payload.url);
  } catch {}
};

const TRUST_KEY = "suka_trusted_domains";
const loadTrusted = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(TRUST_KEY) || "[]"));
  } catch { return new Set(); }
};
const saveTrusted = (set) => {
  try { localStorage.setItem(TRUST_KEY, JSON.stringify(Array.from(set))); }
  catch {}
};

/* ---------------------------------- Card ----------------------------------- */
/**
 * @param {object} props
 * @param {object} props.source
 *   - url: string
 *   - title?: string
 *   - author?: string
 *   - publishedAt?: string|Date
 *   - scrapedAt?: string|Date
 *   - license?: string ("CC BY", "All rights reserved", …)
 *   - tags?: string[]
 *   - confidence?: number [0..1] extraction confidence/quality
 *   - snapshotId?: string (if you keep cached snapshots)
 *   - notes?: string
 * @param {Array}  props.ingredients? optional raw ingredient lines (to map)
 * @param {string} props.size? "sm" | "md"
 * @param {boolean} props.compact?
 * @param {function} props.onTrustChange?
 */
export default function SourceAttributionCard({
  source,
  ingredients = [],
  size = "md",
  compact = false,
  onTrustChange,
}) {
  const {
    url,
    title,
    author,
    publishedAt,
    scrapedAt,
    license,
    tags = [],
    confidence,
    snapshotId,
    notes,
  } = source || {};

  const domain = useMemo(() => getDomain(url), [url]);
  const favicon = useMemo(() => faviconFor(url), [url]);
  const conf = clamp01(confidence ?? 0.8); // default optimistic
  const [trustedSet, setTrustedSet] = useState(loadTrusted());
  const isTrusted = trustedSet.has(domain);

  useEffect(() => { setTrustedSet(loadTrusted()); }, []);
  useEffect(() => {
    onTrustChange?.(domain, isTrusted);
  }, [domain, isTrusted, onTrustChange]);

  const toggleTrust = () => {
    const next = new Set(trustedSet);
    if (isTrusted) next.delete(domain); else next.add(domain);
    setTrustedSet(next);
    saveTrusted(next);
    eventBus.emit("collector.source.trust.toggled", { domain, trusted: !isTrusted });
  };

  const openSource = () => {
    if (url) window.open(url, "_blank", "noopener,noreferrer");
    eventBus.emit("collector.source.opened", { url, domain });
  };

  const openSnapshot = () => {
    // Your app might route to a snapshot view by id; emit an event either way.
    eventBus.emit("collector.source.snapshot.open", { snapshotId, url });
  };

  const reportIssue = async () => {
    eventBus.emit("collector.source.report.requested", { url, domain });
    if (automation?.runTemplate) {
      try {
        await automation.runTemplate("collector.source.reportIssue", { url, domain, title, author, publishedAt });
      } catch {}
    }
  };

  const mapIngredients = () => {
    if (!ingredients?.length) return;
    eventBus.emit("meals.ingredients.mapping.open", { rows: ingredients.map(raw => ({ raw })) });
  };

  const copyCitation = async () => {
    try {
      await navigator.clipboard?.writeText(mdCitation({ title, url, author, publishedAt }));
      eventBus.emit("collector.source.citation.copied", { url });
    } catch {}
  };

  const share = async () => {
    await safeShare({ url, title: title || domain });
    eventBus.emit("collector.source.shared", { url });
  };

  const meterPct = Math.round(conf * 100);
  const meterBarStyle = { width: `${meterPct}%` };
  const meterClass = confidenceColor(conf);

  const cap = (s = "") => (s ? s[0].toUpperCase() + s.slice(1) : s);

  return (
    <div className={`rounded-xl border shadow-sm bg-white ${compact ? "p-3" : "p-4"} w-full max-w-[720px]`}>
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg overflow-hidden flex items-center justify-center border bg-white">
          {favicon ? (
            <img src={favicon} alt="" className="w-6 h-6" loading="lazy" />
          ) : (
            <Globe className="w-5 h-5 opacity-60" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={openSource} className="text-sm font-semibold truncate hover:underline">
              {title || domain || "Source"}
            </button>
            {domain ? (
              <span className="text-xs text-gray-500 flex items-center gap-1">
                <Link2 className="w-3.5 h-3.5" />
                {domain}
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-xs text-gray-600 flex items-center gap-3 flex-wrap">
            {author && (
              <span className="inline-flex items-center gap-1">
                <User className="w-3.5 h-3.5" /> {author}
              </span>
            )}
            {publishedAt && (
              <span className="inline-flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5" /> {fmtDate(publishedAt)}
              </span>
            )}
            {license && (
              <span className="inline-flex items-center gap-1">
                <Scale className="w-3.5 h-3.5" /> {license}
              </span>
            )}
            {scrapedAt && (
              <span className="inline-flex items-center gap-1 text-gray-500">
                <FileClock className="w-3.5 h-3.5" /> Collected {fmtDate(scrapedAt)}
              </span>
            )}
          </div>
        </div>

        {/* Primary */}
        <div className="shrink-0 flex items-center gap-2">
          <button
            onClick={openSource}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border bg-white hover:bg-gray-50 text-xs"
            title="Open source"
          >
            <ExternalLink className="w-4 h-4" /> Open
          </button>
          <TrustBadge trusted={isTrusted} onClick={toggleTrust} />
        </div>
      </div>

      {/* Meta row: tags + confidence */}
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1 flex-wrap">
          {tags.slice(0, 4).map((t) => (
            <span key={t} className="text-[11px] px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">
              {cap(t)}
            </span>
          ))}
          {tags.length > 4 && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-50 text-gray-600 border">+{tags.length - 4}</span>
          )}
          {license && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100 flex items-center gap-1">
              <BadgeCheck className="w-3.5 h-3.5" /> {license}
            </span>
          )}
        </div>
        <div className="min-w-[160px]">
          <div className="flex items-center justify-between text-[11px] text-gray-500 mb-0.5">
            <span className="inline-flex items-center gap-1"><Percent className="w-3.5 h-3.5" /> Confidence</span>
            <span>{meterPct}%</span>
          </div>
          <div className="h-1.5 bg-gray-100 rounded">
            <div className={`h-full rounded ${meterClass}`} style={meterBarStyle} />
          </div>
        </div>
      </div>

      {/* Notes */}
      {!!notes && (
        <div className="mt-3 text-xs text-gray-700 bg-gray-50 border rounded-lg p-2">
          <div className="flex items-center gap-1.5 text-gray-500 mb-1">
            <Info className="w-3.5 h-3.5" /> Notes
          </div>
          <div className="leading-5">{notes}</div>
        </div>
      )}

      {/* Actions */}
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <button
          onClick={copyCitation}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border bg-white hover:bg-gray-50 text-xs"
          title="Copy Markdown citation"
        >
          <Clipboard className="w-4 h-4" /> Copy citation
        </button>

        <button
          onClick={share}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border bg-white hover:bg-gray-50 text-xs"
          title="Share"
        >
          <Share2 className="w-4 h-4" /> Share
        </button>

        {snapshotId && (
          <button
            onClick={openSnapshot}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border bg-white hover:bg-gray-50 text-xs"
            title="Open cached snapshot"
          >
            <FileText className="w-4 h-4" /> Snapshot
          </button>
        )}

        {ingredients?.length > 0 && (
          <button
            onClick={mapIngredients}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border bg-white hover:bg-gray-50 text-xs"
            title="Map ingredients to inventory"
          >
            <Boxes className="w-4 h-4" /> Map ingredients
          </button>
        )}

        {/* Inline SendTo */}
        {SendToMenu ? (
          <SendToMenu
            mode={"recipes"}                 // or "ingredients" depending on your page context
            selected={[{ id: url, title, raw: title, name: title }]}
            buttonClassName="text-xs px-2.5 py-1.5"
            label="Send to…"
            size="sm"
          />
        ) : (
          <button
            onClick={() => eventBus.emit("sendto.open", { from: "source-card", selection: [{ id: url, title }] })}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border bg-white hover:bg-gray-50 text-xs"
            title="Send to…"
          >
            <MoreHorizontal className="w-4 h-4" /> Send to…
          </button>
        )}

        <span className="grow" />
        <button
          onClick={reportIssue}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border bg-white hover:bg-gray-50 text-xs"
          title="Report parsing issue"
        >
          <Sparkles className="w-4 h-4" /> Report issue
        </button>
      </div>
    </div>
  );
}

/* ------------------------------- Subcomponents ------------------------------ */
function TrustBadge({ trusted, onClick }) {
  return trusted ? (
    <button
      onClick={onClick}
      title="Trusted domain — click to untrust"
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px]"
    >
      <ShieldCheck className="w-3.5 h-3.5" /> Trusted
    </button>
  ) : (
    <button
      onClick={onClick}
      title="Mark domain as trusted"
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-gray-50 text-gray-700 border text-[11px]"
    >
      <Shield className="w-3.5 h-3.5" /> Trust domain
    </button>
  );
}
