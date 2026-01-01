/**
 * File: src/services/planning/BlueprintAdapter.js
 * Purpose: Convert selected pattern(s) into SSA session blueprints (steps with timers/voice hooks placeholders).
 *
 * Output format (SSA-friendly):
 *  - { sessions: Array<SessionBlueprint>, summary: object, inventoryMoves: [], shoppingDelta: [] }
 *
 * SessionBlueprint (minimal contract):
 *  {
 *    id, domain, title, sourcePatternId,
 *    tags: [],
 *    meta: { createdAt, variantFlags, culture, seasonTags, leanRefs },
 *    steps: Array<{ id, title, kind, etaSec, timers?, voice?, inventoryMoves?, notes?, uiHints? }>
 *  }
 */

function isoNow() { return new Date().toISOString(); }
function safeArr(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }

function toStepTemplate(step, idx) {
  const id = step?.id ? String(step.id) : `step_${idx+1}`;
  const title = String(step?.title || step?.name || `Step ${idx+1}`);
  const kind = String(step?.kind || step?.type || "template");
  const etaMin = Number.isFinite(step?.timeboxMin) ? step.timeboxMin : (Number.isFinite(step?.etaMin) ? step.etaMin : null);
  const etaSec = etaMin != null ? Math.max(0, Math.round(etaMin * 60)) : null;

  return {
    id,
    title,
    kind,
    etaSec,
    timers: safeArr(step?.timers).map((t) => ({
      id: String(t?.id || `timer_${id}`),
      label: String(t?.label || title),
      seconds: Number.isFinite(t?.seconds) ? t.seconds : null,
    })),
    voice: {
      speakOnStart: !!step?.voice?.speakOnStart,
      prompt: String(step?.voice?.prompt || ""),
      // placeholders for SSA runtime (TTS/earcons/haptics)
      hooks: safeArr(step?.voice?.hooks),
    },
    inventoryMoves: safeArr(step?.inventoryMoves).map((m) => ({
      type: String(m?.type || "placeholder"),
      from: String(m?.from || ""),
      to: String(m?.to || ""),
      itemTag: String(m?.itemTag || ""),
      qty: m?.qty ?? null,
      notes: m?.notes ? String(m.notes) : "",
    })),
    notes: safeArr(step?.notes).map(String),
    uiHints: step?.ui || step?.uiHints || {},
  };
}

function inferSessionsFromOutputs(pattern) {
  // Patterns may produce multiple sessions (meals + storehouse).
  const out = [];
  const produces = safeArr(pattern?.produces);
  for (const p of produces) {
    if (p?.type === "session" && p?.domain) {
      out.push({ domain: String(p.domain), title: String(p.title || pattern.title || "Session"), source: "produces" });
    }
  }
  // If none specified, make a session per pattern domain.
  if (!out.length) out.push({ domain: String(pattern.domain || "planning"), title: String(pattern.title || "Plan Session"), source: "fallback" });
  return out;
}

export class BlueprintAdapter {
  fromPatterns({ domain, patterns = [], ranked = [], seasonal = {}, culture = {}, context = {}, lean = {} } = {}) {
    const sessions = [];
    const inventoryMoves = [];
    const shoppingDelta = [];

    for (const pat of safeArr(patterns)) {
      const patId = String(pat?.id || pat?.patternId || "");
      const patTitle = String(pat?.title || "Plan Pattern");
      const sessionDefs = inferSessionsFromOutputs(pat);

      // Steps are blueprint templates, not raw UI tasks.
      const steps = safeArr(pat?.steps).map(toStepTemplate);

      // Accumulate inventory/shopping placeholders from outputs if present.
      for (const o of safeArr(pat?.outputs)) {
        if (o?.type === "inventoryMove") inventoryMoves.push(o);
        if (o?.type === "shoppingDelta") shoppingDelta.push(o);
      }

      for (const sdef of sessionDefs) {
        const sDomain = String(sdef.domain || domain || "planning");
        const sid = `sess_${sDomain}_${patId}_${sessions.length + 1}`;

        sessions.push({
          id: sid,
          domain: sDomain,
          title: sdef.title || patTitle,
          sourcePatternId: patId,
          tags: safeArr(pat?.intentTags).map(String),
          meta: {
            createdAt: isoNow(),
            variantFlags: seasonal?.variantFlags || {},
            seasonTags: safeArr(seasonal?.tags).map(String),
            culture,
            leanRefs: {
              standardWorkRefs: safeArr(lean?.recommendations?.standardWorkRefs).map(String),
              valueStreamRefs: safeArr(lean?.recommendations?.valueStreamRefs).map(String),
            },
            contextHints: safeArr(context?.hintTags).map(String),
          },
          steps,
        });
      }
    }

    return {
      sessions,
      summary: {
        sessionCount: sessions.length,
        patternsUsed: safeArr(patterns).map((p) => String(p?.id || "")),
      },
      inventoryMoves,
      shoppingDelta,
    };
  }
}

export default BlueprintAdapter;
