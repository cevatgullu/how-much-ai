// Fixtures are verbatim responses captured from grok.com on 2026-08-13 against a live SuperGrok
// account, before and after an upgrade to SuperGrok Plus. The quota payloads moved to
// grok-credits.test.ts when the card stopped drawing two-hour mode windows.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./_resolve-ts.mjs";

const {
  activeGrokTier,
  grokBearerClaims,
  grokCredentialKind,
  grokPlanLabel,
  grokProvider,
  grokTokenFromAuthFile,
} = await import("./grok.ts");
const { ProviderError } = await import("./types.ts");

// A structurally valid JWT with `{"sub":"u-1","email":"a@b.test"}` as its payload. Unsigned: the
// claims are read for display only and are never trusted for authorisation.
const BEARER = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEiLCJlbWFpbCI6ImFAYi50ZXN0In0.c2ln";

test("the active subscription wins over a superseded one", () => {
  // An upgraded account keeps the old row; taking subscriptions[0] reports the wrong plan.
  const payload = {
    subscriptions: [
      { tier: "SUBSCRIPTION_TIER_GROK_PRO", status: "SUBSCRIPTION_STATUS_INACTIVE" },
      { tier: "SUBSCRIPTION_TIER_SUPER_GROK_PLUS", status: "SUBSCRIPTION_STATUS_ACTIVE" },
    ],
  };
  assert.equal(activeGrokTier(payload), "SUBSCRIPTION_TIER_SUPER_GROK_PLUS");
  assert.equal(grokPlanLabel(activeGrokTier(payload)), "SuperGrok Plus");
  assert.equal(activeGrokTier({ subscriptions: [] }), null);
  assert.equal(grokPlanLabel(null), "Grok");
});

test("the credential kind decides which quota source can answer", () => {
  // Neither source covers every install: the hosted deployment cannot read a file on the user's
  // machine, and grok.com's session endpoints do not accept a CLI bearer.
  assert.equal(grokCredentialKind(BEARER), "bearer");
  assert.equal(grokCredentialKind("sso=abc123"), "cookie");
  assert.equal(grokCredentialKind("abc123"), "cookie");
});

test("a pasted session is accepted bare, as a pair, or inside a cookie header", () => {
  const parse = grokProvider.parseManualCredential!;
  assert.deepEqual(parse("abc123"), { accessToken: "sso=abc123", refreshToken: null, expiresAt: 0 });
  assert.deepEqual(parse("  sso=abc123  "), { accessToken: "sso=abc123", refreshToken: null, expiresAt: 0 });
  assert.deepEqual(
    parse("i18nextLng=tr; sso=abc123; x-userid=zzz"),
    { accessToken: "sso=abc123", refreshToken: null, expiresAt: 0 },
  );
  // Base64url session values contain '='; the split must keep the tail intact.
  assert.deepEqual(parse("sso=a.b==").accessToken, "sso=a.b==");
  assert.equal(parse(""), null);
  assert.equal(parse("x-userid=zzz"), null, "a cookie header without sso carries no session");
  assert.equal(parse("two words"), null);
});

test("a pasted ~/.grok/auth.json is read as a bearer credential", () => {
  const parse = grokProvider.parseManualCredential!;
  assert.equal(grokTokenFromAuthFile({ "grok.com": { key: BEARER } }), BEARER);
  assert.equal(grokTokenFromAuthFile({ a: { access_token: BEARER } }), BEARER);
  // Entries without a usable token must not stop the search at the first key.
  assert.equal(grokTokenFromAuthFile({ a: { key: "" }, b: { key: BEARER } }), BEARER);
  assert.equal(grokTokenFromAuthFile({ a: { key: "not-a-jwt" } }), null);
  assert.deepEqual(parse(JSON.stringify({ "grok.com": { key: BEARER } })), {
    accessToken: BEARER,
    refreshToken: null,
    expiresAt: 0,
  });
  // A bare token is the same credential without the file around it.
  assert.equal(parse(BEARER)?.accessToken, BEARER);
  // A JSON document that is not an auth file carries no cookie either; storing the raw text as a
  // session value would produce an account that can never authenticate.
  assert.equal(parse(JSON.stringify({ hello: "world" })), null);
});

test("the provider declares no OAuth path", () => {
  // xAI answers OAuth tokens on every grok.com endpoint except the quota ones, which return
  // 403 oauth2-auth-forbidden. Advertising OAuth here would offer a login that cannot read quota.
  assert.equal(grokProvider.supportsOAuth, false);
  assert.equal(grokProvider.id, "grok");
});

test("refresh is a no-op because neither credential carries a refresh grant", async () => {
  const tokens = { accessToken: "sso=abc", refreshToken: null, expiresAt: 0 };
  assert.deepEqual(await grokProvider.refresh(tokens), tokens);
});

// --- fetchUsage --------------------------------------------------------------------------------

const COOKIE_TOKENS = { accessToken: "sso=abc", refreshToken: null, expiresAt: 0 };
const BEARER_TOKENS = { accessToken: BEARER, refreshToken: null, expiresAt: 0 };
const SUBSCRIPTIONS = {
  subscriptions: [{ tier: "SUBSCRIPTION_TIER_SUPER_GROK_PLUS", status: "SUBSCRIPTION_STATUS_ACTIVE" }],
};
const CREDITS = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      end: "2026-08-19T22:58:04.994998+00:00",
    },
    creditUsagePercent: 7,
    productUsage: [
      { product: "GrokBuild", usagePercent: 5 },
      { product: "GrokAppBuilder", usagePercent: 2 },
      { product: "GrokChat" },
    ],
  },
};

