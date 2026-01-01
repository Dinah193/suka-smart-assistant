// C:\Users\larho\suka-smart-assistant\src\server\services\calendarService.js
//
// Suka Smart Assistant — Calendar Service (enhanced, provider-agnostic)
//
// Public API (backwards-compatible):
//   - listProviders()
//   - createEventsBatch({ provider, calendarId, events, upsert?=true })
//   - createEvent({ provider, calendarId, data, upsert?=true })
//   - deleteEvent({ provider, calendarId, eventId })
//
// Optional helpers (safe to ignore if not used):
//   - listEvents({ provider, calendarId, since?, until?, q?, externalId? })
//   - deleteByExternalId({ provider, calendarId, externalId })
//   - exportIcs({ calendarId="household", since?, until? })  // local adapter only
//
// Features:
//   - Idempotent upserts via externalId (Local + Google; best-effort Outlook open extension).
//   - Sabbath/quiet-hour awareness (opt-in via event.metadata.sabbathAware=true).
//   - Local JSON store for dev/offline; Google/Outlook adapters loaded lazily.
//   - Normalized return: { id, htmlLink, start, end, summary, provider, calendarId, timezone, externalId }
//
// Notes:
//   - We do *not* enforce Sabbath nudging globally — your controllers already pre-nudge.
//     This service only honors explicit per-event metadata flags to keep it flexible for n8n.
//
// Cloud deps (optional):
//   Google:   npm i googleapis
//   Outlook:  npm i @microsoft/microsoft-graph-client @azure/identity isomorphic-fetch
//

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_TZ = process.env.GENERIC_TIMEZONE || "America/Chicago";
const DATA_DIR = process.env.SUKA_DATA_DIR || path.join(process.cwd(), "data");
const LOCAL_DB = path.join(DATA_DIR, "calendar-local.json");

/* ─────────────────────────────── Helpers ─────────────────────────────── */

const DAY = 86400000;
const toISO = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const asArray = (x) => (Array.isArray(x) ? x : [x]);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureTz(e) {
  const ev = { ...e };
  if (!ev.timezone) ev.timezone = DEFAULT_TZ;
  return ev;
}
function parseBool(v, d = false) {
  if (typeof v === "boolean") return v;
  if (v == null) return d;
  const s = String(v).toLowerCase();
  return ["1","true","yes","y"].includes(s) ? true : ["0","false","no","n"].includes(s) ? false : d;
}
function inQuietHours(date, { start = 21, end = 7 } = {}) {
  const h = date.getHours();
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}
function isSabbath(date, { avoidSabbath = true, saturdayAsSabbath = false } = {}) {
  if (!avoidSabbath) return false;
  return saturdayAsSabbath ? date.getDay() === 6 : date.getDay() === 6; // Saturday
}
function nudgeToAllowed(date, {
  avoidSabbath = true,
  saturdayAsSabbath = false,
  quietHours = { start: 21, end: 7 },
  defaultHour = 9
} = {}) {
  let d = new Date(date);
  let guard = 0;
  while ((isSabbath(d, { avoidSabbath, saturdayAsSabbath }) || inQuietHours(d, quietHours)) && guard < 14) {
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, defaultHour, 0, 0, 0);
    guard++;
  }
  return d;
}

/** Optionally nudge timings per-event (only if metadata opts-in) */
function maybeNudgeEvent(e) {
  const meta = e.metadata || {};
  const sabbathAware = parseBool(meta.sabbathAware, false);
  if (!sabbathAware) return e;
  const params = {
    avoidSabbath: true,
    saturdayAsSabbath: parseBool(meta.saturdayAsSabbath, false),
    quietHours: meta.quietHours || { start: 21, end: 7 },
    defaultHour: Number.isFinite(meta.defaultHour) ? meta.defaultHour : 9
  };
  const start = nudgeToAllowed(new Date(e.start), params);
  const end = e.end ? new Date(e.end) : new Date(start.getTime() + 60 * 60_000);
  return { ...e, start: toISO(start), end: toISO(end) };
}

/** Lightweight retry for flaky cloud calls */
async function withRetry(fn, { attempts = 3, delayMs = 250 }) {
  let err;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      if (i < attempts - 1) await sleep(delayMs * (i + 1));
    }
  }
  throw err;
}

/* ───────────────────── Local JSON Adapter (always on) ─────────────────── */

