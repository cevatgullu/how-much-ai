import assert from "node:assert/strict";
import { test } from "node:test";
import "./providers/_resolve-ts.mjs";
import type { WeeklyAccountMetric } from "./quota-metrics";

const {
  dashboardOrderReducer,
  initialDashboardOrderState,
  resolvedDashboardOrder,
} = await import("./dashboard-order-state.ts");

function metric(
  accountId: string,
  sourceIndex: number,
  highestWeeklyUsedPercent: number | null,
  nearestWeeklyResetAt: string | null,
): WeeklyAccountMetric {
  return {
    accountId,
    sourceIndex,
    highestWeeklyUsedPercent,
    highestWeeklyLimitKey: null,
    highestWeeklyLimitLabel: null,
    nearestWeeklyResetAt,
    nearestWeeklyResetKey: null,
    nearestWeeklyResetLabel: null,
    hasFreshReading: true,
  };
}

test("keeps vault order visible until every account in a batch settles", () => {
  let state = initialDashboardOrderState(["a", "b", "c"], "source");
  const before = structuredClone(state);

  state = dashboardOrderReducer(state, { type: "batch_started", accountIds: ["a", "b", "c"] });
  state = dashboardOrderReducer(state, { type: "account_settled", accountId: "b" });
  state = dashboardOrderReducer(state, { type: "candidate_order", accountIds: ["c", "b", "a"], acceptedEpoch: 101 });

  assert.deepEqual(state.visibleAccountIds, ["a", "b", "c"]);
  assert.deepEqual(state.unsettledAccountIds, ["a", "c"]);
  assert.equal(state.pendingAccountIds, null);
  assert.equal(state.acceptedEpoch, 0);
  assert.deepEqual(before.visibleAccountIds, ["a", "b", "c"]);

  state = dashboardOrderReducer(state, { type: "account_settled", accountId: "a" });
  state = dashboardOrderReducer(state, { type: "account_settled", accountId: "c" });
  state = dashboardOrderReducer(state, { type: "candidate_order", accountIds: ["c", "b", "a"], acceptedEpoch: 102 });

  assert.deepEqual(state.visibleAccountIds, ["c", "b", "a"]);
  assert.equal(state.pendingAccountIds, null);
  assert.equal(state.acceptedEpoch, 102);
});

test("settles a one-account refresh before accepting its candidate order", () => {
  let state = initialDashboardOrderState(["a", "b"], "weekly-usage");
  state = dashboardOrderReducer(state, { type: "batch_started", accountIds: ["a"] });
  state = dashboardOrderReducer(state, { type: "candidate_order", accountIds: ["b", "a"], acceptedEpoch: 10 });

  assert.deepEqual(state.visibleAccountIds, ["a", "b"]);

  state = dashboardOrderReducer(state, { type: "account_settled", accountId: "a" });
  state = dashboardOrderReducer(state, { type: "candidate_order", accountIds: ["b", "a"], acceptedEpoch: 11 });

  assert.deepEqual(state.visibleAccountIds, ["b", "a"]);
  assert.equal(state.acceptedEpoch, 11);
});

test("defers an accepted candidate until both focus and pointer fences leave", () => {
  let state = initialDashboardOrderState(["a", "b", "c"], "weekly-reset");
  state = dashboardOrderReducer(state, { type: "interaction_enter", accountId: "a", channel: "focus" });
  state = dashboardOrderReducer(state, { type: "interaction_enter", accountId: "b", channel: "pointer" });
  state = dashboardOrderReducer(state, { type: "candidate_order", accountIds: ["c", "b", "a"], acceptedEpoch: 20 });

  assert.deepEqual(state.visibleAccountIds, ["a", "b", "c"]);
  assert.deepEqual(state.pendingAccountIds, ["c", "b", "a"]);
  assert.deepEqual(state.focusAccountIds, ["a"]);
  assert.deepEqual(state.pointerAccountIds, ["b"]);
  assert.equal(state.acceptedEpoch, 20);

  state = dashboardOrderReducer(state, { type: "interaction_leave", accountId: "a", channel: "focus" });
  assert.deepEqual(state.visibleAccountIds, ["a", "b", "c"]);

  state = dashboardOrderReducer(state, { type: "interaction_leave", accountId: "b", channel: "pointer" });
  assert.deepEqual(state.visibleAccountIds, ["c", "b", "a"]);
  assert.equal(state.pendingAccountIds, null);
});

