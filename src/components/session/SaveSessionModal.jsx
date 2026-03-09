// File: src/components/session/SaveSessionModal.jsx
// SSA — SaveSessionModal (production-ready)
//
// Purpose
// - Provide a robust, reusable modal for saving/renaming/exporting a Session.
// - Designed to work in SSA’s "household steward" architecture: sessions are durable artifacts
//   that feed planning, KPIs, and the “web of meaning” across domains.
//
// Key behaviors
// - Safe defaults (never crashes if dependencies are missing).
// - Supports:
//   - Save as Draft / Save Final
//   - Rename
//   - Optional tags
//   - Optional notes
//   - Optional export as JSON
// - Integrates with SSA eventBus (if available) and automation runtime (if available).
//
// Assumptions / Integration points (soft)
// - If you have a modal system already: this component can be used standalone.
// - If you have db/session services: pass them as props.
// - If you have eventBus: pass it or it will attempt to import from "@/services/events/eventBus".
// - If you have toast system: pass toast functions or it will degrade gracefully.
//
// Usage
// <SaveSessionModal
//   open={open}
//   onOpenChange={setOpen}
//   session={session}
//   onSave={async (payload) => { ... }}   // REQUIRED for persistence
//   onDeleteDraft={async (id) => {...}}   // optional
//   allowExport
// />
//
// Return payload shape (onSave):
// {
//   mode: "draft"|"final",
//   sessionId,
//   title,
//   tags: [],
//   notes,
//   meta: { ... },
//   session: { ... } // original session (or normalized copy)
// }

