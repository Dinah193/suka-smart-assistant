// src/ai/context/buildContext.ts
/* A defensive context aggregator that does NOT rely on @ path aliases.
   It pulls the user's global "vision" options (Home page) from:
   1) a global bridge (window.__SUKA_VISION_OPTIONS), or
   2) localStorage ("suka.vision.options"), or
   3) falls back to {}.
   It also tries to read domain data from Dexie tables if present. */

type AnyDexie = any;

// IMPORTANT: relative import (no @ alias)
import DexieDBRaw from "../../db"; // adjust if your db entry is in a different path

// If your Dexie export is JS-only without types, keep it loose:
const DexieDB: AnyDexie = DexieDBRaw as AnyDexie;

export type HouseholdContext = {
  profile: string[];
  goals: string[];
  constraints: string[];
  dietary: string[];
  weeklyHrs?: any;   // could be string | {kind:"custom", value:string}
  budget?: any;      // same shape as weeklyHrs
  unitSystem: "Standard (US)" | "Metric";

  // Optional domain data (best-effort)
  mealPlan?: any[];
  jobs?: any[];
  community?: any[];
  badges?: any[];
  inventory?: any[];
  cooking?: any[];
  cleaning?: any[];
  garden?: any[];
  animals?: any[];
};

/** Try to read the vision options without importing React context.
 *  Expected shape is what your Home page saves in VisionContext.
 */
function readVisionOptions(): Record<string, any> {
  // 1) bridge set by app (you can set this once when VisionProvider mounts)
  if (typeof window !== "undefined") {
    const bridged = (window as any).__SUKA_VISION_OPTIONS;
    if (bridged && typeof bridged === "object") return bridged;
  }
  // 2) localStorage fallback
  try {
    const raw =
      (typeof localStorage !== "undefined" && localStorage.getItem("suka.vision.options")) ||
      (typeof localStorage !== "undefined" && localStorage.getItem("vision.options"));
    if (raw) return JSON.parse(raw);
  } catch {}
  // 3) default
  return {};
}

/** Read unit system from localStorage or default to Standard (US) */
function readUnitSystem(): "Standard (US)" | "Metric" {
  try {
    const u =
      (typeof localStorage !== "undefined" && localStorage.getItem("suka.units")) ||
      (typeof localStorage !== "undefined" && localStorage.getItem("unitSystem"));
    if (u && /metric/i.test(u)) return "Metric";
  } catch {}
  return "Standard (US)";
}

/** Safe toArray on a Dexie table; returns [] if table missing */
async function toArraySafe(table: any): Promise<any[]> {
  try {
    if (table && typeof table.toArray === "function") {
      const res = await table.toArray();
      return Array.isArray(res) ? res : [];
    }
  } catch {}
  return [];
}

/** Build a single context object used by AI templates/agents. */
export async function buildHouseholdContext(): Promise<HouseholdContext> {
  const o = readVisionOptions();
  const arr = (v: any) => (Array.isArray(v) ? v : []);

  // Domain tables are optional; these calls are all best-effort
  const mealPlan  = await toArraySafe(DexieDB?.mealPlans);
  const jobs      = await toArraySafe(DexieDB?.jobs);
  const badges    = await toArraySafe(DexieDB?.badges);
  const community = await toArraySafe(DexieDB?.community);
  const inventory = await toArraySafe(DexieDB?.inventory);
  const cooking   = await toArraySafe(DexieDB?.recipes);
  const cleaning  = await toArraySafe(DexieDB?.cleaningTasks);
  const garden    = await toArraySafe(DexieDB?.garden);
  const animals   = await toArraySafe(DexieDB?.animals);

  const ctx: HouseholdContext = {
    profile: arr(o.mode),
    goals: arr(o.goals),
    constraints: arr(o.constraints),
    dietary: arr(o.dietary),
    weeklyHrs: o.weeklyHrs,
    budget: o.budget,
    unitSystem: readUnitSystem(),
    mealPlan, jobs, community, badges, inventory, cooking, cleaning, garden, animals,
  };

  return ctx;
}

/** Optional: let React set a bridge once so this module can read it without importing the context. */
export function setVisionOptionsBridge(opts: Record<string, any>) {
  if (typeof window !== "undefined") {
    (window as any).__SUKA_VISION_OPTIONS = opts || {};
    try {
      localStorage.setItem("suka.vision.options", JSON.stringify(opts || {}));
    } catch {}
  }
}
