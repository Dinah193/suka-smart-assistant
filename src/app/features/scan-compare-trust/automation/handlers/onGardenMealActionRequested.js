/* eslint-disable no-console */
// src/features/scan-compare-trust/automation/handlers/onGardenMealActionRequested.js
// Purpose: Bridge Scan • Compare • Trust actions to Garden & Meal engines.
// Orchestration: intent → build work orders → dispatch to engine(s) → stream progress → NBA nudges
//
// Upstream event (typical from ScanSheet/CTA buttons):
// 'garden:meal:action:requested' payload = {
//   requestId?, sessionId?, userId?, householdId?,
//   intent: 'plan_garden_from_seeds' | 'add_to_meal_plan' | 'use_on_hand' | 'grow_for_meals' | 'replant_suggestions',
//   product?,                  // safe product shape (id/sku/gtin/name/...)
//   seeds?: [{ name, variety?, gtin?, crop, qty?, unit?, maturityDays?, sowDepth?, spacing?, notes? }], // from OCR/seed packs
//   meals?: { targetWindow?:{startISO,endISO}, tags?:string[], servings?:number },
//   context?: { location?, device?, stores?:string[], seasonHint?:string },
//   meta?: { favoriteSessionName?, scheduleId?, templateId? },
//   flags?: { deferIfGuarded?: boolean, allowPartial?: boolean, enableToasts?: boolean }
// }
//
// DI (all optional; safe fallbacks):
// - eventBus    : { emit(evt, payload) }
// - config      : { get(path, fb), sabbathGuard?, quietHours? }
// - analytics   : { track(evt, payload) }
// - gardenAgent : { planBeds(seeds, opts), replant(opts), linkInventoryToBeds(items, opts) } // async
// - mealAgent   : { addToPlan(items, opts), suggestMeals(opts), linkGardenToMeals(map, opts) } // async
// - dexie       : { tasks?:Table, inbox?:Table, favorites?:Table } // optional persistence
// - nba         : { queue(nudge), preferInbox?:()=>boolean }
// - favorites   : { saveSession(sessionObj), getSessionById(id) }
// - schedules   : { rememberLastRun(meta) }
// - uid         : { rid():string }
// - clock       : { now():Date }
//
// Notes:
// - This is a "thin orchestrator": it builds work orders and delegates to agents.
// - Emits canonical events so UI modules (ScanSheet, Planner, Garden dashboards) can react.

