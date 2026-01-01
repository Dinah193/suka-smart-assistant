// src/components/cleaning/EntryExitFlowDesigner.jsx
// Entry/Exit Flow Designer
// - Design household entry/exit routines (mudroom / foyer / back door flow)
// - Integrates with CleaningPlanManager (Generate Routine → ad-hoc plan)
// - Sabbath-aware guardrails
// - Deep Clean Focus per-step cadences (monthly/quarterly/bi-annual/annual)
// - Presets: Daily Reset Entry, Bug-Shield Touchpoints, Paper Inbox Zero (mail basket)
// - Emits events & automation nudges; builds calendar RRULEs for cadence steps
// - Optimistic updates with Undo affordance via eventBus toast (or your UndoToast component)

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  DoorOpen,
  DoorClosed,
  Sparkles,
  CalendarPlus,
  Plus,
  Save,
  Trash2,
  MoveUp,
  MoveDown,
  Play,
  Undo2,
  Redo2,
  Settings,
  Shield,
  Inbox,
  Footprints,
  KeySquare,
  ShoppingBasket,
  Leaf,
  TimerReset,
  ClipboardList,
  Info,
} from "lucide-react";

// Defensive dynamic imports – degrade gracefully in dev
let eventBus = { emit: () => {}, on: () => () => {} };
let automation = { queue: () => {}, invoke: async () => {} };
let CleaningPlanManager = null;
let PreferencesStore = { getState: () => ({ timezone: "America/New_York", sabbathAware: true }) };
let materializeCleaningPacks = null;
let deepCleanCadenceToRRULE = (x) => "RRULE:FREQ=YEARLY;BYHOUR=9;BYMINUTE=0;BYSECOND=0";

(async () => {
  try { ({ eventBus } = await import("@/services/events/eventBus")); } catch {}
  try { ({ automation } = await import("@/services/automation/runtime")); } catch {}
  try { ({ default: CleaningPlanManager } = await import("@/managers/CleaningPlanManager")); } catch {}
  try {
    const t = await import("@/data/cleaningTemplates");
    materializeCleaningPacks = t?.materializePacks;
  } catch {}
  try {
    const s = await import("@/data/organizingStrategies");
    deepCleanCadenceToRRULE = s?.deepCleanCadenceToRRULE || deepCleanCadenceToRRULE;
  } catch {}
  try {
    const p = await import("@/stores/preferences");
    PreferencesStore = p?.usePreferencesStore || PreferencesStore;
  } catch {}
})();

const TZ = () => {
  try { return PreferencesStore.getState()?.timezone || "America/New_York"; } catch { return "America/New_York"; }
};
const SABBATH_AWARE = () => {
  try { return !!PreferencesStore.getState()?.sabbathAware; } catch { return true; }
};
const isSabbathApprox = (d = new Date(), tz = "America/New_York", aware = true) => {
  if (!aware) return false;
  // Approx: Saturday
  const dow = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(d);
  return dow === "Sat";
};

// Simple id
const toId = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

// Default Zones for entry/exit flows
const ZONES = ["entry", "mudroom", "garage", "back-door", "kitchen", "storehouse"];

// Quick-add chips used by many households
const QUICK_CHIPS = [
  { icon: <Footprints className="w-4 h-4" />, label: "Shoe Rack Reset", title: "Reset shoe rack & mud tray", zone: "entry", estMinutes: 3 },
  { icon: <KeySquare className="w-4 h-4" />, label: "Key Hook", title: "Keys on hook, bags to peg", zone: "entry", estMinutes: 1 },
  { icon: <Inbox className="w-4 h-4" />, label: "Mail Basket", title: "Mail to basket (no counters)", zone: "entry", estMinutes: 1, tags: ["paper-inbox"] },
  { icon: <Shield className="w-4 h-4" />, label: "Bug Sweep", title: "Crumb wipe & trash seal check", zone: "kitchen", estMinutes: 4, cadence: "monthly" },
  { icon: <ShoppingBasket className="w-4 h-4" />, label: "Groceries Staging", title: "Stage groceries; cold first", zone: "kitchen", estMinutes: 5 },
  { icon: <Leaf className="w-4 h-4" />, label: "Garden Basket", title: "Harvest basket to sink/wash", zone: "kitchen", estMinutes: 5, tags: ["harvest"] },
  { icon: <TimerReset className="w-4 h-4" />, label: "Daily Reset", title: "Quick surface reset (entry)", zone: "entry", estMinutes: 3 },
];

