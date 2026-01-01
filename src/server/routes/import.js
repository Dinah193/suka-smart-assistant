// C:\Users\larho\suka-smart-assistant\src\server\routes\import.js
// -----------------------------------------------------------------------------
// SSA Import Route (server-side)
// -----------------------------------------------------------------------------
// PURPOSE
// This route is the *server entry point* for all external imports coming into
// the Suka Smart Assistant (SSA). Anything that comes from the outside world
// (bookmarklet, browser extension, mobile share sheet, CSV/JSON upload,
// partner webhook, “import from Allrecipes / YouTube / cleaning blog / seed
// supplier / animal husbandry guide”) should be able to POST here.
//
// PIPELINE (high-level)
// 1. Receive raw import → validate shape → add server metadata
// 2. Emit `import.received` on the shared eventBus
// 3. Hand off to ImportService (assume it exists in /src/features/import)
//    to normalize to SSA’s *context intelligence* shape
// 4. Emit `import.parsed` (or `import.failed` on error)
// 5. If the normalized payload *creates or updates* household data
//    (inventory, storehouse goals, sessions, garden, animal, preservation),
//    we also:
//      - emit the relevant domain event(s)
//      - call exportToHubIfEnabled(...) so SSA can *optionally* push the
//        same payload to the Suka Village Family Fund Hub (SVFFH)
// 6. Optionally nudge the automation runtime so it can auto-schedule
//    a session based on the import
//
// IMPORTANT RULES IMPLEMENTED HERE
// - SSA <> SVFFH separation: this route *always* treats SSA as source of truth.
//   We only *optionally* export to Hub if featureFlags.familyFundMode === true.
// - Multi-domain: we detect domain (recipe, cleaning, garden/seed, animal/
//   butchery, storehouse, video/how-to) from payload and branch accordingly.
// - Event-driven: every meaningful step emits { type, ts, source, data }.
// - Forward-thinking: adding a new import type = add to DOMAIN_HANDLERS below.
//
// ASSUMPTIONS
// - src/services/eventBus.js exists and exposes a simple .emit(eventObj)
// - src/config/featureFlags.js (or .json) exists and can be required here
// - src/services/hub/HubPacketFormatter.js & src/services/hub/FamilyFundConnector.js
//   both exist and can be *soft-required* (fail silently if missing)
// - src/features/import/ImportService.js exists and exposes an async
//   .process(rawPayload, options) → { kind, normalized, events, ... }
//
// NOTE
// This is an Express router file. Mount it in your server/app.js like:
//
//   const importRoute = require('./src/server/routes/import');
//   app.use('/api/import', importRoute);
//
// -----------------------------------------------------------------------------

const express = require('express');
const router = express.Router();

// Shared event bus (app-level, event-driven SSA)
const eventBus = safeRequire('../../services/eventBus', {
  emit: () => {},
});

// Feature flags (SSA owns data; Hub is optional)
const featureFlags = safeRequire('../../config/featureFlags', {
  familyFundMode: false,
});

// ImportService – high-level orchestrator for imports
const ImportService = safeRequire('../../features/import/ImportService', null);

// Optional: automation runtime on the server side (if present)
// so imports can immediately become actionable sessions
const automationRuntime = safeRequire('../../services/automation/runtime', {
  dispatch: () => {},
  scheduleFromImport: () => {},
});

// Optional Hub connectors
const HubPacketFormatter = safeRequire(
  '../../services/hub/HubPacketFormatter',
  { format: () => null }
);

const FamilyFundConnector = safeRequire(
  '../../services/hub/FamilyFundConnector',
  { send: async () => {} }
);

// -----------------------------------------------------------------------------
// Soft require helper
// -----------------------------------------------------------------------------
function safeRequire(path, fallback) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(path);
  } catch (err) {
    // In production you might want to log this to a central logger
    return fallback;
  }
}

// -----------------------------------------------------------------------------
// Helper: emit SSA event with consistent shape
// -----------------------------------------------------------------------------
function emitEvent(type, source, data = {}) {
  const evt = {
    type,
    ts: new Date().toISOString(),
    source, // e.g. 'server:import', 'server:import:recipe'
    data,
  };
  try {
    eventBus.emit(evt);
  } catch (err) {
    // fail silently – eventing should never crash request cycle
  }
  return evt;
}

