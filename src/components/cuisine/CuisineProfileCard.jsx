
// FILE: src/components/cuisine/CuisineProfileCard.jsx
import React, { useEffect, useMemo, useState } from "react";
import BasicModal from "@/components/ui/BasicModal";
import { loadCuisineCatalogs } from "@/services/cuisine/CuisineCatalogLoader";
import { getCuisinePrefs, upsertCuisinePrefs } from "@/services/cuisine/CuisinePreferenceService";

export default function CuisineProfileCard({ householdId = "default", cuisineKey = "aai", onOpenPreferences }) {
  const [catalogs, setCatalogs] = useState(null);
  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showRules, setShowRules] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setErr("");
      const c = await loadCuisineCatalogs({ cuisineKey });
      const p = await getCuisinePrefs({ householdId });
      if (!alive) return;
      setCatalogs(c);
      setPrefs(p);
      setLoading(false);
      if (c?.errors?.length) setErr(c.errors.join(" • "));
    })();
    return () => { alive = false; };
  }, [householdId, cuisineKey]);

  const enabled = useMemo(() => {
    const keys = prefs?.enabledCuisineKeys || [];
    return keys.includes(cuisineKey);
  }, [prefs, cuisineKey]);

  async function toggleEnabled() {
    const nextKeys = new Set([...(prefs?.enabledCuisineKeys || [])]);
    if (enabled) nextKeys.delete(cuisineKey);
    else nextKeys.add(cuisineKey);
    const next = await upsertCuisinePrefs({
      householdId,
      patch: { enabledCuisineKeys: Array.from(nextKeys) }
    });
    setPrefs(next);
    try {
      const { emit } = (await import("@/services/events/eventBus")).default || (await import("@/services/events/eventBus"));
      emit?.("cuisine.profile.enabled", { householdId, cuisineKey, enabled: !enabled });
    } catch {}
  }

  const profile = catalogs?.profile || {};
  const torah = profile?.principles?.torahFoodLaw || {};

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-[hsl(var(--text-subtle))]">Cuisine Profile</div>
          <div className="text-lg font-semibold leading-tight">{profile?.name || "Cuisine"}</div>
          <div className="text-xs text-[hsl(var(--text-subtle))] mt-1">
            {profile?.description || "Fixed cuisine logic for meal planning."}
          </div>
        </div>

        <button
          type="button"
          className={`btn ${enabled ? "btn--primary" : "btn--ghost"} btn--sm`}
          onClick={toggleEnabled}
          disabled={loading}
          title={enabled ? "Disable cuisine profile" : "Enable cuisine profile"}
        >
          {enabled ? "Enabled" : "Enable"}
        </button>
      </div>

      {err ? (
        <div className="mt-2 text-xs text-red-600">
          Catalog warnings: {err}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowRules(true)}>
          Torah-safe rules
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => onOpenPreferences?.()}
          disabled={!enabled}
          title={!enabled ? "Enable the profile to edit preferences" : "Edit cuisine preferences"}
        >
          Preferences
        </button>
      </div>

      <BasicModal isOpen={showRules} onClose={() => setShowRules(false)} title="Torah-safe food law (metadata)">
        <div className="text-sm space-y-2">
          <div className="text-xs text-gray-600">
            SSA uses this as metadata to keep meal planning aligned to Torah food law constraints (scripture-only).
          </div>
          <div>
            <div className="font-semibold">Summary</div>
            <div className="text-sm">{torah?.summary || "—"}</div>
          </div>
          <div>
            <div className="font-semibold">Scripture refs</div>
            <ul className="list-disc ml-5">
              {(torah?.scriptureRefs || []).map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>
          <div>
            <div className="font-semibold">Allowed land proteins</div>
            <div className="text-sm">{(torah?.allowedLandProteins || []).join(", ") || "—"}</div>
          </div>
          <div>
            <div className="font-semibold">Allowed fish (fins + scales)</div>
            <div className="text-sm">{(torah?.allowedFish || []).join(", ") || "—"}</div>
          </div>
          <div>
            <div className="font-semibold">Excluded categories</div>
            <div className="text-sm">{(torah?.excludeCategories || []).join(", ") || "—"}</div>
          </div>
        </div>
      </BasicModal>
    </div>
  );
}
