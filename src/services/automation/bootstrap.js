// C:\Users\larho\suka-smart-assistant\src\services\automation\bootstrap.js
//
// Suka Smart Assistant — Automation Bootstrap (Dynamic, ESM)
//
// What’s new:
//  • Robust agent resolution (default/named/factory/class/async)
//  • Event shape aligned with agentRegistry: { topic, payload, ... }
//  • SSR-safe “household intuition” wiring (guards for window)
//  • Idempotent start; clear boot order: agents → templates → triggers
//  • Flexible trigger registration (default/named/factory)
//

import { automation } from "@/services/automation/runtime";
import autoRegisterTemplates from "@/services/automation/autoRegisterTemplates";
import { registerAgent } from "@/services/automation/agentRegistry";

/* ----------------------------- Agents ---------------------------------- */
/**
 * We keep your explicit imports (fast path), but the resolver below
 * tolerates default/named/factory/class and promise-returning modules.
 */
import * as animalAgentMod from "@/agents/animalAgent";
import * as gardenAgentMod from "@/agents/gardeningAgent";
import * as gardenHealthAgentMod from "@/agents/gardenHealthAgent";
import * as gardenHarvestAgentMod from "@/agents/gardenHarvestAgent";
import * as soilAndWaterAgentMod from "@/agents/soilAndWaterAgent";
import * as breedingAndButcheringAgentMod from "@/agents/breedingAndButcheringAgent";
import * as mealPlanningAgentMod from "@/agents/mealPlanningAgent";
import * as cookingAgentMod from "@/agents/cookingAgent";
import * as recipeConsolidatorAgentMod from "@/agents/recipeConsolidatorAgent";
import * as inventoryAgentMod from "@/agents/inventoryAgent";
import * as batchCookingAgentMod from "@/agents/batchCookingAgent";
import * as cleaningAgentMod from "@/agents/cleaningAgent";
import * as feedOptimizerAgentMod from "@/agents/feedOptimizerAgent";
import * as companionPlantingAgentMod from "@/agents/companionPlantingAgent";
import * as wasteToCompostAgentMod from "@/agents/wasteToCompostAgent";
import * as storehouseAgentMod from "@/agents/storehouseAgent";

/* ----------------------------- Triggers -------------------------------- */
import * as loadCalendarContextMod from "@/services/triggers/loadCalendarContext";
import * as detectCleaningTriggersMod from "@/services/triggers/detectCleaningTriggers";
import * as householdOrchestratorMod from "@/services/triggers/householdOrchestrator";

/* ----------------------------- Safe resolvers --------------------------- */
function pickFirstExport(mod, preferred = []) {
  if (!mod) return undefined;
  if (mod.default) return mod.default;
  for (const k of preferred) if (mod[k]) return mod[k];
  if (mod.template) return mod.template;
  if (typeof mod.getTemplate === "function") return mod.getTemplate();
  if (mod.agent) return mod.agent;
  const val = Object.values(mod).find((v) => typeof v === "object" || typeof v === "function");
  return val;
}

async function resolveMaybeAsync(entity) {
  // If it's a promise (dynamic import/factory), await once
  if (entity && typeof entity.then === "function") {
    try { return await entity; } catch { return undefined; }
  }
  // If it's a factory (function without prototype methods), try invoking with no args
  if (typeof entity === "function") {
    const proto = entity.prototype || {};
    const looksClass = typeof proto === "object" && (proto.start || proto.teardown || proto.handleEvent);
    if (!looksClass) {
      try {
        const out = entity();
        return typeof out?.then === "function" ? await out : out ?? entity; // fall back to original
      } catch {
        return entity; // could be intended as class/ctor
      }
    }
  }
  return entity;
}

/* ----------------------------- Agent registration ---------------------- */
async function registerAllAgents() {
  const defs = [
    ["animalAgent", pickFirstExport(animalAgentMod, ["animalAgent"])],
    ["gardenAgent", pickFirstExport(gardenAgentMod, ["gardenAgent", "gardeningAgent"])],
    ["gardenHealthAgent", pickFirstExport(gardenHealthAgentMod, ["gardenHealthAgent"])],
    ["gardenHarvestAgent", pickFirstExport(gardenHarvestAgentMod, ["gardenHarvestAgent"])],
    ["soilAndWaterAgent", pickFirstExport(soilAndWaterAgentMod, ["soilAndWaterAgent"])],
    ["breedingAndButcheringAgent", pickFirstExport(breedingAndButcheringAgentMod, ["breedingAndButcheringAgent"])],
    ["mealPlanningAgent", pickFirstExport(mealPlanningAgentMod, ["mealPlanningAgent"])],
    ["cookingAgent", pickFirstExport(cookingAgentMod, ["cookingAgent"])],
    ["recipeConsolidatorAgent", pickFirstExport(recipeConsolidatorAgentMod, ["recipeConsolidatorAgent"])],
    ["inventoryAgent", pickFirstExport(inventoryAgentMod, ["inventoryAgent"])],
    ["batchCookingAgent", pickFirstExport(batchCookingAgentMod, ["batchCookingAgent"])],
    ["cleaningAgent", pickFirstExport(cleaningAgentMod, ["cleaningAgent"])],
    ["feedOptimizerAgent", pickFirstExport(feedOptimizerAgentMod, ["feedOptimizerAgent"])],
    ["companionPlantingAgent", pickFirstExport(companionPlantingAgentMod, ["companionPlantingAgent"])],
    ["wasteToCompostAgent", pickFirstExport(wasteToCompostAgentMod, ["wasteToCompostAgent"])],
    ["storehouseAgent", pickFirstExport(storehouseAgentMod, ["storehouseAgent"])],
  ];

  // Resolve async/factories and register with the upgraded agentRegistry
  for (const [name, raw] of defs) {
    try {
      const inst = await resolveMaybeAsync(raw);
      if (!inst) {
        console.warn(`[automation] Agent "${name}" not found or not exported. Skipping.`);
        continue;
      }
      await registerAgent(name, inst);
    } catch (e) {
      console.warn(`[automation] Failed to register agent "${name}":`, e?.message || e);
    }
  }
}

