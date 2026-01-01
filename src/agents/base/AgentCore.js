// --- keep any existing exports you already have above ---

function toMessages(arg) {
  if (Array.isArray(arg)) return arg; // already messages
  if (arg && (arg.system || arg.prompt || arg.task || arg.role)) {
    const parts = [];
    if (arg.role) parts.push(`Role: ${arg.role}`);
    if (arg.task) parts.push(`Task: ${arg.task}`);
    if (arg.prompt) parts.push(arg.prompt);
    const msgs = [];
    if (arg.system) msgs.push({ role: "system", content: arg.system });
    msgs.push({ role: "user", content: parts.join("\n\n") || "Respond briefly." });
    return msgs;
  }
  throw new Error("callLLM: expected messages array or {system/prompt/...} object");
}

export async function callLLM(arg, opts = {}) {
  const key = import.meta.env.VITE_OPENAI_API_KEY;
  if (!key) throw new Error("LLM_DISABLED: missing VITE_OPENAI_API_KEY");

  const model = opts.model || import.meta.env.VITE_OPENAI_MODEL || "gpt-4o-mini";
  const base = (import.meta.env.VITE_OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/,'');
  const body = {
    model,
    messages: toMessages(arg),
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.max_tokens ?? opts.max_tokens ?? 800,
  };

  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`LLM_HTTP_${r.status}: ${text.slice(0, 200)}`);
  }

  const json = await r.json();
  // normalize to always return a message-like object
  const msg = json.choices?.[0]?.message || { content: "" };
  return msg;
}
