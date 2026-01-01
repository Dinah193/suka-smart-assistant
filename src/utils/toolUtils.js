// src/utils/toolUtils.js

/**
 * Match available tools to a task's required tool tags
 * @param {Array} tools - Array of all tool objects
 * @param {Array} requiredTags - Tags needed for the task (e.g. ["digging", "manual"])
 * @returns {Array} - Matching tool objects
 */
export function matchToolsToTask(tools = [], requiredTags = []) {
  return tools.filter((tool) =>
    requiredTags.every((tag) => tool.tags?.includes(tag))
  );
}

/**
 * Filter tools by role or use-case (e.g. "butcher", "milker", "cleaner")
 * @param {Array} tools
 * @param {string} role
 * @returns {Array}
 */
export function filterToolsByRole(tools = [], role = "") {
  return tools.filter((tool) => tool.tags?.includes(role.toLowerCase()));
}

/**
 * Find tools needing maintenance or reporting damage
 * @param {Array} tools
 * @returns {Array} - Tools with condition not marked as "good"
 */
export function getDamagedOrWornTools(tools = []) {
  return tools.filter(
    (tool) => tool.condition && tool.condition.toLowerCase() !== "good"
  );
}

/**
 * Suggest replacements for missing tools based on usage tags
 * @param {Array} missingTags - Tags that couldn't be matched
 * @param {Array} inventoryTools
 * @returns {Array} - Suggested similar tools by shared tags
 */
export function suggestToolAlternatives(missingTags = [], inventoryTools = []) {
  return inventoryTools.filter((tool) =>
    tool.tags?.some((tag) => missingTags.includes(tag))
  );
}

/**
 * Categorize tools by location or storage zone
 * @param {Array} tools
 * @returns {Object} - Keyed by location
 */
export function groupToolsByLocation(tools = []) {
  return tools.reduce((acc, tool) => {
    const loc = tool.location || "Unassigned";
    if (!acc[loc]) acc[loc] = [];
    acc[loc].push(tool);
    return acc;
  }, {});
}

/**
 * Determine if a tool is available for a task now
 * @param {Object} tool
 * @param {Array} sessions - Active tool sessions (toolId, inUse)
 * @returns {boolean}
 */
export function isToolAvailable(tool, sessions = []) {
  const active = sessions.find(
    (session) => session.toolId === tool.id && session.inUse
  );
  return !active;
}

/**
 * Generate a restock alert for tools marked with "autoRestock" and damaged
 * @param {Array} tools
 * @returns {Array} - Tool restock suggestions
 */
export function getToolRestockAlerts(tools = []) {
  return tools.filter(
    (tool) =>
      tool.autoRestock === true &&
      tool.condition &&
      tool.condition.toLowerCase() !== "good"
  );
}

/**
 * Finds the user with the best match based on tool overlap.
 * @param {Array} userTools - Array of tool IDs a user owns.
 * @param {Array} requiredTools - Array of tool IDs needed for a task.
 * @returns {Number} - How many tools match.
 */
export function findBestMatchingTools(userTools, requiredTools) {
  if (!Array.isArray(userTools) || !Array.isArray(requiredTools)) return 0;
  return requiredTools.filter((toolId) => userTools.includes(toolId)).length;
}

/**
 * ✅ NEW: Get available tools (fixes missing export)
 * Returns tools that are not currently in-use. Optionally require tags.
 * @param {Array} tools - Tool objects with at least { id, tags? }
 * @param {Array} sessions - Active sessions with { toolId, inUse }
 * @param {Array} requiredTags - Optional tags the tool must include
 * @returns {Array} - Available (and optionally tag-matching) tools
 */
export function getAvailableTools(tools = [], sessions = [], requiredTags = []) {
  const busyIds = new Set(
    sessions.filter((s) => s?.inUse).map((s) => s.toolId)
  );

  return tools.filter((tool) => {
    const free = !busyIds.has(tool.id);
    const tagMatch =
      requiredTags.length === 0 ||
      requiredTags.every((t) => tool.tags?.includes(t));
    return free && tagMatch;
  });
}
