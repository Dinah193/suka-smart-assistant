/**
 * src/services/planning/BlueprintAdapter.js
 */

function isoNow() {
  return new Date().toISOString();
}
function safeArr(v) {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

function stableIdFallback(prefix, idx) {
  return `${prefix}_${idx + 1}`;
}

function toStepTemplate(step, idx) {
  const id = step?.id ? String(step.id) : `step_${idx + 1}`;
  const title = String(step?.title || step?.name || `Step ${idx + 1}`);
  const kind = String(step?.kind || step?.type || "template");
  const etaMin = Number.isFinite(step?.timeboxMin)
    ? step.timeboxMin
    : Number.isFinite(step?.etaMin)
      ? step.etaMin
      : null;
  const etaSec = etaMin != null ? Math.max(0, Math.round(etaMin * 60)) : null;

  const timersIn = safeArr(step?.timers);

  return {
    id,
    title,
    kind,
    etaSec,
    timers: timersIn.map((t, tIdx) => ({
      id: String(t?.id || `timer_${id}_${tIdx + 1}`),
      label: String(t?.label || title),
      seconds: Number.isFinite(t?.seconds) ? t.seconds : null,
      // allow future SSA mins compat if upstream sends minutes
      minutes: Number.isFinite(t?.minutes) ? t.minutes : null,
    })),
    voice: {
      speakOnStart: !!step?.voice?.speakOnStart,
      prompt: String(step?.voice?.prompt || ""),
      hooks: safeArr(step?.voice?.hooks),
    },
    inventoryMoves: safeArr(step?.inventoryMoves).map((m, mIdx) => ({
      id: String(m?.id || `move_${id}_${mIdx + 1}`),
      type: String(m?.type || "placeholder"),
      from: String(m?.from || ""),
      to: String(m?.to || ""),
      itemTag: String(m?.itemTag || ""),
      qty: m?.qty ?? null,
      unit: m?.unit ? String(m.unit) : "",
      notes: m?.notes ? String(m.notes) : "",
    })),
    notes: safeArr(step?.notes).map(String),
    uiHints: step?.ui || step?.uiHints || {},
  };
}

function inferSessionsFromOutputs(pattern) {
  const out = [];
  const produces = safeArr(pattern?.produces);
  for (const p of produces) {
    if (p?.type === "session" && p?.domain) {
      out.push({
        domain: String(p.domain),
        title: String(p.title || pattern.title || "Session"),
        source: "produces",
      });
    }
  }
  if (!out.length) {
    out.push({
      domain: String(pattern.domain || "planning"),
      title: String(pattern.title || "Plan Session"),
      source: "fallback",
    });
  }
  return out;
}

function normalizeOutput(o, sourcePatternId) {
  const type = String(o?.type || "unknown");
  // keep payload but ensure stable minimal envelope
  return {
    type,
    sourcePatternId: String(sourcePatternId || ""),
    payload: o?.payload ?? o ?? {},
  };
}

function splitOutputsByVisibility(outputs, visibility) {
  const showFarmToTable = !!visibility?.showFarmToTable;

  const visible = {
    inventoryMoves: [],
    shoppingDelta: [],
    farmToTable: null,
  };

  const hidden = {
    inventoryMoves: [],
    shoppingDelta: [],
    farmToTable: null,
  };

  for (const o of outputs) {
    const t = o?.type;

    if (t === "inventoryMove") {
      (showFarmToTable ? visible : hidden).inventoryMoves.push(o);
      continue;
    }

    if (t === "shoppingDelta") {
      (showFarmToTable ? visible : hidden).shoppingDelta.push(o);
      continue;
    }

    // Farm-to-table bundle output (recommended upstream)
    if (t === "farmToTable") {
      if (showFarmToTable) visible.farmToTable = o;
      else hidden.farmToTable = o;
      continue;
    }

    // Unknown outputs stay hidden by default to prevent UI surprises
    hidden.shoppingDelta.push(o);
  }

  return { visible, hidden };
}

export class BlueprintAdapter {
  /**
   * @param {object} input
   * @param {object} options
   * options.visibility.showFarmToTable (default false):
   *   - if false: farm-to-table outputs are produced but returned under `hidden`
   *   - if true: returned under top-level `inventoryMoves/shoppingDelta` and `farmToTable`
   */
  fromPatterns(
    {
      domain,
      patterns = [],
      ranked = [],
      seasonal = {},
      culture = {},
      context = {},
      lean = {},
    } = {},
    options = {},
  ) {
    const sessions = [];

    const normalizedOutputs = [];
    const hidden = { inventoryMoves: [], shoppingDelta: [], farmToTable: null };

    const pats = safeArr(patterns);

    for (let pIdx = 0; pIdx < pats.length; pIdx++) {
      const pat = pats[pIdx];
      const patId = String(
        pat?.id || pat?.patternId || stableIdFallback("pattern", pIdx),
      );
      const patTitle = String(pat?.title || "Plan Pattern");
      const sessionDefs = inferSessionsFromOutputs(pat);

      const steps = safeArr(pat?.steps).map((s, i) => toStepTemplate(s, i));

      // Normalize all outputs first
      const outs = safeArr(pat?.outputs).map((o) => normalizeOutput(o, patId));
      normalizedOutputs.push(...outs);

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
              standardWorkRefs: safeArr(
                lean?.recommendations?.standardWorkRefs,
              ).map(String),
              valueStreamRefs: safeArr(
                lean?.recommendations?.valueStreamRefs,
              ).map(String),
            },
            contextHints: safeArr(context?.hintTags).map(String),
            // crucial: explicit “visibility defaults”
            visibility: {
              showFarmToTable: !!options?.visibility?.showFarmToTable,
            },
          },
          steps,
        });
      }
    }

    // Split outputs into visible vs hidden (UI gating)
    const { visible, hidden: hiddenSplit } = splitOutputsByVisibility(
      normalizedOutputs.map((o) => ({
        type: o.type,
        ...o.payload,
        sourcePatternId: o.sourcePatternId,
      })),
      { showFarmToTable: !!options?.visibility?.showFarmToTable },
    );

    hidden.inventoryMoves = hiddenSplit.inventoryMoves;
    hidden.shoppingDelta = hiddenSplit.shoppingDelta;
    hidden.farmToTable = hiddenSplit.farmToTable;

    return {
      sessions,

      // visible outputs (Meal Planner can ignore by default)
      inventoryMoves: visible.inventoryMoves,
      shoppingDelta: visible.shoppingDelta,
      farmToTable: visible.farmToTable || null,

      // hidden outputs (produced but not shown unless opted-in)
      hidden,

      summary: {
        sessionCount: sessions.length,
        patternsUsed: pats.map((p, i) =>
          String(p?.id || p?.patternId || stableIdFallback("pattern", i)),
        ),
        farmToTable: {
          visible: !!options?.visibility?.showFarmToTable,
          hiddenInventoryMoves: hidden.inventoryMoves.length,
          hiddenShoppingDelta: hidden.shoppingDelta.length,
          hasHiddenFarmToTableBundle: !!hidden.farmToTable,
        },
      },
    };
  }
}

export default BlueprintAdapter;
