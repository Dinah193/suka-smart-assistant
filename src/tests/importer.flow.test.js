// __tests__/importer.flow.test.js
// importer.flow.test.js — URL → preview → confirm → normalize
// ----------------------------------------------------------------------------
// This test verifies the full importer flow for recipes collected from URLs:
// 1) User submits one or more URLs
// 2) System fetches & parses → emits previews with source attribution
// 3) User confirms selections
// 4) System normalizes (units/servings), de-dupes/versions, tags, and saves
//
// The flow aligns with project updates mentioned in chats:
// - Pinterest/Allrecipes attribution (SourceAttributionCard)
// - Bulk URL collection (BulkUrlGrid)
// - CollectionsPicker (board/collection destination)
// - Version-aware de-dupe (recipeDeduper.withVersionPicker)
// - Units/servings standardization (recipeNormalizer.normalizeAll)
// - Tagging inference (taggingAutoClassifier.infer)
// - EventBus-driven (nba.suggest, library.item.saved)
//
// These tests are defensive and rely on DI-friendly mocks so they run
// without real network, stores, or engines.
//
// Paste this file as: `src/engines/importer/__tests__/importer.flow.test.js`
// or adjust your Jest rootDir/glob as needed.

import { jest } from '@jest/globals';

// ----------------------- Subject Under Test (SUT) ----------------------------
// We expect an importer orchestrator with a single entrypoint:
//   runImporterFlow({ urls, collectionId }, deps)
// returning { previews, saved, errors } and emitting events.
//
// If your actual path differs, update the import below.
import { runImporterFlow } from '../importerFlow';

// ------------------------------ Test Mocks ----------------------------------

function createMockBus() {
  const subs = new Map();
  return {
    publish: jest.fn((topic, message) => {
      (subs.get(topic) || []).forEach((cb) => cb(message));
    }),
    subscribe(topic, cb) {
      const arr = subs.get(topic) || [];
      arr.push(cb);
      subs.set(topic, arr);
    },
    _subs: subs,
  };
}

function uuidMock() {
  let i = 0;
  return () => `uuid-${++i}`;
}

const TIMEZONE = 'America/New_York';
const nowISO = () => new Date('2025-10-20T12:00:00.000Z').toISOString();

// Simulated network fetcher/parser for supported sites
const fetcherMock = {
  // Very small HTML/JSON-ish stubs → parsed recipe objects
  async fetchAndParse(url) {
    if (/allrecipes\.com/.test(url)) {
      return {
        canonicalUrl: 'https://www.allrecipes.com/recipe/12345/easy-chicken-curry/',
        source: { host: 'allrecipes.com', title: 'Allrecipes', favicon: '🅰️' },
        title: 'Easy Chicken Curry',
        image: 'https://images.ar/easy-chicken-curry.jpg',
        yield: '4 servings',
        ingredients: [
          { name: 'chicken thighs', qty: 1, unit: 'lb' },
          { name: 'onion', qty: 1, unit: '' },
          { name: 'garam masala', qty: 2, unit: 'tsp' },
          { name: 'coconut milk', qty: 1, unit: 'can' },
        ],
        steps: ['Chop onion', 'Brown chicken', 'Simmer with spices', 'Add coconut milk'],
        meta: { totalTime: 40 },
      };
    }
    if (/pinterest\.com/.test(url)) {
      // Pinterest often embeds a link to the real recipe; we simulate resolved data
      return {
        canonicalUrl: 'https://myblog.example.com/recipes/oat-waffles',
        source: { host: 'pinterest.com', title: 'Pinterest Pin', favicon: '📌' },
        title: 'Crispy Oat Waffles (Pin)',
        image: 'https://img.pin/waffles.jpg',
        yield: '6 waffles',
        ingredients: [
          { name: 'oats', qty: 2, unit: 'cup' },
          { name: 'egg', qty: 2, unit: '' },
          { name: 'milk', qty: 1.5, unit: 'cup' },
        ],
        steps: ['Blend oats', 'Mix wet', 'Cook on waffle iron'],
        meta: { totalTime: 25 },
      };
    }
    if (/duplicate\.example/.test(url)) {
      // Same canonical recipe, slightly different title/version
      return {
        canonicalUrl: 'https://www.allrecipes.com/recipe/12345/easy-chicken-curry/',
        source: { host: 'duplicate.example', title: 'Food Mirror', favicon: '🔁' },
        title: 'Chicken Curry (Stovetop Version)',
        image: 'https://mirror/img.jpg',
        yield: '4 servings',
        ingredients: [
          { name: 'chicken thighs', qty: 0.9, unit: 'lb' },
          { name: 'onion', qty: 1, unit: '' },
          { name: 'garam masala', qty: 2, unit: 'tsp' },
          { name: 'coconut milk', qty: 1, unit: 'can' },
        ],
        steps: ['Chop onion', 'Brown chicken', 'Spice simmer', 'Add coconut milk'],
        meta: { totalTime: 38, version: 'stovetop' },
      };
    }
    if (/fail\.example/.test(url)) {
      throw new Error('Network/parse failed');
    }
    // Generic fallback
    return {
      canonicalUrl: url,
      source: { host: new URL(url).host, title: 'Web', favicon: '🌐' },
      title: 'Untitled Recipe',
      image: null,
      yield: '2 servings',
      ingredients: [{ name: 'water', qty: 1, unit: 'cup' }],
      steps: ['Boil water'],
      meta: {},
    };
  },
};

