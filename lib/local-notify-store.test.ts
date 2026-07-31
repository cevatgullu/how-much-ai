import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOCAL_NOTIFY_STATE_STORAGE_KEY,
  MAX_LOCAL_NOTIFY_RECORDS,
  MAX_LOCAL_NOTIFY_STATE_BYTES,
  hashLocalAccountId,
  loadLocalNotifyDocument,
  localNotificationTag,
  parseLocalNotifyDocument,
  saveLocalNotifyDocument,
  type LocalNotifyDocument,
  type LocalNotifyRecord,
} from "./local-notify-store.ts";

const ACCOUNT_HASH = "a".repeat(64);
const RESET_AT = "2026-08-01T00:00:00.000Z";
const EMPTY_DOCUMENT = { version: 1, records: [] };

function record(overrides: Partial<LocalNotifyRecord> = {}): LocalNotifyRecord {
  return {
    accountHash: ACCOUNT_HASH,
    limitKey: "session",
    lastResetAt: RESET_AT,
    nextBoundaryIndex: 2,
    lastObservedUtilization: 40,
    ...overrides,
  };
}

function rawDocument(records: unknown[], version: unknown = 1): string {
  return JSON.stringify({ version, records });
}

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  readonly reads: string[] = [];
  readonly writes: Array<[string, string]> = [];

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.writes.push([key, value]);
    this.values.set(key, value);
  }
}

function assertCorrupt(raw: string): void {
  assert.deepEqual(parseLocalNotifyDocument(raw), {
    ok: false,
    document: EMPTY_DOCUMENT,
    error: "corrupt",
  });
}

test("missing local state is a valid empty V1 document", () => {
  assert.deepEqual(parseLocalNotifyDocument(null), { ok: true, document: EMPTY_DOCUMENT });
  assertCorrupt("");
  assertCorrupt("null");
  assertCorrupt("[]");
});

test("accepts only the exact own-property document and record schemas", () => {
  assert.deepEqual(parseLocalNotifyDocument(rawDocument([record()])), {
    ok: true,
    document: { version: 1, records: [record()] },
  });

  for (const candidate of [
    { version: 1, records: [], extra: true },
    { records: [] },
    { version: 1 },
    { version: 1, records: {} },
    { version: 1, records: [[ACCOUNT_HASH, "session"]] },
    { version: 1, records: [{ ...record(), extra: "private" }] },
    { version: 1, records: [{ ...record(), ["__proto__"]: "private" }] },
    { version: 1, records: [{ accountHash: ACCOUNT_HASH, limitKey: "session" }] },
  ]) {
    assertCorrupt(JSON.stringify(candidate));
  }

  assertCorrupt(
    `{"version":1,"records":[{"accountHash":"${ACCOUNT_HASH}","limitKey":"session",` +
      `"lastResetAt":null,"nextBoundaryIndex":0,"lastObservedUtilization":0,"__proto__":{}}]}`,
  );
});

test("rejects unsupported and malformed versions without retaining records", () => {
  assert.deepEqual(parseLocalNotifyDocument(rawDocument([record()], 2)), {
    ok: false,
    document: EMPTY_DOCUMENT,
    error: "future_version",
  });
  for (const version of [0, -1, 1.1, "1", null]) assertCorrupt(rawDocument([record()], version));
});

test("enforces the UTF-8 byte bound before parsing", () => {
  const exact = rawDocument([]).padEnd(MAX_LOCAL_NOTIFY_STATE_BYTES, " ");
  assert.equal(new TextEncoder().encode(exact).byteLength, MAX_LOCAL_NOTIFY_STATE_BYTES);
  assert.deepEqual(parseLocalNotifyDocument(exact), { ok: true, document: EMPTY_DOCUMENT });

  const oversizedAscii = exact + " ";
  assert.deepEqual(parseLocalNotifyDocument(oversizedAscii), {
    ok: false,
    document: EMPTY_DOCUMENT,
    error: "oversized",
  });

  const oversizedUtf8 = "é".repeat(MAX_LOCAL_NOTIFY_STATE_BYTES / 2 + 1);
  assert.ok(oversizedUtf8.length < MAX_LOCAL_NOTIFY_STATE_BYTES);
  assert.deepEqual(parseLocalNotifyDocument(oversizedUtf8), {
    ok: false,
    document: EMPTY_DOCUMENT,
    error: "oversized",
  });
});

