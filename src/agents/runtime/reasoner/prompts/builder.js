// C:\Users\larho\suka-smart-assistant\src\agents\runtime\reasoner\prompts\builder.js
/**
 * Reasoner Prompt Builder
 * ---------------------------------------------------------------------------
 * Builds the final prompt payload for the Reasoner call.
 *
 * Output formats supported:
 *  - "messages": array of { role, content }
 *  - "text": single string
 *
 * This module is intentionally browser-safe (no node:* imports).
 */

import { buildSystemMessage, buildSystemText } from "./system.js";
import {
  renderTemplateForMode,
  coerceToMessages,
  stringifyForTextPrompt,
} from "./templates.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function safeJson(x) {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

function clampNum(n, lo, hi, fallback) {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Extract a lightweight "input summary" for prompts (avoid dumping massive objects).
 */
function summarizeInput(input, runtime) {
  const maxKeys = Number(runtime?.promptMaxInputKeys ?? 40);
  const maxString = Number(runtime?.promptMaxStringLen ?? 2000);

  if (!isObject(input)) return input;

  const keys = Object.keys(input);
  const picked = {};
  for (let i = 0; i < Math.min(keys.length, maxKeys); i += 1) {
    const k = keys[i];
    const v = input[k];
    if (typeof v === "string" && v.length > maxString) {
      picked[k] = `${v.slice(0, maxString)}…(truncated)`;
    } else {
      picked[k] = v;
    }
  }

  if (keys.length > maxKeys) {
    picked.__note__ = `Input truncated: included ${maxKeys}/${keys.length} keys`;
  }

  return picked;
}

/**
 * Extract a lightweight "context summary" for prompts (avoid Dexie dumps).
 */
function summarizeContext(context, runtime) {
  const maxKeys = Number(runtime?.promptMaxContextKeys ?? 60);
  const maxString = Number(runtime?.promptMaxStringLen ?? 2000);

  if (!isObject(context)) return context;

  const keys = Object.keys(context);
  const picked = {};
  for (let i = 0; i < Math.min(keys.length, maxKeys); i += 1) {
    const k = keys[i];
    const v = context[k];
    if (typeof v === "string" && v.length > maxString) {
      picked[k] = `${v.slice(0, maxString)}…(truncated)`;
    } else {
      picked[k] = v;
    }
  }

  if (keys.length > maxKeys) {
    picked.__note__ = `Context truncated: included ${maxKeys}/${keys.length} keys`;
  }

  return picked;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Normalize evidence into a stable, lightweight structure suitable for gating
 * decisions (budget/confidence) and prompt selection.
 *
 * This function is intentionally tolerant: callers may pass:
 * - array of evidence items
 * - object with { items } or { evidence }
 * - null/undefined
 *
 * Each item is normalized to:
 * { id, source, ts, kind, score, title, snippet, meta }
 *
 * @param {any} evidence
 * @param {object} [opts]
 * @param {number} [opts.maxItems=200]
 * @param {number} [opts.maxSnippetLen=600]
 * @returns {{ items: Array<object>, counts: object, newestTs: string|null }}
 */
export function normalizeEvidence(evidence, opts = {}) {
  const maxItems = clampNum(opts.maxItems, 0, 5000, 200);
  const maxSnippetLen = clampNum(opts.maxSnippetLen, 0, 5000, 600);

  let raw = evidence;

  // common wrapper shapes
  if (isObject(raw)) {
    if (Array.isArray(raw.items)) raw = raw.items;
    else if (Array.isArray(raw.evidence)) raw = raw.evidence;
    else if (Array.isArray(raw.sources)) raw = raw.sources;
  }

  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const items = [];
  const counts = {
    total: 0,
    bySource: {},
    byKind: {},
  };

  let newestMs = -1;

  for (let i = 0; i < Math.min(arr.length, maxItems); i += 1) {
    const it = arr[i] || {};
    const src = String(it.source ?? it.provider ?? it.from ?? "unknown");
    const kind = String(it.kind ?? it.type ?? "evidence");
    const ts = it.ts || it.time || it.at || it.date || null;

    let tsIso = null;
    if (typeof ts === "string" && ts.trim()) {
      const d = new Date(ts);
      if (!Number.isNaN(d.getTime())) {
        tsIso = d.toISOString();
        if (d.getTime() > newestMs) newestMs = d.getTime();
      }
    } else if (typeof ts === "number" && Number.isFinite(ts)) {
      const d = new Date(ts);
      tsIso = d.toISOString();
      if (d.getTime() > newestMs) newestMs = d.getTime();
    }

    const title = typeof it.title === "string" ? it.title : "";
    const snippetRaw =
      typeof it.snippet === "string"
        ? it.snippet
        : typeof it.text === "string"
        ? it.text
        : typeof it.summary === "string"
        ? it.summary
        : "";

    const snippet =
      snippetRaw && snippetRaw.length > maxSnippetLen
        ? `${snippetRaw.slice(0, maxSnippetLen)}…`
        : snippetRaw;

    const score =
      typeof it.score === "number"
        ? it.score
        : typeof it.confidence === "number"
        ? it.confidence
        : null;

    const id =
      typeof it.id === "string" && it.id.trim()
        ? it.id.trim()
        : `${src}:${kind}:${i}`;

    const meta = isObject(it.meta)
      ? it.meta
      : isObject(it.metadata)
      ? it.metadata
      : undefined;

    items.push({
      id,
      source: src,
      kind,
      ts: tsIso,
      score,
      title,
      snippet,
      meta,
    });

    counts.total += 1;
    counts.bySource[src] = (counts.bySource[src] || 0) + 1;
    counts.byKind[kind] = (counts.byKind[kind] || 0) + 1;
  }

  return {
    items,
    counts,
    newestTs: newestMs >= 0 ? new Date(newestMs).toISOString() : null,
  };
}

/**
 * Resolve prompt policy inputs for gating / caching decisions.
 * Kept conservative and browser-safe; does not depend on mode registry.
 *
 * This normalizes:
 * - prompt format ("messages" | "text")
 * - truncation caps (input/context keys, string length)
 * - whether to include a DATA_PAYLOAD message
 *
 * @param {object} args
 * @param {object} [args.runtime]
 * @param {string} [args.mode]
 * @param {string} [args.domain]
 * @param {string} [args.intent]
 * @param {object} [args.policy] optional explicit policy override
 * @returns {{ promptFormat: string, promptMaxInputKeys: number, promptMaxContextKeys: number, promptMaxStringLen: number, includePayload: boolean }}
 */
export function resolvePromptPolicy({
  runtime = {},
  mode,
  domain,
  intent,
  policy,
} = {}) {
  const p = isObject(policy) ? policy : {};

  const fmt =
    p.promptFormat ||
    p.format ||
    runtime?.promptFormat ||
    runtime?.format ||
    runtime?.reasonerPromptFormat ||
    "messages";

  const promptFormat = fmt === "text" ? "text" : "messages";

  const promptMaxInputKeys = clampNum(
    p.promptMaxInputKeys ?? runtime?.promptMaxInputKeys,
    5,
    500,
    40
  );
  const promptMaxContextKeys = clampNum(
    p.promptMaxContextKeys ?? runtime?.promptMaxContextKeys,
    5,
    1000,
    60
  );
  const promptMaxStringLen = clampNum(
    p.promptMaxStringLen ?? runtime?.promptMaxStringLen,
    200,
    20000,
    2000
  );

  // Include payload by default for messages prompts; optional for text prompts.
  const includePayload =
    p.includePayload != null ? !!p.includePayload : promptFormat === "messages";

  return {
    promptFormat,
    promptMaxInputKeys,
    promptMaxContextKeys,
    promptMaxStringLen,
    includePayload,
    // these are helpful for debug and future shaping, but harmless
    mode: mode || null,
    domain: domain || null,
    intent: intent || null,
  };
}

/**
 * Build the final Reasoner prompt payload for a mode.
 *
 * @param {Object} args
 * @param {string} args.mode
 * @param {string} args.domain
 * @param {string} args.intent
 * @param {Object} args.input
 * @param {Object} args.context
 * @param {Object} [args.runtime]
 * @returns {Array<{role: string, content: string}>|string}
 */
export function buildPromptForMode({
  mode,
  domain,
  intent,
  input,
  context,
  runtime = {},
}) {
  const policy = resolvePromptPolicy({ runtime, mode, domain, intent });

  const promptFormat = policy.promptFormat;

  const system =
    promptFormat === "text"
      ? buildSystemText({ domain, intent, mode, runtime })
      : buildSystemMessage({ domain, intent, mode, runtime });

  // Render the domain/mode template
  const template = renderTemplateForMode({
    mode,
    domain,
    intent,
    runtime: {
      ...runtime,
      promptFormat,
      promptMaxInputKeys: policy.promptMaxInputKeys,
      promptMaxContextKeys: policy.promptMaxContextKeys,
      promptMaxStringLen: policy.promptMaxStringLen,
    },
    input: summarizeInput(input, policy),
    context: summarizeContext(context, policy),
  });

  // If templates returns something non-standard, normalize it.
  if (promptFormat === "text") {
    const sysText = typeof system === "string" ? system : system?.content || "";
    const asText = stringifyForTextPrompt(template);

    // Put system first; append payload
    return [
      sysText,
      "",
      "INPUT:",
      safeJson(summarizeInput(input, policy)),
      "",
      "CONTEXT:",
      safeJson(summarizeContext(context, policy)),
      "",
      "TASK:",
      asText,
    ].join("\n");
  }

  // messages format
  const sysMsg =
    typeof system === "string" ? { role: "system", content: system } : system;

  const msgs = coerceToMessages(template);

  if (!policy.includePayload) {
    return [sysMsg, ...msgs];
  }

  // We also add a compact “data payload” message to help deterministic outputs
  const payloadMsg = {
    role: "user",
    content: [
      "DATA_PAYLOAD (JSON):",
      safeJson({
        domain,
        intent,
        mode,
        input: summarizeInput(input, policy),
        context: summarizeContext(context, policy),
      }),
    ].join("\n"),
  };

  return [sysMsg, payloadMsg, ...msgs];
}

export default buildPromptForMode;
