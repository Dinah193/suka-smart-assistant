import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const TOKEN_PREFIX = "ssa_at_";
const STORE_FILE = path.resolve(process.cwd(), "data", "auth-state.json");
const SESSION_COOKIE_NAME = String(process.env.AUTH_SESSION_COOKIE_NAME || "ssa_session").trim();
const ACCESS_TOKEN_SECRETS = (() => {
  const csv = String(process.env.AUTH_ACCESS_TOKEN_SECRETS || "").trim();
  const fallback = String(process.env.AUTH_ACCESS_TOKEN_SECRET || "dev_access_secret_change_me").trim();
  const list = csv
    ? csv
        .split(",")
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];
  if (fallback) list.push(fallback);
  return Array.from(new Set(list));
})();
const ACCESS_TTL_SEC = Number(process.env.AUTH_ACCESS_TTL_SEC || 900);
const REFRESH_TTL_MS = Number(process.env.AUTH_REFRESH_TTL_MS || 1000 * 60 * 60 * 24 * 7);
const REFRESH_TTL_REMEMBER_MS = Number(
  process.env.AUTH_REFRESH_REMEMBER_TTL_MS || 1000 * 60 * 60 * 24 * 30
);
const NODE_ENV = String(process.env.NODE_ENV || "development").toLowerCase();
const IS_PROD = NODE_ENV === "production";
const COOKIE_SECURE = String(process.env.AUTH_COOKIE_SECURE || (IS_PROD ? "true" : "false")).toLowerCase() === "true";
const COOKIE_DOMAIN = String(process.env.AUTH_COOKIE_DOMAIN || "").trim() || undefined;
const COOKIE_PATH = String(process.env.AUTH_COOKIE_PATH || "/").trim() || "/";
const COOKIE_SAME_SITE = (() => {
  const configured = String(process.env.AUTH_COOKIE_SAME_SITE || "lax").trim().toLowerCase();
  if (["strict", "lax", "none"].includes(configured)) return configured;
  return "lax";
})();
const resetRequests = new Map();

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function sanitizeName(value) {
  return String(value || "").trim();
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

function hashPassword(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function signTokenPayload(encodedPayload) {
  const signingSecret = ACCESS_TOKEN_SECRETS[0] || "dev_access_secret_change_me";
  return crypto
    .createHmac("sha256", signingSecret)
    .update(String(encodedPayload || ""), "utf8")
    .digest("base64url");
}

function verifyTokenPayloadSignature(encodedPayload, providedSig) {
  const normalized = String(providedSig || "");
  for (const secret of ACCESS_TOKEN_SECRETS) {
    try {
      const expectedSig = crypto
        .createHmac("sha256", secret)
        .update(String(encodedPayload || ""), "utf8")
        .digest("base64url");
      if (expectedSig.length !== normalized.length) continue;
      if (crypto.timingSafeEqual(Buffer.from(normalized), Buffer.from(expectedSig))) {
        return true;
      }
    } catch {
      // try next secret
    }
  }
  return false;
}

function defaultStore() {
  return {
    version: 2,
    accountsByEmail: {},
    userHouseholdMap: {},
    householdsById: {},
    sessionsById: {},
    updatedAt: nowIso(),
  };
}

async function ensureStoreDir() {
  await fs.mkdir(path.dirname(STORE_FILE), { recursive: true });
}

async function readStore() {
  await ensureStoreDir();
  try {
    const raw = await fs.readFile(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return {
      ...defaultStore(),
      ...parsed,
      accountsByEmail:
        parsed?.accountsByEmail && typeof parsed.accountsByEmail === "object"
          ? parsed.accountsByEmail
          : {},
      userHouseholdMap:
        parsed?.userHouseholdMap && typeof parsed.userHouseholdMap === "object"
          ? parsed.userHouseholdMap
          : {},
      householdsById:
        parsed?.householdsById && typeof parsed.householdsById === "object"
          ? parsed.householdsById
          : {},
      sessionsById:
        parsed?.sessionsById && typeof parsed.sessionsById === "object"
          ? parsed.sessionsById
          : {},
    };
  } catch {
    return defaultStore();
  }
}

async function writeStore(store) {
  await ensureStoreDir();
  const payload = {
    ...defaultStore(),
    ...store,
    updatedAt: nowIso(),
  };
  await fs.writeFile(STORE_FILE, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function accountToUser(account) {
  if (!account || typeof account !== "object") return null;
  return {
    id: account.id || account.userId,
    userId: account.userId || account.id,
    email: account.email || null,
    firstName: account.firstName || "",
    lastName: account.lastName || "",
    householdId: account.householdId || null,
    roles: Array.isArray(account.roles) ? account.roles : ["member"],
    authProvider: account.authProvider || "native",
  };
}

function buildAccessToken({ userId, sessionId }) {
  const iat = Math.floor(nowMs() / 1000);
  const exp = iat + ACCESS_TTL_SEC;
  const payload = {
    sub: String(userId || ""),
    sid: String(sessionId || ""),
    iat,
    exp,
  };
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const sig = signTokenPayload(encodedPayload);
  return `${TOKEN_PREFIX}${encodedPayload}.${sig}`;
}

function parseAccessToken(token) {
  const raw = String(token || "").trim();
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const body = raw.slice(TOKEN_PREFIX.length);
  const dot = body.lastIndexOf(".");
  if (dot <= 0) return null;

  const encodedPayload = body.slice(0, dot);
  const providedSig = body.slice(dot + 1);
  if (!verifyTokenPayloadSignature(encodedPayload, providedSig)) {
    return null;
  }

  const decoded = fromBase64Url(encodedPayload);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded);
    if (!parsed?.sub || !parsed?.sid || !Number.isFinite(parsed?.exp)) {
      return null;
    }
    if (Math.floor(nowMs() / 1000) >= Number(parsed.exp)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseSessionCookieValue(value) {
  const raw = String(value || "").trim();
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const sessionId = raw.slice(0, dot);
  const refreshToken = raw.slice(dot + 1);
  if (!sessionId || !refreshToken) return null;
  return { sessionId, refreshToken };
}

function buildSessionCookieValue(sessionId, refreshToken) {
  return `${sessionId}.${refreshToken}`;
}

function buildCookieDescriptor(value, rememberMe = false) {
  const maxAgeMs = rememberMe ? REFRESH_TTL_REMEMBER_MS : REFRESH_TTL_MS;
  const sameSite = COOKIE_SAME_SITE === "none" && !COOKIE_SECURE ? "lax" : COOKIE_SAME_SITE;
  return {
    name: SESSION_COOKIE_NAME,
    value,
    options: {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite,
      path: COOKIE_PATH,
      domain: COOKIE_DOMAIN,
      maxAge: maxAgeMs,
    },
    maxAgeMs,
  };
}

function sessionIsExpired(session) {
  if (!session?.expiresAt) return true;
  const expiresMs = Date.parse(String(session.expiresAt));
  if (!Number.isFinite(expiresMs)) return true;
  return nowMs() >= expiresMs;
}

function sessionIsRevoked(session) {
  return Boolean(session?.revokedAt || session?.revokedReason);
}

async function getAccountByEmail(email) {
  const store = await readStore();
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;
  return store.accountsByEmail[normalizedEmail] || null;
}

async function getAccountByUserId(userId) {
  const store = await readStore();
  const needle = String(userId || "").trim();
  if (!needle) return null;
  const account = Object.values(store.accountsByEmail).find((candidate) => {
    return candidate?.userId === needle || candidate?.id === needle;
  });
  return account || null;
}

async function issueSessionForUser({ user, rememberMe = false, parentSessionId = null } = {}) {
  const userId = String(user?.userId || user?.id || "").trim();
  if (!userId) {
    throw new Error("user_required");
  }

  const store = await readStore();
  const sessionId = `sess_${crypto.randomUUID()}`;
  const refreshToken = crypto.randomBytes(48).toString("base64url");
  const expiresAt = new Date(nowMs() + (rememberMe ? REFRESH_TTL_REMEMBER_MS : REFRESH_TTL_MS)).toISOString();

  store.sessionsById[sessionId] = {
    id: sessionId,
    userId,
    refreshTokenHash: hashToken(refreshToken),
    rememberMe: Boolean(rememberMe),
    parentSessionId: parentSessionId || null,
    createdAt: nowIso(),
    lastSeenAt: nowIso(),
    rotatedAt: null,
    revokedAt: null,
    revokedReason: null,
    expiresAt,
  };

  await writeStore(store);

  const accessToken = buildAccessToken({ userId, sessionId });
  const cookieValue = buildSessionCookieValue(sessionId, refreshToken);

  return {
    session: {
      accessToken,
      tokenType: "Bearer",
      issuedAt: nowIso(),
      expiresAt,
      sessionId,
    },
    cookie: buildCookieDescriptor(cookieValue, rememberMe),
  };
}

async function resolveSessionFromRefreshCookie(sessionCookie = "") {
  const parsed = parseSessionCookieValue(sessionCookie);
  if (!parsed) return null;

  const store = await readStore();
  const session = store.sessionsById[parsed.sessionId];
  if (!session) return null;
  if (sessionIsRevoked(session) || sessionIsExpired(session)) return null;
  if (session.refreshTokenHash !== hashToken(parsed.refreshToken)) return null;

  session.lastSeenAt = nowIso();
  store.sessionsById[parsed.sessionId] = session;
  await writeStore(store);
  return session;
}

export async function createNativeAccount({ firstName = "", lastName = "", email = "", password = "", rememberMe = false } = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error("email_required");
  }
  if (String(password || "").length < 10) {
    throw new Error("weak_password");
  }

  const store = await readStore();
  if (store.accountsByEmail[normalizedEmail]) {
    throw new Error("account_exists");
  }

  const userId = `native_${crypto.randomUUID()}`;
  const account = {
    id: userId,
    userId,
    email: normalizedEmail,
    firstName: sanitizeName(firstName),
    lastName: sanitizeName(lastName),
    passwordHash: hashPassword(password),
    householdId: null,
    roles: ["member"],
    authProvider: "native",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  store.accountsByEmail[normalizedEmail] = account;
  await writeStore(store);

  const user = accountToUser(account);
  const issued = await issueSessionForUser({ user, rememberMe });

  return {
    ok: true,
    user,
    session: issued.session,
    cookie: issued.cookie,
    scaffold: false,
  };
}

export async function signInNative({ email = "", password = "", rememberMe = false } = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error("email_required");
  }

  const account = await getAccountByEmail(normalizedEmail);
  if (!account) {
    throw new Error("invalid_credentials");
  }
  if (hashPassword(password) !== account.passwordHash) {
    throw new Error("invalid_credentials");
  }

  const user = accountToUser(account);
  const issued = await issueSessionForUser({ user, rememberMe });

  return {
    ok: true,
    user,
    session: issued.session,
    cookie: issued.cookie,
    scaffold: false,
  };
}

export async function requestPasswordReset({ email = "" } = {}) {
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
    scaffold: false,
    message: "Password reset flow accepted.",
  };
}

export async function resetPassword({ token = "", password = "" } = {}) {
  const key = String(token || "").trim();
  const record = key ? resetRequests.get(key) : null;
  if (!record) {
    return {
      ok: false,
      error: "invalid_or_expired_reset_token",
    };
  }

  const normalizedEmail = normalizeEmail(record.email);
  const store = await readStore();
  const account = store.accountsByEmail[normalizedEmail];
  if (account && String(password || "").length >= 10) {
    account.passwordHash = hashPassword(password);
    account.updatedAt = nowIso();
    store.accountsByEmail[normalizedEmail] = account;
    await writeStore(store);
  }

  resetRequests.delete(key);
  return {
    ok: true,
    email: normalizedEmail,
    scaffold: false,
    message: "Password reset accepted.",
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
      scaffold: false,
    };
  }

  return {
    ok: true,
    redirectTo: returnTo,
    scaffold: false,
  };
}

export async function verifyHttpRequest({ token = "", sessionToken = "" } = {}) {
  const bearer = String(token || "").trim();
  const cookieToken = String(sessionToken || "").trim();

  if (bearer) {
    const parsed = parseAccessToken(bearer);
    if (parsed?.sub && parsed?.sid) {
      const store = await readStore();
      const session = store.sessionsById[parsed.sid];
      if (session && !sessionIsRevoked(session) && !sessionIsExpired(session) && session.userId === parsed.sub) {
        const account = await getAccountByUserId(parsed.sub);
        const user = accountToUser(account);
        if (user) {
          return {
            ok: true,
            userId: user.userId || user.id,
            homeId: user.householdId || null,
            familyId: null,
            roles: Array.isArray(user.roles) ? user.roles : [],
            provider: user.authProvider || "native",
            sessionId: parsed.sid,
          };
        }
      }
    }
  }

  if (cookieToken) {
    const session = await resolveSessionFromRefreshCookie(cookieToken);
    if (!session) return { ok: false };
    const account = await getAccountByUserId(session.userId);
    const user = accountToUser(account);
    if (!user) return { ok: false };

    return {
      ok: true,
      userId: user.userId || user.id,
      homeId: user.householdId || null,
      familyId: null,
      roles: Array.isArray(user.roles) ? user.roles : [],
      provider: user.authProvider || "native",
      sessionId: session.id,
    };
  }

  return { ok: false };
}

export async function verifySocketToken(token) {
  return verifyHttpRequest({ token });
}

export async function getCurrentSession({ token = "", sessionToken = "" } = {}) {
  const verified = await verifyHttpRequest({ token, sessionToken });
  if (!verified.ok) {
    return { ok: false, error: "unauthorized" };
  }

  const account = await getAccountByUserId(verified.userId);
  const user = accountToUser(account);
  if (!user) {
    return { ok: false, error: "unauthorized" };
  }

  return {
    ok: true,
    user,
    session: {
      sessionId: verified.sessionId || null,
    },
    scaffold: false,
  };
}

export async function refreshSession({ token = "", sessionToken = "", rememberMe = false } = {}) {
  const cookieParsed = parseSessionCookieValue(sessionToken);
  if (cookieParsed) {
    const store = await readStore();
    const oldSession = store.sessionsById[cookieParsed.sessionId];
    if (
      oldSession &&
      !sessionIsRevoked(oldSession) &&
      !sessionIsExpired(oldSession) &&
      oldSession.refreshTokenHash === hashToken(cookieParsed.refreshToken)
    ) {
      oldSession.revokedAt = nowIso();
      oldSession.revokedReason = "rotated";
      oldSession.rotatedAt = nowIso();
      store.sessionsById[cookieParsed.sessionId] = oldSession;
      await writeStore(store);

      const account = await getAccountByUserId(oldSession.userId);
      const user = accountToUser(account);
      if (!user) {
        return { ok: false, error: "unauthorized" };
      }

      const issued = await issueSessionForUser({
        user,
        rememberMe: Boolean(oldSession.rememberMe || rememberMe),
        parentSessionId: oldSession.id,
      });

      return {
        ok: true,
        user,
        session: issued.session,
        cookie: issued.cookie,
        scaffold: false,
      };
    }
  }

  const current = await getCurrentSession({ token, sessionToken });
  if (!current.ok) {
    return current;
  }

  const issued = await issueSessionForUser({ user: current.user, rememberMe: Boolean(rememberMe) });
  return {
    ok: true,
    user: current.user,
    session: issued.session,
    cookie: issued.cookie,
    scaffold: false,
  };
}

export async function revokeSession({ token = "", sessionToken = "" } = {}) {
  const store = await readStore();
  let revoked = false;

  const cookieParsed = parseSessionCookieValue(sessionToken);
  if (cookieParsed && store.sessionsById[cookieParsed.sessionId]) {
    const session = store.sessionsById[cookieParsed.sessionId];
    if (!sessionIsRevoked(session)) {
      session.revokedAt = nowIso();
      session.revokedReason = "logout";
      store.sessionsById[cookieParsed.sessionId] = session;
      revoked = true;
    }
  }

  const accessParsed = parseAccessToken(token);
  if (accessParsed?.sid && store.sessionsById[accessParsed.sid]) {
    const session = store.sessionsById[accessParsed.sid];
    if (!sessionIsRevoked(session)) {
      session.revokedAt = nowIso();
      session.revokedReason = "logout";
      store.sessionsById[accessParsed.sid] = session;
      revoked = true;
    }
  }

  if (revoked) {
    await writeStore(store);
  }

  return {
    ok: true,
    revoked,
    scaffold: false,
  };
}

export async function bootstrapHouseholdMembership({
  token = "",
  sessionToken = "",
  householdId = "",
  householdName = "",
} = {}) {
  const current = await getCurrentSession({ token, sessionToken });
  if (!current.ok) return current;

  const existingUser = current.user || {};
  const userId = existingUser.userId || existingUser.id;
  if (!userId) return { ok: false, error: "unauthorized" };

  const requested = String(householdId || "").trim();
  const resolvedHouseholdId = requested || `house_${crypto.randomUUID()}`;
  const resolvedHouseholdName = String(householdName || "My Household").trim() || "My Household";

  const store = await readStore();
  const account = Object.values(store.accountsByEmail).find((candidate) => {
    return candidate?.userId === userId || candidate?.id === userId;
  });
  if (!account) return { ok: false, error: "unauthorized" };

  const currentHouseholdId = String(account.householdId || "").trim();
  if (currentHouseholdId && currentHouseholdId !== resolvedHouseholdId) {
    return {
      ok: false,
      error: "household_membership_locked",
      userId,
      householdId: currentHouseholdId,
    };
  }

  account.householdId = currentHouseholdId || resolvedHouseholdId;
  account.updatedAt = nowIso();
  store.accountsByEmail[normalizeEmail(account.email)] = account;
  store.userHouseholdMap[userId] = account.householdId;
  store.householdsById[account.householdId] = {
    id: account.householdId,
    name: resolvedHouseholdName,
    createdByUserId: userId,
    createdAt: store.householdsById[account.householdId]?.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
  await writeStore(store);

  const user = accountToUser(account);
  const issued = await issueSessionForUser({ user, rememberMe: false });

  return {
    ok: true,
    user,
    household: store.householdsById[account.householdId],
    session: issued.session,
    cookie: issued.cookie,
    scaffold: false,
  };
}

export function getSessionCookieName() {
  return SESSION_COOKIE_NAME;
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
  bootstrapHouseholdMembership,
  getSessionCookieName,
};
