// src/pages/mealplanner/index.jsx
// -----------------------------------------------------------------------------
// IMPORTANT:
// App.jsx lazy-loads Meal Planner from multiple candidate paths.
// If the first candidate fails for any reason (casing, merge conflict, export
// mismatch), Vite will fall back to this file.
//
// To guarantee the Meal Planner always renders the *intended* SV-styled page,
// this file simply re-exports the canonical implementation.
// -----------------------------------------------------------------------------

export { default } from "./mealplanner.jsx";
