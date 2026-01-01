// src/types/mealplan.d.ts

/* -------------------------------------------------------------------------- */
/* Common scalars & helpers                                                   */
/* -------------------------------------------------------------------------- */

export type ISODateString = string;      // e.g. "2025-08-19T18:30:00.000Z"
export type DateYMD = string;            // e.g. "2025-08-19"
export type WeekId = string;             // e.g. "2025-W34"
export type UUID = string;

export type Unit =
  | 'g' | 'kg' | 'oz' | 'lb'
  | 'ml' | 'l'
  | 'tsp' | 'tbsp' | 'cup'
  | 'each' | 'unit'
  | (string & {}); // allow custom units

export type MoneyCents = number;         // store prices in cents
export type UrlString = string;

export interface Range<T = number> {
  min?: T;
  max?: T;
}

/* Small generic quantity */
export interface Qty {
  qty: number;
  unit?: Unit;
}

/* Optional app-wide observance hints (aligns with SettingsStore) */
export interface ObservanceHints {
  sabbathAware?: boolean;
  sabbathSunsetOffsetMin?: number;
  // Optional explicit window for clarity in UI/planning
  sabbathWindow?: { start?: ISODateString; end?: ISODateString } | null;
}

/* -------------------------------------------------------------------------- */
/* Recipe & Nutrition                                                         */
/* -------------------------------------------------------------------------- */

export interface Nutrition {
  calories?: number;
  protein_g?: number;
  fat_g?: number;
  carbs_g?: number;
  fiber_g?: number;
  sodium_mg?: number;
  [k: string]: number | undefined;
}

export interface IngredientLine {
  name: string;
  qty: number;
  unit?: Unit;
  notes?: string;
  // optional mapping to inventory SKU
  sku?: string | null;
  category?: string | null; // e.g. "produce", "dairy"
  // optional pricing metadata (lets agents estimate meal cost)
  unitPriceCents?: MoneyCents | null;
}

export interface RecipeLite {
  id: string;
  title: string;
  slug?: string;
  tags?: string[];
  serves?: number;                 // default servings
  ingredients?: IngredientLine[];  // normalized lines
  nutritionPerServing?: Nutrition;
  url?: UrlString;

  // Optional hints for planners/UI
  imageUrl?: UrlString;
  prepTimeMin?: number | null;
  cookTimeMin?: number | null;
  totalTimeMin?: number | null;
  costPerServingCents?: MoneyCents | null;
  meta?: Record<string, any>;
}

/* -------------------------------------------------------------------------- */
/* Meal planning                                                              */
/* -------------------------------------------------------------------------- */

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack' | (string & {});
export interface MealSlotWindow {
  start: string; // "HH:mm"
  end: string;   // "HH:mm"
}

/** Rhythm rule (lightweight mirror of MealRhythmStore presets) */
export interface RhythmRule {
  id: string;
  name?: string;
  priority?: number;
  enabled?: boolean;
  match?: {
    daysOfWeek?: number[];     // 0..6
    weekday?: boolean;         // M-F
    weekend?: boolean;         // Sat/Sun
    labels?: string[];         // tag-based activation
  };
  ifWindowDaily?: MealSlotWindow; // intermittent-fasting window, etc.
  slots?: Array<{ slotId: MealSlot; label?: string; timeHint?: string }>;
  dayMacroTarget?: { kcal?: number };
}

/** A single planned meal occurrence */
export interface PlannedMeal {
  id: string;               // internal id
  date: DateYMD;            // YYYY-MM-DD
  slot: MealSlot;

  recipeId?: string;
  recipe?: RecipeLite | null;

  servings?: number;        // how many portions to prepare
  notes?: string;
  labels?: string[];        // e.g. "batch", "freezer-meal"
  meta?: any;

  // Optional helpful computed fields for UI/agents
  estimateCents?: MoneyCents | null;     // estimated total cost for this meal
  prepTimeMin?: number | null;           // specific to this instance
  freezerSafe?: boolean;                 // tagging convenience
}

/** Plan container */
export interface MealPlan {
  planId: string;
  userId?: string | null;
  startDate: DateYMD;
  days: number;             // span length (e.g., 7, 14)
  week?: WeekId;
  timezone?: string;
  createdAt?: ISODateString;
  updatedAt?: ISODateString;

  meals: PlannedMeal[];

  // Preferences/context used to generate this plan (snapshot)
  prefsSnapshot?: Partial<MealPlanPrefs> | null;
  rhythmRules?: RhythmRule[];           // snapshot of active rhythm rules
  observance?: ObservanceHints;         // snapshot from Settings

