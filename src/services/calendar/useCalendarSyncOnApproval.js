// src/services/calendar/useCalendarSyncOnApproval.js
import { useEffect, useRef } from "react";
import { eventBus } from "@/services/events/eventBus";
import { useHouseholdCalendar } from "@/store/HouseholdCalendarStore";

/**
 * useCalendarSyncOnApproval
 * -------------------------
 * Listens for approval events across modules (cooking, cleaning, animal, garden,
 * inventory) and, on approval only, creates HouseholdCalendar events and (optionally)
 * syncs to external calendars. Supports mixed event names & payload shapes.
 *
 * Supported topics:
 * - "draft:approved"  (generic)
 * - "cooking:approved", "cleaning:approved", "animal:approved",
 *   "garden:approved", "gardening:approved", "inventory:approved"
 *
 * Draft payload shape (normalized best-effort):
 * {
 *   id: string,
 *   kind: 'cooking_session' | 'cleaning_session' | 'animal_session' | 'garden_session' | 'inventory_update' | 'session',
 *   title?: string,
 *   schedule?: { start: string|Date, end?: string|Date, tz?: string },
 *   durationMinutes?: number,
 *   notes?: string,
 *   // Cooking
 *   recipes?: [{ id, name, station, allergens, yield, timers: [...] }],
 *   // Cleaning
 *   zones?: string[],
 *   // Inventory
 *   items?: [{ id, name, delta: number, unit?: string, location?: string }],
 *   action?: 'receive'|'consume'|'audit',
 *   metadata?: { storageHints?, labelTemplate?, safetyTimers?, ... }
 * }
 */
export function useCalendarSyncOnApproval({
  enabled = true,
  externalSync = true,
  conflict = "shift",
  sabbathGuard = { enabled: true },
  sourceTag = "ai-draft",
  onAfterInternalAdd,
  onAfterExternalSync
} = {}) {
  const addEvent = useHouseholdCalendar((s) => s.addEvent);
  const getEvents = useHouseholdCalendar((s) => s.getEvents);
  const removeEvent = useHouseholdCalendar((s) => s.removeEvent);
  const updateEvent = useHouseholdCalendar((s) => s.updateEvent);
  const lastSyncedRef = useRef(new Map()); // draftId -> eventId

  useEffect(() => {
    if (!enabled) return;

    // Listen to multiple approval topics (includes inventory:approved)
    const topics = [
      "draft:approved",
      "cooking:approved",
      "cleaning:approved",
      "animal:approved",
      "garden:approved",
      "gardening:approved",
      "inventory:approved"
    ];

    const offFns = topics.map((t) =>
      eventBus.on(t, async (payload) => {
        try {
          const drafts = Array.isArray(payload)
            ? payload
            : Array.isArray(payload?.drafts)
            ? payload.drafts
            : [payload?.draft ?? payload];

          for (const raw of drafts.filter(Boolean)) {
            const draft = normalizeDraft(raw, t); // unify shapes
            let event = buildEventFromDraft(draft, sourceTag);

            // Sabbath guard
            if (sabbathGuard?.enabled && event.start) {
              const block = getSabbathWindow(event.start, sabbathGuard?.getWindow);
              if (isWithin(event.start, block.start, block.end) || isWithin(event.end, block.start, block.end)) {
                const shifted = shiftOutOfWindow(event, block);
                if (!shifted) {
                  eventBus.emit("calendar:sync:error", {
                    reason: "SABBATH_WINDOW",
                    message: "Session falls within Sabbath/holy window",
                    draft
                  });
                  continue;
                }
                event = shifted;
              }
            }

            // Conflict resolution
            const resolved = resolveConflicts(event, getEvents(), conflict);
            const eventId = addEvent(resolved);
            lastSyncedRef.current.set(draft.id ?? resolved.refId ?? eventId, eventId);

            eventBus.emit("calendar:sync:internalAdded", { eventId, draftId: draft.id, event: resolved });
            try { onAfterInternalAdd?.(resolved, draft); } catch (e) { console.warn("onAfterInternalAdd error:", e); }

            // External sync (on approval only)
            if (externalSync) {
              try {
                const result = await syncExternalCalendar(resolved, draft);
                eventBus.emit("calendar:sync:success", {
                  provider: result?.provider ?? "generic",
                  providerEventId: result?.providerEventId,
                  eventId,
                  draftId: draft.id
                });
                try { onAfterExternalSync?.(result, resolved, draft); } catch (e) { console.warn("onAfterExternalSync error:", e); }
                if (result?.providerEventId) {
                  updateEvent(eventId, {
                    external: {
                      ...(resolved.external ?? {}),
                      [result.provider ?? "generic"]: result.providerEventId
                    }
                  });
                }
              } catch (err) {
                eventBus.emit("calendar:sync:error", {
                  reason: "EXTERNAL_SYNC_FAILED",
                  message: err?.message ?? "External calendar sync failed",
                  draft,
                  eventId
                });
              }
            }
          }
        } catch (err) {
          eventBus.emit("calendar:sync:error", { reason: "UNEXPECTED", message: err?.message ?? String(err) });
        }
      })
    );

    // Unapprove/undo hooks
    const offUnapproved = eventBus.on("draft:unapproved", (draft) => {
      const key = draft?.id;
      if (!key || !lastSyncedRef.current.has(key)) return;
      const eventId = lastSyncedRef.current.get(key);
      removeEvent(eventId);
      lastSyncedRef.current.delete(key);
      eventBus.emit("calendar:sync:internalRemoved", { eventId, draftId: key });
    });

    const offUndo = eventBus.on("calendar:undo:last", () => {
      const keys = Array.from(lastSyncedRef.current.keys());
      const lastKey = keys[keys.length - 1];
      if (!lastKey) return;
      const eventId = lastSyncedRef.current.get(lastKey);
      removeEvent(eventId);
      lastSyncedRef.current.delete(lastKey);
      eventBus.emit("calendar:sync:internalRemoved", { eventId, draftId: lastKey });
    });

    return () => {
      offFns.forEach((off) => off?.());
      offUnapproved?.();
      offUndo?.();
    };
  }, [
    enabled,
    externalSync,
    conflict,
    sabbathGuard?.enabled,
    sabbathGuard?.getWindow,
    sourceTag,
    addEvent,
    getEvents,
    removeEvent,
    updateEvent,
    onAfterInternalAdd,
    onAfterExternalSync
  ]);
}

