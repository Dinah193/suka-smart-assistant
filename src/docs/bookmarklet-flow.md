# Suka Smart Assistant – Bookmarklet / “Add to Suka” Flow
**File:** `C:\Users\larho\suka-smart-assistant\src\docs\bookmarklet-flow.md`  
**Version:** 2025-10-31  
**Status:** ready to implement  
**Covers:** cleaning, garden (plan/care/harvest), storehouse stock planning (with grocery sections), meal planning/cooking, animal acquisition/care/butchery, **plus** reverse generation  
**Aligned with:**  
- `src/services/automation/runtime.js` (new unified `automation.schedule.request` listener + domain remaps)  
- `src/workers/import.worker.js`  
- `src/workers/importQueue.worker.js`  
- `src/public/shortcut-download.html`  
- your updated `home.jsx` with inline generators (garden from seed, animal plan from recipes, etc.)

---

## 1. Purpose

You said:  

> “I want to use a browser bookmarklet for as many different types of sites as I can.”

and

> “Ensure users can save **their own** favorite sessions and schedules, not just system sessions and schedules.”

and

> “It must also support **reverse generation**.”

So this flow is the **desktop/laptop/web** twin of the **mobile-share** flow we just documented. The difference: bookmarklet can run **on any site** and scrape a bit more context from the DOM before sending it to Suka.

This doc tells you:

1. what JS to inject as a bookmarklet
2. what payload to build
3. how to guess the domain (cleaning, garden, storehouse, meals, animals)
4. how to ask Suka to **create a schedule** and **save a favorite**
5. how to trigger **reverse generation** automatically
6. how to hand it off to your **import worker** / **import queue worker** and then to the **automation runtime**

---

## 2. High-level flow

