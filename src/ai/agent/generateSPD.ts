// src/ai/agent/generateSPD.ts
/* Generates a Suka Portable Doc (SPD): YAML front-matter + Markdown body.
   - No @/ path aliases
   - Defensive shims for callLLM and Dexie
   - Supports multiple templates via TEMPLATE_MAP
*/

import { buildHouseholdContext } from "../context/buildContext";

// Templates (relative, JSON)
import tplMeal     from "../templates/meal-plan-weekly.suka.json";
import tplCleaning from "../templates/cleaning-rotation.suka.json";
import tplGarden   from "../templates/garden-calendar.suka.json";
import tplAnimals  from "../templates/animal-care-week.suka.json";

// Dexie (relative) – kept very loose to avoid type issues if not present
// If your DB entry lives elsewhere, adjust this path.
import DexieDBRaw from "../../db";

// ---------- Loose types / shims ----------
type AnyDexie = any;
const DexieDB: AnyDexie = (DexieDBRaw as AnyDexie) || {};

// Prefer the real agent if available; otherwise use a shim
// If you DO have "@/agents/base/AgentCore", keep it there for the app path,
// but for this background-friendly file we avoid the alias and provide a fallback.
type CallLLMFn = (prompt: string, opts?: any) => Promise<string>;
let callLLM: CallLLMFn = async (prompt: string) => {
  // Fallback to window.callLLM if the app injected it
  if (typeof window !== "undefined" && (window as any).callLLM) {
    return (window as any).callLLM(prompt, { model: "gpt-4o-mini", temperature: 0.3, max_tokens: 1500 });
  }
  // Last-resort shim: return the prompt wrapped (so UI still works during wiring)
  console.warn("[generateSPD] callLLM shim in use. Provide a real AgentCore for production.");
  return `# Draft (shim)\n\n> LLM unavailable. Prompt was:\n\n\`\`\`\n${prompt}\n\`\`\`\n`;
};

// If you want to hard-wire your real agent (when aliases are set up), uncomment & adapt:
// import { callLLM as realCallLLM } from "../../agents/base/AgentCore";
// callLLM = realCallLLM;

// ---------- Template map ----------
const TEMPLATE_MAP: Record<string, any> = {
  "meal-plan-weekly": tplMeal,
  "cleaning-rotation": tplCleaning,
  "garden-calendar": tplGarden,
  "animal-care-week": tplAnimals,
};

// ---------- Prompts ----------
const OUTLINE_PROMPT = (tpl: any, ctx: any) => `
You are Suka’s household planning expert.
Create a concise outline for "${tpl.title}".
Profile: ${JSON.stringify(ctx.profile)}
Goals: ${JSON.stringify(ctx.goals)}
Constraints: ${JSON.stringify(ctx.constraints)}
Dietary: ${JSON.stringify(ctx.dietary)}
Time (hrs/wk): ${JSON.stringify(ctx.weeklyHrs)}
Budget: ${JSON.stringify(ctx.budget)}
Units: ${ctx.unitSystem}
Relevant data:
- MealPlan items: ${ctx.mealPlan?.length || 0}
- Cleaning tasks: ${ctx.cleaning?.length || 0}
- Garden items: ${ctx.garden?.length || 0}
- Animal groups: ${ctx.animals?.length || 0}
Sections: ${JSON.stringify(tpl.sections)}

Return JSON: { title, sections: [{id, heading, bullets[]}] }.
`.trim();

const DRAFT_PROMPT = (tpl: any, outlineJson: string, unitSystem: string) => `
Draft the full Markdown document for this outline:
${outlineJson}

Tone: ${tpl.tone}
Use headings and lists. Convert quantities & temperatures for ${unitSystem}.
Where applicable, pull hints from context:
- Cleaning: preferred zones, user cleaning tasks/inventory if present
- Garden: crops, beds, preservation tags, frost-window heuristics
- Animals: species, feed types, care routines & inventory
Keep Markdown only.
`.trim();

// ---------- Helpers ----------
function yamlFrontMatter(obj: Record<string, any>) {
  const yaml = Object.entries(obj)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v)}`)
    .join("\n");
  return `---\n${yaml}\n---\n\n`;
}

// Safe put to Dexie
async function putDocSafe(rec: any) {
  try {
    if (DexieDB?.docs?.put) {
      return await DexieDB.docs.put(rec);
    }
  } catch (e) {
    console.warn("[generateSPD] Dexie put failed (docs table missing?)", e);
  }
  return null;
}

function uuid() {
  if (typeof crypto !== "undefined" && (crypto as any).randomUUID) return (crypto as any).randomUUID();
  // simple fallback
  return "doc_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---------- Main ----------
export async function generateSPD(templateId = "meal-plan-weekly") {
  const tpl = TEMPLATE_MAP[templateId];
  if (!tpl) throw new Error(`Unknown templateId: ${templateId}`);

  const ctx = await buildHouseholdContext();

  // 1) Outline
  const outlineRaw = await callLLM(
    OUTLINE_PROMPT(tpl, ctx),
    { model: "gpt-4o-mini", temperature: 0.3, max_tokens: 900 }
  );
  const outlineJson = typeof outlineRaw === "string" ? outlineRaw : JSON.stringify(outlineRaw);

  // 2) Draft
  const draftMd = await callLLM(
    DRAFT_PROMPT(tpl, outlineJson, ctx.unitSystem),
    { model: "gpt-4o-mini", temperature: 0.35, max_tokens: 2200 }
  );
  const body = typeof draftMd === "string" ? draftMd : JSON.stringify(draftMd);

  // 3) Front-matter meta
  const meta = {
    id: tpl.id,
    title: `${tpl.title} — ${new Date().toLocaleDateString()}`,
    version: tpl.version,
    unitSystem: ctx.unitSystem,
    sources: {
      home: true,
      mealPlanning: !!ctx.mealPlan?.length,
      jobs: !!ctx.jobs?.length,
      community: !!ctx.community,
      badges: !!ctx.badges?.length
    },
    targets: tpl.targets,
    tags: ["auto", tpl.id],
    summary: {
      householdProfile: ctx.profile,
      dietaryNotes: ctx.dietary,
      weeklyTimeBudgetHrs: (ctx.weeklyHrs && (ctx.weeklyHrs.value ?? ctx.weeklyHrs)) || "",
      budgetPerWeek: (ctx.budget && (ctx.budget.value ?? ctx.budget)) || ""
    }
  };

  const spd = yamlFrontMatter(meta) + body;

  // 4) Persist
  const id = uuid();
  await putDocSafe({ id, templateId: tpl.id, createdAt: Date.now(), meta, spd });

  return { id, meta, spd };
}

export default generateSPD;
