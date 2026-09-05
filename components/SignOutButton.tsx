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
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-sm border border-border px-3 text-sm text-faint transition-all enabled:hover:border-border-light enabled:hover:bg-surface-hover enabled:hover:text-ivory disabled:opacity-50"
    >
      <SignOutIcon className="h-4 w-4" />
      <span>{busy ? "Oturum kapatılıyor…" : "Oturumu kapat"}</span>
    </button>
  );
}
