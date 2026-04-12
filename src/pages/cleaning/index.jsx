// C:\Users\larho\suka-smart-assistant\src\pages\cleaning\index.jsx
/* eslint-disable no-console */

/**
 * Cleaning Page (Interactive Module)
 * -----------------------------------------------------------------------------
 * REQUIRED (1) User flows on this page
 * - Generate: generate a cleaning plan (draft) from preferences (zones/intensity)
 * - Review: open the generated plan modal and review steps + timers
 * - Save plan: save the draft into a local Plan Library (Dexie) as a reusable plan
 * - Edit plan: rename, change zones/intensity, edit step titles/durations (basic inline)
 * - Duplicate plan: copy an existing plan to tweak it
 * - Delete plan: delete from Plan Library
 * - Search/filter: search plans by title, filter by zone + intensity + status
 * - Mark completed: mark a plan “completed today” (adds lastCompletedAt + increments counter)
 * - Run now:
 *   - Start SessionRunner with a runnable session (existing SessionsRepo),
 *   - or create a session from a plan/draft and open SessionRunner / navigate to play route
 *
 * REQUIRED (2) Data contract (Dexie record schema)
 * This module reads/writes:
 * A) cleaningPlans (NEW TABLE) — reusable plans owned by the user
 *  {
 *    id: string,                    // primary id for plan
 *    householdId: string|null,      // optional; null for standalone SSA
 *    title: string,
 *    intensity: "light"|"standard"|"deep",
 *    zones: string[],               // e.g., ["Kitchen","Bathroom"]
 *    steps: Array<{
 *      id: string,
 *      title: string,
 *      desc?: string,
 *      durationSec: number,
 *      blockers?: string[],
 *      metadata?: object
 *    }>,
 *    tags: string[],
 *    status: "active"|"archived",
 *    createdAt: string,             // ISO
 *    updatedAt: string,             // ISO
 *    lastCompletedAt?: string|null, // ISO
 *    completedCount?: number,       // number
 *    source?: string,               // e.g. "generated" | "manual" | "import"
 *  }
 *
 * B) sessions (EXISTING) — persisted runnable sessions (via db.saveSession)
 *  Uses your shared contract in src/services/db.js:
 *    saveSession(session) -> { sessionId, id(alias), dbId }
 *
 * REQUIRED (3) State model
 * - Local state:
 *   - generator prefs: title/zones/intensity and guards
 *   - draft + draft modal visibility
 *   - Plan Library: plans[], selection, editing state, search/filter, pagination
 *   - UI states: busy/progress, toasts, banners, error states
 * - Derived state:
 *   - filteredPlans (search + filter)
 *   - favoriteSessionsFull (existing behavior)
 * - Validation:
 *   - title required (trim length > 0)
 *   - zones length >= 1
 *   - steps must have title; durationSec >= 0
 * - Optimistic updates:
 *   - create/update/delete plan updates UI immediately, then Dexie write
 *   - if Dexie fails, we revert and show toast
 * - Error states:
 *   - db missing table → seed + fallback to localStorage plan library
 *
 * REQUIRED (4) Persistence
 * - Dexie CRUD for cleaningPlans with soft-import for db
 * - Seed handling if table missing: attempts to create minimal local plan list in localStorage
 *
 * REQUIRED (5) EventBus
 * - Soft-import eventBus from:
 *   "@/services/events/eventBus.js" OR "../../services/events/eventBus"
 * - Emit standardized events on every mutation (create/update/delete/complete)
 * - Payload shape (canonical):
 *   { type, ts, source, data: { ... } }
 *
 * REQUIRED (6) Wiring
 * - Default export page component (router-friendly)
 * - Safe fallbacks for db/eventBus/openRunner/SessionsRepo
 * - No TypeScript
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import "@/styles/household.css";
import "../cooking/cooking.css"; // reuse Cooking page layout + cards
import {
  SSAAnimalAvatar,
  SSAButton,
  SSAGrowthOverlay,
  SSAHouseholdParticipation,
  SSASeasonalTaskHighlight,
  CollaborationChip,
} from "@/components/ssa";
import { getSeasonKey, getSeasonLabel } from "@/utils/season";
import {
  findValueByCandidateKeys,
  normalizeParticipationEntries,
} from "@/utils/householdGlance";
import {
  areAgendaFiltersEqual,
  normalizeAppliedAgendaFilters,
} from "@/utils/householdAgendaControls";
import { buildHouseholdTodayUpcomingQuery } from "@/utils/householdAgendaQueryParams";

/* -------------------------------------------------------------------------- */
/* Soft/defensive shared imports (REQUIRED)                                    */
/* -------------------------------------------------------------------------- */

// db soft-import (required): "@/services/db" OR "../../services/db"
let db = null;
let saveSession = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const m = require("@/services/db");
  db = m?.default || m?.db || m;
  saveSession = m?.saveSession || null;
} catch {
  try {
    // eslint-disable-next-line global-require
    const m2 = require("../../services/db");
    db = m2?.default || m2?.db || m2;
    saveSession = m2?.saveSession || null;
  } catch {}
}

// eventBus soft-import (required): "@/services/events/eventBus.js" OR "../../services/events/eventBus"
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
  } catch {}
}

let automation = {
  on: () => () => {},
  request: async () => null,
  emitEvent: () => {},
};
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const a = require("@/services/automation/runtime");
  automation = a?.default || a || automation;
} catch {}

let SessionsRepo = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const m = require("@/services/session/SessionsRepo");
  SessionsRepo = m?.default || m;
} catch {}

let openRunner = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const m = require("@/features/session-runner/openRunner");
  openRunner = m?.default || m;
} catch {}

let draftToPlay = (d) => d;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const m = require("@/services/session/draftToPlay");
  draftToPlay = m?.default || m;
} catch {}

/* Optional page-local components (soft) */
let CleaningSessionPlanner = () => null;
try {
  // eslint-disable-next-line global-require
  const m = require("./CleaningSessionPlanner.jsx");
  CleaningSessionPlanner = m?.default || m;
} catch {}

let MultiTimerPanel = () => null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const m = require("@/features/timers/MultiTimerPanel.jsx");
  MultiTimerPanel = m?.default || m;
} catch {}

/* NEW: optional backend/module bridge for context-driven hints */
let backendModuleBridge = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const m = require("@/services/backend/moduleBridge");
  backendModuleBridge = m?.default || m;
} catch {}

/* NEW: shared Cleaning Session Engine + artifacts (StepGraph-based) */
let CleaningSessionEngine = null;
let getSessionReadyArtifacts = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const mod = require("@/engines/cleaning/CleaningSessionEngine");
  CleaningSessionEngine = mod?.default || mod?.CleaningSessionEngine || mod;
} catch {}
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const artMod = require("@/services/session/getSessionReadyArtifacts");
  getSessionReadyArtifacts =
    artMod?.default || artMod?.getSessionReadyArtifacts || artMod;
} catch {}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix = "clean") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function resolveCleaningHouseholdId() {
  if (typeof window === "undefined") return "default-household";
  const fromGlobal =
    window.__suka?.profile?.householdId ||
    window.__suka?.profile?.homeId ||
    window.__suka?.householdId ||
    window.__suka?.homeId;
  if (fromGlobal) return String(fromGlobal);

  try {
    const raw = window.localStorage?.getItem("suka.profile");
    const parsed = raw ? JSON.parse(raw) : null;
    return String(parsed?.householdId || parsed?.homeId || "default-household");
  } catch {
    return "default-household";
  }
}

/**
 * REQUIRED (5): Standardized event emission (supports both emit(type,data) and emit(payload)).
 * Canonical payload: { type, ts, source, data }
 */
function emitSSA(type, data, source = "ui/cleaning") {
  const payload = { type, ts: nowIso(), source, data };
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    if (eventBus.emit.length >= 2) eventBus.emit(type, payload);
    else eventBus.emit(payload);
  } catch {}
}

/**
 * DB accessors for Plan Library:
 * - Prefer Dexie table `cleaningPlans`
 * - If missing, fallback to localStorage
 */
const LS_PLANS_KEY = "ssa.cleaningPlans.v1";

