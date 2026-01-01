// src/services/templates/kitchen/HarvestPreservationSync.template.js

/**
 * Harvest & Preservation Sync — standardized template contract
 *
 * Contract fields:
 * - id, name, version, purpose
 * - triggers[]: machine-readable event keys
 * - inputs: schema-ish description for UI/validators
 * - logic[]: human-readable steps
 * - actions[]: identifiers your orchestrator understands
 * - outputs: shape description of returned data
 * - fallbacks[]: graceful options for surplus
 * - schedule: RRULE hints for auto-scheduling
 * - nextRuns(now): compute upcoming run times (ISO)
 * - run(ctx, services): execute → { ok, summary, gardenUpdates, calendarEvents, actions, ... }
 */

import dayjs from "dayjs";

/* ----------------------------------------------------------------------------
   Helpers
---------------------------------------------------------------------------- */
const isoNow = () => new Date().toISOString();
const safeNum = (n, fb = 0) => (Number.isFinite(Number(n)) ? Number(n) : fb);
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const title = (s) => (s || "").replace(/\b\w/g, (m) => m.toUpperCase());
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const uniq = (arr) => Array.from(new Set(arr || []));

/* ----------------------------------------------------------------------------
   Defaults (methods + prefs are editable)
---------------------------------------------------------------------------- */
const DEFAULTS = {
  lookaheadDays: 10,
  sessionStartLocal: "18:00",
  altSessionStartLocalWeekend: "10:00", // weekend morning option
  maxSessionHours: 3.5,
  maxSessionsPerDay: 2,
  donateThresholdKg: 3,
  openUIRoute: "/tier2/kitchen/preservation",
  labelPrinterRoute: "/tier2/kitchen/labels",
  batchPlannerRoute: "/tier2/household/meals#batch-session-planner",
  notifyOnDonation: true,
  notifyOnStart: true,
  parLevels: {
    // optional pantry par levels to nudge priorities
    "Tomato Sauce jar": 12,
    "Frozen Greens kg": 6,
  },
  methods: {
    canning: { kgPerHour: 3.5, requires: ["jars", "lids", "stove"], batchSizeKg: 2.5 },
    freezing: { kgPerHour: 6.0, requires: ["freezerSpaceKg", "bags"], batchSizeKg: 3.0 },
    drying: { kgPerHour: 2.0, requires: ["dehydratorTrays"], batchSizeKg: 1.5 },
    fermenting: { kgPerHour: 2.5, requires: ["fermentVessels"], batchSizeKg: 2.0 },
  },
  defaultPreferences: {
    Tomato: ["canning", "freezing", "drying"],
    Cucumber: ["fermenting", "canning", "drying"],
    Pepper: ["freezing", "drying", "canning"],
    Herb: ["drying", "freezing"],
    Apple: ["canning", "drying", "freezing"],
    Greens: ["freezing", "fermenting"],
    Default: ["freezing", "canning", "drying"],
  },
};

