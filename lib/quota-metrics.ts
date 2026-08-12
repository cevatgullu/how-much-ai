import { extractBars, parseResetTimestamp } from "./format";
import type { AccountSnapshot, BrowserAccount } from "./types";

export type QuotaSortMode = "source" | "weekly-usage" | "weekly-reset";

export interface WeeklyAccountMetric {
  accountId: string;
  sourceIndex: number;
  highestWeeklyUsedPercent: number | null;
  highestWeeklyLimitKey: string | null;
  highestWeeklyLimitLabel: string | null;
  nearestWeeklyResetAt: string | null;
  nearestWeeklyResetKey: string | null;
  nearestWeeklyResetLabel: string | null;
  hasFreshReading: boolean;
}

export interface WeeklyAccountSummary {
  accountCount: number;
  highestUsage: WeeklyAccountMetric | null;
  nearestReset: WeeklyAccountMetric | null;
}

const WEEKLY_KINDS = new Set(["weekly_all", "weekly_oauth_apps", "weekly_scoped"]);

function weeklyTieBreak(a: { kind: string; key: string }, b: { kind: string; key: string }): number {
  const rank = (bar: { kind: string }) => (bar.kind === "weekly_all" ? 0 : bar.kind === "weekly_oauth_apps" ? 1 : 2);
  return rank(a) - rank(b) || a.key.localeCompare(b.key);
}

function sourceTieBreak(a: WeeklyAccountMetric, b: WeeklyAccountMetric): number {
  return a.sourceIndex - b.sourceIndex || a.accountId.localeCompare(b.accountId);
}

function emptyMetric(account: BrowserAccount, sourceIndex: number): WeeklyAccountMetric {
  return {
    accountId: account.id,
    sourceIndex,
    highestWeeklyUsedPercent: null,
    highestWeeklyLimitKey: null,
    highestWeeklyLimitLabel: null,
    nearestWeeklyResetAt: null,
    nearestWeeklyResetKey: null,
    nearestWeeklyResetLabel: null,
    hasFreshReading: false,
  };
}

export function deriveWeeklyAccountMetric(
  account: BrowserAccount,
  snapshot: AccountSnapshot | undefined,
  sourceIndex: number,
  acceptedAt: number,
): WeeklyAccountMetric {
  const metric = emptyMetric(account, sourceIndex);
  if (!snapshot?.usage) return metric;

  const weeklyBars = extractBars(snapshot.usage).filter((bar) => WEEKLY_KINDS.has(bar.kind));
  const highestUsage = [...weeklyBars].sort((a, b) => b.usedPercent - a.usedPercent || weeklyTieBreak(a, b))[0];
  const nearestReset = weeklyBars
    .map((bar) => ({ bar, timestamp: bar.resetsAt === null ? null : parseResetTimestamp(bar.resetsAt) }))
    .filter((candidate): candidate is { bar: (typeof weeklyBars)[number]; timestamp: number } => candidate.timestamp !== null && candidate.timestamp > acceptedAt)
    .sort((a, b) => a.timestamp - b.timestamp || weeklyTieBreak(a.bar, b.bar))[0];

  return {
    ...metric,
    highestWeeklyUsedPercent: highestUsage?.usedPercent ?? null,
    highestWeeklyLimitKey: highestUsage?.key ?? null,
    highestWeeklyLimitLabel: highestUsage?.label ?? null,
    nearestWeeklyResetAt: nearestReset?.bar.resetsAt ?? null,
    nearestWeeklyResetKey: nearestReset?.bar.key ?? null,
    nearestWeeklyResetLabel: nearestReset?.bar.label ?? null,
    hasFreshReading: snapshot.status === "ready" && snapshot.stale !== true,
  };
}

export function deriveWeeklyAccountMetrics(
  accounts: readonly BrowserAccount[],
  snapshots: Readonly<Record<string, AccountSnapshot>>,
  acceptedAt: number,
): WeeklyAccountMetric[] {
  return accounts.map((account, sourceIndex) => deriveWeeklyAccountMetric(account, snapshots[account.id], sourceIndex, acceptedAt));
}

export function sortWeeklyAccountMetrics(
  metrics: readonly WeeklyAccountMetric[],
  mode: QuotaSortMode,
): WeeklyAccountMetric[] {
  return [...metrics].sort((a, b) => {
    if (mode === "source") return sourceTieBreak(a, b);
    if (mode === "weekly-usage") {
      if (a.highestWeeklyUsedPercent === null) return b.highestWeeklyUsedPercent === null ? sourceTieBreak(a, b) : 1;
      if (b.highestWeeklyUsedPercent === null) return -1;
      return b.highestWeeklyUsedPercent - a.highestWeeklyUsedPercent || sourceTieBreak(a, b);
    }

    const aTimestamp = a.nearestWeeklyResetAt === null ? null : parseResetTimestamp(a.nearestWeeklyResetAt);
    const bTimestamp = b.nearestWeeklyResetAt === null ? null : parseResetTimestamp(b.nearestWeeklyResetAt);
    if (aTimestamp === null) return bTimestamp === null ? sourceTieBreak(a, b) : 1;
    if (bTimestamp === null) return -1;
    return aTimestamp - bTimestamp || sourceTieBreak(a, b);
  });
}

export function summarizeWeeklyAccountMetrics(metrics: readonly WeeklyAccountMetric[]): WeeklyAccountSummary {
  const highestUsage = sortWeeklyAccountMetrics(metrics, "weekly-usage").find((metric) => metric.highestWeeklyUsedPercent !== null) ?? null;
  const nearestReset = sortWeeklyAccountMetrics(metrics, "weekly-reset").find((metric) => metric.nearestWeeklyResetAt !== null) ?? null;
  return { accountCount: metrics.length, highestUsage, nearestReset };
}