// Units/servings normalizer
const recipeNormalizerMock = {
  async normalizeAll(items) {
    return items.map((r) => ({
      ...r,
      // Normalize 1 lb → 16 oz (simple example)
      ingredients: (r.ingredients || []).map((ing) => {
        if (String(ing.unit).toLowerCase() === 'lb') {
          return { ...ing, qty: (ing.qty || 0) * 16, unit: 'oz' };
        }
        if (/can/i.test(ing.unit || '')) {
          // very naive can→oz assumption (13.5 oz coconut milk as typical)
          return { ...ing, qty: 13.5, unit: 'oz' };
        }
        return ing;
      }),
      // Normalize yield to servings integer when possible
      servings: parseServings(r.yield),
    }));
  },
};

function parseServings(y) {
  const m = String(y || '').match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}

// Tagging inference
const taggingAutoClassifierMock = {
  infer(recipe) {
    const tags = [];
    const name = (recipe.title || '').toLowerCase();
    if (/(curry|garam masala)/.test(JSON.stringify(recipe).toLowerCase())) tags.push('indian');
    if (/waffle/.test(name)) tags.push('breakfast');
    if (/chicken/.test(JSON.stringify(recipe).toLowerCase())) tags.push('protein:chicken');
    return { tags };
  },
};

// Version-aware de-duper
const recipeDeduperMock = {
  withVersionPicker(list) {
    // Merge by canonicalUrl; keep the first as primary and store alternates in .versions
    const map = new Map();
    for (const r of list) {
      const key = r.canonicalUrl || r.url;
      if (!map.has(key)) {
        map.set(key, { ...r, versions: [] });
      } else {
        const primary = map.get(key);
        primary.versions.push(r);
      }
    }
    return {
      list: Array.from(map.values()),
      pickVersion(key, chooseIdx = 0) {
        const primary = map.get(key);
        if (!primary) return null;
        if (!primary.versions.length) return primary;
        if (chooseIdx === -1) return primary; // keep original
        return { ...(primary.versions[chooseIdx] || primary) };
      },
    };
  },
};

// Library/recipes store (save previews & final items)
function createRecipesStoreMock() {
  const saved = [];
  return {
    async save(item) {
      saved.push(item);
      return item;
    },
    get _saved() {
      return saved;
    },
  };
}

// User/profile store
const userStoreMock = {
  getTimezone: () => TIMEZONE,
  getSettings: () => ({ sabbathGuard: true }),
  getProfile: () => ({ id: 'user-1', name: 'Rhonda' }),
};

// Collections/boards store
function createCollectionsStoreMock() {
  const savedTo = [];
  return {
    async addToCollection(collectionId, itemId) {
      savedTo.push({ collectionId, itemId });
    },
    get _links() {
      return savedTo;
    },
  };
}

// ------------------------------ Test Suite ----------------------------------

