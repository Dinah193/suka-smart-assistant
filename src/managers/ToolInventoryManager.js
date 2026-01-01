// src/managers/ToolInventoryManager.js

import Dexie from "dexie";

/* -----------------------------------------------------------------------------
 * DB (v1 -> v2)
 * -------------------------------------------------------------------------- */
const db = new Dexie("SukaInventoryDB");

// v1 (original)
db.version(1).stores({
  tools: "id, name, type, location, condition, tags",
});

// v2: richer fields + separate logs
db.version(2)
  .stores({
    tools:
      "id, name, type, location, condition, conditionScore, tags, serial, vendor, purchaseAt, lastServiceAt, serviceEveryDays, notes, lastUpdated",
    checkouts: "++id, toolId, by, atISO, dueISO, returnedAtISO, notes",
    maintenanceLogs: "++id, toolId, atISO, action, notes, nextDueISO",
  })
  .upgrade(async (tx) => {
    const tbl = tx.table("tools");
    const items = await tbl.toArray();
    await Promise.all(
      items.map((t) =>
        tbl.put({
          ...t,
          conditionScore: typeof t.conditionScore === "number" ? t.conditionScore : scoreFromCondition(t.condition),
          tags: Array.isArray(t.tags) ? t.tags : (t.tags ? [t.tags] : []),
          lastUpdated: t.lastUpdated || new Date(),
          serviceEveryDays: t.serviceEveryDays || null,
          lastServiceAt: t.lastServiceAt || null,
          purchaseAt: t.purchaseAt || null,
          notes: t.notes || "",
        })
      )
    );
  });

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */
const hasWindow = () => typeof window !== "undefined";
const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d || Date.now()).toISOString());
const toNum = (v, def = 0) => (Number.isFinite(Number(v)) ? Number(v) : def);
const safeArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const genId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

function emitUpdated(topic = "TOOLS:UPDATED", payload = {}) {
  try {
    const s = hasWindow() ? window.__SUKA_SOCKET__ : null;
    if (s?.connected) s.emit(topic, { at: iso(), ...payload });
  } catch { /* noop */ }
}

function scoreFromCondition(cond) {
  const c = String(cond || "").toLowerCase();
  if (c.includes("new")) return 90;
  if (c.includes("good") || c.includes("excellent")) return 75;
  if (c.includes("fair")) return 55;
  if (c.includes("poor") || c.includes("broken")) return 25;
  return 60; // default “OK”
}

function dueFrom(lastISO, everyDays) {
  if (!lastISO || !everyDays) return null;
  const t = new Date(lastISO).getTime() + Number(everyDays) * 86400000;
  return iso(t);
}

function daysSince(d) {
  if (!d) return null;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
}

function tokenize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/* -----------------------------------------------------------------------------
 * Manager
 * -------------------------------------------------------------------------- */
