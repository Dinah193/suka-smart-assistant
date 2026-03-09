// SessionHUD.jsx — always-on HUD for execution & prep (ES2015-safe)
import React, { useEffect, useState, Suspense } from "react";

/* ----------------------------- Defensive imports ---------------------------- */
var eventBus = {
  on: function () {},
  off: function () {},
  emit: function () {},
};
try {
  var eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus)) || eventBus;
} catch (e) {}

var exec = null;
try {
  exec = require("@/engines/session/sessionExecutionEngine");
} catch (e) {}

/** Favorites: SESSIONS (not plans) */
var useFavoriteSessions = null;
try {
  var favMod = require("@/hooks/useFavoriteSessions");
  useFavoriteSessions =
    (favMod && (favMod.useFavoriteSessions || favMod.default)) || null;
} catch (e) {}

/** Save Session modal (lazy) */
var SaveSessionModalLazy = null;
try {
  SaveSessionModalLazy = React.lazy(function () {
    return import("@/components/session/SaveSessionModal.jsx");
  });
} catch (e) {}

/* ----------------------------------- UI bits -------------------------------- */
function Pill(props) {
  return (
    <span
      className={
        "inline-block px-2 py-0.5 text-xs rounded-full border " +
        (props.className || "")
      }
    >
      {props.children}
    </span>
  );
}
function Badge(props) {
  var color =
    props.variant === "danger"
      ? "bg-red-50 text-red-700 border-red-300"
      : props.variant === "warn"
      ? "bg-amber-50 text-amber-700 border-amber-300"
      : props.variant === "ok"
      ? "bg-emerald-50 text-emerald-700 border-emerald-300"
      : "bg-gray-50 text-gray-700 border-gray-300";
  return (
    <span
      className={
        "inline-flex items-center px-2 py-0.5 rounded-md text-[11px] border " +
        color
      }
    >
      {props.children}
    </span>
  );
}
function Banner(props) {
  var tone = props.tone || "info";
  var cls =
    tone === "danger"
      ? "bg-red-50 border-red-200 text-red-800"
      : tone === "warn"
      ? "bg-amber-50 border-amber-200 text-amber-800"
      : "bg-blue-50 border-blue-200 text-blue-800";
  return (
    <div className={"w-full text-xs px-3 py-2 border rounded-md " + cls}>
      {props.children}
    </div>
  );
}
function Button(props) {
  var tone = props.tone || "subtle";
  var base =
    "px-2 py-1 text-xs border rounded-md transition active:translate-y-[1px]";
  var cls =
    tone === "primary"
      ? "bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700"
      : tone === "ghost"
      ? "bg-transparent hover:bg-gray-100"
      : "bg-white hover:bg-gray-50";
  return (
    <button
      onClick={props.onClick}
      className={
        base + " " + cls + (props.className ? " " + props.className : "")
      }
      disabled={props.disabled}
      title={props.title}
    >
      {props.children}
    </button>
  );
}

/* ---------------------------------- Helpers --------------------------------- */
function safeFile(name) {
  return String(name || "session")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/-+/g, "-");
}
function toastSafe(message, variant) {
  try {
    eventBus.emit("ui.toast", {
      message: message,
      variant: variant || "success",
    });
  } catch (e) {
    if (variant === "error") console.warn(message);
    else console.log(message);
  }
}

