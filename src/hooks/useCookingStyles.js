// src/hooks/useCookingStyles.js
// Robust, user-responsive hook for generating, caching, and running cooking styles.
// Integrates CookingPrefsStore, CookingStylesAgent, and automation runtime.
// Avoids circular imports. SSR-safe. Stale-while-revalidate with debounced updates.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CookingPrefsStore } from "@/store/CookingPrefsStore";
import { generateStyle, approveStyleDraft, startPlanRun, learnFromFeedback, buildChecklist } from "@/agents/cookingStylesAgent";
import { automation } from "@/services/automation/runtime";

/* -------------------------------------------------------------------------- */
/* Internal cache (SWR-style)                                                  */
/* -------------------------------------------------------------------------- */
const CACHE = new Map(); // key -> { data, meta, ts }
const DEFAULT_TTL = 1000 * 60 * 5; // 5 minutes

/* -------------------------------------------------------------------------- */
/* Status enum                                                                 */
/* -------------------------------------------------------------------------- */
const STATUS = Object.freeze({
  IDLE: "idle",
  LOADING: "loading",
  REFRESHING: "refreshing",
  OK: "ok",
  ERROR: "error",
});

/* -------------------------------------------------------------------------- */
/* Public hook                                                                 */
/* -------------------------------------------------------------------------- */
export function useCookingStyles({
  cuisine,
  dish = "",
  initialVariant = "house",
  initialBranchId = null,
  ttl = DEFAULT_TTL,
  autoGenerate = true,
  debounceMs = 280,
} = {}) {
  const key = useMemo(() => `${(cuisine || "").trim()}::${(dish || "").trim()}`, [cuisine, dish]);

  // Reactive state
  const [status, setStatus] = useState(STATUS.IDLE);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null); // full template output (interactive plan JSON)
  const [variant, setVariant] = useState(() => loadSessionVariant(key, initialVariant));
  const [branchId, setBranchId] = useState(() => loadSessionBranch(key, initialBranchId));
  const [lastUpdated, setLastUpdated] = useState(null);

  // Concurrency / lifecycle guards
  const mounted = useRef(true);
  const pendingReq = useRef({ id: 0 });
  const debTimer = useRef(null);

  // Snapshot of prefs (we re-read on demand; don't hold a stale copy)
  const getPrefs = useCallback(() => CookingPrefsStore.get(), []);

  // Derived: plan steps for current variant/branch
  const steps = useMemo(() => pickPlanSteps(data, variant, branchId), [data, variant, branchId]);

  /* ------------------------------------------------------------------------ */
  /* Generate (SWR: serve cache, then refresh)                                */
  /* ------------------------------------------------------------------------ */
  const generate = useCallback(
    async ({ force = false, reason = "manual" } = {}) => {
      if (!cuisine) return { ok: false, summary: "Missing cuisine" };

      // 1) Serve cache if fresh; mark as ok (no spinner), and revalidate in bg
      const now = Date.now();
      const cached = CACHE.get(key);
      const fresh = cached && now - cached.ts < ttl;

      if (cached && !force) {
        setData(cached.data);
        setLastUpdated(cached.ts);
        setStatus(STATUS.OK);
        // Revalidate in the background (refreshing) if stale-ish
        if (!fresh) revalidateInBackground(key, { cuisine, dish, reason: "stale" });
        return { ok: true, fromCache: true };
      }

      // 2) Active fetch (loading or refreshing depending on cache presence)
      setStatus(cached ? STATUS.REFRESHING : STATUS.LOADING);
      setError(null);
      const reqId = ++pendingReq.current.id;

      try {
        const res = await callWithRetry(async () => {
          // generateStyle returns { ok, summary, data } in our agent; keep compatibility:
          const out = await generateStyle({
            cuisine,
            dish,
            constraints: getPrefs()?.constraints || undefined,
            now: new Date().toISOString(),
          });

          // We normalize to { data }
          if (out?.ok) return out.data;
          // On older agent versions, result shape may be {data: adjusted} or {plan/meta}; handle both:
          if (out?.plan || out?.variants || out?.traditional) return out;
          throw new Error(out?.summary || "Failed to generate style");
        });

        // Latest-wins: ignore old responses
        if (!mounted.current || reqId !== pendingReq.current.id) return { ok: false, stale: true };

        CACHE.set(key, { data: res, ts: Date.now() });
        setData(res);
        setLastUpdated(Date.now());
        setStatus(STATUS.OK);
        automation.emit("styles/generated", { cuisine, dish, reason });

        return { ok: true, data: res };
      } catch (err) {
        if (!mounted.current || reqId !== pendingReq.current.id) return { ok: false, stale: true };
        setError(err);
        setStatus(STATUS.ERROR);
        automation.emit("styles/error", { cuisine, dish, error: String(err?.message || err) });
        return { ok: false, error: err };
      }
    },
    [cuisine, dish, key, ttl, getPrefs]
  );

  /* ------------------------------------------------------------------------ */
  /* Debounced re-generation on prefs change                                   */
  /* ------------------------------------------------------------------------ */
  useEffect(() => {
    if (!autoGenerate || !cuisine) return;

    const unsub = CookingPrefsStore.subscribe(() => {
      // SWR: keep showing cached plan; kick a debounced refresh
      if (debTimer.current) clearTimeout(debTimer.current);
      debTimer.current = setTimeout(() => {
        generate({ force: true, reason: "prefs_change" });
      }, debounceMs);
    });

    return () => {
      clearTimeout(debTimer.current);
      unsub();
    };
  }, [autoGenerate, cuisine, debounceMs, generate]);

  /* ------------------------------------------------------------------------ */
  /* Generate on mount / on key change                                         */
  /* ------------------------------------------------------------------------ */
  useEffect(() => {
    mounted.current = true;
    if (autoGenerate && cuisine) {
      generate({ force: false, reason: "mount_or_key_change" });
    }
    return () => {
      mounted.current = false;
    };
  }, [key, cuisine, dish, autoGenerate, generate]);

  /* ------------------------------------------------------------------------ */
  /* Persist selection (variant/branch) per cuisine::dish                      */
  /* ------------------------------------------------------------------------ */
  useEffect(() => {
    saveSessionVariant(key, variant);
  }, [key, variant]);
  useEffect(() => {
    saveSessionBranch(key, branchId);
  }, [key, branchId]);

  /* ------------------------------------------------------------------------ */
  /* Automation listeners (nice UX hooks)                                      */
  /* ------------------------------------------------------------------------ */
  useEffect(() => {
    // Prefetch on hover (e.g., user hovers a cuisine card)
    const offHover = automation.on("styles/prefetchHint", (p) => {
      if (p?.cuisine === cuisine && p?.dish === dish) {
        revalidateInBackground(key, { cuisine, dish, reason: "prefetch" });
      }
    });

    // External approval/start triggers (e.g., from another panel)
    const offApprove = automation.on("styles/approve", (p) => {
      if (p?.cuisine === cuisine && p?.dish === dish && data) {
        approveStyleDraft({ cuisine, dish, data, variant, branchId });
        automation.emit("toast/show", { kind: "success", title: "Plan ready", message: "Timers scheduled." });
      }
    });
    const offStart = automation.on("styles/start", (p) => {
      if (p?.cuisine === cuisine && p?.dish === dish && data) {
        startPlanRun({ cuisine, dish, data, variant, branchId });
      }
    });

    return () => { offHover(); offApprove(); offStart(); };
  }, [cuisine, dish, data, variant, branchId, key]);

  /* ------------------------------------------------------------------------ */
  /* Feedback (learn + refresh)                                                */
  /* ------------------------------------------------------------------------ */
  const submitFeedback = useCallback(
    async ({ rating, notes = "", deltas = {} }) => {
      try {
        await learnFromFeedback({ cuisine, dish, rating, notes, deltas, chosenVariant: variant });
        // Invalidate cache & refresh
        CACHE.delete(key);
        automation.emit("styles/learned", { cuisine, dish, rating });
        generate({ force: true, reason: "feedback" });
        return { ok: true };
      } catch (err) {
        automation.emit("styles/feedbackError", { cuisine, dish, error: String(err?.message || err) });
        return { ok: false, error: err };
      }
    },
    [cuisine, dish, variant, key, generate]
  );

  /* ------------------------------------------------------------------------ */
  /* UI-friendly selectors                                                     */
  /* ------------------------------------------------------------------------ */
  const cards = useMemo(() => buildUiCards(data), [data]);
  const checklist = useMemo(() => {
    try { return data ? buildChecklist(data, variant, branchId) : []; }
    catch { return []; }
  }, [data, variant, branchId]);
  const timers = useMemo(() => stepsToTimers(steps), [steps]);

  /* ------------------------------------------------------------------------ */
  /* Public API                                                                */
  /* ------------------------------------------------------------------------ */
  return {
    // state
    status, // idle | loading | refreshing | ok | error
    error,
    lastUpdated,

    // data
    data,          // full interactive plan JSON
    steps,         // flat array of steps for current variant/branch
    cards,         // quick cards for your raised-card UI
    checklist,     // readable steps (label, duration, cues)
    timers,        // ready for MultiTimerManager

    // selection
    variant, setVariant,
    branchId, setBranchId,

    // actions
    generate,               // regenerate (force) with reasons
    approve: () => data && approveStyleDraft({ cuisine, dish, data, variant, branchId }),
    start:   () => data && startPlanRun({ cuisine, dish, data, variant, branchId }),
    submitFeedback,

    // cache helpers
    clearCache: () => CACHE.delete(key),
    cachedAt: CACHE.get(key)?.ts || null,
  };
}

