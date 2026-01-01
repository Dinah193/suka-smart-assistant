// src/pages/settings/views/CalendarSettingsPage.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { automation, emitProgress } from "@/services/automation/runtime";
import { useCalendarStore } from "@/store/CalendarStore";         // assumed Zustand/Redux hook
import { usePreferencesStore } from "@/store/PreferencesStore";   // assumed hook for global prefs
import { sabbathGuard } from "@/services/guardrails/sabbathGuard"; // wraps calls to avoid scheduling on Sabbath
import { classNames } from "@/utils/css";
import { formatDistanceToNow } from "date-fns";

/* -------------------------------------------------------------------------- */
/* Lightweight UI atoms (cards, rows, buttons)                                */
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

const ToggleRow = ({ label, hint, checked, onChange, disabled }) => (
  <div className="flex items-start justify-between py-3">
    <div className="pr-4">
      <p className="font-medium">{label}</p>
      {hint ? <p className="text-sm opacity-70">{hint}</p> : null}
    </div>
    <label className="cursor-pointer flex items-center gap-3">
      <input
        type="checkbox"
        className="toggle toggle-primary"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
    </label>
  </div>
);

const SelectRow = ({ label, hint, value, onChange, options = [], disabled }) => (
  <div className="flex items-start justify-between py-3">
    <div className="pr-4">
      <p className="font-medium">{label}</p>
      {hint ? <p className="text-sm opacity-70">{hint}</p> : null}
    </div>
    <select
      className="select select-bordered w-56"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    >
      {options.map((opt) => (
        <option key={opt.value ?? opt} value={opt.value ?? opt}>
          {opt.label ?? opt}
        </option>
      ))}
    </select>
  </div>
);

const InputRow = ({ label, hint, value, onChange, placeholder, disabled }) => (
  <div className="flex items-start justify-between py-3">
    <div className="pr-4">
      <p className="font-medium">{label}</p>
      {hint ? <p className="text-sm opacity-70">{hint}</p> : null}
    </div>
    <input
      className="input input-bordered w-96"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
    />
  </div>
);

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

const GhostButton = (props) => (
  <button {...props} className={classNames("btn btn-ghost btn-sm", props.className)} />
);

const PrimaryButton = (props) => (
  <button {...props} className={classNames("btn btn-primary", props.className)} />
);

const SubtleButton = (props) => (
  <button {...props} className={classNames("btn btn-outline btn-sm", props.className)} />
);

const Divider = () => <div className="border-t border-base-200 my-4" />;

const Skeleton = ({ lines = 3 }) => (
  <div className="animate-pulse space-y-3">
    {Array.from({ length: lines }).map((_, i) => (
      <div key={i} className="h-4 bg-base-200 rounded" />
    ))}
  </div>
);

