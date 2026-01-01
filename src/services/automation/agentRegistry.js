// C:\Users\larho\suka-smart-assistant\src\services\automation\agentRegistry.js
//
// Suka Smart Assistant — Automation Agent Registry (Dynamic, ESM)
//
// Responsibilities:
//  • Realize agents from class/factory/object or Promise thereof
//  • Manage lifecycle (init/start/teardown) with timeouts & retries
//  • Track metadata & health
//  • Wire agents to the automation runtime EventBus with per-agent filters
//  • Provide enable/disable/pause/resume and broadcast/dispatch helpers
//
// An "agent" may implement any of:
//  - init({ automation, name, registry }) : void|Promise
//  - start(): void|Promise
//  - teardown(): void|Promise
//  - handleEvent(eventCtx): void|Promise
//  - topics?: string[]            // opt-in topic list
//  - filter?(eventCtx): boolean   // optional predicate
//  - meta?: { version?, capabilities?, description? }
//
// The automation runtime is expected to be an EventEmitter-like bus exporting:
//    export const automation = new EventEmitter()
// that emits { topic, payload, userId?, homeId?, correlationId?, ts? } under "event".
//

import { automation } from "./runtime";

// ---------- env (Vite/browser + Node safe) ----------
const __ENV__ =
  (typeof import.meta !== "undefined" && import.meta.env) ||
  (typeof globalThis !== "undefined" && globalThis.process && globalThis.process.env) ||
  {};

function envNum(...keys) {
  for (let i = 0; i < keys.length; i++) {
    const v = __ENV__[keys[i]];
    if (v !== undefined && v !== null && v !== "") return Number(v);
  }
  return undefined;
}

// Prefer Vite's VITE_* in browser; fall back to non-prefixed if present
const MAX_INIT_RETRIES = envNum("VITE_AGENT_INIT_RETRIES", "AGENT_INIT_RETRIES");
const LIFECYCLE_TIMEOUT_MS = envNum("VITE_AGENT_LIFECYCLE_TIMEOUT_MS", "AGENT_LIFECYCLE_TIMEOUT_MS");

// Defaults if not provided via env
const _MAX_INIT_RETRIES = Number.isFinite(MAX_INIT_RETRIES) ? MAX_INIT_RETRIES : 1;
const _LIFECYCLE_TIMEOUT_MS = Number.isFinite(LIFECYCLE_TIMEOUT_MS) ? LIFECYCLE_TIMEOUT_MS : 8000;

// ---------- internal state ----------
/** @type {Map<string, { agent:any, meta:object, status:string, enabled:boolean, paused:boolean, startedAt?:string, listeners:Array<Function>, lastError?:string, tries:number }>} */
const _agents = new Map();

// ---------- small utils ----------
const nowISO = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withTimeout(promise, ms, label = "operation") {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms))),
  ]);
}

function safeStr(err) {
  return err?.message || String(err);
}

function normalizeName(name) {
  return String(name || "").trim();
}

// ---------- realization ----------
// Accept class, factory, plain object, or a Promise to any of those
async function realizeAgent(agentLike) {
  if (!agentLike) return null;

  const resolved = typeof agentLike?.then === "function" ? await agentLike : agentLike;

  // 1) function: class or factory
  if (typeof resolved === "function") {
    const proto = resolved.prototype || {};
    const looksClass = typeof proto === "object" && (proto.start || proto.teardown || proto.handleEvent);
    if (looksClass) {
      try {
        return new resolved({ automation, bus: automation, registry: exportsShim });
      } catch (e) {
        console.warn("[agentRegistry] failed to construct class agent:", safeStr(e));
        return null;
      }
    }
    // factory
    try {
      return resolved({ automation, bus: automation, registry: exportsShim }) ?? resolved();
    } catch (e) {
      console.warn("[agentRegistry] factory agent threw:", safeStr(e));
      return null;
    }
  }

  // 2) plain object instance
  if (typeof resolved === "object") return resolved;

  return null;
}

// ---------- wiring to runtime bus ----------
function makeEventListener(name, rec) {
  // Single listener function bound to runtime bus; fan-in through per-agent checks.
  return async function onAutomationEvent(eventCtx) {
    if (!rec.enabled || rec.paused) return;
    try {
      // topic filter (if provided)
      if (Array.isArray(rec.agent?.topics) && rec.agent.topics.length > 0) {
        if (!rec.agent.topics.includes(eventCtx.topic)) return;
      }
      // custom predicate (if provided)
      if (typeof rec.agent?.filter === "function") {
        const pass = await rec.agent.filter(eventCtx);
        if (!pass) return;
      }

      if (typeof rec.agent?.handleEvent === "function") {
        await rec.agent.handleEvent(eventCtx);
      }
    } catch (e) {
      rec.lastError = safeStr(e);
      console.warn(`[agentRegistry] agent "${name}" handleEvent error:`, rec.lastError);
    }
  };
}

