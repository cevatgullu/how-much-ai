import assert from "node:assert/strict";
import { test } from "node:test";
import "./_resolve-ts.mjs";

const { OPENAI_DEVICE_AUTH, pollOpenAIDeviceAuthorization, startOpenAIDeviceAuthorization } =
  await import("./openai-device-auth.ts");

type FetchCall = { url: string; init?: RequestInit };

function jwt(payload: Record<string, unknown>): string {
  const segment = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${segment}.signature`;
}

function authorization() {
  return {
    deviceAuthId: "device-1",
    userCode: "ABCD-EFGH",
    intervalMs: 5_000,
    expiresAt: 1_700_000_900_000,
  };
}

function timeoutRecorder(): {
  durations: number[];
  signal: AbortSignal;
  timeoutSignal: (durationMs: number) => AbortSignal;
} {
  const durations: number[] = [];
  const signal = new AbortController().signal;
  return {
    durations,
    signal,
    timeoutSignal: (durationMs) => {
      durations.push(durationMs);
      return signal;
    },
  };
}

async function rejectsWithStatus(operation: Promise<unknown>, status: number): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal((error as { status?: unknown }).status, status);
    return true;
  });
}

test("device start posts only the public client id and validates string interval", async () => {
  const calls: FetchCall[] = [];
  const timeout = timeoutRecorder();
  const result = await startOpenAIDeviceAuthorization({
    now: () => 1_700_000_000_000,
    timeoutSignal: timeout.timeoutSignal,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({ device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: "5" });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://auth.openai.com/api/accounts/deviceauth/usercode");
  assert.deepEqual(calls[0]?.init, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: OPENAI_DEVICE_AUTH.clientId }),
    redirect: "manual",
    cache: "no-store",
    signal: calls[0]?.init?.signal,
  });
  assert.deepEqual(timeout.durations, [15_000]);
  assert.equal(calls[0]?.init?.signal, timeout.signal);
  assert.deepEqual(result, {
    deviceAuthId: "device-1",
    userCode: "ABCD-EFGH",
    intervalMs: 5_000,
    expiresAt: 1_700_000_900_000,
  });
});

test("device start clamps a numeric string interval to one through ten seconds", async () => {
  const low = await startOpenAIDeviceAuthorization({
    fetchImpl: async () =>
      Response.json({ device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: "0.25" }),
  });
  const high = await startOpenAIDeviceAuthorization({
    fetchImpl: async () =>
      Response.json({ device_auth_id: "device-2", user_code: "IJKL-MNOP", interval: "45" }),
  });

  assert.equal(low.intervalMs, 1_000);
  assert.equal(high.intervalMs, 10_000);
});

test("device poll posts only the device fields and treats 404 as pending", async () => {
  const calls: FetchCall[] = [];
  const timeout = timeoutRecorder();
  const result = await pollOpenAIDeviceAuthorization(authorization(), {
    timeoutSignal: timeout.timeoutSignal,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 404 });
    },
  });

  assert.deepEqual(result, { status: "pending" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://auth.openai.com/api/accounts/deviceauth/token");
  assert.deepEqual(calls[0]?.init, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_auth_id: "device-1", user_code: "ABCD-EFGH" }),
    redirect: "manual",
    cache: "no-store",
    signal: calls[0]?.init?.signal,
  });
  assert.deepEqual(timeout.durations, [15_000]);
  assert.equal(calls[0]?.init?.signal, timeout.signal);
});

test("authorized poll exchanges one code with the exact form boundary", async () => {
  const calls: FetchCall[] = [];
  const timeout = timeoutRecorder();
  const accessToken = jwt({ exp: 1_800_000_000 });
  const result = await pollOpenAIDeviceAuthorization(authorization(), {
    timeoutSignal: timeout.timeoutSignal,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) {
        return Response.json({ authorization_code: "authorization-code", code_verifier: "code-verifier" });
      }
      return Response.json({ access_token: accessToken, refresh_token: "synthetic-refresh" });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.url, "https://auth.openai.com/oauth/token");
  assert.deepEqual(calls[1]?.init, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      "grant_type=authorization_code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&code=authorization-code&redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback&code_verifier=code-verifier",
    redirect: "manual",
    cache: "no-store",
    signal: calls[1]?.init?.signal,
  });
  assert.deepEqual(timeout.durations, [15_000, 30_000]);
  assert.equal(calls[0]?.init?.signal, timeout.signal);
  assert.equal(calls[1]?.init?.signal, timeout.signal);
  assert.deepEqual(result, {
    status: "authorized",
    tokens: { accessToken, refreshToken: "synthetic-refresh", expiresAt: 1_800_000_000_000 },
  });
});

test("token exchange rejects a missing refresh token", async () => {
  let calls = 0;
  const accessToken = jwt({ exp: 1_800_000_000 });
  const operation = pollOpenAIDeviceAuthorization(authorization(), {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ authorization_code: "authorization-code", code_verifier: "code-verifier" })
        : Response.json({ access_token: accessToken });
    },
  });

  await rejectsWithStatus(operation, 502);
  assert.equal(calls, 2);
});

test("only a 404 poll response is pending", async () => {
  await rejectsWithStatus(
    startOpenAIDeviceAuthorization({ fetchImpl: async () => new Response(null, { status: 503 }) }),
    503,
  );
  await rejectsWithStatus(
    pollOpenAIDeviceAuthorization(authorization(), {
      fetchImpl: async () => new Response(null, { status: 500 }),
    }),
    500,
  );
});

test("device start rejects malformed response fields", async () => {
  for (const body of [
    { device_auth_id: "", user_code: "ABCD-EFGH", interval: "5" },
    { device_auth_id: "device-1", user_code: 123, interval: "5" },
    { device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: 5 },
    { device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: "five" },
  ]) {
    await rejectsWithStatus(
      startOpenAIDeviceAuthorization({ fetchImpl: async () => Response.json(body) }),
      502,
    );
  }
});

test("device start rejects oversized response fields", async () => {
  for (const body of [
    { device_auth_id: "d".repeat(4_097), user_code: "ABCD-EFGH", interval: "5" },
    { device_auth_id: "device-1", user_code: "u".repeat(129), interval: "5" },
  ]) {
    await rejectsWithStatus(
      startOpenAIDeviceAuthorization({ fetchImpl: async () => Response.json(body) }),
      502,
    );
  }
});

test("device poll rejects malformed authorization fields before exchange", async () => {
  for (const body of [
    { authorization_code: "", code_verifier: "code-verifier" },
    { authorization_code: "authorization-code", code_verifier: null },
  ]) {
    let calls = 0;
    await rejectsWithStatus(
      pollOpenAIDeviceAuthorization(authorization(), {
        fetchImpl: async () => {
          calls += 1;
          return Response.json(body);
        },
      }),
      502,
    );
    assert.equal(calls, 1);
  }
});

test("device poll rejects oversized authorization fields before exchange", async () => {
  for (const body of [
    { authorization_code: "a".repeat(4_097), code_verifier: "code-verifier" },
    { authorization_code: "authorization-code", code_verifier: "v".repeat(4_097) },
  ]) {
    let calls = 0;
    await rejectsWithStatus(
      pollOpenAIDeviceAuthorization(authorization(), {
        fetchImpl: async () => {
          calls += 1;
          return Response.json(body);
        },
      }),
      502,
    );
    assert.equal(calls, 1);
  }
});

test("transport failures are bounded and classified without response details", async () => {
  await rejectsWithStatus(
    startOpenAIDeviceAuthorization({
      fetchImpl: async () => {
        throw new Error("synthetic transport failure");
      },
    }),
    502,
  );
  await rejectsWithStatus(
    pollOpenAIDeviceAuthorization(authorization(), {
      fetchImpl: async () => {
        throw new Error("synthetic transport failure");
      },
    }),
    502,
  );
});

test("an ambiguous exchange transport failure makes exactly one token request", async () => {
  const calls: string[] = [];
  const operation = pollOpenAIDeviceAuthorization(authorization(), {
    fetchImpl: async (input) => {
      calls.push(String(input));
      if (calls.length === 1) {
        return Response.json({ authorization_code: "authorization-code", code_verifier: "code-verifier" });
      }
      throw new Error("synthetic ambiguous exchange");
    },
  });

  await rejectsWithStatus(operation, 502);
  assert.equal(calls.filter((url) => url === "https://auth.openai.com/oauth/token").length, 1);
});

test("device errors expose only the non-secret phase needed for safe retry decisions", async () => {
  await assert.rejects(
    pollOpenAIDeviceAuthorization(authorization(), {
      fetchImpl: async () => new Response(null, { status: 503 }),
    }),
    (error: unknown) => {
      assert.equal((error as { phase?: unknown }).phase, "poll");
      return true;
    },
  );

  await assert.rejects(
    pollOpenAIDeviceAuthorization(authorization(), {
      fetchImpl: async () => Response.json({ authorization_code: "authorization-code", code_verifier: null }),
    }),
    (error: unknown) => {
      assert.equal((error as { phase?: unknown }).phase, "authorization");
      return true;
    },
  );

  let calls = 0;
  await assert.rejects(
    pollOpenAIDeviceAuthorization(authorization(), {
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json({ authorization_code: "authorization-code", code_verifier: "code-verifier" });
        }
        throw new Error("synthetic ambiguous exchange");
      },
    }),
    (error: unknown) => {
      assert.equal((error as { phase?: unknown }).phase, "exchange");
      return true;
    },
  );
});
