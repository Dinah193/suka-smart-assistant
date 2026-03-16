// File: src/components/scheduler/SaveScheduleModal.jsx
// Production-ready, dependency-light modal for saving a schedule pattern.
// - No shadcn/radix dependency required.
// - Tries to use your UI primitives if present (Button/Input/Label/Card) and
//   falls back to minimal built-ins if they aren't.
// - Optional eventBus emission (safe no-op if not present).
// - Optional localStorage draft persistence.
// - Save is handled by injected onSave(payload) for Dexie/server/etc.

import React, { useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------ tiny utilities ------------------------------ */
function cn(...parts) {
  return parts
    .flatMap((p) => (Array.isArray(p) ? p : [p]))
    .filter(Boolean)
    .join(" ");
}

function safeJsonParse(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function uid(prefix = "sched") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getTZ() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function parseTags(str) {
  return String(str || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function stringifyTags(tags) {
  return Array.isArray(tags) ? tags.join(", ") : "";
}

/* -------------------------- optional deps (safe) --------------------------- */
async function loadEventBus() {
  try {
    const m = await import("@/services/events/eventBus");
    return m?.default || m?.eventBus || m;
  } catch {
    try {
      const m2 = await import("@/services/events/eventBus.js");
      return m2?.default || m2?.eventBus || m2;
    } catch {
      return null;
    }
  }
}

/* ------------------------------- UI fallbacks ------------------------------ */
let Button = null;
let Input = null;
let Label = null;
let Card = null;
let CardHeader = null;
let CardContent = null;
let CardFooter = null;

function FallbackButton({ className, variant = "default", ...props }) {
  const base =
    "inline-flex items-center justify-center rounded-md text-sm font-medium transition " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 " +
    "disabled:pointer-events-none disabled:opacity-50";
  const variants = {
    default: "bg-slate-900 text-white hover:bg-slate-800 px-4 py-2",
    secondary: "bg-slate-100 text-slate-900 hover:bg-slate-200 px-4 py-2",
    outline:
      "border border-slate-300 bg-white text-slate-900 hover:bg-slate-50 px-4 py-2",
    destructive: "bg-red-600 text-white hover:bg-red-700 px-4 py-2",
    ghost: "bg-transparent hover:bg-slate-100 text-slate-900 px-3 py-2",
    link: "bg-transparent underline text-slate-900 hover:text-slate-700 p-0",
  };
  return (
    <button
      className={cn(base, variants[variant] || variants.default, className)}
      {...props}
    />
  );
}

function FallbackInput({ className, ...props }) {
  return (
    <input
      className={cn(
        "flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm",
        "placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}

function FallbackLabel({ className, ...props }) {
  return (
    <label
      className={cn(
        "text-sm font-medium leading-none text-slate-900",
        "peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className
      )}
      {...props}
    />
  );
}

function FallbackCard({ className, ...props }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-slate-200 bg-white shadow-sm",
        className
      )}
      {...props}
    />
  );
}
function FallbackCardHeader({ className, ...props }) {
  return (
    <div
      className={cn("p-4 border-b border-slate-100", className)}
      {...props}
    />
  );
}
function FallbackCardContent({ className, ...props }) {
  return <div className={cn("p-4", className)} {...props} />;
}
function FallbackCardFooter({ className, ...props }) {
  return (
    <div
      className={cn("p-4 border-t border-slate-100", className)}
      {...props}
    />
  );
}

async function loadUIPrimitives() {
  try {
    const b = await import("@/components/ui/button");
    Button = b?.Button || b?.default || null;
  } catch {}
  try {
    const i = await import("@/components/ui/input");
    Input = i?.Input || i?.default || null;
  } catch {}
  try {
    const l = await import("@/components/ui/label");
    Label = l?.Label || l?.default || null;
  } catch {}
  try {
    const c = await import("@/components/ui/card");
    Card = c?.Card || c?.default || null;
    CardHeader = c?.CardHeader || null;
    CardContent = c?.CardContent || null;
    CardFooter = c?.CardFooter || null;
  } catch {}

  if (!Button) Button = FallbackButton;
  if (!Input) Input = FallbackInput;
  if (!Label) Label = FallbackLabel;
  if (!Card) Card = FallbackCard;
  if (!CardHeader) CardHeader = FallbackCardHeader;
  if (!CardContent) CardContent = FallbackCardContent;
  if (!CardFooter) CardFooter = FallbackCardFooter;
}

/* ------------------------------ Modal UI bits ------------------------------ */
const WEEKDAY = [
  { key: 0, label: "Sun" },
  { key: 1, label: "Mon" },
  { key: 2, label: "Tue" },
  { key: 3, label: "Wed" },
  { key: 4, label: "Thu" },
  { key: 5, label: "Fri" },
  { key: 6, label: "Sat" },
];

function Backdrop({ onClick }) {
  return (
    <div
      className="fixed inset-0 z-[70] bg-black/50 backdrop-blur-[1px]"
      onMouseDown={onClick}
    />
  );
}

function ModalShell({ children }) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="w-full max-w-3xl">{children}</div>
    </div>
  );
}

function TogglePill({ checked, onChange, label, disabled }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition",
        checked
          ? "border-slate-900 bg-slate-900 text-white"
          : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50",
        disabled && "opacity-50 cursor-not-allowed"
      )}
      aria-pressed={checked ? "true" : "false"}
    >
      <span
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          checked ? "bg-white" : "bg-slate-300"
        )}
      />
      {label}
    </button>
  );
}

