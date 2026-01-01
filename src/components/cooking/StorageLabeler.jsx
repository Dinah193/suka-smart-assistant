// src/components/cooking/StorageLabeler.jsx

import React, { useRef, useState } from "react";
import { useReactToPrint } from "react-to-print";
import { X, Printer } from "lucide-react";

export default function StorageLabeler({ item, onClose }) {
  const labelRef = useRef();
  const [formData, setFormData] = useState({
    storageLocation: "Freezer",
    method: "Pressure Canned",
    expiration: "",
    batchId: `BATCH-${Date.now()}`,
  });

  const handlePrint = useReactToPrint({
    content: () => labelRef.current,
  });

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handlePrintClick = () => {
    handlePrint();
    if (onClose) onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-30 z-50 flex items-center justify-center">
      <div className="bg-white w-full max-w-lg p-6 rounded-lg shadow-xl border-2 border-green-600">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-green-700">🏷 Print Storage Label</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-black">
            <X size={24} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Storage Type</label>
            <select
              name="storageLocation"
              value={formData.storageLocation}
              onChange={handleChange}
              className="w-full border border-gray-300 rounded px-3 py-2"
            >
              <option>Freezer</option>
              <option>Root Cellar</option>
              <option>Shelf</option>
              <option>Refrigerator</option>
              <option>Fermentation Room</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Processing Method</label>
            <select
              name="method"
              value={formData.method}
              onChange={handleChange}
              className="w-full border border-gray-300 rounded px-3 py-2"
            >
              <option>Pressure Canned</option>
              <option>Water Bath Canned</option>
              <option>Fermented</option>
              <option>Dehydrated</option>
              <option>Smoked</option>
              <option>Fresh</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Expiration Date</label>
            <input
              type="date"
              name="expiration"
              value={formData.expiration}
              onChange={handleChange}
              className="w-full border border-gray-300 rounded px-3 py-2"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Batch ID</label>
            <input
              type="text"
              name="batchId"
              value={formData.batchId}
              onChange={handleChange}
              className="w-full border border-gray-300 rounded px-3 py-2"
            />
          </div>

          <div className="flex justify-end">
            <button
              onClick={handlePrintClick}
              className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 flex items-center gap-2"
            >
              <Printer size={18} /> Print Label
            </button>
          </div>
        </div>

        {/* Hidden Printable Area */}
        <div className="hidden print:block">
          <div ref={labelRef} className="p-6 text-black text-lg font-sans">
            <div className="border border-black p-4 w-72">
              <div className="font-bold text-xl mb-2">{item?.name || "Food Item"}</div>
              <div>Storage: {formData.storageLocation}</div>
              <div>Processed: {formData.method}</div>
              <div>Expires: {formData.expiration}</div>
              <div>Batch ID: {formData.batchId}</div>
              <div>Date: {new Date().toLocaleDateString()}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
