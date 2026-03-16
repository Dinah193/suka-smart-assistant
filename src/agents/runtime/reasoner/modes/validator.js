// File: src/agents/runtime/reasoner/modes/validator.js
// SSA — Reasoner Mode Validator (production-ready)
//
// Purpose
// - Validate a "mode" definition and/or a resolved policy object.
// - Used by runtime reasoner pipelines (budget/gating/core) to ensure
//   mode config is sane and won’t crash builds or produce unsafe defaults.
//
// Design
// - Pure, deterministic, browser-safe (no Node imports).
// - Returns structured { ok, errors, warnings, normalized }.
// - Does NOT throw by default; callers may choose to throw on !ok.
//
// Works with:
// - Mode objects from `modes/map.js`
// - Resolved policy objects from `resolvePolicy()`
//
// Notes
// - SSA is offline-first: validation favors "warn and continue" unless
//   config is clearly broken.
// - Keep this file dependency-free to avoid Vite build surprises.

/* ------------------------------ helpers ------------------------------ */

function asArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function clamp(n, min, max, fallback) {
  const x = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, x));
}

function normalizeToken(s, fallback = "") {
  const t = String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  return t || fallback;
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    const k = String(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function pushErr(errors, path, message, code = "invalid") {
  errors.push({ code, path, message });
}

function pushWarn(warnings, path, message, code = "warn") {
  warnings.push({ code, path, message });
}

/* ------------------------------ known enums ------------------------------ */

const KNOWN_CACHE_STRATEGIES = new Set([
  "hash",
  "coarse",
  "artifact",
  "entity",
]);
const KNOWN_SOURCES = new Set([
  "local",
  "catalog",
  "artifact",
  "receipt",
  "manual",
  "web",
]);

/* ------------------------------ validators ------------------------------ */

function validateConfidenceBucket(conf, errors, warnings, basePath) {
  const p = basePath || "confidence";
  if (!isObj(conf)) {
    pushErr(errors, p, "confidence must be an object.");
    return null;
  }

  const minAccept = clamp(conf.minAccept, 0, 1, NaN);
  const minWarn = clamp(conf.minWarn, 0, 1, NaN);
  const minBlock = clamp(conf.minBlock, 0, 1, NaN);

  if (!Number.isFinite(minAccept))
    pushErr(errors, `${p}.minAccept`, "Must be a number in [0,1].");
  if (!Number.isFinite(minWarn))
    pushErr(errors, `${p}.minWarn`, "Must be a number in [0,1].");
  if (!Number.isFinite(minBlock))
    pushErr(errors, `${p}.minBlock`, "Must be a number in [0,1].");

  if (
    Number.isFinite(minAccept) &&
    Number.isFinite(minWarn) &&
    minAccept < minWarn
  ) {
    pushWarn(
      warnings,
      p,
      "minAccept is less than minWarn; usually accept >= warn.",
      "threshold_order"
    );
  }
  if (
    Number.isFinite(minWarn) &&
    Number.isFinite(minBlock) &&
    minWarn < minBlock
  ) {
    pushWarn(
      warnings,
      p,
      "minWarn is less than minBlock; usually warn >= block.",
      "threshold_order"
    );
  }

  // weights are optional, but if present, validate numeric and sane
  const weights = conf.weights;
  let normalizedWeights = undefined;
  if (weights != null) {
    if (!isObj(weights)) {
      pushWarn(
        warnings,
        `${p}.weights`,
        "weights should be an object of numeric weights.",
        "weights_shape"
      );
    } else {
      const out = {};
      let sum = 0;
      for (const [k, v] of Object.entries(weights)) {
        const w = typeof v === "string" ? Number(v) : v;
        if (!Number.isFinite(w) || w < 0) {
          pushWarn(
            warnings,
            `${p}.weights.${k}`,
            "Weight should be a non-negative number.",
            "weights_value"
          );
          continue;
        }
        out[k] = w;
        sum += w;
      }
      if (sum > 0) {
        // normalize to sum=1 for stability (callers may ignore)
        for (const k of Object.keys(out)) out[k] = out[k] / sum;
        normalizedWeights = out;
      } else {
        pushWarn(
          warnings,
          `${p}.weights`,
          "weights sum to 0; ignoring.",
          "weights_sum"
        );
      }
    }
  }

  return {
    minAccept: Number.isFinite(minAccept) ? minAccept : conf.minAccept,
    minWarn: Number.isFinite(minWarn) ? minWarn : conf.minWarn,
    minBlock: Number.isFinite(minBlock) ? minBlock : conf.minBlock,
    ...(normalizedWeights ? { weights: normalizedWeights } : {}),
  };
}

function validateFreshnessBucket(fresh, errors, warnings, basePath) {
  const p = basePath || "freshness";
  if (!isObj(fresh)) {
    pushErr(errors, p, "freshness must be an object.");
    return null;
  }

  const maxAgeDays =
    fresh.maxAgeDays != null
      ? clamp(fresh.maxAgeDays, 0, 365000, NaN)
      : undefined;
  const preferRecentDays =
    fresh.preferRecentDays != null
      ? clamp(fresh.preferRecentDays, 0, 365000, NaN)
      : undefined;

  if (fresh.maxAgeDays != null && !Number.isFinite(maxAgeDays)) {
    pushErr(errors, `${p}.maxAgeDays`, "Must be a number >= 0.");
  }
  if (fresh.preferRecentDays != null && !Number.isFinite(preferRecentDays)) {
    pushErr(errors, `${p}.preferRecentDays`, "Must be a number >= 0.");
  }
  if (
    Number.isFinite(maxAgeDays) &&
    Number.isFinite(preferRecentDays) &&
    preferRecentDays > maxAgeDays
  ) {
    pushWarn(
      warnings,
      p,
      "preferRecentDays is greater than maxAgeDays; preferRecentDays is typically <= maxAgeDays.",
      "freshness_order"
    );
  }

  const downrankStale =
    fresh.downrankStale == null ? undefined : !!fresh.downrankStale;

  return {
    ...(maxAgeDays != null ? { maxAgeDays } : {}),
    ...(preferRecentDays != null ? { preferRecentDays } : {}),
    ...(downrankStale != null ? { downrankStale } : {}),
  };
}

function validateCacheBucket(cache, errors, warnings, basePath) {
  const p = basePath || "cache";
  if (!isObj(cache)) {
    pushErr(errors, p, "cache must be an object.");
    return null;
  }

  const enabled = cache.enabled == null ? undefined : !!cache.enabled;

  const ttlMs =
    cache.ttlMs != null
      ? clamp(cache.ttlMs, 0, 365000 * 24 * 60 * 60 * 1000, NaN)
      : undefined;
  if (cache.ttlMs != null && !Number.isFinite(ttlMs)) {
    pushErr(errors, `${p}.ttlMs`, "ttlMs must be a number >= 0.");
  }

  const strategy =
    cache.strategy != null ? normalizeToken(cache.strategy) : undefined;
  if (strategy != null && !KNOWN_CACHE_STRATEGIES.has(strategy)) {
    pushWarn(
      warnings,
      `${p}.strategy`,
      `Unknown cache strategy '${
        cache.strategy
      }'. Expected one of: ${Array.from(KNOWN_CACHE_STRATEGIES).join(", ")}.`,
      "cache_strategy"
    );
  }

  return {
    ...(enabled != null ? { enabled } : {}),
    ...(ttlMs != null ? { ttlMs } : {}),
    ...(strategy != null ? { strategy } : {}),
  };
}

function validateSelectionBucket(sel, errors, warnings, basePath) {
  const p = basePath || "selection";
  if (!isObj(sel)) {
    pushErr(errors, p, "selection must be an object.");
    return null;
  }

  let prefer = undefined;
  if (sel.prefer != null) {
    const arr = asArray(sel.prefer)
      .map((x) => normalizeToken(x))
      .filter(Boolean);
    if (!arr.length) {
      pushWarn(
        warnings,
        `${p}.prefer`,
        "prefer is empty; using engine defaults.",
        "prefer_empty"
      );
    } else {
      const unknown = arr.filter((x) => !KNOWN_SOURCES.has(x));
      if (unknown.length) {
        pushWarn(
          warnings,
          `${p}.prefer`,
          `Unknown sources in prefer: ${unknown.join(
            ", "
          )}. Known: ${Array.from(KNOWN_SOURCES).join(", ")}.`,
          "prefer_unknown"
        );
      }
      prefer = uniq(arr);
    }
  }

  const maxCandidates =
    sel.maxCandidates != null
      ? clamp(sel.maxCandidates, 1, 5000, NaN)
      : undefined;
  if (sel.maxCandidates != null && !Number.isFinite(maxCandidates)) {
    pushErr(
      errors,
      `${p}.maxCandidates`,
      "maxCandidates must be a number >= 1."
    );
  }

  return {
    ...(prefer ? { prefer } : {}),
    ...(maxCandidates != null ? { maxCandidates } : {}),
  };
}

function validateSafetyBucket(safety, errors, warnings, basePath) {
  const p = basePath || "safety";
  if (!isObj(safety)) {
    pushErr(errors, p, "safety must be an object.");
    return null;
  }

  const strict = safety.strict == null ? undefined : !!safety.strict;
  const quietHoursAware =
    safety.quietHoursAware == null ? undefined : !!safety.quietHoursAware;
  const sabbathAware =
    safety.sabbathAware == null ? undefined : !!safety.sabbathAware;

  // Warn if both guards are disabled while strict is true (odd)
  if (strict === true && quietHoursAware === false && sabbathAware === false) {
    pushWarn(
      warnings,
      p,
      "strict=true while quietHoursAware=false and sabbathAware=false; consider enabling guard awareness.",
      "safety_mismatch"
    );
  }

  return {
    ...(strict != null ? { strict } : {}),
    ...(quietHoursAware != null ? { quietHoursAware } : {}),
    ...(sabbathAware != null ? { sabbathAware } : {}),
  };
}

/* ------------------------------ public API ------------------------------ */

/**
 * Validate a Mode definition (from modes/map.js).
 * Returns { ok, errors, warnings, normalized }.
 */
export function validateMode(mode) {
  const errors = [];
  const warnings = [];
  const m = mode || {};

  const id = normalizeToken(m.id);
  if (!id) pushErr(errors, "id", "Mode id is required.");
  const label = String(m.label ?? "").trim();
  if (!label)
    pushWarn(
      warnings,
      "label",
      "Mode label is empty (UI will look rough).",
      "missing_label"
    );

  const defaults = m.defaults;
  if (!isObj(defaults)) {
    pushErr(errors, "defaults", "Mode.defaults must be an object.");
  }

  const normalizedDefaults = {};
  if (isObj(defaults)) {
    const c = validateConfidenceBucket(
      defaults.confidence,
      errors,
      warnings,
      "defaults.confidence"
    );
    const f = validateFreshnessBucket(
      defaults.freshness,
      errors,
      warnings,
      "defaults.freshness"
    );
    const cache = validateCacheBucket(
      defaults.cache,
      errors,
      warnings,
      "defaults.cache"
    );
    const sel = validateSelectionBucket(
      defaults.selection,
      errors,
      warnings,
      "defaults.selection"
    );
    const s = validateSafetyBucket(
      defaults.safety,
      errors,
      warnings,
      "defaults.safety"
    );

    if (c) normalizedDefaults.confidence = c;
    if (f) normalizedDefaults.freshness = f;
    if (cache) normalizedDefaults.cache = cache;
    if (sel) normalizedDefaults.selection = sel;
    if (s) normalizedDefaults.safety = s;
  }

  // selectors are optional; if present validate shape lightly
  const selectors = m.selectors;
  if (selectors != null && !isObj(selectors)) {
    pushWarn(
      warnings,
      "selectors",
      "selectors should be an object.",
      "selectors_shape"
    );
  } else if (isObj(selectors)) {
    for (const bucketName of ["domains", "kinds"]) {
      const bucket = selectors[bucketName];
      const p = `selectors.${bucketName}`;
      if (bucket != null && !isObj(bucket)) {
        pushWarn(
          warnings,
          p,
          `${bucketName} should be an object map.`,
          "selectors_bucket"
        );
        continue;
      }
      if (!isObj(bucket)) continue;
      for (const [key, cfg] of Object.entries(bucket)) {
        const pp = `${p}.${key}`;
        if (!isObj(cfg)) {
          pushWarn(
            warnings,
            pp,
            "Selector config should be an object.",
            "selectors_cfg"
          );
          continue;
        }
        if (cfg.prefer != null) {
          const arr = asArray(cfg.prefer)
            .map((x) => normalizeToken(x))
            .filter(Boolean);
          const unknown = arr.filter((x) => !KNOWN_SOURCES.has(x));
          if (unknown.length) {
            pushWarn(
              warnings,
              `${pp}.prefer`,
              `Unknown sources in prefer: ${unknown.join(", ")}.`,
              "prefer_unknown"
            );
          }
        }
        if (cfg.maxCandidates != null) {
          const mc = clamp(cfg.maxCandidates, 1, 5000, NaN);
          if (!Number.isFinite(mc)) {
            pushWarn(
              warnings,
              `${pp}.maxCandidates`,
              "maxCandidates should be a number >= 1.",
              "maxCandidates"
            );
          }
        }
      }
    }
  }

  const ok = errors.length === 0;

  const normalized = {
    ...m,
    id: id || m.id,
    label: label || m.label,
    defaults: isObj(defaults)
      ? { ...defaults, ...normalizedDefaults }
      : defaults,
  };

  return { ok, errors, warnings, normalized };
}

/**
 * Validate a Resolved Policy object (output of resolvePolicy()).
 * Returns { ok, errors, warnings, normalized }.
 */
export function validatePolicy(policy) {
  const errors = [];
  const warnings = [];
  const p = policy || {};

  const mode = normalizeToken(p.mode || p.modeId || p.id, "default");
  const domain = normalizeToken(p.domain, "generic");
  const kind = normalizeToken(p.kind, "generic");

  // buckets
  const conf = validateConfidenceBucket(
    p.confidence,
    errors,
    warnings,
    "confidence"
  );
  const fresh = validateFreshnessBucket(
    p.freshness,
    errors,
    warnings,
    "freshness"
  );
  const cache = validateCacheBucket(p.cache, errors, warnings, "cache");
  const sel = validateSelectionBucket(
    p.selection,
    errors,
    warnings,
    "selection"
  );
  const safety = validateSafetyBucket(p.safety, errors, warnings, "safety");

  // additional sanity checks
  if (sel?.maxCandidates != null && sel.maxCandidates > 500) {
    pushWarn(
      warnings,
      "selection.maxCandidates",
      "maxCandidates is very high; may slow down evidence selection in large datasets.",
      "perf"
    );
  }
  if (cache?.enabled === true && cache?.ttlMs === 0) {
    pushWarn(
      warnings,
      "cache.ttlMs",
      "cache enabled but ttlMs=0; caching effectively disabled.",
      "cache_ttl"
    );
  }

  const ok = errors.length === 0;

  const normalized = {
    ...p,
    mode,
    domain,
    kind,
    ...(conf ? { confidence: { ...p.confidence, ...conf } } : {}),
    ...(fresh ? { freshness: { ...p.freshness, ...fresh } } : {}),
    ...(cache ? { cache: { ...p.cache, ...cache } } : {}),
    ...(sel ? { selection: { ...p.selection, ...sel } } : {}),
    ...(safety ? { safety: { ...p.safety, ...safety } } : {}),
  };

  return { ok, errors, warnings, normalized };
}

/**
 * Convenience: validate either a mode or a policy-like object by inspecting keys.
 * - If object has `.defaults`, treats as mode.
 * - Else treats as policy.
 */
export function validateModeOrPolicy(obj) {
  if (obj && typeof obj === "object" && "defaults" in obj)
    return validateMode(obj);
  return validatePolicy(obj);
}

/**
 * Alias export expected by shims:
 *   import { validateModeOutput } from "@/agents/runtime/reasoner/modes/validator";
 *
 * In SSA, "mode output" can be:
 * - a resolved policy object
 * - a mode definition (rare)
 * - a "reasoner output" object (best-effort)
 *
 * We treat this as "validate obj by heuristic" unless a schema/mode/policy is supplied.
 *
 * @param {any} value
 * @param {any} [schemaOrModeOrPolicy]
 * @param {object} [opts]
 * @returns {{ ok:boolean, errors:Array<any>, warnings:Array<any>, normalized:any, schemaUsed?:string }}
 */
export function validateModeOutput(value, schemaOrModeOrPolicy, opts = {}) {
  // If caller provided a schema/mode/policy hint, route through validateWithSchema.
  if (schemaOrModeOrPolicy != null) {
    return validateWithSchema(value, schemaOrModeOrPolicy, opts);
  }
  // Otherwise, best-effort heuristic validation.
  const res = validateModeOrPolicy(value);
  return { ...res, schemaUsed: "heuristic" };
}

/**
 * Optional: strict assert helper for callers that want to throw.
 */
export function assertValidMode(mode, message = "Invalid reasoner mode") {
  const res = validateMode(mode);
  if (!res.ok) {
    const details = res.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`${message}: ${details}`);
  }
  return res.normalized;
}

/**
 * Optional: strict assert helper for policies.
 */
export function assertValidPolicy(policy, message = "Invalid reasoner policy") {
  const res = validatePolicy(policy);
  if (!res.ok) {
    const details = res.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`${message}: ${details}`);
  }
  return res.normalized;
}

