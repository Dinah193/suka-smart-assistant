import React, { useState, useMemo } from "react";
import { Timer } from "lucide-react";
import isEqual from "lodash.isequal";
import { useDeepCompareEffect } from "../../hooks/useDeepCompareEffect";

export default function BatchSessionPlanner({
  selectedRecipes = [],
  scaledSteps = [],
  storageIntentMap = {},
  toolInventory = [],
  inventoryStatus = {},
  timers = {},
  completedSteps = [],
  onStepComplete,
}) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [steps, setSteps] = useState([]);
  const [timer, setTimer] = useState(0);
  const [isRunning, setIsRunning] = useState(false);

  const constructedSteps = useMemo(() => {
    const collected = [];
    const source = scaledSteps.length ? scaledSteps : selectedRecipes;

    source.forEach((recipe) => {
      recipe.steps?.forEach((step) => {
        collected.push({
          recipeId: recipe.id,
          recipeName: recipe.name,
          description: step.description || step,
          estimatedTime: step.estimatedTime || 5,
          toolHint: step.toolHint || null,
        });
      });
    });

    return collected;
  }, [selectedRecipes, scaledSteps]);

  useDeepCompareEffect(() => {
    if (!isEqual(steps, constructedSteps)) {
      setSteps(constructedSteps);
      setCurrentStepIndex(0);
      setIsRunning(false);
      setTimer(0);
    }
  }, [constructedSteps]);

  React.useEffect(() => {
    let interval;
    if (isRunning && timer > 0) {
      interval = setInterval(() => {
        setTimer((t) => t - 1);
      }, 1000);
    } else if (isRunning && timer === 0) {
      speak("Step complete.");
      setIsRunning(false);
      if (steps[currentStepIndex]) {
        onStepComplete?.(steps[currentStepIndex]);
      }
    }
    return () => clearInterval(interval);
  }, [isRunning, timer, currentStepIndex, steps, onStepComplete]);

  const speak = (text) => {
    if ("speechSynthesis" in window) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      window.speechSynthesis.speak(utterance);
    }
  };

  const startNextStep = () => {
    if (currentStepIndex >= steps.length) return;
    const step = steps[currentStepIndex];

    const toolNote = step.toolHint
      ? toolInventory.find((tool) =>
          step.toolHint?.toLowerCase().includes(tool.name.toLowerCase())
        )
        ? `Use your ${step.toolHint}`
        : `You may need ${step.toolHint}, which isn't in your current tools.`
      : "";

    speak(`Starting step ${currentStepIndex + 1}: ${step.description}. ${toolNote}`);
    setTimer(step.estimatedTime * 60);
    setIsRunning(true);
  };

  const skipStep = () => {
    setIsRunning(false);
    setTimer(0);
    setCurrentStepIndex((i) => i + 1);
  };

  const completeStep = () => {
    setIsRunning(false);
    setTimer(0);
    onStepComplete?.(steps[currentStepIndex]);
    setCurrentStepIndex((i) => i + 1);
  };

  if (currentStepIndex >= steps.length) {
    return (
      <div className="p-6 text-green-700 font-semibold">
        🎉 All steps completed!
        <p className="text-stone-500 text-sm mt-2">
          Stored meals:{" "}
          {
            Object.entries(storageIntentMap)
              .filter(([_, intent]) => intent === "store" || intent === "partial").length
          }{" "}
          recipes will be added to your inventory.
        </p>
      </div>
    );
  }

  const step = steps[currentStepIndex];

  return (
    <div className="bg-rose-50 p-6 border border-rose-300 rounded-xl space-y-4 shadow-lg">
      <h2 className="text-2xl font-bold text-rose-700">🍽 Live Cooking Walkthrough</h2>
      <p className="text-lg text-rose-800 font-medium">
        {step.recipeName} - Step {currentStepIndex + 1} of {steps.length}
      </p>
      <p className="text-stone-700 text-md border-l-4 pl-4 border-rose-400 italic">
        {step.description}
      </p>
      {step.toolHint && (
        <p className="text-sm text-stone-500">
          Suggested tool:{" "}
          <span className="font-semibold text-indigo-600">{step.toolHint}</span>
        </p>
      )}
      <div className="flex items-center gap-4 mt-3">
        <Timer className="text-rose-600" />
        <span className="text-stone-800 font-semibold">
          ⏱ {Math.floor(timer / 60)}:{String(timer % 60).padStart(2, "0")} min
        </span>
      </div>

      <div className="flex gap-3 flex-wrap">
        {!isRunning && (
          <button
            onClick={startNextStep}
            className="bg-pink-600 hover:bg-pink-700 text-white px-4 py-2 rounded"
          >
            ▶️ Start Step
          </button>
        )}
        {isRunning && (
          <button
            onClick={() => setIsRunning(false)}
            className="bg-yellow-500 hover:bg-yellow-600 text-white px-4 py-2 rounded"
          >
            ⏸ Pause
          </button>
        )}
        {!isRunning && timer > 0 && (
          <button
            onClick={() => setIsRunning(true)}
            className="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded"
          >
            🔁 Resume
          </button>
        )}
        <button
          onClick={completeStep}
          className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded"
        >
          ✅ Complete Step
        </button>
        <button
          onClick={skipStep}
          className="bg-stone-400 hover:bg-stone-500 text-white px-4 py-2 rounded"
        >
          ⏩ Skip
        </button>
      </div>
    </div>
  );
}