/* ------------------------- Household intuition wiring ------------------ */
/**
 * Emits UX/session signals as automation events with canonical topics,
 * matching the agentRegistry eventCtx contract:
 *   { topic: string, payload: object, ts: number, source?: string }
 */
function wireHouseholdIntuition() {
  if (typeof window === "undefined" || !window?.addEventListener) return; // SSR/Node guard

  const emit = (topic, payload = {}) => {
    try {
      automation.emit?.("event", { topic, payload, ts: Date.now(), source: "intuition" });
    } catch (e) {
      console.warn("[automation/bootstrap] emit failed:", topic, e?.message || e);
    }
  };

  // Cooking lifecycle
  window.addEventListener("session:cooking:planned", () => emit("SESSION.COOKING.PLANNED"));
  window.addEventListener("session:cooking:started", () => emit("SESSION.COOKING.STARTED"));
  window.addEventListener("session:cooking:finished", () => emit("SESSION.COOKING.FINISHED"));

  // Cleaning lifecycle
  window.addEventListener("session:cleaning:planned", () => emit("SESSION.CLEANING.PLANNED"));
  window.addEventListener("session:cleaning:started", () => emit("SESSION.CLEANING.STARTED"));
  window.addEventListener("session:cleaning:finished", () => emit("SESSION.CLEANING.FINISHED"));

  // Gardening / season windows
  window.addEventListener("garden:harvest:window", () => emit("GARDEN.HARVEST.WINDOW"));
  window.addEventListener("garden:planting:window", () => emit("GARDEN.PLANTING.WINDOW"));

  // Weather signals
  window.addEventListener("weather:frostAlert", () => emit("WEATHER.FROST.ALERT"));
  window.addEventListener("weather:heatAlert", () => emit("WEATHER.HEAT.ALERT"));
  window.addEventListener("weather:rainWindow", () => emit("WEATHER.RAIN.WINDOW"));

  // Sabbath rhythm
  window.addEventListener("sabbath:prep", () => emit("SABBATH.PREP.WINDOW"));
  window.addEventListener("sabbath:start", () => emit("SABBATH.START"));
  window.addEventListener("sabbath:end", () => emit("SABBATH.END"));
}

/* ----------------------------- Trigger registration -------------------- */
function resolveTrigger(mod, preferred = []) {
  const t = pickFirstExport(mod, preferred);
  return t;
}
function registerTriggers() {
  const triggers = [
    resolveTrigger(loadCalendarContextMod, ["loadCalendarContext"]),
    resolveTrigger(detectCleaningTriggersMod, ["detectCleaningTriggers"]),
    resolveTrigger(householdOrchestratorMod, ["householdOrchestrator"]),
  ];

  for (const trig of triggers) {
    if (!trig) continue;
    try {
      // runtime tolerates function or object; we pass through directly
      automation.registerTrigger(trig);
    } catch (e) {
      console.warn("[automation] Failed to register trigger:", e?.message || e);
    }
  }
}

/* ----------------------------- Bootstrap -------------------------------- */
/**
 * Boot sequence:
 *   1) Agents (so templates/triggers can call them)
 *   2) Templates (auto-discovery + normalization + shims)
 *   3) Triggers (background orchestration)
 *   4) Start runtime (idempotent)
 *   5) Optionally wire household intuition (browser only)
 */
export async function bootstrapAutomation(options = {}) {
  const { wireIntuition = true } = options;
  try {
    await registerAllAgents();                 // 1
    await autoRegisterTemplates();             // 2
    registerTriggers();                        // 3
    automation.start?.({ source: "bootstrap" }); // 4 (idempotent)

    if (wireIntuition) wireHouseholdIntuition(); // 5

    if (import.meta?.env?.DEV) {
      try {
        const ids = automation.getTemplates?.().map((t) => t.id);
        console.debug("[automation] templates:", ids);
        console.debug("[automation] runtime started & intuition wired.");
      } catch {}
    }
  } catch (e) {
    console.error("Automation bootstrap failed (skipped):", e?.message || e);
  }
}

export default bootstrapAutomation;
