// File: src/pages/household/HouseholdMealsCuisine.jsx
/**
 * HouseholdMealsCuisine
 * -----------------------------------------------------------------------------
 * SSA Household Meal Cuisine configuration page.
 *
 * Goals
 *  - Provide a stable, production-safe household cuisine preferences editor.
 *  - Browser-safe (no Node imports).
 *  - Works even if optional SSA stores/services are missing.
 *  - Persists to localStorage by default (so users don't lose settings).
 *  - Emits SSA eventBus events if available (non-fatal if not).
 *
 * Why this exists
 *  - Your error: "HouseholdMealsCuisinePage is not defined" means a route/component
 *    was referenced but never imported or created. This file gives you a solid
 *    household cuisine settings page you can wire into App routes.
 *
 * Notes
 *  - This page does NOT assume Dexie schemas exist (keeps build stable).
 *  - Later you can replace localStorage persistence with a HouseholdProfileStore
 *    or Dexie-backed preference store with the same "contract".
 */

import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";

/* -----------------------------------------------------------------------------
 * Optional integration (safe)
 * -------------------------------------------------------------------------- */
function safeRequireEventBus() {
  // Avoid static import to keep builds safe if file paths change.
  // If your eventBus exists at "@/services/eventBus", this will load it.
  // If it doesn't, we silently no-op.
  return null;
}

function getEventBus() {
  // Best-effort: check global first (some SSA setups attach it)
  if (typeof window !== "undefined" && window.__SSA_EVENT_BUS__) {
    return window.__SSA_EVENT_BUS__;
  }
  // Try local dynamic import if available (but do not block rendering)
  // We keep it simple and only use global bus by default.
  return safeRequireEventBus();
}

function emitEvent(topic, payload) {
  try {
    const bus = getEventBus();
    if (!bus) return;
    if (typeof bus.emit === "function") bus.emit(topic, payload);
    else if (typeof bus.publish === "function") bus.publish(topic, payload);
    else if (typeof bus.dispatch === "function") bus.dispatch(topic, payload);
  } catch {
    // never crash the UI
  }
}

/* -----------------------------------------------------------------------------
 * Storage helpers (browser-safe)
 * -------------------------------------------------------------------------- */
const LS_KEY = "ssa.household.mealsCuisine.v1";

