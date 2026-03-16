// File: C:\Users\larho\suka-smart-assistant\src\components\cooking\CookingSessionReviewModal.jsx
/**
 * CookingSessionReviewModal
 * -----------------------------------------------------------------------------
 * SSA — Cooking Session Review Modal (browser-safe, production-ready)
 *
 * Purpose
 *  - Let the user review a completed (or in-progress) cooking session:
 *      • Summary (duration, servings, recipe titles)
 *      • Steps timeline (with completion + notes)
 *      • Ingredient / inventory impacts (best-effort)
 *      • Notes + outcomes + leftovers
 *      • Export (JSON) + Copy summary
 *
 * Design constraints
 *  - Works even if some services/stores are missing (soft integrations)
 *  - Does not import Node APIs
 *  - Minimizes assumptions about your schema (handles unknown shapes)
 *
 * Props
 *  - open: boolean
 *  - onClose: () => void
 *  - sessionId?: string
 *  - session?: object (if you already have it; sessionId optional)
 *  - loadOnOpen?: boolean (default true if sessionId provided)
 *  - title?: string (override modal title)
 *
 * Optional callbacks
 *  - onExport?: (payload) => void
 *  - onCommitReview?: (reviewPatch) => Promise<void> | void
 *
 * Notes
 *  - This modal is intentionally "schema tolerant".
 *  - It tries to read sessionStore (if present) but falls back to passed session.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

/* -----------------------------------------------------------------------------
 * Optional deps (soft)
 * -------------------------------------------------------------------------- */

let sessionStore = null;
try {
  const mod = await import("@/services/session/sessionStore.js");
  sessionStore = mod?.default ?? mod ?? null;
} catch {
  sessionStore = null;
}

let cookingSelectors = null;
try {
  const mod = await import("@/services/selectors/cookingSelectors.js");
  cookingSelectors = mod?.default ?? mod ?? null;
} catch {
  cookingSelectors = null;
}

let eventBus = null;
try {
  const mod = await import("@/services/events/eventBus");
  eventBus = mod?.default ?? mod ?? null;
} catch {
  eventBus = null;
}

let DashboardLog = null;
try {
  const mod = await import("@/services/dashboard/DashboardLog.js");
  DashboardLog = mod?.default ?? mod ?? null;
} catch {
  DashboardLog = null;
}

let logger = null;
try {
  const mod = await import("@/utils/logger.js");
  logger = mod?.default ?? null;
} catch {
  logger = null;
}

/* -----------------------------------------------------------------------------
 * Utilities (schema-tolerant)
 * -------------------------------------------------------------------------- */

const SOURCE = "components.cooking.CookingSessionReviewModal";

function safeObject(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}
function safeArray(x) {
  return Array.isArray(x) ? x : [];
}
function asStr(x, fallback = "") {
  if (x == null) return fallback;
  return String(x);
}
function toMs(d) {
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(t) ? t : 0;
}
function fmtDateTime(x) {
  try {
    const d = x instanceof Date ? x : new Date(x);
    if (!Number.isFinite(d.getTime())) return "—";
    return d.toLocaleString();
  } catch {
    return "—";
  }
}
function fmtMins(mins) {
  const m = Number(mins);
  if (!Number.isFinite(m) || m <= 0) return "—";
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return `${h}h${r ? ` ${r}m` : ""}`;
}
function durationFrom(session) {
  const s = safeObject(session);
  const start = s.startedAt || s.startTime || s.startedISO || s.started;
  const end = s.endedAt || s.endTime || s.endedISO || s.ended;
  const a = toMs(start);
  const b = toMs(end);
  if (!a || !b || b <= a) return null;
  return (b - a) / 60000;
}
function downloadJson(filename, obj) {
  try {
    const blob = new Blob([JSON.stringify(obj, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 250);
    return true;
  } catch {
    return false;
  }
}
function copyToClipboard(text) {
  try {
    if (navigator?.clipboard?.writeText)
      return navigator.clipboard.writeText(text);
  } catch {
    // ignore
  }
  // fallback
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      ok ? resolve(true) : reject(new Error("copy_failed"));
    } catch (e) {
      reject(e);
    }
  });
}
function emit(name, payload) {
  try {
    eventBus?.emit?.(name, payload);
  } catch {
    // ignore
  }
}
async function dashLog(message, meta) {
  try {
    if (!DashboardLog) return;
    if (typeof DashboardLog.info === "function") {
      await DashboardLog.info(message, null, {
        source: SOURCE,
        ...(meta || {}),
      });
    } else if (typeof DashboardLog.log === "function") {
      await DashboardLog.log({
        category: "Cooking",
        icon: "🍳",
        message,
        time: new Date(),
        meta: { source: SOURCE, ...(meta || {}) },
      });
    }
  } catch {
    // ignore
  }
}