  // Derived aggregates (optional)
  demand?: GroceryDemandItem[];     // merged demand for the period
  summary?: MealPlanSummary;
}

export interface MealPlanSummary {
  totalMeals: number;
  totalServings: number;
  bySlot?: Record<MealSlot, number>;
  byTag?: Record<string, number>;
  nutritionApprox?: Nutrition; // summed/avg approx, if available

  // Optional budget rollups
  spendCents?: MoneyCents | 0;
  spendByDay?: Array<{ date: DateYMD; cents: MoneyCents }>;
}

/* -------------------------------------------------------------------------- */
/* Grocery demand + inventory                                                 */
/* -------------------------------------------------------------------------- */

export interface GroceryDemandItem {
  name: string;
  qty: number;
  unit?: Unit;
  needBy?: DateYMD | ISODateString;     // when needed
  category?: string | null;
  sources?: Array<{
    recipeId?: string;
    recipeTitle?: string;
    mealId?: string;
    slot?: MealSlot;
    servings?: number;
    qty?: number;
  }>;
  // Optional procurement hints
  preferredVendorId?: string | null;
  substitutions?: string[]; // alternative SKUs/names
}

export interface InventoryItem {
  name: string;
  qty: number;
  unit?: Unit;
  location?: string | null;             // e.g. "pantry", "freezer A"
  min?: number | null;                  // minimum desired stock
  reorderTo?: number | null;            // target stock level
  sku?: string | null;
  lastUpdated?: ISODateString;

  // Optional dating for perishables
  perishBy?: DateYMD | null;
}

export type InventorySnapshot =
  | Record<string, { qty: number; unit?: Unit; [k: string]: any }>
  | InventoryItem[];

/* -------------------------------------------------------------------------- */
/* Preferences (aligns with MealPrefsStore / useMealPrefs)                    */
/* -------------------------------------------------------------------------- */

export interface DietaryPrefs {
  diets?: Array<'keto' | 'paleo' | 'vegetarian' | 'vegan' | 'kosher' | 'halal' | (string & {})>;
  allergies?: string[];     // e.g. "peanut", "shellfish"
  dislikes?: string[];      // ingredients or tags
  maxPrepMinutes?: number;  // soft cap
  kidFriendly?: boolean;
  spiceTolerance?: 'low' | 'medium' | 'high';
  // Optional stricter toggles (mirror to MealPrefsStore)
  kosherStyle?: boolean;
  pork?: boolean;
  shellfish?: boolean;
}

export interface CalendarPrefs {
  timezone?: string;
  sabbathAware?: boolean;
  sabbathSunsetOffsetMin?: number; // used by sabbath-sunset-prep
  avoidDates?: DateYMD[];          // holidays, travel, etc.
}

export interface BudgetPrefs {
  weekly?: MoneyCents;  // suggested weekly grocery budget
  hardCap?: MoneyCents; // do-not-exceed cap
}

export interface MealPlanPrefs {
  householdSize?: number;        // default servings per dinner
  defaultSlots?: MealSlot[];     // which slots to plan for
  batchCookDays?: Array<'sun'|'mon'|'tue'|'wed'|'thu'|'fri'|'sat'>;

  dietary?: DietaryPrefs;
  calendar?: CalendarPrefs;
  budget?: BudgetPrefs;

  labels?: string[];             // default labels to apply to meals/tasks
  vendorPreference?: string[];   // preferred vendor ids for procurement

  // Optional rhythm window (IF etc.) for generation hints
  ifWindowDaily?: MealSlotWindow | null;
}

/* -------------------------------------------------------------------------- */
/* Vendors & catalog                                                          */
/* -------------------------------------------------------------------------- */

export interface Vendor {
  id: string;
  name: string;
  priority?: number;     // lower = preferred
  leadTimeDays?: number; // default 2
  minOrderCents?: MoneyCents | null;
  shippingCents?: MoneyCents | null;
  tags?: string[];
  catalog?: VendorCatalogItem[];
}

export interface VendorCatalogItem {
  sku: string;
  name: string;          // human-friendly name
  unit?: Unit;           // selling unit (e.g., 'lb', 'each')
  packQty?: number;      // units per pack (default 1)
  priceCents: MoneyCents;
  vendorId?: string;
  category?: string | null;
  substitutes?: string[]; // alternative SKUs
}

/* -------------------------------------------------------------------------- */
/* Procurement planning (server + fallback planner)                           */
/* -------------------------------------------------------------------------- */

