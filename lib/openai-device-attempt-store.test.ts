import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOpenAIDeviceAttemptStore,
  OpenAIDeviceAttemptCapacityError,
  type OpenAIDeviceAttemptRecord,
} from "./openai-device-attempt-store.ts";
import type { OpenAIDeviceAuthorization } from "./providers/openai-device-auth.ts";

const ATTEMPT_TTL_MS = 15 * 60_000;
const POLL_FENCE_MS = 30_000;
const COMPLETION_REPLAY_MS = 60_000;

function encoded(byte: number): string {
  return Buffer.alloc(32, byte).toString("base64url");
}

function authorization(now: number, intervalMs = 5_000): OpenAIDeviceAuthorization {
  return {
    deviceAuthId: "device-secret",
    userCode: "ABCD-EFGH",
    intervalMs,
    expiresAt: now + ATTEMPT_TTL_MS,
  };
}

function deterministicStore(nowRef: { value: number }) {
  let nextByte = 1;
  const requestedSizes: number[] = [];
  const records = new Map<string, OpenAIDeviceAttemptRecord>();
  const store = createOpenAIDeviceAttemptStore({
    now: () => nowRef.value,
    randomBytes: (size) => {
      requestedSizes.push(size);
      return new Uint8Array(size).fill(nextByte++);
    },
    records,
  });
  return { store, records, requestedSizes };
}

test("start creates a canonical user-bound capability and returns only browser-safe authorization fields", () => {
  const now = { value: 10_000 };
  const { store, records, requestedSizes } = deterministicStore(now);

  const started = store.start("user-a", authorization(now.value), "account-selected");

  assert.deepEqual(started, {
    attemptId: encoded(1),
    userCode: "ABCD-EFGH",
    pollAfterMs: 5_000,
    expiresAt: now.value + ATTEMPT_TTL_MS,
  });
  assert.match(started.attemptId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(started.attemptId, "base64url").length, 32);
  assert.deepEqual(requestedSizes, [32]);

  const retained = records.get(started.attemptId);
  assert.equal(retained?.status, "pending");
  assert.equal(retained?.userId, "user-a");
  assert.equal(retained?.deviceAuthId, "device-secret");
  assert.equal(retained?.userCode, "ABCD-EFGH");
  assert.equal(retained?.expectedAccountId, "account-selected");
});

test("status and poll claims reject noncanonical capabilities and a different authenticated user", () => {
  const now = { value: 20_000 };
  const { store } = deterministicStore(now);
  const started = store.start("user-a", authorization(now.value));
  now.value += 5_000;

  assert.equal(store.status(`${started.attemptId}=`, "user-a"), null);
  assert.equal(store.status(started.attemptId.slice(0, -1), "user-a"), null);
  assert.equal(store.status(started.attemptId, "user-b"), null);
  assert.equal(store.claimPoll(started.attemptId, "user-b"), null);
  assert.equal(store.claimPoll(`${started.attemptId}=`, "user-a"), null);
  assert.equal(store.claimPoll(started.attemptId, "user-a")?.kind, "poll");
});

test("polling respects the upstream interval and permits only one live owner", () => {
  const now = { value: 30_000 };
  const { store } = deterministicStore(now);
  const started = store.start("user-a", authorization(now.value));

  assert.deepEqual(store.claimPoll(started.attemptId, "user-a"), {
    kind: "pending",
    pollAfterMs: 5_000,
    expiresAt: now.value + ATTEMPT_TTL_MS,
  });
  now.value += 5_000;
  const claim = store.claimPoll(started.attemptId, "user-a");
  assert.equal(claim?.kind, "poll");
  if (!claim || claim.kind !== "poll") assert.fail("expected a poll owner");
  assert.equal(claim.owner, encoded(2));
  assert.deepEqual(claim.authorization, {
    deviceAuthId: "device-secret",
    userCode: "ABCD-EFGH",
    intervalMs: 5_000,
    expiresAt: 30_000 + ATTEMPT_TTL_MS,
  });
  assert.deepEqual(store.claimPoll(started.attemptId, "user-a"), {
    kind: "processing",
    pollAfterMs: POLL_FENCE_MS,
    expiresAt: 30_000 + ATTEMPT_TTL_MS,
  });
});

test("a crashed poll owner is fenced out when a new owner reclaims after thirty seconds", () => {
  const now = { value: 40_000 };
  const { store } = deterministicStore(now);
  const started = store.start("user-a", authorization(now.value));
  now.value += 5_000;
  const abandoned = store.claimPoll(started.attemptId, "user-a");
  assert.ok(abandoned && abandoned.kind === "poll");

  now.value += POLL_FENCE_MS;
  const reclaimed = store.claimPoll(started.attemptId, "user-a");
  assert.ok(reclaimed && reclaimed.kind === "poll");
  assert.equal(reclaimed.owner, encoded(3));
  assert.equal(store.releasePending(started.attemptId, abandoned.owner), false);
  assert.equal(store.fail(started.attemptId, abandoned.owner), false);
  assert.equal(store.releasePending(started.attemptId, reclaimed.owner), true);
  assert.equal(store.claimPoll(started.attemptId, "user-a")?.kind, "pending");

  now.value += 5_000;
  assert.equal(store.claimPoll(started.attemptId, "user-a")?.kind, "poll");
});

