# Orchestrator Modes — Expected Behavior Spec  
_File: `src/tests/agents/orchestrator.modes.spec.md`_

These notes describe how the **Orchestrator** must behave for each mode
declared in `src/config/orchestrator.modes.json`.

They are written as **behavioral expectations** (not Jest tests) to guide:
- manual QA,
- future automated tests,
- and shim implementations that depend on mode behavior.

The modes assumed here:

- `SSA_LOCAL`
- `SSA_HUB`
- `DEMO`
- `OFFLINE_FALLBACK`

> ⚠️ Whenever “orchestrator” is mentioned below, it means the shim / helper
> that reads `orchestrator.modes.json`, decides which pipeline to run, and
> coordinates the SessionRunner + AI shims + Hub exporter.

---

## 1. Global Expectations (All Modes)

### 1.1 Mode Resolution

- **GIVEN** the app bootstraps  
  **WHEN** the orchestrator loads `orchestrator.modes.json`  
  **THEN** it MUST:
  - validate that `defaults.defaultMode` exists and is one of `modes` keys,
  - select that mode if no explicit context override is provided,
  - expose a `getCurrentMode()` helper for SessionRunner and shims.

- **GIVEN** an explicit override is present (e.g. `?mode=DEMO` or user profile setting)  
  **WHEN** the orchestrator initializes  
  **THEN** it MUST:
  - prefer the explicit override over the default,
  - fall back to the default if the override is invalid / unknown.

### 1.2 SessionRunner Integration

For **ALL** modes:

- **GIVEN** a `session.open.request` event is emitted  
  **THEN** the orchestrator MUST:
  - look up the current mode, select the appropriate `sessionControl` settings,
  - allow the SessionRunner to run **without being torn down** by route changes,
  - ensure checkpoints are written according to the mode’s `checkpointPolicy`.

- **GIVEN** a session is in `running` status  
  **WHEN** the user navigates to a different route  
  **THEN**:
  - the SessionRunner remains active,
  - timers remain accurate (Web Worker or equivalent),
  - the current mode continues to apply unchanged.

### 1.3 Guards & Safety

For all modes except where explicitly disabled:

- Sabbath, Quiet Hours, Inventory, Weather, and Battery guards SHOULD be
  interpreted according to `guards` configuration for the current mode:
  - `enforced: true` → block / auto-pause,
  - `enforced: false` but `logOnly: true` → allow but emit warnings.

- **GIVEN** a guard blocks a step or a whole session  
  **THEN** the orchestrator MUST:
  - emit `session.paused` with `reason` matching the guard (e.g. `"sabbath"`),
  - optionally request a user-facing explanation from the guard-explainer shim,
  - NEVER silently discard the session.

### 1.4 Engagement Layer

For all modes where `engagement` flags are `true`:

- **Screen Wake Lock**
  - If `wakeLock: true` and the API is available,
    - SessionRunner SHOULD acquire a wake lock when a session starts,
    - release it when the last running session completes / aborts.

- **Notifications**
  - If `notifications: true`, SessionRunner SHOULD:
    - request permission (once) from the user,
    - show an ongoing “Session in progress” notification while a session is running,
    - include Pause / Next action buttons mapped to `session.intent.pause` / `session.intent.next`.

- **Picture-in-Picture (PiP)**
  - If `pictureInPicture: true` and Document PiP is available,
    - SessionRunner MAY create a mini “control HUD” window,
    - the HUD MUST continue to reflect current step / remaining time.

---

## 2. `SSA_LOCAL` Mode

**Intended for**: Single-household use, no Hub export, everything runs locally.

### 2.1 Pipeline and Tasks

- **Allowed tasks**: All SSA tasks (imports, planning, sessions, garden, animals, preservation, storehouse).  
- **Engine**: Local-first, no Hub export.

### 2.2 Session Behavior

- Sessions MUST:
  - fully respect all configured guards,
  - write checkpoints frequently (e.g., on every step change and ~10s tick),
  - auto-resume if a `running` session is found on reload.

