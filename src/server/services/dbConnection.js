"use strict";

let mongoose = null;
try {
  mongoose = require("mongoose");
} catch {
  mongoose = null;
}

const state = {
  driver: mongoose ? "mongoose" : "file",
  connected: false,
  readyState: 0,
  uriConfigured: false,
  fallbackFileMode: true,
  lastError: null,
};

let warnedMissingDriver = false;
let warnedMissingUri = false;

function resolveMongoUri() {
  return (
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.MONGO_URL ||
    ""
  ).trim();
}

function refreshStateFromMongoose() {
  if (!mongoose?.connection) return;
  state.readyState = Number(mongoose.connection.readyState || 0);
  state.connected = state.readyState === 1;
}

function getStatus() {
  refreshStateFromMongoose();
  return {
    driver: state.driver,
    connected: state.connected,
    readyState: state.readyState,
    uriConfigured: state.uriConfigured,
    fallbackFileMode: state.fallbackFileMode,
    lastError: state.lastError,
  };
}

async function init() {
  state.lastError = null;

  const mongoUri = resolveMongoUri();
  state.uriConfigured = !!mongoUri;

  if (!mongoose) {
    state.driver = "file";
    state.connected = false;
    state.readyState = 0;
    state.fallbackFileMode = true;
    if (!warnedMissingDriver) {
      warnedMissingDriver = true;
      console.warn("[db] mongoose is not installed; using file-fallback model behavior");
    }
    return getStatus();
  }

  state.driver = "mongoose";

  if (!mongoUri) {
    refreshStateFromMongoose();
    state.fallbackFileMode = !state.connected;
    if (!warnedMissingUri) {
      warnedMissingUri = true;
      console.warn("[db] MONGODB_URI/MONGO_URI not set; using file-fallback model behavior");
    }
    return getStatus();
  }

  if (mongoose.connection?.readyState === 1) {
    state.connected = true;
    state.readyState = 1;
    state.fallbackFileMode = false;
    return getStatus();
  }

  try {
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 2000),
      maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 10),
    });
    refreshStateFromMongoose();
    state.fallbackFileMode = false;
    console.log("[db] MongoDB connected");
  } catch (err) {
    state.lastError = String(err?.message || err || "mongo_connect_failed");
    state.connected = false;
    state.readyState = Number(mongoose.connection?.readyState || 0);
    state.fallbackFileMode = true;
    console.warn(`[db] MongoDB connection failed; using file-fallback model behavior: ${state.lastError}`);
  }

  return getStatus();
}

async function close() {
  if (!mongoose?.connection) return;
  if (mongoose.connection.readyState !== 1) return;
  await mongoose.connection.close();
  refreshStateFromMongoose();
  state.fallbackFileMode = true;
}

module.exports = {
  init,
  close,
  getStatus,
};
