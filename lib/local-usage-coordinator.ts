import { decideCacheAction, type CacheEntry } from "./usage-cache-core";
import type { AccountTokens, ProfileData, UsageData } from "./types";

const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_IDLE_TTL_MS = 24 * 60 * 60_000;

export type AccountUsageStatus = "ready" | "reauth" | "stale" | "error" | "loading";

export interface AccountUsageResult {
  usage: UsageData | null;
  profile: ProfileData | null;
  status: AccountUsageStatus;
  fetchedAt: number | null;
  cooldownUntil: number;
  stale: boolean;
  error?: string;
  // Rotated pairs are normally durable already and are echoed only to keep the current tab in sync.
  tokens?: AccountTokens;
  // Present only when renewal succeeded but every durable vault write failed.
  tokensNeedPersistence?: true;
}

export interface LocalUsageCacheStore {
  commit(outcome: {
    usage?: UsageData;
    profile?: ProfileData | null;
    fetchedAt?: number;
    status: string;
    cooldownUntil: number;
  }): Promise<void>;
  release(): Promise<void>;
}

export interface LocalUsagePrior {
  usage: UsageData | null;
  profile: ProfileData | null;
  fetchedAt: number | null;
  status: string | null;
}

export interface LocalUsageRefreshRequest<Account extends { id: string }> {
  userId: string;
  account: Account;
  now: number;
  store: LocalUsageCacheStore;
  prior: LocalUsagePrior;
}

export type LocalUsageRefresh<Account extends { id: string }> = (
  request: LocalUsageRefreshRequest<Account>,
) => Promise<AccountUsageResult>;

export interface LocalUsageCoordinatorOptions {
  maxEntries?: number;
  idleTtlMs?: number;
}

interface LocalEntry {
  usage: UsageData | null;
  profile: ProfileData | null;
  fetchedAt: number;
  status: string;
  cooldownUntil: number;
  lastAccessedAt: number;
  accessOrder: number;
}

function toCacheEntry(entry: LocalEntry | null): CacheEntry | null {
  if (!entry) return null;
  return {
    hasUsage: entry.usage != null,
    fetchedAt: entry.fetchedAt,
    status: entry.status,
    cooldownUntil: entry.cooldownUntil,
    refreshingUntil: 0,
  };
}

function fetchedAtOf(entry: LocalEntry | null): number | null {
  if (!entry) return null;
  return entry.usage !== null || entry.fetchedAt !== 0 ? entry.fetchedAt : null;
}

function cachedResult(entry: LocalEntry | null, stale: boolean): AccountUsageResult {
  if (!entry) {
    return {
      usage: null,
      profile: null,
      status: "loading",
      fetchedAt: null,
      cooldownUntil: 0,
      stale,
    };
  }
  const refreshThrottled = entry.status.startsWith("refresh_throttled_");
  const status = (
    entry.status === "reauth"
      ? "reauth"
      : stale
        ? entry.usage
          ? "stale"
          : entry.status === "error" || refreshThrottled
            ? "error"
            : "loading"
        : "ready"
  ) as AccountUsageStatus;
  return {
    usage: entry.usage,
    profile: null,
    status,
    fetchedAt: fetchedAtOf(entry),
    cooldownUntil: entry.cooldownUntil,
    stale,
    ...(refreshThrottled
      ? { error: "Automatic renewal is temporarily throttled. The app will retry after its cooldown." }
      : {}),
  };
}

function failedResult(prior: LocalUsagePrior, error: unknown): AccountUsageResult {
  const message = error instanceof Error ? error.message : "Failed to reach Anthropic";
  if (prior.usage) {
    return {
      usage: prior.usage,
      profile: prior.profile,
      status: "stale",
      fetchedAt: prior.fetchedAt,
      cooldownUntil: 0,
      stale: true,
      error: message,
    };
  }
  return {
    usage: null,
    profile: null,
    status: "error",
    fetchedAt: null,
    cooldownUntil: 0,
    stale: true,
    error: message,
  };
}

