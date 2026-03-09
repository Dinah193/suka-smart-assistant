// File: src/components/garden/GardenPlanShareModal.jsx
/**
 * GardenPlanShareModal (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Browser-only modal to share Garden Plans & Schedule Packets across:
 *      • Household (self)
 *      • Small Group
 *      • Coalition
 *      • Direct recipients (households/roles/members)
 *
 * Uses:
 *  - GardenPlanStore (plan selection + schedule generation)
 *  - GardenPlanShareService (buildSharePacket/sendShare)
 *  - eventBus for orchestration (optional auto-open)
 *
 * UX
 *  - Step 1: Choose what to share (Assignment / Collaborative / Template)
 *  - Step 2: Choose scope + recipients
 *  - Step 3: Options (schedule range, scrub options, notes, tags)
 *  - Step 4: Preview + Send/Copy/Download JSON
 *
 * Notes
 *  - This modal intentionally does NOT depend on any app-specific modal system.
 *    You can render it conditionally in a page/layout and pass `open`.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import GardenPlanStore from "@/services/gardening/GardenPlanStore";
import GardenPlanShareService from "@/services/gardening/GardenPlanShareService";
import { eventBus } from "@/services/events/eventBus";

/* ----------------------------------------------------------------------------
 * Lightweight UI primitives (no external deps)
 * ---------------------------------------------------------------------------- */

function cx(...args) {
  return args.filter(Boolean).join(" ");
}

function safeString(v) {
  return String(v ?? "");
}

function dayKeyToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function addDays(dayKey, n) {
  const d = new Date(`${dayKey}T12:00:00`);
  d.setDate(d.getDate() + Number(n || 0));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

async function copyToClipboard(text) {
  const t = safeString(text);
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch {
    // fallback below
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.setAttribute("readonly", "true");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  downloadBlob(filename, blob);
}

function emit(type, data) {
  try {
    eventBus?.emit?.(type, data, { source: "ui.GardenPlanShareModal" });
  } catch {
    // noop
  }
}

/* ----------------------------------------------------------------------------
 * Default in-modal CSS (kept minimal; uses bridge.scan.css if present)
 * ---------------------------------------------------------------------------- */

const styles = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.55)",
    zIndex: 9999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  modal: {
    width: "min(980px, 96vw)",
    maxHeight: "92vh",
    overflow: "auto",
    background: "var(--ssa-card, #111827)",
    color: "var(--ssa-text, #e5e7eb)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 14,
    boxShadow: "0 12px 30px rgba(0,0,0,0.35)",
  },
  header: {
    padding: "14px 16px",
    borderBottom: "1px solid rgba(255,255,255,0.10)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  body: {
    padding: 16,
    display: "grid",
    gap: 14,
  },
  grid2: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 14,
  },
  grid3: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: 12,
  },
  section: {
    border: "1px solid rgba(255,255,255,0.10)",
    borderRadius: 12,
    padding: 12,
    background: "rgba(255,255,255,0.03)",
  },
  label: {
    fontSize: 12,
    opacity: 0.9,
    marginBottom: 6,
  },
  input: {
    width: "100%",
    padding: "10px 10px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(0,0,0,0.25)",
    color: "inherit",
    outline: "none",
  },
  textarea: {
    width: "100%",
    padding: "10px 10px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(0,0,0,0.25)",
    color: "inherit",
    outline: "none",
    minHeight: 90,
    resize: "vertical",
  },
  pillRow: { display: "flex", flexWrap: "wrap", gap: 8 },
  pill: (active) => ({
    padding: "8px 10px",
    borderRadius: 999,
    border: `1px solid ${
      active ? "rgba(59,130,246,0.9)" : "rgba(255,255,255,0.14)"
    }`,
    background: active ? "rgba(59,130,246,0.18)" : "rgba(255,255,255,0.03)",
    cursor: "pointer",
    userSelect: "none",
    fontSize: 13,
  }),
  btnRow: { display: "flex", gap: 10, flexWrap: "wrap" },
  btn: (variant = "default") => {
    const base = {
      padding: "10px 12px",
      borderRadius: 12,
      border: "1px solid rgba(255,255,255,0.14)",
      background: "rgba(255,255,255,0.06)",
      color: "inherit",
      cursor: "pointer",
      fontWeight: 600,
      fontSize: 13,
    };
    if (variant === "primary") {
      return {
        ...base,
        background: "rgba(59,130,246,0.22)",
        border: "1px solid rgba(59,130,246,0.55)",
      };
    }
    if (variant === "danger") {
      return {
        ...base,
        background: "rgba(239,68,68,0.20)",
        border: "1px solid rgba(239,68,68,0.45)",
      };
    }
    if (variant === "ghost") {
      return { ...base, background: "transparent" };
    }
    return base;
  },
  small: { fontSize: 12, opacity: 0.88, lineHeight: 1.35 },
  mono: {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 12,
  },
  divider: {
    height: 1,
    background: "rgba(255,255,255,0.10)",
    margin: "10px 0",
  },
  previewBox: {
    border: "1px dashed rgba(255,255,255,0.18)",
    borderRadius: 12,
    padding: 12,
    background: "rgba(0,0,0,0.18)",
    overflow: "auto",
    maxHeight: 320,
  },
};

