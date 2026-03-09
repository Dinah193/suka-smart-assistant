// File: src/components/scheduler/SaveTemplateModal.jsx
/**
 * SaveTemplateModal (SSA)
 * -----------------------------------------------------------------------------
 * Production-ready, browser-only modal for saving "templates" (schedule/session/
 * plan blueprints) into whatever backing store you choose.
 *
 * ✅ Works with ANY store/service:
 *   - You pass `existingTemplates` (array) and `onSave(template)` callback.
 *   - Modal handles: naming, slugging, overwrite selection, validation, tags,
 *     metadata, and a JSON payload editor/preview.
 *
 * ✅ SSA-friendly:
 *   - Emits optional UI toast events via eventBus if present.
 *   - Has a stable template contract.
 *   - Safe: no Node imports, no file system.
 *
 * Template Contract (what this modal outputs)
 * -----------------------------------------------------------------------------
 * {
 *   id?: string,              // optional (for overwrite)
 *   name: string,
 *   slug: string,             // url-safe stable key
 *   kind: "schedule"|"session"|"plan"|"other",
 *   category?: string,
 *   tags?: string[],
 *   description?: string,
 *   visibility?: "private"|"household"|"shared",
 *   payload: object,          // your serialized template content
 *   meta: {
 *     createdAtISO: string,
 *     updatedAtISO: string,
 *     source?: string,        // e.g., "cleaning", "mealplanning"
 *     version?: number,
 *     notes?: string,
 *   }
 * }
 *
 * Props
 * -----------------------------------------------------------------------------
 * open: boolean
 * onClose: () => void
 * onSave: (templateObj) => Promise<{ok:boolean, id?:string, error?:string}> | any
 *
 * optional:
 * title?: string
 * source?: string                 // domain/module: "cleaning" | "cooking" etc
 * kind?: "schedule"|"session"|"plan"|"other"
 * initialPayload?: object         // default payload to save
 * initialTemplate?: object        // prefill all fields (edit mode)
 * existingTemplates?: array       // list for overwrite / uniqueness checks
 * allowOverwrite?: boolean        // default true
 * defaultVisibility?: string      // "private" | "household" | "shared"
 * lockKind?: boolean             // default false
 * lockSource?: boolean           // default false
 * maxPayloadChars?: number        // default 250000
 * className?: string
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

let eventBus = null;
let Events = null;
try {
  // optional; safe if not present
  // eslint-disable-next-line import/no-unresolved
  const mod = require("@/services/events/eventBus");
  eventBus = mod?.eventBus || mod?.default || null;
  Events = mod?.Events || mod?.eventBus?.Events || null;
} catch {
  // noop (modal still works)
}

/* -------------------------------- helpers -------------------------------- */

