/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\recipes\hooks\useCookSetup.js
//
// SSA • useCookSetup
// -----------------------------------------------------------------------------
// Purpose:
//   Central modal state + adapter invocation for CookSetupModal.
//
// What it does:
//   - Owns "setup" state for adapting a recipe to the user's:
//       • doneness targets
//       • kitchen capabilities (equipment/tools + capabilities)
//       • chosen method plan (feasible alternatives)
//       • overrides (time/servings, etc. if present)
//   - Invokes RecipeAdapterService in a safe, debounced, cancelable way.
//   - Returns UI-ready data for:
//       • EquipmentMethodPicker (method plans)
//       • DonenessSelector
//       • EquipmentChecklist
//       • AdaptationSummary
//   - Emits SSA eventBus events (optional) so the rest of the app can react.
//
// Dependencies (expected to exist from your earlier requests):
//   - "@/features/recipes/engines/RecipeAdapterService"
//   - "@/features/recipes/engines/DonenessResolver"   (optional direct usage)
//   - "@/features/recipes/engines/CapabilityMatcher"  (optional direct usage)
//   - "@/services/eventBus" (if you have one) else it no-ops safely
//
// Notes:
//   - Works whether you pass full kitchenCaps or not.
//   - Uses request "runId" + AbortController to avoid stale updates.
//   - Provides deterministic defaults and defensively normalizes inputs.
//
// Usage:
//   const {
//     state,
//     setDonenessTarget,
//     toggleEquipment,
//     setSelectedMethodPlan,
//     runAdaptationNow,
//     resetToDefaults,
//     ui,
//     isLoading,
//     error
//   } = useCookSetup({ recipe, kitchenCaps, donenessProfile, initialVariant, options });
//
//   ui.adaptation -> pass to <AdaptationSummary />
//   ui.methodPlans -> pass to <EquipmentMethodPicker />
//   ui.requiredEquipmentIds -> pass to <EquipmentChecklist />
//
// No placeholders. Production-ready.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RecipeAdapterService } from "@/features/recipes/engines/RecipeAdapterService";

// Optional: use eventBus if present; otherwise no-op.
let eventBus = null;
try {
  // eslint-disable-next-line global-require
  eventBus =
    require("@/services/eventBus")?.eventBus ||
    require("@/services/eventBus") ||
    null;
} catch {
  eventBus = null;
}

/* ------------------------------ utils ------------------------------ */

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeString(s, max = 500, fallback = "") {
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
        .map((x) => safeString(String(x), 120, ""))
        .filter(Boolean)
    )
  );
}

function stableJSON(obj) {
  // Deterministic stringify for dependency keys (good enough for SSA usage)
  try {
    return JSON.stringify(obj, Object.keys(obj || {}).sort());
  } catch {
    try {
      return JSON.stringify(obj);
    } catch {
      return "";
    }
  }
}

function nowMs() {
  return Date.now();
}

function computeDefaultSelectedEquipment(requiredEquipmentIds, kitchenCaps) {
  // If user has equipment list, preselect intersection + required; else required.
  const req = uniq(requiredEquipmentIds);
  const available = uniq(
    kitchenCaps?.equipmentIds || kitchenCaps?.equipment || []
  );
  if (!available.length) return req;
  const availSet = new Set(available);
  const keep = req.filter((id) => availSet.has(id));
  // always include required items for visibility, even if missing; modal can show missing.
  return uniq([...keep, ...req]);
}

function normalizeKitchenCaps(kitchenCaps) {
  const kc = isPlainObject(kitchenCaps) ? kitchenCaps : {};
  return {
    kitchenId: safeString(kc.kitchenId || kc.id || "", 120, ""),
    equipmentIds: uniq(kc.equipmentIds || kc.equipment || kc.tools || []),
    capabilityKeys: uniq(kc.capabilityKeys || kc.capabilities || []),
    // allow metadata passthrough for UI
    equipmentCatalog: isPlainObject(kc.equipmentCatalog)
      ? kc.equipmentCatalog
      : null,
  };
}

function normalizeDonenessProfile(donenessProfile) {
  const dp = isPlainObject(donenessProfile) ? donenessProfile : {};
  return {
    profileId: safeString(dp.profileId || dp.id || "", 120, ""),
    // Allow either a high-level map or explicit selections.
    // The adapter is expected to interpret this.
    preferences: isPlainObject(dp.preferences) ? dp.preferences : dp,
  };
}

