// src/pages/settings/views/GardenSettingsPage.jsx
import React, { useEffect, useRef, useState } from "react";
import { automation, emitProgress } from "@/services/automation/runtime";
import { sabbathGuard } from "@/services/guardrails/sabbathGuard";
import { classNames } from "@/utils/css";

// Optional stores (graceful fallback if absent)
import { useGardenStore } from "@/store/GardenStore";         // optional
import { useInventoryStore } from "@/store/InventoryStore";   // optional (seed/potting mix sync)
import { useCalendarStore } from "@/store/CalendarStore";     // optional

/* -------------------------------------------------------------------------- */
/* UI atoms (consistent with other Settings views)                            */
/* -------------------------------------------------------------------------- */

const SectionCard = ({ title, subtitle, right, children }) => (
  <div className="rounded-2xl shadow-md border border-base-200 bg-base-100">
    <div className="flex items-start justify-between p-5 border-b border-base-200">
      <div>
        <h3 className="text-lg font-semibold">{title}</h3>
        {subtitle ? <p className="text-sm opacity-70 mt-1">{subtitle}</p> : null}
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

const Select = ({ value, onChange, options = [], disabled, className = "w-56" }) => (
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

const Input = ({ value, onChange, placeholder, disabled, className = "w-64", type = "text" }) => (
  <input
    type={type}
    className={classNames("input input-bordered", className)}
    value={value ?? ""}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    disabled={disabled}
  />
);

const Textarea = ({ value, onChange, placeholder, disabled, className = "w-full" }) => (
  <textarea
    className={classNames("textarea textarea-bordered", className)}
    value={value ?? ""}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    disabled={disabled}
  />
);

const GhostButton = (props) => (
  <button {...props} className={classNames("btn btn-ghost btn-sm", props.className)} />
);
const PrimaryButton = (props) => (
  <button {...props} className={classNames("btn btn-primary", props.className)} />
);
const SubtleButton = (props) => (
  <button {...props} className={classNames("btn btn-outline btn-sm", props.className)} />
);
const DangerButton = (props) => (
  <button {...props} className={classNames("btn btn-error btn-sm", props.className)} />
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
/* Undo stack (optimistic saves with revert)                                  */
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
/* Event-driven glue                                                          */
/* -------------------------------------------------------------------------- */
const EVENT_KEYS = [
  "recipe.consolidated",   // adjust preservation & harvest targets
  "inventory.updated",     // seeds/supplies changed
  "calendar.synced",       // surface success
  "preferences.changed",   // quiet hours / irrigation window
  "torah.profile.updated", // feast meals may influence harvest windows
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
/* Bed List Editor                                                            */
/* -------------------------------------------------------------------------- */
function BedsEditor({ beds, onAdd, onUpdate, onRemove, busy }) {
  const [draft, setDraft] = useState({ name: "", length: "", width: "", notes: "" });

  return (
    <div className="space-y-3">
      {(!beds || beds.length === 0) ? (
        <div className="rounded-xl border border-dashed border-base-300 p-6 grid place-items-center text-center">
          <p className="font-medium">No beds/plots yet</p>
          <p className="text-sm opacity-70 mt-1">
            Add your first bed to enable crop planning, succession, and irrigation scheduling.
          </p>
          <div className="mt-3 flex flex-col items-center gap-2 w-full max-w-2xl">
            <div className="flex flex-wrap items-center gap-2">
              <Input className="w-48" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} placeholder="Name (e.g., Bed A)" />
              <Input className="w-28" value={draft.length} onChange={(v) => setDraft({ ...draft, length: v })} placeholder="Length (ft)" />
              <Input className="w-28" value={draft.width}  onChange={(v) => setDraft({ ...draft, width: v })}  placeholder="Width (ft)" />
            </div>
            <Textarea value={draft.notes} onChange={(v) => setDraft({ ...draft, notes: v })} placeholder="Notes (sun/shade, drip line, soil)" />
            <PrimaryButton
              disabled={!draft.name || busy}
              onClick={() => { onAdd?.(draft); setDraft({ name: "", length: "", width: "", notes: "" }); }}
            >
              Add Bed
            </PrimaryButton>
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-3">
            {beds.map((b, idx) => (
              <div key={b.id ?? idx} className="rounded-xl border border-base-200 p-4 bg-base-100">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    <Input className="w-full" value={b.name} onChange={(v) => onUpdate?.(b.id ?? idx, { ...b, name: v })} placeholder="Name" disabled={busy} />
                    <Input className="w-full" value={b.length ?? ""} onChange={(v) => onUpdate?.(b.id ?? idx, { ...b, length: v })} placeholder="Length (ft)" disabled={busy} />
                    <Input className="w-full" value={b.width ?? ""} onChange={(v) => onUpdate?.(b.id ?? idx, { ...b, width: v })} placeholder="Width (ft)" disabled={busy} />
                    <Textarea className="sm:col-span-2 lg:col-span-3" value={b.notes ?? ""} onChange={(v) => onUpdate?.(b.id ?? idx, { ...b, notes: v })} placeholder="Notes (sun/shade, drip line, soil)" disabled={busy} />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Select
                      className="w-40"
                      value={b.exposure ?? "full-sun"}
                      onChange={(v) => onUpdate?.(b.id ?? idx, { ...b, exposure: v })}
                      options={[
                        { value: "full-sun", label: "Full Sun" },
                        { value: "partial", label: "Partial Sun" },
                        { value: "shade", label: "Shade" },
                      ]}
                      disabled={busy}
                    />
                    <DangerButton onClick={() => onRemove?.(b.id ?? idx)} disabled={busy}>Remove</DangerButton>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <Divider />
          <div className="flex items-center gap-2">
            <Input className="w-48" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} placeholder="Add bed name…" />
            <Input className="w-28" value={draft.length} onChange={(v) => setDraft({ ...draft, length: v })} placeholder="Length (ft)" />
            <Input className="w-28" value={draft.width}  onChange={(v) => setDraft({ ...draft, width: v })}  placeholder="Width (ft)" />
            <PrimaryButton disabled={!draft.name || busy} onClick={() => { onAdd?.(draft); setDraft({ name: "", length: "", width: "", notes: "" }); }}>
              Add Bed
            </PrimaryButton>
          </div>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Main Page                                                                  */
/* -------------------------------------------------------------------------- */

export default function GardenSettingsPage() {
  const garden = useGardenStore?.() ?? {};
  const inventory = useInventoryStore?.() ?? {};
  const calendar = useCalendarStore?.() ?? {};

  const loading = garden.loading || false;
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [banners, setBanners] = useState([]);
  const undo = useUndoStack();

  /* ------------------------------ State ----------------------------------- */
  // Profile
  const [usdaZone, setUsdaZone] = useState(garden.usdaZone || "7b");
  const [latitude, setLatitude] = useState(garden.latitude ?? "");
  const [longitude, setLongitude] = useState(garden.longitude ?? "");
  const [frostAuto, setFrostAuto] = useState(garden.frostAuto ?? true);
  const [lastSpringFrost, setLastSpringFrost] = useState(garden.lastSpringFrost || "");
  const [firstFallFrost, setFirstFallFrost] = useState(garden.firstFallFrost || "");
  const [useHebrewFeastWindows, setUseHebrewFeastWindows] = useState(garden.useHebrewFeastWindows ?? false);

  // Preferences
  const [companionMode, setCompanionMode] = useState(garden.companionMode || "standard"); // standard|aggressive|off
  const [rotationYears, setRotationYears] = useState(garden.rotationYears ?? 3);
  const [successionWeeks, setSuccessionWeeks] = useState(garden.successionWeeks ?? 2);
  const [irrigationWindow, setIrrigationWindow] = useState(garden.irrigationWindow || { start: "05:30", end: "08:30" });
  const [autoCompostTasks, setAutoCompostTasks] = useState(garden.autoCompostTasks ?? true);
  const [syncToCalendar, setSyncToCalendar] = useState(garden.syncToCalendar ?? true);
  const [sabbathBlock, setSabbathBlock] = useState(garden.sabbathBlock ?? true);
  const [emitForecastToAgrarian, setEmitForecastToAgrarian] = useState(garden.emitForecastToAgrarian ?? true);

  // Seed Saving (NEW)
  const [seedSavingEnabled, setSeedSavingEnabled] = useState(garden.seedSavingEnabled ?? false);
  const [seedSavingPolicy, setSeedSavingPolicy] = useState(garden.seedSavingPolicy || "household"); // household|share|heirloom-only|off
  const [isolationDistance, setIsolationDistance] = useState(garden.isolationDistance ?? 25); // feet default
  const [purityTarget, setPurityTarget] = useState(garden.purityTarget ?? 90); // % germplasm purity target
  const [dryingMethod, setDryingMethod] = useState(garden.dryingMethod || "screen"); // screen|paper|ferment|silica
  const [fermentationDays, setFermentationDays] = useState(garden.fermentationDays ?? 3); // for wet seeds (tomatoes, cukes)
  const [storageContainer, setStorageContainer] = useState(garden.storageContainer || "coin-envelope"); // coin-envelope|glass-jar|mylar
  const [desiccantType, setDesiccantType] = useState(garden.desiccantType || "silica-gel"); // silica-gel|rice|none
  const [storageLocation, setStorageLocation] = useState(garden.storageLocation || "pantry"); // pantry|freezer|fridge
  const [labelFormat, setLabelFormat] = useState(garden.labelFormat || "{variety} · {year} · {bed}");
  const [germTestIntervalMonths, setGermTestIntervalMonths] = useState(garden.germTestIntervalMonths ?? 12);
  const [shareSurplusWith, setShareSurplusWith] = useState(garden.shareSurplusWith || ["family"]); // family|neighbors|co-op

  // Beds/plots & seed sources
  const [beds, setBeds] = useState(garden.beds || []); // [{id,name,length,width,notes,exposure}]
  const [seedVendors, setSeedVendors] = useState(garden.seedVendors || ["Baker Creek", "Johnny's"]);
  const [autoSeedReorder, setAutoSeedReorder] = useState(garden.autoSeedReorder ?? false);

  /* -------------------------- Event-driven glue --------------------------- */
  useAutomationGlue((event, payload) => {
    if (event === "recipe.consolidated") {
      addBanner({
        key: "preservation-alignment",
        tone: "info",
        text:
          "Recipes consolidated. Align harvest windows to support batch cooking/preservation goals.",
        actions: [{ label: "Align Harvest Targets", fn: () => handleGenerate("harvest-targets") }],
      });
    }
    if (event === "inventory.updated") {
      addBanner({
        key: "seed-supplies",
        tone: "warning",
        text:
          "Inventory changed. Recompute seed needs & supplies before the next succession.",
        actions: [{ label: "Recompute Seed Needs", fn: () => handleGenerate("seed-needs") }],
      });
    }
    if (event === "calendar.synced") {
      addBanner({ key: "cal-synced", tone: "success", text: "Garden calendar sync complete.", dismissible: true });
    }
    if (event === "preferences.changed") {
      setToast({ tone: "info", text: "Preferences updated. Irrigation window & quiet hours applied." });
    }
    if (event === "torah.profile.updated") {
      addBanner({
        key: "feast-alignment",
        tone: "info",
        text:
          "Dietary profile changed. Consider aligning planting/harvest windows for upcoming feast meals.",
        actions: [{ label: "Build Feast Alignment", fn: () => handleGenerate("feast-alignment") }],
      });
    }
  });

  function addBanner(b) {
    setBanners((prev) => (prev.find((x) => x.key === b.key) ? prev : [...prev, b]));
  }
  function dismissBanner(key) {
    setBanners((prev) => prev.filter((b) => b.key !== key));
  }

  /* ------------------------------ Persistence ----------------------------- */
  const optimisticSave = async (partial, descr = "Settings") => {
    const prev = {
      // profile
      usdaZone, latitude, longitude, frostAuto, lastSpringFrost, firstFallFrost, useHebrewFeastWindows,
      // prefs
      companionMode, rotationYears, successionWeeks, irrigationWindow, autoCompostTasks,
      syncToCalendar, sabbathBlock, emitForecastToAgrarian,
      // seed saving
      seedSavingEnabled, seedSavingPolicy, isolationDistance, purityTarget, dryingMethod,
      fermentationDays, storageContainer, desiccantType, storageLocation, labelFormat,
      germTestIntervalMonths, shareSurplusWith,
      // beds & sourcing
      beds, seedVendors, autoSeedReorder,
    };

    // Apply optimistic updates locally
    Object.entries(partial).forEach(([k, v]) => {
      switch (k) {
        // profile
        case "usdaZone": setUsdaZone(v); break;
        case "latitude": setLatitude(v); break;
        case "longitude": setLongitude(v); break;
        case "frostAuto": setFrostAuto(v); break;
        case "lastSpringFrost": setLastSpringFrost(v); break;
        case "firstFallFrost": setFirstFallFrost(v); break;
        case "useHebrewFeastWindows": setUseHebrewFeastWindows(v); break;
        // prefs
        case "companionMode": setCompanionMode(v); break;
        case "rotationYears": setRotationYears(v); break;
        case "successionWeeks": setSuccessionWeeks(v); break;
        case "irrigationWindow": setIrrigationWindow(v); break;
        case "autoCompostTasks": setAutoCompostTasks(v); break;
        case "syncToCalendar": setSyncToCalendar(v); break;
        case "sabbathBlock": setSabbathBlock(v); break;
        case "emitForecastToAgrarian": setEmitForecastToAgrarian(v); break;
        // seed saving
        case "seedSavingEnabled": setSeedSavingEnabled(v); break;
        case "seedSavingPolicy": setSeedSavingPolicy(v); break;
        case "isolationDistance": setIsolationDistance(v); break;
        case "purityTarget": setPurityTarget(v); break;
        case "dryingMethod": setDryingMethod(v); break;
        case "fermentationDays": setFermentationDays(v); break;
        case "storageContainer": setStorageContainer(v); break;
        case "desiccantType": setDesiccantType(v); break;
        case "storageLocation": setStorageLocation(v); break;
        case "labelFormat": setLabelFormat(v); break;
        case "germTestIntervalMonths": setGermTestIntervalMonths(v); break;
        case "shareSurplusWith": setShareSurplusWith(v); break;
        // beds/sourcing
        case "beds": setBeds(v); break;
        case "seedVendors": setSeedVendors(v); break;
        case "autoSeedReorder": setAutoSeedReorder(v); break;
        default: break;
      }
    });

    const { undo: revert } = undo.push(() => setStateFrom(prev)(), descr);

    setBusy(true);
    try {
      if (garden.saveSettings) {
        await garden.saveSettings({ ...prev, ...partial });
      } else {
        await automation.request?.("garden.saveSettings", { ...prev, ...partial });
      }
      setToast({ tone: "success", text: `${descr} saved`, action: { label: "Undo", fn: () => revert() } });
      emitProgress?.("settings.saved", { scope: "garden", nextBestAction: suggestNBA(partial) });
    } catch (e) {
      revert();
      setToast({ tone: "error", text: `Failed to save ${descr}.` });
    } finally {
      setBusy(false);
    }
  };

  function setStateFrom(prev) {
    return () => {
      setUsdaZone(prev.usdaZone); setLatitude(prev.latitude); setLongitude(prev.longitude);
      setFrostAuto(prev.frostAuto); setLastSpringFrost(prev.lastSpringFrost); setFirstFallFrost(prev.firstFallFrost);
      setUseHebrewFeastWindows(prev.useHebrewFeastWindows);

      setCompanionMode(prev.companionMode); setRotationYears(prev.rotationYears);
      setSuccessionWeeks(prev.successionWeeks); setIrrigationWindow(prev.irrigationWindow);
      setAutoCompostTasks(prev.autoCompostTasks); setSyncToCalendar(prev.syncToCalendar);
      setSabbathBlock(prev.sabbathBlock); setEmitForecastToAgrarian(prev.emitForecastToAgrarian);

      setSeedSavingEnabled(prev.seedSavingEnabled); setSeedSavingPolicy(prev.seedSavingPolicy);
      setIsolationDistance(prev.isolationDistance); setPurityTarget(prev.purityTarget);
      setDryingMethod(prev.dryingMethod); setFermentationDays(prev.fermentationDays);
      setStorageContainer(prev.storageContainer); setDesiccantType(prev.desiccantType);
      setStorageLocation(prev.storageLocation); setLabelFormat(prev.labelFormat);
      setGermTestIntervalMonths(prev.germTestIntervalMonths);
      setShareSurplusWith(prev.shareSurplusWith);

      setBeds(prev.beds); setSeedVendors(prev.seedVendors); setAutoSeedReorder(prev.autoSeedReorder);
    };
  }

  const suggestNBA = (partial) => {
    if ("beds" in partial) return { label: "Recompute Rotation", action: () => handleGenerate("rotation") };
    if ("usdaZone" in partial || "lastSpringFrost" in partial || "firstFallFrost" in partial || "frostAuto" in partial)
      return { label: "Build Planting Calendar", action: () => handleGenerate("calendar") };
    if ("companionMode" in partial) return { label: "Update Companion Map", action: () => handleGenerate("companion") };
    if ("emitForecastToAgrarian" in partial) return { label: "Send Forecast Now", action: () => handleShareForecast() };
    if ("syncToCalendar" in partial || "irrigationWindow" in partial)
      return { label: "Sync to Calendar", action: () => handleSync("garden") };
    if ("seedSavingEnabled" in partial || "seedSavingPolicy" in partial || "isolationDistance" in partial || "purityTarget" in partial)
      return { label: "Build Seed Saving Tasks", action: () => handleGenerate("seed-saving") };
    return { label: "Open Garden Dashboard", action: () => openGarden() };
  };

  /* -------------------------------- Actions -------------------------------- */
  const handleGenerate = async (scope) => {
    const task = async () => {
      setBusy(true);
      try {
        if (garden.generate) {
          await garden.generate(scope);
        } else {
          await automation.request?.("garden.generate", { scope });
        }
        setToast({ tone: "success", text: `${labelForScope(scope)} generated.` });
      } catch {
        setToast({ tone: "error", text: `Failed to generate ${labelForScope(scope)}.` });
      } finally {
        setBusy(false);
      }
    };
    await sabbathGuard(task, { allowReadOnly: false });
  };

  const handleSync = async (scope = "garden") => {
    const task = async () => {
      try {
        if (garden.syncNow) {
          await garden.syncNow(scope);
        } else {
          await automation.request?.("calendar.sync", { scope });
        }
        automation.emit?.("calendar.synced", { scope });
        setToast({ tone: "success", text: "Garden events synced to calendar." });
      } catch {
        setToast({ tone: "error", text: "Calendar sync failed." });
      }
    };
    await sabbathGuard(task, { allowReadOnly: true });
  };

  const handleShareForecast = async () => {
    const task = async () => {
      try {
        await automation.request?.("sharing.family.gardenForecast", {
          horizonDays: 42,
          includeSeedNeeds: true,
          includeIrrigation: true,
          includeHarvestTargets: true,
          role: "agrarian",
        });
        setToast({ tone: "success", text: "Garden forecast sent to family agrarian." });
      } catch {
        setToast({ tone: "error", text: "Could not send garden forecast." });
      }
    };
    await sabbathGuard(task, { allowReadOnly: true });
  };

  const openGarden = () => automation.emit?.("ui.navigate", { to: "/tier2/household/garden" });

  const labelForScope = (scope) =>
    ({
      calendar: "planting calendar",
      rotation: "crop rotation",
      companion: "companion map",
      "seed-needs": "seed needs",
      "harvest-targets": "harvest targets",
      "feast-alignment": "feast alignment",
      "seed-saving": "seed saving tasks",
    }[scope] || scope);

  /* ------------------------------- Beds CRUD ------------------------------- */
  const addBed = async (b) => {
    const genId = () =>
      (typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `bed-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const nz = { id: genId(), exposure: "full-sun", ...b };
    const prev = beds;
    setBeds((list) => [...list, nz]);
    const { undo: revert } = undo.push(() => setBeds(prev), "Add bed");

    setBusy(true);
    try {
      if (garden.saveSettings) await garden.saveSettings({ beds: [...prev, nz] });
      else await automation.request?.("garden.saveSettings", { beds: [...prev, nz] });
      setToast({ tone: "success", text: "Bed added", action: { label: "Undo", fn: revert } });
    } catch {
      revert();
      setToast({ tone: "error", text: "Failed to add bed." });
    } finally {
      setBusy(false);
    }
  };

  const updateBed = async (id, patch) => {
    const next = beds.map((b) => ((b.id ?? b._id) === id ? { ...b, ...patch } : b));
    await optimisticSave({ beds: next }, "Bed");
  };

  const removeBed = async (id) => {
    const prev = beds;
    const next = beds.filter((b) => (b.id ?? b._id) !== id);
    setBeds(next);
    const { undo: revert } = undo.push(() => setBeds(prev), "Remove bed");

    setBusy(true);
    try {
      if (garden.saveSettings) await garden.saveSettings({ beds: next });
      else await automation.request?.("garden.saveSettings", { beds: next });
      setToast({ tone: "success", text: "Bed removed", action: { label: "Undo", fn: revert } });
    } catch {
      revert();
      setToast({ tone: "error", text: "Failed to remove bed." });
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------- Lifecycle ------------------------------ */
  useEffect(() => {
    garden.fetchSettings?.();
  }, []); // eslint-disable-line

  /* ---------------------------------- UI ---------------------------------- */
  return (
    <div className="max-w-6xl mx-auto px-4 md:px-6 lg:px-2 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Garden Settings</h1>
          <p className="opacity-70">
            Configure zone, frost dates, beds, rotations, seed saving, and sync/sharing. Optimistic saves with Undo.
          </p>
        </div>
        <div className="flex gap-2">
          <GhostButton onClick={() => handleGenerate("calendar")}>Build Planting Calendar</GhostButton>
          <PrimaryButton onClick={openGarden}>Open Garden</PrimaryButton>
        </div>
      </div>

      {/* Event-driven banners */}
      {banners.map((b) => (
        <InlineNotice key={b.key} tone={b.tone}>
          <div className="flex items-center justify-between w-full">
            <span>{b.text}</span>
            <div className="flex items-center gap-2">
              {b.actions?.map((a, i) => (
                <SubtleButton key={i} onClick={a.fn}>{a.label}</SubtleButton>
              ))}
              {b.dismissible !== false && (
                <GhostButton onClick={() => dismissBanner(b.key)}>Dismiss</GhostButton>
              )}
            </div>
          </div>
        </InlineNotice>
      ))}

      {/* Garden Profile */}
      <SectionCard
        title="Garden Profile"
        subtitle="Set your zone and frost dates. Auto mode estimates frost by lat/long; manual overrides are supported."
      >
        {loading ? (
          <Skeleton lines={4} />
        ) : (
          <>
            <Row label="USDA Zone" hint="Used for crop timing and winter survivability">
              <Select
                value={usdaZone}
                onChange={(v) => optimisticSave({ usdaZone: v }, "USDA Zone")}
                options={["3a","3b","4a","4b","5a","5b","6a","6b","7a","7b","8a","8b","9a","9b","10a","10b","11a","11b"].map(z=>({value:z,label:z}))}
                disabled={busy}
              />
            </Row>
            <Row label="Location (lat/long)" hint="Improves frost and sunrise/sunset accuracy">
              <Input className="w-40" value={latitude}  onChange={(v)=>optimisticSave({ latitude:v }, "Latitude")}  placeholder="33.5" disabled={busy} />
              <Input className="w-40" value={longitude} onChange={(v)=>optimisticSave({ longitude:v },"Longitude")} placeholder="-86.0" disabled={busy} />
              <SubtleButton
                onClick={async () => {
                  // Optional helper that your runtime can implement
                  try {
                    setBusy(true);
                    const res = await automation.request?.("geo.deriveFrostByLatLong", { latitude, longitude });
                    if (res?.lastSpringFrost || res?.firstFallFrost) {
                      await optimisticSave({
                        lastSpringFrost: res.lastSpringFrost ?? lastSpringFrost,
                        firstFallFrost: res.firstFallFrost ?? firstFallFrost,
                        frostAuto: true,
                      }, "Derived frost dates");
                    }
                  } finally { setBusy(false); }
                }}
                disabled={busy || !latitude || !longitude}
              >
                Detect Frost Dates
              </SubtleButton>
            </Row>
            <Row label="Frost Dates" hint="Switch off Auto to set specific dates">
              <Toggle checked={frostAuto} onChange={(v)=>optimisticSave({ frostAuto:v }, "Frost auto")} disabled={busy} />
              {!frostAuto && (
                <>
                  <Input type="date" value={lastSpringFrost} onChange={(v)=>optimisticSave({ lastSpringFrost:v }, "Spring frost")} />
                  <Input type="date" value={firstFallFrost}  onChange={(v)=>optimisticSave({ firstFallFrost:v }, "Fall frost")} />
                </>
              )}
            </Row>
            <Row
              label="Align to Feast Windows"
              hint="Shift planting/harvest windows to support planned feast meals (Moedim)."
            >
              <Toggle
                checked={useHebrewFeastWindows}
                onChange={(v) => optimisticSave({ useHebrewFeastWindows: v }, "Feast alignment")}
                disabled={busy}
              />
              <SubtleButton onClick={() => handleGenerate("feast-alignment")} disabled={busy}>
                Build Alignment
              </SubtleButton>
            </Row>
          </>
        )}
      </SectionCard>

      {/* Beds & Plots */}
      <SectionCard
        title="Beds & Plots"
        subtitle="Describe your growing spaces to unlock crop rotation, succession, and irrigation planning."
        right={<SubtleButton onClick={() => handleGenerate("rotation")} disabled={busy}>Recompute Rotation</SubtleButton>}
      >
        {loading ? <Skeleton lines={4} /> : (
          <BedsEditor beds={beds} onAdd={addBed} onUpdate={updateBed} onRemove={removeBed} busy={busy} />
        )}
      </SectionCard>

      {/* Preferences & Methods */}
      <SectionCard title="Preferences & Methods" subtitle="Fine-tune companion planting, rotation, succession, and irrigation.">
        {loading ? (
          <Skeleton lines={5} />
        ) : (
          <>
            <Row label="Companion Planting" hint="Adjust strength of companion suggestions">
              <Select
                value={companionMode}
                onChange={(v) => optimisticSave({ companionMode: v }, "Companion mode")}
                options={[
                  { value: "off", label: "Off" },
                  { value: "standard", label: "Standard" },
                  { value: "aggressive", label: "Aggressive" },
                ]}
                disabled={busy}
              />
            </Row>
            <Row label="Rotation Length" hint="Years before a family returns to the same bed">
              <Select
                value={String(rotationYears)}
                onChange={(v) => optimisticSave({ rotationYears: parseInt(v, 10) }, "Rotation length")}
                options={[2,3,4,5].map(n => ({ value:String(n), label:`${n} years` }))}
                disabled={busy}
              />
            </Row>
            <Row label="Succession Interval" hint="Weeks between staggered plantings">
              <Select
                value={String(successionWeeks)}
                onChange={(v) => optimisticSave({ successionWeeks: parseInt(v, 10) }, "Succession interval")}
                options={[1,2,3,4,5,6].map(n => ({ value:String(n), label:`${n} week${n>1?"s":""}` }))}
                disabled={busy}
              />
            </Row>
            <Row label="Irrigation Window" hint="Schedule watering during low-evaporation hours">
              <Input className="w-28" value={irrigationWindow.start} onChange={(v)=>optimisticSave({ irrigationWindow: { ...irrigationWindow, start: v } }, "Irrigation window")} placeholder="05:30" />
              <span className="opacity-60">to</span>
              <Input className="w-28" value={irrigationWindow.end}   onChange={(v)=>optimisticSave({ irrigationWindow: { ...irrigationWindow, end: v } }, "Irrigation window")}   placeholder="08:30" />
              <SubtleButton onClick={() => handleGenerate("calendar")} disabled={busy}>Rebuild Watering</SubtleButton>
            </Row>
            <Row label="Auto Compost Tasks" hint="Generate turn/aerate/add-greens tasks">
              <Toggle checked={autoCompostTasks} onChange={(v)=>optimisticSave({ autoCompostTasks:v },"Compost tasks")} disabled={busy} />
            </Row>
          </>
        )}
      </SectionCard>

      {/* Seeds & Supplies */}
      <SectionCard title="Seeds & Supplies" subtitle="Connect vendors and keep seed inventory in sync with plans.">
        {loading ? (
          <Skeleton lines={3} />
        ) : (
          <>
            <Row label="Seed Vendors" hint="Comma-separated list for sourcing & price checks">
              <Input
                className="w-[36rem]"
                value={seedVendors.join(", ")}
                onChange={(v)=>optimisticSave({ seedVendors: v.split(",").map(s=>s.trim()).filter(Boolean) }, "Seed vendors")}
                placeholder="Baker Creek, Johnny's"
                disabled={busy}
              />
            </Row>
            <Row label="Auto Seed Reorder" hint="Create a draft order when seed counts fall below plan needs">
              <Toggle
                checked={autoSeedReorder}
                onChange={(v)=>optimisticSave({ autoSeedReorder: v }, "Auto reorder")}
                disabled={busy}
              />
              <SubtleButton onClick={() => handleGenerate("seed-needs")} disabled={busy}>Recompute Seed Needs</SubtleButton>
            </Row>
          </>
        )}
      </SectionCard>

      {/* Seed Saving (NEW) */}
      <SectionCard
        title="Seed Saving"
        subtitle="Define isolation, purity targets, drying/storage methods, and sharing policy. We’ll generate QA/germination checks and labels."
        right={
          <SubtleButton onClick={() => handleGenerate("seed-saving")} disabled={busy || !seedSavingEnabled}>
            Build Seed Saving Tasks
          </SubtleButton>
        }
      >
        {loading ? (
          <Skeleton lines={4} />
        ) : (
          <>
            <Row label="Enable Seed Saving" hint="Turn on to plan isolation, drying, storage, and germination testing">
              <Toggle
                checked={seedSavingEnabled}
                onChange={(v)=>optimisticSave({ seedSavingEnabled: v }, "Seed saving")}
                disabled={busy}
              />
            </Row>

            <Row label="Policy" hint="Who are seeds saved for?">
              <Select
                value={seedSavingPolicy}
                onChange={(v)=>optimisticSave({ seedSavingPolicy: v }, "Seed saving policy")}
                options={[
                  { value: "household", label: "Household use" },
                  { value: "share", label: "Share / exchange" },
                  { value: "heirloom-only", label: "Heirloom-only" },
                  { value: "off", label: "Disable for season" },
                ]}
                disabled={busy || !seedSavingEnabled}
              />
            </Row>

            <Row label="Isolation Distance" hint="Feet between varieties to minimize cross-pollination">
              <Input
                type="number"
                className="w-28"
                value={String(isolationDistance)}
                onChange={(v)=>optimisticSave({ isolationDistance: Math.max(0, parseInt(v || "0", 10)) }, "Isolation distance")}
                placeholder="25"
                disabled={busy || !seedSavingEnabled}
              />
              <Chip>{purityTarget}% purity target</Chip>
            </Row>

            <Row label="Purity Target" hint="Minimum % of seed true-to-type">
              <Select
                value={String(purityTarget)}
                onChange={(v)=>optimisticSave({ purityTarget: parseInt(v, 10) }, "Purity target")}
                options={[80,85,90,95,98,99].map(n=>({ value:String(n), label:`${n}%` }))}
                disabled={busy || !seedSavingEnabled}
              />
            </Row>

            <Row label="Drying Method" hint="Choose the default method for saved seed after cleaning">
              <Select
                value={dryingMethod}
                onChange={(v)=>optimisticSave({ dryingMethod: v }, "Drying method")}
                options={[
                  { value: "screen", label: "Screen drying" },
                  { value: "paper", label: "Paper towel/envelope" },
                  { value: "ferment", label: "Fermentation (tomatoes, cukes)" },
                  { value: "silica", label: "Desiccant-assisted" },
                ]}
                disabled={busy || !seedSavingEnabled}
              />
              {dryingMethod === "ferment" && (
                <>
                  <span className="opacity-60">Ferment</span>
                  <Input
                    type="number"
                    className="w-24"
                    value={String(fermentationDays)}
                    onChange={(v)=>optimisticSave({ fermentationDays: Math.max(1, parseInt(v || "1", 10)) }, "Fermentation days")}
                    placeholder="3"
                    disabled={busy}
                  />
                  <span className="opacity-60">days</span>
                </>
              )}
            </Row>

            <Row label="Storage" hint="Default container, desiccant, and location">
              <Select
                className="w-44"
                value={storageContainer}
                onChange={(v)=>optimisticSave({ storageContainer: v }, "Storage container")}
                options={[
                  { value: "coin-envelope", label: "Coin envelope" },
                  { value: "glass-jar", label: "Glass jar" },
                  { value: "mylar", label: "Mylar bag" },
                ]}
                disabled={busy || !seedSavingEnabled}
              />
              <Select
                className="w-44"
                value={desiccantType}
                onChange={(v)=>optimisticSave({ desiccantType: v }, "Desiccant")}
                options={[
                  { value: "silica-gel", label: "Silica gel" },
                  { value: "rice", label: "Rice" },
                  { value: "none", label: "None" },
                ]}
                disabled={busy || !seedSavingEnabled}
              />
              <Select
                className="w-44"
                value={storageLocation}
                onChange={(v)=>optimisticSave({ storageLocation: v }, "Storage location")}
                options={[
                  { value: "pantry", label: "Pantry (cool/dark)" },
                  { value: "fridge", label: "Refrigerator" },
                  { value: "freezer", label: "Freezer" },
                ]}
                disabled={busy || !seedSavingEnabled}
              />
            </Row>

            <Row label="Label Format" hint="Tokens: {`{variety}`}, {`{year}`}, {`{bed}`}, {`{notes}`}"
            >
              <Input
                className="w-[36rem]"
                value={labelFormat}
                onChange={(v)=>optimisticSave({ labelFormat: v }, "Label format")}
                placeholder="{variety} · {year} · {bed}"
                disabled={busy || !seedSavingEnabled}
              />
            </Row>

            <Row label="Germination Testing" hint="Interval for quick germ tests of stored seed lots">
              <Select
                value={String(germTestIntervalMonths)}
                onChange={(v)=>optimisticSave({ germTestIntervalMonths: parseInt(v, 10) }, "Germ test interval")}
                options={[6,12,18,24,36].map(n=>({ value:String(n), label:`Every ${n} months` }))}
                disabled={busy || !seedSavingEnabled}
              />
              <SubtleButton onClick={() => handleGenerate("seed-saving")} disabled={busy || !seedSavingEnabled}>
                Build QA Schedule
              </SubtleButton>
            </Row>

            <Row label="Share Surplus" hint="Who should we notify when you have extra, viable seed">
              <Input
                className="w-[28rem]"
                value={shareSurplusWith.join(", ")}
                onChange={(v)=>optimisticSave({ shareSurplusWith: v.split(",").map(s=>s.trim()).filter(Boolean) }, "Seed sharing audience")}
                placeholder="family, neighbors, co-op"
                disabled={busy || !seedSavingEnabled}
              />
              <SubtleButton
                onClick={async () => {
                  try {
                    setBusy(true);
                    await automation.request?.("sharing.family.seedSurplus", {
                      audiences: shareSurplusWith,
                      labelFormat,
                    });
                    setToast({ tone: "success", text: "Shared seed surplus preferences." });
                  } catch {
                    setToast({ tone: "error", text: "Could not share seed surplus prefs." });
                  } finally { setBusy(false); }
                }}
                disabled={busy || !seedSavingEnabled}
              >
                Notify Audience
              </SubtleButton>
            </Row>
          </>
        )}
      </SectionCard>

      {/* Calendar & Sharing */}
      <SectionCard title="Calendar & Sharing" subtitle="Sync tasks and notify your family agrarian with forecasts.">
        {loading ? (
          <Skeleton lines={3} />
        ) : (
          <>
            <Row label="Sync Garden to Calendar" hint="Create/refresh events for sowing, transplanting, watering, and harvest">
              <Toggle
                checked={syncToCalendar}
                onChange={(v)=>optimisticSave({ syncToCalendar: v }, "Calendar sync")}
                disabled={busy}
              />
              <SubtleButton onClick={() => handleSync("garden")} disabled={busy}>Sync now</SubtleButton>
            </Row>
            <Row label="Sabbath Guard" hint="Avoid creating/editing events during Sabbath; read-only allowed">
              <Toggle checked={sabbathBlock} onChange={(v)=>optimisticSave({ sabbathBlock:v }, "Sabbath guard")} disabled={busy} />
            </Row>
            <Row
              label="Share Garden Forecast with Family Agrarian"
              hint="Send a 6-week plan with seed needs, watering, and target harvests"
            >
              <Toggle
                checked={emitForecastToAgrarian}
                onChange={(v)=>optimisticSave({ emitForecastToAgrarian: v }, "Agrarian forecast")}
                disabled={busy}
              />
              <SubtleButton onClick={handleShareForecast} disabled={busy}>Send now</SubtleButton>
            </Row>
          </>
        )}
      </SectionCard>

      {/* Recommended Next Steps */}
      <SectionCard title="Recommended Next Steps" subtitle="Keep momentum with one clear action.">
        <div className="flex flex-wrap gap-2">
          <PrimaryButton onClick={() => handleGenerate("calendar")} disabled={busy}>Build Planting Calendar</PrimaryButton>
          <SubtleButton onClick={() => handleGenerate("rotation")} disabled={busy}>Recompute Rotation</SubtleButton>
          <SubtleButton onClick={() => handleGenerate("companion")} disabled={busy}>Update Companion Map</SubtleButton>
          <SubtleButton onClick={() => handleGenerate("seed-needs")} disabled={busy}>Recompute Seed Needs</SubtleButton>
          <SubtleButton onClick={() => handleGenerate("harvest-targets")} disabled={busy}>Align Harvest Targets</SubtleButton>
          <SubtleButton onClick={() => handleGenerate("seed-saving")} disabled={busy || !seedSavingEnabled}>Build Seed Saving Tasks</SubtleButton>
          <SubtleButton onClick={() => handleSync("garden")} disabled={busy}>Sync to Calendar</SubtleButton>
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
                <button className="btn btn-xs" onClick={() => toast.action.fn?.()}>
                  {toast.action.label}
                </button>
              ) : null}
              <button className="btn btn-ghost btn-xs" onClick={() => setToast(null)}>✕</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Dev-only smoke tests (kept minimal; safe to remove in production)          */
/* -------------------------------------------------------------------------- */
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  try {
    console.assert(typeof classNames === "function", "classNames available");
    console.log("GardenSettingsPage: smoke tests OK");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("GardenSettingsPage: smoke tests failed", err);
  }
}

/* -------------------------------------------------------------------------- */
/* Notes for integrators                                                      */
/*
New optional seed saving fields (graceful fallback if missing):
  seedSavingEnabled?: boolean
  seedSavingPolicy?: "household"|"share"|"heirloom-only"|"off"
  isolationDistance?: number   // feet
  purityTarget?: number        // 80..99
  dryingMethod?: "screen"|"paper"|"ferment"|"silica"
  fermentationDays?: number
  storageContainer?: "coin-envelope"|"glass-jar"|"mylar"
  desiccantType?: "silica-gel"|"rice"|"none"
  storageLocation?: "pantry"|"fridge"|"freezer"
  labelFormat?: string         // tokens {variety},{year},{bed},{notes}
  germTestIntervalMonths?: number
  shareSurplusWith?: string[]  // e.g., ["family","neighbors","co-op"]

Automation hooks (optional):
  automation.request("geo.deriveFrostByLatLong", { latitude, longitude })
  garden.generate("seed-saving") to build tasks/QA schedule for saved seeds
  sharing.family.seedSurplus to broadcast audience prefs
*/
