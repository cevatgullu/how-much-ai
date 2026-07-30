import assert from "node:assert/strict";
import path from "node:path";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { refreshAllAccounts } from "./refresh-all.ts";
import type {
  AccountUsageResult,
  LocalUsageRefreshRequest,
} from "./local-usage-coordinator.ts";
import { CACHE_TTL_MS, COOLDOWN_MS } from "./usage-cache-core.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith(pathToFileURL(projectRoot).href) &&
      !context.parentURL.includes("/node_modules/") &&
      path.extname(new URL(specifier, context.parentURL).pathname) === ""
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
const { LocalUsageCoordinator } = await import("./local-usage-coordinator.ts");
after(() => moduleHooks.deregister());

interface TestAccount {
  id: string;
}

function readyResult(accountId: string, fetchedAt: number): AccountUsageResult {
  return {
    usage: { sample: `${accountId}@${fetchedAt}` },
    profile: null,
    status: "ready",
    fetchedAt,
    cooldownUntil: 0,
    stale: false,
  };
}

async function commitReady(
  request: LocalUsageRefreshRequest<TestAccount>,
): Promise<AccountUsageResult> {
  const result = readyResult(request.account.id, request.now);
  await request.store.commit({
    usage: result.usage ?? undefined,
    profile: null,
    fetchedAt: request.now,
    status: "ready",
    cooldownUntil: 0,
  });
  return result;
}

function attemptsObject(attempts: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries(attempts);
}

test("one-minute polls of five accounts use one upstream attempt each before the exact TTL boundary", async () => {
  const ids = ["claude-1", "claude-2", "claude-3", "claude-4", "openai-1"];
  const attempts = new Map<string, number>();
  let now = 0;
  const coordinator = new LocalUsageCoordinator<TestAccount>(
    () => now,
    async (request) => {
      attempts.set(request.account.id, (attempts.get(request.account.id) ?? 0) + 1);
      return commitReady(request);
    },
  );

  for (const pollAt of [0, 60_000, 120_000, 180_000, 240_000]) {
    now = pollAt;
    const results = new Map<string, AccountUsageResult>();
    const summary = await refreshAllAccounts(ids, async (id) => {
      const result = await coordinator.getAccountUsage(`usage:${id}`, "default", { id });
      results.set(id, result);
      return result.status === "ready" && !result.stale;
    });

    assert.deepEqual(summary, { updated: 5, total: 5 });
    for (const id of ids) {
      assert.equal(results.get(id)?.fetchedAt, 0);
      assert.deepEqual(results.get(id)?.usage, { sample: `${id}@0` });
    }
  }

  assert.deepEqual(attemptsObject(attempts), {
    "claude-1": 1,
    "claude-2": 1,
    "claude-3": 1,
    "claude-4": 1,
    "openai-1": 1,
  });

  now = CACHE_TTL_MS;
  const boundaryResults = new Map<string, AccountUsageResult>();
  const boundarySummary = await refreshAllAccounts(ids, async (id) => {
    const result = await coordinator.getAccountUsage(`usage:${id}`, "default", { id });
    boundaryResults.set(id, result);
    return result.status === "ready" && !result.stale;
  });

  assert.deepEqual(boundarySummary, { updated: 5, total: 5 });
  assert.deepEqual(attemptsObject(attempts), {
    "claude-1": 2,
    "claude-2": 2,
    "claude-3": 2,
    "claude-4": 2,
    "openai-1": 2,
  });
  for (const id of ids) {
    assert.equal(boundaryResults.get(id)?.fetchedAt, CACHE_TTL_MS);
    assert.deepEqual(boundaryResults.get(id)?.usage, {
      sample: `${id}@${CACHE_TTL_MS}`,
    });
  }
});

