import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  deliverLocalNotification,
  LOCAL_NOTIFICATION_ACK,
  LOCAL_NOTIFICATION_MESSAGE,
  localNotificationPermission,
  requestLocalNotificationPermission,
} from "./local-notify-delivery.ts";

const VALID_PAYLOAD = {
  title: "How Much AI" as const,
  body: "Current session has 9% remaining.",
  tag: "hma:0123456789abcdef0123456789abcdef",
};

const replacedGlobals = [
  "Notification",
  "navigator",
  "MessageChannel",
  "crypto",
  "fetch",
  "PushManager",
  "setTimeout",
  "clearTimeout",
] as const;
const originalDescriptors = new Map(
  replacedGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);

afterEach(() => {
  for (const name of replacedGlobals) {
    const descriptor = originalDescriptors.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

class TestPort {
  peer?: TestPort;
  closed = false;
  started = false;
  readonly listeners = new Set<(event: MessageEvent) => void>();

  addEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener);
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }

  postMessage(data: unknown): void {
    const peer = this.peer;
    queueMicrotask(() => {
      for (const listener of peer?.listeners ?? []) listener({ data } as MessageEvent);
    });
  }
}

class TestMessageChannel {
  readonly port1 = new TestPort();
  readonly port2 = new TestPort();

  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

interface BrowserEnvironmentOptions {
  permission?: NotificationPermission;
  requestPermission?: () => Promise<NotificationPermission>;
  onPostMessage?: (data: unknown, ports: readonly TestPort[]) => void;
  active?: boolean;
  controller?: boolean;
}

function installBrowserEnvironment(options: BrowserEnvironmentOptions = {}) {
  const calls = {
    register: [] as string[],
    permissionRequests: 0,
    posted: [] as unknown[],
    fetches: 0,
  };
  const notification = {
    permission: options.permission ?? "granted",
    requestPermission: async () => {
      calls.permissionRequests += 1;
      return options.requestPermission?.() ?? notification.permission;
    },
  };
  const worker = {
    postMessage: (data: unknown, ports: readonly TestPort[]) => {
      calls.posted.push(data);
      options.onPostMessage?.(data, ports);
    },
  };
  const registration = { active: options.active === false ? null : worker };
  const serviceWorker = {
    controller: options.controller ? worker : null,
    register: async (url: string) => {
      calls.register.push(url);
      return registration;
    },
    ready: Promise.resolve(registration),
  };

  Object.defineProperty(globalThis, "Notification", { configurable: true, value: notification });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker, locks: { request: async () => undefined } },
  });
  Object.defineProperty(globalThis, "MessageChannel", { configurable: true, value: TestMessageChannel });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
        return bytes;
      },
    },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => {
      calls.fetches += 1;
      throw new Error("Local delivery must not use fetch");
    },
  });
  Object.defineProperty(globalThis, "PushManager", {
    configurable: true,
    get: () => {
      throw new Error("Local delivery must not inspect PushManager");
    },
  });
  return calls;
}

test("permission is requested only by the explicit permission function and denied is not prompted again", async () => {
  let permission: NotificationPermission = "default";
  const calls = installBrowserEnvironment({
    get permission() {
      return permission;
    },
    requestPermission: async () => {
      permission = "denied";
      (globalThis.Notification as unknown as { permission: NotificationPermission }).permission = permission;
      return permission;
    },
  });

  assert.equal(localNotificationPermission(), "default");
  assert.deepEqual(await deliverLocalNotification(VALID_PAYLOAD), {
    ok: false,
    reason: "denied",
    message: "Local notifications are not permitted.",
  });
  assert.equal(calls.permissionRequests, 0);

  assert.deepEqual(await requestLocalNotificationPermission(), {
    ok: false,
    reason: "denied",
    message: "Local notifications are not permitted.",
  });
  assert.equal(calls.permissionRequests, 1);
  assert.deepEqual(await requestLocalNotificationPermission(), {
    ok: false,
    reason: "denied",
    message: "Local notifications are not permitted.",
  });
  assert.equal(calls.permissionRequests, 1);
});

test("support requires local browser primitives but never PushManager", async () => {
  installBrowserEnvironment();
  assert.equal(localNotificationPermission(), "granted");
  assert.deepEqual(await requestLocalNotificationPermission(), { ok: true });

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker: {}, locks: undefined },
  });
  assert.equal(localNotificationPermission(), "unsupported");
  assert.deepEqual(await deliverLocalNotification(VALID_PAYLOAD), {
    ok: false,
    reason: "unsupported",
    message: "Local notifications are unavailable in this browser.",
  });
});

