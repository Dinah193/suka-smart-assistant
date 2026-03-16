// src/services/mealplanning/mealPlanExports.js
// Exports for Meal Plans, Shopping, Batch Sessions, and Labels.
// Formats: ICS, CSV, Markdown, JSON, lightweight PDF (no hard deps).
// Designed to work in browser (download) and Node (write to /exports)

import { sabbathGuard } from "@/services/guardrails/sabbathGuard";
import { usePreferencesStore } from "@/store/PreferencesStore";
import { Recipes } from "@/store/RecipeStore";
import { BatchDrafts } from "@/store/BatchDraftStore";
import { logger } from "@/utils/logger";

/* ----------------------------------------------------------------------------
   Public API
---------------------------------------------------------------------------- */
export const mealPlanExports = {
  /**
   * Export a full meal plan.
   * format: "ics" | "csv:shopping" | "csv:plan" | "md" | "json" | "pdf:labels" | "pdf:summary"
   */
  async exportPlan({ plan, format, options = {} }) {
    if (!plan) throw new Error("Missing plan");
    const prefs = usePreferencesStore.getState?.() || {};
    const tz = options.timezone || prefs?.timezone || "America/New_York";

    switch (format) {
      case "ics": {
        const ics = buildPlanICS(plan, {
          tz,
          includeTimers: !!options.includeTimers,
        });
        return await saveFile({
          data: ics,
          filename: icsName(plan),
          mime: "text/calendar",
        });
      }
      case "csv:shopping": {
        const csv = buildShoppingCSV(plan, {
          passoverMode: !!prefs?.calendar?.passoverMode,
        });
        return await saveFile({
          data: csv,
          filename: shoppingName(plan),
          mime: "text/csv",
        });
      }
      case "csv:plan": {
        const csv = buildPlanCSV(plan);
        return await saveFile({
          data: csv,
          filename: `${fileSafe(plan)}-plan.csv`,
          mime: "text/csv",
        });
      }
      case "md": {
        const md = await buildPlanMarkdown(plan, { prefs });
        return await saveFile({
          data: md,
          filename: `${fileSafe(plan)}.md`,
          mime: "text/markdown",
        });
      }
      case "json": {
        const json = JSON.stringify(plan, null, 2);
        return await saveFile({
          data: json,
          filename: `${fileSafe(plan)}.json`,
          mime: "application/json",
        });
      }
      case "pdf:labels": {
        const blob = await buildLabelsPDF(plan, { prefs });
        return await saveBlob({
          blob,
          filename: `${fileSafe(plan)}-labels.pdf`,
        });
      }
      case "pdf:summary": {
        const blob = await buildPlanSummaryPDF(plan, { prefs });
        return await saveBlob({
          blob,
          filename: `${fileSafe(plan)}-summary.pdf`,
        });
      }
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  },

  /** Export a Batch Session draft as an ICS (multi-timer stitched to blocks). */
  async exportBatchICS(draftId, { timezone } = {}) {
    const prefs = usePreferencesStore.getState?.() || {};
    const tz = timezone || prefs?.timezone || "America/New_York";
    const draft = await BatchDrafts.getById(draftId);
    if (!draft) throw new Error("Batch draft not found");
    const ics = await buildBatchICS(draft, { tz });
    return await saveFile({
      data: ics,
      filename: `${fileSafe({ weekStartISO: draft.dateSuggested })}-batch.ics`,
      mime: "text/calendar",
    });
  },

  /** Quick helpers used by NBA buttons */
  async exportGroceryCSV(plan) {
    const prefs = usePreferencesStore.getState?.() || {};
    const csv = buildShoppingCSV(plan, {
      passoverMode: !!prefs?.calendar?.passoverMode,
    });
    return await saveFile({
      data: csv,
      filename: shoppingName(plan),
      mime: "text/csv",
    });
  },
  async exportMarkdown(plan) {
    const prefs = usePreferencesStore.getState?.() || {};
    const md = await buildPlanMarkdown(plan, { prefs });
    return await saveFile({
      data: md,
      filename: `${fileSafe(plan)}.md`,
      mime: "text/markdown",
    });
  },
};

/* ----------------------------------------------------------------------------
   Builders — ICS
---------------------------------------------------------------------------- */
function buildPlanICS(plan, { tz, includeTimers } = {}) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Suka Smart Assistant//Meal Plan//EN",
    `X-WR-CALNAME:Suka Meal Plan`,
    `X-WR-TIMEZONE:${tz}`,
  ];

  const sab = sabbathGuard?.window?.() || null;

  for (const day of plan.days) {
    for (const mk of ["breakfast", "lunch", "dinner", "snack"]) {
      const slot = day.meals[mk];
      if (!slot?.recipeId) continue;

      const start = toDateLocal(day.dateISO, mk);
      const end = new Date(start.getTime() + 60 * 60 * 1000); // 1-hour slot block
      const title = safeICS(`${cap(mk)}: ${resolveRecipeName(slot.recipeId)}`);

      const notes = [];
      if (slot.tags?.length) notes.push(`Tags: ${slot.tags.join(", ")}`);
      if (includeTimers && slot?.timers?.steps?.length) {
        notes.push("Timers:");
        slot.timers.steps.forEach((s) =>
          notes.push(`- ${s.label} (${s.minutes}m)`)
        );
      }
      if (sab && isWithin(start, sab.from, sab.to)) {
        notes.push("⛔ Sabbath window – keep cooking simple/low-touch.");
      }

      lines.push(
        ...eventBlock({
          tz,
          uid: `suka-${plan.id}-${day.dateISO}-${mk}`,
          title,
          start,
          end,
          description: notes.join("\\n"),
        })
      );
    }
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

async function buildBatchICS(draft, { tz }) {
  const recipes = await Recipes.all();
  const map = Object.fromEntries(recipes.map((r) => [r.id, r]));
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Suka Smart Assistant//Batch Session//EN",
    `X-WR-CALNAME:Suka Batch Session`,
    `X-WR-TIMEZONE:${tz}`,
  ];

  const baseStart = toDateLocal(draft.dateSuggested, "batch");
  let cursor = new Date(baseStart);

  for (const block of draft.timers || []) {
    const r = map[block.recipeId];
    const title = safeICS(`Batch: ${r?.title || "Recipe"}`);
    const minutes =
      (block.steps || []).reduce((a, b) => a + (b.minutes || 0), 0) || 45;
    const start = new Date(cursor);
    const end = new Date(cursor.getTime() + minutes * 60 * 1000);

    const desc = ["Steps:"]
      .concat((block.steps || []).map((s) => `- ${s.label} (${s.minutes}m)`))
      .join("\\n");

    lines.push(
      ...eventBlock({
        tz,
        uid: `suka-batch-${draft.id}-${block.recipeId}`,
        title,
        start,
        end,
        description: desc,
      })
    );

    cursor = new Date(end.getTime() + 10 * 60 * 1000); // 10 min buffer
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function eventBlock({ tz, uid, title, start, end, description }) {
  return [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${toICSDate(new Date())}`,
    `DTSTART;TZID=${tz}:${toICSDate(start)}`,
    `DTEND;TZID=${tz}:${toICSDate(end)}`,
    `SUMMARY:${title}`,
    ...(description ? foldICS(`DESCRIPTION:${description}`) : []),
    "END:VEVENT",
  ];
}

/* ----------------------------------------------------------------------------
   Builders — CSV
---------------------------------------------------------------------------- */
function buildShoppingCSV(plan, { passoverMode } = {}) {
  // Columns: Date, Meal, Item, Qty, Aisle, Notes
  const head = ["Date", "Meal", "Item", "Qty", "Aisle", "Notes"];
  const rows = [head];

  const restrictedTags = new Set(["chametz", "leaven", "leavening-agent"]);

  for (const day of plan.days) {
    for (const mk of ["breakfast", "lunch", "dinner", "snack"]) {
      const slot = day.meals[mk];
      if (!slot?.recipeId) continue;
      const r = resolveRecipe(slot.recipeId);
      if (!r?.ingredients) continue;

      for (const ing of r.ingredients) {
        // Respect Passover mode by tagging/flagging items with chametz-y tags
        const isChametz = (ing.tags || []).some((t) => restrictedTags.has(t));
        if (passoverMode && isChametz) continue;

        rows.push([
          day.dateISO,
          mk,
          csvSafe(ing.name || ""),
          csvSafe(scaleQty(ing.qty, slot.servings)),
          csvSafe(ing.aisle || ""),
          csvSafe(isChametz ? "Restricted during Passover" : ing.note || ""),
        ]);
      }
    }
  }
  return rows.map((r) => r.join(",")).join("\n");
}

function buildPlanCSV(plan) {
  // Grid style: Date, Breakfast, Lunch, Dinner, Snack
  const head = ["Date", "Breakfast", "Lunch", "Dinner", "Snack"];
  const rows = [head];

  for (const day of plan.days) {
    rows.push([
      day.dateISO,
      csvSafe(resolveRecipeName(day.meals.breakfast?.recipeId)),
      csvSafe(resolveRecipeName(day.meals.lunch?.recipeId)),
      csvSafe(resolveRecipeName(day.meals.dinner?.recipeId)),
      csvSafe(resolveRecipeName(day.meals.snack?.recipeId)),
    ]);
  }
  return rows.map((r) => r.join(",")).join("\n");
}

/* ----------------------------------------------------------------------------
   Builders — Markdown
---------------------------------------------------------------------------- */
async function buildPlanMarkdown(plan, { prefs } = {}) {
  const sab = sabbathGuard?.window?.() || null;

  const lines = [];
  lines.push(`# Weekly Meal Plan`);
  lines.push(`**Household:** ${prefs?.householdName || "—"}  `);
  lines.push(`**Week Starting:** ${plan.weekStartISO}`);
  if (prefs?.calendar?.passoverMode)
    lines.push(`> Passover mode is **ON** (chametz filtered).\n`);

  for (const d of plan.days) {
    lines.push(`\n## ${d.dateISO}`);
    for (const mk of ["breakfast", "lunch", "dinner", "snack"]) {
      const slot = d.meals[mk];
      const r = resolveRecipe(slot?.recipeId);
      if (!r) continue;

      lines.push(`**${cap(mk)}:** ${r.title || "—"}`);
      if (slot?.tags?.length) lines.push(`- _Tags:_ ${slot.tags.join(", ")}`);
      if (slot?.timers?.steps?.length) {
        lines.push(`- _Timers:_`);
        slot.timers.steps.forEach((s) =>
          lines.push(`  - ${s.label} (${s.minutes}m)`)
        );
      }
    }

    if (sab && isWithin(new Date(d.dateISO), sab.from, sab.to)) {
      lines.push(`\n> ⛔ **Sabbath** window — favor leftovers/simple reheats.`);
    }
  }

  // Grocery appendix
  lines.push(`\n---\n## Grocery List\n`);
  lines.push("- Group items by aisle when shopping.");
  const csv = buildShoppingCSV(plan, {
    passoverMode: !!prefs?.calendar?.passoverMode,
  });
  const parsed = parseCSV(csv);
  const body = parsed.slice(1); // without header
  const byAisle = {};
  body.forEach((r) => {
    const aisle = r[4] || "Other";
    (byAisle[aisle] ||= []).push(`${r[2]} — ${r[3]}`);
  });
  Object.keys(byAisle)
    .sort()
    .forEach((aisle) => {
      lines.push(`\n### ${aisle}`);
      byAisle[aisle].forEach((item) => lines.push(`- ${item}`));
    });

  return lines.join("\n");
}

/* ----------------------------------------------------------------------------
   Builders — Lightweight PDFs (labels & summary)
   (No external deps: we generate a simple PDF using a minimal PDF syntax.)
   If you later install jsPDF or PDFKit, you can swap implementations easily.
---------------------------------------------------------------------------- */
async function buildLabelsPDF(plan, { prefs } = {}) {
  const labels = [];

  for (const d of plan.days) {
    for (const mk of ["breakfast", "lunch", "dinner", "snack"]) {
      const slot = d.meals[mk];
      if (!slot?.recipeId) continue;
      const r = resolveRecipe(slot.recipeId);
      labels.push({
        title: r?.title || cap(mk),
        date: d.dateISO,
        meal: cap(mk),
        servings: slot.servings || 1,
        tags: (slot.tags || []).slice(0, 4).join(", "),
      });
    }
  }
  return minimalPdfFromText({
    title: `${prefs?.householdName || "Household"} — Meal Labels`,
    lines: labels.map(
      (l) =>
        `${l.date} • ${l.meal}\n${l.title}\nServings: ${l.servings}${
          l.tags ? `\nTags: ${l.tags}` : ""
        }`
    ),
  });
}

async function buildPlanSummaryPDF(plan, { prefs } = {}) {
  const lines = [];
  lines.push(`${prefs?.householdName || "Household"} — Weekly Meal Plan`);
  lines.push(`Week Starting: ${plan.weekStartISO}`);
  lines.push("");

  for (const d of plan.days) {
    lines.push(d.dateISO);
    for (const mk of ["breakfast", "lunch", "dinner", "snack"]) {
      const name = resolveRecipeName(d.meals[mk]?.recipeId);
      if (name) lines.push(`  - ${cap(mk)}: ${name}`);
    }
    lines.push("");
  }
  return minimalPdfFromText({ title: "Meal Plan Summary", lines });
}

/* ----------------------------------------------------------------------------
   Utilities — Minimal PDF generator (vector text only)
---------------------------------------------------------------------------- */
function minimalPdfFromText({ title, lines }) {
  // Very small PDF writer for text-only docs (each line on a new row).
  // NOTE: This is not fancy, but works reliably without deps.
  const fontSize = 12;
  const margin = 50;
  const lineHeight = 16;
  const pageWidth = 595; // A4 width pt
  const pageHeight = 842; // A4 height pt

  const content = [];
  let y = pageHeight - margin;

  const addLine = (txt) => {
    if (y < margin) {
      // new page
      content.push("ET", "Q", "q", "BT", `/F1 ${fontSize} Tf`, "50 792 Td");
      y = pageHeight - margin;
    }
    const escaped = txt.replace(/([()\\])/g, "\\$1");
    content.push(`1 0 0 1 ${margin} ${y} Tm (${escaped}) Tj`);
    y -= lineHeight;
  };

  // Header
  content.push("q", "BT", `/F1 ${fontSize} Tf`, "50 792 Td");
  addLine(title);
  addLine(" ");
  lines.forEach((l) => addLine(l));

  // PDF assembly
  const objects = [];
  const xref = [];
  const addObject = (str) => {
    const offset = objects.join("").length;
    xref.push(offset);
    objects.push(str);
  };

  const contentStream = `<< /Length ${
    content.join("\n").length
  } >>\nstream\n${content.join("\n")}\nendstream`;
  const fontObj =
    "2 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
  const contentsObj = `3 0 obj\n${contentStream}\nendobj\n`;
  const pageObj = `4 0 obj\n<< /Type /Page /Parent 1 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents 3 0 R /Resources << /Font << /F1 2 0 R >> >> >>\nendobj\n`;
  const pagesObj =
    "1 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n";
  const catalogObj = "5 0 obj\n<< /Type /Catalog /Pages 1 0 R >>\nendobj\n";

  // Order matters for xref offsets:
  addObject(pagesObj);
  addObject(fontObj);
  addObject(contentsObj);
  addObject(pageObj);
  addObject(catalogObj);

  // Build xref table
  let pdf = "%PDF-1.4\n" + objects.join("");
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${xref.length + 1}\n0000000000 65535 f \n`;
  for (let i = 0; i < xref.length; i++) {
    const off = (xref[i] + "%PDF-1.4\n".length).toString().padStart(10, "0");
    pdf += `${off} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${
    xref.length + 1
  } /Root 5 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new Blob([pdf], { type: "application/pdf" });
}

/* ----------------------------------------------------------------------------
   Helpers
---------------------------------------------------------------------------- */
function icsName(plan) {
  return `${fileSafe(plan)}.ics`;
}
function shoppingName(plan) {
  return `${fileSafe(plan)}-shopping.csv`;
}
function fileSafe(plan) {
  const start = plan.weekStartISO?.slice(0, 10) || "plan";
  return `mealplan-${start}`;
}
function cap(s) {
  return (s || "").charAt(0).toUpperCase() + (s || "").slice(1);
}

function toDateLocal(dateISO, bucket) {
  // breakfast: 08:00, lunch: 12:00, dinner: 18:00, snack: 15:00, batch: 09:00
  const d = new Date(`${dateISO}T00:00:00`);
  const map = { breakfast: 8, lunch: 12, dinner: 18, snack: 15, batch: 9 };
  const h = map[bucket] ?? 12;
  d.setHours(h, 0, 0, 0);
  return d;
}

function toICSDate(d) {
  const yyyy = d.getFullYear();
  const mm = `${d.getMonth() + 1}`.padStart(2, "0");
  const dd = `${d.getDate()}`.padStart(2, "0");
  const hh = `${d.getHours()}`.padStart(2, "0");
  const mi = `${d.getMinutes()}`.padStart(2, "0");
  const ss = `${d.getSeconds()}`.padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}`;
}

function foldICS(line) {
  // Fold long lines per RFC 5545 (75 octets); simple approach:
  const out = [];
  const max = 70;
  for (let i = 0; i < line.length; i += max) {
    out.push((i === 0 ? "" : " ") + line.slice(i, i + max));
  }
  return out;
}

function safeICS(s) {
  return (s || "").replace(/[;,]/g, " ").replace(/\n/g, "\\n");
}

function isWithin(date, from, to) {
  if (!from || !to) return false;
  const t = date.getTime();
  return t >= new Date(from).getTime() && t <= new Date(to).getTime();
}

function csvSafe(s) {
  if (s == null) return "";
  const str = String(s);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function scaleQty(qty, servings = 1) {
  const q = (qty || 0) * servings;
  return Number.isFinite(q) ? q : "";
}

function parseCSV(text) {
  // simple CSV parse (no quoted commas nesting beyond basics)
  return text.split("\n").map((line) => {
    const out = [];
    let cur = "";
    let inside = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
        continue;
      }
      if (ch === '"') {
        inside = !inside;
        continue;
      }
      if (ch === "," && !inside) {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out;
  });
}

/* ----------------------------------------------------------------------------
   Recipe resolvers (kept decoupled; works even if store not initialized yet)
---------------------------------------------------------------------------- */
function resolveRecipe(id) {
  // NOTE: Recipes.all() is async; for export speed we use a lazy cache pattern.
  if (!id) return null;
  if (!globalThis.__SUKA_RECIPE_CACHE) return null;
  return globalThis.__SUKA_RECIPE_CACHE[id] || null;
}

function resolveRecipeName(id) {
  const r = resolveRecipe(id);
  return r?.title || "";
}

/* Call this at app bootstrap once recipes are loaded to speed up exports */
export async function primeRecipeCache() {
  try {
    const all = await Recipes.all();
    globalThis.__SUKA_RECIPE_CACHE = Object.fromEntries(
      all.map((r) => [r.id, r])
    );
  } catch (e) {
    logger.warn("[mealPlanExports] primeRecipeCache failed", e);
  }
}

/* ----------------------------------------------------------------------------
   Save helpers — browser & Node compatible
---------------------------------------------------------------------------- */
async function saveFile({ data, filename, mime }) {
  const blob = new Blob([data], { type: mime });
  return saveBlob({ blob, filename });
}

async function saveBlob({ blob, filename }) {
  // Browser path
  if (typeof window !== "undefined" && window?.URL?.createObjectURL) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
    return { ok: true, filename };
  }

  // Node path (dev server / exports folder)
  try {
    // Indirect dynamic import keeps browser bundlers from resolving Node core modules.
    const dynamicImport = new Function("s", "return import(s)");
    const fs = await dynamicImport("node:fs");
    const path = await dynamicImport("node:path");
    const dir = path.resolve(process.cwd(), "exports");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, filename);
    const buf = Buffer.from(await blob.arrayBuffer());
    fs.writeFileSync(filePath, buf);
    return { ok: true, filename, filePath };
  } catch (e) {
    logger.error("[mealPlanExports] saveBlob failed", e);
    throw e;
  }
}

/* ----------------------------------------------------------------------------
   Tiny integration surface for NBA toolbar (optional convenience)
---------------------------------------------------------------------------- */
export function exportActionsForNBA(plan) {
  return [
    {
      id: "export_grocery_csv",
      label: "Export Grocery CSV",
      icon: "download",
      intent: "export",
      payload: { planId: plan.id, format: "csv:shopping" },
    },
    {
      id: "export_calendar_ics",
      label: "Export Calendar (ICS)",
      icon: "calendar",
      intent: "export",
      payload: { planId: plan.id, format: "ics" },
    },
    {
      id: "export_md",
      label: "Export Markdown",
      icon: "file-text",
      intent: "export",
      payload: { planId: plan.id, format: "md" },
    },
    {
      id: "export_labels_pdf",
      label: "Print Labels (PDF)",
      icon: "printer",
      intent: "export",
      payload: { planId: plan.id, format: "pdf:labels" },
    },
  ];
}

export default mealPlanExports;
