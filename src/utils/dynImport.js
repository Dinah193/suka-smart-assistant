// src/utils/dynImport.js
/**
 * Dynamic import helpers that work with Vite:
 * - Build a static superset map using literal import.meta.glob() patterns
 * - Filter that superset at runtime using a tiny glob matcher (**, *, ?)
 * - Provide helpers to load modules by exact/suffix match
 *
 * No regex literals, no TypeScript-style annotations.
 */

// ---------------------------------------------------------
// 1) Superset registry (LITERAL patterns only for Vite)
// ---------------------------------------------------------
const G_JS   = import.meta.glob([
  '/src/**/*.js',
  '!/src/tests/**',
  '!/src/**/__tests__/**',
  '!/src/**/*.test.*',
  '!/src/**/*.spec.*',
  '!/src/pages/**/Import.*',
  '!/src/pages/**/import.*',
]);
const G_TS   = import.meta.glob([
  '/src/**/*.ts',
  '!/src/tests/**',
  '!/src/**/__tests__/**',
  '!/src/**/*.test.*',
  '!/src/**/*.spec.*',
  '!/src/pages/**/Import.*',
  '!/src/pages/**/import.*',
]);
const G_JSX  = import.meta.glob([
  '/src/**/*.jsx',
  '!/src/tests/**',
  '!/src/**/__tests__/**',
  '!/src/**/*.test.*',
  '!/src/**/*.spec.*',
  '!/src/pages/**/Import.*',
  '!/src/pages/**/import.*',
]);
const G_TSX  = import.meta.glob([
  '/src/**/*.tsx',
  '!/src/tests/**',
  '!/src/**/__tests__/**',
  '!/src/**/*.test.*',
  '!/src/**/*.spec.*',
  '!/src/pages/**/Import.*',
  '!/src/pages/**/import.*',
]);
const G_MD   = import.meta.glob([
  '/src/**/*.md',
  '!/src/tests/**',
  '!/src/**/__tests__/**',
  '!/src/**/*.test.*',
  '!/src/**/*.spec.*',
  '!/src/pages/**/Import.*',
  '!/src/pages/**/import.*',
]);
const G_MDX  = import.meta.glob([
  '/src/**/*.mdx',
  '!/src/tests/**',
  '!/src/**/__tests__/**',
  '!/src/**/*.test.*',
  '!/src/**/*.spec.*',
  '!/src/pages/**/Import.*',
  '!/src/pages/**/import.*',
]);
// Remove this if you don't need JSON as raw:
const G_JSON = import.meta.glob([
  '/src/**/*.json',
  '!/src/tests/**',
  '!/src/**/__tests__/**',
  '!/src/**/*.test.*',
  '!/src/**/*.spec.*',
  '!/src/pages/**/Import.*',
  '!/src/pages/**/import.*',
], { query: '?raw', import: 'default' });

// path -> () => Promise<Module>
const ALL_MODULES = Object.assign({}, G_JS, G_TS, G_JSX, G_TSX, G_MD, G_MDX, G_JSON);

// ---------------------------------------------------------
// 2) Tiny glob matcher without RegExp
//    Supports:
//      ** : any subpath (including '/')
//       * : any chars except '/'
//       ? : exactly one char except '/'
// ---------------------------------------------------------

// Split pattern into segments by '/', keeping "**" segments intact.
function splitSegments(s) {
  if (!s) return [''];
  // normalize backslashes to forward slashes just in case
  return String(s).replace(/\\/g, '/').split('/');
}

// Match a single segment (no '/'), pattern can contain '*' and '?'
function matchSegment(name, pat) {
  var n = String(name), p = String(pat);
  var ni = 0, pi = 0, starIdx = -1, matchIdx = 0;

  while (ni < n.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === n[ni])) {
      ni++; pi++; // single-char match
    } else if (pi < p.length && p[pi] === '*') {
      starIdx = pi;
      matchIdx = ni;
      pi++; // assume * matches zero chars, we'll extend if needed
    } else if (starIdx !== -1) {
      // backtrack to last star and let it eat one more char
      pi = starIdx + 1;
      matchIdx++;
      ni = matchIdx;
    } else {
      return false;
    }
  }
  // consume any trailing '*' in pattern
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

// Core "**" aware matcher: path like "/a/b/c.js", pattern like "/src/**\/*.js"
function matchesGlob(path, pattern) {
  var pSegs = splitSegments(pattern);
  var sSegs = splitSegments(path);

  var pi = 0; // pattern index
  var si = 0; // path index
  var starPi = -1; // index of last ** in pattern
  var starSi = -1; // path index when ** was taken

  while (si < sSegs.length) {
    if (pi < pSegs.length) {
      var patSeg = pSegs[pi];
      if (patSeg === '**') {
        // remember position; ** can match zero or more segments
        starPi = pi;
        starSi = si;
        pi++;           // move past the **
        continue;       // and try to match further
      }
      // normal segment: must match without '/'
      if (matchSegment(sSegs[si], patSeg)) {
        si++; pi++;
        continue;
      }
    }
    // if we cannot match, but we saw a ** before, let ** consume one more segment
    if (starPi !== -1) {
      pi = starPi + 1;
      starSi++;
      si = starSi;
      continue;
    }
    return false;
  }

  // consume trailing ** in pattern
  while (pi < pSegs.length && pSegs[pi] === '**') pi++;
  return pi === pSegs.length;
}

// ---------------------------------------------------------
// 3) Helpers
// ---------------------------------------------------------
function toArray(x) {
  if (Array.isArray(x)) return x;
  return x == null ? [] : [x];
}

function filterByPatterns(map, patterns) {
  var pats = toArray(patterns).filter(Boolean);
  if (!pats.length) return Object.assign({}, map);
  var out = {};
  var keys = Object.keys(map);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    for (var j = 0; j < pats.length; j++) {
      if (matchesGlob(key, pats[j])) {
        out[key] = map[key];
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------
// 4) Public API
// ---------------------------------------------------------

// Create a loader bound to one or more glob patterns (strings or array)
export function makeGlobLoader(patterns) {
  var filtered = filterByPatterns(ALL_MODULES, patterns);

  return async function load(pathLike) {
    var candidates = toArray(pathLike);

    // 1) Exact keys
    for (var i = 0; i < candidates.length; i++) {
      var p = String(candidates[i]);
      if (Object.prototype.hasOwnProperty.call(filtered, p)) {
        var mod1 = await filtered[p]();
        return (mod1 && mod1.default) ? mod1.default : mod1;
      }
    }

    // 2) Suffix fallback (helps if caller passes relative variants)
    var keys = Object.keys(filtered);
    for (var j = 0; j < candidates.length; j++) {
      var want = String(candidates[j]);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if (key.endsWith(want)) {
          var mod2 = await filtered[key]();
          return (mod2 && mod2.default) ? mod2.default : mod2;
        }
      }
    }

    // 3) Nothing matched — throw a clear error
    var sample = keys.slice(0, 20).join('\n  ');
    var msg = '[dynImport] Could not resolve any of:\n  ' +
              candidates.join('\n  ') +
              '\nfrom filtered module set (' + keys.length + ' entries).' +
              (sample ? '\nSample keys:\n  ' + sample : '');
    throw new Error(msg);
  };
}

// Load the first existing module from patterns + path variants
export async function loadFirst(patterns, pathLikeVariants) {
  const loader = makeGlobLoader(patterns);
  return loader(pathLikeVariants);
}

// Handy prebuilt loader covering /src/**
export const loadFromSrc = makeGlobLoader(['/src/**']);
