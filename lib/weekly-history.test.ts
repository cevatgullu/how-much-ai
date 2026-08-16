// The trend is the only part of the instrument that remembers anything, so the rules about what
// gets written, what gets thrown away, and what a gap means are the whole contract.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./providers/_resolve-ts.mjs";

const {
  historyDayKey,
  historyDayWindow,
  parseWeeklyHistory,
  pruneWeeklyHistory,
  recordWeeklyHistory,
  weeklyHistorySamples,
  weeklyTrendFilledDays,
  weeklyTrendSeries,
  WEEKLY_HISTORY_RETENTION_DAYS,
  WEEKLY_TREND_DAYS,
} = await import("./weekly-history.ts");

// Local noon avoids a UTC-offset day boundary turning the fixture into the neighbouring date.
const day = (year: number, month: number, date: number) => new Date(year, month - 1, date, 12).getTime();
const TODAY = day(2026, 8, 16);

test("a day key is the local calendar day, not the UTC one", () => {
  // A reading taken at 01:30 local belongs to that local day; bucketing by UTC would file it under
  // yesterday for every user east of Greenwich, which is where this app is used.
  assert.equal(historyDayKey(new Date(2026, 7, 16, 1, 30).getTime()), "2026-08-16");
  assert.equal(historyDayKey(new Date(2026, 7, 16, 23, 45).getTime()), "2026-08-16");
});

test("the window walks calendar days, so a DST shift cannot skip or repeat a date", () => {
  const window = historyDayWindow(TODAY, WEEKLY_TREND_DAYS);
  assert.equal(window.length, 7);
  assert.deepEqual(window, [
    "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13",
    "2026-08-14", "2026-08-15", "2026-08-16",
  ]);
  // Turkey's clocks are fixed, but the app is not: stepping by date index rather than by 86400000
  // is what keeps a 23-hour day from producing two identical keys.
  const across = historyDayWindow(new Date(2026, 2, 30, 12).getTime(), 3);
  assert.equal(new Set(across).size, 3);
});

test("today's reading replaces today's earlier reading instead of stacking", () => {
  let history = recordWeeklyHistory({}, [{ accountId: "a", percent: 12 }], TODAY);
  history = recordWeeklyHistory(history, [{ accountId: "a", percent: 19 }], TODAY + 3_600_000);
  assert.deepEqual(history.a, [{ day: "2026-08-16", percent: 19 }]);
});

test("the last reading of the day wins, including when a limit rolls back down", () => {
  // Keeping the maximum would look tidier and be wrong: the window really does drop to near zero
  // at the reset, and a curve that refuses to come down stops describing the account.
  let history = recordWeeklyHistory({}, [{ accountId: "a", percent: 96 }], TODAY);
  history = recordWeeklyHistory(history, [{ accountId: "a", percent: 3 }], TODAY + 7_200_000);
  assert.equal(history.a[0].percent, 3);
});

test("percentages are clamped and rounded on the way in", () => {
  const history = recordWeeklyHistory({}, [
    { accountId: "a", percent: 142 },
    { accountId: "b", percent: -8 },
    { accountId: "c", percent: 61.6 },
  ], TODAY);
  assert.equal(history.a[0].percent, 100);
  assert.equal(history.b[0].percent, 0);
  assert.equal(history.c[0].percent, 62);
});

test("points older than the retention window are dropped", () => {
  const history = {
    a: [
      { day: historyDayKey(day(2026, 8, 6)), percent: 10 },
      { day: historyDayKey(day(2026, 8, 8)), percent: 20 },
      { day: historyDayKey(day(2026, 8, 9)), percent: 30 },
      { day: historyDayKey(day(2026, 8, 16)), percent: 40 },
    ],
  };
  const pruned = pruneWeeklyHistory(history, TODAY);
  // Retention is eight days: today plus the seven behind it, so 09-08 survives and 08-08 does not.
  assert.deepEqual(pruned.a.map((point) => point.day), ["2026-08-09", "2026-08-16"]);
  assert.equal(WEEKLY_HISTORY_RETENTION_DAYS, 8);
});

test("a removed account's history goes with it", () => {
  const history = {
    kept: [{ day: "2026-08-16", percent: 5 }],
    gone: [{ day: "2026-08-16", percent: 5 }],
  };
  assert.deepEqual(Object.keys(pruneWeeklyHistory(history, TODAY, ["kept"])), ["kept"]);
  // Accounts with nothing left after pruning must not linger as empty arrays.
  assert.deepEqual(pruneWeeklyHistory({ old: [{ day: "2026-01-01", percent: 5 }] }, TODAY), {});
});

test("only fresh readings are written down", () => {
  const samples = weeklyHistorySamples([
    { accountId: "fresh", highestWeeklyUsedPercent: 44, hasFreshReading: true },
    // A stale card is repeating an old number; filing it under today invents a measurement.
    { accountId: "stale", highestWeeklyUsedPercent: 44, hasFreshReading: false },
    { accountId: "empty", highestWeeklyUsedPercent: null, hasFreshReading: true },
  ]);
  assert.deepEqual(samples, [{ accountId: "fresh", percent: 44 }]);
});

test("series line up with the chart's day slots and gaps stay gaps", () => {
  const history = {
    a: [
      { day: "2026-08-11", percent: 20 },
      { day: "2026-08-14", percent: 55 },
      { day: "2026-08-16", percent: 71 },
    ],
  };
  const [series] = weeklyTrendSeries(history, ["a"], TODAY);
  assert.deepEqual(series.points, [null, 20, null, null, 55, null, 71]);
  assert.equal(series.latest, 71);
});

test("an account with no history yields an empty series rather than being dropped", () => {
  const [series] = weeklyTrendSeries({}, ["ghost"], TODAY);
  assert.equal(series.accountId, "ghost");
  assert.equal(series.latest, null);
  assert.equal(series.points.length, WEEKLY_TREND_DAYS);
});

test("the first day of collection is one filled slot", () => {
  const series = weeklyTrendSeries({ a: [{ day: "2026-08-16", percent: 8 }] }, ["a"], TODAY);
  assert.equal(weeklyTrendFilledDays(series), 1);
  const two = weeklyTrendSeries(
    { a: [{ day: "2026-08-15", percent: 8 }, { day: "2026-08-16", percent: 9 }] },
    ["a"],
    TODAY,
  );
  assert.equal(weeklyTrendFilledDays(two), 2);
});

test("a corrupt or oversized stored value degrades to an empty history", () => {
  assert.deepEqual(parseWeeklyHistory(null), {});
  assert.deepEqual(parseWeeklyHistory("not json"), {});
  assert.deepEqual(parseWeeklyHistory("[]"), {});
  assert.deepEqual(parseWeeklyHistory(JSON.stringify({ a: "nope" })), {});
  // Rows that fail validation are dropped individually; one bad point must not lose the account.
  const mixed = parseWeeklyHistory(JSON.stringify({
    a: [
      { day: "2026-08-16", percent: 12 },
      { day: "16/08/2026", percent: 12 },
      { day: "2026-08-15", percent: "12" },
      { day: "2026-08-16", percent: 99 },
    ],
  }));
  assert.deepEqual(mixed.a, [{ day: "2026-08-16", percent: 12 }]);
  // A value too large to be a history is refused outright rather than parsed.
  assert.deepEqual(parseWeeklyHistory(JSON.stringify({ a: "x".repeat(40_000) })), {});
});
