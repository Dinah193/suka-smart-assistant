// src/stores/scheduler/prefs.js
// Lightweight scheduler prefs accessor used by scheduler/safety modules.

const DEFAULT_PREFS = {
  user: { locale: "en-US", timeZone: "America/Chicago" },
  quietHours: { enabled: false, start: "22:00", end: "06:00" },
  sabbathGuard: { enabled: false },
  safety: {
    softLeadMs: 2 * 60 * 1000,
    hardGraceMs: 60 * 1000,
    cooldownMs: 45 * 1000,
    minTickMs: 5000,
  },
};

export function getSchedulerPrefs() {
  return DEFAULT_PREFS;
}

export default { getSchedulerPrefs };
