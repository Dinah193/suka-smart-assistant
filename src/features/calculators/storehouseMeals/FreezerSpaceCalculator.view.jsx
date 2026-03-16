// Bridge file for Vite import compatibility.
//
// Some pages import:
//   "@/features/calculators/storehouseMeals/FreezerSpaceCalculator.view"
//
// But the actual view component lives at:
//   "@/features/calculators/storehouseMeals/FreezerSpaceCalculator/FreezerSpaceCalculator.view.jsx"
//
// This bridge keeps imports stable and avoids ENOENT during build.

export { default } from "./FreezerSpaceCalculator/FreezerSpaceCalculator.view.jsx";
