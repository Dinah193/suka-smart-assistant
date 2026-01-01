// C:\Users\larho\suka-smart-assistant\src\tests\calculators\health\MacroCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for MacroCalculator logic and SessionRunner-style integration.
//
// Assumptions about MacroCalculator.logic.js public API:
//
//   export function calculateMacros(profile)
//   export function createMacroSessionFromProfile(profile, options?)
//
// Where `profile` looks like:
//   {
//     sex: "female" | "male",
//     ageYears: number,
//     heightCm: number,
//     weightKg: number,
//     activityLevel: "sedentary" | "light" | "moderate" | "active" | "athlete",
//     goal: "lose" | "maintain" | "gain"
//   }
//
// And `calculateMacros(profile)` returns:
//
//   {
//     calories: number,
//     proteinGrams: number,
//     fatGrams: number,
//     carbGrams: number,
//     method: "mifflin-st-jeor" | string
//   }
//
// And `createMacroSessionFromProfile(profile, options?)` returns a session
// object that satisfies the SSA SessionRunner minimal contract:
//
//   {
//     id: string,
//     domain: "cooking",
//     title: string,
//     source: { type: "manual", refId: null } | {...},
//     steps: [
//       {
//         id: string,
//         title: string,
//         desc: string,
//         durationSec: number,
//         blockers: string[],
//         metadata: {
//           tempTargetF: number,
//           donenessCue: string,
//           cueNotes: string
//         }
//       },
//       ...
//     ],
//     prefs: { voiceGuidance: boolean, haptic: boolean, autoAdvance: boolean },
//     status: "pending",
//     progress: {
//       currentStepIndex: 0,
//       elapsedSec: 0,
//       startedAt: null,
//       pausedAt: null
//     },
//     analytics: { skippedSteps: [], adjustments: [] },
//     createdAt: string (ISO),
//     updatedAt: string (ISO)
//   }
//
// If your actual logic file uses slightly different names, either:
//   - Update your logic to match this API, OR
//   - Adjust these tests accordingly.
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  calculateMacros,
  createMacroSessionFromProfile
} from "@/features/calculators/health/MacroCalculator.logic.js";

// Helper: base profile used in multiple tests
const BASE_PROFILE = Object.freeze({
  sex: "female",
  ageYears: 35,
  heightCm: 165,
  weightKg: 80,
  activityLevel: "light",
  goal: "lose"
});

describe("MacroCalculator.calculateMacros", () => {
  it("returns an object with calories and macro grams for a valid profile", () => {
    const result = calculateMacros(BASE_PROFILE);

    expect(result).toBeTruthy();
    expect(typeof result).toBe("object");

    // Core fields
    expect(typeof result.calories).toBe("number");
    expect(typeof result.proteinGrams).toBe("number");
    expect(typeof result.fatGrams).toBe("number");
    expect(typeof result.carbGrams).toBe("number");

    // Reasonable ranges (not exact values, just sanity checks)
    expect(result.calories).toBeGreaterThan(1000);
    expect(result.calories).toBeLessThan(3000);

    expect(result.proteinGrams).toBeGreaterThan(40);
    expect(result.proteinGrams).toBeLessThan(250);

    expect(result.fatGrams).toBeGreaterThan(20);
    expect(result.fatGrams).toBeLessThan(200);

    expect(result.carbGrams).toBeGreaterThan(30);
    expect(result.carbGrams).toBeLessThan(400);

    // Optional method identifier
    if (result.method) {
      expect(typeof result.method).toBe("string");
    }
  });

  it("adapts calories for different goals (lose vs maintain vs gain)", () => {
    const loseProfile = { ...BASE_PROFILE, goal: "lose" };
    const maintainProfile = { ...BASE_PROFILE, goal: "maintain" };
    const gainProfile = { ...BASE_PROFILE, goal: "gain" };

    const lose = calculateMacros(loseProfile);
    const maintain = calculateMacros(maintainProfile);
    const gain = calculateMacros(gainProfile);

    // In general: lose < maintain < gain
    expect(lose.calories).toBeLessThan(maintain.calories);
    expect(maintain.calories).toBeLessThan(gain.calories);
  });

  it("increases calories with higher activity level", () => {
    const sedentary = calculateMacros({
      ...BASE_PROFILE,
      activityLevel: "sedentary"
    });
    const moderate = calculateMacros({
      ...BASE_PROFILE,
      activityLevel: "moderate"
    });
    const athlete = calculateMacros({
      ...BASE_PROFILE,
      activityLevel: "athlete"
    });

    expect(sedentary.calories).toBeLessThan(moderate.calories);
    expect(moderate.calories).toBeLessThan(athlete.calories);
  });

  it("throws or returns null for clearly invalid input", () => {
    const badProfile = {
      ...BASE_PROFILE,
      ageYears: -5,
      heightCm: 0,
      weightKg: 0
    };

    let threw = false;
    let result = undefined;

    try {
      // If your implementation prefers returning null on invalid input,
      // this test still passes (we check both code paths).
      result = calculateMacros(badProfile);
    } catch (err) {
      threw = true;
    }

    if (!threw) {
      expect(result).toBeNull();
    }
  });
});

