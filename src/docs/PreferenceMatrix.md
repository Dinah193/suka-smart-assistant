C:\Users\larho\suka-smart-assistant\src\docs\PreferenceMatrix.md
# SSA Preference Matrix — Keys, Defaults, and Domain Applicability

> imports (scrape/ingest) → intelligence (normalize/enrich) → **automation (rules → tasks/sessions)**  
> Preferences steer normalization (units, substitutions), automation (schedules, concurrency),
> notifications (quiet hours), and export policy. This is a quick-reference for **all preference keys**
> defined in `src/schemas/Preference.schema.json`.

---

## 0) Scope & Inheritance

**Where do preferences apply?**

- `scope.kind` = `"household"` *(default)* or `"user"`.
- Resolution order when both exist: **user overrides household**, otherwise use household.  
- Runtime services should cache a **resolved view**:
  ```json
  {
    "units": {...}, "dietary": {...}, "kitchen": {...}, "cleaning": {...},
    "garden": {...}, "animal": {...}, "storehouse": {...},
    "notifications": {...}, "automation": {...},
    "safety": {...}, "privacy": {...}, "exportPolicy": {...}, "scraping": {...}
  }
1) Summary Matrix
Section	Key	Type	Default	Domains Affected
scope	kind	enum(household,user)	household	all
scope	timezone	string (IANA)	—	automation, notifications, scheduler
scope	locale	string (BCP47)	—	normalization (labels), notifications
scope	region	string (ISO-3166)	—	garden (zones), storehouse (retail)
units	system	enum(metric,imperial,mixed)	mixed	normalization (all domains)
units	temperature	enum(F,C)	F	cooking, cleaning, preservation, garden
units	volume	enum(L,mL,cup,fl_oz,qt,gal)	cup	cooking, preservation
units	mass	enum(g,kg,oz,lb)	g	cooking, preservation
units	length	enum(mm,cm,m,inch,ft)	inch	garden (spacing), how-to
dietary	servingsDefault	integer	4	cooking (task sizing)
dietary	allergens	string[]	[]	cooking (filter), storehouse (alerts)
dietary	avoidIngredients	string[]	[]	cooking (substitution), storehouse
dietary	preferredIngredients	string[]	[]	cooking (ranking)
dietary	styles	string[]	[]	cooking (rule hints)
dietary	sodiumMaxMgPerDay	integer	—	analytics/hints
dietary	sugarsMaxGPerDay	integer	—	analytics/hints
kitchen	equipmentAvailable	string[]	[]	cooking (planner, readiness)
kitchen	substitutions[].{name,alternatives[]}	array<object>	[]	cooking (normalizer)
kitchen	temperatureTargets.<label>	map → {targetTempF,restMinutes}	{}	cooking (safety overrides)
cleaning	preferredAgents	string[]	[]	cleaning (normalizer/rules)
cleaning	agentConcentrationPPM.<agent>	map<string,number>	{}	cleaning (safety defaults)
cleaning	contactTimeSecDefault	integer	60	cleaning
cleaning	fragranceFree	boolean	false	cleaning (product selection)
garden	usdaZone	string	—	garden (seasonality)
garden	beds[].{id,name,areaSqFt,sunExposure}	array<object>	[]	garden (scheduling, capacity)
garden	preferredVendors	string[]	[]	garden (source ranking)
garden	soilTargets.{pH,moisturePctMin/Max}	object	—	garden (readiness thresholds)
animal	species	string[]	[]	animal (task templates)
animal	vetContacts	string[]	[]	animal (notify, provenance)
animal	feedVendors	string[]	[]	animal/storehouse
storehouse	lowStockThresholds[]	array<patch-like>	[]	storehouse (shortage events)
storehouse	firstExpireFirstOut	boolean	true	storehouse
storehouse	shoppingBudget	money	—	storehouse (analytics)
storehouse	preferredRetailers	string[]	[]	storehouse (pricing sources)
notifications	channels[]	array<channelPreference>	at least one required	all (alerts)
notifications	quietHours[]	array<timeWindow>	[]	all (non-critical suppression)
notifications	criticalBypassQuietHours	boolean	true	all
automation	suggestionWindows[]	array<timeWindow>	[]	planner across domains
automation	maxConcurrentTasks	integer	3	planner
automation	defaultDurations.<domain>	isoDuration	—	task scheduling
safety	ppePreferred	string[]	[]	cleaning, animal, maintenance
safety	tempTargetsF.<label>	map<string,number>	{}	cooking (override)
safety	sanitizer.{contactTimeSecMin,concentrationPPMMin}	object	{60,150?} if set by user	cleaning
safety	allergenStrictMode	boolean	true	cooking (filter strictness)
privacy	retainProvenanceDays	integer	90	scraper/normalizer storage
privacy	shareAnonymizedMetrics	boolean	false	analytics/export
exportPolicy	familyFundModeDefault	boolean	false	hub export
exportPolicy	shareLevelDefault	enum(none,summary,full)	summary	hub export
exportPolicy	allowDomains	string[]	[]	hub export
scraping	allowExternalImports	boolean	true	scraping
scraping	siteAllowList	string[] (hostnames)	[]	scraping
scraping	siteDenyList	string[] (hostnames)	[]	scraping
scraping	maxRequestsPerMinutePerHost	integer	12	scraping/scheduler

Tip: Add keys conservatively; new options should be additive. See schemas/README.txt for versioning.

2) Domain-Specific Notes
Cooking
Units drive normalization (e.g., convert “½ cup” → qty: 118 mL when system=metric but display may differ).

Dietary filters exclude allergens and avoidIngredients during recipe synthesis and substitution planning.

Kitchen.equipmentAvailable toggles step variants (e.g., “Instant Pot” vs “Dutch oven”).

Safety.tempTargetsF / kitchen.temperatureTargets override default doneness/hold recommendations.

Automation.defaultDurations.cooking seeds planning when recipe metadata is missing.

Cleaning
cleaning.preferredAgents / agentConcentrationPPM / contactTimeSecDefault set sanitizer guidance in normalized tables and readiness checks.

safety.sanitizer provides minimums; rules can alert if parsed guidance is weaker.

Garden
garden.usdaZone and soilTargets gate planting windows and readiness (ResourceReadiness.kind = "soil").

beds[] inform capacity and location tagging for tasks (e.g., “Plant carrots — Bed A”).

Animal
animal.species activates species-specific task libraries (feeding, vaccination).

vetContacts used for notifications or link-outs in animal health tasks.

Storehouse
lowStockThresholds[] directly feed inventory.shortage.detected events when live counts fall below min.

firstExpireFirstOut changes picking strategy; analytics and UI should honor it.

preferredRetailers rank pricing sources and rule suggestions.

Notifications
channels[] define routing. Example:

json
Copy code
{ "channel": "email", "enabled": true, "address": "household@example.com", "severity": ["warning","critical"] }
quietHours[] format: { "days": ["MO","TU"], "startLocal": "21:30", "endLocal": "07:00" }.

Automation
suggestionWindows[] are soft constraints; the scheduler still enforces rate limits and host robots.

maxConcurrentTasks keeps the household schedule sane across domains.

Safety
ppePreferred becomes default step hints (gloves/goggles).

allergenStrictMode (true): hard-fail on recipes that include allergens unless explicit override in a session.

Export & Privacy
exportPolicy.familyFundModeDefault controls default Hub export; individual actions still call exportToHubIfEnabled.

privacy.retainProvenanceDays limits how long scraped provenance is stored.

Scraping
scraping.siteAllowList / siteDenyList are consulted by ScraperEngine & ScraperScheduler; allowlist takes precedence when non-empty.

maxRequestsPerMinutePerHost maps to ScraperScheduler.setRateLimitForHost.

3) Example: Minimal Household Preferences
json
Copy code
{
  "version": "1.0.0",
  "scope": { "kind": "household", "householdId": "hh_123", "timezone": "America/Chicago", "locale": "en-US", "region": "US" },
  "units": { "system": "mixed", "temperature": "F", "volume": "cup", "mass": "g", "length": "inch" },
  "notifications": {
    "channels": [
      { "channel": "inbox", "enabled": true, "severity": ["info","warning","critical"] }
    ],
    "quietHours": [{ "days": ["MO","TU","WE","TH","FR","SA","SU"], "startLocal": "21:30", "endLocal": "07:00" }]
  },
  "automation": { "maxConcurrentTasks": 3 }
}
4) Example: User Overrides Household
Household sets general cooking style; a user prefers metric & vegetarian:

json
Copy code
// household
{ "units": { "system": "mixed", "temperature": "F" }, "dietary": { "styles": ["balanced"] } }
// user
{ "units": { "system": "metric", "temperature": "C" }, "dietary": { "styles": ["vegetarian"] } }
Resolved (user session): units.system = metric, temperature = C, styles = ["vegetarian"].

5) Change Management
Add only optional keys in MINOR updates; keep defaults sensible.

Document new keys here and in schemas/README.txt.

When removing/renaming (MAJOR), ship a migration helper and update the matrix.

6) Quick Checklist for Using Preferences in Code
 Fetch resolved preferences (user over household).

 Respect units during normalization; keep canonical storage (e.g., grams, liters) and convert for display.

 Apply dietary and safety when creating tasks (filters & targets).

 Honor suggestionWindows and quietHours in planners and notifiers.

 Enforce lowStockThresholds during inventory updates.

 Follow exportPolicy before calling exportToHubIfEnabled.

Source of truth: src/schemas/Preference.schema.json
Related: SynthesisPipeline.md, RuleLibraryOverview.md, ScraperSources.json, ResourceReadiness.schema.json