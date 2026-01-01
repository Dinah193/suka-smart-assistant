
// FILE: src/pages/household/meals.jsx
import React, { useMemo, useState } from "react";
import DashboardSection from "@/components/layout/DashboardSection";
import CuisineProfileCard from "@/components/cuisine/CuisineProfileCard";
import CuisinePreferencesModal from "@/components/cuisine/CuisinePreferencesModal";
import SpiceFlavorMatrixView from "@/components/cuisine/SpiceFlavorMatrixView";
import TechniqueOverlapView from "@/components/cuisine/TechniqueOverlapView";
import FeastDayMealSuggestions from "@/components/cuisine/FeastDayMealSuggestions";
import CuisineExplainPanel from "@/components/cuisine/CuisineExplainPanel";
import { resolveCuisineMeals } from "@/services/cuisine/CuisineResolver";
import { getFeatureFlag } from "@/config";

// SSA style: household steward defaults
const DEFAULT_HOUSEHOLD_ID = "default";
const CUISINE_KEY = "aai";

function next7Dates() {
  const out = [];
  const start = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    out.push(d);
  }
  return out;
}

export default function HouseholdMealsCuisinePage() {
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(false);
  const [tryNew, setTryNew] = useState(false);
  const [selectedExplainIdx, setSelectedExplainIdx] = useState(0);

  const flagsOk = useMemo(() => {
    return (
      getFeatureFlag("cuisineProfiles.enabled") !== false &&
      getFeatureFlag("cuisineProfiles.enableCuisineProfilesUI") !== false &&
      getFeatureFlag("cuisineProfiles.enableAAICuisineProfile") !== false
    );
  }, []);

  async function generate() {
    setLoading(true);
    const dates = next7Dates();
    const res = await resolveCuisineMeals({
      householdId: DEFAULT_HOUSEHOLD_ID,
      cuisineKey: CUISINE_KEY,
      dates,
      mealType: "dinner",
      tryNew,
      emitEvents: true,
    });
    setPlan(res);
    setSelectedExplainIdx(0);
    setLoading(false);
  }

  const selected = plan?.results?.[selectedExplainIdx] || null;

  if (!flagsOk) {
    return (
      <div className="p-4">
        <DashboardSection title="Meals • Cuisine">
          <div className="card">
            <div className="text-sm">
              Cuisine Profiles UI is disabled by feature flags.
            </div>
          </div>
        </DashboardSection>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <DashboardSection title="Meals • Cuisine (AAI)">
        <div className="grid lg:grid-cols-3 gap-4">
          <div className="lg:col-span-1 space-y-4">
            <CuisineProfileCard
              householdId={DEFAULT_HOUSEHOLD_ID}
              cuisineKey={CUISINE_KEY}
              onOpenPreferences={() => setPrefsOpen(true)}
            />

            <div className="card">
              <div className="text-sm font-semibold">Deterministic weekly dinner suggestions</div>
              <div className="text-xs text-[hsl(var(--text-subtle))] mt-1">
                Uses fixed rhythm + rotation state (cooldowns, protein/technique/spice variety).
              </div>

              <div className="mt-3 flex items-center gap-2">
                <input
                  id="tryNew"
                  type="checkbox"
                  checked={tryNew}
                  onChange={(e) => setTryNew(e.target.checked)}
                />
                <label htmlFor="tryNew" className="text-sm">Try something new (underused dishes)</label>
              </div>

              <div className="mt-3 flex gap-2">
                <button type="button" className="btn btn--primary btn--sm" onClick={generate} disabled={loading}>
                  {loading ? "Generating…" : "Generate 7-day plan"}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPrefsOpen(true)}>
                  Preferences
                </button>
              </div>

              {plan?.catalogsMeta?.errors?.length ? (
                <div className="text-xs text-red-600 mt-2">
                  Catalog errors: {plan.catalogsMeta.errors.join(" • ")}
                </div>
              ) : null}
            </div>

            {getFeatureFlag("cuisineProfiles.enableCuisineExplainability") !== false ? (
              <CuisineExplainPanel selection={selected} />
            ) : null}
          </div>

          <div className="lg:col-span-2 space-y-4">
            <div className="card">
              <div className="text-lg font-semibold">Upcoming dinners</div>
              <div className="text-xs text-[hsl(var(--text-subtle))]">
                Click a day to view explainability (if enabled).
              </div>

              <div className="mt-3 grid md:grid-cols-2 gap-3">
                {(plan?.results || []).map((r, idx) => (
                  <button
                    key={r.date || idx}
                    type="button"
                    className={`text-left border rounded-lg p-3 bg-white/60 hover:bg-white ${idx === selectedExplainIdx ? "ring-2 ring-black/10" : ""}`}
                    onClick={() => setSelectedExplainIdx(idx)}
                  >
                    <div className="text-xs text-gray-600">{r.date}</div>
                    <div className="font-semibold">{r.dishName || "—"}</div>
                    <div className="text-xs text-gray-600 mt-1">
                      Protein: {r?.dish?.primaryProtein || "—"} • Technique: {(r?.dish?.techniques || [])[0] || "—"}
                    </div>
                  </button>
                ))}
              </div>

              {!plan?.results?.length ? (
                <div className="text-sm text-gray-600 mt-3">
                  Generate a plan to see your cuisine rotation suggestions.
                </div>
              ) : null}
            </div>

            <SpiceFlavorMatrixView cuisineKey={CUISINE_KEY} />
            <TechniqueOverlapView cuisineKey={CUISINE_KEY} />

            {getFeatureFlag("cuisineProfiles.enableFeastDayMealSuggestions") !== false ? (
              <FeastDayMealSuggestions householdId={DEFAULT_HOUSEHOLD_ID} cuisineKey={CUISINE_KEY} />
            ) : null}
          </div>
        </div>
      </DashboardSection>

      <CuisinePreferencesModal
        isOpen={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        householdId={DEFAULT_HOUSEHOLD_ID}
      />
    </div>
  );
}
