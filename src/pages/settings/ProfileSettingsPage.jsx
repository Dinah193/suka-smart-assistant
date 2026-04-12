import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Link } from "react-router-dom";
import * as ProfileService from "@/services/profile/householdProfileService";
import eventBus from "@/services/events/eventBus";
import {
  SSAAnimalAvatar,
  SSABadge,
  SSAButton,
  SSACard,
  SSAField,
  SSAHouseholdParticipation,
  SSAInlineAlert,
  SSAInput,
  SSAInteractiveTaskList,
  SSAProgressRing,
  SSASeasonalTaskHighlight,
  SSASelect,
  SSAModal,
  SSATabs,
  SSATextarea,
  SSAToastHost,
  SSAToggle,
  SSAGrowthOverlay,
} from "@/components/ssa";
import { getSeasonKey, getSeasonLabel } from "@/utils/season";

const TAB_POSTS = "posts";
const TAB_MEDIA = "media";
const TAB_SAVED = "saved";
const TAB_TASKS = "tasks";
const TAB_JOBS = "jobs";
const TAB_MESSAGES = "messages";
const TAB_SETTINGS = "settings";

const TAB_ITEMS = [
  { key: TAB_POSTS, label: "Posts" },
  { key: TAB_MEDIA, label: "Media" },
  { key: TAB_SAVED, label: "Saved" },
  { key: TAB_TASKS, label: "Collaborative Tasks" },
  { key: TAB_JOBS, label: "Seasonal Work" },
  { key: TAB_MESSAGES, label: "Messages" },
  { key: TAB_SETTINGS, label: "Settings" },
];

const FEED_ITEMS = [
  {
    id: "post-1",
    title: "Spring sowing window confirmed",
    subtitle: "Two households synced seed trays and irrigation prep.",
    season: "spring",
    household: "Willow Collective",
    status: "assigned",
    animal: "chickens",
    meta: "12m ago",
    body:
      "Seedling transfer starts at dusk. We aligned meal prep and coop checks to avoid overlap.",
    tags: ["#sowing", "#householdsync", "#seasonalwork"],
    participation: [
      { name: "Willow", value: 5 },
      { name: "Oak", value: 3 },
      { name: "Stonefield", value: 2 },
    ],
    progress: 63,
  },
  {
    id: "post-2",
    title: "Preservation relay organized",
    subtitle: "Batch canning and labeling split across allies.",
    season: "autumn",
    household: "Oak and Hearth",
    status: "request",
    animal: "goats",
    meta: "46m ago",
    body:
      "Four jars per household this evening. Shared checklist now mapped to next-day meal cycle.",
    tags: ["#preserving", "#taskrelay", "#agrarianfeed"],
    participation: [
      { name: "Oak", value: 4 },
      { name: "Willow", value: 3 },
      { name: "Brook", value: 1 },
    ],
    progress: 48,
  },
  {
    id: "post-3",
    title: "Livestock lane maintenance closed",
    subtitle: "Water, feed, and bedding checkpoints complete.",
    season: "summer",
    household: "Stonefield Home",
    status: "complete",
    animal: "ducks",
    meta: "1h ago",
    body:
      "Shared maintenance closed early so the household can start market prep before sunset.",
    tags: ["#livestock", "#maintenance", "#collaboration"],
    participation: [
      { name: "Stonefield", value: 6 },
      { name: "Willow", value: 2 },
      { name: "Oak", value: 2 },
    ],
    progress: 91,
  },
];

const HOUSEHOLDS = [
  { id: "h1", name: "Willow Collective", animal: "chickens", status: "assigned" },
  { id: "h2", name: "Oak and Hearth", animal: "goats", status: "request" },
  { id: "h3", name: "Stonefield Home", animal: "ducks", status: "complete" },
  { id: "h4", name: "Meadow Keep", animal: "sheep", status: "assigned" },
];

const MODULE_NOTIFICATIONS = [
  {
    id: "notif-meals-1",
    module: "meals",
    moduleLabel: "Meals and Batch Cooking",
    title: "Seasonal menu reminder",
    message: "Spring herb menu closes in 4 hours. Confirm batch prep portions.",
    seasonalContext: "Seasonal recipe focus: nettle omelet and root broth",
    severity: "warning",
    progress: 58,
    household: "Willow Collective",
    animal: "chickens",
    unread: true,
    collaborativeSignal: "2 households requested shared prep window",
  },
  {
    id: "notif-storehouse-1",
    module: "storehouse",
    moduleLabel: "Storehouse Inventory and Replenishment",
    title: "Seasonal stock tracking",
    message: "Berry preserve jars below target threshold for early summer demand.",
    seasonalContext: "Replenishment target: +18 jars before heat wave",
    severity: "warning",
    progress: 46,
    household: "Oak and Hearth",
    animal: "goats",
    unread: true,
    collaborativeSignal: "Shared stock transfer offered by Meadow Keep",
  },
  {
    id: "notif-garden-1",
    module: "gardens",
    moduleLabel: "Gardens and Orchards",
    title: "Seasonal crop milestone",
    message: "Orchard thinning milestone reached. Next pass due by sunset.",
    seasonalContext: "Current crops: peas, spinach, early strawberries",
    severity: "info",
    progress: 71,
    household: "Stonefield Home",
    animal: "deer",
    unread: false,
    collaborativeSignal: "1 household joined orchard relay",
  },
  {
    id: "notif-animals-1",
    module: "animals",
    moduleLabel: "Animal Husbandry",
    title: "Seasonal husbandry task",
    message: "Milking and butchery handoff sequence queued for evening round.",
    seasonalContext: "Care lane: milking checks + feed rotation + butchery prep",
    severity: "warning",
    progress: 63,
    household: "Meadow Keep",
    animal: "cows",
    unread: true,
    collaborativeSignal: "3 households aligned care roster",
  },
];

const MODULE_TASKS = [
  { id: "mod-task-1", title: "Confirm spring batch menu", done: false, household: "Meals" },
  { id: "mod-task-2", title: "Replenish preserve shelf lane", done: false, household: "Storehouse" },
  { id: "mod-task-3", title: "Log orchard thinning checkpoint", done: true, household: "Gardens" },
  { id: "mod-task-4", title: "Assign milking and butchery handoff", done: false, household: "Husbandry" },
];

const DM_MODULES = [
  {
    key: "meals",
    label: "Meals and Batch Cooking",
    seasonalHighlight: "Seasonal recipes: nettle omelet, root broth, herb porridge",
  },
  {
    key: "storehouse",
    label: "Storehouse and Inventory",
    seasonalHighlight: "Seasonal stock alert: berry preserves below summer target",
  },
  {
    key: "gardens",
    label: "Gardens and Orchards",
    seasonalHighlight: "Seasonal crops: peas, spinach, early strawberries",
  },
  {
    key: "animals",
    label: "Animal Husbandry",
    seasonalHighlight: "Seasonal care: milking rota, feed checks, butchery prep",
  },
];

const DM_CONVERSATIONS = [
  {
    id: "dm-1",
    household: "Willow Collective",
    animal: "chickens",
    unread: 2,
    status: "assigned",
    lastAt: "2m ago",
    lastMessage: "Can we shift evening batch prep after orchard pass?",
    moduleParticipation: [
      { name: "Meals", value: 5 },
      { name: "Storehouse", value: 3 },
      { name: "Gardens", value: 4 },
      { name: "Husbandry", value: 2 },
    ],
    thread: [
      {
        id: "dm-1-msg-1",
        from: "other",
        body: "Can we shift evening batch prep after orchard pass?",
        moduleKey: "meals",
        seasonalCue: "Spring herb menu closes tonight",
        at: "5:44 PM",
      },
      {
        id: "dm-1-msg-2",
        from: "me",
        body: "Yes, and we can assign preserve replenishment right after.",
        moduleKey: "storehouse",
        seasonalCue: "Low berry preserve jars",
        at: "5:46 PM",
      },
    ],
  },
  {
    id: "dm-2",
    household: "Oak and Hearth",
    animal: "goats",
    unread: 1,
    status: "request",
    lastAt: "14m ago",
    lastMessage: "Need orchard milestone update before canning run.",
    moduleParticipation: [
      { name: "Meals", value: 2 },
      { name: "Storehouse", value: 5 },
      { name: "Gardens", value: 5 },
      { name: "Husbandry", value: 1 },
    ],
    thread: [
      {
        id: "dm-2-msg-1",
        from: "other",
        body: "Need orchard milestone update before canning run.",
        moduleKey: "gardens",
        seasonalCue: "Summer orchard ladder cycle",
        at: "5:30 PM",
      },
    ],
  },
  {
    id: "dm-3",
    household: "Stonefield Home",
    animal: "deer",
    unread: 0,
    status: "complete",
    lastAt: "1h ago",
    lastMessage: "Milking and butchery handoff finalized for autumn lane.",
    moduleParticipation: [
      { name: "Meals", value: 4 },
      { name: "Storehouse", value: 4 },
      { name: "Gardens", value: 3 },
      { name: "Husbandry", value: 6 },
    ],
    thread: [
      {
        id: "dm-3-msg-1",
        from: "other",
        body: "Milking and butchery handoff finalized for autumn lane.",
        moduleKey: "animals",
        seasonalCue: "Autumn husbandry readiness",
        at: "4:49 PM",
      },
    ],
  },
];

