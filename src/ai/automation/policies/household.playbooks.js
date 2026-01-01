// src/ai/automation/policies/household.playbooks.js
// Minimal examples. Extend with your own Torah/Sabbath logic windows.

export const PLAYBOOKS = [
  {
    id: "pre-batch-cook-reset",
    when: ({ events, ctx }) =>
      events.includes("SESSION.PLANNED.COOKING") &&
      ctx.tod !== "evening", // earlier heads-up
    then: async ({ agents, ctx }) => {
      const est = await agents.cleaning.estimatePlan(ctx, { preset: "kitchen-reset-10min" });
      return {
        nudge: {
          title: "Quick kitchen reset for smoother cooking later",
          message: est.summary || "A 10-minute reset clears counters, empties sink, stages tools.",
          actions: [{ id: "start-reset", label: "Start 10-min timer" }],
          priority: 0.82,
          next: "SESSION.STARTED.CLEANING",
        },
      };
    },
  },
  {
    id: "harvest->preserve->meal",
    when: ({ events }) => events.includes("GARDEN.HARVEST.WINDOW"),
    then: async ({ agents, ctx }) => {
      const harvest = await agents.gardenHarvest.estimatePlan(ctx, { window: "this-week" });
      const preserve = await agents.preservation.estimatePlan(ctx, { inputs: harvest?.surplus ?? [] });
      const meals = await agents.mealPlanning.estimatePlan(ctx, { prefer: harvest?.fresh ?? [] });

      return {
        nudge: {
          title: "Your garden is ready — here’s how to use it",
          message: `Harvest: ${harvest?.summary}. Preserve plan: ${preserve?.summary}. Meals: ${meals?.summary}.`,
          actions: [
            { id: "schedule-harvest", label: "Schedule harvest" },
            { id: "queue-preserve", label: "Queue preservation" },
            { id: "add-meals", label: "Add meals" },
          ],
          priority: 0.89,
          next: "SESSION.PLANNED.GARDENING",
        },
      };
    },
  },
  {
    id: "sabbath-prep",
    when: ({ events }) => events.includes("SABBATH.PREP.WINDOW"),
    then: async ({ agents, ctx }) => {
      const cook = await agents.cooking.estimatePlan(ctx, { preset: "sabbath" });
      const clean = await agents.cleaning.estimatePlan(ctx, { preset: "high-visibility-rooms" });
      return {
        nudge: {
          title: "Shabbat prep flow",
          message: `${cook?.summary || "Plan meals and prep today."} ${clean?.summary || "Quick tidy and bathrooms."}`,
          actions: [{ id: "open-prep-checklist", label: "Open prep checklist" }],
          priority: 0.95,
          next: "SESSION.PLANNED.COOKING",
        },
      };
    },
  },
];
