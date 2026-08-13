"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { NotifyConfig, NotifySettings } from "@/lib/notify-client";
import type { LocalNotifyRuntimeStatus } from "@/lib/local-notify-coordinator";
import {
  localNotificationPermission,
  requestLocalNotificationPermission,
  type LocalDeliveryResult,
} from "@/lib/local-notify-delivery";
import { loadSettings, saveSettings, type Settings } from "@/lib/storage";
import { ModalShell } from "./ModalShell";

interface NotificationsPanelProps {
  open: boolean;
  onClose: () => void;
  strictLocal: boolean;
  autoRefresh: boolean;
  localStatus: LocalNotifyRuntimeStatus;
}

const DEFAULT_CONFIG: NotifyConfig = {
  recovery: true,
  warning: true,
  everyReset: false,
  warnThreshold: 90,
  recoveryThreshold: 80,
};

type PushState = "loading" | "on" | "off" | "denied" | "unsupported" | "error";

type HostedPushClient = Pick<
  typeof import("@/lib/notify-client"),
  "pushSupported" | "currentPushSubscription"
>;

interface HostedPushStatus {
  state: Exclude<PushState, "loading">;
  message: string | null;
}

export async function readHostedPushStatus(
  loadClient: () => Promise<HostedPushClient> = async () => await import("@/lib/notify-client"),
  readPermission: () => NotificationPermission = () => Notification.permission,
): Promise<HostedPushStatus> {
  try {
    const hosted = await loadClient();
    if (!hosted.pushSupported()) return { state: "unsupported", message: null };
    if (readPermission() === "denied") return { state: "denied", message: null };
    const subscription = await hosted.currentPushSubscription();
    return { state: subscription ? "on" : "off", message: null };
  } catch {
    return {
      state: "error",
      message: "Bu tarayıcının bildirim aboneliği denetlenemedi.",
    };
  }
}

export type LocalPermissionRequestStatus =
  | NotificationPermission
  | "unsupported"
  | "worker_error";

export async function resolveLocalPermissionRequest(
  requestPermission: () => Promise<LocalDeliveryResult> = requestLocalNotificationPermission,
  readPermission: () => NotificationPermission | "unsupported" = localNotificationPermission,
): Promise<LocalPermissionRequestStatus> {
  let result: LocalDeliveryResult;
  try {
    result = await requestPermission();
  } catch {
    result = { ok: false, reason: "worker", message: "Local notification delivery failed." };
  }

  let actual: NotificationPermission | "unsupported";
  try {
    actual = readPermission();
  } catch {
    return "worker_error";
  }
  if (actual !== "default") return actual;
  if (!result.ok && (result.reason === "worker" || result.reason === "timeout")) {
    return "worker_error";
  }
  return "default";
}

interface ThresholdValidation {
  warnThreshold: number | null;
  recoveryThreshold: number | null;
  warnError: string | null;
  recoveryError: string | null;
  relationError: string | null;
  valid: boolean;
}

function parseThreshold(label: string, value: string): { value: number | null; error: string | null } {
  const trimmed = value.trim();
  if (!trimmed) return { value: null, error: `Enter a ${label.toLowerCase()}.` };
  if (!/^\d+$/.test(trimmed)) {
    return { value: null, error: `${label} must be a whole number from 1 to 100.` };
  }
  const parsed = Number(trimmed);
  if (parsed < 1 || parsed > 100) {
    return { value: null, error: `${label} must be from 1 to 100.` };
  }
  return { value: parsed, error: null };
}

