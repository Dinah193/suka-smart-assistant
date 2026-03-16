/* eslint-disable no-console */
// src/pages/cleaning/SessionRunner.jsx
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

/* -----------------------------------------------------------------------------
   Defensive imports (support default or named exports, or fall back stubs)
----------------------------------------------------------------------------- */
const isBrowser = typeof window !== "undefined";

let eventBus = { emit() {}, on() {}, off() {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let automation = {
  emit: () => {},
  on: () => {},
  off: () => {},
  rules: { get: () => [] },
};
try {
  const mod = require("@/services/automation/runtime");
  automation = (mod && (mod.automation || mod.default || mod)) || automation;
} catch (_e) {}

let pausePolicies = {
  constants: {
    REASON_USER: "user",
    REASON_SAFETY: "safety",
    REASON_SABBATH: "sabbath",
  },
  shouldFreeze: () => false,
  canContinue: () => true,
  normalize: (p) => ({ ...p }),
};
try {
  const mod = require("@/services/session/policies/pausePolicies");
  pausePolicies = (mod && (mod.default || mod)) || pausePolicies;
} catch (_e) {}

let offsetParser = {
  parse: (s) => {
    // Very small fallback: "+20m", "PT1H", "10m"
    if (!s) return 0;
    const m =
      /(?:(\+)?PT)?(?:(\d+)H)?(?:(\d+)M)?/.exec(s) ||
      /^(\+)?(\d+)\s*m(in)?$/.exec(s) ||
      /^(\+)?(\d+)\s*h(ours?)?$/.exec(s);
    if (!m) return 0;
    const nums = m.slice(2).map((x) => (x ? parseInt(x, 10) : 0));
    let minutes = 0;
    if (/H|hours?/.test(s)) minutes = nums[0] * 60;
    else if (/M|min/.test(s)) minutes = nums[0];
    else minutes = (nums[0] || 0) * 60 + (nums[1] || 0);
    return minutes * 60 * 1000;
  },
};
try {
  const mod = require("@/services/session/utils/offsetParser");
  offsetParser = (mod && (mod.default || mod)) || offsetParser;
} catch (_e) {}

let calendarSync = {
  addEvents: async () => ({ ok: true }),
  writeSession: async () => ({ ok: true }),
};
try {
  const mod = require("@/services/calendar/calendarSync");
  calendarSync = (mod && (mod.default || mod)) || calendarSync;
} catch (_e) {}

let inventoryGuard = { ensureOnHand: () => ({ ok: true, shortages: [] }) };
try {
  const mod = require("@/services/session/guards/inventoryGuard");
  inventoryGuard = (mod && (mod.default || mod)) || inventoryGuard;
} catch (_e) {}

let useSettingsStore = () => ({
  quietHours: { start: "21:00", end: "06:30", enabled: false },
  sabbath: { enabled: false, from: "Friday 18:00", to: "Saturday 19:30" },
  defaults: { cleaningTemplateId: "speed-clean-30" },
  rhythms: { preferMorning: false },
});
try {
  const mod = require("@/stores/settingsStore");
  useSettingsStore =
    (mod && (mod.default || mod.useSettingsStore)) || useSettingsStore;
} catch (_e) {}

let useFavoriteSessions = () => ({
  list: () => [],
  save: async () => ({ ok: true }),
  remove: async () => ({ ok: true }),
});
try {
  const mod = require("@/hooks/useFavoriteSessions");
  useFavoriteSessions =
    (mod && (mod.default || mod.useFavoriteSessions)) || useFavoriteSessions;
} catch (_e) {}

let useSchedules = () => ({
  list: () => [],
  save: async () => ({ ok: true }),
});
try {
  const mod = require("@/hooks/useSchedules");
  useSchedules = (mod && (mod.default || mod.useSchedules)) || useSchedules;
} catch (_e) {}

/* -----------------------------------------------------------------------------
   LocalStorage fallbacks for favorites/schedules (if hooks unavailable)
----------------------------------------------------------------------------- */
const fallbackFavKey = "cleaning:favorites";
const fallbackSchedKey = "cleaning:schedules";
const localFavAPI = {
  list: () => {
    if (!isBrowser) return [];
    try {
      return JSON.parse(localStorage.getItem(fallbackFavKey) || "[]");
    } catch {
      return [];
    }
  },
  save: async (fav) => {
    if (!isBrowser) return { ok: false };
    const all = localFavAPI.list();
    const next = [
      ...all.filter((f) => f.id !== fav.id),
      { ...fav, updatedAt: Date.now() },
    ];
    localStorage.setItem(fallbackFavKey, JSON.stringify(next));
    return { ok: true };
  },
  remove: async (id) => {
    if (!isBrowser) return { ok: false };
    const all = localFavAPI.list().filter((f) => f.id !== id);
    localStorage.setItem(fallbackFavKey, JSON.stringify(all));
    return { ok: true };
  },
};
const localSchedAPI = {
  list: () => {
    if (!isBrowser) return [];
    try {
      return JSON.parse(localStorage.getItem(fallbackSchedKey) || "[]");
    } catch {
      return [];
    }
  },
  save: async (s) => {
    if (!isBrowser) return { ok: false };
    const all = localSchedAPI.list();
    const next = [
      ...all.filter((x) => x.id !== s.id),
      { ...s, updatedAt: Date.now() },
    ];
    localStorage.setItem(fallbackSchedKey, JSON.stringify(next));
    return { ok: true };
  },
};

/* -----------------------------------------------------------------------------
   Small presentational pieces (inline for simplicity)
----------------------------------------------------------------------------- */
const Banner = ({ title, subtitle, onExit, onPause, onResume, isPaused }) => (
  <div className="p-3 md:p-4 rounded-2xl shadow bg-white/70 dark:bg-zinc-900/70 border border-zinc-200 dark:border-zinc-700 backdrop-blur">
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className="text-xl md:text-2xl font-semibold">{title}</div>
        {subtitle ? <div className="text-sm opacity-80">{subtitle}</div> : null}
      </div>
      <div className="flex gap-2">
        {!isPaused ? (
          <button
            className="px-3 py-2 rounded-xl border bg-amber-50 hover:bg-amber-100"
            onClick={onPause}
          >
            Pause
          </button>
        ) : (
          <button
            className="px-3 py-2 rounded-xl border bg-emerald-50 hover:bg-emerald-100"
            onClick={onResume}
          >
            Resume
          </button>
        )}
        <button
          className="px-3 py-2 rounded-xl border bg-zinc-50 hover:bg-zinc-100"
          onClick={onExit}
        >
          Exit
        </button>
      </div>
    </div>
  </div>
);

const Timeline = ({ steps = [], currentIndex = 0 }) => (
  <div className="mt-3 grid gap-2">
    {steps.map((s, i) => {
      const active = i === currentIndex;
      const done = i < currentIndex;
      return (
        <div
          key={s.id || i}
          className={[
            "p-3 rounded-xl border",
            active
              ? "bg-blue-50 border-blue-300"
              : done
              ? "bg-green-50 border-green-300"
              : "bg-zinc-50 border-zinc-200",
          ].join(" ")}
        >
          <div className="font-medium">
            {i + 1}. {s.title || s.task || "Untitled Step"}
          </div>
          {s.hints ? <div className="text-sm opacity-75">{s.hints}</div> : null}
          {s.duration ? (
            <div className="text-xs opacity-60 mt-1">~{s.duration} min</div>
          ) : null}
        </div>
      );
    })}
  </div>
);

const PauseModal = ({ open, reason, onClose, onContinue }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40">
      <div className="w-[min(560px,92vw)] rounded-2xl bg-white dark:bg-zinc-900 shadow-xl border border-zinc-200 dark:border-zinc-700 p-4">
        <div className="text-lg font-semibold mb-1">Session Paused</div>
        <div className="text-sm opacity-80 mb-4">
          {reason || "Session is paused."}
        </div>
        <div className="flex justify-end gap-2">
          <button
            className="px-3 py-2 rounded-xl border bg-zinc-50"
            onClick={onClose}
          >
            Close
          </button>
          <button
            className="px-3 py-2 rounded-xl border bg-emerald-50 hover:bg-emerald-100"
            onClick={onContinue}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
};

/* -----------------------------------------------------------------------------
   Helpers
----------------------------------------------------------------------------- */
const nowISO = () => new Date().toISOString();
const uid = () => Math.random().toString(36).slice(2, 10);

/* -----------------------------------------------------------------------------
   SessionRunner (Cleaning)
----------------------------------------------------------------------------- */
export default function CleaningSessionRunner() {
  const navigate = useNavigate();
  const location = useLocation();

  const { quietHours, sabbath, defaults, rhythms } = useSettingsStore();

  // Resolve hooks or fallbacks for favorites/schedules
  const favHook = (() => {
    try {
      const h = useFavoriteSessions();
      if (h && typeof h.list === "function") return h;
    } catch {}
    return localFavAPI;
  })();

  const schedHook = (() => {
    try {
      const h = useSchedules();
      if (h && typeof h.list === "function") return h;
    } catch {}
    return localSchedAPI;
  })();

  // Router state may carry templateId, seed steps, or resume info
  const routeState = (location && location.state) || {};
  const templateId =
    routeState.templateId || defaults?.cleaningTemplateId || "speed-clean-30";

  // Session state
  const [sessionId] = useState(() => routeState.sessionId || `clean-${uid()}`);
  const [title, setTitle] = useState(routeState.title || "Cleaning Session");
  const [subtitle, setSubtitle] = useState(
    routeState.subtitle || "Let’s reset your home."
  );
  const [steps, setSteps] = useState(() => {
    const seed = (routeState.steps || []).map((s, i) => ({
      id: s.id || `st-${i}-${uid()}`,
      ...s,
    }));
    return seed.length
      ? seed
      : [
          {
            id: `st-${uid()}`,
            title: "Tidy entry & living room",
            duration: 10,
            hints: "Collect clutter, quick surfaces",
          },
          {
            id: `st-${uid()}`,
            title: "Kitchen reset",
            duration: 10,
            hints: "Dishes, counters, spot mop",
          },
          {
            id: `st-${uid()}`,
            title: "Bathroom refresh",
            duration: 7,
            hints: "Mirror, sink, toilet, quick floor",
          },
          {
            id: `st-${uid()}`,
            title: "Hallway & trash",
            duration: 3,
            hints: "Gather bins, swap liners",
          },
        ];
  });
  const [idx, setIdx] = useState(() =>
    Math.min(routeState.currentIndex || 0, Math.max(steps.length - 1, 0))
  );
  const [paused, setPaused] = useState(false);
  const [pauseReason, setPauseReason] = useState("");
  const [startedAt] = useState(routeState.startedAt || nowISO());
  const [scheduleSuggestion, setScheduleSuggestion] = useState(null);
  const [shortages, setShortages] = useState([]);
  const [kbHint, setKbHint] = useState("(Space) pause • (→) next • (←) back");

  const timerRef = useRef(null);

  // Keyboard controls
  useEffect(() => {
    const onKey = (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        paused ? onResume() : onPause();
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        goNext();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, idx, steps.length]);

  // Inventory guard (e.g., cleaning supplies) before start
  useEffect(() => {
    (async () => {
      try {
        const guardRes = await inventoryGuard.ensureOnHand?.({
          domain: "cleaning",
          sessionId,
          items: [
            "All-purpose cleaner",
            "Glass cleaner",
            "Trash bags",
            "Microfiber cloths",
          ],
        });
        if (guardRes?.shortages?.length) {
          setShortages(guardRes.shortages);
          eventBus.emit("inventory:signals", {
            domain: "cleaning",
            sessionId,
            shortages: guardRes.shortages,
          });
        }
      } catch (e) {
        console.warn("Inventory guard skipped:", e?.message || e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Sabbath / Quiet hours guard at mount
  useEffect(() => {
    try {
      const shouldFreeze = pausePolicies.shouldFreeze?.({
        domain: "cleaning",
        quietHours,
        sabbath,
        rhythms,
        now: new Date(),
      });
      if (shouldFreeze) {
        setPaused(true);
        setPauseReason("Paused by household guard (Sabbath/Quiet Hours).");
        eventBus.emit("session:paused", {
          sessionId,
          domain: "cleaning",
          reason: pausePolicies.constants?.REASON_SABBATH || "guard",
        });
      }
    } catch (_e) {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto write session to calendar timeline on start (defensive)
  useEffect(() => {
    (async () => {
      try {
        await calendarSync.writeSession?.({
          id: sessionId,
          domain: "cleaning",
          title,
          startedAt,
          steps: steps.map((s, i) => ({
            title: s.title,
            offsetMs: i * 60_000 * (s.duration || 5),
          })),
        });
      } catch (_e) {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Tick: simple step auto-advance using step durations (if present)
  useEffect(() => {
    clearInterval(timerRef.current);
    if (paused) return;
    const current = steps[idx];
    if (!current?.duration) return; // no auto-advance

    const ms = current.duration * 60_000;
    const start = Date.now();
    timerRef.current = setInterval(() => {
      if (Date.now() - start >= ms) {
        clearInterval(timerRef.current);
        goNext();
      }
    }, 1000);
    return () => clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, paused, steps]);

  // Orchestration listeners (defensive)
  useEffect(() => {
    const onStep = (payload) => {
      if (payload?.sessionId !== sessionId || payload?.domain !== "cleaning")
        return;
      if (payload.type === "next") goNext();
      if (payload.type === "prev") goPrev();
      if (payload.type === "pause") onPause(payload.reason);
      if (payload.type === "resume") onResume();
    };
    eventBus.on?.("session:control", onStep);
    return () => eventBus.off?.("session:control", onStep);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, idx, paused]);

  // Derived progress
  const progress = useMemo(() => {
    const total = steps.length || 1;
    const pct = Math.round(((idx + 1) / total) * 100);
    return { total, pct };
  }, [idx, steps.length]);

  const goNext = useCallback(() => {
    setIdx((i) => Math.min(i + 1, Math.max(steps.length - 1, 0)));
    eventBus.emit("session:step:changed", {
      sessionId,
      domain: "cleaning",
      index: Math.min(idx + 1, steps.length - 1),
    });
  }, [idx, sessionId, steps.length]);

  const goPrev = useCallback(() => {
    setIdx((i) => Math.max(i - 1, 0));
    eventBus.emit("session:step:changed", {
      sessionId,
      domain: "cleaning",
      index: Math.max(idx - 1, 0),
    });
  }, [idx, sessionId]);

  const onPause = useCallback(
    (reason = pausePolicies.constants?.REASON_USER || "user") => {
      setPaused(true);
      const message =
        reason === pausePolicies.constants?.REASON_SAFETY
          ? "Paused for safety."
          : reason === pausePolicies.constants?.REASON_SABBATH
          ? "Paused by household guard (Sabbath/Quiet Hours)."
          : "Paused by user.";
      setPauseReason(message);
      eventBus.emit("session:paused", {
        sessionId,
        domain: "cleaning",
        reason,
      });
    },
    [sessionId]
  );

  const onResume = useCallback(() => {
    const ok = pausePolicies.canContinue?.({
      domain: "cleaning",
      quietHours,
      sabbath,
      now: new Date(),
    });
    if (!ok) {
      setPauseReason("Cannot resume yet due to household guard.");
      return;
    }
    setPaused(false);
    setPauseReason("");
    eventBus.emit("session:resumed", { sessionId, domain: "cleaning" });
  }, [sessionId, quietHours, sabbath]);

  const onExit = useCallback(() => {
    eventBus.emit("session:ended", {
      sessionId,
      domain: "cleaning",
      finishedAt: nowISO(),
    });
    navigate("/tier2/household/chores", { replace: true });
  }, [navigate, sessionId]);

  /* -------------------------------- Save: Favorite Session ------------------------------- */
  const saveFavorite = useCallback(async () => {
    const fav = {
      id: `fav-${sessionId}`,
      domain: "cleaning",
      title: title || "Cleaning Session",
      templateId,
      steps,
      createdAt: startedAt,
      updatedAt: Date.now(),
      meta: { source: "user", scheduleSuggestion },
    };
    const res = await (favHook.save?.(fav) || Promise.resolve({ ok: false }));
    if (res?.ok) {
      eventBus.emit("favorites:changed", { domain: "cleaning" });
      alert("Saved to Favorites ✓");
    } else {
      alert("Could not save favorite.");
    }
  }, [
    favHook,
    scheduleSuggestion,
    sessionId,
    startedAt,
    steps,
    templateId,
    title,
  ]);

  /* -------------------------------- Save: Schedule Template ------------------------------ */
  const saveScheduleTemplate = useCallback(async () => {
    // Suggest schedule: next morning or user rhythm
    const base = new Date();
    if (rhythms?.preferMorning) {
      base.setHours(8, 0, 0, 0);
      if (base < new Date()) base.setDate(base.getDate() + 1);
    }
    const sched = {
      id: `sched-${uid()}`,
      domain: "cleaning",
      title: `${title} – Schedule`,
      sessionTemplate: { templateId, steps },
      rrule: "FREQ=WEEKLY;BYDAY=MO,TH", // editable later in Schedule UI
      firstRunAt: base.toISOString(),
    };
    setScheduleSuggestion(sched);

    // Persist schedule template (hook or localStorage)
    const res = await (schedHook.save?.(sched) ||
      Promise.resolve({ ok: false }));
    if (res?.ok) {
      eventBus.emit("schedules:changed", { domain: "cleaning" });
      alert("Schedule template saved ✓");
    } else {
      alert("Could not save schedule template.");
    }

    // Offer to write immediate calendar entries (defensive)
    try {
      await calendarSync.addEvents?.({
        domain: "cleaning",
        title: sched.title,
        rrule: sched.rrule,
        firstRunAt: sched.firstRunAt,
        meta: { sessionTemplateId: sched.id, source: "SessionRunner" },
      });
    } catch (_e) {}
  }, [
    calendarSync,
    rhythms?.preferMorning,
    schedHook,
    steps,
    templateId,
    title,
  ]);

  /* --------------------------------- Render --------------------------------- */
  const currentStep = steps[idx] || {};
  const shortagesBadge = shortages?.length ? (
    <span className="ml-2 inline-flex items-center px-2 py-0.5 text-xs rounded-full bg-amber-100 border border-amber-300">
      {shortages.length} supply issue{shortages.length > 1 ? "s" : ""}
    </span>
  ) : null;

  return (
    <div className="max-w-3xl mx-auto p-3 md:p-6">
      {/* Top bar */}
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm opacity-70">
          <Link className="underline" to="/tier2/household/chores">
            Chores
          </Link>
          <span className="mx-1">/</span>
          <span>Session</span>
          {shortagesBadge}
        </div>
        <div className="text-xs opacity-70">{kbHint}</div>
      </div>

      {/* Banner */}
      <Banner
        title={`${title} (${progress.pct}%)`}
        subtitle={subtitle}
        onExit={onExit}
        onPause={onPause}
        onResume={onResume}
        isPaused={paused}
      />

      {/* Actions */}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className="px-3 py-2 rounded-xl border bg-blue-50 hover:bg-blue-100"
          onClick={saveFavorite}
        >
          Save Favorite Session
        </button>
        <button
          className="px-3 py-2 rounded-xl border bg-purple-50 hover:bg-purple-100"
          onClick={saveScheduleTemplate}
        >
          Save as Schedule Template
        </button>
        <button
          className="px-3 py-2 rounded-xl border bg-zinc-50 hover:bg-zinc-100"
          onClick={() => navigate("/scheduler/settings")}
        >
          Open Scheduler Settings
        </button>
      </div>

      {/* Current step card */}
      <div className="mt-4 p-4 rounded-2xl border bg-white dark:bg-zinc-900">
        <div className="flex items-baseline justify-between">
          <div className="text-lg font-semibold">
            {currentStep.title || "Step"}
          </div>
          <div className="text-xs opacity-70">
            Step {idx + 1} of {steps.length}
          </div>
        </div>
        {currentStep.hints ? (
          <div className="mt-1 text-sm opacity-80">{currentStep.hints}</div>
        ) : null}
        <div className="mt-3 flex gap-2">
          <button
            className="px-3 py-2 rounded-xl border bg-zinc-50 hover:bg-zinc-100"
            onClick={goPrev}
            disabled={idx === 0}
          >
            ← Back
          </button>
          <button
            className="px-3 py-2 rounded-xl border bg-emerald-50 hover:bg-emerald-100"
            onClick={goNext}
            disabled={idx >= steps.length - 1}
          >
            Next →
          </button>
        </div>
      </div>

      {/* Timeline */}
      <div className="mt-4">
        <Timeline steps={steps} currentIndex={idx} />
      </div>

      {/* Pause modal */}
      <PauseModal
        open={paused}
        reason={pauseReason}
        onClose={() => setPauseReason("")}
        onContinue={onResume}
      />

      {/* Footer / secondary info */}
      <div className="mt-6 text-xs opacity-60">
        Template: <code>{templateId}</code> • Session ID:{" "}
        <code>{sessionId}</code> • Started:{" "}
        <time dateTime={startedAt}>{new Date(startedAt).toLocaleString()}</time>
      </div>
    </div>
  );
}
