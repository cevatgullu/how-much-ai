import { randomBytes as nodeRandomBytes } from "node:crypto";
import type { ConnectedAccountInfo } from "./connect-account";
import type { OpenAIDeviceAuthorization } from "./providers/openai-device-auth";

const ATTEMPT_TTL_MS = 15 * 60_000;
const MAX_RECORDS = 8;
const POLL_FENCE_MS = 30_000;
const TERMINAL_RETENTION_MS = 60_000;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FAILED_ERROR = "OpenAI device login failed. Start a new login and try again.";
const EXPIRED_ERROR = "OpenAI device login expired. Start a new login and try again.";

interface AttemptBase {
  attemptId: string;
  userId: string;
  createdAt: number;
}

interface LiveAttemptBase extends AttemptBase {
  expiresAt: number;
  intervalMs: number;
  deviceAuthId: string;
  userCode: string;
  expectedAccountId?: string;
}

export interface OpenAIDevicePendingAttempt extends LiveAttemptBase {
  status: "pending";
  nextPollAt: number;
  owner?: never;
  ownerExpiresAt?: never;
}

export interface OpenAIDevicePollingAttempt extends LiveAttemptBase {
  status: "polling";
  owner: string;
  ownerExpiresAt: number;
  nextPollAt?: never;
}

export interface OpenAIDeviceConsumingAttempt extends AttemptBase {
  status: "consuming";
  consumeExpiresAt: number;
  intervalMs: number;
  consumer: string;
  deviceAuthId?: never;
  userCode?: never;
  expectedAccountId?: never;
  owner?: never;
  ownerExpiresAt?: never;
}

interface TerminalAttemptBase extends AttemptBase {
  retainUntil: number;
  deviceAuthId?: never;
  userCode?: never;
  expectedAccountId?: never;
  owner?: never;
  ownerExpiresAt?: never;
}

export interface OpenAIDeviceDoneAttempt extends TerminalAttemptBase {
  status: "done";
  account: ConnectedAccountInfo;
}

export interface OpenAIDeviceFailedAttempt extends TerminalAttemptBase {
  status: "failed";
}

export interface OpenAIDeviceExpiredAttempt extends TerminalAttemptBase {
  status: "expired";
}

export type OpenAIDeviceAttemptRecord =
  | OpenAIDevicePendingAttempt
  | OpenAIDevicePollingAttempt
  | OpenAIDeviceConsumingAttempt
  | OpenAIDeviceDoneAttempt
  | OpenAIDeviceFailedAttempt
  | OpenAIDeviceExpiredAttempt;

export type OpenAIDeviceAttemptPublicStatus =
  | { status: "pending" | "processing"; pollAfterMs: number; expiresAt: number }
  | { status: "done"; account: ConnectedAccountInfo }
  | { status: "failed" | "expired"; error: string };

export type OpenAIDevicePollClaim =
  | {
      kind: "poll";
      owner: string;
      authorization: OpenAIDeviceAuthorization;
      expectedAccountId?: string;
    }
  | { kind: "pending" | "processing"; pollAfterMs: number; expiresAt: number };

export interface OpenAIDeviceAttemptStore {
  start(
    userId: string,
    authorization: OpenAIDeviceAuthorization,
    expectedAccountId?: string,
  ): { attemptId: string; userCode: string; pollAfterMs: number; expiresAt: number };
  claimPoll(attemptId: unknown, userId: string): OpenAIDevicePollClaim | null;
  renewPoll(attemptId: unknown, owner: unknown): boolean;
  releasePending(attemptId: unknown, owner: unknown): boolean;
  beginConsume(attemptId: unknown, owner: unknown): boolean;
  complete(
    attemptId: unknown,
    owner: unknown,
    account: ConnectedAccountInfo,
  ): boolean;
  fail(attemptId: unknown, owner: unknown): boolean;
  status(attemptId: unknown, userId: string): OpenAIDeviceAttemptPublicStatus | null;
}

interface OpenAIDeviceAttemptStoreOptions {
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  records?: Map<string, OpenAIDeviceAttemptRecord>;
}

export class OpenAIDeviceAttemptCapacityError extends Error {
  constructor() {
    super("Too many OpenAI device login attempts are already active");
    this.name = "OpenAIDeviceAttemptCapacityError";
  }
}

