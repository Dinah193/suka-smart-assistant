# server_py.py
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional, Callable
import traceback

app = FastAPI(title="Suka Orchestrator", version="0.1.0")

# ------------------------- CORS -------------------------
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173", "http://127.0.0.1:5173",  # Vite dev server
        "http://localhost:3000", "http://127.0.0.1:3000",  # Next.js (if you switch later)
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ------------------------- Core Schemas -------------------------

class TemplateStep(BaseModel):
    id: str
    kind: str  # "rule" | "transform" | "action"
    description: Optional[str] = None
    code: Optional[str] = None          # python code to eval/exec in a safe sandbox
    jinja: Optional[str] = None         # optional templating
    uses: Optional[List[str]] = None    # names of inputs/context keys
    emits: Optional[List[str]] = None   # names of outputs/context keys

class AITemplate(BaseModel):
    id: str
    name: str
    purpose: str
    triggers: List[str] = []
    inputs_spec: Dict[str, str] = {}    # {name: "type/description"}
    steps: List[TemplateStep] = []
    actions_spec: Dict[str, str] = {}   # describes action payloads
    fallbacks: List[str] = []
    outputs_spec: Dict[str, str] = {}

class AgentRequest(BaseModel):
    agent: str
    template_id: Optional[str] = None
    trigger: Optional[str] = None
    context: Dict[str, Any] = Field(default_factory=dict)
    options: Dict[str, Any] = Field(default_factory=dict)

class RunResult(BaseModel):
    ok: bool
    agent: str
    template_id: Optional[str] = None
    actions: List[Dict[str, Any]] = Field(default_factory=list)
    updates: Dict[str, Any] = Field(default_factory=dict)
    logs: List[str] = Field(default_factory=list)
    error: Optional[str] = None

# ------------------------- In-Memory Stores -------------------------

TEMPLATES: Dict[str, AITemplate] = {}
SUBSCRIBERS: Dict[str, List[str]] = {}  # trigger -> list of agents
REGISTRY: Dict[str, Callable] = {}      # agent_name -> call(context) -> RunResult
STATE: Dict[str, Any] = {
    "inventory": {},
    "garden": {},
    "animals": {},
    "mealplans": {},
    "calendar": [],
    "preferences": {"zone": "7b"},
}

def log(result: RunResult, msg: str):
    result.logs.append(msg)

# --- tiny helpers for ISO date math & scheduling used by templates ---
from datetime import date as _dt_date, timedelta as _dt_timedelta

def iso_add_days(iso: str, days: int) -> str:
    d = _dt_date.fromisoformat(iso)
    return (d + _dt_timedelta(days=int(days))).isoformat()

def next_free_date(start_iso: str, forbid_tags: List[str]) -> str:
    """
    Given a start date and a list of tags to avoid (e.g., ['cleaning']),
    walk forward up to 14 days to find the first date with no conflicting events.
    """
    try:
        d = _dt_date.fromisoformat(start_iso)
    except Exception:
        d = _dt_date.today()
    for _ in range(14):
        day = d.isoformat()
        clashes = [
            e for e in STATE["calendar"]
            if e.get("date") == day and set(e.get("tags", [])) & set(forbid_tags or [])
        ]
        if not clashes:
            return day
        d = d + _dt_timedelta(days=1)
    return d.isoformat()

# ------------------------- Template Engine -------------------------

def safe_eval(expr: str, ctx: Dict[str, Any]):
    # very small sandbox; extend if needed
    allowed = {"min": min, "max": max, "round": round, "len": len, "sum": sum, "any": any, "all": all}
    return eval(expr, {"__builtins__": {}}, {**allowed, **ctx})

def safe_exec(code: str, ctx: Dict[str, Any]):
    exec(code, {"__builtins__": {}}, ctx)
    return ctx

