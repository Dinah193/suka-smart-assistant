// C:\Users\larho\suka-smart-assistant\src\tests\overlay.payloads.test.js
// Ensures streamerSafe scrubFields are applied to overlay-bound payloads.
//
// What this validates in the SSA pipeline (imports → intelligence → automation → overlay):
// - When a payload is marked { streamerSafe: true } and provides an explicit list
//   of `scrubFields`, the overlay payload builder MUST sanitize those fields.
// - Fields not listed in `scrubFields` stay intact.
// - Works with nested keys using dot-notation and array indices (e.g. "steps.0.note").
// - Non-string values (objects, arrays, numbers) are replaced with "[redacted]" as well.
// - When streamerSafe = false, the sanitizer is a no-op.
//
// Target module (to be implemented if missing):
//   src/overlay/overlayPayloads.js
//   export function applyStreamerSafeScrub(payload: object, scrubFields?: string[], redaction?: string): object
//
// If you haven't created the implementation yet, generate it next. These tests
// define the expected behavior and will guide your implementation.
//
// Run with Jest or Vitest:
//   npx jest   src/tests/overlay.payloads.test.js
//   npx vitest run src/tests/overlay.payloads.test.js

let applyStreamerSafeScrub;

// Try to import the real implementation; if missing, tests will still load and fail clearly.
try {
  ({ applyStreamerSafeScrub } = require("../overlay/overlayPayloads.js"));
} catch (e) {
  // Provide a sentinel function so the test suite loads; individual tests will fail
  // with a helpful message pointing to the missing implementation.
  applyStreamerSafeScrub = () => {
    throw new Error(
      "applyStreamerSafeScrub not found. Create src/overlay/overlayPayloads.js exporting applyStreamerSafeScrub(payload, scrubFields, redaction?)"
    );
  };
}

// Small helpers for nested assertions
function getAt(obj, path) {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  return parts.reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

describe("overlay payloads — streamerSafe scrubFields", () => {
  const base = {
    type: "overlay.show",
    ts: "2025-11-07T00:00:00.000Z",
    source: "tests.overlay",
    data: {
      domain: "cooking",
      sessionId: "sess_abc",
      streamerSafe: true,
      title: "Grandma’s Phone [[private]]555-123-4567[[/private]]",
      notes: "Use secret spice [[private]]MSG[[/private]] at 12:34",
      author: { name: "Nana", email: "nana@example.com" },
      steps: [
        { title: "Prep", note: "Pantry code 1234" },
        { title: "Cook", note: "Whisper the passphrase" },
      ],
      meta: {
        address: {
          line1: "12 Secret St",
          city: "Somewhere",
        },
        contact: {
          phone: "555-222-3333",
        },
      },
    },
  };

  test("no-op when streamerSafe=false", () => {
    const payload = {
      ...base,
      data: { ...base.data, streamerSafe: false },
    };
    const result = applyStreamerSafeScrub(payload, ["title", "notes", "author.email"]);
    expect(result.data.title).toBe(base.data.title);
    expect(result.data.notes).toBe(base.data.notes);
    expect(result.data.author.email).toBe(base.data.author.email);
  });

  test("scrubs top-level fields listed in scrubFields", () => {
    const result = applyStreamerSafeScrub(base, ["title", "notes"]);
    expect(result.data.title).toBe("[redacted]");
    expect(result.data.notes).toBe("[redacted]");
    // untouched neighbor
    expect(result.data.author.name).toBe("Nana");
  });

  test("scrubs nested dot-notation paths (author.email, meta.address.line1)", () => {
    const result = applyStreamerSafeScrub(base, ["author.email", "meta.address.line1"]);
    expect(result.data.author.email).toBe("[redacted]");
    expect(result.data.meta.address.line1).toBe("[redacted]");
    // do not over-scrub siblings
    expect(result.data.meta.address.city).toBe("Somewhere");
  });

  test("scrubs array indices (steps.0.note) without mutating other items", () => {
    const result = applyStreamerSafeScrub(base, ["steps.0.note"]);
    expect(result.data.steps[0].note).toBe("[redacted]");
    expect(result.data.steps[0].title).toBe("Prep");
    // second step untouched
    expect(result.data.steps[1].note).toBe("Whisper the passphrase");
  });

  test("replaces non-string values with [redacted] as well", () => {
    // scrub entire meta.address object and steps array
    const result = applyStreamerSafeScrub(base, ["meta.address", "steps"]);
    expect(result.data.meta.address).toBe("[redacted]");
    expect(result.data.steps).toBe("[redacted]");
  });

  test("custom redaction token is honored", () => {
    const result = applyStreamerSafeScrub(base, ["title"], "***");
    expect(result.data.title).toBe("***");
  });

  test("does not throw when scrubFields includes unknown/missing paths", () => {
    expect(() =>
      applyStreamerSafeScrub(base, ["does.not.exist", "meta.contact.fax"])
    ).not.toThrow();
    const result = applyStreamerSafeScrub(base, ["does.not.exist", "meta.contact.fax"]);
    expect(getAt(result, "data.meta.contact.fax")).toBeUndefined();
  });

  test("returns a new object (does not mutate original payload)", () => {
    const clone = JSON.parse(JSON.stringify(base));
    const result = applyStreamerSafeScrub(clone, ["title"]);
    expect(result).not.toBe(clone);
    expect(result.data).not.toBe(clone.data);
    // original remains intact
    expect(clone.data.title).toContain("555-123-4567");
  });

  test("idempotent scrubbing: reapplying does not change other fields", () => {
    const once = applyStreamerSafeScrub(base, ["title", "author.email"]);
    const twice = applyStreamerSafeScrub(once, ["title", "author.email"]);
    expect(twice.data.title).toBe("[redacted]");
    expect(twice.data.author.email).toBe("[redacted]");
    // unrelated field should remain equal
    expect(twice.data.domain).toBe(once.data.domain);
  });
});
