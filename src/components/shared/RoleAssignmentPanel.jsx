// src/components/shared/RoleAssignmentPanel.jsx

import React, { useState } from "react";
import { UserPlus, Users, ShieldCheck, ClipboardList } from "lucide-react";

const initialRoles = [
  { id: "cleaning", name: "Cleaning Coordinator", color: "bg-yellow-200" },
  { id: "cooking", name: "Meal Prep Manager", color: "bg-orange-200" },
  { id: "inventory", name: "Inventory Steward", color: "bg-lime-200" },
];

const sampleMembers = ["Imani", "Zion", "Nia", "Ezra"];

export default function RoleAssignmentPanel() {
  const [roles, setRoles] = useState(initialRoles);
  const [assignments, setAssignments] = useState({});
  const [newRole, setNewRole] = useState("");

  const handleAssign = (roleId, member) => {
    setAssignments((prev) => ({
      ...prev,
      [roleId]: member,
    }));
  };

  const handleAddRole = () => {
    if (!newRole.trim()) return;
    const newRoleObj = {
      id: newRole.toLowerCase().replace(/\s+/g, "-"),
      name: newRole,
      color: "bg-sky-200",
    };
    setRoles([...roles, newRoleObj]);
    setNewRole("");
  };

  return (
    <div className="p-6 bg-white border border-stone-300 rounded-xl shadow-md max-w-3xl">
      <h2 className="text-2xl font-bold mb-4 text-purple-700 flex items-center gap-2">
        <Users size={24} /> Household Role Assignment
      </h2>

      {/* Add New Role */}
      <div className="flex gap-2 mb-6">
        <input
          type="text"
          placeholder="Add custom role (e.g. Sabbath Setup)"
          value={newRole}
          onChange={(e) => setNewRole(e.target.value)}
          className="flex-1 border border-stone-300 px-3 py-2 rounded"
        />
        <button
          onClick={handleAddRole}
          className="bg-purple-500 hover:bg-purple-600 text-white px-4 py-2 rounded"
        >
          ➕ Add Role
        </button>
      </div>

      {/* Role Assignment Table */}
      <div className="grid gap-4">
        {roles.map((role) => (
          <div
            key={role.id}
            className={`p-4 rounded-lg border ${role.color} flex items-center justify-between`}
          >
            <div>
              <h3 className="font-semibold text-stone-800 flex items-center gap-2">
                <ShieldCheck size={18} /> {role.name}
              </h3>
              <p className="text-sm text-stone-600">
                Assigned to:{" "}
                <span className="font-medium text-stone-900">
                  {assignments[role.id] || "Not assigned"}
                </span>
              </p>
            </div>
            <select
              value={assignments[role.id] || ""}
              onChange={(e) => handleAssign(role.id, e.target.value)}
              className="border border-stone-300 px-3 py-1 rounded"
            >
              <option value="">-- Assign Member --</option>
              {sampleMembers.map((member) => (
                <option key={member} value={member}>
                  {member}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      {/* Note */}
      <div className="mt-6 p-4 text-sm bg-purple-100 border border-purple-300 rounded text-purple-800">
        <ClipboardList className="inline-block mr-2" size={16} />
        Assigned roles determine who receives cleaning/cooking alerts, reminders, and planner updates.
      </div>
    </div>
  );
}
