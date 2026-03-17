/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\formatters\cooking\cookingDraftFormatter.jsx
/**
 * Cooking Draft Formatter (CRUD-capable)
 * -----------------------------------------------------------------------------
 * NOTE: This file exports a React component (even though it is .js).
 * It renders a resolved Cooking draft in human-friendly form and supports
 * full CRUD editing (create/read/update/delete) with patch emission.
 *
 * Input accepted:
 *  - resolved draft object, OR
 *  - wrapper { via, res } where res is the resolved draft
 *
 * Emitted events (soft eventBus):
 *  - "draft.read"    once on mount
 *  - "draft.created" on CREATE
 *  - "draft.updated" on UPDATE/CREATE/DELETE mutations
 *  - "draft.deleted" on DELETE
 *
 * No DB writes here. Pure UI + state + events/callbacks.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  CLAMP_HINT_TEXT,
  useNonNegativeClampHints,
} from "@/ui/ux/useNonNegativeClampHints";

/* ------------------------- Soft/defensive eventBus -------------------------- */
let eventBus = { emit: () => {}, on: () => () => {} };
try {
  // eslint-disable-next-line global-require
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eb || eventBus;
} catch {
  try {
    // eslint-disable-next-line global-require
    const eb2 = require("@/services/events/eventBus");
    eventBus = eb2?.default || eb2?.eventBus || eb2 || eventBus;
  } catch {}
}

/* ----------------------------- Domain schema -------------------------------- */
const SCHEMA = {
  domain: "cooking",
  labels: {
    title: "Draft Cooking Session",
    assumptions: "Assumptions",
    sections: "Sections",
    tasks: "Tasks",
    inventoryAlerts: "Inventory Alerts",
    healthReminders: "Reminders",
    debug: "Debug Raw Draft JSON",

    recipes: "Recipes",
    consolidatedSteps: "Consolidated Steps (Runner Preview)",
    timers: "Timers",
    equipment: "Equipment",
    ingredients: "Ingredients / Inputs",
  },
  defaults: {
    sectionTitle: "New Section",
    bullet: "New bullet…",
    task: {
      label: "New cooking task…",
      priority: "med",
      durationMin: 10,
      dueISO: "",
      tags: ["cooking"],
      station: "", // prep/cook/serve/cleanup
    },
    alert: {
      item: "New ingredient/supply…",
      neededQty: 0,
      unit: "",
      severity: "low",
      suggestion: "",
    },
    reminder: {
      label: "New reminder…",
      cadence: "weekly",
      nextDueISO: "",
    },
    recipe: { name: "New recipe", source: "", servings: "", notes: "" },
    step: {
      label: "New step…",
      station: "prep",
      durationMin: 5,
      timerSec: 0,
      recipe: "",
      notes: "",
    },
    timer: { label: "New timer", seconds: 300, startAtStepIndex: 0, notes: "" },
    equipmentItem: { name: "New equipment", notes: "" },
    ingredient: { name: "New ingredient", qty: 0, unit: "", notes: "" },
  },
};

function nowISO() {
  return new Date().toISOString();
}

function uid(prefix = "id") {
  return `${prefix}_${Math.random()
    .toString(16)
    .slice(2)}_${Date.now().toString(16)}`;
}

function deepClone(x) {
  try {
    return structuredClone(x);
  } catch {
    return JSON.parse(JSON.stringify(x ?? null));
  }
}

function isWrapperDraft(x) {
  return x && typeof x === "object" && "via" in x && "res" in x;
}

function normalizeDraftInput(draftOrWrapper) {
  const d = isWrapperDraft(draftOrWrapper)
    ? draftOrWrapper?.res
    : draftOrWrapper;
  const base = d && typeof d === "object" ? d : {};

  const normalized = {
    id: base.id || uid("cooking_draft"),
    domain: base.domain || SCHEMA.domain,
    title: base.title || SCHEMA.labels.title,
    summary: base.summary || "",
    assumptions: Array.isArray(base.assumptions) ? base.assumptions : [],
    sections: Array.isArray(base.sections) ? base.sections : [],
    tasks: Array.isArray(base.tasks) ? base.tasks : [],
    inventoryAlerts: Array.isArray(base.inventoryAlerts)
      ? base.inventoryAlerts
      : [],
    healthReminders: Array.isArray(base.healthReminders)
      ? base.healthReminders
      : [],

    // cooking-specific
    recipes: Array.isArray(base.recipes) ? base.recipes : [],
    consolidatedSteps: Array.isArray(base.consolidatedSteps)
      ? base.consolidatedSteps
      : [],
    timers: Array.isArray(base.timers) ? base.timers : [],
    equipment: Array.isArray(base.equipment) ? base.equipment : [],
    ingredients: Array.isArray(base.ingredients) ? base.ingredients : [],

    meta: base.meta || {},
  };

  // Normalize sections
  normalized.sections = normalized.sections.map((s) => ({
    id: s?.id || uid("sec"),
    title: s?.title || "Section",
    bullets: Array.isArray(s?.bullets) ? s.bullets : [],
    table: s?.table && typeof s.table === "object" ? s.table : null,
  }));
  normalized.sections = normalized.sections.map((s) => {
    if (!s.table) return s;
    const columns = Array.isArray(s.table.columns) ? s.table.columns : [];
    const rows = Array.isArray(s.table.rows) ? s.table.rows : [];
    return { ...s, table: { ...s.table, columns, rows } };
  });

  // Normalize tasks
  normalized.tasks = normalized.tasks.map((t) => ({
    id: t?.id || uid("task"),
    label: String(t?.label ?? ""),
    priority: t?.priority || "med",
    durationMin: Number.isFinite(Number(t?.durationMin))
      ? Number(t.durationMin)
      : undefined,
    dueISO: t?.dueISO || "",
    tags: Array.isArray(t?.tags) ? t.tags : ["cooking"],
    station: t?.station || "",
  }));

  // Normalize alerts
  normalized.inventoryAlerts = normalized.inventoryAlerts.map((a) => ({
    id: a?.id || uid("alert"),
    sku: a?.sku,
    item: String(a?.item ?? a?.name ?? ""),
    neededQty: a?.neededQty,
    unit: a?.unit || "",
    severity: a?.severity || "low",
    suggestion: a?.suggestion || "",
  }));

  // Normalize reminders
  normalized.healthReminders = normalized.healthReminders.map((r) => ({
    id: r?.id || uid("rem"),
    label: r?.label || "",
    cadence: r?.cadence || "weekly",
    nextDueISO: r?.nextDueISO || "",
  }));

  // Recipes
  normalized.recipes = normalized.recipes.map((r) => ({
    id: r?.id || uid("rcp"),
    name: r?.name || r?.title || "Recipe",
    source: r?.source || "",
    servings: r?.servings ?? "",
    notes: r?.notes || "",
  }));

  // Consolidated steps (runner preview)
  normalized.consolidatedSteps = normalized.consolidatedSteps.map((s) => ({
    id: s?.id || uid("step"),
    label: s?.label || s?.text || "",
    station: s?.station || "prep",
    durationMin: Number.isFinite(Number(s?.durationMin))
      ? Number(s.durationMin)
      : undefined,
    timerSec: Number.isFinite(Number(s?.timerSec)) ? Number(s.timerSec) : 0,
    recipe: s?.recipe || "",
    notes: s?.notes || "",
  }));

  // Timers
  normalized.timers = normalized.timers.map((t) => ({
    id: t?.id || uid("tmr"),
    label: t?.label || "Timer",
    seconds: Number.isFinite(Number(t?.seconds)) ? Number(t.seconds) : 0,
    startAtStepIndex: Number.isFinite(Number(t?.startAtStepIndex))
      ? Number(t.startAtStepIndex)
      : 0,
    notes: t?.notes || "",
  }));

  // Equipment
  normalized.equipment = normalized.equipment.map((e) => ({
    id: e?.id || uid("eq"),
    name: e?.name || String(e ?? ""),
    notes: e?.notes || "",
  }));

  // Ingredients
  normalized.ingredients = normalized.ingredients.map((ing) => ({
    id: ing?.id || uid("ing"),
    name: ing?.name || String(ing?.item ?? ""),
    qty: Number.isFinite(Number(ing?.qty)) ? Number(ing.qty) : ing?.qty ?? "",
    unit: ing?.unit || "",
    notes: ing?.notes || "",
  }));

  return normalized;
}