function normalizeRecipeInput(recipe) {
  // Accept a raw recipe object OR a recipeVariant/cookPlan-ish shape.
  const r = isPlainObject(recipe) ? recipe : {};
  return r;
}

function safeEmit(topic, payload) {
  try {
    if (!eventBus) return;
    if (typeof eventBus.emit === "function") eventBus.emit(topic, payload);
    else if (typeof eventBus.publish === "function")
      eventBus.publish(topic, payload);
  } catch (e) {
    console.warn("[useCookSetup] eventBus emit failed", topic, e);
  }
}

function inferRequiredEquipmentFromAdaptation(adaptation) {
  const a = isPlainObject(adaptation) ? adaptation : {};
  const cap = isPlainObject(a.capabilityReport) ? a.capabilityReport : null;
  const plan = isPlainObject(a.selectedPlan) ? a.selectedPlan : null;

  // Prefer: selectedPlan.requires.equipmentIds, then capabilityReport missing+present,
  // then adaptation.requiredEquipmentIds (if your adapter provides it), then adaptedSteps equipmentIds.
  const reqFromPlan = uniq(plan?.requires?.equipmentIds);
  if (reqFromPlan.length) return reqFromPlan;

  const fromAdapterDirect = uniq(a.requiredEquipmentIds);
  if (fromAdapterDirect.length) return fromAdapterDirect;

  const fromCap = uniq([
    ...(cap?.missingEquipmentIds || []),
    ...(cap?.presentEquipmentIds || []),
    ...(cap?.requiredEquipmentIds || []),
  ]);
  if (fromCap.length) return fromCap;

  const adaptedSteps = Array.isArray(a.adaptedSteps) ? a.adaptedSteps : [];
  const fromSteps = uniq(
    adaptedSteps.flatMap((s) =>
      Array.isArray(s?.equipmentIds) ? s.equipmentIds : []
    )
  );
  if (fromSteps.length) return fromSteps;

  return [];
}

function inferPlansFromAdaptation(adaptation) {
  const a = isPlainObject(adaptation) ? adaptation : {};
  const plans = Array.isArray(a.plans) ? a.plans : [];
  const selected = isPlainObject(a.selectedPlan) ? a.selectedPlan : null;

  // If adapter doesn't include a plans list, still provide the selected plan as a single option.
  if (!plans.length && selected) {
    const id = safeString(selected.id || "selected_plan", 120, "selected_plan");
    return [
      {
        id,
        label: safeString(selected.label || "", 120, ""),
        methodKey: safeString(selected.methodKey || "", 80, ""),
        methodLabel: safeString(selected.methodLabel || "", 120, ""),
        feasible: !!selected.feasible,
        severity:
          safeLower(selected.severity || "") ||
          (selected.feasible ? "ok" : "bad"),
        score: Number.isFinite(Number(selected.score))
          ? Number(selected.score)
          : null,
        requires: selected.requires || {},
        missing: selected.missing || {},
        substitutions: selected.substitutions || [],
        deltas: selected.deltas || {},
        notes: safeString(selected.notes || "", 800, ""),
        why: safeString(selected.why || "", 800, ""),
        evidence: selected.evidence ?? null,
      },
    ];
  }

  return plans;
}

/* ------------------------------ hook ------------------------------ */

/**
 * @param {object} args
 * @param {object} args.recipe - base recipe object (raw or normalized)
 * @param {object} [args.kitchenCaps] - kitchen capabilities (equipmentIds, capabilityKeys, etc.)
 * @param {object} [args.donenessProfile] - user doneness preferences profile
 * @param {object} [args.initialVariant] - previously saved adapted recipe variant (optional)
 * @param {object} [args.options] - behavior toggles
 */
