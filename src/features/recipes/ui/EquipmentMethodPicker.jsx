/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\recipes\ui\EquipmentMethodPicker.jsx
//
// SSA • EquipmentMethodPicker
// -----------------------------------------------------------------------------
// Purpose:
//   A UI picker used by CookSetupModal (and other recipe flows) to choose between
//   feasible cooking method plans based on available equipment/capabilities.
//
// Why it exists:
//   - CapabilityMatcher can produce methodFallbacks and substitutions.
//   - RecipeAdapterService can output alternative "method plans" (e.g., bake vs air_fry)
//     when the original method is not feasible or user prefers another route.
//   - Users need a clear, friendly way to pick a plan, understand tradeoffs,
//     and apply the selection to re-run adaptation.
//
// This component:
//   - Displays a list of method plans (cards), each with:
//       • method name
//       • feasibility status (ok/warn/bad)
//       • required equipment + missing equipment
//       • substitutions (if any)
//       • estimated time/effort deltas (optional)
//       • notes and "why" text (optional)
//   - Allows choosing one plan (radio) and optionally "prefer" it.
//   - Can show a compact dropdown mode if you want minimal UI.
//
// Styling:
//   - SSA-friendly, no Tailwind.
//   - Uses inline styles + assumes household.css/cooking.css present in page.
//
// Props:
//   plans: Array<MethodPlan>
//     MethodPlan = {
//       id: string,
//       label?: string,
//       methodKey: string,          // e.g., "bake", "air_fry"
//       methodLabel?: string,       // display label
//       feasible: boolean,
//       severity?: "ok"|"warn"|"bad",
//       score?: number,             // higher better (optional)
//       requires?: {
//         equipmentIds?: string[],
//         capabilityKeys?: string[],
//       },
//       missing?: {
//         equipmentIds?: string[],
//         capabilityKeys?: string[],
//       },
//       substitutions?: Array<{
//         missingKey: string,
//         chosenKey: string,
//         confidence?: number,
//         friction?: number,
//         notes?: string,
//       }>,
//       deltas?: {
//         timeSeconds?: number,      // + = slower, - = faster
//         stepsDelta?: number,
//         complexity?: number,       // 0..1
//         cleanup?: number,          // 0..1
//       },
//       notes?: string,
//       why?: string,
//       evidence?: any,
//     }
//
//   value: selected plan id (string) OR object { planId }
//   onChange: (planId, plan) => void
//
//   mode?: "cards" | "dropdown"   default "cards"
//   disabled?: boolean
//   showEvidence?: boolean        default false
//   showScoring?: boolean         default true
//   allowNotNow?: boolean         default true (shows "keep original / auto")
//
//   header?: string
//   subheader?: string
//
// -----------------------------------------------------------------------------
// Integration tip (CookSetupModal):
//   - Provide plans from CapabilityMatcher.methodFallbacks plus the original method.
//   - When user selects a plan, set the recipe method in modal state and re-run adapter.
//
// No placeholders. Defensive. Production-ready.

import React, { useMemo } from "react";

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeString(s, max = 500, fallback = "") {
  if (typeof s !== "string") return fallback;
  const t = s.trim();
  return t ? t.slice(0, max) : fallback;
}

function clamp01(n, fallback = 0.7) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function normalizeValue(value) {
  if (typeof value === "string") return value;
  if (isPlainObject(value) && typeof value.planId === "string")
    return value.planId;
  return "";
}

function normalizePlans(plans) {
  const arr = Array.isArray(plans) ? plans : [];
  const out = [];
  for (const p of arr) {
    if (!p) continue;
    const id = safeString(p.id || "", 120, "");
    const methodKey = safeString(p.methodKey || "", 80, "");
    if (!id || !methodKey) continue;

    out.push({
      id,
      label: safeString(p.label || "", 120, ""),
      methodKey,
      methodLabel: safeString(p.methodLabel || "", 120, ""),
      feasible: !!p.feasible,
      severity: safeString(p.severity || "", 16, "") || inferSeverity(p),
      score: Number.isFinite(Number(p.score)) ? Number(p.score) : null,
      requires: normalizeReqMissing(p.requires),
      missing: normalizeReqMissing(p.missing),
      substitutions: normalizeSubs(p.substitutions),
      deltas: normalizeDeltas(p.deltas),
      notes: safeString(p.notes || "", 800, ""),
      why: safeString(p.why || "", 900, ""),
      evidence: p.evidence ?? null,
    });
  }
  return out;
}

