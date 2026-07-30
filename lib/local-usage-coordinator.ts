import { decideCacheAction, type CacheEntry } from "./usage-cache-core";
import type { AccountTokens, ProfileData, UsageData } from "./types";

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

interface LocalEntry {
  usage: UsageData | null;
  profile: ProfileData | null;
  fetchedAt: number;
  status: string;
  cooldownUntil: number;
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
  private readonly clock: () => number;
  private readonly refresh: LocalUsageRefresh<Account>;

  constructor(clock: () => number, refresh: LocalUsageRefresh<Account>) {
    this.clock = clock;
    this.refresh = refresh;
  }

  async getAccountUsage(
    key: string,
    userId: string,
    account: Account,
  ): Promise<AccountUsageResult> {
    const now = this.clock();
    const entry = this.cache.get(key) ?? null;
    const action =
      entry?.status === "reauth" ? "cooldown" : decideCacheAction(toCacheEntry(entry), now);
    if (action === "fresh") return cachedResult(entry, false);
    if (action === "cooldown") return cachedResult(entry, true);

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const store: LocalUsageCacheStore = {
      commit: async (outcome) => {
        const previous = this.cache.get(key);
        this.cache.set(key, {
          usage: outcome.usage !== undefined ? outcome.usage : (previous?.usage ?? null),
          profile:
            outcome.profile !== undefined ? outcome.profile : (previous?.profile ?? null),
          fetchedAt:
            outcome.fetchedAt !== undefined ? outcome.fetchedAt : (previous?.fetchedAt ?? 0),
          status: outcome.status,
          cooldownUntil: outcome.cooldownUntil,
        });
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
      if (this.inflight.get(key) === pending) this.inflight.delete(key);
    }
  }

  clear(key: string): void {
    this.cache.delete(key);
  }
}
