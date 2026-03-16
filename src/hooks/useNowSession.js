/**
 * src/hooks/useNowSession.js
 * -----------------------------------------------------------------------------
 * useNowSession — "Now" resolver for SSA domain pages
 *
 * Purpose:
 * - Find the next *runnable* session for a given domain (cooking, cleaning, etc.)
 * - Evaluate guard blockers (sabbath, quietHours, weather, inventory, equipment, battery)
 * - If multiple candidates are runnable, expose a light-weight selector list
 * - Provide a single `run()` helper that opens the SessionRunner modal via eventBus
 *
 * How it fits:
 * - Domain pages render a prominent "Now" CTA. They call this hook with { domain }
 *   and wire the returned `run()` to the CTA. If there are multiple runnable sessions,
 *   this hook emits a `ui.selector.request` event AND returns `pickList` for UI rendering.
 * - The SessionRunner modal is expected to be mounted at app root and listens for
 *   `ui.sessionrunner.open` events: { sessionId }.
 *
 * Events (payload shape: { type, ts, source, data }):
 * - domain.now.requested      → when `refresh()` starts
 * - domain.now.resolved       → candidates + firstRunnable
 * - domain.now.blocked        → when all candidates are blocked (reasons attached)
 * - ui.selector.request       → when multiple runnable candidates exist
 * - ui.selector.dismiss       → when selection flow is dismissed programmatically
 * - ui.sessionrunner.open     → when run() triggers modal opening
 * - domain.now.error          → unexpected errors
 *
 * Resilience:
 * - Safe in SSR; soft-imports all modules; Dexie access is guarded
 * - If a guard file is missing, it is treated as "pass"
 * - If SessionsRepo missing, falls back to simple Dexie table lookup (best effort)
 *
 * Returned API:
 *   const {
 *     loading, error,
 *     candidates,             // raw candidates (pending/running/paused), newest first
 *     pickList,               // runnable subset (sorted)
 *     firstRunnable,          // best pick or null
 *     refresh,                // re-scan store and recompute guards
 *     check,                  // check( session ) → { ok, reasons[] }
 *     run,                    // run( session? ) → open runner or emit selector
 *   } = useNowSession({ domain, selectorTitle?, includePaused?=false })
 *
 * Notes:
 * - Guard evaluation runs on the first step of each session (currentStepIndex).
 *   If a step is missing/invalid, the session is considered runnable with a warning.
 * - You can pipe `pickList` to your own minimal selector UI. If you don't, users
 *   can still select from a global selector modal if your app listens to
 *   `ui.selector.request`.
 * -----------------------------------------------------------------------------
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import eventBus from "@/services/events/eventBus";
import { featureFlags } from "@/config/featureFlags";

const SOURCE = "hooks.useNowSession";
const isoNow = () => new Date().toISOString();
const emit = (type, data = {}) => {
  const payload = { type, ts: isoNow(), source: SOURCE, data };
  try {
    eventBus?.emit?.(payload);
  } catch {}
  return payload;
};

// --------------------------- Soft Imports / Stubs ---------------------------

function softRequire(path) {
  try {
    return require(/* @vite-ignore */ path);
  } catch {
    return null;
  }
}

// Sessions access
let SessionsRepo = softRequire("@/features/session/SessionsRepo");
SessionsRepo = SessionsRepo?.default || SessionsRepo;

// Guards (each returns Promise<{ pass:boolean, reason?:string }>)
const guardPaths = {
  sabbath: "@/features/session/session.guards/sabbath",
  quietHours: "@/features/session/session.guards/quietHours",
  weather: "@/features/session/session.guards/weather",
  inventory: "@/features/session/session.guards/inventory",
  equipment: "@/features/session/session.guards/equipment",
  battery: "@/features/session/session.guards/battery",
};

const guards = {};
for (const [k, p] of Object.entries(guardPaths)) {
  const m = softRequire(p);
  guards[k] = m?.default || m?.check || (() => Promise.resolve({ pass: true }));
}

// Fallback Dexie table GET if SessionsRepo is missing
async function fallbackFetchSessions(domain, includePaused) {
  try {
    const db = window?.SSA_DB; // convention: your Dexie instance could be exposed
    if (!db?.sessions) return [];
    // naive fetch: newest first
    const rows = await db.sessions
      .where("domain")
      .equals(domain)
      .reverse()
      .sortBy("updatedAt");
    return (rows || []).filter((s) => {
      if (!includePaused)
        return s.status === "pending" || s.status === "running";
      return (
        s.status === "pending" ||
        s.status === "running" ||
        s.status === "paused"
      );
    });
  } catch {
    return [];
  }
}

async function fetchCandidates(domain, includePaused) {
  if (SessionsRepo?.findByDomain) {
    // Repo contract we assume in SSA: returns newest-first
    const all = await SessionsRepo.findByDomain(domain, {
      statuses: includePaused
        ? ["pending", "running", "paused"]
        : ["pending", "running"],
    });
    return Array.isArray(all) ? all : [];
  }
  // Fallback
  return fallbackFetchSessions(domain, includePaused);
}

