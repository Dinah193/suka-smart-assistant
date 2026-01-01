// File: C:\Users\larho\suka-smart-assistant\src\tests\planner.spec.js
/**
 * Planner tests — Critical Path & Back-Planning
 * -----------------------------------------------------------------------------
 * Scope
 *  - Verifies graph-based critical path calculations (ES/EF/LS/LF/slack).
 *  - Verifies backward scheduling from a fixed deadline with constraints
 *    (quiet hours window) and basic hard-buffer insertion.
 *
 * Context in SSA
 *  - During **compile**, the planner produces a feasible plan from domain
 *    tasks and dependencies. Critical path length informs soft-buffer needs
 *    and SLO projections. Back-planning is used when a fixed end time exists
 *    (e.g., guest arrival, equipment booking end).
 *  - During **gate**, quiet hours/Sabbath and resource exclusivity are applied.
 *  - During **control**, reschedule suggestions nudge tasks while preserving
 *    precedence and respecting constraints.
 *
 * Assumed module under test (MUT)
 *  - src/planning/planner.js exporting:
 *      criticalPath(tasks) -> {
 *        totalDurationMin: number,
 *        order: string[],                 // a valid topological order
 *        criticalIds: string[]|Set<string>,
 *        nodes: Record<id, { es:number, ef:number, ls:number, lf:number, slack:number }>
 *      }
 *      backPlan({ targetEndISO, tasks, constraints }) -> {
 *        schedule: Array<{
 *          id:string, startISO:string, endISO:string,
 *          // optional:
 *          buffer?: { kind:string, minutes:number }
 *        }>,
 *        violations?: Array<{ id?:string, reason:string }>
 *      }
 *
 * NOTE: If your actual signatures differ, adjust the imports/expectations below.
 */

import { criticalPath, backPlan } from "../planning/planner";

const ISO = (y, m, d, hh, mm = 0) =>
  new Date(Date.UTC(y, m - 1, d, hh, mm)).toISOString();

const addMinISO = (iso, min) => new Date(new Date(iso).getTime() + min * 60000).toISOString();
const diffMin = (aISO, bISO) => Math.round((new Date(bISO) - new Date(aISO)) / 60000);

function byId(arr, id) {
  const x = arr.find((t) => t.id === id);
  if (!x) throw new Error(`Missing id: ${id}`);
  return x;
}

// ---------------------------------------------------------------------------
// Critical Path: diamond graph test
//   A(30) → B(40) → D(10)
//       └→ C(20) ─┘
// CP length = 30 + 40 + 10 = 80 min; C has 20 min slack.
// ---------------------------------------------------------------------------

