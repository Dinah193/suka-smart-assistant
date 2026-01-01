# Stability Engine — Design & Usage

> Folder: `src/features/stability/`

The **Stability Engine** gives you a single mental model and UI surface for answering two questions:

1. **“How stable is SSA right now?”**  
   (Can sessions run end-to-end without getting torn down by navigation, device limits, or guard rules?)
2. **“What should I adjust next?”**  
   (Device settings, guards, SessionRunner options, or integration with the Hub.)

It does **not** replace the `SessionRunner`. Instead, it observes:

- Session lifecycle events (`session.*`)
- Guard statuses
- Device capability detection
- Dexie-backed analytics (historical trends)

…and then surfaces that information in a friendly, dashboard-style interface.


---

## 1. High-Level Architecture

The Stability feature is **read-only** and **non-blocking**:

- It **never** starts/stops sessions directly.
- It **never** changes guards or Hub behavior directly.
- It only:
  - Listens on `eventBus` for `session.*` events.
  - Optionally loads analytics snapshots from Dexie (`fetchHistory` props).
  - Probes browser capabilities (wake-lock, notifications, TTS, PiP, service worker).

### Core Concepts

- **SessionRunner** (elsewhere):  
  Full-screen modal that runs cooking/cleaning/garden/animals/preservation/storehouse sessions.
- **Stability Engine** (this feature):  
  A set of **views + helpers** that describe how resilient the SessionRunner is:
  - Device capabilities
  - Guards
  - Background behavior
  - Hub integration
  - History and recommendations

---

## 2. Data Contracts

### 2.1 Session Object (reference)

The Stability Engine treats the Session object as read-only. It assumes the following minimal contract:

```jsonc
{
  "id": "string",
  "domain": "cooking|cleaning|garden|animals|preservation|storehouse",
  "title": "string",
  "source": {
    "type": "recipe|cleaningPlan|gardenPlan|animalTask|import|manual",
    "refId": "string|null"
  },
  "steps": [
    {
      "id": "string",
      "title": "string",
      "desc": "string",
      "durationSec": 0,
      "blockers": ["inventory","weather","quietHours","sabbath","equipment"],
      "metadata": {
        "tempTargetF": 0,
        "donenessCue": "color|texture|probeTemp|timer|smell",
        "cueNotes": "string"
      }
    }
  ],
  "prefs": { "voiceGuidance": true, "haptic": true, "autoAdvance": false },
  "status": "pending|running|paused|completed|aborted",
  "progress": {
    "currentStepIndex": 0,
    "elapsedSec": 0,
    "startedAt": "ISO|null",
    "pausedAt": "ISO|null"
  },
  "analytics": { "skippedSteps": [], "adjustments": [] },
  "createdAt": "ISO",
  "updatedAt": "ISO"
}
The Stability UI only cares about a few fields:

domain, title, status

progress.currentStepIndex

analytics.skippedSteps

analytics.adjustments (especially those with type: "guard")

2.2 Stability Dimensions (Radar / Recommendations)
A stability dimension is a normalized 0–1 score:

ts
Copy code
type StabilityDimension = {
  key: string;       // e.g. "device"|"guards"|"session"|"background"|"integration"
  label?: string;    // human-friendly name
  score: number;     // 0–1; will be clamped
};
Example:

js
Copy code
[
  { key: "device", label: "Device", score: 0.82 },
  { key: "guards", label: "Guards", score: 0.61 },
  { key: "session", label: "Session Runner", score: 0.9 },
  { key: "background", label: "Background", score: 0.7 },
  { key: "integration", label: "Integration", score: 0.5 },
]
You are free to decide how these scores are derived (e.g. from analytics, guard failure rates, or simple heuristics).

2.3 Device Capability Snapshot
The Stability views use a lightweight capability snapshot:

ts
Copy code
type DeviceCaps = {
  wakeLock?: "available"|"unavailable"|"degraded"|"unknown";
  notifications?: "available"|"unavailable"|"degraded"|"unknown";
  speech?: "available"|"unavailable"|"degraded"|"unknown";
  mediaSession?: "available"|"unavailable"|"degraded"|"unknown";
  docPictureInPicture?: "available"|"unavailable"|"degraded"|"unknown";
  serviceWorker?: "available"|"unavailable"|"degraded"|"unknown";
};
The defaults are "unknown", and the Stability Dashboard probes the browser on mount.

2.4 Guard Status Snapshot
Guards are summarized as:

ts
Copy code
type GuardStatus = {
  sabbath?: "ok"|"degraded"|"failing"|"checking"|"unknown";
  quietHours?: "ok"|"degraded"|"failing"|"checking"|"unknown";
  weather?: "ok"|"degraded"|"failing"|"checking"|"unknown";
  inventory?: "ok"|"degraded"|"failing"|"checking"|"unknown";
  battery?: "ok"|"degraded"|"failing"|"checking"|"unknown";
};
Today, battery can be probed directly (if navigator.getBattery exists). Other guards should emit their own guard.* events and update shared state that the Stability views read from.

3. Event Contracts
3.1 Emitted by SessionRunner (expected)
The Stability Engine expects the SessionRunner to emit the following via eventBus:

session.started

session.step.changed

session.paused

session.resumed

session.completed

session.aborted

session.exported (when Hub send succeeds)

Recommended payload shape:

js
Copy code
eventBus.emit({
  type: "session.completed",       // one of the above
  ts: new Date().toISOString(),    // ISO 8601
  source: "session.runner",        // module id
  data: {
    session,                       // full session object (or snapshot)
    // optional extra analytics or flags
  }
});
The Stability views are defensive: if data.session is missing, they try payload.session, otherwise they just store a minimal event record.

3.2 Consumed by Stability
StabilityDashboardView listens to session.started, session.step.changed, and all terminal events to show the current session and last event.

StabilityHistoryTimeline listens to session.completed and session.aborted to append a simple, event-derived history entry when real analytics aren’t wired yet.

You can later replace / augment these with Dexie-backed analytics as the source of truth.

4. Dexie & Analytics Integration (Optional)
The Stability Engine is ready for Dexie-backed analytics, but does not require it.

4.1 Suggested Dexie Table
You can store daily/rolling stability snapshots, for example:

ts
Copy code
type StabilitySnapshotRow = {
  id: string;         // e.g. "2025-11-20"
  ts: string;         // ISO when snapshot was computed
  dimensions: StabilityDimension[];
  guardStatus: GuardStatus;
  deviceCaps?: DeviceCaps;
  meta?: {
    sessionsStarted?: number;
    sessionsCompleted?: number;
    guardFailures?: number;
    notes?: string;
  };
};
Dexie store example:

ts
Copy code
db.version(x).stores({
  stabilitySnapshots: "id, ts",
  // ... other stores
});
4.2 Wiring Into StabilityHistoryTimeline
StabilityHistoryTimeline accepts a fetchHistory prop:

jsx
Copy code
<StabilityHistoryTimeline
  fetchHistory={async () => {
    const rows = await db.stabilitySnapshots
      .orderBy("ts")
      .reverse()
      .limit(50)
      .toArray();

    return rows.map(row => ({
      id: row.id,
      ts: row.ts,
      label: "Household stability snapshot",
      domain: "general",
      score: averageScore(row.dimensions),
      healthStatus: undefined, // let component classify
      meta: row.meta,
    }));
  }}
/>
If fetchHistory is not provided, the component shows a demo dataset so the UI is never empty during development.

5. UI Components in This Feature
5.1 StabilityDashboard.view.jsx
Purpose: Main Stability dashboard page.

Key responsibilities:

Probe device capabilities (WakeLock, Notification, speechSynthesis, navigator.mediaSession, documentPictureInPicture, serviceWorker).

Show Guard status summary (Sabbath, Quiet hours, Weather, Inventory, Battery).

Subscribe to session.* events and display:

Current running session (title, domain, step index, status).

Last session event (type + timestamp).

Detect familyFundMode and display whether Hub export is expected.

Provide a “Run stability test session” button that emits:

js
Copy code
eventBus.emit({
  type: "session.test.request",
  ts: new Date().toISOString(),
  source: "stability.dashboard",
  data: { session: debugSession }
});
Your SessionRunner can listen for session.test.request and immediately open a test session.

It also contains a local details modal (StabilityDetailModal) with tabs:

Device

Guards

Session Runner

Background

This modal is purely informational and does not affect timers or wake-lock.

5.2 StabilityRadarChart.jsx
Purpose: Visual snapshot of stability dimensions as a radar chart.

Pure SVG, no third-party chart library.

Props:

dimensions?: StabilityDimension[]

size?: number (default 260)

ringCount?: number (default 4)

showLegend?: boolean (default true)

Uses 0–1 scores to plot vertices around a circle.

Draws:

Concentric rings

Axes lines

Polygon for actual values

Percentage + qualitative label (“Excellent”, “Strong”, etc.) in the center.

Usage example:

jsx
Copy code
<StabilityRadarChart
  dimensions={[
    { key: "device", label: "Device", score: 0.78 },
    { key: "guards", label: "Guards", score: 0.58 },
    { key: "session", label: "Session Runner", score: 0.92 },
    { key: "background", label: "Background", score: 0.7 },
    { key: "integration", label: "Integration", score: 0.65 },
  ]}
/>
5.3 StabilityHistoryTimeline.jsx
Purpose: Timeline of stability-relevant events and snapshots.

Renders a vertical timeline with:

Timestamp, label, domain pill, health badge, and a score %.

Accepts:

entries?: StabilityHistoryEntry[]

maxItems?: number

fetchHistory?: () => Promise<StabilityHistoryEntry[]>

onSelectEntry?: (entry) => void

Listens to session.completed and session.aborted and appends event-derived entries when analytics aren’t wired.

Each timeline item opens a detail modal with:

Label, domain, stability score, health classification.

Simple metrics: sessions started/completed, guard failures, battery, notes.

5.4 StabilityRecommendations.jsx
Purpose: “Next best action” panel.

Inputs:

dimensions?: StabilityDimension[]

deviceCaps?: DeviceCaps

guardStatus?: GuardStatus

onSuggestionClick?: (suggestion) => void

Generates StabilitySuggestion objects:

ts
Copy code
type StabilitySuggestion = {
  id: string;
  category: "device"|"guards"|"session"|"background"|"integration"|"general";
  priority: "critical"|"important"|"nice-to-have";
  title: string;
  description: string;
  actions: string[];
};
Uses heuristics:

Low dimension scores → targeted suggestions per category.

Device caps that are "unavailable"/"degraded" → capability suggestions.

Guard statuses "failing"/"degraded" → guard tuning suggestions.

If everything is strong, it shows a single “You’re in great shape” suggestion.

Includes a small help modal explaining how recommendations are generated.

6. How To Wire the Stability Dashboard Into the App
6.1 Route Registration
In your main router (e.g. App.jsx):

jsx
Copy code
import StabilityDashboardView from "@/features/stability/StabilityDashboard.view";

<Routes>
  {/* ...other routes... */}
  <Route path="/stability" element={<StabilityDashboardView />} />
</Routes>
You can link to this from your main navigation (e.g. “Stability & Resilience” menu entry).

6.2 Using the Stability Components Together
Example layout for the Stability page:

jsx
Copy code
import StabilityDashboardView from "@/features/stability/StabilityDashboard.view";
import StabilityRadarChart from "@/features/stability/StabilityRadarChart";
import StabilityHistoryTimeline from "@/features/stability/StabilityHistoryTimeline";
import StabilityRecommendations from "@/features/stability/StabilityRecommendations";

// Inside StabilityDashboardView, or a child:
<main className="grid grid-cols-1 xl:grid-cols-3 gap-6">
  <section className="xl:col-span-2 space-y-5">
    {/* Session resilience + details (from StabilityDashboardView itself) */}
  </section>

  <section className="space-y-4">
    <StabilityRadarChart dimensions={dimensionsFromAnalytics} />
    <StabilityHistoryTimeline fetchHistory={loadFromDexie} />
    <StabilityRecommendations
      dimensions={dimensionsFromAnalytics}
      deviceCaps={deviceCaps}
      guardStatus={guardStatus}
    />
  </section>
</main>
You can compute dimensionsFromAnalytics, deviceCaps, and guardStatus inside StabilityDashboardView and pass them down.

7. Guard & Capability Integration
7.1 Guards
Your guard services (e.g. SabbathGuard, QuietHoursGuard, WeatherGuard, InventoryGuard) should:

Maintain internal state (ok / degraded / failing / checking / unknown).

Emit their own events as they evaluate conditions, for example:

js
Copy code
eventBus.emit({
  type: "guard.sabbath",
  ts: new Date().toISOString(),
  source: "sabbath.guard",
  data: {
    status: "ok",
    nextBoundary: "2025-11-29T18:00:00Z"
  }
});
A shared store or context can listen to these guard.* events and maintain a unified GuardStatus snapshot that StabilityDashboardView reads.

7.2 Device Caps
StabilityDashboardView currently probes capabilities directly using:

navigator.wakeLock

Notification.permission

speechSynthesis

navigator.mediaSession

window.documentPictureInPicture / DocumentPictureInPicture

navigator.serviceWorker

You can extract this into a shared deviceCapsService later if needed, but the current implementation is already defensive (falls back to "unavailable"/"unknown").

8. SessionRunner & Stability — How They Work Together
The SessionRunner is responsible for:

Timers (with Web Worker when available).

Wake-lock acquisition/release.

Notifications and Media Session handlers.

Dexie checkpoints and auto-resume.

Hub export (session.exported) when familyFundMode is true.

The Stability Engine:

Watches the event stream (no control).

Displays:

Whether a session is currently running, paused, or finished.

Most recent session.* events.

Device + guard readiness.

Historical stability trends and suggestions.

You can safely leave the Stability page open while sessions run, or navigate away — the SessionRunner is mounted at the app root (via a portal in App.jsx), and the Stability components do not unmount it.

9. Extension Points & Next Steps
Some practical ways to extend this feature:

Real analytics scores
Replace the simple heuristics with real numbers from Dexie:

Session completion vs. abort ratio.

Average guard failures per session.

Average step skips per domain.

How often wake-lock / notifications are denied or not available.

Per-domain stability slices
Add dimensions like "cooking.stability", "cleaning.stability", etc.
Then show radar charts scoped to each domain.

User-facing guard tuning UI
Link from a guard suggestion to a “Guard Settings” page where users can tune:

Sabbath boundaries.

Quiet hours.

Weather thresholds (wind, rain, heat).

Minimum inventory requirements.

Stability badges in other pages
Show small stability badges (e.g. “Stable / Limited / At risk”) on domain dashboards (cooking, cleaning, garden…) using a subset of the same StabilityDimension data.

Hub integration summary
Add a small panel showing when the last session.exported event succeeded and how many sessions have been exported to the Family Fund Hub in the current week/month.

10. Design Goals Recap
Non-intrusive: Stability tools observe; they do not interfere with SessionRunner logic.

Always informative: Even with no Dexie analytics and minimal events, the UI:

Shows device capability probes.

Provides demo history.

Generates generic but helpful recommendations.

Ready for growth: Types and props are flexible so you can:

Plug in real analytics later.

Add new guard types.

Add new stability dimensions without rewriting the UI.