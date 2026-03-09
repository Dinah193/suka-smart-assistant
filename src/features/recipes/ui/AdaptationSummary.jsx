/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\recipes\ui\AdaptationSummary.jsx
//
// SSA • AdaptationSummary ("what changed and why")
// -----------------------------------------------------------------------------
// Purpose:
//   Human-friendly explanation of what SSA changed during recipe adaptation.
//   Used by CookSetupModal after RecipeAdapterService runs.
//
// Design goals:
//   - Deterministic, explainable summary: "what changed" + "why" + "impact".
//   - Works even if adapter output shapes vary slightly (defensive normalization).
//   - Supports:
//       • method plan selection + feasibility tradeoffs
//       • tool/equipment substitutions
//       • doneness target resolution
//       • step transformations (text rewrites, added warnings, inserted timers)
//       • extracted timers + tasks
//       • ingredient/unit adjustments (if present)
//       • capability gaps (missing equipment/capabilities)
//       • copy to clipboard and "export JSON" (download) for debugging
//
// Props:
//   adaptation?: object
//     Expected (best-effort) fields (any optional):
//       {
//         status?: "ok"|"warn"|"bad",
//         recipeId?: string,
//         source?: string,
//         version?: string,
//         createdAt?: number|ISO,
//         selectedPlan?: { id, methodKey, methodLabel, feasible, severity, score, requires, missing, substitutions, deltas, notes, why },
//         plans?: Array<...>                      // optional, summary only
//         doneness?: {
//            resolved?: { targetKey, targetName, internalTempF, internalTempC, confidence, notes, evidence },
//            userSelection?: { targetKey, targetName, internalTempF, internalTempC, notes }
//         },
//         capabilityReport?: {
//            feasible?: boolean,
//            missingEquipmentIds?: string[],
//            missingCapabilityKeys?: string[],
//            substitutions?: Array<{ missingKey, chosenKey, confidence, friction, notes }>
//         },
//         substitutions?: Array<{ ...same as above }>,
//         toolSubstitutions?: Array<{ ... }>,
//         ingredientSubstitutions?: Array<{ from, to, reason, confidence, notes }>,
//         ingredientAdjustments?: Array<{ key, fromQty, toQty, fromUnit, toUnit, reason }>,
//         stepDiff?: {
//            originalCount?: number,
//            adaptedCount?: number,
//            changes?: Array<{
//               kind: "rewrite"|"insert"|"remove"|"timer"|"task"|"warning"|"note"|"equipment"|"temperature"|"time"|"other",
//               stepIndex?: number,
//               before?: string,
//               after?: string,
//               reason?: string,
//               evidence?: any,
//               meta?: any
//            }>
//         },
//         adaptedSteps?: Array<{ text, timers?, tasks?, equipmentIds?, notes?, warnings? }>,
//         timers?: Array<{ label, seconds, kind?, stepIndex?, sourceText? }>,
//         tasks?: Array<{ label, kind?, stepIndex?, dueAtOffsetSeconds? }>,
//         warnings?: Array<{ label, severity?, reason?, stepIndex? }>,
//         notes?: Array<string>,
//         audit?: Array<{ code, message, level, context?, data? }>
//       }
//
//   equipmentCatalog?: Record<string, { id, label?, category?, icon? }> // optional; used for nicer names
//   showDebug?: boolean             // default false; shows JSON + export
//   compact?: boolean               // default false; tighter spacing
//   header?: string
//   subheader?: string
//
// -----------------------------------------------------------------------------
// Integration (CookSetupModal):
//   <AdaptationSummary
//     adaptation={adapterOut}
//     equipmentCatalog={EQUIPMENT_CATALOG_MAP}
//     showDebug={debugMode}
//   />
//
// No placeholders. Production-ready.

import React, { useMemo, useState } from "react";

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeString(s, max = 1200, fallback = "") {
  if (typeof s !== "string") return fallback;
  const t = s.trim();
  return t ? t.slice(0, max) : fallback;
}

function safeLower(s) {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

function uniq(arr) {
  return Array.from(
    new Set(
      (Array.isArray(arr) ? arr : [])
        .map((x) => safeString(String(x), 160, ""))
        .filter(Boolean)
    )
  );
}

function clamp01(n, fallback = 0.7) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function formatSeconds(sec) {
  const x = Number(sec);
  if (!Number.isFinite(x)) return "—";
  const s = Math.max(0, Math.round(x));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (r && !h) parts.push(`${r}s`);
  return parts.join(" ") || "0s";
}

function pillStyle(tone = "neutral") {
  const bg =
    tone === "good"
      ? "rgba(46, 204, 113, 0.18)"
      : tone === "warn"
      ? "rgba(241, 196, 15, 0.18)"
      : tone === "bad"
      ? "rgba(231, 76, 60, 0.18)"
      : "rgba(0,0,0,0.10)";
  const border =
    tone === "good"
      ? "rgba(46, 204, 113, 0.35)"
      : tone === "warn"
      ? "rgba(241, 196, 15, 0.35)"
      : tone === "bad"
      ? "rgba(231, 76, 60, 0.35)"
      : "rgba(0,0,0,0.20)";
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "2px 10px",
    borderRadius: 999,
    background: bg,
    border: `1px solid ${border}`,
    fontSize: 12,
    lineHeight: "18px",
    marginRight: 8,
    marginBottom: 6,
    whiteSpace: "nowrap",
  };
}

function normalizeCatalog(equipmentCatalog) {
  const cat = isPlainObject(equipmentCatalog) ? equipmentCatalog : {};
  const out = {};
  for (const [k, v] of Object.entries(cat)) {
    const id = safeString((v && v.id) || k, 160, "");
    if (!id) continue;
    out[id] = {
      id,
      label: safeString(v?.label || id, 200, id),
      category: safeString(v?.category || "", 80, "") || "Other",
      icon: safeString(v?.icon || "", 12, ""),
    };
  }
  return out;
}

function equipmentLabel(id, catalog) {
  const item = catalog?.[id];
  if (item?.label) return item.label;
  return safeString(String(id).replace(/[_-]+/g, " "), 220, id);
}

