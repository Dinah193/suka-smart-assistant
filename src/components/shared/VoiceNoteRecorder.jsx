// src/components/shared/VoiceNoteRecorder.jsx

import React, { useState, useRef } from "react";
import { Mic, StopCircle, PlayCircle, Save, Trash2 } from "lucide-react";

export default function VoiceNoteRecorder({ onSave }) {
  const [recording, setRecording] = useState(false);
  const [audioURL, setAudioURL] = useState(null);
  const [mediaRecorder, setMediaRecorder] = useState(null);
  const audioChunks = useRef([]);

  const startRecording = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => audioChunks.current.push(e.data);
    recorder.onstop = () => {
      const audioBlob = new Blob(audioChunks.current, { type: "audio/wav" });
      const url = URL.createObjectURL(audioBlob);
      setAudioURL(url);
      if (onSave) onSave(audioBlob); // Optional callback for parent
    };

    audioChunks.current = [];
    recorder.start();
    setMediaRecorder(recorder);
    setRecording(true);
  };

  const stopRecording = () => {
    if (mediaRecorder) {
      mediaRecorder.stop();
      setRecording(false);
    }
  };

  const deleteRecording = () => {
    setAudioURL(null);
    audioChunks.current = [];
    setMediaRecorder(null);
  };

  return (
    <div className="bg-white border border-stone-300 p-4 rounded-lg shadow max-w-md">
      <h3 className="text-lg font-semibold text-stone-700 mb-3 flex items-center gap-2">
        <Mic size={20} /> Voice Note Recorder
      </h3>

      {!recording && !audioURL && (
        <button
          onClick={startRecording}
          className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded flex items-center gap-2"
        >
          <Mic size={18} /> Start Recording
        </button>
      )}

      {recording && (
        <button
          onClick={stopRecording}
          className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded flex items-center gap-2"
        >
          <StopCircle size={18} /> Stop Recording
        </button>
      )}

      {audioURL && !recording && (
        <div className="mt-4 space-y-2">
          <audio controls src={audioURL} className="w-full" />
          <div className="flex gap-3">
            <a
              href={audioURL}
              download="voice-note.wav"
              className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded flex items-center gap-1"
            >
              <Save size={16} /> Save
            </a>
            <button
              onClick={deleteRecording}
              className="text-red-500 hover:text-red-700 flex items-center gap-1"
            >
              <Trash2 size={16} /> Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