// Guard evaluation on the current step (or first valid)
async function evaluateGuards(session) {
  const idx = Number(session?.progress?.currentStepIndex || 0);
  const steps = Array.isArray(session?.steps) ? session.steps : [];
  const step = steps[idx] || steps[0] || null;

  // If step missing/invalid, allow but record warning
  if (!step || !step.id) {
    return { ok: true, reasons: ["no-step-warning"] };
  }

  // Respect explicit blockers on the step if present, else evaluate all
  const requested =
    Array.isArray(step.blockers) && step.blockers.length
      ? step.blockers
      : ["sabbath", "quietHours", "weather", "inventory", "equipment"];

  // Battery is optional global guard that we tack on (won't block unless threshold logic says so)
  if (!requested.includes("battery")) requested.push("battery");

  const checks = await Promise.all(
    requested.map(async (name) => {
      const fn = guards[name] || (() => Promise.resolve({ pass: true }));
      try {
        const res = await fn({ session, step });
        return {
          name,
          pass: !!res?.pass,
          reason: res?.reason || (res?.pass ? undefined : "blocked"),
        };
      } catch (e) {
        // Guard failed → do not block by crash; report reason for visibility
        return { name, pass: true, reason: `guard-error:${name}` };
      }
    })
  );

  const blocked = checks.filter((c) => !c.pass);
  const reasons = checks
    .map((c) => (c.reason ? `${c.name}:${c.reason}` : null))
    .filter(Boolean);
  return { ok: blocked.length === 0, reasons };
}

// Sorting heuristic for runnable candidates
function scoreSession(s) {
  // Newest updated first, running gets a boost, shorter remaining estimated time preferred
  const updated = +new Date(s?.updatedAt || s?.createdAt || 0);
  const runningBoost = s?.status === "running" ? 1e9 : 0;
  const totalSteps = Array.isArray(s?.steps) ? s.steps.length : 0;
  const cur = Number(s?.progress?.currentStepIndex || 0);
  const remain = Math.max(0, totalSteps - cur - 1);
  // Shorter remaining → higher score
  const remainScore = 1e6 - Math.min(1e6, remain * 1e4);
  return updated + runningBoost + remainScore;
}

// ------------------------------- The Hook ----------------------------------

/**
 * @typedef {Object} UseNowSessionOptions
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
 * @property {boolean} [includePaused=false]    Include paused sessions as runnable
 * @property {string}  [selectorTitle]          Optional title when emitting ui.selector.request
 */

/**
 * Resolve and run "Now" sessions for a domain.
 * @param {UseNowSessionOptions} options
 */
export default function useNowSession(options = {}) {
  const { domain, includePaused = false, selectorTitle } = options;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [runnable, setRunnable] = useState([]); // subset after guards
  const abortRef = useRef({ aborted: false });

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    abortRef.current.aborted = false;

    emit("domain.now.requested", { domain });

    try {
      const raw = await fetchCandidates(domain, includePaused);
      if (abortRef.current.aborted) return;

      // Evaluate guards concurrently
      const guardResults = await Promise.all(
        raw.map(async (s) => {
          const { ok, reasons } = await evaluateGuards(s);
          return { session: s, ok, reasons };
        })
      );
      if (abortRef.current.aborted) return;

      const runnables = guardResults
        .filter((r) => r.ok)
        .map((r) => r.session)
        .sort((a, b) => scoreSession(b) - scoreSession(a));

      setCandidates(raw);
      setRunnable(runnables);

      const first = runnables[0] || null;

      emit("domain.now.resolved", {
        domain,
        candidateCount: raw.length,
        runnableCount: runnables.length,
        firstRunnableId: first?.id || null,
      });

      if (!runnables.length) {
        const allReasons = guardResults.reduce((acc, r) => {
          acc[r.session?.id || "unknown"] = r.reasons || [];
          return acc;
        }, {});
        emit("domain.now.blocked", { domain, reasonsBySession: allReasons });
      }
    } catch (e) {
      setError(e);
      emit("domain.now.error", { domain, message: String(e?.message || e) });
    } finally {
      setLoading(false);
    }
  }, [domain, includePaused]);

  useEffect(() => {
    if (!domain) return;
    refresh();
    return () => {
      abortRef.current.aborted = true;
    };
  }, [domain, refresh]);

  // Public checker for a specific session object
  const check = useCallback(async (session) => {
    try {
      return await evaluateGuards(session);
    } catch (e) {
      return { ok: true, reasons: [`check-error:${String(e?.message || e)}`] };
    }
  }, []);

  // Open the runner
  const openRunner = useCallback((sessionId) => {
    // Consumers: mount your SessionRunner modal at app root and listen to this event
    emit("ui.sessionrunner.open", { sessionId });
  }, []);

  // Run the best candidate, or emit selector request if many.
  const run = useCallback(
    async (session) => {
      // If explicit session passed, prefer it (after checking).
      if (session) {
        const { ok, reasons } = await check(session);
        if (!ok) {
          emit("domain.now.blocked", {
            domain,
            reasonsBySession: { [session.id]: reasons || [] },
          });
          return false;
        }
        openRunner(session.id);
        return true;
      }

      // No explicit session → pick from runnable subset
      if (!runnable.length) {
        // Attempt to refresh once if we had nothing
        await refresh();
        if (!runnable.length) return false;
      }

      if (runnable.length === 1) {
        openRunner(runnable[0].id);
        return true;
      }

      // Multiple: emit selector request for caller/global UI
      const items = runnable.slice(0, 10).map((s) => ({
        id: s.id,
        title: s.title || "(untitled session)",
        subtitle: `${s.domain} • step ${
          Number(s?.progress?.currentStepIndex || 0) + 1
        }/${Array.isArray(s?.steps) ? s.steps.length : 0}`,
      }));

      emit("ui.selector.request", {
        title: selectorTitle || "Choose a session to run now",
        items,
        meta: { domain, purpose: "run-now" },
      });

      return false;
    },
    [domain, runnable, openRunner, refresh, check]
  );

  const firstRunnable = useMemo(() => runnable[0] || null, [runnable]);

  return {
    loading,
    error,
    candidates,
    pickList: runnable,
    firstRunnable,
    refresh,
    check,
    run,
  };
}
