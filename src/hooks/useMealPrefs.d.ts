// src/hooks/useMealPrefs.d.ts
import type { MealPlanPrefs } from "../types/mealplan";

/**
 * Source of the current preferences snapshot.
 * - "local"     → device/localStorage
 * - "server"    → fetched from backend profile
 * - "profile"   → logged-in user profile defaults
 * - "inferred"  → derived from behavior (recipes used, pantry, macros)
 * - "imported"  → uploaded file or cookbook import
 */
export type MealPrefsSource = "local" | "server" | "profile" | "inferred" | "imported";

/** Status/meta about the prefs state, used for banners/toasts/guards. */
export interface MealPrefsStatus {
  /** true while loading from disk/network/agents */
  loading: boolean;
  /** any last error encountered */
  error?: unknown;
  /** has at least one successful load completed? */
  hydrated?: boolean;
  /** unsaved local changes present? */
  dirty?: boolean;
  /** last successful persistence to storage/profile */
  persisted?: boolean;
  /** semantic schema version of MealPlanPrefs used in the app */
  version?: number;
  /** ISO timestamp of last mutation (for audit/undo UI) */
  lastUpdated?: string;
  /** where the current snapshot came from */
  source?: MealPrefsSource;
}

/** Selector helpers to keep UI components simple & fast. */
export interface MealPrefsSelectors {
  /** pick a subset of fields for memoized components */
  pick?<K extends keyof MealPlanPrefs>(keys: readonly K[]): Pick<MealPlanPrefs, K>;
  /** get a single field by key */
  get?<K extends keyof MealPlanPrefs>(key: K): MealPlanPrefs[K];
  /**
   * Build a query/hash payload for agents (meal planner, batch cooker, calendar sync).
   * Example: { season:"spring", kcal:1800, proteinG:140, exclude:["pork"], ... }
   */
  toQuery?(): Record<string, string | number | boolean | string[] | number[]>;
}

/** Mutation helpers tailored to Suka’s agent-driven flows. */
export interface MealPrefsActions {
  /**
   * Primary setter (required).
   * Accepts a partial patch or a functional updater (prev → patch).
   * Automatically flips `dirty` and refreshes `lastUpdated`.
   */
  setPrefs: (
    next: Partial<MealPlanPrefs> | ((prev: MealPlanPrefs) => Partial<MealPlanPrefs>)
  ) => void;

  /** Merge without replacing arrays (agent-friendly tolerant merge). */
  merge?(next: Partial<MealPlanPrefs>): void;

  /**
   * Reset preferences:
   * - "soft": keep identity/macros, clear transient filters
   * - "hard": revert to profile defaults
   * - "factory": revert to app factory defaults
   */
  reset?(kind?: "soft" | "hard" | "factory"): void;

  /** Load profile- or zone-based defaults (e.g., USDA zone, season presets). */
  loadDefaults?(profileKey?: string): void;

  /** Immediately persist to storage/profile; resolves when done. */
  persistNow?(): Promise<void>;

  /**
   * Subscribe to changes (for non-React consumers/agents).
   * Returns an unsubscribe function.
   */
  subscribe?(listener: (prefs: MealPlanPrefs) => void): () => void;

  /**
   * Apply a named template (e.g., "HairGrowthKeto", "Zone7bSpringCore",
   * "KosherPassoverWeek", "BatchCookingHighProtein").
   */
  applyTemplate?(templateId: string, overrides?: Partial<MealPlanPrefs>): void;

  /** Validate prefs; returns `{ ok, issues }` for guardrails and UX hints. */
  validate?(): { ok: boolean; issues: Array<{ path: string; message: string }> };
}

/**
 * React hook returning meal-planner preferences plus helpers.
 * Implementation lives in useMealPrefs.js.
 *
 * Notes for implementers (Suka ecosystem):
 * - Should integrate with Inventory/Recipe stores (auto-linking),
 *   macros calculator, calendar seasons & feast-day rules,
 *   and agent orchestrators (mealPlanning / batchCooking / grocery).
 * - Persist to localStorage and sync to profile when available.
 */
export interface UseMealPrefsReturn
  extends MealPrefsStatus,
    MealPrefsSelectors,
    MealPrefsActions {
  /** Current meal planning preferences snapshot (authoritative). */
  prefs: MealPlanPrefs;
}

/** Backward-compatible export: existing fields remain valid; helpers are optional. */
export function useMealPrefs(): UseMealPrefsReturn;
