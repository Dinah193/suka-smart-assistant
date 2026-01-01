// src/components/cooking/PrepTaskOptimizer.jsx
import React, { useEffect, useState } from "react";
import { useDrop, useDrag, DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { useTimerStore } from "@/store/MultiTimerStore";
import { useBatchQueueStore } from "@/store/BatchQueueStore";
import { extractPrepTasksFromRecipes } from "@/utils/extractPrepTasks";
import { Speaker, TimerReset } from "lucide-react";

const DraggableTask = ({ task, index, moveTask, onStepClick }) => {
  const [, ref] = useDrag({ type: "TASK", item: { index } });
  const [, drop] = useDrop({
    accept: "TASK",
    hover: (item) => {
      if (item.index !== index) {
        moveTask(item.index, index);
        item.index = index;
      }
    },
  });

  return (
    <div
      ref={(node) => ref(drop(node))}
      className="bg-orange-100 border border-orange-300 rounded px-4 py-2 mb-2 shadow-sm flex items-center justify-between"
    >
      <span>{task.label}</span>
      <div className="flex gap-2">
        <button onClick={() => speak(task.label)} className="text-orange-600 hover:text-orange-800">
          <Speaker size={18} />
        </button>
        <button
          onClick={() => onStepClick(task)}
          className="text-green-600 hover:text-green-800"
          title="Start Timer"
        >
          <TimerReset size={18} />
        </button>
      </div>
    </div>
  );
};

const speak = (text) => {
  if ("speechSynthesis" in window) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    window.speechSynthesis.speak(utterance);
  }
};

export default function PrepTaskOptimizer() {
  const { selectedRecipes } = useBatchQueueStore();
  const { createTimer, startTimer } = useTimerStore();

  const extracted = extractPrepTasksFromRecipes(selectedRecipes);
  const [tasks, setTasks] = useState(extracted);

  useEffect(() => {
    tasks.forEach((task) => {
      createTimer(task.id, task.label, task.estimatedTime * 60);
    });
  }, [tasks]);

  const moveTask = (fromIndex, toIndex) => {
    const updated = [...tasks];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    setTasks(updated);
  };

  const handleStepClick = (task) => {
    speak(`Starting task: ${task.label}`);
    startTimer(task.id);
  };

  return (
    <DndProvider backend={HTML5Backend}>
      <div className="p-5 bg-white border border-orange-300 rounded shadow-md">
        <h2 className="text-xl font-bold text-orange-700 mb-4">🧤 Prep Task Optimizer</h2>
        {tasks.length === 0 ? (
          <p className="text-stone-500 italic">No prep tasks yet. Select recipes first.</p>
        ) : (
          <div>
            {tasks.map((task, index) => (
              <DraggableTask
                key={task.id}
                task={task}
                index={index}
                moveTask={moveTask}
                onStepClick={handleStepClick}
              />
            ))}
          </div>
        )}
      </div>
    </DndProvider>
  );
}