class LocalCalendar {
  constructor(filePath) {
    this.filePath = filePath;
    this._mem = null;
  }
  async _load() {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const buf = await fs.readFile(this.filePath);
      this._mem = JSON.parse(buf.toString());
    } catch {
      this._mem = { calendars: { household: [] }, meta: {} };
      await this._flush();
    }
  }
  async _flush() {
    await fs.writeFile(this.filePath, JSON.stringify(this._mem, null, 2));
  }
  async _ready() { if (!this._mem) await this._load(); }
  _ensureCalendar(calendarId) { if (!this._mem.calendars[calendarId]) this._mem.calendars[calendarId] = []; }
  _list(calendarId) { this._ensureCalendar(calendarId); return this._mem.calendars[calendarId]; }

  async listProviders() {
    await this._ready();
    const calendars = Object.keys(this._mem.calendars).map((id) => ({ id, name: id === "household" ? "Household" : id }));
    return [{ provider: "local", calendars }];
  }

  _findIndexByExternalId(calendarId, externalId) {
    const list = this._list(calendarId);
    return list.findIndex((e) => e.externalId && e.externalId === externalId);
  }
  _findIndexById(calendarId, id) {
    const list = this._list(calendarId);
    return list.findIndex((e) => e.id === id);
  }
  _normalizeForReturn(calendarId, e) {
    return {
      id: e.id,
      htmlLink: e.htmlLink || "",
      start: e.start,
      end: e.end,
      summary: e.title || e.summary || "",
      provider: "local",
      calendarId,
      timezone: e.timezone || DEFAULT_TZ,
      externalId: e.externalId || null,
    };
  }

  async createEventsBatch({ calendarId = "household", events, upsert = true }) {
    await this._ready();
    const list = [];
    for (const raw of asArray(events)) {
      const nudged = maybeNudgeEvent(ensureTz(raw));
      this._ensureCalendar(calendarId);

      let idx = -1;
      if (upsert && nudged.externalId) idx = this._findIndexByExternalId(calendarId, nudged.externalId);

      if (idx >= 0) {
        const prev = this._mem.calendars[calendarId][idx];
        const updated = { ...prev, ...nudged, id: prev.id, updatedAt: toISO(new Date()) };
        this._mem.calendars[calendarId][idx] = updated;
        list.push(this._normalizeForReturn(calendarId, updated));
      } else {
        const id = nudged.externalId || `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const saved = { ...nudged, id, createdAt: toISO(new Date()), updatedAt: toISO(new Date()), htmlLink: "" };
        this._mem.calendars[calendarId].push(saved);
        list.push(this._normalizeForReturn(calendarId, saved));
      }
    }
    await this._flush();
    return list;
  }

  async createEvent({ calendarId = "household", data, upsert = true }) {
    const [one] = await this.createEventsBatch({ calendarId, events: [data], upsert });
    return one;
  }

  async deleteEvent({ calendarId = "household", eventId }) {
    await this._ready();
    const idx = this._findIndexById(calendarId, eventId);
    if (idx >= 0) {
      const [removed] = this._mem.calendars[calendarId].splice(idx, 1);
      await this._flush();
      return { deleted: true, id: removed.id };
    }
    return { deleted: false, id: eventId, reason: "not-found" };
  }

  // ------- Optional helpers for richer UX in dev/offline -------
  async deleteByExternalId({ calendarId = "household", externalId }) {
    await this._ready();
    const idx = this._findIndexByExternalId(calendarId, externalId);
    if (idx >= 0) {
      const [removed] = this._mem.calendars[calendarId].splice(idx, 1);
      await this._flush();
      return { deleted: true, id: removed.id, externalId };
    }
    return { deleted: false, externalId, reason: "not-found" };
  }

  async listEvents({ calendarId = "household", since, until, q, externalId } = {}) {
    await this._ready();
    let list = [...this._list(calendarId)];
    if (externalId) list = list.filter((e) => e.externalId === externalId);
    if (since) list = list.filter((e) => new Date(e.start) >= new Date(since));
    if (until) list = list.filter((e) => new Date(e.start) <= new Date(until));
    if (q) {
      const s = q.toLowerCase();
      list = list.filter((e) =>
        (e.title || "").toLowerCase().includes(s) ||
        (e.description || "").toLowerCase().includes(s) ||
        (e.location || "").toLowerCase().includes(s)
      );
    }
    return list.map((e) => this._normalizeForReturn(calendarId, e));
  }

  async exportIcs({ calendarId = "household", since, until } = {}) {
    await this._ready();
    const events = await this.listEvents({ calendarId, since, until });
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Suka Smart Assistant//Calendar//EN"
    ];
    for (const e of events) {
      const uid = e.id || e.externalId || `local-${Math.random().toString(36).slice(2)}`;
      lines.push(
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTART:${new Date(e.start).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`,
        `DTEND:${new Date(e.end).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`,
        `SUMMARY:${(e.summary || "").replace(/\n/g, "\\n")}`,
        "END:VEVENT"
      );
    }
    lines.push("END:VCALENDAR");
    const outPath = path.join(DATA_DIR, `export-${calendarId}-${Date.now()}.ics`);
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(outPath, lines.join("\r\n"));
    return { ok: true, file: outPath };
  }
}

