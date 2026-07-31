import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REMAINING_BOUNDARIES,
  diffLocalLimit,
  formatLocalLimitNotification,
  type LocalLimitReading,
  type LocalLimitState,
  type RemainingBoundary,
} from "./local-notify-detect.ts";

const T1 = "2026-07-31T10:00:00.000Z";
const T2 = "2026-07-31T15:00:00.000Z";
const RULES_ON = { remainingWarnings: true, resetNotifications: true };

function reading(overrides: Partial<LocalLimitReading> = {}): LocalLimitReading {
  return {
    limitKey: "session",
    usedPercent: 40,
    remainingPercent: 60,
    resetsAt: T1,
    ...overrides,
  };
}

function at(remainingPercent: number, resetsAt = T1): LocalLimitReading {
  return reading({ remainingPercent, usedPercent: 100 - remainingPercent, resetsAt });
}

function event(state: LocalLimitState | undefined, next: LocalLimitReading) {
  return diffLocalLimit(state, next, RULES_ON);
}

test("each remaining boundary fires once when crossed and then advances its cursor", () => {
  for (const boundary of REMAINING_BOUNDARIES) {
    const seeded = event(undefined, at(boundary + 1));
    assert.equal(seeded.kind, "seed", `seed ${boundary}`);
    assert.equal(seeded.event, null, `silent seed ${boundary}`);

    const crossed = event(seeded.nextState, at(boundary));
    assert.deepEqual(crossed.event, { type: "threshold", boundary }, `cross ${boundary}`);

    const repeated = event(crossed.nextState, at(boundary));
    assert.equal(repeated.event, null, `repeat ${boundary}`);
  }
});

test("does not emit above the first boundary", () => {
  const seeded = event(undefined, at(60));
  const result = event(seeded.nextState, at(51));
  assert.equal(result.event, null);
  assert.equal(result.nextState.nextBoundaryIndex, 0);
});

test("a multi-boundary jump emits only the tightest crossed boundary", () => {
  const seeded = event(undefined, at(49));
  const jumped = event(seeded.nextState, at(9));
  assert.deepEqual(jumped.event, { type: "threshold", boundary: 10 });
  assert.equal(jumped.nextState.nextBoundaryIndex, 6);
  assert.deepEqual(event(jumped.nextState, at(5)).event, { type: "threshold", boundary: 5 });
});

test("first observation at five remaining is silent and cannot replay that threshold", () => {
  const seeded = event(undefined, at(5));
  assert.equal(seeded.event, null);
  assert.equal(seeded.nextState.nextBoundaryIndex, 7);
  assert.equal(event(seeded.nextState, at(5)).event, null);
});

test("zero remaining formats as a limit exhausted notification", () => {
  const seeded = event(undefined, at(1));
  const exhausted = event(seeded.nextState, at(0));
  assert.deepEqual(exhausted.event, { type: "threshold", boundary: 0 });
  assert.deepEqual(formatLocalLimitNotification(exhausted.event!, "Kişisel", "Oturum"), {
    title: "How Much AI",
    body: "Kişisel • Oturum: limit bitti.",
  });
});

test("a strictly later valid reset timestamp emits only a reset and seeds its new window", () => {
  const seeded = event(undefined, at(49));
  const reset = event(seeded.nextState, at(0, T2));
  assert.deepEqual(reset.event, { type: "reset" });
  assert.equal(reset.nextState.lastResetAt, T2);
  assert.equal(reset.nextState.nextBoundaryIndex, 8);
  assert.deepEqual(formatLocalLimitNotification(reset.event!, "Kişisel", "Oturum"), {
    title: "How Much AI",
    body: "Kişisel • Oturum: limit sıfırlandı.",
  });
});

test("a null timestamp still advances thresholds but cannot reset", () => {
  const seeded = event(undefined, at(51, null));
  const threshold = event(seeded.nextState, at(50, null));
  assert.deepEqual(threshold.event, { type: "threshold", boundary: 50 });
  assert.equal(threshold.nextState.lastResetAt, null);
});

test("the first valid timestamp after null is adopted without a reset", () => {
  const seeded = event(undefined, at(51, null));
  const adopted = event(seeded.nextState, at(49, T1));
  assert.deepEqual(adopted.event, { type: "threshold", boundary: 50 });
  assert.equal(adopted.nextState.lastResetAt, T1);
});

test("invalid, equal, and older timestamps do not reset or regress the stored timestamp", () => {
  const initial = event(undefined, at(51, T2));
  for (const stamp of ["not-a-date", T2, T1]) {
    const result = event(initial.nextState, at(50, stamp));
    assert.deepEqual(result.event, { type: "threshold", boundary: 50 }, stamp);
    assert.equal(result.nextState.lastResetAt, T2, stamp);
  }
});

test("a malformed calendar timestamp cannot normalize into a reset", () => {
  const initial = event(undefined, at(51, "2026-02-01T10:00:00.000Z"));
  const malformed = event(initial.nextState, at(50, "2026-02-30T10:00:00.000Z"));
  assert.deepEqual(malformed.event, { type: "threshold", boundary: 50 });
  assert.equal(malformed.nextState.lastResetAt, "2026-02-01T10:00:00.000Z");
});

test("a utilization drop without a reset does not re-arm a crossed boundary", () => {
  const seeded = event(undefined, at(51));
  const crossed = event(seeded.nextState, at(50));
  const recovered = event(crossed.nextState, at(60));
  const recrossed = event(recovered.nextState, at(50));
  assert.equal(recrossed.event, null);
});

test("disabled rules advance state silently and cannot replay history when re-enabled", () => {
  const seeded = event(undefined, at(51));
  const silentThreshold = diffLocalLimit(seeded.nextState, at(40), {
    remainingWarnings: false,
    resetNotifications: false,
  });
  assert.equal(silentThreshold.event, null);
  assert.equal(silentThreshold.nextState.nextBoundaryIndex, 2);
  assert.equal(event(silentThreshold.nextState, at(40)).event, null);

  const silentReset = diffLocalLimit(silentThreshold.nextState, at(60, T2), {
    remainingWarnings: true,
    resetNotifications: false,
  });
  assert.equal(silentReset.event, null);
  assert.equal(silentReset.nextState.lastResetAt, T2);
  assert.equal(event(silentReset.nextState, at(40, T2)).event?.type, "threshold");
});

test("four caller-owned account and limit state machines remain independent", () => {
  const states = new Map<string, LocalLimitState | undefined>();
  const keys = ["a:session", "a:weekly", "b:session", "b:weekly"];
  for (const key of keys) states.set(key, event(undefined, at(51)).nextState);

  for (const key of keys) {
    const result = event(states.get(key), reading({ limitKey: key, remainingPercent: 50, usedPercent: 50 }));
    assert.deepEqual(result.event, { type: "threshold", boundary: 50 as RemainingBoundary });
    states.set(key, result.nextState);
  }
  for (const key of keys) assert.equal(event(states.get(key), at(50)).event, null);
});