// Smart presets (pulling from project chats)
const PRESETS = [
  {
    id: "daily-entry-reset",
    name: "Daily Entry Reset",
    icon: <DoorClosed className="w-4 h-4" />,
    steps: [
      { title: "Shoes to rack; mud tray clear", zone: "entry", estMinutes: 3, trigger: "onEntry" },
      { title: "Keys to hook; bags to peg", zone: "entry", estMinutes: 1, trigger: "onEntry" },
      { title: "Mail to inbox basket", zone: "entry", estMinutes: 1, tags: ["paper-inbox"], trigger: "onEntry" },
      { title: "Groceries staged; cold items first", zone: "kitchen", estMinutes: 5, trigger: "onEntry" },
    ],
  },
  {
    id: "bug-shield-touchpoints",
    name: "Bug-Shield Touchpoints",
    icon: <Shield className="w-4 h-4" />,
    steps: [
      { title: "Entry points quick check (gaps/doors)", zone: "entry", estMinutes: 3, trigger: "onExit", cadence: "monthly" },
      { title: "Crumb wipe near pet bowls & trash seals", zone: "kitchen", estMinutes: 4, trigger: "onEntry", cadence: "monthly" },
      { title: "Refresh traps/monitor cards", zone: "entry", estMinutes: 2, trigger: "onExit", cadence: "monthly" },
    ],
    afterLoad: () => {
      // Materialize cleaning pack, if available
      try { materializeCleaningPacks && materializeCleaningPacks(["bugShieldBasics"]); } catch {}
    },
  },
  {
    id: "paper-inbox-bridge",
    name: "Paper Inbox Bridge",
    icon: <Inbox className="w-4 h-4" />,
    steps: [
      { title: "Mail to paper inbox; counters stay clear", zone: "entry", estMinutes: 1, trigger: "onEntry", tags: ["paper-inbox"] },
      { title: "Pin weekly ‘Paper Inbox Zero’ slot", zone: "office", estMinutes: 0, trigger: "onExit", cadence: "weekly" },
    ],
  },
  {
    id: "harvest-to-pantry",
    name: "Harvest → Pantry Handoff",
    icon: <Leaf className="w-4 h-4" />,
    steps: [
      { title: "Harvest basket to sink; wash & inspect", zone: "kitchen", estMinutes: 10, trigger: "onEntry" },
      { title: "Portion for fresh vs preserve", zone: "kitchen", estMinutes: 8, trigger: "onEntry" },
      { title: "Update Storehouse inventory & labels", zone: "storehouse", estMinutes: 5, trigger: "onExit", cadence: "weekly" },
    ],
  },
];

const DEFAULT_STEP = () => ({
  id: crypto.randomUUID(),
  title: "",
  zone: "entry",
  estMinutes: 3,
  trigger: "onEntry", // onEntry | onExit | both
  role: "household", // household | adult | child
  cadence: null, // null | monthly | quarterly | bi-annual | annual | weekly | daily
  sabbathBlocked: true,
  tags: [],
});

// Local undo/redo stack (simple)
function useHistory(value) {
  const [stack, setStack] = useState([value]);
  const [index, setIndex] = useState(0);
  const canUndo = index > 0;
  const canRedo = index < stack.length - 1;
  const set = (v) => {
    const newStack = stack.slice(0, index + 1).concat([v]);
    setStack(newStack);
    setIndex(newStack.length - 1);
  };
  const undo = () => { if (canUndo) setIndex(index - 1); };
  const redo = () => { if (canRedo) setIndex(index + 1); };
  return { value: stack[index], set, undo, redo, canUndo, canRedo };
}

