import React, { useState, useEffect } from "react";
import { Play, Pause, Volume2, VolumeX } from "lucide-react";

export default function BatchCookingWalkthrough({ batchSteps = [], onFinish }) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [remainingTime, setRemainingTime] = useState(batchSteps[0]?.duration || 0);
  const [voiceOn, setVoiceOn] = useState(true);

  const currentStep = batchSteps[currentStepIndex];

  useEffect(() => {
    if (isPlaying && remainingTime > 0) {
      const timer = setTimeout(() => setRemainingTime((t) => t - 1), 1000);
      return () => clearTimeout(timer);
    } else if (isPlaying && remainingTime === 0) {
      nextStep();
    }
  }, [isPlaying, remainingTime]);

  useEffect(() => {
    if (voiceOn && currentStep?.label) {
      const utterance = new SpeechSynthesisUtterance(currentStep.label);
      speechSynthesis.speak(utterance);
    }
  }, [currentStepIndex, voiceOn]);

  const nextStep = () => {
    if (currentStepIndex < batchSteps.length - 1) {
      setCurrentStepIndex(currentStepIndex + 1);
      setRemainingTime(batchSteps[currentStepIndex + 1].duration);
    } else {
      setIsPlaying(false);
      onFinish && onFinish();
    }
  };

  const togglePlay = () => setIsPlaying(!isPlaying);
  const toggleVoice = () => setVoiceOn((v) => !v);

  return (
    <div className="p-6 border border-green-300 rounded-lg shadow bg-green-50">
      <h2 className="text-2xl font-bold text-green-700 mb-4">🍲 Batch Cooking Walkthrough</h2>

      {currentStep ? (
        <div className="space-y-4">
          <div className="text-xl font-semibold text-green-800">{currentStep.label}</div>

          <div className="text-sm text-stone-600">
            Estimated Time: {currentStep.duration} seconds
          </div>

          <div className="text-3xl font-mono text-center text-green-900">
            ⏱ {remainingTime}s
          </div>

          <div className="flex gap-4 justify-center">
            <button
              onClick={togglePlay}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded"
            >
              {isPlaying ? <Pause size={18} /> : <Play size={18} />}
              {isPlaying ? "Pause" : "Start"}
            </button>
            <button
              onClick={toggleVoice}
              className={`flex items-center gap-2 ${
                voiceOn ? "bg-yellow-500" : "bg-stone-400"
              } text-white px-4 py-2 rounded`}
            >
              {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
              Voice {voiceOn ? "On" : "Off"}
            </button>
          </div>
        </div>
      ) : (
        <div className="text-stone-600">✅ All cooking steps completed!</div>
      )}
    </div>
  );
}
