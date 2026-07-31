import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_BOOTSTRAP_TTL_MS,
  createLocalBootstrapStore,
  localBootstrapStore,
} from "./local-bootstrap.ts";

test("tickets are random 32-byte base64url capabilities and a newer ticket invalidates the old one", () => {
  const store = createLocalBootstrapStore();
  const first = store.issue(1_000);
  const second = store.issue(1_001);

  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.match(second, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(store.consume(second, 1_002), true);

  const invalidationStore = createLocalBootstrapStore();
  const invalidated = invalidationStore.issue(2_000);
  const live = invalidationStore.issue(2_001);
  assert.equal(invalidationStore.consume(invalidated, 2_002), false);
  assert.equal(invalidationStore.consume(live, 2_002), false);
});

test("a ticket expires at 20 seconds and is deleted before one-use success", () => {
  const store = createLocalBootstrapStore();
  const expired = store.issue(5_000);
  assert.equal(store.consume(expired, 5_000 + LOCAL_BOOTSTRAP_TTL_MS), false);

  const live = store.issue(10_000);
  assert.equal(store.consume(live, 10_000 + LOCAL_BOOTSTRAP_TTL_MS - 1), true);
  assert.equal(store.consume(live, 10_000 + LOCAL_BOOTSTRAP_TTL_MS - 1), false);
});

test("every failed consume attempt atomically invalidates the live ticket", () => {
  for (const attemptedTicket of [
    "",
    "a".repeat(42),
    "a".repeat(44),
    "a".repeat(42) + "=",
    "a".repeat(42) + "!",
    "b".repeat(43),
    undefined,
    null,
    {},
  ]) {
    const store = createLocalBootstrapStore();
    const liveTicket = store.issue(20_000);
    assert.equal(store.consume(attemptedTicket, 20_001), false);
    assert.equal(store.consume(liveTicket, 20_001), false);
  }
});

test("the bounded store retains only ticket hashes and at most eight entries", () => {
  const retained = new Map<string, number>();
  const store = createLocalBootstrapStore({ retained });
  let newest = "";

  for (let index = 0; index < 12; index++) {
    newest = store.issue(30_000 + index);
    assert.equal([...retained.keys()].includes(newest), false);
    assert.equal(JSON.stringify([...retained]), JSON.stringify([...retained]).replaceAll(newest, ""));
    assert.ok(retained.size <= 8);
  }

  assert.equal(retained.size, 1);
  const [digest] = retained.keys();
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(store.consume(newest, 30_020), true);
});

test("a fresh store models restart loss and the production store is globalThis-backed", () => {
  const beforeRestart = createLocalBootstrapStore();
  const ticket = beforeRestart.issue(40_000);
  const afterRestart = createLocalBootstrapStore();

  assert.equal(afterRestart.consume(ticket, 40_001), false);
  assert.equal(globalThis.__hmcLocalBootstrapStore, localBootstrapStore);
});
