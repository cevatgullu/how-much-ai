"use client";

import { useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import type { WeeklyAccountMetric } from "@/lib/quota-metrics";
import { placeQuotaRulerMarkers, type RulerCluster } from "@/lib/quota-ruler-layout";
import type { BrowserAccount } from "@/lib/types";
import { RulerIcon } from "./Icons";
import { quotaRulerAccountName } from "./QuotaReadings";

export interface QuotaRulerProps {
  metrics: readonly WeeklyAccountMetric[];
  accountsById: ReadonlyMap<string, BrowserAccount>;
  providerOrdinals: ReadonlyMap<string, number>;
}

export type QuotaRulerPopupAction =
  | { type: "open"; clusterId: string }
  | { type: "close" }
  | { type: "key"; key: string; clusterId?: string };

export function quotaRulerPopupReducer(state: string | null, action: QuotaRulerPopupAction): string | null {
  if (action.type === "open") return action.clusterId;
  if (action.type === "close") return null;
  if (action.key === "Escape") return null;
  if (action.key === "Enter" && action.clusterId) return action.clusterId;
  return state;
}

interface QuotaRulerFocusTarget {
  focus(options?: FocusOptions): void;
}

export function focusQuotaRulerRef(
  clusterId: string | null,
  refs: ReadonlyMap<string, QuotaRulerFocusTarget>,
): boolean {
  if (!clusterId) return false;
  const target = refs.get(clusterId);
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

export function scheduleQuotaRulerRefFocus(
  clusterId: string | null,
  refs: ReadonlyMap<string, QuotaRulerFocusTarget>,
  schedule: (callback: () => void) => unknown = (callback) => requestAnimationFrame(callback),
): boolean {
  if (!clusterId || !refs.has(clusterId)) return false;
  schedule(() => focusQuotaRulerRef(clusterId, refs));
  return true;
}

export interface QuotaRulerPopupGeometry {
  triggerCenterX: number;
  dialogLeft: number;
  dialogWidth: number;
}

export function quotaRulerPopupGeometry(
  centerX: number,
  rulerWidth: number,
  triggerWidth = 44,
  preferredDialogWidth = 256,
  inset = 8,
): QuotaRulerPopupGeometry {
  const width = Math.max(0, rulerWidth);
  const safeInset = Math.min(Math.max(0, inset), width / 2);
  const triggerEdge = Math.min(width / 2, safeInset + Math.max(0, triggerWidth) / 2);
  const triggerCenterX = Math.min(width - triggerEdge, Math.max(triggerEdge, centerX));
  const dialogWidth = Math.max(0, Math.min(preferredDialogWidth, width - safeInset * 2));
  const dialogLeft = Math.min(
    width - safeInset - dialogWidth,
    Math.max(safeInset, centerX - dialogWidth / 2),
  );
  return { triggerCenterX, dialogLeft, dialogWidth };
}

const PRIMARY_TICKS = [0, 50, 85, 100] as const;
const SECONDARY_TICKS = [25, 75] as const;
const FALLBACK_TRACK_WIDTH = 640;

function clampedPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function tickSet() {
  return (
    <>
      {PRIMARY_TICKS.map((value) => (
        <span
          key={`primary-${value}`}
          data-ruler-tick="primary"
          data-ruler-value={value}
          className="absolute inset-y-0 border-l border-border"
          style={{ left: `${value}%` }}
        >
          <span className="absolute top-0 -translate-x-1/2 font-mono text-[10px] tabular-nums text-faint">{value}</span>
        </span>
      ))}
      {SECONDARY_TICKS.map((value) => (
        <span
          key={`secondary-${value}`}
          data-ruler-tick="secondary"
          data-ruler-value={value}
          className="absolute inset-y-4 border-l border-border"
          style={{ left: `${value}%` }}
        >
          <span className="absolute top-0 -translate-x-1/2 font-mono text-[10px] tabular-nums text-faint">{value}</span>
        </span>
      ))}
    </>
  );
}

function clusterMembers(
  cluster: RulerCluster,
  metricsById: ReadonlyMap<string, WeeklyAccountMetric>,
  accountsById: ReadonlyMap<string, BrowserAccount>,
  providerOrdinals: ReadonlyMap<string, number>,
) {
  return cluster.members.map((member) => {
    const metric = metricsById.get(member.accountId);
    return (
      <li key={member.accountId} className="flex min-w-0 justify-between gap-3">
        <span className="truncate">
          {quotaRulerAccountName(accountsById.get(member.accountId), providerOrdinals.get(member.accountId))}
        </span>
        <span className="shrink-0 font-mono tabular-nums">%{Math.round(metric?.highestWeeklyUsedPercent ?? 0)}</span>
      </li>
    );
  });
}

export function QuotaRuler({ metrics, accountsById, providerOrdinals }: QuotaRulerProps) {
  const titleId = useId();
  const trackRef = useRef<HTMLDivElement>(null);
  const labelRefs = useRef(new Map<string, HTMLSpanElement>());
  const clusterButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const clusterDialogRefs = useRef(new Map<string, HTMLDivElement>());
  const [trackWidth, setTrackWidth] = useState(FALLBACK_TRACK_WIDTH);
  const [labelWidths, setLabelWidths] = useState<Readonly<Record<string, number>>>({});
  const [openClusterId, dispatchPopup] = useReducer(quotaRulerPopupReducer, null);
  const measuredMetrics = useMemo(
    () => metrics.filter((metric) => metric.highestWeeklyUsedPercent !== null),
    [metrics],
  );
  const metricsById = useMemo(() => new Map(metrics.map((metric) => [metric.accountId, metric])), [metrics]);
  const markerInputs = useMemo(() => measuredMetrics.map((metric) => {
    const accountName = quotaRulerAccountName(accountsById.get(metric.accountId), providerOrdinals.get(metric.accountId));
    const estimatedWidth = Math.min(176, Math.max(88, accountName.length * 8 + 48));
    return {
      accountId: metric.accountId,
      sourceIndex: metric.sourceIndex,
      usedPercent: metric.highestWeeklyUsedPercent ?? 0,
      labelWidth: labelWidths[metric.accountId] ?? estimatedWidth,
    };
  }), [accountsById, labelWidths, measuredMetrics, providerOrdinals]);
  const layout = useMemo(
    () => placeQuotaRulerMarkers(markerInputs, trackWidth),
    [markerInputs, trackWidth],
  );
  const highest = useMemo(
    () => [...measuredMetrics].sort((a, b) =>
      (b.highestWeeklyUsedPercent ?? 0) - (a.highestWeeklyUsedPercent ?? 0)
      || a.sourceIndex - b.sourceIndex
      || a.accountId.localeCompare(b.accountId))[0],
    [measuredMetrics],
  );

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const nextWidths: Record<string, number> = {};
      let widthsChanged = false;
      for (const entry of entries) {
        if (entry.target === trackRef.current) {
          if (entry.contentRect.width > 0) setTrackWidth(entry.contentRect.width);
          continue;
        }
        const accountId = (entry.target as HTMLElement).dataset.rulerMarkerId;
        if (!accountId || entry.contentRect.width <= 0) continue;
        nextWidths[accountId] = entry.contentRect.width;
        widthsChanged = true;
      }
      if (widthsChanged) setLabelWidths((current) => ({ ...current, ...nextWidths }));
    });
    if (trackRef.current) observer.observe(trackRef.current);
    for (const label of labelRefs.current.values()) observer.observe(label);
    return () => observer.disconnect();
  }, [layout.placements.length]);

  useEffect(() => {
    focusQuotaRulerRef(openClusterId, clusterDialogRefs.current);
  }, [openClusterId]);

  const closePopup = (restoreFocus = true) => {
    const closingId = openClusterId;
    dispatchPopup({ type: "close" });
    if (restoreFocus && closingId) {
      scheduleQuotaRulerRefFocus(closingId, clusterButtonRefs.current);
    }
  };

  return (
    <section className="quota-ruler min-w-0" aria-labelledby={titleId}>
      <h2 id={titleId} className="flex items-center gap-2 text-lg text-ivory">
        <RulerIcon className="h-5 w-5 text-faint" />
        Kota cetveli
      </h2>

      <div className="relative mt-3 hidden min-h-44 min-[960px]:block">
        <div ref={trackRef} aria-hidden="true" className="absolute inset-x-0 top-0 h-44 border-y border-border">
          {tickSet()}
          {measuredMetrics.map((metric) => (
            <span
              key={metric.accountId}
              className="absolute bottom-0 h-3 border-l-2 border-current text-muted"
              style={{ left: `${clampedPercent(metric.highestWeeklyUsedPercent ?? 0)}%` }}
            />
          ))}
        </div>
        {layout.placements.map((placement) => {
          const metric = metricsById.get(placement.accountId);
          return (
            <span
              key={placement.accountId}
              ref={(node) => {
                if (node) labelRefs.current.set(placement.accountId, node);
                else labelRefs.current.delete(placement.accountId);
              }}
              data-ruler-marker-id={placement.accountId}
              aria-hidden="true"
              className="absolute truncate text-center text-xs text-faint"
              style={{ left: placement.left, top: 34 + placement.lane * 36, width: placement.labelWidth }}
            >
              {quotaRulerAccountName(accountsById.get(placement.accountId), providerOrdinals.get(placement.accountId))}{" "}
              <span className="font-mono tabular-nums">%{Math.round(metric?.highestWeeklyUsedPercent ?? 0)}</span>
            </span>
          );
        })}
        {layout.clusters.map((cluster) => {
          const open = openClusterId === cluster.id;
          const popupId = `${cluster.id}-popup`;
          const geometry = quotaRulerPopupGeometry(cluster.centerX, trackWidth);
          return (
            <div
              key={cluster.id}
              data-ruler-cluster-center={geometry.triggerCenterX}
              className="absolute top-[142px]"
              style={{ left: geometry.triggerCenterX }}
            >
              <button
                ref={(node) => {
                  if (node) clusterButtonRefs.current.set(cluster.id, node);
                  else clusterButtonRefs.current.delete(cluster.id);
                }}
                type="button"
                data-ruler-cluster=""
                aria-label={`${cluster.members.length} hesaplık kümeyi aç`}
                aria-expanded={open}
                aria-controls={popupId}
                className="h-11 w-11 -translate-x-1/2 rounded-md border border-border bg-surface p-0 font-mono text-sm tabular-nums text-ivory"
                onClick={() => open ? closePopup(false) : dispatchPopup({ type: "open", clusterId: cluster.id })}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== "Escape") return;
                  event.preventDefault();
                  if (event.key === "Escape") closePopup();
                  else dispatchPopup({ type: "key", key: event.key, clusterId: cluster.id });
                }}
              >
                +{cluster.members.length}
              </button>
              <div
                ref={(node) => {
                  if (node) clusterDialogRefs.current.set(cluster.id, node);
                  else clusterDialogRefs.current.delete(cluster.id);
                }}
                id={popupId}
                role="dialog"
                tabIndex={-1}
                aria-label={`${cluster.members.length} hesaplık kota kümesi`}
                hidden={!open}
                data-ruler-popup-left={geometry.dialogLeft}
                data-ruler-popup-width={geometry.dialogWidth}
                className="absolute z-10 mt-2 rounded-lg border border-border bg-surface p-3 text-sm text-ivory outline-none focus-visible:ring-2 focus-visible:ring-current"
                style={{
                  left: geometry.dialogLeft - geometry.triggerCenterX,
                  width: geometry.dialogWidth,
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  closePopup();
                }}
              >
                <ol className="grid gap-2">{clusterMembers(cluster, metricsById, accountsById, providerOrdinals)}</ol>
              </div>
            </div>
          );
        })}
      </div>

      <div aria-hidden="true" className="relative mt-3 h-[104px] border-y border-border min-[960px]:hidden">
        {tickSet()}
        {measuredMetrics.map((metric) => (
          <span
            key={metric.accountId}
            className="absolute bottom-0 h-3 border-l-2 border-current text-muted"
            style={{ left: `${clampedPercent(metric.highestWeeklyUsedPercent ?? 0)}%` }}
          />
        ))}
        {highest ? (
          <span
            data-ruler-mobile-peak=""
            className="absolute top-8 truncate text-xs text-faint"
            style={{
              left: 8,
              right: 8,
              textAlign: (highest.highestWeeklyUsedPercent ?? 0) <= 25
                ? "left"
                : (highest.highestWeeklyUsedPercent ?? 0) >= 75
                  ? "right"
                  : "center",
            }}
          >
            En yoğun · {quotaRulerAccountName(accountsById.get(highest.accountId), providerOrdinals.get(highest.accountId))}{" "}
            <span className="font-mono tabular-nums">%{Math.round(highest.highestWeeklyUsedPercent ?? 0)}</span>
          </span>
        ) : null}
      </div>

      <ol aria-label="Kota cetveli hesapları" className="sr-only">
        {metrics.map((metric) => {
          const name = quotaRulerAccountName(accountsById.get(metric.accountId), providerOrdinals.get(metric.accountId));
          if (metric.highestWeeklyUsedPercent === null) {
            return (
              <li key={metric.accountId} data-ruler-account={metric.accountId} data-state="waiting">
                <span>{name}</span> <span>İlk veri bekleniyor</span>
              </li>
            );
          }
          return (
            <li key={metric.accountId} data-ruler-account={metric.accountId}>
              <span>{name}</span>{" "}
              <span>%{Math.round(metric.highestWeeklyUsedPercent)}</span>{" "}
              <span>{metric.highestWeeklyLimitLabel ?? "Haftalık limit"}</span>{" "}
              <span>son veri</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
