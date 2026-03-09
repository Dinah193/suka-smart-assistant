// File: src/agents/runtime/reasonerDriver.js
/**
 * reasonerDriver
 * -----------------------------------------------------------------------------
 * SSA Agent Runtime — Reasoner driver (browser-safe).
 *
 * Purpose
 *  - Provide a single entry-point for "reasoning" calls inside SSA that:
 *      • works offline-first (no hard dependency on remote LLMs)
 *      • can route to multiple "reasoners" (rules, templates, LLM, hybrid)
 *      • standardizes prompt/context payloads
 *      • emits lifecycle events to SSA eventBus (if available)
 *      • supports tracing + deterministic runs when possible
 *      • enforces guardrails (size limits, PII scrubbing hooks)
 *
 * Key Concepts
 *  - Reasoner: an implementation that can produce a "reasoned result"
 *    given a prompt + context + tools snapshot.
 *  - Driver: this file, which selects a reasoner, prepares input, and
 *    normalizes output into a stable contract used across the app.
 *
 * Dependencies
 *  - eventBus is OPTIONAL: if present at "@/services/events/eventBus" it will be used.
 *  - MealPrefs/Inventory/etc. are NOT imported here to avoid circular deps.
 *    Callers provide "context" explicitly.
 *
 * No Node imports — safe for Vite production builds.
 */

/* -----------------------------------------------------------------------------
 * Optional eventBus (do not crash if missing)
 * -------------------------------------------------------------------------- */

let eventBus = null;
try {
  // NOTE: keep static import path stable; if your event bus differs, adjust here.
  // eslint-disable-next-line import/no-unresolved
  // eslint-disable-next-line global-require
  eventBus = (await import("@/services/events/eventBus")).default ?? null;
} catch {
  eventBus = null;
}

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

const SOURCE = "agents.runtime.reasonerDriver";

const DEFAULTS = Object.freeze({
  driverVersion: "1.0.0",
  maxPromptChars: 20_000,
  maxContextChars: 80_000,
  maxToolChars: 80_000,
  defaultTimeoutMs: 20_000,
  // deterministic by default for non-LLM reasoners
  deterministic: true,
});

function nowMs() {
  return Date.now();
}

function genId(prefix = "rr") {
  // small, collision-resistant in-browser id
  const rnd = Math.random().toString(16).slice(2);
  return `${prefix}_${nowMs().toString(16)}_${rnd}`;
}

