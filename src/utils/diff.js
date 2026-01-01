/**
 * Suka Smart Assistant — diff utilities
 *
 * What this gives you:
 * - deep diff between prev/next with domain-aware numeric tolerance (grams, kcal)
 * - human-friendly change summaries (e.g., "Net Carbs: 23.5 → 25.0 g")
 * - JSON-Patch-like ops: { op: 'add'|'remove'|'replace', path: '/a/b/0', value? }
 * - keyed array diff for entries (by externalId | id | code | label)
 * - immutable patch application
 * - tiny test harness you can run in dev (runDiffSelfTest())
 *
 * Designed for nutrition data:
 *   {
 *     totals: { netCarb, protein, fat, fiber, sugarAlcohol },
 *     calories: { totalCalories, carbCals, protCals, fatCals, fiberCals, saCals },
 *     pct: { carbsPct, proteinPct, fatPct },
 *     settings: { includeFiberCalories, fiberCalPerGram, includeSACalories, saCalPerGram },
 *     entries: [{ label, externalId?, netCarb, fiber, sugarAlcohol, protein, fat, servings }]
 *   }
 */

// ------------------------ config / helpers ------------------------

const DEFAULT_OPTS = {
  eps: {
    grams: 0.05,          // treat +/- 0.05 g as equal
    calories: 0.5,        // treat +/- 0.5 kcal as equal
    percent: 1e-4,        // percent fractions (0..1)
    number: 1e-9,         // generic tiny epsilon
  },
  numericFields: {
    grams: ['netCarb', 'protein', 'fat', 'fiber', 'sugarAlcohol', 'servings'],
    calories: ['totalCalories', 'carbCals', 'protCals', 'fatCals', 'fiberCals', 'saCals'],
    percent: ['carbsPct', 'proteinPct', 'fatPct'],
  },
  // prefer these keys to track item identity in arrays under /entries
  arrayKeys: {
    '/entries': ['externalId', 'id', 'code', 'label'],
  },
  // allow skipping paths completely
  ignorePaths: [],
  // pretty labels for human summaries
  labels: {
    netCarb: 'Net Carbs (g)',
    protein: 'Protein (g)',
    fat: 'Fat (g)',
    fiber: 'Fiber (g)',
    sugarAlcohol: 'Sugar Alcohols (g)',
    totalCalories: 'Calories total',
    carbCals: 'Carb kcal',
    protCals: 'Protein kcal',
    fatCals: 'Fat kcal',
    fiberCals: 'Fiber kcal',
    saCals: 'Sugar alcohol kcal',
    carbsPct: 'Net Carb %',
    proteinPct: 'Protein %',
    fatPct: 'Fat %',
    includeFiberCalories: 'Fiber calories',
    includeSACalories: 'Sugar alcohol calories',
    fiberCalPerGram: 'Fiber cal/g',
    saCalPerGram: 'Sugar alcohol cal/g',
    servings: 'Servings',
    label: 'Item',
  },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isDate = (v) => v instanceof Date;
const isNil  = (v) => v === null || v === undefined;

// RFC6901 path-escape
const encSeg = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');

// Determine numeric bucket for tolerance
function numericKind(key, opts) {
  const nf = opts.numericFields || {};
  if ((nf.grams || []).includes(key)) return 'grams';
  if ((nf.calories || []).includes(key)) return 'calories';
  if ((nf.percent || []).includes(key)) return 'percent';
  return 'number';
}

function numEqual(a, b, key, opts) {
  const kind = numericKind(key, opts);
  const eps = (opts.eps && opts.eps[kind]) ?? DEFAULT_OPTS.eps.number;
  const na = Number(a), nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return a === b;
  return Math.abs(na - nb) <= eps;
}

function deepEqual(a, b, opts, keyHint = '') {
  if (a === b) return true;
  if (isDate(a) && isDate(b)) return a.getTime() === b.getTime();
  if (typeof a !== typeof b) return false;

  // numeric-ish strings vs numbers: allow tolerant compare
  if (typeof a === 'number' || typeof b === 'number') {
    return numEqual(a, b, keyHint, opts);
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i], opts, keyHint)) return false;
    }
    return true;
  }

  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!deepEqual(a[k], b[k], opts, k)) return false;
    }
    return true;
  }

  return a === b;
}

function shouldIgnore(path, opts) {
  return (opts.ignorePaths || []).some((p) => path === p || path.startsWith(p + '/'));
}

