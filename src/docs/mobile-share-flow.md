Suka Smart Assistant – Mobile Share / Send-to-Suka Flow
File: C:\Users\larho\suka-smart-assistant\src\docs\mobile-share-flow.md
Version: 2025-10-31
Scope: mobile browser share sheet, in-app share, bookmarklet, PWA share target
Domains covered: cleaning, garden (plan/care/harvest), storehouse (grocery sections), meal planning/cooking, animal acquisition/care/butchery
Key requirements satisfied:


users can save their own favorite sessions/schedules (not only system ones)


supports reverse generation (recipes→animals, recipes→garden, harvest→storehouse, storehouse→cleaning, animals→meals/storehouse)


uses shared orchestration via automation.schedule.request


looks/behaves like well executed websites: quick action, toast, “saved” indicator, schedule suggestion


aligns with current project chats (import workers, import queue worker, automation runtime updates, home.jsx inline generators)



1. Goal
Make it ridiculously easy for someone on a phone to do this:

“I’m on Allrecipes / Pinterest / a gardening blog / homestead TikTok → I hit Share → ‘Suka Smart Assistant’ → Suka figures out if it’s a recipe, cleaning idea, garden seed/care, harvest info, storehouse goal (with grocery sections), or an animal/butchery plan, then saves it, schedules it, and offers me a user-owned favorite.”

This doc explains how your mobile share target should package data for your existing import stack:


src/workers/import.worker.js


src/workers/importQueue.worker.js


src/services/automation/runtime.js


src/public/shortcut-download.html



2. Mobile entry points we support
We want to accept content from as many places as possible, especially on mobile:


PWA Share Target


Your PWA manifest can declare a share_target route, e.g. /share/mobile.


Mobile OS will call that route with title, text, url, and sometimes files.




Browser Share → “Suka Smart Assistant”


On Android/Chrome you can register a custom handler in your PWA.


On iOS/Safari, a shortcut/bookmarklet may be more reliable.




Bookmarklet / Shortcut


Already covered in shortcut-download.html but here we describe the mobile variant:


Bookmarklet scrapes the open page and POSTs to your /api/import or sends a postMessage to the PWA.




In-app “Share to Suka” button


For your own app pages (recipes, garden entries, animals, storehouse plans) you show a Share → Mobile action that calls the same endpoint or worker.





3. Canonical payload from a mobile share
No matter where the share started, we want to end up with this structure (the import envelope):
{
  "source": "mobile-share",
  "kind": "auto",
  "raw": {
    "title": "Garlic Dill Green Beans",
    "text": "…copied from the share sheet…",
    "url": "https://example.com/pantry-green-beans",
    "html": null
  },
  "meta": {
    "favoriteMe": true,
    "priority": 1,
    "from": "mobile",
    "device": "phone"
  }
}

That object is what we post to either:


import.worker.js (for single, immediate items), or


importQueue.worker.js (for multiple items / offline / background queue)



4. Where the “smart” part happens
Your workers already know how to fan out to domains:


cleaning: cleaning.routine.imported


garden: garden.seed.imported / garden.care.imported / garden.harvest.imported


storehouse: storehouse.plan.imported (with default grocery sections)


meals: mealplan.imported


animals: animals.plan.imported


So the mobile flow only has to do one extra step:
👉 guess which domain the mobile content is about and stamp kind: before sending to the worker.

5. Heuristics for domain guessing (mobile)
This is the part that makes the mobile flow feel like a “well executed” app.
Below is dynamic code (pseudocode → real JS) you can drop into your /share/mobile handler or a small frontend util that runs before posting to the worker.
// src/docs/snippets/mobile-share-domain-guess.js
export function guessMobileDomain({ title = "", text = "", url = "" } = {}) {
  const hay = `${title} ${text} ${url}`.toLowerCase();

  // meals / recipes
  const mealWords = ["recipe", "allrecipes", "pinterest.com/pin", "foodnetwork", "cook", "ingredients", "servings"];
  if (mealWords.some((w) => hay.includes(w))) {
    return { kind: "mealplan", confidence: 0.9 };
  }

  // garden (seed / care / harvest)
  const gardenWords = ["seed", "sow", "planting", "garden", "raised bed", "zone", "usda zone", "harvest"];
  if (gardenWords.some((w) => hay.includes(w))) {
    // if "harvest" is there, mark it
    if (hay.includes("harvest")) {
      return { kind: "harvest", confidence: 0.9 };
    }
    return { kind: "garden", confidence: 0.8 };
  }

  // cleaning / declutter
  const cleaningWords = ["cleaning", "declutter", "deep clean", "laundry day", "bathroom cleaning", "spring clean"];
  if (cleaningWords.some((w) => hay.includes(w))) {
    return { kind: "cleaning", confidence: 0.8 };
  }

  // storehouse / pantry / canning
  const storeWords = ["pantry", "storehouse", "canning", "preserving", "food storage", "grocery list", "stock up"];
  if (storeWords.some((w) => hay.includes(w))) {
    return { kind: "storehouse", confidence: 0.8 };
  }

  // animals / butchery
  const animalWords = ["butchery", "lamb", "sheep", "goat", "chicken tractor", "poultry", "hog", "pasture plan"];
  if (animalWords.some((w) => hay.includes(w))) {
    return { kind: "animals", confidence: 0.75 };
  }

  // fallback
  return { kind: "auto", confidence: 0.3 };
}

This is mobile-friendly, no heavy parsing, and gives you a domain guess.

6. Sending to the worker (mobile-side dynamic code)
Here’s a dynamic client-side handler for your mobile share route:
// src/docs/snippets/mobile-share-handler.js
import { guessMobileDomain } from "./mobile-share-domain-guess.js";

