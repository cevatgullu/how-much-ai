import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAuthorizeUrl,
  CLAUDE_OAUTH,
  createPkce,
  parseOAuthCallbackRepresentation,
  parseOAuthProviderCallback,
} from "./oauth.ts";

test("app-owned OAuth uses a fresh PKCE verifier and least-privilege monitoring scopes", async () => {
  const bundle = await createPkce(1_900_000_000_000);
  assert.match(bundle.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(bundle.challenge, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(bundle.state, /^[A-Za-z0-9_-]{32,128}$/);
  assert.notEqual(bundle.verifier, bundle.challenge);
  assert.equal(bundle.createdAt, 1_900_000_000_000);

  const url = new URL(buildAuthorizeUrl(bundle));
  assert.equal(url.origin + url.pathname, CLAUDE_OAUTH.authorizeUrl);
  assert.equal(url.searchParams.get("client_id"), CLAUDE_OAUTH.clientId);
  assert.equal(url.searchParams.get("redirect_uri"), CLAUDE_OAUTH.redirectUri);
  assert.equal(url.searchParams.get("scope"), CLAUDE_OAUTH.scopes);
  assert.equal(url.searchParams.get("code_challenge"), bundle.challenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), bundle.state);
});

test("strict callback parsing accepts only the two reviewed Claude representations", () => {
  const state = "s".repeat(43);
  assert.deepEqual(parseOAuthCallbackRepresentation(` auth-code-1#${state} `), {
    code: "auth-code-1",
    state,
  });
  assert.deepEqual(
    parseOAuthCallbackRepresentation(
      `https://platform.claude.com/oauth/code/callback?code=auth-code-2&state=${state}`,
    ),
    { code: "auth-code-2", state },
  );
  assert.deepEqual(
    parseOAuthProviderCallback(
      `https://platform.claude.com/oauth/code/callback?code=auth-code-3#${state}`,
      "ignored",
    ),
    { code: "auth-code-3", state },
  );
  assert.deepEqual(
    parseOAuthProviderCallback(
      "https://platform.claude.com/oauth/code/callback",
      ` auth-code-4#${state} `,
    ),
    { code: "auth-code-4", state },
  );
});

test("strict callback parsing rejects lookalikes, ambiguity, and unbounded input", () => {
  const state = "s".repeat(43);
  for (const raw of [
    "bare-code",
    `code#short-state`,
    `code#${state}#${state}`,
    `https://attacker.example/oauth/code/callback?code=code&state=${state}`,
    `https://platform.claude.com:444/oauth/code/callback?code=code&state=${state}`,
    `https://platform.claude.com/oauth/code/callback-suffix?code=code&state=${state}`,
    `https://platform.claude.com/oauth/code/callback?code=one&code=two&state=${state}`,
    `https://platform.claude.com/oauth/code/callback?code=code&state=${state}&extra=1`,
    `https://platform.claude.com/oauth/code/callback?code=code&state=${state}#${state}`,
    `${"c".repeat(4097)}#${state}`,
  ]) {
    assert.equal(parseOAuthCallbackRepresentation(raw), null, raw);
  }

  assert.equal(
    parseOAuthProviderCallback(
      "https://platform.claude.com/oauth/code/callback?code=bad",
      `valid-code#${state}`,
    ),
    null,
  );
  assert.equal(
    parseOAuthProviderCallback(
      "https://user@platform.claude.com/oauth/code/callback",
      `valid-code#${state}`,
    ),
    null,
  );
  for (const href of [
    "https://platform.claude.com/oauth/code/callback?",
    "https://platform.claude.com/oauth/code/callback#",
  ]) {
    assert.equal(
      parseOAuthProviderCallback(href, `valid-code#${state}`),
      null,
      href,
    );
  }
});
