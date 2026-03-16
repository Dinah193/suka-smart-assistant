/* eslint-disable no-console */
// src/pages/MealPlanning/SessionRunner.jsx
import React, { useEffect, useMemo, useRef, useState, Suspense } from "react";

/* --------------------------------- Tokens ---------------------------------- */
const cx = (...a) => a.filter(Boolean).join(" ");
const WRAP = "mx-auto max-w-7xl px-4 py-4";
const BTN =
  "inline-flex items-center gap-2 rounded-2xl px-3 py-1.5 text-sm font-medium shadow-sm transition focus:outline-none focus:ring-2 focus:ring-offset-2 active:translate-y-px";
const VAR = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-600",
  subtle:
    "bg-white text-gray-900 hover:bg-gray-50 border border-gray-200 focus:ring-indigo-600",
  ghost: "bg-transparent text-gray-700 hover:bg-gray-100 focus:ring-indigo-600",
  danger: "bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-600",
  warn: "bg-amber-500 text-white hover:bg-amber-600 focus:ring-amber-600",
  success:
    "bg-emerald-600 text-white hover:bg-emerald-700 focus:ring-emerald-600",
};
const FIELD =
  "w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-600";
const CHIP =
  "inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white/80 px-2 py-0.5 text-[11px] font-medium text-gray-700";
const CARD = "rounded-2xl border border-gray-200 bg-white p-4 shadow-sm";
const ROW = "flex items-center gap-2";

/* ----------------------------- Defensive imports ---------------------------- */
let eventBus = { emit() {}, on() {}, off() {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus)) || eventBus;
} catch (_) {}

let automation = null;
try {
  const a = require("@/services/automation/runtime");
  automation = (a && (a.automation || a.default)) || null;
} catch (_) {}

/* Favorites: Sessions & Schedules (user-owned) */
let useFavoriteSessions = null;
try {
  const favMod = require("@/hooks/useFavoriteSessions");
  useFavoriteSessions =
    (favMod && (favMod.useFavoriteSessions || favMod.default)) || null;
} catch (_) {}
let useFavoriteSchedules = null;
try {
  const favSchedMod = require("@/hooks/useFavoriteSchedules");
  useFavoriteSchedules =
    (favSchedMod &&
      (favSchedMod.useFavoriteSchedules || favSchedMod.default)) ||
    null;
} catch (_) {}

/* Lazy optional modals/components */
let SaveSessionModalLazy = null;
try {
  SaveSessionModalLazy = React.lazy(() =>
    import("@/components/session/SaveSessionModal.jsx")
  );
} catch (_) {}
let SaveScheduleModalLazy = null;
try {
  SaveScheduleModalLazy = React.lazy(() =>
    import("@/components/scheduler/SaveScheduleModal.jsx")
  );
} catch (_) {}
let InlineToastAnchorLazy = null;
try {
  InlineToastAnchorLazy = React.lazy(() =>
    import("@/components/toasts/InlineToastAnchor.jsx")
  );
} catch (_) {}

/* ----------------------------------- Icons ---------------------------------- */
let I = {};
try {
  const L = require("lucide-react");
  I = {
    Play: L.Play,
    Pause: L.Pause,
    Square: L.Square,
    Check: L.Check,
    X: L.X,
    Clock: L.Clock3,
    Star: L.Star,
    StarOff: L.StarOff,
    Save: L.Save,
    ChevronRight: L.ChevronRight,
    ChevronDown: L.ChevronDown,
    External: L.ExternalLink,
    Alert: L.AlertTriangle,
    Timer: L.Timer,
    ListChecks: L.ListChecks,
    Sparkles: L.Sparkles,
    More: L.MoreHorizontal,
    Edit: L.Pencil,
    Grip: L.GripVertical,
    Download: L.Download,
    Calendar: L.Calendar,
  };
} catch (_) {
  I = new Proxy(
    {},
    {
      get() {
        return () => <span />;
      },
    }
  );
}

