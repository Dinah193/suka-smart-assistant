import { getToken, setToken } from "./tokenProvider.js";

const SESSION_CACHE_TTL_MS = 15000;

let cachedSession = null;
let cachedAt = 0;
let cachedToken = "";
let inFlight = null;

function readAccessToken() {
  try {
    return String(getToken("access") || "").trim();
  } catch {
    return "";
  }
}

function cacheSession(session, token) {
  cachedSession = session;
  cachedAt = Date.now();
  cachedToken = String(token || "");
  return cachedSession;
}

export function invalidateSessionCache() {
  cachedSession = null;
  cachedAt = 0;
  cachedToken = "";
}

export async function resolveSession({ force = false } = {}) {
  const token = readAccessToken();

  if (cachedToken !== token) {
    invalidateSessionCache();
    cachedToken = token;
  }

  if (!force && cachedSession && Date.now() - cachedAt < SESSION_CACHE_TTL_MS) {
    return cachedSession;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const response = await fetch("/api/auth/me", {
        method: "GET",
        headers,
        credentials: "include",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.ok) {
        return cacheSession(null, token);
      }
      return cacheSession(payload, token);
    } catch {
      return cacheSession(null, token);
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export async function refreshSessionState() {
  const token = readAccessToken();
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch("/api/auth/session/refresh", {
      method: "POST",
      headers,
      credentials: "include",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.ok) {
      invalidateSessionCache();
      return null;
    }

    const nextToken = String(payload?.session?.accessToken || "").trim();
    if (nextToken) {
      setToken(nextToken, { kind: "access", source: "auth.session.refresh" });
    }

    invalidateSessionCache();
    return resolveSession({ force: true });
  } catch {
    invalidateSessionCache();
    return null;
  }
}

export default {
  resolveSession,
  refreshSessionState,
  invalidateSessionCache,
};