describe('Importer Flow — URL → preview → confirm → normalize', () => {
  let bus;
  let uuid;
  let recipesStore;
  let collectionsStore;
  const deps = () => ({
    bus,
    engines: {
      fetcher: fetcherMock,
      recipeNormalizer: recipeNormalizerMock,
      taggingAutoClassifier: taggingAutoClassifierMock,
      recipeDeduper: recipeDeduperMock,
    },
    stores: {
      recipesStore,
      collectionsStore,
      userStore: userStoreMock,
    },
    helpers: {
      uuid,
      time: {
        nowISO,
      },
    },
    log: () => {},
  });

  beforeEach(() => {
    bus = createMockBus();
    uuid = uuidMock();
    recipesStore = createRecipesStoreMock();
    collectionsStore = createCollectionsStoreMock();
    jest.clearAllMocks();
  });

  test('happy path: Allrecipes URL → preview emitted → confirm → normalized & saved', async () => {
    // Listen for preview event to simulate UI "preview step"
    const previewsSeen = [];
    bus.subscribe('collector.preview.ready', ({ previews, meta }) => {
      previewsSeen.push({ previews, meta });
    });

    const result = await runImporterFlow(
      {
        urls: ['https://www.allrecipes.com/recipe/12345/easy-chicken-curry/'],
        collectionId: 'col:weeknight-dinners',
        confirm: true, // simulate user confirms all previews
      },
      deps()
    );

    // Step 1: preview should be emitted with source attribution
    expect(previewsSeen.length).toBe(1);
    const preview = previewsSeen[0].previews[0];
    expect(preview.title).toMatch(/Chicken Curry/i);
    expect(preview.source.host).toBe('allrecipes.com');
    expect(preview.image).toBeTruthy();
    expect(preview.ingredients.length).toBeGreaterThan(0);

    // Step 2: after confirm, normalized & tagged item saved
    expect(result.saved.length).toBe(1);
    const saved = result.saved[0];
    // Normalization: 1 lb chicken -> 16 oz
    const chicken = saved.ingredients.find((i) => i.name.includes('chicken'));
    expect(chicken.unit).toBe('oz');
    expect(chicken.qty).toBeCloseTo(16);
    // Tagging: indian + protein
    expect(new Set(saved.tags)).toEqual(new Set(['indian', 'protein:chicken']));

    // Store link to collection should have been created
    expect(collectionsStore._links).toEqual([{ collectionId: 'col:weeknight-dinners', itemId: saved.id }]);

    // Event for saved item
    expect(bus.publish).toHaveBeenCalledWith(
      'library.item.saved',
      expect.objectContaining({ item: expect.objectContaining({ title: expect.any(String) }) })
    );
  });

  test('multiple URLs with duplicate canonical → version picker honored', async () => {
    const result = await runImporterFlow(
      {
        urls: [
          'https://www.allrecipes.com/recipe/12345/easy-chicken-curry/',
          'https://duplicate.example/food/easy-chicken-curry-stovetop',
        ],
        collectionId: 'col:curry',
        // choose second version (index 0 is original, 1st alt is index 0 in versions array)
        pickVersion: {
          // key is canonicalUrl
          'https://www.allrecipes.com/recipe/12345/easy-chicken-curry/': 0, // choose the first alternate
        },
        confirm: true,
      },
      deps()
    );

    // Only one saved due to de-dupe
    expect(result.saved.length).toBe(1);
    const saved = result.saved[0];
    // We chose the alternate which had totalTime 38 and slightly different title
    expect(saved.title).toMatch(/Stovetop/i);
    // Normalization still applied
    const chicken = saved.ingredients.find((i) => i.name.includes('chicken'));
    expect(chicken.unit).toBe('oz');
    expect(chicken.qty).toBeGreaterThan(14);
  });

  test('Pinterest attribution respected; preview then confirm', async () => {
    const res = await runImporterFlow(
      {
        urls: ['https://www.pinterest.com/pin/12345/'],
        collectionId: 'col:breakfast',
        confirm: true,
      },
      deps()
    );

    expect(res.previews[0].source.host).toBe('pinterest.com');
    expect(res.saved[0].title).toMatch(/Waffles/i);
    // Tag inference
    expect(new Set(res.saved[0].tags)).toEqual(new Set(['breakfast']));
  });

  test('one failing URL does not block others; errors collected', async () => {
    const res = await runImporterFlow(
      {
        urls: [
          'https://fail.example/recipe/boom',
          'https://www.allrecipes.com/recipe/12345/easy-chicken-curry/',
        ],
        collectionId: 'col:mixed',
        confirm: true,
      },
      deps()
    );

    expect(res.errors.length).toBe(1);
    expect(res.previews.length).toBe(1);
    expect(res.saved.length).toBe(1);
  });
});