/* ----------------------------------------------------------------------------
   The standardized template object
---------------------------------------------------------------------------- */
const HarvestPreservationSyncTemplate = {
  id: "harvest-preservation-sync",
  name: "Harvest & Preservation Sync",
  version: "2.2.0",
  purpose:
    "Align harvest windows with preservation capacity to minimize waste, with visible drafts, reservations, labels, and donation fallbacks.",

  // Machine-readable triggers your orchestrator can subscribe to
  triggers: ["crop_maturity_window", "user_request", "daily_scan_0700"],

  // Minimal schema-style hints (for UI + validators)
  inputs: {
    harvestForecasts:
      "array[{ bedId, crop, variety?, estYieldKg:number, window:{startISO,endISO}, perishableHours? }]",
    preferences: "record<cropName, string[] /* ordered methods */>",
    capacity:
      "object{ jars?, lids?, stove?, freezerSpaceKg?, bags?, dehydratorTrays?, fermentVessels? }",
    pantryInventory: "record<string /* product name or sku */, number>",
    community: "array[{ name, phone?, url?, pickup? }]",
    settings:
      "object{ lookaheadDays?, sessionStartLocal?, altSessionStartLocalWeekend?, maxSessionHours?, maxSessionsPerDay?, donateThresholdKg?, openUIRoute?, labelPrinterRoute?, batchPlannerRoute?, notifyOnDonation?, notifyOnStart?, methods?, defaultPreferences?, parLevels? }",
  },

  // Human-readable logic ladder
  logic: [
    "Open Preservation Planner UI in draft mode.",
    "Filter harvest windows within lookahead; score by urgency (window end & perishability).",
    "Per forecast: walk preferred methods; check capacity gates & throughput; split into feasible sessions capped per day.",
    "Draft reservations for consumables/equipment/space; schedule inventory increments post-session.",
    "Create calendar events; open Label Printer and Batch Session Planner with prefilled sessions.",
    "If surplus remains above threshold, schedule donation & raise DONATION_OFFER + NOTIFY.",
  ],

  // Action identifiers consumed by your orchestrator/renderer
  actions: [
    "OPEN_UI",
    "RESERVE_CONSUMABLE",
    "RESERVE_EQUIPMENT",
    "RESERVE_SPACE",
    "INVENTORY_INCREMENT_SCHEDULED",
    "DONATION_OFFER",
    "INVENTORY_RESERVE",
    "ORDER_SUPPLIES",
    "CREATE_TASK",
    "NOTIFY",
    "PRINT_LABELS",
    "LINK_BATCH_SESSION",
  ],

  // Output shape
  outputs: {
    gardenUpdates:
      "array[ {type:'kitchen.preserved_log_planned'|'kitchen.preservation_plan'|'kitchen.capacity_note', ...} ]",
    calendarEvents: "array[ {type:'care'|'donation', title, date, notes?} ]",
    recommendations: "array[string]",
    logs: "array",
    actions: "array[{type, ...}]",
    draft: "object{ sessions, surplusKg, notes }",
  },

  // Surplus fallback paths
  fallbacks: ["donate_surplus", "defer_low_priority_crops", "switch_method_to_fit_capacity"],

  // Morning sweep for upcoming windows
  schedule: { RRULE: "FREQ=DAILY;BYHOUR=7;BYMINUTE=0;BYSECOND=0" },

  // Compute upcoming run times (ISO strings)
  nextRuns(now = dayjs(), ctx = {}) {
    const forecasts = ctx?.inputs?.harvestForecasts || [];
    const cues = forecasts
      .map((f) => dayjs(f.window?.startISO).subtract(1, "day"))
      .filter((d) => d.isValid() && d.isAfter(now))
      .map((d) => d.toISOString());
    if (cues.length) return cues.sort();
    const base = now.add(1, "day").hour(7).minute(0).second(0).millisecond(0);
    return [base.toISOString()];
  },

  // Execute template
  async run(ctx = {}, services = {}) {
    const startTs = isoNow();
    const logs = [];
    const recommendations = [];
    const calendarEvents = [];
    const gardenUpdates = [];
    const actions = [];

    const now = dayjs(ctx.now || new Date());
    const inputs = ctx.inputs || {};
    const S = {
      ...DEFAULTS,
      ...(inputs.settings || {}),
      methods: { ...DEFAULTS.methods, ...(inputs.settings?.methods || {}) },
      defaultPreferences: {
        ...DEFAULTS.defaultPreferences,
        ...(inputs.settings?.defaultPreferences || {}),
      },
      parLevels: { ...DEFAULTS.parLevels, ...(inputs.settings?.parLevels || {}) },
    };

    const rawForecasts = inputs.harvestForecasts || [];
    const prefs = inputs.preferences || {};
    const capacity = { ...(inputs.capacity || {}) };
    const pantry = inputs.pantryInventory || {};
    const community = inputs.community || [];

    // Open Preservation Planner UI (draft)
    actions.push({
      type: "OPEN_UI",
      route: S.openUIRoute,
      component: "PreservationPlanner",
      params: { mode: "draft" },
    });

    // Filter and score forecasts by urgency (earlier end + shorter perishability = higher priority)
    const forecasts = rawForecasts
      .filter(
        (f) =>
          dayjs(f.window?.startISO).isBefore(now.add(S.lookaheadDays, "day")) &&
          dayjs(f.window?.endISO || f.window?.startISO).isAfter(now.subtract(1, "day"))
      )
      .map((f) => ({
        ...f,
        perish: safeNum(f.perishableHours, 48),
        score:
          (dayjs(f.window?.endISO).diff(now, "hour") || 0) -
          0.75 * safeNum(f.perishableHours, 48), // lower = more urgent
      }))
      .sort((a, b) => a.score - b.score);

    // Capacity heads-up notes (freezer space, jars, etc.)
    pushCapacityNotes(capacity, gardenUpdates);

    const sessions = []; // { method, crop, variety?, dateISO, durationH, kgPlanned, outputs:[], checklist:[], draft:true }
    let unplannedSurplusKg = 0;

    // We'll track per-day session counts to avoid overbooking
    const daySessionCounts = {};

    for (const f of forecasts) {
      const crop = f.crop || "Unknown";
      const variety = f.variety || null;
      let remaining = Math.max(0, safeNum(f.estYieldKg, 0));
      if (remaining <= 0) continue;

      const perishableH = safeNum(f.perishableHours, 48);
      const latestProcess = dayjs(f.window?.startISO || now).add(perishableH, "hour");

      const prefList =
        prefs[crop] || S.defaultPreferences[crop] || S.defaultPreferences.Default;

      // Pantry par nudging (prioritize methods/products below par)
      const parHint = parPriorityHint(crop, pantry, S.parLevels);

      for (const method of prioritizeByPar(prefList, parHint)) {
        if (remaining <= 0) break;

        // Attempt multiple sessions (split) if we exceed max session hours or per-day caps
        // Hard stop if the window & perishability won't allow more
        let guard = 8; // prevent infinite loops
        while (remaining > 0 && guard-- > 0) {
          const plan = planMethodBatch(
            method,
            crop,
            remaining,
            capacity,
            S.methods,
            S.maxSessionHours
          );
          if (!plan || plan.kgPlanned <= 0) break;

          const startSlot = bestSessionStart(f.window, now, S.sessionStartLocal, S.altSessionStartLocalWeekend);
          let sessionDate = clampToWindow(startSlot, f.window, latestProcess);

          // Respect per-day cap by pushing to next valid day within window/perishability
          sessionDate = bumpIfOverbooked(sessionDate, daySessionCounts, S.maxSessionsPerDay, f.window, latestProcess);
          if (!sessionDate) break; // cannot schedule within constraints

          const outputs = outputSkusFor(method, crop, variety, plan.kgPlanned);

          const sess = {
            method,
            crop,
            variety,
            dateISO: sessionDate.toISOString(),
            durationH: plan.hours,
            kgPlanned: round(plan.kgPlanned, 2),
            outputs,
            checklist: checklistFor(method, crop),
            draft: true,
          };
          sessions.push(sess);

          // Reserve capacity (draft)
          actions.push(...capacityReserveActions(method, plan).map((a) => ({ ...a, draft: true })));

          // Schedule inventory increments when session completes
          actions.push({
            type: "INVENTORY_INCREMENT_SCHEDULED",
            dateISO: sessionDate.add(plan.hours, "hour").toISOString(),
            items: outputs.map((o) => ({ sku: o.sku, qty: o.qty, unit: o.unit })),
            reason: `Preservation: ${title(method)} ${crop}`,
          });

          // Label Printer (draft)
          actions.push({
            type: "PRINT_LABELS",
            route: S.labelPrinterRoute,
            items: outputs.map((o) => ({
              name: o.name,
              sku: o.sku,
              qty: o.qty,
              unit: o.unit,
              dateISO: sessionDate.toISOString(),
              method,
            })),
            draft: true,
          });

          // Batch Session Planner link (ties into your Meals dashboard tooling)
          actions.push({
            type: "LINK_BATCH_SESSION",
            route: S.batchPlannerRoute,
            params: {
              method,
              crop,
              variety,
              dateISO: sess.dateISO,
              durationH: sess.durationH,
              kgPlanned: sess.kgPlanned,
              outputs,
            },
            draft: true,
          });

          // Calendar entry (visible)
          calendarEvents.push({
            type: "care",
            title: `${title(method)} — ${crop}${variety ? " (" + variety + ")" : ""}`,
            date: sess.dateISO,
            notes: `Duration ~${round(sess.durationH, 1)} h. Planned ${round(sess.kgPlanned, 1)} kg.`,
          });

          if (S.notifyOnStart) {
            actions.push({
              type: "NOTIFY",
              channel: "inbox",
              title: `Planned ${title(method)} session`,
              body: `${crop}${variety ? " (" + variety + ")" : ""} — ${round(
                sess.kgPlanned,
                1
              )} kg at ${dayjs(sess.dateISO).format("MMM D, HH:mm")}`,
              tags: ["kitchen", "preservation"],
            });
          }

          // Consume capacity snapshot
          applyCapacityConsumption(method, plan, capacity);
          remaining = Math.max(0, remaining - plan.kgPlanned);
        }
      }

      if (remaining > 0) {
        unplannedSurplusKg += remaining;
        recommendations.push(
          `${crop}${variety ? " (" + variety + ")" : ""}: ~${round(
            remaining,
            1
          )} kg exceeds current preservation capacity/time window.`
        );
      }
    }

    // Donation fallback for surplus
    if (unplannedSurplusKg >= S.donateThresholdKg) {
      const contact = community[0] || null;
      const donateDateISO = dayjs()
        .add(1, "day")
        .hour(11)
        .minute(0)
        .second(0)
        .millisecond(0)
        .toISOString();

      calendarEvents.push({
        type: "donation",
        title: "Donate surplus produce",
        date: donateDateISO,
        notes: contact
          ? `Contact ${contact.name} (${contact.phone || contact.url || ""})`
          : "Coordinate with local food share/community network.",
      });

      actions.push({
        type: "DONATION_OFFER",
        dateISO: donateDateISO,
        estimateKg: round(unplannedSurplusKg, 1),
        contact,
      });

      if (S.notifyOnDonation) {
        actions.push({
          type: "NOTIFY",
          channel: "inbox",
          title: "Donation recommended",
          body: `Estimated surplus ~${round(unplannedSurplusKg, 1)} kg available for donation.`,
          tags: ["kitchen", "donation"],
        });
      }

      // Optional pick-up task
      actions.push({
        type: "CREATE_TASK",
        title: "Arrange surplus pickup / drop-off",
        dueISO: donateDateISO,
        notes: contact
          ? `Confirm with ${contact.name}`
          : "Find nearest community food share or neighbor.",
        tags: ["kitchen", "donation"],
      });
    }

    // Planned preserved goods log + consolidated plan
    sessions.forEach((s) => {
      gardenUpdates.push({
        type: "kitchen.preserved_log_planned",
        whenISO: s.dateISO,
        method: s.method,
        crop: s.crop,
        variety: s.variety || undefined,
        kg: s.kgPlanned,
        outputs: s.outputs,
        notes: `Session ~${round(s.durationH, 1)} h`,
        draft: true,
      });
    });

    gardenUpdates.push({
      type: "kitchen.preservation_plan",
      createdISO: isoNow(),
      sessions,
      surplusKg: unplannedSurplusKg || 0,
      notes:
        unplannedSurplusKg > 0
          ? `Unplanned surplus ~${round(unplannedSurplusKg, 1)} kg`
          : undefined,
      draft: true,
    });

    // Final OPEN_UI with preloaded sessions (review mode)
    actions.push({
      type: "OPEN_UI",
      route: S.openUIRoute,
      component: "PreservationPlanner",
      params: { initialSessions: sessions, mode: "review" },
    });

    const summary = sessions.length
      ? `Drafted ${sessions.length} preservation session(s). Surplus: ${round(
          unplannedSurplusKg,
          1
        )} kg.`
      : "No sessions drafted (capacity/time constraints or missing forecasts).";

    services?.logger?.info?.(`[${this.id}] ${summary}`);

    return {
      ok: true,
      timestamp: startTs,
      summary,
      recommendations,
      calendarEvents,
      gardenUpdates,
      logs,
      actions,
      draft: {
        sessions,
        surplusKg: unplannedSurplusKg,
        notes: buildDraftNotes(capacity, pantry, S.parLevels, unplannedSurplusKg),
      },
    };
  },
};