function inferSeverity(p) {
  if (!p) return "warn";
  if (p.feasible) {
    const miss =
      (p.missing?.equipmentIds || []).length +
      (p.missing?.capabilityKeys || []).length;
    if (!miss) return "ok";
    return "warn";
  }
  return "bad";
}

function normalizeReqMissing(obj) {
  const o = isPlainObject(obj) ? obj : {};
  const eq = Array.isArray(o.equipmentIds)
    ? o.equipmentIds.map((x) => safeString(String(x), 80, "")).filter(Boolean)
    : [];
  const caps = Array.isArray(o.capabilityKeys)
    ? o.capabilityKeys.map((x) => safeString(String(x), 80, "")).filter(Boolean)
    : [];
  return {
    equipmentIds: Array.from(new Set(eq)),
    capabilityKeys: Array.from(new Set(caps)),
  };
}

function normalizeSubs(subs) {
  const arr = Array.isArray(subs) ? subs : [];
  const out = [];
  for (const s of arr) {
    if (!s) continue;
    const missingKey = safeString(s.missingKey || "", 80, "");
    const chosenKey = safeString(s.chosenKey || "", 80, "");
    if (!missingKey || !chosenKey) continue;
    out.push({
      missingKey,
      chosenKey,
      confidence: clamp01(s.confidence, 0.7),
      friction: clamp01(s.friction, 0.5),
      notes: safeString(s.notes || "", 500, ""),
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

function methodTitle(plan) {
  const a = plan.methodLabel || plan.methodKey;
  const b = plan.label ? ` • ${plan.label}` : "";
  return `${a}${b}`;
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

function formatSeconds(s) {
  const x = Number(s);
  if (!Number.isFinite(x)) return "—";
  const abs = Math.abs(Math.round(x));
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const sec = abs % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec && !h) parts.push(`${sec}s`);
  const base = parts.join(" ") || "0s";
  return x >= 0 ? `+${base}` : `-${base}`;
}

function scoreTone(score) {
  if (score == null) return "neutral";
  if (score >= 0.8) return "good";
  if (score >= 0.55) return "warn";
  return "bad";
}

export default function EquipmentMethodPicker({
  plans,
  value,
  onChange,
  mode = "cards",
  disabled = false,
  showEvidence = false,
  showScoring = true,
  allowNotNow = true,
  header = "Choose a feasible method",
  subheader = "Pick the best method plan for your kitchen right now. SSA will adapt steps, tools and timing to match.",
}) {
  const normalizedPlans = useMemo(() => normalizePlans(plans), [plans]);
  const selectedId = useMemo(() => normalizeValue(value), [value]);

  const computed = useMemo(() => {
    const list = normalizedPlans.slice();

    // Sort: feasible first, then severity, then score desc (if present)
    list.sort((a, b) => {
      const af = a.feasible ? 1 : 0;
      const bf = b.feasible ? 1 : 0;
      if (af !== bf) return bf - af;

      const sevRank = (s) => (s === "ok" ? 2 : s === "warn" ? 1 : 0);
      const as = sevRank(a.severity);
      const bs = sevRank(b.severity);
      if (as !== bs) return bs - as;

      const asc = a.score == null ? -1 : a.score;
      const bsc = b.score == null ? -1 : b.score;
      if (asc !== bsc) return bsc - asc;

      return methodTitle(a).localeCompare(methodTitle(b));
    });

    // Default selection if none:
    let defaultId = selectedId;
    if (!defaultId && list.length) {
      const best =
        list.find((p) => p.feasible && p.severity === "ok") ||
        list.find((p) => p.feasible) ||
        list[0];
      defaultId = best?.id || "";
    }

    const selectedPlan = list.find((p) => p.id === defaultId) || null;

    return { list, defaultId, selectedPlan };
  }, [normalizedPlans, selectedId]);

  function commit(planId) {
    const plan = computed.list.find((p) => p.id === planId) || null;
    if (typeof onChange === "function") onChange(planId, plan);
  }

  if (!computed.list.length) {
    return (
      <div
        style={{
          border: "1px solid rgba(0,0,0,0.12)",
          borderRadius: 12,
          padding: 12,
          background: "rgba(0,0,0,0.02)",
        }}
      >
        <div style={{ fontWeight: 900, marginBottom: 6 }}>
          No alternative method plans
        </div>
        <div style={{ fontSize: 13, opacity: 0.8 }}>
          SSA did not generate any method options. This is normal if the recipe
          is already feasible.
        </div>
      </div>
    );
  }

  if (mode === "dropdown") {
    const id = computed.defaultId;
    return (
      <div>
        <div style={{ fontWeight: 900, marginBottom: 6 }}>{header}</div>
        {subheader ? (
          <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 8 }}>
            {subheader}
          </div>
        ) : null}

        <select
          value={id}
          onChange={(e) => commit(e.target.value)}
          disabled={disabled}
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.18)",
            background: "rgba(255,255,255,0.75)",
            fontFamily: "inherit",
            fontSize: 14,
            opacity: disabled ? 0.65 : 1,
          }}
          aria-label="Method plan dropdown"
        >
          {allowNotNow ? <option value="">Keep original / Auto</option> : null}
          {computed.list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.methodLabel || p.methodKey}
              {p.feasible ? "" : " (not feasible)"}
              {p.score != null ? ` • score ${Math.round(p.score * 100)}%` : ""}
            </option>
          ))}
        </select>

        {computed.selectedPlan ? (
          <div style={{ marginTop: 10 }}>
            {renderPlanSummary(computed.selectedPlan, {
              showEvidence,
              showScoring,
            })}
          </div>
        ) : null}
      </div>
    );
  }

  // Cards mode
  return (
    <div>
      <div style={{ fontWeight: 900, marginBottom: 6 }}>{header}</div>
      {subheader ? (
        <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 10 }}>
          {subheader}
        </div>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {allowNotNow ? (
          <PlanCard
            key="__auto__"
            plan={{
              id: "",
              methodKey: "auto",
              methodLabel: "Keep original / Auto",
              feasible: true,
              severity: "ok",
              score: null,
              requires: { equipmentIds: [], capabilityKeys: [] },
              missing: { equipmentIds: [], capabilityKeys: [] },
              substitutions: [],
              deltas: {
                timeSeconds: null,
                stepsDelta: null,
                complexity: null,
                cleanup: null,
              },
              notes:
                "SSA will keep the recipe method as-is and attempt minimal substitutions.",
              why: "",
              evidence: null,
              label: "",
            }}
            selected={computed.defaultId === ""}
            disabled={disabled}
            showEvidence={showEvidence}
            showScoring={showScoring}
            onSelect={() => commit("")}
          />
        ) : null}

        {computed.list.map((p) => (
          <PlanCard
            key={p.id}
            plan={p}
            selected={computed.defaultId === p.id}
            disabled={disabled}
            showEvidence={showEvidence}
            showScoring={showScoring}
            onSelect={() => commit(p.id)}
          />
        ))}
      </div>
    </div>
  );
}

