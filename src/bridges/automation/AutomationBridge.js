/* Expose unified hooks for panels and HUDs */
import DexieDB from "@/db";
import runtime from "@/services/automation/runtime";

export function installAutomationBridge() {
  const routes = {
    meal: "/tier2/household/meals",
    cleaning: "/tier2/household/cleaning",
    garden: "/tier2/household/garden",
    animals: "/tier2/household/animals",
    inventory: "/tier2/household/inventory",
  };

  // attach once
  window.__suka = window.__suka || {};
  window.__suka.db = DexieDB;
  window.__suka.automationRuntime = runtime;
  window.__suka.routes = { ...(window.__suka.routes||{}), ...routes };
}
