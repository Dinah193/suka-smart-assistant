// ES2015-safe, Tailwind utility classes, defensive deps, no optional chaining.
import React, { useEffect, useRef, useState } from "react";

let eventBus = {
  on: function () {},
  off: function () {},
  emit: function () {},
};
try {
  var eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus)) || eventBus;
} catch (e) {}

let prepEngine = null; // not strictly needed here, but kept for parity
try {
  prepEngine = require("@/engines/planning/prepConsolidationEngine");
} catch (e) {}

let Orchestrator = null;
try {
  Orchestrator = require("@/services/session/PrepSessionOrchestrator");
} catch (e) {}

function SectionTitle(props) {
  return (
    <h4 className="text-sm font-semibold text-gray-700 mb-2">
      {props.children}
    </h4>
  );
}

function Badge(props) {
  var color =
    props.variant === "info"
      ? "bg-sky-100 text-sky-700 border-sky-200"
      : props.variant === "warn"
      ? "bg-amber-100 text-amber-700 border-amber-200"
      : props.variant === "ok"
      ? "bg-emerald-100 text-emerald-700 border-emerald-200"
      : "bg-gray-100 text-gray-700 border-gray-200";
  return (
    <span
      className={
        "inline-flex items-center px-2 py-0.5 rounded-md text-xs border " +
        color
      }
    >
      {props.children}
    </span>
  );
}

