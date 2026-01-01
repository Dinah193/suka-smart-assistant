# QA Matrix — Device / Browser / Offline / RTC Coverage
**File:** `src/qa/matrix.md`  
**Scope:** End-to-end coverage for **Play**, **Remote**, and **Overlay** surfaces in the Suka Smart Assistant (SSA).  
**Pipeline fit:** Validates the “session execution” layer that sits after imports → intelligence → **automation** → (optional) hub export. Ensures eventBus payloads `{ type, ts, source, data }` remain consistent across devices, and that offline/RTC fallbacks preserve household autonomy.

---

## 0) Roles, Surfaces, and Topologies

**Surfaces**
- **Play** — hands-busy session runner (mobile-first; timers, speech, haptics).
- **Remote** — phone controls/steers an external screen/session.
- **Overlay** — display on desktop/TV with large text, step focus, progress.

**Topologies**
- **T1:** Phone = Play (solo)  
- **T2:** Phone = Remote → TV/PC = Overlay (WebRTC data channel)  
- **T3:** Phone = Remote → TV/PC = Overlay (WebSocket fallback)  
- **T4:** Laptop = Play + Overlay (single device, dual window/tab)  
- **T5:** Phone Play (offline PWA) → later sync  
- **T6:** Multi-remotes (2+ phones) controlling single Overlay (arbitration)

Record for each topology:
- Event bus flow observed (✔)  
- DataChannel or WS fallback engaged (✔)  
- Session continuity on reconnect (✔)  
- Hub export respected when `featureFlags.familyFundMode=true` (✔)

---

## 1) Environment Matrix

| OS | Device | Browser/App | PWA Installed | Notes |
|---|---|---|---|---|
| iOS 17+ | iPhone (modern) | Safari | ☐ | Wake Lock polyfill needed; autoplay restrictions |
| iOS 17+ | iPad | Safari | ☐ | Stage Manager multiwindow tests |
| Android 12+ | Pixel/Samsung | Chrome | ☐ | Full Wake Lock API |
| Android 12+ | Tablet | Chrome | ☐ | Split-screen; external display |
| Windows 11 | Desktop/Laptop | Chrome | ☐ | Fullscreen + Media Session |
| Windows 11 | Desktop/Laptop | Edge | ☐ | System media controls verification |
| macOS 14+ | MacBook | Chrome | ☐ | Menu-bar media controls |
| macOS 14+ | MacBook | Safari | ☐ | Autoplay quirks; WebRTC H264 |
| smart TV | Cast target | System Browser/WebView | N/A | Overlay read-only view |
| Low-end Android | Phone | Chrome | ☐ | CPU/Memory pressure scenarios |

> For each row, execute Feature & Scenario checklists below and mark ✔/✖ with notes.

---

## 2) Feature Capability Checklist (per device/browser)

Mark each after testing on the target **Surface** (Play / Remote / Overlay).

### Core
- [ ] **EventBus wiring**: emits `{ type, ts, source, data }` with ISO `ts`; no extra props
- [ ] **Timers**: accuracy ±1s/min under load and background/lock events
- [ ] **Step progression**: Next/Prev behavior; idempotent controls
- [ ] **Speech prompts** (TTS) where available; degrade gracefully
- [ ] **Doneness cues** visible (text) when media or TTS unavailable

### Hands-Busy UX
- [ ] **Screen Wake Lock**: keeps screen on (or polyfill fallback)
- [ ] **Haptics/Vibration**: step change & timer alarms (mobile)
- [ ] **Media Session**: lock-screen controls (Prev/Play/Pause/Next)
- [ ] **Notifications**: permission request + timer done notification
- [ ] **Fullscreen**: Overlay supports fullscreen toggle w/ escape fallback

### Storage & Offline
- [ ] **PWA installability**: manifest icons, offline start
- [ ] **Service Worker**: route cache, offline first for Play/Overlay JS/CSS/html
- [ ] **Background Sync**: queued event flush after reconnect
- [ ] **IndexedDB (Dexie)**: drafts, favorites, schedules save/read
- [ ] **Storage Quota**: graceful errors on quota exceeded