test("delivery registers only /sw.js and accepts a matching exact acknowledgement", async () => {
  let sentPort: TestPort | undefined;
  const calls = installBrowserEnvironment({
    onPostMessage: (data, ports) => {
      const request = data as Record<string, unknown>;
      assert.deepEqual(Object.keys(request).sort(), ["body", "requestId", "tag", "title", "type"]);
      assert.equal(request.type, LOCAL_NOTIFICATION_MESSAGE);
      assert.equal(request.requestId, "000102030405060708090a0b0c0d0e0f");
      assert.equal(request.title, VALID_PAYLOAD.title);
      assert.equal(request.body, VALID_PAYLOAD.body);
      assert.equal(request.tag, VALID_PAYLOAD.tag);
      assert.equal(ports.length, 1);
      sentPort = ports[0];
      ports[0]?.postMessage({
        type: LOCAL_NOTIFICATION_ACK,
        requestId: request.requestId,
        ok: true,
      });
    },
  });

  assert.deepEqual(await deliverLocalNotification(VALID_PAYLOAD), { ok: true });
  assert.deepEqual(calls.register, ["/sw.js"]);
  assert.equal(calls.fetches, 0);
  assert.equal(calls.posted.length, 1);
  assert.equal(sentPort?.peer?.closed, true);
});

test("delivery rejects malformed payloads locally without echoing private content", async () => {
  const calls = installBrowserEnvironment();
  const privateBody = "private-body\u0000";
  const result = await deliverLocalNotification({
    title: "How Much AI",
    body: privateBody,
    tag: "hma:PRIVATE-TAG",
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.reason, "worker");
  assert.doesNotMatch(JSON.stringify(result), /private-body|PRIVATE-TAG/);
  assert.deepEqual(calls.register, []);
  assert.equal(calls.posted.length, 0);
});

test("delivery ignores malformed, mismatched, and negative acknowledgements without reflecting payload", async () => {
  const hiddenExtraAcknowledgement = {
    type: LOCAL_NOTIFICATION_ACK,
    requestId: "000102030405060708090a0b0c0d0e0f",
    ok: true,
  };
  Object.defineProperty(hiddenExtraAcknowledgement, "body", { value: "hidden", enumerable: false });
  const acknowledgements = [
    { type: LOCAL_NOTIFICATION_ACK, requestId: "f".repeat(32), ok: true },
    { type: LOCAL_NOTIFICATION_ACK, requestId: "000102030405060708090a0b0c0d0e0f", ok: true, body: "extra" },
    { type: LOCAL_NOTIFICATION_ACK, requestId: "000102030405060708090a0b0c0d0e0f", ok: "true" },
    hiddenExtraAcknowledgement,
    { type: LOCAL_NOTIFICATION_ACK, requestId: "000102030405060708090a0b0c0d0e0f", ok: false },
  ];

  for (const acknowledgement of acknowledgements) {
    installBrowserEnvironment({
      onPostMessage: (_data, ports) => ports[0]?.postMessage(acknowledgement),
    });
    const result = await deliverLocalNotification(VALID_PAYLOAD);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.reason, "worker");
    assert.doesNotMatch(JSON.stringify(result), /Current session|hma:/);
  }
});

test("delivery times out after exactly 10 seconds and cleans its timer and port", async () => {
  let timeoutMs = -1;
  let timeoutCallback: (() => void) | undefined;
  let clearCalls = 0;
  let sentPort: TestPort | undefined;
  installBrowserEnvironment({ onPostMessage: (_data, ports) => { sentPort = ports[0]; } });
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: (callback: () => void, milliseconds: number) => {
      timeoutCallback = callback;
      timeoutMs = milliseconds;
      return 41;
    },
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    value: (timer: number) => {
      assert.equal(timer, 41);
      clearCalls += 1;
    },
  });

  const pending = deliverLocalNotification(VALID_PAYLOAD);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(timeoutMs, 10_000);
  timeoutCallback?.();
  assert.deepEqual(await pending, {
    ok: false,
    reason: "timeout",
    message: "Local notification delivery timed out.",
  });
  assert.equal(clearCalls, 1);
  assert.equal(sentPort?.peer?.closed, true);
  assert.equal(sentPort?.peer?.listeners.size, 0);
});

test("delivery fails generically when no active worker can receive the request", async () => {
  installBrowserEnvironment({ active: false, controller: false });
  assert.deepEqual(await deliverLocalNotification(VALID_PAYLOAD), {
    ok: false,
    reason: "worker",
    message: "Local notification delivery failed.",
  });
});
