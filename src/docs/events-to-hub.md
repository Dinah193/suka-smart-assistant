# Suka Smart Assistant → Hub
## Events That *May* Be Sent to the Suka Village Family Fund Hub

**File:** `src/docs/events-to-hub.md`  
**Scope:** Documents the **SSA-side** events that are candidates for export to the Hub **when** `featureFlags.familyFundMode === true`.  
**Important:** SSA always owns the data first. Hub is **downstream** and **optional**.

---

## 1. Export preconditions

SSA only attempts a Hub export if **all** of the following are true:

1. `featureFlags.familyFundMode === true`
2. The event is **household-data relevant** (it affects inventory, storehouse, garden harvests, animals/butchery, preservation, or household members)
3. The event payload can be formatted by **`HubPacketFormatter`**
4. **`FamilyFundConnector`** is available  
   - if it is **not** available, **SSA continues normally** — no crash, no hard fail

In code, SSA will do something like:

```js
await exportToHubIfEnabled({
  type: "<event.name>",
  ts: new Date().toISOString(),
  source: "<ssa.module>",
  data: { ...domainPayload }
});
This is the same shape as the SSA event bus:
{ type, ts, source, data }.

2. Core household events
These describe the household itself and its people. These matter to Hub because they define who the data belongs to.

2.1 household.created
When: new household record added (db.households.hook("creating", ...))

Why to Hub: Hub needs the household identity for rollups

Shape:

json
Copy code
{
  "type": "household.created",
  "ts": "<ISO>",
  "source": "db.index.households",
  "data": {
    "id": "hh_123",
    "name": "McKay Household",
    "slug": "mckay-household",
    "ownerId": "user_123",
    "featureFlags": {
      "familyFundMode": true
    }
  }
}
2.2 household.updated
When: household settings, flags, or metadata change

Why to Hub: Hub should stay in sync, esp. for familyFundMode

Shape: same as above, but data may be { id, mods, old }

2.3 household.member.added
When: a member is added to the household

Why to Hub: Hub can show “which people are contributing what”

Shape:

json
Copy code
{
  "type": "household.member.added",
  "ts": "<ISO>",
  "source": "db.index.householdMembers",
  "data": {
    "id": "hm_45",
    "householdId": "hh_123",
    "displayName": "Rhonda",
    "role": "householder"
  }
}
3. Import-driven events
These are the first events SSA usually emits. They tell Hub “a household is actively bringing in knowledge.”

3.1 import.parsed
When: any import (recipe, cleaning, garden, animal, storehouse, video) is successfully normalized

Why to Hub: lets Hub learn what content households actually use

Shape:

json
Copy code
{
  "type": "import.parsed",
  "ts": "<ISO>",
  "source": "db.index.imports",
  "data": {
    "id": "imp_123",
    "householdId": "hh_123",
    "domain": "cleaning",
    "source": "bookmarklet.html",
    "normalizedPayload": { /* domain object */ },
    "contextIntelligence": { /* ingredients, tasks, equipment, seasonality */ }
  }
}
3.2 import.session.generate.requested
When: an import asks SSA to create a real session (e.g. cleaning / garden / storehouse stock plan)

Why to Hub: shows “demand” for that type of work

Shape:

json
Copy code
{
  "type": "import.session.generate.requested",
  "ts": "<ISO>",
  "source": "db.index.importToSessionRequests",
  "data": {
    "id": "req_77",
    "householdId": "hh_123",
    "importId": "imp_123",
    "requestedSessionType": "cleaning"
  }
}
3.3 import.failed (optional export)
When: SSA can’t parse an import

Why to Hub: (optional) shows gaps in content

Shape: { type: "import.failed", ... }

4. Inventory & storehouse events
This is high-value data for Hub, because it shows real supply and real shortages. This is what you said you want Hub users to see so they can open grocery stores, farmers markets, meal prep, etc.

4.1 inventory.updated
When: item is created or updated in Dexie inventory table

Why to Hub: inventory patterns ⇒ production opportunities

Shape:

json
Copy code
{
  "type": "inventory.updated",
  "ts": "<ISO>",
  "source": "db.index.inventory",
  "data": {
    "item": {
      "id": "inv_10",
      "householdId": "hh_123",
      "name": "Lamb sausage",
      "quantity": 12,
      "unit": "links",
      "location": "freezer-1",
      "category": "meat"
    },
    "intent": "create"
  }
}
4.2 inventory.shortage.detected
When: updated quantity < minThreshold

Why to Hub: tells Hub “this thing is in demand right now”

Shape:

json
Copy code
{
  "type": "inventory.shortage.detected",
  "ts": "<ISO>",
  "source": "db.index.inventory",
  "data": {
    "item": {
      "id": "inv_10",
      "name": "Lamb sausage",
      "quantity": 2,
      "minThreshold": 6,
      "category": "meat"
    }
  }
}
4.3 storehouse.goal.created
When: an import or user defines “we want to keep X on hand”

Why to Hub: this is “latent demand” — good for production planning

Shape:

json
Copy code
{
  "type": "storehouse.goal.created",
  "ts": "<ISO>",
  "source": "db.index.storehouseGoals",
  "data": {
    "id": "sg_55",
    "householdId": "hh_123",
    "name": "Whole wheat flour",
    "targetQuantity": 50,
    "unit": "lb",
    "priority": "high"
  }
}
4.4 storehouse.stock.fromButchery
When: a butchery session outputs meat/cuts to the storehouse

Why to Hub: shows locally produced items

Shape:

json
Copy code
{
  "type": "storehouse.stock.fromButchery",
  "ts": "<ISO>",
  "source": "db.index.butcherySessions",
  "data": {
    "sessionId": "butch_44",
    "outputs": [
      { "name": "Lamb chops", "qty": 8, "unit": "pcs" }
    ]
  }
}
5. Garden & harvest events
These tell Hub what people are actually growing and when.

5.1 garden.plan.created
When: import or user makes a plan

Why to Hub: aggregate crop planning

Shape:

json
Copy code
{
  "type": "garden.plan.created",
  "ts": "<ISO>",
  "source": "db.index.gardenPlans",
  "data": {
    "id": "gp_101",
    "householdId": "hh_123",
    "name": "Spring 2026 beds",
    "season": "spring",
    "crops": ["collards", "tomatoes", "basil"]
  }
}
5.2 garden.harvest.logged
When: real harvest logged

Why to Hub: real production → farmers markets / co-ops can see what’s in season locally

Shape:

json
Copy code
{
  "type": "garden.harvest.logged",
  "ts": "<ISO>",
  "source": "db.index.gardenHarvests",
  "data": {
    "id": "harv_5",
    "householdId": "hh_123",
    "gardenPlanId": "gp_101",
    "crop": "tomatoes",
    "quantity": 12,
    "unit": "lb"
  }
}
6. Animal & butchery events
These matter because not every household raises animals — the Hub can match households that do with households that need.

6.1 animals.asset.created
When: household registers livestock/animal asset

Why to Hub: track local animal capacity

Shape:

json
Copy code
{
  "type": "animals.asset.created",
  "ts": "<ISO>",
  "source": "db.index.animalAssets",
  "data": {
    "id": "an_100",
    "householdId": "hh_123",
    "species": "sheep",
    "breed": "katahdin",
    "status": "active"
  }
}
6.2 animals.butchery.session.created
When: butchery session is scheduled or logged

Why to Hub: seasonal/local meat availability

Shape:

json
Copy code
{
  "type": "animals.butchery.session.created",
  "ts": "<ISO>",
  "source": "db.index.butcherySessions",
  "data": {
    "id": "butch_44",
    "householdId": "hh_123",
    "animalPlanId": "ap_1",
    "date": "2025-11-02"
  }
}
7. Preservation events
Preservation is how harvests/animals become storehouse. Hub needs to see who preserves what.

7.1 preservation.completed
When: household finishes a preservation batch

Why to Hub: shows durable food supply & skills

Shape:

json
Copy code
{
  "type": "preservation.completed",
  "ts": "<ISO>",
  "source": "db.index.preservationBatches",
  "data": {
    "id": "pres_7",
    "householdId": "hh_123",
    "method": "canning",
    "sourceType": "garden",
    "outputs": [
      { "name": "Tomatoes (quart)", "qty": 10 }
    ]
  }
}
8. Session events (general)
When SSA actually creates work for the household, Hub can learn which tasks people are doing.

8.1 session.created
When: new actionable session is created (cooking, cleaning, garden, animal, preservation)

Why to Hub: real activity, good for service marketplaces

Shape:

json
Copy code
{
  "type": "session.created",
  "ts": "<ISO>",
  "source": "db.index.sessions",
  "data": {
    "id": "sess_999",
    "householdId": "hh_123",
    "type": "cleaning",
    "status": "scheduled",
    "scheduledFor": "2025-11-03T14:00:00.000Z"
  }
}
9. Events usually not sent to Hub
These are often local-only (unless you explicitly decide otherwise):

cleaning.session.updated

garden.care.task.created

meals.plan.updated

import.updated

pricebook.updated

coupons.updated

debug/dev events

You can export them, but by default SSA doesn’t need to flood the Hub.

10. Recap
Exportable (high-value) events:

household.created

household.updated

household.member.added

import.parsed

import.session.generate.requested

inventory.updated

inventory.shortage.detected

storehouse.goal.created

storehouse.stock.fromButchery

garden.plan.created

garden.harvest.logged

animals.asset.created

animals.butchery.session.created

preservation.completed

session.created

Guardrails:

all exported payloads are { type, ts, source, data }

always check featureFlags.familyFundMode

always route through HubPacketFormatter + FamilyFundConnector

always fail silently

That’s the SSA → Hub event list. ✅