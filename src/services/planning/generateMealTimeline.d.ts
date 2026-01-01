// C:\Users\larho\suka-smart-assistant\src\services\planning\generateMealTimeline.d.ts

import type { DateYMD, MealPlan, MealPlanPrefs } from "../../types/mealplan";

/**
 * Options for generating a dynamic, integrated meal timeline that plugs into:
 * - Inventory / Grocery delta
 * - Garden → Meals linkage (harvest-aware)
 * - Batch cooking sessions & prep checklists
 * - Nutrition targets & per-meal/day rollups
 * - Quiet windows (Sabbath/Feast) + calendar export hooks
 * - Timers & voice cues
 * - Labels for packaged meals (freezer/jars)
 */
export interface GenerateOptions {
  /** Prefer these prefs; merged over user/global defaults. */
  prefs?: Partial<MealPlanPrefs>;

  /** Start clock anchor (used for suggested cook/serve timestamps). */
  startTime?: Date | string;

  /** Deterministic generation for testing. */
  seed?: number;

  /** Garden integration: align meals to expected harvests. */
  integrateGarden?: boolean;

  /** Inventory integration: compute grocery deltas vs on-hand. */
  integrateInventory?: boolean;

  /** Batch cooking controls. */
  batchCooking?: {
    enabled?: boolean;
    /** E.g., cook once to cover this many days. Default 2. */
    daysPerBatch?: number;
    /** Cap recipes per batch session. Default 6. */
    maxRecipesPerBatch?: number;
    /** Try to group by shared ingredients for efficiency. */
    consolidateByIngredients?: boolean;
  };

  /** Scheduling tempo for prep/cook windows. */
  pacing?: "aggressive" | "normal" | "leisurely";

  /** Respect quiet windows (Sabbath/Feasts); annotate or avoid as configured. */
  respectPrefs?: boolean;

  /** Calendar export hooks. */
  calendarHooks?: {
    /** If true, avoid placing cook windows during quiet windows. */
    blockQuietWindows?: boolean;
    /** Which provider the caller intends to export to. (Purely advisory in types.) */
    provider?: "local" | "google" | "microsoft";
    /** If true, generator returns event stubs for export. */
    exportEvents?: boolean;
  };

  /** Nutrition controls. */
  nutrition?: {
    /** Daily macro targets used to steer meal selection/portion scaling. */
    targetMacros?: MacroTargets;
    /** Also compute per-meal macros (heavier but useful for UI cards). */
    computePerMeal?: boolean;
  };

  /** Label/packaging stubs for frozen/jarred meals. */
  labels?: {
    generate?: boolean;
    defaultShelfLife?: string; // e.g., "3 months frozen"
  };

  /** Timers / voice cues for cook windows. */
  timers?: {
    generate?: boolean;
    voiceAlerts?: boolean;
  };
}

/** Simple macro target shape used for steering meal generation. */
export interface MacroTargets {
  calories?: number;
  protein?: number; // grams
  fat?: number;     // grams
  carbs?: number;   // grams
  fiber?: number;   // grams
  sugar?: number;   // grams
}

/** A single scheduled item (prep or cook) tied to a meal. */
export interface MealTimelineEvent {
  id: string;
  dayIndex: number;            // 0..days-1
  slot: "breakfast" | "lunch" | "dinner" | "snack" | string;
  /** ISO string; consumers may re-anchor relative to startTime */
  start: string;
  /** Minutes duration */
  durationMin: number;
  type: "prep" | "cook" | "serve" | "leftovers" | "batch";
  title: string;
  recipeId?: string;
  recipeName?: string;
  notes?: string[];
  /** Soft constraints the generator considered (quiet windows, etc.) */
  constraints?: Array<{
    kind: "quiet-window" | "inventory" | "garden" | "macro";
    detail: string;
  }>;
}

/** A lightweight timer definition for MultiTimerPanel. */
export interface TimerDef {
  id: string;
  label: string;
  /** Minutes from the plan's startTime anchor. */
  startsAtMinute: number;
  durationMinutes: number;
  voiceCue?: string;
  forEventId?: string;
  forRecipeId?: string;
}

