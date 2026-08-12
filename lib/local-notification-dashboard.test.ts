import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "next/dist/build/swc/index.js";
import type { BrowserAccount, UsageResponse } from "./types.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
let hostedClientResolutions = 0;

function sourceModule(target: string): string {
  for (const candidate of [target, `${target}.ts`, `${target}.tsx`]) {
    try {
      readFileSync(candidate);
      return pathToFileURL(candidate).href;
    } catch {}
  }
  return pathToFileURL(target).href;
}

const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/notify-client") hostedClientResolutions += 1;
    if (specifier.startsWith("@/")) {
      return {
        url: sourceModule(path.join(projectRoot, specifier.slice(2))),
        shortCircuit: true,
      };
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith(pathToFileURL(projectRoot).href) &&
      !context.parentURL.includes("/node_modules/") &&
      path.extname(new URL(specifier, context.parentURL).pathname) === ""
    ) {
      return {
        url: sourceModule(fileURLToPath(new URL(specifier, context.parentURL))),
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      const transformed = transformSync(source, {
        filename: fileURLToPath(url),
        jsc: {
          parser: { syntax: "typescript", tsx: true },
          transform: { react: { runtime: "automatic" } },
        },
        module: { type: "es6" },
      });
      return { format: "module", source: transformed.code, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const {
  NotificationsPanel,
  readHostedPushStatus,
  resolveLocalPermissionRequest,
} = await import("../components/NotificationsPanel.tsx");
const {
  createLocalNotificationTaskQueue,
  localAccountLabel,
  processCurrentLocalDashboardSnapshot,
  processLocalDashboardSnapshot,
} = await import(
  "../components/Dashboard.tsx"
);

after(() => moduleHooks.deregister());

function account(id: string, provider: "anthropic" | "openai" = "anthropic"): BrowserAccount {
  return {
    id,
    email: `${id}@example.invalid`,
    fullName: `Full ${id}`,
    plan: provider === "anthropic" ? "Max" : "ChatGPT Pro",
    addedAt: 1,
    credentialKind: "managed",
    provider,
    credentialExpiresAt: 2,
  };
}

function readyResponse(overrides: Partial<UsageResponse> = {}): UsageResponse {
  return {
    usage: { five_hour: { utilization: 40, resets_at: "2026-08-02T00:00:00.000Z" } },
    profile: null,
    status: "ready",
    stale: false,
    ...overrides,
  };
}

test("localAccountLabel uses only a safe nickname or a provider-specific ordinal", () => {
  let forbiddenReads = 0;
  const privateFields = {
    label: "  Work  ",
    provider: "anthropic" as const,
    get email() { forbiddenReads += 1; return "secret@example.invalid"; },
    get fullName() { forbiddenReads += 1; return "Secret Person"; },
    get id() { forbiddenReads += 1; return "provider-account-secret"; },
  };
  assert.equal(localAccountLabel(privateFields, 3), "Work");
  assert.equal(forbiddenReads, 0);

  for (const label of ["", "person@example.invalid", "line\nbreak", "x".repeat(41)]) {
    assert.equal(localAccountLabel({ label, provider: "anthropic" }, 4), "Claude 4");
  }
  assert.equal(localAccountLabel({ label: "@hidden", provider: "openai" }, 2), "ChatGPT 2");
});

test("strict-local panel renders the fixed rail and explicit device-only controls without loading hosted APIs", () => {
  assert.equal(hostedClientResolutions, 0);
  const markup = renderToStaticMarkup(createElement(NotificationsPanel, {
    open: true,
    onClose() {},
    strictLocal: true,
    autoRefresh: false,
    localStatus: "idle",
  }));

  assert.match(markup, /Kalan limit uyarıları/);
  assert.match(markup, /Limit sıfırlanınca bildir/);
  assert.match(markup, /50 · 40 · 30 · 20 · 15 · 10 · 5 · bitti/);
  assert.match(markup, /Bildirim izni ver/);
  assert.match(markup, /Otomatik yenileme kapalı; canlı bildirimler duraklatıldı\./);
  assert.equal(hostedClientResolutions, 0);
});

test("ordinary panel remains on the hosted notification path", () => {
  const markup = renderToStaticMarkup(createElement(NotificationsPanel, {
    open: true,
    onClose() {},
    strictLocal: false,
    autoRefresh: true,
    localStatus: "idle",
  }));
  assert.match(markup, /Loading notification settings/);
  assert.doesNotMatch(markup, /Kalan limit uyarıları/);
});

test("dashboard notification boundary accepts only strict-local fresh ready usage", async () => {
  const current = account("claude-1");
  const activeAccounts = [current];
  const calls: unknown[] = [];
  const process = async (input: unknown) => {
    calls.push(input);
    return { status: "delivered" as const, delivered: 1 };
  };
  const rules = { remainingWarnings: true, resetNotifications: false };

  assert.equal(await processLocalDashboardSnapshot({
    strictLocal: true,
    response: readyResponse(),
    account: current,
    activeAccounts,
    rules,
    process,
  }), "delivered");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    accountId: "claude-1",
    accountLabel: "Claude 1",
    bars: [{
      key: "session",
      kind: "session",
      label: "5 saatlik limit",
      usedPercent: 40,
      remainingPercent: 60,
      resetsAt: "2026-08-02T00:00:00.000Z",
      severity: "normal",
      isActive: false,
    }],
    activeAccountIds: ["claude-1"],
    rules,
    stale: false,
  });

  for (const candidate of [
    { strictLocal: false, response: readyResponse() },
    { strictLocal: true, response: readyResponse({ status: "reauth" }) },
    { strictLocal: true, response: readyResponse({ status: "loading" }) },
    { strictLocal: true, response: readyResponse({ status: "error" }) },
    { strictLocal: true, response: readyResponse({ status: "stale", stale: true }) },
    { strictLocal: true, response: readyResponse({ usage: null }) },
  ]) {
    assert.equal(await processLocalDashboardSnapshot({
      ...candidate,
      account: current,
      activeAccounts,
      rules,
      process,
    }), null);
  }
  assert.equal(calls.length, 1);
});

test("notification failures stay generic and four Claude accounts keep ordinals 1 through 4", async () => {
  const activeAccounts = [1, 2, 3, 4].map((ordinal) => account(`claude-${ordinal}`));
  const labels: string[] = [];
  for (const current of activeAccounts) {
    const status = await processLocalDashboardSnapshot({
      strictLocal: true,
      response: readyResponse(),
      account: current,
      activeAccounts,
      rules: { remainingWarnings: true, resetNotifications: true },
      process: async (input: { accountLabel: string }) => {
        labels.push(input.accountLabel);
        return { status: "idle", delivered: 0 };
      },
    });
    assert.equal(status, "idle");
  }
  assert.deepEqual(labels, ["Claude 1", "Claude 2", "Claude 3", "Claude 4"]);

  assert.equal(await processLocalDashboardSnapshot({
    strictLocal: true,
    response: readyResponse(),
    account: activeAccounts[0],
    activeAccounts,
    rules: { remainingWarnings: true, resetNotifications: true },
    process: async () => { throw new Error("private payload detail"); },
  }), "worker_error");
});

test("ready local notifications serialize by arrival and survive a rejecting task", async () => {
  const activeAccounts = [1, 2, 3, 4].map((ordinal) => account(`claude-${ordinal}`));
  const queue = createLocalNotificationTaskQueue();
  const labels: string[] = [];
  let concurrency = 0;
  let maxConcurrency = 0;
  const arrivalOrder = [3, 0, 1, 2];

  const results = arrivalOrder.map((index) => {
    const current = activeAccounts[index];
    return queue.enqueue(async () => {
      const status = await processCurrentLocalDashboardSnapshot({
        strictLocal: true,
        response: readyResponse(),
        accountId: current.id,
        getActiveAccounts: () => activeAccounts,
        loadLocalSettings: () => ({
          autoRefresh: true,
          sortMode: "source",
          localNotifications: { remainingWarnings: true, resetNotifications: true },
        }),
        process: async (input: { accountLabel: string }) => {
          concurrency += 1;
          maxConcurrency = Math.max(maxConcurrency, concurrency);
          labels.push(input.accountLabel);
          await new Promise<void>((resolve) => setImmediate(resolve));
          concurrency -= 1;
          return { status: "idle", delivered: 0 };
        },
      });
      if (index === 1) throw new Error("private notification failure");
      return status;
    });
  });

  assert.deepEqual(await Promise.all(results), [
    "idle",
    "idle",
    "worker_error",
    "idle",
  ]);
  assert.deepEqual(labels, ["Claude 4", "Claude 1", "Claude 2", "Claude 3"]);
  assert.equal(maxConcurrency, 1);
});

test("queued execution skips removed targets and hosted mode never reads local settings", async () => {
  const removed = account("claude-removed");
  let accountReads = 0;
  let settingsReads = 0;
  let processCalls = 0;
  const common = {
    response: readyResponse(),
    accountId: removed.id,
    getActiveAccounts: () => {
      accountReads += 1;
      return [] as BrowserAccount[];
    },
    loadLocalSettings: () => {
      settingsReads += 1;
      return {
        autoRefresh: true,
        sortMode: "source",
        localNotifications: { remainingWarnings: true, resetNotifications: true },
      };
    },
    process: async () => {
      processCalls += 1;
      return { status: "idle" as const, delivered: 0 };
    },
  };

  assert.equal(await processCurrentLocalDashboardSnapshot({ ...common, strictLocal: false }), null);
  assert.deepEqual([accountReads, settingsReads, processCalls], [0, 0, 0]);
  assert.equal(await processCurrentLocalDashboardSnapshot({ ...common, strictLocal: true }), null);
  assert.deepEqual([accountReads, settingsReads, processCalls], [1, 0, 0]);
});

test("permission request status follows actual permission and contains request failures", async () => {
  const result = (ok: boolean, reason?: "denied" | "unsupported" | "worker" | "timeout") =>
    ok ? { ok: true as const } : { ok: false as const, reason: reason!, message: "private detail" };

  assert.equal(await resolveLocalPermissionRequest(
    async () => result(true),
    () => "granted",
  ), "granted");
  assert.equal(await resolveLocalPermissionRequest(
    async () => result(true),
    () => "denied",
  ), "denied");
  assert.equal(await resolveLocalPermissionRequest(
    async () => result(false, "denied"),
    () => "default",
  ), "default");
  assert.equal(await resolveLocalPermissionRequest(
    async () => result(false, "worker"),
    () => "default",
  ), "worker_error");
  assert.equal(await resolveLocalPermissionRequest(
    async () => result(false, "timeout"),
    () => "default",
  ), "worker_error");
  assert.equal(await resolveLocalPermissionRequest(
    async () => { throw new Error("private import failure"); },
    () => "default",
  ), "worker_error");
  assert.equal(await resolveLocalPermissionRequest(
    async () => result(true),
    () => "unsupported",
  ), "unsupported");
});

test("hosted push status contains a rejecting client loader generically", async () => {
  assert.deepEqual(await readHostedPushStatus(
    async () => { throw new Error("private module path"); },
    () => "default",
  ), {
    state: "error",
    message: "Couldn't check this browser's push subscription.",
  });

  let subscriptions = 0;
  assert.deepEqual(await readHostedPushStatus(async () => ({
    pushSupported: () => true,
    currentPushSubscription: async () => {
      subscriptions += 1;
      return {} as PushSubscription;
    },
  }), () => "denied"), { state: "denied", message: null });
  assert.equal(subscriptions, 0);
});

test("manual and automatic refreshes share the nonblocking refreshAccount path", () => {
  const source = readFileSync(path.join(projectRoot, "components", "Dashboard.tsx"), "utf8");
  assert.match(source, /refreshAllAccounts\(ids, refreshAccount\)/);
  assert.match(source, /onRefresh=\{\(\) => void refreshAccount\(account\.id\)\}/);
  assert.match(source, /setInterval\(\(\) => void refreshAll\(\), 60_000\)/);
  assert.match(source, /void localNotifyQueueRef\.current\.enqueue\(/);
  assert.doesNotMatch(source, /await localNotifyQueueRef\.current\.enqueue\(/);
});
