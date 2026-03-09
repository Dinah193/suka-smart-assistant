// C:\Users\larho\suka-smart-assistant\src\pages\garden\index.jsx
/* eslint-disable no-console */
/**
 * Garden Page
 * -----------------------------------------------------------------------------
 * Purpose
 * Domain page for Planning + “Now” execution of Garden sessions.
 *
 * How this fits
 * - Shows a prominent “Now” CTA to resolve and run the next garden session.
 * - If multiple runnable sessions exist, opens a swap modal.
 * - Creates a persisted Session (Dexie via SessionsRepo) from:
 *      - Plan Draft
 *      - Garden Artifacts (StepGraphs → Composite)
 *      - Or a Merge of both
 *   when none exist, then opens the unified SessionRunner modal.
 * - Runner (mounted at app root) handles wake-lock, notifications, TTS,
 *   Media Session, PiP, checkpoints, resume logic, guards, and Hub export.
 *
 * Contracts touched
 * - SessionsRepo: { getRunnable({domain}), upsert(session) }
 * - openRunner({ sessionId, sticky: true })
 * - eventBus: emit({ type, ts, source, data })
 * - automation runtime: optional helpers
 *
 * Events (emitted elsewhere by the runner)
 * session.started, session.step.changed, session.paused, session.resumed,
 * session.completed, session.aborted, session.exported
 *
 * Notes
 * - Soft/defensive imports so this page doesn't crash in partial builds.
 * - Session object conforms to the “minimum viable” contract from prompt.
 *
 * =============================================================================
 * REQUIRED (Interactive Module Add-on)
 * =============================================================================
 * 1) USER FLOWS (Garden Records / Log)
 *    - View a list of garden records (tasks/notes/plantings/harvests).
 *    - Search by text (title/description/crop/location/tags).
 *    - Filter by: type, status (open/done/archived), priority.
 *    - Sort by: due date, updated date, created date.
 *    - Add a record (modal form).
 *    - Edit a record (modal form).
 *    - Soft-delete (archive) / restore.
 *    - Mark complete / reopen.
 *    - Optimistic UI for create/update/archive; rollback on error.
 *
 * 2) DATA CONTRACT (Dexie table: gardenRecords)
 *    GardenRecord = {
 *      id: string,
 *      householdId: string|null,
 *      type: "task"|"planting"|"harvest"|"note",
 *      title: string,
 *      description: string,
 *      crop: string,
 *      variety: string,
 *      location: string,     // e.g., "Backyard", "Plot A", "Bed 3"
 *      bed: string,          // optional finer-grain
 *      dueDate: string|null, // ISO date (YYYY-MM-DD)
 *      status: "open"|"done"|"archived",
 *      priority: "low"|"med"|"high",
 *      tags: string[],       // simple labels
 *      meta: object,         // flexible (e.g., qty, units, photos refs)
 *      completedAt: string|null, // ISO datetime
 *      archivedAt: string|null,  // ISO datetime
 *      createdAt: string,         // ISO datetime
 *      updatedAt: string          // ISO datetime
 *    }
 *
 * 3) STATE MODEL
 *    Local state:
 *      - records[], loading, loadError
 *      - query/filter/sort state
 *      - modal open + draft form state + validationErrors
 *      - mutateBusy + mutateError (per action)
 *    Derived state:
 *      - visibleRecords = filtered + searched + sorted
 *      - counts (open/done/archived)
 *    Validation:
 *      - title required
 *      - type required
 *      - dueDate must be YYYY-MM-DD if provided
 *    Optimistic updates:
 *      - apply local update first; persist; rollback on failure
 *
 * 4) PERSISTENCE (Dexie CRUD) — soft import DB + fallback Dexie instance
 *    - Tries to use your app DB (soft import).
 *    - If missing OR table missing, uses a local fallback Dexie instance
 *      with gardenRecords store so the page remains interactive.
 *    - Seeds demo rows when empty (first run).
 *
 * 5) EVENTBUS
 *    Emits standardized events on every mutation:
 *      - garden.record.created
 *      - garden.record.updated
 *      - garden.record.archived
 *      - garden.record.restored
 *      - garden.record.deleted (hard delete if used)
 *    Payload shape:
 *      { record, patch?, previous?, householdId, reason?, optimistic: boolean }
 *
 * 6) WIRING
 *    - Default export page component (routable)
 *    - All dependencies have safe fallbacks to avoid runtime crashes
 */

import React, { useEffect, useMemo, useState, useRef } from "react";
import { Link } from "react-router-dom";

/* -------------------------------- Safe Imports -------------------------------- */

import * as GardenQueueManagerMod from "../../managers/GardenQueueManager";
import InventoryMonitor from "../../managers/InventoryMonitor";
import ReminderManager from "../../managers/ReminderManager";
import { automation } from "@/services/automation/runtime";

/* ✅ NEW: required softImport */
import { softImport } from "@/services/softImport";

/* -------------------------- EventBus (soft / defensive) ------------------------ */
/**
 * REQUIRED: Soft-import for eventBus path:
 *   "@/services/events/eventBus.js" OR "../../services/events/eventBus"
 */
let eventBus = { emit: () => {}, on: () => () => {} };
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const eb = require("@/services/events/eventBus.js");
  eventBus = eb?.default || eb?.eventBus || eb || eventBus;
} catch {
  try {
    // eslint-disable-next-line global-require
    const eb2 = require("../../services/events/eventBus");
    eventBus = eb2?.default || eb2?.eventBus || eb2 || eventBus;
  } catch {
    // keep noop
  }
}

// Garden artifacts + hub + flags (soft)
let GardenArtifactRepo = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@/services/garden/GardenArtifactRepo");
  GardenArtifactRepo = mod.default || mod;
} catch {}

let featureFlags = { familyFundMode: false };
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@/config/featureFlags");
  featureFlags = mod.featureFlags || mod.default || featureFlags;
} catch {}

let HubPacketFormatter = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@/services/hub/HubPacketFormatter");
  HubPacketFormatter = mod.default || mod;
} catch {}

let FamilyFundConnector = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@/services/hub/FamilyFundConnector");
  FamilyFundConnector = mod.default || mod;
} catch {}

import CropPicker from "@/components/garden/CropPicker.jsx";

/* ------------------------------- Session plumbing ------------------------------ */

let SessionsRepo = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@/services/session/SessionsRepo");
  SessionsRepo = mod.default || mod;
} catch {}

let openRunner = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@/features/session-runner/openRunner");
  openRunner = mod.default || mod;
} catch {}

/* ------------------------------- Optional stores ------------------------------ */

let useHouseholdCalendar = () => ({ events: [], addEvent: () => {} });
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@/store/HouseholdCalendarStore");
  useHouseholdCalendar = mod.useHouseholdCalendar || useHouseholdCalendar;
} catch {}

let useGardenGroupStore = () => ({ groups: [], communityGardens: [] });
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@/store/GardenGroupStore");
  useGardenGroupStore = mod.useGardenGroupStore || useGardenGroupStore;
} catch {}

/* -------------------------- Favorites (sessions & schedules) ------------------ */

const FAV_TEMPLATES_KEY = "suka:garden.favoriteTemplates.v1";

