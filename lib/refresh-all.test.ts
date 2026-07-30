import assert from "node:assert/strict";
import test from "node:test";
import { refreshAllAccounts } from "./refresh-all.ts";

test("one failed account does not block four successful account refreshes", async () => {
  const ids = ["claude-1", "claude-2", "claude-3", "claude-4", "openai-1"];
  const called: string[] = [];
  const summary = await refreshAllAccounts(ids, async (id) => {
    called.push(id);
    if (id === "claude-3") throw new Error("simulated provider outage");
    return true;
  });

  assert.deepEqual(called, ids);
  assert.deepEqual(summary, { updated: 4, total: 5 });
});

test("synchronous throws and rejected promises are isolated per account", async () => {
  const ids = ["ready-1", "sync-failure", "ready-2", "async-failure", "ready-3"];
  const called: string[] = [];
  const summary = await refreshAllAccounts(ids, (id) => {
    called.push(id);
    if (id === "sync-failure") throw new Error("synchronous failure");
    if (id === "async-failure") return Promise.reject(new Error("asynchronous failure"));
    return Promise.resolve(true);
  });

  assert.deepEqual(called, ids);
  assert.deepEqual(summary, { updated: 3, total: 5 });
});

test("an empty account list performs no work", async () => {
  let calls = 0;
  const summary = await refreshAllAccounts([], async () => {
    calls += 1;
    return true;
  });

  assert.equal(calls, 0);
  assert.deepEqual(summary, { updated: 0, total: 0 });
});