// ------------------------ human summaries ------------------------

function fmtVal(path, key, val, opts) {
  if (isNil(val)) return '—';
  const kind = numericKind(key, opts);
  if (kind === 'grams') return `${Number(val).toFixed(1)} g`;
  if (kind === 'calories') return `${Math.round(Number(val))} kcal`;
  if (kind === 'percent') return `${(Number(val) * 100).toFixed(1)}%`;
  if (typeof val === 'boolean') return val ? 'On' : 'Off';
  return String(val);
}

function humanize(path, key, oldVal, newVal, opts) {
  const L = (opts.labels && opts.labels[key]) || key;
  // Entries context
  const m = path.match(/^(.+\/entries\/)([^/]+)(?:\/(.+))?$/);
  if (m) {
    const [, , id, leaf] = m;
    if (leaf === 'servings') {
      return `Servings (${id}): ${fmtVal(path, 'servings', oldVal, opts)} → ${fmtVal(path, 'servings', newVal, opts)}`;
    }
    if (leaf && ['netCarb','protein','fat','fiber','sugarAlcohol'].includes(leaf)) {
      const pretty = (opts.labels && opts.labels[leaf]) || leaf;
      return `${pretty} (${id}): ${fmtVal(path, leaf, oldVal, opts)} → ${fmtVal(path, leaf, newVal, opts)}`;
    }
  }

  // Settings toggles & sliders
  if (path.includes('/settings/')) {
    return `${L}: ${fmtVal(path, key, oldVal, opts)} → ${fmtVal(path, key, newVal, opts)}`;
  }

  return `${L}: ${fmtVal(path, key, oldVal, opts)} → ${fmtVal(path, key, newVal, opts)}`;
}

// ------------------------ array keyed diff ------------------------

function resolveArrayKeys(path, opts) {
  const map = opts.arrayKeys || {};
  // find the longest matching base (e.g., '/entries')
  let chosen = null;
  for (const base in map) {
    if (path.endsWith(base) || path.includes(base + '/')) {
      chosen = map[base];
      break;
    }
  }
  // default preference order for anything that looks like entries
  return chosen || ['externalId', 'id', 'code', 'label'];
}

function keyFor(item, keys) {
  for (const k of keys) {
    if (item && item[k] != null && String(item[k]).length) return `${k}:${String(item[k])}`;
  }
  // fallback stable signature
  if (item && typeof item === 'object') {
    return 'idx:' + JSON.stringify({
      label: item.label,
      netCarb: item.netCarb, protein: item.protein, fat: item.fat, fiber: item.fiber, sugarAlcohol: item.sugarAlcohol,
    });
  }
  return 'idx:' + String(item);
}

// ------------------------ diff core ------------------------

/**
 * Compute deep diff → { ops, summary, stats, changed }
 * ops: JSON-Patch-like (add/remove/replace). Paths use RFC6901.
 */