def run_template(tpl: AITemplate, context: Dict[str, Any], result: RunResult):
    # expose helpers to template code
    ctx = {
        **context,
        "iso_add_days": iso_add_days,
        "_dt_date": _dt_date,
        "next_free_date": next_free_date,
    }
    actions: List[Dict[str, Any]] = []
    for step in tpl.steps:
        try:
            if step.kind == "rule" and step.code:
                log(result, f"RULE {step.id}")
                out = safe_eval(step.code, ctx)
                if step.emits:
                    if len(step.emits) == 1:
                        ctx[step.emits[0]] = out
                    else:
                        for k, v in zip(step.emits, out if isinstance(out, (list, tuple)) else [out]):
                            ctx[k] = v
            elif step.kind == "transform" and step.code:
                log(result, f"TRANSFORM {step.id}")
                safe_exec(step.code, ctx)
            elif step.kind == "action" and step.code:
                log(result, f"ACTION {step.id}")
                payload = safe_eval(step.code, ctx)
                if not isinstance(payload, dict):
                    payload = {"value": payload}
                payload.setdefault("action_id", step.id)
                actions.append(payload)
        except Exception as e:
            log(result, f"STEP ERROR {step.id}: {e}")
            raise
    return ctx, actions

# ------------------------- Built-in Actions (side-effects) -------------------------

def apply_actions(actions: List[Dict[str, Any]]):
    for a in actions:
        t = a.get("type")
        if t == "inventory.adjust":
            item = a["item"]; delta = a.get("delta", 0)
            STATE["inventory"][item] = STATE["inventory"].get(item, 0) + delta
        elif t == "calendar.add":
            STATE["calendar"].append({
                "title": a.get("title", "Untitled"),
                "date": a.get("date"),
                "tags": a.get("tags", []),
                "meta": a,
            })
        elif t == "garden.plan":
            STATE["garden"]["plan"] = a.get("plan", [])
        # add more as needed

# ------------------------- Agent Registration -------------------------

def register_agent(name: str):
    def _wrap(fn):
        REGISTRY[name] = fn
        return fn
    return _wrap

def subscribe(trigger: str, agent_name: str):
    SUBSCRIBERS.setdefault(trigger, []).append(agent_name)

def subscribe_once(trigger: str, agent_name: str):
    """Idempotent subscription to avoid duplicates across reloads."""
    agents = SUBSCRIBERS.setdefault(trigger, [])
    if agent_name not in agents:
        agents.append(agent_name)

# ------------------------- Templates -------------------------