/** Label stub for Label Printer when meals are packaged. */
export interface LabelStub {
  id: string;
  recipeId?: string;
  name: string;
  producedOn: string;     // YYYY-MM-DD
  useBy?: string;         // YYYY-MM-DD
  shelfLife?: string;     // human-readable fallback
  servings?: number | null;
  allergens?: string[];
  dietTags?: string[];
  notes?: string;
}

/** Aggregated grocery + inventory deltas. */
export interface GroceryDelta {
  /** Items missing from inventory (needed > 0). */
  missing: Array<{ name: string; needed: number; unit?: string }>;
  /** Items to reserve (on hand but earmarked). */
  toReserve: Array<{ name: string; qty: number; unit?: string }>;
  /** Free-form notes (e.g., service warnings/fallbacks). */
  notes: string[];
}

/** Nutrition rollups for the UI. */
export interface NutritionBundle {
  totalsPerDay?: Array<{
    dayIndex: number;
    calories?: number;
    protein?: number;
    fat?: number;
    carbs?: number;
    fiber?: number;
    sugar?: number;
  }>;
  perMeal?: Array<{
    dayIndex: number;
    slot: string;
    recipeId?: string;
    recipeName?: string;
    calories?: number;
    protein?: number;
    fat?: number;
    carbs?: number;
    fiber?: number;
    sugar?: number;
  }>;
  notes?: string[];
}

/** Calendar export stubs (if requested). */
export interface CalendarEventStub {
  id: string;
  title: string;
  start: string;  // ISO
  end: string;    // ISO
  description?: string;
  location?: string;
  /** For downstream routing to provider calendars. */
  meta?: Record<string, any>;
}

/**
 * The enriched return type for generate(): a MealPlan plus everything
 * your UI needs to feel “intuitive & connected.”
 */
export interface MealTimeline {
  /** The classic meal plan structure (menus, assignments, etc.). */
  plan: MealPlan;

  /** Scheduled prep/cook/serve events aligned to the plan. */
  events: MealTimelineEvent[];

  /** Multi-timer & voice-cue definitions. */
  timers: TimerDef[];

  /** Labels for packaged meals (optional). */
  labels: LabelStub[];

  /** Grocery + inventory deltas derived from the plan. */
  inventory: GroceryDelta;

  /** Nutrition rollups matching prefs/targets. */
  nutrition: NutritionBundle;

  /** Optional calendar export items. */
  calendar?: {
    provider?: "local" | "google" | "microsoft";
    exportable?: boolean;
    events?: CalendarEventStub[];
  };

  /** Debug/UX hints & non-fatal warnings. */
  meta: {
    startTime: string; // ISO anchor used for offsets
    pacing: "aggressive" | "normal" | "leisurely";
    resources?: Record<string, number>; // if meal generator considers stations
    warnings: string[];
    version: string;
  };

  /** Convenience for Batch Session Planner integration. */
  batching?: {
    enabled: boolean;
    sessions: Array<{
      id: string;
      dayIndex: number;
      recipeIds: string[];
      /** Minutes-from-anchor suggested window. */
      startMinute: number;
      estimatedTotalMinutes: number;
      notes?: string[];
    }>;
  };
}

/**
 * Generate an enriched MealTimeline for [startDate, days] honoring (optional) prefs.
 * Use this signature to unlock all cross-module integrations.
 */
export declare function generate(
  startDate: DateYMD,
  days: number,
  options?: GenerateOptions
): Promise<MealTimeline>;

/**
 * @deprecated Legacy signature retained for backwards compatibility.
 * Prefer the overload with `GenerateOptions` which returns `MealTimeline`.
 */
export declare function generate(
  startDate: DateYMD,
  days: number,
  prefs?: Partial<MealPlanPrefs>
): Promise<MealPlan>;

/** Optional convenience type if you export an object with { generate }. */
export type MealTimelineApi = { generate: typeof generate };
