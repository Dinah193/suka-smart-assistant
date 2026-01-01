// src/services/labels/templates.js
/* eslint-disable no-console */

/**
 * Suka Smart Assistant — Labels Templates (strings + helpers)
 * --------------------------------------------------------------------
 * Goals:
 * 1) Clear IA: registry of label templates + compile/build helpers.
 * 2) Intuitive flow: preview → generate → print, with Undo and NBA.
 * 3) Consistency: emits design-system glue (toasts, empty, undo, NBA).
 * 4) Event-driven: listens to inventory updates; emits labels.generated.
 *
 * No external deps. Strings-in, strings-out. UI can render however.
 */

import {
  events,
  NAMES,
  buildEvent,
  emitEvent,
} from "@/services/events/contracts";

/* ──────────────────────────────────────────────────────────────
 * Storage (persist last batches for print/undo)
 * ────────────────────────────────────────────────────────────── */
const STORAGE_KEY = "suka.labels.batches.v1";

const storage = {
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  },
  save(batches) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(batches || []));
    } catch (e) {
      console.warn("[labels] storage save error", e);
    }
  },
  add(batch) {
    const all = storage.load();
    all.unshift(batch);
    storage.save(all.slice(0, 25)); // keep last 25 batches
  },
  remove(batchId) {
    const all = storage.load();
    const next = all.filter((b) => b.id !== batchId);
    storage.save(next);
  },
  get(batchId) {
    return storage.load().find((b) => b.id === batchId) || null;
  },
  latest() {
    return storage.load()[0] || null;
  },
};

/* ──────────────────────────────────────────────────────────────
 * Utilities
 * ────────────────────────────────────────────────────────────── */
const isStr = (v) => typeof v === "string";
const isNum = (v) => Number.isFinite(v);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const nowISO = () => new Date().toISOString();
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function pad(n, len = 2, ch = "0") {
  const s = String(n ?? "");
  if (s.length >= len) return s;
  return ch.repeat(len - s.length) + s;
}

function fmtDate(input, format = "YYYY-MM-DD") {
  // Minimal date formatter (local time). Supported tokens: YYYY, MM, DD, hh, mm
  const d = input instanceof Date ? input : new Date(input ?? Date.now());
  if (Number.isNaN(d.getTime())) return "";
  const map = {
    YYYY: String(d.getFullYear()),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    hh: pad(d.getHours()),
    mm: pad(d.getMinutes()),
  };
  return format.replace(/YYYY|MM|DD|hh|mm/g, (t) => map[t]);
}

/* ──────────────────────────────────────────────────────────────
 * Template Engine
 * Syntax: "Product: {{name|upper}} (SKU {{sku}})"
 * Filters: upper, lower, slug, date('YYYY-MM-DD'), pad(n), truncate(n)
 * ────────────────────────────────────────────────────────────── */

const FILTERS = {
  upper: (v) => String(v ?? "").toUpperCase(),
  lower: (v) => String(v ?? "").toLowerCase(),
  slug: (v) => slugify(v),
  pad: (v, arg) => pad(v, Number(arg ?? 2)),
  truncate: (v, arg) => {
    const n = clamp(Number(arg ?? 20), 1, 200);
    const s = String(v ?? "");
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  },
  date: (v, arg) => fmtDate(v, isStr(arg) ? arg : "YYYY-MM-DD"),
};

function applyFilters(value, pipes) {
  return pipes.reduce((acc, p) => {
    const [name, rawArg] = p;
    const arg = rawArg && rawArg.replace(/^['"]|['"]$/g, "");
    const f = FILTERS[name];
    try {
      return f ? f(acc, arg) : acc;
    } catch {
      return acc;
    }
  }, value);
}

/**
 * Compile a string template with {{placeholders|filters}}
 * @param {string} template
 * @param {Record<string, any>} data
 * @returns {string}
 */
export function compileString(template, data) {
  if (!isStr(template)) return "";
  return template.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
    const segments = String(expr).split("|").map((s) => s.trim());
    const key = segments.shift();
    const pipes = segments.map((seg) => {
      const m = seg.match(/^(\w+)(?:\((.*)\))?$/);
      if (!m) return [seg];
      const [, name, args] = m;
      const firstArg = (args || "").split(",")[0]?.trim();
      return [name, firstArg];
    });
    const raw = key?.split(".").reduce((acc, k) => (acc ? acc[k] : undefined), data) ?? "";
    return applyFilters(raw, pipes);
  });
}

/* ──────────────────────────────────────────────────────────────
 * Template Registry
 * ────────────────────────────────────────────────────────────── */

const REGISTRY = new Map();

/**
 * Register/override a label template.
 * @param {string} id e.g., "inventory/basic"
 * @param {{name:string, description?:string, content:string[], meta?:object}} def
 * content: array of lines; each may contain {{placeholders}}
 */
