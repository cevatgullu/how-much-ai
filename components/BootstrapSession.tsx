"use client";

import { useEffect, useState } from "react";
import { StarburstIcon } from "@/components/Icons";
import {
  beginBootstrapSession,
  type BootstrapSessionAttempt,
} from "@/lib/bootstrap-session";

const browserAttempt: BootstrapSessionAttempt | null =
  typeof window === "undefined" ? null : beginBootstrapSession(window);

export function BootstrapSession() {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    if (!browserAttempt) {
      setFailed(true);
      return () => {
        active = false;
      };
    }
    void browserAttempt.completion.then((ok) => {
      if (active && !ok) setFailed(true);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="animate-rise w-full max-w-sm text-center">
        <StarburstIcon className="mx-auto h-10 w-10 text-coral" />
        <h1 className="font-display mt-5 text-2xl text-ivory">How Much AI</h1>
        <p className="mt-2 text-sm text-muted" role={failed ? "alert" : undefined}>
          {failed
            ? "The secure launch link is unavailable. Close this window and open the launcher again."
            : "Opening your secure local dashboard\u2026"}
        </p>
      </div>
    </div>
  );
}