function normalizeAdaptation(adaptation) {
  const a = isPlainObject(adaptation) ? adaptation : {};
  const statusRaw = safeLower(a.status || "");
  const status =
    statusRaw === "ok" || statusRaw === "warn" || statusRaw === "bad"
      ? statusRaw
      : "ok";

  const selectedPlan = isPlainObject(a.selectedPlan) ? a.selectedPlan : null;
  const plan = selectedPlan
    ? {
        id: safeString(selectedPlan.id || "", 160, ""),
        methodKey: safeString(selectedPlan.methodKey || "", 80, ""),
        methodLabel: safeString(selectedPlan.methodLabel || "", 120, ""),
        feasible: !!selectedPlan.feasible,
        severity:
          safeLower(selectedPlan.severity || "") ||
          (selectedPlan.feasible ? "ok" : "bad"),
        score: Number.isFinite(Number(selectedPlan.score))
          ? Number(selectedPlan.score)
          : null,
        requires: {
          equipmentIds: uniq(selectedPlan.requires?.equipmentIds),
          capabilityKeys: uniq(selectedPlan.requires?.capabilityKeys),
        },
        missing: {
          equipmentIds: uniq(selectedPlan.missing?.equipmentIds),
          capabilityKeys: uniq(selectedPlan.missing?.capabilityKeys),
        },
        substitutions: normalizeSubstitutions(selectedPlan.substitutions),
        deltas: normalizeDeltas(selectedPlan.deltas),
        notes: safeString(selectedPlan.notes || "", 1000, ""),
        why: safeString(selectedPlan.why || "", 1200, ""),
      }
    : null;

  const cap = isPlainObject(a.capabilityReport) ? a.capabilityReport : null;

  const capabilityReport = cap
    ? {
        feasible: cap.feasible == null ? null : !!cap.feasible,
        missingEquipmentIds: uniq(cap.missingEquipmentIds),
        missingCapabilityKeys: uniq(cap.missingCapabilityKeys),
        substitutions: normalizeSubstitutions(cap.substitutions),
      }
    : null;

  // unify substitutions from possible fields
  const subs = normalizeSubstitutions(
    a.substitutions || a.toolSubstitutions || []
  );

  const ingredientSubs = normalizeIngredientSubs(a.ingredientSubstitutions);
  const ingredientAdj = normalizeIngredientAdjustments(a.ingredientAdjustments);

  const stepDiff = normalizeStepDiff(a.stepDiff, a.adaptedSteps);

  const timers = normalizeTimers(a.timers, a.adaptedSteps);
  const tasks = normalizeTasks(a.tasks, a.adaptedSteps);
  const warnings = normalizeWarnings(a.warnings, a.adaptedSteps);

  const notes = Array.isArray(a.notes)
    ? a.notes.map((x) => safeString(String(x), 600, "")).filter(Boolean)
    : [];

  const audit = Array.isArray(a.audit)
    ? a.audit
        .map((x) => ({
          code: safeString(x?.code || "", 80, ""),
          message: safeString(x?.message || "", 600, ""),
          level: safeLower(x?.level || "") || "info",
          context: x?.context ?? null,
          data: x?.data ?? null,
        }))
        .filter((x) => x.code || x.message)
    : [];

  const doneness = normalizeDoneness(a.doneness);

  return {
    status,
    recipeId: safeString(a.recipeId || "", 200, ""),
    source: safeString(a.source || "", 200, ""),
    version: safeString(a.version || "", 60, ""),
    createdAt: a.createdAt ?? null,
    selectedPlan: plan,
    capabilityReport,
    substitutions: subs,
    ingredientSubstitutions: ingredientSubs,
    ingredientAdjustments: ingredientAdj,
    stepDiff,
    timers,
    tasks,
    warnings,
    notes,
    audit,
    raw: a,
  };
}

function normalizeSubstitutions(substitutions) {
  const arr = Array.isArray(substitutions) ? substitutions : [];
  const out = [];
  for (const s of arr) {
    if (!s) continue;
    const missingKey = safeString(s.missingKey || s.from || "", 160, "");
    const chosenKey = safeString(s.chosenKey || s.to || "", 160, "");
    if (!missingKey || !chosenKey) continue;
    out.push({
      missingKey,
      chosenKey,
      confidence: clamp01(s.confidence, 0.7),
      friction: clamp01(s.friction, 0.5),
      notes: safeString(s.notes || s.reason || "", 600, ""),
    });
  }
  return out;
}

function normalizeIngredientSubs(arr) {
  const a = Array.isArray(arr) ? arr : [];
  const out = [];
  for (const s of a) {
    if (!s) continue;
    const from = safeString(s.from || "", 200, "");
    const to = safeString(s.to || "", 200, "");
    if (!from || !to) continue;
    out.push({
      from,
      to,
      reason: safeString(s.reason || "", 800, ""),
      confidence: clamp01(s.confidence, 0.7),
      notes: safeString(s.notes || "", 800, ""),
    });
  }
  return out;
}

function normalizeIngredientAdjustments(arr) {
  const a = Array.isArray(arr) ? arr : [];
  const out = [];
  for (const it of a) {
    if (!it) continue;
    const key = safeString(it.key || it.ingredient || "", 240, "");
    if (!key) continue;
    out.push({
      key,
      fromQty: it.fromQty ?? null,
      toQty: it.toQty ?? null,
      fromUnit: safeString(it.fromUnit || "", 40, ""),
      toUnit: safeString(it.toUnit || "", 40, ""),
      reason: safeString(it.reason || "", 800, ""),
    });
  }
  return out;
}

function normalizeDeltas(d) {
  const o = isPlainObject(d) ? d : {};
  return {
    timeSeconds: Number.isFinite(Number(o.timeSeconds))
      ? Number(o.timeSeconds)
      : null,
    stepsDelta: Number.isFinite(Number(o.stepsDelta))
      ? Number(o.stepsDelta)
      : null,
    complexity: o.complexity == null ? null : clamp01(o.complexity, 0.5),
    cleanup: o.cleanup == null ? null : clamp01(o.cleanup, 0.5),
  };
}