def load_default_templates():
    # Harvest & Preservation Sync (now avoids cleaning days)
    TEMPLATES["harvest_preservation"] = AITemplate(
        id="harvest_preservation",
        name="Harvest & Preservation Sync",
        purpose="Avoid waste by aligning harvest windows with preservation slots.",
        triggers=["crop.maturity_window", "garden.estimate_ready"],
        inputs_spec={"upcoming": "list of {crop, qty, window_start, window_end}", "prefs": "preservation prefs"},
        steps=[
            TemplateStep(
                id="score_surplus",
                kind="rule",
                description="flag crops exceeding fresh-keep capacity",
                code="[{**c, 'surplus': max(0, c.get('qty',0) - c.get('fresh_capacity',0))} for c in upcoming]",
                emits=["scored"],
                uses=["upcoming"]
            ),
            TemplateStep(
                id="build_preservation_jobs",
                kind="transform",
                description="map surplus to jobs and avoid cleaning days",
                code=(
                    "jobs = []\n"
                    "for c in scored:\n"
                    "  method = (prefs.get(c['crop']) or 'freeze') if c.get('surplus',0)>0 else None\n"
                    "  if method:\n"
                    "    start = c.get('window_start') or _dt_date.today().isoformat()\n"
                    "    safe_date = next_free_date(start, ['cleaning'])\n"
                    "    jobs.append({'type':'calendar.add','title':f\"Preserve {c['crop']} ({method})\",\n"
                    "                'date': safe_date,'tags':['preservation',method,'garden'],'qty':c['surplus']})\n"
                ),
                emits=["jobs"]
            ),
            TemplateStep(
                id="emit_actions",
                kind="action",
                code="{'type':'batch','actions': jobs}",
                emits=[]
            ),
        ],
        actions_spec={"calendar.add":"adds preserve job"},
        fallbacks=["if no surplus, no-op"],
        outputs_spec={"jobs":"list of calendar jobs"}
    )

    # Soil & Water Health Keeper
    TEMPLATES["soil_water_keeper"] = AITemplate(
        id="soil_water_keeper",
        name="Soil & Water Health Keeper",
        purpose="Keep soil fertile and moisture balanced.",
        triggers=["weather.rain", "irrigation.cycle", "soil.test_due"],
        inputs_spec={"soil": "pH, NPK, moisture", "rules":"watering windows"},
        steps=[
            TemplateStep(
                id="need_amend",
                kind="rule",
                code="{'lime': soil['pH']<6.2, 'sulfur': soil['pH']>7.2}",
                emits=["amend"]
            ),
            TemplateStep(
                id="schedule_actions",
                kind="transform",
                code=(
                    "acts=[]\n"
                    "if amend['lime']: acts.append({'type':'inventory.adjust','item':'garden_lime','delta':-5})\n"
                    "if amend['sulfur']: acts.append({'type':'inventory.adjust','item':'elemental_sulfur','delta':-3})\n"
                    "if soil.get('moisture','ok')=='low':\n"
                    "  acts.append({'type':'calendar.add','title':'Irrigation block','date': rules.get('next_slot'),'tags':['irrigation','garden']})\n"
                ),
                emits=["acts"]
            ),
            TemplateStep(id="emit", kind="action", code="{'type':'batch','actions': acts}")
        ],
        actions_spec={"inventory.adjust":"decrement amendments","calendar.add":"add watering"},
        fallbacks=["mulch if drought persists"],
        outputs_spec={"acts":"list"}
    )

    # Companion Plant Layout Builder
    TEMPLATES["companion_layout"] = AITemplate(
        id="companion_layout",
        name="Companion Plant Layout Builder",
        purpose="Arrange plants for mutual benefit.",
        triggers=["garden.preplanting"],
        inputs_spec={"crops":"list", "beds":"list", "chart":"companion matrix"},
        steps=[
            TemplateStep(
                id="layout",
                kind="rule",
                code="[{ 'bedId': b['bedId'], 'rows':[ {'crop':c, 'row':i+1} for i,c in enumerate(crops[:b.get('rows',3)]) ] } for b in beds]",
                emits=["plan"]
            ),
            TemplateStep(
                id="emit_plan",
                kind="action",
                code="{'type':'garden.plan','plan': plan}"
            )
        ],
        actions_spec={"garden.plan":"save bed plan"},
        fallbacks=["monocrop if conflicts"],
        outputs_spec={"plan":"bed map"}
    )

    # Cleaning Routine (rotating rooms; date-aware)
    TEMPLATES["cleaning_routine"] = AITemplate(
        id="cleaning_routine",
        name="Cleaning Routine",
        purpose="Suggest a short rotating cleaning plan and add tasks to the calendar.",
        triggers=["cleaning.suggest"],
        inputs_spec={
            "rooms": "list of room names",
            "start": "YYYY-MM-DD ISO date to begin",
            "days": "integer number of days to plan",
            "duration_min": "minutes per task (int)"
        },
        steps=[
            TemplateStep(
                id="build_cleaning_jobs",
                kind="transform",
                description="Rotate through rooms and create day-by-day tasks (these define cleaning blocks)",
                code=(
                    "jobs = []\n"
                    "rooms = rooms or ['Kitchen','Bathroom','Bedrooms']\n"
                    "start = start or _dt_date.today().isoformat()\n"
                    "try:\n"
                    "  duration = int(duration_min)\n"
                    "except Exception:\n"
                    "  duration = 30\n"
                    "n = int(days or 3)\n"
                    "for i in range(n):\n"
                    "  room = rooms[i % len(rooms)]\n"
                    "  day = iso_add_days(start, i)\n"
                    "  jobs.append({\n"
                    "    'type':'calendar.add',\n"
                    "    'title': f'Clean {room} ({duration} min)',\n"
                    "    'date': day,\n"
                    "    'tags': ['cleaning','routine']\n"
                    "  })\n"
                ),
                emits=["jobs"]
            ),
            TemplateStep(
                id="emit_actions",
                kind="action",
                code="{'type':'batch','actions': jobs}"
            )
        ],
        actions_spec={"calendar.add": "adds cleaning task per day"},
        fallbacks=["Skip if rooms list empty"],
        outputs_spec={"jobs": "list of cleaning calendar jobs"}
    )

    # Animals → Compost (resource cycling) — FIXED STRINGS
    TEMPLATES["animals_to_compost"] = AITemplate(
        id="animals_to_compost",
        name="Animals → Compost",
        purpose="Convert stall cleanouts/coop litter into compost inventory + reminders.",
        triggers=["animals.cleanout"],
        inputs_spec={"waste_lbs": "float", "carbon_source": "straw|leaves|chips"},
        steps=[
            TemplateStep(
                id="update_inventory_and_reminder",
                kind="transform",
                code=(
                    "acts = []\n"
                    "w = float(waste_lbs or 0)\n"
                    "if w:\n"
                    "  acts.append({'type':'inventory.adjust','item':'compost_greens_lbs','delta': w})\n"
                    "safe_day = _dt_date.today().isoformat()\n"
                    "# Add a reminder to turn the compost pile today\n"
                    "acts.append({'type':'calendar.add','title':'Turn compost pile','date': safe_day,'tags':['compost','garden']})\n"
                    "jobs = acts\n"
                ),
                emits=["jobs"]
            ),
            TemplateStep(id="emit", kind="action", code="{'type':'batch','actions': jobs}")
        ],
        outputs_spec={"jobs":"list"}
    )

