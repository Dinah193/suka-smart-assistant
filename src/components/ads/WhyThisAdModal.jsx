// src/components/ads/WhyThisAdModal.jsx
import React, { useEffect, useMemo, useState } from "react";
import {
  getAdsPrefs,
  setAdsPrefs,
} from "@/services/ads/SponsoredPlacementService";

function fmtDistance(meters) {
  if (!Number.isFinite(meters)) return null;
  const mi = meters / 1609.344;
  if (mi < 0.2) return `${Math.round(meters)} m`;
  return `${mi.toFixed(mi < 10 ? 1 : 0)} mi`;
}

export default function WhyThisAdModal({
  open,
  onClose,
  payload = null, // { place, meta, filters, context }
}) {
  const [prefs, setPrefs] = useState(() => getAdsPrefs());

  useEffect(() => {
    const onPrefs = () => setPrefs(getAdsPrefs());
    window.addEventListener("ads.preferences.changed", onPrefs);
    return () => window.removeEventListener("ads.preferences.changed", onPrefs);
  }, []);

  const place = payload?.place || payload?.rawPlace || null;
  const meta = payload?.meta || payload?.sponsoredMeta || null;
  const filters = payload?.filters || null;

  const reasons = useMemo(() => {
    const out = [];
    if (filters?.allowedCategories?.length) {
      out.push(
        `Matches your categories (${filters.allowedCategories.join(", ")})`
      );
    }
    if (filters?.maxDistanceMeters != null && place?.distanceMeters != null) {
      out.push(
        `Within your distance range (${fmtDistance(place.distanceMeters)})`
      );
    }
    if (filters?.requireOpenNow) out.push("Only showing stores open now");
    if (!out.length)
      out.push("Shown because it matches your current store filters");
    return out;
  }, [filters, place]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-xl card bg-base-100 rounded-2xl shadow-xl border border-base-200">
        <div className="card-body">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold">Why am I seeing this?</h3>
              <p className="text-sm opacity-80 mt-1">
                Sponsored placements are always labeled and still must match
                your filters.
              </p>
            </div>
            <button
              className="btn btn-ghost btn-sm rounded-2xl"
              onClick={onClose}
            >
              ✕
            </button>
          </div>

          <div className="mt-3 p-3 rounded-2xl bg-base-200/60">
            <div className="text-sm font-semibold">
              {place?.name || "This store"}
            </div>
            <div className="text-xs opacity-80 mt-1">
              Source: {meta?.source || "local sponsors"}
              {meta?.campaignId ? ` • Campaign ${meta.campaignId}` : ""}
            </div>
            <ul className="mt-2 text-sm list-disc pl-5 space-y-1">
              {reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>

          <div className="mt-4 grid gap-3">
            <div className="flex items-center justify-between gap-3 p-3 rounded-2xl border border-base-200">
              <div>
                <div className="font-semibold text-sm">
                  Sponsored placements
                </div>
                <div className="text-xs opacity-70">
                  Turn this off to never see sponsored store cards.
                </div>
              </div>
              <input
                type="checkbox"
                className="toggle toggle-primary"
                checked={!!prefs.sponsoredPlacementsEnabled}
                onChange={(e) =>
                  setAdsPrefs({ sponsoredPlacementsEnabled: e.target.checked })
                }
              />
            </div>

            <div className="flex items-center justify-between gap-3 p-3 rounded-2xl border border-base-200">
              <div>
                <div className="font-semibold text-sm">
                  Share ads telemetry (opt-in)
                </div>
                <div className="text-xs opacity-70">
                  Helps improve sponsor selection. Stored locally unless you
                  opt-in.
                </div>
              </div>
              <input
                type="checkbox"
                className="toggle toggle-primary"
                checked={!!prefs.shareAdsTelemetry}
                onChange={(e) =>
                  setAdsPrefs({ shareAdsTelemetry: e.target.checked })
                }
              />
            </div>

            <div className="flex items-center justify-between gap-3 p-3 rounded-2xl border border-base-200">
              <div>
                <div className="font-semibold text-sm">
                  Receipt conversion proxy (premium)
                </div>
                <div className="text-xs opacity-70">
                  If enabled, a receipt-confirmed purchase can be used as a
                  conversion signal.
                </div>
              </div>
              <input
                type="checkbox"
                className="toggle toggle-primary"
                checked={!!prefs.premiumConversionProxy}
                onChange={(e) =>
                  setAdsPrefs({ premiumConversionProxy: e.target.checked })
                }
              />
            </div>
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              className="btn btn-ghost btn-sm rounded-2xl"
              onClick={onClose}
            >
              Close
            </button>
          </div>

          <p className="text-xs opacity-60 mt-3">
            Trust note: SSA won’t show a sponsor if it doesn’t match your
            current filters (distance/category/open-now), and sponsored cards
            must be clearly labeled.
          </p>
        </div>
      </div>
    </div>
  );
}
