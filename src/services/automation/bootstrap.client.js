// src/services/automation/bootstrap.client.js
// Browser-only automation bootstrap (NO node:* imports).
// Optional deps: eventBus, Web Worker, backend endpoints.

let started = false;

const DEV = import.meta.env?.DEV;
const LS_DRAFTS_KEY = "suka:automation:drafts:v2";
const CHANNEL_NAME = "suka-automation";

const nowIso = () => new Date().toISOString();

function safeParse(json, fallback) {
  try { return JSON.parse(json); } catch { return fallback; }
}
function lsGet(key, fallback) {
  try { return safeParse(localStorage.getItem(key), fallback); } catch { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

const debounceMap = new Map();
function debounce(key, fn, ms = 400) {
  clearTimeout(debounceMap.get(key));
  const t = setTimeout(fn, ms);
  debounceMap.set(key, t);
}
const uid = (pfx = "d") =>
  `${pfx}_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;

/* ----------------------------- Event Bus Loader ---------------------------- */
let bus = null;
async function ensureBus() {
  if (bus) return bus;
  try {
    const mod = await import("@/services/events/eventBus.js");
    const candidate = mod?.default ?? mod;
    if (candidate?.on && candidate?.emit) {
      bus = candidate;
      return bus;
    }
  } catch (e) {
    if (DEV) console.warn("[automation] No eventBus found, using internal bus.", e);
  }
  const listeners = new Map();
  bus = {
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
      return () => listeners.get(evt)?.delete(fn);
    },
    off(evt, fn) { listeners.get(evt)?.delete(fn); },
    emit(evt, payload) {
      listeners.get(evt)?.forEach((listener) => {
        try { listener(payload); } catch (err) { if (DEV) console.warn("[automation] listener error", err); }
      });
    },
  };
  return bus;
}

/* ----------------------------- Broadcast Channel --------------------------- */
let channel = null;
function openChannel() {
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (e) => {
      try {
        const { type, data } = e.data || {};
        if (type === "drafts:replace" && Array.isArray(data)) {
          DraftStore._replaceFromRemote(data);
        } else if (type === "drafts:patch" && data?.id) {
          DraftStore._patchFromRemote(data.id, data.patch);
        }
      } catch (err) {
        if (DEV) console.warn("[automation] channel message error", err);
      }
    };
  } catch {
    channel = null;
  }
}
function sendChannel(msg) { try { channel?.postMessage(msg); } catch {} }

/* -------------------------------- Draft Store ------------------------------ */
const DraftStore = (() => {
  function normalizeDrafts(v) {
    if (!Array.isArray(v)) return [];
    return v.filter((d) => d && typeof d === "object" && "id" in d);
  }
  function read() { return normalizeDrafts(lsGet(LS_DRAFTS_KEY, [])); }
  function write(next) { lsSet(LS_DRAFTS_KEY, normalizeDrafts(next)); }

  let drafts = read();
  const subs = new Set();

  function notify() { subs.forEach((fn) => { try { fn(drafts); } catch {} }); }
  function persistAndNotify() {
    write(drafts);
    notify();
    sendChannel({ type: "drafts:replace", data: drafts });
  }

  function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
  function list(filter = {}) {
    drafts = read(); // resync
    const { type, status } = filter || {};
    return drafts.filter(
      (d) => (type ? d.type === type : true) && (status ? d.status === status : true),
    );
  }

  function create({ type, title, payload, meta }) {
    const id = uid("draft");
    const draft = {
      id,
      type,
      title: title ?? `New ${type} draft`,
      status: "pending",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      payload: payload ?? {},
      meta: meta ?? {},
    };
    drafts = [draft, ...list()];
    persistAndNotify();
    toast(`Draft ready: ${draft.title}`);
    return draft;
  }

  function update(id, patch) {
    const arr = list();
    const i = arr.findIndex((d) => d.id === id);
    if (i === -1) return null;
    arr[i] = { ...arr[i], ...patch, updatedAt: nowIso() };
    drafts = arr;
    persistAndNotify();
    sendChannel({ type: "drafts:patch", data: { id, patch } });
    return arr[i];
  }

  function approve(id) { return update(id, { status: "approved" }); }
  function dismiss(id) { return update(id, { status: "dismissed" }); }
  function remove(id) { drafts = list().filter((d) => d.id !== id); persistAndNotify(); }
  function reset() { drafts = []; persistAndNotify(); }

  function _replaceFromRemote(data) { drafts = normalizeDrafts(data); write(drafts); notify(); }
  function _patchFromRemote(id, patch) {
    const arr = list();
    const i = arr.findIndex((d) => d.id === id);
    if (i === -1) return;
    arr[i] = { ...arr[i], ...patch, updatedAt: nowIso() };
    drafts = arr; write(drafts); notify();
  }

  return {
    subscribe, list, create, update, approve, dismiss, remove, reset,
    _replaceFromRemote, _patchFromRemote,
  };
})();

if (DEV) window.__DraftStore = DraftStore;

/* ------------------------------ Toast / UX hook ---------------------------- */
function toast(message, level = "info") {
  try {
    window.dispatchEvent(new CustomEvent("toast", { detail: { message, level } }));
  } catch {}
  if (DEV) console.log(`[toast:${level}]`, message);
}

/* ---------------------- Optional: Web Worker Integration ------------------- */
let worker = null;
async function ensureWorker() {
  if (worker) return worker;

  // Vite 6+: "as" is deprecated; use "query: '?url', import: 'default'"
  const maps = [
    import.meta.glob("/src/workers/automation.worker.{js,ts,mjs,jsx,tsx}", { query: "?url", import: "default" }),
    import.meta.glob("@/workers/automation.worker.{js,ts,mjs,jsx,tsx}", { query: "?url", import: "default" }),
  ];
  const map = Object.assign({}, ...maps);
  const keys = Object.keys(map);

  if (keys.length === 0) {
    if (DEV) console.info("[automation] No automation.worker.* found; continuing without a Web Worker.");
    worker = null;
    return worker;
  }

  try {
    const loader = map[keys[0]];
    const modOrUrl = await loader();
    const workerUrl = typeof modOrUrl === "string" ? modOrUrl : (modOrUrl?.default ?? modOrUrl);
    worker = new Worker(workerUrl, { type: "module" });
    worker.onmessage = (e) => {
      try {
        const { type, data } = e.data || {};
        if (type === "draft") DraftStore.create(data);
      } catch (err) {
        if (DEV) console.warn("[automation] worker message error", err);
      }
    };
    if (DEV) console.info("[automation] Worker started:", keys[0]);
  } catch (err) {
    console.warn("[automation] Worker unavailable:", err?.message || err);
    worker = null;
  }
  return worker;
}
function workerDraft(type, payload) {
  if (!worker) return false;
  try { worker.postMessage({ type: "generate", data: { type, payload } }); return true; } catch { return false; }
}

/* -------------------------- Heuristics & Generators ------------------------ */
function makeCookingDraftFromRecipes({ recipes = [], prefs = {}, inventory = {} }) {
  const title = prefs?.sessionTitle || `Cooking Session (${recipes.length} recipes)`;
  const stations = ["prep", "range", "oven", "grill"];
  let sIdx = 0;

  const items = recipes.map((r) => {
    const station = r.station || stations[(sIdx++) % stations.length];
    const allergens = r.allergens || [];
    const dietary = r.dietary || [];
    const yieldText = r.yield || "makes 1 batch";

    const timers = [];
    if (r.hotFill) {
      timers.push({ kind: "hot-fill", minutes: 10, note: "Hold above 74°C/165°F for hot fill" });
      timers.push({ kind: "chill", minutes: 45, note: "Rapid chill to ≤4°C/40°F" });
    }

    const label = {
      prefix: prefs.labelPrefix || "SV",
      dateFormat: prefs.dateFormat || "YYYY-MM-DD",
      ingredientsLine: r.ingredients?.map((i) => i.name).join(", ") || "",
    };

    return { recipeId: r.id, name: r.name, station, allergens, dietary, yield: yieldText, timers, label };
  });

  const totalQuarts = recipes.reduce((sum, r) => sum + (r.estimatedQuarts || 0), 0);
  const freezerCapacity = inventory.freezerQuarts ?? null;
  const storageHints = freezerCapacity != null
    ? { freezer: { requiredQuarts: totalQuarts, remaining: freezerCapacity - totalQuarts } }
    : {};

  return {
    type: "cooking-session",
    title,
    payload: {
      items,
      storageHints,
      context: { weeklyFlavorRhythm: prefs?.weeklyFlavorRhythm || null, householdId: prefs?.householdId || null },
    },
    meta: { source: "client-heuristic", createdBy: "automation.bootstrap.client" },
  };
}

function makeCleaningDraftFromSignals({ zones = [], constraints = {} }) {
  const title = `Cleaning Session (${Array.isArray(zones) ? zones.length : 0} zones)`;
  const items = (Array.isArray(zones) ? zones : []).map((z) => ({
    zoneId: z.id,
    name: z.name,
    timeBlock: constraints?.sabbath ? "Auto-schedule outside Sabbath window" : "Anytime",
    supplies: z.supplyHints || [],
  }));
  return {
    type: "cleaning-session",
    title,
    payload: { items, constraints: constraints || {} },
    meta: { source: "client-heuristic", createdBy: "automation.bootstrap.client" },
  };
}

/* ------------------------------ Backend helpers --------------------------- */
async function tryBackendGenerate(kind, input) {
  try {
    const res = await fetch("/api/automation/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, input }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function tryCalendarSync(approvedDraft) {
  try {
    const res = await fetch("/api/calendar/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: approvedDraft }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* -------------------------------- Bootstrap ------------------------------- */
export async function startAutomationBootstrap(opts = {}) {
  if (started) return { ok: true, skipped: true };
  started = true;

  // Minimal surface immediately
  window.__automation = {
    createDraft: DraftStore.create,
    listDrafts: DraftStore.list,
    approveDraft: async (id) => {
      const draft = DraftStore.approve(id);
      if (!draft) return null;
      bus?.emit?.("calendar/sync", { draft });
      await tryCalendarSync(draft);
      toast(`Approved: ${draft.title}`, "success");
      return draft;
    },
    dismissDraft: (id) => DraftStore.dismiss(id),
    removeDraft: (id) => DraftStore.remove(id),
    subscribeDrafts: DraftStore.subscribe,
    resetDrafts: () => DraftStore.reset(),
    status: "booting",
    startedAt: nowIso(),
  };

  try {
    openChannel();
    await ensureBus();
    await ensureWorker();
  } catch (e) {
    console.warn("[automation] bootstrap degraded:", e?.message || e);
  }

  if (DEV) console.info("[automation] client bootstrap started.");

  // Events
  bus.on("household/profile/updated", async (profile) => {
    debounce("profile-updated", async () => {
      const serverDraft = await tryBackendGenerate("profile-to-meal-plan", { profile });
      if (serverDraft?.type) return void DraftStore.create(serverDraft);
      DraftStore.create({
        type: "meal-plan",
        title: "New Meal Plan (from profile)",
        payload: { weeklyFlavorRhythm: profile?.weeklyFlavorRhythm || null, notes: "Auto-generated from household profile." },
        meta: { source: "client-heuristic" },
      });
    }, 700);
  });

  bus.on("recipes/consolidated", async (evt) => {
    const { recipes, prefs, inventory } = evt || {};
    debounce("recipes-consolidated", async () => {
      const serverDraft = await tryBackendGenerate("recipes-to-cooking-session", { recipes, prefs, inventory });
      if (serverDraft?.type) return void DraftStore.create(serverDraft);
      DraftStore.create(makeCookingDraftFromRecipes({ recipes, prefs, inventory }));
    }, 400);
  });

  bus.on("cleaning/signals", async (evt) => {
    const { zones, constraints } = evt || {};
    debounce("cleaning-signals", async () => {
      const serverDraft = await tryBackendGenerate("signals-to-cleaning-session", { zones, constraints });
      if (serverDraft?.type) return void DraftStore.create(serverDraft);
      DraftStore.create(makeCleaningDraftFromSignals({ zones: zones || [], constraints: constraints || {} }));
    }, 400);
  });

  bus.on("automation/draft/patch", ({ id, patch }) => {
    if (!id || !patch) return;
    DraftStore.update(id, patch);
  });

  bus.on("automation/draft/approve", async ({ id }) => {
    if (!id) return;
    await window.__automation.approveDraft(id);
  });

  DraftStore.subscribe(() => {
    bus.emit?.("ui/rightSidebar/refresh", { reason: "drafts-updated" });
  });

  if (worker) {
    bus.on("recipes/consolidated", (evt) => {
      const ok = workerDraft("cooking-session", evt);
      if (ok && DEV) console.info("[automation] delegated to worker: cooking-session");
    });
  }

  window.__automation.status = "ready:client";

  if (DEV) {
    console.log(
      "%cAutomation ready (client)",
      "color: #0ea5e9; font-weight: bold;",
      { channel: !!channel, worker: !!worker, bus: !!bus, drafts: DraftStore.list().length },
    );
  }

  return { ok: true };
}

/* We do NOT auto-start here; main.jsx is the single source of truth. */
