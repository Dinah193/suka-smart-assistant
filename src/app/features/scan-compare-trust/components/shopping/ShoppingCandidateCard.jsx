// C:\Users\larho\suka-smart-assistant\src\app\features\scan-compare-trust\components\shopping\ShoppingCandidateCard.jsx
import React, { useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Tag,
  ShieldAlert,
  Wheat,
  Store,
  Info,
} from "lucide-react";

import StoreCompareTable from "./StoreCompareTable";
import CouponStrip from "./CouponStrip";
import RecallBanner from "./RecallBanner";
import IngredientsCheckPanel from "./IngredientsCheckPanel";

/**
 * ShoppingCandidateCard
 * -----------------------------------------------------------------------------
 * Displays a "shopping scan result" card for a staged candidate scan.
 *
 * ✅ Shows:
 *  - price at current store (if known)
 *  - compare table across selected stores
 *  - coupons strip
 *  - recall banner
 *  - ingredients flags
 *
 * ✅ Streaming-friendly:
 *  - supports updates via eventBus (optional)
 *
 * ✅ Enrichment-aware:
 *  - Accepts candidate.resolved
 *  - Shows "loading enrichment…" until each section arrives
 *  - Works in list view (dense/compact) and modal view (full)
 *
 * Expected candidate shape (flexible):
 * {
 *   id, status, createdAt,
 *   stores: ["Walmart", ...],
 *   storeSetKey,
 *   scan: { id, kind, content, meta, at, intent, mode },
 *   resolved?: {
 *     item?: { title, brand, size, upc, sku, imageUrl, category }
 *     observations?: [{store, price, unitPrice, currency, at, source, inStock}]
 *     coupons?: [{ id, title, amountOff, pctOff, store, expiresAt, code, url }]
 *     recalls?: [{ id, title, severity, summary, url, date, affected }]
 *     ingredientsCheck?: { ok, flags: [...], allergens: [...], additives: [...], notes }
 *   }
 * }
 *
 * Props:
 * - candidate (required)
 * - currentStore (optional string) — used for "price at current store" label
 * - eventBus (optional) — if present, listens for enrichment updates
 * - onOpenDetails (optional)
 * - dense (optional boolean)   (list/compact use-case)
 */

