// File: src/utils/menuExport.js
// Builds a Household Menu from a meal plan in HTML & Markdown and triggers a download.

export function formatHouseholdMenuMarkdown(plan, opts = {}) {
  const {
    title = "Household Menu",
    startDate, // optional override
    sections = ["Breakfast", "Lunch", "Dinner"], // visible meal slots
    showNotes = true,
  } = opts;

  const days = plan?.days || []; // [{ date: '2025-10-20', entries: { Breakfast: [...], Lunch: [...], Dinner: [...] }, notes?: '...' }]
  const formatDate = (d) => new Date(d).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

  let md = `# ${title}\n\n`;
  if (startDate) md += `_Start: ${new Date(startDate).toLocaleDateString()}_\n\n`;

  for (const day of days) {
    md += `## ${formatDate(day.date)}\n`;
    for (const sec of sections) {
      const items = (day.entries?.[sec] || []).map(x => x.name || x.title || x).filter(Boolean);
      md += `- **${sec}:** ${items.length ? items.join(", ") : "_—_"}\n`;
    }
    if (showNotes && day.notes) md += `\n> ${day.notes}\n`;
    md += `\n`;
  }

  return md.trim() + "\n";
}

export function formatHouseholdMenuHTML(plan, opts = {}) {
  const {
    title = "Household Menu",
    startDate,
    sections = ["Breakfast", "Lunch", "Dinner"],
    showNotes = true,
    brand = { name: "Suka", accent: "#4f46e5" },
  } = opts;

  const days = plan?.days || [];
  const formatDate = (d) => new Date(d).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

  const dayCards = days.map((day) => {
    const blocks = sections.map((sec) => {
      const items = (day.entries?.[sec] || []).map(x => x.name || x.title || x).filter(Boolean);
      const content = items.length ? items.map(i => `<li>${escapeHTML(i)}</li>`).join("") : `<li class="empty">—</li>`;
      return `
        <div class="slot">
          <div class="slot-title">${escapeHTML(sec)}</div>
          <ul class="slot-list">${content}</ul>
        </div>`;
    }).join("");

    const notes = showNotes && day.notes
      ? `<div class="notes"><span>Notes</span><p>${escapeHTML(day.notes)}</p></div>`
      : "";

    return `
      <article class="day-card">
        <header class="day-header">${escapeHTML(formatDate(day.date))}</header>
        <div class="slots">${blocks}</div>
        ${notes}
      </article>`;
  }).join("");

  const start = startDate
    ? `<div class="subtitle">Start: ${escapeHTML(new Date(startDate).toLocaleDateString())}</div>`
    : "";

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHTML(title)}</title>
<style>
:root{ --accent:${brand.accent}; --ink:#111827; --muted:#6b7280; --bg:#ffffff; --card:#ffffff; --line:#e5e7eb; }
*{box-sizing:border-box}
body{margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji";}
.wrapper{max-width:980px; margin:24px auto; padding:0 16px;}
.header{display:flex; align-items:flex-end; gap:12px; margin-bottom:16px;}
.title{font-size:28px; font-weight:700; color:var(--ink);}
.brand{margin-left:auto; font-weight:600; font-size:14px; color:var(--accent);}
.subtitle{color:var(--muted); font-size:13px; margin-top:4px;}
.grid{display:grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap:16px;}
.day-card{background:var(--card); border:1px solid var(--line); border-radius:14px; padding:12px;}
.day-header{font-weight:600; color:var(--ink); margin-bottom:8px;}
.slots{display:grid; gap:8px;}
.slot{border:1px dashed var(--line); border-radius:10px; padding:8px;}
.slot-title{font-size:12px; font-weight:700; color:var(--accent); text-transform:uppercase; letter-spacing:.02em; margin-bottom:4px;}
.slot-list{margin:0; padding-left:16px;}
.slot-list li{font-size:14px; line-height:1.4;}
.slot-list li.empty{color:var(--muted); list-style:none; padding-left:0;}
.notes{border-top:1px solid var(--line); margin-top:8px; padding-top:8px;}
.notes > span{font-size:12px; font-weight:700; color:var(--muted);}
.notes > p{margin:.25rem 0 0 0; font-size:13px;}
@media print{
  body{background:#fff;}
  .wrapper{max-width:100%; margin:0; padding:0;}
  .header{margin:0 0 8px 0; padding:0 16px;}
  .grid{gap:10px; padding:0 16px;}
}
</style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div>
        <div class="title">${escapeHTML(title)}</div>
        ${start}
      </div>
      <div class="brand">${escapeHTML(brand.name)}</div>
    </div>
    <section class="grid">
      ${dayCards}
    </section>
  </div>
</body>
</html>`;
  return html;
}

export function downloadText(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function escapeHTML(s = "") {
  return String(s).replace(/[&<>\"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]
  ));
}
