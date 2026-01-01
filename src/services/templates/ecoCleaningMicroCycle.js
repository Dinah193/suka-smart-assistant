// src/services/templates/ecoCleaningMicroCycle.js

import * as timeUtils from "@/utils/timeUtils";
import TimerManager from "@/managers/TimerManager";
import ReminderManager from "@/managers/ReminderManager"; // optional, for soft nudges

// Optional stores/services (guarded)
let ZoneStore, CleaningSuppliesStore, BadgeManager, SettingsStore, CalendarSyncModule;
try { ZoneStore = require("@/store/ZoneStore"); } catch (_) {}
try { CleaningSuppliesStore = require("@/store/CleaningSuppliesStore"); } catch (_) {}
try { BadgeManager = require("@/managers/BadgeManager"); } catch (_) {}
try { SettingsStore = require("@/store/SettingsStore"); } catch (_) {}
try { CalendarSyncModule = require("@/services/calendar/CalendarSyncModule").default; } catch (_) {}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));
const isoDate = (d = new Date()) =>
  (typeof timeUtils?.toLocalISODate === "function")
    ? timeUtils.toLocalISODate(d)
    : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,10);

/**
 * Contract-compliant metadata
 */
export const template = {
  id: "eco_cleaning_micro_cycle_v2",
  version: "2.2.0",
  purpose: "Fast, eco-friendly resets (5–20 min) that keep the home feeling peaceful — with visible drafts and soft nudges.",
  triggers: ["after::meal", "time::08:30_local", "ui::ZoneGroupPanel.open"],
  inputs: {
    // zones: [{ id, name, messinessScore?, priority?, tags?:[] }]
    // timeAvailable: minutes (default 15; clamps 5–25)
    // library: { [tag|'default']: [{ id, title, estMinutes, tags:['visible','reset',...], eco?:true }] }
    // settings: { music?:boolean, streaks?:boolean, restockDaily?:boolean, quickMode?:'kid'|'guest'|null }
    required: [],
    optional: ["zones", "timeAvailable", "library", "settings"]
  },
  logic: {
    selectors: [
      "ZoneStore.getAllZones?()",
      "CleaningSuppliesStore.getRestockState?() / getNextDueRestock?()",
      "SettingsStore.get('eco_micro_cycle_prefs')"
    ],
    rules: [
      "Pick 1–3 'visible win' tasks (≤7min each) in messiest/prioritized zones.",
      "Fit tasks within timeAvailable; prefer eco-tagged where provided.",
      "Optionally rotate a 2–3min supplies restock once per day.",
      "If behind → emit 3-task power tidy for the messiest zone.",
      "Visible draft first; user can swap before starting timer."
    ],
    llm_roles: []
  },
  actions: [
    "OPEN_UI",          // RoutineScheduleBuilder in draft mode
    "PATCH_PLAN",       // allow apply/revert
    "START_TIMER",      // TimerManager.start
    "REMIND",           // gentle end-of-cycle
    "BADGE",            // streak/badge increment
    "CALENDAR_SYNC",    // optional all-day log event
    "NOTIFY"            // optional toast/inbox heads-up
  ],
  outputs: {
    ui: ["RoutineScheduleBuilder.jsx"],
    data: ["checklist", "draft", "durationMin"],
    alerts: [],
    actions: "array"
  },
  fallbacks: [
    "If behind → one-room power tidy with 3 high-impact tasks."
  ],
  success_message: "Mini-cycle drafted. A few minutes to a calmer space.",
  used_by: ["cleaningAgent"]
};

/* ---------------- Defaults ---------------- */
const DEFAULTS = {
  minWindow: 5,
  maxWindow: 25,
  defaultWindow: 15,
  openUIRoute: "/tier2/household/routines#micro-cycle",
  enableMusic: true,
  enableStreaks: true,
  restockDaily: true,
  // quickMode: 'kid' | 'guest' | null
};

/* ---------------- Helpers ---------------- */

// Persist a light preference blob
function getPrefs() {
  try { return SettingsStore?.get?.("eco_micro_cycle_prefs") || {}; } catch { return {}; }
}
function setPrefs(p) {
  try { SettingsStore?.set?.("eco_micro_cycle_prefs", p); } catch {}
}

function getZones(zonesIn) {
  const fromStore = ZoneStore?.getAllZones?.() || [];
  const zones = (zonesIn?.length ? zonesIn : fromStore).map((z, i) => ({
    id: z.id ?? `zone_${i}`,
    name: z.name ?? `Zone ${i + 1}`,
    messinessScore: Number(z.messinessScore ?? 0), // 0..10
    priority: Number(z.priority ?? 1),
    tags: z.tags || []
  }));
  zones.sort((a, b) => (b.messinessScore - a.messinessScore) || (b.priority - a.priority));
  return zones;
}

