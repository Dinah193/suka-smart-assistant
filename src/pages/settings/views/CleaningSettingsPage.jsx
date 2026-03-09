// src/pages/settings/views/CleaningSettingsPage.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { automation, emitProgress } from "@/services/automation/runtime";
import { sabbathGuard } from "@/services/guardrails/sabbathGuard";
import { usePreferencesStore } from "@/store/PreferencesStore"; // optional
import { useCleaningStore } from "@/store/CleaningStore"; // optional
import { classNames } from "@/utils/css";

/* -------------------------------------------------------------------------- */
/* UI atoms                                                                   */
/* -------------------------------------------------------------------------- */

const SectionCard = ({ title, subtitle, right, children }) => (
  <div className="rounded-2xl shadow-md border border-base-200 bg-base-100">
    <div className="flex items-start justify-between p-5 border-b border-base-200">
      <div>
        <h3 className="text-lg font-semibold">{title}</h3>
        {subtitle ? (
          <p className="text-sm opacity-70 mt-1">{subtitle}</p>
        ) : null}
      </div>
      {right}
    </div>
    <div className="p-5">{children}</div>
  </div>
);

const Row = ({ label, hint, children }) => (
  <div className="flex items-start justify-between py-3">
    <div className="pr-4">
      <p className="font-medium">{label}</p>
      {hint ? <p className="text-sm opacity-70">{hint}</p> : null}
    </div>
    <div className="flex items-center gap-3">{children}</div>
  </div>
);

const Toggle = ({ checked, onChange, disabled }) => (
  <input
    type="checkbox"
    className="toggle toggle-primary"
    checked={!!checked}
    onChange={(e) => onChange(e.target.checked)}
    disabled={disabled}
  />
);

const Select = ({
  value,
  onChange,
  options = [],
  disabled,
  className = "w-56",
}) => (
  <select
    className={classNames("select select-bordered", className)}
    value={value ?? ""}
    onChange={(e) => onChange(e.target.value)}
    disabled={disabled}
  >
    {options.map((o) => (
      <option key={(o.value ?? o) + ""} value={o.value ?? o}>
        {o.label ?? o}
      </option>
    ))}
  </select>
);

const Input = ({
  value,
  onChange,
  placeholder,
  disabled,
  className = "w-80",
}) => (
  <input
    className={classNames("input input-bordered", className)}
    value={value ?? ""}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    disabled={disabled}
  />
);

const Textarea = ({
  value,
  onChange,
  placeholder,
  disabled,
  className = "w-full",
}) => (
  <textarea
    className={classNames("textarea textarea-bordered", className)}
    value={value ?? ""}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    disabled={disabled}
  />
);

const GhostButton = (props) => (
  <button
    {...props}
    className={classNames("btn btn-ghost btn-sm", props.className)}
  />
);
const PrimaryButton = (props) => (
  <button
    {...props}
    className={classNames("btn btn-primary", props.className)}
  />
);
const SubtleButton = (props) => (
  <button
    {...props}
    className={classNames("btn btn-outline btn-sm", props.className)}
  />
);
const DangerButton = (props) => (
  <button
    {...props}
    className={classNames("btn btn-error btn-sm", props.className)}
  />
);

const Divider = () => <div className="border-t border-base-200 my-4" />;

const InlineNotice = ({ tone = "info", children }) => {
  const toneClass =
    tone === "success"
      ? "alert-success"
      : tone === "warning"
      ? "alert-warning"
      : tone === "error"
      ? "alert-error"
      : "alert-info";
  return <div className={classNames("alert", toneClass)}>{children}</div>;
};

const Skeleton = ({ lines = 3 }) => (
  <div className="animate-pulse space-y-3">
    {Array.from({ length: lines }).map((_, i) => (
      <div key={i} className="h-4 bg-base-200 rounded" />
    ))}
  </div>
);

/* -------------------------------------------------------------------------- */
/* Undo stack (optimistic)                                                    */
/* -------------------------------------------------------------------------- */
function useUndoStack() {
  const stack = useRef([]);
  const push = (revert, descr = "Change") => {
    stack.current.push(revert);
    return {
      message: `${descr} applied`,
      undo: () => {
        const fn = stack.current.pop();
        if (fn) fn();
      },
    };
  };
  return { push };
}

