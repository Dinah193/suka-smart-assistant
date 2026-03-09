// src/app/db.js
// Bridge shim so feature modules under /src/app can import "../../../db"
// without needing to know the real db location.
//
// This keeps build stable while you evolve your DB layer.
// It attempts to re-export the Dexie instance from your canonical DB module.
//
// Expected canonical locations (common in SSA):
// - src/services/db.js
// - or src/services/db/index.js
//
// If your canonical module exports `db` (named) or `default`, this will work.

import * as DbModule from "@/services/db";

/**
 * Try common export shapes:
 * - named export: `export const db = new Dexie(...)`
 * - default export: `export default db`
 */
const resolvedDb = DbModule.db || DbModule.default || DbModule;

export const db = resolvedDb;
export default resolvedDb;
