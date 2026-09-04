"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { DUMP_COMMANDS, parseCredentials } from "@/lib/credentials";
import { safeServerErrorId, serverErrorText } from "@/lib/error-reference";
import { buildAuthorizeUrl, clearPkce, loadOrCreatePkce, parsePastedCode, type PkceBundle } from "@/lib/oauth";
import type { BrowserAccount } from "@/lib/types";
import type { ProviderId } from "@/lib/providers/types";
import { CheckIcon, CopyIcon, DesktopIcon, SpinnerIcon, TerminalIcon } from "./Icons";
import { ModalShell } from "./ModalShell";
import { OpenAIDeviceLogin } from "./OpenAIDeviceLogin";
import { PROVIDER_META, PROVIDER_ORDER, parseCodexCredential, parseGrokSession } from "./providers-ui";

interface AddAccountModalProps {
  open: boolean;
  strictLocal: boolean;
  onClose: () => void;
  reconnectAccount?: BrowserAccount | null;
  // Local / pairing flow: the server added the account to the vault directly, so the dashboard should
  // re-pull the vault.
  onServerConnected: () => void | Promise<void>;
}

function errText(_value: unknown, fallback: string): string {
  return fallback;
}

type OS = "macOS" | "linux" | "windows";
type CredentialMethod = "private-login" | "existing-session";
const OS_LABELS: Record<OS, string> = { macOS: "macOS", linux: "Linux", windows: "Windows" };

// Which primary connect flow this deployment offers (feature-detected on open).
type Mode = "local" | "pair" | "paste";

async function copyText(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Fall through to the selection-based copy path below.
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
  if (!copied) throw new Error("Bu tarayıcıda kopyalama engelli. Komutu seçip elle kopyalayın.");
}

// The accent-btn class follows the nearest [data-provider] scope (coral for Claude, mono for ChatGPT);
// its hover shade is handled in globals.css, so no per-state coral utilities are needed here.
const PRIMARY_BTN =
  "accent-btn inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-medium transition-colors disabled:opacity-50";
const PRIMARY_BUTTON = PRIMARY_BTN;
const PRIMARY_LINK = PRIMARY_BTN;
const REQUEST_TIMEOUT_MS = 30_000;

class StrictLocalDisplayError extends Error {}

function connectionDisplayError(strictLocal: boolean, localMessage: string, hostedMessage: string): Error {
  return strictLocal ? new StrictLocalDisplayError(localMessage) : new Error(hostedMessage);
}

function timeoutError(action: string): Error {
  return new Error(`${action} 30 saniye içinde tamamlanmadı. Bağlantıyı denetleyip yeniden deneyin.`);
}

