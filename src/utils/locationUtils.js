// src/utils/locationUtils.js

/**
 * Standardize and clean location names (e.g. pantry, cellar, coop)
 * @param {string} input
 * @returns {string}
 */
export function normalizeLocation(input) {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-") // spaces to hyphens
    .replace(/[^a-z0-9\-]/g, ""); // remove non-alphanumerics
}

/**
 * Friendly label formatter from location keys.
 * @param {string} key
 * @returns {string}
 */
export function formatLocationLabel(key) {
  return key
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Group inventory or assets by normalized location
 * @param {Array} items - e.g. supplies, animals, tools
 * @returns {Object} - { "root-cellar": [item, item], "pantry": [...] }
 */
export function groupByLocation(items = []) {
  return items.reduce((acc, item) => {
    const key = normalizeLocation(item.location || "unsorted");
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

/**
 * Compare two locations for match (after normalization)
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isSameLocation(a, b) {
  return normalizeLocation(a) === normalizeLocation(b);
}

/**
 * Suggest standard zone groups based on location keywords.
 * Used in dashboards or task assignment.
 * @param {string} location
 * @returns {string} zone category
 */
export function inferZoneFromLocation(location) {
  const key = normalizeLocation(location);
  if (key.includes("cellar") || key.includes("cold")) return "Storage Zone";
  if (key.includes("kitchen") || key.includes("pantry")) return "Food Zone";
  if (key.includes("coop") || key.includes("barn")) return "Animal Zone";
  if (key.includes("garden") || key.includes("shed")) return "Garden Zone";
  if (key.includes("bath") || key.includes("laundry")) return "Hygiene Zone";
  return "General Zone";
}
