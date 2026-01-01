// src/store/MealPrefsStore.d.ts
import type {
  MealPlanPrefs as BaseMealPlanPrefs,
  DietaryPrefs,          // comes from your ../types/mealplan.d.ts
} from "../types/mealplan";

/** Internal helper types (not exported) */
declare type ISODate = string;
declare type MealRhythmPreset = "custom" | "16:8" | "18:6" | "omad" | "36h" | "adf" | (string & {});
declare type SlotType = "meal" | "fast" | "snack";
declare type DietTag =
  | "unrestricted"
  | "keto"
  | "lowcarb"
  | "paleo"
  | "mediterranean"
  | "refeed"
  | "fasting"
  | (string & {});

declare interface RhythmSlot {
  slotId: string;
  label: string;
  type: SlotType;
  start: string; // "hh:mm" 24h
  end: string;   // "hh:mm" 24h
}

declare interface AdfConfig {
  startIso: ISODate;
  fastEveryOtherDay: boolean;
}

declare interface RhythmOverride {
  slots?: RhythmSlot[];
  dietTag?: DietTag;
}

/** 0=Sun..6=Sat, with default fallback */
declare type DietByDow = Partial<Record<0 | 1 | 2 | 3 | 4 | 5 | 6, DietTag>> & { default?: DietTag };

declare interface MacroTargets {
  calories?: number;
  proteinPercent?: number;
  carbsPercent?: number;
  fatPercent?: number;
  proteinPerKg?: number;
  netCarbsLimit?: number;
  fiberTarget?: number;
}

declare interface SizingPrefs {
  defaultServings?: number;
  scaleToHousehold?: boolean;
  roundServings?: boolean;
}

declare interface BatchCookingPrefs {
  enabled: boolean;
  daysOfWeek?: Array<0 | 1 | 2 | 3 | 4 | 5 | 6>;
  defaultStart?: string;           // "14:00"
  defaultDurationMins?: number;    // e.g., 120
  autoGeneratePrepLists?: boolean;
}

declare interface ShoppingPrefs {
  cadence: "weekly" | "biweekly" | "monthly" | "as_needed";
  budgetPerPeriod?: number;
  preferredStores?: string[];
  autoGroupByAisle?: boolean;
}

declare interface LeftoversPrefs {
  planLeftovers: boolean;
  keepDays?: number;
  assignToSlots?: boolean;
}

declare interface InventorySyncPrefs {
  autoDecrementOnPlan?: boolean;
  decrementOnCook?: boolean;
  reserveOnPlan?: boolean;
}

declare interface ObservancePrefs {
  sabbathAware?: boolean;
  sabbathDayRule?: "hebrew_day7" | "saturday"; // default "hebrew_day7"
  sabbathPrepWindowHours?: number;
  feastDayBehavior?: "lock" | "swap" | "skip";
  showSunsetTimes?: boolean;
}

declare interface ReminderPrefs {
  enableReminders?: boolean;
  reminderTimes?: string[];  // ["09:00","17:00"]
  advanceMinutes?: number;
}

declare interface RhythmPrefs {
  preset: MealRhythmPreset;
  timezone: string;          // IANA TZ, e.g. "America/New_York"
  slots: RhythmSlot[];
  dietByDow: DietByDow;
  adf?: AdfConfig | null;
  overrides?: Record<ISODate, RhythmOverride>;
}

/* ──────────────────────────────────────────────────────────────
   Module augmentation: merge extra fields into MealPlanPrefs.
   NOTE: do NOT extend; interface merging avoids recursive base.
   ────────────────────────────────────────────────────────────── */
declare module "../types/mealplan" {
  interface MealPlanPrefs {
    /** Rhythm-driven planner defaults */
    rhythm: RhythmPrefs;

    /** Nutrition & scaling */
    macros?: MacroTargets;
    sizing?: SizingPrefs;

    /** Workflows */
    batchCooking?: BatchCookingPrefs;
    shopping?: ShoppingPrefs;
    leftovers?: LeftoversPrefs;
    inventorySync?: InventorySyncPrefs;

    /** Keep the same shape/name as your base */
    dietary?: DietaryPrefs;

    /** Sabbath/feast-day awareness */
    observance?: ObservancePrefs;

    /** Reminders */
    reminders?: ReminderPrefs;

    /** Generator defaults */
    defaultGenerateDays?: number; // e.g., 28

    /** Feature flags */
    features?: {
      aiSuggestions?: boolean;
      allowSwapWithJustification?: boolean;
      enableCostEstimates?: boolean;
    };
  }
}

/** Public runtime API (same shape you already use) */
interface MealPrefsStoreApi {
  get(): Promise<BaseMealPlanPrefs>;
  set(next: Partial<BaseMealPlanPrefs>): Promise<void>;
  onChange(listener: (prefs: BaseMealPlanPrefs) => void): () => void;
}

/** Matches CommonJS shape: module.exports = store */
declare const store: MealPrefsStoreApi;
export = store;
