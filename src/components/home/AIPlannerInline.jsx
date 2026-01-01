// src/components/home/AIPlannerInline.jsx
import React, { useEffect, useRef } from "react";
import { useVision } from "@/context/VisionContext";
import { callLLM } from "@/agents/base/AgentCore";
import { automation } from "@/services/automation/runtime";

// Stable signature so we only run when the vision actually changes
const signatureOf = (v) =>
  JSON.stringify({
    goals: v?.goals ?? "",
    constraints: v?.constraints ?? "",
    timePerWeek: v?.timePerWeek ?? 0,
    budget: v?.budget ?? "",
    dietary: v?.dietary ?? "",
  });

export default function AIPlannerInline() {
  const { vision } = useVision();
  const lastSigRef = useRef("");
  const debounceRef = useRef(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    // Only run when the user has actually saved some goals
    if (!vision || !vision.goals) return;

    const sig = signatureOf(vision);
    if (sig === lastSigRef.current) return; // no-change guard

    // Debounce to avoid thrashing during rapid edits
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      lastSigRef.current = sig;

      try {
        const prompt = [
          {
            role: "system",
            content:
              "You are Suka's background household planner. Respond with compact JSON only (no prose). Keys you may include: calendarBlocks, shoppingFocus, preservation, cleaning, cookingHabits.",
          },
          {
            role: "user",
            content: JSON.stringify({
              goals: vision.goals,
              constraints: vision.constraints,
              timePerWeek: vision.timePerWeek,
              budget: vision.budget,
              dietary: vision.dietary,
            }),
          },
        ];

        const res = await callLLM(prompt, { temperature: 0.3, max_tokens: 800 });
        const raw = typeof res === "string" ? res : res?.content ?? "{}";

        let plan;
        try {
          plan = JSON.parse(raw);
        } catch {
          // If the model returned markdown or text, pass it through as a note
          plan = { note: raw };
        }

        // Prefer the runtime if present; otherwise broadcast an event the app can listen to
        if (automation?.runPlan) {
          await automation.runPlan(plan, { source: "vision", controlLevel: 3 });
        } else if (automation?.emit) {
          automation.emit("event", { type: "vision:auto-plan", payload: plan });
        } else {
          window.dispatchEvent(new CustomEvent("vision:auto-plan", { detail: { plan } }));
        }
      } catch {
        // Silent fail; the next change will retry
      } finally {
        inFlightRef.current = false;
      }
    }, 400);

    return () => clearTimeout(debounceRef.current);
  }, [vision]);

  return null; // runs in the background; no UI
}
