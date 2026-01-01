// src/services/templates/donenessTexturePersonalizer.js
import * as RecipeStore from "@/store/RecipeStore";
import { callLLM } from "@/agents/base/AgentCore";

// Optional stores (guarded)
let DeviceStore, TasteProfileStore, MultiTimerManager;
try { DeviceStore = require("@/store/DeviceStore"); } catch (_) {}
try { TasteProfileStore = require("@/store/TasteProfileStore"); } catch (_) {}
try { MultiTimerManager = require("@/store/MultiTimerManager"); } catch (_) {}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));
const round = (n, d = 0) => Math.round(n * 10 ** d) / 10 ** d;
const isoNow = () => new Date().toISOString();

export const template = {
  // Keep the same id for callers; bump version for capability
  id: "doneness_texture_personalizer",
  version: "3.0.0",
  purpose:
    "Personalize doneness & texture with sensory anchors, calibrated timers, probe hints, and a feedback loop. Visible-draft first.",
  triggers: [
    "event::first_time_recipe",
    "profile::diet_change",
    "ui::LiveCookingWalkthrough.open",
    "event::user_feedback_doneness"
  ],
  inputs: {
    required: ["recipeId"],
    optional: [
      "donenessPrefs",           // { meats?, pasta?, veg?, rice?, eggs?, probeTargets? }
      "stoveHeatBias",           // 'runsHot'|'runsCool'|'neutral'
      "ovenBiasPct",             // +/- % oven bias
      "probeTargets",            // map of item->target °C
      "units"                    // 'C'|'F' for UI hints (default 'F')
    ]
  },
  logic: {
    selectors: [
      "RecipeStore.getById(recipeId)",
      "DeviceStore.getCalibration() → { stoveHeatBias, ovenBiasPct }",
      "TasteProfileStore.getUserDoneness()",
      "Per-step cue augmentation via LLM with robust fallbacks",
      "Step time bias by method (stovetop vs oven/grill)"
    ],
    rules: [
      "Add 1–2 compact visual/texture/sound anchors on each heat step.",
      "Apply stove bias to saute/simmer/boil/fry; oven bias to bake/roast/grill.",
      "Suggest probe targets (°F/°C) with carryover notes when relevant.",
      "Return visible draft of tuned steps; orchestrator may apply or revert.",
      "Persist merged prefs; learn from user timer corrections over time."
    ],
    llm_roles: [
      "Rewrite steps in a calm, compact style; include sensory anchors; avoid purple prose."
    ]
  },
  actions: [
    "OPEN_UI", "PATCH_RECIPE_STEPS", "SAVE_PREFERENCES", "NOTIFY", "CREATE_TASK"
  ],
  outputs: {
    data: ["stepsTuned", "timerAdjustHints", "probeHints", "appliedBias", "draft"],
    ui: [],
    alerts: []
  },
  fallbacks: [
    "If disliked, re-run with adjusted prefs; we record delta to improve next time."
  ],
  success_message: "Doneness cues drafted. Review & apply when ready.",
  used_by: ["cookingAgent"]
};

/* ----------------------- Helpers ----------------------- */
const METHOD_MAP = [
  { key: /sauté|saute|sear|brown/i, tag: "saute" },
  { key: /simmer|reduce/i, tag: "simmer" },
  { key: /boil|parboil|blanch/i, tag: "boil" },
  { key: /bake|roast|oven/i, tag: "oven" },
  { key: /grill|broil/i, tag: "grill" },
  { key: /fry|shallow-fry|deep-fry/i, tag: "fry" },
];
const detectMethod = (text = "") => (METHOD_MAP.find(m => m.key.test(text))?.tag || "other");

function defaultAnchors(text = "") {
  const t = text.toLowerCase();
  const m = detectMethod(text);
  if (t.includes("pasta") || t.includes("noodle")) return ["Al dente: slight resistance", "No chalky core"];
  if (t.includes("rice") || t.includes("quinoa")) return ["Tender, separate grains", "No starchy puddle"];
  if (t.includes("egg")) return ["Edges set, centers just glossy", "No liquid pooling"];
  if (t.includes("broccoli") || t.includes("green bean")) return ["Bright color, tender-crisp", "Knife meets slight resistance"];
  switch (m) {
    case "saute":  return ["Edges deep golden", "Fond forms; no black patches"];
    case "simmer": return ["Lazy tiny bubbles", "Coats back of spoon"];
    case "boil":   return ["Active bubbles", "Softens yet holds shape"];
    case "oven":   return ["Edges pull from pan", "Center springs back lightly"];
    case "grill":  return ["Defined grill marks", "Juices run clear/rosy per target"];
    case "fry":    return ["Steady bubbles", "Even golden, crisp sound"];
    default:       return ["Evenly heated", "Aroma blooms; no scorching"];
  }
}