test("applies the exact 512-record bound before validating individual records", () => {
  const atLimit = Array.from({ length: MAX_LOCAL_NOTIFY_RECORDS }, () => null);
  assert.deepEqual(parseLocalNotifyDocument(rawDocument(atLimit)), {
    ok: false,
    document: EMPTY_DOCUMENT,
    error: "corrupt",
  });
  assert.deepEqual(parseLocalNotifyDocument(rawDocument([...atLimit, null])), {
    ok: false,
    document: EMPTY_DOCUMENT,
    error: "oversized",
  });
});

test("requires lowercase 64-hex account hashes", () => {
  assert.equal(parseLocalNotifyDocument(rawDocument([record({ accountHash: "0123456789abcdef".repeat(4) })])).ok, true);
  for (const accountHash of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "", 7]) {
    assertCorrupt(rawDocument([record({ accountHash: accountHash as string })]));
  }
});

test("accepts only bounded stable ASCII limit keys", () => {
  const accepted = [
    "session",
    "weekly_all",
    "weekly_oauth_apps",
    "weekly_scoped:Claude%203.7%25",
    "a".repeat(160),
    "A0._:%!~*'()-",
  ];
  for (const limitKey of accepted) {
    assert.equal(parseLocalNotifyDocument(rawDocument([record({ limitKey })])).ok, true, limitKey);
  }

  const rejected = [
    "",
    "a".repeat(161),
    " session",
    "weekly scoped",
    "user@example.com",
    "slash/value",
    "line\nbreak",
    "oturüm",
    "__proto__",
    "prototype",
    "constructor",
    4,
  ];
  for (const limitKey of rejected) assertCorrupt(rawDocument([record({ limitKey: limitKey as string })]));
});

test("reuses strict reset timestamp validation with a 40-character cap", () => {
  const accepted = [
    null,
    "2024-02-29T23:59:59Z",
    "2026-08-01T02:30:00+02:30",
    "2026-08-01T00:00:00.1234567890123456789Z",
  ];
  for (const lastResetAt of accepted) {
    assert.ok(lastResetAt === null || lastResetAt.length <= 40);
    assert.equal(parseLocalNotifyDocument(rawDocument([record({ lastResetAt })])).ok, true, String(lastResetAt));
  }

  const rejected = [
    "2023-02-29T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-08-01 00:00:00Z",
    "2026-08-01T00:00:00",
    "2026-08-01T00:00:00.12345678901234567890Z",
    1,
  ];
  for (const lastResetAt of rejected) {
    assertCorrupt(rawDocument([record({ lastResetAt: lastResetAt as string })]));
  }
});