/* ------------------------ Path parsing + patching --------------------------- */
function parsePath(path) {
  const p = String(path || "").trim();
  if (!p) return [];
  const parts = [];
  p.split(".").forEach((chunk) => {
    const re = /([^[\]]+)|\[(\d+)\]/g;
    let m;
    while ((m = re.exec(chunk))) {
      if (m[1] != null) parts.push(m[1]);
      if (m[2] != null) parts.push(Number(m[2]));
    }
  });
  return parts;
}

function getAtPath(obj, path) {
  const keys = Array.isArray(path) ? path : parsePath(path);
  let cur = obj;
  for (let i = 0; i < keys.length; i += 1) {
    if (cur == null) return undefined;
    cur = cur[keys[i]];
  }
  return cur;
}

function setAtPath(obj, path, value) {
  const keys = Array.isArray(path) ? path : parsePath(path);
  if (!keys.length) return obj;
  const next = deepClone(obj);
  let cur = next;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i];
    const nk = keys[i + 1];
    if (cur[k] == null) cur[k] = typeof nk === "number" ? [] : {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return next;
}

function addAtPath(obj, path, value) {
  const keys = Array.isArray(path) ? path : parsePath(path);
  const arr = getAtPath(obj, keys);
  if (!Array.isArray(arr)) {
    const created = setAtPath(obj, keys, []);
    return addAtPath(created, keys, value);
  }
  const next = deepClone(obj);
  const dest = getAtPath(next, keys);
  dest.push(value);
  return next;
}

function removeAtPath(obj, path) {
  const keys = Array.isArray(path) ? path : parsePath(path);
  if (!keys.length) return obj;

  const next = deepClone(obj);
  const last = keys[keys.length - 1];
  const parentPath = keys.slice(0, -1);
  const parent = getAtPath(next, parentPath);

  if (parent == null) return next;

  if (typeof last === "number" && Array.isArray(parent)) {
    parent.splice(last, 1);
    return next;
  }
  if (typeof last === "string" && typeof parent === "object") {
    // eslint-disable-next-line no-param-reassign
    delete parent[last];
  }
  return next;
}

function applyPatch(prevDraft, patch) {
  const p = patch || {};
  if (!p.op || !p.path) return prevDraft;
  if (p.op === "set") return setAtPath(prevDraft, p.path, p.value);
  if (p.op === "add") return addAtPath(prevDraft, p.path, p.value);
  if (p.op === "remove") return removeAtPath(prevDraft, p.path);
  return prevDraft;
}

/* ----------------------------- Small UI bits -------------------------------- */
function Btn({ children, onClick, disabled, title, kind = "default" }) {
  const base =
    "ssa-btn" +
    (kind === "danger"
      ? " ssa-btn-danger"
      : kind === "primary"
      ? " ssa-btn-primary"
      : "") +
    (disabled ? " ssa-btn-disabled" : "");
  return (
    <button
      type="button"
      className={base}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <div className="ssa-field">
      {label ? <div className="ssa-label">{label}</div> : null}
      <div className="ssa-control">{children}</div>
    </div>
  );
}