/* ─────────────── Google Calendar Adapter (optional, lazy) ─────────────── */

let GoogleAdapter = null;
try {
  const { google } = await (async () => import("googleapis"))();
  GoogleAdapter = class {
    constructor() {
      const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
      const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
      const oauthJson = process.env.GOOGLE_OAUTH_JSON;

      if (clientEmail && key) {
        this.auth = new google.auth.JWT({
          email: clientEmail,
          key,
          scopes: ["https://www.googleapis.com/auth/calendar"],
        });
      } else if (oauthJson) {
        const creds = JSON.parse(oauthJson);
        this.auth = new google.auth.OAuth2(creds.client_id, creds.client_secret, creds.redirect_uris?.[0]);
        this.auth.setCredentials({ refresh_token: creds.refresh_token });
      } else {
        throw new Error("Missing Google credentials; falling back to Local");
      }
      this.gcal = google.calendar({ version: "v3", auth: this.auth });
    }

    async listProviders() {
      return [{ provider: "google", calendars: [{ id: "primary", name: "Primary" }] }];
    }

    _normalize(calendarId, g) {
      return {
        id: g.id,
        htmlLink: g.htmlLink || "",
        start: g.start?.dateTime || g.start?.date,
        end: g.end?.dateTime || g.end?.date,
        summary: g.summary || "",
        provider: "google",
        calendarId,
        timezone: g.start?.timeZone || DEFAULT_TZ,
        externalId: g.extendedProperties?.private?.externalId || null,
      };
    }

    _buildGoogleEvent(e0) {
      const e = maybeNudgeEvent(ensureTz(e0));
      const allDay = !!e.allDay;
      const start = allDay
        ? { date: e.start, timeZone: e.timezone || DEFAULT_TZ }
        : { dateTime: e.start, timeZone: e.timezone || DEFAULT_TZ };
      const end = allDay
        ? { date: e.end, timeZone: e.timezone || DEFAULT_TZ }
        : { dateTime: e.end, timeZone: e.timezone || DEFAULT_TZ };

      const reminders = Array.isArray(e.reminders)
        ? { useDefault: false, overrides: e.reminders.map(r => ({ method: r.method || "popup", minutes: r.minutes })) }
        : undefined;

      const attendees = Array.isArray(e.attendees)
        ? e.attendees.map(a => ({ email: a.email, displayName: a.name, optional: !!a.optional }))
        : undefined;

      return {
        summary: e.title,
        description: e.description,
        location: e.location,
        start,
        end,
        attendees,
        reminders,
        transparency: e.transparency === "transparent" ? "transparent" : "opaque",
        visibility: e.visibility || "default",
        extendedProperties: e.externalId ? { private: { externalId: e.externalId } } : undefined,
      };
    }

    async _findByExternalId(calendarId, externalId) {
      // Google lacks direct filter by extendedProperties; we fetch recent and scan.
      const res = await this.gcal.events.list({
        calendarId,
        maxResults: 100,
        singleEvents: true,
        orderBy: "startTime",
        timeMin: new Date(Date.now() - 365 * DAY).toISOString(),
      });
      const match = (res.data.items || []).find(
        (ev) => ev.extendedProperties?.private?.externalId === externalId
      );
      return match || null;
    }

    async createEventsBatch({ calendarId = "primary", events, upsert = true }) {
      const out = [];
      for (const raw of asArray(events)) {
        const e = ensureTz(raw);
        const body = this._buildGoogleEvent(e);

        const res = await withRetry(async () => {
          if (upsert && e.externalId) {
            const existing = await this._findByExternalId(calendarId, e.externalId);
            if (existing?.id) {
              const updated = await this.gcal.events.patch({ calendarId, eventId: existing.id, requestBody: body });
              return this._normalize(calendarId, updated.data);
            }
          }
          const created = await this.gcal.events.insert({ calendarId, requestBody: body });
          return this._normalize(calendarId, created.data);
        });
        out.push(res);
      }
      return out;
    }

    async createEvent({ calendarId = "primary", data, upsert = true }) {
      const [one] = await this.createEventsBatch({ calendarId, events: [data], upsert });
      return one;
    }

    async deleteEvent({ calendarId = "primary", eventId }) {
      await withRetry(() => this.gcal.events.delete({ calendarId, eventId }));
      return { deleted: true, id: eventId };
    }

    // Optional helpers (Google):
    async listEvents({ calendarId = "primary", since, until, q, externalId } = {}) {
      const res = await this.gcal.events.list({
        calendarId,
        q,
        timeMin: since ? new Date(since).toISOString() : undefined,
        timeMax: until ? new Date(until).toISOString() : undefined,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 2500
      });
      let items = res.data.items || [];
      if (externalId) items = items.filter((ev) => ev.extendedProperties?.private?.externalId === externalId);
      return items.map((g) => this._normalize(calendarId, g));
    }
  };
} catch {
  // googleapis not installed or creds missing
}

