import eventBus from "@/services/events/eventBus";

function readJsonStorage(key) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function resolveIdentity() {
  const suka = typeof window !== "undefined" ? window.__suka || {} : {};
  const profile = suka.profile || readJsonStorage("suka.profile") || readJsonStorage("suka.user") || {};

  return {
    userId: profile.userId || profile.id || suka.userId || null,
    homeId: profile.homeId || profile.householdId || suka.homeId || suka.householdId || "default",
    familyId: profile.familyId || suka.familyId || null,
  };
}

function resolveScope(identity, explicitScope) {
  const scope = explicitScope === "family" ? "family" : identity.familyId ? "family" : "household";
  const scopeId = scope === "family" ? identity.familyId || "default" : identity.homeId || "default";
  return { scope, scopeId: String(scopeId || "default") };
}

export async function emitCanonicalSignal(input = {}) {
  const identity = resolveIdentity();
  const { scope, scopeId } = resolveScope(identity, input.scope);

  const signal = {
    type: input.type || input.event || "unknownSignal",
    event: input.event || input.type || "unknownSignal",
    sourceModule: input.sourceModule || "ui.unknown",
    urgency: input.urgency || "normal",
    dependencies: Array.isArray(input.dependencies) ? input.dependencies : [],
    completionPct: Number.isFinite(Number(input.completionPct)) ? Number(input.completionPct) : 0,
    privacyScope: input.privacyScope || "household",
    scope,
    scopeId,
    payload: {
      ...(input.payload || {}),
      userId: identity.userId,
      homeId: identity.homeId,
      familyId: identity.familyId,
      source: input.sourceModule || "ui.unknown",
    },
  };

  try {
    eventBus?.emit?.("signal:emit", signal);
  } catch {
    // Keep emitter best-effort.
  }

  try {
    const socket = window?.__suka?.socket;
    if (socket && typeof socket.emit === "function") {
      socket.emit("signal:emit", signal);
      return { ok: true, via: "socket", signal };
    }
  } catch {
    // fallback to HTTP
  }

  // Opt-in only: static frontends should not spam missing /api route requests.
  const enableHttpFallback =
    String(import.meta?.env?.VITE_ENABLE_REALTIME_HTTP_FALLBACK || "false").toLowerCase() === "true";
  if (!enableHttpFallback) {
    return { ok: false, via: "disabled-http-fallback", signal };
  }

  try {
    const res = await fetch("/api/realtime/signals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-user-id": identity.userId || "",
        "x-home-id": identity.homeId || "",
        "x-family-id": identity.familyId || "",
      },
      body: JSON.stringify({
        scope,
        scopeId,
        signal,
      }),
    });

    return { ok: res.ok, via: "http", signal };
  } catch {
    return { ok: false, via: "none", signal };
  }
}