export interface PlanOpts {
  startDate?: DateYMD;
  sabbathAware?: boolean;
  budget?: BudgetPrefs | null;
  preferVendors?: string[];  // vendor ids to prioritize
}

export interface ProcurementItem {
  sku?: string | null;       // chosen SKU if mapped
  name: string;
  qty: number;
  unit?: Unit;
  packQty?: number;          // units per pack
  packs?: number;            // number of packs to buy
  unitPriceCents?: MoneyCents | 0;
  extPriceCents?: MoneyCents | 0;
  category?: string | null;
  needBy?: DateYMD | ISODateString | null;
  sources?: GroceryDemandItem['sources'];
}

export interface PurchaseOrder {
  id: string;
  vendorId: string;
  vendorName: string;
  orderDate: ISODateString;
  estDeliveryDate: ISODateString | null;
  items: ProcurementItem[];
  shippingCents?: MoneyCents | 0;
  subtotalCents?: MoneyCents | 0;
  totalCents?: MoneyCents | 0;
  notes?: string | null;
}

export interface Substitution {
  original: { name: string; unit?: Unit; reason?: string };
  chosen: { sku?: string | null; name: string; unit?: Unit };
}

export interface Backorder {
  name: string;
  qty: number;
  unit?: Unit;
  vendorId?: string | null;
  reason?: string; // e.g., "out_of_stock"
}

export interface ProcurementPlanSummary {
  spendCents?: MoneyCents | 0;
  items?: number;
  vendors?: number;
  weekBuckets?: Array<{ week: WeekId; spendCents: MoneyCents }>;
}

export interface ProcurementPlan {
  purchaseOrders: PurchaseOrder[];
  substitutions: Substitution[];
  backorders: Backorder[];
  tasks?: PlanTask[]; // optional task suggestions
  summary?: ProcurementPlanSummary;
}

/** Payload accepted by POST /procurement/plan (server) */
export interface ProcurementPlanRequest {
  demand: GroceryDemandItem[];
  inventory: InventorySnapshot;   // map or array
  vendors?: Vendor[];
  opts?: PlanOpts;
}

/** Response from POST /procurement/plan (server) */
export interface ProcurementPlanResponse extends ProcurementPlan {}

/* -------------------------------------------------------------------------- */
/* Task payload (used by /automations/tasks across workflows)                 */
/* -------------------------------------------------------------------------- */

export interface PlanTask {
  title: string;
  category: 'procurement' | 'inventory' | 'mealplan' | 'cooking' | 'sabbath' | 'home' | 'irrigation' | 'preservation' | string;
  labels?: string[];
  priority?: 1 | 2 | 3; // 1 = high
  due?: ISODateString | DateYMD;
  userId?: string | null;
  meta?: any;
}

/* -------------------------------------------------------------------------- */
/* Service contracts (optional typing for your service modules)               */
/* -------------------------------------------------------------------------- */

export interface MealPlannerService {
  /** Generate meals for a period, honoring prefs and calendar constraints. */
  generatePlan(
    startDate: DateYMD,
    days: number,
    prefs?: Partial<MealPlanPrefs>
  ): Promise<MealPlan>;

  /** Build consolidated grocery demand from a plan (or directly from meals). */
  buildGroceryList(
    input: MealPlan | PlannedMeal[]
  ): Promise<GroceryDemandItem[]>;

  /** Convert a grocery list + inventory into a procurement plan. */
  planProcurement(
    req: ProcurementPlanRequest
  ): Promise<ProcurementPlanResponse>;
}

/* -------------------------------------------------------------------------- */
/* Workflow payloads (align with n8n files you built earlier)                 */
/* -------------------------------------------------------------------------- */

export interface AutoRefillWebhookBody {
  userId?: string;
  startDate?: DateYMD;
  days?: number;
  demand?: GroceryDemandItem[];
  inventory?: InventorySnapshot;
  vendors?: Vendor[];
  budget?: BudgetPrefs;
  preferVendors?: string[];
  observance?: ObservanceHints;
}

export interface AutoRefillWebhookResult {
  ok: boolean;
  planner: 'server' | 'fallback' | 'unknown';
  purchaseOrders: number;
  tasksCreated: number;
  summary?: ProcurementPlanSummary;
}

/* -------------------------------------------------------------------------- */
/* Type guards (declaration only)                                             */
/* -------------------------------------------------------------------------- */

export function isMealPlan(x: any): x is MealPlan;
export function isGroceryDemandItem(x: any): x is GroceryDemandItem;
export function isProcurementPlan(x: any): x is ProcurementPlan;
