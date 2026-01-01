// src/services/mealplanning/mealPlanSharing.js
// Secure, privacy-safe sharing for Meal Plans
// - Signed tokens (HMAC-SHA256) to prevent tampering
// - Sanitized public payload (no PII, no internal ids beyond recipe ids)
// - Public HTML renderer (modern, readable, mobile-first)
// - Optional grocery + batch-session appendices
// - Social share helpers + fallback local persistence
//
// Integrates with: MealPlanStore, RecipeStore, BatchDraftStore, PreferencesStore,
// sabbathGuard, Passover mode, West-African-forward tags, NBA actions.
//
// NOTE: No external deps. Crypto via Web Crypto or Node 'crypto'.

import { sabbathGuard } from "@/services/guardrails/sabbathGuard";
import { usePreferencesStore } from "@/store/PreferencesStore";
import { MealPlans } from "@/store/MealPlanStore";
import { Recipes } from "@/store/RecipeStore";
import { BatchDrafts } from "@/store/BatchDraftStore";
import { logger } from "@/utils/logger";
import { formatISO } from "@/utils/dates";
import { mealPlanExports, primeRecipeCache } from "@/services/mealplanning/mealPlanExports";

// ----------------------------------------------------------------------------
// Config & helpers
// ----------------------------------------------------------------------------
const ALG = "SHA-256";
const DEFAULT_EXP_DAYS = 14;
const LOCAL_NS = "__SUKA_SHARE_PLANS__";
const DEFAULT_THEME = {
  bg: "#0b1020",
  card: "#121735",
  text: "#f6f7fb",
  sub: "#cdd3f5",
  blue: "#3b82f6",     // blue
  purple: "#7c3aed",   // purple
  scarlet: "#dc2626",  // scarlet
  gold: "#d4af37"      // gold
};

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function strToBuf(s) {
  return new TextEncoder().encode(s);
}
async function hmac(key, data) {
  // Browser Web Crypto
  if (globalThis.crypto?.subtle) {
    const k = await crypto.subtle.importKey("raw", strToBuf(key), { name: "HMAC", hash: ALG }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", k, strToBuf(data));
    return b64url(sig);
  }
  // Node
  try {
    const { createHmac } = await import("crypto");
    return createHmac("sha256", key).update(data).digest("base64url");
  } catch {
    throw new Error("No crypto available for signing");
  }
}

function getBaseURL() {
  if (typeof window !== "undefined") {
    const { protocol, host } = window.location;
    return `${protocol}//${host}`;
  }
  return process.env.PUBLIC_BASE_URL || "http://localhost:5173";
}

function nowISO() { return new Date().toISOString(); }
function addDaysISO(startISO, days) {
  const d = new Date(startISO); d.setDate(d.getDate() + days); return d.toISOString();
}
function expiresFrom(days = DEFAULT_EXP_DAYS) {
  return addDaysISO(nowISO(), days);
}

function pick(obj, keys) { return Object.fromEntries(keys.map(k => [k, obj?.[k]])); }

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------
export const mealPlanSharing = {
  /**
   * Create a signed share token + persisted public snapshot.
   * options: { visibility: "unlisted"|"public", expiresInDays, includeGrocery, includeBatch }
   */
  async createShare(planId, options = {}) {
    await primeRecipeCache().catch(() => {});
    const plan = await MealPlans.getById(planId);
    if (!plan) throw new Error("Plan not found");

    const prefs = usePreferencesStore.getState?.() || {};
    const snapshot = await buildPublicSnapshot(plan, prefs, options);

    const payload = {
      v: 1,
      kind: "mealplan",
      createdAt: nowISO(),
      expiresAt: expiresFrom(options.expiresInDays),
      visibility: options.visibility || "unlisted",
      data: snapshot
    };

    const secret = await resolveShareSecret();
    const body = JSON.stringify(payload);
    const sig = await hmac(secret, body);
    const token = `${b64url(strToBuf("suka.share.v1"))}.${b64url(strToBuf(body))}.${sig}`;

    // Persist
    const share = { token, payload };
    await ShareStore.save(share);

    // Emit a simple event if you have an eventBus (optional)
    // eventBus.emit("mealplan:shared", { planId, token });

    return { token, url: buildShareURL(token), expiresAt: payload.expiresAt };
  },

  /** Resolve a share by token (verifies signature & expiry). Returns sanitized snapshot. */
  async resolve(token) {
    const rec = await ShareStore.get(token);
    if (!rec) throw new Error("Share not found");
    await verifyToken(rec.token, rec.payload);
    if (new Date(rec.payload.expiresAt) < new Date()) throw new Error("Share link expired");
    return rec.payload;
  },

  /** Revoke a share token. */
  async revoke(token) {
    await ShareStore.remove(token);
    return { ok: true };
  },

  /**
   * Render a public, standalone HTML document for the shared plan.
   * Usage: const html = await mealPlanSharing.renderHTML(token)
   */
  async renderHTML(token) {
    const { payload } = await ShareStore.get(token) || {};
    if (!payload) throw new Error("Share not found");
    await verifyToken(token, payload);
    return renderPublicHTML(payload, DEFAULT_THEME);
  },

  /**
   * Copy a share URL to clipboard (browser only).
   */
  async copyURL(token) {
    const url = buildShareURL(token);
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return { ok: true, url };
    }
    // Fallback
    return { ok: true, url };
  },

  /**
   * Social share helpers – returns a URL you can open in a new tab/window.
   * target: "twitter" | "facebook" | "pinterest"
   */
  shareTo(target, token) {
    const url = encodeURIComponent(buildShareURL(token));
    const text = encodeURIComponent("Our weekly meal plan via Suka Smart Assistant");
    switch (target) {
      case "twitter":
        return `https://twitter.com/intent/tweet?text=${text}&url=${url}`;
      case "facebook":
        return `https://www.facebook.com/sharer/sharer.php?u=${url}`;
      case "pinterest":
        return `https://pinterest.com/pin/create/button/?url=${url}&description=${text}`;
      default:
        return buildShareURL(token);
    }
  }
};