/* ----------------------------------------------------------------------------
 * Modal
 * ---------------------------------------------------------------------------- */

const DEFAULT_RANGE_DAYS = 14;

function defaultModeDefaults(mode) {
  if (mode === "assignment") {
    const from = dayKeyToday();
    return {
      schedule: {
        fromDayKey: from,
        toDayKey: addDays(from, DEFAULT_RANGE_DAYS - 1),
        includeCompleted: false,
        includeSkipped: false,
      },
      scrub: {
        includeConstraints: true,
        includeSupplies: true,
        stripStatus: true,
        scrubIdentity: true,
      },
      permissions: {
        mode: "assignment",
        canEdit: false,
        canMarkDone: true,
        canReturnReceipts: true,
      },
    };
  }
  if (mode === "template") {
    return {
      schedule: null,
      scrub: {
        scrubIdentity: true,
        keepTaskNotes: false,
        keepPlanNotes: true,
        keepBlackouts: false,
        scrubTimestamps: true,
      },
      permissions: {
        mode: "template",
        canEdit: true,
        canMarkDone: false,
        canReturnReceipts: false,
      },
    };
  }
  // collaborative
  return {
    schedule: null,
    scrub: {
      scrubIdentity: false,
    },
    permissions: {
      mode: "collaborative",
      canEdit: true,
      canMarkDone: true,
      canReturnReceipts: true,
    },
  };
}

/**
 * Optional "directory" provider for scope/recipients.
 * If you have GroupStore/CoalitionStore etc., pass these lists in props.
 *
 * @param {{
 *  open: boolean,
 *  onClose: ()=>void,
 *  planId?: string,
 *  actor?: { actorId?:string, householdId?:string, name?:string },
 *  // Directory data:
 *  households?: Array<{ id:string, label:string }>,
 *  groups?: Array<{ id:string, name:string }>,
 *  coalitions?: Array<{ id:string, name:string }>,
 *  roles?: Array<{ id:string, label:string }>,
 *  // behavior:
 *  autoOpenOnEvent?: boolean,
 * }} props
 */
