// C:\Users\larho\suka-smart-assistant\src\services\recalls\RecallService.js
// -----------------------------------------------------------------------------
// RecallService
// - Matches by UPC / brand / product name (title)
// - Stores recall alerts in Dexie
//
// Recommended Dexie tables:
//   recalls: "&id, upc, brand, ts, severity"
//   recall_alerts: "++id, candidateId, upc, ts"
//
// Emits:
//   recalls:ingested
//   recalls:matched
// -----------------------------------------------------------------------------

function now() {
  return Date.now();
}

function str(x) {
  const s = String(x ?? "").trim();
  return s ? s : "";
}

function safeBus(bus) {
  return bus && typeof bus.emit === "function" ? bus : { emit: () => {} };
}

function safeDb(db) {
  return db && typeof db.table === "function" ? db : null;
}

function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function severityRank(sev) {
  const s = String(sev || "")
    .toLowerCase()
    .trim();
  if (s === "high" || s === "critical") return 3;
  if (s === "medium") return 2;
  if (s === "low") return 1;
  return 0;
}

function overlapScore(a, b) {
  const A = new Set(
    norm(a)
      .split(" ")
      .filter((w) => w.length > 2)
  );
  const B = new Set(
    norm(b)
      .split(" ")
      .filter((w) => w.length > 2)
  );
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return Math.min(30, hit * 6);
}

export function createRecallService(deps = {}) {
  const db = deps.db || null;
  const eventBus = deps.eventBus || null;
  const logger = deps.logger || console;

  const dexie = safeDb(db);
  const bus = safeBus(eventBus);

  const mem = {
    recalls: [],
    alerts: [],
  };

  return {
    ingestRecalls,
    matchRecallsForCandidate,
    listRecallsByUpc,
    listRecallAlerts,
  };

  /**
   * Ingest recall items (normalized).
   * Supported:
   * { id, title, severity, summary, url, date, affected, upc?, brand?, productName? }
   */
  async function ingestRecalls(recalls = []) {
    const list = Array.isArray(recalls) ? recalls : [];
    const normalized = list.map(materializeRecall).filter(Boolean);

    if (dexie && dexie.recalls) {
      try {
        await dexie.recalls.bulkPut(normalized);
        bus.emit("recalls:ingested", { count: normalized.length, ts: now() });
        return normalized.length;
      } catch (e) {
        logger?.warn?.(
          "[RecallService] recalls.bulkPut failed, falling back",
          e
        );
      }
    }

    for (const r of normalized) {
      const idx = mem.recalls.findIndex((x) => x.id === r.id);
      if (idx >= 0) mem.recalls[idx] = r;
      else mem.recalls.push(r);
    }

    bus.emit("recalls:ingested", { count: normalized.length, ts: now() });
    return normalized.length;
  }

  /**
   * Match recalls for a candidate.
   * Inputs:
   * { candidateId, upc, brand, title, limit }
   * Output:
   * recall[] sorted by score desc
   */
  async function matchRecallsForCandidate(opts = {}) {
    const cid = str(opts.candidateId);
    const u = str(opts.upc);
    const b = norm(opts.brand);
    const t = norm(opts.title);
    const limit = Math.max(1, Number(opts.limit || 10));

    const recalls = await selectRecalls();

    const scored = recalls
      .map((r) => {
        const rUpc = str(r.upc);
        const rBrand = norm(r.brand);
        const rTitle = norm(r.productName || r.title);

        const score =
          (rUpc && u && rUpc === u ? 100 : 0) +
          (rBrand && b && rBrand === b ? 25 : 0) +
          (rTitle && t ? overlapScore(rTitle, t) : 0) +
          severityRank(r.severity) * 3;

        return { r, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b2) => b2.score - a.score)
      .slice(0, limit)
      .map((x) => x.r);

    const alertRec = {
      candidateId: cid || null,
      upc: u || null,
      ts: now(),
      recalls: scored,
    };

    await persistAlert(alertRec);

    bus.emit("recalls:matched", {
      candidateId: cid || null,
      upc: u || null,
      count: scored.length,
      ts: now(),
    });

    return scored;
  }

  async function listRecallsByUpc(opts = {}) {
    const u = str(opts.upc);
    if (!u) return [];

    if (dexie && dexie.recalls) {
      try {
        if (dexie.recalls.where) {
          return await dexie.recalls.where("upc").equals(u).toArray();
        }
        // fallback if schema differs
        const all = await dexie.recalls.toArray();
        return all.filter((r) => str(r.upc) === u);
      } catch (e) {
        logger?.warn?.("[RecallService] listRecallsByUpc", e);
      }
    }

    return mem.recalls.filter((r) => str(r.upc) === u);
  }

  async function listRecallAlerts(opts = {}) {
    const cid = str(opts.candidateId);

    if (dexie && dexie.recall_alerts) {
      try {
        if (!cid) {
          return await dexie.recall_alerts
            .orderBy("ts")
            .reverse()
            .limit(50)
            .toArray();
        }
        if (dexie.recall_alerts.where) {
          return await dexie.recall_alerts
            .where("candidateId")
            .equals(cid)
            .toArray();
        }
        const all = await dexie.recall_alerts.toArray();
        return all.filter((a) => str(a.candidateId) === cid);
      } catch (e) {
        logger?.warn?.("[RecallService] listRecallAlerts", e);
      }
    }

    if (!cid) return mem.alerts.slice(-50);
    return mem.alerts.filter((a) => str(a.candidateId) === cid);
  }

  // -------------------- internals --------------------

  async function selectRecalls() {
    if (dexie && dexie.recalls) {
      try {
        return await dexie.recalls.toArray();
      } catch (e) {
        logger?.warn?.("[RecallService] selectRecalls", e);
      }
    }
    return mem.recalls.slice();
  }

  async function persistAlert(alertRec) {
    const rec = {
      candidateId: alertRec.candidateId || null,
      upc: alertRec.upc || null,
      ts: alertRec.ts || now(),
      recalls: Array.isArray(alertRec.recalls) ? alertRec.recalls : [],
    };

    if (dexie && dexie.recall_alerts) {
      try {
        await dexie.recall_alerts.add(rec);
        return;
      } catch (e) {
        logger?.warn?.(
          "[RecallService] recall_alerts.add failed, falling back",
          e
        );
      }
    }

    mem.alerts.push({ ...rec, id: mem.alerts.length + 1 });
  }

  function materializeRecall(r) {
    const o = isObj(r) ? r : {};
    const id = str(o.id || o.recallId || o.url || o.title || "");
    if (!id) return null;

    return {
      id,
      title: str(o.title || "Recall"),
      severity: str(o.severity || "medium").toLowerCase(),
      summary: str(o.summary || o.description || "") || null,
      url: str(o.url || "") || null,
      date: str(o.date || o.publishedAt || "") || null,
      affected: o.affected || null,

      upc: str(o.upc || "") || null,
      brand: str(o.brand || "") || null,
      productName: str(o.productName || o.product_name || "") || null,

      ts: now(),
    };
  }
}

let __recallService;
export function getRecallService(deps) {
  if (!__recallService) __recallService = createRecallService(deps);
  return __recallService;
}