function pickVisibleWinTask(zone, library = {}, quickMode = null) {
  const zkey = zone?.tags?.find?.(t => library[t]) || "default";
  const tasks = library[zkey] || library.default || [];

  // prefer eco + visible/reset, ≤7min
  let candidates = tasks.filter(t => {
    const tags = t.tags || [];
    const isVisible = tags.includes("visible") || tags.includes("reset");
    const shortEnough = Number(t.estMinutes ?? 5) <= 7;
    return isVisible && shortEnough;
  });

  // kid/guest quick mode → favor super-short tasks
  if (quickMode === "kid" || quickMode === "guest") {
    candidates = candidates
      .filter(t => (t.estMinutes ?? 5) <= 5)
      .sort((a, b) => (a.estMinutes ?? 5) - (b.estMinutes ?? 5));
  } else {
    // normal: prefer eco flag, then shortest first
    candidates = candidates
      .sort((a, b) => {
        const ecoA = (a.eco ? 1 : 0), ecoB = (b.eco ? 1 : 0);
        if (ecoA !== ecoB) return ecoB - ecoA;
        return (a.estMinutes ?? 5) - (b.estMinutes ?? 5);
      });
  }

  const task = candidates[0];
  if (!task) return null;

  return {
    id: `${zone.id}__${task.id || task.title.replace(/\s+/g, "_").toLowerCase()}`,
    zoneId: zone.id,
    zoneName: zone.name,
    title: task.title,
    estMinutes: Number(task.estMinutes ?? 5),
    tags: task.tags || ["visible"],
    eco: !!task.eco
  };
}

// supplies: at most one 2–3min restock per day if enabled
function pickRestockTask(settings = {}) {
  if (!settings.restockDaily) return null;
  const last = getPrefs()?.lastRestockDate;
  if (last === isoDate()) return null; // already did today

  const due = CleaningSuppliesStore?.getNextDueRestock?.() || null;
  if (!due) return null;

  return {
    id: `restock__${due.id || due.name}`,
    zoneId: due.zoneId || "supplies",
    zoneName: due.zoneName || "Supplies",
    title: `Restock: ${due.name}`,
    estMinutes: 3,
    tags: ["restock", "visible", "eco"]
  };
}

function buildPowerTidy(zone, quickMode = null) {
  const base = [
    { key: "trash", title: "Quick trash sweep", est: 3 },
    { key: "surfaces", title: "Clear & wipe primary surfaces", est: 7 },
    { key: "floors", title: "3-minute floor reset (high-traffic)", est: 5 }
  ];
  const tweaked = (quickMode ? base.map(t => ({ ...t, est: Math.max(2, t.est - 1) })) : base);
  return tweaked.map(t => ({
    id: `${zone.id}__${t.key}`,
    zoneId: zone.id,
    zoneName: zone.name,
    title: t.title,
    estMinutes: t.est,
    tags: ["power_tidy", "visible"]
  }));
}

/** Compute next run times: after breakfast/lunch/dinner & morning sweep */
export function nextRuns(now = new Date()) {
  const runs = [];
  const addAt = (h, m = 0) => {
    const d = new Date(now); d.setHours(h, m, 0, 0);
    if (d > now) runs.push(d.toISOString());
  };
  addAt(8, 30);  // morning sweep
  addAt(13, 30); // after lunch buffer
  addAt(19, 0);  // after dinner buffer
  return runs.length ? runs : [new Date(now.getTime() + 60 * 60000).toISOString()];
}

/* ---------------- Execute ---------------- */

/**
 * Execute the template.
 * @param {Object} payload
 * @param {Array<Object>} [payload.zones]
 * @param {number}        [payload.timeAvailable]  // minutes (5–25), default 15
 * @param {Object}        [payload.library]
 * @param {Object}        [payload.settings]       // { music?, streaks?, restockDaily?, quickMode? }
 * @param {Object}        [ctx]                    // { openUI?, now? }
 * @returns {Promise<{ok:boolean, checklist:Array, durationMin:number, draft:boolean, actions:Array, message:string}>}
 */
