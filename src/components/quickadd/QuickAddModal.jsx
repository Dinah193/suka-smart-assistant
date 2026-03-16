/* eslint-disable no-console */
// src/components/quickadd/QuickAddModal.jsx

import React, { useEffect, useMemo, useRef, useState } from "react";
import QuickAddEngine from "@/services/quickadd/QuickAddEngine";
import { QUICKADD_EVENTS } from "@/services/quickadd/quickAddContracts";

/* ----------------------- soft import eventBus (optional) ------------------- */
let eventBus = { emit: () => {}, on: () => () => {} };
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eb || eventBus;
} catch {
  try {
    // eslint-disable-next-line global-require
    const eb2 = require("@/services/events/eventBus");
    eventBus = eb2?.default || eb2?.eventBus || eb2 || eventBus;
  } catch {}
}

function cn(...a) {
  return a.filter(Boolean).join(" ");
}

function safeStr(x) {
  return x == null ? "" : String(x);
}

function domainColor(domain) {
  switch (domain) {
    case "inventory":
      return "bg-emerald-50 border-emerald-200 text-emerald-900";
    case "cooking":
      return "bg-amber-50 border-amber-200 text-amber-900";
    case "cleaning":
      return "bg-sky-50 border-sky-200 text-sky-900";
    case "garden":
      return "bg-lime-50 border-lime-200 text-lime-900";
    case "animals":
      return "bg-violet-50 border-violet-200 text-violet-900";
    case "nutrition":
      return "bg-rose-50 border-rose-200 text-rose-900";
    default:
      return "bg-slate-50 border-slate-200 text-slate-900";
  }
}

function prettyDomain(d) {
  if (!d) return "Unknown";
  return d.charAt(0).toUpperCase() + d.slice(1);
}

function pct(n) {
  const x = Math.round((Number(n || 0) * 100) / 1);
  return `${Math.max(0, Math.min(100, x))}%`;
}

function chipLabel(k, v) {
  if (v == null || v === "") return k;
  if (typeof v === "number") return `${k}: ${v}`;
  return `${k}: ${safeStr(v)}`;
}

function pickDefaultChips(suggestion) {
  const dom = suggestion?.domain;
  const f = suggestion?.fields || {};
  if (dom === "inventory") {
    return [
      {
        key: "category",
        value: f.category || "pantry",
        options: ["pantry", "freezer", "fridge", "storehouse"],
      },
      {
        key: "storage",
        value: f.storage || "pantry",
        options: ["pantry", "freezer", "fridge", "root cellar"],
      },
      {
        key: "unit",
        value: f.unit || "ea",
        options: ["ea", "lb", "oz", "g", "kg"],
      },
    ];
  }
  if (dom === "cleaning") {
    return [
      {
        key: "zone",
        value: f.zone || "kitchen",
        options: ["kitchen", "bathroom", "living", "bedroom"],
      },
      {
        key: "priority",
        value: f.priority || "normal",
        options: ["low", "normal", "high"],
      },
      {
        key: "estMinutes",
        value: f.estMinutes ?? 10,
        options: [5, 10, 15, 20, 30],
      },
    ];
  }
  if (dom === "garden") {
    return [
      {
        key: "bed",
        value: f.bed || "Bed 1",
        options: ["Bed 1", "Bed 2", "Greenhouse", "Orchard"],
      },
      {
        key: "action",
        value: f.action || "care",
        options: ["plant", "care", "harvest"],
      },
      {
        key: "estMinutes",
        value: f.estMinutes ?? 15,
        options: [10, 15, 20, 30],
      },
    ];
  }
  if (dom === "animals") {
    return [
      {
        key: "animalGroup",
        value: f.animalGroup || "livestock",
        options: ["chickens", "goats", "sheep", "livestock"],
      },
      {
        key: "action",
        value: f.action || "care",
        options: ["feed", "care", "health"],
      },
      {
        key: "estMinutes",
        value: f.estMinutes ?? 10,
        options: [5, 10, 15, 20],
      },
    ];
  }
  if (dom === "nutrition") {
    return [{ key: "applyToMealPlan", value: true, options: [true, false] }];
  }
  if (dom === "cooking") {
    return [
      {
        key: "intent",
        value: f.intent || "note",
        options: ["ingredient", "note"],
      },
      {
        key: "recipeHint",
        value: f.recipeHint || "meal",
        options: ["meal", "recipe"],
      },
    ];
  }
  return [];
}