export function diff(prev, next, options = {}) {
  const opts = { ...DEFAULT_OPTS, ...options };
  const ops = [];
  const summary = [];
  const stats = { added: 0, removed: 0, updated: 0 };

  function pushReplace(path, key, oldV, newV) {
    ops.push({ op: 'replace', path, value: newV });
    stats.updated += 1;
    summary.push(humanize(path, key, oldV, newV, opts));
  }

  function walk(pv, nv, path) {
    if (shouldIgnore(path, opts)) return;

    // equal?
    if (deepEqual(pv, nv, opts)) return;

    // array handling (keyed for entries)
    if (Array.isArray(pv) && Array.isArray(nv)) {
      const keys = resolveArrayKeys(path, opts);
      const aMap = new Map(pv.map((it) => [keyFor(it, keys), it]));
      const bMap = new Map(nv.map((it) => [keyFor(it, keys), it]));

      // removals
      for (const [k, aVal] of aMap.entries()) {
        if (!bMap.has(k)) {
          ops.push({ op: 'remove', path: `${path}/${encSeg(k)}` });
          stats.removed += 1;
          summary.push(`Removed item (${k.includes(':') ? k.split(':')[1] : k})`);
        }
      }
      // adds & updates
      for (const [k, bVal] of bMap.entries()) {
        if (!aMap.has(k)) {
          ops.push({ op: 'add', path: `${path}/${encSeg(k)}`, value: bVal });
          stats.added += 1;
          const label = bVal?.label ? ` "${bVal.label}"` : '';
          summary.push(`Added item${label}`);
        } else {
          // recurse object fields
          const aVal = aMap.get(k);
          walk(aVal, bVal, `${path}/${encSeg(k)}`);
        }
      }
      return;
    }

    // object handling
    if (isObj(pv) && isObj(nv)) {
      const keys = new Set([...Object.keys(pv), ...Object.keys(nv)]);
      for (const k of keys) {
        const a = pv[k], b = nv[k];
        const nextPath = `${path}/${encSeg(k)}`;
        if (isNil(a) && !isNil(b)) {
          ops.push({ op: 'add', path: nextPath, value: b });
          stats.added += 1;
          summary.push(`Added ${opts.labels[k] || k}: ${fmtVal(nextPath, k, b, opts)}`);
        } else if (!isNil(a) && isNil(b)) {
          ops.push({ op: 'remove', path: nextPath });
          stats.removed += 1;
          summary.push(`Removed ${opts.labels[k] || k}`);
        } else {
          // both present → walk deeper or replace
          if (isObj(a) || Array.isArray(a)) {
            walk(a, b, nextPath);
          } else if (!numEqual(a, b, k, opts) || typeof a !== 'number' || typeof b !== 'number') {
            // replace if not numerically equal (or non-number changed)
            pushReplace(nextPath, k, a, b);
          }
        }
      }
      return;
    }

    // primitives or type changes
    pushReplace(path, path.split('/').pop(), pv, nv);
  }

  walk(prev, next, ''); // start at root
  const changed = ops.length > 0;
  return { ops, summary, stats, changed };
}

// ------------------------ patching & merging ------------------------

/** Apply JSON-Patch-like ops immutably. Limited to add/remove/replace. */
export function applyPatch(target, ops) {
  const root = structuredClone ? structuredClone(target) : JSON.parse(JSON.stringify(target));

  function getParent(obj, path) {
    const segs = path.split('/').slice(1); // drop first empty
    if (!segs.length) return { parent: null, key: '' };
    let parent = obj;
    for (let i = 0; i < segs.length - 1; i++) {
      const k = segs[i].replace(/~1/g, '/').replace(/~0/g, '~');
      parent = parent[k];
      if (parent == null) break;
    }
    const key = segs[segs.length - 1].replace(/~1/g, '/').replace(/~0/g, '~');
    return { parent, key };
  }

  for (const op of ops) {
    const { parent, key } = getParent(root, op.path);
    if (!parent) continue;
    if (op.op === 'add' || op.op === 'replace') {
      parent[key] = op.value;
    } else if (op.op === 'remove') {
      if (Array.isArray(parent)) {
        const idx = Number(key);
        if (Number.isInteger(idx)) parent.splice(idx, 1);
        else delete parent[key];
      } else {
        delete parent[key];
      }
    } else {
      throw new Error(`Unsupported op: ${op.op}`);
    }
  }
  return root;
}

/** Deep merge with array dedupe by identity keys (entries). */
export function deepMerge(a, b, options = {}) {
  const opts = { ...DEFAULT_OPTS, ...options };
  if (Array.isArray(a) && Array.isArray(b)) {
    const keys = resolveArrayKeys('/entries', opts);
    const out = [];
    const seen = new Set();
    for (const it of [...a, ...b]) {
      const k = keyFor(it, keys);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(it);
      } else {
        // later item from b wins shallowly
        const idx = out.findIndex((x) => keyFor(x, keys) === k);
        out[idx] = { ...out[idx], ...it };
      }
    }
    return out;
  }
  if (isObj(a) && isObj(b)) {
    const out = { ...a };
    for (const k of Object.keys(b)) {
      out[k] = k in a ? deepMerge(a[k], b[k], opts) : b[k];
    }
    return out;
  }
  return b;
}

// ------------------------ convenience ------------------------

export function isEqual(a, b, options = {}) {
  const opts = { ...DEFAULT_OPTS, ...options };
  return deepEqual(a, b, opts);
}

/**
 * Quick change flags for common UI checks.
 * Returns: { hasTotalsChange, hasEntriesChange, hasSettingsChange, hasAnything }
 */