// -----------------------------------------------------------------------------
// Helper: hub export (silent fail)
// -----------------------------------------------------------------------------
async function exportToHubIfEnabled(payload) {
  if (!featureFlags || !featureFlags.familyFundMode) return;
  try {
    const packet = HubPacketFormatter.format(payload);
    if (!packet) return;
    await FamilyFundConnector.send(packet);
  } catch (err) {
    // Silent fail – Hub is optional
  }
}

// -----------------------------------------------------------------------------
// Domain handlers – forward-thinking registry
// Add new import types here (e.g. 'preservation', 'health', 'finance')
// Each handler receives: (normalized, req, res)
// and returns: { events: [...], householdMutations: [...] }
// -----------------------------------------------------------------------------
const DOMAIN_HANDLERS = {
  recipe: async (normalized) => {
    // normalized.data should contain recipe, ingredients, equipment, steps...
    // Emit meal-planning friendly event
    const events = [
      emitEvent('import.parsed.recipe', 'server:import:recipe', normalized),
    ];

    // If it produced a meal session or inventory delta, we’ll return them
    const householdMutations = [];

    if (normalized.generated && normalized.generated.sessions) {
      householdMutations.push({
        kind: 'session.generated',
        sessions: normalized.generated.sessions,
      });
    }

    if (normalized.inventory && normalized.inventory.updated) {
      householdMutations.push({
        kind: 'inventory.updated',
        items: normalized.inventory.updated,
      });
    }

    return { events, householdMutations };
  },

  cleaning: async (normalized) => {
    const events = [
      emitEvent('import.parsed.cleaning', 'server:import:cleaning', normalized),
    ];

    const householdMutations = [];
    if (normalized.generated && normalized.generated.sessions) {
      householdMutations.push({
        kind: 'cleaning.session.generated',
        sessions: normalized.generated.sessions,
      });
    }

    return { events, householdMutations };
  },

  garden: async (normalized) => {
    const events = [
      emitEvent('import.parsed.garden', 'server:import:garden', normalized),
    ];

    const householdMutations = [];
    if (normalized.generated && normalized.generated.gardenTasks) {
      householdMutations.push({
        kind: 'garden.tasks.generated',
        tasks: normalized.generated.gardenTasks,
      });
    }

    // If import contained seed → storehouse or inventory seeding, reflect it
    if (normalized.inventory && normalized.inventory.plantables) {
      householdMutations.push({
        kind: 'inventory.updated',
        items: normalized.inventory.plantables,
      });
    }

    return { events, householdMutations };
  },

  animal: async (normalized) => {
    const events = [
      emitEvent('import.parsed.animal', 'server:import:animal', normalized),
    ];

    const householdMutations = [];
    if (normalized.generated && normalized.generated.animalSessions) {
      householdMutations.push({
        kind: 'animal.session.generated',
        sessions: normalized.generated.animalSessions,
      });
    }

    if (normalized.inventory && normalized.inventory.cuts) {
      householdMutations.push({
        kind: 'inventory.updated',
        items: normalized.inventory.cuts,
      });
    }

    return { events, householdMutations };
  },

  storehouse: async (normalized) => {
    const events = [
      emitEvent(
        'import.parsed.storehouse',
        'server:import:storehouse',
        normalized
      ),
    ];

    const householdMutations = [];
    if (normalized.generated && normalized.generated.storehouseGoals) {
      householdMutations.push({
        kind: 'storehouse.goals.updated',
        goals: normalized.generated.storehouseGoals,
      });
    }

    return { events, householdMutations };
  },

  video: async (normalized) => {
    // video/how-to imports create *context intelligence* more than sessions
    const events = [
      emitEvent('import.parsed.video', 'server:import:video', normalized),
    ];
    return { events, householdMutations: [] };
  },
};

