import assert from "node:assert/strict";
import test from "node:test";
import { beginOAuthCallbackSession } from "./oauth-callback-session.ts";

const state = "s".repeat(43);

function browserFor(
  hash: string,
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  const events: string[] = [];
  const location = {
    pathname: "/oauth/callback",
    search: "",
    hash,
  };
  return {
    events,
    location,
    browser: {
      location,
      history: {
        replaceState(_data: unknown, _unused: string, destination?: string | URL | null) {
          const next = String(destination);
          events.push(`history:${next}`);
          location.hash = "";
          const query = next.indexOf("?");
          location.search = query >= 0 ? next.slice(query) : "";
        },
      },
      fetch: fetchImpl,
    },
  };
}

test("OAuth callback erases its fragment synchronously before the bounded same-origin POST", async () => {
  const code = "one-time/code+value";
  let fixture!: ReturnType<typeof browserFor>;
  fixture = browserFor(
    `#code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    async (input, init) => {
      fixture.events.push("fetch");
      assert.deepEqual(fixture.events, ["history:/oauth/callback", "fetch"]);
      assert.equal(input, "/api/connect/oauth/attempt/callback");
      assert.deepEqual(init, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ code, state }),
      });
      return Response.json({ status: "done" });
    },
  );

  const attempt = beginOAuthCallbackSession(fixture.browser);
  assert.equal(attempt.started, true);
  assert.equal(fixture.location.hash, "");
  assert.deepEqual(fixture.events, ["history:/oauth/callback", "fetch"]);
  assert.equal(await attempt.completion, true);
});

test("malformed, ambiguous, queried, and oversized callbacks are erased without a request", async () => {
  for (const { pathname = "/oauth/callback", search = "", hash } of [
    { hash: "#code=one&state=short" },
    { hash: `#state=${state}&code=one` },
    { hash: `#code=one&state=${state}&extra=x` },
    { hash: `#code=${"x".repeat(4097)}&state=${state}` },
    { hash: `#code=one%23two&state=${state}` },
    { hash: `#code=one&state=${state}`, search: "?code=lookalike" },
    { hash: `#code=one&state=${state}`, pathname: "/oauth/callback/" },
  ]) {
    let calls = 0;
    const fixture = browserFor(hash, async () => {
      calls += 1;
      return Response.json({ status: "done" });
    });
    fixture.location.pathname = pathname;
    fixture.location.search = search;

    const attempt = beginOAuthCallbackSession(fixture.browser);
    assert.equal(attempt.started, false, `${pathname}${search}${hash}`);
    assert.equal(fixture.location.hash, "");
    assert.equal(fixture.location.search, "");
    assert.equal(calls, 0);
    assert.equal(await attempt.completion, false);
  }
});

test("callback completion is generic and fails closed on non-success or network failure", async () => {
  for (const fetchImpl of [
    async () => Response.json({ status: "failed" }, { status: 400 }),
    async () => Response.json({ status: "done", token: "lookalike" }),
    async () => {
      throw new Error("network detail");
    },
  ]) {
    const fixture = browserFor(`#code=one&state=${state}`, fetchImpl);
    const attempt = beginOAuthCallbackSession(fixture.browser);
    assert.equal(attempt.started, true);
    assert.equal(await attempt.completion, false);
  }
});