function loadFavoriteTemplates() {
  try {
    const raw = localStorage.getItem(FAV_TEMPLATES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveFavoriteTemplates(templates) {
  try {
    localStorage.setItem(FAV_TEMPLATES_KEY, JSON.stringify(templates));
  } catch {
    // ignore
  }
}

/* -------------------------- Planner state persistence ------------------------- */

const PLANNER_STATE_KEY = "suka:garden.plannerInputs.v1";

function loadPlannerInputs() {
  try {
    const raw = localStorage.getItem(PLANNER_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function savePlannerInputs(next) {
  try {
    localStorage.setItem(PLANNER_STATE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

/* --------------------------------- Utilities --------------------------------- */

const ACRES_TO_SQFT = 43560;

const todayISO = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);

function addDaysISO(iso, days) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function fmt(iso) {
  try {
    return new Date(`${iso}T12:00:00`).toLocaleDateString();
  } catch {
    return iso;
  }
}

const cls = (...xs) => xs.filter(Boolean).join(" ");

function safeJsonClone(x) {
  try {
    return JSON.parse(JSON.stringify(x));
  } catch {
    return x;
  }
}

function makeId(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function nowISO() {
  return new Date().toISOString();
}

function normStr(x) {
  return String(x ?? "").trim();
}

function splitTags(s) {
  return normStr(s)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function isISODate(yyyyMmDd) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(yyyyMmDd || ""));
}

/* --------------------------- Hub Export Helper -------------------------------- */

async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;

    const formatter =
      HubPacketFormatter.formatSession ||
      HubPacketFormatter.format ||
      HubPacketFormatter.default ||
      null;
    const connector =
      FamilyFundConnector.send ||
      FamilyFundConnector.export ||
      FamilyFundConnector.default ||
      null;

    if (!formatter || !connector) return;

    const packet = formatter(payload);
    await connector(packet);
  } catch (err) {
    console.warn("[garden] exportToHubIfEnabled failed:", err?.message || err);
  }
}

/* ----------------------------- Local padding tokens -------------------------- */

const PAD = {
  tab: { padding: "0.5rem 0.9rem" },
  chip: { padding: "0.45rem 0.8rem" },
  btn: { padding: "0.55rem 1rem" },
};

const FIELD_INPUT_CLASS = "input";

/* --------------------------- Managers: safe wrappers -------------------------- */

function resolveGQM(mod) {
  return mod && mod.default ? mod.default : mod;
}

async function getQueueSafe() {
  const GQM = resolveGQM(GardenQueueManagerMod);
  if (GQM && typeof GQM.getQueue === "function") return await GQM.getQueue();
  if (GQM && typeof GQM.get === "function")
    return (await GQM.get("queue")) || [];
  if (Array.isArray(GQM?.queue)) return GQM.queue;
  return [];
}

async function completeTaskSafe(taskId) {
  const GQM = resolveGQM(GardenQueueManagerMod);
  if (GQM?.completeTask) return GQM.completeTask(taskId);
  if (GQM?.complete) return GQM.complete(taskId);
  if (GQM?.markDone) return GQM.markDone(taskId);
  emitEvent("garden/task_complete", { taskId });
}

/* ----------------------------- Small UI helpers ------------------------------ */

function Field({ label, children, hint }) {
  return (
    <label className="sv-stack-sm">
      <div className="sv-strong">{label}</div>
      {children}
      {hint ? <div className="sv-caption">{hint}</div> : null}
    </label>
  );
}

function StepHeader({ step, title, subtitle }) {
  return (
    <div className="sv-row sv-align-start" style={{ gap: 10 }}>
      <div className="sv-badge" style={{ width: 32, textAlign: "center" }}>
        {step}
      </div>
      <div className="sv-stack-xs">
        <div className="sv-strong" style={{ fontSize: 16 }}>
          {title}
        </div>
        {subtitle ? <div className="sv-muted">{subtitle}</div> : null}
      </div>
    </div>
  );
}

/* --------------------------- Domain-aware Event Glue -------------------------- */

function emitEvent(type, payload = {}) {
  const evt = {
    type,
    ts: new Date().toISOString(),
    source: "ui/garden",
    data: {
      ...payload,
      domain: "garden",
    },
  };
  try {
    automation?.emit?.("event", evt);
  } catch {}
  try {
    eventBus?.emit?.("event", evt);
  } catch {}
}

/* =============================================================================
   Dexie: Garden Records (Interactive Module)
   ============================================================================= */

/**
 * ✅ UPDATED: Soft-import DB using softImport (required)
 */
async function getDbSafe() {
  const dbMod = await softImport([
    "@/services/db.js",
    "@/services/db",
    "../../services/db.js",
    "../../services/db",
  ]);
  return dbMod?.db ?? dbMod ?? null;
}

function hasTable(db, tableName) {
  try {
    if (!db) return false;
    if (db[tableName]) return true;
    if (Array.isArray(db?.tables))
      return db.tables.some((t) => t?.name === tableName);
    return false;
  } catch {
    return false;
  }
}

async function ensureGardenRecordsTable(db) {
  // If your main DB exists but doesn't have the table, we cannot mutate schema at runtime.
  // In that case we keep using fallback for this module only.
  if (hasTable(db, "gardenRecords")) return { db, table: db.gardenRecords };

  // Create fallback with gardenRecords if main DB doesn't include it.
  try {
    // eslint-disable-next-line global-require
    const Dexie = require("dexie");
    const fallback = new Dexie("suka-ssa-fallback");
    fallback.version(1).stores({
      gardenRecords:
        "id, householdId, type, status, priority, dueDate, createdAt, updatedAt",
    });
    await fallback.open();
    return { db: fallback, table: fallback.gardenRecords };
  } catch (e) {
    console.warn("[garden] ensureGardenRecordsTable failed:", e?.message || e);
    return { db: null, table: null };
  }
}

function defaultHouseholdId() {
  try {
    return (
      localStorage.getItem("suka:householdId") ||
      localStorage.getItem("suka:activeHouseholdId") ||
      ""
    );
  } catch {
    return "";
  }
}

function validateGardenRecordDraft(d) {
  const errors = {};
  const title = normStr(d.title);
  const type = normStr(d.type);
  const dueDate = normStr(d.dueDate);

  if (!title) errors.title = "Title is required.";
  if (!type) errors.type = "Type is required.";
  if (dueDate && !isISODate(dueDate))
    errors.dueDate = "Due date must be YYYY-MM-DD.";

  return errors;
}

function normalizeGardenRecordDraft(d, { householdId }) {
  const now = nowISO();
  const tags = Array.isArray(d.tags) ? d.tags : splitTags(d.tagsInput || "");

  const out = {
    id: d.id || makeId("gr"),
    householdId: householdId || null,
    type: d.type || "task",
    title: normStr(d.title),
    description: normStr(d.description),
    crop: normStr(d.crop),
    variety: normStr(d.variety),
    location: normStr(d.location),
    bed: normStr(d.bed),
    dueDate: normStr(d.dueDate) || null,
    status: d.status || "open",
    priority: d.priority || "med",
    tags,
    meta: d.meta && typeof d.meta === "object" ? d.meta : {},
    completedAt: d.status === "done" ? d.completedAt || now : null,
    archivedAt: d.status === "archived" ? d.archivedAt || now : null,
    createdAt: d.createdAt || now,
    updatedAt: now,
  };

  // enforce status timestamps
  if (out.status !== "done") out.completedAt = null;
  if (out.status !== "archived") out.archivedAt = null;

  return out;
}

/* ------------------------ GardenRecord Modal (Add/Edit) ----------------------- */

function GardenRecordModal({
  open,
  mode, // "create" | "edit"
  initial,
  onClose,
  onSave,
  busy,
  error,
  validationErrors,
  onChangeDraft,
}) {
  if (!open) return null;
  const d = initial || {};

  return (
    <div className="sv-modal" style={{ zIndex: 95 }}>
      <div className="sv-card sv-pad" style={{ width: 720, maxWidth: "94vw" }}>
        <div className="sv-row sv-justify-between sv-align-center">
          <div className="sv-strong" style={{ fontSize: 16 }}>
            {mode === "edit" ? "Edit Garden Record" : "Add Garden Record"}
          </div>
          <button className="btn" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>

        {error ? (
          <div className="sv-card sv-pad" style={{ marginTop: 10 }}>
            <div className="sv-strong">Couldn’t save</div>
            <div className="sv-muted" style={{ marginTop: 6 }}>
              {String(error)}
            </div>
          </div>
        ) : null}

        <div
          style={{
            marginTop: 12,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 12,
          }}
        >
          <Field label="Type">
            <select
              className={FIELD_INPUT_CLASS}
              value={d.type || "task"}
              onChange={(e) => onChangeDraft({ type: e.target.value })}
            >
              <option value="task">Task</option>
              <option value="planting">Planting</option>
              <option value="harvest">Harvest</option>
              <option value="note">Note</option>
            </select>
            {validationErrors?.type ? (
              <div className="sv-caption" style={{ marginTop: 6 }}>
                {validationErrors.type}
              </div>
            ) : null}
          </Field>

          <Field label="Priority">
            <select
              className={FIELD_INPUT_CLASS}
              value={d.priority || "med"}
              onChange={(e) => onChangeDraft({ priority: e.target.value })}
            >
              <option value="low">Low</option>
              <option value="med">Medium</option>
              <option value="high">High</option>
            </select>
          </Field>

          <Field label="Status">
            <select
              className={FIELD_INPUT_CLASS}
              value={d.status || "open"}
              onChange={(e) => onChangeDraft({ status: e.target.value })}
            >
              <option value="open">Open</option>
              <option value="done">Done</option>
              <option value="archived">Archived</option>
            </select>
          </Field>

          <Field label="Due date (optional)" hint="YYYY-MM-DD">
            <input
              className={FIELD_INPUT_CLASS}
              value={d.dueDate || ""}
              onChange={(e) => onChangeDraft({ dueDate: e.target.value })}
              placeholder="2026-03-15"
            />
            {validationErrors?.dueDate ? (
              <div className="sv-caption" style={{ marginTop: 6 }}>
                {validationErrors.dueDate}
              </div>
            ) : null}
          </Field>

          <Field label="Title">
            <input
              className={FIELD_INPUT_CLASS}
              value={d.title || ""}
              onChange={(e) => onChangeDraft({ title: e.target.value })}
              placeholder="e.g., Water Bed 3"
            />
            {validationErrors?.title ? (
              <div className="sv-caption" style={{ marginTop: 6 }}>
                {validationErrors.title}
              </div>
            ) : null}
          </Field>

          <Field label="Crop (optional)">
            <input
              className={FIELD_INPUT_CLASS}
              value={d.crop || ""}
              onChange={(e) => onChangeDraft({ crop: e.target.value })}
              placeholder="e.g., Tomato"
            />
          </Field>

          <Field label="Variety (optional)">
            <input
              className={FIELD_INPUT_CLASS}
              value={d.variety || ""}
              onChange={(e) => onChangeDraft({ variety: e.target.value })}
              placeholder="e.g., Roma"
            />
          </Field>

          <Field label="Location (optional)">
            <input
              className={FIELD_INPUT_CLASS}
              value={d.location || ""}
              onChange={(e) => onChangeDraft({ location: e.target.value })}
              placeholder="e.g., Backyard / Plot A"
            />
          </Field>

          <Field label="Bed (optional)">
            <input
              className={FIELD_INPUT_CLASS}
              value={d.bed || ""}
              onChange={(e) => onChangeDraft({ bed: e.target.value })}
              placeholder="e.g., Bed 3"
            />
          </Field>

          <Field label="Tags (comma-separated)">
            <input
              className={FIELD_INPUT_CLASS}
              value={d.tagsInput || ""}
              onChange={(e) => onChangeDraft({ tagsInput: e.target.value })}
              placeholder="e.g., weekly, drip, greenhouse"
            />
          </Field>

          <Field label="Description (optional)">
            <textarea
              className={FIELD_INPUT_CLASS}
              rows={3}
              value={d.description || ""}
              onChange={(e) => onChangeDraft({ description: e.target.value })}
              placeholder="Add any details, measurements, or constraints…"
            />
          </Field>
        </div>

        <div
          className="sv-row sv-justify-end sv-align-center"
          style={{ gap: 8, marginTop: 12, flexWrap: "wrap" }}
        >
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn primary"
            style={PAD.btn}
            onClick={onSave}
            disabled={busy}
            aria-busy={busy}
          >
            {mode === "edit" ? "Save Changes" : "Add Record"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* =============================================================================
   Torah-aligned, Zone-aware Suggestion Engine (Zone 7B defaults)
   ========================================================================== */

const Z7B_DB = {
  spring: {
    grains: ["barley", "wheat", "oats"],
    legumes: ["peas", "chickpeas", "lentils"],
    greensHerbs: [
      "spinach",
      "kale",
      "lettuce",
      "cilantro",
      "dill",
      "hyssop",
      "mint",
    ],
    veg: ["onions", "garlic", "leeks", "carrots", "beets", "radishes"],
    fruitPrep: ["grapes", "figs", "pomegranates"],
  },
  summer: {
    grains: ["corn"],
    veg: [
      "cucumbers",
      "melons",
      "squash",
      "okra",
      "eggplant",
      "peppers",
      "tomatoes",
      "beans",
    ],
    sevenSpecies: ["grapes", "olives", "figs"],
    herbs: ["basil", "sage", "oregano", "thyme", "rosemary"],
  },
  fall: {
    grains: ["rye", "spelt", "wheat"],
    veg: [
      "cabbage",
      "broccoli",
      "cauliflower",
      "brussels sprouts",
      "turnips",
      "collards",
      "mustard greens",
    ],
  },
  winter: {
    rest: true,
    cover: ["winter rye", "clover", "vetch"],
    hardy: ["spinach", "kale", "collards", "garlic"],
  },
  torah: {
    keepVineyardSeparate: true,
    avoidKilayim: true,
    practiceGleanings: true,
    rotateBeds: true,
    sevenSpecies: [
      "wheat",
      "barley",
      "grapes",
      "figs",
      "pomegranates",
      "olives",
      "dates",
    ],
  },
};

function buildTorahAlignedPlan({ acres = 0.25, zone = "7b", mealHints = {} }) {
  const sqft = Math.max(ACRES_TO_SQFT * acres, 0);

  const alloc = {
    grains: 0.25,
    legumes: 0.15,
    veg: 0.4,
    herbs: 0.1,
    perennials: 0.1,
  };

  const bySqft = Object.fromEntries(
    Object.entries(alloc).map(([k, v]) => [k, Math.round(sqft * v)])
  );

  const BED = 32;
  const beds = [];
  const addBed = (name, areaSqft, crops) =>
    beds.push({ name, areaSqft, crops });

  const mealPull = new Set(
    (mealHints?.focusCrops || [])
      .concat(mealHints?.frequentIngredients || [])
      .map((s) => String(s || "").toLowerCase())
      .filter(Boolean)
  );

  const pickBiased = (list, n) => {
    const uniq = Array.from(new Set(list.map((x) => String(x).toLowerCase())));
    const pulled = uniq.filter((c) => mealPull.has(c));
    const rest = uniq.filter((c) => !mealPull.has(c));
    return [...pulled, ...rest].slice(0, Math.max(1, n));
  };

  const grains = [...Z7B_DB.spring.grains, ...Z7B_DB.fall.grains];
  const legumes = Z7B_DB.spring.legumes.concat("beans");
  const herbs = Array.from(
    new Set([...Z7B_DB.spring.greensHerbs, ...Z7B_DB.summer.herbs])
  );
  const veg = Array.from(
    new Set([...Z7B_DB.spring.veg, ...Z7B_DB.summer.veg, ...Z7B_DB.fall.veg])
  );
  const perennials = Array.from(
    new Set(["grapes", "figs", "pomegranates", "olives"])
  );

  const vegChosen = pickBiased(veg, 6);
  const grainChosen = pickBiased(grains, 3);
  const legumeChosen = pickBiased(legumes, 2);
  const herbChosen = pickBiased(herbs, 5);
  const perennialChosen = pickBiased(perennials, 3);

  const mkBeds = (catName, area, cropsArr) => {
    const bedCount = Math.max(1, Math.round(area / BED));
    const perCrop = Math.max(1, Math.floor(bedCount / cropsArr.length));
    let used = 0;

    cropsArr.forEach((crop, idx) => {
      const nBeds = idx === cropsArr.length - 1 ? bedCount - used : perCrop;
      used += nBeds;
      if (nBeds <= 0) return;
      addBed(`${catName.toUpperCase()} • ${crop}`, nBeds * BED, [
        { name: crop, qty: nBeds },
      ]);
    });
  };

  mkBeds("Grains", bySqft.grains, grainChosen);
  mkBeds("Legumes", bySqft.legumes, legumeChosen);
  mkBeds("Vegetables", bySqft.veg, vegChosen);
  mkBeds("Herbs", bySqft.herbs, herbChosen);

  if (bySqft.perennials > 0 && perennialChosen.length) {
    const hasGrapes = perennialChosen.includes("grapes");
    addBed(
      hasGrapes ? "Vineyard (separate)" : "Perennial Fruit Row",
      Math.max(32, bySqft.perennials),
      perennialChosen.map((c) => ({ name: c, qty: 1 }))
    );
  }

  const restRecommendation = `Rotate categories annually and assign at least one bed to winter cover (e.g., ${Z7B_DB.winter.cover.join(
    ", "
  )}) for land rest. Leave gleanings for community as able.`;

  return {
    zone,
    areaSqft: sqft,
    beds,
    irrigation: "drip",
    compost: 'Top dress 1" compost at spring turn-over',
    torah: Z7B_DB.torah,
    notes: restRecommendation,
  };
}

function buildCalendarEventsFromPlan(plan, { scope, groupId, communityId }) {
  const out = [];
  const base = todayISO();

  const scopeMeta =
    scope === "individual"
      ? { scope: "household" }
      : scope === "group"
      ? { scope: "group", groupId }
      : { scope: "community", communityId };

  (plan.beds || []).forEach((b, i) => {
    const titleCrop = (b.crops?.[0]?.name || "Crop").replace(/\b\w/g, (m) => m);

    out.push({
      title: `Garden • Plant ${titleCrop}`,
      date: addDaysISO(base, i * 2),
      color: "#34d399",
      source: "garden",
      ...scopeMeta,
    });

    if (/tomato|grape|cucumber|beans/.test(titleCrop.toLowerCase())) {
      out.push({
        title: `Garden • Stake/Trellis ${titleCrop}`,
        date: addDaysISO(base, i * 2 + 7),
        color: "#10b981",
        source: "garden",
        ...scopeMeta,
      });
    }

    out.push({
      title: `Garden • Harvest ${titleCrop}`,
      date: addDaysISO(base, 45 + i * 3),
      color: "#059669",
      source: "garden",
      ...scopeMeta,
    });
  });

  return out;
}

/* ---------------------- Maintenance Schedule (Draft) ------------------------- */

function buildMaintenanceSchedule(plan, { waterAccess = "drip" }) {
  const base = todayISO();

  const crops = (plan?.beds || []).flatMap((b) =>
    (b.crops || []).map((c) => String(c.name || "").toLowerCase())
  );

  const hasTomato = crops.some((c) => /tomato/.test(c));
  const hasVines = crops.some((c) => /grape|cucumber|beans/.test(c));
  const hasFruitTreesOrBush = crops.some((c) =>
    /grape|fig|olive|pomegranate/.test(c)
  );
  const hasLeafy = crops.some((c) => /lettuce|spinach|kale|greens/.test(c));
  const hasHeavyFeeders = crops.some((c) =>
    /tomato|corn|cabbage|broccoli|squash|pepper/.test(c)
  );

  const makeSeries = (startISO, stepDays, count) => {
    const arr = [];
    for (let i = 0; i < count; i++)
      arr.push(addDaysISO(startISO, i * stepDays));
    return arr;
  };

  let waterEvery = 2;
  if (waterAccess === "drip") waterEvery = 3;
  if (waterAccess === "limited") waterEvery = 4;

  const watering = {
    title: "Watering",
    cadence: `Every ${waterEvery} day${
      waterEvery > 1 ? "s" : ""
    } (${waterAccess})`,
    notes: "Deep, infrequent watering preferred. Adjust after rainfall.",
    next: makeSeries(base, waterEvery, 6),
  };

  const weedingEvery = 10;
  const weeding = {
    title: "Weeding",
    cadence: `Every ${weedingEvery} days`,
    notes: "Prioritize rows and bed edges; mulch to reduce regrowth.",
    next: makeSeries(addDaysISO(base, 3), weedingEvery, 6),
  };

  const feedEvery = hasHeavyFeeders || hasLeafy ? 21 : 28;
  const feeding = {
    title: "Feeding",
    cadence: hasHeavyFeeders || hasLeafy ? "Every 3 weeks" : "Every 4 weeks",
    notes: hasHeavyFeeders
      ? "Compost tea or balanced organic fertilizer for tomatoes/peppers/corn/brassicas."
      : hasLeafy
      ? "Light compost tea for leafy beds; avoid over-nitrogen for fruiting crops."
      : "General top-dress or compost tea.",
    next: makeSeries(addDaysISO(base, 7), feedEvery, 6),
  };

  const pruningEvery = hasVines || hasTomato || hasFruitTreesOrBush ? 30 : 45;
  const pruning = {
    title: "Pruning / Training",
    cadence: `Every ${pruningEvery} days`,
    notes:
      hasVines || hasTomato
        ? "Sucker tomatoes if indeterminate; train cucumbers/beans; tie grapes to trellis."
        : hasFruitTreesOrBush
        ? "Seasonal structural pruning for fruiting perennials."
        : "Light maintenance; remove diseased/damaged growth.",
    next: makeSeries(addDaysISO(base, 10), pruningEvery, 6),
  };

  return { watering, weeding, feeding, pruning };
}

/* --------------------------- Lightweight Conflict Scan ----------------------- */

function detectPlannerConflicts({
  mode,
  selectedGroupId,
  selectedCommunityId,
  constraints,
  waterAccess,
  soilType,
}) {
  const issues = [];

  if (mode === "group" && !selectedGroupId)
    issues.push({ kind: "time", note: "No group selected" });
  if (mode === "community" && !selectedCommunityId)
    issues.push({ kind: "time", note: "No community garden selected" });

  if (soilType === "unknown")
    issues.push({
      kind: "biohazard",
      note: "Unknown soil type — recommend soil test",
    });

  if (String(constraints).toLowerCase().includes("withhold"))
    issues.push({ kind: "weather", note: "Withhold constraint present" });

  if (waterAccess === "limited")
    issues.push({
      kind: "appliance",
      note: "Limited irrigation; adjust watering cadence",
    });

  return issues;
}

/* ------------------------------ NBA Recommendations -------------------------- */

function computeNBA({ queue, inventoryNeeds, gardenPlan }) {
  const cards = [];

  if (!gardenPlan) {
    cards.push({
      id: "nba-generate-plan",
      title: "Generate a Garden Plan",
      body: "Create a zone-aware, Torah-aligned draft and push dates to your calendar.",
      action: "generatePlan",
    });
  }

  if (gardenPlan && Array.isArray(queue) && queue.length === 0) {
    cards.push({
      id: "nba-sync-tasks",
      title: "Sync Tasks to Queue",
      body: "Accept your draft to populate your garden task queue.",
      action: "acceptAndSync",
    });
  }

  if (Array.isArray(inventoryNeeds) && inventoryNeeds.length > 0) {
    const names = inventoryNeeds
      .slice(0, 3)
      .map((i) => i?.name)
      .filter(Boolean);
    cards.push({
      id: "nba-reorder-seeds",
      title: "Reorder Seeds & Supplies",
      body: `Low inventory detected${
        names.length ? `: ${names.join(", ")}` : ""
      }.`,
      action: "openInventory",
    });
  }

  return cards;
}

/* --------------------------- Swap Modal for “Now” ---------------------------- */

function SessionSwapModal({
  open,
  onClose,
  sessions = [],
  onSelect,
  favoriteSessionIds = [],
  onToggleFavorite,
}) {
  if (!open) return null;
  const total = sessions.length;
  const next = sessions[0];

  return (
    <div className="sv-modal" style={{ zIndex: 90 }}>
      <div className="sv-card sv-pad" style={{ width: 520, maxWidth: "92vw" }}>
        <div
          className="sv-row sv-justify-between sv-align-center"
          style={{ marginBottom: 8 }}
        >
          <div className="sv-strong">Start Garden Session Now</div>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div
          className="sv-stack-sm"
          style={{
            background: "linear-gradient(180deg,#0a2b19,rgba(0,0,0,0.15))",
            borderRadius: 16,
            padding: 16,
          }}
        >
          <div className="sv-row sv-justify-between sv-align-center">
            <div className="sv-muted">You’re starting</div>
            <div className="sv-badge">
              {total} session{total === 1 ? "" : "s"} available
            </div>
          </div>
          <div className="sv-row sv-align-end" style={{ gap: 8 }}>
            <div className="sv-display">{total}</div>
            <div className="sv-muted">runnable</div>
          </div>
          {next ? (
            <div className="sv-caption">
              Next up: <span className="sv-strong">{next.title}</span> •{" "}
              {next.steps?.length ?? 0} steps
            </div>
          ) : null}
        </div>

        <div
          className="sv-stack"
          style={{ marginTop: 12, maxHeight: 260, overflow: "auto" }}
        >
          {sessions.map((s) => {
            const isFav = favoriteSessionIds.includes(s.id);
            return (
              <div
                key={s.id}
                className="sv-row sv-justify-between sv-align-center sv-card sv-pad"
                style={{ borderRadius: 12 }}
              >
                <div>
                  <div
                    className="sv-strong"
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    {s.title || "Garden Session"}
                    <button
                      type="button"
                      className="btn xs"
                      title={
                        isFav ? "Remove from favorites" : "Save as favorite"
                      }
                      onClick={() => onToggleFavorite && onToggleFavorite(s)}
                    >
                      {isFav ? "★" : "☆"}
                    </button>
                  </div>
                  <div className="sv-muted sv-text-sm">
                    {s?.steps?.length ?? 0} steps •{" "}
                    {s?.prefs?.voiceGuidance ? "Voice" : "Silent"} •{" "}
                    {s?.progress?.startedAt ? "Resume" : "Fresh"}
                  </div>
                </div>
                <button className="btn primary" onClick={() => onSelect(s)}>
                  Start
                </button>
              </div>
            );
          })}
          {!sessions.length && (
            <div className="sv-muted">No saved sessions found.</div>
          )}
        </div>

        <div className="sv-row sv-justify-end" style={{ marginTop: 12 }}>
          <button
            className="btn primary"
            onClick={() => (sessions[0] ? onSelect(sessions[0]) : onClose())}
          >
            Start Selected
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Fallback “quick” plan ------------------------- */

function makeQuickGardenFallback() {
  const id = `garden_quick_${Date.now()}`;
  const steps = [
    {
      id: `${id}_walk`,
      title: "Walk beds & inspect",
      desc: "Check moisture, pests, disease; note issues.",
      durationSec: 8 * 60,
      blockers: ["weather", "quietHours", "sabbath", "equipment"],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes: "Use timer as cadence; log findings.",
      },
    },
    {
      id: `${id}_weed`,
      title: "Weed edges & rows",
      desc: "Focus on bed borders and heavy weed spots.",
      durationSec: 12 * 60,
      blockers: ["weather", "quietHours", "sabbath", "equipment"],
      metadata: { tempTargetF: 0, donenessCue: "timer", cueNotes: "" },
    },
    {
      id: `${id}_water`,
      title: "Water deeply",
      desc: "Water by zone; prioritize new plantings and containers.",
      durationSec: 10 * 60,
      blockers: ["weather", "quietHours", "sabbath", "equipment"],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes: "Adjust if rain today.",
      },
    },
  ];

  return {
    id,
    title: "Quick Garden Session",
    steps,
    metrics: { estMinutes: 30 },
    preferences: {},
    draftType: "garden",
  };
}

/* -------------------- Artifact + StepGraph helpers (Option 3) ---------------- */

async function loadReadyGardenArtifacts() {
  if (!GardenArtifactRepo) return [];
  try {
    if (typeof GardenArtifactRepo.getReadyArtifacts === "function") {
      const res = await GardenArtifactRepo.getReadyArtifacts({
        domain: "garden",
      });
      return Array.isArray(res) ? res : [];
    }

    if (typeof GardenArtifactRepo.list === "function") {
      const res = await GardenArtifactRepo.list({
        domain: "garden",
        status: "ready",
      });
      const arr = Array.isArray(res) ? res : [];
      return arr.filter(
        (a) =>
          a?.status === "ready" ||
          a?.compliant === true ||
          a?.isCompliant === true
      );
    }

    return [];
  } catch (err) {
    console.warn(
      "[garden] loadReadyGardenArtifacts failed:",
      err?.message || err
    );
    return [];
  }
}

function artifactToStepGraph(artifact) {
  if (!artifact) return null;
  const baseId =
    artifact.id ||
    artifact.slug ||
    `artifact_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2)}`;
  const baseLabel = artifact.title || artifact.name || "Garden Artifact";

  const priority =
    typeof artifact.priority === "number" ? artifact.priority : 10;

  let rawSteps = [];
  if (Array.isArray(artifact.stepGraph?.steps))
    rawSteps = artifact.stepGraph.steps;
  else if (Array.isArray(artifact.steps)) rawSteps = artifact.steps;

  const steps = rawSteps.map((s, idx) => ({
    id:
      s.id ||
      `${baseId}_step_${idx + 1}_${Math.random().toString(36).slice(2)}`,
    title: s.title || s.name || `Garden Step ${idx + 1}`,
    desc: s.desc || s.description || "",
    durationSec:
      typeof s.durationSec === "number"
        ? s.durationSec
        : typeof s.estimateSec === "number"
        ? s.estimateSec
        : 5 * 60,
    blockers:
      Array.isArray(s.blockers) && s.blockers.length
        ? s.blockers
        : ["weather", "quietHours", "sabbath", "equipment"],
    metadata: {
      ...s.metadata,
      sourceArtifactId: artifact.id || null,
      sourceArtifactType: artifact.type || artifact.kind || "garden",
    },
  }));

  if (!steps.length) return null;

  return { id: baseId, label: baseLabel, priority, steps };
}

function mergeStepGraphs(graphs) {
  const sorted = [...graphs].sort(
    (a, b) => (a.priority ?? 10) - (b.priority ?? 10)
  );
  const mergedSteps = [];
  sorted.forEach((g) => {
    (g.steps || []).forEach((step) =>
      mergedSteps.push({ ...step, sourceGraphId: g.id })
    );
  });
  return {
    id: `garden_composite_${Date.now()}`,
    label: "Composite Garden Session",
    steps: mergedSteps,
  };
}

/* =============================================================================
   Session building (Plan / Artifacts / Merge)
   ========================================================================== */

function stepsFromPlan(
  plan,
  draft,
  { waterAccess, mode, selectedGroupId, selectedCommunityId } = {}
) {
  if (!plan) return [];
  const steps = [];
  const baseId = `plan_${Date.now().toString(36)}`;

  // 1) quick inspection first
  steps.push({
    id: `${baseId}_inspect`,
    title: "Inspect beds & note issues",
    desc: "Walk beds; check pests, wilt, moisture; record any issues.",
    durationSec: 8 * 60,
    blockers: ["weather", "quietHours", "sabbath"],
    metadata: { source: "garden.plan", kind: "inspect" },
  });

  // 2) bed work: plant / prep per bed
  (plan.beds || []).slice(0, 12).forEach((b, idx) => {
    const crop = b?.crops?.[0]?.name || "crop";
    const label = String(crop).replace(/\b\w/g, (m) => m);
    const est = Math.max(6, Math.min(25, Math.round((b.areaSqft || 32) / 10)));
    steps.push({
      id: `${baseId}_bed_${idx + 1}`,
      title: `Bed work • ${label}`,
      desc: `Prep/plant/maintain: ${
        b.name || label
      }. Follow spacing & mulch; log progress.`,
      durationSec: est * 60,
      blockers: ["weather", "quietHours", "sabbath", "equipment"],
      metadata: {
        source: "garden.plan",
        kind: "bed",
        bedName: b.name || "",
        crop: crop,
      },
    });
  });

  // 3) maintenance cadence snapshot as a single action block
  const sched = draft?.schedules || null;
  if (sched?.watering?.cadence) {
    steps.push({
      id: `${baseId}_maintenance`,
      title: "Maintenance cadence (set & commit)",
      desc: `Water: ${sched.watering.cadence}. Weed: ${
        sched.weeding?.cadence || "—"
      }. Feed: ${sched.feeding?.cadence || "—"}.`,
      durationSec: 6 * 60,
      blockers: ["quietHours", "sabbath"],
      metadata: { source: "garden.plan", kind: "schedule" },
    });
  }

  // 4) watering action now
  const waterMinutes =
    waterAccess === "limited" ? 14 : waterAccess === "drip" ? 10 : 12;
  steps.push({
    id: `${baseId}_water_now`,
    title: "Water (today)",
    desc: "Deep watering pass; prioritize new plantings and containers.",
    durationSec: waterMinutes * 60,
    blockers: ["weather", "quietHours", "sabbath", "equipment"],
    metadata: {
      source: "garden.plan",
      kind: "water",
      waterAccess: waterAccess || "drip",
    },
  });

  // scope tags
  const scope =
    mode === "group"
      ? { scope: "group", groupId: selectedGroupId || null }
      : mode === "community"
      ? { scope: "community", communityId: selectedCommunityId || null }
      : { scope: "household" };

  return steps.map((s) => ({
    ...s,
    metadata: { ...(s.metadata || {}), ...scope },
  }));
}

function stepsFromArtifacts(compositeGraph) {
  const steps = (compositeGraph?.steps || []).map((s, idx) => ({
    id: s.id || makeId(`art_step_${idx + 1}`),
    title: s.title || `Garden Step ${idx + 1}`,
    desc: s.desc || "",
    durationSec: typeof s.durationSec === "number" ? s.durationSec : 5 * 60,
    blockers: Array.isArray(s.blockers)
      ? s.blockers
      : ["weather", "quietHours", "sabbath", "equipment"],
    metadata: { ...(s.metadata || {}), source: "garden.artifact" },
  }));
  return steps;
}

function mergeSteps(planSteps, artifactSteps) {
  const out = [];
  const seen = new Set();

  const push = (step) => {
    const key =
      step?.id ||
      `${normStr(step?.title).toLowerCase()}|${normStr(
        step?.desc
      ).toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(step);
  };

  (artifactSteps || []).forEach(push);
  (planSteps || []).forEach(push);

  return out;
}

function buildSessionObject({ title, steps, meta }) {
  const id = makeId("sess_garden");
  const estMinutes = Math.max(
    1,
    Math.round((steps || []).reduce((s, x) => s + (x.durationSec || 0), 0) / 60)
  );

  return {
    id,
    domain: "garden",
    title: title || "Garden Session",
    steps: Array.isArray(steps) ? steps : [],
    createdAt: nowISO(),
    updatedAt: nowISO(),
    progress: { currentStepIndex: 0, startedAt: null, completedAt: null },
    prefs: { voiceGuidance: true, ...meta?.prefs },
    metadata: meta || {},
    metrics: { estMinutes },
    status: "runnable",
  };
}

async function upsertSessionSafe(session) {
  // SessionsRepo preferred
  if (SessionsRepo?.upsert) {
    await SessionsRepo.upsert(session);
    return session.id;
  }

  // fallback: localStorage sessions stash (keeps page functional)
  try {
    const key = "suka:sessions.fallback.v1";
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    const next = Array.isArray(arr) ? arr : [];
    const idx = next.findIndex((s) => s?.id === session.id);
    if (idx >= 0) next[idx] = session;
    else next.unshift(session);
    localStorage.setItem(key, JSON.stringify(next.slice(0, 200)));
  } catch {}
  return session.id;
}

async function getRunnableSafe() {
  if (SessionsRepo?.getRunnable) {
    const list = await SessionsRepo.getRunnable({ domain: "garden" });
    return Array.isArray(list) ? list : [];
  }
  // fallback to localStorage stash
  try {
    const key = "suka:sessions.fallback.v1";
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(arr) ? arr : [];
    return list.filter(
      (s) => s?.domain === "garden" && s?.status !== "archived"
    );
  } catch {
    return [];
  }
}

async function openRunnerSafe({ sessionId }) {
  if (typeof openRunner === "function") {
    openRunner({ sessionId, sticky: true });
    return;
  }
  // minimal fallback: emit event; host app may listen and open runner
  emitEvent("runner.open.requested", { sessionId, sticky: true });
}

/* =============================================================================
   Garden Page — 3 modes + Draft schedules + NBA strip + “Now” session flow
   ========================================================================== */

export default function GardenDashboard() {
  const { addEvent } = useHouseholdCalendar();
  const { groups, communityGardens } = useGardenGroupStore();

  const initialInputs = useMemo(() => loadPlannerInputs(), []);

  const [mode, setMode] = useState(
    () =>
      initialInputs.mode ||
      localStorage.getItem("suka:gardenMode") ||
      "individual"
  );

  const [selectedGroupId, setSelectedGroupId] = useState(
    initialInputs.selectedGroupId || ""
  );
  const [selectedCommunityId, setSelectedCommunityId] = useState(
    initialInputs.selectedCommunityId || ""
  );

  const [householdSize, setHouseholdSize] = useState(
    initialInputs.householdSize ?? 4
  );
  const [landArea, setLandArea] = useState(initialInputs.landArea ?? "0.25");
  const [usdaZone, setUsdaZone] = useState(initialInputs.usdaZone ?? "7b");
  const [waterAccess, setWaterAccess] = useState(
    initialInputs.waterAccess ?? "drip"
  );
  const [soilType, setSoilType] = useState(initialInputs.soilType ?? "loam");
  const [outputsWanted, setOutputsWanted] = useState(
    Array.isArray(initialInputs.outputsWanted)
      ? initialInputs.outputsWanted
      : ["veg", "fruit", "herbs"]
  );
  const [constraints, setConstraints] = useState(
    initialInputs.constraints ?? ""
  );
  const [notes, setNotes] = useState(initialInputs.notes ?? "");

  const [cropPickerOpen, setCropPickerOpen] = useState(false);
  const [selectedCrops, setSelectedCrops] = useState(
    Array.isArray(initialInputs.selectedCrops)
      ? initialInputs.selectedCrops
      : []
  );

  const [sessionSource, setSessionSource] = useState(
    initialInputs.sessionSource || "plan"
  );

  const [gardenPlan, setGardenPlan] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [lastOutput, setLastOutput] = useState(null);

  const [queue, setQueue] = useState([]);
  const [inventoryNeeds, setInventoryNeeds] = useState([]);
  const [reminders, setReminders] = useState([]);

  const mealHintsRef = useRef({ focusCrops: [], frequentIngredients: [] });

  const [storehouseSections, setStorehouseSections] = useState([]);
  const [animalButcheryWindows, setAnimalButcheryWindows] = useState([]);
  const [cleaningZones, setCleaningZones] = useState([]);

  const [conflictCount, setConflictCount] = useState(0);
  const [shortages, setShortages] = useState({
    total: 0,
    pantry: 0,
    cleaning: 0,
    hygiene: 0,
    animal: 0,
    garden: 0,
  });

  /* =============================================================================
     Garden Records (Interactive CRUD state model)
     ========================================================================== */
  const [householdId] = useState(() => defaultHouseholdId());

  const [grDb, setGrDb] = useState(null);
  const [grTable, setGrTable] = useState(null);

  const [records, setRecords] = useState([]);
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [recordsError, setRecordsError] = useState(null);

  const [grQuery, setGrQuery] = useState("");
  const [grType, setGrType] = useState("all"); // all|task|planting|harvest|note
  const [grStatus, setGrStatus] = useState("open"); // open|done|archived|all
  const [grPriority, setGrPriority] = useState("all"); // all|low|med|high
  const [grSort, setGrSort] = useState("dueDate"); // dueDate|updatedAt|createdAt

  const [grModalOpen, setGrModalOpen] = useState(false);
  const [grModalMode, setGrModalMode] = useState("create");
  const [grDraft, setGrDraft] = useState(null);
  const [grValidation, setGrValidation] = useState({});
  const [grMutateBusy, setGrMutateBusy] = useState(false);
  const [grMutateError, setGrMutateError] = useState(null);

  // init DB/table for gardenRecords (soft + fallback)
  useEffect(() => {
    (async () => {
      try {
        const db = await getDbSafe();
        const ensured = await ensureGardenRecordsTable(db);
        setGrDb(ensured.db || null);
        setGrTable(ensured.table || null);
      } catch (e) {
        setGrDb(null);
        setGrTable(null);
      }
    })();
  }, []);

  // load + seed
  useEffect(() => {
    (async () => {
      setRecordsLoading(true);
      setRecordsError(null);
      try {
        if (!grTable) {
          setRecords([]);
          setRecordsLoading(false);
          return;
        }

        const all = await grTable.toArray();
        const filtered = Array.isArray(all)
          ? all.filter((r) =>
              householdId ? r.householdId === householdId : true
            )
          : [];

        // seed on first-run (only if empty)
        if (!filtered.length) {
          const seed = [
            {
              id: makeId("gr"),
              householdId: householdId || null,
              type: "task",
              title: "Water seed starts",
              description: "Check trays; deep water if top is dry.",
              crop: "",
              variety: "",
              location: "Indoor / Seed rack",
              bed: "",
              dueDate: todayISO(),
              status: "open",
              priority: "med",
              tags: ["weekly"],
              meta: { seededBy: "garden.page.seed" },
              completedAt: null,
              archivedAt: null,
              createdAt: nowISO(),
              updatedAt: nowISO(),
            },
            {
              id: makeId("gr"),
              householdId: householdId || null,
              type: "note",
              title: "Soil test reminder",
              description: "Consider soil test for new beds.",
              crop: "",
              variety: "",
              location: "Backyard",
              bed: "",
              dueDate: addDaysISO(todayISO(), 7),
              status: "open",
              priority: "low",
              tags: ["planning"],
              meta: { seededBy: "garden.page.seed" },
              completedAt: null,
              archivedAt: null,
              createdAt: nowISO(),
              updatedAt: nowISO(),
            },
          ];

          // optimistic insert then persist
          setRecords(seed);
          await grTable.bulkPut(seed);

          emitEvent("garden.record.created", {
            householdId: householdId || null,
            optimistic: false,
            reason: "seed",
            record: seed[0],
          });
          emitEvent("garden.record.created", {
            householdId: householdId || null,
            optimistic: false,
            reason: "seed",
            record: seed[1],
          });

          setRecordsLoading(false);
          return;
        }

        setRecords(filtered);
        setRecordsLoading(false);

        // optional: live updates if Dexie supports hooks
        try {
          if (grDb?.on?.("changes")) {
            // leave unmanaged; many apps already have global liveQuery; we keep it simple
          }
        } catch {}
      } catch (e) {
        setRecordsError(e?.message || String(e));
        setRecordsLoading(false);
      }
    })();
  }, [grTable, householdId, grDb]);

  const recordCounts = useMemo(() => {
    const c = { open: 0, done: 0, archived: 0, total: 0 };
    (records || []).forEach((r) => {
      c.total += 1;
      if (r?.status === "open") c.open += 1;
      if (r?.status === "done") c.done += 1;
      if (r?.status === "archived") c.archived += 1;
    });
    return c;
  }, [records]);

  const visibleRecords = useMemo(() => {
    const q = normStr(grQuery).toLowerCase();
    const type = grType;
    const status = grStatus;
    const priority = grPriority;

    const matches = (r) => {
      if (!r) return false;
      if (type !== "all" && r.type !== type) return false;
      if (priority !== "all" && r.priority !== priority) return false;
      if (status !== "all" && r.status !== status) return false;

      if (!q) return true;

      const hay = [
        r.title,
        r.description,
        r.crop,
        r.variety,
        r.location,
        r.bed,
        ...(Array.isArray(r.tags) ? r.tags : []),
      ]
        .map((x) => String(x || "").toLowerCase())
        .join(" • ");

      return hay.includes(q);
    };

    const list = (records || []).filter(matches);

    const byDateDesc = (a, b, key) => {
      const ax = a?.[key] || "";
      const bx = b?.[key] || "";
      if (!ax && bx) return 1;
      if (ax && !bx) return -1;
      return String(bx).localeCompare(String(ax));
    };

    const sorted = [...list].sort((a, b) => {
      if (grSort === "dueDate") {
        const ad = a?.dueDate || "9999-99-99";
        const bd = b?.dueDate || "9999-99-99";
        return String(ad).localeCompare(String(bd));
      }
      if (grSort === "createdAt") return byDateDesc(a, b, "createdAt");
      return byDateDesc(a, b, "updatedAt");
    });

    return sorted;
  }, [records, grQuery, grType, grStatus, grPriority, grSort]);

  const openCreateRecord = () => {
    setGrMutateError(null);
    setGrValidation({});
    setGrModalMode("create");
    setGrDraft({
      type: "task",
      title: "",
      description: "",
      crop: "",
      variety: "",
      location: "",
      bed: "",
      dueDate: "",
      status: "open",
      priority: "med",
      tagsInput: "",
      meta: {},
    });
    setGrModalOpen(true);
  };

  const openEditRecord = (r) => {
    if (!r) return;
    setGrMutateError(null);
    setGrValidation({});
    setGrModalMode("edit");
    setGrDraft({
      ...safeJsonClone(r),
      tagsInput: Array.isArray(r.tags) ? r.tags.join(", ") : "",
    });
    setGrModalOpen(true);
  };

  const closeRecordModal = () => {
    setGrModalOpen(false);
    setGrDraft(null);
    setGrValidation({});
    setGrMutateError(null);
  };

  const persistRecordUpsert = async (normalized, { previous, optimistic }) => {
    if (!grTable) throw new Error("gardenRecords table unavailable.");
    await grTable.put(normalized);

    emitEvent(
      grModalMode === "edit"
        ? "garden.record.updated"
        : "garden.record.created",
      {
        householdId: householdId || null,
        optimistic: !!optimistic,
        record: normalized,
        previous: previous || null,
        patch:
          previous && previous.id === normalized.id
            ? {
                status: normalized.status,
                title: normalized.title,
                dueDate: normalized.dueDate,
                updatedAt: normalized.updatedAt,
              }
            : null,
      }
    );

    await exportToHubIfEnabled({
      type: "garden.record.upserted",
      domain: "garden",
      source: "garden-page",
      data: { record: normalized },
    });
  };

  const saveRecordFromModal = async () => {
    setGrMutateError(null);

    const errors = validateGardenRecordDraft(grDraft || {});
    setGrValidation(errors);
    if (Object.keys(errors).length) return;

    const normalized = normalizeGardenRecordDraft(grDraft || {}, {
      householdId,
    });

    setGrMutateBusy(true);
    const prevRecords = records;
    const prev = records.find((x) => x.id === normalized.id) || null;

    setRecords((cur) => {
      const exists = cur.some((x) => x.id === normalized.id);
      const next = exists
        ? cur.map((x) => (x.id === normalized.id ? normalized : x))
        : [normalized, ...cur];
      return next;
    });

    try {
      await persistRecordUpsert(normalized, {
        previous: prev,
        optimistic: true,
      });
      setGrMutateBusy(false);
      closeRecordModal();
    } catch (e) {
      setRecords(prevRecords);
      setGrMutateBusy(false);
      setGrMutateError(e?.message || String(e));
    }
  };

  const markRecordDone = async (r) => {
    if (!r?.id) return;
    const prevRecords = records;
    const previous = safeJsonClone(r);

    const next = {
      ...r,
      status: "done",
      completedAt: r.completedAt || nowISO(),
      archivedAt: null,
      updatedAt: nowISO(),
    };

    setRecords((cur) => cur.map((x) => (x.id === r.id ? next : x)));

    try {
      if (!grTable) throw new Error("gardenRecords table unavailable.");
      await grTable.put(next);
      emitEvent("garden.record.updated", {
        householdId: householdId || null,
        optimistic: false,
        record: next,
        previous,
        patch: { status: "done", completedAt: next.completedAt },
      });
    } catch (e) {
      setRecords(prevRecords);
      emitEvent("garden.record.update_failed", {
        householdId: householdId || null,
        error: e?.message || String(e),
        record: next,
      });
    }
  };

  const reopenRecord = async (r) => {
    if (!r?.id) return;
    const prevRecords = records;
    const previous = safeJsonClone(r);

    const next = {
      ...r,
      status: "open",
      completedAt: null,
      archivedAt: null,
      updatedAt: nowISO(),
    };

    setRecords((cur) => cur.map((x) => (x.id === r.id ? next : x)));

    try {
      if (!grTable) throw new Error("gardenRecords table unavailable.");
      await grTable.put(next);
      emitEvent("garden.record.updated", {
        householdId: householdId || null,
        optimistic: false,
        record: next,
        previous,
        patch: { status: "open" },
      });
    } catch (e) {
      setRecords(prevRecords);
      emitEvent("garden.record.update_failed", {
        householdId: householdId || null,
        error: e?.message || String(e),
        record: next,
      });
    }
  };

  const archiveRecord = async (r) => {
    if (!r?.id) return;
    const prevRecords = records;
    const previous = safeJsonClone(r);

    const next = {
      ...r,
      status: "archived",
      archivedAt: r.archivedAt || nowISO(),
      updatedAt: nowISO(),
    };

    setRecords((cur) => cur.map((x) => (x.id === r.id ? next : x)));

    try {
      if (!grTable) throw new Error("gardenRecords table unavailable.");
      await grTable.put(next);
      emitEvent("garden.record.archived", {
        householdId: householdId || null,
        optimistic: false,
        record: next,
        previous,
      });
    } catch (e) {
      setRecords(prevRecords);
      emitEvent("garden.record.archive_failed", {
        householdId: householdId || null,
        error: e?.message || String(e),
        record: next,
      });
    }
  };

  const restoreRecord = async (r) => {
    if (!r?.id) return;
    const prevRecords = records;
    const previous = safeJsonClone(r);

    const next = {
      ...r,
      status: "open",
      archivedAt: null,
      updatedAt: nowISO(),
    };

    setRecords((cur) => cur.map((x) => (x.id === r.id ? next : x)));

    try {
      if (!grTable) throw new Error("gardenRecords table unavailable.");
      await grTable.put(next);
      emitEvent("garden.record.restored", {
        householdId: householdId || null,
        optimistic: false,
        record: next,
        previous,
      });
    } catch (e) {
      setRecords(prevRecords);
      emitEvent("garden.record.restore_failed", {
        householdId: householdId || null,
        error: e?.message || String(e),
        record: next,
      });
    }
  };

  const hardDeleteRecord = async (r) => {
    if (!r?.id) return;
    const prevRecords = records;
    const previous = safeJsonClone(r);

    setRecords((cur) => cur.filter((x) => x.id !== r.id));

    try {
      if (!grTable) throw new Error("gardenRecords table unavailable.");
      await grTable.delete(r.id);
      emitEvent("garden.record.deleted", {
        householdId: householdId || null,
        optimistic: false,
        record: null,
        previous,
      });
    } catch (e) {
      setRecords(prevRecords);
      emitEvent("garden.record.delete_failed", {
        householdId: householdId || null,
        error: e?.message || String(e),
        previous,
      });
    }
  };

  /* =============================================================================
     Existing planner state persistence
     ========================================================================== */
  useEffect(() => {
    const snapshot = {
      mode,
      selectedGroupId,
      selectedCommunityId,
      householdSize,
      landArea,
      usdaZone,
      waterAccess,
      soilType,
      outputsWanted,
      constraints,
      notes,
      selectedCrops,
      sessionSource,
    };
    savePlannerInputs(snapshot);
    emitEvent("prefs.updated", { kind: "garden.planner", snapshot });
  }, [
    mode,
    selectedGroupId,
    selectedCommunityId,
    householdSize,
    landArea,
    usdaZone,
    waterAccess,
    soilType,
    outputsWanted,
    constraints,
    notes,
    selectedCrops,
    sessionSource,
  ]);

  const [favoriteTemplates, setFavoriteTemplates] = useState(() =>
    loadFavoriteTemplates()
  );
  const [favoriteSessionIds, setFavoriteSessionIds] = useState(() => {
    const fromTemplates = loadFavoriteTemplates()
      .filter((t) => t.kind === "session" && t.sessionId)
      .map((t) => t.sessionId);
    return Array.from(new Set(fromTemplates));
  });

  const [runnable, setRunnable] = useState([]);
  const [swapOpen, setSwapOpen] = useState(false);

  const cropCatalog = useMemo(
    () => ({
      Tomato: {
        category: "veg",
        spacingInches: { inRow: 18, betweenRow: 24 },
        seedsPerPlant: 1,
        seedOverplantPct: 15,
      },
      Lettuce: {
        category: "veg",
        plantsPerSqft: 4,
        seedsPerPlant: 1,
        seedOverplantPct: 20,
      },
      Cucumber: {
        category: "veg",
        spacingInches: { inRow: 12, betweenRow: 36 },
      },
      Basil: { category: "herb", plantsPerSqft: 1.5 },
      Pepper: { category: "veg", spacingInches: { inRow: 18, betweenRow: 24 } },
      Carrot: {
        category: "veg",
        plantsPerSqft: 16,
        seedsPerPlant: 1,
        seedOverplantPct: 10,
      },
    }),
    []
  );

  useEffect(() => {
    (async () => {
      const [q, low, rem] = await Promise.all([
        getQueueSafe(),
        InventoryMonitor?.getLowGardenInventory?.() ?? [],
        ReminderManager?.getGardenReminders?.() ?? [],
      ]);
      setQueue(Array.isArray(q) ? q : []);
      setInventoryNeeds(Array.isArray(low) ? low : []);
      setReminders(Array.isArray(rem) ? rem : []);
    })();
  }, []);

  const refreshRunnable = async () => {
    try {
      const list = await getRunnableSafe();
      setRunnable(Array.isArray(list) ? list : []);
    } catch {
      setRunnable([]);
    }
  };

  useEffect(() => {
    refreshRunnable();
    const offs = [
      eventBus.on?.("session.started", refreshRunnable),
      eventBus.on?.("session.completed", refreshRunnable),
      eventBus.on?.("session.aborted", refreshRunnable),
      eventBus.on?.("session.saved", refreshRunnable),
    ].filter(Boolean);

    return () =>
      offs.forEach((off) => {
        try {
          off?.();
        } catch {}
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("suka:gardenMode", mode);
    } catch {}
  }, [mode]);

  useEffect(() => {
    const offs = [];

    if (typeof automation?.on === "function") {
      offs.push(
        automation.on("meal/planGenerated", ({ res }) => {
          try {
            if (!res) return;
            const names = [];
            (res.meals || []).forEach((m) => {
              const s = String(m?.name || m).toLowerCase();
              if (
                /tomato|basil|pepper|onion|garlic|cucumber|squash|okra|bean/.test(
                  s
                )
              )
                names.push(s);
            });
            (res.shoppingList || []).forEach((it) => {
              const s = String(it?.name || it).toLowerCase();
              if (
                /tomato|basil|pepper|onion|garlic|cucumber|squash|okra|bean|lettuce|spinach|kale/.test(
                  s
                )
              )
                names.push(s);
            });
            mealHintsRef.current = {
              focusCrops: Array.from(new Set(names)),
              frequentIngredients: [],
            };
            localStorage.setItem(
              "suka:mealHints",
              JSON.stringify(mealHintsRef.current)
            );
          } catch {}
        })
      );

      offs.push(
        automation.on("storehouse/planGenerated", ({ res }) => {
          try {
            const sections =
              (res?.sections || res?.grocerySections || [])
                .map((s) => String(s?.name || s).trim())
                .filter(Boolean) || [];
            if (sections.length)
              setStorehouseSections(Array.from(new Set(sections)));
          } catch {}
        })
      );

      offs.push(
        automation.on("animals/stocking.estimate.completed", ({ res }) => {
          try {
            const windows = res?.butcheryWindows || res?.harvestWindows || [];
            const normalized = windows
              .map((w) => {
                if (typeof w === "string") return w;
                if (w?.label) return w.label;
                if (w?.month) return `Month ${w.month}`;
                return null;
              })
              .filter(Boolean);
            if (normalized.length)
              setAnimalButcheryWindows(Array.from(new Set(normalized)));
          } catch {}
        })
      );

      offs.push(
        automation.on("cleaning/zonePlanGenerated", ({ res }) => {
          try {
            const zones =
              (res?.zones || [])
                .map((z) => String(z?.name || z).trim())
                .filter(Boolean) || [];
            if (zones.length) setCleaningZones(Array.from(new Set(zones)));
          } catch {}
        })
      );
    }

    try {
      const cached = JSON.parse(
        localStorage.getItem("suka:mealHints") || "null"
      );
      if (cached && typeof cached === "object") mealHintsRef.current = cached;
    } catch {}

    return () => {
      offs.forEach((off) => {
        try {
          off?.();
        } catch {}
      });
    };
  }, []);

  useEffect(() => {
    const offA = eventBus.on?.("planner.conflict.detected", () =>
      setConflictCount((n) => Math.min(99, n + 1))
    );

    const offB = eventBus.on?.("supplies.shortages.update", (payload) => {
      const list = Array.isArray(payload?.items) ? payload.items : [];
      const counters = {
        total: 0,
        pantry: 0,
        cleaning: 0,
        hygiene: 0,
        animal: 0,
        garden: 0,
      };
      for (const r of list) {
        counters.total += 1;
        if (r?.domain && counters[r.domain] !== undefined)
          counters[r.domain] += 1;
      }
      setShortages(counters);
    });

    return () => {
      try {
        offA?.();
      } catch {}
      try {
        offB?.();
      } catch {}
    };
  }, []);

  const markComplete = async (taskId) => {
    await completeTaskSafe(taskId);
    setQueue(await getQueueSafe());
    emitEvent("prep.tasks.requested", { params: { reason: "task_completed" } });
    emitEvent("nba.updated", { reason: "garden_task_completed" });
  };

  const estimateGardenPlan = async () => {
    setBusy(true);
    setOk(false);
    setLastOutput(null);

    const conflicts = detectPlannerConflicts({
      mode,
      selectedGroupId,
      selectedCommunityId,
      constraints,
      waterAccess,
      soilType,
    });
    if (conflicts.length) {
      conflicts.forEach((c) =>
        emitEvent("planner.conflict.detected", { kind: c.kind, note: c.note })
      );
    }

    try {
      const plan = buildTorahAlignedPlan({
        acres: Number(landArea) || 0,
        zone: String(usdaZone || "7b").toLowerCase(),
        mealHints: mealHintsRef.current,
      });

      if (selectedCrops.length > 0) {
        const note =
          `User selected ${selectedCrops.length} crop(s): ` +
          selectedCrops
            .map((c) => (c.variety ? `${c.name} (${c.variety})` : c.name))
            .join(", ");
        plan.notes = plan.notes ? `${plan.notes} • ${note}` : note;
      }

      const extraNotes = [];
      if (storehouseSections.length) {
        extraNotes.push(
          `Prioritize crops that keep your ${storehouseSections.join(
            ", "
          )} sections full (pantry + freezer staples).`
        );
      }
      if (animalButcheryWindows.length) {
        extraNotes.push(
          `Try to stack big harvest weeks near your animal butchery windows: ${animalButcheryWindows.join(
            ", "
          )} for smoother preservation days.`
        );
      }
      if (cleaningZones.length) {
        extraNotes.push(
          `Pair heavy harvest days with cleaning sessions in ${cleaningZones.join(
            ", "
          )} so kitchen & mudroom reset quickly.`
        );
      }
      if (extraNotes.length) {
        plan.notes = plan.notes
          ? `${plan.notes} • ${extraNotes.join(" • ")}`
          : extraNotes.join(" • ");
      }

      const calEvents = buildCalendarEventsFromPlan(plan, {
        scope: mode,
        groupId: mode === "group" ? selectedGroupId || null : null,
        communityId: mode === "community" ? selectedCommunityId || null : null,
      });

      calEvents.forEach((ev) => addEvent?.(ev));

      const schedules = buildMaintenanceSchedule(plan, { waterAccess });

      setGardenPlan(plan);
      setDraft({
        summary: {
          scope: mode,
          groupId: selectedGroupId || null,
          communityId: selectedCommunityId || null,
          areaSqft: Math.round(plan.areaSqft),
          zone: plan.zone,
          irrigation: plan.irrigation,
        },
        schedules,
      });

      setLastOutput({
        via: "local-suggester",
        plan,
        events: calEvents,
        draft: { schedules },
        meta: {
          mode,
          groupId: selectedGroupId || null,
          communityId: selectedCommunityId || null,
          householdSize,
          land: { acres: Number(landArea) || 0 },
          climate: { usdaZone },
          waterAccess,
          soilType,
          outputsWanted,
          constraints,
          notes,
        },
      });

      emitEvent("garden.plan.generated", {
        householdId: householdId || null,
        mode,
        zone: plan.zone,
        acres: Number(landArea) || 0,
        beds: plan.beds?.length || 0,
      });

      setOk(true);
    } catch (e) {
      console.warn("[garden] estimateGardenPlan failed:", e?.message || e);
      emitEvent("garden.plan.generate_failed", {
        error: e?.message || String(e),
      });
      setOk(false);
    } finally {
      setBusy(false);
    }
  };

  const acceptAndSync = async () => {
    // This page doesn’t assume a specific queue schema, so we “request” sync.
    // If you have a real GardenQueueManager sync method, it will run; otherwise it becomes an event.
    try {
      const GQM = resolveGQM(GardenQueueManagerMod);
      if (GQM?.syncFromPlan && gardenPlan) {
        await GQM.syncFromPlan(gardenPlan, { draft, householdId, mode });
      } else if (GQM?.enqueueFromPlan && gardenPlan) {
        await GQM.enqueueFromPlan(gardenPlan, { draft, householdId, mode });
      } else {
        emitEvent("garden.queue.sync_requested", {
          householdId: householdId || null,
          mode,
          plan: gardenPlan || null,
          draft: draft || null,
        });
      }
      setQueue(await getQueueSafe());
      emitEvent("nba.updated", { reason: "accepted_and_synced" });
    } catch (e) {
      console.warn("[garden] acceptAndSync failed:", e?.message || e);
      emitEvent("garden.queue.sync_failed", { error: e?.message || String(e) });
    }
  };

  const toggleFavoriteSession = (session) => {
    if (!session?.id) return;
    const current = loadFavoriteTemplates();
    const isFav = current.some(
      (t) => t.kind === "session" && t.sessionId === session.id
    );

    const next = isFav
      ? current.filter(
          (t) => !(t.kind === "session" && t.sessionId === session.id)
        )
      : [
          {
            kind: "session",
            sessionId: session.id,
            title: session.title || "Garden Session",
            createdAt: nowISO(),
          },
          ...current,
        ];

    saveFavoriteTemplates(next);
    setFavoriteTemplates(next);
    setFavoriteSessionIds(
      next
        .filter((t) => t.kind === "session" && t.sessionId)
        .map((t) => t.sessionId)
    );

    emitEvent(isFav ? "garden.favorite.removed" : "garden.favorite.added", {
      sessionId: session.id,
      title: session.title || "",
    });
  };

  const buildAndRunSessionNow = async () => {
    setBusy(true);
    try {
      const list = await getRunnableSafe();
      if (list.length > 1) {
        setRunnable(list);
        setSwapOpen(true);
        setBusy(false);
        return;
      }
      if (list.length === 1) {
        await openRunnerSafe({ sessionId: list[0].id });
        emitEvent("garden.session.opened", {
          sessionId: list[0].id,
          via: "runnable",
        });
        setBusy(false);
        return;
      }

      // none runnable → create based on sessionSource
      let steps = [];
      let title = "Garden Session";

      const planSteps = stepsFromPlan(gardenPlan, draft, {
        waterAccess,
        mode,
        selectedGroupId,
        selectedCommunityId,
      });

      let artifactSteps = [];
      if (sessionSource === "artifacts" || sessionSource === "merge") {
        const artifacts = await loadReadyGardenArtifacts();
        const graphs = artifacts.map(artifactToStepGraph).filter(Boolean);

        if (graphs.length) {
          const composite = mergeStepGraphs(graphs);
          artifactSteps = stepsFromArtifacts(composite);
          title = composite.label || title;
        }
      }

      if (sessionSource === "plan") {
        steps = planSteps;
        title = gardenPlan ? "Garden Plan Session" : title;
      } else if (sessionSource === "artifacts") {
        steps = artifactSteps;
        title = artifactSteps.length ? title : "Garden Session (Fallback)";
      } else {
        // merge
        steps = mergeSteps(planSteps, artifactSteps);
        title = "Composite Garden Session";
      }

      if (!steps.length) {
        const quick = makeQuickGardenFallback();
        steps = quick.steps;
        title = quick.title;
      }

      const session = buildSessionObject({
        title,
        steps,
        meta: {
          scope: mode,
          groupId: mode === "group" ? selectedGroupId || null : null,
          communityId:
            mode === "community" ? selectedCommunityId || null : null,
          inputs: {
            householdSize,
            landArea,
            usdaZone,
            waterAccess,
            soilType,
            outputsWanted,
            constraints,
            notes,
          },
          plan: gardenPlan
            ? { zone: gardenPlan.zone, beds: gardenPlan.beds?.length || 0 }
            : null,
          prefs: { voiceGuidance: true },
        },
      });

      const sessionId = await upsertSessionSafe(session);
      emitEvent("session.saved", {
        sessionId,
        domain: "garden",
        reason: "created_from_garden_page",
      });

      await exportToHubIfEnabled({
        type: "garden.session.created",
        domain: "garden",
        source: "garden-page",
        data: { session },
      });

      await refreshRunnable();
      await openRunnerSafe({ sessionId });

      emitEvent("garden.session.opened", { sessionId, via: "created" });
    } catch (e) {
      console.warn("[garden] buildAndRunSessionNow failed:", e?.message || e);
      emitEvent("garden.session.create_failed", {
        error: e?.message || String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  const nbaCards = useMemo(
    () => computeNBA({ queue, inventoryNeeds, gardenPlan }),
    [queue, inventoryNeeds, gardenPlan]
  );

  const handleNBACard = async (action) => {
    if (action === "generatePlan") return estimateGardenPlan();
    if (action === "acceptAndSync") return acceptAndSync();
    if (action === "openInventory") {
      emitEvent("nav.requested", {
        to: "/inventory",
        reason: "garden_low_inventory",
      });
      return;
    }
  };

  return (
    <div className="sv-page">
      {/* Header */}
      <div
        className="sv-row sv-justify-between sv-align-center"
        style={{ gap: 12 }}
      >
        <div className="sv-stack-xs">
          <div className="sv-display" style={{ fontSize: 22 }}>
            Garden
          </div>
          <div className="sv-muted">
            Plan → sync → run a single, actionable session (with timers +
            checkpoints).
          </div>
        </div>

        <div
          className="sv-row sv-align-center"
          style={{ gap: 8, flexWrap: "wrap" }}
        >
          <button
            className={cls("btn", "primary")}
            style={PAD.btn}
            onClick={buildAndRunSessionNow}
            disabled={busy}
            aria-busy={busy}
            title="Resolve next runnable Garden session or create one"
          >
            Now
          </button>
          <Link className="btn" to="/calendar">
            Calendar
          </Link>
          <Link className="btn" to="/inventory">
            Inventory
          </Link>
        </div>
      </div>

      {/* Status strip */}
      <div
        className="sv-row sv-align-center"
        style={{ gap: 10, flexWrap: "wrap", marginTop: 12 }}
      >
        <div className="sv-badge">Conflicts: {conflictCount}</div>
        <div className="sv-badge">Shortages: {shortages.total}</div>
        <div className="sv-badge">Open records: {recordCounts.open}</div>
        <div className="sv-badge">Runnable sessions: {runnable.length}</div>
      </div>

      {/* NBA strip */}
      {nbaCards.length ? (
        <div
          className="sv-row"
          style={{
            gap: 10,
            marginTop: 14,
            overflowX: "auto",
            paddingBottom: 4,
          }}
        >
          {nbaCards.map((c) => (
            <button
              key={c.id}
              type="button"
              className="sv-card sv-pad"
              style={{
                minWidth: 260,
                textAlign: "left",
                borderRadius: 16,
                cursor: "pointer",
              }}
              onClick={() => handleNBACard(c.action)}
            >
              <div className="sv-strong">{c.title}</div>
              <div className="sv-muted" style={{ marginTop: 6 }}>
                {c.body}
              </div>
            </button>
          ))}
        </div>
      ) : null}

      {/* Planner + Queue + Records */}
      <div
        style={{
          marginTop: 14,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
          gap: 12,
          alignItems: "start",
        }}
      >
        {/* Planner */}
        <div className="sv-card sv-pad" style={{ borderRadius: 16 }}>
          <StepHeader
            step={1}
            title="Plan (Zone-aware, Torah-aligned)"
            subtitle="Generate a draft plan + maintenance cadence; optionally push key dates to calendar."
          />

          <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
            <Field label="Scope">
              <div className="sv-row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className={cls("btn", mode === "individual" && "primary")}
                  style={PAD.tab}
                  onClick={() => setMode("individual")}
                >
                  Household
                </button>
                <button
                  type="button"
                  className={cls("btn", mode === "group" && "primary")}
                  style={PAD.tab}
                  onClick={() => setMode("group")}
                >
                  Group
                </button>
                <button
                  type="button"
                  className={cls("btn", mode === "community" && "primary")}
                  style={PAD.tab}
                  onClick={() => setMode("community")}
                >
                  Community
                </button>
              </div>
            </Field>

            {mode === "group" ? (
              <Field label="Garden group">
                <select
                  className={FIELD_INPUT_CLASS}
                  value={selectedGroupId}
                  onChange={(e) => setSelectedGroupId(e.target.value)}
                >
                  <option value="">Select…</option>
                  {(groups || []).map((g) => (
                    <option
                      key={g.id || g.slug || g.name}
                      value={g.id || g.slug || g.name}
                    >
                      {g.name || g.title || g.id}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            {mode === "community" ? (
              <Field label="Community garden">
                <select
                  className={FIELD_INPUT_CLASS}
                  value={selectedCommunityId}
                  onChange={(e) => setSelectedCommunityId(e.target.value)}
                >
                  <option value="">Select…</option>
                  {(communityGardens || []).map((g) => (
                    <option
                      key={g.id || g.slug || g.name}
                      value={g.id || g.slug || g.name}
                    >
                      {g.name || g.title || g.id}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
              }}
            >
              <Field label="Household size">
                <input
                  className={FIELD_INPUT_CLASS}
                  value={householdSize}
                  onChange={(e) =>
                    setHouseholdSize(Number(e.target.value || 0))
                  }
                />
              </Field>
              <Field label="Land area (acres)">
                <input
                  className={FIELD_INPUT_CLASS}
                  value={landArea}
                  onChange={(e) => setLandArea(e.target.value)}
                  placeholder="0.25"
                />
              </Field>
              <Field label="USDA zone">
                <input
                  className={FIELD_INPUT_CLASS}
                  value={usdaZone}
                  onChange={(e) => setUsdaZone(e.target.value)}
                  placeholder="7b"
                />
              </Field>
              <Field label="Water access">
                <select
                  className={FIELD_INPUT_CLASS}
                  value={waterAccess}
                  onChange={(e) => setWaterAccess(e.target.value)}
                >
                  <option value="drip">Drip</option>
                  <option value="hose">Hose</option>
                  <option value="limited">Limited</option>
                </select>
              </Field>
            </div>

            <Field label="Soil type">
              <select
                className={FIELD_INPUT_CLASS}
                value={soilType}
                onChange={(e) => setSoilType(e.target.value)}
              >
                <option value="loam">Loam</option>
                <option value="clay">Clay</option>
                <option value="sand">Sand</option>
                <option value="unknown">Unknown</option>
              </select>
            </Field>

            <Field label="Outputs wanted (quick tags)">
              <div className="sv-row" style={{ gap: 8, flexWrap: "wrap" }}>
                {["veg", "fruit", "herbs", "grains", "legumes"].map((k) => {
                  const active = outputsWanted.includes(k);
                  return (
                    <button
                      key={k}
                      type="button"
                      className={cls("btn", active && "primary")}
                      style={PAD.chip}
                      onClick={() =>
                        setOutputsWanted((cur) =>
                          cur.includes(k)
                            ? cur.filter((x) => x !== k)
                            : [...cur, k]
                        )
                      }
                    >
                      {k}
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="Constraints (optional)">
              <input
                className={FIELD_INPUT_CLASS}
                value={constraints}
                onChange={(e) => setConstraints(e.target.value)}
                placeholder="e.g., Withhold watering on Sabbath; no synthetic fertilizer…"
              />
            </Field>

            <Field label="Notes (optional)">
              <textarea
                className={FIELD_INPUT_CLASS}
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything SSA should keep in mind..."
              />
            </Field>

            <Field label="Selected crops (optional)">
              <div className="sv-row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button
                  className="btn"
                  type="button"
                  onClick={() => setCropPickerOpen(true)}
                >
                  Pick crops
                </button>
                {selectedCrops.length ? (
                  <div className="sv-muted">
                    {selectedCrops
                      .slice(0, 4)
                      .map((c) =>
                        c.variety ? `${c.name} (${c.variety})` : c.name
                      )
                      .join(", ")}
                    {selectedCrops.length > 4 ? "…" : ""}
                  </div>
                ) : (
                  <div className="sv-muted">None selected</div>
                )}
              </div>
            </Field>

            <Field label="Session source for “Now” when none exist">
              <select
                className={FIELD_INPUT_CLASS}
                value={sessionSource}
                onChange={(e) => setSessionSource(e.target.value)}
              >
                <option value="plan">Plan draft</option>
                <option value="artifacts">Artifacts only</option>
                <option value="merge">Merge plan + artifacts</option>
              </select>
            </Field>

            <div className="sv-row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button
                className="btn primary"
                style={PAD.btn}
                onClick={estimateGardenPlan}
                disabled={busy}
              >
                Generate plan
              </button>
              <button
                className="btn"
                onClick={acceptAndSync}
                disabled={!gardenPlan || busy}
                title="Ask the queue manager to create actionable tasks from your plan"
              >
                Sync tasks to queue
              </button>
            </div>

            {ok && gardenPlan ? (
              <div className="sv-card sv-pad" style={{ borderRadius: 14 }}>
                <div className="sv-strong">Draft created</div>
                <div className="sv-muted" style={{ marginTop: 6 }}>
                  Zone <span className="sv-strong">{gardenPlan.zone}</span> •{" "}
                  {Math.round(gardenPlan.areaSqft)} sqft •{" "}
                  {(gardenPlan.beds || []).length} beds
                </div>
                {gardenPlan.notes ? (
                  <div className="sv-caption" style={{ marginTop: 8 }}>
                    {gardenPlan.notes}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {/* Queue */}
        <div className="sv-card sv-pad" style={{ borderRadius: 16 }}>
          <StepHeader
            step={2}
            title="Garden Queue"
            subtitle="Your next actionable tasks (from plans, imports, or manual add)."
          />

          <div
            className="sv-row"
            style={{ gap: 8, flexWrap: "wrap", marginTop: 12 }}
          >
            <button className="btn" onClick={() => setQueue((q) => [...q])}>
              Refresh
            </button>
            <button
              className="btn primary"
              onClick={buildAndRunSessionNow}
              disabled={busy}
            >
              Run now
            </button>
          </div>

          {inventoryNeeds?.length ? (
            <div
              className="sv-card sv-pad"
              style={{ marginTop: 12, borderRadius: 14 }}
            >
              <div className="sv-strong">Low inventory</div>
              <div className="sv-muted" style={{ marginTop: 6 }}>
                {(inventoryNeeds || [])
                  .slice(0, 5)
                  .map((x) => x?.name || x)
                  .join(", ")}
                {inventoryNeeds.length > 5 ? "…" : ""}
              </div>
              <div style={{ marginTop: 10 }}>
                <Link className="btn" to="/inventory">
                  Review inventory
                </Link>
              </div>
            </div>
          ) : null}

          {reminders?.length ? (
            <div
              className="sv-card sv-pad"
              style={{ marginTop: 12, borderRadius: 14 }}
            >
              <div className="sv-strong">Reminders</div>
              <ul style={{ marginTop: 8 }}>
                {reminders.slice(0, 4).map((r, idx) => (
                  <li key={r.id || idx} className="sv-muted">
                    {r.title || r.text || String(r)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div style={{ marginTop: 12 }}>
            {Array.isArray(queue) && queue.length ? (
              <div className="sv-stack-sm">
                {queue.slice(0, 12).map((t) => (
                  <div
                    key={t.id || t.taskId || t.title}
                    className="sv-row sv-justify-between sv-align-center sv-card sv-pad"
                    style={{ borderRadius: 12 }}
                  >
                    <div className="sv-stack-xs" style={{ minWidth: 0 }}>
                      <div
                        className="sv-strong"
                        style={{
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {t.title || t.name || "Garden task"}
                      </div>
                      <div className="sv-muted sv-text-sm">
                        {t.location || t.bed || ""}{" "}
                        {t.dueDate ? `• due ${fmt(t.dueDate)}` : ""}
                      </div>
                    </div>
                    <button
                      className="btn primary"
                      onClick={() => markComplete(t.id || t.taskId)}
                    >
                      Done
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="sv-muted" style={{ marginTop: 10 }}>
                No queue items yet. Generate a plan and sync tasks, or add
                records below.
              </div>
            )}
          </div>
        </div>

        {/* Records */}
        <div className="sv-card sv-pad" style={{ borderRadius: 16 }}>
          <StepHeader
            step={3}
            title="Garden Records"
            subtitle="Tasks, plantings, harvests, and notes — searchable and sortable."
          />

          <div
            className="sv-row"
            style={{ gap: 8, flexWrap: "wrap", marginTop: 12 }}
          >
            <button className="btn primary" onClick={openCreateRecord}>
              Add record
            </button>
            <div className="sv-badge">Open: {recordCounts.open}</div>
            <div className="sv-badge">Done: {recordCounts.done}</div>
            <div className="sv-badge">Archived: {recordCounts.archived}</div>
          </div>

          <div
            style={{
              marginTop: 12,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: 10,
            }}
          >
            <Field label="Search">
              <input
                className={FIELD_INPUT_CLASS}
                value={grQuery}
                onChange={(e) => setGrQuery(e.target.value)}
                placeholder="title, crop, location, tags…"
              />
            </Field>

            <Field label="Type">
              <select
                className={FIELD_INPUT_CLASS}
                value={grType}
                onChange={(e) => setGrType(e.target.value)}
              >
                <option value="all">All</option>
                <option value="task">Task</option>
                <option value="planting">Planting</option>
                <option value="harvest">Harvest</option>
                <option value="note">Note</option>
              </select>
            </Field>

            <Field label="Status">
              <select
                className={FIELD_INPUT_CLASS}
                value={grStatus}
                onChange={(e) => setGrStatus(e.target.value)}
              >
                <option value="open">Open</option>
                <option value="done">Done</option>
                <option value="archived">Archived</option>
                <option value="all">All</option>
              </select>
            </Field>

            <Field label="Priority">
              <select
                className={FIELD_INPUT_CLASS}
                value={grPriority}
                onChange={(e) => setGrPriority(e.target.value)}
              >
                <option value="all">All</option>
                <option value="low">Low</option>
                <option value="med">Medium</option>
                <option value="high">High</option>
              </select>
            </Field>

            <Field label="Sort">
              <select
                className={FIELD_INPUT_CLASS}
                value={grSort}
                onChange={(e) => setGrSort(e.target.value)}
              >
                <option value="dueDate">Due date</option>
                <option value="updatedAt">Updated</option>
                <option value="createdAt">Created</option>
              </select>
            </Field>
          </div>

          <div style={{ marginTop: 12 }}>
            {recordsLoading ? <div className="sv-muted">Loading…</div> : null}
            {recordsError ? (
              <div className="sv-card sv-pad" style={{ borderRadius: 12 }}>
                <div className="sv-strong">Couldn’t load records</div>
                <div className="sv-muted" style={{ marginTop: 6 }}>
                  {recordsError}
                </div>
              </div>
            ) : null}

            {!recordsLoading && !visibleRecords.length ? (
              <div className="sv-muted">No records match your filters.</div>
            ) : null}

            {!!visibleRecords.length ? (
              <div className="sv-stack-sm">
                {visibleRecords.slice(0, 30).map((r) => (
                  <div
                    key={r.id}
                    className="sv-card sv-pad"
                    style={{ borderRadius: 14 }}
                  >
                    <div
                      className="sv-row sv-justify-between sv-align-center"
                      style={{ gap: 10 }}
                    >
                      <div className="sv-stack-xs" style={{ minWidth: 0 }}>
                        <div
                          className="sv-strong"
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <span
                            className="sv-badge"
                            title={`${r.type} • ${r.priority}`}
                          >
                            {r.type}
                          </span>
                          <span
                            style={{
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {r.title}
                          </span>
                        </div>

                        <div className="sv-muted sv-text-sm">
                          {r.crop
                            ? `${r.crop}${r.variety ? ` (${r.variety})` : ""}`
                            : ""}
                          {r.location ? ` • ${r.location}` : ""}
                          {r.bed ? ` • ${r.bed}` : ""}
                          {r.dueDate ? ` • due ${fmt(r.dueDate)}` : ""}
                        </div>

                        {r.description ? (
                          <div className="sv-caption" style={{ marginTop: 6 }}>
                            {r.description}
                          </div>
                        ) : null}

                        {/* ✅ FIXED: broken JSX + duplicate tags block */}
                        {Array.isArray(r.tags) && r.tags.length ? (
                          <div
                            className="sv-row"
                            style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}
                          >
                            {r.tags.slice(0, 8).map((t) => (
                              <span key={t} className="sv-badge">
                                {t}
                              </span>
                            ))}
                            {r.tags.length > 8 ? (
                              <span className="sv-muted sv-text-sm">…</span>
                            ) : null}
                          </div>
                        ) : null}
                      </div>

                      <div
                        className="sv-row"
                        style={{
                          gap: 8,
                          flexWrap: "wrap",
                          justifyContent: "flex-end",
                        }}
                      >
                        <button
                          className="btn"
                          onClick={() => openEditRecord(r)}
                        >
                          Edit
                        </button>

                        {r.status === "open" ? (
                          <button
                            className="btn primary"
                            onClick={() => markRecordDone(r)}
                          >
                            Mark done
                          </button>
                        ) : null}

                        {r.status === "done" ? (
                          <button
                            className="btn"
                            onClick={() => reopenRecord(r)}
                          >
                            Reopen
                          </button>
                        ) : null}

                        {r.status !== "archived" ? (
                          <button
                            className="btn"
                            onClick={() => archiveRecord(r)}
                          >
                            Archive
                          </button>
                        ) : (
                          <button
                            className="btn"
                            onClick={() => restoreRecord(r)}
                          >
                            Restore
                          </button>
                        )}

                        <button
                          className="btn"
                          onClick={() => hardDeleteRecord(r)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Modals */}
      <GardenRecordModal
        open={grModalOpen}
        mode={grModalMode}
        initial={grDraft}
        onClose={closeRecordModal}
        onSave={saveRecordFromModal}
        busy={grMutateBusy}
        error={grMutateError}
        validationErrors={grValidation}
        onChangeDraft={(patch) =>
          setGrDraft((cur) => ({
            ...(cur || {}),
            ...(patch || {}),
          }))
        }
      />

      <SessionSwapModal
        open={swapOpen}
        onClose={() => setSwapOpen(false)}
        sessions={runnable}
        favoriteSessionIds={favoriteSessionIds}
        onToggleFavorite={toggleFavoriteSession}
        onSelect={async (s) => {
          try {
            setSwapOpen(false);
            if (!s?.id) return;
            await openRunnerSafe({ sessionId: s.id });
            emitEvent("garden.session.opened", {
              sessionId: s.id,
              via: "swap_modal",
            });
          } catch (e) {
            emitEvent("garden.session.open_failed", {
              error: e?.message || String(e),
            });
          }
        }}
      />

      {cropPickerOpen ? (
        <CropPicker
          open={cropPickerOpen}
          onClose={() => setCropPickerOpen(false)}
          selected={selectedCrops}
          catalog={cropCatalog}
          onChange={(next) => {
            const arr = Array.isArray(next) ? next : [];
            setSelectedCrops(arr);
            emitEvent("garden.crops.selected", {
              count: arr.length,
              crops: arr.map((c) => ({
                name: c?.name || c,
                variety: c?.variety || "",
              })),
            });
          }}
        />
      ) : null}
    </div>
  );
}
