import React, { useState, useEffect, useRef } from "react";
import {
  Mic,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  SkipForward,
  SkipBack,
} from "lucide-react";
import { createTimer, startTimer } from "@/store/MultiTimerManager"; // Zustand timer store
import { parseStepWithTimer } from "@/utils/stepTimerHelper"; // keyword/time extractor

export default function VoiceStepNavigator({ steps = [] }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const synth = window.speechSynthesis;
  const recognitionRef = useRef(null);
  const [enhancedSteps, setEnhancedSteps] = useState([]);

  const speak = (text) => {
    if (synth.speaking) synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => setIsSpeaking(false);
    synth.speak(utterance);
    setIsSpeaking(true);
  };

  const processSteps = (stepsRaw = []) => {
    const result = [];

    stepsRaw.forEach((step, i) => {
      const { timer, preStep } = parseStepWithTimer(step.instruction);
      if (preStep) {
        const preId = `pre-${i}-${Date.now()}`;
        createTimer(preId, preStep.label, preStep.duration);
        result.push({
          instruction: preStep.label,
          timerId: preId,
        });
      }

      if (timer) {
        const id = `timer-${i}-${Date.now()}`;
        createTimer(id, step.instruction, timer.duration);
        result.push({
          instruction: step.instruction,
          timerId: id,
        });
      } else {
        result.push({
          instruction: step.instruction,
        });
      }
    });

    setEnhancedSteps(result);
  };

  useEffect(() => {
    processSteps(steps);
  }, [steps]);

  const currentStep = enhancedSteps[currentIndex];

  const handleVoiceCommand = (command) => {
    switch (command.toLowerCase()) {
      case "next":
        goToNextStep();
        break;
      case "previous":
      case "back":
        goToPreviousStep();
        break;
      case "repeat":
        speak(currentStep?.instruction);
        break;
      case "pause":
        synth.pause();
        break;
      case "resume":
        synth.resume();
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.lang = "en-US";
      recognition.interimResults = false;

      recognition.onresult = (event) => {
        const transcript =
          event.results[event.results.length - 1][0].transcript.trim();
        handleVoiceCommand(transcript);
      };

      recognition.onerror = (err) => {
        console.error("Voice recognition error:", err);
      };

      recognitionRef.current = recognition;
      recognition.start();

      return () => recognition.stop();
    }
  }, [currentIndex, enhancedSteps]);

  const goToNextStep = () => {
    if (currentIndex < enhancedSteps.length - 1) {
      const next = currentIndex + 1;
      setCurrentIndex(next);
      speak(enhancedSteps[next].instruction);
      if (enhancedSteps[next].timerId) {
        startTimer(enhancedSteps[next].timerId);
      }
    }
  };

  const goToPreviousStep = () => {
    if (currentIndex > 0) {
      const prev = currentIndex - 1;
      setCurrentIndex(prev);
      speak(enhancedSteps[prev].instruction);
    }
  };

  const repeatStep = () => {
    speak(currentStep?.instruction);
  };

  return (
    <div className="p-4 bg-orange-50 border border-orange-300 rounded-lg shadow w-full max-w-xl mx-auto">
      <h2 className="text-lg font-bold mb-3 text-orange-700 flex items-center gap-2">
        <Mic size={20} /> Voice Step Navigator
      </h2>

      {currentStep ? (
        <div className="space-y-4">
          <div className="p-4 bg-white border rounded shadow text-lg text-gray-800 font-medium">
            {currentStep.instruction}
          </div>

          <div className="flex justify-center gap-4">
            <button
              onClick={goToPreviousStep}
              className="bg-orange-200 p-2 rounded-full hover:bg-orange-300"
              title="Previous Step"
            >
              <SkipBack size={20} />
            </button>
            <button
              onClick={repeatStep}
              className="bg-orange-200 p-2 rounded-full hover:bg-orange-300"
              title="Repeat Step"
            >
              <RotateCcw size={20} />
            </button>
            {isSpeaking ? (
              <button
                onClick={() => synth.pause()}
                className="bg-orange-500 text-white p-2 rounded-full hover:bg-orange-600"
                title="Pause"
              >
                <PauseCircle size={24} />
              </button>
            ) : (
              <button
                onClick={() => speak(currentStep.instruction)}
                className="bg-green-600 text-white p-2 rounded-full hover:bg-green-700"
                title="Speak"
              >
                <PlayCircle size={24} />
              </button>
            )}
            <button
              onClick={goToNextStep}
              className="bg-orange-200 p-2 rounded-full hover:bg-orange-300"
              title="Next Step"
            >
              <SkipForward size={20} />
            </button>
          </div>
        </div>
      ) : (
        <p className="text-gray-500 italic">No steps loaded.</p>
      )}
    </div>
  );
}
