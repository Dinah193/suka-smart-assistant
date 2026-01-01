// src/utils/syncStorage.js

export const getSharedPlans = (userId) => {
  const plans = JSON.parse(localStorage.getItem("sharedPlans") || "[]");
  return plans.filter(plan =>
    plan.visibility === "public" || plan.sharedWith?.includes(userId)
  );
};

export const saveSharedPlan = (newPlan) => {
  const plans = JSON.parse(localStorage.getItem("sharedPlans") || "[]");
  localStorage.setItem("sharedPlans", JSON.stringify([...plans, newPlan]));
};

export const getGardenPlans = () => {
  return JSON.parse(localStorage.getItem("gardenPlans") || "[]");
};

export const saveGardenPlan = (plot) => {
  const plots = JSON.parse(localStorage.getItem("gardenPlans") || "[]");
  localStorage.setItem("gardenPlans", JSON.stringify([...plots, plot]));
};

export const getAnimalPlans = () => {
  return JSON.parse(localStorage.getItem("animalPlans") || "[]");
};

export const saveAnimalPlan = (animalPlan) => {
  const plans = JSON.parse(localStorage.getItem("animalPlans") || "[]");
  localStorage.setItem("animalPlans", JSON.stringify([...plans, animalPlan]));
};
