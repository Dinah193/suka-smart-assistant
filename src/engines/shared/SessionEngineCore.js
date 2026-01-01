// src/engines/shared/SessionEngineCore.js
/* eslint-disable no-console */

/**
 * SessionEngineCore
 * -----------------------------------------------------------------------------
 * A reusable base class for all domain engines (inventory, meals, cleaning,
 * garden, animals, storehouse) so that:
 *
 *  - All sessions look/behave the same
 *  - Users can save their own favorite sessions/schedules (NOT just system)
 *  - Schedules hand off to the in-app automation runtime
 *  - Reverse generation is supported via a pluggable hook
 *  - Shared orchestration events are emitted in the same format
 *
 * Domain engines should subclass and implement:
 *   - this.domainName = "inventory" | "meals" | ...
 *   - buildTasksFromSource(sourcePayload)
 *   - optionally: buildTasksFromReverse(reversePayload)
 */

import DexieDB from "@/db"; // align with your other engines

const isBrowser = typeof window !== "undefined";
const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const nowISO = () => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/* event bridge                                                               */
/* -------------------------------------------------------------------------- */
const emitGlobal = (type, detail = {}) => {
  if (isBrowser) {
    window.dispatchEvent(new CustomEvent(type, { detail }));
    try {
      const bus = window.__suka?.eventBus;
      if (bus?.emit) bus.emit(type, detail);
    } catch {
      /* noop */
    }
  }
};

/* -------------------------------------------------------------------------- */
/* quiet / sabbath guard (non-blocking)                                      */
/* -------------------------------------------------------------------------- */
const respectQuietHours = async (ctx = {}) => {
  try {
    const globalConfig = isBrowser ? window.__suka?.config ?? {} : {};
    const quiet = globalConfig.quietHours || {};
    if (!quiet.enabled) return true;

    const hour = new Date().getHours();
    const start = quiet.start ?? 21;
    const end = quiet.end ?? 7;
    const within =
      start < end ? hour >= start && hour < end : hour >= start || hour < end;

    if (within) {
      emitGlobal("suka:quiet-hours:blocked", {
        ctx,
        reason: "session-engine-core",
      });
    }
    return !within;
  } catch (err) {
    console.warn("[SessionEngineCore] quiet-hours check failed", err);
    return true;
  }
};

/* -------------------------------------------------------------------------- */
/* base normalizer                                                            */
/* -------------------------------------------------------------------------- */
const normalizeSession = (partial = {}, domainName = "session") => {
  const id = partial.id || `${domainName}_sess_${genId()}`;
  return {
    id,
    domain: domainName,
    type: partial.type || `${domainName}-session`,
    label: partial.label || `${capitalize(domainName)} Session`,
    createdAt: partial.createdAt || nowISO(),
    updatedAt: nowISO(),
    source: partial.source || "manual", // scan|plan|reverse|import|sync|manual
    tasks: Array.isArray(partial.tasks) ? partial.tasks : [],
    links: {
      ...(partial.links || {}),
    },
    schedule: partial.schedule || null,
    ownedByUser: partial.ownedByUser ?? true,
    status: partial.status || "draft",
    meta: {
      ...(partial.meta || {}),
    },
  };
};

const capitalize = (str) => str.charAt(0).toUpperCase() + str.slice(1);

/* -------------------------------------------------------------------------- */
/* core class                                                                 */
/* -------------------------------------------------------------------------- */
export class SessionEngineCore {
  /**
   * @param {object} opts
   * @param {string} opts.domainName - e.g. "inventory", "meals", "garden"
   * @param {string} [opts.sessionTableName] - Dexie table for sessions
   * @param {string} [opts.favoritesTableName] - Dexie table for favorites
   */
  constructor(opts = {}) {
    this.domainName = opts.domainName || "session";
    this.sessionTableName =
      opts.sessionTableName || `${this.domainName}Sessions`;
    this.favoritesTableName = opts.favoritesTableName || "favorites";
    this.allowLocalStorageFallback = opts.allowLocalStorageFallback ?? true;

    this.sessionTable = this._getTable(this.sessionTableName);
    this.favoritesTable = this._getTable(this.favoritesTableName);
  }

