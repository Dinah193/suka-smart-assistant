// C:\Users\larho\suka-smart-assistant\src\services\planning\parseRecipeSteps.js
/**
 * parseRecipeSteps (rich, agent- & session-aware; zero deps)
 * ----------------------------------------------------------
 * Turns raw instruction strings into structured steps tailored for your
 * Batch Session Planner, MultiTimerPanel (voice alerts), label printer,
 * storage capacity hints, and safety-aware workflow.
 *
 * What you get per step:
 *  - estimatedTime (minutes) + waitMinutes (rests, proofs, marinade, chilling)
 *  - timers[] with labels and trigger semantics (for MultiTimerPanel)
 *  - temperatures:
 *      • surface/oven temps (e.g., 375°F)
 *      • internal/food-safe targets (e.g., "to 165°F")
 *  - action + phase: PREP | COOK | COOL | PRESERVE | FINISH
 *  - tools/equipment + resources / station hints (prep | range | oven | grill | airfryer | pressure)
 *  - pantry supplies + allergen flags (gluten, dairy, nuts, soy, eggs, shellfish, fish)
 *  - safety tags (raw_poultry, deep_fry, hot_sugar, pressure_canning, water_bath_canning, hot_fill)
 *  - preserving/canning metadata (method, psi, venting, headspace, jar sizes)
 *  - parallelization hints + dependency placeholder (dependsOn)
 *
 * Back-compat preserved: { step, description, estimatedTime, tools, supplies }
 */

const DEFAULT_SUPPLIES = [
  "salt","pepper","oil","olive oil","vegetable oil","butter","sugar","flour",
  "baking powder","baking soda","vinegar","soy sauce","honey","garlic","onion"
];

const ALLERGEN_LEX = {
  dairy: /(milk|butter|cream|cheese|yogurt|half[-\s]?and[-\s]?half|ghee)\b/i,
  eggs: /\b(egg|eggs)\b/i,
  gluten: /\b(wheat|flour(?!less)\b|breadcrumbs?|panko|pasta|semolina|barley|rye)\b/i,
  nuts: /\b(peanut|almond|walnut|pecan|cashew|hazelnut|pistachio)\b/i,
  soy: /\b(soy|tofu|tempeh|edamame|soy sauce|tamari|miso)\b/i,
  shellfish: /\b(shrimp|prawns?|crab|lobster|scallops?|clams?|mussels?|oysters?)\b/i,
  fish: /\b(salmon|tuna|cod|trout|sardines?|anchov(y|ies)|mackerel|tilapia|haddock)\b/i,
};

const TOOL_LEX = [
  { id:"oven",           rx:/\b(preheat|bake|roast|broil)\b/i },
  { id:"sheet_pan",      rx:/\b(sheet pan|baking sheet|tray)\b/i },
  { id:"pan",            rx:/\b(skillet|fry(ing)? pan|saute|sauté|pan[-\s]?sear)\b/i },
  { id:"pot",            rx:/\b(pot|saucepan|stockpot|dutch oven)\b/i },
  { id:"stand_mixer",    rx:/\b(stand mixer|kitchenaid)\b/i },
  { id:"hand_mixer",     rx:/\b(hand mixer)\b/i },
  { id:"whisk",          rx:/\b(whisk)\b/i },
  { id:"blender",        rx:/\b(blend|blender|puree|purée)\b/i },
  { id:"food_processor", rx:/\b(food processor|pulse in (a )?processor)\b/i },
  { id:"bowl",           rx:/\b(mix(ing)? bowl)\b/i },
  { id:"knife",          rx:/\b(chop|slice|dice|mince|julienne)\b/i },
  { id:"grater",         rx:/\b(grate|zest|box grater)\b/i },
  { id:"airfryer",       rx:/\b(air[-\s]?fry|air fryer)\b/i },
  { id:"instant_pot",    rx:/\b(instant pot|pressure cook(er)?|pressure canner)\b/i },
  { id:"slow_cooker",    rx:/\b(slow cook|crock[-\s]?pot|slow cooker)\b/i },
  { id:"rice_cooker",    rx:/\b(rice cooker)\b/i },
  { id:"microwave",      rx:/\b(microwave)\b/i },
  { id:"thermometer",    rx:/\b(thermometer|probe|instant[-\s]?read)\b/i },
  { id:"canner",         rx:/\b(pressure canner|water[-\s]?bath canner)\b/i },
  { id:"vac_sealer",     rx:/\b(vac(uum)?[-\s]?seal(er)?)\b/i },
  { id:"jar",            rx:/\b(mason jar|jars?\b|quart|pint)\b/i },
  { id:"grill",          rx:/\b(grill|grilling)\b/i },
];

