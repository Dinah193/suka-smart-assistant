import React, { useState } from "react";
import { PlusCircle, Trash2, Edit, Save } from "lucide-react";

export default function SupplyInventoryTracker() {
  const [inventory, setInventory] = useState([
    { id: 1, name: "Baking Soda", quantity: 2, unit: "cups", category: "Cleaning", eco: true },
    { id: 2, name: "Olive Oil", quantity: 1, unit: "bottle", category: "Cooking", eco: false }
  ]);

  const [search, setSearch] = useState("");
  const [newItem, setNewItem] = useState({ name: "", quantity: "", unit: "", category: "", eco: false });
  const [editId, setEditId] = useState(null);

  const filteredInventory = inventory.filter((item) =>
    item.name.toLowerCase().includes(search.toLowerCase()) ||
    item.category.toLowerCase().includes(search.toLowerCase())
  );

  const handleAdd = () => {
    if (!newItem.name || !newItem.quantity || !newItem.unit || !newItem.category) return;
    setInventory([
      ...inventory,
      { ...newItem, id: Date.now() }
    ]);
    setNewItem({ name: "", quantity: "", unit: "", category: "", eco: false });
  };

  const handleDelete = (id) => {
    setInventory(inventory.filter(item => item.id !== id));
  };

  const handleEdit = (id) => {
    setEditId(id);
  };

  const handleSave = (id) => {
    setEditId(null);
  };

  const handleUpdate = (id, field, value) => {
    const updated = inventory.map(item =>
      item.id === id ? { ...item, [field]: value } : item
    );
    setInventory(updated);
  };

  return (
    <div className="p-6 bg-white rounded-xl shadow border border-green-200">
      <h2 className="text-2xl font-bold text-green-700 mb-4">🧺 Supply Inventory Tracker</h2>

      <input
        type="text"
        placeholder="Search by name or category..."
        className="mb-4 w-full px-4 py-2 border border-stone-300 rounded"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {/* Add new item */}
      <div className="grid md:grid-cols-5 gap-3 mb-4 items-center">
        <input
          type="text"
          placeholder="Item name"
          value={newItem.name}
          onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
          className="border px-2 py-1 rounded"
        />
        <input
          type="number"
          placeholder="Qty"
          value={newItem.quantity}
          onChange={(e) => setNewItem({ ...newItem, quantity: e.target.value })}
          className="border px-2 py-1 rounded"
        />
        <input
          type="text"
          placeholder="Unit (e.g. cups)"
          value={newItem.unit}
          onChange={(e) => setNewItem({ ...newItem, unit: e.target.value })}
          className="border px-2 py-1 rounded"
        />
        <input
          type="text"
          placeholder="Category"
          value={newItem.category}
          onChange={(e) => setNewItem({ ...newItem, category: e.target.value })}
          className="border px-2 py-1 rounded"
        />
        <label className="flex items-center gap-2 text-sm text-green-800">
          <input
            type="checkbox"
            checked={newItem.eco}
            onChange={(e) => setNewItem({ ...newItem, eco: e.target.checked })}
          />
          ♻️ Eco
        </label>
        <button
          className="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded flex items-center gap-2"
          onClick={handleAdd}
        >
          <PlusCircle size={18} /> Add
        </button>
      </div>

      {/* Inventory list */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border border-green-100">
          <thead className="bg-green-100 text-green-800">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th>Qty</th>
              <th>Unit</th>
              <th>Category</th>
              <th>Eco</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredInventory.map((item) => (
              <tr key={item.id} className="border-t border-green-100">
                <td className="px-4 py-2">
                  {editId === item.id ? (
                    <input
                      value={item.name}
                      onChange={(e) => handleUpdate(item.id, "name", e.target.value)}
                      className="border px-2 py-1 rounded"
                    />
                  ) : item.name}
                </td>
                <td>
                  {editId === item.id ? (
                    <input
                      type="number"
                      value={item.quantity}
                      onChange={(e) => handleUpdate(item.id, "quantity", e.target.value)}
                      className="border px-2 py-1 rounded w-20"
                    />
                  ) : item.quantity}
                </td>
                <td>
                  {editId === item.id ? (
                    <input
                      value={item.unit}
                      onChange={(e) => handleUpdate(item.id, "unit", e.target.value)}
                      className="border px-2 py-1 rounded w-20"
                    />
                  ) : item.unit}
                </td>
                <td>
                  {editId === item.id ? (
                    <input
                      value={item.category}
                      onChange={(e) => handleUpdate(item.id, "category", e.target.value)}
                      className="border px-2 py-1 rounded"
                    />
                  ) : item.category}
                </td>
                <td className="text-center">
                  {item.eco ? "✅" : "—"}
                </td>
                <td className="flex gap-2 py-2">
                  {editId === item.id ? (
                    <button onClick={() => handleSave(item.id)} className="text-green-600 hover:text-green-800">
                      <Save size={18} />
                    </button>
                  ) : (
                    <button onClick={() => handleEdit(item.id)} className="text-blue-600 hover:text-blue-800">
                      <Edit size={18} />
                    </button>
                  )}
                  <button onClick={() => handleDelete(item.id)} className="text-red-500 hover:text-red-700">
                    <Trash2 size={18} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredInventory.length === 0 && (
          <p className="text-stone-400 italic mt-4 text-center">No items match your search.</p>
        )}
      </div>
    </div>
  );
}