export default function GardenPlanShareModal(props) {
  const {
    open,
    onClose,
    planId: planIdProp,
    actor,
    households = [],
    groups = [],
    coalitions = [],
    roles = [],
    autoOpenOnEvent = true,
  } = props || {};

  const [internalOpen, setInternalOpen] = useState(!!open);
  const isOpen = open != null ? !!open : internalOpen;

  const [planId, setPlanId] = useState(
    planIdProp || GardenPlanStore.getActivePlan()?.id || ""
  );
  const [mode, setMode] = useState("assignment"); // assignment | collaborative | template

  const [scopeType, setScopeType] = useState("direct"); // direct | household | group | coalition
  const [scopeId, setScopeId] = useState("");
  const [scopeName, setScopeName] = useState("");

  const [recipients, setRecipients] = useState([]); // [{type,id,label}]
  const [metaTitle, setMetaTitle] = useState("");
  const [metaNotes, setMetaNotes] = useState("");
  const [metaTags, setMetaTags] = useState("");

  const [schedule, setSchedule] = useState(
    defaultModeDefaults("assignment").schedule
  );
  const [scrub, setScrub] = useState(defaultModeDefaults("assignment").scrub);
  const [permissions, setPermissions] = useState(
    defaultModeDefaults("assignment").permissions
  );

  const [preview, setPreview] = useState(null); // built packet
  const [status, setStatus] = useState({ busy: false, msg: "", error: "" });

  const closeBtnRef = useRef(null);

  // Sync prop-controlled open
  useEffect(() => {
    if (open == null) return;
    setInternalOpen(!!open);
  }, [open]);

  // Update planId if prop changes
  useEffect(() => {
    if (planIdProp) setPlanId(planIdProp);
  }, [planIdProp]);

  // Auto-open via eventBus
  useEffect(() => {
    if (!autoOpenOnEvent) return () => {};
    // When user chooses "share garden plan" elsewhere, you can emit:
    // eventBus.emit("ui/modalOpen", { id:"GardenPlanShareModal", planId, mode? })
    const unsub = eventBus.on(
      "ui/modalOpen",
      (payload) => {
        const data = payload?.data || payload || {};
        if (safeString(data?.id) !== "GardenPlanShareModal") return;
        const pid = data?.planId || GardenPlanStore.getActivePlan()?.id || "";
        if (pid) setPlanId(pid);
        if (data?.mode) setMode(safeString(data.mode));
        setInternalOpen(true);
      },
      { priority: 50 }
    );
    return () => {
      try {
        unsub?.();
      } catch {}
    };
  }, [autoOpenOnEvent]);

  // Re-apply mode defaults when mode changes
  useEffect(() => {
    const d = defaultModeDefaults(mode);
    setSchedule(d.schedule);
    setScrub(d.scrub);
    setPermissions(d.permissions);

    // reasonable default title if empty
    setMetaTitle((prev) => {
      if (prev?.trim()) return prev;
      if (mode === "assignment") return "Garden Tasks";
      if (mode === "template") return "Garden Plan Template";
      return "Garden Plan";
    });

    // Clear preview on mode shift
    setPreview(null);
    setStatus({ busy: false, msg: "", error: "" });
  }, [mode]);

  const plans = useMemo(() => {
    const list = GardenPlanStore.listPlans();
    // Ensure store is hydrated
    return Array.isArray(list) ? list : [];
  }, [GardenPlanStore.getState?.()?.lastSavedISO]); // light refresh heuristic

  const activePlan = useMemo(() => GardenPlanStore.getPlan(planId), [planId]);

  const scopeOptions = useMemo(() => {
    const base = [
      { type: "direct", label: "Direct (choose recipients)" },
      { type: "household", label: "My Household" },
    ];
    if ((groups || []).length)
      base.push({ type: "group", label: "Small Group" });
    if ((coalitions || []).length)
      base.push({ type: "coalition", label: "Coalition" });
    return base;
  }, [groups, coalitions]);

  const computedScope = useMemo(() => {
    const type = scopeType;
    if (type === "direct") return { type: "direct" };
    if (type === "household")
      return {
        type: "household",
        id: actor?.householdId || "my-household",
        name: "My Household",
      };
    if (type === "group") {
      const g = (groups || []).find(
        (x) => safeString(x.id) === safeString(scopeId)
      );
      return {
        type: "group",
        id: scopeId,
        name: g?.name || scopeName || "Group",
      };
    }
    if (type === "coalition") {
      const c = (coalitions || []).find(
        (x) => safeString(x.id) === safeString(scopeId)
      );
      return {
        type: "coalition",
        id: scopeId,
        name: c?.name || scopeName || "Coalition",
      };
    }
    return { type: "direct" };
  }, [scopeType, scopeId, scopeName, groups, coalitions, actor]);

  const canSend = useMemo(() => {
    if (!planId || !activePlan) return false;
    if (scopeType === "direct") return recipients.length > 0;
    return true;
  }, [planId, activePlan, scopeType, recipients]);

  const buildPreview = () => {
    setStatus({ busy: true, msg: "Building preview…", error: "" });
    try {
      const built = GardenPlanShareService.buildSharePacket({
        mode,
        planId,
        scope: computedScope,
        recipients: scopeType === "direct" ? recipients : [], // scope share doesn't require direct list
        permissions,
        scrub,
        actor: actor || {},
        meta: {
          title: metaTitle,
          notes: metaNotes,
          tags: metaTags
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        },
        schedule: mode === "assignment" ? schedule : undefined,
      });
      if (!built?.ok) {
        setStatus({
          busy: false,
          msg: "",
          error: safeString(built?.error || "Failed to build preview"),
        });
        setPreview(null);
        return;
      }
      setPreview(built.packet);
      setStatus({ busy: false, msg: "Preview ready.", error: "" });
      emit("ui/toast", {
        variant: "success",
        title: "Preview ready",
        message: "Packet prepared for sharing.",
      });
    } catch (e) {
      setStatus({ busy: false, msg: "", error: String(e?.message || e) });
      setPreview(null);
    }
  };

  const doSend = async () => {
    setStatus({ busy: true, msg: "Sending…", error: "" });
    try {
      const res = await GardenPlanShareService.sendShare({
        mode,
        planId,
        scope: computedScope,
        recipients: scopeType === "direct" ? recipients : [],
        permissions,
        scrub,
        actor: actor || {},
        meta: {
          title: metaTitle,
          notes: metaNotes,
          tags: metaTags
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        },
        schedule: mode === "assignment" ? schedule : undefined,
      });

      if (!res?.ok) {
        setStatus({
          busy: false,
          msg: "",
          error: safeString(res?.error || "Send failed"),
        });
        emit("ui/toast", {
          variant: "error",
          title: "Share failed",
          message: safeString(res?.error || "Send failed"),
        });
        return;
      }

      setStatus({
        busy: false,
        msg: `Shared (${res.status || "queued"}).`,
        error: "",
      });
      setPreview(res.packet || preview);
      emit("ui/toast", {
        variant: "success",
        title: "Shared",
        message: `Packet ${res.status || "queued"} in outbox.`,
      });
    } catch (e) {
      setStatus({ busy: false, msg: "", error: String(e?.message || e) });
      emit("ui/toast", {
        variant: "error",
        title: "Share failed",
        message: String(e?.message || e),
      });
    }
  };

  const doCopyJSON = async () => {
    if (!preview) return;
    const ok = await copyToClipboard(JSON.stringify(preview, null, 2));
    emit("ui/toast", {
      variant: ok ? "success" : "error",
      title: ok ? "Copied" : "Copy failed",
      message: ok
        ? "Share packet JSON copied to clipboard."
        : "Could not copy to clipboard.",
    });
  };

  const doDownloadJSON = () => {
    if (!preview) return;
    const base = mode === "assignment" ? "garden-schedule" : "garden-plan";
    downloadJSON(`${base}-share-packet.json`, preview);
    emit("ui/toast", {
      variant: "success",
      title: "Downloaded",
      message: "Share packet JSON downloaded.",
    });
  };

  const addRecipient = (r) => {
    if (!r?.id) return;
    setRecipients((prev) => {
      const next = Array.isArray(prev) ? prev.slice() : [];
      const key = `${r.type}:${r.id}`;
      if (next.some((x) => `${x.type}:${x.id}` === key)) return next;
      next.push({ type: r.type, id: r.id, label: r.label || "" });
      return next;
    });
  };

  const removeRecipient = (type, id) => {
    setRecipients((prev) =>
      (prev || []).filter((r) => !(r.type === type && r.id === id))
    );
  };

  const onOverlayClick = (e) => {
    if (e.target === e.currentTarget) {
      // click outside
      if (onClose) onClose();
      else setInternalOpen(false);
      emit("ui/modalClose", { id: "GardenPlanShareModal" });
    }
  };

  const close = () => {
    if (onClose) onClose();
    else setInternalOpen(false);
    emit("ui/modalClose", { id: "GardenPlanShareModal" });
  };

  useEffect(() => {
    if (!isOpen) return;
    // focus close button for accessibility
    setTimeout(() => {
      try {
        closeBtnRef.current?.focus?.();
      } catch {}
    }, 50);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      style={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="Share Garden Plan"
      onMouseDown={onOverlayClick}
    >
      <div style={styles.modal}>
        <div style={styles.header}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>
              Share Garden Plan
            </div>
            <div style={styles.small}>
              Share as assignment (schedule), collaborative plan, or template —
              to household, small group, or coalition.
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              ref={closeBtnRef}
              style={styles.btn("ghost")}
              onClick={close}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        <div style={styles.body}>
          {/* Plan + Mode */}
          <div style={styles.grid2}>
            <div style={styles.section}>
              <div style={styles.label}>Plan</div>
              <select
                style={styles.input}
                value={planId}
                onChange={(e) => {
                  setPlanId(e.target.value);
                  setPreview(null);
                  setStatus({ busy: false, msg: "", error: "" });
                }}
              >
                <option value="" disabled>
                  Select a plan…
                </option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.year}
                  </option>
                ))}
              </select>
              <div style={{ ...styles.small, marginTop: 8 }}>
                {activePlan ? (
                  <>
                    <div>
                      <b>Selected:</b> {activePlan.name} ({activePlan.year})
                    </div>
                    <div>
                      Beds: {activePlan.beds?.length || 0} • Crops:{" "}
                      {activePlan.crops?.length || 0} • Tasks:{" "}
                      {activePlan.tasks?.length || 0}
                    </div>
                  </>
                ) : (
                  <span style={{ opacity: 0.8 }}>Pick a plan to share.</span>
                )}
              </div>
            </div>

            <div style={styles.section}>
              <div style={styles.label}>Share Mode</div>
              <div style={styles.pillRow}>
                <div
                  style={styles.pill(mode === "assignment")}
                  onClick={() => setMode("assignment")}
                >
                  Assignment (Schedule)
                </div>
                <div
                  style={styles.pill(mode === "collaborative")}
                  onClick={() => setMode("collaborative")}
                >
                  Collaborative (Plan)
                </div>
                <div
                  style={styles.pill(mode === "template")}
                  onClick={() => setMode("template")}
                >
                  Template (Starter)
                </div>
              </div>
              <div style={{ ...styles.small, marginTop: 8 }}>
                {mode === "assignment" && (
                  <span>
                    Send a read-only task packet with supplies + “do not do”
                    constraints. Great for helpers.
                  </span>
                )}
                {mode === "collaborative" && (
                  <span>
                    Send the plan source-of-truth so others can import and work
                    jointly (merge workflow later).
                  </span>
                )}
                {mode === "template" && (
                  <span>
                    Send a scrubbed starter plan (no history/status/identity)
                    for others to import and customize.
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Scope + Recipients */}
          <div style={styles.grid2}>
            <div style={styles.section}>
              <div style={styles.label}>Share Scope</div>
              <select
                style={styles.input}
                value={scopeType}
                onChange={(e) => {
                  const next = e.target.value;
                  setScopeType(next);
                  setScopeId("");
                  setScopeName("");
                  setRecipients([]);
                  setPreview(null);
                }}
              >
                {scopeOptions.map((o) => (
                  <option key={o.type} value={o.type}>
                    {o.label}
                  </option>
                ))}
              </select>

              {scopeType === "group" && (
                <div style={{ marginTop: 10 }}>
                  <div style={styles.label}>Choose Group</div>
                  <select
                    style={styles.input}
                    value={scopeId}
                    onChange={(e) => {
                      setScopeId(e.target.value);
                      setPreview(null);
                    }}
                  >
                    <option value="" disabled>
                      Select group…
                    </option>
                    {(groups || []).map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {scopeType === "coalition" && (
                <div style={{ marginTop: 10 }}>
                  <div style={styles.label}>Choose Coalition</div>
                  <select
                    style={styles.input}
                    value={scopeId}
                    onChange={(e) => {
                      setScopeId(e.target.value);
                      setPreview(null);
                    }}
                  >
                    <option value="" disabled>
                      Select coalition…
                    </option>
                    {(coalitions || []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {scopeType === "direct" && (
                <div style={{ marginTop: 10 }}>
                  <div style={styles.label}>Recipients (direct)</div>

                  <div style={{ display: "grid", gap: 10 }}>
                    <div style={styles.small}>
                      Add households, roles, or members who should receive this
                      packet.
                    </div>

                    <div style={styles.grid3}>
                      <div>
                        <div style={styles.label}>Households</div>
                        <select
                          style={styles.input}
                          defaultValue=""
                          onChange={(e) => {
                            const id = e.target.value;
                            const h = (households || []).find(
                              (x) => safeString(x.id) === safeString(id)
                            );
                            if (id)
                              addRecipient({
                                type: "household",
                                id,
                                label: h?.label || "",
                              });
                            e.target.value = "";
                          }}
                        >
                          <option value="">Add…</option>
                          {(households || []).map((h) => (
                            <option key={h.id} value={h.id}>
                              {h.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <div style={styles.label}>Roles</div>
                        <select
                          style={styles.input}
                          defaultValue=""
                          onChange={(e) => {
                            const id = e.target.value;
                            const r = (roles || []).find(
                              (x) => safeString(x.id) === safeString(id)
                            );
                            if (id)
                              addRecipient({
                                type: "role",
                                id,
                                label: r?.label || "",
                              });
                            e.target.value = "";
                          }}
                        >
                          <option value="">Add…</option>
                          {(roles || []).map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <div style={styles.label}>Manual ID</div>
                        <input
                          style={styles.input}
                          placeholder="type:id (e.g. household:hh_123)"
                          onKeyDown={(e) => {
                            if (e.key !== "Enter") return;
                            const raw = safeString(
                              e.currentTarget.value
                            ).trim();
                            if (!raw) return;
                            const [type, id] = raw.includes(":")
                              ? raw.split(":")
                              : ["household", raw];
                            addRecipient({ type, id, label: "" });
                            e.currentTarget.value = "";
                          }}
                        />
                        <div style={{ ...styles.small, marginTop: 6 }}>
                          Press Enter to add.
                        </div>
                      </div>
                    </div>

                    {!!recipients.length && (
                      <div>
                        <div style={styles.label}>Selected recipients</div>
                        <div style={styles.pillRow}>
                          {recipients.map((r) => (
                            <div
                              key={`${r.type}:${r.id}`}
                              style={styles.pill(true)}
                            >
                              <span style={{ opacity: 0.9 }}>
                                {r.type}:{r.label || r.id}
                              </span>
                              <span
                                style={{
                                  marginLeft: 10,
                                  opacity: 0.9,
                                  cursor: "pointer",
                                }}
                                onClick={() => removeRecipient(r.type, r.id)}
                                title="Remove"
                              >
                                ✕
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Options */}
            <div style={styles.section}>
              <div style={styles.label}>Options</div>

              <div style={{ display: "grid", gap: 10 }}>
                <div>
                  <div style={styles.label}>Title</div>
                  <input
                    style={styles.input}
                    value={metaTitle}
                    onChange={(e) => setMetaTitle(e.target.value)}
                  />
                </div>

                <div>
                  <div style={styles.label}>Notes / Instructions</div>
                  <textarea
                    style={styles.textarea}
                    value={metaNotes}
                    onChange={(e) => setMetaNotes(e.target.value)}
                    placeholder="Add instructions (preferred supplies, gate code, where tools are kept, etc.)"
                  />
                </div>

                <div>
                  <div style={styles.label}>Tags (comma-separated)</div>
                  <input
                    style={styles.input}
                    value={metaTags}
                    onChange={(e) => setMetaTags(e.target.value)}
                    placeholder="spring, beds, harvest, irrigation"
                  />
                </div>

                {mode === "assignment" && (
                  <>
                    <div style={styles.divider} />
                    <div style={{ display: "grid", gap: 10 }}>
                      <div style={styles.label}>Schedule range</div>
                      <div style={styles.grid2}>
                        <div>
                          <div style={styles.label}>From</div>
                          <input
                            style={styles.input}
                            type="date"
                            value={schedule?.fromDayKey || ""}
                            onChange={(e) =>
                              setSchedule((prev) => ({
                                ...(prev || {}),
                                fromDayKey: e.target.value,
                              }))
                            }
                          />
                        </div>
                        <div>
                          <div style={styles.label}>To</div>
                          <input
                            style={styles.input}
                            type="date"
                            value={schedule?.toDayKey || ""}
                            onChange={(e) =>
                              setSchedule((prev) => ({
                                ...(prev || {}),
                                toDayKey: e.target.value,
                              }))
                            }
                          />
                        </div>
                      </div>

                      <div style={styles.grid2}>
                        <label
                          style={{
                            ...styles.small,
                            display: "flex",
                            gap: 8,
                            alignItems: "center",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={!!schedule?.includeCompleted}
                            onChange={(e) =>
                              setSchedule((prev) => ({
                                ...(prev || {}),
                                includeCompleted: e.target.checked,
                              }))
                            }
                          />
                          Include completed tasks
                        </label>
                        <label
                          style={{
                            ...styles.small,
                            display: "flex",
                            gap: 8,
                            alignItems: "center",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={!!schedule?.includeSkipped}
                            onChange={(e) =>
                              setSchedule((prev) => ({
                                ...(prev || {}),
                                includeSkipped: e.target.checked,
                              }))
                            }
                          />
                          Include skipped tasks
                        </label>
                      </div>
                    </div>
                  </>
                )}

                {/* Scrub toggles */}
                <div style={styles.divider} />
                <div style={{ display: "grid", gap: 8 }}>
                  <div style={styles.label}>Scrub / Privacy</div>

                  <label
                    style={{
                      ...styles.small,
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={scrub?.scrubIdentity !== false}
                      onChange={(e) =>
                        setScrub((prev) => ({
                          ...(prev || {}),
                          scrubIdentity: e.target.checked,
                        }))
                      }
                    />
                    Scrub identity (household/member IDs)
                  </label>

                  {mode === "assignment" && (
                    <>
                      <label
                        style={{
                          ...styles.small,
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={scrub?.includeConstraints !== false}
                          onChange={(e) =>
                            setScrub((prev) => ({
                              ...(prev || {}),
                              includeConstraints: e.target.checked,
                            }))
                          }
                        />
                        Include constraints (do-not + preferred supplies)
                      </label>
                      <label
                        style={{
                          ...styles.small,
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={scrub?.includeSupplies !== false}
                          onChange={(e) =>
                            setScrub((prev) => ({
                              ...(prev || {}),
                              includeSupplies: e.target.checked,
                            }))
                          }
                        />
                        Include supplies list
                      </label>
                      <label
                        style={{
                          ...styles.small,
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={scrub?.stripStatus !== false}
                          onChange={(e) =>
                            setScrub((prev) => ({
                              ...(prev || {}),
                              stripStatus: e.target.checked,
                            }))
                          }
                        />
                        Strip status flags (done/skipped)
                      </label>
                    </>
                  )}

                  {mode === "template" && (
                    <>
                      <label
                        style={{
                          ...styles.small,
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={!!scrub?.keepPlanNotes}
                          onChange={(e) =>
                            setScrub((prev) => ({
                              ...(prev || {}),
                              keepPlanNotes: e.target.checked,
                            }))
                          }
                        />
                        Keep plan notes
                      </label>
                      <label
                        style={{
                          ...styles.small,
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={!!scrub?.keepTaskNotes}
                          onChange={(e) =>
                            setScrub((prev) => ({
                              ...(prev || {}),
                              keepTaskNotes: e.target.checked,
                            }))
                          }
                        />
                        Keep task notes
                      </label>
                      <label
                        style={{
                          ...styles.small,
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={!!scrub?.keepBlackouts}
                          onChange={(e) =>
                            setScrub((prev) => ({
                              ...(prev || {}),
                              keepBlackouts: e.target.checked,
                            }))
                          }
                        />
                        Keep blackout dates
                      </label>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Preview */}
          <div style={styles.section}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 12,
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 800 }}>Preview</div>
                <div style={styles.small}>
                  Build a packet preview first. Then copy JSON, download, or
                  send to outbox.
                </div>
              </div>
              <div style={styles.btnRow}>
                <button
                  style={styles.btn("primary")}
                  onClick={buildPreview}
                  disabled={!planId || !activePlan || status.busy}
                  title="Build preview packet"
                >
                  Build Preview
                </button>
                <button
                  style={styles.btn("primary")}
                  onClick={doSend}
                  disabled={!canSend || status.busy}
                  title="Send share packet (stored to outbox)"
                >
                  Send / Queue
                </button>
                <button
                  style={styles.btn()}
                  onClick={doCopyJSON}
                  disabled={!preview || status.busy}
                >
                  Copy JSON
                </button>
                <button
                  style={styles.btn()}
                  onClick={doDownloadJSON}
                  disabled={!preview || status.busy}
                >
                  Download JSON
                </button>
                <button
                  style={styles.btn("danger")}
                  onClick={close}
                  disabled={status.busy}
                >
                  Close
                </button>
              </div>
            </div>

            {!!status.error && (
              <div
                style={{
                  marginTop: 10,
                  ...styles.small,
                  color: "rgba(239,68,68,0.95)",
                }}
              >
                <b>Error:</b> {status.error}
              </div>
            )}
            {!!status.msg && !status.error && (
              <div
                style={{
                  marginTop: 10,
                  ...styles.small,
                  color: "rgba(34,197,94,0.95)",
                }}
              >
                {status.msg}
              </div>
            )}

            <div style={{ marginTop: 12, ...styles.previewBox }}>
              {preview ? (
                <pre style={styles.mono}>
                  {JSON.stringify(preview, null, 2)}
                </pre>
              ) : (
                <div style={styles.small}>
                  No preview yet. Click <b>Build Preview</b>.
                </div>
              )}
            </div>

            <div style={{ marginTop: 10, ...styles.small, opacity: 0.85 }}>
              <b>Tip:</b> If your app has a central “Share Outbox” page, you can
              list queued packets using{" "}
              <span style={styles.mono}>
                GardenPlanShareService.listOutbox()
              </span>
              .
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