const MEDIA_STORIES = [
  {
    id: "story-1",
    title: "Dawn irrigation relay",
    subtitle: "Shared garden lanes watered before sun-rise heat.",
    season: "spring",
    household: "Willow Collective",
    status: "assigned",
    animal: "chickens",
    meta: "Today · 05:42",
    preview: "Hover to preview moisture, labor, and handoff status.",
    body:
      "Garden rows 2-5 were split across two households so breakfast prep stayed uninterrupted.",
    progress: 68,
    layers: { meals: 62, storehouse: 54, gardens: 84, livestock: 36 },
    participants: [
      { name: "Willow", animal: "chickens", value: 4 },
      { name: "Oak", animal: "goats", value: 3 },
      { name: "Stonefield", animal: "deer", value: 2 },
    ],
    activities: ["Water Relay", "Mulch Handoff", "Gate Check"],
    modules: [
      {
        key: "meals",
        title: "Meals and Batch Cooking",
        detail: "Breakfast-prep overlap reduced with shared dawn task windows and spring timing.",
        participation: 61,
        seasonalTag: "Spring recipe highlight",
        seasonalItems: ["Nettle omelet", "Herb porridge", "Radish pickle side"],
      },
      {
        key: "storehouse",
        title: "Storehouse and Preservation",
        detail: "Freezer labels and canning queue staged for post-irrigation handoff in current season.",
        participation: 54,
        seasonalTag: "Seasonal stock alert",
        stockAlert: "Low spring jam jars: 6 remaining",
      },
      {
        key: "gardens",
        title: "Gardens and Orchards",
        detail: "Irrigation and mulch pass completed across high-priority beds for spring growth.",
        participation: 84,
        seasonalTag: "Seasonal crops",
        seasonalItems: ["Peas", "Spinach", "Early strawberries"],
      },
      {
        key: "animals",
        title: "Animal Husbandry",
        detail: "Morning feed and milking check integrated before seasonal field tasks.",
        participation: 48,
        seasonalTag: "Seasonal husbandry tasks",
        seasonalItems: ["Goat milking rota", "Chick brooder checks", "Pasture fence walkthrough"],
      },
    ],
  },
  {
    id: "story-2",
    title: "Orchard ladder chain",
    subtitle: "Rotating ladder and crate flow for safe fruit harvest.",
    season: "summer",
    household: "Oak and Hearth",
    status: "request",
    animal: "goats",
    meta: "Today · 12:16",
    preview: "Tap to expand full harvest sequence and participation map.",
    body:
      "Crate transfer points were synchronized with midday shade windows to reduce drop loss.",
    progress: 52,
    layers: { meals: 46, storehouse: 58, gardens: 62, livestock: 29 },
    participants: [
      { name: "Oak", animal: "goats", value: 5 },
      { name: "Willow", animal: "chickens", value: 3 },
      { name: "Meadow", animal: "turkeys", value: 2 },
    ],
    activities: ["Crate Relay", "Sorting Table", "Wash Line"],
    modules: [
      {
        key: "meals",
        title: "Meals and Batch Cooking",
        detail: "Harvest timing aligned to evening batch roasting for summer workload balancing.",
        participation: 46,
        seasonalTag: "Summer recipe highlight",
        seasonalItems: ["Stone-fruit cobbler", "Tomato skillet", "Zucchini bake"],
      },
      {
        key: "storehouse",
        title: "Storehouse and Preservation",
        detail: "Fruit batches split into fresh-use and preserve lanes for summer shelf planning.",
        participation: 58,
        seasonalTag: "Seasonal stock alert",
        stockAlert: "Fermentation crock near capacity (92%)",
      },
      {
        key: "gardens",
        title: "Gardens and Orchards",
        detail: "Orchard ladder zones rotated for safer picking cadence during high-heat windows.",
        participation: 62,
        seasonalTag: "Seasonal crops",
        seasonalItems: ["Plums", "Summer squash", "Runner beans"],
      },
      {
        key: "animals",
        title: "Animal Husbandry",
        detail: "Livestock checks performed between crate relay rounds and seasonal heat protocol.",
        participation: 43,
        seasonalTag: "Seasonal husbandry tasks",
        seasonalItems: ["Cooling trough refill", "Milking shade shifts", "Poultry hydration checks"],
      },
    ],
  },
  {
    id: "story-3",
    title: "Barn-to-cellar preserve run",
    subtitle: "Livestock outputs and pantry prep merged in one cycle.",
    season: "autumn",
    household: "Stonefield Home",
    status: "complete",
    animal: "cows",
    meta: "Yesterday · 18:08",
    preview: "Open story to replay canning and labeling timeline.",
    body:
      "Evening batching finished early, leaving extra time for feed checks and morning meal setup.",
    progress: 93,
    layers: { meals: 86, storehouse: 94, gardens: 77, livestock: 88 },
    participants: [
      { name: "Stonefield", animal: "cows", value: 6 },
      { name: "Willow", animal: "chickens", value: 2 },
      { name: "Oak", animal: "turkeys", value: 2 },
    ],
    activities: ["Canning Sprint", "Label Pass", "Feed Round"],
    modules: [
      {
        key: "meals",
        title: "Meals and Batch Cooking",
        detail: "Butchering and milking outputs converted to meal-ready batches for autumn demand.",
        participation: 86,
        seasonalTag: "Autumn recipe highlight",
        seasonalItems: ["Root stew", "Cider braise", "Pumpkin mash"],
      },
      {
        key: "storehouse",
        title: "Storehouse and Preservation",
        detail: "Canning, cooling, and shelf indexing completed as part of autumn preservation sprint.",
        participation: 94,
        seasonalTag: "Seasonal stock alert",
        stockAlert: "Apple preserves low for winter target (43% complete)",
      },
      {
        key: "gardens",
        title: "Gardens and Orchards",
        detail: "Root crop wash and orchard cull integrated into preserve sequence for seasonal turnover.",
        participation: 77,
        seasonalTag: "Seasonal crops",
        seasonalItems: ["Pumpkins", "Beets", "Late apples"],
      },
      {
        key: "animals",
        title: "Animal Husbandry",
        detail: "Livestock care, milking, and butchery handoff closed before dusk in peak preserve window.",
        participation: 88,
        seasonalTag: "Seasonal husbandry tasks",
        seasonalItems: ["Butchery prep", "Winter feed batching", "Milking parity checks"],
      },
    ],
  },
];

const DEFAULT_PROFILE_SETTINGS = Object.freeze({
  displayName: "Mara of Willow Collective",
  primaryRole: "coordinator",
  bio: "Focused on household meal cycles, preservation, and seasonal task harmonization.",
  receiveSeasonalAlerts: true,
  allowTaskInvitations: true,
  autoSharePlaybooks: false,
});

const DEFAULT_DM_STATE = Object.freeze({
  conversations: DM_CONVERSATIONS,
  selectedConversationId: DM_CONVERSATIONS[0]?.id || null,
  taskAssignments: [],
  moduleNotifications: [],
  lastUpdatedAt: null,
});

function profileToDirectMessaging(profile) {
  const incoming = profile?.directMessaging;
  if (!incoming || typeof incoming !== "object") return DEFAULT_DM_STATE;

  const conversations = Array.isArray(incoming.conversations)
    ? incoming.conversations
    : DM_CONVERSATIONS;
  const taskAssignments = Array.isArray(incoming.taskAssignments)
    ? incoming.taskAssignments
    : [];
  const moduleNotifications = Array.isArray(incoming.moduleNotifications)
    ? incoming.moduleNotifications
    : [];

  return {
    conversations,
    selectedConversationId: incoming.selectedConversationId || conversations[0]?.id || null,
    taskAssignments,
    moduleNotifications,
    lastUpdatedAt: incoming.lastUpdatedAt || null,
  };
}

function buildOpenThreadRequestFromSearch(search) {
  try {
    const params = new URLSearchParams(String(search || ""));
    const conversationId = String(params.get("dmConversation") || "").trim();
    const moduleKey = String(params.get("dmModule") || "").trim();
    const actionType = String(params.get("dmAction") || "").trim();
    const prefill = String(params.get("dmPrefill") || "").trim();

    if (!conversationId && !moduleKey && !actionType && !prefill) return null;

    return {
      conversationId: conversationId || null,
      moduleKey: moduleKey || null,
      actionType: actionType || null,
      prefill: prefill || null,
      source: "query",
      nonce: Date.now(),
    };
  } catch {
    return null;
  }
}

function getProfileServiceMethod(methodName) {
  try {
    const candidate = ProfileService?.[methodName];
    return typeof candidate === "function" ? candidate : null;
  } catch {
    return null;
  }
}

function toBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  return fallback;
}

function profileToSettings(profile) {
  const household = profile?.household || {};
  const notifications = profile?.notifications || {};
  return {
    displayName: String(household?.profileDisplayName || DEFAULT_PROFILE_SETTINGS.displayName),
    primaryRole: String(household?.profileRole || DEFAULT_PROFILE_SETTINGS.primaryRole),
    bio: String(household?.profileBio || DEFAULT_PROFILE_SETTINGS.bio),
    receiveSeasonalAlerts: toBoolean(
      notifications?.profileSeasonalAlerts,
      DEFAULT_PROFILE_SETTINGS.receiveSeasonalAlerts
    ),
    allowTaskInvitations: toBoolean(
      notifications?.profileTaskInvitations,
      DEFAULT_PROFILE_SETTINGS.allowTaskInvitations
    ),
    autoSharePlaybooks: toBoolean(
      household?.profileAutoSharePlaybooks,
      DEFAULT_PROFILE_SETTINGS.autoSharePlaybooks
    ),
  };
}

