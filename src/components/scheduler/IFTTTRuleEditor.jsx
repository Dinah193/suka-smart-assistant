/* eslint-disable no-console */
// src/components/scheduler/IFTTTRuleEditor.jsx
import React, { useEffect, useMemo, useState, Suspense } from "react";

/* --------------------------------- Tokens ---------------------------------- */
var cx = function () {
  var a = [].slice.call(arguments).filter(Boolean);
  return a.join(" ");
};
var WRAP = "rounded-3xl border border-gray-200 bg-white shadow-sm";
var BTN =
  "inline-flex items-center gap-2 rounded-2xl px-3 py-1.5 text-sm font-medium shadow-sm transition focus:outline-none focus:ring-2 focus:ring-offset-2 active:translate-y-px";
var VAR = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-600",
  subtle:
    "bg-white text-gray-900 hover:bg-gray-50 border border-gray-200 focus:ring-indigo-600",
  ghost: "bg-transparent text-gray-700 hover:bg-gray-100 focus:ring-indigo-600",
  danger: "bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-600",
  warn: "bg-amber-500 text-white hover:bg-amber-600 focus:ring-amber-600",
};
var CHIP =
  "inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white/80 px-2.5 py-0.5 text-[11px] font-medium text-gray-700";
var FIELD =
  "w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-600";

/* ----------------------------- Defensive imports ---------------------------- */
var eventBus = {
  emit: function () {},
  on: function () {},
  off: function () {},
};
try {
  var eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus)) || eventBus;
} catch (_) {}

var automation = null;
try {
  var a = require("@/services/automation/runtime");
  automation = (a && (a.automation || a.default)) || null;
} catch (_) {}

/* Sessions (existing) ------------------------------------------------------- */
var useFavoriteSessions = null;
try {
  var favMod = require("@/hooks/useFavoriteSessions");
  useFavoriteSessions =
    (favMod && (favMod.useFavoriteSessions || favMod.default)) || null;
} catch (_) {}

/* NEW: Schedules favorites (user-owned) ------------------------------------ */
var useFavoriteSchedules = null;
try {
  var favSchedMod = require("@/hooks/useFavoriteSchedules");
  useFavoriteSchedules =
    (favSchedMod &&
      (favSchedMod.useFavoriteSchedules || favSchedMod.default)) ||
    null;
} catch (_) {}

/* Lazy modals --------------------------------------------------------------- */
var SaveSessionModalLazy = null;
try {
  SaveSessionModalLazy = React.lazy(function () {
    return import("@/components/session/SaveSessionModal.jsx");
  });
} catch (_) {}

var SaveScheduleModalLazy = null; // NEW
try {
  SaveScheduleModalLazy = React.lazy(function () {
    return import("@/components/scheduler/SaveScheduleModal.jsx");
  });
} catch (_) {}

/* ----------------------------------- Icons ---------------------------------- */
var I = {};
try {
  var L = require("lucide-react");
  I = {
    Plus: L.Plus,
    Trash: L.Trash2,
    Grip: L.GripVertical,
    Play: L.Play,
    Zap: L.Zap,
    Clock: L.Clock3,
    Calendar: L.Calendar,
    Filter: L.Filter,
    Settings: L.Settings,
    Star: L.Star,
    StarOff: L.StarOff,
    Save: L.Save,
    TestTube: L.TestTube2,
    Check: L.Check,
    X: L.X,
    Download: L.Download,
    Upload: L.Upload,
    ChevronDown: L.ChevronDown,
    More: L.MoreHorizontal,
    Alert: L.AlertTriangle,
    Link: L.Link2,
    Cloud: L.Cloud,
    Copy: L.Copy,
  };
} catch (_) {
  I = {
    Plus: function () {
      return <span>＋</span>;
    },
    Trash: function () {
      return <span>🗑</span>;
    },
    Grip: function () {
      return <span>⋮⋮</span>;
    },
    Play: function () {
      return <span>▶</span>;
    },
    Zap: function () {
      return <span>⚡</span>;
    },
    Clock: function () {
      return <span>🕒</span>;
    },
    Calendar: function () {
      return <span>📅</span>;
    },
    Filter: function () {
      return <span>⧉</span>;
    },
    Settings: function () {
      return <span>⚙</span>;
    },
    Star: function () {
      return <span>★</span>;
    },
    StarOff: function () {
      return <span>☆</span>;
    },
    Save: function () {
      return <span>💾</span>;
    },
    TestTube: function () {
      return <span>🧪</span>;
    },
    Check: function () {
      return <span>✔</span>;
    },
    X: function () {
      return <span>✕</span>;
    },
    Download: function () {
      return <span>⬇</span>;
    },
    Upload: function () {
      return <span>⬆</span>;
    },
    ChevronDown: function () {
      return <span>▾</span>;
    },
    More: function () {
      return <span>⋯</span>;
    },
    Alert: function () {
      return <span>⚠</span>;
    },
    Link: function () {
      return <span>🔗</span>;
    },
    Cloud: function () {
      return <span>☁</span>;
    },
    Copy: function () {
      return <span>⧉</span>;
    },
  };
}

/* ---------------------------------- Utils ---------------------------------- */
function toastSafe(message, variant) {
  try {
    eventBus.emit("ui.toast", {
      message: message,
      variant: variant || "success",
    });
  } catch (_) {
    if (variant === "error") console.warn(message);
    else console.log(message);
  }
}
function uid(prefix) {
  return (prefix || "id") + ":" + Math.random().toString(36).slice(2, 9);
}
function safeParse(json, fallback) {
  try {
    return JSON.parse(json);
  } catch (_) {
    return fallback;
  }
}
function copyToClipboard(text) {
  try {
    navigator.clipboard && navigator.clipboard.writeText(String(text || ""));
    toastSafe("Copied to clipboard.");
  } catch (_) {
    toastSafe("Copy failed.", "error");
  }
}

