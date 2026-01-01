import React, { useState, useEffect } from "react";
import { CheckCircle, GripVertical, Volume2 } from "lucide-react";
import { DragDropContext, Droppable, Draggable } from "react-beautiful-dnd";

/**
 * Props:
 * - selectedRecipes: array of recipes [{ id, name, ingredients: [], instructions: [] }]
 * - onReorder (optional): callback when steps are reordered
 */
export default function PrepStepsList({ selectedRecipes = [], onReorder = () => {} }) {
  const [checked, setChecked] = useState([]);
  const [items, setItems] = useState([]);

  useEffect(() => {
    const parsedSteps = [];

    selectedRecipes.forEach((recipe) => {
      recipe.ingredients?.forEach((ing, i) =>
        parsedSteps.push({
          id: `${recipe.id}-ing-${i}`,
          label: `Prep ingredient: ${ing}`
        })
      );

      recipe.instructions?.forEach((inst, j) =>
        parsedSteps.push({
          id: `${recipe.id}-inst-${j}`,
          label: `Step: ${inst}`
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

  const handleDragEnd = (result) => {
    if (!result.destination) return;

    const newItems = Array.from(items);
    const [moved] = newItems.splice(result.source.index, 1);
    newItems.splice(result.destination.index, 0, moved);

    setItems(newItems);
    onReorder(newItems);
  };

  return (
    <div className="p-4 bg-orange-50 border border-orange-200 rounded-xl shadow">
      <h2 className="text-xl font-bold text-orange-700 mb-3">🧠 Prep Steps & Instructions</h2>

      <DragDropContext onDragEnd={handleDragEnd}>
        <Droppable droppableId="prepSteps">
          {(provided) => (
            <ul
              className="space-y-3"
              {...provided.droppableProps}
              ref={provided.innerRef}
            >
              {items.map((step, index) => (
                <Draggable key={step.id} draggableId={step.id} index={index}>
                  {(provided) => (
                    <li
                      ref={provided.innerRef}
                      {...provided.draggableProps}
                      {...provided.dragHandleProps}
                      className={`p-3 flex items-center justify-between rounded border ${
                        checked.includes(step.id)
                          ? "bg-green-100 border-green-300"
                          : "bg-white border-orange-300"
                      } shadow transition-all`}
                    >
                      <div className="flex items-center gap-3 flex-1">
                        <GripVertical size={18} className="text-orange-400" />
                        <input
                          type="checkbox"
                          checked={checked.includes(step.id)}
                          onChange={() => toggleCheck(step.id)}
                        />
                        <span className="text-sm text-stone-800">{step.label}</span>
                      </div>

                      <button
                        onClick={() => speakStep(step.label)}
                        className="text-orange-500 hover:text-orange-700"
                        title="Read aloud"
                      >
                        <Volume2 size={18} />
                      </button>

                      {checked.includes(step.id) && (
                        <CheckCircle size={18} className="text-green-600" />
                      )}
                    </li>
                  )}
                </Draggable>
              ))}
              {provided.placeholder}
            </ul>
          )}
        </Droppable>
      </DragDropContext>
    </div>
  );
}