  /* ------------------------------------------------------------------------ */
  /* PUBLIC: create from source (forward)                                     */
  /* ------------------------------------------------------------------------ */
  /**
   * Creates a session from a domain-specific source payload.
   * Domain subclass MUST implement `buildTasksFromSource`.
   */
  async createFromSource(sourcePayload = {}, meta = {}) {
    const ok = await respectQuietHours({
      domain: this.domainName,
      kind: "create-from-source",
    });

    const tasks = await this._safeBuildTasksFromSource(sourcePayload);
    const session = normalizeSession(
      {
        source: meta.source || "plan",
        label:
          meta.label ||
          `${capitalize(this.domainName)} Session (from source)`,
        tasks,
        links: meta.links || {},
        ownedByUser: meta.ownedByUser ?? true,
        meta,
      },
      this.domainName
    );

    await this._persist(session);
    this._emitCreated(session, { from: "source", quiet: !ok });
    return session;
  }

  /* ------------------------------------------------------------------------ */
  /* PUBLIC: create from reverse (reverse generation)                         */
  /* ------------------------------------------------------------------------ */
  /**
   * Reverse generation entry point.
   * Domain subclass CAN implement `buildTasksFromReverse`.
   * If not implemented, we just create an empty session to keep UX consistent.
   */
  async createFromReverse(reversePayload = {}, meta = {}) {
    const tasks = await this._safeBuildTasksFromReverse(reversePayload);
    const session = normalizeSession(
      {
        source: "reverse",
        label:
          meta.label ||
          `${capitalize(this.domainName)} Session (reverse-generated)`,
        tasks,
        links: meta.links || {},
        ownedByUser: meta.ownedByUser ?? true,
        meta,
      },
      this.domainName
    );

    await this._persist(session);
    this._emitCreated(session, { from: "reverse" });

    // shared orchestration like you did for inventory
    this._emitLinkedDomainRefresh();

    return session;
  }

