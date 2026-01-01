/* eslint-disable no-console */

// C:\Users\larho\suka-smart-assistant\src\data\PlanningDraftsRepo.js
// Dexie-first planning drafts repo with localStorage fallback.

const LS_KEY = "ssa.planningDrafts.v1";

const nowISO = () => new Date().toISOString();

function createId(prefix = "draft") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

async function safeImportDb() {
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    const mod = await import("@/db");
    return mod?.default || mod?.db || mod;
  } catch {
    try {
      // eslint-disable-next-line global-require, import/no-unresolved
      const mod2 = await import("../db");
      return mod2?.default || mod2?.db || mod2;
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[PlanningDraftsRepo] Dexie db import unavailable:", err);
      }
      return null;
    }
  }
}

function readLS() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeLS(rows) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(rows));
  } catch {
    // ignore
  }
}

async function upsertLS(row) {
  const rows = readLS();
  const idx = rows.findIndex((r) => r.id === row.id);
  if (idx >= 0) rows[idx] = row;
  else rows.unshift(row);
  writeLS(rows);
  return row;
}

async function queryLS({ kind, domain, status, limit = 25 } = {}) {
  let rows = readLS();
  if (kind) rows = rows.filter((r) => r.kind === kind);
  if (domain) rows = rows.filter((r) => r.domain === domain);
  if (status) rows = rows.filter((r) => r.status === status);
  rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return rows.slice(0, limit);
}

export async function savePlanningDraft(partial) {
  const createdAt = partial?.createdAt || nowISO();
  const updatedAt = nowISO();
  const row = {
    id: partial?.id || createId("draft"),
    kind: partial?.kind || "unknown.draft",
    domain: partial?.domain || "unknown",
    title: partial?.title || "Draft",
    status: partial?.status || "draft",
    createdAt,
    updatedAt,
    inputs: partial?.inputs || {},
    outputs: partial?.outputs || {},
    links: partial?.links || { homesteadPlanId: null },
    metadata: partial?.metadata || { version: 1 },
  };

  const db = await safeImportDb();
  try {
    if (db?.planningDrafts) {
      await db.planningDrafts.put(row);
      return row;
    }
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[PlanningDraftsRepo] Dexie put failed, falling back:", err);
    }
  }
  return upsertLS(row);
}

export async function listPlanningDrafts(opts = {}) {
  const db = await safeImportDb();
  try {
    if (db?.planningDrafts) {
      let q = db.planningDrafts.toCollection();
      if (opts.kind) q = db.planningDrafts.where("kind").equals(opts.kind);
      // If you need compound filters, keep it simple: filter() is OK for small volumes.
      let rows = await q.toArray();
      if (opts.domain) rows = rows.filter((r) => r.domain === opts.domain);
      if (opts.status) rows = rows.filter((r) => r.status === opts.status);
      rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
      return rows.slice(0, opts.limit || 25);
    }
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[PlanningDraftsRepo] Dexie list failed, falling back:",
        err
      );
    }
  }
  return queryLS(opts);
}

export async function getPlanningDraft(id) {
  if (!id) return null;
  const db = await safeImportDb();
  try {
    if (db?.planningDrafts) return await db.planningDrafts.get(id);
  } catch {
    // ignore
  }
  const rows = readLS();
  return rows.find((r) => r.id === id) || null;
}
