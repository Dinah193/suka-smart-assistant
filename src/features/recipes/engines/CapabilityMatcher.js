/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\recipes\engines\CapabilityMatcher.js
//
// SSA • CapabilityMatcher
// -----------------------------------------------------------------------------
// Purpose:
//   Match REQUIRED vs AVAILABLE kitchen capabilities and produce:
//     - missing capabilities (critical blockers)
//     - satisfied capabilities
//     - substitution suggestions (using ToolSubstitutionRules.catalog.js)
//     - method fallback suggestions (optional)
//     - a user-friendly report for CookSetupModal / planners
//
// This engine is deterministic and browser-safe.
//
// Inputs (tolerant):
//   availableCaps:
//     - { tools: { [capKey]: true|false }, tags?: string[] }
//     - OR { capabilities: string[] }   // legacy
//     - OR { available: string[] }      // legacy
//
//   requiredSpec:
//     - { required: string[], optional?: string[], niceToHave?: string[] }
//     - OR { equipmentRequired: [{ key, label, optional }...] }  // from RecipeAdapterService
//     - OR a simple array of required keys
//
// Outputs:
//   {
//     ok: true,
//     satisfied: [{ key, label?, strength, source }],
//     missing: [{ key, label?, critical, reason }],
//     optionalMissing: [{...}],
//     substitutions: [{ missingKey, chosenKey, fromRuleId, confidence, friction, notes }],
//     methodFallbacks: [{ fromMethod, toMethod, reason, confidence }],
//     flags: [],
//     notes: [],
//     warnings: []
//   }
//
// -----------------------------------------------------------------------------
// Dependencies:
//   - ToolSubstitutionRules.catalog.js
// -----------------------------------------------------------------------------
// NOTE: This engine does *NOT* mutate inputs.

import ToolSubstitutionRulesCatalog from "@/features/recipes/catalogs/ToolSubstitutionRules.catalog";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const ENGINE_ID = "features/recipes/engines/CapabilityMatcher";
const ENGINE_VERSION = "1.0.0";