/* -------------------------------------------------------------------------- */
/* Background revalidate                                                       */
/* -------------------------------------------------------------------------- */
async function revalidateInBackground(key, { cuisine, dish, reason }) {
  try {
    const out = await generateStyle({ cuisine, dish, now: new Date().toISOString() });
    if (out?.ok) {
      CACHE.set(key, { data: out.data, ts: Date.now() });
      automation.emit("styles/refreshed", { cuisine, dish, reason });
    }
  } catch {
    // silent
  }
}

/* -------------------------------------------------------------------------- */
/* Retry with backoff (network resilience)                                     */
/* -------------------------------------------------------------------------- */
async function callWithRetry(fn, { retries = 2, baseMs = 400 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const transient = isTransient(err);
      if (!transient || attempt >= retries) throw err;
      const wait = baseMs * Math.pow(2, attempt) + jitter(120);
      await sleep(wait);
      attempt++;
    }
  }
}
function isTransient(err) {
  const s = String(err?.message || err || "");
  return /timeout|network|rate|overloaded|temporar|fetch/i.test(s);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (n) => Math.floor(Math.random() * n);

/* -------------------------------------------------------------------------- */
/* UI helpers                                                                  */
/* -------------------------------------------------------------------------- */
function pickPlanSteps(data, variant = "house", branchId = null) {
  if (!data) return [];
  const base = data?.plan?.[variant] || [];
  if (!branchId) return base;

  // append matching branch steps; future: splice by deps if present
  const branches = (data?.branches || []).filter((b) => (b.appliesTo || "").includes(variant));
  const match = branches.find((b) => b.id === branchId);
  return match ? [...base, ...(match.steps || [])] : base;
}

function stepsToTimers(steps) {
  return (steps || []).map((s, i) => ({
    id: s.id || `step-${i + 1}`,
    label: s.label || `Step ${i + 1}`,
    durationSec: Number(s.durationSec || 0),
    meta: {
      heatLevel: s.heatLevel || "off",
      tempTarget: s.tempTarget || null,
      equipment: s.equipment || [],
      cues: s.cues || {},
      safety: s.safety || "",
      deps: s.deps || [],
    },
  }));
}

function buildUiCards(data) {
  if (!data) return [];
  const cards = [];

  if (data?.traditional) {
    cards.push({
      kind: "anchors",
      title: "Traditional Anchors",
      items: [
        ...(data.traditional.techniques || []),
        ...(data.traditional.vessels || []),
        ...(data.traditional.aromaAnchors || []),
      ].slice(0, 10),
    });
  }

  const v = data?.variants || {};
  const variants = ["orthodox", "house", "quick"].filter((k) => v[k]).map((k) => ({
    key: k, title: v[k].title, summary: v[k].summary,
  }));
  if (variants.length) cards.push({ kind: "variants", title: "Variants", items: variants });

  if ((data?.safety || []).length) cards.push({ kind: "safety", title: "Safety", items: data.safety.slice(0, 5) });

  const anchors = data?.shopping?.anchors || [];
  const swaps = (data?.shopping?.swaps || []).map((s) => `${s.for} → ${s.try} (${s.why})`);
  if (anchors.length || swaps.length) {
    cards.push({ kind: "shopping", title: "Shopping", items: [...anchors.slice(0, 4), ...swaps.slice(0, 4)] });
  }

  return cards;
}

/* -------------------------------------------------------------------------- */
/* Session helpers (persist selection per cuisine::dish)                       */
/* -------------------------------------------------------------------------- */
const VKEY = "suka.cooking.variant.";
const BKEY = "suka.cooking.branch.";
function loadSessionVariant(key, fallback) {
  try { return sessionStorage.getItem(VKEY + key) || fallback; } catch { return fallback; }
}
function saveSessionVariant(key, val) {
  try { sessionStorage.setItem(VKEY + key, String(val ?? "")); } catch {}
}
function loadSessionBranch(key, fallback) {
  try { return sessionStorage.getItem(BKEY + key) || fallback; } catch { return fallback; }
}
function saveSessionBranch(key, val) {
  try { sessionStorage.setItem(BKEY + key, String(val ?? "")); } catch {}
}
