
// FILE: src/services/cuisine/CuisinePreferenceService.js
// Persists cuisine preferences (per household) using Dexie.
// Defensive: works even if db isn't available yet.

import { db } from "@/services/db";

const TABLE = "cuisine_user_prefs";

function nowIso() {
  try { return new Date().toISOString(); } catch { return String(Date.now()); }
}

function normArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

export const DEFAULT_PREFS = Object.freeze({
  householdId: "default",
  enabledCuisineKeys: ["aai"],
  spiceHeatLevel: "medium",
  dislikedIngredients: [],
  preferredProteins: ["beef", "lamb", "goat"],
  dietMode: "normal",
  allowExperimentalMeals: true,
  updatedAt: null,
});

export async function getCuisinePrefs({ householdId = "default" } = {}) {
  const hid = String(householdId || "default");
  try {
    const row = await db?.table?.(TABLE)?.where?.("householdId")?.equals?.(hid)?.first?.();
    if (!row) return { ...DEFAULT_PREFS, householdId: hid };
    return {
      ...DEFAULT_PREFS,
      ...row,
      householdId: hid,
      enabledCuisineKeys: normArray(row.enabledCuisineKeys),
      dislikedIngredients: normArray(row.dislikedIngredients),
      preferredProteins: normArray(row.preferredProteins),
    };
  } catch {
    // Fallback to localStorage if db isn't ready
    try {
      const raw = localStorage.getItem(`suka.cuisine.prefs.${hid}`);
      const obj = raw ? JSON.parse(raw) : null;
      return obj ? { ...DEFAULT_PREFS, ...obj, householdId: hid } : { ...DEFAULT_PREFS, householdId: hid };
    } catch {
      return { ...DEFAULT_PREFS, householdId: hid };
    }
  }
}

export async function upsertCuisinePrefs({ householdId = "default", patch = {} } = {}) {
  const hid = String(householdId || "default");
  const next = {
    ...(await getCuisinePrefs({ householdId: hid })),
    ...patch,
    householdId: hid,
    enabledCuisineKeys: normArray(patch.enabledCuisineKeys ?? patch.enabledCuisineKeys === "" ? patch.enabledCuisineKeys : undefined),
    dislikedIngredients: normArray(patch.dislikedIngredients),
    preferredProteins: normArray(patch.preferredProteins),
    updatedAt: nowIso(),
  };

  try {
    const t = db?.table?.(TABLE);
    if (!t) throw new Error("db table missing");
    const existing = await t.where("householdId").equals(hid).first();
    if (existing?.id) await t.update(existing.id, next);
    else await t.add(next);
  } catch {
    try { localStorage.setItem(`suka.cuisine.prefs.${hid}`, JSON.stringify(next)); } catch {}
  }
  return next;
}
