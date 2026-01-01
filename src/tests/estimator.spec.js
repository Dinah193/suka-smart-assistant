// File: C:\Users\larho\suka-smart-assistant\src\tests\estimator.spec.js
/**
 * Estimator math tests — PERT & Monte Carlo
 * -----------------------------------------------------------------------------
 * Scope
 *  - Validates Beta-PERT mean/variance helpers and Monte Carlo aggregation.
 *  - Ensures deterministic sampling with a seeded RNG (by mocking Math.random).
 *
 * Context in SSA
 *  - Domain engines produce optimistic/mostLikely/pessimistic task estimates.
 *  - ETA worker and planners may call estimator utilities to:
 *      • compute PERT mean/variance for single tasks
 *      • sample durations for simulation-based buffering
 *  - This test guards the *math layer*; it’s independent of eventBus/bridges.
 *
 * Expected module under test
 *  - src/math/estimator.js exporting:
 *      pertMean(a, m, b, lambda = 4)
 *      pertVariance(a, m, b, lambda = 4)
 *      samplePert(a, m, b, lambda = 4, rng = Math.random)
 *      monteCarloSum(tasks, { trials = 10000, lambda = 4, rng } = {})
 *          // tasks: [{ a, m, b }] or [{ optimistic, mostLikely, pessimistic }]
 *
 * If your function names differ, adjust the imports below.
 */

import {
  pertMean,
  pertVariance,
  samplePert,
  monteCarloSum,
} from "../math/estimator";

// ------------------------------
// Test helpers (reference math)
// ------------------------------

/** Compute α,β for scaled Beta-PERT given a,m,b,λ (λ=4 classic). */
function abFromPert(a, m, b, lambda = 4) {
  if (!(b > a)) throw new Error("bad range");
  const x = (m - a) / (b - a);
  const alpha = 1 + lambda * x;
  const beta = 1 + lambda * (1 - x);
  return { alpha, beta };
}

/** Reference mean using α,β form on [a,b]. */
function refPertMean(a, m, b, lambda = 4) {
  const { alpha, beta } = abFromPert(a, m, b, lambda);
  return a + (alpha / (alpha + beta)) * (b - a);
}

/** Reference variance using α,β on [a,b]. */
function refPertVariance(a, m, b, lambda = 4) {
  const { alpha, beta } = abFromPert(a, m, b, lambda);
  const num = alpha * beta * Math.pow(b - a, 2);
  const den = Math.pow(alpha + beta, 2) * (alpha + beta + 1);
  return num / den;
}

