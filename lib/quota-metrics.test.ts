import assert from "node:assert/strict";
import { test } from "node:test";
import "./providers/_resolve-ts.mjs";
import type { AccountSnapshot, BrowserAccount, UsageData } from "./types";

const {
  deriveWeeklyAccountMetric,
  deriveWeeklyAccountMetrics,
  sortWeeklyAccountMetrics,
  summarizeWeeklyAccountMetrics,
} = await import("./quota-metrics.ts");

const acceptedAt = Date.parse("2026-08-12T09:00:00.000Z");

function account(id: string): BrowserAccount {
  return {
    id,
    email: `${id}@example.test`,
    plan: "Max",
    addedAt: acceptedAt,
    credentialKind: "managed",
    provider: "anthropic",
    credentialExpiresAt: acceptedAt + 86_400_000,
  };
}

function snapshot(usage: UsageData, status: AccountSnapshot["status"] = "ready", stale = false): AccountSnapshot {
  return { status, usage, stale };
}

test("derives the highest weekly usage and nearest future weekly reset independently", () => {
  const usage: UsageData = {
    seven_day: { utilization: 61, resets_at: "2026-08-12T10:00:00.000Z" },
    seven_day_oauth_apps: { utilization: 72, resets_at: "2026-08-12T12:00:00.000Z" },
    seven_day_opus: { utilization: 88, resets_at: "2026-08-12T15:00:00.000Z" },
  };

  assert.deepEqual(deriveWeeklyAccountMetric(account("account-a"), snapshot(usage), 3, acceptedAt), {
    accountId: "account-a",
    sourceIndex: 3,
    highestWeeklyUsedPercent: 88,
    highestWeeklyLimitKey: "weekly_scoped:opus",
    highestWeeklyLimitLabel: "Opus haftalık limiti",
    nearestWeeklyResetAt: "2026-08-12T10:00:00.000Z",
    nearestWeeklyResetKey: "weekly_all",
    nearestWeeklyResetLabel: "Haftalık limit",
    hasFreshReading: true,
  });
});

test("uses only weekly bars, preserves zero-use reset candidates, and rejects invalid or past resets", () => {
  const usage: UsageData = {
    five_hour: { utilization: 99, resets_at: "2026-08-12T09:30:00.000Z" },
    limits: [
      { kind: "other", percent: 100, severity: "critical", resets_at: "2026-08-12T09:15:00.000Z" },
      { kind: "weekly_oauth_apps", percent: 0, severity: "normal", resets_at: "2026-08-12T09:20:00.000Z" },
      { kind: "weekly_all", percent: 60, severity: "normal", resets_at: "2026-02-31T10:00:00.000Z" },
      { kind: "weekly_scoped", percent: 70, severity: "normal", resets_at: "2026-08-12T08:59:59.000Z", scope: { model: { id: "x", display_name: "X" } } },
    ],
  };

  assert.deepEqual(deriveWeeklyAccountMetric(account("account-a"), snapshot(usage), 0, acceptedAt), {
    accountId: "account-a",
    sourceIndex: 0,
    highestWeeklyUsedPercent: 70,
    highestWeeklyLimitKey: "weekly_scoped:x",
    highestWeeklyLimitLabel: "X haftalık limiti",
    nearestWeeklyResetAt: "2026-08-12T09:20:00.000Z",
    nearestWeeklyResetKey: "weekly_oauth_apps",
    nearestWeeklyResetLabel: "Bağlı uygulamalar haftalık limiti",
    hasFreshReading: true,
  });
});

test("breaks weekly maximum ties by overall, OAuth, then scoped key", () => {
  const usage: UsageData = {
    seven_day: { utilization: 80, resets_at: null },
    seven_day_oauth_apps: { utilization: 80, resets_at: null },
    limits: [
      { kind: "weekly_scoped", percent: 80, severity: "normal", resets_at: null, scope: { model: { id: "zeta", display_name: "Zeta" } } },
      { kind: "weekly_scoped", percent: 80, severity: "normal", resets_at: null, scope: { model: { id: "alpha", display_name: "Alpha" } } },
    ],
  };
  assert.equal(deriveWeeklyAccountMetric(account("a"), snapshot(usage), 0, acceptedAt).highestWeeklyLimitKey, "weekly_all");

  const noOverall: UsageData = { ...usage, seven_day: undefined, seven_day_oauth_apps: { utilization: 80, resets_at: null } };
  assert.equal(deriveWeeklyAccountMetric(account("a"), snapshot(noOverall), 0, acceptedAt).highestWeeklyLimitKey, "weekly_oauth_apps");

  const scopedOnly: UsageData = { limits: usage.limits };
  assert.equal(deriveWeeklyAccountMetric(account("a"), snapshot(scopedOnly), 0, acceptedAt).highestWeeklyLimitKey, "weekly_scoped:alpha");
});