/* -------------------------------------------------------------------------- */
/* Event glue                                                                 */
/* -------------------------------------------------------------------------- */
const EVENT_KEYS = [
  "recipe.consolidated", // update kitchen cleanup steps & labels
  "inventory.updated", // cleaning supplies availability -> tasks & shopping
  "calendar.synced", // surface success
  "preferences.changed", // quiet hours, time windows
  "torah.profile.updated", // if rules affect kitchen prep/cleanup flow
];

function useAutomationGlue(onEvent) {
  useEffect(() => {
    const offFns = [];
    EVENT_KEYS.forEach((k) => {
      const off = automation?.on?.(k, (payload) => onEvent?.(k, payload));
      if (off) offFns.push(off);
    });
    return () => offFns.forEach((f) => f?.());
  }, [onEvent]);
}

/* -------------------------------------------------------------------------- */
/* Zone list editor                                                           */
/* -------------------------------------------------------------------------- */
function ZoneEditor({ zones, onAdd, onUpdate, onRemove, busy }) {
  const [draftName, setDraftName] = useState("");
  const [draftNotes, setDraftNotes] = useState("");

  return (
    <div className="space-y-3">
      {zones.length === 0 ? (
        <div className="rounded-xl border border-dashed border-base-300 p-6 grid place-items-center text-center">
          <p className="font-medium">No zones set yet</p>
          <p className="text-sm opacity-70 mt-1">
            Zones help you rotate deep cleaning with less decision fatigue
            (e.g., Kitchen, Bathrooms, Entry, Bedrooms).
          </p>
          <div className="mt-3 flex gap-2">
            <Input
              value={draftName}
              onChange={setDraftName}
              placeholder="e.g., Kitchen"
            />
            <PrimaryButton
              disabled={!draftName || busy}
              onClick={() => {
                onAdd?.({ name: draftName, notes: draftNotes });
                setDraftName("");
                setDraftNotes("");
              }}
            >
              Add Zone
            </PrimaryButton>
          </div>
          <div className="mt-2 w-full max-w-xl">
            <Textarea
              value={draftNotes}
              onChange={setDraftNotes}
              placeholder="Optional notes (surfaces, tools, etc.)"
            />
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-3">
            {zones.map((z, idx) => (
              <div
                key={z.id ?? idx}
                className="rounded-xl border border-base-200 p-4 bg-base-100"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <Input
                      className="w-72"
                      value={z.name}
                      onChange={(v) =>
                        onUpdate?.(z.id ?? idx, { ...z, name: v })
                      }
                      placeholder="Zone name"
                      disabled={busy}
                    />
                    <Textarea
                      className="w-full mt-2"
                      value={z.notes ?? ""}
                      onChange={(v) =>
                        onUpdate?.(z.id ?? idx, { ...z, notes: v })
                      }
                      placeholder="Notes (surfaces, supplies, equipment)"
                      disabled={busy}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Select
                      className="w-40"
                      value={z.frequency ?? "weekly"}
                      onChange={(v) =>
                        onUpdate?.(z.id ?? idx, { ...z, frequency: v })
                      }
                      options={[
                        { value: "daily", label: "Daily" },
                        { value: "weekly", label: "Weekly" },
                        { value: "biweekly", label: "Every 2 Weeks" },
                        { value: "monthly", label: "Monthly" },
                      ]}
                      disabled={busy}
                    />
                    <Select
                      className="w-40"
                      value={z.window ?? "any"}
                      onChange={(v) =>
                        onUpdate?.(z.id ?? idx, { ...z, window: v })
                      }
                      options={[
                        { value: "any", label: "Any time" },
                        { value: "quiet", label: "Quiet hours only" },
                        { value: "daylight", label: "Daylight hours" },
                      ]}
                      disabled={busy}
                    />
                    <DangerButton
                      onClick={() => onRemove?.(z.id ?? idx)}
                      disabled={busy}
                    >
                      Remove
                    </DangerButton>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <Divider />
          <div className="flex items-center gap-2">
            <Input
              value={draftName}
              onChange={setDraftName}
              placeholder="Add another zone…"
            />
            <PrimaryButton
              disabled={!draftName || busy}
              onClick={() => {
                onAdd?.({ name: draftName, notes: draftNotes });
                setDraftName("");
                setDraftNotes("");
              }}
            >
              Add Zone
            </PrimaryButton>
            <Textarea
              className="w-[28rem]"
              value={draftNotes}
              onChange={setDraftNotes}
              placeholder="Notes for new zone (optional)"
            />
          </div>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Main page                                                                  */
/* -------------------------------------------------------------------------- */

export default function CleaningSettingsPage() {
  const cleaning = useCleaningStore?.() ?? {};
  const prefs = usePreferencesStore?.() ?? {};

  const loading = cleaning.loading || false;
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [banners, setBanners] = useState([]);

  const undo = useUndoStack();

  // Core prefs / settings
  const [autoAssign, setAutoAssign] = useState(cleaning.autoAssign ?? true);
  const [sabbathBlock, setSabbathBlock] = useState(
    cleaning.sabbathBlock ?? true
  );
  const [quietHours, setQuietHours] = useState(
    cleaning.quietHours || { start: "21:00", end: "07:00" }
  );
  const [defaultRotation, setDefaultRotation] = useState(
    cleaning.defaultRotation || "weekly"
  );
  const [emitForecastToFamily, setEmitForecastToFamily] = useState(
    cleaning.emitForecastToFamily ?? true
  );
  const [syncToCalendar, setSyncToCalendar] = useState(
    cleaning.syncToCalendar ?? true
  );

  // Routine templates & zones
  const [templates, setTemplates] = useState(cleaning.templates || []); // [{id,name,steps:[...] }]
  const [zones, setZones] = useState(cleaning.zones || []); // [{id,name,notes,frequency,window}]

  /* -------------------------- Event-driven glue -------------------------- */
  useAutomationGlue((event, payload) => {
    if (event === "recipe.consolidated") {
      addBanner({
        key: "kitchen.cleanup",
        tone: "info",
        text: "Recipes consolidated. Consider regenerating kitchen cleanup checklists and relinking to batch sessions.",
        actions: [
          {
            label: "Regenerate Kitchen Cleanup",
            fn: () => handleGenerate("kitchen-cleanup"),
          },
        ],
      });
    }
    if (event === "inventory.updated") {
      addBanner({
        key: "supplies",
        tone: "warning",
        text: "Inventory changed. Recompute cleaning supplies & shopping list to avoid mid-task shortages.",
        actions: [
          { label: "Recompute Supplies", fn: () => handleGenerate("supplies") },
        ],
      });
    }
    if (event === "calendar.synced") {
      addBanner({
        key: "synced",
        tone: "success",
        text: "Calendar sync complete.",
        dismissible: true,
      });
    }
    if (event === "preferences.changed") {
      setToast({
        tone: "info",
        text: "Preferences updated. Quiet hours & windows will be respected.",
      });
    }
    if (event === "torah.profile.updated") {
      // Surface as FYI; kitchen context may alter pre/post meal cleaning flow.
      addBanner({
        key: "torah-update",
        tone: "info",
        text: "Dietary profile changed. Kitchen prep/cleanup sequences may have shifted. Review your templates.",
        actions: [{ label: "Open Templates", fn: () => openTemplates() }],
      });
    }
  });

  function addBanner(b) {
    setBanners((prev) =>
      prev.find((x) => x.key === b.key) ? prev : [...prev, b]
    );
  }
  function dismissBanner(key) {
    setBanners((prev) => prev.filter((b) => b.key !== key));
  }

  /* ----------------------------- Persistence ----------------------------- */
  const optimisticSave = async (partial, descr = "Settings") => {
    const prev = {
      autoAssign,
      sabbathBlock,
      quietHours,
      defaultRotation,
      emitForecastToFamily,
      syncToCalendar,
      templates,
      zones,
    };

    // apply optimistic
    if ("autoAssign" in partial) setAutoAssign(partial.autoAssign);
    if ("sabbathBlock" in partial) setSabbathBlock(partial.sabbathBlock);
    if ("quietHours" in partial) setQuietHours(partial.quietHours);
    if ("defaultRotation" in partial)
      setDefaultRotation(partial.defaultRotation);
    if ("emitForecastToFamily" in partial)
      setEmitForecastToFamily(partial.emitForecastToFamily);
    if ("syncToCalendar" in partial) setSyncToCalendar(partial.syncToCalendar);
    if ("templates" in partial) setTemplates(partial.templates);
    if ("zones" in partial) setZones(partial.zones);

    const { undo: revert } = undo.push(() => {
      setAutoAssign(prev.autoAssign);
      setSabbathBlock(prev.sabbathBlock);
      setQuietHours(prev.quietHours);
      setDefaultRotation(prev.defaultRotation);
      setEmitForecastToFamily(prev.emitForecastToFamily);
      setSyncToCalendar(prev.syncToCalendar);
      setTemplates(prev.templates);
      setZones(prev.zones);
    }, descr);

    setBusy(true);
    try {
      if (cleaning.saveSettings) {
        await cleaning.saveSettings({ ...prev, ...partial });
      } else {
        await automation.request?.("cleaning.saveSettings", {
          ...prev,
          ...partial,
        });
      }
      setToast({
        tone: "success",
        text: `${descr} saved`,
        action: { label: "Undo", fn: () => revert() },
      });
      emitProgress?.("settings.saved", {
        scope: "cleaning",
        nextBestAction: suggestNBA(partial),
      });
    } catch (e) {
      revert();
      setToast({ tone: "error", text: `Failed to save ${descr}.` });
    } finally {
      setBusy(false);
    }
  };

  const suggestNBA = (partial) => {
    if ("zones" in partial) {
      return {
        label: "Rebuild Rotation",
        action: () => handleGenerate("rotation"),
      };
    }
    if ("templates" in partial) {
      return {
        label: "Generate Weekly Plan",
        action: () => handleGenerate("weekly"),
      };
    }
    if ("emitForecastToFamily" in partial) {
      return {
        label: "Send Forecast Now",
        action: () => handleShareForecast(),
      };
    }
    if ("syncToCalendar" in partial || "quietHours" in partial) {
      return {
        label: "Sync to Calendar",
        action: () => handleSync("cleaning"),
      };
    }
    return {
      label: "Open Cleaning Dashboard",
      action: () => openCleaningDashboard(),
    };
  };

  /* ------------------------------- Actions -------------------------------- */
  const handleGenerate = async (scope) => {
    const task = async () => {
      setBusy(true);
      try {
        if (cleaning.generate) {
          await cleaning.generate(scope);
        } else {
          await automation.request?.("cleaning.generate", { scope });
        }
        setToast({
          tone: "success",
          text: `Generated ${labelForScope(scope)}.`,
        });
      } catch (e) {
        setToast({
          tone: "error",
          text: `Failed to generate ${labelForScope(scope)}.`,
        });
      } finally {
        setBusy(false);
      }
    };
    // Writing tasks are restricted on Sabbath unless allowed
    await sabbathGuard(task, { allowReadOnly: false });
  };

  const handleSync = async (scope = "cleaning") => {
    const task = async () => {
      try {
        if (cleaning.syncNow) {
          await cleaning.syncNow(scope);
        } else {
          await automation.request?.("calendar.sync", { scope });
        }
        automation.emit?.("calendar.synced", { scope });
        setToast({
          tone: "success",
          text: "Cleaning events synced to calendar.",
        });
      } catch {
        setToast({ tone: "error", text: "Calendar sync failed." });
      }
    };
    await sabbathGuard(task, { allowReadOnly: true });
  };

  const handleShareForecast = async () => {
    const task = async () => {
      try {
        await automation.request?.("sharing.family.cleaningForecast", {
          includeZones: true,
          includeTemplates: true,
          horizonDays: 28,
        });
        setToast({
          tone: "success",
          text: "Cleaning forecast sent to family planners.",
        });
      } catch {
        setToast({ tone: "error", text: "Could not send cleaning forecast." });
      }
    };
    await sabbathGuard(task, { allowReadOnly: true });
  };

  const openCleaningDashboard = () =>
    automation.emit?.("ui.navigate", { to: "/tier2/household/cleaning" });
  const openTemplates = () =>
    automation.emit?.("ui.navigate", {
      to: "/tier2/household/cleaning/templates",
    });

  const labelForScope = (scope) =>
    ({
      weekly: "weekly plan",
      rotation: "zone rotation",
      "kitchen-cleanup": "kitchen cleanup lists",
      supplies: "supply plan",
    }[scope] || scope);

  /* ------------------------------- Templates ------------------------------ */
  const addTemplate = async () => {
    const newT = {
      id: crypto.randomUUID?.() ?? Date.now(),
      name: "New Routine",
      steps: ["Sweep", "Mop"],
    };
    const prev = templates;
    setTemplates((t) => [newT, ...t]);
    const { undo: revert } = undo.push(() => setTemplates(prev), "Add routine");

    setBusy(true);
    try {
      if (cleaning.saveSettings) {
        await cleaning.saveSettings({ templates: [newT, ...prev] });
      } else {
        await automation.request?.("cleaning.saveSettings", {
          templates: [newT, ...prev],
        });
      }
      setToast({
        tone: "success",
        text: "Routine added",
        action: { label: "Undo", fn: revert },
      });
    } catch {
      revert();
      setToast({ tone: "error", text: "Failed to add routine." });
    } finally {
      setBusy(false);
    }
  };

  const updateTemplate = async (id, patch) => {
    const next = templates.map((t) => (t.id === id ? { ...t, ...patch } : t));
    await optimisticSave({ templates: next }, "Routine");
  };

  const removeTemplate = async (id) => {
    const prev = templates;
    const next = templates.filter((t) => t.id !== id);
    setTemplates(next);
    const { undo: revert } = undo.push(
      () => setTemplates(prev),
      "Remove routine"
    );

    setBusy(true);
    try {
      if (cleaning.saveSettings) {
        await cleaning.saveSettings({ templates: next });
      } else {
        await automation.request?.("cleaning.saveSettings", {
          templates: next,
        });
      }
      setToast({
        tone: "success",
        text: "Routine removed",
        action: { label: "Undo", fn: revert },
      });
    } catch {
      revert();
      setToast({ tone: "error", text: "Failed to remove routine." });
    } finally {
      setBusy(false);
    }
  };

  /* --------------------------------- Zones -------------------------------- */
  const addZone = async (z) => {
    const nz = {
      id: crypto.randomUUID?.() ?? Date.now(),
      frequency: defaultRotation,
      window: "any",
      ...z,
    };
    const prev = zones;
    setZones((zs) => [...zs, nz]);
    const { undo: revert } = undo.push(() => setZones(prev), "Add zone");

    setBusy(true);
    try {
      if (cleaning.saveSettings) {
        await cleaning.saveSettings({ zones: [...prev, nz] });
      } else {
        await automation.request?.("cleaning.saveSettings", {
          zones: [...prev, nz],
        });
      }
      setToast({
        tone: "success",
        text: "Zone added",
        action: { label: "Undo", fn: revert },
      });
    } catch {
      revert();
      setToast({ tone: "error", text: "Failed to add zone." });
    } finally {
      setBusy(false);
    }
  };

  const updateZone = async (id, patch) => {
    const next = zones.map((z) =>
      (z.id ?? z._id) === id ? { ...z, ...patch } : z
    );
    await optimisticSave({ zones: next }, "Zone");
  };

  const removeZone = async (id) => {
    const prev = zones;
    const next = zones.filter((z) => (z.id ?? z._id) !== id);
    setZones(next);
    const { undo: revert } = undo.push(() => setZones(prev), "Remove zone");

    setBusy(true);
    try {
      if (cleaning.saveSettings) {
        await cleaning.saveSettings({ zones: next });
      } else {
        await automation.request?.("cleaning.saveSettings", { zones: next });
      }
      setToast({
        tone: "success",
        text: "Zone removed",
        action: { label: "Undo", fn: revert },
      });
    } catch {
      revert();
      setToast({ tone: "error", text: "Failed to remove zone." });
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------- Lifecycle ------------------------------ */
  useEffect(() => {
    cleaning.fetchSettings?.();
  }, []); // eslint-disable-line

  /* --------------------------------- UI ---------------------------------- */
  return (
    <div className="max-w-6xl mx-auto px-4 md:px-6 lg:px-2 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Cleaning Settings</h1>
          <p className="opacity-70">
            Configure cleaning routines, zone rotations, quiet hours, Sabbath
            guard, and calendar/forecast sync.
          </p>
        </div>
        <div className="flex gap-2">
          <GhostButton onClick={() => handleGenerate("weekly")}>
            Generate Weekly Plan
          </GhostButton>
          <PrimaryButton onClick={() => openCleaningDashboard()}>
            Open Cleaning
          </PrimaryButton>
        </div>
      </div>

      {/* Event-driven banners */}
      {banners.map((b) => (
        <InlineNotice key={b.key} tone={b.tone}>
          <div className="flex items-center justify-between w-full">
            <span>{b.text}</span>
            <div className="flex items-center gap-2">
              {b.actions?.map((a, i) => (
                <SubtleButton key={i} onClick={a.fn}>
                  {a.label}
                </SubtleButton>
              ))}
              {b.dismissible !== false && (
                <GhostButton onClick={() => dismissBanner(b.key)}>
                  Dismiss
                </GhostButton>
              )}
            </div>
          </div>
        </InlineNotice>
      ))}

      {/* Defaults & Behavior */}
      <SectionCard
        title="Defaults & Behavior"
        subtitle="Apply household-wide rules and automation behavior."
      >
        {loading ? (
          <Skeleton lines={5} />
        ) : (
          <>
            <Row
              label="Default Zone Rotation"
              hint="How often each zone should cycle by default."
            >
              <Select
                value={defaultRotation}
                onChange={(v) =>
                  optimisticSave({ defaultRotation: v }, "Default rotation")
                }
                options={[
                  { value: "weekly", label: "Weekly" },
                  { value: "biweekly", label: "Every 2 Weeks" },
                  { value: "monthly", label: "Monthly" },
                ]}
                disabled={busy}
              />
            </Row>

            <Row
              label="Auto-Assign by Household Roles"
              hint="Auto distributes tasks by availability, skill, and role. Undo is available from toasts."
            >
              <Toggle
                checked={autoAssign}
                onChange={(v) =>
                  optimisticSave({ autoAssign: v }, "Auto-assign")
                }
                disabled={busy}
              />
            </Row>

            <Row
              label="Sabbath Guard"
              hint="Avoid creating/editing tasks during Sabbath. Read-only operations still allowed."
            >
              <Toggle
                checked={sabbathBlock}
                onChange={(v) =>
                  optimisticSave({ sabbathBlock: v }, "Sabbath guard")
                }
                disabled={busy}
              />
            </Row>

            <Row
              label="Quiet Hours"
              hint="Tasks that create noise will be scheduled outside of quiet hours."
            >
              <Input
                className="w-32"
                value={quietHours.start}
                onChange={(v) =>
                  optimisticSave(
                    { quietHours: { ...quietHours, start: v } },
                    "Quiet hours"
                  )
                }
                placeholder="21:00"
                disabled={busy}
              />
              <span className="opacity-60">to</span>
              <Input
                className="w-32"
                value={quietHours.end}
                onChange={(v) =>
                  optimisticSave(
                    { quietHours: { ...quietHours, end: v } },
                    "Quiet hours"
                  )
                }
                placeholder="07:00"
                disabled={busy}
              />
            </Row>

            <Row
              label="Sync Cleaning to Calendar"
              hint="Create/refresh calendar events for your plans and rotations."
            >
              <Toggle
                checked={syncToCalendar}
                onChange={(v) =>
                  optimisticSave({ syncToCalendar: v }, "Calendar sync")
                }
                disabled={busy}
              />
              <SubtleButton
                onClick={() => handleSync("cleaning")}
                disabled={busy}
              >
                Sync now
              </SubtleButton>
            </Row>

            <Row
              label="Share Cleaning Forecast with Family"
              hint="Send a 4-week forecast to the family planning channel for coordination."
            >
              <Toggle
                checked={emitForecastToFamily}
                onChange={(v) =>
                  optimisticSave({ emitForecastToFamily: v }, "Family forecast")
                }
                disabled={busy}
              />
              <SubtleButton
                onClick={() => handleShareForecast()}
                disabled={busy}
              >
                Send now
              </SubtleButton>
            </Row>
          </>
        )}
      </SectionCard>

      {/* Routine Templates */}
      <SectionCard
        title="Routine Templates"
        subtitle="Reusable checklists for rooms and tasks. Link to batch cooking cleanups and seasonal deep cleans."
        right={
          <PrimaryButton onClick={addTemplate} disabled={busy}>
            New Routine
          </PrimaryButton>
        }
      >
        {loading ? (
          <Skeleton lines={4} />
        ) : templates.length === 0 ? (
          <div className="rounded-xl border border-dashed border-base-300 p-6 grid place-items-center text-center">
            <p className="font-medium">No routines yet</p>
            <p className="text-sm opacity-70 mt-1">
              Start with a “Kitchen Daily Reset” or “Bathroom Weekly
              Deep-Clean.” Add steps and save.
            </p>
            <div className="mt-3">
              <PrimaryButton onClick={addTemplate} disabled={busy}>
                Create First Routine
              </PrimaryButton>
            </div>
          </div>
        ) : (
          <div className="grid gap-3">
            {templates.map((t) => (
              <div
                key={t.id}
                className="rounded-xl border border-base-200 p-4 bg-base-100"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <Input
                      className="w-80"
                      value={t.name}
                      onChange={(v) => updateTemplate(t.id, { name: v })}
                      placeholder="Routine name"
                      disabled={busy}
                    />
                    <div className="mt-2 space-y-2">
                      {(t.steps ?? []).map((s, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <Input
                            className="w-full"
                            value={s}
                            onChange={(v) => {
                              const steps = [...(t.steps ?? [])];
                              steps[i] = v;
                              updateTemplate(t.id, { steps });
                            }}
                            placeholder={`Step ${i + 1}`}
                            disabled={busy}
                          />
                          <DangerButton
                            onClick={() => {
                              const steps = (t.steps ?? []).filter(
                                (_, idx) => idx !== i
                              );
                              updateTemplate(t.id, { steps });
                            }}
                            disabled={busy}
                          >
                            Remove
                          </DangerButton>
                        </div>
                      ))}
                      <SubtleButton
                        onClick={() =>
                          updateTemplate(t.id, {
                            steps: [...(t.steps ?? []), ""],
                          })
                        }
                        disabled={busy}
                      >
                        + Add Step
                      </SubtleButton>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Select
                      className="w-44"
                      value={t.frequency ?? "weekly"}
                      onChange={(v) => updateTemplate(t.id, { frequency: v })}
                      options={[
                        { value: "daily", label: "Daily" },
                        { value: "weekly", label: "Weekly" },
                        { value: "biweekly", label: "Every 2 Weeks" },
                        { value: "monthly", label: "Monthly" },
                        { value: "seasonal", label: "Seasonal" },
                      ]}
                      disabled={busy}
                    />
                    <Select
                      className="w-44"
                      value={t.window ?? "any"}
                      onChange={(v) => updateTemplate(t.id, { window: v })}
                      options={[
                        { value: "any", label: "Any time" },
                        { value: "quiet", label: "Quiet hours only" },
                        { value: "daylight", label: "Daylight hours" },
                      ]}
                      disabled={busy}
                    />
                    <DangerButton
                      onClick={() => removeTemplate(t.id)}
                      disabled={busy}
                    >
                      Delete
                    </DangerButton>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        <Divider />
        <div className="flex items-center gap-2">
          <PrimaryButton
            onClick={() => handleGenerate("weekly")}
            disabled={busy}
          >
            Generate Weekly Plan
          </PrimaryButton>
          <SubtleButton
            onClick={() => handleGenerate("kitchen-cleanup")}
            disabled={busy}
          >
            Regenerate Kitchen Cleanup
          </SubtleButton>
          <SubtleButton onClick={() => openTemplates()}>
            Open Template Library
          </SubtleButton>
        </div>
      </SectionCard>

      {/* Zones & Rotation */}
      <SectionCard
        title="Zones & Rotation"
        subtitle="Break your home into zones to rotate deep cleaning and prevent overwhelm."
        right={
          <SubtleButton
            onClick={() => handleGenerate("rotation")}
            disabled={busy}
          >
            Rebuild Rotation
          </SubtleButton>
        }
      >
        {loading ? (
          <Skeleton lines={4} />
        ) : (
          <ZoneEditor
            zones={zones}
            onAdd={addZone}
            onUpdate={updateZone}
            onRemove={removeZone}
            busy={busy}
          />
        )}
      </SectionCard>

      {/* Next Steps */}
      <SectionCard
        title="Recommended Next Steps"
        subtitle="Keep momentum with one clear action."
      >
        <div className="flex flex-wrap gap-2">
          <PrimaryButton
            onClick={() => handleGenerate("weekly")}
            disabled={busy}
          >
            Generate Weekly Plan
          </PrimaryButton>
          <SubtleButton onClick={() => handleSync("cleaning")} disabled={busy}>
            Sync to Calendar
          </SubtleButton>
          <SubtleButton onClick={() => handleShareForecast()} disabled={busy}>
            Send Family Forecast
          </SubtleButton>
          <SubtleButton
            onClick={() =>
              automation.emit?.("ui.navigate", { to: "/tier2/household/meals" })
            }
          >
            Link Kitchen Cleanup to Batch Sessions
          </SubtleButton>
          <SubtleButton
            onClick={() =>
              automation.emit?.("ui.navigate", {
                to: "/tier2/household/inventory",
              })
            }
          >
            Check Cleaning Supplies
          </SubtleButton>
        </div>
      </SectionCard>

      {/* Toast */}
      {toast && (
        <div className="toast toast-end z-50">
          <div
            className={classNames(
              "alert",
              toast.tone === "success"
                ? "alert-success"
                : toast.tone === "warning"
                ? "alert-warning"
                : toast.tone === "error"
                ? "alert-error"
                : "alert-info"
            )}
          >
            <div className="flex items-center gap-3">
              <span>{toast.text}</span>
              {toast.action ? (
                <button
                  className="btn btn-xs"
                  onClick={() => toast.action.fn?.()}
                >
                  {toast.action.label}
                </button>
              ) : null}
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => setToast(null)}
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Notes for integrators                                                      */
/*
Expected CleaningStore shape (optional, graceful fallback if missing):
  useCleaningStore(): {
    loading?: boolean
    autoAssign?: boolean
    sabbathBlock?: boolean
    quietHours?: { start:string, end:string }
    defaultRotation?: "weekly"|"biweekly"|"monthly"
    emitForecastToFamily?: boolean
    syncToCalendar?: boolean
    templates?: Array<{ id:string, name:string, steps:string[], frequency?:string, window?:string }>
    zones?: Array<{ id:string, name:string, notes?:string, frequency?:string, window?:string }>
    // methods:
    fetchSettings?: () => Promise<void>
    saveSettings?: (settings) => Promise<void>
    generate?: (scope:"weekly"|"rotation"|"kitchen-cleanup"|"supplies") => Promise<void>
    syncNow?: (scope:"cleaning") => Promise<void>
  }

Automation runtime fallbacks used if store fns are absent:
  automation.request("cleaning.saveSettings", payload)
  automation.request("cleaning.generate", { scope })
  automation.request("calendar.sync", { scope: "cleaning" })
  automation.request("sharing.family.cleaningForecast", { includeZones, includeTemplates, horizonDays })
  automation.on("event", handler)
  automation.emit("ui.navigate", { to:"/route" })
  automation.emit("calendar.synced", { scope:"cleaning" })

Event-driven glue (listens to):
  recipe.consolidated  -> suggest regen of kitchen cleanup lists
  inventory.updated    -> recompute supplies/shopping
  calendar.synced      -> success banner
  preferences.changed  -> inform quiet hours applied
  torah.profile.updated-> prompt to review kitchen templates

Undo pattern:
  All saves are optimistic and push a revert callback; toast includes Undo.

Empty states:
  When no templates or zones, dashed cards surface clear CTAs and examples.

Access/Flows:
  "Generate Weekly Plan" (primary), "Sync to Calendar" (secondary), "Send Family Forecast" (secondary)
  Single “Next Best Action” in emitProgress after each significant save.

Design system:
  Tailwind + DaisyUI; button atoms unified across sections.
*/