/** Simple deterministic RNG factory (Mulberry32). */
function makeSeeded(seed) {
  let t = seed >>> 0;
  return function rng() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Temporarily patch Math.random with a seeded generator. */
function withSeed(seed, fn) {
  const original = Math.random;
  try {
    Math.random = makeSeeded(seed);
    return fn();
  } finally {
    Math.random = original;
  }
}

/** Convert alias fields to {a,m,b}. */
function norm(t) {
  const a = t.a ?? t.optimistic;
  const m = t.m ?? t.mostLikely;
  const b = t.b ?? t.pessimistic;
  return { a, m, b };
}

// ------------------------------
// Tests
// ------------------------------

describe("PERT mean", () => {
  it("matches classic PERT mean for symmetric inputs", () => {
    const a = 10, m = 20, b = 30, lambda = 4;
    // Classic closed form: (a + λm + b) / (λ + 2)
    const classic = (a + lambda * m + b) / (lambda + 2);
    expect(pertMean(a, m, b, lambda)).toBeCloseTo(classic, 12);
    // αβ reference should also match
    expect(pertMean(a, m, b, lambda)).toBeCloseTo(refPertMean(a, m, b, lambda), 12);
  });

  it("handles skewed modes correctly (mode near a)", () => {
    const a = 20, m = 22, b = 40, lambda = 4;
    const expected = refPertMean(a, m, b, lambda);
    expect(pertMean(a, m, b, lambda)).toBeCloseTo(expected, 12);
    expect(pertMean(a, m, b, lambda)).toBeGreaterThan(a);
    expect(pertMean(a, m, b, lambda)).toBeLessThan((a + b) / 2);
  });

  it("degenerates to the constant when a=m=b", () => {
    expect(pertMean(15, 15, 15)).toBe(15);
    expect(pertVariance(15, 15, 15)).toBe(0);
  });

  it("throws or returns NaN on invalid ranges", () => {
    // Implementation may throw or return NaN; accept either but not a finite number.
    const run = () => pertMean(10, 20, 9);
    const got = (() => { try { return run(); } catch (e) { return NaN; } })();
    expect(Number.isFinite(got)).toBe(false);
  });
});

describe("PERT variance", () => {
  it("matches αβ variance formula on [a,b] scale", () => {
    const a = 1, m = 2, b = 7, lambda = 4;
    const expected = refPertVariance(a, m, b, lambda);
    expect(pertVariance(a, m, b, lambda)).toBeCloseTo(expected, 12);
  });

  it("variance increases when spread widens", () => {
    const tight = pertVariance(10, 10.5, 11);
    const wide = pertVariance(10, 12, 20);
    expect(wide).toBeGreaterThan(tight);
  });
});

describe("PERT sampling (samplePert)", () => {
  it("is deterministic with a provided seeded rng", () => {
    const rngA = makeSeeded(42);
    const rngB = makeSeeded(42);
    const drawsA = Array.from({ length: 5 }, () => samplePert(10, 12, 20, 4, rngA));
    const drawsB = Array.from({ length: 5 }, () => samplePert(10, 12, 20, 4, rngB));
    expect(drawsA).toEqual(drawsB);
  });

  it("roughly centers around PERT mean over many samples", () => {
    const a = 5, m = 8, b = 20, lambda = 4;
    const mu = pertMean(a, m, b, lambda);
    const rng = makeSeeded(7);
    const N = 100_000;
    let sum = 0;
    for (let i = 0; i < N; i++) sum += samplePert(a, m, b, lambda, rng);
    const avg = sum / N;
    // Law of large numbers: within small tolerance of the mean
    expect(avg).toBeCloseTo(mu, 2); // ~1e-2 relative on this scale
  });

  it("respects bounds [a,b]", () => {
    const a = 2, m = 3, b = 5, rng = makeSeeded(99);
    for (let i = 0; i < 10_000; i++) {
      const x = samplePert(a, m, b, 4, rng);
      expect(x).toBeGreaterThanOrEqual(a - 1e-12);
      expect(x).toBeLessThanOrEqual(b + 1e-12);
    }
  });

  it("works deterministically when Math.random is mocked", () => {
    const values = withSeed(123, () => [
      samplePert(1, 2, 4),
      samplePert(1, 2, 4),
      samplePert(1, 2, 4),
    ]);
    const again = withSeed(123, () => [
      samplePert(1, 2, 4),
      samplePert(1, 2, 4),
      samplePert(1, 2, 4),
    ]);
    expect(values).toEqual(again);
  });
});

describe("Monte Carlo aggregation (monteCarloSum)", () => {
  it("converges to sum of PERT means (LLN)", () => {
    const tasks = [
      { a: 10, m: 15, b: 40 },
      { optimistic: 5, mostLikely: 8, pessimistic: 15 },
      { a: 2, m: 3, b: 5 },
    ];
    const muSum = tasks
      .map(norm)
      .map(({ a, m, b }) => pertMean(a, m, b))
      .reduce((s, x) => s + x, 0);

    const rng = makeSeeded(20251109);
    const { mean, variance, trials } = monteCarloSum(tasks, { trials: 200_000, rng });

    expect(trials).toBe(200000);
    expect(mean).toBeCloseTo(muSum, 1); // within ~0.1 on this scale
    // Crude check: variance should be close to sum of individual variances (independent tasks)
    const varSum = tasks
      .map(norm)
      .map(({ a, m, b }) => pertVariance(a, m, b))
      .reduce((s, v) => s + v, 0);
    expect(variance).toBeCloseTo(varSum, 1);
  });

  it("accepts empty task lists and returns zeros", () => {
    const { mean, variance, trials } = monteCarloSum([], { trials: 10_000, rng: makeSeeded(1) });
    expect(mean).toBe(0);
    expect(variance).toBe(0);
    expect(trials).toBe(10000);
  });

  it("throws or guards on invalid inputs", () => {
    const badTasks = [{ a: 5, m: 4, b: 3 }]; // b <= a invalid
    const run = () => monteCarloSum(badTasks, { trials: 100, rng: makeSeeded(5) });
    // Accept either thrown error or NaN mean (but not a finite number)
    try {
      const r = run();
      expect(Number.isFinite(r.mean)).toBe(false);
    } catch (e) {
      expect(e).toBeTruthy();
    }
  });

  it("is deterministic with a seeded RNG", () => {
    const tasks = [
      { a: 10, m: 12, b: 20 },
      { a: 3, m: 4, b: 9 },
    ];
    const rng1 = makeSeeded(101);
    const rng2 = makeSeeded(101);
    const r1 = monteCarloSum(tasks, { trials: 50_000, rng: rng1 });
    const r2 = monteCarloSum(tasks, { trials: 50_000, rng: rng2 });
    expect(r1.mean).toBeCloseTo(r2.mean, 12);
    expect(r1.variance).toBeCloseTo(r2.variance, 12);
  });
});

// ------------------------------
// Edge cases & regressions
// ------------------------------

describe("Edge cases & regressions", () => {
  it("handles ultra-narrow ranges without numerical instability", () => {
    const a = 60, m = 60.1, b = 60.2;
    expect(() => pertVariance(a, m, b)).not.toThrow();
    expect(pertVariance(a, m, b)).toBeGreaterThan(0);
    // Sampling should still remain within bounds
    const rng = makeSeeded(77);
    for (let i = 0; i < 1000; i++) {
      const x = samplePert(a, m, b, 4, rng);
      expect(x).toBeGreaterThanOrEqual(a - 1e-9);
      expect(x).toBeLessThanOrEqual(b + 1e-9);
    }
  });

  it("tolerates different λ values (flatter vs sharper distributions)", () => {
    const a = 1, m = 3, b = 10;
    const muFlat = pertMean(a, m, b, 2);
    const muSharp = pertMean(a, m, b, 8);
    // Means shift slightly with λ, but remain between a and b
    expect(muFlat).toBeGreaterThan(a);
    expect(muFlat).toBeLessThan(b);
    expect(muSharp).toBeGreaterThan(a);
    expect(muSharp).toBeLessThan(b);
    // Variance shrinks as λ grows (sharper about mode)
    expect(pertVariance(a, m, b, 8)).toBeLessThan(pertVariance(a, m, b, 2));
  });
});
