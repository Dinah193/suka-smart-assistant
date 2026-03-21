"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const AUTH_STATE_FILE = path.resolve(process.cwd(), "data", "auth-state.json");
const ACCESS_POLICY_FILE = path.resolve(process.cwd(), "data", "access-policies.json");

function nowIso() {
  return new Date().toISOString();
}

function defaultPolicyStore() {
  return {
    version: 1,
    collaborationGrants: [],
    entitlementGrantsByUserId: {},
    householdRolesByHouseholdId: {},
    updatedAt: nowIso(),
  };
}

async function ensureDataDir() {
  await fs.mkdir(path.dirname(ACCESS_POLICY_FILE), { recursive: true });
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function readAuthState() {
  const fallback = {
    accountsByEmail: {},
    userHouseholdMap: {},
    householdsById: {},
  };
  return readJsonFile(AUTH_STATE_FILE, fallback);
}

async function readAccessPolicyState() {
  await ensureDataDir();
  const parsed = await readJsonFile(ACCESS_POLICY_FILE, defaultPolicyStore());
  return {
    ...defaultPolicyStore(),
    ...parsed,
    collaborationGrants: Array.isArray(parsed?.collaborationGrants) ? parsed.collaborationGrants : [],
    entitlementGrantsByUserId:
      parsed?.entitlementGrantsByUserId && typeof parsed.entitlementGrantsByUserId === "object"
        ? parsed.entitlementGrantsByUserId
        : {},
    householdRolesByHouseholdId:
      parsed?.householdRolesByHouseholdId && typeof parsed.householdRolesByHouseholdId === "object"
        ? parsed.householdRolesByHouseholdId
        : {},
  };
}

function methodToAction(method) {
  const normalized = String(method || "GET").toUpperCase();
  if (normalized === "GET" || normalized === "HEAD") return "read";
  if (normalized === "POST") return "create";
  if (normalized === "PUT" || normalized === "PATCH") return "update";
  if (normalized === "DELETE") return "delete";
  return "read";
}

function getDefaultHouseholdRole() {
  return "owner";
}

function findAccountByUserId(authState, userId) {
  const needle = String(userId || "").trim();
  if (!needle) return null;
  const accounts = Object.values(authState?.accountsByEmail || {});
  return accounts.find((account) => account?.userId === needle || account?.id === needle) || null;
}

async function resolveHouseholdAccess({ userId, requestedHouseholdId } = {}) {
  const authState = await readAuthState();
  const policyState = await readAccessPolicyState();

  const account = findAccountByUserId(authState, userId);
  const ownHouseholdId = String(account?.householdId || authState?.userHouseholdMap?.[userId] || "").trim() || null;

  const resolvedRequested = String(requestedHouseholdId || ownHouseholdId || "").trim() || null;

  const roleFromPolicy =
    policyState?.householdRolesByHouseholdId?.[resolvedRequested || ""]?.[String(userId || "").trim()] || null;

  const role =
    roleFromPolicy ||
    (resolvedRequested && ownHouseholdId && resolvedRequested === ownHouseholdId
      ? getDefaultHouseholdRole()
      : null);

  return {
    ownHouseholdId,
    requestedHouseholdId: resolvedRequested,
    sameHousehold: Boolean(ownHouseholdId && resolvedRequested && ownHouseholdId === resolvedRequested),
    role,
  };
}

async function hasCollaborationGrant({ userId, moduleKey, householdId, action }) {
  const policyState = await readAccessPolicyState();
  const now = Date.now();
  const grants = Array.isArray(policyState?.collaborationGrants) ? policyState.collaborationGrants : [];

  return grants.some((grant) => {
    if (!grant || typeof grant !== "object") return false;
    if (String(grant.userId || "") !== String(userId || "")) return false;
    if (String(grant.moduleKey || "") !== String(moduleKey || "")) return false;
    if (String(grant.householdId || "") !== String(householdId || "")) return false;

    const startsAt = Date.parse(String(grant.startsAt || ""));
    const expiresAt = Date.parse(String(grant.expiresAt || ""));
    if (Number.isFinite(startsAt) && now < startsAt) return false;
    if (Number.isFinite(expiresAt) && now > expiresAt) return false;

    const allowedActions = Array.isArray(grant.actions) ? grant.actions.map((x) => String(x || "")) : ["read"];
    return allowedActions.includes("*") || allowedActions.includes(String(action || "read"));
  });
}

async function hasEntitlement({ userId, feature }) {
  if (!feature || feature === "planner.base") return true;

  const policyState = await readAccessPolicyState();
  const userEntitlements = Array.isArray(policyState?.entitlementGrantsByUserId?.[String(userId || "")])
    ? policyState.entitlementGrantsByUserId[String(userId || "")]
    : [];

  return userEntitlements.includes("all") || userEntitlements.includes(feature);
}

module.exports = {
  methodToAction,
  resolveHouseholdAccess,
  hasCollaborationGrant,
  hasEntitlement,
};
