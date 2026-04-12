# DM Persistence Phase PR Summary (2026-04-04)

## Scope
- Persist assign-action side effects in direct messaging state.
- Add explicit integration coverage for deep-link thread opening, cross-module open-thread events, unread persistence, and retry flow.
- Verify no regressions in rollout gate and broader CI checks.

## Functional Changes
- Added persisted direct-messaging fields:
  - taskAssignments
  - moduleNotifications
- Assign action now persists task and notification artifacts alongside message snapshots.
- Failed send rollback restores both conversation state and assign artifacts.
- Incoming message handling now persists unread increments.
- DM state refresh preserves currently selected conversation when valid, preventing deep-link/open-thread context loss during async reload.

## Key Files
- src/pages/settings/ProfileSettingsPage.jsx
- src/services/profile/householdProfileService.js
- _tests_/profileSettings.messages.contract.test.jsx
- _tests_/householdProfileService.messages.contract.test.js
- release-checklist.md

## Test Coverage Added/Expanded
- profileSettings.messages.contract.test.jsx:
  - deep-link query open-thread context
  - cross-module open-thread event routing
  - unread increment + read reset persistence
  - failed-send retry flow
  - assign artifact persistence
- householdProfileService.messages.contract.test.js:
  - patch normalization preserves taskAssignments and moduleNotifications

## Validation Evidence
- test:ssa:rollout:gate: PASSED (14 files, 27 tests)
- lint:ci: PASSED
- typecheck:ci: PASSED
- smoke:e2e: PASSED (2 files, 5 tests)
- smoke:consolidated:check: PASSED

## Risks / Notes
- Workspace currently contains extensive unrelated in-flight changes. Keep this PR scoped to DM-related files only.
- Recommend creating commit using explicit file list to avoid accidental inclusion of unrelated modifications.