export default function PrepConsolidationDrawer(props) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [nextStep, setNextStep] = useState(null);

  // NEW: state coming from Orchestrator drawer feed
  const [drawerState, setDrawerState] = useState(null);
  const [leadSessions, setLeadSessions] = useState([]); // scheduled advance sessions
  const [timersPreview, setTimersPreview] = useState([]);
  const [sabbathGuard, setSabbathGuard] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [store, setStore] = useState("Default");
  const [targetStartISO, setTargetStartISO] = useState("");

  const streamRef = useRef(null);

  /* --------------------------------- Bus wiring -------------------------------- */
  useEffect(function () {
    function handleReady(payload) {
      setOpen(true);
      // allow pre-seeded suggestion lists from payload
      if (payload && payload.suggestions && payload.suggestions.length)
        setSuggestions(payload.suggestions);
      if (payload && payload.store) setStore(payload.store);
      if (payload && payload.sabbathGuard != null)
        setSabbathGuard(!!payload.sabbathGuard);
      if (payload && payload.targetStartISO)
        setTargetStartISO(payload.targetStartISO);
    }
    function handleDrawerState(payload) {
      setDrawerState(payload);
      // sneak a timers preview if present
      if (payload && payload.timersPreview)
        setTimersPreview(payload.timersPreview);
    }
    try {
      if (eventBus.on) {
        eventBus.on("prep:consolidation:ready", handleReady);
        eventBus.on("prep:drawer:state", handleDrawerState);
      }
    } catch (e) {}
    return function cleanup() {
      try {
        if (eventBus.off) {
          eventBus.off("prep:consolidation:ready", handleReady);
          eventBus.off("prep:drawer:state", handleDrawerState);
        }
      } catch (e) {}
    };
  }, []);

  // allow external open/close toggles
  useEffect(
    function () {
      if (typeof props.open === "boolean") setOpen(props.open);
    },
    [props.open]
  );

  // accept incoming suggestions from parent
  useEffect(
    function () {
      if (Array.isArray(props.suggestions) && props.suggestions.length)
        setSuggestions(props.suggestions);
    },
    [props.suggestions]
  );

  // optional defaults from parent
  useEffect(
    function () {
      if (typeof props.sabbathGuard === "boolean")
        setSabbathGuard(!!props.sabbathGuard);
    },
    [props.sabbathGuard]
  );

  useEffect(
    function () {
      if (typeof props.dryRun === "boolean") setDryRun(!!props.dryRun);
    },
    [props.dryRun]
  );

  useEffect(
    function () {
      if (typeof props.store === "string" && props.store) setStore(props.store);
    },
    [props.store]
  );

  useEffect(
    function () {
      if (typeof props.targetStartISO === "string" && props.targetStartISO)
        setTargetStartISO(props.targetStartISO);
    },
    [props.targetStartISO]
  );

  function close() {
    setOpen(false);
    if (streamRef.current && streamRef.current.destroy)
      streamRef.current.destroy();
  }

  function activeSuggestion() {
    if (!suggestions.length) return null;
    var idx = Math.max(0, Math.min(activeIdx, suggestions.length - 1));
    return suggestions[idx];
  }

  /* --------------------------------- Actions ---------------------------------- */

  // NEW: Single-call: create session, schedule lead-prep, (preview or start) timers, stream steps
  function orchestrateNow() {
    var sug = activeSuggestion();
    if (!sug || !Orchestrator) return;

    // clean any previous stream
    if (streamRef.current && streamRef.current.destroy)
      streamRef.current.destroy();

    var opts = {
      store: store,
      sabbathGuard: !!sabbathGuard,
      dryRun: !!dryRun,
      targetStartISO: targetStartISO,
    };

    var result = Orchestrator.orchestrate(sug, opts) || {};
    setLeadSessions(result.leadSessions || []);
    setTimersPreview(
      (result.drawerState && result.drawerState.timersPreview) || []
    );

    // begin next-steps stream (ensure we set the ref so we can control it)
    if (result.stream) {
      streamRef.current = result.stream;
      result.stream.onUpdate(function (payload) {
        setNextStep(payload.current);
        try {
          if (eventBus.emit)
            eventBus.emit("nba:hint", {
              type: "NEXT_STEP",
              label: payload.current
                ? payload.current.label || payload.current.description
                : "All steps done",
            });
        } catch (e) {}
      });
    }

    // open timer panel
    try {
      if (eventBus.emit)
        eventBus.emit("ui:open", {
          target: "MultiTimerPanel",
          groupId: sug.id,
        });
    } catch (e) {}
  }

  function previewTimers() {
    var sug = activeSuggestion();
    if (!sug || !Orchestrator) return;
    var preview = Orchestrator.startTimersForSuggestion(sug, {
      sabbathGuard: !!sabbathGuard,
      dryRun: true,
      store: store,
    });
    setTimersPreview(preview || []);
  }

  function autoBuildSessionOnly() {
    var sug = activeSuggestion();
    if (!sug || !Orchestrator) return;
    Orchestrator.buildFromSuggestion(sug, {
      store: store,
      sabbathGuard: !!sabbathGuard,
    });
  }

  function controlTimers(command) {
    // emits for a matching MultiTimer implementation
    var sug = activeSuggestion();
    var groupId = (sug && sug.id) || "grp:unknown";
    try {
      if (eventBus.emit) {
        if (command === "pause")
          eventBus.emit("multitimer:group:pause", { groupId: groupId });
        if (command === "resume")
          eventBus.emit("multitimer:group:resume", { groupId: groupId });
        if (command === "skip")
          eventBus.emit("multitimer:group:skip", {
            groupId: groupId,
            count: 1,
          });
        if (command === "complete")
          eventBus.emit("multitimer:group:complete", { groupId: groupId });
      }
    } catch (e) {}
    // also reflect into the stream if present
    if (streamRef.current) {
      if (command === "skip" && streamRef.current.skip)
        streamRef.current.skip(1);
      if (command === "complete" && streamRef.current.completeAll)
        streamRef.current.completeAll();
    }
  }

  /* --------------------------------- Renderers -------------------------------- */

  function renderReasons(sug) {
    var reasons = (sug && sug.reasons) || [];
    if (!reasons.length) return null;
    return (
      <ul className="list-disc ml-5 text-xs text-gray-600">
        {reasons.map(function (r, i) {
          return <li key={i}>{r}</li>;
        })}
      </ul>
    );
  }

  function renderChecklist(sug) {
    var cl = sug && sug.checklist;
    if (!cl) return null;
    return (
      <div className="space-y-3">
        <div>
          <SectionTitle>Steps</SectionTitle>
          <ol className="list-decimal ml-5 text-sm">
            {(cl.steps || []).map(function (s, i) {
              var label = s.label || s.description || "Step";
              var isNext =
                nextStep &&
                (nextStep.label === label || nextStep.description === label);
              return (
                <li
                  key={i}
                  className={isNext ? "font-semibold text-emerald-700" : ""}
                >
                  {label}{" "}
                  {s.domain ? (
                    <span className="text-gray-400">({s.domain})</span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <SectionTitle>Tools</SectionTitle>
            <div className="text-xs text-gray-700">
              {(cl.tools || []).join(", ") || "—"}
            </div>
          </div>
          <div>
            <SectionTitle>Consumables</SectionTitle>
            <div className="text-xs text-gray-700">
              {(cl.consumables || []).join(", ") || "—"}
            </div>
          </div>
          <div>
            <SectionTitle>Appliances</SectionTitle>
            <div className="text-xs text-gray-700">
              {(cl.appliances || []).join(", ") || "—"}
            </div>
          </div>
          <div>
            <SectionTitle>Ingredients</SectionTitle>
            <div className="text-xs text-gray-700">
              {(cl.ingredients || []).slice(0, 8).join(", ") || "—"}
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderLeadSessions() {
    if (!leadSessions || !leadSessions.length) return null;
    return (
      <div className="mt-3 border rounded-lg p-3">
        <SectionTitle>Scheduled Lead Prep</SectionTitle>
        <ul className="space-y-2">
          {leadSessions.map(function (s, i) {
            return (
              <li key={i} className="flex items-start justify-between">
                <div className="text-sm">
                  <div className="font-medium">{s.title || "Lead Prep"}</div>
                  <div className="text-xs text-gray-500">
                    {s.when ? new Date(s.when).toLocaleString() : ""}
                  </div>
                </div>
                <Badge variant="info">{s.domain || "prep"}</Badge>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  function renderTimersPreview() {
    if (!timersPreview || !timersPreview.length) return null;
    return (
      <div className="mt-3 border rounded-lg p-3">
        <SectionTitle>Timers Preview</SectionTitle>
        <ul className="divide-y divide-gray-100">
          {timersPreview.map(function (t, i) {
            return (
              <li
                key={t.id || i}
                className="py-2 flex items-center justify-between"
              >
                <div>
                  <div className="text-sm font-medium">{t.label || "Task"}</div>
                  <div className="text-xs text-gray-500">
                    {(t.minutes || 0) + " min"} · starts +
                    {t.startOffsetSec || 0}s
                  </div>
                </div>
                <Badge variant={t.disabled ? "warn" : "ok"}>
                  {t.disabled ? "Disabled" : "Ready"}
                </Badge>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  if (!open) return null;

  var sug = activeSuggestion();

  return (
    <div className="fixed inset-y-0 right-0 w-full max-w-md bg-white shadow-2xl border-l border-gray-200 z-40 flex flex-col">
      <div className="p-4 border-b">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold">Prep Consolidation</h3>
            <p className="text-xs text-gray-500">
              Batch similar tasks, schedule lead prep, run timers, and follow
              next steps.
            </p>
          </div>
          <button
            onClick={close}
            className="px-2 py-1 rounded-md border text-sm"
          >
            Close
          </button>
        </div>
      </div>

      {!suggestions || !suggestions.length ? (
        <div className="p-6 text-sm text-gray-600">
          No suggestions yet. Run an analysis from the Planner or Batch Session
          Planner.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-sm font-semibold">
                {sug ? sug.title || "Batch Prep" : "Batch Prep"}
              </div>
              <div className="text-xs text-gray-500">
                {sug && sug.window
                  ? new Date(sug.window.start).toLocaleString() +
                    " → " +
                    new Date(sug.window.end).toLocaleTimeString()
                  : ""}
              </div>
              {drawerState && drawerState.aisleHint ? (
                <div className="mt-1">
                  <Badge>{drawerState.aisleHint}</Badge>
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={function () {
                  if (activeIdx > 0) setActiveIdx(activeIdx - 1);
                }}
                className="px-2 py-1 text-sm border rounded-md"
                disabled={activeIdx <= 0}
              >
                Prev
              </button>
              <button
                onClick={function () {
                  if (activeIdx < suggestions.length - 1)
                    setActiveIdx(activeIdx + 1);
                }}
                className="px-2 py-1 text-sm border rounded-md"
                disabled={activeIdx >= suggestions.length - 1}
              >
                Next
              </button>
            </div>
          </div>

          {/* Controls panel */}
          <div className="border rounded-lg p-3">
            <SectionTitle>Session Options</SectionTitle>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">
                    Store
                  </label>
                  <input
                    value={store}
                    onChange={function (e) {
                      setStore(e.target.value);
                    }}
                    className="w-full border rounded-md px-2 py-1 text-sm"
                    placeholder="Default"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">
                    Target Start (ISO)
                  </label>
                  <input
                    value={targetStartISO}
                    onChange={function (e) {
                      setTargetStartISO(e.target.value);
                    }}
                    className="w-full border rounded-md px-2 py-1 text-sm"
                    placeholder="2025-10-22T18:00:00-05:00"
                  />
                </div>
              </div>
              <div className="flex items-center gap-4">
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={sabbathGuard}
                    onChange={function (e) {
                      setSabbathGuard(e.target.checked);
                    }}
                  />
                  <span>Sabbath guard</span>
                </label>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={dryRun}
                    onChange={function (e) {
                      setDryRun(e.target.checked);
                    }}
                  />
                  <span>Preview only (dry-run)</span>
                </label>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={orchestrateNow}
                  className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold shadow hover:bg-emerald-700 transition"
                >
                  Orchestrate: Lead Prep + Timers + Steps
                </button>
                <button
                  onClick={previewTimers}
                  className="px-3 py-2 rounded-lg bg-sky-600 text-white text-sm font-semibold shadow hover:bg-sky-700 transition"
                >
                  Preview Timers
                </button>
                <button
                  onClick={autoBuildSessionOnly}
                  className="px-3 py-2 rounded-lg bg-gray-800 text-white text-sm font-semibold shadow hover:bg-black transition"
                >
                  Build Session Only
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={function () {
                    controlTimers("pause");
                  }}
                  className="px-2 py-1 text-sm border rounded-md"
                >
                  Pause
                </button>
                <button
                  onClick={function () {
                    controlTimers("resume");
                  }}
                  className="px-2 py-1 text-sm border rounded-md"
                >
                  Resume
                </button>
                <button
                  onClick={function () {
                    controlTimers("skip");
                  }}
                  className="px-2 py-1 text-sm border rounded-md"
                >
                  Skip
                </button>
                <button
                  onClick={function () {
                    controlTimers("complete");
                  }}
                  className="px-2 py-1 text-sm border rounded-md"
                >
                  Complete
                </button>
              </div>
            </div>
          </div>

          {/* Reasons + Checklist */}
          <div>{renderReasons(sug)}</div>
          <div className="border rounded-lg p-3">{renderChecklist(sug)}</div>

          {/* Lead sessions & timers preview */}
          {renderLeadSessions()}
          {renderTimersPreview()}

          {/* Helper copy */}
          <p className="text-xs text-gray-500">
            We’ll schedule separate lead-prep sessions for long items (defrost,
            soak, brine, ferment/proof), start or preview multi-timers, and
            stream the next step as each timer completes.
          </p>
        </div>
      )}
    </div>
  );
}