/* --------------------------- Event Builders & Utils --------------------------- */

function buildEventFromDraft(draft, sourceTag) {
  const kind = draft?.kind ?? draft?.type ?? "session";
  const { start, end } = coerceSchedule(draft);
  const durationMin = draft?.durationMinutes ?? estimateDuration(draft, kind, start, end);
  const computedEnd = end ?? new Date(start.getTime() + durationMin * 60_000);

  const baseTitle =
    draft?.title ||
    (kind === "cooking_session" ? "Cooking Session" :
     kind === "cleaning_session" ? "Cleaning Session" :
     kind === "animal_session" ? "Animal Care Session" :
     kind === "garden_session" ? "Garden Session" :
     kind === "inventory_update" ? inventoryTitleFromAction(draft?.action) :
     "Household Session");

  const descLines = [];

  // Cooking details
  if (kind === "cooking_session" && Array.isArray(draft?.recipes)) {
    descLines.push(`Recipes:`);
    draft.recipes.forEach((r, idx) => {
      const parts = [
        `${idx + 1}. ${r?.name ?? r?.id ?? "Recipe"}`,
        r?.station ? `(station: ${r.station})` : null,
        r?.allergens?.length ? `⚠ allergens: ${r.allergens.join(", ")}` : null,
        r?.yield ? `yield: ${stringifyYield(r.yield)}` : null
      ].filter(Boolean);
      descLines.push(`   - ${parts.join(" • ")}`);
    });
  }

  // Cleaning details
  if (kind === "cleaning_session" && Array.isArray(draft?.zones)) {
    descLines.push(`Zones: ${draft.zones.join(", ")}`);
  }

  // Animal details (optional)
  if (kind === "animal_session" && Array.isArray(draft?.tasks)) {
    descLines.push(`Animal Tasks:`);
    draft.tasks.forEach((t, i) => descLines.push(`   - ${i + 1}. ${t?.title ?? t}`));
  }

  // Garden details (optional)
  if (kind === "garden_session" && Array.isArray(draft?.tasks)) {
    descLines.push(`Garden Tasks:`);
    draft.tasks.forEach((t, i) => descLines.push(`   - ${i + 1}. ${t?.title ?? t}`));
  }

  // Inventory details
  if (kind === "inventory_update" && Array.isArray(draft?.items)) {
    descLines.push(`Inventory: ${draft?.action ?? "update"}`);
    draft.items.forEach((it, i) => {
      const unit = it?.unit ? ` ${it.unit}` : "";
      const delta = typeof it?.delta === "number" ? (it.delta > 0 ? `+${it.delta}` : `${it.delta}`) : "";
      const loc = it?.location ? ` @ ${it.location}` : "";
      descLines.push(`   - ${i + 1}. ${it?.name ?? it?.id ?? "Item"} ${delta}${unit}${loc}`);
    });
  }

  if (draft?.notes) descLines.push(`Notes: ${draft.notes}`);

  const description = descLines.join("\n");

  const metadata = {
    kind,
    draftRef: draft?.id,
    ownerId: draft?.ownerId,
    labelTemplate: draft?.metadata?.labelTemplate,
    storageHints: draft?.metadata?.storageHints,
    safetyTimers: draft?.metadata?.safetyTimers,
    stations: getStations(draft),
    allergens: getAllergens(draft),
    action: draft?.action, // inventory
    createdAt: new Date().toISOString(),
    source: sourceTag
  };

  return {
    id: `evt_${Math.random().toString(36).slice(2)}`,
    title: baseTitle,
    start,
    end: computedEnd,
    color: colorForKind(kind),
    source: sourceForKind(kind),
    refId: draft?.id,
    description,
    metadata
  };
}