export default HarvestPreservationSyncTemplate;

/* =========================
   Internal helper functions
   ========================= */

function pushCapacityNotes(capacity, gardenUpdates) {
  const notes = [];
  if (safeNum(capacity.jars, 0) < 8) notes.push("Low jars (<8).");
  if (safeNum(capacity.lids, 0) < 8) notes.push("Low lids (<8).");
  if (safeNum(capacity.freezerSpaceKg, 0) < 2) notes.push("Low freezer space (<2 kg).");
  if (safeNum(capacity.dehydratorTrays, 0) < 2) notes.push("Few dehydrator trays (<2).");
  if (safeNum(capacity.fermentVessels, 0) < 1) notes.push("No ferment vessels.");
  if (notes.length) {
    gardenUpdates.push({
      type: "kitchen.capacity_note",
      createdISO: isoNow(),
      notes,
    });
  }
}

function buildDraftNotes(capacity, pantry, parLevels, surplusKg) {
  const n = [];
  if (surplusKg > 0) n.push("Donation recommended to prevent spoilage.");
  const lowFreezer = safeNum(capacity.freezerSpaceKg, 0) < 2;
  if (lowFreezer) n.push("Defragment freezer space or prioritize non-freezing methods.");
  const belowPar = belowParItems(pantry, parLevels);
  if (belowPar.length) n.push(`Below par: ${belowPar.join(", ")}`);
  return n;
}

