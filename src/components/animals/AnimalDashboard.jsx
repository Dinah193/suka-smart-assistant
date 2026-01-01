// src/components/animals/AnimalDashboard.jsx

import React, { useEffect, useState } from "react";
import AnimalQueueManager from "../../managers/AnimalQueueManager";
import DexieDB from "../../db";

export default function AnimalDashboard() {
  const [animals, setAnimals] = useState([]);
  const [queues, setQueues] = useState({
    milking: [],
    butchering: [],
    health: [],
    feeding: [],
  });

  const fetchAnimalsAndQueues = async () => {
    const allAnimals = await DexieDB.animals.toArray();

    const milking = await AnimalQueueManager.getMilkingQueue();
    const butchering = await AnimalQueueManager.getButcheringQueue();
    const health = await AnimalQueueManager.getHealthCheckQueue();
    const feeding = await AnimalQueueManager.getFeedingQueue();

    setAnimals(allAnimals);
    setQueues({ milking, butchering, health, feeding });
  };

  const markTaskComplete = async (type, animalId) => {
    await AnimalQueueManager.removeAnimalFromQueue(type, animalId);
    fetchAnimalsAndQueues();
  };

  useEffect(() => {
    fetchAnimalsAndQueues();
  }, []);

  return (
    <div className="p-6 bg-stone-50 min-h-screen">
      <h1 className="text-3xl font-bold mb-6 text-amber-700">🐓 Animal Dashboard</h1>

      <section className="mb-8">
        <h2 className="text-xl font-semibold text-stone-800 mb-3">📋 Animal Inventory</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {animals.map((animal) => (
            <div
              key={animal.id}
              className="bg-white border border-stone-200 rounded p-4 shadow text-sm"
            >
              <p className="font-semibold text-stone-700">{animal.name}</p>
              <p className="text-stone-500">
                {animal.type} — {animal.status}
              </p>
              <p className="text-xs italic text-stone-400">
                Last Update: {new Date(animal.lastUpdated).toLocaleDateString()}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-stone-800 mb-3">📅 Task Queues</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {["milking", "butchering", "health", "feeding"].map((type) => (
            <div
              key={type}
              className="bg-white border border-stone-300 rounded shadow p-4"
            >
              <h3 className="text-md font-bold capitalize text-amber-600">
                {type} Queue
              </h3>
              {queues[type]?.length > 0 ? (
                <ul className="mt-2 text-sm text-stone-700 space-y-1">
                  {queues[type].map((animal) => (
                    <li
                      key={animal.id}
                      className="flex justify-between items-center border-b border-dashed py-1"
                    >
                      {animal.name}
                      <button
                        onClick={() => markTaskComplete(type, animal.id)}
                        className="text-green-600 hover:text-green-800 text-xs"
                      >
                        ✅ Done
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-stone-400 italic mt-2">No tasks</p>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