function inventoryTitleFromAction(action) {
  if (action === "receive") return "Inventory Received";
  if (action === "consume") return "Inventory Consumed";
  if (action === "audit") return "Inventory Audit";
  return "Inventory Update";
}

function sourceForKind(kind) {
  if (kind === "cooking_session") return "cooking";
  if (kind === "cleaning_session") return "cleaning";
  if (kind === "animal_session") return "animal";
  if (kind === "garden_session") return "garden";
  if (kind === "inventory_update") return "inventory";
  return "household";
}

function coerceSchedule(draft) {
  const startRaw = draft?.schedule?.start ?? draft?.start;
  const endRaw = draft?.schedule?.end ?? draft?.end;

  const now = new Date();
  const topOfHour = new Date(now);
  topOfHour.setMinutes(0, 0, 0);
  if (now.getMinutes() > 0) topOfHour.setHours(topOfHour.getHours() + 1);

  const start = startRaw ? new Date(startRaw) : topOfHour;
  const end = endRaw ? new Date(endRaw) : undefined;

  return { start, end };
}

function estimateDuration(draft, kind, start, end) {
  if (end) return Math.max(15, Math.round((new Date(end) - new Date(start)) / 60000));
  if (kind === "cooking_session") {
    const n = Array.isArray(draft?.recipes) ? draft.recipes.length : 2;
    return Math.min(240, 120 + n * 10);
  }
  if (kind === "cleaning_session") {
    const z = Array.isArray(draft?.zones) ? draft.zones.length : 3;
    return Math.min(240, 90 + z * 15);
  }
  if (kind === "inventory_update") {
    const n = Array.isArray(draft?.items) ? draft.items.length : 4;
    return Math.min(90, 30 + n * 5); // quick admin-ish task
  }
  return 90;
}

function stringifyYield(y) {
  if (!y) return "";
  if (typeof y === "string") return y;
  if (typeof y === "number") return `${y}`;
  if (typeof y === "object") {
    const qty = y?.qty ?? y?.quantity ?? y?.amount;
    const unit = y?.unit ?? y?.units;
    if (qty && unit) return `${qty} ${unit}`;
  }
  return "";
}

function getStations(draft) {
  if (!Array.isArray(draft?.recipes)) return undefined;
  return draft.recipes.map((r) => r?.station).filter(Boolean);
}

function getAllergens(draft) {
  if (!Array.isArray(draft?.recipes)) return undefined;
  const set = new Set();
  draft.recipes.forEach((r) => (r?.allergens ?? []).forEach((a) => set.add(a)));
  return Array.from(set);
}

function colorForKind(kind) {
  if (kind === "cooking_session") return "#F59E0B"; // amber-500
  if (kind === "cleaning_session") return "#10B981"; // emerald-500
  if (kind === "animal_session") return "#A78BFA"; // violet-400
  if (kind === "garden_session") return "#22C55E"; // green-500
  if (kind === "inventory_update") return "#3B82F6"; // blue-500
  return "#6366F1"; // indigo-500
}

/* --------------------------- Sabbath/Holy Time Guard -------------------------- */

function getSabbathWindow(anchorDate, customWindowFn) {
  if (typeof customWindowFn === "function") {
    try {
      const win = customWindowFn(new Date(anchorDate));
      if (win?.start && win?.end) return win;
    } catch { /* fall through */ }
  }
  // Default: Fri 18:00 -> Sat 19:00 local (approx.; replace with Hebrew calendar when ready)
  const d = new Date(anchorDate);
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const fri = new Date(d);
  const diffToFri = (5 - day + 7) % 7;
  fri.setDate(d.getDate() + (diffToFri === 0 && d.getHours() >= 18 ? 7 : diffToFri));
  fri.setHours(18, 0, 0, 0);

  const start = new Date(fri);
  const end = new Date(fri);
  end.setDate(fri.getDate() + 1);
  end.setHours(19, 0, 0, 0);
  return { start, end };
}

