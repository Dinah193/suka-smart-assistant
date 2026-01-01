# Family Fund Mode in Suka Smart Assistant (SSA)

**File:** `src/docs/familyFund-mode.md`  
**Goal:** Explain clearly how **Suka Smart Assistant (SSA)** stays an **independent, household-first app**, and how, *when you turn it on*, it can **also** share household data with the **Suka Village Family Fund Hub (SVFFH)** — without losing control.

---

## 1. First principle

> **SSA owns the data first.**  
> SVFFH only gets what SSA decides to send **after** SSA has stored it, normalized it, and emitted its own events.

That means:
- SSA can run on your laptop / LAN / local Vite dev
- SSA can work offline
- SSA can manage meals, cleaning, garden, animals, preservation, and storehouse
- SSA can emit events and schedule sessions
- **Even if** SVFFH is down or unreachable

SVFFH is **optional** and **downstream**.

---

## 2. What is `familyFundMode`?

`familyFundMode` is a **feature flag** (see `schema.household.json` + `getConfig()`) that tells SSA:

> “When you do your normal household work, also format that data to send to the Hub.”

It does **not** change your import logic, session logic, or Dexie logic — those stay the same.

It only changes what happens **after** we do something important.

---

## 3. Where the flag lives

You can keep it in household settings:

```json
{
  "featureFlags": {
    "familyFundMode": true,
    "scanCompareTrust": true,
    "importCleaning": true,
    "importGarden": true
  }
}
Or expose it in a settings UI so the householder can toggle it.

4. What happens when it’s ON
When familyFundMode === true, SSA will:

Do the normal thing (import, normalize, store, emit event)

Build a Hub-friendly packet

Try to send it to SVFFH

Ignore errors

In code, this is the pattern we used in src/db/index.js:

js
Copy code
async function exportToHubIfEnabled(payload) {
  try {
    const cfg = getConfig();
    const enabled =
      cfg?.featureFlags?.familyFundMode === true ||
      cfg?.featureFlags?.["familyFundMode"] === true;

    if (!enabled) return;

    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch {
    // Hub is optional; SSA must keep working
  }
}
Key ideas:

Check the flag first

Format the data (so Hub has a consistent shape)

Send it (so Hub has a feed of household activity)

Fail silently (so SSA isn’t blocked)

5. Which SSA actions get exported
We only export household-significant events, things like:

household.created

household.member.added

import.parsed

inventory.updated

inventory.shortage.detected

storehouse.goal.created

garden.harvest.logged

animals.asset.created

animals.butchery.session.created

preservation.completed

session.created

See: src/docs/events-to-hub.md for the full list.

Why these? Because Hub users need real demand and real production to make decisions about:

opening grocery stores / markets

offering housekeeping / meal prep

planning community preserves / community canning

stocking construction / animal feed / seed stores

6. Why this is better than “push everything”
You said:

“I want the information collected to be complete, not an opt-in and I want it to be used for accurate information for HUB users…”

That’s exactly what familyFundMode enables — but with control:

Household decides: turn the mode on or off

SSA decides: what counts as “household data”

Hub receives: actionable, normalized, time-stamped packets

This gives Hub accuracy without forcing households to tether themselves to the hub to operate.

7. How it fits in the pipeline
Here’s the full flow with familyFundMode ON:

Imports

browser → /import/share-capture

stored in importQueue → normalized → in imports

Intelligence

SSA extracts ingredients / methods / equipment / seasonality / task graphs

writes to contextIntelligence

Automation

SSA emits import.parsed

automation runtime sees it, creates sessions:

cooking

cleaning

garden care

animal care / butchery

preservation

storehouse restock / production

Household data changed

new session

new storehouse goal

inventory updated

harvest logged

preservation recorded

(Optional) Hub export

SSA checks familyFundMode

builds packet (with { type, ts, source, data })

sends to SVFFH

if SVFFH is down → SSA continues

8. SSA ↔ SVFFH relationship
Think of it like this:

SSA = personal household engine

imports everything

knows your calendar / guards (Sabbath, quiet hours, weather)

generates your actual to-do’s

keeps your storehouse plan

SVFFH = community intelligence + mutual aid

sees what households need

sees what households produce

enables trade, group buy, co-op, susu, marketplace

can publish “Make more beef sausage this month — 7 households are low”

So:

SSA = mine; SVFFH = ours.
familyFundMode is the bridge.

9. What Hub receives (shape)
Every exported packet should already look like an SSA event:

json
Copy code
{
  "type": "inventory.shortage.detected",
  "ts": "2025-11-02T22:15:00.000Z",
  "source": "db.index.inventory",
  "data": {
    "item": {
      "id": "inv_22",
      "householdId": "hh_mcKay",
      "name": "Whole wheat flour",
      "quantity": 2,
      "minThreshold": 10,
      "category": "grain"
    }
  }
}
Hub can add:

region / locality

household → fund mapping

aggregation

opportunity detection

But SSA doesn’t need to know any of that.

10. Security / privacy stance
default: off (SSA is local-first)

when on:

send only event-shaped payloads

no browser secrets / no cookies

no Talmud / non-requested data (matching your other requirements)

no dependence on current Jewish culture — it’s culture-aware, not culture-dependent

If you ever need multiple export targets, you can extend the helper:

js
Copy code
async function exportToHubIfEnabled(payload) {
  const cfg = getConfig();
  const enabled = cfg?.featureFlags?.familyFundMode;
  if (!enabled) return;

  const packet = HubPacketFormatter.format(payload);
  await Promise.allSettled([
    FamilyFundConnector.send(packet),
    // future: VillageReportsConnector.send(packet),
    // future: AuditTrailConnector.send(packet),
  ]);
}
11. Developer checklist
When you add a new feature that changes household data, do this:

Emit SSA event:

js
Copy code
eventBus.emit("X.created", { ... })
Call the helper:

js
Copy code
exportToHubIfEnabled({
  type: "X.created",
  ts: new Date().toISOString(),
  source: "feature.module",
  data: row
});
Make sure the data has householdId

Add it to src/docs/events-to-hub.md

That’s it.

12. Summary
SSA and SVFFH are not the same.

SSA must be able to run by itself.

familyFundMode is a bridge, not a dependency.

With the mode ON, SSA becomes a household telemetry source for the Hub.

With the mode OFF, SSA is a private household engine.

✅ That’s family fund mode.