function validateThresholds(warnDraft: string, recoveryDraft: string): ThresholdValidation {
  const warn = parseThreshold("Warning threshold", warnDraft);
  const recovery = parseThreshold("Recovery threshold", recoveryDraft);
  const relationError =
    warn.value !== null && recovery.value !== null && recovery.value >= warn.value
      ? "Recovery threshold must be lower than warning threshold."
      : null;
  return {
    warnThreshold: warn.value,
    recoveryThreshold: recovery.value,
    warnError: warn.error,
    recoveryError: recovery.error,
    relationError,
    valid: !warn.error && !recovery.error && !relationError,
  };
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      disabled={disabled}
      className="flex w-full items-start justify-between gap-4 rounded-xl border border-border bg-bg px-4 py-3 text-left transition-colors enabled:hover:border-border-light disabled:cursor-not-allowed disabled:opacity-55"
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ivory">{label}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted">{description}</span>
      </span>
      <span
        aria-hidden="true"
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? "bg-coral" : "bg-track"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-ivory transition-transform ${
            checked ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </span>
    </button>
  );
}

function LocalNotificationsPanel({
  open,
  onClose,
  autoRefresh,
  localStatus,
}: Omit<NotificationsPanelProps, "strictLocal">) {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    () => localNotificationPermission(),
  );
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionRequestFailed, setPermissionRequestFailed] = useState(false);
  const [storageError, setStorageError] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSettings(loadSettings());
    setPermission(localNotificationPermission());
    setPermissionRequestFailed(false);
    setStorageError(false);
  }, [open]);

  const updateRules = useCallback((next: Settings["localNotifications"]) => {
    const current = loadSettings();
    const nextSettings = { ...current, localNotifications: next };
    if (!saveSettings(nextSettings)) {
      setStorageError(true);
      return;
    }
    setSettings(nextSettings);
    setStorageError(false);
  }, []);

  const requestPermission = useCallback(async () => {
    if (permissionBusy || permission !== "default") return;
    setPermissionBusy(true);
    try {
      const status = await resolveLocalPermissionRequest();
      if (status === "worker_error") {
        setPermissionRequestFailed(true);
      } else {
        setPermission(status);
        setPermissionRequestFailed(false);
      }
    } finally {
      setPermissionBusy(false);
    }
  }, [permission, permissionBusy]);

  const statusMessage = storageError || localStatus === "storage_error"
    ? "Yerel bildirim ayarları bu cihazda saklanamadı."
    : permission === "unsupported"
      ? "Bu tarayıcı yerel bildirimleri desteklemiyor."
      : permission === "denied"
        ? "Bildirim izni engellendi; tarayıcı ayarlarından izin verin."
        : permissionRequestFailed || localStatus === "worker_error"
          ? "Yerel bildirim çalışanına ulaşılamadı."
          : localStatus === "lock_unavailable"
            ? "Yerel bildirimler başka bir sekmede işleniyor."
            : permission === "granted"
              ? "Bu cihazda yerel bildirimler hazır."
              : "Bildirimler yalnızca aşağıdaki düğmeye bastığınızda izin ister.";

  return (
    <ModalShell
      open={open}
      title="Bildirimler"
      description="Limit geçişlerini yalnızca bu cihazda takip edin."
      onClose={onClose}
      dismissible={!permissionBusy}
    >
      <div className="mt-5 space-y-4">
        <section className="rounded-xl border border-border bg-bg p-4" aria-labelledby="local-device-heading">
          <div className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <h3 id="local-device-heading" className="text-sm font-medium text-ivory">Bu cihaz</h3>
              <span className="mt-1 block text-xs leading-relaxed text-muted" aria-live="polite">
                {statusMessage}
              </span>
            </span>
            <button
              type="button"
              onClick={() => {
                void requestPermission().catch(() => setPermissionRequestFailed(true));
              }}
              disabled={permissionBusy || permission !== "default"}
              className="min-h-11 shrink-0 rounded-lg bg-coral px-3.5 py-1.5 text-sm font-medium text-white enabled:hover:bg-coral-pressed disabled:opacity-45"
            >
              {permissionBusy ? "İsteniyor…" : "Bildirim izni ver"}
            </button>
          </div>
        </section>

        {!autoRefresh && (
          <p className="rounded-xl border border-[#e3b56e]/35 bg-[#e3b56e]/10 px-4 py-3 text-xs leading-relaxed text-[#f0c47d]" role="status">
          Otomatik okumalar durdu; Yenile komutu kuralları çalıştırmaya devam eder.
          </p>
        )}

        <fieldset className="space-y-2">
          <legend className="text-[11px] font-medium uppercase tracking-wide text-faint">Yerel kurallar</legend>
          <Toggle
            checked={settings.localNotifications.remainingWarnings}
            onChange={() => updateRules({
              ...settings.localNotifications,
              remainingWarnings: !settings.localNotifications.remainingWarnings,
            })}
            label="Kalan limit uyarıları"
            description="Sabit kalan-limit eşiklerini geçince bu cihazda bildirir."
          />
          <div className="overflow-hidden rounded-xl border border-border bg-bg px-4 py-3" aria-label="Kalan limit uyarı ölçeği">
            <div aria-hidden="true" className="relative mb-2 h-2 rounded-full bg-track">
              <span className="absolute inset-y-0 left-0 w-1/2 rounded-full bg-coral/75" />
              {[0, 5, 10, 15, 20, 30, 40, 50].map((threshold) => (
                <span
                  key={threshold}
                  className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-ivory/75"
                  style={{ left: `${threshold}%` }}
                />
              ))}
            </div>
            <p className="text-center text-xs tabular-nums tracking-wide text-muted">
              50 · 40 · 30 · 20 · 15 · 10 · 5 · bitti
            </p>
          </div>
          <Toggle
            checked={settings.localNotifications.resetNotifications}
            onChange={() => updateRules({
              ...settings.localNotifications,
              resetNotifications: !settings.localNotifications.resetNotifications,
            })}
            label="Limit sıfırlanınca bildir"
            description="Doğrulanmış yeni sıfırlama zamanı geldiğinde bu cihazda bildirir."
          />
        </fieldset>

        <p className="border-t border-border/60 pt-4 text-[11px] leading-relaxed text-faint">
          Bu cihazdaki yerel bildirimler yalnızca ayrılmış pencere açık veya simge durumuna küçültülmüşken çalışır; otomatik ve elle yenilenen okumaları kullanır. Hesap verileri bir bildirim servisine gönderilmez.
        </p>
      </div>
    </ModalShell>
  );
}