export default function ShoppingCandidateCard({
  candidate,
  currentStore,
  eventBus,
  dense = false,
  onOpenDetails,
}) {
  const c = candidate || {};
  const scan = c.scan || {};
  const resolved = c.resolved || {};

  // "compact" behavior: dense list cards typically start collapsed
  const [expanded, setExpanded] = useState(!dense);

  // Local snapshot that can be patched by eventBus streaming updates
  const [liveResolved, setLiveResolved] = useState(resolved);

  // If props.resolved changes from upstream, refresh local snapshot.
  // (Use a broader dependency set than just item fields; allow partial section updates.)
  useEffect(() => {
    setLiveResolved(resolved || {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    c?.id,
    resolved?.item?.upc,
    resolved?.item?.title,
    // section-level changes (non-exhaustive but practical)
    Array.isArray(resolved?.observations) ? resolved.observations.length : 0,
    Array.isArray(resolved?.coupons) ? resolved.coupons.length : 0,
    Array.isArray(resolved?.recalls) ? resolved.recalls.length : 0,
    resolved?.ingredientsCheck?.ok,
    Array.isArray(resolved?.ingredientsCheck?.flags)
      ? resolved.ingredientsCheck.flags.length
      : 0,
  ]);

  // Optional: live updates via eventBus (enrichment pipeline can push updates)
  useEffect(() => {
    if (!eventBus?.on || !c?.id) return;

    function onUpdate(payload) {
      // payload: { candidateId, resolved: {...} }
      // OR { candidateId, patch: { resolved: {...} } }
      // OR { candidateId, patch: {...resolvedSubtree} }
      const cid = payload?.candidateId || payload?.id;
      if (String(cid) !== String(c.id)) return;

      const nextResolved =
        payload?.resolved ||
        payload?.patch?.resolved ||
        payload?.patch ||
        payload?.data?.resolved ||
        null;

      if (nextResolved && typeof nextResolved === "object") {
        setLiveResolved((prev) => deepMerge(prev || {}, nextResolved));
      }
    }

    eventBus.on("shopping:candidate.enriched", onUpdate);
    eventBus.on("shopping:candidate.updated", onUpdate);
    eventBus.on("shopping:candidate.patch", onUpdate);

    return () => {
      eventBus.off?.("shopping:candidate.enriched", onUpdate);
      eventBus.off?.("shopping:candidate.updated", onUpdate);
      eventBus.off?.("shopping:candidate.patch", onUpdate);
    };
  }, [eventBus, c?.id]);

  // Candidate stores + primary store context
  const stores = Array.isArray(c.stores) ? c.stores : [];
  const storePrimary = currentStore || stores[0] || null;

  // Section extraction
  const item = (liveResolved && liveResolved.item) || guessItemFromScan(scan);

  const observations = Array.isArray(liveResolved?.observations)
    ? liveResolved.observations
    : [];

  const coupons = Array.isArray(liveResolved?.coupons)
    ? liveResolved.coupons
    : [];
  const recalls = Array.isArray(liveResolved?.recalls)
    ? liveResolved.recalls
    : [];

  const ingredientsCheck =
    liveResolved?.ingredientsCheck &&
    typeof liveResolved.ingredientsCheck === "object"
      ? liveResolved.ingredientsCheck
      : null;

  // Loading state per section (you asked: “loading enrichment…” until each section arrives)
  const loading = useMemo(() => {
    const hasAnyResolved = liveResolved && Object.keys(liveResolved).length > 0;

    const hasItem =
      !!liveResolved?.item &&
      typeof liveResolved.item === "object" &&
      Object.keys(liveResolved.item).length > 0;

    const hasObservations = Array.isArray(liveResolved?.observations);
    const hasCoupons = Array.isArray(liveResolved?.coupons);
    const hasRecalls = Array.isArray(liveResolved?.recalls);
    const hasIngredients = !!ingredientsCheck;

    // If we have no resolved at all, everything is "loading"
    if (!hasAnyResolved) {
      return {
        any: true,
        item: true,
        observations: true,
        coupons: true,
        recalls: true,
        ingredients: true,
      };
    }

    // Otherwise, section-level loading means "not present yet" (still streaming)
    return {
      any: false,
      item: !hasItem,
      observations: !hasObservations,
      coupons: !hasCoupons,
      recalls: !hasRecalls,
      ingredients: !hasIngredients,
    };
  }, [liveResolved, ingredientsCheck]);

  const status = String(c.status || "staged");
  const statusTone = statusToneFor(status);

  const primaryPrice = useMemo(() => {
    if (!storePrimary) return null;
    return pickBestObservationForStore(observations, storePrimary);
  }, [observations, storePrimary]);

  const compareRows = useMemo(() => {
    return buildCompareRows({ observations, stores });
  }, [observations, stores]);

  const flagsSummary = useMemo(() => {
    const out = [];
    const recallSeverity = maxRecallSeverity(recalls);
    if (recallSeverity) out.push({ kind: "recall", severity: recallSeverity });

    const coupCount = coupons.length;
    if (coupCount > 0) out.push({ kind: "coupon", count: coupCount });

    const ingFlags = Array.isArray(ingredientsCheck?.flags)
      ? ingredientsCheck.flags
      : [];
    if (ingFlags.length > 0)
      out.push({ kind: "ingredients", count: ingFlags.length });

    return out;
  }, [recalls, coupons, ingredientsCheck]);

  return (
    <div className="rounded-xl border bg-background overflow-hidden">
      {/* Header */}
      <div className="p-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`text-[11px] px-2 py-0.5 rounded-full border ${statusTone}`}
              title={`Candidate status: ${status}`}
            >
              {status.toUpperCase()}
            </span>

            {storePrimary ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Store className="h-3.5 w-3.5" />
                {storePrimary}
              </span>
            ) : null}

            {/* Global enrichment chip */}
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              {loading.any ? (
                <>
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                  loading enrichment…
                </>
              ) : (
                <>
                  <BadgeCheck className="h-3.5 w-3.5 text-emerald-600" />
                  live data
                </>
              )}
            </span>
          </div>

          <div className="mt-1 text-sm font-semibold truncate">
            {loading.item ? (
              <span className="text-muted-foreground">Loading item…</span>
            ) : (
              item?.title || "Scanned Item"
            )}
          </div>

          <div className="mt-0.5 text-[12px] text-muted-foreground truncate">
            {loading.item ? (
              <span>Loading details…</span>
            ) : (
              <>
                {item?.brand ? `${item.brand} • ` : ""}
                {item?.size ? `${item.size} • ` : ""}
                {item?.upc
                  ? `UPC: ${item.upc}`
                  : scan?.kind === "barcode"
                  ? scan?.content
                  : ""}
              </>
            )}
          </div>

          {/* Primary price */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <div className="text-sm font-medium">
              {loading.observations ? (
                <span className="text-[12px] text-muted-foreground">
                  Loading price…
                </span>
              ) : primaryPrice?.price != null ? (
                <>
                  {formatMoney(primaryPrice.price, primaryPrice.currency)}{" "}
                  <span className="text-[12px] text-muted-foreground">
                    {primaryPrice.unitPrice != null
                      ? `(${formatMoney(
                          primaryPrice.unitPrice,
                          primaryPrice.currency
                        )}/${primaryPrice.unit || "unit"})`
                      : null}
                  </span>
                </>
              ) : (
                <span className="text-[12px] text-muted-foreground">
                  Price not found yet
                </span>
              )}
            </div>

            {/* Flags chips */}
            <div className="flex flex-wrap gap-2">
              {flagsSummary.map((f, idx) => (
                <FlagChip key={`${f.kind}:${idx}`} flag={f} />
              ))}
              {/* Section-level "loading" chips (only if that section isn't present yet) */}
              {dense ? (
                <>
                  {loading.coupons ? <MiniLoadChip label="Coupons…" /> : null}
                  {loading.recalls ? <MiniLoadChip label="Recalls…" /> : null}
                  {loading.ingredients ? (
                    <MiniLoadChip label="Ingredients…" />
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          <button
            className="px-2 py-1 text-xs rounded-md border hover:bg-muted"
            onClick={() => setExpanded((x) => !x)}
            aria-expanded={expanded}
          >
            {expanded ? (
              <>
                <ChevronUp className="h-4 w-4 inline mr-1" /> Hide
              </>
            ) : (
              <>
                <ChevronDown className="h-4 w-4 inline mr-1" /> Details
              </>
            )}
          </button>

          {typeof onOpenDetails === "function" ? (
            <button
              className="px-2 py-1 text-xs rounded-md border hover:bg-muted"
              onClick={() => onOpenDetails(c)}
            >
              <Info className="h-4 w-4 inline mr-1" /> Open
            </button>
          ) : null}
        </div>
      </div>

      {/* Recall banner (always above details) */}
      {loading.recalls ? (
        <LoadingRow label="Loading recalls…" />
      ) : recalls.length ? (
        <RecallBanner recalls={recalls} />
      ) : null}

      {/* Details */}
      {expanded ? (
        <div className="px-3 pb-3 space-y-3">
          {loading.coupons ? (
            <LoadingBox title="Coupons" />
          ) : coupons.length ? (
            <CouponStrip coupons={coupons} stores={stores} />
          ) : (
            <EmptyHint dense={dense} label="No coupons found." />
          )}

          {loading.observations ? (
            <LoadingBox title="Store Compare" />
          ) : (
            <StoreCompareTable
              stores={stores}
              rows={compareRows}
              highlightStore={storePrimary}
            />
          )}

          {loading.ingredients ? (
            <LoadingBox title="Ingredients" />
          ) : (
            <IngredientsCheckPanel
              ingredientsCheck={ingredientsCheck}
              item={item}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ UI Helpers ------------------------------ */

function FlagChip({ flag }) {
  if (!flag) return null;

  if (flag.kind === "recall") {
    const sev = String(flag.severity || "medium");
    const tone =
      sev === "high"
        ? "bg-red-50 text-red-700 border-red-200"
        : sev === "medium"
        ? "bg-amber-50 text-amber-800 border-amber-200"
        : "bg-slate-50 text-slate-700 border-slate-200";
    return (
      <span
        className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${tone}`}
      >
        <ShieldAlert className="h-3.5 w-3.5" /> Recall
      </span>
    );
  }

  if (flag.kind === "coupon") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">
        <Tag className="h-3.5 w-3.5" /> {flag.count} coupon
        {flag.count === 1 ? "" : "s"}
      </span>
    );
  }

  if (flag.kind === "ingredients") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border bg-indigo-50 text-indigo-700 border-indigo-200">
        <Wheat className="h-3.5 w-3.5" /> {flag.count} flag
        {flag.count === 1 ? "" : "s"}
      </span>
    );
  }

  return null;
}

function MiniLoadChip({ label }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border bg-slate-50 text-slate-700 border-slate-200">
      <AlertTriangle className="h-3.5 w-3.5 text-amber-600" /> {label}
    </span>
  );
}

function LoadingRow({ label }) {
  return (
    <div className="px-3 pb-2">
      <div className="text-[12px] text-muted-foreground inline-flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-600" />
        {label}
      </div>
    </div>
  );
}

function LoadingBox({ title }) {
  return (
    <div className="rounded-lg border p-3 bg-slate-50">
      <div className="text-xs font-medium">{title}</div>
      <div className="mt-2 h-3 w-2/3 rounded bg-slate-200 animate-pulse" />
      <div className="mt-2 h-3 w-1/2 rounded bg-slate-200 animate-pulse" />
      <div className="mt-2 h-3 w-3/4 rounded bg-slate-200 animate-pulse" />
    </div>
  );
}

function EmptyHint({ label }) {
  return <div className="text-[12px] text-muted-foreground px-1">{label}</div>;
}

/* ------------------------------ Data Helpers ------------------------------ */

function statusToneFor(status) {
  const s = String(status || "").toLowerCase();
  if (s === "committed" || s === "reconciled")
    return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (s === "blocked" || s === "failed")
    return "bg-red-50 text-red-700 border-red-200";
  if (s === "enriched" || s === "ready")
    return "bg-indigo-50 text-indigo-700 border-indigo-200";
  return "bg-slate-50 text-slate-700 border-slate-200";
}

function guessItemFromScan(scan) {
  const kind = String(scan?.kind || "");
  const content = String(scan?.content || "");
  if (kind === "barcode") {
    return { title: "Barcode scan", upc: content };
  }
  if (kind === "text") {
    return { title: content.slice(0, 60) || "Text scan" };
  }
  if (kind === "image") {
    return { title: "Image scan" };
  }
  return { title: "Scan" };
}

function pickBestObservationForStore(observations, store) {
  const sNorm = normStore(store);
  const matches = (observations || []).filter(
    (o) => normStore(o?.store) === sNorm
  );
  if (!matches.length) return null;

  // Prefer inStock then newest
  matches.sort((a, b) => {
    const ai = a?.inStock === false ? 1 : 0;
    const bi = b?.inStock === false ? 1 : 0;
    if (ai !== bi) return ai - bi;
    return Number(b?.at || 0) - Number(a?.at || 0);
  });
  return normalizeObservation(matches[0]);
}

function buildCompareRows({ observations, stores }) {
  const obs = Array.isArray(observations)
    ? observations.map(normalizeObservation)
    : [];
  const storeList = Array.isArray(stores) ? stores : [];

  const out = storeList.map((s) => {
    const best = pickBestObservationForStore(obs, s);
    return {
      store: s,
      price: best?.price ?? null,
      unitPrice: best?.unitPrice ?? null,
      currency: best?.currency || "USD",
      inStock: best?.inStock ?? null,
      source: best?.source || null,
      at: best?.at || null,
      confidence: best?.confidence ?? null,
    };
  });

  // If there are observations for stores not in selected store list, append them.
  const extraStores = new Set();
  for (const o of obs) {
    const st = String(o?.store || "").trim();
    if (!st) continue;
    if (!storeList.some((s) => normStore(s) === normStore(st)))
      extraStores.add(st);
  }
  for (const st of extraStores) {
    const best = pickBestObservationForStore(obs, st);
    out.push({
      store: st,
      price: best?.price ?? null,
      unitPrice: best?.unitPrice ?? null,
      currency: best?.currency || "USD",
      inStock: best?.inStock ?? null,
      source: best?.source || null,
      at: best?.at || null,
      confidence: best?.confidence ?? null,
    });
  }

  return out;
}

function normalizeObservation(o) {
  if (!o || typeof o !== "object") return {};
  return {
    store: o.store || o.retailer || o.market || "",
    price: toNum(o.price),
    unitPrice: toNum(o.unitPrice || o.unit_price),
    unit: o.unit || o.unitLabel || o.unit_label || null,
    currency: o.currency || "USD",
    inStock: typeof o.inStock === "boolean" ? o.inStock : o.in_stock,
    at: o.at || o.ts || o.observedAt || o.observed_at || null,
    source: o.source || o.provider || null,
    confidence: toNum(o.confidence),
  };
}

function maxRecallSeverity(recalls) {
  const list = Array.isArray(recalls) ? recalls : [];
  let best = null;
  for (const r of list) {
    const sev = String(r?.severity || "").toLowerCase();
    const rank =
      sev === "high" ? 3 : sev === "medium" ? 2 : sev === "low" ? 1 : 0;
    if (!best || rank > best.rank) best = { severity: sev || "medium", rank };
  }
  return best?.severity || null;
}

function formatMoney(value, currency = "USD") {
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

function normStore(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
