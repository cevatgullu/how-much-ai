"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { safeInternalPath } from "@/lib/safe-navigation";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || working) return;
    setWorking(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError("Oturum açılamadı. Parolayı denetleyip yeniden deneyin.");
        setWorking(false);
        return;
      }
      router.replace(safeInternalPath(params.get("next")));
      router.refresh();
    } catch {
      setError("Ağ bağlantısı kurulamadı. Yeniden deneyin.");
      setWorking(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="login-stage animate-rise">
        <div className="flex flex-col text-left">
          <p className="login-kicker">Kota sayacı</p>
          <h1 className="font-display text-ivory">How Much AI</h1>
          <p className="mt-3 text-sm text-muted">Devam etmek için parolayı girin</p>
        </div>
        <form onSubmit={submit} className="mt-7 space-y-3">
          <label htmlFor="password" className="sr-only">
            Parola
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Parola"
            autoFocus
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "password-error" : undefined}
            className="min-h-11 w-full rounded-lg border border-border bg-surface px-3.5 py-2.5 text-sm text-ivory placeholder:text-faint focus:border-coral/60 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!password || working}
            aria-busy={working}
            className="min-h-11 w-full rounded-lg bg-coral py-2.5 text-sm font-medium text-white transition-colors enabled:hover:bg-coral-pressed disabled:opacity-50"
          >
            {working ? "Oturum açılıyor…" : "Oturum aç"}
          </button>
          {error && (
            <p
              id="password-error"
              role="alert"
              className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-center text-xs text-[#ff9c95]"
            >
              {error}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}

export function PasswordLogin({ strictLocal }: { strictLocal: boolean }) {
  if (strictLocal) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="login-stage animate-rise text-left">
          <p className="login-kicker">Kota sayacı</p>
          <h1 className="font-display text-ivory">How Much AI</h1>
          <p className="mt-3 text-sm text-muted">
            Devam etmek için How Much AI&apos;ı güvenli başlatıcıdan açın.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
