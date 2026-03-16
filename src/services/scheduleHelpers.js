// src/services/scheduleHelpers.js
// Default no-op guard helpers. Domain adapters can replace these in runtime.

export function isSabbath() {
  return false;
}

export function inQuietHours() {
  return false;
}

export function nextUnquiet() {
  return null;
}

export function withholdsForDomain() {
  return [];
}

export default {
  isSabbath,
  inQuietHours,
  nextUnquiet,
  withholdsForDomain,
};
