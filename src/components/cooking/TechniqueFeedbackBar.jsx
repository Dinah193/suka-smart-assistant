// src/components/cooking/TechniqueFeedbackBar.jsx
import React, { useEffect, useMemo, useState } from "react";
import { automation } from "@/services/automation/runtime";
import { CookingPrefsStore } from "@/store/CookingPrefsStore";
import { learnFromFeedback, buildChecklist } from "@/agents/cookingStylesAgent";

/**
 * TechniqueFeedbackBar v2
 * - Raised horizontal card for quick post-cook feedback
 * - Works standalone or receives runtime deltas from timers (deltasFromRun)
 *
 * Props:
 *  - cuisine: string (required)
 *  - dish?: string
 *  - variant?: "orthodox" | "house" | "quick" (default "house")
 *  - compact?: boolean (smaller layout)
 *  - deltasFromRun?: object (e.g., { searSecondsPlus: true, restTimePlus: true })
 *  - onSubmitted?: (payload) => void
 *  - showSliderNudges?: boolean (default true) — inline taste sliders
 *  - dataForChecklist?: object (optional plan data to show “what we just cooked” popover)
 */

export default function TechniqueFeedbackBar({
  cuisine,
  dish = "",
  variant = "house",
  compact = false,
  deltasFromRun = null,
  onSubmitted,
  showSliderNudges = true,
  dataForChecklist = null,
}) {
  const [rating, setRating] = useState(4);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // read sliders from store and stay in sync
  const [sliders, setSliders] = useState(CookingPrefsStore.get().sliders);
  useEffect(() => CookingPrefsStore.subscribe((s) => setSliders(s.sliders)), []);

  // quick delta toggles (users often tweak these)
  const [deltas, setDeltas] = useState({
    searSecondsPlus: false,
    braiseTimePlus: false,
    restTimePlus: false,
    smokeMore: false,
    pressureCook: false,
  });

  // merge runtime deltas (e.g., timers captured user extending a timer)
  useEffect(() => {
    if (!deltasFromRun) return;
    setDeltas((d) => ({ ...d, ...deltasFromRun }));
  }, [deltasFromRun]);

  const checklist = useMemo(() => {
    if (!dataForChecklist) return null;
    try {
      return buildChecklist(dataForChecklist, variant);
    } catch {
      return null;
    }
  }, [dataForChecklist, variant]);

  async function submit() {
    if (!cuisine) return;
    setSubmitting(true);

    // assemble final deltas payload
    const finalDeltas = { ...deltas };
    // Inline slider “nudges” become deltas too for learning transparency
    // (UI edits sliders live via store; we send intent here for agent heuristics)
    finalDeltas.sliderSnapshot = { ...sliders };

    // Emit a UI event for analytics/automation
    automation.emit("ui/feedbackSubmit", {
      cuisine,
      dish,
      rating,
      variant,
      deltas: finalDeltas,
      notes,
      ts: new Date().toISOString(),
    });

    // send to agent learning loop
    await learnFromFeedback({
      cuisine,
      dish,
      rating,
      notes,
      chosenVariant: variant,
      deltas: finalDeltas,
    });

    // tiny UX polish: optimistic toast via automation (your toast system can subscribe)
    automation.emit("toast/show", {
      kind: "success",
      title: "Saved",
      message: "Thanks! We tuned your house style and taste sliders.",
    });

    setNotes("");
    setSubmitting(false);
    onSubmitted?.({ cuisine, dish, rating, variant, deltas: finalDeltas });
  }

  function setDelta(key, val) {
    setDeltas((d) => ({ ...d, [key]: typeof val === "boolean" ? val : !d[key] }));
  }

  function NudgeSlider({ k, label }) {
    return (
      <div className="flex items-center gap-2">
        <span className="w-20 text-sm">{label}</span>
        <input
          type="range"
          min="0"
          max="100"
          value={sliders[k]}
          onChange={(e) => CookingPrefsStore.setSliders({ [k]: Number(e.target.value) })}
          className="range range-xs flex-1"
          aria-label={`${label} preference`}
        />
        <span className="w-8 text-xs text-right">{sliders[k]}</span>
      </div>
    );
  }

  return (
    <div
      className={[
        "w-full rounded-2xl shadow-lg border border-base-200",
        "bg-base-100/90 backdrop-blur",
        compact ? "p-3" : "p-4",
      ].join(" ")}
    >
      <div className="flex flex-col md:flex-row md:items-center gap-3">
        {/* Left: Rating */}
        <div className="flex items-center gap-2">
          <span className="font-semibold">How did it turn out?</span>
          <StarRating value={rating} onChange={setRating} />
        </div>

        {/* Middle: Quick texture deltas */}
        <div className="flex flex-wrap items-center gap-2 md:ml-4">
          <QuickChip
            label="More browning"
            active={deltas.searSecondsPlus}
            onClick={() => setDelta("searSecondsPlus")}
            title="We seared longer / want more crust next time"
          />
          <QuickChip
            label="Softer/tender"
            active={deltas.braiseTimePlus || deltas.restTimePlus}
            onClick={() => {
              setDelta("braiseTimePlus", true);
              setDelta("restTimePlus", true);
            }}
            title="We braised/rested longer / prefer softer texture"
          />
          <QuickChip
            label="Smokier"
            active={deltas.smokeMore}
            onClick={() => setDelta("smokeMore")}
            title="Prefer stronger smoke/char notes"
          />
          <QuickChip
            label="Pressure-cooked"
            active={deltas.pressureCook}
            onClick={() => setDelta("pressureCook")}
            title="We used a pressure cooker or want that option"
          />
          {checklist && (
            <details className="dropdown">
              <summary className="btn btn-ghost btn-xs">What we cooked</summary>
              <div className="p-3 mt-2 w-80 card card-compact bg-base-200 shadow">
                <h4 className="font-medium mb-2">Steps</h4>
                <ul className="space-y-1 max-h-60 overflow-auto pr-1">
                  {checklist.map((row) => (
                    <li key={row.idx} className="text-xs">
                      <span className="font-semibold mr-1">{row.idx}.</span>
                      {row.label}
                      {row.duration ? <span className="opacity-70"> &nbsp;• {row.duration}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          )}
        </div>

        {/* Right: Notes + Submit */}
        <div className="flex-1 flex items-center gap-2 md:justify-end md:ml-auto">
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Brief note (e.g., 'a bit drier', 'want silkier sauce')"
            className="input input-bordered input-sm w-full md:w-80"
            maxLength={140}
          />
          <button
            className={`btn btn-sm btn-primary rounded-xl ${submitting ? "loading" : ""}`}
            onClick={submit}
            disabled={submitting || !cuisine}
            title="Save feedback & learn"
          >
            {submitting ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {/* Inline taste sliders (optional) */}
      {showSliderNudges && (
        <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
          <NudgeSlider k="doneness" label="Doneness" />
          <NudgeSlider k="softness" label="Softness" />
          <NudgeSlider k="browning" label="Browning" />
          <NudgeSlider k="smokiness" label="Smokiness" />
          <NudgeSlider k="sourness" label="Sourness" />
          <NudgeSlider k="chiliHeat" label="Chili Heat" />
        </div>
      )}

      {/* Footer: small hint */}
      <div className="mt-2 text-xs opacity-70 flex items-center gap-2">
        <kbd className="kbd kbd-xs">1–5</kbd> set rating &middot; <kbd className="kbd kbd-xs">Enter</kbd> save
      </div>
    </div>
  );
}

/* ----------------------------- Subcomponents ----------------------------- */

function StarRating({ value, onChange }) {
  // keyboard: 1–5
  useEffect(() => {
    const handler = (e) => {
      if (["1", "2", "3", "4", "5"].includes(e.key)) onChange?.(Number(e.key));
      if (e.key === "Enter") {
        // fire a synthetic click on the Save button if present
        const btn = document.querySelector('[title="Save feedback & learn"]');
        if (btn) btn.click();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onChange]);

  return (
    <div className="rating rating-sm">
      {[1, 2, 3, 4, 5].map((n) => (
        <input
          key={n}
          type="radio"
          name="rating"
          className="mask mask-star-2 bg-yellow-400"
          checked={value === n}
          onChange={() => onChange(n)}
          aria-label={`${n} star${n === 1 ? "" : "s"}`}
        />
      ))}
    </div>
  );
}

function QuickChip({ label, active, onClick, title }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={[
        "px-3 py-1 rounded-full text-xs transition-all",
        "border",
        active
          ? "bg-primary text-primary-content border-primary shadow"
          : "bg-base-100 border-base-300 hover:bg-base-200",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