export async function execute(payload = {}, ctx = {}) {
  const {
    zones: zonesIn = [],
    timeAvailable = DEFAULTS.defaultWindow,
    library: libraryIn = {},
    settings = {}
  } = payload;

  const { openUI, now = new Date() } = ctx;

  const S = {
    ...DEFAULTS,
    enableMusic: settings.music ?? getPrefs()?.music ?? DEFAULTS.enableMusic,
    enableStreaks: settings.streaks ?? getPrefs()?.streaks ?? DEFAULTS.enableStreaks,
    restockDaily: settings.restockDaily ?? getPrefs()?.restockDaily ?? DEFAULTS.restockDaily,
    quickMode: settings.quickMode ?? getPrefs()?.quickMode ?? null
  };
  setPrefs({ ...getPrefs(), music: S.enableMusic, streaks: S.enableStreaks, restockDaily: S.restockDaily, quickMode: S.quickMode });

  const durationMin = clamp(timeAvailable, DEFAULTS.minWindow, DEFAULTS.maxWindow);
  const zones = getZones(zonesIn);
  const library = libraryIn;

  /* Build draft checklist */
  const checklist = [];
  let minutes = 0;

  // Optional: one tiny restock (eco habit)
  const restock = pickRestockTask(S);
  if (restock && minutes + restock.estMinutes <= durationMin) {
    checklist.push(restock);
    minutes += restock.estMinutes;
    // mark restock day to avoid duplicates
    const prefs = getPrefs();
    setPrefs({ ...prefs, lastRestockDate: isoDate(now) });
  }

  // Visible wins by messiness/priority
  for (const z of zones) {
    if (minutes >= durationMin) break;
    const task = pickVisibleWinTask(z, library, S.quickMode);
    if (!task) continue;
    if (minutes + task.estMinutes <= durationMin) {
      checklist.push(task);
      minutes += task.estMinutes;
    }
  }

  // Fallback if behind or too few tasks
  const behind = (zones[0]?.messinessScore ?? 0) >= 7 || checklist.length < 2;
  if (behind) {
    const top = zones[0] || { id: "room_1", name: "Main Room" };
    const power = buildPowerTidy(top, S.quickMode);
    const filled = checklist.reduce((s, t) => s + (t.estMinutes ?? 0), 0);
    if (filled < Math.max(10, Math.round(durationMin * 0.6))) {
      checklist.splice(0, checklist.length, ...power);
      minutes = power.reduce((s, t) => s + t.estMinutes, 0);
    } else {
      for (const t of power) {
        if (minutes + t.estMinutes <= durationMin) {
          checklist.push(t);
          minutes += t.estMinutes;
        }
      }
    }
  }

  /* Visible draft UI payload */
  const params = {
    title: `Today: ${durationMin}-Minute Micro-Cycle`,
    day: isoDate(now),
    tasks: checklist,
    durationMin,
    draft: true,
    quickMode: S.quickMode
  };

  const actions = [];

  // OPEN_UI draft
  actions.push({
    type: "OPEN_UI",
    route: DEFAULTS.openUIRoute,
    component: "RoutineScheduleBuilder",
    params
  });

  // PATCH_PLAN (for orchestrator to allow apply or edit)
  actions.push({
    type: "PATCH_PLAN",
    plan: params,
    draft: true
  });

  // Optional: calendar log (non-blocking)
  try {
    const event = {
      start: now,
      end: new Date(now.getTime() + durationMin * 60000),
      title: "Eco Micro-Cycle",
      description: checklist.map(t => `• ${t.zoneName}: ${t.title} (${t.estMinutes}m)`).join("\n"),
      tags: ["cleaning", "micro_cycle"],
      allDay: false
    };
    CalendarSyncModule?.load?.([event]);
    actions.push({ type: "CALENDAR_SYNC", events: [event], draft: true });
  } catch {}

  // START_TIMER
  actions.push({
    type: "START_TIMER",
    seconds: Math.max(1, Math.round(durationMin * 60)),
    label: "Eco Cleaning Micro-Cycle",
    sound: "soft_chime",
    gentle: true
  });

  // Actually start timer now (non-fatal if TimerManager is absent)
  TimerManager.start?.({
    seconds: Math.max(1, Math.round(durationMin * 60)),
    label: "Eco Cleaning Micro-Cycle",
    sound: "soft_chime",
    gentle: true
  });

  // Soft end-of-cycle reminder
  const endAt = timeUtils?.addMinutes?.(now, durationMin) || new Date(now.getTime() + durationMin * 60000);
  actions.push({
    type: "REMIND",
    atISO: endAt.toISOString(),
    title: "Nice work—mini-cycle complete",
    body: "Mark tasks done and enjoy the calm ✨",
    tags: ["cleaning", "micro_cycle"]
  });
  ReminderManager.schedule?.({
    at: endAt,
    title: "Nice work—mini-cycle complete",
    message: "Mark tasks done and enjoy the calm ✨",
    tags: ["cleaning", "micro_cycle"]
  });

  // Streaks / badges
  if (S.enableStreaks) {
    actions.push({ type: "BADGE", key: "eco_micro_cycle" });
    try { BadgeManager?.increment?.("eco_micro_cycle"); } catch {}
  }

  // Optional: play music (UI can pick a playlist)
  if (S.enableMusic) {
    actions.push({
      type: "NOTIFY",
      channel: "toast",
      title: "Micro-Cycle started",
      body: "Starting your focus playlist 🎵",
      tags: ["cleaning", "micro_cycle"]
    });
    // Your UI layer may react to a 'ui:playlist' event; we just emit a signal here
    try { window.dispatchEvent(new CustomEvent("ui:playlist", { detail: { preset: "focus_clean" } })); } catch {}
  }

  // Fire UI immediately if handler provided
  if (typeof openUI === "function") {
    try { openUI("RoutineScheduleBuilder", params); } catch {}
  } else {
    try {
      window.dispatchEvent(new CustomEvent("ui:navigate", {
        detail: { route: "RoutineScheduleBuilder", params }
      }));
    } catch {}
  }

  return {
    ok: true,
    checklist,
    durationMin,
    draft: true,
    actions,
    message: template.success_message
  };
}

export default {
  template,
  execute,
  nextRuns
};
