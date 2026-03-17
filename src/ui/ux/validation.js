export function coerceNonNegativeNumber(value, defaultValue = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return defaultValue;
  return n < 0 ? defaultValue : n;
}

export function findNegativeNumericFields(record = {}, fields = []) {
  if (!record || typeof record !== "object") return [];
  return fields.filter((field) => {
    const n = Number(record[field]);
    return Number.isFinite(n) && n < 0;
  });
}