const DEFAULT_PROBE_C = {
  chickenBreast: 64, chickenThigh: 74, steakRare: 52, steakMed: 57, steakWell: 65,
  salmon: 50, porkChop: 63, lambMed: 60, meatloaf: 68, eggSoft: 63, eggHard: 71
};
function pickProbeTargets(text = "", custom = {}, units = "F") {
  const t = text.toLowerCase();
  const map = { ...DEFAULT_PROBE_C, ...(custom || {}) };
  let key = null;
  if (t.includes("chicken") && t.includes("breast")) key = "chickenBreast";
  else if (t.includes("chicken")) key = "chickenThigh";
  else if (t.includes("salmon")) key = "salmon";
  else if (t.includes("pork")) key = "porkChop";
  else if (t.includes("meatloaf")) key = "meatloaf";
  else if (t.includes("lamb")) key = "lambMed";
  else if (t.includes("steak")) key = "steakMed";
  else if (t.includes("egg")) key = "eggSoft";
  if (!key) return null;
  const c = map[key]; if (!Number.isFinite(c)) return null;
  const isF = String(units || "F").toUpperCase() === "F";
  return { key, target: Math.round(isF ? (c * 9/5 + 32) : c), units: isF ? "°F" : "°C" };
}

const heatBiasFactor = (stoveHeatBias) =>
  stoveHeatBias === "runsHot" ? 0.9 : stoveHeatBias === "runsCool" ? 1.1 : 1.0;

const ovenBiasFactor = (pct) => {
  const n = Number(pct);
  if (!Number.isFinite(n) || n === 0) return 1.0;
  return clamp(1 + n / 100, 0.8, 1.2);
};

function applyDurationBias(seconds, method, stoveBias, ovenBias) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  let factor = 1.0;
  if (["saute", "simmer", "boil", "fry"].includes(method)) factor *= stoveBias;
  if (["oven", "grill"].includes(method)) factor *= ovenBias;
  const to = clamp(Math.round(seconds * factor), 10, 3 * 3600);
  return to !== seconds ? { from: seconds, to } : null;
}

/* ----------------------- LLM (optional) ----------------------- */
async function llmTune(steps, prefs) {
  try {
    const res = await callLLM(
      [
        { role: "system", content: "You are a calm, precise cooking guide. Keep steps compact. Add 1–2 short visual/texture/sound anchors to each heat step." },
        { role: "user", content: JSON.stringify({ steps, prefs }) }
      ],
      { temperature: 0.2, max_tokens: 900 }
    );
    const parsed = JSON.parse(res?.content || "{}");
    if (parsed?.steps?.length) return parsed.steps; // [{text, cues?, seconds?}]
  } catch {}
  return null;
}

/* ----------------------- Core execute ----------------------- */
/**
 * New entrypoint preferred by orchestrators.
 * @param {{recipeId:string, donenessPrefs?:Object, stoveHeatBias?:string, ovenBiasPct?:number, probeTargets?:Object, units?:'C'|'F'}} payload
 * @param {{applyDrafts?:boolean, openUI?:Function, now?:Date}} ctx
 */