// --------------------------- Minimal SUT shim --------------------------------
// If your project already has `importerFlow.js` with `runImporterFlow`,
// remove the shim below. It exists so this test file remains paste-and-run
// friendly. The shim uses the DI mocks above to simulate the flow.

export async function runImporterFlow(payload, deps) {
  const {
    urls = [],
    collectionId,
    confirm = false,
    pickVersion = {}, // { [canonicalUrl]: chosenAltIndex }
  } = payload;

  const { bus, engines, stores, helpers, log } = deps;
  const {
    fetcher,
    recipeNormalizer,
    taggingAutoClassifier,
    recipeDeduper,
  } = engines;
  const { recipesStore, collectionsStore, userStore } = stores;
  const uuid = helpers?.uuid || (() => Math.random().toString(36).slice(2));

  const previews = [];
  const errors = [];

  // 1) Fetch & parse
  for (const url of urls) {
    try {
      const parsed = await fetcher.fetchAndParse(url);
      const preview = {
        id: uuid(),
        ...parsed,
        collectedAt: helpers?.time?.nowISO?.() || new Date().toISOString(),
        sourceAttribution: {
          host: parsed.source?.host,
          title: parsed.source?.title,
          favicon: parsed.source?.favicon,
        },
        // minimal card fields for SourceAttributionCard
        card: {
          title: parsed.title,
          image: parsed.image,
          sourceTitle: parsed.source?.title,
        },
      };
      previews.push(preview);
    } catch (e) {
      errors.push({ url, error: String(e.message || e) });
      log?.('fetch.parse.error', url, e);
    }
  }

  // 2) Emit preview for UI step
  bus?.publish?.('collector.preview.ready', {
    previews,
    meta: {
      tz: userStore?.getTimezone?.() || 'America/New_York',
      collectionId,
      count: previews.length,
    },
  });

  // If not confirmed yet, return previews only
  if (!confirm) {
    return { previews, saved: [], errors };
  }

  // 3) De-dupe with version picker
  let dedup = recipeDeduper?.withVersionPicker?.(previews) || { list: previews, pickVersion: () => null };

  const picked = dedup.list.map((item) => {
    const key = item.canonicalUrl || item.url;
    const idx = pickVersion[key];
    if (typeof idx === 'number') {
      const chosen = dedup.pickVersion(key, idx);
      return chosen || item;
    }
    return item;
  });

  // 4) Normalize units/servings
  const normalized = recipeNormalizer?.normalizeAll
    ? await recipeNormalizer.normalizeAll(picked)
    : picked;

  // 5) Tagging inference
  const tagged = normalized.map((r) => {
    const inferred = taggingAutoClassifier?.infer?.(r) || { tags: [] };
    return { ...r, tags: Array.from(new Set([...(r.tags || []), ...(inferred.tags || [])])) };
  });

  // 6) Save to library + link to collection
  const saved = [];
  for (const item of tagged) {
    const libItem = await recipesStore.save({
      id: uuid(),
      ...item,
      savedAt: helpers?.time?.nowISO?.() || new Date().toISOString(),
      ownerId: userStore?.getProfile?.().id || 'user',
    });
    saved.push(libItem);
    if (collectionId) {
      await collectionsStore.addToCollection(collectionId, libItem.id);
    }
    // emit per-item save
    bus?.publish?.('library.item.saved', { item: libItem, collectionId });
  }

  // 7) NBA suggestion to continue flow
  bus?.publish?.('nba.suggest', {
    scope: 'collector',
    actions: [
      {
        id: 'send-to-menu',
        label: 'Add to Meal Plan',
        cta: 'Open Meal Planner',
        route: '/MealPlanning',
      },
      {
        id: 'tag-new-items',
        label: 'Refine tags & courses',
        cta: 'Open Tagging',
        route: '/MealPlanning/Tagging',
      },
    ],
  });

  return { previews, saved, errors };
}
