import React, { useEffect, useMemo, useRef, useState } from "react";
import SettingToggle from "@/components/settings/SettingToggle.jsx";
import SettingMultiCheck from "@/components/settings/SettingMultiCheck.jsx";

/**
 * AutomationSettingsPage
 * ---------------------------------------------------------------------------
 * Goals:
 * - Clear IA: Overview, Triggers & Glue, Actions, Scheduling, Safety, Integrations, Tools
 * - Intuitive flows: onboarding card, progress ring, one-click presets with UNDO
 * - Consistent design: cards, toggles, multiselects, toasts, non-blocking states
 * - Event-driven glue: refreshes on preferences/recipe/inventory/calendar/garden/animal changes
 * - Add empty states, undo patterns, and one “Next Best Action” after successes
 */

// --------------------- soft imports (defensive) -----------------------------
let Profile = null;
try {
  Profile = require("@/services/profile/householdProfileService");
} catch {
  Profile = {
    getProfile: async () => ({}),
    subscribe: () => () => {},
    setAtPath: async () => {},
    getAtPath: (_p, d) => d,
  };
}

let Jobs = null;
try {
  Jobs = require("@/services/jobs/engine");
} catch {
  Jobs = { on: () => () => {}, emit: () => {} };
}

// --------------------- helpers & tokens -------------------------------------
const cls = (...xs) => xs.filter(Boolean).join(" ");

const Section = ({ title, description, children, right }) => (
  <div className="card bg-base-100 border border-base-200 shadow-sm rounded-2xl">
    <div className="card-body">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="card-title text-lg md:text-xl">{title}</h2>
          {description && <p className="text-sm opacity-70 mt-1">{description}</p>}
        </div>
        {right}
      </div>
      <div className="mt-4 grid gap-4">{children}</div>
    </div>
  </div>
);

function useIsMounted() {
  const r = useRef(false);
  useEffect(() => { r.current = true; return () => { r.current = false; }; }, []);
  return () => r.current;
}

function toast(kind, message) {
  window.dispatchEvent(new CustomEvent("ui.toast", { detail: { kind, message } }));
}

function suggestNBA(detail) {
  window.dispatchEvent(new CustomEvent("ui.nba.suggest", { detail }));
}

function offerUndo(label, token, onPerform) {
  const handler = (e) => {
    if (e?.detail?.token !== token) return;
    try { onPerform?.(); } finally {
      window.removeEventListener("jobs.undo.perform", handler);
      toast("warning", "Undo applied");
    }
  };
  window.addEventListener("jobs.undo.perform", handler, { once: true });
  window.dispatchEvent(new CustomEvent("ui.undo.offer", { detail: { label, token } }));
}

function useProfile() {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const isMounted = useIsMounted();

  useEffect(() => {
    let unsub = () => {};
    (async () => {
      try {
        const p = await Profile.getProfile();
        if (isMounted()) setProfile(p || {});
      } finally {
        if (isMounted()) setLoading(false);
      }
    })();
    try { unsub = Profile.subscribe?.((p) => isMounted() && setProfile(p)); } catch {}
    return () => unsub && unsub();
  }, []);

  // cross-domain glue
  useEffect(() => {
    const events = [
      "preferences.changed",
      "recipe.consolidated",
      "inventory.updated",
      "calendar.synced",
      "garden.updated",
      "animal.updated",
    ];
    const bump = () => setProfile((p) => ({ ...(p || {}) }));
    events.forEach((ev) => window.addEventListener(ev, bump));
    return () => events.forEach((ev) => window.removeEventListener(ev, bump));
  }, []);

  return { profile, loading };
}

// --------------------- static catalogs --------------------------------------
const TRIGGER_OPTIONS = [
  "preferences.changed",
  "recipe.consolidated",
  "inventory.updated",
  "calendar.synced",
  "garden.updated",
  "animal.updated",
];

const ACTION_OPTIONS = [
  "applyInventory",         // Update inventory from meal plans
  "rebuildShoppingList",    // Recompute shopping list from shortages
  "gardenForecast",         // Refresh garden harvest forecast
  "preservationQueue",      // Recompute preservation plan
  "calendarSync",           // Sync tasks to calendar
  "suggestNBA",             // Suggest next-best action
];

