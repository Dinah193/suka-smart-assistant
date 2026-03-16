// C:\Users\larho\suka-smart-assistant\src\components\knowledgeHelper\KnowledgeHelperPanel.jsx
/* eslint-disable no-console */
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  Sparkles,
  ShieldAlert,
  Wrench,
  BookOpen,
  Filter,
  ChevronDown,
  ChevronUp,
  X,
  Save,
  RefreshCw,
  Tag,
  Clock,
  LayoutGrid,
  List,
  ExternalLink,
} from "lucide-react";

import SafetyAlertCard from "./SafetyAlertCard";
import SkillCard from "./SkillCard";
import Troubleshooter from "./Troubleshooter";

/**
 * SSA • Knowledge Helper • KnowledgeHelperPanel
 * -----------------------------------------------------------------------------
 * Orchestrates Knowledge Helper experiences:
 *  - Skills: curated "how-to" cards with step checklists
 *  - Troubleshooter: guided problem diagnosis + checklists + safety
 *  - Safety: aggregated safety alerts surfaced from skills/troubleshooter
 *
 * Production features
 *  - Deterministic & browser-safe (no Node imports)
 *  - Optional Dexie persistence (best-effort): saves "recent skills", "pinned",
 *    and "last troubleshooter session inputs"
 *  - Optional eventBus emit hooks (best-effort)
 *  - Search + filter by domain, level, tags
 *  - Graceful fallback if db/eventBus are not present
 *
 * -----------------------------------------------------------------------------
 * Props
 *  - householdId: string
 *  - userId: string (optional)
 *  - domain: string (current app context; e.g. cooking|cleaning|garden)
 *  - title: string (optional)
 *  - compact: boolean
 *  - defaultTab: "skills"|"troubleshoot"|"safety"
 *
 *  Data
 *  - skills: array of skill objects (see SkillCard docs)
 *  - safetyAlerts: array of alert objects (see SafetyAlertCard)
 *  - issueTemplates: array of Troubleshooter templates (optional)
 *
 *  Hooks
 *  - onClose: () => void
 *  - onSkillAction: (actionId, skill) => void
 *  - onTroubleshooterCompleted: (payload) => void
 *  - onPinnedChange: (pinnedIds) => void
 *
 * -----------------------------------------------------------------------------
 * Suggested Dexie tables (optional)
 *  - knowledgePinned: "&key, householdId, userId, updatedAt, value"
 *  - knowledgeRecent: "&key, householdId, userId, updatedAt, value"
 *  - kv/settings/appSettings: fallback
 *
 * Events (stable)
 *  - knowledge.panel.opened
 *  - knowledge.panel.updated
 *  - knowledge.panel.pinned.changed
 *  - knowledge.panel.recent.changed
 */

const DEFAULT_SOURCE = "components/knowledgeHelper/KnowledgeHelperPanel";

const EVENTS = Object.freeze({
  OPENED: "knowledge.panel.opened",
  UPDATED: "knowledge.panel.updated",
  PINNED_CHANGED: "knowledge.panel.pinned.changed",
  RECENT_CHANGED: "knowledge.panel.recent.changed",
});

const PINNED_KEY = "knowledgeHelper.pinned.v1";
const RECENT_KEY = "knowledgeHelper.recent.v1";
const LAST_TROUBLESHOOTER_KEY = "knowledgeHelper.lastTroubleshooter.v1";

const TAB = Object.freeze({
  SKILLS: "skills",
  TROUBLESHOOT: "troubleshoot",
  SAFETY: "safety",
});

const VIEW = Object.freeze({
  GRID: "grid",
  LIST: "list",
});

const LEVELS = ["beginner", "intermediate", "advanced"];

