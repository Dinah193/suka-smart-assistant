const PRODUCT_TELEMETRY_KEY = "suka.productActionTelemetry.v1";
const MAX_EVENTS = 600;

function asNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function normalizeMode(mode) {
  const raw = String(mode || "").trim().toLowerCase();
  if (raw === "expert") return "expert";
  return "novice";
}

function readJson(key, fallback = null) {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function resolveLearningMode(explicitMode) {
  if (explicitMode) return normalizeMode(explicitMode);

  const uiMode = readJson("ssa.ui.learningMode", null);
  if (typeof uiMode === "string") return normalizeMode(uiMode);

  const draft = readJson("ssa.householdAutomationPanel.draft", null);
  const skillLevel = String(draft?.skillLevel || "").toLowerCase();
  if (skillLevel === "expert") return "expert";

  return "novice";
}

function readStore() {
  return readJson(PRODUCT_TELEMETRY_KEY, { events: [], updatedAt: null }) || {
    events: [],
    updatedAt: null,
  };
}

function writeStore(next) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(PRODUCT_TELEMETRY_KEY, JSON.stringify(next));
  } catch {
    // Ignore local storage failures.
  }
}

function pushRecord(record) {
  const store = readStore();
  const events = [...store.events, record].slice(-MAX_EVENTS);
  writeStore({ events, updatedAt: new Date().toISOString() });
}

function baseRecord({ eventName, page, mode, payload = {} }) {
  return {
    eventName,
    page: String(page || "unknown"),
    mode: resolveLearningMode(mode),
    timestamp: asNumber(payload.timestamp, Date.now()),
    source: String(payload.source || "ui.product-actions"),
    action: payload.action ? String(payload.action) : null,
    status: payload.status ? String(payload.status) : "click",
    quickActionCount: Math.max(0, asNumber(payload.quickActionCount, 0)),
    meta: payload.meta && typeof payload.meta === "object" ? payload.meta : null,
  };
}

export function recordProductActionImpression({ page, quickActionCount = 0, mode, meta }) {
  pushRecord(
    baseRecord({
      eventName: "product_action_impression",
      page,
      mode,
      payload: {
        quickActionCount,
        meta,
      },
    })
  );
}

export function recordProductActionClick({ page, action, mode, status = "click", meta }) {
  pushRecord(
    baseRecord({
      eventName: "product_action_clicked",
      page,
      mode,
      payload: {
        action,
        status,
        meta,
      },
    })
  );
}

export function getProductActionTelemetrySummary() {
  const store = readStore();
  const summary = {
    totals: { impressions: 0, clicks: 0 },
    byPage: {},
    byMode: {
      novice: { impressions: 0, clicks: 0 },
      expert: { impressions: 0, clicks: 0 },
    },
    updatedAt: store.updatedAt || null,
  };

  const ensurePage = (page) => {
    if (!summary.byPage[page]) {
      summary.byPage[page] = { impressions: 0, clicks: 0 };
    }
  };

  for (const event of store.events) {
    const page = String(event.page || "unknown");
    const mode = normalizeMode(event.mode);
    ensurePage(page);

    if (event.eventName === "product_action_impression") {
      const impressions = Math.max(1, asNumber(event.quickActionCount, 1));
      summary.totals.impressions += impressions;
      summary.byPage[page].impressions += impressions;
      summary.byMode[mode].impressions += impressions;
      continue;
    }

    if (event.eventName === "product_action_clicked") {
      summary.totals.clicks += 1;
      summary.byPage[page].clicks += 1;
      summary.byMode[mode].clicks += 1;
    }
  }

  const rate = (clicks, impressions) =>
    impressions > 0 ? Math.round((clicks / impressions) * 10000) / 100 : 0;

  return {
    ...summary,
    ctr: {
      total: rate(summary.totals.clicks, summary.totals.impressions),
      byMode: {
        novice: rate(summary.byMode.novice.clicks, summary.byMode.novice.impressions),
        expert: rate(summary.byMode.expert.clicks, summary.byMode.expert.impressions),
      },
      byPage: Object.fromEntries(
        Object.entries(summary.byPage).map(([page, bucket]) => [
          page,
          rate(bucket.clicks, bucket.impressions),
        ])
      ),
    },
  };
}

export function clearProductActionTelemetry() {
  writeStore({ events: [], updatedAt: new Date().toISOString() });
}

export { PRODUCT_TELEMETRY_KEY };
