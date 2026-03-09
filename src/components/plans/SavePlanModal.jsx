// File: src/components/plans/SavePlanModal.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * SavePlanModal
 * -----------------------------------------------------------------------------
 * Production-ready, dependency-tolerant modal for saving "Plans" in SSA.
 *
 * Goals
 *  - Works even if your Plans DB/service is not wired yet (graceful fallback).
 *  - Dexie-first if available (via src/services/db.js export), else localStorage.
 *  - Emits optional events through eventBus if present (src/services/events/eventBus).
 *  - Accessible: ESC close, focus management, click-outside, ARIA roles.
 *
 * Recommended DB table (if you have / will add it):
 *  - plans:
 *      id (PK), kind, domain, title, description, tags, status,
 *      payload (json), createdAtISO, updatedAtISO, version
 *
 * Props
 *  - open: boolean
 *  - onClose: function
 *  - draft: object (your plan draft / blueprint / config to save)
 *  - kind: string (e.g. "mealPlan", "cleaningPlan", "studyPlan", "shoppingPlan")
 *  - domain: string (optional; e.g. "meals", "cleaning", "garden")
 *  - defaultTitle: string (optional)
 *  - defaultDescription: string (optional)
 *  - defaultTags: string[] (optional)
 *  - allowOverwrite: boolean (default true) – show “Update existing” option
 *  - existingPlans: array (optional) – if you already queried; {id,title,kind,domain}
 *  - onSaved: function(result) – called after save { ok, id, storage, record }
 *  - onError: function(error)
 *  - storageKey: string (optional) – localStorage key prefix override
 *  - maxTitleLen: number (default 80)
 *  - maxDescLen: number (default 600)
 *
 * Notes
 *  - This component does not assume your UI library; uses simple CSS classnames:
 *      "modal-overlay", "modal", "card", "btn", "btn-primary", "btn-ghost", etc.
 *    If you already have bridge.scan.css, these should look acceptable.
 */

const SOURCE = "components.plans.SavePlanModal";

/* ---------------------------------- utils ---------------------------------- */
function nowISO() {
  return new Date().toISOString();
}

function safeString(v) {
  if (v == null) return "";
  return String(v);
}

function clampLen(s, max) {
  const str = safeString(s);
  if (!max || max <= 0) return str;
  return str.length > max ? str.slice(0, max) : str;
}

function normalizeTags(input) {
  if (Array.isArray(input)) {
    return input
      .map((t) => safeString(t).trim())
      .filter(Boolean)
      .map((t) => t.replace(/\s+/g, " "))
      .slice(0, 24);
  }
  const raw = safeString(input);
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => t.replace(/\s+/g, " "))
    .slice(0, 24);
}

function makeId(prefix = "plan") {
  // Stable enough for client-side IDs without extra deps
  const rand = Math.random().toString(16).slice(2);
  const t = Date.now().toString(16);
  return `${prefix}_${t}_${rand}`;
}

function isObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function shallowPick(obj, keys) {
  const out = {};
  if (!isObject(obj)) return out;
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

function coerceArrayPlans(existingPlans) {
  if (!Array.isArray(existingPlans)) return [];
  return existingPlans
    .map((p) => (isObject(p) ? p : null))
    .filter(Boolean)
    .map((p) => ({
      id: safeString(p.id),
      title: safeString(p.title || p.name),
      kind: safeString(p.kind),
      domain: safeString(p.domain),
      updatedAtISO: safeString(p.updatedAtISO || p.updatedAt || ""),
      createdAtISO: safeString(p.createdAtISO || p.createdAt || ""),
    }))
    .filter((p) => p.id && p.title);
}

/* -------------------------- optional dependency shims ------------------------ */
async function tryGetDB() {
  // Prefer: src/services/db.js exporting { db } (common SSA pattern)
  // If your project exports default, we try that too.
  try {
    const mod = await import(/* @vite-ignore */ "@/services/db");
    if (mod?.db) return mod.db;
    if (mod?.default) return mod.default;
  } catch (_) {
    // ignore
  }
  return null;
}

async function tryGetEventBus() {
  try {
    const mod = await import(/* @vite-ignore */ "@/services/events/eventBus");
    return mod?.eventBus || mod?.default || null;
  } catch (_) {
    return null;
  }
}

function lsReadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function lsWriteJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (_) {
    return false;
  }
}