  /* ------------------------------------------------------------------------ */
  /* PUBLIC: save as favorite                                                 */
  /* ------------------------------------------------------------------------ */
  async saveAsFavorite(session) {
    try {
      const favorite = {
        id: `fav_${session.id}`,
        type: `${this.domainName}-session`,
        label: session.label,
        payload: session,
        createdAt: nowISO(),
        updatedAt: nowISO(),
        ownedByUser: true,
      };

      if (this.favoritesTable) {
        await this.favoritesTable.put(favorite);
      } else if (this.allowLocalStorageFallback && isBrowser) {
        const key = `suka:favorites:${this.domainName}`;
        const prev = JSON.parse(localStorage.getItem(key) || "[]");
        prev.push(favorite);
        localStorage.setItem(key, JSON.stringify(prev));
      }

      emitGlobal(`${this.domainName}:favorite:created`, {
        favorite,
      });
      return favorite;
    } catch (err) {
      console.error(
        `[SessionEngineCore:${this.domainName}] failed to save favorite`,
        err
      );
      return null;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* PUBLIC: schedule                                                         */
  /* ------------------------------------------------------------------------ */
  async scheduleSession(sessionId, scheduleDef) {
    if (!sessionId || !scheduleDef) return null;
    const session = await this._get(sessionId);
    if (!session) return null;

    session.schedule = scheduleDef;
    session.updatedAt = nowISO();
    await this._persist(session);

    // handoff to automation runtime (your src/services/automation/runtime.js)
    emitGlobal("automation:schedule:register", {
      id: sessionId,
      kind: `${this.domainName}-session`,
      schedule: scheduleDef,
      payload: session,
    });

    emitGlobal(`${this.domainName}:session:scheduled`, { session });
    return session;
  }

  /* ------------------------------------------------------------------------ */
  /* PUBLIC: list / filter                                                    */
  /* ------------------------------------------------------------------------ */
  async list(opts = {}) {
    const table = this.sessionTable;
    if (!table) {
      if (this.allowLocalStorageFallback && isBrowser) {
        const key = `suka:${this.domainName}-sessions`;
        const prev = JSON.parse(localStorage.getItem(key) || "[]");
        return this._filterSessions(prev, opts);
      }
      return [];
    }
    const all = await table.toArray();
    return this._filterSessions(all, opts);
  }

  /* ------------------------------------------------------------------------ */
  /* PUBLIC: update status                                                    */
  /* ------------------------------------------------------------------------ */
  async updateStatus(sessionId, status = "done") {
    const session = await this._get(sessionId);
    if (!session) return null;
    session.status = status;
    session.updatedAt = nowISO();
    await this._persist(session);
    emitGlobal(`${this.domainName}:session:updated`, { session });
    return session;
  }

  /* ------------------------------------------------------------------------ */
  /* PROTECTED: to be overridden                                              */
  /* ------------------------------------------------------------------------ */
  // eslint-disable-next-line class-methods-use-this
  async buildTasksFromSource(/* sourcePayload */) {
    // domain should override
    return [];
  }

  // eslint-disable-next-line class-methods-use-this
  async buildTasksFromReverse(/* reversePayload */) {
    // domain can override
    return [];
  }

  /* ------------------------------------------------------------------------ */
  /* INTERNAL: safe wrappers                                                  */
  /* ------------------------------------------------------------------------ */
  async _safeBuildTasksFromSource(sourcePayload) {
    try {
      const result = await this.buildTasksFromSource(sourcePayload);
      return Array.isArray(result) ? result : [];
    } catch (err) {
      console.error(
        `[SessionEngineCore:${this.domainName}] buildTasksFromSource failed`,
        err
      );
      return [];
    }
  }

  async _safeBuildTasksFromReverse(reversePayload) {
    try {
      const result = await this.buildTasksFromReverse(reversePayload);
      return Array.isArray(result) ? result : [];
    } catch (err) {
      console.error(
        `[SessionEngineCore:${this.domainName}] buildTasksFromReverse failed`,
        err
      );
      return [];
    }
  }

  /* ------------------------------------------------------------------------ */
  /* INTERNAL: persistence                                                    */
  /* ------------------------------------------------------------------------ */
  _getTable(name) {
    try {
      return DexieDB?.[name] ?? null;
    } catch (err) {
      console.warn(
        `[SessionEngineCore:${this.domainName}] Dexie table not available:`,
        name,
        err
      );
      return null;
    }
  }

  async _persist(session) {
    if (this.sessionTable) {
      await this.sessionTable.put(session);
    } else if (this.allowLocalStorageFallback && isBrowser) {
      const key = `suka:${this.domainName}-sessions`;
      const prev = JSON.parse(localStorage.getItem(key) || "[]");
      const idx = prev.findIndex((s) => s.id === session.id);
      if (idx > -1) prev[idx] = session;
      else prev.push(session);
      localStorage.setItem(key, JSON.stringify(prev));
    }
  }

  async _get(id) {
    if (this.sessionTable) {
      return this.sessionTable.get(id);
    }
    if (this.allowLocalStorageFallback && isBrowser) {
      const key = `suka:${this.domainName}-sessions`;
      const prev = JSON.parse(localStorage.getItem(key) || "[]");
      return prev.find((s) => s.id === id) || null;
    }
    return null;
  }

  _filterSessions(list, opts) {
    if (!opts.filter) return list;
    return list.filter((s) => {
      if (opts.filter.source && s.source !== opts.filter.source) return false;
      if (opts.filter.status && s.status !== opts.filter.status) return false;
      if (
        opts.filter.ownedByUser !== undefined &&
        s.ownedByUser !== opts.filter.ownedByUser
      )
        return false;
      return true;
    });
  }

  /* ------------------------------------------------------------------------ */
  /* INTERNAL: events                                                         */
  /* ------------------------------------------------------------------------ */
  _emitCreated(session, extra = {}) {
    emitGlobal(`${this.domainName}:session:created`, {
      session,
      ...extra,
    });
  }

  /**
   * Your chats say:
   *  - "These updates must be editable on the other pages as well."
   *  - "The things that are generated on the home page need to update the appropriate other pages"
   *
   * So we broadcast the generic refresh signals here.
   */
  _emitLinkedDomainRefresh() {
    emitGlobal("meals:needs-refresh", {
      reason: `${this.domainName}-session-created`,
    });
    emitGlobal("garden:needs-refresh", {
      reason: `${this.domainName}-session-created`,
    });
    emitGlobal("animals:needs-refresh", {
      reason: `${this.domainName}-session-created`,
    });
    emitGlobal("cleaning:needs-refresh", {
      reason: `${this.domainName}-session-created`,
    });
    emitGlobal("inventory:needs-refresh", {
      reason: `${this.domainName}-session-created`,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* helper: make a singleton like your other files                            */
/* -------------------------------------------------------------------------- */
const __instances = {};
export const getSessionEngineCore = (domainName, opts = {}) => {
  const key = domainName || opts.domainName || "session";
  if (!__instances[key]) {
    __instances[key] = new SessionEngineCore({ domainName: key, ...opts });
  }
  return __instances[key];
};
