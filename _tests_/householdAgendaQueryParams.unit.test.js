import { describe, expect, it } from "vitest";

import { buildHouseholdTodayUpcomingQuery } from "../src/utils/householdAgendaQueryParams.js";

describe("householdAgendaQueryParams", () => {
  it("applies default limits and sort params", () => {
    const params = buildHouseholdTodayUpcomingQuery({
      householdId: "household-1",
    });

    expect(params.get("householdId")).toBe("household-1");
    expect(params.get("todayLimit")).toBe("10");
    expect(params.get("upcomingLimit")).toBe("10");
    expect(params.get("sortBy")).toBe("dueAt");
    expect(params.get("sortDirection")).toBe("desc");
  });

  it("includes modules and optional filters when provided", () => {
    const params = buildHouseholdTodayUpcomingQuery({
      householdId: "household-2",
      todayLimit: 6,
      upcomingLimit: 12,
      modules: "meal,cleaning",
      filters: {
        person: "member-alpha",
        module: "cleaning",
        priority: "high",
        status: "blocked",
        sortBy: "status",
        sortDirection: "asc",
      },
    });

    expect(params.get("householdId")).toBe("household-2");
    expect(params.get("todayLimit")).toBe("6");
    expect(params.get("upcomingLimit")).toBe("12");
    expect(params.get("modules")).toBe("meal,cleaning");
    expect(params.get("person")).toBe("member-alpha");
    expect(params.get("module")).toBe("cleaning");
    expect(params.get("priority")).toBe("high");
    expect(params.get("status")).toBe("blocked");
    expect(params.get("sortBy")).toBe("status");
    expect(params.get("sortDirection")).toBe("asc");
  });

  it("omits optional module and filter fields when empty", () => {
    const params = buildHouseholdTodayUpcomingQuery({
      householdId: "household-3",
      modules: "",
      filters: {
        person: "",
        module: "",
        priority: "",
        status: "",
      },
    });

    expect(params.has("modules")).toBe(false);
    expect(params.has("person")).toBe(false);
    expect(params.has("module")).toBe(false);
    expect(params.has("priority")).toBe(false);
    expect(params.has("status")).toBe(false);
    expect(params.get("sortBy")).toBe("dueAt");
    expect(params.get("sortDirection")).toBe("desc");
  });
});