1. **User is on** Allrecipes / Pinterest / homestead blog / garden seed catalog / butchery article / pantry-stocking article.
2. **User clicks** “Add to Suka” bookmarklet.
3. JS in the page:
   - scrapes `document.title`, `location.href`, some page text, maybe an image
   - runs **domain-guessing heuristics** (very similar to the mobile version)
   - builds **one canonical envelope** like:

   ```json
   {
     "source": "bookmarklet",
     "kind": "mealplan",
     "raw": { ...pageData },
     "meta": {
       "favoriteMe": true,
       "priority": 1,
       "from": "bookmarklet"
     }
   }
It tries to postMessage that to the already-open Suka tab/PWA.

If no PWA is open, it can open your Suka app with the payload in the URL (fallback).

Inside Suka, your main thread passes it to the import queue worker.

Worker normalizes → emits:

import.normalized

automation.schedule.request

favorite.request

reverse.action.request

automation/runtime.js picks up automation.schedule.request and persists a user-owned schedule.

UI shows toast “Imported to Suka • scheduled”.

3. The actual bookmarklet (dynamic, domain-aware)
Below is a dynamic script you can minify and URL-encode for the bookmarklet. Keep it here in the doc for editing.

js
Copy code
// src/docs/snippets/suka-bookmarklet.js
(function () {
  const WIN = window;
  const DOC = document;

  // 1) Gather page data
  const title = DOC.title || "";
  const url = WIN.location.href;
  const sel = WIN.getSelection ? String(WIN.getSelection()) : "";
  const metaDesc = DOC.querySelector('meta[name="description"]')?.content || "";
  const text = (sel || metaDesc || "").slice(0, 1200); // keep it short
  const html = null; // we can add if we need

  // 2) Guess domain (same logic as mobile, but add a few desktop-only hints)
  function guessDomain({ title = "", text = "", url = "" } = {}) {
    const hay = `${title} ${text} ${url}`.toLowerCase();

    // meals / recipes (Allrecipes, Pinterest food, etc.)
    const mealWords = [
      "recipe",
      "allrecipes.com",
      "pinterest.com/pin",
      "foodnetwork.com",
      "ingredient",
      "prep time",
      "cook time",
      "servings"
    ];
    if (mealWords.some((w) => hay.includes(w))) {
      return { kind: "mealplan", confidence: 0.92 };
    }

    // garden / homestead / seed catalogs
    const gardenWords = [
      "seed",
      "sow",
      "planting",
      "garden",
      "raised bed",
      "usda zone",
      "harvest",
      "transplanting",
      "companion planting"
    ];
    if (gardenWords.some((w) => hay.includes(w))) {
      if (hay.includes("harvest")) {
        return { kind: "harvest", confidence: 0.9 };
      }
      return { kind: "garden", confidence: 0.85 };
    }

    // cleaning / declutter / routines
    const cleaningWords = ["cleaning", "declutter", "deep clean", "laundry day", "spring cleaning", "tidy"];
    if (cleaningWords.some((w) => hay.includes(w))) {
      return { kind: "cleaning", confidence: 0.8 };
    }

    // storehouse / pantry / canning / grocery prepping
    const storeWords = [
      "pantry",
      "storehouse",
      "food storage",
      "canning",
      "preserving",
      "grocery haul",
      "stockpile",
      "prepper pantry"
    ];
    if (storeWords.some((w) => hay.includes(w))) {
      return { kind: "storehouse", confidence: 0.8 };
    }

    // animals / butchery / livestock
    const animalWords = [
      "butchery",
      "livestock",
      "sheep",
      "goat",
      "poultry",
      "chicken tractor",
      "offal",
      "meat birds",
      "breed for meat"
    ];
    if (animalWords.some((w) => hay.includes(w))) {
      return { kind: "animals", confidence: 0.75 };
    }

    return { kind: "auto", confidence: 0.35 };
  }

  const { kind, confidence } = guessDomain({ title, text, url });

  // 3) Build canonical envelope
  const envelope = {
    source: "bookmarklet",
    kind,
    raw: { title, text, url, html },
    meta: {
      favoriteMe: true,         // ✅ user-owned favorites
      priority: 1,
      from: "bookmarklet",
      confidence,
      // for reverse generation to know the article's context
      domainHint: kind
    }
  };

  // 4) Try to send to an already-open Suka window/tab via postMessage
  const MSG = {
    type: "SUKA:IMPORT",
    payload: envelope
  };

  // a) if this window actually *is* Suka, dispatch directly
  if (WIN.__suka?.workers?.importQueue) {
    WIN.__suka.workers.importQueue.postMessage({
      type: "IMPORT_QUEUE:ENQUEUE",
      payload: envelope
    });
    alert("Sent to Suka (importQueue). You can edit it in your dashboard.");
    return;
  }

  // b) broadcast to other tabs
  try {
    WIN.postMessage(MSG, "*");
  } catch (e) {
    // ignore
  }

  // c) last resort: open Suka with payload in hash (fallback)
  const encoded = encodeURIComponent(JSON.stringify(envelope));
  const sukaUrl = "https://your-suka-app.localhost/share#payload=" + encoded;
  WIN.open(sukaUrl, "_blank", "noopener,noreferrer");
})();
You will minify + javascript:(...) this for the actual bookmarklet, but this is the source-of-truth.

4. What the Suka tab should do with this message
Add this listener to your root layout or to a small “bridge” module (e.g. src/app/bridge/bookmarklet-bridge.js):

js
Copy code
// src/app/bridge/bookmarklet-bridge.js
import { automation } from "@/services/automation/runtime";

const KNOWN_REVERSE = ["recipes→animals", "recipes→garden", "harvest→storehouse", "storehouse→cleaning", "animals→meals", "animals→storehouse"];

function buildReverse(kind, raw = {}) {
  const list = [];

  if (kind === "mealplan" || kind === "recipe" || (raw.title || "").toLowerCase().includes("recipe")) {
    list.push({ kind: "recipes→animals" });
    list.push({ kind: "recipes→garden" });
  }

  if (kind === "harvest") {
    list.push({
      kind: "harvest→storehouse",
      item: raw.crop || raw.variety || raw.title || "harvested-produce",
      amount: raw.yield || raw.qty || null,
    });
  }

  if (kind === "storehouse") {
    list.push({ kind: "storehouse→cleaning", shelves: raw.shelves || "all" });
  }

  if (kind === "animals") {
    list.push({ kind: "animals→meals" });
    list.push({ kind: "animals→storehouse" });
  }

  return list.filter((x) => KNOWN_REVERSE.includes(x.kind));
}

export function attachBookmarkletBridge() {
  if (typeof window === "undefined") return;
  window.addEventListener("message", (evt) => {
    const msg = evt.data;
    if (!msg || msg.type !== "SUKA:IMPORT") return;

    const { kind, raw, meta = {} } = msg.payload || {};
    const domain = kind || meta.domainHint || "generic";

    // 1) send to import queue worker if available
    if (window.__suka?.workers?.importQueue) {
      window.__suka.workers.importQueue.postMessage({
        type: "IMPORT_QUEUE:ENQUEUE",
        payload: msg.payload,
      });
    }

    // 2) ask automation to schedule (this uses your new runtime rule)
    automation.emitEvent("automation.schedule.request", {
      title: `${domain[0].toUpperCase() + domain.slice(1)} – from bookmarklet`,
      templateId:
        {
          cleaning: "cleaning.session.generate",
          garden: "garden.session.generate",
          harvest: "garden.session.generate",
          storehouse: "storehouse.session.generate",
          mealplan: "cooking.session.generate",
          animals: "animals.session.generate",
        }[domain] || "generic.session.generate",
      rule:
        domain === "animals"
          ? { at: "07:00" }
          : domain === "garden"
          ? { at: "08:00" }
          : domain === "storehouse"
          ? { at: "11:00" }
          : { at: "15:00" },
      ctx: { ...raw, from: "bookmarklet" },
      meta: {
        domain,
        source: "bookmarklet",
        favoriteMe: !!meta.favoriteMe,
      },
      tags: ["imported", "user-owned", "bookmarklet"],
    });

    // 3) user-owned favorites, not just system
    if (meta.favoriteMe) {
      automation.saveFavoriteSession?.({
        title: `📥 ${domain.toUpperCase()} – from site`,
        domain,
        payload: raw,
        source: "bookmarklet",
      });
    }

    // 4) reverse generation
    const revs = buildReverse(domain, raw);
    revs.forEach((rev) => {
      automation.emitEvent("reverse.action.request", {
        ...rev,
        meta: {
          domain,
          source: "bookmarklet",
        },
      });
    });

    // 5) visual feedback (like “well executed” sites)
    automation.emitEvent("ui.toast", {
      variant: "success",
      title: "Added to Suka",
      message: `We imported that ${domain} item and scheduled it. You can edit it on the ${domain} page.`,
    });
  });
}
Call attachBookmarkletBridge() once in your app root (e.g. in src/main.jsx or src/App.jsx).

This is the key piece that brings your bookmarklet into the same event flow as your mobile share, import workers, and automation runtime.

5. Reverse generation table (for reference in this doc)
from bookmarklet kind	reverse we fire	why
mealplan / recipe	recipes→animals	“Generate animal plan from recipes” (your request)
mealplan / recipe	recipes→garden	“Grow the ingredients we keep cooking”
harvest	harvest→storehouse	harvest goes straight to storehouse goals
storehouse	storehouse→cleaning	pantry shelving needs a clearout
animals	animals→meals	butchery → meals/cooking sessions
animals	animals→storehouse	butchery → stock / curing / freezing

This matches the reverse routes we defined in the other docs.

6. Notes on “well executed websites” inspiration
Notion / Raindrop-like: single click → item captured → toast → open in app

Linear-like: small payload, fast to process, optimistic UI

Airtable / Coda-like: schema-light, normalize later in the app
We copied these UX ideas: quick capture, optimistic toast, editable later, user-owned favorites.

7. How to add new bookmarklet domains later
Add to the guessDomain(...) word lists.

Add the mapping in the bridge (templateId + rule).

Add the reverse routes (if it affects another domain).

Keep favoriteMe: true for bookmarklet items – desktop users also expect persistence.

8. TL;DR
Bookmarklet builds a canonical envelope.

Envelope is sent to Suka tab → Import Queue Worker.

Import pipeline emits:

schedule request → automation runtime stores user schedule

favorite request → user-owned favorites

reverse requests → cleaning, garden, storehouse, meals, animals stay in sync

This doc keeps bookmarklet behavior aligned with:

mobile share

updated automation runtime

your home page generators

co-op / community planning vision

End of file.
