// src/services/templates/flowSaverSwapRecover.js

import { createTimer, startTimer, removeTimer } from "@/store/MultiTimerManager";
import * as timeUtils from "@/utils/timeUtils";
import * as inventoryUtils from "@/utils/inventoryUtils";

/**
 * Contract-compliant template metadata
 */
export const template = {
  id: "flow_saver_swap_recover_v2",
  version: "2.3.0",
  purpose: "If something burns/spills, instantly pivot with safe, calm guidance and keep dinner on time.",
  triggers: ["ui::panic", "voice::help_its_burning", "ui::LiveCookingWalkthrough.panic"],
  inputs: {
    // currentStep: { text, duration?:sec, startAtSec?:sec }
    // inventory: snapshot or utility-backed { items: { name->qty } }
    // timeLeft: minutes remaining until target plate-up
    required: ["currentStep", "inventory", "timeLeft"],
    optional: ["sessionId", "recipeId", "issue"] // 'burn'|'spill'|'overcook'|'smoke'|'fire'...
  },
  logic: {
    selectors: [
      "inventoryUtils.getSnapshot() when inventory missing",
      "Heuristics choose: safety → sauce rescue → side swap",
      "Compress revised steps to fit remaining window"
    ],
    rules: [
      "If fire/smoke → safety sequence (lid → heat off → baking soda; never water on grease).",
      "If pan sauce/scorch → lift, transfer, strain, rebalance (and taste check).",
      "If side ruined/time tight → pivot to 5–10 min pantry side; keep plate on schedule.",
      "Cancel old timers and start new synchronized timers with calm labels.",
      "Emit visible draft update so UI can show what changed."
    ],
    llm_roles: []
  },
  actions: [
    "CANCEL_TIMERS",
    "OPEN_UI",              // optional: patch walkthrough panel
    "PATCH_WALKTHROUGH",    // planTitle + revised steps
    "START_TIMER",
    "NOTIFY",               // toast/inbox heads-up
    "LOG_EVENT"             // analytics/event stream
  ],
  outputs: {
    ui: [],
    data: ["revisedSteps", "calmingPrompt", "path", "compressedToMin"],
    alerts: []
  },
  fallbacks: [
    "If beyond rescue → run Quick Suggest (#1) with remaining time."
  ],
  success_message: "I’ve set a safe recovery path and updated your timers.",
  used_by: ["cookingAgent"]
};

/* ----------------- Helpers ----------------- */

// Best-effort: remove timers created with `${sessionId}_${i}` ids
function cancelSessionTimers(sessionId, max = 64) {
  if (!sessionId) return;
  for (let i = 0; i < max; i++) {
    try { removeTimer(`${sessionId}_${i}`); } catch {}
  }
}

// Start timers directly from step objects: [{ text, calmText, duration:sec, startAtSec }]
function startFromSteps(steps = [], { label = "Flow Saver", sessionId } = {}) {
  const sid = sessionId || `flow_${Date.now()}`;
  const planned = [];

  let cursor = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {};
    const startAtSec = Number.isFinite(s.startAtSec) ? Math.max(0, s.startAtSec) : cursor;
    const durationSec = Math.max(1, Math.round(Number(s.duration ?? 60)));
    const id = `${sid}_${i}`;
    const lbl = (s.calmText || s.text || `Step ${i + 1}`).slice(0, 80);

    createTimer(id, lbl, durationSec);
    setTimeout(() => startTimer(id), Math.max(0, startAtSec) * 1000);

    planned.push({ id, label: lbl, startAtSec, durationSec });
    cursor = startAtSec + durationSec;
  }

  return { timers: planned, sessionId: sid };
}

// Very light presence check
function hasAny(inv, names = []) {
  const snap = inv?.items ? inv.items : inv;
  const keys = Object.keys(snap || {}).map((k) => k.toLowerCase());
  return names.some((n) => keys.includes(String(n).toLowerCase()));
}

