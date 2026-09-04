"use client";

import type { WeeklyAccountMetric, WeeklyAccountSummary } from "@/lib/quota-metrics";
import type { BrowserAccount } from "@/lib/types";
import { formatResetSchedule } from "@/lib/format";
import { accountDisplayName } from "./AccountCard";
import { providerMeta } from "./providers-ui";

export interface QuotaReadingsProps {
  summary: WeeklyAccountSummary;
  accountsById: ReadonlyMap<string, BrowserAccount>;
  providerOrdinals: ReadonlyMap<string, number>;
  now: number;
}

export function quotaRulerAccountName(
  account: BrowserAccount | undefined,
  providerOrdinal: number | undefined,
): string {
  if (!account) return "Hesap";
  const displayName = accountDisplayName(account).trim();
  if (displayName && displayName !== account.email) return displayName;
  // Read the label from the provider registry rather than branching on two ids: the old
  // `openai ? "ChatGPT" : "Claude"` sent every other provider to "Claude", so a Grok account
  // appeared as a second "Claude 1" on the ruler and in the summary.
  return `${providerMeta(account.provider).label} ${providerOrdinal ?? 1}`;
}

function metricAccountName(
  metric: WeeklyAccountMetric | null,
  accountsById: ReadonlyMap<string, BrowserAccount>,
  providerOrdinals: ReadonlyMap<string, number>,
): string {
  if (!metric) return "—";
  return quotaRulerAccountName(accountsById.get(metric.accountId), providerOrdinals.get(metric.accountId));
}

export function QuotaReadings({ summary, accountsById, providerOrdinals, now }: QuotaReadingsProps) {
  const highest = summary.highestUsage;
  const nearest = summary.nearestReset;
  const nearestSchedule = formatResetSchedule(nearest?.nearestWeeklyResetAt ?? null, now);
  return (
    <dl className="quota-readings min-w-0" aria-label="Kota özeti">
      <div className="quota-reading">
        <dt>Hesap</dt>
        <dd className="quota-reading-value tabular-nums">{summary.accountCount}</dd>
      </div>
      <div className="quota-reading">
        <dt>En yüksek haftalık kullanım</dt>
        <dd className="min-w-0 text-sm">
          {highest ? (
            <>
              <span>{metricAccountName(highest, accountsById, providerOrdinals)}</span>{" "}
              <span className="font-mono tabular-nums">%{Math.round(highest.highestWeeklyUsedPercent ?? 0)}</span>{" "}
              <span className="text-faint">{highest.highestWeeklyLimitLabel ?? "Haftalık limit"}</span>
            </>
          ) : "—"}
        </dd>
      </div>
      <div className="quota-reading">
        <dt>En yakın haftalık yenilenme</dt>
        <dd className="min-w-0 text-sm">
          {nearest ? (
            <>
              <span>{metricAccountName(nearest, accountsById, providerOrdinals)}</span>{" "}
              <span className="text-faint">{nearest.nearestWeeklyResetLabel ?? "Haftalık limit"}</span>{" "}
              {nearest.nearestWeeklyResetAt && nearestSchedule ? (
                <time className="font-mono text-xs tabular-nums" dateTime={nearest.nearestWeeklyResetAt}>
                  {nearestSchedule.state === "past"
                    ? "yenilenme verisi bekleniyor"
                    : `${nearestSchedule.countdown} · ${nearestSchedule.exact}`}
                </time>
              ) : null}
            </>
          ) : "—"}
        </dd>
      </div>
    </dl>
  );
}
