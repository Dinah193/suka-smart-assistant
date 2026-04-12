export function findValueByCandidateKeys(input, candidateKeys = []) {
  if (!input || typeof input !== "object") return null;
  const wanted = new Set(candidateKeys.map((k) => String(k).toLowerCase()));
  const queue = [input];

  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object") continue;

    for (const [key, value] of Object.entries(node)) {
      if (wanted.has(String(key).toLowerCase())) return value;
      if (value && typeof value === "object") queue.push(value);
    }
  }

  return null;
}

export function normalizeParticipationEntries(rawEntries) {
  if (!Array.isArray(rawEntries)) return null;

  const normalized = rawEntries
    .map((item, idx) => {
      if (!item || typeof item !== "object") return null;
      const name = String(
        item.name || item.label || item.key || `Member ${idx + 1}`
      ).trim();
      const value = Math.max(
        0,
        Number(item.value ?? item.count ?? item.total ?? 0) || 0
      );
      return { name, value };
    })
    .filter(Boolean);

  return normalized.length ? normalized : null;
}