function PlanCard({
  plan,
  selected,
  disabled,
  showEvidence,
  showScoring,
  onSelect,
}) {
  const tone =
    plan.severity === "ok" ? "good" : plan.severity === "warn" ? "warn" : "bad";
  const border = selected
    ? "rgba(52, 152, 219, 0.55)"
    : tone === "good"
    ? "rgba(46, 204, 113, 0.35)"
    : tone === "warn"
    ? "rgba(241, 196, 15, 0.35)"
    : "rgba(231, 76, 60, 0.35)";
  const bg = selected
    ? "rgba(52, 152, 219, 0.08)"
    : tone === "good"
    ? "rgba(46, 204, 113, 0.06)"
    : tone === "warn"
    ? "rgba(241, 196, 15, 0.06)"
    : "rgba(231, 76, 60, 0.06)";

  const missingCount =
    (plan.missing?.equipmentIds?.length || 0) +
    (plan.missing?.capabilityKeys?.length || 0);

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      style={{
        textAlign: "left",
        border: `1px solid ${border}`,
        background: bg,
        borderRadius: 14,
        padding: 12,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.65 : 1,
      }}
      aria-pressed={selected}
      aria-label={`Select method plan ${plan.methodLabel || plan.methodKey}`}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "baseline",
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontWeight: 900, fontSize: 14 }}>
          <span style={{ marginRight: 10 }}>{selected ? "🔘" : "⚪"}</span>
          {methodTitle(plan)}
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "flex-end",
          }}
        >
          <span style={pillStyle(tone)}>
            {plan.feasible
              ? missingCount
                ? "Feasible (review)"
                : "Feasible"
              : "Not feasible"}
          </span>
          {showScoring && plan.score != null ? (
            <span style={pillStyle(scoreTone(plan.score))}>
              score {Math.round(plan.score * 100)}%
            </span>
          ) : null}
        </div>
      </div>

      <div style={{ marginTop: 8 }}>
        {renderPlanSummary(plan, { showEvidence, showScoring })}
      </div>
    </button>
  );
}

