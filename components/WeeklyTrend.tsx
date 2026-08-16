"use client";

// Seven days of weekly usage, drawn as inline SVG.
//
// No charting library. One polyline per account over a fixed 0–100 scale is the whole requirement,
// and every library that draws it also brings a layout engine, a tooltip system, and a bundle
// larger than this page. The viewBox is fixed and the element is width-fluid, so the geometry is
// computed once and the browser scales it — which also means the same markup renders identically
// server-side, where there is no layout to measure.

import type { BrowserAccount } from "@/lib/types";
import type { WeeklyTrendSeries } from "@/lib/weekly-history";
import { WEEKLY_TREND_DAYS, weeklyTrendFilledDays } from "@/lib/weekly-history";
import { quotaRulerAccountName } from "./QuotaReadings";

const VIEW_WIDTH = 336;
const VIEW_HEIGHT = 108;
const PAD_X = 6;
const PAD_TOP = 8;
const PAD_BOTTOM = 10;
const PLOT_HEIGHT = VIEW_HEIGHT - PAD_TOP - PAD_BOTTOM;

export interface WeeklyTrendProps {
  series: readonly WeeklyTrendSeries[];
  days: readonly string[];
  accountsById: ReadonlyMap<string, BrowserAccount>;
  providerOrdinals: ReadonlyMap<string, number>;
}

/**
 * Line colour follows the account's provider accent, so a curve and its card read as the same
 * thing. Two accounts on one provider share the hue and separate by dash pattern instead — a
 * per-account palette would collide with the severity colours the bars already own.
 */
export function weeklyTrendStroke(provider: BrowserAccount["provider"] | undefined): string {
  if (provider === "openai") return "var(--calibration-blue)";
  if (provider === "grok") return "#b9c6bf";
  return "var(--claude-coral)";
}

const DASHES = ["", "5 3", "2 3", "8 3 2 3"];

export function weeklyTrendDash(providerOrdinal: number): string | undefined {
  return DASHES[(Math.max(1, providerOrdinal) - 1) % DASHES.length] || undefined;
}

function slotX(slot: number): number {
  return PAD_X + ((VIEW_WIDTH - PAD_X * 2) * slot) / (WEEKLY_TREND_DAYS - 1);
}

function percentY(percent: number): number {
  return PAD_TOP + PLOT_HEIGHT * (1 - Math.max(0, Math.min(100, percent)) / 100);
}

/**
 * Split a series into unbroken runs.
 *
 * A missing day is a day the app was not open, not a day of zero usage. Bridging the gap with a
 * straight line would draw usage that was never measured, so each run is its own polyline and the
 * gap simply shows.
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

function dayLabel(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("tr-TR", { weekday: "short" }).format(new Date(year, month - 1, date));
}

export function WeeklyTrend({ series, days, accountsById, providerOrdinals }: WeeklyTrendProps) {
  const drawn = series.filter((entry) => entry.latest !== null);
  if (drawn.length === 0) return null;

  const filledDays = weeklyTrendFilledDays(drawn);
  const named = drawn.map((entry) => {
    const account = accountsById.get(entry.accountId);
    const ordinal = providerOrdinals.get(entry.accountId);
    return {
      entry,
      account,
      name: quotaRulerAccountName(account, ordinal),
      stroke: weeklyTrendStroke(account?.provider),
      dash: weeklyTrendDash(ordinal ?? 1),
    };
  });

  return (
    <section className="weekly-trend min-w-0" aria-label="7 günlük haftalık kullanım eğrisi">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-xs text-faint">7 günlük haftalık kullanım</h2>
        {filledDays <= 1 && (
          // Not an error state: one day of data is exactly what the first run looks like, and the
          // single dot below is meaningless without saying why there is no line yet.
          <p className="text-[11px] text-faint">Bugünden itibaren birikmeye başladı.</p>
        )}
      </div>

      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        className="weekly-trend-plot mt-2 w-full"
        role="img"
        aria-label={named
          .map(({ name, entry }) => `${name}: %${entry.latest}`)
          .join(", ")}
      >
        {[0, 50, 100].map((percent) => (
          <line
            key={percent}
            x1={PAD_X}
            x2={VIEW_WIDTH - PAD_X}
            y1={percentY(percent)}
            y2={percentY(percent)}
            className="weekly-trend-grid"
          />
        ))}
        {named.map(({ entry, name, stroke, dash }) => (
          <g key={entry.accountId} data-account={entry.accountId}>
            <title>{name}</title>
            {weeklyTrendRuns(entry.points).map((run) =>
              // A run of one has no line to draw, so the day is marked as a dot instead — which is
              // also exactly what the very first day of collection looks like.
              run.length === 1 ? (
                <circle
                  key={`${entry.accountId}-${run[0].slot}`}
                  cx={slotX(run[0].slot)}
                  cy={percentY(run[0].percent)}
                  r="2.8"
                  fill={stroke}
                />
              ) : (
                <polyline
                  key={`${entry.accountId}-${run[0].slot}`}
                  fill="none"
                  stroke={stroke}
                  strokeDasharray={dash}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  points={run.map(({ slot, percent }) => `${slotX(slot)},${percentY(percent)}`).join(" ")}
                />
              ),
            )}
          </g>
        ))}
      </svg>

      <ol role="list" className="weekly-trend-days list-none" aria-hidden="true">
        {days.map((day) => (
          <li key={day}>{dayLabel(day)}</li>
        ))}
      </ol>

      <ul role="list" className="weekly-trend-legend list-none">
        {named.map(({ entry, name, stroke, dash }) => (
          <li key={entry.accountId} className="weekly-trend-legend-item">
            <svg viewBox="0 0 16 8" className="weekly-trend-swatch" aria-hidden="true">
              <line
                x1="1"
                y1="4"
                x2="15"
                y2="4"
                stroke={stroke}
                strokeDasharray={dash}
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <span className="min-w-0 truncate">{name}</span>
            <span className="font-mono tabular-nums text-ivory">%{entry.latest}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