export default mealPlanSharing;

// ----------------------------------------------------------------------------
// Snapshot builder (privacy-safe)
// ----------------------------------------------------------------------------
async function buildPublicSnapshot(plan, prefs, opts) {
  const sab = sabbathGuard?.window?.() || null;
  const passoverMode = !!prefs?.calendar?.passoverMode;

  // Minimal recipe cache (title, tags only) to render public view
  const allRecipes = await Recipes.all().catch(() => []);
  const rmap = Object.fromEntries(allRecipes.map(r => [r.id, { id: r.id, title: r.title, tags: r.tags || [] }]));

  // Sanitize days/meals → keep only recipeId, tags, servings
  const days = plan.days.map(d => ({
    dateISO: d.dateISO,
    meals: {
      breakfast: keepPublic(d.meals.breakfast),
      lunch: keepPublic(d.meals.lunch),
      dinner: keepPublic(d.meals.dinner),
      snack: keepPublic(d.meals.snack),
    },
  }));

  // Grocery (no inventory locations)
  let grocery = null;
  if (opts.includeGrocery) {
    try {
      const csv = await mealPlanExports.exportPlan({ plan, format: "csv:shopping" })
        .then(r => r?.filePath ? null : null) // browser path already downloads; we just regenerate
        .catch(() => null);
      // Instead of reading a file, rebuild a plain list here from recipes
      grocery = computePublicGrocery(plan, allRecipes, passoverMode);
    } catch {
      grocery = computePublicGrocery(plan, allRecipes, passoverMode);
    }
  }

  // Batch appendix summary
  let batch = null;
  if (opts.includeBatch) {
    batch = await inferBatchAppendix(plan, rmap);
  }

  const meta = {
    weekStartISO: plan.weekStartISO,
    createdAt: plan?.meta?.createdAt || formatISO(new Date()),
    sabbath: sab ? pick(sab, ["from", "to"]) : null,
    passoverMode,
    theme: pickThemeTokens(prefs)
  };

  return { meta, days, grocery, batch, recipes: rmap };
}