/* ------------------------------ Defaults & helpers ------------------------- */
const DEFAULT_PATTERN = {
  kind: "weekly", // weekly | rrule | fixed | adhoc
  weekly: { days: [1, 3, 5], time: "09:00", note: "" },
  rrule: { rule: "FREQ=WEEKLY;BYDAY=MO,WE,FR", time: "09:00" },
  fixed: { dates: [{ month: 1, day: 15 }], time: "09:00" },
};

const DEFAULT_NOTIFS = {
  enabled: true,
  leadMinutes: 10,
  channels: { toast: true, sound: false, voice: false },
};

const DEFAULT_GUARDS = {
  sabbathGuard: true,
  quietHoursPolicy: "respect", // respect | ignore | warn
};

function normalizeInitial(initial, context) {
  const tz = initial?.timezone || context?.timezone || getTZ();
  const domain = initial?.domain || context?.domain || "general";

  return {
    id: initial?.id || uid("schedule"),
    name: initial?.name || "",
    description: initial?.description || "",
    tags: Array.isArray(initial?.tags) ? initial.tags : [],
    domain,
    timezone: tz,
    startDate: initial?.startDate || todayISO(),
    endDate: initial?.endDate || "",
    pattern: {
      ...DEFAULT_PATTERN,
      ...(initial?.pattern || {}),
      weekly: {
        ...DEFAULT_PATTERN.weekly,
        ...(initial?.pattern?.weekly || {}),
      },
      rrule: { ...DEFAULT_PATTERN.rrule, ...(initial?.pattern?.rrule || {}) },
      fixed: { ...DEFAULT_PATTERN.fixed, ...(initial?.pattern?.fixed || {}) },
    },
    ...DEFAULT_GUARDS,
    ...(initial?.sabbathGuard !== undefined
      ? { sabbathGuard: !!initial.sabbathGuard }
      : {}),
    ...(initial?.quietHoursPolicy
      ? { quietHoursPolicy: initial.quietHoursPolicy }
      : {}),
    notifications: {
      ...DEFAULT_NOTIFS,
      ...(initial?.notifications || {}),
      channels: {
        ...DEFAULT_NOTIFS.channels,
        ...(initial?.notifications?.channels || {}),
      },
    },
    meta: {
      ...(initial?.meta || {}),
      source: initial?.meta?.source || "SaveScheduleModal",
      createdAt: initial?.meta?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

function validateDraft(draft) {
  const errors = {};
  if (!draft?.name?.trim()) errors.name = "Name is required.";
  if (!draft?.pattern?.kind) errors.kind = "Schedule type is required.";

  const kind = draft?.pattern?.kind;

  if (kind === "weekly") {
    const days = draft?.pattern?.weekly?.days || [];
    if (!Array.isArray(days) || days.length === 0) {
      errors.weeklyDays = "Select at least one weekday.";
    }
    if (!draft?.pattern?.weekly?.time) errors.weeklyTime = "Time is required.";
  }

  if (kind === "rrule") {
    if (!draft?.pattern?.rrule?.rule?.trim())
      errors.rrule = "RRULE is required.";
    if (!draft?.pattern?.rrule?.time) errors.rruleTime = "Time is required.";
  }

  if (kind === "fixed") {
    const dates = draft?.pattern?.fixed?.dates || [];
    if (!Array.isArray(dates) || dates.length === 0) {
      errors.fixedDates = "Add at least one fixed date.";
    } else {
      for (const d of dates) {
        if (!d || !d.month || !d.day) {
          errors.fixedDates = "Each fixed date needs month and day.";
          break;
        }
      }
    }
    if (!draft?.pattern?.fixed?.time) errors.fixedTime = "Time is required.";
  }

  return errors;
}

/* ---------------------------------- Component ------------------------------ */
export default function SaveScheduleModal({
  open = false,
  onOpenChange,
  initial = null,
  context = null,

  onSave, // async (payload) => savedPayload

  title = "Save schedule",
  subtitle = "Name your schedule and choose how it repeats.",
  storageKey,
  allowLocalDraft = true,
  emitEvents = true,
}) {
  const [ready, setReady] = useState(false);
  const [eventBus, setEventBus] = useState(null);

  const computedStorageKey = useMemo(() => {
    if (storageKey) return storageKey;
    const dom = context?.domain || initial?.domain || "general";
    const hid = context?.householdId ? `:${context.householdId}` : "";
    return `ssa:scheduler:saveScheduleDraft:${dom}${hid}`;
  }, [storageKey, context?.domain, context?.householdId, initial?.domain]);

  const [draft, setDraft] = useState(() => normalizeInitial(initial, context));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null);

  const firstFieldRef = useRef(null);
  const lastActiveElementRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      await loadUIPrimitives();
      const eb = await loadEventBus();
      if (!alive) return;
      setEventBus(eb || null);
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;

    lastActiveElementRef.current = document.activeElement;

    if (allowLocalDraft) {
      const stored = safeJsonParse(
        localStorage.getItem(computedStorageKey),
        null
      );
      if (stored && typeof stored === "object") {
        setDraft((prev) => normalizeInitial({ ...prev, ...stored }, context));
      } else {
        setDraft(normalizeInitial(initial, context));
      }
    } else {
      setDraft(normalizeInitial(initial, context));
    }

    setErrors({});
    setSaveResult(null);

    setTimeout(() => {
      firstFieldRef.current?.focus?.();
    }, 0);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow || "";
      const el = lastActiveElementRef.current;
      if (el && typeof el.focus === "function") el.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!allowLocalDraft) return;
    localStorage.setItem(computedStorageKey, JSON.stringify(draft));
  }, [draft, open, allowLocalDraft, computedStorageKey]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
      if (e.key === "Tab") {
        const root = document.getElementById("ssa-save-schedule-modal");
        if (!root) return;
        const focusable = root.querySelectorAll(
          'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])'
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, { passive: false });
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function emit(name, payload) {
    if (!emitEvents) return;
    try {
      if (eventBus?.emit) eventBus.emit(name, payload);
    } catch {
      // ignore
    }
  }

  function handleClose() {
    onOpenChange?.(false);
  }

  function setField(path, value) {
    setDraft((prev) => {
      const next = structuredClone(prev);
      const parts = path.split(".");
      let obj = next;
      for (let i = 0; i < parts.length - 1; i++) {
        obj[parts[i]] = obj[parts[i]] ?? {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = value;
      next.meta = next.meta || {};
      next.meta.updatedAt = new Date().toISOString();
      return next;
    });
  }

  function toggleWeekday(dayKey) {
    const days = new Set(draft.pattern.weekly.days || []);
    if (days.has(dayKey)) days.delete(dayKey);
    else days.add(dayKey);
    setField(
      "pattern.weekly.days",
      Array.from(days).sort((a, b) => a - b)
    );
  }

  function addFixedDate() {
    const dates = Array.isArray(draft.pattern.fixed.dates)
      ? [...draft.pattern.fixed.dates]
      : [];
    dates.push({ month: 1, day: 1 });
    setField("pattern.fixed.dates", dates);
  }

  function updateFixedDate(idx, field, val) {
    const dates = Array.isArray(draft.pattern.fixed.dates)
      ? [...draft.pattern.fixed.dates]
      : [];
    const d = { ...(dates[idx] || {}) };
    if (field === "month")
      d.month = Math.max(1, Math.min(12, Number(val || 1)));
    if (field === "day") d.day = Math.max(1, Math.min(31, Number(val || 1)));
    dates[idx] = d;
    setField("pattern.fixed.dates", dates);
  }

  function removeFixedDate(idx) {
    const dates = Array.isArray(draft.pattern.fixed.dates)
      ? [...draft.pattern.fixed.dates]
      : [];
    dates.splice(idx, 1);
    setField("pattern.fixed.dates", dates);
  }

  async function handleSave() {
    const v = validateDraft(draft);
    setErrors(v);
    if (Object.keys(v).length) return;

    setSaving(true);
    setSaveResult(null);
    emit("schedule.save.attempt", { id: draft.id, domain: draft.domain });

    try {
      const payload = {
        ...draft,
        tags: Array.isArray(draft.tags) ? draft.tags : parseTags(draft.tags),
        meta: { ...(draft.meta || {}), updatedAt: new Date().toISOString() },
      };

      const saved = (await onSave?.(payload)) || payload;

      if (allowLocalDraft) localStorage.removeItem(computedStorageKey);

      setSaveResult({ ok: true });
      emit("schedule.saved", { id: saved.id, domain: saved.domain, saved });

      setTimeout(() => {
        onOpenChange?.(false);
      }, 100);
    } catch (e) {
      const msg =
        e?.message ||
        "Save failed. Please check your persistence hook (onSave).";
      setSaveResult({ ok: false, message: msg });
      emit("schedule.save.failed", {
        id: draft.id,
        domain: draft.domain,
        error: msg,
      });
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    const fresh = normalizeInitial(initial, context);
    setDraft(fresh);
    setErrors({});
    setSaveResult(null);
    if (allowLocalDraft) localStorage.removeItem(computedStorageKey);
    emit("schedule.draft.reset", { id: fresh.id, domain: fresh.domain });
  }

  if (!open) return null;

  if (!ready) {
    return (
      <>
        <Backdrop onClick={handleClose} />
        <ModalShell>
          <FallbackCard className="p-6">
            <div className="text-sm text-slate-600">Loading…</div>
          </FallbackCard>
        </ModalShell>
      </>
    );
  }

  const Btn = Button || FallbackButton;
  const Inp = Input || FallbackInput;
  const Lab = Label || FallbackLabel;

  return (
    <>
      <Backdrop onClick={handleClose} />
      <ModalShell>
        <Card id="ssa-save-schedule-modal" role="dialog" aria-modal="true">
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-lg font-semibold text-slate-900">
                  {title}
                </div>
                <div className="mt-1 text-sm text-slate-600">{subtitle}</div>
              </div>
              <Btn
                type="button"
                variant="ghost"
                onClick={handleClose}
                aria-label="Close"
                className="rounded-full"
              >
                ✕
              </Btn>
            </div>
          </CardHeader>

          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* Left: identity */}
              <div className="space-y-4">
                <div className="space-y-1">
                  <Lab htmlFor="sched-name">Name</Lab>
                  <Inp
                    id="sched-name"
                    ref={firstFieldRef}
                    value={draft.name}
                    onChange={(e) => setField("name", e.target.value)}
                    placeholder="e.g., Mon/Wed/Fri Deep Clean"
                    className={cn(errors.name && "border-red-400")}
                  />
                  {errors.name ? (
                    <div className="text-xs text-red-600">{errors.name}</div>
                  ) : null}
                </div>

                <div className="space-y-1">
                  <Lab htmlFor="sched-desc">Description (optional)</Lab>
                  <textarea
                    id="sched-desc"
                    value={draft.description}
                    onChange={(e) => setField("description", e.target.value)}
                    placeholder="Short note about what this schedule does…"
                    className={cn(
                      "min-h-[84px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm",
                      "placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400"
                    )}
                  />
                </div>

                <div className="space-y-1">
                  <Lab htmlFor="sched-tags">Tags (comma-separated)</Lab>
                  <Inp
                    id="sched-tags"
                    value={stringifyTags(draft.tags)}
                    onChange={(e) =>
                      setField("tags", parseTags(e.target.value))
                    }
                    placeholder="e.g., kitchen, weekly, rotation"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Lab htmlFor="sched-domain">Domain</Lab>
                    <select
                      id="sched-domain"
                      value={draft.domain}
                      onChange={(e) => setField("domain", e.target.value)}
                      className={cn(
                        "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm",
                        "focus:outline-none focus:ring-2 focus:ring-slate-400"
                      )}
                    >
                      <option value="general">general</option>
                      <option value="cleaning">cleaning</option>
                      <option value="cooking">cooking</option>
                      <option value="garden">garden</option>
                      <option value="animals">animals</option>
                      <option value="storehouse">storehouse</option>
                      <option value="mealplanning">mealplanning</option>
                      <option value="calendar">calendar</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <Lab htmlFor="sched-tz">Timezone</Lab>
                    <Inp
                      id="sched-tz"
                      value={draft.timezone}
                      onChange={(e) => setField("timezone", e.target.value)}
                      placeholder="America/Chicago"
                    />
                    <div className="text-[11px] text-slate-500">
                      Default: {getTZ()}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Lab htmlFor="sched-start">Start date</Lab>
                    <Inp
                      id="sched-start"
                      type="date"
                      value={draft.startDate}
                      onChange={(e) => setField("startDate", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Lab htmlFor="sched-end">End date (optional)</Lab>
                    <Inp
                      id="sched-end"
                      type="date"
                      value={draft.endDate || ""}
                      onChange={(e) => setField("endDate", e.target.value)}
                    />
                  </div>
                </div>
              </div>

              {/* Right: pattern + policies */}
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="text-sm font-semibold text-slate-900">
                    Repeat pattern
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { v: "weekly", l: "Weekly" },
                      { v: "rrule", l: "Advanced (RRULE)" },
                      { v: "fixed", l: "Fixed dates" },
                      { v: "adhoc", l: "Ad-hoc" },
                    ].map((k) => (
                      <TogglePill
                        key={k.v}
                        checked={draft.pattern.kind === k.v}
                        onChange={() => setField("pattern.kind", k.v)}
                        label={k.l}
                      />
                    ))}
                  </div>
                </div>

                {draft.pattern.kind === "weekly" ? (
                  <div className="rounded-lg border border-slate-200 p-4 space-y-3">
                    <div className="text-sm font-semibold text-slate-900">
                      Weekly settings
                    </div>

                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-700">
                        Days of week
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {WEEKDAY.map((d) => (
                          <TogglePill
                            key={d.key}
                            checked={(draft.pattern.weekly.days || []).includes(
                              d.key
                            )}
                            onChange={() => toggleWeekday(d.key)}
                            label={d.label}
                          />
                        ))}
                      </div>
                      {errors.weeklyDays ? (
                        <div className="text-xs text-red-600">
                          {errors.weeklyDays}
                        </div>
                      ) : null}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Lab htmlFor="weekly-time">Time</Lab>
                        <Inp
                          id="weekly-time"
                          type="time"
                          value={draft.pattern.weekly.time || ""}
                          onChange={(e) =>
                            setField("pattern.weekly.time", e.target.value)
                          }
                          className={cn(errors.weeklyTime && "border-red-400")}
                        />
                        {errors.weeklyTime ? (
                          <div className="text-xs text-red-600">
                            {errors.weeklyTime}
                          </div>
                        ) : null}
                      </div>
                      <div className="space-y-1">
                        <Lab htmlFor="weekly-note">Notes</Lab>
                        <Inp
                          id="weekly-note"
                          value={draft.pattern.weekly.note || ""}
                          onChange={(e) =>
                            setField("pattern.weekly.note", e.target.value)
                          }
                          placeholder="optional"
                        />
                      </div>
                    </div>
                  </div>
                ) : null}

                {draft.pattern.kind === "rrule" ? (
                  <div className="rounded-lg border border-slate-200 p-4 space-y-3">
                    <div className="text-sm font-semibold text-slate-900">
                      Advanced RRULE
                    </div>
                    <div className="text-xs text-slate-500">
                      Example:{" "}
                      <span className="font-mono">
                        FREQ=WEEKLY;BYDAY=MO,WE,FR
                      </span>
                    </div>

                    <div className="space-y-1">
                      <Lab htmlFor="rrule-rule">RRULE</Lab>
                      <Inp
                        id="rrule-rule"
                        value={draft.pattern.rrule.rule || ""}
                        onChange={(e) =>
                          setField("pattern.rrule.rule", e.target.value)
                        }
                        placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR"
                        className={cn(errors.rrule && "border-red-400")}
                      />
                      {errors.rrule ? (
                        <div className="text-xs text-red-600">
                          {errors.rrule}
                        </div>
                      ) : null}
                    </div>

                    <div className="space-y-1">
                      <Lab htmlFor="rrule-time">Time</Lab>
                      <Inp
                        id="rrule-time"
                        type="time"
                        value={draft.pattern.rrule.time || ""}
                        onChange={(e) =>
                          setField("pattern.rrule.time", e.target.value)
                        }
                        className={cn(errors.rruleTime && "border-red-400")}
                      />
                      {errors.rruleTime ? (
                        <div className="text-xs text-red-600">
                          {errors.rruleTime}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {draft.pattern.kind === "fixed" ? (
                  <div className="rounded-lg border border-slate-200 p-4 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-900">
                          Fixed dates
                        </div>
                        <div className="text-xs text-slate-500">
                          Repeats on specific month/day (year-agnostic).
                        </div>
                      </div>
                      <Btn
                        type="button"
                        variant="outline"
                        onClick={addFixedDate}
                      >
                        + Add date
                      </Btn>
                    </div>

                    <div className="space-y-2">
                      {(draft.pattern.fixed.dates || []).map((d, idx) => (
                        <div
                          key={`${idx}-${d.month}-${d.day}`}
                          className="flex items-center gap-2"
                        >
                          <div className="flex items-center gap-2">
                            <div className="text-xs text-slate-600 w-10">
                              MM
                            </div>
                            <Inp
                              type="number"
                              min={1}
                              max={12}
                              value={d.month}
                              onChange={(e) =>
                                updateFixedDate(idx, "month", e.target.value)
                              }
                              className="w-20"
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="text-xs text-slate-600 w-10">
                              DD
                            </div>
                            <Inp
                              type="number"
                              min={1}
                              max={31}
                              value={d.day}
                              onChange={(e) =>
                                updateFixedDate(idx, "day", e.target.value)
                              }
                              className="w-20"
                            />
                          </div>
                          <Btn
                            type="button"
                            variant="ghost"
                            onClick={() => removeFixedDate(idx)}
                          >
                            Remove
                          </Btn>
                        </div>
                      ))}
                      {errors.fixedDates ? (
                        <div className="text-xs text-red-600">
                          {errors.fixedDates}
                        </div>
                      ) : null}
                    </div>

                    <div className="space-y-1">
                      <Lab htmlFor="fixed-time">Time</Lab>
                      <Inp
                        id="fixed-time"
                        type="time"
                        value={draft.pattern.fixed.time || ""}
                        onChange={(e) =>
                          setField("pattern.fixed.time", e.target.value)
                        }
                        className={cn(errors.fixedTime && "border-red-400")}
                      />
                      {errors.fixedTime ? (
                        <div className="text-xs text-red-600">
                          {errors.fixedTime}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {draft.pattern.kind === "adhoc" ? (
                  <div className="rounded-lg border border-slate-200 p-4 space-y-2">
                    <div className="text-sm font-semibold text-slate-900">
                      Ad-hoc
                    </div>
                    <div className="text-xs text-slate-500">
                      No automatic repeating. Save as a template only.
                    </div>
                  </div>
                ) : null}

                <div className="rounded-lg border border-slate-200 p-4 space-y-3">
                  <div className="text-sm font-semibold text-slate-900">
                    Policies & notifications
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <TogglePill
                      checked={!!draft.sabbathGuard}
                      onChange={(v) => setField("sabbathGuard", v)}
                      label="Sabbath guard"
                    />
                    <TogglePill
                      checked={draft.quietHoursPolicy === "respect"}
                      onChange={() => setField("quietHoursPolicy", "respect")}
                      label="Quiet hours: respect"
                    />
                    <TogglePill
                      checked={draft.quietHoursPolicy === "warn"}
                      onChange={() => setField("quietHoursPolicy", "warn")}
                      label="Quiet hours: warn"
                    />
                    <TogglePill
                      checked={draft.quietHoursPolicy === "ignore"}
                      onChange={() => setField("quietHoursPolicy", "ignore")}
                      label="Quiet hours: ignore"
                    />
                  </div>

                  <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-medium text-slate-700">
                          Notifications
                        </div>
                        <TogglePill
                          checked={!!draft.notifications.enabled}
                          onChange={(v) => setField("notifications.enabled", v)}
                          label={draft.notifications.enabled ? "On" : "Off"}
                        />
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <TogglePill
                          disabled={!draft.notifications.enabled}
                          checked={!!draft.notifications.channels.toast}
                          onChange={(v) =>
                            setField("notifications.channels.toast", v)
                          }
                          label="Toast"
                        />
                        <TogglePill
                          disabled={!draft.notifications.enabled}
                          checked={!!draft.notifications.channels.sound}
                          onChange={(v) =>
                            setField("notifications.channels.sound", v)
                          }
                          label="Sound"
                        />
                        <TogglePill
                          disabled={!draft.notifications.enabled}
                          checked={!!draft.notifications.channels.voice}
                          onChange={(v) =>
                            setField("notifications.channels.voice", v)
                          }
                          label="Voice"
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <Lab htmlFor="lead-min">Lead time (minutes)</Lab>
                      <Inp
                        id="lead-min"
                        type="number"
                        min={0}
                        value={draft.notifications.leadMinutes ?? 0}
                        onChange={(e) =>
                          setField(
                            "notifications.leadMinutes",
                            Number(e.target.value || 0)
                          )
                        }
                        disabled={!draft.notifications.enabled}
                      />
                      <div className="text-[11px] text-slate-500">
                        Notify this many minutes before.
                      </div>
                    </div>
                  </div>
                </div>

                {saveResult?.ok === false ? (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                    {saveResult.message}
                  </div>
                ) : null}
              </div>
            </div>
          </CardContent>

          <CardFooter>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-2">
                <Btn
                  type="button"
                  variant="outline"
                  onClick={handleReset}
                  disabled={saving}
                >
                  Reset
                </Btn>
                <Btn
                  type="button"
                  variant="ghost"
                  onClick={handleClose}
                  disabled={saving}
                >
                  Cancel
                </Btn>
              </div>

              <div className="flex items-center gap-2">
                <Btn
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setErrors(validateDraft(draft));
                    emit("schedule.draft.saved", {
                      id: draft.id,
                      domain: draft.domain,
                    });
                    setSaveResult({ ok: true });
                    setTimeout(() => setSaveResult(null), 900);
                  }}
                  disabled={saving}
                  title="Keeps draft in local storage"
                >
                  Save draft
                </Btn>

                <Btn
                  type="button"
                  variant="default"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? "Saving…" : "Save schedule"}
                </Btn>
              </div>
            </div>

            <div className="mt-3 text-[11px] text-slate-500">
              ID: <span className="font-mono">{draft.id}</span>
              {" · "}
              Draft key: <span className="font-mono">{computedStorageKey}</span>
            </div>
          </CardFooter>
        </Card>
      </ModalShell>
    </>
  );
}