const ACTION_ORDER = [
  "preheat","wash","rinse","peel","chop","dice","slice","mince","mix","whisk","knead",
  "marinate","brine","proof","boil","simmer","steam","sear","saute","sauté","bake","roast",
  "broil","grill","airfry","pressure cook","slow cook","blend","rest","cool","pack","label","jar","vac seal","freeze"
];

const INTERNAL_TEMP_RX = /\b(to|until)\s+(?:internal\s+)?temp(?:erature)?\s*(?:reaches|of|is)?\s*(\d{2,3})\s*°?\s*(f|c)\b/i;
const OVEN_TEMP_RX = /(\d{2,3})\s*°?\s*(f|c|degrees\s*f|degrees\s*c)?\b/i;
const TIME_RANGE_RX = /(\d+(?:\.\d+)?)\s*(?:–|-|to)\s*(\d+(?:\.\d+)?)\s*(sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours)\b/i;
const TIME_SINGLE_RX = /(\d+(?:\.\d+)?)\s*(sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours)\b/i;
const HHMM_RX = /\b(\d{1,2}):(\d{2})\b/;

// Canning specifics
const PRESSURE_CANNING_RX = /\b(pressure can(?:ning|ner)|process(?:ing)? at\s*\d+\s*psi|psi\b)/i;
const WATER_BATH_RX = /\b(water[-\s]?bath|boiling[-\s]?water)\b/i;
const PSI_RX = /\b(\d{5,15})\s*psi\b/i; // also allow smaller: /(\d{2}) psi/
const PSI_NUMBER_RX = /\b(\d{2})\s*psi\b/i;
const VENT_RX = /\b(vent|venting)\s*(\d+(?:\.\d+)?)(?:\s*(min|mins|minutes))?\b/i;
const HEADSPACE_RX = /\b(head\s*space|headspace)\s*(\d+\/\d+|\d+(?:\.\d+)?)\s*(inch|in|")?\b/i;
const JAR_SIZE_RX = /\b(pints?|quarts?|half[-\s]?pints?)\b/i;
const HOT_FILL_RX = /\b(hot[-\s]?fill|hot[-\s]?pack)\b/i;

// Cooling & food-safety
const COOL_TO_RX = /\b(cool)\s+(?:to|until)\s*(\d{2,3})\s*°?\s*f\b/i;
const ICE_BATH_RX = /\b(ice bath)\b/i;
const CHILL_RX = /\b(chill(?:ed)?|refrigerate|cool in fridge)\b/i;
const HOT_HOLD_RX = /\b(hot hold|hold hot)\b/i;

function estimateMinutesFromText(text="") {
  const hhmm = text.match(HHMM_RX);
  if (hhmm) {
    const h = parseInt(hhmm[1],10), m = parseInt(hhmm[2],10);
    return h*60 + m;
  }
  const range = text.match(TIME_RANGE_RX);
  if (range) {
    const a = parseFloat(range[1]), b = parseFloat(range[2]), unit = range[3].toLowerCase();
    const mid = (a + b) / 2;
    return toMinutes(mid, unit);
  }
  const single = text.match(TIME_SINGLE_RX);
  if (single) return toMinutes(parseFloat(single[1]), single[2].toLowerCase());

  // keywords fallback
  if (/\b(slow cook|proof|marinate)\b/i.test(text)) return 60;
  if (/\b(bake|roast|simmer|boil|pressure cook|air[-\s]?fry|water[-\s]?bath|process)\b/i.test(text)) return 20;
  if (/\b(chop|mix|whisk|dice|knead|blend|season|label|pack|jar|vac(uum)?[-\s]?seal)\b/i.test(text)) return 5;
  if (/\b(plate|serve)\b/i.test(text)) return 2;
  return 3;
}

function toMinutes(val, unit) {
  if (/sec/.test(unit)) return Math.max(1, Math.round(val / 60));
  if (/hr|hour/.test(unit)) return Math.round(val * 60);
  return Math.round(val);
}

function extractWaitMinutes(text="") {
  // Includes rest/proof/marinate/chill/cool/vent etc. (blocking time)
  if (!/\b(rest|cool|chill|marinate|proof|rise|vent)\b/i.test(text)) return 0;
  const mm = estimateMinutesFromText(text);
  return Math.max(0, mm);
}

function extractTemperature(text="") {
  // Prefer explicit internal temp targets
  const internal = text.match(INTERNAL_TEMP_RX);
  if (internal) {
    const val = parseInt(internal[2], 10);
    const unit = /c/i.test(internal[3]) ? "C" : "F";
    return { value: val, unit, kind: "internal" };
  }
  const m = text.match(OVEN_TEMP_RX);
  if (!m) return null;
  const value = parseInt(m[1],10);
  let unit = "F";
  if (m[2]) unit = /c/i.test(m[2]) ? "C" : "F";
  return { value, unit, kind: "ambient" };
}

function guessAction(text="") {
  const t = text.toLowerCase();
  if (/preheat|heat oven/.test(t)) return "preheat";
  if (/(wash|rinse|peel)/.test(t)) return RegExp.$1;
  if (/(chop|dice|mince|slice|julienne)/.test(t)) return RegExp.$1;
  if (/(mix|combine|whisk|stir)/.test(t)) return /whisk/.test(t) ? "whisk" : "mix";
  if (/(knead)/.test(t)) return "knead";
  if (/(marinat|brine)/.test(t)) return /marinat/.test(t) ? "marinate" : "brine";
  if (/(boil|simmer|steam)/.test(t)) return RegExp.$1;
  if (/(sear|saute|sauté)/.test(t)) return "sear";
  if (/(bake|roast|broil)/.test(t)) return RegExp.$1;
  if (/(grill)/.test(t)) return "grill";
  if (/(air[-\s]?fry)/.test(t)) return "airfry";
  if (/(pressure cook|instant pot)/.test(t)) return "pressure cook";
  if (/(slow cook|crock)/.test(t)) return "slow cook";
  if (/(blend|pur[ée]e)/.test(t)) return "blend";
  if (/(cool|rest|chill|proof|rise)/.test(t)) return "rest";
  if (/(label|jar|vac(uum)?[-\s]?seal|freeze|pack|process)/.test(t)) return "pack";
  return "step";
}

function phaseFromAction(action) {
  if (["preheat","wash","rinse","peel","chop","dice","slice","mince","mix","whisk","knead","marinate","brine","proof"].includes(action)) return "PREP";
  if (["boil","simmer","steam","sear","saute","sauté","bake","roast","broil","grill","airfry","pressure cook","slow cook"].includes(action)) return "COOK";
  if (["rest","cool","chill"].includes(action)) return "COOL";
  if (["pack","label","jar","vac seal","freeze","process"].includes(action)) return "PRESERVE";
  return "FINISH";
}

function extractTools(text="") {
  const ids = new Set();
  TOOL_LEX.forEach(({id, rx}) => { if (rx.test(text)) ids.add(id); });
  return Array.from(ids);
}

function extractSupplies(text="") {
  const found = [];
  for (const s of DEFAULT_SUPPLIES) {
    const rx = new RegExp(`\\b${escapeReg(s)}\\b`, "i");
    if (rx.test(text)) found.push(s);
  }
  return found;
}

function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function resourcesFromTools(toolIds=[]) {
  const ids = new Set(toolIds);
  const res = {};
  if (ids.has("oven") || ids.has("sheet_pan")) res.oven = 1;
  if (ids.has("pan") || ids.has("pot") || ids.has("rice_cooker")) res.burners = 1;
  if (ids.has("stand_mixer") || ids.has("hand_mixer") || ids.has("whisk")) res.mixers = 1;
  if (ids.has("airfryer")) res.airfryers = 1;
  if (ids.has("instant_pot") || ids.has("canner")) res.pressure = 1;
  if (ids.has("slow_cooker")) res.slowcooker = 1;
  if (ids.has("grill")) res.grill = 1;
  return res;
}

function stationFromResources(resources = {}) {
  if (resources.oven) return "oven";
  if (resources.grill) return "grill";
  if (resources.burners) return "range";
  if (resources.airfryers) return "airfryer";
  if (resources.pressure) return "pressure";
  if (resources.slowcooker) return "slow_cooker";
  if (resources.mixers) return "prep";
  return "prep";
}

function safetyTags(text="") {
  const tags = [];
  if (/\b(raw (chicken|poultry|turkey))\b/i.test(text)) tags.push("raw_poultry");
  if (/\b(deep[-\s]?fry|fryer)\b/i.test(text)) tags.push("deep_fry");
  if (/\b(hot sugar|caramel|hard[-\s]?crack)\b/i.test(text)) tags.push("hot_sugar");
  if (PRESSURE_CANNING_RX.test(text)) tags.push("pressure_canning");
  if (WATER_BATH_RX.test(text)) tags.push("water_bath_canning");
  if (HOT_FILL_RX.test(text)) tags.push("hot_fill");
  if (ICE_BATH_RX.test(text)) tags.push("ice_bath");
  if (HOT_HOLD_RX.test(text)) tags.push("hot_hold");
  if (/\b(thaw|defrost)\b/i.test(text)) tags.push("thawing");
  return tags;
}

function allergenTags(text="") {
  const tags = [];
  for (const [k, rx] of Object.entries(ALLERGEN_LEX)) {
    if (rx.test(text)) tags.push(k);
  }
  return tags;
}

/** Build MultiTimerPanel-friendly timer descriptors from a step */
function buildTimers({ description, action, baseMinutes, waitMinutes, temp, canning }) {
  const timers = [];

  // Active timer (cook/heat)
  if (baseMinutes && ["COOK","PRESERVE"].includes(phaseFromAction(action))) {
    timers.push({
      type: "active",
      label: timerLabelFor(action, description, canning),
      minutes: baseMinutes,
      startTrigger: "onStart", // UI: start when user taps "Start Step"
      voiceAlert: true
    });
  }

  // Wait / rest / chill / proof timers
  if (waitMinutes > 0) {
    timers.push({
      type: "wait",
      label: waitLabelFor(description),
      minutes: waitMinutes,
      startTrigger: "afterPrevious",
      voiceAlert: true
    });
  }

  // Temperature target monitor (internal temp)
  if (temp?.kind === "internal") {
    timers.push({
      type: "probe",
      label: `Target ${temp.value}°${temp.unit} internal`,
      targetTemp: `${temp.value}°${temp.unit}`,
      startTrigger: "onStart",
      voiceAlert: true
    });
  }

  // Canning specifics: venting period
  if (canning?.ventMinutes) {
    timers.push({
      type: "wait",
      label: `Venting (${canning.ventMinutes}m)`,
      minutes: canning.ventMinutes,
      startTrigger: "onStart",
      voiceAlert: true
    });
  }

  return timers;
}

function timerLabelFor(action, description, canning) {
  if (canning?.method) {
    if (canning.method === "pressure") {
      const psi = canning.psi ? ` @ ${canning.psi} PSI` : "";
      return `Process${psi}`;
    }
    if (canning.method === "water_bath") return "Water-bath process";
  }
  if (/(bake|roast)/i.test(action)) return "Bake/Roast";
  if (/simmer/i.test(action)) return "Simmer";
  if (/boil/i.test(action)) return "Boil";
  if (/airfry/i.test(action)) return "Air fry";
  if (/grill/i.test(action)) return "Grill";
  if (/pressure cook/i.test(action)) return "Pressure cook";
  if (/slow cook/i.test(action)) return "Slow cook";
  if (/sear|saute|sauté/i.test(action)) return "Pan cook";
  return "Timer";
}

function waitLabelFor(text) {
  if (/marinat/i.test(text)) return "Marinate";
  if (/proof|rise/i.test(text)) return "Proof";
  if (/chill|cool/i.test(text)) return /\b(ice bath)\b/i.test(text) ? "Ice bath" : "Chill/Cool";
  if (/rest/i.test(text)) return "Rest";
  if (/vent/i.test(text)) return "Venting";
  return "Wait";
}

function parseCanningMeta(text="") {
  const meta = {};
  if (PRESSURE_CANNING_RX.test(text)) {
    meta.method = "pressure";
    const psiM = text.match(PSI_NUMBER_RX);
    if (psiM) meta.psi = parseInt(psiM[1], 10);
  } else if (WATER_BATH_RX.test(text)) {
    meta.method = "water_bath";
  }
  const ventM = text.match(VENT_RX);
  if (ventM) meta.ventMinutes = Number.isFinite(+ventM[2]) ? Math.round(+ventM[2]) : undefined;

  const headM = text.match(HEADSPACE_RX);
  if (headM) meta.headspace = headM[2];

  const jarM = text.match(JAR_SIZE_RX);
  if (jarM) meta.jarSize = jarM[0].toLowerCase();

  if (HOT_FILL_RX.test(text)) meta.hotFill = true;

  // process time
  const processMin = estimateMinutesFromText(text);
  if (processMin) meta.processMinutes = processMin;

  return Object.keys(meta).length ? meta : null;
}

function parseCoolingSafety(text="") {
  const out = {};
  const coolTo = text.match(COOL_TO_RX);
  if (coolTo) {
    out.coolTo = parseInt(coolTo[2], 10); // °F target
  }
  out.iceBath = !!text.match(ICE_BATH_RX);
  out.chill = !!text.match(CHILL_RX);
  out.hotHold = !!text.match(HOT_HOLD_RX);
  return Object.keys(out).length ? out : null;
}

/**
 * Parses raw instruction strings into structured steps with timing and metadata.
 * @param {Array<string>} instructions
 * @param {Object} options
 *    - defaultPrepMinutes: number (fallback when no time found; default 3)
 *    - parallelizePrep: boolean (default true)
 *    - attachStations: boolean (default true)  // maps equipment→station for load-balancing
 */
const parseRecipeSteps = (instructions = [], options = {}) => {
  if (!Array.isArray(instructions)) return [];

  const defaultPrepMinutes = Number.isFinite(options.defaultPrepMinutes) ? options.defaultPrepMinutes : 3;
  const parallelizePrep = options.parallelizePrep !== false;
  const attachStations = options.attachStations !== false;

  const steps = instructions
    .filter((line) => typeof line === "string" && line.trim() !== "")
    .map((line, index) => {
      const description = line.trim();

      const temp = extractTemperature(description);
      const action = guessAction(description);
      const phase = phaseFromAction(action);

      // time estimation
      const baseMinutes = estimateMinutesFromText(description) || defaultPrepMinutes;
      const waitMinutes = extractWaitMinutes(description);
      const estimatedTime = Math.max(1, baseMinutes);

      const tools = extractTools(description);
      const supplies = extractSupplies(description);
      const resources = resourcesFromTools(tools);

      const allergens = allergenTags(description);
      const safety = safetyTags(description);

      const canning = parseCanningMeta(description);
      const cooling = parseCoolingSafety(description);

      const timers = buildTimers({
        description,
        action,
        baseMinutes,
        waitMinutes,
        temp,
        canning
      });

      // parallelization hint: allow overlapping for PREP and passive waits
      const canParallelize =
        phase === "PREP" ? !!parallelizePrep :
        ["rest","cool"].includes(action) ? true :
        false;

      const station = attachStations ? stationFromResources(resources) : undefined;

      return {
        // Back-compat fields:
        step: index + 1,
        description,
        estimatedTime,          // minutes
        tools,
        supplies,

        // Rich metadata for planners/schedulers:
        action,
        phase,                  // PREP | COOK | COOL | PRESERVE | FINISH
        waitMinutes,            // separate rest/proof/chill
        temperature: temp ? `${temp.value}°${temp.unit}` : null,
        temperatureKind: temp?.kind || null, // 'internal' | 'ambient' | null
        equipment: tools.slice(),
        resources,              // { oven:1, burners:1, mixers:1, ... }
        station,                // prep | range | oven | grill | airfryer | pressure | slow_cooker
        canParallelize,
        dependsOn: [],          // left empty; scheduler can thread if desired
        safetyTags: safety,     // for certifications/assignments & UI warnings
        allergens,              // for user matching & UI callouts
        orderHint: ACTION_ORDER.indexOf(action), // helps sorting if needed

        // Session & label/preserving helpers:
        timers,                 // [{type,label,minutes,startTrigger,...}]
        preserving: canning,    // { method, psi, ventMinutes, headspace, jarSize, hotFill, processMinutes }
        cooling: cooling        // { coolTo, iceBath, chill, hotHold }
      };
    });

  return steps;
};

export default parseRecipeSteps;

// Named exports for tests/other modules
export {
  estimateMinutesFromText,
  extractWaitMinutes,
  extractTemperature,
  extractTools,
  extractSupplies,
  guessAction,
  phaseFromAction,
  resourcesFromTools,
  safetyTags,
  allergenTags,
  parseCanningMeta,
  parseCoolingSafety
};