/* ------------------------------- Default libs ------------------------------ */
/** Triggers the user can pick from (id, label, input schema-ish) */
var DEFAULT_TRIGGERS = [
  { id: "time.at", label: "Time is (HH:MM)", input: { type: "time" } },
  {
    id: "time.every",
    label: "Every interval",
    input: { type: "interval", placeholder: "+15m" },
  },
  {
    id: "event.sensor",
    label: "Sensor event",
    input: {
      type: "select",
      options: ["door.open", "motion.detected", "temp.high"],
    },
  },
  {
    id: "session.step.done",
    label: "Session step complete",
    input: { type: "text", placeholder: "step id" },
  },
  {
    id: "inventory.low",
    label: "Inventory low",
    input: { type: "text", placeholder: "item name" },
  },
];

/** Conditions (IF filters) */
var DEFAULT_CONDITIONS = [
  { id: "guard.weather.ok", label: "Weather OK", input: { type: "none" } },
  {
    id: "guard.sabbath.off",
    label: "Sabbath guard off",
    input: { type: "none" },
  },
  { id: "home.occupied", label: "Home occupied", input: { type: "none" } },
  {
    id: "time.between",
    label: "Time between (HH:MM–HH:MM)",
    input: { type: "timerange" },
  },
  {
    id: "value.equals",
    label: "Value equals",
    input: { type: "kv", placeholderKey: "path", placeholderVal: "value" },
  },
];

/** Actions (THEN) */
var DEFAULT_ACTIONS = [
  {
    id: "session.start",
    label: "Start session",
    input: { type: "session", placeholder: "Session title or id" },
  },
  {
    id: "session.pause",
    label: "Pause session",
    input: { type: "sessionId", placeholder: "Session id" },
  },
  {
    id: "notify.toast",
    label: "Show toast",
    input: { type: "text", placeholder: "Message" },
  },
  {
    id: "inventory.order",
    label: "Create shopping list item",
    input: { type: "text", placeholder: "Item name" },
  },
  {
    id: "calendar.add",
    label: "Add calendar event",
    input: { type: "text", placeholder: "Event title" },
  },
];

/* --------------------------------- Types ----------------------------------- */
/**
 * Rule shape:
 * {
 *   id, title, enabled, priority, trigger: { type, value },
 *   conditions: [{ id, op?: "AND"|"OR", value }],
 *   actions: [{ id, value, meta? }],
 *   description?, owner?, createdAt?, updatedAt?
 * }
 */

/* -------------------------------- Component -------------------------------- */
/**
 * IFTTTRuleEditor – if/then editor for condition-aware rules
 *
 * Props:
 *  - domain?: string (default "session")
 *  - initialRule?: Rule
 *  - triggers?: array
 *  - conditions?: array
 *  - actions?: array
 *  - onSave?: (rule) => void
 *  - onTest?: (result) => void
 */
