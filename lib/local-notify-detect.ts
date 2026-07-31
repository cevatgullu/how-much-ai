// @ts-expect-error Node's direct TypeScript test runner needs the source extension.
import { parseResetTimestamp } from "./format.ts";

export const REMAINING_BOUNDARIES = [50, 40, 30, 20, 15, 10, 5, 0] as const;
export type RemainingBoundary = (typeof REMAINING_BOUNDARIES)[number];

export interface LocalNotifyRules {
  remainingWarnings: boolean;
  resetNotifications: boolean;
}

export interface LocalLimitReading {
  limitKey: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
}

export interface LocalLimitState {
  lastResetAt: string | null;
  nextBoundaryIndex: number;
  lastObservedUtilization: number;
}

export type LocalLimitEvent =
  | { type: "threshold"; boundary: RemainingBoundary }
  | { type: "reset" };

export type LocalLimitDiff =
  | { kind: "ignore"; nextState: null; event: null }
  | { kind: "seed" | "advance"; nextState: LocalLimitState; event: null }
  | { kind: "event"; nextState: LocalLimitState; event: LocalLimitEvent };

function crossedBoundaryIndex(remaining: number): number {
  let crossed = -1;
  for (let index = 0; index < REMAINING_BOUNDARIES.length; index += 1) {
    if (remaining <= REMAINING_BOUNDARIES[index]) crossed = index;
  }
  return crossed;
}

function timestampMs(timestamp: string | null): number {
  return timestamp === null ? Number.NaN : (parseResetTimestamp(timestamp) ?? Number.NaN);
}

function stateFor(reading: LocalLimitReading, lastResetAt: string | null, nextBoundaryIndex: number): LocalLimitState {
  return {
    lastResetAt,
    nextBoundaryIndex,
    lastObservedUtilization: reading.usedPercent,
  };
}

export function diffLocalLimit(
  previous: LocalLimitState | undefined,
  reading: LocalLimitReading,
  rules: LocalNotifyRules,
): LocalLimitDiff {
  const crossed = crossedBoundaryIndex(reading.remainingPercent);
  const seededCursor = crossed + 1;
  const currentMs = timestampMs(reading.resetsAt);

  if (!previous) {
    return {
      kind: "seed",
      nextState: stateFor(reading, Number.isNaN(currentMs) ? null : reading.resetsAt, seededCursor),
      event: null,
    };
  }

  const previousMs = timestampMs(previous.lastResetAt);
  const isReset = !Number.isNaN(previousMs) && !Number.isNaN(currentMs) && currentMs > previousMs;
  if (isReset) {
    const nextState = stateFor(reading, reading.resetsAt, seededCursor);
    return rules.resetNotifications
      ? { kind: "event", nextState, event: { type: "reset" } }
      : { kind: "advance", nextState, event: null };
  }

  const lastResetAt =
    !Number.isNaN(currentMs) && Number.isNaN(previousMs) ? reading.resetsAt : previous.lastResetAt;
  const nextBoundaryIndex = Math.max(previous.nextBoundaryIndex, seededCursor);
  const nextState = stateFor(reading, lastResetAt, nextBoundaryIndex);

  if (crossed >= 0 && crossed >= previous.nextBoundaryIndex && rules.remainingWarnings) {
    return {
      kind: "event",
      nextState,
      event: { type: "threshold", boundary: REMAINING_BOUNDARIES[crossed] },
    };
  }

  return { kind: "advance", nextState, event: null };
}

export function formatLocalLimitNotification(
  event: LocalLimitEvent,
  accountLabel: string,
  limitLabel: string,
): { title: "How Much AI"; body: string } {
  if (event.type === "reset") {
    return { title: "How Much AI", body: accountLabel + " • " + limitLabel + ": limit sıfırlandı." };
  }
  if (event.boundary === 0) {
    return { title: "How Much AI", body: accountLabel + " • " + limitLabel + ": limit bitti." };
  }
  return {
    title: "How Much AI",
    body: accountLabel + " • " + limitLabel + ": %" + event.boundary + " kaldı.",
  };
}
