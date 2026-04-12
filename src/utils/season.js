export function getSeasonKey(date = new Date()) {
  const month = date.getMonth() + 1;
  if (month === 12 || month <= 2) return "winter";
  if (month <= 5) return "spring";
  if (month <= 8) return "summer";
  return "autumn";
}

export function getSeasonLabel(season) {
  const safe = String(season || "").trim().toLowerCase() || "spring";
  return safe.charAt(0).toUpperCase() + safe.slice(1);
}
