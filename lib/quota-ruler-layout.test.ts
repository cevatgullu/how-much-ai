import assert from "node:assert/strict";
import { test } from "node:test";
import "./providers/_resolve-ts.mjs";
import type { RulerMarkerInput } from "./quota-ruler-layout.ts";

const { placeQuotaRulerMarkers, stableRulerClusterId } = await import("./quota-ruler-layout.ts");

function marker(
  accountId: string,
  sourceIndex: number,
  usedPercent: number,
  labelWidth = 80,
): RulerMarkerInput {
  return { accountId, sourceIndex, usedPercent, labelWidth };
}

test("places boundary and calibration markers inside the track with an 8px gap and at most three lanes", () => {
  const markers = [
    marker("zero", 0, 0, 40),
    marker("quarter", 1, 25, 40),
    marker("half", 2, 50, 40),
    marker("warning", 3, 85, 40),
    marker("full", 4, 100, 40),
  ];

  const result = placeQuotaRulerMarkers(markers, 400);

  assert.deepEqual(
    result.placements.map(({ accountId, centerX, left, lane }) => ({ accountId, centerX, left, lane })),
    [
      { accountId: "zero", centerX: 0, left: 0, lane: 0 },
      { accountId: "quarter", centerX: 100, left: 80, lane: 0 },
      { accountId: "half", centerX: 200, left: 180, lane: 0 },
      { accountId: "warning", centerX: 340, left: 320, lane: 0 },
      { accountId: "full", centerX: 400, left: 360, lane: 1 },
    ],
  );
  assert.deepEqual(result.clusters, []);
  assert.ok(result.placements.every((placement) => placement.left >= 0));
  assert.ok(result.placements.every((placement) => placement.left + placement.labelWidth <= 400));
  assert.ok(result.placements.every((placement) => placement.lane >= 0 && placement.lane <= 2));
});

test("clamps percentages and label boxes in pixel space without changing the marker values", () => {
  const markers = [
    marker("below", 0, -20, 500),
    marker("middle", 1, 50, 32),
    marker("above", 2, 120, 500),
  ];

  const result = placeQuotaRulerMarkers(markers, 104);

  assert.deepEqual(
    result.placements.map(({ accountId, usedPercent, centerX, left, labelWidth, lane }) => ({
      accountId,
      usedPercent,
      centerX,
      left,
      labelWidth,
      lane,
    })),
    [
      { accountId: "below", usedPercent: -20, centerX: 0, left: 0, labelWidth: 104, lane: 0 },
      { accountId: "middle", usedPercent: 50, centerX: 52, left: 36, labelWidth: 32, lane: 1 },
      { accountId: "above", usedPercent: 120, centerX: 104, left: 0, labelWidth: 104, lane: 2 },
    ],
  );
});

test("uses three lanes for equal percentages and clusters the remaining long Turkish labels", () => {
  const markers = Array.from({ length: 12 }, (_, sourceIndex) =>
    marker(`hesap-${String(sourceIndex).padStart(2, "0")}`, sourceIndex, 50, 180),
  );

  const result = placeQuotaRulerMarkers(markers, 240);

  assert.deepEqual(result.placements.map(({ accountId, lane }) => [accountId, lane]), [
    ["hesap-00", 0],
    ["hesap-01", 1],
    ["hesap-02", 2],
  ]);
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0]?.centerX, 120);
  assert.deepEqual(
    result.clusters[0]?.members.map(({ accountId }) => accountId),
    markers.slice(3).map(({ accountId }) => accountId),
  );
  assert.match(result.clusters[0]?.id ?? "", /^ruler-cluster-[a-z0-9]+$/);
});

test("orders dense seven-marker clusters by percentage, then source index and account id", () => {
  const markers = [
    marker("z", 4, 51),
    marker("b", 1, 50),
    marker("a", 1, 50),
    marker("early", 0, 48),
    marker("late", 8, 53),
    marker("middle", 3, 49),
    marker("near", 5, 52),
  ];

  const result = placeQuotaRulerMarkers(markers, 200);

  assert.deepEqual(result.placements.map(({ accountId, lane }) => [accountId, lane]), [
    ["early", 0],
    ["middle", 1],
    ["a", 2],
  ]);
  assert.deepEqual(result.clusters.map((cluster) => cluster.members.map(({ accountId }) => accountId)), [
    ["b", "z", "near", "late"],
  ]);
});

test("returns deterministic output and never mutates marker input", () => {
  const markers = [
    marker("gamma", 2, 50, 160),
    marker("alpha", 0, 50, 160),
    marker("beta", 1, 50, 160),
    marker("delta", 3, 50, 160),
  ];
  const before = structuredClone(markers);

  const first = placeQuotaRulerMarkers(markers, 200);
  const second = placeQuotaRulerMarkers([...markers].reverse(), 200);

  assert.deepEqual(first, second);
  assert.deepEqual(markers, before);
});

test("hashes only canonical opaque account ids and source indices with browser-safe output", () => {
  const members = [marker("opaque-b", 2, 85, 180), marker("opaque-a", 1, 50, 90)];
  const changedMeasurements = [marker("opaque-a", 1, 0, 12), marker("opaque-b", 2, 100, 300)];

  const id = stableRulerClusterId(members);

  assert.match(id, /^ruler-cluster-[a-z0-9]+$/);
  assert.equal(id, stableRulerClusterId([...members].reverse()));
  assert.equal(id, stableRulerClusterId(changedMeasurements));
  assert.notEqual(id, stableRulerClusterId([marker("opaque-a", 1, 0, 12), marker("opaque-c", 2, 100, 300)]));
});
