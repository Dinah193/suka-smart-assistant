// C:\Users\larho\suka-smart-assistant\src\services\planning\getZonePlantingDates.d.ts

import type { DateYMD } from "../../types/mealplan";

/**
 * GLOBAL-READY PLANTING DATES API (Type Definitions)
 * --------------------------------------------------
 * Backward compatible with your prior types, now broadened for **all regions,
 * including African countries** and hemispheres. Supports national meteorology
 * services, Köppen–Geiger classes, elevation, bimodal rainy seasons, and GDD.
 */

/** Calculation data provenance. */
export type PlantingCalcSource =
  | "usda_zone_table"
  | "noaa_frost_avg"
  | "user_frost_overrides"
  | "historical_localized"
  | "heuristic_companion_rules"
  | "koppen_geiger_climate"
  | "global_normals"     // WMO normals / national services
  | "era5_reanalysis"    // Copernicus ERA5/ERA5-Land
  | "provider_specific";

/** Zone/coding systems (extensible). */
export type ZoneSystem =
  | "USDA"         // United States
  | "RHS"          // United Kingdom RHS H1–H7
  | "CANADA"       // Canadian Plant Hardiness
  | "AUS"          // Australia (BoM/ABARES derived)
  | "NZ"           // New Zealand (NIWA derived)
  | "EU"           // EU composite / DWD / Meteo-France / AEMET etc.
  | "KOPPEN"       // Köppen–Geiger (e.g., Cfb, Aw)
  | "LOCAL"        // Custom local schema
  // African region-aware placeholders (your impl may map these to providers):
  | "AF_SOUTHERN"  // SAWS, MeteoBotswana, Eswatini, Namibia, Zimbabwe, Zambia, Lesotho
  | "AF_EAST"      // KMD (Kenya), TMA (Tanzania), Uganda, Ethiopia, Rwanda, Burundi, Somalia
  | "AF_WEST"      // NiMet (Nigeria), GMet (Ghana), ANACIM (Senegal), Meteo-BF, etc.
  | "AF_NORTH"     // DMN (Morocco), INM (Tunisia), ONM (Algeria), EMA (Egypt), Libya
  | "AF_CENTRAL";  // Cameroon, Congo, DRC, CAR, Gabon, Equatorial Guinea

export type PlantingMethod = "direct_sow" | "start_indoors" | "transplant";
export type Season = "spring" | "summer" | "fall" | "winter";
export type Confidence = "low" | "medium" | "high";

/** Frost-risk envelope. */
export interface FrostRisk {
  lastSpring?: DateYMD;   // YYYY-MM-DD
  firstFall?: DateYMD;    // YYYY-MM-DD
  /** Bias toward risk tolerance; 0.1=safer, 0.9=earlier. Default 0.5. */
  percentile?: 0.1 | 0.2 | 0.5 | 0.8 | 0.9;
}

/** Heat-stress guidance. */
export interface HeatRisk {
  firstHighHeat?: DateYMD;     // e.g., ≥32°C/90°F onset
  thresholdF?: number;         // optional heat index/WBGT-like threshold
}

/**
 * Rain seasonality.
 * Many African climates are **bimodal** (e.g., “long rains” & “short rains”).
 * Keep legacy fields for back-compat and add `windows` for richer modeling.
 */
export interface RainSeasonality {
  hasMonsoon?: boolean;
  rainyStart?: DateYMD;               // legacy single-window start
  rainyEnd?: DateYMD;                 // legacy single-window end
  /** Multiple labelled rainy windows (e.g., "long_rains", "short_rains"). */
  windows?: Array<{ start: DateYMD; end: DateYMD; label?: string }>;
}

/** Soil temperature constraints for germination/transplant safety. */
export interface SoilTempThreshold {
  minSoilTempC?: number;
  consecutiveDays?: number;
}

/** Daylength guardrails (some crops are short/long-day sensitive). */
export interface PhotoperiodRule {
  minHours?: number;
  maxHours?: number;
}

/** Growing degree days (thermal time) configuration. */
export interface GDDConfig {
  baseC: number;
  target?: number;
  upperCapC?: number;
}

/** Options (now location- and provider-aware for **any** country). */
export interface GetDatesOptions {
  /** Prefer explicit coordinates over coarse zones when available. */
  location?: {
    lat: number;                // WGS84 latitude
    lon: number;                // WGS84 longitude
    elevationM?: number;        // improves frost/soil temp estimation
    tz?: string;                // IANA tz, e.g., "Africa/Nairobi"
    country?: string;           // ISO 3166-1 alpha-2 (e.g., "KE", "ZA", "NG", "EG")
  };

  /** Zone descriptor; may be a simple code or a structured system+code. */
  zone?: string | { system: ZoneSystem; code: string };

  frost?: FrostRisk;
  heat?: HeatRisk;
  soil?: SoilTempThreshold;
  photoperiod?: PhotoperiodRule;
  gdd?: GDDConfig;
  rainfall?: RainSeasonality;

  source?: PlantingCalcSource;
  includeFall?: boolean;
  successionEveryDays?: number;

  /** Align harvest with cooking/meal-plan targets. */
  harvestTargets?: Array<{ start: DateYMD; end: DateYMD; label?: string }>;

  /** Season-extension capabilities (buffers/lead times). */
  seasonExtension?: {
    rowCover?: boolean;
    lowTunnel?: boolean;
    coldFrame?: boolean;
    greenhouse?: boolean;
    heatMatIndoors?: boolean;
  };

  pacing?: "aggressive" | "normal" | "conservative";

  /** Emit calendar stubs for starts, harden-off, transplants, successions, harvests. */
  includeCalendarStubs?: boolean;

