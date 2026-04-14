export const HOUSEHOLD_PARITY_MODULES = ["meal", "cleaning", "storehouse", "homestead"];

export function buildHouseholdParityFixture(nowMs = Date.now()) {
  const dueAnchor = new Date(nowMs);
  dueAnchor.setUTCHours(12, 0, 0, 0);
  if (dueAnchor.getTime() <= nowMs) {
    dueAnchor.setUTCDate(dueAnchor.getUTCDate() + 1);
  }

  return HOUSEHOLD_PARITY_MODULES.map((moduleKey, index) => {
    const ownerId = `member-${moduleKey}`;
    const baseDueAt = new Date(dueAnchor.getTime() + (index + 1) * 45 * 60 * 1000).toISOString();
    const dependentDueAt = new Date(dueAnchor.getTime() + (index + 1) * 75 * 60 * 1000).toISOString();

    return {
      moduleKey,
      ownerId,
      baseTask: {
        moduleKey,
        title: `Parity base ${moduleKey}`,
        ownerId,
        dueAt: baseDueAt,
        priority: "high",
      },
      dependentTask: {
        moduleKey,
        title: `Parity dependent ${moduleKey}`,
        ownerId,
        dueAt: dependentDueAt,
        priority: "normal",
        recurrence: {
          enabled: true,
          frequency: "daily",
        },
      },
    };
  });
}