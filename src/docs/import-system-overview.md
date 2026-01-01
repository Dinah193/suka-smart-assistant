Suka Smart Assistant – Import System Overview
File: C:\Users\larho\suka-smart-assistant\src\docs\import-system-overview.md
Version: 2025-10-31
Audience: You (builder), plus future contributors adding new domain imports (cleaning, garden, storehouse, meals, animals/butchery), plus UI/automation folks wiring new “Save to my schedules/favorites” buttons.

1. Why this import system exists
Your Suka Smart Assistant isn’t “just recipes.” It’s a household operating system. That means an import can be:


a recipe from Allrecipes / Pinterest / TikTok


a cleaning routine from a blog


a seed-packet OCR capture


a garden-care schedule


a harvest log


a storehouse stock goal built around grocery sections


an animal plan / butchery plan generated from recipes


something a family member shared from another household / co-op


…and all of those need to land in the same pipeline so they can:


be normalized into Suka’s internal shape,


be scheduled in the local automation runtime (your src/services/automation/runtime.js),


let the user (not just the system) save it as a favorite session or schedule,


and trigger reverse generation (ex: “I imported recipes → what animals/garden/storehouse/cleaning does that imply?”).


This doc explains how that pipeline is put together.

2. Components in this pipeline
You now have these key moving parts:


Public / Bookmarklet / Shortcut Page


src/public/shortcut-download.html


Lets users install 1-click shortcuts for cleaning, garden (plan, care, harvest), storehouse (grocery sections), meals, animals/butchery, and reverse generation.


Those shortcuts always send a canonical event:
automation.schedule.request (or a domain-level schedule event that gets remapped).




Import Worker


src/workers/import.worker.js


Takes single imports, normalizes them to a domain envelope:


cleaning → cleaning.routine.imported


garden (seed/care/harvest) → garden.seed.imported / garden.care.imported / garden.harvest.imported


storehouse → storehouse.plan.imported (with grocery-section inspiration baked in)


meals → mealplan.imported


animals/butchery → animals.plan.imported




Emits 3 important messages back to the main thread:


import.normalized


automation.schedule.request


favorite.request




Also emits reverse fan-out requests like:


recipes→animals


recipes→garden


harvest→storehouse


storehouse→cleaning


animals→meals






Import Queue Worker


src/workers/importQueue.worker.js


Same domains as above but buffered and prioritized.


Can restore a queue from IndexedDB (via main thread).


Every job runs through the same pattern:


normalize → emit schedule → emit favorite (if user said so) → emit reverse → send toast.






Import Service / Router (main thread)


src/features/import/ImportService.js


src/features/import/ImportRouter.js


These are the “glue” in the browser tab. They receive worker messages and re-emit them to:


window.__suka?.eventBus


window.automation.emitEvent(...) (your in-app automation runtime)


UI components (scan panel, meal planner, storehouse planner, garden planner, animals planner).






Automation Runtime


src/services/automation/runtime.js (you just updated it)


This is the brain:


listens for automation.schedule.request


persists user schedules


has favorites glue


has shared orchestration rules:


cooking → cooking/session/schedule


cleaning → cleaning/session/schedule


garden → garden/session/schedule


animals → animals/session/schedule


inventory/storehouse → inventory/session/schedule




remaps them all back to one place so everything is storable.







3. Canonical event you should always target
No matter what you import, try to end up with this:
{
  topic: "automation.schedule.request",
  payload: {
    id: "optional-id-or-empty",
    title: "Human readable session name",
    templateId: "cleaning.session.generate" // or garden.session.generate, etc.
    rule: { at: "09:00" },                  // or { at: "15:00", days: [0] }
    days: [/* optional day numbers 0..6 */],
    tags: ["imported", "user-owned", "home"],
    ctx: { /* domain-specific data (recipes, seeds, shelves, animals...) */ },
    meta: { domain: "cleaning" }
  }
}

Your updated automation runtime already has a rule to catch this and do:


saveSchedule(...)


emit automation.schedule.created


publish to the UI (toast, schedules list, etc.)


persist to localStorage / in-app store


That’s why every import (cleaning, garden, storehouse, meals, animals) should send this shape.

4. Domain-by-domain specifics
4.1 Cleaning
What we import


Routine (standard / deep / declutter-first)


Zones (entry, mudroom, kitchen, wet areas)


Long cadence / focus room


“From storehouse” cleanout


