// src/server/db/models/ExecutionsLog.js
/**
 * ExecutionsLog
 * -------------
 * A flexible log for workflow/automation executions (e.g., n8n, batch jobs).
 *
 * Prefers Mongoose (MongoDB). If mongoose isn't installed/connected, a JSON
 * file fallback is used with the same exported API.
 *
 * Fields (core):
 *  - userId?: string
 *  - source: 'n8n' | 'automation' | 'job' | 'script' | string
 *  - type?: string                // domain/type label (e.g., 'mealplan', 'import')
 *  - workflowId?: string          // n8n workflow id, or job key
 *  - executionId: string          // external execution id or generated id
 *  - status: 'queued'|'running'|'success'|'error'|'canceled'
 *  - startedAt: Date
 *  - finishedAt?: Date
 *  - durationMs?: number
 *  - input?: any
 *  - output?: any
 *  - error?: { message, stack?, code?, data? }
 *  - tags?: string[]
 *  - meta?: any
 *
 * Statics:
 *  - logStart({ userId, source, type, workflowId, executionId?, input?, tags?, meta? })
 *  - logUpdate(executionId, patch)        // status/output/meta/tag adjustments
 *  - logFinish(executionId, output?, meta?)
 *  - logError(executionId, errorObj, meta?)
 *  - logCancel(executionId, meta?)
 *  - getByExecution(executionId)
 *  - listRecent({ limit, status?, source?, workflowId?, userId?, since?, to? })
 *  - listByWorkflow(workflowId, { limit })
 *  - summarize({ since?, to?, source?, workflowId?, userId? })
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

let mongoose = null;
try { mongoose = require('mongoose'); } catch (_) {}

const hasMongoose = !!mongoose;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function nowISO() { return new Date().toISOString(); }
function toISO(d) { try { return d ? new Date(d).toISOString() : null; } catch { return null; } }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function round(n, p = 2) { const m = 10 ** p; return Math.round((n + Number.EPSILON) * m) / m; }
function normExecId(x) { return String(x || `exec_${Date.now()}_${Math.floor(Math.random() * 1e6)}`); }
function pick(obj, keys) {
  const out = {};
  keys.forEach((k) => { if (obj[k] !== undefined) out[k] = obj[k]; });
  return out;
}

// ===========================================================================
// Mongoose Model (preferred)
// ===========================================================================
let MModel = null;

if (hasMongoose) {
  const ErrorSchema = new mongoose.Schema({
    message: String,
    stack: String,
    code: String,
    data: mongoose.Schema.Types.Mixed,
  }, { _id: false });

  const ExecSchema = new mongoose.Schema({
    userId: { type: String, index: true },
    source: { type: String, required: true, index: true },      // e.g., 'n8n'
    type:   { type: String, index: true },                       // e.g., 'mealplan'
    workflowId: { type: String, index: true },
    executionId: { type: String, required: true, unique: true, index: true },

    status: { type: String, enum: ['queued','running','success','error','canceled'], index: true, required: true, default: 'running' },
    startedAt: { type: Date, required: true, default: Date.now, index: true },
    finishedAt: { type: Date },
    durationMs: { type: Number },

    input: mongoose.Schema.Types.Mixed,
    output: mongoose.Schema.Types.Mixed,
    error: ErrorSchema,
    tags: [{ type: String, index: true }],
    meta: mongoose.Schema.Types.Mixed,
  }, { timestamps: true });

  ExecSchema.index({ source: 1, workflowId: 1, startedAt: -1 });
  ExecSchema.index({ userId: 1, startedAt: -1 });
  ExecSchema.index({ status: 1, startedAt: -1 });

  // ---- Statics ----

  ExecSchema.statics.logStart = async function logStart(data = {}) {
    const executionId = normExecId(data.executionId);
    const doc = new this({
      userId: data.userId || null,
      source: data.source || 'job',
      type: data.type || null,
      workflowId: data.workflowId || null,
      executionId,
      status: data.status || 'running',
      startedAt: toISO(data.startedAt) || new Date(),
      input: data.input || null,
      tags: Array.isArray(data.tags) ? data.tags : [],
      meta: data.meta || {},
    });
    return doc.save();
  };

  ExecSchema.statics.logUpdate = async function logUpdate(executionId, patch = {}) {
    const doc = await this.findOne({ executionId });
    if (!doc) return null;

    if (patch.status) doc.status = patch.status;
    if (patch.output !== undefined) doc.output = patch.output;
    if (patch.error !== undefined) doc.error = patch.error;
    if (patch.meta) doc.meta = { ...(doc.meta || {}), ...patch.meta };
    if (Array.isArray(patch.tags)) doc.tags = patch.tags;

    if (patch.finishedAt) doc.finishedAt = toISO(patch.finishedAt);
    if (patch.startedAt) doc.startedAt = toISO(patch.startedAt);

    // recompute duration if finish known
    if (doc.finishedAt && doc.startedAt) {
      const dur = new Date(doc.finishedAt) - new Date(doc.startedAt);
      doc.durationMs = clamp(dur, 0, 1000 * 60 * 60 * 24 * 14); // cap at 14 days
    }

    await doc.save();
    return doc;
  };

  ExecSchema.statics.logFinish = async function logFinish(executionId, output = null, meta = null) {
    const doc = await this.findOne({ executionId });
    if (!doc) return null;
    doc.status = 'success';
    doc.finishedAt = new Date();
    if (output !== undefined) doc.output = output;
    if (meta) doc.meta = { ...(doc.meta || {}), ...meta };
    if (doc.startedAt) doc.durationMs = new Date(doc.finishedAt) - new Date(doc.startedAt);
    await doc.save();
    return doc;
  };

  ExecSchema.statics.logError = async function logError(executionId, errorObj = {}, meta = null) {
    const doc = await this.findOne({ executionId });
    if (!doc) return null;
    doc.status = 'error';
    doc.finishedAt = new Date();
    doc.error = {
      message: String(errorObj.message || errorObj) || 'Execution error',
      stack: errorObj.stack || null,
      code: errorObj.code || null,
      data: errorObj.data || null,
    };
    if (meta) doc.meta = { ...(doc.meta || {}), ...meta };
    if (doc.startedAt) doc.durationMs = new Date(doc.finishedAt) - new Date(doc.startedAt);
    await doc.save();
    return doc;
  };

  ExecSchema.statics.logCancel = async function logCancel(executionId, meta = null) {
    const doc = await this.findOne({ executionId });
    if (!doc) return null;
    doc.status = 'canceled';
    doc.finishedAt = new Date();
    if (meta) doc.meta = { ...(doc.meta || {}), ...meta };
    if (doc.startedAt) doc.durationMs = new Date(doc.finishedAt) - new Date(doc.startedAt);
    await doc.save();
    return doc;
  };

  ExecSchema.statics.getByExecution = function getByExecution(executionId) {
    return this.findOne({ executionId });
  };

  ExecSchema.statics.listRecent = function listRecent({ limit = 50, status = null, source = null, workflowId = null, userId = null, since = null, to = null } = {}) {
    const q = {};
    if (status) q.status = status;
    if (source) q.source = source;
    if (workflowId) q.workflowId = workflowId;
    if (userId) q.userId = userId;
    if (since || to) q.startedAt = {};
    if (since) q.startedAt.$gte = toISO(since);
    if (to) q.startedAt.$lte = toISO(to);
    return this.find(q).sort({ startedAt: -1 }).limit(Math.max(1, Math.min(500, limit)));
  };

  ExecSchema.statics.listByWorkflow = function listByWorkflow(workflowId, { limit = 50 } = {}) {
    return this.find({ workflowId }).sort({ startedAt: -1 }).limit(Math.max(1, Math.min(500, limit)));
  };

  ExecSchema.statics.summarize = async function summarize({ since = null, to = null, source = null, workflowId = null, userId = null } = {}) {
    const match = {};
    if (since || to) match.startedAt = {};
    if (since) match.startedAt.$gte = toISO(since);
    if (to) match.startedAt.$lte = toISO(to);
    if (source) match.source = source;
    if (workflowId) match.workflowId = workflowId;
    if (userId) match.userId = userId;

    const agg = await this.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          avgDur: { $avg: '$durationMs' },
        },
      },
    ]);

    const summary = { total: 0, byStatus: {}, avgDurationMs: 0 };
    let totalDur = 0;
    let totalCnt = 0;
    agg.forEach((row) => {
      summary.byStatus[row._id] = row.count;
      summary.total += row.count;
      if (row.avgDur) { totalDur += row.avgDur * row.count; totalCnt += row.count; }
    });
    summary.avgDurationMs = totalCnt ? round(totalDur / totalCnt, 0) : 0;

    return summary;
  };

  MModel = mongoose.models.ExecutionsLog || mongoose.model('ExecutionsLog', ExecSchema);
}

// ===========================================================================
// File-based Fallback (same API)
// ===========================================================================
const DATA_DIR = path.resolve(__dirname, '../../../data');
const FILE_PATH = path.join(DATA_DIR, 'executionsLog.json');

async function ensureFile() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try { await fsp.access(FILE_PATH, fs.constants.F_OK); }
  catch { await fsp.writeFile(FILE_PATH, JSON.stringify({ items: [], updatedAt: nowISO() }, null, 2), 'utf8'); }
}

async function readDB() {
  await ensureFile();
  const raw = await fsp.readFile(FILE_PATH, 'utf8');
  try { return JSON.parse(raw); } catch { return { items: [], updatedAt: nowISO() }; }
}

async function writeDB(db) {
  const tmp = `${FILE_PATH}.tmp`;
  db.updatedAt = nowISO();
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
  await fsp.rename(tmp, FILE_PATH);
  return db;
}

const FileDAO = {
  async logStart(data = {}) {
    const db = await readDB();
    const executionId = normExecId(data.executionId);
    const doc = {
      userId: data.userId || null,
      source: data.source || 'job',
      type: data.type || null,
      workflowId: data.workflowId || null,
      executionId,
      status: data.status || 'running',
      startedAt: toISO(data.startedAt) || nowISO(),
      finishedAt: null,
      durationMs: null,
      input: data.input || null,
      output: null,
      error: null,
      tags: Array.isArray(data.tags) ? data.tags : [],
      meta: data.meta || {},
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    db.items.push(doc);
    await writeDB(db);
    return doc;
  },

  async logUpdate(executionId, patch = {}) {
    const db = await readDB();
    const doc = db.items.find((x) => x.executionId === executionId);
    if (!doc) return null;

    if (patch.status) doc.status = patch.status;
    if (patch.output !== undefined) doc.output = patch.output;
    if (patch.error !== undefined) doc.error = patch.error;
    if (patch.meta) doc.meta = { ...(doc.meta || {}), ...patch.meta };
    if (Array.isArray(patch.tags)) doc.tags = patch.tags;
    if (patch.finishedAt) doc.finishedAt = toISO(patch.finishedAt);
    if (patch.startedAt) doc.startedAt = toISO(patch.startedAt);

    if (doc.finishedAt && doc.startedAt) {
      const dur = new Date(doc.finishedAt) - new Date(doc.startedAt);
      doc.durationMs = clamp(dur, 0, 1000 * 60 * 60 * 24 * 14);
    }

    doc.updatedAt = nowISO();
    await writeDB(db);
    return doc;
  },

  async logFinish(executionId, output = null, meta = null) {
    const db = await readDB();
    const doc = db.items.find((x) => x.executionId === executionId);
    if (!doc) return null;
    doc.status = 'success';
    doc.finishedAt = nowISO();
    if (output !== undefined) doc.output = output;
    if (meta) doc.meta = { ...(doc.meta || {}), ...meta };
    if (doc.startedAt) doc.durationMs = new Date(doc.finishedAt) - new Date(doc.startedAt);
    doc.updatedAt = nowISO();
    await writeDB(db);
    return doc;
  },

  async logError(executionId, errorObj = {}, meta = null) {
    const db = await readDB();
    const doc = db.items.find((x) => x.executionId === executionId);
    if (!doc) return null;
    doc.status = 'error';
    doc.finishedAt = nowISO();
    doc.error = {
      message: String(errorObj.message || errorObj) || 'Execution error',
      stack: errorObj.stack || null,
      code: errorObj.code || null,
      data: errorObj.data || null,
    };
    if (meta) doc.meta = { ...(doc.meta || {}), ...meta };
    if (doc.startedAt) doc.durationMs = new Date(doc.finishedAt) - new Date(doc.startedAt);
    doc.updatedAt = nowISO();
    await writeDB(db);
    return doc;
  },

  async logCancel(executionId, meta = null) {
    const db = await readDB();
    const doc = db.items.find((x) => x.executionId === executionId);
    if (!doc) return null;
    doc.status = 'canceled';
    doc.finishedAt = nowISO();
    if (meta) doc.meta = { ...(doc.meta || {}), ...meta };
    if (doc.startedAt) doc.durationMs = new Date(doc.finishedAt) - new Date(doc.startedAt);
    doc.updatedAt = nowISO();
    await writeDB(db);
    return doc;
  },

  async getByExecution(executionId) {
    const db = await readDB();
    return db.items.find((x) => x.executionId === executionId) || null;
  },

  async listRecent({ limit = 50, status = null, source = null, workflowId = null, userId = null, since = null, to = null } = {}) {
    const db = await readDB();
    let arr = db.items.slice();
    if (status) arr = arr.filter((x) => x.status === status);
    if (source) arr = arr.filter((x) => x.source === source);
    if (workflowId) arr = arr.filter((x) => x.workflowId === workflowId);
    if (userId) arr = arr.filter((x) => x.userId === userId);
    if (since) arr = arr.filter((x) => new Date(x.startedAt) >= new Date(since));
    if (to) arr = arr.filter((x) => new Date(x.startedAt) <= new Date(to));
    arr.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    return arr.slice(0, Math.max(1, Math.min(500, limit)));
  },

  async listByWorkflow(workflowId, { limit = 50 } = {}) {
    const db = await readDB();
    let arr = db.items.filter((x) => x.workflowId === workflowId);
    arr.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    return arr.slice(0, Math.max(1, Math.min(500, limit)));
  },

  async summarize({ since = null, to = null, source = null, workflowId = null, userId = null } = {}) {
    const items = await this.listRecent({ limit: 10_000, since, to, source, workflowId, userId });
    const summary = { total: items.length, byStatus: {}, avgDurationMs: 0 };
    let durSum = 0; let durCnt = 0;
    items.forEach((it) => {
      summary.byStatus[it.status] = (summary.byStatus[it.status] || 0) + 1;
      if (typeof it.durationMs === 'number') { durSum += it.durationMs; durCnt += 1; }
    });
    summary.avgDurationMs = durCnt ? round(durSum / durCnt, 0) : 0;
    return summary;
  },
};

// ===========================================================================
// Unified Export
// ===========================================================================
const ExecutionsLog = MModel || FileDAO;

module.exports = ExecutionsLog;
module.exports.default = ExecutionsLog;
module.exports.__driver = hasMongoose ? 'mongoose' : 'file';