/* -----------------------------------------------------------------------------
 * Modal shell (lightweight)
 * -------------------------------------------------------------------------- */

function ModalShell({ open, onClose, title, children, footer }) {
  const overlayRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="ssa-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === overlayRef.current) onClose?.();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 9999,
      }}
    >
      <div
        className="ssa-modal card"
        style={{
          width: "min(980px, 100%)",
          maxHeight: "min(86vh, 900px)",
          overflow: "hidden",
          borderRadius: 14,
          background: "var(--card-bg, #fff)",
          border: "1px solid rgba(0,0,0,0.08)",
          boxShadow: "0 18px 60px rgba(0,0,0,0.35)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          className="ssa-modal-header"
          style={{
            padding: "14px 16px",
            borderBottom: "1px solid rgba(0,0,0,0.08)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            justifyContent: "space-between",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 16,
                fontWeight: 700,
                lineHeight: 1.2,
                marginBottom: 2,
              }}
            >
              {title || "Cooking Session Review"}
            </div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Review outcomes, steps, and impacts.
            </div>
          </div>
          <button
            className="btn"
            onClick={onClose}
            style={{
              borderRadius: 10,
              padding: "8px 10px",
              border: "1px solid rgba(0,0,0,0.12)",
              background: "rgba(0,0,0,0.03)",
              cursor: "pointer",
            }}
            aria-label="Close"
            title="Close"
          >
            ✕
          </button>
        </div>

        <div
          className="ssa-modal-body"
          style={{ padding: 16, overflow: "auto", flex: 1 }}
        >
          {children}
        </div>

        {footer ? (
          <div
            className="ssa-modal-footer"
            style={{
              padding: 16,
              borderTop: "1px solid rgba(0,0,0,0.08)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Main component
 * -------------------------------------------------------------------------- */

export default function CookingSessionReviewModal({
  open,
  onClose,
  sessionId,
  session: sessionProp,
  loadOnOpen = true,
  title,
  onExport,
  onCommitReview,
}) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [session, setSession] = useState(sessionProp || null);

  // Review fields (light, non-destructive)
  const [reviewNotes, setReviewNotes] = useState("");
  const [leftovers, setLeftovers] = useState("");
  const [rating, setRating] = useState(0);
  const [tags, setTags] = useState("");

  const [activeTab, setActiveTab] = useState("summary"); // summary|steps|ingredients|inventory|notes
  const loadedForIdRef = useRef(null);

  // Keep local session in sync with prop changes
  useEffect(() => {
    if (sessionProp) setSession(sessionProp);
  }, [sessionProp]);

  // Load session by id when opening
  useEffect(() => {
    if (!open) return;
    if (!loadOnOpen) return;
    if (!sessionId) return;
    if (loadedForIdRef.current === sessionId) return;

    let alive = true;

    (async () => {
      setLoading(true);
      setErr("");
      try {
        let s = null;

        // Try sessionStore
        if (sessionStore?.getById) {
          s = await sessionStore.getById(sessionId);
        } else if (sessionStore?.getSession) {
          s = await sessionStore.getSession(sessionId);
        } else if (sessionStore?.read) {
          s = await sessionStore.read(sessionId);
        }

        // Fallback: selectors if they provide a loader
        if (!s && cookingSelectors?.getCookingSessionById) {
          s = await cookingSelectors.getCookingSessionById(sessionId);
        }

        if (!alive) return;
        setSession(s || null);
        loadedForIdRef.current = sessionId;

        // Hydrate review fields if present
        const meta = safeObject(
          (s && (s.review || s.meta?.review || s.meta?.outcome)) || {}
        );
        setReviewNotes(asStr(meta.notes || meta.reviewNotes || ""));
        setLeftovers(asStr(meta.leftovers || ""));
        setRating(Number(meta.rating || 0) || 0);
        setTags(
          asStr(meta.tags || "")
            .replace(/\s+/g, " ")
            .trim()
        );
      } catch (e) {
        if (!alive) return;
        setErr(e?.message || "Failed to load session");
        setSession(null);
      } finally {
        if (!alive) return;
        setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [open, loadOnOpen, sessionId]);

  const normalized = useMemo(() => {
    const s = safeObject(session);

    const id = s.sessionId || s.id || sessionId || "";
    const startedAt = s.startedAt || s.startTime || s.startedISO || s.started;
    const endedAt = s.endedAt || s.endTime || s.endedISO || s.ended;

    const steps =
      safeArray(s.steps) ||
      safeArray(s.blueprint?.steps) ||
      safeArray(s.session?.steps) ||
      safeArray(s.plan?.steps);

    const recipes =
      safeArray(s.recipes) ||
      safeArray(s.meta?.recipes) ||
      safeArray(s.data?.recipes) ||
      [];

    const ingredients =
      safeArray(s.ingredients) ||
      safeArray(s.meta?.ingredients) ||
      safeArray(s.data?.ingredients) ||
      safeArray(s.inputs?.ingredients) ||
      [];

    const inventoryImpacts =
      safeArray(s.inventoryImpacts) ||
      safeArray(s.meta?.inventoryImpacts) ||
      safeArray(s.data?.inventoryImpacts) ||
      safeArray(s.inventory?.impacts) ||
      [];

    const servings =
      s.servings ?? s.portions ?? s.meta?.servings ?? s.meta?.portions ?? null;

    const durationMins = durationFrom(s);

    const status = s.status || s.state || (endedAt ? "completed" : "active");

    return {
      raw: s,
      id,
      startedAt,
      endedAt,
      status,
      steps,
      recipes,
      ingredients,
      inventoryImpacts,
      servings,
      durationMins,
      title:
        s.title ||
        s.name ||
        (recipes[0]?.title
          ? `Cooking: ${recipes[0]?.title}`
          : "Cooking Session"),
    };
  }, [session, sessionId]);

  const stepStats = useMemo(() => {
    const steps = safeArray(normalized.steps);

    const total = steps.length;
    const done = steps.filter((st) => {
      const s = safeObject(st);
      const completed =
        s.completed === true ||
        s.done === true ||
        s.status === "done" ||
        s.state === "done" ||
        s.completedAt ||
        s.endedAt;
      return !!completed;
    }).length;

    const notesCount = steps.filter(
      (st) => !!safeObject(st).note || !!safeObject(st).notes
    ).length;

    return { total, done, notesCount };
  }, [normalized.steps]);

  const ingredientStats = useMemo(() => {
    const ing = safeArray(normalized.ingredients);
    const count = ing.length;

    const withQty = ing.filter((i) => {
      const o = safeObject(i);
      const q = o.quantity ?? o.qty ?? o.amount;
      return Number.isFinite(Number(q)) && Number(q) > 0;
    }).length;

    const withMap = ing.filter(
      (i) =>
        !!(
          safeObject(i).inventoryItemId ||
          safeObject(i).sku ||
          safeObject(i).itemId
        )
    ).length;

    return { count, withQty, withMap };
  }, [normalized.ingredients]);

  const impactStats = useMemo(() => {
    const impacts = safeArray(normalized.inventoryImpacts);
    if (!impacts.length) return { count: 0, adds: 0, subs: 0 };

    let adds = 0;
    let subs = 0;

    for (const it of impacts) {
      const o = safeObject(it);
      const delta = Number(o.delta ?? o.change ?? o.qtyDelta ?? 0);
      if (Number.isFinite(delta)) {
        if (delta > 0) adds += 1;
        if (delta < 0) subs += 1;
      } else {
        const kind = String(o.type || o.kind || "").toLowerCase();
        if (kind.includes("add")) adds += 1;
        if (
          kind.includes("sub") ||
          kind.includes("use") ||
          kind.includes("consume")
        )
          subs += 1;
      }
    }

    return { count: impacts.length, adds, subs };
  }, [normalized.inventoryImpacts]);

  const summaryText = useMemo(() => {
    const lines = [];
    lines.push(`${normalized.title}`);
    lines.push(`Session: ${normalized.id || "—"}`);
    lines.push(`Status: ${normalized.status || "—"}`);
    if (normalized.startedAt)
      lines.push(`Started: ${fmtDateTime(normalized.startedAt)}`);
    if (normalized.endedAt)
      lines.push(`Ended: ${fmtDateTime(normalized.endedAt)}`);
    if (normalized.durationMins != null)
      lines.push(`Duration: ${fmtMins(normalized.durationMins)}`);
    if (normalized.servings != null)
      lines.push(`Servings: ${normalized.servings}`);
    lines.push(`Steps: ${stepStats.done}/${stepStats.total}`);
    lines.push(
      `Ingredients: ${ingredientStats.count} (mapped: ${ingredientStats.withMap})`
    );
    if (impactStats.count)
      lines.push(
        `Inventory impacts: ${impactStats.count} (adds: ${impactStats.adds}, uses: ${impactStats.subs})`
      );

    if (reviewNotes.trim()) lines.push(`Notes: ${reviewNotes.trim()}`);
    if (leftovers.trim()) lines.push(`Leftovers: ${leftovers.trim()}`);
    if (rating) lines.push(`Rating: ${rating}/5`);
    if (tags.trim()) lines.push(`Tags: ${tags.trim()}`);

    return lines.join("\n");
  }, [
    normalized,
    stepStats,
    ingredientStats,
    impactStats,
    reviewNotes,
    leftovers,
    rating,
    tags,
  ]);

  const exportPayload = useMemo(() => {
    const base = {
      type: "cooking.session.review.export",
      exportedAt: new Date().toISOString(),
      sessionId: normalized.id || null,
      sessionTitle: normalized.title || null,
      status: normalized.status || null,
      startedAt: normalized.startedAt || null,
      endedAt: normalized.endedAt || null,
      durationMins: normalized.durationMins ?? null,
      servings: normalized.servings ?? null,
      stats: {
        steps: stepStats,
        ingredients: ingredientStats,
        inventory: impactStats,
      },
      review: {
        notes: reviewNotes || "",
        leftovers: leftovers || "",
        rating: rating || 0,
        tags: tags || "",
      },
      session: normalized.raw || null,
    };
    return base;
  }, [
    normalized,
    stepStats,
    ingredientStats,
    impactStats,
    reviewNotes,
    leftovers,
    rating,
    tags,
  ]);

  async function handleExport() {
    try {
      emit("cooking.session.review.export", { sessionId: normalized.id });
      await dashLog("Exported cooking session review", {
        sessionId: normalized.id,
      });

      if (typeof onExport === "function") {
        onExport(exportPayload);
        return;
      }

      const filename = `cooking-session-${(normalized.id || "export").replace(
        /[^\w-]+/g,
        "_"
      )}.json`;
      downloadJson(filename, exportPayload);
    } catch (e) {
      setErr(e?.message || "Export failed");
    }
  }

  async function handleCopySummary() {
    try {
      await copyToClipboard(summaryText);
      await dashLog("Copied cooking session summary", {
        sessionId: normalized.id,
      });
      emit("cooking.session.review.copied", { sessionId: normalized.id });
    } catch (e) {
      setErr(e?.message || "Copy failed");
    }
  }

  async function handleSaveReview() {
    const patch = {
      review: {
        notes: reviewNotes || "",
        leftovers: leftovers || "",
        rating: rating || 0,
        tags: (tags || "").trim(),
        updatedAt: new Date().toISOString(),
      },
    };

    try {
      setErr("");
      emit("cooking.session.review.save.requested", {
        sessionId: normalized.id,
      });

      // 1) user callback wins
      if (typeof onCommitReview === "function") {
        await onCommitReview(patch);
      } else {
        // 2) best-effort sessionStore write
        const sid = normalized.id;
        if (sid && sessionStore?.patch) {
          await sessionStore.patch(sid, patch);
        } else if (sid && sessionStore?.update) {
          await sessionStore.update(sid, patch);
        } else if (sid && sessionStore?.upsert) {
          await sessionStore.upsert({ ...(normalized.raw || {}), ...patch });
        } else {
          // Fallback: just update local state so UI isn't lost
          setSession((prev) => {
            const p = safeObject(prev);
            const meta = safeObject(p.meta);
            return {
              ...p,
              review: deepMergeSafe(safeObject(p.review), patch.review),
              meta: deepMergeSafe(meta, { review: patch.review }),
            };
          });
        }
      }

      await dashLog("Saved cooking session review", {
        sessionId: normalized.id,
      });
      emit("cooking.session.review.saved", { sessionId: normalized.id, patch });

      // show subtle success without toast system dependency
      if (logger?.info)
        logger.info(
          "Saved cooking session review",
          { sessionId: normalized.id },
          { source: SOURCE }
        );
    } catch (e) {
      setErr(e?.message || "Failed to save review");
      if (logger?.error)
        logger.error("Failed to save cooking session review", e, {
          source: SOURCE,
        });
    }
  }

  function deepMergeSafe(base, patch) {
    const b = safeObject(base);
    const p = safeObject(patch);
    const out = { ...b };
    for (const k of Object.keys(p)) {
      const pv = p[k];
      const bv = out[k];
      if (
        pv &&
        typeof pv === "object" &&
        !Array.isArray(pv) &&
        bv &&
        typeof bv === "object" &&
        !Array.isArray(bv)
      ) {
        out[k] = deepMergeSafe(bv, pv);
      } else out[k] = pv;
    }
    return out;
  }

  const footer = (
    <>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <button className="btn" onClick={handleCopySummary} style={btnStyle()}>
          Copy Summary
        </button>
        <button className="btn" onClick={handleExport} style={btnStyle()}>
          Export JSON
        </button>
        <button
          className="btn"
          onClick={handleSaveReview}
          style={btnStyle({ fontWeight: 700 })}
        >
          Save Review
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          className="btn"
          onClick={onClose}
          style={btnStyle({ background: "rgba(0,0,0,0.04)" })}
        >
          Close
        </button>
      </div>
    </>
  );

  return (
    <ModalShell
      open={!!open}
      onClose={onClose}
      title={title || "Cooking Session Review"}
      footer={footer}
    >
      {/* top summary strip */}
      <div
        className="card"
        style={{
          padding: 12,
          borderRadius: 12,
          border: "1px solid rgba(0,0,0,0.08)",
          background: "rgba(0,0,0,0.02)",
          marginBottom: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "baseline",
            justifyContent: "space-between",
            flexWrap: "wrap",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.2 }}>
              {normalized.title}
            </div>
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
              Session ID:{" "}
              <span style={{ fontFamily: "monospace" }}>
                {normalized.id || "—"}
              </span>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Pill label="Status" value={normalized.status} />
            <Pill
              label="Duration"
              value={
                normalized.durationMins != null
                  ? fmtMins(normalized.durationMins)
                  : "—"
              }
            />
            <Pill
              label="Steps"
              value={`${stepStats.done}/${stepStats.total}`}
            />
            <Pill label="Ingredients" value={`${ingredientStats.count}`} />
          </div>
        </div>

        <div
          style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}
        >
          <SmallKV
            label="Started"
            value={
              normalized.startedAt ? fmtDateTime(normalized.startedAt) : "—"
            }
          />
          <SmallKV
            label="Ended"
            value={normalized.endedAt ? fmtDateTime(normalized.endedAt) : "—"}
          />
          <SmallKV
            label="Servings"
            value={
              normalized.servings != null ? String(normalized.servings) : "—"
            }
          />
          {impactStats.count ? (
            <SmallKV
              label="Inventory impacts"
              value={`${impactStats.count} (adds: ${impactStats.adds}, uses: ${impactStats.subs})`}
            />
          ) : (
            <SmallKV label="Inventory impacts" value="—" />
          )}
        </div>
      </div>

      {/* errors / loading */}
      {loading ? (
        <div style={{ padding: 10, opacity: 0.8 }}>Loading session…</div>
      ) : null}
      {err ? (
        <div
          style={{
            padding: 10,
            borderRadius: 10,
            border: "1px solid rgba(220, 38, 38, 0.25)",
            background: "rgba(220, 38, 38, 0.06)",
            color: "#7f1d1d",
            marginBottom: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          {err}
        </div>
      ) : null}

      {/* tabs */}
      <div
        style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}
      >
        <TabButton
          active={activeTab === "summary"}
          onClick={() => setActiveTab("summary")}
        >
          Summary
        </TabButton>
        <TabButton
          active={activeTab === "steps"}
          onClick={() => setActiveTab("steps")}
        >
          Steps
        </TabButton>
        <TabButton
          active={activeTab === "ingredients"}
          onClick={() => setActiveTab("ingredients")}
        >
          Ingredients
        </TabButton>
        <TabButton
          active={activeTab === "inventory"}
          onClick={() => setActiveTab("inventory")}
        >
          Inventory
        </TabButton>
        <TabButton
          active={activeTab === "notes"}
          onClick={() => setActiveTab("notes")}
        >
          Notes & Outcome
        </TabButton>
      </div>

      {/* tab panels */}
      {activeTab === "summary" ? (
        <SummaryPanel
          normalized={normalized}
          stepStats={stepStats}
          ingredientStats={ingredientStats}
          impactStats={impactStats}
        />
      ) : null}

      {activeTab === "steps" ? <StepsPanel steps={normalized.steps} /> : null}

      {activeTab === "ingredients" ? (
        <IngredientsPanel ingredients={normalized.ingredients} />
      ) : null}

      {activeTab === "inventory" ? (
        <InventoryPanel
          impacts={normalized.inventoryImpacts}
          ingredients={normalized.ingredients}
        />
      ) : null}

      {activeTab === "notes" ? (
        <NotesPanel
          reviewNotes={reviewNotes}
          setReviewNotes={setReviewNotes}
          leftovers={leftovers}
          setLeftovers={setLeftovers}
          rating={rating}
          setRating={setRating}
          tags={tags}
          setTags={setTags}
        />
      ) : null}
    </ModalShell>
  );
}

/* -----------------------------------------------------------------------------
 * Small UI pieces
 * -------------------------------------------------------------------------- */

function btnStyle(extra = {}) {
  return {
    borderRadius: 10,
    padding: "10px 12px",
    border: "1px solid rgba(0,0,0,0.12)",
    background: "rgba(0,0,0,0.02)",
    cursor: "pointer",
    ...extra,
  };
}

function TabButton({ active, children, onClick }) {
  return (
    <button
      className="btn"
      onClick={onClick}
      style={{
        ...btnStyle(),
        background: active ? "rgba(0,0,0,0.08)" : "rgba(0,0,0,0.02)",
        borderColor: active ? "rgba(0,0,0,0.20)" : "rgba(0,0,0,0.12)",
        fontWeight: active ? 800 : 600,
      }}
    >
      {children}
    </button>
  );
}

function Pill({ label, value }) {
  return (
    <div
      style={{
        padding: "8px 10px",
        borderRadius: 999,
        border: "1px solid rgba(0,0,0,0.10)",
        background: "rgba(0,0,0,0.02)",
        display: "flex",
        gap: 6,
        alignItems: "baseline",
      }}
    >
      <span style={{ fontSize: 11, opacity: 0.75 }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 800 }}>{value ?? "—"}</span>
    </div>
  );
}

function SmallKV({ label, value }) {
  return (
    <div style={{ display: "flex", gap: 6, fontSize: 12 }}>
      <span style={{ opacity: 0.7 }}>{label}:</span>
      <span style={{ fontWeight: 700 }}>{value ?? "—"}</span>
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Panels
 * -------------------------------------------------------------------------- */

function SummaryPanel({ normalized, stepStats, ingredientStats, impactStats }) {
  const recipes = safeArray(normalized.recipes);
  const topRecipes = recipes.length
    ? recipes
        .map((r) => r.title || r.name || r.id)
        .filter(Boolean)
        .slice(0, 10)
    : [];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      <div className="card" style={panelCard()}>
        <div style={panelTitle()}>Session Summary</div>
        <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
          <SmallKV label="Title" value={normalized.title} />
          <SmallKV label="Status" value={normalized.status} />
          <SmallKV
            label="Started"
            value={
              normalized.startedAt ? fmtDateTime(normalized.startedAt) : "—"
            }
          />
          <SmallKV
            label="Ended"
            value={normalized.endedAt ? fmtDateTime(normalized.endedAt) : "—"}
          />
          <SmallKV
            label="Duration"
            value={
              normalized.durationMins != null
                ? fmtMins(normalized.durationMins)
                : "—"
            }
          />
          <SmallKV
            label="Servings"
            value={
              normalized.servings != null ? String(normalized.servings) : "—"
            }
          />
        </div>
      </div>

      <div className="card" style={panelCard()}>
        <div style={panelTitle()}>Coverage</div>
        <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
          <SmallKV
            label="Steps completed"
            value={`${stepStats.done}/${stepStats.total}`}
          />
          <SmallKV label="Step notes" value={`${stepStats.notesCount}`} />
          <SmallKV label="Ingredients" value={`${ingredientStats.count}`} />
          <SmallKV
            label="Ingredient qty set"
            value={`${ingredientStats.withQty}`}
          />
          <SmallKV
            label="Ingredient mapped to inventory"
            value={`${ingredientStats.withMap}`}
          />
          <SmallKV label="Inventory impacts" value={`${impactStats.count}`} />
        </div>
      </div>

      <div className="card" style={{ ...panelCard(), gridColumn: "1 / -1" }}>
        <div style={panelTitle()}>Recipes</div>
        <div style={{ marginTop: 8 }}>
          {topRecipes.length ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {topRecipes.map((t, idx) => (
                <li key={`${t}-${idx}`} style={{ marginBottom: 4 }}>
                  {t}
                </li>
              ))}
            </ul>
          ) : (
            <div style={{ opacity: 0.75 }}>
              No recipes attached to this session.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepsPanel({ steps }) {
  const list = safeArray(steps);

  return (
    <div className="card" style={panelCard()}>
      <div style={panelTitle()}>Steps</div>

      {list.length ? (
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          {list.map((st, idx) => {
            const s = safeObject(st);
            const title = s.title || s.name || `Step ${idx + 1}`;
            const done =
              s.completed === true ||
              s.done === true ||
              s.status === "done" ||
              s.state === "done" ||
              !!s.completedAt ||
              !!s.endedAt;

            const startedAt = s.startedAt || s.startedISO || null;
            const endedAt = s.completedAt || s.endedAt || null;
            const note = s.note || s.notes || "";

            const est =
              s.estMins ?? s.estimatedMinutes ?? s.durationMins ?? null;

            return (
              <div
                key={s.id || `${title}-${idx}`}
                style={{
                  border: "1px solid rgba(0,0,0,0.10)",
                  borderRadius: 12,
                  padding: 10,
                  background: done
                    ? "rgba(16, 185, 129, 0.06)"
                    : "rgba(0,0,0,0.02)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ fontWeight: 800 }}>
                    {done ? "✅" : "⬜"} {title}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>
                    {est != null ? `Est: ${Math.round(Number(est))}m` : null}
                  </div>
                </div>

                <div
                  style={{
                    marginTop: 6,
                    display: "flex",
                    gap: 12,
                    flexWrap: "wrap",
                    fontSize: 12,
                    opacity: 0.85,
                  }}
                >
                  {startedAt ? (
                    <span>Start: {fmtDateTime(startedAt)}</span>
                  ) : null}
                  {endedAt ? <span>End: {fmtDateTime(endedAt)}</span> : null}
                </div>

                {note ? (
                  <div
                    style={{
                      marginTop: 8,
                      fontSize: 13,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    <span style={{ fontWeight: 700, opacity: 0.85 }}>
                      Note:
                    </span>{" "}
                    {String(note)}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ marginTop: 10, opacity: 0.75 }}>
          No steps found on this session.
        </div>
      )}
    </div>
  );
}

function IngredientsPanel({ ingredients }) {
  const list = safeArray(ingredients);

  return (
    <div className="card" style={panelCard()}>
      <div style={panelTitle()}>Ingredients</div>

      {list.length ? (
        <div style={{ marginTop: 10, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["Ingredient", "Qty", "Unit", "Mapped Item", "Notes"].map(
                  (h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "left",
                        fontSize: 12,
                        padding: "8px 8px",
                        borderBottom: "1px solid rgba(0,0,0,0.10)",
                        opacity: 0.8,
                      }}
                    >
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {list.map((it, idx) => {
                const o = safeObject(it);
                const name =
                  o.name || o.label || o.ingredient || o.title || "—";
                const qty = o.quantity ?? o.qty ?? o.amount ?? "";
                const unit = o.unit ?? o.uom ?? "";
                const mapped =
                  o.inventoryName ||
                  o.itemName ||
                  o.sku ||
                  o.inventoryItemId ||
                  o.itemId ||
                  "";
                const note = o.note || o.notes || "";

                return (
                  <tr key={o.id || `${name}-${idx}`}>
                    <td style={tdStyle()}>{name}</td>
                    <td style={tdStyle()}>{qty !== "" ? String(qty) : "—"}</td>
                    <td style={tdStyle()}>{unit ? String(unit) : "—"}</td>
                    <td style={tdStyle()}>
                      {mapped ? (
                        <span style={{ fontFamily: "monospace" }}>
                          {String(mapped)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={tdStyle()}>{note ? String(note) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ marginTop: 10, opacity: 0.75 }}>
          No ingredients found on this session.
        </div>
      )}
    </div>
  );
}

function InventoryPanel({ impacts, ingredients }) {
  const list = safeArray(impacts);
  const ing = safeArray(ingredients);

  // If impacts missing, attempt to derive simple "consumed" list from ingredients (best-effort)
  const derived = useMemo(() => {
    if (list.length) return [];
    return ing
      .map((i) => {
        const o = safeObject(i);
        const qty = Number(o.quantity ?? o.qty ?? o.amount ?? 0);
        if (!Number.isFinite(qty) || qty <= 0) return null;
        const unit = o.unit ?? o.uom ?? "";
        const name =
          o.inventoryName || o.itemName || o.name || o.label || "Ingredient";
        return {
          id: o.id || `${name}-${unit}-${qty}`,
          item: name,
          delta: -qty,
          unit,
          note: "Derived from ingredients",
        };
      })
      .filter(Boolean);
  }, [list.length, ing]);

  const shown = list.length ? list : derived;

  return (
    <div className="card" style={panelCard()}>
      <div style={panelTitle()}>Inventory</div>

      {shown.length ? (
        <div style={{ marginTop: 10, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["Item", "Delta", "Unit", "Type", "Details"].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: "left",
                      fontSize: 12,
                      padding: "8px 8px",
                      borderBottom: "1px solid rgba(0,0,0,0.10)",
                      opacity: 0.8,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((it, idx) => {
                const o = safeObject(it);
                const item =
                  o.itemName ||
                  o.inventoryName ||
                  o.name ||
                  o.item ||
                  o.sku ||
                  o.inventoryItemId ||
                  o.itemId ||
                  "—";

                const delta = Number(o.delta ?? o.change ?? o.qtyDelta ?? 0);
                const unit = o.unit ?? o.uom ?? "";
                const type =
                  o.type ||
                  o.kind ||
                  (delta < 0 ? "consume" : delta > 0 ? "add" : "adjust");
                const details = o.note || o.notes || o.reason || "";

                return (
                  <tr key={o.id || `${item}-${idx}`}>
                    <td style={tdStyle()}>{String(item)}</td>
                    <td style={tdStyle()}>
                      {Number.isFinite(delta) ? (
                        <span
                          style={{ fontFamily: "monospace", fontWeight: 800 }}
                        >
                          {delta > 0 ? `+${delta}` : `${delta}`}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={tdStyle()}>{unit ? String(unit) : "—"}</td>
                    <td style={tdStyle()}>{String(type)}</td>
                    <td style={tdStyle()}>{details ? String(details) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {!list.length && derived.length ? (
            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
              These inventory rows are derived from ingredient quantities
              because no explicit inventory impacts were recorded.
            </div>
          ) : null}
        </div>
      ) : (
        <div style={{ marginTop: 10, opacity: 0.75 }}>
          No inventory impacts recorded for this session.
        </div>
      )}
    </div>
  );
}

function NotesPanel({
  reviewNotes,
  setReviewNotes,
  leftovers,
  setLeftovers,
  rating,
  setRating,
  tags,
  setTags,
}) {
  return (
    <div className="card" style={panelCard()}>
      <div style={panelTitle()}>Notes & Outcome</div>

      <div style={{ marginTop: 10, display: "grid", gap: 12 }}>
        <div>
          <div style={fieldLabel()}>Review Notes</div>
          <textarea
            value={reviewNotes}
            onChange={(e) => setReviewNotes(e.target.value)}
            rows={5}
            style={textareaStyle()}
            placeholder="What went well? What should change next time? Timing notes, seasoning, substitutions…"
          />
        </div>

        <div>
          <div style={fieldLabel()}>Leftovers</div>
          <textarea
            value={leftovers}
            onChange={(e) => setLeftovers(e.target.value)}
            rows={3}
            style={textareaStyle()}
            placeholder="What leftovers were produced, and where did you store them?"
          />
        </div>

        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
        >
          <div>
            <div style={fieldLabel()}>Rating</div>
            <StarRating value={rating} onChange={setRating} />
          </div>
          <div>
            <div style={fieldLabel()}>Tags</div>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              style={inputStyle()}
              placeholder="e.g., quick, family-favorite, spicy, freezer-friendly"
            />
          </div>
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, opacity: 0.75 }}>
        Tip: Use tags to improve your “fixed but varied” rotation logic (search
        + filters + seasonal buckets).
      </div>
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Form/UI styles
 * -------------------------------------------------------------------------- */

function panelCard() {
  return {
    padding: 12,
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,0.08)",
    background: "rgba(255,255,255,0.9)",
  };
}
function panelTitle() {
  return { fontSize: 14, fontWeight: 900, letterSpacing: 0.2 };
}
function tdStyle() {
  return {
    padding: "8px 8px",
    borderBottom: "1px solid rgba(0,0,0,0.06)",
    fontSize: 13,
    verticalAlign: "top",
  };
}
function fieldLabel() {
  return { fontSize: 12, fontWeight: 800, opacity: 0.8, marginBottom: 6 };
}
function textareaStyle() {
  return {
    width: "100%",
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,0.12)",
    padding: "10px 12px",
    fontSize: 13,
    outline: "none",
    background: "rgba(0,0,0,0.02)",
    resize: "vertical",
  };
}
function inputStyle() {
  return {
    width: "100%",
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,0.12)",
    padding: "10px 12px",
    fontSize: 13,
    outline: "none",
    background: "rgba(0,0,0,0.02)",
  };
}

/* -----------------------------------------------------------------------------
 * Star rating
 * -------------------------------------------------------------------------- */

function StarRating({ value = 0, onChange }) {
  const v = Number(value) || 0;
  const stars = [1, 2, 3, 4, 5];

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      {stars.map((s) => {
        const active = s <= v;
        return (
          <button
            key={s}
            onClick={() => onChange?.(s)}
            className="btn"
            style={{
              borderRadius: 10,
              padding: "8px 10px",
              border: "1px solid rgba(0,0,0,0.12)",
              background: active
                ? "rgba(250, 204, 21, 0.25)"
                : "rgba(0,0,0,0.02)",
              cursor: "pointer",
              fontSize: 14,
              lineHeight: 1,
            }}
            title={`${s}/5`}
            aria-label={`Set rating ${s} of 5`}
          >
            {active ? "★" : "☆"}
          </button>
        );
      })}
      <span style={{ fontSize: 12, opacity: 0.75, marginLeft: 6 }}>
        {v ? `${v}/5` : "No rating"}
      </span>
    </div>
  );
}