/* ────────── Microsoft Outlook / Graph Adapter (optional, lazy) ────────── */

let OutlookAdapter = null;
try {
  await (async () => import("isomorphic-fetch"))(); // polyfill
  const graphMod = await (async () => import("@microsoft/microsoft-graph-client"))();
  const { Client } = graphMod;
  const { ClientSecretCredential } = (await import("@azure/identity"));

  // For open extensions to emulate "externalId" upsert.
  const OPEN_EXT_NAME = "com.suka.externalId";

  OutlookAdapter = class {
    constructor() {
      const tenantId = process.env.MS_TENANT_ID;
      const clientId = process.env.MS_CLIENT_ID;
      const clientSecret = process.env.MS_CLIENT_SECRET;
      const userId = process.env.MS_USER_ID || "me";

      if (!tenantId || !clientId || !clientSecret) {
        throw new Error("Missing Microsoft Graph credentials; falling back to Local");
      }
      this.userId = userId;
      const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
      this.client = Client.init({
        authProvider: {
          getAccessToken: async () => {
            const token = await credential.getToken("https://graph.microsoft.com/.default");
            return token.token;
          },
        },
      });
    }

    async listProviders() {
      return [{ provider: "outlook", calendars: [{ id: "primary", name: "Default" }] }];
    }

    _normalize(calendarId, g) {
      // try to read our open extension value if present
      const ext = (g.extensions || []).find((x) => x.id === OPEN_EXT_NAME);
      return {
        id: g.id,
        htmlLink: g.webLink || "",
        start: g.start?.dateTime,
        end: g.end?.dateTime,
        summary: g.subject || "",
        provider: "outlook",
        calendarId,
        timezone: g.start?.timeZone || DEFAULT_TZ,
        externalId: ext?.externalId || null,
      };
    }

    _buildGraphEvent(e0) {
      const e = maybeNudgeEvent(ensureTz(e0));
      const tz = e.timezone || DEFAULT_TZ;
      const body = {
        subject: e.title,
        body: e.description ? { contentType: "text", content: e.description } : undefined,
        start: { dateTime: e.start, timeZone: tz },
        end: { dateTime: e.end, timeZone: tz },
        location: e.location ? { displayName: e.location } : undefined,
        attendees: Array.isArray(e.attendees)
          ? e.attendees.map((a) => ({ emailAddress: { address: a.email, name: a.name }, type: a.optional ? "optional" : "required" }))
          : undefined,
      };
      if (Array.isArray(e.reminders) && e.reminders.length > 0) {
        const first = e.reminders[0];
        body.isReminderOn = true;
        body.reminderMinutesBeforeStart = Math.max(0, Number(first.minutes) || 0);
      }
      return body;
    }

    async _findByExternalId(calendarId, externalId) {
      // Open extensions listing is limited; we fetch recent items and filter by extension.
      const resp = await this.client
        .api(`/users/${this.userId}/events`)
        .select("id,subject,webLink,start,end")
        .top(100)
        .get();

      const events = resp.value || [];
      // For each, fetch its open extensions in parallel (best-effort)
      const withExt = await Promise.all(events.map(async (ev) => {
        try {
          const ext = await this.client.api(`/users/${this.userId}/events/${ev.id}/extensions/${OPEN_EXT_NAME}`).get();
          return { ...ev, extensions: [ext] };
        } catch {
          return ev;
        }
      }));
      return withExt.find((ev) => (ev.extensions || []).some((x) => x.id === OPEN_EXT_NAME && x.externalId === externalId)) || null;
    }

    async _attachOpenExtension(eventId, externalId) {
      try {
        await this.client.api(`/users/${this.userId}/events/${eventId}/extensions`).post({
          "@odata.type": "microsoft.graph.openTypeExtension",
          extensionName: OPEN_EXT_NAME,
          externalId,
        });
      } catch {
        // ignore (insufficient perms or existing)
      }
    }

    async createEventsBatch({ calendarId = "primary", events, upsert = true }) {
      const out = [];
      for (const raw of asArray(events)) {
        const e = ensureTz(raw);
        const body = this._buildGraphEvent(e);

        const created = await withRetry(async () => {
          if (upsert && e.externalId) {
            const existing = await this._findByExternalId(calendarId, e.externalId);
            if (existing?.id) {
              // PATCH existing
              const updated = await this.client.api(`/users/${this.userId}/events/${existing.id}`).patch(body);
              await this._attachOpenExtension(existing.id, e.externalId);
              // read back updated
              const full = await this.client.api(`/users/${this.userId}/events/${existing.id}`).get();
              return this._normalize(calendarId, { ...full, extensions: [{ id: OPEN_EXT_NAME, externalId: e.externalId }] });
            }
          }
          const createdEv = await this.client.api(`/users/${this.userId}/events`).post(body);
          if (e.externalId) await this._attachOpenExtension(createdEv.id, e.externalId);
          // fetch with extension for normalization
          let full = createdEv;
          try {
            const ext = await this.client.api(`/users/${this.userId}/events/${createdEv.id}/extensions/${OPEN_EXT_NAME}`).get();
            full = { ...createdEv, extensions: [ext] };
          } catch {}
          return this._normalize(calendarId, full);
        });
        out.push(created);
      }
      return out;
    }

    async createEvent({ calendarId = "primary", data, upsert = true }) {
      const [one] = await this.createEventsBatch({ calendarId, events: [data], upsert });
      return one;
    }

    async deleteEvent({ calendarId = "primary", eventId }) {
      await withRetry(() => this.client.api(`/users/${this.userId}/events/${eventId}`).delete());
      return { deleted: true, id: eventId };
    }
  };
} catch {
  // Graph deps not installed or creds missing
}