function canonicalCapability(value: unknown): value is string {
  if (typeof value !== "string" || !CAPABILITY_PATTERN.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 32 && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

function copyAccount(account: ConnectedAccountInfo): ConnectedAccountInfo {
  return {
    id: account.id,
    email: account.email,
    plan: account.plan,
    label: account.label,
    alreadyConnected: account.alreadyConnected,
  };
}

export function createOpenAIDeviceAttemptStore(
  options: OpenAIDeviceAttemptStoreOptions = {},
): OpenAIDeviceAttemptStore {
  const now = options.now ?? Date.now;
  const random = options.randomBytes ?? ((size: number) => nodeRandomBytes(size));
  const records = options.records ?? new Map<string, OpenAIDeviceAttemptRecord>();

  function terminalRecord(
    record:
      | OpenAIDevicePendingAttempt
      | OpenAIDevicePollingAttempt
      | OpenAIDeviceConsumingAttempt,
    status: "failed" | "expired",
    current: number,
  ): OpenAIDeviceFailedAttempt | OpenAIDeviceExpiredAttempt {
    return {
      attemptId: record.attemptId,
      userId: record.userId,
      createdAt: record.createdAt,
      status,
      retainUntil: current + TERMINAL_RETENTION_MS,
    };
  }

  function expireLiveRecord(
    record: OpenAIDeviceAttemptRecord,
    current: number,
  ): OpenAIDeviceAttemptRecord {
    if (
      ((record.status === "pending" || record.status === "polling") &&
        current >= record.expiresAt) ||
      (record.status === "consuming" && current >= record.consumeExpiresAt)
    ) {
      const expired = terminalRecord(record, "expired", current);
      records.set(record.attemptId, expired);
      return expired;
    }
    return record;
  }

  function pruneRecord(
    record: OpenAIDeviceAttemptRecord,
    current: number,
  ): OpenAIDeviceAttemptRecord | null {
    const currentRecord = expireLiveRecord(record, current);
    if (
      (currentRecord.status === "done" ||
        currentRecord.status === "failed" ||
        currentRecord.status === "expired") &&
      current >= currentRecord.retainUntil
    ) {
      records.delete(currentRecord.attemptId);
      return null;
    }
    return currentRecord;
  }

  function makeCapability(isAvailable: (value: string) => boolean): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const value = Buffer.from(random(32)).toString("base64url");
      if (canonicalCapability(value) && isAvailable(value)) return value;
    }
    throw new Error("OpenAI device login randomness did not produce a unique capability");
  }

  function ownerAvailable(value: string): boolean {
    if (records.has(value)) return false;
    for (const record of records.values()) {
      if (
        (record.status === "polling" && record.owner === value) ||
        (record.status === "consuming" && record.consumer === value)
      ) {
        return false;
      }
    }
    return true;
  }

  function makeRoom(current: number): void {
    for (const record of [...records.values()]) pruneRecord(record, current);
    if (records.size < MAX_RECORDS) return;

    const reclaimable = [...records.values()]
      .filter(
        (record): record is
          | OpenAIDeviceDoneAttempt
          | OpenAIDeviceFailedAttempt
          | OpenAIDeviceExpiredAttempt =>
          record.status === "done" ||
          record.status === "failed" ||
          record.status === "expired",
      )
      .sort((left, right) => left.createdAt - right.createdAt);
    for (const record of reclaimable) {
      records.delete(record.attemptId);
      if (records.size < MAX_RECORDS) return;
    }
    throw new OpenAIDeviceAttemptCapacityError();
  }

  function ownedPollingRecord(
    attemptId: unknown,
    owner: unknown,
    current: number,
  ): OpenAIDevicePollingAttempt | null {
    if (!canonicalCapability(attemptId) || !canonicalCapability(owner)) return null;
    const found = records.get(attemptId);
    const record = found ? pruneRecord(found, current) : null;
    if (
      !record ||
      record.status !== "polling" ||
      record.owner !== owner ||
      current >= record.ownerExpiresAt
    ) {
      return null;
    }
    return record;
  }

  function ownedConsumingRecord(
    attemptId: unknown,
    consumer: unknown,
    current: number,
  ): OpenAIDeviceConsumingAttempt | null {
    if (!canonicalCapability(attemptId) || !canonicalCapability(consumer)) return null;
    const found = records.get(attemptId);
    const record = found ? pruneRecord(found, current) : null;
    if (!record || record.status !== "consuming" || record.consumer !== consumer) return null;
    return record;
  }

  return {
    start(userId, authorization, expectedAccountId) {
      const current = now();
      makeRoom(current);
      const attemptId = makeCapability((value) => !records.has(value));
      const expiresAt = Math.min(authorization.expiresAt, current + ATTEMPT_TTL_MS);
      const record: OpenAIDevicePendingAttempt = {
        attemptId,
        userId,
        createdAt: current,
        status: "pending",
        expiresAt,
        intervalMs: authorization.intervalMs,
        nextPollAt: current + authorization.intervalMs,
        deviceAuthId: authorization.deviceAuthId,
        userCode: authorization.userCode,
        ...(expectedAccountId ? { expectedAccountId } : {}),
      };
      records.set(attemptId, record);
      return {
        attemptId,
        userCode: record.userCode,
        pollAfterMs: record.intervalMs,
        expiresAt: record.expiresAt,
      };
    },

    claimPoll(attemptId, userId) {
      if (!canonicalCapability(attemptId)) return null;
      const current = now();
      const found = records.get(attemptId);
      if (!found || found.userId !== userId) return null;
      const record = pruneRecord(found, current);
      if (!record) {
        return null;
      }

      if (record.status === "consuming") {
        return {
          kind: "processing",
          pollAfterMs: Math.min(
            record.intervalMs,
            Math.max(0, record.consumeExpiresAt - current),
          ),
          expiresAt: record.consumeExpiresAt,
        };
      }
      if (record.status !== "pending" && record.status !== "polling") return null;

      if (record.status === "pending" && current < record.nextPollAt) {
        return {
          kind: "pending",
          pollAfterMs: record.nextPollAt - current,
          expiresAt: record.expiresAt,
        };
      }
      if (record.status === "polling" && current < record.ownerExpiresAt) {
        return {
          kind: "processing",
          pollAfterMs: record.ownerExpiresAt - current,
          expiresAt: record.expiresAt,
        };
      }

      const owner = makeCapability(ownerAvailable);
      const polling: OpenAIDevicePollingAttempt = {
        attemptId: record.attemptId,
        userId: record.userId,
        createdAt: record.createdAt,
        status: "polling",
        expiresAt: record.expiresAt,
        intervalMs: record.intervalMs,
        deviceAuthId: record.deviceAuthId,
        userCode: record.userCode,
        ...(record.expectedAccountId
          ? { expectedAccountId: record.expectedAccountId }
          : {}),
        owner,
        ownerExpiresAt: current + POLL_FENCE_MS,
      };
      records.set(record.attemptId, polling);
      return {
        kind: "poll",
        owner,
        authorization: {
          deviceAuthId: polling.deviceAuthId,
          userCode: polling.userCode,
          intervalMs: polling.intervalMs,
          expiresAt: polling.expiresAt,
        },
        ...(polling.expectedAccountId
          ? { expectedAccountId: polling.expectedAccountId }
          : {}),
      };
    },

    renewPoll(attemptId, owner) {
      const current = now();
      const record = ownedPollingRecord(attemptId, owner, current);
      if (!record) return false;
      records.set(record.attemptId, {
        ...record,
        ownerExpiresAt: current + POLL_FENCE_MS,
      });
      return true;
    },

    releasePending(attemptId, owner) {
      const current = now();
      const record = ownedPollingRecord(attemptId, owner, current);
      if (!record) return false;
      const pending: OpenAIDevicePendingAttempt = {
        attemptId: record.attemptId,
        userId: record.userId,
        createdAt: record.createdAt,
        status: "pending",
        expiresAt: record.expiresAt,
        intervalMs: record.intervalMs,
        deviceAuthId: record.deviceAuthId,
        userCode: record.userCode,
        ...(record.expectedAccountId
          ? { expectedAccountId: record.expectedAccountId }
          : {}),
        nextPollAt: current + record.intervalMs,
      };
      records.set(record.attemptId, pending);
      return true;
    },

    beginConsume(attemptId, owner) {
      const current = now();
      const record = ownedPollingRecord(attemptId, owner, current);
      if (!record) return false;
      records.set(record.attemptId, {
        attemptId: record.attemptId,
        userId: record.userId,
        createdAt: record.createdAt,
        status: "consuming",
        consumeExpiresAt: current + ATTEMPT_TTL_MS,
        intervalMs: record.intervalMs,
        consumer: record.owner,
      });
      return true;
    },

    complete(attemptId, owner, account) {
      const current = now();
      const record = ownedConsumingRecord(attemptId, owner, current);
      if (!record) return false;
      records.set(record.attemptId, {
        attemptId: record.attemptId,
        userId: record.userId,
        createdAt: record.createdAt,
        status: "done",
        retainUntil: current + TERMINAL_RETENTION_MS,
        account: copyAccount(account),
      });
      return true;
    },

    fail(attemptId, owner) {
      const current = now();
      const record =
        ownedPollingRecord(attemptId, owner, current) ??
        ownedConsumingRecord(attemptId, owner, current);
      if (!record) return false;
      records.set(record.attemptId, terminalRecord(record, "failed", current));
      return true;
    },

    status(attemptId, userId) {
      if (!canonicalCapability(attemptId)) return null;
      const current = now();
      const found = records.get(attemptId);
      if (!found || found.userId !== userId) return null;
      const record = pruneRecord(found, current);
      if (!record) return null;

      if (record.status === "pending") {
        return {
          status: "pending",
          pollAfterMs: Math.max(0, record.nextPollAt - current),
          expiresAt: record.expiresAt,
        };
      }
      if (record.status === "polling") {
        return {
          status: "processing",
          pollAfterMs: Math.max(0, record.ownerExpiresAt - current),
          expiresAt: record.expiresAt,
        };
      }
      if (record.status === "consuming") {
        return {
          status: "processing",
          pollAfterMs: Math.min(
            record.intervalMs,
            Math.max(0, record.consumeExpiresAt - current),
          ),
          expiresAt: record.consumeExpiresAt,
        };
      }
      if (record.status === "done") {
        return { status: "done", account: copyAccount(record.account) };
      }
      if (record.status === "failed") {
        return { status: "failed", error: FAILED_ERROR };
      }
      return { status: "expired", error: EXPIRED_ERROR };
    },
  };
}

declare global {
  var __hmcOpenAIDeviceAttemptStore: OpenAIDeviceAttemptStore | undefined;
}

export const openAIDeviceAttemptStore =
  globalThis.__hmcOpenAIDeviceAttemptStore ?? createOpenAIDeviceAttemptStore();
globalThis.__hmcOpenAIDeviceAttemptStore = openAIDeviceAttemptStore;