### Networking
- [ ] **WebRTC DataChannel** (Remote↔Overlay): connect, send, back-pressure, ordered/unordered as configured
- [ ] **WebSocket fallback**: auto-connect on RTC failure, heartbeats
- [ ] **BroadcastChannel** (same-device dual-tab Overlay tests)
- [ ] **Reconnect logic**: exponential backoff, resume session state
- [ ] **Permissions**: mic/camera prompts (if used), notification prompts deterministic

### Overlay Specific
- [ ] **Low-motion mode** (prefers-reduced-motion respected)
- [ ] **Streamer Safe mode**: strips pantry/private fields from overlay payload
- [ ] **Large type scaling**: readable at 10ft; responsive typography grid

### Remote Specific
- [ ] **Room join/leave** lifecycle events emitted
- [ ] **Arbitration**: multiple remotes — last writer wins w/ debouncing
- [ ] **Latency budget**: input→overlay < 150ms on LAN; < 400ms WAN

---

## 3) Offline & Network Profiles

Simulate with DevTools/OS toggles and record results.

| Profile | Method | Expected Behaviors |
|---|---|---|
| **Offline (Airplane)** | OS Airplane or DevTools offline | Play loads from cache, timers run, events queued for sync |
| **Poor (2G/3G)** | DevTools throttle | RTC may fail; auto WS fallback; keep UI responsive |
| **Flaky Wi-Fi** | Toggle Wi-Fi during session | Reconnect & state resume; no duplicate steps/timers |
| **WAN latency 300ms** | NetEm/DevTools custom | Input→overlay within WAN budget or show “High latency” indicator |

Check:
- [ ] **Queue drain** upon reconnect (events flush in order)  
- [ ] **No data loss** on page reload while offline  
- [ ] **Idempotent** replays (no double “timer.start”)

---

## 4) RTC Scenarios (Run for each Topology T2/T3/T6)

1. **Pairing & Room Discovery**
   - [ ] Remote joins room; Overlay acknowledges (`control.reply{status:"accepted"}`)
   - [ ] Heartbeat cadence respected; missed heartbeats → reconnect

2. **Command Round-Trip**
   - [ ] `control.command{action:"session.start"}` → Overlay executes
   - [ ] `control.reply{status:"executed"}` with `durationMs` populated

3. **Fallback Trigger**
   - [ ] Force RTC failure → WS fallback within 3s
   - [ ] Visual badge shows transport = WS; later auto-upgrade back to RTC

4. **Multi-Remote Arbitration**
   - [ ] Two remotes send `timer.pause` within 200ms; last command wins; others get `control.reply{status:"queued"|"ok"}`
   - [ ] Conflict toast appears on losing client

5. **State Sync**
   - [ ] New Remote joins mid-session → receives full “session snapshot” within 1s

---

## 5) Play Surface Scenarios

- [ ] **Single recipe, single timer**: start/pause/resume/complete → notifications + haptics
- [ ] **Multi-timer**: overlapping alarms; ensure distinct labels; Media Session shows active
- [ ] **Prep synthesis steps**: pre-boil water offset fires before boil step
- [ ] **Doneness preferences**: “medium” carries to cue text + target temp/time
- [ ] **Offline start**: cold-start PWA offline; loads last session draft

---

## 6) Overlay Scenarios

- [ ] **Large step focus & progress**: keyboard/remote input navigates
- [ ] **Streamer Safe mode ON**: verify payload redaction (no private fields)
- [ ] **Low-motion**: animations reduced; no jitter on step change
- [ ] **Fullscreen**: toggle + escape; maintain state on exit

---

## 7) Remote Scenarios

- [ ] **Room switch**: leave Room A, join Room B; old overlay stops accepting commands
- [ ] **Transport indicator**: RTC ↔ WS badge reflects current transport
- [ ] **Battery saver**: Android/iOS low-power mode → timers remain reliable (±1s/min)

---

## 8) Observability & Event Contracts