load_default_templates()

# ---- Trigger → Agent wiring (runs once; safe across reloads) ----
subscribe_once("garden.estimate_ready", "gardenHarvestAgent")
subscribe_once("soil.test_due", "soilAndWaterAgent")
subscribe_once("garden.preplanting", "companionLayoutAgent")
subscribe_once("cleaning.suggest", "cleaningRoutineAgent")
subscribe_once("animals.cleanout", "resourceCyclerAgent")

# ------------------------- Template Lookup Helper -------------------------

def require_template(template_id: Optional[str], fallback_id: str) -> AITemplate:
    """
    Enforces that a template exists, or raises a 404 HTTPException.
    """
    key = template_id or fallback_id
    tpl = TEMPLATES.get(key)
    if tpl is None:
        raise HTTPException(status_code=404, detail=f"Template '{key}' not found")
    return tpl

# ------------------------- Orchestrator -------------------------

def run_agent(agent_name: str, context: Dict[str, Any], template_id: Optional[str]=None, trigger: Optional[str]=None) -> RunResult:
    if agent_name not in REGISTRY:
        return RunResult(ok=False, agent=agent_name, error="Unknown agent")
    return REGISTRY[agent_name](context=context, template_id=template_id, trigger=trigger)

def emit_trigger(trigger: str, event: Dict[str, Any]) -> List[RunResult]:
    results: List[RunResult] = []
    for agent_name in SUBSCRIBERS.get(trigger, []):
        res = run_agent(agent_name, context=event, trigger=trigger)
        results.append(res)
    return results

# ------------------------- Agents -------------------------

@register_agent("gardenHarvestAgent")
def garden_harvest_agent(context: Dict[str, Any], template_id: Optional[str], trigger: Optional[str]) -> RunResult:
    tpl = require_template(template_id, "harvest_preservation")
    result = RunResult(ok=True, agent="gardenHarvestAgent", template_id=tpl.id)
    try:
        ctx, actions = run_template(tpl, context, result)
        flattened: List[Dict[str, Any]] = []
        for a in actions:
            if a.get("type") == "batch":
                flattened.extend(a.get("actions", []))
            else:
                flattened.append(a)
        apply_actions(flattened)
        result.actions = flattened
        result.updates = {"inventory": STATE["inventory"], "calendar": STATE["calendar"]}
    except Exception as e:
        result.ok = False
        result.error = f"{e}\n{traceback.format_exc()}"
    return result

