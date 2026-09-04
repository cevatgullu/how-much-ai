"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AccountSnapshot, BrowserAccount, UsageResponse, VaultMutation } from "@/lib/types";
import type { ProviderId } from "@/lib/providers/types";
import { PROVIDER_META } from "@/components/providers-ui";
import { loadSettings, saveSettings, type Settings } from "@/lib/storage";
import { refreshAllAccounts } from "@/lib/refresh-all";
import {
  processLocalNotificationSnapshot,
  type LocalNotifyRuntimeResult,
  type LocalNotifyRuntimeStatus,
  type LocalSnapshotInput,
} from "@/lib/local-notify-coordinator";
import type { LocalNotifyRules } from "@/lib/local-notify-detect";
import {
  archiveUnreadableVault,
  fetchVault,
  persistVaultMutations,
  VaultRequestError,
  type VaultRecoveryResult,
  type VaultSnapshot,
} from "@/lib/vault-client";
import { extractBars, formatClock, parseResetTimestamp, planLabel } from "@/lib/format";
import { AccountCard, deriveFiveHourPeak } from "@/components/AccountCard";
import { AddAccountModal } from "@/components/AddAccountModal";
import { NotificationsPanel } from "@/components/NotificationsPanel";
import { PlusIcon, StarburstIcon } from "@/components/Icons";
import { DashboardHeader } from "@/components/DashboardHeader";
import { DashboardSheets, type DashboardSheet } from "@/components/DashboardSheets";
import { MobileCommandBar } from "@/components/MobileCommandBar";
import { QuotaReadings } from "@/components/QuotaReadings";
import { WeeklyTrend } from "@/components/WeeklyTrend";
import {
  dashboardVaultReducer,
  initialDashboardVaultState,
} from "@/components/dashboard-vault-state";
import {
  dashboardOrderReducer,
  initialDashboardOrderState,
  resolvedDashboardOrder,
  type DashboardOrderEvent,
  type DashboardOrderState,
  type InteractionChannel,
} from "@/lib/dashboard-order-state";
import {
  deriveWeeklyAccountMetrics,
  summarizeWeeklyAccountMetrics,
  type QuotaSortMode,
  type WeeklyAccountMetric,
} from "@/lib/quota-metrics";
import {
  historyDayWindow,
  loadWeeklyHistory,
  pruneWeeklyHistory,
  recordWeeklyHistory,
  saveWeeklyHistory,
  weeklyHistorySamples,
  weeklyTrendSeries,
  WEEKLY_TREND_DAYS,
  type WeeklyHistory,
} from "@/lib/weekly-history";

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function errText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

type StrictLocalDashboardMessageKey = "auto_refresh_save_failed" | "vault_unreadable";

export function strictLocalDashboardMessage(
  strictLocal: boolean,
  key: StrictLocalDashboardMessageKey,
): string {
  if (key === "auto_refresh_save_failed") {
    return "Otomatik yenileme tercihi bu cihaza kaydedilemedi.";
  }
  return "Yeniden yüklemek kayıtlı kasanın kilidini açamaz. Aşağıdaki kurtarma seçeneklerini kullanın veya önceki şifreleme anahtarını geri yükleyin.";
}

export function dashboardVaultRecoveryNotice(
  strictLocal: boolean,
  recovery: VaultRecoveryResult,
): string {
  void strictLocal;
  return recovery.backupArchive
    ? `Okunamayan kasa ${recovery.archive} olarak, okunamayan son iyi yedeği de ${recovery.backupArchive} olarak korundu. Hesaplarınızı şimdi yeniden bağlayabilirsiniz.`
    : `Okunamayan kasa ${recovery.archive} olarak korundu. Hesaplarınızı şimdi yeniden bağlayabilirsiniz.`;
}

const LOCAL_LABEL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

export function accountProviderOrdinals(
  accounts: readonly Pick<BrowserAccount, "id" | "provider">[],
): ReadonlyMap<string, number> {
  const counts = new Map<ProviderId, number>();
  return new Map(accounts.map((account) => {
    const provider = account.provider ?? "anthropic";
    const ordinal = (counts.get(provider) ?? 0) + 1;
    counts.set(provider, ordinal);
    return [account.id, ordinal] as const;
  }));
}

export function commitDashboardSnapshot(
  snapshots: Readonly<Record<string, AccountSnapshot>>,
  accountId: string,
  updater: (snapshot: AccountSnapshot | undefined) => AccountSnapshot,
): Record<string, AccountSnapshot> {
  return { ...snapshots, [accountId]: updater(snapshots[accountId]) };
}

/**
 * Fold today's fresh readings into the stored history and drop what has aged out.
 *
 * Pruning happens on the same pass as the write so the eight-day bound holds even for a device
 * that is opened once a month: a pass that only appended would keep growing until something else
 * happened to clean up.
 */
export function advanceWeeklyHistory(
  history: WeeklyHistory,
  metrics: readonly WeeklyAccountMetric[],
  accountIds: readonly string[],
  now: number,
): WeeklyHistory {
  return pruneWeeklyHistory(
    recordWeeklyHistory(history, weeklyHistorySamples(metrics), now),
    now,
    accountIds,
  );
}

export function saveDashboardSortMode(
  mode: QuotaSortMode,
  load: () => Settings = loadSettings,
  save: (settings: Settings) => boolean = saveSettings,
): boolean {
  return save({ ...load(), sortMode: mode });
}

export function dashboardMetricForNow(metric: WeeklyAccountMetric, now: number): WeeklyAccountMetric {
  const resetAt = metric.nearestWeeklyResetAt === null
    ? null
    : parseResetTimestamp(metric.nearestWeeklyResetAt);
  if (resetAt === null || resetAt >= now) return metric;
  return {
    ...metric,
    nearestWeeklyResetAt: null,
    nearestWeeklyResetKey: null,
    nearestWeeklyResetLabel: "yenilenme verisi bekleniyor",
  };
}

interface ScrollableAccountElement {
  scrollIntoView(options?: ScrollIntoViewOptions): void;
}

export function scheduleDashboardAccountScroll(
  element: ScrollableAccountElement | null,
  schedule: (callback: () => void) => unknown = (callback) => requestAnimationFrame(callback),
): boolean {
  if (!element) return false;
  schedule(() => element.scrollIntoView({ block: "nearest" }));
  return true;
}

export interface DashboardOrderScrollRequest {
  accountId: string;
  sequence: number;
}

export interface DashboardOrderViewState extends DashboardOrderState {
  scrollRequest: DashboardOrderScrollRequest | null;
}