/* -------------------------------------------------------------------------- */
/* Undo Stack (optimistic updates with revert)                                */
/* -------------------------------------------------------------------------- */
function useUndoStack() {
  const stack = useRef([]);
  const push = (revertFn, descr = "Change") => {
    stack.current.push(revertFn);
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
/* Helper: Event glue                                                         */
/* -------------------------------------------------------------------------- */

const EVENT_KEYS = [
  "recipe.consolidated",
  "inventory.updated",
  "calendar.synced",
  "preferences.changed",
  "torah.profile.updated",
];

function useAutomationGlue(onEvent) {
  useEffect(() => {
    const offFns = [];
    EVENT_KEYS.forEach((k) => {
      const off = automation?.on?.(k, (payload) => onEvent?.(k, payload));
      if (off) offFns.push(off);
    });
    return () => offFns.forEach((off) => off?.());
  }, [onEvent]);
}

/* -------------------------------------------------------------------------- */
/* Provider Connector Card                                                    */
/* -------------------------------------------------------------------------- */

const ProviderCard = ({ provider, connected, accountLabel, onConnect, onDisconnect, lastSync, syncing }) => {
  const logo = {
    google: "G",
    outlook: "O",
    ics: "ICS",
  }[provider];

  const title = {
    google: "Google Calendar",
    outlook: "Microsoft Outlook",
    ics: "ICS / iCal URL",
  }[provider];

  const sub = {
    google: "Two-way sync of events & tasks",
    outlook: "Two-way sync with Microsoft 365",
    ics: "One-way import from a public/private URL",
  }[provider];

  return (
    <div className="rounded-xl border border-base-200 p-4 flex items-center justify-between bg-base-100">
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 rounded-xl bg-base-200 grid place-items-center text-sm font-bold">{logo}</div>
        <div>
          <p className="font-semibold">{title}</p>
          <p className="text-sm opacity-70">{sub}</p>
          {connected ? (
            <p className="text-xs mt-1">
              Connected {accountLabel ? `as ${accountLabel}` : ""} · Last sync{" "}
              {lastSync ? formatDistanceToNow(new Date(lastSync), { addSuffix: true }) : "—"}
            </p>
          ) : (
            <p className="text-xs mt-1 opacity-70">Not connected</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {connected ? (
          <>
            <SubtleButton onClick={onDisconnect} disabled={syncing}>
              Disconnect
            </SubtleButton>
            <PrimaryButton onClick={onConnect} disabled={syncing}>
              {syncing ? "Syncing…" : "Sync now"}
            </PrimaryButton>
          </>
        ) : (
          <PrimaryButton onClick={onConnect} disabled={syncing}>
            {provider === "ics" ? "Add URL" : "Connect"}
          </PrimaryButton>
        )}
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Main Page                                                                  */
/* -------------------------------------------------------------------------- */

export default function CalendarSettingsPage() {
  const undo = useUndoStack();

  // Pull stores (fallbacks provided if not wired yet)
  const calendarStore = useCalendarStore?.() ?? {};
  const prefsStore = usePreferencesStore?.() ?? {};

  const initialLoading = calendarStore.loading || false;
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [banners, setBanners] = useState([]);

  // Core settings
  const [timezone, setTimezone] = useState(
    prefsStore.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York"
  );
  const [weekStart, setWeekStart] = useState(calendarStore.weekStart || "sun");
  const [defaultCalendar, setDefaultCalendar] = useState(calendarStore.defaultCalendar || "household");
  const [autoSync, setAutoSync] = useState(calendarStore.autoSync ?? true);
  const [sabbathBlock, setSabbathBlock] = useState(calendarStore.sabbathBlock ?? true);

  // Hebrew calendar alignment (your project note: full moon month start is supported)
  const [hebrewMode, setHebrewMode] = useState(
    calendarStore.hebrewMode || "fullMoon" // "fullMoon" | "newMoon" | "firstCrescent" | "noHebrew"
  );
  const [autoMoedim, setAutoMoedim] = useState(calendarStore.autoMoedim ?? true);

  // ICS url
  const [icsUrl, setIcsUrl] = useState(calendarStore.icsUrl || "");

  // Provider states (connected or not)
  const [providers, setProviders] = useState(() => ({
    google: calendarStore.google || { connected: false },
    outlook: calendarStore.outlook || { connected: false },
    ics: { connected: !!(calendarStore.icsUrl && calendarStore.icsUrl.length > 3) },
  }));

  const lastSync = calendarStore.lastSync || null;

  /* ----------------------------- Event glue ------------------------------ */
  useAutomationGlue((event, payload) => {
    // Surface meaningful banners that drive a "next best action"
    if (event === "recipe.consolidated") {
      addBanner({
        key: "recipe.changed",
        tone: "info",
        text: "Recipes were consolidated. Consider re-syncing meal events to your calendar.",
        actions: [{ label: "Resync meals", fn: () => handleSync("meals") }],
      });
    }
    if (event === "inventory.updated") {
      addBanner({
        key: "inv.changed",
        tone: "info",
        text: "Inventory changed. You may want to refresh preservation & shopping tasks on the calendar.",
        actions: [{ label: "Refresh tasks", fn: () => handleSync("tasks") }],
      });
    }
    if (event === "calendar.synced") {
      addBanner({
        key: "cal.synced",
        tone: "success",
        text: "Calendar sync completed.",
        dismissible: true,
      });
    }
    if (event === "preferences.changed") {
      // Update visuals subtly
      setToast({ tone: "info", text: "Preferences updated. Calendar will reflect new defaults." });
    }
    if (event === "torah.profile.updated") {
      addBanner({
        key: "torah.updated",
        tone: "warning",
        text:
          "Torah dietary profile changed. Meal suggestions & labels may need review; resync events if you adjusted food rules.",
        actions: [{ label: "Resync meals", fn: () => handleSync("meals") }],
      });
    }
  });

  function addBanner(b) {
    setBanners((prev) => {
      if (prev.find((x) => x.key === b.key)) return prev;
      return [...prev, b];
    });
  }
  function dismissBanner(key) {
    setBanners((prev) => prev.filter((b) => b.key !== key));
  }

  /* ----------------------------- Persist logic --------------------------- */
  const optimisticSave = async (partial, descr = "Settings") => {
    // Optimistic local application
    const prev = {
      timezone,
      weekStart,
      defaultCalendar,
      autoSync,
      sabbathBlock,
      hebrewMode,
      autoMoedim,
      icsUrl,
    };

    // Apply partial here
    if ("timezone" in partial) setTimezone(partial.timezone);
    if ("weekStart" in partial) setWeekStart(partial.weekStart);
    if ("defaultCalendar" in partial) setDefaultCalendar(partial.defaultCalendar);
    if ("autoSync" in partial) setAutoSync(partial.autoSync);
    if ("sabbathBlock" in partial) setSabbathBlock(partial.sabbathBlock);
    if ("hebrewMode" in partial) setHebrewMode(partial.hebrewMode);
    if ("autoMoedim" in partial) setAutoMoedim(partial.autoMoedim);
    if ("icsUrl" in partial) setIcsUrl(partial.icsUrl);

    const { undo: revert } = undo.push(() => {
      // revert changes
      setTimezone(prev.timezone);
      setWeekStart(prev.weekStart);
      setDefaultCalendar(prev.defaultCalendar);
      setAutoSync(prev.autoSync);
      setSabbathBlock(prev.sabbathBlock);
      setHebrewMode(prev.hebrewMode);
      setAutoMoedim(prev.autoMoedim);
      setIcsUrl(prev.icsUrl);
    }, descr);

    setBusy(true);
    try {
      // Prefer CalendarStore if present, else fall back to automation bus
      if (calendarStore.saveSettings) {
        await calendarStore.saveSettings({
          ...prev,
          ...partial,
        });
      } else {
        await automation.request?.("calendar.saveSettings", { ...prev, ...partial });
      }

      setToast({
        tone: "success",
        text: `${descr} saved`,
        action: { label: "Undo", fn: () => revert() },
      });
      // Emit a single "next best action" suggestion
      emitProgress?.("settings.saved", {
        scope: "calendar",
        nextBestAction: suggestNBA(partial),
      });
    } catch (e) {
      // Revert on error
      revert();
      setToast({ tone: "error", text: `Failed to save ${descr}. Please try again.` });
    } finally {
      setBusy(false);
    }
  };

  const suggestNBA = (partial) => {
    if ("hebrewMode" in partial || "autoMoedim" in partial) {
      return { label: "Rebuild Moedim events", action: () => handleSync("moedim") };
    }
    if ("timezone" in partial || "weekStart" in partial) {
      return { label: "Sync calendar now", action: () => handleSync("all") };
    }
    return { label: "Open Calendar", action: () => openCalendarApp() };
  };

  const openCalendarApp = () => {
    // Route to in-app calendar view if your app has it
    automation.emit?.("ui.navigate", { to: "/calendar" });
  };

  const handleConnect = async (provider) => {
    setBusy(true);
    try {
      if (provider === "ics") {
        if (!icsUrl || icsUrl.length < 8) {
          setToast({ tone: "warning", text: "Enter a valid ICS URL before connecting." });
          return;
        }
      }
      const run = () =>
        provider === "ics"
          ? calendarStore.connectICS?.(icsUrl) ?? automation.request?.("calendar.connect.ics", { icsUrl })
          : calendarStore.connectProvider?.(provider) ?? automation.request?.("calendar.connect", { provider });

      await run();
      setProviders((p) => ({ ...p, [provider]: { ...(p[provider] || {}), connected: true } }));
      setToast({ tone: "success", text: `${provider.toUpperCase()} connected.` });
      await handleSync("all");
    } catch (e) {
      setToast({ tone: "error", text: `Failed to connect ${provider.toUpperCase()}.` });
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async (provider) => {
    const prev = providers[provider];
    setProviders((p) => ({ ...p, [provider]: { ...(p[provider] || {}), connected: false } }));
    const { undo: revert } = undo.push(() =>
      setProviders((p) => ({ ...p, [provider]: prev }))
    , "Disconnect");

    setBusy(true);
    try {
      const run =
        calendarStore.disconnectProvider?.(provider) ??
        automation.request?.("calendar.disconnect", { provider });
      await run;
      setToast({ tone: "success", text: `${provider.toUpperCase()} disconnected`, action: { label: "Undo", fn: revert } });
    } catch (e) {
      revert();
      setToast({ tone: "error", text: `Failed to disconnect ${provider.toUpperCase()}.` });
    } finally {
      setBusy(false);
    }
  };

  const handleSync = async (scope = "all") => {
    const task = async () => {
      emitProgress?.("calendar.sync.started", { scope });
      if (calendarStore.syncNow) {
        await calendarStore.syncNow(scope);
      } else {
        await automation.request?.("calendar.sync", { scope });
      }
      automation.emit?.("calendar.synced", { scope });
      setToast({ tone: "success", text: `Calendar ${scope} sync complete.` });
    };
    // Sabbath-aware sync (non-destructive tasks allowed; you can change behavior in sabbathGuard)
    await sabbathGuard(task, { allowReadOnly: true });
  };

  /* ---------------------------- Derived data ----------------------------- */
  const emptyConnected = useMemo(
    () => !providers.google?.connected && !providers.outlook?.connected && !providers.ics?.connected,
    [providers]
  );

  /* ------------------------------ Lifecycle ------------------------------ */
  useEffect(() => {
    // initial fetch if store exposes it
    calendarStore.fetchSettings?.();
  }, []); // eslint-disable-line

  /* --------------------------------- UI ---------------------------------- */
  return (
    <div className="max-w-5xl mx-auto px-4 md:px-6 lg:px-2 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Calendar Settings</h1>
          <p className="opacity-70">
            Configure providers, defaults, and Hebrew calendar alignment. Changes save optimistically with Undo.
          </p>
        </div>
        <div className="flex gap-2">
          <GhostButton onClick={() => handleSync("all")}>Sync now</GhostButton>
          <PrimaryButton onClick={() => openCalendarApp()}>Open Calendar</PrimaryButton>
        </div>
      </div>

      {/* Banners driven by the event glue */}
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
                <GhostButton onClick={() => dismissBanner(b.key)}>Dismiss</GhostButton>
              )}
            </div>
          </div>
        </InlineNotice>
      ))}

      {/* Providers */}
      <SectionCard
        title="Connected Calendars"
        subtitle="Link your external calendars to sync tasks, meals, holy days, and schedules."
        right={
          <span className="text-xs opacity-70">
            Last sync: {lastSync ? formatDistanceToNow(new Date(lastSync), { addSuffix: true }) : "—"}
          </span>
        }
      >
        {initialLoading ? (
          <Skeleton lines={4} />
        ) : (
          <div className="space-y-3">
            <ProviderCard
              provider="google"
              connected={!!providers.google?.connected}
              accountLabel={providers.google?.email}
              lastSync={lastSync}
              syncing={busy}
              onConnect={() => handleConnect("google")}
              onDisconnect={() => handleDisconnect("google")}
            />
            <ProviderCard
              provider="outlook"
              connected={!!providers.outlook?.connected}
              accountLabel={providers.outlook?.email}
              lastSync={lastSync}
              syncing={busy}
              onConnect={() => handleConnect("outlook")}
              onDisconnect={() => handleDisconnect("outlook")}
            />
            <div className="rounded-xl border border-base-200 p-4 space-y-3 bg-base-100">
              <ProviderCard
                provider="ics"
                connected={!!providers.ics?.connected}
                lastSync={lastSync}
                syncing={busy}
                onConnect={() => handleConnect("ics")}
                onDisconnect={() => handleDisconnect("ics")}
              />
              <InputRow
                label="ICS URL"
                hint="Paste a publicly reachable iCal URL. Private links are kept local."
                value={icsUrl}
                onChange={(v) => setIcsUrl(v)}
                placeholder="https://example.com/calendar.ics"
                disabled={busy}
              />
              <div className="flex justify-end">
                <SubtleButton onClick={() => optimisticSave({ icsUrl }, "ICS URL")}>Save URL</SubtleButton>
              </div>
            </div>

            {emptyConnected && (
              <div className="rounded-xl border border-dashed border-base-300 p-6 grid place-items-center text-center">
                <p className="font-medium">No calendars connected yet</p>
                <p className="text-sm opacity-70 mt-1">
                  Connect Google or Outlook for two-way sync, or add an ICS URL to import events.
                </p>
                <div className="mt-3 flex gap-2">
                  <PrimaryButton onClick={() => handleConnect("google")}>Connect Google</PrimaryButton>
                  <SubtleButton onClick={() => handleConnect("outlook")}>Connect Outlook</SubtleButton>
                </div>
              </div>
            )}
          </div>
        )}
      </SectionCard>

      {/* Defaults & Behavior */}
      <SectionCard title="Defaults & Behavior" subtitle="Set how your calendar behaves across the app.">
        {initialLoading ? (
          <Skeleton lines={5} />
        ) : (
          <>
            <SelectRow
              label="Default Calendar"
              hint="Where new tasks/events should be created by default."
              value={defaultCalendar}
              onChange={(v) => optimisticSave({ defaultCalendar: v }, "Default calendar")}
              options={[
                { value: "household", label: "Household Calendar" },
                { value: "meals", label: "Meals & Batch Cooking" },
                { value: "garden", label: "Garden & Harvests" },
                { value: "animals", label: "Animals & Health" },
                { value: "cleaning", label: "Cleaning & Rotations" },
              ]}
              disabled={busy}
            />
            <SelectRow
              label="Start of Week"
              value={weekStart}
              onChange={(v) => optimisticSave({ weekStart: v }, "Start of week")}
              options={[
                { value: "sun", label: "Sunday" },
                { value: "mon", label: "Monday" },
                { value: "sat", label: "Saturday" },
              ]}
              disabled={busy}
            />
            <SelectRow
              label="Time Zone"
              hint="Applied to new events and parsing of external calendars."
              value={timezone}
              onChange={(v) => optimisticSave({ timezone: v }, "Time zone")}
              options={[
                { value: "America/New_York", label: "America/New_York" },
                { value: "America/Chicago", label: "America/Chicago" },
                { value: "America/Denver", label: "America/Denver" },
                { value: "America/Los_Angeles", label: "America/Los_Angeles" },
                { value: Intl.DateTimeFormat().resolvedOptions().timeZone, label: "Auto-detected" },
              ]}
              disabled={busy}
            />
            <ToggleRow
              label="Auto-Sync in Background"
              hint="Keep your calendars fresh without manual sync."
              checked={autoSync}
              onChange={(v) => optimisticSave({ autoSync: v }, "Background sync")}
              disabled={busy}
            />
            <ToggleRow
              label="Sabbath Guard"
              hint="Avoid creating/editing events during Sabbath. Read-only sync allowed."
              checked={sabbathBlock}
              onChange={(v) => optimisticSave({ sabbathBlock: v }, "Sabbath guard")}
              disabled={busy}
            />
          </>
        )}
      </SectionCard>

      {/* Hebrew Calendar Alignment */}
      <SectionCard
        title="Hebrew Calendar Alignment"
        subtitle="Generate holy days and align months per your rules (Full Moon, New Moon, First Crescent)."
        right={
          <SubtleButton onClick={() => automation.emit?.("ui.navigate", { to: "/hebrew-calendar" })}>
            Open Hebrew Calendar
          </SubtleButton>
        }
      >
        {initialLoading ? (
          <Skeleton lines={4} />
        ) : (
          <>
            <SelectRow
              label="Month Start Rule"
              hint="Your project notes prefer Full Moon as Day 1; other options are available."
              value={hebrewMode}
              onChange={(v) => optimisticSave({ hebrewMode: v }, "Hebrew alignment")}
              options={[
                { value: "fullMoon", label: "Full Moon (Day 1)" },
                { value: "newMoon", label: "Astronomical New Moon" },
                { value: "firstCrescent", label: "First Visible Crescent" },
                { value: "noHebrew", label: "Do not align / off" },
              ]}
              disabled={busy}
            />
            <ToggleRow
              label="Auto-Generate Moedim"
              hint="Add appointed times/feast days to your default calendar."
              checked={autoMoedim}
              onChange={(v) => optimisticSave({ autoMoedim: v }, "Moedim generation")}
              disabled={busy}
            />
            <Divider />
            <div className="flex items-center gap-2">
              <PrimaryButton onClick={() => handleSync("moedim")} disabled={busy}>
                Rebuild Moedim Events
              </PrimaryButton>
              <SubtleButton onClick={() => automation.emit?.("ui.navigate", { to: "/meals/plan" })}>
                Plan Meals for Holy Days
              </SubtleButton>
            </div>
          </>
        )}
      </SectionCard>

      {/* Next Best Actions */}
      <SectionCard title="Recommended Next Steps" subtitle="Keep momentum with one clear action.">
        <div className="flex flex-wrap gap-2">
          <PrimaryButton onClick={() => handleSync("all")}>Sync everything now</PrimaryButton>
          <SubtleButton onClick={() => automation.emit?.("ui.navigate", { to: "/tier2/household/meals" })}>
            Resync meal events
          </SubtleButton>
          <SubtleButton onClick={() => automation.emit?.("ui.navigate", { to: "/tier2/household/garden" })}>
            Refresh garden tasks
          </SubtleButton>
          <SubtleButton onClick={() => automation.emit?.("ui.navigate", { to: "/tier2/household/animals" })}>
            Refresh animal tasks
          </SubtleButton>
          <SubtleButton onClick={() => automation.emit?.("ui.navigate", { to: "/tier2/household/cleaning" })}>
            Refresh cleaning rotations
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
                <button className="btn btn-xs" onClick={() => toast.action.fn?.()}>
                  {toast.action.label}
                </button>
              ) : null}
              <button className="btn btn-ghost btn-xs" onClick={() => setToast(null)}>
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
- Expected stores (gracefully optional):
  useCalendarStore(): {
    loading?: boolean
    weekStart?: "sun"|"mon"|"sat"
    defaultCalendar?: string
    autoSync?: boolean
    sabbathBlock?: boolean
    hebrewMode?: "fullMoon"|"newMoon"|"firstCrescent"|"noHebrew"
    autoMoedim?: boolean
    icsUrl?: string
    google?: { connected:boolean, email?:string }
    outlook?: { connected:boolean, email?:string }
    lastSync?: string | Date
    fetchSettings?: () => Promise<void>
    saveSettings?: (settings) => Promise<void>
    connectProvider?: (provider) => Promise<void>
    connectICS?: (url) => Promise<void>
    disconnectProvider?: (provider) => Promise<void>
    syncNow?: (scope:"all"|"meals"|"tasks"|"moedim") => Promise<void>
  }

- Automation runtime (used if the store fn is absent):
  automation.request("calendar.saveSettings", payload)
  automation.request("calendar.connect", { provider })
  automation.request("calendar.connect.ics", { icsUrl })
  automation.request("calendar.disconnect", { provider })
  automation.request("calendar.sync", { scope })
  automation.on("event", handler)
  automation.emit("ui.navigate", { to:"/route" })
  automation.emit("calendar.synced", { scope })

- Sabbath guard:
  sabbathGuard(taskFn, { allowReadOnly: true }) wraps sync to respect your Sabbath rules.

- Event-driven glue:
  Listens to: recipe.consolidated, inventory.updated, calendar.synced, preferences.changed, torah.profile.updated.
  Each surfaces a contextual banner with a single Next Best Action button.

- Undo pattern:
  Optimistic updates push a revert callback; toast includes an Undo action.

- Empty states:
  If no providers connected, a dashed card appears with clear CTAs to connect.

- Design System:
  Tailwind + DaisyUI classes. Buttons: PrimaryButton / SubtleButton / GhostButton
*/
