"use client";

import { useState } from "react";
import { logout } from "@/lib/vault-client";
import { SignOutIcon } from "./Icons";

interface Props {
  onError: (message: string) => void;
}

export function SignOutButton({ onError }: Props) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await logout();
    } catch {
      setBusy(false);
      onError("Oturum kapatılamadı. Yeniden deneyin.");
    }
  };

  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={busy}
      aria-label={busy ? "Oturum kapatılıyor" : "Oturumu kapat"}
      aria-busy={busy}
      title="Oturumu kapat"
      className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-border text-faint transition-all enabled:hover:border-border-light enabled:hover:bg-surface-hover enabled:hover:text-ivory disabled:opacity-50 sm:w-auto sm:gap-2 sm:px-3"
    >
      <SignOutIcon className="h-4 w-4" />
      <span className="hidden sm:inline">{busy ? "Oturum kapatılıyor…" : "Oturumu kapat"}</span>
    </button>
  );
}