function belowParItems(pantry, parLevels) {
  const out = [];
  for (const [k, par] of Object.entries(parLevels || {})) {
    const have = safeNum(pantry[k], 0);
    if (have < par) out.push(`${k} (have ${have}, par ${par})`);
  }
  return out;
}

function parPriorityHint(crop, pantry, parLevels) {
  // Returns a weight by method output SKU being below par
  // Simple heuristic: if crop has a common product key in parLevels, bump priority
  const keys = Object.keys(parLevels || {});
  const hit = keys.find((k) => k.toLowerCase().includes(crop.toLowerCase()));
  if (!hit) return 0;
  const have = safeNum(pantry[hit], 0);
  return Math.max(0, (parLevels[hit] || 0) - have); // bigger gap = more urgency
}

function prioritizeByPar(methods, parHint) {
  if (!parHint) return methods;
  // Favor earlier methods if par gap exists; small nudge by duplicating first choice
  if (methods.length > 1) return [methods[0], methods[0], ...methods.slice(1)];
  return methods;
}

function bestSessionStart(window, now, hhmm = "18:00", altWeekend = "10:00") {
  const [h, m] = (hhmm || "18:00").split(":").map(Number);
  const base = dayjs(now).hour(h).minute(m).second(0).millisecond(0);
  const isWeekend = [0, 6].includes(base.day());
  const weekendBase = dayjs(now)
    .hour(Number((altWeekend || "10:00").split(":")[0]))
    .minute(Number((altWeekend || "10:00").split(":")[1]))
    .second(0)
    .millisecond(0);
  const candidate = isWeekend ? weekendBase : base;

  const winStart = dayjs(window?.startISO || now);
  const winEnd = dayjs(window?.endISO || candidate);
  if (candidate.isBefore(winStart)) return winStart.hour(candidate.hour()).minute(candidate.minute());
  if (candidate.isAfter(winEnd)) return winEnd;
  return candidate;
}

