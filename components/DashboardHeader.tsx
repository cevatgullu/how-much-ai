"use client";

import type { RefObject } from "react";
import type { QuotaSortMode } from "@/lib/quota-metrics";
import { BellIcon, PlusIcon, RefreshIcon, StarburstIcon } from "./Icons";

const SORT_LABELS: Record<QuotaSortMode, string> = {
  source: "Kayıt sırası",
  "weekly-usage": "En çok haftalık kullanım",
  "weekly-reset": "En yakın haftalık yenilenme",
};

interface DashboardHeaderProps {
  healthLabel: string;
  autoRefresh: boolean;
  sortMode: QuotaSortMode;
  sortUnavailable: boolean;
  refreshing: boolean;
  canRefresh: boolean;
  addAccountButtonRef?: RefObject<HTMLButtonElement | null>;
  onRefresh: () => void;
  onAddAccount: () => void;
  onNotifications: () => void;
  onSort: () => void;
  onMenu: () => void;
}

export function dashboardSortLabel(mode: QuotaSortMode): string {
  return SORT_LABELS[mode];
}

export function DashboardHeader({
  healthLabel,
  autoRefresh,
  sortMode,
  sortUnavailable,
  refreshing,
  canRefresh,
  addAccountButtonRef,
  onRefresh,
  onAddAccount,
  onNotifications,
  onSort,
  onMenu,
}: DashboardHeaderProps) {
  return (
    <header className="dashboard-header instrument-header sticky top-0 z-40 border-b border-border bg-bg">
      <div className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <StarburstIcon className="h-6 w-6 shrink-0 text-coral" />
          <div className="min-w-0">
            <h1 className="font-display text-xl leading-none text-ivory">How Much AI</h1>
            <p className="mt-1 truncate text-xs text-muted">{healthLabel}</p>
          </div>
        </div>

        <div className="dashboard-header-actions hidden items-center gap-2 min-[960px]:flex">
          <span className="text-xs text-muted" data-auto-refresh-state={autoRefresh ? "on" : "off"}>
            Otomatik yenileme {autoRefresh ? "açık" : "kapalı"}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={!canRefresh || refreshing}
            aria-label="Yenile"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm text-ivory disabled:opacity-40"
          >
            <RefreshIcon className={`h-4 w-4 ${refreshing ? "animate-spin-slow" : ""}`} />
            Yenile
          </button>
          <button
            ref={addAccountButtonRef}
            type="button"
            onClick={onAddAccount}
            aria-label="Hesap ekle"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm text-ivory"
          >
            <PlusIcon className="h-4 w-4" />
            Hesap ekle
          </button>
          <button
            type="button"
            onClick={onNotifications}
            aria-label="Uyarılar"
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-border text-ivory"
          >
            <BellIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onMenu}
            aria-label="Menü"
            className="min-h-11 rounded-lg border border-border px-3 text-sm text-ivory"
          >
            Menü
          </button>
        </div>

        <div className="dashboard-sort-strip w-full border-t border-border pt-2">
          <button
            type="button"
            onClick={onSort}
            className="flex min-h-11 w-full min-w-0 items-center justify-between gap-3 text-left text-sm"
            aria-label={`Sıralama: ${SORT_LABELS[sortMode]}`}
          >
            <span className="text-muted">Sıralama</span>
            <span className="min-w-0 truncate text-right text-ivory">{SORT_LABELS[sortMode]}</span>
          </button>
          {sortUnavailable && sortMode !== "source" && (
            <p role="status" className="pb-1 text-xs text-muted">
              Sıralamak için kullanılabilir haftalık veri yok
            </p>
          )}
        </div>
      </div>
    </header>
  );
}
