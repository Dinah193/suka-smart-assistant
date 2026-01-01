/* eslint-disable no-console */
// src/features/scan-compare-trust/automation/handlers/onSafetyCheckCompleted.js
// Purpose: Transform safety results into NBA nudges/toasts (+inbox), with guards & dedupe.
//
// Upstream events typically emitted by your pipeline/fanout:
// - 'product:safety:evaluated'  payload = {
//     requestId, sessionId, productId,
//     safety: { ok, findings: [{ code, title, severity:'high'|'medium'|'low', kind, source, details, refUrl? }], meta? },
//     durationMs
//   }
//
// This handler will:
// - Respect Sabbath/QuietHour guards (defer to inbox if active)
// - De-dupe (TTL) per productId + finding codes
// - Emit 'ui:toast:show' (interactive), 'nba:nudge:queued' (for NBA stream), and inbox events
// - Provide actionable buttons that other handlers/listeners consume
//
// DI (all optional; safe fallbacks):
// - eventBus   : { emit(evt, payload) }
// - config     : { get(path, fb), sabbathGuard?, quietHours? }
// - analytics  : { track(evt, payload) }
// - dexie      : { inbox?:Table, nudges?:Table }   // optional persistence
// - nba        : { queue(nudge), preferInbox?:()=>boolean } // optional NBA orchestrator
// - uid        : { rid():string }
// - clock      : { now():Date }
// - cache      : { get(k), set(k,v) } // TTL cache (optional)
// - favorites  : { saveSession(sessionObj) } // optional (for user-saved safety sessions)
// - coupons    : { suggestSafeBrandCoupons(product, ctx) } // optional helper
// - alternatives: { findSafer(product, userPrefs, ctx) }   // optional helper
// - userPrefs  : { loader?(userId, householdId): Promise<Prefs> }
//
// Notes:
// - This handler doesn’t fetch alternatives/coupons itself; it only *requests* them via events.
// - Buttons emit intent events; your existing listeners (e.g., ProductResolver, CouponService) act.

