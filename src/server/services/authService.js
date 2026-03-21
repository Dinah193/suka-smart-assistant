import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const TOKEN_PREFIX = "ssa_dev_";
const STORE_FILE = path.resolve(process.cwd(), "data", "auth-state.json");
const resetRequests = new Map();
const revokedTokens = new Set();

function nowIso() {
  return new Date().toISOString();
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

function defaultStore() {
  return {
    version: 1,
    accountsByEmail: {},
    userHouseholdMap: {},
    householdsById: {},
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
      accountsByEmail: parsed?.accountsByEmail && typeof parsed.accountsByEmail === "object" ? parsed.accountsByEmail : {},
      userHouseholdMap: parsed?.userHouseholdMap && typeof parsed.userHouseholdMap === "object" ? parsed.userHouseholdMap : {},
      householdsById: parsed?.householdsById && typeof parsed.householdsById === "object" ? parsed.householdsById : {},
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

function buildSession(user) {
  return {
    accessToken: buildDevToken(user),
    tokenType: "Bearer",
    issuedAt: nowIso(),
  };
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

export async function createNativeAccount({ firstName = "", lastName = "", email = "", password = "" } = {}) {
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
  return {
    ok: true,
    user,
    session: buildSession(user),
    scaffold: true,
  };
}

export async function signInNative({ email = "", password = "" } = {}) {
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
  return {
    ok: true,
    user,
    session: buildSession(user),
    scaffold: true,
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
    scaffold: true,
    message: "Password reset flow is scaffolded. Replace with email provider integration.",
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

  const account = await getAccountByUserId(parsed.userId || parsed.id);
  if (!account) return { ok: false };
  const user = accountToUser(account);

  return {
    ok: true,
    userId: user.userId || user.id,
    homeId: user.householdId || null,
    familyId: null,
    roles: Array.isArray(user.roles) ? user.roles : [],
    provider: user.authProvider || "native",
  };
}

export async function verifySocketToken(token) {
  return verifyHttpRequest({ token });
}

export async function getCurrentSession({ token = "", sessionToken = "" } = {}) {
  const raw = String(token || "").trim() || String(sessionToken || "").trim();
  if (!raw || revokedTokens.has(raw)) {
    return { ok: false, error: "unauthorized" };
  }

  const parsed = parseDevToken(raw);
  if (!parsed) {
    return { ok: false, error: "unauthorized" };
  }

  const account = await getAccountByUserId(parsed.userId || parsed.id);
  if (!account) {
    return { ok: false, error: "unauthorized" };
  }

  const user = accountToUser(account);

  return {
    ok: true,
    user,
    scaffold: true,
  };
}

export async function refreshSession({ token = "", sessionToken = "" } = {}) {
  const current = await getCurrentSession({ token, sessionToken });
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

export async function bootstrapHouseholdMembership({ token = "", sessionToken = "", householdId = "", householdName = "" } = {}) {
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
  return {
    ok: true,
    user,
    household: store.householdsById[account.householdId],
    session: buildSession(user),
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
  bootstrapHouseholdMembership,
};