function lsReadPlans() {
  try {
    const raw = localStorage.getItem(LS_PLANS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function lsWritePlans(plans) {
  try {
    localStorage.setItem(LS_PLANS_KEY, JSON.stringify(plans || []));
    return true;
  } catch {
    return false;
  }
}

function getPlansTableSafe() {
  try {
    if (!db) return null;
    // Dexie exposes table as db.table("name") and also as db[name] if declared.
    if (typeof db.table === "function") {
      // Throws if unknown in schema
      return db.table("cleaningPlans");
    }
    if (db.cleaningPlans) return db.cleaningPlans;
    return null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Agents worker client (soft import)                                         */
/* -------------------------------------------------------------------------- */

function createshimsClient() {
  let worker = null;

  try {
    worker = new Worker(new URL("@/workers/agentsWorker.js", import.meta.url), {
      type: "module",
    });
  } catch (e) {
    console.warn("[cleaning] agents worker unavailable:", e?.message || e);
  }

  let seq = 0;
  const pending = new Map();
  const listeners = {
    progress: new Set(),
    draft: new Set(),
    error: new Set(),
    log: new Set(),
    result: new Set(),
  };

  const callSet = (set, data) => {
    set.forEach((fn) => {
      try {
        fn?.(data);
      } catch (e) {
        console.error(e);
      }
    });
  };

  if (worker) {
    worker.onmessage = (ev) => {
      const { id, type, data } = ev.data || {};
      if (type === "PROGRESS") callSet(listeners.progress, data);
      if (type === "DRAFT_READY") callSet(listeners.draft, data);
      if (type === "ERROR") callSet(listeners.error, data);
      if (type === "LOG") callSet(listeners.log, data);
      if (type === "RESULT") callSet(listeners.result, data);

      const p = pending.get(id);
      if (!p) return;

      if (type === "ERROR") {
        pending.delete(id);
        p.reject(new Error(data?.message || "Worker error"));
        return;
      }
      if (type === "RESULT") {
        pending.delete(id);
        p.resolve(data);
      }
    };
  }

  const call = (type, payload) => {
    if (!worker) return Promise.reject(new Error("worker-unavailable"));
    const id = `w:${++seq}:${type}`;
    const out = new Promise((resolve, reject) =>
      pending.set(id, { resolve, reject })
    );
    worker.postMessage({ id, type, payload });
    return out;
  };

  const registrar = (set) => (fn) => {
    if (typeof fn !== "function") return () => {};
    set.add(fn);
    return () => set.delete(fn);
  };

  return {
    onProgress: registrar(listeners.progress),
    onDraft: registrar(listeners.draft),
    onError: registrar(listeners.error),
    onLog: registrar(listeners.log),
    onResult: registrar(listeners.result),
    init: async () => {
      if (!worker) return { ok: false, fallback: true };
      try {
        return await call("INIT", { preload: ["cleaningAgent", "zonesAgent"] });
      } catch {
        return { ok: false, fallback: true };
      }
    },
    generateCleaningDraft: async (params) => {
      return call("GENERATE_SESSIONS", {
        scope: "cleaning",
        opts: { cleaning: params },
      });
    },
    shutdown: () => {
      try {
        worker?.terminate?.();
      } catch {}
      try {
        pending.clear();
      } catch {}
      try {
        Object.values(listeners).forEach((s) => s.clear?.());
      } catch {}
    },
  };
}

/* -------------------------------------------------------------------------- */
/* UI atoms (kept consistent with your raised-card feel)                      */
/* -------------------------------------------------------------------------- */

function Card({ className = "", children, style, id }) {
  return (
    <div id={id} className={`sv-card ${className}`} style={style}>
      {children}
    </div>
  );
}

function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  title,
  className = "",
  type = "button",
}) {
  const mappedVariant = variant === "primary" ? "primary" : "secondary";
  return (
    <SSAButton
      type={type}
      variant={mappedVariant}
      className={`sv-btn ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </SSAButton>
  );
}

function SectionHeader({ icon, title, sub, right }) {
  return (
    <div className="sv-sectionHead">
      <div
        className="sv-sectionHead__row"
        style={{ justifyContent: "space-between", alignItems: "center" }}
      >
        <div className="sv-sectionHead__row">
          {icon ? <span className="sv-sectionHead__icon">{icon}</span> : null}
          <h2 className="sv-sectionHead__title">{title}</h2>
        </div>
        {right}
      </div>
      {sub ? <p className="sv-muted">{sub}</p> : null}
    </div>
  );
}

function Input({ label, value, onChange, type = "text", placeholder }) {
  return (
    <label className="sv-field">
      {label ? <span className="sv-field__label">{label}</span> : null}
      <input
        className="sv-input"
        type={type}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="sv-toggle">
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="sv-toggle__thumb" />
      <span className="sv-toggle__label">{label}</span>
    </label>
  );
}

function Chip({ active, children, onClick }) {
  return (
    <button
      type="button"
      className={`sv-chip ${active ? "is-active" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ProgressBar({ pct }) {
  const v = Math.max(0, Math.min(100, Math.round(pct || 0)));
  return (
    <div className="sv-progress">
      <div className="sv-progress__bar" style={{ width: `${v}%` }} />
    </div>
  );
}

const Toast = ({ tone = "info", text, action, onClose }) => (
  <div className={`sv-toast sv-toast--${tone}`}>
    <span>{text}</span>
    {action && (
      <button
        type="button"
        className="sv-btn sv-btn--outline sv-btn--sm"
        onClick={action.fn}
      >
        {action.label}
      </button>
    )}
    <button
      type="button"
      className="sv-btn sv-btn--ghost sv-btn--sm"
      onClick={onClose}
    >
      ✕
    </button>
  </div>
);

const Banner = ({ tone = "info", children, onDismiss }) => (
  <div className={`sv-banner sv-banner--${tone}`}>
    <div className="sv-banner__content">{children}</div>
    {onDismiss ? (
      <button
        type="button"
        className="sv-btn sv-btn--ghost sv-btn--sm"
        onClick={onDismiss}
      >
        Dismiss
      </button>
    ) : null}
  </div>
);

/* -------------------------------------------------------------------------- */
/* Swap Modal (“Now”) (kept from your patterns)                               */
/* -------------------------------------------------------------------------- */

function SessionSwapModal({
  open,
  onClose,
  sessions = [],
  onSelect,
  isFavorite = () => false,
  onToggleFavorite = () => {},
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
          <div className="sv-strong">Start Cleaning Now</div>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        <div
          className="sv-stack-sm"
          style={{
            background: "linear-gradient(180deg,#0f1b2b,rgba(0,0,0,0.2))",
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
            const fav = isFavorite(s);
            return (
              <div
                key={s.id}
                className="sv-row sv-justify-between sv-align-center sv-card sv-pad"
                style={{ borderRadius: 12 }}
              >
                <div>
                  <div className="sv-row sv-align-center" style={{ gap: 8 }}>
                    <div className="sv-strong">
                      {s.title || "Cleaning Session"}
                    </div>
                    <button
                      type="button"
                      className="sv-btn sv-btn--ghost sv-btn--sm"
                      onClick={() => onToggleFavorite(s)}
                      title={
                        fav
                          ? "Remove from favorite routines"
                          : "Save as favorite routine"
                      }
                    >
                      {fav ? "★" : "☆"}
                    </button>
                  </div>
                  <div className="sv-muted sv-text-sm">
                    {s?.steps?.length ?? 0} steps •{" "}
                    {s?.prefs?.voiceGuidance ? "Voice" : "Silent"} •{" "}
                    {s?.progress?.startedAt ? "Resume" : "Fresh"}
                  </div>
                </div>
                <Button onClick={() => onSelect(s)}>Start</Button>
              </div>
            );
          })}
          {!sessions.length && (
            <div className="sv-muted">No saved sessions found.</div>
          )}
        </div>

        <div className="sv-row sv-justify-end" style={{ marginTop: 12 }}>
          <Button
            onClick={() => (sessions[0] ? onSelect(sessions[0]) : onClose())}
          >
            Start Selected
          </Button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Draft normalization + local fallback (kept from your patterns)             */
/* -------------------------------------------------------------------------- */

function makeFallbackDraft({
  title,
  zones = ["Kitchen", "Bathroom", "Living Room"],
  intensity = "standard",
}) {
  const id = `draft_clean_${Date.now()}`;
  const steps = [];

  const stepFor = (zone, i) => (desc, min) => ({
    id: `${id}_${zone}_${i}_${desc.toLowerCase().replace(/\s+/g, "-")}`,
    title: `${zone}: ${desc}`,
    desc: `${desc} (${intensity})`,
    durationSec: min * 60,
    blockers: ["quietHours", "sabbath", "equipment"],
    metadata: { cueNotes: "" },
  });

  zones.forEach((z, zi) => {
    const add = stepFor(z, zi);
    steps.push(add("Declutter surfaces", 5));
    steps.push(add("Dust high to low", 6));
    steps.push(add("Wipe/disinfect touch points", 8));
    steps.push(add("Sweep/Vacuum", 7));
    steps.push(add("Spot mop", 6));
  });

  return {
    id,
    title: title || "Cleaning Session",
    createdAt: nowIso(),
    steps,
    metrics: {
      estMinutes: Math.round(
        steps.reduce((a, s) => a + (s.durationSec || 0), 0) / 60
      ),
    },
    preferences: { zones, intensity },
    draftType: "cleaning",
    domain: "cleaning",
    source: "local-fallback",
  };
}

function normalizeDraftToCleaning(incoming, prefs) {
  const zones = prefs?.zones || ["Kitchen", "Bathroom", "Living Room"];
  const intensity = prefs?.intensity || "standard";
  const title = prefs?.title || "Cleaning Session";

  const d = incoming && typeof incoming === "object" ? { ...incoming } : null;
  if (!d) return makeFallbackDraft({ title, zones, intensity });

  const steps = Array.isArray(d.steps) ? d.steps : [];
  const stepText = steps
    .slice(0, 10)
    .map((s) => `${s?.title || ""} ${s?.desc || ""}`.toLowerCase())
    .join(" | ");

  const looksCooking =
    /balanced meal|cook protein|preheat|doneness|simmer|boil|saute|recipe|ingredients/.test(
      stepText
    ) ||
    /cooking/.test((d.title || "").toLowerCase()) ||
    /cooking/.test((d.domain || "").toLowerCase());

  if (looksCooking || !steps.length) {
    const fallback = makeFallbackDraft({ title, zones, intensity });
    return {
      ...fallback,
      source: `${fallback.source}|normalized`,
      createdAt: d.createdAt || fallback.createdAt,
    };
  }

  const out = {
    ...d,
    title: d.title && !/cooking/i.test(d.title) ? d.title : title,
    draftType: "cleaning",
    domain: "cleaning",
    preferences: {
      ...(d.preferences || {}),
      zones: Array.isArray(d.preferences?.zones) ? d.preferences.zones : zones,
      intensity: d.preferences?.intensity || intensity,
    },
  };

  out.steps = (Array.isArray(out.steps) ? out.steps : []).map((s, i) => ({
    id: s?.id || `${out.id || "draft_clean"}_${i + 1}`,
    title: s?.title || s?.desc || `Step ${i + 1}`,
    desc: s?.desc || "",
    durationSec: Number.isFinite(s?.durationSec) ? s.durationSec : 0,
    blockers: Array.isArray(s?.blockers)
      ? s.blockers
      : ["quietHours", "sabbath", "equipment"],
    metadata: s?.metadata || { cueNotes: "" },
  }));

  out.metrics = out.metrics || {};
  if (!out.metrics.estMinutes) {
    out.metrics.estMinutes = Math.round(
      out.steps.reduce((a, s) => a + (s.durationSec || 0), 0) / 60
    );
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Favorites strip (kept)                                                     */
/* -------------------------------------------------------------------------- */

const FAV_SESS_KEY = "cleaning.favorite.sessions.v1";
function loadFavSessionIds() {
  try {
    const raw = localStorage.getItem(FAV_SESS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* The Page                                                                   */
/* -------------------------------------------------------------------------- */

export default function CleaningPage() {
  const navigate = useNavigate();

  // Generator prefs (existing patterns kept)
  const [title, setTitle] = useState("Cleaning Session");
  const [zones, setZones] = useState(["Kitchen", "Bathroom", "Living Room"]);
  const [intensity, setIntensity] = useState("standard"); // light|standard|deep
  const [sabbathAware, setSabbathAware] = useState(false);
  const [quietAware, setQuietAware] = useState(true);
  const [petsPresent, setPetsPresent] = useState(false);

  // Draft generation + UI
  const clientRef = useRef(null);
  const [progress, setProgress] = useState({ phase: null, pct: 0 });
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [banners, setBanners] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);

  // “Now” runnable sessions
  const [runnable, setRunnable] = useState([]);
  const [swapOpen, setSwapOpen] = useState(false);
  const [favoriteSessionIds, setFavoriteSessionIds] =
    useState(loadFavSessionIds);

  // Backend hints (optional)
  const [backendHints, setBackendHints] = useState(null);

  // Cross-domain glance (optional)
  const [householdGlance, setHouseholdGlance] = useState(null);
  const [householdAgenda, setHouseholdAgenda] = useState({
    applied: {
      filters: {
        person: "",
        module: "",
        priority: "",
        status: "",
      },
      sortBy: "dueAt",
      sortDirection: "desc",
    },
    today: [],
    upcoming: [],
  });
  const [householdAgendaBusy, setHouseholdAgendaBusy] = useState(false);
  const [agendaFilters, setAgendaFilters] = useState({
    person: "",
    module: "",
    priority: "",
    status: "",
    sortBy: "dueAt",
    sortDirection: "desc",
  });
  const [agendaPersonDraft, setAgendaPersonDraft] = useState("");

  // NEW: Plan Library state (interactive)
  const [plans, setPlans] = useState([]);
  const [plansLoaded, setPlansLoaded] = useState(false);
  const [planError, setPlanError] = useState(null);

  const [planSearch, setPlanSearch] = useState("");
  const [filterIntensity, setFilterIntensity] = useState("all"); // all|light|standard|deep
  const [filterZone, setFilterZone] = useState("all"); // all|Kitchen|...
  const [filterStatus, setFilterStatus] = useState("active"); // active|archived|all

  const [editingPlanId, setEditingPlanId] = useState(null);
  const [editTitle, setEditTitle] = useState("");
  const [editIntensity, setEditIntensity] = useState("standard");
  const [editZones, setEditZones] = useState([]);
  const [editSteps, setEditSteps] = useState([]);

  const [optimistic, setOptimistic] = useState({}); // id -> "saving"/"deleting"/"error"

  // Persist favorite sessions list (kept)
  useEffect(() => {
    try {
      localStorage.setItem(FAV_SESS_KEY, JSON.stringify(favoriteSessionIds));
    } catch {}
  }, [favoriteSessionIds]);

  // Banner helpers
  const bannerAdd = (b) =>
    setBanners((prev) =>
      prev.find((x) => x.key === b.key) ? prev : [...prev, b]
    );
  const bannerDismiss = (key) =>
    setBanners((prev) => prev.filter((b) => b.key !== key));

  // ---- Load Plan Library (Dexie preferred; LS fallback)
  const loadPlans = async () => {
    setPlanError(null);

    const table = getPlansTableSafe();
    if (!table) {
      // Seed handling: fallback store exists if Dexie table missing
      const local = lsReadPlans();
      setPlans(local);
      setPlansLoaded(true);
      setPlanError(
        "Dexie table cleaningPlans is missing; using localStorage fallback."
      );
      return;
    }

    try {
      const list = await table.toArray();
      setPlans(Array.isArray(list) ? list : []);
      setPlansLoaded(true);
    } catch (e) {
      console.warn("[cleaning] loadPlans failed:", e?.message || e);
      const local = lsReadPlans();
      setPlans(local);
      setPlansLoaded(true);
      setPlanError("Could not read Dexie; using localStorage fallback.");
    }
  };

  useEffect(() => {
    loadPlans();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Runnable sessions refresh (kept behavior)
  const refreshRunnable = async () => {
    try {
      if (!SessionsRepo?.getRunnable) return setRunnable([]);
      const list = await SessionsRepo.getRunnable({ domain: "cleaning" });
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
      eventBus.on?.("cleaning.plan.created", loadPlans),
      eventBus.on?.("cleaning.plan.updated", loadPlans),
      eventBus.on?.("cleaning.plan.deleted", loadPlans),
      eventBus.on?.("cleaning.plan.completed", loadPlans),
    ].filter(Boolean);

    return () =>
      offs.forEach((off) => {
        try {
          off?.();
        } catch {}
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Optional glance
  const fetchHouseholdGlance = async () => {
    try {
      const res = await automation.request?.("household.glance", {
        focus: "cleaning",
      });
      if (res) setHouseholdGlance(res);
    } catch {}
  };

  useEffect(() => {
    fetchHouseholdGlance();
  }, []);

  const fetchHouseholdAgenda = useCallback(async () => {
    setHouseholdAgendaBusy(true);
    try {
      const householdId = resolveCleaningHouseholdId();
      const params = buildHouseholdTodayUpcomingQuery({
        householdId,
        modules: "meal,cleaning,storehouse,homestead,community",
        todayLimit: 6,
        upcomingLimit: 6,
        filters: agendaFilters,
      });
      const response = await fetch(
        `/api/planners/household/today-upcoming?${params.toString()}`,
        {
          credentials: "include",
        }
      );
      if (!response.ok) return;
      const payload = await response.json();
      setHouseholdAgenda({
        applied: payload?.applied && typeof payload.applied === "object"
          ? payload.applied
          : {
              filters: {
                person: String(agendaFilters.person || ""),
                module: String(agendaFilters.module || ""),
                priority: String(agendaFilters.priority || ""),
                status: String(agendaFilters.status || ""),
              },
              sortBy: String(agendaFilters.sortBy || "dueAt"),
              sortDirection: String(agendaFilters.sortDirection || "desc"),
            },
        today: Array.isArray(payload?.today) ? payload.today : [],
        upcoming: Array.isArray(payload?.upcoming) ? payload.upcoming : [],
      });
      const normalizedAppliedFilters = normalizeAppliedAgendaFilters(payload?.applied);
      setAgendaFilters((previous) => {
        if (areAgendaFiltersEqual(previous, normalizedAppliedFilters)) {
          return previous;
        }
        return normalizedAppliedFilters;
      });
      setAgendaPersonDraft((previous) => {
        if (previous === normalizedAppliedFilters.person) {
          return previous;
        }
        return normalizedAppliedFilters.person;
      });
    } catch {
      // keep current agenda state
    } finally {
      setHouseholdAgendaBusy(false);
    }
  }, [agendaFilters]);

  useEffect(() => {
    fetchHouseholdAgenda();
  }, [fetchHouseholdAgenda]);

  const agendaCueLine = (item) =>
    [
      String(item?.module || item?.lane || "household"),
      String(item?.workflowState || item?.state || "planned"),
      item?.priority ? String(item.priority) : null,
      item?.recurrenceEnabled ? "recurring" : null,
      item?.hasDependencyBlock
        ? `blocked by ${Number(item?.blockingDependencyCount || 0)} deps`
        : null,
      item?.hasConflict ? `conflicts ${Number(item?.conflictCount || 0)}` : null,
      item?.overdue ? "overdue" : null,
    ]
      .filter(Boolean)
      .join(" | ");

  // ---- Module context push (kept)
  useEffect(() => {
    const ctx = {
      module: "cleaning",
      domain: "cleaning",
      page: "CleaningPage",
      prefs: { title, zones, intensity, sabbathAware, quietAware, petsPresent },
      ts: nowIso(),
    };

    emitSSA("module.context.changed", ctx, "ui/cleaning");

    try {
      automation.emitEvent?.("module.context.changed", ctx);
    } catch {}

    try {
      backendModuleBridge?.pushModuleContext?.("cleaning", ctx);
    } catch {}

    try {
      const maybePromise = backendModuleBridge?.getModuleHints?.(
        "cleaning",
        ctx
      );
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise
          .then((hints) => {
            if (hints) setBackendHints(hints);
          })
          .catch(() => {});
      }
    } catch {}
  }, [title, zones, intensity, sabbathAware, quietAware, petsPresent]);

  /* ------------------------------------------------------------------------ */
  /* Draft/session actions                                                     */
  /* ------------------------------------------------------------------------ */

  const prefs = useMemo(
    () => ({
      title,
      zones,
      intensity,
      sabbathAware,
      quietAware,
      petsPresent,
    }),
    [title, zones, intensity, sabbathAware, quietAware, petsPresent]
  );

  const intensityLabel = useMemo(
    () =>
      intensity === "light"
        ? "Light tidy"
        : intensity === "deep"
        ? "Deep clean"
        : "Standard",
    [intensity]
  );

  const startRunnerFor = async (session) => {
    const sid = session?.id || session?.sessionId;
    if (!sid) return;

    const envelope = {
      domain: "cleaning",
      id: sid,
      sessionId: sid,
      sticky: true,
    };

    // Prefer direct openRunner
    try {
      if (openRunner) await openRunner({ sessionId: sid, sticky: true });
    } catch (e) {
      console.warn("[cleaning] openRunner failed:", e?.message || e);
    }

    // Always broadcast a canonical request so any host can catch it.
    emitSSA("session.play.requested", envelope, "ui/cleaning");
    try {
      window.dispatchEvent?.(
        new CustomEvent("session.play.requested", {
          detail: {
            type: "session.play.requested",
            ts: nowIso(),
            source: "ui/cleaning",
            data: envelope,
          },
        })
      );
    } catch {}

    // Navigate fallback (ensures user gets to play view even if runner host fails)
    try {
      navigate(`/cleaning/play/${sid}`);
    } catch {}
  };

  const createSessionFromDraft = async (incomingDraft) => {
    const d = normalizeDraftToCleaning(incomingDraft, prefs);

    const sessionId = `clean_${Date.now()}_${Math.random()
      .toString(16)
      .slice(2)}`;

    const sessionDraft = {
      id: sessionId,
      sessionId,
      domain: "cleaning",
      title: d?.title || "Cleaning Session",
      source: { type: "cleaningPlan", refId: d?.id || null },
      steps: (d?.steps || []).map((s, i) => ({
        id: s.id || `${sessionId}_step_${i + 1}`,
        title: s.title || s.desc || `Step ${i + 1}`,
        desc: s.desc || "",
        durationSec: s.durationSec || 0,
        blockers: Array.isArray(s.blockers)
          ? s.blockers
          : ["quietHours", "sabbath", "equipment"],
        metadata: s.metadata || { cueNotes: "" },
      })),
      prefs: { voiceGuidance: true, haptic: true, autoAdvance: false },
      status: "draft",
      progress: {
        currentStepIndex: 0,
        elapsedSec: 0,
        startedAt: null,
        pausedAt: null,
      },
      analytics: { skippedSteps: [], adjustments: [] },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    // Persist session via shared helper if available (your db.js supports stable sessionId)
    try {
      if (typeof saveSession === "function") {
        await saveSession(sessionDraft);
      } else if (db?.sessions?.put) {
        // fallback if your db exports sessions store directly
        await db.sessions.put(sessionDraft);
      }
    } catch (e) {
      console.warn("[cleaning] saveSession failed:", e?.message || e);
    }

    try {
      await SessionsRepo?.upsert?.(sessionDraft);
    } catch {}

    emitSSA(
      "cleaning.session.created",
      { sessionId, session: sessionDraft },
      "ui/cleaning"
    );
    emitSSA(
      "session.saved",
      { domain: "cleaning", id: sessionId },
      "ui/cleaning"
    );

    return sessionDraft;
  };

  const handleNow = async () => {
    await refreshRunnable();

    if (runnable.length > 1) {
      setSwapOpen(true);
      return;
    }

    if (runnable.length === 1) {
      startRunnerFor(runnable[0]);
      return;
    }

    // no runnable; create from current draft or fallback
    const d = normalizeDraftToCleaning(
      draft || makeFallbackDraft(prefs),
      prefs
    );
    const sess = await createSessionFromDraft(d);
    startRunnerFor(sess);
  };

  const handleSwapSelect = async (s) => {
    setSwapOpen(false);
    if (!s) return;
    startRunnerFor(s);
  };

  // ---- Generate plan (engine first, worker fallback, then local fallback)
  const handleGenerate = async () => {
    setBusy(true);
    setDraft(null);
    setModalOpen(false);
    setProgress({ phase: "queued", pct: 1 });

    emitSSA(
      "session.generate.requested",
      { domain: "cleaning", preferences: prefs },
      "ui/cleaning"
    );

    // 1) StepGraph engine
    try {
      if (
        CleaningSessionEngine &&
        typeof CleaningSessionEngine.generate === "function"
      ) {
        let artifacts = null;
        try {
          if (typeof getSessionReadyArtifacts === "function") {
            artifacts = await getSessionReadyArtifacts({ domain: "cleaning" });
          }
        } catch {}

        const raw = await CleaningSessionEngine.generate({
          householdId: null,
          windowRange: null,
          tags: ["cleaning", intensity].filter(Boolean),
          prefs,
          artifacts,
        });

        const normalized = normalizeDraftToCleaning(raw, prefs);
        setDraft(normalized);
        setModalOpen(true);
        setProgress({ phase: "engine", pct: 100 });
        setToast({ tone: "success", text: "Cleaning plan ready." });

        emitSSA("cleaning.draft.ready", { draft: normalized }, "ui/cleaning");
        setBusy(false);
        return;
      }
    } catch (e) {
      console.warn("[cleaning] engine generate failed:", e?.message || e);
    }

    // 2) Worker
    try {
      const client = clientRef.current;
      const res = await client?.generateCleaningDraft?.({ preferences: prefs });
      if (!res) throw new Error("agents-failed");
      setToast({ tone: "info", text: "Generating…" });
      // DRAFT_READY listener will set draft
    } catch (e) {
      console.warn(
        "[cleaning] worker generate failed, fallback:",
        e?.message || e
      );
      const fallback = normalizeDraftToCleaning(
        makeFallbackDraft(prefs),
        prefs
      );
      setDraft(fallback);
      setModalOpen(true);
      setToast({ tone: "success", text: "Fallback plan created." });
      emitSSA(
        "cleaning.draft.ready",
        { draft: fallback, source: "local-fallback" },
        "ui/cleaning"
      );
    } finally {
      setBusy(false);
    }
  };

  // ---- Create session & run from a draft
  const handleCleanNow = async (incoming) => {
    try {
      const cleanedDraft = normalizeDraftToCleaning(incoming || draft, prefs);
      setDraft(cleanedDraft);
      const session = await createSessionFromDraft(cleanedDraft);
      startRunnerFor(session);
    } catch (e) {
      console.warn("[cleaning] Clean Now failed:", e?.message || e);
      setToast({ tone: "error", text: "Couldn’t start cleaning session." });
    }
  };

  /* ------------------------------------------------------------------------ */
  /* Plan Library CRUD (REQUIRED)                                              */
  /* ------------------------------------------------------------------------ */

  const validatePlan = (p) => {
    const errs = [];
    if (!p.title || !String(p.title).trim()) errs.push("Title is required.");
    if (!Array.isArray(p.zones) || p.zones.length < 1)
      errs.push("Select at least 1 zone.");
    if (!Array.isArray(p.steps) || p.steps.length < 1)
      errs.push("Plan must have at least 1 step.");
    const badStep = (p.steps || []).find(
      (s) => !s || !String(s.title || s.desc || "").trim()
    );
    if (badStep) errs.push("Each step needs a title/description.");
    return errs;
  };

  const beginEdit = (plan) => {
    setEditingPlanId(plan.id);
    setEditTitle(plan.title || "");
    setEditIntensity(plan.intensity || "standard");
    setEditZones(Array.isArray(plan.zones) ? plan.zones : []);
    setEditSteps(Array.isArray(plan.steps) ? plan.steps : []);
  };

  const cancelEdit = () => {
    setEditingPlanId(null);
    setEditTitle("");
    setEditIntensity("standard");
    setEditZones([]);
    setEditSteps([]);
  };

  const upsertPlanPersist = async (plan, { op }) => {
    // optimistic UI already applied by caller
    const table = getPlansTableSafe();

    // Dexie path
    if (table) {
      if (op === "delete") {
        await table.delete(plan.id);
        return;
      }
      await table.put(plan);
      return;
    }

    // localStorage fallback
    const current = lsReadPlans();
    if (op === "delete") {
      lsWritePlans(current.filter((p) => p.id !== plan.id));
      return;
    }
    const idx = current.findIndex((p) => p.id === plan.id);
    const next = [...current];
    if (idx >= 0) next[idx] = plan;
    else next.unshift(plan);
    lsWritePlans(next);
  };

  const createPlanFromDraft = async (d) => {
    const normalized = normalizeDraftToCleaning(d, prefs);
    const plan = {
      id: makeId("plan"),
      householdId: null,
      title: normalized.title || "Cleaning Plan",
      intensity: normalized.preferences?.intensity || intensity || "standard",
      zones: normalized.preferences?.zones || zones || [],
      steps: normalized.steps || [],
      tags: ["cleaning", "plan"],
      status: "active",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastCompletedAt: null,
      completedCount: 0,
      source: normalized.source || "generated",
    };

    const errs = validatePlan(plan);
    if (errs.length) {
      setToast({ tone: "error", text: errs[0] });
      return;
    }

    // optimistic insert
    setOptimistic((m) => ({ ...m, [plan.id]: "saving" }));
    setPlans((prev) => [plan, ...prev]);

    emitSSA("cleaning.plan.create.requested", { plan }, "ui/cleaning");

    try {
      await upsertPlanPersist(plan, { op: "upsert" });
      setOptimistic((m) => ({ ...m, [plan.id]: null }));
      setToast({ tone: "success", text: "Plan saved to Library." });
      emitSSA(
        "cleaning.plan.created",
        { planId: plan.id, plan },
        "ui/cleaning"
      );
    } catch (e) {
      console.warn("[cleaning] createPlan failed:", e?.message || e);
      // revert
      setPlans((prev) => prev.filter((p) => p.id !== plan.id));
      setOptimistic((m) => ({ ...m, [plan.id]: "error" }));
      setToast({ tone: "error", text: "Couldn’t save plan." });
      emitSSA(
        "cleaning.plan.create.failed",
        { planId: plan.id, error: String(e?.message || e) },
        "ui/cleaning"
      );
    }
  };

  const saveEdits = async () => {
    const plan = plans.find((p) => p.id === editingPlanId);
    if (!plan) return;

    const updated = {
      ...plan,
      title: String(editTitle || "").trim(),
      intensity: editIntensity,
      zones: Array.isArray(editZones) ? editZones : [],
      steps: Array.isArray(editSteps) ? editSteps : [],
      updatedAt: nowIso(),
    };

    const errs = validatePlan(updated);
    if (errs.length) {
      setToast({ tone: "error", text: errs[0] });
      return;
    }

    // optimistic update
    setOptimistic((m) => ({ ...m, [updated.id]: "saving" }));
    setPlans((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));

    emitSSA(
      "cleaning.plan.update.requested",
      { planId: updated.id, plan: updated },
      "ui/cleaning"
    );

    try {
      await upsertPlanPersist(updated, { op: "upsert" });
      setOptimistic((m) => ({ ...m, [updated.id]: null }));
      setToast({ tone: "success", text: "Plan updated." });
      emitSSA(
        "cleaning.plan.updated",
        { planId: updated.id, plan: updated },
        "ui/cleaning"
      );
      cancelEdit();
    } catch (e) {
      console.warn("[cleaning] updatePlan failed:", e?.message || e);
      // revert from storage (reload)
      await loadPlans();
      setOptimistic((m) => ({ ...m, [updated.id]: "error" }));
      setToast({ tone: "error", text: "Couldn’t update plan." });
      emitSSA(
        "cleaning.plan.update.failed",
        { planId: updated.id, error: String(e?.message || e) },
        "ui/cleaning"
      );
    }
  };

  const deletePlan = async (plan) => {
    if (!plan?.id) return;

    // optimistic remove
    setOptimistic((m) => ({ ...m, [plan.id]: "deleting" }));
    const prevPlans = plans;
    setPlans((p) => p.filter((x) => x.id !== plan.id));

    emitSSA(
      "cleaning.plan.delete.requested",
      { planId: plan.id },
      "ui/cleaning"
    );

    try {
      await upsertPlanPersist(plan, { op: "delete" });
      setOptimistic((m) => ({ ...m, [plan.id]: null }));
      setToast({ tone: "success", text: "Plan deleted." });
      emitSSA("cleaning.plan.deleted", { planId: plan.id }, "ui/cleaning");
    } catch (e) {
      console.warn("[cleaning] deletePlan failed:", e?.message || e);
      // revert
      setPlans(prevPlans);
      setOptimistic((m) => ({ ...m, [plan.id]: "error" }));
      setToast({ tone: "error", text: "Couldn’t delete plan." });
      emitSSA(
        "cleaning.plan.delete.failed",
        { planId: plan.id, error: String(e?.message || e) },
        "ui/cleaning"
      );
    }
  };

  const duplicatePlan = async (plan) => {
    if (!plan) return;
    const copy = {
      ...plan,
      id: makeId("plan"),
      title: `${plan.title || "Plan"} (copy)`,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastCompletedAt: null,
      completedCount: 0,
      source: (plan.source || "library") + "|duplicate",
    };

    // optimistic insert
    setOptimistic((m) => ({ ...m, [copy.id]: "saving" }));
    setPlans((prev) => [copy, ...prev]);

    emitSSA(
      "cleaning.plan.duplicate.requested",
      { fromPlanId: plan.id, plan: copy },
      "ui/cleaning"
    );

    try {
      await upsertPlanPersist(copy, { op: "upsert" });
      setOptimistic((m) => ({ ...m, [copy.id]: null }));
      setToast({ tone: "success", text: "Plan duplicated." });
      emitSSA(
        "cleaning.plan.created",
        { planId: copy.id, plan: copy },
        "ui/cleaning"
      );
    } catch (e) {
      setPlans((prev) => prev.filter((p) => p.id !== copy.id));
      setOptimistic((m) => ({ ...m, [copy.id]: "error" }));
      setToast({ tone: "error", text: "Couldn’t duplicate plan." });
      emitSSA(
        "cleaning.plan.duplicate.failed",
        { fromPlanId: plan.id, error: String(e?.message || e) },
        "ui/cleaning"
      );
    }
  };

  const markPlanCompleted = async (plan) => {
    if (!plan?.id) return;

    const updated = {
      ...plan,
      lastCompletedAt: nowIso(),
      completedCount: Number(plan.completedCount || 0) + 1,
      updatedAt: nowIso(),
    };

    // optimistic update
    setOptimistic((m) => ({ ...m, [updated.id]: "saving" }));
    setPlans((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));

    emitSSA(
      "cleaning.plan.complete.requested",
      { planId: updated.id },
      "ui/cleaning"
    );

    try {
      await upsertPlanPersist(updated, { op: "upsert" });
      setOptimistic((m) => ({ ...m, [updated.id]: null }));
      setToast({ tone: "success", text: "Marked completed." });
      emitSSA(
        "cleaning.plan.completed",
        { planId: updated.id, plan: updated },
        "ui/cleaning"
      );
    } catch (e) {
      await loadPlans();
      setOptimistic((m) => ({ ...m, [updated.id]: "error" }));
      setToast({ tone: "error", text: "Couldn’t mark completed." });
      emitSSA(
        "cleaning.plan.complete.failed",
        { planId: updated.id, error: String(e?.message || e) },
        "ui/cleaning"
      );
    }
  };

  const runPlanNow = async (plan) => {
    if (!plan) return;
    const draftLike = {
      id: plan.id,
      title: plan.title,
      steps: plan.steps,
      preferences: { zones: plan.zones, intensity: plan.intensity },
      draftType: "cleaning",
      domain: "cleaning",
      source: "plan-library",
      metrics: {
        estMinutes: Math.round(
          (plan.steps || []).reduce((a, s) => a + (s.durationSec || 0), 0) / 60
        ),
      },
    };
    const sess = await createSessionFromDraft(draftLike);
    startRunnerFor(sess);
  };

  /* ------------------------------------------------------------------------ */
  /* Plan Library derived state (search/filter)                                */
  /* ------------------------------------------------------------------------ */

  const allZones = useMemo(() => {
    const set = new Set();
    plans.forEach((p) => (p.zones || []).forEach((z) => set.add(z)));
    return Array.from(set).sort();
  }, [plans]);

  const filteredPlans = useMemo(() => {
    const q = String(planSearch || "")
      .toLowerCase()
      .trim();

    return (plans || [])
      .filter((p) => {
        if (!p) return false;
        if (filterStatus !== "all" && (p.status || "active") !== filterStatus)
          return false;
        if (
          filterIntensity !== "all" &&
          (p.intensity || "standard") !== filterIntensity
        )
          return false;
        if (filterZone !== "all" && !(p.zones || []).includes(filterZone))
          return false;
        if (!q) return true;
        const hay = `${p.title || ""} ${(p.zones || []).join(" ")} ${(
          p.tags || []
        ).join(" ")}`
          .toLowerCase()
          .trim();
        return hay.includes(q);
      })
      .sort((a, b) => {
        const at = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
        const bt = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
        return bt - at;
      });
  }, [plans, planSearch, filterIntensity, filterZone, filterStatus]);

  /* ------------------------------------------------------------------------ */
  /* Init agents worker listeners (kept behavior)                              */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    const client = createshimsClient();
    clientRef.current = client;

    const off1 = client.onProgress((d) =>
      setProgress({ phase: d?.phase ?? null, pct: d?.pct ?? 0 })
    );

    const off2 = client.onDraft((payload) => {
      const nextDraftRaw = payload?.draft || payload?.data?.draft || payload;
      if (!nextDraftRaw) return;

      const nextDraft = normalizeDraftToCleaning(nextDraftRaw, prefs);

      setDraft(nextDraft);
      setModalOpen(true);
      setBusy(false);
      setToast({ tone: "success", text: "Cleaning plan ready." });

      emitSSA(
        "cleaning.draft.ready",
        { draft: nextDraft, source: "agentsWorker" },
        "ui/cleaning"
      );
    });

    const off3 = client.onError((e) => {
      console.warn("[cleaning] worker error:", e);
      setToast({
        tone: "error",
        text: "Couldn’t generate — using a local fallback.",
      });
    });

    client.init().catch(() => {});

    return () => {
      [off1, off2, off3].forEach((off) => {
        try {
          off?.();
        } catch {}
      });
      try {
        client.shutdown();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------------------ */
  /* Hotkeys (kept, but now interactive)                                       */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    const onKey = (e) => {
      const k = (e.key || "").toLowerCase();
      if (k === "g") handleGenerate();
      if (k === "n") handleNow();
      if (k === "c" && (draft || plans.length)) handleCleanNow(draft);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, plans.length, runnable.length, prefs]);

  /* ------------------------------------------------------------------------ */
  /* Favorites sessions (kept)                                                 */
  /* ------------------------------------------------------------------------ */

  const isSessionFavorite = (s) =>
    !!(s && s.id && favoriteSessionIds.includes(s.id));
  const toggleFavoriteSession = (s) => {
    if (!s || !s.id) return;
    const exists = favoriteSessionIds.includes(s.id);
    setFavoriteSessionIds((prev) =>
      exists ? prev.filter((id) => id !== s.id) : [...prev, s.id]
    );
    setToast({
      tone: "info",
      text: exists
        ? "Removed from favorite routines."
        : "Saved as favorite routine.",
    });
    emitSSA(
      "cleaning.session.favorite.toggled",
      { sessionId: s.id, favorite: !exists },
      "ui/cleaning"
    );
  };

  const favoriteSessionsFull = useMemo(
    () => runnable.filter((s) => isSessionFavorite(s)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runnable, favoriteSessionIds]
  );

  const glanceSeasonRaw = useMemo(
    () =>
      findValueByCandidateKeys(householdGlance, [
        "season",
        "seasonKey",
        "currentSeason",
      ]),
    [householdGlance]
  );

  const seasonalKey = useMemo(() => {
    const candidate = String(glanceSeasonRaw || "").toLowerCase();
    if (["spring", "summer", "autumn", "winter"].includes(candidate)) {
      return candidate;
    }
    return getSeasonKey(new Date());
  }, [glanceSeasonRaw]);

  const seasonalLabel = useMemo(() => getSeasonLabel(seasonalKey), [seasonalKey]);
  const completedPlans = useMemo(
    () => (plans || []).filter((p) => p?.lastCompletedAt).length,
    [plans]
  );
  const glanceCompletion = useMemo(() => {
    const n = Number(
      findValueByCandidateKeys(householdGlance, [
        "cleaningCompletionPct",
        "completionPct",
        "completionPercent",
        "completion",
      ])
    );
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  }, [householdGlance]);

  const completionPct = useMemo(() => {
    if (Number.isFinite(glanceCompletion)) return glanceCompletion;
    if (!plans.length) return 0;
    return Math.round((completedPlans / plans.length) * 100);
  }, [glanceCompletion, completedPlans, plans]);

  const glanceParticipation = useMemo(
    () =>
      normalizeParticipationEntries(
        findValueByCandidateKeys(householdGlance, [
          "participation",
          "participationEntries",
          "householdParticipation",
          "members",
        ])
      ),
    [householdGlance]
  );

  const participationEntries = useMemo(
    () =>
      glanceParticipation || [
        { name: "Plans", value: plans.length },
        { name: "Ready Runs", value: runnable.length },
        { name: "Favorites", value: favoriteSessionsFull.length },
      ],
    [glanceParticipation, plans.length, runnable.length, favoriteSessionsFull.length]
  );

  /* ------------------------------------------------------------------------ */
  /* Render                                                                    */
  /* ------------------------------------------------------------------------ */

  return (
    <div className="cook-page cleaning-page">
      <div className="cook-page-inner sv-container">
        {/* Hero */}
        <div className="sv-hero sv-pad ssa-hero-wrap">
          <div className="sv-row sv-justify-between sv-align-center">
            <div className="sv-row">
              <span className="sv-emoji">🧹</span>
              <h1 className="sv-pageTitle ssa-hero-title">Cleaning</h1>
              <CollaborationChip household="Household" status="assigned" />
            </div>

            <div className="sv-row sv-gap ssa-hero-actions">
              <Button
                onClick={handleNow}
                title="Open SessionRunner now (hotkey: N)"
              >
                Now
              </Button>
              <div className="sv-caption" style={{ alignSelf: "center" }}>
                {runnable.length
                  ? `${runnable.length} ready`
                  : "builds from current plan"}
              </div>
            </div>
          </div>

          <div className="sv-row sv-align-center" style={{ marginTop: 8, gap: 10 }}>
            <SSAAnimalAvatar animal="goats" label="Homestead Rhythm" size="sm" />
            <span className="sv-caption">Season: {seasonalLabel}</span>
          </div>

          <p className="sv-muted ssa-hero-subtitle">
            Generate cleaning plans with steps + timers, save them to your Plan
            Library, and run hands-free with the SessionRunner.
          </p>
        </div>

        {/* Banners */}
        {banners.map((b) => (
          <Banner
            key={b.key}
            tone={b.tone}
            onDismiss={
              b.dismissible === false ? undefined : () => bannerDismiss(b.key)
            }
          >
            {b.content || b.text}
          </Banner>
        ))}

        <div className="sv-row sv-gap sv-wrap" style={{ marginTop: 16 }}>
          <div style={{ flex: "1 1 260px", minWidth: 240 }}>
            <SSAGrowthOverlay
              label="Seasonal Completion"
              value={completionPct}
              className="ssa-seasonal-card"
            />
          </div>
          <div style={{ flex: "1 1 260px", minWidth: 240 }}>
            <SSASeasonalTaskHighlight
              season={seasonalKey}
              title={`${seasonalLabel} Household Focus`}
              detail="Keep high-traffic zones clean before meal prep and evening routines."
              urgency={zones.length >= 4 ? "high" : "normal"}
            />
          </div>
          <div style={{ flex: "1 1 260px", minWidth: 240 }}>
            <SSAHouseholdParticipation
              label="Cleaning Participation"
              entries={participationEntries}
            />
          </div>
        </div>

        {/* Plan Library + Favorites row */}
        <div
          className="sv-row sv-gap sv-wrap"
          style={{ alignItems: "stretch", marginTop: 16 }}
        >
          {/* Plan Library (NEW interactive module) */}
          <Card className="sv-pad" style={{ flex: "2 1 520px", minWidth: 320 }}>
            <SectionHeader
              icon="📚"
              title="Plan Library"
              sub="Create, edit, search, filter, duplicate, complete, and run plans."
              right={
                <div className="sv-row sv-gap sv-wrap">
                  <Button
                    variant="outline"
                    onClick={() => {
                      if (!draft) {
                        setToast({
                          tone: "info",
                          text: "Generate a plan first (G) or use an existing plan.",
                        });
                        return;
                      }
                      createPlanFromDraft(draft);
                    }}
                    disabled={!draft}
                    title={
                      !draft
                        ? "Generate a plan first"
                        : "Save current draft as a plan"
                    }
                  >
                    Save Draft → Library
                  </Button>
                  <Button
                    variant="outline"
                    onClick={loadPlans}
                    title="Reload plans"
                  >
                    Refresh
                  </Button>
                </div>
              }
            />

            {planError ? (
              <div className="sv-muted sv-text-sm" style={{ marginBottom: 8 }}>
                ⚠ {planError}
              </div>
            ) : null}

            <div className="sv-row sv-gap sv-wrap">
              <Input
                label="Search"
                value={planSearch}
                onChange={setPlanSearch}
                placeholder="Search title, zones, tags…"
              />

              <label className="sv-field" style={{ minWidth: 180 }}>
                <span className="sv-field__label">Intensity</span>
                <select
                  className="sv-input"
                  value={filterIntensity}
                  onChange={(e) => setFilterIntensity(e.target.value)}
                >
                  <option value="all">All</option>
                  <option value="light">Light</option>
                  <option value="standard">Standard</option>
                  <option value="deep">Deep</option>
                </select>
              </label>

              <label className="sv-field" style={{ minWidth: 180 }}>
                <span className="sv-field__label">Zone</span>
                <select
                  className="sv-input"
                  value={filterZone}
                  onChange={(e) => setFilterZone(e.target.value)}
                >
                  <option value="all">All</option>
                  {allZones.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              </label>

              <label className="sv-field" style={{ minWidth: 180 }}>
                <span className="sv-field__label">Status</span>
                <select
                  className="sv-input"
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                >
                  <option value="active">Active</option>
                  <option value="archived">Archived</option>
                  <option value="all">All</option>
                </select>
              </label>
            </div>

            <div className="sv-stack-sm" style={{ marginTop: 12 }}>
              {!plansLoaded ? (
                <div className="sv-muted sv-text-sm">Loading plans…</div>
              ) : filteredPlans.length ? (
                filteredPlans.map((p) => {
                  const isEditing = editingPlanId === p.id;
                  const busyFlag = optimistic[p.id];

                  return (
                    <div
                      key={p.id}
                      className="sv-card sv-pad"
                      style={{
                        borderRadius: 12,
                        opacity: busyFlag === "deleting" ? 0.6 : 1,
                      }}
                    >
                      <div
                        className="sv-row sv-justify-between sv-align-center sv-wrap"
                        style={{ gap: 10 }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div
                            className="sv-row sv-align-center"
                            style={{ gap: 8 }}
                          >
                            <div className="sv-strong sv-ellipsis">
                              {p.title || "Cleaning Plan"}
                            </div>
                            <span className="sv-badge ssa-hero-chip">
                              {p.intensity || "standard"}
                            </span>
                            {busyFlag === "saving" ? (
                              <span className="sv-caption">Saving…</span>
                            ) : null}
                            {busyFlag === "error" ? (
                              <span className="sv-caption sv-danger">
                                Error
                              </span>
                            ) : null}
                          </div>

                          <div className="sv-caption">
                            {(p.zones || []).join(", ") || "—"} •{" "}
                            {(p.steps || []).length} steps •{" "}
                            {p.lastCompletedAt
                              ? `Last done: ${new Date(
                                  p.lastCompletedAt
                                ).toLocaleDateString()}`
                              : "Not completed yet"}{" "}
                            {Number.isFinite(p.completedCount)
                              ? `• Count: ${p.completedCount}`
                              : ""}
                          </div>
                        </div>

                        <div className="sv-row sv-gap sv-wrap">
                          <Button
                            variant="primary"
                            onClick={() => runPlanNow(p)}
                          >
                            ▶ Run
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => {
                              const d = {
                                id: `draft_from_plan_${p.id}`,
                                title: p.title,
                                steps: p.steps,
                                preferences: {
                                  zones: p.zones,
                                  intensity: p.intensity,
                                },
                                draftType: "cleaning",
                                domain: "cleaning",
                                source: "plan-library",
                              };
                              setDraft(normalizeDraftToCleaning(d, prefs));
                              setModalOpen(true);
                            }}
                          >
                            Preview
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => duplicatePlan(p)}
                          >
                            Duplicate
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => markPlanCompleted(p)}
                          >
                            ✓ Completed
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() =>
                              isEditing ? cancelEdit() : beginEdit(p)
                            }
                          >
                            {isEditing ? "Cancel" : "Edit"}
                          </Button>
                          <Button variant="ghost" onClick={() => deletePlan(p)}>
                            Delete
                          </Button>
                        </div>
                      </div>

                      {isEditing ? (
                        <div className="sv-stack-sm" style={{ marginTop: 12 }}>
                          <div className="sv-row sv-gap sv-wrap">
                            <Input
                              label="Title"
                              value={editTitle}
                              onChange={setEditTitle}
                              placeholder="Plan title"
                            />
                            <label
                              className="sv-field"
                              style={{ minWidth: 180 }}
                            >
                              <span className="sv-field__label">Intensity</span>
                              <select
                                className="sv-input"
                                value={editIntensity}
                                onChange={(e) =>
                                  setEditIntensity(e.target.value)
                                }
                              >
                                <option value="light">Light</option>
                                <option value="standard">Standard</option>
                                <option value="deep">Deep</option>
                              </select>
                            </label>
                          </div>

                          <div className="sv-row sv-gap sv-wrap">
                            {[
                              "Kitchen",
                              "Bathroom",
                              "Living Room",
                              "Bedrooms",
                              "Entry",
                              "Dining",
                              "Office",
                              "Laundry",
                            ].map((z) => (
                              <Chip
                                key={z}
                                active={editZones.includes(z)}
                                onClick={() =>
                                  setEditZones((prev) =>
                                    prev.includes(z)
                                      ? prev.filter((x) => x !== z)
                                      : [...prev, z]
                                  )
                                }
                              >
                                {z}
                              </Chip>
                            ))}
                          </div>

                          <div className="sv-stack-sm">
                            <div className="sv-caption caps">Steps</div>
                            {(editSteps || []).map((s, idx) => (
                              <div
                                key={s.id || `${p.id}_step_${idx}`}
                                className="sv-row sv-gap sv-wrap sv-align-center"
                              >
                                <label
                                  className="sv-field"
                                  style={{ flex: "2 1 320px", minWidth: 260 }}
                                >
                                  <span className="sv-field__label">
                                    {idx + 1}
                                  </span>
                                  <input
                                    className="sv-input"
                                    value={s.title || s.desc || ""}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      setEditSteps((prev) =>
                                        prev.map((x, i) =>
                                          i === idx
                                            ? { ...x, title: val, desc: val }
                                            : x
                                        )
                                      );
                                    }}
                                  />
                                </label>

                                <label
                                  className="sv-field"
                                  style={{ width: 160 }}
                                >
                                  <span className="sv-field__label">
                                    Minutes
                                  </span>
                                  <input
                                    className="sv-input"
                                    type="number"
                                    min="0"
                                    value={Math.round(
                                      (s.durationSec || 0) / 60
                                    )}
                                    onChange={(e) => {
                                      const mins = Math.max(
                                        0,
                                        Number(e.target.value || 0)
                                      );
                                      setEditSteps((prev) =>
                                        prev.map((x, i) =>
                                          i === idx
                                            ? { ...x, durationSec: mins * 60 }
                                            : x
                                        )
                                      );
                                    }}
                                  />
                                </label>

                                <Button
                                  variant="ghost"
                                  onClick={() =>
                                    setEditSteps((prev) =>
                                      prev.filter((_, i) => i !== idx)
                                    )
                                  }
                                >
                                  Remove
                                </Button>
                              </div>
                            ))}

                            <div className="sv-row sv-gap">
                              <Button
                                variant="outline"
                                onClick={() =>
                                  setEditSteps((prev) => [
                                    ...prev,
                                    {
                                      id: makeId("step"),
                                      title: "New step",
                                      desc: "New step",
                                      durationSec: 5 * 60,
                                      blockers: [
                                        "quietHours",
                                        "sabbath",
                                        "equipment",
                                      ],
                                      metadata: { cueNotes: "" },
                                    },
                                  ])
                                }
                              >
                                + Add step
                              </Button>

                              <Button onClick={saveEdits}>Save changes</Button>
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })
              ) : (
                <div className="sv-muted sv-text-sm">
                  No plans found. Generate a plan and save it to your Library.
                </div>
              )}
            </div>
          </Card>

          {/* Favorite routines strip (kept) */}
          <Card className="sv-pad" style={{ flex: "1 1 320px", minWidth: 280 }}>
            <SectionHeader
              icon="⭐"
              title="Favorite Routines"
              sub="Star sessions in the Now picker to pin them here."
            />
            {favoriteSessionsFull.length ? (
              <ul className="sv-stack-sm sv-text-sm">
                {favoriteSessionsFull.map((s) => (
                  <li
                    key={s.id}
                    className="sv-row sv-justify-between sv-align-center sv-card sv-pad"
                    style={{ borderRadius: 10 }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div className="sv-strong sv-ellipsis">
                        {s.title || "Cleaning Session"}
                      </div>
                      <div className="sv-caption">
                        {s?.steps?.length ?? 0} steps •{" "}
                        {s?.progress?.startedAt ? "Resume" : "Fresh"}
                      </div>
                    </div>
                    <div className="sv-row sv-gap">
                      <Button
                        variant="primary"
                        onClick={() => startRunnerFor(s)}
                      >
                        ▶ Run
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => toggleFavoriteSession(s)}
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="sv-muted sv-text-sm">
                No favorite routines yet. Open <strong>Now</strong> and star a
                routine (☆).
              </div>
            )}
          </Card>
        </div>

        {/* Backend hints (optional) */}
        {backendHints ? (
          <Card className="sv-pad sv-block" style={{ marginTop: 16 }}>
            <SectionHeader
              icon="✨"
              title="Personalized Suggestions"
              sub="Backend intelligence based on your routines and preferences."
            />
            <div className="sv-stack-sm sv-text-sm">
              {backendHints.message ? (
                <p className="sv-muted">{backendHints.message}</p>
              ) : null}
              {Array.isArray(backendHints.suggestions) &&
              backendHints.suggestions.length ? (
                <ul className="sv-list">
                  {backendHints.suggestions.map((s, idx) => (
                    <li key={idx}>{s}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </Card>
        ) : null}

        {/* Generate panel (kept patterns) */}
        <Card className="sv-pad sv-block" style={{ marginTop: 16 }}>
          <SectionHeader
            icon="🧭"
            title="Generate Cleaning Plan"
            sub="Choose zones and intensity; we’ll build steps and timers."
            right={
              busy ? (
                <div className="sv-row sv-gap">
                  <ProgressBar pct={progress.pct} />
                  <div className="sv-caption">
                    {(progress.phase || "working…").toString()} •{" "}
                    {Math.round(progress.pct || 0)}%
                  </div>
                </div>
              ) : null
            }
          />

          <div className="sv-row sv-gap sv-wrap">
            <Input
              label="Title"
              value={title}
              onChange={setTitle}
              placeholder="Cleaning Session"
            />

            <label className="sv-field">
              <span className="sv-field__label">Intensity</span>
              <div className="sv-wrap">
                <Chip
                  active={intensity === "light"}
                  onClick={() => setIntensity("light")}
                >
                  Light
                </Chip>
                <Chip
                  active={intensity === "standard"}
                  onClick={() => setIntensity("standard")}
                >
                  Standard
                </Chip>
                <Chip
                  active={intensity === "deep"}
                  onClick={() => setIntensity("deep")}
                >
                  Deep
                </Chip>
              </div>
              <div className="sv-caption">{intensityLabel}</div>
            </label>
          </div>

          <div className="sv-row sv-gap sv-wrap">
            {[
              "Kitchen",
              "Bathroom",
              "Living Room",
              "Bedrooms",
              "Entry",
              "Dining",
              "Office",
              "Laundry",
            ].map((z) => (
              <Chip
                key={z}
                active={zones.includes(z)}
                onClick={() =>
                  setZones((prev) =>
                    prev.includes(z)
                      ? prev.filter((x) => x !== z)
                      : [...prev, z]
                  )
                }
              >
                {z}
              </Chip>
            ))}
          </div>

          <div className="sv-row sv-gap sv-wrap">
            <Toggle
              label="Sabbath-aware"
              checked={sabbathAware}
              onChange={setSabbathAware}
            />
            <Toggle
              label="Quiet hours guard"
              checked={quietAware}
              onChange={setQuietAware}
            />
            <Toggle
              label="Pets present"
              checked={petsPresent}
              onChange={setPetsPresent}
            />
          </div>

          <div className="sv-row sv-gap">
            <Button
              onClick={handleGenerate}
              disabled={busy}
              title="Shortcut: G"
            >
              Generate plan
            </Button>

            {draft ? (
              <>
                <Button variant="outline" onClick={() => setModalOpen(true)}>
                  Preview draft
                </Button>
                <Button
                  variant="outline"
                  onClick={() => createPlanFromDraft(draft)}
                >
                  Save to Library
                </Button>
                <Button
                  onClick={() => handleCleanNow(draft)}
                  title="Shortcut: C"
                >
                  Clean Now
                </Button>
              </>
            ) : null}
          </div>
        </Card>

        {/* Planner (kept) */}
        <Card className="sv-pad sv-block" style={{ marginTop: 16 }}>
          <SectionHeader
            icon="🧩"
            title="Cleaning Planner"
            sub="Adjust steps, order, and supplies before you run."
          />
          <CleaningSessionPlanner
            onDraftReady={(raw) => {
              const cleaned = normalizeDraftToCleaning(raw, prefs);
              setDraft(cleaned);
              setModalOpen(true);
              emitSSA(
                "cleaning.draft.ready",
                { draft: cleaned, source: "planner" },
                "ui/cleaning"
              );
            }}
          />
        </Card>

        {/* Timers (kept) */}
        {draft ? (
          <Card className="sv-pad sv-block" style={{ marginTop: 16 }}>
            <SectionHeader
              icon="⏱️"
              title="Multi-Timers"
              sub="Start timers, get voice alerts, and jump to steps."
            />
            <MultiTimerPanel draft={draftToPlay(draft)} />
          </Card>
        ) : null}

        <Card className="sv-pad sv-block" style={{ marginTop: 16 }}>
          <SectionHeader
            icon="🧭"
            title="Household Today and Upcoming"
            sub="Cross-module recurrence, dependency, and conflict cues."
            right={
              <Button variant="outline" onClick={fetchHouseholdAgenda}>
                Refresh agenda
              </Button>
            }
          />
          <div
            className="sv-grid"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", marginBottom: 8 }}
          >
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span className="sv-muted">Module</span>
              <select
                value={agendaFilters.module}
                onChange={(event) =>
                  setAgendaFilters((prev) => ({ ...prev, module: String(event.target.value || "") }))
                }
              >
                <option value="">All</option>
                <option value="meal">meal</option>
                <option value="cleaning">cleaning</option>
                <option value="storehouse">storehouse</option>
                <option value="homestead">homestead</option>
                <option value="community">community</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span className="sv-muted">Priority</span>
              <select
                value={agendaFilters.priority}
                onChange={(event) =>
                  setAgendaFilters((prev) => ({ ...prev, priority: String(event.target.value || "") }))
                }
              >
                <option value="">All</option>
                <option value="critical">critical</option>
                <option value="high">high</option>
                <option value="normal">normal</option>
                <option value="low">low</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span className="sv-muted">Status</span>
              <select
                value={agendaFilters.status}
                onChange={(event) =>
                  setAgendaFilters((prev) => ({ ...prev, status: String(event.target.value || "") }))
                }
              >
                <option value="">All</option>
                <option value="blocked">blocked</option>
                <option value="pending_approval">pending_approval</option>
                <option value="active">active</option>
                <option value="draft">draft</option>
                <option value="planned">planned</option>
                <option value="completed">completed</option>
                <option value="archived">archived</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span className="sv-muted">Sort</span>
              <select
                value={agendaFilters.sortBy}
                onChange={(event) =>
                  setAgendaFilters((prev) => ({ ...prev, sortBy: String(event.target.value || "dueAt") }))
                }
              >
                <option value="dueAt">dueAt</option>
                <option value="priority">priority</option>
                <option value="status">status</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span className="sv-muted">Direction</span>
              <select
                value={agendaFilters.sortDirection}
                onChange={(event) =>
                  setAgendaFilters((prev) => ({ ...prev, sortDirection: String(event.target.value || "desc") }))
                }
              >
                <option value="desc">desc</option>
                <option value="asc">asc</option>
              </select>
            </label>
          </div>
          <div className="sv-row sv-gap sv-wrap" style={{ marginBottom: 8 }}>
            <input
              type="text"
              value={agendaPersonDraft}
              onChange={(event) => setAgendaPersonDraft(String(event.target.value || ""))}
              placeholder="Filter by person handle"
              style={{ flex: "1 1 220px" }}
            />
            <Button
              variant="outline"
              onClick={() =>
                setAgendaFilters((prev) => ({
                  ...prev,
                  person: String(agendaPersonDraft || "").trim().toLowerCase(),
                }))
              }
            >
              Apply Person
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setAgendaPersonDraft("");
                setAgendaFilters({
                  person: "",
                  module: "",
                  priority: "",
                  status: "",
                  sortBy: "dueAt",
                  sortDirection: "desc",
                });
              }}
            >
              Reset Filters
            </Button>
          </div>
          {householdAgendaBusy &&
          !householdAgenda.today.length &&
          !householdAgenda.upcoming.length ? (
            <div className="sv-muted sv-text-sm">Loading household agenda…</div>
          ) : (
            <div className="sv-stack-sm">
              <div className="sv-muted" style={{ fontSize: 12 }}>
                Applied: {String(householdAgenda?.applied?.filters?.module || "all modules")}
                {householdAgenda?.applied?.filters?.priority
                  ? ` | ${String(householdAgenda.applied.filters.priority)} priority`
                  : ""}
                {householdAgenda?.applied?.filters?.status
                  ? ` | ${String(householdAgenda.applied.filters.status)} status`
                  : ""}
                {householdAgenda?.applied?.filters?.person
                  ? ` | person ${String(householdAgenda.applied.filters.person)}`
                  : ""}
                {` | sort ${String(householdAgenda?.applied?.sortBy || "dueAt")}:${String(householdAgenda?.applied?.sortDirection || "desc")}`}
              </div>
              <div className="sv-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
                <div className="sv-stack-sm">
                  <div className="sv-caption caps">Today</div>
                  {householdAgenda.today.length ? (
                    <ul className="sv-list sv-text-sm">
                      {householdAgenda.today.slice(0, 4).map((item) => (
                        <li key={item.id}>
                          <div className="sv-strong">{item.title}</div>
                          <div className="sv-muted" style={{ fontSize: 11 }}>
                            {agendaCueLine(item)}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="sv-muted sv-text-sm">No items for today.</div>
                  )}
                </div>
                <div className="sv-stack-sm">
                  <div className="sv-caption caps">Upcoming</div>
                  {householdAgenda.upcoming.length ? (
                    <ul className="sv-list sv-text-sm">
                      {householdAgenda.upcoming.slice(0, 4).map((item) => (
                        <li key={item.id}>
                          <div className="sv-strong">{item.title}</div>
                          <div className="sv-muted" style={{ fontSize: 11 }}>
                            {agendaCueLine(item)}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="sv-muted sv-text-sm">No upcoming items.</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </Card>

        {/* Household Glance (optional kept) */}
        <Card className="sv-pad sv-block" style={{ marginTop: 16 }}>
          <SectionHeader
            icon="🏡"
            title="Household Glance"
            sub="Cleaning aligned with meals, garden, animals, and storehouse."
            right={
              <Button variant="outline" onClick={fetchHouseholdGlance}>
                Refresh glance
              </Button>
            }
          />
          {householdGlance ? (
            <div className="sv-stack-sm sv-text-sm">
              <pre className="sv-code" style={{ whiteSpace: "pre-wrap" }}>
                {JSON.stringify(householdGlance, null, 2)}
              </pre>
            </div>
          ) : (
            <div className="sv-muted sv-text-sm">
              We’ll show a glance once the automation runtime exposes{" "}
              <code>household.glance</code>.
            </div>
          )}
        </Card>

        {/* Draft Modal (kept, but includes save/run actions) */}
        {modalOpen && draft ? (
          <div className="sv-modal">
            <Card className="sv-modal__card">
              <div className="sv-modal__head">
                <div>
                  <div className="sv-modal__title">
                    {draft.title || "Cleaning Session"}
                  </div>
                  <div className="sv-muted">
                    {draft.steps?.length ?? 0} steps • ~{" "}
                    {draft.metrics?.estMinutes ?? 0} min
                  </div>
                </div>
              </div>

              <div className="sv-modal__body sv-stack">
                <div className="sv-caption caps">Steps</div>
                <ol className="sv-list sv-list--decimal">
                  {(draft.steps || []).map((s) => (
                    <li key={s.id}>
                      <span className="sv-strong">{s.title || s.desc}</span>
                      {s.durationSec ? (
                        <span className="sv-muted">
                          {" "}
                          • ~{Math.round((s.durationSec || 0) / 60)}m
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>

              <div className="sv-row sv-justify-end sv-pad sv-wrap sv-gap">
                <Button variant="ghost" onClick={() => setModalOpen(false)}>
                  Close
                </Button>
                <Button
                  variant="outline"
                  onClick={() => createPlanFromDraft(draft)}
                >
                  Save to Library
                </Button>
                <Button variant="outline" onClick={() => handleCleanNow(draft)}>
                  Clean Now
                </Button>
                <Button onClick={handleNow}>Now</Button>
              </div>
            </Card>
          </div>
        ) : null}

        {/* Swap modal for multiple runnable sessions (kept) */}
        <SessionSwapModal
          open={swapOpen}
          onClose={() => setSwapOpen(false)}
          sessions={runnable}
          onSelect={handleSwapSelect}
          isFavorite={isSessionFavorite}
          onToggleFavorite={toggleFavoriteSession}
        />

        {/* Toast */}
        {toast ? (
          <div className="sv-toastWrap">
            <Toast
              tone={toast.tone}
              text={toast.text}
              action={toast.action}
              onClose={() => setToast(null)}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* NOTE: This page requires a Dexie table "cleaningPlans" for full persistence */
/* -------------------------------------------------------------------------- */