What we emit
{
  "domain": "cleaning",
  "action": "cleaning.routine.imported",
  "data": {
    "id": "<gen>",
    "routineType": "standard",
    "zones": ["entry", "kitchen", "bathroom"],
    "declutterFirst": true
  }
}

Schedule we request
{
  "title": "Daily Cleaning – from import",
  "templateId": "cleaning.session.generate",
  "rule": { "at": "09:00" },
  "meta": { "domain": "cleaning" }
}

Reverse generation we support


storehouse→cleaning (if the import came from storehouse shelves)


User favorites
Worker emits:
{
  "type": "favorite.request",
  "payload": {
    "entity": "session",
    "data": {
      "title": "Cleaning – Landing Zones",
      "domain": "cleaning"
    }
  }
}

So the user can re-run it later, not just your system.

4.2 Garden (planning, care, harvest)
What we import


Seed packet OCR


Bed assignment


Care/irrigation/feeding schedules


Harvest logs (with quantity)


What we emit
{
  "domain": "garden",
  "action": "garden.seed.imported",
  "data": {
    "id": "<gen>",
    "variety": "Buttercrunch",
    "crop": "lettuce",
    "sowingWindow": "Mar–Apr",
    "spacing": "6in",
    "beds": ["A1"]
  }
}

Schedule we request
{
  "title": "Garden Care – from import",
  "templateId": "garden.session.generate",
  "rule": { "at": "08:00" },
  "meta": { "domain": "garden" }
}

Reverse generation we support


harvest→storehouse (when the import was harvest w/ yield)


recipes→garden (when a meal import says “grow this”)


This connects to your storehouse goals and to meal planning.

4.3 Storehouse (stock planning, grocery sections)
Why this matters
You wanted a Storehouse Goals Planner (vision) separate from Inventory (execution).
Imports can feed the planner from:


grocery blogs


pricebook scan


harvest results


co-op / family shared list


What we import
{
  "domain": "storehouse",
  "action": "storehouse.plan.imported",
  "data": {
    "id": "<gen>",
    "name": "Storehouse Goal",
    "targetDays": 30,
    "sections": [
      { "name": "produce", "targetQty": null, "unit": "unit" },
      { "name": "dry-goods", "targetQty": null, "unit": "unit" },
      { "name": "fermenting/preserving", "targetQty": null, "unit": "unit" }
    ]
  }
}

Grocery sections for inspiration
We always default to:
produce
dairy-eggs
meat-seafood
frozen
dry-goods
baking
condiments
fermenting/preserving
bulk
cleaning-supplies

Schedule we request
{
  "title": "Storehouse Stock Planning",
  "templateId": "storehouse.session.generate",
  "rule": { "at": "11:00" },
  "meta": { "domain": "storehouse" }
}

Reverse generation we support


storehouse→cleaning (pantry shelves need clearing)


harvest→storehouse (from garden harvest imports)


User favorites
We emit a favorite.request so the user can have “My storehouse refresh” as a saved session.

4.4 Meal planning & cooking
What we import


recipe URL


Pinterest → Planner


photo → recipe OCR


“copy from another household / co-op”


What we emit
{
  "domain": "meals",
  "action": "mealplan.imported",
  "data": {
    "id": "<gen>",
    "title": "Imported Recipe / Meal Plan",
    "recipes": [
      "https://www.allrecipes.com/...",
      "local-recipe-id"
    ],
    "inventoryAware": true
  }
}

Schedule we request
{
  "title": "Meals / Cooking – from import",
  "templateId": "cooking.session.generate",
  "rule": { "at": "15:00", "days": [0] },
  "meta": { "domain": "cooking" }
}

Reverse generation we support


recipes→animals (what animals do I need to raise / purchase?)


recipes→garden (what crops should I plant or prioritize?)


recipes→storehouse (what staples should I stock?)


this is exactly the “reverse direction” you asked for on the home page: “Generate Animal Plan from Recipes”


User favorites
We emit a favorite.request so user can save “Sunday Batch – from imports.”

4.5 Animals: acquisition, care, butchery
What we import


a basic animal plan (species, count)


a butchery queue from your butchery module


a plan generated from recipes (reverse)


What we emit
{
  "domain": "animals",
  "action": "animals.plan.imported",
  "data": {
    "id": "<gen>",
    "title": "Animal Plan",
    "species": "sheep",
    "count": 2,
    "includeBreeds": true,
    "includeMeatEstimates": true
  }
}

Schedule we request
{
  "title": "Animals – Care / Butchery",
  "templateId": "animals.session.generate",
  "rule": { "at": "07:00" },
  "meta": { "domain": "animals" }
}