export function initialDashboardOrderViewState(
  accountIds: readonly string[],
  mode: QuotaSortMode,
): DashboardOrderViewState {
  return {
    ...initialDashboardOrderState(accountIds, mode),
    scrollRequest: null,
  };
}

function sameDashboardOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((accountId, index) => accountId === b[index]);
}

export function dashboardOrderViewReducer(
  state: DashboardOrderViewState,
  event: DashboardOrderEvent,
): DashboardOrderViewState {
  const nextOrder = dashboardOrderReducer(state, event);
  const releasedReorder = event.type === "interaction_leave"
    && state.pendingAccountIds !== null
    && nextOrder.pendingAccountIds === null
    && !sameDashboardOrder(state.visibleAccountIds, nextOrder.visibleAccountIds);
  return {
    ...nextOrder,
    scrollRequest: releasedReorder
      ? {
          accountId: event.accountId,
          sequence: (state.scrollRequest?.sequence ?? 0) + 1,
        }
      : state.scrollRequest,
  };
}

export function scheduleDashboardOrderScroll(
  request: DashboardOrderScrollRequest | null,
  accountElements: ReadonlyMap<string, ScrollableAccountElement>,
  schedule?: (callback: () => void) => unknown,
): boolean {
  if (request === null) return false;
  return scheduleDashboardAccountScroll(
    accountElements.get(request.accountId) ?? null,
    schedule,
  );
}

export interface DashboardAccountRow {
  key: string;
  account: BrowserAccount;
  metric: WeeklyAccountMetric;
  providerOrdinal: number;
  mobileExpanded: boolean;
}

function emptyDashboardMetric(accountId: string, sourceIndex: number): WeeklyAccountMetric {
  return {
    accountId,
    sourceIndex,
    highestWeeklyUsedPercent: null,
    highestWeeklyLimitKey: null,
    highestWeeklyLimitLabel: null,
    nearestWeeklyResetAt: null,
    nearestWeeklyResetKey: null,
    nearestWeeklyResetLabel: null,
    hasFreshReading: false,
  };
}

export function dashboardAccountRows(
  accounts: readonly BrowserAccount[],
  visibleAccountIds: readonly string[],
  metrics: readonly WeeklyAccountMetric[],
  providerOrdinals: ReadonlyMap<string, number>,
  expandedAccountIds: ReadonlySet<string>,
): DashboardAccountRow[] {
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const metricsById = new Map(metrics.map((metric) => [metric.accountId, metric]));
  return visibleAccountIds.flatMap((accountId) => {
    const account = accountsById.get(accountId);
    if (!account) return [];
    const sourceIndex = accounts.findIndex((candidate) => candidate.id === accountId);
    return [{
      key: accountId,
      account,
      metric: metricsById.get(accountId) ?? emptyDashboardMetric(accountId, sourceIndex),
      providerOrdinal: providerOrdinals.get(accountId) ?? 1,
      mobileExpanded: expandedAccountIds.has(accountId),
    }];
  });
}

interface DashboardAccountListProps {
  accounts: readonly BrowserAccount[];
  strictLocal?: boolean;
  visibleAccountIds: readonly string[];
  snapshots: Readonly<Record<string, AccountSnapshot>>;
  metrics: readonly WeeklyAccountMetric[];
  providerOrdinals: ReadonlyMap<string, number>;
  expandedAccountIds: ReadonlySet<string>;
  now: number;
  setAccountElement?: (accountId: string, element: HTMLLIElement | null) => void;
  onMobileExpandedChange: (accountId: string, expanded: boolean) => void;
  onInteractionFenceChange: (accountId: string, channel: InteractionChannel, active: boolean) => void;
  onRefresh: (accountId: string) => void;
  onRemove: (accountId: string) => void;
  onReconnect?: (account: BrowserAccount) => void;
  onRename: (accountId: string, label: string | undefined) => void;
}

export function DashboardAccountList({
  accounts,
  strictLocal = false,
  visibleAccountIds,
  snapshots,
  metrics,
  providerOrdinals,
  expandedAccountIds,
  now,
  setAccountElement,
  onMobileExpandedChange,
  onInteractionFenceChange,
  onRefresh,
  onRemove,
  onReconnect,
  onRename,
}: DashboardAccountListProps) {
  const rows = dashboardAccountRows(accounts, visibleAccountIds, metrics, providerOrdinals, expandedAccountIds);
  // Hesaplar ailelerine göre gruplanır; sıralama zaten uygulanmış olduğu için her ailenin
  // kendi içindeki sıra korunur. Böylece sıralama seçimi aile içinde geçerli olur.
  const families = (["anthropic", "openai", "grok"] as const)
    .map((id) => ({
      id,
      meta: PROVIDER_META[id],
      rows: rows.filter((row) => (row.account.provider ?? "anthropic") === id),
    }))
    .filter((family) => family.rows.length > 0);
  return (
    <ol role="list" className="dashboard-account-list account-grid list-none">
      {families.flatMap((family) => [
        <li key={`family-${family.id}`} className="dashboard-family-head list-none" data-family={family.id}>
          <family.meta.Icon className="h-3.5 w-3.5 shrink-0" />
          <span className="dashboard-family-name">{family.meta.label}</span>
          <span className="dashboard-family-rule" aria-hidden="true" />
          <span className="dashboard-family-count">{family.rows.length} hesap</span>
        </li>,
        ...family.rows.map((row) => {
        const usageBars = row.account.id in snapshots && snapshots[row.account.id]?.usage
          ? extractBars(snapshots[row.account.id]!.usage!)
          : [];
        return (
          <li
            key={row.key}
            className="dashboard-account-item min-w-0"
            data-dashboard-account={row.account.id}
            data-dashboard-key={row.key}
            ref={(element) => setAccountElement?.(row.account.id, element)}
          >
            <AccountCard
              account={row.account}
              strictLocal={strictLocal}
              snapshot={snapshots[row.account.id]}
              metric={dashboardMetricForNow(row.metric, now)}
              fiveHourPeak={deriveFiveHourPeak(usageBars)}
              now={now}
              providerOrdinal={row.providerOrdinal}
              mobileExpanded={row.mobileExpanded}
              onMobileExpandedChange={(expanded) => onMobileExpandedChange(row.account.id, expanded)}
              onInteractionFenceChange={(channel, active) => onInteractionFenceChange(row.account.id, channel, active)}
              onRefresh={() => onRefresh(row.account.id)}
              onRemove={() => onRemove(row.account.id)}
              onReconnect={onReconnect ? () => onReconnect(row.account) : undefined}
              onRename={(label) => onRename(row.account.id, label)}
            />
          </li>
        );
        }),
      ])}
    </ol>
  );
}