test("ignores a candidate order from an older accepted epoch", () => {
  let state = initialDashboardOrderState(["a", "b", "c"], "weekly-usage");
  state = dashboardOrderReducer(state, { type: "candidate_order", accountIds: ["c", "b", "a"], acceptedEpoch: 102 });
  state = dashboardOrderReducer(state, { type: "candidate_order", accountIds: ["b", "a", "c"], acceptedEpoch: 101 });

  assert.deepEqual(state.visibleAccountIds, ["c", "b", "a"]);
  assert.equal(state.acceptedEpoch, 102);
});

test("keeps a newer fenced candidate when an older candidate arrives", () => {
  let state = initialDashboardOrderState(["a", "b", "c"], "weekly-usage");
  state = dashboardOrderReducer(state, { type: "interaction_enter", accountId: "a", channel: "focus" });
  state = dashboardOrderReducer(state, { type: "candidate_order", accountIds: ["c", "b", "a"], acceptedEpoch: 102 });
  state = dashboardOrderReducer(state, { type: "candidate_order", accountIds: ["b", "a", "c"], acceptedEpoch: 101 });

  assert.deepEqual(state.pendingAccountIds, ["c", "b", "a"]);
  assert.equal(state.acceptedEpoch, 102);

  state = dashboardOrderReducer(state, { type: "interaction_leave", accountId: "a", channel: "focus" });
  assert.deepEqual(state.visibleAccountIds, ["c", "b", "a"]);
});

test("changes sort mode through the same interaction fence", () => {
  let state = initialDashboardOrderState(["a", "b"], "source");
  state = dashboardOrderReducer(state, { type: "interaction_enter", accountId: "a", channel: "focus" });
  state = dashboardOrderReducer(state, { type: "sort_changed", mode: "weekly-usage", accountIds: ["b", "a"] });

  assert.equal(state.mode, "weekly-usage");
  assert.deepEqual(state.visibleAccountIds, ["a", "b"]);
  assert.deepEqual(state.pendingAccountIds, ["b", "a"]);

  state = dashboardOrderReducer(state, { type: "interaction_leave", accountId: "a", channel: "focus" });
  assert.deepEqual(state.visibleAccountIds, ["b", "a"]);
});

test("removes deleted ids and appends added ids in vault order across all fences", () => {
  let state = initialDashboardOrderState(["a", "b", "c"], "weekly-usage");
  state = dashboardOrderReducer(state, { type: "interaction_enter", accountId: "b", channel: "focus" });
  state = dashboardOrderReducer(state, { type: "interaction_enter", accountId: "c", channel: "pointer" });
  state = dashboardOrderReducer(state, { type: "candidate_order", accountIds: ["c", "b", "a"], acceptedEpoch: 30 });
  state = dashboardOrderReducer(state, { type: "batch_started", accountIds: ["a", "b", "c"] });
  state = dashboardOrderReducer(state, { type: "accounts_changed", accountIds: ["b", "d"] });

  assert.deepEqual(state.visibleAccountIds, ["b", "d"]);
  assert.deepEqual(state.pendingAccountIds, ["b", "d"]);
  assert.deepEqual(state.unsettledAccountIds, ["b"]);
  assert.deepEqual(state.focusAccountIds, ["b"]);
  assert.deepEqual(state.pointerAccountIds, []);
});

test("resolves metric ids without mutating metrics and leaves expanded ids external to reorder", () => {
  const metrics = [
    metric("source-first", 0, 55, "2026-08-12T12:00:00.000Z"),
    metric("usage-first", 1, 80, "2026-08-12T11:00:00.000Z"),
    metric("missing", 2, null, null),
  ];
  const before = structuredClone(metrics);
  const expandedAccountIds = new Set(["source-first"]);

  assert.deepEqual(resolvedDashboardOrder(metrics, "source"), ["source-first", "usage-first", "missing"]);
  assert.deepEqual(resolvedDashboardOrder(metrics, "weekly-usage"), ["usage-first", "source-first", "missing"]);
  assert.deepEqual(resolvedDashboardOrder(metrics, "weekly-reset"), ["usage-first", "source-first", "missing"]);
  assert.deepEqual(metrics, before);
  assert.deepEqual([...expandedAccountIds], ["source-first"]);
});