@register_agent("soilAndWaterAgent")
def soil_and_water_agent(context: Dict[str, Any], template_id: Optional[str], trigger: Optional[str]) -> RunResult:
    tpl = require_template(template_id, "soil_water_keeper")
    result = RunResult(ok=True, agent="soilAndWaterAgent", template_id=tpl.id)
    try:
        ctx, actions = run_template(tpl, context, result)
        flattened: List[Dict[str, Any]] = []
        for a in actions:
            if a.get("type") == "batch":
                flattened.extend(a.get("actions",[]))
            else:
                flattened.append(a)
        apply_actions(flattened)
        result.actions = flattened
        result.updates = {"inventory": STATE["inventory"], "calendar": STATE["calendar"]}
    except Exception as e:
        result.ok = False
        result.error = str(e)
    return result

@register_agent("companionLayoutAgent")
def companion_layout_agent(context: Dict[str, Any], template_id: Optional[str], trigger: Optional[str]) -> RunResult:
    tpl = require_template(template_id, "companion_layout")
    result = RunResult(ok=True, agent="companionLayoutAgent", template_id=tpl.id)
    try:
        ctx, actions = run_template(tpl, context, result)
        flattened: List[Dict[str, Any]] = []
        for a in actions:
            if a.get("type") == "batch":
                flattened.extend(a.get("actions", []))
            else:
                flattened.append(a)
        apply_actions(flattened)
        result.actions = flattened
        result.updates = {"garden": STATE["garden"]}
    except Exception as e:
        result.ok = False
        result.error = str(e)
    return result

@register_agent("cleaningRoutineAgent")
def cleaning_routine_agent(context: Dict[str, Any], template_id: Optional[str], trigger: Optional[str]) -> RunResult:
    tpl = require_template(template_id, "cleaning_routine")
    result = RunResult(ok=True, agent="cleaningRoutineAgent", template_id=tpl.id)
    try:
        ctx, actions = run_template(tpl, context, result)
        flattened: List[Dict[str, Any]] = []
        for a in actions:
            if a.get("type") == "batch":
                flattened.extend(a.get("actions", []))
            else:
                flattened.append(a)
        apply_actions(flattened)
        result.actions = flattened
        result.updates = {"calendar": STATE["calendar"]}
    except Exception as e:
        result.ok = False
        result.error = str(e)
    return result

@register_agent("resourceCyclerAgent")
def resource_cycler_agent(context: Dict[str, Any], template_id: Optional[str], trigger: Optional[str]) -> RunResult:
    tpl = require_template(template_id, "animals_to_compost")
    result = RunResult(ok=True, agent="resourceCyclerAgent", template_id=tpl.id)
    try:
        ctx, actions = run_template(tpl, context, result)
        flattened: List[Dict[str, Any]] = []
        for a in actions:
            if a.get("type") == "batch":
                flattened.extend(a.get("actions", []))
            else:
                flattened.append(a)
        apply_actions(flattened)
        result.actions = flattened
        result.updates = {"inventory": STATE["inventory"], "calendar": STATE["calendar"]}
    except Exception as e:
        result.ok = False
        result.error = str(e)
    return result

# ------------------------- Routes -------------------------

@app.get("/templates")
def list_templates():
    return [t.model_dump() for t in TEMPLATES.values()]

@app.post("/agents/run", response_model=RunResult)
def run_agents(req: AgentRequest):
    # Validate template up-front if provided
    if req.template_id:
        _ = require_template(req.template_id, req.template_id)
    return run_agent(req.agent, req.context, template_id=req.template_id, trigger=req.trigger)

@app.post("/events/emit")
def emit(req: Dict[str, Any]):
    trig = req.get("trigger")
    if not trig:
        raise HTTPException(400, "missing trigger")
    results = [r.model_dump() for r in emit_trigger(trig, req.get("event", {}))]
    return {"ok": True, "trigger": trig, "results": results}

@app.post("/preferences/meal-focus")
def set_meal_focus(pref: Dict[str, Any]):
    focus = pref.get("focus_crops") or pref.get("focus") or []
    if not isinstance(focus, list):
        raise HTTPException(400, "focus_crops must be a list")
    STATE["preferences"]["meal_focus"] = [str(x).lower() for x in focus]
    return {"ok": True, "focus_crops": STATE["preferences"]["meal_focus"]}

@app.get("/state")
def get_state():
    return STATE
