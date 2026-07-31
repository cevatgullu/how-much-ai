import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

export const OAUTH_ATTEMPT_TTL_MS = 5 * 60_000;
const OAUTH_ATTEMPT_MAX_ENTRIES = 8;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type OAuthAttemptStatus =
  | "created"
  | "pending"
  | "processing"
  | "done"
  | "failed"
  | "expired";

export interface OAuthAttemptRecord {
  attemptId: string;
  provider: "anthropic";
  status: OAuthAttemptStatus;
  createdAt: number;
  expiresAt: number;
  verifier?: string;
  challenge?: string;
  stateHash?: string;
  expectedAccountId?: string;
  displayLabel?: string;
}

export interface OAuthAttemptPublicStatus {
  status: "pending" | "processing" | "done" | "failed" | "expired";
  provider: "anthropic";
  displayLabel: string;
}

export interface OAuthAttemptStore {
  start(options?: { expectedAccountId?: string }): { attemptId: string };
  launch(attemptId: unknown): { challenge: string; state: string } | null;
  claim(
    state: unknown,
  ): { attemptId: string; verifier: string; expectedAccountId?: string } | null;
  finish(
    attemptId: string,
    outcome: { status: "done"; displayLabel?: string } | { status: "failed" },
  ): boolean;
  status(attemptId: unknown): OAuthAttemptPublicStatus | null;
}

interface OAuthAttemptStoreOptions {
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  records?: Map<string, OAuthAttemptRecord>;
  stateIndex?: Map<string, string>;
}

export class OAuthAttemptCapacityError extends Error {
  constructor() {
    super("Too many OAuth attempts are already active");
    this.name = "OAuthAttemptCapacityError";
  }
}

function digestHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function capability(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
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

function clearPreExchangeSecrets(
  record: OAuthAttemptRecord,
  stateIndex: Map<string, string>,
): void {
  if (record.stateHash) stateIndex.delete(record.stateHash);
  delete record.verifier;
  delete record.challenge;
  delete record.stateHash;
  delete record.expectedAccountId;
}

export function createOAuthAttemptStore(
  options: OAuthAttemptStoreOptions = {},
): OAuthAttemptStore {
  const now = options.now ?? Date.now;
  const random = options.randomBytes ?? ((size: number) => nodeRandomBytes(size));
  const records = options.records ?? new Map<string, OAuthAttemptRecord>();
  const stateIndex = options.stateIndex ?? new Map<string, string>();

  function expirePreExchange(record: OAuthAttemptRecord, current: number): boolean {
    if (
      (record.status === "created" || record.status === "pending") &&
      current >= record.expiresAt
    ) {
      clearPreExchangeSecrets(record, stateIndex);
      record.status = "expired";
      return true;
    }
    return false;
  }

  function makeUniqueCapability(isAvailable: (value: string) => boolean): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const value = capability(random(32));
      if (canonicalCapability(value) && isAvailable(value)) return value;
    }
    throw new Error("OAuth randomness did not produce a unique capability");
  }

  function makeRoom(current: number): void {
    for (const record of records.values()) expirePreExchange(record, current);
    if (records.size < OAUTH_ATTEMPT_MAX_ENTRIES) return;

    const reclaimable = [...records.values()]
      .filter((record) =>
        record.status === "done" ||
        record.status === "failed" ||
        record.status === "expired",
      )
      .sort((left, right) => left.createdAt - right.createdAt);
    for (const record of reclaimable) {
      clearPreExchangeSecrets(record, stateIndex);
      records.delete(record.attemptId);
      if (records.size < OAUTH_ATTEMPT_MAX_ENTRIES) return;
    }
    throw new OAuthAttemptCapacityError();
  }

  return {
    start({ expectedAccountId } = {}) {
      const current = now();
      makeRoom(current);
      const attemptId = makeUniqueCapability((value) => !records.has(value));
      const verifier = capability(random(32));
      const record: OAuthAttemptRecord = {
        attemptId,
        provider: "anthropic",
        status: "created",
        createdAt: current,
        expiresAt: current + OAUTH_ATTEMPT_TTL_MS,
        verifier,
        challenge: createHash("sha256").update(verifier, "utf8").digest("base64url"),
        ...(expectedAccountId ? { expectedAccountId } : {}),
      };
      records.set(attemptId, record);
      return { attemptId };
    },

    launch(attemptId) {
      if (!canonicalCapability(attemptId)) return null;
      const record = records.get(attemptId);
      if (!record || expirePreExchange(record, now()) || record.status !== "created") {
        return null;
      }

      const state = makeUniqueCapability((value) => !stateIndex.has(digestHex(value)));
      const stateHash = digestHex(state);
      const challenge = record.challenge;
      if (!challenge) {
        clearPreExchangeSecrets(record, stateIndex);
        record.status = "failed";
        return null;
      }
      record.stateHash = stateHash;
      record.status = "pending";
      delete record.challenge;
      stateIndex.set(stateHash, record.attemptId);
      return { challenge, state };
    },

    claim(state) {
      if (!canonicalCapability(state)) return null;
      const stateHash = digestHex(state);
      const attemptId = stateIndex.get(stateHash);
      const record = attemptId ? records.get(attemptId) : undefined;
      if (!record || expirePreExchange(record, now()) || record.status !== "pending") {
        return null;
      }

      const verifier = record.verifier;
      if (!verifier) {
        clearPreExchangeSecrets(record, stateIndex);
        record.status = "failed";
        return null;
      }
      const expectedAccountId = record.expectedAccountId;
      record.status = "processing";
      clearPreExchangeSecrets(record, stateIndex);
      return {
        attemptId: record.attemptId,
        verifier,
        ...(expectedAccountId ? { expectedAccountId } : {}),
      };
    },

    finish(attemptId, outcome) {
      const record = records.get(attemptId);
      if (!record || record.status !== "processing") return false;
      record.status = outcome.status;
      record.displayLabel =
        outcome.status === "done" && outcome.displayLabel
          ? outcome.displayLabel
          : "Claude account";
      return true;
    },

    status(attemptId) {
      if (!canonicalCapability(attemptId)) return null;
      const record = records.get(attemptId);
      if (!record) return null;
      expirePreExchange(record, now());
      return {
        status:
          record.status === "created" ? "pending" : record.status,
        provider: "anthropic",
        displayLabel: record.displayLabel ?? "Claude account",
      };
    },
  };
}

declare global {
  var __hmcOAuthAttemptStore: OAuthAttemptStore | undefined;
}

export const oauthAttemptStore =
  globalThis.__hmcOAuthAttemptStore ?? createOAuthAttemptStore();
globalThis.__hmcOAuthAttemptStore = oauthAttemptStore;
