"use client";

import { useEffect, useState } from "react";
import { CheckIcon, SpinnerIcon, StarburstIcon } from "@/components/Icons";
import {
  beginOAuthCallbackSession,
  type OAuthCallbackSessionAttempt,
} from "@/lib/oauth-callback-session";

const browserAttempt: OAuthCallbackSessionAttempt | null =
  typeof window === "undefined" ? null : beginOAuthCallbackSession(window);

export function OAuthCallbackSession() {
  const [status, setStatus] = useState<"working" | "done" | "failed">(
    "working",
  );

  useEffect(() => {
    let active = true;
    if (!browserAttempt) {
      setStatus("failed");
      return () => {
        active = false;
      };
    }
    void browserAttempt.completion.then((ok) => {
      if (active) setStatus(ok ? "done" : "failed");
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="animate-rise w-full max-w-sm text-center">
        {status === "working" ? (
          <SpinnerIcon className="mx-auto h-10 w-10 animate-spin-slow text-coral" />
        ) : status === "done" ? (
          <CheckIcon className="mx-auto h-10 w-10 text-coral" />
        ) : (
          <StarburstIcon className="mx-auto h-10 w-10 text-coral" />
        )}
        <h1 className="font-display mt-5 text-2xl text-ivory">How Much AI</h1>
        <p
          className="mt-2 text-sm text-muted"
          role={status === "failed" ? "alert" : "status"}
        >
          {status === "working"
            ? "Completing your secure Claude connection\u2026"
            : status === "done"
              ? "Claude connection complete. You can close this window."
              : "The secure Claude connection could not be completed. Close this window and start again."}
        </p>
      </div>
    </div>
  );
}
