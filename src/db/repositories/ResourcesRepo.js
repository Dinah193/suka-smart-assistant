// C:\Users\larho\suka-smart-assistant\src\db\repositories\ResourcesRepo.js
/* eslint-disable no-console */

/**
 * ResourcesRepo
 * -----------------------------------------------------------------------------
 * Role in pipeline:
 * - Imports → Intelligence → Automation → (optional) Hub export
 * - "Resources" model the household graph of people, devices, rooms (and can
 *   be extended to vehicles, animals, tools, appliances, zones). Engines and
 *   automations resolve where/with-whom sessions run, who gets notifications,
 *   and which device can display/stream/timer. Any mutation emits an event for
 *   the automation runtime; if familyFundMode is ON, changes are also sent to
 *   the Hub (best-effort).
 *
 * Design goals:
 * - Domain-agnostic, extensible shape (devices/persons/rooms share common core)
 * - Efficient CRUD, batch operations, targeted finders
 * - Defensive normalization, consistent event shape { type, ts, source, data }
 */

let db = null;
try {
  // Expect a Dexie instance with a "resources" table.
  const mod = require("@/db");
  db = mod?.default || mod?.db || mod;
} catch {}

let eventBus = { emit: () => {}, on: () => () => {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let featureFlags = { familyFundMode: false };
try {
  featureFlags = require("@/config/featureFlags.json");
} catch {}

let HubPacketFormatter = null;
try {
  const mod = require("@/services/hub/HubPacketFormatter");
  HubPacketFormatter = mod?.default || mod;
} catch {}

let FamilyFundConnector = null;
try {
  const mod = require("@/services/hub/FamilyFundConnector");
  FamilyFundConnector = mod?.default || mod;
} catch {}

const SOURCE = "db/ResourcesRepo";

/* ----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

function isoNow() {
  return new Date().toISOString();
}

function uuid(prefix = "res") {
  try {
    return (
      globalThis?.crypto?.randomUUID?.() ||
      `${prefix}_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`
    );
  } catch {
    return `${prefix}_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }
}

function emit(type, data) {
  try {
    eventBus.emit({ type, ts: isoNow(), source: SOURCE, data });
  } catch (err) {
    console.warn("[ResourcesRepo] event emit failed:", err);
  }
}

async function exportToHubIfEnabled(payload) {
  if (
    !featureFlags?.familyFundMode ||
    !HubPacketFormatter ||
    !FamilyFundConnector
  )
    return;
  try {
    const packet =
      HubPacketFormatter.formatResourceChange?.(payload) || payload;
    await FamilyFundConnector.send?.(packet);
  } catch (err) {
    // Silent fail by design
    console.warn(
      "[ResourcesRepo] Hub export failed (silent):",
      err?.message || err
    );
  }
}

function ensureDB() {
  if (!db || typeof db !== "object" || !db.resources) {
    throw new Error(
      "Dexie 'db.resources' table not available. Ensure '@/db' exports a Dexie with a 'resources' table."
    );
  }
}

/**
 * Normalize a resource into a safe, future-proof shape.
 * type: "device" | "person" | "room" | (future: "vehicle" | "animal" | "tool" | "appliance" | "zone")
 * status: "active" | "inactive" | "retired" | "maintenance" | "offline" | "available" | "busy" | "away"
 */
function normalizeResource(input = {}) {
  if (!input || typeof input !== "object")
    return { ok: false, error: "Invalid resource payload." };

  const now = isoNow();
  const allowedTypes = new Set([
    "device",
    "person",
    "room",
    "animal",
    "tool",
    "appliance",
    "vehicle",
    "zone",
  ]);
  const allowedStatus = new Set([
    "active",
    "inactive",
    "retired",
    "maintenance",
    "offline",
    "available",
    "busy",
    "away",
  ]);

  const type =
    (input.type && String(input.type).trim().toLowerCase()) || "device";
  const status = allowedStatus.has(input.status) ? input.status : "active";

  const record = {
    id: input.id || uuid(),
    type: allowedTypes.has(type) ? type : "device",
    name: String(input.name || "").trim() || "Unnamed",
    alias: Array.isArray(input.alias) ? input.alias : [],

    status,

    // Capability tags help the automation runtime discover surfaces:
    // examples: ["screen", "speaker", "microphone", "camera", "timer", "wake-lock", "webrtc", "ble", "rfid"]
    capabilities: Array.isArray(input.capabilities)
      ? dedupeStrings(input.capabilities)
      : [],

    // Placement / Ownership
    location: {
      roomId: input?.location?.roomId || null,
      coords: input?.location?.coords || null, // { lat, lng, alt? } or { x, y, z }
      // optional zone references in future
      zoneId: input?.location?.zoneId || null,
    },
    assignedTo: {
      personId: input?.assignedTo?.personId || null, // primary assignee (e.g., phone owner)
      householdRole: input?.assignedTo?.householdRole || null, // "householder" | "guest" | ...
    },
    householdId: input.householdId || null,
    origin: input.origin || null, // import url, connector, user action

    // Contact (for people) / Network (for devices)
    contact: {
      email: input?.contact?.email || null,
      phone: input?.contact?.phone || null,
      // device network hints (local only; do NOT store secrets here)
      network: input?.contact?.network || null, // { ip, hostname, kind }
    },

    presence: {
      state: normalizePresence(input?.presence?.state), // "online" | "offline" | "present" | "away" | "unknown"
      lastSeenAt:
        input?.presence?.lastSeenAt || (status === "offline" ? null : now),
      // lightweight signal snapshot for automations
      signal: input?.presence?.signal || null, // { rssi, batteryPct, charging }
    },

    schedule: {
      // availability windows (ISO): [{ start, end, daysOfWeek?: [0..6] }]
      availability: Array.isArray(input?.schedule?.availability)
        ? input.schedule.availability
        : [],
      // do-not-disturb windows: [{ start, end, daysOfWeek?: [0..6] }]
      dnd: Array.isArray(input?.schedule?.dnd) ? input.schedule.dnd : [],
      timezone: input?.schedule?.timezone || null,
    },

    metadata:
      input.metadata && typeof input.metadata === "object"
        ? input.metadata
        : {},

    createdAt: input.createdAt || now,
    updatedAt: now,
    archivedAt: input.archivedAt || null,
  };

  return { ok: true, record };
}

function normalizePresence(state) {
  const allowed = new Set(["online", "offline", "present", "away", "unknown"]);
  return allowed.has(state) ? state : "unknown";
}

function dedupeStrings(arr) {
  return Array.from(new Set(arr.map((s) => String(s).trim()).filter(Boolean)));
}

/* ----------------------------------------------------------------------------
 * Repository
 * -------------------------------------------------------------------------- */

const ResourcesRepo = {
  /**
   * create(resource)
   */
  async create(resource) {
    ensureDB();
    const res = normalizeResource(resource);
    if (!res.ok) return { ok: false, error: res.error };

    const rec = res.record;
    try {
      await db.resources.put(rec);
      const payload = { action: "create", resource: rec };
      emit("resource.created", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: rec };
    } catch (err) {
      console.error("[ResourcesRepo.create] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * bulkCreate(resources[])
   */
  async bulkCreate(list = []) {
    ensureDB();
    if (!Array.isArray(list) || !list.length)
      return { ok: false, error: "Nothing to create." };

    const ready = [];
    for (const r of list) {
      const res = normalizeResource(r);
      if (res.ok) ready.push(res.record);
    }
    if (!ready.length) return { ok: false, error: "No valid resources." };

    try {
      const ids = await db.resources.bulkPut(ready);
      const payload = {
        action: "bulkCreate",
        count: ready.length,
        resources: ready.map((r) => r.id),
      };
      emit("resource.bulk_created", payload);
      await exportToHubIfEnabled(payload);
      return {
        ok: true,
        data: Array.isArray(ids) ? ids : ready.map((r) => r.id),
      };
    } catch (err) {
      console.error("[ResourcesRepo.bulkCreate] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * getById(id)
   */
  async getById(id) {
    ensureDB();
    if (!id) return { ok: false, error: "Missing id." };
    try {
      const row = await db.resources.get(id);
      return row ? { ok: true, data: row } : { ok: false, error: "Not found." };
    } catch (err) {
      console.error("[ResourcesRepo.getById] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * list(filters)
   * - Filters: type, status, roomId, personId, capabilityHas, text, limit/offset, sortBy/sortDir
   */
  async list(opts = {}) {
    ensureDB();
    const {
      type = null,
      status = null,
      roomId = null,
      personId = null,
      capabilityHas = null, // string | string[]
      text = null, // fuzzy on name/alias
      limit = 200,
      offset = 0,
      sortBy = "updatedAt",
      sortDir = "desc",
    } = opts;

    try {
      let coll = db.resources.toCollection();

      if (type) {
        const set = Array.isArray(type) ? new Set(type) : new Set([type]);
        coll = coll.and((r) => set.has(r.type));
      }
      if (status) {
        const set = Array.isArray(status) ? new Set(status) : new Set([status]);
        coll = coll.and((r) => set.has(r.status));
      }
      if (roomId) {
        coll = coll.and((r) => r?.location?.roomId === roomId);
      }
      if (personId) {
        coll = coll.and((r) => r?.assignedTo?.personId === personId);
      }
      if (capabilityHas) {
        const req = Array.isArray(capabilityHas)
          ? new Set(capabilityHas)
          : new Set([capabilityHas]);
        coll = coll.and((r) => {
          const caps = new Set(r?.capabilities || []);
          for (const c of req) if (!caps.has(c)) return false;
          return true;
        });
      }
      if (text) {
        const q = String(text).toLowerCase();
        coll = coll.and((r) => {
          const inName = String(r.name || "")
            .toLowerCase()
            .includes(q);
          const inAlias = (r.alias || []).some((a) =>
            String(a).toLowerCase().includes(q)
          );
          return inName || inAlias;
        });
      }

      const dir = sortDir === "asc" ? 1 : -1;
      const arr = await coll
        .sortBy(sortBy)
        .then((a) => (dir === 1 ? a : a.reverse()));
      const slice = arr.slice(offset, offset + limit);

      return {
        ok: true,
        data: { total: arr.length, items: slice, offset, limit },
      };
    } catch (err) {
      console.error("[ResourcesRepo.list] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * update(id, next)
   */
  async update(id, next) {
    ensureDB();
    if (!id || !next || typeof next !== "object")
      return { ok: false, error: "Invalid update payload." };

    const current = await db.resources.get(id);
    if (!current) return { ok: false, error: "Not found." };

    const res = normalizeResource({
      ...next,
      id,
      createdAt: current.createdAt,
    });
    if (!res.ok) return { ok: false, error: res.error };

    try {
      await db.resources.put(res.record);
      const payload = { action: "update", resource: res.record };
      emit("resource.updated", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: res.record };
    } catch (err) {
      console.error("[ResourcesRepo.update] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * patch(id, partial)
   */
  async patch(id, partial = {}) {
    ensureDB();
    if (!id || typeof partial !== "object")
      return { ok: false, error: "Invalid patch payload." };
    try {
      const current = await db.resources.get(id);
      if (!current) return { ok: false, error: "Not found." };

      const merged = { ...current, ...partial, id, updatedAt: isoNow() };
      await db.resources.put(merged);
      const payload = {
        action: "patch",
        resource: merged,
        fields: Object.keys(partial),
      };
      emit("resource.patched", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: merged };
    } catch (err) {
      console.error("[ResourcesRepo.patch] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * upsert(resource)
   */
  async upsert(resource = {}) {
    ensureDB();
    const id = resource?.id;
    if (!id) return this.create(resource);
    const exist = await db.resources.get(id);
    return exist ? this.patch(id, resource) : this.create(resource);
  },

  /**
   * remove(id)
   */
  async remove(id) {
    ensureDB();
    if (!id) return { ok: false, error: "Missing id." };

    try {
      const current = await db.resources.get(id);
      if (!current) return { ok: false, error: "Not found." };

      await db.resources.delete(id);
      const payload = { action: "delete", id, resource: current };
      emit("resource.deleted", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: { id } };
    } catch (err) {
      console.error("[ResourcesRepo.remove] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * bulkRemove(ids[])
   */
  async bulkRemove(ids = []) {
    ensureDB();
    if (!Array.isArray(ids) || !ids.length)
      return { ok: false, error: "Nothing to remove." };
    try {
      await db.resources.bulkDelete(ids);
      const payload = { action: "bulkDelete", ids };
      emit("resource.bulk_deleted", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: ids };
    } catch (err) {
      console.error("[ResourcesRepo.bulkRemove] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /* --------------------------------------------------------------------------
   * Convenience helpers for devices/persons/rooms
   * ------------------------------------------------------------------------ */

  async setStatus(id, status) {
    const res = await this.patch(id, { status });
    if (res.ok) {
      const payload = { action: "status.set", id, status };
      emit("resource.status_set", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async rename(id, name) {
    const res = await this.patch(id, { name: String(name || "").trim() });
    if (res.ok) {
      const payload = { action: "rename", id, name: res.data.name };
      emit("resource.renamed", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async assignToRoom(id, roomId) {
    const res = await this.patch(id, {
      location: { ...(await this._getLocation(id)), roomId },
    });
    if (res.ok) {
      const payload = { action: "assign.room", id, roomId };
      emit("resource.assigned_room", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async linkPerson(id, personId, householdRole = null) {
    const res = await this.patch(id, {
      assignedTo: { personId, householdRole },
    });
    if (res.ok) {
      const payload = { action: "assign.person", id, personId, householdRole };
      emit("resource.assigned_person", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async unlinkPerson(id) {
    const res = await this.patch(id, {
      assignedTo: { personId: null, householdRole: null },
    });
    if (res.ok) {
      const payload = { action: "unassign.person", id };
      emit("resource.unassigned_person", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async setCapabilities(id, caps = []) {
    if (!Array.isArray(caps))
      return { ok: false, error: "capabilities must be an array." };
    const res = await this.patch(id, { capabilities: dedupeStrings(caps) });
    if (res.ok) {
      const payload = {
        action: "capabilities.set",
        id,
        capabilities: res.data.capabilities,
      };
      emit("resource.capabilities_set", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async addCapabilities(id, caps = []) {
    if (!Array.isArray(caps) || !caps.length)
      return { ok: false, error: "No capabilities to add." };
    const curr = await this.getById(id);
    if (!curr.ok) return curr;
    const merged = dedupeStrings([...(curr.data.capabilities || []), ...caps]);
    return this.setCapabilities(id, merged);
  },

  async removeCapabilities(id, caps = []) {
    if (!Array.isArray(caps) || !caps.length)
      return { ok: false, error: "No capabilities to remove." };
    const curr = await this.getById(id);
    if (!curr.ok) return curr;
    const drop = new Set(caps);
    const kept = (curr.data.capabilities || []).filter((c) => !drop.has(c));
    return this.setCapabilities(id, kept);
  },

  async pingPresence(id, { state = "online", signal = null } = {}) {
    const now = isoNow();
    const res = await this.patch(id, {
      presence: { state: normalizePresence(state), lastSeenAt: now, signal },
    });
    if (res.ok) {
      const payload = {
        action: "presence.ping",
        id,
        state: res.data?.presence?.state,
        lastSeenAt: now,
      };
      emit("resource.presence_ping", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async markOfflineAfter(id, isoCutoff) {
    // Helper: if lastSeenAt < cutoff, set state offline.
    const r = await this.getById(id);
    if (!r.ok) return r;
    const last = r.data?.presence?.lastSeenAt
      ? new Date(r.data.presence.lastSeenAt).getTime()
      : 0;
    const cutoff = isoCutoff ? new Date(isoCutoff).getTime() : 0;
    if (last && cutoff && last < cutoff) {
      return this.patch(id, {
        presence: { ...(r.data.presence || {}), state: "offline" },
      });
    }
    return { ok: true, data: r.data }; // no-op
  },

  async setAvailability(id, availability = []) {
    if (!Array.isArray(availability))
      return { ok: false, error: "availability must be an array." };
    const r = await this.getById(id);
    if (!r.ok) return r;
    const schedule = { ...(r.data.schedule || {}), availability };
    const res = await this.patch(id, { schedule });
    if (res.ok) {
      const payload = { action: "schedule.availability_set", id, availability };
      emit("resource.availability_set", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async setDnd(id, dnd = []) {
    if (!Array.isArray(dnd))
      return { ok: false, error: "dnd must be an array." };
    const r = await this.getById(id);
    if (!r.ok) return r;
    const schedule = { ...(r.data.schedule || {}), dnd };
    const res = await this.patch(id, { schedule });
    if (res.ok) {
      const payload = { action: "schedule.dnd_set", id, dnd };
      emit("resource.dnd_set", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async locate(id, coords = null) {
    const r = await this.getById(id);
    if (!r.ok) return r;
    const location = { ...(r.data.location || {}), coords };
    const res = await this.patch(id, { location });
    if (res.ok) {
      const payload = { action: "location.set", id, coords };
      emit("resource.location_set", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  /* --------------------------------------------------------------------------
   * Finders
   * ------------------------------------------------------------------------ */

  async devices(opts = {}) {
    return this.list({ ...opts, type: "device" });
  },

  async persons(opts = {}) {
    return this.list({ ...opts, type: "person" });
  },

  async rooms(opts = {}) {
    return this.list({ ...opts, type: "room" });
  },

  async byCapability(capability, opts = {}) {
    return this.list({ ...opts, capabilityHas: capability });
  },

  async byRoom(roomId, opts = {}) {
    return this.list({ ...opts, roomId });
  },

  async byPerson(personId, opts = {}) {
    return this.list({ ...opts, personId });
  },

  /* --------------------------------------------------------------------------
   * Private helpers
   * ------------------------------------------------------------------------ */

  async _getLocation(id) {
    try {
      const row = await db.resources.get(id);
      return row?.location || {};
    } catch {
      return {};
    }
  },
};

export default ResourcesRepo;
