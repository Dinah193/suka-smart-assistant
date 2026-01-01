/* eslint-disable no-restricted-globals */
/**
 * automation.worker.js  (module worker)
 * -------------------------------------------------------------
 * Runs CPU-heavy or long-running draft generation off the UI thread.
 * - ZERO node:* imports (safe for Vite/browser)
 * - Optional backend delegation to /api/automation/generate
 * - Falls back to local heuristics if backend unavailable
 *
 * Inbound messages (from bootstrap.client.js):
 *   { type: 'generate', data: { type: 'cooking-session'|'cleaning-session'|'meal-plan', payload: {...} } }
 *   { type: 'warmup' }     -> prepares caches
 *   { type: 'ping' }       -> responds with 'pong'
 *
 * Outbound messages (to client):
 *   { type: 'draft', data: DraftObject }
 *   { type: 'log', level, message, extra? }
 *   { type: 'pong' }
 */

// ------------------------------ Utilities ---------------------------------
const DEV = typeof importScripts === 'function'; // good enough; workers run in own global
const nowIso = () => new Date().toISOString();

function post(type, payload) {
  self.postMessage({ type, ...(payload ?? {}) });
}

function log(level, message, extra) {
  // Keep logs minimal to avoid noisy consoles in production
  if (level === 'error' || (typeof __DEV__ !== 'undefined' && __DEV__)) {
    post('log', { level, message, extra });
  } else if (DEV && level !== 'debug') {
    post('log', { level, message, extra });
  }
}

function uid(pfx = 'w') {
  return `${pfx}_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function clone(v) {
  try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
}

// Safe fetch: returns null on error
async function safeJson(url, init) {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ------------------------- Shared Draft Builders ---------------------------
// These mirror/extend your heuristics used elsewhere in the app.

function balanceStations(recipes) {
  const stations = ['prep', 'range', 'oven', 'grill'];
  let i = 0;
  return recipes.map(r => ({ ...r, station: r.station || stations[(i++) % stations.length] }));
}

function buildCookingDraft(input) {
  const { recipes = [], prefs = {}, inventory = {} } = input || {};
  const withStations = balanceStations(recipes);

  const items = withStations.map((r) => {
    const allergens = r.allergens || [];
    const dietary = r.dietary || [];
    const yieldText = r.yield || 'makes 1 batch';

    // Safety timers if hot-fill logic is present
    const timers = [];
    if (r.hotFill) {
      timers.push({ kind: 'hot-fill', minutes: 10, note: 'Hold above 74°C/165°F for hot fill' });
      timers.push({ kind: 'chill', minutes: 45, note: 'Rapid chill to ≤4°C/40°F' });
    }

    const label = {
      prefix: prefs.labelPrefix || 'SV',
      dateFormat: prefs.dateFormat || 'YYYY-MM-DD',
      ingredientsLine: (r.ingredients || []).map(i => i.name).join(', ')
    };

    return {
      recipeId: r.id,
      name: r.name,
      station: r.station || 'prep',
      allergens,
      dietary,
      yield: yieldText,
      timers,
      label
    };
  });

  // Storage capacity hints
  const totalQuarts = recipes.reduce((sum, r) => sum + (r.estimatedQuarts || 0), 0);
  const freezerCapacity = inventory.freezerQuarts ?? null;
  const storageHints = freezerCapacity != null
    ? { freezer: { requiredQuarts: totalQuarts, remaining: freezerCapacity - totalQuarts } }
    : {};

  return {
    type: 'cooking-session',
    title: prefs?.sessionTitle || `Cooking Session (${recipes.length} recipes)`,
    payload: {
      items,
      storageHints,
      context: {
        weeklyFlavorRhythm: prefs?.weeklyFlavorRhythm || null,
        householdId: prefs?.householdId || null
      }
    },
    meta: { source: 'worker', createdBy: 'automation.worker.js', createdAt: nowIso() }
  };
}

function buildCleaningDraft(input) {
  const { zones = [], constraints = {} } = input || {};
  const items = zones.map((z) => ({
    zoneId: z.id,
    name: z.name,
    supplies: z.supplyHints || [],
    timeBlock: constraints?.sabbath ? 'Auto-schedule outside Sabbath window' : 'Anytime'
  }));

  return {
    type: 'cleaning-session',
    title: `Cleaning Session (${zones.length} zones)`,
    payload: { items, constraints },
    meta: { source: 'worker', createdBy: 'automation.worker.js', createdAt: nowIso() }
  };
}

function buildMealPlanDraft(input) {
  const { profile = {}, prefs = {} } = input || {};
  return {
    type: 'meal-plan',
    title: prefs?.title || 'New Meal Plan (from profile)',
    payload: {
      weeklyFlavorRhythm: profile?.weeklyFlavorRhythm || prefs?.weeklyFlavorRhythm || null,
      householdId: profile?.householdId || prefs?.householdId || null,
      notes: 'Auto-generated from household profile (worker).'
    },
    meta: { source: 'worker', createdBy: 'automation.worker.js', createdAt: nowIso() }
  };
}

// ----------------------- Delegation to Backend (optional) ------------------
async function tryServer(kind, payload) {
  // If your Node side mounted /api/automation/generate, this will use it.
  const json = await safeJson('/api/automation/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, input: payload })
  });
  return json; // may be null
}

// ----------------------------- Command Router ------------------------------
async function handleGenerate(data) {
  const { type, payload } = data || {};
  if (!type) {
    log('error', 'Worker generate called without a type');
    return;
  }

  // 1) Prefer server agent if available
  const serverKind = (() => {
    switch (type) {
      case 'cooking-session': return 'recipes-to-cooking-session';
      case 'cleaning-session': return 'signals-to-cleaning-session';
      case 'meal-plan': return 'profile-to-meal-plan';
      default: return null;
    }
  })();

  if (serverKind) {
    const serverDraft = await tryServer(serverKind, payload);
    if (serverDraft && serverDraft.type) {
      post('draft', { data: serverDraft });
      return;
    }
  }

  // 2) Fallback to local heuristic
  let draft;
  switch (type) {
    case 'cooking-session':
      draft = buildCookingDraft(payload);
      break;
    case 'cleaning-session':
      draft = buildCleaningDraft(payload);
      break;
    case 'meal-plan':
      draft = buildMealPlanDraft(payload);
      break;
    default:
      draft = {
        type: type || 'note',
        title: 'Worker Draft',
        payload: clone(payload || {}),
        meta: { source: 'worker', createdBy: 'automation.worker.js', createdAt: nowIso() }
      };
  }

  // Ensure a stable id for client-side stores if they add one
  draft.id = draft.id || uid('draft');
  post('draft', { data: draft });
}

// Optional priming; you could prefetch flavor lists, etc.
async function warmup() {
  // no-op placeholder; keep for future caching
  return true;
}

// ------------------------------ Message Loop -------------------------------
self.addEventListener('message', (e) => {
  const msg = e?.data || {};
  const { type } = msg;

  switch (type) {
    case 'ping': {
      post('pong');
      break;
    }
    case 'warmup': {
      warmup().then(() => log('info', 'worker warmup complete'));
      break;
    }
    case 'generate': {
      // { data: { type, payload } }
      handleGenerate(msg.data).catch((err) => {
        log('error', 'worker generate failed', { message: err?.message || String(err) });
      });
      break;
    }
    default: {
      log('debug', 'unknown message to worker', { type });
    }
  }
});

// Identify worker version (helpful for debugging cache/bundle issues)
log('info', 'automation.worker.js ready', { version: '1.0.0', at: nowIso() });
