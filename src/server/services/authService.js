import crypto from "node:crypto";

const TOKEN_PREFIX = "ssa_dev_";
const resetRequests = new Map();
const revokedTokens = new Set();

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function toBase64Url(text) {
  return Buffer.from(String(text || ""), "utf8").toString("base64url");
}

function fromBase64Url(text) {
  try {
    return Buffer.from(String(text || ""), "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function sanitizeReturnTo(value, fallback = "/") {
  const input = String(value || "").trim();
  if (!input.startsWith("/")) return fallback;
  if (input.startsWith("//")) return fallback;
  return input;
}

function buildDevToken(user) {
  return `${TOKEN_PREFIX}${toBase64Url(JSON.stringify(user || {}))}`;
}

function parseDevToken(token) {
  if (!String(token || "").startsWith(TOKEN_PREFIX)) return null;
  const encoded = String(token).slice(TOKEN_PREFIX.length);
  const parsed = fromBase64Url(encoded);
  if (!parsed) return null;
  try {
    const payload = JSON.parse(parsed);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

export function createNativeAccount({ firstName = "", lastName = "", email = "" } = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error("email_required");
  }

  const user = {
    id: `native_${crypto.randomUUID()}`,
    userId: `native_${crypto.randomUUID()}`,
    householdId: null,
    email: normalizedEmail,
    firstName: String(firstName || "").trim(),
    lastName: String(lastName || "").trim(),
    roles: ["member"],
    authProvider: "native",
    createdAt: nowIso(),
  };

  return {
    ok: true,
    user,
    session: {
      accessToken: buildDevToken(user),
      tokenType: "Bearer",
      issuedAt: nowIso(),
    },
    scaffold: true,
  };
}

export function signInNative({ email = "" } = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error("email_required");
  }

  const user = {
    id: `native_${toBase64Url(normalizedEmail).slice(0, 16)}`,
    userId: `native_${toBase64Url(normalizedEmail).slice(0, 16)}`,
    householdId: null,
    email: normalizedEmail,
    roles: ["member"],
    authProvider: "native",
    signedInAt: nowIso(),
  };

  return {
    ok: true,
    user,
    session: {
      accessToken: buildDevToken(user),
      tokenType: "Bearer",
      issuedAt: nowIso(),
    },
    scaffold: true,
  };
}

export function requestPasswordReset({ email = "" } = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error("email_required");
  }

  const token = crypto.randomUUID();
  resetRequests.set(token, {
    email: normalizedEmail,
    createdAt: nowIso(),
  });

  return {
    ok: true,
    email: normalizedEmail,
    resetToken: token,
    scaffold: true,
    message: "Password reset flow is scaffolded. Replace with email provider integration.",
  };
}

export function resetPassword({ token = "" } = {}) {
  const key = String(token || "").trim();
  const record = key ? resetRequests.get(key) : null;
  if (!record) {
    return {
      ok: false,
      error: "invalid_or_expired_reset_token",
    };
  }

  resetRequests.delete(key);
  return {
    ok: true,
    email: record.email,
    scaffold: true,
    message: "Password reset accepted in scaffold mode.",
  };
}

export function getHubAuthorizationUrl({ returnTo = "/" } = {}) {
  const safeReturnTo = sanitizeReturnTo(returnTo, "/");
  const configured = String(process.env.HUB_OAUTH_AUTHORIZE_URL || "").trim();

  if (!configured) {
    return {
      configured: false,
      fallbackUrl: `/login?hub=not_configured&returnTo=${encodeURIComponent(safeReturnTo)}`,
    };
  }

  const callbackUrl = String(process.env.HUB_OAUTH_CALLBACK_URL || "").trim();
  const state = toBase64Url(
    JSON.stringify({
      nonce: crypto.randomUUID(),
      returnTo: safeReturnTo,
      issuedAt: nowIso(),
    })
  );

  const url = new URL(configured);
  if (callbackUrl) {
    url.searchParams.set("redirect_uri", callbackUrl);
  }
  url.searchParams.set("state", state);

  return {
    configured: true,
    url: url.toString(),
    state,
  };
}

export function handleHubCallback({ code = "", state = "" } = {}) {
  const parsedState = state ? fromBase64Url(state) : "";
  let returnTo = "/";
  if (parsedState) {
    try {
      const parsed = JSON.parse(parsedState);
      returnTo = sanitizeReturnTo(parsed?.returnTo, "/");
    } catch {
      returnTo = "/";
    }
  }

  if (!String(code || "").trim()) {
    return {
      ok: false,
      redirectTo: `/login?hub=callback_missing_code&returnTo=${encodeURIComponent(returnTo)}`,
      scaffold: true,
    };
  }

  return {
    ok: true,
    redirectTo: returnTo,
    scaffold: true,
  };
}

export async function verifyHttpRequest({ token = "", sessionToken = "" } = {}) {
  const bearer = String(token || "").trim();
  const cookieToken = String(sessionToken || "").trim();
  if ((bearer && revokedTokens.has(bearer)) || (cookieToken && revokedTokens.has(cookieToken))) {
    return { ok: false };
  }

  const parsed = parseDevToken(bearer) || parseDevToken(cookieToken);
  if (!parsed) return { ok: false };

  return {
    ok: true,
    userId: parsed.userId || parsed.id,
    homeId: parsed.householdId || null,
    familyId: parsed.familyId || null,
    roles: Array.isArray(parsed.roles) ? parsed.roles : [],
    provider: parsed.authProvider || "native",
  };
}

export async function verifySocketToken(token) {
  return verifyHttpRequest({ token });
}

export function getCurrentSession({ token = "", sessionToken = "" } = {}) {
  const raw = String(token || "").trim() || String(sessionToken || "").trim();
  if (!raw || revokedTokens.has(raw)) {
    return { ok: false, error: "unauthorized" };
  }

  const parsed = parseDevToken(raw);
  if (!parsed) {
    return { ok: false, error: "unauthorized" };
  }

  return {
    ok: true,
    user: {
      id: parsed.id || parsed.userId,
      userId: parsed.userId || parsed.id,
      email: parsed.email || null,
      householdId: parsed.householdId || null,
      roles: Array.isArray(parsed.roles) ? parsed.roles : [],
      authProvider: parsed.authProvider || "native",
    },
    scaffold: true,
  };
}

export function refreshSession({ token = "", sessionToken = "" } = {}) {
  const current = getCurrentSession({ token, sessionToken });
  if (!current.ok) {
    return current;
  }

  return {
    ok: true,
    user: current.user,
    session: {
      accessToken: buildDevToken(current.user),
      tokenType: "Bearer",
      issuedAt: nowIso(),
    },
    scaffold: true,
  };
}

export function revokeSession({ token = "", sessionToken = "" } = {}) {
  const bearer = String(token || "").trim();
  const cookieToken = String(sessionToken || "").trim();
  if (bearer) revokedTokens.add(bearer);
  if (cookieToken) revokedTokens.add(cookieToken);

  return {
    ok: true,
    revoked: Boolean(bearer || cookieToken),
    scaffold: true,
  };
}

export default {
  createNativeAccount,
  signInNative,
  requestPasswordReset,
  resetPassword,
  getHubAuthorizationUrl,
  handleHubCallback,
  verifyHttpRequest,
  verifySocketToken,
  getCurrentSession,
  refreshSession,
  revokeSession,
};