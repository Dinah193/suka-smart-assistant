// src/components/worker/RoleTaskBoard.jsx

import React, { useEffect, useState } from "react";
import WorkerTasks from "../../managers/WorkerTasks";
import { DndProvider, useDrag, useDrop } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";

const ItemType = "TASK";

const TaskCard = ({ task }) => {
  const [{ isDragging }, drag] = useDrag(() => ({
    type: ItemType,
    item: { task },
    collect: (monitor) => ({
      isDragging: !!monitor.isDragging(),
    }),
  }));

  return (
    <div
      ref={drag}
      className={`p-2 mb-2 rounded shadow cursor-move bg-white border ${
        isDragging ? "opacity-50" : ""
      }`}
    >
      <p className="text-sm font-bold">{task.name}</p>
      <p className="text-xs text-gray-600">{task.task}</p>
      <span className="text-xs italic text-blue-500">{task.recommendedRole}</span>
    </div>
  );
};

const RoleColumn = ({ role, tasks, onDrop }) => {
  const [{ isOver }, drop] = useDrop(() => ({
    accept: ItemType,
    drop: (item) => onDrop(item.task, role),
    collect: (monitor) => ({
      isOver: !!monitor.isOver(),
    }),
  }));

  return (
    <div
      ref={drop}
      className={`flex-1 p-4 border rounded min-h-[300px] ${
        isOver ? "bg-green-100" : "bg-gray-100"
      }`}
    >
      <h2 className="text-lg font-semibold mb-3 text-center">{role}</h2>
      {tasks.map((task, i) => (
        <TaskCard key={i} task={task} />
      ))}
    </div>
  );
};

export default function RoleTaskBoard() {
  const [allTasks, setAllTasks] = useState([]);
  const [assigned, setAssigned] = useState({});

  const roles = ["butcher", "milker", "gardener", "farm hand", "scheduler", "general"];

  const fetchTasks = async () => {
    const unassigned = await WorkerTasks.generateAllUnassignedTasks();
    const assignedTasks = await WorkerTasks.getAssignedTasks();

    const grouped = roles.reduce((acc, role) => {
      acc[role] = assignedTasks.filter((t) => t.role === role);
      return acc;
    }, {});

    setAllTasks(unassigned);
    setAssigned(grouped);
  };

  const handleAssign = async (task, role) => {
    await WorkerTasks.assignTaskToWorker({
      taskId: task.id,
      task,
      role,
      assignedTo: null, // Manual assignment by role only
    });
    fetchTasks();
  };

  useEffect(() => {
    fetchTasks();
  }, []);

  return (
    <DndProvider backend={HTML5Backend}>
      <div className="p-6 bg-stone-50 min-h-screen">
        <h1 className="text-3xl font-bold text-stone-800 mb-6">🧰 Role Task Board</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          <div className="p-4 bg-white border rounded shadow">
            <h2 className="text-xl font-semibold mb-3">📋 Unassigned Tasks</h2>
            {allTasks.map((task, i) => (
              <TaskCard key={i} task={task} />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-4">
            {roles.map((role) => (
              <RoleColumn
                key={role}
                role={role}
                tasks={assigned[role] || []}
                onDrop={handleAssign}
              />
            ))}
          </div>
        </div>
      </div>
    </DndProvider>
  );
}
