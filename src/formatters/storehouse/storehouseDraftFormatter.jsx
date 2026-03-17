/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\formatters\storehouse\storehouseDraftFormatter.jsx

import React, { useEffect, useMemo, useRef, useState } from "react";
import { coerceNonNegativeNumber } from "@/ui/ux/validation";

/**
 * Storehouse Draft Formatter (CRUD-capable)
 * -----------------------------------------------------------------------------
 * - Accepts resolved draft OR wrapper { via, res }
 * - Normalizes missing fields safely
 * - Full CRUD (create/read/update/delete) for all blocks
 * - Emits eventBus events on mount + every mutation
 * - Produces patch records for every change
 * - Undo last change (keeps at least 10 history entries)
 * - Debug Raw Draft JSON collapsible when editable===true
 *
 * NOTE:
 * - No DB writes here. Only local state updates + callbacks + event emit.
 * - TODO stubs included for Dexie/Hub persistence/export.
 */

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
  domain: "storehouse",
  labels: {
    title: "Storehouse Draft",
    assumptions: "Assumptions",
    sections: "Sections",
    tasks: "Tasks",
    inventoryAlerts: "Inventory Alerts",
    healthReminders: "Reminders",
    debug: "Debug Raw Draft JSON",

    targets: "Targets",
    stockList: "Stock List",
    locations: "Storage Locations",
    rotations: "Rotation & Shelf Life",
    preservation: "Preservation Plan",
  },
  defaults: {
    sectionTitle: "New Section",
    bullet: "New bullet…",
    task: { label: "New task…", priority: "med", durationMin: 20, dueISO: "" },
    alert: {
      item: "New item…",
      neededQty: 0,
      unit: "",
      severity: "low",
      suggestion: "",
    },
    reminder: { label: "New reminder…", cadence: "weekly", nextDueISO: "" },

    target: {
      label: "Target",
      qty: 0,
      unit: "",
      timeframe: "month",
      notes: "",
    },
    stockItem: {
      item: "Item",
      qty: 0,
      unit: "",
      category: "dry",
      location: "pantry",
      minQty: 0,
      reorderQty: 0,
      rotation: "FIFO",
      shelfLifeDays: 0,
      notes: "",
    },
    location: { name: "Location", type: "pantry", notes: "" },
    rotationRule: {
      item: "Item",
      rotation: "FIFO",
      shelfLifeDays: 0,
      checkCadence: "monthly",
      notes: "",
    },
    preservationItem: {
      item: "Item",
      method: "canning",
      qty: 0,
      unit: "",
      season: "",
      notes: "",
    },
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

/* ---------------------------- Path helpers ---------------------------------- */
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

export function applyPatch(prevDraft, patch) {
  const p = patch || {};
  if (!p.op || !p.path) return prevDraft;
  if (p.op === "set") return setAtPath(prevDraft, p.path, p.value);
  if (p.op === "add") return addAtPath(prevDraft, p.path, p.value);
  if (p.op === "remove") return removeAtPath(prevDraft, p.path);
  return prevDraft;
}

/* ---------------------------- Normalization --------------------------------- */
function normalizeDraftInput(draftOrWrapper) {
  const d = isWrapperDraft(draftOrWrapper)
    ? draftOrWrapper?.res
    : draftOrWrapper;
  const base = d && typeof d === "object" ? d : {};

  const normalized = {
    id: base.id || uid("storehouse_draft"),
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

    // storehouse extras (optional)
    targets: Array.isArray(base.targets)
      ? base.targets
      : Array.isArray(base.provisioningPlan?.targets)
      ? base.provisioningPlan.targets
      : [],
    stockList: Array.isArray(base.stockList)
      ? base.stockList
      : Array.isArray(base.stock?.items)
      ? base.stock.items
      : [],
    locations: Array.isArray(base.locations)
      ? base.locations
      : Array.isArray(base.storage?.locations)
      ? base.storage.locations
      : [],
    rotations: Array.isArray(base.rotations)
      ? base.rotations
      : Array.isArray(base.rotationRules)
      ? base.rotationRules
      : [],
    preservationPlan: Array.isArray(base.preservationPlan)
      ? base.preservationPlan
      : Array.isArray(base.preservation?.items)
      ? base.preservation.items
      : [],

    meta: base.meta || {},
  };

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

  normalized.tasks = normalized.tasks.map((t) => ({
    id: t?.id || uid("task"),
    label: String(t?.label ?? ""),
    priority: t?.priority || "med",
    durationMin: Number.isFinite(Number(t?.durationMin))
      ? Number(t.durationMin)
      : "",
    dueISO: t?.dueISO || "",
  }));

  normalized.inventoryAlerts = normalized.inventoryAlerts.map((a) => ({
    id: a?.id || uid("alert"),
    item: String(a?.item ?? a?.name ?? ""),
    neededQty: a?.neededQty ?? 0,
    unit: a?.unit || "",
    severity: a?.severity || "low",
    suggestion: a?.suggestion || "",
  }));

  normalized.healthReminders = normalized.healthReminders.map((r) => ({
    id: r?.id || uid("rem"),
    label: r?.label || "",
    cadence: r?.cadence || "weekly",
    nextDueISO: r?.nextDueISO || "",
  }));

  normalized.targets = normalized.targets.map((t) => ({
    id: t?.id || uid("tgt"),
    label: t?.label || "Target",
    qty: Number.isFinite(Number(t?.qty)) ? Number(t.qty) : t?.qty ?? 0,
    unit: t?.unit || "",
    timeframe: t?.timeframe || "month",
    notes: t?.notes || "",
  }));

  normalized.locations = normalized.locations.map((l) => ({
    id: l?.id || uid("loc"),
    name: l?.name || "Location",
    type: l?.type || "pantry",
    notes: l?.notes || "",
  }));

  normalized.stockList = normalized.stockList.map((s) => ({
    id: s?.id || uid("stk"),
    item: s?.item || s?.name || "Item",
    qty: Number.isFinite(Number(s?.qty)) ? Number(s.qty) : s?.qty ?? 0,
    unit: s?.unit || "",
    category: s?.category || "dry",
    location: s?.location || "pantry",
    minQty: Number.isFinite(Number(s?.minQty))
      ? Number(s.minQty)
      : s?.minQty ?? 0,
    reorderQty: Number.isFinite(Number(s?.reorderQty))
      ? Number(s.reorderQty)
      : s?.reorderQty ?? 0,
    rotation: s?.rotation || "FIFO",
    shelfLifeDays: Number.isFinite(Number(s?.shelfLifeDays))
      ? Number(s.shelfLifeDays)
      : s?.shelfLifeDays ?? 0,
    notes: s?.notes || "",
  }));

  normalized.rotations = normalized.rotations.map((r) => ({
    id: r?.id || uid("rot"),
    item: r?.item || r?.name || "Item",
    rotation: r?.rotation || "FIFO",
    shelfLifeDays: Number.isFinite(Number(r?.shelfLifeDays))
      ? Number(r.shelfLifeDays)
      : r?.shelfLifeDays ?? 0,
    checkCadence: r?.checkCadence || "monthly",
    notes: r?.notes || "",
  }));

  normalized.preservationPlan = normalized.preservationPlan.map((p) => ({
    id: p?.id || uid("pres"),
    item: p?.item || p?.name || "Item",
    method: p?.method || "canning",
    qty: Number.isFinite(Number(p?.qty)) ? Number(p.qty) : p?.qty ?? 0,
    unit: p?.unit || "",
    season: p?.season || "",
    notes: p?.notes || "",
  }));

  return normalized;
}

/* ----------------------------- UI helpers ----------------------------------- */
function Btn({ children, onClick, disabled, title, kind = "default" }) {
  const cls =
    "ssa-btn " +
    (kind === "primary" ? "ssa-btn-primary " : "") +
    (kind === "danger" ? "ssa-btn-danger " : "") +
    (disabled ? "ssa-btn-disabled" : "");
  return (
    <button
      type="button"
      className={cls.trim()}
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
        const raw = e.target.value;
        if (raw === "") onChange?.("");
        else {
          const parsed = Number(raw);
          if (!Number.isFinite(parsed)) return;
          onChange?.(coerceNonNegativeNumber(parsed, 0));
        }
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
function Select({ value, onChange, options = [], disabled = false }) {
  return (
    <select
      className="ssa-select"
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
function confirmDanger(message) {
  // eslint-disable-next-line no-alert
  return window.confirm(message || "Are you sure?");
}

const NON_NEGATIVE_FIELD_PATH =
  /\.(qty|minQty|reorderQty|neededQty|shelfLifeDays)$/i;

function sanitizeFieldValue(path, value) {
  if (!NON_NEGATIVE_FIELD_PATH.test(path)) return value;
  if (value === "") return "";
  return coerceNonNegativeNumber(value, 0);
}

/* ------------------------------ Empty state --------------------------------- */
function EmptyState({ title, body, onAdd, addLabel = "Add", canCRUD }) {
  return (
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
}

/* ------------------------- Main formatter component ------------------------- */
export default function StorehouseDraftFormatter({
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
  const historyRef = useRef([]);
  const mountedRef = useRef(false);

  useEffect(() => {
    setState(normalizeDraftInput(draft));
  }, [draft]);

  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    try {
      eventBus.emit("draft.read", { domain: DOMAIN, draftId: initial.id });
    } catch {}
  }, [DOMAIN, initial.id]);

  const canEdit = !!editable;
  const canCRUD = !!editable && !!allowCRUD;

  function makePatch(op, path, value) {
    return {
      op,
      path,
      value,
      ts: nowISO(),
      domain: DOMAIN,
      draftId: state?.id || initial?.id,
    };
  }

  function emit(evt, payload) {
    try {
      eventBus.emit(evt, payload);
    } catch {}
  }

  function pushHistory(prevDraft, patch) {
    const stack = historyRef.current || [];
    stack.push({ prev: prevDraft, patch });
    if (stack.length > 10) stack.splice(0, stack.length - 10);
    historyRef.current = stack;
  }

  function commitPatch(patch, meta = {}) {
    setState((prev) => {
      const prevSnapshot = deepClone(prev);
      const nextDraft = applyPatch(prev, patch);

      pushHistory(prevSnapshot, patch);

      onPatch?.(patch);
      onChange?.(nextDraft);

      if (patch.op === "add") {
        onCreate?.({
          kind: meta.kind,
          path: patch.path,
          value: meta.createdValue ?? patch.value,
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
  }

  function setField(path, value) {
    commitPatch(makePatch("set", path, sanitizeFieldValue(path, value)));
  }
  function addItem(path, value, kind) {
    commitPatch(makePatch("add", path, value), { kind, createdValue: value });
  }
  function removeItem(path, message) {
    if (!canCRUD) return;
    if (!confirmDanger(message || "Delete this item?")) return;
    commitPatch(makePatch("remove", path));
  }

  function undo() {
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
  }

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

  const newTarget = () => ({
    id: uid("tgt"),
    ...deepClone(SCHEMA.defaults.target),
  });
  const newLocation = () => ({
    id: uid("loc"),
    ...deepClone(SCHEMA.defaults.location),
  });
  const newStockItem = () => ({
    id: uid("stk"),
    ...deepClone(SCHEMA.defaults.stockItem),
  });
  const newRotation = () => ({
    id: uid("rot"),
    ...deepClone(SCHEMA.defaults.rotationRule),
  });
  const newPreservation = () => ({
    id: uid("pres"),
    ...deepClone(SCHEMA.defaults.preservationItem),
  });

  function ensureSectionTable(sectionIndex) {
    const basePath = `sections[${sectionIndex}].table`;
    const existing = getAtPath(state, basePath);
    if (existing) return;
    const table = { columns: ["Item", "Qty", "Notes"], rows: [["", "", ""]] };
    commitPatch(makePatch("set", basePath, table));
  }

  /* ------------------------------ Renderers -------------------------------- */
  function renderHeader() {
    return (
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
            {/* TODO: Persist to Dexie */}
            {/* TODO: Export to Hub */}
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
    );
  }

  function renderAssumptions() {
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
            body="Assumptions capture constraints (budget, family size, storage limits, dietary rules)."
            addLabel="Add assumption"
            onAdd={() =>
              addItem("assumptions", "New assumption…", "assumption")
            }
            canCRUD={canCRUD}
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
  }

  function renderTargets() {
    const list = Array.isArray(state.targets) ? state.targets : [];
    return (
      <div className="ssa-card">
        <div className="ssa-card-header">
          <div className="ssa-card-title">{SCHEMA.labels.targets}</div>
          <div className="ssa-card-actions">
            {canCRUD ? (
              <Btn
                kind="primary"
                onClick={() => addItem("targets", newTarget(), "target")}
              >
                + Add Target
              </Btn>
            ) : null}
          </div>
        </div>

        {list.length === 0 ? (
          <EmptyState
            title="No targets yet."
            body="Targets define how much you want on hand (weekly, monthly, seasonal, annual)."
            addLabel="Add target"
            onAdd={() => addItem("targets", newTarget(), "target")}
            canCRUD={canCRUD}
          />
        ) : (
          <div className="ssa-table-wrap">
            <table className="ssa-table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Qty</th>
                  <th>Unit</th>
                  <th>Timeframe</th>
                  <th>Notes</th>
                  {canCRUD ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {list.map((t, i) => (
                  <tr key={t.id || `tgt_${i}`}>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={t.label}
                          onChange={(v) => setField(`targets[${i}].label`, v)}
                        />
                      ) : (
                        t.label
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <NumInput
                          value={t.qty ?? 0}
                          min={0}
                          onChange={(v) => setField(`targets[${i}].qty`, v)}
                        />
                      ) : (
                        String(t.qty ?? 0)
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={t.unit}
                          onChange={(v) => setField(`targets[${i}].unit`, v)}
                        />
                      ) : (
                        t.unit
                      )}
                    </td>
                    <td style={{ minWidth: 160 }}>
                      {canEdit ? (
                        <Select
                          value={t.timeframe || "month"}
                          onChange={(v) =>
                            setField(`targets[${i}].timeframe`, v)
                          }
                          options={[
                            { value: "week", label: "week" },
                            { value: "month", label: "month" },
                            { value: "season", label: "season" },
                            { value: "year", label: "year" },
                          ]}
                        />
                      ) : (
                        t.timeframe
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextArea
                          rows={2}
                          value={t.notes || ""}
                          onChange={(v) => setField(`targets[${i}].notes`, v)}
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
                            removeItem(`targets[${i}]`, "Delete this target?")
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
  }

  function renderLocations() {
    const list = Array.isArray(state.locations) ? state.locations : [];
    return (
      <div className="ssa-card">
        <div className="ssa-card-header">
          <div className="ssa-card-title">{SCHEMA.labels.locations}</div>
          <div className="ssa-card-actions">
            {canCRUD ? (
              <Btn
                kind="primary"
                onClick={() => addItem("locations", newLocation(), "location")}
              >
                + Add Location
              </Btn>
            ) : null}
          </div>
        </div>

        {list.length === 0 ? (
          <EmptyState
            title="No locations yet."
            body="Locations map real storage (pantry, freezer, root cellar, shed)."
            addLabel="Add location"
            onAdd={() => addItem("locations", newLocation(), "location")}
            canCRUD={canCRUD}
          />
        ) : (
          <div className="ssa-table-wrap">
            <table className="ssa-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Notes</th>
                  {canCRUD ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {list.map((l, i) => (
                  <tr key={l.id || `loc_${i}`}>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={l.name}
                          onChange={(v) => setField(`locations[${i}].name`, v)}
                        />
                      ) : (
                        l.name
                      )}
                    </td>
                    <td style={{ minWidth: 180 }}>
                      {canEdit ? (
                        <Select
                          value={l.type || "pantry"}
                          onChange={(v) => setField(`locations[${i}].type`, v)}
                          options={[
                            { value: "pantry", label: "pantry" },
                            { value: "freezer", label: "freezer" },
                            { value: "fridge", label: "fridge" },
                            { value: "root-cellar", label: "root-cellar" },
                            { value: "shed", label: "shed" },
                            { value: "other", label: "other" },
                          ]}
                        />
                      ) : (
                        l.type
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextArea
                          rows={2}
                          value={l.notes || ""}
                          onChange={(v) => setField(`locations[${i}].notes`, v)}
                        />
                      ) : (
                        l.notes
                      )}
                    </td>
                    {canCRUD ? (
                      <td>
                        <Btn
                          kind="danger"
                          onClick={() =>
                            removeItem(
                              `locations[${i}]`,
                              "Delete this location?"
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
  }

  function renderStockList() {
    const list = Array.isArray(state.stockList) ? state.stockList : [];
    return (
      <div className="ssa-card">
        <div className="ssa-card-header">
          <div className="ssa-card-title">{SCHEMA.labels.stockList}</div>
          <div className="ssa-card-actions">
            {canCRUD ? (
              <Btn
                kind="primary"
                onClick={() =>
                  addItem("stockList", newStockItem(), "stockItem")
                }
              >
                + Add Stock Item
              </Btn>
            ) : null}
          </div>
        </div>

        {list.length === 0 ? (
          <EmptyState
            title="No stock items yet."
            body="Stock list defines what should exist with min/reorder thresholds."
            addLabel="Add stock item"
            onAdd={() => addItem("stockList", newStockItem(), "stockItem")}
            canCRUD={canCRUD}
          />
        ) : (
          <div className="ssa-table-wrap">
            <table className="ssa-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Qty</th>
                  <th>Unit</th>
                  <th>Category</th>
                  <th>Location</th>
                  <th>Min</th>
                  <th>Reorder</th>
                  <th>Rotation</th>
                  <th>Shelf Life (days)</th>
                  <th>Notes</th>
                  {canCRUD ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {list.map((s, i) => (
                  <tr key={s.id || `stk_${i}`}>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={s.item}
                          onChange={(v) => setField(`stockList[${i}].item`, v)}
                        />
                      ) : (
                        s.item
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <NumInput
                          value={s.qty ?? 0}
                          min={0}
                          onChange={(v) => setField(`stockList[${i}].qty`, v)}
                        />
                      ) : (
                        String(s.qty ?? 0)
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={s.unit}
                          onChange={(v) => setField(`stockList[${i}].unit`, v)}
                        />
                      ) : (
                        s.unit
                      )}
                    </td>
                    <td style={{ minWidth: 140 }}>
                      {canEdit ? (
                        <Select
                          value={s.category || "dry"}
                          onChange={(v) =>
                            setField(`stockList[${i}].category`, v)
                          }
                          options={[
                            { value: "dry", label: "dry" },
                            { value: "canned", label: "canned" },
                            { value: "frozen", label: "frozen" },
                            { value: "fresh", label: "fresh" },
                            { value: "spices", label: "spices" },
                            { value: "medical", label: "medical" },
                            { value: "hygiene", label: "hygiene" },
                            { value: "cleaning", label: "cleaning" },
                            { value: "other", label: "other" },
                          ]}
                        />
                      ) : (
                        s.category
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={s.location}
                          onChange={(v) =>
                            setField(`stockList[${i}].location`, v)
                          }
                        />
                      ) : (
                        s.location
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <NumInput
                          value={s.minQty ?? 0}
                          min={0}
                          onChange={(v) =>
                            setField(`stockList[${i}].minQty`, v)
                          }
                        />
                      ) : (
                        String(s.minQty ?? 0)
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <NumInput
                          value={s.reorderQty ?? 0}
                          min={0}
                          onChange={(v) =>
                            setField(`stockList[${i}].reorderQty`, v)
                          }
                        />
                      ) : (
                        String(s.reorderQty ?? 0)
                      )}
                    </td>
                    <td style={{ minWidth: 110 }}>
                      {canEdit ? (
                        <Select
                          value={s.rotation || "FIFO"}
                          onChange={(v) =>
                            setField(`stockList[${i}].rotation`, v)
                          }
                          options={[
                            { value: "FIFO", label: "FIFO" },
                            { value: "FEFO", label: "FEFO" },
                            { value: "LIFO", label: "LIFO" },
                          ]}
                        />
                      ) : (
                        s.rotation
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <NumInput
                          value={s.shelfLifeDays ?? 0}
                          min={0}
                          onChange={(v) =>
                            setField(`stockList[${i}].shelfLifeDays`, v)
                          }
                        />
                      ) : (
                        String(s.shelfLifeDays ?? 0)
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextArea
                          rows={2}
                          value={s.notes || ""}
                          onChange={(v) => setField(`stockList[${i}].notes`, v)}
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
                              `stockList[${i}]`,
                              "Delete this stock item?"
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
  }

  function renderRotations() {
    const list = Array.isArray(state.rotations) ? state.rotations : [];
    return (
      <div className="ssa-card">
        <div className="ssa-card-header">
          <div className="ssa-card-title">{SCHEMA.labels.rotations}</div>
          <div className="ssa-card-actions">
            {canCRUD ? (
              <Btn
                kind="primary"
                onClick={() => addItem("rotations", newRotation(), "rotation")}
              >
                + Add Rule
              </Btn>
            ) : null}
          </div>
        </div>

        {list.length === 0 ? (
          <EmptyState
            title="No rotation rules yet."
            body="Rotation rules define how to use & check shelf life on a cadence."
            addLabel="Add rotation rule"
            onAdd={() => addItem("rotations", newRotation(), "rotation")}
            canCRUD={canCRUD}
          />
        ) : (
          <div className="ssa-table-wrap">
            <table className="ssa-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Rotation</th>
                  <th>Shelf Life (days)</th>
                  <th>Check Cadence</th>
                  <th>Notes</th>
                  {canCRUD ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {list.map((r, i) => (
                  <tr key={r.id || `rot_${i}`}>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={r.item}
                          onChange={(v) => setField(`rotations[${i}].item`, v)}
                        />
                      ) : (
                        r.item
                      )}
                    </td>
                    <td style={{ minWidth: 110 }}>
                      {canEdit ? (
                        <Select
                          value={r.rotation || "FIFO"}
                          onChange={(v) =>
                            setField(`rotations[${i}].rotation`, v)
                          }
                          options={[
                            { value: "FIFO", label: "FIFO" },
                            { value: "FEFO", label: "FEFO" },
                            { value: "LIFO", label: "LIFO" },
                          ]}
                        />
                      ) : (
                        r.rotation
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <NumInput
                          value={r.shelfLifeDays ?? 0}
                          min={0}
                          onChange={(v) =>
                            setField(`rotations[${i}].shelfLifeDays`, v)
                          }
                        />
                      ) : (
                        String(r.shelfLifeDays ?? 0)
                      )}
                    </td>
                    <td style={{ minWidth: 140 }}>
                      {canEdit ? (
                        <Select
                          value={r.checkCadence || "monthly"}
                          onChange={(v) =>
                            setField(`rotations[${i}].checkCadence`, v)
                          }
                          options={[
                            { value: "weekly", label: "weekly" },
                            { value: "monthly", label: "monthly" },
                            { value: "quarterly", label: "quarterly" },
                            { value: "seasonal", label: "seasonal" },
                          ]}
                        />
                      ) : (
                        r.checkCadence
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextArea
                          rows={2}
                          value={r.notes || ""}
                          onChange={(v) => setField(`rotations[${i}].notes`, v)}
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
                              `rotations[${i}]`,
                              "Delete this rotation rule?"
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
  }

  function renderPreservationPlan() {
    const list = Array.isArray(state.preservationPlan)
      ? state.preservationPlan
      : [];
    return (
      <div className="ssa-card">
        <div className="ssa-card-header">
          <div className="ssa-card-title">{SCHEMA.labels.preservation}</div>
          <div className="ssa-card-actions">
            {canCRUD ? (
              <Btn
                kind="primary"
                onClick={() =>
                  addItem(
                    "preservationPlan",
                    newPreservation(),
                    "preservationItem"
                  )
                }
              >
                + Add Item
              </Btn>
            ) : null}
          </div>
        </div>

        {list.length === 0 ? (
          <EmptyState
            title="No preservation plan items yet."
            body="Track what to preserve and how (canning, dehydrating, freezing, curing, fermenting)."
            addLabel="Add preservation item"
            onAdd={() =>
              addItem("preservationPlan", newPreservation(), "preservationItem")
            }
            canCRUD={canCRUD}
          />
        ) : (
          <div className="ssa-table-wrap">
            <table className="ssa-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Method</th>
                  <th>Qty</th>
                  <th>Unit</th>
                  <th>Season</th>
                  <th>Notes</th>
                  {canCRUD ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {list.map((p, i) => (
                  <tr key={p.id || `pres_${i}`}>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={p.item}
                          onChange={(v) =>
                            setField(`preservationPlan[${i}].item`, v)
                          }
                        />
                      ) : (
                        p.item
                      )}
                    </td>
                    <td style={{ minWidth: 160 }}>
                      {canEdit ? (
                        <Select
                          value={p.method || "canning"}
                          onChange={(v) =>
                            setField(`preservationPlan[${i}].method`, v)
                          }
                          options={[
                            { value: "canning", label: "canning" },
                            { value: "dehydrating", label: "dehydrating" },
                            { value: "freezing", label: "freezing" },
                            { value: "curing", label: "curing" },
                            { value: "fermenting", label: "fermenting" },
                            { value: "smoking", label: "smoking" },
                            { value: "other", label: "other" },
                          ]}
                        />
                      ) : (
                        p.method
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <NumInput
                          value={p.qty ?? 0}
                          min={0}
                          onChange={(v) =>
                            setField(`preservationPlan[${i}].qty`, v)
                          }
                        />
                      ) : (
                        String(p.qty ?? 0)
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={p.unit}
                          onChange={(v) =>
                            setField(`preservationPlan[${i}].unit`, v)
                          }
                        />
                      ) : (
                        p.unit
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={p.season || ""}
                          placeholder="e.g. summer"
                          onChange={(v) =>
                            setField(`preservationPlan[${i}].season`, v)
                          }
                        />
                      ) : (
                        p.season
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <TextArea
                          rows={2}
                          value={p.notes || ""}
                          onChange={(v) =>
                            setField(`preservationPlan[${i}].notes`, v)
                          }
                        />
                      ) : (
                        p.notes
                      )}
                    </td>
                    {canCRUD ? (
                      <td>
                        <Btn
                          kind="danger"
                          onClick={() =>
                            removeItem(
                              `preservationPlan[${i}]`,
                              "Delete this preservation item?"
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
  }

  function renderSections() {
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
            body="Sections can describe policies: stock rules, purchase cadence, emergency buffer, seasonal goals."
            addLabel="Add section"
            onAdd={() => addItem("sections", newSection(), "section")}
            canCRUD={canCRUD}
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
                        body="Bullets can be rules, quick notes, or purchasing guidance."
                        addLabel="Add bullet"
                        onAdd={() =>
                          addItem(
                            `sections[${si}].bullets`,
                            SCHEMA.defaults.bullet,
                            "bullet"
                          )
                        }
                        canCRUD={canCRUD}
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
  }

  function renderTasks() {
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
            body="Tasks are actionable items that can become sessions (audit, restock, rotate pantry, label freezer)."
            addLabel="Add task"
            onAdd={() => addItem("tasks", newTask(), "task")}
            canCRUD={canCRUD}
          />
        ) : (
          <div className="ssa-table-wrap">
            <table className="ssa-table">
              <thead>
                <tr>
                  <th>Label</th>
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
                    <td style={{ minWidth: 110 }}>
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
                          value={t.durationMin}
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
  }

  function renderAlerts() {
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
            title="No inventory alerts."
            body="Alerts capture shortages and suggestions (what to buy / how much / substitute)."
            addLabel="Add alert"
            onAdd={() => addItem("inventoryAlerts", newAlert(), "alert")}
            canCRUD={canCRUD}
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
                        <NumInput
                          value={a.neededQty ?? 0}
                          min={0}
                          onChange={(v) =>
                            setField(`inventoryAlerts[${i}].neededQty`, v)
                          }
                        />
                      ) : (
                        String(a.neededQty ?? 0)
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
                    <td style={{ minWidth: 120 }}>
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
  }

  function renderReminders() {
    const list = Array.isArray(state.healthReminders)
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

        {list.length === 0 ? (
          <EmptyState
            title="No reminders."
            body="Use reminders for rotation checks, audits, and recurring storehouse rhythms."
            addLabel="Add reminder"
            onAdd={() => addItem("healthReminders", newReminder(), "reminder")}
            canCRUD={canCRUD}
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
                {list.map((r, i) => (
                  <tr key={r?.id || `rem_${i}`}>
                    <td>
                      {canEdit ? (
                        <TextInput
                          value={r.label}
                          onChange={(v) =>
                            setField(`healthReminders[${i}].label`, v)
                          }
                        />
                      ) : (
                        r.label
                      )}
                    </td>
                    <td style={{ minWidth: 140 }}>
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
  }

  function renderDebug() {
    if (!canEdit) return null;
    return (
      <div className="ssa-card">
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
        ) : (
          <div className="ssa-muted">
            Toggle to view the raw draft JSON for troubleshooting.
          </div>
        )}
      </div>
    );
  }

  /* ------------------------------ Main render ------------------------------- */
  return (
    <div className={`ssa-draft-root ${className || ""}`.trim()}>
      {/* Minimal embedded styles (portable, no external libs) */}
      <style>{`
        .ssa-draft-root{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; line-height:1.35; padding:12px; max-width:1100px}
        .ssa-header{border:1px solid #ddd; border-radius:12px; padding:12px; margin-bottom:12px; background:#fff}
        .ssa-header-top{display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px}
        .ssa-title{font-weight:800; font-size:18px}
        .ssa-pill{font-size:12px; padding:3px 8px; border:1px solid #ddd; border-radius:999px; color:#333; background:#fafafa}
        .ssa-actions{display:flex; gap:8px; flex-wrap:wrap}
        .ssa-card{border:1px solid #ddd; border-radius:12px; padding:12px; margin-bottom:12px; background:#fff}
        .ssa-card-header{display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px}
        .ssa-card-title{font-weight:800}
        .ssa-card-actions{display:flex; gap:8px; flex-wrap:wrap}
        .ssa-field{display:grid; grid-template-columns:140px 1fr; gap:10px; margin:8px 0}
        .ssa-label{font-size:12px; color:#444; padding-top:8px}
        .ssa-control{}
        .ssa-input,.ssa-select,.ssa-textarea{width:100%; box-sizing:border-box; border:1px solid #ccc; border-radius:10px; padding:8px 10px; font-size:14px; background:#fff}
        .ssa-textarea{resize:vertical}
        .ssa-btn{border:1px solid #bbb; background:#fff; border-radius:10px; padding:7px 10px; cursor:pointer; font-size:13px}
        .ssa-btn-primary{border-color:#2a6; background:#2a6; color:#fff}
        .ssa-btn-danger{border-color:#c33; background:#c33; color:#fff}
        .ssa-btn-disabled{opacity:.55; cursor:not-allowed}
        .ssa-empty{border:1px dashed #ccc; border-radius:12px; padding:12px; background:#fafafa}
        .ssa-empty-title{font-weight:800; margin-bottom:6px}
        .ssa-empty-body{color:#555; margin-bottom:10px}
        .ssa-empty-actions{display:flex; gap:8px}
        .ssa-list{list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:8px}
        .ssa-list-item{display:flex; gap:8px; align-items:center}
        .ssa-stack{display:flex; flex-direction:column; gap:10px}
        .ssa-subcard{border:1px solid #eee; border-radius:12px; padding:10px; background:#fcfcfc}
        .ssa-subcard-header{display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px}
        .ssa-subcard-title{font-weight:700; flex:1}
        .ssa-subcard-actions{display:flex; gap:8px; flex-wrap:wrap}
        .ssa-block{margin-top:10px}
        .ssa-block-title{font-weight:800; margin-bottom:6px}
        .ssa-table-wrap{overflow:auto}
        .ssa-table{width:100%; border-collapse:collapse; font-size:13px}
        .ssa-table th,.ssa-table td{border:1px solid #e3e3e3; padding:8px; vertical-align:top}
        .ssa-row-actions{display:flex; gap:8px; margin-top:8px}
        .ssa-pre{border:1px solid #eee; border-radius:12px; padding:10px; overflow:auto; background:#0b0b0b; color:#f2f2f2; font-size:12px}
        .ssa-muted{color:#666; font-size:13px}
        @media (max-width: 720px){
          .ssa-field{grid-template-columns:1fr; }
          .ssa-label{padding-top:0}
        }
      `}</style>

      {renderHeader()}

      {renderAssumptions()}

      {/* Storehouse-specific blocks */}
      {renderTargets()}
      {renderLocations()}
      {renderStockList()}
      {renderRotations()}
      {renderPreservationPlan()}

      {/* Generic required blocks */}
      {renderSections()}
      {renderTasks()}
      {renderAlerts()}
      {renderReminders()}

      {renderDebug()}
    </div>
  );
}
