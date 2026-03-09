// src/components/cooking/PrepStepsList.jsx
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { CheckCircle, GripVertical, Volume2 } from "lucide-react";
import { DndProvider, useDrag, useDrop } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";

/**
 * Props:
 * - selectedRecipes: array of recipes [{ id, name, ingredients: [], instructions: [] }]
 * - onReorder (optional): callback when steps are reordered
 */
export default function PrepStepsList({
  selectedRecipes = [],
  onReorder = () => {},
}) {
  const [checked, setChecked] = useState([]);
  const [items, setItems] = useState([]);

  useEffect(() => {
    const parsedSteps = [];

    selectedRecipes.forEach((recipe) => {
      recipe.ingredients?.forEach((ing, i) =>
        parsedSteps.push({
          id: `${recipe.id}-ing-${i}`,
          label: `Prep ingredient: ${ing}`,
        })
      );

      recipe.instructions?.forEach((inst, j) =>
        parsedSteps.push({
          id: `${recipe.id}-inst-${j}`,
          label: `Step: ${inst}`,
        })
      );
    });

    setItems(parsedSteps);
  }, [selectedRecipes]);

  const toggleCheck = (id) => {
    setChecked((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  const speakStep = (text) => {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "en-US";
    utter.pitch = 1;
    utter.rate = 1;
    speechSynthesis.speak(utter);
  };

  const moveItem = useCallback(
    (fromIndex, toIndex) => {
      if (fromIndex === toIndex) return;

      setItems((prev) => {
        const next = Array.from(prev);
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        try {
          onReorder(next);
        } catch {}
        return next;
      });
    },
    [onReorder]
  );

  return (
    <DndProvider backend={HTML5Backend}>
      <div className="p-4 bg-orange-50 border border-orange-200 rounded-xl shadow">
        <h2 className="text-xl font-bold text-orange-700 mb-3">
          🧠 Prep Steps & Instructions
        </h2>

        <ul className="space-y-3">
          {items.map((step, index) => (
            <PrepStepRow
              key={step.id}
              step={step}
              index={index}
              checked={checked.includes(step.id)}
              onToggle={() => toggleCheck(step.id)}
              onSpeak={() => speakStep(step.label)}
              moveItem={moveItem}
            />
          ))}
        </ul>
      </div>
    </DndProvider>
  );
}

/* ------------------------------ DnD row item ------------------------------ */
const DND_TYPE = "PREP_STEP_ROW";

function PrepStepRow({ step, index, checked, onToggle, onSpeak, moveItem }) {
  const ref = React.useRef(null);

  const [, drop] = useDrop(
    () => ({
      accept: DND_TYPE,
      hover: (item, monitor) => {
        if (!ref.current) return;

        const dragIndex = item.index;
        const hoverIndex = index;

        if (dragIndex === hoverIndex) return;

        const hoverRect = ref.current.getBoundingClientRect();
        const hoverMiddleY = (hoverRect.bottom - hoverRect.top) / 2;

        const clientOffset = monitor.getClientOffset();
        if (!clientOffset) return;

        const hoverClientY = clientOffset.y - hoverRect.top;

        // Only move when crossing half of the item's height (classic dnd behavior)
        if (dragIndex < hoverIndex && hoverClientY < hoverMiddleY) return;
        if (dragIndex > hoverIndex && hoverClientY > hoverMiddleY) return;

        moveItem(dragIndex, hoverIndex);
        item.index = hoverIndex;
      },
    }),
    [index, moveItem]
  );

  const [{ isDragging }, drag] = useDrag(
    () => ({
      type: DND_TYPE,
      item: { id: step.id, index },
      collect: (monitor) => ({
        isDragging: monitor.isDragging(),
      }),
    }),
    [step.id, index]
  );

  drag(drop(ref));

  return (
    <li
      ref={ref}
      className={`p-3 flex items-center justify-between rounded border shadow transition-all ${
        checked ? "bg-green-100 border-green-300" : "bg-white border-orange-300"
      } ${isDragging ? "opacity-70" : ""}`}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <GripVertical size={18} className="text-orange-400" />
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className="text-sm text-stone-800 truncate">{step.label}</span>
      </div>

      <button
        onClick={onSpeak}
        className="text-orange-500 hover:text-orange-700"
        title="Read aloud"
        type="button"
      >
        <Volume2 size={18} />
      </button>

      {checked && <CheckCircle size={18} className="text-green-600" />}
    </li>
  );
}