// -----------------------------------------------------------------------------
// POST /api/import
// Receives raw import payloads from extensions / bookmarklet / mobile / partners
// -----------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const raw = req.body;

  // 1. Basic guard
  if (!raw || typeof raw !== 'object') {
    emitEvent('import.invalid', 'server:import', { reason: 'no body' });
    return res.status(400).json({
      ok: false,
      error: 'Invalid import: body required.',
    });
  }

  // 2. Add server metadata
  const receivedAt = new Date().toISOString();
  const source = raw.source || 'external';
  const importId = raw.id || `imp_${Date.now()}`;

  const baseCtx = {
    id: importId,
    receivedAt,
    ip: req.ip,
    ua: req.headers['user-agent'] || '',
  };

  emitEvent('import.received', 'server:import', {
    ...baseCtx,
    source,
    rawType: raw.type || 'unknown',
  });

  // 3. Normalize via ImportService (central SSA logic)
  if (!ImportService || typeof ImportService.process !== 'function') {
    // If the ImportService is not available, we still record the import
    emitEvent('import.failed', 'server:import', {
      ...baseCtx,
      reason: 'ImportService not available',
    });
    return res.status(503).json({
      ok: false,
      error: 'ImportService is temporarily unavailable.',
    });
  }

  let normalized;
  try {
    normalized = await ImportService.process(raw, {
      source,
      server: true,
      ip: req.ip,
      ua: req.headers['user-agent'] || '',
      // tell ImportService we want multi-domain support
      allow: ['recipe', 'cleaning', 'garden', 'animal', 'storehouse', 'video'],
    });
  } catch (err) {
    emitEvent('import.failed', 'server:import', {
      ...baseCtx,
      error: err.message,
    });
    return res.status(500).json({
      ok: false,
      error: 'Import could not be processed.',
      details: err.message,
    });
  }

  // normalized should now look like:
  // {
  //   kind: 'recipe' | 'cleaning' | 'garden' | 'animal' | 'storehouse' | 'video',
  //   data: { ...context intelligence... },
  //   generated: { ...sessions/tasks/goals... },
  //   inventory: { ...delta... },
  //   meta: { sourceUrl, site, importedAt, ... }
  // }

  if (!normalized || !normalized.kind) {
    emitEvent('import.failed', 'server:import', {
      ...baseCtx,
      reason: 'normalized missing kind',
    });
    return res.status(422).json({
      ok: false,
      error: 'Normalized import did not specify a kind.',
    });
  }

  const domain = normalized.kind;
  const handler = DOMAIN_HANDLERS[domain];

  if (!handler) {
    // Forward-thinking: unknown domain → still emit, still return OK,
    // just don’t apply domain-specific logic
    emitEvent('import.parsed.unknown', 'server:import', {
      ...baseCtx,
      normalized,
    });
    return res.json({
      ok: true,
      message: `Import processed but domain handler not found for "${domain}".`,
      normalized,
    });
  }

  // 4. Run domain handler
  let domainResult;
  try {
    domainResult = await handler(normalized);
  } catch (err) {
    emitEvent('import.failed', 'server:import', {
      ...baseCtx,
      error: err.message,
      domain,
    });
    return res.status(500).json({
      ok: false,
      error: `Domain handler failed for "${domain}".`,
      details: err.message,
    });
  }

  // 5. Emit domain-level household mutations + export to Hub if needed
  //    and ping automation runtime
  if (domainResult && Array.isArray(domainResult.householdMutations)) {
    for (const mutation of domainResult.householdMutations) {
      // Emit domain-level event
      emitEvent(mutation.kind, 'server:import', mutation);

      // Export to Hub (optional)
      await exportToHubIfEnabled({
        mutation,
        source: 'server:import',
        at: new Date().toISOString(),
      });

      // Automation: tell runtime we have something new to schedule
      if (automationRuntime && typeof automationRuntime.scheduleFromImport === 'function') {
        try {
          await automationRuntime.scheduleFromImport({
            mutation,
            normalized,
            domain,
            importId,
          });
        } catch (err) {
          // automation is best-effort; do not fail request
        }
      }
    }
  }

  // 6. Final success response
  return res.json({
    ok: true,
    id: importId,
    receivedAt,
    domain,
    normalized,
    events: domainResult ? domainResult.events || [] : [],
  });
});

// -----------------------------------------------------------------------------
// OPTIONAL: GET /api/import/health
// quick health check to see if ImportService + eventBus are alive
// -----------------------------------------------------------------------------
router.get('/health', (req, res) => {
  const healthy = !!ImportService && typeof ImportService.process === 'function';
  return res.json({
    ok: healthy,
    importService: healthy ? 'available' : 'missing',
    eventBus: !!eventBus ? 'available' : 'missing',
    ts: new Date().toISOString(),
  });
});

module.exports = router;
