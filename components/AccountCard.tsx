"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AccountSnapshot, BrowserAccount } from "@/lib/types";
import { extractBars, formatClock, formatResetSchedule, type NormalizedUsageBar } from "@/lib/format";
import type { InteractionChannel } from "@/lib/dashboard-order-state";
import type { WeeklyAccountMetric } from "@/lib/quota-metrics";
import { UsageBar } from "./UsageBar";
import { RefreshIcon, XIcon } from "./Icons";
import { providerMeta } from "./providers-ui";

const ICON_BTN =
  "flex h-11 w-11 items-center justify-center rounded-lg text-faint transition-colors enabled:hover:bg-surface-hover enabled:hover:text-ivory disabled:opacity-40";

function freshnessAge(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "az önce";
  if (minutes < 60) return `${minutes} dk önce`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} sa önce`;
  return `${Math.floor(hours / 24)} gün önce`;
}

export function deriveFiveHourPeak(bars: readonly NormalizedUsageBar[]): number | null {
  let peak: number | null = null;
  for (const bar of bars) {
    if (bar.kind !== "session") continue;
    peak = peak === null ? bar.usedPercent : Math.max(peak, bar.usedPercent);
  }
  return peak;
}

export function accountDisplayName(
  account: Pick<BrowserAccount, "label" | "fullName" | "email">,
): string {
  return account.label || account.fullName || account.email;
}

interface AccountCardProps {
  account: BrowserAccount;
  snapshot: AccountSnapshot | undefined;
  metric?: WeeklyAccountMetric;
  fiveHourPeak?: number | null;
  now: number;
  /** Transitional until Dashboard supplies the controlled Task 6 contract. */
  index?: number;
  providerOrdinal: number;
  mobileExpanded?: boolean;
  onMobileExpandedChange?: (expanded: boolean) => void;
  onInteractionFenceChange?: (channel: InteractionChannel, active: boolean) => void;
  onRefresh: () => void;
  onRemove: () => void;
  onReconnect?: () => void;
  onRename: (label: string | undefined) => void;
}

export function AccountCard({
  account,
  snapshot,
  metric,
  fiveHourPeak,
  now,
  providerOrdinal,
  mobileExpanded = false,
  onMobileExpandedChange,
  onInteractionFenceChange,
  onRefresh,
  onRemove,
  onReconnect,
  onRename,
}: AccountCardProps) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const renameTriggerRef = useRef<HTMLButtonElement>(null);
  const removeTriggerRef = useRef<HTMLButtonElement>(null);
  const cancelRemoveRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const freshnessId = useId();
  const removeTitleId = useId();
  const removeDescriptionId = useId();
  const ledgerPanelId = `${useId().replace(/[^a-zA-Z0-9_-]/g, "")}-ledger-panel`;

  useEffect(() => {
    if (!confirmRemove) return;
    const frame = requestAnimationFrame(() => cancelRemoveRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [confirmRemove]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const status = snapshot?.status ?? "idle";
  const loading = status === "loading";
  const bars = snapshot?.usage
    ? extractBars(snapshot.usage).map((bar) => account.provider === "openai" && bar.kind === "session"
      ? { ...bar, label: "Codex · 5 saatlik limit" }
      : bar)
    : null;
  const resolvedFiveHourPeak = fiveHourPeak === undefined
    ? deriveFiveHourPeak(bars ?? [])
    : fiveHourPeak;
  const hasBars = !!bars && bars.length > 0;
  // Stale = the server is showing its last-good reading because Anthropic rate-limited the upstream
  // poll (a cooldown), not a live fetch. We keep the bars but flag their age.
  const stale = (snapshot?.stale ?? false) && status !== "reauth";
  const oldData = hasBars && status !== "reauth" && (stale || loading || status === "error");
  const lastDataText = snapshot?.fetchedAt ? ` Son veri ${freshnessAge(snapshot.fetchedAt, now)}.` : "";
  const freshnessText = loading && hasBars
    ? `Yenileniyor — son veriler gösteriliyor.${lastDataText}`
    : status === "error" && hasBars
      ? `Yenileme başarısız — son veriler gösteriliyor.${lastDataText}`
      : stale
        ? `Güncel değil — son veri ${snapshot?.fetchedAt ? freshnessAge(snapshot.fetchedAt, now) : "daha önce"}.`
        : null;
  const displayName = accountDisplayName(account);
  const credentialKind = account.credentialKind;
  const managedLogin = credentialKind === "managed";
  const setupToken = credentialKind === "long_lived";
  const sharedCliLogin = credentialKind === "rotating";
  const providerName = account.provider === "openai" ? "ChatGPT" : "Claude";
  const cliName = account.provider === "openai" ? "Codex CLI" : "Claude Code";
  const tokenDaysRemaining = Math.ceil((account.credentialExpiresAt - now) / 86_400_000);
  const tokenExpiryWarning = setupToken && tokenDaysRemaining <= 30;
  const cooldownRemaining = Math.max(0, (snapshot?.cooldownUntil ?? 0) - now);
  const cooldownMinutes = Math.max(1, Math.ceil(cooldownRemaining / 60_000));
  const refreshDisabled = loading || status === "reauth" || cooldownRemaining > 0;
  const initial = displayName.charAt(0).toUpperCase() || "?";
  const weeklyPeak = metric?.highestWeeklyUsedPercent ?? null;
  const nearestReset = formatResetSchedule(metric?.nearestWeeklyResetAt ?? null, now);
  const ledgerState = status === "reauth"
    ? "reauth"
    : status === "error"
      ? "error"
      : status === "loading"
        ? "loading"
        : stale
          ? "stale"
          : status === "ready"
            ? "ready"
            : "idle";
  const ledgerStateLabel = ledgerState === "reauth"
    ? "Yeniden bağlanma gerekli"
    : ledgerState === "error"
      ? "Yenileme başarısız"
      : ledgerState === "loading"
        ? "Yenileniyor"
        : ledgerState === "stale"
          ? "Güncel değil"
          : ledgerState === "ready"
            ? "Güncel"
            : "İlk veri bekleniyor";

  const restoreRenameFocus = () => {
    requestAnimationFrame(() => renameTriggerRef.current?.focus({ preventScroll: true }));
  };

  const cancelRemove = () => {
    setConfirmRemove(false);
    requestAnimationFrame(() => removeTriggerRef.current?.focus({ preventScroll: true }));
  };

  const commitRename = (restoreFocus = false) => {
    const trimmed = draft.trim();
    onRename(trimmed ? trimmed : undefined);
    setEditing(false);
    if (restoreFocus) restoreRenameFocus();
  };

  const beginRename = (trigger: HTMLButtonElement) => {
    renameTriggerRef.current = trigger;
    setDraft(account.label ?? "");
    setEditing(true);
  };

  const beginRemove = (trigger: HTMLButtonElement) => {
    removeTriggerRef.current = trigger;
    setConfirmRemove(true);
  };

  const renderUsageDetails = (): ReactNode => status === "reauth" ? (
    <div role="alert" className="flex min-w-0 flex-col items-start gap-3 rounded-xl border border-border bg-bg-raised p-4">
      <p className="min-w-0 break-words text-sm leading-relaxed text-muted">
        {managedLogin
          ? `This private app login expired or was revoked. Sign in with ${providerName} again to restore automatic renewal.`
          : setupToken
            ? "This legacy inference-only setup token expired or was revoked. Replace it to restore checks."
            : `This shared ${cliName} session rotated somewhere else. Replace it with a private app login so normal CLI refreshes cannot disconnect the dashboard.`}
      </p>
      {onReconnect ? (
        <button
          type="button"
          onClick={onReconnect}
          aria-label={`Reconnect ${displayName}`}
          className="accent-btn min-h-11 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors"
        >
          {managedLogin ? "Reconnect private login" : setupToken ? "Replace with private login" : "Reconnect reliably"}
        </button>
      ) : (
        <p className="text-xs font-medium text-ivory">
          {account.provider === "openai"
            ? "Reconnect this ChatGPT account to replace it."
            : "Use the secure launcher's Claude connector to replace it."}
        </p>
      )}
    </div>
  ) : hasBars ? (
    <>
      {bars.map((bar) => (
        <UsageBar
          key={bar.key}
          bar={bar}
          now={now}
          stale={oldData}
          freshnessDescriptionId={freshnessText ? freshnessId : undefined}
        />
      ))}
    </>
  ) : status === "error" ? (
    <div role="status" className="flex min-w-0 flex-col items-start gap-3 rounded-xl border border-border bg-bg-raised p-4">
      <p className="min-w-0 break-words text-sm text-muted">{snapshot?.error ?? "Couldn't load usage."}</p>
      <button
        type="button"
        onClick={onRefresh}
        disabled={cooldownRemaining > 0}
        className="min-h-11 rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-ivory transition-colors enabled:hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {cooldownRemaining > 0 ? `Retry in ${cooldownMinutes} min` : "Retry"}
      </button>
    </div>
  ) : status === "ready" ? (
    <div className="rounded-xl border border-border bg-bg-raised p-4">
      <p className="text-sm text-muted">No usage limits reported yet for this account.</p>
    </div>
  ) : (
    <div className="space-y-4" aria-hidden>
      {[0, 1, 2].map((item) => (
        <div key={item}>
          <div className="skeleton h-3 w-2/5 rounded" />
          <div className="skeleton mt-2 h-2 w-full rounded-full" />
        </div>
      ))}
    </div>
  );

  return (
    <article
      aria-labelledby={headingId}
      data-provider={account.provider ?? "anthropic"}
      data-stale={oldData || undefined}
      className="flex h-full min-w-0 flex-col rounded-2xl border border-border bg-surface p-5"
      aria-busy={loading}
      onFocusCapture={() => onInteractionFenceChange?.("focus", true)}
      onBlurCapture={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        onInteractionFenceChange?.("focus", false);
      }}
      onPointerEnter={() => onInteractionFenceChange?.("pointer", true)}
      onPointerLeave={() => onInteractionFenceChange?.("pointer", false)}
      onKeyDown={(event) => {
        if (!confirmRemove || event.key !== "Escape") return;
        event.preventDefault();
        cancelRemove();
      }}
    >
      <div className="hidden min-w-0 flex-col gap-3 min-[960px]:flex xs:flex-row xs:items-start xs:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-[15px] font-semibold"
            style={{
              background: "var(--avatar-bg)",
              color: "var(--avatar-fg)",
              borderColor: "var(--avatar-border)",
            }}
          >
            {initial}
          </div>
          <div className="min-w-0">
            <h2 id={headingId} className="truncate text-[11px] font-semibold uppercase tracking-wide text-faint">
              {providerMeta(account.provider).label} {providerOrdinal}
            </h2>
            <button
              type="button"
              onClick={(event) => beginRename(event.currentTarget)}
              aria-label={`Rename ${displayName}`}
              title="Rename this account"
              className="flex min-h-11 min-w-11 max-w-full items-center truncate text-left text-[15px] font-medium text-ivory transition-colors hover:text-[var(--accent-bright)]"
            >
              {displayName}
            </button>
            <p className="truncate text-xs text-faint">{account.email}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 self-end xs:self-auto">
          {(() => {
            const meta = providerMeta(account.provider);
            const ProviderMark = meta.Icon;
            return (
              <span
                title={`${meta.label} · ${account.plan}`}
                className="mr-1 inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted"
              >
                <span className="inline-flex" style={{ color: "var(--accent-bright)" }}>
                  <ProviderMark className="h-3 w-3 shrink-0" />
                </span>
                {account.plan}
              </span>
            );
          })()}
          <button
            type="button"
            className={ICON_BTN}
            title={
              status === "reauth"
                ? "Replace this account's token before refreshing"
                : cooldownRemaining > 0
                  ? `Retry available in ${cooldownMinutes} minute${cooldownMinutes === 1 ? "" : "s"}`
                  : "Refresh this account"
            }
            aria-label={
              status === "reauth"
                ? `Reconnect ${displayName} before refreshing`
                : cooldownRemaining > 0
                  ? `Refresh ${displayName} available in ${cooldownMinutes} minutes`
                  : `Refresh ${displayName}`
            }
            onClick={onRefresh}
            disabled={refreshDisabled}
          >
            <RefreshIcon className={`h-4 w-4 ${loading ? "animate-spin-slow" : ""}`} />
          </button>
          <button
            type="button"
            className={ICON_BTN}
            title="Remove this account from the dashboard"
            aria-label={`Remove ${displayName}`}
            onClick={(event) => beginRemove(event.currentTarget)}
            disabled={confirmRemove}
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div
        data-ledger-account={account.id}
        data-ledger-state={ledgerState}
        className="min-w-0 min-[960px]:hidden"
      >
        <button
          type="button"
          data-ledger-expand={account.id}
          aria-expanded={mobileExpanded}
          aria-controls={ledgerPanelId}
          onClick={() => onMobileExpandedChange?.(!mobileExpanded)}
          className="block min-h-11 w-full min-w-0 text-left"
        >
          <span className="flex min-w-0 items-start justify-between gap-3">
            <span className="min-w-0">
              <span className="block text-[11px] font-semibold uppercase tracking-wide text-faint">
                {providerMeta(account.provider).label} {providerOrdinal}
              </span>
              <span className="block truncate text-[15px] font-medium text-ivory">{displayName}</span>
              <span className="block truncate text-xs text-faint">{account.email}</span>
            </span>
            <span className="shrink-0 text-xs text-muted">{account.plan}</span>
          </span>
          <span className="mt-3 grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 text-xs">
            <span data-ledger-metric="five-hour" className="min-w-0">
              <span className="block text-faint">Beş saatlik tepe</span>
              <span data-ledger-value={resolvedFiveHourPeak ?? "missing"} className="block tabular-nums text-ivory">{resolvedFiveHourPeak === null ? "—" : `%${resolvedFiveHourPeak}`}</span>
            </span>
            <span data-ledger-metric="weekly" className="min-w-0">
              <span className="block text-faint">Haftalık tepe</span>
              <span data-ledger-value={weeklyPeak ?? "missing"} className="block tabular-nums text-ivory">{weeklyPeak === null ? "—" : `%${weeklyPeak}`}</span>
              {metric?.highestWeeklyLimitLabel && <span className="block break-words text-faint">{metric.highestWeeklyLimitLabel}</span>}
            </span>
            <span data-ledger-metric="nearest-reset" className="min-w-0">
              <span className="block text-faint">En yakın yenilenme</span>
              <span className="block tabular-nums text-ivory">{nearestReset?.countdown ?? nearestReset?.exact ?? "—"}</span>
              {metric?.nearestWeeklyResetLabel && <span className="block break-words text-faint">{metric.nearestWeeklyResetLabel}</span>}
            </span>
            <span data-ledger-metric="state" className="min-w-0">
              <span className="block text-faint">Durum</span>
              <span data-ledger-status-label className="block break-words text-ivory">{ledgerStateLabel}</span>
            </span>
          </span>
        </button>

        <section
          id={ledgerPanelId}
          data-ledger-panel={account.id}
          hidden={!mobileExpanded}
          className="mt-4 min-w-0 space-y-4"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <button
              type="button"
              className={ICON_BTN}
              title="Refresh this account"
              aria-label={`Refresh ${displayName}`}
              onClick={onRefresh}
              disabled={refreshDisabled}
            >
              <RefreshIcon className={`h-4 w-4 ${loading ? "animate-spin-slow" : ""}`} />
            </button>
            <button
              type="button"
              className={ICON_BTN}
              title="Rename this account"
              aria-label={`Rename ${displayName}`}
              onClick={(event) => beginRename(event.currentTarget)}
            >
              <span aria-hidden="true" className="text-base">Aa</span>
            </button>
            <button
              type="button"
              className={ICON_BTN}
              title="Remove this account from the dashboard"
              aria-label={`Remove ${displayName}`}
              onClick={(event) => beginRemove(event.currentTarget)}
              disabled={confirmRemove}
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
          <div className={`min-w-0 space-y-4 transition-opacity duration-300 ${loading && hasBars ? "opacity-60" : ""}`}>
            {renderUsageDetails()}
          </div>
        </section>
      </div>

      {editing && (
        <input
          ref={inputRef}
          aria-label={`Nickname for ${account.email}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => commitRename()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitRename(true);
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setEditing(false);
              restoreRenameFocus();
            }
          }}
          placeholder={account.fullName || account.email}
          maxLength={40}
          className="mt-3 min-h-11 w-full min-w-0 rounded-md border border-border bg-bg px-2 py-1 text-[15px] font-medium text-ivory focus:border-[var(--accent)] focus:outline-none"
        />
      )}

      {confirmRemove && (
        <div
          role="group"
          aria-labelledby={removeTitleId}
          aria-describedby={removeDescriptionId}
          className="mt-4 rounded-xl border border-danger/30 bg-danger/10 p-3"
        >
          <p id={removeTitleId} className="text-sm font-medium text-ivory">Remove {displayName}?</p>
          <p id={removeDescriptionId} className="mt-1 text-xs leading-relaxed text-muted">
            Its saved monitor credential will be deleted. You&apos;ll need to connect it again to restore monitoring.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              ref={cancelRemoveRef}
              type="button"
              onClick={cancelRemove}
              className="min-h-11 rounded-lg border border-border px-3 text-xs font-medium text-ivory transition-colors hover:bg-surface-hover"
            >
              Keep account
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="min-h-11 rounded-lg bg-danger/20 px-3 text-xs font-semibold text-[#ff9c95] transition-colors hover:bg-danger/30"
            >
              Remove account
            </button>
          </div>
        </div>
      )}

      {sharedCliLogin && status !== "reauth" && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#e3b56e]/30 bg-[#e3b56e]/10 px-3 py-2 text-xs leading-relaxed text-[#f0c47d]">
          <span className="max-w-sm">
            This account shares {cliName}&apos;s rotating login. A private app login renews independently.
          </span>
          {onReconnect ? (
            <button
              type="button"
              onClick={onReconnect}
              className="min-h-11 rounded-lg border border-current/30 px-3 font-semibold text-ivory transition-colors hover:bg-white/5"
            >
              Replace with private login
            </button>
          ) : (
            <span className="font-medium text-ivory">
              Use the secure launcher to replace it.
            </span>
          )}
        </div>
      )}

      {tokenExpiryWarning && status !== "reauth" && (
        <div
          role="status"
          className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#e3b56e]/30 bg-[#e3b56e]/10 px-3 py-2 text-xs leading-relaxed text-[#f0c47d]"
        >
          <span>
            {tokenDaysRemaining < 0
              ? "Estimated monitor-token renewal date has passed."
              : tokenDaysRemaining === 0
                ? "Estimated monitor-token renewal is due today."
                : `Estimated monitor-token renewal in ${tokenDaysRemaining} day${tokenDaysRemaining === 1 ? "" : "s"}.`}
          </span>
          {onReconnect ? (
            <button
              type="button"
              onClick={onReconnect}
              className="min-h-11 rounded-lg border border-current/30 px-3 py-1.5 font-semibold text-ivory transition-colors hover:bg-white/5"
            >
              Replace with private login
            </button>
          ) : (
            <span className="font-medium text-ivory">
              Use the secure launcher to replace it.
            </span>
          )}
        </div>
      )}

      {freshnessText && (
        <div
          id={freshnessId}
          role="status"
          aria-live="polite"
          className="mt-4 min-w-0 break-words rounded-lg border border-[#e3b56e]/30 bg-[#e3b56e]/10 px-3 py-2 text-[11px] leading-relaxed text-[#e3b56e]"
        >
          {freshnessText}
        </div>
      )}

      <div className={`mt-5 hidden min-w-0 flex-1 space-y-4 transition-opacity duration-300 min-[960px]:block ${loading && hasBars ? "opacity-60" : ""}`}>
        {renderUsageDetails()}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-[11px] text-faint">
        <span>
          {status === "reauth" ? (
            <span className="text-[#e3b56e]">reconnect required</span>
          ) : status === "error" ? (
            <span className="text-[#e3b56e]">
              {hasBars ? "refresh failed — showing last data" : "refresh failed"}
            </span>
          ) : stale && hasBars ? (
            <span className="text-[#e3b56e]">rate-limited — showing last update</span>
          ) : snapshot?.fetchedAt ? (
            `updated ${formatClock(snapshot.fetchedAt)}`
          ) : (
            "waiting for first refresh"
          )}
        </span>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span
            title={
              managedLogin
                ? `Private app-owned ${providerName} login; renews automatically without sharing ${cliName}'s session`
                : setupToken
                  ? `Legacy inference-only setup token; estimated renewal date ${new Date(account.credentialExpiresAt).toLocaleDateString()}`
                  : `Shared with ${cliName}; a private app login is more reliable`
            }
            className={sharedCliLogin ? "text-[#e3b56e]" : "text-muted"}
          >
            {managedLogin ? "private app login · auto-renews" : setupToken ? "setup token · legacy" : "shared CLI login"}
          </span>
          {snapshot?.usage?.extra_usage?.is_enabled && <span>extra usage on</span>}
        </div>
      </div>
    </article>
  );
}