For each scenario, confirm event emissions (subscribe in DevTools console):

- `control.command|reply|error|heartbeat`
- `session.started|session.progress|session.completed`
- `overlay.connected|overlay.disconnected`
- `remote.joined|remote.left`
- `network.transport.changed` (dataChannel|websocket)
- `export.hub.attempted|export.hub.skipped|export.hub.failed` (when enabled)

**Checks**
- [ ] Every event conforms to `{ type, ts, source, data }` with ISO `ts`
- [ ] No PII in Overlay-bound payloads when Streamer Safe is enabled
- [ ] Errors include `code` (UPPER_SNAKE) & `message`

---

## 9) Accessibility

- [ ] **Keyboard navigation**: tab order, focus rings visible
- [ ] **ARIA roles**: timers, progress, step current/total
- [ ] **Contrast**: AA minimum across themes
- [ ] **Captions**: TTS text mirrors audio; toast summaries are readable

---

## 10) Performance Budgets

- First interaction to step render: **< 100ms** (warm) / **< 250ms** (cold)
- Timer tick drift under CPU load: **< 200ms/min**
- Remote → Overlay command latency: **< 150ms LAN**, **< 400ms WAN**
- Memory ceiling (low-end Android): **< 200MB** total for Play

Capture with Performance panel; attach screenshots to case.

---

## 11) Known Platform Quirks (Checklist)

- [ ] **iOS**: Wake Lock polyfill via continuous tiny video or periodic focus nudge
- [ ] **iOS**: Notification permission gated by user gesture
- [ ] **Safari**: Autoplay media requires muted start / user gesture
- [ ] **Android**: Battery optimizations may throttle timers; verify foreground service-like behavior via notifications/haptics cadence
- [ ] **Desktop Safari**: H.264 codec negotiation for RTC

---

## 12) Severity & Pass/Fail

**Severity**
- **S1**: Data loss, session cannot complete, no fallback
- **S2**: Major degradation, manual workaround
- **S3**: Minor issue, cosmetic or alt-path available
- **S4**: Nit/tech debt

**Exit Criteria**
- All **S1/S2** closed or deferred with approved mitigation
- 100% of **Core**, **Storage & Offline**, **Networking**, and **Overlay/Remote** checklists pass on **at least one** device per OS family (iOS/Android/Win/macOS)
- RTC + WS fallback validated in **T2** and **T3**

---

## 13) Bug Filing Template

Title: [Surface] [Topology] Brief issue summary
Env: OS/Device/Browser + PWA install? + Topology (T2/T3/…)
Severity: S1/S2/S3/S4
Steps:

…

…
Expected: …
Actual: …
Logs:

eventBus dump (type, ts, source, data) …

transport changes (network.transport.changed) …
Artifacts: screenshots/video, perf trace

yaml
Copy code

---

## 14) Test Run Log (Sample Table)

| Date | Tester | Env Row | Topology | Pass | Fail | Sev Summary | Notes |
|---|---|---|---|---:|---:|---|---|
| 2025-11-08 | | Android/Chrome/Phone | T2 | 24 | 2 | S2×1, S3×1 | WS fallback slow to engage |

---

## 15) How-To: Simulations & Toggles

- **Offline:** DevTools → Network → Offline OR OS Airplane mode  
- **Throttling:** DevTools → Network → 2G/3G/Wi-Fi presets  
- **CPU Stress:** DevTools → Performance → CPU Throttle 4x  
- **PWA Install:** Address bar install / Android “Add to Home screen”  
- **Fullscreen:** `F11` or UI control in Overlay  
- **Wake Lock Check:** Dim timeout vs. API/polyfill behavior  
- **Service Worker Update:** unregister/register, hard reload, offline start

---

## 16) Acceptance Sign-off

- [ ] Matrix executed across targeted rows  
- [ ] All S1/S2 resolved/mitigated  
- [ ] Contracts validated (control + session events)  
- [ ] Offline start + sync proven  
- [ ] RTC and WS fallback proven

**Signatures:** QA Lead ___  Eng Owner ___  PM ___