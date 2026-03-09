// src/services/session/utils/scheduleDebug.js
/* eslint-disable no-console */

/**
 * scheduleDebug.js — Dev logging toggles for schedulers & sessions
 * Safe for TS parser (no import.meta usage), SSR-friendly, and defensive.
 */

let eventBus = { on() {}, off() {}, emit() {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {
  /* no-op */
}

let timeMath = null;
try {
  timeMath = require("@/services/session/utils/timeMath.js");
  timeMath = (timeMath && (timeMath.default || timeMath)) || null;
} catch (_e) {
  /* no-op */
}

/* --------------------------------- Env-safe --------------------------------- */
const isBrowser = typeof window !== "undefined";
const now = () => Date.now();

/* ------------------------------- Config / State ------------------------------ */
const DEFAULT_DOMAINS = [
  "scheduler",
  "sessions",
  "inventory",
  "garden",
  "animals",
  "cleaning",
  "meals",
  "automation",
];

const LEVELS = /** @type {const} */ ({
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
});

const COLOR_BY_LEVEL = {
  error:
    "background:#fee2e2;color:#991b1b;border:1px solid #fecaca;border-radius:6px;padding:2px 6px",
  warn: "background:#fef3c7;color:#92400e;border:1px solid #fde68a;border-radius:6px;padding:2px 6px",
  info: "background:#e0f2fe;color:#075985;border:1px solid #bae6fd;border-radius:6px;padding:2px 6px",
  debug:
    "background:#ecfeff;color:#164e63;border:1px solid #cffafe;border-radius:6px;padding:2px 6px",
  trace:
    "background:#f1f5f9;color:#0f172a;border:1px solid #e2e8f0;border-radius:6px;padding:2px 6px",
};

const COLOR_BY_DOMAIN = {
  scheduler: "color:#0f766e",
  sessions: "color:#7c3aed",
  inventory: "color:#0ea5e9",
  garden: "color:#65a30d",
  animals: "color:#dc2626",
  cleaning: "color:#f59e0b",
  meals: "color:#d946ef",
  automation: "color:#334155",
  default: "color:#334155",
};

const LS_KEY = "suka.debug";
const QS_KEY = "debug";
const QS_OFF = "ndebug";
const DEFAULT_LEVEL = "info";
const DEFAULT_ENABLED = false;
const DEFAULT_SAMPLE = 1.0;

/* ------------------------------ Ring Buffer --------------------------------- */
const MAX_BUFFER = 500;
const buffer = [];
function pushBuffer(entry) {
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
}
export function getBuffer() {
  return buffer.slice();
}
export function clearBuffer() {
  buffer.length = 0;
}
export function exportBuffer() {
  return JSON.stringify(
    { exportedAt: new Date().toISOString(), entries: buffer },
    null,
    2
  );
}

/* ----------------------------- Enablement State ----------------------------- */
let _enabled = DEFAULT_ENABLED;
let _level = LEVELS[DEFAULT_LEVEL] ?? LEVELS.info;
let _domains = new Set();
let _sample = DEFAULT_SAMPLE;
let _autoSubscribed = false;

function parseCsv(v) {
  return String(v || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ------------- SAFE env flag reader (no import.meta usage at all) ----------- */
function readEnvFlag() {
  try {
    const pe = (typeof process !== "undefined" && process.env) || {};
    return pe.VITE_SUKA_DEBUG || pe.SUKA_DEBUG || "";
  } catch (_e) {
    return "";
  }
}

function readLocalStorage() {
  if (!isBrowser) return null;
  try {
    const s = window.localStorage.getItem(LS_KEY);
    return s ? JSON.parse(s) : null;
  } catch (_e) {
    return null;
  }
}

function writeLocalStorage(state) {
  if (!isBrowser) return;
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch (_e) {}
}

function readQueryStrings() {
  if (!isBrowser) return null;
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.has(QS_OFF)) return { off: true };
    const v = u.searchParams.get(QS_KEY);
    if (!v) return null;
    return { debug: v };
  } catch (_e) {
    return null;
  }
}

function applyDomains(domainsCsv) {
  _domains.clear();
  const list = domainsCsv ? parseCsv(domainsCsv) : [];
  for (const d of list) _domains.add(d.toLowerCase());
}

/* --------------------------------- Controls --------------------------------- */
export function setEnabled(v) {
  _enabled = !!v;
  syncAutoSubscriptions();
  persistState();
}
export function isEnabled() {
  return !!_enabled;
}

export function setLevel(level) {
  if (typeof level === "number") _level = level;
  else _level = LEVELS[level] ?? _level;
  persistState();
}
export function getLevel() {
  return _level;
}

export function setDomains(domainsCsv) {
  applyDomains(domainsCsv);
  persistState();
}
export function getDomains() {
  return Array.from(_domains);
}

export function setSample(prob01) {
  _sample = Math.max(0, Math.min(1, Number(prob01) || 0));
  persistState();
}
export function getSample() {
  return _sample;
}

export function enableAll() {
  _enabled = true;
  _domains.clear();
  persistState();
  syncAutoSubscriptions();
}
export function disableAll() {
  _enabled = false;
  persistState();
  syncAutoSubscriptions();
}

function persistState() {
  writeLocalStorage({
    enabled: _enabled,
    level: _level,
    domains: Array.from(_domains),
    sample: _sample,
  });
}

function hydrateInitialState() {
  const saved = readLocalStorage();
  if (saved) {
    _enabled = !!saved.enabled;
    _level = Number.isFinite(saved.level) ? saved.level : _level;
    _domains = new Set(Array.isArray(saved.domains) ? saved.domains : []);
    _sample = Number.isFinite(saved.sample) ? saved.sample : _sample;
  }

  const envFlag = readEnvFlag();
  if (envFlag) parseDebugFlag(envFlag);

  const qs = readQueryStrings();
  if (qs?.off) {
    _enabled = false;
  } else if (qs?.debug) {
    parseDebugFlag(qs.debug);
  }

  if (_domains.has("all")) _domains.clear();

  persistState();
}

function parseDebugFlag(flag) {
  const f = String(flag || "")
    .trim()
    .toLowerCase();
  if (!f) return;

  if (["off", "false", "0", "no"].includes(f)) {
    _enabled = false;
    return;
  }

  _enabled = true;
  if (["on", "true", "1", "yes", "all", "*"].includes(f)) {
    _domains.clear();
    _level = Math.max(_level, LEVELS.debug);
    return;
  }

  const parts = parseCsv(f);
  const keep = [];
  let highest = _level;

  for (const p of parts) {
    const [dom, lvl] = p.split("@");
    if (dom) keep.push(dom);
    if (lvl && LEVELS[lvl] != null) highest = Math.max(highest, LEVELS[lvl]);
  }

  _domains = new Set(keep);
  _level = highest;
}

/* --------------------------------- Filters ---------------------------------- */
function shouldSample() {
  if (_sample >= 1) return true;
  return Math.random() < _sample;
}

function domainOk(domain) {
  if (!_enabled) return false;
  if (!domain) return true;
  if (_domains.size === 0) return true;
  return _domains.has(String(domain).toLowerCase());
}

function levelOk(level) {
  const n = typeof level === "number" ? level : LEVELS[level] ?? LEVELS.debug;
  return n <= _level;
}

/* --------------------------------- Utilities -------------------------------- */
function styleFor(level, domain) {
  const s1 = COLOR_BY_LEVEL[level] || COLOR_BY_LEVEL.debug;
  const s2 = COLOR_BY_DOMAIN[domain] || COLOR_BY_DOMAIN.default;
  return [s1, s2];
}

function writeLine(kind, domain, label, payload, meta) {
  const [sLevel, sDomain] = styleFor(kind, domain);
  const ts = new Date().toISOString();
  const title = `%c${kind.toUpperCase()}%c ${
    domain ? `[${domain}] ` : ""
  }${label}`;
  const record = { ts, kind, domain, label, payload, meta };

  pushBuffer(record);

  if (kind === "error")
    console.error(title, sLevel, sDomain, payload || "", meta || "");
  else if (kind === "warn")
    console.warn(title, sLevel, sDomain, payload || "", meta || "");
  else console.log(title, sLevel, sDomain, payload || "", meta || "");
}

function grouped(kind, domain, label, payload, meta, collapsed = true) {
  const [sLevel, sDomain] = styleFor(kind, domain);
  const ts = new Date().toISOString();
  const title = `%c${kind.toUpperCase()}%c ${
    domain ? `[${domain}] ` : ""
  }${label}  ${meta?.note ? `— ${meta.note}` : ""}`;

  const record = { ts, kind, domain, label, payload, meta };
  pushBuffer(record);

  const open = collapsed ? console.groupCollapsed : console.group;
  const close = console.groupEnd;

  open.call(console, title, sLevel, sDomain);
  try {
    if (meta) console.log("meta:", meta);
    if (payload != null) console.log("payload:", payload);
  } finally {
    close.call(console);
  }
}

/* --------------------------------- Public API -------------------------------- */
function log(
  kind,
  domain,
  label,
  payload = null,
  meta = null,
  collapsed = false
) {
  if (!domainOk(domain) || !levelOk(kind) || !shouldSample()) return;
  grouped(kind, domain, label, payload, meta, collapsed);
}

export const dbg = {
  error: (domain, label, payload, meta) =>
    log("error", domain, label, payload, meta),
  warn: (domain, label, payload, meta) =>
    log("warn", domain, label, payload, meta, true),
  info: (domain, label, payload, meta) =>
    log("info", domain, label, payload, meta, true),
  debug: (domain, label, payload, meta) =>
    log("debug", domain, label, payload, meta, true),
  trace: (domain, label, payload, meta) =>
    log("trace", domain, label, payload, meta, true),

  group: (domain, title, fn, meta) => {
    if (!domainOk(domain) || !levelOk("debug") || !shouldSample()) return;
    const [sLevel, sDomain] = styleFor("debug", domain);
    console.groupCollapsed(`%cDEBUG%c [${domain}] ${title}`, sLevel, sDomain);
    try {
      fn?.();
    } finally {
      console.groupEnd();
    }
    pushBuffer({
      ts: new Date().toISOString(),
      kind: "group",
      domain,
      label: title,
      meta,
    });
  },
};

/* -------------------------- Domain-specific helpers ------------------------- */
export function logEvent(evtName, payload = {}, domain = inferDomain(evtName)) {
  log(
    "info",
    domain,
    `event: ${evtName}`,
    sanitizeEvent(payload),
    { evt: evtName },
    true
  );
}

export function logDecision(kind, reason, context = {}, domain = "scheduler") {
  log("debug", domain, `decision: ${kind}`, context, { reason }, true);
}

export function logTimerSet(what, dueTs, options = {}, domain = "scheduler") {
  const human = timeMath?.humanize
    ? timeMath.humanize(dueTs - now())
    : `${dueTs - now()}ms`;
  log(
    "debug",
    domain,
    `timer:set → ${what}`,
    options,
    { dueTs, eta: human },
    true
  );
}

export function logTimerFire(what, scheduledTs, domain = "scheduler") {
  const late = now() - scheduledTs;
  const humanLate = timeMath?.humanize ? timeMath.humanize(late) : `${late}ms`;
  log(
    "info",
    domain,
    `timer:fire → ${what}`,
    null,
    { scheduledTs, late: humanLate },
    false
  );
}

export function logPause(
  sessionId,
  atTs = now(),
  reason = "unspecified",
  domain = "sessions"
) {
  log(
    "info",
    domain,
    `session:pause #${sessionId}`,
    null,
    { atTs, reason },
    true
  );
}

export function logResume(sessionId, atTs = now(), domain = "sessions") {
  log("info", domain, `session:resume #${sessionId}`, null, { atTs }, true);
}

export function traceStep(sessionId, step, state = {}, domain = "sessions") {
  log("trace", domain, `step:${step} #${sessionId}`, state, null, true);
}

/* ----------------------------- EventBus subscriptions ------------------------ */
function syncAutoSubscriptions() {
  if (!_enabled) {
    if (_autoSubscribed) {
      try {
        eventBus.off && eventBus.off("*", onAnyEvent);
      } catch (_e) {}
      _autoSubscribed = false;
    }
    return;
  }
  if (_autoSubscribed) return;

  try {
    if (eventBus.on) {
      eventBus.on("*", onAnyEvent);
      _autoSubscribed = true;
    }
  } catch (_e) {
    /* no-op */
  }
}

function onAnyEvent(evtName, payload) {
  const domain = inferDomain(evtName, payload);
  if (!domainOk(domain) || !levelOk("info")) return;

  const clean = sanitizeEvent(payload);
  const meta = { evt: evtName };
  if (clean?.kind) meta.kind = clean.kind;
  if (clean?.domain) meta.domain = clean.domain;

  grouped("info", domain, `eventBus: ${evtName}`, clean, meta, true);
}

function inferDomain(evtName, payload) {
  const p = (evtName || "").split(".")[0] || "";
  const hint = (payload && (payload.domain || payload?.params?.domain)) || "";
  if (hint) return String(hint).toLowerCase();
  switch (p) {
    case "mealplan":
      return "meals";
    case "grocerylist":
      return "meals";
    case "prep":
      return "meals";
    case "inventory":
      return "inventory";
    case "planner":
      return "scheduler";
    case "session":
    case "sessions":
      return "sessions";
    case "garden":
      return "garden";
    case "animal":
    case "animals":
      return "animals";
    case "cleaning":
      return "cleaning";
    case "automation":
      return "automation";
    default:
      return p || "scheduler";
  }
}

function sanitizeEvent(payload) {
  if (!payload || typeof payload !== "object") return payload ?? null;
  const omitKeys = new Set([
    "_bigData",
    "rawHtml",
    "imageBlob",
    "stack",
    "stackTrace",
    "sourceMap",
  ]);
  const out = {};
  for (const k of Object.keys(payload)) {
    if (omitKeys.has(k)) continue;
    out[k] = payload[k];
  }
  return out;
}

/* ------------------------------ Quick Shortcuts ------------------------------ */
export function toggle(domainOrAll = "all") {
  if (!_enabled) {
    _enabled = true;
    if (domainOrAll && domainOrAll !== "all") setDomains(domainOrAll);
  } else {
    if (_domains.size === 0 || domainOrAll === "all") _enabled = false;
    else setDomains("");
  }
  persistState();
  syncAutoSubscriptions();
}

export function withDomain(domain) {
  const d = String(domain || "scheduler").toLowerCase();
  return {
    error: (label, payload, meta) => dbg.error(d, label, payload, meta),
    warn: (label, payload, meta) => dbg.warn(d, label, payload, meta),
    info: (label, payload, meta) => dbg.info(d, label, payload, meta),
    debug: (label, payload, meta) => dbg.debug(d, label, payload, meta),
    trace: (label, payload, meta) => dbg.trace(d, label, payload, meta),
  };
}

/* ------------------------------ Pretty Banners ------------------------------- */
export function banner(msg = "Suka Debug ON") {
  if (!_enabled) return;
  const s =
    "background:#111827;color:#f9fafb;padding:6px 10px;border-radius:8px";
  console.log(`%c${msg}`, s);
}

/* --------------------------------- Init/Hydrate ------------------------------ */
hydrateInitialState();
syncAutoSubscriptions();

if (_enabled && isBrowser) {
  const levelName =
    Object.keys(LEVELS).find((k) => LEVELS[k] === _level) || "info";
  banner(
    `Suka Debug: ON — level=${levelName} ` +
      `domains=${
        _domains.size ? Array.from(_domains).join(",") : "ALL"
      } sample=${_sample}`
  );
}

/* ----------------------------------- Exports -------------------------------- */
const scheduleDebug = {
  isEnabled,
  setEnabled,
  enableAll,
  disableAll,
  getLevel,
  setLevel,
  getDomains,
  setDomains,
  getSample,
  setSample,
  toggle,

  dbg,
  logEvent,
  logDecision,
  logTimerSet,
  logTimerFire,
  logPause,
  logResume,
  traceStep,
  withDomain,

  getBuffer,
  clearBuffer,
  exportBuffer,

  banner,
  LEVELS,
  DEFAULT_DOMAINS,
};

export default scheduleDebug;
