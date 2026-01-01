# `src/agents/cache/dexie.table.md`

Dexie cache table structure for SSA reasoning & memoization

---

## 1. Purpose

This note defines the **Dexie table structure** used to persist cached reasoning results for the Suka Smart Assistant (SSA), so that:

- Heavy Reasoner calls (session composition, guard evaluations, etc.) can be **reused across reloads**.
- The in-memory cache in `src/agents/cache/memo.js` can be **backed by Dexie** via a `MemoStorageAdapter`.
- We have a **debuggable**, **queryable** store for cache inspection / pruning.

This is purely structural documentation; the runtime adapter lives in a separate JS module.

---

## 2. Table Overview

We will use a single Dexie table for cached reasoning:

- **Table name:** `reasoningCache`
- **Primary key:** `key` (canonical string from `buildReasoningKey` in `src/agents/cache/keys.js`)
- **Indexes:**
  - `domain` — for filtering by domain (e.g. "sessions").
  - `[domain+intent]` — compound index to inspect/debug per intent.
  - `expiresAt` — for TTL-based cleanup jobs.

> **Note:** `memo.js` operates with a `MemoEntry` shape. The Dexie schema mirrors that shape, with a few denormalized columns (`domain`, `intent`, `userId`, `variant`) pulled out for easier querying.

---

## 3. Field Mapping (`MemoEntry` → Dexie columns)

From `src/agents/cache/memo.js`, `MemoEntry` is:

```ts
type MemoEntry = {
  key: string;
  value: any;
  createdAt: number;
  expiresAt: number | null;
  meta: {
    keyParts: MemoKeyParts;
    ttlMs?: number;
    hitCount?: number;
    version?: string;
  };
};
MemoKeyParts (logical identifiers):

ts
Copy code
type MemoKeyParts = {
  domain: string;
  intent: string;
  variant?: string;
  userId?: string;
  fingerprint?: string;
};
3.1 Dexie columns
Column	Type	Source / Purpose
key	string	PK. Canonical cache key; built via buildReasoningKey / buildMemoKey.
value	any	Cached value from Reasoner / expensive function.
createdAt	number	Epoch ms when entry was created.
expiresAt	number	Epoch ms when entry becomes stale (TTL). May be null for non-expiring (rare).
domain	string	Denormalized: meta.keyParts.domain.
intent	string	Denormalized: meta.keyParts.intent.
variant	string	Denormalized: `meta.keyParts.variant
userId	string	Denormalized: `meta.keyParts.userId
meta	object	Full meta object (keyParts, ttlMs, hitCount, version, etc.).

These denormalized columns allow:

specific cleanup: e.g. "clear all sessions cache for this user"

debugging: "what intents are being cached most?"

4. Dexie Store Definition
In your existing Dexie setup (e.g., src/services/db/index.js), add or extend a version with the following stores definition:

js
Copy code
// Example: src/services/db/index.js

import Dexie from 'dexie';

export const db = new Dexie('SukaSmartAssistantDB');

db.version(3).stores({
  // ...existing tables...

  /**
   * reasoningCache
   *
   * key         → primary key (canonical cache key string)
   * domain      → index by domain
   * [domain+intent] → compound index for per-intent queries
   * expiresAt   → index for TTL cleanup
   */
  reasoningCache: `
    key,
    domain,
    [domain+intent],
    expiresAt
  `
});

// If you already have versions, bump the version number and add reasoningCache
// to the latest version's stores() call.
Important: If you already have Dexie versions, increment the version and add reasoningCache in the new version block. Do not change older version schemas or you’ll break migrations.

5. Example Dexie-backed MemoStorageAdapter
This is how you would wire Dexie to memo.js via the MemoStorageAdapter interface.

js
Copy code
// Example: src/services/db/reasoningCacheAdapter.js

import { db } from './index'; // your central Dexie instance

/**
 * Dexie-backed MemoStorageAdapter for reasoning cache.
 *
 * Matches the interface expected by src/agents/cache/memo.js:
 *   - get(key)    → Promise<MemoEntry|null>
 *   - set(entry)  → Promise<void>
 *   - remove(key) → Promise<void>
 *   - clear()     → Promise<void>
 */
export const reasoningCacheAdapter = {
  /**
   * @param {string} key
   * @returns {Promise<import('../../agents/cache/memo').MemoEntry|null>}
   */
  async get(key) {
    const row = await db.reasoningCache.get(key);
    if (!row) return null;

    // Row shape already matches MemoEntry, we just return it.
    return row;
  },

  /**
   * @param {import('../../agents/cache/memo').MemoEntry} entry
   * @returns {Promise<void>}
   */
  async set(entry) {
    const { key, value, createdAt, expiresAt, meta } = entry;

    const domain = meta?.keyParts?.domain || 'unknown';
    const intent = meta?.keyParts?.intent || 'unknown';
    const variant = meta?.keyParts?.variant || 'default';
    const userId = meta?.keyParts?.userId || 'anon';

    await db.reasoningCache.put({
      key,
      value,
      createdAt,
      expiresAt,
      domain,
      intent,
      variant,
      userId,
      meta
    });
  },

  /**
   * @param {string} key
   * @returns {Promise<void>}
   */
  async remove(key) {
    await db.reasoningCache.delete(key);
  },

  /**
   * @returns {Promise<void>}
   */
  async clear() {
    await db.reasoningCache.clear();
  }
};
Then register this adapter with the memo layer:

js
Copy code
// Example: src/bootstrap/cacheSetup.js

import { setMemoStorageAdapter } from '../../agents/cache/memo';
import { reasoningCacheAdapter } from '../../services/db/reasoningCacheAdapter';

setMemoStorageAdapter(reasoningCacheAdapter);
6. TTL & Cleanup Strategy
The memo layer (memo.js) enforces TTL on read, but you might want a periodic cleanup job to keep the Dexie table lean.

A simple pattern:

Run on app startup and occasionally (e.g. once per day or when opening dev tools):

DELETE all entries where expiresAt <= now.

Optional: keep a max table size by deleting oldest createdAt rows if needed.

Example cleanup function:

js
Copy code
// Example: src/services/db/cleanupReasoningCache.js

import { db } from './index';

export async function cleanupExpiredReasoningCache() {
  const now = Date.now();

  await db.reasoningCache
    .where('expiresAt')
    .belowOrEqual(now)
    .delete();
}
You can trigger this from:

A background “maintenance” tick.

A dev-only settings page.

App startup (best-effort, non-blocking).

7. How This Connects to SessionRunner / “Now” flows
Session composition agents use memoizeAsync in src/agents/cache/memo.js, with keys built via buildReasoningKey / makeReasoningKey in src/agents/cache/keys.js.

The memo layer first checks in-memory cache, then Dexie-backed reasoningCache.

When a user clicks “Now” on a domain page:

The “next runnable session” resolver can reuse a cached composed session if:

Same (domain, intent, payload) (e.g. same recipe/garden plan/animal task).

Within ttlMs.

This avoids repeated heavy Reasoner work and speeds up the SessionRunner modal launch.

8. Extension Points
If you later need more advanced cache behavior, this table supports:

Per-domain clearing: db.reasoningCache.where('domain').equals('sessions').delete()

Per-intent clearing: db.reasoningCache.where('[domain+intent]').equals(['sessions', 'session.compose.cooking']).delete()

Per-user clearing: add an index on userId in the schema (e.g., reasoningCache: 'key, domain, [domain+intent], expiresAt, userId').

When modifying indexes, remember to:

Increment Dexie version.

Add the new indexed fields to the store definition.

Keep the MemoEntry writing logic in sync (ensure you store the extra columns).