function pickQuickSide(inv, timeLeftMin = 12) {
  // priority order tuned to speed + universality; respect super-tight windows
  if (hasAny(inv, ["microwave rice", "ready rice"]) && timeLeftMin <= 6) {
    return { title: "Heat microwave rice", estMinutes: 2, steps: ["Microwave per packet; fluff and serve."] };
  }
  if (hasAny(inv, ["couscous"])) {
    return {
      title: "Make quick couscous",
      estMinutes: 6,
      steps: [
        "Boil water (1 cup per 1 cup couscous).",
        "Stir in couscous with pinch of salt; cover off heat 5 min.",
        "Fluff with fork; add olive oil/butter if you like."
      ]
    };
  }
  if (hasAny(inv, ["eggs", "bread"])) {
    return {
      title: "Toast + soft-scrambled eggs",
      estMinutes: 7,
      steps: ["Toast bread.", "Low heat: scramble eggs until just creamy.", "Season and plate."]
    };
  }
  if (hasAny(inv, ["canned beans", "black beans", "chickpeas"])) {
    return {
      title: "Warm seasoned beans",
      estMinutes: 8,
      steps: ["Rinse (if salted). Warm gently with a splash of water.", "Salt, pepper, olive oil; optional garlic/chili."]
    };
  }
  if (hasAny(inv, ["lettuce", "greens"])) {
    return {
      title: "Simple dressed greens",
      estMinutes: 5,
      steps: ["Toss greens with olive oil, vinegar/lemon, and salt.", "Add any seeds/nuts if you have them."]
    };
  }
  return {
    title: "Butter noodles",
    estMinutes: Math.min(10, Math.max(6, timeLeftMin)),
    steps: ["Boil pasta until al dente.", "Toss with butter/olive oil, salt; optional cheese."]
  };
}

function buildSauceRescue() {
  return {
    title: "Sauce rescue",
    estMinutes: 6,
    steps: [
      "Remove pan from heat immediately.",
      "Transfer salvageable contents to a clean pan; avoid any black bits.",
      "Deglaze with water/stock; simmer briefly and strain.",
      "Rebalance with a small knob of butter or a splash of acid.",
      "Taste; if smoky/bitter remains, discard and pivot to a quick side."
    ],
    voice: "No stress—lift the pan off heat. Move the good bits to a clean pan, deglaze, strain, then rebalance."
  };
}

function buildSafetyStop() {
  return {
    title: "Safety first",
    estMinutes: 2,
    steps: [
      "If flames: slide a lid over the pan and turn the heat OFF.",
      "Smother with baking soda if needed. NEVER use water on grease.",
      "Leave the lid on until the pan is fully cool and smoking stops."
    ],
    voice: "We’re safe first: lid on, heat off. Use baking soda if needed—never water on grease."
  };
}

// Heuristic detection
function detectPath({ currentStep = {}, issue = "", timeLeft = 20 }) {
  const t = String(currentStep.text || "").toLowerCase();
  const prob = String(issue || "").toLowerCase();

  // explicit safety
  if (/fire|flame/.test(prob) || /flame|grease fire/.test(t)) return "safety_stop";
  if (/smoke/.test(prob) && /grease|fry|sear|pan/.test(t)) return "safety_stop";

  const sauceLike =
    /sauce|reduce|pan|fond|deglaze|gravy|glaze/.test(t) ||
    /sear|brown/.test(t) ||
    /burn|scorch|smoke/.test(prob);

  const preferSideSwap = (!sauceLike && timeLeft <= 15) || /spill|dropped|overflow/.test(prob) || /overcook|mushy/.test(prob);

  if (sauceLike && !preferSideSwap) return "sauce_rescue";
  return "side_swap";
}

// Convert simple plan into step objects for timers
function toStepObjects(plan, baseStart = 0) {
  const steps = [];
  let cursor = baseStart;
  for (const s of plan.steps) {
    // estimate 45–120 sec per instruction line (word length heuristic)
    const words = String(s).split(/\s+/).length;
    const est = Math.max(45, Math.min(120, words * 3));
    steps.push({ text: s, calmText: s, duration: est, startAtSec: cursor });
    cursor += est;
  }
  return steps;
}

// Compress or stretch to a target window (in minutes)
function fitToWindow(stepObjs, windowMin) {
  const target = Math.max(2, Math.round(windowMin * 60));
  const total = stepObjs.reduce((a, s) => a + (s.duration || 0), 0);
  if (total <= 0) return { steps: stepObjs, compressed: 0 };

  // Only compress; we rarely stretch during recovery
  const factor = Math.min(1, target / total);
  if (factor === 1) return { steps: stepObjs, compressed: 0 };

  let cursor = 0;
  const fitted = stepObjs.map((s) => {
    const newDur = Math.max(15, Math.round((s.duration || 30) * factor));
    const out = { ...s, duration: newDur, startAtSec: cursor };
    cursor += newDur;
    return out;
  });

  return { steps: fitted, compressed: Math.round((1 - factor) * 100) };
}

/* ----------------- Execute ----------------- */

