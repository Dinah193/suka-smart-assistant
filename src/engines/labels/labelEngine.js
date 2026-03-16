// File: src/engines/labels/labelEngine.js
// SSA — Label Engine (production-ready, dependency-free)
//
// Purpose
// - Deterministic label generation for SSA: pantry/storehouse, freezer, jars/cans,
//   batch cooking, butchery cuts, garden harvest, fermentation, and generic labels.
// - Generates:
//    1) A normalized "label job" object (what to print + why)
//    2) Printable output for a target renderer: "zpl" (Zebra) or "html" (browser print)
// - Integrates with SSA patterns via optional eventBus injection.
//
// Design Goals
// - Works offline; no network calls.
// - Safe defaults; strict sanitization.
// - Template-driven with overridable layouts.
// - "Evidence trail": every label includes normalized fields + computed lines.
//
// Usage
//   import { createLabelEngine } from "@/engines/labels/labelEngine";
//   import { eventBus } from "@/services/events/eventBus";
//
//   const labels = createLabelEngine({ eventBus });
//   const job = labels.buildLabel({
//     type: "freezer_pack",
//     data: { itemName:"Goat Sausage", batchId:"B-102", packedAt:"2026-01-01", useBy:"2026-04-01" }
//   });
//   const zpl = labels.render(job, { renderer:"zpl", printer: { dpi:203, widthIn:2, heightIn:1 }});
//
// Notes
// - ZPL output is conservative and widely compatible.
// - HTML output is print-friendly and can be piped into a popup/iframe.
//
// Export
// - createLabelEngine(opts)
// - DEFAULT_TEMPLATES (for inspection/customization)
// - helpers: sanitizeText, formatDateShort, computeUseBy, computeBestBy, makeLabelId

import {
  formatLocalDate,
  toDate,
  toISODateTimeLocal,
} from "@/engines/scheduling/scheduleHelpers";

/* ------------------------------ constants ------------------------------ */

const DEFAULT_RENDERER = "html"; // html | zpl
const DEFAULT_LOCALE = undefined; // use browser/OS default
const DEFAULT_DPI = 203; // common Zebra
const DEFAULT_SIZE = { widthIn: 2, heightIn: 1 }; // 2x1 inch
const DEFAULT_MARGIN = 0.08; // inches
const MAX_LINE_LEN = 48; // for conservative truncation in plain outputs

// Common label types in SSA
const LABEL_TYPES = Object.freeze([
  "generic",
  "pantry",
  "freezer_pack",
  "jar",
  "ferment",
  "batch_cook",
  "leftovers",
  "butchery_cut",
  "harvest",
]);

/* ------------------------------ helpers ------------------------------ */

