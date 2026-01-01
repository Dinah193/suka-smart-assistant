// src/utils/aiParsing.js

export function safeJSONParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

/**
 * Extracts a JSON object from an LLM response.
 * - Prefers ```json ... ``` fenced blocks
 * - Otherwise scans for the first balanced { ... }
 * Returns parsed object or null.
 */
export function extractJSONBlock(text = "") {
  if (!text) return null;

  // ```json ... ```
  const fence = text.match(/```json\s*([\s\S]*?)\s*```/i) || text.match(/```\s*([\s\S]*?)\s*```/);
  if (fence?.[1]) {
    const parsed = safeJSONParse(fence[1].trim());
    if (parsed) return parsed;
  }

  // Balanced braces scan
  const s = String(text);
  let start = s.indexOf("{");
  while (start !== -1) {
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = s.slice(start, i + 1);
          const parsed = safeJSONParse(candidate);
          if (parsed) return parsed;
          break;
        }
      }
    }
    start = s.indexOf("{", start + 1);
  }
  return null;
}