function safeString(x) {
  if (x == null) return "";
  if (typeof x === "string") return x;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function clampStr(s, max) {
  const str = String(s || "");
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n…(truncated ${str.length - max} chars)`;
}

function toLowerSafe(s) {
  return String(s || "").toLowerCase();
}

function emit(name, payload) {
  try {
    eventBus?.emit?.(name, payload);
  } catch {
    // never crash driver on telemetry
  }
}

/* -----------------------------------------------------------------------------
 * Guardrails / scrubbing hooks (pluggable)
 * -------------------------------------------------------------------------- */

/**
 * Default scrubbing is light-touch and safe; replace by injecting
 * opts.scrubbers if you need more aggressive behavior.
 */
function defaultScrub(text) {
  // Mask very common PII patterns (best-effort; not perfect).
  let t = String(text || "");

  // emails
  t = t.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "[redacted_email]"
  );
  // phone numbers (simple)
  t = t.replace(
    /\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    "[redacted_phone]"
  );
  // SSN (US)
  t = t.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[redacted_ssn]");

  return t;
}

function applyScrubbers(text, scrubbers = []) {
  let out = String(text || "");
  const list = Array.isArray(scrubbers) ? scrubbers : [];
  for (const fn of list) {
    try {
      if (typeof fn === "function") out = fn(out);
    } catch {
      // ignore scrubber errors
    }
  }
  return out;
}

/* -----------------------------------------------------------------------------
 * Reasoner interface + registry
 * -------------------------------------------------------------------------- */

/**
 * @typedef {object} ReasonerRequest
 * @property {string} runId
 * @property {string} task
 * @property {string} prompt
 * @property {any} context
 * @property {any} tools
 * @property {object} meta
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} ReasonerResult
 * @property {string} runId
 * @property {string} task
 * @property {string} reasonerId
 * @property {string} status - ok|error|timeout|canceled
 * @property {any} output
 * @property {string[]} messages
 * @property {object} trace
 * @property {number} startedAt
 * @property {number} endedAt
 * @property {number} durationMs
 * @property {any} error
 */

const registry = new Map();

/**
 * Register a reasoner implementation.
 * @param {string} id
 * @param {object} impl
 * @param {(req:ReasonerRequest)=>Promise<ReasonerResult>} impl.run
 * @param {(cap:any)=>boolean} [impl.supports] - capability predicate
 * @param {number} [impl.priority] - higher wins
 */
export function registerReasoner(id, impl) {
  if (!id || typeof id !== "string")
    throw new Error("registerReasoner: id required");
  if (!impl || typeof impl.run !== "function")
    throw new Error("registerReasoner: impl.run required");
  registry.set(id, { id, ...impl });
}

/**
 * Unregister a reasoner.
 */
export function unregisterReasoner(id) {
  registry.delete(id);
}

/**
 * List all registered reasoners (sorted by priority desc).
 */
export function listReasoners() {
  return Array.from(registry.values()).sort(
    (a, b) => (b.priority || 0) - (a.priority || 0)
  );
}

/* -----------------------------------------------------------------------------
 * Built-in reasoners
 * -------------------------------------------------------------------------- */

/**
 * RuleBasedReasoner: simple deterministic router with small helpers.
 * Useful as baseline/offline mode.
 */
function makeRuleBasedReasoner() {
  return {
    id: "rules",
    priority: 10,
    supports: () => true,
    async run(req) {
      const startedAt = nowMs();
      const messages = [];
      const trace = { kind: "rules", decisions: [] };

      try {
        const task = toLowerSafe(req.task);
        const prompt = req.prompt || "";

        // Very small, deterministic patterns:
        if (task.includes("summar")) {
          trace.decisions.push({ rule: "summarize", hit: true });
          const out = summarizeText(prompt, 6);
          return finalizeOk(req, startedAt, {
            output: { summary: out },
            messages: ["Summarized input."],
            trace,
            reasonerId: "rules",
          });
        }

        if (task.includes("classif") || task.includes("label")) {
          trace.decisions.push({ rule: "classify", hit: true });
          const labels = simpleLabels(prompt);
          return finalizeOk(req, startedAt, {
            output: { labels },
            messages: ["Classified input using simple labels."],
            trace,
            reasonerId: "rules",
          });
        }

        if (task.includes("extract")) {
          trace.decisions.push({ rule: "extract", hit: true });
          const entities = simpleEntityExtract(prompt);
          return finalizeOk(req, startedAt, {
            output: { entities },
            messages: ["Extracted basic entities."],
            trace,
            reasonerId: "rules",
          });
        }

        // Default: echo back with gentle structure
        trace.decisions.push({ rule: "default", hit: true });
        messages.push(
          "No specialized rule matched; returning structured echo."
        );

        return finalizeOk(req, startedAt, {
          output: {
            task: req.task,
            note: "No specialized rule matched.",
            prompt: clampStr(prompt, 2000),
          },
          messages,
          trace,
          reasonerId: "rules",
        });
      } catch (error) {
        return finalizeErr(req, startedAt, { reasonerId: "rules", error });
      }
    },
  };
}

/**
 * TemplateReasoner: executes tiny "decision templates" provided by caller context.
 * Example use:
 *  - Caller passes context.templates = [{ id, when:{contains:[]}, output:{...}}]
 */
function makeTemplateReasoner() {
  return {
    id: "templates",
    priority: 20,
    supports: (cap) => !!cap?.templatesEnabled,
    async run(req) {
      const startedAt = nowMs();
      const trace = { kind: "templates", matched: null };

      try {
        const templates = Array.isArray(req?.context?.templates)
          ? req.context.templates
          : [];
        const p = toLowerSafe(req.prompt);

        for (const t of templates) {
          const when = t?.when || {};
          const contains = Array.isArray(when.contains) ? when.contains : [];
          const taskIs = Array.isArray(when.taskIs)
            ? when.taskIs
            : when.taskIs
            ? [when.taskIs]
            : [];

          const taskOk =
            !taskIs.length ||
            taskIs.map(toLowerSafe).includes(toLowerSafe(req.task));
          const containsOk =
            !contains.length ||
            contains.map(toLowerSafe).every((needle) => p.includes(needle));

          if (taskOk && containsOk) {
            trace.matched = t?.id || "template";
            return finalizeOk(req, startedAt, {
              output: t?.output ?? {
                templateId: t?.id,
                note: "Template matched.",
              },
              messages: t?.messages ?? [`Template matched: ${trace.matched}`],
              trace,
              reasonerId: "templates",
            });
          }
        }

        return finalizeOk(req, startedAt, {
          output: { matched: false },
          messages: ["No template matched."],
          trace,
          reasonerId: "templates",
        });
      } catch (error) {
        return finalizeErr(req, startedAt, { reasonerId: "templates", error });
      }
    },
  };
}

/* -----------------------------------------------------------------------------
 * Minimal deterministic helpers (no heavy NLP)
 * -------------------------------------------------------------------------- */

function summarizeText(text, maxLines = 6) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const sentences = raw
    .split(/(?<=[.!?])\s+/g)
    .map((s) => s.trim())
    .filter(Boolean);

  // Take first N sentences, but cap length
  const picked = sentences.slice(0, Math.max(1, maxLines));
  const joined = picked.join(" ");
  return clampStr(joined, 1200);
}

function simpleLabels(text) {
  const t = toLowerSafe(text);
  const labels = new Set();

  if (/(coupon|discount|promo|rebate|deal)/.test(t)) labels.add("coupons");
  if (/(price|cost|cheaper|compare)/.test(t)) labels.add("pricing");
  if (/(ingredient|allergen|nutrition|calorie)/.test(t))
    labels.add("nutrition");
  if (/(recipe|cook|bake|grill|roast|fry)/.test(t)) labels.add("cooking");
  if (/(clean|laundry|declutter|sanitize)/.test(t)) labels.add("cleaning");
  if (/(garden|plant|harvest|soil)/.test(t)) labels.add("garden");
  if (/(animal|feed|butcher|slaughter)/.test(t)) labels.add("animals");
  if (/(inventory|storehouse|pantry|stock)/.test(t)) labels.add("inventory");

  if (!labels.size) labels.add("general");
  return Array.from(labels);
}

function simpleEntityExtract(text) {
  const raw = String(text || "");
  const entities = {
    numbers: [],
    money: [],
    dates: [],
    urls: [],
    emails: [],
  };

  // numbers
  const nums = raw.match(/\b\d+(?:\.\d+)?\b/g) || [];
  entities.numbers = nums.slice(0, 50);

  // money
  const money = raw.match(/\$\s?\d+(?:\.\d{2})?/g) || [];
  entities.money = money.slice(0, 50);

  // urls
  const urls = raw.match(/\bhttps?:\/\/[^\s]+/g) || [];
  entities.urls = urls.slice(0, 20);

  // emails
  const emails = raw.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) || [];
  entities.emails = emails.slice(0, 20);

  // dates (very rough)
  const dates =
    raw.match(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/g) || [];
  entities.dates = dates.slice(0, 20);

  return entities;
}

/* -----------------------------------------------------------------------------
 * Driver selection / capability model
 * -------------------------------------------------------------------------- */

/**
 * Capability snapshot tells the driver what it can do right now.
 * Caller can override/extend.
 */
function defaultCapabilities() {
  return {
    templatesEnabled: true,
    rulesEnabled: true,
    // Placeholder for future:
    llmEnabled: false,
    toolsEnabled: true,
    offlinePreferred: true,
  };
}

function pickReasoner(cap) {
  const capSnap = cap || defaultCapabilities();
  const list = listReasoners();

  // Filter by supports and enabled flags
  const eligible = list.filter((r) => {
    try {
      if (typeof r.supports === "function" && !r.supports(capSnap))
        return false;
      // soft-enable flags by id
      if (r.id === "templates" && capSnap.templatesEnabled === false)
        return false;
      if (r.id === "rules" && capSnap.rulesEnabled === false) return false;
      if (r.id === "llm" && capSnap.llmEnabled === false) return false;
      return true;
    } catch {
      return false;
    }
  });

  return eligible[0] || null;
}

/* -----------------------------------------------------------------------------
 * Timeout / cancellation
 * -------------------------------------------------------------------------- */

function withTimeout(promise, timeoutMs, signal) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;

  let timer = null;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error("Reasoner timeout"), { code: "ETIMEOUT" })
        ),
      ms
    );
  });

  const abortPromise =
    signal &&
    new Promise((_, reject) => {
      if (signal.aborted) {
        reject(
          Object.assign(new Error("Reasoner canceled"), { code: "ECANCELED" })
        );
        return;
      }
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(
          Object.assign(new Error("Reasoner canceled"), { code: "ECANCELED" })
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });

  const raced = abortPromise
    ? Promise.race([promise, timeoutPromise, abortPromise])
    : Promise.race([promise, timeoutPromise]);

  return raced.finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/* -----------------------------------------------------------------------------
 * Result finalizers
 * -------------------------------------------------------------------------- */

function finalizeOk(req, startedAt, partial) {
  const endedAt = nowMs();
  return {
    runId: req.runId,
    task: req.task,
    reasonerId: partial.reasonerId || "unknown",
    status: "ok",
    output: partial.output,
    messages: Array.isArray(partial.messages) ? partial.messages : [],
    trace: partial.trace || {},
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    error: null,
  };
}

function finalizeErr(req, startedAt, { reasonerId, error }) {
  const endedAt = nowMs();
  const code = error?.code || error?.name || "EERROR";
  const status =
    code === "ETIMEOUT"
      ? "timeout"
      : code === "ECANCELED"
      ? "canceled"
      : "error";
  return {
    runId: req.runId,
    task: req.task,
    reasonerId: reasonerId || "unknown",
    status,
    output: null,
    messages: [],
    trace: { kind: "error", code },
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    error: {
      code,
      message: String(error?.message || error),
      stack: error?.stack || null,
    },
  };
}

/* -----------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */

/**
 * Main driver call.
 *
 * @param {object} input
 * @param {string} input.task - the reasoner task (e.g., "summarize", "extract", "classify", "plan")
 * @param {string|any} input.prompt - prompt or data
 * @param {any} [input.context] - structured context snapshot (prefs, inventory, etc.)
 * @param {any} [input.tools] - tool snapshot or hints
 * @param {object} [input.meta] - caller metadata (source, userId, householdId, etc.)
 * @param {AbortSignal} [input.signal]
 *
 * @param {object} [opts]
 * @param {string} [opts.reasonerId] - force a specific reasoner
 * @param {object} [opts.capabilities] - capability snapshot
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.deterministic]
 * @param {Array<(s:string)=>string>} [opts.scrubbers] - additional scrubbers
 * @returns {Promise<ReasonerResult>}
 */
export async function runReasoner(input, opts = {}) {
  const startedAt = nowMs();
  const runId = input?.meta?.runId || input?.runId || genId("rr");

  const timeoutMs = Number(opts.timeoutMs ?? DEFAULTS.defaultTimeoutMs);
  const deterministic =
    typeof opts.deterministic === "boolean"
      ? opts.deterministic
      : DEFAULTS.deterministic;

  const capabilities = {
    ...defaultCapabilities(),
    ...(opts.capabilities || {}),
  };

  // Prepare prompt/context/tools as strings (for size clamps) but preserve objects too.
  const rawPrompt = input?.prompt;
  const rawContext = input?.context ?? null;
  const rawTools = input?.tools ?? null;

  // scrub + clamp prompt
  let promptStr = safeString(rawPrompt);
  promptStr = applyScrubbers(defaultScrub(promptStr), opts.scrubbers);
  promptStr = clampStr(promptStr, DEFAULTS.maxPromptChars);

  // scrub + clamp context/tools (string forms)
  let contextStr = safeString(rawContext);
  contextStr = applyScrubbers(defaultScrub(contextStr), opts.scrubbers);
  contextStr = clampStr(contextStr, DEFAULTS.maxContextChars);

  let toolsStr = safeString(rawTools);
  toolsStr = clampStr(toolsStr, DEFAULTS.maxToolChars);

  const req = {
    runId,
    task: String(input?.task || "general"),
    prompt: promptStr,
    context: rawContext,
    tools: rawTools,
    meta: {
      ...input?.meta,
      driver: SOURCE,
      driverVersion: DEFAULTS.driverVersion,
      deterministic,
      capabilities,
      // lightweight payload summaries
      promptChars: promptStr.length,
      contextChars: contextStr.length,
      toolsChars: toolsStr.length,
    },
    signal: input?.signal,
  };

  emit("agent.reasoner.started", { runId, task: req.task, meta: req.meta });

  try {
    // Pick reasoner
    const forced = opts.reasonerId ? registry.get(opts.reasonerId) : null;
    const reasoner =
      forced || pickReasoner(capabilities) || registry.get("rules");

    if (!reasoner) {
      throw Object.assign(new Error("No reasoner registered"), {
        code: "ENOREASONER",
      });
    }

    emit("agent.reasoner.selected", {
      runId,
      task: req.task,
      reasonerId: reasoner.id,
      deterministic,
    });

    const result = await withTimeout(
      Promise.resolve().then(() => reasoner.run(req)),
      timeoutMs,
      req.signal
    );

    emit("agent.reasoner.finished", {
      runId,
      task: req.task,
      reasonerId: result?.reasonerId || reasoner.id,
      status: result?.status || "ok",
      durationMs: result?.durationMs ?? nowMs() - startedAt,
    });

    return result;
  } catch (error) {
    const errResult = finalizeErr(req, startedAt, {
      reasonerId: opts.reasonerId || "driver",
      error,
    });

    emit("agent.reasoner.finished", {
      runId,
      task: req.task,
      reasonerId: errResult.reasonerId,
      status: errResult.status,
      durationMs: errResult.durationMs,
      error: errResult.error,
    });

    return errResult;
  }
}

/**
 * Back-compat export expected by sababShim.js:
 *   import { callReasoner } from "@/agents/runtime/reasonerDriver";
 *
 * Keep it as a thin alias to runReasoner().
 */
export async function callReasoner(input, opts = {}) {
  return runReasoner(input, opts);
}

/**
 * Convenience helper to create a "reasoner call" with stable meta.
 */
export function makeReasonerCall(baseMeta = {}) {
  return (task, prompt, context, tools, opts) =>
    runReasoner({ task, prompt, context, tools, meta: { ...baseMeta } }, opts);
}

/**
 * Small helper for "plan-like" output normalization: ensures arrays/objects exist.
 * Callers can use this to avoid UI crashes.
 */
export function normalizePlanOutput(out) {
  const o = out && typeof out === "object" ? out : {};
  return {
    title: o.title || null,
    summary: o.summary || null,
    steps: Array.isArray(o.steps) ? o.steps : [],
    tasks: Array.isArray(o.tasks) ? o.tasks : [],
    warnings: Array.isArray(o.warnings) ? o.warnings : [],
    hints: Array.isArray(o.hints) ? o.hints : [],
    meta: o.meta && typeof o.meta === "object" ? o.meta : {},
  };
}

/* -----------------------------------------------------------------------------
 * Initialize registry with built-ins (idempotent)
 * -------------------------------------------------------------------------- */

let _initialized = false;

/**
 * Call once at app startup (safe to call multiple times).
 */
export function initReasonerDriver() {
  if (_initialized) return;
  _initialized = true;

  // Register built-ins
  if (!registry.has("templates"))
    registerReasoner("templates", makeTemplateReasoner());
  if (!registry.has("rules"))
    registerReasoner("rules", makeRuleBasedReasoner());

  emit("agent.reasoner.registry.ready", {
    reasoners: listReasoners().map((r) => ({
      id: r.id,
      priority: r.priority || 0,
    })),
  });
}

// Auto-init (safe)
initReasonerDriver();

export default {
  runReasoner,
  callReasoner,
  makeReasonerCall,
  normalizePlanOutput,
  initReasonerDriver,
  registerReasoner,
  unregisterReasoner,
  listReasoners,
};