/* ------------------------------ storage helpers ----------------------------- */
async function saveToDexie({ record }) {
  const db = await tryGetDB();
  if (!db) {
    const err = new Error("Dexie db not available");
    err.code = "DB_UNAVAILABLE";
    throw err;
  }

  // Accept common table names if you haven’t standardized yet
  const tableCandidates = ["plans", "plan_store", "planStore"];
  let table = null;
  for (const name of tableCandidates) {
    if (db[name] && typeof db[name].put === "function") {
      table = db[name];
      break;
    }
  }
  if (!table) {
    const err = new Error("No plans table found on db (expected: db.plans)");
    err.code = "PLANS_TABLE_MISSING";
    throw err;
  }

  // put() upserts by PK; add() inserts only
  await table.put(record);
  return { ok: true, storage: "dexie", id: record.id, record };
}

async function saveToLocalStorage({ record, storageKey }) {
  const key = storageKey || "ssa.plans";
  const list = lsReadJSON(key, []);
  const arr = Array.isArray(list) ? list : [];

  const idx = arr.findIndex((p) => p && p.id === record.id);
  if (idx >= 0) arr[idx] = record;
  else arr.unshift(record);

  // cap list to prevent runaway growth
  const capped = arr.slice(0, 300);
  const ok = lsWriteJSON(key, capped);
  if (!ok) {
    const err = new Error("Failed to write plans to localStorage");
    err.code = "LS_WRITE_FAILED";
    throw err;
  }
  return { ok: true, storage: "localStorage", id: record.id, record };
}

async function emitPlanEvent(type, payload) {
  const bus = await tryGetEventBus();
  if (!bus) return;

  // Try common shapes: bus.emit(), bus.publish()
  try {
    if (typeof bus.emit === "function") bus.emit(type, payload);
    else if (typeof bus.publish === "function") bus.publish(type, payload);
  } catch (_) {
    // ignore event failures
  }
}

