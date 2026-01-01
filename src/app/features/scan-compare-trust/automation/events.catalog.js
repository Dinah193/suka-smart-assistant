/* eslint-disable no-console */
// events.catalog.js — Event names + payload contracts (runtime-validated, dep-free)
// Style: ESM-first, zero deps, namespaced constants, gentle schemas, versioned.

/**
 * Public API
 * ----------
 * EVENT            // string constants (namespaced)
 * SCHEMA           // runtime schemas for each event
 * assertPayload(name, payload) -> {ok:boolean, errors?:string[]}
 * buildEvent(name, payload, meta?) -> { name, payload, atISO, v, meta? }  (throws on invalid)
 * isEvent(name, evt) -> boolean
 * 
 * Notes:
 * - Keep event names stable. Only add new ones or deprecate with clear mapping.
 * - Schemas are permissive but catch common shape errors.
 * - Aligns with: deeplinks.js, ocr.worker.js, cycle.worker.js, useProductScan.js,
 *   CouponService, CycleAnalyzer, SourceAttribution, Save Session modal & Scheduler.
 */

export const CATALOG_VERSION = "2025.10.27";

/* ------------------------------- NAMES ----------------------------------- */

export const EVENT = Object.freeze({
  // UI entry + guards
  SCAN_SHEET_OPEN:           "scan:sheet:open",
  SCAN_ORCHESTRATE_START:    "scan:orchestrate:start",
  GUARD_BLOCKED:             "guard:blocked",
  NBA_HINT:                  "nba:hint",

  // Favorites + schedules (user-owned)
  SESSION_FAVOR_PROMPT:      "session:favorites:prompt",
  SCHED_TEMPLATE_APPLY:      "scheduler:template:apply",

  // Deep links (analytics-level typically)
  DEEPLINK_OPENED:           "deeplink_opened",

  // Product scan pipeline (resolve → safety → pricing → coupons)
  PRODUCT_RESOLVED:          "product:resolved",
  PRODUCT_SAFETY_DONE:       "product:safety:evaluated",
  PRICING_RESOLVED:          "pricing:resolved",
  COUPONS_RESOLVED:          "coupons:resolved",

  // Observability + attribution
  SOURCE_ATTR_UPDATED:       "source:attribution:updated",

  // Coupon / cycle signals
  COUPON_OFFER_OBSERVED:     "coupon:offer:observed",
  CYCLE_OBSERVED:            "cycle:observed",

  // OCR worker -> app shell
  WORKER_OCR_READY:          "worker:ocr:ready",
  WORKER_OCR_INIT_OK:        "worker:ocr:init_ok",
  WORKER_OCR_PROGRESS:       "worker:ocr:progress",
  WORKER_OCR_FRAME_DONE:     "worker:ocr:frame_done",
  WORKER_OCR_SERIES_INDEXED: "worker:ocr:series_indexed",
  WORKER_OCR_CYCLES:         "worker:ocr:cycles_learned",
  WORKER_OCR_GUARD_BLOCKED:  "worker:ocr:guard_blocked",
  WORKER_OCR_ERROR:          "worker:ocr:error",
  WORKER_OCR_HEALTH:         "worker:ocr:health",

  // Cycle worker -> app shell
  WORKER_CYCLE_READY:        "worker:cycle:ready",
  WORKER_CYCLE_INIT_OK:      "worker:cycle:init_ok",
  WORKER_CYCLE_UPSERT_OK:    "worker:cycle:upsert_ok",
  WORKER_CYCLE_OFFERS_OK:    "worker:cycle:offers_ok",
  WORKER_CYCLE_CYCLES:       "worker:cycle:cycles_learned",
  WORKER_CYCLE_ANOMALIES:    "worker:cycle:anomalies",
  WORKER_CYCLE_GUARD_BLOCKED:"worker:cycle:guard_blocked",
  WORKER_CYCLE_ERROR:        "worker:cycle:error",

  // ScanSheet interactions (nice-to-have UI intents)
  SCAN_ACTION_ADD_TO_CART:   "scan:action:add_to_cart",
  SCAN_TRUST_INGREDIENT_FLAG:"scan:trust:ingredient_flag",
});

