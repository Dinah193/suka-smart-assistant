# Local Fallback Storage Keys (SSA)

> **Scope:** These keys are used as **last-resort, offline/local-only** fallbacks when IndexedDB/Dexie or domain-scoped stores are unavailable, or during very early boot (before DB is ready).  
> **Owner:** `src/data/localFallback/*` utilities and thin adapters inside domain UIs.  
> **Events:** When a writer updates a key, it SHOULD also emit a bus payload `{ type, ts, source, data }`. See each key’s “Emit” note.

---

## Quick Index

| Key | Domain | Purpose | Value shape |
|---|---|---|---|
| `sv.favorite.cookingDrafts` | Cooking | User favorites (drafts) fallback | Array of `FavoriteDraft` |
| `sv.cooking.scheduleTemplates` | Cooking | Schedule templates fallback | Array of `ScheduleTemplate` |
| `sv.favorites.cleaningDrafts` | Cleaning | User favorites (drafts) fallback | Array of `FavoriteDraft` |
| `sv.cleaning.scheduleTemplates` | Cleaning | Schedule templates fallback | Array of `ScheduleTemplate` |
| `sv.favorites.gardenDrafts` | Garden | User favorites (drafts) fallback | Array of `FavoriteDraft` |
| `sv.garden.scheduleTemplates` | Garden | Schedule templates fallback | Array of `ScheduleTemplate` |
| `sv.favorites.animalsDrafts` | Animals | User favorites (drafts) fallback | Array of `FavoriteDraft` |
| `sv.animals.scheduleTemplates` | Animals | Schedule templates fallback | Array of `ScheduleTemplate` |
| `lastApprovedDraftId` | Cross-domain (per surface) | Remembers last draft approved for play | String |

> **Naming note:** The keys are intentionally not renamed for consistency with existing callers. Some use the singular `favorite` prefix; others use plural `favorites`. Keep them **as-is**.

---

## Shared Value Models