const STORE_TABLE_CANDIDATES = Object.freeze([
  "knowledgePinned",
  "knowledgeRecent",
  "knowledgeHelper",
  "kv",
  "settings",
  "appSettings",
]);

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function nowISO() {
  return new Date().toISOString();
}
function normalizeStr(v) {
  if (v == null) return "";
  return String(v).trim();
}
function normalizeArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => normalizeStr(x)).filter(Boolean);
}
function safeUrl(u) {
  const s = normalizeStr(u);
  if (!s) return "";
  try {
    const url = new URL(s, window.location.origin);
    const proto = url.protocol.toLowerCase();
    if (proto === "http:" || proto === "https:") return url.toString();
    return "";
  } catch {
    return "";
  }
}
function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}
function jclone(x) {
  return x == null ? x : JSON.parse(JSON.stringify(x));
}
function randomId(prefix = "kh") {
  const rnd =
    globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Math.random().toString(16).slice(2)}${Math.random()
          .toString(16)
          .slice(2)}`;
  return `${prefix}_${rnd.replace(/-/g, "").slice(0, 18)}`;
}
function formatWhen(iso) {
  const s = normalizeStr(iso);
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function getDbAndBus() {
  let db = null;
  let eventBus = null;

  try {
    const mod = await import("@/services/db");
    db = mod.db || mod.default || null;
  } catch {
    try {
      const mod = await import("../../services/db");
      db = mod.db || mod.default || null;
    } catch {
      // ignore
    }
  }

  try {
    const mod = await import("@/services/events/eventBus");
    eventBus = mod.eventBus || mod.default || null;
  } catch {
    try {
      const mod = await import("../../services/events/eventBus");
      eventBus = mod.eventBus || mod.default || null;
    } catch {
      // ignore
    }
  }

  return { db, eventBus };
}

function hasTable(db, name) {
  try {
    if (!db?.tables) return false;
    return db.tables.some((t) => t?.name === name);
  } catch {
    return false;
  }
}

function pickTable(db, candidates) {
  for (const n of candidates) if (hasTable(db, n)) return n;
  return null;
}

function emit(bus, evt, payload) {
  try {
    if (!bus) return;
    if (typeof bus.emit === "function") bus.emit(evt, payload);
    else if (typeof bus.publish === "function") bus.publish(evt, payload);
  } catch (e) {
    console.warn("[KnowledgeHelperPanel] event emit failed:", evt, e);
  }
}

/**
 * KV-like store API (best-effort):
 * - supports either a dedicated table with { key, value } OR Dexie-style { id }
 */
async function loadKey({ householdId, userId, key }) {
  const { db } = await getDbAndBus();
  if (!db) return null;

  const tableName = pickTable(db, STORE_TABLE_CANDIDATES);
  if (!tableName) return null;

  try {
    const t = db.table(tableName);
    const scopedKey = `${normalizeStr(householdId) || "global"}:${
      normalizeStr(userId) || "anon"
    }:${key}`;
    // Try common shapes:
    const row =
      (await t.get(scopedKey)) ||
      (await t.get({ key: scopedKey })) ||
      (await t.get({ id: scopedKey })) ||
      null;

    if (!row) return null;
    if (row.value != null) return row.value;
    if (row.payload != null) return row.payload;
    return row;
  } catch (e) {
    console.warn("[KnowledgeHelperPanel] loadKey failed", e);
    return null;
  }
}

async function saveKey({ householdId, userId, key, value }) {
  const { db } = await getDbAndBus();
  if (!db) return { ok: false, mode: "none" };

  const tableName = pickTable(db, STORE_TABLE_CANDIDATES);
  if (!tableName) return { ok: false, mode: "none" };

  try {
    const t = db.table(tableName);
    const scopedKey = `${normalizeStr(householdId) || "global"}:${
      normalizeStr(userId) || "anon"
    }:${key}`;
    const row = {
      key: scopedKey,
      id: scopedKey,
      householdId: normalizeStr(householdId) || null,
      userId: normalizeStr(userId) || null,
      updatedAt: nowISO(),
      value: jclone(value),
    };
    await t.put(row);
    return { ok: true, mode: "table", table: tableName };
  } catch (e) {
    console.warn("[KnowledgeHelperPanel] saveKey failed", e);
    return { ok: false, mode: "none" };
  }
}

function Pill({ icon, children }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-white/70 border border-black/5 px-2 py-0.5 text-xs text-slate-700">
      {icon ? (
        <span className="inline-flex h-3.5 w-3.5 items-center justify-center">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}

function Chip({ active, children, onClick, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded-full px-3 py-1 text-xs font-medium border",
        active
          ? "bg-slate-900 text-white border-slate-900"
          : "bg-white text-slate-800 border-slate-200 hover:bg-slate-50",
      ].join(" ")}
      title={title}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function IconButton({ onClick, title, children, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!!disabled}
      className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white p-2 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      title={title}
      aria-label={title}
    >
      {children}
    </button>
  );
}

function normalizeSkill(s) {
  const o = isObj(s) ? s : {};
  const id = normalizeStr(o.id) || randomId("skill");
  return {
    ...o,
    id,
    title: normalizeStr(o.title) || "Skill",
    subtitle: normalizeStr(o.subtitle) || "",
    domain: normalizeStr(o.domain) || "",
    level: LEVELS.includes(normalizeStr(o.level).toLowerCase())
      ? normalizeStr(o.level).toLowerCase()
      : "beginner",
    durationMins: Number.isFinite(Number(o.durationMins))
      ? Number(o.durationMins)
      : null,
    tags: normalizeArray(o.tags),
    safetyAlerts: Array.isArray(o.safetyAlerts) ? o.safetyAlerts : [],
    steps: Array.isArray(o.steps) ? o.steps : [],
    sources: Array.isArray(o.sources) ? o.sources : [],
    updatedAt: normalizeStr(o.updatedAt || ""),
    createdAt: normalizeStr(o.createdAt || ""),
  };
}

function collectSafetyAlertsFromSkills(skills) {
  const alerts = [];
  for (const sk of skills) {
    const arr = Array.isArray(sk?.safetyAlerts) ? sk.safetyAlerts : [];
    arr.forEach((a) => {
      if (!a) return;
      alerts.push({
        ...a,
        // keep original id if present; add fallback
        id: a.id || `${sk.id}_alert_${Math.random().toString(16).slice(2)}`,
        // helpful tags
        tags: Array.isArray(a.tags) ? a.tags : [],
        domains: Array.isArray(a.domains)
          ? a.domains
          : sk.domain
          ? [sk.domain]
          : [],
      });
    });
  }
  return alerts;
}

function scoreSkillMatch(skill, q) {
  const query = normalizeStr(q).toLowerCase();
  if (!query) return 0;

  const hay = [
    skill.title,
    skill.subtitle,
    skill.domain,
    (skill.tags || []).join(" "),
    normalizeArray(skill.tools).join(" "),
    normalizeArray(skill.materials).join(" "),
  ]
    .join(" ")
    .toLowerCase();

  // simplistic scoring: title hit > tag hit > elsewhere
  let score = 0;
  if (skill.title.toLowerCase().includes(query)) score += 5;
  if (skill.subtitle.toLowerCase().includes(query)) score += 3;
  if (skill.domain.toLowerCase().includes(query)) score += 2;
  if ((skill.tags || []).some((t) => t.toLowerCase().includes(query)))
    score += 2;
  if (hay.includes(query)) score += 1;
  return score;
}

export default function KnowledgeHelperPanel({
  householdId = "",
  userId = "",
  domain = "",
  title = "Knowledge Helper",
  compact = false,
  defaultTab = TAB.SKILLS,
  skills = [],
  safetyAlerts = [],
  issueTemplates = null,
  onClose,
  onSkillAction,
  onTroubleshooterCompleted,
  onPinnedChange,
}) {
  const panelId = useMemo(() => randomId("khp"), []);
  const pad = compact ? "p-3" : "p-4";

  const normalizedSkills = useMemo(
    () => (Array.isArray(skills) ? skills.map(normalizeSkill) : []),
    [skills]
  );

  const [tab, setTab] = useState(
    [TAB.SKILLS, TAB.TROUBLESHOOT, TAB.SAFETY].includes(defaultTab)
      ? defaultTab
      : TAB.SKILLS
  );
  const [view, setView] = useState(VIEW.GRID);

  const [query, setQuery] = useState("");
  const [filterDomain, setFilterDomain] = useState(domain || "");
  const [filterLevel, setFilterLevel] = useState(""); // beginner|intermediate|advanced
  const [filterTag, setFilterTag] = useState("");
  const [onlyPinned, setOnlyPinned] = useState(false);

  const [pinnedIds, setPinnedIds] = useState([]);
  const [recentIds, setRecentIds] = useState([]);

  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");

  const [lastTroubleshootInitial, setLastTroubleshootInitial] = useState(null);

  const searchRef = useRef(null);

  // Emit opened event
  useEffect(() => {
    (async () => {
      const { eventBus } = await getDbAndBus();
      emit(eventBus, EVENTS.OPENED, {
        householdId: normalizeStr(householdId) || null,
        userId: normalizeStr(userId) || null,
        domain: normalizeStr(domain) || null,
        panelId,
        openedAt: nowISO(),
        source: DEFAULT_SOURCE,
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load pinned/recent/last troubleshooter inputs
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const pinned = await loadKey({ householdId, userId, key: PINNED_KEY });
        const recent = await loadKey({ householdId, userId, key: RECENT_KEY });
        const lastTs = await loadKey({
          householdId,
          userId,
          key: LAST_TROUBLESHOOTER_KEY,
        });

        if (!alive) return;
        setPinnedIds(Array.isArray(pinned) ? pinned.map(String) : []);
        setRecentIds(Array.isArray(recent) ? recent.map(String) : []);
        setLastTroubleshootInitial(isObj(lastTs) ? lastTs : null);
      } catch (e) {
        console.warn("[KnowledgeHelperPanel] load persisted state failed", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [householdId, userId]);

  // Auto-clear toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  // Derived filter options
  const allDomains = useMemo(() => {
    const set = new Set();
    normalizedSkills.forEach((s) => s.domain && set.add(s.domain));
    if (domain) set.add(domain);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [normalizedSkills, domain]);

  const allTags = useMemo(() => {
    const set = new Set();
    normalizedSkills.forEach((s) => (s.tags || []).forEach((t) => set.add(t)));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [normalizedSkills]);

  const filteredSkills = useMemo(() => {
    const q = normalizeStr(query);
    const d = normalizeStr(filterDomain);
    const lv = normalizeStr(filterLevel).toLowerCase();
    const tg = normalizeStr(filterTag);

    let out = normalizedSkills.slice();

    if (onlyPinned) {
      const p = new Set(pinnedIds);
      out = out.filter((s) => p.has(String(s.id)));
    }
    if (d) out = out.filter((s) => normalizeStr(s.domain) === d);
    if (lv) out = out.filter((s) => normalizeStr(s.level).toLowerCase() === lv);
    if (tg) out = out.filter((s) => (s.tags || []).includes(tg));

    if (q) {
      out = out
        .map((s) => ({ s, score: scoreSkillMatch(s, q) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.s);
    } else {
      // mild stable ordering: pinned first then by title
      const p = new Set(pinnedIds);
      out.sort((a, b) => {
        const ap = p.has(String(a.id)) ? 0 : 1;
        const bp = p.has(String(b.id)) ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return a.title.localeCompare(b.title);
      });
    }

    return out;
  }, [
    normalizedSkills,
    query,
    filterDomain,
    filterLevel,
    filterTag,
    onlyPinned,
    pinnedIds,
  ]);

  const mergedSafetyAlerts = useMemo(() => {
    const base = Array.isArray(safetyAlerts)
      ? safetyAlerts.filter(Boolean)
      : [];
    const fromSkills = collectSafetyAlertsFromSkills(filteredSkills);
    // De-dupe by id if present, else by title+summary
    const seen = new Set();
    const out = [];
    [...base, ...fromSkills].forEach((a) => {
      const id = normalizeStr(a?.id);
      const key =
        id ||
        `${normalizeStr(a?.title).toLowerCase()}::${normalizeStr(
          a?.summary
        ).toLowerCase()}`.slice(0, 180);
      if (!key) return;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(a);
    });

    // Sort: critical/high first
    const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    out.sort((a, b) => {
      const av = order[normalizeStr(a?.severity).toLowerCase()] ?? 5;
      const bv = order[normalizeStr(b?.severity).toLowerCase()] ?? 5;
      if (av !== bv) return av - bv;
      return normalizeStr(a?.title).localeCompare(normalizeStr(b?.title));
    });

    return out;
  }, [safetyAlerts, filteredSkills]);

  const pinnedSet = useMemo(() => new Set(pinnedIds.map(String)), [pinnedIds]);

  async function persistPinned(next) {
    setPinnedIds(next);
    setBusy(true);
    setError("");
    try {
      await saveKey({ householdId, userId, key: PINNED_KEY, value: next });
      const { eventBus } = await getDbAndBus();
      emit(eventBus, EVENTS.PINNED_CHANGED, {
        householdId: normalizeStr(householdId) || null,
        userId: normalizeStr(userId) || null,
        domain: normalizeStr(domain) || null,
        panelId,
        updatedAt: nowISO(),
        pinnedIds: jclone(next),
        source: DEFAULT_SOURCE,
      });
      onPinnedChange?.(next);
      setToast("Pinned updated");
    } catch (e) {
      console.warn("[KnowledgeHelperPanel] persistPinned failed", e);
      setError("Couldn’t save pinned items.");
    } finally {
      setBusy(false);
    }
  }

  async function persistRecent(next) {
    setRecentIds(next);
    try {
      await saveKey({ householdId, userId, key: RECENT_KEY, value: next });
      const { eventBus } = await getDbAndBus();
      emit(eventBus, EVENTS.RECENT_CHANGED, {
        householdId: normalizeStr(householdId) || null,
        userId: normalizeStr(userId) || null,
        domain: normalizeStr(domain) || null,
        panelId,
        updatedAt: nowISO(),
        recentIds: jclone(next),
        source: DEFAULT_SOURCE,
      });
    } catch (e) {
      console.warn("[KnowledgeHelperPanel] persistRecent failed", e);
    }
  }

  function togglePinned(skillId) {
    const id = String(skillId);
    const next = pinnedSet.has(id)
      ? pinnedIds.filter((x) => String(x) !== id)
      : Array.from(new Set([id, ...pinnedIds]));
    persistPinned(next);
  }

  function bumpRecent(skillId) {
    const id = String(skillId);
    const next = [id, ...recentIds.filter((x) => String(x) !== id)].slice(
      0,
      20
    );
    persistRecent(next);
  }

  async function persistLastTroubleshooter(inputs) {
    try {
      await saveKey({
        householdId,
        userId,
        key: LAST_TROUBLESHOOTER_KEY,
        value: inputs,
      });
      setLastTroubleshootInitial(inputs);
    } catch (e) {
      console.warn(
        "[KnowledgeHelperPanel] persistLastTroubleshooter failed",
        e
      );
    }
  }

  function resetFilters() {
    setQuery("");
    setFilterDomain(domain || "");
    setFilterLevel("");
    setFilterTag("");
    setOnlyPinned(false);
    setTimeout(() => searchRef.current?.focus?.(), 30);
  }

  function selectTab(next) {
    setTab(next);
    setError("");
    // Focus search when going to skills
    if (next === TAB.SKILLS) setTimeout(() => searchRef.current?.focus?.(), 30);
  }

  function handleSkillAction(actionId, skillObj) {
    bumpRecent(skillObj?.id);
    try {
      onSkillAction?.(actionId, skillObj);
    } catch (e) {
      console.warn("[KnowledgeHelperPanel] onSkillAction failed", e);
    }
  }

  // Default actions for each SkillCard (caller can handle or ignore)
  function buildSkillActions(skillObj) {
    const id = String(skillObj?.id || "");
    const pinned = pinnedSet.has(id);

    return [
      {
        id: pinned ? "unpin" : "pin",
        label: pinned ? "Unpin" : "Pin",
        variant: "secondary",
        icon: <Tag className="h-4 w-4" aria-hidden="true" />,
      },
      {
        id: "start",
        label: "Start",
        variant: "primary",
        icon: <Sparkles className="h-4 w-4" aria-hidden="true" />,
      },
    ];
  }

  function onSkillCardAction(actionId, skillObj) {
    const id = String(skillObj?.id || "");
    if (actionId === "pin") return togglePinned(id);
    if (actionId === "unpin") return togglePinned(id);
    return handleSkillAction(actionId, skillObj);
  }

  const headerSubtitle = useMemo(() => {
    const d = normalizeStr(domain);
    if (!d)
      return "Search skills, run a troubleshooter, and review safety notes.";
    return `Context: ${d} • Search skills, troubleshoot issues, and review safety notes.`;
  }, [domain]);

  return (
    <div className="w-full">
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        {/* Header */}
        <div className={`${pad} flex items-start justify-between gap-3`}>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-900 truncate">
                {title}
              </h2>
              {domain ? (
                <Pill icon={<Tag className="h-3.5 w-3.5" aria-hidden="true" />}>
                  {domain}
                </Pill>
              ) : null}
              {toast ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-800">
                  <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                  {toast}
                </span>
              ) : null}
              {busy ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-800">
                  <RefreshCw
                    className="h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                  Saving…
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-slate-600">{headerSubtitle}</p>
          </div>

          <div className="flex items-center gap-2">
            <IconButton
              onClick={resetFilters}
              title="Reset filters"
              disabled={busy}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </IconButton>

            {typeof onClose === "function" ? (
              <IconButton onClick={onClose} title="Close" disabled={busy}>
                <X className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            ) : null}
          </div>
        </div>

        {/* Tabs */}
        <div className="border-t border-slate-100">
          <div className={`${pad} pb-2 flex flex-wrap items-center gap-2`}>
            <Chip
              active={tab === TAB.SKILLS}
              onClick={() => selectTab(TAB.SKILLS)}
              title="Browse skills"
            >
              <span className="inline-flex items-center gap-2">
                <BookOpen className="h-4 w-4" aria-hidden="true" /> Skills
              </span>
            </Chip>
            <Chip
              active={tab === TAB.TROUBLESHOOT}
              onClick={() => selectTab(TAB.TROUBLESHOOT)}
              title="Diagnose an issue"
            >
              <span className="inline-flex items-center gap-2">
                <Wrench className="h-4 w-4" aria-hidden="true" /> Troubleshooter
              </span>
            </Chip>
            <Chip
              active={tab === TAB.SAFETY}
              onClick={() => selectTab(TAB.SAFETY)}
              title="Review safety alerts"
            >
              <span className="inline-flex items-center gap-2">
                <ShieldAlert className="h-4 w-4" aria-hidden="true" /> Safety
              </span>
            </Chip>

            <div className="ml-auto flex items-center gap-2">
              {tab === TAB.SKILLS ? (
                <>
                  <IconButton
                    onClick={() =>
                      setView((v) => (v === VIEW.GRID ? VIEW.LIST : VIEW.GRID))
                    }
                    title={
                      view === VIEW.GRID
                        ? "Switch to list view"
                        : "Switch to grid view"
                    }
                  >
                    {view === VIEW.GRID ? (
                      <List className="h-4 w-4" />
                    ) : (
                      <LayoutGrid className="h-4 w-4" />
                    )}
                  </IconButton>

                  <Chip
                    active={onlyPinned}
                    onClick={() => setOnlyPinned((v) => !v)}
                    title="Show only pinned skills"
                  >
                    Pinned
                  </Chip>
                </>
              ) : null}
            </div>
          </div>

          {/* Error */}
          {error ? (
            <div className="px-4 pb-4">
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
                {error}
              </div>
            </div>
          ) : null}

          {/* Skills tab: search + filters */}
          {tab === TAB.SKILLS ? (
            <div className={`${pad} pt-0 space-y-3`}>
              <div className="grid gap-3 md:grid-cols-3">
                <label className="md:col-span-2 block">
                  <span className="text-sm font-medium text-slate-900">
                    Search
                  </span>
                  <div className="mt-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
                    <Search
                      className="h-4 w-4 text-slate-500"
                      aria-hidden="true"
                    />
                    <input
                      ref={searchRef}
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search skills, tags, tools…"
                      className="w-full text-sm outline-none"
                    />
                    {query ? (
                      <button
                        type="button"
                        onClick={() => setQuery("")}
                        className="rounded-full p-1 hover:bg-slate-100"
                        aria-label="Clear search"
                        title="Clear"
                      >
                        <X
                          className="h-4 w-4 text-slate-600"
                          aria-hidden="true"
                        />
                      </button>
                    ) : null}
                  </div>
                </label>

                <label className="block">
                  <span className="text-sm font-medium text-slate-900">
                    Filters
                  </span>
                  <div className="mt-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
                    <Filter
                      className="h-4 w-4 text-slate-500"
                      aria-hidden="true"
                    />
                    <span className="text-sm text-slate-700">
                      {filteredSkills.length} / {normalizedSkills.length}
                    </span>
                    <span className="ml-auto text-xs text-slate-500">
                      {onlyPinned ? "Pinned only" : "All"}
                    </span>
                  </div>
                </label>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <label className="block">
                  <span className="text-sm font-medium text-slate-900">
                    Domain
                  </span>
                  <select
                    value={filterDomain}
                    onChange={(e) => setFilterDomain(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
                  >
                    <option value="">All domains</option>
                    {allDomains.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="text-sm font-medium text-slate-900">
                    Level
                  </span>
                  <select
                    value={filterLevel}
                    onChange={(e) => setFilterLevel(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
                  >
                    <option value="">All levels</option>
                    {LEVELS.map((lv) => (
                      <option key={lv} value={lv}>
                        {lv}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="text-sm font-medium text-slate-900">
                    Tag
                  </span>
                  <select
                    value={filterTag}
                    onChange={(e) => setFilterTag(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
                  >
                    <option value="">All tags</option>
                    {allTags.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {/* Skills content */}
              {!filteredSkills.length ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                  No skills match your filters.
                </div>
              ) : (
                <div
                  className={
                    view === VIEW.GRID
                      ? "grid gap-4 lg:grid-cols-2"
                      : "space-y-4"
                  }
                >
                  {filteredSkills.map((sk) => (
                    <SkillCard
                      key={sk.id}
                      skill={sk}
                      compact={compact}
                      defaultExpanded={false}
                      showSafety={true}
                      showSources={true}
                      showTags={true}
                      actions={buildSkillActions(sk)}
                      onAction={(actionId, skillObj) =>
                        onSkillCardAction(actionId, skillObj)
                      }
                      onProgressChange={() => bumpRecent(sk.id)}
                      onDismiss={null}
                    />
                  ))}
                </div>
              )}

              {/* Recent / Pinned summary strip */}
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Pinned:</span>
                  <span>{pinnedIds.length}</span>
                  <span className="font-medium ml-3">Recent:</span>
                  <span>{recentIds.length}</span>
                  <span className="ml-auto text-slate-500">
                    Panel: {panelId} • {DEFAULT_SOURCE}
                  </span>
                </div>
              </div>
            </div>
          ) : null}

          {/* Troubleshooter tab */}
          {tab === TAB.TROUBLESHOOT ? (
            <div className={`${pad} pt-0`}>
              <Troubleshooter
                householdId={householdId}
                userId={userId}
                domain={domain || "general"}
                compact={compact}
                templates={issueTemplates}
                initial={lastTroubleshootInitial}
                onSaved={(payload) => {
                  // store inputs only (small), not entire outputs
                  const inputs = payload?.inputs || null;
                  if (inputs) persistLastTroubleshooter(inputs);
                }}
                onCompleted={(payload) => {
                  const inputs = payload?.inputs || null;
                  if (inputs) persistLastTroubleshooter(inputs);
                  try {
                    onTroubleshooterCompleted?.(payload);
                  } catch (e) {
                    console.warn(
                      "[KnowledgeHelperPanel] onTroubleshooterCompleted failed",
                      e
                    );
                  }
                }}
              />

              <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                Tip: Your last troubleshooter inputs are saved (best-effort) so
                you can resume later.
              </div>
            </div>
          ) : null}

          {/* Safety tab */}
          {tab === TAB.SAFETY ? (
            <div className={`${pad} pt-0 space-y-3`}>
              {!mergedSafetyAlerts.length ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                  No safety alerts right now.
                </div>
              ) : (
                <>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 flex flex-wrap items-center gap-2">
                    <ShieldAlert
                      className="h-4 w-4 text-slate-700"
                      aria-hidden="true"
                    />
                    <span className="font-medium text-slate-900">
                      Safety alerts
                    </span>
                    <span className="text-slate-700">
                      ({mergedSafetyAlerts.length})
                    </span>
                    <span className="ml-auto text-xs text-slate-500">
                      Includes alerts embedded in skills + external alerts
                      passed into this panel.
                    </span>
                  </div>

                  <div className="space-y-3">
                    {mergedSafetyAlerts.map((al, idx) => (
                      <SafetyAlertCard
                        key={al.id || `alert_${idx}`}
                        alert={al}
                        compact={compact}
                        defaultExpanded={
                          al?.severity === "high" || al?.severity === "critical"
                        }
                      />
                    ))}
                  </div>
                </>
              )}

              {/* Sources (optional quick list) */}
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="flex items-center gap-2">
                  <Clock
                    className="h-4 w-4 text-slate-700"
                    aria-hidden="true"
                  />
                  <span className="text-sm font-semibold text-slate-900">
                    Notes
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-700 leading-6">
                  These are general safety pointers. For urgent or severe
                  symptoms, prioritize immediate safety and seek appropriate
                  help.
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  {DEFAULT_SOURCE} • {formatWhen(nowISO())}
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Minimal footer (non-invasive) */}
      <div className="mt-3 text-xs text-slate-600">
        Want the panel to auto-load skills from your catalogs? Pass a populated{" "}
        <code className="rounded bg-slate-100 px-1">skills</code> array from
        your domain engine.{" "}
        <a
          href={safeUrl("https://dexie.org/")}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-slate-900 hover:underline"
        >
          Dexie <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
