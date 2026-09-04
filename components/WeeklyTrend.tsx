"use client";

// Seven days of weekly usage, one row per account.
//
// A shared line chart with eight overlapping curves is geometry, not a reading: the eye cannot
// tell Claude 4 from ChatGPT 3, and the day labels sit too small to name a Tuesday. Each account
// gets its own strip of seven cells instead. The number in the cell is the weekly-limit percent
// that day; a missing cell is a day the app was not open, not a day of zero usage.

import type { BrowserAccount } from "@/lib/types";
import type { WeeklyTrendSeries } from "@/lib/weekly-history";
import { weeklyTrendFilledDays } from "@/lib/weekly-history";
import { quotaRulerAccountName } from "./QuotaReadings";

export interface WeeklyTrendProps {
  series: readonly WeeklyTrendSeries[];
  days: readonly string[];
  accountsById: ReadonlyMap<string, BrowserAccount>;
  providerOrdinals: ReadonlyMap<string, number>;
}

/**
 * Cell colour follows the account's provider accent, so a row and its card read as the same
 * thing. Severity colours stay on the quota bars: a 90% week is not the same signal as a
 * danger-red five-hour bar.
 */
export function weeklyTrendStroke(provider: BrowserAccount["provider"] | undefined): string {
  if (provider === "openai") return "var(--calibration-blue)";
  if (provider === "grok") return "#b9c6bf";
  return "var(--claude-coral)";
}

/**
 * Split a series into unbroken runs.
 *
 * A missing day is a day the app was not open, not a day of zero usage. Bridging the gap would
 * invent a measurement, so each run stays separate — the cells simply leave the hole empty.
 */
export function weeklyTrendRuns(points: readonly (number | null)[]): { slot: number; percent: number }[][] {
  const runs: { slot: number; percent: number }[][] = [];
  let run: { slot: number; percent: number }[] = [];
  points.forEach((percent, slot) => {
    if (percent === null) {
      if (run.length > 0) runs.push(run);
      run = [];
      return;
    }
    run.push({ slot, percent });
  });
  if (run.length > 0) runs.push(run);
  return runs;
}

export function weeklyTrendDayParts(day: string): { weekday: string; dayOfMonth: string; spoken: string } {
  const [year, month, date] = day.split("-").map(Number);
  const value = new Date(year, month - 1, date);
  return {
    weekday: new Intl.DateTimeFormat("tr-TR", { weekday: "short" }).format(value).replace(/\.$/u, ""),
    dayOfMonth: String(date),
    spoken: new Intl.DateTimeFormat("tr-TR", {
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(value),
  };
}

function cellLabel(spoken: string, percent: number | null): string {
  return percent === null ? `${spoken}: ölçüm yok` : `${spoken}: %${percent}`;
}

export function WeeklyTrend({ series, days, accountsById, providerOrdinals }: WeeklyTrendProps) {
  const drawn = series.filter((entry) => entry.latest !== null);
  if (drawn.length === 0) return null;

  const filledDays = weeklyTrendFilledDays(drawn);
  const captions = days.map(weeklyTrendDayParts);
  const named = drawn.map((entry) => {
    const account = accountsById.get(entry.accountId);
    const ordinal = providerOrdinals.get(entry.accountId);
    return {
      entry,
      name: quotaRulerAccountName(account, ordinal),
      stroke: weeklyTrendStroke(account?.provider),
    };
  });

  return (
    <section className="weekly-trend min-w-0" aria-label="Son 7 günün haftalık kullanımı">
      <div className="weekly-trend-intro">
        <div className="min-w-0">
          <h2 className="weekly-trend-title">Son 7 gün</h2>
          <p className="weekly-trend-hint">
            Her kutu o günün haftalık kota yüzdesi. Boş kutu sıfır kullanım değil: o gün ölçüm yok.
          </p>
        </div>
        {filledDays <= 1 && (
          // Not an error state: one day of data is exactly what the first run looks like, and a
          // single filled cell is meaningless without saying why the other six are empty.
          <p className="weekly-trend-note">Bugünden itibaren birikmeye başladı.</p>
        )}
      </div>

      <ul className="weekly-trend-weekdays" aria-hidden="true">
        <li className="weekly-trend-weekdays-label">Hesap</li>
        {captions.map((caption, index) => (
          <li key={days[index]} className="weekly-trend-weekday">
            <span className="weekly-trend-weekday-date">{caption.dayOfMonth}</span>
            <span className="weekly-trend-weekday-name">{caption.weekday}</span>
          </li>
        ))}
        <li className="weekly-trend-weekdays-label weekly-trend-weekdays-now">Şimdi</li>
      </ul>

      <ul className="weekly-trend-accounts">
        {named.map(({ entry, name, stroke }) => (
          <li key={entry.accountId} className="weekly-trend-account" data-account={entry.accountId}>
            <div className="weekly-trend-account-grid">
              <div className="weekly-trend-account-name">
                <span className="weekly-trend-swatch" style={{ background: stroke }} aria-hidden="true" />
                <span className="min-w-0 truncate">{name}</span>
              </div>
              <ul className="weekly-trend-cells">
                {entry.points.map((percent, slot) => {
                  const empty = percent === null;
                  const spoken = captions[slot]?.spoken ?? days[slot] ?? "";
                  return (
                    <li
                      key={`${entry.accountId}-${days[slot] ?? slot}`}
                      className="weekly-trend-cell"
                      data-empty={empty ? "true" : "false"}
                      aria-label={cellLabel(spoken, percent)}
                    >
                      {!empty && percent > 0 && (
                        <span
                          className="weekly-trend-cell-fill"
                          style={{ height: `max(3px, ${percent}%)`, background: stroke }}
                          aria-hidden="true"
                        />
                      )}
                      <span className="weekly-trend-cell-value">{empty ? "—" : percent}</span>
                    </li>
                  );
                })}
              </ul>
              <p className="weekly-trend-account-now">
                <span className="weekly-trend-account-now-value">%{entry.latest}</span>
                <span className="weekly-trend-account-now-label">şimdi</span>
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
