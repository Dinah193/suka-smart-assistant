# Cache Key Design & Invalidation Guide  
_File: `src/docs/cache-keys.md`_

This doc defines how Suka Smart Assistant (SSA) forms **cache keys**, where they
live, and how they get **invalidated** (TTL + event-driven). It’s meant to keep:

- SessionRunner resilient,
- Reasoner shims efficient,
- External fetches (weather, coupons, prices, etc.) under budget,
- Behavior predictable when users jump around the app.

It also sketches a **Cache Inspector / Swap Modal** concept that lets you manage
cache groups without breaking long-running Sessions.

---

## 1. Cache Layers in SSA

SSA uses several cache layers. Keys must be consistent across them.

1. **In-memory (per tab)**
   - Short-lived, fastest.
   - Ideal for:
     - active Session state mirrors,
     - recently fetched config,
     - per-route UI memoization.

2. **Dexie (IndexedDB)**
   - Persistent across page reloads.
   - Used for:
     - `sessions` store (SessionRunner checkpoints),
     - pricebook / circular snapshots,
     - Reasoner outputs (e.g., consolidated shopping list).

3. **Service Worker / HTTP cache**
   - Browser-native. SSA should:
     - Use standard `cache-control` and ETag semantics when applicable,
     - Respect TTLs defined in `freshness.policy.json`.

4. **Optional Hub / remote caches**
   - For `familyFundMode === true` cases (not detailed here).
   - Keys should mirror local naming with an added `householdId` or `hubScope`.

---

## 2. Key Naming Pattern

### 2.1 Canonical Format

All SSA cache keys should follow this shape:

```text
<scope>:<domain>:<resource>[:<subResource>...][:<idOrHash>][:v<version>]
Where:

scope — Which layer or purpose:

mem (in-memory),

dexie (Dexie-backed),

sw (service worker),

http (HTTP-level / external),

reasoner (structured AI outputs).

domain — High-level domain:

cooking, cleaning, garden, animals,

preservation, storehouse, shopping,

weather, circulars, pricebook, coupons, layout, inventory.

resource — Type of object:

session, plan, schedule, snapshot, forecast,

list, tree, config, profile, ruleset.

subResource — Optional more specific type:

daily, hourly, weekly, butcherySheet, storagePlan, etc.

idOrHash — Optional identity component:

householdId, storeId, zip, or a hash of structured input.

v<version> — Schema version.

Bump this when you change schemas to avoid mixing old/new data.

Example:
dexie:shopping:list:household:abc123:planHash:7f9e:v1

2.2 Hashing Inputs
When caching Reasoner outputs or derived plans, use a stable hash over
normalized inputs:

Sorted arrays,

Lowercased store IDs,

Normalized units (g vs oz vs lb),

Stripped out volatile fields (timestamps, random IDs).

Pseudo steps:

Canonicalize input JSON (sorted keys, normalized units).

Stringify.

Hash (e.g., SHA-256 → base36 or hex).

Use a short prefix (hash_<6–12 chars>) in the key.

Example:

text
Copy code
reasoner:shopping.consolidateList:hash_7f9e3c:v1
3. Key Catalog by Domain
3.1 Weather
text
Copy code
dexie:weather:current:<locationHash>:v1
dexie:weather:hourly:<locationHash>:v1
dexie:weather:daily:<locationHash>:v1
locationHash can be:

lat,lon normalized, or

ZIP/postal code, or

A combination hashed into a short ID.

TTLs governed by freshness.policy.json under weather.current,
weather.hourly, weather.daily.

3.2 Circulars & Coupons
text
Copy code
dexie:circulars:weekly:<storeId>:<yearWeek>:v1
dexie:circulars:itemIndex:<storeId>:<yearWeek>:v1
dexie:coupons:manufacturer:all:v1
dexie:coupons:store:<storeId>:v1
yearWeek format: YYYY-WW (e.g., 2025-08).

TTLs under circulars.weekly and coupons.manufacturer in freshness policy.

3.3 Pricebook & Store Layout
text
Copy code
dexie:pricebook:grocery:<storeId>:v1
dexie:layout:store:<storeId>:aisleMap:v1
dexie:layout:store:<storeId>:categoryTree:v1
Layout tends to change slowly → long TTL.

Pricebook may update more frequently (weekly or on-demand).

3.4 Inventory & Storehouse
text
Copy code
dexie:inventory:storehouse:<householdId>:snapshot:v1
dexie:inventory:storehouse:<householdId>:shortages:v1
dexie:storehouse:storagePlan:<householdId>:v1
snapshot stores normalized inventory quantities per item.

shortages is derived from planning (meals, preservation, etc.).

storagePlan powers storehouse planning skills and UI.

3.5 Sessions & Plans
SessionRunner / Dexie

text
Copy code
dexie:session:<sessionId>:v1
dexie:session:analytics:<sessionId>:v1
dexie:session:progress:<sessionId>:v1
These correspond to:

The full Session object (Session contract),

Analytics attached post-run,

Progress snapshots for fast resume.

Derived Plans (not tied 1:1 to a Session)

text
Copy code
dexie:plan:cooking:batch:<householdId>:hash_<inputHash>:v1
dexie:plan:cleaning:routine:<householdId>:hash_<inputHash>:v1
dexie:plan:garden:schedule:<householdId>:hash_<inputHash>:v1
dexie:plan:animals:butcheryCutSheet:<householdId>:hash_<inputHash>:v1
dexie:plan:storehouse:storagePlanner:<householdId>:hash_<inputHash>:v1
dexie:plan:shopping:list:<householdId>:hash_<inputHash>:v1
These are Reasoner shim outputs persisted for reuse and offline operation.

4. Reasoner & Skills Cache Keys
4.1 Reasoner Output Keys
text
Copy code
reasoner:<modeName>:hash_<inputHash>:v<schemaVersion>
Examples:

text
Copy code
reasoner:cooking.composeSession:hash_12ab9c:v1
reasoner:cleaning.composeRoutine:hash_3f7e4d:v1
reasoner:storehouse.storagePlanner:hash_88c0aa:v1
reasoner:shopping.consolidateList:hash_f09e21:v1
reasoner:garden.schedule:hash_2ce901:v1
reasoner:animals.butcheryCutSheet:hash_a7b43d:v1
modeName matches orchestrator.modes.json keys.

schemaVersion must match the output schema version in schemas/skills/....

4.2 Skill-Level Mirrors (Optional)
To simplify Dexie lookups, you can mirror Reasoner keys:

text
Copy code
dexie:skills:cooking.composeSession:hash_<inputHash>:v1
dexie:skills:shopping.consolidateList:hash_<inputHash>:v1
This is purely a convenience layer that:

Uses the same hash,

Stores the Reasoner output in a Dexie table,

Makes offline rehydration and debugging easier.

5. Invalidation Rules
Invalidation is a combination of:

TTL-based expiry (from freshness.policy.json),

Event-driven invalidation (from eventBus and domain mutations).

5.1 TTL-Based Expiry
For keys tied to freshness policy entries:

On read:

Load from Dexie,

Compare now vs cachedAt (stored with the value),

If (now - cachedAt) > ttlMs, treat as stale:

Attempt a background refresh,

Optionally return stale data if (now - cachedAt) <= maxStaleMs,

Otherwise drop and refetch before returning.

Store with each entry:

js
Copy code
{
  value: ...,         // actual payload
  cachedAt: string,   // ISO timestamp
  ttlMs: number       // copied from freshness policy at time of write
}
5.2 Event-Driven Invalidation Matrix
Below is a suggested mapping of SSA events → which key groups should be
invalidated or refreshed.

Inventory Events
inventory.updated

Invalidate:

dexie:inventory:storehouse:<householdId>:snapshot:v1

dexie:inventory:storehouse:<householdId>:shortages:v1

Mark dependent plans as stale:

dexie:plan:storehouse:storagePlanner:<householdId>:*

dexie:plan:shopping:list:<householdId>:*

dexie:plan:cooking:batch:<householdId>:*

inventory.shortage.detected

Don’t necessarily drop caches.

May log “shortage state” in shortages entry; UI should reflect this.

Import / Circular Events
import.parsed with sourceType = circular/pricebook/coupons:

Invalidate:

matching dexie:circulars:weekly:<storeId>:<yearWeek>:v1

matching dexie:pricebook:grocery:<storeId>:v1

matching dexie:coupons:store:<storeId>:v1

Reasoner / Mode Changes
reasoner.swap.applied

Bump in-memory overrides for which model or settings to use.

Optionally:

Mark all reasoner:<modeName>:* entries as “generated with old config”.

Respect their TTL and allow them to live out their life,
or aggressively evict if you don’t trust older outputs.

reasoner.delta.schemaUpdated

When a schema version changes, you should:

Bump v<schemaVersion> in keys.

The old entries will naturally fall out of usage because queries will use
the new version suffix.

Session Lifecycle
session.completed

Keep dexie:session:<sessionId>:v1 and dexie:session:analytics:<sessionId>:v1
for history & statistics.

You may:

Drop dexie:session:progress:<sessionId>:v1 (no need to resume).

session.aborted

Decide whether progress should persist:

If aborted by user and they might resume, keep the progress.

If aborted due to guard violation (e.g., sabbath, quietHours), keep.

If aborted due to fatal error, consider:

Clearing progress,

Or marking a “failed” state inside progress rather than deleting.

session.checkpoint.written

No invalidation—this updates dexie:session:progress:<sessionId>:v1.

6. Key Formation Conventions
To keep the codebase sane:

Always use helper functions to form keys.

Example (src/services/cacheKeys.js):

js
Copy code
export function weatherCurrentKey(locationHash) {
  return `dexie:weather:current:${locationHash}:v1`;
}

export function reasonerKey(modeName, inputHash, schemaVersion = 1) {
  return `reasoner:${modeName}:hash_${inputHash}:v${schemaVersion}`;
}
Keep identifiers normalized:

Store IDs: lowercased, trimmed.

Household IDs: a single canonical ID per household.

Avoid mixing human-readable names directly in keys if they can change.

Version bump instead of mutation:

If you significantly change a schema or semantics, bump v1 → v2.

Let old keys fade out (TTL or occasional cleanup).

7. Cache Inspector & Swap Modal (Dev Tool Concept)
To help you manage this in practice, SSA can expose a Cache Inspector / Swap
Modal at the root (similar to SessionRunner and a “Swap” modal visual).

Purpose:

Inspect:

Cache groups (weather, circulars, pricebook, sessions, skills),

Key counts and approximate size,

“Freshness” (how old entries are vs TTL).

Manage:

Flush group (e.g., “Clear all circulars caches”),

Invalidate individual keys,

Override reasoner modes (e.g., switch model or budget) at runtime.

Behavioral Requirements:

Mounted once at root with a portal (so it survives route changes).

Uses eventBus for signals:

cache.inspect.request → open modal,

cache.flush.request → flush group / key,

reasoner.swap.request → highlight modes and override.

Why it’s safe for Sessions:

The modal operates on caches & reasoner configs, not on:

Active Session timers,

sessions Dexie state,

SessionRunner’s internal Web Worker.

Clearing circulars or pricebook entries does not kill the active Session:

A running Session uses its own composed steps (already persisted).

New planning calls might re-fetch or re-plan when needed.

This makes the modal a “background-friendly” operations panel that you can
open, tweak caches, and close without losing user progress.

8. Summary & Checklist
Key pattern:

scope:domain:resource[:subResource...][:idOrHash][:v<version>]

For every new cacheable thing:

Decide domain, resource, and whether it’s:

Session-related,

Reference data (weather, pricebook),

Reasoner output (skills / plans).

Add helper(s) to a central cacheKeys module.

Add TTL entry to freshness.policy.json if it’s external data.

Add event invalidation rules where appropriate:

import.parsed,

inventory.updated,

reasoner.swap.applied,

session.completed/aborted.

Ensure Dexie entries store:

value,

cachedAt,

possibly ttlMs for self-contained expiry logic.

Use this document as the reference to keep cache behavior predictable as SSA
grows across cooking, cleaning, garden, animals, preservation, storehouse, and
shopping workflows.