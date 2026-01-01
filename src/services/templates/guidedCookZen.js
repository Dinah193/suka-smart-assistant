// src/services/templates/guidedCookZen.js

import * as RecipeStore from "@/store/RecipeStore";
import * as timeUtils from "@/utils/timeUtils";
import extractPrepTasks from "@/utils/extractPrepTasks";
import generateMealTimeline from "@/services/planning/generateMealTimeline";
import {
  createTimer,
  startTimer,
  pauseTimer,
  completeTimer,
  removeTimer,
} from "@/store/MultiTimerManager";
import { callLLM } from "@/agents/base/AgentCore";

// Optional/guarded modules (non-fatal if absent)
let SessionStore, HapticsManager, SpeechManager, BadgeManager;
try { SessionStore = require("@/store/SessionStore"); } catch (_) {}
try { HapticsManager = require("@/managers/HapticsManager").default; } catch (_) {}
try { SpeechManager = require("@/managers/SpeechManager").default; } catch (_) {}
try { BadgeManager = require("@/managers/BadgeManager"); } catch (_) {}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));
const seconds = (min) => Math.max(1, Math.round((Number(min) || 0) * 60));

/**
 * Contract-compliant template metadata
 */
export const template = {
  id: "guided_cook_zen_v2",
  version: "2.2.0",
  purpose: "Calm, step-by-step cook-through with visual doneness cues, live recovery, and pacing.",
  triggers: [
    "ui::StartSession",
    "voice::start cooking",
    "ui::panic",                 // integrates Flow Saver
    "timer::overdue_soft_ping"   // soft nudge loop
  ],
  inputs: {
    required: ["recipeId"],
    optional: ["donenessPrefs", "tools", "servings", "stoveHeatBias", "assistiveMode" /* 'voice'|'touch'|'handsfree' */]
  },
  logic: {
    selectors: [
      "RecipeStore.getById(recipeId)",
      "extractPrepTasks(recipe)",
      "generateMealTimeline({ recipe, tools, servings, donenessPrefs })",
      "Doneness Personalizer: doneness_texture_personalizer_v1 (pre-timers)",
      "Flow Saver: flow_saver_swap_recover_v1 (panic path)"
    ],
    rules: [
      "Merge prep tasks with cook steps; create overlaps & buffers.",
      "Attach calm wording + 1–2 visual cues per heat step.",
      "Apply stoveHeatBias timer tuning via Personalizer.",
      "Start synchronized timers; soft nudges if a step is missed.",
      "Live catch-up branch compresses safe steps when behind.",
      "Hands-free voice nav optional; light haptics when step starts/ends."
    ],
    llm_roles: [
      "Rewrite steps concisely in a gentle tone.",
      "Generate 1–2 VISUAL doneness cues for each heat step."
    ]
  },
  actions: [
    "OPEN_UI:LiveCookingWalkthrough.jsx#session",
    "OPEN_UI:VoiceStepNavigator.jsx#session",
    "TIMERS:startFromTimeline",
    "RUN:doneness_texture_personalizer_v1",
    "RUN:flow_saver_swap_recover_v1 (on panic)",
    "EVENT:guidedcook:catchup",
  ],
  outputs: {
    ui: ["LiveCookingWalkthrough.jsx", "VoiceStepNavigator.jsx"],
    data: ["timers", "voicePrompts", "plateUpTime", "sessionId", "actions"],
    alerts: ["step_nudges", "overdue_soft_ping", "catchup_available"]
  },
  fallbacks: [
    "If a step is missed → offer catch-up branch that compresses/overlaps the next two steps safely.",
    "If something burns/spills → route to Flow Saver Swap/Recover."
  ],
  success_message: "Okay—let’s cook. I’ll guide and keep time for you.",
  used_by: ["cookingAgent", "batchCookingAgent"]
};

/* =========================
   Doneness cues / LLM glue
   ========================= */

function fallbackCuesFor(stepText = "") {
  const t = stepText.toLowerCase();
  if (t.includes("onion")) return ["Onions turn glossy and translucent", "Edges curl slightly"];
  if (t.includes("sear") || t.includes("brown"))
    return ["Surface turns deep golden-brown", "Fond forms on pan (not black)"];
  if (t.includes("boil") && t.includes("pasta"))
    return ["Al dente: firm bite, no chalky core", "No sticking when tossed"];
  if (t.includes("sauté") || t.includes("saute") || t.includes("stir-fry"))
    return ["Vegetables bright in color", "Still crisp when pressed with spoon"];
  if (t.includes("bake"))
    return ["Center set; springs back lightly", "Edges just pull from pan"];
  if (t.includes("reduce") || t.includes("simmer"))
    return ["Slow, steady bubbles", "Sauce coats back of spoon"];
  return ["Looks evenly heated", "Aromas bloom; no scorching smell"];
}

