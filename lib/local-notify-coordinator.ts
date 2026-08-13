import type { NormalizedUsageBar } from "./format";
// @ts-expect-error Node's direct TypeScript test runner needs the source extension.
import { diffLocalLimit, formatLocalLimitNotification, type LocalNotifyRules } from "./local-notify-detect.ts";
// @ts-expect-error Node's direct TypeScript test runner needs the source extension.
import { deliverLocalNotification, type LocalDeliveryResult, type LocalWorkerNotification } from "./local-notify-delivery.ts";
// @ts-expect-error Node's direct TypeScript test runner needs the source extension.
import { hashLocalAccountId, loadLocalNotifyDocument, localNotificationTag, saveLocalNotifyDocument, type LocalNotifyDocument, type LocalNotifyRecord } from "./local-notify-store.ts";

const LOCAL_NOTIFY_LOCK_NAME = "hma-local-notifications-v1";
const LOCAL_NOTIFY_LOCK_OPTIONS = { mode: "exclusive", ifAvailable: true } as const;

export interface LocalSnapshotInput {
  accountId: string;
  accountLabel: string;
  bars: readonly NormalizedUsageBar[];
  activeAccountIds: readonly string[];
  rules: LocalNotifyRules;
  stale: boolean;
}

export type LocalNotifyRuntimeStatus =
  | "idle"
  | "delivered"
  | "denied"
  | "unsupported"
  | "worker_error"
  | "storage_error"
  | "lock_unavailable";

export interface LocalNotifyRuntimeResult {
  status: LocalNotifyRuntimeStatus;
  delivered: number;
}

export interface LocalNotifyLockManager {
  request(
    name: string,
    options: typeof LOCAL_NOTIFY_LOCK_OPTIONS,
    callback: (lock: unknown | null) => Promise<LocalNotifyRuntimeResult | undefined>,
  ): Promise<LocalNotifyRuntimeResult | undefined>;
}

export interface LocalNotifyCoordinatorDependencies {
  locks?: LocalNotifyLockManager | null;
  storage?: Storage | null;
  hashAccountId?: (accountId: string) => Promise<string>;
  notificationTag?: (accountHash: string, limitKey: string) => Promise<string>;
  loadDocument?: typeof loadLocalNotifyDocument;
  saveDocument?: typeof saveLocalNotifyDocument;
  deliver?: (payload: LocalWorkerNotification) => Promise<LocalDeliveryResult>;
}

function dependencyWasProvided(
  dependencies: LocalNotifyCoordinatorDependencies | undefined,
  name: keyof LocalNotifyCoordinatorDependencies,
): boolean {
  return dependencies !== undefined && Object.prototype.hasOwnProperty.call(dependencies, name);
}

function lockManager(dependencies: LocalNotifyCoordinatorDependencies | undefined): LocalNotifyLockManager | null {
  try {
    if (dependencyWasProvided(dependencies, "locks")) return dependencies?.locks ?? null;
    if (
      typeof navigator === "undefined" ||
      navigator.locks === undefined ||
      typeof navigator.locks.request !== "function"
    ) return null;
    return {
      request: async (name, options, callback) =>
        await navigator.locks.request(name, options, async (lock) => await callback(lock)),
    };
  } catch {
    return null;
  }
}