function normalizeStepDiff(stepDiff, adaptedSteps) {
  const sd = isPlainObject(stepDiff) ? stepDiff : {};
  const changesArr = Array.isArray(sd.changes) ? sd.changes : [];

  const changes = changesArr
    .map((c) => ({
      kind: safeLower(c?.kind || "other") || "other",
      stepIndex: Number.isFinite(Number(c?.stepIndex))
        ? Number(c.stepIndex)
        : null,
      before: safeString(c?.before || "", 3000, ""),
      after: safeString(c?.after || "", 3000, ""),
      reason: safeString(c?.reason || "", 1200, ""),
      evidence: c?.evidence ?? null,
      meta: c?.meta ?? null,
    }))
    .filter((c) => c.before || c.after || c.reason);

  // fallback counts if absent
  const adaptedCount =
    sd.adaptedCount ??
    (Array.isArray(adaptedSteps) ? adaptedSteps.length : null);
  const originalCount = sd.originalCount ?? null;

  // If no explicit diff provided, infer "insertions" from adaptedSteps annotations
  if (!changes.length && Array.isArray(adaptedSteps) && adaptedSteps.length) {
    const inferred = inferStepChangesFromAdaptedSteps(adaptedSteps);
    return { originalCount, adaptedCount, changes: inferred };
  }

  return {
    originalCount: Number.isFinite(Number(originalCount))
      ? Number(originalCount)
      : null,
    adaptedCount: Number.isFinite(Number(adaptedCount))
      ? Number(adaptedCount)
      : null,
    changes,
  };
}

function inferStepChangesFromAdaptedSteps(adaptedSteps) {
  const out = [];
  adaptedSteps.forEach((s, idx) => {
    if (!s) return;
    const text = safeString(s.text || s.after || "", 3000, "");
    const timers = Array.isArray(s.timers) ? s.timers : [];
    const tasks = Array.isArray(s.tasks) ? s.tasks : [];
    const warnings = Array.isArray(s.warnings) ? s.warnings : [];
    const notes = Array.isArray(s.notes) ? s.notes : [];

    if (warnings.length) {
      out.push({
        kind: "warning",
        stepIndex: idx,
        before: "",
        after: text,
        reason: "Added safety/quality warning(s) for this step.",
        evidence: { warnings: warnings.slice(0, 5) },
        meta: null,
      });
    }
    if (timers.length) {
      out.push({
        kind: "timer",
        stepIndex: idx,
        before: "",
        after: text,
        reason: "Extracted timer(s) to help run the session hands-free.",
        evidence: { timers: timers.slice(0, 5) },
        meta: null,
      });
    }
    if (tasks.length) {
      out.push({
        kind: "task",
        stepIndex: idx,
        before: "",
        after: text,
        reason: "Created prep/parallel task(s) for smoother flow.",
        evidence: { tasks: tasks.slice(0, 5) },
        meta: null,
      });
    }
    if (notes.length) {
      out.push({
        kind: "note",
        stepIndex: idx,
        before: "",
        after: text,
        reason: "Added contextual note(s) to reduce confusion.",
        evidence: { notes: notes.slice(0, 5) },
        meta: null,
      });
    }
  });
  return out;
}