/* ---------------------------------- Modal ---------------------------------- */
export default function SavePlanModal({
  open,
  onClose,

  draft,
  kind = "plan",
  domain = "",

  defaultTitle = "",
  defaultDescription = "",
  defaultTags = [],

  allowOverwrite = true,
  existingPlans,
  onSaved,
  onError,

  storageKey,
  maxTitleLen = 80,
  maxDescLen = 600,
}) {
  const overlayRef = useRef(null);
  const dialogRef = useRef(null);
  const titleInputRef = useRef(null);
  const lastActiveElRef = useRef(null);

  const existing = useMemo(
    () => coerceArrayPlans(existingPlans),
    [existingPlans]
  );

  const [mode, setMode] = useState("new"); // "new" | "update"
  const [selectedExistingId, setSelectedExistingId] = useState("");

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tagsText, setTagsText] = useState("");

  const [status, setStatus] = useState("draft"); // "draft" | "active" | "archived"
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  // Seed initial values when opening
  useEffect(() => {
    if (!open) return;

    lastActiveElRef.current = document.activeElement;

    const seededTitle = clampLen(
      defaultTitle || (isObject(draft) ? safeString(draft.title) : ""),
      maxTitleLen
    );
    const seededDesc = clampLen(
      defaultDescription ||
        (isObject(draft) ? safeString(draft.description) : ""),
      maxDescLen
    );
    const seededTags = normalizeTags(
      defaultTags?.length ? defaultTags : isObject(draft) ? draft.tags : []
    );

    setTitle(seededTitle || "");
    setDescription(seededDesc || "");
    setTagsText(seededTags.join(", "));
    setStatus(
      isObject(draft) && safeString(draft.status)
        ? safeString(draft.status)
        : "draft"
    );

    // Default mode
    if (allowOverwrite && existing.length > 0) {
      setMode("new");
      setSelectedExistingId("");
    } else {
      setMode("new");
      setSelectedExistingId("");
    }

    setSaving(false);
    setErrorMsg("");

    // Focus
    setTimeout(() => {
      titleInputRef.current?.focus?.();
      titleInputRef.current?.select?.();
    }, 0);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ESC + basic focus trap
  useEffect(() => {
    if (!open) return;

    function onKeyDown(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
        return;
      }

      if (e.key === "Tab") {
        // Basic focus trap within dialog
        const root = dialogRef.current;
        if (!root) return;
        const focusables = root.querySelectorAll(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (!focusables.length) return;

        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;

        if (e.shiftKey) {
          if (active === first || !root.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleClose() {
    if (saving) return; // prevent closing mid-save
    onClose?.();
    const last = lastActiveElRef.current;
    if (last && typeof last.focus === "function") {
      setTimeout(() => last.focus(), 0);
    }
  }

  function onOverlayMouseDown(e) {
    if (e.target === overlayRef.current) {
      handleClose();
    }
  }

  const canUpdate = allowOverwrite && existing.length > 0;

  const selectedExisting = useMemo(() => {
    if (!selectedExistingId) return null;
    return existing.find((p) => p.id === selectedExistingId) || null;
  }, [existing, selectedExistingId]);

  const computedPreview = useMemo(() => {
    const t = clampLen(title.trim(), maxTitleLen);
    const d = clampLen(description.trim(), maxDescLen);
    const tags = normalizeTags(tagsText);
    return { title: t, description: d, tags };
  }, [title, description, tagsText, maxTitleLen, maxDescLen]);

  function validate() {
    const t = computedPreview.title;
    if (!t) return "Please enter a plan name.";
    if (t.length > maxTitleLen)
      return `Plan name must be ≤ ${maxTitleLen} characters.`;
    if (computedPreview.description.length > maxDescLen)
      return `Description must be ≤ ${maxDescLen} characters.`;

    if (mode === "update") {
      if (!canUpdate) return "Updating an existing plan is not available.";
      if (!selectedExistingId) return "Choose an existing plan to update.";
    }
    return "";
  }

  async function handleSave() {
    const v = validate();
    if (v) {
      setErrorMsg(v);
      return;
    }

    setSaving(true);
    setErrorMsg("");

    const baseId =
      mode === "update" && selectedExistingId
        ? selectedExistingId
        : makeId("plan");

    // Record shape is intentionally "fat" but stable.
    // You can migrate/normalize later (PlanService, resolver, etc.).
    const record = {
      id: baseId,
      kind: safeString(kind || "plan"),
      domain: safeString(domain || ""),
      title: computedPreview.title,
      description: computedPreview.description,
      tags: computedPreview.tags,
      status: safeString(status || "draft"),

      payload: isObject(draft) ? draft : { value: draft },

      version: 1,
      updatedAtISO: nowISO(),
      createdAtISO:
        mode === "update" && selectedExisting
          ? safeString(selectedExisting.createdAtISO || nowISO())
          : nowISO(),
      meta: {
        source: SOURCE,
        saveMode: mode,
      },
    };

    try {
      // 1) Dexie-first if available
      let result;
      try {
        result = await saveToDexie({ record });
      } catch (dexErr) {
        // 2) fallback to localStorage
        result = await saveToLocalStorage({ record, storageKey });
        // attach note about dexie failure (non-fatal)
        result.note =
          dexErr?.message || "Dexie save failed; used localStorage.";
      }

      // Emit events (non-fatal)
      await emitPlanEvent("plan.saved", {
        id: record.id,
        kind: record.kind,
        domain: record.domain,
        storage: result.storage,
        atISO: record.updatedAtISO,
        mode,
      });

      onSaved?.(result);
      setSaving(false);
      handleClose();
    } catch (err) {
      const msg =
        err?.message ||
        "Failed to save the plan. Please try again or check storage.";
      setErrorMsg(msg);
      setSaving(false);
      onError?.(err);

      // Emit error event (non-fatal)
      await emitPlanEvent("plan.save_failed", {
        kind: safeString(kind || "plan"),
        domain: safeString(domain || ""),
        message: msg,
        code: err?.code || "",
      });
    }
  }

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      onMouseDown={onOverlayMouseDown}
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 9999,
      }}
    >
      <div
        ref={dialogRef}
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-label="Save plan"
        style={{
          width: "min(860px, 100%)",
          maxHeight: "min(85vh, 900px)",
          overflow: "auto",
          borderRadius: 14,
          background: "var(--panel, #111)",
          color: "var(--text, #f2f2f2)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 16px 10px",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.1 }}>
              Save Plan
            </div>
            <div style={{ opacity: 0.85, marginTop: 6, fontSize: 13 }}>
              Store a reusable plan blueprint for{" "}
              <span style={{ fontWeight: 700 }}>
                {safeString(kind || "plan")}
              </span>
              {domain ? (
                <>
                  {" "}
                  • <span style={{ opacity: 0.95 }}>{domain}</span>
                </>
              ) : null}
            </div>
          </div>

          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleClose}
            aria-label="Close"
            disabled={saving}
            style={{
              borderRadius: 10,
              padding: "8px 10px",
              border: "1px solid rgba(255,255,255,0.12)",
              background: "transparent",
              color: "inherit",
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 16 }}>
          {/* Mode: new vs update */}
          {canUpdate ? (
            <div
              className="card"
              style={{
                padding: 12,
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.08)",
                background: "rgba(255,255,255,0.03)",
                marginBottom: 14,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 10 }}>
                Save mode
              </div>

              <div
                style={{
                  display: "flex",
                  gap: 10,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  <input
                    type="radio"
                    name="saveMode"
                    value="new"
                    checked={mode === "new"}
                    onChange={() => {
                      setMode("new");
                      setSelectedExistingId("");
                      setErrorMsg("");
                    }}
                    disabled={saving}
                  />
                  <span>Create new plan</span>
                </label>

                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  <input
                    type="radio"
                    name="saveMode"
                    value="update"
                    checked={mode === "update"}
                    onChange={() => {
                      setMode("update");
                      // default to first plan if none selected
                      if (!selectedExistingId && existing[0]?.id) {
                        setSelectedExistingId(existing[0].id);
                      }
                      setErrorMsg("");
                    }}
                    disabled={saving}
                  />
                  <span>Update existing</span>
                </label>

                {mode === "update" ? (
                  <div style={{ flex: "1 1 280px", minWidth: 240 }}>
                    <select
                      value={selectedExistingId}
                      onChange={(e) => setSelectedExistingId(e.target.value)}
                      disabled={saving}
                      style={{
                        width: "100%",
                        padding: "10px 10px",
                        borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(0,0,0,0.25)",
                        color: "inherit",
                      }}
                      aria-label="Choose an existing plan"
                    >
                      {existing.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title}
                          {p.domain ? ` • ${p.domain}` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </div>

              {mode === "update" && selectedExisting ? (
                <div style={{ marginTop: 10, opacity: 0.85, fontSize: 12 }}>
                  Updating:{" "}
                  <span style={{ fontWeight: 800 }}>
                    {selectedExisting.title}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Fields */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr",
              gap: 12,
            }}
          >
            <div>
              <label
                htmlFor="plan-title"
                style={{ display: "block", fontSize: 12, fontWeight: 800 }}
              >
                Plan name
              </label>
              <input
                id="plan-title"
                ref={titleInputRef}
                type="text"
                value={title}
                onChange={(e) => {
                  setTitle(clampLen(e.target.value, maxTitleLen));
                  setErrorMsg("");
                }}
                disabled={saving}
                placeholder="e.g., Sabbath Week Meal Rhythm"
                style={{
                  width: "100%",
                  marginTop: 6,
                  padding: "11px 12px",
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(0,0,0,0.25)",
                  color: "inherit",
                  outline: "none",
                }}
              />
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                {computedPreview.title.length}/{maxTitleLen}
              </div>
            </div>

            <div>
              <label
                htmlFor="plan-desc"
                style={{ display: "block", fontSize: 12, fontWeight: 800 }}
              >
                Description (optional)
              </label>
              <textarea
                id="plan-desc"
                value={description}
                onChange={(e) => {
                  setDescription(clampLen(e.target.value, maxDescLen));
                  setErrorMsg("");
                }}
                disabled={saving}
                placeholder="What is this plan for? Any assumptions, notes, or constraints…"
                rows={4}
                style={{
                  width: "100%",
                  marginTop: 6,
                  padding: "11px 12px",
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(0,0,0,0.25)",
                  color: "inherit",
                  outline: "none",
                  resize: "vertical",
                }}
              />
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                {computedPreview.description.length}/{maxDescLen}
              </div>
            </div>

            <div>
              <label
                htmlFor="plan-tags"
                style={{ display: "block", fontSize: 12, fontWeight: 800 }}
              >
                Tags (comma-separated)
              </label>
              <input
                id="plan-tags"
                type="text"
                value={tagsText}
                onChange={(e) => {
                  setTagsText(e.target.value);
                  setErrorMsg("");
                }}
                disabled={saving}
                placeholder="e.g., sabbath, budget, batch-cooking, rotation"
                style={{
                  width: "100%",
                  marginTop: 6,
                  padding: "11px 12px",
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(0,0,0,0.25)",
                  color: "inherit",
                  outline: "none",
                }}
              />
              {computedPreview.tags.length ? (
                <div
                  style={{
                    marginTop: 8,
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                  }}
                >
                  {computedPreview.tags.map((t) => (
                    <span
                      key={t}
                      className="chip"
                      style={{
                        padding: "6px 10px",
                        borderRadius: 999,
                        border: "1px solid rgba(255,255,255,0.14)",
                        background: "rgba(255,255,255,0.04)",
                        fontSize: 12,
                        opacity: 0.95,
                      }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              ) : (
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
                  Tip: tags help SSA route plans to the right dashboards.
                </div>
              )}
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
              }}
            >
              <div>
                <label
                  htmlFor="plan-status"
                  style={{ display: "block", fontSize: 12, fontWeight: 800 }}
                >
                  Status
                </label>
                <select
                  id="plan-status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  disabled={saving}
                  style={{
                    width: "100%",
                    marginTop: 6,
                    padding: "10px 10px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.12)",
                    background: "rgba(0,0,0,0.25)",
                    color: "inherit",
                  }}
                >
                  <option value="draft">Draft</option>
                  <option value="active">Active</option>
                  <option value="archived">Archived</option>
                </select>
              </div>

              <div>
                <label
                  style={{ display: "block", fontSize: 12, fontWeight: 800 }}
                >
                  What will be saved
                </label>
                <div
                  className="card"
                  style={{
                    marginTop: 6,
                    padding: 10,
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "rgba(255,255,255,0.03)",
                    fontSize: 12,
                    opacity: 0.9,
                  }}
                >
                  <div>
                    <span style={{ opacity: 0.8 }}>Kind:</span>{" "}
                    <span style={{ fontWeight: 800 }}>
                      {safeString(kind || "plan")}
                    </span>
                  </div>
                  <div style={{ marginTop: 4 }}>
                    <span style={{ opacity: 0.8 }}>Domain:</span>{" "}
                    <span style={{ fontWeight: 800 }}>
                      {domain ? domain : "—"}
                    </span>
                  </div>
                  <div style={{ marginTop: 4 }}>
                    <span style={{ opacity: 0.8 }}>Draft keys:</span>{" "}
                    <span style={{ fontWeight: 800 }}>
                      {isObject(draft)
                        ? Object.keys(shallowPick(draft, Object.keys(draft)))
                            .length
                        : 1}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {errorMsg ? (
              <div
                role="alert"
                style={{
                  padding: 12,
                  borderRadius: 12,
                  border: "1px solid rgba(255,80,80,0.35)",
                  background: "rgba(255,80,80,0.12)",
                  color: "rgba(255,240,240,0.98)",
                  fontSize: 13,
                  fontWeight: 650,
                }}
              >
                {errorMsg}
              </div>
            ) : null}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: 16,
            borderTop: "1px solid rgba(255,255,255,0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {saving ? "Saving…" : "ESC to close"}
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleClose}
              disabled={saving}
              style={{
                borderRadius: 12,
                padding: "10px 12px",
                border: "1px solid rgba(255,255,255,0.12)",
                background: "transparent",
                color: "inherit",
                cursor: saving ? "not-allowed" : "pointer",
              }}
            >
              Cancel
            </button>

            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving}
              style={{
                borderRadius: 12,
                padding: "10px 14px",
                border: "1px solid rgba(255,255,255,0.12)",
                background: saving ? "rgba(255,255,255,0.12)" : "#5b7cff",
                color: saving ? "rgba(255,255,255,0.85)" : "#0b1020",
                fontWeight: 900,
                cursor: saving ? "not-allowed" : "pointer",
                minWidth: 140,
              }}
            >
              {saving
                ? "Saving…"
                : mode === "update"
                ? "Update Plan"
                : "Save Plan"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