// ---------- lifecycle helpers ----------
async function startAgent(name, rec) {
  const a = rec.agent;
  const meta = a?.meta || {};
  rec.meta = {
    version: meta.version || "0.0.0",
    capabilities: meta.capabilities || [],
    description: meta.description || "",
  };

  // init (with retries)
  let tries = 0;
  while (tries <= _MAX_INIT_RETRIES) {
    try {
      if (typeof a?.init === "function") {
        await withTimeout(
          Promise.resolve(a.init({ automation, name, registry: exportsShim })),
          _LIFECYCLE_TIMEOUT_MS,
          "init"
        );
      }
      break; // success
    } catch (e) {
      tries += 1;
      rec.lastError = safeStr(e);
      if (tries > _MAX_INIT_RETRIES) {
        rec.status = "error";
        throw e;
      }
      await sleep(150 + Math.random() * 150);
    }
  }

  // start
  if (typeof a?.start === "function") {
    await withTimeout(Promise.resolve(a.start()), _LIFECYCLE_TIMEOUT_MS, "start");
  }

  // attach runtime bus listener
  const listener = makeEventListener(name, rec);
  automation.on("event", listener);
  rec.listeners.push(() => automation.off("event", listener));

  rec.status = "running";
  rec.startedAt = nowISO();
}

async function teardownAgent(name, rec) {
  // remove listeners first
  try {
    for (const off of rec.listeners || []) {
      try { off(); } catch {}
    }
    rec.listeners = [];
  } catch {}

  // teardown hook
  try {
    if (typeof rec.agent?.teardown === "function") {
      await withTimeout(Promise.resolve(rec.agent.teardown()), _LIFECYCLE_TIMEOUT_MS, "teardown");
    }
  } catch (e) {
    console.warn(`[agentRegistry] teardown() failed for "${name}":`, safeStr(e));
  }
}

// ---------- public API ----------
export async function registerAgent(name, instanceLike) {
  name = normalizeName(name);
  if (!name || !instanceLike) {
    console.warn("registerAgent requires name + instance");
    return null;
  }

  // If already registered, cleanly replace (HMR-safe)
  if (_agents.has(name)) {
    const old = _agents.get(name);
    await teardownAgent(name, old).catch(() => {});
    _agents.delete(name);
  }

  const agent = await realizeAgent(instanceLike);
  if (!agent) {
    console.warn(`[agentRegistry] Skipping invalid agent for "${name}".`);
    return null;
  }

  const rec = {
    agent,
    meta: {},
    status: "starting",
    enabled: true,
    paused: false,
    listeners: [],
    tries: 0,
    lastError: undefined,
  };
  _agents.set(name, rec);

  try {
    await startAgent(name, rec);
  } catch (e) {
    rec.status = "error";
    rec.lastError = safeStr(e);
    console.warn(`[agentRegistry] start failed for "${name}":`, rec.lastError);
  }

  return rec.agent;
}

export async function unregisterAgent(name) {
  name = normalizeName(name);
  const rec = _agents.get(name);
  if (!rec) return false;
  await teardownAgent(name, rec).catch(() => {});
  _agents.delete(name);
  return true;
}

export function getAgent(name) {
  name = normalizeName(name);
  const rec = _agents.get(name);
  if (!rec) {
    console.warn(`Agent "${name}" not found. Did you register it in bootstrap?`);
    return null;
  }
  return rec.agent;
}

export function getAgentOrNull(name) {
  name = normalizeName(name);
  return _agents.get(name)?.agent ?? null;
}

export function listAgents({ withMeta = false } = {}) {
  if (!withMeta) return Array.from(_agents.keys());
  return Array.from(_agents.entries()).map(([name, rec]) => ({
    name,
    status: rec.status,
    enabled: rec.enabled,
    paused: rec.paused,
    startedAt: rec.startedAt || null,
    lastError: rec.lastError || null,
    meta: rec.meta || {},
  }));
}

// ---------- control surface ----------
export function enableAgent(name) {
  const rec = _agents.get(normalizeName(name));
  if (!rec) return false;
  rec.enabled = true;
  return true;
}
export function disableAgent(name) {
  const rec = _agents.get(normalizeName(name));
  if (!rec) return false;
  rec.enabled = false;
  return true;
}
export function pauseAgent(name) {
  const rec = _agents.get(normalizeName(name));
  if (!rec) return false;
  rec.paused = true;
  return true;
}
export function resumeAgent(name) {
  const rec = _agents.get(normalizeName(name));
  if (!rec) return false;
  rec.paused = false;
  return true;
}

// Broadcast a synthetic event to all agents (respects topics/filter)
export function broadcast(topic, payload = {}, meta = {}) {
  const eventCtx = {
    topic,
    payload,
    ts: Date.now(),
    ...meta, // userId, homeId, correlationId, etc.
  };
  automation.emit("event", eventCtx);
}

// Dispatch directly to a single agent’s handleEvent (skips topics/filter)
export async function dispatchTo(name, eventCtx) {
  const rec = _agents.get(normalizeName(name));
  if (!rec?.agent?.handleEvent) return false;
  try {
    await Promise.resolve(rec.agent.handleEvent(eventCtx));
    return true;
  } catch (e) {
    rec.lastError = safeStr(e);
    console.warn(`[agentRegistry] dispatchTo("${name}") error:`, rec.lastError);
    return false;
  }
}

// Health snapshot (for /api/automations or admin panels)
export function getHealth() {
  const out = {};
  for (const [name, rec] of _agents) {
    out[name] = {
      status: rec.status,
      enabled: rec.enabled,
      paused: rec.paused,
      startedAt: rec.startedAt || null,
      lastError: rec.lastError || null,
      meta: rec.meta || {},
    };
  }
  return out;
}

// ---------- re-export a minimal facade for agents to use if needed ----------
const exportsShim = {
  registerAgent,
  unregisterAgent,
  getAgent,
  getAgentOrNull,
  listAgents,
  enableAgent,
  disableAgent,
  pauseAgent,
  resumeAgent,
  broadcast,
  dispatchTo,
  getHealth,
};
export default exportsShim;