export async function execute(payload, ctx = {}) {
  const {
    recipeId,
    donenessPrefs = {},
    stoveHeatBias,
    ovenBiasPct,
    probeTargets,
    units = "F"
  } = payload || {};
  const { applyDrafts = false, openUI, now = new Date() } = ctx;

  if (!recipeId) throw new Error("donenessTexturePersonalizer: recipeId is required");
  const recipe = RecipeStore.getById?.(recipeId) || RecipeStore.getRecipe?.(recipeId);
  if (!recipe) throw new Error("donenessTexturePersonalizer: recipe not found");

  const deviceCal = DeviceStore?.getCalibration?.() || {};
  const stoveBias = heatBiasFactor(stoveHeatBias || deviceCal.stoveHeatBias || "neutral");
  const ovenBias = ovenBiasFactor(
    Number.isFinite(ovenBiasPct) ? ovenBiasPct : Number(deviceCal.ovenBiasPct || 0)
  );

  const userTaste = TasteProfileStore?.getUserDoneness?.() || {};
  const mergedPrefs = { ...userTaste, ...donenessPrefs };

  const baseSteps = (recipe.steps || []).map((s) => (typeof s === "string" ? { text: s } : { ...s }));
  const llm = await llmTune(baseSteps, mergedPrefs);

  const timerAdjustHints = {};
  const probeHints = [];
  const appliedBias = { stoveBias, ovenBias };

  const tuned = baseSteps.map((s, i) => {
    const method = detectMethod(s.text || "");
    const llmStep = llm?.[i] || {};
    const cues = (llmStep.cues && llmStep.cues.length ? llmStep.cues : defaultAnchors(s.text));

    const seconds = Number.isFinite(llmStep.seconds) ? llmStep.seconds : Number(s.seconds || s.duration || 0);
    const biasDelta = seconds ? applyDurationBias(seconds, method, stoveBias, ovenBias) : null;
    if (biasDelta) timerAdjustHints[i] = biasDelta;

    const prob = pickProbeTargets(s.text || "", probeTargets || mergedPrefs.probeTargets, units);
    if (prob) {
      const carry = ["oven", "grill"].includes(method) ? (String(units).toUpperCase() === "F" ? "+5°F rest" : "+3°C rest") : null;
      probeHints.push({ stepIndex: i, ...prob, carryover: carry });
    }

    const newSeconds = biasDelta ? biasDelta.to : seconds;

    // fast sensory checks for starches/veg
    let quickCheck = null;
    const t = (s.text || "").toLowerCase();
    if (t.includes("pasta")) quickCheck = "Taste a piece: slight core resistance, not chalky.";
    else if (t.includes("broccoli") || t.includes("green bean")) quickCheck = "Pierce tip: light resistance; color stays bright.";
    else if (t.includes("rice")) quickCheck = "Spoon test: grains separate, no starchy puddle.";

    return {
      ...s,
      calmText: llmStep.text || s.calmText || s.text,
      cues,
      method,
      seconds: newSeconds || undefined,
      duration: newSeconds || undefined,
      quickCheck: quickCheck || s.quickCheck || undefined
    };
  });

  // Persist prefs best-effort
  try {
    RecipeStore.savePreferences?.(recipeId, {
      donenessPrefs: mergedPrefs,
      stoveHeatBias: stoveHeatBias || deviceCal.stoveHeatBias || "neutral",
      ovenBiasPct: Number.isFinite(ovenBiasPct) ? ovenBiasPct : (deviceCal.ovenBiasPct || 0),
      updatedAt: isoNow()
    });
  } catch {}

  // Suggested actions (visible draft)
  const actions = [
    {
      type: "OPEN_UI",
      route: "/tier2/kitchen/live",
      component: "LiveCookingWalkthrough",
      params: { recipeId, steps: tuned, draft: true }
    },
    { type: "PATCH_RECIPE_STEPS", recipeId, steps: tuned, draft: !applyDrafts },
    { type: "SAVE_PREFERENCES", recipeId, prefs: { donenessPrefs: mergedPrefs,
        stoveHeatBias: stoveHeatBias || deviceCal.stoveHeatBias || "neutral",
        ovenBiasPct: Number.isFinite(ovenBiasPct) ? ovenBiasPct : (deviceCal.ovenBiasPct || 0) } }
  ];

  if (Math.abs(ovenBias - 1.0) >= 0.05 || Math.abs(stoveBias - 1.0) >= 0.05) {
    actions.push({
      type: "NOTIFY",
      channel: "inbox",
      title: "Applied device calibration",
      body: `Cook times adjusted (stove ×${round(stoveBias, 2)}, oven ×${round(ovenBias, 2)}).`,
      tags: ["cooking", "personalization"]
    });
  }

  // Optional calibration coaching if historic corrections are large/frequent
  try {
    const hist = RecipeStore.getTimerCorrections?.(recipeId) || []; // [{deltaPct, atISO}]
    const large = (hist || []).filter(h => Math.abs(h.deltaPct) >= 15);
    if (large.length >= 3) {
      actions.push({
        type: "CREATE_TASK",
        title: "Quick stove/oven calibration",
        dueISO: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        notes: "Run sugar-water simmer (stove) and sugar melt @ 350°F (oven) tests to refine timing bias.",
        tags: ["calibration", "kitchen"]
      });
    }
  } catch {}

  // Open UI immediately if provided
  if (typeof openUI === "function") {
    try { openUI("LiveCookingWalkthrough", { recipeId, steps: tuned, draft: true }); } catch {}
  } else {
    try {
      window.dispatchEvent(new CustomEvent("ui:navigate", {
        detail: { route: "/tier2/kitchen/live", params: { recipeId, steps: tuned, draft: true } }
      }));
    } catch {}
  }

  return {
    ok: true,
    stepsTuned: tuned,
    timerAdjustHints,
    probeHints,
    appliedBias,
    draft: !applyDrafts,
    actions,
    message: template.success_message
  };
}

/* ----------------------- Legacy adapter ----------------------- */
/**
 * Legacy entrypoint (kept for backwards compatibility with callers using run(ctx)).
 * Accepts ctx with { recipeId, donenessPrefs, stoveHeatBias } and returns the same shape.
 */
export async function run(ctx = {}) {
  const { recipeId, donenessPrefs, stoveHeatBias } = ctx || {};
  return execute({ recipeId, donenessPrefs, stoveHeatBias }, {});
}

const DONENESS_TEMPLATE = { ...template, execute, run };
export default DONENESS_TEMPLATE;