/**
 * Back-compat export expected by some shims.
 *
 * Name used by shims: `validateWithSchema(...)`
 * In SSA runtime, this validator is *policy/mode sanity*, not full JSON-schema validation.
 * So we accept (value, schema?, opts?) and return a consistent result shape:
 *   { ok, errors, warnings, normalized, schemaUsed }
 *
 * - If `schema` is a function, we call it as a predicate.
 * - If `schema` looks like a mode (has defaults), we validateMode(schema).
 * - Otherwise, we validatePolicy(value) as a safe default.
 */
export function validateWithSchema(value, schema, opts = {}) {
  // If caller gave an actual mode or policy, validate it.
  // Most shims pass a "policy" (resolved mode defaults) as value.
  let res = null;

  // If schema is a function predicate, use it first (non-throwing).
  if (typeof schema === "function") {
    try {
      const ok = !!schema(value, opts);
      res = ok
        ? { ok: true, errors: [], warnings: [], normalized: value }
        : {
            ok: false,
            errors: [
              {
                code: "schema",
                path: "schema",
                message: "Schema predicate returned false.",
              },
            ],
            warnings: [],
            normalized: value,
          };
      return { ...res, schemaUsed: "predicate" };
    } catch (e) {
      return {
        ok: false,
        errors: [
          {
            code: "schema_error",
            path: "schema",
            message: `Schema predicate threw: ${String(e)}`,
          },
        ],
        warnings: [],
        normalized: value,
        schemaUsed: "predicate",
      };
    }
  }

  // If schema looks like a Mode definition, validate it (and also the value as policy if requested).
  if (schema && typeof schema === "object" && "defaults" in schema) {
    const modeRes = validateMode(schema);
    // If caller wants only schema check, honor it.
    if (opts && opts.schemaOnly) return { ...modeRes, schemaUsed: "mode" };

    // Otherwise validate the value as a policy-ish object too (best effort).
    const valRes = validatePolicy(value);
    // Merge: ok only if both ok; concatenate messages.
    const ok = modeRes.ok && valRes.ok;
    return {
      ok,
      errors: [...modeRes.errors, ...valRes.errors],
      warnings: [...modeRes.warnings, ...valRes.warnings],
      normalized: valRes.normalized,
      schemaUsed: "mode+policy",
    };
  }

  // Default: validate the value as policy, with mode/policy heuristics.
  res = validateModeOrPolicy(value);
  return { ...res, schemaUsed: "heuristic" };
}

export default {
  validateMode,
  validatePolicy,
  validateModeOrPolicy,
  validateModeOutput,
  assertValidMode,
  assertValidPolicy,
  validateWithSchema,
};
