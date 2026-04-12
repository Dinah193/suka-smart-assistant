export function buildHouseholdTodayUpcomingQuery({
  householdId,
  todayLimit = 10,
  upcomingLimit = 10,
  modules = "",
  filters = {},
}) {
  const params = new URLSearchParams({
    householdId: String(householdId || ""),
    todayLimit: String(todayLimit),
    upcomingLimit: String(upcomingLimit),
    sortBy: String(filters?.sortBy || "dueAt"),
    sortDirection: String(filters?.sortDirection || "desc"),
  });

  if (modules) {
    params.set("modules", String(modules));
  }
  if (filters?.person) {
    params.set("person", String(filters.person));
  }
  if (filters?.module) {
    params.set("module", String(filters.module));
  }
  if (filters?.priority) {
    params.set("priority", String(filters.priority));
  }
  if (filters?.status) {
    params.set("status", String(filters.status));
  }

  return params;
}