export default function IFTTTRuleEditor(props) {
  var domain = props.domain || "session";

  var library = {
    triggers:
      Array.isArray(props.triggers) && props.triggers.length
        ? props.triggers
        : DEFAULT_TRIGGERS,
    conditions:
      Array.isArray(props.conditions) && props.conditions.length
        ? props.conditions
        : DEFAULT_CONDITIONS,
    actions:
      Array.isArray(props.actions) && props.actions.length
        ? props.actions
        : DEFAULT_ACTIONS,
  };

  var blank = {
    id: uid("rule"),
    title: "New rule",
    enabled: true,
    priority: 5,
    trigger: { type: library.triggers[0].id, value: "" },
    conditions: [],
    actions: [{ id: library.actions[0].id, value: "" }],
    description: "",
  };

  var _rule = useState(props.initialRule || blank),
    rule = _rule[0],
    setRule = _rule[1];
  var _drawer = useState(false),
    showJSON = _drawer[0],
    setShowJSON = _drawer[1];
  var _testBusy = useState(false),
    testBusy = _testBusy[0],
    setTestBusy = _testBusy[1];
  var _saveBusy = useState(false),
    saveBusy = _saveBusy[0],
    setSaveBusy = _saveBusy[1];
  var _saveSessionOpen = useState(false),
    saveSessionOpen = _saveSessionOpen[0],
    setSaveSessionOpen = _saveSessionOpen[1];

  /* -------------------------- Sessions: favorites --------------------------- */
  var favSessionApi = null;
  try {
    favSessionApi = useFavoriteSessions ? useFavoriteSessions(domain) : null;
  } catch (_) {}
  var startSessionAction = useMemo(
    function () {
      return (
        (rule.actions || []).find(function (a) {
          return a.id === "session.start";
        }) || null
      );
    },
    [rule && rule.actions]
  );
  var sessionIdOrTitle = (startSessionAction && startSessionAction.value) || "";
  var isFavInit = !!(
    sessionIdOrTitle &&
    favSessionApi &&
    favSessionApi.isFavorite &&
    favSessionApi.isFavorite(sessionIdOrTitle)
  );
  var _isFav = useState(isFavInit),
    isFav = _isFav[0],
    setIsFav = _isFav[1];

  useEffect(
    function () {
      if (!favSessionApi || !sessionIdOrTitle) return;
      try {
        setIsFav(
          !!favSessionApi.isFavorite &&
            !!favSessionApi.isFavorite(sessionIdOrTitle)
        );
      } catch (_) {}
    },
    [sessionIdOrTitle]
  );

  function toggleFavoriteSession() {
    if (!sessionIdOrTitle) {
      toastSafe("Enter a session id or title first.", "error");
      return;
    }
    try {
      if (favSessionApi && favSessionApi.toggleFavorite) {
        var next = favSessionApi.toggleFavorite(sessionIdOrTitle, {
          id: sessionIdOrTitle,
          title: String(sessionIdOrTitle),
          domain: domain,
        });
        if (next && typeof next.then === "function") {
          next.then(function (v) {
            setIsFav(!!v);
          });
        } else {
          setIsFav(!!next);
        }
      } else {
        var v = !isFav;
        setIsFav(v);
        eventBus.emit &&
          eventBus.emit("session.favorite.toggled", {
            domain: domain,
            sessionId: sessionIdOrTitle,
            next: v,
            meta: { title: String(sessionIdOrTitle) },
            source: "IFTTTRuleEditor",
          });
      }
      toastSafe(
        isFav
          ? "Removed from favorite sessions."
          : "Added to favorite sessions."
      );
    } catch (e) {
      toastSafe("Could not update favorite sessions.", "error");
    }
  }

  function openSaveSession() {
    if (!sessionIdOrTitle) {
      toastSafe("Enter a session id or title first.", "error");
      return;
    }
    setSaveSessionOpen(true);
    try {
      eventBus.emit &&
        eventBus.emit("session.save.modal.opened", {
          domain: domain,
          sessionId: sessionIdOrTitle,
          source: "IFTTTRuleEditor",
        });
    } catch (_) {}
  }

  /* -------------------------- NEW: Schedules favorites ---------------------- */
  // We consider "schedule" to be the trigger (time.at or time.every) + value pair.
  var scheduleKey = useMemo(
    function () {
      var t = rule && rule.trigger && rule.trigger.type;
      var v = rule && rule.trigger && rule.trigger.value;
      if (!t || !v) return "";
      return String(t + "::" + JSON.stringify(v));
    },
    [
      rule && rule.trigger && rule.trigger.type,
      rule && rule.trigger && rule.trigger.value,
    ]
  );

  var favScheduleApi = null;
  try {
    favScheduleApi = useFavoriteSchedules ? useFavoriteSchedules(domain) : null;
  } catch (_) {}
  var _isSchedFav = useState(false),
    isSchedFav = _isSchedFav[0],
    setIsSchedFav = _isSchedFav[1];
  var _saveScheduleOpen = useState(false),
    saveScheduleOpen = _saveScheduleOpen[0],
    setSaveScheduleOpen = _saveScheduleOpen[1];

  useEffect(
    function () {
      if (!favScheduleApi || !scheduleKey) return;
      try {
        setIsSchedFav(
          !!favScheduleApi.isFavorite &&
            !!favScheduleApi.isFavorite(scheduleKey)
        );
      } catch (_) {}
    },
    [scheduleKey]
  );

  function toggleFavoriteSchedule() {
    if (!scheduleKey) {
      toastSafe("Choose a schedule value first.", "error");
      return;
    }
    try {
      if (favScheduleApi && favScheduleApi.toggleFavorite) {
        var meta = {
          id: scheduleKey,
          domain: domain,
          kind: "schedule",
          trigger: rule.trigger || {},
          title:
            (rule.title ? rule.title + " — " : "") +
            prettyScheduleLabel(rule.trigger),
        };
        var next = favScheduleApi.toggleFavorite(scheduleKey, meta);
        if (next && typeof next.then === "function") {
          next.then(function (v) {
            setIsSchedFav(!!v);
          });
        } else {
          setIsSchedFav(!!next);
        }
      } else {
        var v = !isSchedFav;
        setIsSchedFav(v);
        eventBus.emit &&
          eventBus.emit("schedule.favorite.toggled", {
            domain: domain,
            scheduleKey: scheduleKey,
            next: v,
            trigger: rule.trigger,
            source: "IFTTTRuleEditor",
          });
      }
      toastSafe(
        isSchedFav
          ? "Removed from favorite schedules."
          : "Added to favorite schedules."
      );
    } catch (e) {
      toastSafe("Could not update favorite schedules.", "error");
    }
  }

  function openSaveSchedule() {
    if (!scheduleKey) {
      toastSafe("Choose a schedule value first.", "error");
      return;
    }
    setSaveScheduleOpen(true);
    try {
      eventBus.emit &&
        eventBus.emit("schedule.save.modal.opened", {
          domain: domain,
          scheduleKey: scheduleKey,
          trigger: rule.trigger,
          source: "IFTTTRuleEditor",
        });
    } catch (_) {}
  }

  function prettyScheduleLabel(trigger) {
    if (!trigger || !trigger.type) return "Schedule";
    if (trigger.type === "time.at") return "At " + String(trigger.value || "—");
    if (trigger.type === "time.every")
      return "Every " + String(trigger.value || "—");
    return trigger.type + " " + String(trigger.value || "");
  }

  /* -------------------------------- Actions -------------------------------- */
  function updateRule(patch) {
    setRule(function (cur) {
      return Object.assign({}, cur, patch);
    });
  }
  function updateTrigger(type, value) {
    updateRule({ trigger: { type: type, value: value } });
  }
  function addCondition() {
    var first = library.conditions[0] || { id: "value.equals" };
    updateRule({
      conditions: (rule.conditions || []).concat([
        {
          id: first.id,
          op: rule.conditions.length ? "AND" : undefined,
          value: "",
        },
      ]),
    });
  }
  function updateCondition(i, field, val) {
    var next = (rule.conditions || []).slice();
    var item = Object.assign({}, next[i] || {});
    item[field] = val;
    next[i] = item;
    updateRule({ conditions: next });
  }
  function removeCondition(i) {
    var next = (rule.conditions || []).slice();
    next.splice(i, 1);
    updateRule({ conditions: next });
  }
  function addAction() {
    var first = library.actions[0] || { id: "notify.toast" };
    updateRule({
      actions: (rule.actions || []).concat([{ id: first.id, value: "" }]),
    });
  }
  function updateAction(i, field, val) {
    var next = (rule.actions || []).slice();
    var item = Object.assign({}, next[i] || {});
    item[field] = val;
    next[i] = item;
    updateRule({ actions: next });
  }
  function removeAction(i) {
    var next = (rule.actions || []).slice();
    next.splice(i, 1);
    updateRule({ actions: next });
  }

  function testRule() {
    setTestBusy(true);
    var payload = { rule: rule, domain: domain, source: "IFTTTRuleEditor" };
    // Prefer runtime test; fall back to bus
    var done = function (res) {
      setTestBusy(false);
      if (!res) {
        toastSafe("No test result. Check listeners.", "warn");
        return;
      }
      var ok = !!res.ok;
      toastSafe(
        ok ? "Test passed." : "Test found issues.",
        ok ? "success" : "warn"
      );
      props.onTest && props.onTest(res);
    };
    try {
      if (automation && automation.rules && automation.rules.test) {
        var maybe = automation.rules.test(payload);
        if (maybe && typeof maybe.then === "function") {
          maybe.then(done).catch(function () {
            setTestBusy(false);
            toastSafe("Test failed.", "error");
          });
          return;
        }
        done(maybe);
      } else {
        eventBus.emit &&
          eventBus.emit(
            "automation.rule.test.requested",
            Object.assign({}, payload, { reply: done })
          );
        // If nothing responds, fallback after a tick
        setTimeout(function () {
          if (testBusy)
            done({ ok: true, notes: ["No listeners; assumed pass"] });
        }, 400);
      }
    } catch (e) {
      setTestBusy(false);
      toastSafe("Test failed.", "error");
    }
  }

  function saveRule() {
    setSaveBusy(true);
    var data = Object.assign({}, rule, { updatedAt: new Date().toISOString() });
    var done = function (stored) {
      setSaveBusy(false);
      toastSafe("Rule saved.");
      props.onSave && props.onSave(stored || data);
    };
    try {
      if (automation && automation.rules && automation.rules.save) {
        var maybe = automation.rules.save({ rule: data, domain: domain });
        if (maybe && typeof maybe.then === "function") {
          maybe.then(done).catch(function () {
            setSaveBusy(false);
            toastSafe("Save failed.", "error");
          });
          return;
        }
        done(maybe);
      } else {
        eventBus.emit &&
          eventBus.emit("automation.rule.save.requested", {
            rule: data,
            domain: domain,
            source: "IFTTTRuleEditor",
            reply: done,
          });
        setTimeout(function () {
          if (saveBusy) done(data);
        }, 350);
      }
    } catch (e) {
      setSaveBusy(false);
      toastSafe("Save failed.", "error");
    }
  }

  function exportJSON() {
    try {
      var blob = new Blob([JSON.stringify(rule, null, 2)], {
        type: "application/json",
      });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download =
        (rule.title
          ? rule.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")
          : "rule") + ".json";
      a.click();
      URL.revokeObjectURL(a.href);
      toastSafe("Downloaded rule JSON.");
    } catch (e) {
      toastSafe("Export failed.", "error");
    }
  }

  // NEW: Export to cloud providers via orchestration listeners
  function exportToCloud(provider) {
    try {
      eventBus.emit &&
        eventBus.emit("automation.rule.export.requested", {
          provider: provider,
          rule: rule,
          filename: (rule.title || "rule") + ".json",
          source: "IFTTTRuleEditor",
        });
      toastSafe("Sent export request to " + provider + ".");
    } catch (e) {
      toastSafe("Export request failed.", "error");
    }
  }

  function importJSON() {
    try {
      var inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "application/json";
      inp.onchange = function (ev) {
        var file = ev.target && ev.target.files && ev.target.files[0];
        if (!file) return;
        var fr = new FileReader();
        fr.onload = function () {
          var data = safeParse(String(fr.result || ""), null);
          if (!data) {
            toastSafe("Invalid JSON file.", "error");
            return;
          }
          setRule(
            Object.assign({}, blank, data, { id: data.id || uid("rule") })
          );
          toastSafe("Imported rule.");
        };
        fr.readAsText(file);
      };
      inp.click();
    } catch (e) {
      toastSafe("Import failed.", "error");
    }
  }

  /* ------------------------------- Render bits ------------------------------- */
  function Section(props) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-3 sm:p-4">
        {props.title ? (
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-900">
              {props.title}
            </span>
            {props.chips}
          </div>
        ) : null}
        {props.children}
      </div>
    );
  }
  function Row(props) {
    return (
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
        {props.children}
      </div>
    );
  }
  function MenuItem(p) {
    return (
      <button
        type="button"
        onClick={p.onClick}
        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
      >
        {p.icon}
        {p.label}
      </button>
    );
  }

  /* ------------------------------- Input cells ------------------------------- */
  function ValueInput(conf, value, onChange) {
    var t = conf && conf.type;
    // Helper: schedule favorite affordance if trigger is schedule-like
    var showScheduleFavUI =
      rule &&
      rule.trigger &&
      (rule.trigger.type === "time.at" || rule.trigger.type === "time.every");
    var ScheduleFavButtons = function () {
      if (!showScheduleFavUI) return null;
      return (
        <>
          <button
            className={cx(BTN, VAR.ghost, "px-2")}
            type="button"
            title={isSchedFav ? "Unfavorite schedule" : "Favorite schedule"}
            onClick={toggleFavoriteSchedule}
          >
            {isSchedFav ? (
              <I.Star className="h-4 w-4 text-amber-500" />
            ) : (
              <I.StarOff className="h-4 w-4" />
            )}
          </button>
          <button
            className={cx(BTN, VAR.subtle)}
            type="button"
            onClick={openSaveSchedule}
          >
            <I.Save className="h-4 w-4" />
            <span className="hidden sm:inline">Save</span>
          </button>
        </>
      );
    };

    if (t === "none") return <span className={CHIP}>No input</span>;
    if (t === "time")
      return (
        <div className="flex items-center gap-2">
          <input
            type="time"
            className={FIELD}
            value={String(value || "")}
            onChange={function (e) {
              onChange(e.target.value);
            }}
          />
          <ScheduleFavButtons />
        </div>
      );
    if (t === "interval")
      return (
        <div className="flex items-center gap-2">
          <input
            className={FIELD}
            placeholder={conf.placeholder || "+15m"}
            value={String(value || "")}
            onChange={function (e) {
              onChange(e.target.value);
            }}
          />
          <ScheduleFavButtons />
        </div>
      );
    if (t === "text")
      return (
        <input
          className={FIELD}
          placeholder={conf.placeholder || ""}
          value={String(value || "")}
          onChange={function (e) {
            onChange(e.target.value);
          }}
        />
      );
    if (t === "session")
      return (
        <div className="flex items-center gap-2">
          <input
            className={FIELD}
            placeholder={conf.placeholder || "Session title or id"}
            value={String(value || "")}
            onChange={function (e) {
              onChange(e.target.value);
            }}
          />
          {/* Session favorite & save (user-owned) */}
          <button
            className={cx(BTN, VAR.ghost, "px-2")}
            type="button"
            title={isFav ? "Unfavorite session" : "Favorite session"}
            onClick={toggleFavoriteSession}
          >
            {isFav ? (
              <I.Star className="h-4 w-4 text-amber-500" />
            ) : (
              <I.StarOff className="h-4 w-4" />
            )}
          </button>
          <button
            className={cx(BTN, VAR.subtle)}
            type="button"
            onClick={openSaveSession}
          >
            <I.Save className="h-4 w-4" />
            <span className="hidden sm:inline">Save</span>
          </button>
        </div>
      );
    if (t === "sessionId")
      return (
        <input
          className={FIELD}
          placeholder={conf.placeholder || "Session id"}
          value={String(value || "")}
          onChange={function (e) {
            onChange(e.target.value);
          }}
        />
      );
    if (t === "select")
      return (
        <select
          className={FIELD}
          value={String(value || "")}
          onChange={function (e) {
            onChange(e.target.value);
          }}
        >
          <option value="">Select…</option>
          {(conf.options || []).map(function (opt) {
            return (
              <option key={opt} value={opt}>
                {opt}
              </option>
            );
          })}
        </select>
      );
    if (t === "timerange")
      return (
        <div className="grid grid-cols-2 gap-2">
          <input
            type="time"
            className={FIELD}
            value={(value && value.start) || ""}
            onChange={function (e) {
              onChange(
                Object.assign({}, value || {}, { start: e.target.value })
              );
            }}
          />
          <input
            type="time"
            className={FIELD}
            value={(value && value.end) || ""}
            onChange={function (e) {
              onChange(Object.assign({}, value || {}, { end: e.target.value }));
            }}
          />
        </div>
      );
    if (t === "kv")
      return (
        <div className="grid grid-cols-2 gap-2">
          <input
            className={FIELD}
            placeholder={conf.placeholderKey || "key.path"}
            value={(value && value.k) || ""}
            onChange={function (e) {
              onChange(Object.assign({}, value || {}, { k: e.target.value }));
            }}
          />
          <input
            className={FIELD}
            placeholder={conf.placeholderVal || "value"}
            value={(value && value.v) || ""}
            onChange={function (e) {
              onChange(Object.assign({}, value || {}, { v: e.target.value }));
            }}
          />
        </div>
      );
    return (
      <input
        className={FIELD}
        value={String(value || "")}
        onChange={function (e) {
          onChange(e.target.value);
        }}
      />
    );
  }

  /* --------------------------------- Compute -------------------------------- */
  var triggerDef =
    library.triggers.find(function (t) {
      return t.id === (rule.trigger && rule.trigger.type);
    }) || library.triggers[0];
  var progressPct = 0; // reserved; could show rule completeness later

  /* ---------------------------------- UI ------------------------------------ */
  return (
    <section className={WRAP} aria-label="IFTTT rule editor">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-gradient-to-r from-white to-gray-50 px-4 py-3 rounded-t-3xl">
        <div className="min-w-0">
          <input
            className="w-full max-w-[22rem] rounded-2xl border border-gray-200 bg-white px-3 py-1.5 text-sm font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-600"
            value={rule.title || ""}
            onChange={function (e) {
              updateRule({ title: e.target.value });
            }}
            placeholder="Automation name"
          />
          <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-600">
            <span className={CHIP}>Priority {rule.priority}</span>
            <span className={CHIP}>
              {rule.enabled ? "Enabled" : "Disabled"}
            </span>
            <span className={CHIP}>{domain}</span>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            className={cx(BTN, VAR.subtle)}
            onClick={function () {
              updateRule({ enabled: !rule.enabled });
            }}
          >
            {rule.enabled ? "Disable" : "Enable"}
          </button>
          <details className="relative">
            <summary
              className={cx(
                BTN,
                VAR.ghost,
                "cursor-pointer list-none [&::-webkit-details-marker]:hidden"
              )}
            >
              <I.More className="h-4 w-4" />
              <span className="hidden sm:inline">More</span>
            </summary>
            <div className="absolute right-0 z-10 mt-2 min-w-[16rem] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
              <MenuItem
                onClick={exportJSON}
                icon={<I.Download className="h-4 w-4" />}
                label="Export (.json)"
              />
              <MenuItem
                onClick={importJSON}
                icon={<I.Upload className="h-4 w-4" />}
                label="Import (.json)"
              />
              <div className="h-px bg-gray-100" />
              <MenuItem
                onClick={function () {
                  exportToCloud("gdrive");
                }}
                icon={<I.Cloud className="h-4 w-4" />}
                label="Export to Google Drive"
              />
              <MenuItem
                onClick={function () {
                  exportToCloud("onedrive");
                }}
                icon={<I.Cloud className="h-4 w-4" />}
                label="Export to OneDrive"
              />
              <MenuItem
                onClick={function () {
                  copyToClipboard(JSON.stringify(rule, null, 2));
                }}
                icon={<I.Copy className="h-4 w-4" />}
                label="Copy JSON to clipboard"
              />
              <div className="h-px bg-gray-100" />
              <MenuItem
                onClick={function () {
                  setShowJSON(true);
                }}
                icon={<I.Settings className="h-4 w-4" />}
                label="Edit raw JSON…"
              />
            </div>
          </details>
          <button
            className={cx(BTN, VAR.subtle)}
            onClick={testRule}
            disabled={testBusy}
          >
            <I.TestTube className="h-4 w-4" />
            Test
          </button>
          <button
            className={cx(BTN, VAR.primary)}
            onClick={saveRule}
            disabled={saveBusy}
          >
            <I.Save className="h-4 w-4" />
            Save rule
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="px-4 py-4 space-y-4">
        {/* Description & priority */}
        <Section title="Summary" chips={<span className={CHIP}>Overview</span>}>
          <Row>
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-700">
                Description
              </label>
              <textarea
                className={cx(FIELD, "min-h-[72px]")}
                value={rule.description || ""}
                onChange={function (e) {
                  updateRule({ description: e.target.value });
                }}
                placeholder="What should this automation do?"
              />
            </div>
            <div className="w-full sm:w-44">
              <label className="block text-xs font-medium text-gray-700">
                Priority (1–9)
              </label>
              <input
                type="number"
                min="1"
                max="9"
                className={FIELD}
                value={Number(rule.priority || 5)}
                onChange={function (e) {
                  updateRule({
                    priority: Math.max(
                      1,
                      Math.min(9, Number(e.target.value || 5))
                    ),
                  });
                }}
              />
            </div>
          </Row>
        </Section>

        {/* Trigger */}
        <Section
          title="IF (Trigger)"
          chips={
            <span className={CHIP}>
              <I.Clock className="h-3.5 w-3.5" />
              When to fire
            </span>
          }
        >
          <Row>
            <div className="w-full sm:w-72">
              <label className="block text-xs font-medium text-gray-700">
                Trigger
              </label>
              <select
                className={FIELD}
                value={rule.trigger.type}
                onChange={function (e) {
                  updateTrigger(e.target.value, "");
                }}
              >
                {library.triggers.map(function (t) {
                  return (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  );
                })}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-700">
                Value
              </label>
              {ValueInput(
                triggerDef && triggerDef.input,
                rule.trigger.value,
                function (v) {
                  updateTrigger(rule.trigger.type, v);
                }
              )}
              {rule.trigger &&
              (rule.trigger.type === "time.at" ||
                rule.trigger.type === "time.every") ? (
                <div className="mt-1 text-[11px] text-gray-600">
                  Schedule:{" "}
                  <span className="font-medium">
                    {prettyScheduleLabel(rule.trigger)}
                  </span>
                </div>
              ) : null}
            </div>
          </Row>
        </Section>

        {/* Conditions */}
        <Section
          title="AND / OR Conditions"
          chips={
            <span className={CHIP}>
              <I.Filter className="h-3.5 w-3.5" />
              Filters
            </span>
          }
        >
          {(rule.conditions || []).length === 0 ? (
            <div className="text-xs text-gray-600">
              No conditions. This rule will always run when the trigger fires.
            </div>
          ) : null}
          <div className="space-y-3">
            {(rule.conditions || []).map(function (c, i) {
              var conf =
                library.conditions.find(function (it) {
                  return it.id === c.id;
                }) || library.conditions[0];
              return (
                <div key={i} className="rounded-xl border border-gray-200 p-3">
                  <div className="flex items-center gap-2">
                    {i > 0 ? (
                      <select
                        className="rounded-lg border border-gray-300 px-2 py-1 text-xs"
                        value={c.op || "AND"}
                        onChange={function (e) {
                          updateCondition(i, "op", e.target.value);
                        }}
                      >
                        <option value="AND">AND</option>
                        <option value="OR">OR</option>
                      </select>
                    ) : (
                      <span className={CHIP}>IF</span>
                    )}

                    <select
                      className="flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                      value={c.id}
                      onChange={function (e) {
                        updateCondition(i, "id", e.target.value);
                        updateCondition(i, "value", "");
                      }}
                    >
                      {library.conditions.map(function (t) {
                        return (
                          <option key={t.id} value={t.id}>
                            {t.label}
                          </option>
                        );
                      })}
                    </select>

                    <button
                      className={cx(BTN, VAR.ghost, "px-2")}
                      onClick={function () {
                        removeCondition(i);
                      }}
                      title="Remove"
                    >
                      <I.Trash className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="mt-2">
                    {ValueInput(conf && conf.input, c.value, function (v) {
                      updateCondition(i, "value", v);
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-3">
            <button className={cx(BTN, VAR.subtle)} onClick={addCondition}>
              <I.Plus className="h-4 w-4" />
              Add condition
            </button>
          </div>
        </Section>

        {/* Actions */}
        <Section
          title="THEN (Actions)"
          chips={
            <span className={CHIP}>
              <I.Zap className="h-3.5 w-3.5" />
              What to do
            </span>
          }
        >
          {(rule.actions || []).map(function (a, i) {
            var conf =
              library.actions.find(function (it) {
                return it.id === a.id;
              }) || library.actions[0];
            return (
              <div key={i} className="rounded-xl border border-gray-200 p-3">
                <div className="flex items-center gap-2">
                  <span className={CHIP}>THEN</span>
                  <select
                    className="flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                    value={a.id}
                    onChange={function (e) {
                      updateAction(i, "id", e.target.value);
                      updateAction(i, "value", "");
                    }}
                  >
                    {library.actions.map(function (t) {
                      return (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      );
                    })}
                  </select>
                  <button
                    className={cx(BTN, VAR.ghost, "px-2")}
                    onClick={function () {
                      removeAction(i);
                    }}
                    title="Remove"
                  >
                    <I.Trash className="h-4 w-4" />
                  </button>
                </div>

                <div className="mt-2">
                  {ValueInput(conf && conf.input, a.value, function (v) {
                    updateAction(i, "value", v);
                  })}
                </div>

                {/* Quick wiring tips */}
                {a.id === "session.start" ? (
                  <div className="mt-2 text-[11px] text-gray-600">
                    This will emit <code>session.start.requested</code>. Use
                    time-based triggers to schedule start; deciders/guards
                    (inventory, Sabbath, weather) can be applied upstream.
                  </div>
                ) : null}
              </div>
            );
          })}

          <div className="mt-3 flex items-center gap-2">
            <button className={cx(BTN, VAR.subtle)} onClick={addAction}>
              <I.Plus className="h-4 w-4" />
              Add action
            </button>
            <details className="relative">
              <summary
                className={cx(
                  BTN,
                  VAR.ghost,
                  "cursor-pointer list-none [&::-webkit-details-marker]:hidden"
                )}
              >
                <I.More className="h-4 w-4" />
                <span className="hidden sm:inline">Generate</span>
              </summary>
              <div className="absolute left-0 z-10 mt-2 min-w-[16rem] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
                <MenuItem
                  onClick={function () {
                    // Quick template: every day at 6pm start session
                    setRule(
                      Object.assign({}, rule, {
                        title: "Daily 6pm session",
                        trigger: { type: "time.at", value: "18:00" },
                        conditions: [{ id: "guard.sabbath.off", value: "" }],
                        actions: [
                          { id: "session.start", value: "Evening Routine" },
                        ],
                      })
                    );
                    toastSafe("Inserted daily 6pm template.");
                  }}
                  icon={<I.Play className="h-4 w-4" />}
                  label="Daily 6pm → Start session"
                />
                <MenuItem
                  onClick={function () {
                    // Weekday morning check-in every 20m between 7–9am
                    setRule(
                      Object.assign({}, rule, {
                        title: "Weekday morning check-ins",
                        trigger: { type: "time.every", value: "+20m" },
                        conditions: [
                          {
                            id: "time.between",
                            value: { start: "07:00", end: "09:00" },
                          },
                          { id: "guard.sabbath.off", value: "" },
                        ],
                        actions: [
                          {
                            id: "notify.toast",
                            value: "Quick morning check-in",
                          },
                        ],
                      })
                    );
                    toastSafe("Inserted weekday morning template.");
                  }}
                  icon={<I.Clock className="h-4 w-4" />}
                  label="Weekday mornings (every 20m, 7–9am)"
                />
              </div>
            </details>
          </div>
        </Section>

        {/* Footer helpers */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] text-gray-600">
            Rules publish events like{" "}
            <code>automation.rule.save.requested</code>,{" "}
            <code>automation.rule.test.requested</code>. Actions emit
            <code> session.start.requested</code>,{" "}
            <code>session.pause.requested</code>, <code>ui.toast</code>, etc.
            Triggers integrate with guards & policies (inventory, Sabbath,
            weather, pause).
          </div>
          <div className="flex items-center gap-2">
            <button
              className={cx(BTN, VAR.subtle)}
              onClick={testRule}
              disabled={testBusy}
            >
              <I.TestTube className="h-4 w-4" />
              Test
            </button>
            <button
              className={cx(BTN, VAR.primary)}
              onClick={saveRule}
              disabled={saveBusy}
            >
              <I.Save className="h-4 w-4" />
              Save rule
            </button>
          </div>
        </div>
      </div>

      {/* Raw JSON drawer */}
      {showJSON ? (
        <RawJSONDrawer
          value={rule}
          onClose={function () {
            setShowJSON(false);
          }}
          onApply={function (next) {
            try {
              setRule(Object.assign({}, rule, next));
              toastSafe("Applied JSON.");
            } catch (_) {
              toastSafe("Invalid JSON.", "error");
            }
          }}
        />
      ) : null}

      {/* Save Session modal (lazy preferred) */}
      {saveSessionOpen ? (
        SaveSessionModalLazy ? (
          <Suspense fallback={null}>
            <SaveSessionModalLazy
              isOpen={true}
              onClose={function () {
                setSaveSessionOpen(false);
              }}
              defaultTitle={String(sessionIdOrTitle || "My Session")}
              domain={domain}
              sessionId={String(sessionIdOrTitle || "__pending__")}
              onSaved={function (saved) {
                try {
                  eventBus.emit &&
                    eventBus.emit("session.saved", {
                      from: "IFTTTRuleEditor",
                      saved: saved,
                    });
                } catch (_) {}
                toastSafe("Session saved.");
                setSaveSessionOpen(false);
              }}
            />
          </Suspense>
        ) : (
          <InlineSaveSession
            defaultTitle={String(sessionIdOrTitle || "My Session")}
            domain={domain}
            sessionId={String(sessionIdOrTitle || "__pending__")}
            onClose={function () {
              setSaveSessionOpen(false);
            }}
            onSaved={function (saved) {
              try {
                eventBus.emit &&
                  eventBus.emit("session.saved", {
                    from: "IFTTTRuleEditor",
                    saved: saved,
                  });
              } catch (_) {}
              toastSafe("Session saved.");
              setSaveSessionOpen(false);
            }}
          />
        )
      ) : null}

      {/* NEW: Save Schedule modal (lazy preferred) */}
      {saveScheduleOpen ? (
        SaveScheduleModalLazy ? (
          <Suspense fallback={null}>
            <SaveScheduleModalLazy
              isOpen={true}
              onClose={function () {
                setSaveScheduleOpen(false);
              }}
              domain={domain}
              scheduleKey={scheduleKey}
              trigger={rule.trigger}
              defaultTitle={
                rule.title
                  ? rule.title + " — " + prettyScheduleLabel(rule.trigger)
                  : prettyScheduleLabel(rule.trigger)
              }
              onSaved={function (saved) {
                try {
                  eventBus.emit &&
                    eventBus.emit("schedule.saved", {
                      from: "IFTTTRuleEditor",
                      saved: saved,
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
            scheduleKey={scheduleKey}
            trigger={rule.trigger}
            defaultTitle={
              rule.title
                ? rule.title + " — " + prettyScheduleLabel(rule.trigger)
                : prettyScheduleLabel(rule.trigger)
            }
            onClose={function () {
              setSaveScheduleOpen(false);
            }}
            onSaved={function (saved) {
              try {
                eventBus.emit &&
                  eventBus.emit("schedule.saved", {
                    from: "IFTTTRuleEditor",
                    saved: saved,
                  });
              } catch (_) {}
              toastSafe("Schedule saved.");
              setSaveScheduleOpen(false);
            }}
          />
        )
      ) : null}
    </section>
  );
}

/* ------------------------------ Raw JSON Drawer ----------------------------- */
function RawJSONDrawer(props) {
  var _text = useState(JSON.stringify(props.value || {}, null, 2)),
    text = _text[0],
    setText = _text[1];

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-end bg-black/30"
      role="dialog"
      aria-modal="true"
      onClick={function (e) {
        if (e.target === e.currentTarget) props.onClose && props.onClose();
      }}
    >
      <div className="w-full max-w-2xl rounded-t-3xl border border-gray-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <div className="text-sm font-semibold text-gray-900">
            Edit rule JSON
          </div>
          <button
            className={cx(BTN, VAR.ghost, "px-2")}
            onClick={props.onClose}
          >
            <I.X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4">
          <textarea
            className={cx(FIELD, "min-h-[50vh] font-mono text-xs")}
            value={text}
            onChange={function (e) {
              setText(e.target.value);
            }}
          />
          <div className="mt-3 flex justify-end gap-2">
            <button className={cx(BTN, VAR.ghost)} onClick={props.onClose}>
              Cancel
            </button>
            <button
              className={cx(BTN, VAR.primary)}
              onClick={function () {
                props.onApply && props.onApply(safeParse(text, {}));
              }}
            >
              <I.Check className="h-4 w-4" />
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- Inline Save (Fallback) ------------------------ */
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
            source: "IFTTTRuleEditor",
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
          onChange={function (e) {
            setName(e.target.value);
          }}
          placeholder="Session title"
        />

        <label className="mt-4 block text-sm font-medium text-gray-700">
          Notes
        </label>
        <textarea
          className={cx(FIELD, "min-h-[96px]")}
          value={notes}
          onChange={function (e) {
            setNotes(e.target.value);
          }}
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

/* ---------------------------- Inline Save Schedule -------------------------- */
function InlineSaveSchedule(props) {
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
        id: props.scheduleKey,
        domain: props.domain,
        title: name,
        notes: notes,
        trigger: props.trigger || {},
        kind: "schedule",
      };
      try {
        eventBus.emit &&
          eventBus.emit("schedule.save.requested", {
            payload: payload,
            source: "IFTTTRuleEditor",
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
      onClick={function (e) {
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
          onChange={function (e) {
            setName(e.target.value);
          }}
          placeholder="Schedule title"
        />

        <label className="mt-4 block text-sm font-medium text-gray-700">
          Notes
        </label>
        <textarea
          className={cx(FIELD, "min-h-[96px]")}
          value={notes}
          onChange={function (e) {
            setNotes(e.target.value);
          }}
          placeholder="e.g., Applies only on weekdays, or before sunset"
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
