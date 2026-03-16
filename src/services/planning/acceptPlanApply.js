// src/services/planning/acceptPlanApply.js
/* eslint-disable no-console */

/**
 * Shared Plan Acceptance Orchestrator (all domains)
 * ---------------------------------------------------------------------------
 * This file is the shared “acceptance pipeline” from:
 *   imports → intelligence (plan) → acceptance → persistence → events → automation → (optional) hub export
 *
 * It takes a domain plan/draft, expands it into occurrences, then derives:
 *   - session drafts (for SessionRunner)
 *   - calendar events (for scheduling / reminders)
 * and persists them idempotently via stable IDs.
 *
 * Key features:
 * - Domain adapters with extension points
 * - Defensive validation + early returns
 * - Emits standardized events via eventBus: { type, ts, source, data }
 * - Optional Hub export if featureFlags.familyFundMode === true (fails silently)
 */

import eventBus from "@/services/events/eventBus.js";
import featureFlags from "@/config/featureFlags.json";

import { normalizeOccurrence } from "./normalizeOccurrence.js";
import { planKey, sessionId, calendarEventId } from "./ids.js";

/* ------------------------------ Safe imports ------------------------------ */

async function safeImport(path) {
  try {
    return await import(path);
  } catch (e) {
    return null;
  }
}

async function getReposFromContextOrImports(context = {}) {
  // Allow injection (tests / alternate storage backends)
  const SessionsRepo = context.SessionsRepo || context.sessionsRepo;
  const CalendarRepo = context.CalendarRepo || context.calendarRepo;

  if (SessionsRepo && CalendarRepo) return { SessionsRepo, CalendarRepo };

  // Best-effort default imports (adjust paths if your repos live elsewhere)
  const sessionsMod =
    (await safeImport("@/repos/SessionsRepo.js")) ||
    (await safeImport("@/domain/sessions/SessionsRepo.js")) ||
    (await safeImport("@/services/repos/SessionsRepo.js"));

  const calendarMod =
    (await safeImport("@/repos/CalendarRepo.js")) ||
    (await safeImport("@/domain/calendar/CalendarRepo.js")) ||
    (await safeImport("@/services/repos/CalendarRepo.js"));

  return {
    SessionsRepo:
      SessionsRepo || sessionsMod?.default || sessionsMod?.SessionsRepo || null,
    CalendarRepo:
      CalendarRepo || calendarMod?.default || calendarMod?.CalendarRepo || null,
  };
}

/* ------------------------------ Event helpers ------------------------------ */

function nowIso() {
  return new Date().toISOString();
}

function emit(type, source, data) {
  try {
    eventBus.emit({
      type,
      ts: nowIso(),
      source,
      data,
    });
  } catch (e) {
    // eventBus should not crash acceptance pipeline
    console.warn(`[acceptPlanApply] eventBus.emit failed for ${type}`, e);
  }
}

/* ------------------------------ Hub export ------------------------------ */

