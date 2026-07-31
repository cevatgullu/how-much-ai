"use client";

import { useId } from "react";
import { formatResetSchedule, severityColor, type NormalizedUsageBar } from "@/lib/format";

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
  const critical = !atLimit && (remaining <= 15 || bar.severity === "critical");
  const low = !atLimit && !critical && (
    remaining <= 50 || bar.severity === "warning" || bar.severity === "elevated"
  );
  const state = atLimit ? "Limit bitti" : critical ? "Kritik" : low ? "Az kaldı" : null;
  const stateClass = atLimit || critical
    ? "bg-danger/15 text-[#ea7b74]"
    : "bg-amber/15 text-[#e3b56e]";
  const scheduleText = reset
    ? [reset.countdown, `Sıfırlanma zamanı ${reset.exact}`].filter(Boolean).join(", ")
    : null;
  const valueText = [
    `%${remaining} kaldı`,
    `Kullanılan: %${used}`,
    scheduleText,
    stale ? "Eski veri" : null,
  ].filter(Boolean).join(". ");

  return (
    <div>
      <div className="grid gap-y-1 xs:grid-cols-[minmax(0,1fr)_auto] xs:items-baseline xs:gap-x-3 xs:gap-y-0">
        <span className="flex min-w-0 items-baseline gap-2">
          <span id={labelId} title={bar.label} className="min-w-0 truncate text-[13px] text-muted">
            {bar.label}
          </span>
          {state && (
            <span className={`shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${stateClass}`}>
              {state}
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-baseline justify-between gap-2 xs:shrink-0 xs:justify-end">
          <span className="text-[11px] text-faint">Kullanılan: %{used}</span>
          <span className="ml-auto shrink-0 text-right text-sm font-semibold tabular-nums text-ivory">
            %{remaining} kaldı
          </span>
        </span>
      </div>
      {reset && (
        <time dateTime={bar.resetsAt ?? undefined} className="mt-1 block text-[11px] text-faint">
          {[reset.countdown, reset.exact].filter(Boolean).join(" · ")}
        </time>
      )}
      <div
        role="progressbar"
        aria-labelledby={labelId}
        aria-describedby={freshnessDescriptionId}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining}
        aria-valuetext={valueText}
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-track"
      >
        <div
          className="bar-fill h-full rounded-full"
          style={{ width: `${remaining}%`, backgroundColor: severityColor(used, bar.severity) }}
        />
      </div>
    </div>
  );
}