export default function createOnGardenMealActionRequested(deps = {}) {
  const eventBus    = deps.eventBus    || { emit: () => {} };
  const config      = deps.config      || { get: () => undefined, sabbathGuard: {}, quietHours: {} };
  const analytics   = deps.analytics   || { track: () => {} };
  const gardenAgent = deps.gardenAgent || { planBeds: async () => ({}), replant: async () => ({}), linkInventoryToBeds: async () => ({}) };
  const mealAgent   = deps.mealAgent   || { addToPlan: async () => ({}), suggestMeals: async () => ({}), linkGardenToMeals: async () => ({}) };
  const dexie       = deps.dexie       || {};
  const nba         = deps.nba         || { queue: async () => {}, preferInbox: () => false };
  const favorites   = deps.favorites   || { saveSession: async () => {}, getSessionById: async () => null };
  const schedules   = deps.schedules   || { rememberLastRun: async () => {} };
  const uid         = deps.uid         || { rid: () => cryptoId() };
  const clock       = deps.clock       || { now: () => new Date() };

  return async function onGardenMealActionRequested(payload = {}) {
    const now = clock.now();
    const {
      requestId = uid.rid(),
      sessionId = uid.rid(),
      userId, householdId,
      intent,
      product,
      seeds = [],
      meals  = {},
      context = {},
      meta = {},
      flags = {}
    } = payload;

    if (!intent) {
      const error = { code: 'NO_INTENT', message: 'No intent provided' };
      eventBus.emit('garden:meal:action:failed', { requestId, sessionId, error });
      return { ok: false, requestId, sessionId, error };
    }

    const effectiveFlags = {
      deferIfGuarded: true,
      allowPartial: true,
      enableToasts: true,
      ...flags,
    };

    // Guards → optionally defer to inbox
    const guarded = sabbathGuardActive(config, now) || quietHoursActive(config, now);
    if (guarded && effectiveFlags.deferIfGuarded) {
      await queueInbox(dexie, eventBus, {
        id: `inbox_${requestId}`,
        type: 'action',
        title: actionTitle(intent),
        body: 'Scheduled due to Quiet Hours/Sabbath Guard.',
        createdAt: now.toISOString(),
        cta: [{ id: 'action:run_now', label: 'Run now' }],
        meta: { requestId, sessionId, intent, productId: idOf(product) }
      });
      eventBus.emit('garden:meal:action:deferred', { requestId, sessionId, intent });
      analytics.track('garden_meal_action_deferred', { requestId, sessionId, intent });
      return { ok: true, requestId, sessionId, deferred: true };
    }

    // Persist: create a task row (optional)
    const taskId = `task_${requestId}`;
    await persistTask(dexie, {
      id: taskId,
      requestId, sessionId, userId, householdId,
      intent, product: pickSafeProductShape(product),
      seeds: seeds.map(pickSeedShape),
      meals, context,
      status: 'pending',
      createdAt: now.toISOString()
    });

    // Emit start
    eventBus.emit('garden:meal:action:started', {
      requestId, sessionId, intent,
      productId: idOf(product),
      seedsCount: seeds.length,
      atISO: now.toISOString()
    });

    let result = null;
    try {
      switch (intent) {
        case 'plan_garden_from_seeds': {
          // Build garden planning work order from seed packets (OCR-supported)
          const workOrder = buildGardenWorkOrderFromSeeds(seeds, context, product);
          eventBus.emit('garden:plan:requested', { requestId, sessionId, workOrder });

          const plan = await gardenAgent.planBeds(workOrder.seeds, {
            schedule: workOrder.schedule,
            location: context.location,
            seasonHint: context.seasonHint,
            userId, householdId,
          });

          // Link to meals if user wants to grow for recipes
          let linking = null;
          if (meals?.tags?.length || meals?.targetWindow) {
            linking = await mealAgent.linkGardenToMeals({ plan, meals }, { userId, householdId });
            eventBus.emit('meals:garden:linked', { requestId, sessionId, linking });
          }

          result = { plan, linking };
          break;
        }

        case 'add_to_meal_plan': {
          // Add scanned product (or seed output) into meal plan window
          const items = buildMealItemsFromProduct(product, meals);
          eventBus.emit('meals:plan:add:requested', { requestId, sessionId, items, meals });

          const planRes = await mealAgent.addToPlan(items, {
            targetWindow: meals.targetWindow,
            tags: meals.tags || [],
            servings: meals.servings || 0,
            userId, householdId
          });
          result = { plan: planRes };
          break;
        }

        case 'use_on_hand': {
          // Prefer pantry/inventory ingredients → suggest recipes
          const suggest = await mealAgent.suggestMeals({
            mode: 'on_hand',
            product: pickSafeProductShape(product),
            tags: meals.tags || [],
            servings: meals.servings || 0,
            userId, householdId
          });
          result = { suggestions: suggest };
          break;
        }

        case 'grow_for_meals': {
          // Map product → crop → plan bed(s) and link to meal plan timeframes
          const cropSeed = mapProductToCropSeed(product, seeds);
          const plan = await gardenAgent.planBeds([cropSeed], {
            schedule: inferScheduleFromMeals(meals),
            location: context.location,
            seasonHint: context.seasonHint,
            userId, householdId
          });
          const linking = await mealAgent.linkGardenToMeals({ plan, meals }, { userId, householdId });
          result = { plan, linking };
          break;
        }

        case 'replant_suggestions': {
          // Ask garden agent for replant tasks from inventory depletion & meal cadence
          const replant = await gardenAgent.replant({
            seasonHint: context.seasonHint,
            userId, householdId
          });
          result = { replant };
          break;
        }

        default: {
          throw Object.assign(new Error('UNSUPPORTED_INTENT'), { code: 'UNSUPPORTED_INTENT' });
        }
      }

      // Update task
      await updateTask(dexie, taskId, {
        status: 'completed',
        completedAt: clock.now().toISOString(),
        resultSummary: summarizeResult(intent, result)
      });

      // NBA nudge + toast/inbox
      const nudge = buildActionNudge({ requestId, sessionId, intent, product, seeds, meals, result });
      try { await nba.queue(nudge); } catch {}
      deliverNudge(eventBus, dexie, nudge, now, { enableToasts: effectiveFlags.enableToasts, inboxFallback: nba.preferInbox() });

      // Remember last run (scheduler recap / “Run Again”)
      try { await schedules.rememberLastRun({ type: `action:${intent}`, requestId, sessionId, userId, scheduleId: meta.scheduleId || null, atISO: clock.now().toISOString() }); } catch {}

      // Optional: save as user favorite session template
      if (meta.favoriteSessionName) {
        try {
          await favorites.saveSession({
            name: meta.favoriteSessionName,
            kind: 'scanAction',
            template: {
              intent,
              seeds: seeds.map(pickSeedShape),
              meals,
              flags: effectiveFlags,
              scheduleId: meta.scheduleId || null
            },
            savedAt: clock.now().toISOString(),
            userId, householdId,
          });
          eventBus.emit('favorites:session:saved', { requestId, sessionId, name: meta.favoriteSessionName, type: 'scanAction' });
        } catch (e) { console.warn('favorites.saveSession failed', e); }
      }

      const out = { ok: true, requestId, sessionId, intent, result };
      eventBus.emit('garden:meal:action:completed', out);
      analytics.track('garden_meal_action_completed', { requestId, sessionId, intent });
      return out;

    } catch (e) {
      const error = normalizeError(e);
      await updateTask(dexie, taskId, { status: 'failed', failedAt: clock.now().toISOString(), error });
      const fail = { ok: false, requestId, sessionId, intent, error };
      eventBus.emit('garden:meal:action:failed', fail);
      analytics.track('garden_meal_action_failed', { requestId, sessionId, intent, code: error.code });
      if (effectiveFlags.allowPartial && error.partial) {
        const partial = { ...fail, ...error.partial };
        eventBus.emit('garden:meal:action:partial', partial);
        return partial;
      }
      return fail;
    }
  };

  // ---------- helpers ----------

  function cryptoId() {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch {}
    return 'id_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function sabbathGuardActive(cfg, now) {
    const sg = cfg.sabbathGuard || cfg.get?.('sabbathGuard', {});
    if (!sg?.enabled) return false;
    const d = now.getDay(); const h = now.getHours();
    return (d === 5 && h >= 18) || (d === 6 && h <= 20);
  }
  function quietHoursActive(cfg, now) {
    const qh = cfg.quietHours || cfg.get?.('quietHours', {});
    if (!qh?.start || !qh?.end) return false;
    return isWithinRange(now, qh.start, qh.end);
  }
  function isWithinRange(now, startHHMM, endHHMM) {
    const [sh, sm] = (startHHMM || '23:59').split(':').map(Number);
    const [eh, em] = (endHHMM || '00:00').split(':').map(Number);
    const s = new Date(now); s.setHours(sh ?? 0, sm ?? 0, 0, 0);
    const e = new Date(now); e.setHours(eh ?? 0, em ?? 0, 0, 0);
    return s <= e ? now >= s && now <= e : (now >= s || now <= e);
  }

  function idOf(p) { return p?.id || p?.gtin || p?.sku || p?.upc || 'unknown'; }
  function pickSafeProductShape(p) {
    if (!p) return null;
    const { id, sku, gtin, upc, brand, name, size, unit, images, category, subcategory, tags, meta } = p;
    return {
      id, sku, gtin, upc, brand, name, size, unit, images, category, subcategory, tags,
      meta: meta ? {
        ...meta,
        providers: Array.isArray(meta.providers) ? meta.providers.map(x => ({ id: x.id, name: x.name })) : undefined
      } : undefined
    };
  }
  function pickSeedShape(s) {
    if (!s) return null;
    const { name, variety, gtin, crop, qty, unit, maturityDays, sowDepth, spacing, notes } = s;
    return { name, variety, gtin, crop, qty, unit, maturityDays, sowDepth, spacing, notes };
  }

  function actionTitle(intent) {
    switch (intent) {
      case 'plan_garden_from_seeds': return 'Plan Garden from Seed Packets';
      case 'add_to_meal_plan':       return 'Add to Meal Plan';
      case 'use_on_hand':            return 'Use On-Hand Ingredients';
      case 'grow_for_meals':         return 'Grow for Future Meals';
      case 'replant_suggestions':    return 'Replant Suggestions';
      default: return 'Requested Action';
    }
  }

  async function persistTask(dexie, row) {
    if (dexie?.tasks?.add) { try { await dexie.tasks.add(row); } catch {} }
  }
  async function updateTask(dexie, id, patch) {
    if (dexie?.tasks?.update) { try { await dexie.tasks.update(id, patch); } catch {} }
  }

  function buildGardenWorkOrderFromSeeds(seeds, context, product) {
    // Derive schedule hints from season or product metadata
    const schedule = {
      startISO: context?.seasonHint ? seasonStartISO(context.seasonHint) : null,
      endISO: context?.seasonHint ? seasonEndISO(context.seasonHint) : null,
    };
    // Normalize seed list
    const norm = (seeds || []).map(pickSeedShape).filter(Boolean);
    // If product contains crop info (e.g., seed packet scanned), fold it in
    if (product?.meta?.seed) {
      const sp = product.meta.seed;
      norm.push(pickSeedShape({
        name: product.name, crop: sp.crop || product.meta.crop, qty: sp.qty, unit: sp.unit,
        maturityDays: sp.maturityDays, sowDepth: sp.sowDepth, spacing: sp.spacing, notes: sp.notes
      }));
    }
    return { seeds: dedupeSeeds(norm), schedule };
  }

  function dedupeSeeds(list) {
    const key = s => `${(s.crop || s.name || '').toLowerCase()}:${s.variety || ''}`;
    const map = new Map();
    for (const s of list) {
      const k = key(s);
      if (!map.has(k)) map.set(k, { ...s });
      else {
        const prev = map.get(k);
        const qty = (Number(prev.qty || 0) + Number(s.qty || 0)) || prev.qty || s.qty;
        map.set(k, { ...prev, qty });
      }
    }
    return [...map.values()];
  }

  function buildMealItemsFromProduct(product, meals) {
    const base = pickSafeProductShape(product);
    return [{
      product: base,
      qty: meals?.servings ? Number(meals.servings) : 1,
      unit: base?.unit || 'ea',
      tags: meals?.tags || []
    }];
  }

  function mapProductToCropSeed(product, seeds) {
    // Try to infer crop from product category/name; fallback to first seed crop
    const crop = product?.category || product?.name?.split(' ')[0] || seeds[0]?.crop || 'mixed greens';
    return { name: crop, crop, qty: 1, unit: 'pkt', maturityDays: 60, sowDepth: '0.5 in', spacing: '6 in' };
  }

  function inferScheduleFromMeals(meals) {
    // If user provided a target meal window, back-calculate sowing window
    const start = meals?.targetWindow?.startISO ? new Date(meals.targetWindow.startISO) : null;
    const end   = meals?.targetWindow?.endISO   ? new Date(meals.targetWindow.endISO)   : null;
    if (!start || !end) return null;
    // crude: assume 60 days maturity default; engines can refine per crop
    const sow = new Date(start); sow.setDate(sow.getDate() - 60);
    return { startISO: sow.toISOString(), endISO: end.toISOString() };
  }

  function seasonStartISO(season) {
    const now = new Date();
    const y = now.getFullYear();
    const map = { spring:`${y}-03-15`, summer:`${y}-06-01`, fall:`${y}-09-01`, winter:`${y}-12-01` };
    return new Date(map[season] || now).toISOString();
  }
  function seasonEndISO(season) {
    const now = new Date();
    const y = now.getFullYear();
    const map = { spring:`${y}-06-01`, summer:`${y}-09-01`, fall:`${y}-12-01`, winter:`${y+1}-03-01` };
    return new Date(map[season] || now).toISOString();
  }

  function summarizeResult(intent, result) {
    if (!result) return 'No result';
    if (intent === 'plan_garden_from_seeds' || intent === 'grow_for_meals') {
      const beds = Array.isArray(result?.plan?.beds) ? result.plan.beds.length : 0;
      return `Garden plan created (${beds} bed${beds===1?'':'s'})`;
    }
    if (intent === 'add_to_meal_plan') {
      const meals = Array.isArray(result?.plan?.items) ? result.plan.items.length : 0;
      return `Added to meal plan (${meals} item${meals===1?'':'s'})`;
    }
    if (intent === 'use_on_hand') {
      const n = Array.isArray(result?.suggestions?.recipes) ? result.suggestions.recipes.length : 0;
      return `Suggested ${n} recipe${n===1?'':'s'} using on-hand items`;
    }
    if (intent === 'replant_suggestions') {
      const n = Array.isArray(result?.replant?.tasks) ? result.replant.tasks.length : 0;
      return `Generated ${n} replant task${n===1?'':'s'}`;
    }
    return 'Action completed';
  }

  function buildActionNudge({ requestId, sessionId, intent, product, seeds, meals, result }) {
    const intents = [];
    switch (intent) {
      case 'plan_garden_from_seeds':
        intents.push({ id: 'garden:view_plan', label: 'View garden plan', primary: true });
        intents.push({ id: 'garden:print_labels', label: 'Print bed labels' });
        intents.push({ id: 'meals:link', label: 'Link to meals' });
        break;
      case 'add_to_meal_plan':
        intents.push({ id: 'meals:view_plan', label: 'View meal plan', primary: true });
        intents.push({ id: 'grocery:gen_list', label: 'Generate grocery list' });
        break;
      case 'use_on_hand':
        intents.push({ id: 'meals:view_suggestions', label: 'View suggestions', primary: true });
        intents.push({ id: 'inventory:adjust', label: 'Adjust inventory' });
        break;
      case 'grow_for_meals':
        intents.push({ id: 'garden:view_plan', label: 'View garden plan', primary: true });
        intents.push({ id: 'meals:link', label: 'Link to meals' });
        break;
      case 'replant_suggestions':
        intents.push({ id: 'garden:view_tasks', label: 'Review replant tasks', primary: true });
        break;
      default: intents.push({ id: 'action:view', label: 'View details', primary: true });
    }
    return {
      id: `nudge_action_${requestId}`,
      channel: 'scan-compare-trust',
      productId: idOf(product),
      severity: 'info',
      intents,
      meta: {
        requestId, sessionId, intent,
        seedsCount: seeds.length || 0,
        meals: meals || null,
        summary: summarizeResult(intent, result)
      }
    };
  }

  async function queueInbox(dexie, eventBus, item) {
    if (dexie?.inbox?.add) { try { await dexie.inbox.add(item); } catch {} }
    eventBus.emit('inbox:notification:added', item);
  }

  function deliverNudge(eventBus, dexie, nudge, now, opts) {
    const enableToasts = !!opts.enableToasts;
    if (!enableToasts || opts.inboxFallback) {
      queueInbox(dexie, eventBus, {
        id: `inbox_${nudge.id}`,
        type: 'action',
        title: actionTitle(nudge.meta.intent),
        body: nudge.meta.summary || 'Action completed.',
        createdAt: now.toISOString(),
        cta: nudge.intents,
        meta: nudge.meta
      });
      return;
    }
    // Toast
    eventBus.emit('ui:toast:show', {
      id: `toast_${nudge.id}`,
      kind: 'toast',
      tone: 'success',
      title: actionTitle(nudge.meta.intent),
      message: nudge.meta.summary || 'Done.',
      actions: nudge.intents,
      meta: nudge.meta
    });
  }

  function normalizeError(err) {
    if (err?.name === 'AbortError' || err === 'timeout') {
      return { code: 'TIMEOUT', message: 'Action timed out' };
    }
    if (err?.code === 'UNSUPPORTED_INTENT') {
      return { code: 'UNSUPPORTED_INTENT', message: 'Unsupported intent' };
    }
    return { code: err?.code || 'UNKNOWN', message: err?.message || String(err) };
  }
}