export function makeLabelId(prefix = "LBL") {
  // short-ish, stable enough for jobs
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 7)
    .toUpperCase()}`;
}

export function sanitizeText(
  input,
  { maxLen = 120, keepNewlines = false } = {}
) {
  const s = String(input ?? "");
  // remove control chars (except newline optionally)
  const cleaned = s.replace(
    keepNewlines ? /[^\x20-\x7E\n]/g : /[^\x20-\x7E]/g,
    ""
  );
  const normalized = cleaned.replace(/\s+/g, " ").trim();
  if (!maxLen) return normalized;
  return normalized.length > maxLen
    ? normalized.slice(0, maxLen - 1) + "…"
    : normalized;
}

function clamp(n, min, max) {
  const nn = Number.isFinite(n) ? n : min;
  return Math.min(max, Math.max(min, nn));
}

function safeNum(v, fallback = 0) {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : fallback;
}

function round(n, digits = 2) {
  const p = Math.pow(10, digits);
  return Math.round(safeNum(n, 0) * p) / p;
}

export function formatDateShort(dateLike, locales = DEFAULT_LOCALE) {
  const d = toDate(dateLike);
  if (!d) return "";
  // Use scheduleHelpers Intl wrapper for consistent behavior
  return formatLocalDate(d, locales);
}

export function formatDateISO(dateLike) {
  const d = toDate(dateLike);
  if (!d) return "";
  return toISODateTimeLocal(d);
}

export function normalizeUnit(unit) {
  const u = String(unit ?? "")
    .trim()
    .toLowerCase();
  if (!u) return "";
  const map = {
    pound: "lb",
    pounds: "lb",
    lbs: "lb",
    ounce: "oz",
    ounces: "oz",
    gram: "g",
    grams: "g",
    kilogram: "kg",
    kilograms: "kg",
    quart: "qt",
    quarts: "qt",
    pint: "pt",
    pints: "pt",
    gallon: "gal",
    gallons: "gal",
  };
  return map[u] || u;
}

export function formatQty(qty, unit, { digits = 2 } = {}) {
  const q = safeNum(qty, NaN);
  const u = normalizeUnit(unit);
  if (!Number.isFinite(q)) return "";
  const q2 = round(q, digits);
  if (!u) return String(q2);
  return `${q2}${u}`;
}

export function truncateLine(line, maxLen = MAX_LINE_LEN) {
  const s = sanitizeText(line, { maxLen: 999 });
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(0, maxLen - 1)) + "…";
}

// Adds days to a date (local)
function addDaysLocal(dateLike, days) {
  const d = toDate(dateLike);
  if (!d) return null;
  const out = new Date(d);
  out.setDate(out.getDate() + safeNum(days, 0));
  return out;
}

/**
 * Compute "use by" and "best by" dates deterministically using shelf-life rules.
 * Pass either:
 *  - explicit useBy/bestBy in data (wins), or
 *  - preservation hints + shelfLifeDays in data or template defaults
 */
export function computeUseBy({ packedAt, shelfLifeDays, useBy }) {
  const explicit = toDate(useBy);
  if (explicit) return explicit;
  const base = toDate(packedAt) || new Date();
  const days = clamp(safeNum(shelfLifeDays, 0), 0, 3650);
  if (!days) return null;
  return addDaysLocal(base, days);
}

export function computeBestBy({ packedAt, bestBy, bestByDays }) {
  const explicit = toDate(bestBy);
  if (explicit) return explicit;
  const base = toDate(packedAt) || new Date();
  const days = clamp(safeNum(bestByDays, 0), 0, 3650);
  if (!days) return null;
  return addDaysLocal(base, days);
}

function ensureArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

/* ------------------------------ template model ------------------------------ */
/**
Template output is "layout blocks" that renderers convert to ZPL/HTML.
Block types:
  - text: { type:"text", x,y, w,h, size, bold, value, align }
  - hr: { type:"hr", x,y, w, thickness }
  - qr: { type:"qr", x,y, size, value }
  - barcode: { type:"barcode", x,y, height, value, humanReadable }
  - box: { type:"box", x,y, w,h, thickness }
Coordinates are inches in logical layout space (renderer converts to dots/pixels).
*/

/* ------------------------------ default templates ------------------------------ */

function baseDefaults() {
  return {
    labelSize: { ...DEFAULT_SIZE },
    dpi: DEFAULT_DPI,
    marginIn: DEFAULT_MARGIN,
    font: {
      // "size" in inches for HTML; in ZPL we map to dot height (approx)
      small: 0.12,
      normal: 0.16,
      large: 0.2,
      xl: 0.26,
    },
    // for computation:
    shelfLifeDays: 0,
    bestByDays: 0,
    // rendering:
    showQR: true,
    showBarcode: false,
    qrField: "qrValue",
    barcodeField: "barcodeValue",
  };
}

function mkHeaderBlocks({ title, subtitle, rightTop, rightBottom, opts }) {
  const m = opts.marginIn;
  const w = opts.labelSize.widthIn - m * 2;
  return [
    {
      type: "text",
      x: m,
      y: m,
      w,
      h: 0.22,
      size: "xl",
      bold: true,
      value: title,
      align: "left",
    },
    subtitle
      ? {
          type: "text",
          x: m,
          y: m + 0.26,
          w: w * 0.68,
          h: 0.16,
          size: "normal",
          value: subtitle,
          align: "left",
        }
      : null,
    rightTop
      ? {
          type: "text",
          x: m + w * 0.7,
          y: m + 0.02,
          w: w * 0.3,
          h: 0.16,
          size: "normal",
          bold: true,
          value: rightTop,
          align: "right",
        }
      : null,
    rightBottom
      ? {
          type: "text",
          x: m + w * 0.7,
          y: m + 0.22,
          w: w * 0.3,
          h: 0.14,
          size: "small",
          value: rightBottom,
          align: "right",
        }
      : null,
    { type: "hr", x: m, y: m + 0.46, w, thickness: 0.012 },
  ].filter(Boolean);
}

function mkFooterBlocks({ left, center, right, opts }) {
  const m = opts.marginIn;
  const w = opts.labelSize.widthIn - m * 2;
  const y = opts.labelSize.heightIn - m - 0.16;
  return [
    left
      ? {
          type: "text",
          x: m,
          y,
          w: w * 0.33,
          h: 0.14,
          size: "small",
          value: left,
          align: "left",
        }
      : null,
    center
      ? {
          type: "text",
          x: m + w * 0.33,
          y,
          w: w * 0.34,
          h: 0.14,
          size: "small",
          value: center,
          align: "center",
        }
      : null,
    right
      ? {
          type: "text",
          x: m + w * 0.67,
          y,
          w: w * 0.33,
          h: 0.14,
          size: "small",
          value: right,
          align: "right",
        }
      : null,
  ].filter(Boolean);
}

function mkQrBlock({ value, opts }) {
  if (!opts.showQR || !value) return [];
  const m = opts.marginIn;
  const size = 0.55; // inches square
  const x = opts.labelSize.widthIn - m - size;
  const y = opts.marginIn + 0.52;
  return [{ type: "qr", x, y, size, value }];
}

function mkBarcodeBlock({ value, opts }) {
  if (!opts.showBarcode || !value) return [];
  const m = opts.marginIn;
  const x = m;
  const y = opts.labelSize.heightIn - m - 0.42;
  return [
    {
      type: "barcode",
      x,
      y,
      height: 0.28,
      value: String(value),
      humanReadable: false,
    },
  ];
}

// Default label templates (minimal but extensible)
export const DEFAULT_TEMPLATES = Object.freeze({
  generic: {
    id: "generic",
    type: "generic",
    defaults: { ...baseDefaults() },
    resolveFields(data) {
      const itemName = pickFirst(data.itemName, data.name, data.title, "Item");
      const batchId = pickFirst(data.batchId, data.lot, data.lotId, "");
      const packedAt = toDate(
        data.packedAt || data.date || data.madeAt || new Date()
      );
      const notes = pickFirst(data.notes, data.desc, "");

      const qrValue =
        pickFirst(data.qrValue, data.qr, "") ||
        (batchId ? `SSA:${itemName}|BATCH:${batchId}` : `SSA:${itemName}`);

      return {
        itemName,
        batchId,
        packedAt,
        notes,
        qrValue,
        barcodeValue: pickFirst(data.barcodeValue, data.barcode, ""),
      };
    },
    buildLayout(fields, opts) {
      const title = truncateLine(fields.itemName, 28);
      const subtitle = fields.batchId
        ? `Batch: ${truncateLine(fields.batchId, 18)}`
        : "";
      const rightTop = formatDateShort(fields.packedAt);
      const rightBottom = "SSA";
      const blocks = [
        ...mkHeaderBlocks({ title, subtitle, rightTop, rightBottom, opts }),
        ...mkQrBlock({ value: fields.qrValue, opts }),
        {
          type: "text",
          x: opts.marginIn,
          y: opts.marginIn + 0.54,
          w: (opts.labelSize.widthIn - opts.marginIn * 2) * 0.68,
          h: 0.16,
          size: "normal",
          value: truncateLine(fields.notes || "—", 40),
        },
        ...mkFooterBlocks({
          left: fields.batchId ? `Lot ${truncateLine(fields.batchId, 10)}` : "",
          center: "",
          right: "",
          opts,
        }),
      ];
      return blocks.filter(Boolean);
    },
  },

  pantry: {
    id: "pantry",
    type: "pantry",
    defaults: { ...baseDefaults(), shelfLifeDays: 365 },
    resolveFields(data) {
      const itemName = pickFirst(data.itemName, data.name, "Pantry Item");
      const packedAt = toDate(data.packedAt || data.date || new Date());
      const shelfLifeDays = safeNum(data.shelfLifeDays, 365);
      const useBy = computeUseBy({
        packedAt,
        shelfLifeDays,
        useBy: data.useBy,
      });
      const qty = data.qty ?? data.quantity ?? "";
      const unit = data.unit ?? "";
      const location = pickFirst(data.location, data.bin, data.shelf, "");
      const qrValue =
        pickFirst(data.qrValue, "") ||
        `SSA:pantry|${itemName}|packed:${formatDateISO(
          packedAt
        )}|useBy:${formatDateISO(useBy)}`;

      return {
        itemName,
        packedAt,
        useBy,
        qty,
        unit,
        location,
        qrValue,
      };
    },
    buildLayout(fields, opts) {
      const title = truncateLine(fields.itemName, 26);
      const qtyLine = fields.qty
        ? `Qty: ${formatQty(fields.qty, fields.unit)}`
        : "";
      const useByLine = fields.useBy
        ? `Use By: ${formatDateShort(fields.useBy)}`
        : "";
      const locLine = fields.location
        ? `Loc: ${truncateLine(fields.location, 18)}`
        : "";

      const m = opts.marginIn;
      const w = opts.labelSize.widthIn - m * 2;

      return [
        ...mkHeaderBlocks({
          title,
          subtitle: qtyLine || locLine,
          rightTop: formatDateShort(fields.packedAt),
          rightBottom: "Packed",
          opts,
        }),
        ...mkQrBlock({ value: fields.qrValue, opts }),
        {
          type: "text",
          x: m,
          y: m + 0.56,
          w: w * 0.68,
          h: 0.16,
          size: "large",
          bold: true,
          value: truncateLine(useByLine || "—", 34),
        },
        {
          type: "text",
          x: m,
          y: m + 0.76,
          w: w * 0.68,
          h: 0.14,
          size: "small",
          value: truncateLine(locLine || "", 34),
        },
      ].filter(Boolean);
    },
  },

  freezer_pack: {
    id: "freezer_pack",
    type: "freezer_pack",
    defaults: { ...baseDefaults(), shelfLifeDays: 90, bestByDays: 60 },
    resolveFields(data) {
      const itemName = pickFirst(data.itemName, data.name, "Freezer Pack");
      const batchId = pickFirst(data.batchId, data.lot, "");
      const packedAt = toDate(data.packedAt || data.date || new Date());
      const qty = data.qty ?? data.quantity ?? "";
      const unit = data.unit ?? "";
      const cut = pickFirst(data.cut, data.part, "");
      const shelfLifeDays = safeNum(data.shelfLifeDays, 90);
      const bestByDays = safeNum(data.bestByDays, 60);
      const bestBy = computeBestBy({
        packedAt,
        bestBy: data.bestBy,
        bestByDays,
      });
      const useBy = computeUseBy({
        packedAt,
        shelfLifeDays,
        useBy: data.useBy,
      });
      const storage = pickFirst(data.storage, data.zone, "Freezer");
      const qrValue =
        pickFirst(data.qrValue, "") ||
        `SSA:freezer|${itemName}|batch:${batchId}|packed:${formatDateISO(
          packedAt
        )}|bestBy:${formatDateISO(bestBy)}|useBy:${formatDateISO(useBy)}`;

      return {
        itemName,
        batchId,
        packedAt,
        qty,
        unit,
        cut,
        bestBy,
        useBy,
        storage,
        qrValue,
      };
    },
    buildLayout(fields, opts) {
      const title = truncateLine(fields.itemName, 24);
      const subtitle = fields.cut
        ? truncateLine(fields.cut, 24)
        : fields.batchId
        ? `Batch ${truncateLine(fields.batchId, 16)}`
        : "";
      const rightTop = fields.qty
        ? formatQty(fields.qty, fields.unit, { digits: 2 })
        : "";
      const rightBottom = truncateLine(fields.storage || "Freezer", 10);

      const m = opts.marginIn;
      const w = opts.labelSize.widthIn - m * 2;

      return [
        ...mkHeaderBlocks({ title, subtitle, rightTop, rightBottom, opts }),
        ...mkQrBlock({ value: fields.qrValue, opts }),
        {
          type: "text",
          x: m,
          y: m + 0.56,
          w: w * 0.68,
          h: 0.16,
          size: "normal",
          value: fields.bestBy
            ? `Best By: ${formatDateShort(fields.bestBy)}`
            : "Best By: —",
        },
        {
          type: "text",
          x: m,
          y: m + 0.74,
          w: w * 0.68,
          h: 0.16,
          size: "normal",
          bold: true,
          value: fields.useBy
            ? `Use By: ${formatDateShort(fields.useBy)}`
            : "Use By: —",
        },
        ...mkFooterBlocks({
          left: fields.batchId ? `Lot ${truncateLine(fields.batchId, 10)}` : "",
          center: `Packed ${formatDateShort(fields.packedAt)}`,
          right: "",
          opts,
        }),
      ].filter(Boolean);
    },
  },

  jar: {
    id: "jar",
    type: "jar",
    defaults: { ...baseDefaults(), shelfLifeDays: 365 },
    resolveFields(data) {
      const itemName = pickFirst(data.itemName, data.name, "Jar");
      const packedAt = toDate(
        data.packedAt || data.cannedAt || data.date || new Date()
      );
      const method = pickFirst(data.method, data.process, "");
      const batchId = pickFirst(data.batchId, data.lot, "");
      const shelfLifeDays = safeNum(data.shelfLifeDays, 365);
      const useBy = computeUseBy({
        packedAt,
        shelfLifeDays,
        useBy: data.useBy,
      });
      const lid = pickFirst(data.lid, data.seal, "");
      const qrValue =
        pickFirst(data.qrValue, "") ||
        `SSA:jar|${itemName}|method:${method}|packed:${formatDateISO(
          packedAt
        )}|useBy:${formatDateISO(useBy)}|batch:${batchId}`;

      return { itemName, packedAt, method, batchId, useBy, lid, qrValue };
    },
    buildLayout(fields, opts) {
      const title = truncateLine(fields.itemName, 24);
      const subtitle = fields.method
        ? truncateLine(fields.method, 24)
        : fields.lid
        ? truncateLine(fields.lid, 24)
        : "";
      const rightTop = "JAR";
      const rightBottom = fields.batchId
        ? truncateLine(fields.batchId, 10)
        : "";

      const m = opts.marginIn;
      const w = opts.labelSize.widthIn - m * 2;

      return [
        ...mkHeaderBlocks({ title, subtitle, rightTop, rightBottom, opts }),
        ...mkQrBlock({ value: fields.qrValue, opts }),
        {
          type: "text",
          x: m,
          y: m + 0.56,
          w: w * 0.68,
          h: 0.16,
          size: "normal",
          value: `Packed: ${formatDateShort(fields.packedAt)}`,
        },
        {
          type: "text",
          x: m,
          y: m + 0.74,
          w: w * 0.68,
          h: 0.16,
          size: "normal",
          bold: true,
          value: fields.useBy
            ? `Use By: ${formatDateShort(fields.useBy)}`
            : "Use By: —",
        },
      ].filter(Boolean);
    },
  },

  ferment: {
    id: "ferment",
    type: "ferment",
    defaults: { ...baseDefaults(), bestByDays: 30, shelfLifeDays: 120 },
    resolveFields(data) {
      const itemName = pickFirst(data.itemName, data.name, "Ferment");
      const startedAt = toDate(
        data.startedAt || data.startDate || data.packedAt || new Date()
      );
      const targetDays = clamp(
        safeNum(data.targetDays ?? data.days ?? 7, 7),
        0,
        365
      );
      const readyAt = addDaysLocal(startedAt, targetDays);
      const bestBy = computeBestBy({
        packedAt: startedAt,
        bestBy: data.bestBy,
        bestByDays: safeNum(data.bestByDays, 30),
      });
      const useBy = computeUseBy({
        packedAt: startedAt,
        shelfLifeDays: safeNum(data.shelfLifeDays, 120),
        useBy: data.useBy,
      });
      const batchId = pickFirst(data.batchId, data.lot, "");
      const qrValue =
        pickFirst(data.qrValue, "") ||
        `SSA:ferment|${itemName}|start:${formatDateISO(
          startedAt
        )}|ready:${formatDateISO(readyAt)}|bestBy:${formatDateISO(
          bestBy
        )}|useBy:${formatDateISO(useBy)}|batch:${batchId}`;

      return {
        itemName,
        startedAt,
        targetDays,
        readyAt,
        bestBy,
        useBy,
        batchId,
        qrValue,
      };
    },
    buildLayout(fields, opts) {
      const title = truncateLine(fields.itemName, 24);
      const subtitle = fields.batchId
        ? `Batch ${truncateLine(fields.batchId, 16)}`
        : "Fermentation";
      const rightTop = `${fields.targetDays}d`;
      const rightBottom = "TARGET";

      const m = opts.marginIn;
      const w = opts.labelSize.widthIn - m * 2;

      return [
        ...mkHeaderBlocks({ title, subtitle, rightTop, rightBottom, opts }),
        ...mkQrBlock({ value: fields.qrValue, opts }),
        {
          type: "text",
          x: m,
          y: m + 0.56,
          w: w * 0.68,
          h: 0.16,
          size: "normal",
          value: `Start: ${formatDateShort(fields.startedAt)}`,
        },
        {
          type: "text",
          x: m,
          y: m + 0.72,
          w: w * 0.68,
          h: 0.16,
          size: "normal",
          bold: true,
          value: fields.readyAt
            ? `Ready: ${formatDateShort(fields.readyAt)}`
            : "Ready: —",
        },
        {
          type: "text",
          x: m,
          y: m + 0.88,
          w: w * 0.68,
          h: 0.14,
          size: "small",
          value: fields.useBy ? `Use By: ${formatDateShort(fields.useBy)}` : "",
        },
      ].filter(Boolean);
    },
  },

  leftovers: {
    id: "leftovers",
    type: "leftovers",
    defaults: { ...baseDefaults(), shelfLifeDays: 4 },
    resolveFields(data) {
      const itemName = pickFirst(data.itemName, data.name, "Leftovers");
      const cookedAt = toDate(data.cookedAt || data.packedAt || new Date());
      const shelfLifeDays = safeNum(data.shelfLifeDays, 4);
      const useBy = computeUseBy({
        packedAt: cookedAt,
        shelfLifeDays,
        useBy: data.useBy,
      });
      const container = pickFirst(data.container, data.bin, "");
      const qrValue =
        pickFirst(data.qrValue, "") ||
        `SSA:leftovers|${itemName}|cooked:${formatDateISO(
          cookedAt
        )}|useBy:${formatDateISO(useBy)}`;

      return { itemName, cookedAt, useBy, container, qrValue };
    },
    buildLayout(fields, opts) {
      const title = truncateLine(fields.itemName, 24);
      const subtitle = fields.container
        ? truncateLine(fields.container, 24)
        : "Reheat + eat";
      const rightTop = "LEFT";
      const rightBottom = "";

      const m = opts.marginIn;
      const w = opts.labelSize.widthIn - m * 2;

      return [
        ...mkHeaderBlocks({ title, subtitle, rightTop, rightBottom, opts }),
        ...mkQrBlock({ value: fields.qrValue, opts }),
        {
          type: "text",
          x: m,
          y: m + 0.56,
          w: w * 0.68,
          h: 0.16,
          size: "normal",
          value: `Cooked: ${formatDateShort(fields.cookedAt)}`,
        },
        {
          type: "text",
          x: m,
          y: m + 0.74,
          w: w * 0.68,
          h: 0.16,
          size: "normal",
          bold: true,
          value: fields.useBy
            ? `Use By: ${formatDateShort(fields.useBy)}`
            : "Use By: —",
        },
      ].filter(Boolean);
    },
  },
});

/* ------------------------------ renderer utils ------------------------------ */

function inchesToDots(inches, dpi) {
  return Math.round(safeNum(inches, 0) * safeNum(dpi, DEFAULT_DPI));
}

function resolveFontSizeInches(sizeKey, font) {
  if (!sizeKey) return font.normal;
  if (typeof sizeKey === "number") return sizeKey;
  const key = String(sizeKey).toLowerCase();
  return font[key] || font.normal;
}

function splitToLines(text, maxCharsPerLine) {
  const s = sanitizeText(text, { maxLen: 1000, keepNewlines: false });
  if (!s) return [];
  if (!maxCharsPerLine || maxCharsPerLine <= 0) return [s];

  const words = s.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (next.length <= maxCharsPerLine) {
      cur = next;
    } else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/* ------------------------------ ZPL renderer ------------------------------ */

function renderZpl(job, renderOpts) {
  const printer = renderOpts?.printer || {};
  const dpi = safeNum(printer.dpi, job.options.dpi || DEFAULT_DPI);
  const size = printer.size || job.options.labelSize || DEFAULT_SIZE;

  const widthDots = inchesToDots(size.widthIn, dpi);
  const heightDots = inchesToDots(size.heightIn, dpi);

  // ZPL command helpers
  const z = [];
  z.push("^XA");
  z.push(`^PW${widthDots}`);
  z.push(`^LL${heightDots}`);
  // darkness/speed may be set by caller; keep neutral

  const font = job.options.font || baseDefaults().font;

  for (const b of job.layout) {
    if (!b) continue;

    if (b.type === "hr") {
      const x = inchesToDots(b.x, dpi);
      const y = inchesToDots(b.y, dpi);
      const w = inchesToDots(b.w, dpi);
      const t = Math.max(1, inchesToDots(b.thickness || 0.01, dpi));
      z.push(`^FO${x},${y}^GB${w},${t},${t}^FS`);
      continue;
    }

    if (b.type === "box") {
      const x = inchesToDots(b.x, dpi);
      const y = inchesToDots(b.y, dpi);
      const w = inchesToDots(b.w, dpi);
      const h = inchesToDots(b.h, dpi);
      const t = Math.max(1, inchesToDots(b.thickness || 0.01, dpi));
      z.push(`^FO${x},${y}^GB${w},${h},${t}^FS`);
      continue;
    }

    if (b.type === "qr") {
      const x = inchesToDots(b.x, dpi);
      const y = inchesToDots(b.y, dpi);
      // module size in dots (1-10 typical). Map inches to dots then scale.
      const sizeDots = inchesToDots(b.size || 0.55, dpi);
      const module = clamp(Math.round(sizeDots / 28), 3, 10); // conservative mapping
      const val = sanitizeText(b.value, { maxLen: 240 });
      // ^BQN:2, model 2, magnification
      z.push(`^FO${x},${y}^BQN,2,${module}`);
      z.push(`^FDLA,${val}^FS`);
      continue;
    }

    if (b.type === "barcode") {
      const x = inchesToDots(b.x, dpi);
      const y = inchesToDots(b.y, dpi);
      const h = inchesToDots(b.height || 0.28, dpi);
      const val = sanitizeText(b.value, { maxLen: 60 });
      // Code128
      z.push(`^FO${x},${y}^BCN,${h},N,N,N`);
      z.push(`^FD${val}^FS`);
      continue;
    }

    if (b.type === "text") {
      const x = inchesToDots(b.x, dpi);
      const y = inchesToDots(b.y, dpi);
      const wDots = inchesToDots(b.w || 1, dpi);

      const sizeIn = resolveFontSizeInches(b.size, font);
      const hDots = Math.max(12, inchesToDots(sizeIn, dpi)); // font height
      const wChar = Math.max(8, Math.round(hDots * 0.6)); // rough char width

      const maxChars = Math.max(5, Math.floor(wDots / wChar));
      const lines = splitToLines(b.value || "", maxChars).slice(0, 3); // keep ZPL safe

      // Alignment: left/center/right using ^FB
      // ^FBw,h,lines,space,justification
      const just = String(b.align || "left").toLowerCase();
      const j = just === "center" ? "C" : just === "right" ? "R" : "L";
      const maxLines = Math.max(1, Math.min(3, lines.length || 1));

      // Use ^A0N for scalable font.
      z.push(
        `^FO${x},${y}^A0N,${hDots},${Math.round(
          hDots * 0.85
        )}^FB${wDots},${maxLines},0,0,${j}`
      );
      z.push(`^FD${sanitizeText(lines.join(" "), { maxLen: 240 })}^FS`);
      continue;
    }
  }

  z.push("^XZ");
  return z.join("\n");
}

/* ------------------------------ HTML renderer ------------------------------ */

function renderHtml(job, renderOpts) {
  const printer = renderOpts?.printer || {};
  const size = printer.size || job.options.labelSize || DEFAULT_SIZE;
  const marginIn = safeNum(job.options.marginIn, DEFAULT_MARGIN);
  const font = job.options.font || baseDefaults().font;

  // Convert inches to CSS pixels (96 dpi) for layout preview/print
  const pxPerIn = 96;
  const W = Math.round(size.widthIn * pxPerIn);
  const H = Math.round(size.heightIn * pxPerIn);

  const style = `
  <style>
    .ssa-label-sheet { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
    .ssa-label {
      position: relative;
      width: ${W}px;
      height: ${H}px;
      border: 1px solid rgba(0,0,0,0.12);
      border-radius: 10px;
      box-sizing: border-box;
      overflow: hidden;
      background: #fff;
    }
    .ssa-label * { box-sizing: border-box; }
    .ssa-label .t { position:absolute; white-space: nowrap; overflow:hidden; text-overflow: ellipsis; }
    .ssa-label .hr { position:absolute; background: rgba(0,0,0,0.65); }
    .ssa-label .bx { position:absolute; border: 1px solid rgba(0,0,0,0.65); }
    .ssa-label .qr {
      position:absolute;
      display:flex;
      align-items:center;
      justify-content:center;
      border: 1px solid rgba(0,0,0,0.2);
      border-radius: 8px;
      background: #fff;
      font-size: 10px;
      color: rgba(0,0,0,0.55);
      text-align:center;
      padding: 6px;
      line-height: 1.15;
    }
    .ssa-label .barcode {
      position:absolute;
      display:flex;
      align-items:flex-end;
      justify-content:center;
      border: 1px solid rgba(0,0,0,0.15);
      border-radius: 8px;
      background: #fff;
      padding: 6px;
      font-size: 10px;
      color: rgba(0,0,0,0.6);
    }
    @media print {
      .ssa-label { border: none; border-radius: 0; }
    }
  </style>`.trim();

  const marginPx = marginIn * pxPerIn;

  function sizePx(key) {
    const inches = resolveFontSizeInches(key, font);
    return Math.max(10, Math.round(inches * pxPerIn));
  }

  const blocks = job.layout
    .filter(Boolean)
    .map((b) => {
      if (b.type === "hr") {
        const x = Math.round(b.x * pxPerIn);
        const y = Math.round(b.y * pxPerIn);
        const w = Math.round(b.w * pxPerIn);
        const t = Math.max(1, Math.round((b.thickness || 0.01) * pxPerIn));
        return `<div class="hr" style="left:${x}px;top:${y}px;width:${w}px;height:${t}px;"></div>`;
      }
      if (b.type === "box") {
        const x = Math.round(b.x * pxPerIn);
        const y = Math.round(b.y * pxPerIn);
        const w = Math.round(b.w * pxPerIn);
        const h = Math.round(b.h * pxPerIn);
        const t = Math.max(1, Math.round((b.thickness || 0.01) * pxPerIn));
        return `<div class="bx" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-width:${t}px;"></div>`;
      }
      if (b.type === "qr") {
        const x = Math.round(b.x * pxPerIn);
        const y = Math.round(b.y * pxPerIn);
        const s = Math.round((b.size || 0.55) * pxPerIn);
        // NOTE: This is a placeholder preview (not a real QR) to remain dependency-free.
        // For real QR codes, plug in an adapter in your UI layer.
        const val = sanitizeText(b.value, { maxLen: 120 });
        return `<div class="qr" style="left:${x}px;top:${y}px;width:${s}px;height:${s}px;">
          <div><strong>QR</strong><br/><span>${val}</span></div>
        </div>`;
      }
      if (b.type === "barcode") {
        const x = Math.round(b.x * pxPerIn);
        const y = Math.round(b.y * pxPerIn);
        const h = Math.round((b.height || 0.28) * pxPerIn);
        const val = sanitizeText(b.value, { maxLen: 60 });
        return `<div class="barcode" style="left:${x}px;top:${y}px;width:${Math.round(
          W - marginPx * 2
        )}px;height:${h}px;">
          <div><strong>BAR</strong> ${val}</div>
        </div>`;
      }
      if (b.type === "text") {
        const x = Math.round(b.x * pxPerIn);
        const y = Math.round(b.y * pxPerIn);
        const w = Math.round((b.w || size.widthIn - marginIn * 2) * pxPerIn);
        const fs = sizePx(b.size || "normal");
        const align = (b.align || "left").toLowerCase();
        const fw = b.bold ? 800 : 600;
        return `<div class="t" style="
          left:${x}px;top:${y}px;width:${w}px;
          font-size:${fs}px;font-weight:${fw};text-align:${align};
        ">${escapeHtml(truncateLine(b.value || "", 120))}</div>`;
      }
      return "";
    })
    .join("\n");

  return `${style}
  <div class="ssa-label-sheet">
    <div class="ssa-label" style="padding:${Math.round(marginPx)}px;">
      ${blocks}
    </div>
  </div>`;
}

