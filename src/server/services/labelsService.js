// C:\Users\larho\suka-smart-assistant\src\server\services\labelsService.js
//
// Suka Smart Assistant — Labels Service (Dynamic)
//
// Purpose:
//   Dynamic label templates + PDF generation for inventory items, preserved jars,
//   freezer packs, batch cooking sessions, garden harvests, etc. Returns
//   "visible-draft" payloads for preview/edit, and final PDFs (buffer or file).
//
// Highlights aligned with project chats:
//   • Persisted templates (local JSON store), plus Avery-style presets
//   • Mustache {{variable}} interpolation with sensible defaults
//   • Optional QR codes (Suka deep-links) and barcodes (Code128/EAN/UPC)
//   • Draft builders for Cooking Batch Sessions, Garden Harvests, Inventory
//   • Date helpers (madeOn / frozenOn / packedOn / bestBy) & safety rounding
//   • ESM module (mirrors other services) with lazy adapters later if needed
//
// Deps (install in /server):
//   npm i pdf-lib qrcode bwip-js mustache dayjs uuid
//
// NOTE: This service uses only StandardFonts (Helvetica/Bold) for reliability.
//       You can extend with embedded TTFs later if you add a font loader.
//
// ------------------------------------------------------------------------------

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import Mustache from "mustache";
import dayjs from "dayjs";
import QRCode from "qrcode";
import bwipjs from "bwip-js";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// ---------- Paths & DB bootstrap ---------------------------------------------

const DATA_DIR = path.resolve(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "labels.json");
const OUTPUT_DIR = path.resolve(process.cwd(), "tmp", "labels");

function inchesToPoints(inches) {
  return inches * 72;
}

async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
}

async function init() {
  await ensureDirs();
  try {
    await fsp.access(DB_PATH, fs.constants.F_OK);
  } catch {
    const seed = { templates: [], presets: {}, updatedAt: new Date().toISOString() };
    await fsp.writeFile(DB_PATH, JSON.stringify(seed, null, 2), "utf8");
  }
  return true;
}

async function readDB() {
  await init();
  const raw = await fsp.readFile(DB_PATH, "utf8");
  return JSON.parse(raw || '{"templates": [], "presets": {}}');
}

