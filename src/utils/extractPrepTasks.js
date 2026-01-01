// src/utils/extractPrepTasks.js

/**
 * Dynamically extracts prep tasks from selected recipes.
 * @param {Array} recipes - List of recipe objects with prepSteps
 * @returns {Array} prepTasks - Flattened, labeled prep task objects
 */
export function extractPrepTasksFromRecipes(recipes = []) {
  const allPrep = recipes.flatMap((recipe) =>
    recipe.prepSteps?.map((step, idx) => ({
      id: `${recipe.id}-${step.id || idx}`, // Unique ID using recipe + step
      label: `[${recipe.name}] ${step.label}`, // For clear context
      estimatedTime: step.estimatedTime || 2,  // Default time fallback
      recipeId: recipe.id,
      originalStep: step,
    })) || []
  );
  return allPrep;
}
