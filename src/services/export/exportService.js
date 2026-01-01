// src/services/export/exportService.js
/* eslint-disable no-console */

/**
 * Suka Smart Assistant — Export Service
 * -------------------------------------------------------------
 * 1) Clear IA: top-level exports for PDFs, Labels, Share Packs, and Agent Reports.
 * 2) Intuitive flow: preview → generate → print/share with Undo + NBA.
 * 3) Consistency: emits design-system glue (toasts, empty, undo, progress).
 * 4) Event-driven glue: responds to recipes/inventory/calendar changes.
 * 5) Monetization: optional paid download offers per artifact.
 *
 * No external deps. Uses Blob/URL for browser downloads.
 */

import {
  events,
  NAMES,
  buildEvent,
  emitEvent,
} from "@/services/events/contracts";

import Labels from "@/services/labels/templates"; // strings+helpers module

/* ──────────────────────────────────────────────────────────────
 * Tiny persistence (recent exports)
 * ────────────────────────────────────────────────────────────── */
const STORAGE_KEY = "suka.exports.v1";

const storage = {
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  },
  save(items) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items || []));
    } catch (e) {
      console.warn("[export] storage save error", e);
    }
  },
  add(item) {
    const all = storage.load();
    all.unshift(item);
    storage.save(all.slice(0, 50));
  },
  remove(id) {
    const next = storage.load().filter((x) => x.id !== id);
    storage.save(next);
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
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const nowISO = () => new Date().toISOString();

function toast(variant, title, message) {
  events.emit(buildEvent(NAMES["ui.toast.shown"], { variant, title, message }, { source: "exportService" }));
}

function progress(context, step, total, label) {
  events.emit(buildEvent(NAMES["ui.state.pending"], { key: `export:${context}:${step}/${total}` }, { source: "exportService" }));
  events.emit(buildEvent(NAMES["ui.toast.shown"], { variant: "info", title: label || "Preparing export", message: `${step}/${total}` }, { source: "exportService" }));
}

function done(context) {
  events.emit(buildEvent(NAMES["ui.state.ready"], { key: `export:${context}` }, { source: "exportService" }));
}

function htmlEscape(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function section(title, bodyHtml) {
  return `<section class="card"><h2>${htmlEscape(title)}</h2>${bodyHtml || ""}</section>`;
}

function simpleCss() {
  return `
    <style>
      :root{--fg:#111;--muted:#666;--card:#fff;--line:#e5e7eb;--chip:#f3f4f6;}
      *{box-sizing:border-box} body{margin:0;background:#f7f7f7;color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
      .page{max-width:900px;margin:24px auto;background:var(--card);padding:28px;border:1px solid var(--line);border-radius:16px}
      h1{margin:0 0 4px;font-size:28px;line-height:1.15} .muted{color:var(--muted);margin-bottom:16px}
      .meta{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0 16px;color:var(--muted)}
      .card{border:1px solid var(--line);border-radius:12px;padding:16px;background:#fff;margin-top:16px}
      .grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
      .tags{margin:8px 0 0;display:flex;flex-wrap:wrap;gap:8px}
      .tags span{background:var(--chip);border:1px solid var(--line);border-radius:999px;padding:2px 8px;font-size:12px}
      table{width:100%;border-collapse:collapse}
      th,td{padding:8px;border-bottom:1px solid var(--line);text-align:left}
      .step-num{display:inline-grid;place-items:center;border:1px solid var(--line);border-radius:999px;width:20px;height:20px;font-size:12px;margin-right:6px}
      footer{margin-top:20px;color:var(--muted);font-size:12px}
      .pill{background:#f3f4f6;border:1px solid var(--line);border-radius:999px;padding:2px 8px;font-size:12px}
    </style>`;
}

/* ──────────────────────────────────────────────────────────────
 * Monetization helper: offer a paid download for any artifact
 * Emits a checkout request + NBA, with Undo to cancel the hold.
 * ────────────────────────────────────────────────────────────── */
function offerPaidDownload(rec, paid = { priceCents: 0, productId: "", currency: "USD" }) {
  if (!paid || !paid.priceCents || !paid.productId) return null;

  const payload = {
    productId: paid.productId,
    priceCents: Number(paid.priceCents),
    currency: paid.currency || "USD",
    artifactId: rec.id,
    artifactName: rec.name,
    artifactType: rec.type,
  };

  // Ask host app to open checkout
  events.emit(
    buildEvent(
      NAMES["commerce.checkout.requested"] || "commerce.checkout.requested",
      payload,
      { source: "exportService.monetize" }
    )
  );

  // Single NBA to complete purchase
  events.emit(
    buildEvent(
      NAMES["ui.nba.suggested"],
      { label: "Complete Purchase", hint: "Secure checkout", route: "/checkout", params: { pid: paid.productId, ref: rec.id } },
      { source: "exportService.monetize" }
    )
  );

  // Undo cancels the offer/hard hold in your system
  emitEvent(
    NAMES["ui.undo.offered"],
    { label: "Cancel Purchase", ttlMs: 8000 },
    {
      source: "exportService.monetize",
      undo: {
        label: "Cancel Purchase",
        handler: () => {
          events.emit(
            buildEvent(
              NAMES["commerce.checkout.canceled"] || "commerce.checkout.canceled",
              { productId: paid.productId, artifactId: rec.id },
              { source: "exportService.monetize" }
            )
          );
          toast("info", "Purchase canceled", "You can re-open checkout later.");
        },
      },
    }
  );

  return payload;
}

/* ──────────────────────────────────────────────────────────────
 * Nutrition helpers (serving sizes + macro percentages)
 * ────────────────────────────────────────────────────────────── */
function hasNutrition(n) {
  if (!n) return false;
  const keys = ["calories","protein","carbs","fat","fiber","sugar","sodium",
                "totalCalories","totalProtein","totalCarbs","totalFat"];
  return keys.some((k) => n[k] != null && !Number.isNaN(Number(n[k])));
}

/** Returns normalized per-serving nutrition + metadata */
function normalizeNutrition(recipe = {}) {
  const n = recipe.nutrition || {};
  const servings = Math.max(1, Number(recipe.servings || 1));
  const basis = (n.basis || n.perRecipe === true ? "per_recipe" : "per_serving");

  // Pull primary fields (prefer per-serving, else totals)
  let calories = n.calories ?? null;
  let protein = n.protein ?? null;
  let carbs = n.carbs ?? null;
  let fat = n.fat ?? null;
  let fiber = n.fiber ?? null;
  let sugar = n.sugar ?? null;
  let sodium = n.sodium ?? null;

  // If per-recipe totals supplied, divide by servings
  if (basis === "per_recipe" || (calories == null && (n.totalCalories != null))) {
    calories = n.totalCalories != null ? Number(n.totalCalories) / servings : calories;
    protein  = n.totalProtein  != null ? Number(n.totalProtein)  / servings : protein;
    carbs    = n.totalCarbs    != null ? Number(n.totalCarbs)    / servings : carbs;
    fat      = n.totalFat      != null ? Number(n.totalFat)      / servings : fat;
    fiber    = n.totalFiber    != null ? Number(n.totalFiber)    / servings : fiber;
    sugar    = n.totalSugar    != null ? Number(n.totalSugar)    / servings : sugar;
    sodium   = n.totalSodium   != null ? Number(n.totalSodium)   / servings : sodium;
  }

  // Coerce numbers
  const num = (x) => (x == null || Number.isNaN(Number(x)) ? null : Number(x));
  calories = num(calories);
  protein  = num(protein);
  carbs    = num(carbs);
  fat      = num(fat);
  fiber    = num(fiber);
  sugar    = num(sugar);
  sodium   = num(sodium);

  // If calories missing but macros present, estimate from macros
  const kcalFromMacros = (protein != null || carbs != null || fat != null)
    ? (4 * (protein || 0)) + (4 * (carbs || 0)) + (9 * (fat || 0))
    : null;
  const inferred = calories == null && kcalFromMacros != null ? Math.round(kcalFromMacros) : null;
  const caloriesFinal = calories ?? inferred;

  // Macro percentages
  const denom = caloriesFinal && caloriesFinal > 0 ? caloriesFinal : null;
  const pct = { protein: null, carbs: null, fat: null };
  if (denom) {
    const rp = protein != null ? (protein * 4 / denom) * 100 : 0;
    const rc = carbs   != null ? (carbs   * 4 / denom) * 100 : 0;
    const rf = fat     != null ? (fat     * 9 / denom) * 100 : 0;
    let p = Math.round(rp), c = Math.round(rc), f = Math.round(rf);
    const diff = 100 - (p + c + f);
    if (diff) {
      // Nudge largest to hit 100
      const arr = [{k:"protein",v:p},{k:"carbs",v:c},{k:"fat",v:f}].sort((a,b)=>b.v-a.v);
      arr[0].v += diff;
      p = arr.find(x=>x.k==="protein").v;
      c = arr.find(x=>x.k==="carbs").v;
      f = arr.find(x=>x.k==="fat").v;
    }
    pct.protein = protein != null ? p : null;
    pct.carbs   = carbs   != null ? c : null;
    pct.fat     = fat     != null ? f : null;
  }

  return {
    perServing: { calories: caloriesFinal, protein, carbs, fat, fiber, sugar, sodium },
    servingSize: n.servingSize || null,
    servings,
    caloriesEstimated: calories == null && caloriesFinal != null,
    pct,
  };
}

function renderNutritionPanel(recipe = {}) {
  if (!hasNutrition(recipe.nutrition)) return "";
  const norm = normalizeNutrition(recipe);
  const s = norm.perServing;

  const show = (v, unit = "") => (v == null ? "—" : `${Math.round(v)}${unit}`);
  const macroPct = (k) => (norm.pct[k] == null ? "" : ` <small class="pct">${norm.pct[k]}%</small>`);
  const calLabel = norm.caloriesEstimated ? "~" + show(s.calories) : show(s.calories);

  const servingMetaParts = [];
  if (norm.servingSize) servingMetaParts.push(`Serving size: ${htmlEscape(norm.servingSize)}`);
  if (norm.servings) servingMetaParts.push(`${norm.servings} serving${norm.servings > 1 ? "s" : ""} per recipe`);
  const servingMeta = servingMetaParts.length ? `<p class="muted serving">${servingMetaParts.join(" • ")}</p>` : "";

  return `
  <section class="nutrition">
    <h3>Nutrition (per serving)</h3>
    ${servingMeta}
    <div class="grid">
      <div><strong>Calories</strong><span>${calLabel}</span></div>
      <div><strong>Protein</strong><span>${show(s.protein,"g")}${macroPct("protein")}</span></div>
      <div><strong>Carbs</strong><span>${show(s.carbs,"g")}${macroPct("carbs")}</span></div>
      <div><strong>Fat</strong><span>${show(s.fat,"g")}${macroPct("fat")}</span></div>
      <div><strong>Fiber</strong><span>${show(s.fiber,"g")}</span></div>
      <div><strong>Sugar</strong><span>${show(s.sugar,"g")}</span></div>
      <div><strong>Sodium</strong><span>${show(s.sodium,"mg")}</span></div>
    </div>
    ${
      norm.pct.protein != null || norm.pct.carbs != null || norm.pct.fat != null
        ? `<p class="muted macro-split">Macro split: P ${norm.pct.protein ?? "—"}% • C ${norm.pct.carbs ?? "—"}% • F ${norm.pct.fat ?? "—"}%</p>`
        : ""
    }
  </section>`;
}

/* ──────────────────────────────────────────────────────────────
 * PDF/HTML builders
 * ────────────────────────────────────────────────────────────── */
function htmlToBlob(html) {
  return new Blob([html], { type: "text/html;charset=utf-8" }); // browser-friendly; print to PDF
}

function buildRecipeHtml(recipe, opts = {}) {
  const title = htmlEscape(recipe.title || "Untitled Recipe");
  const desc = htmlEscape(recipe.description || "");
  const serves = recipe.servings ? `<span>Serves: ${htmlEscape(String(recipe.servings))}</span>` : "";
  const time = recipe.totalTime ? `<span>Total: ${htmlEscape(String(recipe.totalTime))}</span>` : "";
  const tags = Array.isArray(recipe.tags) && recipe.tags.length ? `<div class="tags">${recipe.tags.map((t) => `<span>${htmlEscape(String(t))}</span>`).join("")}</div>` : "";

  const ingredients = (recipe.ingredients || [])
    .map((it) => `<li>${htmlEscape(it.quantity ? `${it.quantity} ` : "")}${htmlEscape(it.name || it)}</li>`)
    .join("");

  const steps = (recipe.steps || recipe.method || [])
    .map((s, i) => `<li><span class="step-num">${i + 1}</span> ${htmlEscape(s)}</li>`)
    .join("");

  const nutritionHtml = renderNutritionPanel(recipe);

  const css = `
    ${simpleCss()}
    <style>
      .grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
      .nutrition{margin-top:16px}
      .nutrition h3{margin:0 0 8px;font-size:14px}
      .nutrition .serving{margin:4px 0 10px}
      .nutrition .grid{display:grid;grid-template-columns:repeat(4, minmax(0,1fr));gap:8px}
      .nutrition .grid > div{border:1px dashed var(--line);padding:8px;border-radius:8px;font-size:12px;display:flex;justify-content:space-between;align-items:center}
      .nutrition .pct{color:var(--muted);margin-left:6px}
      .nutrition .macro-split{margin-top:8px}
    </style>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${css}</head><body>
    <article class="page">
      <header>
        <h1>${title}</h1>
        <p class="muted">${desc}</p>
        <div class="meta">${serves}${time}</div>
        ${tags}
      </header>
      <section class="grid2">
        <div class="card">
          <h2>Ingredients</h2>
          <ul>${ingredients}</ul>
        </div>
        <div class="card">
          <h2>Instructions</h2>
          <ol>${steps}</ol>
          ${nutritionHtml}
        </div>
      </section>
      <footer>Generated ${new Date().toLocaleString()} • Suka Smart Assistant</footer>
    </article>
  </body></html>`;
}

function buildAgentHtml(title, summaryHtml, sections = []) {
  const css = simpleCss();
  const body = [
    `<header><h1>${htmlEscape(title)}</h1>${summaryHtml || ""}</header>`,
    ...sections.map(s => section(s.title, s.html)),
    `<footer>Generated ${new Date().toLocaleString()} • Suka Smart Assistant</footer>`,
  ].join("\n");

  return `<!doctype html><html><head><meta charset="utf-8"><title>${htmlEscape(title)}</title>${css}</head><body>
    <article class="page">${body}</article></body></html>`;
}

/* ──────────────────────────────────────────────────────────────
 * Core exports (existing) — now with optional paid {priceCents,productId,currency}
 * ────────────────────────────────────────────────────────────── */

/**
 * Generate a print-friendly "PDF" (HTML blob).
 * @param {object} recipe
 * @param {{paid?:{priceCents:number,productId:string,currency?:string}}} [opts]
 * @returns {{id:string, type:"recipe-pdf", at:string, name:string, url:string, bytes:number}}
 */
export function exportRecipePDF(recipe, opts = {}) {
  if (!recipe || !isStr(recipe.title)) {
    // Helpful empty state
    events.emit(
      buildEvent(
        NAMES["ui.empty.presented"],
        {
          context: "export.recipe",
          actions: [
            { label: "Open Recipes", eventName: NAMES["ia.route.navigated"], payload: { path: "/tier2/household/meals#recipes" } },
            { label: "Scan a Recipe", eventName: NAMES["ia.route.navigated"], payload: { path: "/scan/recipe" } },
          ],
        },
        { source: "exportService" }
      )
    );
    return null;
  }

  progress("recipe", 1, 2, "Preparing recipe export");
  const html = buildRecipeHtml(recipe);
  const blob = htmlToBlob(html);
  const url = URL.createObjectURL(blob);

  const rec = {
    id: uid(),
    type: "recipe-pdf",
    at: nowISO(),
    name: `${(recipe.title || "recipe").replace(/[^\w.-]+/g, "_")}.html`,
    url,
    bytes: blob.size,
  };
  storage.add(rec);

  // Undo removes the artifact from recent list
  emitEvent(
    NAMES["ui.undo.offered"],
    { label: "Undo Export", ttlMs: 8000 },
    {
      source: "exportService.exportRecipePDF",
      undo: {
        label: "Undo Export",
        handler: () => {
          storage.remove(rec.id);
          toast("info", "Export removed", "The recipe export was undone.");
          try { URL.revokeObjectURL(url); } catch { /* noop */ }
        },
      },
      nextBestAction: {
        label: "Print Recipe",
        hint: "Open the file and print as PDF",
        route: "/exports",
        params: { id: rec.id },
      },
    }
  );

  // Optional: offer paid download
  if (opts.paid) offerPaidDownload(rec, opts.paid);

  done("recipe");
  toast("success", "Recipe ready", "Open the file to print or share.");
  return rec;
}

/**
 * Build and persist labels, returning the batch and a printable HTML.
 * @param {Array<object>} items
 * @param {{templateId?:string,defaults?:object,copies?:number,title?:string, paid?:{priceCents:number,productId:string,currency?:string}}} cfg
 * @returns {{batch:any, url:string, name:string}}
 */
export function exportInventoryLabels(items, cfg = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    Labels.emitEmptyStateForLabels("labels.generate.empty");
    return null;
  }

  progress("labels", 1, 2, "Generating labels");
  const batch = Labels.generateLabels(items, {
    templateId: cfg.templateId || "inventory/basic",
    defaults: cfg.defaults || {},
    copies: clamp(Number(cfg.copies ?? 1), 1, 50),
    title: cfg.title,
  });

  // Build a lightweight print sheet HTML for convenience (1 label per block)
  const css = `
    <style>
      :root{--line:#e5e7eb;--fg:#111}
      body{margin:16px;font:12px/1.3 system-ui,-apple-system,Segoe UI,Roboto}
      .label{display:inline-block;vertical-align:top;width:240px;height:90px;border:1px solid var(--line);border-radius:8px;padding:6px;margin:4px;color:var(--fg)}
      .l1{font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .l2,.l3{font-size:10px;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    </style>`;
  const body = batch.records
    .map((r) => {
      const [l1, l2, l3] = r.lines;
      return `<div class="label"><div class="l1">${htmlEscape(l1 || "")}</div><div class="l2">${htmlEscape(l2 || "")}</div><div class="l3">${htmlEscape(l3 || "")}</div></div>`;
    })
    .join("");
  const html = `<!doctype html><meta charset="utf-8"><title>Labels</title>${css}<body>${body}</body>`;
  const blob = htmlToBlob(html);
  const url = URL.createObjectURL(blob);

  const rec = {
    id: uid(),
    type: "inventory-labels",
    at: nowISO(),
    name: `labels-${batch.id}.html`,
    url,
    bytes: blob.size,
  };
  storage.add(rec);

  // Offer Undo for the export artifact (batch already has its own Undo inside Labels)
  emitEvent(
    NAMES["ui.undo.offered"],
    { label: "Undo Export", ttlMs: 8000 },
    {
      source: "exportService.exportInventoryLabels",
      undo: {
        label: "Undo Export",
        handler: () => {
          storage.remove(rec.id);
          toast("info", "Export removed", "The label export was undone.");
          try { URL.revokeObjectURL(url); } catch { /* noop */ }
        },
      },
      nextBestAction: {
        label: "Print Labels",
        hint: `Open printable sheet`,
        route: "/tier2/household/inventory#labels-print",
        params: { batchId: batch.id },
      },
    }
  );

  // Optional: offer paid download
  if (cfg.paid) offerPaidDownload(rec, cfg.paid);

  done("labels");
  toast("success", "Labels ready", `${batch.count} labels generated.`);
  return { batch, url, name: rec.name };
}

/**
 * Meal Plan Share Pack (calendar-aware; includes per-serving calories)
 * @param {{weekStartISO:string, items:Array<{date:string,title:string, recipe?:object}>}} plan
 * @param {{paid?:{priceCents:number,productId:string,currency?:string}}} [opts]
 * @returns {{id:string, type:"meal-share", at:string, name:string, url:string, bytes:number}}
 */
export function exportMealPlanShare(plan, opts = {}) {
  if (!plan || !Array.isArray(plan.items) || plan.items.length === 0) {
    events.emit(buildEvent(NAMES["ui.empty.presented"], {
      context: "export.mealplan",
      actions: [
        { label: "Open Planner", eventName: NAMES["ia.route.navigated"], payload: { path: "/tier2/household/meals" } },
        { label: "Create Plan",  eventName: NAMES["ia.route.navigated"], payload: { path: "/tier2/household/meals#new" } },
      ],
    }, { source: "exportService" }));
    return null;
  }

  progress("share", 1, 2, "Composing share sheet");

  const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  const rows = plan.items
    .slice()
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((it) => {
      const title = htmlEscape(it.title || it.recipe?.title || "Meal");
      const cal = hasNutrition(it.recipe?.nutrition) ? normalizeNutrition(it.recipe).perServing.calories : null;
      const calStr = isNum(cal) ? `<span class="pill">${Math.round(cal)} kcal</span>` : "";
      return `<tr><td class="date">${fmtDay(it.date)}</td><td class="meal">${title}</td><td style="text-align:right">${calStr}</td></tr>`;
    })
    .join("");

  const css = `
    ${simpleCss()}
    <style>
      table{border:1px solid var(--line);border-radius:12px;overflow:hidden}
      tr:last-child td{border-bottom:none}
      td.date{white-space:nowrap}
    </style>`;
  const title = `Meal Plan • Week of ${plan.weekStartISO}`;
  const html = `<!doctype html><meta charset="utf-8"><title>${htmlEscape(title)}</title>${css}
    <article class="page">
      <h1>${htmlEscape(title)}</h1>
      <p class="muted">Share with family or print.</p>
      <section class="card">
        <table><thead><tr><th>Day</th><th>Meal</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      </section>
      <footer>Generated ${new Date().toLocaleString()} • Suka Smart Assistant</footer>
    </article>`;

  const blob = htmlToBlob(html);
  const url = URL.createObjectURL(blob);

  const rec = { id: uid(), type: "meal-share", at: nowISO(), name: `mealplan-${plan.weekStartISO}.html`, url, bytes: blob.size };
  storage.add(rec);

  // Undo + NBA
  emitEvent(
    NAMES["ui.undo.offered"],
    { label: "Undo Export", ttlMs: 8000 },
    {
      source: "exportService.exportMealPlanShare",
      undo: {
        label: "Undo Export",
        handler: () => {
          storage.remove(rec.id);
          toast("info", "Export removed", "The share sheet was undone.");
          try { URL.revokeObjectURL(url); } catch { /* noop */ }
        },
      },
      nextBestAction: {
        label: "Share Plan",
        hint: "Send the link to family",
        route: "/exports",
        params: { id: rec.id },
      },
    }
  );

  if (opts.paid) offerPaidDownload(rec, opts.paid);

  done("share");
  toast("success", "Share sheet ready", "Open to share or print.");
  return rec;
}

/* ──────────────────────────────────────────────────────────────
 * Agent category exports (from your /src/agents/* list)
 * Each function: builds a clear HTML report, persists, Undo + NBA,
 * optional paid checkout via { paid: { priceCents, productId, currency } }
 * ────────────────────────────────────────────────────────────── */

function persistAndEnvelope({ html, name, type, context, nba }) {
  const blob = htmlToBlob(html);
  const url = URL.createObjectURL(blob);
  const rec = { id: uid(), type, at: nowISO(), name, url, bytes: blob.size };
  storage.add(rec);

  emitEvent(
    NAMES["ui.undo.offered"],
    { label: "Undo Export", ttlMs: 8000 },
    {
      source: `exportService.${context}`,
      undo: {
        label: "Undo Export",
        handler: () => {
          storage.remove(rec.id);
          toast("info", "Export removed", "The export was undone.");
          try { URL.revokeObjectURL(url); } catch { /* noop */ }
        },
      },
      nextBestAction: nba || {
        label: "Open Export",
        hint: "Preview, print or share",
        route: "/exports",
        params: { id: rec.id },
      },
    }
  );

  return rec;
}

function gridRows(rows = [], columns = []) {
  const head = `<thead><tr>${columns.map(c => `<th>${htmlEscape(c)}</th>`).join("")}</tr></thead>`;
  const body = `<tbody>${rows.map(r => `<tr>${columns.map(c => `<td>${htmlEscape(String(r[c] ?? ""))}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<table>${head}${body}</table>`;
}

/* ------------ Animal & Husbandry ---------------- */
export function exportAnimalHealthReport(data = {}, opts = {}) {
  progress("animalHealth", 1, 2, "Composing animal health report");
  const title = data.title || "Animal Health Report";
  const summary = `<p class="muted">${htmlEscape(data.summary || "Health checks, vaccinations, and treatments.")}</p>`;
  const sections = [
    { title: "Herd Overview", html: gridRows(data.herd || [], ["id","name","type","age","status"]) },
    { title: "Health Interventions", html: gridRows(data.interventions || [], ["date","name","animal","dose","notes"]) },
    { title: "Upcoming Care", html: gridRows(data.upcoming || [], ["date","task","animal","assignee"]) },
  ];
  const html = buildAgentHtml(title, summary, sections);
  const rec = persistAndEnvelope({
    html, name: `animal-health-${Date.now()}.html`, type: "animal-health-report",
    context: "animalHealth", nba: { label: "Schedule Care", hint: "Add to calendar", route: "/calendar" }
  });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("animalHealth");
  toast("success", "Animal Health export ready", "Open to review.");
  return rec;
}

export function exportBreedingPlan(data = {}, opts = {}) {
  progress("breeding", 1, 2, "Composing breeding plan");
  const title = data.title || "Breeding & Butchering Plan";
  const sections = [
    { title: "Breeding Pairs", html: gridRows(data.pairs || [], ["sire","dam","window","notes"]) },
    { title: "Gestation/Incubation", html: gridRows(data.gestation || [], ["animal","days","dueDate"]) },
    { title: "Butchering Windows", html: gridRows(data.butchering || [], ["animal","targetWeight","window","processor"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name: `breeding-plan-${Date.now()}.html`, type: "breeding-plan", context: "breeding" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("breeding");
  toast("success", "Breeding plan ready", "Open to print or share.");
  return rec;
}

export function exportButcheryCutSheet(data = {}, opts = {}) {
  progress("butchery", 1, 2, "Preparing cut sheet");
  const title = data.title || "Butchery Cut Sheet";
  const sections = [
    { title: "Animal", html: gridRows([data.animal || {}], ["id","type","liveWeight","hangDays"]) },
    { title: "Cuts Selection", html: gridRows(data.cuts || [], ["cut","thickness","qty","notes"]) },
    { title: "Packaging", html: gridRows([data.packaging || {}], ["wrap","label","special"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name: `cut-sheet-${Date.now()}.html`, type: "butchery-cut-sheet", context: "butchery" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("butchery"); toast("success","Cut sheet ready","Review with your processor."); return rec;
}

/* ------------ Cooking / Batch / Preservation -------------- */
export function exportBatchCookingPlan(data = {}, opts = {}) {
  progress("batchCooking", 1, 2, "Composing batch cooking plan");
  const title = data.title || "Batch Cooking Plan";
  const recipeList = (data.recipes || []).map(r => `<li>${htmlEscape(r.title || "Untitled")} — ${htmlEscape(r.portions || "1x")}</li>`).join("");
  const recipesHtml = `<ul>${recipeList || "<li>No recipes selected</li>"}</ul>`;
  const sections = [
    { title: "Recipes", html: recipesHtml },
    { title: "Shopping List", html: gridRows(data.shopping || [], ["item","qty","unit","section"]) },
    { title: "Timeline", html: gridRows(data.timeline || [], ["start","end","task","owner"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name: `batch-cooking-${Date.now()}.html`, type: "batch-cooking-plan", context: "batchCooking",
    nba: { label: "Start Cooking Session", hint: "Track progress", route: "/tier2/household/meals#cook" } });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("batchCooking"); toast("success","Batch plan ready","Open to start."); return rec;
}

export function exportPreservationPlan(data = {}, opts = {}) {
  progress("preservation", 1, 2, "Building preservation plan");
  const title = data.title || "Preservation Plan";
  const sections = [
    { title: "Batches", html: gridRows(data.batches || [], ["recipe","method","qty","jars","headspace"]) },
    { title: "Safety Notes", html: `<p class="muted">${htmlEscape(data.safety || "Follow tested methods and altitude adjustments.")}</p>` },
    { title: "Inventory Targets", html: gridRows(data.targets || [], ["item","par","unit"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name:`preservation-${Date.now()}.html`, type:"preservation-plan", context:"preservation" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("preservation"); toast("success","Preservation plan ready","Open to review."); return rec;
}

export function exportProcurementList(data = {}, opts = {}) {
  progress("procurement", 1, 2, "Compiling procurement list");
  const title = data.title || "Procurement List";
  const sections = [
    { title: "Vendors", html: gridRows(data.vendors || [], ["name","contact","terms"]) },
    { title: "Items to Source", html: gridRows(data.items || [], ["item","qty","unit","targetPrice","vendor"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name:`procurement-${Date.now()}.html`, type:"procurement-list", context:"procurement" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("procurement"); toast("success","Procurement list ready","Send to vendor."); return rec;
}

/* ------------ Meals / Recipes -------------- */
export function exportRecipeConsolidationSummary(data = {}, opts = {}) {
  progress("recipeConsolidation", 1, 2, "Summarizing recipes");
  const title = data.title || "Recipe Consolidation Summary";
  const sections = [
    { title: "Imported", html: gridRows(data.imported || [], ["title","source","status"]) },
    { title: "Duplicates Resolved", html: gridRows(data.duplicates || [], ["title","keptId","mergedIds"]) },
    { title: "Errors", html: gridRows(data.errors || [], ["source","reason"]) },
  ];
  const html = buildAgentHtml(title, `<p class="muted">Consolidation results</p>`, sections);
  const rec = persistAndEnvelope({ html, name:`recipe-consolidation-${Date.now()}.html`, type:"recipe-consolidation", context:"recipeConsolidation" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("recipeConsolidation"); toast("success","Summary ready","Open to review."); return rec;
}

export function exportMealBundle(data = {}, opts = {}) {
  progress("mealBundle", 1, 2, "Creating meal bundle");
  const title = data.title || "Meal Bundle";
  const sections = [
    { title: "Bundle", html: gridRows(data.bundle || [], ["meal","serves","day"]) },
    { title: "Shopping", html: gridRows(data.shopping || [], ["item","qty","unit","storeSection"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name:`meal-bundle-${Date.now()}.html`, type:"meal-bundle", context:"mealBundle" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("mealBundle"); toast("success","Meal bundle ready","Open to review."); return rec;
}

/* ------------ Cleaning -------------- */
export function exportCleaningRoutine(data = {}, opts = {}) {
  progress("cleaningRoutine", 1, 2, "Composing cleaning routine");
  const title = data.title || "Cleaning Routine";
  const sections = [
    { title: "Zones", html: gridRows(data.zones || [], ["zone","frequency","notes"]) },
    { title: "Tasks", html: gridRows(data.tasks || [], ["task","tools","duration","owner"]) },
    { title: "Schedule", html: gridRows(data.schedule || [], ["day","time","zone"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name:`cleaning-routine-${Date.now()}.html`, type:"cleaning-routine", context:"cleaningRoutine",
    nba: { label: "Sync to Calendar", hint: "Keep routine on track", route: "/calendar" } });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("cleaningRoutine"); toast("success","Routine ready","Open to sync."); return rec;
}

/* ------------ Garden -------------- */
export function exportGardenPlan(data = {}, opts = {}) {
  progress("gardenPlan", 1, 2, "Drafting garden plan");
  const title = data.title || "Garden Plan";
  const sections = [
    { title: "Beds & Layout", html: gridRows(data.beds || [], ["bed","crop","spacing","succession"]) },
    { title: "Sowing & Transplanting", html: gridRows(data.sowing || [], ["crop","start","transplant","maturity"]) },
    { title: "Watering & Soil", html: gridRows(data.soilWater || [], ["zone","schedule","amendments"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name:`garden-plan-${Date.now()}.html`, type:"garden-plan", context:"gardenPlan" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("gardenPlan"); toast("success","Garden plan ready","Open to review."); return rec;
}

export function exportCompanionPlantingGuide(data = {}, opts = {}) {
  progress("companionPlanting", 1, 2, "Building companion guide");
  const title = data.title || "Companion Planting Guide";
  const sections = [
    { title: "Companions", html: gridRows(data.companions || [], ["crop","with","benefit"]) },
    { title: "Avoid", html: gridRows(data.avoid || [], ["crop","avoid","reason"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name:`companion-guide-${Date.now()}.html`, type:"companion-planting", context:"companionPlanting" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("companionPlanting"); toast("success","Guide ready","Open to print."); return rec;
}

export function exportGardenEstimate(data = {}, opts = {}) {
  progress("gardenEstimate", 1, 2, "Estimating yield");
  const title = data.title || "Garden Estimate";
  const sections = [
    { title: "Yield Estimates", html: gridRows(data.yield || [], ["crop","area","expected","unit"]) },
    { title: "Labor Estimates", html: gridRows(data.labor || [], ["task","hours"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name:`garden-estimate-${Date.now()}.html`, type:"garden-estimate", context:"gardenEstimate" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("gardenEstimate"); toast("success","Estimate ready","Open to review."); return rec;
}

export function exportGardenHealth(data = {}, opts = {}) {
  progress("gardenHealth", 1, 2, "Composing garden health report");
  const title = data.title || "Garden Health Report";
  const sections = [
    { title: "Observations", html: gridRows(data.observations || [], ["date","bed","issue","severity","action"]) },
    { title: "Soil Tests", html: gridRows(data.soilTests || [], ["date","bed","ph","n","p","k"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name:`garden-health-${Date.now()}.html`, type:"garden-health", context:"gardenHealth" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("gardenHealth"); toast("success","Health report ready","Open to review."); return rec;
}

export function exportGardenHarvestSchedule(data = {}, opts = {}) {
  progress("gardenHarvest", 1, 2, "Creating harvest schedule");
  const title = data.title || "Harvest Schedule";
  const sections = [
    { title: "Schedule", html: gridRows(data.schedule || [], ["date","crop","quantity","unit"]) },
    { title: "Post-harvest", html: gridRows(data.postHarvest || [], ["crop","step","notes"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name:`harvest-schedule-${Date.now()}.html`, type:"garden-harvest", context:"gardenHarvest" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("gardenHarvest"); toast("success","Schedule ready","Open to plan."); return rec;
}

export function exportSoilAndWaterReport(data = {}, opts = {}) {
  progress("soilWater", 1, 2, "Composing soil & water report");
  const title = data.title || "Soil & Water Report";
  const sections = [
    { title: "Soil Improvements", html: gridRows(data.soil || [], ["bed","amendment","rate","date"]) },
    { title: "Irrigation", html: gridRows(data.irrigation || [], ["zone","method","schedule"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name:`soil-water-${Date.now()}.html`, type:"soil-water", context:"soilWater" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("soilWater"); toast("success","Report ready","Open to review."); return rec;
}

/* ------------ Inventory / Storehouse / Waste -------------- */
export function exportInventorySnapshot(data = {}, opts = {}) {
  progress("inventory", 1, 2, "Creating inventory snapshot");
  const title = data.title || "Inventory Snapshot";
  const sections = [
    { title: "Summary", html: gridRows([data.summary || {}], ["items","stockValue","lowCount"]) },
    { title: "Low Signals", html: gridRows(data.low || [], ["sku","name","qty","par"]) },
    { title: "Overstock", html: gridRows(data.overstock || [], ["sku","name","qty"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name:`inventory-snapshot-${Date.now()}.html`, type:"inventory-snapshot", context:"inventory" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("inventory"); toast("success","Snapshot ready","Open to review."); return rec;
}

export function exportStorehouseReport(data = {}, opts = {}) {
  progress("storehouse", 1, 2, "Composing storehouse report");
  const title = data.title || "Storehouse Report";
  const sections = [
    { title: "Inflows", html: gridRows(data.inflows || [], ["date","sku","qty","source"]) },
    { title: "Outflows", html: gridRows(data.outflows || [], ["date","sku","qty","destination"]) },
    { title: "Aging", html: gridRows(data.aging || [], ["sku","name","days","risk"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name:`storehouse-${Date.now()}.html`, type:"storehouse-report", context:"storehouse" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("storehouse"); toast("success","Storehouse report ready","Open to review."); return rec;
}

export function exportWasteToCompostPlan(data = {}, opts = {}) {
  progress("wasteToCompost", 1, 2, "Planning waste-to-compost");
  const title = data.title || "Waste to Compost Plan";
  const sections = [
    { title: "Waste Streams", html: gridRows(data.streams || [], ["type","volume","frequency"]) },
    { title: "Composting Plan", html: gridRows(data.plan || [], ["method","ratio","turning","notes"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name:`waste-compost-${Date.now()}.html`, type:"waste-compost", context:"wasteToCompost" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("wasteToCompost"); toast("success","Plan ready","Open to review."); return rec;
}

/* ------------ Cooking Styles / Sausage / Cure / Feed -------------- */
export function exportCookingStylesGuide(data = {}, opts = {}) {
  progress("cookingStyles", 1, 2, "Compiling cooking styles guide");
  const title = data.title || "Cooking Styles Guide";
  const sections = [
    { title: "Styles", html: gridRows(data.styles || [], ["style","temps","notes"]) },
    { title: "Recommended Recipes", html: gridRows(data.recipes || [], ["title","time","difficulty"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name:`cooking-styles-${Date.now()}.html`, type:"cooking-styles", context:"cookingStyles" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("cookingStyles"); toast("success","Guide ready","Open to browse."); return rec;
}

export function exportSausageBatchSheet(data = {}, opts = {}) {
  progress("sausage", 1, 2, "Preparing sausage batch sheet");
  const title = data.title || "Sausage Batch Sheet";
  const sections = [
    { title: "Batch", html: gridRows([data.batch || {}], ["name","weight","meat","fat","liquid"]) },
    { title: "Seasoning", html: gridRows(data.seasoning || [], ["spice","rate","unit"]) },
    { title: "Process", html: gridRows(data.process || [], ["step","target","notes"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name:`sausage-batch-${Date.now()}.html`, type:"sausage-batch", context:"sausage" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("sausage"); toast("success","Batch sheet ready","Open to review."); return rec;
}

export function exportCureCalculatorSheet(data = {}, opts = {}) {
  progress("cureCalc", 1, 2, "Building cure calc sheet");
  const title = data.title || "Cure Calculator";
  const sections = [
    { title: "Inputs", html: gridRows([data.inputs || {}], ["meatWeight","saltPct","sugarPct","curePct"]) },
    { title: "Outputs", html: gridRows([data.outputs || {}], ["salt","sugar","cure","notes"]) },
  ];
  const html = buildAgentHtml(title, `<p class="muted">Calculated curing amounts.</p>`, sections);
  const rec = persistAndEnvelope({ html, name:`cure-calc-${Date.now()}.html`, type:"cure-calc", context:"cureCalc" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("cureCalc"); toast("success","Cure sheet ready","Open to print."); return rec;
}

export function exportFeedOptimizationReport(data = {}, opts = {}) {
  progress("feedOptimizer", 1, 2, "Optimizing feed");
  const title = data.title || "Feed Optimization Report";
  const sections = [
    { title: "Feed Mix", html: gridRows(data.mix || [], ["ingredient","rate","unit","cost"]) },
    { title: "Nutrition", html: gridRows(data.nutrition || [], ["animal","protein","energy","notes"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name:`feed-optimizer-${Date.now()}.html`, type:"feed-optimizer", context:"feedOptimizer" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("feedOptimizer"); toast("success","Feed report ready","Open to review."); return rec;
}

/* ------------ Misc: Cooking Agent, Inventory Agent wrappers -------------- */
export function exportCookingSessionPlan(data = {}, opts = {}) {
  progress("cooking", 1, 2, "Composing cooking session plan");
  const title = data.title || "Cooking Session Plan";
  const sections = [
    { title: "Tasks", html: gridRows(data.tasks || [], ["order","task","duration","owner"]) },
    { title: "Tools", html: gridRows(data.tools || [], ["tool","qty"]) },
  ];
  const html = buildAgentHtml(title, "", sections);
  const rec = persistAndEnvelope({ html, name:`cooking-session-${Date.now()}.html`, type:"cooking-session", context:"cooking" });
  if (opts.paid) offerPaidDownload(rec, opts.paid);
  done("cooking"); toast("success","Session plan ready","Open to start."); return rec;
}

/* ──────────────────────────────────────────────────────────────
 * Event-driven UI Glue (kept from before)
 * ────────────────────────────────────────────────────────────── */

// Suggest exporting labels after inventory increases
events.on(NAMES["inventory.updated"], (ev) => {
  const diffs = ev?.payload?.diffs || [];
  if (!Array.isArray(diffs) || diffs.length === 0) return;
  const added = diffs.some((d) => Number(d?.delta || 0) > 0);
  if (added) {
    events.emit(
      buildEvent(
        NAMES["ui.nba.suggested"],
        { label: "Export Labels", hint: "Generate printable labels", route: "/tier2/household/inventory#labels" },
        { source: "exportService.glue" }
      )
    );
  }
});

// After recipe consolidation, nudge to export favorite recipes
events.on(NAMES["recipes.consolidated"] || "recipes.consolidated", () => {
  events.emit(
    buildEvent(
      NAMES["ui.nba.suggested"],
      { label: "Export Recipes", hint: "Print or share selected recipes", route: "/tier2/household/meals#recipes" },
      { source: "exportService.glue" }
    )
  );
});

// On calendar changes, offer to share week
events.on(NAMES["calendar.events.created"], ({ payload }) => {
  if (!payload?.range) return;
  events.emit(
    buildEvent(
      NAMES["ui.nba.suggested"],
      { label: "Export Meal Plan", hint: "Share week with family", route: "/tier2/household/meals#export" },
      { source: "exportService.glue" }
    )
  );
});

/* ──────────────────────────────────────────────────────────────
 * Public API
 * ────────────────────────────────────────────────────────────── */
export default {
  // PDF/HTML exports
  exportRecipePDF,
  exportInventoryLabels,
  exportMealPlanShare,

  // Agent exports
  exportAnimalHealthReport,
  exportBreedingPlan,
  exportButcheryCutSheet,
  exportBatchCookingPlan,
  exportPreservationPlan,
  exportProcurementList,
  exportRecipeConsolidationSummary,
  exportMealBundle,
  exportCleaningRoutine,
  exportGardenPlan,
  exportCompanionPlantingGuide,
  exportGardenEstimate,
  exportGardenHealth,
  exportGardenHarvestSchedule,
  exportSoilAndWaterReport,
  exportInventorySnapshot,
  exportStorehouseReport,
  exportWasteToCompostPlan,
  exportCookingStylesGuide,
  exportSausageBatchSheet,
  exportCureCalculatorSheet,
  exportFeedOptimizationReport,
  exportCookingSessionPlan,

  // Monetization helper (optional use)
  offerPaidDownload,

  // Persistence helpers
  latest: storage.latest,
};