/* ───────────────────────── Adapter selection ───────────────────────── */

const local = new LocalCalendar(LOCAL_DB);

function selectAdapter(provider) {
  const p = (provider || "local").toLowerCase();
  if (p === "google" && GoogleAdapter) {
    try { return new GoogleAdapter(); } catch { return local; }
  }
  if (p === "outlook" && OutlookAdapter) {
    try { return new OutlookAdapter(); } catch { return local; }
  }
  return local;
}

/* ───────────────────────────── Public API ───────────────────────────── */

/** Providers & calendars (best-effort) */
export async function listProviders() {
  const list = [];
  list.push(...(await local.listProviders()));
  if (GoogleAdapter) {
    try { list.push(...(await new GoogleAdapter().listProviders())); } catch {}
  }
  if (OutlookAdapter) {
    try { list.push(...(await new OutlookAdapter().listProviders())); } catch {}
  }
  return list;
}

/** Batch create/upsert */
export async function createEventsBatch({ provider = "local", calendarId, events, upsert = true }) {
  const adapter = selectAdapter(provider);
  return adapter.createEventsBatch({ calendarId, events, upsert });
}

/** Single create/upsert */
export async function createEvent({ provider = "local", calendarId, data, upsert = true }) {
  const adapter = selectAdapter(provider);
  return adapter.createEvent({ calendarId, data, upsert });
}

/** Delete by provider event id */
export async function deleteEvent({ provider = "local", calendarId, eventId }) {
  const adapter = selectAdapter(provider);
  return adapter.deleteEvent({ calendarId, eventId });
}

/* ───────────── Optional helpers (gracefully degrade if missing) ───────────── */

export async function listEvents({ provider = "local", calendarId, since, until, q, externalId } = {}) {
  const adapter = selectAdapter(provider);
  if (typeof adapter.listEvents === "function") return adapter.listEvents({ calendarId, since, until, q, externalId });
  // Fallback: Local supports; cloud may not — return empty to keep contract safe.
  return [];
}

export async function deleteByExternalId({ provider = "local", calendarId, externalId }) {
  const adapter = selectAdapter(provider);
  if (typeof adapter.deleteByExternalId === "function") return adapter.deleteByExternalId({ calendarId, externalId });
  return { deleted: false, externalId, reason: "not-supported" };
}

export async function exportIcs({ calendarId = "household", since, until } = {}) {
  if (typeof local.exportIcs === "function") return local.exportIcs({ calendarId, since, until });
  return { ok: false, error: "ICS export only available for local adapter" };
}

/* ───────────────────────── Default export (compat) ───────────────────────── */

export default {
  listProviders,
  createEventsBatch,
  createEvent,
  deleteEvent,
  // optional helpers:
  listEvents,
  deleteByExternalId,
  exportIcs,
};