function Overlay({ open, onClose, children }) {
  if (!open) return null;
  return (
    <div
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 12,
      }}
    >
      {children}
    </div>
  );
}

export default function QuickAddModal({
  // optional overrides
  householdId,
  personId,
  defaultOpen = false,
  defaultText = "",
}) {
  const engine = useMemo(() => new QuickAddEngine(), []);
  const inputRef = useRef(null);

  const [open, setOpen] = useState(Boolean(defaultOpen));
  const [source, setSource] = useState("unknown");

  const [rawText, setRawText] = useState(defaultText);
  const [draft, setDraft] = useState(null);
  const [suggestion, setSuggestion] = useState(null);
  const [confirmed, setConfirmed] = useState({});
  const [status, setStatus] = useState("idle"); // idle|detecting|ready|committing|done|error
  const [error, setError] = useState("");

  // undo
  const [undoPayload, setUndoPayload] = useState(null);
  const undoTimerRef = useRef(null);

  function close() {
    setOpen(false);
    setStatus("idle");
    setError("");
    setDraft(null);
    setSuggestion(null);
    setConfirmed({});
    setRawText("");
  }

  // Listen for quickadd.opened via window + eventBus
  useEffect(() => {
    const onOpen = (payload) => {
      setSource(payload?.source || "unknown");
      setRawText(payload?.initialText || "");
      setOpen(true);
      setTimeout(() => inputRef.current?.focus?.(), 50);
    };

    const winHandler = (e) => onOpen(e?.detail || {});
    window.addEventListener(QUICKADD_EVENTS.OPEN, winHandler);

    const off = eventBus?.on?.(QUICKADD_EVENTS.OPEN, (evt) =>
      onOpen(evt?.data || evt || {})
    );

    return () => {
      window.removeEventListener(QUICKADD_EVENTS.OPEN, winHandler);
      if (typeof off === "function") off();
    };
  }, []);

  // Detect/suggest on input changes (debounced)
  useEffect(() => {
    if (!open) return undefined;
    const t = safeStr(rawText).trim();
    if (!t) {
      setDraft(null);
      setSuggestion(null);
      setConfirmed({});
      setStatus("idle");
      setError("");
      return undefined;
    }

    setStatus("detecting");
    setError("");

    const handle = setTimeout(async () => {
      try {
        const d = await engine.upsertDraft({
          rawText: t,
          source,
          householdId,
          personId,
          existingId: draft?.id,
        });
        setDraft(d);
        setSuggestion(d?.suggestion || null);

        // initialize confirmed fields with defaults (wizardless)
        setConfirmed((prev) => {
          const base = { ...(d?.suggestion?.fields || {}) };
          // keep any user overrides
          return { ...base, ...(prev || {}) };
        });

        setStatus("ready");
      } catch (e) {
        setStatus("error");
        setError(e?.message || "Failed to detect.");
      }
    }, 250);

    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawText, open, source]);

  const chips = useMemo(() => pickDefaultChips(suggestion), [suggestion]);

  function cycleChip(ch) {
    const { key, options } = ch;
    if (!options?.length) return;
    setConfirmed((prev) => {
      const cur = prev?.[key];
      const idx = options.findIndex((x) => String(x) === String(cur));
      const next = options[(idx + 1) % options.length];
      return { ...(prev || {}), [key]: next };
    });
  }

  async function onCommit() {
    if (!draft || !suggestion) return;
    setStatus("committing");
    setError("");
    try {
      const { entity } = await engine.commitDraft(draft, confirmed);

      // show undo pill
      const undo = {
        at: new Date().toISOString(),
        domain: suggestion.domain,
        entity,
        draftId: draft.id,
      };
      setUndoPayload(undo);
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      undoTimerRef.current = setTimeout(() => setUndoPayload(null), 6500);

      setStatus("done");
      // minimal friction: close quickly after commit, keep undo available in UI
      setTimeout(() => {
        close();
      }, 250);
    } catch (e) {
      setStatus("error");
      setError(e?.message || "Commit failed.");
    }
  }

  function onUndo() {
    // “Undo” here is event-driven: tell domains to revert if they support it.
    // We still keep quickadd history, but domains can implement delete/revert.
    if (!undoPayload) return;
    try {
      eventBus?.emit?.({
        type: "quickadd.undo.requested",
        ts: new Date().toISOString(),
        source: "QuickAddModal",
        data: undoPayload,
      });
      window.dispatchEvent(
        new CustomEvent("quickadd.undo.requested", { detail: undoPayload })
      );
    } catch {}
    setUndoPayload(null);
  }

  const dom = suggestion?.domain || "unknown";
  const conf = suggestion?.confidence ?? draft?.confidence ?? 0;

  const title =
    dom === "inventory"
      ? safeStr(confirmed?.name || suggestion?.fields?.name || "New item")
      : dom === "cleaning" || dom === "garden" || dom === "animals"
      ? safeStr(confirmed?.title || suggestion?.fields?.title || "New task")
      : dom === "nutrition"
      ? "Apply nutrition target"
      : dom === "cooking"
      ? "Add cooking note"
      : "Quick Add";

  return (
    <>
      {/* floating undo (works even after modal closes) */}
      {undoPayload ? (
        <div
          style={{
            position: "fixed",
            right: 12,
            bottom: 12,
            zIndex: 10000,
            background: "white",
            border: "1px solid rgba(0,0,0,0.12)",
            borderRadius: 14,
            boxShadow: "0 12px 30px rgba(0,0,0,0.18)",
            padding: "10px 12px",
            maxWidth: 360,
            display: "flex",
            gap: 10,
            alignItems: "center",
          }}
        >
          <div style={{ fontSize: 13, lineHeight: 1.2 }}>
            <div style={{ fontWeight: 700 }}>
              Added to {prettyDomain(undoPayload.domain)}
            </div>
            <div style={{ opacity: 0.8, marginTop: 2 }}>
              Undo is available for a moment.
            </div>
          </div>
          <button
            type="button"
            onClick={onUndo}
            style={{
              marginLeft: "auto",
              border: "1px solid rgba(0,0,0,0.15)",
              background: "#fff",
              borderRadius: 10,
              padding: "6px 10px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Undo
          </button>
        </div>
      ) : null}

      <Overlay open={open} onClose={close}>
        <div
          role="dialog"
          aria-modal="true"
          style={{
            width: "min(760px, 100%)",
            background: "white",
            borderRadius: 18,
            border: "1px solid rgba(0,0,0,0.12)",
            boxShadow: "0 20px 60px rgba(0,0,0,0.22)",
            overflow: "hidden",
          }}
        >
          {/* header */}
          <div
            style={{ padding: 14, borderBottom: "1px solid rgba(0,0,0,0.08)" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ fontWeight: 900, fontSize: 16 }}>Quick Add</div>
              <div
                className={cn("qa-badge", domainColor(dom))}
                style={{
                  borderRadius: 999,
                  border: "1px solid",
                  padding: "4px 10px",
                  fontSize: 12,
                  fontWeight: 800,
                }}
              >
                {prettyDomain(dom)} • {pct(conf)}
              </div>
              <button
                type="button"
                onClick={close}
                style={{
                  marginLeft: "auto",
                  border: "none",
                  background: "transparent",
                  fontSize: 18,
                  cursor: "pointer",
                  padding: 6,
                }}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div style={{ marginTop: 10 }}>
              <input
                ref={inputRef}
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder="Scan / paste / type one line… (e.g., “2 lb chicken thighs”, “mop kitchen”, “plant kale seeds”)"
                style={{
                  width: "100%",
                  borderRadius: 14,
                  border: "1px solid rgba(0,0,0,0.16)",
                  padding: "12px 12px",
                  outline: "none",
                  fontSize: 14,
                }}
              />
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
                Minimal typing: SSA detects the domain and gives you confirm
                chips.
              </div>
            </div>
          </div>

          {/* body */}
          <div style={{ padding: 14 }}>
            {status === "detecting" ? (
              <div style={{ fontSize: 13, opacity: 0.75 }}>Detecting…</div>
            ) : null}

            {error ? (
              <div
                style={{
                  marginTop: 8,
                  background: "rgba(255,0,0,0.06)",
                  border: "1px solid rgba(255,0,0,0.18)",
                  padding: 10,
                  borderRadius: 12,
                  color: "#7a1b1b",
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                {error}
              </div>
            ) : null}

            {suggestion ? (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginTop: 8,
                  }}
                >
                  <div style={{ fontWeight: 900, fontSize: 15 }}>{title}</div>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    {safeStr(suggestion.label)}
                  </div>
                </div>

                {/* confirm chips */}
                <div
                  style={{
                    marginTop: 10,
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                  }}
                >
                  {chips.map((ch) => (
                    <button
                      key={ch.key}
                      type="button"
                      onClick={() => cycleChip(ch)}
                      style={{
                        borderRadius: 999,
                        border: "1px solid rgba(0,0,0,0.14)",
                        background: "#fff",
                        padding: "7px 10px",
                        fontSize: 12,
                        fontWeight: 800,
                        cursor: "pointer",
                      }}
                      title="Click to cycle"
                    >
                      {chipLabel(ch.key, confirmed?.[ch.key] ?? ch.value)}
                      <span style={{ marginLeft: 6, opacity: 0.55 }}>▾</span>
                    </button>
                  ))}
                  {/* contextual chips from engine */}
                  {(suggestion.chips || []).slice(0, 6).map((c) => (
                    <span
                      key={c}
                      style={{
                        borderRadius: 999,
                        background: "rgba(0,0,0,0.04)",
                        border: "1px solid rgba(0,0,0,0.10)",
                        padding: "7px 10px",
                        fontSize: 12,
                        fontWeight: 800,
                        opacity: 0.85,
                      }}
                    >
                      {c}
                    </span>
                  ))}
                </div>

                {/* compact preview of structured fields */}
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 900, opacity: 0.8 }}>
                    Structured fields
                  </div>
                  <div
                    style={{
                      marginTop: 8,
                      borderRadius: 14,
                      border: "1px solid rgba(0,0,0,0.10)",
                      background: "rgba(0,0,0,0.02)",
                      padding: 10,
                      fontSize: 12,
                      lineHeight: 1.35,
                      maxHeight: 160,
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    }}
                  >
                    {JSON.stringify(
                      {
                        domain: suggestion.domain,
                        confidence: conf,
                        fields: confirmed,
                      },
                      null,
                      2
                    )}
                  </div>
                </div>

                {/* warnings */}
                {(suggestion.warnings || []).length ? (
                  <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85 }}>
                    {suggestion.warnings.map((w) => (
                      <div key={w}>⚠️ {w}</div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <div style={{ fontSize: 13, opacity: 0.7, marginTop: 8 }}>
                Start with one line. SSA will detect and structure it.
              </div>
            )}
          </div>

          {/* footer */}
          <div
            style={{
              padding: 14,
              borderTop: "1px solid rgba(0,0,0,0.08)",
              display: "flex",
              gap: 10,
              alignItems: "center",
            }}
          >
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              {status === "ready"
                ? "Tap Confirm to create it."
                : status === "committing"
                ? "Committing…"
                : " "}
            </div>

            <button
              type="button"
              onClick={close}
              style={{
                marginLeft: "auto",
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.14)",
                background: "#fff",
                padding: "10px 12px",
                fontWeight: 900,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>

            <button
              type="button"
              onClick={onCommit}
              disabled={
                !suggestion || status === "detecting" || status === "committing"
              }
              style={{
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.12)",
                background:
                  !suggestion || status !== "ready"
                    ? "rgba(0,0,0,0.08)"
                    : "black",
                color:
                  !suggestion || status !== "ready"
                    ? "rgba(0,0,0,0.45)"
                    : "white",
                padding: "10px 14px",
                fontWeight: 900,
                cursor:
                  !suggestion || status !== "ready" ? "not-allowed" : "pointer",
              }}
            >
              Confirm
            </button>
          </div>
        </div>
      </Overlay>
    </>
  );
}