const NOTIFY_OPTIONS = [
  "Job Started",
  "Job Completed",
  "Low Stock",
  "Plan Conflict",
  "Sync Error",
];

const QUIET_HOUR_PRESETS = ["22:00–07:00", "None"];

// --------------------- progress ring ----------------------------------------
function SetupProgress({ profile }) {
  const enabled =
    !!profile?.automation?.autoSyncInventory ||
    !!profile?.automation?.autoGardenForecast ||
    !!profile?.automation?.autoAnimalHealth ||
    !!profile?.automation?.nightlyRun ||
    !!profile?.automation?.nbaHints;

  const triggers = (profile?.automation?.triggers || []).length > 0;
  const actions = (profile?.automation?.actions || []).length > 0;
  const notify = (profile?.automation?.notifications || []).length > 0;

  const steps = [enabled, triggers, actions, notify];
  const pct = Math.round((steps.filter(Boolean).length / steps.length) * 100) || 0;

  return (
    <div className="flex items-center gap-3">
      <div className="radial-progress text-primary" style={{ "--value": pct, "--size": "36px" }} role="progressbar">
        <span className="text-xs">{pct}%</span>
      </div>
      <div className="text-sm opacity-80">Automation setup</div>
    </div>
  );
}

// --------------------- presets ----------------------------------------------
async function applyCorePreset() {
  // snapshot for undo
  const before = {
    autoSyncInventory: Profile.getAtPath?.("automation.autoSyncInventory", false),
    autoGardenForecast: Profile.getAtPath?.("automation.autoGardenForecast", false),
    autoAnimalHealth: Profile.getAtPath?.("automation.autoAnimalHealth", false),
    nightlyRun: Profile.getAtPath?.("automation.nightlyRun", false),
    respectRestWindows: Profile.getAtPath?.("automation.respectRestWindows", true),
    nbaHints: Profile.getAtPath?.("automation.nbaHints", true),
    triggers: Profile.getAtPath?.("automation.triggers", []),
    actions: Profile.getAtPath?.("automation.actions", []),
    notifications: Profile.getAtPath?.("automation.notifications", []),
    quietHours: Profile.getAtPath?.("automation.quietHours", []),
  };

  const next = {
    "automation.autoSyncInventory": true,
    "automation.autoGardenForecast": true,
    "automation.autoAnimalHealth": true,
    "automation.nightlyRun": true,
    "automation.respectRestWindows": true,
    "automation.nbaHints": true,
    "automation.triggers": Array.from(new Set([...before.triggers, ...TRIGGER_OPTIONS])),
    "automation.actions": Array.from(new Set([...before.actions, ...ACTION_OPTIONS])),
    "automation.notifications": Array.from(new Set([...before.notifications, "Job Completed", "Low Stock"])),
    "automation.quietHours": QUIET_HOUR_PRESETS.includes("22:00–07:00")
      ? ["22:00–07:00"]
      : [...(before.quietHours || []), "22:00–07:00"],
  };

  await Promise.all(Object.entries(next).map(([path, val]) => Profile.setAtPath?.(path, val)));
  toast("success", "Core automations enabled");

  const token = `auto-core-${Date.now()}`;
  offerUndo("Enabled Core Automations", token, () => {
    Object.entries(before).forEach(([k, v]) => {
      const map = {
        autoSyncInventory: "automation.autoSyncInventory",
        autoGardenForecast: "automation.autoGardenForecast",
        autoAnimalHealth: "automation.autoAnimalHealth",
        nightlyRun: "automation.nightlyRun",
        respectRestWindows: "automation.respectRestWindows",
        nbaHints: "automation.nbaHints",
        triggers: "automation.triggers",
        actions: "automation.actions",
        notifications: "automation.notifications",
        quietHours: "automation.quietHours",
      };
      try { Profile.setAtPath?.(map[k], v); } catch {}
    });
  });

  suggestNBA({
    label: "Run a test automation now",
    cta: "Trigger Test",
    onClick: () => triggerTestEvent(),
  });
}

