"use client";

import { BellIcon, PlusIcon, RefreshIcon } from "./Icons";

interface MobileCommandBarProps {
  refreshing: boolean;
  canRefresh: boolean;
  onRefresh: () => void;
  onAddAccount: () => void;
  onNotifications: () => void;
  onMenu: () => void;
}

export function MobileCommandBar({
  refreshing,
  canRefresh,
  onRefresh,
  onAddAccount,
  onNotifications,
  onMenu,
}: MobileCommandBarProps) {
  const buttonClass = "flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 text-xs text-ivory";
  return (
    <nav aria-label="Hızlı komutlar" className="mobile-command-bar fixed inset-x-0 bottom-0 z-40 flex min-[960px]:hidden">
      <button type="button" aria-label="Yenile" className={buttonClass} onClick={onRefresh} disabled={!canRefresh || refreshing}>
        <RefreshIcon className={`h-4 w-4 ${refreshing ? "animate-spin-slow" : ""}`} />
        <span>Yenile</span>
      </button>
      <button type="button" aria-label="Hesap ekle" className={buttonClass} onClick={onAddAccount}>
        <PlusIcon className="h-4 w-4" />
        <span>Hesap</span>
      </button>
      <button type="button" aria-label="Uyarılar" className={buttonClass} onClick={onNotifications}>
        <BellIcon className="h-4 w-4" />
        <span>Uyarılar</span>
      </button>
      <button type="button" aria-label="Menü" className={buttonClass} onClick={onMenu}>
        <span aria-hidden="true" className="text-base leading-none">•••</span>
        <span>Menü</span>
      </button>
    </nav>
  );
}
