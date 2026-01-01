// src/automation/n8nBridge.js
import { triggerFlow } from "@/services/n8nClient";

/**
 * Send a payload to an n8n webhook path with optional user/household context.
 * @param {string} path - e.g., "meal/refresh"
 * @param {object} payload
 * @param {object} [ctx] - { userId, householdId, source }
 */
export async function sendToN8n(path, payload = {}, ctx = {}) {
  const body = {
    ...payload,
    _ctx: {
      userId: ctx.userId || null,
      householdId: ctx.householdId || null,
      source: ctx.source || "app",
    },
  };
  return triggerFlow(path, body);
}
