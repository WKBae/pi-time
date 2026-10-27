import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addUsage, createUsageTotals, formatCompletionTime, formatDuration, formatSummary,
} from "../src/timing.ts";

test("duration formatting covers subsecond, minute, hour, and multiday boundaries", () => {
  for (const [ms, expected] of [
    [0, "0s"], [999, "0s"], [1000, "1s"], [59999, "59s"],
    [60000, "1m 0s"], [3599999, "59m 59s"], [3600000, "1h 0m 0s"],
    [90061000, "25h 1m 1s"], [-1000, "0s"], [NaN, "0s"],
  ] as const) assert.equal(formatDuration(ms), expected);
});

test("completion time uses local time and padded 12-hour hours, minutes, seconds", () => {
  for (const [hour, expected] of [
    [0, "12:05:09 AM"], [1, "01:05:09 AM"], [12, "12:05:09 PM"],
    [13, "01:05:09 PM"], [23, "11:05:09 PM"],
  ] as const) {
    assert.equal(formatCompletionTime(new Date(2026, 0, 1, hour, 5, 9)), expected);
  }
});

test("sums disjoint input buckets and reported costs across calls without counting subsets twice", () => {
  const totals = createUsageTotals();
  addUsage(totals, {
    input: 100, cacheRead: 800, cacheWrite: 20, cacheWrite1h: 10,
    output: 70, reasoning: 30, totalTokens: 990, cost: { total: 0.01 },
  });
  addUsage(totals, { input: 280, output: 20, cost: { total: 0.0023 } });
  assert.equal(totals.input, 1200);
  assert.equal(totals.cached, 800);
  assert.equal(totals.output, 90);
  assert.ok(Math.abs(totals.cost - 0.0123) < 1e-10);
});

test("missing, negative, and nonfinite usage never produces NaN or Infinity", () => {
  const totals = createUsageTotals();
  addUsage(totals);
  addUsage(totals, {});
  addUsage(totals, { input: NaN, cacheRead: Infinity, cacheWrite: -2, output: -1, cost: {} });
  addUsage(totals, { cost: { total: Infinity } });
  addUsage(totals, { cost: { total: NaN } });
  addUsage(totals, { cost: { total: -0.01 } });
  assert.deepEqual(totals, createUsageTotals());
});

test("summary has the exact middot-separated elapsed, usage/cost, completion layout", () => {
  assert.equal(
    formatSummary(83000, 12500, { input: 1200, cached: 800, output: 90, cost: 0.0123 },
      new Date(2026, 0, 1, 13, 5, 9)),
    "1m 23s · tools 12s · in 1,200 (800 cached), out 90 · $0.0123 · 01:05:09 PM",
  );
  assert.equal(
    formatSummary(0, 0, createUsageTotals(), new Date(2026, 0, 1)),
    "0s · tools 0s · in 0 (0 cached), out 0 · $0.0000 · 12:00:00 AM",
  );
});
