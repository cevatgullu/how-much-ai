import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import "./providers/_resolve-ts.mjs";

const { createStrictLocalFetch, OutboundPolicyError } = await import("./outbound-fetch-policy.ts");

const strictEnv = { HMC_STRICT_LOCAL_MODE: "1" };

test("strict fetch allows only the four exact provider origins and forces manual redirects", async () => {
  const calls: Array<{ url: string; redirect?: RequestRedirect }> = [];
  const upstream: typeof fetch = async (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), redirect: init?.redirect });
    return new Response("{}", { status: 200 });
  };
  const guarded = createStrictLocalFetch(upstream, strictEnv);
  const inputs: Array<RequestInfo | URL> = [
    "https://api.anthropic.com/api/oauth/usage",
    new URL("https://platform.claude.com/v1/oauth/token"),
    new Request("https://auth.openai.com/oauth/token", { redirect: "follow" }),
    "https://chatgpt.com/backend-api/wham/usage",
  ];

  for (const input of inputs) await guarded(input, { redirect: "follow" });

  assert.deepEqual(
    calls.map(({ url }) => new URL(url).origin),
    [
      "https://api.anthropic.com",
      "https://platform.claude.com",
      "https://auth.openai.com",
      "https://chatgpt.com",
    ],
  );
  assert.ok(calls.every((call) => call.redirect === "manual"));
});

test("strict fetch rejects lookalikes, credentials, cleartext, ports, and unrelated origins", async () => {
  let upstreamCalls = 0;
  const guarded = createStrictLocalFetch(async () => {
    upstreamCalls += 1;
    return new Response("{}");
  }, strictEnv);

  for (const url of [
    "https://api.anthropic.com.attacker.example/steal",
    "https://attacker.example/",
    "http://api.anthropic.com/api/oauth/usage",
    "https://api.anthropic.com:444/api/oauth/usage",
    "https://user:pass@api.anthropic.com/api/oauth/usage",
    "http://127.0.0.1:37645/api/usage",
  ]) {
    await assert.rejects(() => guarded(url), OutboundPolicyError);
  }

  let coercions = 0;
  const changingInput = {
    toString: () => ++coercions === 1
      ? "https://api.anthropic.com/api/oauth/usage"
      : "https://attacker.example/steal",
  } as unknown as RequestInfo;
  await assert.rejects(() => guarded(changingInput), OutboundPolicyError);
  assert.equal(upstreamCalls, 0);
});

test("blocked and malformed URLs stay out of diagnostics and expose no original-fetch escape", async () => {
  const canary = `secret-${randomUUID()}`;
  const upstream = Object.assign(async () => new Response("{}"), {
    __hmaOriginalFetch: async () => new Response("{}"),
    _nextOriginalFetch: async () => new Response("{}"),
  }) as unknown as typeof fetch;
  const guarded = createStrictLocalFetch(upstream, strictEnv);

  for (const raw of [`https://${canary}.invalid/`, `not-a-url-${canary}`]) {
    await assert.rejects(
      () => guarded(raw),
      (error: Error) =>
        error instanceof OutboundPolicyError &&
        error.name === "OutboundPolicyError" &&
        !error.message.includes(canary),
    );
  }
  assert.equal(Object.prototype.hasOwnProperty.call(guarded, "__hmaOriginalFetch"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(guarded, "_nextOriginalFetch"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(globalThis, "__hmaOriginalFetch"), false);
});

test("non-strict mode preserves the original fetch function and redirect behavior", async () => {
  let redirect: RequestRedirect | undefined;
  const upstream: typeof fetch = async (_input, init) => {
    redirect = init?.redirect;
    return new Response("ok");
  };
  const unguarded = createStrictLocalFetch(upstream, {});

  assert.equal(unguarded, upstream);
  await unguarded("https://example.test/", { redirect: "follow" });
  assert.equal(redirect, "follow");
});