- **GIVEN** a session is `running`  
  **WHEN** the tab is reloaded  
  **THEN**:
  - orchestrator in `SSA_LOCAL` MUST locate the last `running` session,
  - mount SessionRunner in “resume” mode at the same step (or safe default),
  - re-establish timers and wake-lock (if allowed by browser).

### 2.3 Hub Export

- `SSA_LOCAL` MUST **never** export to Hub:
  - `session.exported` MUST NOT be emitted under this mode.
  - Any attempt to call Hub connectors MUST be skipped with local warnings only.

### 2.4 UI & Swap Modal

- The **mode swap modal** (from a global toolbar or settings menu):
  - SHOULD allow switching from `SSA_LOCAL` to other modes,
  - MUST show `SSA_LOCAL` as:
    - “Local Only / Private”,
    - including notes like “Sessions, inventory, and analytics stay on this device.”
  - MUST warn if there is an active `running` session:
    - e.g. “Switching modes will not stop your session, but behavior (exports, guards) may change.”

---

## 3. `SSA_HUB` Mode

**Intended for**: Households that are linked to a Family Fund Hub, where export is desired.

### 3.1 Pipeline and Tasks

- Same task coverage as `SSA_LOCAL`, but with **additional Hub steps**:
  - import → normalize → plan session → run session → analytics → **Hub export**.

### 3.2 Hub Export Behavior

- **GIVEN** a session transitions to `completed` or `aborted`  
  **THEN** in `SSA_HUB`:
  - orchestrator SHOULD prepare a Hub-compatible envelope (via `HubPacketFormatter`),
  - call `FamilyFundConnector.sendSessionPacket` (or equivalent),
  - on success:
    - emit `session.exported` with `{ sessionId, hubMessageId?, tookMs?, bytes? }`,
  - on failure:
    - MUST NOT crash the Runner,
    - SHOULD log an error and possibly show a low-priority toast,
    - MAY retry according to internal retry/backoff policy (not specified here).

### 3.3 Session & Guard Behavior

- `SSA_HUB` MUST enforce **the same** safety guards as `SSA_LOCAL`, plus:
  - logs or telemetry events MAY be enriched with Hub-related metadata,
  - guard reasons (e.g., Sabbath, Quiet Hours) MAY be included in Hub analytics if configured.

### 3.4 UI & Swap Modal

- In the mode swap modal:
  - `SSA_HUB` SHOULD be labeled as “Family Fund Connected”,
  - require a visual indicator (e.g., Hub icon) and a brief description:
    - “Completed sessions are exported to your Family Fund (if online).”
  - If current session is running:
    - the modal MUST clearly state that export will apply **only after** completion/abort.

---

## 4. `DEMO` Mode

**Intended for**: Quick tryouts, demos, training, or marketing environments.

### 4.1 Pipeline and Behavior

- **Allowed tasks**: Mostly read-only / synthetic:
  - simple imports, short sessions, sample data.
- Sessions MAY be:
  - shorter, pre-canned,
  - not persisted across reloads (depending on `orchestrator.modes.json`).

- **GIVEN** `DEMO` mode is active  
  **THEN**:
  - orchestrator SHOULD NOT modify real inventory, storehouse, or Hub membership data,
  - any Dexie writes SHOULD use a “demo namespace” or be cleaned on exit.

### 4.2 Engagement

- Wake Lock, Notifications, PiP MAY be enabled, but:
  - they SHOULD be tuned for short-lived sessions,
  - frequent, playful toasts are acceptable.

### 4.3 Guard Behavior

- Guards MAY be in `logOnly` mode:
  - e.g., `quietHours.enforced = false, logOnly = true`,
  - sessions should **not** be blocked, but the UI MAY show “(simulated) blocked reason”.

### 4.4 UI & Swap Modal

- In the mode swap modal:
  - `DEMO` MUST be clearly marked as **non-production**, e.g.:
    - “Demo (no real data / exports)”,
  - selecting `DEMO` SHOULD optionally show a confirmation:
    - “This mode uses sample data and will not save your household changes.”

---

## 5. `OFFLINE_FALLBACK` Mode

**Intended for**: When network is unavailable or degraded.

### 5.1 Mode Activation

