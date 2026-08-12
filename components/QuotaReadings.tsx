"use client";

import type { WeeklyAccountMetric, WeeklyAccountSummary } from "@/lib/quota-metrics";
import type { BrowserAccount } from "@/lib/types";
import { accountDisplayName } from "./AccountCard";

export interface QuotaReadingsProps {
  summary: WeeklyAccountSummary;
  accountsById: ReadonlyMap<string, BrowserAccount>;
  providerOrdinals: ReadonlyMap<string, number>;
}

export function quotaRulerAccountName(
  account: BrowserAccount | undefined,
  providerOrdinal: number | undefined,
): string {
  if (!account) return "Hesap";
  const displayName = accountDisplayName(account).trim();
  if (displayName && displayName !== account.email) return displayName;
  return `${account.provider === "openai" ? "ChatGPT" : "Claude"} ${providerOrdinal ?? 1}`;
}

function metricAccountName(
  metric: WeeklyAccountMetric | null,
  accountsById: ReadonlyMap<string, BrowserAccount>,
  providerOrdinals: ReadonlyMap<string, number>,
): string {
  if (!metric) return "—";
  return quotaRulerAccountName(accountsById.get(metric.accountId), providerOrdinals.get(metric.accountId));
}

export function QuotaReadings({ summary, accountsById, providerOrdinals }: QuotaReadingsProps) {
  const highest = summary.highestUsage;
  const nearest = summary.nearestReset;
  return (
    <dl className="quota-readings grid min-w-0 gap-3" aria-label="Kota özeti">
      <div className="min-w-0 border-t border-border pt-2">
        <dt className="text-xs text-faint">Hesap</dt>
        <dd className="font-mono text-lg tabular-nums text-ivory">{summary.accountCount}</dd>
      </div>
      <div className="min-w-0 border-t border-border pt-2">
        <dt className="text-xs text-faint">En yüksek haftalık kullanım</dt>
        <dd className="min-w-0 text-sm text-ivory">
          {highest ? (
            <>
              <span>{metricAccountName(highest, accountsById, providerOrdinals)}</span>{" "}
              <span className="font-mono tabular-nums">%{Math.round(highest.highestWeeklyUsedPercent ?? 0)}</span>{" "}
              <span className="text-faint">{highest.highestWeeklyLimitLabel ?? "Haftalık limit"}</span>
            </>
          ) : "—"}
        </dd>
      </div>
      <div className="min-w-0 border-t border-border pt-2">
        <dt className="text-xs text-faint">En yakın haftalık yenilenme</dt>
        <dd className="min-w-0 text-sm text-ivory">
          {nearest ? (
            <>
              <span>{metricAccountName(nearest, accountsById, providerOrdinals)}</span>{" "}
              <span className="text-faint">{nearest.nearestWeeklyResetLabel ?? "Haftalık limit"}</span>{" "}
              {nearest.nearestWeeklyResetAt ? (
                <time className="font-mono text-xs tabular-nums" dateTime={nearest.nearestWeeklyResetAt}>
                  {nearest.nearestWeeklyResetAt}
                </time>
              ) : null}
            </>
          ) : "—"}
        </dd>
      </div>
    </dl>
  );
}