async function triggerTestEvent() {
  try {
    toast("info", "Triggering test event…");
    // Simulate a small job for visual feedback
    Jobs.emit?.("ui.progress", { at: 0.25, message: "Test automation" });
    // Fire a real domain event the glue listens to
    window.dispatchEvent(new CustomEvent("preferences.changed", { detail: { source: "test" } }));
    setTimeout(() => Jobs.emit?.("jobs.run.succeeded", { jobId: "automation.test" }), 400);
    suggestNBA({ label: "Review recent jobs", cta: "Open Jobs", href: "#/jobs" });
  } catch {
    toast("error", "Test failed");
  }
}

// --------------------- page -------------------------------------------------
export default function AutomationSettingsPage() {
  const { profile, loading } = useProfile();

  const disabledAll =
    !profile?.automation?.autoSyncInventory &&
    !profile?.automation?.autoGardenForecast &&
    !profile?.automation?.autoAnimalHealth &&
    !profile?.automation?.nightlyRun &&
    !profile?.automation?.nbaHints;

  if (loading) {
    return (
      <div className="p-4 md:p-6 w-full max-w-5xl mx-auto">
        <div className="animate-pulse h-6 w-48 bg-base-200 rounded-2xl mb-3" />
        <div className="animate-pulse h-28 bg-base-200 rounded-2xl mb-3" />
        <div className="animate-pulse h-28 bg-base-200 rounded-2xl mb-3" />
        <div className="animate-pulse h-32 bg-base-200 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 w-full max-w-5xl mx-auto grid gap-6">
      {/* ONBOARDING / EMPTY */}
      {disabledAll && (
        <div className="card bg-base-100 border border-base-200 rounded-2xl">
          <div className="card-body">
            <div className="flex items-start gap-3">
              <div className="avatar placeholder">
                <div className="w-10 h-10 rounded-full bg-base-200 text-base-content">⚙️</div>
              </div>
              <div className="flex-1">
                <h2 className="card-title">Let’s turn on automations</h2>
                <p className="text-sm opacity-70">
                  Enable smart sync between Meals, Inventory, Garden, Calendar, and Animal tasks.
                  Undo is offered after bulk changes; confirmations are minimized.
                </p>
              </div>
              <SetupProgress profile={profile} />
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button className="btn btn-primary btn-sm rounded-2xl" onClick={applyCorePreset}>
                Enable Core Automations
              </button>
              <button
                className="btn btn-ghost btn-sm rounded-2xl"
                onClick={() => suggestNBA({ label: "Open Jobs", cta: "Go", href: "#/jobs" })}
              >
                Skip for now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* OVERVIEW */}
      <Section
        title="Overview"
        description="Core knobs that most households enable. These power cross-domain workflows."
        right={<SetupProgress profile={profile} />}
      >
        <SettingToggle
          path="automation.autoSyncInventory"
          label="Auto-sync Inventory from meal plans"
          hint="When recipes consolidate, deduct ingredients and update shortages."
          tone="info"
        />
        <SettingToggle
          path="automation.autoGardenForecast"
          label="Auto garden forecast"
          hint="Recompute harvest estimates when meal plans or weather change."
        />
        <SettingToggle
          path="automation.autoAnimalHealth"
          label="Auto animal health reminders"
          hint="Schedule due tasks (e.g., deworming) on your calendar."
        />
        <SettingToggle
          path="automation.nightlyRun"
          label="Nightly optimization run"
          hint="Batch small jobs at night to keep the day snappy."
        />
        <SettingToggle
          path="automation.nbaHints"
          label="Suggest next best action"
          hint="After each successful job, surface one contextual suggestion."
        />
        <SettingToggle
          path="automation.respectRestWindows"
          label="Respect rest windows"
          hint="Skip non-urgent jobs during your configured rest periods."
        />
      </Section>

      {/* TRIGGERS & GLUE */}
      <Section
        title="Triggers & Glue"
        description="Choose which events should trigger automation across the system."
      >
        <SettingMultiCheck
          path="automation.triggers"
          label="Events to react to"
          hint="We coalesce back-to-back events to avoid thrashing."
          options={TRIGGER_OPTIONS}
        />
        <SettingToggle
          path="automation.coalesceEvents"
          label="Coalesce rapid events"
          hint="Bundle multiple events happening within a short window."
        />
        <SettingToggle
          path="automation.throttleJobs"
          label="Throttle long jobs"
          hint="When the system is busy, delay non-critical jobs."
        />
      </Section>

      {/* ACTIONS */}
      <Section
        title="Actions"
        description="What should the assistant do in response to triggers?"
      >
        <SettingMultiCheck
          path="automation.actions"
          label="Allowed actions"
          hint="Pick the actions you want queued automatically."
          options={ACTION_OPTIONS}
        />
        <SettingToggle
          path="automation.requireUndoOffer"
          label="Always offer Undo"
          hint="After impactful actions, show an undo chip instead of a confirm dialog."
        />
      </Section>

      {/* SCHEDULING */}
      <Section
        title="Scheduling"
        description="Define quiet hours and when to batch background work."
      >
        <SettingMultiCheck
          path="automation.quietHours"
          label="Quiet hours"
          hint="Automations run silently, deferring noisy tasks."
          options={QUIET_HOUR_PRESETS}
        />
        <SettingToggle
          path="automation.deferNotificationsDuringQuiet"
          label="Defer notifications during quiet hours"
          hint="We’ll hold non-critical toasts until quiet hours end."
        />
      </Section>

      {/* SAFETY & NOTIFICATIONS */}
      <Section
        title="Safety & Notifications"
        description="Protect against surprises and decide what alerts you see."
      >
        <SettingToggle
          path="automation.confirmDangerous"
          label="Confirm potentially destructive steps"
          hint="Rarely needed; we prefer Undo. Still useful for bulk deletions."
          tone="warn"
        />
        <SettingMultiCheck
          path="automation.notifications"
          label="Notify me about"
          hint="Choose the notifications you want from automation jobs."
          options={NOTIFY_OPTIONS}
        />
      </Section>

      {/* TOOLS */}
      <Section
        title="Tools"
        description="Apply a preset, test your glue, or clear local caches with Undo."
      >
        <div className="grid gap-3 md:grid-cols-2">
          {/* Presets */}
          <div className="card bg-base-100 border border-base-200 rounded-2xl">
            <div className="card-body">
              <h3 className="font-semibold">Quick presets</h3>
              <p className="text-sm opacity-70">
                Start with sensible defaults. You can tweak everything after.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button className="btn btn-outline btn-sm rounded-2xl" onClick={applyCorePreset}>
                  Enable Core Automations
                </button>
                <button className="btn btn-ghost btn-sm rounded-2xl" onClick={triggerTestEvent}>
                  Trigger Test
                </button>
              </div>
            </div>
          </div>

          {/* Local Data Tools with Undo */}
          <LocalDataTools />
        </div>
      </Section>
    </div>
  );
}

// --------------------- Local Data Tools (undo pattern) ----------------------
function LocalDataTools() {
  const clearAutomationLocal = async () => {
    try {
      // Snapshot keys that look automation-related (prefix heuristic)
      const snapshot = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (/^(suka:automation|automation:|suka:jobs)/i.test(k)) {
          snapshot[k] = localStorage.getItem(k);
        }
      }
      Object.keys(snapshot).forEach((k) => localStorage.removeItem(k));
      toast("success", "Automation caches cleared");

      const token = `automation-clear-${Date.now()}`;
      offerUndo("Cleared automation caches", token, () => {
        Object.entries(snapshot).forEach(([k, v]) => {
          try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {}
        });
      });

      suggestNBA({ label: "Reload to apply clean state", cta: "Reload", onClick: () => location.reload() });
    } catch {
      toast("error", "Could not clear caches");
    }
  };

  return (
    <div className="card bg-base-100 border border-base-200 rounded-2xl">
      <div className="card-body">
        <h3 className="font-semibold">Local data</h3>
        <p className="text-sm opacity-70">
          Clear cached automation state if something looks stale. Undo is offered automatically.
        </p>
        <div className="mt-3">
          <button className="btn btn-outline btn-sm rounded-2xl" onClick={clearAutomationLocal}>
            Clear Automation Caches
          </button>
        </div>
      </div>
    </div>
  );
}