export function NotificationsPanel(props: NotificationsPanelProps) {
  if (props.strictLocal) {
    return (
      <LocalNotificationsPanel
        open={props.open}
        onClose={props.onClose}
        autoRefresh={props.autoRefresh}
        localStatus={props.localStatus}
      />
    );
  }
  return <HostedNotificationsPanel open={props.open} onClose={props.onClose} />;
}

function HostedNotificationsPanel({ open, onClose }: Pick<NotificationsPanelProps, "open" | "onClose">) {
  const warnInputId = useId();
  const recoveryInputId = useId();
  const warnErrorId = useId();
  const recoveryErrorId = useId();
  const relationErrorId = useId();
  const pushStatusId = useId();

  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settings, setSettings] = useState<NotifySettings | null>(null);
  const [config, setConfig] = useState<NotifyConfig>(DEFAULT_CONFIG);
  const [savedConfig, setSavedConfig] = useState<NotifyConfig | null>(null);
  const [warnDraft, setWarnDraft] = useState(String(DEFAULT_CONFIG.warnThreshold));
  const [recoveryDraft, setRecoveryDraft] = useState(String(DEFAULT_CONFIG.recoveryThreshold));
  const [pushState, setPushState] = useState<PushState>("loading");
  const [pushError, setPushError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const generationRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const draftVersionRef = useRef(0);

  const validation = useMemo(() => validateThresholds(warnDraft, recoveryDraft), [warnDraft, recoveryDraft]);
  const dirty = useMemo(() => {
    if (!savedConfig) return false;
    return (
      config.recovery !== savedConfig.recovery ||
      config.warning !== savedConfig.warning ||
      config.everyReset !== savedConfig.everyReset ||
      warnDraft.trim() !== String(savedConfig.warnThreshold) ||
      recoveryDraft.trim() !== String(savedConfig.recoveryThreshold)
    );
  }, [config, recoveryDraft, savedConfig, warnDraft]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const refreshPushState = useCallback(async (generation: number) => {
    if (generationRef.current !== generation) return;
    setPushState("loading");
    setPushError(null);
    const status = await readHostedPushStatus();
    if (generationRef.current !== generation) return;
    setPushState(status.state);
    setPushError(status.message);
  }, []);

  const loadPanel = useCallback(() => {
    const generation = ++generationRef.current;
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);

    setLoading(true);
    setLoadFailed(false);
    setLoadError(null);
    setSettings(null);
    setSavedConfig(null);
    setActionError(null);
    setSaved(false);
    setBusy(false);
    setSaving(false);
    setConfirmDiscard(false);

    void import("@/lib/notify-client")
      .then((hosted) => hosted.fetchNotifySettings(controller.signal))
      .then((nextSettings) => {
        if (generationRef.current !== generation) return;
        const nextConfig = nextSettings.config ?? DEFAULT_CONFIG;
        setSettings(nextSettings);
        setConfig(nextConfig);
        setSavedConfig(nextConfig);
        setWarnDraft(String(nextConfig.warnThreshold));
        setRecoveryDraft(String(nextConfig.recoveryThreshold));
      })
      .catch((error) => {
        if (controller.signal.aborted || generationRef.current !== generation) return;
        setLoadFailed(true);
        setLoadError(messageFrom(error, "Couldn't load notification settings."));
      })
      .finally(() => {
        if (generationRef.current === generation) setLoading(false);
      });
    void refreshPushState(generation).catch(() => {
      if (generationRef.current !== generation) return;
      setPushState("error");
      setPushError("Bu tarayıcının bildirim aboneliği denetlenemedi.");
    });
  }, [refreshPushState]);

  useEffect(() => {
    if (!open) return;
    loadPanel();
    return () => {
      generationRef.current += 1;
      loadControllerRef.current?.abort();
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, [loadPanel, open]);

  useEffect(() => {
    if (!confirmDiscard) return;
    const frame = requestAnimationFrame(() => keepEditingRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [confirmDiscard]);

  const togglePush = useCallback(async () => {
    if (busy || !settings?.vapidPublicKey) return;
    const generation = generationRef.current;
    setBusy(true);
    setPushError(null);
    try {
      if (pushState === "error") {
        await refreshPushState(generation);
      } else if (pushState === "on") {
        const hosted = await import("@/lib/notify-client");
        await hosted.disablePush();
        if (generationRef.current === generation) setPushState("off");
      } else {
        const hosted = await import("@/lib/notify-client");
        const result = await hosted.enablePush(settings.vapidPublicKey);
        if (generationRef.current !== generation) return;
        if (result.ok) {
          setPushState("on");
        } else {
          await refreshPushState(generation);
          if (generationRef.current === generation) {
            setPushError(result.message ?? "Couldn't enable notifications.");
          }
        }
      }
    } catch {
      if (generationRef.current === generation) {
        setPushState("error");
        setPushError("Couldn't update push notifications.");
      }
    } finally {
      if (generationRef.current === generation) setBusy(false);
    }
  }, [busy, pushState, refreshPushState, settings]);

  const resetChanges = useCallback(() => {
    if (!savedConfig) return;
    draftVersionRef.current += 1;
    setConfig(savedConfig);
    setWarnDraft(String(savedConfig.warnThreshold));
    setRecoveryDraft(String(savedConfig.recoveryThreshold));
    setActionError(null);
    setSaved(false);
    setConfirmDiscard(false);
  }, [savedConfig]);

  const save = useCallback(async () => {
    if (saving || !dirty || !validation.valid || validation.warnThreshold === null || validation.recoveryThreshold === null) {
      return;
    }
    const generation = generationRef.current;
    const draftVersion = draftVersionRef.current;
    const draftConfig: NotifyConfig = {
      ...config,
      warnThreshold: validation.warnThreshold,
      recoveryThreshold: validation.recoveryThreshold,
    };
    setSaving(true);
    setActionError(null);
    setSaved(false);
    try {
      const { saveNotifyConfig } = await import("@/lib/notify-client");
      const next = await saveNotifyConfig(draftConfig);
      if (generationRef.current !== generation) return;
      setSavedConfig(next);
      const draftUnchanged = draftVersionRef.current === draftVersion;
      if (draftUnchanged) {
        setConfig(next);
        setWarnDraft(String(next.warnThreshold));
        setRecoveryDraft(String(next.recoveryThreshold));
      }
      setSaved(draftUnchanged);
      setConfirmDiscard(false);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      if (draftUnchanged) {
        savedTimerRef.current = setTimeout(() => {
          if (generationRef.current === generation) setSaved(false);
        }, 2000);
      }
    } catch (error) {
      if (generationRef.current === generation) {
        setActionError(messageFrom(error, "Bildirim ayarları kaydedilemedi."));
      }
    } finally {
      if (generationRef.current === generation) setSaving(false);
    }
  }, [config, dirty, saving, validation]);

  const requestClose = useCallback(() => {
    if (dirtyRef.current) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }, [onClose]);

  const discardAndClose = useCallback(() => {
    resetChanges();
    onClose();
  }, [onClose, resetChanges]);

  const ready = settings?.ready ?? false;
  const pushDescription =
    pushState === "on"
      ? "Açık — bu tarayıcı uyarı alacak."
      : pushState === "denied"
        ? "Bu tarayıcının site ayarlarında engellenmiş."
        : pushState === "unsupported"
          ? "This browser doesn't support web push."
          : pushState === "loading"
            ? "Bu tarayıcı denetleniyor…"
            : pushState === "error"
              ? "Bu tarayıcının geçerli aboneliği belirlenemedi."
              : "Bu cihaz için kapalı.";

  return (
    <ModalShell
      open={open}
      title="Notifications"
      description="Get pinged when a limit resets or runs hot."
      onClose={requestClose}
      dismissible={!busy && !saving}
    >
      {loading ? (
        <div className="mt-6" role="status" aria-label="Loading notification settings">
          <span className="sr-only">Loading notification settings…</span>
          <div className="space-y-3" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div key={index} className="skeleton h-14 w-full rounded-xl" />
            ))}
          </div>
        </div>
      ) : loadFailed ? (
        <div
          className="mt-6 rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm leading-relaxed text-[#ea7b74]"
          role="alert"
        >
          {loadError ?? "Couldn't load notification settings."}
          <button
            type="button"
            onClick={loadPanel}
            className="mt-3 block min-h-11 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ivory transition-colors hover:bg-surface-hover"
          >
            Retry
          </button>
        </div>
      ) : !ready ? (
        <p className="mt-6 rounded-xl border border-border bg-bg p-4 text-sm leading-relaxed text-muted">
          Notifications need a Convex backend (the scheduler and device subscriptions live there). Set{" "}
          <code className="text-secondary">CONVEX_URL</code> and{" "}
          <code className="text-secondary">VAULT_ACCESS_SECRET</code>, then deploy the functions in{" "}
          <code className="text-secondary">./convex</code>. See{" "}
          <code className="text-secondary">.env.example</code>.
        </p>
      ) : (
        <div className="mt-5 space-y-5">
          <section aria-labelledby={`${pushStatusId}-heading`}>
            <h3 id={`${pushStatusId}-heading`} className="text-[11px] font-medium uppercase tracking-wide text-faint">
              This device
            </h3>
            {!settings?.pushConfigured ? (
              <p className="mt-2 rounded-xl border border-border bg-bg p-3 text-xs leading-relaxed text-muted">
                Web push isn&apos;t configured on the server (no VAPID keys). Telegram and webhook alerts still work
                if you set those. See <code className="text-secondary">.env.example</code> to enable push.
              </p>
            ) : (
              <div className="mt-2 rounded-xl border border-border bg-bg px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <span className="min-w-0 text-sm text-ivory">
                    Push notifications
                    <span id={pushStatusId} className="mt-0.5 block text-xs text-muted" aria-live="polite">
                      {pushDescription}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={togglePush}
                    disabled={
                      busy ||
                      pushState === "loading" ||
                      pushState === "denied" ||
                      pushState === "unsupported"
                    }
                    aria-describedby={pushStatusId}
                    className={`min-h-11 shrink-0 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors disabled:opacity-40 ${
                      pushState === "on"
                        ? "border border-border text-muted enabled:hover:bg-surface-hover enabled:hover:text-ivory"
                        : "bg-coral text-white enabled:hover:bg-coral-pressed"
                    }`}
                  >
                    {busy
                      ? "Working…"
                      : pushState === "on"
                        ? "Disable"
                        : pushState === "error"
                          ? "Check status"
                          : "Enable"}
                  </button>
                </div>
                {pushError && (
                  <p className="mt-2 text-xs leading-relaxed text-[#ea7b74]" role="alert">
                    {pushError}
                  </p>
                )}
              </div>
            )}
          </section>

          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            noValidate
          >
            <fieldset className="space-y-2" disabled={saving}>
              <legend className="text-[11px] font-medium uppercase tracking-wide text-faint">Alert me when</legend>
              <Toggle
                checked={config.recovery}
                onChange={() => {
                  draftVersionRef.current += 1;
                  setConfig((current) => ({ ...current, recovery: !current.recovery }));
                  setSaved(false);
                }}
                label="A maxed-out limit resets"
                description={`A window you'd pushed past ${recoveryDraft || "…"}% has rolled over — you're clear to keep going.`}
                disabled={saving}
              />
              <Toggle
                checked={config.warning}
                onChange={() => {
                  draftVersionRef.current += 1;
                  setConfig((current) => ({ ...current, warning: !current.warning }));
                  setSaved(false);
                }}
                label="I'm approaching a limit"
                description={`Usage crosses ${warnDraft || "…"}% (once per window).`}
                disabled={saving}
              />
              <Toggle
                checked={config.everyReset}
                onChange={() => {
                  draftVersionRef.current += 1;
                  setConfig((current) => ({ ...current, everyReset: !current.everyReset }));
                  setSaved(false);
                }}
                label="Any limit resets"
                description="Her pencere yenilenmesinde, neredeyse hiç kullanmadıklarınızda bile. Konuşkan — varsayılan olarak kapalı."
                disabled={saving}
              />
            </fieldset>

            <fieldset disabled={saving}>
              <legend className="sr-only">Alert thresholds</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-border bg-bg px-4 py-3">
                  <label htmlFor={warnInputId} className="block text-xs text-muted">
                    Warn at
                  </label>
                  <span className="mt-1 flex items-baseline gap-1">
                    <input
                      id={warnInputId}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={100}
                      step={1}
                      value={warnDraft}
                      onChange={(event) => {
                        draftVersionRef.current += 1;
                        setWarnDraft(event.target.value);
                        setSaved(false);
                      }}
                      aria-invalid={Boolean(validation.warnError)}
                      aria-describedby={validation.warnError ? warnErrorId : undefined}
                      className={`min-h-11 w-16 rounded-md border bg-surface px-2 py-1 text-sm tabular-nums text-ivory focus:border-coral/60 focus:outline-none ${
                        validation.warnError ? "border-danger/60" : "border-border"
                      }`}
                    />
                    <span className="text-sm text-faint" aria-hidden="true">
                      %
                    </span>
                  </span>
                  {validation.warnError && (
                    <p id={warnErrorId} className="mt-2 text-xs leading-relaxed text-[#ea7b74]">
                      {validation.warnError}
                    </p>
                  )}
                </div>
                <div className="rounded-xl border border-border bg-bg px-4 py-3">
                  <label htmlFor={recoveryInputId} className="block text-xs text-muted">
                    Recovered when peak ≥
                  </label>
                  <span className="mt-1 flex items-baseline gap-1">
                    <input
                      id={recoveryInputId}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={100}
                      step={1}
                      value={recoveryDraft}
                      onChange={(event) => {
                        draftVersionRef.current += 1;
                        setRecoveryDraft(event.target.value);
                        setSaved(false);
                      }}
                      aria-invalid={Boolean(validation.recoveryError || validation.relationError)}
                      aria-describedby={
                        validation.recoveryError
                          ? recoveryErrorId
                          : validation.relationError
                            ? relationErrorId
                            : undefined
                      }
                      className={`min-h-11 w-16 rounded-md border bg-surface px-2 py-1 text-sm tabular-nums text-ivory focus:border-coral/60 focus:outline-none ${
                        validation.recoveryError || validation.relationError ? "border-danger/60" : "border-border"
                      }`}
                    />
                    <span className="text-sm text-faint" aria-hidden="true">
                      %
                    </span>
                  </span>
                  {validation.recoveryError && (
                    <p id={recoveryErrorId} className="mt-2 text-xs leading-relaxed text-[#ea7b74]">
                      {validation.recoveryError}
                    </p>
                  )}
                </div>
              </div>
              {validation.relationError && (
                <p id={relationErrorId} className="mt-2 text-xs leading-relaxed text-[#ea7b74]" role="alert">
                  {validation.relationError}
                </p>
              )}
            </fieldset>

            {actionError && (
              <p
                className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-[#ea7b74]"
                role="alert"
              >
                {actionError}
              </p>
            )}

            {confirmDiscard && (
              <div className="rounded-xl border border-coral/40 bg-coral/10 p-4" role="alert">
                <p className="text-sm font-medium text-ivory">Discard unsaved changes?</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Your alert rules have changed but haven&apos;t been saved.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    ref={keepEditingRef}
                    type="button"
                    onClick={() => setConfirmDiscard(false)}
                    className="min-h-11 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ivory transition-colors hover:bg-surface-hover"
                  >
                    Keep editing
                  </button>
                  <button
                    type="button"
                    onClick={discardAndClose}
                    className="min-h-11 rounded-lg bg-coral px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-coral-pressed"
                  >
                    Discard changes
                  </button>
                </div>
              </div>
            )}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="min-h-5 text-xs text-muted" aria-live="polite">
                {saving ? "Saving settings…" : saved ? "Ayarlar kaydedildi." : dirty ? "Unsaved changes" : ""}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={resetChanges}
                  disabled={!dirty || saving}
                  className="min-h-11 flex-1 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors enabled:hover:bg-surface-hover enabled:hover:text-ivory disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none"
                >
                  Reset
                </button>
                <button
                  type="submit"
                  disabled={saving || !dirty || !validation.valid}
                  className="min-h-11 flex-1 rounded-lg bg-coral px-4 py-2 text-sm font-medium text-white transition-colors enabled:hover:bg-coral-pressed disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
                >
                  {saving ? "Saving…" : "Save settings"}
                </button>
              </div>
            </div>

            <p className="border-t border-border/60 pt-4 text-[11px] leading-relaxed text-faint">
              A background check runs every ~5 minutes and sends alerts through whichever channels you&apos;ve
              configured (web push, Telegram, webhook). Triggers and thresholds apply to all channels.
            </p>
          </form>
        </div>
      )}
    </ModalShell>
  );
}