test("retains last-good bars but only marks ready non-stale snapshots fresh", () => {
  const usage: UsageData = { seven_day: { utilization: 40, resets_at: "2026-08-12T11:00:00.000Z" } };
  for (const [status, stale] of [
    ["ready", false],
    ["ready", true],
    ["loading", false],
    ["error", false],
  ] as const) {
    const metric = deriveWeeklyAccountMetric(account(`${status}-${stale}`), snapshot(usage, status, stale), 0, acceptedAt);
    assert.equal(metric.highestWeeklyUsedPercent, 40);
    assert.equal(metric.hasFreshReading, status === "ready" && !stale);
  }
  assert.deepEqual(deriveWeeklyAccountMetric(account("missing"), undefined, 2, acceptedAt), {
    accountId: "missing",
    sourceIndex: 2,
    highestWeeklyUsedPercent: null,
    highestWeeklyLimitKey: null,
    highestWeeklyLimitLabel: null,
    nearestWeeklyResetAt: null,
    nearestWeeklyResetKey: null,
    nearestWeeklyResetLabel: null,
    hasFreshReading: false,
  });
});

test("derives metrics without changing accounts or snapshots", () => {
  const accounts = [account("a"), account("b")];
  const snapshots = { a: snapshot({ seven_day: { utilization: 30, resets_at: null } }), b: snapshot({}) };
  const accountsBefore = structuredClone(accounts);
  const snapshotsBefore = structuredClone(snapshots);

  assert.deepEqual(
    deriveWeeklyAccountMetrics(accounts, snapshots, acceptedAt).map((metric) => [metric.accountId, metric.sourceIndex, metric.highestWeeklyUsedPercent]),
    [["a", 0, 30], ["b", 1, null]],
  );
  assert.deepEqual(accounts, accountsBefore);
  assert.deepEqual(snapshots, snapshotsBefore);
});

test("sorts source, usage, and reset modes with missing values last and deterministic ties", () => {
  const metrics = [
    { accountId: "b", sourceIndex: 1, highestWeeklyUsedPercent: 70, nearestWeeklyResetAt: "2026-08-12T12:00:00.000Z" },
    { accountId: "a", sourceIndex: 1, highestWeeklyUsedPercent: 70, nearestWeeklyResetAt: "2026-08-12T12:00:00.000Z" },
    { accountId: "early", sourceIndex: 5, highestWeeklyUsedPercent: 10, nearestWeeklyResetAt: "2026-08-12T10:00:00.000Z" },
    { accountId: "missing", sourceIndex: 0, highestWeeklyUsedPercent: null, nearestWeeklyResetAt: null },
  ].map((partial) => ({
    ...partial,
    highestWeeklyLimitKey: null,
    highestWeeklyLimitLabel: null,
    nearestWeeklyResetKey: null,
    nearestWeeklyResetLabel: null,
    hasFreshReading: false,
  }));
  const before = structuredClone(metrics);

  assert.deepEqual(sortWeeklyAccountMetrics(metrics, "source").map((metric) => metric.accountId), ["missing", "a", "b", "early"]);
  assert.deepEqual(sortWeeklyAccountMetrics(metrics, "weekly-usage").map((metric) => metric.accountId), ["a", "b", "early", "missing"]);
  assert.deepEqual(sortWeeklyAccountMetrics(metrics, "weekly-reset").map((metric) => metric.accountId), ["early", "a", "b", "missing"]);
  assert.deepEqual(metrics, before);
});

test("summarizes account count with deterministic usage and reset winners", () => {
  const metrics = deriveWeeklyAccountMetrics(
    [account("later"), account("first"), account("none")],
    {
      later: snapshot({ seven_day: { utilization: 80, resets_at: "2026-08-12T12:00:00.000Z" } }),
      first: snapshot({ seven_day: { utilization: 80, resets_at: "2026-08-12T10:00:00.000Z" } }),
      none: snapshot({}),
    },
    acceptedAt,
  );
  const summary = summarizeWeeklyAccountMetrics(metrics);
  assert.equal(summary.accountCount, 3);
  assert.equal(summary.highestUsage?.accountId, "later");
  assert.equal(summary.nearestReset?.accountId, "first");
  assert.deepEqual(summarizeWeeklyAccountMetrics([]), { accountCount: 0, highestUsage: null, nearestReset: null });
});