async function writeDB(db) {
  db.updatedAt = new Date().toISOString();
  await fsp.writeFile(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

// ---------- Template CRUD -----------------------------------------------------

/**
 * Template shape (example):
 * {
 *   id: "uuid",
 *   name: "Avery 5160 Jar Label",
 *   page: { size: "LETTER", widthIn: 8.5, heightIn: 11, marginIn: 0.25, gutterIn: 0.125, background?: null|{type:"grid"|"image",...} },
 *   grid: { rows: 10, cols: 3, labelWidthIn: 2.625, labelHeightIn: 1, bleedIn: 0 },
 *   defaults: { fontSize: 9, font: "Helvetica", color: "#000000", lineHeight: 1.2 },
 *   fields: [
 *     { key: "title", x: 10, y: 20, fontSize: 12, bold: true, value: "{{productName}}", maxWidth?: 180 },
 *     { key: "subtitle", x: 10, y: 8, fontSize: 8, value: "Batch {{batchCode}} • {{packedOn}}" }
 *   ],
 *   qr: { enabled: true, size: 64, x: 145, y: 8, value: "{{qrPayload}}" },
 *   barcode: { enabled: false, type: "code128", width: 140, height: 24, x: 10, y: 2, value: "{{sku}}" }
 * }
 */

export async function listLabelTemplates() {
  const db = await readDB();
  return db.templates;
}

export async function getLabelTemplate(id) {
  const db = await readDB();
  return db.templates.find((t) => t.id === id) || null;
}

export async function upsertLabelTemplate(template) {
  const db = await readDB();
  const now = new Date().toISOString();

  const rec = {
    id: template.id || uuidv4(),
    name: template.name || "Label Template",
    page: template.page || {},
    grid: template.grid || {},
    defaults: template.defaults || {},
    fields: Array.isArray(template.fields) ? template.fields : [],
    qr: template.qr || { enabled: false },
    barcode: template.barcode || { enabled: false },
    createdAt: template.createdAt || now,
    updatedAt: now,
  };

  const idx = db.templates.findIndex((t) => t.id === rec.id);
  if (idx >= 0) db.templates[idx] = rec;
  else db.templates.push(rec);

  await writeDB(db);
  return rec;
}

export async function deleteLabelTemplate(id) {
  const db = await readDB();
  const before = db.templates.length;
  db.templates = db.templates.filter((t) => t.id !== id);
  const deleted = db.templates.length !== before;
  await writeDB(db);
  return deleted;
}

// ---------- Presets (Avery etc.) ---------------------------------------------

const PAGE_PRESETS = {
  LETTER: { widthIn: 8.5, heightIn: 11 },
  A4: { widthIn: 8.27, heightIn: 11.69 },
};

// Common Avery grid presets used in pantry/jar labels
const GRID_PRESETS = {
  "avery-5160": { rows: 10, cols: 3, labelWidthIn: 2.625, labelHeightIn: 1, marginIn: 0.25, gutterIn: 0.125 },
  "avery-8160": { rows: 10, cols: 3, labelWidthIn: 2.625, labelHeightIn: 1, marginIn: 0.25, gutterIn: 0.125 },
  "avery-6521": { rows: 15, cols: 5, labelWidthIn: 1.75, labelHeightIn: 0.5, marginIn: 0.25, gutterIn: 0.125 },
  "square-2in-12up": { rows: 6, cols: 2, labelWidthIn: 3.5, labelHeightIn: 3.5, marginIn: 0.25, gutterIn: 0.25 },
};

export async function listPresets() {
  // Expose a combined preset view (hardcoded + DB-stored if you ever add)
  const db = await readDB();
  return { page: PAGE_PRESETS, grid: { ...GRID_PRESETS, ...(db.presets?.grid || {}) } };
}

// ---------- Rendering helpers -------------------------------------------------

function parseHexColor(hex, fallback = "#000000") {
  const h = (hex || fallback).replace("#", "");
  if (![3, 6].includes(h.length)) return rgb(0, 0, 0);
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  return rgb(r, g, b);
}

async function makeQRCodePngBuffer(text) {
  return QRCode.toBuffer(text || "", { errorCorrectionLevel: "M", type: "png", margin: 0 });
}

async function makeBarcodePngBuffer(value, type = "code128", height = 30) {
  return new Promise((resolve, reject) => {
    bwipjs.toBuffer(
      {
        bcid: type,
        text: value || "",
        scale: 2,
        height,
        includetext: false,
        paddingwidth: 0,
        paddingheight: 0,
        backgroundcolor: "FFFFFF",
      },
      (err, png) => (err ? reject(err) : resolve(png))
    );
  });
}

// ---------- PDF generation ----------------------------------------------------

async function renderLabelOnPage(pdf, page, fonts, template, data, originX, originY, labelW, labelH, { debugBoxes } = {}) {
  const color = parseHexColor(template.defaults?.color || "#000000");
  const fontSizeDefault = template.defaults?.fontSize || 9;
  const lineHeight = (template.defaults?.lineHeight || 1.2) * (fontSizeDefault || 9);
  const textFont = fonts[template.defaults?.font || "Helvetica"] || fonts.Helvetica;

  if (debugBoxes) {
    page.drawRectangle({
      x: originX,
      y: originY,
      width: labelW,
      height: labelH,
      borderColor: rgb(0.8, 0.2, 0.2),
      borderWidth: 0.5,
    });
  }

  // Text fields
  for (const field of template.fields || []) {
    const valueTmpl = field.value ?? `{{${field.key}}}`;
    let rendered = Mustache.render(valueTmpl, data);
    if (!rendered) continue;

    const font = field.bold && fonts.HelveticaBold ? fonts.HelveticaBold : textFont;
    const size = field.fontSize || fontSizeDefault;
    const x = originX + (field.x || 0);
    const y = originY + (field.y || 0);

    // Truncate if maxWidth is set and text is too wide (simple ellipsis)
    const maxWidth = field.maxWidth || undefined;
    if (maxWidth) {
      const width = font.widthOfTextAtSize(rendered, size);
      if (width > maxWidth) {
        while (rendered.length && font.widthOfTextAtSize(`${rendered}…`, size) > maxWidth) {
          rendered = rendered.slice(0, -1);
        }
        rendered = `${rendered}…`;
      }
    }

    page.drawText(rendered, { x, y, size, font, color, lineHeight, maxWidth });
  }

  // QR
  if (template.qr?.enabled) {
    const qrValue = Mustache.render(template.qr.value || "", data);
    if (qrValue) {
      const qrBuf = await makeQRCodePngBuffer(qrValue);
      const qrImg = await pdf.embedPng(qrBuf);
      const size = template.qr.size || 64;
      const x = originX + (template.qr.x || 0);
      const y = originY + (template.qr.y || 0);
      page.drawImage(qrImg, { x, y, width: size, height: size });
    }
  }

  // Barcode
  if (template.barcode?.enabled) {
    const codeVal = Mustache.render(template.barcode.value || "", data);
    if (codeVal) {
      const bType = template.barcode.type || "code128";
      const bHeight = template.barcode.height || 24;
      const bcBuf = await makeBarcodePngBuffer(codeVal, bType, bHeight);
      const bcImg = await pdf.embedPng(bcBuf);
      const w = template.barcode.width || 140;
      const x = originX + (template.barcode.x || 0);
      const y = originY + (template.barcode.y || 0);
      page.drawImage(bcImg, { x, y, width: w, height: template.barcode.height || 24 });
    }
  }
}

async function generateLabelSheetPDF({ template, items, options = {} }) {
  const pagePreset = PAGE_PRESETS[template.page?.size || "LETTER"] || PAGE_PRESETS.LETTER;
  const pageWidthPt = inchesToPoints(template.page?.widthIn || pagePreset.widthIn);
  const pageHeightPt = inchesToPoints(template.page?.heightIn || pagePreset.heightIn);

  const marginIn = template.page?.marginIn ?? GRID_PRESETS?.[template.preset || ""]?.marginIn ?? 0.25;
  const gutterIn = template.page?.gutterIn ?? GRID_PRESETS?.[template.preset || ""]?.gutterIn ?? 0.125;

  const rows = template.grid?.rows ?? GRID_PRESETS?.[template.preset || ""]?.rows ?? 10;
  const cols = template.grid?.cols ?? GRID_PRESETS?.[template.preset || ""]?.cols ?? 3;

  const labelWIn =
    template.grid?.labelWidthIn ??
    GRID_PRESETS?.[template.preset || ""]?.labelWidthIn ??
    (pagePreset.widthIn - 2 * marginIn - (cols - 1) * gutterIn) / cols;

  const labelHIn =
    template.grid?.labelHeightIn ??
    GRID_PRESETS?.[template.preset || ""]?.labelHeightIn ??
    (pagePreset.heightIn - 2 * marginIn - (rows - 1) * gutterIn) / rows;

  const labelW = inchesToPoints(labelWIn);
  const labelH = inchesToPoints(labelHIn);
  const margin = inchesToPoints(marginIn);
  const gutter = inchesToPoints(gutterIn);

  const doc = await PDFDocument.create();

  // Fonts
  const Helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const HelveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fonts = { Helvetica, HelveticaBold };

  // Page
  let page = doc.addPage([pageWidthPt, pageHeightPt]);
  let cellIndex = 0;

  // Normalize dates per row
  const normalized = items.map((it) => ({
    ...it,
    now: dayjs().format("YYYY-MM-DD"),
    madeOn: it.madeOn ? dayjs(it.madeOn).format("YYYY-MM-DD") : undefined,
    packedOn: it.packedOn ? dayjs(it.packedOn).format("YYYY-MM-DD") : undefined,
    frozenOn: it.frozenOn ? dayjs(it.frozenOn).format("YYYY-MM-DD") : undefined,
    bestBy: it.bestBy ? dayjs(it.bestBy).format("YYYY-MM-DD") : undefined,
  }));

  for (const data of normalized) {
    const row = Math.floor(cellIndex / cols) % rows;
    const col = cellIndex % cols;

    // New page every grid fill
    if (cellIndex > 0 && cellIndex % (rows * cols) === 0) {
      page = doc.addPage([pageWidthPt, pageHeightPt]);
    }

    const originX = margin + col * (labelW + gutter);
    const originY = pageHeightPt - margin - (row + 1) * labelH - row * gutter;

    await renderLabelOnPage(doc, page, fonts, template, data, originX, originY, labelW, labelH, {
      debugBoxes: options.debugBoxes,
    });

    cellIndex += 1;
  }

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}

// ---------- Public generation API --------------------------------------------

/**
 * Generate labels as a PDF from either:
 *  - a saved templateId, or
 *  - an inline template object
 *
 * @param {Object} args
 * @param {string} [args.templateId]
 * @param {Object} [args.inlineTemplate]
 * @param {Array<Object>} args.items - data rows (one row per label cell)
 * @param {Object} [args.options] - { debugBoxes, output: 'buffer' | 'file', filename }
 */
export async function generateLabels(args) {
  const { templateId, inlineTemplate, items = [], options = {} } = args || {};
  if (!templateId && !inlineTemplate) {
    throw new Error("labelsService.generateLabels: Provide templateId or inlineTemplate");
  }

  const template =
    inlineTemplate ||
    (await getLabelTemplate(templateId)) ||
    (() => {
      throw new Error(`labelsService: Template ${templateId} not found`);
    })();

  const pdfBuffer = await generateLabelSheetPDF({ template, items, options });

  if (options.output === "file") {
    const safeName =
      options.filename ||
      `${(template.name || "labels").replace(/[^\w-]/g, "_")}-${dayjs().format("YYYYMMDD-HHmmss")}.pdf`;
    const outPath = path.join(OUTPUT_DIR, safeName);
    await fsp.writeFile(outPath, pdfBuffer);
    return { filePath: outPath, count: items.length };
  }

  return { buffer: pdfBuffer, count: items.length };
}

export async function generateRepeatedLabel({ templateId, inlineTemplate, data, copies = 1, options = {} }) {
  const items = Array.from({ length: copies }, () => ({ ...data }));
  return generateLabels({ templateId, inlineTemplate, items, options });
}

// ---------- Draft builders (visible drafts for Suka UIs) ---------------------

/**
 * Build label rows from a Cooking Batch Session (artifacts.labels-like).
 * Accepts the session object from cookingService or a simplified array.
 */
export function buildDraftFromBatchSession(batchOrLabels, { qrBaseUrl = "suka://", userId } = {}) {
  const labels = Array.isArray(batchOrLabels)
    ? batchOrLabels
    : (batchOrLabels?.artifacts?.labels || []);

  return labels.map((l) => {
    const fields = l.fields || {};
    const id = l.id || uuidv4();
    const sku = fields.sku || slugify(fields.contents || fields.name || `batch-item-${id.slice(-4)}`);
    const qrPayload = buildQrDeepLink(qrBaseUrl, {
      type: "inventory",
      id: sku,
      userId,
      meta: { batchId: batchOrLabels?.id, labelId: id },
    });

    return {
      productName: fields.name || fields.contents || "",
      batchCode: fields.batchCode || "",
      packedOn: fields.madeOn || fields.packedOn || dayjs().format("YYYY-MM-DD"),
      bestBy: fields.useBy || fields.bestBy || "",
      notes: fields.storage || "",
      sku,
      qrPayload,
    };
  });
}

/**
 * Build label rows from Garden harvest entries.
 */
export function buildDraftFromHarvests(harvests = [], { qrBaseUrl = "suka://", userId } = {}) {
  return harvests.map((h) => {
    const name = h.cropName || h.cropKey || "Harvest";
    const batchCode = `harv-${(h.id || uuidv4()).slice(-6)}`;
    const sku = slugify(name);
    const qrPayload = buildQrDeepLink(qrBaseUrl, {
      type: "inventory",
      id: sku,
      userId,
      meta: { harvestId: h.id, planId: h.planId },
    });

    // Simple best-by rules: pantry 15mo; freezer 4mo; fridge 5d (UI can override)
    const made = dayjs(h.date || new Date());
    const best = made.add(5, "day").format("YYYY-MM-DD");

    return {
      productName: name,
      batchCode,
      packedOn: made.format("YYYY-MM-DD"),
      bestBy: best,
      notes: h.notes || "Refrigerated",
      sku,
      qrPayload,
    };
  });
}

/**
 * Build label rows for arbitrary inventory items.
 */
export function buildDraftFromInventory(items = [], { qrBaseUrl = "suka://", userId } = {}) {
  return items.map((it) => {
    const sku = it.sku || slugify(it.name || `item-${uuidv4().slice(-4)}`);
    const qrPayload = buildQrDeepLink(qrBaseUrl, { type: "inventory", id: sku, userId });

    return {
      productName: it.name || sku,
      batchCode: it.meta?.batchCode || it.meta?.lot || "",
      packedOn: it.meta?.madeOn || it.meta?.packedOn || dayjs().format("YYYY-MM-DD"),
      bestBy: it.meta?.bestBy || "",
      notes: it.meta?.storage || "",
      sku,
      qrPayload,
    };
  });
}

// ---------- Helpers: deep-links, slug, sample template -----------------------

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Build a QR deep link payload.
 * Default scheme "suka://entity/<type>/<id>?userId=..." (works offline),
 * can be swapped to https://app.suka/home?entity=... later if needed.
 */
export function buildQrDeepLink(base = "suka://", { type, id, userId, meta = {} } = {}) {
  const safeBase = base.endsWith("/") ? base : `${base}/`;
  const q = new URLSearchParams({ ...(userId ? { userId } : {}), ...(meta ? { meta: JSON.stringify(meta) } : {}) });
  return `${safeBase}entity/${encodeURIComponent(type || "unknown")}/${encodeURIComponent(id || "")}?${q.toString()}`;
}

// ---------- Sample template seeding ------------------------------------------

const SAMPLE_TEMPLATE = {
  name: "Jar / Pack Label (Letter 3x10 • Avery 5160)",
  preset: "avery-5160",
  page: { size: "LETTER" },
  grid: { rows: 10, cols: 3, labelWidthIn: 2.625, labelHeightIn: 1 },
  defaults: { font: "Helvetica", fontSize: 9, color: "#111111", lineHeight: 1.2 },
  fields: [
    { key: "title", value: "{{productName}}", x: 8, y: 56, fontSize: 12, bold: true, maxWidth: 168 },
    { key: "sub", value: "Batch {{batchCode}} • {{packedOn}}", x: 8, y: 42, fontSize: 8, maxWidth: 168 },
    { key: "notes", value: "{{notes}}", x: 8, y: 28, fontSize: 8, maxWidth: 168 },
    { key: "best", value: "Best by: {{bestBy}}", x: 8, y: 14, fontSize: 8, maxWidth: 168 },
  ],
  qr: { enabled: true, size: 40, x: 180, y: 8, value: "{{qrPayload}}" },
  barcode: { enabled: false, type: "code128", width: 120, height: 24, x: 8, y: 4, value: "{{sku}}" },
};

export async function ensureSampleTemplate() {
  const list = await listLabelTemplates();
  if (list.length === 0) {
    await upsertLabelTemplate(SAMPLE_TEMPLATE);
  }
}

// ---------- Default export (for dynamic import usage) ------------------------

const LabelsService = {
  // lifecycle
  init,
  ensureSampleTemplate,

  // presets
  listPresets,

  // templates
  listLabelTemplates,
  getLabelTemplate,
  upsertLabelTemplate,
  deleteLabelTemplate,

  // generation
  generateLabels,
  generateRepeatedLabel,

  // drafts
  buildDraftFromBatchSession,
  buildDraftFromHarvests,
  buildDraftFromInventory,

  // helpers
  buildQrDeepLink,
};

export default LabelsService;
