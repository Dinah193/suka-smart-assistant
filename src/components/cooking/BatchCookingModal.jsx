import React, { useState } from "react";
import AdvancedModal from "@/components/ui/AdvancedModal";

export default function BatchCookingModal({ isOpen, onClose }) {
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState({
    recipeName: "",
    servings: 1,
    includeTimer: false,
  });

  const handleNext = () => setStep((s) => s + 1);
  const handleBack = () => setStep((s) => s - 1);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : value,
    }));
  };

  return (
    <AdvancedModal isOpen={isOpen} onClose={onClose} title="Batch Cooking Setup">
      {step === 1 && (
        <>
          <label className="block">
            Recipe Name:
            <input
              type="text"
              name="recipeName"
              value={formData.recipeName}
              onChange={handleChange}
              className="mt-1 block w-full border rounded px-3 py-2"
            />
          </label>

          <label className="block">
            Servings:
            <input
              type="number"
              name="servings"
              value={formData.servings}
              onChange={handleChange}
              className="mt-1 block w-full border rounded px-3 py-2"
            />
          </label>

          <label className="flex items-center gap-2 mt-3">
            <input
              type="checkbox"
              name="includeTimer"
              checked={formData.includeTimer}
              onChange={handleChange}
            />
            Add Cooking Timer
          </label>

          <div className="flex justify-between mt-4">
            <button
              onClick={onClose}
              className="bg-gray-300 text-black px-4 py-2 rounded"
            >
              Cancel
            </button>
            <button
              onClick={handleNext}
              className="bg-pink-600 text-white px-4 py-2 rounded"
            >
              Next
            </button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <p className="text-sm">
            Ready to start batch cooking: <strong>{formData.recipeName}</strong> for{" "}
            <strong>{formData.servings}</strong> servings?
          </p>

          {formData.includeTimer && (
            <p className="text-pink-600 font-semibold">Timers will be included in the session.</p>
          )}

          <div className="flex justify-between mt-4">
            <button
              onClick={handleBack}
              className="bg-gray-300 text-black px-4 py-2 rounded"
            >
              Back
            </button>
            <button
              onClick={() => {
                // Submit logic here (save to DB, trigger batch session, etc.)
                onClose();
              }}
              className="bg-green-600 text-white px-4 py-2 rounded"
            >
              Start Cooking
            </button>
          </div>
        </>
      )}
    </AdvancedModal>
  );
}
