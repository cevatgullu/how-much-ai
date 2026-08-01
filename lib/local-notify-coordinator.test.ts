import assert from "node:assert/strict";
import { test } from "node:test";
import type { NormalizedUsageBar } from "./format";
import {
  processLocalNotificationSnapshot,
  type LocalNotifyCoordinatorDependencies,
  type LocalSnapshotInput,
} from "./local-notify-coordinator.ts";
import type { LocalDeliveryResult, LocalWorkerNotification } from "./local-notify-delivery";
import {
  LOCAL_NOTIFY_STATE_STORAGE_KEY,
  MAX_LOCAL_NOTIFY_STATE_BYTES,
  type LocalNotifyDocument,
} from "./local-notify-store.ts";

const T1 = "2026-07-31T10:00:00.000Z";
const T2 = "2026-07-31T15:00:00.000Z";
const RULES = { remainingWarnings: true, resetNotifications: true };

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  readonly reads: string[] = [];
  readonly writes: Array<[string, string]> = [];
  readonly removes: string[] = [];

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null {
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }
  removeItem(key: string): void {
    this.removes.push(key);
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.writes.push([key, value]);
    this.values.set(key, value);
  }
}

function bar(
  key: string,
  remainingPercent: number,
  resetsAt: string | null = T1,
  label = key,
): NormalizedUsageBar {
  return {
    key,
    kind: key,
    label,
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    resetsAt,
    severity: "normal",
    isActive: false,
  };
}

function snapshot(overrides: Partial<LocalSnapshotInput> = {}): LocalSnapshotInput {
  return {
    accountId: "account-a",
    accountLabel: "Claude 1",
    bars: [bar("session", 51)],
    activeAccountIds: ["account-a"],
    rules: RULES,
    stale: false,
    ...overrides,
  };
}

function hashFor(accountId: string): string {
  const code = Math.max(0, ["account-a", "account-b", "account-c", "account-d"].indexOf(accountId));
  return (code + 10).toString(16).repeat(64);
}

function unlockedDependencies(
  storage: Storage,
  deliver: (payload: LocalWorkerNotification) => Promise<LocalDeliveryResult> = async () => ({ ok: true }),
): LocalNotifyCoordinatorDependencies {
  return {
    locks: {
      request: async (name, options, callback) => {
        assert.equal(name, "hma-local-notifications-v1");
        assert.deepEqual(options, { mode: "exclusive", ifAvailable: true });
        return await callback({ name });
      },
    },
    storage,
    hashAccountId: async (accountId) => hashFor(accountId),
    notificationTag: async (accountHash, limitKey) =>
      `hma:${(accountHash + limitKey).replace(/[^a-f0-9]/g, "a").slice(0, 32).padEnd(32, "a")}`,
    deliver,
  };
}

function stored(storage: MemoryStorage): LocalNotifyDocument {
  return JSON.parse(storage.values.get(LOCAL_NOTIFY_STATE_STORAGE_KEY) ?? "") as LocalNotifyDocument;
}

test("stale snapshots return idle before locks, storage, hashing, or delivery", async () => {
  const calls: string[] = [];
  const storage = new MemoryStorage();
  const result = await processLocalNotificationSnapshot(snapshot({ stale: true }), {
    locks: { request: async () => { calls.push("lock"); throw new Error("must not lock"); } },
    storage,
    hashAccountId: async () => { calls.push("hash"); throw new Error("must not hash"); },
    notificationTag: async () => { calls.push("tag"); throw new Error("must not tag"); },
    deliver: async () => { calls.push("deliver"); return { ok: true }; },
  });

  assert.deepEqual(result, { status: "idle", delivered: 0 });
  assert.deepEqual(calls, []);
  assert.deepEqual(storage.reads, []);
  assert.deepEqual(storage.writes, []);
});

test("the first fresh snapshot silently seeds all bars in one canonical write", async () => {
  const storage = new MemoryStorage();
  const deliveries: LocalWorkerNotification[] = [];
  const result = await processLocalNotificationSnapshot(
    snapshot({ bars: [bar("weekly_all", 9), bar("session", 51)] }),
    unlockedDependencies(storage, async (payload) => { deliveries.push(payload); return { ok: true }; }),
  );

  assert.deepEqual(result, { status: "idle", delivered: 0 });
  assert.deepEqual(deliveries, []);
  assert.equal(storage.reads.length, 1);
  assert.equal(storage.writes.length, 1);
  assert.deepEqual(stored(storage).records.map(({ limitKey, nextBoundaryIndex }) => [limitKey, nextBoundaryIndex]), [
    ["session", 0],
    ["weekly_all", 6],
  ]);
});

