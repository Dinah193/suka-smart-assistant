// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { emitCanonicalSignalMock, useRealtimeCoordinationMock } = vi.hoisted(() => ({
  emitCanonicalSignalMock: vi.fn(async () => ({ ok: true })),
  useRealtimeCoordinationMock: vi.fn(),
}));

vi.mock("../src/services/realtime/canonicalSignalEmitter", () => ({
  emitCanonicalSignal: (...args) => emitCanonicalSignalMock(...args),
}));

vi.mock("../src/hooks/useRealtimeCoordination", () => ({
  default: (...args) => useRealtimeCoordinationMock(...args),
}));

import RealtimeCoordinationPanel from "../src/components/home/RealtimeCoordinationPanel.jsx";

describe("realtime coordination readiness actions contract", () => {
  let container;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    emitCanonicalSignalMock.mockReset();
    useRealtimeCoordinationMock.mockReset();

    useRealtimeCoordinationMock.mockReturnValue({
      scope: "household",
      scopeId: "home-1",
      queueDepth: 3,
      connected: true,
      connecting: false,
      userId: "user-1",
      suggestions: [
        { id: "s1", consumedAt: null, priorityScore: 95, assignedToUserId: null, assignedRole: null },
        {
          id: "s2",
          consumedAt: null,
          priorityScore: 70,
          assignedToUserId: "user-2",
          assignedRole: null,
          assignmentTs: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
        },
      ],
      latestReport: { generatedAt: new Date().toISOString(), summary: {} },
      refreshSuggestions: vi.fn(async () => {}),
      requestReport: vi.fn(async () => {}),
      consumeSuggestion: vi.fn(async () => {}),
      assignSuggestion: vi.fn(async () => {}),
      lastError: null,
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("emits readiness and conflict signals from readiness actions", async () => {
    await act(async () => {
      root.render(React.createElement(RealtimeCoordinationPanel));
    });

    const text = String(container.textContent || "");
    expect(text).toContain("Collaboration readiness");
    expect(text).toContain("Unassigned: 1");
    expect(text).toContain("Priority 80+: 1");
    expect(text).toContain("Stale assigned: 1");

    const broadcastButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      String(btn.textContent || "").includes("Broadcast readiness")
    );
    const conflictButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      String(btn.textContent || "").includes("Flag collaboration conflict")
    );

    expect(broadcastButton).toBeTruthy();
    expect(conflictButton).toBeTruthy();

    await act(async () => {
      broadcastButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      conflictButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(emitCanonicalSignalMock).toHaveBeenCalledTimes(2);
    expect(emitCanonicalSignalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "taskStarted",
        sourceModule: "realtime.coordination",
        payload: expect.objectContaining({
          reason: "readiness_ping",
          totals: expect.objectContaining({
            unassigned: 1,
            highPriority: 1,
            staleAssigned: 1,
          }),
        }),
      })
    );
    expect(emitCanonicalSignalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "inventoryShortage",
        sourceModule: "realtime.coordination",
        payload: expect.objectContaining({
          reason: "collaboration_conflict",
          unassigned: 1,
          staleAssigned: 1,
        }),
      })
    );
  });
});
