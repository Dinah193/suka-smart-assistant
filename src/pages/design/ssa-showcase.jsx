import React, { useMemo, useState } from "react";
import {
  SSAButton,
  SSAAnimalAvatar,
  SSACard,
  SSAField,
  SSAInput,
  SSATextarea,
  SSASelect,
  SSAToggle,
  SSACheckbox,
  SSARadio,
  SSAHeader,
  SSASidebar,
  SSATabs,
  SSABreadcrumbs,
  SSADropdown,
  SSALayout,
  SSAModal,
  SSADrawer,
  SSAPopover,
  SSAAccordion,
  SSAInlineAlert,
  SSAToastHost,
  SSAProgressBar,
  SSACollabUpdate,
  SSABadge,
  SSAProgressRing,
  SSASkeleton,
  SSAInteractiveTaskList,
  SSAGrowthOverlay,
  SSASeasonalTaskHighlight,
  SSAHouseholdParticipation,
} from "@/components/ssa";

export default function SSAShowcasePage() {
  const [activeTab, setActiveTab] = useState("overview");
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [notifyEnabled, setNotifyEnabled] = useState(true);
  const [priority, setPriority] = useState("normal");
  const [modalOpen, setModalOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [busyState, setBusyState] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [motionExpanded, setMotionExpanded] = useState(true);
  const [motionSeed, setMotionSeed] = useState(0);
  const [season, setSeason] = useState("spring");
  const [completion, setCompletion] = useState(64);
  const [alertLevel, setAlertLevel] = useState(42);
  const [streaks, setStreaks] = useState({
    meals: 6,
    storehouse: 4,
    gardens: 7,
    animals: 5,
  });

  const moduleCues = useMemo(
    () => [
      {
        key: "meals",
        label: "Meals and Batch Cooking",
        cue: "Seasonal recipe lane: root broth, nettle omelet, herb porridge",
        progress: streaks.meals * 10,
        participants: [
          { name: "Mara", value: 5 },
          { name: "Ruth", value: 3 },
          { name: "Eli", value: 2 },
        ],
      },
      {
        key: "storehouse",
        label: "Storehouse and Inventory",
        cue: "Seasonal stock focus: preserves, dehydrated aromatics, broth base",
        progress: streaks.storehouse * 10,
        participants: [
          { name: "Mara", value: 4 },
          { name: "Noah", value: 3 },
          { name: "Jada", value: 3 },
        ],
      },
      {
        key: "gardens",
        label: "Gardens and Orchards",
        cue: "Seasonal crop queue: peas, spinach, strawberries, orchard thinning",
        progress: streaks.gardens * 10,
        participants: [
          { name: "Eli", value: 4 },
          { name: "Ruth", value: 4 },
          { name: "Mara", value: 2 },
        ],
      },
      {
        key: "animals",
        label: "Animal Husbandry",
        cue: "Care + milking + butchering sequence aligned to seasonal tasks",
        progress: streaks.animals * 10,
        participants: [
          { name: "Noah", value: 4 },
          { name: "Mara", value: 3 },
          { name: "Eli", value: 3 },
        ],
      },
    ],
    [streaks]
  );

  async function runStateDemo() {
    setShowSuccess(false);
    setBusyState(true);
    await new Promise((resolve) => {
      setTimeout(resolve, 900);
    });
    setBusyState(false);
    setShowSuccess(true);
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-4 py-6">
      <SSAHeader
        brand="SSA Visual Design System"
        actions={
          <div className="ssa-hero-actions">
            <SSAButton variant="secondary" onClick={() => setModalOpen(true)}>
              Interaction Spec
            </SSAButton>
            <SSAButton variant="primary" onClick={() => setDrawerOpen(true)}>
              Module Cues
            </SSAButton>
            <SSADropdown
              label="Review"
              items={[
                { key: "tokens", label: "Token audit" },
                { key: "a11y", label: "Accessibility pass" },
                { key: "motion", label: "Motion QA" },
              ]}
            />
          </div>
        }
      />

      <SSALayout
        sidebar={
          <SSASidebar
            activeKey={activeTab}
            onSelect={setActiveTab}
            items={[
              { key: "overview", label: "Tokens" },
              { key: "forms", label: "States" },
              { key: "feedback", label: "Module Cues" },
              { key: "fun", label: "Motion + Guidance" },
            ]}
          />
        }
        header={
          <div className="space-y-2">
            <SSABreadcrumbs
              items={[
                { label: "Home", href: "/" },
                { label: "Design" },
                { label: "SSA Visual System" },
              ]}
            />
            <SSATabs
              activeKey={activeTab}
              onChange={setActiveTab}
              tabs={[
                { key: "overview", label: "Tokens" },
                { key: "forms", label: "States" },
                { key: "feedback", label: "Module Cues" },
                { key: "fun", label: "Motion + Guidance" },
              ]}
            />
          </div>
        }
      >
        <div className="grid gap-4 xl:grid-cols-2">
          <section className="ssa-hero-wrap space-y-3 p-4 xl:col-span-2" aria-label="Token overview">
            <h2 className="ssa-hero-title text-lg">Color, Typography, Spacing, and Rhythm</h2>
            <p className="ssa-hero-subtitle">
              Use design tokens as the source of truth. Avoid hardcoded values in page components.
            </p>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] p-3">
                <p className="text-xs text-[var(--ssa-text-secondary)]">Surface</p>
                <div className="mt-2 flex gap-1">
                  <div className="h-8 w-8 rounded bg-[var(--ssa-surface-0)] border border-[var(--ssa-border-subtle)]" />
                  <div className="h-8 w-8 rounded bg-[var(--ssa-surface-1)] border border-[var(--ssa-border-subtle)]" />
                  <div className="h-8 w-8 rounded bg-[var(--ssa-surface-2)] border border-[var(--ssa-border-subtle)]" />
                  <div className="h-8 w-8 rounded bg-[var(--ssa-surface-elevated)] border border-[var(--ssa-border-subtle)]" />
                </div>
              </div>
              <div className="rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] p-3">
                <p className="text-xs text-[var(--ssa-text-secondary)]">Type Scale</p>
                <p className="ssa-hero-title text-lg">H2 Semantic</p>
                <p className="text-sm text-[var(--ssa-text-primary)]">Body Medium Sample</p>
                <p className="text-xs text-[var(--ssa-text-secondary)]">Caption + labels</p>
              </div>
              <div className="rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] p-3">
                <p className="text-xs text-[var(--ssa-text-secondary)]">Spacing Rhythm</p>
                <div className="mt-2 space-y-2">
                  <div className="h-2 w-16 rounded bg-[var(--ssa-action-primary-bg)]" />
                  <div className="h-2 w-24 rounded bg-[var(--ssa-action-primary-bg)]" />
                  <div className="h-2 w-32 rounded bg-[var(--ssa-action-primary-bg)]" />
                </div>
              </div>
              <div className="rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] p-3">
                <p className="text-xs text-[var(--ssa-text-secondary)]">Collaboration Status</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <SSABadge tone="request">request</SSABadge>
                  <SSABadge tone="assigned">assigned</SSABadge>
                  <SSABadge tone="complete">complete</SSABadge>
                  <SSABadge tone="blocked">blocked</SSABadge>
                </div>
              </div>
            </div>
          </section>

          <SSACard
            title="Collaborative feed card"
            subtitle="One component with metadata, actions, and ownership"
            variant="feed"
            season="spring"
            household="Meal Team"
            collaborationStatus="assigned"
            meta="Updated 2 minutes ago"
            actions={
              <>
                <SSAButton variant="secondary">Open</SSAButton>
                <SSAButton variant="primary">Assign</SSAButton>
              </>
            }
          >
            <p>Inventory-first recommendations are now synced to planning and prep flows.</p>
            <div className="mt-3 ssa-hero-actions">
              <SSABadge tone="assigned">Assigned</SSABadge>
              <SSABadge tone="request">Needs review</SSABadge>
            </div>
          </SSACard>

          <SSACard
            title="Media/task card"
            subtitle="Surface visual context plus next actions"
            variant="media"
            season="autumn"
            media={<div className="h-28 w-full bg-[var(--ssa-surface-1)]" aria-label="Media placeholder" />}
            actions={<SSAButton variant="secondary">View details</SSAButton>}
          >
            <p>Use this for gallery, story, or kitchen board style surfaces.</p>
          </SSACard>

          <section className="ssa-hero-wrap space-y-3 p-4 xl:col-span-2" aria-label="Component states">
            <h2 className="ssa-hero-title text-lg">Component State Gallery</h2>
            <p className="ssa-hero-subtitle">
              Default, hover, focus, pressed, disabled, loading, and success examples for action controls.
            </p>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] p-3">
                <p className="text-xs text-[var(--ssa-text-secondary)]">Default</p>
                <div className="mt-2"><SSAButton>Primary</SSAButton></div>
              </div>
              <div className="rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] p-3">
                <p className="text-xs text-[var(--ssa-text-secondary)]">Hover Preview</p>
                <button
                  type="button"
                  className="inline-flex items-center justify-center gap-2 rounded-[var(--ssa-radius-chip)] border border-transparent bg-[var(--ssa-action-primary-hover)] px-3 py-2 text-sm font-semibold text-[var(--ssa-action-primary-fg)] shadow-[var(--ssa-shadow-2)]"
                >
                  Hover
                </button>
              </div>
              <div className="rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] p-3">
                <p className="text-xs text-[var(--ssa-text-secondary)]">Focus</p>
                <button
                  type="button"
                  className="inline-flex items-center justify-center gap-2 rounded-[var(--ssa-radius-chip)] border border-transparent bg-[var(--ssa-action-primary-bg)] px-3 py-2 text-sm font-semibold text-[var(--ssa-action-primary-fg)] ring-2 ring-[var(--ssa-focus-ring-color)] ring-offset-2"
                >
                  Focused
                </button>
              </div>
              <div className="rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] p-3">
                <p className="text-xs text-[var(--ssa-text-secondary)]">Pressed</p>
                <button
                  type="button"
                  className="inline-flex translate-y-[1px] items-center justify-center gap-2 rounded-[var(--ssa-radius-chip)] border border-transparent bg-[var(--ssa-action-primary-pressed)] px-3 py-2 text-sm font-semibold text-[var(--ssa-action-primary-fg)]"
                >
                  Pressed
                </button>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] p-3">
                <p className="text-xs text-[var(--ssa-text-secondary)]">Disabled</p>
                <div className="mt-2"><SSAButton disabled>Disabled</SSAButton></div>
              </div>
              <div className="rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] p-3">
                <p className="text-xs text-[var(--ssa-text-secondary)]">Loading</p>
                <div className="mt-2"><SSAButton loading>Saving</SSAButton></div>
              </div>
              <div className="rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] p-3">
                <p className="text-xs text-[var(--ssa-text-secondary)]">Interactive Success Flow</p>
                <div className="mt-2 flex items-center gap-2">
                  <SSAButton onClick={runStateDemo} loading={busyState}>Run</SSAButton>
                  {showSuccess ? <SSABadge tone="complete">Success</SSABadge> : null}
                </div>
              </div>
            </div>
          </section>

          <section className="ssa-hero-wrap space-y-3 p-4 xl:col-span-2">
            <h2 className="ssa-hero-title text-lg">Form and input primitives</h2>
            <div className="grid gap-3 md:grid-cols-2">
              <SSAField label="Task title" hint="Clear and action-oriented">
                <SSAInput placeholder="Review produce inventory" />
              </SSAField>
              <SSAField label="Domain">
                <SSASelect defaultValue="mealplanner">
                  <option value="mealplanner">Meal planner</option>
                  <option value="storehouse">Storehouse</option>
                  <option value="homestead">Homestead</option>
                </SSASelect>
              </SSAField>
              <SSAField label="Notes" success="Saved as draft">
                <SSATextarea rows={3} defaultValue="Coordinate prep with household B before publish." />
              </SSAField>
              <div className="space-y-3">
                <SSAToggle checked={syncEnabled} onChange={setSyncEnabled} label="Realtime household sync" />
                <SSACheckbox checked={notifyEnabled} onChange={setNotifyEnabled} label="Notify linked households" />
                <div className="ssa-hero-actions">
                  <SSARadio
                    name="priority"
                    value="normal"
                    checked={priority === "normal"}
                    onChange={setPriority}
                    label="Normal"
                  />
                  <SSARadio
                    name="priority"
                    value="high"
                    checked={priority === "high"}
                    onChange={setPriority}
                    label="High"
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="space-y-3 xl:col-span-2">
            <SSAInlineAlert tone={alertLevel > 70 ? "danger" : alertLevel > 40 ? "warning" : "success"}>
              Dynamic alert: stock stress is {alertLevel}% this cycle.
            </SSAInlineAlert>
            <SSAProgressBar value={68} label="Coordination progress" />
            <SSACollabUpdate actor="Mara" action="assigned" target="Preservation queue" />
            <div className="grid gap-2 md:grid-cols-[1fr_220px]">
              <SSAInput
                aria-label="Alert level slider"
                type="range"
                min="0"
                max="100"
                value={alertLevel}
                onChange={(event) => setAlertLevel(Number(event.target.value || 0))}
              />
              <SSABadge tone={alertLevel > 70 ? "blocked" : alertLevel > 40 ? "request" : "complete"}>
                Alert Level {alertLevel}
              </SSABadge>
            </div>
          </section>

          <section className="ssa-hero-wrap space-y-3 p-4 xl:col-span-2" aria-label="Household module seasonal cues">
            <h2 className="ssa-hero-title text-lg">Household Collaboration Cues by Module</h2>
            <div className="grid gap-3 md:grid-cols-[1fr_220px]">
              <SSASelect value={season} onChange={(event) => setSeason(event.target.value)}>
                <option value="spring">Spring</option>
                <option value="summer">Summer</option>
                <option value="autumn">Autumn</option>
                <option value="winter">Winter</option>
              </SSASelect>
              <SSAInput
                type="range"
                min="10"
                max="100"
                value={completion}
                onChange={(event) => setCompletion(Number(event.target.value || 0))}
                aria-label="Module completion"
              />
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              {moduleCues.map((module) => (
                <div key={module.key} className="space-y-2 rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] p-3">
                  <SSASeasonalTaskHighlight
                    season={season}
                    title={module.label}
                    detail={module.cue}
                    urgency={module.progress + completion > 140 ? "high" : "medium"}
                  />
                  <SSAGrowthOverlay
                    label={`${module.label} seasonal readiness`}
                    value={Math.max(0, Math.min(100, Math.round((module.progress + completion) / 2)))}
                  />
                  <SSAHouseholdParticipation
                    label={`${module.label} collaboration participation`}
                    entries={module.participants}
                  />
                </div>
              ))}
            </div>
          </section>

          <section className="grid gap-4 xl:col-span-2 lg:grid-cols-2">
            <div className="space-y-3">
              <div className="ssa-hero-wrap p-3">
                <h3 className="ssa-hero-title text-base">Clean Animal Avatars</h3>
                <div className="mt-2 ssa-hero-actions">
                  <SSAAnimalAvatar animal="sheep" />
                  <SSAAnimalAvatar animal="goats" />
                  <SSAAnimalAvatar animal="cows" />
                  <SSAAnimalAvatar animal="deer" />
                  <SSAAnimalAvatar animal="chickens" />
                  <SSAAnimalAvatar animal="quail" />
                  <SSAAnimalAvatar animal="ducks" />
                  <SSAAnimalAvatar animal="geese" />
                  <SSAAnimalAvatar animal="turkeys" />
                </div>
              </div>

              <SSAAccordion
                items={[
                  {
                    key: "qa",
                    title: "Design QA checklist",
                    content: "Validate contrast, spacing rhythm, and focus order before release.",
                  },
                ]}
              />
              <SSAPopover trigger="Read tips">
                Prefer collaboration cues that encode actor, target, and status in one glance.
              </SSAPopover>
            </div>

            <div className="ssa-hero-wrap space-y-3 p-4">
              <h2 className="ssa-hero-title text-lg">Fun Functional Visualizations</h2>
              <div className="ssa-hero-actions">
                <SSABadge tone="complete">Complete</SSABadge>
                <SSABadge tone="blocked">Blocked</SSABadge>
              </div>
              <SSAGrowthOverlay label="Orchard growth" value={74} />
              <SSASeasonalTaskHighlight
                season="summer"
                urgency="medium"
                title="Harvest squash before rain"
                detail="Prioritize plots 2 and 3 this evening."
              />
              <SSAHouseholdParticipation
                entries={[
                  { name: "Mara", value: 4 },
                  { name: "Ruth", value: 3 },
                  { name: "Eli", value: 2 },
                ]}
              />
              <SSAProgressRing value={74} />
              <div className="space-y-2 rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] p-3">
                <p className="text-xs text-[var(--ssa-text-secondary)]">Collaborative streaks across modules</p>
                {Object.entries(streaks).map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between gap-2">
                    <span className="text-sm capitalize text-[var(--ssa-text-primary)]">{key}</span>
                    <div className="flex items-center gap-2">
                      <SSABadge tone="assigned">{value}d</SSABadge>
                      <SSAButton
                        variant="secondary"
                        onClick={() => setStreaks((prev) => ({ ...prev, [key]: Math.min(14, prev[key] + 1) }))}
                      >
                        +
                      </SSAButton>
                    </div>
                  </div>
                ))}
              </div>
              <SSASkeleton className="h-8 w-full" />
            </div>
          </section>

          <section className="ssa-hero-wrap space-y-3 p-4 xl:col-span-2" aria-label="Motion demos">
            <h2 className="ssa-hero-title text-lg">Motion and Interaction Demos</h2>
            <p className="ssa-hero-subtitle">
              Microinteractions should be fast, purposeful, and reduced-motion friendly.
            </p>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] p-3">
                <p className="text-xs text-[var(--ssa-text-secondary)]">Microinteraction</p>
                <button
                  type="button"
                  onClick={() => setMotionSeed((prev) => prev + 1)}
                  className="mt-2 rounded-[var(--ssa-radius-chip)] border border-[var(--ssa-border-default)] px-3 py-2 text-sm transition-transform duration-150 hover:-translate-y-[1px] active:translate-y-[1px]"
                  style={{ transform: motionSeed % 2 ? "scale(1.02)" : "scale(1)" }}
                >
                  Tap Bounce
                </button>
              </div>
              <div className="rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] p-3">
                <p className="text-xs text-[var(--ssa-text-secondary)]">Transition</p>
                <SSAButton variant="secondary" onClick={() => setMotionExpanded((prev) => !prev)}>
                  Toggle Panel
                </SSAButton>
                <div
                  className="mt-2 overflow-hidden rounded-[var(--ssa-radius-chip)] bg-[var(--ssa-surface-1)] transition-all duration-300"
                  style={{ maxHeight: motionExpanded ? "80px" : "0px", opacity: motionExpanded ? 1 : 0 }}
                >
                  <p className="p-2 text-xs text-[var(--ssa-text-secondary)]">Seasonal panel transitions with stable layout anchoring.</p>
                </div>
              </div>
              <div className="rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] p-3">
                <p className="text-xs text-[var(--ssa-text-secondary)]">Staggered Animation</p>
                <div className="mt-2 grid gap-1">
                  {[0, 1, 2].map((idx) => (
                    <div
                      key={`${motionSeed}-${idx}`}
                      className="rounded bg-[var(--ssa-surface-1)] p-2 text-xs text-[var(--ssa-text-secondary)] transition-all duration-300"
                      style={{
                        opacity: 1,
                        transform: `translateY(${motionSeed % 2 ? 0 : idx * 2}px)`,
                        transitionDelay: `${idx * 60}ms`,
                      }}
                    >
                      Motion lane {idx + 1}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="xl:col-span-2">
            <SSAInteractiveTaskList
              tasks={[
                { id: "t1", title: "Confirm pantry sync", done: false, household: "A" },
                { id: "t2", title: "Publish prep update", done: true, household: "B" },
                { id: "t3", title: "Milking + butchery handoff", done: false, household: "C" },
              ]}
            />
          </section>

          <section className="ssa-hero-wrap space-y-3 p-4 xl:col-span-2" aria-label="Tailwind and CSS guidance">
            <h2 className="ssa-hero-title text-lg">Tailwind/CSS Guidance and Animation Recommendations</h2>
            <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--ssa-text-primary)]">
              <li>Use token-backed classes for color, spacing, and radius; avoid hardcoded hex values in JSX.</li>
              <li>Prefer shared wrappers: <strong>ssa-hero-wrap</strong>, <strong>ssa-hero-chip</strong>, <strong>ssa-hero-actions</strong>.</li>
              <li>All interactive controls must show clear focus-visible rings and keyboard support.</li>
              <li>Use short motion durations (120-300ms) for controls; reserve longer transitions for large layout changes.</li>
              <li>Support reduced-motion by disabling non-essential transforms and stagger effects.</li>
            </ul>
            <pre className="overflow-auto rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] bg-[var(--ssa-surface-1)] p-3 text-xs text-[var(--ssa-text-primary)]">
{`/* Tailwind + token usage */
<button className="rounded-[var(--ssa-radius-chip)] bg-[var(--ssa-action-primary-bg)] text-[var(--ssa-action-primary-fg)] focus-visible:ring-2 focus-visible:ring-[var(--ssa-focus-ring-color)] transition-all duration-150 hover:-translate-y-[1px] active:translate-y-[1px]" />

/* Motion recommendation */
.ssa-motion-panel {
  transition: max-height 280ms var(--ssa-ease-standard), opacity 220ms var(--ssa-ease-standard);
}

@media (prefers-reduced-motion: reduce) {
  .ssa-motion-panel { transition: none; }
}`}
            </pre>
          </section>
        </div>
      </SSALayout>

      <SSAToastHost
        initial={[
          { id: "toast-1", message: "Design review shared with product." },
          { id: "toast-2", message: "Accessibility checklist completed." },
        ]}
      />

      <SSAModal
        open={modalOpen}
        title="SSA Interaction Spec"
        onClose={() => setModalOpen(false)}
        footer={<SSAButton onClick={() => setModalOpen(false)}>Close</SSAButton>}
      >
        <p>
          Required interaction states: default, hover, focus, pressed, disabled, loading, success.
          Each must be discoverable in keyboard and touch contexts.
        </p>
      </SSAModal>

      <SSADrawer open={drawerOpen} title="Household Module Cue Matrix" onClose={() => setDrawerOpen(false)}>
        <div className="space-y-2 text-sm text-[var(--ssa-text-primary)]">
          <p>Meals: seasonal recipe indicators and batch windows.</p>
          <p>Storehouse: seasonal stock management and preserve thresholds.</p>
          <p>Gardens: seasonal crops, orchard milestones, and relay readiness.</p>
          <p>Animals: care lanes, milking cycles, butchering prep, and seasonal tasks.</p>
        </div>
      </SSADrawer>
    </div>
  );
}
