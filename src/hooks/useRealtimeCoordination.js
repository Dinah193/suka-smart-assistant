import { useCallback, useEffect, useMemo, useState } from "react";
import { useSocket } from "@/hooks/useSocket";

function readJsonStorage(key) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function resolveIdentity(overrides = {}) {
  const globalSuka =
    typeof window !== "undefined" && window.__suka ? window.__suka : {};
  const profile =
    overrides.profile ||
    globalSuka.profile ||
    readJsonStorage("suka.profile") ||
    readJsonStorage("suka.user") ||
    {};

  const userId =
    overrides.userId ||
    profile.userId ||
    profile.id ||
    globalSuka.userId ||
    null;

  const familyId =
    overrides.familyId ||
    profile.familyId ||
    globalSuka.familyId ||
    null;

  const householdId =
    overrides.householdId ||
    overrides.homeId ||
    profile.householdId ||
    profile.homeId ||
    globalSuka.householdId ||
    globalSuka.homeId ||
    "default";

  const scope = overrides.scope || (familyId ? "family" : "household");
  const scopeId =
    overrides.scopeId ||
    (scope === "family" ? familyId || "default" : householdId || "default");

  return {
    scope,
    scopeId: String(scopeId || "default"),
    userId: userId ? String(userId) : null,
    familyId: familyId ? String(familyId) : null,
    householdId: householdId ? String(householdId) : "default",
  };
}

function roomForScope(scope, scopeId) {
  return scope === "family" ? `family:${scopeId}` : `home:${scopeId}`;
}

export default function useRealtimeCoordination(overrides = {}) {
  const identity = useMemo(
    () => resolveIdentity(overrides),
    [
      overrides.scope,
      overrides.scopeId,
      overrides.userId,
      overrides.familyId,
      overrides.householdId,
      overrides.homeId,
      overrides.profile,
    ]
  );

  const joinedRooms = useMemo(
    () => [roomForScope(identity.scope, identity.scopeId)],
    [identity.scope, identity.scopeId]
  );

  const sock = useSocket({
    userId: identity.userId,
    alsoJoinRooms: joinedRooms,
  });

  const [suggestions, setSuggestions] = useState([]);
  const [latestReport, setLatestReport] = useState(null);
  const [queueDepth, setQueueDepth] = useState(0);
  const [loading, setLoading] = useState(true);
  const [lastError, setLastError] = useState(null);

  const refreshSuggestions = useCallback(async () => {
    try {
      const res = await sock.emitAck("suggestion:list", {
        scope: identity.scope,
        scopeId: identity.scopeId,
      });
      const next = Array.isArray(res?.suggestions) ? res.suggestions : [];
      setSuggestions(next);
      setQueueDepth(next.filter((x) => !x.consumedAt).length);
      setLastError(null);
      return next;
    } catch (err) {
      setLastError(err);
      return [];
    }
  }, [identity.scope, identity.scopeId, sock]);

  const requestReport = useCallback(async () => {
    try {
      const res = await sock.emitAck("report:request", {
        scope: identity.scope,
        scopeId: identity.scopeId,
      });
      const report = res?.report || null;
      setLatestReport(report);
      setLastError(null);
      return report;
    } catch (err) {
      setLastError(err);
      return null;
    }
  }, [identity.scope, identity.scopeId, sock]);

  const consumeSuggestion = useCallback(
    async (suggestionId) => {
      if (!suggestionId) return null;
      try {
        const res = await sock.emitAck("suggestion:consume", {
          scope: identity.scope,
          scopeId: identity.scopeId,
          suggestionId,
        });

        if (res?.suggestion) {
          setSuggestions((prev) =>
            prev.map((item) =>
              item.id === suggestionId
                ? { ...item, consumedAt: res.suggestion.consumedAt || new Date().toISOString() }
                : item
            )
          );
          setQueueDepth((d) => Math.max(0, d - 1));
        }

        setLastError(null);
        return res?.suggestion || null;
      } catch (err) {
        setLastError(err);
        return null;
      }
    },
    [identity.scope, identity.scopeId, sock]
  );

  const assignSuggestion = useCallback(
    async ({ suggestionId, assignedToUserId = null, assignedRole = null } = {}) => {
      if (!suggestionId) return null;
      try {
        const res = await sock.emitAck("suggestion:assign", {
          scope: identity.scope,
          scopeId: identity.scopeId,
          suggestionId,
          assignedToUserId,
          assignedRole,
        });

        if (res?.suggestion) {
          setSuggestions((prev) =>
            prev.map((item) =>
              item.id === suggestionId
                ? {
                    ...item,
                    assignedToUserId: res.suggestion.assignedToUserId || null,
                    assignedRole: res.suggestion.assignedRole || null,
                    assignmentTs: res.suggestion.assignmentTs || new Date().toISOString(),
                  }
                : item
            )
          );
        }

        setLastError(null);
        return res?.suggestion || null;
      } catch (err) {
        setLastError(err);
        return null;
      }
    },
    [identity.scope, identity.scopeId, sock]
  );

  useEffect(() => {
    if (!sock.connected) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      await Promise.all([refreshSuggestions(), requestReport()]);
      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [sock.connected, refreshSuggestions, requestReport]);

  useEffect(() => {
    const offQueueUpdate = sock.subscribe("suggestion:queue:update", (evt) => {
      if (!evt || String(evt.scopeId) !== String(identity.scopeId)) return;
      if (evt.scope !== identity.scope) return;

      if (Array.isArray(evt.created) && evt.created.length) {
        setSuggestions((prev) => {
          const next = [...evt.created, ...prev];
          const seen = new Set();
          return next.filter((item) => {
            const k = String(item?.id || "");
            if (!k || seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        });
      }
      setQueueDepth(Number(evt.queueDepth || 0));
    });

    const offConsumed = sock.subscribe("suggestion:queue:consumed", (evt) => {
      if (!evt || String(evt.scopeId) !== String(identity.scopeId)) return;
      if (evt.scope !== identity.scope) return;

      setSuggestions((prev) =>
        prev.map((item) =>
          item.id === evt.suggestionId
            ? {
                ...item,
                consumedAt: evt.consumedAt || new Date().toISOString(),
                consumedBy: evt.consumedBy || null,
              }
            : item
        )
      );
      setQueueDepth((d) => Math.max(0, d - 1));
    });

    const offReport = sock.subscribe("report:updated", (report) => {
      if (!report || String(report.scopeId) !== String(identity.scopeId)) return;
      if (report.scope !== identity.scope) return;
      setLatestReport(report);
    });

    const offAssigned = sock.subscribe("suggestion:queue:assigned", (evt) => {
      if (!evt || String(evt.scopeId) !== String(identity.scopeId)) return;
      if (evt.scope !== identity.scope) return;

      setSuggestions((prev) =>
        prev.map((item) =>
          item.id === evt.suggestionId
            ? {
                ...item,
                assignedToUserId: evt.assignedToUserId || null,
                assignedRole: evt.assignedRole || null,
                assignmentTs: evt.assignmentTs || new Date().toISOString(),
              }
            : item
        )
      );
    });

    return () => {
      offQueueUpdate?.();
      offConsumed?.();
      offReport?.();
      offAssigned?.();
    };
  }, [identity.scope, identity.scopeId, sock]);

  return {
    ...identity,
    connected: sock.connected,
    connecting: sock.connecting,
    loading,
    lastError,
    queueDepth,
    suggestions,
    latestReport,
    refreshSuggestions,
    requestReport,
    consumeSuggestion,
    assignSuggestion,
  };
}
