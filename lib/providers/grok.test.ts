// Fixtures are verbatim responses captured from grok.com on 2026-08-13 against a live
// SuperGrok account, before and after an upgrade to SuperGrok Plus.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./_resolve-ts.mjs";

const { grokUsedPercent, normalizeGrokUsage, grokModeLabel } = await import("./grok-usage.ts");
const { availableGrokModes, activeGrokTier, grokPlanLabel, grokProvider } = await import("./grok.ts");

const MODES_PAYLOAD = {
  modes: [
    { id: "auto", title: "Auto", description: "Chooses Fast or Expert", availability: { available: {} } },
    { id: "fast", title: "Fast", description: "Quick responses · Grok 4.5", availability: { available: {} } },
    { id: "expert", title: "Expert", description: "Thinks hard · Grok 4.5", availability: { available: {} } },
    {
      id: "heavy",
      title: "Heavy",
      description: "Team of Experts · Grok 4.5",
      availability: { requiresUpgrade: { message: "", minimumSubscriptionTier: "TIER_SUPERGROK_HEAVY" } },
    },
    { id: "build", title: "Build", description: "Build apps and sites · Grok 4.6", availability: { available: {} } },
  ],
  defaultModeId: "auto",
};

const window2h = (remaining: number, total: number) => ({
  windowSizeSeconds: 7200,
  remainingQueries: remaining,
  totalQueries: total,
  lowEffortRateLimits: null,
  highEffortRateLimits: null,
});

test("only modes the tier grants are queried", () => {
  const modes = availableGrokModes(MODES_PAYLOAD);
  assert.deepEqual(modes.map((mode) => mode.id), ["auto", "fast", "expert", "build"]);
  // Heavy is gated behind a higher tier; querying it would draw a bar for quota that cannot be spent.
  assert.equal(modes.some((mode) => mode.id === "heavy"), false);
});

test("mode ids come from the mode list, never from the marketing model name", () => {
  // Every spelling of the Grok 4.6 model name 404s on /rest/rate-limits; the accepted key is the
  // mode id, and the model name only appears in the description.
  const build = availableGrokModes(MODES_PAYLOAD).find((mode) => mode.id === "build");
  assert.ok(build);
  assert.equal(build.id, "build");
  assert.match(String(build.description), /Grok 4\.6/u);
});

test("used percentage inverts the remaining count and clamps", () => {
  assert.equal(grokUsedPercent(window2h(10, 10)), 0);
  assert.equal(grokUsedPercent(window2h(7, 10)), 30);
  assert.equal(grokUsedPercent(window2h(0, 10)), 100);
  assert.equal(grokUsedPercent(window2h(45, 90)), 50);
  // A remaining count above the total is nonsense; it must not read as negative usage.
  assert.equal(grokUsedPercent(window2h(12, 10)), 0);
});

test("a mode the tier grants no quota for is unavailable, not zero-used", () => {
  // Build reads 0/0 on plain SuperGrok. Drawing that as "0% used" would claim a full allowance.
  assert.equal(grokUsedPercent(window2h(0, 0)), null);
  const usage = normalizeGrokUsage([
    { id: "build", title: "Build", payload: window2h(0, 0) },
    { id: "expert", title: "Expert", payload: window2h(90, 90) },
  ]);
  assert.deepEqual(usage.limits?.map((limit) => limit.group), ["expert"]);
});

test("labels carry the raw counts because a percentage of ten loses a whole query", () => {
  assert.equal(grokModeLabel({ id: "build", title: "Build", payload: window2h(3, 10) }), "Build · 3/10");
});

test("limits are rolling-window entries with no fabricated reset stamp", () => {
  const usage = normalizeGrokUsage([{ id: "build", title: "Build", payload: window2h(1, 10) }]);
  const limit = usage.limits?.[0];
  assert.ok(limit);
  assert.equal(limit.kind, "grok_mode");
  assert.equal(limit.percent, 90);
  assert.equal(limit.severity, "critical");
  // The window slides; knowing it is two hours long says nothing about when it rolls.
  assert.equal(limit.resets_at, null);
  assert.equal(limit.scope?.model?.id, "build");
});

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

test("the provider declares no OAuth path", () => {
  // xAI answers OAuth tokens on every endpoint except /rest/rate-limits, which returns
  // 403 oauth2-auth-forbidden. Advertising OAuth here would offer a login that cannot read quota.
  assert.equal(grokProvider.supportsOAuth, false);
  assert.equal(grokProvider.id, "grok");
});

test("refresh is a no-op because a browser session has no refresh grant", async () => {
  const tokens = { accessToken: "sso=abc", refreshToken: null, expiresAt: 0 };
  assert.deepEqual(await grokProvider.refresh(tokens), tokens);
});