/* ---------------------------------- Utils ---------------------------------- */
const nowISO = () => new Date().toISOString();
const uid = (p = "id") => p + ":" + Math.random().toString(36).slice(2, 9);
const toastSafe = (message, variant) => {
  try {
    eventBus.emit("ui.toast", { message, variant: variant || "success" });
  } catch {
    variant === "error" ? console.warn(message) : console.log(message);
  }
};
const prettyScheduleLabel = (trg) => {
  if (!trg || !trg.type) return "Schedule";
  if (trg.type === "time.at") return `At ${String(trg.value || "—")}`;
  if (trg.type === "time.every") return `Every ${String(trg.value || "—")}`;
  return `${trg.type} ${String(trg.value || "")}`;
};
const scheduleKey = (trigger) =>
  trigger && trigger.type
    ? `${trigger.type}::${JSON.stringify(trigger.value)}`
    : "";

/* ============================== Session Runner ============================== */
/**
 * Props:
 * - sessionIdOrTitle?: string
 * - domain?: string ("session")
 * - schedule?: { trigger?, key? } // optional link to schedule that launched this
 */
export default function SessionRunner(props) {
  const domain = props.domain || "session";
  const initialId = props.sessionIdOrTitle || "Meal Planning — This Week";

  /* ------------------------------- State model ------------------------------ */
  const [session, setSession] = useState({
    id: initialId,
    title: initialId,
    status: "idle", // idle|running|paused|done|stopped
    startedAt: null,
    pausedAt: null,
    steps: [
      {
        id: "s1",
        title: "Check pantry/fridge inventory",
        done: false,
        notes: "",
      },
      {
        id: "s2",
        title: "Pick 4–5 mains for the week",
        done: false,
        notes: "",
      },
      { id: "s3", title: "Draft grocery list", done: false, notes: "" },
      { id: "s4", title: "Block time on calendar", done: false, notes: "" },
    ],
  });

  const [expanded, setExpanded] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showPause, setShowPause] = useState(false);

  // Link to schedule if provided
  const schedule = useMemo(() => {
    const t = props.schedule && (props.schedule.trigger || null);
    const key = props.schedule && (props.schedule.key || scheduleKey(t));
    return t ? { trigger: t, key, label: prettyScheduleLabel(t) } : null;
  }, [props.schedule]);

  /* ------------------------------ Favorites APIs ---------------------------- */
  let favSessApi = null;
  try {
    favSessApi = useFavoriteSessions ? useFavoriteSessions(domain) : null;
  } catch (_) {}
  const [isFavSession, setIsFavSession] = useState(
    !!(favSessApi && favSessApi.isFavorite && favSessApi.isFavorite(initialId))
  );

  let favSchedApi = null;
  try {
    favSchedApi = useFavoriteSchedules ? useFavoriteSchedules(domain) : null;
  } catch (_) {}
  const [isFavSched, setIsFavSched] = useState(() => {
    if (!schedule || !favSchedApi || !favSchedApi.isFavorite) return false;
    return !!favSchedApi.isFavorite(schedule.key);
  });

  const [saveSessionOpen, setSaveSessionOpen] = useState(false);
  const [saveScheduleOpen, setSaveScheduleOpen] = useState(false);

  /* ------------------------------ Load from runtime ------------------------- */
  useEffect(() => {
    // hydrate session from automation runtime if available
    try {
      if (automation && automation.sessions && automation.sessions.get) {
        const maybe = automation.sessions.get({ idOrTitle: initialId, domain });
        if (maybe && typeof maybe.then === "function") {
          maybe.then((res) => {
            if (res) setSession((s) => Object.assign({}, s, res));
          });
        } else if (maybe) {
          setSession((s) => Object.assign({}, s, maybe));
        }
      }
    } catch (_) {}

    // bus listeners: step updates or external control
    const onStepStatus = (p = {}) => {
      if (!p.stepId) return;
      setSession((s) => {
        const arr = (s.steps || []).slice();
        const idx = arr.findIndex((x) => x.id === p.stepId);
        if (idx < 0) return s;
        arr[idx] = Object.assign({}, arr[idx], { done: !!p.done });
        return Object.assign({}, s, { steps: arr });
      });
    };
    const onSessionControl = (p = {}) => {
      if (p.idOrTitle && p.idOrTitle !== session.id) return;
      if (p.action === "pause") doPause();
      if (p.action === "resume") doResume();
      if (p.action === "stop") doStop();
    };
    try {
      eventBus.on && eventBus.on("step.status.updated", onStepStatus);
      eventBus.on && eventBus.on("session.control.requested", onSessionControl);
    } catch (_) {}

    return () => {
      try {
        eventBus.off && eventBus.off("step.status.updated", onStepStatus);
        eventBus.off &&
          eventBus.off("session.control.requested", onSessionControl);
      } catch (_) {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialId, domain, session.id]);

  /* --------------------------------- Actions -------------------------------- */
  function doStart() {
    if (session.status === "running") return;
    setBusy(true);
    const next = Object.assign({}, session, {
      status: "running",
      startedAt: session.startedAt || nowISO(),
      pausedAt: null,
    });
    setSession(next);
    try {
      if (automation && automation.sessions && automation.sessions.start) {
        const maybe = automation.sessions.start({
          idOrTitle: session.id,
          domain,
        });
        if (maybe && typeof maybe.then === "function") {
          maybe.then(() => {});
        }
      } else {
        eventBus.emit &&
          eventBus.emit("session.start.requested", {
            idOrTitle: session.id,
            domain,
            source: "SessionRunner",
          });
      }
      eventBus.emit &&
        eventBus.emit("ui.toast", {
          message: "Session started.",
          variant: "success",
          ttl: 2000,
          session: { idOrTitle: session.id, domain },
        });
    } finally {
      setBusy(false);
    }
  }
  function doPause() {
    if (session.status !== "running") return;
    setShowPause(true);
  }
  function doConfirmPause(reason) {
    setShowPause(false);
    setSession((s) =>
      Object.assign({}, s, {
        status: "paused",
        pausedAt: nowISO(),
        pauseReason: reason || "",
      })
    );
    try {
      if (automation && automation.sessions && automation.sessions.pause) {
        const maybe = automation.sessions.pause({
          idOrTitle: session.id,
          domain,
          reason,
        });
        if (maybe && typeof maybe.then === "function") {
          maybe.then(() => {});
        }
      } else {
        eventBus.emit &&
          eventBus.emit("session.pause.requested", {
            idOrTitle: session.id,
            domain,
            reason,
            source: "SessionRunner",
          });
      }
      toastSafe("Session paused.");
    } catch (_) {}
  }
  function doResume() {
    if (session.status !== "paused") return;
    setSession((s) =>
      Object.assign({}, s, { status: "running", pausedAt: null })
    );
    try {
      if (automation && automation.sessions && automation.sessions.resume) {
        const maybe = automation.sessions.resume({
          idOrTitle: session.id,
          domain,
        });
        if (maybe && typeof maybe.then === "function") {
          maybe.then(() => {});
        }
      } else {
        eventBus.emit &&
          eventBus.emit("session.resume.requested", {
            idOrTitle: session.id,
            domain,
            source: "SessionRunner",
          });
      }
      toastSafe("Session resumed.");
    } catch (_) {}
  }
  function doStop() {
    if (session.status === "stopped" || session.status === "done") return;
    setSession((s) => Object.assign({}, s, { status: "stopped" }));
    try {
      if (automation && automation.sessions && automation.sessions.stop) {
        const maybe = automation.sessions.stop({
          idOrTitle: session.id,
          domain,
        });
        if (maybe && typeof maybe.then === "function") {
          maybe.then(() => {});
        }
      } else {
        eventBus.emit &&
          eventBus.emit("session.stop.requested", {
            idOrTitle: session.id,
            domain,
            source: "SessionRunner",
          });
      }
    } catch (_) {}
    toastSafe("Session stopped.", "warn");
  }
  function toggleStepDone(step) {
    const done = !step.done;
    setSession((s) => {
      const arr = (s.steps || []).slice();
      const idx = arr.findIndex((x) => x.id === step.id);
      if (idx >= 0) arr[idx] = Object.assign({}, step, { done });
      return Object.assign({}, s, { steps: arr });
    });
    try {
      if (automation && automation.steps && automation.steps.setDone) {
        automation.steps.setDone({
          stepId: step.id,
          done,
          domain,
          sessionIdOrTitle: session.id,
        });
      } else {
        eventBus.emit &&
          eventBus.emit("step.status.updated", {
            stepId: step.id,
            done,
            domain,
            sessionIdOrTitle: session.id,
            source: "SessionRunner",
          });
      }
    } catch (_) {}
  }

  /* --------------------------- Favorite / Save (Session) -------------------- */
  function toggleFavoriteSession() {
    try {
      if (useFavoriteSessions && favSessApi && favSessApi.toggleFavorite) {
        const next = favSessApi.toggleFavorite(session.id, {
          id: session.id,
          title: session.title,
          domain,
        });
        if (next && typeof next.then === "function") {
          next.then((v) => setIsFavSession(!!v));
        } else setIsFavSession(!!next);
      } else {
        setIsFavSession((v) => !v);
        eventBus.emit &&
          eventBus.emit("session.favorite.toggled", {
            domain,
            sessionId: session.id,
            next: !isFavSession,
            meta: { title: session.title },
            source: "SessionRunner",
          });
      }
      toastSafe(
        isFavSession
          ? "Removed from favorite sessions."
          : "Added to favorite sessions."
      );
    } catch (_) {
      toastSafe("Could not update favorite sessions.", "error");
    }
  }
  function openSaveSession() {
    setSaveSessionOpen(true);
    try {
      eventBus.emit &&
        eventBus.emit("session.save.modal.opened", {
          domain,
          sessionId: session.id,
          source: "SessionRunner",
        });
    } catch (_) {}
  }

  /* -------------------------- Favorite / Save (Schedule) -------------------- */
  function toggleFavoriteSchedule() {
    if (!schedule) return;
    try {
      if (useFavoriteSchedules && favSchedApi && favSchedApi.toggleFavorite) {
        const meta = {
          id: schedule.key,
          domain,
          kind: "schedule",
          trigger: schedule.trigger,
          title: `${session.title} — ${schedule.label}`,
        };
        const next = favSchedApi.toggleFavorite(schedule.key, meta);
        if (next && typeof next.then === "function") {
          next.then((v) => setIsFavSched(!!v));
        } else setIsFavSched(!!next);
      } else {
        setIsFavSched((v) => !v);
        eventBus.emit &&
          eventBus.emit("schedule.favorite.toggled", {
            domain,
            scheduleKey: schedule.key,
            trigger: schedule.trigger,
            next: !isFavSched,
            source: "SessionRunner",
          });
      }
      toastSafe(
        isFavSched
          ? "Removed from favorite schedules."
          : "Added to favorite schedules."
      );
    } catch (_) {
      toastSafe("Could not update favorite schedules.", "error");
    }
  }
  function openSaveSchedule() {
    if (!schedule) return;
    setSaveScheduleOpen(true);
    try {
      eventBus.emit &&
        eventBus.emit("schedule.save.modal.opened", {
          domain,
          scheduleKey: schedule.key,
          trigger: schedule.trigger,
          source: "SessionRunner",
        });
    } catch (_) {}
  }

  /* ---------------------------------- UI ------------------------------------ */
  const progress = useMemo(() => {
    const total = (session.steps || []).length || 1;
    const done = (session.steps || []).filter((s) => s.done).length;
    return Math.round((done / total) * 100);
  }, [session.steps]);

  return (
    <main className={WRAP}>
      {/* Page HUD / toasts */}
      {InlineToastAnchorLazy ? (
        <Suspense fallback={null}>
          <InlineToastAnchorLazy position="top-right" domain={domain} />
        </Suspense>
      ) : null}

      {/* Banner */}
      <section className={cx(CARD, "border-2 border-indigo-100")}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-gray-900">
              {session.title}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className={CHIP}>
                <I.ListChecks className="h-3.5 w-3.5" /> {progress}% complete
              </span>
              <span className={CHIP}>
                <I.Timer className="h-3.5 w-3.5" /> {session.status}
              </span>
              {schedule ? (
                <span className={CHIP}>
                  <I.Clock className="h-3.5 w-3.5" /> {schedule.label}
                </span>
              ) : null}
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {/* Session favorites & save */}
            <button
              className={cx(BTN, VAR.ghost, "px-2")}
              onClick={toggleFavoriteSession}
              title={isFavSession ? "Unfavorite session" : "Favorite session"}
            >
              <I.Star
                className={cx("h-4 w-4", isFavSession ? "text-amber-500" : "")}
              />
            </button>
            <button
              className={cx(BTN, VAR.subtle, "px-2")}
              onClick={openSaveSession}
              title="Save session"
            >
              <I.Save className="h-4 w-4" />
            </button>

            {/* If launched from a schedule, expose schedule star/save */}
            {schedule ? (
              <>
                <div className="h-5 w-px bg-gray-200 mx-1" />
                <button
                  className={cx(BTN, VAR.ghost, "px-2")}
                  onClick={toggleFavoriteSchedule}
                  title={
                    isFavSched ? "Unfavorite schedule" : "Favorite schedule"
                  }
                >
                  <I.Star
                    className={cx(
                      "h-4 w-4",
                      isFavSched ? "text-amber-500" : ""
                    )}
                  />
                </button>
                <button
                  className={cx(BTN, VAR.subtle, "px-2")}
                  onClick={openSaveSchedule}
                  title="Save schedule"
                >
                  <I.Save className="h-4 w-4" />
                </button>
              </>
            ) : null}

            {/* Controls */}
            {session.status !== "running" ? (
              <button
                className={cx(BTN, VAR.primary)}
                onClick={doStart}
                disabled={busy}
              >
                <I.Play className="h-4 w-4" /> Start
              </button>
            ) : (
              <>
                <button className={cx(BTN, VAR.warn)} onClick={doPause}>
                  <I.Pause className="h-4 w-4" /> Pause
                </button>
                <button className={cx(BTN, VAR.danger)} onClick={doStop}>
                  <I.Square className="h-4 w-4" /> Stop
                </button>
              </>
            )}
            {session.status === "paused" ? (
              <button className={cx(BTN, VAR.primary)} onClick={doResume}>
                <I.Play className="h-4 w-4" /> Resume
              </button>
            ) : null}
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-100">
          <div
            className="h-full rounded-full bg-indigo-600 transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      </section>

      {/* Timeline / Steps */}
      <section className="mt-4">
        <div className={cx(CARD, "p-0")}>
          <header className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
            <div className="text-sm font-semibold text-gray-900">Timeline</div>
            <div className="flex items-center gap-2">
              <button
                className={cx(BTN, VAR.ghost)}
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? (
                  <I.ChevronDown className="h-4 w-4" />
                ) : (
                  <I.ChevronRight className="h-4 w-4" />
                )}{" "}
                {expanded ? "Collapse" : "Expand"}
              </button>
            </div>
          </header>

          {expanded ? (
            <ul className="divide-y divide-gray-100">
              {(session.steps || []).map((step, idx) => (
                <li
                  key={step.id}
                  className="px-4 py-3 hover:bg-gray-50 transition"
                >
                  <div className="flex items-start gap-3">
                    <button
                      className={cx(
                        BTN,
                        step.done ? VAR.success : VAR.subtle,
                        "px-2"
                      )}
                      onClick={() => toggleStepDone(step)}
                      title={step.done ? "Mark as not done" : "Mark as done"}
                    >
                      <I.Check className="h-4 w-4" />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div
                          className={cx(
                            "text-sm font-medium",
                            step.done
                              ? "line-through text-gray-500"
                              : "text-gray-900"
                          )}
                        >
                          {idx + 1}. {step.title}
                        </div>
                        <span className={CHIP}>id:{step.id}</span>
                      </div>
                      {step.notes ? (
                        <p className="mt-1 text-[12px] text-gray-600">
                          {step.notes}
                        </p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <button
                          className={cx(BTN, VAR.ghost)}
                          onClick={() => {
                            // example “nudge” toast for the step
                            eventBus.emit &&
                              eventBus.emit("ui.toast", {
                                message: step.done
                                  ? "You already completed this step."
                                  : `Ready for: ${step.title}`,
                                variant: step.done ? "warn" : "info",
                                ttl: "+6s",
                                step: {
                                  id: step.id,
                                  canUndo: true,
                                  canComplete: true,
                                },
                                session: { idOrTitle: session.id, domain },
                                actions: [
                                  {
                                    label: "Mark done",
                                    event: "step.complete.requested",
                                    variant: "primary",
                                  },
                                  {
                                    label: "Undo",
                                    event: "step.undo.requested",
                                  },
                                ],
                              });
                          }}
                        >
                          Nudge
                        </button>
                        <button
                          className={cx(BTN, VAR.subtle)}
                          onClick={() => {
                            const txt = prompt(
                              "Add / edit note",
                              step.notes || ""
                            );
                            if (txt === null) return;
                            setSession((s) => {
                              const arr = s.steps.slice();
                              const i = arr.findIndex((x) => x.id === step.id);
                              if (i >= 0)
                                arr[i] = Object.assign({}, arr[i], {
                                  notes: txt,
                                });
                              return Object.assign({}, s, { steps: arr });
                            });
                          }}
                        >
                          <I.Edit className="h-4 w-4" /> Note
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      {/* Pause Modal */}
      {showPause ? (
        <PauseModal
          onClose={() => setShowPause(false)}
          onConfirm={doConfirmPause}
        />
      ) : null}

      {/* Save Session modal (lazy preferred) */}
      {saveSessionOpen ? (
        SaveSessionModalLazy ? (
          <Suspense fallback={null}>
            <SaveSessionModalLazy
              isOpen={true}
              onClose={() => setSaveSessionOpen(false)}
              domain={domain}
              sessionId={String(session.id || "__pending__")}
              defaultTitle={String(session.title || "My Session")}
              onSaved={(saved) => {
                try {
                  eventBus.emit &&
                    eventBus.emit("session.saved", {
                      from: "SessionRunner",
                      saved,
                    });
                } catch (_) {}
                toastSafe("Session saved.");
                setSaveSessionOpen(false);
              }}
            />
          </Suspense>
        ) : (
          <InlineSaveSession
            domain={domain}
            sessionId={String(session.id || "__pending__")}
            defaultTitle={String(session.title || "My Session")}
            onClose={() => setSaveSessionOpen(false)}
            onSaved={(saved) => {
              try {
                eventBus.emit &&
                  eventBus.emit("session.saved", {
                    from: "SessionRunner",
                    saved,
                  });
              } catch (_) {}
              toastSafe("Session saved.");
              setSaveSessionOpen(false);
            }}
          />
        )
      ) : null}

      {/* Save Schedule modal (lazy preferred) */}
      {saveScheduleOpen && schedule ? (
        SaveScheduleModalLazy ? (
          <Suspense fallback={null}>
            <SaveScheduleModalLazy
              isOpen={true}
              onClose={() => setSaveScheduleOpen(false)}
              domain={domain}
              scheduleKey={String(schedule.key || "__pending__")}
              trigger={schedule.trigger}
              defaultTitle={`${session.title} — ${schedule.label}`}
              onSaved={(saved) => {
                try {
                  eventBus.emit &&
                    eventBus.emit("schedule.saved", {
                      from: "SessionRunner",
                      saved,
                    });
                } catch (_) {}
                toastSafe("Schedule saved.");
                setSaveScheduleOpen(false);
              }}
            />
          </Suspense>
        ) : (
          <InlineSaveSchedule
            domain={domain}
            scheduleKey={String(schedule.key || "__pending__")}
            trigger={schedule.trigger}
            defaultTitle={`${session.title} — ${schedule.label}`}
            onClose={() => setSaveScheduleOpen(false)}
            onSaved={(saved) => {
              try {
                eventBus.emit &&
                  eventBus.emit("schedule.saved", {
                    from: "SessionRunner",
                    saved,
                  });
              } catch (_) {}
              toastSafe("Schedule saved.");
              setSaveScheduleOpen(false);
            }}
          />
        )
      ) : null}
    </main>
  );
}

/* --------------------------------- Pause Modal ------------------------------ */
function PauseModal({ onClose, onConfirm }) {
  const [reason, setReason] = useState("");
  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/30"
      role="dialog"
      aria-modal="true"
      aria-label="Pause session"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose && onClose();
      }}
    >
      <div className="w-[95vw] max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <div className="text-base font-semibold text-gray-900">
            <I.Pause className="inline h-4 w-4 mr-1" /> Pause session
          </div>
          <button
            className={cx(BTN, VAR.ghost, "px-2")}
            onClick={onClose}
            aria-label="Close"
          >
            <I.X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-1 text-sm text-gray-600">
          Optionally add a short note so we can resume smoothly.
        </p>

        <label className="mt-4 block text-sm font-medium text-gray-700">
          Reason (optional)
        </label>
        <input
          className={FIELD}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g., got a call, oven preheating"
        />

        <div className="mt-6 flex justify-end gap-2">
          <button className={cx(BTN, VAR.ghost)} onClick={onClose}>
            Cancel
          </button>
          <button
            className={cx(BTN, VAR.warn)}
            onClick={() => onConfirm && onConfirm(reason)}
          >
            <I.Pause className="h-4 w-4" /> Pause
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- Inline Save (Fallbacks) ----------------------- */
function InlineSaveSession(props) {
  const [name, setName] = useState(props.defaultTitle || "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  function submit() {
    setBusy(true);
    try {
      const payload = {
        id: props.sessionId,
        domain: props.domain,
        title: name,
        notes,
      };
      try {
        eventBus.emit &&
          eventBus.emit("session.save.requested", {
            payload,
            source: "SessionRunner",
          });
      } catch (_) {}
      props.onSaved && props.onSaved(payload);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/30"
      role="dialog"
      aria-modal="true"
      aria-label="Save session"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose && props.onClose();
      }}
    >
      <div className="w-[95vw] max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">
            Save Session
          </h3>
          <button
            className={cx(BTN, VAR.ghost, "px-2")}
            onClick={props.onClose}
            aria-label="Close"
          >
            <I.X className="h-4 w-4" />
          </button>
        </div>
        <label className="mt-4 block text-sm font-medium text-gray-700">
          Title
        </label>
        <input
          className={FIELD}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Session title"
        />
        <label className="mt-4 block text-sm font-medium text-gray-700">
          Notes
        </label>
        <textarea
          className={cx(FIELD, "min-h-[96px]")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What should future-you remember?"
        />
        <div className="mt-6 flex justify-end gap-2">
          <button className={cx(BTN, VAR.ghost)} onClick={props.onClose}>
            Cancel
          </button>
          <button
            className={cx(BTN, VAR.primary)}
            onClick={submit}
            disabled={busy}
          >
            <I.Save className="h-4 w-4" />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function InlineSaveSchedule(props) {
  const [name, setName] = useState(props.defaultTitle || "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  function submit() {
    setBusy(true);
    try {
      const payload = {
        id: props.scheduleKey,
        domain: props.domain,
        title: name,
        notes,
        trigger: props.trigger || {},
        kind: "schedule",
      };
      try {
        eventBus.emit &&
          eventBus.emit("schedule.save.requested", {
            payload,
            source: "SessionRunner",
          });
      } catch (_) {}
      props.onSaved && props.onSaved(payload);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/30"
      role="dialog"
      aria-modal="true"
      aria-label="Save schedule"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose && props.onClose();
      }}
    >
      <div className="w-[95vw] max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">
            Save Schedule
          </h3>
          <button
            className={cx(BTN, VAR.ghost, "px-2")}
            onClick={props.onClose}
            aria-label="Close"
          >
            <I.X className="h-4 w-4" />
          </button>
        </div>
        <label className="mt-4 block text-sm font-medium text-gray-700">
          Title
        </label>
        <input
          className={FIELD}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Schedule title"
        />
        <label className="mt-4 block text-sm font-medium text-gray-700">
          Notes
        </label>
        <textarea
          className={cx(FIELD, "min-h-[96px]")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g., Applies only on weekdays"
        />
        <div className="mt-6 flex justify-end gap-2">
          <button className={cx(BTN, VAR.ghost)} onClick={props.onClose}>
            Cancel
          </button>
          <button
            className={cx(BTN, VAR.primary)}
            onClick={submit}
            disabled={busy}
          >
            <I.Save className="h-4 w-4" />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