test("event state advances only after acknowledgement and denied retries the exact prior row", async () => {
  const storage = new MemoryStorage();
  const deliveries: LocalWorkerNotification[] = [];
  const results: LocalDeliveryResult[] = [
    { ok: false, reason: "denied", message: "private details must be ignored" },
    { ok: true },
  ];
  const dependencies = unlockedDependencies(storage, async (payload) => {
    deliveries.push(payload);
    return results.shift()!;
  });

  await processLocalNotificationSnapshot(snapshot(), dependencies);
  const before = structuredClone(stored(storage).records[0]);
  assert.deepEqual(
    await processLocalNotificationSnapshot(snapshot({ bars: [bar("session", 50)] }), dependencies),
    { status: "denied", delivered: 0 },
  );
  assert.deepEqual(stored(storage).records[0], before);
  assert.deepEqual(
    await processLocalNotificationSnapshot(snapshot({ bars: [bar("session", 50)] }), dependencies),
    { status: "delivered", delivered: 1 },
  );
  assert.equal(stored(storage).records[0]?.nextBoundaryIndex, 1);
  assert.deepEqual(deliveries.map(({ body }) => body), [
    "Claude 1 • session: %50 kaldı.",
    "Claude 1 • session: %50 kaldı.",
  ]);
});

test("a throwing delivery stays retryable while eventless rows advance and save", async () => {
  const storage = new MemoryStorage();
  let attempts = 0;
  const dependencies = unlockedDependencies(storage, async () => {
    attempts += 1;
    throw new Error("sensitive worker failure");
  });
  await processLocalNotificationSnapshot(
    snapshot({ bars: [bar("session", 51), bar("weekly_all", 51)] }),
    dependencies,
  );

  assert.deepEqual(
    await processLocalNotificationSnapshot(
      snapshot({ bars: [bar("session", 50), bar("weekly_all", 60)] }),
      dependencies,
    ),
    { status: "worker_error", delivered: 0 },
  );
  const records = stored(storage).records;
  assert.equal(records.find(({ limitKey }) => limitKey === "session")?.nextBoundaryIndex, 0);
  assert.equal(records.find(({ limitKey }) => limitKey === "weekly_all")?.lastObservedUtilization, 40);
  assert.equal(attempts, 1);
});

test("a failed multi-boundary jump retries only its tightest boundary", async () => {
  const storage = new MemoryStorage();
  const bodies: string[] = [];
  let succeed = false;
  const dependencies = unlockedDependencies(storage, async (payload) => {
    bodies.push(payload.body);
    return succeed ? { ok: true } : { ok: false, reason: "timeout", message: "ignored" };
  });
  await processLocalNotificationSnapshot(snapshot(), dependencies);

  assert.deepEqual(
    await processLocalNotificationSnapshot(snapshot({ bars: [bar("session", 9)] }), dependencies),
    { status: "worker_error", delivered: 0 },
  );
  succeed = true;
  assert.deepEqual(
    await processLocalNotificationSnapshot(snapshot({ bars: [bar("session", 9)] }), dependencies),
    { status: "delivered", delivered: 1 },
  );
  assert.deepEqual(bodies, ["Claude 1 • session: %10 kaldı.", "Claude 1 • session: %10 kaldı."]);
  assert.equal(stored(storage).records[0]?.nextBoundaryIndex, 6);
});

test("a failed reset retries the same reset copy until acknowledged", async () => {
  const storage = new MemoryStorage();
  const bodies: string[] = [];
  let attempt = 0;
  const dependencies = unlockedDependencies(storage, async (payload) => {
    bodies.push(payload.body);
    attempt += 1;
    return attempt === 1 ? { ok: false, reason: "unsupported", message: "ignored" } : { ok: true };
  });
  await processLocalNotificationSnapshot(snapshot({ bars: [bar("session", 20, T1)] }), dependencies);

  assert.deepEqual(
    await processLocalNotificationSnapshot(snapshot({ bars: [bar("session", 70, T2)] }), dependencies),
    { status: "unsupported", delivered: 0 },
  );
  assert.equal(stored(storage).records[0]?.lastResetAt, T1);
  assert.deepEqual(
    await processLocalNotificationSnapshot(snapshot({ bars: [bar("session", 70, T2)] }), dependencies),
    { status: "delivered", delivered: 1 },
  );
  assert.deepEqual(bodies, [
    "Claude 1 • session: limit sıfırlandı.",
    "Claude 1 • session: limit sıfırlandı.",
  ]);
  assert.equal(stored(storage).records[0]?.lastResetAt, T2);
});