const DEFAULTS = Object.freeze({
  // Should we attempt substitutions for missing required tools?
  allowToolSubstitutions: true,

  // If method is provided and unavailable, should we propose fallbacks?
  allowMethodFallbacks: true,

  // Hard limits for safety
  maxItems: 500,
  maxWarnings: 200,
});

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeLower(s) {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

function safeString(s, max = 256, fallback = "") {
  if (typeof s !== "string") return fallback;
  const t = s.trim();
  return t ? t.slice(0, max) : fallback;
}

function uniqStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(arr) ? arr : []) {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function clamp01(n, fallback = 0.7) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function nowISO() {
  return new Date().toISOString();
}

function addWarning(out, w) {
  if (!out) return;
  if (!Array.isArray(out.warnings)) out.warnings = [];
  if (out.warnings.length >= (out.limits?.maxWarnings ?? DEFAULTS.maxWarnings))
    return;

  if (typeof w === "string") {
    out.warnings.push({ code: "warning", message: w });
    return;
  }

  out.warnings.push({
    code: safeString(w?.code, 128, "warning"),
    message: safeString(w?.message, 1200, "Warning"),
    severity: ["info", "warn", "error"].includes(w?.severity)
      ? w.severity
      : "warn",
    context: isPlainObject(w?.context) ? w.context : {},
  });
}

function pushNote(out, note) {
  if (!out) return;
  if (!Array.isArray(out.notes)) out.notes = [];
  const n = safeString(note, 2000, "");
  if (!n) return;
  out.notes.push(n);
}

/* -------------------------------------------------------------------------- */
/* Normalize available capabilities                                            */
/* -------------------------------------------------------------------------- */

function normalizeAvailableCaps(availableCaps) {
  // Ideal:
  //   { tools: { "appliance:oven": true, ... }, tags: ["small_kitchen"] }
  // Legacy:
  //   { capabilities: ["appliance:oven", ...] }
  //   { available: ["appliance:oven", ...] }
  const caps = isPlainObject(availableCaps) ? availableCaps : {};
  let tools = {};
  let tags = [];

  if (isPlainObject(caps.tools)) {
    tools = { ...caps.tools };
  } else if (Array.isArray(caps.capabilities)) {
    tools = {};
    for (const k of caps.capabilities) tools[String(k)] = true;
  } else if (Array.isArray(caps.available)) {
    tools = {};
    for (const k of caps.available) tools[String(k)] = true;
  } else {
    tools = {};
  }

  tags = uniqStrings(caps.tags || caps.labels || caps.flags || []).map((t) =>
    safeLower(t)
  );
  return { tools, tags };
}

function hasCap(available, key) {
  if (!key) return false;
  const k = String(key);
  return !!available?.tools?.[k];
}

/* -------------------------------------------------------------------------- */
/* Normalize required spec                                                     */
/* -------------------------------------------------------------------------- */

function normalizeRequiredSpec(requiredSpec) {
  // Accept:
  //  - array: ["appliance:oven", ...]
  //  - { required: [], optional: [], niceToHave: [] }
  //  - { equipmentRequired: [{key,label,optional}, ...] }  // from adapter
  //  - { equipment: { required: [], optional: [] } }       // variant/equipment-like
  const spec = requiredSpec;

  const out = {
    required: [],
    optional: [],
    niceToHave: [],
    meta: { source: "unknown" },
    labels: {}, // key -> label (best effort)
  };

  if (Array.isArray(spec)) {
    out.required = uniqStrings(spec);
    out.meta.source = "array";
    return out;
  }

  if (isPlainObject(spec)) {
    // equipmentRequired array form
    const eqReq = Array.isArray(spec.equipmentRequired)
      ? spec.equipmentRequired
      : isPlainObject(spec.equipment) && Array.isArray(spec.equipment.required)
      ? spec.equipment.required
      : null;

    if (eqReq) {
      const required = [];
      const optional = [];
      for (const e of eqReq) {
        if (!isPlainObject(e)) continue;
        const key = safeString(e.key, 200, "");
        if (!key) continue;
        const label = safeString(e.label, 200, "") || key;
        out.labels[key] = label;
        if (e.optional) optional.push(key);
        else required.push(key);
      }

      // Also incorporate spec.equipment.optional if present
      const eqOpt =
        isPlainObject(spec.equipment) && Array.isArray(spec.equipment.optional)
          ? spec.equipment.optional
          : null;
      if (eqOpt) {
        for (const e of eqOpt) {
          if (!isPlainObject(e)) continue;
          const key = safeString(e.key, 200, "");
          if (!key) continue;
          const label = safeString(e.label, 200, "") || key;
          out.labels[key] = label;
          optional.push(key);
        }
      }

      out.required = uniqStrings(required);
      out.optional = uniqStrings(
        optional.filter((k) => !out.required.includes(k))
      );
      out.meta.source = "equipmentRequired";
      return out;
    }

    // plain lists form
    if (
      Array.isArray(spec.required) ||
      Array.isArray(spec.optional) ||
      Array.isArray(spec.niceToHave)
    ) {
      out.required = uniqStrings(spec.required || []);
      out.optional = uniqStrings(spec.optional || []).filter(
        (k) => !out.required.includes(k)
      );
      out.niceToHave = uniqStrings(spec.niceToHave || []).filter(
        (k) => !out.required.includes(k) && !out.optional.includes(k)
      );
      out.meta.source = "lists";
      return out;
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Capability strength heuristics                                              */
/* -------------------------------------------------------------------------- */

function strengthForKey(key) {
  const k = safeLower(key);
  if (k.startsWith("appliance:")) return 1.0;
  if (k.startsWith("cookware:")) return 0.8;
  if (k.startsWith("utensil:")) return 0.6;
  if (k.startsWith("skill:")) return 0.5;
  return 0.7;
}

function defaultLabelForKey(key) {
  const k = safeLower(key);
  if (!k) return "";
  const after = k.includes(":") ? k.split(":")[1] : k;
  return after.replace(/_/g, " ");
}

/* -------------------------------------------------------------------------- */
/* Method fallback suggestions (lightweight, deterministic)                    */
/* -------------------------------------------------------------------------- */

function proposeMethodFallbacks(method, available) {
  // Very conservative: only suggest if we can infer appliance availability.
  const m = safeLower(method);
  if (!m) return [];

  const hasOven =
    hasCap(available, "appliance:oven") ||
    hasCap(available, "appliance:toaster_oven");
  const hasStove = hasCap(available, "appliance:stovetop");
  const hasAirFryer = hasCap(available, "appliance:air_fryer");
  const hasGrill = hasCap(available, "appliance:grill");
  const hasMicrowave = hasCap(available, "appliance:microwave");
  const hasPressure = hasCap(available, "appliance:pressure_cooker");
  const hasSlow = hasCap(available, "appliance:slow_cooker");

  const out = [];

  const push = (toMethod, reason, confidence = 0.7) => {
    out.push({
      fromMethod: m,
      toMethod,
      reason,
      confidence: clamp01(confidence, 0.7),
    });
  };

  const ovenNeeded = ["bake", "roast", "broil"].includes(m);
  const stoveNeeded = [
    "saute",
    "pan_sear",
    "stir_fry",
    "simmer",
    "boil",
    "poach",
  ].includes(m);

  if (ovenNeeded && !hasOven) {
    if (hasAirFryer)
      push(
        "air_fry",
        "No oven detected; air fryer can approximate small-batch baking/roasting.",
        0.75
      );
    if (hasGrill)
      push(
        "grill",
        "No oven detected; grill can approximate roasting with indirect heat.",
        0.65
      );
    if (hasStove)
      push(
        "saute",
        "No oven detected; stovetop cooking can be used with a covered pan.",
        0.55
      );
    if (hasMicrowave)
      push(
        "microwave",
        "No oven detected; microwave can be used for partial cooking/reheating.",
        0.45
      );
  }

  if (stoveNeeded && !hasStove) {
    if (hasGrill)
      push(
        "grill",
        "No stovetop detected; grill can replace direct-heat cooking.",
        0.7
      );
    if (hasMicrowave)
      push(
        "microwave",
        "No stovetop detected; microwave may work for limited steps.",
        0.4
      );
    if (hasPressure)
      push(
        "pressure_cook",
        "No stovetop detected; pressure cooker can cook many braises/stews.",
        0.65
      );
    if (hasSlow)
      push(
        "slow_cook",
        "No stovetop detected; slow cooker can cook many braises/stews.",
        0.6
      );
  }

  if (m === "air_fry" && !hasAirFryer) {
    if (hasOven)
      push(
        "bake",
        "No air fryer detected; oven can replicate with convection if available.",
        0.75
      );
    if (hasGrill)
      push(
        "grill",
        "No air fryer detected; grill can replicate with careful heat control.",
        0.55
      );
  }

  if (m === "grill" && !hasGrill) {
    if (hasOven)
      push(
        "broil",
        "No grill detected; broil can approximate top-down high heat.",
        0.6
      );
    if (hasStove)
      push(
        "pan_sear",
        "No grill detected; pan searing can approximate browned surface.",
        0.6
      );
  }

  // unique toMethod
  const seen = new Set();
  return out.filter((x) => {
    if (seen.has(x.toMethod)) return false;
    seen.add(x.toMethod);
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* Tool substitution application wrapper                                       */
/* -------------------------------------------------------------------------- */

function applyToolSubstitutions(requiredKeys, available, method, tags) {
  if (
    !ToolSubstitutionRulesCatalog ||
    typeof ToolSubstitutionRulesCatalog.applyToolSubstitutionsToEquipment !==
      "function"
  ) {
    return {
      substitutions: [],
      stillMissing: requiredKeys.slice(),
      equipmentResolved: [],
    };
  }

  const equipmentRequired = requiredKeys.map((key) => ({
    id: `equip_${key}`,
    class: key.startsWith("appliance:")
      ? "appliance"
      : key.startsWith("cookware:")
      ? "cookware"
      : "utensil",
    key,
    label: defaultLabelForKey(key),
    optional: false,
    notes: "",
  }));

  const res = ToolSubstitutionRulesCatalog.applyToolSubstitutionsToEquipment({
    equipmentRequired,
    kitchenCaps: available,
    method,
    recipeTags: Array.isArray(tags) ? tags : [],
  });

  return {
    substitutions: Array.isArray(res?.substitutions) ? res.substitutions : [],
    stillMissing: Array.isArray(res?.stillMissing)
      ? res.stillMissing
      : requiredKeys.slice(),
    equipmentResolved: Array.isArray(res?.equipmentResolved)
      ? res.equipmentResolved
      : [],
  };
}

/* -------------------------------------------------------------------------- */
/* Main matcher                                                                */
/* -------------------------------------------------------------------------- */

function matchCapabilities(input = {}) {
  const available = normalizeAvailableCaps(
    input.availableCaps || input.available || {}
  );
  const req = normalizeRequiredSpec(input.requiredSpec || input.required || []);
  const options = normalizeOptions(input.options);

  const method = safeLower(input.method || "");
  const tags = uniqStrings(
    input.tags || input.recipeTags || available.tags || []
  ).map((t) => safeLower(t));

  const out = {
    ok: true,
    engine: { id: ENGINE_ID, version: ENGINE_VERSION },
    at: nowISO(),
    satisfied: [],
    missing: [],
    optionalMissing: [],
    substitutions: [],
    methodFallbacks: [],
    flags: [],
    notes: [],
    warnings: [],
    limits: { maxWarnings: options.maxWarnings },
    meta: {
      requiredCount: req.required.length,
      optionalCount: req.optional.length,
      niceToHaveCount: req.niceToHave.length,
      requiredSource: req.meta.source,
    },
  };

  // Guard limits
  const allReq = req.required.slice(0, DEFAULTS.maxItems);
  const allOpt = req.optional.slice(0, DEFAULTS.maxItems);

  if (req.required.length > DEFAULTS.maxItems) {
    addWarning(out, {
      code: "required_truncated",
      message: `Required list truncated to ${DEFAULTS.maxItems}.`,
      severity: "warn",
      context: { original: req.required.length, max: DEFAULTS.maxItems },
    });
    out.flags.push("required_truncated");
  }

  if (req.optional.length > DEFAULTS.maxItems) {
    addWarning(out, {
      code: "optional_truncated",
      message: `Optional list truncated to ${DEFAULTS.maxItems}.`,
      severity: "warn",
      context: { original: req.optional.length, max: DEFAULTS.maxItems },
    });
    out.flags.push("optional_truncated");
  }

  // Satisfied / missing for required
  const missingRequired = [];
  for (const key of allReq) {
    const label = req.labels[key] || defaultLabelForKey(key) || key;
    if (hasCap(available, key)) {
      out.satisfied.push({
        key,
        label,
        strength: strengthForKey(key),
        source: "available",
      });
    } else {
      missingRequired.push(key);
      out.missing.push({
        key,
        label,
        critical: true,
        reason: "Not available in kitchen capabilities.",
      });
    }
  }

  // Optional missing
  for (const key of allOpt) {
    const label = req.labels[key] || defaultLabelForKey(key) || key;
    if (hasCap(available, key)) {
      out.satisfied.push({
        key,
        label,
        strength: strengthForKey(key),
        source: "available_optional",
      });
    } else {
      out.optionalMissing.push({
        key,
        label,
        critical: false,
        reason: "Optional but not available.",
      });
    }
  }

  // Tool substitutions
  if (options.allowToolSubstitutions && missingRequired.length) {
    const subRes = applyToolSubstitutions(
      missingRequired,
      available,
      method,
      tags
    );
    out.substitutions = (subRes.substitutions || []).map((s) => ({
      missingKey: safeString(s.missingKey, 200, ""),
      chosenKey: safeString(s.chosenKey, 200, ""),
      fromRuleId: safeString(s.fromRuleId, 200, ""),
      confidence: clamp01(s.confidence, 0.6),
      friction: clamp01(s.friction, 0.5),
      notes: safeString(s.notes || "", 800, ""),
      stepRewriteHints: Array.isArray(s.stepRewriteHints)
        ? s.stepRewriteHints
        : [],
    }));

    const stillMissing = Array.isArray(subRes.stillMissing)
      ? subRes.stillMissing
      : missingRequired;

    if (out.substitutions.length) {
      pushNote(
        out,
        `Applied ${out.substitutions.length} tool substitution suggestion(s).`
      );
      out.flags.push("tool_substitutions_suggested");
    }

    // Reduce missing list based on substitutions (if chosenKey is available)
    // We treat substitution as satisfying missing if chosenKey exists.
    const satisfiedBySub = new Set();
    for (const sub of out.substitutions) {
      if (!sub.missingKey || !sub.chosenKey) continue;
      if (hasCap(available, sub.chosenKey)) satisfiedBySub.add(sub.missingKey);
    }

    if (satisfiedBySub.size) {
      // Remove those from missing (but keep record as "resolved by substitution" note)
      out.missing = out.missing.map((m) => {
        if (satisfiedBySub.has(m.key)) {
          return {
            ...m,
            critical: false,
            reason: "Resolved by substitution suggestion.",
            resolvedBy: "substitution",
          };
        }
        return m;
      });
      out.flags.push("missing_resolved_by_substitution");
    }

    // Update critical missing: those still missing (no substitution)
    const criticalStillMissing = new Set(
      stillMissing.filter((k) => !satisfiedBySub.has(k))
    );
    if (criticalStillMissing.size) {
      out.flags.push("critical_missing_capabilities");
      addWarning(out, {
        code: "critical_missing_capabilities",
        message: `Missing critical capability(ies): ${Array.from(
          criticalStillMissing
        ).join(", ")}`,
        severity: "warn",
        context: { missing: Array.from(criticalStillMissing) },
      });
    } else {
      pushNote(
        out,
        "All required capabilities are satisfied directly or via substitution."
      );
    }
  } else if (missingRequired.length) {
    out.flags.push("critical_missing_capabilities");
    addWarning(out, {
      code: "critical_missing_capabilities",
      message: `Missing required capability(ies): ${missingRequired.join(
        ", "
      )}`,
      severity: "warn",
      context: { missing: missingRequired },
    });
  }

  // Method fallbacks
  if (options.allowMethodFallbacks && method) {
    // if method implies an appliance that is missing, suggest alternatives
    const fallbacks = proposeMethodFallbacks(method, available);
    if (fallbacks.length) {
      out.methodFallbacks = fallbacks;
      out.flags.push("method_fallbacks_suggested");
      pushNote(
        out,
        `Suggested ${fallbacks.length} method fallback(s) based on available appliances.`
      );
    }
  }

  // Quick quality evaluation
  const stillCriticalMissing = out.missing.filter((m) => m.critical === true);
  if (stillCriticalMissing.length) {
    out.ok = false;
    out.flags.push("needs_user_review");
  }

  // Deduplicate satisfied keys
  const seenSat = new Set();
  out.satisfied = out.satisfied.filter((s) => {
    const k = s.key;
    if (seenSat.has(k)) return false;
    seenSat.add(k);
    return true;
  });

  return out;
}

/* -------------------------------------------------------------------------- */
/* Convenience: build requiredSpec from recipe/variant/cookPlan structures     */
/* -------------------------------------------------------------------------- */

function buildRequiredSpecFromVariantOrPlan(input = {}) {
  // Accept:
  //  - variant.equipment.required/optional arrays of objects with key/label
  //  - cookPlan.equipment.required/optional arrays
  //  - variant.steps[*].requires.equipmentIds arrays
  const variant = input.variant || null;
  const cookPlan = input.cookPlan || null;

  const required = [];
  const optional = [];
  const labels = {};

  const addEquipObj = (e, isOptional) => {
    if (!isPlainObject(e)) return;
    const key = safeString(e.key, 200, "");
    if (!key) return;
    const label =
      safeString(e.label, 200, "") || defaultLabelForKey(key) || key;
    labels[key] = label;
    (isOptional ? optional : required).push(key);
  };

  const addKey = (key, isOptional) => {
    const k = safeString(key, 200, "");
    if (!k) return;
    (isOptional ? optional : required).push(k);
  };

  const collectFromEquipment = (eq) => {
    if (!isPlainObject(eq)) return;
    if (Array.isArray(eq.required))
      eq.required.forEach((e) => addEquipObj(e, false));
    if (Array.isArray(eq.optional))
      eq.optional.forEach((e) => addEquipObj(e, true));
  };

  if (isPlainObject(variant)) collectFromEquipment(variant.equipment);
  if (isPlainObject(cookPlan)) collectFromEquipment(cookPlan.equipment);

  // Steps requires
  const steps = Array.isArray(variant?.steps)
    ? variant.steps
    : Array.isArray(cookPlan?.timeline)
    ? cookPlan.timeline
    : [];
  for (const s of steps) {
    const ids = s?.requires?.equipmentIds;
    if (Array.isArray(ids)) ids.forEach((k) => addKey(k, false));
  }

  // Normalize, remove overlaps
  const reqUniq = uniqStrings(required);
  const optUniq = uniqStrings(optional).filter((k) => !reqUniq.includes(k));

  return {
    required: reqUniq,
    optional: optUniq,
    niceToHave: [],
    labels,
  };
}

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

function normalizeOptions(options) {
  const o = isPlainObject(options) ? options : {};
  return {
    allowToolSubstitutions:
      typeof o.allowToolSubstitutions === "boolean"
        ? o.allowToolSubstitutions
        : DEFAULTS.allowToolSubstitutions,
    allowMethodFallbacks:
      typeof o.allowMethodFallbacks === "boolean"
        ? o.allowMethodFallbacks
        : DEFAULTS.allowMethodFallbacks,
    maxWarnings: Number.isFinite(Number(o.maxWarnings))
      ? Number(o.maxWarnings)
      : DEFAULTS.maxWarnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                     */
/* -------------------------------------------------------------------------- */

const CapabilityMatcher = Object.freeze({
  engine: { id: ENGINE_ID, version: ENGINE_VERSION },
  matchCapabilities,
  buildRequiredSpecFromVariantOrPlan,
  normalizeAvailableCaps,
  normalizeRequiredSpec,
  hasCap,
});

export {
  CapabilityMatcher,
  ENGINE_ID,
  ENGINE_VERSION,
  matchCapabilities,
  buildRequiredSpecFromVariantOrPlan,
  normalizeAvailableCaps,
  normalizeRequiredSpec,
  hasCap,
};

export default CapabilityMatcher;