test("requires integer cursor and utilization values within their closed ranges", () => {
  for (const nextBoundaryIndex of [0, 8]) {
    for (const lastObservedUtilization of [0, 100]) {
      assert.equal(
        parseLocalNotifyDocument(rawDocument([record({ nextBoundaryIndex, lastObservedUtilization })])).ok,
        true,
      );
    }
  }

  for (const nextBoundaryIndex of [-1, 9, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
    assertCorrupt(rawDocument([record({ nextBoundaryIndex: nextBoundaryIndex as number })]));
  }
  for (const lastObservedUtilization of [-1, 101, 0.5, Number.NaN, Number.NEGATIVE_INFINITY, "40"]) {
    assertCorrupt(rawDocument([record({ lastObservedUtilization: lastObservedUtilization as number })]));
  }
});

test("rejects duplicate account and limit identities without returning partial state", () => {
  const first = record();
  const duplicate = record({ lastObservedUtilization: 80 });
  assert.deepEqual(parseLocalNotifyDocument(rawDocument([first, duplicate])), {
    ok: false,
    document: EMPTY_DOCUMENT,
    error: "corrupt",
  });
});

test("saves one canonical field order and deterministic account/key sort", () => {
  const storage = new MemoryStorage();
  const document: LocalNotifyDocument = {
    version: 1,
    records: [
      record({ accountHash: "b".repeat(64), limitKey: "weekly_all", lastResetAt: null }),
      record({ accountHash: "a".repeat(64), limitKey: "weekly_all", nextBoundaryIndex: 8 }),
      record({ accountHash: "a".repeat(64), limitKey: "session", lastObservedUtilization: 0 }),
    ],
  };

  assert.deepEqual(saveLocalNotifyDocument(storage, document), { ok: true });
  assert.deepEqual(storage.writes, [[LOCAL_NOTIFY_STATE_STORAGE_KEY, storage.values.get(LOCAL_NOTIFY_STATE_STORAGE_KEY)!]]);
  assert.equal(
    storage.values.get(LOCAL_NOTIFY_STATE_STORAGE_KEY),
    `{"version":1,"records":[` +
      `{"accountHash":"${"a".repeat(64)}","limitKey":"session","lastResetAt":"${RESET_AT}","nextBoundaryIndex":2,"lastObservedUtilization":0},` +
      `{"accountHash":"${"a".repeat(64)}","limitKey":"weekly_all","lastResetAt":"${RESET_AT}","nextBoundaryIndex":8,"lastObservedUtilization":40},` +
      `{"accountHash":"${"b".repeat(64)}","limitKey":"weekly_all","lastResetAt":null,"nextBoundaryIndex":2,"lastObservedUtilization":40}]}`,
  );
  assert.deepEqual(document.records.map(({ accountHash, limitKey }) => [accountHash, limitKey]), [
    ["b".repeat(64), "weekly_all"],
    ["a".repeat(64), "weekly_all"],
    ["a".repeat(64), "session"],
  ]);

  assert.deepEqual(loadLocalNotifyDocument(storage), {
    ok: true,
    document: {
      version: 1,
      records: [
        record({ accountHash: "a".repeat(64), limitKey: "session", lastObservedUtilization: 0 }),
        record({ accountHash: "a".repeat(64), limitKey: "weekly_all", nextBoundaryIndex: 8 }),
        record({ accountHash: "b".repeat(64), limitKey: "weekly_all", lastResetAt: null }),
      ],
    },
  });
  assert.deepEqual(storage.reads, [LOCAL_NOTIFY_STATE_STORAGE_KEY]);
});

test("load and save use only the fixed non-identifying storage key", () => {
  const storage = new MemoryStorage();
  const accountId = "acct-live-sensitive-123";
  const limitKey = "weekly_scoped:opus";
  const document = { version: 1, records: [record({ accountHash: ACCOUNT_HASH, limitKey })] } as const;

  assert.deepEqual(saveLocalNotifyDocument(storage, document), { ok: true });
  assert.deepEqual(loadLocalNotifyDocument(storage), { ok: true, document });
  assert.deepEqual(storage.writes.map(([key]) => key), ["hma:local-notify-state:v1"]);
  assert.deepEqual(storage.reads, ["hma:local-notify-state:v1"]);
  assert.equal(LOCAL_NOTIFY_STATE_STORAGE_KEY.includes(accountId), false);
  assert.equal(LOCAL_NOTIFY_STATE_STORAGE_KEY.includes(limitKey), false);
});

test("storage exceptions fail closed without throwing or exposing stored content", () => {
  const secret = "sk-ant-api03-storage-secret";
  const unavailableRead = {
    getItem(): string {
      throw new Error(secret);
    },
  } as Storage;
  assert.deepEqual(loadLocalNotifyDocument(unavailableRead), {
    ok: false,
    document: EMPTY_DOCUMENT,
    error: "unavailable",
  });

  const unavailableWrite = {
    setItem(): void {
      throw new Error(secret);
    },
  } as Storage;
  assert.deepEqual(saveLocalNotifyDocument(unavailableWrite, { version: 1, records: [] }), {
    ok: false,
    error: "unavailable",
  });
});

test("save rejects malformed runtime objects and oversized output before storage", () => {
  const storage = new MemoryStorage();
  const inheritedRecord = Object.create({ accountHash: ACCOUNT_HASH }) as LocalNotifyRecord;
  Object.assign(inheritedRecord, {
    limitKey: "session",
    lastResetAt: RESET_AT,
    nextBoundaryIndex: 0,
    lastObservedUtilization: 0,
  });
  assert.deepEqual(
    saveLocalNotifyDocument(storage, { version: 1, records: [inheritedRecord] }),
    { ok: false, error: "unavailable" },
  );

  class RecordWithPrototype {
    accountHash = ACCOUNT_HASH;
    limitKey = "session";
    lastResetAt = RESET_AT;
    nextBoundaryIndex = 0;
    lastObservedUtilization = 0;
  }
  assert.deepEqual(
    saveLocalNotifyDocument(storage, { version: 1, records: [new RecordWithPrototype() as LocalNotifyRecord] }),
    { ok: false, error: "unavailable" },
  );
  assert.deepEqual(
    saveLocalNotifyDocument(storage, {
      version: 1,
      records: [{ ...record(), privateLabel: "Alice Private" } as LocalNotifyRecord],
    }),
    { ok: false, error: "unavailable" },
  );
  assert.deepEqual(
    saveLocalNotifyDocument(storage, {
      version: 1,
      records: [record({ lastObservedUtilization: Number.POSITIVE_INFINITY })],
    }),
    { ok: false, error: "unavailable" },
  );
  assert.deepEqual(storage.writes, []);

  const tooMany = Array.from({ length: MAX_LOCAL_NOTIFY_RECORDS + 1 }, (_, index) =>
    record({ accountHash: index.toString(16).padStart(64, "0") }),
  );
  assert.deepEqual(saveLocalNotifyDocument(storage, { version: 1, records: tooMany }), {
    ok: false,
    error: "oversized",
  });
  const tooManyBytes = Array.from({ length: 300 }, (_, index) =>
    record({
      accountHash: index.toString(16).padStart(64, "0"),
      limitKey: "k" + index.toString().padStart(159, "x"),
      lastResetAt: "2026-08-01T00:00:00.1234567890123456789Z",
    }),
  );
  assert.ok(new Set(tooManyBytes.map(({ accountHash, limitKey }) => accountHash + "\0" + limitKey)).size === 300);
  assert.deepEqual(saveLocalNotifyDocument(storage, { version: 1, records: tooManyBytes }), {
    ok: false,
    error: "oversized",
  });
  assert.deepEqual(storage.writes, []);
});

test("hashes account IDs with browser SHA-256 and emits only lowercase hex", async () => {
  assert.equal(
    await hashLocalAccountId("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.match(await hashLocalAccountId("acct-sensitive"), /^[0-9a-f]{64}$/);
});

test("notification tags hash the account hash and limit key behind an opaque prefix", async () => {
  assert.equal(await localNotificationTag(ACCOUNT_HASH, "session"), "hma:dc70fd60ff14aab6ee36eba05efb39d0");
  const tag = await localNotificationTag(ACCOUNT_HASH, "weekly_scoped:opus");
  assert.match(tag, /^hma:[0-9a-f]{32}$/);
  assert.equal(tag.includes(ACCOUNT_HASH), false);
  assert.equal(tag.includes("weekly_scoped"), false);
  assert.equal(tag.includes("opus"), false);
});

test("serialized state and tags never retain account metadata or credentials", async () => {
  const privateFixture = {
    email: "alice.private@example.com",
    accountId: "acct-private-0123456789",
    accessToken: "sk-ant-api03-access-private",
    refreshToken: "sk-ant-ort01-refresh-private",
    label: "Personal Claude account",
    fullName: "Alice Private Person",
  };
  const accountHash = await hashLocalAccountId(privateFixture.accountId);
  const storage = new MemoryStorage();
  assert.deepEqual(
    saveLocalNotifyDocument(storage, { version: 1, records: [record({ accountHash, limitKey: "session" })] }),
    { ok: true },
  );
  const serialized = storage.values.get(LOCAL_NOTIFY_STATE_STORAGE_KEY)!;
  const tag = await localNotificationTag(accountHash, "session");

  for (const secret of Object.values(privateFixture)) {
    assert.equal(serialized.includes(secret), false, secret);
    assert.equal(tag.includes(secret), false, secret);
  }
  assert.equal(tag.includes(accountHash), false);
  assert.equal(tag.includes("session"), false);
});
