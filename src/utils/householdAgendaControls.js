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

export function buildAppliedAgendaSummary(applied) {
  const normalized = normalizeAppliedAgendaFilters(applied);
  let summary = `Applied: ${String(normalized.module || "all modules")}`;
  if (normalized.priority) {
    summary += ` | ${String(normalized.priority)} priority`;
  }
  if (normalized.status) {
    summary += ` | ${String(normalized.status)} status`;
  }
  if (normalized.person) {
    summary += ` | person ${String(normalized.person)}`;
  }
  summary += ` | sort ${String(normalized.sortBy)}:${String(normalized.sortDirection)}`;
  return summary;
}
