// C:\Users\larho\suka-smart-assistant\src\pages\tasks\views\TaskSettings.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * TaskSettings.jsx
 * Suka Smart Assistant — Task & Jobs Settings
 * --------------------------------------------------------------------
 * Goals:
 * 1) Clear IA: grouped settings (General, Notifications, Domain Glue, Safety).
 * 2) Intuitive flow: edit → preview → save with Undo; obvious primary CTA.
 * 3) Consistent design: DaisyUI/Tailwind cards, buttons, toasts, states.
 * 4) Event-driven glue: emits jobs.settings.updated and domain refresh events;
 *    listens to recipe.consolidated, inventory.updated, calendar.synced,
 *    preferences.changed to keep badges/filters in sync.
 *
 * Notes:
 * - Uses localStorage to persist user settings per device.
 * - Soft-imports Jobs Engine & Torah Profile Hooks if available (no hard fail).
 * - Includes test emitters for domain events to verify glue wiring.
 */

// ---------- Soft imports (optional) -----------------------------------------
let Jobs = null;
try {
  // eslint-disable-next-line import/no-unresolved
  Jobs = require("@/services/jobs/engine.js");
} catch (_) {
  Jobs = null;
}

let getTIP = null;
try {
  // eslint-disable-next-line import/no-unresolved
  ({ getTIP } = require("@/services/integration/torahProfileHooks.js"));
} catch (_) {
  getTIP = null;
}

// ---------- Utilities --------------------------------------------------------
const LS_KEY = "suka.tasks.settings.v1";