/* --------------------------------- Component -------------------------------- */
export default function SessionHUD() {
  // Active execution context
  var _useState = useState(null),
    active = _useState[0],
    setActive = _useState[1]; // {id,title,domain,status,index,total,step,progress?}

  // Live safety & inventory cues
  var _hz = useState([]),
    hazards = _hz[0],
    setHazards = _hz[1]; // strings
  var _ppe = useState([]),
    ppe = _ppe[0],
    setPpe = _ppe[1];
  var _inv = useState([]),
    invBadges = _inv[0],
    setInvBadges = _inv[1]; // [{name,status,aisle}]

  // Timers & group state
  var _t = useState([]),
    timers = _t[0],
    setTimers = _t[1]; // [{id,label,minutes,disabled}]
  var _gp = useState(false),
    groupPaused = _gp[0],
    setGroupPaused = _gp[1];

  // Lead-prep visibility from Drawer/Orchestrator
  var _lead = useState([]),
    lead = _lead[0],
    setLead = _lead[1]; // [{title,when,domain}]

  // Session meta (store, sabbath, target)
  var _meta = useState({ store: "Default", sabbath: false, target: null }),
    meta = _meta[0],
    setMeta = _meta[1];

  // Guards / alerts / inline helpers
  var _grd = useState({}),
    guards = _grd[0],
    setGuards = _grd[1]; // { sabbathActive, incompatibleChemicals? }
  var _al = useState([]),
    alerts = _al[0],
    setAlerts = _al[1];
  var _cl = useState(null),
    checklist = _cl[0],
    setChecklist = _cl[1];
  var _lnk = useState([]),
    links = _lnk[0],
    setLinks = _lnk[1];

  // UX: save/favorite/export
  var _saveOpen = useState(false),
    saveOpen = _saveOpen[0],
    setSaveOpen = _saveOpen[1];
  var _fav = useState(false),
    fav = _fav[0],
    setFav = _fav[1];

  // Favorites hook (defensive)
  var favApi = null;
  try {
    favApi = useFavoriteSessions
      ? useFavoriteSessions((active && active.domain) || "session")
      : null;
  } catch (e) {}

  function setActiveSafe(next) {
    setActive(typeof next === "function" ? next : next);
  }

  /* ------------------------------ Subscriptions ----------------------------- */
  useEffect(function () {
    // Legacy → state builder
    function onCreated(ev) {
      setActiveSafe(function (prev) {
        if (prev && prev.id === (ev && ev.id)) return prev;
        return {
          id: ev && ev.id,
          title: (ev && ev.title) || "Session",
          domain: (ev && ev.domain) || "session",
          status: "READY",
          index: 0,
          total: 0,
          step: null,
          progress: { done: 0, total: 0 },
        };
      });
    }
    function onProgress(ev) {
      // ev: {id,status,index,total,step,domain,hazards,ppe,guards,progress,title?}
      setActiveSafe(function (prev) {
        var base =
          prev && prev.id === (ev && ev.id)
            ? prev
            : {
                id: ev && ev.id,
                title: (prev && prev.title) || (ev && ev.title) || "Session",
                domain: (ev && ev.domain) || (prev && prev.domain) || "session",
              };
        return {
          id: base.id,
          title: (ev && ev.title) || base.title,
          domain: (ev && ev.domain) || base.domain,
          status: (ev && ev.status) || base.status || "RUNNING",
          index: Number((ev && ev.index) || 0),
          total: Number((ev && ev.total) || base.total || 0),
          step: (ev && ev.step) || base.step || null,
          progress: (ev && ev.progress) ||
            base.progress || {
              done: Number((ev && ev.index) || 0),
              total: Number((ev && ev.total) || 0),
            },
        };
      });
      if (ev && ev.hazards)
        setHazards(Array.isArray(ev.hazards) ? ev.hazards : []);
      if (ev && ev.ppe) setPpe(Array.isArray(ev.ppe) ? ev.ppe : []);
      if (ev && ev.guards) setGuards(ev.guards || {});
      setMeta(function (m) {
        var sab = !!(ev && ev.guards && ev.guards.sabbathActive);
        return { store: m.store, sabbath: sab, target: m.target };
      });
    }
    function onDone(ev) {
      setActiveSafe(function (prev) {
        return prev && prev.id === (ev && ev.id) ? null : prev;
      });
      setTimers([]);
      setGroupPaused(false);
      setAlerts([]);
      setChecklist(null);
      setLinks([]);
    }

    // New shared orchestration → normalize to legacy handlers
    function onStateChanged(payload) {
      var s = (payload && (payload.session || payload)) || null;
      if (!s) return;
      onProgress({
        id: s.id,
        title:
          s.title ||
          s.planTitle ||
          (s.domain
            ? s.domain.charAt(0).toUpperCase() + s.domain.slice(1) + " Session"
            : "Session"),
        domain: s.domain || "session",
        status: s.active ? "RUNNING" : "PAUSED",
        index:
          (s.currentStep && (s.currentStep.index || s.currentStep.idx)) || 0,
        total: s.totalSteps || (s.currentStep && s.currentStep.total) || 0,
        step: s.currentStep || s.nextStep || null,
        progress:
          typeof s.progressPct === "number"
            ? { done: Math.round(s.progressPct), total: 100 }
            : null,
        guards: s.guards || null,
        hazards: s.hazards || null,
        ppe: s.ppe || null,
      });
    }
    function onTick(payload) {
      // Lightweight tick updates (remaining/time/progress only)
      if (!payload) return;
      setActiveSafe(function (prev) {
        if (!prev) return prev;
        var same = !payload.sessionId || payload.sessionId === prev.id;
        if (!same) return prev;
        var p =
          typeof payload.progressPct === "number"
            ? {
                done: Math.max(
                  0,
                  Math.min(100, Math.round(payload.progressPct))
                ),
                total: 100,
              }
            : prev.progress;
        var step = prev.step ? { ...prev.step } : null;
        if (step && typeof payload.stepRemainingSec === "number")
          step.remainingSec = payload.stepRemainingSec;
        return { ...prev, step: step, progress: p };
      });
    }

    // Multi-timer lifecycle (unchanged)
    function mountTimers(payload, isPreview) {
      if (!payload || !payload.timers) return;
      setTimers(function (prev) {
        var next = prev.slice();
        for (var i = 0; i < payload.timers.length; i++) {
          var t = payload.timers[i];
          var idx = -1;
          for (var j = 0; j < next.length; j++)
            if (next[j].id === t.id) {
              idx = j;
              break;
            }
          var item = {
            id: t.id,
            label: t.label,
            minutes: t.minutes,
            disabled: isPreview ? true : !!t.disabled,
          };
          if (idx >= 0) next[idx] = item;
          else next.push(item);
        }
        return next;
      });
      setGroupPaused(false);
    }
    function onTimerStart(ev) {
      mountTimers(ev, false);
    }
    function onTimerPreview(ev) {
      mountTimers(ev, true);
    }
    function onTimerDone(ev) {
      setTimers(function (prev) {
        return prev.filter(function (t) {
          return t.id !== (ev && ev.id);
        });
      });
    }
    function onGroupPause() {
      setGroupPaused(true);
    }
    function onGroupPaused() {
      setGroupPaused(true);
    }
    function onGroupResume() {
      setGroupPaused(false);
    }
    function onGroupStop(payload) {
      setTimers(function () {
        return [];
      });
    }

    // Hazards / safety hints from NBA (legacy)
    function onSafety(ev) {
      if (!ev || !ev.label) return;
      if (ev.type === "SAFETY" && ev.label.indexOf("Hazards: ") === 0) {
        var hs = ev.label
          .replace("Hazards: ", "")
          .split(",")
          .map(function (x) {
            return x.trim();
          })
          .filter(Boolean);
        setHazards(hs);
      }
      if (ev.type === "PPE" && ev.label.indexOf("PPE: ") === 0) {
        var pp = ev.label
          .replace("PPE: ", "")
          .split(",")
          .map(function (x) {
            return x.trim();
          })
          .filter(Boolean);
        setPpe(pp);
      }
    }

    // Inventory signal badges (short/low/surplus)
    function onInvItemStatus(ev) {
      if (!ev || !ev.name) return;
      setInvBadges(function (prev) {
        var rest = prev.filter(function (b) {
          return b.name !== ev.name;
        });
        var entry = {
          name: ev.name,
          status: ev.status,
          aisle: ev.meta && ev.meta.aisle ? ev.meta.aisle : null,
        };
        if (ev.status === "short" || ev.status === "low") rest.unshift(entry);
        return rest.slice(0, 6);
      });
    }

    // Lead prep & drawer meta
    function onLeadSessions(payload) {
      var list = payload && payload.sessions ? payload.sessions : [];
      setLead(list.slice(0, 5));
    }
    function onDrawerState(payload) {
      if (!payload) return;
      setMeta(function (m) {
        return {
          store: payload.store || m.store,
          sabbath: !!payload.sabbathGuard,
          target: payload.etaISO || m.target,
        };
      });
    }

    // Inline orchestration helpers
    function onAlertsShow(payload) {
      setAlerts(
        payload && Array.isArray(payload.issues)
          ? payload.issues.slice(0, 5)
          : []
      );
    }
    function onChecklistOpen(payload) {
      if (!payload) return;
      setChecklist({
        title: payload.title || "Checklist",
        items: Array.isArray(payload.items) ? payload.items.slice(0, 8) : [],
      });
    }
    function onLinksOpen(payload) {
      setLinks(
        payload && Array.isArray(payload.links) ? payload.links.slice(0, 4) : []
      );
    }
    function onCheckPrompt(payload) {
      setChecklist({ title: (payload && payload.label) || "Check", items: [] });
    }

    try {
      if (eventBus.on) {
        // Legacy
        eventBus.on("session:created", onCreated);
        eventBus.on("session:progress", onProgress);
        eventBus.on("session:done", onDone);
        eventBus.on("session:log", function () {}); // placeholder

        // New orchestration
        eventBus.on("session.state.changed", onStateChanged);
        eventBus.on("session.tick", onTick);

        // Timers
        eventBus.on("multitimer:start", onTimerStart);
        eventBus.on("multitimer:preview", onTimerPreview);
        eventBus.on("multitimer:timer:done", onTimerDone);
        eventBus.on("multitimer:group:pause", onGroupPause);
        eventBus.on("multitimer:group:paused", onGroupPaused);
        eventBus.on("multitimer:group:resumed", onGroupResume);
        eventBus.on("multitimer:stop", onGroupStop);

        // Safety & inventory
        eventBus.on("nba:hint", onSafety);
        eventBus.on("inventory:item:status", onInvItemStatus);

        // Lead prep + drawer
        eventBus.on("prep:lead:sessions", onLeadSessions);
        eventBus.on("prep:drawer:state", onDrawerState);

        // Inline surfaces
        eventBus.on("alerts:show", onAlertsShow);
        eventBus.on("checklist:open", onChecklistOpen);
        eventBus.on("links:open", onLinksOpen);
        eventBus.on("check:prompt", onCheckPrompt);
      }
    } catch (e) {}

    return function cleanup() {
      try {
        if (eventBus.off) {
          eventBus.off("session:created", onCreated);
          eventBus.off("session:progress", onProgress);
          eventBus.off("session:done", onDone);

          eventBus.off("session.state.changed", onStateChanged);
          eventBus.off("session.tick", onTick);

          eventBus.off("multitimer:start", onTimerStart);
          eventBus.off("multitimer:preview", onTimerPreview);
          eventBus.off("multitimer:timer:done", onTimerDone);
          eventBus.off("multitimer:group:pause", onGroupPause);
          eventBus.off("multitimer:group:paused", onGroupPaused);
          eventBus.off("multitimer:group:resumed", onGroupResume);
          eventBus.off("multitimer:stop", onGroupStop);

          eventBus.off("nba:hint", onSafety);
          eventBus.off("inventory:item:status", onInvItemStatus);

          eventBus.off("prep:lead:sessions", onLeadSessions);
          eventBus.off("prep:drawer:state", onDrawerState);

          eventBus.off("alerts:show", onAlertsShow);
          eventBus.off("checklist:open", onChecklistOpen);
          eventBus.off("links:open", onLinksOpen);
          eventBus.off("check:prompt", onCheckPrompt);
        }
      } catch (e) {}
    };
  }, []);

  // Auto-wire favorites for the active session
  useEffect(
    function () {
      try {
        if (!favApi || !active || !active.id) return;
        setFav(!!favApi.isFavorite && !!favApi.isFavorite(active.id));
      } catch (e) {}
    },
    [active && active.id]
  );

  if (!active) return null;

  var currentIndex = Number(active.index || 0);
  var total = Number(active.total || 0);
  // Prefer engine-provided progress, else derive
  var doneCount =
    active.progress && typeof active.progress.done === "number"
      ? active.progress.done
      : currentIndex;
  var totalCount =
    active.progress && typeof active.progress.total === "number"
      ? active.progress.total
      : total;
  var pct = totalCount ? Math.round((doneCount / totalCount) * 100) : 0;

  function action(cmd) {
    if (!active || !exec) return;
    try {
      if (cmd === "pause") exec.pause(active.id);
      if (cmd === "resume") exec.resume(active.id);
      if (cmd === "stop") exec.stop(active.id);
      if (cmd === "skip" && exec.skip) exec.skip(active.id, 1);
      if (cmd === "complete" && exec.completeAll) exec.completeAll(active.id);
    } catch (e) {}
  }

  function openDrawer() {
    try {
      if (eventBus.emit)
        eventBus.emit("ui:open", { target: "PrepConsolidationDrawer" });
    } catch (e) {}
  }
  function openTimers() {
    try {
      if (eventBus.emit)
        eventBus.emit("ui:open", { target: "MultiTimerPanel" });
    } catch (e) {}
  }

  function statusBadgeVariant(status) {
    if (status === "short") return "danger";
    if (status === "low") return "warn";
    if (status === "surplus") return "ok";
    return "ok";
  }

  function toggleFavorite() {
    if (!active || !active.id) return;
    try {
      if (favApi && favApi.toggleFavorite) {
        var next = favApi.toggleFavorite(active.id, {
          id: active.id,
          title: active.title,
          domain: active.domain,
        });
        // handle promise or value
        if (next && typeof next.then === "function") {
          next.then(function (val) {
            setFav(!!val);
          });
        } else {
          setFav(!!next);
        }
      } else {
        var newVal = !fav;
        setFav(newVal);
        eventBus.emit &&
          eventBus.emit("session.favorite.toggled", {
            domain: active.domain || "session",
            sessionId: active.id,
            next: newVal,
            meta: { title: active.title },
            source: "SessionHUD",
          });
      }
      toastSafe(
        fav ? "Removed from favorite sessions." : "Added to favorite sessions."
      );
    } catch (e) {
      toastSafe("Could not update favorite sessions.", "error");
    }
  }

  function openSave() {
    if (!active || !active.id) {
      toastSafe("No active session to save.", "error");
      return;
    }
    setSaveOpen(true);
    try {
      eventBus.emit &&
        eventBus.emit("session.save.modal.opened", {
          domain: active.domain || "session",
          sessionId: active.id,
          source: "SessionHUD",
        });
    } catch (e) {}
  }

  function exportSnapshot() {
    if (!active || !active.id) return;
    var fallback = {
      id: active.id,
      domain: active.domain,
      title: active.title,
      step: active.step,
      progress: active.progress,
      guards: guards,
      hazards: hazards,
      ppe: ppe,
    };
    try {
      eventBus.emit &&
        eventBus.emit("session.snapshot.requested", {
          sessionId: active.id,
          domain: active.domain || "session",
          source: "SessionHUD",
          reply: function (snapshot) {
            var data = snapshot || fallback;
            var blob = new Blob([JSON.stringify(data, null, 2)], {
              type: "application/json",
            });
            var a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = safeFile(active.title || "session") + ".json";
            a.click();
            URL.revokeObjectURL(a.href);
            toastSafe("Downloaded session snapshot.");
          },
        });
    } catch (e) {
      // Fallback immediate download
      var blob = new Blob([JSON.stringify(fallback, null, 2)], {
        type: "application/json",
      });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = safeFile(active.title || "session") + ".json";
      a.click();
      URL.revokeObjectURL(a.href);
    }
  }

  var stepLabel = active.step
    ? active.step.label || active.step.title || active.step.description || "—"
    : "—";
  var stepType = active.step ? active.step.type || "MANUAL" : null;
  var stepWait = !!(active.step && active.step.wait);
  var sabbathOn =
    !!(meta && meta.sabbath) || !!(guards && guards.sabbathActive);

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 w-[min(820px,92%)] rounded-2xl shadow-2xl bg-white border border-gray-200 z-50">
      {/* Header */}
      <div className="px-4 py-3 border-b flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">
            {active.title || "Session"}
          </div>
          <div className="text-[11px] text-gray-500 flex items-center gap-2">
            <span>
              {active.domain || "session"} • {active.status || "RUNNING"}
            </span>
            {sabbathOn ? <Badge variant="warn">Sabbath guard</Badge> : null}
            {guards && guards.incompatibleChemicals ? (
              <Badge variant="danger">
                Chem clash: {guards.incompatibleChemicals.a} +{" "}
                {guards.incompatibleChemicals.b}
              </Badge>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            onClick={function () {
              openDrawer();
            }}
          >
            Prep Drawer
          </Button>
          <Button
            onClick={function () {
              openTimers();
            }}
          >
            Timers
          </Button>
          <Button
            onClick={function () {
              toggleFavorite();
            }}
            tone="ghost"
            title={fav ? "Unfavorite session" : "Favorite session"}
          >
            {fav ? "★ Fav" : "☆ Fav"}
          </Button>
          <Button
            onClick={function () {
              openSave();
            }}
            tone="subtle"
          >
            Save
          </Button>
          <Button
            onClick={function () {
              exportSnapshot();
            }}
            tone="ghost"
          >
            Export
          </Button>
          <Button
            onClick={function () {
              action("pause");
            }}
          >
            Pause
          </Button>
          <Button
            onClick={function () {
              action("resume");
            }}
          >
            Resume
          </Button>
          <Button
            onClick={function () {
              action("stop");
            }}
            tone="primary"
          >
            Stop
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="px-4 py-3 space-y-3">
        {/* Top banners: alerts + guidance */}
        {alerts && alerts.length ? (
          <Banner tone="warn">
            <div className="font-medium mb-1">Pre-checks &amp; guards</div>
            <ul className="list-disc ml-5 space-y-0.5">
              {alerts.map(function (a, i) {
                return <li key={"al" + i}>{a}</li>;
              })}
            </ul>
          </Banner>
        ) : null}

        {/* Safety, PPE & inventory badges */}
        {hazards.length || (ppe && ppe.length) || invBadges.length ? (
          <div className="flex flex-wrap gap-2">
            {hazards.map(function (h, i) {
              return (
                <Pill
                  key={"hz" + i}
                  className="border-red-300 text-red-700 bg-red-50"
                >
                  {h}
                </Pill>
              );
            })}
            {(ppe || []).map(function (p, i) {
              return (
                <Pill
                  key={"ppe" + i}
                  className="border-emerald-300 text-emerald-700 bg-emerald-50"
                >
                  {p}
                </Pill>
              );
            })}
            {invBadges.map(function (b, i) {
              var txt =
                (b.status === "short"
                  ? "Short"
                  : b.status === "low"
                  ? "Low"
                  : b.status === "surplus"
                  ? "Surplus"
                  : "Have") +
                ": " +
                b.name +
                (b.aisle ? " (" + b.aisle + ")" : "");
              return (
                <Badge key={"inv" + i} variant={statusBadgeVariant(b.status)}>
                  {txt}
                </Badge>
              );
            })}
          </div>
        ) : null}

        {/* Current step & progress */}
        <div className="text-sm">
          <div className="font-medium mb-1">Now</div>
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="font-semibold truncate">{stepLabel}</div>
              <div className="text-[11px] text-gray-500 mt-0.5">
                {stepType
                  ? stepType + (stepWait ? " • waits" : " • flows")
                  : "—"}
              </div>
              <div className="h-2 bg-gray-100 rounded mt-2">
                <div
                  className="h-2 bg-emerald-500 rounded"
                  style={{ width: (pct || 0) + "%" }}
                />
              </div>
              <div className="text-[11px] text-gray-500 mt-1">
                Step {doneCount + 1} of {totalCount || 0}
              </div>
              {/* Inline helpers */}
              {(checklist && (checklist.items.length || checklist.title)) ||
              (links && links.length) ? (
                <div className="mt-2 space-y-2">
                  {checklist ? (
                    <div>
                      <div className="text-[11px] text-gray-600">
                        {checklist.title}
                      </div>
                      {checklist.items.length ? (
                        <ul className="text-[11px] list-disc ml-5">
                          {checklist.items.map(function (it, i) {
                            return <li key={"cl" + i}>{it}</li>;
                          })}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}
                  {links && links.length ? (
                    <div className="flex flex-wrap gap-2">
                      {links.map(function (l, i) {
                        return (
                          <a
                            key={"lnk" + i}
                            href={l.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[11px] underline text-blue-700"
                          >
                            {l.label || l.url}
                          </a>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                onClick={function () {
                  action("skip");
                }}
                tone="ghost"
              >
                Skip
              </Button>
              <Button
                onClick={function () {
                  action("complete");
                }}
              >
                Complete
              </Button>
            </div>
          </div>
        </div>

        {/* Active timers */}
        <div>
          <div className="text-xs font-medium mb-1 text-gray-700">
            Active timers{" "}
            {groupPaused ? (
              <span className="text-amber-600">(paused)</span>
            ) : null}
          </div>
          {timers.length ? (
            <ul className="text-xs divide-y divide-gray-100">
              {timers.map(function (t) {
                return (
                  <li
                    key={t.id}
                    className="py-1.5 flex items-center justify-between"
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate">
                        {t.label || "Task"}
                      </div>
                      <div className="text-[11px] text-gray-500">
                        {(t.minutes || 0) + " min"}
                      </div>
                    </div>
                    <Badge variant={t.disabled ? "warn" : "ok"}>
                      {t.disabled ? "Preview" : "Running"}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="text-xs text-gray-500">None</div>
          )}
        </div>

        {/* Scheduled lead prep */}
        {lead && lead.length ? (
          <div>
            <div className="text-xs font-medium mb-1 text-gray-700">
              Scheduled lead prep
            </div>
            <ul className="text-xs list-disc ml-5">
              {lead.map(function (s, i) {
                var when = s.when ? new Date(s.when).toLocaleString() : "";
                return (
                  <li key={i}>
                    {s.title || "Lead Prep"} — {when}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {/* Meta row */}
        <div className="flex items-center justify-between">
          <div className="text-[11px] text-gray-500">Store: {meta.store}</div>
          {meta.target ? (
            <div className="text-[11px] text-gray-500">
              ETA: {new Date(meta.target).toLocaleString()}
            </div>
          ) : null}
        </div>
      </div>

      {/* Save session modal (lazy preferred; inline fallback below) */}
      {saveOpen ? (
        SaveSessionModalLazy ? (
          <Suspense fallback={null}>
            <SaveSessionModalLazy
              isOpen={true}
              onClose={function () {
                setSaveOpen(false);
              }}
              defaultTitle={(active && active.title) || "My Session"}
              domain={(active && active.domain) || "session"}
              sessionId={(active && active.id) || "__pending__"}
              onSaved={function (saved) {
                try {
                  eventBus.emit &&
                    eventBus.emit("session.saved", {
                      from: "SessionHUD",
                      saved: saved,
                    });
                } catch (e) {}
                toastSafe("Session saved.");
                setSaveOpen(false);
              }}
            />
          </Suspense>
        ) : (
          <InlineSaveSession
            domain={(active && active.domain) || "session"}
            sessionId={(active && active.id) || "__pending__"}
            defaultTitle={(active && active.title) || "My Session"}
            onClose={function () {
              setSaveOpen(false);
            }}
            onSaved={function (saved) {
              try {
                eventBus.emit &&
                  eventBus.emit("session.saved", {
                    from: "SessionHUD",
                    saved: saved,
                  });
              } catch (e) {}
              toastSafe("Session saved.");
              setSaveOpen(false);
            }}
          />
        )
      ) : null}
    </div>
  );
}

/* ------------------------------ Inline Save (fallback) ------------------------------ */
function InlineSaveSession(props) {
  var _n = useState(props.defaultTitle || ""),
    name = _n[0],
    setName = _n[1];
  var _notes = useState(""),
    notes = _notes[0],
    setNotes = _notes[1];
  var _busy = useState(false),
    busy = _busy[0],
    setBusy = _busy[1];

  function submit() {
    setBusy(true);
    try {
      var payload = {
        id: props.sessionId,
        domain: props.domain,
        title: name,
        notes: notes,
      };
      try {
        eventBus.emit &&
          eventBus.emit("session.save.requested", {
            payload: payload,
            source: "SessionHUD",
          });
      } catch (e) {}
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
      onClick={function (e) {
        if (e.target === e.currentTarget) props.onClose && props.onClose();
      }}
    >
      <div className="w-[95vw] max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">
            Save Session
          </h3>
          <button
            className="px-2 py-1 text-xs border rounded-md"
            onClick={props.onClose}
          >
            Close
          </button>
        </div>

        <label className="mt-4 block text-sm font-medium text-gray-700">
          Title
        </label>
        <input
          className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-600"
          value={name}
          onChange={function (e) {
            setName(e.target.value);
          }}
          placeholder="Session title"
        />

        <label className="mt-4 block text-sm font-medium text-gray-700">
          Notes
        </label>
        <textarea
          className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-600"
          rows={3}
          value={notes}
          onChange={function (e) {
            setNotes(e.target.value);
          }}
          placeholder="What should future-you remember?"
        />

        <div className="mt-6 flex justify-end gap-2">
          <button
            className="px-2 py-1 text-xs border rounded-md"
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            className="px-2 py-1 text-xs border rounded-md bg-indigo-600 text-white hover:bg-indigo-700"
            onClick={submit}
            disabled={busy}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
