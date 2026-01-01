// src/services/guardrails/sabbathGuard.js
/**
 * Suka Guardrails — Sabbath-aware task wrapper
 *
 * Responsibilities:
 *  - Decide if an action is allowed now based on Sabbath status.
 *  - If blocked, optionally schedule/defer until after Sabbath ends.
 *  - Emit UI glue (toast/confirm, next-best-actions) via automation bus.
 *  - Persist a small local queue, replay on Sabbath exit, and support Undo.
 *
 * No external packages required.
 */

import { automation } from "@/services/automation/runtime";

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

const BUS = {
  toast(payload) {
    try { automation.emit?.("ui.toast", payload); } catch { /* no-op */ }
  },
  confirm: async (payload) => {
    try {
      // shape: { title, message, confirmLabel, cancelLabel, tone }
      const res = await automation.request?.("ui.confirm", payload);
      if (typeof res?.confirmed === "boolean") return res.confirmed;
    } catch {}
    // Fallback (browser confirm)
    // eslint-disable-next-line no-alert
    return window.confirm?.(payload?.message || payload?.title || "Proceed?") ?? true;
  },
  emit(type, data) {
    try { automation.emit?.(type, data); } catch {}
  },
  request: async (type, data) => {
    try { return await automation.request?.(type, data); } catch { return null; }
  },
};

const LS = {
  get(key, fallback = null) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* no-op */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* no-op */ }
  },
};

const QUEUE_KEY = "suka.sabbath.queue.v1";

/** Convenience: clamp a number */
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/* -------------------------------------------------------------------------- */
/* Sabbath detection (backend-first, heuristic fallback)                      */
/* -------------------------------------------------------------------------- */

/** Ask backend for status if available. Expected { isSabbath, window:{start,end}, source } */
async function askBackendStatus() {
  try {
    const res = await BUS.request("torah.isSabbathNow");
    if (res && typeof res.isSabbath === "boolean") return { ...res, source: res.source || "backend" };
  } catch {}
  return null;
}

/** Very simple local heuristic: Fri 18:00 → Sat 21:00 (local). */
function heuristicWindow(now = new Date()) {
  const d = new Date(now);
  const day = d.getDay(); // 0 Sun … 6 Sat
  const base = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  // Start: this week's Friday 18:00
  const friOffset = (5 - day + 7) % 7; // days until Friday (0-6)
  const lastFri = new Date(base);
  lastFri.setDate(base.getDate() - ((day + 7 - 5) % 7));
  lastFri.setHours(18, 0, 0, 0);

  const nextFri = new Date(base);
  nextFri.setDate(base.getDate() + friOffset);
  nextFri.setHours(18, 0, 0, 0);

  // End: Saturday 21:00
  const satOfLast = new Date(lastFri);
  satOfLast.setDate(lastFri.getDate() + 1);
  satOfLast.setHours(21, 0, 0, 0);

  const satOfNext = new Date(nextFri);
  satOfNext.setDate(nextFri.getDate() + 1);
  satOfNext.setHours(21, 0, 0, 0);

  const withinLast = d >= lastFri && d < satOfLast;
  const withinNext = d >= nextFri && d < satOfNext;

  if (withinLast) return { start: +lastFri, end: +satOfLast };
  if (withinNext) return { start: +nextFri, end: +satOfNext };

  // choose closest upcoming window
  const future = d < nextFri ? { start: +nextFri, end: +satOfNext } : { start: +nextFri + 7 * 864e5, end: +satOfNext + 7 * 864e5 };
  return future;
}

/** Resolve Sabbath status + window. Backend wins; heuristic as fallback. */
export async function getSabbathStatus() {
  const backend = await askBackendStatus();
  if (backend) {
    const start = backend.window?.start ?? null;
    const end = backend.window?.end ?? null;
    return {
      isSabbath: !!backend.isSabbath,
      window: start && end ? { start, end } : heuristicWindow(),
      source: "backend",
    };
  }
  const w = heuristicWindow();
  const now = Date.now();
  return { isSabbath: now >= w.start && now < w.end, window: w, source: "heuristic" };
}

/** Convenience: when does Sabbath end (ms since epoch) */
export async function getSabbathEnd() {
  const st = await getSabbathStatus();
  return st?.window?.end ?? Date.now();
}

/* -------------------------------------------------------------------------- */
/* Local deferred queue                                                       */
/* -------------------------------------------------------------------------- */

function readQueue() {
  const arr = LS.get(QUEUE_KEY, []);
  return Array.isArray(arr) ? arr : [];
}
function writeQueue(arr) {
  LS.set(QUEUE_KEY, arr);
}

/**
 * Enqueue a job to run later.
 * @returns {id} string
 */