function readLS(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
function writeLS(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
function classNames(...xs) { return xs.filter(Boolean).join(" "); }

const DEFAULTS = {
  general: {
    showAdvanced: false,
    historyRetentionDays: 30,
    autoSuggestNBA: true,
    undoWindowSec: 30,
    stepConfirmations: "undo", // "confirm" | "undo"
  },
  notifications: {
    toastOnSuccess: true,
    toastOnFail: true,
    toastOnUndo: true,
    sound: false,
  },
  domainGlue: {
    reactToRecipes: true,
    reactToInventory: true,
    reactToCalendar: true,
    reactToPreferences: true,
  },
  safety: {
    sabbathGuard: true, // only effective if Torah profile enables guard actions
    allowSabbathOverride: false,
    confirmDangerousActions: true,
  }
};

const SECTION_ORDER = ["general", "notifications", "domainGlue", "safety"];

// ---------- Toast helper (global bridge) ------------------------------------
function toast(kind, message) {
  window.dispatchEvent(new CustomEvent("ui.toast", { detail: { kind, message } }));
}

// ---------- Action dispatcher for NBA/preview buttons -----------------------
function dispatchAction(action) {
  if (!action) return;
  if (action.type === "nav") {
    if (action.to?.startsWith("http")) window.location.href = action.to;
    else window.location.hash = `#${action.to}`;
  } else if (action.type === "dispatch") {
    window.dispatchEvent(new CustomEvent(action.event || "suka.dispatch", { detail: action.payload || {} }));
  } else if (action.type === "ui") {
    window.dispatchEvent(new CustomEvent(action.event || "suka.ui", { detail: action.payload || {} }));
  }
}

// ---------- Cards ------------------------------------------------------------
function SectionCard({ title, subtitle, children, right }) {
  return (
    <div className="card bg-base-100 border border-base-200 rounded-2xl shadow-sm">
      <div className="card-body">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-lg font-semibold">{title}</div>
            {subtitle && <div className="text-sm opacity-70">{subtitle}</div>}
          </div>
          {right}
        </div>
        <div className="mt-3 grid gap-3">{children}</div>
      </div>
    </div>
  );
}

function FieldRow({ label, hint, children }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[240px,1fr] gap-3 items-center">
      <div>
        <div className="font-medium">{label}</div>
        {hint && <div className="text-xs opacity-70">{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

// ---------- Main Component ---------------------------------------------------
export default function TaskSettings() {
  const [settings, setSettings] = useState(() => readLS(LS_KEY, DEFAULTS));
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);
  const [undoStack, setUndoStack] = useState([]); // snapshots for undo
  const undoTimerRef = useRef(null);

  const tipInfo = useTipInfo();

  // Persist settings whenever changed
  useEffect(() => {
    writeLS(LS_KEY, settings);
  }, [settings]);

  // Listen to domain events → refresh badges/filters
  useEffect(() => {
    if (!Jobs) return;

    const refresh = (scope) => () => {
      window.dispatchEvent(new CustomEvent("ui.badges.refresh", { detail: { scope } }));
      window.dispatchEvent(new CustomEvent("ui.filters.refresh", { detail: { scope } }));
    };

    const offR = Jobs.on?.("recipe.consolidated", refresh("meals"));
    const offI = Jobs.on?.("inventory.updated", refresh("inventory"));
    const offC = Jobs.on?.("calendar.synced", refresh("calendar"));
    const offP = Jobs.on?.("preferences.changed", refresh("global"));

    return () => {
      offR && offR();
      offI && offI();
      offC && offC();
      offP && offP();
    };
  }, []);

  // Derived flags
  const sabbathGuardEffective = tipInfo?.sabbath?.guardActions && draft.safety.sabbathGuard;

  // Handlers
  const update = (path, value) => {
    setDraft((d) => deepSet({ ...d }, path, value));
  };

  const handlePreviewSuccess = () => {
    if (!draft.notifications.toastOnSuccess) return;
    toast("success", "This is how a success toast appears.");
  };
  const handlePreviewFail = () => {
    if (!draft.notifications.toastOnFail) return;
    toast("error", "This is how a failure toast appears.");
  };
  const handlePreviewUndo = () => {
    if (!draft.notifications.toastOnUndo) return;
    toast("warning", "This is how an undo toast appears.");
  };

  const handleSave = async () => {
    setSaving(true);
    const snapshot = settings;
    setUndoStack((stk) => [snapshot, ...stk].slice(0, 5));
    setSettings(draft);
    setLastSaved(new Date().toISOString());

    // Broadcast to jobs engine and UI
    Jobs?.emit?.("jobs.settings.updated", { settings: draft });
    toast("success", "Settings saved. Undo available for a short time.");

    // Start undo window based on draft.general.undoWindowSec
    clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => {
      setUndoStack([]);
    }, (draft.general.undoWindowSec || 30) * 1000);

    // Light domain refresh for visible counters
    if (draft.domainGlue.reactToPreferences) {
      window.dispatchEvent(new CustomEvent("preferences.changed", { detail: { source: "TaskSettings" } }));
    }

    setSaving(false);
  };

  const handleUndo = () => {
    if (undoStack.length === 0) {
      toast("error", "Nothing to undo.");
      return;
    }
    const prev = undoStack[0];
    setSettings(prev);
    setDraft(prev);
    setUndoStack((stk) => stk.slice(1));
    Jobs?.emit?.("jobs.settings.updated", { settings: prev, reverted: true });
    toast("warning", "Reverted to previous settings.");
  };

  const handleResetDefaults = () => {
    const ok = window.confirm("Reset all Task & Jobs settings to defaults?");
    if (!ok) return;
    setDraft(DEFAULTS);
  };

  const handleApplyDraftToAllJobs = () => {
    // This broadcasts; your engine can decide what to do with it
    Jobs?.emit?.("jobs.settings.apply", { settings: draft });
    toast("info", "Applied current settings to all jobs (broadcast).");
  };

  const handleNBAPreview = () => {
    if (!draft.general.autoSuggestNBA) {
      toast("info", "Auto-suggest NBA is disabled in General settings.");
      return;
    }
    window.dispatchEvent(new CustomEvent("ui.nba.suggest", {
      detail: { label: "Open Meal Planner", action: { type: "nav", to: "/tier2/household/meals/plan" } }
    }));
  };

  // Test emitters to verify glue (safe, optional)
  const glueEmitters = [
    { label: "Emit recipe.consolidated", evt: "recipe.consolidated" },
    { label: "Emit inventory.updated", evt: "inventory.updated" },
    { label: "Emit calendar.synced", evt: "calendar.synced" },
    { label: "Emit preferences.changed", evt: "preferences.changed" }
  ];

  return (
    <div className="w-full max-w-6xl mx-auto px-4 md:px-0">
      <div className="mb-4">
        <h1 className="text-2xl md:text-3xl font-bold">Task & Jobs Settings</h1>
        <p className="opacity-70">
          Configure how tasks run, how feedback is shown, and how the UI reacts to changes across Meals, Inventory, and Calendar.
        </p>
      </div>

      {/* General */}
      <SectionCard
        title="General"
        subtitle="Defaults that affect run flows, history retention, undo behavior, and guidance."
        right={
          <div className="flex gap-2">
            <button className="btn btn-ghost btn-sm rounded-2xl" onClick={handleResetDefaults}>Reset to Defaults</button>
          </div>
        }
      >
        <FieldRow label="History retention" hint="Number of days to keep task history in local storage.">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              className="input input-bordered rounded-2xl w-32"
              value={draft.general.historyRetentionDays}
              onChange={(e) => update("general.historyRetentionDays", clampInt(e.target.value, 1, 365))}
            />
            <span className="opacity-70 text-sm">days</span>
          </div>
        </FieldRow>

        <FieldRow label="Next Best Action" hint="Automatically suggest a single, sensible action after success.">
          <input
            type="checkbox"
            className="toggle"
            checked={draft.general.autoSuggestNBA}
            onChange={(e) => update("general.autoSuggestNBA", e.target.checked)}
          />
        </FieldRow>

        <FieldRow label="Step handling" hint="Prefer quick Undo over pre-confirmation dialogs to reduce friction.">
          <select
            className="select select-bordered rounded-2xl w-full md:w-64"
            value={draft.general.stepConfirmations}
            onChange={(e) => update("general.stepConfirmations", e.target.value)}
          >
            <option value="undo">Use Undo (recommended)</option>
            <option value="confirm">Ask for confirmation before each destructive step</option>
          </select>
        </FieldRow>

        <FieldRow label="Undo window" hint="How long Undo is available after Save/Step.">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={5}
              className="input input-bordered rounded-2xl w-32"
              value={draft.general.undoWindowSec}
              onChange={(e) => update("general.undoWindowSec", clampInt(e.target.value, 5, 300))}
            />
            <span className="opacity-70 text-sm">seconds</span>
          </div>
        </FieldRow>

        <FieldRow label="Show advanced options" hint="Reveals additional controls for power users.">
          <input
            type="checkbox"
            className="toggle"
            checked={draft.general.showAdvanced}
            onChange={(e) => update("general.showAdvanced", e.target.checked)}
          />
        </FieldRow>
      </SectionCard>

      <div className="h-4" />

      {/* Notifications */}
      <SectionCard
        title="Notifications"
        subtitle="Choose which toasts appear during runs and after actions."
        right={
          <div className="join">
            <button className="btn btn-ghost btn-sm join-item rounded-l-2xl" onClick={handlePreviewSuccess}>Preview Success</button>
            <button className="btn btn-ghost btn-sm join-item" onClick={handlePreviewFail}>Preview Fail</button>
            <button className="btn btn-ghost btn-sm join-item rounded-r-2xl" onClick={handlePreviewUndo}>Preview Undo</button>
          </div>
        }
      >
        <FieldRow label="Success toasts" hint="Show a toast when a job succeeds.">
          <input
            type="checkbox"
            className="toggle"
            checked={draft.notifications.toastOnSuccess}
            onChange={(e) => update("notifications.toastOnSuccess", e.target.checked)}
          />
        </FieldRow>

        <FieldRow label="Failure toasts" hint="Show a toast when a job fails.">
          <input
            type="checkbox"
            className="toggle"
            checked={draft.notifications.toastOnFail}
            onChange={(e) => update("notifications.toastOnFail", e.target.checked)}
          />
        </FieldRow>

        <FieldRow label="Undo toasts" hint="Show a toast when a step is undone.">
          <input
            type="checkbox"
            className="toggle"
            checked={draft.notifications.toastOnUndo}
            onChange={(e) => update("notifications.toastOnUndo", e.target.checked)}
          />
        </FieldRow>

        <FieldRow label="Sound" hint="Play a gentle sound on success/failure.">
          <input
            type="checkbox"
            className="toggle"
            checked={draft.notifications.sound}
            onChange={(e) => update("notifications.sound", e.target.checked)}
          />
        </FieldRow>
      </SectionCard>

      <div className="h-4" />

      {/* Domain Glue */}
      <SectionCard
        title="Event-driven Glue"
        subtitle="Automatically refresh badges, filters, and panels when data changes."
        right={
          <div className="dropdown dropdown-end">
            <label tabIndex={0} className="btn btn-ghost btn-sm rounded-2xl">Test Events</label>
            <ul tabIndex={0} className="dropdown-content menu p-2 shadow bg-base-100 rounded-box w-64">
              {glueEmitters.map((g) => (
                <li key={g.evt}>
                  <button
                    className="justify-between"
                    onClick={() => Jobs?.emit?.(g.evt, { at: Date.now(), source: "TaskSettings.test" })}
                  >
                    {g.label} <span className="badge badge-ghost">{g.evt}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        }
      >
        <FieldRow label="React to recipe changes" hint="Refresh Meals UI when recipes are consolidated or updated.">
          <input
            type="checkbox"
            className="toggle"
            checked={draft.domainGlue.reactToRecipes}
            onChange={(e) => update("domainGlue.reactToRecipes", e.target.checked)}
          />
        </FieldRow>

        <FieldRow label="React to inventory updates" hint="Refresh Inventory UI when storehouse changes.">
          <input
            type="checkbox"
            className="toggle"
            checked={draft.domainGlue.reactToInventory}
            onChange={(e) => update("domainGlue.reactToInventory", e.target.checked)}
          />
        </FieldRow>

        <FieldRow label="React to calendar sync" hint="Refresh calendar badges & filters when items are synced.">
          <input
            type="checkbox"
            className="toggle"
            checked={draft.domainGlue.reactToCalendar}
            onChange={(e) => update("domainGlue.reactToCalendar", e.target.checked)}
          />
        </FieldRow>

        <FieldRow label="React to preference changes" hint="Refresh global badges/filters when preferences change.">
          <input
            type="checkbox"
            className="toggle"
            checked={draft.domainGlue.reactToPreferences}
            onChange={(e) => update("domainGlue.reactToPreferences", e.target.checked)}
          />
        </FieldRow>
      </SectionCard>

      <div className="h-4" />

      {/* Safety */}
      <SectionCard
        title="Safety & Sabbath Guard"
        subtitle="Protect users from accidental destructive actions and respect Sabbath, when enabled."
        right={
          <span className={classNames("badge rounded-full", sabbathGuardEffective ? "badge-info" : "badge-ghost")}>
            {sabbathGuardEffective ? "Sabbath guard active" : "Sabbath guard off"}
          </span>
        }
      >
        <FieldRow
          label="Enable Sabbath guard"
          hint={tipInfo?.sabbath?.guardActions
            ? "Blocks jobs on Sabbath unless overridden below."
            : "Disabled in Torah profile. Toggle has no effect until profile enables Sabbath guard."}
        >
          <input
            type="checkbox"
            className="toggle"
            checked={draft.safety.sabbathGuard}
            onChange={(e) => update("safety.sabbathGuard", e.target.checked)}
            disabled={!tipInfo?.sabbath?.guardActions}
          />
        </FieldRow>

        <FieldRow label="Allow Sabbath override" hint="Permit explicitly bypassing the Sabbath guard for urgent tasks.">
          <input
            type="checkbox"
            className="toggle"
            checked={draft.safety.allowSabbathOverride}
            onChange={(e) => update("safety.allowSabbathOverride", e.target.checked)}
            disabled={!draft.safety.sabbathGuard || !tipInfo?.sabbath?.guardActions}
          />
        </FieldRow>

        <FieldRow label="Confirm dangerous actions" hint="Ask confirmation before destructive or irreversible steps.">
          <input
            type="checkbox"
            className="toggle"
            checked={draft.safety.confirmDangerousActions}
            onChange={(e) => update("safety.confirmDangerousActions", e.target.checked)}
          />
        </FieldRow>
      </SectionCard>

      <div className="h-6" />

      {/* Footer actions */}
      <div className="flex items-center justify-between">
        <div className="text-sm opacity-70">
          {lastSaved ? <>Last saved: {new Date(lastSaved).toLocaleString()}</> : "Not saved yet"}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-outline btn-sm rounded-2xl"
            onClick={handleNBAPreview}
          >
            Preview Next Best Action
          </button>
          <button
            className="btn btn-outline btn-sm rounded-2xl"
            onClick={handleApplyDraftToAllJobs}
          >
            Apply to All Jobs
          </button>
          <button
            className="btn btn-ghost btn-sm rounded-2xl"
            onClick={handleUndo}
            disabled={undoStack.length === 0}
            title={undoStack.length ? "Undo last save" : "Nothing to undo"}
          >
            Undo
          </button>
          <button
            className={classNames("btn btn-primary btn-sm rounded-2xl", saving && "btn-disabled")}
            onClick={handleSave}
          >
            {saving ? "Saving…" : "Save Settings"}
          </button>
        </div>
      </div>

      {/* Advanced dev tools */}
      {draft.general.showAdvanced && (
        <>
          <div className="h-6" />
          <SectionCard title="Advanced — Debug & Snapshots" subtitle="Inspector for current draft and saved settings.">
            <details>
              <summary className="cursor-pointer text-sm font-semibold">Current Draft</summary>
              <pre className="mt-2 bg-base-200 p-3 rounded-xl text-xs overflow-x-auto">
                {JSON.stringify(draft, null, 2)}
              </pre>
            </details>
            <details>
              <summary className="cursor-pointer text-sm font-semibold">Saved Settings</summary>
              <pre className="mt-2 bg-base-200 p-3 rounded-xl text-xs overflow-x-auto">
                {JSON.stringify(settings, null, 2)}
              </pre>
            </details>
          </SectionCard>
        </>
      )}
      <div className="h-8" />

      {/* Bottom bar */}
      <div className="flex items-center justify-end gap-2">
        <button className="btn btn-outline btn-sm rounded-2xl" onClick={() => (window.location.hash = "#/tasks/history")}>
          Go to Task History
        </button>
        <button className="btn btn-primary btn-sm rounded-2xl" onClick={() => (window.location.hash = "#/dashboard")}>
          Back to Dashboard
        </button>
      </div>
    </div>
  );
}

// ---------- Hooks & helpers --------------------------------------------------
function useTipInfo() {
  const [tip, setTip] = useState(null);
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!getTIP) return setTip(null);
      try {
        const info = await getTIP();
        if (mounted) setTip(info || null);
      } catch {
        if (mounted) setTip(null);
      }
    })();
    return () => { mounted = false; };
  }, []);
  return tip;
}

function deepSet(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

function clampInt(v, min, max) {
  let n = parseInt(v, 10);
  if (Number.isNaN(n)) n = min;
  return Math.max(min, Math.min(max, n));
}
