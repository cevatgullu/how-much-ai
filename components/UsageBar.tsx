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
    ? "bg-danger/15 text-[#e0564a]"
    : "bg-amber/15 text-[#e6a54a]";
  // Severity reads low -> high as amber -> coral -> red. The two lighter bands used to be the
  // other way round, so a barely-touched limit looked hotter than a half-spent one.
  //
  // These are fixed severity colours, not the provider accent. The accent is per provider
  // (coral for Claude, blue for ChatGPT, bone for Grok), so using it here made the same
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
    <div className="usage-meter">
      <div className="usage-meter-head">
        <span id={labelId} title={bar.label} className="usage-meter-label min-w-0 break-words">
          {bar.label}
        </span>
        {state && (
          <span className={`shrink-0 rounded-sm px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${stateClass}`}>
            {state}
          </span>
        )}
      </div>
      <div className="usage-meter-readout">
        <span className="usage-meter-used tabular-nums" style={{ color: fillColor }}>
          %{used}
        </span>
        <span className="usage-meter-caption">kullanıldı</span>
        <span className="usage-meter-remain">%{remaining} kaldı</span>
      </div>
      {reset && (
        <time dateTime={bar.resetsAt ?? undefined} className="mt-1 block min-w-0 break-words text-[12px] tabular-nums text-faint">
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
        className="usage-ruler"
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
            style={{ left: `calc(${used}% - 1px)` }}
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
}