export function registerTemplate(id, def) {
  if (!isStr(id) || !id.includes("/")) {
    throw new Error(`[labels] invalid template id "${id}" (use "domain/name")`);
  }
  if (!isObj(def) || !Array.isArray(def.content)) {
    throw new Error(`[labels] invalid template def for "${id}"`);
  }
  REGISTRY.set(id, { ...def, id });
}

/** Return a template or null */
export function getTemplate(id) {
  return REGISTRY.get(id) || null;
}

/** List all templates */
export function listTemplates() {
  return Array.from(REGISTRY.values()).map(({ id, name, description, meta }) => ({
    id, name, description, meta,
  }));
}

/* Default templates (balanced for 2–3 lines on 1x2.625" labels) */
registerTemplate("inventory/basic", {
  name: "Inventory — Basic",
  description: "Name, SKU, location, and packed date.",
  content: [
    "{{name|truncate(28)}}",
    "SKU {{sku}} • {{location|upper}}",
    "Packed {{packedOn|date('YYYY-MM-DD')}}",
  ],
  meta: { maxLines: 3 },
});

registerTemplate("inventory/dateful", {
  name: "Inventory — Dateful",
  description: "Name + dates (packed/expiry) and qty.",
  content: [
    "{{name|truncate(28)}}  ×{{qty|pad(2)}}",
    "Packed {{packedOn|date('YYYY-MM-DD')}}",
    "Use by {{expiresOn|date('YYYY-MM-DD')}}",
  ],
  meta: { maxLines: 3 },
});

registerTemplate("inventory/compact", {
  name: "Inventory — Compact",
  description: "Max density for small labels.",
  content: [
    "{{name|truncate(22)}}",
    "SKU {{sku}} • {{qty}} • {{location|upper}}",
  ],
  meta: { maxLines: 2 },
});

registerTemplate("inventory/qr-payload", {
  name: "Inventory — QR Payload (text)",
  description: "Generates a single line payload for QR encoders.",
  content: [
    "INV|{{sku}}|{{name|truncate(60)}}|Q={{qty}}|P={{packedOn|date('YYYY-MM-DD')}}|E={{expiresOn|date('YYYY-MM-DD')}}|L={{location|slug}}",
  ],
  meta: { maxLines: 1, qr: true },
});

/* ──────────────────────────────────────────────────────────────
 * Compilation Helpers
 * ────────────────────────────────────────────────────────────── */

/**
 * Normalize an inventory item to data suitable for templates.
 * Accepts a 'recipe' or 'inventory' shape, tries to pick sensible fields.
 */
export function toLabelData(entity = {}, defaults = {}) {
  const name = entity.title || entity.name || defaults.name || "Unknown";
  const sku = entity.sku || entity.code || entity.id || defaults.sku || "SKU-NA";
  const qty = isNum(entity.qty) ? entity.qty : (isNum(entity.quantity) ? entity.quantity : (defaults.qty ?? 1));
  const location = entity.location || entity.bin || entity.area || defaults.location || "pantry";
  const packedOn = entity.packedOn || entity.createdAt || defaults.packedOn || nowISO();
  const expiresOn = entity.expiresOn || entity.bestBy || defaults.expiresOn || null;
  const household = defaults.household || "Household";

  return {
    name, sku, qty, location, packedOn, expiresOn, household,
    // pass through any additional props for custom placeholders
    ...entity,
  };
}

/**
 * Compile one label (array of strings) using a template id.
 * @returns {string[]} lines
 */
export function compileLabel(templateId, data) {
  const t = getTemplate(templateId);
  if (!t) throw new Error(`[labels] unknown template "${templateId}"`);
  return t.content.map((line) => compileString(line, data));
}

/**
 * Build a label record for UI/printing.
 * @returns {{lines:string[], payload?:string, meta:object, data:object}}
 */
export function buildLabelRecord(templateId, data) {
  const t = getTemplate(templateId);
  if (!t) throw new Error(`[labels] unknown template "${templateId}"`);
  const lines = t.content.map((line) => compileString(line, data));
  const payload = t.meta?.qr ? lines.join("\n") : undefined;
  return { lines, payload, meta: { ...t.meta, templateId }, data };
}

/* ──────────────────────────────────────────────────────────────
 * Empty states & Sheet estimation
 * ────────────────────────────────────────────────────────────── */

export function estimateSheetUsage(count, paper = "avery-5160") {
  // 5160 has 30 labels per letter sheet
  const perSheet = paper === "avery-8160" ? 30 : 30;
  const sheets = Math.ceil((Number(count) || 0) / perSheet);
  return { perSheet, sheets };
}

export function emitEmptyStateForLabels(context = "labels.generate") {
  events.emit(
    buildEvent(
      NAMES["ui.empty.presented"],
      {
        context,
        actions: [
          { label: "Open Inventory", eventName: NAMES["ia.route.navigated"], payload: { path: "/tier2/household/inventory" } },
          { label: "Scan Items",     eventName: NAMES["ia.route.navigated"], payload: { path: "/scan" } },
        ],
      },
      { source: "labels/templates" }
    )
  );
}