/**
 * Execute the template.
 * @param {Object} payload
 * @param {{text:string, duration?:number, startAtSec?:number}} payload.currentStep
 * @param {Object} payload.inventory
 * @param {number} payload.timeLeft  // minutes
 * @param {string} [payload.sessionId]
 * @param {string} [payload.recipeId]
 * @param {string} [payload.issue]   // 'burn' | 'spill' | 'overcook' | 'smoke' | 'fire' ...
 * @param {Object} [ctx]             // { openUI?, runTemplate? }
 * @returns {Promise<{ok:boolean, revisedSteps:Array, calmingPrompt:string, path:string, compressedToMin:number, message:string, actions:Array}>}
 */
export async function execute(payload, ctx = {}) {
  const {
    currentStep,
    inventory,
    timeLeft,
    sessionId,
    recipeId,
    issue
  } = payload || {};

  if (!currentStep || typeof timeLeft !== "number") {
    throw new Error("flowSaver: missing currentStep or timeLeft.");
  }

  // Normalize inventory if needed
  const inv = inventory?.items || inventory ? inventory : (inventoryUtils.getSnapshot?.() || {});

  // Decide recovery path
  const path = detectPath({ currentStep, issue, timeLeft });

  let plan;
  if (path === "safety_stop") {
    plan = buildSafetyStop();
  } else if (path === "sauce_rescue") {
    plan = buildSauceRescue();
  } else {
    const side = pickQuickSide(inv, timeLeft);
    // If the quick side exceeds remaining time by a lot → try the backup flow (#1)
    if (side.estMinutes > Math.max(10, timeLeft) && typeof ctx?.runTemplate === "function") {
      try {
        const qs = await ctx.runTemplate("quick_suggest_dinner_v1", { timeAvailable: Math.max(10, timeLeft) });
        // Surface backup option to UI
        try {
          window.dispatchEvent(new CustomEvent("flowsaver:backup", { detail: { sessionId, recipeId, picks: qs?.picks || [] } }));
        } catch {}
        return {
          ok: true,
          revisedSteps: [],
          calmingPrompt: "Breathing—let’s pivot to a fast backup. I’ve suggested a few options that fit your time.",
          path: "backup_suggest",
          compressedToMin: 0,
          message: "Switched to backup meal suggestions.",
          actions: [{ type: "NOTIFY", channel: "toast", title: "Backup ready", body: "Quick suggestions are in your tray.", tags: ["flowsaver"] }]
        };
      } catch {
        // fall through to simplest side swap anyway
      }
    }
    plan = { title: side.title, estMinutes: side.estMinutes, steps: side.steps,
      voice: "No problem—we’ll pivot to a quick side so dinner still lands on time. I’ll guide you step by step." };
  }

  // Prepare revised step objects → fit to remaining window
  const rawSteps = toStepObjects(plan, 0);
  const { steps: fitted, compressed } = fitToWindow(rawSteps, Math.max(2, timeLeft));

  // Update active session + timers (best-effort)
  let timers = [];
  try {
    cancelSessionTimers(sessionId);
    const started = startFromSteps(fitted, {
      label: `Flow Saver — ${plan.title}`,
      sessionId
    });
    timers = started.timers;

    // Patch walkthrough
    try {
      window.dispatchEvent(new CustomEvent("flowsaver:update", {
        detail: { sessionId, recipeId, planTitle: plan.title, revisedSteps: fitted, timers, path }
      }));
    } catch {}

    // Portion/label note
    try {
      window.dispatchEvent(new CustomEvent("session:adjustPortions", {
        detail: { sessionId, note: path === "sauce_rescue" ? "Sauce rescued; portions unchanged."
                       : path === "safety_stop" ? "Paused for safety; resuming with simplified path."
                       : "Side swapped—labels updated for serving notes." }
      }));
    } catch {}
  } catch {
    // Non-fatal: UI can still consume revisedSteps
  }

  const calmingPrompt =
    plan.voice ||
    "It’s okay. I’ve set a quick recovery—follow my lead and we’ll plate calmly.";

  const actions = [
    { type: "CANCEL_TIMERS", sessionId },
    { type: "PATCH_WALKTHROUGH", sessionId, recipeId, planTitle: plan.title, path, steps: fitted, draft: false },
    { type: "START_TIMER", sessionId, label: `Flow Saver — ${plan.title}`, steps: fitted },
    { type: "NOTIFY", channel: "toast", title: plan.title, body: "Recovery steps are live. You’ve got this. 💪", tags: ["flowsaver"] },
    { type: "LOG_EVENT", name: "flowsaver_invoked", props: { path, compressedPct: compressed, timeLeftMin: timeLeft } }
  ];

  return {
    ok: true,
    revisedSteps: fitted,
    calmingPrompt,
    path,
    compressedToMin: compressed,
    message: template.success_message,
    actions
  };
}

export default {
  template,
  execute
};