function transactionStorage(dependencies: LocalNotifyCoordinatorDependencies | undefined): Storage | null {
  if (dependencyWasProvided(dependencies, "storage")) return dependencies?.storage ?? null;
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

function identity(accountHash: string, limitKey: string): string {
  return accountHash + "\0" + limitKey;
}

function recordFromState(
  accountHash: string,
  limitKey: string,
  state: Pick<LocalNotifyRecord, "lastResetAt" | "nextBoundaryIndex" | "lastObservedUtilization">,
): LocalNotifyRecord {
  return {
    accountHash,
    limitKey,
    lastResetAt: state.lastResetAt,
    nextBoundaryIndex: state.nextBoundaryIndex,
    lastObservedUtilization: state.lastObservedUtilization,
  };
}

function deliveryFailureStatus(result: LocalDeliveryResult): Exclude<
  LocalNotifyRuntimeStatus,
  "idle" | "delivered" | "storage_error" | "lock_unavailable"
> {
  if (result.ok) return "worker_error";
  if (result.reason === "denied") return "denied";
  if (result.reason === "unsupported") return "unsupported";
  return "worker_error";
}

async function runTransaction(
  input: LocalSnapshotInput,
  dependencies: LocalNotifyCoordinatorDependencies | undefined,
  deliveredCounter: { value: number },
): Promise<LocalNotifyRuntimeResult> {
  const hashAccountId = dependencies?.hashAccountId ?? hashLocalAccountId;
  const createTag = dependencies?.notificationTag ?? localNotificationTag;
  const loadDocument = dependencies?.loadDocument ?? loadLocalNotifyDocument;
  const saveDocument = dependencies?.saveDocument ?? saveLocalNotifyDocument;
  const deliver = dependencies?.deliver ?? deliverLocalNotification;

  const accountHash = await hashAccountId(input.accountId);
  const activeAccountHashes = new Set<string>();
  for (const activeAccountId of input.activeAccountIds) {
    activeAccountHashes.add(await hashAccountId(activeAccountId));
  }

  const storage = transactionStorage(dependencies);
  if (!storage) return { status: "storage_error", delivered: deliveredCounter.value };
  const loaded = loadDocument(storage);
  if (!loaded.ok && loaded.error === "unavailable") {
    return { status: "storage_error", delivered: deliveredCounter.value };
  }

  const records = new Map<string, LocalNotifyRecord>();
  for (const record of loaded.document.records) {
    records.set(identity(record.accountHash, record.limitKey), { ...record });
  }

  let firstFailure: LocalNotifyRuntimeStatus | null = null;
  const currentLimitKeys = new Set<string>();
  for (const bar of input.bars) {
    currentLimitKeys.add(bar.key);
    const recordIdentity = identity(accountHash, bar.key);
    const previous = records.get(recordIdentity);
    const diff = diffLocalLimit(
      previous,
      {
        limitKey: bar.key,
        usedPercent: bar.usedPercent,
        remainingPercent: bar.remainingPercent,
        resetsAt: bar.resetsAt,
      },
      input.rules,
    );

    if (diff.kind === "ignore") continue;
    if (diff.event === null) {
      records.set(recordIdentity, recordFromState(accountHash, bar.key, diff.nextState));
      continue;
    }

    const copy = formatLocalLimitNotification(diff.event, input.accountLabel, bar.label);
    const tag = await createTag(accountHash, bar.key);
    let delivery: LocalDeliveryResult;
    try {
      delivery = await deliver({ ...copy, tag });
    } catch {
      delivery = { ok: false, reason: "worker", message: "Local notification delivery failed." };
    }
    if (delivery.ok) {
      deliveredCounter.value += 1;
      records.set(recordIdentity, recordFromState(accountHash, bar.key, diff.nextState));
    } else if (firstFailure === null) {
      firstFailure = deliveryFailureStatus(delivery);
    }
  }

  for (const [recordIdentity, record] of records) {
    if (record.accountHash === accountHash && !currentLimitKeys.has(record.limitKey)) {
      records.delete(recordIdentity);
    }
  }
  for (const [recordIdentity, record] of records) {
    if (!activeAccountHashes.has(record.accountHash)) records.delete(recordIdentity);
  }

  const document: LocalNotifyDocument = { version: 1, records: [...records.values()] };
  const saved = saveDocument(storage, document);
  if (!saved.ok) return { status: "storage_error", delivered: deliveredCounter.value };
  if (firstFailure !== null) return { status: firstFailure, delivered: deliveredCounter.value };
  return {
    status: deliveredCounter.value > 0 ? "delivered" : "idle",
    delivered: deliveredCounter.value,
  };
}

export async function processLocalNotificationSnapshot(
  input: LocalSnapshotInput,
  dependencies?: LocalNotifyCoordinatorDependencies,
): Promise<LocalNotifyRuntimeResult> {
  if (input.stale) return { status: "idle", delivered: 0 };

  const locks = lockManager(dependencies);
  if (!locks) return { status: "lock_unavailable", delivered: 0 };

  const deliveredCounter = { value: 0 };
  let entered = false;
  try {
    const result = await locks.request(
      LOCAL_NOTIFY_LOCK_NAME,
      LOCAL_NOTIFY_LOCK_OPTIONS,
      async (lock) => {
        if (!lock) return undefined;
        entered = true;
        try {
          return await runTransaction(input, dependencies, deliveredCounter);
        } catch {
          return { status: "storage_error", delivered: deliveredCounter.value };
        }
      },
    );
    if (!entered || result === undefined) return { status: "lock_unavailable", delivered: 0 };
    return result;
  } catch {
    return { status: "lock_unavailable", delivered: 0 };
  }
}