/* ──────────────────────────────────────────────────────────────
 * Batch Building + Emission (Undo + NBA)
 * ────────────────────────────────────────────────────────────── */

/**
 * Build a batch of labels from entities and a template.
 * @param {Array<object>} entities
 * @param {{templateId:string, defaults?:object, copies?:number, title?:string}} cfg
 * @returns {{ id:string, at:string, count:number, title:string, records:Array}}
 */
export function buildBatch(entities, cfg) {
  const items = Array.isArray(entities) ? entities : [];
  if (items.length === 0) {
    emitEmptyStateForLabels("labels.generate.empty");
    return {
      id: uid(), at: nowISO(), count: 0, title: cfg?.title || "Empty Batch", records: [],
    };
  }

  const templateId = cfg?.templateId || "inventory/basic";
  const copies = clamp(Number(cfg?.copies ?? 1), 1, 50);
  const defaults = cfg?.defaults || {};

  const records = [];
  for (const entity of items) {
    const data = toLabelData(entity, defaults);
    const rec = buildLabelRecord(templateId, data);
    for (let i = 0; i < copies; i++) records.push(rec);
  }

  const batch = {
    id: uid(),
    at: nowISO(),
    count: records.length,
    title: cfg?.title || `${records.length} label${records.length !== 1 ? "s" : ""}`,
    templateId,
    records,
  };

  return batch;
}

/**
 * Generate a batch, persist locally, and emit canonical + UI glue:
 * - Emits storehouse.labels.generated (canonical)
 * - Offers Undo (removes batch)
 * - Suggests NBA ("Print Labels")
 */
export function generateLabels(entities, cfg) {
  const batch = buildBatch(entities, cfg);
  if (batch.count === 0) return batch;

  storage.add(batch);

  // Emit canonical event (+ built-in Undo + NBA from contracts)
  const env = emitEvent(
    NAMES["storehouse.labels.generated"],
    { batchId: batch.id, count: batch.count },
    {
      source: "labels/templates",
      undo: {
        label: "Undo",
        handler: () => {
          storage.remove(batch.id);
          events.emit(
            buildEvent(
              NAMES["ui.toast.shown"],
              { variant: "info", title: "Labels removed", message: "The last label batch was undone." },
              { source: "labels/templates" }
            )
          );
        },
      },
      nextBestAction: {
        label: "Print Labels",
        hint: `Ready to print ${batch.count}`,
        route: "/tier2/household/inventory#labels-print",
      },
    }
  );

  // Helpful toast + sheet estimate
  const { sheets } = estimateSheetUsage(batch.count);
  events.emit(
    buildEvent(
      NAMES["ui.toast.shown"],
      { variant: "success", title: "Labels generated", message: `${batch.count} labels • ~${sheets} sheet(s)` },
      { source: "labels/templates" }
    )
  );

  return { ...batch, envelopeId: env.id };
}

/**
 * Preview only (does not persist or emit).
 * @returns {{ sample:Array<{lines:string[]}> , templateId:string }}
 */
export function previewLabels(entities, cfg) {
  const items = Array.isArray(entities) ? entities : [];
  const sample = (items.slice(0, 3)).map((e) => buildLabelRecord(cfg?.templateId || "inventory/basic", toLabelData(e, cfg?.defaults)));
  if (sample.length === 0) {
    emitEmptyStateForLabels("labels.preview.empty");
  }
  return { sample, templateId: cfg?.templateId || "inventory/basic" };
}

/* ──────────────────────────────────────────────────────────────
 * Event-driven Glue
 * - Nudge users to generate labels after inventory changes.
 * - Keep a small debounce to avoid thrash on bulk ops.
 * ────────────────────────────────────────────────────────────── */

(function wireGlue() {
  try {
    events.on(NAMES["inventory.updated"], ({ payload }) => {
      const diffs = payload?.diffs || [];
      if (!Array.isArray(diffs) || diffs.length === 0) return;

      // If there are net positive deltas, suggest labels; else, suggest grocery list.
      const added = diffs.some((d) => Number(d?.delta || 0) > 0);
      if (added) {
        events.emit(
          buildEvent(
            NAMES["ui.nba.suggested"],
            {
              label: "Generate Labels",
              hint: "Print/update storage labels",
              route: "/tier2/household/inventory#labels",
            },
            { source: "labels/templates" }
          )
        );
      }
    });
  } catch (e) {
    console.warn("[labels] glue wiring failed", e);
  }
})();

/* ──────────────────────────────────────────────────────────────
 * Public API
 * ────────────────────────────────────────────────────────────── */
export default {
  // Registry
  registerTemplate,
  getTemplate,
  listTemplates,

  // Compilation
  compileString,
  compileLabel,
  buildLabelRecord,
  toLabelData,

  // Batches
  buildBatch,
  generateLabels,
  previewLabels,

  // Utils
  estimateSheetUsage,
  emitEmptyStateForLabels,
};