test("a live poll owner renews its fence while stale owners still expire exactly thirty seconds later", () => {
  const now = { value: 45_000 };
  const { store } = deterministicStore(now);
  const started = store.start("user-a", authorization(now.value));
  now.value += 5_000;
  const claim = store.claimPoll(started.attemptId, "user-a");
  assert.ok(claim && claim.kind === "poll");

  now.value += POLL_FENCE_MS - 1;
  assert.equal(store.renewPoll(started.attemptId, claim.owner), true);
  assert.equal(store.renewPoll(started.attemptId, encoded(99)), false);

  now.value += POLL_FENCE_MS - 1;
  assert.equal(store.claimPoll(started.attemptId, "user-a")?.kind, "processing");
  now.value += 1;
  const reclaimed = store.claimPoll(started.attemptId, "user-a");
  assert.ok(reclaimed && reclaimed.kind === "poll");
  assert.notEqual(reclaimed.owner, claim.owner);
  assert.equal(store.renewPoll(started.attemptId, claim.owner), false);
});

test("completion rejects the wrong owner, deletes secrets, and replays only copied account metadata for sixty seconds", () => {
  const now = { value: 50_000 };
  const { store, records } = deterministicStore(now);
  const started = store.start("user-a", authorization(now.value), "account-selected");
  now.value += 5_000;
  const claim = store.claimPoll(started.attemptId, "user-a");
  assert.ok(claim && claim.kind === "poll");
  const account = {
    id: "account-id",
    email: "account@example.com",
    plan: "ChatGPT Plus",
    label: "account@example.com",
    alreadyConnected: false,
  };

  assert.equal(store.complete(started.attemptId, encoded(99), account), false);
  assert.equal(store.complete(started.attemptId, claim.owner, account), true);
  account.label = "mutated after completion";

  assert.deepEqual(store.status(started.attemptId, "user-a"), {
    status: "done",
    account: {
      id: "account-id",
      email: "account@example.com",
      plan: "ChatGPT Plus",
      label: "account@example.com",
      alreadyConnected: false,
    },
  });
  assert.equal(store.status(started.attemptId, "user-b"), null);
  const retained = records.get(started.attemptId);
  assert.equal(retained?.status, "done");
  assert.equal(retained?.deviceAuthId, undefined);
  assert.equal(retained?.userCode, undefined);
  assert.equal(retained?.expectedAccountId, undefined);
  assert.equal(retained?.owner, undefined);
  assert.equal(JSON.stringify(retained).includes("device-secret"), false);

  now.value += COMPLETION_REPLAY_MS;
  assert.equal(store.status(started.attemptId, "user-a"), null);
  assert.equal(records.has(started.attemptId), false);
});

test("failure is owner-fenced, deletes every secret, and exposes only a generic error", () => {
  const now = { value: 60_000 };
  const { store, records } = deterministicStore(now);
  const started = store.start("user-a", authorization(now.value), "account-selected");
  now.value += 5_000;
  const claim = store.claimPoll(started.attemptId, "user-a");
  assert.ok(claim && claim.kind === "poll");

  assert.equal(store.fail(started.attemptId, encoded(99)), false);
  assert.equal(store.fail(started.attemptId, claim.owner), true);
  assert.deepEqual(store.status(started.attemptId, "user-a"), {
    status: "failed",
    error: "OpenAI device login failed. Start a new login and try again.",
  });
  const retained = records.get(started.attemptId);
  assert.deepEqual(
    Object.keys(retained ?? {}).sort(),
    ["attemptId", "createdAt", "retainUntil", "status", "userId"].sort(),
  );
});

test("fifteen-minute expiry is exact and replaces live state with a generic secret-free result", () => {
  const now = { value: 70_000 };
  const { store, records } = deterministicStore(now);
  const started = store.start("user-a", authorization(now.value), "account-selected");

  now.value += ATTEMPT_TTL_MS - 1;
  assert.equal(store.status(started.attemptId, "user-a")?.status, "pending");
  now.value += 1;
  assert.deepEqual(store.status(started.attemptId, "user-a"), {
    status: "expired",
    error: "OpenAI device login expired. Start a new login and try again.",
  });
  const retained = records.get(started.attemptId);
  assert.deepEqual(
    Object.keys(retained ?? {}).sort(),
    ["attemptId", "createdAt", "retainUntil", "status", "userId"].sort(),
  );
});

test("capacity rejects a ninth live attempt without evicting pending or polling records", () => {
  const now = { value: 80_000 };
  const { store, records } = deterministicStore(now);
  const attempts = Array.from(
    { length: 8 },
    () => store.start("user-a", authorization(now.value)).attemptId,
  );
  now.value += 5_000;
  assert.equal(store.claimPoll(attempts[0], "user-a")?.kind, "poll");

  assert.throws(
    () => store.start("user-a", authorization(now.value)),
    OpenAIDeviceAttemptCapacityError,
  );
  assert.equal(records.size, 8);
  assert.equal(records.get(attempts[0])?.status, "polling");
  assert.equal(records.get(attempts[1])?.status, "pending");
});

test("capacity reclaims terminal and expired records before admitting another attempt", () => {
  const now = { value: 90_000 };
  const { store, records } = deterministicStore(now);
  const attempts = Array.from(
    { length: 8 },
    () => store.start("user-a", authorization(now.value)).attemptId,
  );
  now.value += 5_000;
  const claim = store.claimPoll(attempts[0], "user-a");
  assert.ok(claim && claim.kind === "poll");
  assert.equal(store.fail(attempts[0], claim.owner), true);

  const ninth = store.start("user-a", authorization(now.value));
  assert.equal(records.has(attempts[0]), false);
  assert.equal(records.has(ninth.attemptId), true);
  assert.equal(records.size, 8);

  now.value = 90_000 + ATTEMPT_TTL_MS;
  const tenth = store.start("user-a", authorization(now.value));
  assert.equal(records.has(attempts[1]), false);
  assert.equal(records.has(tenth.attemptId), true);
  assert.equal(records.size, 8);
});
