// src/utils/timeUtils.js

/**
 * Convert minutes into a "X hr Y min" format
 * @param {number} minutes
 * @returns {string}
 */
export function formatDuration(minutes = 0) {
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hrs > 0 ? `${hrs} hr${hrs > 1 ? "s" : ""}` : ""}${hrs && mins ? " " : ""}${
    mins > 0 ? `${mins} min` : ""
  }`.trim();
}

/**
 * Convert ISO or Date to "Monday, Jan 1 at 2:30 PM" format
 * @param {string|Date} time
 * @returns {string}
 */
export function formatReadableTime(time) {
  const options = {
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };
  return new Date(time).toLocaleString(undefined, options);
}

/**
 * Add minutes to a time (Date or ISO string)
 * @param {Date|string} time
 * @param {number} minutes
 * @returns {Date}
 */
export function addMinutes(time, minutes) {
  const date = new Date(time);
  date.setMinutes(date.getMinutes() + minutes);
  return date;
}

/**
 * Compare two times and return difference in minutes
 * @param {Date|string} a
 * @param {Date|string} b
 * @returns {number}
 */
export function diffInMinutes(a, b) {
  const t1 = new Date(a).getTime();
  const t2 = new Date(b).getTime();
  return Math.floor((t2 - t1) / 60000);
}

/**
 * Generate recurring schedule timestamps (daily/weekly/etc.)
 * @param {Object} config - { startTime, interval, unit, count }
 * @returns {Array<Date>}
 */
export function generateRecurringTimestamps({
  startTime = new Date(),
  interval = 1,
  unit = "day", // "minute" | "hour" | "day" | "week"
  count = 5,
}) {
  const intervals = {
    minute: 60000,
    hour: 3600000,
    day: 86400000,
    week: 604800000,
  };

  const results = [];
  const start = new Date(startTime).getTime();
  const increment = intervals[unit] * interval;

  for (let i = 0; i < count; i++) {
    results.push(new Date(start + i * increment));
  }

  return results;
}

/**
 * Format time as HH:MM for display
 * @param {Date|string} time
 * @returns {string}
 */
export function formatTimeOnly(time) {
  const date = new Date(time);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Check if a reminder is due within the next X minutes
 * @param {Date|string} targetTime
 * @param {number} withinMinutes
 * @returns {boolean}
 */
export function isReminderDueSoon(targetTime, withinMinutes = 15) {
  const now = new Date();
  const target = new Date(targetTime);
  const diff = (target - now) / 60000;
  return diff >= 0 && diff <= withinMinutes;
}