function escapeHtml(s) {
  const str = String(s ?? "");
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* ------------------------------ engine ------------------------------ */

function normalizeLabelRequest(req) {
  const r = req || {};
  const type = String(r.type || r.labelType || "generic").trim();
  const normalizedType = LABEL_TYPES.includes(type) ? type : "generic";

  return {
    id: r.id || makeLabelId("LBL"),
    type: normalizedType,
    templateId:
      String(r.templateId || r.template || normalizedType).trim() ||
      normalizedType,
    data: r.data || {},
    meta: r.meta || {},
    createdAt: r.createdAt || toISODateTimeLocal(new Date()),
  };
}

function normalizeRenderOptions(opts, jobOptions) {
  const o = opts || {};
  const renderer = String(o.renderer || DEFAULT_RENDERER).toLowerCase();
  const finalRenderer = renderer === "zpl" ? "zpl" : "html";

  const printer = o.printer || {};
  const dpi = safeNum(printer.dpi, jobOptions?.dpi || DEFAULT_DPI);
  const size = printer.size || jobOptions?.labelSize || DEFAULT_SIZE;

  return {
    renderer: finalRenderer,
    printer: {
      dpi,
      size: {
        widthIn: safeNum(size.widthIn, DEFAULT_SIZE.widthIn),
        heightIn: safeNum(size.heightIn, DEFAULT_SIZE.heightIn),
      },
    },
  };
}

export function createLabelEngine(engineOpts = {}) {
  const opts = engineOpts || {};
  const eventBus = opts.eventBus || null;

  // templates registry
  const templates = new Map();
  for (const [k, tpl] of Object.entries(DEFAULT_TEMPLATES))
    templates.set(k, tpl);
  for (const tpl of ensureArray(opts.templates)) {
    if (tpl?.id) templates.set(tpl.id, tpl);
  }

  // optional overrides by type/templateId
  const templateOverrides = opts.templateOverrides || {}; // { [id]: { defaults?, buildLayout?, resolveFields? } }

  function listTemplates() {
    return Array.from(templates.values()).map((t) => ({
      id: t.id,
      type: t.type,
      hasDefaults: !!t.defaults,
    }));
  }

  function registerTemplate(tpl) {
    if (!tpl || !tpl.id)
      throw new Error("registerTemplate(tpl): tpl.id is required");
    templates.set(tpl.id, tpl);
  }

  function getTemplate(id) {
    const key = String(id || "").trim();
    const tpl = templates.get(key) || templates.get("generic");
    const ov = templateOverrides?.[key] || null;
    if (!ov) return tpl;

    // Merge defaults; allow override functions
    return {
      ...tpl,
      ...ov,
      defaults: { ...(tpl.defaults || {}), ...(ov.defaults || {}) },
      resolveFields: ov.resolveFields || tpl.resolveFields,
      buildLayout: ov.buildLayout || tpl.buildLayout,
    };
  }

  function buildLabel(request, buildOpts = {}) {
    const req = normalizeLabelRequest(request);

    const tpl = getTemplate(req.templateId || req.type);
    const defaults = tpl.defaults || baseDefaults();
    const jobOptions = {
      ...baseDefaults(),
      ...defaults,
      ...(buildOpts.options || {}),
      labelSize: {
        ...(baseDefaults().labelSize || DEFAULT_SIZE),
        ...(defaults.labelSize || {}),
        ...(buildOpts.options?.labelSize || {}),
      },
      font: {
        ...(baseDefaults().font || {}),
        ...(defaults.font || {}),
        ...(buildOpts.options?.font || {}),
      },
    };

    const fields = tpl.resolveFields
      ? tpl.resolveFields(req.data, { request: req, options: jobOptions })
      : req.data;

    // Ensure computed standard fields exist if template wants them
    const computed = {
      labelId: req.id,
      labelType: req.type,
      templateId: tpl.id,
      createdAt: req.createdAt,
      ...fields,
    };

    const layout = tpl.buildLayout
      ? tpl.buildLayout(computed, jobOptions, { request: req })
      : [];

    const job = {
      id: req.id,
      type: req.type,
      templateId: tpl.id,
      createdAt: req.createdAt,
      options: jobOptions,
      fields: computed,
      layout: ensureArray(layout).filter(Boolean),
      meta: {
        ...req.meta,
        // trace
        engine: "labelEngine",
        template: tpl.id,
      },
    };

    // basic validation warnings
    const warnings = [];
    if (!job.layout.length)
      warnings.push({
        code: "empty_layout",
        message: `Template '${tpl.id}' produced no layout blocks.`,
      });
    if (!job.fields)
      warnings.push({
        code: "missing_fields",
        message: `Template '${tpl.id}' produced no fields.`,
      });

    job.warnings = warnings;

    if (eventBus?.emit) {
      eventBus.emit(
        "labels.built",
        { labelId: job.id, type: job.type, templateId: job.templateId },
        { source: "labelEngine" }
      );
    }

    return job;
  }

  function buildBatch(requests, buildOpts = {}) {
    const list = ensureArray(requests).map((r) => buildLabel(r, buildOpts));
    if (eventBus?.emit) {
      eventBus.emit(
        "labels.batch.built",
        { count: list.length },
        { source: "labelEngine" }
      );
    }
    return list;
  }

  function render(jobOrJobs, renderOpts = {}) {
    const jobs = ensureArray(jobOrJobs);
    if (!jobs.length) return "";

    // If multiple labels, return concatenated output:
    // - ZPL: concatenate multiple ^XA...^XZ blocks
    // - HTML: wrap each label in a page flow
    const first = jobs[0];
    const ro = normalizeRenderOptions(renderOpts, first?.options);

    if (ro.renderer === "zpl") {
      const out = jobs.map((j) => renderZpl(j, ro)).join("\n");
      if (eventBus?.emit)
        eventBus.emit(
          "labels.rendered",
          { renderer: "zpl", count: jobs.length },
          { source: "labelEngine" }
        );
      return out;
    }

    // HTML
    const html = jobs
      .map((j) => {
        const labelHtml = renderHtml(j, ro);
        // lightweight separator for print pages
        return `<div style="page-break-inside:avoid; margin:12px;">${labelHtml}</div>`;
      })
      .join("\n");

    if (eventBus?.emit)
      eventBus.emit(
        "labels.rendered",
        { renderer: "html", count: jobs.length },
        { source: "labelEngine" }
      );

    return `<div>${html}</div>`;
  }

  function toZpl(jobOrJobs, printer) {
    return render(jobOrJobs, { renderer: "zpl", printer });
  }

  function toHtml(jobOrJobs, printer) {
    return render(jobOrJobs, { renderer: "html", printer });
  }

  return {
    // templates
    listTemplates,
    registerTemplate,
    getTemplate,

    // jobs
    buildLabel,
    buildBatch,

    // render
    render,
    toZpl,
    toHtml,
  };
}

export default createLabelEngine;