export function localAccountLabel(
  account: Pick<BrowserAccount, "label" | "provider">,
  providerOrdinal: number,
): string {
  const nickname = typeof account.label === "string" ? account.label.trim() : "";
  if (
    nickname.length >= 1 &&
    nickname.length <= 40 &&
    !LOCAL_LABEL_CONTROL_PATTERN.test(nickname) &&
    !nickname.includes("@")
  ) return nickname;
  return `${PROVIDER_META[account.provider ?? "anthropic"].label} ${providerOrdinal}`;
}

type DashboardLocalNotificationProcessor = (
  input: LocalSnapshotInput,
) => Promise<LocalNotifyRuntimeResult>;

interface ProcessLocalDashboardSnapshotOptions {
  strictLocal: boolean;
  response: UsageResponse;
  account: BrowserAccount;
  activeAccounts: readonly BrowserAccount[];
  rules: LocalNotifyRules;
  process?: DashboardLocalNotificationProcessor;
}

export async function processLocalDashboardSnapshot({
  strictLocal,
  response,
  account,
  activeAccounts,
  rules,
  process = processLocalNotificationSnapshot,
}: ProcessLocalDashboardSnapshotOptions): Promise<LocalNotifyRuntimeStatus | null> {
  if (
    !strictLocal ||
    response.status !== "ready" ||
    response.stale === true ||
    !response.usage
  ) return null;

  let providerOrdinal = 0;
  for (const candidate of activeAccounts) {
    if (candidate.provider !== account.provider) continue;
    providerOrdinal += 1;
    if (candidate.id === account.id) break;
  }
  if (providerOrdinal < 1) return null;

  try {
    const result = await process({
      accountId: account.id,
      accountLabel: localAccountLabel(account, providerOrdinal),
      bars: extractBars(response.usage),
      activeAccountIds: activeAccounts.map((candidate) => candidate.id),
      rules,
      stale: false,
    });
    return result.status;
  } catch {
    return "worker_error";
  }
}

type LocalNotificationTask = () => Promise<LocalNotifyRuntimeStatus | null>;

export interface LocalNotificationTaskQueue {
  enqueue(task: LocalNotificationTask): Promise<LocalNotifyRuntimeStatus | null>;
}

