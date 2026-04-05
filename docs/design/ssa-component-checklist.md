# SSA Component Checklist (Mapped to Current Components)

Source references:
- `docs/design/ssa-ui-spec-pack.md`
- `docs/design/doet-page-matrix.md`

Checklist status key:
- `[ ]` not started
- `[~]` in progress
- `[x]` complete

## A) Foundation Primitives (must land first)

| Status | Component | Current File | Required SSA Upgrade |
|---|---|---|---|
| [ ] | Button primitive | `src/components/ui/button.jsx` | Adopt action and state tokens; full hover/focus/pressed/loading states |
| [ ] | Card primitive | `src/components/ui/card.jsx` | Apply layered surface and border tokens; selected state style |
| [ ] | Tabs primitive | `src/components/ui/tabs.jsx` | Add active/disabled/unread badge hooks and keyboard parity |
| [ ] | Dialog primitive | `src/components/ui/dialog.jsx` | Standardize focus trap, submit/loading states, and motion tokens |
| [ ] | Input primitive | `src/components/ui/input.jsx` | Add focus-visible ring tokens and disabled helper-text conventions |
| [ ] | Select primitive | `src/components/ui/select.jsx` | Align state styling and validation feedback tokens |
| [ ] | Checkbox primitive | `src/components/ui/checkbox.jsx` | Normalize focus, checked, indeterminate, and disabled states |
| [ ] | Skeleton primitive | `src/components/ui/skeleton.jsx` | Move to loading token shimmer and container-friendly variants |
| [ ] | Toast hook/UI | `src/components/ui/use-toast.jsx` | Map success/warning/danger/info tones to status tokens |
| [ ] | Badge primitive | `src/components/ui/badge.jsx` | Add collaboration status variants (request/assigned/completed/blocked) |

## B) Shared System Components

| Status | Component | Current File | Required SSA Upgrade |
|---|---|---|---|
| [ ] | Section header | `src/components/ui/SectionHeader.jsx` | Use heading typography scale and rhythm spacing tokens |
| [ ] | Section card | `src/components/ui/SectionCard.jsx` | Enforce card elevations and selected/disabled states |
| [ ] | Page hero | `src/components/ui/PageHero.jsx` | Add route identity, cycle status slot, and responsive spacing |
| [ ] | Empty placeholder | `src/components/ui/EmptyPlaceholder.jsx` | Include action guidance and optional collaboration CTA |
| [ ] | Loading boundary | `src/components/common/LoadingBoundary.jsx` | Standardize loading and error communication patterns |
| [ ] | Next best action bar | `src/components/common/NextBestActionBar.jsx` | Adopt collaboration chip variants and action hierarchy |
| [ ] | Data status | `src/components/shared/DataStatus.jsx` | Standardize status semantics and icon + label requirements |
| [ ] | Confirm bar | `src/components/shared/ConfirmBar.jsx` | Add pressed/disabled state treatment and undo support |

## C) Planner and Mission-Control Surface Components

| Status | Component | Current File | Required SSA Upgrade |
|---|---|---|---|
| [ ] | Planner dashboard card | `src/components/planners/PlannerDashboardCard.jsx` | Add KPI hierarchy and tokenized card layers |
| [ ] | Household automation panel | `src/components/planners/HouseholdAutomationPanel.jsx` | Align toggles, alerts, and ownership metadata styling |
| [ ] | Homestead planner shell | `src/components/homestead/HomesteadPlannerShell.jsx` | Adopt mission-control layout conventions |
| [ ] | Planner section card | `src/components/homestead/PlannerSectionCard.jsx` | Add explicit selected/blocked/in-progress visual states |
| [ ] | Progressive disclosure panel | `src/components/homestead/ProgressiveDisclosurePanel.jsx` | Apply accordion rules and reduced-motion behavior |
| [ ] | Homestead planner subnav | `src/components/homestead/HomesteadPlannerSubnav.jsx` | Align active tab and unread/alert counters |
| [ ] | Homestead readiness card | `src/components/homestead/HomesteadReadinessCard.jsx` | Use status and risk token mapping |
| [~] | Meal planner dashboard | `src/components/meals/MealPlannerDashboard.jsx` | Enforce dual-pane collaboration + execution affordance; controls regression coverage added in `_tests_/mealPlanner.controls.contract.test.jsx`; social persistence/handoff coverage landed in `_tests_/mealPlanner.contextFeedActions.contract.test.js`, `_tests_/mealPlanner.feedInteractions.ui.contract.test.jsx`, and `_tests_/mealPlanner.crossModuleHandoff.contract.test.js` with startup hardening commit `2d9974e` |
| [ ] | Grocery list panel | `src/components/meals/GroceryListPanel.jsx` | Add collaboration transfer actions and state chips |
| [ ] | Storehouse queue planner | `src/components/storehouse/PreservationQueuePlanner.jsx` | Standardize warning and deadline visual language |

## D) Collaboration and Social-Operational Components

| Status | Component | Current File | Required SSA Upgrade |
|---|---|---|---|
| [ ] | Realtime coordination panel | `src/components/home/RealtimeCoordinationPanel.jsx` | Add operational feed-to-action conversion behavior |
| [ ] | Notification item | `src/components/sacred/Notification.jsx` | Apply alert matrix states and escalation affordances |
| [ ] | Feed post | `src/components/sacred/FeedPost.jsx` | Add task conversion actions and household context chips |
| [ ] | Role assignment panel | `src/components/shared/RoleAssignmentPanel.jsx` | Enforce assignment and reassignment interaction states |
| [ ] | Inline toast anchor | `src/components/toasts/InlineToastAnchor.jsx` | Align to status tokenized messaging and undo timing |

## E) Supporting Legacy-Primitives Alignment (track only)

| Status | Component | Current File | Required SSA Upgrade |
|---|---|---|---|
| [ ] | Sacred button | `src/components/sacred/Button.jsx` | Resolve divergence vs `ui/button.jsx` token contract |
| [ ] | Sacred card | `src/components/sacred/Card.jsx` | Resolve divergence vs `ui/card.jsx` token contract |
| [ ] | Sacred avatar | `src/components/sacred/Avatar.jsx` | Map shape/depth/typography to SSA tokens |
| [ ] | Dashboard grid | `src/components/sacred/DashboardGrid.jsx` | Ensure mission-control layout spacing and columns |

## Exit Criteria

1. Every component above consumes tokenized values from `src/styles/ssa-token-seed.css` (or equivalent imported bridge).
2. Every interactive component supports: default, hover, focus-visible, disabled, loading.
3. Priority components support state-specific variants: error, success, blocked, assigned, complete.
4. No page-level hardcoded color values remain in planner and community routes for upgraded components.
