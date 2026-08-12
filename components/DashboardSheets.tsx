"use client";

import type { QuotaSortMode } from "@/lib/quota-metrics";
import { ModalShell } from "./ModalShell";
import { SignOutButton } from "./SignOutButton";

export type DashboardSheet = "sort" | "menu" | null;

const SORT_OPTIONS: readonly { value: QuotaSortMode; label: string }[] = [
  { value: "source", label: "Kayıt sırası" },
  { value: "weekly-usage", label: "En çok haftalık kullanım" },
  { value: "weekly-reset", label: "En yakın haftalık yenilenme" },
];

interface DashboardSheetsProps {
  activeSheet: DashboardSheet;
  sortMode: QuotaSortMode;
  autoRefresh: boolean;
  showSignOut: boolean;
  onClose: () => void;
  onSortModeChange: (mode: QuotaSortMode) => void;
  onAutoRefreshChange: (enabled: boolean) => void;
  onSignOutError: (message: string) => void;
}

export function DashboardSheets({
  activeSheet,
  sortMode,
  autoRefresh,
  showSignOut,
  onClose,
  onSortModeChange,
  onAutoRefreshChange,
  onSignOutError,
}: DashboardSheetsProps) {
  if (activeSheet === null) return null;
  const sorting = activeSheet === "sort";
  return (
    <ModalShell
      open
      placement="sheet"
      title={sorting ? "Sıralama" : "Menü"}
      onClose={onClose}
      maxWidthClassName="max-w-xl"
    >
      {sorting ? (
        <fieldset className="dashboard-sheet dashboard-sort-sheet mt-5 space-y-2">
          <legend className="sr-only">Hesap sıralaması</legend>
          {SORT_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border px-3 text-sm text-ivory"
            >
              <input
                type="radio"
                name="dashboard-sort"
                value={option.value}
                checked={sortMode === option.value}
                onChange={() => onSortModeChange(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <div className="dashboard-sheet dashboard-menu-sheet mt-5 space-y-4">
          <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border pb-3">
            <span className="text-sm text-ivory">Otomatik yenileme</span>
            <button
              type="button"
              role="switch"
              aria-checked={autoRefresh}
              onClick={() => onAutoRefreshChange(!autoRefresh)}
              className="min-h-11 rounded-lg border border-border px-3 text-sm text-ivory"
            >
              {autoRefresh ? "Açık" : "Kapalı"}
            </button>
          </div>
          <p className="text-sm leading-relaxed text-muted">
            Hesap kimlik bilgileri şifrelenmiş yerel kasada saklanır. Okumalar bu cihazdaki açık veya küçültülmüş pencerede yenilenir.
          </p>
          {showSignOut && <SignOutButton onError={onSignOutError} />}
        </div>
      )}
    </ModalShell>
  );
}