// The production local backend and deterministic tests share this cache/single-flight authority.
export class LocalUsageCoordinator<Account extends { id: string }> {
  private readonly cache = new Map<string, LocalEntry>();
  private readonly inflight = new Map<string, Promise<AccountUsageResult>>();
  private readonly clearedInflight = new Set<string>();
  private readonly clock: () => number;
  private readonly refresh: LocalUsageRefresh<Account>;
  private readonly maxEntries: number;
  private readonly idleTtlMs: number;
  private accessOrder = 0;

  constructor(
    clock: () => number,
    refresh: LocalUsageRefresh<Account>,
    options: LocalUsageCoordinatorOptions = {},
  ) {
    this.clock = clock;
    this.refresh = refresh;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error("Local usage cache maxEntries must be a positive safe integer.");
    }
    if (!Number.isFinite(this.idleTtlMs) || this.idleTtlMs <= 0) {
      throw new Error("Local usage cache idleTtlMs must be positive.");
    }
  }

  async getAccountUsage(
    key: string,
    userId: string,
    account: Account,
  ): Promise<AccountUsageResult> {
    const now = this.clock();
    this.prune(now);
    const entry = this.cache.get(key) ?? null;
    if (entry) this.touch(entry, now);
    const action =
      entry?.status === "reauth" ? "cooldown" : decideCacheAction(toCacheEntry(entry), now);
    if (action === "fresh") return cachedResult(entry, false);
    if (action === "cooldown") return cachedResult(entry, true);

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const store: LocalUsageCacheStore = {
      commit: async (outcome) => {
        if (this.clearedInflight.has(key)) return;
        const previous = this.cache.get(key);
        const accessedAt = this.clock();
        this.cache.set(key, {
          usage: outcome.usage !== undefined ? outcome.usage : (previous?.usage ?? null),
          profile:
            outcome.profile !== undefined ? outcome.profile : (previous?.profile ?? null),
          fetchedAt:
            outcome.fetchedAt !== undefined ? outcome.fetchedAt : (previous?.fetchedAt ?? 0),
          status: outcome.status,
          cooldownUntil: outcome.cooldownUntil,
          lastAccessedAt: accessedAt,
          accessOrder: ++this.accessOrder,
        });
        this.prune(accessedAt);
      },
      release: async () => {},
    };
    const prior: LocalUsagePrior = {
      usage: entry?.usage ?? null,
      profile: null,
      fetchedAt: fetchedAtOf(entry),
      status: entry?.status ?? null,
    };
    const pending = Promise.resolve()
      .then(() => this.refresh({ userId, account, now, store, prior }))
      .catch((error) => failedResult(prior, error));
    this.inflight.set(key, pending);

    try {
      return await pending;
    } finally {
      if (this.inflight.get(key) === pending) {
        this.inflight.delete(key);
        this.clearedInflight.delete(key);
        this.prune(this.clock());
      }
    }
  }

  clear(key: string): void {
    this.cache.delete(key);
    if (this.inflight.has(key)) this.clearedInflight.add(key);
  }

  cacheSizeForTest(): number {
    return this.cache.size;
  }

  private touch(entry: LocalEntry, now: number): void {
    entry.lastAccessedAt = now;
    entry.accessOrder = ++this.accessOrder;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.cache) {
      if (this.inflight.has(key)) continue;
      if (now - entry.lastAccessedAt >= this.idleTtlMs) this.cache.delete(key);
    }
    if (this.cache.size <= this.maxEntries) return;

    const candidates = [...this.cache.entries()]
      .filter(([key]) => !this.inflight.has(key))
      .sort((left, right) => left[1].accessOrder - right[1].accessOrder);
    for (const [key] of candidates) {
      if (this.cache.size <= this.maxEntries) break;
      this.cache.delete(key);
    }
  }
}
