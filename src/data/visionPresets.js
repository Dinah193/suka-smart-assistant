// src/data/visionPresets.js
export const VISION_PRESETS = {
  "efficient-economy": {
    label: "Efficient Home — Economy Stimulator",
    description:
      "Buy from local producers, cook efficiently, automate; minimal DIY production.",
    weights: {
      diyPreference: 0.25,         // 0..1
      localPreference: 0.9,
      organicPreference: 0.5,
    },
    constraints: {
      landSqft: 50,                // patio/small yard
      livestockAllowed: false,
      budgetFlex: 0.7,             // 0 tight … 1 loose
    },
  },
  "balanced-hybrid": {
    label: "Balanced Hybrid",
    description:
      "Garden & preserve common items; buy specialty goods from locals.",
    weights: {
      diyPreference: 0.6,
      localPreference: 0.8,
      organicPreference: 0.6,
    },
    constraints: {
      landSqft: 400,
      livestockAllowed: true,
      budgetFlex: 0.5,
    },
  },
  "agrarian-offgrid": {
    label: "Agrarian Goals — Off‑Grid Leaning",
    description:
      "Homestead focus: grow/raise most foods, heavy preservation, lower purchasing.",
    weights: {
      diyPreference: 0.9,
      localPreference: 0.7,
      organicPreference: 0.9,
    },
    constraints: {
      landSqft: 2000,
      livestockAllowed: true,
      budgetFlex: 0.3,
    },
  },
};
