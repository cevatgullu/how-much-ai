import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

const workerSource = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://dashboard.example.test";
const REQUEST_ID = "0123456789abcdef0123456789abcdef";
const TAG = "hma:abcdef0123456789abcdef0123456789";

interface WorkerHarnessOptions {
  showNotification?: (title: string, options: Record<string, unknown>) => Promise<void>;
  throwSynchronously?: boolean;
  windowClients?: Array<{ url: string; focus?: () => Promise<unknown>; navigate?: (url: string) => Promise<unknown> }>;
}

function createWorkerHarness(options: WorkerHarnessOptions = {}) {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const self = {
    location: { origin: ORIGIN },
    registration: {
      showNotification: (title: string, notificationOptions: Record<string, unknown>) => {
        shown.push({ title, options: notificationOptions });
        if (options.throwSynchronously) throw new Error("synchronous display failure");
        return options.showNotification?.(title, notificationOptions) ?? Promise.resolve();
      },
    },
    clients: {
      matchAll: async () => options.windowClients ?? [],
      openWindow: async (url: string) => { opened.push(url); },
    },
    addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => {
      handlers.set(type, handler);
    },
  };
  vm.runInContext(workerSource, vm.createContext({ self, URL, Promise }));

  return { handlers, shown, opened };
}

function validMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "hma-local-limit-v1",
    requestId: REQUEST_ID,
    title: "How Much AI",
    body: "Weekly limit has 8% remaining.",
    tag: TAG,
    ...overrides,
  };
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function sendMessage(
  harness: ReturnType<typeof createWorkerHarness>,
  data: unknown,
  options: { sourceUrl?: unknown; ports?: unknown[] } = {},
) {
  const acknowledgements: unknown[] = [];
  const port = { postMessage: (message: unknown) => acknowledgements.push(message), close: () => undefined };
  const waits: Promise<unknown>[] = [];
  harness.handlers.get("message")?.({
    data,
    source: { url: options.sourceUrl ?? `${ORIGIN}/dashboard` },
    ports: options.ports ?? [port],
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
  });
  await Promise.all(waits);
  return acknowledgements;
}

test("a valid same-origin local request displays only validated notification fields and acknowledges after display", async () => {
  let displayResolved = false;
  const harness = createWorkerHarness({
    showNotification: async () => { displayResolved = true; },
  });
  const acknowledgements = await sendMessage(harness, validMessage());

  assert.equal(displayResolved, true);
  assert.deepEqual(plain(harness.shown), [{
    title: "How Much AI",
    options: {
      body: "Weekly limit has 8% remaining.",
      tag: TAG,
      renotify: true,
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { url: "/" },
    },
  }]);
  assert.deepEqual(plain(acknowledgements), [{
    type: "hma-local-limit-result-v1",
    requestId: REQUEST_ID,
    ok: true,
  }]);
});

test("exact own request fields, title, body, and tag are enforced before display", async () => {
  const hiddenExtraMessage = validMessage();
  Object.defineProperty(hiddenExtraMessage, "extra", { value: true, enumerable: false });
  const symbolicMessage = validMessage();
  Object.defineProperty(symbolicMessage, Symbol("private"), { value: true });
  const invalidMessages = [
    { ...validMessage(), extra: true },
    hiddenExtraMessage,
    symbolicMessage,
    Object.assign(Object.create(null), { ...validMessage(), body: "" }),
    validMessage({ title: "Account warning" }),
    validMessage({ body: "x".repeat(241) }),
    validMessage({ body: "line\nfeed" }),
    validMessage({ body: "delete\u007fcontrol" }),
    validMessage({ tag: "hma:ABCDEF0123456789abcdef0123456789" }),
    validMessage({ tag: "hma:abcdef0123456789abcdef012345678" }),
  ];

  for (const message of invalidMessages) {
    const harness = createWorkerHarness();
    const acknowledgements = await sendMessage(harness, message);
    assert.equal(harness.shown.length, 0);
    assert.deepEqual(plain(acknowledgements), [{
      type: "hma-local-limit-result-v1",
      requestId: REQUEST_ID,
      ok: false,
    }]);
  }
});