describe("criticalPath()", () => {
  const tasks = [
    { id: "A", title: "Prep", minutes: 30, deps: [] },
    { id: "B", title: "Cook", minutes: 40, deps: ["A"] },
    { id: "C", title: "Sauce", minutes: 20, deps: ["A"] },
    { id: "D", title: "Plate", minutes: 10, deps: ["B", "C"] },
  ];

  it("computes total duration and slack correctly", () => {
    const res = criticalPath(tasks);
    expect(res).toBeTruthy();

    // total duration
    expect(res.totalDurationMin).toBe(80);

    // topological order must start with A and end with D
    expect(res.order[0]).toBe("A");
    expect(res.order[res.order.length - 1]).toBe("D");

    // critical set must include A,B,D and exclude C
    const crit = res.criticalIds instanceof Set ? res.criticalIds : new Set(res.criticalIds);
    expect(crit.has("A")).toBe(true);
    expect(crit.has("B")).toBe(true);
    expect(crit.has("D")).toBe(true);
    expect(crit.has("C")).toBe(false);

    // node times & slack (origin ES=0)
    const n = res.nodes;
    expect(n.A.es).toBe(0);
    expect(n.A.ef).toBe(30);
    // B follows A
    expect(n.B.es).toBe(30);
    expect(n.B.ef).toBe(70);
    // C can start after A, finishes at 50
    expect(n.C.es).toBe(30);
    expect(n.C.ef).toBe(50);
    // D waits for both B and C → ES=70
    expect(n.D.es).toBe(70);
    expect(n.D.ef).toBe(80);

    // Late times anchored by CP length (80)
    expect(n.D.lf).toBe(80);
    expect(n.D.ls).toBe(70);

    // Slack: C can slip 20 min without delaying D
    expect(n.C.slack).toBe(20);
    // Slack of CP nodes is ~0 (allow tiny float noise)
    for (const id of ["A", "B", "D"]) {
      expect(Math.abs(n[id].slack)).toBeLessThan(1e-9);
    }
  });

  it("throws or reports on cycles (invalid precedence)", () => {
    const cyclic = [
      { id: "X", minutes: 5, deps: ["Y"] },
      { id: "Y", minutes: 5, deps: ["X"] },
    ];
    try {
      const r = criticalPath(cyclic);
      // If implementation signals instead of throwing, assert a flag:
      expect(r && r.error).toBeTruthy();
    } catch (e) {
      expect(String(e)).toMatch(/cycle|acyclic/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Back-Planning: fixed deadline with precedence
// Using same diamond graph. Deadline sets D.end at targetEnd.
// ---------------------------------------------------------------------------

describe("backPlan() — basic precedence, no extra constraints", () => {
  const tasks = [
    { id: "A", minutes: 30, deps: [] },
    { id: "B", minutes: 40, deps: ["A"] },
    { id: "C", minutes: 20, deps: ["A"] },
    { id: "D", minutes: 10, deps: ["B", "C"] },
  ];

  const targetEndISO = ISO(2025, 11, 9, 18, 0); // 18:00Z

  it("schedules backwards to meet deadline while honoring deps", () => {
    const { schedule, violations } = backPlan({ targetEndISO, tasks, constraints: {} });
    expect(violations?.length || 0).toBe(0);

    const d = byId(schedule, "D");
    expect(d.endISO).toBe(targetEndISO);
    expect(diffMin(d.startISO, d.endISO)).toBe(10);

    // B and C must end when D starts
    const b = byId(schedule, "B");
    const c = byId(schedule, "C");
    expect(b.endISO).toBe(d.startISO);
    expect(c.endISO).toBe(d.startISO);
    expect(diffMin(b.startISO, b.endISO)).toBe(40);
    expect(diffMin(c.startISO, c.endISO)).toBe(20);

    // A must end at min(B.start, C.start)
    const a = byId(schedule, "A");
    const latestChildStart = [b.startISO, c.startISO].sort()[0]; // ISO sort OK
    expect(a.endISO).toBe(latestChildStart);
    expect(diffMin(a.startISO, a.endISO)).toBe(30);

    // Overall span equals CP length (80 min)
    const total = diffMin(a.startISO, d.endISO);
    expect(total).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// Back-Planning with quiet-hours constraint:
// - Quiet hours block 22:00–07:00 (local; tests use ISO UTC for simplicity).
// - If deadline is 22:10 and task takes 30m, it must snap to end by 22:00.
// ---------------------------------------------------------------------------

describe("backPlan() — quiet hours snapping (no work inside blocked window)", () => {
  const tasks = [{ id: "X", minutes: 30, deps: [] }];
  const targetEndISO = ISO(2025, 11, 9, 22, 10); // 22:10Z

  const constraints = {
    quietHours: { startLocalHour: 22, endLocalHour: 7 },
    // For the unit test we assume the planner interprets "local hour"
    // against the provided timestamps uniformly; we assert only the boundary snap.
  };

  it("moves work to finish at quiet-hours boundary when the deadline breaches it", () => {
    const { schedule, violations } = backPlan({ targetEndISO, tasks, constraints });
    expect(violations?.length || 0).toBe(0);
    const x = byId(schedule, "X");
    // Should finish at 22:00 boundary and start at 21:30
    // Allow 1-minute tolerance if the implementation rounds.
    const expectedEnd = ISO(2025, 11, 9, 22, 0);
    expect(Math.abs(diffMin(x.endISO, expectedEnd))).toBeLessThanOrEqual(1);
    expect(Math.abs(diffMin(x.startISO, ISO(2025, 11, 9, 21, 30)))).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Back-Planning with buffer insertion:
//  - If a "sanitation" hard buffer (5m) is required between B→D, planner
//    should insert the buffer while back-scheduling.
// ---------------------------------------------------------------------------

describe("backPlan() — hard buffer insertion between specific edges", () => {
  const tasks = [
    { id: "A", minutes: 30, deps: [] },
    { id: "B", minutes: 40, deps: ["A"], tags: { kind: "meat" } },
    { id: "C", minutes: 20, deps: ["A"], tags: { kind: "veg" } },
    { id: "D", minutes: 10, deps: ["B", "C"] },
  ];

  const targetEndISO = ISO(2025, 11, 9, 18, 0);

  const constraints = {
    buffers: [
      // Sanitation required between meat → any different kind
      { fromKind: "meat", toKind: "*", minutes: 5, hard: true, label: "sanitation" },
    ],
  };

  it("adds sanitation buffer after B before D", () => {
    const { schedule, violations } = backPlan({ targetEndISO, tasks, constraints });
    expect(violations?.length || 0).toBe(0);

    const d = byId(schedule, "D");
    const b = byId(schedule, "B");
    // There should be either a synthetic buffer item or gap == 5m between B.end and D.start
    const gapBD = diffMin(b.endISO, d.startISO);
    if (gapBD !== 5) {
      // If represented as explicit item, find it
      const buf = schedule.find((s) => s.buffer?.kind === "sanitation");
      expect(buf).toBeTruthy();
      expect(diffMin(buf.startISO, buf.endISO)).toBe(5);
      // And B.end == buffer.start; buffer.end == D.start
      expect(diffMin(b.endISO, buf.startISO)).toBe(0);
      expect(diffMin(buf.endISO, d.startISO)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Validations
// ---------------------------------------------------------------------------

describe("Planner input validation", () => {
  it("rejects missing durations or negative minutes", () => {
    const bad = [{ id: "oops", minutes: -5, deps: [] }];
    try {
      const cp = criticalPath(bad);
      expect(cp && cp.error).toBeTruthy();
    } catch (e) {
      expect(String(e)).toMatch(/minutes|duration|positive/i);
    }
  });

  it("rejects unknown dependencies", () => {
    const bad = [
      { id: "A", minutes: 10, deps: ["Z"] },
      { id: "B", minutes: 10, deps: [] },
    ];
    try {
      const cp = criticalPath(bad);
      expect(cp && cp.error).toBeTruthy();
    } catch (e) {
      expect(String(e)).toMatch(/dependency|unknown/i);
    }
  });
});
