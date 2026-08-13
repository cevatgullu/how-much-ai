import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  createOAuthAttemptStore,
  OAuthAttemptCapacityError,
  OAUTH_ATTEMPT_TTL_MS,
  type OAuthAttemptRecord,
} from "./oauth-attempt-store.ts";

function encoded(byte: number): string {
  return Buffer.alloc(32, byte).toString("base64url");
}

function deterministicStore(nowRef: { value: number }) {
  let nextByte = 1;
  const records = new Map<string, OAuthAttemptRecord>();
  const stateIndex = new Map<string, string>();
  const store = createOAuthAttemptStore({
    now: () => nowRef.value,
    randomBytes: (size) => new Uint8Array(size).fill(nextByte++),
    records,
    stateIndex,
  });
  return { store, records, stateIndex };
}

test("start returns only a fresh opaque id while verifier and challenge remain server-side", () => {
  const now = { value: 10_000 };
  const { store, records } = deterministicStore(now);

  const first = store.start({ expectedAccountId: "acct-selected" });
  const second = store.start();

  assert.deepEqual(first, { attemptId: encoded(1) });
  assert.deepEqual(second, { attemptId: encoded(3) });
  assert.match(first.attemptId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(first.attemptId, "base64url").length, 32);

  const retained = records.get(first.attemptId);
  assert.equal(retained?.status, "created");
  assert.equal(retained?.verifier, encoded(2));
  assert.equal(
    retained?.challenge,
    createHash("sha256").update(encoded(2), "utf8").digest("base64url"),
  );
  assert.equal(retained?.stateHash, undefined);
  assert.equal(retained?.expectedAccountId, "acct-selected");
  assert.equal(retained?.expiresAt, now.value + OAUTH_ATTEMPT_TTL_MS);
});

test("one-use launch creates state atomically and retains only its hash", () => {
  const now = { value: 20_000 };
  const { store, records, stateIndex } = deterministicStore(now);
  const { attemptId } = store.start();

  const launch = store.launch(attemptId);

  assert.deepEqual(launch, {
    challenge: createHash("sha256").update(encoded(2), "utf8").digest("base64url"),
    state: encoded(3),
  });
  assert.equal(records.get(attemptId)?.status, "pending");
  assert.equal(records.get(attemptId)?.stateHash, createHash("sha256").update(encoded(3)).digest("hex"));
  assert.equal(records.get(attemptId)?.challenge, undefined);
  assert.equal(records.get(attemptId)?.verifier, encoded(2));
  assert.equal(JSON.stringify(records.get(attemptId)).includes(encoded(3)), false);
  assert.equal(stateIndex.size, 1);
  assert.equal(store.launch(attemptId), null);
});

test("callback claim changes pending to processing synchronously and permits one exchange", () => {
  const now = { value: 30_000 };
  const { store, records, stateIndex } = deterministicStore(now);
  const { attemptId } = store.start({ expectedAccountId: "acct-selected" });
  const launch = store.launch(attemptId);
  assert.ok(launch);

  const first = store.claim(launch.state);
  const replay = store.claim(launch.state);

  assert.deepEqual(first, {
    attemptId,
    verifier: encoded(2),
    expectedAccountId: "acct-selected",
  });
  assert.equal(replay, null);
  assert.equal(records.get(attemptId)?.status, "processing");
  assert.equal(records.get(attemptId)?.verifier, undefined);
  assert.equal(records.get(attemptId)?.challenge, undefined);
  assert.equal(records.get(attemptId)?.stateHash, undefined);
  assert.equal(stateIndex.size, 0);
});

test("five-minute expiry is exact and clears every pre-exchange secret", () => {
  const now = { value: 40_000 };
  const { store, records } = deterministicStore(now);
  const { attemptId } = store.start();
  const launch = store.launch(attemptId);
  assert.ok(launch);

  now.value += OAUTH_ATTEMPT_TTL_MS;

  assert.equal(store.claim(launch.state), null);
  assert.deepEqual(store.status(attemptId), {
    status: "expired",
    provider: "anthropic",
    displayLabel: "Claude account",
  });
  const retained = records.get(attemptId);
  assert.equal(retained?.verifier, undefined);
  assert.equal(retained?.challenge, undefined);
  assert.equal(retained?.stateHash, undefined);
});

test("wrong state, terminal failure, and replay never become reusable", () => {
  const now = { value: 50_000 };
  const { store } = deterministicStore(now);
  const { attemptId } = store.start();
  const launch = store.launch(attemptId);
  assert.ok(launch);
  assert.equal(store.claim(encoded(99)), null);

  const claim = store.claim(launch.state);
  assert.ok(claim);
  assert.equal(store.finish(attemptId, { status: "failed" }), true);
  assert.deepEqual(store.status(attemptId), {
    status: "failed",
    provider: "anthropic",
    displayLabel: "Claude account",
  });
  assert.equal(store.claim(launch.state), null);
  assert.equal(store.finish(attemptId, { status: "done", displayLabel: "Claude 1" }), false);
});

test("capacity never evicts live or processing attempts to admit a ninth", () => {
  const now = { value: 60_000 };
  const { store, records } = deterministicStore(now);
  const ids = Array.from({ length: 8 }, () => store.start().attemptId);
  const launch = store.launch(ids[0]);
  assert.ok(launch);
  assert.ok(store.claim(launch.state));

  assert.throws(() => store.start(), OAuthAttemptCapacityError);
  assert.equal(records.size, 8);
  assert.equal(records.get(ids[0])?.status, "processing");
});

test("a terminal record may be reclaimed without disturbing a processing sibling", () => {
  const now = { value: 70_000 };
  const { store, records } = deterministicStore(now);
  const ids = Array.from({ length: 8 }, () => store.start().attemptId);
  for (const id of ids.slice(0, 2)) {
    const launch = store.launch(id);
    assert.ok(launch);
    assert.ok(store.claim(launch.state));
  }
  assert.equal(store.finish(ids[0], { status: "done", displayLabel: "Claude 1" }), true);

  const ninth = store.start();

  assert.equal(records.has(ids[0]), false);
  assert.equal(records.get(ids[1])?.status, "processing");
  assert.equal(records.has(ninth.attemptId), true);
  assert.equal(records.size, 8);
});
