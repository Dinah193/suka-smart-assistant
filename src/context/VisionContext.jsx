// src/context/VisionContext.jsx
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { VISION_PRESETS } from "@/data/visionPresets";

const DEFAULT_KEY = "balanced-hybrid";
const STORAGE_KEY = "householdVision";

const VisionContext = createContext(undefined);

/* -------------------------------------------------------------------------- */
/* Days + Rhythm helpers                                                      */
/* -------------------------------------------------------------------------- */
const DAY_KEYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];

/** Ensure we always store rhythm as { day: string[] } for all 7 days. */
function normalizeRhythm(input) {
  const out = {};
  const src = (input && typeof input === "object") ? input : {};
  for (const k of DAY_KEYS) {
    const raw = src[k];
    if (Array.isArray(raw)) {
      // coerce to trimmed, unique strings
      const vals = [...new Set(raw.map(x => String(x).trim()).filter(Boolean))];
      out[k] = vals;
    } else if (typeof raw === "string" && raw.trim()) {
      out[k] = [raw.trim()];
    } else {
      out[k] = []; // default empty list (means "no specific flavor set")
    }
  }
  return out;
}

/** Derive today's day-key in local time. */
function todayKey() {
  const idx = new Date().getDay(); // 0=Sun..6=Sat
  // map to our keys
  return ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][idx];
}

/* -------------------------------------------------------------------------- */
/* storage helpers                                                            */
/* -------------------------------------------------------------------------- */
function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveToStorage(v) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {}
}

/* -------------------------------------------------------------------------- */
/* derive base options from a preset                                          */
/* -------------------------------------------------------------------------- */
function baseOptionsFromPreset(preset) {
  const p = preset || VISION_PRESETS[DEFAULT_KEY];
  const w = p.weights || {};
  const c = p.constraints || {};

  // If a preset happens to define a default weeklyFlavorRhythm, use it; otherwise empty.
  const presetRhythm = normalizeRhythm(p.weeklyFlavorRhythm || {});

  return {
    // Generic knobs many agents understand
    diyPreference: w.diyPreference ?? 0.5,
    localPreference: w.localPreference ?? 0.5,
    organicPreference: w.organicPreference ?? 0.5,
    landSqft: c.landSqft ?? 0,
    livestockAllowed: !!c.livestockAllowed,

    // Procurement-specific
    vendorPrefs: { preferred: (w.localPreference ?? 0.5) > 0.75 ? "local" : "cost" },
    budgetLimit: null, // can be computed from a budget model later

    // NEW: Flavor rhythm (Mon–Sun arrays of strings)
    weeklyFlavorRhythm: presetRhythm,
  };
}

/* -------------------------------------------------------------------------- */
/* Provider                                                                   */
/* -------------------------------------------------------------------------- */
export function VisionProvider({ children }) {
  // seed from storage or default
  const stored = loadFromStorage();
  const [key, setKey] = useState(stored?.key || DEFAULT_KEY);

  const preset = useMemo(
    () => VISION_PRESETS[key] || VISION_PRESETS[DEFAULT_KEY],
    [key]
  );

  // options are editable; start with base-from-preset overlaid by any stored options
  const [options, setOptions] = useState(() => {
    const base = baseOptionsFromPreset(preset);
    const storedOptions = stored?.options || {};

    // MIGRATION: if stored options are missing rhythm or malformed, normalize it.
    const mergedRhythm = normalizeRhythm(storedOptions.weeklyFlavorRhythm);

    return {
      ...base,
      ...storedOptions,
      weeklyFlavorRhythm: mergedRhythm, // ensure normalized shape
    };
  });

  // persist whenever key or options change
  useEffect(() => saveToStorage({ key, options }), [key, options]);

  // when preset key changes, merge new base values without nuking user tweaks
  useEffect(() => {
    const base = baseOptionsFromPreset(preset);
    setOptions(prev => ({
      ...base,
      ...prev,
      // Always keep rhythm normalized even if user/preset changed
      weeklyFlavorRhythm: normalizeRhythm(prev.weeklyFlavorRhythm),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  /* ---------------------------- convenience helpers ---------------------------- */
  // Get flavors for a given Date (defaults to today).
  const getFlavorsForDate = (date = new Date()) => {
    const dk = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][date.getDay()];
    const arr = options?.weeklyFlavorRhythm?.[dk] || [];
    return Array.isArray(arr) ? arr : [];
  };

  // Common case: today's flavors (used by MealPlan, Library suggestions, Live overlays, Share captions)
  const todayFlavors = useMemo(() => getFlavorsForDate(new Date()), [options?.weeklyFlavorRhythm]);

  // Stable value to avoid new refs each render (prevents getSnapshot loops)
  const value = useMemo(
    () => ({
      key,
      setKey,
      preset,
      options,
      setOptions,
      presets: VISION_PRESETS,
      // new helpers
      getFlavorsForDate,
      todayFlavors,
      todayFlavorKey: todayKey(),
    }),
    [key, preset, options, todayFlavors]
  );

  return <VisionContext.Provider value={value}>{children}</VisionContext.Provider>;
}

/* -------------------------------------------------------------------------- */
export const useVision = () => {
  const ctx = useContext(VisionContext);
  if (!ctx) throw new Error("useVision must be used within <VisionProvider>");
  return ctx;
};

export default VisionProvider;
