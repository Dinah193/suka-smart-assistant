import React, { useState } from "react";
import { PlusCircle, Trash2, Edit, Save } from "lucide-react";

export default function UserToolInventory() {
  const [tools, setTools] = useState([
    { id: 1, name: "Microfiber Mop", type: "Manual", category: "Floor", eco: true },
    { id: 2, name: "Steam Cleaner", type: "Electric", category: "Multi-surface", eco: true },
    { id: 3, name: "Dish Brush", type: "Manual", category: "Dishes", eco: false }
  ]);

  const [search, setSearch] = useState("");
  const [newTool, setNewTool] = useState({ name: "", type: "Manual", category: "", eco: false });
  const [editId, setEditId] = useState(null);

  const filteredTools = tools.filter((t) =>
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    t.category.toLowerCase().includes(search.toLowerCase())
  );

  const addTool = () => {
    if (!newTool.name || !newTool.category) return;
    setTools([...tools, { ...newTool, id: Date.now() }]);
    setNewTool({ name: "", type: "Manual", category: "", eco: false });
  };

  const deleteTool = (id) => setTools(tools.filter((t) => t.id !== id));

  const startEdit = (id) => setEditId(id);

  const saveEdit = () => setEditId(null);

  const updateTool = (id, field, value) => {
    const updated = tools.map((t) =>
      t.id === id ? { ...t, [field]: value } : t
    );
    setTools(updated);
  };

  return (
    <div className="p-6 bg-white rounded-xl shadow border border-blue-200">
      <h2 className="text-2xl font-bold text-blue-700 mb-4">🧰 User Tool Inventory</h2>

      <input
        type="text"
        placeholder="Search by name or category..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full px-4 py-2 border border-stone-300 rounded mb-4"
      />

      {/* New Tool Form */}
      <div className="grid md:grid-cols-5 gap-3 mb-6 items-center">
        <input
          type="text"
          placeholder="Tool name"
          value={newTool.name}
          onChange={(e) => setNewTool({ ...newTool, name: e.target.value })}
          className="border px-2 py-1 rounded"
        />
        <select
          value={newTool.type}
          onChange={(e) => setNewTool({ ...newTool, type: e.target.value })}
          className="border px-2 py-1 rounded"
        >
          <option>Manual</option>
          <option>Electric</option>
        </select>
        <input
          type="text"
          placeholder="Category"
          value={newTool.category}
          onChange={(e) => setNewTool({ ...newTool, category: e.target.value })}
          className="border px-2 py-1 rounded"
        />
        <label className="flex items-center gap-2 text-sm text-blue-800">
          <input
            type="checkbox"
            checked={newTool.eco}
            onChange={(e) => setNewTool({ ...newTool, eco: e.target.checked })}
          />
          ♻️ Eco
        </label>
        <button
          onClick={addTool}
          className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded flex items-center gap-2"
        >
          <PlusCircle size={18} /> Add Tool
        </button>
      </div>

      {/* Tool Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border border-blue-100">
          <thead className="bg-blue-100 text-blue-800">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th>Type</th>
              <th>Category</th>
              <th>Eco</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredTools.map((tool) => (
              <tr key={tool.id} className="border-t border-blue-100">
                <td className="px-4 py-2">
                  {editId === tool.id ? (
                    <input
                      value={tool.name}
                      onChange={(e) => updateTool(tool.id, "name", e.target.value)}
                      className="border px-2 py-1 rounded"
                    />
                  ) : tool.name}
                </td>
                <td>
                  {editId === tool.id ? (
                    <select
                      value={tool.type}
                      onChange={(e) => updateTool(tool.id, "type", e.target.value)}
                      className="border px-2 py-1 rounded"
                    >
                      <option>Manual</option>
                      <option>Electric</option>
                    </select>
                  ) : tool.type}
                </td>
                <td>
                  {editId === tool.id ? (
                    <input
                      value={tool.category}
                      onChange={(e) => updateTool(tool.id, "category", e.target.value)}
                      className="border px-2 py-1 rounded"
                    />
                  ) : tool.category}
                </td>
                <td className="text-center">{tool.eco ? "✅" : "—"}</td>
                <td className="flex gap-2 py-2">
                  {editId === tool.id ? (
                    <button
                      onClick={saveEdit}
                      className="text-blue-600 hover:text-blue-800"
                    >
                      <Save size={18} />
                    </button>
                  ) : (
                    <button
                      onClick={() => startEdit(tool.id)}
                      className="text-blue-600 hover:text-blue-800"
                    >
                      <Edit size={18} />
                    </button>
                  )}
                  <button
                    onClick={() => deleteTool(tool.id)}
                    className="text-red-500 hover:text-red-700"
                  >
                    <Trash2 size={18} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {filteredTools.length === 0 && (
          <p className="text-stone-400 italic text-center mt-4">No tools match your search.</p>
        )}
      </div>
    </div>
  );
}