export function createLocalNotificationTaskQueue(): LocalNotificationTaskQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue(task) {
      const result = tail.then(async () => {
        try {
          return await task();
        } catch {
          return "worker_error";
        }
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

interface ProcessCurrentLocalDashboardSnapshotOptions {
  strictLocal: boolean;
  response: UsageResponse;
  accountId: string;
  getActiveAccounts: () => readonly BrowserAccount[];
  loadLocalSettings?: () => Settings;
  process?: DashboardLocalNotificationProcessor;
}

export async function processCurrentLocalDashboardSnapshot({
  strictLocal,
  response,
  accountId,
  getActiveAccounts,
  loadLocalSettings = loadSettings,
  process = processLocalNotificationSnapshot,
}: ProcessCurrentLocalDashboardSnapshotOptions): Promise<LocalNotifyRuntimeStatus | null> {
  if (!strictLocal) return null;
  const activeAccounts = getActiveAccounts();
  const account = activeAccounts.find((candidate) => candidate.id === accountId);
  if (!account) return null;
  try {
    return await processLocalDashboardSnapshot({
      strictLocal: true,
      response,
      account,
      activeAccounts,
      rules: loadLocalSettings().localNotifications,
      process,
    });
  } catch {
    return "storage_error";
  }
}

interface DashboardProps {
  showSignOut: boolean;
  strictLocal: boolean;
}

export function Dashboard({ showSignOut, strictLocal }: DashboardProps) {
  const snapshotsRef = useRef<Record<string, AccountSnapshot>>({});
  const [accounts, setAccounts] = useState<BrowserAccount[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, AccountSnapshot>>(
    () => snapshotsRef.current,
  );
  const [vaultUi, dispatchVaultUi] = useReducer(dashboardVaultReducer, initialDashboardVaultState);
  const {
    status: vaultState,
    error: vaultError,
    errorCode: vaultErrorCode,
    recoveryConfirm: vaultRecoveryConfirm,
    recoveryError: vaultRecoveryError,
  } = vaultUi;
  const [vaultRecoveryBusy, setVaultRecoveryBusy] = useState(false);
  const [vaultRecoveryNotice, setVaultRecoveryNotice] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [reconnectAccount, setReconnectAccount] = useState<BrowserAccount | null>(null);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [activeSheet, setActiveSheet] = useState<DashboardSheet>(null);
  const [localNotifyStatus, setLocalNotifyStatus] = useState<LocalNotifyRuntimeStatus>("idle");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [orderState, dispatchOrder] = useReducer(
    dashboardOrderViewReducer,
    undefined,
    () => initialDashboardOrderViewState([], "source"),
  );
  const [settledMetrics, setSettledMetrics] = useState<WeeklyAccountMetric[]>([]);
  const [weeklyHistory, setWeeklyHistory] = useState<WeeklyHistory>(() => ({}));
  const [expandedAccountIds, setExpandedAccountIds] = useState<ReadonlySet<string>>(() => new Set());
  const [lastRefreshAll, setLastRefreshAll] = useState<{ at: number; updated: number; total: number } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const accountsRef = useRef<BrowserAccount[]>([]);
  accountsRef.current = accounts;
  const orderModeRef = useRef<QuotaSortMode>("source");
  orderModeRef.current = orderState.mode;
  const acceptedEpochRef = useRef(0);
  // Mirrors weeklyHistory so the settle callback can fold into it without taking a dependency on
  // the state and re-subscribing every render.
  const weeklyHistoryRef = useRef<WeeklyHistory>({});
  const accountElementsRef = useRef(new Map<string, HTMLLIElement>());
  const serverVaultRef = useRef<VaultSnapshot | null>(null);
  const failedMutationsRef = useRef<VaultMutation[]>([]);
  const persistChain = useRef<Promise<void>>(Promise.resolve());
  const saveRevision = useRef(0);
  const vaultReadGeneration = useRef(0);
  const explicitVaultReads = useRef(0);
  const addAccountButtonRef = useRef<HTMLButtonElement>(null);
  const localNotifyQueueRef = useRef<LocalNotificationTaskQueue | null>(null);
  if (localNotifyQueueRef.current === null) {
    localNotifyQueueRef.current = createLocalNotificationTaskQueue();
  }
  // Per-account in-flight lock: refresh tokens are single-use, so two concurrent refreshes
  // of the same account would double-spend the token.
  const inFlight = useRef<Set<string>>(new Set());
  const now = useNow(30_000);
  const vaultUnreadable = vaultErrorCode === "VAULT_UNREADABLE";

  const replaceSnapshots = useCallback((next: Record<string, AccountSnapshot>) => {
    snapshotsRef.current = next;
    setSnapshots(next);
  }, []);

  const commitSnapshot = useCallback((
    accountId: string,
    updater: (snapshot: AccountSnapshot | undefined) => AccountSnapshot,
  ) => {
    const next = commitDashboardSnapshot(snapshotsRef.current, accountId, updater);
    snapshotsRef.current = next;
    setSnapshots(next);
  }, []);

  const acceptSettledSnapshots = useCallback(() => {
    const acceptedAt = Math.max(Date.now(), acceptedEpochRef.current + 1);
    acceptedEpochRef.current = acceptedAt;
    const metrics = deriveWeeklyAccountMetrics(accountsRef.current, snapshotsRef.current, acceptedAt);
    setSettledMetrics(metrics);
    // Settling is the one moment the readings are known to be complete and fresh, which is exactly
    // the sample the trend wants; writing on every snapshot would record half-refreshed rounds.
    const history = advanceWeeklyHistory(
      weeklyHistoryRef.current,
      metrics,
      accountsRef.current.map((account) => account.id),
      acceptedAt,
    );
    weeklyHistoryRef.current = history;
    setWeeklyHistory(history);
    // A failed write is not worth a banner: the chart is an extra, and the next settle retries.
    saveWeeklyHistory(history);
    dispatchOrder({
      type: "candidate_order",
      accountIds: resolvedDashboardOrder(metrics, orderModeRef.current),
      acceptedEpoch: acceptedAt,
    });
  }, []);

  const adoptSuccessfulVaultSnapshot = useCallback((snapshot: VaultSnapshot) => {
    serverVaultRef.current = snapshot;
    accountsRef.current = snapshot.accounts;
    setAccounts(snapshot.accounts);
    dispatchOrder({
      type: "accounts_changed",
      accountIds: snapshot.accounts.map((account) => account.id),
    });
    dispatchVaultUi({ type: "load_succeeded" });
    setSyncError(null);
  }, []);

  useEffect(() => {
    const accountIds = accounts.map((account) => account.id);
    dispatchOrder({ type: "accounts_changed", accountIds });
    setSettledMetrics((current) => {
      const currentById = new Map(current.map((metric) => [metric.accountId, metric]));
      return accountIds.map((accountId, sourceIndex) => ({
        ...(currentById.get(accountId) ?? emptyDashboardMetric(accountId, sourceIndex)),
        sourceIndex,
      }));
    });
    setExpandedAccountIds((current) => {
      const active = new Set(accountIds);
      return new Set([...current].filter((accountId) => active.has(accountId)));
    });
  }, [accounts]);

  const queueSave = useCallback((mutation?: VaultMutation) => {
    const revision = ++saveRevision.current;
    setSaveState("saving");
    setSaveError(null);
    const operation = persistChain.current.catch(() => {}).then(async () => {
      const mutations = [...failedMutationsRef.current, ...(mutation ? [mutation] : [])];
      failedMutationsRef.current = [];
      let snapshot = serverVaultRef.current ?? (await fetchVault());

      for (let index = 0; index < mutations.length; index += 1) {
        try {
          snapshot = await persistVaultMutations(snapshot, [mutations[index]]);
          serverVaultRef.current = snapshot;
        } catch (error) {
          // Retain this edit and every later queued edit. A retry replays their semantic patches;
          // idempotency also covers the case where a network response was lost after a valid save.
          failedMutationsRef.current = [...mutations.slice(index), ...failedMutationsRef.current];
          throw error;
        }
      }
      return snapshot;
    });
    persistChain.current = operation.then(
      () => undefined,
      () => undefined,
    );
    void operation.then(
      (snapshot) => {
        if (revision !== saveRevision.current) return;
        accountsRef.current = snapshot.accounts;
        setAccounts(snapshot.accounts);
        setSaveState("idle");
      },
      (error) => {
        if (revision !== saveRevision.current) return;
        setSaveState("error");
        setSaveError("Hesap değişiklikleri kaydedilemedi.");
      },
    );
  }, []);

  const loadVault = useCallback(async () => {
    const readGeneration = ++vaultReadGeneration.current;
    explicitVaultReads.current += 1;
    dispatchVaultUi({ type: "load_started" });
    setSyncError(null);
    try {
      const snapshot = await fetchVault();
      if (readGeneration !== vaultReadGeneration.current) return false;
      adoptSuccessfulVaultSnapshot(snapshot);
      setSaveState("idle");
      setSaveError(null);
      return true;
    } catch (error) {
      if (readGeneration !== vaultReadGeneration.current) return false;
      dispatchVaultUi({
        type: "load_failed",
        error: "Kayıtlı hesaplara erişilemedi.",
        errorCode: error instanceof VaultRequestError ? error.errorCode ?? null : null,
      });
      return false;
    } finally {
      explicitVaultReads.current = Math.max(0, explicitVaultReads.current - 1);
    }
  }, [adoptSuccessfulVaultSnapshot]);

  const recoverUnreadableVault = useCallback(async () => {
    if (vaultRecoveryBusy) return;
    setVaultRecoveryBusy(true);
    dispatchVaultUi({ type: "recovery_started" });
    try {
      const recovery = await archiveUnreadableVault();
      const loaded = await loadVault();
      if (!loaded) throw new Error("Eski kasa arşivlendi, ancak yeni boş kasa yüklenemedi.");
      setActionError(null);
      setVaultRecoveryNotice(dashboardVaultRecoveryNotice(strictLocal, recovery));
    } catch (error) {
      dispatchVaultUi({
        type: "recovery_failed",
        error: "Yeni kasa güvenli biçimde başlatılamadı.",
      });
    } finally {
      setVaultRecoveryBusy(false);
    }
  }, [loadVault, strictLocal, vaultRecoveryBusy]);

  useEffect(() => {
    const settings = loadSettings();
    setAutoRefresh(settings.autoRefresh);
    orderModeRef.current = settings.sortMode;
    dispatchOrder({ type: "sort_changed", mode: settings.sortMode, accountIds: [] });
    void loadVault();
  }, [loadVault]);

  useEffect(() => {
    if (vaultState !== "ready") return;
    const current = loadSettings();
    if (!saveSettings({ ...current, autoRefresh })) {
      setPreferenceError(strictLocalDashboardMessage(strictLocal, "auto_refresh_save_failed"));
    } else {
      setPreferenceError(null);
    }
  }, [autoRefresh, strictLocal, vaultState]);

  const refreshAccount = useCallback(
    async (id: string): Promise<boolean> => {
      if (inFlight.current.has(id)) return false;
      inFlight.current.add(id);
      try {
        const existingSnapshot = snapshotsRef.current[id];
        if (
          existingSnapshot?.status === "reauth" ||
          (existingSnapshot?.cooldownUntil ?? 0) > Date.now()
        ) return false;
        if (!accountsRef.current.some((account) => account.id === id)) return false;
        commitSnapshot(id, (previous) => ({ ...previous, status: "loading" }));

        // Send the account id so the server can key its shared cache + single-flight refresh lock
        // (lib/usage-service). The refresh token is single-use, so this coordination — not the
        // client — is what stops the dashboard and the cron from racing it.
        const res = await fetch("/api/usage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId: id }),
        });

        // A 401 here means the app session expired (not the Claude token) — go re-authenticate.
        if (res.status === 401) {
          window.location.href = "/login";
          return false;
        }
        const data: UsageResponse & { error?: string } = await res.json().catch(() => ({}) as never);
        if (!res.ok) {
          commitSnapshot(id, (previous) => ({
              ...previous,
              status: "error",
              error: errText(data.error, `Kullanım isteği başarısız oldu (${res.status}).`),
              cooldownUntil: data.cooldownUntil,
              stale: data.stale,
          }));
          return false;
        }

        // Rotation and recovery are completed inside the coordinated server path. The response is
        // deliberately credential-free, so this tab only updates usage and display metadata.
        if (!accountsRef.current.some((a) => a.id === id)) return false;

        // Dead token: the account must be re-added. Never retry-storm (the server is in cooldown).
        if (data.status === "reauth") {
          commitSnapshot(id, (previous) => ({
            ...previous,
            status: "reauth",
            error: data.error,
            cooldownUntil: data.cooldownUntil,
            stale: true,
          }));
          return false;
        }

        // No usage to show: either a hard error, or another poller is mid-refresh (loading) with no
        // cached value yet — in the latter case keep the current view and let the next poll resolve it.
        if (!data.usage) {
          if (data.status === "error" || data.error) {
            commitSnapshot(id, (previous) => ({
                ...previous,
                status: "error",
                error: errText(data.error, "Kullanım verisi yüklenemedi."),
                cooldownUntil: data.cooldownUntil,
                stale: data.stale,
            }));
          } else {
            commitSnapshot(id, (previous) => previous?.usage
              ? { ...previous, status: "ready", stale: true }
              : { ...previous, status: "error", error: "Kullanım verisi hâlâ yenileniyor — birazdan yeniden deneyin." });
          }
          return false;
        }
        const usage = data.usage;

        const cur = accountsRef.current.find((a) => a.id === id)!;
        // Refresh identity/plan only from providers that return a profile (Anthropic). OpenAI keeps
        // its connect-time metadata — data.profile is null — so this refresh is skipped entirely.
        if (data.profile) {
          const plan = planLabel(data.profile);
          const nextEmail = data.profile.account?.email ?? cur.email;
          const nextName = data.profile.account?.full_name ?? cur.fullName;
          const nextPlan = plan === "Claude" ? cur.plan : plan;
          // Only write to the vault when something persisted actually changed.
          if (nextEmail !== cur.email || nextName !== cur.fullName || nextPlan !== cur.plan) {
            const mutation: VaultMutation = {
              op: "update_metadata",
              accountId: id,
              ...(nextEmail !== cur.email ? { email: nextEmail } : {}),
              ...(nextName !== cur.fullName ? { fullName: nextName ?? null } : {}),
              ...(nextPlan !== cur.plan ? { plan: nextPlan } : {}),
            };
            const nextAccounts = accountsRef.current.map((account) =>
              account.id === id
                ? {
                    ...account,
                    email: nextEmail,
                    ...(nextName === undefined ? { fullName: undefined } : { fullName: nextName }),
                    plan: nextPlan,
                  }
                : account,
            );
            accountsRef.current = nextAccounts;
            setAccounts(nextAccounts);
            queueSave(mutation);
          }
        }
        commitSnapshot(id, () => ({
            status: "ready",
            usage,
            profile: data.profile,
            // Stale = the server served its last-good reading during an upstream cooldown; keep the
            // original fetch time so the card can say how old it is.
            fetchedAt: data.fetchedAt ?? Date.now(),
            stale: !!data.stale,
            cooldownUntil: data.cooldownUntil,
        }));
        if (
          strictLocal &&
          data.status === "ready" &&
          !data.stale &&
          localNotifyQueueRef.current !== null
        ) {
          void localNotifyQueueRef.current.enqueue(
            () => processCurrentLocalDashboardSnapshot({
              strictLocal: true,
              response: data,
              accountId: id,
              getActiveAccounts: () => accountsRef.current,
            }),
          )
            .then((status) => {
              if (status !== null) setLocalNotifyStatus(status);
            })
            .catch(() => setLocalNotifyStatus("worker_error"));
        }
        return !data.stale;
      } catch {
        if (accountsRef.current.some((a) => a.id === id)) {
          commitSnapshot(id, (previous) => ({
            ...previous,
            status: "error",
            error: "Ağ bağlantısı kurulamadı.",
          }));
        }
        return false;
      } finally {
        inFlight.current.delete(id);
        dispatchOrder({ type: "account_settled", accountId: id });
      }
    },
    [commitSnapshot, queueSave, strictLocal],
  );

  const refreshAll = useCallback(async () => {
    const ids = accountsRef.current.map((account) => account.id);
    if (ids.length === 0) return;
    dispatchOrder({ type: "batch_started", accountIds: ids });
    const summary = await refreshAllAccounts(ids, refreshAccount);
    acceptSettledSnapshots();
    setLastRefreshAll({ at: Date.now(), ...summary });
  }, [acceptSettledSnapshots, refreshAccount]);

  const refreshSingleAccount = useCallback(async (accountId: string) => {
    dispatchOrder({ type: "batch_started", accountIds: [accountId] });
    await refreshAccount(accountId);
    acceptSettledSnapshots();
  }, [acceptSettledSnapshots, refreshAccount]);

  // The local + pairing connect flows add the account to the vault SERVER-side (never handing the
  // token to the browser), so after one succeeds we re-pull the vault and refresh the newcomer.
  const reloadVault = useCallback(async () => {
    let explicitReadStarted = false;
    let readGeneration: number | null = null;
    try {
      await persistChain.current;
      readGeneration = ++vaultReadGeneration.current;
      explicitVaultReads.current += 1;
      explicitReadStarted = true;
      const snapshot = await fetchVault();
      if (readGeneration !== vaultReadGeneration.current) return;
      adoptSuccessfulVaultSnapshot(snapshot);
      // A connection route may have replaced credentials without changing visible metadata. Reset
      // every returned account rather than comparing secrets the browser no longer receives.
      const resetSnapshots = Object.fromEntries(
        snapshot.accounts.map((account) => [account.id, { status: "idle" as const }]),
      );
      replaceSnapshots(resetSnapshots);
      void refreshAll();
    } catch (error) {
      if (readGeneration !== null && readGeneration !== vaultReadGeneration.current) return;
      setSyncError("Kayıtlı hesaplar yeniden yüklenemedi.");
      throw error;
    } finally {
      if (explicitReadStarted) explicitVaultReads.current = Math.max(0, explicitVaultReads.current - 1);
    }
  }, [adoptSuccessfulVaultSnapshot, refreshAll, replaceSnapshots]);

  // Read the stored trend once, on the client. Doing it in an effect rather than in useState keeps
  // the server render and the first client render identical — localStorage does not exist during SSR.
  useEffect(() => {
    const stored = pruneWeeklyHistory(loadWeeklyHistory(), Date.now());
    weeklyHistoryRef.current = stored;
    setWeeklyHistory(stored);
  }, []);

  useEffect(() => {
    if (vaultState === "ready") void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultState]);

  useEffect(() => {
    if (vaultState !== "ready" || !autoRefresh) return;
    // Every minute — cheap now that reads are served from the shared server cache (upstream is still
    // only hit at most once per 5 min per account). The local countdown ticks between polls.
    const t = setInterval(() => void refreshAll(), 60_000);
    return () => clearInterval(t);
  }, [vaultState, autoRefresh, refreshAll]);

  // Cross-device sync: when this tab regains focus, pull the latest vault (unless a refresh
  // is mid-flight, to avoid clobbering a just-rotated token before it's persisted).
  useEffect(() => {
    const onFocus = () => {
      if (inFlight.current.size > 0 || saveState === "saving") return;
      if (saveState !== "idle") return;
      if (explicitVaultReads.current > 0) return;
      const revisionAtStart = saveRevision.current;
      const readGeneration = ++vaultReadGeneration.current;
      fetchVault()
        .then((snapshot) => {
          // A user edit may have started while this GET was in flight. Its response is then only a
          // historical snapshot; the queued conditional save will merge against the real latest copy.
          if (
            readGeneration !== vaultReadGeneration.current ||
            revisionAtStart !== saveRevision.current ||
            inFlight.current.size > 0
          ) return;
          adoptSuccessfulVaultSnapshot(snapshot);
        })
        .catch((error) => {
          if (readGeneration !== vaultReadGeneration.current) return;
          setSyncError("Kayıtlı hesaplar eşitlenemedi.");
        });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [adoptSuccessfulVaultSnapshot, saveState]);

  // Add-account entry point. Self-hosted installs are always unlimited.
  const handleAddClick = useCallback(() => {
    setActionError(null);
    if (vaultState !== "ready") {
      setActionError(
          vaultState === "error"
          ? vaultUnreadable
            ? strictLocalDashboardMessage(strictLocal, "vault_unreadable")
            : "Kayıtlı hesaplar kullanılamıyor. Aşağıdan yeniden yüklemeyi deneyin."
          : "Kayıtlı hesaplar denetleniyor…",
      );
      return;
    }
    setReconnectAccount(null);
    setModalOpen(true);
  }, [strictLocal, vaultError, vaultState, vaultUnreadable]);

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setReconnectAccount(null);
  }, []);

  const reconnect = useCallback((account: BrowserAccount) => {
    if (strictLocal) {
      setActionError(
        "Bu hesabı değiştirmek için güvenli başlatıcıdaki Claude bağlayıcısını kullanın.",
      );
      return;
    }
    setReconnectAccount(account);
    setModalOpen(true);
  }, [strictLocal]);

  const closeNotifications = useCallback(() => setNotifyOpen(false), []);

  const removeAccount = useCallback(
    (id: string) => {
      inFlight.current.delete(id);
      const next = accountsRef.current.filter((account) => account.id !== id);
      accountsRef.current = next;
      setAccounts(next);
      queueSave({ op: "remove", accountId: id });
      const nextSnapshots = { ...snapshotsRef.current };
      delete nextSnapshots[id];
      replaceSnapshots(nextSnapshots);
      requestAnimationFrame(() => addAccountButtonRef.current?.focus({ preventScroll: true }));
    },
    [queueSave, replaceSnapshots],
  );

  const renameAccount = useCallback(
    (id: string, label: string | undefined) => {
      const normalized = label?.trim() || undefined;
      const current = accountsRef.current.find((account) => account.id === id);
      if (!current || current.label === normalized) return;
      const next = accountsRef.current.map((account) =>
        account.id === id ? { ...account, label: normalized } : account,
      );
      accountsRef.current = next;
      setAccounts(next);
      queueSave({ op: "rename", accountId: id, label: normalized ?? null });
    },
    [queueSave],
  );

  const refreshing = accounts.some((a) => snapshots[a.id]?.status === "loading");

  // When every connected account uses one provider, the page adopts that provider's theme. Mixed or
  // empty dashboards stay neutral; individual cards always retain their own provider theme.
  const pageProvider = useMemo<ProviderId>(() => {
    if (accounts.length === 0) return "anthropic";
    const first = accounts[0].provider ?? "anthropic";
    return accounts.every((a) => (a.provider ?? "anthropic") === first) ? first : "anthropic";
  }, [accounts]);

  const providerOrdinals = useMemo(() => accountProviderOrdinals(accounts), [accounts]);

  useEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute("data-provider");
    root.setAttribute("data-provider", pageProvider);
    return () => {
      if (previous === null) root.removeAttribute("data-provider");
      else root.setAttribute("data-provider", previous);
    };
  }, [pageProvider]);

  const presentedMetrics = useMemo(
    () => settledMetrics.map((metric) => dashboardMetricForNow(metric, now)),
    [now, settledMetrics],
  );
  const accountsById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );
  const quotaSummary = useMemo(
    () => summarizeWeeklyAccountMetrics(presentedMetrics),
    [presentedMetrics],
  );
  // Keyed off the account order rather than the visible (sorted) order: the legend should not
  // reshuffle every time the sort mode changes, since the curves themselves do not move.
  const trendSeries = useMemo(
    () => weeklyTrendSeries(weeklyHistory, accounts.map((account) => account.id), now),
    [accounts, now, weeklyHistory],
  );
  const trendDays = useMemo(() => historyDayWindow(now, WEEKLY_TREND_DAYS), [now]);
  const sortUnavailable = orderState.mode === "weekly-usage"
    ? !settledMetrics.some((metric) => metric.highestWeeklyUsedPercent !== null)
    : orderState.mode === "weekly-reset"
      ? !presentedMetrics.some((metric) => metric.nearestWeeklyResetAt !== null)
      : false;
  const readyAccounts = accounts.filter((account) => snapshots[account.id]?.status === "ready").length;
  const healthLabel = accounts.length === 0
    ? "İlk veri bekleniyor"
    : `${readyAccounts}/${accounts.length} hesap güncel`;

  const retrySave = useCallback(() => queueSave(), [queueSave]);
  const retryPreference = useCallback(() => {
    const current = loadSettings();
    if (saveSettings({ ...current, autoRefresh })) setPreferenceError(null);
  }, [autoRefresh]);

  const changeSortMode = useCallback((mode: QuotaSortMode) => {
    orderModeRef.current = mode;
    dispatchOrder({
      type: "sort_changed",
      mode,
      accountIds: resolvedDashboardOrder(settledMetrics, mode),
    });
    if (saveDashboardSortMode(mode)) setPreferenceError(null);
    else setPreferenceError("Sıralama tercihi bu cihaza kaydedilemedi.");
    setActiveSheet(null);
  }, [settledMetrics]);

  const setAccountElement = useCallback((accountId: string, element: HTMLLIElement | null) => {
    if (element) accountElementsRef.current.set(accountId, element);
    else accountElementsRef.current.delete(accountId);
  }, []);

  useEffect(() => {
    scheduleDashboardOrderScroll(orderState.scrollRequest, accountElementsRef.current);
  }, [orderState.scrollRequest]);

  const changeExpandedAccount = useCallback((accountId: string, expanded: boolean) => {
    setExpandedAccountIds((current) => {
      const next = new Set(current);
      if (expanded) next.add(accountId);
      else next.delete(accountId);
      return next;
    });
  }, []);

  const changeInteractionFence = useCallback((
    accountId: string,
    channel: InteractionChannel,
    active: boolean,
  ) => {
    if (active) {
      dispatchOrder({ type: "interaction_enter", accountId, channel });
      return;
    }
    dispatchOrder({ type: "interaction_leave", accountId, channel });
  }, []);

  return (
    <div className="instrument-app flex min-h-screen flex-col">
      <a href="#dashboard-main" className="skip-link">
        Pano içeriğine geç
      </a>
      <DashboardHeader
        healthLabel={healthLabel}
        autoRefresh={autoRefresh}
        sortMode={orderState.mode}
        sortUnavailable={sortUnavailable}
        refreshing={refreshing}
        canRefresh={accounts.length > 0}
        addAccountButtonRef={addAccountButtonRef}
        onRefresh={() => void refreshAll()}
        onAddAccount={handleAddClick}
        onNotifications={() => setNotifyOpen(true)}
        onSort={() => setActiveSheet("sort")}
        onMenu={() => setActiveSheet("menu")}
      />

      <main
        id="dashboard-main"
        tabIndex={-1}
        className="instrument-shell w-full flex-1 pt-6 sm:pt-8"
      >
        {actionError && (
          <div role="alert" className="animate-fade-in mb-4 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-[#ff9c95]">
            {actionError}
          </div>
        )}
        {vaultRecoveryNotice && (
          <div role="status" className="animate-fade-in mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-coral/40 bg-coral/10 px-4 py-3 text-sm text-ivory">
            <span>{vaultRecoveryNotice}</span>
            <button
              type="button"
              onClick={() => setVaultRecoveryNotice(null)}
              className="min-h-11 rounded-lg border border-current/30 px-3 text-xs font-medium hover:bg-white/5"
            >
              Kapat
            </button>
          </div>
        )}
        {saveState !== "idle" && (
          <div
            role={saveState === "error" ? "alert" : "status"}
            className={`animate-fade-in mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${
              saveState === "error" ? "border-danger/30 bg-danger/10 text-[#ff9c95]" : "border-border bg-surface text-muted"
            }`}
          >
            <span>{saveState === "saving" ? "Hesap değişiklikleri kaydediliyor…" : "Hesap değişiklikleri kaydedilemedi."}</span>
            {saveState === "error" && (
              <button type="button" onClick={retrySave} className="min-h-11 rounded-lg border border-current/30 px-3 py-1.5 font-medium hover:bg-white/5">
                Kaydetmeyi yeniden dene
              </button>
            )}
          </div>
        )}
        {preferenceError && (
          <div role="alert" className="animate-fade-in mb-4 flex items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-[#ff9c95]">
            <span>{preferenceError}</span>
            <button type="button" onClick={retryPreference} className="min-h-11 rounded-lg border border-current/30 px-3 py-1.5 font-medium hover:bg-white/5">
              Tercihi yeniden dene
            </button>
          </div>
        )}
        {syncError && vaultState === "ready" && (
          <div role="alert" className="animate-fade-in mb-4 flex items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-[#ff9c95]">
            <span>Kayıtlı hesaplar eşitlenemedi.</span>
            <button type="button" onClick={() => void reloadVault().catch(() => {})} className="min-h-11 rounded-lg border border-current/30 px-3 py-1.5 font-medium hover:bg-white/5">
              Eşitlemeyi yeniden dene
            </button>
          </div>
        )}
        {vaultState === "loading" ? (
          <div className="mx-auto mt-14 max-w-md space-y-4" aria-label="Kayıtlı hesaplar yükleniyor" role="status">
            <div className="skeleton mx-auto h-12 w-12 rounded-full" />
            <div className="skeleton mx-auto h-8 w-3/4 rounded-lg" />
            <div className="skeleton mx-auto h-4 w-full rounded" />
          </div>
        ) : vaultState === "error" ? (
          <div className="animate-rise mx-auto mt-14 max-w-md rounded-2xl border border-danger/30 bg-danger/10 p-6 text-center">
            <StarburstIcon className="mx-auto h-10 w-10 text-[#ff9c95]" />
            <h2 className="font-display mt-5 text-2xl text-ivory">Kayıtlı hesaplar yüklenemedi</h2>
            <p role="alert" className="mt-3 text-sm leading-relaxed text-muted">
              Kayıtlı verilerinize dokunulmadı. Depolamayı denetleyip yeniden deneyin.
            </p>
            {vaultUnreadable && (
              <p className="mt-3 text-xs leading-relaxed text-[#f0c47d]">
                Yeniden yüklemek eksik şifreleme anahtarını düzeltemez. Önceki anahtarı geri yükleyin veya okunamayan dosyayı yedekleyip boş bir kasayla başlayın.
              </p>
            )}
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
              <button
                type="button"
                onClick={() => void loadVault()}
                disabled={vaultRecoveryBusy}
                className="min-h-11 rounded-xl bg-coral px-5 py-2.5 text-sm font-medium text-white enabled:hover:bg-coral-pressed disabled:opacity-50"
              >
                Anahtarı geri yükledikten sonra dene
              </button>
              {vaultUnreadable && (
                <button
                  type="button"
                  onClick={() => {
                    dispatchVaultUi({ type: "recovery_confirmation_opened" });
                  }}
                  disabled={vaultRecoveryBusy}
                  className="min-h-11 rounded-xl border border-border px-5 py-2.5 text-sm font-medium text-ivory enabled:hover:bg-surface-hover disabled:opacity-50"
                >
                  Güvenle yeniden başla
                </button>
              )}
            </div>
            {vaultRecoveryConfirm && (
              <div role="alert" className="mt-4 rounded-xl border border-[#e3b56e]/35 bg-bg/60 p-4 text-left">
                <p className="text-sm font-medium text-ivory">Okunamayan kasa arşivlenip yeniden başlansın mı?</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Şifreli dosya yeniden adlandırılıp yedek olarak tutulur. Eski anahtar olmadan kimlik bilgileri kurtarılamaz; her hesabı bir kez yeniden bağlamanız gerekir.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => dispatchVaultUi({ type: "recovery_confirmation_closed" })}
                    disabled={vaultRecoveryBusy}
                    className="min-h-11 rounded-lg border border-border px-3 text-xs font-medium text-ivory enabled:hover:bg-surface-hover disabled:opacity-50"
                  >
                    Geçerli kasayı tut
                  </button>
                  <button
                    type="button"
                    onClick={() => void recoverUnreadableVault()}
                    disabled={vaultRecoveryBusy}
                    aria-busy={vaultRecoveryBusy}
                    className="min-h-11 rounded-lg bg-danger/20 px-3 text-xs font-semibold text-[#ff9c95] enabled:hover:bg-danger/30 disabled:opacity-50"
                  >
                    {vaultRecoveryBusy ? "Arşivleniyor…" : "Arşivle ve yeniden başla"}
                  </button>
                </div>
              </div>
            )}
            {vaultRecoveryError && (
              <p role="alert" className="mt-3 text-xs leading-relaxed text-[#ff9c95]">
                {vaultRecoveryError}
              </p>
            )}
          </div>
        ) : accounts.length === 0 ? (
          <div className="animate-rise mx-auto mt-12 max-w-md text-center sm:mt-16">
            <StarburstIcon className="mx-auto h-12 w-12 text-coral" />
            <h2 className="font-display mt-6 text-3xl text-ivory">Tüm hesaplar. Tek kota cetveli.</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              Claude ve ChatGPT/Codex hesaplarınızı bağlayın; kullanım limitlerini tek yerde, otomatik olarak izleyin.
            </p>
            <button
              type="button"
              onClick={handleAddClick}
              className="mt-7 inline-flex min-h-11 items-center gap-2 rounded-xl bg-coral px-5 py-2.5 text-sm font-medium text-white transition-colors enabled:hover:bg-coral-pressed"
            >
              <PlusIcon className="h-4 w-4" />
              İlk hesabı bağla
            </button>
          </div>
        ) : (
          <>
            {/* The 0-100 ruler was removed: with eight accounts its markers stacked into three
                rows of name+percentage chips and stopped being readable at a glance. The readings
                below answer the same question in plain text, and the sort modes surface the rest. */}
            <section className="quota-instrument-overview instrument-overview mb-6 grid min-w-0 gap-4" aria-label="Kota görünümü">
              <QuotaReadings
                summary={quotaSummary}
                accountsById={accountsById}
                providerOrdinals={providerOrdinals}
                now={now}
              />
              <WeeklyTrend
                series={trendSeries}
                days={trendDays}
                accountsById={accountsById}
                providerOrdinals={providerOrdinals}
              />
            </section>
            <DashboardAccountList
              accounts={accounts}
              strictLocal={strictLocal}
              visibleAccountIds={orderState.visibleAccountIds}
              snapshots={snapshots}
              metrics={settledMetrics}
              providerOrdinals={providerOrdinals}
              expandedAccountIds={expandedAccountIds}
              now={now}
              setAccountElement={setAccountElement}
              onMobileExpandedChange={changeExpandedAccount}
              onInteractionFenceChange={changeInteractionFence}
              onRefresh={(accountId) => void refreshSingleAccount(accountId)}
              onRemove={removeAccount}
              onReconnect={strictLocal ? undefined : reconnect}
              onRename={renameAccount}
            />
          </>
        )}
      </main>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-1 px-6 py-6 text-center text-[11px] leading-relaxed text-faint">
          <p>Resmî olmayan araç — Anthropic veya OpenAI ile bağlantılı değildir. Hesap belirteçleri şifreli saklanır.</p>
          {lastRefreshAll && (
            <p>
              {lastRefreshAll.updated === lastRefreshAll.total
                ? `Son yenileme ${formatClock(lastRefreshAll.at)}`
                : lastRefreshAll.updated > 0
                  ? `Son yenileme ${formatClock(lastRefreshAll.at)} · ${lastRefreshAll.updated}/${lastRefreshAll.total} hesap güncellendi`
                  : `Son yenileme denemesi ${formatClock(lastRefreshAll.at)} · hiçbir hesap güncellenmedi`}
            </p>
          )}
        </div>
      </footer>

      <MobileCommandBar
        refreshing={refreshing}
        canRefresh={accounts.length > 0}
        onRefresh={() => void refreshAll()}
        onAddAccount={handleAddClick}
        onNotifications={() => setNotifyOpen(true)}
        onMenu={() => setActiveSheet("menu")}
      />
      <DashboardSheets
        activeSheet={activeSheet}
        sortMode={orderState.mode}
        autoRefresh={autoRefresh}
        showSignOut={showSignOut}
        onClose={() => setActiveSheet(null)}
        onSortModeChange={changeSortMode}
        onAutoRefreshChange={setAutoRefresh}
        onSignOutError={setActionError}
      />

      <AddAccountModal
        open={modalOpen}
        strictLocal={strictLocal}
        onClose={closeModal}
        reconnectAccount={reconnectAccount}
        onServerConnected={reloadVault}
      />
      <NotificationsPanel
        open={notifyOpen}
        onClose={closeNotifications}
        strictLocal={strictLocal}
        autoRefresh={autoRefresh}
        localStatus={localNotifyStatus}
      />
    </div>
  );
}