function normalizeTimers(timers, adaptedSteps) {
  const arr = Array.isArray(timers) ? timers : [];
  const out = [];
  for (const t of arr) {
    if (!t) continue;
    const seconds = Number(t.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    out.push({
      label: safeString(t.label || "Timer", 200, "Timer"),
      seconds: Math.round(seconds),
      kind: safeLower(t.kind || "") || "timer",
      stepIndex: Number.isFinite(Number(t.stepIndex))
        ? Number(t.stepIndex)
        : null,
      sourceText: safeString(t.sourceText || "", 800, ""),
    });
  }
  if (out.length) return out;

  // fallback from adaptedSteps
  if (Array.isArray(adaptedSteps)) {
    const inferred = [];
    adaptedSteps.forEach((s, idx) => {
      const ts = Array.isArray(s?.timers) ? s.timers : [];
      ts.forEach((t) => {
        const seconds = Number(t?.seconds);
        if (!Number.isFinite(seconds) || seconds <= 0) return;
        inferred.push({
          label: safeString(t?.label || "Timer", 200, "Timer"),
          seconds: Math.round(seconds),
          kind: safeLower(t?.kind || "") || "timer",
          stepIndex: idx,
          sourceText: safeString(t?.sourceText || "", 800, ""),
        });
      });
    });
    return inferred;
  }
  return [];
}

function normalizeTasks(tasks, adaptedSteps) {
  const arr = Array.isArray(tasks) ? tasks : [];
  const out = [];
  for (const t of arr) {
    if (!t) continue;
    const label = safeString(t.label || "", 260, "");
    if (!label) continue;
    out.push({
      label,
      kind: safeLower(t.kind || "") || "task",
      stepIndex: Number.isFinite(Number(t.stepIndex))
        ? Number(t.stepIndex)
        : null,
      dueAtOffsetSeconds: Number.isFinite(Number(t.dueAtOffsetSeconds))
        ? Number(t.dueAtOffsetSeconds)
        : null,
    });
  }
  if (out.length) return out;

  // fallback from adaptedSteps
  if (Array.isArray(adaptedSteps)) {
    const inferred = [];
    adaptedSteps.forEach((s, idx) => {
      const ts = Array.isArray(s?.tasks) ? s.tasks : [];
      ts.forEach((t) => {
        const label = safeString(t?.label || "", 260, "");
        if (!label) return;
        inferred.push({
          label,
          kind: safeLower(t?.kind || "") || "task",
          stepIndex: idx,
          dueAtOffsetSeconds: Number.isFinite(Number(t?.dueAtOffsetSeconds))
            ? Number(t.dueAtOffsetSeconds)
            : null,
        });
      });
    });
    return inferred;
  }
  return [];
}

function normalizeWarnings(warnings, adaptedSteps) {
  const arr = Array.isArray(warnings) ? warnings : [];
  const out = [];
  for (const w of arr) {
    if (!w) continue;
    const label = safeString(w.label || w.message || "", 400, "");
    if (!label) continue;
    out.push({
      label,
      severity: safeLower(w.severity || "") || "warn",
      reason: safeString(w.reason || "", 800, ""),
      stepIndex: Number.isFinite(Number(w.stepIndex))
        ? Number(w.stepIndex)
        : null,
    });
  }
  if (out.length) return out;

  // fallback from adaptedSteps
  if (Array.isArray(adaptedSteps)) {
    const inferred = [];
    adaptedSteps.forEach((s, idx) => {
      const ws = Array.isArray(s?.warnings) ? s.warnings : [];
      ws.forEach((w) => {
        const label = safeString(w?.label || w?.message || "", 400, "");
        if (!label) return;
        inferred.push({
          label,
          severity: safeLower(w?.severity || "") || "warn",
          reason: safeString(w?.reason || "", 800, ""),
          stepIndex: idx,
        });
      });
    });
    return inferred;
  }
  return [];
}

function normalizeDoneness(doneness) {
  const d = isPlainObject(doneness) ? doneness : {};
  const resolved = isPlainObject(d.resolved) ? d.resolved : null;
  const userSelection = isPlainObject(d.userSelection) ? d.userSelection : null;

  const r = resolved
    ? {
        targetKey: safeString(resolved.targetKey || "", 80, ""),
        targetName: safeString(
          resolved.targetName || resolved.name || "",
          120,
          ""
        ),
        internalTempF: Number.isFinite(Number(resolved.internalTempF))
          ? Number(resolved.internalTempF)
          : null,
        internalTempC: Number.isFinite(Number(resolved.internalTempC))
          ? Number(resolved.internalTempC)
          : null,
        confidence: clamp01(resolved.confidence, 0.7),
        notes: safeString(resolved.notes || "", 800, ""),
        evidence: resolved.evidence ?? null,
      }
    : null;

  const u = userSelection
    ? {
        targetKey: safeString(userSelection.targetKey || "", 80, ""),
        targetName: safeString(userSelection.targetName || "", 120, ""),
        internalTempF: Number.isFinite(Number(userSelection.internalTempF))
          ? Number(userSelection.internalTempF)
          : null,
        internalTempC: Number.isFinite(Number(userSelection.internalTempC))
          ? Number(userSelection.internalTempC)
          : null,
        notes: safeString(userSelection.notes || "", 800, ""),
      }
    : null;

  return { resolved: r, userSelection: u };
}

function toneFromStatus(status) {
  if (status === "ok") return "good";
  if (status === "warn") return "warn";
  if (status === "bad") return "bad";
  return "neutral";
}

function downloadJSON(filename, obj) {
  try {
    const blob = new Blob([JSON.stringify(obj, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.warn("[AdaptationSummary] downloadJSON failed", e);
  }
}

async function copyText(text) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) {
    console.warn("[AdaptationSummary] copy failed", e);
    return false;
  }
}

function buildHumanSummary(a, catalog) {
  const lines = [];

  if (a.selectedPlan) {
    const p = a.selectedPlan;
    const title = p.methodLabel || p.methodKey || "method";
    const feas = p.feasible ? "feasible" : "not feasible";
    lines.push(`Method plan: ${title} (${feas})`);
    if (p.why) lines.push(`Why: ${p.why}`);
    if (p.deltas?.timeSeconds != null)
      lines.push(
        `Time delta: ${p.deltas.timeSeconds >= 0 ? "+" : "-"}${formatSeconds(
          Math.abs(p.deltas.timeSeconds)
        )}`
      );
    if (p.missing?.equipmentIds?.length) {
      lines.push(
        `Missing equipment: ${p.missing.equipmentIds
          .map((id) => equipmentLabel(id, catalog))
          .join(", ")}`
      );
    }
    if (p.substitutions?.length) {
      p.substitutions.slice(0, 12).forEach((s) => {
        lines.push(
          `Substitution: ${equipmentLabel(
            s.missingKey,
            catalog
          )} → ${equipmentLabel(s.chosenKey, catalog)} (${Math.round(
            (s.confidence ?? 0.7) * 100
          )}%)`
        );
      });
    }
  }

  // Doneness
  if (a.doneness?.resolved) {
    const d = a.doneness.resolved;
    const dn = d.targetName || d.targetKey || "doneness";
    const temps = [];
    if (d.internalTempF != null) temps.push(`${d.internalTempF}°F`);
    if (d.internalTempC != null) temps.push(`${d.internalTempC}°C`);
    lines.push(
      `Doneness target: ${dn}${temps.length ? ` (${temps.join(" / ")})` : ""}`
    );
    if (d.notes) lines.push(`Doneness note: ${d.notes}`);
  }

  // Capability gaps
  if (a.capabilityReport) {
    const mEq = a.capabilityReport.missingEquipmentIds || [];
    const mCap = a.capabilityReport.missingCapabilityKeys || [];
    if (mEq.length || mCap.length) {
      if (mEq.length)
        lines.push(
          `Capability gap (equipment): ${mEq
            .map((id) => equipmentLabel(id, catalog))
            .join(", ")}`
        );
      if (mCap.length)
        lines.push(`Capability gap (capabilities): ${mCap.join(", ")}`);
    }
  }

  // Substitutions (global)
  if (a.substitutions?.length) {
    a.substitutions.slice(0, 12).forEach((s) => {
      lines.push(
        `Tool substitution: ${equipmentLabel(
          s.missingKey,
          catalog
        )} → ${equipmentLabel(s.chosenKey, catalog)} (${Math.round(
          (s.confidence ?? 0.7) * 100
        )}%)`
      );
    });
  }

  // Ingredients
  if (a.ingredientSubstitutions?.length) {
    a.ingredientSubstitutions.slice(0, 12).forEach((s) => {
      lines.push(
        `Ingredient substitution: ${s.from} → ${s.to}${
          s.reason ? ` (${s.reason})` : ""
        }`
      );
    });
  }
  if (a.ingredientAdjustments?.length) {
    a.ingredientAdjustments.slice(0, 12).forEach((x) => {
      const from =
        x.fromQty != null
          ? `${x.fromQty}${x.fromUnit ? ` ${x.fromUnit}` : ""}`
          : "";
      const to =
        x.toQty != null ? `${x.toQty}${x.toUnit ? ` ${x.toUnit}` : ""}` : "";
      lines.push(
        `Ingredient adjustment: ${x.key}${
          from && to ? ` (${from} → ${to})` : ""
        }${x.reason ? ` (${x.reason})` : ""}`
      );
    });
  }

  // Steps
  if (a.stepDiff?.changes?.length) {
    const counts = countChangeKinds(a.stepDiff.changes);
    const parts = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, n]) => `${k}:${n}`);
    if (parts.length) lines.push(`Step changes: ${parts.join(", ")}`);
  }

  // Timers/tasks/warnings
  if (a.timers?.length) lines.push(`Timers extracted: ${a.timers.length}`);
  if (a.tasks?.length) lines.push(`Tasks created: ${a.tasks.length}`);
  if (a.warnings?.length) lines.push(`Warnings added: ${a.warnings.length}`);

  // Notes
  if (a.notes?.length) {
    a.notes.slice(0, 6).forEach((n) => lines.push(`Note: ${n}`));
  }

  return lines.join("\n");
}

function countChangeKinds(changes) {
  const out = {};
  (Array.isArray(changes) ? changes : []).forEach((c) => {
    const k = safeLower(c?.kind || "other") || "other";
    out[k] = (out[k] || 0) + 1;
  });
  return out;
}