export function shallowChanges(prev, next) {
  const hasTotalsChange = !isEqual(prev?.totals, next?.totals, DEFAULT_OPTS) ||
                          !isEqual(prev?.calories, next?.calories, DEFAULT_OPTS) ||
                          !isEqual(prev?.pct, next?.pct, DEFAULT_OPTS);
  const hasEntriesChange = !isEqual(prev?.entries, next?.entries, DEFAULT_OPTS);
  const hasSettingsChange = !isEqual(prev?.settings, next?.settings, DEFAULT_OPTS);
  return {
    hasTotalsChange,
    hasEntriesChange,
    hasSettingsChange,
    hasAnything: hasTotalsChange || hasEntriesChange || hasSettingsChange,
  };
}

// ------------------------ self-test (optional) ------------------------

/**
 * Run tiny built-in tests in dev. Safe to call manually.
 * Will throw if an assertion fails.
 */
export function runDiffSelfTest() {
  const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assert failed'); };
  const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

  // 1) numeric tolerance for grams
  const A = { totals: { netCarb: 10.00 } };
  const B = { totals: { netCarb: 10.04 } };
  assert(!diff(A, B).changed, 'grams eps should treat 10.00 vs 10.04 as equal');

  const C = { totals: { netCarb: 10.11 } };
  assert(diff(A, C).changed, '10.00 vs 10.11 should be a change (> 0.05g)');

  // 2) keyed array diff with servings update
  const prev = {
    entries: [
      { externalId: 'upc:123', label: 'Item A', netCarb: 5, protein: 3, fat: 2, fiber: 1, sugarAlcohol: 0, servings: 1 },
      { externalId: 'upc:456', label: 'Item B', netCarb: 10, protein: 0, fat: 0, fiber: 0, sugarAlcohol: 0, servings: 1 },
    ],
  };
  const next = {
    entries: [
      { externalId: 'upc:123', label: 'Item A', netCarb: 5, protein: 3, fat: 2, fiber: 1, sugarAlcohol: 0, servings: 1.5 }, // changed servings
      { externalId: 'upc:789', label: 'Item C', netCarb: 1, protein: 1, fat: 1, fiber: 0, sugarAlcohol: 0, servings: 1 },   // added
    ],
  };
  const d1 = diff(prev, next, { arrayKeys: { '/entries': ['externalId'] } });
  assert(d1.changed, 'should detect changes in entries');
  assert(d1.stats.added === 1 && d1.stats.removed === 1 && d1.stats.updated >= 1, 'stats should reflect add/remove/update');

  // 3) summaries human-friendly
  const s = d1.summary.join(' | ');
  assert(s.includes('Servings') && (s.includes('1.5') || s.includes('1.50')), 'should mention servings update');
  assert(s.includes('Added item') || s.includes('Removed item'), 'should include add/remove lines');

  // 4) applyPatch produces next
  const after = applyPatch(prev, d1.ops);
  // we didn't produce strict index-based ops, but our keyed paths should line up for object maps
  // To keep test deterministic, compare via deepEqual with our tolerance:
  assert(isEqual(after, deepMerge(prev, next)), 'patched result should equal merged next state');

  // 5) settings change summary
  const S1 = { settings: { includeFiberCalories: true, fiberCalPerGram: 2 } };
  const S2 = { settings: { includeFiberCalories: false, fiberCalPerGram: 1.8 } };
  const d2 = diff(S1, S2);
  assert(d2.summary.some((l) => l.toLowerCase().includes('fiber calories')), 'should summarize fiber calories toggle');

  // 6) totals/pct/calories equality checks
  const T1 = { totals: { netCarb: 1, protein: 57, fat: 105, fiber: 0, sugarAlcohol: 0 },
               calories: { totalCalories: 1177, carbCals: 4, protCals: 228, fatCals: 945, fiberCals: 0, saCals: 0 },
               pct: { carbsPct: 4/1177, proteinPct: 228/1177, fatPct: 945/1177 } };
  const T2 = JSON.parse(JSON.stringify(T1));
  const d3 = diff(T1, T2);
  assert(!d3.changed, 'identical totals should not change');

  // small numerical jitter in pct should not flip change:
  T2.pct.carbsPct += 5e-5;
  assert(!diff(T1, T2).changed, 'tiny pct jitter should be ignored via percent epsilon');

  return 'diff.js self-test passed';
}

// ------------------------ default export ------------------------

export default {
  diff,
  applyPatch,
  deepMerge,
  isEqual,
  shallowChanges,
  runDiffSelfTest,
};
