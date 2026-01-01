# Suka Smart Assistant — Browser Bookmarklet
**Name:** `Suka it`

This bookmarklet lets you grab *whatever page you are on* — recipes, cleaning routines, garden/seed info, animal/butchery guides, storehouse/long-term pantry posts, or video/how-to pages — and send it straight to your Suka Smart Assistant (SSA) import pipeline.

It sends **one JSON payload** that matches  
`src/import/bookmarklet/sharePayload.contract.json`  
so SSA can do:

1. **Import →** detect domain → pick the correct parser  
2. **Normalize →** unify fields into SSA’s internal schemas  
3. **Intelligence →** extract ingredients / methods / equipment / seasonality / routines  
4. **Automation →** emit events → schedule sessions / inventory checks  
5. **(Optional) Hub →** if `familyFundMode=true`, SSA mirrors the same payload to the Suka Village Family Fund Hub

---

## 1. What the bookmarklet does
When you click **“Suka it”**:

1. It looks at the current tab (URL, `<title>`, `<meta>`).  
2. It tries to grab raw HTML (where allowed) and obvious structured data (`<script type="application/ld+json">`).  
3. It tries to detect **what kind of page** this is: `recipe`, `cleaning`, `garden`, `animal`, `storehouse`, or `video/howto`.  
4. It builds a JSON object in the same shape as  
   `src/import/bookmarklet/sharePayload.contract.json`  
   and **posts** it to your **local SSA endpoint**.
5. SSA receives it → `ImportService.importPayload(...)` → `ImportRouter.routeImport(...)` → parser → normalizer → UI preview.

---

## 2. The actual bookmarklet code
> **How to use this:** Copy everything between `javascript:(function(){ ... })();` and paste it into a new browser bookmark as the URL.

```text
javascript:(function(){
  /* Suka Smart Assistant — "Suka it" bookmarklet */
  const SSA_ENDPOINT = window.SUKA_BOOKMARKLET_ENDPOINT
    || "http://localhost:5173/api/import"; // <--- change if your SSA uses a different port/path

  function pickDomainFromPage() {
    const u = location.href.toLowerCase();
    const t = (document.title || "").toLowerCase();
    const bodyText = (document.body && document.body.innerText || "").toLowerCase().slice(0, 1500);

    // quick heuristics
    if (u.includes("recipe") || bodyText.includes("ingredients") || bodyText.includes("preheat oven")) return "recipe";
    if (u.includes("clean") || t.includes("cleaning") || bodyText.includes("declutter")) return "cleaning";
    if (u.includes("garden") || u.includes("seed") || bodyText.includes("planting")) return "garden";
    if (u.includes("butcher") || u.includes("meat") || bodyText.includes("slaughter") || bodyText.includes("goat")) return "animal";
    if (u.includes("pantry") || u.includes("storehouse") || bodyText.includes("long-term storage")) return "storehouse";
    if (u.includes("youtube.com") || u.includes("youtu.be") || u.includes("tiktok.com")) return "video";
    return "unknown";
  }

  function grabJsonLd() {
    const out = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        const parsed = JSON.parse(s.textContent);
        out.push(parsed);
      } catch (e) {}
    });
    return out;
  }

  const payload = {
    version: new Date().toISOString().slice(0,10),
    source: "browser.bookmarklet",
    familyFundMode: false, // user can toggle this later in SSA
    payload: {
      url: location.href,
      domain: pickDomainFromPage(),
      title: document.title || "",
      description: (document.querySelector('meta[name="description"]') || {}).content
        || (document.querySelector('meta[property="og:description"]') || {}).content
        || "",
      html: document.documentElement.outerHTML.slice(0, 250000), // cap so we don't blow up the request
      structuredData: grabJsonLd(),
      images: Array.from(document.images || []).slice(0, 12).map(img => img.src).filter(Boolean),
      capturedAt: new Date().toISOString(),
      clientHints: {
        showPreview: true
      }
    },
    meta: {
      userAgent: navigator.userAgent,
      clientTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
      language: navigator.language || null
    }
  };

  // send to SSA
  fetch(SSA_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    mode: "cors",
    body: JSON.stringify(payload)
  })
  .then(function(res){
    if (!res.ok) throw new Error("SSA responded with " + res.status);
    alert("✅ Sent to Suka Smart Assistant.\nDomain: " + payload.payload.domain);
  })
  .catch(function(err){
    console.warn("Suka bookmarklet error:", err);
    alert("⚠️ Could not reach Suka Smart Assistant at:\n" + SSA_ENDPOINT + "\nSee console for details.");
  });
})();
