// C:\Users\larho\suka-smart-assistant\src\tests\control.contract.test.js
/**
 * SSA — Control Message Contract Tests
 *
 * Purpose:
 *  - Validates the contract for control messages that travel over the shared eventBus,
 *    WebRTC data channels, sockets, or internal automation runtimes.
 *  - All control payloads MUST follow the canonical envelope:
 *      { type, ts, source, data }
 *    where:
 *      - type: "control.command" | "control.reply" | "control.error" | "control.heartbeat"
 *      - ts: ISO 8601 string (UTC recommended)
 *      - source: stable string identifier of the emitter (e.g., "ui.cooking.play", "svc.automation")
 *      - data: type-specific object (see oneOf below)
 *
 * How this fits the SSA pipeline:
 *  - imports → intelligence → automation → (optional) hub export
 *  - These control messages are primarily consumed in the "automation" and "overlay/remote control"
 *    phases to command sessions, timers, streaming overlays, robots, etc.
 *
 * Forward-thinking:
 *  - Pattern-based action names (lowercase, kebab/underscore/dot allowed) to avoid future collisions.
 *  - Optional `meta` reserved for audit/tracing; `data.params` extensible for domain specifics.
 *  - Clear reply/error/heartbeat variants to support robust orchestration and observability.
 */

import Ajv from "ajv";
import addFormats from "ajv-formats";

/** Build an Ajv instance with formats & strictness tuned for contracts. */
function buildValidator() {
  const ajv = new Ajv({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
    removeAdditional: false,
  });
  addFormats(ajv); // enables "date-time" etc.
  return ajv;
}

/** JSON Schema for control envelope + variants */
const controlSchema = {
  $id: "https://schemas.ssa/control.message.schema.json",
  type: "object",
  additionalProperties: false,
  required: ["type", "ts", "source", "data"],
  properties: {
    type: {
      type: "string",
      pattern: "^control\\.(command|reply|error|heartbeat)$",
      description: "Variant tag under the 'control.*' namespace.",
    },
    ts: {
      type: "string",
      format: "date-time",
      description: "ISO 8601 timestamp for when the message was emitted.",
    },
    source: {
      type: "string",
      minLength: 3,
      maxLength: 128,
      pattern: "^[a-z][a-z0-9._:-]+$",
      description:
        "Emitter identifier (e.g., 'ui.cooking.play', 'svc.automation', 'agent.cleaning').",
    },
    meta: {
      type: "object",
      additionalProperties: true,
      description:
        "Optional tracing/audit context (requestId, sessionId, room, userId, etc.).",
    },
    data: {
      oneOf: [
        { $ref: "#/$defs/command" },
        { $ref: "#/$defs/reply" },
        { $ref: "#/$defs/error" },
        { $ref: "#/$defs/heartbeat" },
      ],
    },
  },
  allOf: [
    {
      if: { properties: { type: { const: "control.command" } }, required: ["type"] },
      then: {
        properties: {
          data: { $ref: "#/$defs/command" },
        },
      },
    },
    {
      if: { properties: { type: { const: "control.reply" } }, required: ["type"] },
      then: {
        properties: {
          data: { $ref: "#/$defs/reply" },
        },
      },
    },
    {
      if: { properties: { type: { const: "control.error" } }, required: ["type"] },
      then: {
        properties: {
          data: { $ref: "#/$defs/error" },
        },
      },
    },
    {
      if: { properties: { type: { const: "control.heartbeat" } }, required: ["type"] },
      then: {
        properties: {
          data: { $ref: "#/$defs/heartbeat" },
        },
      },
    },
  ],
  $defs: {
    // control.command
    command: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "id", "action"],
      properties: {
        kind: { const: "command" },
        id: {
          type: "string",
          minLength: 8,
          maxLength: 64,
          pattern: "^[A-Za-z0-9._:-]+$",
          description: "Client-generated command id (uuid/ulid/snowflake acceptable).",
        },
        action: {
          type: "string",
          minLength: 3,
          maxLength: 64,
          pattern: "^[a-z][a-z0-9._-]+$",
          description:
            "Action verb (e.g., 'session.start', 'timer.pause', 'overlay.sync', 'garden.plan').",
        },
        target: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          pattern: "^[A-Za-z0-9._:/-]+$",
          description:
            "Optional addressable target (room id, device id, session id, domain path).",
        },
        scope: {
          type: "string",
          enum: ["local", "household", "room", "global"],
          default: "local",
        },
        ack: {
          type: "string",
          enum: ["none", "immediate", "executed"],
          default: "immediate",
        },
        params: {
          type: "object",
          additionalProperties: true, // domain-specific knobs (forward-compatible)
        },
      },
    },

    // control.reply
    reply: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "inReplyTo", "status"],
      properties: {
        kind: { const: "reply" },
        inReplyTo: {
          type: "string",
          minLength: 8,
          maxLength: 64,
          pattern: "^[A-Za-z0-9._:-]+$",
          description: "Matches the original command 'id'.",
        },
        status: {
          type: "string",
          enum: ["ok", "accepted", "queued", "executed"],
        },
        result: {
          type: "object",
          additionalProperties: true,
          description: "Optional structured result payload.",
        },
        durationMs: {
          type: "number",
          minimum: 0,
        },
      },
    },

    // control.error
    error: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "code", "message"],
      properties: {
        kind: { const: "error" },
        inReplyTo: {
          type: "string",
          minLength: 8,
          maxLength: 64,
          pattern: "^[A-Za-z0-9._:-]+$",
          description: "If error is a response to a command, include its 'id'.",
        },
        code: {
          type: "string",
          minLength: 3,
          maxLength: 64,
          pattern: "^[A-Z0-9_]+$",
          description: "Machine-friendly error code (e.g., INVALID_PARAMS, NOT_FOUND).",
        },
        message: { type: "string", minLength: 1, maxLength: 400 },
        details: {
          type: "object",
          additionalProperties: true,
        },
      },
    },

    // control.heartbeat
    heartbeat: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "seq", "intervalMs"],
      properties: {
        kind: { const: "heartbeat" },
        seq: { type: "integer", minimum: 0 },
        intervalMs: { type: "integer", minimum: 100 },
        info: {
          type: "object",
          additionalProperties: true,
          description: "Optional live info (load, battery, network, capabilities).",
        },
      },
    },
  },
};

