"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  createOpenAIDeviceLoginSession,
  OPENAI_DEVICE_VERIFICATION_URL,
  type OpenAIDeviceConnectedAccount,
  type OpenAIDeviceLoginSession,
  type OpenAIDeviceLoginState,
} from "@/lib/openai-device-login-session";
import { CopyIcon, OpenAIIcon, SpinnerIcon } from "./Icons";

interface OpenAIDeviceLoginProps {
  expectedAccountId?: string;
  disabled: boolean;
  onConnected(account: OpenAIDeviceConnectedAccount): void;
  onBusyChange(busy: boolean): void;
}

type DeviceLoginView = OpenAIDeviceLoginState | { status: "idle" };

async function copyText(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Fall through to the selection-based copy path.
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Copy is blocked. Select the code and copy it manually.");
}

export function OpenAIDeviceLogin({
  expectedAccountId,
  disabled,
  onConnected,
  onBusyChange,
}: OpenAIDeviceLoginProps) {
  const [view, setView] = useState<DeviceLoginView>({ status: "idle" });
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const headingId = useId();
  const callbacksRef = useRef({ onConnected, onBusyChange });
  callbacksRef.current = { onConnected, onBusyChange };
  const sessionRef = useRef<OpenAIDeviceLoginSession | null>(null);

  if (sessionRef.current === null) {
    sessionRef.current = createOpenAIDeviceLoginSession({
      fetch: (input, init) => fetch(input, init),
      open: (url) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (handle) => window.clearTimeout(handle),
      navigateToLogin: () => {
        window.location.href = "/login";
      },
      onState: setView,
      onConnected: (account) => callbacksRef.current.onConnected(account),
      onBusyChange: (busy) => callbacksRef.current.onBusyChange(busy),
    });
  }

  useEffect(() => () => sessionRef.current?.cancel(), []);

  const start = () => {
    setCopied(false);
    setCopyError(null);
    void sessionRef.current?.start(expectedAccountId);
  };

  const cancel = () => {
    sessionRef.current?.cancel();
    setView({ status: "idle" });
    setCopied(false);
    setCopyError(null);
  };

  const authorization = view.status === "waiting" || view.status === "processing" ? view : null;

  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-border bg-surface p-5">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
          style={{ background: "var(--accent-soft)", color: "var(--accent-bright)" }}
        >
          <OpenAIIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="text-sm font-medium text-ivory">
            Connect private ChatGPT login
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            How Much AI gets its own renewable login, separate from the Codex CLI.
          </p>
          <p className="mt-2 text-[11px] font-medium text-[var(--accent-bright)]">
            private app login · auto-renews
          </p>
        </div>
      </div>

      {view.status === "idle" ? (
        <button
          type="button"
          onClick={start}
          disabled={disabled}
          className="accent-btn mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          {expectedAccountId ? "Reconnect private login" : "Connect private ChatGPT login"}
        </button>
      ) : null}

      {view.status === "starting" ? (
        <div role="status" aria-live="polite" className="mt-4 inline-flex items-center gap-2 text-xs text-muted">
          <SpinnerIcon className="h-4 w-4 animate-spin-slow text-[var(--accent-bright)]" />
          Getting a one-time code…
        </div>
      ) : null}

      {authorization ? (
        <div className="mt-4 rounded-xl border border-border bg-bg-raised p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">One-time code</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 select-all rounded-lg border border-border bg-bg px-3 py-2 font-mono text-lg font-semibold tracking-[0.16em] text-ivory">
              {authorization.userCode}
            </code>
            <button
              type="button"
              onClick={() => {
                setCopyError(null);
                void copyText(authorization.userCode).then(
                  () => setCopied(true),
                  (error) => setCopyError(error instanceof Error ? error.message : "Couldn't copy the code."),
                );
              }}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium text-muted transition-colors hover:bg-surface-hover hover:text-ivory"
            >
              <CopyIcon className="h-3.5 w-3.5" />
              {copied ? "Copied" : "Copy code"}
            </button>
          </div>
          <a
            href={OPENAI_DEVICE_VERIFICATION_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex min-h-11 items-center text-xs font-medium text-[var(--accent-bright)] underline decoration-border underline-offset-4"
          >
            Open ChatGPT device login
          </a>
          <p className="text-[11px] leading-relaxed text-faint">
            <time dateTime={new Date(authorization.expiresAt).toISOString()}>
              Expires at {new Date(authorization.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
            </time>
          </p>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            Continue only because you started this login in How Much AI. Never enter a code sent by another person.
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span role="status" aria-live="polite" className="inline-flex items-center gap-2 text-xs text-muted">
              <SpinnerIcon className="h-4 w-4 animate-spin-slow text-[var(--accent-bright)]" />
              {view.status === "processing" ? "Finishing secure connection…" : "Waiting for ChatGPT…"}
            </span>
            <button
              type="button"
              onClick={cancel}
              className="min-h-11 rounded-lg border border-border px-3 text-xs font-medium text-muted transition-colors hover:bg-surface-hover hover:text-ivory"
            >
              Cancel login
            </button>
          </div>
        </div>
      ) : null}

      {view.status === "failed" || view.status === "expired" ? (
        <div role="alert" className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-3 text-xs leading-relaxed text-[#ff9c95]">
          <p>
            {view.status === "expired"
              ? "That one-time code expired. Start a new private ChatGPT login."
              : "Private ChatGPT login couldn't be completed. Start a new login and try again."}
          </p>
          <button
            type="button"
            onClick={start}
            disabled={disabled}
            className="mt-2 min-h-11 rounded-lg border border-current/30 px-3 font-medium text-ivory transition-colors enabled:hover:bg-white/5 disabled:opacity-50"
          >
            Start a new login
          </button>
        </div>
      ) : null}

      {copyError ? (
        <p role="alert" className="mt-2 text-[11px] leading-relaxed text-[#ff9c95]">
          {copyError}
        </p>
      ) : null}

      {view.status === "done" ? (
        <p role="status" aria-live="polite" className="mt-4 text-xs text-muted">
          ChatGPT connected. Syncing the dashboard…
        </p>
      ) : null}
    </section>
  );
}