function TextInput({ value, onChange, placeholder = "", disabled = false }) {
  return (
    <input
      className="ssa-input"
      type="text"
      value={value ?? ""}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
}

function NumInput({
  value,
  onChange,
  placeholder = "",
  disabled = false,
  min,
}) {
  const v = value === undefined || value === null ? "" : String(value);
  return (
    <input
      className="ssa-input"
      type="number"
      value={v}
      placeholder={placeholder}
      disabled={disabled}
      min={min}
      onChange={(e) => {
        const n = e.target.value;
        onChange?.(n === "" ? "" : Number(n));
      }}
    />
  );
}

function TextArea({
  value,
  onChange,
  placeholder = "",
  disabled = false,
  rows = 3,
}) {
  return (
    <textarea
      className="ssa-textarea"
      value={value ?? ""}
      placeholder={placeholder}
      disabled={disabled}
      rows={rows}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
}

function Select({ value, onChange, options, disabled = false }) {
  return (
    <select
      className="ssa-select"
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.value)}
    >
      {(options || []).map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function ConfirmDanger({ message }) {
  // eslint-disable-next-line no-alert
  return window.confirm(message || "Are you sure?");
}

const NON_NEGATIVE_QTY_PATHS = [
  /^ingredients\[\d+\]\.qty$/,
  /^inventoryAlerts\[\d+\]\.neededQty$/,
];

/* --------------------------- Main formatter component ------------------------ */
export default function CookingDraftFormatter({
  draft,
  editable = true,
  allowCRUD = true,
  onCreate,
  onUpdate,
  onDelete,
  onChange,
  onPatch,
  className = "",
}) {
  const DOMAIN = SCHEMA.domain;

  const initial = useMemo(() => normalizeDraftInput(draft), [draft]);
  const [state, setState] = useState(() => initial);
  const [debugOpen, setDebugOpen] = useState(false);
  const { clampHints, sanitizeFieldValue } = useNonNegativeClampHints({
    paths: NON_NEGATIVE_QTY_PATHS,
    warningTitle: "Inventory quantity adjusted",
    warningDescription:
      "Negative values were clamped to zero for inventory-related fields.",
  });

  const historyRef = useRef([]);
  const mountedRef = useRef(false);

  useEffect(() => {
    const next = normalizeDraftInput(draft);
    setState(next);
  }, [draft]);

  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    try {
      eventBus.emit("draft.read", { domain: DOMAIN, draftId: initial.id });
    } catch {}
  }, [DOMAIN, initial.id]);

  const emit = (evt, payload) => {
    try {
      eventBus.emit(evt, payload);
    } catch {}
  };

  const pushHistory = (prev, patch) => {
    const stack = historyRef.current || [];
    stack.push({ prev, patch });
    if (stack.length > 10) stack.splice(0, stack.length - 10);
    historyRef.current = stack;
  };

  const commitPatch = (patch, { kind, createdValue } = {}) => {
    setState((prev) => {
      const prevSnapshot = deepClone(prev);
      const nextDraft = applyPatch(prev, patch);

      pushHistory(prevSnapshot, patch);

      onPatch?.(patch);
      onChange?.(nextDraft);

      if (patch.op === "add") {
        onCreate?.({
          kind,
          path: patch.path,
          value: createdValue ?? patch.value,
          nextDraft,
        });
        emit("draft.created", {
          domain: DOMAIN,
          draftId: nextDraft.id,
          patch,
          nextDraft,
        });
      } else if (patch.op === "remove") {
        onDelete?.({ path: patch.path, nextDraft });
        emit("draft.deleted", {
          domain: DOMAIN,
          draftId: nextDraft.id,
          patch,
          nextDraft,
        });
      } else {
        onUpdate?.({ path: patch.path, value: patch.value, nextDraft, patch });
      }

      emit("draft.updated", {
        domain: DOMAIN,
        draftId: nextDraft.id,
        patch,
        nextDraft,
      });

      return nextDraft;
    });
  };

  const makePatch = (op, path, value) => ({
    op,
    path,
    value,
    ts: nowISO(),
    domain: DOMAIN,
    draftId: state?.id || initial?.id,
  });

  const canEdit = !!editable;
  const canCRUD = !!editable && !!allowCRUD;

  const setField = (path, value) => {
    commitPatch(makePatch("set", path, sanitizeFieldValue(path, value)));
  };
  const addItem = (path, value, kind) =>
    commitPatch(makePatch("add", path, value), { kind, createdValue: value });
  const removeItem = (path, confirmMsg) => {
    if (!canCRUD) return;
    if (!ConfirmDanger({ message: confirmMsg || "Delete this item?" })) return;
    commitPatch(makePatch("remove", path));
  };

  const undo = () => {
    const stack = historyRef.current || [];
    const last = stack.pop();
    if (!last) return;
    historyRef.current = stack;
    const prevDraft = last.prev;
    setState(prevDraft);

    const patch = {
      op: "set",
      path: "__undo__",
      value: last.patch,
      ts: nowISO(),
      domain: DOMAIN,
      draftId: prevDraft.id,
    };
    onPatch?.(patch);
    onChange?.(prevDraft);
    emit("draft.updated", {
      domain: DOMAIN,
      draftId: prevDraft.id,
      patch,
      nextDraft: prevDraft,
    });
  };

  /* ---------------------------- Create defaults ----------------------------- */
  const newSection = () => ({
    id: uid("sec"),
    title: SCHEMA.defaults.sectionTitle,
    bullets: [SCHEMA.defaults.bullet],
    table: null,
  });

  const newTask = () => ({
    id: uid("task"),
    ...deepClone(SCHEMA.defaults.task),
  });
  const newAlert = () => ({
    id: uid("alert"),
    ...deepClone(SCHEMA.defaults.alert),
  });
  const newReminder = () => ({
    id: uid("rem"),
    ...deepClone(SCHEMA.defaults.reminder),
  });
  const newRecipe = () => ({
    id: uid("rcp"),
    ...deepClone(SCHEMA.defaults.recipe),
  });
  const newStep = () => ({
    id: uid("step"),
    ...deepClone(SCHEMA.defaults.step),
  });
  const newTimer = () => ({
    id: uid("tmr"),
    ...deepClone(SCHEMA.defaults.timer),
  });
  const newEquipment = () => ({
    id: uid("eq"),
    ...deepClone(SCHEMA.defaults.equipmentItem),
  });
  const newIngredient = () => ({
    id: uid("ing"),
    ...deepClone(SCHEMA.defaults.ingredient),
  });

  const ensureSectionTable = (sectionIndex) => {
    const basePath = `sections[${sectionIndex}].table`;
    const existing = getAtPath(state, basePath);
    if (existing) return;
    const table = { columns: ["Step", "Notes"], rows: [["", ""]] };
    commitPatch(makePatch("set", basePath, table));
  };

  /* ------------------------------- Renderers -------------------------------- */
  const EmptyState = ({ title, body, onAdd, addLabel = "Add" }) => (
    <div className="ssa-empty">
      <div className="ssa-empty-title">{title}</div>
      <div className="ssa-empty-body">{body}</div>
      {canCRUD && onAdd ? (
        <div className="ssa-empty-actions">
          <Btn kind="primary" onClick={onAdd}>
            {addLabel}
          </Btn>
        </div>
      ) : null}
    </div>
  );

  const renderAssumptions = () => {
    const list = Array.isArray(state.assumptions) ? state.assumptions : [];
    return (
      <div className="ssa-card">
        <div className="ssa-card-header">
          <div className="ssa-card-title">{SCHEMA.labels.assumptions}</div>
          <div className="ssa-card-actions">
            {canCRUD ? (
              <Btn
                kind="primary"
                onClick={() =>
                  addItem("assumptions", "New assumption…", "assumption")
                }
              >
                + Add
              </Btn>
            ) : null}
          </div>
        </div>

        {list.length === 0 ? (
          <EmptyState
            title="No assumptions yet."
            body="Assumptions clarify timing, equipment, and batch constraints."
            addLabel="Add assumption"
            onAdd={() =>
              addItem("assumptions", "New assumption…", "assumption")
            }
          />
        ) : (
          <ul className="ssa-list">
            {list.map((a, i) => (
              <li key={`assump_${i}`} className="ssa-list-item">
                {canEdit ? (
                  <TextInput
                    value={a}
                    onChange={(v) => setField(`assumptions[${i}]`, v)}
                  />
                ) : (
                  <span>{a}</span>
                )}
                {canCRUD ? (
                  <Btn
                    kind="danger"
                    onClick={() =>
                      removeItem(`assumptions[${i}]`, "Delete this assumption?")
                    }
                  >
                    Delete
                  </Btn>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  const renderRecipes = () => {
    const recipes = Array.isArray(state.recipes) ? state.recipes : [];
    return (
      <div className="ssa-card">
        <div className="ssa-card-header">
          <div className="ssa-card-title">{SCHEMA.labels.recipes}</div>
          <div className="ssa-card-actions">
            {canCRUD ? (
              <Btn
                kind="primary"
                onClick={() => addItem("recipes", newRecipe(), "recipe")}
              >
                + Add Recipe
              </Btn>
            ) : null}
          </div>
        </div>

        {recipes.length === 0 ? (
          <EmptyState
            title="No recipes in this session."
            body="Add recipes that are included in the cooking session."
            addLabel="Add recipe"
            onAdd={() => addItem("recipes", newRecipe(), "recipe")}
          />
        ) : (
          <div className="ssa-table-wrap">
            <table className="ssa-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Source</th>
                  <th>Servings</th>
                  <th>Notes</th>
                  {canCRUD ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {recipes.map((r, i) => (
                  <tr key={r?.id || `rcp_${i}`}>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={r.name}
                          onChange={(v) => setField(`recipes[${i}].name`, v)}
                        />
                      ) : (
                        r.name
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={r.source}
                          onChange={(v) => setField(`recipes[${i}].source`, v)}
                        />
                      ) : (
                        r.source
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={r.servings}
                          onChange={(v) =>
                            setField(`recipes[${i}].servings`, v)
                          }
                        />
                      ) : (
                        String(r.servings ?? "")
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextArea
                          rows={2}
                          value={r.notes}
                          onChange={(v) => setField(`recipes[${i}].notes`, v)}
                        />
                      ) : (
                        r.notes
                      )}
                    </td>
                    {canCRUD ? (
                      <td>
                        <Btn
                          kind="danger"
                          onClick={() =>
                            removeItem(
                              `recipes[${i}]`,
                              "Delete this recipe entry?"
                            )
                          }
                        >
                          Delete
                        </Btn>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const renderIngredients = () => {
    const ingredients = Array.isArray(state.ingredients)
      ? state.ingredients
      : [];
    return (
      <div className="ssa-card">
        <div className="ssa-card-header">
          <div className="ssa-card-title">{SCHEMA.labels.ingredients}</div>
          <div className="ssa-card-actions">
            {canCRUD ? (
              <Btn
                kind="primary"
                onClick={() =>
                  addItem("ingredients", newIngredient(), "ingredient")
                }
              >
                + Add Ingredient
              </Btn>
            ) : null}
          </div>
        </div>

        {ingredients.length === 0 ? (
          <EmptyState
            title="No ingredients listed."
            body="If your generator outputs ingredients/inputs, you can edit them here."
            addLabel="Add ingredient"
            onAdd={() => addItem("ingredients", newIngredient(), "ingredient")}
          />
        ) : (
          <div className="ssa-table-wrap">
            <table className="ssa-table">
              <thead>
                <tr>
                  <th>Ingredient</th>
                  <th>Qty</th>
                  <th>Unit</th>
                  <th>Notes</th>
                  {canCRUD ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {ingredients.map((ing, i) => (
                  <tr key={ing?.id || `ing_${i}`}>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={ing.name}
                          onChange={(v) =>
                            setField(`ingredients[${i}].name`, v)
                          }
                        />
                      ) : (
                        ing.name
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <>
                          <NumInput
                            value={ing.qty ?? ""}
                            min={0}
                            onChange={(v) => setField(`ingredients[${i}].qty`, v)}
                          />
                          {clampHints[`ingredients[${i}].qty`] ? (
                            <div className="ssa-clamp-hint" role="note">
                              {CLAMP_HINT_TEXT}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        String(ing.qty ?? "")
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={ing.unit}
                          onChange={(v) =>
                            setField(`ingredients[${i}].unit`, v)
                          }
                        />
                      ) : (
                        ing.unit
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextArea
                          rows={2}
                          value={ing.notes}
                          onChange={(v) =>
                            setField(`ingredients[${i}].notes`, v)
                          }
                        />
                      ) : (
                        ing.notes
                      )}
                    </td>
                    {canCRUD ? (
                      <td>
                        <Btn
                          kind="danger"
                          onClick={() =>
                            removeItem(
                              `ingredients[${i}]`,
                              "Delete this ingredient?"
                            )
                          }
                        >
                          Delete
                        </Btn>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const renderEquipment = () => {
    const equipment = Array.isArray(state.equipment) ? state.equipment : [];
    return (
      <div className="ssa-card">
        <div className="ssa-card-header">
          <div className="ssa-card-title">{SCHEMA.labels.equipment}</div>
          <div className="ssa-card-actions">
            {canCRUD ? (
              <Btn
                kind="primary"
                onClick={() =>
                  addItem("equipment", newEquipment(), "equipment")
                }
              >
                + Add Equipment
              </Btn>
            ) : null}
          </div>
        </div>

        {equipment.length === 0 ? (
          <EmptyState
            title="No equipment listed."
            body="List required tools (pots, pans, instant pot, mixer, etc.)."
            addLabel="Add equipment"
            onAdd={() => addItem("equipment", newEquipment(), "equipment")}
          />
        ) : (
          <div className="ssa-table-wrap">
            <table className="ssa-table">
              <thead>
                <tr>
                  <th>Equipment</th>
                  <th>Notes</th>
                  {canCRUD ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {equipment.map((e, i) => (
                  <tr key={e?.id || `eq_${i}`}>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={e.name}
                          onChange={(v) => setField(`equipment[${i}].name`, v)}
                        />
                      ) : (
                        e.name
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextArea
                          rows={2}
                          value={e.notes}
                          onChange={(v) => setField(`equipment[${i}].notes`, v)}
                        />
                      ) : (
                        e.notes
                      )}
                    </td>
                    {canCRUD ? (
                      <td>
                        <Btn
                          kind="danger"
                          onClick={() =>
                            removeItem(
                              `equipment[${i}]`,
                              "Delete this equipment item?"
                            )
                          }
                        >
                          Delete
                        </Btn>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const renderConsolidatedSteps = () => {
    const steps = Array.isArray(state.consolidatedSteps)
      ? state.consolidatedSteps
      : [];
    return (
      <div className="ssa-card">
        <div className="ssa-card-header">
          <div className="ssa-card-title">
            {SCHEMA.labels.consolidatedSteps}
          </div>
          <div className="ssa-card-actions">
            {canCRUD ? (
              <Btn
                kind="primary"
                onClick={() => addItem("consolidatedSteps", newStep(), "step")}
              >
                + Add Step
              </Btn>
            ) : null}
          </div>
        </div>

        {steps.length === 0 ? (
          <EmptyState
            title="No consolidated steps."
            body="This is the step list your SessionRunner should play through. Add/edit steps and timers here."
            addLabel="Add step"
            onAdd={() => addItem("consolidatedSteps", newStep(), "step")}
          />
        ) : (
          <div className="ssa-table-wrap">
            <table className="ssa-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Step</th>
                  <th>Station</th>
                  <th>Recipe</th>
                  <th>Duration (min)</th>
                  <th>Timer (sec)</th>
                  <th>Notes</th>
                  {canCRUD ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {steps.map((s, i) => (
                  <tr key={s?.id || `step_${i}`}>
                    <td style={{ opacity: 0.8 }}>{i + 1}</td>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={s.label}
                          onChange={(v) =>
                            setField(`consolidatedSteps[${i}].label`, v)
                          }
                        />
                      ) : (
                        s.label
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <Select
                          value={s.station || "prep"}
                          onChange={(v) =>
                            setField(`consolidatedSteps[${i}].station`, v)
                          }
                          options={[
                            { value: "prep", label: "prep" },
                            { value: "cook", label: "cook" },
                            { value: "serve", label: "serve" },
                            { value: "cleanup", label: "cleanup" },
                          ]}
                        />
                      ) : (
                        s.station
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={s.recipe || ""}
                          onChange={(v) =>
                            setField(`consolidatedSteps[${i}].recipe`, v)
                          }
                        />
                      ) : (
                        s.recipe
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <NumInput
                          value={s.durationMin ?? ""}
                          onChange={(v) =>
                            setField(`consolidatedSteps[${i}].durationMin`, v)
                          }
                        />
                      ) : (
                        String(s.durationMin ?? "")
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <NumInput
                          value={s.timerSec ?? 0}
                          onChange={(v) =>
                            setField(`consolidatedSteps[${i}].timerSec`, v)
                          }
                        />
                      ) : (
                        String(s.timerSec ?? 0)
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextArea
                          rows={2}
                          value={s.notes || ""}
                          onChange={(v) =>
                            setField(`consolidatedSteps[${i}].notes`, v)
                          }
                        />
                      ) : (
                        s.notes
                      )}
                    </td>
                    {canCRUD ? (
                      <td>
                        <Btn
                          kind="danger"
                          onClick={() =>
                            removeItem(
                              `consolidatedSteps[${i}]`,
                              "Delete this step?"
                            )
                          }
                        >
                          Delete
                        </Btn>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const renderTimers = () => {
    const timers = Array.isArray(state.timers) ? state.timers : [];
    return (
      <div className="ssa-card">
        <div className="ssa-card-header">
          <div className="ssa-card-title">{SCHEMA.labels.timers}</div>
          <div className="ssa-card-actions">
            {canCRUD ? (
              <Btn
                kind="primary"
                onClick={() => addItem("timers", newTimer(), "timer")}
              >
                + Add Timer
              </Btn>
            ) : null}
          </div>
        </div>

        {timers.length === 0 ? (
          <EmptyState
            title="No timers listed."
            body="Timers can mirror multi-timer panel entries."
            addLabel="Add timer"
            onAdd={() => addItem("timers", newTimer(), "timer")}
          />
        ) : (
          <div className="ssa-table-wrap">
            <table className="ssa-table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Seconds</th>
                  <th>Start at Step #</th>
                  <th>Notes</th>
                  {canCRUD ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {timers.map((t, i) => (
                  <tr key={t?.id || `tmr_${i}`}>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={t.label}
                          onChange={(v) => setField(`timers[${i}].label`, v)}
                        />
                      ) : (
                        t.label
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <NumInput
                          value={t.seconds ?? 0}
                          onChange={(v) => setField(`timers[${i}].seconds`, v)}
                        />
                      ) : (
                        String(t.seconds ?? 0)
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <NumInput
                          value={t.startAtStepIndex ?? 0}
                          onChange={(v) =>
                            setField(`timers[${i}].startAtStepIndex`, v)
                          }
                        />
                      ) : (
                        String(t.startAtStepIndex ?? 0)
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextArea
                          rows={2}
                          value={t.notes || ""}
                          onChange={(v) => setField(`timers[${i}].notes`, v)}
                        />
                      ) : (
                        t.notes
                      )}
                    </td>
                    {canCRUD ? (
                      <td>
                        <Btn
                          kind="danger"
                          onClick={() =>
                            removeItem(`timers[${i}]`, "Delete this timer?")
                          }
                        >
                          Delete
                        </Btn>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const renderSections = () => {
    const sections = Array.isArray(state.sections) ? state.sections : [];

    return (
      <div className="ssa-card">
        <div className="ssa-card-header">
          <div className="ssa-card-title">{SCHEMA.labels.sections}</div>
          <div className="ssa-card-actions">
            {canCRUD ? (
              <Btn
                kind="primary"
                onClick={() => addItem("sections", newSection(), "section")}
              >
                + Add Section
              </Btn>
            ) : null}
          </div>
        </div>

        {sections.length === 0 ? (
          <EmptyState
            title="No sections yet."
            body="Sections are narrative blocks (Prep, Cook, Serve, Cleanup) for human readability."
            addLabel="Add section"
            onAdd={() => addItem("sections", newSection(), "section")}
          />
        ) : (
          <div className="ssa-stack">
            {sections.map((sec, si) => {
              const bullets = Array.isArray(sec?.bullets) ? sec.bullets : [];
              const table =
                sec?.table && typeof sec.table === "object" ? sec.table : null;

              return (
                <div key={sec?.id || `sec_${si}`} className="ssa-subcard">
                  <div className="ssa-subcard-header">
                    <div className="ssa-subcard-title">
                      {canEdit ? (
                        <TextInput
                          value={sec?.title}
                          placeholder="Section title"
                          onChange={(v) => setField(`sections[${si}].title`, v)}
                        />
                      ) : (
                        <strong>{sec?.title}</strong>
                      )}
                    </div>
                    <div className="ssa-subcard-actions">
                      {canCRUD ? (
                        <>
                          <Btn
                            onClick={() =>
                              addItem(
                                `sections[${si}].bullets`,
                                SCHEMA.defaults.bullet,
                                "bullet"
                              )
                            }
                          >
                            + Bullet
                          </Btn>
                          <Btn
                            onClick={() => ensureSectionTable(si)}
                            title="Add a table to this section"
                          >
                            + Table
                          </Btn>
                          <Btn
                            kind="danger"
                            onClick={() =>
                              removeItem(
                                `sections[${si}]`,
                                "Delete this entire section?"
                              )
                            }
                          >
                            Delete Section
                          </Btn>
                        </>
                      ) : null}
                    </div>
                  </div>

                  <div className="ssa-block">
                    <div className="ssa-block-title">Bullets</div>
                    {bullets.length === 0 ? (
                      <EmptyState
                        title="No bullets"
                        body="Bullets can be prep notes, sequencing, or serving instructions."
                        addLabel="Add bullet"
                        onAdd={() =>
                          addItem(
                            `sections[${si}].bullets`,
                            SCHEMA.defaults.bullet,
                            "bullet"
                          )
                        }
                      />
                    ) : (
                      <ul className="ssa-list">
                        {bullets.map((b, bi) => (
                          <li key={`b_${si}_${bi}`} className="ssa-list-item">
                            {canEdit ? (
                              <TextInput
                                value={b}
                                onChange={(v) =>
                                  setField(`sections[${si}].bullets[${bi}]`, v)
                                }
                              />
                            ) : (
                              <span>{b}</span>
                            )}
                            {canCRUD ? (
                              <Btn
                                kind="danger"
                                onClick={() =>
                                  removeItem(
                                    `sections[${si}].bullets[${bi}]`,
                                    "Delete this bullet?"
                                  )
                                }
                              >
                                Delete
                              </Btn>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {table ? (
                    <div className="ssa-block">
                      <div className="ssa-block-title">Table</div>
                      <div className="ssa-table-wrap">
                        <table className="ssa-table">
                          <thead>
                            <tr>
                              {(table.columns || []).map((c, ci) => (
                                <th key={`c_${si}_${ci}`}>{String(c)}</th>
                              ))}
                              {canCRUD ? <th>Actions</th> : null}
                            </tr>
                          </thead>
                          <tbody>
                            {(table.rows || []).map((row, ri) => (
                              <tr key={`r_${si}_${ri}`}>
                                {(row || []).map((cell, ci) => (
                                  <td key={`cell_${si}_${ri}_${ci}`}>
                                    {canEdit ? (
                                      <TextInput
                                        value={cell}
                                        onChange={(v) =>
                                          setField(
                                            `sections[${si}].table.rows[${ri}][${ci}]`,
                                            v
                                          )
                                        }
                                      />
                                    ) : (
                                      String(cell ?? "")
                                    )}
                                  </td>
                                ))}
                                {canCRUD ? (
                                  <td>
                                    <Btn
                                      kind="danger"
                                      onClick={() =>
                                        removeItem(
                                          `sections[${si}].table.rows[${ri}]`,
                                          "Delete this row?"
                                        )
                                      }
                                    >
                                      Delete Row
                                    </Btn>
                                  </td>
                                ) : null}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {canCRUD ? (
                        <div className="ssa-row-actions">
                          <Btn
                            onClick={() =>
                              addItem(
                                `sections[${si}].table.rows`,
                                new Array((table.columns || []).length).fill(
                                  ""
                                ),
                                "tableRow"
                              )
                            }
                          >
                            + Add Row
                          </Btn>
                          <Btn
                            kind="danger"
                            onClick={() =>
                              removeItem(
                                `sections[${si}].table`,
                                "Remove table from this section?"
                              )
                            }
                          >
                            Remove Table
                          </Btn>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderTasks = () => {
    const tasks = Array.isArray(state.tasks) ? state.tasks : [];
    return (
      <div className="ssa-card">
        <div className="ssa-card-header">
          <div className="ssa-card-title">{SCHEMA.labels.tasks}</div>
          <div className="ssa-card-actions">
            {canCRUD ? (
              <Btn
                kind="primary"
                onClick={() => addItem("tasks", newTask(), "task")}
              >
                + Add Task
              </Btn>
            ) : null}
          </div>
        </div>

        {tasks.length === 0 ? (
          <EmptyState
            title="No tasks yet."
            body="Tasks are actionable items that can be compiled into the session."
            addLabel="Add task"
            onAdd={() => addItem("tasks", newTask(), "task")}
          />
        ) : (
          <div className="ssa-table-wrap">
            <table className="ssa-table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Station</th>
                  <th>Priority</th>
                  <th>Duration (min)</th>
                  <th>Due ISO</th>
                  {canCRUD ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {tasks.map((t, i) => (
                  <tr key={t?.id || `task_${i}`}>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={t.label}
                          onChange={(v) => setField(`tasks[${i}].label`, v)}
                        />
                      ) : (
                        t.label
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={t.station || ""}
                          onChange={(v) => setField(`tasks[${i}].station`, v)}
                        />
                      ) : (
                        t.station
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <Select
                          value={t.priority || "med"}
                          onChange={(v) => setField(`tasks[${i}].priority`, v)}
                          options={[
                            { value: "high", label: "high" },
                            { value: "med", label: "med" },
                            { value: "low", label: "low" },
                          ]}
                        />
                      ) : (
                        t.priority
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <NumInput
                          value={t.durationMin ?? ""}
                          onChange={(v) =>
                            setField(`tasks[${i}].durationMin`, v)
                          }
                        />
                      ) : (
                        String(t.durationMin ?? "")
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={t.dueISO || ""}
                          placeholder="YYYY-MM-DDTHH:mm:ssZ"
                          onChange={(v) => setField(`tasks[${i}].dueISO`, v)}
                        />
                      ) : (
                        t.dueISO
                      )}
                    </td>
                    {canCRUD ? (
                      <td>
                        <Btn
                          kind="danger"
                          onClick={() =>
                            removeItem(`tasks[${i}]`, "Delete this task?")
                          }
                        >
                          Delete
                        </Btn>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const renderAlerts = () => {
    const alerts = Array.isArray(state.inventoryAlerts)
      ? state.inventoryAlerts
      : [];
    return (
      <div className="ssa-card">
        <div className="ssa-card-header">
          <div className="ssa-card-title">{SCHEMA.labels.inventoryAlerts}</div>
          <div className="ssa-card-actions">
            {canCRUD ? (
              <Btn
                kind="primary"
                onClick={() => addItem("inventoryAlerts", newAlert(), "alert")}
              >
                + Add Alert
              </Btn>
            ) : null}
          </div>
        </div>

        {alerts.length === 0 ? (
          <EmptyState
            title="No inventory alerts yet."
            body="Use this for missing ingredients/tools or substitutions."
            addLabel="Add alert"
            onAdd={() => addItem("inventoryAlerts", newAlert(), "alert")}
          />
        ) : (
          <div className="ssa-table-wrap">
            <table className="ssa-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Needed Qty</th>
                  <th>Unit</th>
                  <th>Severity</th>
                  <th>Suggestion</th>
                  {canCRUD ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {alerts.map((a, i) => (
                  <tr key={a?.id || `alert_${i}`}>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={a.item}
                          onChange={(v) =>
                            setField(`inventoryAlerts[${i}].item`, v)
                          }
                        />
                      ) : (
                        a.item
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <>
                          <NumInput
                            value={a.neededQty ?? ""}
                            min={0}
                            onChange={(v) =>
                              setField(`inventoryAlerts[${i}].neededQty`, v)
                            }
                          />
                          {clampHints[`inventoryAlerts[${i}].neededQty`] ? (
                            <div className="ssa-clamp-hint" role="note">
                              {CLAMP_HINT_TEXT}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        String(a.neededQty ?? "")
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={a.unit}
                          onChange={(v) =>
                            setField(`inventoryAlerts[${i}].unit`, v)
                          }
                        />
                      ) : (
                        a.unit
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <Select
                          value={a.severity || "low"}
                          onChange={(v) =>
                            setField(`inventoryAlerts[${i}].severity`, v)
                          }
                          options={[
                            { value: "high", label: "high" },
                            { value: "med", label: "med" },
                            { value: "low", label: "low" },
                          ]}
                        />
                      ) : (
                        a.severity
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextArea
                          rows={2}
                          value={a.suggestion || ""}
                          onChange={(v) =>
                            setField(`inventoryAlerts[${i}].suggestion`, v)
                          }
                        />
                      ) : (
                        a.suggestion
                      )}
                    </td>
                    {canCRUD ? (
                      <td>
                        <Btn
                          kind="danger"
                          onClick={() =>
                            removeItem(
                              `inventoryAlerts[${i}]`,
                              "Delete this alert?"
                            )
                          }
                        >
                          Delete
                        </Btn>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const renderReminders = () => {
    const rems = Array.isArray(state.healthReminders)
      ? state.healthReminders
      : [];
    return (
      <div className="ssa-card">
        <div className="ssa-card-header">
          <div className="ssa-card-title">{SCHEMA.labels.healthReminders}</div>
          <div className="ssa-card-actions">
            {canCRUD ? (
              <Btn
                kind="primary"
                onClick={() =>
                  addItem("healthReminders", newReminder(), "reminder")
                }
              >
                + Add Reminder
              </Btn>
            ) : null}
          </div>
        </div>

        {rems.length === 0 ? (
          <EmptyState
            title="No reminders yet."
            body="Use this for recurring kitchen reminders (deep clean fridge, rotate pantry, sharpen knives)."
            addLabel="Add reminder"
            onAdd={() => addItem("healthReminders", newReminder(), "reminder")}
          />
        ) : (
          <div className="ssa-table-wrap">
            <table className="ssa-table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Cadence</th>
                  <th>Next Due ISO</th>
                  {canCRUD ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {rems.map((r, i) => (
                  <tr key={r?.id || `rem_${i}`}>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={r.label || ""}
                          onChange={(v) =>
                            setField(`healthReminders[${i}].label`, v)
                          }
                        />
                      ) : (
                        r.label
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <Select
                          value={r.cadence || "weekly"}
                          onChange={(v) =>
                            setField(`healthReminders[${i}].cadence`, v)
                          }
                          options={[
                            { value: "daily", label: "daily" },
                            { value: "weekly", label: "weekly" },
                            { value: "monthly", label: "monthly" },
                            { value: "seasonal", label: "seasonal" },
                          ]}
                        />
                      ) : (
                        r.cadence
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={r.nextDueISO || ""}
                          placeholder="YYYY-MM-DDTHH:mm:ssZ"
                          onChange={(v) =>
                            setField(`healthReminders[${i}].nextDueISO`, v)
                          }
                        />
                      ) : (
                        r.nextDueISO
                      )}
                    </td>
                    {canCRUD ? (
                      <td>
                        <Btn
                          kind="danger"
                          onClick={() =>
                            removeItem(
                              `healthReminders[${i}]`,
                              "Delete this reminder?"
                            )
                          }
                        >
                          Delete
                        </Btn>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  /* ------------------------------- Main UI ---------------------------------- */
  return (
    <div className={`ssa-draft ${className}`}>
      <style>{`
        .ssa-draft{display:flex;flex-direction:column;gap:12px;font-family:system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;}
        .ssa-card{border:1px solid rgba(0,0,0,.12);border-radius:12px;padding:12px;background:#fff}
        .ssa-subcard{border:1px solid rgba(0,0,0,.10);border-radius:12px;padding:10px;background:#fafafa}
        .ssa-card-header,.ssa-subcard-header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
        .ssa-card-title{font-weight:700;font-size:14px}
        .ssa-subcard-title{font-weight:700;font-size:13px;min-width:240px;flex:1}
        .ssa-card-actions,.ssa-subcard-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
        .ssa-field{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}
        .ssa-label{font-size:12px;opacity:.8}
        .ssa-control{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
        .ssa-input,.ssa-textarea,.ssa-select{width:100%;max-width:100%;padding:8px 10px;border:1px solid rgba(0,0,0,.14);border-radius:10px;background:#fff}
        .ssa-textarea{resize:vertical}
        .ssa-btn{padding:8px 10px;border-radius:10px;border:1px solid rgba(0,0,0,.15);background:#fff;cursor:pointer}
        .ssa-btn-primary{background:#111;color:#fff;border-color:#111}
        .ssa-btn-danger{background:#b00020;color:#fff;border-color:#b00020}
        .ssa-btn-disabled{opacity:.5;cursor:not-allowed}
        .ssa-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
        .ssa-list-item{display:flex;align-items:center;gap:8px}
        .ssa-stack{display:flex;flex-direction:column;gap:10px}
        .ssa-block{margin-top:10px}
        .ssa-block-title{font-weight:600;font-size:12px;opacity:.85;margin-bottom:6px}
        .ssa-empty{border:1px dashed rgba(0,0,0,.18);border-radius:12px;padding:12px;background:#fff}
        .ssa-empty-title{font-weight:700;margin-bottom:4px}
        .ssa-empty-body{opacity:.85;font-size:13px;margin-bottom:10px}
        .ssa-empty-actions{display:flex;gap:8px}
        .ssa-table-wrap{overflow:auto}
        .ssa-table{width:100%;border-collapse:separate;border-spacing:0;min-width:920px}
        .ssa-table th,.ssa-table td{border-bottom:1px solid rgba(0,0,0,.10);padding:8px;vertical-align:top}
        .ssa-table th{font-size:12px;text-align:left;opacity:.85}
        .ssa-row-actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
        .ssa-header{border:1px solid rgba(0,0,0,.12);border-radius:12px;padding:12px;background:#fff}
        .ssa-header-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
        .ssa-title{font-weight:800;font-size:16px}
        .ssa-pill{font-size:12px;border:1px solid rgba(0,0,0,.14);border-radius:999px;padding:4px 10px;opacity:.85}
        .ssa-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
        .ssa-debug{margin-top:10px}
        .ssa-pre{white-space:pre-wrap;word-break:break-word;background:#0b1020;color:#e8e8e8;border-radius:12px;padding:10px;font-size:12px}
      `}</style>

      <div className="ssa-header">
        <div className="ssa-header-top">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="ssa-title">{SCHEMA.labels.title}</div>
            <div className="ssa-pill">{state.id}</div>
          </div>
          <div className="ssa-actions">
            {canEdit ? (
              <Btn
                onClick={undo}
                disabled={(historyRef.current || []).length === 0}
                title="Undo last change"
              >
                Undo
              </Btn>
            ) : null}
            {/* TODO: Dexie persistence */}
            {/* TODO: Hub export */}
          </div>
        </div>

        <Field label="Title">
          {canEdit ? (
            <TextInput
              value={state.title}
              onChange={(v) => setField("title", v)}
            />
          ) : (
            <div>{state.title}</div>
          )}
        </Field>

        <Field label="Summary">
          {canEdit ? (
            <TextArea
              value={state.summary}
              onChange={(v) => setField("summary", v)}
              rows={3}
            />
          ) : (
            <div>{state.summary}</div>
          )}
        </Field>
      </div>

      {renderRecipes()}
      {renderIngredients()}
      {renderEquipment()}
      {renderConsolidatedSteps()}
      {renderTimers()}

      {renderAssumptions()}
      {renderSections()}
      {renderTasks()}
      {renderAlerts()}
      {renderReminders()}

      {editable ? (
        <div className="ssa-card ssa-debug">
          <div className="ssa-card-header">
            <div className="ssa-card-title">{SCHEMA.labels.debug}</div>
            <div className="ssa-card-actions">
              <Btn onClick={() => setDebugOpen((v) => !v)}>
                {debugOpen ? "Hide" : "Show"}
              </Btn>
            </div>
          </div>
          {debugOpen ? (
            <pre className="ssa-pre">{JSON.stringify(state, null, 2)}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