  /** Light-touch companion hints (non-blocking). */
  includeCompanionNotes?: boolean;

  /** Crop-specific overrides and advanced rules. */
  overrides?: Record<
    string,
    {
      method?: PlantingMethod;
      daysToMaturity?: number;
      indoorLeadTimeDays?: number;
      successionEveryDays?: number;
      fallVarietyBias?: boolean;
      soil?: SoilTempThreshold;
      photoperiod?: PhotoperiodRule;
      gdd?: GDDConfig;
    }
  >;

  /**
   * Pluggable climate providers.
   * Your implementation can query any of these; failures should be non-fatal.
   * Include African national services as desired.
   */
  climateProviders?: Partial<{
    frostFor(lat: number, lon: number, elevationM?: number, country?: string): Promise<FrostRisk | null>;
    soilFor(lat: number, lon: number, whenISO: DateYMD): Promise<{ avgSoilTempC?: number } | null>;
    photoperiodFor(lat: number, lon: number, whenISO: DateYMD): Promise<{ hours: number } | null>;
    tempsFor(lat: number, lon: number, startISO: DateYMD, endISO: DateYMD): Promise<Array<{ date: DateYMD; tminC: number; tmaxC: number }> | null>;
    normalsFor(lat: number, lon: number, country?: string): Promise<Record<string, any> | null>;
    /** Optional regional hooks (examples): */
    africaEastNormals?(country: string, lat: number, lon: number): Promise<Record<string, any> | null>;   // KMD/TMA-style normals
    africaWestNormals?(country: string, lat: number, lon: number): Promise<Record<string, any> | null>;   // NiMet/GMet-style normals
    africaSouthNormals?(country: string, lat: number, lon: number): Promise<Record<string, any> | null>;  // SAWS/ARC-style normals
    africaNorthNormals?(country: string, lat: number, lon: number): Promise<Record<string, any> | null>;  // DMN/INM/ONM/EMA-style normals
    africaCentralNormals?(country: string, lat: number, lon: number): Promise<Record<string, any> | null>;
  }>;
}

/** Per-crop schedule with multi-stage windows. */
export interface CropPlantingSchedule {
  crop: string;
  method: PlantingMethod;

  spring?: {
    directSow?: { start: DateYMD; end: DateYMD } | null;
    startIndoors?: { start: DateYMD; end: DateYMD } | null;
    hardenOff?: { start: DateYMD; end: DateYMD } | null;
    transplantOut?: { start: DateYMD; end: DateYMD } | null;
    lastSowForHeat?: DateYMD | null;
    succession?: Array<{ date: DateYMD; note?: string }>;
    expectedHarvest?: { start: DateYMD; end: DateYMD } | null;
  };

  fall?: {
    directSow?: { start: DateYMD; end: DateYMD } | null;
    startIndoors?: { start: DateYMD; end: DateYMD } | null;
    hardenOff?: { start: DateYMD; end: DateYMD } | null;
    transplantOut?: { start: DateYMD; end: DateYMD } | null;
    lastSowBeforeFrost?: DateYMD | null;
    succession?: Array<{ date: DateYMD; note?: string }>;
    expectedHarvest?: { start: DateYMD; end: DateYMD } | null;
  };

  meta: {
    zone: string;
    zoneDetail?: { system: ZoneSystem; code: string } | null;
    season: Season[];
    daysToMaturity?: number;
    indoorLeadTimeDays?: number;
    gdd?: GDDConfig & { accumulated?: number };
    soil?: SoilTempThreshold;
    photoperiod?: PhotoperiodRule;
    rainfall?: RainSeasonality;
    buffers?: { early?: number; late?: number };
    confidence: Confidence;
    source: PlantingCalcSource;
    notes?: string[];
    companionNotes?: string[];
  };
}

/** Calendar event stub (for your Calendar Service). */
export interface CalendarEventStub {
  id: string;
  title: string;
  start: string; // ISO datetime
  end?: string;  // ISO datetime
  description?: string;
  location?: string;
  meta?: Record<string, any>;
  kind?: "seed_start" | "harden_off" | "transplant" | "direct_sow" | "succession" | "harvest_window" | "cover_on" | "cover_off" | "irrigate";
}

/** Rich result. */
export interface ZonePlantingDates {
  schedules: Record<string, CropPlantingSchedule>;
  links?: {
    harvestAlignedWindows?: Array<{ crop: string; targetLabel?: string; start: DateYMD; end: DateYMD }>;
  };
  calendar?: {
    provider?: "local" | "google" | "microsoft";
    events: CalendarEventStub[];
    tz?: string; // defaults to options.location.tz if set
  };
  warnings: string[];
  diagnostics?: {
    hemisphere?: "N" | "S";
    koppenClass?: string;
    usedProviders?: PlantingCalcSource[];
    usedOverrides?: string[];
    dataGaps?: string[]; // e.g., "soil_temp", "frost_percentile"
    rainfallWindowsChosen?: Array<{ start: DateYMD; end: DateYMD; label?: string }>;
  };
  version: string;
}

/**
 * Prefer passing `options.location` with lat/lon/elevation for best accuracy
 * in **all countries (including across Africa)**. `zone` remains for back-compat.
 */
export declare function getDates(
  zone: string,
  crops: string[],
  options?: GetDatesOptions
): Promise<ZonePlantingDates>;

/** LEGACY minimal shape (kept for compatibility). */
export declare function getDates(
  zone: string,
  crops: string[]
): Promise<Record<string, { start: DateYMD; end: DateYMD }>>;

export type ZonePlantingApi = { getDates: typeof getDates };
