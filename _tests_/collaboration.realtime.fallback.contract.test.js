import { describe, expect, it } from "vitest";

const {
  resolveRealtimeFallback,
  buildReplayPayload,
} = require("../src/server/contracts/collaborationRealtimeFallbackContract.js");

describe("collaboration realtime fallback contract", () => {
  it("falls back from websocket to polling after disconnect", () => {
    const fallback = resolveRealtimeFallback({
      state: {
        transport: "websocket",
        lastSequence: 4,
      },
      disconnected: true,
      reason: "socket_closed",
    });

    expect(fallback.transport).toBe("polling");
    expect(fallback.fallbackReason).toBe("socket_closed");
    expect(fallback.lastSequence).toBe(4);
  });

  it("replays missed events in sequence order", () => {
    const replay = buildReplayPayload({
      state: {
        transport: "polling",
        fallbackReason: "connection_lost",
        lastSequence: 7,
      },
      polledEvents: [
        { sequence: 10, type: "decision.updated" },
        { sequence: 8, type: "decision.created" },
        { sequence: 6, type: "decision.ignored" },
      ],
    });

    expect(replay.replayEvents.map((event) => event.sequence)).toEqual([8, 10]);
    expect(replay.lastSequence).toBe(10);
    expect(replay.transport).toBe("polling");
  });
});
