// src/utils/calendarUtils.js

import { format, addDays, subDays, isSameDay, isToday, parseISO } from "date-fns";

/**
 * Format a date string or object to human-readable label.
 * @param {string|Date} date 
 * @returns {string}
 */
export function formatDateLabel(date) {
  const parsed = typeof date === "string" ? parseISO(date) : date;
  return format(parsed, "EEEE, MMMM d, yyyy");
}

/**
 * Create a range of days for a week view, centered on today or given day.
 * @param {Date} centerDate 
 * @param {number} totalDays 
 * @returns {Date[]}
 */
export function generateWeekRange(centerDate = new Date(), totalDays = 7) {
  const half = Math.floor(totalDays / 2);
  return Array.from({ length: totalDays }, (_, i) => {
    const offset = i - half;
    return addDays(centerDate, offset);
  });
}

/**
 * Check if a given session (cleaning/cooking/etc.) is scheduled for today.
 * @param {Object} session - session object with date property
 * @returns {boolean}
 */
export function isSessionToday(session) {
  if (!session?.date) return false;
  return isToday(parseISO(session.date));
}

/**
 * Get upcoming events within N days from now.
 * @param {Array} allEvents 
 * @param {number} daysAhead 
 * @returns {Array}
 */
export function getUpcomingEvents(allEvents = [], daysAhead = 3) {
  const now = new Date();
  const futureLimit = addDays(now, daysAhead);

  return allEvents.filter(event => {
    const eventDate = parseISO(event.date);
    return eventDate >= now && eventDate <= futureLimit;
  });
}

/**
 * Group sessions or tasks by day.
 * @param {Array} sessions - Array of { date: string }
 * @returns {Object} - { "2025-06-21": [session, session] }
 */
export function groupByDay(sessions = []) {
  return sessions.reduce((acc, session) => {
    const day = format(parseISO(session.date), "yyyy-MM-dd");
    if (!acc[day]) acc[day] = [];
    acc[day].push(session);
    return acc;
  }, {});
}

/**
 * Shift all events by days (e.g. for rescheduling a week).
 * @param {Array} sessions 
 * @param {number} days 
 * @returns {Array}
 */
export function shiftDates(sessions, days) {
  return sessions.map(session => {
    const newDate = addDays(parseISO(session.date), days);
    return { ...session, date: newDate.toISOString().split("T")[0] };
  });
}
