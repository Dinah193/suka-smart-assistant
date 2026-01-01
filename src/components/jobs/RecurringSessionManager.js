// src/components/jobs/RecurringSessionManager.js

/**
 * Generates recurring service session entries.
 * @param {Object} booking - Booking object containing details.
 * @param {string} booking.provider - Provider name
 * @param {string} booking.serviceType - Type of service
 * @param {string} booking.startDate - ISO string or 'YYYY-MM-DD'
 * @param {string} booking.time - 24h format string 'HH:MM'
 * @param {string} booking.frequency - 'weekly' | 'biweekly' | 'monthly'
 * @param {string} booking.notes - Optional instructions
 * @param {number} [count=12] - Number of sessions to generate
 * @returns {Array<Object>} List of scheduled sessions
 */
function generateRecurringSessions(booking, count = 12) {
  const {
    provider,
    serviceType,
    startDate,
    time,
    frequency,
    notes,
  } = booking;

  const sessions = [];
  const baseDate = new Date(`${startDate}T${time}`);

  const frequencyMap = {
    weekly: 7,
    biweekly: 14,
    monthly: 30,
  };

  const intervalDays = frequencyMap[frequency] || 7;

  for (let i = 0; i < count; i++) {
    const sessionDate = new Date(baseDate);
    sessionDate.setDate(baseDate.getDate() + i * intervalDays);

    sessions.push({
      id: `${provider}-${serviceType}-${i + 1}`,
      date: sessionDate.toISOString().split("T")[0],
      time,
      provider,
      serviceType,
      notes,
      status: "scheduled",
    });
  }

  return sessions;
}

/**
 * Filters upcoming sessions by today’s date
 * @param {Array<Object>} sessions
 * @returns {Array<Object>} Sorted list of upcoming sessions
 */
function getUpcomingSessions(sessions) {
  const today = new Date();
  return sessions
    .filter((s) => new Date(`${s.date}T${s.time}`) >= today)
    .sort(
      (a, b) =>
        new Date(`${a.date}T${a.time}`) - new Date(`${b.date}T${b.time}`)
    );
}

/**
 * Formats a session into human-readable string
 * @param {Object} session
 * @returns {string}
 */
function formatSession(session) {
  return `${session.serviceType} with ${session.provider} on ${session.date} at ${session.time}`;
}

// ✅ Default export
export default {
  generateRecurringSessions,
  getUpcomingSessions,
  formatSession,
};
