/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\pages\mealplanner\Import.jsx

import React, { useEffect, useMemo, useRef, useState } from "react";

const DOMAIN = "mealplanner";

/* -------------------------- Soft / Defensive Imports ----------------------- */
let eventBus = { emit: () => {} };
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const eb = require("@/services/events/eventBus.js");
  eventBus = eb?.default || eb?.eventBus || eb || eventBus;
} catch {
  try {
    // eslint-disable-next-line global-require
    const eb2 = require("../../services/events/eventBus");
    eventBus = eb2?.default || eb2?.eventBus || eb2 || eventBus;
  } catch {}
}

let featureFlags = {};
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  featureFlags = require("@/config/featureFlags.json");
  featureFlags = featureFlags?.default || featureFlags || {};
} catch {
  try {
    // eslint-disable-next-line global-require
    featureFlags = require("@/config/featureFlags.json");
    featureFlags = featureFlags?.default || featureFlags || {};
  } catch {
    featureFlags = {};
  }
}

let db = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const mod = require("@/services/db.js");
  db = mod?.db || mod?.default || mod || null;
} catch {
  try {
    // eslint-disable-next-line global-require
    const mod2 = require("../../services/db");
    db = mod2?.db || mod2?.default || mod2 || null;
  } catch {
    db = null;
  }
}

// Parser: domain-specific (must not crash if missing)
let mealPlannerParser = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  mealPlannerParser = require("@/import/parsers/mealPlannerParser.js");
  mealPlannerParser = mealPlannerParser?.default || mealPlannerParser || null;
} catch {
  mealPlannerParser = null;
}

// Optional normalizer (shared or domain-specific)
let ImportNormalizer = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  ImportNormalizer = require("@/import/ImportNormalizer.js");
  ImportNormalizer = ImportNormalizer?.default || ImportNormalizer || null;
} catch {
  ImportNormalizer = null;
}

// Optional engine (safe) — meal planner may exist under engines/mealplanner
let MealPlannerEngine = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  MealPlannerEngine = require("@/engines/mealplanner/MealPlannerEngine.js");
  MealPlannerEngine = MealPlannerEngine?.default || MealPlannerEngine || null;
} catch {
  MealPlannerEngine = null;
}

/* ------------------------------- Data Contracts ---------------------------- */
/**
 * ImportRaw
 * {
 *   id: string,
 *   domain: "mealplanner",
 *   createdAtISO: string,
 *   updatedAtISO: string,
 *   source: { kind:"url"|"text"|"file", url?:string, textPreview?:string, filename?:string, mime?:string, size?:number },
 *   raw: { url?:string, text?:string, fileMeta?:object },
 *   fingerprint?: string,
 * }
 *
 * ImportNormalized
 * {
 *   id: string,
 *   rawId: string,
 *   domain: "mealplanner",
 *   createdAtISO: string,
 *   updatedAtISO: string,
 *   confidence: { overall:number, fields: Record<string, number> },
 *   extracted: object,         // parser output (pre-edit)
 *   edits: { patches: Array<{ts:string, path:string, value:any}> },
 *   normalized: {
 *     kind: "mealplanner_import",
 *     title: string,
 *     summary: string,
 *     days: Array<{
 *       date?: string,                 // ISO date (optional)
 *       label?: string,                // "Mon" / "Day 1"
 *       meals: Array<{
 *         mealType: "breakfast"|"lunch"|"dinner"|"snack"|"other",
 *         title: string,
 *         servings?: number,
 *         recipes?: Array<{ title:string, sourceUrl?:string }>,
 *         notes?: string
 *       }>
 *     }>,
 *     constraints: {
 *       dietary?: string[],
 *       dislikes?: string[],
 *       budget?: { amount?: number, currency?: string },
 *       kitchen?: { equipment?: string[] },
 *     },
 *     groceryItems: Array<{ name:string, qty?:number, unit?:string, category?:string }>,
 *     notes?: string,
 *   }
 * }
 *
 * LinkMap
 * {
 *   id: string,
 *   rawId: string,
 *   normId: string,
 *   domain: "mealplanner",
 *   createdAtISO: string,
 *   updatedAtISO: string,
 *   links: {
 *     inventory: Array<{ localId?:string, name:string, qty?:number, unit?:string, confidence?:number }>,
 *     equipment: Array<{ localId?:string, name:string, confidence?:number }>,
 *     tags: Array<{ name:string, confidence?:number }>,
 *   }
 * }
 */

/* --------------------------------- Helpers -------------------------------- */
function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function safeEmit(type, payload) {
  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit({ type, ...payload });
    }
  } catch (e) {
    if (import.meta?.env?.DEV) console.warn("[Import] emit failed", type, e);
  }
}

