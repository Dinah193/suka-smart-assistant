# Weekly KPI Rollup Template

Status: Active Template
Template ID: KPI-ROLLUP-WEEKLY-V1

## Week Metadata

- Week ending (UTC): YYYY-MM-DD
- Release window: <release or sprint tag>
- Prepared by: <owner>
- Reviewed by: <engineering + product>
- Data source timestamp (UTC): YYYY-MM-DDTHH:mm:ssZ

## KPI Targets

| KPI | Target | Current Week | Prior Week | Delta | Status |
|---|---:|---:|---:|---:|---|
| Activation Rate | >= 0.35 |  |  |  |  |
| Weekly Active Households (WAH) | >= 0.40 |  |  |  |  |
| Task Completion Rate | >= 0.65 |  |  |  |  |
| Collaboration Depth | >= 1.20 |  |  |  |  |
| Participation Rate | >= 0.50 |  |  |  |  |
| Median Resolution Hours | <= 48.00 |  |  |  |  |
| Retention Week 2 | >= 0.25 |  |  |  |  |
| Retention Week 4 | >= 0.15 |  |  |  |  |

## Gate Summary

- Launch gate pass/fail: <pass|fail>
- Failed KPI keys: <comma-separated list or none>
- Blocker severity: <none|warning|release-blocker>

## Observations

1. Positive movement:
- <bullet>

2. Regressions:
- <bullet>

3. Potential root causes:
- <bullet>

## Action Plan (Next 7 Days)

1. <owner> - <action> - <due date>
2. <owner> - <action> - <due date>
3. <owner> - <action> - <due date>

## Evidence Links

- Launch metrics contract source: [src/server/contracts/launchMetricsContract.js](../../src/server/contracts/launchMetricsContract.js)
- Launch metrics contract tests: [_tests_/metrics.launchGates.contract.test.js](../../_tests_/metrics.launchGates.contract.test.js)
- Latest release checklist: [release-checklist.md](../../release-checklist.md)
- Current roadmap: [post-closeout-roadmap-2026-04-12.md](post-closeout-roadmap-2026-04-12.md)

## Completion Checklist

- [ ] Metrics snapshot captured for this week.
- [ ] Gate outcome evaluated against targets.
- [ ] Risks and owner actions recorded.
- [ ] Reviewed in weekly product + engineering sync.