function enqueue(job) {
  const q = readQueue();
  const id = job.id || `job:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  q.push({ ...job, id, createdAt: Date.now(), status: "scheduled" });
  writeQueue(q);
  BUS.emit("guardrails.sabbath.job.scheduled", { id, job });
  return id;
}

function cancelJob(id) {
  const q = readQueue();
  const idx = q.findIndex((j) => j.id === id);
  if (idx >= 0) {
    const [job] = q.splice(idx, 1);
    writeQueue(q);
    BUS.emit("guardrails.sabbath.job.canceled", { id, job });
    return true;
  }
  return false;
}

async function runDueJobs() {
  const now = Date.now();
  const st = await getSabbathStatus();
  if (st.isSabbath) return;

  const q = readQueue();
  const due = q.filter((j) => (j.runAt ?? 0) <= now && j.status === "scheduled");
  if (!due.length) return;

  // mark running to avoid double-fire if tab duplicates run
  const next = q.map((j) => (due.some((d) => d.id === j.id) ? { ...j, status: "running" } : j));
  writeQueue(next);

  for (const job of due) {
    try {
      BUS.emit("guardrails.sabbath.job.start", { id: job.id });
      // If the job describes an automation call, run it; else try to eval a function body (safeguard).
      if (job.automation) {
        await BUS.request(job.automation.type, job.automation.payload);
      } else if (typeof job.fn === "function") {
        await job.fn();
      } else if (job.fnSrc) {
        // extremely conservative: do nothing by default (avoid eval). You can wire a resolver here if needed.
        console.warn("[sabbathGuard] fnSrc present but not executed for safety.");
      }
      BUS.emit("guardrails.sabbath.job.done", { id: job.id });
      BUS.toast({
        tone: "success",
        text: job.successText || "Deferred task completed.",
        action: job.nextAction || null,
      });
    } catch (e) {
      console.error("[sabbathGuard] deferred job error", e);
      BUS.emit("guardrails.sabbath.job.error", { id: job.id, error: e?.message || String(e) });
      BUS.toast({ tone: "error", text: "Deferred task failed to run." });
    } finally {
      cancelJob(job.id);
    }
  }
}

/* Watcher: when Sabbath flips to OFF, we replay due jobs and notify UI */
let watcherStarted = false;
export function startSabbathWatcher(pollMs = 60_000) {
  if (watcherStarted) return;
  watcherStarted = true;

  let lastIsSabbath = null;

  const tick = async () => {
    const st = await getSabbathStatus();
    if (lastIsSabbath === null) lastIsSabbath = st.isSabbath;

    if (st.isSabbath !== lastIsSabbath) {
      BUS.emit("guardrails.sabbath.changed", st);
      if (!st.isSabbath) {
        // Sabbath ended → run queue
        await runDueJobs();
        BUS.toast({
          tone: "success",
          text: "Sabbath ended. Deferred tasks will run now.",
        });
      } else {
        BUS.toast({ tone: "info", text: "Sabbath started. Write actions are limited." });
      }
      lastIsSabbath = st.isSabbath;
    }
  };

  // Kick immediately, then poll
  tick();
  const id = setInterval(tick, clamp(pollMs, 5_000, 300_000));
  // Allow consumers to stop the watcher if needed
  return () => clearInterval(id);
}

/* -------------------------------------------------------------------------- */
/* Next best actions                                                          */
/* -------------------------------------------------------------------------- */

function nextBestFor(type = "write") {
  // Suggest safe alternatives during Sabbath
  const actions = {
    calendar: { label: "Review calendar", navigate: "/calendar" },
    inventory: { label: "Audit pantry", navigate: "/storehouse" },
    recipe: { label: "Plan recipes", navigate: "/meal-planning" },
    cooking: { label: "Preview session", navigate: "/cooking" },
    default: { label: "Open Home", navigate: "/" },
  };
  return actions[type] || actions.default;
}

/* -------------------------------------------------------------------------- */
/* Public API: sabbathGuard                                                   */
/* -------------------------------------------------------------------------- */

/**
 * sabbathGuard(task, options)
 * Wrap any async task (write, calendar sync, inventory mutation, etc.)
 *
 * @param {() => Promise<any>|any} task               The work to do when allowed.
 * @param {Object} options
 * @param {string} options.label                      Human label for the task (used in UI).
 * @param {"read"|"write"|"calendar"|"inventory"|"recipe"|"cooking"} options.type
 * @param {boolean} options.allowDuringSabbath        Force allow even if Sabbath (not recommended).
 * @param {boolean} options.readOnly                  Treat as read-only; allowed but warn.
 * @param {boolean} options.scheduleIfBlocked         If blocked, defer to after Sabbath automatically.
 * @param {number|"afterSabbath"} options.runAt       Specific ms epoch; or "afterSabbath".
 * @param {{label:string, navigate?:string}} options.nextAction   Suggest next step after success.
 * @param {boolean} options.confirm                   Ask confirmation before running (outside Sabbath).
 *
 * @returns {Promise<any|undefined>} result of task if executed
 */
export async function sabbathGuard(task, options = {}) {
  const {
    label = "Task",
    type = "write",
    allowDuringSabbath = false,
    readOnly = false,
    scheduleIfBlocked = true,
    runAt = "afterSabbath",
    nextAction,
    confirm = false,
  } = options;

  const st = await getSabbathStatus();
  const baseNext = nextAction || nextBestFor(type);

  // Always allowed path
  const runNow = async () => {
    if (confirm) {
      const ok = await BUS.confirm({
        title: label,
        message: `Proceed with ${label.toLowerCase()}?`,
        confirmLabel: "Proceed",
        cancelLabel: "Cancel",
      });
      if (!ok) return undefined;
    }

    const res = await Promise.resolve().then(task);

    // Success toast + next best action
    BUS.toast({
      tone: "success",
      text: `${label} complete.`,
      action: baseNext ? { label: baseNext.label, navigate: baseNext.navigate } : null,
    });

    // Notify listeners (event-driven glue)
    // Map task type -> domain events the app can respond to
    const domainEvent = {
      calendar: "calendar.synced",
      inventory: "inventory.updated",
      recipe: "recipe.consolidated",
      cooking: "cooking.session.generated",
      write: "app.data.changed",
      read: "app.viewed",
    }[type] || "app.data.changed";

    BUS.emit(domainEvent, { source: "sabbathGuard", label });

    return res;
  };

  // If backend status allows forcing run
  if (!st.isSabbath || allowDuringSabbath || readOnly) {
    if (st.isSabbath && readOnly) {
      BUS.toast({
        tone: "warning",
        text: `${label}: read-only allowed during Sabbath.`,
      });
    }
    return runNow();
  }

  // Blocked path
  const endAt = (await getSabbathEnd()) || Date.now();
  const when = runAt === "afterSabbath" ? endAt + 2000 : Number(runAt) || endAt + 2000;

  // Offer to defer or cancel
  const ok = await BUS.confirm({
    title: `${label} is paused`,
    tone: "info",
    message:
      "Sabbath mode is active. Would you like me to schedule this automatically for after Sabbath ends?",
    confirmLabel: "Schedule",
    cancelLabel: "Cancel",
  });

  if (!ok) {
    BUS.toast({
      tone: "info",
      text: `${label} canceled.`,
      action: baseNext ? { label: baseNext.label, navigate: baseNext.navigate } : null,
    });
    return undefined;
  }

  if (!scheduleIfBlocked) {
    BUS.toast({ tone: "info", text: `${label} not scheduled.` });
    return undefined;
  }

  // Defer: use backend if available, else local queue
  try {
    const payload = { label, type, runAt: when };
    const backendJob = await BUS.request("tasks.deferUntil", payload);

    let scheduledId;
    if (backendJob?.id) {
      scheduledId = backendJob.id;
    } else {
      // Persist locally with a generic automation call if provided
      scheduledId = enqueue({
        runAt: when,
        automation: options.automation ?? null, // optional: { type: "inventory.reserveForCooking", payload: {...} }
        successText: `${label} ran successfully.`,
        nextAction: baseNext ? { label: baseNext.label, navigate: baseNext.navigate } : null,
      });
    }

    const undo = () => {
      const canceled = cancelJob(scheduledId);
      if (canceled) {
        BUS.toast({ tone: "success", text: "Scheduled task canceled." });
      } else {
        BUS.toast({ tone: "warning", text: "Couldn’t cancel (may be managed by backend)." });
      }
    };

    BUS.toast({
      tone: "success",
      text: `${label} scheduled for after Sabbath.`,
      action: { label: "Undo", navigate: null, undo }, // UI can call .undo if supported; otherwise ignore
    });

    BUS.emit("guardrails.sabbath.job.scheduled", { id: scheduledId, at: when, label, type });

    return undefined;
  } catch (e) {
    console.error("[sabbathGuard] schedule failed", e);
    BUS.toast({ tone: "error", text: "Couldn’t schedule. Try again later." });
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Convenience wrappers for common domains                                    */
/* -------------------------------------------------------------------------- */

export async function sabbathGuardCalendar(task, opts = {}) {
  return sabbathGuard(task, { type: "calendar", label: "Calendar sync", ...opts });
}

export async function sabbathGuardInventory(task, opts = {}) {
  return sabbathGuard(task, { type: "inventory", label: "Inventory update", ...opts });
}

export async function sabbathGuardRecipe(task, opts = {}) {
  return sabbathGuard(task, { type: "recipe", label: "Recipe update", ...opts });
}

export async function sabbathGuardCooking(task, opts = {}) {
  return sabbathGuard(task, { type: "cooking", label: "Cooking session", ...opts });
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

// Start the status watcher once on first import
startSabbathWatcher();
