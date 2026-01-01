// src/pages/agentPlanner.jsx
import React, { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";

// Core & registries
import { callLLM } from "@/agents/base/AgentCore"; // your existing core
// These two exist in your repo per screenshot; fall back safely if APIs differ.
let agentRegistry = {};
let templatesIndex = [];

async function safeLoadRegistries() {
  try {
    const mod = await import("@/services/automation/agentRegistry");
    agentRegistry = mod.agentRegistry || mod.default || {};
  } catch {}
  try {
    // your auto-register already walks /services/templates and exports a list
    const mod = await import("@/services/automation/autoRegisterTemplates");
    const getter = mod.getTemplates || mod.getAllTemplates || mod.default;
    templatesIndex = (typeof getter === "function" ? getter() : getter) || [];
  } catch {}
}

export default function AgentPlanner() {
  const [loaded, setLoaded] = useState(false);
  const [raw, setRaw] = useState("");
  const [agentId, setAgentId] = useState("");
  const [templateId, setTemplateId] = useState(""); // optional
  const [controlLevel, setControlLevel] = useState(2); // 1 = gentle tips … 4 = fully automated
  const [plan, setPlan] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    safeLoadRegistries().finally(() => setLoaded(true));
  }, []);

  const agentOptions = useMemo(() => Object.keys(agentRegistry || {}), [loaded]);
  const templateOptions = useMemo(
    () =>
      (templatesIndex || []).map((t) => ({
        id: t.id || t.key || t.name,
        label: t.title || t.name || t.id,
        forAgents: t.forAgents || t.tags || [],
      })),
    [loaded]
  );

  // lightweight auto-suggest for template based on text + chosen agent
  function autoSuggestTemplate(text, chosenAgent) {
    const lower = (text || "").toLowerCase();
    const candidates = templateOptions.filter(
      (t) =>
        !t.forAgents.length || t.forAgents.includes(chosenAgent)
    );

    const score = (t) => {
      const L = `${t.label}`.toLowerCase();
      let s = 0;
      if (chosenAgent && t.forAgents.includes(chosenAgent)) s += 3;
      if (lower.includes("harvest") && L.includes("harvest")) s += 2;
      if (lower.includes("preserv") && L.includes("preserv")) s += 2;
      if (lower.includes("soil") && L.includes("soil")) s += 2;
      if (lower.includes("irrig") && L.includes("water")) s += 2;
      if (lower.includes("cook") && L.includes("cook")) s += 2;
      if (lower.includes("clean") && L.includes("clean")) s += 2;
      if (lower.includes("animal") && L.includes("breed")) s += 2;
      if (lower.includes("compost") && L.includes("compost")) s += 2;
      return s;
    };

    const best = candidates
      .map((t) => ({ ...t, _s: score(t) }))
      .sort((a, b) => b._s - a._s)[0];
    return best?.id || "";
  }

  async function handleGenerate() {
    setBusy(true);
    setError("");
    setPlan("");

    try {
      const chosenTemplate =
        templateId || autoSuggestTemplate(raw, agentId) || "AUTO";

      // Graceful prompt—uses your existing Agents + Templates language
      const prompt = `
You are the Suka Smart Assistant.

Context:
- Agents available: ${agentOptions.join(", ")}
- Templates available: ${templateOptions.map(t=>t.label).join(", ")}

User freeform request (raw thoughts/desires):
"""${raw}"""

Chosen agent: ${agentId || "AUTO-SELECT"}
Chosen template: ${chosenTemplate}
Control level (1–4):
${controlLevel} 
  1 = tips only, no scheduling
  2 = make a plan with suggested tasks & times
  3 = make a plan + schedule tentative items and reminders
  4 = fully automate: schedule, emit inventory updates, and notify

Output:
- A concise title
- A 5–10 step plan with checkable items (bulleted)
- Any inventory deltas or procurement suggestions
- Calendar block suggestions with ISO start/end (if control >= 2)
- Agent handoffs (which manager or agent to call next)
- “Why this sequence works” (2–4 bullets)
- Fallbacks if something is missing or time is short
- Friendly tone; align with the user’s preferences when possible.
      `;

      const res = await callLLM(prompt, {
        model: "gpt-4",
        temperature: 0.4,
        max_tokens: 1400,
      });

      setPlan(typeof res === "string" ? res : JSON.stringify(res, null, 2));
    } catch (e) {
      console.error(e);
      setError("I couldn’t generate a plan just now. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSchedule() {
    // optional: try to hand off to your automation runtime if present
    try {
      const mod = await import("@/services/automation/runtime");
      const runner = mod.runPlan || mod.applyPlan || mod.runtime || null;
      if (runner) {
        await runner(plan, {
          controlLevel,
          requestedAt: dayjs().toISOString(),
        });
        alert("Scheduled! Check Calendar / Reminders.");
      } else {
        alert("Runtime not found. Saved the plan text only.");
      }
    } catch {
      alert("Could not access automation runtime. Saved the plan text only.");
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <h1 className="text-2xl font-bold">AI Planner (Tell me what you want)</h1>

      <textarea
        className="w-full p-4 border rounded-xl bg-white/70"
        placeholder="Example: “I want to stop wasting tomatoes, can you time my harvests and set up dehydrating & canning weekends? Also remind me to rotate the compost.”"
        rows={6}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="space-y-2">
          <label className="text-sm font-semibold">Agent</label>
          <select
            className="w-full p-2 border rounded-xl"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          >
            <option value="">Auto-select</option>
            {agentOptions.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-semibold">Template (optional)</label>
          <select
            className="w-full p-2 border rounded-xl"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
          >
            <option value="">Auto-suggest</option>
            {templateOptions.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-semibold">
            Control Level: {controlLevel}
          </label>
          <input
            type="range"
            min={1}
            max={4}
            value={controlLevel}
            onChange={(e) => setControlLevel(Number(e.target.value))}
            className="w-full"
          />
          <p className="text-xs text-gray-600">
            1: tips • 2: plan • 3: plan + tentative schedule • 4: fully automate
          </p>
        </div>
      </div>

      <div className="flex gap-3">
        <button onClick={handleGenerate} disabled={busy} className="btn btn-primary">
          {busy ? "Thinking…" : "Generate Plan"}
        </button>
        <button onClick={handleSchedule} disabled={!plan} className="btn btn-outline">
          Schedule / Apply
        </button>
      </div>

      {error && <div className="text-red-600">{error}</div>}

      {plan && (
        <div className="p-4 border rounded-xl bg-white/70 whitespace-pre-wrap">
          {plan}
        </div>
      )}
    </div>
  );
}