interface RecordedRequest {
  url: string;
  headers: Headers;
}

async function withFetch<T>(
  handler: (url: string, init: RequestInit | undefined) => Response,
  run: (requests: RecordedRequest[]) => Promise<T>,
): Promise<T> {
  const requests: RecordedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return Promise.resolve(handler(String(input), init));
  }) as typeof fetch;
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = original;
  }
}

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

test("a CLI bearer reads the pool from the billing facade, credits format only", async () => {
  const usage = await withFetch(
    (url) => {
      if (url.endsWith("/rest/subscriptions")) return json(SUBSCRIPTIONS);
      if (!url.startsWith("https://cli-chat-proxy.grok.com/v1/billing")) {
        throw new Error(`beklenmeyen istek: ${url}`);
      }
      return json(CREDITS);
    },
    async (requests) => {
      const usage = await grokProvider.fetchUsage(BEARER_TOKENS);
      const billing = requests.find((request) => request.url.includes("cli-chat-proxy"));
      assert.ok(billing);
      // Without format=credits the same path returns the money invoice, which is $0 on a
      // subscription and would render as an untouched quota.
      assert.match(billing.url, /\?format=credits$/u);
      assert.equal(billing.headers.get("authorization"), `Bearer ${BEARER}`);
      assert.equal(billing.headers.get("x-xai-token-auth"), "xai-grok-cli");
      return usage;
    },
  );

  assert.deepEqual(
    usage.limits?.map((limit) => [limit.kind, limit.percent]),
    [["weekly_all", 7], ["grok_build", 5], ["grok_app_builder", 2]],
  );
  assert.equal(usage.limits?.[0].scope?.model?.display_name, "Haftalık SuperGrok Plus limiti");
  assert.equal(usage.limits?.[0].resets_at, "2026-08-19T22:58:04.994Z");
});

test("a session cookie reads the same numbers from grok.com", async () => {
  const usage = await withFetch(
    (url, init) => {
      if (url.endsWith("/rest/subscriptions")) return json(SUBSCRIPTIONS);
      if (!url.endsWith("/GetGrokCreditsConfig")) throw new Error(`beklenmeyen istek: ${url}`);
      // The binary attempt goes first; a deployment that refuses it must still produce the reading.
      const contentType = new Headers(init?.headers).get("content-type") ?? "";
      if (contentType.includes("grpc-web")) {
        return new Response(new Uint8Array(), { status: 200, headers: { "grpc-status": "16" } });
      }
      return json(CREDITS);
    },
    () => grokProvider.fetchUsage(COOKIE_TOKENS),
  );

  assert.deepEqual(
    usage.limits?.map((limit) => [limit.kind, limit.percent]),
    [["weekly_all", 7], ["grok_build", 5], ["grok_app_builder", 2]],
  );
  // No mode window survives: the two-hour counters describe burst throttling, not the subscription.
  assert.equal(usage.limits?.some((limit) => limit.kind === "grok_mode"), false);
});

test("an unreadable plan still yields the reading under the subscription's own name", async () => {
  const usage = await withFetch(
    (url) => (url.endsWith("/rest/subscriptions") ? new Response("", { status: 500 }) : json(CREDITS)),
    () => grokProvider.fetchUsage(COOKIE_TOKENS),
  );
  assert.equal(usage.limits?.[0].percent, 7);
  assert.equal(usage.limits?.[0].scope?.model?.display_name, "Haftalık SuperGrok Plus limiti");
});

test("an expired credential routes the card to reconnect rather than showing a stale zero", async () => {
  for (const tokens of [COOKIE_TOKENS, BEARER_TOKENS]) {
    await assert.rejects(
      withFetch(
        (url) => (url.endsWith("/rest/subscriptions") ? json(SUBSCRIPTIONS) : new Response("", { status: 401 })),
        () => grokProvider.fetchUsage(tokens),
      ),
      (err: unknown) => err instanceof ProviderError && err.status === 401,
    );
  }
});

test("the invoice payload is refused instead of being drawn as an empty quota", async () => {
  // `/v1/billing` without format=credits answers $0 on a subscription. Publishing that as 0% used
  // is exactly the wrong answer for an account that is spending its allowance.
  await assert.rejects(
    withFetch(
      (url) =>
        url.endsWith("/rest/subscriptions")
          ? json(SUBSCRIPTIONS)
          : json({ monthlyLimit: { val: 0 }, usage: { totalUsed: { val: 0 } } }),
      () => grokProvider.fetchUsage(BEARER_TOKENS),
    ),
    (err: unknown) => err instanceof ProviderError && err.providerId === "grok",
  );
});

test("identity comes from the token's own claims when the credential is a bearer", async () => {
  // grok.com's session endpoint is cookie-authenticated; asking it about a CLI token would 401 on
  // an otherwise perfectly usable credential.
  const profile = await withFetch(
    (url) => {
      if (url.endsWith("/rest/subscriptions")) return json(SUBSCRIPTIONS);
      throw new Error(`beklenmeyen istek: ${url}`);
    },
    () => grokProvider.resolveIdentity(BEARER_TOKENS),
  );
  assert.equal(profile.id, "u-1");
  assert.equal(profile.email, "a@b.test");
  assert.equal(profile.plan, "SuperGrok Plus");
  assert.deepEqual(grokBearerClaims("not.a.jwt"), { sub: "", email: "" });
});
