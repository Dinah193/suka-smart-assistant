"use strict";

const ONBOARDING_STAGES = Object.freeze({
  UNAUTHENTICATED: "unauthenticated",
  AUTHENTICATED_UNLINKED: "authenticated_unlinked",
  READY: "ready",
});

const ONBOARDING_ROUTES = Object.freeze({
  SIGN_IN: "/login",
  CREATE_ACCOUNT: "/create-account",
  FORGOT_PASSWORD: "/forgot-password",
  HOUSEHOLD_BOOTSTRAP: "/onboarding/household",
  READY_HOME: "/",
});

const ONBOARDING_REQUIRED_ROUTE_ORDER = Object.freeze([
  ONBOARDING_ROUTES.SIGN_IN,
  ONBOARDING_ROUTES.CREATE_ACCOUNT,
  ONBOARDING_ROUTES.HOUSEHOLD_BOOTSTRAP,
  ONBOARDING_ROUTES.READY_HOME,
]);

function normalizeText(value, fallback = "") {
  return String(value == null ? fallback : value).trim();
}

function resolveOnboardingStage({ user } = {}) {
  const row = user && typeof user === "object" ? user : null;
  if (!row) return ONBOARDING_STAGES.UNAUTHENTICATED;

  const userId = normalizeText(row.userId || row.id);
  if (!userId) return ONBOARDING_STAGES.UNAUTHENTICATED;

  const householdId = normalizeText(row.householdId);
  if (!householdId) return ONBOARDING_STAGES.AUTHENTICATED_UNLINKED;

  return ONBOARDING_STAGES.READY;
}

function resolveOnboardingNextRoute({ stage, returnTo } = {}) {
  const normalizedStage = normalizeText(stage).toLowerCase();
  if (normalizedStage === ONBOARDING_STAGES.AUTHENTICATED_UNLINKED) {
    return ONBOARDING_ROUTES.HOUSEHOLD_BOOTSTRAP;
  }
  if (normalizedStage === ONBOARDING_STAGES.READY) {
    const target = normalizeText(returnTo, ONBOARDING_ROUTES.READY_HOME);
    return target.startsWith("/") ? target : ONBOARDING_ROUTES.READY_HOME;
  }
  return ONBOARDING_ROUTES.SIGN_IN;
}

function buildOnboardingContractPayload({ user, returnTo = ONBOARDING_ROUTES.READY_HOME } = {}) {
  const stage = resolveOnboardingStage({ user });
  const nextRoute = resolveOnboardingNextRoute({ stage, returnTo });
  const householdLinked = stage === ONBOARDING_STAGES.READY;

  return {
    stage,
    nextRoute,
    householdLinked,
    requiredRouteOrder: [...ONBOARDING_REQUIRED_ROUTE_ORDER],
    authRoutes: {
      signIn: ONBOARDING_ROUTES.SIGN_IN,
      createAccount: ONBOARDING_ROUTES.CREATE_ACCOUNT,
      forgotPassword: ONBOARDING_ROUTES.FORGOT_PASSWORD,
      bootstrap: ONBOARDING_ROUTES.HOUSEHOLD_BOOTSTRAP,
      ready: ONBOARDING_ROUTES.READY_HOME,
    },
  };
}

module.exports = {
  ONBOARDING_STAGES,
  ONBOARDING_ROUTES,
  ONBOARDING_REQUIRED_ROUTE_ORDER,
  resolveOnboardingStage,
  resolveOnboardingNextRoute,
  buildOnboardingContractPayload,
};
