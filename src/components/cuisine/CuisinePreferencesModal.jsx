
// FILE: src/components/cuisine/CuisinePreferencesModal.jsx
import React, { useEffect, useMemo, useState } from "react";
import BasicModal from "@/components/ui/BasicModal";
import { getCuisinePrefs, upsertCuisinePrefs } from "@/services/cuisine/CuisinePreferenceService";

const HEAT = ["none", "mild", "medium", "hot"];
const DIETS = ["normal", "keto", "carnivore", "vegetarian", "OMAD"];

function chipStr(list) {
  return (list || []).join(", ");
}
function parseList(str) {
  return String(str || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function CuisinePreferencesModal({
  isOpen,
  onClose,
  householdId = "default",
}) {
  const [prefs, setPrefs] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!isOpen) return;
    (async () => {
      const p = await getCuisinePrefs({ householdId });
      if (!alive) return;
      setPrefs(p);
    })();
    return () => { alive = false; };
  }, [isOpen, householdId]);

  const enabledKeys = useMemo(() => prefs?.enabledCuisineKeys || [], [prefs]);

  async function savePatch(patch) {
    setSaving(true);
    const next = await upsertCuisinePrefs({ householdId, patch });
    setPrefs(next);
    setSaving(false);
    try {
      const mod = await import("@/services/events/eventBus");
      const bus = mod?.default || mod;
      bus?.emit?.("cuisine.prefs.updated", { householdId, prefs: next });
    } catch {}
  }

  if (!prefs) {
    return (
      <BasicModal isOpen={isOpen} onClose={onClose} title="Cuisine Preferences">
        <div className="text-sm">Loading…</div>
      </BasicModal>
    );
  }

  return (
    <BasicModal isOpen={isOpen} onClose={onClose} title="Cuisine Preferences">
      <div className="space-y-4 text-sm">
        <div className="text-xs text-gray-600">
          These settings control deterministic cuisine selection, rotation, and substitution behavior.
        </div>

        <div>
          <div className="font-semibold">Enabled cuisines</div>
          <div className="text-xs text-gray-600">Current: {enabledKeys.join(", ") || "none"}</div>
        </div>

        <div>
          <label className="font-semibold block mb-1">Spice heat level</label>
          <select
            className="w-full border rounded px-2 py-1"
            value={prefs.spiceHeatLevel || "medium"}
            onChange={(e) => savePatch({ spiceHeatLevel: e.target.value })}
            disabled={saving}
          >
            {HEAT.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="font-semibold block mb-1">Diet mode</label>
          <select
            className="w-full border rounded px-2 py-1"
            value={prefs.dietMode || "normal"}
            onChange={(e) => savePatch({ dietMode: e.target.value })}
            disabled={saving}
          >
            {DIETS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <div className="text-xs text-gray-600 mt-1">
            Diet modes filter the dish catalog without deleting rotation history.
          </div>
        </div>

        <div>
          <label className="font-semibold block mb-1">Preferred proteins (comma-separated)</label>
          <input
            className="w-full border rounded px-2 py-1"
            value={chipStr(prefs.preferredProteins)}
            onChange={(e) => setPrefs((p) => ({ ...p, preferredProteins: parseList(e.target.value) }))}
            onBlur={() => savePatch({ preferredProteins: prefs.preferredProteins })}
            disabled={saving}
            placeholder="beef, lamb, goat, fish"
          />
          <div className="text-xs text-gray-600 mt-1">
            Used as a soft preference (rotation still maintains variety).
          </div>
        </div>

        <div>
          <label className="font-semibold block mb-1">Disliked ingredients (comma-separated)</label>
          <input
            className="w-full border rounded px-2 py-1"
            value={chipStr(prefs.dislikedIngredients)}
            onChange={(e) => setPrefs((p) => ({ ...p, dislikedIngredients: parseList(e.target.value) }))}
            onBlur={() => savePatch({ dislikedIngredients: prefs.dislikedIngredients })}
            disabled={saving}
            placeholder="okra, peanuts, cilantro"
          />
          <div className="text-xs text-gray-600 mt-1">
            Best-effort filter using dish names + recipe tags.
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            id="allowExperimentalMeals"
            type="checkbox"
            checked={prefs.allowExperimentalMeals !== false}
            onChange={(e) => savePatch({ allowExperimentalMeals: e.target.checked })}
            disabled={saving}
          />
          <label htmlFor="allowExperimentalMeals">
            Allow experimental / underused meals in “Try something new”
          </label>
        </div>

        <div className="pt-2 flex gap-2">
          <button type="button" className="btn btn--primary btn--sm" onClick={onClose}>
            Done
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => savePatch({
              spiceHeatLevel: "medium",
              dietMode: "normal",
              preferredProteins: ["beef","lamb","goat"],
              dislikedIngredients: [],
              allowExperimentalMeals: true,
            })}
            disabled={saving}
          >
            Reset
          </button>
        </div>
      </div>
    </BasicModal>
  );
}