const ToolInventoryManager = {
  /* ------------------------------- Core (compat) --------------------------- */

  async add(tool) {
    const now = new Date();
    const row = {
      id: tool.id || genId(),
      name: tool.name?.trim(),
      type: tool.type || "general",
      location: tool.location || "",
      condition: tool.condition || "good",
      conditionScore: toNum(tool.conditionScore, scoreFromCondition(tool.condition)),
      tags: safeArr(tool.tags),
      serial: tool.serial || "",
      vendor: tool.vendor || "",
      purchaseAt: tool.purchaseAt || null,
      lastServiceAt: tool.lastServiceAt || null,
      serviceEveryDays: tool.serviceEveryDays || null,
      notes: tool.notes || "",
      lastUpdated: now,
    };
    await db.tools.put(row);
    emitUpdated();
    return row;
  },

  async getAll() {
    return db.tools.toArray();
  },

  async update(id, updates) {
    const prev = await db.tools.get(id);
    if (!prev) return 0;
    const next = {
      ...prev,
      ...updates,
      tags: updates.tags ? safeArr(updates.tags) : prev.tags,
      conditionScore:
        updates.conditionScore != null
          ? toNum(updates.conditionScore, prev.conditionScore)
          : scoreFromCondition(updates.condition || prev.condition),
      lastUpdated: new Date(),
    };
    await db.tools.put(next);
    emitUpdated();
    return 1;
  },

  async remove(id) {
    await db.tools.delete(id);
    emitUpdated();
    return 1;
  },

  async clear() {
    await db.tools.clear();
    if (db.checkouts) await db.checkouts.clear();
    if (db.maintenanceLogs) await db.maintenanceLogs.clear();
    emitUpdated();
    return 1;
  },

  /* ------------------------------- Bulk/Portability ----------------------- */

  async bulkUpsert(list = []) {
    const rows = list.map((t) => ({
      id: t.id || genId(),
      name: t.name?.trim(),
      type: t.type || "general",
      location: t.location || "",
      condition: t.condition || "good",
      conditionScore: toNum(t.conditionScore, scoreFromCondition(t.condition)),
      tags: safeArr(t.tags),
      serial: t.serial || "",
      vendor: t.vendor || "",
      purchaseAt: t.purchaseAt || null,
      lastServiceAt: t.lastServiceAt || null,
      serviceEveryDays: t.serviceEveryDays || null,
      notes: t.notes || "",
      lastUpdated: new Date(),
    }));
    await db.tools.bulkPut(rows);
    emitUpdated();
    return rows.length;
  },

  async exportCSV() {
    const rows = await db.tools.toArray();
    const header = [
      "id","name","type","location","condition","conditionScore","tags","serial","vendor","purchaseAt","lastServiceAt","serviceEveryDays","notes","lastUpdatedISO"
    ];
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push([
        r.id,
        JSON.stringify(r.name ?? ""),
        JSON.stringify(r.type ?? ""),
        JSON.stringify(r.location ?? ""),
        JSON.stringify(r.condition ?? ""),
        r.conditionScore ?? "",
        JSON.stringify((r.tags || []).join("|")),
        JSON.stringify(r.serial ?? ""),
        JSON.stringify(r.vendor ?? ""),
        r.purchaseAt ?? "",
        r.lastServiceAt ?? "",
        r.serviceEveryDays ?? "",
        JSON.stringify(r.notes ?? ""),
        iso(r.lastUpdated || new Date())
      ].join(","));
    }
    return lines.join("\n");
  },

  async importCSV(text) {
    if (!text) return 0;
    const [head, ...rows] = text.split(/\r?\n/).filter(Boolean);
    const cols = head.split(",");
    const idx = (k) => cols.indexOf(k);
    const parsed = rows.map((line) => {
      const c = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g).map((v) => v.replace(/^"|"$/g, ""));
      return {
        id: c[idx("id")] || genId(),
        name: c[idx("name")] || "",
        type: c[idx("type")] || "general",
        location: c[idx("location")] || "",
        condition: c[idx("condition")] || "good",
        conditionScore: toNum(c[idx("conditionScore")], scoreFromCondition(c[idx("condition")])),
        tags: (c[idx("tags")] || "").split("|").filter(Boolean),
        serial: c[idx("serial")] || "",
        vendor: c[idx("vendor")] || "",
        purchaseAt: c[idx("purchaseAt")] || null,
        lastServiceAt: c[idx("lastServiceAt")] || null,
        serviceEveryDays: c[idx("serviceEveryDays")] ? Number(c[idx("serviceEveryDays")]) : null,
        notes: c[idx("notes")] || "",
        lastUpdated: new Date(c[idx("lastUpdatedISO")] || Date.now()),
      };
    });
    await db.tools.bulkPut(parsed);
    emitUpdated();
    return parsed.length;
  },

  async backupToLocal() {
    const tools = await db.tools.toArray();
    const checkouts = (await db.checkouts?.toArray?.()) || [];
    const maintenance = (await db.maintenanceLogs?.toArray?.()) || [];
    localStorage.setItem("suka_tools_backup", JSON.stringify({ tools, checkouts, maintenance, at: iso() }));
    return true;
  },

  async restoreFromLocal() {
    const raw = localStorage.getItem("suka_tools_backup");
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    const tools = parsed?.tools || [];
    const checkouts = parsed?.checkouts || [];
    const maintenance = parsed?.maintenance || [];
    await db.transaction("rw", db.tools, db.checkouts, db.maintenanceLogs, async () => {
      await db.tools.clear();
      if (db.checkouts) await db.checkouts.clear();
      if (db.maintenanceLogs) await db.maintenanceLogs.clear();
      if (tools.length) await db.tools.bulkPut(tools);
      if (checkouts.length && db.checkouts) await db.checkouts.bulkPut(checkouts);
      if (maintenance.length && db.maintenanceLogs) await db.maintenanceLogs.bulkPut(maintenance);
    });
    emitUpdated();
    return tools.length;
  },

  /* -------------------------------- Search/Lookup ------------------------- */

  async findByNameLoose(name) {
    if (!name) return null;
    const needle = String(name).trim().toLowerCase().replace(/\s+/g, " ");
    const all = await db.tools.toArray();
    return (
      all.find((t) => (t.name || "").toLowerCase().replace(/\s+/g, " ") === needle) ||
      all.find((t) => tokenize(t.name).includes(needle)) ||
      null
    );
  },

  async search(q, { tagsAny = [], type = null, location = null } = {}) {
    const all = await db.tools.toArray();
    const needle = String(q || "").toLowerCase().trim();
    return all.filter((t) => {
      const textOK =
        !needle ||
        (t.name && t.name.toLowerCase().includes(needle)) ||
        (t.type && t.type.toLowerCase().includes(needle)) ||
        tokenize([t.name, t.type, t.location, t.serial, t.vendor, t.notes].join(" ")).some((x) =>
          x.includes(needle)
        );
      const tagOK = !tagsAny.length || safeArr(t.tags).some((x) => tagsAny.includes(x));
      const typeOK = !type || t.type === type;
      const locOK = !location || t.location === location;
      return textOK && tagOK && typeOK && locOK;
    });
  },

  /* ------------------------------- Availability --------------------------- */

  async checkout(toolId, { by, hours = 4, notes = "" } = {}) {
    const tool = await db.tools.get(toolId);
    if (!tool) return null;

    // Ensure not already checked out
    const active = await db.checkouts.where("toolId").equals(toolId).and((r) => !r.returnedAtISO).toArray();
    if (active.length) {
      // append note
      return { conflict: true, checkout: active[0] };
    }

    const atISO = iso();
    const dueISO = iso(new Date(Date.now() + hours * 3600000));
    const row = { toolId, by: by || "unknown", atISO, dueISO, returnedAtISO: null, notes };
    await db.checkouts.add(row);
    // degrade condition slightly on checkout? (optional)
    tool.lastUpdated = new Date();
    await db.tools.put(tool);
    emitUpdated();
    return row;
  },

  async checkin(toolId, { condition, notes = "" } = {}) {
    const tool = await db.tools.get(toolId);
    if (!tool) return null;

    const active = await db.checkouts.where("toolId").equals(toolId).and((r) => !r.returnedAtISO).toArray();
    if (!active.length) return { ok: false, reason: "not_checked_out" };

    const entry = active[0];
    entry.returnedAtISO = iso();
    if (notes) entry.notes = `${entry.notes || ""}\n${notes}`.trim();
    await db.checkouts.put(entry);

    if (condition) {
      tool.condition = condition;
      tool.conditionScore = scoreFromCondition(condition);
    }
    tool.lastUpdated = new Date();
    await db.tools.put(tool);
    emitUpdated();
    return { ok: true, entry };
  },

  async getAvailable() {
    const all = await db.tools.toArray();
    const active = await db.checkouts?.toArray?.();
    if (!active) return all; // no checkout table → all available

    const out = [];
    for (const t of all) {
      const onLoan = active.some((r) => r.toolId === t.id && !r.returnedAtISO);
      if (!onLoan) out.push(t);
    }
    return out;
  },

  async getCheckedOutBy(user) {
    const rows = await db.checkouts?.where("by").equals(user).and((r) => !r.returnedAtISO).toArray();
    if (!rows) return [];
    const ids = rows.map((r) => r.toolId);
    const tools = await db.tools.bulkGet(ids);
    return tools.filter(Boolean).map((t, i) => ({ ...t, checkout: rows[i] }));
  },

  async overdueCheckouts({ windowHours = 0 } = {}) {
    const rows = await db.checkouts?.toArray?.();
    if (!rows) return [];
    const now = Date.now();
    const list = rows.filter((r) => !r.returnedAtISO && new Date(r.dueISO).getTime() + windowHours * 3600000 < now);
    const ids = list.map((r) => r.toolId);
    const tools = await db.tools.bulkGet(ids);
    return tools.map((t, i) => ({ ...t, checkout: list[i] })).filter(Boolean);
  },

  /* -------------------------------- Maintenance --------------------------- */

  async markMaintenance(toolId, { action = "service", notes = "", nextInDays = null } = {}) {
    const tool = await db.tools.get(toolId);
    if (!tool) return 0;

    const atISO = iso();
    let nextDueISO = null;
    if (nextInDays != null) nextDueISO = iso(new Date(Date.now() + Number(nextInDays) * 86400000));

    await db.maintenanceLogs?.add?.({ toolId, atISO, action, notes, nextDueISO });
    tool.lastServiceAt = atISO;
    if (nextInDays != null) tool.serviceEveryDays = Number(nextInDays);
    tool.lastUpdated = new Date();
    await db.tools.put(tool);
    emitUpdated();
    return 1;
  },

  async dueMaintenance({ withinDays = 14 } = {}) {
    const rows = await db.tools.toArray();
    const now = Date.now();
    const limit = withinDays * 86400000;

    return rows
      .map((t) => {
        const nextISO = t.serviceEveryDays ? dueFrom(t.lastServiceAt || t.purchaseAt || iso(), t.serviceEveryDays) : null;
        const nextTs = nextISO ? new Date(nextISO).getTime() : null;
        const dueSoon = nextTs != null && nextTs - now <= limit;
        return {
          ...t,
          nextServiceISO: nextISO,
          daysSinceService: daysSince(t.lastServiceAt),
          dueSoon,
        };
      })
      .filter((t) => t.dueSoon);
  },

  async maintenanceSummary() {
    const all = await db.tools.toArray();
    const due14 = await this.dueMaintenance({ withinDays: 14 });
    const overdue = due14.filter((t) => new Date(t.nextServiceISO).getTime() <= Date.now()).length;
    return {
      total: all.length,
      dueIn14: due14.length,
      overdue,
      avgCondition: all.length ? Math.round(all.reduce((s, t) => s + (t.conditionScore || 0), 0) / all.length) : 0,
    };
  },

  /* --------------------------------- Insights ----------------------------- */

  async suggestReplacements({ max = 10 } = {}) {
    const rows = await db.tools.toArray();
    const sorted = rows
      .map((t) => {
        const ageDays = daysSince(t.purchaseAt) ?? 0;
        const wear = 100 - (t.conditionScore || 50);
        // crude heuristic: older + worn tools bubble up
        const score = wear * 0.7 + Math.min(3650, ageDays) / 3650 * 30;
        return { ...t, replacementScore: Math.round(score) };
      })
      .sort((a, b) => (b.replacementScore || 0) - (a.replacementScore || 0));
    return sorted.slice(0, max);
  },
};

export default ToolInventoryManager;