test("the first failure in bar order governs status while later successes still count", async () => {
  const storage = new MemoryStorage();
  let results: LocalDeliveryResult[] = [];
  const dependencies = unlockedDependencies(storage, async () => results.shift()!);
  await processLocalNotificationSnapshot(
    snapshot({ bars: [bar("session", 51), bar("weekly_all", 51), bar("weekly_scoped:opus", 51)] }),
    dependencies,
  );
  results = [
    { ok: false, reason: "denied", message: "ignored" },
    { ok: false, reason: "unsupported", message: "ignored" },
    { ok: true },
  ];

  assert.deepEqual(
    await processLocalNotificationSnapshot(
      snapshot({ bars: [bar("session", 50), bar("weekly_all", 50), bar("weekly_scoped:opus", 50)] }),
      dependencies,
    ),
    { status: "denied", delivered: 1 },
  );
});

test("fresh snapshots prune vanished limits and active-account pruning retains other active account rows", async () => {
  const storage = new MemoryStorage();
  const dependencies = unlockedDependencies(storage);
  await processLocalNotificationSnapshot(
    snapshot({ bars: [bar("session", 51), bar("weekly_all", 51)], activeAccountIds: ["account-a", "account-b"] }),
    dependencies,
  );
  await processLocalNotificationSnapshot(
    snapshot({
      accountId: "account-b",
      accountLabel: "Claude 2",
      bars: [bar("session", 51)],
      activeAccountIds: ["account-a", "account-b"],
    }),
    dependencies,
  );
  await processLocalNotificationSnapshot(
    snapshot({ bars: [bar("session", 49)], activeAccountIds: ["account-a", "account-b"] }),
    dependencies,
  );
  assert.deepEqual(stored(storage).records.map(({ accountHash, limitKey }) => [accountHash, limitKey]), [
    [hashFor("account-a"), "session"],
    [hashFor("account-b"), "session"],
  ]);

  await processLocalNotificationSnapshot(
    snapshot({ bars: [bar("session", 49)], activeAccountIds: ["account-a"] }),
    dependencies,
  );
  assert.deepEqual(stored(storage).records.map(({ accountHash, limitKey }) => [accountHash, limitKey]), [
    [hashFor("account-a"), "session"],
  ]);
});

test("four accounts use independent hashed state without persisting labels or raw identifiers", async () => {
  const storage = new MemoryStorage();
  const deliveries: string[] = [];
  const dependencies = unlockedDependencies(storage, async (payload) => {
    deliveries.push(payload.body);
    return { ok: true };
  });
  const accountIds = ["account-a", "account-b", "account-c", "account-d"];
  for (let index = 0; index < accountIds.length; index += 1) {
    await processLocalNotificationSnapshot(snapshot({
      accountId: accountIds[index],
      accountLabel: `Private Claude ${index + 1}`,
      bars: [bar("session", 51)],
      activeAccountIds: accountIds,
    }), dependencies);
  }
  for (let index = 0; index < accountIds.length; index += 1) {
    await processLocalNotificationSnapshot(snapshot({
      accountId: accountIds[index],
      accountLabel: `Private Claude ${index + 1}`,
      bars: [bar("session", 50)],
      activeAccountIds: accountIds,
    }), dependencies);
  }

  assert.equal(deliveries.length, 4);
  assert.equal(stored(storage).records.length, 4);
  const serialized = storage.values.get(LOCAL_NOTIFY_STATE_STORAGE_KEY)!;
  for (const accountId of accountIds) assert.equal(serialized.includes(accountId), false);
  assert.equal(serialized.includes("Private Claude"), false);
});

test("parallel calls use the exact exclusive lock and never overlap transactions", async () => {
  const storage = new MemoryStorage();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const locks = {
    request: async <T>(
      name: string,
      options: { mode: "exclusive"; ifAvailable: true },
      callback: (lock: unknown | null) => Promise<T>,
    ): Promise<T | undefined> => {
      assert.equal(name, "hma-local-notifications-v1");
      assert.deepEqual(options, { mode: "exclusive", ifAvailable: true });
      calls += 1;
      if (calls === 2) return await callback(null);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      try { return await callback({ name }); }
      finally { active -= 1; }
    },
  };
  const dependencies = { ...unlockedDependencies(storage), locks };
  const first = processLocalNotificationSnapshot(snapshot(), dependencies);
  await Promise.resolve();
  const second = processLocalNotificationSnapshot(snapshot(), dependencies);
  release();

  assert.deepEqual(await Promise.all([first, second]), [
    { status: "idle", delivered: 0 },
    { status: "lock_unavailable", delivered: 0 },
  ]);
  assert.equal(maximumActive, 1);
  assert.equal(storage.reads.length, 1);
  assert.equal(storage.writes.length, 1);
});

test("missing, null, and throwing locks return lock_unavailable without any protected work", async () => {
  for (const locks of [
    null,
    { request: async () => undefined },
    { request: async () => { throw new Error("private lock error"); } },
  ]) {
    const storage = new MemoryStorage();
    let hashes = 0;
    let deliveries = 0;
    assert.deepEqual(await processLocalNotificationSnapshot(snapshot(), {
      locks,
      storage,
      hashAccountId: async () => { hashes += 1; return "a".repeat(64); },
      notificationTag: async () => "hma:" + "a".repeat(32),
      deliver: async () => { deliveries += 1; return { ok: true }; },
    }), { status: "lock_unavailable", delivered: 0 });
    assert.equal(hashes, 0);
    assert.equal(deliveries, 0);
    assert.deepEqual(storage.reads, []);
    assert.deepEqual(storage.writes, []);
  }
});