export default function createOnSafetyCheckCompleted(deps = {}) {
  const eventBus  = deps.eventBus  || { emit: () => {} };
  const config    = deps.config    || { get: () => undefined, sabbathGuard: {}, quietHours: {} };
  const analytics = deps.analytics || { track: () => {} };
  const dexie     = deps.dexie     || {};
  const nba       = deps.nba       || { queue: async () => {}, preferInbox: () => false };
  const uid       = deps.uid       || { rid: () => cryptoId() };
  const clock     = deps.clock     || { now: () => new Date() };
  const cache     = deps.cache     || createTTLCache({ ttlMs: 3 * 60 * 1000 }); // 3 min dedupe window
  const favorites = deps.favorites || { saveSession: async () => {} };

  return async function onSafetyCheckCompleted(payload = {}) {
    const now = clock.now();
    const {
      requestId = uid.rid(),
      sessionId = uid.rid(),
      userId,
      householdId,
      productId,
      safety,
      meta = {} // { favoriteSessionName?, scheduleId?, templateId? }
    } = payload;

    // Defensive guards
    if (!safety || !Array.isArray(safety.findings)) {
      const err = { code: 'NO_SAFETY_DATA', message: 'No safety findings supplied' };
      eventBus.emit('nba:nudge:skipped', { requestId, sessionId, productId, reason: err });
      return { ok: false, requestId, sessionId, error: err };
    }

    // Load prefs (avoidIngredients, alert thresholds, etc.)
    const prefs = await loadUserPrefsSafe(config, userId, householdId);

    // Compute highest severity & group messages
    const { severity, groups } = summarizeFindings(safety.findings, prefs);

    // Deduplicate for this productId+codes
    const sig = buildSignature(productId, groups);
    if (cache.get(sig)) {
      eventBus.emit('nba:nudge:deduped', { requestId, sessionId, productId, signature: sig });
      return { ok: true, requestId, sessionId, deduped: true };
    }
    cache.set(sig, true);

    // Quiet Hours / Sabbath Guard → route to inbox
    const guarded = sabbathGuardActive(config, now) || quietHoursActive(config, now) || nba.preferInbox();
    const delivery = guarded ? 'inbox' : 'toast';

    // Persist nudge (optional)
    const nudgeRecord = {
      id: uid.rid(),
      requestId, sessionId, productId,
      severity, groups,
      delivery,
      createdAt: now.toISOString(),
      meta,
    };
    if (dexie?.nudges?.add) {
      try { await dexie.nudges.add(nudgeRecord); } catch {}
    }

    // Build NBA object with actionable intents
    const nudge = buildNudge({ productId, severity, groups, prefs, requestId, sessionId });

    // Queue into NBA (so other panes/widgets can react)
    try { await nba.queue(nudge); } catch {}

    // Deliver
    if (delivery === 'toast') {
      // Single urgent modal toast for recalls; stackable toasts for others
      if (severity === 'high' && groups.recall.length) {
        eventBus.emit('ui:toast:show', makeRecallModalToast(nudge, groups.recall, now));
      } else {
        // Allergen / Harmful / FYI
        groups.allergen.length && eventBus.emit('ui:toast:show', makeToast('high', nudge, 'Potential allergen detected', 'View findings', 'safety:view'));
        groups.harmful.length  && eventBus.emit('ui:toast:show', makeToast('high', nudge, 'Harmful ingredient flagged', 'Safer alternatives', 'alternatives:request'));
        groups.fyi.length      && eventBus.emit('ui:toast:show', makeToast('low',  nudge, 'Heads-up on this product', 'Show details', 'safety:view'));
      }
    } else {
      // Inbox path
      const inboxItem = {
        id: uid.rid(),
        type: 'safety',
        title: inboxTitle(severity, groups),
        body: inboxBody(groups),
        productId,
        createdAt: now.toISOString(),
        cta: [
          { id: 'safety:view', label: 'View findings' },
          { id: 'alternatives:request', label: 'Find safer alternatives' },
          { id: 'coupons:safeBrand', label: 'Clip safe-brand coupons' },
          { id: 'prefs:remember', label: 'Remember preference' },
        ],
        meta: { requestId, sessionId, severity }
      };
      if (dexie?.inbox?.add) {
        try { await dexie.inbox.add(inboxItem); } catch {}
      }
      eventBus.emit('inbox:notification:added', inboxItem);
    }

    // Emit a general "nudge queued" event for any listeners (e.g., RecoveryStrip)
    eventBus.emit('nba:nudge:queued', { requestId, sessionId, nudge, delivery, severity });

    analytics.track('safety_nudge_emitted', { requestId, sessionId, productId, severity, delivery });

    // Optional: allow users to save this safety-only setup as a favorite
    if (meta.favoriteSessionName) {
      try {
        await favorites.saveSession({
          name: meta.favoriteSessionName,
          kind: 'scanSafetyOnly',
          template: { flags: { safetyOnly: true }, scheduleId: meta.scheduleId || null },
          savedAt: now.toISOString(),
          userId, householdId,
        });
        eventBus.emit('favorites:session:saved', { requestId, sessionId, name: meta.favoriteSessionName, type: 'scanSafetyOnly' });
      } catch (e) {
        console.warn('favorites.saveSession failed', e);
      }
    }

    return { ok: true, requestId, sessionId, severity, delivery };
  };

  // ------------------ helpers ------------------

  function cryptoId() {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch {}
    return 'id_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function createTTLCache({ ttlMs }) {
    const map = new Map();
    return {
      get(k) {
        const r = map.get(k); if (!r) return null;
        if (Date.now() > r.exp) { map.delete(k); return null; }
        return r.val;
      },
      set(k, v) { map.set(k, { val: v, exp: Date.now() + ttlMs }); }
    };
  }

  function sabbathGuardActive(cfg, now) {
    const sg = cfg.sabbathGuard || cfg.get?.('sabbathGuard', {});
    if (!sg?.enabled) return false;
    // Simple: Fri 18:00 – Sat 20:00
    const day = now.getDay();
    const hr  = now.getHours();
    return (day === 5 && hr >= 18) || (day === 6 && hr <= 20);
    // If you have precise windows, replace with date-math using sg.start/sg.end.
  }

  function quietHoursActive(cfg, now) {
    const qh = cfg.quietHours || cfg.get?.('quietHours', {});
    if (!qh?.start || !qh?.end) return false;
    return isWithinRange(now, qh.start, qh.end);
  }

  function isWithinRange(now, startHHMM, endHHMM) {
    const [sh, sm] = (startHHMM || '23:59').split(':').map(Number);
    const [eh, em] = (endHHMM   || '00:00').split(':').map(Number);
    const start = new Date(now); start.setHours(sh ?? 0, sm ?? 0, 0, 0);
    const end   = new Date(now); end.setHours(eh ?? 0, em ?? 0, 0, 0);
    return start <= end ? now >= start && now <= end : (now >= start || now <= end);
  }

  async function loadUserPrefsSafe(config, userId, householdId) {
    try {
      const loader = config.get?.('userPrefs.loader');
      if (loader) {
        const p = await loader(userId, householdId);
        if (p) return p;
      }
    } catch {}
    return {
      alertThreshold: 'medium',               // 'low' | 'medium' | 'high'
      avoidIngredients: [],
      dietTags: [],
      stores: config.get?.('scanCompareTrust.defaultStores', []) ?? [],
    };
  }

  function summarizeFindings(findings, prefs) {
    const groups = { recall: [], allergen: [], harmful: [], fyi: [] };
    for (const f of findings) {
      if (f.kind === 'recall' || f.code === 'RECALL') groups.recall.push(f);
      else if (f.kind === 'allergen') groups.allergen.push(f);
      else if (f.kind === 'harmful' || f.code === 'HARMFUL_INGREDIENT') groups.harmful.push(f);
      else groups.fyi.push(f);
    }
    // Highest severity present
    const sevRank = { high: 3, medium: 2, low: 1 };
    let severity = 'low';
    for (const f of findings) {
      const s = f.severity || 'low';
      if (sevRank[s] > sevRank[severity]) severity = s;
    }
    // Allow prefs to raise/lower threshold (e.g., allergens are always high)
    if (groups.allergen.length && prefs?.alertThreshold !== 'high') {
      // Promote allergen to high if user has dietTags/avoid list matching
      severity = 'high';
    }
    return { severity, groups };
  }

  function buildSignature(productId, groups) {
    const codes = [
      ...groups.recall.map(f => f.code),
      ...groups.allergen.map(f => f.code),
      ...groups.harmful.map(f => f.code),
      ...groups.fyi.map(f => f.code),
    ].filter(Boolean).sort().join('|');
    return `safety:${productId}:${codes}`;
  }

  function buildNudge({ productId, severity, groups, prefs, requestId, sessionId }) {
    // Map groups into CTA intents consumed by other handlers
    const intents = [];
    if (groups.recall.length) {
      intents.push({ id: 'safety:view', label: 'View recall details', priority: 'urgent' });
    }
    if (groups.harmful.length || groups.allergen.length) {
      intents.push({ id: 'alternatives:request', label: 'Find safer alternatives', priority: 'high' });
      intents.push({ id: 'prefs:remember', label: 'Remember preference', priority: 'medium' });
      intents.push({ id: 'coupons:safeBrand', label: 'Clip safe-brand coupons', priority: 'medium' });
    }
    if (groups.fyi.length && !intents.length) {
      intents.push({ id: 'safety:view', label: 'Show details', priority: 'low' });
    }

    return {
      id: `nudge_${requestId}`,
      channel: 'scan-compare-trust',
      productId,
      severity,
      intents,
      meta: {
        requestId, sessionId,
        groups: {
          recall: groups.recall.length,
          allergen: groups.allergen.length,
          harmful: groups.harmful.length,
          fyi: groups.fyi.length,
        }
      }
    };
  }

  function makeRecallModalToast(nudge, recallFindings, now) {
    const top = recallFindings[0];
    return {
      id: `toast_${nudge.id}`,
      kind: 'modal',                    // your UI can render this as a blocking modal
      tone: 'destructive',
      title: '⚠️ Product Recall Detected',
      message: top?.title || 'This item is under an active recall. Tap to review.',
      actions: [
        { id: 'safety:view', label: 'View recall details', primary: true },
        { id: 'alternatives:request', label: 'Find safer alternatives' },
        { id: 'prefs:remember', label: 'Remember preference' },
      ],
      meta: { ...nudge.meta, emittedAt: now.toISOString() }
    };
  }

  function makeToast(tone, nudge, message, ctaLabel, ctaId) {
    return {
      id: `toast_${nudge.id}_${ctaId}`,
      kind: 'toast',
      tone, // 'high'|'low' mapped by your UI to color/severity
      title: 'Safety check',
      message,
      actions: [
        { id: ctaId, label: ctaLabel, primary: true },
        ...(nudge.intents.find(i => i.id === 'coupons:safeBrand') ? [{ id: 'coupons:safeBrand', label: 'Clip safe-brand coupons' }] : []),
        ...(nudge.intents.find(i => i.id === 'prefs:remember') ? [{ id: 'prefs:remember', label: 'Remember preference' }] : []),
      ],
      meta: nudge.meta
    };
  }

  function inboxTitle(severity, groups) {
    if (groups.recall.length) return 'Product Recall Detected';
    if (severity === 'high')   return 'Important Safety Alert';
    if (groups.allergen.length) return 'Possible Allergen';
    if (groups.harmful.length)  return 'Harmful Ingredient Flagged';
    return 'Safety Heads-up';
    }

  function inboxBody(groups) {
    const parts = [];
    if (groups.recall.length)   parts.push(`Recall notices: ${groups.recall.length}`);
    if (groups.allergen.length) parts.push(`Allergen alerts: ${groups.allergen.length}`);
    if (groups.harmful.length)  parts.push(`Harmful ingredients: ${groups.harmful.length}`);
    if (groups.fyi.length)      parts.push(`FYI notes: ${groups.fyi.length}`);
    return parts.join(' • ');
  }
}
