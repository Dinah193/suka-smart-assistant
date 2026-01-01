// src/server/db/models/CookingHistory.js
/**
 * CookingHistory Model
 * --------------------
 * Flexible model that prefers Mongoose (MongoDB) but falls back to a JSON file.
 *
 * Schema (high level):
 *  - userId, sessionId, title, batch, status, startedAt, finishedAt
 *  - recipes: [{ recipeId, title, portions, tags, steps:[{ stepId, idx, text, status, startedAt, finishedAt, durationMs }] }]
 *  - events: [{ ts, type, payload }]
 *  - timers: [{ id, label, minutes, startedAt, finishedAt, status }]
 *  - notes: [{ at, text, meta }]
 *  - labels: [{ at, filePath, count, templateId }]
 *  - inventoryDeltas: [{ at, name, qty, unit }]
 *
 * API (common to Mongoose and FileDAO):
 *  - startSession(data)
 *  - finishSession(sessionId, patch)
 *  - recordEvent(sessionId, type, payload)
 *  - addNote(sessionId, text, meta)
 *  - addInventoryDelta(sessionId, line)       // {name, qty, unit, at?}
 *  - addLabelRecord(sessionId, rec)           // {filePath, count, templateId, at?}
 *  - appendSteps(sessionId, recipeId, steps[]) // attach missing steps
 *  - getBySession(sessionId)
 *  - listByUser(userId, {limit, since, to, status})
 *  - getUserSummary(userId, {since, to})
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

// ---------- Optional Mongoose ----------
let mongoose = null;
try { mongoose = require('mongoose'); } catch (_) {}
const hasMongoose = !!mongoose;

// ---------- Shared helpers ----------
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function nowISO() { return new Date().toISOString(); }
function toISO(x) { try { return x ? new Date(x).toISOString() : null; } catch { return null; } }
function pick(obj, keys) {
  const out = {};
  keys.forEach(k => { if (obj[k] !== undefined) out[k] = obj[k]; });
  return out;
}

// ============================================================================
// MONGOOSE MODEL (preferred)
// ============================================================================
let MModel = null;

if (hasMongoose) {
  const StepSchema = new mongoose.Schema({
    stepId: { type: String, index: true },
    idx: Number,
    text: String,
    status: { type: String, enum: ['pending','in_progress','done','skipped'], default: 'pending' },
    startedAt: Date,
    finishedAt: Date,
    durationMs: Number,
    notes: [{ at: Date, text: String }],
  }, { _id: false });

  const RecipeSchema = new mongoose.Schema({
    recipeId: { type: String, index: true },
    title: String,
    portions: Number,
    tags: [String],
    steps: [StepSchema],
  }, { _id: false });

  const EventSchema = new mongoose.Schema({
    ts: { type: Date, default: Date.now, index: true },
    type: { type: String, index: true },
    payload: mongoose.Schema.Types.Mixed,
  }, { _id: false });

  const TimerSchema = new mongoose.Schema({
    id: { type: String, index: true },
    label: String,
    minutes: Number,
    startedAt: Date,
    finishedAt: Date,
    status: { type: String, enum: ['running','paused','done','canceled'], default: 'running' },
  }, { _id: false });

  const LabelSchema = new mongoose.Schema({
    at: { type: Date, default: Date.now },
    filePath: String,
    count: Number,
    templateId: String,
  }, { _id: false });

  const InvDeltaSchema = new mongoose.Schema({
    at: { type: Date, default: Date.now },
    name: String,
    qty: Number,
    unit: String,
  }, { _id: false });

  const CookingHistorySchema = new mongoose.Schema({
    userId: { type: String, index: true, required: true },
    sessionId: { type: String, unique: true, index: true, required: true },
    title: String,
    batch: { type: Boolean, default: false },
    status: { type: String, enum: ['active','done','canceled'], default: 'active', index: true },
    startedAt: { type: Date, default: Date.now, index: true },
    finishedAt: { type: Date },
    durationMin: Number,

    recipes: [RecipeSchema],
    events: [EventSchema],
    timers: [TimerSchema],
    notes: [{ at: { type: Date, default: Date.now }, text: String, meta: mongoose.Schema.Types.Mixed }],
    labels: [LabelSchema],
    inventoryDeltas: [InvDeltaSchema],

    meta: mongoose.Schema.Types.Mixed,
  }, { timestamps: true });

  CookingHistorySchema.index({ userId: 1, startedAt: -1 });
  CookingHistorySchema.index({ title: 'text' });

  // ---- Statics ----
  CookingHistorySchema.statics.startSession = async function startSession(data) {
    const doc = new this({
      userId: data.userId,
      sessionId: data.sessionId,
      title: data.title || 'Cooking Session',
      batch: !!data.batch,
      status: 'active',
      startedAt: toISO(data.startedAt) || new Date(),
      recipes: data.recipes || [],
      meta: data.meta || {},
    });
    return doc.save();
  };

  CookingHistorySchema.statics.finishSession = async function finishSession(sessionId, patch = {}) {
    const doc = await this.findOne({ sessionId });
    if (!doc) return null;
    doc.status = patch.status || 'done';
    doc.finishedAt = toISO(patch.finishedAt) || new Date();
    const dur = (doc.finishedAt - (doc.startedAt || new Date())) / 60000;
    doc.durationMin = clamp(Math.round(dur), 0, 24 * 60);
    if (Array.isArray(patch.timers)) doc.timers.push(...patch.timers);
    if (Array.isArray(patch.events)) doc.events.push(...patch.events);
    if (Array.isArray(patch.labels)) doc.labels.push(...patch.labels);
    if (Array.isArray(patch.inventoryDeltas)) doc.inventoryDeltas.push(...patch.inventoryDeltas);
    if (patch.meta) doc.meta = { ...(doc.meta || {}), ...patch.meta };
    await doc.save();
    return doc;
  };

  CookingHistorySchema.statics.recordEvent = async function recordEvent(sessionId, type, payload = {}) {
    return this.findOneAndUpdate(
      { sessionId },
      { $push: { events: { ts: new Date(), type, payload } } },
      { new: true },
    );
  };

  CookingHistorySchema.statics.addNote = async function addNote(sessionId, text, meta = {}) {
    return this.findOneAndUpdate(
      { sessionId },
      { $push: { notes: { at: new Date(), text, meta } } },
      { new: true },
    );
  };

  CookingHistorySchema.statics.addInventoryDelta = async function addInventoryDelta(sessionId, line) {
    const rec = { at: toISO(line.at) || new Date(), name: line.name, qty: Number(line.qty || 0), unit: line.unit || '' };
    return this.findOneAndUpdate(
      { sessionId },
      { $push: { inventoryDeltas: rec } },
      { new: true },
    );
  };

  CookingHistorySchema.statics.addLabelRecord = async function addLabelRecord(sessionId, rec) {
    const val = { at: toISO(rec.at) || new Date(), filePath: rec.filePath || null, count: Number(rec.count || 0), templateId: rec.templateId || null };
    return this.findOneAndUpdate(
      { sessionId },
      { $push: { labels: val } },
      { new: true },
    );
  };

  CookingHistorySchema.statics.appendSteps = async function appendSteps(sessionId, recipeId, steps = []) {
    const doc = await this.findOne({ sessionId });
    if (!doc) return null;
    const r = (doc.recipes || []).find(x => x.recipeId === recipeId);
    if (!r) return null;
    const existing = new Set((r.steps || []).map(s => s.stepId));
    (steps || []).forEach(s => {
      if (!existing.has(s.stepId)) r.steps.push(s);
    });
    await doc.save();
    return doc;
  };

  CookingHistorySchema.statics.getBySession = async function getBySession(sessionId) {
    return this.findOne({ sessionId });
  };

  CookingHistorySchema.statics.listByUser = async function listByUser(userId, { limit = 50, since = null, to = null, status = null } = {}) {
    const q = { userId };
    if (status) q.status = status;
    if (since || to) q.startedAt = {};
    if (since) q.startedAt.$gte = toISO(since);
    if (to) q.startedAt.$lte = toISO(to);
    return this.find(q).sort({ startedAt: -1 }).limit(Math.max(1, Math.min(500, limit)));
  };

  CookingHistorySchema.statics.getUserSummary = async function getUserSummary(userId, { since = null, to = null } = {}) {
    const match = { userId };
    if (since || to) match.startedAt = {};
    if (since) match.startedAt.$gte = toISO(since);
    if (to) match.startedAt.$lte = toISO(to);

    const agg = await this.aggregate([
      { $match: match },
      {
        $project: {
          durationMin: 1,
          recipesCount: { $size: { $ifNull: ['$recipes', []] } },
          startedAt: 1,
          titles: '$recipes.title',
        },
      },
      {
        $group: {
          _id: null,
          sessions: { $sum: 1 },
          minutes: { $sum: '$durationMin' },
          recipes: { $sum: '$recipesCount' },
        },
      },
    ]);
    const base = agg[0] || { sessions: 0, minutes: 0, recipes: 0 };
    return {
      userId,
      sessions: base.sessions || 0,
      totalMinutes: base.minutes || 0,
      totalRecipes: base.recipes || 0,
      since: since ? toISO(since) : null,
      to: to ? toISO(to) : null,
    };
  };

  MModel = mongoose.models.CookingHistory || mongoose.model('CookingHistory', CookingHistorySchema);
}

// ============================================================================
// FILE-BASED FALLBACK DAO (same API)
// ============================================================================
const DATA_DIR = path.resolve(__dirname, '../../../data');
const FILE_PATH = path.join(DATA_DIR, 'cookingHistory.json');

async function ensureFile() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try { await fsp.access(FILE_PATH, fs.constants.F_OK); }
  catch { await fsp.writeFile(FILE_PATH, JSON.stringify({ items: [], updatedAt: nowISO() }, null, 2), 'utf8'); }
}

async function readFileDB() {
  await ensureFile();
  const raw = await fsp.readFile(FILE_PATH, 'utf8');
  try { return JSON.parse(raw); } catch { return { items: [], updatedAt: nowISO() }; }
}

async function writeFileDB(db) {
  const tmp = `${FILE_PATH}.tmp`;
  db.updatedAt = nowISO();
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
  await fsp.rename(tmp, FILE_PATH);
  return db;
}

const FileDAO = {
  async startSession(data) {
    const db = await readFileDB();
    const doc = {
      userId: data.userId,
      sessionId: data.sessionId,
      title: data.title || 'Cooking Session',
      batch: !!data.batch,
      status: 'active',
      startedAt: toISO(data.startedAt) || nowISO(),
      finishedAt: null,
      durationMin: null,
      recipes: data.recipes || [],
      events: [],
      timers: [],
      notes: [],
      labels: [],
      inventoryDeltas: [],
      meta: data.meta || {},
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    db.items.push(doc);
    await writeFileDB(db);
    return doc;
  },

  async finishSession(sessionId, patch = {}) {
    const db = await readFileDB();
    const doc = db.items.find(x => x.sessionId === sessionId);
    if (!doc) return null;
    doc.status = patch.status || 'done';
    doc.finishedAt = toISO(patch.finishedAt) || nowISO();
    const dur = (new Date(doc.finishedAt) - new Date(doc.startedAt)) / 60000;
    doc.durationMin = clamp(Math.round(dur), 0, 24 * 60);
    if (Array.isArray(patch.timers)) doc.timers.push(...patch.timers);
    if (Array.isArray(patch.events)) doc.events.push(...patch.events);
    if (Array.isArray(patch.labels)) doc.labels.push(...patch.labels);
    if (Array.isArray(patch.inventoryDeltas)) doc.inventoryDeltas.push(...patch.inventoryDeltas);
    if (patch.meta) doc.meta = { ...(doc.meta || {}), ...patch.meta };
    doc.updatedAt = nowISO();
    await writeFileDB(db);
    return doc;
  },

  async recordEvent(sessionId, type, payload = {}) {
    const db = await readFileDB();
    const doc = db.items.find(x => x.sessionId === sessionId);
    if (!doc) return null;
    doc.events.push({ ts: nowISO(), type, payload });
    doc.updatedAt = nowISO();
    await writeFileDB(db);
    return doc;
  },

  async addNote(sessionId, text, meta = {}) {
    const db = await readFileDB();
    const doc = db.items.find(x => x.sessionId === sessionId);
    if (!doc) return null;
    doc.notes.push({ at: nowISO(), text, meta });
    doc.updatedAt = nowISO();
    await writeFileDB(db);
    return doc;
  },

  async addInventoryDelta(sessionId, line) {
    const db = await readFileDB();
    const doc = db.items.find(x => x.sessionId === sessionId);
    if (!doc) return null;
    doc.inventoryDeltas.push({ at: toISO(line.at) || nowISO(), name: line.name, qty: Number(line.qty || 0), unit: line.unit || '' });
    doc.updatedAt = nowISO();
    await writeFileDB(db);
    return doc;
  },

  async addLabelRecord(sessionId, rec) {
    const db = await readFileDB();
    const doc = db.items.find(x => x.sessionId === sessionId);
    if (!doc) return null;
    doc.labels.push({ at: toISO(rec.at) || nowISO(), filePath: rec.filePath || null, count: Number(rec.count || 0), templateId: rec.templateId || null });
    doc.updatedAt = nowISO();
    await writeFileDB(db);
    return doc;
  },

  async appendSteps(sessionId, recipeId, steps = []) {
    const db = await readFileDB();
    const doc = db.items.find(x => x.sessionId === sessionId);
    if (!doc) return null;
    const r = (doc.recipes || []).find(x => x.recipeId === recipeId);
    if (!r) return null;
    const existing = new Set((r.steps || []).map(s => s.stepId));
    (steps || []).forEach(s => { if (!existing.has(s.stepId)) r.steps.push(s); });
    doc.updatedAt = nowISO();
    await writeFileDB(db);
    return doc;
  },

  async getBySession(sessionId) {
    const db = await readFileDB();
    return db.items.find(x => x.sessionId === sessionId) || null;
  },

  async listByUser(userId, { limit = 50, since = null, to = null, status = null } = {}) {
    const db = await readFileDB();
    let arr = db.items.filter(x => x.userId === userId);
    if (status) arr = arr.filter(x => x.status === status);
    if (since) arr = arr.filter(x => new Date(x.startedAt) >= new Date(since));
    if (to) arr = arr.filter(x => new Date(x.startedAt) <= new Date(to));
    arr.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    return arr.slice(0, Math.max(1, Math.min(500, limit)));
  },

  async getUserSummary(userId, { since = null, to = null } = {}) {
    const items = await this.listByUser(userId, { limit: 10000, since, to });
    const sessions = items.length;
    const minutes = items.reduce((s, it) => s + (it.durationMin || 0), 0);
    const recipes = items.reduce((s, it) => s + ((it.recipes || []).length), 0);
    return {
      userId,
      sessions,
      totalMinutes: minutes,
      totalRecipes: recipes,
      since: since ? toISO(since) : null,
      to: to ? toISO(to) : null,
    };
  },
};

// ============================================================================
// EXPORT UNIFIED INTERFACE
// ============================================================================
const CookingHistory = MModel || FileDAO;

module.exports = CookingHistory;
module.exports.default = CookingHistory;

// Also export a tiny helper to detect backend mode (db vs file), if useful
module.exports.__driver = hasMongoose ? 'mongoose' : 'file';
