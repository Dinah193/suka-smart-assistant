import React from "react";
import { X } from "lucide-react";

export default function AdvancedModal({ isOpen, onClose, title, children, width = "max-w-xl" }) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center px-4">
      <div className={`bg-white rounded-xl shadow-2xl w-full ${width} relative overflow-hidden`}>
        {/* Header */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-stone-200 bg-pink-600 text-white">
          <h2 className="text-lg font-bold">{title}</h2>
          <button onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">{children}</div>
      </div>
    </div>
  );
}