async function exportToHubIfEnabled(
  payload,
  { source = "services/planning/acceptPlanApply" } = {}
) {
  try {
    if (!featureFlags?.familyFundMode) return;

    const fmtMod =
      (await safeImport("@/services/hub/HubPacketFormatter.js")) ||
      (await safeImport("@/services/hub/HubPacketFormatter.js"));

    const connMod =
      (await safeImport("@/services/hub/FamilyFundConnector.js")) ||
      (await safeImport("@/services/hub/FamilyFundConnector.js"));

    const HubPacketFormatter = fmtMod?.default || fmtMod?.HubPacketFormatter;
    const FamilyFundConnector =
      connMod?.default || connMod?.FamilyFundConnector;

    if (!HubPacketFormatter || !FamilyFundConnector) return;

    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch {
    // Fail silently by requirement
  }
}

/* ------------------------------ Adapter registry ------------------------------ */

/**
 * Domain adapters must provide:
 * - buildOccurrences(domain, plan, draft)
 * - buildSessionDraft(domain, occurrence, context)
 * - buildCalendarEvents(domain, occurrence, context)
 *
 * Extension point:
 * - context.adapters[domain] can override any/all functions.
 * - Additional domains can be added without changing this orchestrator.
 */
const defaultAdapter = {
  name: "default",

  buildOccurrences(domain, plan, draft) {
    // Defensive fallback:
    // - If plan.occurrences exists, use it.
    // - Else if draft.occurrences exists, use it.
    // - Else create a single "now" occurrence.
    const occs = plan?.occurrences || draft?.occurrences;
    if (Array.isArray(occs) && occs.length) return occs;

    const startAt = nowIso();
    return [
      {
        startAt,
        endAt: null,
        title: plan?.title || plan?.name || `${domain} plan`,
        meta: { fallback: true },
      },
    ];
  },

  buildSessionDraft(domain, occurrence, context) {
    // Minimal session contract; domains can enrich steps/timers/ingredients.
    const sid = sessionId(domain, occurrence);

    return {
      id: sid,
      domain,
      // status lifecycle: "draft" -> "ready" -> "active" -> "completed"
      status: "draft",
      title: occurrence.title || `${domain} session`,
      occurrenceId: occurrence.id,
      planId: occurrence.planId,
      // StepGraph-compatible skeleton (domains should generate real steps)
      steps: Array.isArray(occurrence?.meta?.steps)
        ? occurrence.meta.steps
        : [],
      timers: [],
      blockers: [],
      contextSnapshot: context?.snapshot || null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      meta: {
        source: "acceptPlanApply",
        adapter: occurrence?.source?.adapter || "default",
      },
    };
  },

  buildCalendarEvents(domain, occurrence, context) {
    // Default: one event mirroring the occurrence window.
    const eid = calendarEventId(domain, occurrence, "main");

    return [
      {
        id: eid,
        domain,
        occurrenceId: occurrence.id,
        planId: occurrence.planId,
        title: occurrence.title || `${domain} scheduled item`,
        startAt: occurrence.startAt,
        endAt: occurrence.endAt,
        // optional fields that your CalendarRepo can ignore if unsupported
        reminders: context?.calendarReminders || [],
        location: occurrence?.meta?.location || null,
        notes: occurrence?.meta?.notes || null,
        updatedAt: nowIso(),
        meta: {
          source: "acceptPlanApply",
        },
      },
    ];
  },
};

function resolveAdapter(domain, context = {}) {
  const injected = context?.adapters?.[domain];
  if (!injected) return defaultAdapter;

  return {
    name: injected.name || `${domain}-adapter`,
    buildOccurrences:
      injected.buildOccurrences || defaultAdapter.buildOccurrences,
    buildSessionDraft:
      injected.buildSessionDraft || defaultAdapter.buildSessionDraft,
    buildCalendarEvents:
      injected.buildCalendarEvents || defaultAdapter.buildCalendarEvents,
  };
}

/* ------------------------------ Public API ------------------------------ */

/**
 * acceptPlanApply(inputs)
 * ---------------------------------------------------------------------------
 * Inputs: { domain, plan, draft, context }
 *
 * Pipeline:
 * 1) buildOccurrences(domain, plan, draft)
 * 2) normalize occurrences (stable IDs)
 * 3) buildSessionDraft(domain, occurrence, context)
 * 4) buildCalendarEvents(domain, occurrence, context)
 * 5) persist (upsertMany)
 * 6) emit events:
 *    - plan.accepted
 *    - sessions.upserted
 *    - calendar.events.upserted
 *    - queue.synced (optional)
 */
export default async function acceptPlanApply({
  domain,
  plan,
  draft,
  context,
} = {}) {
  const source = "services/planning/acceptPlanApply";

  // -------------------- Validate inputs --------------------
  if (!domain || typeof domain !== "string") {
    emit("plan.accepted", source, {
      ok: false,
      error: "domain is required (string)",
      received: { domain },
    });
    return { ok: false, error: "domain is required (string)" };
  }

  if (!plan || typeof plan !== "object") {
    emit("plan.accepted", source, {
      ok: false,
      domain,
      error: "plan is required (object)",
    });
    return { ok: false, error: "plan is required (object)" };
  }

  const adapter = resolveAdapter(domain, context);
  const pk = planKey(domain, plan);

  // -------------------- Expand occurrences --------------------
  let rawOccurrences;
  try {
    rawOccurrences = adapter.buildOccurrences(domain, plan, draft);
  } catch (e) {
    emit("plan.accepted", source, {
      ok: false,
      domain,
      planId: pk,
      error: `buildOccurrences failed: ${e?.message || String(e)}`,
    });
    return { ok: false, error: "buildOccurrences failed", details: e?.message };
  }

  if (!Array.isArray(rawOccurrences) || rawOccurrences.length === 0) {
    emit("plan.accepted", source, {
      ok: false,
      domain,
      planId: pk,
      error: "No occurrences produced by adapter",
    });
    return { ok: false, error: "No occurrences produced by adapter" };
  }

  // -------------------- Normalize occurrences (stable IDs) --------------------
  let occurrences = [];
  try {
    occurrences = rawOccurrences.map((o) =>
      normalizeOccurrence(domain, plan, o, adapter.name)
    );
  } catch (e) {
    emit("plan.accepted", source, {
      ok: false,
      domain,
      planId: pk,
      error: `normalizeOccurrence failed: ${e?.message || String(e)}`,
    });
    return {
      ok: false,
      error: "normalizeOccurrence failed",
      details: e?.message,
    };
  }

  // -------------------- Build artifacts --------------------
  const sessions = [];
  const calendarEvents = [];

  for (const occ of occurrences) {
    try {
      const s = adapter.buildSessionDraft(domain, occ, context);
      if (s && typeof s === "object") {
        // Ensure stable session id exists
        s.id = s.id || sessionId(domain, occ);
        s.domain = s.domain || domain;
        s.planId = s.planId || occ.planId;
        s.occurrenceId = s.occurrenceId || occ.id;
        s.updatedAt = nowIso();
        sessions.push(s);
      }
    } catch (e) {
      // Keep going; one broken occurrence shouldn't kill the entire accept
      console.warn(
        `[acceptPlanApply] buildSessionDraft failed for occ=${occ.id}`,
        e
      );
    }

    try {
      const evs = adapter.buildCalendarEvents(domain, occ, context);
      if (Array.isArray(evs)) {
        for (let i = 0; i < evs.length; i += 1) {
          const ev = evs[i];
          if (!ev || typeof ev !== "object") continue;
          ev.id = ev.id || calendarEventId(domain, occ, `slot-${i}`);
          ev.domain = ev.domain || domain;
          ev.planId = ev.planId || occ.planId;
          ev.occurrenceId = ev.occurrenceId || occ.id;
          ev.updatedAt = nowIso();
          calendarEvents.push(ev);
        }
      }
    } catch (e) {
      console.warn(
        `[acceptPlanApply] buildCalendarEvents failed for occ=${occ.id}`,
        e
      );
    }
  }

  // -------------------- Persist --------------------
  const { SessionsRepo, CalendarRepo } = await getReposFromContextOrImports(
    context
  );

  if (!SessionsRepo || !CalendarRepo) {
    const msg =
      "Missing SessionsRepo and/or CalendarRepo (inject via context or ensure repo modules exist)";
    emit("plan.accepted", source, {
      ok: false,
      domain,
      planId: pk,
      error: msg,
    });
    return { ok: false, error: msg };
  }

  let sessionsResult = null;
  let calendarResult = null;

  try {
    if (sessions.length) {
      sessionsResult = await SessionsRepo.upsertMany(sessions);
      emit("sessions.upserted", source, {
        domain,
        planId: pk,
        count: sessions.length,
        ids: sessions.map((s) => s.id),
      });
    }
  } catch (e) {
    emit("sessions.upserted", source, {
      domain,
      planId: pk,
      ok: false,
      error: `SessionsRepo.upsertMany failed: ${e?.message || String(e)}`,
    });
  }

  try {
    if (calendarEvents.length) {
      calendarResult = await CalendarRepo.upsertMany(calendarEvents);
      emit("calendar.events.upserted", source, {
        domain,
        planId: pk,
        count: calendarEvents.length,
        ids: calendarEvents.map((ev) => ev.id),
      });
    }
  } catch (e) {
    emit("calendar.events.upserted", source, {
      domain,
      planId: pk,
      ok: false,
      error: `CalendarRepo.upsertMany failed: ${e?.message || String(e)}`,
    });
  }

  // Optional: sync queue (if your automation runtime uses a queue repo)
  // Extension point:
  // - Provide context.QueueRepo with upsertMany or syncFromArtifacts.
  try {
    const QueueRepo = context?.QueueRepo || context?.queueRepo || null;
    if (QueueRepo && typeof QueueRepo.syncFromArtifacts === "function") {
      await QueueRepo.syncFromArtifacts({
        domain,
        planId: pk,
        sessions,
        calendarEvents,
      });
      emit("queue.synced", source, { domain, planId: pk, ok: true });
    }
  } catch (e) {
    emit("queue.synced", source, {
      domain,
      planId: pk,
      ok: false,
      error: `Queue sync failed: ${e?.message || String(e)}`,
    });
  }

  // -------------------- Final plan.accepted event --------------------
  const acceptanceSummary = {
    ok: true,
    domain,
    planId: pk,
    occurrenceCount: occurrences.length,
    sessionCount: sessions.length,
    calendarEventCount: calendarEvents.length,
  };

  emit("plan.accepted", source, acceptanceSummary);

  // -------------------- Optional Hub export --------------------
  // Only export if we actually changed household artifacts
  if (sessions.length || calendarEvents.length) {
    await exportToHubIfEnabled(
      {
        type: "plan.accepted",
        domain,
        planId: pk,
        occurrences,
        sessions,
        calendarEvents,
      },
      { source }
    );
  }

  return {
    ...acceptanceSummary,
    results: {
      sessions: sessionsResult,
      calendar: calendarResult,
    },
  };
}