function clampToWindow(date, window, latest) {
  let d = dayjs(date);
  if (window?.startISO && d.isBefore(window.startISO)) d = dayjs(window.startISO);
  // Don't go past latest viable processing time (perishability)
  if (latest && d.isAfter(latest)) d = dayjs(latest);
  return d;
}

function bumpIfOverbooked(date, dayCounts, maxPerDay, window, latest) {
  let d = dayjs(date);
  const end = dayjs.min(dayjs(window?.endISO || d), dayjs(latest || d.add(6, "hour")));
  let guard = 10;
  while (guard-- > 0) {
    const key = d.format("YYYY-MM-DD");
    const used = safeNum(dayCounts[key], 0);
    if (used < maxPerDay) {
      dayCounts[key] = used + 1;
      return d;
    }
    d = d.add(1, "day");
    if (d.isAfter(end)) return null;
  }
  return null;
}

function planMethodBatch(method, crop, remainingKg, capacity, methodsCfg, maxHrs) {
  const cfg = methodsCfg[method];
  if (!cfg) return null;
  if (!hasCapacity(method, capacity, cfg)) return null;

  const kgPerHour = safeNum(cfg.kgPerHour, 3);
  const maxBatchKg = safeNum(cfg.batchSizeKg, remainingKg);
  const candidateKg = Math.min(remainingKg, maxBatchKg, kgFromCapacity(method, capacity, cfg));
  if (candidateKg <= 0) return null;

  let hours = candidateKg / Math.max(kgPerHour, 0.1);
  if (hours > maxHrs) {
    const cappedKg = kgPerHour * maxHrs;
    if (cappedKg <= 0.1) return null;
    return {
      kgPlanned: round(Math.min(candidateKg, cappedKg), 2),
      hours: round(Math.min(hours, maxHrs), 2),
    };
  }
  return { kgPlanned: round(candidateKg, 2), hours: round(hours, 2) };
}