export default function EntryExitFlowDesigner({
  initialFlow = null,
  onSave = () => {},
  title = "Entry/Exit Flow Designer",
}) {
  const [flowMeta, setFlowMeta] = useState({
    name: initialFlow?.name || "My Entry/Exit Flow",
    sabbathAware: initialFlow?.sabbathAware ?? true,
  });

  const history = useHistory(initialFlow?.steps?.length ? initialFlow.steps : []);
  const steps = history.value;

  const [presetId, setPresetId] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef(null);

  const tz = useMemo(() => TZ(), []);
  const sabbathAwarePref = useMemo(() => SABBATH_AWARE(), []);
  const sabbathBlockedNow = isSabbathApprox(new Date(), tz, flowMeta.sabbathAware && sabbathAwarePref);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault(); handleSave();
      }
      if (e.key.toLowerCase() === "n" && !e.repeat) addStep();
      if (e.key.toLowerCase() === "g" && !e.repeat) handleGenerateRoutine();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [steps, flowMeta]);

  const addStep = (prefill = {}) => {
    const created = { ...DEFAULT_STEP(), ...prefill };
    history.set([...(steps || []), created]);
    eventBus.emit("ui:toast", { type: "info", message: "Step added. Press Ctrl+S to save." });
  };

  const removeStep = (id) => {
    const prev = steps;
    const next = prev.filter((s) => s.id !== id);
    history.set(next);
    eventBus.emit("ui:toast:undo", {
      message: "Step removed",
      actionLabel: "Undo",
      onAction: () => history.set(prev),
    });
  };

  const moveStep = (index, dir) => {
    const to = index + dir;
    if (to < 0 || to >= steps.length) return;
    const next = steps.slice();
    const [it] = next.splice(index, 1);
    next.splice(to, 0, it);
    history.set(next);
  };

  const updateStep = (id, patch) => {
    const next = steps.map((s) => (s.id === id ? { ...s, ...patch } : s));
    history.set(next);
  };

  const loadPreset = (id) => {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setPresetId(id);
    const inflated = preset.steps.map((st) => ({ ...DEFAULT_STEP(), ...st, id: crypto.randomUUID() }));
    history.set(inflated);
    try { preset.afterLoad && preset.afterLoad(); } catch {}
    eventBus.emit("ui:toast", { type: "success", message: `Preset loaded: ${preset.name}` });
  };

  const handleSave = async () => {
    const payload = { name: flowMeta.name.trim(), steps, sabbathAware: !!flowMeta.sabbathAware, tz };
    onSave?.(payload);
    // Allow others to persist as template
    eventBus.emit("organizing:flow:saveTemplate", payload);
    eventBus.emit("ui:toast", { type: "success", message: "Entry/Exit flow saved." });
  };

  const buildTasksForCleaning = () => {
    // Convert steps to Cleaning Plan tasks (respect sabbath)
    const tasks = steps.map((s, idx) => ({
      id: s.id,
      title: s.title || `Step ${idx + 1}`,
      area: s.zone || "entry",
      estMinutes: s.estMinutes || 3,
      priority: 2,
      cadence: s.cadence || null,
      meta: { trigger: s.trigger, role: s.role, sabbathBlocked: !!s.sabbathBlocked, tags: s.tags || [] },
    })).filter(s => !(s.sabbathBlocked && sabbathBlockedNow));
    return tasks;
  };

  const scheduleCadenceSteps = (tasks) => {
    tasks.filter(t => !!t.cadence).forEach((t) => {
      const rrule = deepCleanCadenceToRRULE(t.cadence);
      eventBus.emit("calendar:create:rrule", {
        title: `Entry/Exit: ${t.title}`,
        area: t.area,
        rrule,
        tz,
        meta: { source: "entry-exit-flow", cadence: t.cadence, trigger: t.meta?.trigger },
      });
    });
  };

  const handleGenerateRoutine = async () => {
    if (!steps?.length) {
      eventBus.emit("ui:toast", { type: "warning", message: "Add at least one step to generate a routine." });
      return;
    }
    if (sabbathBlockedNow) {
      eventBus.emit("ui:toast", {
        type: "info",
        message: "Sabbath guard active. Cadenced work will be scheduled later.",
      });
    }
    setBusy(true);
    try {
      const tasks = buildTasksForCleaning();

      // Create ad-hoc plan for LiveCleaningSession if available
      if (CleaningPlanManager?.createAdhocPlan) {
        const plan = CleaningPlanManager.createAdhocPlan({
          title: `${flowMeta.name} (Entry/Exit)`,
          tasks,
          meta: { source: "EntryExitFlowDesigner", createdAt: new Date().toISOString() },
        });
        eventBus.emit("cleaning:plan:created", { planId: plan?.id, source: "entry-exit-flow" });
      }

      // Schedule cadence steps to Calendar
      scheduleCadenceSteps(tasks);

      // Friendly nudge for paper inbox / harvest / groceries ties
      const hasPaper = tasks.some(t => t.meta?.tags?.includes("paper-inbox"));
      if (hasPaper) {
        automation.queue?.("UI:Nudge", {
          message: "Want to pin ‘Paper Inbox Zero’ weekly block on your calendar?",
          actions: [{ label: "Open Calendar", event: "ui:navigate", to: "/calendar" }],
        });
      }
      const hasHarvest = tasks.some(t => (t.title || "").toLowerCase().includes("harvest"));
      if (hasHarvest) {
        automation.queue?.("Inventory:SyncFromHarvestLog", { mode: "append" });
      }

      eventBus.emit("ui:toast", { type: "success", message: "Routine generated. Open Live Session to begin." });
    } catch (e) {
      console.error(e);
      eventBus.emit("ui:toast", { type: "error", message: "Could not generate routine." });
    } finally {
      setBusy(false);
    }
  };

  const addQuickChip = (chip) => addStep({ title: chip.title, zone: chip.zone, estMinutes: chip.estMinutes, tags: chip.tags || [], cadence: chip.cadence || null });

  // UI bits
  const EmptyState = () => (
    <div className="border border-dashed rounded-2xl p-8 text-center bg-white">
      <div className="flex items-center justify-center gap-2 text-gray-700">
        <Info className="w-5 h-5" />
        <span className="font-medium">No steps yet</span>
      </div>
      <p className="text-sm text-gray-500 mt-2">Use a preset, quick-add chips, or add a custom step.</p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <button className="btn" onClick={() => loadPreset("daily-entry-reset")}><DoorClosed className="w-4 h-4 mr-1" /> Daily Entry Reset</button>
        <button className="btn" onClick={() => loadPreset("bug-shield-touchpoints")}><Shield className="w-4 h-4 mr-1" /> Bug-Shield</button>
        <button className="btn" onClick={() => addStep()}><Plus className="w-4 h-4 mr-1" /> Add Step</button>
      </div>
    </div>
  );

  return (
    <div className="w-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <DoorOpen className="w-5 h-5 text-gray-700" />
          <h2 className="text-lg font-semibold">{title}</h2>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn" onClick={() => history.undo()} disabled={!history.canUndo} title="Undo (Ctrl+Z)">
            <Undo2 className="w-4 h-4 mr-1" /> Undo
          </button>
          <button className="btn" onClick={() => history.redo()} disabled={!history.canRedo} title="Redo (Ctrl+Shift+Z)">
            <Redo2 className="w-4 h-4 mr-1" /> Redo
          </button>
          <button className="btn" onClick={handleSave} title="Save (Ctrl+S)">
            <Save className="w-4 h-4 mr-1" /> Save
          </button>
          <button className="btn btn-primary" onClick={handleGenerateRoutine} disabled={busy}>
            <Play className="w-4 h-4 mr-1" /> Generate Routine
          </button>
        </div>
      </div>

      {/* Meta */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <div className="p-3 rounded-xl border bg-white">
          <label className="text-xs text-gray-500">Flow name</label>
          <input
            className="w-full border rounded-lg px-3 py-2 mt-1"
            value={flowMeta.name}
            onChange={(e) => setFlowMeta((m) => ({ ...m, name: e.target.value }))}
            placeholder="e.g., ‘Front Door Daily Flow’"
          />
        </div>

        <div className="p-3 rounded-xl border bg-white">
          <label className="text-xs text-gray-500">Preset</label>
          <div className="flex gap-2 mt-1">
            <select
              className="border rounded-lg px-3 py-2 flex-1"
              value={presetId}
              onChange={(e) => loadPreset(e.target.value)}
            >
              <option value="">Choose…</option>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button className="btn" onClick={() => presetId && loadPreset(presetId)}>
              <ClipboardList className="w-4 h-4" />
            </button>
          </div>
          <p className="text-[11px] text-gray-500 mt-1">Switching presets replaces current steps.</p>
        </div>

        <div className="p-3 rounded-xl border bg-white flex items-center justify-between">
          <div>
            <div className="text-xs text-gray-500">Sabbath Guard</div>
            <div className="text-sm">
              {flowMeta.sabbathAware ? "Enabled" : "Disabled"}
              {isSabbathApprox(new Date(), tz, flowMeta.sabbathAware) && (
                <span className="ml-2 text-amber-600">(active now)</span>
              )}
            </div>
          </div>
          <button
            className="btn"
            onClick={() => setFlowMeta((m) => ({ ...m, sabbathAware: !m.sabbathAware }))}
            title="Toggle Sabbath Guard"
          >
            <Settings className="w-4 h-4 mr-1" /> Toggle
          </button>
        </div>
      </div>

      {/* Quick chips */}
      <div className="p-3 rounded-xl border bg-white mb-4">
        <div className="flex items-center gap-2 mb-2">
          <Sparkles className="w-4 h-4" />
          <div className="text-sm font-medium">Quick-add</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {QUICK_CHIPS.map((chip, i) => (
            <button
              key={i}
              onClick={() => addQuickChip(chip)}
              className="inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded-full border hover:bg-gray-50"
              title={chip.title}
            >
              {chip.icon}
              {chip.label}
            </button>
          ))}
          <button className="inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded-full border hover:bg-gray-50" onClick={() => addStep()}>
            <Plus className="w-4 h-4" /> Custom…
          </button>
        </div>
      </div>

      {/* Steps */}
      <div ref={listRef} className="space-y-2">
        {!steps?.length ? (
          <EmptyState />
        ) : (
          steps.map((s, idx) => (
            <div key={s.id} className="p-3 rounded-xl border bg-white">
              <div className="grid grid-cols-12 gap-2">
                <div className="col-span-12 md:col-span-6">
                  <label className="text-xs text-gray-500">Title</label>
                  <input
                    className="w-full border rounded-lg px-3 py-2 mt-1"
                    value={s.title}
                    onChange={(e) => updateStep(s.id, { title: e.target.value })}
                    placeholder={`Step ${idx + 1}`}
                  />
                </div>
                <div className="col-span-6 md:col-span-2">
                  <label className="text-xs text-gray-500">Zone</label>
                  <select
                    className="w-full border rounded-lg px-3 py-2 mt-1"
                    value={s.zone}
                    onChange={(e) => updateStep(s.id, { zone: e.target.value })}
                  >
                    {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
                  </select>
                </div>
                <div className="col-span-3 md:col-span-1">
                  <label className="text-xs text-gray-500">Est (min)</label>
                  <input
                    type="number"
                    min={1}
                    className="w-full border rounded-lg px-3 py-2 mt-1"
                    value={s.estMinutes}
                    onChange={(e) => updateStep(s.id, { estMinutes: Math.max(1, Number(e.target.value || 1)) })}
                  />
                </div>
                <div className="col-span-6 md:col-span-2">
                  <label className="text-xs text-gray-500">Trigger</label>
                  <select
                    className="w-full border rounded-lg px-3 py-2 mt-1"
                    value={s.trigger}
                    onChange={(e) => updateStep(s.id, { trigger: e.target.value })}
                  >
                    <option value="onEntry">On Entry</option>
                    <option value="onExit">On Exit</option>
                    <option value="both">Both</option>
                  </select>
                </div>
                <div className="col-span-6 md:col-span-1">
                  <label className="text-xs text-gray-500">Role</label>
                  <select
                    className="w-full border rounded-lg px-3 py-2 mt-1"
                    value={s.role}
                    onChange={(e) => updateStep(s.id, { role: e.target.value })}
                  >
                    <option value="household">Household</option>
                    <option value="adult">Adult</option>
                    <option value="child">Child</option>
                  </select>
                </div>

                <div className="col-span-12 md:col-span-6">
                  <label className="text-xs text-gray-500 flex items-center gap-1">
                    <CalendarPlus className="w-4 h-4" /> Deep Clean Focus (cadence)
                  </label>
                  <select
                    className="w-full border rounded-lg px-3 py-2 mt-1"
                    value={s.cadence || ""}
                    onChange={(e) => updateStep(s.id, { cadence: e.target.value || null })}
                  >
                    <option value="">— None —</option>
                    <option value="monthly">Monthly</option>
                    <option value="quarterly">Quarterly</option>
                    <option value="bi-annual">Bi-Annual</option>
                    <option value="annual">Annual</option>
                    <option value="weekly">Weekly</option>
                    <option value="daily">Daily</option>
                  </select>
                  {s.cadence && (
                    <p className="text-[11px] text-gray-500 mt-1">
                      Will create a Calendar RRULE (e.g., {deepCleanCadenceToRRULE(s.cadence).replace("RRULE:", "")})
                    </p>
                  )}
                </div>

                <div className="col-span-12 md:col-span-3">
                  <label className="text-xs text-gray-500">Tags</label>
                  <input
                    className="w-full border rounded-lg px-3 py-2 mt-1"
                    value={(s.tags || []).join(", ")}
                    onChange={(e) => updateStep(s.id, { tags: e.target.value.split(",").map(t => t.trim()).filter(Boolean) })}
                    placeholder="paper-inbox, harvest"
                  />
                </div>

                <div className="col-span-12 md:col-span-3">
                  <label className="text-xs text-gray-500">Sabbath Block</label>
                  <div className="mt-1 flex items-center gap-2">
                    <button
                      className={`px-3 py-2 rounded-lg border ${s.sabbathBlocked ? "bg-gray-800 text-white" : "bg-white"}`}
                      onClick={() => updateStep(s.id, { sabbathBlocked: !s.sabbathBlocked })}
                      title="If on, this step will be skipped during Sabbath."
                    >
                      {s.sabbathBlocked ? "Blocked" : "Allowed"}
                    </button>
                    {sabbathBlockedNow && s.sabbathBlocked && (
                      <span className="text-[11px] text-amber-600">Active now</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Row actions */}
              <div className="flex items-center justify-between mt-3">
                <div className="flex items-center gap-2">
                  <button className="btn" onClick={() => moveStep(idx, -1)} disabled={idx === 0} title="Move up">
                    <MoveUp className="w-4 h-4" />
                  </button>
                  <button className="btn" onClick={() => moveStep(idx, +1)} disabled={idx === steps.length - 1} title="Move down">
                    <MoveDown className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button className="btn btn-danger" onClick={() => removeStep(s.id)}>
                    <Trash2 className="w-4 h-4 mr-1" /> Remove
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer help */}
      <div className="mt-4 p-3 rounded-xl border bg-white">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-gray-600 flex items-center gap-1">
            <Play className="w-4 h-4" /> <b>Generate Routine</b> creates an ad-hoc Cleaning Plan and schedules cadence items.
          </span>
          <span className="text-gray-600 flex items-center gap-1">
            <Sparkles className="w-4 h-4" /> Use <b>cadences</b> for Deep Clean Focus per step.
          </span>
          <span className="text-gray-600 flex items-center gap-1">
            <DoorOpen className="w-4 h-4" /> <b>Triggers</b> run on entry, exit, or both.
          </span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------
   Lightweight button styles
   (Tailwind utility-first)
--------------------------------*/
const BTN_BASE = "inline-flex items-center justify-center rounded-lg px-3 py-2 border text-sm";
const styles = document?.createElement ? (() => {
  const el = document.createElement("style");
  el.innerHTML = `
  .btn { ${tw(`
    ${BTN_BASE}
    bg-white hover:bg-gray-50 border-gray-300 text-gray-700
  `)} }
  .btn-primary { ${tw(`
    ${BTN_BASE}
    bg-gray-900 text-white border-gray-900 hover:bg-black
  `)} }
  .btn-danger { ${tw(`
    ${BTN_BASE}
    bg-white text-red-600 border-red-300 hover:bg-red-50
  `)} }
  `;
  document.head.appendChild(el);
  return true;
})() : false;

// Tailwind helper (no-op at runtime, just keeps styles collocated)
function tw(str) { return str; }