function sectionHeaderStyle(compact) {
  return {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 10,
    cursor: "pointer",
    padding: compact ? "8px 10px" : "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,0.12)",
    background: "rgba(255,255,255,0.60)",
  };
}

function sectionBodyStyle(compact) {
  return {
    padding: compact ? "8px 10px" : "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,0.10)",
    background: "rgba(0,0,0,0.02)",
    marginTop: 8,
  };
}

function MiniTable({ rows }) {
  if (!rows?.length) return null;
  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
      >
        <tbody>
          {rows.map((r, idx) => (
            <tr
              key={idx}
              style={{ borderBottom: "1px solid rgba(0,0,0,0.08)" }}
            >
              <td
                style={{
                  padding: "6px 8px",
                  fontWeight: 900,
                  verticalAlign: "top",
                  whiteSpace: "nowrap",
                }}
              >
                {r[0]}
              </td>
              <td style={{ padding: "6px 8px", opacity: 0.9 }}>{r[1]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Disclosure({ title, right, open, setOpen, compact, children }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setOpen(!open);
        }}
        style={sectionHeaderStyle(compact)}
        aria-expanded={open}
      >
        <div style={{ fontWeight: 900 }}>{title}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {right}
          <span aria-hidden="true" style={{ opacity: 0.7 }}>
            {open ? "▾" : "▸"}
          </span>
        </div>
      </div>
      {open ? <div style={sectionBodyStyle(compact)}>{children}</div> : null}
    </div>
  );
}

export default function AdaptationSummary({
  adaptation,
  equipmentCatalog,
  showDebug = false,
  compact = false,
  header = "Adaptation summary",
  subheader = "Here’s what SSA changed to match your doneness preferences and kitchen capabilities.",
}) {
  const catalog = useMemo(
    () => normalizeCatalog(equipmentCatalog),
    [equipmentCatalog]
  );
  const a = useMemo(() => normalizeAdaptation(adaptation), [adaptation]);

  const tone = useMemo(() => toneFromStatus(a.status), [a.status]);

  const counts = useMemo(() => {
    const stepKinds = countChangeKinds(a.stepDiff?.changes || []);
    return {
      substitutions:
        a.substitutions.length +
        (a.selectedPlan?.substitutions?.length || 0) +
        (a.capabilityReport?.substitutions?.length || 0),
      ingredientSubstitutions: a.ingredientSubstitutions.length,
      ingredientAdjustments: a.ingredientAdjustments.length,
      stepChanges: (a.stepDiff?.changes || []).length,
      timers: a.timers.length,
      tasks: a.tasks.length,
      warnings: a.warnings.length,
      audit: a.audit.length,
      stepKinds,
    };
  }, [a]);

  const [openPlan, setOpenPlan] = useState(true);
  const [openDoneness, setOpenDoneness] = useState(true);
  const [openEquipment, setOpenEquipment] = useState(true);
  const [openIngredients, setOpenIngredients] = useState(false);
  const [openSteps, setOpenSteps] = useState(false);
  const [openTimersTasks, setOpenTimersTasks] = useState(false);
  const [openWarnings, setOpenWarnings] = useState(false);
  const [openNotesAudit, setOpenNotesAudit] = useState(false);
  const [openDebug, setOpenDebug] = useState(false);
  const [copied, setCopied] = useState(false);

  const humanSummary = useMemo(
    () => buildHumanSummary(a, catalog),
    [a, catalog]
  );

  async function onCopy() {
    const ok = await copyText(humanSummary);
    setCopied(ok);
    setTimeout(() => setCopied(false), 1200);
  }

  const pad = compact ? 10 : 12;

  return (
    <div
      style={{
        border: "1px solid rgba(0,0,0,0.12)",
        borderRadius: 14,
        padding: pad,
        background: "rgba(0,0,0,0.02)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "baseline",
        }}
      >
        <div>
          <div style={{ fontWeight: 900, fontSize: 16 }}>{header}</div>
          {subheader ? (
            <div style={{ fontSize: 13, opacity: 0.8, marginTop: 2 }}>
              {subheader}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "flex-end",
          }}
        >
          <span style={pillStyle(tone)}>{a.status.toUpperCase()}</span>
          {a.selectedPlan?.methodLabel || a.selectedPlan?.methodKey ? (
            <span style={pillStyle("neutral")}>
              method: {a.selectedPlan.methodLabel || a.selectedPlan.methodKey}
            </span>
          ) : null}
          {counts.substitutions ? (
            <span style={pillStyle("neutral")}>
              subs {counts.substitutions}
            </span>
          ) : null}
          {counts.stepChanges ? (
            <span style={pillStyle("neutral")}>
              step changes {counts.stepChanges}
            </span>
          ) : null}
          {counts.timers ? (
            <span style={pillStyle("neutral")}>timers {counts.timers}</span>
          ) : null}
          {counts.tasks ? (
            <span style={pillStyle("neutral")}>tasks {counts.tasks}</span>
          ) : null}
          {counts.warnings ? (
            <span style={pillStyle("warn")}>warnings {counts.warnings}</span>
          ) : null}
        </div>
      </div>

      {/* Quick actions */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        <button
          type="button"
          onClick={onCopy}
          className="sv-btn"
          style={{
            padding: "8px 10px",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.18)",
            background: copied
              ? "rgba(46, 204, 113, 0.18)"
              : "rgba(0,0,0,0.05)",
            cursor: "pointer",
            fontWeight: 900,
          }}
        >
          {copied ? "Copied" : "Copy summary"}
        </button>

        <button
          type="button"
          onClick={() =>
            downloadJSON(`ssa_recipe_adaptation_${Date.now()}.json`, a.raw)
          }
          className="sv-btn"
          style={{
            padding: "8px 10px",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.18)",
            background: "rgba(0,0,0,0.05)",
            cursor: "pointer",
            fontWeight: 900,
          }}
        >
          Export JSON
        </button>
      </div>

      {/* Main sections */}
      <Disclosure
        title="Method plan"
        right={
          a.selectedPlan ? (
            <span style={pillStyle(a.selectedPlan.feasible ? "good" : "bad")}>
              {a.selectedPlan.feasible ? "feasible" : "not feasible"}
            </span>
          ) : (
            <span style={pillStyle("neutral")}>none</span>
          )
        }
        open={openPlan}
        setOpen={setOpenPlan}
        compact={compact}
      >
        {a.selectedPlan ? (
          <>
            <MiniTable
              rows={[
                [
                  "Method",
                  a.selectedPlan.methodLabel || a.selectedPlan.methodKey || "—",
                ],
                ["Why", a.selectedPlan.why || "—"],
                [
                  "Tradeoffs",
                  [
                    a.selectedPlan.deltas?.timeSeconds != null
                      ? `time ${
                          a.selectedPlan.deltas.timeSeconds >= 0 ? "+" : "-"
                        }${formatSeconds(
                          Math.abs(a.selectedPlan.deltas.timeSeconds)
                        )}`
                      : null,
                    a.selectedPlan.deltas?.stepsDelta != null
                      ? `steps ${
                          a.selectedPlan.deltas.stepsDelta >= 0
                            ? `+${a.selectedPlan.deltas.stepsDelta}`
                            : `${a.selectedPlan.deltas.stepsDelta}`
                        }`
                      : null,
                    a.selectedPlan.deltas?.complexity != null
                      ? `complexity ${Math.round(
                          a.selectedPlan.deltas.complexity * 100
                        )}%`
                      : null,
                    a.selectedPlan.deltas?.cleanup != null
                      ? `cleanup ${Math.round(
                          a.selectedPlan.deltas.cleanup * 100
                        )}%`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" • ") || "—",
                ],
                [
                  "Requires",
                  [
                    ...(a.selectedPlan.requires?.equipmentIds || []).map((id) =>
                      equipmentLabel(id, catalog)
                    ),
                    ...(a.selectedPlan.requires?.capabilityKeys || []),
                  ].join(", ") || "—",
                ],
                [
                  "Missing",
                  [
                    ...(a.selectedPlan.missing?.equipmentIds || []).map((id) =>
                      equipmentLabel(id, catalog)
                    ),
                    ...(a.selectedPlan.missing?.capabilityKeys || []),
                  ].join(", ") || "—",
                ],
              ]}
            />
            {a.selectedPlan.substitutions?.length ? (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontWeight: 900, marginBottom: 6 }}>
                  Applied substitutions
                </div>
                {a.selectedPlan.substitutions.slice(0, 14).map((s, idx) => (
                  <div
                    key={`${s.missingKey}_${s.chosenKey}_${idx}`}
                    style={{
                      border: "1px solid rgba(0,0,0,0.10)",
                      borderRadius: 12,
                      padding: 10,
                      background: "rgba(255,255,255,0.60)",
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ fontWeight: 900 }}>
                      {equipmentLabel(s.missingKey, catalog)} →{" "}
                      {equipmentLabel(s.chosenKey, catalog)}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                      confidence {Math.round((s.confidence ?? 0.7) * 100)}% •
                      friction {Math.round((s.friction ?? 0.5) * 100)}%
                    </div>
                    {s.notes ? (
                      <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
                        {s.notes}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            {a.selectedPlan.notes ? (
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
                {a.selectedPlan.notes}
              </div>
            ) : null}
          </>
        ) : (
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            SSA did not record a selected method plan. This is fine if the
            original method was feasible and unchanged.
          </div>
        )}
      </Disclosure>

      <Disclosure
        title="Doneness target"
        right={
          a.doneness?.resolved ? (
            <span style={pillStyle("good")}>
              {a.doneness.resolved.targetName ||
                a.doneness.resolved.targetKey ||
                "resolved"}
            </span>
          ) : (
            <span style={pillStyle("neutral")}>not set</span>
          )
        }
        open={openDoneness}
        setOpen={setOpenDoneness}
        compact={compact}
      >
        {a.doneness?.resolved ? (
          <>
            <MiniTable
              rows={[
                [
                  "Target",
                  a.doneness.resolved.targetName ||
                    a.doneness.resolved.targetKey ||
                    "—",
                ],
                [
                  "Internal temp",
                  [
                    a.doneness.resolved.internalTempF != null
                      ? `${a.doneness.resolved.internalTempF}°F`
                      : null,
                    a.doneness.resolved.internalTempC != null
                      ? `${a.doneness.resolved.internalTempC}°C`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" / ") || "—",
                ],
                [
                  "Confidence",
                  `${Math.round(
                    (a.doneness.resolved.confidence ?? 0.7) * 100
                  )}%`,
                ],
                ["Notes", a.doneness.resolved.notes || "—"],
              ]}
            />
            {a.doneness.userSelection ? (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontWeight: 900, marginBottom: 6 }}>
                  Your selection
                </div>
                <MiniTable
                  rows={[
                    [
                      "Target",
                      a.doneness.userSelection.targetName ||
                        a.doneness.userSelection.targetKey ||
                        "—",
                    ],
                    [
                      "Override temp",
                      [
                        a.doneness.userSelection.internalTempF != null
                          ? `${a.doneness.userSelection.internalTempF}°F`
                          : null,
                        a.doneness.userSelection.internalTempC != null
                          ? `${a.doneness.userSelection.internalTempC}°C`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" / ") || "—",
                    ],
                    ["Notes", a.doneness.userSelection.notes || "—"],
                  ]}
                />
              </div>
            ) : null}
          </>
        ) : (
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            No doneness target was resolved. If this recipe is for a protein,
            you can set a target (rare/medium/well or temp).
          </div>
        )}
      </Disclosure>

      <Disclosure
        title="Equipment and capability changes"
        right={
          counts.substitutions ? (
            <span style={pillStyle("neutral")}>
              {counts.substitutions} changes
            </span>
          ) : (
            <span style={pillStyle("neutral")}>none</span>
          )
        }
        open={openEquipment}
        setOpen={setOpenEquipment}
        compact={compact}
      >
        {/* Capability gaps */}
        {a.capabilityReport &&
        (a.capabilityReport.missingEquipmentIds?.length || 0) +
          (a.capabilityReport.missingCapabilityKeys?.length || 0) >
          0 ? (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 900, marginBottom: 6 }}>
              Gaps SSA detected
            </div>
            <div style={{ display: "flex", flexWrap: "wrap" }}>
              {a.capabilityReport.missingEquipmentIds.map((id) => (
                <span key={id} style={pillStyle("warn")}>
                  {equipmentLabel(id, catalog)}
                </span>
              ))}
              {a.capabilityReport.missingCapabilityKeys.map((k) => (
                <span key={k} style={pillStyle("warn")}>
                  {k}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {/* Combined substitutions */}
        {counts.substitutions ? (
          <div>
            <div style={{ fontWeight: 900, marginBottom: 6 }}>
              Substitutions applied
            </div>

            {[
              ...(a.capabilityReport?.substitutions || []),
              ...(a.selectedPlan?.substitutions || []),
              ...a.substitutions,
            ]
              .slice(0, 18)
              .map((s, idx) => (
                <div
                  key={`${s.missingKey}_${s.chosenKey}_${idx}`}
                  style={{
                    border: "1px solid rgba(0,0,0,0.10)",
                    borderRadius: 12,
                    padding: 10,
                    background: "rgba(255,255,255,0.60)",
                    marginBottom: 8,
                  }}
                >
                  <div style={{ fontWeight: 900 }}>
                    {equipmentLabel(s.missingKey, catalog)} →{" "}
                    {equipmentLabel(s.chosenKey, catalog)}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>
                    confidence {Math.round((s.confidence ?? 0.7) * 100)}% •
                    friction {Math.round((s.friction ?? 0.5) * 100)}%
                  </div>
                  {s.notes ? (
                    <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
                      {s.notes}
                    </div>
                  ) : null}
                </div>
              ))}
          </div>
        ) : (
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            SSA did not need to substitute tools/equipment for this recipe.
          </div>
        )}
      </Disclosure>

      <Disclosure
        title="Ingredients"
        right={
          counts.ingredientSubstitutions || counts.ingredientAdjustments ? (
            <span style={pillStyle("neutral")}>
              {counts.ingredientSubstitutions + counts.ingredientAdjustments}{" "}
              changes
            </span>
          ) : (
            <span style={pillStyle("neutral")}>none</span>
          )
        }
        open={openIngredients}
        setOpen={setOpenIngredients}
        compact={compact}
      >
        {!counts.ingredientSubstitutions && !counts.ingredientAdjustments ? (
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            No ingredient substitutions or adjustments were recorded.
          </div>
        ) : (
          <>
            {a.ingredientSubstitutions.length ? (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 900, marginBottom: 6 }}>
                  Substitutions
                </div>
                {a.ingredientSubstitutions.slice(0, 14).map((s, idx) => (
                  <div
                    key={`${s.from}_${s.to}_${idx}`}
                    style={{
                      border: "1px solid rgba(0,0,0,0.10)",
                      borderRadius: 12,
                      padding: 10,
                      background: "rgba(255,255,255,0.60)",
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ fontWeight: 900 }}>
                      {s.from} → {s.to}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.85 }}>
                      confidence {Math.round((s.confidence ?? 0.7) * 100)}%
                      {s.reason ? ` • ${s.reason}` : ""}
                    </div>
                    {s.notes ? (
                      <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
                        {s.notes}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {a.ingredientAdjustments.length ? (
              <div>
                <div style={{ fontWeight: 900, marginBottom: 6 }}>
                  Adjustments
                </div>
                {a.ingredientAdjustments.slice(0, 14).map((x, idx) => {
                  const from =
                    x.fromQty != null
                      ? `${x.fromQty}${x.fromUnit ? ` ${x.fromUnit}` : ""}`
                      : null;
                  const to =
                    x.toQty != null
                      ? `${x.toQty}${x.toUnit ? ` ${x.toUnit}` : ""}`
                      : null;
                  return (
                    <div
                      key={`${x.key}_${idx}`}
                      style={{
                        border: "1px solid rgba(0,0,0,0.10)",
                        borderRadius: 12,
                        padding: 10,
                        background: "rgba(255,255,255,0.60)",
                        marginBottom: 8,
                      }}
                    >
                      <div style={{ fontWeight: 900 }}>{x.key}</div>
                      <div style={{ fontSize: 12, opacity: 0.85 }}>
                        {from && to ? `${from} → ${to}` : "adjusted"}
                        {x.reason ? ` • ${x.reason}` : ""}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </>
        )}
      </Disclosure>

      <Disclosure
        title="Step changes"
        right={
          counts.stepChanges ? (
            <span style={pillStyle("neutral")}>
              {counts.stepChanges} changes
            </span>
          ) : (
            <span style={pillStyle("neutral")}>none</span>
          )
        }
        open={openSteps}
        setOpen={setOpenSteps}
        compact={compact}
      >
        {counts.stepChanges ? (
          <>
            <div
              style={{ display: "flex", flexWrap: "wrap", marginBottom: 10 }}
            >
              {Object.entries(counts.stepKinds)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([k, n]) => (
                  <span key={k} style={pillStyle("neutral")}>
                    {k}:{n}
                  </span>
                ))}
            </div>

            {(a.stepDiff?.changes || []).slice(0, 20).map((c, idx) => (
              <div
                key={`${c.kind}_${c.stepIndex ?? "x"}_${idx}`}
                style={{
                  border: "1px solid rgba(0,0,0,0.10)",
                  borderRadius: 12,
                  padding: 10,
                  background: "rgba(255,255,255,0.60)",
                  marginBottom: 8,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ fontWeight: 900 }}>
                    {c.kind}
                    {c.stepIndex != null ? ` • step ${c.stepIndex + 1}` : ""}
                  </div>
                  {c.reason ? (
                    <span style={pillStyle("neutral")}>why</span>
                  ) : null}
                </div>

                {c.reason ? (
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 6 }}>
                    {c.reason}
                  </div>
                ) : null}

                {c.before ? (
                  <div style={{ marginTop: 8 }}>
                    <div
                      style={{
                        fontWeight: 900,
                        fontSize: 12,
                        opacity: 0.85,
                        marginBottom: 4,
                      }}
                    >
                      Before
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        opacity: 0.9,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {c.before}
                    </div>
                  </div>
                ) : null}

                {c.after ? (
                  <div style={{ marginTop: 8 }}>
                    <div
                      style={{
                        fontWeight: 900,
                        fontSize: 12,
                        opacity: 0.85,
                        marginBottom: 4,
                      }}
                    >
                      After
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        opacity: 0.9,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {c.after}
                    </div>
                  </div>
                ) : null}

                {/* Avoid big evidence dumps by default; debug section covers full JSON */}
                {c.evidence ? (
                  <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
                    Evidence recorded (view in Debug if needed).
                  </div>
                ) : null}
              </div>
            ))}

            {(a.stepDiff?.changes || []).length > 20 ? (
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                Showing first 20 changes. Export JSON for the full list.
              </div>
            ) : null}
          </>
        ) : (
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            No explicit step diff was recorded. Timers/tasks may still have been
            extracted.
          </div>
        )}
      </Disclosure>

      <Disclosure
        title="Timers and tasks"
        right={
          counts.timers || counts.tasks ? (
            <span style={pillStyle("neutral")}>
              {counts.timers} timers • {counts.tasks} tasks
            </span>
          ) : (
            <span style={pillStyle("neutral")}>none</span>
          )
        }
        open={openTimersTasks}
        setOpen={setOpenTimersTasks}
        compact={compact}
      >
        {!counts.timers && !counts.tasks ? (
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            No timers or tasks were extracted.
          </div>
        ) : (
          <>
            {a.timers.length ? (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 900, marginBottom: 6 }}>Timers</div>
                {a.timers.slice(0, 18).map((t, idx) => (
                  <div
                    key={`${t.label}_${t.seconds}_${idx}`}
                    style={{
                      border: "1px solid rgba(0,0,0,0.10)",
                      borderRadius: 12,
                      padding: 10,
                      background: "rgba(255,255,255,0.60)",
                      marginBottom: 8,
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ fontWeight: 900 }}>{t.label}</div>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        justifyContent: "flex-end",
                      }}
                    >
                      <span style={pillStyle("neutral")}>
                        {formatSeconds(t.seconds)}
                      </span>
                      {t.stepIndex != null ? (
                        <span style={pillStyle("neutral")}>
                          step {t.stepIndex + 1}
                        </span>
                      ) : null}
                      {t.kind ? (
                        <span style={pillStyle("neutral")}>{t.kind}</span>
                      ) : null}
                    </div>
                    {t.sourceText ? (
                      <div
                        style={{ fontSize: 12, opacity: 0.8, width: "100%" }}
                      >
                        {t.sourceText}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {a.tasks.length ? (
              <div>
                <div style={{ fontWeight: 900, marginBottom: 6 }}>Tasks</div>
                {a.tasks.slice(0, 18).map((t, idx) => (
                  <div
                    key={`${t.label}_${idx}`}
                    style={{
                      border: "1px solid rgba(0,0,0,0.10)",
                      borderRadius: 12,
                      padding: 10,
                      background: "rgba(255,255,255,0.60)",
                      marginBottom: 8,
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ fontWeight: 900 }}>{t.label}</div>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        justifyContent: "flex-end",
                      }}
                    >
                      {t.stepIndex != null ? (
                        <span style={pillStyle("neutral")}>
                          step {t.stepIndex + 1}
                        </span>
                      ) : null}
                      {t.kind ? (
                        <span style={pillStyle("neutral")}>{t.kind}</span>
                      ) : null}
                      {t.dueAtOffsetSeconds != null ? (
                        <span style={pillStyle("neutral")}>
                          due +{formatSeconds(t.dueAtOffsetSeconds)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </Disclosure>

      <Disclosure
        title="Warnings"
        right={
          counts.warnings ? (
            <span style={pillStyle("warn")}>{counts.warnings}</span>
          ) : (
            <span style={pillStyle("neutral")}>none</span>
          )
        }
        open={openWarnings}
        setOpen={setOpenWarnings}
        compact={compact}
      >
        {!counts.warnings ? (
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            No warnings were added.
          </div>
        ) : (
          <>
            {a.warnings.slice(0, 18).map((w, idx) => (
              <div
                key={`${w.label}_${idx}`}
                style={{
                  border: "1px solid rgba(0,0,0,0.10)",
                  borderRadius: 12,
                  padding: 10,
                  background: "rgba(255,255,255,0.60)",
                  marginBottom: 8,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ fontWeight: 900 }}>{w.label}</div>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      justifyContent: "flex-end",
                    }}
                  >
                    <span
                      style={pillStyle(w.severity === "bad" ? "bad" : "warn")}
                    >
                      {(w.severity || "warn").toUpperCase()}
                    </span>
                    {w.stepIndex != null ? (
                      <span style={pillStyle("neutral")}>
                        step {w.stepIndex + 1}
                      </span>
                    ) : null}
                  </div>
                </div>
                {w.reason ? (
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 6 }}>
                    {w.reason}
                  </div>
                ) : null}
              </div>
            ))}
          </>
        )}
      </Disclosure>

      <Disclosure
        title="Notes and audit"
        right={
          counts.audit || a.notes.length ? (
            <span style={pillStyle("neutral")}>
              {a.notes.length} notes • {counts.audit} audit
            </span>
          ) : (
            <span style={pillStyle("neutral")}>none</span>
          )
        }
        open={openNotesAudit}
        setOpen={setOpenNotesAudit}
        compact={compact}
      >
        {a.notes.length ? (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 900, marginBottom: 6 }}>Notes</div>
            <ul style={{ margin: 0, paddingLeft: 18, opacity: 0.9 }}>
              {a.notes.slice(0, 12).map((n, idx) => (
                <li key={idx} style={{ marginBottom: 6 }}>
                  {n}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {a.audit.length ? (
          <div>
            <div style={{ fontWeight: 900, marginBottom: 6 }}>Audit trail</div>
            {a.audit.slice(0, 14).map((x, idx) => (
              <div
                key={`${x.code}_${idx}`}
                style={{
                  border: "1px solid rgba(0,0,0,0.10)",
                  borderRadius: 12,
                  padding: 10,
                  background: "rgba(255,255,255,0.60)",
                  marginBottom: 8,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ fontWeight: 900 }}>{x.code || "audit"}</div>
                  <span
                    style={pillStyle(
                      x.level === "error"
                        ? "bad"
                        : x.level === "warn"
                        ? "warn"
                        : "neutral"
                    )}
                  >
                    {(x.level || "info").toUpperCase()}
                  </span>
                </div>
                {x.message ? (
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 6 }}>
                    {x.message}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {!a.notes.length && !a.audit.length ? (
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            No notes or audit entries.
          </div>
        ) : null}
      </Disclosure>

      {/* Debug */}
      {showDebug ? (
        <Disclosure
          title="Debug"
          right={<span style={pillStyle("neutral")}>raw JSON</span>}
          open={openDebug}
          setOpen={setOpenDebug}
          compact={compact}
        >
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
            This is intended for development/testing. Export JSON for issue
            reports.
          </div>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              fontSize: 12,
              opacity: 0.9,
              background: "rgba(0,0,0,0.04)",
              border: "1px solid rgba(0,0,0,0.10)",
              borderRadius: 12,
              padding: 10,
              margin: 0,
            }}
          >
            {JSON.stringify(a.raw, null, 2)}
          </pre>
        </Disclosure>
      ) : null}
    </div>
  );
}