### `FavoriteDraft`
```ts
{
  id: string;           // local favorite id (not the draft id)
  targetId: string;     // the actual draft id
  title?: string;
  tags?: string[];
  createdAt: string;    // ISO timestamp
}
ScheduleTemplate
ts
Copy code
{
  id: string;
  title: string;
  rrule: string;             // e.g. "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=0"
  tzid?: string;             // IANA TZ, optional
  startTime?: string;        // ISO datetime for next/first occurrence
  durationMs?: number;
  alarmMinutesBefore?: number;
  enabled: boolean;
  nextRunAt?: string;        // ISO datetime (planner precompute)
  lastRunAt?: string;        // ISO datetime
  meta?: Record<string, any>;
  createdAt: string;         // ISO
  updatedAt: string;         // ISO
}
Validation: Writers should defensively validate shapes and coerce minimal fields (e.g., enabled: !!enabled), but readers must treat all values as untrusted and apply defaults.

Keys
1) sv.favorite.cookingDrafts
Purpose: Fallback list of favorited cooking drafts when favorites.cookingDrafts store isn’t reachable yet.

Type: FavoriteDraft[] (serialized JSON).

Default: [] (empty array).

Emit: After write, emit
{ type: "favorites.added|favorites.removed", ts, source: "localFallback.cooking", data: { targetId, snapshotLen } }

Example:

json
Copy code
[
  { "id": "fav_x1", "targetId": "draft_abc", "title": "Sourdough Starter", "tags": ["bread"], "createdAt": "2025-11-07T00:00:00.000Z" }
]
2) sv.cooking.scheduleTemplates
Purpose: Fallback schedule templates for cooking suggestions.

Type: ScheduleTemplate[].

Default: [].

Emit: { type: "schedule.template.upserted", ts, source: "localFallback.cooking", data: { id, enabled } }

Example:

json
Copy code
[
  {
    "id": "tpl_cook_1",
    "title": "Weeknight Dinner",
    "rrule": "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH;BYHOUR=18;BYMINUTE=0",
    "enabled": true,
    "createdAt": "2025-11-07T00:00:00.000Z",
    "updatedAt": "2025-11-07T00:00:00.000Z"
  }
]
3) sv.favorites.cleaningDrafts
Purpose: Fallback list of favorited cleaning drafts.

Type: FavoriteDraft[].

Default: [].

Emit: { type: "favorites.added|favorites.removed", ts, source: "localFallback.cleaning", data: { targetId, snapshotLen } }

4) sv.cleaning.scheduleTemplates
Purpose: Fallback schedule templates for cleaning.

Type: ScheduleTemplate[].

Default: [].

Emit: { type: "schedule.template.upserted", ts, source: "localFallback.cleaning", data: { id, enabled } }

5) sv.favorites.gardenDrafts
Purpose: Fallback list of favorited garden drafts.

Type: FavoriteDraft[].

Default: [].

Emit: { type: "favorites.added|favorites.removed", ts, source: "localFallback.garden", data: { targetId, snapshotLen } }

6) sv.garden.scheduleTemplates
Purpose: Fallback schedule templates for garden.

Type: ScheduleTemplate[].

Default: [].

Emit: { type: "schedule.template.upserted", ts, source: "localFallback.garden", data: { id, enabled } }

7) sv.favorites.animalsDrafts
Purpose: Fallback list of favorited animals drafts.

Type: FavoriteDraft[].

Default: [].

Emit: { type: "favorites.added|favorites.removed", ts, source: "localFallback.animals", data: { targetId, snapshotLen } }

8) sv.animals.scheduleTemplates
Purpose: Fallback schedule templates for animals.

Type: ScheduleTemplate[].

Default: [].

Emit: { type: "schedule.template.upserted", ts, source: "localFallback.animals", data: { id, enabled } }

9) lastApprovedDraftId
Purpose: Cross-surface convenience: remembers the most recent draftId the user approved for play (used to preselect or offer “Resume draft”).

Type: string (draft id).

Default: absent (treat as no prior approval).

Emit: { type: "session.draft.approved", ts, source: "localFallback.lastApproved", data: { draftId } }

Notes: If domain affinity is desired, callers MAY namespace to lastApprovedDraftId:cooking etc., but this base key remains a simple cross-domain pointer.

Read/Write Guidance
Guarded JSON: Always wrap JSON.parse in try/catch. On parse failure, reset to default and emit { type: "local.fallback.reset", data: { key } }.

Atomicity: Write with localStorage.setItem(key, JSON.stringify(value)) after updating an in-memory copy to minimize partial writes.

Size awareness: localStorage limits vary (~5–10MB). Keep arrays small (≤ 200 items). Evict oldest first by createdAt.

Privacy: Do not store secrets or PII. Titles/notes should already be streamer-safe by upstream mappers (see draftToPlay.js redaction).

One-way sync: These keys are not authoritative. When Dexie tables become available, prefer DB → UI, and only use local fallback for bootstrapping.

Migration Notes
From generic tables: The migrations vXX-favorites-schedules.js and vXX-add-plays.js create IndexedDB stores. At boot, if DB is available, hydrate DB from these local keys only once, then clear the keys (or mark migratedAt in meta).

Key continuity: Keep the exact key names above to avoid breaking older builds.

Shape drift: If fields expand (e.g., ScheduleTemplate.meta), preserve unknown keys on write-back (read-modify-write).

Minimal Example (Writer)
js
Copy code
function addCookingFavorite(targetId, title) {
  const key = "sv.favorite.cookingDrafts";
  let list = [];
  try { list = JSON.parse(localStorage.getItem(key) || "[]"); } catch {}
  const now = new Date().toISOString();
  list.unshift({ id: `fav_${Date.now()}`, targetId, title, createdAt: now });
  localStorage.setItem(key, JSON.stringify(list));

  const payload = {
    type: "favorites.added",
    ts: now,
    source: "localFallback.cooking",
    data: { targetId, snapshotLen: list.length }
  };
  window.dispatchEvent(new CustomEvent(payload.type, { detail: payload }));
}