// src/services/ingest/fingerprint.js
// -----------------------------------------------------------------------------
// Fingerprinting + dedupe helpers
// -----------------------------------------------------------------------------
// Deterministic, stable hashing for artifact payloads.
// - Normalize whitespace + case for text
// - Stable hash for same content
// - Works in browser (WebCrypto) and Node (crypto) when available
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .toLowerCase();
}

function normalizePayload(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return normalizeText(payload);
  try {
    // stable-ish stringify: sort keys
    const seen = new WeakSet();
    const stable = JSON.stringify(
      payload,
      (k, v) => {
        if (v && typeof v === "object") {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
          if (!Array.isArray(v)) {
            return Object.keys(v)
              .sort()
              .reduce((acc, key) => {
                acc[key] = v[key];
                return acc;
              }, {});
          }
        }
        return v;
      },
      0
    );
    return normalizeText(stable);
  } catch {
    return normalizeText(String(payload));
  }
}

async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);

  // Browser WebCrypto
  if (typeof crypto !== "undefined" && crypto?.subtle?.digest) {
    const hash = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(hash);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    // base64url
    const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    return b64;
  }

  // Node fallback (Vite may polyfill in dev server; guard it)
  try {
    const mod = await import("crypto");
    const h = mod.createHash("sha256").update(input, "utf8").digest("base64");
    return h.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  } catch (e) {
    // deterministic non-crypto fallback (FNV-1a 64-bit)
    let h1 = BigInt("14695981039346656037");
    const prime = BigInt("1099511628211");
    for (let i = 0; i < input.length; i++) {
      h1 ^= BigInt(input.charCodeAt(i));
      h1 *= prime;
      h1 &= BigInt("0xFFFFFFFFFFFFFFFF");
    }
    return h1.toString(16);
  }
}

/**
 * Compute a fingerprint for an artifact payload.
 * Returns: { fingerprint, normalized, kind }
 */
export async function makeFingerprint({ text, url, json, fileMeta } = {}) {
  const kind = text
    ? "text"
    : url
    ? "url"
    : json
    ? "json"
    : fileMeta
    ? "file"
    : "unknown";

  const normalized =
    kind === "text"
      ? normalizeText(text)
      : kind === "url"
      ? normalizeText(url)
      : kind === "json"
      ? normalizePayload(json)
      : kind === "file"
      ? normalizePayload(fileMeta)
      : normalizePayload({ text, url, json, fileMeta });

  const fingerprint = await sha256Base64Url(`${kind}:${normalized}`);
  return { fingerprint, normalized, kind };
}

export function normalizeIngestText(text) {
  return normalizeText(text);
}