function hasCapacity(method, capacity, cfg) {
  const need = cfg.requires || [];
  for (const key of need) {
    if (key === "stove" && !capacity.stove) return false;
    if (key === "jars" && safeNum(capacity.jars, 0) <= 0) return false;
    if (key === "lids" && safeNum(capacity.lids, 0) <= 0) return false;
    if (key === "freezerSpaceKg" && safeNum(capacity.freezerSpaceKg, 0) <= 0) return false;
    if (key === "bags" && safeNum(capacity.bags, 0) <= 0) return false;
    if (key === "dehydratorTrays" && safeNum(capacity.dehydratorTrays, 0) <= 0) return false;
    if (key === "fermentVessels" && safeNum(capacity.fermentVessels, 0) <= 0) return false;
  }
  return true;
}

function kgFromCapacity(method, capacity, cfg) {
  switch (method) {
    case "canning": {
      const jars = safeNum(capacity.jars, 0);
      const lids = safeNum(capacity.lids, 0);
      const jarKg = 0.7; // ~0.7 kg produce per jar avg
      return Math.max(0, Math.min(jars, lids) * jarKg);
    }
    case "freezing": {
      const space = safeNum(capacity.freezerSpaceKg, 0);
      const bags = safeNum(capacity.bags, 0);
      const bagKg = 0.8;
      return Math.max(0, Math.min(space, bags * bagKg));
    }
    case "drying": {
      const trays = safeNum(capacity.dehydratorTrays, 0);
      const trayKg = 0.25;
      return Math.max(0, trays * trayKg);
    }
    case "fermenting": {
      const vessels = safeNum(capacity.fermentVessels, 0);
      const vesselKg = 1.8;
      return Math.max(0, vessels * vesselKg);
    }
    default:
      return Infinity;
  }
}