function keepPublic(slot) {
  if (!slot?.recipeId) return null;
  return {
    recipeId: slot.recipeId,
    servings: slot.servings || 1,
    tags: (slot.tags || []).slice(0, 8)
  };
}

function computePublicGrocery(plan, recipes, passoverMode) {
  const rmap = Object.fromEntries(recipes.map(r => [r.id, r]));
  const restricted = new Set(["chametz", "leaven", "leavening-agent"]);
  const list = [];

  for (const d of plan.days) {
    for (const mk of ["breakfast", "lunch", "dinner", "snack"]) {
      const slot = d.meals[mk];
      if (!slot?.recipeId) continue;
      const r = rmap[slot.recipeId];
      if (!r?.ingredients) continue;

      for (const ing of r.ingredients) {
        const isChametz = (ing.tags || []).some(t => restricted.has(t));
        if (passoverMode && isChametz) continue;

        list.push({
          dateISO: d.dateISO,
          meal: mk,
          item: ing.name || "",
          qty: (ing.qty || 0) * (slot.servings || 1),
          aisle: ing.aisle || null,
          note: isChametz ? "Restricted during Passover" : (ing.note || null)
        });
      }
    }
  }

  // Group by aisle for nicer display
  const byAisle = {};
  list.forEach(it => {
    const k = it.aisle || "Other";
    (byAisle[k] ||= []).push(it);
  });
  return { byAisle };
}

async function inferBatchAppendix(plan, rmap) {
  // Collect weekend dinners + lunches
  const pick = [];
  for (const d of plan.days) {
    const dow = new Date(d.dateISO).getDay();
    if (dow === 6 || dow === 0) {
      ["dinner", "lunch"].forEach(mk => {
        const id = d.meals[mk]?.recipeId;
        if (id) pick.push(id);
      });
    }
  }
  const uniq = [...new Set(pick)];
  if (!uniq.length) return null;

  // If a BatchDraft already exists, we could reference it; here we just summarize.
  const steps = uniq.map(id => ({
    recipeId: id,
    title: rmap[id]?.title || "Recipe",
  }));
  return { steps };
}

function pickThemeTokens(prefs) {
  // You can wire this to your Tailwind tokens later
  return {
    primary: DEFAULT_THEME.blue,
    accent: DEFAULT_THEME.purple,
    warn: DEFAULT_THEME.scarlet,
    highlight: DEFAULT_THEME.gold
  };
}