async function withDeadline<T>(promise: Promise<T>, action: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(timeoutError(action)), REQUEST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function strictLocalClaudeConnectionErrorText(
  status: number,
  _serverError: unknown,
  errorId: unknown,
): string {
  const message = status === 401
    ? "Claude yetkilendirme kodu kabul edilmedi. Yeni bir oturum açıp yeniden deneyin."
    : "Claude bağlantısı tamamlanamadı. Yeniden deneyin.";
  const reference = safeServerErrorId(errorId);
  return reference ? `${message} Referans: ${reference}.` : message;
}

interface ConnectedInfo {
  email: string;
  plan?: string;
  label?: string;
}

interface AddAccountSuccessCardProps {
  strictLocal: boolean;
  connected: ConnectedInfo;
  completionError: string | null;
  onRetry: () => void;
}

export function AddAccountSuccessCard({
  strictLocal,
  connected,
  completionError,
  onRetry,
}: AddAccountSuccessCardProps) {
  return (
    <div className="space-y-3">
      <div
        role="status"
        className="flex items-center gap-3 rounded-xl border px-4 py-3.5"
        style={{
          borderColor: "color-mix(in srgb, var(--accent) 40%, transparent)",
          background: "var(--accent-soft)",
        }}
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          style={{ background: "var(--accent-soft)", color: "var(--accent-bright)" }}
        >
          <CheckIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-ivory">
            {`${connected.label || connected.email} bağlandı`}
          </p>
          <p className="truncate text-xs text-muted">
            {connected.email}
            {connected.plan ? ` · ${connected.plan}` : ""}
          </p>
        </div>
      </div>
      {!completionError && (
        <p role="status" className="inline-flex items-center gap-2 text-xs text-muted" aria-live="polite">
          <SpinnerIcon className="h-4 w-4 animate-spin-slow text-[var(--accent-bright)]" />
          {"Kimlik bilgisi güvenle kaydedildi. Pano eşitleniyor…"}
        </p>
      )}
      {completionError && (
        <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-[#ff9c95]">
          <p>{completionError}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 min-h-11 rounded-lg border border-current/30 px-3 py-1.5 font-medium hover:bg-white/5"
          >
            {"Pano eşitlemesini yeniden dene"}
          </button>
        </div>
      )}
    </div>
  );
}

interface LocalMachineError {
  message: string;
  recommendation?: string;
}

interface ClaudeLocalMachinePanelProps {
  strictLocal: boolean;
  busy: boolean;
  working: boolean;
  error: LocalMachineError | null;
  onConnect: () => void;
  actionRef?: RefObject<HTMLButtonElement | null>;
}

export function ClaudeLocalMachinePanel({
  strictLocal,
  busy,
  working,
  error,
  onConnect,
  actionRef,
}: ClaudeLocalMachinePanelProps) {
  return (
    <>
      <div className="rounded-xl border border-border bg-surface p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-coral/15 text-coral-bright">
            <DesktopIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ivory">{"Bu makineden bağlan"}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              {"Bu bilgisayardaki Claude Code oturumunu okuyacağız. Bu hızlı seçenek CLI ile dönen oturumu paylaşır ve özel uygulama oturumu kadar güvenilir değildir."}
            </p>
          </div>
        </div>
        <button
          ref={actionRef}
          type="button"
          onClick={onConnect}
          disabled={busy}
          className={`mt-4 ${PRIMARY_BUTTON}`}
        >
          {working ? (
            <>
              <SpinnerIcon className="h-4 w-4 animate-spin-slow" />
              {"Bağlanıyor…"}
            </>
          ) : (
            <>
              <DesktopIcon className="h-4 w-4" />
              {"Bu makineden bağlan"}
            </>
          )}
        </button>
      </div>
      {error && (
        <div role="alert" className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-xs leading-relaxed text-[#ff9c95]">
          <p>{error.message}</p>
          {error.recommendation && <p className="mt-1 text-muted">{error.recommendation}</p>}
        </div>
      )}
    </>
  );
}

type OpenAILocalFailureKind = "provider" | "timeout" | "network";

export function strictLocalOpenAILocalConnectionErrorText(
  kind: OpenAILocalFailureKind,
  _serverError: unknown,
  errorId: unknown,
): string {
  const message = kind === "provider"
    ? "Bu makinedeki Codex oturumu okunamadı."
    : kind === "timeout"
      ? "Codex oturumunu okuma işlemi zaman aşımına uğradı. Yeniden deneyin."
      : "Codex oturumu okunamadı. Uygulamanın çalıştığını denetleyip yeniden deneyin.";
  const reference = safeServerErrorId(errorId);
  return reference ? `${message} Referans: ${reference}.` : message;
}

interface OpenAILocalMachinePanelProps {
  strictLocal: boolean;
  busy: boolean;
  working: boolean;
  error: LocalMachineError | null;
  onConnect: () => void;
  actionRef?: RefObject<HTMLButtonElement | null>;
}

export function OpenAILocalMachinePanel({
  busy,
  working,
  error,
  onConnect,
  actionRef,
}: OpenAILocalMachinePanelProps) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-start gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
          style={{ background: "var(--accent-soft)", color: "var(--accent-bright)" }}
        >
          <DesktopIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ivory">Bu bilgisayardaki Codex oturumunu oku</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Codex CLI&apos;ın bu makinedeki <code>~/.codex/auth.json</code> dosyasına kaydettiği ChatGPT oturumunu kullanır.
          </p>
          <button
            ref={actionRef}
            type="button"
            onClick={onConnect}
            disabled={busy}
            className={`mt-3 ${PRIMARY_BUTTON}`}
          >
            {working ? <SpinnerIcon className="h-4 w-4 animate-spin-slow" /> : null}
            {working ? "Okunuyor…" : "ChatGPT oturumunu bu makineden oku"}
          </button>
          {error ? (
            <div role="alert" className="mt-2 text-[11px] leading-relaxed text-[#ff9c95]">
              <p>{error.message}</p>
              {error.recommendation ? <p className="mt-1 text-faint">{error.recommendation}</p> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type PairingPanelState = "starting" | "waiting" | "processing" | "expired" | "error";

interface ClaudePairingPanelProps {
  strictLocal: boolean;
  state: PairingPanelState;
  command: string;
  error: string | null;
  busy: boolean;
  copied: boolean;
  copyError?: string | null;
  onCopy: () => void;
  onRetry: () => void;
  headingRef?: RefObject<HTMLParagraphElement | null>;
}

export function ClaudePairingPanel({
  strictLocal,
  state,
  command,
  error,
  busy,
  copied,
  copyError,
  onCopy,
  onRetry,
  headingRef,
}: ClaudePairingPanelProps) {
  const starting = state === "starting";
  return (
    <>
      <div className="flex gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-coral/15 text-coral-bright">
          <TerminalIcon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p ref={headingRef} tabIndex={-1} className="text-sm text-ivory outline-none">
            {"Hesabın açık olduğu yerde tek bir komut çalıştır"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            {"Claude Code kullandığınız bilgisayarda bu komutu terminale yapıştırın. O makinedeki geçerli dönen oturumu okur ve daha az güvenilir hızlı seçenek olarak buraya bağlar."}
          </p>
          {starting && !command && (
            <div role="status" className="mt-3 inline-flex items-center gap-2 text-xs text-muted">
              <SpinnerIcon className="h-4 w-4 animate-spin-slow text-coral" />
              {"Tek kullanımlık eşleştirme kodu alınıyor…"}
            </div>
          )}
          {command && (
            <div className="mt-2.5 flex items-stretch gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs text-secondary">
                {command}
              </code>
              <button
                type="button"
                onClick={onCopy}
                className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-ivory"
              >
                <CopyIcon className="h-3.5 w-3.5" />
                {copied ? ("Kopyalandı") : ("Kopyala")}
              </button>
            </div>
          )}
          {copyError && (
            <p role="alert" className="mt-2 text-[11px] leading-relaxed text-[#ff9c95]">{copyError}</p>
          )}
          {command && state === "waiting" && (
            <div className="mt-3 inline-flex items-center gap-2 text-xs text-muted">
              <SpinnerIcon className="h-4 w-4 animate-spin-slow text-coral" />
              {"Komutu çalıştırmanız bekleniyor…"}
            </div>
          )}
          {state === "processing" && (
            <div className="mt-3 inline-flex items-center gap-2 text-xs text-muted" role="status">
              <SpinnerIcon className="h-4 w-4 animate-spin-slow text-coral" />
              {"Hesap doğrulandı — güvenle kaydediliyor…"}
            </div>
          )}
          {state === "expired" && (
            <div className="mt-3 flex items-center gap-3">
              <span className="text-xs text-[#e3b56e]">Kodun süresi doldu.</span>
              <button
                type="button"
                onClick={onRetry}
                disabled={busy}
                aria-busy={busy}
                className="min-h-11 rounded-lg border border-border px-3 py-1 text-xs font-medium text-ivory transition-colors enabled:hover:bg-surface-hover"
              >
                {busy
                  ? ("Kod alınıyor…")
                  : ("Yeni kod al")}
              </button>
            </div>
          )}
          {state === "error" && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p role="alert" className="text-xs text-[#ff9c95]">
                {strictLocal ? "Eşleştirme hizmetine ulaşılamadı." : error ?? "Eşleştirme servisine ulaşılamadı."}
              </p>
              <button
                type="button"
                onClick={onRetry}
                disabled={busy}
                aria-busy={busy}
                className="min-h-11 rounded-lg border border-border px-3 py-1 text-xs font-medium text-ivory transition-colors enabled:hover:bg-surface-hover"
              >
                {busy
                  ? ("Yeniden deneniyor…")
                  : ("Yeniden dene")}
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="mt-4 rounded-xl border border-border/70 bg-surface/60 p-3.5 text-[11px] leading-relaxed text-faint">
        <p className="mb-1.5 font-medium text-muted">Ne olur ve neden güvenlidir</p>
        <ul className="space-y-1">
          <li>Claude Code&apos;un o makinede kullandığı oturum belirtecini gönderir.</li>
          <li>HTTPS ile iletilir ve şifreli saklanır; yalnızca panonuz okuyabilir.</li>
          <li>Yardımcı açık kaynaklıdır; çalıştırmadan önce ne yaptığını inceleyebilirsiniz.</li>
        </ul>
      </div>
    </>
  );
}

export function AddAccountModal({
  open,
  strictLocal,
  onClose,
  reconnectAccount,
  onServerConnected,
}: AddAccountModalProps) {
  const [mode, setMode] = useState<Mode>(() =>
    strictLocal ? "local" : "paste",
  );
  const [showPaste, setShowPaste] = useState(true);
  // Which provider is being connected. Reconnect is locked to the account's own provider.
  const [provider, setProvider] = useState<ProviderId>(
    () => reconnectAccount?.provider ?? "anthropic",
  );

  // Paste flow.
  const [os, setOs] = useState<OS>("macOS");
  const [credentialMethod, setCredentialMethod] = useState<CredentialMethod>("private-login");
  const [pasted, setPasted] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [oauthBundle, setOauthBundle] = useState<PkceBundle | null>(null);
  const [oauthOpened, setOauthOpened] = useState(false);

  // Local flow.
  const [localWorking, setLocalWorking] = useState(false);
  const [localError, setLocalError] = useState<{ message: string; recommendation?: string } | null>(null);
  const [deviceBusy, setDeviceBusy] = useState(false);

  // Pairing flow.
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairCommand, setPairCommand] = useState("");
  const [pairState, setPairState] = useState<"waiting" | "processing" | "expired" | "error">("waiting");
  const [pairStarting, setPairStarting] = useState(false);
  const [pairCopied, setPairCopied] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairCopyError, setPairCopyError] = useState<string | null>(null);

  // Shared success (local or pair).
  const [connected, setConnected] = useState<{ email: string; plan?: string; label?: string } | null>(null);
  const [completionError, setCompletionError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollGeneration = useRef(0);
  const closedRef = useRef(false);
  const pairStartGeneration = useRef(0);
  const pairStartPromise = useRef<Promise<boolean> | null>(null);
  const pairStartController = useRef<AbortController | null>(null);
  const operationController = useRef<AbortController | null>(null);
  const operationRef = useRef<"oauth" | "manual" | "local" | "pair-start" | null>(null);
  const focusModeAfterSwitch = useRef(false);
  const pasteHeadingRef = useRef<HTMLParagraphElement>(null);
  const localActionRef = useRef<HTMLButtonElement>(null);
  const pairHeadingRef = useRef<HTMLParagraphElement>(null);

  const stopPolling = useCallback(() => {
    pollGeneration.current += 1;
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const reloadAndClose = useCallback(async () => {
    setCompletionError(null);
    try {
      await withDeadline(Promise.resolve(onServerConnected()), "Pano eşitlemesi");
      if (!closedRef.current) onClose();
    } catch {
      if (!closedRef.current) {
        setCompletionError(
          "Hesap bağlandı, ancak pano yeniden yüklenemedi. Eşitlemeyi yeniden deneyin.",
        );
      }
    }
  }, [onClose, onServerConnected]);

  // Server-side connect succeeded → briefly show success, then reload the vault and close.
  const finishServerConnect = useCallback(
    (info: { email: string; plan?: string; label?: string }) => {
      stopPolling();
      setConnected(info);
      setCompletionError(null);
      if (finishRef.current) clearTimeout(finishRef.current);
      finishRef.current = setTimeout(() => {
        if (closedRef.current) return;
        void reloadAndClose();
      }, 1100);
    },
    [reloadAndClose, stopPolling],
  );

  const pollPairing = useCallback(
    (code: string) => {
      stopPolling();
      const generation = pollGeneration.current;
      let failures = 0;
      const schedule = (delay: number) => {
        if (closedRef.current || generation !== pollGeneration.current) return;
        pollRef.current = setTimeout(() => void tick(), delay);
      };
      const tick = async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          const res = await fetch(`/api/connect/pair/status?code=${encodeURIComponent(code)}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (closedRef.current || generation !== pollGeneration.current) return;
          if (res.status === 401) {
            window.location.href = "/login";
            return;
          }
          const data = (await res.json().catch(() => ({}))) as { status?: string; email?: string; error?: string };
          if (!res.ok) {
            failures += 1;
            if (failures >= 3) {
              stopPolling();
              setPairError(errText(data.error, "Eşleştirme servisine ulaşılamadı. Yeniden deneyin."));
              setPairState("error");
              return;
            }
            schedule(Math.min(7500, 1500 * 2 ** failures));
            return;
          }
          failures = 0;
          if (data.status === "done") {
            finishServerConnect({ email: data.email ?? "hesabınız" });
          } else if (data.status === "processing") {
            setPairState("processing");
            schedule(1500);
          } else if (data.status === "failed") {
            stopPolling();
            setPairError(errText(data.error, "Hesap kaydedilemedi. Yeni kod alıp yeniden deneyin."));
            setPairState("error");
          } else if (data.status === "expired") {
            stopPolling();
            setPairState("expired");
          } else {
            setPairState("waiting");
            schedule(2500);
          }
        } catch {
          failures += 1;
          if (failures >= 3) {
            stopPolling();
            setPairError("Eşleştirme servisine ulaşılamadı. Bağlantınızı denetleyip yeniden deneyin.");
            setPairState("error");
          } else {
            schedule(Math.min(7500, 1500 * 2 ** failures));
          }
        } finally {
          clearTimeout(timeout);
        }
      };
      schedule(2500);
    },
    [finishServerConnect, stopPolling],
  );

  const startPairing = useCallback((): Promise<boolean> => {
    // The start endpoint mints a new single-use code. Reuse one in-flight promise so double-clicks,
    // keyboard activation, and quick retries cannot create overlapping codes whose responses race.
    if (pairStartPromise.current) return pairStartPromise.current;
    if (operationRef.current) return Promise.resolve(false);

    const generation = ++pairStartGeneration.current;
    const controller = new AbortController();
    pairStartController.current = controller;
    operationRef.current = "pair-start";
    setPairStarting(true);
    setPairCode(null);
    setPairCommand("");
    setPairCopied(false);
    setPairCopyError(null);
    setPairError(null);
    setPairState("waiting");
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let attempt!: Promise<boolean>;
    attempt = (async () => {
      try {
        const res = await fetch("/api/connect/pair/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedAccountId: reconnectAccount?.id }),
          signal: controller.signal,
        });
        if (closedRef.current || generation !== pairStartGeneration.current) return false;
        if (res.status === 401) {
          window.location.href = "/login";
          return false;
        }
        const data = (await res.json().catch(() => ({}))) as { code?: string; command?: string; error?: string };
        if (closedRef.current || generation !== pairStartGeneration.current) return false;
        if (!res.ok || !data.code || !data.command) {
          setPairError(errText(data.error, "Eşleştirme başlatılamadı. Yeniden deneyin."));
          setPairState("error");
          return false;
        }
        setPairCode(data.code);
        setPairCommand(data.command);
        setPairState("waiting");
        setPairError(null);
        setConnected(null);
        pollPairing(data.code);
        return true;
      } catch (startError) {
        if (
          controller.signal.aborted ||
          closedRef.current ||
          generation !== pairStartGeneration.current ||
          (startError instanceof Error && startError.name === "AbortError")
        ) {
          if (!closedRef.current && generation === pairStartGeneration.current) {
            setPairError("Eşleştirme kodu alma işlemi 30 saniyede zaman aşımına uğradı. Bağlantınızı denetleyip yeniden deneyin.");
            setPairState("error");
          }
          return false;
        }
        setPairError("Eşleştirme başlatılamadı. Bağlantınızı denetleyip yeniden deneyin.");
        setPairState("error");
        return false;
      } finally {
        clearTimeout(timeout);
        if (pairStartPromise.current === attempt) pairStartPromise.current = null;
        if (pairStartController.current === controller) pairStartController.current = null;
        if (operationRef.current === "pair-start") operationRef.current = null;
        if (!closedRef.current && generation === pairStartGeneration.current) setPairStarting(false);
      }
    })();
    pairStartPromise.current = attempt;
    return attempt;
  }, [pollPairing, reconnectAccount?.id]);

  // A private full-scope OAuth login owned by this app is immediately visible on every deployment.
  // In the background we only detect which explicitly less-reliable shared-CLI alternative to offer;
  // no pairing code is minted until the user chooses it.
  useEffect(() => {
    if (!open) return;
    closedRef.current = false;
    pairStartGeneration.current += 1;
    pairStartController.current?.abort();
    pairStartController.current = null;
    pairStartPromise.current = null;
    operationController.current?.abort();
    operationController.current = null;
    operationRef.current = null;
    setMode(strictLocal ? "local" : "paste");
    setShowPaste(true);
    setProvider(reconnectAccount?.provider ?? "anthropic");
    setPasted("");
    setCredentialMethod("private-login");
    setError(null);
    setWorking(false);
    setCopied(false);
    setCopyError(null);
    setOauthBundle(null);
    setOauthOpened(false);
    setLocalWorking(false);
    setLocalError(null);
    setDeviceBusy(false);
    setPairCode(null);
    setPairCommand("");
    setPairState("waiting");
    setPairStarting(false);
    setPairCopied(false);
    setPairError(null);
    setPairCopyError(null);
    setConnected(null);
    setCompletionError(null);

    let cancelled = false;
    void loadOrCreatePkce().then(
      (bundle) => {
        if (!cancelled) setOauthBundle(bundle);
      },
      () => {
        if (!cancelled) {
          setError(
            "Güvenli Claude oturumu hazırlanamadı. Bu pencereyi kapatıp yeniden deneyin.",
          );
        }
      },
    );
    void (async () => {
      // Self-hosted local quick-connect is available only on the machine running the app.
      try {
        const res = await fetch("/api/connect/local", { cache: "no-store" });
        if (cancelled) return;
        if (res.ok) {
          setMode("local");
          return;
        }
      } catch {
        /* fall through */
      }
      if (!strictLocal) {
        setMode("pair");
      }
    })();

    return () => {
      cancelled = true;
    };
    // Runs only on open transitions; the convenience probe must not hide the durable setup flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, strictLocal]);

  // Stop polling + mark closed whenever the modal is not open / unmounts.
  useEffect(() => {
    if (!open) {
      closedRef.current = true;
      pairStartGeneration.current += 1;
      pairStartController.current?.abort();
      pairStartController.current = null;
      pairStartPromise.current = null;
      operationController.current?.abort();
      operationController.current = null;
      operationRef.current = null;
      stopPolling();
      if (finishRef.current) {
        clearTimeout(finishRef.current);
        finishRef.current = null;
      }
    }
    return () => {
      pairStartGeneration.current += 1;
      pairStartController.current?.abort();
      pairStartController.current = null;
      pairStartPromise.current = null;
      operationController.current?.abort();
      operationController.current = null;
      operationRef.current = null;
      stopPolling();
      if (finishRef.current) {
        clearTimeout(finishRef.current);
        finishRef.current = null;
      }
    };
  }, [open, stopPolling]);

  useEffect(() => {
    if (!open || !focusModeAfterSwitch.current) return;
    focusModeAfterSwitch.current = false;
    const frame = requestAnimationFrame(() => {
      const target = showPaste
        ? pasteHeadingRef.current
        : mode === "local"
          ? localActionRef.current
          : pairHeadingRef.current;
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, open, showPaste]);

  const connectLocal = useCallback(async () => {
    if (localWorking || operationRef.current) return;
    const controller = new AbortController();
    operationController.current = controller;
    operationRef.current = "local";
    setLocalWorking(true);
    setLocalError(null);
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch("/api/connect/local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedAccountId: reconnectAccount?.id }),
        signal: controller.signal,
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        email?: string;
        plan?: string;
        label?: string;
        error?: string;
        recommendation?: string;
      };
      if (!res.ok) {
        setLocalError({
          message: errText(
            data.error,
            "Bu makineden bağlantı kurulamadı.",
          ),
          recommendation: undefined,
        });
        return;
      }
      finishServerConnect({ email: data.email ?? "hesabınız", plan: data.plan, label: data.label });
    } catch (connectError) {
      if (!closedRef.current) {
        setLocalError({
          message:
            connectError instanceof Error && connectError.name === "AbortError"
              ? "Bağlantı 30 saniye içinde tamamlanamadı. Uygulamanın çalıştığını denetleyip yeniden deneyin."
              : "Ağ bağlantısı kurulamadı. Uygulamanın çalıştığını denetleyin.",
        });
      }
    } finally {
      clearTimeout(timeout);
      if (operationController.current === controller) operationController.current = null;
      if (operationRef.current === "local") operationRef.current = null;
      if (!closedRef.current) setLocalWorking(false);
    }
  }, [localWorking, finishServerConnect, reconnectAccount?.id, strictLocal]);

  const connectPaste = useCallback(async () => {
    if (!pasted.trim() || working || operationRef.current) return;
    const oauthFlow = credentialMethod === "private-login";
    const operation = oauthFlow ? "oauth" : "manual";
    const controller = new AbortController();
    operationController.current = controller;
    operationRef.current = operation;
    setWorking(true);
    setError(null);
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let res: Response;
      if (oauthFlow) {
        if (!oauthBundle) {
          throw connectionDisplayError(
            strictLocal,
            "Güvenli oturum hâlâ hazırlanıyor. Biraz bekleyip yeniden deneyin.",
            "Güvenli oturum açma hâlâ hazırlanıyor. Biraz bekleyip yeniden deneyin.",
          );
        }
        const authorization = parsePastedCode(pasted);
        if (!authorization.code || !authorization.state) {
          throw connectionDisplayError(
            strictLocal,
            "Claude tarafından gösterilen yetkilendirme kodunun tamamını #state son ekiyle birlikte yapıştırın.",
            "Claude'un verdiği yetkilendirme kodunu #state ekiyle birlikte eksiksiz yapıştırın.",
          );
        }
        if (authorization.state !== oauthBundle.state) {
          throw connectionDisplayError(
            strictLocal,
            "Bu kod önceki bir oturum açma denemesine ait. Claude oturumunu yeniden açıp yeni kodu yapıştırın.",
            "Bu kod daha eski bir oturum açma denemesine ait. Claude oturum açma sayfasını yeniden açıp yeni kodu yapıştırın.",
          );
        }
        res = await fetch("/api/connect/oauth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: authorization.code,
            state: authorization.state,
            verifier: oauthBundle.verifier,
            expectedAccountId: reconnectAccount?.id,
          }),
          signal: controller.signal,
        });
      } else {
        const parsed = parseCredentials(pasted);
        if (!parsed) {
          throw new Error(
            "Bunu okuyamadım. \"accessToken\" içeren tam Claude Code kimlik JSON'unu yapıştırın.",
          );
        }
        res = await fetch("/api/connect/manual", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tokens: parsed.tokens, expectedAccountId: reconnectAccount?.id }),
          signal: controller.signal,
        });
      }
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        errorId?: unknown;
        email?: string;
        plan?: string;
        label?: string;
      };
      if (res.status === 401 && data.error === "Not signed in") {
        window.location.href = "/login";
        return;
      }
      if (!res.ok) {
        throw strictLocal && oauthFlow
          ? new StrictLocalDisplayError(
              strictLocalClaudeConnectionErrorText(res.status, data.error, data.errorId),
            )
          : new Error(
              serverErrorText(
                data.error,
                res.status === 401
                  ? oauthFlow
                    ? "Claude bu yetkilendirme kodunu kabul etmedi. Yeni bir oturum açıp yeniden deneyin."
                    : "Bu paylaşılan oturum yenilenmiş olabilir. Yeni bir kimlik bilgisi kopyalayıp yeniden deneyin."
                  : "Claude bağlantısı tamamlanamadı.",
                data.errorId,
              ),
            );
      }
      if (oauthFlow) clearPkce();
      finishServerConnect({
        email: data.email ?? reconnectAccount?.email ?? "hesabınız",
        plan: data.plan,
        label: data.label,
      });
    } catch (err) {
      if (!closedRef.current) {
        setError(
          err instanceof Error && err.name === "AbortError"
            ? "Bağlantı 30 saniye içinde tamamlanamadı. Bağlantınızı denetleyip yeniden deneyin."
            : strictLocal && err instanceof StrictLocalDisplayError
              ? err.message
              : strictLocal
                ? "Claude bağlantısı tamamlanamadı. Yeniden deneyin."
                : err instanceof Error
              ? err.message
              : "Bir şeyler ters gitti — yeniden deneyin.",
        );
      }
    } finally {
      clearTimeout(timeout);
      if (operationController.current === controller) operationController.current = null;
      if (operationRef.current === operation) operationRef.current = null;
      if (!closedRef.current) setWorking(false);
    }
  }, [credentialMethod, finishServerConnect, oauthBundle, pasted, reconnectAccount, strictLocal, working]);

  // OpenAI: one-click read of this machine's ~/.codex/auth.json.
  const connectOpenAILocal = useCallback(async () => {
    if (localWorking || operationRef.current) return;
    const controller = new AbortController();
    operationController.current = controller;
    operationRef.current = "local";
    setLocalWorking(true);
    setLocalError(null);
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch("/api/connect/local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "openai", expectedAccountId: reconnectAccount?.id }),
        signal: controller.signal,
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        email?: string;
        plan?: string;
        label?: string;
        error?: string;
        errorId?: unknown;
        recommendation?: string;
      };
      if (!res.ok) {
        setLocalError({
          message: strictLocal
            ? strictLocalOpenAILocalConnectionErrorText("provider", data.error, data.errorId)
            : errText(data.error, "Bu makinedeki Codex oturumu okunamadı."),
          recommendation: undefined,
        });
        return;
      }
      finishServerConnect({ email: data.email ?? "ChatGPT hesabınız", plan: data.plan, label: data.label });
    } catch (connectError) {
      if (!closedRef.current) {
        setLocalError({
          message:
            connectError instanceof Error && connectError.name === "AbortError"
              ? strictLocal
                ? strictLocalOpenAILocalConnectionErrorText("timeout", undefined, undefined)
                : "Bağlantı 30 saniyede zaman aşımına uğradı. Uygulamanın çalıştığını denetleyip yeniden deneyin."
              : strictLocal
                ? strictLocalOpenAILocalConnectionErrorText("network", undefined, undefined)
                : "Ağ hatası — uygulama hâlâ çalışıyor mu?",
        });
      }
    } finally {
      clearTimeout(timeout);
      if (operationController.current === controller) operationController.current = null;
      if (operationRef.current === "local") operationRef.current = null;
      if (!closedRef.current) setLocalWorking(false);
    }
  }, [localWorking, finishServerConnect, reconnectAccount?.id, strictLocal]);

  // Grok: paste the grok.com session → parse client-side → verify + save server-side.
  // xAI refuses quota reads from OAuth tokens (403 oauth2-auth-forbidden), so a browser session
  // is the only credential that can read remaining queries. See lib/providers/grok.ts.
  const connectGrokPaste = useCallback(async () => {
    if (strictLocal || !pasted.trim() || working || operationRef.current) return;
    const controller = new AbortController();
    operationController.current = controller;
    operationRef.current = "manual";
    setWorking(true);
    setError(null);
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const tokens = parseGrokSession(pasted);
      if (!tokens) {
        throw new Error("Bunu okuyamadım. grok.com çerezlerindeki `sso` değerini yapıştırın.");
      }
      const res = await fetch("/api/connect/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "grok", tokens, expectedAccountId: reconnectAccount?.id }),
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        email?: string;
        plan?: string;
        label?: string;
      };
      if (!res.ok) throw new Error(data.error || "Grok oturumu doğrulanamadı.");
      setPasted("");
      finishServerConnect({ email: data.email ?? "", plan: data.plan, label: data.label });
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : "Grok oturumu doğrulanamadı.");
      }
    } finally {
      clearTimeout(timeout);
      operationController.current = null;
      if (operationRef.current === "manual") operationRef.current = null;
      setWorking(false);
    }
  }, [pasted, working, strictLocal, reconnectAccount?.id, finishServerConnect]);

  // OpenAI: paste ~/.codex/auth.json → parse client-side → verify + save server-side.
  const connectOpenAIPaste = useCallback(async () => {
    if (strictLocal || !pasted.trim() || working || operationRef.current) return;
    const controller = new AbortController();
    operationController.current = controller;
    operationRef.current = "manual";
    setWorking(true);
    setError(null);
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const tokens = parseCodexCredential(pasted);
      if (!tokens) {
        throw new Error("Bunu okuyamadım. \"access_token\" içeren tam ~/.codex/auth.json içeriğini yapıştırın.");
      }
      const res = await fetch("/api/connect/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "openai", tokens, expectedAccountId: reconnectAccount?.id }),
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        errorId?: unknown;
        email?: string;
        plan?: string;
        label?: string;
      };
      if (res.status === 401 && data.error === "Not signed in") {
        window.location.href = "/login";
        return;
      }
      if (!res.ok) {
        throw new Error(
          serverErrorText(
            data.error,
            res.status === 401
              ? "Bu ChatGPT oturumunun süresi dolmuş ya da yenilenmiş. Güncel ~/.codex/auth.json içeriğini yapıştırın."
              : "ChatGPT hesabı bağlanamadı.",
            data.errorId,
          ),
        );
      }
      finishServerConnect({
        email: data.email ?? reconnectAccount?.email ?? "ChatGPT hesabınız",
        plan: data.plan,
        label: data.label,
      });
    } catch (err) {
      if (!closedRef.current) {
        setError(
          err instanceof Error && err.name === "AbortError"
            ? "Bağlantı 30 saniyede zaman aşımına uğradı. Bağlantınızı denetleyip yeniden deneyin."
            : err instanceof Error
              ? err.message
              : "Bir şeyler ters gitti — yeniden deneyin.",
        );
      }
    } finally {
      clearTimeout(timeout);
      if (operationController.current === controller) operationController.current = null;
      if (operationRef.current === "manual") operationRef.current = null;
      if (!closedRef.current) setWorking(false);
    }
  }, [finishServerConnect, pasted, reconnectAccount, strictLocal, working]);

  if (!open) return null;
  const requestBusy = working || localWorking || deviceBusy || pairStarting || pairState === "processing";
  const command = DUMP_COMMANDS[os];
  const oauthUrl = oauthBundle ? buildAuthorizeUrl(oauthBundle) : null;

  const successCard = connected && (
    <AddAccountSuccessCard
      strictLocal={strictLocal}
      connected={connected}
      completionError={completionError}
      onRetry={() => void reloadAndClose()}
    />
  );

  // The private app-owned OAuth flow is primary. Importing the CLI's current rotating credential is
  // retained only as an explicit legacy option for environments where browser sign-in is impossible.
  const pasteBlock = (
    <div className="space-y-5">
      <div className="flex gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-coral/15 text-xs font-semibold text-coral-bright">
          1
        </span>
        <div className="min-w-0 flex-1">
          <p ref={pasteHeadingRef} tabIndex={-1} className="text-sm text-ivory outline-none">
            {credentialMethod === "private-login" ? "Bu pano için özel oturumu yetkilendir" : "Geçerli Claude Code oturumunu kopyala"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            {credentialMethod === "private-login"
              ? "Claude ile bir kez oturum açın. Uygulama kendi yenilenebilir oturumunu şifreli saklar ve Claude Code oturumuna dokunmadan yeniler."
              : "Bu hızlı yöntem Claude Code'un yenilenen oturumunu kopyalar. CLI ve pano birbirinin oturumunu geçersiz kılabileceği için özel uygulama oturumu daha güvenilirdir."}
          </p>
          {credentialMethod === "private-login" && (
            <>
              <p className="mt-2 inline-flex rounded-full border border-coral/35 bg-coral/10 px-2.5 py-1 text-[11px] font-medium text-coral-bright">
                {"Önerilen · bir kez bağla · otomatik yenilenir"}
              </p>
              <a
                href={oauthUrl ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                aria-disabled={!oauthUrl || requestBusy}
                onClick={(event) => {
                  if (!oauthUrl || requestBusy) {
                    event.preventDefault();
                    return;
                  }
                  setPasted("");
                  setError(null);
                  setOauthOpened(true);
                }}
                className={`mt-3 ${PRIMARY_LINK} ${!oauthUrl || requestBusy ? "pointer-events-none opacity-50" : ""}`}
              >
                Güvenli Claude oturum açma sayfasını aç
              </a>
              <p className="mt-2 text-[11px] leading-relaxed text-faint">
                Claude yeni sekmede açılır ve tek kullanımlık yetkilendirme kodu verir. <code>claude setup-token</code>{" "}
                belirteci kullanım kontrollerini desteklemediği için burada kullanılamaz.
              </p>
              {oauthOpened && (
                <p role="status" className="mt-2 text-[11px] leading-relaxed text-muted">
                  {"Oturum açma sayfası açıldı. Erişimi onaylayıp Claude tarafından gösterilen kodun tamamını kopyalayın."}
                </p>
              )}
            </>
          )}
          {credentialMethod === "existing-session" && (
            <>
              <div className="mt-2.5 inline-flex rounded-lg border border-border p-0.5">
                {(Object.keys(OS_LABELS) as OS[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    disabled={requestBusy}
                    onClick={() => {
                      setOs(key);
                      setCopied(false);
                      setCopyError(null);
                    }}
                    aria-pressed={os === key}
                    className={`min-h-11 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      os === key ? "bg-surface-hover text-ivory" : "text-faint enabled:hover:text-muted"
                    }`}
                  >
                    {OS_LABELS[key]}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex items-stretch gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs text-secondary">
                  {command}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    setCopyError(null);
                    void copyText(command).then(
                      () => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      },
                      () => setCopyError(
                        "Komut kopyalanamadı. Komutu seçip elle kopyalayın.",
                      ),
                    );
                  }}
                  className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-ivory"
                >
                  <CopyIcon className="h-3.5 w-3.5" />
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              {os === "macOS" && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
                  macOS will ask permission to read the keychain — click Allow.
                </p>
              )}
              {copyError && (
                <p role="alert" className="mt-2 text-[11px] leading-relaxed text-[#ff9c95]">
                  {copyError}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-coral/15 text-xs font-semibold text-coral-bright">
          2
        </span>
        <div className="min-w-0 flex-1">
          <label htmlFor="claude-credentials" className="text-sm text-ivory">
            {credentialMethod === "private-login" ? "Yetkilendirme kodunu yapıştır" : "Kimlik bilgisi JSON'unu yapıştır"}
          </label>
          <textarea
            id="claude-credentials"
            aria-label={credentialMethod === "private-login" ? "Claude yetkilendirme kodu" : "Claude Code kimlik bilgileri"}
            value={pasted}
            disabled={requestBusy}
            onChange={(e) => setPasted(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) connectPaste();
            }}
            placeholder={
              credentialMethod === "private-login"
                ? "authorization-code#state"
                : '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-…","refreshToken":"…"}}'
            }
            spellCheck={false}
            autoComplete="off"
            rows={3}
            className="mt-2 w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs text-ivory placeholder:text-faint focus:border-coral/60 focus:outline-none"
          />
          <button
            type="button"
            onClick={connectPaste}
            disabled={!pasted.trim() || requestBusy}
            className={`mt-2 ${PRIMARY_BUTTON}`}
          >
            {working ? "Bağlanıyor…" : credentialMethod === "private-login" ? "Güvenli bağlantıyı tamamla" : "Paylaşılan oturumu bağla"}
          </button>
          {!strictLocal && (
            <button
              type="button"
              disabled={requestBusy}
              onClick={() => {
                setCredentialMethod((current) =>
                  current === "private-login" ? "existing-session" : "private-login",
                );
                setPasted("");
                setError(null);
                setCopied(false);
                setCopyError(null);
                setOauthOpened(false);
              }}
              className="mt-2 inline-flex min-h-11 items-center text-xs font-medium text-muted underline decoration-border underline-offset-4 transition-colors enabled:hover:text-ivory"
            >
              {credentialMethod === "private-login"
                ? "Bu makinedeki Claude Code oturumunu kullan"
                : "Panoya özel oturum kullan (önerilen)"}
            </button>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-[#ff9c95]">
          {error}
        </p>
      )}
    </div>
  );

  // Legacy convenience flows always provide an obvious path back to the isolated app-owned login.
  const pasteFallback = (
    <div className="mt-5 border-t border-border/60 pt-4">
      {showPaste ? (
        pasteBlock
      ) : (
        <button
          type="button"
          onClick={() => {
            stopPolling();
            pairStartGeneration.current += 1;
            pairStartController.current?.abort();
            pairStartController.current = null;
            pairStartPromise.current = null;
            setPairCode(null);
            setPairCommand("");
            setPairState("waiting");
            setCredentialMethod("private-login");
            setOauthOpened(false);
            setPasted("");
            setError(null);
            focusModeAfterSwitch.current = true;
            setShowPaste(true);
          }}
          disabled={requestBusy}
          className="inline-flex min-h-11 items-center text-xs font-medium text-muted underline decoration-border underline-offset-4 transition-colors enabled:hover:text-ivory disabled:cursor-not-allowed disabled:opacity-45"
        >
          {"Özel uygulama oturumuna dön (önerilen)"}
        </button>
      )}
    </div>
  );

  const quickAlternative = mode !== "paste" && showPaste && !connected && (
    <div className="mt-5 rounded-xl border border-border/70 bg-surface/55 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.1em] text-faint">Eski hızlı alternatif</p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">
        {mode === "local"
          ? "Bu makinedeki Claude Code oturumunu kopyalamadan kullanın. CLI ile dönen oturum paylaşılır; süreçlerden biri yenilediğinde bağlantı kesilebilir."
          : "Başka bir makinedeki Claude Code oturumunu eşleştirin. CLI ile dönen oturum paylaşılır; süreçlerden biri yenilediğinde bağlantı kesilebilir."}
      </p>
      <button
        type="button"
        disabled={requestBusy}
        aria-busy={mode === "pair" && pairStarting}
        onClick={() => {
          focusModeAfterSwitch.current = true;
          setShowPaste(false);
          if (mode === "pair") void startPairing();
        }}
        className="mt-3 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border px-3.5 py-2 text-xs font-medium text-ivory transition-colors enabled:hover:bg-surface-hover disabled:opacity-50"
      >
        {mode === "pair" && pairStarting && <SpinnerIcon className="h-4 w-4 animate-spin-slow text-coral" />}
        {mode === "local"
          ? "Bu makinedeki geçerli oturumu kullan"
          : pairStarting
            ? "Eşleştirme kodu alınıyor…"
            : "Cihaz eşleştirme yardımcısını kullan"}
      </button>
    </div>
  );

  const providerPicker = !reconnectAccount && !connected && (
    <div className="mt-5 inline-flex rounded-lg border border-border p-0.5">
      {PROVIDER_ORDER.map((pid) => {
        const meta = PROVIDER_META[pid];
        const Icon = meta.Icon;
        const active = provider === pid;
        return (
          <button
            key={pid}
            type="button"
            disabled={requestBusy}
            aria-pressed={active}
            onClick={() => {
              setProvider(pid);
              setError(null);
              setLocalError(null);
              setPasted("");
            }}
            className={`inline-flex min-h-11 items-center gap-2 rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
              active ? "bg-surface-hover text-ivory" : "text-faint enabled:hover:text-muted"
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {meta.label}
          </button>
        );
      })}
    </div>
  );

  const grokBlock = (
    <div className="mt-5">
      {connected ? (
        successCard
      ) : strictLocal ? (
        <p className="text-sm leading-relaxed text-muted">
          Grok bu yerel kurulumda bağlanamıyor. Kota verisini yalnız bir tarayıcı oturumu okuyabiliyor
          ve strict-local mod dışarıdan kimlik yapıştırmayı kabul etmiyor. Grok&apos;u barındırılan
          sürümden bağlayın.
        </p>
      ) : (
        <div className="space-y-4">
          <div>
            <label htmlFor="grok-session" className="text-sm text-ivory">
              Grok kimliğini yapıştırın
            </label>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              <strong className="font-semibold text-ivory">Önerilen:</strong> Grok CLI kuruluysa
              {" "}<span className="font-mono">~/.grok/auth.json</span> dosyasının tamamını yapıştırın. Kapsamı dar
              bir token&apos;dır ve süresi dolunca <span className="font-mono">grok login</span> ile yenilenir.
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              <strong className="font-semibold text-ivory">Alternatif:</strong> grok.com açıkken
              {" "}<span className="font-mono">F12</span> → <span className="font-mono">Application</span>
              {" → "}<span className="font-mono">Cookies</span> → <span className="font-mono">https://grok.com</span> →
              {" "}<span className="font-mono">sso</span> satırının değeri. Şifreli saklanır ve bir daha gösterilmez.
            </p>
            <p className="mt-2 text-xs leading-relaxed text-[#e3b56e]">
              <span className="font-mono">sso</span> bir oturum çerezidir: kapsamı dar bir token değil, Grok
              hesabınızın tamamına erişim. Süresi dolduğunda kart yeniden bağlanma ister ve yenileme yolu yoktur —
              xAI kota okumasını OAuth token&apos;larına kapattığı için başka bir yol yok.
            </p>
            <textarea
              id="grok-session"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              disabled={requestBusy}
              rows={3}
              spellCheck={false}
              autoComplete="off"
              className="mt-3 w-full rounded-lg border border-border bg-bg p-3 font-mono text-xs text-ivory outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:opacity-50"
              placeholder={'{"grok.com":{"key":"..."}}  ya da  sso=...'}
            />
          </div>
          <button
            type="button"
            disabled={requestBusy || !pasted.trim()}
            onClick={connectGrokPaste}
            className={`${PRIMARY_LINK} disabled:pointer-events-none disabled:opacity-50`}
          >
            {working ? "Doğrulanıyor…" : "Grok hesabını bağla"}
          </button>
        </div>
      )}
    </div>
  );

  const openaiBlock = (
    <div className="mt-5">
      {connected ? (
        successCard
      ) : (
        <div className="space-y-4">
          <OpenAIDeviceLogin
            expectedAccountId={reconnectAccount?.id}
            disabled={requestBusy}
            onBusyChange={setDeviceBusy}
            onConnected={(account) => {
              finishServerConnect({
                email: account.email,
                plan: account.plan,
                label: account.label,
              });
            }}
          />

          <details className="rounded-xl border border-border/70 bg-surface/55">
            <summary className="min-h-11 cursor-pointer px-4 py-3 text-xs font-medium text-muted transition-colors hover:text-ivory focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]">
              Eski paylaşılan CLI oturumu
            </summary>
            <div className="space-y-4 border-t border-border/60 px-4 pb-4 pt-3">
              <p className="text-xs leading-relaxed text-[#e3b56e]">
                Codex CLI yenilemesi panonun bağlantısını kesebilir. Bu seçeneği yalnızca özel oturum kullanılamıyorsa kullanın.
              </p>

              {mode === "local" ? (
                <OpenAILocalMachinePanel
                  strictLocal={strictLocal}
                  busy={requestBusy}
                  working={localWorking}
                  error={localError}
                  onConnect={connectOpenAILocal}
                  actionRef={localActionRef}
                />
              ) : null}

              {!strictLocal ? (
                <div className={mode === "local" ? "border-t border-border/60 pt-4" : ""}>
                  <label htmlFor="openai-cli-credentials" className="text-sm text-ivory">
                    {mode === "local" ? "Ya da ~/.codex/auth.json içeriğini yapıştırın" : "~/.codex/auth.json içeriğini yapıştırın"}
                  </label>
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    <code className="rounded bg-bg px-1 py-0.5 font-mono">cat ~/.codex/auth.json</code> çıktısının
                    tamamını yapıştırın. Jetonlar şifreli saklanır, bir daha gösterilmez.
                  </p>
                  <textarea
                    id="openai-cli-credentials"
                    value={pasted}
                    disabled={requestBusy}
                    onChange={(event) => {
                      setPasted(event.target.value);
                      setError(null);
                    }}
                    spellCheck={false}
                    autoComplete="off"
                    rows={4}
                    placeholder={'{ "tokens": { "access_token": "…", "refresh_token": "…" } }'}
                    className="mt-2 w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs text-secondary outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    type="button"
                    onClick={connectOpenAIPaste}
                    disabled={!pasted.trim() || requestBusy}
                    className={`mt-3 ${PRIMARY_BUTTON}`}
                  >
                    {working ? <SpinnerIcon className="h-4 w-4 animate-spin-slow" /> : null}
                    {working ? "Bağlanıyor…" : "Paylaşılan ChatGPT oturumunu bağla"}
                  </button>
                  {error ? (
                    <p role="alert" className="mt-2 text-[11px] leading-relaxed text-[#ff9c95]">
                      {error}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </details>
        </div>
      )}
    </div>
  );

  return (
    <ModalShell
      open={open}
      title={reconnectAccount ? `${reconnectAccount.label || reconnectAccount.email} hesabını yeniden bağla` : "Hesap bağla"}
      description={
        reconnectAccount
          ? "Bu hesabı, panodaki kimliğini değiştirmeden süresi dolan oturumunu yenilemek için yeniden yetkilendirin."
          : undefined
      }
      onClose={onClose}
      dismissible={!requestBusy && (!connected || Boolean(completionError))}
    >
      <div className="contents" data-provider={provider}>
      {providerPicker}
      {provider === "openai" ? (
        openaiBlock
      ) : provider === "grok" ? (
        grokBlock
      ) : (
      <div className="mt-5">
          {(mode === "paste" || showPaste) && !connected && pasteBlock}
          {quickAlternative}

          {mode === "local" && (connected || !showPaste) && (
            <div>
              {connected ? (
                successCard
              ) : (
                <>
                  <ClaudeLocalMachinePanel
                    strictLocal={strictLocal}
                    busy={requestBusy}
                    working={localWorking}
                    error={localError}
                    onConnect={connectLocal}
                    actionRef={localActionRef}
                  />
                  {pasteFallback}
                </>
              )}
            </div>
          )}

          {mode === "pair" && (connected || !showPaste) && (
            <div>
              {connected ? (
                successCard
              ) : (
                <>
                  <ClaudePairingPanel
                    strictLocal={strictLocal}
                    state={pairStarting ? "starting" : pairState}
                    command={pairCommand}
                    error={pairError}
                    busy={requestBusy}
                    copied={pairCopied}
                    copyError={pairCopyError}
                    headingRef={pairHeadingRef}
                    onCopy={() => {
                      setPairCopyError(null);
                      void copyText(pairCommand).then(
                        () => {
                          setPairCopied(true);
                          setTimeout(() => setPairCopied(false), 2000);
                        },
                        () => setPairCopyError(
                          "Komut kopyalanamadı. Komutu seçip elle kopyalayın.",
                        ),
                      );
                    }}
                    onRetry={() => void startPairing()}
                  />
                  {pasteFallback}
                </>
              )}
            </div>
          )}

          <p className="mt-5 border-t border-border/60 pt-4 text-[11px] leading-relaxed text-faint">
              {"Kimlik bilgileri şifreli yerel kasanızda saklanır ve yalnızca Anthropic hesap kontrolleri için kullanılır. Önerilen oturumun kendine ait yenilenebilir oturumu vardır; normal Claude Code CLI bunu döndüremez. Hızlı bağlantı, CLI'ın paylaşılan oturumunu içe aktarır ve başka bir süreç önce yenilerse değiştirilmesi gerekebilir."}
          </p>
      </div>
      )}
      </div>
    </ModalShell>
  );
}
