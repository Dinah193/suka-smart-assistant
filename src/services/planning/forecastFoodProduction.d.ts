import type { DateYMD, Unit } from '../../types/mealplan';

/** ISO8601 YYYY-MM-DD (from ../../types/mealplan) */
export type YMD = DateYMD;

/* ────────────────────────────────────────────────────────────────────────────
   Inputs
──────────────────────────────────────────────────────────────────────────── */

export interface CropForecastInput {
  /** USDA/region zone like "6a" (used with climateAdjust when available) */
  zone?: string;
  /** Inclusive start date of forecast window; defaults to “today” (local). */
  startDate?: YMD;
  /** Number of days forward to forecast (default 90). */
  days?: number;

  /**
   * Planned plantings. Minimal shape stays backward compatible.
   * Provide extra fields to get better estimates.
   */
  plantings?: Array<PlantingInputMinimal | PlantingInputDetailed>;
}

/** Minimal planting row (backward-compatible with existing callers). */
export interface PlantingInputMinimal {
  crop: string;
  variety?: string;
  /** Count of plants or units established (e.g., seedlings set or row-feet blocks). */
  count: number;
  /** Optional bed/plot identifier for routing/labels. */
  bed?: string;
}

/** Rich planting row enabling smarter forecasts. */
export interface PlantingInputDetailed extends PlantingInputMinimal {
  /** Optional unique planting id (helps correlate to inventory/labels). */
  id?: string;
  /** When seeds were sown (direct) or trays started. */
  sowDate?: YMD;
  /** When transplants were set out. */
  transplantDate?: YMD;
  /** First harvest date if known (overrides maturityDays calc). */
  firstHarvestDate?: YMD;
  /** Typical maturity in days for the variety in your zone. */
  maturityDays?: number;
  /**
   * Expected marketable yield per plant (or per “count” unit) per harvest cycle.
   * Example: 0.25 lb/plant/pick for tomatoes; or 1 head/plant for lettuce.
   */
  expectedYieldPerUnit?: number;
  /** Unit for expected yields; defaults to 'ct' if not provided. */
  yieldUnit?: Unit;
  /**
   * Number of pickings/harvests per plant across its productive window
   * (e.g., determinate tomato 3–5; leaf lettuce 2–3; single-cut lettuce 1).
   */
  expectedHarvestPasses?: number;
  /**
   * Optional harvest window length in days (e.g., 28 for lettuce cut-and-come).
   * If provided with expectedHarvestPasses, yields are spread across the window.
   */
  harvestWindowDays?: number;
  /**
   * Succession plan: create the same planting every `intervalDays` this many times.
   * Useful for weekly greens.
   */
  succession?: {
    times: number;
    intervalDays: number;
  };
  /** Free-form notes carried into forecast items. */
  notes?: string | null;
}

/* ────────────────────────────────────────────────────────────────────────────
   Options / Modes
──────────────────────────────────────────────────────────────────────────── */

export type AggregateBy = 'none' | 'day' | 'week' | 'month';

export interface ForecastOptions {
  /** Aggregation granularity for output; 'none' returns per-day entries (default 'day'). */
  aggregateBy?: AggregateBy;
  /** Smoothing window in days for continuous crops (tomato, cucumber, beans). */
  smoothDays?: number;
  /**
   * Apply climate/zone adjustments when variety metadata is present.
   * Implementation may use zone, average GDD, or local heuristics.
   */
  climateAdjust?: boolean;
  /** Include uncertainty bands if assumptions exist (e.g., 10–90 percentiles). */
  includeUncertainty?: boolean;
  /** If true, include cumulative totals in the response metadata. */
  includeCumulative?: boolean;
  /** If true, include byproducts (e.g., beet greens) when assumptions are known. */
  includeByproducts?: boolean;
  /**
   * Controls unit normalization (e.g., convert kg↔g, lb↔oz).
   * If omitted, returns units as provided per planting with light normalization.
   */
  normalizeUnits?: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
   Outputs
──────────────────────────────────────────────────────────────────────────── */

export interface CropForecastItem {
  /** Date bucket (YMD). If aggregateBy='week' or 'month', this is the bucket start. */
  date: YMD;
  crop: string;
  /** Forecast quantity for this date/bucket in the item’s unit. */
  qty: number;
  /** Unit for qty (e.g., 'ct', 'g', 'kg', 'oz', 'lb'). */
  unit?: Unit;
  /** Bed/plot reference when available. */
  bed?: string | null;
  /** Planting id if provided upstream. */
  plantingId?: string | null;
  /** Variety when available. */
  variety?: string | null;
  /** Optional uncertainty band for this item. */
  ci?: ForecastConfidence | null;
  /** Notes carried from planting row or heuristics. */
  notes?: string | null;
}

export interface ForecastConfidence {
  /** e.g., 0.1 for 10th percentile and 0.9 for 90th percentile. */
  p10?: number | null;
  p50?: number | null; // median
  p90?: number | null;
}

export interface ForecastTotals {
  /** Sum over the window in native units per crop. */
  byCrop: Array<{
    crop: string;
    unit: Unit;
    qty: number;
  }>;
  /** Sum over the window in native units per (crop, bed). */
  byCropBed: Array<{
    crop: string;
    bed: string | null;
    unit: Unit;
    qty: number;
  }>;
}

export interface ForecastMeta {
  /** Actual start/end used (may differ after aggregation). */
  window: { start: YMD; end: YMD; days: number };
  /** Options echo (after defaults applied). */
  options: Required<Pick<
    ForecastOptions,
    'aggregateBy' | 'smoothDays' | 'climateAdjust' | 'includeUncertainty' | 'includeCumulative' | 'includeByproducts' | 'normalizeUnits'
  >>;
  /** Number of input plantings (after expanding successions). */
  plantingsExpanded: number;
  /** Totals summary if requested. */
  totals?: ForecastTotals;
  /** Warnings or assumptions applied (e.g., “no maturityDays; used default”). */
  notices?: string[];
}

export interface ForecastOutput {
  /** Per-date (or per-aggregate-bucket) forecast rows. */
  items: CropForecastItem[];
  /** Optional metadata and totals. */
  meta: ForecastMeta;
}

/* ────────────────────────────────────────────────────────────────────────────
   API
──────────────────────────────────────────────────────────────────────────── */

/**
 * Simple forecast of yields per day from planned plantings.
 * BACKWARD-COMPATIBLE signature: returns per-day items without metadata.
 */
export declare function forecast(
  input: CropForecastInput
): Promise<CropForecastItem[]>;

/**
 * Advanced forecast with options, aggregation, and metadata.
 */
export declare function forecast(
  input: CropForecastInput,
  options: ForecastOptions
): Promise<ForecastOutput>;
