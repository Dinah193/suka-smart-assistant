// src/utils/crypto.js — browser+node friendly crypto helpers
const isBrowser = typeof window !== "undefined";

export function randomUUID() {
  if (!isBrowser) {
    // Node (prefer node:crypto if present)
    try { return require("node:crypto").randomUUID(); } catch {}
    try { return require("crypto").randomUUID(); } catch {}
  }
  if (crypto?.randomUUID) return crypto.randomUUID();
  // fallback: RFC4122 v4-ish
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (crypto?.getRandomValues ? crypto.getRandomValues(new Uint8Array(1))[0] : Math.random()*256) | 0;
    const v = c === "x" ? (r & 0xf) : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}

export async function hmacSha256Hex(message, secret) {
  if (!isBrowser) {
    try {
      const { createHmac } = require("node:crypto");
      return createHmac("sha256", secret).update(message).digest("hex");
    } catch {
      const { createHmac } = require("crypto");
      return createHmac("sha256", secret).update(message).digest("hex");
    }
  }
  // Browser: WebCrypto
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
