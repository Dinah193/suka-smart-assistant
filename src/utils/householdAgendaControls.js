export function normalizeAppliedAgendaFilters(applied) {
  return {
    person: String(applied?.filters?.person || "").trim().toLowerCase(),
    module: String(applied?.filters?.module || ""),
    priority: String(applied?.filters?.priority || ""),
    status: String(applied?.filters?.status || ""),
    sortBy: String(applied?.sortBy || "dueAt"),
    sortDirection: String(applied?.sortDirection || "desc"),
  };
}

export function areAgendaFiltersEqual(left, right) {
  return Boolean(
    left
      && right
      && left.person === right.person
      && left.module === right.module
      && left.priority === right.priority
      && left.status === right.status
      && left.sortBy === right.sortBy
      && left.sortDirection === right.sortDirection
  );
}
