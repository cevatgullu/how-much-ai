"use client";

import { useId } from "react";
import { formatResetSchedule, type NormalizedUsageBar } from "@/lib/format";

interface UsageBarProps {
  bar: NormalizedUsageBar;
  now: number;
  stale: boolean;
  freshnessDescriptionId?: string;
}

export function UsageBar({ bar, now, stale, freshnessDescriptionId }: UsageBarProps) {
  const labelId = useId();
  const remaining = bar.remainingPercent;
  const used = bar.usedPercent;
  const reset = formatResetSchedule(bar.resetsAt, now);
  const atLimit = remaining === 0;
  const critical = !atLimit && remaining <= 15;
  const low = !atLimit && !critical && remaining <= 50;
  const state = atLimit ? "Limit bitti" : critical ? "Kritik" : low ? "Az kaldı" : null;
  const stateClass = atLimit || critical
    ? "bg-danger/15 text-[#ea7b74]"
    : "bg-amber/15 text-[#e3b56e]";
  // Severity reads low -> high as amber -> coral -> red. The two lighter bands used to be the
  // other way round, so a barely-touched limit looked hotter than a half-spent one.
  //
  // These are fixed severity colours, not the provider accent. The accent is per provider
  // (coral for Claude, blue for ChatGPT, neutral for Grok), so using it here made the same
  // fill level a different hue on each card and the scale stopped meaning anything.
  const fillColor = atLimit || critical
    ? "var(--color-danger)"
    : low
      ? "var(--color-coral)"
      : "var(--color-amber)";
  const scheduleText = reset
    ? [reset.countdown, `Sıfırlanma zamanı ${reset.exact}`].filter(Boolean).join(", ")
    : null;
  const valueText = [
    `Kullanılan: %${used}`,
    `%${remaining} kaldı`,
    scheduleText,
    stale ? "Eski veri" : null,
  ].filter(Boolean).join(". ");

  return (
    <div>
      <div className="grid gap-y-1 xs:grid-cols-[minmax(0,1fr)_auto] xs:items-baseline xs:gap-x-3 xs:gap-y-0">
        <span className="flex min-w-0 flex-wrap items-baseline gap-2">
          <span id={labelId} title={bar.label} className="min-w-0 break-words text-[13px] text-muted">
            {bar.label}
          </span>
          {state && (
            <span className={`shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${stateClass}`}>
              {state}
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-baseline justify-between gap-2 xs:shrink-0 xs:justify-end">
          <span
            className="ml-auto shrink-0 text-right text-[15px] font-semibold leading-none tabular-nums"
            style={{ color: fillColor }}
          >
            %{used}
            <span className="ml-1 text-[10px] font-normal text-faint">kullanıldı</span>
          </span>
        </span>
      </div>
      {reset && (
        <time dateTime={bar.resetsAt ?? undefined} className="mt-1 block min-w-0 break-words text-[11px] tabular-nums text-faint">
          {[reset.countdown, reset.exact].filter(Boolean).join(" · ")}
        </time>
      )}
      <div
        role="progressbar"
        aria-labelledby={labelId}
        aria-describedby={freshnessDescriptionId}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used}
        aria-valuetext={valueText}
        className="usage-ruler mt-1.5"
      >
        <span className="usage-ruler-major" style={{ left: "25%" }} aria-hidden="true" />
        <span className="usage-ruler-major" style={{ left: "50%" }} aria-hidden="true" />
        <span className="usage-ruler-major" style={{ left: "75%" }} aria-hidden="true" />
        {/* Dolgu tüketimi gösterir: çubuk doldukça kota biter. */}
        <span
          className="usage-ruler-fill bar-fill"
          style={{ width: `${used}%`, backgroundColor: fillColor }}
        />
        {used > 2 && used < 100 && (
          <span
            className="usage-ruler-edge"
            style={{ left: `calc(${used}% - 1px)`, backgroundColor: fillColor, color: fillColor }}
            aria-hidden="true"
          />
        )}
      </div>
      <div className="mt-1 text-[10px] tabular-nums text-faint">%{remaining} kaldı</div>
    </div>
  );
}
