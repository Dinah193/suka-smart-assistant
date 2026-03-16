/**
 * animals/schedule.js
 * -------------------
 * How this fits:
 * - Lives under: src/agents/skills/animals/schedule.js
 * - Used by: Animal Dashboard, Homestead Planner, and SessionRunner when
 *   building “Now” animal care sessions.
 *
 * Responsibilities:
 * - Given animal profiles (and best-effort DB lookups), generate:
 *    • Feeding tasks (daily / interval-based)
 *    • Breeding tasks (heat checks, breed dates, pregnancy checks, dry-off dates)
 *    • Health tasks (vaccines, deworming, hoof/hoof care, weight checks)
 * - For each generated task, build Early / On-time / Late (or Light / Standard / Deep)
 *   swap options that a root-mounted AnimalScheduleSwapModal can display.
 *
 * Swap Modal Integration:
 * - This file is pure logic; it does NOT render UI.
 * - The returned `tasks` array includes:
 *    • swapOptions[] (per task)
 *    • chosenSwapId (resume-aware)
 * - Your AnimalScheduleSwapModal should:
 *    • group tasks by animal & day,
 *    • let the user choose between variants,
 *    • persist choices in Dexie keyed by taskId,
 *    • remain mounted at app root so it survives navigation.
 *
 * Hub Integration:
 * - Exports schedule analytics to Family Fund Hub when familyFundMode === true
 *   using HubPacketFormatter.formatAnimalSchedule().
 */

import { db } from "../../../services/db";
import { emitEvent } from "../../../services/events/eventBus";
import { familyFundMode } from "../../../config/featureFlags";
import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

/* -------------------------------------------------------------------------- */
/* Typedefs                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {"cattle"|"goat"|"sheep"|"poultry"|"rabbit"|"swine"|"dog"|"cat"|"other"} AnimalSpecies
 */

/**
 * @typedef {"buck"|"ram"|"bull"|"boar"|"rooster"|"male"|"doe"|"ewe"|"cow"|"sow"|"hen"|"female"|"wether"|"castrated"|"unknown"} AnimalSex
 */

/**
 * Single animal profile minimal contract for scheduling.
 *
 * @typedef {Object} AnimalProfile
 * @property {string} id
 * @property {string} name
 * @property {AnimalSpecies} [species]
 * @property {AnimalSex} [sex]
 * @property {string} [breed]
 * @property {string[]} [tags]                   - e.g. ["milking","breeder","grow-out"].
 * @property {number} [ageDays]
 * @property {number} [weightKg]
 * @property {string} [groupId]                  - Pen / herd / flock id.
 * @property {boolean} [isBreeder]
 * @property {boolean} [isLactating]
 * @property {boolean} [isGrowOut]
 * @property {string} [lastHeatDate]             - For females, ISO date.
 * @property {string} [lastServiceDate]          - Last breeding/service.
 * @property {string} [expectedDueDate]          - Pregnant animals.
 * @property {string} [lastDewormDate]
 * @property {string} [lastVaccineDate]
 * @property {string} [lastHoofTrimDate]
 * @property {string} [lastWeightCheckDate]
 */

/**
 * @typedef {"feeding"|"breeding"|"health"} AnimalTaskKind
 */

/**
 * Individual task window/slot.
 *
 * @typedef {Object} AnimalTask
 * @property {string} id                   - Stable id, e.g. "a_<animalId>_<kind>_<yyyy-mm-dd>".
 * @property {string} animalId
 * @property {string} animalName
 * @property {AnimalTaskKind} kind
 * @property {string} label                - Short sentence for UI.
 * @property {string} description          - Detailed instructions.
 * @property {string} dueDate              - YYYY-MM-DD (local).
 * @property {string|null} dueTime         - "HH:mm" or null for "anytime".
 * @property {number|null} estimatedMinutes
 * @property {string[]} blockers           - ["weather","sabbath","equipment","inventory","quietHours"].
 * @property {string[]} tags               - e.g. ["milking","grain","breeding-check"].
 * @property {Object} metadata             - Free-form extra info; see helper functions.
 */

