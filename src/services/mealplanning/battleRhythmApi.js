const JSON_HEADERS = { "Content-Type": "application/json" };

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: "Invalid JSON response" };
  }
}

async function request(url, init = {}) {
  const res = await fetch(url, init);
  const body = await readJson(res);
  if (!res.ok || body?.ok === false) {
    const err = new Error(body?.error || `Request failed: ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function getBattleRhythmProfile(userId = "global") {
  const qs = new URLSearchParams({ userId: String(userId || "global") });
  return request(`/api/battle-rhythm/profile?${qs.toString()}`);
}

export async function saveBattleRhythmProfile(userId = "global", profile = {}) {
  return request("/api/battle-rhythm/profile", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ userId: String(userId || "global"), profile }),
  });
}

export async function listBattleRhythmCustomizations(userId = "global") {
  const qs = new URLSearchParams({ userId: String(userId || "global") });
  return request(`/api/battle-rhythm/customizations?${qs.toString()}`);
}

export async function upsertBattleRhythmCustomization(payload = {}) {
  return request("/api/battle-rhythm/customizations", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export async function deleteBattleRhythmCustomization(payload = {}) {
  return request("/api/battle-rhythm/customizations", {
    method: "DELETE",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export async function resolveRecipeWithBattleRhythm(payload = {}) {
  return request("/api/mealplan/resolveRecipe", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}