Reverse generation we support


animals→meals (butchery → meals)


animals→storehouse (butchery → stock / curing / freezing)


recipes→animals (when it came from meals)


User favorites
We emit a favorite.request so users can have “Flock/Butchery – Weekly” as their schedule.

5. Shared orchestration (how it actually ties together)
You updated src/services/automation/runtime.js to do this:

listen for automation.schedule.request

save as user schedule

re-emit as automation.schedule.created (for UI)

register domain triggers:

cleaning/session/schedule → schedule cleaning template

cooking/session/schedule → schedule cooking template

garden/session/schedule → schedule garden template

animals/session/schedule → schedule animals template

inventory/session/schedule → schedule inventory template

This doc’s rule:
Every new import you add should either:

emit that canonical automation.schedule.request itself, or

emit a domain schedule event that the runtime has a trigger for.

That’s the “one inbox” idea.

6. User-owned favorites & schedules
You said this many times:

“Ensure users can save their own favorite sessions and schedules, not just system sessions and schedules.”

So the workers always send a message like:
{
  "type": "favorite.request",
  "payload": {
    "entity": "session",
    "data": {
      "title": "Garden – Seed Inbox → Plan",
      "domain": "garden",
      "source": "import"
    }
  }
}

Your main thread should:

try window.automation.saveFavoriteSession(...) (because runtime already has favorites glue), else

fall back to localStorage["suka.favorites.sessions"].

That way imports and manual UI actions end up in the same favorites list.

7. Reverse generation (the important part)
These are the blessed reverse routes we’re using right now:

recipes→animals

reason: “Generate animal plan from recipes”

appears on Home → Animal Planner

used in animals import workers

recipes→garden

reason: meal plan says “grow this”

feeds garden inbox

harvest→storehouse

reason: garden harvest was imported

supports your “storehouse vs inventory” separation

storehouse→cleaning

reason: “clean the pantry shelves to match new storehouse goals”

animals→meals / animals→storehouse

reason: butchery/processing was imported

Any new worker / import service must pick from those so we don’t end up with weird one-off reverse names.

8. How this compares to “well executed websites”
You said: “Consider well executed websites to pull inspiration.”
Here’s how we’re mimicking them:

Notion style: one page for installing helpers (we did: shortcut-download.html)

Linear / Superhuman style: single canonical action → multiple domains (we did: automation.schedule.request)

Figma / Miro style: worker does the shape, UI just renders (we did: workers emit import.normalized, UI decides)

Modern recipe apps: pull → normalize → push to planner → show “save this for next week” (we did: favorite.request)

9. What to do when adding a new import type

Add a branch to both workers:

src/workers/import.worker.js

src/workers/importQueue.worker.js

Map it to one of: cleaning, garden, storehouse, meals, animals (the 5 big domains).

Emit the canonical schedule request.

Emit favorite.request if:

user triggered from shortcut/bookmarklet

user said “favoriteMe” in meta

If it’s convertible → add a reverse route from the list in §7.

Update this doc with:

example payload

example schedule

example reverse

10. Example end-to-end flow (Pinterest board → animals)

User opens your public shortcut page and clicks “Meal Planning & Cooking Sessions”.

Browser shortcut sends { kind: "recipe", raw: {...}, meta: { source: "shortcut-download", favoriteMe: true } } to importQueue.worker.

Queue worker normalizes to meals and emits:

import.normalized

automation.schedule.request (→ cooking.session.generate at 15:00 Sunday)

favorite.request (“Cooking Session – current recipes”)

reverse.action.request with { kind: "recipes→animals" }

Main thread re-emits those to:

window.__suka.eventBus

window.automation

your meals page / animals page (to show “we generated an animal plan”)

Automation runtime persists the schedule and emits automation.schedule.created.

User sees in Schedules: “Meals / Cooking – from import (Sun 3PM)”.

That satisfies all of your requirements:

cleaning, garden, storehouse, meals, animals all there

user favorites are saved

reverse generation fires

shared orchestration is used

inspired by well executed sites

11. Summary of canonical events your UI should listen for
Your React app should listen for these from the main thread:

import.normalized – show “Imported to {domain}”

automation.schedule.request – pass to runtime

automation.schedule.created – toast + add to Schedules UI

favorite.request – call runtime favorite API or fall back to localStorage

reverse.action.request – call domain services to actually do the reverse

ui.toast – show quick feedback

That keeps the UX intuitive: user imports something → immediately sees it routed → can run it later → can edit on its own page.

End of doc.