/**
 * Swap option for one task.
 *
 * @typedef {Object} AnimalTaskSwapOption
 * @property {string} id
 * @property {string} label                - e.g. "On-time feeding", "Early feeding".
 * @property {string} summary              - UX copy for swap modal.
 * @property {"early"|"onTime"|"late"|"light"|"standard"|"deep"} variant
 * @property {string} targetDate           - YYYY-MM-DD for this variant.
 * @property {string|null} targetTime      - HH:mm or null.
 * @property {boolean} autoSelected
 * @property {boolean} [isNeutral]
 * @property {string[]} badges             - e.g. ["DEFAULT","SAFE","AGGRESSIVE"].
 */

/**
 * Schedule result for each task with swap options & choice.
 *
 * @typedef {Object} AnimalScheduleTaskResult
 * @property {AnimalTask} task
 * @property {AnimalTaskSwapOption[]} swapOptions
 * @property {string|null} chosenSwapId
 * @property {string|null} error
 */

/**
 * Planner options.
 *
 * @typedef {Object} AnimalScheduleOptions
 * @property {string} [eventSource="animals"]
 * @property {number} [nowTs]                - Timestamp; defaults to Date.now().
 * @property {number} [horizonDays=7]        - Plan tasks within this many days from `now`.
 * @property {Record<string,string>} [chosenSwapByTaskId] - Resume map (taskId → swapId).
 */

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * SSA event wrapper.
 * @param {string} type
 * @param {string} source
 * @param {any} data
 */