/* ------------------------------- SCHEMAS --------------------------------- */
/** Minimal schema helpers (dep-free) */
const t = {
  string: (o={}) => ({type:"string", ...o}),
  number: (o={}) => ({type:"number", ...o}),
  boolean:(o={}) => ({type:"boolean",...o}),
  isoDate:(o={}) => ({type:"isoDate",...o}),
  enum:   (vals, o={}) => ({type:"enum", vals, ...o}),
  array:  (item, o={}) => ({type:"array", item, ...o}),
  obj:    (shape, o={}) => ({type:"obj", shape, ...o}),
  optional: (inner) => ({...inner, optional:true}),
  nullable: (inner) => ({...inner, nullable:true}),
};

export const SCHEMA = Object.freeze({
  [EVENT.SCAN_SHEET_OPEN]: t.obj({
    barcode: t.optional(t.obj({ type: t.enum(["upc","ean"]), value: t.string() })),
    queryText: t.optional(t.string()),
    storeFilter: t.optional(t.string()),
    userZip: t.optional(t.string()),
    initialTab: t.optional(t.enum(["compare","details","trust"])),
    providerHints: t.optional(t.obj({
      preferStores: t.optional(t.array(t.string())),
      zip: t.optional(t.string()),
    })),
    _deeplink: t.optional(t.obj({ source: t.string(), at: t.optional(t.isoDate()) })),
  }),

  [EVENT.SCAN_ORCHESTRATE_START]: t.obj({
    source: t.optional(t.string()),
    barcode: t.nullable(t.obj({ type: t.enum(["upc","ean"]), value: t.string() })),
    queryText: t.optional(t.string()),
    providerHints: t.optional(t.obj({
      preferStores: t.optional(t.array(t.string())),
      zip: t.optional(t.string()),
    })),
  }),

  [EVENT.GUARD_BLOCKED]: t.obj({
    feature: t.string(),
    reason: t.optional(t.enum(["sabbath","quiet-hours","guarded"])),
    atISO: t.optional(t.isoDate()),
    intent: t.optional(t.obj({
      type: t.string(),
      payload: t.optional(t.obj({})),
    })),
  }),

  [EVENT.NBA_HINT]: t.obj({
    scope: t.string(),                 // e.g. 'scan'
    title: t.string(),
    body: t.optional(t.string()),
    action: t.optional(t.obj({ type: t.string(), for: t.optional(t.string()), payload: t.optional(t.obj({})) })),
  }),

  [EVENT.SESSION_FAVOR_PROMPT]: t.obj({
    domain: t.enum(["scan"]),
    template: t.optional(t.string()),
    payload: t.obj({
      barcode: t.nullable(t.obj({ type: t.enum(["upc","ean"]), value: t.string() })),
      queryText: t.optional(t.string()),
      storeFilter: t.optional(t.string()),
      userZip: t.optional(t.string()),
      initialTab: t.optional(t.enum(["compare","details","trust"])),
      providerHints: t.optional(t.obj({
        preferStores: t.optional(t.array(t.string())),
        zip: t.optional(t.string()),
      })),
      _deeplink: t.optional(t.obj({ source: t.string(), at: t.optional(t.isoDate()) })),
    }),
    origin: t.optional(t.string()), // e.g., 'deeplink', 'ocr.worker'
  }),

  [EVENT.SCHED_TEMPLATE_APPLY]: t.obj({
    domain: t.enum(["scan"]),
    templateKey: t.string(), // e.g., 'weekly-scan-sunday-6pm'
    context: t.optional(t.obj({ payload: t.optional(t.obj({})), origin: t.optional(t.string()) }))
  }),

  [EVENT.DEEPLINK_OPENED]: t.obj({
    kind: t.enum(["scan"]),
    scheme: t.optional(t.string()),
    tab: t.optional(t.enum(["compare","details","trust"])),
    hasBarcode: t.optional(t.boolean()),
    store: t.optional(t.string()),
  }),

  // Pipeline
  [EVENT.PRODUCT_RESOLVED]: t.obj({
    barcode: t.nullable(t.obj({ type: t.enum(["upc","ean"]), value: t.string() })),
    queryText: t.optional(t.string()),
    products: t.array(t.obj({
      id: t.string(),
      title: t.string(),
      brand: t.optional(t.string()),
      size: t.optional(t.string()),
      upc: t.optional(t.string()),
      provider: t.optional(t.string()), // e.g., 'costco','aldi','sams'
      score: t.optional(t.number({ min:0, max:1 })),
    })),
    providerHints: t.optional(t.obj({
      preferStores: t.optional(t.array(t.string())),
      zip: t.optional(t.string()),
    })),
  }),

  [EVENT.PRODUCT_SAFETY_DONE]: t.obj({
    products: t.array(t.obj({
      id: t.string(),
      safety: t.obj({
        recalls: t.optional(t.array(t.obj({ id:t.string(), title:t.string(), url:t.optional(t.string()) }))),
        flags: t.optional(t.array(t.obj({ code:t.string(), label:t.string(), severity:t.enum(["low","med","high"]) }))),
      }),
    })),
  }),

  [EVENT.PRICING_RESOLVED]: t.obj({
    items: t.array(t.obj({
      productId: t.string(),
      storeId: t.string(),
      price: t.number(),
      unitPrice: t.optional(t.obj({ amount: t.number(), per: t.string() })),
      dateISO: t.optional(t.isoDate()),
      source: t.optional(t.enum(["adapter","ocr","manual"])),
    })),
  }),

  [EVENT.COUPONS_RESOLVED]: t.obj({
    items: t.array(t.obj({
      productId: t.string(),
      offers: t.array(t.obj({
        id: t.string(),
        provider: t.string(),
        label: t.string(),
        value: t.string(), // "$2 off", "10%"
        startISO: t.optional(t.isoDate()),
        endISO: t.optional(t.isoDate()),
        stacking: t.optional(t.obj({ withManufacturer: t.optional(t.boolean()), withStore: t.optional(t.boolean()) })),
      })),
    })),
  }),

  [EVENT.SOURCE_ATTR_UPDATED]: t.obj({
    forScope: t.enum(["scan"]),
    sources: t.array(t.obj({ kind: t.string(), label: t.string(), weight: t.optional(t.number()) })), // e.g., OCR, Costco API, CycleAnalyzer
  }),

  // Signals
  [EVENT.COUPON_OFFER_OBSERVED]: t.obj({
    brand: t.optional(t.string()),
    category: t.optional(t.string()),
    storeId: t.optional(t.string()),
    startISO: t.isoDate(),
    endISO: t.isoDate(),
    provider: t.optional(t.string()),
  }),

  [EVENT.CYCLE_OBSERVED]: t.obj({
    key: t.string(), // upc:... or bn:...
    likelyCycleDays: t.number(),
    confidence: t.number(),
    nextExpectedStartISO: t.string(),
    window: t.obj({ startISO: t.optional(t.string()), endISO: t.optional(t.string()) }),
  }),

  // OCR worker
  [EVENT.WORKER_OCR_READY]: t.obj({}),
  [EVENT.WORKER_OCR_INIT_OK]: t.obj({ ok: t.boolean() }),
  [EVENT.WORKER_OCR_PROGRESS]: t.obj({ progress: t.number(), status: t.optional(t.string()) }),
  [EVENT.WORKER_OCR_FRAME_DONE]: t.obj({
    jobId: t.optional(t.string()),
    seriesId: t.optional(t.string()),
    frameId: t.optional(t.string()),
    textLen: t.optional(t.number()),
    itemsCount: t.optional(t.number()),
    ms: t.optional(t.number()),
  }),
  [EVENT.WORKER_OCR_SERIES_INDEXED]: t.obj({
    jobId: t.optional(t.string()),
    seriesId: t.string(),
    items: t.array(t.obj({
      key: t.string(), upc: t.optional(t.string()), brand: t.optional(t.string()),
      name: t.optional(t.string()), size: t.optional(t.string()),
      price: t.optional(t.number()), unitPrice: t.optional(t.any),
      dateISO: t.string(), storeId: t.optional(t.string()), source: t.optional(t.string())
    })),
    stats: t.obj({ count: t.number(), window: t.obj({ startISO: t.optional(t.string()), endISO: t.optional(t.string()) }), storeId: t.optional(t.string()) })
  }),
  [EVENT.WORKER_OCR_CYCLES]: t.obj({
    jobId: t.optional(t.string()),
    seriesId: t.string(),
    hints: t.array(t.obj({
      key: t.string(), likelyCycleDays: t.number(), confidence: t.number(),
      nextExpectedStartISO: t.string(),
      window: t.obj({ startISO: t.optional(t.string()), endISO: t.optional(t.string()) })
    })),
  }),
  [EVENT.WORKER_OCR_GUARD_BLOCKED]: t.obj({ reason: t.enum(["sabbath","quiet-hours","guarded"]) }),
  [EVENT.WORKER_OCR_ERROR]: t.obj({ jobId: t.optional(t.string()), message: t.string(), details: t.optional(t.string()) }),
  [EVENT.WORKER_OCR_HEALTH]: t.obj({}),

  // Cycle worker
  [EVENT.WORKER_CYCLE_READY]: t.obj({}),
  [EVENT.WORKER_CYCLE_INIT_OK]: t.obj({ ok: t.boolean() }),
  [EVENT.WORKER_CYCLE_UPSERT_OK]: t.obj({ jobId: t.optional(t.string()), seriesId: t.string(), count: t.number() }),
  [EVENT.WORKER_CYCLE_OFFERS_OK]: t.obj({ jobId: t.optional(t.string()), seriesId: t.string(), count: t.number() }),
  [EVENT.WORKER_CYCLE_CYCLES]: t.obj({
    jobId: t.optional(t.string()),
    seriesId: t.string(),
    hints: t.array(t.obj({
      key: t.string(), upc: t.optional(t.string()), brand: t.optional(t.string()),
      name: t.optional(t.string()), category: t.optional(t.string()),
      storeId: t.optional(t.string()),
      likelyCycleDays: t.number(), confidence: t.number(), promos: t.optional(t.number()),
      lastPromoISO: t.optional(t.string()),
      nextExpectedStartISO: t.string(),
      window: t.obj({ startISO: t.optional(t.string()), endISO: t.optional(t.string()) }),
      seasonality: t.optional(t.obj({ weekdayDensity: t.optional(t.any), monthDensity: t.optional(t.any) })),
      _meta: t.optional(t.obj({ method: t.optional(t.string()), offersAligned: t.optional(t.boolean()) })),
    })),
    stats: t.optional(t.obj({ keys: t.number(), points: t.number(), promos: t.number() })),
  }),
  [EVENT.WORKER_CYCLE_ANOMALIES]: t.obj({
    jobId: t.optional(t.string()),
    seriesId: t.string(),
    items: t.array(t.obj({ key: t.string(), dateISO: t.string(), price: t.number(), deltaPct: t.number(), kind: t.string() })),
  }),
  [EVENT.WORKER_CYCLE_GUARD_BLOCKED]: t.obj({ reason: t.enum(["sabbath","quiet-hours","guarded"]) }),
  [EVENT.WORKER_CYCLE_ERROR]: t.obj({ jobId: t.optional(t.string()), message: t.string() }),

  // UI niceties
  [EVENT.SCAN_ACTION_ADD_TO_CART]: t.obj({
    productId: t.string(),
    storeId: t.optional(t.string()),
    qty: t.optional(t.number()),
  }),
  [EVENT.SCAN_TRUST_INGREDIENT_FLAG]: t.obj({
    productId: t.string(),
    flagCode: t.string(),   // e.g., 'allergen-peanut', 'additive-bha'
    severity: t.enum(["low","med","high"]),
  }),
});