import React, { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import ScrollArea from "@/components/ui/scroll-area";

// If you have these, great; if not, this file still works because we only use them if present.
let fallbackEventBus = null;
try {
  // eslint-disable-next-line import/no-unresolved
  // @ts-ignore
  fallbackEventBus =
    (await import("@/services/events/eventBus")).eventBus || null;
} catch {
  fallbackEventBus = null;
}

/* ------------------------------ tiny utils ------------------------------ */

function cn(...parts) {
  return parts.filter(Boolean).join(" ");
}

function safeStr(v, fallback = "") {
  return typeof v === "string" ? v : v == null ? fallback : String(v);
}

function asArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function uid(prefix = "sess") {
  return `${prefix}_${Math.random()
    .toString(16)
    .slice(2)}_${Date.now().toString(16)}`;
}

function pickTitle(session) {
  return (
    session?.title ||
    session?.name ||
    session?.label ||
    session?.meta?.title ||
    session?.meta?.name ||
    ""
  );
}

function normalizeTags(tags) {
  const out = [];
  const seen = new Set();
  for (const t of asArray(tags)) {
    const v = safeStr(t, "").trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function downloadTextFile(filename, text) {
  try {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    // ignore
  }
}

/* ------------------------------ lightweight Modal shell ------------------------------ */
/**
 * We avoid hard dependency on any Dialog library.
 * If you already have SSA Modal, you can replace these internals later.
 */
function ModalShell({
  open,
  onOpenChange,
  title,
  children,
  footer,
  maxWidth = 720,
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={title || "Modal"}
    >
      {/* overlay */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => onOpenChange?.(false)}
      />
      {/* panel */}
      <div
        className="relative w-[92vw] max-h-[86vh] rounded-xl bg-white text-slate-900 shadow-2xl overflow-hidden"
        style={{ maxWidth }}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200">
          <div className="min-w-0">
            <div className="text-base font-semibold truncate">
              {title || "Save session"}
            </div>
          </div>
          <button
            className="inline-flex items-center justify-center rounded-md px-2 py-1 text-slate-600 hover:bg-slate-100"
            onClick={() => onOpenChange?.(false)}
            aria-label="Close"
            type="button"
          >
            ✕
          </button>
        </div>

        <div className="px-4 py-4">{children}</div>

        {footer ? (
          <div className="px-4 py-3 border-t border-slate-200 bg-slate-50">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------ component ------------------------------ */

export default function SaveSessionModal({
  open,
  onOpenChange,
  session,

  // Persistence hook (REQUIRED to actually save)
  onSave,

  // Optional helpers
  onDeleteDraft,
  onDuplicate,
  onValidate,

  // Feature toggles
  allowDraft = true,
  allowFinal = true,
  allowRename = true,
  allowTags = true,
  allowNotes = true,
  allowExport = true,

  // UI props
  initialTab = "save", // "save" | "details" | "export"
  confirmCloseIfDirty = true,
  maxWidth = 760,

  // Integration points
  eventBus, // optional; else tries "@/services/events/eventBus"
  toast, // optional { success(msg), error(msg), info(msg) }
}) {
  const bus = eventBus || fallbackEventBus;

  const sessionId = useMemo(
    () => session?.id || session?.sessionId || session?.uuid || null,
    [session]
  );
  const defaultTitle = useMemo(() => pickTitle(session), [session]);
  const defaultTags = useMemo(
    () => normalizeTags(session?.tags || session?.meta?.tags || []),
    [session]
  );
  const defaultNotes = useMemo(
    () => safeStr(session?.notes ?? session?.meta?.notes ?? "", ""),
    [session]
  );

  const [tab, setTab] = useState(initialTab);

  const [title, setTitle] = useState(defaultTitle);
  const [tags, setTags] = useState(defaultTags);
  const [notes, setNotes] = useState(defaultNotes);

  const [tagInput, setTagInput] = useState("");
  const [isDraft, setIsDraft] = useState(true);
  const [includeMeta, setIncludeMeta] = useState(true);
  const [includeSteps, setIncludeSteps] = useState(true);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const initialSnapshotRef = useRef({
    title: defaultTitle,
    tags: defaultTags,
    notes: defaultNotes,
    isDraft: true,
    includeMeta: true,
    includeSteps: true,
  });

  const dirty = useMemo(() => {
    const s = initialSnapshotRef.current;
    return (
      safeStr(title) !== safeStr(s.title) ||
      safeStr(notes) !== safeStr(s.notes) ||
      normalizeTags(tags).join("|") !== normalizeTags(s.tags).join("|") ||
      isDraft !== !!s.isDraft ||
      includeMeta !== !!s.includeMeta ||
      includeSteps !== !!s.includeSteps
    );
  }, [title, tags, notes, isDraft, includeMeta, includeSteps]);

  // Reset when opened or when session changes
  useEffect(() => {
    if (!open) return;
    const newTitle = pickTitle(session);
    const newTags = normalizeTags(session?.tags || session?.meta?.tags || []);
    const newNotes = safeStr(session?.notes ?? session?.meta?.notes ?? "", "");

    setTitle(newTitle);
    setTags(newTags);
    setNotes(newNotes);
    setTagInput("");
    setIsDraft(true);
    setIncludeMeta(true);
    setIncludeSteps(true);
    setError("");
    setSaving(false);

    initialSnapshotRef.current = {
      title: newTitle,
      tags: newTags,
      notes: newNotes,
      isDraft: true,
      includeMeta: true,
      includeSteps: true,
    };
  }, [open, session]);

  // Close guard
  const requestClose = () => {
    if (confirmCloseIfDirty && dirty) {
      const ok = window.confirm("You have unsaved changes. Close anyway?");
      if (!ok) return;
    }
    onOpenChange?.(false);
  };

  const canSave = useMemo(() => {
    if (saving) return false;
    if (typeof onSave !== "function") return false;

    if (!session) return false;
    if (!allowDraft && !allowFinal) return false;

    const t = safeStr(title).trim();
    if (!t) return false;

    return true;
  }, [saving, onSave, session, allowDraft, allowFinal, title]);

  const handleAddTag = () => {
    const v = safeStr(tagInput).trim();
    if (!v) return;
    setTags((prev) => normalizeTags([...prev, v]));
    setTagInput("");
  };

  const handleRemoveTag = (t) => {
    const key = safeStr(t).toLowerCase();
    setTags((prev) => prev.filter((x) => safeStr(x).toLowerCase() !== key));
  };

  const buildExportObject = () => {
    const base = structuredCloneSafe(session || {});
    const out = {};

    // Always include core identifiers
    out.id = base.id || base.sessionId || base.uuid || uid("session");
    out.domain = base.domain || base.meta?.domain || base.type || "generic";
    out.kind = base.kind || base.meta?.kind || base.intent || "generic";

    // Include title/tags/notes overrides
    out.title = safeStr(title).trim() || pickTitle(base) || "Untitled Session";
    out.tags = normalizeTags(tags);
    out.notes = safeStr(notes, "");

    if (includeMeta) {
      out.meta = {
        ...(base.meta || {}),
        title: out.title,
        tags: out.tags,
        notes: out.notes,
        exportedAt: new Date().toISOString(),
      };
    }

    if (includeSteps) {
      // common shapes: steps / plan.steps / session.steps
      out.steps =
        base.steps ||
        base.plan?.steps ||
        base.session?.steps ||
        base.taskSteps ||
        [];
    }

    // Copy some common stable fields if present
    if (base.createdAt) out.createdAt = base.createdAt;
    if (base.startedAt) out.startedAt = base.startedAt;
    if (base.completedAt) out.completedAt = base.completedAt;
    if (base.durationMin != null) out.durationMin = base.durationMin;

    return out;
  };

  const validate = async (payload) => {
    if (typeof onValidate !== "function") return { ok: true };
    try {
      const res = await onValidate(payload);
      if (res && res.ok === false) return res;
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e?.message || String(e) };
    }
  };

  const doSave = async (mode) => {
    setError("");
    if (!canSave) return;

    const trimmedTitle = safeStr(title).trim();
    const payload = {
      mode,
      sessionId:
        sessionId || session?.id || session?.sessionId || uid("session"),
      title: trimmedTitle,
      tags: normalizeTags(tags),
      notes: safeStr(notes, ""),
      meta: {
        updatedAt: new Date().toISOString(),
        source: "SaveSessionModal",
      },
      session: session || {},
    };

    const validation = await validate(payload);
    if (!validation?.ok) {
      const msg = validation?.message || "Validation failed.";
      setError(msg);
      toast?.error?.(msg);
      return;
    }

    setSaving(true);

    try {
      // Emit "save requested" (non-fatal if bus missing)
      try {
        bus?.emit?.("session.save.requested", {
          sessionId: payload.sessionId,
          mode,
          domain: session?.domain || session?.meta?.domain,
          kind: session?.kind || session?.meta?.kind,
        });
      } catch {}

      await onSave(payload);

      try {
        bus?.emit?.("session.save.completed", {
          sessionId: payload.sessionId,
          mode,
        });
      } catch {}

      toast?.success?.(
        mode === "final" ? "Session saved (final)." : "Session saved (draft)."
      );

      // Snapshot becomes new “clean”
      initialSnapshotRef.current = {
        title: trimmedTitle,
        tags: normalizeTags(tags),
        notes: safeStr(notes, ""),
        isDraft: mode === "draft",
        includeMeta,
        includeSteps,
      };

      setIsDraft(mode === "draft");
      onOpenChange?.(false);
    } catch (e) {
      const msg = e?.message || String(e);
      setError(msg);
      toast?.error?.(`Save failed: ${msg}`);
      try {
        bus?.emit?.("session.save.failed", {
          sessionId: payload.sessionId,
          mode,
          error: msg,
        });
      } catch {}
    } finally {
      setSaving(false);
    }
  };

  const doDeleteDraft = async () => {
    if (typeof onDeleteDraft !== "function") return;
    const ok = window.confirm("Delete this draft? This cannot be undone.");
    if (!ok) return;

    setSaving(true);
    setError("");

    try {
      await onDeleteDraft(sessionId);
      toast?.success?.("Draft deleted.");
      try {
        bus?.emit?.("session.draft.deleted", { sessionId });
      } catch {}
      onOpenChange?.(false);
    } catch (e) {
      const msg = e?.message || String(e);
      setError(msg);
      toast?.error?.(`Delete failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const doDuplicate = async () => {
    if (typeof onDuplicate !== "function") {
      // fallback: export JSON to allow manual duplication
      const obj = buildExportObject();
      const filename = `${safeStr(obj.title || "session")
        .trim()
        .replace(/\s+/g, "_")
        .slice(0, 48)}.json`;
      downloadTextFile(filename, JSON.stringify(obj, null, 2));
      toast?.info?.("Exported JSON for duplication.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const newId = await onDuplicate({
        session,
        title: safeStr(title).trim() || defaultTitle || "Session Copy",
        tags: normalizeTags(tags),
        notes: safeStr(notes, ""),
      });
      toast?.success?.("Session duplicated.");
      try {
        bus?.emit?.("session.duplicated", {
          from: sessionId,
          to: newId || null,
        });
      } catch {}
    } catch (e) {
      const msg = e?.message || String(e);
      setError(msg);
      toast?.error?.(`Duplicate failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const doExport = () => {
    const obj = buildExportObject();
    const filename = `${safeStr(obj.title || "session")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 48)}.json`;
    downloadTextFile(filename, JSON.stringify(obj, null, 2));
    toast?.success?.("Exported session JSON.");
    try {
      bus?.emit?.("session.exported", { sessionId: obj.id, filename });
    } catch {}
  };

  const footer = (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2">
        {error ? (
          <div className="text-sm text-red-600" role="alert">
            {error}
          </div>
        ) : dirty ? (
          <div className="text-sm text-slate-600">Unsaved changes</div>
        ) : (
          <div className="text-sm text-slate-500">Ready</div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {allowRename ? (
          <Button
            variant="outline"
            onClick={() => setTab("details")}
            disabled={saving}
            title="Edit details"
          >
            Details
          </Button>
        ) : null}

        {allowExport ? (
          <Button
            variant="outline"
            onClick={() => {
              setTab("export");
              if (!allowExport) return;
              doExport();
            }}
            disabled={saving || !allowExport}
            title="Export session JSON"
          >
            Export
          </Button>
        ) : null}

        {typeof onDeleteDraft === "function" ? (
          <Button
            variant="outline"
            onClick={doDeleteDraft}
            disabled={saving || !sessionId}
            title="Delete draft"
          >
            Delete Draft
          </Button>
        ) : null}

        <Button variant="outline" onClick={requestClose} disabled={saving}>
          Cancel
        </Button>

        {allowDraft ? (
          <Button
            onClick={() => doSave("draft")}
            disabled={saving || !canSave}
            title="Save as draft"
          >
            {saving ? "Saving..." : "Save Draft"}
          </Button>
        ) : null}

        {allowFinal ? (
          <Button
            onClick={() => doSave("final")}
            disabled={saving || !canSave}
            title="Save as final"
          >
            {saving ? "Saving..." : "Save Final"}
          </Button>
        ) : null}
      </div>
    </div>
  );

  const headerBadges = (
    <div className="flex flex-wrap items-center gap-2">
      {session?.domain ? (
        <Badge variant="secondary">{safeStr(session.domain)}</Badge>
      ) : null}
      {session?.kind ? (
        <Badge variant="secondary">{safeStr(session.kind)}</Badge>
      ) : null}
      {sessionId ? (
        <Badge variant="outline">{safeStr(sessionId).slice(0, 12)}</Badge>
      ) : null}
    </div>
  );

  return (
    <ModalShell
      open={!!open}
      onOpenChange={(v) => (v ? onOpenChange?.(true) : requestClose())}
      title="Save Session"
      maxWidth={maxWidth}
      footer={footer}
    >
      <div className="flex flex-col gap-3">
        {headerBadges}

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="save">Save</TabsTrigger>
            <TabsTrigger
              value="details"
              disabled={!allowRename && !allowTags && !allowNotes}
            >
              Details
            </TabsTrigger>
            <TabsTrigger value="export" disabled={!allowExport}>
              Export
            </TabsTrigger>
          </TabsList>

          {/* SAVE */}
          <TabsContent value="save">
            <div className="grid gap-3">
              <div className="grid gap-1">
                <label className="text-sm font-medium text-slate-700">
                  Session Title
                </label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g., Sunday Batch Cook — Chicken + Rice"
                  disabled={!allowRename || saving}
                />
                <div className="text-xs text-slate-500">
                  Title is required to save. Keep it human-readable for the
                  household archive.
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Checkbox
                  checked={isDraft}
                  onCheckedChange={(v) => setIsDraft(!!v)}
                  disabled={saving || (!allowDraft && allowFinal)}
                />
                <div className="text-sm text-slate-700">
                  Save as <span className="font-medium">Draft</span>
                  <span className="text-slate-500">
                    {" "}
                    (you can finalize later)
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  onClick={doDuplicate}
                  disabled={saving || !session}
                  title="Duplicate session"
                >
                  Duplicate
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setTab("details")}
                  disabled={saving}
                  title="Edit tags and notes"
                >
                  Edit Details
                </Button>
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-sm font-medium text-slate-800">
                  What gets saved
                </div>
                <div className="text-sm text-slate-600 mt-1">
                  The session snapshot (steps, inputs, and outcomes) is saved as
                  an SSA artifact so it can drive KPIs, planning, and
                  cross-domain suggestions.
                </div>
              </div>
            </div>
          </TabsContent>

          {/* DETAILS */}
          <TabsContent value="details">
            <div className="grid gap-4">
              {allowTags ? (
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-slate-700">
                    Tags
                  </label>

                  <div className="flex gap-2">
                    <Input
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      placeholder="Add a tag (press Enter)"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAddTag();
                        }
                      }}
                      disabled={saving}
                    />
                    <Button
                      variant="outline"
                      onClick={handleAddTag}
                      disabled={saving}
                    >
                      Add
                    </Button>
                  </div>

                  {tags.length ? (
                    <div className="flex flex-wrap gap-2">
                      {tags.map((t) => (
                        <button
                          key={t}
                          type="button"
                          className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                          onClick={() => handleRemoveTag(t)}
                          title="Remove tag"
                          disabled={saving}
                        >
                          <span>{t}</span>
                          <span className="text-slate-400">✕</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500">No tags yet.</div>
                  )}
                </div>
              ) : null}

              {allowNotes ? (
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-slate-700">
                    Notes
                  </label>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Add notes (what went well, what to improve, substitutions, etc.)"
                    disabled={saving}
                    rows={5}
                  />
                </div>
              ) : null}

              <div className="rounded-lg border border-slate-200 p-3">
                <div className="text-sm font-medium text-slate-800">
                  Session preview
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  This is a lightweight snapshot preview for confidence before
                  saving.
                </div>

                <div className="mt-3">
                  <ScrollArea className="h-44 rounded-md border border-slate-200 bg-white">
                    <div className="p-3 text-xs text-slate-700 space-y-2">
                      <div>
                        <span className="font-medium">Title:</span>{" "}
                        {safeStr(title).trim() || "—"}
                      </div>
                      <div>
                        <span className="font-medium">Mode:</span>{" "}
                        {isDraft ? "Draft" : "Final"}
                      </div>
                      <div>
                        <span className="font-medium">Tags:</span>{" "}
                        {tags.length ? tags.join(", ") : "—"}
                      </div>
                      <div>
                        <span className="font-medium">Notes:</span>{" "}
                        {safeStr(notes).trim() ? safeStr(notes).trim() : "—"}
                      </div>
                      <div className="pt-2 border-t border-slate-100">
                        <span className="font-medium">Session:</span>{" "}
                        {session ? "Loaded" : "—"}
                      </div>
                      <div>
                        <span className="font-medium">Steps:</span>{" "}
                        {
                          asArray(
                            session?.steps ||
                              session?.plan?.steps ||
                              session?.taskSteps
                          ).length
                        }
                      </div>
                    </div>
                  </ScrollArea>
                </div>
              </div>
            </div>
          </TabsContent>

          {/* EXPORT */}
          <TabsContent value="export">
            <div className="grid gap-3">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-sm font-medium text-slate-800">
                  Export session
                </div>
                <div className="text-sm text-slate-600 mt-1">
                  Exports a JSON snapshot so you can archive, share, or import
                  into other SSA contexts.
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Checkbox
                  checked={includeMeta}
                  onCheckedChange={(v) => setIncludeMeta(!!v)}
                />
                <div className="text-sm text-slate-700">Include meta block</div>
              </div>

              <div className="flex items-center gap-3">
                <Checkbox
                  checked={includeSteps}
                  onCheckedChange={(v) => setIncludeSteps(!!v)}
                />
                <div className="text-sm text-slate-700">Include steps</div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  onClick={doExport}
                  disabled={!allowExport || !session}
                >
                  Download JSON
                </Button>
                <Button
                  variant="outline"
                  onClick={doDuplicate}
                  disabled={!session}
                >
                  Duplicate (or export)
                </Button>
              </div>

              <div className="rounded-lg border border-slate-200 p-3">
                <div className="text-xs text-slate-500 mb-2">
                  Export preview
                </div>
                <ScrollArea className="h-48 rounded-md border border-slate-200 bg-white">
                  <pre className="p-3 text-[11px] leading-relaxed text-slate-800 whitespace-pre-wrap">
                    {JSON.stringify(buildExportObject(), null, 2)}
                  </pre>
                </ScrollArea>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </ModalShell>
  );
}

/* ------------------------------ helpers ------------------------------ */

function structuredCloneSafe(obj) {
  try {
    return structuredClone(obj);
  } catch {
    return JSON.parse(JSON.stringify(obj));
  }
}