function clamp01(n) {
  const x = Number(n);
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function toTextPreview(s, max = 400) {
  const str = String(s || "");
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pathSet(obj, path, value) {
  const root = obj && typeof obj === "object" ? obj : {};
  const parts = String(path || "").split(".");
  let cur = root;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const isLast = i === parts.length - 1;

    const m = part.match(/^([^\[]+)\[(\d+)\]$/);
    if (m) {
      const key = m[1];
      const idx = Number(m[2]);
      if (!Array.isArray(cur[key])) cur[key] = [];
      if (!cur[key][idx]) cur[key][idx] = {};
      if (isLast) cur[key][idx] = value;
      else cur = cur[key][idx];
      continue;
    }

    if (isLast) cur[part] = value;
    else {
      if (!cur[part] || typeof cur[part] !== "object") cur[part] = {};
      cur = cur[part];
    }
  }
  return root;
}

function ensureDbTablesOrExplain(dbInstance) {
  const required = [
    "importRaw",
    "importNormalized",
    "importLinkMaps",
    "importLogs",
  ];
  if (!dbInstance) {
    return {
      ok: false,
      message:
        "Dexie db module not found. Expected '@/services/db.js' (export default db OR named export db).",
    };
  }
  const missing = required.filter((t) => !dbInstance[t]);
  if (missing.length) {
    return {
      ok: false,
      message: `Dexie schema missing tables: ${missing.join(
        ", "
      )}. Add them in C:\\Users\\larho\\suka-smart-assistant\\src\\services\\db.js and bump db.version(+1).`,
    };
  }
  return { ok: true, message: "" };
}

function safeSplitLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function inferMealType(lineLower) {
  if (lineLower.includes("breakfast") || lineLower.startsWith("b:"))
    return "breakfast";
  if (lineLower.includes("lunch") || lineLower.startsWith("l:")) return "lunch";
  if (lineLower.includes("dinner") || lineLower.startsWith("d:"))
    return "dinner";
  if (lineLower.includes("snack") || lineLower.startsWith("s:")) return "snack";
  return "other";
}

/* -------------------------- Domain Fallback Parsing ------------------------- */
function fallbackParseMealPlanner({ url, text, fileName }) {
  // Must never throw. Heuristics tailored to meal planning.
  const logs = [];
  const rawText = String(text || "");
  const lines = safeSplitLines(rawText);
  const lower = rawText.toLowerCase();

  const extracted = {
    title: "",
    summary: "",
    days: [], // {label, date?, meals:[{mealType,title,servings?,recipes?,notes?}]}
    constraints: {
      dietary: [],
      dislikes: [],
      budget: {},
      kitchen: { equipment: [] },
    },
    groceryItems: [],
    notes: "",
    sourceHints: { url: url || "", fileName: fileName || "" },
  };

  try {
    const maybeJson = safeJsonParse(rawText);
    if (maybeJson && typeof maybeJson === "object") {
      logs.push({
        level: "info",
        msg: "Detected JSON input; attempting structured extraction.",
      });
      extracted.title = String(
        maybeJson.title || maybeJson.name || "Meal Plan"
      );
      extracted.summary = String(
        maybeJson.summary || maybeJson.description || ""
      );

      const days = maybeJson.days || maybeJson.week || maybeJson.plan || [];
      if (Array.isArray(days)) {
        extracted.days = days
          .map((d, i) => {
            if (!d) return null;
            const label = String(d.label || d.day || `Day ${i + 1}`);
            const date = d.date ? String(d.date) : "";
            const meals = Array.isArray(d.meals)
              ? d.meals
                  .map((m) => ({
                    mealType: String(m.mealType || m.type || "other"),
                    title: String(m.title || m.name || ""),
                    servings: m.servings == null ? null : Number(m.servings),
                    recipes: Array.isArray(m.recipes)
                      ? m.recipes.map((r) => ({
                          title: String(r.title || r.name || ""),
                          sourceUrl: r.sourceUrl ? String(r.sourceUrl) : "",
                        }))
                      : [],
                    notes: m.notes ? String(m.notes) : "",
                  }))
                  .filter((m) => m.title)
              : [];
            return { label, date, meals };
          })
          .filter(Boolean);
      }

      const c = maybeJson.constraints || {};
      extracted.constraints = {
        dietary: Array.isArray(c.dietary) ? c.dietary.map(String) : [],
        dislikes: Array.isArray(c.dislikes) ? c.dislikes.map(String) : [],
        budget: c.budget && typeof c.budget === "object" ? c.budget : {},
        kitchen:
          c.kitchen && typeof c.kitchen === "object"
            ? c.kitchen
            : { equipment: [] },
      };

      const gi = maybeJson.groceryItems || maybeJson.groceries || [];
      if (Array.isArray(gi)) {
        extracted.groceryItems = gi
          .map((x) => {
            if (typeof x === "string")
              return { name: x, qty: null, unit: "", category: "" };
            if (x && typeof x === "object") {
              return {
                name: String(x.name || x.item || ""),
                qty: x.qty == null ? null : Number(x.qty),
                unit: x.unit ? String(x.unit) : "",
                category: x.category ? String(x.category) : "",
              };
            }
            return null;
          })
          .filter((x) => x && x.name);
      }

      extracted.notes = String(maybeJson.notes || "");
      if (!extracted.summary && extracted.notes)
        extracted.summary = toTextPreview(extracted.notes, 180);

      return {
        extracted,
        confidence: {
          overall: 0.78,
          fields: { title: 0.85, days: 0.8, groceryItems: 0.75 },
        },
        logs,
      };
    }
  } catch (e) {
    logs.push({
      level: "warn",
      msg: `JSON extraction failed: ${String(e?.message || e)}`,
    });
  }

  // Text heuristics:
  // - Title: first line or inferred
  // - Days: lines with "Day 1" "Mon" "Tuesday" etc.
  // - Meals: lines like "Breakfast: Oatmeal", "B: Oatmeal"
  // - Groceries: lines starting "Grocery:" "Buy:" "Need:"
  // - Constraints: "No pork", "gluten-free", "budget $100", "dislikes: ..."
  extracted.title = lines[0]
    ? lines[0].slice(0, 120)
    : fileName
    ? `Meal Plan (${fileName})`
    : url
    ? "Meal Plan (Imported URL)"
    : "Meal Plan";
  extracted.summary = toTextPreview(lines.slice(1, 6).join(" "), 220);

  const dayHeaders = [];
  const dayRegex =
    /^(day\s*\d+|mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?)(\s*[:\-])?/i;

  lines.forEach((l) => {
    if (dayRegex.test(l)) dayHeaders.push(l);
  });

  // Build days by scanning; simple state machine
  let currentDay = null;
  const days = [];

  function pushDayIfNeeded() {
    if (currentDay && currentDay.meals.length) days.push(currentDay);
    currentDay = null;
  }

  lines.forEach((line) => {
    const ll = line.toLowerCase();

    // Constraints / dislikes / budget
    if (ll.includes("dislike:") || ll.includes("dislikes:")) {
      const v = line.split(":").slice(1).join(":").trim();
      if (v)
        extracted.constraints.dislikes = v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      return;
    }
    if (ll.includes("diet:") || ll.includes("dietary:")) {
      const v = line.split(":").slice(1).join(":").trim();
      if (v)
        extracted.constraints.dietary = v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      return;
    }
    if (ll.includes("budget")) {
      const m = line.match(/(\$|usd)?\s*([0-9]+(\.[0-9]+)?)\s*(usd)?/i);
      if (m)
        extracted.constraints.budget = {
          amount: Number(m[2]),
          currency: "USD",
        };
      return;
    }
    if (ll.includes("no pork") || ll.includes("pork-free")) {
      if (!extracted.constraints.dietary.includes("no-pork"))
        extracted.constraints.dietary.push("no-pork");
      return;
    }

    // Grocery hints
    if (
      ll.startsWith("grocery:") ||
      ll.startsWith("groceries:") ||
      ll.startsWith("buy:") ||
      ll.startsWith("need:")
    ) {
      const v = line.split(":").slice(1).join(":").trim();
      if (v)
        extracted.groceryItems.push({
          name: v,
          qty: null,
          unit: "",
          category: "",
        });
      return;
    }

    // Day header
    if (dayRegex.test(line)) {
      pushDayIfNeeded();
      const label = line.replace(/[:\-]\s*$/, "").trim();
      currentDay = { label, date: "", meals: [] };
      return;
    }

    // Meal line
    const mealMatch = line.match(
      /^(breakfast|lunch|dinner|snack|b|l|d|s)\s*[:\-]\s*(.*)$/i
    );
    if (mealMatch) {
      if (!currentDay)
        currentDay = { label: "Unlabeled Day", date: "", meals: [] };
      const mealType = inferMealType(mealMatch[1].toLowerCase());
      const mealTitle = String(mealMatch[2] || "").trim();
      if (mealTitle)
        currentDay.meals.push({
          mealType,
          title: mealTitle,
          servings: null,
          recipes: [],
          notes: "",
        });
      return;
    }

    // Bullet list might be meals if we have a day
    if (
      (ll.startsWith("-") || ll.startsWith("*") || ll.startsWith("•")) &&
      currentDay
    ) {
      const cleaned = line.replace(/^(-|\*|•)\s*/i, "").trim();
      if (cleaned)
        currentDay.meals.push({
          mealType: "other",
          title: cleaned,
          servings: null,
          recipes: [],
          notes: "",
        });
      return;
    }
  });

  pushDayIfNeeded();
  extracted.days = days.slice(0, 14);

  extracted.notes = toTextPreview(rawText, 1400);

  // If no days detected, create one with meals inferred from lines containing ":" patterns
  if (!extracted.days.length) {
    const inferredMeals = [];
    lines.forEach((line) => {
      const m = line.match(/^([^:]+)\s*:\s*(.*)$/);
      if (!m) return;
      const mealType = inferMealType(m[1].toLowerCase());
      const title = String(m[2] || "").trim();
      if (title)
        inferredMeals.push({
          mealType,
          title,
          servings: null,
          recipes: [],
          notes: "",
        });
    });
    if (inferredMeals.length) {
      extracted.days = [
        { label: "Imported", date: "", meals: inferredMeals.slice(0, 20) },
      ];
      logs.push({
        level: "info",
        msg: "No day headers found; inferred a single day from labeled lines.",
      });
    }
  }

  const confidence = {
    overall: clamp01(
      0.35 +
        (extracted.days.length ? 0.25 : 0) +
        (extracted.groceryItems.length ? 0.15 : 0) +
        (extracted.constraints.dietary.length ||
        extracted.constraints.dislikes.length
          ? 0.1
          : 0)
    ),
    fields: {
      title: extracted.title ? 0.7 : 0.2,
      days: extracted.days.length ? 0.75 : 0.2,
      groceryItems: extracted.groceryItems.length ? 0.65 : 0.2,
      constraints: extracted.constraints ? 0.55 : 0.2,
    },
  };

  logs.push({ level: "info", msg: "Used fallback meal planner heuristics." });
  if (url) logs.push({ level: "info", msg: `Source URL provided: ${url}` });
  if (fileName)
    logs.push({ level: "info", msg: `Source file provided: ${fileName}` });
  if (
    lower.includes("meal prep") ||
    lower.includes("mealplan") ||
    lower.includes("grocery")
  ) {
    logs.push({
      level: "info",
      msg: "Detected meal plan keywords (meal prep/mealplan/grocery).",
    });
  }

  return { extracted, confidence, logs };
}

/* --------------------------- Domain Normalization --------------------------- */
function fallbackNormalizeMealPlanner(extracted, patches) {
  const ex = extracted && typeof extracted === "object" ? extracted : {};
  const p = Array.isArray(patches) ? patches : [];

  const title = String(ex.title || "Meal Plan Import");
  const summary = String(ex.summary || "");

  const days = Array.isArray(ex.days)
    ? ex.days
        .map((d, i) => ({
          date: d?.date ? String(d.date) : "",
          label: d?.label ? String(d.label) : `Day ${i + 1}`,
          meals: Array.isArray(d?.meals)
            ? d.meals
                .map((m) => ({
                  mealType: String(m?.mealType || "other"),
                  title: String(m?.title || "").trim(),
                  servings: m?.servings == null ? null : Number(m.servings),
                  recipes: Array.isArray(m?.recipes)
                    ? m.recipes
                        .map((r) => ({
                          title: String(r?.title || "").trim(),
                          sourceUrl: r?.sourceUrl ? String(r.sourceUrl) : "",
                        }))
                        .filter((r) => r.title)
                    : [],
                  notes: m?.notes ? String(m.notes) : "",
                }))
                .filter((m) => m.title)
            : [],
        }))
        .filter((d) => d.meals.length)
    : [];

  const constraints =
    ex.constraints && typeof ex.constraints === "object" ? ex.constraints : {};
  const dietary = Array.isArray(constraints.dietary)
    ? constraints.dietary.map(String)
    : [];
  const dislikes = Array.isArray(constraints.dislikes)
    ? constraints.dislikes.map(String)
    : [];
  const budget =
    constraints.budget && typeof constraints.budget === "object"
      ? constraints.budget
      : {};
  const kitchen =
    constraints.kitchen && typeof constraints.kitchen === "object"
      ? constraints.kitchen
      : { equipment: [] };

  const groceryItems = Array.isArray(ex.groceryItems)
    ? ex.groceryItems
        .map((g) => ({
          name: g?.name ? String(g.name) : "",
          qty: g?.qty == null ? null : Number(g.qty),
          unit: g?.unit ? String(g.unit) : "",
          category: g?.category ? String(g.category) : "",
        }))
        .filter((g) => g.name)
    : [];

  const notes = ex.notes ? String(ex.notes) : "";

  const assumptions = [];
  if (p.length)
    assumptions.push(`User applied ${p.length} edits during import.`);
  if (!days.length)
    assumptions.push(
      "No days/meals detected; importer may require manual edits."
    );

  return {
    kind: "mealplanner_import",
    title,
    summary,
    days,
    constraints: { dietary, dislikes, budget, kitchen },
    groceryItems,
    notes,
    assumptions,
  };
}

/* --------------------------- Draft Generation ------------------------------ */
async function generateDraftResolved({ normalized, linkMap }) {
  const norm = normalized && typeof normalized === "object" ? normalized : {};
  const links = linkMap && typeof linkMap === "object" ? linkMap : {};

  // Try engine if present
  try {
    if (
      MealPlannerEngine &&
      typeof MealPlannerEngine.createDraftFromImport === "function"
    ) {
      const res = await MealPlannerEngine.createDraftFromImport({
        domain: DOMAIN,
        normalized: norm,
        linkMap: links,
      });
      if (res && typeof res === "object" && res.id) return res;
    }
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[Import] engine draft failed; falling back", e);
  }

  // Fallback: build a resolved “meal plan session draft”
  const title = String(norm?.title || "Meal Plan Draft");
  const summary = String(norm?.summary || "");

  const days = Array.isArray(norm?.days) ? norm.days : [];
  const groceryItems = Array.isArray(norm?.groceryItems)
    ? norm.groceryItems
    : [];
  const tasks = [];

  days.forEach((d) => {
    const label = d?.label || d?.date || "Day";
    const meals = Array.isArray(d?.meals) ? d.meals : [];
    meals.forEach((m) => {
      if (!m?.title) return;
      tasks.push({
        id: makeId("task"),
        label: `${label}: ${String(m.mealType || "meal").toUpperCase()} — ${
          m.title
        }`,
        type: "meal",
        estMinutes: 10,
        notes: m.notes || "",
      });
    });
  });

  groceryItems.forEach((g) => {
    if (!g?.name) return;
    tasks.push({
      id: makeId("task"),
      label: `Grocery: ${g.name}${
        g.qty != null ? ` (${g.qty}${g.unit ? ` ${g.unit}` : ""})` : ""
      }`,
      type: "grocery",
      estMinutes: 3,
      notes: g.category ? `Category: ${g.category}` : "",
    });
  });

  const sections = [
    { id: makeId("sec"), title: "Days & Meals", items: days },
    { id: makeId("sec"), title: "Grocery Items", items: groceryItems },
    { id: makeId("sec"), title: "Constraints", items: norm?.constraints || {} },
  ];

  return {
    id: makeId("mealplannerDraft"),
    domain: DOMAIN,
    title,
    summary,
    assumptions: Array.isArray(norm?.assumptions) ? norm.assumptions : [],
    sections,
    tasks,
    inventoryAlerts: [],
    healthReminders: [],
    meta: {
      createdAt: nowIso(),
      source: "import.fallbackDraft",
      linkSummary: {
        inventory: Array.isArray(links?.inventory) ? links.inventory.length : 0,
        equipment: Array.isArray(links?.equipment) ? links.equipment.length : 0,
        tags: Array.isArray(links?.tags) ? links.tags.length : 0,
      },
    },
  };
}

/* -------------------------------- UI Helpers ------------------------------ */
function StepPill({ active, label, idx }) {
  return (
    <div className={`ssaStepPill ${active ? "active" : ""}`}>
      <div className="ssaStepPillNum">{idx + 1}</div>
      <div className="ssaStepPillLabel">{label}</div>
    </div>
  );
}

function EmptyState({ title, detail }) {
  return (
    <div className="ssaEmpty">
      <div className="ssaEmptyTitle">{title}</div>
      {detail ? <div className="ssaEmptyDetail">{detail}</div> : null}
    </div>
  );
}

function TableEditor({ rows, onChange, columns, emptyLabel }) {
  const safeRows = Array.isArray(rows) ? rows : [];

  function addRow() {
    const blank = {};
    columns.forEach((c) => {
      blank[c.key] = c.defaultValue != null ? c.defaultValue : "";
    });
    onChange([...safeRows, blank]);
  }

  function removeRow(i) {
    const next = safeRows.slice();
    next.splice(i, 1);
    onChange(next);
  }

  function updateCell(i, key, value) {
    const next = safeRows.slice();
    next[i] = { ...(next[i] || {}), [key]: value };
    onChange(next);
  }

  return (
    <div className="ssaTableWrap">
      {safeRows.length ? (
        <table className="ssaTable">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {safeRows.map((r, i) => (
              <tr key={`row_${i}`}>
                {columns.map((c) => (
                  <td key={c.key}>
                    <input
                      className="ssaInput"
                      value={r?.[c.key] ?? ""}
                      onChange={(e) => updateCell(i, c.key, e.target.value)}
                      placeholder={c.placeholder || ""}
                    />
                  </td>
                ))}
                <td className="ssaTdActions">
                  <button
                    type="button"
                    className="ssaBtn ghost"
                    onClick={() => removeRow(i)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState
          title={emptyLabel || "No rows yet"}
          detail="Add rows to map/link SSA entities."
        />
      )}
      <div className="ssaRow">
        <button type="button" className="ssaBtn" onClick={addRow}>
          + Add row
        </button>
      </div>
    </div>
  );
}

/* -------------------------------- Main Page ------------------------------- */
export default function ImportMealPlannerPage() {
  // Wizard steps
  const STEPS = useMemo(
    () => [
      { key: "source", label: "Source" },
      { key: "preview", label: "Parse Preview" },
      { key: "edit", label: "Edit Fields" },
      { key: "normalize", label: "Normalize" },
      { key: "link", label: "Map / Link" },
      { key: "save", label: "Save" },
    ],
    []
  );

  const [stepIdx, setStepIdx] = useState(0);

  // Source inputs
  const [sourceKind, setSourceKind] = useState("url"); // url | text | file
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [fileObj, setFileObj] = useState(null);

  // Pipeline state
  const [raw, setRaw] = useState(null);
  const [parsed, setParsed] = useState(null); // { extracted, confidence, logs }
  const [normalized, setNormalized] = useState(null); // ImportNormalized object
  const [linkMap, setLinkMap] = useState(null); // LinkMap object
  const [patches, setPatches] = useState([]); // [{ts,path,value}]
  const [dirty, setDirty] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);

  // Logs + status
  const [pipelineLogs, setPipelineLogs] = useState([]); // {ts, level, msg, stage}
  const [status, setStatus] = useState({ kind: "idle", msg: "" }); // idle | working | error | success
  const [saveError, setSaveError] = useState("");
  const [savedIds, setSavedIds] = useState({
    rawId: "",
    normId: "",
    linkMapId: "",
  });

  // Draft
  const [draft, setDraft] = useState(null);
  const draftRef = useRef(null);

  const dbCheck = useMemo(() => ensureDbTablesOrExplain(db), [db]);

  function log(stage, level, msg) {
    const entry = { id: makeId("log"), ts: nowIso(), stage, level, msg };
    setPipelineLogs((prev) => [entry, ...(prev || [])]);
    return entry;
  }

  // Events: import.page.opened
  useEffect(() => {
    safeEmit("import.page.opened", { domain: DOMAIN, ts: nowIso() });
    log("page", "info", "Import page opened.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentStep = STEPS[stepIdx]?.key;

  const canGoNext = useMemo(() => {
    if (currentStep === "source") {
      if (sourceKind === "url") return Boolean(url.trim());
      if (sourceKind === "text") return Boolean(text.trim());
      if (sourceKind === "file") return Boolean(fileObj);
      return false;
    }
    if (currentStep === "preview") return Boolean(parsed?.extracted);
    if (currentStep === "edit") return Boolean(parsed?.extracted);
    if (currentStep === "normalize") return Boolean(normalized?.id);
    if (currentStep === "link") return Boolean(linkMap?.id);
    if (currentStep === "save") return true;
    return true;
  }, [
    currentStep,
    fileObj,
    parsed,
    normalized,
    linkMap,
    sourceKind,
    url,
    text,
  ]);

  function nextStep() {
    if (!canGoNext) return;
    setStepIdx((i) => Math.min(i + 1, STEPS.length - 1));
  }

  function prevStep() {
    setStepIdx((i) => Math.max(i - 1, 0));
  }

  function resetAll() {
    setRaw(null);
    setParsed(null);
    setNormalized(null);
    setLinkMap(null);
    setPatches([]);
    setDirty(false);
    setLastSaved(null);
    setPipelineLogs([]);
    setStatus({ kind: "idle", msg: "" });
    setSaveError("");
    setSavedIds({ rawId: "", normId: "", linkMapId: "" });
    setDraft(null);
    draftRef.current = null;
    setStepIdx(0);
  }

  async function readFileAsText(file) {
    return new Promise((resolve) => {
      try {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => resolve("");
        reader.readAsText(file);
      } catch {
        resolve("");
      }
    });
  }

  async function receiveImport() {
    setStatus({ kind: "working", msg: "Receiving import…" });
    setSaveError("");

    const id = makeId("importRaw");
    const createdAtISO = nowIso();

    const src = { kind: sourceKind };
    const rawPayload = { url: "", text: "", fileMeta: null };

    if (sourceKind === "url") {
      src.url = url.trim();
      rawPayload.url = src.url;
      rawPayload.text = "";
    } else if (sourceKind === "text") {
      src.textPreview = toTextPreview(text, 400);
      rawPayload.text = text;
    } else if (sourceKind === "file") {
      const f = fileObj;
      src.filename = f?.name || "import.txt";
      src.mime = f?.type || "text/plain";
      src.size = f?.size || 0;
      const fileText = await readFileAsText(f);
      rawPayload.text = fileText;
      rawPayload.fileMeta = {
        name: src.filename,
        mime: src.mime,
        size: src.size,
      };
    }

    const rawObj = {
      id,
      domain: DOMAIN,
      createdAtISO,
      updatedAtISO: createdAtISO,
      source: src,
      raw: rawPayload,
      fingerprint: `${DOMAIN}:${src.kind}:${
        src.url || src.filename || ""
      }:${createdAtISO}`,
    };

    setRaw(rawObj);

    safeEmit("import.received", {
      domain: DOMAIN,
      rawId: rawObj.id,
      source: rawObj.source,
      ts: nowIso(),
    });

    log("receive", "info", `Import received (${sourceKind}).`);
    setStatus({ kind: "success", msg: "Import received." });
    return rawObj;
  }

  async function runParse() {
    setStatus({ kind: "working", msg: "Parsing…" });
    setSaveError("");

    const r = raw || (await receiveImport());
    if (!r) {
      setStatus({ kind: "error", msg: "No raw import available." });
      return null;
    }

    const stageLogs = [];
    const contentText = String(r?.raw?.text || "");
    const theUrl = String(r?.raw?.url || r?.source?.url || "");
    const fileName = String(r?.source?.filename || "");

    let out = null;

    // Prefer parser module if present
    try {
      if (mealPlannerParser) {
        const fn =
          mealPlannerParser.parse ||
          mealPlannerParser.parseMealPlanner ||
          mealPlannerParser.default?.parse;
        if (typeof fn === "function") {
          stageLogs.push(
            log("parse", "info", "Using mealPlannerParser module.")
          );
          out = await fn({
            url: theUrl,
            text: contentText,
            fileName,
            domain: DOMAIN,
          });
        }
      }
    } catch (e) {
      stageLogs.push(
        log(
          "parse",
          "warn",
          `Parser module threw; fallback used. (${String(e?.message || e)})`
        )
      );
      out = null;
    }

    if (!out || typeof out !== "object") {
      stageLogs.push(log("parse", "info", "Using fallback parser heuristics."));
      out = fallbackParseMealPlanner({
        url: theUrl,
        text: contentText,
        fileName,
      });
    }

    const parsedObj = {
      extracted: out?.extracted || {},
      confidence: out?.confidence || { overall: 0.3, fields: {} },
      logs: Array.isArray(out?.logs) ? out.logs : [],
    };

    setParsed(parsedObj);

    safeEmit("import.parsed", {
      domain: DOMAIN,
      rawId: r.id,
      extracted: parsedObj.extracted,
      confidence: parsedObj.confidence,
      ts: nowIso(),
    });

    log("parse", "success", "Parse completed.");
    setStatus({ kind: "success", msg: "Parsed." });
    return parsedObj;
  }

  function applyEdit(path, value) {
    const ts = nowIso();
    setPatches((prev) => [...(prev || []), { ts, path, value }]);
    setDirty(true);

    setParsed((prev) => {
      const next = prev
        ? { ...prev }
        : { extracted: {}, confidence: { overall: 0.3, fields: {} }, logs: [] };
      next.extracted = pathSet({ ...(next.extracted || {}) }, path, value);
      return next;
    });
  }

  async function runNormalize() {
    setStatus({ kind: "working", msg: "Normalizing…" });
    setSaveError("");

    const r = raw || (await receiveImport());
    const p = parsed || (await runParse());
    if (!r || !p) {
      setStatus({
        kind: "error",
        msg: "Missing raw/parsed input for normalization.",
      });
      return null;
    }

    let normalizedPayload = null;
    try {
      if (ImportNormalizer) {
        const fn =
          ImportNormalizer.normalizeMealPlanner ||
          ImportNormalizer.normalize?.mealplanner ||
          ImportNormalizer.normalize;
        if (typeof fn === "function") {
          log("normalize", "info", "Using ImportNormalizer module.");
          normalizedPayload = await fn({
            domain: DOMAIN,
            extracted: p.extracted,
            patches,
          });
        }
      }
    } catch (e) {
      log(
        "normalize",
        "warn",
        `ImportNormalizer threw; fallback used. (${String(e?.message || e)})`
      );
      normalizedPayload = null;
    }

    if (!normalizedPayload || typeof normalizedPayload !== "object") {
      normalizedPayload = fallbackNormalizeMealPlanner(p.extracted, patches);
      log("normalize", "info", "Fallback normalization applied.");
    }

    const normObj = {
      id: makeId("importNorm"),
      rawId: r.id,
      domain: DOMAIN,
      createdAtISO: nowIso(),
      updatedAtISO: nowIso(),
      confidence: {
        overall: clamp01(p?.confidence?.overall ?? 0.45),
        fields: p?.confidence?.fields || {},
      },
      extracted: p.extracted || {},
      edits: { patches: Array.isArray(patches) ? patches : [] },
      normalized: normalizedPayload,
    };

    setNormalized(normObj);

    safeEmit("import.normalized", {
      domain: DOMAIN,
      rawId: r.id,
      normId: normObj.id,
      confidence: normObj.confidence,
      normalized: normObj.normalized,
      ts: nowIso(),
    });

    log("normalize", "success", "Normalization completed.");
    setStatus({ kind: "success", msg: "Normalized." });
    return normObj;
  }

  function initLinkMapIfMissing() {
    const rId = raw?.id || "";
    const nId = normalized?.id || "";
    if (!rId || !nId) return null;

    if (linkMap && linkMap.id) return linkMap;

    const lm = {
      id: makeId("linkMap"),
      rawId: rId,
      normId: nId,
      domain: DOMAIN,
      createdAtISO: nowIso(),
      updatedAtISO: nowIso(),
      links: {
        inventory: [],
        equipment: [],
        tags: [],
      },
    };
    setLinkMap(lm);
    return lm;
  }

  function finalizeLinks() {
    const lm = initLinkMapIfMissing();
    if (!lm) {
      setStatus({
        kind: "error",
        msg: "Cannot finalize links without raw+normalized.",
      });
      return;
    }
    setLinkMap((prev) => {
      const next = prev ? { ...prev } : lm;
      next.updatedAtISO = nowIso();
      return next;
    });

    safeEmit("import.linked", {
      domain: DOMAIN,
      rawId: lm.rawId,
      normId: lm.normId,
      linkMapId: lm.id,
      links: lm.links,
      ts: nowIso(),
    });

    log("link", "success", "Links finalized.");
    setStatus({ kind: "success", msg: "Linked." });
  }

  function detectShortagesHeuristic(lm) {
    const inv = Array.isArray(lm?.links?.inventory) ? lm.links.inventory : [];
    const shortages = inv
      .filter((x) => x && x.name && !x.localId)
      .slice(0, 18)
      .map((x) => ({
        item: String(x.name),
        neededQty: x.qty == null ? 1 : Number(x.qty),
        unit: x.unit ? String(x.unit) : "",
      }));
    return shortages;
  }

  async function saveAll() {
    setStatus({ kind: "working", msg: "Saving to Dexie…" });
    setSaveError("");

    const check = ensureDbTablesOrExplain(db);
    if (!check.ok) {
      setSaveError(check.message);
      setStatus({ kind: "error", msg: "Dexie schema not ready." });
      log("save", "error", check.message);
      return null;
    }

    const r = raw || (await receiveImport());
    const p = parsed || (await runParse());
    const n = normalized || (await runNormalize());
    const lm = linkMap?.id ? linkMap : initLinkMapIfMissing();

    if (!r || !p || !n || !lm) {
      const msg =
        "Missing one or more pipeline objects (raw/parsed/normalized/linkMap).";
      setSaveError(msg);
      setStatus({ kind: "error", msg });
      log("save", "error", msg);
      return null;
    }

    const logRows = [];
    const parseLogs = Array.isArray(p?.logs) ? p.logs : [];
    parseLogs.forEach((pl) => {
      logRows.push({
        id: makeId("importLog"),
        domain: DOMAIN,
        rawId: r.id,
        normId: n.id,
        linkMapId: lm.id,
        ts: nowIso(),
        level: pl?.level || "info",
        msg: pl?.msg || String(pl),
        stage: "parse",
      });
    });

    (pipelineLogs || []).slice(0, 60).forEach((l) => {
      logRows.push({
        id: l.id || makeId("importLog"),
        domain: DOMAIN,
        rawId: r.id,
        normId: n.id,
        linkMapId: lm.id,
        ts: l.ts || nowIso(),
        level: l.level || "info",
        msg: l.msg || "",
        stage: l.stage || "pipeline",
      });
    });

    try {
      await db.importRaw.put({ ...r, updatedAtISO: nowIso() });
      await db.importNormalized.put({ ...n, updatedAtISO: nowIso() });
      await db.importLinkMaps.put({ ...lm, updatedAtISO: nowIso() });
      if (logRows.length) await db.importLogs.bulkPut(logRows);

      setLastSaved(nowIso());
      setDirty(false);
      setSavedIds({ rawId: r.id, normId: n.id, linkMapId: lm.id });
      setStatus({ kind: "success", msg: "Saved." });
      log(
        "save",
        "success",
        "Saved raw + normalized + linkMap + logs to Dexie."
      );

      const shortages = detectShortagesHeuristic(lm);
      if (shortages.length) {
        safeEmit("inventory.shortage.detected", {
          domain: DOMAIN,
          rawId: r.id,
          normId: n.id,
          shortages,
          ts: nowIso(),
        });
        log(
          "save",
          "info",
          `Shortage heuristic detected ${shortages.length} items.`
        );
      }

      return { rawId: r.id, normId: n.id, linkMapId: lm.id };
    } catch (e) {
      const msg = `Save failed: ${String(e?.message || e)}`;
      setSaveError(msg);
      setStatus({ kind: "error", msg: "Save failed." });
      log("save", "error", msg);
      return null;
    }
  }

  async function generateDraft() {
    setStatus({ kind: "working", msg: "Generating draft…" });
    setSaveError("");

    const r = raw || (await receiveImport());
    const n = normalized || (await runNormalize());
    const lm = linkMap?.id ? linkMap : initLinkMapIfMissing();

    if (!r || !n || !lm) {
      const msg = "Draft generation requires raw + normalized + linkMap.";
      setStatus({ kind: "error", msg });
      log("draft", "error", msg);
      return null;
    }

    const resolved = await generateDraftResolved({
      normalized: n.normalized,
      linkMap: lm.links,
    });

    setDraft(resolved);
    draftRef.current = resolved;

    safeEmit("session.draft.created", {
      domain: DOMAIN,
      rawId: r.id,
      normId: n.id,
      linkMapId: lm.id,
      draftId: resolved.id,
      ts: nowIso(),
    });

    log("draft", "success", "Session draft created.");

    // TODO: Hub export only if familyFundMode=true (DO NOT implement network)
    if (featureFlags?.familyFundMode === true) {
      log("hub", "info", "TODO: export draft to Hub (familyFundMode enabled).");
    }

    setStatus({ kind: "success", msg: "Draft created." });
    return resolved;
  }

  // Link map editors
  const linkInventoryCols = useMemo(
    () => [
      {
        key: "localId",
        label: "Local ID (optional)",
        placeholder: "inventory row id",
        defaultValue: "",
      },
      {
        key: "name",
        label: "Item Name",
        placeholder: "e.g., chicken thighs, oats",
        defaultValue: "",
      },
      {
        key: "qty",
        label: "Qty (optional)",
        placeholder: "e.g., 2",
        defaultValue: "",
      },
      {
        key: "unit",
        label: "Unit (optional)",
        placeholder: "e.g., lb, cups",
        defaultValue: "",
      },
      {
        key: "confidence",
        label: "Confidence (0-1)",
        placeholder: "0.8",
        defaultValue: "",
      },
    ],
    []
  );

  const linkEquipmentCols = useMemo(
    () => [
      {
        key: "localId",
        label: "Local ID (optional)",
        placeholder: "equipment id",
        defaultValue: "",
      },
      {
        key: "name",
        label: "Equipment",
        placeholder: "e.g., skillet, slow cooker",
        defaultValue: "",
      },
      {
        key: "confidence",
        label: "Confidence (0-1)",
        placeholder: "0.9",
        defaultValue: "",
      },
    ],
    []
  );

  const linkTagCols = useMemo(
    () => [
      {
        key: "name",
        label: "Tag",
        placeholder: "e.g., week1, low-carb, no-pork",
        defaultValue: "",
      },
      {
        key: "confidence",
        label: "Confidence (0-1)",
        placeholder: "0.8",
        defaultValue: "",
      },
    ],
    []
  );

  async function handlePrimaryAction() {
    if (currentStep === "source") {
      await receiveImport();
      await runParse();
      nextStep();
      return;
    }
    if (currentStep === "preview") {
      if (!parsed) await runParse();
      nextStep();
      return;
    }
    if (currentStep === "edit") {
      nextStep();
      return;
    }
    if (currentStep === "normalize") {
      if (!normalized) await runNormalize();
      nextStep();
      return;
    }
    if (currentStep === "link") {
      finalizeLinks();
      nextStep();
      return;
    }
    if (currentStep === "save") {
      await saveAll();
    }
  }

  const extracted = parsed?.extracted || null;
  const conf = parsed?.confidence ||
    normalized?.confidence || { overall: 0, fields: {} };

  const dayCount = Array.isArray(extracted?.days) ? extracted.days.length : 0;
  const mealCount = Array.isArray(extracted?.days)
    ? extracted.days.reduce(
        (acc, d) => acc + (Array.isArray(d?.meals) ? d.meals.length : 0),
        0
      )
    : 0;
  const groceryCount = Array.isArray(extracted?.groceryItems)
    ? extracted.groceryItems.length
    : 0;

  return (
    <div className="ssaImportPage">
      <style>{`
        .ssaImportPage{padding:16px;max-width:1200px;margin:0 auto;color:#111}
        .ssaHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}
        .ssaTitle{font-size:22px;font-weight:800;line-height:1.2}
        .ssaSub{font-size:13px;opacity:.75;margin-top:4px}
        .ssaCard{border:1px solid rgba(0,0,0,.12);border-radius:14px;padding:14px;background:#fff;box-shadow:0 6px 18px rgba(0,0,0,.04)}
        .ssaGrid{display:grid;grid-template-columns: 1.1fr .9fr;gap:12px}
        @media (max-width: 980px){.ssaGrid{grid-template-columns:1fr}}
        .ssaSteps{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 12px}
        .ssaStepPill{display:flex;align-items:center;gap:8px;border:1px solid rgba(0,0,0,.12);border-radius:999px;padding:6px 10px;background:#fafafa}
        .ssaStepPill.active{background:#111;color:#fff;border-color:#111}
        .ssaStepPillNum{width:22px;height:22px;border-radius:999px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.08);font-weight:800}
        .ssaStepPill.active .ssaStepPillNum{background:rgba(255,255,255,.18)}
        .ssaStepPillLabel{font-size:12px;font-weight:700}
        .ssaRow{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}
        .ssaInput,.ssaTextarea,.ssaSelect{width:100%;border:1px solid rgba(0,0,0,.18);border-radius:10px;padding:10px;font-size:14px;outline:none}
        .ssaTextarea{min-height:140px;resize:vertical}
        .ssaSelect{background:#fff}
        .ssaBtn{border:1px solid rgba(0,0,0,.16);background:#111;color:#fff;border-radius:10px;padding:10px 12px;font-weight:800;cursor:pointer}
        .ssaBtn:disabled{opacity:.45;cursor:not-allowed}
        .ssaBtn.ghost{background:transparent;color:#111}
        .ssaBtn.soft{background:#f3f3f3;color:#111}
        .ssaKpi{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}
        .ssaKpiBox{border:1px dashed rgba(0,0,0,.18);border-radius:12px;padding:10px 12px;min-width:140px}
        .ssaKpiLabel{font-size:12px;opacity:.7}
        .ssaKpiVal{font-size:16px;font-weight:900;margin-top:2px}
        .ssaDivider{height:1px;background:rgba(0,0,0,.08);margin:12px 0}
        .ssaEmpty{border:1px dashed rgba(0,0,0,.2);border-radius:12px;padding:12px;background:#fcfcfc}
        .ssaEmptyTitle{font-weight:900}
        .ssaEmptyDetail{opacity:.75;margin-top:4px;font-size:13px}
        .ssaStatus{font-size:13px;padding:8px 10px;border-radius:10px;border:1px solid rgba(0,0,0,.12);background:#fafafa}
        .ssaStatus.working{background:#fff7e6;border-color:#f1d39c}
        .ssaStatus.error{background:#ffecec;border-color:#ffb3b3}
        .ssaStatus.success{background:#eaffe9;border-color:#b6f2b5}
        .ssaTableWrap{margin-top:10px}
        .ssaTable{width:100%;border-collapse:separate;border-spacing:0 8px}
        .ssaTable th{font-size:12px;text-align:left;opacity:.7;padding:0 8px}
        .ssaTable td{padding:0 8px}
        .ssaTdActions{white-space:nowrap}
        .ssaTwoCol{display:grid;grid-template-columns:1fr 1fr;gap:10px}
        @media (max-width:720px){.ssaTwoCol{grid-template-columns:1fr}}
        .ssaMuted{opacity:.7;font-size:13px}
        .ssaWarn{color:#8a3b00}
        .ssaMono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size:12px}
      `}</style>

      <div className="ssaHeader">
        <div>
          <div className="ssaTitle">Meal Planner Import</div>
          <div className="ssaSub">
            Import meal plans → parse → normalize → link to SSA
            inventory/equipment/tags → save → draft.
          </div>
        </div>

        <div style={{ minWidth: 280 }} className={`ssaStatus ${status.kind}`}>
          <div style={{ fontWeight: 900 }}>
            {status.kind === "idle" ? "Ready" : status.kind.toUpperCase()}
          </div>
          <div className="ssaMuted">{status.msg || " "}</div>
          {dirty ? <div className="ssaWarn">Unsaved edits</div> : null}
          {lastSaved ? (
            <div className="ssaMuted">Last saved: {lastSaved}</div>
          ) : null}
        </div>
      </div>

      {!dbCheck.ok ? (
        <div className="ssaCard" style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>
            Dexie schema required
          </div>
          <div className="ssaMuted">{dbCheck.message}</div>
        </div>
      ) : null}

      <div className="ssaSteps">
        {STEPS.map((s, idx) => (
          <StepPill
            key={s.key}
            idx={idx}
            label={s.label}
            active={idx === stepIdx}
          />
        ))}
      </div>

      <div className="ssaGrid">
        {/* Left: Wizard Step */}
        <div className="ssaCard">
          {currentStep === "source" ? (
            <>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>A) Source</div>

              <div className="ssaTwoCol">
                <div>
                  <div className="ssaMuted" style={{ marginBottom: 6 }}>
                    Source type
                  </div>
                  <select
                    className="ssaSelect"
                    value={sourceKind}
                    onChange={(e) => setSourceKind(e.target.value)}
                  >
                    <option value="url">URL</option>
                    <option value="text">Text</option>
                    <option value="file">File</option>
                  </select>
                </div>
                <div>
                  <div className="ssaMuted" style={{ marginBottom: 6 }}>
                    Quick actions
                  </div>
                  <div className="ssaRow">
                    <button
                      type="button"
                      className="ssaBtn soft"
                      onClick={resetAll}
                    >
                      Reset
                    </button>
                    <button
                      type="button"
                      className="ssaBtn ghost"
                      onClick={() => setText("")}
                    >
                      Clear Text
                    </button>
                  </div>
                </div>
              </div>

              <div className="ssaDivider" />

              {sourceKind === "url" ? (
                <>
                  <div className="ssaMuted" style={{ marginBottom: 6 }}>
                    Paste URL (SSA will not fetch network here; URL used as hint
                    only)
                  </div>
                  <input
                    className="ssaInput"
                    placeholder="https://…"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                  <div className="ssaMuted" style={{ marginTop: 8 }}>
                    Tip: If you want reliable results, paste the meal plan
                    content into Text mode.
                  </div>
                </>
              ) : null}

              {sourceKind === "text" ? (
                <>
                  <div className="ssaMuted" style={{ marginBottom: 6 }}>
                    Paste meal plan text (days, meals, groceries, constraints)
                  </div>
                  <textarea
                    className="ssaTextarea"
                    placeholder={`Example:\nMon:\nBreakfast: Eggs & waffles\nLunch: Chicken salad\nDinner: Beef stew\nGroceries: eggs\nGroceries: beef chuck\nDietary: no-pork\n`}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                </>
              ) : null}

              {sourceKind === "file" ? (
                <>
                  <div className="ssaMuted" style={{ marginBottom: 6 }}>
                    Choose a file (txt/json recommended)
                  </div>
                  <input
                    type="file"
                    onChange={(e) => setFileObj(e.target.files?.[0] || null)}
                  />
                  {fileObj ? (
                    <div className="ssaMuted" style={{ marginTop: 8 }}>
                      Selected: <span className="ssaMono">{fileObj.name}</span>
                    </div>
                  ) : null}
                </>
              ) : null}

              <div className="ssaRow" style={{ marginTop: 14 }}>
                <button
                  type="button"
                  className="ssaBtn"
                  onClick={handlePrimaryAction}
                  disabled={!canGoNext}
                >
                  Receive + Parse
                </button>
              </div>
            </>
          ) : null}

          {currentStep === "preview" ? (
            <>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>
                B) Parse Preview
              </div>
              {!parsed?.extracted ? (
                <EmptyState
                  title="No parsed data yet"
                  detail="Run Parse from the Source step."
                />
              ) : (
                <>
                  <div className="ssaKpi">
                    <div className="ssaKpiBox">
                      <div className="ssaKpiLabel">Confidence</div>
                      <div className="ssaKpiVal">
                        {Math.round((conf?.overall || 0) * 100)}%
                      </div>
                    </div>
                    <div className="ssaKpiBox">
                      <div className="ssaKpiLabel">Days</div>
                      <div className="ssaKpiVal">{dayCount}</div>
                    </div>
                    <div className="ssaKpiBox">
                      <div className="ssaKpiLabel">Meals</div>
                      <div className="ssaKpiVal">{mealCount}</div>
                    </div>
                    <div className="ssaKpiBox">
                      <div className="ssaKpiLabel">Groceries</div>
                      <div className="ssaKpiVal">{groceryCount}</div>
                    </div>
                  </div>

                  <div className="ssaDivider" />

                  <div className="ssaMuted" style={{ marginBottom: 6 }}>
                    Extracted JSON (read-only preview)
                  </div>
                  <pre
                    className="ssaCard ssaMono"
                    style={{
                      background: "#fafafa",
                      borderRadius: 12,
                      overflowX: "auto",
                    }}
                  >
                    {JSON.stringify(parsed.extracted, null, 2)}
                  </pre>
                </>
              )}

              <div className="ssaRow">
                <button
                  type="button"
                  className="ssaBtn ghost"
                  onClick={prevStep}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="ssaBtn"
                  onClick={handlePrimaryAction}
                  disabled={!canGoNext}
                >
                  Next: Edit
                </button>
              </div>
            </>
          ) : null}

          {currentStep === "edit" ? (
            <>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>
                C) Edit Fields
              </div>

              {!parsed?.extracted ? (
                <EmptyState title="Nothing to edit yet" detail="Parse first." />
              ) : (
                <>
                  <div className="ssaMuted" style={{ marginBottom: 6 }}>
                    Title
                  </div>
                  <input
                    className="ssaInput"
                    value={parsed?.extracted?.title || ""}
                    onChange={(e) => applyEdit("title", e.target.value)}
                  />

                  <div className="ssaMuted" style={{ margin: "10px 0 6px" }}>
                    Summary
                  </div>
                  <textarea
                    className="ssaTextarea"
                    value={parsed?.extracted?.summary || ""}
                    onChange={(e) => applyEdit("summary", e.target.value)}
                  />

                  <div className="ssaDivider" />

                  <div style={{ fontWeight: 900, marginBottom: 6 }}>
                    Days & Meals (quick edit)
                  </div>
                  <div className="ssaMuted" style={{ marginBottom: 6 }}>
                    Edit as simple text. Format:
                    <span className="ssaMono"> Mon:</span> then
                    <span className="ssaMono"> Breakfast: ...</span>
                    <span className="ssaMono"> Lunch: ...</span>
                  </div>
                  <textarea
                    className="ssaTextarea"
                    value={
                      Array.isArray(parsed?.extracted?.days)
                        ? parsed.extracted.days
                            .map((d) => {
                              const header = `${d?.label || "Day"}:`;
                              const meals = Array.isArray(d?.meals)
                                ? d.meals
                                    .map((m) =>
                                      `${m?.mealType || "meal"}: ${
                                        m?.title || ""
                                      }`.trim()
                                    )
                                    .filter(Boolean)
                                : [];
                              return [header, ...meals].join("\n");
                            })
                            .join("\n\n")
                        : ""
                    }
                    onChange={(e) => {
                      const txt = String(e.target.value || "");
                      const lines = txt.split(/\r?\n/);
                      const days = [];
                      let cur = null;
                      lines.forEach((ln) => {
                        const l = ln.trim();
                        if (!l) return;
                        const dayHdr = l.match(/^(.+)\s*:\s*$/);
                        const mealLine = l.match(
                          /^(breakfast|lunch|dinner|snack|b|l|d|s|other)\s*:\s*(.*)$/i
                        );
                        if (dayHdr && !mealLine) {
                          if (cur && cur.meals.length) days.push(cur);
                          cur = {
                            label: dayHdr[1].trim(),
                            date: "",
                            meals: [],
                          };
                          return;
                        }
                        if (mealLine) {
                          if (!cur)
                            cur = { label: "Imported", date: "", meals: [] };
                          const mealType = inferMealType(
                            mealLine[1].toLowerCase()
                          );
                          const title = String(mealLine[2] || "").trim();
                          if (title)
                            cur.meals.push({
                              mealType,
                              title,
                              servings: null,
                              recipes: [],
                              notes: "",
                            });
                        }
                      });
                      if (cur && cur.meals.length) days.push(cur);
                      applyEdit("days", days.slice(0, 14));
                    }}
                  />

                  <div className="ssaDivider" />

                  <div style={{ fontWeight: 900, marginBottom: 6 }}>
                    Grocery Items (quick edit)
                  </div>
                  <div className="ssaMuted" style={{ marginBottom: 6 }}>
                    Newline list (each line becomes a grocery item).
                  </div>
                  <textarea
                    className="ssaTextarea"
                    value={
                      Array.isArray(parsed?.extracted?.groceryItems)
                        ? parsed.extracted.groceryItems
                            .map((g) => g?.name || "")
                            .filter(Boolean)
                            .join("\n")
                        : ""
                    }
                    onChange={(e) => {
                      const lines = String(e.target.value || "")
                        .split(/\r?\n/)
                        .map((l) => l.trim())
                        .filter(Boolean)
                        .slice(0, 80);
                      const next = lines.map((name) => ({
                        name,
                        qty: null,
                        unit: "",
                        category: "",
                      }));
                      applyEdit("groceryItems", next);
                    }}
                  />

                  <div className="ssaMuted" style={{ marginTop: 10 }}>
                    Edits recorded: <b>{patches.length}</b>
                  </div>
                </>
              )}

              <div className="ssaRow">
                <button
                  type="button"
                  className="ssaBtn ghost"
                  onClick={prevStep}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="ssaBtn"
                  onClick={nextStep}
                  disabled={!canGoNext}
                >
                  Next: Normalize
                </button>
              </div>
            </>
          ) : null}

          {currentStep === "normalize" ? (
            <>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>
                D) Normalize into SSA Contract
              </div>

              {!normalized?.id ? (
                <>
                  <div className="ssaMuted">
                    Normalization converts extracted content into SSA-owned
                    schema for Meal Planner.
                  </div>
                  <div className="ssaRow">
                    <button
                      type="button"
                      className="ssaBtn"
                      onClick={handlePrimaryAction}
                    >
                      Normalize
                    </button>
                    <button
                      type="button"
                      className="ssaBtn ghost"
                      onClick={prevStep}
                    >
                      Back
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="ssaMuted" style={{ marginBottom: 6 }}>
                    Normalized object
                  </div>
                  <pre
                    className="ssaCard ssaMono"
                    style={{
                      background: "#fafafa",
                      borderRadius: 12,
                      overflowX: "auto",
                    }}
                  >
                    {JSON.stringify(normalized.normalized, null, 2)}
                  </pre>

                  <div className="ssaRow">
                    <button
                      type="button"
                      className="ssaBtn ghost"
                      onClick={prevStep}
                    >
                      Back
                    </button>
                    <button type="button" className="ssaBtn" onClick={nextStep}>
                      Next: Map / Link
                    </button>
                  </div>
                </>
              )}
            </>
          ) : null}

          {currentStep === "link" ? (
            <>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>
                E) Map / Link to SSA Entities
              </div>

              {!raw?.id || !normalized?.id ? (
                <EmptyState
                  title="Missing raw/normalized"
                  detail="Run Normalize first."
                />
              ) : (
                <>
                  <div className="ssaMuted">
                    Map ingredients/grocery needs to inventory, equipment to
                    tools, and apply tags (no-pork, week1, etc.).
                  </div>

                  <div className="ssaDivider" />

                  <div style={{ fontWeight: 900, marginBottom: 6 }}>
                    Inventory Links
                  </div>
                  <TableEditor
                    rows={linkMap?.links?.inventory || []}
                    columns={linkInventoryCols}
                    emptyLabel="No inventory links"
                    onChange={(rows) => {
                      const sanitized = rows.map((r) => ({
                        ...r,
                        confidence:
                          r?.confidence === "" ? "" : clamp01(r?.confidence),
                      }));
                      const lm = initLinkMapIfMissing() || linkMap;
                      const next = lm
                        ? { ...lm }
                        : {
                            id: makeId("linkMap"),
                            rawId: raw.id,
                            normId: normalized.id,
                            domain: DOMAIN,
                            createdAtISO: nowIso(),
                            updatedAtISO: nowIso(),
                            links: { inventory: [], equipment: [], tags: [] },
                          };
                      next.links = {
                        ...(next.links || {}),
                        inventory: sanitized,
                      };
                      setLinkMap(next);
                      setDirty(true);
                    }}
                  />

                  <div className="ssaDivider" />

                  <div style={{ fontWeight: 900, marginBottom: 6 }}>
                    Equipment Links
                  </div>
                  <TableEditor
                    rows={linkMap?.links?.equipment || []}
                    columns={linkEquipmentCols}
                    emptyLabel="No equipment links"
                    onChange={(rows) => {
                      const sanitized = rows.map((r) => ({
                        ...r,
                        confidence:
                          r?.confidence === "" ? "" : clamp01(r?.confidence),
                      }));
                      const lm = initLinkMapIfMissing() || linkMap;
                      const next = lm
                        ? { ...lm }
                        : {
                            id: makeId("linkMap"),
                            rawId: raw.id,
                            normId: normalized.id,
                            domain: DOMAIN,
                            createdAtISO: nowIso(),
                            updatedAtISO: nowIso(),
                            links: { inventory: [], equipment: [], tags: [] },
                          };
                      next.links = {
                        ...(next.links || {}),
                        equipment: sanitized,
                      };
                      setLinkMap(next);
                      setDirty(true);
                    }}
                  />

                  <div className="ssaDivider" />

                  <div style={{ fontWeight: 900, marginBottom: 6 }}>Tags</div>
                  <TableEditor
                    rows={linkMap?.links?.tags || []}
                    columns={linkTagCols}
                    emptyLabel="No tags"
                    onChange={(rows) => {
                      const sanitized = rows.map((r) => ({
                        ...r,
                        confidence:
                          r?.confidence === "" ? "" : clamp01(r?.confidence),
                      }));
                      const lm = initLinkMapIfMissing() || linkMap;
                      const next = lm
                        ? { ...lm }
                        : {
                            id: makeId("linkMap"),
                            rawId: raw.id,
                            normId: normalized.id,
                            domain: DOMAIN,
                            createdAtISO: nowIso(),
                            updatedAtISO: nowIso(),
                            links: { inventory: [], equipment: [], tags: [] },
                          };
                      next.links = { ...(next.links || {}), tags: sanitized };
                      setLinkMap(next);
                      setDirty(true);
                    }}
                  />

                  <div className="ssaRow">
                    <button
                      type="button"
                      className="ssaBtn ghost"
                      onClick={prevStep}
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      className="ssaBtn"
                      onClick={handlePrimaryAction}
                    >
                      Confirm Links
                    </button>
                  </div>
                </>
              )}
            </>
          ) : null}

          {currentStep === "save" ? (
            <>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>
                F) Save (Dexie) + G) Draft
              </div>

              {!dbCheck.ok ? (
                <EmptyState
                  title="Dexie schema missing"
                  detail={dbCheck.message}
                />
              ) : (
                <>
                  <div className="ssaMuted">
                    Saves to: <b>importRaw</b>, <b>importNormalized</b>,{" "}
                    <b>importLinkMaps</b>, <b>importLogs</b>
                  </div>

                  {saveError ? (
                    <div className="ssaStatus error" style={{ marginTop: 10 }}>
                      <div style={{ fontWeight: 900 }}>Save error</div>
                      <div className="ssaMuted">{saveError}</div>
                      <div className="ssaRow">
                        <button
                          type="button"
                          className="ssaBtn"
                          onClick={saveAll}
                        >
                          Retry Save
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {savedIds.rawId ? (
                    <div
                      className="ssaStatus success"
                      style={{ marginTop: 10 }}
                    >
                      <div style={{ fontWeight: 900 }}>Saved</div>
                      <div className="ssaMuted">
                        rawId: <span className="ssaMono">{savedIds.rawId}</span>
                        <br />
                        normId:{" "}
                        <span className="ssaMono">{savedIds.normId}</span>
                        <br />
                        linkMapId:{" "}
                        <span className="ssaMono">{savedIds.linkMapId}</span>
                      </div>
                    </div>
                  ) : null}

                  <div className="ssaRow" style={{ marginTop: 12 }}>
                    <button
                      type="button"
                      className="ssaBtn ghost"
                      onClick={prevStep}
                    >
                      Back
                    </button>
                    <button type="button" className="ssaBtn" onClick={saveAll}>
                      Save to Dexie
                    </button>
                    <button
                      type="button"
                      className="ssaBtn soft"
                      onClick={generateDraft}
                    >
                      Generate Session Draft
                    </button>
                  </div>

                  {draft ? (
                    <>
                      <div className="ssaDivider" />
                      <div style={{ fontWeight: 900, marginBottom: 6 }}>
                        Draft (resolved)
                      </div>
                      <pre
                        className="ssaCard ssaMono"
                        style={{
                          background: "#fafafa",
                          borderRadius: 12,
                          overflowX: "auto",
                        }}
                      >
                        {JSON.stringify(draft, null, 2)}
                      </pre>
                    </>
                  ) : (
                    <div className="ssaMuted" style={{ marginTop: 10 }}>
                      Draft not created yet.
                    </div>
                  )}
                </>
              )}
            </>
          ) : null}

          <div className="ssaDivider" />

          <div className="ssaRow">
            <button
              type="button"
              className="ssaBtn ghost"
              onClick={prevStep}
              disabled={stepIdx === 0}
            >
              Back
            </button>
            <button
              type="button"
              className="ssaBtn"
              onClick={handlePrimaryAction}
              disabled={!canGoNext}
            >
              {currentStep === "source"
                ? "Receive + Parse"
                : currentStep === "preview"
                ? "Next"
                : currentStep === "edit"
                ? "Next"
                : currentStep === "normalize"
                ? normalized?.id
                  ? "Next"
                  : "Normalize"
                : currentStep === "link"
                ? "Confirm Links"
                : currentStep === "save"
                ? "Save"
                : "Next"}
            </button>

            {stepIdx < STEPS.length - 1 ? (
              <button
                type="button"
                className="ssaBtn soft"
                onClick={nextStep}
                disabled={!canGoNext}
              >
                Skip →
              </button>
            ) : null}

            <button type="button" className="ssaBtn soft" onClick={resetAll}>
              Reset
            </button>
          </div>
        </div>

        {/* Right: Context / Logs / Snapshot */}
        <div className="ssaCard">
          <div style={{ fontWeight: 900, marginBottom: 8 }}>Snapshot</div>

          <div className="ssaMuted">Domain</div>
          <div style={{ fontWeight: 900 }}>{DOMAIN}</div>

          <div className="ssaDivider" />

          <div className="ssaMuted">Raw</div>
          {raw ? (
            <div className="ssaMono" style={{ whiteSpace: "pre-wrap" }}>
              id: {raw.id}
              {"\n"}source: {raw?.source?.kind}
              {raw?.source?.url ? `\nurl: ${raw.source.url}` : ""}
              {raw?.source?.filename ? `\nfile: ${raw.source.filename}` : ""}
            </div>
          ) : (
            <div className="ssaMuted">No raw import yet.</div>
          )}

          <div className="ssaDivider" />

          <div className="ssaMuted">Normalized</div>
          {normalized?.id ? (
            <div className="ssaMono" style={{ whiteSpace: "pre-wrap" }}>
              id: {normalized.id}
              {"\n"}kind: {normalized?.normalized?.kind}
              {"\n"}title: {normalized?.normalized?.title}
              {"\n"}days:{" "}
              {Array.isArray(normalized?.normalized?.days)
                ? normalized.normalized.days.length
                : 0}
            </div>
          ) : (
            <div className="ssaMuted">Not normalized yet.</div>
          )}

          <div className="ssaDivider" />

          <div className="ssaMuted">Links</div>
          {linkMap?.id ? (
            <div className="ssaMono" style={{ whiteSpace: "pre-wrap" }}>
              id: {linkMap.id}
              {"\n"}inventory:{" "}
              {Array.isArray(linkMap?.links?.inventory)
                ? linkMap.links.inventory.length
                : 0}
              {"\n"}equipment:{" "}
              {Array.isArray(linkMap?.links?.equipment)
                ? linkMap.links.equipment.length
                : 0}
              {"\n"}tags:{" "}
              {Array.isArray(linkMap?.links?.tags)
                ? linkMap.links.tags.length
                : 0}
            </div>
          ) : (
            <div className="ssaMuted">No link map yet.</div>
          )}

          <div className="ssaDivider" />

          <div style={{ fontWeight: 900, marginBottom: 6 }}>Pipeline Logs</div>
          {Array.isArray(pipelineLogs) && pipelineLogs.length ? (
            <div style={{ display: "grid", gap: 8 }}>
              {pipelineLogs.slice(0, 12).map((l) => (
                <div
                  key={l.id}
                  className="ssaCard"
                  style={{ padding: 10, background: "#fafafa" }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <div style={{ fontWeight: 900 }}>{l.stage}</div>
                    <div className="ssaMono" style={{ opacity: 0.7 }}>
                      {String(l.ts || "").slice(11, 19)}
                    </div>
                  </div>
                  <div className="ssaMuted">
                    <b>{l.level}:</b> {l.msg}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="ssaMuted">No logs yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Dexie schema additions required                                             */
/* -------------------------------------------------------------------------- */
/**
 * Paste into:
 *   C:\Users\larho\suka-smart-assistant\src\services\db.js
 *
 * IMPORTANT: bump db.version by +1 when adding/changing schema.
 *
 * Exact .stores snippet (4 tables):
 *
 * {
 *   importRaw: "id, domain, createdAtISO, updatedAtISO, source.kind, source.url",
 *   importNormalized: "id, rawId, domain, createdAtISO, updatedAtISO, confidence.overall",
 *   importLinkMaps: "id, rawId, normId, domain, createdAtISO, updatedAtISO",
 *   importLogs: "id, domain, rawId, normId, linkMapId, ts, level"
 * }
 */

/* -------------------------------------------------------------------------- */
/* Events emitted: names + payload examples + where they fire                  */
/* -------------------------------------------------------------------------- */
/**
 * 1) import.page.opened
 *    Fires in: useEffect() on mount
 *    Payload example:
 *    {
 *      type: "import.page.opened",
 *      domain: "mealplanner",
 *      ts: "2025-12-20T12:34:56.000Z"
 *    }
 *
 * 2) import.received
 *    Fires in: receiveImport()
 *    Payload example:
 *    {
 *      type: "import.received",
 *      domain: "mealplanner",
 *      rawId: "importRaw_...",
 *      source: { kind:"text", textPreview:"..." },
 *      ts: "2025-12-20T12:34:56.000Z"
 *    }
 *
 * 3) import.parsed
 *    Fires in: runParse()
 *    Payload example:
 *    {
 *      type: "import.parsed",
 *      domain: "mealplanner",
 *      rawId: "importRaw_...",
 *      extracted: { title, days:[...], constraints:{...}, groceryItems:[...], ... },
 *      confidence: { overall: 0.66, fields: { ... } },
 *      ts: "2025-12-20T12:34:56.000Z"
 *    }
 *
 * 4) import.normalized
 *    Fires in: runNormalize()
 *    Payload example:
 *    {
 *      type: "import.normalized",
 *      domain: "mealplanner",
 *      rawId: "importRaw_...",
 *      normId: "importNorm_...",
 *      confidence: { overall: 0.66, fields: { ... } },
 *      normalized: { kind:"mealplanner_import", days:[...], groceryItems:[...], constraints:{...}, ... },
 *      ts: "2025-12-20T12:34:56.000Z"
 *    }
 *
 * 5) import.linked
 *    Fires in: finalizeLinks()
 *    Payload example:
 *    {
 *      type: "import.linked",
 *      domain: "mealplanner",
 *      rawId: "importRaw_...",
 *      normId: "importNorm_...",
 *      linkMapId: "linkMap_...",
 *      links: { inventory:[...], equipment:[...], tags:[...] },
 *      ts: "2025-12-20T12:34:56.000Z"
 *    }
 *
 * 6) inventory.shortage.detected
 *    Fires in: saveAll() after successful save (heuristic: inventory link rows missing localId)
 *    Payload example:
 *    {
 *      type: "inventory.shortage.detected",
 *      domain: "mealplanner",
 *      rawId: "importRaw_...",
 *      normId: "importNorm_...",
 *      shortages: [{ item:"eggs", neededQty: 12, unit:"" }],
 *      ts: "2025-12-20T12:34:56.000Z"
 *    }
 *
 * 7) session.draft.created
 *    Fires in: generateDraft()
 *    Payload example:
 *    {
 *      type: "session.draft.created",
 *      domain: "mealplanner",
 *      rawId: "importRaw_...",
 *      normId: "importNorm_...",
 *      linkMapId: "linkMap_...",
 *      draftId: "mealplannerDraft_...",
 *      ts: "2025-12-20T12:34:56.000Z"
 *    }
 */