test("concurrent requests for one account share one upstream call", async () => {
  let attempts = 0;
  let signalUpstreamStarted!: () => void;
  const upstreamStarted = new Promise<void>((resolve) => {
    signalUpstreamStarted = resolve;
  });
  let releaseUpstream!: () => void;
  const upstreamGate = new Promise<void>((resolve) => {
    releaseUpstream = resolve;
  });
  const coordinator = new LocalUsageCoordinator<TestAccount>(
    () => 42,
    async (request) => {
      attempts += 1;
      signalUpstreamStarted();
      await upstreamGate;
      return commitReady(request);
    },
  );

  const first = coordinator.getAccountUsage("usage:claude-1", "default", { id: "claude-1" });
  const second = coordinator.getAccountUsage("usage:claude-1", "default", { id: "claude-1" });
  const third = coordinator.getAccountUsage("usage:claude-1", "default", { id: "claude-1" });

  await upstreamStarted;
  assert.equal(attempts, 1);
  releaseUpstream();
  const results = await Promise.all([first, second, third]);

  assert.equal(attempts, 1);
  assert.deepEqual(
    results.map((result) => result.fetchedAt),
    [42, 42, 42],
  );
  assert.deepEqual(
    results.map((result) => result.usage),
    [
      { sample: "claude-1@42" },
      { sample: "claude-1@42" },
      { sample: "claude-1@42" },
    ],
  );
});

test("one failed account keeps stale data without altering four sibling cache entries", async () => {
  const ids = ["claude-1", "claude-2", "claude-3", "claude-4", "openai-1"];
  const attempts = new Map<string, number>();
  let now = 0;
  const coordinator = new LocalUsageCoordinator<TestAccount>(
    () => now,
    async (request) => {
      const id = request.account.id;
      attempts.set(id, (attempts.get(id) ?? 0) + 1);
      if (id === "claude-3" && request.now === CACHE_TTL_MS) {
        throw new Error("simulated provider outage");
      }
      return commitReady(request);
    },
  );

  await refreshAllAccounts(ids, async (id) => {
    const result = await coordinator.getAccountUsage(`usage:${id}`, "default", { id });
    return result.status === "ready";
  });

  now = CACHE_TTL_MS;
  const results = new Map<string, AccountUsageResult>();
  const summary = await refreshAllAccounts(ids, async (id) => {
    const result = await coordinator.getAccountUsage(`usage:${id}`, "default", { id });
    results.set(id, result);
    return result.status === "ready" && !result.stale;
  });

  assert.deepEqual(summary, { updated: 4, total: 5 });
  assert.deepEqual(results.get("claude-3"), {
    usage: { sample: "claude-3@0" },
    profile: null,
    status: "stale",
    fetchedAt: 0,
    cooldownUntil: 0,
    stale: true,
    error: "simulated provider outage",
  });
  for (const id of ["claude-1", "claude-2", "claude-4", "openai-1"]) {
    assert.deepEqual(results.get(id), readyResult(id, CACHE_TTL_MS));
  }
  assert.deepEqual(attemptsObject(attempts), {
    "claude-1": 2,
    "claude-2": 2,
    "claude-3": 2,
    "claude-4": 2,
    "openai-1": 2,
  });
});

test("a stale cooldown serves the last successful sample without another upstream call", async () => {
  let now = 0;
  let attempts = 0;
  const coordinator = new LocalUsageCoordinator<TestAccount>(
    () => now,
    async (request) => {
      attempts += 1;
      if (attempts === 1) return commitReady(request);
      await request.store.commit({
        status: "stale",
        cooldownUntil: request.now + COOLDOWN_MS,
      });
      return {
        usage: request.prior.usage,
        profile: request.prior.profile,
        status: "stale",
        fetchedAt: request.prior.fetchedAt,
        cooldownUntil: request.now + COOLDOWN_MS,
        stale: true,
      };
    },
  );

  await coordinator.getAccountUsage("usage:claude-1", "default", { id: "claude-1" });
  now = CACHE_TTL_MS;
  await coordinator.getAccountUsage("usage:claude-1", "default", { id: "claude-1" });
  now += 60_000;
  const result = await coordinator.getAccountUsage("usage:claude-1", "default", {
    id: "claude-1",
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, {
    usage: { sample: "claude-1@0" },
    profile: null,
    status: "stale",
    fetchedAt: 0,
    cooldownUntil: CACHE_TTL_MS + COOLDOWN_MS,
    stale: true,
  });
});

test("an upstream failure without cached data returns an error result", async () => {
  const coordinator = new LocalUsageCoordinator<TestAccount>(
    () => 0,
    async () => {
      throw new Error("first fetch failed");
    },
  );

  const result = await coordinator.getAccountUsage("usage:claude-1", "default", {
    id: "claude-1",
  });

  assert.deepEqual(result, {
    usage: null,
    profile: null,
    status: "error",
    fetchedAt: null,
    cooldownUntil: 0,
    stale: true,
    error: "first fetch failed",
  });
});