async function generateLLMCues(steps, donenessPrefs = {}) {
  try {
    const prompt = [
      { role: "system", content: "You are a gentle cooking guide. Keep steps short. Add 1–2 VISUAL doneness cues (color/texture/sound) for each heat step." },
      { role: "user", content: JSON.stringify({ steps, donenessPrefs }) }
    ];
    const res = await callLLM(prompt, { temperature: 0.35, max_tokens: 900 });
    const parsed = JSON.parse(res?.content || "{}");
    if (parsed?.steps?.length) return parsed.steps;  // [{text, cues[]}]
  } catch (_) {}
  return null;
}

/* =========================
   Catch-up & pacing helpers
   ========================= */

function buildCatchUpBranch(currentIndex, timeline) {
  const nextTwo = (timeline.steps || []).slice(currentIndex, currentIndex + 2);
  if (!nextTwo.length) return null;

  const patch = nextTwo.map((s) => {
    const dMin = Number(s.duration ?? 0);
    const compressed = /simmer|rest|proof|marinate|reduce/i.test(s.text)
      ? Math.max(1, Math.round(dMin * 0.8))
      : dMin;
    return { ...s, duration: compressed, note: "Catch-up compression applied (safe range)." };
  });

  return {
    title: "Catch-up branch",
    steps: patch,
    advisory: "We compressed safe steps so you can recover without burning."
  };
}

function startFromTimeline(enrichedTimeline, { nudgeEvery = 60, onMissedStep, onStepStart, onStepEnd } = {}) {
  const sessionId = `gc_${Date.now()}`;
  const steps = Array.isArray(enrichedTimeline?.steps) ? enrichedTimeline.steps : [];

  let cursor = 0;
  const planned = steps.map((s, i) => {
    const startAtSec = Number.isFinite(s.startAtSec) ? Math.max(0, s.startAtSec) : cursor;
    const durationSec = seconds(s.duration ?? 1);
    cursor = Math.max(cursor, startAtSec) + durationSec;

    const id = `${sessionId}_${i}`;
    const label = (s.calmText || s.text || `Step ${i + 1}`).slice(0, 80);

    createTimer(id, label, durationSec);

    setTimeout(() => {
      startTimer(id);
      try {
        onStepStart?.(i, { id, label });
        HapticsManager?.pulse?.("soft");
        if (SpeechManager?.speak && s?.announce !== false) {
          SpeechManager.speak(label);
        }
      } catch {}
    }, Math.max(0, startAtSec) * 1000);

    // Schedule step end cue
    setTimeout(() => {
      try {
        onStepEnd?.(i, { id, label });
        HapticsManager?.pulse?.("soft");
      } catch {}
    }, Math.max(0, startAtSec + durationSec) * 1000);

    // Missed-step detector
    if (typeof onMissedStep === "function") {
      setTimeout(() => {
        try { onMissedStep(i); } catch {}
      }, Math.max(0, startAtSec + 10) * 1000);
    }

    return { id, label, startAtSec, durationSec };
  });

  return { timers: planned, sessionId };
}

/* =========================
   Execute
   ========================= */

/**
 * Execute the template.
 * @param {{recipeId:string, donenessPrefs?:Object, tools?:Array, servings?:number, stoveHeatBias?:'runsHot'|'runsCool', assistiveMode?:'voice'|'touch'|'handsfree'}} payload
 * @param {{openUI?:(route:string, params?:any)=>void, runTemplate?:(id:string, payload?:any, opts?:any)=>Promise<any>}} ctx
 * @returns {Promise<{sessionId:string, timers:Array, voicePrompts:Array, plateUpTime:Date|string, actions:Array, message:string}>}
 */
