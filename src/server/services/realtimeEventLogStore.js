"use strict";

const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function createInMemoryEventLogStore() {
  const entries = [];
  const checkpoints = new Map();

  return {
    kind: "memory",
    append(record = {}) {
      const entry = {
        id: record.id || uuidv4(),
        ts: record.ts || new Date().toISOString(),
        kind: String(record.kind || "unknown"),
        payload: record.payload || {},
      };
      entries.push(entry);
      return { ok: true, entry };
    },
    readAll() {
      return entries.slice();
    },
    getCheckpoint(key) {
      return checkpoints.get(String(key)) || null;
    },
    setCheckpoint(key, value) {
      checkpoints.set(String(key), value || null);
      return { ok: true };
    },
    clear() {
      entries.length = 0;
      checkpoints.clear();
    },
  };
}

function createFileEventLogStore({ logFilePath, checkpointFilePath } = {}) {
  const logPath = path.resolve(logFilePath || path.resolve(process.cwd(), ".tmp/realtime-event-log.jsonl"));
  const checkpointsPath = path.resolve(
    checkpointFilePath || path.resolve(process.cwd(), ".tmp/realtime-event-log.checkpoints.json"),
  );

  function readCheckpoints() {
    return safeReadJson(checkpointsPath, {});
  }

  function writeCheckpoints(next) {
    ensureDir(checkpointsPath);
    fs.writeFileSync(checkpointsPath, JSON.stringify(next || {}, null, 2), "utf8");
  }

  return {
    kind: "file",
    append(record = {}) {
      const entry = {
        id: record.id || uuidv4(),
        ts: record.ts || new Date().toISOString(),
        kind: String(record.kind || "unknown"),
        payload: record.payload || {},
      };
      ensureDir(logPath);
      fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
      return { ok: true, entry };
    },
    readAll() {
      try {
        if (!fs.existsSync(logPath)) return [];
        const raw = fs.readFileSync(logPath, "utf8");
        const lines = raw.split(/\r?\n/).filter(Boolean);
        const out = [];
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === "object") out.push(parsed);
          } catch {
            // skip malformed lines
          }
        }
        return out;
      } catch {
        return [];
      }
    },
    getCheckpoint(key) {
      const map = readCheckpoints();
      return map[String(key)] || null;
    },
    setCheckpoint(key, value) {
      const map = readCheckpoints();
      map[String(key)] = value || null;
      writeCheckpoints(map);
      return { ok: true };
    },
  };
}

module.exports = {
  createInMemoryEventLogStore,
  createFileEventLogStore,
};
