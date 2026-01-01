// C:\Users\larho\suka-smart-assistant\src\tests\session.play.mapper.test.js
// Unit tests for mappers/draftToPlay.js
// - Deterministic IDs
// - Domain normalization
// - Timers extraction
// - Cursor clamping
// - Streamer-safe redaction in meta
// - Envelope shape conformance (session.play.start)
//
// Test runner: works with Jest or Vitest.
//   jest:   npx jest src/tests/session.play.mapper.test.js
//   vitest: npx vitest run src/tests/session.play.mapper.test.js

const {
  draftToPlayStartEnvelope,
  buildOnly,
  __test__: {
    computeSessionId,
    extractTimers,
    normalizeDomain,
    computeStartIndex,
    redact,
  },
} = require("../mappers/draftToPlay.js");

// Small helper: ISO-8601-ish check
function isISODateString(s) {
  if (typeof s !== "string") return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

describe("draftToPlay mapper", () => {
  const baseDraft = {
    id: "draft_abc",
    domain: "cooking",
    title: "Fancy Omelette [[private]](phone: 555-123-4567)[[/private]]",
    notes: "Beat eggs. [[private]]secret spice[[/private]]",
    version: "1.0.0",
    steps: [
      { title: "Crack eggs", durationMs: 30000 },
      { title: "Whisk", timer: { label: "whisk", durationMs: 20000 } },
      { title: "Cook", note: "low heat" },
    ],
    privacy: { streamerSafe: true },
  };

  test("normalizeDomain handles supported values and aliases", () => {
    expect(normalizeDomain("cooking")).toBe("cooking");
    expect(normalizeDomain("CLEANING")).toBe("cleaning");
    expect(normalizeDomain("garden")).toBe("garden");
    expect(normalizeDomain("animal")).toBe("animals"); // alias
    expect(normalizeDomain("animals")).toBe("animals");
    expect(normalizeDomain("preservation")).toBe("preservation");
    expect(normalizeDomain("storehouse")).toBe("storehouse");
    // unknown defaults to cooking
    expect(normalizeDomain("unknown-x")).toBe("cooking");
  });

  test("computeSessionId is deterministic for same draft and stable across calls", () => {
    const id1 = computeSessionId(baseDraft);
    const id2 = computeSessionId({ ...baseDraft }); // shallow copy
    expect(id1).toBe(id2);
    expect(typeof id1).toBe("string");
    expect(id1.length).toBeLessThanOrEqual(24);
    expect(id1.startsWith("cooking_")).toBe(true);
  });

  test("different drafts produce different sessionIds", () => {
    const draftB = { ...baseDraft, title: "Pancakes" };
    const idA = computeSessionId(baseDraft);
    const idB = computeSessionId(draftB);
    expect(idA).not.toBe(idB);
  });

  test("extractTimers finds timers from step.durationMs and step.timer.durationMs", () => {
    const timers = extractTimers(baseDraft);
    expect(Array.isArray(timers)).toBe(true);
    // first step via durationMs, second via timer.durationMs, third none
    expect(timers.length).toBe(2);
    expect(timers[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        label: expect.any(String),
        durationMs: 30000,
      })
    );
    expect(timers[1]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        durationMs: 20000,
      })
    );
  });

  test("computeStartIndex clamps to valid range", () => {
    const steps = [{}, {}, {}, {}];
    const draft = { ...baseDraft, steps };
    expect(computeStartIndex(draft, -5)).toBe(0);
    expect(computeStartIndex(draft, 0)).toBe(0);
    expect(computeStartIndex(draft, 3)).toBe(3);
    expect(computeStartIndex(draft, 999)).toBe(3);
    // when not provided, default 0
    expect(computeStartIndex(draft)).toBe(0);
    // honors draft.startAtStepIndex when not overridden
    expect(computeStartIndex({ ...draft, startAtStepIndex: 2 })).toBe(2);
  });

  test("redact removes [[private]] blocks and obvious sensitive patterns when streamerSafe=true", () => {
    const original = "hello [[private]]secret 555-555-5555 12:34[[/private]] world";
    const redacted = redact(original, true);
    expect(redacted).toContain("hello");
    expect(redacted).toContain("world");
    expect(redacted).not.toContain("secret");
    expect(redacted).not.toContain("555-555-5555");
    expect(redacted).not.toContain("12:34");
    expect(redact(original, false)).toBe(original);
  });

  test("draftToPlayStartEnvelope builds a valid session.play.start envelope with defaults", () => {
    const { envelope, meta } = draftToPlayStartEnvelope(baseDraft);
    expect(envelope).toBeDefined();
    expect(envelope.type).toBe("session.play.start");
    expect(isISODateString(envelope.ts)).toBe(true);
    expect(typeof envelope.source).toBe("string");
    expect(envelope.data).toBeDefined();

    const d = envelope.data;
    expect(d.domain).toBe("cooking");
    expect(typeof d.sessionId).toBe("string");
    expect(d.draftId).toBe("draft_abc");
    expect(typeof d.streamerSafe).toBe("boolean");
    expect(typeof d.startAtStepIndex).toBe("number");
    // speech & keepAwake default undefined/false
    expect(d.keepAwake).toBe(false);
    // meta attached by default
    expect(d.meta).toEqual(meta);

    // meta is redacted when streamerSafe
    expect(meta.title).not.toContain("555");
    expect(meta.notes).not.toContain("secret");
    expect(meta.timers.length).toBe(2);
    expect(meta.steps).toBe(3);
  });

  test("options override: startAtStepIndex, keepAwake, speech, room, source", () => {
    const opts = {
      startAtStepIndex: 5, // will clamp to 2 (since 3 steps)
      keepAwake: true,
      speech: { enabled: true, rate: 1.2 },
      room: "ROOM123",
      source: "tests.session",
    };
    const { envelope } = draftToPlayStartEnvelope(baseDraft, opts);
    expect(envelope.source).toBe("tests.session");

    const d = envelope.data;
    expect(d.keepAwake).toBe(true);
    expect(d.room).toBe("ROOM123");
    expect(d.speech).toEqual({ enabled: true, rate: 1.2 });
    expect(d.startAtStepIndex).toBe(2); // clamped to last step index
  });

  test("attachMeta=false excludes meta from envelope (still returned via helper)", () => {
    const { envelope, meta } = draftToPlayStartEnvelope(baseDraft, { attachMeta: false });
    expect(meta).toBeDefined();
    expect(envelope.data.meta).toBeUndefined();
  });

  test("buildOnly forwards to draftToPlayStartEnvelope and does not mutate", () => {
    const before = JSON.parse(JSON.stringify(baseDraft));
    const { envelope, meta } = buildOnly(baseDraft);
    expect(envelope.type).toBe("session.play.start");
    // base draft remains unchanged
    expect(baseDraft).toEqual(before);
    // reasonable meta
    expect(meta.steps).toBe(3);
  });

  test("domain alias 'animal' is normalized to 'animals' in the envelope", () => {
    const draft = { ...baseDraft, domain: "animal" };
    const { envelope } = draftToPlayStartEnvelope(draft);
    expect(envelope.data.domain).toBe("animals");
  });

  test("envelope has a valid ISO timestamp", () => {
    const { envelope } = draftToPlayStartEnvelope(baseDraft);
    expect(isISODateString(envelope.ts)).toBe(true);
  });
});
