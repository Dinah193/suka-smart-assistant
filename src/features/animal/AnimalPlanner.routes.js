// C:\Users\larho\suka-smart-assistant\src\features\animal\AnimalPlanner.routes.js
// -----------------------------------------------------------------------------
// Route configuration for the Animal Planner feature.
//
// How this fits:
//
// - Exposes a small, composable route config for the Animal Planner UI.
// - Designed to be merged into your app-wide <Routes> tree in App.jsx or a
//   feature router aggregator.
// - The actual “Now” CTA + SessionRunner integration lives in
//   AnimalPlanner.view.jsx (via eventBus + session.requestNext), so this file
//   stays focused on wiring URLs to views.
// -----------------------------------------------------------------------------

import React from "react";
import { Navigate } from "react-router-dom";
import AnimalPlannerView from "./AnimalPlanner.view.jsx";

/**
 * Base route path for the Animal Planner feature.
 * Use this when constructing links or navigation items.
 *
 * @type {string}
 */
export const animalPlannerRouteBase = "/animals/planner";

/**
 * Route definitions for the Animal Planner.
 *
 * Typical integration in App.jsx (or a feature router):
 *
 *   import { animalPlannerRoutes } from "@/features/animal/AnimalPlanner.routes";
 *
 *   // inside <Routes>...
 *   {animalPlannerRoutes.map((r) => (
 *     <Route key={r.path} path={r.path} element={r.element} />
 *   ))}
 *
 * @type {Array<{
 *   path: string;
 *   element: React.ReactElement;
 * }>}
 */
export const animalPlannerRoutes = [
  {
    // Primary Animal Planner page:
    // - Shows the AnimalPlannerView with planning cards, feed/butchery logic,
    //   and a “Now” CTA that emits session.requestNext for animal tasks.
    path: animalPlannerRouteBase,
    element: <AnimalPlannerView />
  },
  {
    // Soft redirect to keep /animals alive as a friendly entry point.
    // If you already have a top-level animals dashboard, you can remove this
    // and link to animalPlannerRouteBase from that page instead.
    path: "/animals",
    element: <Navigate to={animalPlannerRouteBase} replace />
  }
];

/**
 * Helper to merge Animal Planner routes into an existing route list.
 *
 * This is optional, but convenient if you have a feature-based router
 * that builds a flat list of route objects before rendering <Routes>.
 *
 * Example:
 *   import { registerAnimalPlannerRoutes } from "@/features/animal/AnimalPlanner.routes";
 *
 *   const coreRoutes = [...];
 *   const allRoutes = registerAnimalPlannerRoutes(coreRoutes);
 *
 *   <Routes>
 *     {allRoutes.map((r) => (
 *       <Route key={r.path} path={r.path} element={r.element} />
 *     ))}
 *   </Routes>
 *
 * @param {Array<{ path: string; element: React.ReactElement }>} existingRoutes
 * @returns {Array<{ path: string; element: React.ReactElement }>}
 */
export function registerAnimalPlannerRoutes(existingRoutes = []) {
  if (!Array.isArray(existingRoutes)) {
    // Defensive: don’t blow up the app if someone passes something odd.
    console.warn(
      "[AnimalPlanner.routes] registerAnimalPlannerRoutes expected an array, got:",
      typeof existingRoutes
    );
    return [...animalPlannerRoutes];
  }

  return [...existingRoutes, ...animalPlannerRoutes];
}