function safeJsonParse(s, fallback) {
  try {
    if (!s) return fallback;
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function nowISO() {
  try {
    return new Date().toISOString();
  } catch {
    return "";
  }
}

/* -----------------------------------------------------------------------------
 * Domain defaults (opinionated but safe)
 * -------------------------------------------------------------------------- */
const CUISINE_PRESETS = [
  {
    id: "aai-core",
    name: "African-American Israelite (Core)",
    desc: "Southern roots + Mediterranean + West African, Torah-law aware, preservation-forward.",
    tags: ["southern", "mediterranean", "west-african", "torah-aware"],
  },
  {
    id: "caribbean",
    name: "Caribbean Stream",
    desc: "Island spice profiles, stews, curry blends, cabbage sides, festival breads.",
    tags: ["caribbean", "stew", "curry", "spice-forward"],
  },
  {
    id: "west-african",
    name: "West African Stream",
    desc: "Suya-style seasonings, groundnut stews, jollof families, fermented accents.",
    tags: ["west-african", "suya", "stew", "fermented"],
  },
  {
    id: "mediterranean",
    name: "Mediterranean Stream",
    desc: "Grilled meats, olive-forward profiles, legumes, flatbreads, bright herbs.",
    tags: ["mediterranean", "grill", "legumes", "herbs"],
  },
  {
    id: "indian",
    name: "Indian Stream",
    desc: "Masala logic, dal/legumes, tandoor techniques, layered spice system.",
    tags: ["indian", "masala", "dal", "spice-system"],
  },
];

const TECHNIQUE_OPTIONS = [
  "Grilling",
  "Roasting",
  "Braising/Stewing",
  "Pan-Searing",
  "Smoking",
  "Curing",
  "Fermenting",
  "Dehydrating",
  "Pressure Canning",
  "Freezing",
  "Batch Cooking",
  "Flatbread/Baking",
];

const SPICE_FAMILIES = [
  {
    id: "warm",
    name: "Warm & Sweet",
    examples: "cinnamon, allspice, nutmeg, clove",
  },
  {
    id: "savory",
    name: "Savory Herbs",
    examples: "thyme, oregano, rosemary, bay",
  },
  {
    id: "peppery",
    name: "Pepper Heat",
    examples: "black pepper, cayenne, scotch bonnet",
  },
  { id: "earthy", name: "Earthy", examples: "cumin, coriander, fenugreek" },
  {
    id: "smoky",
    name: "Smoky",
    examples: "smoked paprika, chipotle, smoked salt",
  },
  {
    id: "tangy",
    name: "Tangy/Bright",
    examples: "sumac, citrus zest, vinegar-forward",
  },
  {
    id: "umami",
    name: "Umami",
    examples: "tomato paste, dried mushrooms, anchovy (if allowed)",
  },
];

const MEAT_OPTIONS = [
  "Beef",
  "Lamb",
  "Goat",
  "Chicken",
  "Turkey",
  "Fish (scaled/finned)",
  "Wild Game (as configured)",
];

const FAT_OPTIONS = [
  "Tallow",
  "Ghee (if used)",
  "Olive Oil",
  "Avocado Oil",
  "Coconut Oil",
  "Butter (if used)",
];

/**
 * Torah-aware toggles:
 * - This page doesn't enforce law; it configures your household rules.
 * - Your meal engine should read these flags and filter suggestions accordingly.
 */
function defaultCuisineState() {
  return {
    meta: {
      version: 1,
      createdAtISO: nowISO(),
      updatedAtISO: nowISO(),
      source: "defaults",
    },
    householdId: "default",
    enabledCuisinePresetIds: ["aai-core"],
    customCuisineStreams: [], // { id, name, desc, tags }
    allowedMeats: [
      "Beef",
      "Lamb",
      "Goat",
      "Chicken",
      "Turkey",
      "Fish (scaled/finned)",
    ],
    excludedMeats: [], // explicit exclusions
    preferredFats: ["Tallow", "Olive Oil"],
    techniquePreferences: {
      favorite: ["Braising/Stewing", "Batch Cooking", "Roasting"],
      avoid: [],
    },
    spicePreferences: {
      familiesOn: ["savory", "peppery", "earthy", "smoky", "tangy"],
      heatLevel: 3, // 0-5
      saltLevel: 3, // 0-5
      sweetLevel: 2, // 0-5
    },
    breadAndGrains: {
      includeFlatbreads: true,
      includeCornbreads: true,
      includeRice: true,
      includeWheatBreads: true,
      includeGlutenFreeRotation: false,
    },
    veggiesAndSides: {
      prioritizeLeafyGreens: true,
      prioritizeCabbage: true,
      prioritizeBeans: true,
      prioritizeRoots: true,
    },
    preservationAlignment: {
      curingEnabled: true,
      smokingEnabled: true,
      fermentationEnabled: true,
      dehydrationEnabled: true,
      pressureCanningEnabled: true,
      freezerEnabled: true,
    },
    feastDayLogic: {
      enabled: false,
      notes:
        "Optional: later connect to your feast-day meal planner and storehouse list generator.",
    },
    notes: "",
  };
}

/* -----------------------------------------------------------------------------
 * Small UI utilities (no external deps)
 * -------------------------------------------------------------------------- */
function clamp(n, min, max) {
  const x = Number.isFinite(n) ? n : min;
  return Math.max(min, Math.min(max, x));
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function toggleInArray(arr, value) {
  const set = new Set(arr);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  return Array.from(set);
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    const bv = base ? base[k] : undefined;
    if (Array.isArray(pv)) out[k] = pv.slice();
    else if (pv && typeof pv === "object" && !Array.isArray(pv))
      out[k] = deepMerge(bv || {}, pv);
    else out[k] = pv;
  }
  return out;
}

function prettyJson(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return "";
  }
}

/* -----------------------------------------------------------------------------
 * Main Component
 * -------------------------------------------------------------------------- */
export default function HouseholdMealsCuisine() {
  const [state, setState] = useState(() => defaultCuisineState());
  const [status, setStatus] = useState(() => ({
    hydrated: false,
    dirty: false,
    saving: false,
    lastSavedAtISO: "",
    error: "",
  }));

  const initialHydratedRef = useRef(false);
  const lastSavedSnapshotRef = useRef("");

  const computedEnabledPresets = useMemo(() => {
    const enabled = state.enabledCuisinePresetIds || [];
    const base = CUISINE_PRESETS.filter((p) => enabled.includes(p.id));
    const custom = (state.customCuisineStreams || []).filter((s) => s && s.id);
    return { base, custom };
  }, [state.enabledCuisinePresetIds, state.customCuisineStreams]);

  const updateState = useCallback((patchOrFn) => {
    setState((prev) => {
      const patch =
        typeof patchOrFn === "function" ? patchOrFn(prev) : patchOrFn;
      const merged = deepMerge(prev, patch);
      merged.meta = {
        ...(merged.meta || {}),
        updatedAtISO: nowISO(),
        source: "user",
      };
      return merged;
    });
    setStatus((s) => ({ ...s, dirty: true }));
  }, []);

  /* -----------------------------------------------------------------------------
   * Hydrate from localStorage (once)
   * -------------------------------------------------------------------------- */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (initialHydratedRef.current) return;
    initialHydratedRef.current = true;

    const raw = window.localStorage.getItem(LS_KEY);
    const parsed = safeJsonParse(raw, null);

    if (parsed && typeof parsed === "object") {
      const merged = deepMerge(defaultCuisineState(), parsed);
      merged.meta = {
        ...(merged.meta || {}),
        source: "localStorage",
        updatedAtISO: nowISO(),
      };
      setState(merged);
      lastSavedSnapshotRef.current = prettyJson(merged);
    } else {
      const d = defaultCuisineState();
      lastSavedSnapshotRef.current = prettyJson(d);
    }

    setStatus((s) => ({ ...s, hydrated: true }));
    emitEvent("household.cuisine.hydrated", { key: LS_KEY });
  }, []);

  /* -----------------------------------------------------------------------------
   * Auto-save (debounced)
   * -------------------------------------------------------------------------- */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!status.hydrated) return;
    if (!status.dirty) return;

    const handle = window.setTimeout(() => {
      try {
        setStatus((s) => ({ ...s, saving: true, error: "" }));
        const snapshot = prettyJson(state);

        // If no actual changes, don't write.
        if (snapshot && snapshot === lastSavedSnapshotRef.current) {
          setStatus((s) => ({ ...s, saving: false, dirty: false }));
          return;
        }

        window.localStorage.setItem(LS_KEY, snapshot);
        lastSavedSnapshotRef.current = snapshot;

        const ts = nowISO();
        setStatus((s) => ({
          ...s,
          saving: false,
          dirty: false,
          lastSavedAtISO: ts,
        }));

        emitEvent("household.cuisine.saved", { key: LS_KEY, atISO: ts });
      } catch (e) {
        setStatus((s) => ({
          ...s,
          saving: false,
          error: e?.message || "Failed to save settings.",
        }));
      }
    }, 450);

    return () => window.clearTimeout(handle);
  }, [state, status.hydrated, status.dirty]);

  /* -----------------------------------------------------------------------------
   * Actions
   * -------------------------------------------------------------------------- */
  const onResetDefaults = useCallback(() => {
    const d = defaultCuisineState();
    setState(d);
    setStatus((s) => ({ ...s, dirty: true, error: "" }));
    emitEvent("household.cuisine.resetDefaults", { key: LS_KEY });
  }, []);

  const onExportJson = useCallback(() => {
    try {
      const blob = new Blob([prettyJson(state)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ssa-household-meals-cuisine.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      emitEvent("household.cuisine.exported", { key: LS_KEY });
    } catch (e) {
      setStatus((s) => ({ ...s, error: e?.message || "Export failed." }));
    }
  }, [state]);

  const onImportJson = useCallback(async (file) => {
    try {
      if (!file) return;
      const text = await file.text();
      const parsed = safeJsonParse(text, null);
      if (!parsed || typeof parsed !== "object") {
        setStatus((s) => ({ ...s, error: "Invalid JSON file." }));
        return;
      }
      const merged = deepMerge(defaultCuisineState(), parsed);
      merged.meta = {
        ...(merged.meta || {}),
        source: "import",
        updatedAtISO: nowISO(),
      };
      setState(merged);
      setStatus((s) => ({ ...s, dirty: true, error: "" }));
      emitEvent("household.cuisine.imported", { key: LS_KEY, name: file.name });
    } catch (e) {
      setStatus((s) => ({ ...s, error: e?.message || "Import failed." }));
    }
  }, []);

  const onCreateCustomStream = useCallback(() => {
    const id = `custom-${Math.random().toString(16).slice(2)}-${Date.now()}`;
    updateState((prev) => ({
      customCuisineStreams: [
        ...(prev.customCuisineStreams || []),
        { id, name: "Custom Cuisine Stream", desc: "", tags: ["custom"] },
      ],
    }));
  }, [updateState]);

  /* -----------------------------------------------------------------------------
   * Rendering helpers
   * -------------------------------------------------------------------------- */
  const headerStatus = useMemo(() => {
    if (!status.hydrated) return "Loading…";
    if (status.error) return `Error: ${status.error}`;
    if (status.saving) return "Saving…";
    if (status.dirty) return "Unsaved changes…";
    if (status.lastSavedAtISO)
      return `Saved ${new Date(status.lastSavedAtISO).toLocaleString()}`;
    return "Ready";
  }, [status]);

  /* -----------------------------------------------------------------------------
   * UI
   * -------------------------------------------------------------------------- */
  return (
    <div className="page household-meals-cuisine" style={{ padding: 16 }}>
      {/* Header */}
      <div
        className="card"
        style={{
          padding: 16,
          borderRadius: 12,
          border: "1px solid rgba(0,0,0,0.08)",
          marginBottom: 12,
          boxShadow: "0 1px 6px rgba(0,0,0,0.06)",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "baseline",
            flexWrap: "wrap",
          }}
        >
          <h1 style={{ margin: 0, fontSize: 22 }}>
            Household Meal Cuisine Settings
          </h1>
          <div style={{ opacity: 0.75, fontSize: 12 }}>{headerStatus}</div>
        </div>

        <p
          style={{
            marginTop: 10,
            marginBottom: 0,
            opacity: 0.85,
            lineHeight: 1.35,
          }}
        >
          Configure your household’s cuisine streams, allowed foods, spice
          logic, techniques, and preservation alignment. Meal planning, batch
          sessions, storehouse projections, and feast-day menus should read from
          this profile.
        </p>

        <div
          style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}
        >
          <button className="btn" onClick={onResetDefaults} type="button">
            Reset to Defaults
          </button>
          <button className="btn" onClick={onExportJson} type="button">
            Export JSON
          </button>
          <label className="btn" style={{ cursor: "pointer" }}>
            Import JSON
            <input
              type="file"
              accept="application/json"
              style={{ display: "none" }}
              onChange={(e) => onImportJson(e.target.files?.[0])}
            />
          </label>
        </div>
      </div>

      {/* Main grid */}
      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          alignItems: "start",
        }}
      >
        {/* Cuisine Presets */}
        <Section
          title="Cuisine Streams"
          subtitle="Enable one or more base streams, plus custom streams for your household."
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {CUISINE_PRESETS.map((p) => {
              const enabled = (state.enabledCuisinePresetIds || []).includes(
                p.id
              );
              return (
                <div
                  key={p.id}
                  style={{
                    padding: 12,
                    borderRadius: 12,
                    border: "1px solid rgba(0,0,0,0.10)",
                    background: enabled ? "rgba(0,0,0,0.03)" : "transparent",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700 }}>{p.name}</div>
                      <div style={{ opacity: 0.8, fontSize: 13, marginTop: 4 }}>
                        {p.desc}
                      </div>
                      <div
                        style={{
                          marginTop: 8,
                          display: "flex",
                          gap: 6,
                          flexWrap: "wrap",
                        }}
                      >
                        {(p.tags || []).map((t) => (
                          <span
                            key={t}
                            style={{
                              fontSize: 12,
                              opacity: 0.85,
                              border: "1px solid rgba(0,0,0,0.12)",
                              padding: "2px 8px",
                              borderRadius: 999,
                            }}
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <button
                        className="btn"
                        type="button"
                        onClick={() =>
                          updateState((prev) => ({
                            enabledCuisinePresetIds: toggleInArray(
                              prev.enabledCuisinePresetIds || [],
                              p.id
                            ),
                          }))
                        }
                      >
                        {enabled ? "Enabled" : "Enable"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div
            style={{
              marginTop: 12,
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <div style={{ opacity: 0.8, fontSize: 13 }}>
              Custom streams let you define household-specific sub-cuisines
              (e.g., “Goat Suya Sundays”).
            </div>
            <button
              className="btn"
              type="button"
              onClick={onCreateCustomStream}
            >
              Add Custom Stream
            </button>
          </div>

          <div
            style={{
              marginTop: 10,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {(state.customCuisineStreams || []).map((s, idx) => (
              <div
                key={s.id || idx}
                style={{
                  padding: 12,
                  borderRadius: 12,
                  border: "1px solid rgba(0,0,0,0.10)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <Field label="Stream Name">
                      <input
                        className="input"
                        value={s.name || ""}
                        onChange={(e) =>
                          updateState((prev) => ({
                            customCuisineStreams: (
                              prev.customCuisineStreams || []
                            ).map((x) =>
                              x.id === s.id ? { ...x, name: e.target.value } : x
                            ),
                          }))
                        }
                      />
                    </Field>

                    <Field label="Description">
                      <textarea
                        className="input"
                        rows={2}
                        value={s.desc || ""}
                        onChange={(e) =>
                          updateState((prev) => ({
                            customCuisineStreams: (
                              prev.customCuisineStreams || []
                            ).map((x) =>
                              x.id === s.id ? { ...x, desc: e.target.value } : x
                            ),
                          }))
                        }
                      />
                    </Field>

                    <Field label="Tags (comma-separated)">
                      <input
                        className="input"
                        value={(s.tags || []).join(", ")}
                        onChange={(e) =>
                          updateState((prev) => ({
                            customCuisineStreams: (
                              prev.customCuisineStreams || []
                            ).map((x) => {
                              if (x.id !== s.id) return x;
                              const tags = e.target.value
                                .split(",")
                                .map((t) => t.trim())
                                .filter(Boolean);
                              return { ...x, tags: uniq(tags) };
                            }),
                          }))
                        }
                      />
                    </Field>
                  </div>

                  <div>
                    <button
                      className="btn"
                      type="button"
                      onClick={() =>
                        updateState((prev) => ({
                          customCuisineStreams: (
                            prev.customCuisineStreams || []
                          ).filter((x) => x.id !== s.id),
                        }))
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* Allowed foods */}
        <Section
          title="Allowed Foods"
          subtitle="Define allowed meats and preferred fats. Your meal engine should filter suggestions accordingly."
        >
          <Field label="Allowed Meats">
            <MultiToggle
              options={MEAT_OPTIONS}
              value={state.allowedMeats || []}
              onChange={(next) => updateState({ allowedMeats: next })}
            />
          </Field>

          <Field label="Excluded Meats (optional override)">
            <MultiToggle
              options={MEAT_OPTIONS}
              value={state.excludedMeats || []}
              onChange={(next) => updateState({ excludedMeats: next })}
            />
          </Field>

          <Field label="Preferred Fats">
            <MultiToggle
              options={FAT_OPTIONS}
              value={state.preferredFats || []}
              onChange={(next) => updateState({ preferredFats: next })}
            />
          </Field>

          <Divider />

          <Field label="Bread & Grains Rotation">
            <div style={{ display: "grid", gap: 8 }}>
              <ToggleRow
                label="Flatbreads"
                checked={!!state.breadAndGrains?.includeFlatbreads}
                onChange={(v) =>
                  updateState({
                    breadAndGrains: {
                      ...state.breadAndGrains,
                      includeFlatbreads: v,
                    },
                  })
                }
              />
              <ToggleRow
                label="Cornbreads"
                checked={!!state.breadAndGrains?.includeCornbreads}
                onChange={(v) =>
                  updateState({
                    breadAndGrains: {
                      ...state.breadAndGrains,
                      includeCornbreads: v,
                    },
                  })
                }
              />
              <ToggleRow
                label="Rice"
                checked={!!state.breadAndGrains?.includeRice}
                onChange={(v) =>
                  updateState({
                    breadAndGrains: { ...state.breadAndGrains, includeRice: v },
                  })
                }
              />
              <ToggleRow
                label="Wheat breads"
                checked={!!state.breadAndGrains?.includeWheatBreads}
                onChange={(v) =>
                  updateState({
                    breadAndGrains: {
                      ...state.breadAndGrains,
                      includeWheatBreads: v,
                    },
                  })
                }
              />
              <ToggleRow
                label="Gluten-free rotation"
                checked={!!state.breadAndGrains?.includeGlutenFreeRotation}
                onChange={(v) =>
                  updateState({
                    breadAndGrains: {
                      ...state.breadAndGrains,
                      includeGlutenFreeRotation: v,
                    },
                  })
                }
              />
            </div>
          </Field>

          <Divider />

          <Field label="Veggies & Sides Priorities">
            <div style={{ display: "grid", gap: 8 }}>
              <ToggleRow
                label="Leafy greens"
                checked={!!state.veggiesAndSides?.prioritizeLeafyGreens}
                onChange={(v) =>
                  updateState({
                    veggiesAndSides: {
                      ...state.veggiesAndSides,
                      prioritizeLeafyGreens: v,
                    },
                  })
                }
              />
              <ToggleRow
                label="Cabbage family"
                checked={!!state.veggiesAndSides?.prioritizeCabbage}
                onChange={(v) =>
                  updateState({
                    veggiesAndSides: {
                      ...state.veggiesAndSides,
                      prioritizeCabbage: v,
                    },
                  })
                }
              />
              <ToggleRow
                label="Beans/legumes"
                checked={!!state.veggiesAndSides?.prioritizeBeans}
                onChange={(v) =>
                  updateState({
                    veggiesAndSides: {
                      ...state.veggiesAndSides,
                      prioritizeBeans: v,
                    },
                  })
                }
              />
              <ToggleRow
                label="Roots/tubers"
                checked={!!state.veggiesAndSides?.prioritizeRoots}
                onChange={(v) =>
                  updateState({
                    veggiesAndSides: {
                      ...state.veggiesAndSides,
                      prioritizeRoots: v,
                    },
                  })
                }
              />
            </div>
          </Field>
        </Section>

        {/* Techniques */}
        <Section
          title="Techniques"
          subtitle="Choose techniques you favor vs avoid. This steers meal selection and planning."
        >
          <Field label="Favorite Techniques">
            <MultiToggle
              options={TECHNIQUE_OPTIONS}
              value={state.techniquePreferences?.favorite || []}
              onChange={(next) =>
                updateState({
                  techniquePreferences: {
                    ...(state.techniquePreferences || {}),
                    favorite: next,
                  },
                })
              }
            />
          </Field>

          <Field label="Avoid Techniques">
            <MultiToggle
              options={TECHNIQUE_OPTIONS}
              value={state.techniquePreferences?.avoid || []}
              onChange={(next) =>
                updateState({
                  techniquePreferences: {
                    ...(state.techniquePreferences || {}),
                    avoid: next,
                  },
                })
              }
            />
          </Field>

          <Divider />

          <Field label="Preservation Alignment">
            <div style={{ display: "grid", gap: 8 }}>
              <ToggleRow
                label="Curing"
                checked={!!state.preservationAlignment?.curingEnabled}
                onChange={(v) =>
                  updateState({
                    preservationAlignment: {
                      ...state.preservationAlignment,
                      curingEnabled: v,
                    },
                  })
                }
              />
              <ToggleRow
                label="Smoking"
                checked={!!state.preservationAlignment?.smokingEnabled}
                onChange={(v) =>
                  updateState({
                    preservationAlignment: {
                      ...state.preservationAlignment,
                      smokingEnabled: v,
                    },
                  })
                }
              />
              <ToggleRow
                label="Fermentation"
                checked={!!state.preservationAlignment?.fermentationEnabled}
                onChange={(v) =>
                  updateState({
                    preservationAlignment: {
                      ...state.preservationAlignment,
                      fermentationEnabled: v,
                    },
                  })
                }
              />
              <ToggleRow
                label="Dehydration"
                checked={!!state.preservationAlignment?.dehydrationEnabled}
                onChange={(v) =>
                  updateState({
                    preservationAlignment: {
                      ...state.preservationAlignment,
                      dehydrationEnabled: v,
                    },
                  })
                }
              />
              <ToggleRow
                label="Pressure canning"
                checked={!!state.preservationAlignment?.pressureCanningEnabled}
                onChange={(v) =>
                  updateState({
                    preservationAlignment: {
                      ...state.preservationAlignment,
                      pressureCanningEnabled: v,
                    },
                  })
                }
              />
              <ToggleRow
                label="Freezer support"
                checked={!!state.preservationAlignment?.freezerEnabled}
                onChange={(v) =>
                  updateState({
                    preservationAlignment: {
                      ...state.preservationAlignment,
                      freezerEnabled: v,
                    },
                  })
                }
              />
            </div>
          </Field>
        </Section>

        {/* Spices */}
        <Section
          title="Spice & Flavor Matrix"
          subtitle="Select spice families and household intensity levels. This steers sauces, sides, and recipe variants."
        >
          <Field label="Spice Families">
            <div style={{ display: "grid", gap: 8 }}>
              {SPICE_FAMILIES.map((f) => {
                const on = (state.spicePreferences?.familiesOn || []).includes(
                  f.id
                );
                return (
                  <div
                    key={f.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: 10,
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.10)",
                      background: on ? "rgba(0,0,0,0.03)" : "transparent",
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700 }}>{f.name}</div>
                      <div style={{ opacity: 0.8, fontSize: 13, marginTop: 4 }}>
                        {f.examples}
                      </div>
                    </div>
                    <div>
                      <button
                        className="btn"
                        type="button"
                        onClick={() =>
                          updateState((prev) => ({
                            spicePreferences: {
                              ...(prev.spicePreferences || {}),
                              familiesOn: toggleInArray(
                                prev.spicePreferences?.familiesOn || [],
                                f.id
                              ),
                            },
                          }))
                        }
                      >
                        {on ? "On" : "Off"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Field>

          <Divider />

          <Field
            label={`Heat Level: ${clamp(
              state.spicePreferences?.heatLevel ?? 3,
              0,
              5
            )} / 5`}
          >
            <input
              type="range"
              min="0"
              max="5"
              step="1"
              value={clamp(state.spicePreferences?.heatLevel ?? 3, 0, 5)}
              onChange={(e) =>
                updateState({
                  spicePreferences: {
                    ...(state.spicePreferences || {}),
                    heatLevel: clamp(parseInt(e.target.value, 10), 0, 5),
                  },
                })
              }
              style={{ width: "100%" }}
            />
          </Field>

          <Field
            label={`Salt Level: ${clamp(
              state.spicePreferences?.saltLevel ?? 3,
              0,
              5
            )} / 5`}
          >
            <input
              type="range"
              min="0"
              max="5"
              step="1"
              value={clamp(state.spicePreferences?.saltLevel ?? 3, 0, 5)}
              onChange={(e) =>
                updateState({
                  spicePreferences: {
                    ...(state.spicePreferences || {}),
                    saltLevel: clamp(parseInt(e.target.value, 10), 0, 5),
                  },
                })
              }
              style={{ width: "100%" }}
            />
          </Field>

          <Field
            label={`Sweet Level: ${clamp(
              state.spicePreferences?.sweetLevel ?? 2,
              0,
              5
            )} / 5`}
          >
            <input
              type="range"
              min="0"
              max="5"
              step="1"
              value={clamp(state.spicePreferences?.sweetLevel ?? 2, 0, 5)}
              onChange={(e) =>
                updateState({
                  spicePreferences: {
                    ...(state.spicePreferences || {}),
                    sweetLevel: clamp(parseInt(e.target.value, 10), 0, 5),
                  },
                })
              }
              style={{ width: "100%" }}
            />
          </Field>
        </Section>

        {/* Feast day / notes */}
        <Section
          title="Feast-Day & Notes"
          subtitle="Optional integration hooks for calendar/feast logic and household notes."
        >
          <Field label="Enable Feast-Day Meal Logic Hook">
            <ToggleRow
              label="Enable"
              checked={!!state.feastDayLogic?.enabled}
              onChange={(v) =>
                updateState({
                  feastDayLogic: { ...state.feastDayLogic, enabled: v },
                })
              }
            />
          </Field>

          <Field label="Feast-Day Notes (planner hint)">
            <textarea
              className="input"
              rows={4}
              value={state.feastDayLogic?.notes || ""}
              onChange={(e) =>
                updateState({
                  feastDayLogic: {
                    ...(state.feastDayLogic || {}),
                    notes: e.target.value,
                  },
                })
              }
            />
          </Field>

          <Divider />

          <Field label="Household Notes">
            <textarea
              className="input"
              rows={6}
              value={state.notes || ""}
              onChange={(e) => updateState({ notes: e.target.value })}
              placeholder="Example: ‘Goat is primary. Prefer stews and smoked meats. Sunday dinners are celebratory. Avoid overly sweet profiles.’"
            />
          </Field>

          <Divider />

          <details style={{ marginTop: 6 }}>
            <summary style={{ cursor: "pointer", opacity: 0.9 }}>
              Advanced: View raw JSON (read-only)
            </summary>
            <pre
              style={{
                marginTop: 10,
                padding: 12,
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.10)",
                overflowX: "auto",
                background: "rgba(0,0,0,0.03)",
                fontSize: 12,
              }}
            >
              {prettyJson(state)}
            </pre>
          </details>
        </Section>

        {/* Summary card */}
        <Section
          title="Household Cuisine Summary"
          subtitle="This is what your planners/engines should consume. Keep engines reading from the same contract."
        >
          <div style={{ display: "grid", gap: 10 }}>
            <SummaryRow
              label="Enabled base streams"
              value={
                computedEnabledPresets.base.map((x) => x.name).join(" • ") ||
                "None"
              }
            />
            <SummaryRow
              label="Custom streams"
              value={
                computedEnabledPresets.custom.map((x) => x.name).join(" • ") ||
                "None"
              }
            />
            <SummaryRow
              label="Allowed meats"
              value={(state.allowedMeats || []).join(" • ") || "None"}
            />
            <SummaryRow
              label="Excluded meats"
              value={(state.excludedMeats || []).join(" • ") || "None"}
            />
            <SummaryRow
              label="Preferred fats"
              value={(state.preferredFats || []).join(" • ") || "None"}
            />
            <SummaryRow
              label="Favorite techniques"
              value={
                (state.techniquePreferences?.favorite || []).join(" • ") ||
                "None"
              }
            />
            <SummaryRow
              label="Avoid techniques"
              value={
                (state.techniquePreferences?.avoid || []).join(" • ") || "None"
              }
            />
            <SummaryRow
              label="Spice families on"
              value={
                (state.spicePreferences?.familiesOn || []).join(" • ") || "None"
              }
            />
            <SummaryRow
              label="Intensity"
              value={`Heat ${clamp(
                state.spicePreferences?.heatLevel ?? 3,
                0,
                5
              )}/5 • Salt ${clamp(
                state.spicePreferences?.saltLevel ?? 3,
                0,
                5
              )}/5 • Sweet ${clamp(
                state.spicePreferences?.sweetLevel ?? 2,
                0,
                5
              )}/5`}
            />
          </div>

          <Divider />

          <div style={{ opacity: 0.85, fontSize: 13, lineHeight: 1.35 }}>
            <strong>Next step (wiring):</strong> your meal planning engine
            should read
            <code style={{ padding: "0 6px" }}>
              ssa.household.mealsCuisine.v1
            </code>{" "}
            (or replace with a store), then apply:
            <ul style={{ marginTop: 8, marginBottom: 0 }}>
              <li>Filter proteins by allowed/excluded meats</li>
              <li>
                Bias recipe selection by enabled cuisine streams & technique
                favorites
              </li>
              <li>
                Pick sauces/sides based on spice families + intensity sliders
              </li>
              <li>
                Align batch/preservation sessions based on preservation toggles
              </li>
            </ul>
          </div>
        </Section>
      </div>
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Internal components
 * -------------------------------------------------------------------------- */

function Section({ title, subtitle, children }) {
  return (
    <div
      className="card"
      style={{
        padding: 16,
        borderRadius: 12,
        border: "1px solid rgba(0,0,0,0.08)",
        boxShadow: "0 1px 6px rgba(0,0,0,0.06)",
      }}
    >
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 16 }}>{title}</div>
        {subtitle ? (
          <div style={{ opacity: 0.8, fontSize: 13, marginTop: 4 }}>
            {subtitle}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div
        style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, opacity: 0.9 }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function Divider() {
  return (
    <div
      style={{ height: 1, background: "rgba(0,0,0,0.08)", margin: "14px 0" }}
    />
  );
}

function ToggleRow({ label, checked, onChange }) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <span style={{ opacity: 0.9 }}>{label}</span>
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange?.(!!e.target.checked)}
        style={{ transform: "scale(1.1)" }}
      />
    </label>
  );
}

function MultiToggle({ options, value, onChange }) {
  const selected = Array.isArray(value) ? value : [];

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {options.map((opt) => {
        const on = selected.includes(opt);
        return (
          <button
            key={opt}
            type="button"
            className="btn"
            onClick={() => {
              const next = on
                ? selected.filter((x) => x !== opt)
                : [...selected, opt];
              onChange?.(next);
            }}
            style={{
              borderRadius: 999,
              padding: "8px 12px",
              opacity: on ? 1 : 0.85,
              border: on
                ? "1px solid rgba(0,0,0,0.35)"
                : "1px solid rgba(0,0,0,0.15)",
              background: on ? "rgba(0,0,0,0.05)" : "transparent",
            }}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

function SummaryRow({ label, value }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "160px 1fr",
        gap: 10,
        alignItems: "start",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 800, opacity: 0.85 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, opacity: 0.9, lineHeight: 1.35 }}>
        {value}
      </div>
    </div>
  );
}