function renderPlanSummary(plan, { showEvidence, showScoring }) {
  const missingEq = plan.missing?.equipmentIds || [];
  const missingCaps = plan.missing?.capabilityKeys || [];
  const reqEq = plan.requires?.equipmentIds || [];
  const reqCaps = plan.requires?.capabilityKeys || [];

  const deltas = plan.deltas || {};
  const hasDeltas =
    deltas.timeSeconds != null ||
    deltas.stepsDelta != null ||
    deltas.complexity != null ||
    deltas.cleanup != null;

  return (
    <div>
      {/* Requirements */}
      <div style={{ fontSize: 12, opacity: 0.85 }}>
        <div style={{ fontWeight: 900, marginBottom: 6 }}>Requirements</div>
        <div style={{ display: "flex", flexWrap: "wrap" }}>
          {reqEq.slice(0, 8).map((k) => (
            <span key={k} style={pillStyle("neutral")}>
              {k}
            </span>
          ))}
          {reqCaps.slice(0, 6).map((k) => (
            <span key={k} style={pillStyle("neutral")}>
              {k}
            </span>
          ))}
          {!reqEq.length && !reqCaps.length ? (
            <span style={{ fontSize: 12, opacity: 0.7 }}>—</span>
          ) : null}
        </div>
      </div>

      {/* Missing */}
      {missingEq.length || missingCaps.length ? (
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.9 }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>Missing</div>
          <div style={{ display: "flex", flexWrap: "wrap" }}>
            {missingEq.slice(0, 10).map((k) => (
              <span key={k} style={pillStyle("warn")}>
                {k}
              </span>
            ))}
            {missingCaps.slice(0, 10).map((k) => (
              <span key={k} style={pillStyle("warn")}>
                {k}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* Substitutions */}
      {plan.substitutions?.length ? (
        <div style={{ marginTop: 8 }}>
          <div
            style={{
              fontWeight: 900,
              marginBottom: 6,
              fontSize: 12,
              opacity: 0.85,
            }}
          >
            Substitutions
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {plan.substitutions.slice(0, 6).map((s, idx) => (
              <div
                key={`${s.missingKey}_${s.chosenKey}_${idx}`}
                style={{
                  border: "1px solid rgba(0,0,0,0.10)",
                  borderRadius: 10,
                  padding: "8px 10px",
                  background: "rgba(255,255,255,0.6)",
                }}
              >
                <div style={{ fontWeight: 900, fontSize: 12 }}>
                  {s.missingKey} → {s.chosenKey}
                </div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  confidence {Math.round((s.confidence ?? 0.7) * 100)}% •
                  friction {Math.round((s.friction ?? 0.5) * 100)}%
                </div>
                {showEvidence && s.notes ? (
                  <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
                    {s.notes}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Deltas */}
      {hasDeltas ? (
        <div style={{ marginTop: 8 }}>
          <div
            style={{
              fontWeight: 900,
              marginBottom: 6,
              fontSize: 12,
              opacity: 0.85,
            }}
          >
            Tradeoffs
          </div>
          <div style={{ display: "flex", flexWrap: "wrap" }}>
            {deltas.timeSeconds != null ? (
              <span
                style={pillStyle(deltas.timeSeconds <= 0 ? "good" : "warn")}
              >
                time {formatSeconds(deltas.timeSeconds)}
              </span>
            ) : null}
            {deltas.stepsDelta != null ? (
              <span style={pillStyle(deltas.stepsDelta <= 0 ? "good" : "warn")}>
                steps{" "}
                {deltas.stepsDelta >= 0
                  ? `+${deltas.stepsDelta}`
                  : `${deltas.stepsDelta}`}
              </span>
            ) : null}
            {deltas.complexity != null ? (
              <span
                style={pillStyle(deltas.complexity <= 0.55 ? "good" : "warn")}
              >
                complexity {Math.round(deltas.complexity * 100)}%
              </span>
            ) : null}
            {deltas.cleanup != null ? (
              <span style={pillStyle(deltas.cleanup <= 0.55 ? "good" : "warn")}>
                cleanup {Math.round(deltas.cleanup * 100)}%
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Notes / Why */}
      {plan.why ? (
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
          <b>Why:</b> {plan.why}
        </div>
      ) : null}
      {plan.notes ? (
        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
          {plan.notes}
        </div>
      ) : null}

      {/* Evidence */}
      {showEvidence && plan.evidence ? (
        <pre
          style={{
            marginTop: 8,
            whiteSpace: "pre-wrap",
            fontSize: 12,
            opacity: 0.85,
            background: "rgba(0,0,0,0.04)",
            border: "1px solid rgba(0,0,0,0.10)",
            borderRadius: 10,
            padding: 10,
          }}
        >
          {JSON.stringify(plan.evidence, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