function settingsToPatch(settings) {
  return {
    household: {
      profileDisplayName: settings.displayName.trim(),
      profileRole: settings.primaryRole,
      profileBio: settings.bio.trim(),
      profileAutoSharePlaybooks: !!settings.autoSharePlaybooks,
    },
    notifications: {
      profileSeasonalAlerts: !!settings.receiveSeasonalAlerts,
      profileTaskInvitations: !!settings.allowTaskInvitations,
    },
  };
}

export default function ProfileSettingsPage({ initialTab = TAB_POSTS }) {
  const [activeTab, setActiveTab] = useState(initialTab);
  const [alertsMuted, setAlertsMuted] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState(DEFAULT_PROFILE_SETTINGS);
  const [savedSettings, setSavedSettings] = useState(DEFAULT_PROFILE_SETTINGS);
  const [dmState, setDmState] = useState(DEFAULT_DM_STATE);
  const [openThreadRequest, setOpenThreadRequest] = useState(null);
  const [saveState, setSaveState] = useState("idle");

  const seasonKey = useMemo(() => getSeasonKey(new Date()), []);
  const seasonLabel = useMemo(() => getSeasonLabel(seasonKey), [seasonKey]);
  const isDirty = useMemo(
    () => JSON.stringify(settingsDraft) !== JSON.stringify(savedSettings),
    [settingsDraft, savedSettings]
  );

  useEffect(() => {
    if (!ProfileService?.loadProfile) return;

    const loaded = ProfileService.loadProfile();
    const mapped = profileToSettings(loaded);
    const mappedDirectMessaging = profileToDirectMessaging(loaded);
    setSettingsDraft(mapped);
    setSavedSettings(mapped);
    setDmState(mappedDirectMessaging);

    const loadDirectMessaging = getProfileServiceMethod("loadDirectMessaging");
    if (loadDirectMessaging) {
      loadDirectMessaging().then((messages) => {
        if (messages && typeof messages === "object") {
          setDmState(profileToDirectMessaging({ directMessaging: messages }));
        }
      }).catch(() => {
        // local profile fallback already loaded
      });
    }

    if (!ProfileService?.subscribe) return;
    const unsubscribe = ProfileService.subscribe((profile) => {
      const next = profileToSettings(profile);
      const nextDirectMessaging = profileToDirectMessaging(profile);
      setSettingsDraft(next);
      setSavedSettings(next);
      setDmState(nextDirectMessaging);
      setSaveState("idle");
    });

    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);

  useEffect(() => {
    const request = buildOpenThreadRequestFromSearch(globalThis?.location?.search || "");
    if (!request) return;
    setActiveTab(TAB_MESSAGES);
    setOpenThreadRequest(request);
  }, []);

  useEffect(() => {
    const offOpenThread = eventBus?.on?.("profile/messages/open-thread", (payload) => {
      const data = payload?.data || payload || {};
      setActiveTab(TAB_MESSAGES);
      setOpenThreadRequest({
        conversationId: data?.conversationId || null,
        moduleKey: data?.moduleKey || null,
        actionType: data?.actionType || null,
        prefill: data?.prefill || null,
        source: "eventBus",
        nonce: Date.now(),
      });
    });

    return () => {
      if (typeof offOpenThread === "function") offOpenThread();
    };
  }, []);

  async function persistDirectMessaging(nextMessages) {
    setDmState(nextMessages);
    const patchDirectMessaging = getProfileServiceMethod("patchDirectMessaging");
    if (!patchDirectMessaging) return { ok: true };
    return patchDirectMessaging(nextMessages);
  }

  async function appendDirectMessage(payload) {
    const appendDirectMessageMethod = getProfileServiceMethod("appendDirectMessage");
    if (!appendDirectMessageMethod) {
      return {
        ok: true,
        messages: {
          conversations: dmState.conversations,
          selectedConversationId: dmState.selectedConversationId,
        },
      };
    }
    return appendDirectMessageMethod(payload);
  }

  function openThreadByHousehold(household, moduleKey = null) {
    const target = (dmState.conversations || []).find(
      (conversation) => String(conversation?.household || "").toLowerCase() === String(household || "").toLowerCase()
    );

    setActiveTab(TAB_MESSAGES);
    setOpenThreadRequest({
      conversationId: target?.id || null,
      moduleKey: moduleKey || null,
      source: "profile",
      nonce: Date.now(),
    });
  }

  async function handleSaveSettings() {
    if (!ProfileService?.patchProfile) return;
    setSaveState("saving");

    try {
      ProfileService.patchProfile(settingsToPatch(settingsDraft));
      setSavedSettings(settingsDraft);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  function handleResetSettings() {
    if (!ProfileService?.patchProfile) {
      setSettingsDraft(savedSettings);
      setSaveState("idle");
      return;
    }

    setSaveState("saving");
    try {
      ProfileService.patchProfile(settingsToPatch(savedSettings));
      setSettingsDraft(savedSettings);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-3 pb-10 pt-4 sm:px-4">
      <section className="ssa-hero-wrap overflow-hidden p-4 sm:p-5" aria-label="Profile header">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-center">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <SSAAnimalAvatar animal="cows" size="lg" label="Household profile avatar" />
              <div>
                <h1 className="ssa-hero-title text-2xl">{settingsDraft.displayName}</h1>
                <p className="ssa-hero-subtitle">
                  {settingsDraft.bio}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2" aria-label="Profile stats">
              <SSABadge tone="assigned">128 posts</SSABadge>
              <SSABadge tone="complete">42 shared completions</SSABadge>
              <SSABadge tone="request">9 open collaboration requests</SSABadge>
              <SSABadge>Streak: 18 days</SSABadge>
            </div>

            <div className="ssa-hero-actions">
              <SSAButton variant="primary">Follow Household</SSAButton>
              <SSAButton variant="secondary">Invite to Collaboration</SSAButton>
              <SSAButton variant="secondary" onClick={() => openThreadByHousehold("Willow Collective", "meals")}>Message</SSAButton>
            </div>
          </div>

          <div className="space-y-3">
            <SSAGrowthOverlay label={`${seasonLabel} streak`} value={78} className="ssa-seasonal-card" />
            <div className="grid grid-cols-2 gap-3">
              <div className="ssa-hero-wrap p-3 text-center">
                <SSAProgressRing value={74} />
                <p className="mt-2 text-xs text-[var(--ssa-text-secondary)]">Household Growth</p>
              </div>
              <div className="ssa-hero-wrap p-3 text-center">
                <SSAProgressRing value={59} />
                <p className="mt-2 text-xs text-[var(--ssa-text-secondary)]">Seasonal Workload</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="ssa-hero-wrap p-3" aria-label="Profile tabs">
        <SSATabs
          tabs={TAB_ITEMS}
          activeKey={activeTab}
          onChange={setActiveTab}
        />
      </section>

      <AnimatePresence mode="wait" initial={false}>
        <motion.section
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]"
        >
          <div className="space-y-4">
            {activeTab === TAB_POSTS && (
              <PostsPane seasonLabel={seasonLabel} seasonKey={seasonKey} onOpenThread={openThreadByHousehold} />
            )}

            {activeTab === TAB_MEDIA && (
              <MediaPane />
            )}

            {activeTab === TAB_SAVED && (
              <SavedPane />
            )}

            {activeTab === TAB_TASKS && (
              <TasksPane />
            )}

            {activeTab === TAB_JOBS && (
              <JobsPane seasonLabel={seasonLabel} />
            )}

            {activeTab === TAB_MESSAGES && (
              <MessagesPane
                seasonLabel={seasonLabel}
                dmState={dmState}
                onPersistMessages={persistDirectMessaging}
                onAppendMessage={appendDirectMessage}
                openThreadRequest={openThreadRequest}
                onHandledOpenRequest={() => setOpenThreadRequest(null)}
              />
            )}

            {activeTab === TAB_SETTINGS && (
              <SettingsPane
                settingsDraft={settingsDraft}
                setSettingsDraft={setSettingsDraft}
                onSave={handleSaveSettings}
                onReset={handleResetSettings}
                isDirty={isDirty}
                saveState={saveState}
              />
            )}
          </div>

          <aside className="space-y-4" aria-label="Alerts and collaboration sidebar">
            <NotificationsPanel
              alertsMuted={alertsMuted}
              setAlertsMuted={setAlertsMuted}
              seasonLabel={seasonLabel}
              onOpenThread={openThreadByHousehold}
            />
          </aside>
        </motion.section>
      </AnimatePresence>
    </div>
  );
}

function PostsPane({ seasonLabel, seasonKey, onOpenThread }) {
  return (
    <>
      <section className="relative overflow-hidden rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] bg-[var(--ssa-surface-elevated)] p-4">
        <div className="absolute -right-6 -top-6 h-24 w-24 rounded-full bg-[var(--ssa-surface-2)] opacity-40" aria-hidden="true" />
        <div className="absolute -bottom-5 left-10 h-16 w-16 rounded-full bg-[var(--ssa-surface-1)] opacity-50" aria-hidden="true" />
        <h2 className="ssa-hero-title text-lg">{seasonLabel} Collaboration Layer</h2>
        <p className="ssa-hero-subtitle">Layered cards show shared agrarian flow across households.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <SSASeasonalTaskHighlight
            season={seasonKey}
            title="Primary seasonal push"
            detail="Align sowing windows with preservation and livestock support tasks."
            urgency="high"
          />
          <SSASeasonalTaskHighlight
            season={seasonKey}
            title="Secondary support cycle"
            detail="Prepare storage, labeling, and handoff tasks for weekly meal cycles."
            urgency="medium"
          />
        </div>
      </section>

      <section className="space-y-3" aria-label="Household posts feed">
        {FEED_ITEMS.map((item) => (
          <article
            key={item.id}
            className="rounded-[var(--ssa-radius-card)] transition-all hover:-translate-y-[1px] hover:shadow-[var(--ssa-shadow-2)] focus-within:ring-2 focus-within:ring-[var(--ssa-focus-ring-color)]"
          >
            <SSACard
              title={item.title}
              subtitle={item.subtitle}
              variant="feed"
              household={item.household}
              collaborationStatus={item.status}
              season={item.season}
              meta={item.meta}
              actions={
                <>
                  <SSAButton variant="secondary">Coordinate</SSAButton>
                  <SSAButton variant="primary" onClick={() => onOpenThread?.(item.household, "meals")}>Open Thread</SSAButton>
                </>
              }
            >
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <SSAAnimalAvatar animal={item.animal} size="sm" label={item.household} />
                  <span className="text-sm text-[var(--ssa-text-secondary)]">{item.household}</span>
                </div>
                <p>{item.body}</p>
                <div className="flex flex-wrap gap-2">
                  {item.tags.map((tag) => (
                    <SSABadge key={`${item.id}-${tag}`}>{tag}</SSABadge>
                  ))}
                </div>
                <SSAHouseholdParticipation
                  label="Household Participation"
                  entries={item.participation}
                />
                <SSAGrowthOverlay label="Collaboration Progress" value={item.progress} />
              </div>
            </SSACard>
          </article>
        ))}
      </section>
    </>
  );
}

function MediaPane() {
  const prefersReducedMotion = useReducedMotion();
  const [activeIndex, setActiveIndex] = useState(0);
  const [hoveredStoryId, setHoveredStoryId] = useState(null);
  const [expandedStoryId, setExpandedStoryId] = useState(null);
  const [activityPulse, setActivityPulse] = useState({});
  const [moduleActivityPulse, setModuleActivityPulse] = useState({});

  const activeStory = MEDIA_STORIES[activeIndex] || MEDIA_STORIES[0];
  const expandedStory =
    MEDIA_STORIES.find((story) => story.id === expandedStoryId) || null;
  const hoveredStory =
    MEDIA_STORIES.find((story) => story.id === hoveredStoryId) || null;

  function goNext() {
    setActiveIndex((prev) => (prev + 1) % MEDIA_STORIES.length);
  }

  function goPrev() {
    setActiveIndex((prev) =>
      prev - 1 < 0 ? MEDIA_STORIES.length - 1 : prev - 1
    );
  }

  function handleStorySwipe(_, info) {
    if (info.offset.x < -70) {
      goNext();
      return;
    }
    if (info.offset.x > 70) {
      goPrev();
    }
  }

  function handleStoryKeyDown(event) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      goNext();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      goPrev();
    }
  }

  function bumpActivity(storyId, activityLabel) {
    const key = `${storyId}:${activityLabel}`;
    setActivityPulse((prev) => ({
      ...prev,
      [key]: (prev[key] || 0) + 1,
    }));
  }

  function bumpModuleActivity(storyId, moduleKey, actionType) {
    const key = `${storyId}:${moduleKey}:${actionType}`;
    setModuleActivityPulse((prev) => ({
      ...prev,
      [key]: (prev[key] || 0) + 1,
    }));
  }

  return (
    <section className="space-y-3" aria-label="Media tab">
      <div className="ssa-hero-wrap p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="ssa-hero-title text-lg">Stories and Media</h2>
            <p className="ssa-hero-subtitle">
              Swipe through seasonal agrarian stories and expand each card for collaboration detail.
            </p>
          </div>
          <div className="ssa-hero-actions" aria-label="Story navigation controls">
            <SSAButton variant="secondary" onClick={goPrev} aria-label="Previous story">
              Previous
            </SSAButton>
            <SSAButton variant="secondary" onClick={goNext} aria-label="Next story">
              Next
            </SSAButton>
          </div>
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={activeStory.id}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            onDragEnd={handleStorySwipe}
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: 28 }}
            animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, x: 0 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: -24 }}
            transition={{ duration: prefersReducedMotion ? 0.12 : 0.24, ease: "easeOut" }}
            className="mt-3"
            role="group"
            aria-label={`${activeStory.title} story card`}
            tabIndex={0}
            onKeyDown={handleStoryKeyDown}
          >
            <motion.div whileHover={{ y: -2 }} transition={{ duration: 0.16 }}>
              <SSACard
                title={activeStory.title}
                subtitle={activeStory.subtitle}
                season={activeStory.season}
                household={activeStory.household}
                collaborationStatus={activeStory.status}
                variant="media"
                meta={activeStory.meta}
                media={
                  <StoryDepthMedia
                    story={activeStory}
                    onExpand={() => setExpandedStoryId(activeStory.id)}
                  />
                }
                actions={
                  <>
                    <SSAButton
                      variant="secondary"
                      onClick={() => setExpandedStoryId(activeStory.id)}
                    >
                      Expand Story
                    </SSAButton>
                    <SSAButton variant="primary" onClick={goNext}>
                      Next Story
                    </SSAButton>
                  </>
                }
              >
                <div className="space-y-3">
                  <p>{activeStory.body}</p>
                  <SSAGrowthOverlay
                    label="Story collaboration progress"
                    value={activeStory.progress}
                  />
                  <ModuleParticipationGrid
                    story={activeStory}
                    moduleActivityPulse={moduleActivityPulse}
                    onModuleAction={bumpModuleActivity}
                  />
                  <SSAHouseholdParticipation
                    label="Household Participation"
                    entries={activeStory.participants}
                  />
                  <div className="flex flex-wrap gap-2" aria-label="Shared activities">
                    {activeStory.activities.map((activity) => {
                      const activityKey = `${activeStory.id}:${activity}`;
                      const count = activityPulse[activityKey] || 0;
                      return (
                        <motion.button
                          key={activityKey}
                          type="button"
                          whileTap={{ scale: 0.96 }}
                          onClick={() => bumpActivity(activeStory.id, activity)}
                          className="rounded-[var(--ssa-radius-chip)] border border-[var(--ssa-border-default)] bg-[var(--ssa-surface-elevated)] px-3 py-1.5 text-xs font-semibold text-[var(--ssa-text-primary)] transition hover:bg-[var(--ssa-surface-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ssa-focus-ring-color)]"
                          aria-label={`${activity} interaction count ${count}`}
                        >
                          {activity} {count > 0 ? `· ${count}` : ""}
                        </motion.button>
                      );
                    })}
                  </div>
                </div>
              </SSACard>
            </motion.div>
          </motion.div>
        </AnimatePresence>

        <div className="mt-3 grid gap-2 sm:grid-cols-3" aria-label="Story carousel index">
          {MEDIA_STORIES.map((story, index) => {
            const isActive = index === activeIndex;
            return (
              <button
                key={story.id}
                type="button"
                className={`rounded-[var(--ssa-radius-chip)] border p-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ssa-focus-ring-color)] ${
                  isActive
                    ? "border-[var(--ssa-action-primary-bg)] bg-[var(--ssa-surface-1)]"
                    : "border-[var(--ssa-border-subtle)] bg-[var(--ssa-surface-elevated)] hover:bg-[var(--ssa-surface-1)]"
                }`}
                onMouseEnter={() => setHoveredStoryId(story.id)}
                onFocus={() => setHoveredStoryId(story.id)}
                onMouseLeave={() => setHoveredStoryId(null)}
                onBlur={() => setHoveredStoryId(null)}
                onClick={() => setActiveIndex(index)}
                aria-current={isActive ? "true" : undefined}
                aria-label={`Show ${story.title}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-[var(--ssa-text-primary)]">
                    {story.title}
                  </span>
                  <SSAAnimalAvatar animal={story.animal} size="sm" label={story.household} />
                </div>
                <p className="mt-1 text-xs text-[var(--ssa-text-secondary)]">
                  {story.preview}
                </p>
              </button>
            );
          })}
        </div>

        <AnimatePresence>
          {hoveredStory && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.15 }}
              className="mt-2 rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] bg-[var(--ssa-surface-elevated)] p-3"
              role="status"
              aria-label="Story hover preview"
            >
              <div className="flex items-center gap-2">
                <SSAAnimalAvatar animal={hoveredStory.animal} size="sm" label={hoveredStory.household} />
                <strong className="text-sm text-[var(--ssa-text-primary)]">
                  {hoveredStory.household} preview
                </strong>
              </div>
              <p className="mt-1 text-sm text-[var(--ssa-text-secondary)]">{hoveredStory.preview}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {hoveredStory.modules.slice(0, 3).map((module) => (
                  <SSABadge key={`${hoveredStory.id}-${module.key}`}>
                    {module.title}: {module.participation}%
                  </SSABadge>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <SSAModal
        open={!!expandedStory}
        title={expandedStory ? expandedStory.title : "Story"}
        onClose={() => setExpandedStoryId(null)}
      >
        {expandedStory && (
          <div className="space-y-3">
            <StoryDepthMedia story={expandedStory} compact />
            <p className="text-sm text-[var(--ssa-text-primary)]">{expandedStory.body}</p>
            <SSAGrowthOverlay
              label="Expanded story progress"
              value={expandedStory.progress}
            />
            <ModuleParticipationGrid
              story={expandedStory}
              moduleActivityPulse={moduleActivityPulse}
              onModuleAction={bumpModuleActivity}
            />
            <div className="rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-subtle)] p-3">
              <h3 className="ssa-hero-title text-base">Household participants</h3>
              <ul className="mt-2 space-y-2">
                {expandedStory.participants.map((participant) => (
                  <li
                    key={`${expandedStory.id}-${participant.name}`}
                    className="flex items-center justify-between gap-2"
                  >
                    <div className="flex items-center gap-2">
                      <SSAAnimalAvatar
                        animal={participant.animal}
                        size="sm"
                        label={participant.name}
                      />
                      <span className="text-sm text-[var(--ssa-text-primary)]">{participant.name}</span>
                    </div>
                    <SSABadge>{participant.value} shifts</SSABadge>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </SSAModal>
    </section>
  );
}

function StoryDepthMedia({ story, onExpand, compact = false }) {
  const layerItems = [
    { key: "meals", label: "Meals", tone: "bg-[var(--ssa-status-info)]" },
    { key: "storehouse", label: "Storehouse", tone: "bg-[var(--ssa-status-warning)]" },
    { key: "gardens", label: "Gardens", tone: "bg-[var(--ssa-status-success)]" },
    { key: "livestock", label: "Livestock", tone: "bg-[var(--ssa-collab-assigned)]" },
  ];

  return (
    <div
      className={`relative w-full overflow-hidden rounded-[var(--ssa-radius-card)] bg-[linear-gradient(120deg,var(--ssa-surface-1),var(--ssa-surface-2))] ${compact ? "h-44" : "h-36 sm:h-44"}`}
    >
      <motion.div
        initial={{ opacity: 0.35, y: 18 }}
        animate={{ opacity: 0.6, y: 0 }}
        transition={{ duration: 0.45, ease: "easeOut" }}
        className="absolute bottom-0 left-0 right-0 h-20 bg-[linear-gradient(180deg,transparent,var(--ssa-surface-2))]"
        aria-hidden="true"
      />
      <div className="absolute left-3 right-3 top-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {layerItems.map((layer, index) => (
          <motion.div
            key={`${story.id}-${layer.key}`}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 0.9, y: 0 }}
            transition={{ delay: 0.05 + index * 0.04, duration: 0.3 }}
            className={`rounded-full px-2 py-1 text-[10px] font-semibold text-[var(--ssa-text-on-accent)] ${layer.tone}`}
          >
            {layer.label} {story.layers[layer.key]}%
          </motion.div>
        ))}
      </div>
      <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2">
        <div className="flex -space-x-2">
          {story.participants.map((participant) => (
            <span
              key={`${story.id}-${participant.name}-avatar`}
              className="rounded-full border-2 border-[var(--ssa-surface-elevated)]"
            >
              <SSAAnimalAvatar
                animal={participant.animal}
                size="sm"
                label={participant.name}
              />
            </span>
          ))}
        </div>
        <SSAButton
          variant="secondary"
          onClick={onExpand}
          aria-label={`Expand ${story.title}`}
        >
          Expand
        </SSAButton>
      </div>
    </div>
  );
}

function NotificationsPanel({ alertsMuted, setAlertsMuted, seasonLabel, onOpenThread }) {
  const [activeAlerts, setActiveAlerts] = useState(MODULE_NOTIFICATIONS);
  const [selectedAlertId, setSelectedAlertId] = useState(null);
  const [toastSeed, setToastSeed] = useState(0);

  const unreadCount = useMemo(
    () => activeAlerts.filter((alert) => alert.unread).length,
    [activeAlerts]
  );

  const overallProgress = useMemo(() => {
    if (!activeAlerts.length) return 0;
    const sum = activeAlerts.reduce((acc, alert) => acc + Number(alert.progress || 0), 0);
    return Math.round(sum / activeAlerts.length);
  }, [activeAlerts]);

  const toastItems = useMemo(
    () =>
      activeAlerts
        .filter((alert) => alert.unread)
        .slice(0, 3)
        .map((alert) => ({
          id: `toast-${alert.id}-${toastSeed}`,
          message: `${alert.moduleLabel}: ${alert.title}`,
        })),
    [activeAlerts, toastSeed]
  );

  const selectedAlert =
    activeAlerts.find((alert) => alert.id === selectedAlertId) || null;

  function markRead(alertId) {
    setActiveAlerts((prev) =>
      prev.map((alert) =>
        alert.id === alertId
          ? {
              ...alert,
              unread: false,
            }
          : alert
      )
    );
    setToastSeed((prev) => prev + 1);
  }

  function markUnread(alertId) {
    setActiveAlerts((prev) =>
      prev.map((alert) =>
        alert.id === alertId
          ? {
              ...alert,
              unread: true,
            }
          : alert
      )
    );
    setToastSeed((prev) => prev + 1);
  }

  return (
    <>
      <section className="ssa-hero-wrap p-4" aria-label="Notifications panel">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="ssa-hero-title text-base">Module Notifications</h2>
            <p className="text-xs text-[var(--ssa-text-secondary)]">
              {seasonLabel} context is embedded in each household module update.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <SSABadge tone={unreadCount > 0 ? "request" : "complete"}>
              Unread {unreadCount}
            </SSABadge>
            <SSAToggle
              checked={!alertsMuted}
              onChange={(next) => setAlertsMuted(!next)}
              label={alertsMuted ? "Muted" : "Live"}
            />
          </div>
        </div>

        <div className="mb-3 grid grid-cols-[88px_minmax(0,1fr)] gap-3 rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-subtle)] p-3">
          <div className="flex items-center justify-center">
            <SSAProgressRing value={overallProgress} />
          </div>
          <div className="space-y-2">
            <SSAInlineAlert tone="info">
              Cross-module readiness is at {overallProgress}% with {unreadCount} unread collaboration signals.
            </SSAInlineAlert>
            <SSAGrowthOverlay label="Notification Resolution" value={overallProgress} />
          </div>
        </div>

        <div className="space-y-2" aria-label="Stacked notifications">
          <AnimatePresence initial={false}>
            {activeAlerts.map((alert, index) => (
              <motion.div
                key={alert.id}
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ delay: Math.min(index * 0.04, 0.16), duration: 0.2 }}
                className="rounded-[var(--ssa-radius-card)]"
              >
                <SSACard
                  title={alert.title}
                  subtitle={alert.moduleLabel}
                  household={alert.household}
                  collaborationStatus={alert.unread ? "request" : "complete"}
                  variant="feed"
                  meta={alert.collaborativeSignal}
                  actions={
                    <>
                      <SSAButton
                        variant="secondary"
                        onClick={() => setSelectedAlertId(alert.id)}
                      >
                        View
                      </SSAButton>
                      {alert.unread ? (
                        <SSAButton
                          variant="primary"
                          onClick={() => markRead(alert.id)}
                        >
                          Mark Read
                        </SSAButton>
                      ) : (
                        <SSAButton
                          variant="secondary"
                          onClick={() => markUnread(alert.id)}
                        >
                          Mark Unread
                        </SSAButton>
                      )}
                      <SSAButton
                        variant="secondary"
                        onClick={() => onOpenThread?.(alert.household, alert.module)}
                      >
                        Open Thread
                      </SSAButton>
                    </>
                  }
                >
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <SSAAnimalAvatar animal={alert.animal} size="sm" label={alert.household} />
                      <SSABadge>{alert.seasonalContext}</SSABadge>
                    </div>
                    <p>{alert.message}</p>
                    <SSAGrowthOverlay
                      label={`${alert.moduleLabel} progress`}
                      value={alert.progress}
                    />
                    <div className="rounded-[var(--ssa-radius-chip)] border border-[var(--ssa-border-subtle)] p-2 text-xs text-[var(--ssa-text-secondary)]">
                      {alert.module === "meals" && "Seasonal menu reminders: prep windows + recipe handoff active."}
                      {alert.module === "storehouse" && "Seasonal stock tracking: replenish preserves before next cycle."}
                      {alert.module === "gardens" && "Seasonal crops: orchard and bed milestones aligned to weather window."}
                      {alert.module === "animals" && "Seasonal care: milking, butchering, and feed rotations synchronized."}
                    </div>
                  </div>
                </SSACard>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </section>

      <section className="ssa-hero-wrap p-4" aria-label="Module task queue">
        <h3 className="ssa-hero-title text-base">Interactive Module To-Do</h3>
        <p className="mb-2 text-xs text-[var(--ssa-text-secondary)]">
          Mark participation, assign task lanes, and log module activity in one queue.
        </p>
        <SSAInteractiveTaskList tasks={MODULE_TASKS} />
      </section>

      <SSAModal
        open={!!selectedAlert}
        title={selectedAlert ? selectedAlert.title : "Notification"}
        onClose={() => setSelectedAlertId(null)}
      >
        {selectedAlert && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <SSAAnimalAvatar
                animal={selectedAlert.animal}
                size="sm"
                label={selectedAlert.household}
              />
              <span className="text-sm text-[var(--ssa-text-primary)]">{selectedAlert.household}</span>
              <SSABadge>{selectedAlert.moduleLabel}</SSABadge>
            </div>
            <SSAInlineAlert tone={selectedAlert.severity}>{selectedAlert.message}</SSAInlineAlert>
            <SSAGrowthOverlay
              label="Resolution progress"
              value={selectedAlert.progress}
            />
            <div className="rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-subtle)] p-3">
              <h4 className="ssa-hero-title text-sm">Seasonal context</h4>
              <p className="mt-1 text-sm text-[var(--ssa-text-secondary)]">{selectedAlert.seasonalContext}</p>
              <p className="mt-2 text-xs text-[var(--ssa-text-secondary)]">{selectedAlert.collaborativeSignal}</p>
            </div>
          </div>
        )}
      </SSAModal>

      <SSAToastHost initial={toastItems} />
    </>
  );
}

function ModuleParticipationGrid({ story, moduleActivityPulse, onModuleAction }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2" aria-label="Module participation grid">
      {story.modules.map((module) => (
        <SSACard
          key={`${story.id}-${module.key}`}
          title={module.title}
          subtitle={module.detail}
          variant="task"
          actions={
            <ModuleActionBar
              storyId={story.id}
              moduleKey={module.key}
              moduleActivityPulse={moduleActivityPulse}
              onModuleAction={onModuleAction}
            />
          }
        >
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <SSABadge>{module.seasonalTag}</SSABadge>
              {module.key === "storehouse" && module.stockAlert ? (
                <SSAInlineAlert tone="warning">{module.stockAlert}</SSAInlineAlert>
              ) : null}
            </div>
            {Array.isArray(module.seasonalItems) && module.seasonalItems.length > 0 ? (
              <div className="flex flex-wrap gap-2" aria-label={`${module.title} seasonal context`}>
                {module.seasonalItems.map((item) => (
                  <SSABadge key={`${story.id}-${module.key}-${item}`}>{item}</SSABadge>
                ))}
              </div>
            ) : null}
            <SSAGrowthOverlay
              label={`${module.title} participation`}
              value={module.participation}
            />
          </div>
        </SSACard>
      ))}
    </div>
  );
}

function ModuleActionBar({
  storyId,
  moduleKey,
  moduleActivityPulse,
  onModuleAction,
}) {
  const actions = [
    { key: "participation", label: "Mark Participation" },
    { key: "assign", label: "Assign Task" },
    { key: "log", label: "Log Activity" },
  ];

  return (
    <div className="flex flex-wrap gap-2" aria-label="Module microinteractions">
      {actions.map((action) => {
        const pulseKey = `${storyId}:${moduleKey}:${action.key}`;
        const count = moduleActivityPulse[pulseKey] || 0;
        return (
          <motion.button
            key={pulseKey}
            type="button"
            whileTap={{ scale: 0.97 }}
            onClick={() => onModuleAction(storyId, moduleKey, action.key)}
            className="rounded-[var(--ssa-radius-chip)] border border-[var(--ssa-border-default)] bg-[var(--ssa-surface-elevated)] px-2 py-1 text-xs font-semibold text-[var(--ssa-text-primary)] transition hover:bg-[var(--ssa-surface-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ssa-focus-ring-color)]"
            aria-label={`${action.label} count ${count}`}
          >
            {action.label} {count > 0 ? `(${count})` : ""}
          </motion.button>
        );
      })}
    </div>
  );
}

function SavedPane() {
  return (
    <section className="space-y-3" aria-label="Saved tab">
      {FEED_ITEMS.slice(0, 2).map((item) => (
        <SSACard
          key={`saved-${item.id}`}
          title={`Saved: ${item.title}`}
          subtitle="Bookmarked for recurring seasonal coordination"
          season={item.season}
          household={item.household}
          collaborationStatus="assigned"
          actions={<SSAButton variant="secondary">Reopen</SSAButton>}
        >
          <div className="space-y-2">
            <p>{item.body}</p>
            <SSAGrowthOverlay label="Reusable Playbook Readiness" value={item.progress} />
          </div>
        </SSACard>
      ))}
    </section>
  );
}

function TasksPane() {
  return (
    <section className="space-y-3" aria-label="Collaborative Tasks tab">
      <SSAInteractiveTaskList
        tasks={[
          { id: "ct-1", title: "Finalize spring sowing rota", done: false, household: "Willow" },
          { id: "ct-2", title: "Publish canning checklist", done: true, household: "Oak" },
          { id: "ct-3", title: "Assign coop lane inspection", done: false, household: "Stonefield" },
        ]}
      />
      <SSACard
        title="Task handoff lane"
        subtitle="Quick actions for role assignment and escalation"
        variant="task"
        actions={
          <>
            <SSAButton variant="secondary">Assign Roles</SSAButton>
            <SSAButton variant="primary">Escalate Blockers</SSAButton>
          </>
        }
      >
        Keep collaboration lanes explicit: assign owner, due window, and fallback household in one pass.
      </SSACard>
    </section>
  );
}

function JobsPane({ seasonLabel }) {
  return (
    <section className="space-y-3" aria-label="Seasonal Work tab">
      <SSACard
        title={`${seasonLabel} Seasonal Work`}
        subtitle="Seasonal work is managed on the Jobs page"
        variant="alert"
        actions={
          <Link to="/tasks" className="inline-flex">
            <SSAButton variant="primary">Open Jobs Page</SSAButton>
          </Link>
        }
      >
        This tab routes you to the full Jobs workflow where seasonal execution, replay, and assignment tracking live.
      </SSACard>
    </section>
  );
}

function MessagesPane({
  seasonLabel,
  dmState,
  onPersistMessages,
  onAppendMessage,
  openThreadRequest,
  onHandledOpenRequest,
}) {
  const prefersReducedMotion = useReducedMotion();
  const [conversations, setConversations] = useState(dmState?.conversations || DM_CONVERSATIONS);
  const [activeConversationId, setActiveConversationId] = useState(
    dmState?.selectedConversationId || dmState?.conversations?.[0]?.id || DM_CONVERSATIONS[0]?.id || null
  );
  const [composerText, setComposerText] = useState("");
  const [selectedModule, setSelectedModule] = useState("meals");
  const [composerAction, setComposerAction] = useState("send");
  const [isTyping, setIsTyping] = useState(false);
  const [deliveryToastItems, setDeliveryToastItems] = useState([]);
  const [composerError, setComposerError] = useState("");
  const [failedMessages, setFailedMessages] = useState([]);
  const [liveStatus, setLiveStatus] = useState("");
  const [taskAssignments, setTaskAssignments] = useState(
    Array.isArray(dmState?.taskAssignments) ? dmState.taskAssignments : []
  );
  const [moduleNotifications, setModuleNotifications] = useState(
    Array.isArray(dmState?.moduleNotifications) ? dmState.moduleNotifications : []
  );
  const threadEndRef = useRef(null);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) || conversations[0],
    [conversations, activeConversationId]
  );

  const moduleMap = useMemo(
    () => Object.fromEntries(DM_MODULES.map((module) => [module.key, module])),
    []
  );

  useEffect(() => {
    const incomingConversations = Array.isArray(dmState?.conversations) && dmState.conversations.length
      ? dmState.conversations
      : DM_CONVERSATIONS;
    const preferredConversationId = dmState?.selectedConversationId || incomingConversations[0]?.id || null;
    setConversations(incomingConversations);
    setActiveConversationId((previousConversationId) => {
      if (
        previousConversationId
        && incomingConversations.some((conversation) => conversation.id === previousConversationId)
      ) {
        return previousConversationId;
      }
      return preferredConversationId;
    });
    setTaskAssignments(Array.isArray(dmState?.taskAssignments) ? dmState.taskAssignments : []);
    setModuleNotifications(Array.isArray(dmState?.moduleNotifications) ? dmState.moduleNotifications : []);
  }, [
    dmState?.conversations,
    dmState?.selectedConversationId,
    dmState?.taskAssignments,
    dmState?.moduleNotifications,
  ]);

  useEffect(() => {
    if (!threadEndRef.current) return;
    if (typeof threadEndRef.current.scrollIntoView === "function") {
      threadEndRef.current.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth" });
    }
  }, [activeConversation?.thread, prefersReducedMotion]);

  useEffect(() => {
    if (!openThreadRequest) return;

    if (openThreadRequest.conversationId) {
      setActiveConversationId(openThreadRequest.conversationId);
    }
    if (openThreadRequest.moduleKey && moduleMap[openThreadRequest.moduleKey]) {
      setSelectedModule(openThreadRequest.moduleKey);
    }
    if (openThreadRequest.actionType) {
      setComposerAction(openThreadRequest.actionType);
    }
    if (openThreadRequest.prefill) {
      setComposerText(openThreadRequest.prefill);
    }

    if (typeof onHandledOpenRequest === "function") {
      onHandledOpenRequest();
    }
  }, [openThreadRequest, moduleMap, onHandledOpenRequest]);

  useEffect(() => {
    const unsubscribeIncoming = eventBus?.on?.("profile/messages/incoming", (payload) => {
      const data = payload?.data || payload || {};
      if (!data?.conversationId || !data?.message) return;

      setConversations((prev) => {
        const next = prev.map((conversation) => {
          if (conversation.id !== data.conversationId) return conversation;

          const existingThread = Array.isArray(conversation.thread) ? conversation.thread : [];
          if (existingThread.some((item) => item.id === data.message.id)) {
            return conversation;
          }

          const nextThread = [...existingThread, data.message];
          return {
            ...conversation,
            thread: nextThread,
            lastMessage: data.message.body,
            lastAt: data.message.at || "just now",
            unread:
              conversation.id === activeConversationId
                ? conversation.unread
                : Number(conversation.unread || 0) + 1,
          };
        });
        Promise.resolve().then(() => {
          persistSnapshot(next, activeConversationId);
        });
        return next;
      });

      setLiveStatus("New message received");
    });

    const unsubscribeTyping = eventBus?.on?.("profile/messages/typing", (payload) => {
      const data = payload?.data || payload || {};
      if (!data?.conversationId || data.conversationId !== activeConversationId) return;
      setIsTyping(Boolean(data.isTyping));
    });

    return () => {
      if (typeof unsubscribeIncoming === "function") unsubscribeIncoming();
      if (typeof unsubscribeTyping === "function") unsubscribeTyping();
    };
  }, [activeConversationId]);

  async function persistSnapshot(nextConversations, nextActiveConversationId, extras = {}) {
    if (typeof onPersistMessages !== "function") return;
    await onPersistMessages({
      conversations: nextConversations,
      selectedConversationId: nextActiveConversationId,
      taskAssignments: Array.isArray(extras.taskAssignments) ? extras.taskAssignments : taskAssignments,
      moduleNotifications: Array.isArray(extras.moduleNotifications)
        ? extras.moduleNotifications
        : moduleNotifications,
      lastUpdatedAt: new Date().toISOString(),
    });
  }

  function updateConversation(conversationId, updater) {
    setConversations((prev) =>
      prev.map((conversation) =>
        conversation.id === conversationId ? updater(conversation) : conversation
      )
    );
  }

  function markConversationRead(conversationId) {
    const next = conversations.map((conversation) =>
      conversation.id === conversationId
        ? {
            ...conversation,
            unread: 0,
          }
        : conversation
    );
    setConversations(next);
    persistSnapshot(next, conversationId);

    eventBus?.emit?.("profile/messages/read", {
      conversationId,
      at: new Date().toISOString(),
    });
  }

  async function sendMessage() {
    const text = String(composerText || "").trim();
    if (!text || !activeConversation) return;
    setComposerError("");

    const now = new Date();
    const sentAt = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const optimisticMessageId = `${activeConversation.id}-msg-${Date.now()}`;
    const newMessage = {
      id: optimisticMessageId,
      from: "me",
      body: text,
      moduleKey: selectedModule,
      seasonalCue: moduleMap[selectedModule]?.seasonalHighlight || "Seasonal collaboration",
      at: sentAt,
      actionType: composerAction,
    };

    const previousConversations = conversations;
    const previousTaskAssignments = taskAssignments;
    const previousModuleNotifications = moduleNotifications;
    const nextConversations = conversations.map((conversation) =>
      conversation.id === activeConversation.id
        ? {
            ...conversation,
            thread: [...conversation.thread, newMessage],
            lastMessage: text,
            lastAt: "now",
          }
        : conversation
    );

    const createdAt = new Date().toISOString();
    const nextTaskAssignments =
      composerAction === "assign"
        ? [
            {
              id: `task-assign-${Date.now()}`,
              conversationId: activeConversation.id,
              household: activeConversation.household,
              moduleKey: selectedModule,
              title: text,
              createdAt,
              status: "assigned",
            },
            ...taskAssignments,
          ].slice(0, 30)
        : taskAssignments;

    const nextModuleNotifications =
      composerAction === "assign"
        ? [
            {
              id: `notif-assign-${Date.now()}`,
              conversationId: activeConversation.id,
              moduleKey: selectedModule,
              message: `Assigned task: ${text}`,
              unread: true,
              createdAt,
            },
            ...moduleNotifications,
          ].slice(0, 30)
        : moduleNotifications;

    setConversations(nextConversations);
    if (composerAction === "assign") {
      setTaskAssignments(nextTaskAssignments);
      setModuleNotifications(nextModuleNotifications);
    }
    await persistSnapshot(nextConversations, activeConversation.id, {
      taskAssignments: nextTaskAssignments,
      moduleNotifications: nextModuleNotifications,
    });

    setComposerText("");
    setDeliveryToastItems((prev) => [
      {
        id: `toast-delivered-${Date.now()}`,
        message: `${moduleMap[selectedModule]?.label || "Module"} message delivered`,
      },
      ...prev,
    ].slice(0, 3));

    eventBus?.emit?.("profile/messages/sent", {
      conversationId: activeConversation.id,
      message: newMessage,
      at: new Date().toISOString(),
    });

    if (composerAction === "assign") {
      eventBus?.emit?.("profile/messages/task-assigned", {
        conversationId: activeConversation.id,
        taskTitle: text,
        moduleKey: selectedModule,
      });
    }

    if (typeof onAppendMessage === "function") {
      const persisted = await onAppendMessage({
        conversationId: activeConversation.id,
        message: newMessage,
      });

      if (!persisted?.ok) {
        setConversations(previousConversations);
        if (composerAction === "assign") {
          setTaskAssignments(previousTaskAssignments);
          setModuleNotifications(previousModuleNotifications);
        }
        await persistSnapshot(previousConversations, activeConversation.id, {
          taskAssignments: previousTaskAssignments,
          moduleNotifications: previousModuleNotifications,
        });
        setComposerText(text);
        setComposerError("Message send failed. Retry when connection is available.");
        setFailedMessages((prev) => [
          {
            id: `failed-${optimisticMessageId}`,
            conversationId: activeConversation.id,
            body: text,
            moduleKey: selectedModule,
            actionType: composerAction,
          },
          ...prev,
        ].slice(0, 3));
        return;
      }

      if (persisted?.messages) {
        setConversations(persisted.messages.conversations || nextConversations);
      }
    }

    setIsTyping(true);
    setTimeout(() => {
      const replyMessage = {
        id: `${activeConversation.id}-reply-${Date.now()}`,
        from: "other",
        body: `Acknowledged. We'll sync ${moduleMap[selectedModule]?.label || "module"} lane and update assignments.`,
        moduleKey: selectedModule,
        seasonalCue: moduleMap[selectedModule]?.seasonalHighlight || "Seasonal context synced",
        at: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      };

      const next = conversations.map((conversation) =>
        conversation.id === activeConversation.id
          ? {
              ...conversation,
              thread: [...conversation.thread, replyMessage],
              lastMessage: replyMessage.body,
              lastAt: "just now",
              unread:
                conversation.id === activeConversationId
                  ? conversation.unread
                  : Number(conversation.unread || 0) + 1,
            }
          : conversation
      );

      setConversations(next);
      persistSnapshot(next, activeConversation.id);
      setIsTyping(false);
    }, 900);
  }

  async function retryFailedMessage(failedMessage) {
    setComposerText(failedMessage.body);
    setSelectedModule(failedMessage.moduleKey || "meals");
    setComposerAction(failedMessage.actionType || "send");
    setActiveConversationId(failedMessage.conversationId);
    setFailedMessages((prev) => prev.filter((item) => item.id !== failedMessage.id));
  }

  return (
    <section className="space-y-3" aria-label="Direct messaging panel">
      <div className="sr-only" aria-live="polite">{liveStatus}</div>
      <div className="ssa-hero-wrap p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="ssa-hero-title text-lg">Direct Messaging</h2>
            <p className="ssa-hero-subtitle">
              {seasonLabel} collaboration across meals, storehouse, gardens, and husbandry.
            </p>
          </div>
          <SSABadge tone="assigned">{conversations.reduce((sum, item) => sum + item.unread, 0)} unread</SSABadge>
        </div>

        <div className="mt-3 grid gap-3 xl:grid-cols-[290px_minmax(0,1fr)]">
          <div className="space-y-2" aria-label="Conversation list">
            {conversations.map((conversation) => {
              const isActive = conversation.id === activeConversation.id;
              return (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => {
                    setActiveConversationId(conversation.id);
                    markConversationRead(conversation.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      const currentIndex = conversations.findIndex((item) => item.id === conversation.id);
                      const nextConversation = conversations[(currentIndex + 1) % conversations.length];
                      if (nextConversation) {
                        setActiveConversationId(nextConversation.id);
                        markConversationRead(nextConversation.id);
                      }
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      const currentIndex = conversations.findIndex((item) => item.id === conversation.id);
                      const prevConversation = conversations[(currentIndex - 1 + conversations.length) % conversations.length];
                      if (prevConversation) {
                        setActiveConversationId(prevConversation.id);
                        markConversationRead(prevConversation.id);
                      }
                    }
                  }}
                  className={`w-full rounded-[var(--ssa-radius-card)] border p-3 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ssa-focus-ring-color)] ${
                    isActive
                      ? "border-[var(--ssa-action-primary-bg)] bg-[var(--ssa-surface-1)]"
                      : "border-[var(--ssa-border-subtle)] bg-[var(--ssa-surface-elevated)] hover:bg-[var(--ssa-surface-1)] active:translate-y-[1px]"
                  }`}
                  aria-label={"Open conversation: " + conversation.household}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <SSAAnimalAvatar animal={conversation.animal} size="sm" label={conversation.household} />
                      <span className="text-sm font-semibold text-[var(--ssa-text-primary)]">
                        {conversation.household}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {conversation.unread > 0 ? <SSABadge tone="request">{conversation.unread}</SSABadge> : null}
                      <SSABadge tone={conversation.status}>{conversation.status}</SSABadge>
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-[var(--ssa-text-secondary)]">{conversation.lastMessage}</p>
                  <p className="mt-1 text-[11px] text-[var(--ssa-text-secondary)]">{conversation.lastAt}</p>
                  <div className="mt-2">
                    <SSAHouseholdParticipation
                      label="Module Participation"
                      entries={conversation.moduleParticipation}
                    />
                  </div>
                </button>
              );
            })}
          </div>

          <div className="rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-default)] bg-[var(--ssa-surface-elevated)] p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <SSAAnimalAvatar animal={activeConversation.animal} size="sm" label={activeConversation.household} />
                <h3 className="ssa-hero-title text-base">{activeConversation.household} Thread</h3>
              </div>
              <SSABadge>{activeConversation.lastAt}</SSABadge>
            </div>

            <div className="mb-3 grid gap-2 sm:grid-cols-2" aria-label="Module seasonal highlights">
              {DM_MODULES.map((module) => (
                <SSACard
                  key={`dm-module-${module.key}`}
                  title={module.label}
                  subtitle="Seasonal context"
                  variant="task"
                >
                  <div className="space-y-2">
                    <p className="text-xs">{module.seasonalHighlight}</p>
                    <SSABadge>{module.key}</SSABadge>
                  </div>
                </SSACard>
              ))}
            </div>

            <div
              className="max-h-[360px] space-y-2 overflow-y-auto rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-subtle)] p-2"
              aria-label="Chat thread"
            >
              <AnimatePresence initial={false}>
                {activeConversation.thread.map((message) => {
                  const moduleMeta = moduleMap[message.moduleKey] || null;
                  const isMine = message.from === "me";
                  return (
                    <motion.div
                      key={message.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.18 }}
                      className={`flex ${isMine ? "justify-end" : "justify-start"}`}
                    >
                      <div className={`max-w-[92%] sm:max-w-[80%] ${isMine ? "" : ""}`}>
                        <SSACard
                          title={isMine ? "You" : activeConversation.household}
                          subtitle={moduleMeta?.label || "Module update"}
                          variant={isMine ? "task" : "feed"}
                          actions={<SSABadge>{message.at}</SSABadge>}
                        >
                          <div className="space-y-2">
                            <p>{message.body}</p>
                            <div className="flex flex-wrap gap-2">
                              <SSABadge>{message.seasonalCue}</SSABadge>
                              {message.actionType ? <SSABadge>{message.actionType}</SSABadge> : null}
                            </div>
                          </div>
                        </SSACard>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
              {isTyping ? (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="inline-flex items-center gap-2 rounded-[var(--ssa-radius-chip)] border border-[var(--ssa-border-subtle)] bg-[var(--ssa-surface-1)] px-2 py-1 text-xs text-[var(--ssa-text-secondary)]"
                  role="status"
                  aria-label="Typing indicator"
                >
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ssa-text-secondary)]" aria-hidden="true" />
                  <span>{activeConversation.household} is typing...</span>
                </motion.div>
              ) : null}
              <div ref={threadEndRef} />
            </div>

            <div className="mt-3 space-y-2" aria-label="Message composer">
              <div className="grid gap-2 sm:grid-cols-3">
                <SSASelect
                  value={selectedModule}
                  onChange={(event) => setSelectedModule(event.target.value)}
                >
                  {DM_MODULES.map((module) => (
                    <option key={module.key} value={module.key}>
                      {module.label}
                    </option>
                  ))}
                </SSASelect>
                <SSASelect
                  value={composerAction}
                  onChange={(event) => setComposerAction(event.target.value)}
                >
                  <option value="send">Send message</option>
                  <option value="attach">Attach context</option>
                  <option value="assign">Assign task</option>
                  <option value="log">Log module activity</option>
                </SSASelect>
                <div className="flex items-center gap-2">
                  <SSAButton variant="secondary" onClick={() => setComposerText((prev) => `${prev} [Attachment]`.trim())}>
                    Attach
                  </SSAButton>
                  <SSAButton variant="primary" onClick={sendMessage}>
                    Send
                  </SSAButton>
                </div>
              </div>
              <SSAInput
                value={composerText}
                onChange={(event) => setComposerText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder="Message, assign, or log module activity..."
                aria-label="Message input"
              />
              {composerError ? (
                <SSAInlineAlert tone="danger">{composerError}</SSAInlineAlert>
              ) : null}
              {failedMessages.length ? (
                <div className="rounded-[var(--ssa-radius-card)] border border-[var(--ssa-status-warning)] p-2">
                  <p className="text-xs font-semibold text-[var(--ssa-status-warning)]">Failed sends</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {failedMessages.map((failedMessage) => (
                      <SSAButton
                        key={failedMessage.id}
                        variant="secondary"
                        onClick={() => retryFailedMessage(failedMessage)}
                      >
                        Retry: {failedMessage.body.slice(0, 18)}
                      </SSAButton>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <SSABadge>{moduleMap[selectedModule]?.seasonalHighlight}</SSABadge>
                <SSABadge tone="assigned">Collaborative prompt: confirm shared handoff window</SSABadge>
              </div>
            </div>
          </div>
        </div>
      </div>

      <SSAToastHost initial={deliveryToastItems} />
    </section>
  );
}

function SettingsPane({
  settingsDraft,
  setSettingsDraft,
  onSave,
  onReset,
  isDirty,
  saveState,
}) {
  const saveStateMessage =
    saveState === "saved"
      ? "Saved to household profile service."
      : saveState === "saving"
      ? "Saving settings..."
      : saveState === "error"
      ? "Save failed. Try again."
      : "Ready to save.";

  return (
    <section className="ssa-hero-wrap p-4" aria-label="Settings tab">
      <h2 className="ssa-hero-title text-lg">Profile Settings</h2>
      <p className="ssa-hero-subtitle">Update bio, collaboration preferences, and seasonal notification defaults.</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <SSAField label="Display Name" hint="Visible to linked households">
          <SSAInput
            value={settingsDraft.displayName}
            onChange={(event) =>
              setSettingsDraft((prev) => ({
                ...prev,
                displayName: event.target.value,
              }))
            }
          />
        </SSAField>
        <SSAField label="Primary Role" hint="Used in collaboration chips">
          <SSASelect
            value={settingsDraft.primaryRole}
            onChange={(event) =>
              setSettingsDraft((prev) => ({
                ...prev,
                primaryRole: event.target.value,
              }))
            }
          >
            <option value="coordinator">Household Coordinator</option>
            <option value="planner">Planner Lead</option>
            <option value="specialist">Seasonal Specialist</option>
          </SSASelect>
        </SSAField>
        <SSAField label="Bio" hint="Context for collaboration requests">
          <SSATextarea
            value={settingsDraft.bio}
            onChange={(event) =>
              setSettingsDraft((prev) => ({
                ...prev,
                bio: event.target.value,
              }))
            }
            rows={4}
          />
        </SSAField>
        <div className="space-y-3 rounded-[var(--ssa-radius-card)] border border-[var(--ssa-border-subtle)] p-3">
          <SSAToggle
            checked={settingsDraft.receiveSeasonalAlerts}
            onChange={(next) =>
              setSettingsDraft((prev) => ({
                ...prev,
                receiveSeasonalAlerts: !!next,
              }))
            }
            label="Receive seasonal alerts"
          />
          <SSAToggle
            checked={settingsDraft.allowTaskInvitations}
            onChange={(next) =>
              setSettingsDraft((prev) => ({
                ...prev,
                allowTaskInvitations: !!next,
              }))
            }
            label="Allow task invitations"
          />
          <SSAToggle
            checked={settingsDraft.autoSharePlaybooks}
            onChange={(next) =>
              setSettingsDraft((prev) => ({
                ...prev,
                autoSharePlaybooks: !!next,
              }))
            }
            label="Auto-share saved playbooks"
          />
        </div>
      </div>
      <p className="mt-3 text-sm text-[var(--ssa-text-secondary)]">{saveStateMessage}</p>
      <div className="mt-4 ssa-hero-actions">
        <SSAButton variant="primary" onClick={onSave} disabled={!isDirty || saveState === "saving"}>
          Save Settings
        </SSAButton>
        <SSAButton variant="secondary" onClick={onReset} disabled={!isDirty || saveState === "saving"}>
          Reset
        </SSAButton>
      </div>
    </section>
  );
}