- **GIVEN** orchestrator detects loss of connectivity (or Hub unreachability)  
  **THEN** it MAY automatically switch to `OFFLINE_FALLBACK` mode IF:
  - `modes.OFFLINE_FALLBACK.autoSwitch` is true.

- On auto-switch:
  - a toast SHOULD be raised:
    - e.g., “Offline mode: sessions will continue locally; Hub export will resume when online.”
  - SessionRunner MUST continue to operate for currently running sessions.

### 5.2 Hub Export Behavior

- In `OFFLINE_FALLBACK`:
  - No immediate Hub calls may be made.
  - Instead, session export payloads SHOULD be queued locally.
  - When connectivity is restored and mode changes back to `SSA_HUB`:
    - orchestrator MAY flush the queued exports,
    - for each successful export, emit `session.exported`.

### 5.3 Guards & Safety

- Safety guards remain active; **offline** status must **not** disable:
  - Sabbath,
  - Quiet Hours,
  - Inventory,
  - Weather (weather may fallback to last-known or local heuristics).

### 5.4 UI & Swap Modal

- In the mode swap modal:
  - `OFFLINE_FALLBACK` SHOULD be surfaced as:
    - “Offline (local only, export queued)” or similar wording,
  - The modal MUST inform the user:
    - that exports will be queued and sent when back online (depending on config).

---

## 6. Mode Swap Behavior (All Modes)

This applies to the **global swap modal** (e.g., accessible from header/toolbar), not a per-session UI.

### 6.1 Core Rules

- **GIVEN** a user opens the mode swap modal  
  **THEN**:
  - it MUST show all configured modes (except those with `hidden: true`),
  - highlight the current mode,
  - display a short description and key properties (Hub export, guards strictness, etc.).

- **GIVEN** a user selects a different mode while a session is running  
  **THEN**:
  - the orchestrator MUST NOT stop the session,
  - SessionRunner should continue running uninterrupted,
  - only newly initiated actions (e.g., exports, guard evaluations, new sessions) use the new mode.

### 6.2 Accessibility & Resilience

- The mode swap modal MUST:
  - be focus-trapped,
  - close on `Escape`,
  - be re-openable at any time without breaking the SessionRunner.

- It MUST be mounted at the app root (via a portal), so route changes do not unmount it while open.

---

## 7. Test Ideas / Scenarios (High-Level)

These are candidate scenarios for future automated tests:

1. **Mode Default & Override**
   - Start app with no override → expect `SSA_LOCAL`.
   - Start app with `?mode=SSA_HUB` → expect `SSA_HUB`.

2. **Switching with Active Session**
   - Start session in `SSA_LOCAL`, progress a few steps.
   - Open mode swap modal, choose `SSA_HUB`.
   - Expect:
     - session remains running,
     - subsequent completion triggers Hub export attempt.

3. **Offline Transition**
   - Start in `SSA_HUB`, start a session.
   - Simulate network down → orchestrator enters `OFFLINE_FALLBACK`.
   - Complete session; confirm:
     - no immediate Hub call,
     - payload is queued.
   - Simulate network up + mode back to `SSA_HUB`.
   - Confirm queued export is flushed and `session.exported` event fired.

4. **Demo Sandbox**
   - In `DEMO`, perform an import → plan session → run session.
   - Confirm:
     - no real inventory/storehouse tables are updated,
     - data lives in demo namespace or is discarded after reload.

5. **Guard Enforcement**
   - In `SSA_LOCAL`, set Sabbath guard to enforced.
   - Attempt to start session during simulated Sabbath.
   - Expect:
     - `session.paused` or pre-run block with `reason: "sabbath"`,
     - no illegal steps executed.

---

## 8. Notes

- This spec is intentionally **framework-agnostic**: it doesn’t assume Jest/RTL, only behavior.
- The orchestrator, SessionRunner, and ToastBus should all treat the **mode** as a declarative input
  — the same eventBus payloads and session contracts apply in all modes; only policies change.
- As modes evolve (e.g., new `TRAINING` or `KIOSK` modes), extend both:
  - `src/config/orchestrator.modes.json`,
  - and this spec with similar GIVEN / WHEN / THEN expectations.