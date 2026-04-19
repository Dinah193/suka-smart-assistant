import { describe, expect, it } from "vitest";
const {
  buildOnboardingContractPayload,
  resolveOnboardingNextRoute,
  resolveOnboardingStage,
} = require("../src/server/contracts/onboardingContract.js");

describe("onboarding full-cycle contract", () => {
  it("supports stage transitions and deterministic next route resolution", () => {
    const unauthenticated = resolveOnboardingStage({ user: null });
    const linked = resolveOnboardingStage({
      user: { userId: "u-1", householdId: "h-1" },
    });
    const unlinked = resolveOnboardingStage({ user: { userId: "u-2" } });

    expect(unauthenticated).toBe("unauthenticated");
    expect(unlinked).toBe("authenticated_unlinked");
    expect(linked).toBe("ready");

    expect(resolveOnboardingNextRoute({ stage: unauthenticated })).toBe("/login");
    expect(resolveOnboardingNextRoute({ stage: unlinked })).toBe("/onboarding/household");
    expect(resolveOnboardingNextRoute({ stage: linked, returnTo: "/mealplanner" })).toBe("/mealplanner");
  });

  it("builds full onboarding payload with route map", () => {
    const payload = buildOnboardingContractPayload({
      user: { userId: "u-1", householdId: "h-1" },
      returnTo: "/dashboard",
    });

    expect(payload.stage).toBe("ready");
    expect(payload.nextRoute).toBe("/dashboard");
    expect(payload.householdLinked).toBe(true);
    expect(Array.isArray(payload.requiredRouteOrder)).toBe(true);
    expect(payload.authRoutes.signIn).toBe("/login");
    expect(payload.authRoutes.bootstrap).toBe("/onboarding/household");
  });
});