// ----------------------------------------------------------------------------
// Token build/verify
// ----------------------------------------------------------------------------
async function resolveShareSecret() {
  // Prefer server-provided secret in memory (window.__SUKA_SHARE_SECRET)
  if (typeof window !== "undefined" && window.__SUKA_SHARE_SECRET) {
    return window.__SUKA_SHARE_SECRET;
  }
  // Dev fallback (DO NOT use in prod): stable local secret persisted in localStorage
  const k = "__SUKA_SHARE_SECRET";
  const existing = typeof localStorage !== "undefined" ? localStorage.getItem(k) : null;
  if (existing) return existing;
  const gen = `local-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  try { localStorage.setItem(k, gen); } catch { /* ignore */ }
  return gen;
}

async function verifyToken(token, payload) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid token");
  const header = atob(parts[0].replace(/-/g, "+").replace(/_/g, "/"));
  if (!header.startsWith("suka.share.v1")) throw new Error("Unsupported token ver");
  const body = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
  const expected = await hmac(await resolveShareSecret(), body);
  if (expected !== parts[2]) throw new Error("Signature mismatch");
  const parsed = JSON.parse(body);
  if (parsed?.kind !== payload?.kind) throw new Error("Payload mismatch");
  return true;
}

function buildShareURL(token) {
  const base = getBaseURL();
  return `${base}/share/mealplan/${token}`;
}

// ----------------------------------------------------------------------------
// Render public HTML (standalone doc)
// ----------------------------------------------------------------------------
function renderPublicHTML(payload, THEME = DEFAULT_THEME) {
  const { meta, days, grocery, recipes, batch } = payload.data || payload;

  const ogTitle = `Meal Plan — Week of ${meta?.weekStartISO || ""}`;
  const ogDesc = meta?.passoverMode
    ? "Passover mode is ON – chametz filtered."
    : "Weekly plan generated in Suka Smart Assistant.";
  const ogUrl = buildShareURL("TOKEN"); // replaced at runtime by the router if desired

  const css = `
    :root{
      --bg:${THEME.bg};--card:${THEME.card};--text:${THEME.text};--sub:${THEME.sub};
      --blue:${THEME.blue};--purple:${THEME.purple};--scarlet:${THEME.scarlet};--gold:${THEME.gold}
    }
    html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Inter,Arial}
    a{color:var(--blue);text-decoration:none} a:hover{text-decoration:underline}
    .container{max-width:1040px;margin:0 auto;padding:24px}
    .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
    .badge{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;font-size:12px;background:#0f1535;border:1px solid #1d2247;color:var(--sub)}
    .grid{display:grid;grid-template-columns:repeat(1,minmax(0,1fr));gap:12px}
    @media(min-width:700px){.grid{grid-template-columns:repeat(2,minmax(0,1fr));}}
    .card{background:var(--card);border:1px solid #1b2142;border-radius:16px;padding:16px;box-shadow:0 4px 16px rgba(0,0,0,.25)}
    .day{display:flex;gap:12px;align-items:flex-start}
    .date{min-width:105px;color:var(--sub);font-weight:600}
    .meals{flex:1;display:grid;grid-template-columns:100px 1fr;row-gap:6px;column-gap:12px}
    .k{color:var(--gold);text-transform:capitalize;font-weight:600}
    .v a{color:#e6e7ff}
    .tag{display:inline-block;margin:0 6px 6px 0;background:#1a1f3f;border:1px solid #222857;border-radius:999px;padding:2px 8px;font-size:12px;color:#cbd5ff}
    .sectionTitle{font-weight:700;margin:18px 0 8px 0}
    .note{padding:10px 12px;border:1px dashed #273063;background:#101636;border-radius:12px;color:#c9d4ff}
    .pill{display:inline-block;margin:0 6px 6px 0;padding:4px 8px;border-radius:999px;border:1px solid #283066;background:#121a3f;color:#cdd3f5;font-size:12px}
    .footer{margin-top:28px;color:#aab1da;font-size:12px}
    .accent{color:var(--gold)} .scarlet{color:var(--scarlet)} .purple{color:var(--purple)}
    .hr{height:1px;background:#242a52;border:none;margin:20px 0}
    .subtle{color:#aeb7e9}
  `;

  const sabNote = meta?.sabbath ? `
    <div class="note">
      ⛔ <b>Sabbath window</b> from <span class="subtle">${new Date(meta.sabbath.from).toLocaleString()}</span>
      to <span class="subtle">${new Date(meta.sabbath.to).toLocaleString()}</span>. Favor leftovers / low-touch.
    </div>` : "";

  const passoverNote = meta?.passoverMode ? `
    <div class="note">
      ✡️ <b>Passover mode is ON</b> — chametz filtered from grocery & picks.
    </div>` : "";

  const dayCards = days.map(d => {
    const mealRow = (k, slot) => {
      if (!slot) return "";
      const title = recipes?.[slot.recipeId]?.title || "";
      const tags = (slot.tags || []).slice(0, 6).map(t => `<span class="tag">${t}</span>`).join("");
      return `
        <div class="k">${k}</div>
        <div class="v">
          ${title ? `<a target="_blank" rel="noopener">${escapeHtml(title)}</a>` : `<span class="subtle">–</span>`}
          <div>${tags}</div>
        </div>`;
    };

    return `
      <div class="card day">
        <div class="date">${escapeHtml(d.dateISO)}</div>
        <div class="meals">
          ${mealRow("breakfast", d.meals.breakfast)}
          ${mealRow("lunch", d.meals.lunch)}
          ${mealRow("dinner", d.meals.dinner)}
          ${mealRow("snack", d.meals.snack)}
        </div>
      </div>`;
  }).join("");

  const grocerySection = grocery ? renderGrocery(grocery) : "";
  const batchSection = batch ? renderBatch(batch, recipes) : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(ogTitle)}</title>
<meta property="og:title" content="${escapeHtml(ogTitle)}"/>
<meta property="og:description" content="${escapeHtml(ogDesc)}"/>
<meta property="og:type" content="article"/>
<meta property="og:url" content="${escapeHtml(ogUrl)}"/>
<meta name="theme-color" content="${THEME.gold}"/>
<style>${css}</style>
</head>
<body>
  <main class="container">
    <div class="header">
      <div>
        <div class="badge">
          <span style="width:10px;height:10px;border-radius:999px;background:var(--gold);display:inline-block"></span>
          Suka Smart Assistant
        </div>
        <h1 style="margin:10px 0 8px 0;font-size:28px">Weekly Meal Plan <span class="accent">(${escapeHtml(meta?.weekStartISO || "")})</span></h1>
        <div class="subtle">West-African forward • Street/Food-Truck friendly • Fusion capable</div>
      </div>
      <div style="text-align:right">
        <div class="pill">Unlisted Share</div>
      </div>
    </div>

    ${passoverNote}
    ${sabNote}

    <section>
      <h2 class="sectionTitle">Plan</h2>
      <div class="grid">
        ${dayCards}
      </div>
    </section>

    ${grocerySection}
    ${batchSection}

    <hr class="hr"/>

    <div class="footer">
      Generated by <b>Suka Smart Assistant</b>. Colors: <span class="accent">gold</span>, <span class="purple">purple</span>, <span class="scarlet">scarlet</span>, blue.
    </div>
  </main>
</body>
</html>`;
}

function renderGrocery(grocery) {
  const aisles = Object.keys(grocery.byAisle || {}).sort();
  const cols = aisles.map(a => {
    const items = grocery.byAisle[a].map(it => `<li>${escapeHtml(it.item)} <span class="subtle">×${it.qty}</span></li>`).join("");
    return `
      <div class="card">
        <h3 style="margin:0 0 6px 0">${escapeHtml(a)}</h3>
        <ul style="margin:0;padding-left:16px">${items}</ul>
      </div>`;
  }).join("");
  return `
    <section>
      <h2 class="sectionTitle">Grocery</h2>
      <div class="grid">
        ${cols}
      </div>
    </section>`;
}

function renderBatch(batch, recipes) {
  const items = (batch.steps || []).map(s => {
    const t = recipes?.[s.recipeId]?.title || "Recipe";
    return `<li>${escapeHtml(t)}</li>`;
  }).join("");
  return `
    <section>
      <h2 class="sectionTitle">Weekend Batch</h2>
      <div class="card">
        <p class="subtle" style="margin-top:0">Suggested to streamline dinners & lunches.</p>
        <ul style="margin-top:8px;padding-left:16px">${items}</ul>
      </div>
    </section>`;
}

function escapeHtml(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ----------------------------------------------------------------------------
// Local ShareStore (fallback). Replace with API calls when your backend is ready.
// ----------------------------------------------------------------------------
const ShareStore = {
  async save(rec) {
    // If you have a backend: POST /api/share { token, payload }
    const all = readLocal();
    all[rec.token] = rec;
    writeLocal(all);
    return rec;
  },
  async get(token) {
    const all = readLocal();
    return all[token] || null;
  },
  async remove(token) {
    const all = readLocal();
    delete all[token];
    writeLocal(all);
    return true;
  }
};

function readLocal() {
  if (typeof localStorage === "undefined") return globalThis.__SUKA_SHARE_MEM || {};
  try {
    return JSON.parse(localStorage.getItem(LOCAL_NS) || "{}");
  } catch {
    return {};
  }
}
function writeLocal(obj) {
  if (typeof localStorage === "undefined") { globalThis.__SUKA_SHARE_MEM = obj; return; }
  try { localStorage.setItem(LOCAL_NS, JSON.stringify(obj)); } catch (e) { logger.warn("ShareStore write failed", e); }
}