export async function execute(payload, ctx = {}) {
  const {
    recipeId,
    donenessPrefs = {},
    tools = [],
    servings,
    stoveHeatBias,
    assistiveMode = "touch"
  } = payload || {};
  const { openUI, runTemplate } = ctx;

  // 1) Load recipe
  const recipe =
    RecipeStore.getById?.(recipeId) ||
    RecipeStore.getRecipe?.(recipeId) ||
    null;
  if (!recipe) throw new Error(`guidedCookZen: recipe not found: ${recipeId}`);

  // 2) Extract prep & build baseline timeline
  const prep = await extractPrepTasks(recipe);
  const rawTimeline = await generateMealTimeline({
    recipe,
    prep,
    tools,
    servings: servings || recipe.servings || 2,
    donenessPrefs,
    context: { mode: "guided-cook-zen" }
  });

  // 3) Calm wording + visual cues (LLM best-effort → heuristic fallback)
  const llmCues = await generateLLMCues(
    rawTimeline.steps.map((s) => ({ text: s.text, duration: s.duration })),
    donenessPrefs
  );

  const mergedSteps = rawTimeline.steps.map((s, i) => ({
    ...s,
    cues: llmCues?.[i]?.cues || fallbackCuesFor(s.text),
    calmText: llmCues?.[i]?.text || s.text
  }));

  let enrichedTimeline = { ...rawTimeline, steps: mergedSteps };

  // 4) Doneness & Texture Personalizer BEFORE timers (bias durations)
  try {
    if (typeof runTemplate === "function") {
      const tune = await runTemplate("doneness_texture_personalizer_v1", {
        recipeId,
        donenessPrefs,
        stoveHeatBias
      });
      if (tune?.stepsTuned?.length) {
        enrichedTimeline = {
          ...enrichedTimeline,
          steps: enrichedTimeline.steps.map((s, i) => ({
            ...s,
            calmText: tune.stepsTuned[i]?.calmText || s.calmText || s.text,
            cues: tune.stepsTuned[i]?.cues || s.cues,
            duration: tune.stepsTuned[i]?.duration ?? s.duration
          }))
        };
      }
    }
  } catch (_) {
    // non-fatal
  }

  // 5) Start synchronized multi-timers with live catch-up hooks
  const actions = [];
  const { timers, sessionId } = startFromTimeline(enrichedTimeline, {
    nudgeEvery: 60,
    onMissedStep: (index) => {
      const patch = buildCatchUpBranch(index, enrichedTimeline);
      if (patch) {
        window.dispatchEvent(new CustomEvent("guidedcook:catchup", {
          detail: { sessionId, patch, index }
        }));
        actions.push({ type: "EVENT", name: "guidedcook:catchup", index });
      }
    },
    onStepStart: (i, meta) => {
      actions.push({ type: "STEP_START", index: i, meta });
    },
    onStepEnd: (i, meta) => {
      actions.push({ type: "STEP_END", index: i, meta });
      if (i === enrichedTimeline.steps.length - 1) {
        try { BadgeManager?.increment?.("guided_cook_session"); } catch {}
      }
    }
  });

  // 6) Open the Live Walkthrough + Voice Navigator
  const totalMin = Number(enrichedTimeline.totalMinutes ?? rawTimeline.totalMinutes ?? 0);
  const plateUpTime = timeUtils?.addMinutesToNow?.(totalMin) || new Date(Date.now() + seconds(totalMin) * 1000);
  const navParams = { sessionId, recipeId, plateUpTime, donenessPrefs, assistiveMode };

  if (typeof openUI === "function") {
    openUI("LiveCookingWalkthrough", navParams);
    if (assistiveMode !== "touch") openUI("VoiceStepNavigator", navParams);
  } else {
    window.dispatchEvent(new CustomEvent("ui:navigate", { detail: { route: "LiveCookingWalkthrough", params: navParams } }));
    if (assistiveMode !== "touch") {
      window.dispatchEvent(new CustomEvent("ui:navigate", { detail: { route: "VoiceStepNavigator", params: navParams } }));
    }
  }

  // 7) Voice prompts (UI can schedule via offsets)
  const voicePrompts = enrichedTimeline.steps.map((s, i) => ({
    at: s.startAtSec ?? i,
    text: s.calmText,
    cues: s.cues
  }));

  // 8) Persist minimal session context (best-effort)
  try {
    SessionStore?.save?.(sessionId, {
      recipeId,
      startedAt: new Date().toISOString(),
      plateUpTime,
      steps: enrichedTimeline.steps
    });
  } catch (_) {}

  // 9) “Panic” integration → Flow Saver Swap/Recover
  const panicHandler = async (e) => {
    const detail = e?.detail || {};
    if (detail?.sessionId !== sessionId) return;
    try {
      if (typeof runTemplate === "function") {
        await runTemplate("flow_saver_swap_recover_v1", {
          currentStep: detail.currentStep || enrichedTimeline.steps?.[detail.stepIndex || 0],
          inventory: detail.inventory || {},
          timeLeft: clamp(detail.timeLeft ?? 20, 5, 60),
          sessionId,
          recipeId,
          issue: detail.issue || "panic"
        }, {});
      }
    } catch (_) {}
  };
  window.addEventListener("flowsaver:panic", panicHandler);

  // 10) Feedback loop: disliked results auto-tune personalizer
  const feedbackHandler = async (e) => {
    const { recipeId: rid, liked, tweaks } = e.detail || {};
    if (rid !== recipeId || liked !== false) return;
    try {
      if (typeof runTemplate === "function") {
        await runTemplate("doneness_texture_personalizer_v1", {
          recipeId: rid,
          donenessPrefs: { ...(donenessPrefs || {}), ...(tweaks || {}) },
          stoveHeatBias
        });
      }
    } catch (_) {}
  };
  window.addEventListener("doneness:feedback", feedbackHandler);

  actions.push(
    { type: "OPEN_UI", route: "LiveCookingWalkthrough", params: navParams },
    ...(assistiveMode !== "touch" ? [{ type: "OPEN_UI", route: "VoiceStepNavigator", params: navParams }] : []),
    { type: "TIMERS_STARTED", count: timers.length, sessionId }
  );

  return {
    sessionId,
    timers,
    voicePrompts,
    plateUpTime,
    actions,
    message: template.success_message
  };
}

export default {
  template,
  execute
};
