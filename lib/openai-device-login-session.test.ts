import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOpenAIDeviceLoginSession,
  OPENAI_DEVICE_VERIFICATION_URL,
  type OpenAIDeviceLoginState,
} from "./openai-device-login-session.ts";

interface ScheduledTask {
  callback: () => void;
  delay: number;
}

function scheduler() {
  let nextId = 1;
  const tasks = new Map<number, ScheduledTask>();
  const cleared: number[] = [];
  return {
    tasks,
    cleared,
    setTimeout(callback: () => void, delay: number) {
      const id = nextId++;
      tasks.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id: number) {
      cleared.push(id);
      tasks.delete(id);
    },
    runOnly() {
      assert.equal(tasks.size, 1, "exactly one recursive poll may be scheduled");
      const [id, task] = [...tasks][0];
      tasks.delete(id);
      task.callback();
      return task.delay;
    },
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function validStart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attemptId: "attempt-a",
    userCode: "ABCD-EFGH",
    verificationUrl: OPENAI_DEVICE_VERIFICATION_URL,
    pollAfterMs: 1_000,
    expiresAt: 99_000,
    ...overrides,
  };
}

test("start opens the fixed OpenAI page before fetch and recursively honors server poll delays", async () => {
  const clock = scheduler();
  const events: string[] = [];
  const states: OpenAIDeviceLoginState[] = [];
  const connected: unknown[] = [];
  const responses = [
    json({
      attemptId: "attempt-a",
      userCode: "ABCD-EFGH",
      verificationUrl: OPENAI_DEVICE_VERIFICATION_URL,
      pollAfterMs: 1_250,
      expiresAt: 99_000,
    }),
    json({ status: "pending", pollAfterMs: 2_750, expiresAt: 99_000 }),
    json({
      status: "done",
      account: {
        id: "account-a",
        email: "account@example.invalid",
        plan: "ChatGPT Plus",
        label: "Personal",
        alreadyConnected: false,
      },
    }),
  ];
  const session = createOpenAIDeviceLoginSession({
    fetch: async (input) => {
      events.push(`fetch:${String(input)}`);
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
    open(url) {
      events.push(`open:${url}`);
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    navigateToLogin() {
      events.push("login");
    },
    onState(state) {
      states.push(state);
    },
    onConnected(account) {
      connected.push(account);
    },
  });

  const starting = session.start("expected-account");
  assert.deepEqual(events.slice(0, 2), [
    `open:${OPENAI_DEVICE_VERIFICATION_URL}`,
    "fetch:/api/connect/openai/device/start",
  ], "the safe popup and start request both begin before start yields");
  await starting;
  assert.deepEqual(events.slice(0, 2), [
    `open:${OPENAI_DEVICE_VERIFICATION_URL}`,
    "fetch:/api/connect/openai/device/start",
  ]);
  assert.deepEqual(states.at(-1), {
    status: "waiting",
    userCode: "ABCD-EFGH",
    verificationUrl: OPENAI_DEVICE_VERIFICATION_URL,
    expiresAt: 99_000,
  });
  assert.equal(clock.tasks.size, 1);
  assert.equal(clock.cleared.length, 1, "the start deadline is cleared before the poll timer is installed");
  assert.equal(clock.runOnly(), 1_250);
  await settle();
  assert.equal(clock.tasks.size, 1);
  assert.equal(clock.runOnly(), 2_750);
  await settle();
  assert.equal(clock.tasks.size, 0);
  assert.equal(states.filter((state) => state.status === "done").length, 1);
  assert.deepEqual(connected, [{
    id: "account-a",
    email: "account@example.invalid",
    plan: "ChatGPT Plus",
    label: "Personal",
    alreadyConnected: false,
  }]);
});

test("a mismatched server verification URL fails safely without opening it or polling", async () => {
  const clock = scheduler();
  const opened: string[] = [];
  const states: OpenAIDeviceLoginState[] = [];
  const session = createOpenAIDeviceLoginSession({
    fetch: async () => json({
      attemptId: "attempt-a",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://attacker.invalid/device",
      pollAfterMs: 1_000,
      expiresAt: 99_000,
    }),
    open(url) {
      opened.push(url);
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    navigateToLogin() {},
    onState(state) {
      states.push(state);
    },
    onConnected() {
      assert.fail("an invalid start response cannot connect an account");
    },
  });

  await session.start();
  assert.deepEqual(opened, [OPENAI_DEVICE_VERIFICATION_URL]);
  assert.equal(clock.tasks.size, 0);
  assert.equal(states.at(-1)?.status, "failed");
  assert.equal(states.some((state) => state.status === "waiting"), false);
});

test("a never-settling start request is aborted at one deterministic deadline", async () => {
  const clock = scheduler();
  const never = deferred<Response>();
  const states: OpenAIDeviceLoginState[] = [];
  const busy: boolean[] = [];
  let signal: AbortSignal | undefined;
  const session = createOpenAIDeviceLoginSession({
    fetch: async (_input, init) => {
      signal = init?.signal as AbortSignal;
      return never.promise;
    },
    open() {},
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    navigateToLogin() {},
    onState(state) {
      states.push(state);
    },
    onConnected() {
      assert.fail("a timed-out start cannot connect");
    },
    onBusyChange(value) {
      busy.push(value);
    },
  });

  const starting = session.start();
  assert.equal(clock.tasks.size, 1, "start must own the session's only timer");
  assert.equal(clock.runOnly(), 30_000);
  await starting;

  assert.equal(signal?.aborted, true);
  assert.equal(clock.tasks.size, 0);
  assert.deepEqual(busy, [true, false]);
  assert.equal(states.at(-1)?.status, "failed");
  assert.equal(states.some((state) => state.status === "waiting"), false);
});

test("cancel releases a never-settling start request and suppresses its late response", async () => {
  const clock = scheduler();
  const pendingStart = deferred<Response>();
  const states: OpenAIDeviceLoginState[] = [];
  const busy: boolean[] = [];
  let signal: AbortSignal | undefined;
  const session = createOpenAIDeviceLoginSession({
    fetch: async (_input, init) => {
      signal = init?.signal as AbortSignal;
      return pendingStart.promise;
    },
    open() {},
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    navigateToLogin() {
      assert.fail("a cancelled start cannot navigate");
    },
    onState(state) {
      states.push(state);
    },
    onConnected() {
      assert.fail("a cancelled start cannot connect");
    },
    onBusyChange(value) {
      busy.push(value);
    },
  });

  const starting = session.start();
  assert.equal(clock.tasks.size, 1);
  const stateCount = states.length;
  session.cancel();
  await starting;
  assert.equal(signal?.aborted, true);
  assert.equal(clock.tasks.size, 0);
  assert.equal(clock.cleared.length, 1);
  assert.deepEqual(busy, [true, false]);

  pendingStart.resolve(json(validStart()));
  await settle();
  assert.equal(states.length, stateCount);
  assert.equal(clock.tasks.size, 0);
});

test("start accepts only exact fields and JavaScript-date-safe expiry values", async () => {
  for (const body of [
    validStart({ accessToken: "must-not-cross-browser-boundary" }),
    validStart({ expiresAt: 8_640_000_000_000_001 }),
  ]) {
    const clock = scheduler();
    const states: OpenAIDeviceLoginState[] = [];
    const session = createOpenAIDeviceLoginSession({
      fetch: async () => json(body),
      open() {},
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      navigateToLogin() {},
      onState(state) {
        states.push(state);
      },
      onConnected() {},
    });

    await session.start();
    assert.equal(states.at(-1)?.status, "failed");
    assert.equal(states.some((state) => state.status === "waiting"), false);
    assert.equal(clock.tasks.size, 0);
  }
});

test("pending and processing accept only exact fields and date-safe expiries", async () => {
  for (const statusBody of [
    { status: "pending", pollAfterMs: 1_000, expiresAt: 99_000, refreshToken: "must-not-cross-browser-boundary" },
    { status: "processing", pollAfterMs: 1_000, expiresAt: 99_000, accessToken: "must-not-cross-browser-boundary" },
    { status: "pending", pollAfterMs: 1_000, expiresAt: 8_640_000_000_000_001 },
  ]) {
    const clock = scheduler();
    const states: OpenAIDeviceLoginState[] = [];
    const responses = [json(validStart({ pollAfterMs: 1 })), json(statusBody)];
    const session = createOpenAIDeviceLoginSession({
      fetch: async () => responses.shift()!,
      open() {},
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      navigateToLogin() {},
      onState(state) {
        states.push(state);
      },
      onConnected() {},
    });

    await session.start();
    clock.runOnly();
    await settle();
    assert.equal(states.at(-1)?.status, "failed");
    assert.equal(clock.tasks.size, 0);
  }
});

test("terminal success bodies require their exact status and error fields", async () => {
  async function terminal(body: Record<string, unknown>): Promise<OpenAIDeviceLoginState["status"] | undefined> {
    const clock = scheduler();
    const states: OpenAIDeviceLoginState[] = [];
    const responses = [json(validStart({ pollAfterMs: 1 })), json(body)];
    const session = createOpenAIDeviceLoginSession({
      fetch: async () => responses.shift()!,
      open() {},
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      navigateToLogin() {},
      onState(state) {
        states.push(state);
      },
      onConnected() {},
    });
    await session.start();
    clock.runOnly();
    await settle();
    assert.equal(clock.tasks.size, 0);
    return states.at(-1)?.status;
  }

  assert.equal(await terminal({ status: "failed", error: "Try again" }), "failed");
  assert.equal(await terminal({ status: "expired", error: "Start again" }), "expired");
  assert.equal(
    await terminal({ status: "expired", error: "Start again", accessToken: "must-not-cross-browser-boundary" }),
    "failed",
  );
  assert.equal(await terminal({ status: "expired" }), "failed");
  assert.equal(
    await terminal({ status: "failed", error: "Try again", refreshToken: "must-not-cross-browser-boundary" }),
    "failed",
  );
});

test("cancel aborts the active request, clears its timer, and fences every late response", async () => {
  const timerClock = scheduler();
  const timerSession = createOpenAIDeviceLoginSession({
    fetch: async () => json({
      attemptId: "timer-attempt",
      userCode: "TIMER-CODE",
      verificationUrl: OPENAI_DEVICE_VERIFICATION_URL,
      pollAfterMs: 500,
      expiresAt: 99_000,
    }),
    open() {},
    setTimeout: timerClock.setTimeout,
    clearTimeout: timerClock.clearTimeout,
    navigateToLogin() {},
    onState() {},
    onConnected() {},
  });
  await timerSession.start();
  assert.equal(timerClock.tasks.size, 1);
  timerSession.cancel();
  assert.equal(timerClock.tasks.size, 0);
  assert.equal(timerClock.cleared.length, 2, "both the completed start deadline and pending poll were cleared");

  const clock = scheduler();
  const pendingPoll = deferred<Response>();
  const states: OpenAIDeviceLoginState[] = [];
  const signals: AbortSignal[] = [];
  let calls = 0;
  const session = createOpenAIDeviceLoginSession({
    fetch: async (_input, init) => {
      signals.push(init?.signal as AbortSignal);
      calls += 1;
      return calls === 1
        ? json({
            attemptId: "attempt-a",
            userCode: "ABCD-EFGH",
            verificationUrl: OPENAI_DEVICE_VERIFICATION_URL,
            pollAfterMs: 500,
            expiresAt: 99_000,
          })
        : pendingPoll.promise;
    },
    open() {},
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    navigateToLogin() {
      assert.fail("a cancelled response cannot navigate");
    },
    onState(state) {
      states.push(state);
    },
    onConnected() {
      assert.fail("a cancelled response cannot connect an account");
    },
  });

  await session.start();
  clock.runOnly();
  await settle();
  assert.equal(signals.at(-1)?.aborted, false);
  const stateCount = states.length;
  session.cancel();
  assert.equal(signals.at(-1)?.aborted, true);
  assert.equal(clock.tasks.size, 0);
  pendingPoll.resolve(json({
    status: "done",
    account: {
      id: "late",
      email: "late@example.invalid",
      plan: "ChatGPT Plus",
      label: "Late",
      alreadyConnected: false,
    },
  }));
  await settle();
  assert.equal(states.length, stateCount);
  assert.equal(clock.tasks.size, 0);
});

test("only an exact Not signed in 401 navigates to login", async () => {
  async function run(error: string, status: number, extras: Record<string, unknown> = {}): Promise<number> {
    const clock = scheduler();
    let navigations = 0;
    const states: OpenAIDeviceLoginState[] = [];
    const responses = [
      json({
        attemptId: "attempt-a",
        userCode: "ABCD-EFGH",
        verificationUrl: OPENAI_DEVICE_VERIFICATION_URL,
        pollAfterMs: 1,
        expiresAt: 99_000,
      }),
      json({ error, ...extras }, status),
    ];
    const session = createOpenAIDeviceLoginSession({
      fetch: async () => responses.shift()!,
      open() {},
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      navigateToLogin() {
        navigations += 1;
      },
      onState(state) {
        states.push(state);
      },
      onConnected() {},
    });
    await session.start();
    clock.runOnly();
    await settle();
    assert.equal(clock.tasks.size, 0);
    if (navigations === 0) assert.equal(states.at(-1)?.status, "failed");
    return navigations;
  }

  assert.equal(await run("Not signed in", 401), 1);
  assert.equal(await run("Not signed in", 403), 0);
  assert.equal(await run("Session missing", 401), 0);
  assert.equal(await run("Not signed in", 401, { accessToken: "must-not-cross-browser-boundary" }), 0);
});

test("done is emitted once and only for an exact credential-free response", async () => {
  async function run(
    account: Record<string, unknown>,
    responseExtras: Record<string, unknown> = {},
  ): Promise<{ done: number; connected: number }> {
    const clock = scheduler();
    const states: OpenAIDeviceLoginState[] = [];
    let connected = 0;
    const responses = [
      json({
        attemptId: "attempt-a",
        userCode: "ABCD-EFGH",
        verificationUrl: OPENAI_DEVICE_VERIFICATION_URL,
        pollAfterMs: 1,
        expiresAt: 99_000,
      }),
      json({ status: "done", account, ...responseExtras }),
    ];
    const session = createOpenAIDeviceLoginSession({
      fetch: async () => responses.shift()!,
      open() {},
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      navigateToLogin() {},
      onState(state) {
        states.push(state);
      },
      onConnected() {
        connected += 1;
      },
    });
    await session.start();
    clock.runOnly();
    await settle();
    return {
      done: states.filter((state) => state.status === "done").length,
      connected,
    };
  }

  const safeAccount = {
    id: "account-a",
    email: "account@example.invalid",
    plan: "ChatGPT Plus",
    label: "Personal",
    alreadyConnected: false,
  };
  assert.deepEqual(await run(safeAccount), { done: 1, connected: 1 });
  assert.deepEqual(await run({ ...safeAccount, accessToken: "must-not-cross-browser-boundary" }), {
    done: 0,
    connected: 0,
  });
  assert.deepEqual(await run(safeAccount, { refreshToken: "must-not-cross-browser-boundary" }), {
    done: 0,
    connected: 0,
  });
});