test("invalid source, request ID, or MessagePort receives no reflective response", async () => {
  const cases = [
    { message: validMessage(), sourceUrl: "https://evil.example.test/", ports: undefined },
    { message: validMessage(), sourceUrl: "not a URL", ports: undefined },
    { message: validMessage({ requestId: "A".repeat(32) }), sourceUrl: undefined, ports: undefined },
    { message: validMessage(), sourceUrl: undefined, ports: [] },
    { message: validMessage(), sourceUrl: undefined, ports: [{ postMessage() {} }, { postMessage() {} }] },
    { message: validMessage(), sourceUrl: undefined, ports: [{}] },
  ];

  for (const item of cases) {
    const harness = createWorkerHarness();
    const acknowledgements = await sendMessage(harness, item.message, {
      sourceUrl: item.sourceUrl,
      ports: item.ports,
    });
    assert.equal(harness.shown.length, 0);
    assert.deepEqual(acknowledgements, []);
  }
});

test("display failure returns only the generic negative acknowledgement", async () => {
  const harness = createWorkerHarness({
    showNotification: async () => { throw new Error(`do not echo ${TAG}`); },
  });
  const acknowledgements = await sendMessage(harness, validMessage());

  assert.deepEqual(plain(acknowledgements), [{
    type: "hma-local-limit-result-v1",
    requestId: REQUEST_ID,
    ok: false,
  }]);
  assert.doesNotMatch(JSON.stringify(acknowledgements), /Weekly limit|hma:/);
});

test("a synchronous display failure also returns only the generic negative acknowledgement", async () => {
  const harness = createWorkerHarness({ throwSynchronously: true });
  const acknowledgements = await sendMessage(harness, validMessage());

  assert.deepEqual(plain(acknowledgements), [{
    type: "hma-local-limit-result-v1",
    requestId: REQUEST_ID,
    ok: false,
  }]);
});

test("hosted push handling remains available", async () => {
  const harness = createWorkerHarness();
  const waits: Promise<unknown>[] = [];
  harness.handlers.get("push")?.({
    data: { json: () => ({ title: "Hosted alert", body: "Hosted body", tag: "hosted-tag" }) },
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
  });
  await Promise.all(waits);

  assert.equal(harness.shown[0]?.title, "Hosted alert");
  assert.equal(harness.shown[0]?.options.body, "Hosted body");
  assert.equal(harness.shown[0]?.options.tag, "hosted-tag");
});

test("notification clicks ignore stored URLs and focus same-origin clients only", async () => {
  const actions: string[] = [];
  const harness = createWorkerHarness({
    windowClients: [
      { url: "https://evil.example.test/phish", focus: async () => { actions.push("evil-focus"); } },
      {
        url: `${ORIGIN}/existing`,
        navigate: async (url) => { actions.push(`navigate:${url}`); },
        focus: async () => { actions.push("local-focus"); },
      },
    ],
  });
  const waits: Promise<unknown>[] = [];
  harness.handlers.get("notificationclick")?.({
    notification: {
      data: { url: "https%3A%2F%2Fevil.example.test%2Fphish" },
      close: () => { actions.push("close"); },
    },
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
  });
  await Promise.all(waits);

  assert.deepEqual(actions, ["close", "local-focus"]);
  assert.deepEqual(harness.opened, []);
});

test("notification clicks open exact / when no same-origin client exists", async () => {
  const harness = createWorkerHarness({
    windowClients: [{ url: "https://evil.example.test/phish", focus: async () => undefined }],
  });
  const waits: Promise<unknown>[] = [];
  harness.handlers.get("notificationclick")?.({
    notification: { data: { url: "//evil.example.test" }, close: () => undefined },
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
  });
  await Promise.all(waits);

  assert.deepEqual(harness.opened, ["/"]);
});