export function useCookSetup({
  recipe,
  kitchenCaps,
  donenessProfile,
  initialVariant,
  options,
} = {}) {
  const opts = useMemo(() => {
    const o = isPlainObject(options) ? options : {};
    return {
      debounceMs: Number.isFinite(Number(o.debounceMs))
        ? Math.max(0, Number(o.debounceMs))
        : 300,
      autoRun: o.autoRun !== false, // default true
      emitEvents: o.emitEvents !== false, // default true
      debug: !!o.debug,
      // If true, the hook will treat selection changes as "dirty" and re-run adapter.
      rerunOnChange: o.rerunOnChange !== false, // default true
      // Minimal payload to adapter? default false.
      lightweight: !!o.lightweight,
      // pass through extra adapter options
      adapterOptions: isPlainObject(o.adapterOptions) ? o.adapterOptions : {},
    };
  }, [options]);

  const baseRecipe = useMemo(() => normalizeRecipeInput(recipe), [recipe]);
  const kc = useMemo(() => normalizeKitchenCaps(kitchenCaps), [kitchenCaps]);
  const dp = useMemo(
    () => normalizeDonenessProfile(donenessProfile),
    [donenessProfile]
  );

  // A stable "recipe key" for reset logic and reruns
  const recipeKey = useMemo(() => {
    const id = safeString(
      baseRecipe?.id || baseRecipe?.recipeId || baseRecipe?.slug || "",
      200,
      ""
    );
    const title = safeString(
      baseRecipe?.title || baseRecipe?.name || "",
      200,
      ""
    );
    return id || title || stableJSON({ t: title, i: id }).slice(0, 200);
  }, [baseRecipe]);

  const initialVariantNorm = useMemo(
    () => (isPlainObject(initialVariant) ? initialVariant : null),
    [initialVariant]
  );

  /* ------------------------------ state ------------------------------ */

  const [state, setState] = useState(() => {
    // Initialize from initialVariant when present.
    const iv = initialVariantNorm;
    const selectedPlanId =
      safeString(
        iv?.selectedPlanId || iv?.methodPlanId || iv?.selectedPlan?.id || "",
        160,
        ""
      ) || "";

    const donenessTargetKey =
      safeString(
        iv?.donenessTargetKey ||
          iv?.doneness?.targetKey ||
          iv?.doneness?.resolved?.targetKey ||
          "",
        80,
        ""
      ) || "";

    const requiredEquipmentIds = uniq(iv?.requiredEquipmentIds || []);
    const selectedEquipmentIds = uniq(iv?.selectedEquipmentIds || []);

    return {
      recipeKey,
      // user choices
      selectedPlanId,
      donenessTargetKey,
      // equipment selection (what they'll use)
      selectedEquipmentIds: selectedEquipmentIds.length
        ? selectedEquipmentIds
        : computeDefaultSelectedEquipment(requiredEquipmentIds, kc),
      // optional user overrides (servings/time)
      overrides: isPlainObject(iv?.overrides) ? iv.overrides : {},
      // internal flags
      dirty: false,
    };
  });

  // Keep recipeKey current (if recipe changes)
  useEffect(() => {
    setState((prev) => {
      if (prev.recipeKey === recipeKey) return prev;
      // On recipe change: reset, but keep kitchen selections if they still make sense.
      return {
        recipeKey,
        selectedPlanId: "",
        donenessTargetKey: "",
        selectedEquipmentIds: [],
        overrides: {},
        dirty: false,
      };
    });
  }, [recipeKey]);

  const [adaptation, setAdaptation] = useState(() =>
    initialVariantNorm?.adaptation ? initialVariantNorm.adaptation : null
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  // Derived UI inputs from latest adaptation
  const uiDerived = useMemo(() => {
    const requiredEquipmentIds =
      inferRequiredEquipmentFromAdaptation(adaptation);
    const methodPlans = inferPlansFromAdaptation(adaptation);

    // If no selection exists yet, keep selection as is; otherwise ensure it includes required items for visibility.
    const selectedEquipmentIds = uniq([
      ...state.selectedEquipmentIds,
      ...requiredEquipmentIds,
    ]);

    const capReport = isPlainObject(adaptation?.capabilityReport)
      ? adaptation.capabilityReport
      : null;
    const missingEquipmentIds = uniq(capReport?.missingEquipmentIds);
    const missingCapabilityKeys = uniq(capReport?.missingCapabilityKeys);

    return {
      methodPlans,
      requiredEquipmentIds,
      selectedEquipmentIds,
      missingEquipmentIds,
      missingCapabilityKeys,
      equipmentCatalog: kc.equipmentCatalog, // optional pass-through
      adaptation,
    };
  }, [adaptation, state.selectedEquipmentIds, kc.equipmentCatalog]);

  // Keep internal selectedEquipmentIds synced with derived requirement additions (without marking dirty).
  useEffect(() => {
    const req = uiDerived.requiredEquipmentIds;
    if (!req.length) return;

    setState((prev) => {
      const merged = uniq([...prev.selectedEquipmentIds, ...req]);
      // only update if changed
      const same =
        merged.length === prev.selectedEquipmentIds.length &&
        merged.every((x, i) => x === prev.selectedEquipmentIds[i]);

      if (same) return prev;
      return { ...prev, selectedEquipmentIds: merged };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableJSON(uiDerived.requiredEquipmentIds)]);

  /* ------------------------------ adapter invocation (debounced + cancelable) ------------------------------ */

  const runIdRef = useRef(0);
  const abortRef = useRef(null);
  const debounceRef = useRef(null);
  const lastInputsKeyRef = useRef("");

  const buildAdapterInput = useCallback(
    (overrideState) => {
      const s = overrideState || state;
      // Adapter expected inputs (best-effort)
      const input = {
        recipe: baseRecipe,
        kitchen: {
          kitchenId: kc.kitchenId,
          equipmentIds: kc.equipmentIds,
          capabilityKeys: kc.capabilityKeys,
        },
        donenessProfile: dp.preferences,
        // user selections
        selections: {
          selectedPlanId: safeString(s.selectedPlanId || "", 160, ""),
          donenessTargetKey: safeString(s.donenessTargetKey || "", 80, ""),
          selectedEquipmentIds: uniq(s.selectedEquipmentIds),
        },
        overrides: isPlainObject(s.overrides) ? s.overrides : {},
        options: {
          ...opts.adapterOptions,
          lightweight: !!opts.lightweight,
          debug: !!opts.debug,
        },
        meta: {
          source: "features/recipes/hooks/useCookSetup",
          at: nowMs(),
        },
      };
      return input;
    },
    [
      state,
      baseRecipe,
      kc.kitchenId,
      kc.equipmentIds,
      kc.capabilityKeys,
      dp.preferences,
      opts.adapterOptions,
      opts.lightweight,
      opts.debug,
    ]
  );

  const computeInputsKey = useCallback(
    (overrideState) => {
      const input = buildAdapterInput(overrideState);
      // Key should reflect the things that should cause a re-run.
      return stableJSON({
        recipeKey,
        kitchenId: input.kitchen.kitchenId,
        eq: input.kitchen.equipmentIds,
        caps: input.kitchen.capabilityKeys,
        donenessProfile: input.donenessProfile,
        selections: input.selections,
        overrides: input.overrides,
        opt: input.options,
      });
    },
    [buildAdapterInput, recipeKey]
  );

  const cancelInFlight = useCallback(() => {
    try {
      if (abortRef.current) abortRef.current.abort();
    } catch {
      // ignore
    } finally {
      abortRef.current = null;
    }
  }, []);

  const runAdaptationNow = useCallback(
    async (overrideState, reason = "manual") => {
      const inputsKey = computeInputsKey(overrideState);
      // avoid rerunning with identical inputs unless manual forced
      if (
        reason !== "manual" &&
        inputsKey &&
        inputsKey === lastInputsKeyRef.current
      ) {
        return { skipped: true, reason: "same_inputs" };
      }
      lastInputsKeyRef.current = inputsKey;

      cancelInFlight();

      const runId = ++runIdRef.current;
      const controller = new AbortController();
      abortRef.current = controller;

      setIsLoading(true);
      setError(null);

      if (opts.emitEvents) {
        safeEmit("recipes.cooksetup.adaptation.start", {
          runId,
          recipeKey,
          reason,
          inputsKey,
          at: nowMs(),
          source: "useCookSetup",
        });
      }

      let out = null;
      try {
        const adapterInput = buildAdapterInput(overrideState);

        // Support adapter signature with abort signal (preferred). If adapter ignores it, stale updates still blocked by runId check.
        out = await RecipeAdapterService.adaptRecipe(adapterInput, {
          signal: controller.signal,
        });

        if (runId !== runIdRef.current) {
          // stale
          return { skipped: true, reason: "stale_run" };
        }

        setAdaptation(out);

        // Clear dirty if this run reflects current state.
        setState((prev) => ({ ...prev, dirty: false }));

        if (opts.emitEvents) {
          safeEmit("recipes.cooksetup.adaptation.success", {
            runId,
            recipeKey,
            reason,
            at: nowMs(),
            status: safeString(out?.status || "ok", 10, "ok"),
            selectedPlanId: safeString(out?.selectedPlan?.id || "", 160, ""),
          });
        }

        return { ok: true, out };
      } catch (e) {
        if (controller.signal.aborted) {
          return { skipped: true, reason: "aborted" };
        }
        console.warn("[useCookSetup] adapter failed", e);
        if (runId !== runIdRef.current) {
          return { skipped: true, reason: "stale_error" };
        }
        setError(e || new Error("Adaptation failed"));
        if (opts.emitEvents) {
          safeEmit("recipes.cooksetup.adaptation.error", {
            runId,
            recipeKey,
            reason,
            at: nowMs(),
            message: safeString(
              e?.message || "Adaptation failed",
              500,
              "Adaptation failed"
            ),
          });
        }
        return { ok: false, error: e };
      } finally {
        if (runId === runIdRef.current) setIsLoading(false);
      }
    },
    [
      buildAdapterInput,
      cancelInFlight,
      computeInputsKey,
      opts.emitEvents,
      recipeKey,
    ]
  );

  const scheduleAdaptation = useCallback(
    (overrideState, reason = "auto") => {
      if (!opts.autoRun) return;
      if (!opts.rerunOnChange && reason !== "manual") return;

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        runAdaptationNow(overrideState, reason);
      }, opts.debounceMs);
    },
    [opts.autoRun, opts.rerunOnChange, opts.debounceMs, runAdaptationNow]
  );

  // Auto-run on initial mount / key changes (recipe, kitchen, donenessProfile).
  useEffect(() => {
    if (!opts.autoRun) return;

    // Build a "system" key (not including user selections)
    const sysKey = stableJSON({
      recipeKey,
      kitchenId: kc.kitchenId,
      eq: kc.equipmentIds,
      caps: kc.capabilityKeys,
      donenessProfile: dp.preferences,
    });

    scheduleAdaptation(undefined, "system_change");

    return () => {
      // cleanup timer on dependency change
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipeKey, stableJSON(kc), stableJSON(dp), opts.autoRun]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      cancelInFlight();
    };
  }, [cancelInFlight]);

  /* ------------------------------ actions ------------------------------ */

  const setDonenessTarget = useCallback(
    (donenessTargetKey) => {
      const key = safeString(donenessTargetKey || "", 80, "");
      setState((prev) => {
        const next = { ...prev, donenessTargetKey: key, dirty: true };
        return next;
      });

      if (opts.emitEvents) {
        safeEmit("recipes.cooksetup.doneness.change", {
          recipeKey,
          at: nowMs(),
          donenessTargetKey: key,
        });
      }

      scheduleAdaptation(
        (prev) => ({ ...prev, donenessTargetKey: key }),
        "doneness_change"
      );
    },
    [opts.emitEvents, recipeKey, scheduleAdaptation]
  );

  const setSelectedMethodPlan = useCallback(
    (planId) => {
      const id = safeString(planId || "", 160, "");
      setState((prev) => ({ ...prev, selectedPlanId: id, dirty: true }));

      if (opts.emitEvents) {
        safeEmit("recipes.cooksetup.methodplan.change", {
          recipeKey,
          at: nowMs(),
          selectedPlanId: id,
        });
      }

      scheduleAdaptation(
        (prev) => ({ ...prev, selectedPlanId: id }),
        "method_plan_change"
      );
    },
    [opts.emitEvents, recipeKey, scheduleAdaptation]
  );

  const setSelectedEquipmentIds = useCallback(
    (nextIds, meta) => {
      const ids = uniq(nextIds);
      setState((prev) => ({ ...prev, selectedEquipmentIds: ids, dirty: true }));

      if (opts.emitEvents) {
        safeEmit("recipes.cooksetup.equipment.change", {
          recipeKey,
          at: nowMs(),
          selectedEquipmentIds: ids,
          meta: meta || null,
        });
      }

      scheduleAdaptation(
        (prev) => ({ ...prev, selectedEquipmentIds: ids }),
        "equipment_change"
      );
    },
    [opts.emitEvents, recipeKey, scheduleAdaptation]
  );

  const toggleEquipment = useCallback(
    (id) => {
      const eid = safeString(id || "", 120, "");
      if (!eid) return;

      setState((prev) => {
        const set = new Set(prev.selectedEquipmentIds);
        const had = set.has(eid);
        if (had) set.delete(eid);
        else set.add(eid);
        const nextIds = Array.from(set);
        // schedule with derived state
        scheduleAdaptation(
          { ...prev, selectedEquipmentIds: nextIds, dirty: true },
          "equipment_toggle"
        );
        return { ...prev, selectedEquipmentIds: nextIds, dirty: true };
      });

      if (opts.emitEvents) {
        safeEmit("recipes.cooksetup.equipment.toggle", {
          recipeKey,
          at: nowMs(),
          equipmentId: eid,
        });
      }
    },
    [opts.emitEvents, recipeKey, scheduleAdaptation]
  );

  const setOverrides = useCallback(
    (patch) => {
      const p = isPlainObject(patch) ? patch : {};
      setState((prev) => {
        const nextOverrides = {
          ...(isPlainObject(prev.overrides) ? prev.overrides : {}),
          ...p,
        };
        const next = { ...prev, overrides: nextOverrides, dirty: true };
        scheduleAdaptation(next, "overrides_change");
        return next;
      });

      if (opts.emitEvents) {
        safeEmit("recipes.cooksetup.overrides.change", {
          recipeKey,
          at: nowMs(),
          patch: p,
        });
      }
    },
    [opts.emitEvents, recipeKey, scheduleAdaptation]
  );

  const resetToDefaults = useCallback(() => {
    cancelInFlight();
    if (debounceRef.current) clearTimeout(debounceRef.current);

    setState((prev) => {
      const requiredEquipmentIds =
        inferRequiredEquipmentFromAdaptation(adaptation);
      const selectedEquipmentIds = computeDefaultSelectedEquipment(
        requiredEquipmentIds,
        kc
      );

      const next = {
        recipeKey: prev.recipeKey,
        selectedPlanId: "",
        donenessTargetKey: "",
        selectedEquipmentIds,
        overrides: {},
        dirty: false,
      };

      // schedule an adaptation run with defaults
      if (opts.autoRun) {
        setTimeout(() => {
          runAdaptationNow(next, "reset_defaults");
        }, 0);
      }

      return next;
    });

    if (opts.emitEvents) {
      safeEmit("recipes.cooksetup.reset", { recipeKey, at: nowMs() });
    }
  }, [
    adaptation,
    cancelInFlight,
    kc,
    opts.autoRun,
    opts.emitEvents,
    recipeKey,
    runAdaptationNow,
  ]);

  const markClean = useCallback(() => {
    setState((prev) => ({ ...prev, dirty: false }));
  }, []);

  /* ------------------------------ UI bundle ------------------------------ */

  const ui = useMemo(() => {
    // Provide everything the modal needs in one object.
    const methodPlans = uiDerived.methodPlans || [];
    const requiredEquipmentIds = uiDerived.requiredEquipmentIds || [];
    const equipmentCatalog = uiDerived.equipmentCatalog || null;

    // Provide a "selectedPlan" object if possible
    const selectedPlan =
      methodPlans.find(
        (p) =>
          safeString(p.id || "", 160, "") ===
          safeString(state.selectedPlanId || "", 160, "")
      ) ||
      (isPlainObject(adaptation?.selectedPlan)
        ? adaptation.selectedPlan
        : null);

    return {
      adaptation,
      methodPlans,
      selectedPlan,
      requiredEquipmentIds,
      missingEquipmentIds: uiDerived.missingEquipmentIds,
      missingCapabilityKeys: uiDerived.missingCapabilityKeys,
      equipmentCatalog,
      // snapshot of current setup selection for display
      setup: {
        selectedPlanId: state.selectedPlanId,
        donenessTargetKey: state.donenessTargetKey,
        selectedEquipmentIds: uiDerived.selectedEquipmentIds,
        overrides: state.overrides,
        dirty: state.dirty,
      },
    };
  }, [adaptation, state, uiDerived]);

  /* ------------------------------ return API ------------------------------ */

  return {
    // State snapshot
    state: {
      ...state,
      // ensure equipment includes derived required
      selectedEquipmentIds: uiDerived.selectedEquipmentIds,
    },

    // Status
    isLoading,
    error,

    // UI-friendly bundle
    ui,

    // Actions
    setDonenessTarget,
    setSelectedMethodPlan,
    setSelectedEquipmentIds,
    toggleEquipment,
    setOverrides,
    runAdaptationNow,
    resetToDefaults,
    cancelInFlight,
    markClean,
  };
}

export default useCookSetup;