describe("MacroCalculator.createMacroSessionFromProfile", () => {
  it("returns a session that conforms to the SSA SessionRunner minimal contract", () => {
    const session = createMacroSessionFromProfile(BASE_PROFILE, {
      sessionId: "test-macro-session-1"
    });

    // Top-level structural checks
    expect(session).toBeTruthy();
    expect(typeof session).toBe("object");

    expect(typeof session.id).toBe("string");
    expect(session.id.length).toBeGreaterThan(0);

    // Domain must be one of the allowed SSA domains
    // Here we assume macros sessions are part of cooking domain.
    expect(session.domain).toBe("cooking");

    expect(typeof session.title).toBe("string");
    expect(session.title.length).toBeGreaterThan(0);

    // Source
    expect(session.source).toBeTruthy();
    expect(typeof session.source).toBe("object");
    expect(typeof session.source.type).toBe("string");
    expect(["manual", "import", "recipe"].includes(session.source.type)).toBe(
      true
    );

    // Steps
    expect(Array.isArray(session.steps)).toBe(true);
    expect(session.steps.length).toBeGreaterThan(0);

    session.steps.forEach((step) => {
      expect(typeof step.id).toBe("string");
      expect(step.id.length).toBeGreaterThan(0);

      expect(typeof step.title).toBe("string");
      expect(step.title.length).toBeGreaterThan(0);

      expect(typeof step.desc).toBe("string");

      expect(typeof step.durationSec).toBe("number");
      expect(step.durationSec).toBeGreaterThanOrEqual(0);

      expect(Array.isArray(step.blockers)).toBe(true);
      step.blockers.forEach((b) => {
        expect(typeof b).toBe("string");
      });

      // metadata must exist even if mostly zeros/defaults
      expect(step.metadata).toBeTruthy();
      expect(typeof step.metadata).toBe("object");
      expect(typeof step.metadata.tempTargetF).toBe("number");
      expect(typeof step.metadata.donenessCue).toBe("string");
      expect(typeof step.metadata.cueNotes).toBe("string");
    });

    // Prefs
    expect(session.prefs).toBeTruthy();
    expect(typeof session.prefs).toBe("object");
    expect(typeof session.prefs.voiceGuidance).toBe("boolean");
    expect(typeof session.prefs.haptic).toBe("boolean");
    expect(typeof session.prefs.autoAdvance).toBe("boolean");

    // Status & progress
    expect([
      "pending",
      "running",
      "paused",
      "completed",
      "aborted"
    ]).toContain(session.status);

    expect(session.progress).toBeTruthy();
    expect(typeof session.progress).toBe("object");
    expect(typeof session.progress.currentStepIndex).toBe("number");
    expect(typeof session.progress.elapsedSec).toBe("number");

    // startedAt / pausedAt may be null or ISO strings
    if (session.progress.startedAt !== null) {
      expect(typeof session.progress.startedAt).toBe("string");
    }
    if (session.progress.pausedAt !== null) {
      expect(typeof session.progress.pausedAt).toBe("string");
    }

    // Analytics
    expect(session.analytics).toBeTruthy();
    expect(Array.isArray(session.analytics.skippedSteps)).toBe(true);
    expect(Array.isArray(session.analytics.adjustments)).toBe(true);

    // Timestamps
    expect(typeof session.createdAt).toBe("string");
    expect(typeof session.updatedAt).toBe("string");
    // Basic ISO check: contains "T"
    expect(session.createdAt.includes("T")).toBe(true);
    expect(session.updatedAt.includes("T")).toBe(true);
  });

  it("bakes calculated macros into the first step description or notes", () => {
    const session = createMacroSessionFromProfile(BASE_PROFILE, {
      sessionId: "test-macro-session-2"
    });

    const firstStep = session.steps[0];
    expect(firstStep).toBeTruthy();

    const blob = `${firstStep.title} ${firstStep.desc} ${firstStep.metadata.cueNotes}`.toLowerCase();

    // We expect to see words referencing macros, which helps ensure
    // the session is actually derived from the macro calculation.
    expect(
      blob.includes("calorie") ||
        blob.includes("calories") ||
        blob.includes("protein") ||
        blob.includes("carb") ||
        blob.includes("fat")
    ).toBe(true);
  });

  it("produces deterministic IDs when sessionId is provided", () => {
    const s1 = createMacroSessionFromProfile(BASE_PROFILE, {
      sessionId: "macro-session-deterministic"
    });
    const s2 = createMacroSessionFromProfile(BASE_PROFILE, {
      sessionId: "macro-session-deterministic"
    });

    // If you intentionally add a random suffix, adjust this test.
    expect(s1.id).toBe(s2.id);
  });
});