const ajv = buildValidator();
const validate = ajv.compile(controlSchema);

/** Utility: Build the common envelope quickly */
function envelope({ type, source, data, ts = new Date().toISOString(), meta }) {
  return { type, ts, source, data, ...(meta ? { meta } : {}) };
}

/** ------------------------------ TESTS ----------------------------------- */

describe("Control Message Contract", () => {
  test("accepts a valid control.command (session.start)", () => {
    const msg = envelope({
      type: "control.command",
      source: "ui.cooking.play",
      data: {
        kind: "command",
        id: "cmd_01JABCDXYZ",
        action: "session.start",
        target: "session:abc123",
        scope: "local",
        ack: "immediate",
        params: {
          domain: "cooking",
          recipeId: "r_99xy",
          timers: [{ id: "t1", ms: 300000 }],
          preferences: { doneness: "medium", units: "imperial" },
        },
      },
      meta: {
        userId: "u_42",
        room: "living-room-tv",
        trace: "trace_12345",
      },
    });

    const ok = validate(msg);
    if (!ok) {
      // Easier debugging in CI
      console.error(validate.errors);
    }
    expect(ok).toBe(true);
  });

  test("rejects non-ISO timestamp", () => {
    const msg = envelope({
      type: "control.command",
      source: "ui.cooking.play",
      data: {
        kind: "command",
        id: "cmd_badts",
        action: "timer.start",
      },
      ts: "11/08/2025 07:30", // not ISO
    });

    const ok = validate(msg);
    expect(ok).toBe(false);
    // At least one error points to the ts
    const hasTsError = (validate.errors || []).some((e) => e.instancePath === "/ts");
    expect(hasTsError).toBe(true);
  });

  test("rejects action with invalid casing (must be lowercase)", () => {
    const msg = envelope({
      type: "control.command",
      source: "ui.overlay.remote",
      data: {
        kind: "command",
        id: "cmd_case",
        action: "Timer.Start", // invalid (capital T/S not allowed by pattern)
      },
    });
    const ok = validate(msg);
    expect(ok).toBe(false);
  });

  test("rejects missing 'data.id' for command", () => {
    const msg = envelope({
      type: "control.command",
      source: "svc.automation",
      data: {
        kind: "command",
        // id missing
        action: "inventory.sync",
      },
    });
    const ok = validate(msg);
    expect(ok).toBe(false);
  });

  test("accepts a valid control.reply", () => {
    const msg = envelope({
      type: "control.reply",
      source: "svc.automation",
      data: {
        kind: "reply",
        inReplyTo: "cmd_01JABCDXYZ",
        status: "executed",
        result: {
          sessionId: "session:abc123",
          startedAt: "2025-11-08T13:20:00.000Z",
        },
        durationMs: 42,
      },
    });
    const ok = validate(msg);
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
  });

  test("accepts a valid control.error", () => {
    const msg = envelope({
      type: "control.error",
      source: "svc.automation",
      data: {
        kind: "error",
        inReplyTo: "cmd_01JERR",
        code: "INVALID_PARAMS",
        message: "Timer duration must be > 0",
        details: { param: "ms", value: -1 },
      },
    });
    const ok = validate(msg);
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
  });

  test("rejects control.error with lowercase code", () => {
    const msg = envelope({
      type: "control.error",
      source: "svc.automation",
      data: {
        kind: "error",
        code: "invalid_params", // must be UPPER_SNAKE per contract
        message: "nope",
      },
    });
    const ok = validate(msg);
    expect(ok).toBe(false);
  });

  test("accepts a valid control.heartbeat", () => {
    const msg = envelope({
      type: "control.heartbeat",
      source: "ui.remote.phone",
      data: {
        kind: "heartbeat",
        seq: 101,
        intervalMs: 5000,
        info: {
          battery: 0.87,
          network: "wifi",
          roles: ["remote", "overlay-controller"],
        },
      },
    });
    const ok = validate(msg);
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
  });

  test("rejects unexpected top-level properties", () => {
    const msg = {
      // extra 'version' should fail due to additionalProperties:false
      version: 1,
      ...envelope({
        type: "control.heartbeat",
        source: "ui.remote.phone",
        data: { kind: "heartbeat", seq: 1, intervalMs: 2000 },
      }),
    };
    const ok = validate(msg);
    expect(ok).toBe(false);
  });

  test("data variant must match 'type' variant", () => {
    const msg = envelope({
      type: "control.reply",
      source: "svc.automation",
      data: {
        kind: "command", // mismatch (reply expected)
        id: "cmd_oops",
        action: "session.stop",
      },
    });
    const ok = validate(msg);
    expect(ok).toBe(false);
  });
});

/** Optional: export schema for reuse by runtime validators (if tests are imported elsewhere). */
export { controlSchema };