function nowISO() {
  return new Date().toISOString();
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function safeString(v) {
  return String(v ?? "");
}

function slugify(input) {
  const s = safeString(input)
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "template";
}

function uniqSlug(base, existingSlugs) {
  if (!existingSlugs.has(base)) return base;
  let i = 2;
  while (existingSlugs.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

function parseTags(text) {
  return safeString(text)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 30);
}

function stringifyPretty(obj, maxChars = 250000) {
  try {
    const s = JSON.stringify(obj ?? {}, null, 2);
    if (s.length > maxChars) {
      return (
        s.slice(0, maxChars) +
        "\n/* … truncated preview (payload too large) … */\n"
      );
    }
    return s;
  } catch {
    return "{}";
  }
}

function safeJsonParse(text) {
  try {
    const v = JSON.parse(text);
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function emitToast(payload) {
  try {
    const type = Events?.UI_TOAST || eventBus?.Events?.UI_TOAST || "ui/toast";
    eventBus?.emit?.(type, payload, { source: "SaveTemplateModal" });
  } catch {
    // noop
  }
}

function useEscapeKey(open, onClose) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);
}

function clamp(n, min, max) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : min;
}

/* ----------------------------- modal component ---------------------------- */

export default function SaveTemplateModal({
  open = false,
  onClose,
  onSave,

  title = "Save Template",
  source = "scheduler",
  kind = "schedule",

  initialPayload = {},
  initialTemplate = null,

  existingTemplates = [],
  allowOverwrite = true,
  defaultVisibility = "private",

  lockKind = false,
  lockSource = false,

  maxPayloadChars = 250000,

  className = "",
}) {
  useEscapeKey(open, onClose);

  const existing = Array.isArray(existingTemplates) ? existingTemplates : [];
  const existingSlugs = useMemo(() => {
    const set = new Set();
    for (const t of existing) {
      if (t?.slug) set.add(String(t.slug));
    }
    return set;
  }, [existing]);

  const isEditMode = !!initialTemplate?.id;

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [kindState, setKindState] = useState(kind || "schedule");
  const [sourceState, setSourceState] = useState(source || "scheduler");
  const [category, setCategory] = useState("");
  const [visibility, setVisibility] = useState(defaultVisibility || "private");
  const [description, setDescription] = useState("");
  const [tagsText, setTagsText] = useState("");

  const [notes, setNotes] = useState("");

  const [overwriteId, setOverwriteId] = useState(""); // template id to overwrite
  const [payloadText, setPayloadText] = useState("{}");
  const [payloadValid, setPayloadValid] = useState(true);
  const [payloadError, setPayloadError] = useState("");
  const [payloadChars, setPayloadChars] = useState(0);

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const lastAutoSlugRef = useRef("");

  // Draft persistence (optional but helpful)
  const DRAFT_KEY = useMemo(() => {
    const base = `ssa.saveTemplateDraft.${sourceState}.${kindState}`;
    return base;
  }, [sourceState, kindState]);

  // hydrate form on open
  useEffect(() => {
    if (!open) return;

    const tpl = initialTemplate || null;
    const seedPayload =
      (tpl && isPlainObject(tpl.payload) ? tpl.payload : null) ??
      (isPlainObject(initialPayload) ? initialPayload : {});

    // Draft restore attempt first (unless editing an existing template)
    let draft = null;
    if (!tpl?.id) {
      try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (raw) {
          const parsed = safeJsonParse(raw);
          if (parsed.ok && isPlainObject(parsed.value)) draft = parsed.value;
        }
      } catch {
        // ignore
      }
    }

    const seed = draft?.seed || {};
    const seedMeta = draft?.meta || {};

    const seedName = seed.name ?? tpl?.name ?? "";
    const seedSlug = seed.slug ?? tpl?.slug ?? "";
    const seedKind = seed.kind ?? tpl?.kind ?? kindState ?? kind ?? "schedule";
    const seedSource =
      seed.source ?? tpl?.meta?.source ?? sourceState ?? source ?? "scheduler";

    setName(seedName);
    setSlug(seedSlug);
    setKindState(seedKind);
    setSourceState(seedSource);

    setCategory(seed.category ?? tpl?.category ?? "");
    setVisibility(
      seed.visibility ?? tpl?.visibility ?? defaultVisibility ?? "private"
    );
    setDescription(seed.description ?? tpl?.description ?? "");
    setTagsText((seed.tags ?? tpl?.tags ?? []).join(", "));

    setNotes(seedMeta.notes ?? tpl?.meta?.notes ?? "");

    setOverwriteId(tpl?.id ? String(tpl.id) : "");

    const txt =
      draft?.payloadText ?? stringifyPretty(seedPayload, maxPayloadChars);

    setPayloadText(txt);
    setPayloadChars(txt.length);

    // validate payload now
    const parsed = safeJsonParse(txt);
    setPayloadValid(parsed.ok);
    setPayloadError(parsed.ok ? "" : parsed.error);

    setErr("");
    setSaving(false);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // auto-slug from name (only if user hasn’t manually edited slug)
  useEffect(() => {
    if (!open) return;
    const proposed = slugify(name);
    if (!slug) {
      const uniq = isEditMode ? proposed : uniqSlug(proposed, existingSlugs);
      setSlug(uniq);
      lastAutoSlugRef.current = uniq;
      return;
    }
    // If slug equals last auto slug, keep syncing.
    if (slug === lastAutoSlugRef.current) {
      const uniq = isEditMode ? proposed : uniqSlug(proposed, existingSlugs);
      setSlug(uniq);
      lastAutoSlugRef.current = uniq;
    }
  }, [name, open, isEditMode, existingSlugs]); // eslint-disable-line react-hooks/exhaustive-deps

  // persist draft (when not editing an existing template)
  useEffect(() => {
    if (!open) return;
    if (initialTemplate?.id) return;

    const t = setTimeout(() => {
      try {
        const draft = {
          seed: {
            name,
            slug,
            kind: kindState,
            source: sourceState,
            category,
            visibility,
            description,
            tags: parseTags(tagsText),
          },
          meta: { notes },
          payloadText,
          savedAtISO: nowISO(),
        };
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      } catch {
        // ignore
      }
    }, 300);

    return () => clearTimeout(t);
  }, [
    open,
    initialTemplate?.id,
    DRAFT_KEY,
    name,
    slug,
    kindState,
    sourceState,
    category,
    visibility,
    description,
    tagsText,
    notes,
    payloadText,
  ]);

  // payload validation on change (light debounce)
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      setPayloadChars(payloadText.length);
      if (payloadText.length > maxPayloadChars) {
        setPayloadValid(false);
        setPayloadError(
          `Payload is too large (${payloadText.length} chars). Max is ${maxPayloadChars}.`
        );
        return;
      }
      const parsed = safeJsonParse(payloadText);
      setPayloadValid(parsed.ok);
      setPayloadError(parsed.ok ? "" : parsed.error);
    }, 200);
    return () => clearTimeout(t);
  }, [payloadText, open, maxPayloadChars]);

  const overwriteCandidate = useMemo(() => {
    if (!overwriteId) return null;
    return (
      existing.find((t) => String(t?.id || "") === String(overwriteId)) || null
    );
  }, [overwriteId, existing]);

  const canOverwrite = allowOverwrite && (isEditMode || !!overwriteCandidate);

  const computedWarnings = useMemo(() => {
    const warnings = [];
    if (!name.trim()) warnings.push("Name is required.");
    if (!slug.trim()) warnings.push("Slug is required.");
    if (!payloadValid) warnings.push("Payload JSON is invalid.");
    if (!kindState) warnings.push("Kind is required.");
    if (!sourceState) warnings.push("Source is required.");

    // slug uniqueness: if creating new and not overwriting, slug must be unique
    const isNew = !isEditMode && !overwriteCandidate;
    if (isNew && existingSlugs.has(slug.trim())) {
      warnings.push(
        "Slug already exists. Choose a different slug or overwrite an existing template."
      );
    }

    return warnings;
  }, [
    name,
    slug,
    payloadValid,
    kindState,
    sourceState,
    isEditMode,
    overwriteCandidate,
    existingSlugs,
  ]);

  const disableSave = saving || computedWarnings.length > 0 || !onSave;

  function clearDraft() {
    try {
      localStorage.removeItem(DRAFT_KEY);
      emitToast({
        variant: "info",
        title: "Draft cleared",
        message: "Template draft was cleared from this browser.",
      });
    } catch {}
  }

  async function handleSave() {
    setErr("");
    setSaving(true);

    try {
      const parsed = safeJsonParse(payloadText);
      if (!parsed.ok) {
        setSaving(false);
        setErr(`Payload JSON invalid: ${parsed.error}`);
        return;
      }

      const trimmedName = name.trim();
      const trimmedSlug = slugify(slug); // enforce slug safety even if user types
      const tags = parseTags(tagsText);

      const isOverwrite = !!overwriteCandidate || isEditMode;
      const targetId = isEditMode
        ? String(initialTemplate.id)
        : overwriteCandidate
        ? String(overwriteCandidate.id)
        : undefined;

      // If not overwriting and slug collides, force a unique slug (best effort)
      let finalSlug = trimmedSlug || slugify(trimmedName);
      if (!isOverwrite && existingSlugs.has(finalSlug)) {
        finalSlug = uniqSlug(finalSlug, existingSlugs);
      }

      const out = {
        ...(targetId ? { id: targetId } : {}),
        name: trimmedName,
        slug: finalSlug,
        kind: kindState || "schedule",
        category: category?.trim() || "",
        tags,
        description: description?.trim() || "",
        visibility: visibility || defaultVisibility || "private",
        payload: parsed.value ?? {},
        meta: {
          createdAtISO: isOverwrite
            ? safeString(
                initialTemplate?.meta?.createdAtISO ||
                  overwriteCandidate?.meta?.createdAtISO ||
                  nowISO()
              )
            : nowISO(),
          updatedAtISO: nowISO(),
          source: sourceState || source || "scheduler",
          version: clamp(
            Number(
              initialTemplate?.meta?.version ||
                overwriteCandidate?.meta?.version ||
                1
            ),
            1,
            999999
          ),
          notes: notes?.trim() || "",
        },
      };

      const res = await Promise.resolve(onSave(out));

      // Normalize response
      const ok = res?.ok !== false;
      const savedId = res?.id || out.id;

      if (!ok) {
        throw new Error(res?.error || "Save failed.");
      }

      // clear draft on success (only for new templates)
      if (!isEditMode) {
        try {
          localStorage.removeItem(DRAFT_KEY);
        } catch {}
      }

      emitToast({
        variant: "success",
        title: "Template saved",
        message: `${out.name}${savedId ? ` (${savedId})` : ""}`,
      });

      setSaving(false);
      onClose?.();
    } catch (e) {
      setSaving(false);
      const msg = String(e?.message || e);
      setErr(msg);
      emitToast({
        variant: "error",
        title: "Save failed",
        message: msg,
      });
    }
  }

  async function copyJson() {
    setErr("");
    try {
      await navigator.clipboard.writeText(payloadText);
      emitToast({
        variant: "success",
        title: "Copied",
        message: "Payload JSON copied to clipboard.",
      });
    } catch (e) {
      setErr(`Copy failed: ${String(e?.message || e)}`);
    }
  }

  function downloadJson() {
    setErr("");
    try {
      const blob = new Blob([payloadText], {
        type: "application/json;charset=utf-8",
      });
      const a = document.createElement("a");
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = `${slugify(slug || name || "template")}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 250);
    } catch (e) {
      setErr(`Download failed: ${String(e?.message || e)}`);
    }
  }

  function onOverlayClick(e) {
    if (e.target === e.currentTarget) onClose?.();
  }

  if (!open) return null;

  return (
    <div
      className={`ssaModalOverlay ${className}`}
      role="dialog"
      aria-modal="true"
      onMouseDown={onOverlayClick}
    >
      <div className="ssaModal">
        <div className="ssaModalHeader">
          <div>
            <div className="ssaTitle">{title}</div>
            <div className="ssaSub">
              Save a reusable template for schedules/sessions/plans
              (browser-only).
            </div>
          </div>
          <button
            className="ssaBtn ssaBtnGhost"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="ssaModalBody">
          <div className="ssaGrid">
            {/* Left: Fields */}
            <div className="ssaPanel">
              <div className="ssaPanelTitle">Template Details</div>

              <div className="ssaRow">
                <label className="ssaLabel">Name</label>
                <input
                  className="ssaInput"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Weekly Deep Clean (Housekeeper)"
                />
              </div>

              <div className="ssaRow">
                <label className="ssaLabel">Slug (stable key)</label>
                <input
                  className="ssaInput"
                  value={slug}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSlug(v);
                    lastAutoSlugRef.current = ""; // stop auto-sync once user edits
                  }}
                  placeholder="weekly-deep-clean-housekeeper"
                />
                <div className="ssaHint">
                  Used as a stable identifier. Auto-generated from Name unless
                  you override it.
                </div>
              </div>

              <div className="ssaRow2">
                <div>
                  <label className="ssaLabel">Kind</label>
                  <select
                    className="ssaSelect"
                    value={kindState}
                    onChange={(e) => setKindState(e.target.value)}
                    disabled={lockKind}
                  >
                    <option value="schedule">schedule</option>
                    <option value="session">session</option>
                    <option value="plan">plan</option>
                    <option value="other">other</option>
                  </select>
                </div>
                <div>
                  <label className="ssaLabel">Source (domain)</label>
                  <input
                    className="ssaInput"
                    value={sourceState}
                    onChange={(e) => setSourceState(e.target.value)}
                    disabled={lockSource}
                    placeholder="cleaning"
                  />
                </div>
              </div>

              <div className="ssaRow2">
                <div>
                  <label className="ssaLabel">Visibility</label>
                  <select
                    className="ssaSelect"
                    value={visibility}
                    onChange={(e) => setVisibility(e.target.value)}
                  >
                    <option value="private">private</option>
                    <option value="household">household</option>
                    <option value="shared">shared</option>
                  </select>
                </div>
                <div>
                  <label className="ssaLabel">Category</label>
                  <input
                    className="ssaInput"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder="e.g., Cleaning"
                  />
                </div>
              </div>

              <div className="ssaRow">
                <label className="ssaLabel">Tags (comma-separated)</label>
                <input
                  className="ssaInput"
                  value={tagsText}
                  onChange={(e) => setTagsText(e.target.value)}
                  placeholder="housekeeper, weekly, deep-clean, kitchen, bathroom"
                />
              </div>

              <div className="ssaRow">
                <label className="ssaLabel">Description</label>
                <textarea
                  className="ssaTextarea"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  placeholder="What is this template used for?"
                />
              </div>

              <div className="ssaRow">
                <label className="ssaLabel">Notes (internal)</label>
                <textarea
                  className="ssaTextarea"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Optional notes for your household / future edits."
                />
              </div>

              {allowOverwrite ? (
                <div className="ssaPanelSub">
                  <div className="ssaPanelTitle" style={{ marginBottom: 8 }}>
                    Overwrite (optional)
                  </div>

                  <div className="ssaRow">
                    <label className="ssaLabel">
                      Overwrite existing template
                    </label>
                    <select
                      className="ssaSelect"
                      value={overwriteId}
                      onChange={(e) => setOverwriteId(e.target.value)}
                      disabled={isEditMode}
                    >
                      <option value="">
                        {isEditMode
                          ? "Editing existing template (locked)"
                          : "— Do not overwrite —"}
                      </option>
                      {existing.map((t) => (
                        <option
                          key={String(t?.id || t?.slug || t?.name)}
                          value={String(t?.id || "")}
                        >
                          {safeString(t?.name || t?.slug || "Untitled")}{" "}
                          {t?.slug ? `(${t.slug})` : ""}
                        </option>
                      ))}
                    </select>

                    {overwriteCandidate ? (
                      <div className="ssaHint">
                        Will overwrite:{" "}
                        <b>
                          {overwriteCandidate?.name || overwriteCandidate?.slug}
                        </b>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {computedWarnings.length ? (
                <div className="ssaWarn">
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>
                    Fix before saving:
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {computedWarnings.map((w, idx) => (
                      <li key={idx}>{w}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {err ? <div className="ssaError">{err}</div> : null}

              <div className="ssaActions">
                <button
                  className="ssaBtn"
                  onClick={clearDraft}
                  disabled={saving || !!initialTemplate?.id}
                >
                  Clear Draft
                </button>

                <button
                  className="ssaBtn"
                  onClick={copyJson}
                  disabled={!payloadText || saving}
                >
                  Copy Payload JSON
                </button>

                <button
                  className="ssaBtn"
                  onClick={downloadJson}
                  disabled={!payloadText || saving}
                >
                  Download JSON
                </button>

                <button
                  className="ssaBtn ssaBtnPrimary"
                  onClick={handleSave}
                  disabled={disableSave}
                >
                  {saving
                    ? "Saving…"
                    : canOverwrite
                    ? "Save Template"
                    : "Save Template"}
                </button>
              </div>
            </div>

            {/* Right: Payload editor */}
            <div className="ssaPanel">
              <div className="ssaPanelTitle">Template Payload (JSON)</div>

              <div className="ssaPayloadMeta">
                <span className={`ssaPill ${payloadValid ? "ok" : "bad"}`}>
                  {payloadValid ? "Valid JSON" : "Invalid JSON"}
                </span>
                <span className="ssaMetaText">
                  {payloadChars.toLocaleString()} chars /{" "}
                  {maxPayloadChars.toLocaleString()} max
                </span>
              </div>

              {!payloadValid && payloadError ? (
                <div className="ssaError" style={{ marginTop: 8 }}>
                  {payloadError}
                </div>
              ) : null}

              <textarea
                className="ssaTextarea ssaTextareaCode"
                value={payloadText}
                onChange={(e) => setPayloadText(e.target.value)}
                spellCheck={false}
                rows={22}
              />

              <div className="ssaHint" style={{ marginTop: 10 }}>
                Tip: This payload is your “blueprint” data. It can be the output
                of generators like{" "}
                <code>CleaningPlanStore.generateSchedule()</code>, a session
                draft, or a fixed plan map.
              </div>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .ssaModalOverlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.55);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
          z-index: 9999;
        }
        .ssaModal {
          width: min(1200px, 100%);
          max-height: min(92vh, 980px);
          background: #0b0b0b;
          color: #f2f2f2;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 16px;
          overflow: hidden;
          box-shadow: 0 20px 60px rgba(0,0,0,0.45);
          display: flex;
          flex-direction: column;
        }
        .ssaModalHeader {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          padding: 14px 16px;
          border-bottom: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.03);
        }
        .ssaTitle { font-weight: 900; font-size: 16px; }
        .ssaSub { font-size: 12px; opacity: 0.75; margin-top: 2px; }
        .ssaModalBody { padding: 14px 16px; overflow: auto; }
        .ssaGrid {
          display: grid;
          grid-template-columns: 420px 1fr;
          gap: 12px;
        }
        @media (max-width: 980px) {
          .ssaGrid { grid-template-columns: 1fr; }
        }
        .ssaPanel {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 14px;
          padding: 12px;
        }
        .ssaPanelTitle {
          font-weight: 900;
          font-size: 13px;
          margin-bottom: 10px;
        }
        .ssaPanelSub {
          margin-top: 12px;
          padding-top: 10px;
          border-top: 1px solid rgba(255,255,255,0.10);
        }
        .ssaRow { margin-bottom: 10px; }
        .ssaRow2 {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          margin-bottom: 10px;
        }
        .ssaLabel {
          display: block;
          font-size: 12px;
          opacity: 0.85;
          margin-bottom: 6px;
        }
        .ssaInput, .ssaSelect, .ssaTextarea {
          width: 100%;
          background: rgba(255,255,255,0.06);
          color: #f2f2f2;
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 10px;
          padding: 8px 10px;
          font-size: 13px;
          outline: none;
        }
        .ssaTextarea { resize: vertical; }
        .ssaTextareaCode {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          font-size: 12px;
          line-height: 1.35;
          white-space: pre;
        }
        .ssaInput:focus, .ssaSelect:focus, .ssaTextarea:focus {
          border-color: rgba(255,255,255,0.28);
        }
        .ssaHint { font-size: 12px; opacity: 0.7; margin-top: 4px; }
        .ssaActions {
          display: grid;
          grid-template-columns: 1fr;
          gap: 8px;
          margin-top: 12px;
        }
        .ssaBtn {
          width: 100%;
          border-radius: 12px;
          padding: 9px 10px;
          font-weight: 900;
          font-size: 13px;
          border: 1px solid rgba(255,255,255,0.14);
          background: rgba(255,255,255,0.06);
          color: #f2f2f2;
          cursor: pointer;
        }
        .ssaBtn:hover { background: rgba(255,255,255,0.09); }
        .ssaBtn:disabled { opacity: 0.55; cursor: not-allowed; }
        .ssaBtnPrimary {
          background: rgba(255,255,255,0.16);
          border-color: rgba(255,255,255,0.22);
        }
        .ssaBtnGhost {
          width: auto;
          padding: 8px 10px;
          border-radius: 12px;
        }
        .ssaError {
          margin-top: 10px;
          padding: 10px;
          border-radius: 12px;
          background: rgba(255, 80, 80, 0.15);
          border: 1px solid rgba(255, 80, 80, 0.25);
          color: #ffd7d7;
          font-size: 12px;
          white-space: pre-wrap;
        }
        .ssaWarn {
          margin-top: 10px;
          padding: 10px;
          border-radius: 12px;
          background: rgba(255, 200, 80, 0.12);
          border: 1px solid rgba(255, 200, 80, 0.22);
          color: rgba(255, 240, 210, 0.95);
          font-size: 12px;
          white-space: pre-wrap;
        }
        .ssaPayloadMeta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-top: -2px;
          margin-bottom: 8px;
        }
        .ssaPill {
          font-size: 11px;
          font-weight: 900;
          padding: 4px 10px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.18);
          background: rgba(255,255,255,0.05);
        }
        .ssaPill.ok {
          border-color: rgba(120, 255, 170, 0.35);
          background: rgba(120, 255, 170, 0.10);
        }
        .ssaPill.bad {
          border-color: rgba(255, 120, 120, 0.35);
          background: rgba(255, 120, 120, 0.10);
        }
        .ssaMetaText { font-size: 12px; opacity: 0.75; }
        code {
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.12);
          padding: 2px 6px;
          border-radius: 8px;
        }
      `}</style>
    </div>
  );
}