/* ---------------------------- VALIDATION CORE ---------------------------- */

export function assertPayload(name, payload) {
  const schema = SCHEMA[name];
  if (!schema) return { ok: true }; // unknown events: no validation
  const errors = [];
  validate(schema, payload, `payload`, errors);
  return { ok: errors.length === 0, errors };
}

export function buildEvent(name, payload = {}, meta = {}) {
  const v = assertPayload(name, payload);
  if (!v.ok) {
    const msg = `[events.catalog] Invalid payload for "${name}":\n - ${v.errors.join("\n - ")}`;
    throw new Error(msg);
  }
  return { name, payload, atISO: new Date().toISOString(), v: CATALOG_VERSION, ...(Object.keys(meta).length ? { meta } : {}) };
}

export function isEvent(name, evt) {
  return evt && typeof evt === "object" && evt.name === name;
}

/* ---------------------------- INTERNAL VALIDATOR ------------------------- */

function validate(schema, value, path, errors) {
  const type = schema.type;
  const opt = schema.optional === true;
  const nul = schema.nullable === true;
  if (value == null) {
    if (value === null && nul) return true;
    if (value === undefined && opt) return true;
    errors.push(`${path} is ${value === null ? "null" : "undefined"} but required`);
    return false;
  }
  switch (type) {
    case "string":
      if (typeof value !== "string") errors.push(`${path} must be string`);
      break;
    case "number":
      if (typeof value !== "number" || !isFinite(value)) errors.push(`${path} must be number`);
      break;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path} must be boolean`);
      break;
    case "isoDate":
      if (typeof value !== "string" || !isFinite(new Date(value).getTime())) errors.push(`${path} must be ISO date string`);
      break;
    case "enum":
      if (!schema.vals.includes(value)) errors.push(`${path} must be one of ${schema.vals.join(", ")}`);
      break;
    case "array":
      if (!Array.isArray(value)) { errors.push(`${path} must be array`); break; }
      value.forEach((v, i) => validate(schema.item, v, `${path}[${i}]`, errors));
      break;
    case "obj":
      if (typeof value !== "object") { errors.push(`${path} must be object`); break; }
      for (const k of Object.keys(schema.shape)) {
        validate(schema.shape[k], value[k], `${path}.${k}`, errors);
      }
      break;
    default:
      // 'any' or unknown -> accept
      break;
  }
  return errors.length === 0;
}

/* ------------------------------ DEPRECATIONS ----------------------------- */

export const DEPRECATED = Object.freeze({
  // Example:
  // "scan:open": { replacedBy: EVENT.SCAN_SHEET_OPEN, since: "2025-10-01" }
});

/* ------------------------------- USAGE HINTS ------------------------------ */
/**
 * Example: emitting with validation
 * 
 * import { EVENT, buildEvent } from '@/features/scan-compare-trust/automation/events.catalog';
 * eventBus.emit(EVENT.SCAN_SHEET_OPEN, buildEvent(EVENT.SCAN_SHEET_OPEN, {
 *   barcode: { type: 'upc', value: '036000291452' },
 *   storeFilter: 'costco',
 *   initialTab: 'compare',
 *   providerHints: { preferStores: ['costco'], zip: '35203' },
 *   _deeplink: { source: 'deeplink', at: new Date().toISOString() }
 * }));
 * 
 * Example: pipeline stage result
 * eventBus.emit(EVENT.PRICING_RESOLVED, buildEvent(EVENT.PRICING_RESOLVED, {
 *   items: [{ productId: 'p1', storeId: 'costco', price: 12.99, unitPrice: { amount: 0.23, per: 'oz' } }]
 * }));
 * 
 * Favorites & schedules (user-owned):
 * eventBus.emit(EVENT.SESSION_FAVOR_PROMPT, buildEvent(EVENT.SESSION_FAVOR_PROMPT, {
 *   domain: 'scan',
 *   payload: { queryText: 'OCR series', initialTab: 'compare' }
 * }));
 * eventBus.emit(EVENT.SCHED_TEMPLATE_APPLY, buildEvent(EVENT.SCHED_TEMPLATE_APPLY, {
 *   domain: 'scan',
 *   templateKey: 'weekly-scan-sunday-6pm',
 *   context: { origin: 'deeplink' }
 * }));
 */