test("corrupt state is silently repaired, but true read and save failures return storage_error", async () => {
  const corrupt = new MemoryStorage();
  corrupt.values.set(LOCAL_NOTIFY_STATE_STORAGE_KEY, "private corrupt payload");
  assert.deepEqual(
    await processLocalNotificationSnapshot(snapshot(), unlockedDependencies(corrupt)),
    { status: "idle", delivered: 0 },
  );
  assert.equal(stored(corrupt).records.length, 1);

  const unreadable = {
    getItem(): string { throw new Error("private read error"); },
    setItem(): void { throw new Error("must not write"); },
  } as unknown as Storage;
  assert.deepEqual(
    await processLocalNotificationSnapshot(snapshot(), unlockedDependencies(unreadable)),
    { status: "storage_error", delivered: 0 },
  );

  const writeFailure = new MemoryStorage();
  const dependencies = unlockedDependencies(writeFailure);
  await processLocalNotificationSnapshot(snapshot(), dependencies);
  const failingStorage = {
    getItem: (key: string) => writeFailure.getItem(key),
    setItem(): void { throw new Error("private write error"); },
  } as unknown as Storage;
  assert.deepEqual(
    await processLocalNotificationSnapshot(
      snapshot({ bars: [bar("session", 50)] }),
      unlockedDependencies(failingStorage),
    ),
    { status: "storage_error", delivered: 1 },
  );
  assert.equal(stored(writeFailure).records[0]?.nextBoundaryIndex, 0);
});

test("oversized and future-version state are repaired with one fresh canonical seed", async () => {
  for (const raw of [
    "x".repeat(MAX_LOCAL_NOTIFY_STATE_BYTES + 1),
    JSON.stringify({ version: 2, records: [] }),
  ]) {
    const storage = new MemoryStorage();
    storage.values.set(LOCAL_NOTIFY_STATE_STORAGE_KEY, raw);

    assert.deepEqual(
      await processLocalNotificationSnapshot(snapshot(), unlockedDependencies(storage)),
      { status: "idle", delivered: 0 },
    );
    assert.equal(storage.writes.length, 1);
    assert.deepEqual(stored(storage).records.map(({ accountHash, limitKey }) => [accountHash, limitKey]), [
      [hashFor("account-a"), "session"],
    ]);
  }
});

test("failed and stale current-account cycles retain every other active account row", async () => {
  const storage = new MemoryStorage();
  const seedingDependencies = unlockedDependencies(storage);
  await processLocalNotificationSnapshot(
    snapshot({ activeAccountIds: ["account-a", "account-b"] }),
    seedingDependencies,
  );
  await processLocalNotificationSnapshot(
    snapshot({
      accountId: "account-b",
      accountLabel: "Claude 2",
      activeAccountIds: ["account-a", "account-b"],
    }),
    seedingDependencies,
  );

  const failed = await processLocalNotificationSnapshot(
    snapshot({
      bars: [bar("session", 50)],
      activeAccountIds: ["account-a", "account-b"],
    }),
    unlockedDependencies(storage, async () => ({
      ok: false,
      reason: "timeout",
      message: "ignored",
    })),
  );
  assert.deepEqual(failed, { status: "worker_error", delivered: 0 });
  const afterFailure = storage.values.get(LOCAL_NOTIFY_STATE_STORAGE_KEY);
  assert.deepEqual(stored(storage).records.map(({ accountHash }) => accountHash), [
    hashFor("account-a"),
    hashFor("account-b"),
  ]);

  assert.deepEqual(
    await processLocalNotificationSnapshot(
      snapshot({ stale: true, activeAccountIds: ["account-a"] }),
      unlockedDependencies(storage),
    ),
    { status: "idle", delivered: 0 },
  );
  assert.equal(storage.values.get(LOCAL_NOTIFY_STATE_STORAGE_KEY), afterFailure);
});

test("hash and codec exceptions fail generically without delivery", async () => {
  const storage = new MemoryStorage();
  let deliveries = 0;
  assert.deepEqual(await processLocalNotificationSnapshot(snapshot(), {
    ...unlockedDependencies(storage),
    hashAccountId: async () => { throw new Error("private account id"); },
    deliver: async () => { deliveries += 1; return { ok: true }; },
  }), { status: "storage_error", delivered: 0 });
  assert.equal(deliveries, 0);
  assert.deepEqual(storage.reads, []);
  assert.deepEqual(storage.writes, []);
});