export async function handleMobileSharePayload(shareData) {
  // shareData likely looks like: { title, text, url, files? }
  const { kind } = guessMobileDomain(shareData);

  const payload = {
    source: "mobile-share",
    kind,
    raw: {
      title: shareData.title || "",
      text: shareData.text || "",
      url: shareData.url || "",
    },
    meta: {
      favoriteMe: true,            // user intends to save this
      priority: 1,
      from: "mobile",
      device: "phone",
    },
  };

  // send to import queue worker (more robust for mobile)
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: "IMPORT_QUEUE:ENQUEUE",
      payload,
    });
  } else if (window.__suka?.workers?.importQueue) {
    window.__suka.workers.importQueue.postMessage({
      type: "IMPORT_QUEUE:ENQUEUE",
      payload,
    });
  } else {
    // last resort: hit the import worker directly
    window.__suka?.workers?.import?.postMessage?.({
      type: "IMPORT",
      payload,
    });
  }
}

This code respects your existing import stack and works in mobile browsers and PWAs.

7. How favorites & schedules are created (mobile path)
Because we attach "meta.favoriteMe": true, both workers you already have:


import.worker.js


importQueue.worker.js


will emit:


favorite.request – so the mobile user gets a “Saved to My Favorites” experience, not a system-owned one.


automation.schedule.request – so the mobile user gets a suggested schedule right away


You already updated automation/runtime.js to listen for that and persist it. That’s the main reason we add favoriteMe on mobile: mobile actions are highly intentional.

8. Reverse generation in mobile
Mobile users often start with the “visible” thing (a recipe, a garden post) but your system wants to end with household structure (animals, storehouse, cleaning).
So, for mobile shares, we turn on reverse generation by default for certain domains:


If kind === "mealplan" or kind === "recipe" → emit:


reverse.action.request { kind: "recipes→animals" }


reverse.action.request { kind: "recipes→garden" }




If kind === "harvest" → emit:


reverse.action.request { kind: "harvest→storehouse" }




If kind === "storehouse" and it mentions pantry/shelves → emit:


reverse.action.request { kind: "storehouse→cleaning" }




Because the workers already support this pattern, the mobile flow just adds the flags.
Here’s a small snippet you can mention in the doc:
// src/docs/snippets/mobile-share-reverse.js
export function buildReverseForMobile(kind, raw) {
  const reverses = [];

  if (kind === "mealplan" || kind === "recipe") {
    reverses.push({ kind: "recipes→animals" });
    reverses.push({ kind: "recipes→garden" });
  }

  if (kind === "harvest") {
    reverses.push({
      kind: "harvest→storehouse",
      amount: raw.yield || raw.qty || null,
      item: raw.crop || raw.variety || null,
    });
  }

  if (kind === "storehouse" && (raw.needsCleaning || /pantry|shelf|shelves/.test(`${raw.title} ${raw.text || ""}`))) {
    reverses.push({ kind: "storehouse→cleaning", shelves: raw.shelves || "all" });
  }

  return reverses;
}

Your main import worker can forward those reverse tasks as usual.

9. Shared orchestration: mobile → runtime
To stay in sync with the rest of the project (your last automation.js update), your mobile flow should document that it depends on this event being available:
// main thread, receiving worker message
window.addEventListener("message", (evt) => {
  const msg = evt.data;
  if (!msg) return;

  // 1) route mobile imports
  if (msg.type === "import.normalized") {
    // send to event bus so pages (meals, cleaning, garden) auto-update
    window.__suka?.eventBus?.emit?.(msg.payload.domain + "/imported", msg.payload);
  }

  // 2) create schedule in runtime
  if (msg.type === "automation.schedule.request") {
    window.automation?.emitEvent?.("automation.schedule.request", msg.payload);
  }

  // 3) user favorites
  if (msg.type === "favorite.request") {
    window.automation?.saveFavoriteSession?.(msg.payload.data)
    // optional fallback:
    // localStorage setItem('suka.favorites.sessions', ...)
  }

  // 4) reverse
  if (msg.type === "reverse.action.request") {
    window.__suka?.eventBus?.emit?.("reverse.action.request", msg.payload);
  }
});

This is how mobile gets unified with desktop/bookmarklet/web-import.

10. UX notes (inspired by well executed sites)


Immediate feedback: show a toast “Sent to Suka • Meal plan scheduled for Sunday 3pm”.


Inline success CTA: “View in Suka” → deep link to /meal-planning or /garden#planner


Favorite toggle visible: since mobile import sent favoriteMe: true, show “★ Saved” when user later opens that page.


Show source: “Imported from Mobile (Pinterest)” so users trust the pipeline.



11. What to tell future contributors
When you add a new mobile-importable thing (e.g. livestock feed plan, canning batch, construction task):


Add keywords to guessMobileDomain(...)


Map to one of the 5 core domains


Add reverse actions if it affects another domain


Make sure to emit favoriteMe: true from mobile


Make sure to emit automation.schedule.request


Update this doc with sample payload



12. TL;DR


Mobile always sends: { source: "mobile-share", kind, raw, meta: { favoriteMe: true } }


Workers always answer with: import.normalized, automation.schedule.request, favorite.request, and optional reverse.action.request


Domains covered: cleaning, garden, harvest, storehouse (with grocery sections), meal planning, animal acquisition/care/butchery


User-owned: YES – we explicitly save favorites/schedules for the user


Reverse generation: YES – recipes→animals/garden, harvest→storehouse, storehouse→cleaning, animals→meals/storehouse


Shared orchestration: YES – everything funnels to your updated automation/runtime.js


End of file.