function isWithin(ts, start, end) {
  if (!ts || !start || !end) return false;
  const t = new Date(ts).getTime();
  return t >= start.getTime() && t <= end.getTime();
}

function shiftOutOfWindow(event, window) {
  if (!event?.start || !window?.end) return event;
  const dur = event.end ? (new Date(event.end) - new Date(event.start)) : 90 * 60000;
  const shiftedStart = new Date(window.end);
  const shiftedEnd = new Date(shiftedStart.getTime() + dur);
  return { ...event, start: shiftedStart, end: shiftedEnd };
}

/* --------------------------------- Conflicts --------------------------------- */

function resolveConflicts(evt, allEvents, policy = "shift") {
  const overlaps = findOverlaps(evt, allEvents);
  if (overlaps.length === 0) return evt;

  if (policy === "stack") {
    return { ...evt, metadata: { ...(evt.metadata ?? {}), stackedWith: overlaps.map((e) => e.id) } };
  }
  if (policy === "flag") {
    return { ...evt, metadata: { ...(evt.metadata ?? {}), conflictFlag: overlaps.map((e) => e.id) } };
  }

  const latestEnd = overlaps.reduce((max, e) => Math.max(max, new Date(e.end ?? e.start).getTime()), evt.start.getTime());
  const dur = evt.end ? (new Date(evt.end) - new Date(evt.start)) : 90 * 60000;
  const start = new Date(Math.max(latestEnd, evt.start.getTime()));
  const end = new Date(start.getTime() + dur);
  return { ...evt, start, end, metadata: { ...(evt.metadata ?? {}), shiftedFromConflict: overlaps.map((e) => e.id) } };
}

function findOverlaps(evt, all) {
  const s1 = new Date(evt.start).getTime();
  const e1 = new Date(evt.end ?? evt.start).getTime();
  return (all ?? []).filter((e) => {
    if (!e?.start) return false;
    const s2 = new Date(e.start).getTime();
    const e2 = new Date(e.end ?? e.start).getTime();
    return Math.max(s1, s2) < Math.min(e1, e2);
  });
}

/* ---------------------------- External Sync (API) ---------------------------- */

async function syncExternalCalendar(event, draft) {
  const res = await fetch("/api/calendar/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event: serializeEventForAPI(event),
      context: {
        draftId: draft?.id,
        kind: draft?.kind ?? draft?.type,
        ownerId: draft?.ownerId
      }
    })
  });
  if (!res.ok) {
    const msg = await safeText(res);
    throw new Error(msg || `External sync failed with ${res.status}`);
  }
  const data = await res.json().catch(() => ({}));
  return { provider: data?.provider ?? "generic", providerEventId: data?.providerEventId };
}

function serializeEventForAPI(e) {
  return {
    title: e.title,
    start: toIso(e.start),
    end: toIso(e.end),
    description: e.description ?? "",
    color: e.color,
    metadata: e.metadata,
    source: e.source,
    refId: e.refId
  };
}

function toIso(d) {
  try { return new Date(d).toISOString(); } catch { return null; }
}

async function safeText(r) {
  try { return await r.text(); } catch { return ""; }
}

/* ------------------------------ Normalization -------------------------------- */

function normalizeDraft(raw, topic) {
  const d = typeof raw === "object" ? { ...raw } : { id: String(raw) };

  // Infer kind when absent
  if (!d.kind && !d.type) {
    if (topic.startsWith("cooking")) d.kind = "cooking_session";
    else if (topic.startsWith("cleaning")) d.kind = "cleaning_session";
    else if (topic.startsWith("animal")) d.kind = "animal_session";
    else if (topic.startsWith("garden") || topic.startsWith("gardening")) d.kind = "garden_session";
    else if (topic.startsWith("inventory")) d.kind = "inventory_update";
    else d.kind = "session";
  }

  // Normalize schedule container
  if (!d.schedule) {
    d.schedule = {};
    if (d.start) d.schedule.start = d.start;
    if (d.end) d.schedule.end = d.end;
    if (d.tz) d.schedule.tz = d.tz;
  }

  // Garden alias
  if (d.kind === "gardening_session") d.kind = "garden_session";

  // Inventory aliasing: allow common shapes {changes:[...]} or {items:[...]}
  if (d.kind === "inventory_update") {
    if (!Array.isArray(d.items) && Array.isArray(d.changes)) {
      d.items = d.changes;
    }
  }

  return d;
}