function emit(type, source, data) {
  try {
    emitEvent({
      type,
      ts: new Date().toISOString(),
      source,
      data,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[animals/schedule] Failed to emit event:", type, err);
  }
}

/**
 * Convert an ISO-like string to a Date (noon local to avoid TZ flakiness).
 * @param {string|null|undefined} iso
 * @returns {Date|null}
 */
function isoToDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(12, 0, 0, 0);
  return d;
}

/**
 * Convert Date to YYYY-MM-DD string.
 * @param {Date} d
 * @returns {string}
 */
function dateToYMD(d) {
  const year = d.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Add days to a Date, returning a new Date.
 * @param {Date} d
 * @param {number} days
 * @returns {Date}
 */
function addDays(d, days) {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + days);
  return out;
}

/**
 * Compare YYYY-MM-DD strings.
 * @param {string} a
 * @param {string} b
 * @returns {number} -1, 0, 1
 */
function compareYmd(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Dexie helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Optional: get global defaults for feeding/breeding/health intervals.
 * These are just best-effort; you can wire to real tables later.
 *
 * @returns {Promise<{
 *   feedingDefaultTimes?: string[],
 *   dewormIntervalDays?: number,
 *   vaccineIntervalDays?: number,
 *   hoofTrimIntervalDays?: number,
 *   weightCheckIntervalDays?: number
 * }>}
 */
async function fetchAnimalCareDefaults() {
  if (!db) return {};
  try {
    if (db.animalCareMeta && db.animalCareMeta.toCollection) {
      const recs = await db.animalCareMeta.toCollection().limit(1).toArray();
      return recs[0] || {};
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[animals/schedule] Failed to read animalCareMeta:", err);
  }
  return {};
}

/* -------------------------------------------------------------------------- */
/* Feeding task generation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Get default daily feeding times (HH:mm) from DB or fallback.
 * @param {any} meta
 * @returns {string[]}
 */
function resolveFeedingTimes(meta) {
  if (
    Array.isArray(meta.feedingDefaultTimes) &&
    meta.feedingDefaultTimes.length
  ) {
    return meta.feedingDefaultTimes;
  }
  // Simple fallback: morning & evening.
  return ["07:00", "18:00"];
}

/**
 * Generate feeding tasks for an animal over `horizonDays`.
 *
 * - Lactating / grow-out animals get both AM & PM feedings.
 * - Low-maintenance animals may get 1 feeding daily or even every second day,
 *   but here we keep it simple: at least 1 feeding/day.
 *
 * @param {AnimalProfile} animal
 * @param {Date} startDate
 * @param {number} horizonDays
 * @param {string[]} feedingTimes
 * @returns {AnimalTask[]}
 */
function buildFeedingTasks(animal, startDate, horizonDays, feedingTimes) {
  /** @type {AnimalTask[]} */
  const tasks = [];

  const highNeed =
    animal.isLactating ||
    animal.isGrowOut ||
    (Array.isArray(animal.tags) &&
      (animal.tags.includes("milking") || animal.tags.includes("grow-out")));

  for (let i = 0; i < horizonDays; i += 1) {
    const d = addDays(startDate, i);
    const ymd = dateToYMD(d);

    const timesForDay =
      highNeed && feedingTimes.length >= 2 ? feedingTimes : [feedingTimes[0]];

    for (const time of timesForDay) {
      const id = `a_${animal.id}_feeding_${ymd}_${time.replace(":", "")}`;
      tasks.push({
        id,
        animalId: animal.id,
        animalName: animal.name,
        kind: "feeding",
        label: `Feed ${animal.name}`,
        description: highNeed
          ? `Feed ${animal.name} according to high-needs ration (lactating/grow-out). Check water and minerals.`
          : `Feed ${animal.name}. Ensure fresh water and free-choice minerals.`,
        dueDate: ymd,
        dueTime: time,
        estimatedMinutes: 5,
        blockers: ["sabbath", "equipment", "inventory"],
        tags: [
          "feeding",
          highNeed ? "high-need" : "maintenance",
          ...(animal.isLactating ? ["lactating"] : []),
        ],
        metadata: {
          type: highNeed ? "high-need" : "maintenance",
          rationProfileId: null,
          groupId: animal.groupId || null,
          species: animal.species || null,
        },
      });
    }
  }

  return tasks;
}

/* -------------------------------------------------------------------------- */
/* Breeding task generation                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Simple species-specific gestation days (approx).
 */
const GESTATION_DAYS = {
  cattle: 283,
  goat: 150,
  sheep: 150,
  swine: 114,
  rabbit: 31,
};

/**
 * Determine gestation length for an animal.
 * @param {AnimalProfile} animal
 * @returns {number}
 */
function getGestationDays(animal) {
  const key = animal.species || "other";
  return GESTATION_DAYS[key] || 150;
}

/**
 * Generate breeding-related tasks for an animal over horizon.
 * - Heat checks for breeders not yet serviced.
 * - Pregnancy check for serviced animals.
 * - Due date and "pre-kidding/lambing" tasks.
 *
 * @param {AnimalProfile} animal
 * @param {Date} startDate
 * @param {number} horizonDays
 * @returns {AnimalTask[]}
 */
function buildBreedingTasks(animal, startDate, horizonDays) {
  /** @type {AnimalTask[]} */
  const tasks = [];

  const isFemale =
    animal.sex === "doe" ||
    animal.sex === "ewe" ||
    animal.sex === "cow" ||
    animal.sex === "sow" ||
    animal.sex === "hen" ||
    animal.sex === "female";

  if (!animal.isBreeder || !isFemale) return tasks;

  const gestation = getGestationDays(animal);
  const startYmd = dateToYMD(startDate);
  const endYmd = dateToYMD(addDays(startDate, horizonDays - 1));

  // 1) Heat checks: if there's a lastHeatDate but no lastServiceDate.
  if (animal.lastHeatDate && !animal.lastServiceDate) {
    const lastHeat = isoToDate(animal.lastHeatDate);
    if (lastHeat) {
      // Most species cycle ~21 days; check windows.
      const cycle = 21;
      for (let i = 1; i <= 4; i += 1) {
        const heatWindowStart = addDays(lastHeat, i * cycle - 2);
        const heatWindowEnd = addDays(lastHeat, i * cycle + 2);
        const heatYmd = dateToYMD(heatWindowStart);
        if (
          compareYmd(heatYmd, startYmd) >= 0 &&
          compareYmd(heatYmd, endYmd) <= 0
        ) {
          const id = `a_${animal.id}_breeding_heatCheck_${heatYmd}`;
          tasks.push({
            id,
            animalId: animal.id,
            animalName: animal.name,
            kind: "breeding",
            label: `Heat check for ${animal.name}`,
            description:
              "Observe for standing heat and signs of receptivity. Record observations and schedule service if in standing heat.",
            dueDate: heatYmd,
            dueTime: null,
            estimatedMinutes: 10,
            blockers: ["weather", "quietHours"],
            tags: ["breeding", "heat-check"],
            metadata: {
              windowEnd: dateToYMD(heatWindowEnd),
              cycleIndex: i,
            },
          });
        }
      }
    }
  }

  // 2) Pregnancy / gestation tasks if there is a lastServiceDate or expectedDueDate.
  const serviceDate = isoToDate(animal.lastServiceDate);
  const expectedDueDate = isoToDate(animal.expectedDueDate);

  if (serviceDate || expectedDueDate) {
    const conceptionBase = serviceDate || expectedDueDate;
    const nominalDue = expectedDueDate || addDays(conceptionBase, gestation);
    const dueYmd = dateToYMD(nominalDue);

    // Pregnancy check ~30–45 days after breeding.
    if (serviceDate) {
      const pregCheck = addDays(serviceDate, 35);
      const pregYmd = dateToYMD(pregCheck);
      if (
        compareYmd(pregYmd, startYmd) >= 0 &&
        compareYmd(pregYmd, endYmd) <= 0
      ) {
        const id = `a_${animal.id}_breeding_pregCheck_${pregYmd}`;
        tasks.push({
          id,
          animalId: animal.id,
          animalName: animal.name,
          kind: "breeding",
          label: `Pregnancy check for ${animal.name}`,
          description:
            "Perform pregnancy check (palpation, ultrasound, or blood test). Update records with results.",
          dueDate: pregYmd,
          dueTime: null,
          estimatedMinutes: 15,
          blockers: ["equipment"],
          tags: ["breeding", "pregnancy-check"],
          metadata: {
            serviceDate: animal.lastServiceDate,
            method: "palpation|ultrasound|blood-test",
          },
        });
      }
    }

    // Pre-birth prep 2 weeks and 1 week before due date.
    const prepDates = [14, 7].map((daysBefore) =>
      addDays(nominalDue, -daysBefore)
    );
    prepDates.forEach((date, idx) => {
      const ymd = dateToYMD(date);
      if (compareYmd(ymd, startYmd) < 0 || compareYmd(ymd, endYmd) > 0) return;

      const id = `a_${animal.id}_breeding_preBirth_${ymd}_${idx}`;
      tasks.push({
        id,
        animalId: animal.id,
        animalName: animal.name,
        kind: "breeding",
        label: `Pre-birth prep for ${animal.name}`,
        description:
          "Prepare kidding/lambing/calving area, clean pens, gather towels, iodine, and emergency supplies.",
        dueDate: ymd,
        dueTime: null,
        estimatedMinutes: 20,
        blockers: ["equipment"],
        tags: ["breeding", "pre-birth"],
        metadata: {
          dueDate: dueYmd,
          daysBeforeDue: [14, 7][idx],
        },
      });
    });

    // Due date "monitor closely" task.
    if (compareYmd(dueYmd, startYmd) >= 0 && compareYmd(dueYmd, endYmd) <= 0) {
      const id = `a_${animal.id}_breeding_due_${dueYmd}`;
      tasks.push({
        id,
        animalId: animal.id,
        animalName: animal.name,
        kind: "breeding",
        label: `${animal.name} due to give birth`,
        description:
          "Monitor closely for signs of labor. Observe quietly and intervene only if necessary.",
        dueDate: dueYmd,
        dueTime: null,
        estimatedMinutes: 30,
        blockers: ["weather", "quietHours"],
        tags: ["breeding", "due-date"],
        metadata: {
          dueDate: dueYmd,
        },
      });
    }
  }

  return tasks;
}

/* -------------------------------------------------------------------------- */
/* Health task generation                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Helper to compute next-due date given last date + interval.
 *
 * @param {string|null|undefined} lastIso
 * @param {number} intervalDays
 * @returns {string|null}
 */
function computeNextDueDate(lastIso, intervalDays) {
  const last = isoToDate(lastIso);
  const base = last || new Date();
  const next = addDays(base, intervalDays);
  return dateToYMD(next);
}

/**
 * Generate "periodic health" tasks: deworming, vaccines, hoof trims, weight checks.
 *
 * @param {AnimalProfile} animal
 * @param {Date} startDate
 * @param {number} horizonDays
 * @param {any} meta
 * @returns {AnimalTask[]}
 */
function buildHealthTasks(animal, startDate, horizonDays, meta) {
  /** @type {AnimalTask[]} */
  const tasks = [];

  const startYmd = dateToYMD(startDate);
  const endYmd = dateToYMD(addDays(startDate, horizonDays - 1));

  const dewormInterval = Number.isFinite(meta.dewormIntervalDays)
    ? meta.dewormIntervalDays
    : 90;
  const vaccineInterval = Number.isFinite(meta.vaccineIntervalDays)
    ? meta.vaccineIntervalDays
    : 365;
  const hoofInterval = Number.isFinite(meta.hoofTrimIntervalDays)
    ? meta.hoofTrimIntervalDays
    : 180;
  const weightInterval = Number.isFinite(meta.weightCheckIntervalDays)
    ? meta.weightCheckIntervalDays
    : 60;

  const healthConfigs = [
    {
      key: "deworm",
      label: `Deworm ${animal.name}`,
      description:
        "Administer appropriate dewormer based on FAMACHA scoring, weight, and local parasite pressure. Log product and dose.",
      lastDate: animal.lastDewormDate,
      interval: dewormInterval,
      tags: ["health", "deworm"],
    },
    {
      key: "vaccine",
      label: `Vaccinate ${animal.name}`,
      description:
        "Administer due vaccines (e.g., CDT/7-way) per your herd plan. Log lot number and site.",
      lastDate: animal.lastVaccineDate,
      interval: vaccineInterval,
      tags: ["health", "vaccine"],
    },
    {
      key: "hoof",
      label: `Hoof / foot care for ${animal.name}`,
      description:
        "Trim hooves / inspect feet for overgrowth, rot, or injury. Clean and treat as needed.",
      lastDate: animal.lastHoofTrimDate,
      interval: hoofInterval,
      tags: ["health", "hoof-care"],
    },
    {
      key: "weight",
      label: `Weight check for ${animal.name}`,
      description:
        "Record weight using scale or tape. Adjust feed and health plan based on change.",
      lastDate: animal.lastWeightCheckDate,
      interval: weightInterval,
      tags: ["health", "weight-check"],
    },
  ];

  for (const cfg of healthConfigs) {
    const nextYmd = computeNextDueDate(cfg.lastDate, cfg.interval);
    if (!nextYmd) continue;

    if (
      compareYmd(nextYmd, startYmd) >= 0 &&
      compareYmd(nextYmd, endYmd) <= 0
    ) {
      const id = `a_${animal.id}_health_${cfg.key}_${nextYmd}`;
      tasks.push({
        id,
        animalId: animal.id,
        animalName: animal.name,
        kind: "health",
        label: cfg.label,
        description: cfg.description,
        dueDate: nextYmd,
        dueTime: null,
        estimatedMinutes: 15,
        blockers: ["equipment", "weather"],
        tags: cfg.tags,
        metadata: {
          type: cfg.key,
          intervalDays: cfg.interval,
          lastDate: cfg.lastDate || null,
        },
      });
    }
  }

  return tasks;
}

/* -------------------------------------------------------------------------- */
/* Swap option building                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build swap options for a feeding task (Early / On-time / Late).
 *
 * @param {AnimalTask} task
 * @returns {AnimalTaskSwapOption[]}
 */
function buildFeedingSwapOptions(task) {
  const due = isoToDate(task.dueDate);
  if (!due) return [];

  const earlyDate = dateToYMD(addDays(due, -1));
  const lateDate = dateToYMD(addDays(due, 1));

  /** @type {AnimalTaskSwapOption[]} */
  const options = [
    {
      id: `${task.id}:early`,
      label: "Early feeding",
      summary:
        "Feed slightly earlier than planned to align with a heavy workload tomorrow.",
      variant: "early",
      targetDate: earlyDate,
      targetTime: task.dueTime,
      autoSelected: false,
      isNeutral: false,
      badges: ["AGGRESSIVE"],
    },
    {
      id: `${task.id}:onTime`,
      label: "On-time feeding",
      summary:
        "Feed on the normal schedule for consistent routine and rumen health.",
      variant: "onTime",
      targetDate: task.dueDate,
      targetTime: task.dueTime,
      autoSelected: true,
      isNeutral: false,
      badges: ["DEFAULT", "ROUTINE"],
    },
    {
      id: `${task.id}:late`,
      label: "Slightly late feeding",
      summary:
        "Shift feeding slightly later in the day. Use sparingly to avoid stress.",
      variant: "late",
      targetDate: lateDate,
      targetTime: task.dueTime,
      autoSelected: false,
      isNeutral: false,
      badges: ["FLEXIBLE"],
    },
  ];

  return options;
}

/**
 * Build swap options for a breeding task:
 * - On-time (default)
 * - Early (if the task is a prep)
 * - Late tolerance for check-type tasks.
 *
 * @param {AnimalTask} task
 * @returns {AnimalTaskSwapOption[]}
 */
function buildBreedingSwapOptions(task) {
  const due = isoToDate(task.dueDate);
  if (!due) return [];

  const earlyDate = dateToYMD(addDays(due, -1));
  const lateDate = dateToYMD(addDays(due, 2));

  const isPrep = task.tags.includes("pre-birth");

  /** @type {AnimalTaskSwapOption[]} */
  const options = [
    {
      id: `${task.id}:onTime`,
      label: isPrep ? "On-time prep" : "On-time breeding task",
      summary: isPrep
        ? "Do birthing prep on the planned day for a calm, organized birth area."
        : "Perform this breeding task on the planned day.",
      variant: "onTime",
      targetDate: task.dueDate,
      targetTime: task.dueTime,
      autoSelected: true,
      isNeutral: false,
      badges: ["DEFAULT", "SAFE"],
    },
    {
      id: `${task.id}:early`,
      label: isPrep ? "Early prep" : "Early check",
      summary: isPrep
        ? "Prep early so you are fully ready even if birth comes sooner."
        : "Check early if you will be busy on the planned day.",
      variant: "early",
      targetDate: earlyDate,
      targetTime: task.dueTime,
      autoSelected: false,
      isNeutral: false,
      badges: ["AGGRESSIVE"],
    },
    {
      id: `${task.id}:late`,
      label: "Late / grace window",
      summary:
        "Push this breeding check/window a little later if needed (watch for signs and do not over-delay).",
      variant: "late",
      targetDate: lateDate,
      targetTime: task.dueTime,
      autoSelected: false,
      isNeutral: false,
      badges: ["FLEXIBLE", "RISK"],
    },
  ];

  return options;
}

/**
 * Build swap options for a health task:
 * - Light: quick check / minimal intervention.
 * - Standard: normal protocol (default).
 * - Deep: full exam / extended time.
 *
 * @param {AnimalTask} task
 * @returns {AnimalTaskSwapOption[]}
 */
function buildHealthSwapOptions(task) {
  const due = isoToDate(task.dueDate);
  if (!due) return [];

  /** @type {AnimalTaskSwapOption[]} */
  const options = [
    {
      id: `${task.id}:light`,
      label: "Quick / light check",
      summary:
        "Do a quick check or lighter version of this health task if time or weather is tight.",
      variant: "light",
      targetDate: task.dueDate,
      targetTime: task.dueTime,
      autoSelected: false,
      isNeutral: false,
      badges: ["TIME-SAVING"],
    },
    {
      id: `${task.id}:standard`,
      label: "Standard protocol",
      summary:
        "Perform the full, normal version of this health task according to your herd plan.",
      variant: "standard",
      targetDate: task.dueDate,
      targetTime: task.dueTime,
      autoSelected: true,
      isNeutral: false,
      badges: ["DEFAULT", "SAFE"],
    },
    {
      id: `${task.id}:deep`,
      label: "Deep / extended exam",
      summary:
        "Take extra time for a thorough exam, notes, and photos; ideal when you suspect issues or are training someone.",
      variant: "deep",
      targetDate: task.dueDate,
      targetTime: task.dueTime,
      autoSelected: false,
      isNeutral: false,
      badges: ["THOROUGH"],
    },
  ];

  return options;
}

/**
 * Dispatch to correct swap option builder by task.kind.
 *
 * @param {AnimalTask} task
 * @returns {AnimalTaskSwapOption[]}
 */
function buildSwapOptionsForTask(task) {
  if (task.kind === "feeding") return buildFeedingSwapOptions(task);
  if (task.kind === "breeding") return buildBreedingSwapOptions(task);
  if (task.kind === "health") return buildHealthSwapOptions(task);
  return [];
}

/* -------------------------------------------------------------------------- */
/* Hub export                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Export animal schedule to Hub (if familyFundMode is enabled).
 *
 * @param {AnimalScheduleTaskResult[]} tasks
 * @param {string} eventSource
 */
async function exportAnimalScheduleToHub(tasks, eventSource) {
  if (!familyFundMode || !tasks || !tasks.length) return;

  try {
    const payload = HubPacketFormatter.formatAnimalSchedule(tasks, {
      source: eventSource,
      exportedAt: new Date().toISOString(),
    });
    await FamilyFundConnector.send(payload);
    emit("animals.schedule.exported", eventSource, {
      tasks: tasks.length,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[animals/schedule] Hub export failed (soft):", err);
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Generate feeding, breeding, and health tasks for a list of animals.
 *
 * Emits:
 * - animals.schedule.requested
 * - animals.schedule.tasks.built (per animal)
 * - animals.schedule.swapOptions.built (per task)
 * - animals.schedule.completed
 * - animals.schedule.exported (on Hub export success)
 *
 * Integration with SessionRunner:
 * - The resulting `tasks` array can be transformed into Session objects in
 *   an AnimalsSessionBuilder module, using:
 *   • domain: "animals"
 *   • title: "Animal care: <date>"
 *   • steps[] derived from tasks belonging to that date / group.
 *
 * @param {AnimalProfile[]} animals
 * @param {AnimalScheduleOptions} [options]
 * @returns {Promise<{ tasks: AnimalScheduleTaskResult[], meta: { animals: number, tasks: number, errors: number } }>}
 */
export async function generateAnimalSchedule(animals, options = {}) {
  const {
    eventSource = "animals",
    nowTs = Date.now(),
    horizonDays = 7,
    chosenSwapByTaskId = {},
  } = options;

  const safeAnimals = Array.isArray(animals) ? animals : [];
  const now = new Date(nowTs);
  now.setHours(12, 0, 0, 0); // normalize

  emit("animals.schedule.requested", eventSource, {
    animals: safeAnimals.length,
    horizonDays,
  });

  const meta = await fetchAnimalCareDefaults();

  /** @type {AnimalScheduleTaskResult[]} */
  const results = [];
  let errorCount = 0;

  const feedingTimes = resolveFeedingTimes(meta);

  for (const animal of safeAnimals) {
    try {
      const feedingTasks = buildFeedingTasks(
        animal,
        now,
        horizonDays,
        feedingTimes
      );
      const breedingTasks = buildBreedingTasks(animal, now, horizonDays);
      const healthTasks = buildHealthTasks(animal, now, horizonDays, meta);

      /** @type {AnimalTask[]} */
      const allTasks = [...feedingTasks, ...breedingTasks, ...healthTasks];

      emit("animals.schedule.tasks.built", eventSource, {
        animalId: animal.id,
        animalName: animal.name,
        tasks: allTasks.length,
      });

      for (const task of allTasks) {
        const swapOptions = buildSwapOptionsForTask(task);
        const resumeId = chosenSwapByTaskId[task.id];

        const chosen =
          (resumeId && swapOptions.find((opt) => opt.id === resumeId)) ||
          swapOptions.find((opt) => opt.autoSelected) ||
          swapOptions[0] ||
          null;

        /** @type {AnimalScheduleTaskResult} */
        const result = {
          task,
          swapOptions,
          chosenSwapId: chosen ? chosen.id : null,
          error: null,
        };

        results.push(result);

        emit("animals.schedule.swapOptions.built", eventSource, {
          animalId: task.animalId,
          taskId: task.id,
          kind: task.kind,
          optionsCount: swapOptions.length,
          autoSelectedId:
            swapOptions.find((opt) => opt.autoSelected)?.id || null,
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[animals/schedule] Failed to build tasks for animal:",
        animal,
        err
      );
      errorCount += 1;
    }
  }

  emit("animals.schedule.completed", eventSource, {
    animals: safeAnimals.length,
    tasks: results.length,
    errors: errorCount,
    ts: new Date(nowTs).toISOString(),
  });

  // Fire-and-forget Hub export.
  exportAnimalScheduleToHub(results, eventSource).catch(() => {});

  return {
    tasks: results,
    meta: {
      animals: safeAnimals.length,
      tasks: results.length,
      errors: errorCount,
    },
  };
}

/**
 * Convenience helper:
 * Generate schedule tasks for a single animal.
 *
 * @param {AnimalProfile} animal
 * @param {AnimalScheduleOptions} [options]
 * @returns {Promise<AnimalScheduleTaskResult[]>}
 */
export async function generateSingleAnimalSchedule(animal, options = {}) {
  const { tasks } = await generateAnimalSchedule([animal], options);
  // Filter out tasks for this animal only (defensive if more animals later).
  return tasks.filter((t) => t.task.animalId === animal.id);
}
