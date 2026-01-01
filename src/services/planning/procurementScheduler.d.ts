// C:\Users\larho\suka-smart-assistant\src\services\planning\procurementScheduler.d.ts

import type {
  ProcurementPlanRequest,
  ProcurementPlanResponse,
} from "../../types/mealplan";

/**
 * Optional knobs to steer procurement planning and integrate across the system.
 * These augment your existing ProcurementPlanRequest without breaking it.
 */
export interface PlanOptions {
  /** Strategy to prioritize when resolving each line. Default: "cost_first". */
  strategy?:
    | "cost_first"          // cheapest that meets constraints
    | "inventory_first"     // consume inventory/forecast before buying
    | "freshness_first"     // earliest use-by / shortest chain
    | "local_first"         // prefer local vendors even if slightly pricier
    | "balanced";           // blend of cost + freshness + loyalty perks

  /** Hard limits and soft targets. */
  constraints?: {
    budgetMax?: number;                       // total budget ceiling
    vendorAllowlist?: string[];               // only purchase from these vendor IDs
    vendorBlocklist?: string[];               // never purchase from these vendor IDs
    perishableHoursMax?: number;              // cold-chain time limit
    deliveryWindows?: Array<{                 // acceptable window(s) for receiving
      startISO: string;
      endISO: string;
    }>;
    sabbathAware?: boolean;                   // avoid delivery/active procurement in quiet windows
    requireInStock?: boolean;                 // skip backorders if true
    preferInStock?: boolean;                  // de-prioritize backorders if true
  };

  /** Substitution rules (e.g., “baby spinach ↔ spinach” with priority scoring). */
  substitutions?: Array<{
    for: string;                               // canonical item key
    allow: Array<{ key: string; score?: number; note?: string }>;
  }>;

  /** Price locks, coupons, and loyalty. */
  pricing?: {
    priceLocks?: Array<{ vendorId: string; sku: string; unitPrice: number; expiresISO?: string }>;
    coupons?: Array<{ vendorId?: string; code: string; type: "percent" | "amount"; value: number; appliesToSkus?: string[]; expiresISO?: string }>;
    loyaltyMultipliers?: Record<string, number>; // vendorId -> weight boost (e.g., 1.05)
    taxRatePct?: number;                         // default tax if vendor missing one
  };

  /** Fulfillment mode and routing preferences. */
  fulfillment?: {
    mode?: "delivery" | "pickup" | "mixed";
    consolidateVendors?: boolean;               // fewer stops if true
    routeStartAddressId?: string;               // for pickup routing
  };

  /** Link to batch cooking sessions & meal timeline. */
  batching?: {
    sessionIds?: string[];                      // to align purchase timing
    bufferDays?: number;                        // buy this many days before cook date
  };

  /** Produce forecast integration (garden/homegrown). */
  garden?: {
    useForecast?: boolean;                      // default true
    reserveHomegrownFirst?: boolean;            // subtract forecast before shopping
  };

  /** Auditability/settings. */
  meta?: {
    seed?: number;                              // deterministic solver runs (tests)
    versionTag?: string;                        // propagate to audit trail
    includeAlternatesInOutput?: boolean;        // surface near-miss alternates
  };
}

/**
 * Rich planning artifacts returned when options are provided.
 * Backward-compatible: callers using the legacy signature still get ProcurementPlanResponse.
 */
export interface EnhancedProcurementPlanResponse extends ProcurementPlanResponse {
  /** The resolved cart broken down by vendor, with alternates considered. */
  vendors: Array<{
    vendorId: string;
    vendorName?: string;
    fulfillment: "delivery" | "pickup";
    etaISO?: string;
    subtotal: number;
    tax: number;
    discounts: number;
    total: number;
    lines: Array<{
      id: string;                  // internal line id
      demandKey: string;           // link back to request demand
      sku?: string;
      name: string;
      unit: string;
      qty: number;
      unitPrice: number;
      lineTotal: number;
      isSubstitution?: boolean;
      substitutedFor?: string;     // demand key or canonical key
      notes?: string[];
      coldChain?: boolean;         // needs cold handling
      allergens?: string[];        // surfaced for safety review
      backorderETA?: string | null;
      inStock?: boolean;
      alternates?: Array<{ vendorId: string; sku: string; name: string; unitPrice: number; score?: number }>;
    }>;
  }>;

  /** Items not fulfilled and why. */
  unfulfilled: Array<{
    demandKey: string;
    name: string;
    unit?: string;
    qty: number;
    reason:
      | "budget_exceeded"
      | "no_stock"
      | "window_conflict"
      | "vendor_blocked"
      | "substitution_disallowed"
      | "unknown";
    suggestions?: string[];
  }>;

  /** Merged grocery list deltas (post-inventory, post-forecast). */
  deltas: {
    fromInventory: Array<{ name: string; qty: number; unit?: string }>;
    fromGarden: Array<{ name: string; qty: number; unit?: string; sourceDate?: string }>;
    toBuy: Array<{ name: string; qty: number; unit?: string }>;
  };

  /** Route plan for pickups (if any). */
  route?: {
    startAddressId?: string;
    stops: Array<{
      vendorId: string;
      addressId?: string;
      etaISO?: string;
      items: number;               // count of line items at this stop
      coldChainBreakMinutes?: number; // estimate for cold-chain exposure
    }>;
    distanceKm?: number;
    driveTimeMin?: number;
  };

  /** Coupon/lock application summary. */
  pricingSummary?: {
    couponsApplied: Array<{ vendorId?: string; code: string; value: number }>;
    priceLocksApplied: Array<{ vendorId: string; sku: string; unitPrice: number }>;
    loyaltyBoosts?: Array<{ vendorId: string; multiplier: number }>;
    estimatedTax: number;
    estimatedTotal: number;
  };

  /** Cross-links to timeline/sessions for UI hints. */
  links?: {
    mealTimelineRange?: { startISO: string; endISO: string };
    batchSessions?: Array<{ sessionId: string; buyByISO: string }>;
  };

  /** Transparent paper trail for “visible drafts”. */
  audit: Array<{
    atISO: string;
    action: string;               // e.g., "substitution_applied"
    detail?: Record<string, any>;
  }>;

  /** Non-fatal planning hints. */
  warnings: string[];

  /** Version tag (propagated from options.meta.versionTag or set internally). */
  version: string;
}

/**
 * PREFERRED: Dynamic planner with rich options and enriched response.
 */
export declare function plan(
  req: ProcurementPlanRequest,
  options?: PlanOptions
): Promise<EnhancedProcurementPlanResponse>;

/**
 * LEGACY: Original signature kept for backward compatibility.
 * Returns the classic ProcurementPlanResponse shape.
 */
export declare function plan(
  req: ProcurementPlanRequest
): Promise<ProcurementPlanResponse>;

/** Optional convenience type for the CommonJS object export shape. */
export type ProcurementScheduler = { plan: typeof plan };