function applyCapacityConsumption(method, plan, capacity) {
  switch (method) {
    case "canning": {
      const jarKg = 0.7;
      const jarsUsed = Math.ceil(plan.kgPlanned / jarKg);
      capacity.jars = Math.max(0, safeNum(capacity.jars, 0) - jarsUsed);
      capacity.lids = Math.max(0, safeNum(capacity.lids, 0) - jarsUsed);
      break;
    }
    case "freezing": {
      const bagKg = 0.8;
      const bagsUsed = Math.ceil(plan.kgPlanned / bagKg);
      capacity.bags = Math.max(0, safeNum(capacity.bags, 0) - bagsUsed);
      capacity.freezerSpaceKg = Math.max(0, safeNum(capacity.freezerSpaceKg, 0) - plan.kgPlanned);
      break;
    }
    case "drying": {
      const trayKg = 0.25;
      const traysUsed = Math.ceil(plan.kgPlanned / trayKg);
      capacity.dehydratorTrays = Math.max(0, safeNum(capacity.dehydratorTrays, 0) - traysUsed);
      break;
    }
    case "fermenting": {
      const vesselKg = 1.8;
      const vesselsUsed = Math.ceil(plan.kgPlanned / vesselKg);
      capacity.fermentVessels = Math.max(0, safeNum(capacity.fermentVessels, 0) - vesselsUsed);
      break;
    }
    default:
      break;
  }
}

function outputSkusFor(method, crop, variety, kg) {
  switch (method) {
    case "canning":
      return [
        {
          sku: `${crop}-canned`,
          name: `${crop}${variety ? " " + variety : ""} — Canned`,
          qty: Math.ceil(kg / 0.7),
          unit: "jar",
        },
      ];
    case "freezing":
      return [
        {
          sku: `${crop}-frozen-kg`,
          name: `${crop}${variety ? " " + variety : ""} — Frozen`,
          qty: round(kg, 1),
          unit: "kg",
        },
      ];
    case "drying":
      return [
        {
          sku: `${crop}-dried`,
          name: `${crop}${variety ? " " + variety : ""} — Dried`,
          qty: Math.ceil(kg / 0.25),
          unit: "pack",
        },
      ];
    case "fermenting":
      return [
        {
          sku: `${crop}-fermented`,
          name: `${crop}${variety ? " " + variety : ""} — Fermented`,
          qty: Math.ceil(kg / 1.8),
          unit: "jar",
        },
      ];
    default:
      return [{ sku: `${crop}-preserved`, name: `${crop} — Preserved`, qty: kg, unit: "kg" }];
  }
}

function checklistFor(method, crop) {
  const base = ["Sanitize workspace", "Stage labels & log sheet"];
  switch (method) {
    case "canning":
      return [
        ...base,
        "Sterilize jars/lids",
        "Prepare hot water bath/pressure canner",
        `Cook/pack ${crop}`,
        "Process per recipe, cool 12–24h",
      ];
    case "freezing":
      return [...base, `Wash/trim ${crop}`, "Blanch & chill (if required)", "Pack, remove air, label/date"];
    case "drying":
      return [...base, `Slice ${crop} evenly`, "Load trays, set temp/time", "Condition jars/packs after dry"];
    case "fermenting":
      return [
        ...base,
        `Shred/chop ${crop}`,
        "Salt/brine to target %, pack vessels",
        "Burp/monitor daily first week",
      ];
    default:
      return base;
  }
}

function capacityReserveActions(method, plan) {
  switch (method) {
    case "canning": {
      const jarKg = 0.7;
      const jarsUsed = Math.ceil(plan.kgPlanned / jarKg);
      return [
        { type: "RESERVE_CONSUMABLE", key: "jars", qty: jarsUsed },
        { type: "RESERVE_CONSUMABLE", key: "lids", qty: jarsUsed },
      ];
    }
    case "freezing": {
      const bagKg = 0.8;
      const bagsUsed = Math.ceil(plan.kgPlanned / bagKg);
      return [
        { type: "RESERVE_CONSUMABLE", key: "bags", qty: bagsUsed },
        { type: "RESERVE_SPACE", key: "freezerSpaceKg", qty: plan.kgPlanned },
      ];
    }
    case "drying": {
      const trayKg = 0.25;
      const traysUsed = Math.ceil(plan.kgPlanned / trayKg);
      return [{ type: "RESERVE_EQUIPMENT", key: "dehydratorTrays", qty: traysUsed }];
    }
    case "fermenting": {
      const vesselKg = 1.8;
      const vesselsUsed = Math.ceil(plan.kgPlanned / vesselKg);
      return [{ type: "RESERVE_EQUIPMENT", key: "fermentVessels", qty: vesselsUsed }];
    }
    default:
      return [];
  }
}
